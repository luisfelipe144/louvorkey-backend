import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import fs from "fs";
import play from "play-dl";
import ffmpeg from "ffmpeg-static";
import Replicate from "replicate";
import "dotenv/config";

// Firebase Imports para Node.js
import { initializeApp } from "firebase/app";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carregar Configurações do Firebase
const firebaseConfigPath = path.join(__dirname, 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));

// Inicializar Firebase no Backend
const firebaseApp = initializeApp(firebaseConfig);
const storage = getStorage(firebaseApp);

// Configuração do Multer (agora em memória, não salva mais no disco local!)
const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Rota de Upload (Envia direto pro Firebase Storage)
  app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado" });
      }
      
      const uniqueName = `songs/upload-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp3`;
      const storageRef = ref(storage, uniqueName);
      
      console.log(`Fazendo upload para o Firebase: ${uniqueName}`);
      await uploadBytes(storageRef, new Uint8Array(file.buffer), { contentType: file.mimetype || 'audio/mpeg' });
      
      const downloadUrl = await getDownloadURL(storageRef);
      console.log(`Upload concluído: ${downloadUrl}`);
      
      res.json({ url: downloadUrl });
    } catch (error: any) {
      console.error("Erro no upload para Firebase:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Rota de Download do YouTube
  app.post("/api/youtube", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL do YouTube inválida ou não fornecida" });
      }

      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const filename = `youtube-${uniqueSuffix}.mp3`;
      const filepath = path.join(__dirname, filename);

      console.log(`Baixando áudio com play-dl: ${url}`);
      
      const streamInfo = await play.stream(url, { discordPlayerCompatibility: false });
      const writeStream = fs.createWriteStream(filepath);
      streamInfo.stream.pipe(writeStream);
      
      await new Promise((resolve, reject) => {
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
          streamInfo.stream.on('error', reject);
      });

      console.log(`Upload do YouTube para o Firebase...`);
      const buffer = await fs.promises.readFile(filepath);
      const storageRef = ref(storage, `songs/${filename}`);
      
      await uploadBytes(storageRef, new Uint8Array(buffer), { contentType: 'audio/mpeg' });
      const downloadUrl = await getDownloadURL(storageRef);
      
      // Apaga o arquivo temporário
      await fs.promises.unlink(filepath);

      res.json({ 
        url: downloadUrl, 
        title: "Áudio do YouTube" 
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
      // O Replicate aceita URLs públicas (Firebase) diretamente!
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

      console.log("Separação concluída. Replicate retornou URLs temporárias. Transferindo para o Firebase...");
      
      // Replicate retorna URLs que expiram em 1 hora. Temos que salvar no Firebase!
      const stems: any = {};
      const uniqueSession = Date.now();
      
      const stemKeys = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
      
      // Faz o download e upload em paralelo (para ser mais rápido)
      await Promise.all(stemKeys.map(async (key) => {
        if (output[key]) {
          try {
            const stemRes = await fetch(output[key]);
            const stemBuffer = await stemRes.arrayBuffer();
            
            const storageRef = ref(storage, `stems/${uniqueSession}-${key}.mp3`);
            await uploadBytes(storageRef, new Uint8Array(stemBuffer), { contentType: 'audio/mpeg' });
            stems[key] = await getDownloadURL(storageRef);
            console.log(`Faixa '${key}' salva no Firebase!`);
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

  // Não precisamos mais servir a pasta /uploads estaticamente, mas deixamos caso haja arquivos velhos
  const uploadDir = path.join(__dirname, "public", "uploads");
  if (fs.existsSync(uploadDir)) {
    app.use("/uploads", express.static(uploadDir));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
