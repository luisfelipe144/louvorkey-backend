import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import Replicate from "replicate";
import { v2 as cloudinary } from "cloudinary";
import ffmpegStatic from "ffmpeg-static";
import EssentiaPkg from "essentia.js";
import "dotenv/config";

const execFileAsync = promisify(execFile);
const FFMPEG_PATH = ffmpegStatic as unknown as string;

// essentia.js carrega via WASM. Inicializamos uma vez e reusamos.
const { Essentia, EssentiaWASM } = EssentiaPkg as any;
let essentiaInstance: any = null;
async function getEssentia(): Promise<any> {
  if (essentiaInstance) return essentiaInstance;
  const wasm = typeof EssentiaWASM === 'function' ? await EssentiaWASM() : EssentiaWASM;
  essentiaInstance = new Essentia(wasm);
  console.log(`[essentia] versão ${essentiaInstance.version} carregada`);
  return essentiaInstance;
}

// Decodifica MP3 -> mono PCM float32 22050Hz via ffmpeg.
async function decodeMp3ToFloat32(audioBuffer: Buffer): Promise<Float32Array> {
  const uid = crypto.randomUUID();
  const tmpIn = path.join(os.tmpdir(), `dec-in-${uid}.mp3`);
  const tmpOut = path.join(os.tmpdir(), `dec-out-${uid}.pcm`);
  await fs.promises.writeFile(tmpIn, audioBuffer);
  try {
    await execFileAsync(FFMPEG_PATH, [
      '-y', '-i', tmpIn,
      '-ac', '1',
      '-ar', '22050',
      '-f', 'f32le',
      tmpOut,
    ], { maxBuffer: 200 * 1024 * 1024 });
    const pcmBuf = await fs.promises.readFile(tmpOut);
    return new Float32Array(pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength));
  } finally {
    fs.promises.unlink(tmpIn).catch(() => {});
    fs.promises.unlink(tmpOut).catch(() => {});
  }
}

// Detecta o tom (key + scale) do áudio. Retorna null em caso de erro.
async function detectKey(audioBuffer: Buffer): Promise<{ key: string; scale: string; strength: number } | null> {
  try {
    console.log('[detectKey] decodificando MP3...');
    const pcm = await decodeMp3ToFloat32(audioBuffer);
    console.log(`[detectKey] PCM ${pcm.length} samples (${(pcm.length / 22050).toFixed(1)}s), rodando KeyExtractor...`);

    const essentia = await getEssentia();
    const vec = essentia.arrayToVector(pcm);
    try {
      const result = essentia.KeyExtractor(vec);
      console.log(`[detectKey] resultado: ${result.key} ${result.scale} (strength=${result.strength?.toFixed(3)})`);
      return { key: result.key, scale: result.scale, strength: result.strength };
    } finally {
      vec.delete?.();
    }
  } catch (e: any) {
    console.error('[detectKey] Erro:', e.message);
    return null;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cloudinary guarda os áudios (substituiu Firebase Storage que exige plano Blaze).
// Aceita tanto CLOUDINARY_URL (uma var só) quanto as 3 vars individuais.
if (!process.env.CLOUDINARY_URL && process.env.CLOUDINARY_CLOUD_NAME) {
  process.env.CLOUDINARY_URL = `cloudinary://${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}@${process.env.CLOUDINARY_CLOUD_NAME}`;
}
cloudinary.config({ secure: true });

// Upload helper: áudio entra como resource_type "video" no Cloudinary.
async function uploadAudioToCloudinary(
  buffer: Buffer | Uint8Array,
  folder: string,
  publicId?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts: any = {
      resource_type: "video",
      folder,
      format: "mp3",
    };
    if (publicId) opts.public_id = publicId;

    const stream = cloudinary.uploader.upload_stream(opts, (error, result) => {
      if (error) return reject(error);
      if (!result?.secure_url) return reject(new Error("Cloudinary não retornou secure_url"));
      resolve(result.secure_url);
    });
    stream.end(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  });
}

// Configuração do Multer (memória)
const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  if (!process.env.CLOUDINARY_URL) {
    console.warn("[AVISO] CLOUDINARY_URL não configurada. Os uploads vão falhar até que seja definida no Render.");
  }

  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Rota de Upload de arquivo local
  app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado" });
      }

      console.log(`Upload pro Cloudinary: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
      const publicId = `upload-${Date.now()}-${Math.round(Math.random() * 1e9)}`;

      // Roda upload e detecção de tom em paralelo
      const [url, detection] = await Promise.all([
        uploadAudioToCloudinary(file.buffer, "songs", publicId),
        detectKey(file.buffer),
      ]);
      console.log(`Upload concluído: ${url} | tom: ${detection?.key ?? '?'} ${detection?.scale ?? ''}`);

      res.json({
        url,
        originalKey: detection?.key ?? null,
        originalScale: detection?.scale ?? null,
      });
    } catch (error: any) {
      console.error("Erro no upload pro Cloudinary:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Rota de Download do YouTube (via Cobalt API — contorna o bloqueio de IPs de datacenter).
  // Tenta múltiplas instâncias em ordem; usa a primeira que responder com tunnel/redirect válido.
  // Lista override via env COBALT_API_URL (separe por vírgula).
  // Catálogo público (frágil, mudam toda hora): https://instances.hyper.lol/
  const COBALT_INSTANCES = (process.env.COBALT_API_URL ||
    'https://dwnld.nichind.dev,https://api.cobalt.tools,https://cobalt-backend.canine.tools'
  ).split(',').map(s => s.trim()).filter(Boolean);

  async function fetchFromCobalt(youtubeUrl: string): Promise<{ audioBuffer: ArrayBuffer; filename?: string }> {
    const attempts: string[] = [];
    for (const instance of COBALT_INSTANCES) {
      try {
        console.log(`[Cobalt] tentando ${instance}`);
        const cobaltRes = await fetch(instance, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            url: youtubeUrl,
            downloadMode: 'audio',
            audioFormat: 'mp3',
            filenameStyle: 'basic',
          }),
          // @ts-ignore — undici aceita signal mas não declarado em todos os types
          signal: AbortSignal.timeout(20000),
        });

        if (!cobaltRes.ok) {
          const errText = (await cobaltRes.text()).slice(0, 200);
          attempts.push(`${instance} -> HTTP ${cobaltRes.status}: ${errText}`);
          continue;
        }

        const cobaltData: any = await cobaltRes.json();
        if (cobaltData.status === 'error' || !cobaltData.url) {
          attempts.push(`${instance} -> ${cobaltData.error?.code || cobaltData.text || 'sem url'}`);
          continue;
        }

        console.log(`[Cobalt] ${instance} retornou status=${cobaltData.status}, baixando...`);
        const audioRes = await fetch(cobaltData.url, {
          // @ts-ignore
          signal: AbortSignal.timeout(60000),
        });
        if (!audioRes.ok) {
          attempts.push(`${instance} tunnel -> HTTP ${audioRes.status}`);
          continue;
        }
        const audioBuffer = await audioRes.arrayBuffer();
        if (audioBuffer.byteLength < 1024) {
          attempts.push(`${instance} -> resposta muito pequena (${audioBuffer.byteLength}B)`);
          continue;
        }
        return { audioBuffer, filename: cobaltData.filename };
      } catch (e: any) {
        attempts.push(`${instance} -> ${e.message || String(e)}`);
      }
    }
    throw new Error(`Todas as instâncias Cobalt falharam:\n${attempts.join('\n')}`);
  }

  app.post("/api/youtube", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL do YouTube inválida ou não fornecida" });
      }

      const { audioBuffer, filename: cobaltFilename } = await fetchFromCobalt(url);
      const audioBuf = Buffer.from(audioBuffer);

      const publicId = `youtube-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      console.log(`Upload pro Cloudinary: ${publicId} (${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);

      const [cloudinaryUrl, detection] = await Promise.all([
        uploadAudioToCloudinary(audioBuf, "songs", publicId),
        detectKey(audioBuf),
      ]);
      console.log(`YouTube concluído: ${cloudinaryUrl} | tom: ${detection?.key ?? '?'} ${detection?.scale ?? ''}`);

      res.json({
        url: cloudinaryUrl,
        title: cobaltFilename || "Áudio do YouTube",
        originalKey: detection?.key ?? null,
        originalScale: detection?.scale ?? null,
      });
    } catch (error: any) {
      console.error("Erro no download do YouTube:", error);
      res.status(500).json({ error: "Falha ao processar o vídeo do YouTube.", details: error.message });
    }
  });

  // Rota para separar instrumentos (Moises Clone via Replicate Demucs)
  app.post("/api/separate", async (req, res) => {
    try {
      const { audioUrl } = req.body;
      if (!audioUrl) return res.status(400).json({ error: "Áudio não fornecido" });

      if (!process.env.REPLICATE_API_TOKEN) {
        return res.status(500).json({ error: "Token da Replicate ausente no .env" });
      }

      const replicate = new Replicate({
        auth: process.env.REPLICATE_API_TOKEN,
      });

      console.log("Iniciando separação com Demucs (Replicate)... Isso pode levar 1-3 minutos.");
      // htdemucs_6s separa em 6 faixas (vocals, drums, bass, guitar, piano, other).
      // O htdemucs padrão só dá 4 (sem guitar/piano), o que quebra o mixer do app.
      const output: any = await replicate.run(
        "cjwbw/demucs:25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953",
        {
          input: {
            audio: audioUrl,
            model_name: "htdemucs_6s",
            output_format: "mp3"
          }
        }
      );

      console.log("Separação concluída. URLs do Replicate expiram em 1h — transferindo pro Cloudinary...");

      const stems: any = {};
      const uniqueSession = Date.now();
      const stemKeys = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];

      await Promise.all(stemKeys.map(async (key) => {
        if (output[key]) {
          try {
            const stemRes = await fetch(output[key]);
            const stemBuffer = await stemRes.arrayBuffer();
            stems[key] = await uploadAudioToCloudinary(
              new Uint8Array(stemBuffer),
              "stems",
              `${uniqueSession}-${key}`
            );
            console.log(`Faixa '${key}' salva no Cloudinary!`);
          } catch (e) {
            console.error(`Erro ao transferir faixa ${key}:`, e);
          }
        }
      }));

      res.json({ stems });
    } catch (err: any) {
      console.error("Erro na separação de stems:", err);
      res.status(500).json({ error: "Erro interno na separação da IA", details: err.message });
    }
  });

  // Rota de Pitch Shift — gera uma versão da música em outro tom (semitons).
  // Usa ffmpeg com asetrate+atempo: muda o tom preservando o tempo (estilo Moises).
  // Cache idempotente no Cloudinary: mesmo (audioUrl, semitones) reusa o arquivo.
  app.post("/api/pitch", async (req, res) => {
    try {
      const { audioUrl, semitones } = req.body;
      if (!audioUrl || typeof semitones !== 'number') {
        return res.status(400).json({ error: "audioUrl (string) e semitones (number) obrigatórios" });
      }
      if (semitones === 0) {
        return res.json({ url: audioUrl, cached: true });
      }
      if (semitones < -12 || semitones > 12) {
        return res.status(400).json({ error: "semitones deve estar entre -12 e +12" });
      }

      const ratio = Math.pow(2, semitones / 12);
      const sign = semitones > 0 ? 'p' : 'm';
      const urlHash = crypto.createHash('sha1').update(audioUrl).digest('hex').slice(0, 12);
      const publicId = `${urlHash}-${sign}${Math.abs(semitones)}`;
      const cloudinaryPath = `pitched/${publicId}`;

      // Cache: se já existe, retorna sem reprocessar
      try {
        const existing = await cloudinary.api.resource(cloudinaryPath, { resource_type: 'video' });
        if (existing?.secure_url) {
          console.log(`[Pitch] cache hit: ${cloudinaryPath}`);
          return res.json({ url: existing.secure_url, cached: true });
        }
      } catch {
        // Recurso não existe — segue processando
      }

      console.log(`[Pitch] gerando ${semitones} semitons (ratio ${ratio.toFixed(4)}) para ${audioUrl}`);

      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) throw new Error(`Falha ao baixar áudio original: HTTP ${audioRes.status}`);
      const audioBuf = Buffer.from(await audioRes.arrayBuffer());

      const tmp = os.tmpdir();
      const uid = crypto.randomUUID();
      const inputPath = path.join(tmp, `pitch-in-${uid}.mp3`);
      const outputPath = path.join(tmp, `pitch-out-${uid}.mp3`);

      await fs.promises.writeFile(inputPath, audioBuf);

      try {
        // asetrate muda pitch+tempo juntos; atempo corrige só o tempo de volta.
        // Resultado: tom muda, BPM permanece igual.
        const filter = `asetrate=44100*${ratio},aresample=44100,atempo=${(1 / ratio).toFixed(6)}`;
        await execFileAsync(FFMPEG_PATH, [
          '-y',
          '-i', inputPath,
          '-af', filter,
          '-c:a', 'libmp3lame',
          '-q:a', '4',
          outputPath,
        ], { maxBuffer: 64 * 1024 * 1024 });

        const outBuf = await fs.promises.readFile(outputPath);
        const cloudinaryUrl = await uploadAudioToCloudinary(outBuf, 'pitched', publicId);

        console.log(`[Pitch] gerado: ${cloudinaryUrl}`);
        res.json({ url: cloudinaryUrl, cached: false });
      } finally {
        fs.promises.unlink(inputPath).catch(() => {});
        fs.promises.unlink(outputPath).catch(() => {});
      }
    } catch (error: any) {
      console.error("Erro no pitch shift:", error);
      res.status(500).json({ error: "Falha no pitch shift", details: error.message });
    }
  });

  // Mantém /uploads estático se houver arquivos antigos no disco
  const uploadDir = path.join(__dirname, "public", "uploads");
  if (fs.existsSync(uploadDir)) {
    app.use("/uploads", express.static(uploadDir));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
