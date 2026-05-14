import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
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
const require = createRequire(import.meta.url);
const ytDlpPackage = require("yt-dlp-exec") as any;
const ytDlpConstants = require("yt-dlp-exec/src/constants") as { YOUTUBE_DL_PATH: string };
let ytDlpRunnerPromise: Promise<any> | null = null;
let ytDlpCookiesPathPromise: Promise<string | null> | null = null;
const YTDLP_USER_AGENT = process.env.YTDLP_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const YTDLP_EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || 'youtube:player_client=web_safari';

function getYtDlpDownloadUrl() {
  if (process.platform === 'win32') return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  if (process.platform === 'darwin') return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
}

async function getYtDlpRunner() {
  if (fs.existsSync(ytDlpConstants.YOUTUBE_DL_PATH)) return ytDlpPackage;
  if (ytDlpRunnerPromise) return ytDlpRunnerPromise;

  ytDlpRunnerPromise = (async () => {
    const extension = process.platform === 'win32' ? '.exe' : '';
    const targetPath = path.join(os.tmpdir(), `louvorkey-yt-dlp-${process.platform}${extension}`);

    if (!fs.existsSync(targetPath)) {
      const downloadUrl = getYtDlpDownloadUrl();
      console.warn(`[yt-dlp] binario ausente, baixando ${downloadUrl}`);
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`Falha ao baixar yt-dlp: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.promises.writeFile(targetPath, buffer);
      if (process.platform !== 'win32') await fs.promises.chmod(targetPath, 0o755);
    }

    return ytDlpPackage.create(targetPath);
  })();

  return ytDlpRunnerPromise;
}

async function getYtDlpCookiesPath() {
  if (process.env.YTDLP_COOKIES_PATH) return process.env.YTDLP_COOKIES_PATH;
  if (!process.env.YTDLP_COOKIES_BASE64) return null;
  if (ytDlpCookiesPathPromise) return ytDlpCookiesPathPromise;

  ytDlpCookiesPathPromise = (async () => {
    const cookiesPath = path.join(os.tmpdir(), 'louvorkey-youtube-cookies.txt');
    const cookies = Buffer.from(process.env.YTDLP_COOKIES_BASE64 || '', 'base64').toString('utf8');
    await fs.promises.writeFile(cookiesPath, cookies, 'utf8');
    return cookiesPath;
  })();

  return ytDlpCookiesPathPromise;
}

async function getYtDlpCommonFlags() {
  const cookiesPath = await getYtDlpCookiesPath();
  const flags: Record<string, unknown> = {
    noWarnings: true,
    noPlaylist: true,
    userAgent: YTDLP_USER_AGENT,
    referer: 'https://www.youtube.com/',
    extractorArgs: YTDLP_EXTRACTOR_ARGS,
  };
  if (cookiesPath) flags.cookies = cookiesPath;
  return flags;
}

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

// Cloudinary guarda os áudios, stems, metrônomos e versões com tom alterado.
// Aceita tanto CLOUDINARY_URL (uma var só) quanto as 3 vars individuais.
if (!process.env.CLOUDINARY_URL && process.env.CLOUDINARY_CLOUD_NAME) {
  process.env.CLOUDINARY_URL = `cloudinary://${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}@${process.env.CLOUDINARY_CLOUD_NAME}`;
}
cloudinary.config({ secure: true });

// Upload helper: áudio entra como resource_type "video" no Cloudinary.
async function uploadAudioToCloudinary(
  buffer: Buffer | Uint8Array,
  folder: string,
  publicId?: string,
  format = "mp3"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts: any = {
      resource_type: "video",
      folder,
      format,
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
type AudioMetadata = {
  originalKey: string | null;
  originalScale: string | null;
  bpm: number | null;
  metronomeUrl: string | null;
  durationS: number | null;
};

type AnalysisJob = {
  status: 'processing' | 'succeeded' | 'failed';
  result?: AudioMetadata;
  error?: string;
  createdAt: number;
};

const upload = multer({ storage: multer.memoryStorage() });
const DEMUCS_VERSION = "25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953";
const DEMUCS_MODEL = process.env.DEMUCS_MODEL || "htdemucs_ft";
const DEMUCS_OUTPUT_FORMAT = process.env.DEMUCS_OUTPUT_FORMAT || "wav";
const DEMUCS_STEMS_BY_MODEL: Record<string, string[]> = {
  htdemucs_6s: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
  htdemucs: ['vocals', 'drums', 'bass', 'other'],
  htdemucs_ft: ['vocals', 'drums', 'bass', 'other'],
  hdemucs_mmi: ['vocals', 'drums', 'bass', 'other'],
  mdx: ['vocals', 'drums', 'bass', 'other'],
  mdx_extra: ['vocals', 'drums', 'bass', 'other'],
};

function getDemucsStemKeys(modelName = DEMUCS_MODEL) {
  return DEMUCS_STEMS_BY_MODEL[modelName] || DEMUCS_STEMS_BY_MODEL.htdemucs_ft;
}

async function startServer() {
  if (!process.env.CLOUDINARY_URL) {
    console.warn("[AVISO] CLOUDINARY_URL não configurada. Os uploads vão falhar até que seja definida no Render.");
  }

  const app = express();
  const PORT = 3000;

  app.use(cors({ origin: true }));
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "louvorkey-backend" });
  });

  app.post("/api/cloudinary/sign-upload", (_req, res) => {
    const cfg = cloudinary.config();
    const cloudName = cfg.cloud_name || process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = cfg.api_key || process.env.CLOUDINARY_API_KEY;
    const apiSecret = cfg.api_secret || process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      return res.status(500).json({ error: "Cloudinary nao configurado no servidor" });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const folder = "songs";
    const publicId = `upload-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder, public_id: publicId },
      apiSecret
    );

    res.json({
      cloudName,
      apiKey,
      timestamp,
      signature,
      folder,
      publicId,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`,
    });
  });

  // Helper: pipeline completo de processamento — upload + análise + metrônomo.
  // Tudo em paralelo onde possível.
  async function analyzeAndGenerateMetadata(audioBuf: Buffer, publicId: string): Promise<AudioMetadata> {
    const analysis = await analyzeAudio(audioBuf);

    let metronomeUrl: string | null = null;
    let bpm: number | null = null;
    if (analysis && analysis.ticks.length > 4) {
      try {
        console.log(`[metronome] gerando ${analysis.ticks.length} clicks (BPM=${analysis.bpm.toFixed(1)})...`);
        const metroPcm = buildMetronomeBuffer(analysis.ticks, analysis.durationS);
        const metroMp3 = await pcmToMp3(metroPcm);
        metronomeUrl = await uploadAudioToCloudinary(metroMp3, 'metronomes', `${publicId}-metronome`);
        bpm = analysis.bpm;
        console.log(`[metronome] pronto: ${metronomeUrl}`);
      } catch (e: any) {
        console.error('[metronome] erro (não-fatal):', e.message);
      }
    }

    return {
      originalKey: analysis?.key ?? null,
      originalScale: analysis?.scale ?? null,
      bpm,
      metronomeUrl,
      durationS: analysis?.durationS ?? null,
    };
  }

  const analysisJobs = new Map<string, AnalysisJob>();

  function pruneAnalysisJobs() {
    const maxAgeMs = 60 * 60 * 1000;
    const now = Date.now();
    for (const [jobId, job] of analysisJobs.entries()) {
      if (now - job.createdAt > maxAgeMs) analysisJobs.delete(jobId);
    }
  }

  function startAnalysisJob(audioBuf: Buffer, publicId: string): string {
    pruneAnalysisJobs();
    const jobId = crypto.randomUUID();
    analysisJobs.set(jobId, { status: 'processing', createdAt: Date.now() });

    void (async () => {
      try {
        console.log(`[analysis] job ${jobId} iniciado`);
        const result = await analyzeAndGenerateMetadata(audioBuf, publicId);
        analysisJobs.set(jobId, { status: 'succeeded', result, createdAt: Date.now() });
        console.log(`[analysis] job ${jobId} concluido`);
      } catch (e: any) {
        console.error(`[analysis] job ${jobId} falhou:`, e);
        analysisJobs.set(jobId, {
          status: 'failed',
          error: e.message || String(e),
          createdAt: Date.now(),
        });
      }
    })();

    return jobId;
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
      const url = await uploadAudioToCloudinary(file.buffer, "songs", publicId);
      const analysisJobId = startAnalysisJob(file.buffer, `${publicId}-analysis`);
      const result: { url: string; analysisJobId: string; analysisDeferred: boolean } & AudioMetadata = {
        url,
        analysisJobId,
        analysisDeferred: true,
        originalKey: null,
        originalScale: null,
        bpm: null,
        metronomeUrl: null,
        durationS: null,
      };
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
  app.post("/api/analyze/start", async (req, res) => {
    try {
      const { audioUrl } = req.body;
      if (!audioUrl) return res.status(400).json({ error: "audioUrl obrigatorio" });

      console.log(`[analysis] baixando audio para analise: ${audioUrl}`);
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) {
        return res.status(502).json({ error: `Falha ao baixar audio: HTTP ${audioRes.status}` });
      }

      const audioBuf = Buffer.from(await audioRes.arrayBuffer());
      const urlHash = crypto.createHash('sha1').update(audioUrl).digest('hex').slice(0, 12);
      const jobId = startAnalysisJob(audioBuf, `analysis-${urlHash}`);
      res.json({ jobId });
    } catch (error: any) {
      console.error("Erro ao iniciar analise:", error);
      res.status(500).json({ error: "Erro ao iniciar analise", details: error.message });
    }
  });

  app.get("/api/analyze/status/:jobId", async (req, res) => {
    const { jobId } = req.params;
    if (!jobId) return res.status(400).json({ error: "jobId obrigatorio" });

    const job = analysisJobs.get(jobId);
    if (!job) return res.status(404).json({ error: "jobId nao encontrado" });

    res.json(job);
  });

  const COBALT_INSTANCES = (process.env.COBALT_API_URL ||
    'https://dwnld.nichind.dev,https://api.cobalt.tools,https://cobalt-backend.canine.tools'
  ).split(',').map(s => s.trim()).filter(Boolean);

  function cleanExternalError(text: string) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return 'sem detalhes';
    if (/^<!doctype|^<html/i.test(trimmed)) return 'resposta HTML inesperada do servico externo';
    return trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 260);
  }

  function normalizeYouTubeUrl(rawUrl: string) {
    const trimmed = String(rawUrl || '').trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("URL do YouTube invalida");
    }

    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    let videoId = '';

    if (host === 'youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0] || '';
    } else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      videoId = parsed.searchParams.get('v') || '';
      if (!videoId) {
        const parts = parsed.pathname.split('/').filter(Boolean);
        const marker = parts.findIndex((part) => ['shorts', 'live', 'embed'].includes(part));
        if (marker >= 0) videoId = parts[marker + 1] || '';
      }
    }

    const match = videoId.match(/^[a-zA-Z0-9_-]{6,}$/);
    if (!match) throw new Error("Nao encontrei o ID do video neste link do YouTube");
    return `https://www.youtube.com/watch?v=${match[0]}`;
  }

  async function fetchFromYtDlp(youtubeUrl: string): Promise<{ audioBuffer: Buffer; filename?: string; source: string }> {
    const uid = crypto.randomUUID();
    const outputTemplate = path.join(os.tmpdir(), `yt-${uid}.%(ext)s`);
    const outputPrefix = `yt-${uid}.`;
    let title: string | undefined;

    try {
      const ytDlp = await getYtDlpRunner();
      const commonFlags = await getYtDlpCommonFlags();

      try {
        const info = await ytDlp(youtubeUrl, {
          ...commonFlags,
          dumpSingleJson: true,
          skipDownload: true,
        }, { timeout: 45000 });
        title = info?.title;
      } catch (metadataError: any) {
        console.warn("[yt-dlp] metadados indisponiveis:", metadataError.message || String(metadataError));
      }

      await ytDlp.exec(youtubeUrl, {
        ...commonFlags,
        noPlaylist: true,
        format: 'bestaudio/best',
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 0,
        output: outputTemplate,
        ffmpegLocation: FFMPEG_PATH,
        noWarnings: true,
      }, { timeout: 180000 });

      const files = (await fs.promises.readdir(os.tmpdir()))
        .filter((file) => file.startsWith(outputPrefix));
      const mp3File = files.find((file) => file.endsWith('.mp3')) || files[0];
      if (!mp3File) throw new Error("yt-dlp nao gerou arquivo de audio");

      const audioBuffer = await fs.promises.readFile(path.join(os.tmpdir(), mp3File));
      if (audioBuffer.byteLength < 1024) {
        throw new Error(`yt-dlp gerou audio muito pequeno (${audioBuffer.byteLength}B)`);
      }

      return {
        audioBuffer,
        filename: title ? `${title}.mp3` : mp3File,
        source: 'yt-dlp',
      };
    } finally {
      const files = await fs.promises.readdir(os.tmpdir()).catch(() => []);
      await Promise.all(files
        .filter((file) => file.startsWith(outputPrefix))
        .map((file) => fs.promises.unlink(path.join(os.tmpdir(), file)).catch(() => {})));
    }
  }

  async function fetchFromCobalt(youtubeUrl: string): Promise<{ audioBuffer: Buffer; filename?: string; source: string }> {
    const normalizedUrl = normalizeYouTubeUrl(youtubeUrl);
    const attempts: string[] = [];

    try {
      console.log('[yt-dlp] tentando baixar audio...');
      return await fetchFromYtDlp(normalizedUrl);
    } catch (e: any) {
      attempts.push(`yt-dlp -> ${cleanExternalError(e.stderr || e.message || String(e))}`);
      console.warn('[yt-dlp] falhou, tentando Cobalt...');
    }

    for (const instance of COBALT_INSTANCES) {
      try {
        console.log(`[Cobalt] tentando ${instance}`);
        const cobaltRes = await fetch(instance, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            url: normalizedUrl,
            downloadMode: 'audio',
            audioFormat: 'mp3',
            filenameStyle: 'basic',
          }),
          // @ts-ignore — undici aceita signal mas não declarado em todos os types
          signal: AbortSignal.timeout(20000),
        });

        if (!cobaltRes.ok) {
          const errText = await cobaltRes.text();
          attempts.push(`${instance} -> HTTP ${cobaltRes.status}: ${cleanExternalError(errText)}`);
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
        return { audioBuffer: Buffer.from(audioBuffer), filename: cobaltData.filename, source: 'cobalt' };
      } catch (e: any) {
        attempts.push(`${instance} -> ${e.message || String(e)}`);
      }
    }
    throw new Error(`Nao consegui baixar este video do YouTube. Tentativas:\n${attempts.join('\n')}`);
  }

  app.post("/api/youtube", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL do YouTube inválida ou não fornecida" });
      }

      const { audioBuffer, filename: youtubeFilename, source } = await fetchFromCobalt(url);
      const audioBuf = Buffer.from(audioBuffer);

      const publicId = `youtube-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      console.log(`Upload pro Cloudinary: ${publicId} (${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)} MB, source=${source})`);
      const uploadedUrl = await uploadAudioToCloudinary(audioBuf, "songs", publicId);
      const analysisJobId = startAnalysisJob(audioBuf, `${publicId}-analysis`);
      console.log(`YouTube enviado: ${uploadedUrl} | analise em segundo plano: ${analysisJobId}`);

      res.json({
        url: uploadedUrl,
        title: youtubeFilename || "Áudio do YouTube",
        analysisJobId,
        analysisDeferred: true,
        originalKey: null,
        originalScale: null,
        bpm: null,
        metronomeUrl: null,
        durationS: null,
      });
    } catch (error: any) {
      console.error("Erro no download do YouTube:", error);
      res.status(502).json({ error: "Falha ao processar o vídeo do YouTube.", details: cleanExternalError(error.message) });
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
        version: DEMUCS_VERSION,
        input: {
          audio: audioUrl,
          model_name: DEMUCS_MODEL,
          output_format: DEMUCS_OUTPUT_FORMAT,
        },
      });

      console.log(`[separate] prediction iniciada: ${prediction.id}`);
      res.json({ jobId: prediction.id, model: DEMUCS_MODEL, outputFormat: DEMUCS_OUTPUT_FORMAT });
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
        return res.json({ status: 'succeeded', stems: stemsCache.get(jobId), model: DEMUCS_MODEL, outputFormat: DEMUCS_OUTPUT_FORMAT });
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
      const stemKeys = getDemucsStemKeys(DEMUCS_MODEL);

      console.log(`[separate] ${jobId} succeeded, transferindo ${stemKeys.length} stems pro Cloudinary...`);
      await Promise.all(stemKeys.map(async (key) => {
        if (output?.[key]) {
          try {
            const stemRes = await fetch(output[key]);
            const stemBuffer = await stemRes.arrayBuffer();
            stems[key] = await uploadAudioToCloudinary(
              new Uint8Array(stemBuffer),
              "stems",
              `${uniqueSession}-${key}`,
              DEMUCS_OUTPUT_FORMAT
            );
          } catch (e) {
            console.error(`Erro ao transferir faixa ${key}:`, e);
          }
        }
      }));

      stemsCache.set(jobId, stems);
      console.log(`[separate] ${jobId} transferido (${Object.keys(stems).length} stems)`);
      res.json({ status: 'succeeded', stems, model: DEMUCS_MODEL, outputFormat: DEMUCS_OUTPUT_FORMAT });
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

  const webDistDir = path.join(__dirname, "dist");
  if (fs.existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(webDistDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
