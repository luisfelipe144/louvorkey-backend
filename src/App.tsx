import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import {
  Activity,
  Clock,
  Download,
  FileAudio,
  Gauge,
  Loader2,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UploadCloud,
  Volume2,
  VolumeX,
  Wand2,
  X,
  Youtube,
} from 'lucide-react';
import { db } from './firebase';

const API_URL = import.meta.env.VITE_API_URL || 'https://louvorkey-backend.onrender.com';
const COVER_URL = 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=600&fit=crop';

const STEM_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
const STEM_LABELS: Record<string, string> = {
  vocals: 'Voz',
  drums: 'Bateria',
  bass: 'Baixo',
  guitar: 'Guitarra',
  piano: 'Teclado',
  other: 'Instrumental',
  master: 'Master',
  metronome: 'Metrônomo',
};

const SHARP_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_TO_SHARP: Record<string, string> = {
  Db: 'C#',
  Eb: 'D#',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#',
};

type Song = {
  id: string;
  title: string;
  author: string;
  audioUrl: string;
  thumbnail?: string;
  originalKey?: string | null;
  originalScale?: string | null;
  bpm?: number | null;
  metronomeUrl?: string | null;
  durationS?: number | null;
  stems?: Record<string, string>;
  separationModel?: string | null;
  stemsFormat?: string | null;
  createdAt?: unknown;
};

type Notice = {
  type: 'success' | 'error' | 'info';
  message: string;
};

type UploadMode = 'local' | 'youtube';

type AudioUrls = {
  master?: string;
  stems?: Record<string, string>;
  metronome?: string | null;
};

const initialVolumes: Record<string, number> = {
  vocals: 86,
  drums: 86,
  bass: 86,
  guitar: 86,
  piano: 86,
  other: 86,
  master: 100,
  metronome: 0,
};

const initialMutes: Record<string, boolean> = {
  vocals: false,
  drums: false,
  bass: false,
  guitar: false,
  piano: false,
  other: false,
  master: false,
  metronome: true,
};

function normalizeKey(key?: string | null) {
  if (!key) return 'C';
  const clean = key.trim();
  return FLAT_TO_SHARP[clean] || clean;
}

function noteFromSemitones(semitones: number, originalKey?: string | null) {
  const base = normalizeKey(originalKey);
  const start = Math.max(0, SHARP_NOTES.indexOf(base));
  return SHARP_NOTES[((start + semitones) % 12 + 12) % 12];
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function safeError(error: unknown) {
  return readableError(error instanceof Error ? error.message : String(error));
}

function readableError(message: string) {
  let text = String(message || '').trim();

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      text = parsed.details || parsed.error || parsed.message || text;
    } catch {
      // Mantem o texto original quando nao for JSON valido.
    }
  }

  if (/^<!doctype|^<html/i.test(text)) {
    return 'O servidor retornou uma página HTML inesperada. Recarregue o site e tente novamente.';
  }

  if (/sign in to confirm.*not a bot|cookies-from-browser|--cookies/i.test(text)) {
    return 'YouTube bloqueou o servidor com verificacao anti-robo. Anexe um cookies.txt do YouTube na aba YouTube e tente novamente.';
  }

  text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 420 ? `${text.slice(0, 420)}...` : text;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    if (data && typeof data === 'object') {
      const payload = data as { error?: string; details?: string; message?: string };
      throw new Error(readableError(payload.details || payload.error || payload.message || text));
    }
    throw new Error(readableError(text || `HTTP ${response.status}`));
  }

  if (!data) throw new Error('Resposta inválida do servidor.');
  return data as T;
}

function textToBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function readStoredValue(key: string) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<UploadMode>('local');
  const [newTitle, setNewTitle] = useState('');
  const [newAuthor, setNewAuthor] = useState('');
  const [newYoutubeUrl, setNewYoutubeUrl] = useState('');
  const [youtubeCookiesBase64, setYoutubeCookiesBase64] = useState(() => readStoredValue('louvorkey.youtubeCookiesBase64'));
  const [youtubeCookiesName, setYoutubeCookiesName] = useState(() => readStoredValue('louvorkey.youtubeCookiesName'));
  const [newFile, setNewFile] = useState<File | null>(null);
  const [busyLabel, setBusyLabel] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [isPitchLoading, setIsPitchLoading] = useState(false);
  const [isSeparating, setIsSeparating] = useState(false);
  const [separateElapsed, setSeparateElapsed] = useState(0);
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(() => new Set());
  const [volumes, setVolumes] = useState<Record<string, number>>(initialVolumes);
  const [mutes, setMutes] = useState<Record<string, boolean>>(initialMutes);

  const audioRefs = useRef<Record<string, HTMLAudioElement>>({});
  const originalUrlsRef = useRef<AudioUrls>({});
  const selectedSongRef = useRef<Song | null>(null);
  const analysisJobsRef = useRef<Set<string>>(new Set());
  const pitchAbortRef = useRef<AbortController | null>(null);
  const separateStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    selectedSongRef.current = selectedSong;
  }, [selectedSong]);

  useEffect(() => {
    const q = query(collection(db, 'songs'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const nextSongs = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Song));
        setSongs(nextSongs);
        setSelectedSong((current) => {
          if (!current) return current;
          return nextSongs.find((song) => song.id === current.id) || current;
        });
      },
      (error) => {
        setNotice({ type: 'error', message: `Erro ao carregar repertório: ${error.message}` });
      }
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 6500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    return () => unloadAllAudio();
  }, []);

  useEffect(() => {
    if (!isSeparating) return;
    separateStartedAtRef.current = Date.now();
    const interval = window.setInterval(() => {
      if (!separateStartedAtRef.current) return;
      setSeparateElapsed((Date.now() - separateStartedAtRef.current) / 1000);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isSeparating]);

  useEffect(() => {
    Object.entries(audioRefs.current).forEach(([key, audio]) => {
      audio.volume = mutes[key] ? 0 : (volumes[key] ?? 80) / 100;
    });
  }, [volumes, mutes]);

  useEffect(() => {
    if (!playing) return;
    const interval = window.setInterval(() => syncTracks(false), 1500);
    return () => window.clearInterval(interval);
  }, [playing]);

  const filteredSongs = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return songs;
    return songs.filter((song) => {
      return `${song.title} ${song.author}`.toLowerCase().includes(term);
    });
  }, [songs, searchTerm]);

  const visibleStems = useMemo(() => {
    if (!selectedSong?.stems) return [];
    return STEM_ORDER.filter((stem) => selectedSong.stems?.[stem]).map((stem) => ({
      id: stem,
      label: STEM_LABELS[stem] || stem,
    }));
  }, [selectedSong?.stems]);

  const isAnalyzingSelected = selectedSong ? analyzingIds.has(selectedSong.id) : false;

  function resolveUrl(url?: string | null) {
    if (!url) return '';
    if (url.startsWith('/uploads')) return `${API_URL}${url}`;
    return url;
  }

  function setAnalysisState(songId: string, active: boolean) {
    setAnalyzingIds((current) => {
      const next = new Set(current);
      if (active) next.add(songId);
      else next.delete(songId);
      return next;
    });
  }

  function unloadAllAudio() {
    Object.values(audioRefs.current).forEach((audio) => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    });
    audioRefs.current = {};
    setPlaying(false);
    setPosition(0);
    setDuration(0);
  }

  function createTrack(key: string, url: string, trackPosition = 0) {
    const audio = new Audio(resolveUrl(url));
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    audio.volume = mutes[key] ? 0 : (volumes[key] ?? 80) / 100;
    audio.currentTime = trackPosition;

    audio.addEventListener('loadedmetadata', () => {
      if (key !== 'metronome') setDuration(audio.duration || 0);
    });

    audio.addEventListener('timeupdate', () => {
      const tracker = getTracker();
      if (tracker === audio) setPosition(audio.currentTime || 0);
    });

    audio.addEventListener('ended', () => {
      const tracker = getTracker();
      if (tracker === audio) setPlaying(false);
    });

    audioRefs.current[key] = audio;
    return audio;
  }

  function getTracker() {
    const priority = [...STEM_ORDER, 'master'];
    const key = priority.find((item) => audioRefs.current[item]);
    return key ? audioRefs.current[key] : Object.values(audioRefs.current)[0];
  }

  async function loadAudioFromUrls(urls: AudioUrls, startAt = 0) {
    unloadAllAudio();

    if (urls.stems) {
      STEM_ORDER.filter((stem) => urls.stems?.[stem]).forEach((stem) => {
        createTrack(stem, urls.stems![stem], startAt);
      });
    } else if (urls.master) {
      createTrack('master', urls.master, startAt);
    }

    if (urls.metronome) {
      createTrack('metronome', urls.metronome, startAt);
    }

    const tracker = getTracker();
    if (tracker) {
      await new Promise<void>((resolve) => {
        if (tracker.readyState >= 1) return resolve();
        const done = () => resolve();
        tracker.addEventListener('loadedmetadata', done, { once: true });
        window.setTimeout(done, 2500);
      });
      setDuration(tracker.duration || 0);
      setPosition(startAt);
    }
  }

  async function selectSong(song: Song) {
    setSelectedSong(song);
    setPitch(0);

    const urls: AudioUrls = song.stems
      ? { stems: { ...song.stems }, metronome: song.metronomeUrl }
      : { master: song.audioUrl, metronome: song.metronomeUrl };

    originalUrlsRef.current = urls;
    await loadAudioFromUrls(urls);

    if (song.audioUrl && (!song.originalKey || !song.bpm || !song.metronomeUrl)) {
      void pollAnalysisJob(song.id, null, song.audioUrl);
    }
  }

  function syncTracks(force: boolean) {
    const tracks = Object.entries(audioRefs.current).filter(([, audio]) => Number.isFinite(audio.currentTime));
    if (tracks.length < 2) return;
    const positions = tracks.map(([, audio]) => audio.currentTime).sort((a, b) => a - b);
    const drift = positions[positions.length - 1] - positions[0];
    if (!force && drift < 0.08) return;
    const median = positions[Math.floor(positions.length / 2)];
    tracks.forEach(([, audio]) => {
      audio.currentTime = median;
    });
    setPosition(median);
  }

  async function togglePlay() {
    const tracks = Object.values(audioRefs.current);
    if (!tracks.length) return;

    if (playing) {
      tracks.forEach((audio) => audio.pause());
      setPlaying(false);
      return;
    }

    await playTracks(position);
  }

  async function playTracks(startAt: number) {
    const tracks = Object.values(audioRefs.current);
    if (!tracks.length) return;

    tracks.forEach((audio) => {
      audio.currentTime = startAt;
    });

    try {
      await Promise.all(tracks.map((audio) => audio.play()));
      setPosition(startAt);
      setPlaying(true);
      window.setTimeout(() => syncTracks(true), 250);
    } catch (error) {
      setNotice({ type: 'error', message: `Não consegui iniciar o áudio: ${safeError(error)}` });
    }
  }

  function seekTo(value: number) {
    Object.values(audioRefs.current).forEach((audio) => {
      audio.currentTime = value;
    });
    setPosition(value);
  }

  function updateVolume(key: string, value: number) {
    setVolumes((current) => ({ ...current, [key]: value }));
  }

  function toggleMute(key: string) {
    setMutes((current) => ({ ...current, [key]: !current[key] }));
  }

  async function pollAnalysisJob(songId: string, jobId?: string | null, audioUrl?: string) {
    if (analysisJobsRef.current.has(songId)) return;
    analysisJobsRef.current.add(songId);
    setAnalysisState(songId, true);

    try {
      let currentJobId = jobId || null;

      if (!currentJobId && audioUrl) {
        const start = await fetch(`${API_URL}/api/analyze/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioUrl }),
        });
        const text = await start.text();
        if (!start.ok) throw new Error(text || `HTTP ${start.status}`);
        currentJobId = JSON.parse(text).jobId;
      }

      if (!currentJobId) return;

      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
        const response = await fetch(`${API_URL}/api/analyze/status/${currentJobId}`);
        if (!response.ok) continue;

        const data = await response.json();
        if (data.status === 'succeeded') {
          const result = data.result || {};
          await updateDoc(doc(db, 'songs', songId), {
            originalKey: result.originalKey ?? null,
            originalScale: result.originalScale ?? null,
            bpm: result.bpm ?? null,
            metronomeUrl: result.metronomeUrl ?? null,
            durationS: result.durationS ?? null,
          });

          setSelectedSong((current) => {
            if (current?.id !== songId) return current;
            return {
              ...current,
              originalKey: result.originalKey ?? null,
              originalScale: result.originalScale ?? null,
              bpm: result.bpm ?? null,
              metronomeUrl: result.metronomeUrl ?? null,
              durationS: result.durationS ?? null,
            };
          });

          if (selectedSongRef.current?.id === songId && result.metronomeUrl && !audioRefs.current.metronome) {
            createTrack('metronome', result.metronomeUrl, position);
          }
          return;
        }

        if (data.status === 'failed') {
          throw new Error(data.error || 'A análise de tom/BPM falhou.');
        }
      }
    } catch (error) {
      setNotice({ type: 'error', message: `Análise em segundo plano falhou: ${safeError(error)}` });
    } finally {
      analysisJobsRef.current.delete(songId);
      setAnalysisState(songId, false);
    }
  }

  async function handleYoutubeCookiesFile(file?: File | null) {
    if (!file) return;

    try {
      if (file.size > 560_000) {
        throw new Error('Arquivo cookies.txt muito grande. Exporte apenas os cookies do youtube.com.');
      }

      const text = await file.text();
      if (!/youtube\.com/i.test(text)) {
        throw new Error('Esse arquivo nao parece conter cookies do YouTube.');
      }

      const encoded = textToBase64(text);
      if (encoded.length > 740_000) {
        throw new Error('Arquivo cookies.txt muito grande para enviar. Exporte apenas os cookies do youtube.com.');
      }

      setYoutubeCookiesBase64(encoded);
      setYoutubeCookiesName(file.name || 'cookies.txt');
      try {
        localStorage.setItem('louvorkey.youtubeCookiesBase64', encoded);
        localStorage.setItem('louvorkey.youtubeCookiesName', file.name || 'cookies.txt');
      } catch {
        // Se o navegador bloquear localStorage, mantemos em memoria nesta sessao.
      }

      setNotice({ type: 'success', message: 'Cookies do YouTube salvos neste navegador. Agora tente salvar a musica pelo link.' });
    } catch (error) {
      setNotice({ type: 'error', message: `Cookies do YouTube invalidos: ${safeError(error)}` });
    }
  }

  function clearYoutubeCookies() {
    setYoutubeCookiesBase64('');
    setYoutubeCookiesName('');
    try {
      localStorage.removeItem('louvorkey.youtubeCookiesBase64');
      localStorage.removeItem('louvorkey.youtubeCookiesName');
    } catch {
      // Nada a limpar quando localStorage nao estiver disponivel.
    }
    setNotice({ type: 'info', message: 'Cookies do YouTube removidos deste navegador.' });
  }

  async function addSong(event: React.FormEvent) {
    event.preventDefault();
    if (!newTitle.trim() || !newAuthor.trim()) {
      setNotice({ type: 'error', message: 'Preencha título e autor.' });
      return;
    }

    setBusyLabel(addMode === 'local' ? 'Preparando upload direto...' : 'Baixando áudio do YouTube...');

    try {
      let audioUrl = '';
      let analysisJobId: string | null = null;
      let metadata: Partial<Song> = {};

      if (addMode === 'local') {
        if (!newFile) throw new Error('Selecione um arquivo de áudio.');

        const signResponse = await fetch(`${API_URL}/api/cloudinary/sign-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: newFile.name }),
        });
        const signed = await readJsonResponse<{
          apiKey: string;
          timestamp: number;
          signature: string;
          folder: string;
          publicId: string;
          uploadUrl: string;
        }>(signResponse);

        setBusyLabel('Enviando áudio para Cloudinary...');
        const formData = new FormData();
        formData.append('file', newFile);
        formData.append('api_key', String(signed.apiKey));
        formData.append('timestamp', String(signed.timestamp));
        formData.append('signature', String(signed.signature));
        formData.append('folder', String(signed.folder));
        formData.append('public_id', String(signed.publicId));

        const uploadResponse = await fetch(signed.uploadUrl, {
          method: 'POST',
          body: formData,
        });
        const uploadData = await readJsonResponse<{ secure_url: string }>(uploadResponse);
        audioUrl = uploadData.secure_url;
      } else {
        if (!newYoutubeUrl.trim()) throw new Error('Cole o link do YouTube.');
        const response = await fetch(`${API_URL}/api/youtube`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: newYoutubeUrl.trim(),
            cookiesBase64: youtubeCookiesBase64 || undefined,
          }),
        });
        const data = await readJsonResponse<Partial<Song> & { url: string; analysisJobId?: string | null }>(response);
        audioUrl = data.url;
        analysisJobId = data.analysisJobId || null;
        metadata = {
          originalKey: data.originalKey ?? null,
          originalScale: data.originalScale ?? null,
          bpm: data.bpm ?? null,
          metronomeUrl: data.metronomeUrl ?? null,
          durationS: data.durationS ?? null,
        };
      }

      setBusyLabel('Salvando no repertório...');
      const songRef = await addDoc(collection(db, 'songs'), {
        title: newTitle.trim(),
        author: newAuthor.trim(),
        audioUrl,
        thumbnail: COVER_URL,
        originalKey: metadata.originalKey ?? null,
        originalScale: metadata.originalScale ?? null,
        bpm: metadata.bpm ?? null,
        metronomeUrl: metadata.metronomeUrl ?? null,
        durationS: metadata.durationS ?? null,
        createdAt: serverTimestamp(),
      });

      if (analysisJobId) {
        void pollAnalysisJob(songRef.id, analysisJobId, audioUrl);
      } else if (addMode === 'local') {
        void pollAnalysisJob(songRef.id, null, audioUrl);
      }

      setShowAdd(false);
      setNewTitle('');
      setNewAuthor('');
      setNewYoutubeUrl('');
      setNewFile(null);
      setNotice({ type: 'success', message: 'Música adicionada. Tom, BPM e metrônomo serão refinados em segundo plano.' });
    } catch (error) {
      setNotice({ type: 'error', message: `Falha ao adicionar música: ${safeError(error)}` });
    } finally {
      setBusyLabel('');
    }
  }

  async function separateStems() {
    if (!selectedSong) return;
    setIsSeparating(true);
    setSeparateElapsed(0);
    separateStartedAtRef.current = Date.now();

    try {
      const start = await fetch(`${API_URL}/api/separate/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: selectedSong.audioUrl }),
      });
      const startText = await start.text();
      if (!start.ok) throw new Error(startText || `HTTP ${start.status}`);
      const { jobId } = JSON.parse(startText);
      if (!jobId) throw new Error('Servidor não retornou jobId.');

      let stems: Record<string, string> | null = null;
      let separationModel: string | null = null;
      let stemsFormat: string | null = null;

      for (let attempt = 0; attempt < 400; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const status = await fetch(`${API_URL}/api/separate/status/${jobId}`);
        if (!status.ok) continue;
        const data = await status.json();

        if (data.status === 'succeeded') {
          stems = data.stems;
          separationModel = data.model ?? null;
          stemsFormat = data.outputFormat ?? null;
          break;
        }

        if (data.status === 'failed' || data.status === 'canceled') {
          throw new Error(data.error || `Demucs ${data.status}`);
        }
      }

      if (!stems) throw new Error('Timeout: separação demorou mais de 20 minutos.');

      const updatedSong: Song = { ...selectedSong, stems, separationModel, stemsFormat };
      await updateDoc(doc(db, 'songs', selectedSong.id), {
        stems,
        separationModel,
        stemsFormat,
      });
      setSelectedSong(updatedSong);
      await selectSong(updatedSong);

      if (!updatedSong.metronomeUrl && updatedSong.audioUrl) {
        void pollAnalysisJob(updatedSong.id, null, updatedSong.audioUrl);
      }

      setNotice({ type: 'success', message: 'Separação IA Pro concluída.' });
    } catch (error) {
      setNotice({ type: 'error', message: `Falha na separação: ${safeError(error)}` });
    } finally {
      setIsSeparating(false);
      separateStartedAtRef.current = null;
    }
  }

  async function changePitch(nextPitch: number) {
    if (!selectedSong || nextPitch === pitch) return;
    const bounded = Math.max(-6, Math.min(6, nextPitch));
    pitchAbortRef.current?.abort();
    const controller = new AbortController();
    pitchAbortRef.current = controller;
    const wasPlaying = playing;
    const savedPosition = position;

    setPitch(bounded);
    setIsPitchLoading(true);

    try {
      Object.values(audioRefs.current).forEach((audio) => audio.pause());

      const pitchOne = async (url: string) => {
        const response = await fetch(`${API_URL}/api/pitch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ audioUrl: url, semitones: bounded }),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
        return JSON.parse(text).url as string;
      };

      const original = originalUrlsRef.current;
      let pitched: AudioUrls;

      if (original.stems) {
        const entries = await Promise.all(
          Object.entries(original.stems).map(async ([key, url]) => [key, await pitchOne(url)] as const)
        );
        pitched = { stems: Object.fromEntries(entries), metronome: original.metronome };
      } else if (original.master) {
        pitched = { master: await pitchOne(original.master), metronome: original.metronome };
      } else {
        return;
      }

      if (controller.signal.aborted) return;
      await loadAudioFromUrls(pitched, savedPosition);

      if (wasPlaying) {
        await playTracks(savedPosition);
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setNotice({ type: 'error', message: `Falha ao mudar tom: ${safeError(error)}` });
      }
    } finally {
      if (pitchAbortRef.current === controller) setIsPitchLoading(false);
    }
  }

  async function deleteSong() {
    if (!selectedSong) return;
    const ok = window.confirm(`Apagar "${selectedSong.title}" do repertório?`);
    if (!ok) return;
    await deleteDoc(doc(db, 'songs', selectedSong.id));
    unloadAllAudio();
    setSelectedSong(null);
    setNotice({ type: 'success', message: 'Música apagada do repertório.' });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          <span className="brand-mark">
            <Music size={22} />
          </span>
          <span>
            <strong>LouvorKey</strong>
            <small>Studio Web</small>
          </span>
        </button>

        <div className="topbar-actions">
          <span className="connection-pill">
            <Activity size={15} />
            Online
          </span>
          <button className="primary-action" onClick={() => setShowAdd(true)}>
            <Plus size={18} />
            Nova música
          </button>
        </div>
      </header>

      <main className="main-grid">
        <section className="library-panel">
          <div className="hero-card">
            <div>
              <p className="eyebrow">Repertório do ministério</p>
              <h1>Ensaios prontos no celular e no PC.</h1>
              <p className="hero-copy">
                Adicione músicas, mude o tom, gere metrônomo virtual e separe stems com IA Pro sem instalar APK.
              </p>
            </div>
            <div className="hero-stats">
              <span>{songs.length}</span>
              <small>músicas</small>
            </div>
          </div>

          <div className="search-box">
            <Search size={18} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Buscar música, banda ou ministério..."
            />
          </div>

          <div className="song-grid">
            {filteredSongs.map((song) => (
              <button
                key={song.id}
                className={`song-card ${selectedSong?.id === song.id ? 'is-active' : ''}`}
                onClick={() => void selectSong(song)}
              >
                <img src={song.thumbnail || COVER_URL} alt="" />
                <span className="song-card-body">
                  <strong>{song.title}</strong>
                  <small>{song.author}</small>
                  <em>
                    {song.stems ? 'Stems IA' : 'Master'} {song.bpm ? `· ${Math.round(song.bpm)} BPM` : ''}
                  </em>
                </span>
              </button>
            ))}

            {!filteredSongs.length && (
              <div className="empty-state">
                <FileAudio size={40} />
                <strong>Nenhuma música encontrada</strong>
                <span>Adicione uma música ou ajuste a busca.</span>
              </div>
            )}
          </div>
        </section>

        <aside className="studio-panel">
          {!selectedSong ? (
            <div className="studio-empty">
              <Sparkles size={42} />
              <h2>Selecione uma música</h2>
              <p>O player, o mixer, o metrônomo e a IA aparecem aqui.</p>
            </div>
          ) : (
            <>
              <div className="studio-header">
                <img src={selectedSong.thumbnail || COVER_URL} alt="" />
                <div>
                  <p className="eyebrow">Studio Player</p>
                  <h2>{selectedSong.title}</h2>
                  <span>{selectedSong.author}</span>
                </div>
                <button className="icon-danger" onClick={() => void deleteSong()} title="Apagar música">
                  <Trash2 size={18} />
                </button>
              </div>

              <div className="transport-card">
                <div className="timeline-row">
                  <span>{formatTime(position)}</span>
                  <input
                    type="range"
                    min={0}
                    max={duration || 1}
                    step={0.1}
                    value={Math.min(position, duration || 1)}
                    onChange={(event) => seekTo(Number(event.target.value))}
                  />
                  <span>{formatTime(duration)}</span>
                </div>

                <div className="transport-actions">
                  <button className="ghost-button" onClick={() => seekTo(0)}>
                    <RotateCcw size={18} />
                  </button>
                  <button className="play-button" onClick={() => void togglePlay()}>
                    {playing ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}
                  </button>
                  <a className="ghost-button" href={resolveUrl(selectedSong.audioUrl)} target="_blank" rel="noreferrer">
                    <Download size={18} />
                  </a>
                </div>
              </div>

              <section className="control-card">
                <div className="section-title">
                  <Wand2 size={18} />
                  <div>
                    <strong>Tom</strong>
                    <small>
                      Original: {selectedSong.originalKey ? normalizeKey(selectedSong.originalKey) : 'analisando'} · Atual:{' '}
                      {noteFromSemitones(pitch, selectedSong.originalKey)}
                    </small>
                  </div>
                  {isPitchLoading && <Loader2 className="spin" size={18} />}
                </div>

                <div className="pitch-grid">
                  {Array.from({ length: 13 }, (_, index) => index - 6).map((value) => (
                    <button
                      key={value}
                      className={value === pitch ? 'is-active' : ''}
                      disabled={isPitchLoading}
                      onClick={() => void changePitch(value)}
                    >
                      <strong>{noteFromSemitones(value, selectedSong.originalKey)}</strong>
                      <span>{value === 0 ? 'orig.' : value > 0 ? `+${value}` : value}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="control-card">
                <div className="section-title">
                  <Clock size={18} />
                  <div>
                    <strong>Metrônomo virtual</strong>
                    <small>
                      {selectedSong.metronomeUrl
                        ? `${selectedSong.bpm ? Math.round(selectedSong.bpm) : '?'} BPM detectado`
                        : isAnalyzingSelected
                          ? 'gerando em segundo plano...'
                          : 'ainda não gerado'}
                    </small>
                  </div>
                </div>

                {selectedSong.metronomeUrl ? (
                  <MixerRow id="metronome" label="Click" volumes={volumes} mutes={mutes} onVolume={updateVolume} onMute={toggleMute} />
                ) : (
                  <button className="wide-soft-button" onClick={() => void pollAnalysisJob(selectedSong.id, null, selectedSong.audioUrl)}>
                    {isAnalyzingSelected ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
                    Gerar metrônomo e BPM
                  </button>
                )}
              </section>

              <section className="control-card">
                <div className="section-title">
                  <SlidersHorizontal size={18} />
                  <div>
                    <strong>Mixer</strong>
                    <small>
                      {selectedSong.stems
                        ? `${visibleStems.length} stems · ${selectedSong.stemsFormat || 'alta qualidade'}`
                        : 'separe as faixas com IA Pro'}
                    </small>
                  </div>
                </div>

                {!selectedSong.stems ? (
                  <button className="ai-button" onClick={() => void separateStems()} disabled={isSeparating}>
                    {isSeparating ? <Loader2 className="spin" size={20} /> : <Sparkles size={20} />}
                    {isSeparating ? `Separando... ${formatTime(separateElapsed)}` : 'Separar faixas com IA Pro'}
                  </button>
                ) : (
                  <>
                    <button className="wide-soft-button" onClick={() => void separateStems()} disabled={isSeparating}>
                      {isSeparating ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                      {isSeparating ? `Reprocessando... ${formatTime(separateElapsed)}` : 'Reprocessar IA Pro'}
                    </button>
                    <div className="mixer-list">
                      {visibleStems.map((stem) => (
                        <MixerRow
                          key={stem.id}
                          id={stem.id}
                          label={stem.label}
                          volumes={volumes}
                          mutes={mutes}
                          onVolume={updateVolume}
                          onMute={toggleMute}
                        />
                      ))}
                    </div>
                  </>
                )}
              </section>
            </>
          )}
        </aside>
      </main>

      {showAdd && (
        <div className="modal-backdrop" onMouseDown={() => !busyLabel && setShowAdd(false)}>
          <form className="modal-card" onSubmit={(event) => void addSong(event)} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">Novo repertório</p>
                <h2>Adicionar música</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setShowAdd(false)} disabled={!!busyLabel}>
                <X size={20} />
              </button>
            </div>

            <div className="segmented">
              <button type="button" className={addMode === 'local' ? 'is-active' : ''} onClick={() => setAddMode('local')}>
                <UploadCloud size={17} />
                Arquivo
              </button>
              <button type="button" className={addMode === 'youtube' ? 'is-active' : ''} onClick={() => setAddMode('youtube')}>
                <Youtube size={17} />
                YouTube
              </button>
            </div>

            <label className="field">
              <span>Título</span>
              <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Ex: Bondade de Deus" />
            </label>

            <label className="field">
              <span>Autor / Ministério</span>
              <input value={newAuthor} onChange={(event) => setNewAuthor(event.target.value)} placeholder="Ex: Isaías Saad" />
            </label>

            {addMode === 'local' ? (
              <label className="drop-field">
                <FileAudio size={22} />
                <strong>{newFile ? newFile.name : 'Escolher MP3, WAV ou M4A'}</strong>
                <small>O upload vai direto para Cloudinary, sem timeout no Render.</small>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(event) => setNewFile(event.target.files?.[0] || null)}
                />
              </label>
            ) : (
              <>
                <label className="field">
                  <span>Link do YouTube</span>
                  <input
                    value={newYoutubeUrl}
                    onChange={(event) => setNewYoutubeUrl(event.target.value)}
                    placeholder="https://youtube.com/watch?v=..."
                  />
                </label>

                <div className="cookies-card">
                  <div className="cookies-copy">
                    <UploadCloud size={18} />
                    <div>
                      <strong>Cookies do YouTube</strong>
                      <small>
                        {youtubeCookiesName
                          ? `Usando ${youtubeCookiesName}`
                          : 'Opcional: anexe quando o YouTube bloquear o servidor.'}
                      </small>
                    </div>
                  </div>
                  <div className="cookies-actions">
                    <label className="mini-file-button">
                      {youtubeCookiesName ? 'Trocar' : 'Anexar cookies.txt'}
                      <input
                        type="file"
                        accept=".txt,text/plain"
                        disabled={!!busyLabel}
                        onChange={(event) => {
                          void handleYoutubeCookiesFile(event.target.files?.[0] || null);
                          event.currentTarget.value = '';
                        }}
                      />
                    </label>
                    {youtubeCookiesName && (
                      <button type="button" className="text-button" onClick={clearYoutubeCookies} disabled={!!busyLabel}>
                        Remover
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}

            <button className="submit-button" type="submit" disabled={!!busyLabel}>
              {busyLabel ? <Loader2 className="spin" size={20} /> : <Plus size={20} />}
              {busyLabel || 'Salvar música'}
            </button>
          </form>
        </div>
      )}

      {notice && (
        <div className={`notice ${notice.type}`}>
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function MixerRow({
  id,
  label,
  volumes,
  mutes,
  onVolume,
  onMute,
}: {
  id: string;
  label: string;
  volumes: Record<string, number>;
  mutes: Record<string, boolean>;
  onVolume: (id: string, value: number) => void;
  onMute: (id: string) => void;
}) {
  const muted = !!mutes[id];

  return (
    <div className="mixer-row">
      <button className={muted ? 'mute-button is-muted' : 'mute-button'} onClick={() => onMute(id)} type="button">
        {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
      <div className="mixer-main">
        <div>
          <strong>{label}</strong>
          <span>{volumes[id] ?? 0}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={volumes[id] ?? 0}
          onChange={(event) => onVolume(id, Number(event.target.value))}
        />
      </div>
    </div>
  );
}
