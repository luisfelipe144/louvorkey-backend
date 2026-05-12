import React, { useState, useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { 
  View, Text, ScrollView, TouchableOpacity, Image, 
  TextInput, Modal, ActivityIndicator, Alert, Platform 
} from 'react-native';
import { 
  Music, Search, Youtube, Plus, X, Play, Pause, 
  RotateCcw, ChevronUp, ChevronDown, Clock, Download, UploadCloud, FileAudio,
  Volume2, VolumeX, Trash2
} from 'lucide-react-native';
import Slider from '@react-native-community/slider';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Audio } from 'expo-av';
import { db } from './firebase';
import { collection, onSnapshot, query, orderBy, addDoc, updateDoc, doc, serverTimestamp, deleteDoc } from 'firebase/firestore';
import './global.css';

// URL de Produção na Nuvem (Render)
const API_URL = 'https://louvorkey-backend.onrender.com'; 

export default function App() {
  const [songs, setSongs] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSong, setSelectedSong] = useState<any>(null);
  
  // Add Song Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<'local' | 'youtube'>('local');
  const [newTitle, setNewTitle] = useState('');
  const [newAuthor, setNewAuthor] = useState('');
  const [newFile, setNewFile] = useState<any>(null);
  const [newYoutubeUrl, setNewYoutubeUrl] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  // Audio Engine States
  const soundsRef = useRef<{ [key: string]: Audio.Sound }>({});
  // URLs originais da música atual (sem pitch shift) — usadas como base para gerar versões pitched
  const originalUrlsRef = useRef<{ master?: string; stems?: { [key: string]: string } }>({});
  // Cancela requests de pitch antigas quando o usuário muda rápido
  const pitchAbortRef = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [isSeparating, setIsSeparating] = useState(false);
  const [separateStartedAt, setSeparateStartedAt] = useState<number | null>(null);
  const [separateElapsed, setSeparateElapsed] = useState(0);
  const [isPitchLoading, setIsPitchLoading] = useState(false);
  const [showPitchPicker, setShowPitchPicker] = useState(false);
  const [showKeyOverride, setShowKeyOverride] = useState(false);

  // Mixer States
  const [volumes, setVolumes] = useState<{[key: string]: number}>({
    vocals: 80, drums: 80, bass: 80, guitar: 80, piano: 80, other: 80, master: 100
  });
  const [mutes, setMutes] = useState<{[key: string]: boolean}>({
    vocals: false, drums: false, bass: false, guitar: false, piano: false, other: false, master: false
  });
  const [pitch, setPitch] = useState(0);

  // Tick a cada 1s enquanto está separando — mostra timer decorrido
  useEffect(() => {
    if (!separateStartedAt) return;
    const id = setInterval(() => setSeparateElapsed(Date.now() - separateStartedAt), 1000);
    return () => clearInterval(id);
  }, [separateStartedAt]);

  // 1. Iniciar Firebase e carregar músicas
  useEffect(() => {
    const q = query(collection(db, 'songs'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snapshot) => {
      setSongs(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    }, (err) => console.log('Erro Firebase:', err));
    return () => unsub();
  }, []);

  // 2. Limpar áudio ao sair
  useEffect(() => {
    return () => { unloadAllSounds(); };
  }, []);

  const unloadAllSounds = async () => {
    const sounds = Object.values(soundsRef.current);
    for (const sound of sounds) {
      await sound.unloadAsync();
    }
    soundsRef.current = {};
    setPlaying(false);
    setPosition(0);
  };

  // 3. Selecionar Música e Carregar Motor de Áudio
  const handleSelectSong = async (song: any) => {
    setSelectedSong(song);
    setPitch(0); // Sempre começa em C ao trocar música
    await unloadAllSounds();

    // Guarda URLs originais — é a partir delas que geramos versões em outros tons
    if (song.stems) {
      originalUrlsRef.current = { stems: { ...song.stems } };
    } else {
      originalUrlsRef.current = { master: song.audioUrl };
    }

    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
      });

      await loadSoundsFromUrls(originalUrlsRef.current);
    } catch (e) {
      Alert.alert("Erro", "Falha ao carregar áudio");
      console.error(e);
    }
  };

  // Carrega Audio.Sound a partir de URLs (ou originais ou pitched).
  // Não toca em originalUrlsRef — só hidrata o soundsRef.
  const loadSoundsFromUrls = async (urls: { master?: string; stems?: { [key: string]: string } }) => {
    if (urls.stems) {
      const stemKeys = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
      let trackerKey: string | null = null;
      for (const key of stemKeys) {
        let url = urls.stems[key];
        if (!url) continue;
        if (url.startsWith('/uploads')) url = `${API_URL}${url}`;

        const { sound } = await Audio.Sound.createAsync({ uri: url });
        soundsRef.current[key] = sound;
        await sound.setVolumeAsync(mutes[key] ? 0 : (volumes[key] / 100));

        if (!trackerKey) {
          trackerKey = key;
          sound.setOnPlaybackStatusUpdate((status: any) => {
            if (status.isLoaded) {
              setPosition(status.positionMillis);
              setDuration(status.durationMillis || 0);
              if (status.didJustFinish) setPlaying(false);
            }
          });
        }
      }
    } else if (urls.master) {
      let url = urls.master;
      if (url.startsWith('/uploads')) url = `${API_URL}${url}`;

      const { sound } = await Audio.Sound.createAsync({ uri: url });
      soundsRef.current['master'] = sound;
      await sound.setVolumeAsync(mutes.master ? 0 : (volumes.master / 100));
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.isLoaded) {
          setPosition(status.positionMillis);
          setDuration(status.durationMillis || 0);
          if (status.didJustFinish) setPlaying(false);
        }
      });
    }
  };

  // Aplica pitch shift: chama /api/pitch pra cada URL original e recarrega o player.
  // Preserva posição e estado de play. Cancela request anterior se usuário mudar rápido.
  const applyPitch = async (semitones: number) => {
    pitchAbortRef.current?.abort();
    const controller = new AbortController();
    pitchAbortRef.current = controller;

    setIsPitchLoading(true);

    const wasPlaying = playing;
    const savedPosition = position;

    try {
      // Pausa antes de descarregar
      const currentSounds = Object.values(soundsRef.current);
      if (wasPlaying) {
        await Promise.all(currentSounds.map(s => s.pauseAsync().catch(() => {})));
      }

      const orig = originalUrlsRef.current;
      const pitchOne = async (url: string): Promise<string> => {
        const res = await fetch(`${API_URL}/api/pitch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioUrl: url, semitones }),
          signal: controller.signal,
        });
        const body = await res.text();
        if (!res.ok) {
          let detail = body;
          try { detail = JSON.parse(body).details || JSON.parse(body).error || body; } catch {}
          throw new Error(`Pitch (HTTP ${res.status}): ${detail}`);
        }
        return JSON.parse(body).url;
      };

      let newUrls: { master?: string; stems?: { [key: string]: string } };
      if (orig.stems) {
        const entries = await Promise.all(
          Object.entries(orig.stems).map(async ([k, u]) => [k, await pitchOne(u as string)] as const)
        );
        if (controller.signal.aborted) return;
        newUrls = { stems: Object.fromEntries(entries) };
      } else if (orig.master) {
        const url = await pitchOne(orig.master);
        if (controller.signal.aborted) return;
        newUrls = { master: url };
      } else {
        return;
      }

      await unloadAllSounds();
      await loadSoundsFromUrls(newUrls);

      const newSounds = Object.values(soundsRef.current);
      await Promise.all(newSounds.map(s => s.setPositionAsync(savedPosition).catch(() => {})));

      if (wasPlaying) {
        await Promise.all(newSounds.map(s => s.playAsync().catch(() => {})));
        setPlaying(true);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.error('Pitch error:', e);
        Alert.alert("Erro no Tom", e.message || String(e));
      }
    } finally {
      if (pitchAbortRef.current === controller) {
        setIsPitchLoading(false);
      }
    }
  };

  const selectPitch = (semitones: number) => {
    const next = Math.max(-12, Math.min(12, semitones));
    setShowPitchPicker(false);
    if (next === pitch) return;
    setPitch(next);
    applyPitch(next);
  };

  // Permite ao usuário corrigir manualmente o tom original detectado pela IA.
  const overrideOriginalKey = async (newKey: string) => {
    if (!selectedSong) return;
    setShowKeyOverride(false);
    try {
      await updateDoc(doc(db, 'songs', selectedSong.id), { originalKey: newKey });
      setSelectedSong({ ...selectedSong, originalKey: newKey });
    } catch (e: any) {
      Alert.alert("Erro", "Não foi possível salvar o tom: " + e.message);
    }
  };

  // Converte semitons em nota musical, usando o tom original detectado como base.
  // Ex: original 'G' + 2 semitons = 'A'. Original 'Ab' + 1 = 'A'.
  const SHARP_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_TO_SHARP: { [k: string]: string } = {
    'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'
  };
  const normalizeKey = (key: string | null | undefined): string => {
    if (!key) return 'C';
    const k = key.trim();
    return FLAT_TO_SHARP[k] || k;
  };
  const semitonesToNote = (semitones: number, originalKey?: string | null) => {
    const base = normalizeKey(originalKey);
    const startIdx = SHARP_NOTES.indexOf(base);
    const safeStart = startIdx === -1 ? 0 : startIdx;
    const idx = ((safeStart + semitones) % 12 + 12) % 12;
    return SHARP_NOTES[idx];
  };

  const togglePlay = async () => {
    const sounds = Object.values(soundsRef.current);
    if (sounds.length === 0) return;

    if (playing) {
      await Promise.all(sounds.map(s => s.pauseAsync()));
      setPlaying(false);
    } else {
      await Promise.all(sounds.map(s => s.playAsync()));
      setPlaying(true);
    }
  };

  const handleSeek = async (value: number) => {
    const sounds = Object.values(soundsRef.current);
    await Promise.all(sounds.map(s => s.setPositionAsync(value)));
  };

  const changeVolume = async (key: string, val: number) => {
    setVolumes(prev => ({ ...prev, [key]: val }));
    const sound = soundsRef.current[key];
    if (sound && !mutes[key]) {
      await sound.setVolumeAsync(val / 100);
    }
  };

  const toggleMute = async (key: string) => {
    const isMuted = !mutes[key];
    setMutes(prev => ({ ...prev, [key]: isMuted }));
    const sound = soundsRef.current[key];
    if (sound) {
      await sound.setVolumeAsync(isMuted ? 0 : volumes[key] / 100);
    }
  };

  // 4. Inteligência Artificial: Separar Stems
  const handleSeparateStems = async () => {
    if (!selectedSong) return;
    setIsSeparating(true);
    setSeparateStartedAt(Date.now());
    setSeparateElapsed(0);
    try {
      const res = await fetch(`${API_URL}/api/separate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: selectedSong.audioUrl })
      });
      const body = await res.text();
      if (!res.ok) {
        let detail = body;
        try {
          const parsed = JSON.parse(body);
          detail = parsed.details || parsed.error || body;
        } catch {}
        throw new Error(`Separação falhou (HTTP ${res.status}): ${detail}`);
      }

      const data = JSON.parse(body);
      await updateDoc(doc(db, 'songs', selectedSong.id), { stems: data.stems });
      setSelectedSong({ ...selectedSong, stems: data.stems });
      Alert.alert("Sucesso", "Faixas separadas!");
      await handleSelectSong({ ...selectedSong, stems: data.stems }); // Recarrega com stems
    } catch (e: any) {
      Alert.alert("Erro", e.message);
    } finally {
      setIsSeparating(false);
      setSeparateStartedAt(null);
    }
  };

  // 5. Adicionar Nova Música
  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*' });
      if (!result.canceled) setNewFile(result.assets[0]);
    } catch (err) { }
  };

  const handleAddSong = async () => {
    if (!newTitle || !newAuthor) return Alert.alert("Erro", "Preencha todos os campos");
    setIsAdding(true);
    
    try {
      let downloadUrl = '';
      let originalKey: string | null = null;
      if (addMode === 'youtube') {
        if (!newYoutubeUrl) throw new Error("Cole o link do YouTube");
        const res = await fetch(`${API_URL}/api/youtube`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: newYoutubeUrl })
        });
        const rawBody = await res.text();
        if (!res.ok) {
          let detail = rawBody;
          try {
            const parsed = JSON.parse(rawBody);
            detail = parsed.details || parsed.error || rawBody;
          } catch {}
          throw new Error(`YouTube falhou (HTTP ${res.status}): ${detail}`);
        }
        const ytData = JSON.parse(rawBody);
        downloadUrl = ytData.url;
        originalKey = ytData.originalKey ?? null;
      } else {
        if (!newFile) throw new Error("Selecione um arquivo");
        const res = await FileSystem.uploadAsync(`${API_URL}/api/upload`, newFile.uri, {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          mimeType: newFile.mimeType || 'audio/mpeg',
        });

        if (res.status !== 200) {
          let detail = res.body;
          try {
            const parsed = JSON.parse(res.body);
            detail = parsed.error || parsed.details || res.body;
          } catch {}
          throw new Error(`Upload falhou (HTTP ${res.status}): ${detail?.slice?.(0, 300) || detail}`);
        }
        const data = JSON.parse(res.body);
        if (!data.url) throw new Error("Servidor não retornou URL do arquivo");
        downloadUrl = data.url;
        originalKey = data.originalKey ?? null;
      }

      await addDoc(collection(db, 'songs'), {
        title: newTitle, author: newAuthor, audioUrl: downloadUrl,
        originalKey, // tom detectado pelo essentia (pode ser null se falhou)
        thumbnail: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400&h=400&fit=crop',
        createdAt: serverTimestamp()
      });
      
      setShowAddModal(false);
      setNewTitle(''); setNewAuthor(''); setNewFile(null); setNewYoutubeUrl('');
      Alert.alert("Sucesso", "Música adicionada!");
    } catch (e: any) {
      Alert.alert("Erro", e.message);
    } finally {
      setIsAdding(false);
    }
  };

  const handleDownload = async () => {
    if (!selectedSong) return;
    try {
      Alert.alert("Exportando...", "Baixando o arquivo de áudio para o seu dispositivo.");
      const fileUri = FileSystem.documentDirectory + `${selectedSong.title.replace(/[^a-z0-9]/gi, '_')}.mp3`;
      
      let url = selectedSong.audioUrl;
      if (url?.startsWith('/uploads')) url = `${API_URL}${url}`;
      const downloadRes = await FileSystem.downloadAsync(url, fileUri);
      
      if (downloadRes.status === 200) {
        Alert.alert("Sucesso", "Download concluído! Escolha onde salvar.");
        await Sharing.shareAsync(downloadRes.uri);
      } else {
        throw new Error("Falha no download");
      }
    } catch (e: any) {
      Alert.alert("Erro", "Não foi possível baixar o áudio: " + e.message);
    }
  };

  const handleDeleteSong = () => {
    if (!selectedSong) return;
    Alert.alert(
      "Apagar Música",
      "Tem certeza que deseja remover esta música do repertório?",
      [
        { text: "Cancelar", style: "cancel" },
        { 
          text: "Apagar", 
          style: "destructive",
          onPress: async () => {
            try {
              await deleteDoc(doc(db, 'songs', selectedSong.id));
              setSelectedSong(null);
            } catch (e: any) {
              Alert.alert("Erro", "Não foi possível apagar: " + e.message);
            }
          }
        }
      ]
    );
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const filteredSongs = songs.filter(s => 
    s.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.author.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <View className="flex-1 bg-[#0a0a0a]">
      {/* HEADER */}
      <View className="px-6 pt-16 pb-4 border-b border-white/5 bg-[#0a0a0a]/90 flex-row items-center justify-between z-10">
        <View className="flex-row items-center gap-3">
          <View className="w-10 h-10 bg-emerald-500 rounded-xl items-center justify-center">
            <Music color="white" size={20} />
          </View>
          <Text className="text-white text-2xl font-semibold tracking-tight">LouvorKey</Text>
        </View>
        <TouchableOpacity onPress={() => setShowAddModal(true)} className="bg-emerald-500/20 p-2.5 rounded-full">
          <Plus color="#34d399" size={20} />
        </TouchableOpacity>
      </View>

      {/* REPERTÓRIO LIST */}
      <ScrollView className="flex-1 px-6 pt-6" contentContainerStyle={{ paddingBottom: 100 }}>
        <Text className="text-white text-3xl font-medium mb-1">Repertório</Text>
        <Text className="text-white/40 mb-6">Selecione para ensaiar</Text>

        <View className="relative mb-8">
          <View className="absolute left-4 top-3.5 z-10"><Search color="rgba(255,255,255,0.3)" size={20} /></View>
          <TextInput 
            value={searchTerm} onChangeText={setSearchTerm}
            placeholder="Buscar no repertório..." placeholderTextColor="rgba(255,255,255,0.3)"
            className="w-full bg-white/5 border border-white/10 rounded-2xl py-3.5 pl-12 pr-4 text-white text-base"
          />
        </View>

        <View className="flex-row flex-wrap justify-between">
          {filteredSongs.map((song) => (
            <TouchableOpacity 
              key={song.id} onPress={() => handleSelectSong(song)}
              className="w-[48%] bg-white/5 rounded-3xl p-3 border border-white/5 mb-4"
            >
              <Image source={{ uri: song.thumbnail }} className="w-full aspect-square rounded-2xl mb-3" />
              <Text className="text-white font-medium text-base mb-0.5" numberOfLines={1}>{song.title}</Text>
              <Text className="text-white/40 text-xs" numberOfLines={1}>{song.author}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {/* STUDIO PLAYER MODAL */}
      <Modal visible={!!selectedSong} animationType="slide" presentationStyle="pageSheet">
        <View className="flex-1 bg-[#121212] pt-8">
          <View className="flex-row items-center justify-between px-6 pb-4 border-b border-white/5">
            <Text className="text-white font-semibold text-lg">Studio Player</Text>
            <View className="flex-row gap-4">
              <TouchableOpacity onPress={handleDeleteSong} className="bg-red-500/10 p-2 rounded-full">
                <Trash2 color="#ef4444" size={24} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSelectedSong(null)} className="bg-white/5 p-2 rounded-full">
                <X color="white" size={24} opacity={0.6} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView className="flex-1 px-6 pt-6" contentContainerStyle={{ paddingBottom: 40 }}>
            <View className="items-center mb-6">
              <Image source={{ uri: selectedSong?.thumbnail }} className="w-48 h-48 rounded-3xl mb-4 border border-white/10" />
              <Text className="text-white text-2xl font-bold text-center mb-1">{selectedSong?.title}</Text>
              <Text className="text-emerald-400 text-base">{selectedSong?.author}</Text>
            </View>

            {/* PLAYER CONTROLS */}
            <View className="mb-8">
              <View className="flex-row justify-between mb-2">
                <Text className="text-white/40 font-mono text-xs">{formatTime(position)}</Text>
                <Text className="text-white/40 font-mono text-xs">{formatTime(duration)}</Text>
              </View>
              <Slider
                minimumValue={0} maximumValue={duration || 1} value={position}
                onSlidingComplete={handleSeek}
                minimumTrackTintColor="#10b981" maximumTrackTintColor="rgba(255,255,255,0.1)"
                thumbTintColor="#10b981"
              />
              <View className="flex-row items-center justify-center gap-8 mt-4">
                <TouchableOpacity onPress={() => handleSeek(0)} className="p-3 bg-white/5 rounded-full"><RotateCcw color="white" size={20} opacity={0.6} /></TouchableOpacity>
                <TouchableOpacity onPress={togglePlay} className="w-16 h-16 bg-emerald-500 rounded-full items-center justify-center">
                  {playing ? <Pause color="white" size={28} /> : <Play color="white" size={28} style={{ marginLeft: 4 }}/>}
                </TouchableOpacity>
                <TouchableOpacity onPress={handleDownload} className="p-3 bg-white/5 rounded-full"><Download color="white" size={20} opacity={0.6} /></TouchableOpacity>
              </View>
            </View>

            {/* PITCH CONTROL */}
            <TouchableOpacity
              onPress={() => !isPitchLoading && setShowPitchPicker(true)}
              disabled={isPitchLoading}
              className="bg-white/5 p-5 rounded-3xl mb-6 border border-white/5 flex-row items-center justify-between"
            >
              <View className="flex-1">
                <Text className="text-white font-medium">Tom</Text>
                <Text className="text-white/40 text-xs">
                  {isPitchLoading
                    ? 'Aplicando tom... (10-15s)'
                    : selectedSong?.originalKey
                      ? `Original: ${normalizeKey(selectedSong.originalKey)} — toque para mudar`
                      : 'Tom original não detectado — toque para escolher'}
                </Text>
              </View>
              {isPitchLoading
                ? <ActivityIndicator color="#34d399" />
                : <View className="bg-emerald-500/20 px-4 py-2 rounded-lg min-w-[60px] items-center">
                    <Text className="text-emerald-400 font-bold text-lg">{semitonesToNote(pitch, selectedSong?.originalKey)}</Text>
                  </View>
              }
            </TouchableOpacity>

            {/* MIXER */}
            {!selectedSong?.stems ? (
              <TouchableOpacity
                onPress={handleSeparateStems} disabled={isSeparating}
                className="bg-emerald-500/10 border border-emerald-500/20 p-5 rounded-3xl items-center justify-center"
              >
                {isSeparating ? (
                  <View className="items-center gap-2">
                    <View className="flex-row items-center gap-3">
                      <ActivityIndicator color="#34d399" />
                      <Text className="text-emerald-400 font-semibold">
                        Separando faixas com IA...
                      </Text>
                    </View>
                    <Text className="text-white/50 text-xs">
                      {formatTime(separateElapsed)} decorridos · espera entre 2-4 min
                    </Text>
                    <Text className="text-white/30 text-[10px]">
                      Não feche o app · Demucs rodando em GPU
                    </Text>
                  </View>
                ) : (
                  <View className="flex-row items-center gap-3">
                    <Music color="#34d399" size={20} />
                    <Text className="text-emerald-400 font-semibold">Separar 6 Faixas com IA</Text>
                  </View>
                )}
              </TouchableOpacity>
            ) : (
              <View className="bg-black/40 border border-white/5 rounded-3xl p-5 mb-8">
                <Text className="text-white font-medium mb-5">Mixer de 6 Faixas</Text>
                {[
                  { id: 'vocals', label: 'Voz' }, { id: 'drums', label: 'Bateria' }, 
                  { id: 'bass', label: 'Baixo' }, { id: 'guitar', label: 'Guitarra' }, 
                  { id: 'piano', label: 'Teclado' }, { id: 'other', label: 'Metrônomo' }
                ].map((stem) => (
                  <View key={stem.id} className="flex-row items-center gap-4 bg-white/5 p-3 rounded-2xl mb-3">
                    <TouchableOpacity 
                      onPress={() => toggleMute(stem.id)}
                      className={`w-10 h-10 rounded-xl items-center justify-center ${mutes[stem.id] ? 'bg-red-500/20' : 'bg-emerald-500/20'}`}
                    >
                      {mutes[stem.id] ? <VolumeX color="#ef4444" size={18} /> : (stem.id === 'other' ? <Clock color="#34d399" size={18} /> : <Music color="#34d399" size={18} />)}
                    </TouchableOpacity>
                    <View className="flex-1">
                      <View className="flex-row justify-between mb-1">
                        <Text className="text-white/80 text-sm font-medium">{stem.label}</Text>
                        <Text className="text-emerald-400 text-xs font-bold">{volumes[stem.id]}%</Text>
                      </View>
                      <Slider
                        minimumValue={0} maximumValue={100} value={volumes[stem.id]}
                        onValueChange={(val) => changeVolume(stem.id, val)}
                        minimumTrackTintColor="#10b981" maximumTrackTintColor="rgba(255,255,255,0.1)"
                        thumbTintColor="#10b981" style={{ width: '100%', height: 20 }}
                      />
                    </View>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* PITCH PICKER MODAL */}
      <Modal visible={showPitchPicker} animationType="fade" transparent onRequestClose={() => setShowPitchPicker(false)}>
        <View className="flex-1 bg-black/80 justify-center items-center p-6">
          <View className="bg-[#121212] w-full max-w-sm rounded-3xl p-6 border border-white/10">
            <View className="flex-row justify-between items-center mb-2">
              <Text className="text-white font-semibold text-xl">Escolha o tom</Text>
              <TouchableOpacity onPress={() => setShowPitchPicker(false)}>
                <X color="white" size={24} opacity={0.5}/>
              </TouchableOpacity>
            </View>
            <Text className="text-white/40 text-xs mb-3">
              Tom original detectado: <Text className="text-emerald-400 font-bold">{selectedSong?.originalKey ? normalizeKey(selectedSong.originalKey) : '?'}</Text>
              {selectedSong?.originalKey && (
                <Text className="text-white/30"> — toque longo no botão verde pra corrigir</Text>
              )}
            </Text>
            <Text className="text-white/40 text-xs mb-5">
              Tons já gerados antes tocam instantâneo. Tons novos levam ~10-15s pra processar.
            </Text>

            <View className="flex-row flex-wrap justify-center gap-2">
              {Array.from({ length: 13 }, (_, i) => i - 6).map((semitones) => {
                const isCurrent = semitones === pitch;
                const note = semitonesToNote(semitones, selectedSong?.originalKey);
                const shiftLabel = semitones === 0 ? 'original' : (semitones > 0 ? `+${semitones}` : `${semitones}`);
                return (
                  <TouchableOpacity
                    key={semitones}
                    onPress={() => selectPitch(semitones)}
                    onLongPress={() => semitones === 0 && setShowKeyOverride(true)}
                    delayLongPress={400}
                    className={`w-[68px] h-16 rounded-2xl items-center justify-center border ${
                      isCurrent
                        ? 'bg-emerald-500 border-emerald-400'
                        : 'bg-white/5 border-white/10'
                    }`}
                  >
                    <Text className={`font-bold text-xl ${isCurrent ? 'text-white' : 'text-white/90'}`}>
                      {note}
                    </Text>
                    <Text className={`text-[10px] ${isCurrent ? 'text-white/80' : 'text-white/40'}`}>
                      {shiftLabel}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>

      {/* CORRIGIR TOM ORIGINAL MODAL */}
      <Modal visible={showKeyOverride} animationType="fade" transparent onRequestClose={() => setShowKeyOverride(false)}>
        <View className="flex-1 bg-black/80 justify-center items-center p-6">
          <View className="bg-[#121212] w-full max-w-sm rounded-3xl p-6 border border-white/10">
            <View className="flex-row justify-between items-center mb-2">
              <Text className="text-white font-semibold text-xl">Corrigir tom original</Text>
              <TouchableOpacity onPress={() => setShowKeyOverride(false)}>
                <X color="white" size={24} opacity={0.5}/>
              </TouchableOpacity>
            </View>
            <Text className="text-white/40 text-xs mb-5">
              A detecção automática está errada? Selecione o tom real abaixo. Vai ser salvo pra essa música.
            </Text>

            <View className="flex-row flex-wrap justify-center gap-2">
              {SHARP_NOTES.map((note) => {
                const isCurrent = normalizeKey(selectedSong?.originalKey) === note;
                return (
                  <TouchableOpacity
                    key={note}
                    onPress={() => overrideOriginalKey(note)}
                    className={`w-16 h-14 rounded-2xl items-center justify-center border ${
                      isCurrent ? 'bg-emerald-500 border-emerald-400' : 'bg-white/5 border-white/10'
                    }`}
                  >
                    <Text className={`font-bold text-lg ${isCurrent ? 'text-white' : 'text-white/90'}`}>
                      {note}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>

      {/* ADD MUSIC MODAL */}
      <Modal visible={showAddModal} animationType="fade" transparent>
        <View className="flex-1 bg-black/80 justify-center items-center p-6">
          <View className="bg-[#121212] w-full max-w-sm rounded-3xl p-6 border border-white/10">
            <View className="flex-row justify-between items-center mb-6">
              <Text className="text-white font-semibold text-xl">Nova Música</Text>
              <TouchableOpacity onPress={() => setShowAddModal(false)}><X color="white" size={24} opacity={0.5}/></TouchableOpacity>
            </View>

            <View className="flex-row bg-white/5 p-1 rounded-xl mb-6">
              <TouchableOpacity onPress={() => setAddMode('local')} className={`flex-1 py-2 rounded-lg items-center ${addMode === 'local' ? 'bg-white/10' : ''}`}>
                <Text className="text-white font-medium text-sm">Arquivo</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setAddMode('youtube')} className={`flex-1 py-2 rounded-lg items-center ${addMode === 'youtube' ? 'bg-white/10' : ''}`}>
                <Text className="text-white font-medium text-sm">YouTube</Text>
              </TouchableOpacity>
            </View>

            <TextInput value={newTitle} onChangeText={setNewTitle} placeholder="Título da música" placeholderTextColor="rgba(255,255,255,0.3)" className="bg-white/5 border border-white/10 rounded-xl p-4 text-white mb-3" />
            <TextInput value={newAuthor} onChangeText={setNewAuthor} placeholder="Autor / Banda" placeholderTextColor="rgba(255,255,255,0.3)" className="bg-white/5 border border-white/10 rounded-xl p-4 text-white mb-4" />

            {addMode === 'youtube' ? (
              <TextInput value={newYoutubeUrl} onChangeText={setNewYoutubeUrl} placeholder="Link do YouTube" placeholderTextColor="rgba(255,255,255,0.3)" className="bg-white/5 border border-white/10 rounded-xl p-4 text-white mb-6" />
            ) : (
              <TouchableOpacity onPress={pickFile} className="bg-white/5 border border-white/10 border-dashed rounded-xl p-4 mb-6 items-center flex-row justify-center gap-2">
                <FileAudio color="rgba(255,255,255,0.4)" size={20} />
                <Text className="text-white/60">{newFile ? newFile.name : 'Selecionar Áudio (MP3/WAV)'}</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity onPress={handleAddSong} disabled={isAdding} className="bg-emerald-500 py-4 rounded-xl items-center">
              {isAdding ? <ActivityIndicator color="white" /> : <Text className="text-white font-semibold text-lg">Salvar Música</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <StatusBar style="light" />
    </View>
  );
}
