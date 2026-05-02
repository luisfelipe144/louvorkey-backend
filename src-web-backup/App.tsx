/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import * as Tone from 'tone';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  Music, 
  Search, 
  Volume2, 
  VolumeX,
  ChevronUp,
  ChevronDown,
  Loader2,
  Youtube,
  Info,
  Plus,
  Send,
  X,
  CheckCircle2,
  Clock
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db } from './firebase';
import { 
  collection, 
  onSnapshot, 
  addDoc, 
  query, 
  orderBy, 
  serverTimestamp,
  getDocFromServer,
  doc
} from 'firebase/firestore';
import { auth } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';

interface Song {
  id: string;
  title: string;
  author: string;
  thumbnail: string;
  audioUrl: string;
  createdAt: any;
  stems?: {
    bass: string;
    drums: string;
    other: string;
    vocals: string;
  };
}

interface Request {
  id: string;
  youtubeUrl: string;
  songTitle: string;
  status: 'pending' | 'added';
  createdAt: any;
}

const SEMITONES = [
  { label: '-6', value: -6 },
  { label: '-5', value: -5 },
  { label: '-4', value: -4 },
  { label: '-3', value: -3 },
  { label: '-2', value: -2 },
  { label: '-1', value: -1 },
  { label: 'Original', value: 0 },
  { label: '+1', value: 1 },
  { label: '+2', value: 2 },
  { label: '+3', value: 3 },
  { label: '+4', value: 4 },
  { label: '+5', value: 5 },
  { label: '+6', value: 6 },
];

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const transposeKey = (originalKey: string, semitones: number) => {
  if (!originalKey) return '-';
  const startIndex = KEYS.indexOf(originalKey.toUpperCase());
  if (startIndex === -1) return originalKey;
  
  let newIndex = (startIndex + semitones) % 12;
  if (newIndex < 0) newIndex += 12;
  
  return KEYS[newIndex];
};

export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pitch, setPitch] = useState(0);
  const [volume, setVolume] = useState(0);
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
  
  // Modal states
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [requestUrl, setRequestUrl] = useState('');
  const [requestTitle, setRequestTitle] = useState('');

  // Add Song states
  const [newSongTitle, setNewSongTitle] = useState('');
  const [newSongAuthor, setNewSongAuthor] = useState('');
  const [newSongFile, setNewSongFile] = useState<File | null>(null);
  const [addMode, setAddMode] = useState<'local' | 'youtube'>('local');
  const [newSongYoutubeUrl, setNewSongYoutubeUrl] = useState('');

  // IA Stems state
  const [isSeparating, setIsSeparating] = useState(false);
  const [stemVolumes, setStemVolumes] = useState({
    vocals: 80,
    drums: 80,
    bass: 80,
    guitar: 80,
    piano: 80,
    other: 80
  });
  const [stemMutes, setStemMutes] = useState({
    vocals: false,
    drums: false,
    bass: false,
    guitar: false,
    piano: false,
    other: false
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pitchShiftRef = useRef<Tone.PitchShift | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const initializedRef = useRef(false);

  // Utility to log errors to Firestore for AI diagnosis
  const logSystemError = async (message: string, err: any, context: string) => {
    console.error(`[LOG] ${message}:`, err, `Context: ${context}`);
    try {
      await addDoc(collection(db, 'system_logs'), {
        message,
        error: err?.message || String(err),
        stack: err?.stack || 'N/A',
        context,
        timestamp: serverTimestamp()
      });
    } catch (logErr: any) {
      console.error("Falha ao gravar log no Firestore:", logErr);
      setFirebaseError(`Erro crítico: ${logErr.message || "Falha na comunicação com o banco"}`);
    }
  };

  // Global Error Handler
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      const msg = event.message || '';
      if (msg.includes('WebSocket') || msg.includes('vite')) return;
      logSystemError("Erro Global Capturado", event.error || msg, "window.onerror");
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = String(event.reason || '');
      if (reason.includes('WebSocket') || reason.includes('vite')) return;
      logSystemError("Promessa Rejeitada", event.reason, "window.onunhandledrejection");
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  // Auth Listener - Just monitoring, no automatic login to avoid restricted operation error
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) console.log("Usuário logado:", user.uid);
    });
    return () => unsub();
  }, []);

  // Test Connection & Fetch data
  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'songs', 'test-connection'));
      } catch (err: any) {
        if (err.message?.includes('offline')) {
          setFirebaseError("O Firebase parece estar offline ou a configuração está incorreta.");
        }
      }
    };
    testConnection();

    const songsQuery = query(collection(db, 'songs'), orderBy('createdAt', 'desc'));
    const unsubSongs = onSnapshot(songsQuery, (snapshot) => {
      const songsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Song));
      setSongs(songsData);
      setFirebaseError(null); // Clear error on success
    }, (err) => {
      console.error("Erro ao ler músicas:", err);
      logSystemError("Erro ao ler repertório", err, "onSnapshot songs");
      setFirebaseError(`Erro de conexão: ${err.message}`);
    });

    const requestsQuery = query(collection(db, 'requests'), orderBy('createdAt', 'desc'));
    const unsubRequests = onSnapshot(requestsQuery, (snapshot) => {
      const requestsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Request));
      setRequests(requestsData);
    });

    return () => {
      unsubSongs();
      unsubRequests();
    };
  }, []);

  const handleSeparateStems = async () => {
    if (!selectedSong) return;
    setIsSeparating(true);
    try {
      const res = await fetch('/api/separate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: selectedSong.audioUrl })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || err.details || "Erro desconhecido na IA");
      }
      const data = await res.json();
      console.log("Stems recebidos da Replicate:", data.stems);
      
      // Atualizar o Firebase com as URLs das stems
      const { doc, updateDoc } = await import('firebase/firestore');
      await updateDoc(doc(db, 'songs', selectedSong.id), {
        stems: data.stems
      });

      // Atualiza o estado local para refletir a mudança
      setSelectedSong(prev => prev ? { ...prev, stems: data.stems } : null);
      alert("Separação de faixas concluída com sucesso!");
    } catch (err: any) {
      console.error(err);
      alert("Falha na separação: " + err.message);
    } finally {
      setIsSeparating(false);
    }
  };

  // Initialize Tone.js
  const initAudio = async () => {
    if (initializedRef.current) return;
    await Tone.start();
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audioRef.current = audio;
    const pitchShift = new Tone.PitchShift(0);
    pitchShiftRef.current = pitchShift;
    const source = Tone.getContext().createMediaElementSource(audio);
    sourceRef.current = source;
    Tone.connect(source, pitchShift);
    pitchShift.toDestination();
    initializedRef.current = true;

    audio.ontimeupdate = () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration) setProgress((audio.currentTime / audio.duration) * 100);
    };
    audio.onloadedmetadata = () => setDuration(audio.duration);
    audio.onended = () => setPlaying(false);
  };

  const handleSelectSong = async (song: Song) => {
    setLoading(true);
    setError(null);
    try {
      await initAudio();
      setSelectedSong(song);
      if (audioRef.current) {
        audioRef.current.src = song.audioUrl;
        audioRef.current.load();
        setPlaying(false);
        setPitch(0);
        if (pitchShiftRef.current) pitchShiftRef.current.pitch = 0;
      }
    } catch (err) {
      setError("Erro ao carregar música.");
    } finally {
      setLoading(false);
    }
  };

  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requestUrl) return;
    try {
      await addDoc(collection(db, 'requests'), {
        youtubeUrl: requestUrl,
        songTitle: requestTitle || "Sem título",
        status: 'pending',
        createdAt: serverTimestamp()
      });
      setRequestUrl('');
      setRequestTitle('');
      setShowRequestModal(false);
      alert("Solicitação enviada com sucesso!");
    } catch (err) {
      logSystemError("Erro ao enviar solicitação", err, "handleSendRequest");
      alert("Erro ao enviar solicitação.");
    }
  };

  const handleAddSong = async (e: React.FormEvent) => {
    e.preventDefault();
    if (addMode === 'local' && (!newSongTitle || !newSongAuthor || !newSongFile)) return;
    if (addMode === 'youtube' && (!newSongTitle || !newSongAuthor || !newSongYoutubeUrl)) return;
    
    setLoading(true);
    setUploadProgress(0);
    setError(null);
    try {
      let downloadUrl = '';
      
      if (addMode === 'youtube') {
        console.log("Baixando do YouTube via backend...");
        const ytResponse = await fetch('/api/youtube', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: newSongYoutubeUrl })
        });
        
        if (!ytResponse.ok) {
          const errData = await ytResponse.json();
          throw new Error(errData.error || "Falha ao processar link do YouTube");
        }
        
        const ytData = await ytResponse.json();
        downloadUrl = ytData.url;
      } else {
        console.log("Fazendo upload localmente...");
        const formData = new FormData();
        formData.append('file', newSongFile as File);

        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (!uploadResponse.ok) {
          const errData = await uploadResponse.json();
          throw new Error(errData.error || "Falha no upload do arquivo local");
        }

        const uploadData = await uploadResponse.json();
        downloadUrl = uploadData.url;
      }

      console.log("Salvando metadados no Firestore...");
      await addDoc(collection(db, 'songs'), {
        title: newSongTitle,
        author: newSongAuthor,
        thumbnail: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400&h=400&fit=crop",
        audioUrl: downloadUrl,
        createdAt: serverTimestamp()
      });

      setNewSongTitle('');
      setNewSongAuthor('');
      setNewSongFile(null);
      setNewSongYoutubeUrl('');
      setUploadProgress(0);
      setShowAddModal(false);
      setLoading(false);
      alert("Música adicionada ao repertório com sucesso!");
      
    } catch (err: any) {
      console.error("Erro ao adicionar música:", err);
      logSystemError("Erro ao adicionar música", err, "handleAddSong");
      setError(`Erro: ${err.message || 'Erro desconhecido'}`);
      setLoading(false);
    }
  };

  const togglePlay = () => {
    if (!audioRef.current || !selectedSong) return;
    if (playing) audioRef.current.pause();
    else audioRef.current.play();
    setPlaying(!playing);
  };

  const handlePitchChange = (val: number) => {
    setPitch(val);
    if (pitchShiftRef.current) pitchShiftRef.current.pitch = val;
  };

  const handleVolumeChange = (val: number) => {
    setVolume(val);
    if (audioRef.current) {
      const linear = Math.pow(10, val / 20);
      audioRef.current.volume = Math.min(1, Math.max(0, linear));
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (audioRef.current && audioRef.current.duration) {
      audioRef.current.currentTime = (val / 100) * audioRef.current.duration;
      setProgress(val);
    }
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const filteredSongs = songs.filter(s => 
    s.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.author.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-[#0a0a0a]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center text-white">
              <Music size={18} />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">LouvorKey</h1>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setShowRequestModal(true)}
              className="text-sm font-medium text-white/60 hover:text-emerald-500 transition-colors flex items-center gap-2"
            >
              <Youtube size={16} />
              Solicitar Música
            </button>
            <button 
              onClick={() => setShowAddModal(true)}
              className="bg-emerald-500 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-emerald-600 transition-all flex items-center gap-2 shadow-sm"
            >
              <Plus size={16} />
              Adicionar ao Repertório
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        {firebaseError && (
          <div className="mb-8 p-4 bg-red-50 border border-red-100 rounded-2xl text-red-600 text-sm flex items-center gap-2">
            <Info size={16} />
            {firebaseError}
          </div>
        )}
        {/* Search & Filter */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-12">
          <div>
            <h2 className="text-3xl font-medium tracking-tight mb-2">Repertório de Louvor</h2>
            <p className="text-white/40 text-sm">Selecione uma música para ensaiar e mudar o tom.</p>
          </div>
          <div className="relative w-full md:w-96">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30" size={18} />
            <input 
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar no repertório..."
              className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 pl-12 pr-4 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all shadow-sm"
            />
          </div>
        </div>

        {/* Songs Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {filteredSongs.map((song) => (
            <motion.div
              key={song.id}
              whileHover={{ y: -4 }}
              onClick={() => handleSelectSong(song)}
              className={`group cursor-pointer bg-white/5 rounded-3xl p-4 border transition-all shadow-sm hover:shadow-md ${selectedSong?.id === song.id ? 'border-emerald-500 ring-2 ring-emerald-500/10' : 'border-white/5'}`}
            >
              <div className="aspect-square rounded-2xl overflow-hidden mb-4 relative">
                <img 
                  src={song.thumbnail} 
                  alt={song.title} 
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
                {selectedSong?.id === song.id && playing && (
                  <div className="absolute inset-0 bg-emerald-500/20 flex items-center justify-center">
                    <div className="flex gap-1 items-end h-6">
                      <motion.div animate={{ height: [8, 24, 12] }} transition={{ repeat: Infinity, duration: 0.5 }} className="w-1 bg-white rounded-full" />
                      <motion.div animate={{ height: [16, 8, 24] }} transition={{ repeat: Infinity, duration: 0.6 }} className="w-1 bg-white rounded-full" />
                      <motion.div animate={{ height: [24, 12, 16] }} transition={{ repeat: Infinity, duration: 0.4 }} className="w-1 bg-white rounded-full" />
                    </div>
                  </div>
                )}
              </div>
              <h3 className="font-medium text-lg leading-tight mb-1 line-clamp-1">{song.title}</h3>
              <p className="text-white/40 text-sm">{song.author}</p>
            </motion.div>
          ))}
          
          {filteredSongs.length === 0 && (
            <div className="col-span-full py-20 text-center text-white/20">
              <Music size={48} className="mx-auto mb-4 opacity-20" />
              <p className="text-lg font-medium">Nenhuma música encontrada</p>
              <p className="text-sm text-white/40">Tente buscar por outro nome ou adicione uma nova.</p>
            </div>
          )}
        </div>

        {/* Studio Player Modal (Estilo Moises) */}
        <AnimatePresence>
          {selectedSong && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0a0a0a]">
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="w-full h-full relative z-10 flex flex-col lg:flex-row"
              >
                <button 
                  onClick={() => setSelectedSong(null)}
                  className="absolute right-6 top-6 text-white/50 hover:text-white transition-colors z-20 bg-white/5 hover:bg-white/10 p-3 rounded-full"
                >
                  <X size={28} />
                </button>

                {/* Left Side: Artwork & Info */}
                <div className="w-full lg:w-2/5 h-full bg-black/20 p-8 lg:p-12 flex flex-col items-center justify-start border-r border-white/5 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                  <div className="w-full max-w-sm mx-auto flex flex-col items-center mt-auto mb-auto">
                    <img 
                    src={selectedSong.thumbnail} 
                    alt={selectedSong.title} 
                    className="w-48 h-48 md:w-64 md:h-64 rounded-2xl object-cover shadow-2xl mb-6"
                  />
                  <h3 className="text-2xl font-bold text-white text-center mb-1">{selectedSong.title}</h3>
                  <p className="text-emerald-400 text-sm mb-8">{selectedSong.author}</p>

                  <div className="flex gap-4 w-full mb-8">
                    <div className="flex-1 bg-white/5 rounded-xl p-4 text-center border border-white/5">
                      <div className="text-white/40 text-[10px] uppercase tracking-widest font-bold mb-1">BPM</div>
                      <div className="text-xl font-mono text-white">120 <span className="text-xs text-white/20">bpm</span></div>
                    </div>
                    <div className="flex-1 bg-white/5 rounded-xl p-4 text-center border border-white/5">
                      <div className="text-white/40 text-[10px] uppercase tracking-widest font-bold mb-1">Tom Original</div>
                      <div className="text-xl font-mono text-white">C <span className="text-xs text-white/20">Maior</span></div>
                    </div>
                  </div>

                  {/* Moises AI Button */}
                  <div className="w-full">
                    {!selectedSong.stems ? (
                      <button
                        onClick={handleSeparateStems}
                        disabled={isSeparating}
                        className={`w-full py-4 px-6 rounded-2xl font-bold transition-all flex items-center justify-center gap-3 ${
                          isSeparating 
                            ? 'bg-white/5 text-white/40 cursor-not-allowed border border-white/5'
                            : 'bg-emerald-500 text-white hover:bg-emerald-400 shadow-xl shadow-emerald-500/20'
                        }`}
                      >
                        {isSeparating ? (
                          <>
                            <Loader2 size={20} className="animate-spin" />
                            Separando faixas (1-3 min)...
                          </>
                        ) : (
                          <>
                            <Music size={20} />
                            Separar Faixas
                          </>
                        )}
                      </button>
                    ) : (
                      <div className="w-full bg-black/40 border border-white/5 rounded-2xl p-4">
                        <h4 className="text-white font-medium mb-4 flex items-center gap-2">
                          <CheckCircle2 size={16} className="text-emerald-400" />
                          Mixer de Faixas
                        </h4>
                        
                        <div className="space-y-4">
                          {[
                            { id: 'vocals', label: 'Voz', icon: <Music size={14} /> },
                            { id: 'drums', label: 'Bateria', icon: <Music size={14} /> },
                            { id: 'bass', label: 'Baixo', icon: <Music size={14} /> },
                            { id: 'guitar', label: 'Guitarra/Violão', icon: <Music size={14} /> },
                            { id: 'piano', label: 'Teclado/Piano', icon: <Music size={14} /> },
                            { id: 'other', label: 'Metrônomo Inteligente', icon: <Clock size={14} /> }
                          ].map(stem => (
                            <div key={stem.id} className="flex items-center gap-4 bg-white/5 p-3 rounded-xl border border-white/5">
                              <button 
                                onClick={() => setStemMutes(prev => ({...prev, [stem.id]: !prev[stem.id as keyof typeof stemMutes]}))}
                                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                                  stemMutes[stem.id as keyof typeof stemMutes] 
                                    ? 'bg-red-500/20 text-red-500' 
                                    : 'bg-emerald-500/20 text-emerald-400'
                                }`}
                              >
                                {stem.icon}
                              </button>
                              
                              <div className="flex-1">
                                <div className="flex justify-between text-xs font-medium text-white/60 mb-2">
                                  <span>{stem.label}</span>
                                  <span>{stemVolumes[stem.id as keyof typeof stemVolumes]}%</span>
                                </div>
                                <input 
                                  type="range" 
                                  min="0" 
                                  max="100" 
                                  value={stemVolumes[stem.id as keyof typeof stemVolumes]}
                                  onChange={(e) => setStemVolumes(prev => ({...prev, [stem.id]: parseInt(e.target.value)}))}
                                  className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-emerald-500"
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  </div>
                </div>

                {/* Right Side: Studio Controls */}
                <div className="w-full lg:w-3/5 h-full p-8 lg:p-12 flex flex-col justify-start overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                  <div className="w-full max-w-2xl mx-auto my-auto">
                  {/* Pitch Shifter */}
                  <div className="bg-white/5 rounded-2xl p-6 mb-8 border border-white/5">
                    <div className="flex items-center justify-between mb-6">
                      <div>
                        <h4 className="text-white font-medium flex items-center gap-2">
                          <Music size={16} className="text-emerald-400" />
                          Transposição de Tom
                        </h4>
                        <p className="text-white/40 text-xs mt-1">Altere o tom original sem mudar a velocidade</p>
                      </div>
                      <div className="text-right">
                        <div className="text-3xl font-bold text-white tracking-tighter">
                          {transposeKey('C', pitch)}
                        </div>
                        <div className="text-emerald-400 text-xs font-mono">
                          {pitch === 0 ? 'Original' : pitch > 0 ? `+${pitch} Semitons` : `${pitch} Semitons`}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-4 bg-black/40 rounded-xl p-2">
                      <button 
                        onClick={() => handlePitchChange(pitch - 1)}
                        className="w-12 h-12 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-all"
                      >
                        <ChevronDown size={28} />
                      </button>
                      <div className="flex-1 text-center font-mono text-white/40 text-sm">
                        Original: C
                      </div>
                      <button 
                        onClick={() => handlePitchChange(pitch + 1)}
                        className="w-12 h-12 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-all"
                      >
                        <ChevronUp size={28} />
                      </button>
                    </div>
                  </div>

                  {/* Playback Controls */}
                  <div className="mb-8">
                    <div className="flex items-center justify-between text-xs font-mono text-white/40 mb-3">
                      <span>{formatTime(currentTime)}</span>
                      <span>{formatTime(duration)}</span>
                    </div>
                    <input 
                      type="range" 
                      min="0" 
                      max="100" 
                      step="0.1"
                      value={progress}
                      onChange={handleSeek}
                      className="w-full h-2 bg-white/10 rounded-full appearance-none cursor-pointer accent-emerald-500 hover:accent-emerald-400 transition-all"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 bg-white/5 px-4 py-3 rounded-xl border border-white/5">
                      <button onClick={() => setMuted(!muted)} className="text-white/60 hover:text-white transition-colors">
                        {muted || volume === -60 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                      </button>
                      <input 
                        type="range" 
                        min="-60" max="0" 
                        value={volume} 
                        onChange={(e) => handleVolumeChange(parseInt(e.target.value))}
                        className="w-20 accent-emerald-500"
                      />
                    </div>

                    <div className="flex items-center gap-6">
                      <button 
                        onClick={() => {
                          handleSeek({ target: { value: '0' } } as any);
                          if (!playing) togglePlay();
                        }}
                        className="p-3 text-white/60 hover:text-white transition-colors"
                      >
                        <RotateCcw size={24} />
                      </button>
                      <button 
                        onClick={togglePlay}
                        className="w-16 h-16 bg-emerald-500 text-white rounded-full flex items-center justify-center shadow-lg shadow-emerald-500/20 hover:scale-105 transition-all active:scale-95"
                      >
                        {playing ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" className="ml-1" />}
                      </button>
                    </div>
                  </div>

                </div>
              </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>

      {/* Request Modal */}
      <AnimatePresence>
        {showRequestModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setShowRequestModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#121212] border border-white/10 w-full max-w-md rounded-[2rem] p-8 relative z-10 shadow-2xl"
            >
              <button onClick={() => setShowRequestModal(false)} className="absolute right-6 top-6 text-white/20 hover:text-white transition-colors">
                <X size={24} />
              </button>
              <h3 className="text-2xl font-semibold mb-2">Solicitar Música</h3>
              <p className="text-white/40 text-sm mb-6">Cole o link do YouTube para que o administrador adicione ao repertório.</p>
              
              <form onSubmit={handleSendRequest} className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-white/30 uppercase tracking-widest mb-2 block">Link do YouTube</label>
                  <input 
                    type="url" 
                    required
                    value={requestUrl}
                    onChange={(e) => setRequestUrl(e.target.value)}
                    placeholder="https://youtube.com/..."
                    className="w-full bg-white/5 border-none rounded-xl py-3 px-4 text-white focus:ring-2 focus:ring-emerald-500/20"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-white/30 uppercase tracking-widest mb-2 block">Nome da Música (Opcional)</label>
                  <input 
                    type="text" 
                    value={requestTitle}
                    onChange={(e) => setRequestTitle(e.target.value)}
                    placeholder="Ex: Uma Vez - Morada"
                    className="w-full bg-white/5 border-none rounded-xl py-3 px-4 text-white focus:ring-2 focus:ring-emerald-500/20"
                  />
                </div>
                <button 
                  type="submit"
                  className="w-full bg-emerald-500 text-white py-4 rounded-xl font-semibold hover:bg-emerald-600 transition-all flex items-center justify-center gap-2"
                >
                  <Send size={18} />
                  Enviar Solicitação
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Add Song Modal (Admin) */}
      <AnimatePresence>
        {showAddModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setShowAddModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#121212] border border-white/10 w-full max-w-md rounded-[2rem] p-8 relative z-10 shadow-2xl"
            >
              <button onClick={() => setShowAddModal(false)} className="absolute right-6 top-6 text-white/20 hover:text-white transition-colors">
                <X size={24} />
              </button>
              <h3 className="text-2xl font-semibold mb-2">Adicionar ao Repertório</h3>
              <p className="text-white/40 text-sm mb-6">Escolha um arquivo MP3 do seu dispositivo ou use um link do YouTube.</p>
              
              <div className="flex gap-2 mb-6 bg-white/5 p-1 rounded-xl">
                <button 
                  type="button"
                  onClick={() => setAddMode('local')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${addMode === 'local' ? 'bg-[#2a2a2a] shadow-sm text-white' : 'text-white/40 hover:text-white/60'}`}
                >
                  Arquivo Local
                </button>
                <button 
                  type="button"
                  onClick={() => setAddMode('youtube')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${addMode === 'youtube' ? 'bg-[#2a2a2a] shadow-sm text-white' : 'text-white/40 hover:text-white/60'}`}
                >
                  Link do YouTube
                </button>
              </div>

              {error && (
                <div className="mb-6 p-4 bg-red-500/10 text-red-400 rounded-xl text-sm border border-red-500/20 flex items-start gap-2">
                  <Info size={16} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleAddSong} className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-white/30 uppercase tracking-widest mb-2 block">Título</label>
                  <input 
                    type="text" 
                    required
                    value={newSongTitle}
                    onChange={(e) => setNewSongTitle(e.target.value)}
                    placeholder="Nome da música"
                    className="w-full bg-white/5 border-none rounded-xl py-3 px-4 text-white focus:ring-2 focus:ring-emerald-500/20"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-white/30 uppercase tracking-widest mb-2 block">Ministério/Autor</label>
                  <input 
                    type="text" 
                    required
                    value={newSongAuthor}
                    onChange={(e) => setNewSongAuthor(e.target.value)}
                    placeholder="Ex: Morada, Fernandinho..."
                    className="w-full bg-white/5 border-none rounded-xl py-3 px-4 text-white focus:ring-2 focus:ring-emerald-500/20"
                  />
                </div>
                
                {addMode === 'local' ? (
                  <div>
                    <label className="text-xs font-bold text-white/30 uppercase tracking-widest mb-2 block">Arquivo MP3</label>
                    <input 
                      type="file" 
                      required
                      accept="audio/mpeg"
                      onChange={(e) => setNewSongFile(e.target.files?.[0] || null)}
                      className="w-full text-sm text-white/40 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-emerald-500/10 file:text-emerald-400 hover:file:bg-emerald-500/20"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="text-xs font-bold text-white/30 uppercase tracking-widest mb-2 block">Link do YouTube</label>
                    <input 
                      type="url" 
                      required
                      value={newSongYoutubeUrl}
                      onChange={(e) => setNewSongYoutubeUrl(e.target.value)}
                      placeholder="https://youtube.com/watch?v=..."
                      className="w-full bg-white/5 border-none rounded-xl py-3 px-4 text-white focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                )}
                
                <button 
                  type="submit"
                  disabled={loading}
                  className="w-full bg-emerald-500 text-white py-4 rounded-xl font-semibold hover:bg-emerald-600 disabled:opacity-70 disabled:cursor-wait transition-all flex flex-col items-center justify-center gap-1 relative overflow-hidden"
                >
                  {loading && (
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: addMode === 'youtube' ? '100%' : `${uploadProgress}%` }}
                      transition={{ duration: addMode === 'youtube' ? 15 : 0.3 }}
                      className="absolute inset-0 bg-emerald-600/50"
                    />
                  )}
                  <div className="flex items-center gap-2 relative z-10">
                    {loading ? <Loader2 className="animate-spin" size={18} /> : <Plus size={18} />}
                    <span>{loading ? (addMode === 'youtube' ? 'Processando áudio...' : 'Subindo arquivo...') : 'Adicionar Música'}</span>
                  </div>
                  {loading && addMode === 'local' && (
                    <span className="text-[10px] opacity-80 relative z-10">
                      {Math.round(uploadProgress)}% concluído
                    </span>
                  )}
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-6 py-12 border-t border-white/5 mt-12 flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="text-white/40 text-sm">
          © {new Date().getFullYear()} LouvorKey — Repertório do Ministério de Louvor
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-xs font-medium text-white/30">
            <CheckCircle2 size={14} className="text-emerald-500" />
            Servidor Online
          </div>
          <div className="flex items-center gap-2 text-xs font-medium text-white/30">
            <Clock size={14} />
            {songs.length} Músicas no Repertório
          </div>
        </div>
      </footer>
    </div>
  );
}
