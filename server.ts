import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import fs from "fs";
import Replicate from "replicate";
import { v2 as cloudinary } from "cloudinary";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cloudinary é onde guardamos os áudios agora (substituiu o Firebase Storage,
// que exige plano Blaze). Credenciais via env: CLOUDINARY_CLOUD_NAME, _API_KEY, _API_SECRET.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

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
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.warn("[AVISO] Variáveis CLOUDINARY_* não configuradas. Os uploads vão falhar até que sejam definidas no Render.");
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
      const url = await uploadAudioToCloudinary(file.buffer, "songs", publicId);
      console.log(`Upload concluído: ${url}`);

      res.json({ url });
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

      const publicId = `youtube-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      console.log(`Upload pro Cloudinary: ${publicId} (${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
      const cloudinaryUrl = await uploadAudioToCloudinary(new Uint8Array(audioBuffer), "songs", publicId);

      res.json({
        url: cloudinaryUrl,
        title: cobaltFilename || "Áudio do YouTube",
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
      const output: any = await replicate.run(
        "cjwbw/demucs:25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953",
        {
          input: {
            audio: audioUrl,
            model_name: "htdemucs",
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
