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

// Decodifica MP3 -> mono PCM float32 via ffmpeg. Sample rate default 22050,
// passa 44100 quando precisa de precisão temporal (ex: posicionamento de beats).
async function decodeMp3ToFloat32(audioBuffer: Buffer, sampleRate = 22050): Promise<Float32Array> {
  const uid = crypto.randomUUID();
  const tmpIn = path.join(os.tmpdir(), `dec-in-${uid}.mp3`);
  const tmpOut = path.join(os.tmpdir(), `dec-out-${uid}.pcm`);
  await fs.promises.writeFile(tmpIn, audioBuffer);
  try {
    await execFileAsync(FFMPEG_PATH, [
      '-y', '-i', tmpIn,
      '-ac', '1',
      '-ar', String(sampleRate),
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

// Detecta tom (key + scale) E ritmo (BPM + posições dos beats) num único decode.
// Retorna null em caso de erro. ticks são posições dos beats em segundos.
async function analyzeAudio(audioBuffer: Buffer): Promise<{
  key: string;
  scale: string;
  bpm: number;
  ticks: number[];
  durationS: number;
} | null> {
  try {
    console.log('[analyze] decodificando MP3...');
    // Sample rate 44100 (em vez de 22050) pra precisão temporal dos ticks
    const pcm = await decodeMp3ToFloat32(audioBuffer, 44100);
    const durationS = pcm.length / 44100;
    console.log(`[analyze] PCM ${pcm.length} samples (${durationS.toFixed(1)}s)`);

    const essentia = await getEssentia();
    const vec = essentia.arrayToVector(pcm);
    try {
      const keyResult = essentia.KeyExtractor(vec);
      console.log(`[analyze] tom: ${keyResult.key} ${keyResult.scale}`);

      const rhythmResult = essentia.RhythmExtractor2013(vec);
      const ticksRaw = rhythmResult.ticks;
      const ticks: number[] = [];
      if (ticksRaw && typeof ticksRaw.size === 'function') {
        const n = ticksRaw.size();
        for (let i = 0; i < n; i++) ticks.push(ticksRaw.get(i));
        ticksRaw.delete?.();
      } else if (Array.isArray(ticksRaw)) {
        ticks.push(...ticksRaw);
      }
      console.log(`[analyze] BPM: ${rhythmResult.bpm?.toFixed(1)}, ${ticks.length} beats`);

      return {
        key: keyResult.key,
        scale: keyResult.scale,
        bpm: rhythmResult.bpm,
        ticks,
        durationS,
      };
    } finally {
      vec.delete?.();
    }
  } catch (e: any) {
    console.error('[analyze] Erro:', e.message);
    return null;
  }
}

// Gera um sample de click: sine wave com decay exponencial.
function generateClick(sampleRate: number, freq: number, amp: number, durationMs = 50): Float32Array {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const click = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 30);
    click[i] = Math.sin(2 * Math.PI * freq * t) * envelope * amp;
  }
  return click;
}

// Constrói buffer PCM com clicks nas posições exatas dos beats.
// A cada 4 beats faz downbeat (mais agudo + alto) — acento de compasso 4/4.
function buildMetronomeBuffer(beatTimes: number[], durationS: number, sampleRate = 44100): Float32Array {
  const totalSamples = Math.floor(durationS * sampleRate);
  const buffer = new Float32Array(totalSamples);
  const tick = generateClick(sampleRate, 1000, 0.5);
  const downbeat = generateClick(sampleRate, 1500, 0.7);

  for (let i = 0; i < beatTimes.length; i++) {
    const isDownbeat = i % 4 === 0;
    const c = isDownbeat ? downbeat : tick;
    const startSample = Math.floor(beatTimes[i] * sampleRate);
    for (let j = 0; j < c.length && startSample + j < totalSamples; j++) {
      buffer[startSample + j] += c[j];
    }
  }
  // Clip pra evitar saturação se clicks se sobrepuserem
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] > 1) buffer[i] = 1;
    else if (buffer[i] < -1) buffer[i] = -1;
  }
  return buffer;
}

// Encoda PCM mono f32 em MP3 via ffmpeg.
async function pcmToMp3(pcm: Float32Array, sampleRate = 44100): Promise<Buffer> {
  const uid = crypto.randomUUID();
  const tmpPcm = path.join(os.tmpdir(), `m-${uid}.pcm`);
  const tmpMp3 = path.join(os.tmpdir(), `m-${uid}.mp3`);
  await fs.promises.writeFile(tmpPcm, Buffer.from(pcm.buffer));
  try {
    await execFileAsync(FFMPEG_PATH, [
      '-y',
      '-f', 'f32le',
      '-ar', String(sampleRate),
      '-ac', '1',
      '-i', tmpPcm,
      '-c:a', 'libmp3lame',
      '-q:a', '4',
      tmpMp3,
    ], { maxBuffer: 64 * 1024 * 1024 });
    return await fs.promises.readFile(tmpMp3);
  } finally {
    fs.promises.unlink(tmpPcm).catch(() => {});
    fs.promises.unlink(tmpMp3).catch(() => {});
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

  // Helper: pipeline completo de processamento — upload + análise + metrônomo.
  // Tudo em paralelo onde possível.
  async function processAndUploadAudio(audioBuf: Buffer, folder: string, publicId: string) {
    const [url, analysis] = await Promise.all([
      uploadAudioToCloudinary(audioBuf, folder, publicId),
      analyzeAudio(audioBuf),
    ]);

    let metronomeUrl: string | null = null;
    let bpm: number | null = null;
    if (analysis && analysis.ticks.length > 4) {
      try {
        console.log(`[metronome] gerando ${analysis.ticks.length} clicks (BPM=${analysis.bpm.toFixed(1)})...`);
        const metroPcm = buildMetronomeBuffer(analysis.ticks, analysis.durationS);
        const metroMp3 = await pcmToMp3(metroPcm);
        metronomeUrl = await uploadAudioToCloudinary(metroMp3, 'metronomes', `${publicId}-metro`);
        bpm = analysis.bpm;
        console.log(`[metronome] pronto: ${metronomeUrl}`);
      } catch (e: any) {
        console.error('[metronome] erro (não-fatal):', e.message);
      }
    }

    return {
      url,
      originalKey: analysis?.key ?? null,
      originalScale: analysis?.scale ?? null,
      bpm,
      metronomeUrl,
      durationS: analysis?.durationS ?? null,
    };
  }

  // Rota de Upload de arquivo local
  app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado" });
      }

      console.log(`Upload pro Cloudinary: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
      const publicId = `upload-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const result = await processAndUploadAudio(file.buffer, "songs", publicId);
      console.log(`Upload concluído: ${result.url} | tom: ${result.originalKey} ${result.originalScale} | BPM: ${result.bpm?.toFixed(1) ?? '?'}`);
      res.json(result);
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
      const result = await processAndUploadAudio(audioBuf, "songs", publicId);
      console.log(`YouTube concluído: ${result.url} | tom: ${result.originalKey} | BPM: ${result.bpm?.toFixed(1) ?? '?'}`);

      res.json({
        ...result,
        title: cobaltFilename || "Áudio do YouTube",
      });
    } catch (error: any) {
      console.error("Erro no download do YouTube:", error);
      res.status(500).json({ error: "Falha ao processar o vídeo do YouTube.", details: error.message });
    }
  });

  // Separação de stems: padrão assíncrono pra não estourar o timeout do Render Free.
  // POST /api/separate/start  → cria predição no Replicate, retorna jobId imediatamente
  // GET  /api/separate/status/:jobId  → consulta status; quando 'succeeded', transfere
  //                                     stems pro Cloudinary e retorna URLs (cacheado).

  // Cache de stems já transferidos pro Cloudinary, indexado por prediction id.
  // Sobrevive enquanto o processo Node viver. Se cair, o app só precisa pedir de novo.
  const stemsCache = new Map<string, { [key: string]: string }>();

  app.post("/api/separate/start", async (req, res) => {
    try {
      const { audioUrl } = req.body;
      if (!audioUrl) return res.status(400).json({ error: "Áudio não fornecido" });

      if (!process.env.REPLICATE_API_TOKEN) {
        return res.status(500).json({ error: "Token da Replicate ausente no .env" });
      }

      const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

      console.log(`[separate] criando predição Demucs htdemucs_6s para ${audioUrl}`);
      const prediction = await replicate.predictions.create({
        version: "25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953",
        input: {
          audio: audioUrl,
          model_name: "htdemucs_6s",
          output_format: "mp3",
        },
      });

      console.log(`[separate] prediction iniciada: ${prediction.id}`);
      res.json({ jobId: prediction.id });
    } catch (err: any) {
      console.error("Erro ao iniciar separação:", err);
      res.status(500).json({ error: "Erro ao iniciar separação", details: err.message });
    }
  });

  app.get("/api/separate/status/:jobId", async (req, res) => {
    try {
      const { jobId } = req.params;
      if (!jobId) return res.status(400).json({ error: "jobId obrigatório" });

      // Cache hit: stems já foram transferidos antes
      if (stemsCache.has(jobId)) {
        return res.json({ status: 'succeeded', stems: stemsCache.get(jobId) });
      }

      if (!process.env.REPLICATE_API_TOKEN) {
        return res.status(500).json({ error: "Token da Replicate ausente no .env" });
      }

      const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
      const prediction = await replicate.predictions.get(jobId);

      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        return res.json({ status: prediction.status, error: prediction.error });
      }

      if (prediction.status !== 'succeeded') {
        // starting | processing — ainda rodando
        return res.json({ status: prediction.status });
      }

      // Succeeded — transferir stems pro Cloudinary
      const output: any = prediction.output;
      const stems: { [key: string]: string } = {};
      const uniqueSession = jobId.slice(0, 8);
      const stemKeys = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];

      console.log(`[separate] ${jobId} succeeded, transferindo ${stemKeys.length} stems pro Cloudinary...`);
      await Promise.all(stemKeys.map(async (key) => {
        if (output?.[key]) {
          try {
            const stemRes = await fetch(output[key]);
            const stemBuffer = await stemRes.arrayBuffer();
            stems[key] = await uploadAudioToCloudinary(
              new Uint8Array(stemBuffer),
              "stems",
              `${uniqueSession}-${key}`
            );
          } catch (e) {
            console.error(`Erro ao transferir faixa ${key}:`, e);
          }
        }
      }));

      stemsCache.set(jobId, stems);
      console.log(`[separate] ${jobId} transferido (${Object.keys(stems).length} stems)`);
      res.json({ status: 'succeeded', stems });
    } catch (err: any) {
      console.error("Erro no status da separação:", err);
      res.status(500).json({ error: "Erro no status", details: err.message });
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
        // Rubberband: pitch shift de qualidade profissional, preserva formantes
        // (vozes femininas não viram masculinas, instrumentos não somem).
        // - formant=preserved: mantém timbre vocal
        // - pitchq=quality: prioriza qualidade sobre velocidade
        // - channels=together: preserva imagem estéreo
        const filter = `rubberband=pitch=${ratio.toFixed(6)}:formant=preserved:pitchq=quality:channels=together`;
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
