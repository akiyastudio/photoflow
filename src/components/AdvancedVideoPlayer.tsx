/* eslint-disable react-refresh/only-export-components -- directional input helpers are intentionally colocated with the player contract */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Camera, Captions, Gauge, Info, Loader2, Pause, Play, Plus, Settings2, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { VideoPlaybackBackendDescriptor, VideoPlayerState, VideoPlaybackSettings, VideoSubtitleTrack } from '../types';
import { useHostSurfaceState } from './LayerProvider';
import { readSubtitleMemory, resolveRememberedSubtitle, writeSubtitleMemory } from './video-subtitle-memory';
import { DEFAULT_SUBTITLE_FONT_SIZE, normalizeSubtitleFontSize } from '../features/app/video-player-settings';
import { discoverPlaybackBackends, startPlaybackSession } from '../platform/video-playback/playback-session';
import type { PlaybackSession } from '../platform/video-playback/playback-session';
import { DEFAULT_VIDEO_TRANSFORM, hdrModeAvailability, playbackCapabilityPresentation } from '../contracts/video-playback';
import type { VideoTransform } from '../contracts/video-playback';
import { bindingsForArrowMode, normalizeVideoShortcutBindings, resolveVideoShortcut, shortcutInputFromKeyboardEvent } from '../contracts/video-shortcuts';
import type { VideoActionId } from '../contracts/video-shortcuts';

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remaining = whole % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
};

const PLAYBACK_SPEEDS = [0.5, 1, 1.25, 1.5, 2, 3, 4];
const SKIP_SECONDS = 5;
const SUBTITLE_FONT_SIZE_PRESETS = [{ label: '小', value: 20 }, { label: '中', value: 30 }, { label: '大', value: 40 }] as const;
const DEFAULT_VIDEO_SETTINGS: VideoPlaybackSettings = { arrowKeyAction: 'seek', subtitlesEnabled: false, subtitlePreferredLanguages: ['zh', 'chi', 'zho'], subtitleSize: DEFAULT_SUBTITLE_FONT_SIZE, subtitleStyle: 'standard', hdrMode: 'auto', shortcuts: {} };
const createPlaybackToken = () => globalThis.crypto?.randomUUID?.() || `video_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

type VideoDirectionalInputGroup = 'arrows' | 'forward-back';
type VideoDirectionalAction = 'navigate' | 'seek';

const videoDirectionalAction = (arrowKeyAction: VideoPlaybackSettings['arrowKeyAction'], group: VideoDirectionalInputGroup): VideoDirectionalAction => {
  if (group === 'arrows') return arrowKeyAction === 'navigate' ? 'navigate' : 'seek';
  return arrowKeyAction === 'navigate' ? 'seek' : 'navigate';
};

const videoDirectionalKeyboardInput = (key: string): { direction: -1 | 1; group: VideoDirectionalInputGroup } | null => {
  if (key === 'ArrowLeft') return { direction: -1, group: 'arrows' };
  if (key === 'ArrowRight') return { direction: 1, group: 'arrows' };
  return null;
};

type VideoPlayerProps = {
  filePath: string;
  poster?: string;
  onError: (message: string) => void;
  onMetadata: (metadata: { width?: number; height?: number; duration?: number }) => void;
  onNavigate?: (direction: -1 | 1) => void;
  onContextMenuAt?: (x: number, y: number) => void;
  onPointerActivity?: () => void;
  topRightOverlayHole?: number;
  controlsVisible?: boolean;
  controlsOverlay?: boolean;
  onEscape?: () => void;
  onToggleFullscreen?: () => void;
  bottomControls?: ReactNode;
  editorSeekRequest?: { id: number; time: number; pause?: boolean };
  onPlaybackState?: (state: { time: number; duration: number; paused: boolean }) => void;
  keyboardSettings?: VideoPlaybackSettings;
};

const initialState = (): VideoPlayerState => ({
  sessionId: '',
  playerId: '',
  requestId: '',
  type: 'loading',
  paused: true,
  buffering: true,
  volume: 100,
  muted: false,
  speed: 1,
  time: 0,
  duration: 0,
});

const VideoPlayer = ({ filePath, poster, onError, onMetadata, onNavigate, onContextMenuAt, onPointerActivity, topRightOverlayHole = 0, controlsVisible = true, controlsOverlay = false, onEscape, onToggleFullscreen, bottomControls, editorSeekRequest, onPlaybackState, keyboardSettings = DEFAULT_VIDEO_SETTINGS }: VideoPlayerProps) => {
  const { suspended: hostSurfaceSuspended } = useHostSurfaceState();
  const navigate = onNavigate || (() => undefined);
  const showNavigation = Boolean(onNavigate);
  const playerRootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlPanelRef = useRef<HTMLDivElement>(null);
  const controlsOverlayRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const playerIdRef = useRef(createPlaybackToken());
  const requestIdRef = useRef('');
  const errorReportedRef = useRef(false);
  const metadataKeyRef = useRef('');
  const onErrorRef = useRef(onError);
  const onMetadataRef = useRef(onMetadata);
  const onNavigateRef = useRef(navigate);
  const onContextMenuAtRef = useRef(onContextMenuAt);
  const onPointerActivityRef = useRef(onPointerActivity);
  const onEscapeRef = useRef(onEscape);
  const onToggleFullscreenRef = useRef(onToggleFullscreen);
  const shortcutActionRef = useRef<(action: VideoActionId) => void>(() => undefined);
  const onPlaybackStateRef = useRef(onPlaybackState);
  const playbackPositionRef = useRef({ time: 0, duration: 0, paused: true });
  const nativeContextMenuOpenRef = useRef(false);
  onErrorRef.current = onError;
  onMetadataRef.current = onMetadata;
  onNavigateRef.current = navigate;
  onContextMenuAtRef.current = onContextMenuAt;
  onPointerActivityRef.current = onPointerActivity;
  onEscapeRef.current = onEscape;
  onToggleFullscreenRef.current = onToggleFullscreen;
  onPlaybackStateRef.current = onPlaybackState;
  const [sessionId, setSessionId] = useState('');
  const [starting, setStarting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureNotice, setCaptureNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [controlPanel, setControlPanel] = useState<'speed' | 'volume' | 'subtitles' | 'display' | 'info' | null>(null);
  const [videoTransform, setVideoTransform] = useState<VideoTransform>(DEFAULT_VIDEO_TRANSFORM);
  const [activeBackendId, setActiveBackendId] = useState('');
  const [availableBackends, setAvailableBackends] = useState<VideoPlaybackBackendDescriptor[]>([]);
  const [displayCapability, setDisplayCapability] = useState({ hdrAvailable: false, reason: '尚未检测当前显示器' });
  const [subtitleFontSize, setSubtitleFontSize] = useState(() => normalizeSubtitleFontSize(keyboardSettings.subtitleSize));
  const subtitleMemoryRestoredRef = useRef(false);
  const rememberAddedSubtitleRef = useRef(false);
  const [state, setState] = useState<VideoPlayerState>(initialState);
  const shortcutBindings = useMemo(() => bindingsForArrowMode(normalizeVideoShortcutBindings(keyboardSettings.shortcuts), keyboardSettings.arrowKeyAction), [keyboardSettings.arrowKeyAction, keyboardSettings.shortcuts]);

  useEffect(() => setSubtitleFontSize(normalizeSubtitleFontSize(keyboardSettings.subtitleSize)), [keyboardSettings.subtitleSize]);

  useEffect(() => {
    let active = true;
    const requestId = createPlaybackToken();
    requestIdRef.current = requestId;
    sessionRef.current = null;
    nativeContextMenuOpenRef.current = false;
    errorReportedRef.current = false;
    metadataKeyRef.current = '';
    setStarting(true);
    setSessionId('');
    setCapturing(false);
    setCaptureNotice(null);
    setControlPanel(null);
    setVideoTransform(DEFAULT_VIDEO_TRANSFORM);
    setActiveBackendId('');
    setAvailableBackends([]);
    subtitleMemoryRestoredRef.current = false;
    rememberAddedSubtitleRef.current = false;
    setState(initialState());
    const handleState = (update: VideoPlayerState) => {
      if (update.playerId !== playerIdRef.current || update.requestId !== requestIdRef.current) return;
      if (sessionRef.current) setActiveBackendId(sessionRef.current.backendId);
      if (update.type === 'input' && update.input) {
        const input = update.input;
        if (input.kind === 'pointer-move') onPointerActivityRef.current?.();
        else if (input.kind === 'pointer-button' && input.button === 'left') {
          shortcutActionRef.current('video.playPause');
        } else if (input.kind === 'pointer-button' && input.button === 'right') {
          if (!onContextMenuAtRef.current) return;
          const rect = surfaceRef.current?.getBoundingClientRect();
          if (rect) {
            nativeContextMenuOpenRef.current = true;
            sessionRef.current?.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
            onContextMenuAtRef.current(rect.left + Number(input.x || 0), rect.top + Number(input.y || 0));
          }
        } else if (input.kind === 'key') {
          const action = resolveVideoShortcut({ key: input.key || '', code: input.code || input.key || '', ctrl: input.ctrl === true, alt: input.alt === true, shift: input.shift === true, meta: input.meta === true, repeat: input.repeat === true }, shortcutBindings, { scope: showNavigation ? 'media' : 'video' });
          if (action) shortcutActionRef.current(action);
        }
        return;
      }
      if (update.type === 'navigate') {
        onNavigateRef.current(update.direction === -1 ? -1 : 1);
        return;
      }
      if (update.type === 'context-menu') {
        if (!onContextMenuAtRef.current) return;
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (rect) {
          nativeContextMenuOpenRef.current = true;
          sessionRef.current?.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
          onContextMenuAtRef.current(rect.left + Number(update.x || 0), rect.top + Number(update.y || 0));
        }
        return;
      }
      if (update.type === 'pointer-activity') {
        onPointerActivityRef.current?.();
        return;
      }
      if (update.type === 'escape') {
        onEscapeRef.current?.();
        return;
      }
      if (update.type === 'fatal' || update.type === 'error' || update.type === 'stopped') {
        if (!errorReportedRef.current) {
          errorReportedRef.current = true;
          onErrorRef.current(update.error || 'Chromium 与高级视频解码组件均无法播放此视频；请安装或修复高级解码组件，或使用系统播放器');
        }
        return;
      }
      if (update.type === 'subtitle-tracks') {
        setState(current => ({ ...current, ...update }));
      } else if (update.type === 'loading') setState(current => ({ ...current, ...update, buffering: true }));
      else if (update.type === 'file-loaded') {
        setStarting(false);
        setState(current => ({ ...current, ...update, buffering: false }));
      } else if (update.type === 'ended') setState(current => ({ ...current, ...update, paused: true, time: current.duration || current.time }));
      else {
        if (update.type === 'state' && update.buffering === false) setStarting(false);
        setState(current => ({ ...current, ...update }));
      }
    };
    const video = videoRef.current;
    if (!video) return undefined;
    void discoverPlaybackBackends({ filePath, video, electronApi: window.electronAPI }).then(backends => startPlaybackSession({
      backends,
      context: {
        filePath,
        settings: keyboardSettings,
        playerId: playerIdRef.current,
        requestId,
        video,
        electronApi: window.electronAPI,
        onState: handleState,
      },
    })).then(session => {
      if (!active || requestIdRef.current !== requestId) {
        void session.close();
        return;
      }
      sessionRef.current = session;
      setActiveBackendId(session.backendId);
      setAvailableBackends(session.availableBackends || []);
      setSessionId(requestId);
    }).catch(error => {
      if (active && !errorReportedRef.current) {
        errorReportedRef.current = true;
        onErrorRef.current(`视频无法播放：${error instanceof Error ? error.message : String(error)}。请安装或修复高级解码组件，或使用系统播放器。`);
      }
    });
    return () => {
      active = false;
      if (requestIdRef.current === requestId) requestIdRef.current = '';
      const currentSession = sessionRef.current;
      sessionRef.current = null;
      void currentSession?.close();
    };
  }, [filePath, keyboardSettings.arrowKeyAction, keyboardSettings.subtitlesEnabled, keyboardSettings.subtitlePreferredLanguages.join(','), keyboardSettings.subtitleSize, keyboardSettings.subtitleStyle, JSON.stringify(keyboardSettings.shortcuts)]);

  useEffect(() => {
    if (!sessionId || subtitleMemoryRestoredRef.current || !state.subtitleTracks?.length) return;
    subtitleMemoryRestoredRef.current = true;
    let memory;
    try { memory = readSubtitleMemory(localStorage, filePath); } catch { return; }
    const resolution = resolveRememberedSubtitle(memory, state.subtitleTracks);
    if (resolution.mode === 'default' || resolution.mode === 'missing') return;
    if (resolution.mode === 'off') {
      sessionRef.current?.control({ action: 'subtitle-select', value: '' });
      sessionRef.current?.control({ action: 'subtitle-delay', value: resolution.delay });
      return;
    }
    sessionRef.current?.control({ action: 'subtitle-select', value: resolution.track.id });
    sessionRef.current?.control({ action: 'subtitle-delay', value: resolution.delay });
    sessionRef.current?.control({ action: 'subtitle-visible', value: resolution.visible });
  }, [filePath, sessionId, state.subtitleTracks]);

  useEffect(() => {
    if (!rememberAddedSubtitleRef.current || !state.subtitleTracks?.length) return;
    const selected = state.subtitleTracks.find(track => track.id === String(state.subtitleTrackId ?? '') || track.selected);
    if (!selected) return;
    rememberAddedSubtitleRef.current = false;
    try { writeSubtitleMemory(localStorage, filePath, { selection: { mode: 'track', stableId: selected.stableId }, delay: Number(state.subtitleDelay) || 0, visible: state.subtitleVisible !== false, updatedAt: Date.now() }); } catch { /* storage can be unavailable */ }
  }, [filePath, state.subtitleDelay, state.subtitleTrackId, state.subtitleTracks, state.subtitleVisible]);

  useEffect(() => {
    if (!captureNotice) return;
    const timer = window.setTimeout(() => setCaptureNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [captureNotice]);

  useEffect(() => {
    if (!controlsVisible) setControlPanel(null);
  }, [controlsVisible]);

  useEffect(() => {
    if (!sessionRef.current) return;
    const descriptor = sessionRef.current.availableBackends?.find(item => item.backendId === sessionRef.current?.backendId);
    const level = descriptor?.features.statistics.levels.includes('detailed') ? 'detailed' : 'basic';
    sessionRef.current.control({ action: 'statistics-level', statisticsLevel: controlPanel === 'info' ? level : 'off' });
  }, [activeBackendId, controlPanel, sessionId]);

  useEffect(() => {
    if (controlPanel !== 'display') return;
    void window.electronAPI.getVideoDisplayCapabilities().then(result => {
      if (result.success) setDisplayCapability({ hdrAvailable: result.display.hdrAvailable, reason: result.display.reason });
    });
  }, [controlPanel]);

  const syncBounds = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface || !sessionRef.current) return;
    const rect = surface.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const panelRect = controlPanelRef.current?.getBoundingClientRect();
    const panelLeft = panelRect ? Math.max(rect.left, panelRect.left - 2) : 0;
    const panelTop = panelRect ? Math.max(rect.top, panelRect.top - 2) : 0;
    const panelRight = panelRect ? Math.min(rect.right, panelRect.right + 2) : 0;
    const panelBottom = panelRect ? Math.min(rect.bottom, panelRect.bottom + 2) : 0;
    const overlayHole = panelRect && panelRight > panelLeft && panelBottom > panelTop ? {
      x: Math.round((panelLeft - rect.left) * scale),
      y: Math.round((panelTop - rect.top) * scale),
      width: Math.round((panelRight - panelLeft) * scale),
      height: Math.round((panelBottom - panelTop) * scale),
    } : undefined;
    const controlsRect = controlsOverlay && controlsVisible ? controlsOverlayRef.current?.getBoundingClientRect() : undefined;
    const controlsLeft = controlsRect ? Math.max(rect.left, controlsRect.left) : 0;
    const controlsTop = controlsRect ? Math.max(rect.top, controlsRect.top) : 0;
    const controlsRight = controlsRect ? Math.min(rect.right, controlsRect.right) : 0;
    const controlsBottom = controlsRect ? Math.min(rect.bottom, controlsRect.bottom) : 0;
    const controlsOverlayHole = controlsRect && controlsRight > controlsLeft && controlsBottom > controlsTop ? {
      x: Math.round((controlsLeft - rect.left) * scale),
      y: Math.round((controlsTop - rect.top) * scale),
      width: Math.round((controlsRight - controlsLeft) * scale),
      height: Math.round((controlsBottom - controlsTop) * scale),
    } : undefined;
    const cornerSize = Math.max(0, Math.min(rect.width, rect.height, topRightOverlayHole));
    const cornerInset = Math.min(10, Math.max(0, (Math.min(rect.width, rect.height) - cornerSize) / 2));
    const cornerOverlayHole = cornerSize > 0 ? {
      x: Math.round((rect.width - cornerSize - cornerInset) * scale),
      y: Math.round(cornerInset * scale),
      width: Math.round(cornerSize * scale),
      height: Math.round(cornerSize * scale),
    } : undefined;
    const visible = !hostSurfaceSuspended && !nativeContextMenuOpenRef.current && document.visibilityState === 'visible' && rect.width > 1 && rect.height > 1
      && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    sessionRef.current.setBounds({
      x: Math.round(rect.left * scale),
      y: Math.round(rect.top * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
      visible,
      overlayHole,
      controlsOverlayHole,
      cornerOverlayHole,
    });
  }, [controlsOverlay, controlsVisible, hostSurfaceSuspended, topRightOverlayHole]);

  useEffect(() => {
    if (!sessionId) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncBounds);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    if (surfaceRef.current) observer.observe(surfaceRef.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [sessionId, syncBounds]);

  useEffect(() => {
    if (!sessionId) return;
    const frame = window.requestAnimationFrame(syncBounds);
    return () => window.cancelAnimationFrame(frame);
  }, [controlPanel, controlsOverlay, controlsVisible, sessionId, syncBounds]);

  useEffect(() => {
    const width = Number(state.width) || 0;
    const height = Number(state.height) || 0;
    const duration = Number(state.duration) || 0;
    if (!width && !height && !duration) return;
    const key = `${width}:${height}:${duration}`;
    if (metadataKeyRef.current === key) return;
    metadataKeyRef.current = key;
    onMetadataRef.current({ width: width || undefined, height: height || undefined, duration: duration || undefined });
  }, [state.width, state.height, state.duration]);

  const control = (action: 'play' | 'pause' | 'seek' | 'volume' | 'mute' | 'speed' | 'stop' | 'subtitle-select' | 'subtitle-visible' | 'subtitle-delay', value?: number | boolean | string) => {
    if (!sessionRef.current) return;
    sessionRef.current.control({ action, value });
  };
  const paused = state.paused !== false;
  const duration = Math.max(0, Number(state.duration) || 0);
  const time = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(state.time) || 0));
  playbackPositionRef.current = { time, duration, paused };
  const speed = Math.max(0.25, Math.min(4, Number(state.speed) || 1));
  const muted = Boolean(state.muted);
  const volume = Math.max(0, Math.min(100, Number(state.volume) || 0));
  const togglePlayback = () => {
    const action = playbackPositionRef.current.paused ? 'play' : 'pause';
    playbackPositionRef.current.paused = action !== 'play';
    control(action);
  };
  const cyclePlaybackSpeed = () => {
    const currentIndex = PLAYBACK_SPEEDS.findIndex(value => Math.abs(value - speed) < 0.001);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % PLAYBACK_SPEEDS.length : 0;
    control('speed', PLAYBACK_SPEEDS[nextIndex]);
  };
  const changeVolume = (nextVolume: number) => {
    if (muted) control('mute', false);
    control('volume', nextVolume);
  };

  useEffect(() => {
    onPlaybackStateRef.current?.({ time, duration, paused });
  }, [time, duration, paused]);

  useEffect(() => {
    if (!sessionId || !editorSeekRequest) return;
    if (editorSeekRequest.pause) control('pause');
    control('seek', editorSeekRequest.time);
  }, [sessionId, editorSeekRequest?.id]);
  const seekRelative = useCallback((seconds: number) => {
    if (!sessionRef.current) return;
    const current = playbackPositionRef.current;
    const nextTime = Math.max(0, Math.min(current.duration || Number.MAX_SAFE_INTEGER, current.time + seconds));
    current.time = nextTime;
    sessionRef.current.control({ action: 'seek', value: nextTime });
  }, []);

  useEffect(() => {
    let restoreTimer = 0;
    const restoreAfterMenuAction = () => {
      if (!nativeContextMenuOpenRef.current) return;
      window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(() => {
        nativeContextMenuOpenRef.current = false;
        syncBounds();
      }, 120);
    };
    window.addEventListener('pointerdown', restoreAfterMenuAction, true);
    window.addEventListener('keydown', restoreAfterMenuAction, true);
    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener('pointerdown', restoreAfterMenuAction, true);
      window.removeEventListener('keydown', restoreAfterMenuAction, true);
    };
  }, [syncBounds]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const visiblePlayers = [...document.querySelectorAll<HTMLElement>('[data-video-player="true"]')]
        .filter(player => player.getClientRects().length > 0);
      if (visiblePlayers.length > 1 && !playerRootRef.current?.contains(document.activeElement)) return;
      const target = event.target as HTMLElement | null;
      const editable = Boolean(target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'));
      const action = resolveVideoShortcut(shortcutInputFromKeyboardEvent(event), shortcutBindings, { editable, scope: showNavigation ? 'media' : 'video' });
      if (!action || event.repeat && ['video.capture','video.fullscreen','video.subtitles','video.info'].includes(action)) return;
      event.preventDefault();
      event.stopPropagation();
      shortcutActionRef.current(action);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => {
      window.removeEventListener('keydown', handleShortcut);
    };
  }, [shortcutBindings, showNavigation]);
  const captureFrame = async () => {
    const currentSession = sessionRef.current;
    if (!currentSession || capturing) return;
    setCapturing(true);
    setCaptureNotice(null);
    try {
      const result = await currentSession.capture();
      setCaptureNotice(result.success
        ? { text: '当前帧已保存' }
        : { text: result.error || '截图失败', error: true });
    } catch (error) {
      setCaptureNotice({ text: error instanceof Error ? error.message : '截图失败', error: true });
    } finally {
      setCapturing(false);
    }
  };
  const subtitleTracks = state.subtitleTracks || [];
  const selectedSubtitle = subtitleTracks.find(track => track.id === String(state.subtitleTrackId ?? '') || track.selected);
  const subtitleDelay = Math.max(-30, Math.min(30, Number(state.subtitleDelay) || 0));
  const rememberSubtitle = (track: VideoSubtitleTrack | undefined = selectedSubtitle, delay = subtitleDelay, visible = state.subtitleVisible !== false) => {
    if (!track) return;
    try { writeSubtitleMemory(localStorage, filePath, { selection: { mode: 'track', stableId: track.stableId }, delay, visible, updatedAt: Date.now() }); } catch { /* storage can be unavailable */ }
  };
  const disableSubtitles = () => {
    control('subtitle-select', '');
    try { writeSubtitleMemory(localStorage, filePath, { selection: { mode: 'off' }, delay: subtitleDelay, visible: false, updatedAt: Date.now() }); } catch { /* storage can be unavailable */ }
  };
  const selectSubtitle = (id: string) => {
    control('subtitle-select', id);
    const track = subtitleTracks.find(item => item.id === id);
    if (track) rememberSubtitle(track, subtitleDelay, true);
  };
  const changeSubtitleDelay = (delay: number) => {
    const bounded = Math.max(-30, Math.min(30, delay));
    control('subtitle-delay', bounded);
    rememberSubtitle(selectedSubtitle, bounded);
  };
  const changeSubtitleFontSize = (fontSize: number) => {
    const normalized = normalizeSubtitleFontSize(fontSize);
    setSubtitleFontSize(normalized);
    sessionRef.current?.control({ action: 'subtitle-style', fontSize: normalized, style: keyboardSettings.subtitleStyle });
  };
  const addSubtitle = async () => {
    if (!sessionRef.current) return;
    // Choosing a new subtitle is an explicit override of a remembered "off" state.
    subtitleMemoryRestoredRef.current = true;
    const chosen = await sessionRef.current.chooseSubtitle();
    if (!chosen.success) setCaptureNotice({ text: chosen.requiresFeature ? `${chosen.error}；可在显示设置中切换后端` : chosen.error || '字幕加载失败', error: true });
    else if (!chosen.cancelled) rememberAddedSubtitleRef.current = true;
  };
  const changeTransform = (patch: Partial<VideoTransform>) => {
    const next = { ...videoTransform, ...patch };
    setVideoTransform(next);
    sessionRef.current?.control({ action: 'transform', transform: next });
  };
  const switchPlaybackBackend = async (backendId: string) => {
    const result = await sessionRef.current?.switchBackend?.(backendId);
    if (!result?.success) setCaptureNotice({ text: result?.error || '无法切换播放后端', error: true });
    else { setActiveBackendId(sessionRef.current?.backendId || backendId); setCaptureNotice({ text: '播放后端已切换' }); }
  };
  const activeBackend = availableBackends.find(item => item.backendId === activeBackendId);
  const capabilityPresentation = playbackCapabilityPresentation(activeBackend?.features, displayCapability.hdrAvailable);
  const hdrAvailability = hdrModeAvailability({ requested: keyboardSettings.hdrMode, backendModes: activeBackend?.features.hdr.modes || ['sdr'], hdrDisplayAvailable: displayCapability.hdrAvailable });
  shortcutActionRef.current = action => {
    if (action === 'video.playPause') togglePlayback();
    else if (action === 'video.seekBackward') seekRelative(-SKIP_SECONDS);
    else if (action === 'video.seekForward') seekRelative(SKIP_SECONDS);
    else if (action === 'video.frameBackward') seekRelative(-1 / 30);
    else if (action === 'video.frameForward') seekRelative(1 / 30);
    else if (action === 'video.volumeUp') changeVolume(Math.min(100, volume + 5));
    else if (action === 'video.volumeDown') changeVolume(Math.max(0, volume - 5));
    else if (action === 'video.mute') control('mute', !muted);
    else if (action === 'video.speedUp' || action === 'video.speedDown') { const index = PLAYBACK_SPEEDS.findIndex(value => value >= speed); const next = action === 'video.speedUp' ? PLAYBACK_SPEEDS[Math.min(PLAYBACK_SPEEDS.length - 1, Math.max(0, index + 1))] : PLAYBACK_SPEEDS[Math.max(0, (index < 0 ? PLAYBACK_SPEEDS.length : index) - 1)]; control('speed', next); }
    else if (action === 'video.resetSpeed') control('speed', 1);
    else if (action === 'video.fullscreen') onToggleFullscreenRef.current?.();
    else if (action === 'video.exitFullscreen') onEscapeRef.current?.();
    else if (action === 'video.capture') void captureFrame();
    else if (action === 'video.subtitles') setControlPanel(current => current === 'subtitles' ? null : 'subtitles');
    else if (action === 'video.info') setControlPanel(current => current === 'info' ? null : 'info');
    else if (action === 'media.previous') onNavigateRef.current(-1);
    else if (action === 'media.next') onNavigateRef.current(1);
  };

  const forwardBackAction = videoDirectionalAction(keyboardSettings.arrowKeyAction, 'forward-back');
  const runForwardBackControl = (direction: -1 | 1) => {
    if (forwardBackAction === 'navigate') onNavigateRef.current(direction);
    else seekRelative(direction * SKIP_SECONDS);
  };
  const backwardControlLabel = forwardBackAction === 'navigate' ? '上一个视频' : '快退 5 秒';
  const forwardControlLabel = forwardBackAction === 'navigate' ? '下一个视频' : '快进 5 秒';

  const playbackControls = bottomControls || <div className={`relative z-20 flex h-12 shrink-0 items-center gap-1 px-2 text-white ${controlsOverlay ? 'bg-[#070b15]/95 shadow-[0_-10px_24px_rgba(0,0,0,.35)]' : 'border-t border-white/10 bg-[#070b15]'}`}>
        {showNavigation && <button type="button" onClick={() => runForwardBackControl(-1)} title={backwardControlLabel} aria-label={backwardControlLabel} className="rounded p-1.5 text-slate-100 hover:bg-white/10"><SkipBack size={16}/></button>}
        <button type="button" disabled={!sessionId} onClick={togglePlayback} title={paused ? '播放' : '暂停'} aria-label={paused ? '播放' : '暂停'} className="rounded p-1.5 text-slate-100 hover:bg-white/10 disabled:opacity-40">{paused ? <Play size={17} fill="currentColor"/> : <Pause size={17} fill="currentColor"/>}</button>
        {showNavigation && <button type="button" onClick={() => runForwardBackControl(1)} title={forwardControlLabel} aria-label={forwardControlLabel} className="rounded p-1.5 text-slate-100 hover:bg-white/10"><SkipForward size={16}/></button>}
        <span className="w-10 text-right text-[11px] tabular-nums text-slate-300">{formatTime(time)}</span>
        <input type="range" min={0} max={Math.max(0.01, duration)} step={0.01} value={Math.min(time, Math.max(0.01, duration))} disabled={!duration} onChange={event => control('seek', Number(event.currentTarget.value))} aria-label="播放进度" className="min-w-12 flex-1 accent-blue-500 disabled:opacity-40"/>
        <span className="w-10 text-[11px] tabular-nums text-slate-300">{formatTime(duration)}</span>
        <div className="relative shrink-0" onPointerEnter={() => setControlPanel('speed')} onPointerLeave={() => setControlPanel(null)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }}>
          {controlPanel === 'speed' && <div ref={controlPanelRef} className="absolute bottom-full right-1/2 z-30 w-32 translate-x-1/2 pb-2" onClick={event => event.stopPropagation()}>
            <div className="rounded-lg border border-white/15 bg-[#101827] p-2 shadow-2xl shadow-black/70">
              <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium text-slate-300"><span>播放速度</span><span className="tabular-nums">{speed}×</span></div>
              <div className="grid grid-cols-2 gap-1">
                {PLAYBACK_SPEEDS.map(value => <button key={value} type="button" onClick={() => control('speed', value)} aria-label={`设置 ${value} 倍播放速度`} aria-pressed={Math.abs(value - speed) < 0.001} className={`rounded px-1 py-1.5 text-[11px] font-semibold tabular-nums transition-colors ${Math.abs(value - speed) < 0.001 ? 'bg-blue-500 text-white' : 'bg-white/5 text-slate-200 hover:bg-white/15'}`}>{value}×</button>)}
              </div>
            </div>
          </div>}
          <button type="button" disabled={!sessionId} onFocus={() => setControlPanel('speed')} onClick={cyclePlaybackSpeed} title={`播放速度 ${speed}×；单击切换，悬停选择`} aria-label={`当前播放速度 ${speed} 倍，单击切换到下一档`} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40 ${controlPanel === 'speed' ? 'bg-white/10' : ''}`}><Gauge size={16}/></button>
        </div>
        <button type="button" disabled={!sessionId || starting || capturing} onClick={() => void captureFrame()} title="截取当前视频帧并保存到原视频目录" aria-label="截取当前视频帧" className="rounded p-1.5 text-slate-200 hover:bg-white/10 disabled:opacity-40">{capturing ? <Loader2 size={16} className="animate-spin"/> : <Camera size={16}/>}</button>
        <div className="relative shrink-0" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }}>
          {controlPanel === 'subtitles' && <div ref={controlPanelRef} className="absolute bottom-full right-0 z-30 w-72 pb-2" onClick={event => event.stopPropagation()}>
            <div role="menu" aria-label="字幕" className="max-h-80 overflow-auto rounded-lg border border-white/15 bg-[#101827] p-2 text-xs shadow-2xl shadow-black/70">
              <div className="mb-2 flex items-center justify-between px-1 text-slate-300"><span className="font-bold">字幕</span><button type="button" onClick={() => void addSubtitle()} className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-white/10"><Plus size={13}/>添加本地字幕</button></div>
              <button role="menuitemradio" aria-checked={!selectedSubtitle} type="button" onClick={disableSubtitles} className={`block w-full rounded px-2 py-1.5 text-left ${!selectedSubtitle ? 'bg-blue-500 text-white' : 'text-slate-200 hover:bg-white/10'}`}>关闭</button>
              {subtitleTracks.map(track => <button key={track.stableId} role="menuitemradio" aria-checked={selectedSubtitle?.stableId === track.stableId} type="button" onClick={() => selectSubtitle(track.id)} className={`block w-full truncate rounded px-2 py-1.5 text-left ${selectedSubtitle?.stableId === track.stableId ? 'bg-blue-500 text-white' : 'text-slate-200 hover:bg-white/10'}`}>{track.source === 'external' ? '外挂' : '内嵌'} · {track.title || track.language || track.format || `轨道 ${track.id}`}</button>)}
              <div className="mt-2 border-t border-white/10 pt-2">
                <button type="button" disabled={!selectedSubtitle} onClick={() => { const visible = state.subtitleVisible === false; control('subtitle-visible', visible); rememberSubtitle(selectedSubtitle, subtitleDelay, visible); }} className="w-full rounded px-2 py-1.5 text-left text-slate-200 hover:bg-white/10 disabled:opacity-40">{state.subtitleVisible === false ? '显示字幕' : '隐藏字幕'}</button>
                <div className="flex items-center gap-1 px-2 py-1 text-slate-300"><span className="mr-auto">同步 {subtitleDelay > 0 ? `+${subtitleDelay.toFixed(1)}` : subtitleDelay.toFixed(1)} 秒</span><button type="button" onClick={() => changeSubtitleDelay(subtitleDelay - 0.5)} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">提前</button><button type="button" onClick={() => changeSubtitleDelay(0)} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">归零</button><button type="button" onClick={() => changeSubtitleDelay(subtitleDelay + 0.5)} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">延后</button></div>
                <div className="mt-1 flex items-center gap-1 px-2 py-1 text-slate-300"><span className="mr-auto">字号</span>{SUBTITLE_FONT_SIZE_PRESETS.map(preset => <button key={preset.label} type="button" aria-label={`字幕字号${preset.label}`} aria-pressed={subtitleFontSize === preset.value} onClick={() => changeSubtitleFontSize(preset.value)} className={`rounded px-2.5 py-1 font-bold transition ${subtitleFontSize === preset.value ? 'bg-blue-500 text-white' : 'bg-white/5 text-slate-200 hover:bg-white/15'}`}>{preset.label}</button>)}</div>
              </div>
            </div>
          </div>}
          <button type="button" disabled={!sessionId} onClick={() => setControlPanel(current => current === 'subtitles' ? null : 'subtitles')} title="字幕" aria-label="字幕菜单" aria-expanded={controlPanel === 'subtitles'} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40 ${controlPanel === 'subtitles' ? 'bg-white/10' : ''}`}><Captions size={17}/></button>
        </div>
        <div className="relative shrink-0" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }}>
          {controlPanel === 'display' && <div ref={controlPanelRef} className="absolute bottom-full right-0 z-30 w-80 pb-2" onClick={event => event.stopPropagation()}><div className="max-h-96 overflow-auto rounded-lg border border-white/15 bg-[#101827] p-3 text-xs text-slate-200 shadow-2xl shadow-black/70">
            <div className="mb-2 font-bold">显示与播放后端</div>
            <div className="mb-2 grid grid-cols-2 gap-1">{availableBackends.map(backend => <button key={backend.backendId} type="button" aria-pressed={backend.backendId === activeBackendId} onClick={() => void switchPlaybackBackend(backend.backendId)} className={`truncate rounded px-2 py-1.5 text-left ${backend.backendId === activeBackendId ? 'bg-blue-500 text-white' : 'bg-white/5 hover:bg-white/15'}`}>{backend.displayName}</button>)}</div>
            <div className="border-t border-white/10 pt-2"><span className="text-slate-400">画面比例</span><div className="mt-1 grid grid-cols-3 gap-1">{(['source','contain','cover','16:9','4:3','1:1'] as const).filter(mode => capabilityPresentation.transformControls.includes(mode)).map(mode => <button key={mode} type="button" aria-pressed={videoTransform.aspectMode === mode} onClick={() => changeTransform({ aspectMode: mode })} className={`rounded px-1 py-1 ${videoTransform.aspectMode === mode ? 'bg-blue-500 text-white' : 'bg-white/5 hover:bg-white/15'}`}>{mode}</button>)}</div></div>
            <div className="mt-2 flex gap-1"><button type="button" onClick={() => changeTransform({ rotation: ((videoTransform.rotation + 90) % 360) as VideoTransform['rotation'] })} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">旋转 90°</button><button type="button" aria-pressed={videoTransform.flipHorizontal} onClick={() => changeTransform({ flipHorizontal: !videoTransform.flipHorizontal })} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">水平翻转</button><button type="button" aria-pressed={videoTransform.flipVertical} onClick={() => changeTransform({ flipVertical: !videoTransform.flipVertical })} className="rounded bg-white/5 px-2 py-1 hover:bg-white/15">垂直翻转</button></div>
            <div className="mt-2 border-t border-white/10 pt-2"><span>HDR：{keyboardSettings.hdrMode}</span><p className={`mt-1 text-[10px] ${hdrAvailability.available ? 'text-emerald-300' : 'text-amber-300'}`}>{hdrAvailability.available ? `当前后端可用${keyboardSettings.hdrMode === 'hdr-passthrough' ? '，显示器已报告 HDR' : ''}` : hdrAvailability.reason || displayCapability.reason}</p></div>
          </div></div>}
          <button type="button" disabled={!sessionId} onClick={() => setControlPanel(current => current === 'display' ? null : 'display')} title="显示设置" aria-label="显示设置" aria-expanded={controlPanel === 'display'} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 disabled:opacity-40 ${controlPanel === 'display' ? 'bg-white/10' : ''}`}><Settings2 size={16}/></button>
        </div>
        <div className="relative shrink-0" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }}>
          {controlPanel === 'info' && <div ref={controlPanelRef} className="absolute bottom-full right-0 z-30 w-64 pb-2" onClick={event => event.stopPropagation()}><div className="rounded-lg border border-white/15 bg-[#101827] p-3 text-[11px] text-slate-200 shadow-2xl shadow-black/70"><div className="mb-2 font-bold">播放信息</div>{state.statistics ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"><dt>视频</dt><dd>{state.statistics.videoCodec || '未知'}</dd><dt>音频</dt><dd>{state.statistics.audioCodec || '未知'}</dd><dt>解码</dt><dd>{state.statistics.decoder || (state.statistics.hardwareDecoding ? '硬件' : '未报告')}</dd><dt>帧率</dt><dd>{state.statistics.fps?.toFixed(2) || '—'}</dd><dt>丢帧</dt><dd>{state.statistics.droppedFrames ?? '—'}</dd><dt>输出</dt><dd>{state.statistics.output || activeBackend?.displayName || '—'}</dd></dl> : <p className="text-slate-400">正在采集当前后端可提供的信息…</p>}</div></div>}
          <button type="button" disabled={!sessionId} onClick={() => setControlPanel(current => current === 'info' ? null : 'info')} title="播放信息" aria-label="播放信息" aria-expanded={controlPanel === 'info'} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 disabled:opacity-40 ${controlPanel === 'info' ? 'bg-white/10' : ''}`}><Info size={16}/></button>
        </div>
        <div className="relative shrink-0" onPointerEnter={() => setControlPanel('volume')} onPointerLeave={() => setControlPanel(null)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlPanel(null); }}>
          {controlPanel === 'volume' && <div ref={controlPanelRef} className="absolute bottom-full right-0 z-30 w-44 pb-2" onClick={event => event.stopPropagation()}>
            <div className="rounded-lg border border-white/15 bg-[#101827] p-3 shadow-2xl shadow-black/70">
              <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-slate-300"><span>音量</span><span className="tabular-nums">{muted ? 0 : Math.round(volume)}%</span></div>
              <input type="range" min={0} max={100} step={1} value={muted ? 0 : volume} onChange={event => changeVolume(Number(event.currentTarget.value))} aria-label="调整音量" className="block w-full accent-blue-500"/>
            </div>
          </div>}
          <button type="button" disabled={!sessionId} onFocus={() => setControlPanel('volume')} onClick={() => control('mute', !muted)} title={`${muted ? '开启声音' : '关闭声音'}；悬停调整音量`} aria-label={muted ? '开启声音' : '关闭声音'} className={`rounded p-1.5 text-slate-200 hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40 ${controlPanel === 'volume' ? 'bg-white/10' : ''}`}>{muted || volume === 0 ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button>
        </div>
        {(starting || state.buffering) && <span role="status" className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-blue-200"><Loader2 size={13} className="animate-spin"/>加载中</span>}
        {captureNotice && <span role="status" aria-live="polite" title={captureNotice.text} className={`max-w-24 truncate whitespace-nowrap text-[11px] ${captureNotice.error ? 'text-red-300' : 'text-emerald-300'}`}>{captureNotice.text}</span>}
    </div>;

  return <div ref={playerRootRef} data-video-player="true" className="absolute inset-0 flex min-h-0 flex-col bg-black">
    <div
      ref={surfaceRef}
      role="button"
      tabIndex={0}
      aria-label={paused ? '播放视频' : '暂停视频'}
      onClick={togglePlayback}
      onContextMenu={event => {
        if (!onContextMenuAtRef.current) return;
        event.preventDefault();
        onContextMenuAtRef.current(event.clientX, event.clientY);
      }}
      onPointerMove={() => onPointerActivityRef.current?.()}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          togglePlayback();
        }
      }}
      className="relative min-h-0 flex-1 cursor-pointer bg-black bg-contain bg-center bg-no-repeat outline-none"
      style={poster ? { backgroundImage: `url(${JSON.stringify(poster).slice(1, -1)})` } : undefined}
    >
      <video ref={videoRef} className="pointer-events-none absolute inset-0 h-full w-full object-contain" aria-hidden="true"/>
    </div>
    {controlsVisible && (controlsOverlay ? <div ref={controlsOverlayRef} className="absolute inset-x-0 bottom-0 z-20">{playbackControls}</div> : playbackControls)}
  </div>;
};

/** Legacy export name retained only for source compatibility during migration. */
const AdvancedVideoPlayer = VideoPlayer;
export { AdvancedVideoPlayer, VideoPlayer, videoDirectionalAction, videoDirectionalKeyboardInput };
