import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = process.env.BGUTIL_POT_VERSION || '1.3.1';
const REPO = 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git';
const PLUGIN_ZIP_URL = 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip';

const workspace = process.cwd();
const root = process.env.YTDLP_ROOT || path.join(workspace, '.yt-dlp');
const pluginDir = process.env.YTDLP_PLUGIN_DIR || path.join(root, 'plugins');
const providerDir = process.env.YTDLP_BGUTIL_PROVIDER_DIR || path.join(root, 'bgutil-ytdlp-pot-provider');
const serverDir = process.env.YTDLP_BGUTIL_SERVER_HOME || path.join(providerDir, 'server');
const pluginZip = path.join(pluginDir, 'bgutil-ytdlp-pot-provider.zip');
const buildFile = path.join(serverDir, 'build', 'generate_once.js');

const npmBin = 'npm';
const npxBin = 'npx';

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && ['npm', 'npx'].includes(command),
    ...options,
  });
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao baixar ${url}: HTTP ${response.status}`);
  }

  const tmp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, Buffer.from(await response.arrayBuffer()));
  await fs.promises.rename(tmp, destination);
}

async function ensurePlugin() {
  await fs.promises.mkdir(pluginDir, { recursive: true });
  if (fs.existsSync(pluginZip)) {
    console.log(`[yt-dlp-pot] plugin ja existe: ${pluginZip}`);
    return;
  }

  console.log(`[yt-dlp-pot] baixando plugin: ${PLUGIN_ZIP_URL}`);
  await download(PLUGIN_ZIP_URL, pluginZip);
}

function ensureProviderSource() {
  if (fs.existsSync(serverDir)) {
    console.log(`[yt-dlp-pot] provider ja existe: ${providerDir}`);
    return;
  }

  fs.mkdirSync(root, { recursive: true });
  const tmpDir = path.join(os.tmpdir(), `bgutil-ytdlp-pot-provider-${process.pid}-${Date.now()}`);

  try {
    console.log(`[yt-dlp-pot] clonando provider ${VERSION}`);
    run('git', ['clone', '--depth', '1', '--single-branch', '--branch', VERSION, REPO, tmpDir]);
    fs.rmSync(providerDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, providerDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function ensureProviderBuild() {
  if (fs.existsSync(buildFile)) {
    console.log(`[yt-dlp-pot] provider ja compilado: ${buildFile}`);
    return;
  }

  console.log('[yt-dlp-pot] instalando dependencias do provider');
  run(npmBin, ['ci'], { cwd: serverDir });

  console.log('[yt-dlp-pot] compilando provider');
  run(npxBin, ['tsc'], { cwd: serverDir });
}

try {
  await ensurePlugin();
  ensureProviderSource();
  ensureProviderBuild();
  console.log('[yt-dlp-pot] pronto');
} catch (error) {
  console.error('[yt-dlp-pot] setup falhou:', error?.message || error);
  process.exitCode = 1;
}
