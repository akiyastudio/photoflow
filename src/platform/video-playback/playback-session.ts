import type { VideoAudioTrack, VideoPlaybackBackendDescriptor, VideoPlaybackSettings, VideoPlayerState, VideoSubtitleTrack } from '../../types';
import { chromiumVideoStyle, DEFAULT_VIDEO_TRANSFORM, drawTransformedVideoFrame, normalizeVideoTransform, transformedFrameSize } from '../../contracts/video-playback.ts';
import type { VideoHdrMode, VideoStatisticsLevel, VideoToneMapping, VideoTransform } from '../../contracts/video-playback.ts';
import { classifyPlaybackError, PlaybackFailure } from '../../contracts/playback-errors.ts';
import type { PlaybackAttempt, PlaybackErrorCode } from '../../contracts/playback-errors.ts';

export type PlaybackBackendId = string;
export type PlaybackControl = {
  action: 'play' | 'pause' | 'seek' | 'frame-step' | 'frame-back-step' | 'volume' | 'mute' | 'speed' | 'stop' | 'subtitle-select' | 'subtitle-visible' | 'subtitle-delay' | 'subtitle-style' | 'audio-select' | 'transform' | 'hdr-mode' | 'tone-mapping' | 'statistics-level';
  value?: number | boolean | string;
  fontSize?: VideoPlaybackSettings['subtitleSize'];
  style?: VideoPlaybackSettings['subtitleStyle'];
  transform?: VideoTransform;
  hdrMode?: VideoHdrMode;
  toneMapping?: VideoToneMapping;
  targetPeakNits?: number;
  statisticsLevel?: VideoStatisticsLevel;
};

export type PlaybackBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  overlayHole?: { x: number; y: number; width: number; height: number };
  controlsOverlayHole?: { x: number; y: number; width: number; height: number };
  cornerOverlayHole?: { x: number; y: number; width: number; height: number };
};

export interface PlaybackSession {
  readonly id: string;
  readonly backendId: PlaybackBackendId;
  readonly availableBackends?: VideoPlaybackBackendDescriptor[];
  readonly attempts?: PlaybackAttempt[];
  control(request: PlaybackControl): void;
  setBounds(bounds: PlaybackBounds): void;
  capture(mode?: 'sourceFrame'|'displayedFrame'): Promise<{ success: boolean; path?: string; error?: string }>;
  chooseSubtitle(): Promise<{ success: boolean; cancelled?: boolean; path?: string; error?: string; requiresFeature?: string }>;
  switchBackend?(backendId: string): Promise<{ success: boolean; error?: string }>;
  close(): Promise<void>;
}

export interface VideoPlaybackBackend {
  readonly descriptor: VideoPlaybackBackendDescriptor;
  start(context: PlaybackBackendContext): Promise<PlaybackSession>;
}

export type PlaybackSessionSnapshot = {
  time: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  speed: number;
  subtitle: { mode: 'default' | 'off' | 'track'; stableId?: string; visible: boolean; delay: number };
  subtitleStyle: { fontSize: VideoPlaybackSettings['subtitleSize']; style: VideoPlaybackSettings['subtitleStyle'] };
  transform: VideoTransform;
  hdrMode: VideoHdrMode;
  toneMapping: VideoToneMapping;
  targetPeakNits: number;
  statisticsLevel: VideoStatisticsLevel;
  audio: { stableId?: string; language?: string };
};

type ElectronApi = Window['electronAPI'];

export type PlaybackBackendContext = {
  filePath: string;
  settings: VideoPlaybackSettings;
  playerId: string;
  requestId: string;
  video: HTMLVideoElement;
  electronApi: ElectronApi;
  onState: (state: VideoPlayerState) => void;
  onRuntimeFailure: (error: string, code?: PlaybackErrorCode) => void;
};

const stateEnvelope = (context: Omit<PlaybackBackendContext, 'onRuntimeFailure'>, type: VideoPlayerState['type'], state: Partial<VideoPlayerState> = {}): VideoPlayerState => ({
  sessionId: context.requestId,
  playerId: context.playerId,
  requestId: context.requestId,
  type,
  ...state,
});

const waitForChromiumReady = (video: HTMLVideoElement) => new Promise<void>((resolve, reject) => {
  const ready = () => { cleanup(); resolve(); };
  const failed = () => { cleanup(); reject(new Error(video.error?.message || 'Chromium 无法解码此视频')); };
  const cleanup = () => {
    video.removeEventListener('loadedmetadata', ready);
    video.removeEventListener('error', failed);
  };
  video.addEventListener('loadedmetadata', ready, { once: true });
  video.addEventListener('error', failed, { once: true });
  video.load();
});

export class ChromiumPlaybackBackend implements VideoPlaybackBackend {
  readonly descriptor: VideoPlaybackBackendDescriptor;
  constructor(descriptor: VideoPlaybackBackendDescriptor) { this.descriptor = descriptor; }

  async start(context: PlaybackBackendContext): Promise<PlaybackSession> {
    const source = await context.electronApi.getVideoPlaybackSource(context.filePath);
    if (!source.success || !source.mediaUrl) throw new Error(source.error || '无法授权 Chromium 读取视频');
    const { video } = context;
    let closed = false;
    let loaded = false;
    let runtimeFailureReported = false;
    let transform = DEFAULT_VIDEO_TRANSFORM;
    let statisticsLevel: VideoStatisticsLevel = 'off';
    let statisticsTimer = 0;
    let estimatedFps = 0; let lastFrameMediaTime = -1;
    let subtitleDelay = 0;
    let subtitleSequence = 0;
    const browserSubtitles = new Map<string, { element: HTMLTrackElement; stableId: string; name: string; originalTimes: WeakMap<TextTrackCue, { start: number; end: number }> }>();
    const emitSubtitles = () => {
      const tracks = [...browserSubtitles.entries()].map(([id, item]) => ({ id, stableId: item.stableId, source: 'external' as const, title: item.name, format: 'vtt', selected: item.element.track.mode !== 'disabled' }));
      const selected = tracks.find(item => item.selected);
      context.onState(stateEnvelope(context, 'subtitle-tracks', { subtitleTracks: tracks, subtitleTrackId: selected?.id || null, subtitleVisible: selected ? browserSubtitles.get(selected.id)?.element.track.mode === 'showing' : false, subtitleDelay }));
    };
    const applyBrowserSubtitleDelay = () => {
      for (const item of browserSubtitles.values()) for (const cue of Array.from(item.element.track.cues || [])) {
        const original = item.originalTimes.get(cue) || { start: cue.startTime, end: cue.endTime }; item.originalTimes.set(cue, original);
        cue.startTime = Math.max(0, original.start + subtitleDelay); cue.endTime = Math.max(cue.startTime, original.end + subtitleDelay);
      }
    };
    video.src = source.mediaUrl;
    video.poster = '';
    video.preload = 'auto';
    video.playsInline = true;

    const emitState = () => {
      const time = Number(video.currentTime) || 0;
      context.onState(stateEnvelope(context, 'state', {
        time,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        paused: video.paused,
        buffering: video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
        muted: video.muted,
        volume: Math.round(video.volume * 100),
        speed: video.playbackRate,
        width: video.videoWidth,
        height: video.videoHeight,
      }));
    };
    const onWaiting = () => context.onState(stateEnvelope(context, 'loading', { buffering: true }));
    const onPlaying = () => { loaded = true; emitState(); };
    const onEnded = () => context.onState(stateEnvelope(context, 'ended', { paused: true, time: Number(video.duration) || Number(video.currentTime) || 0 }));
    const onError = () => {
      if (closed || !loaded || runtimeFailureReported) return;
      runtimeFailureReported = true;
      context.onRuntimeFailure(video.error?.message || 'Chromium 视频解码失败', 'UNSUPPORTED_CODEC');
    };
    const emitStatistics = () => {
      if (statisticsLevel === 'off' || closed) return;
      const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
      context.onState(stateEnvelope(context, 'statistics', { statistics: {
        level: statisticsLevel === 'detailed' ? 'detailed' : 'basic',
        container: context.filePath.split('.').pop()?.toLowerCase(),
        droppedFrames: quality?.droppedVideoFrames,
        sourceFps: estimatedFps || undefined,
        displayFps: estimatedFps || undefined,
        hardwareDecoding: undefined,
        renderer: 'Chromium HTMLVideoElement',
        toneMapping: 'browser-managed',
      } }));
    };
    const sampleFrameRate = (_now: number, metadata: VideoFrameCallbackMetadata) => { if (closed) return; if (lastFrameMediaTime >= 0 && metadata.mediaTime > lastFrameMediaTime) { const current = 1 / (metadata.mediaTime - lastFrameMediaTime); if (current >= 1 && current <= 240) estimatedFps = estimatedFps ? estimatedFps * 0.8 + current * 0.2 : current; } lastFrameMediaTime = metadata.mediaTime; video.requestVideoFrameCallback?.(sampleFrameRate); };
    const updateStatisticsTimer = () => {
      globalThis.clearInterval(statisticsTimer);
      statisticsTimer = statisticsLevel === 'off' ? 0 : globalThis.setInterval(emitStatistics, statisticsLevel === 'detailed' ? 250 : 1000);
    };
    const events: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [
      ['timeupdate', emitState as EventListener], ['durationchange', emitState as EventListener],
      ['volumechange', emitState as EventListener], ['ratechange', emitState as EventListener],
      ['play', emitState as EventListener], ['pause', emitState as EventListener],
      ['waiting', onWaiting as EventListener], ['playing', onPlaying as EventListener],
      ['ended', onEnded as EventListener], ['error', onError as EventListener],
    ];
    events.forEach(([name, listener]) => video.addEventListener(name, listener));

    try {
      await waitForChromiumReady(video);
      loaded = true;
      context.onState(stateEnvelope(context, 'file-loaded', {
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight,
        buffering: false,
      }));
      try {
        await video.play();
      } catch (error) {
        // A host autoplay policy is not a decoder failure. Keep the Chromium
        // session ready so the existing play control can satisfy user gesture.
        if (!(error instanceof DOMException) || error.name !== 'NotAllowedError') throw error;
        emitState();
      }
      video.requestVideoFrameCallback?.(sampleFrameRate);
    } catch (error) {
      events.forEach(([name, listener]) => video.removeEventListener(name, listener));
      video.removeAttribute('src');
      video.load();
      throw error;
    }

    return {
      id: context.requestId,
      backendId: this.descriptor.backendId,
      control: request => {
        if (closed) return;
        if (request.action === 'play') void video.play().catch(error => {
          if (error instanceof DOMException && error.name === 'NotAllowedError') emitState();
          else onError();
        });
        else if (request.action === 'pause') video.pause();
        else if (request.action === 'seek') video.currentTime = Math.max(0, Number(request.value) || 0);
        else if (request.action === 'frame-step' || request.action === 'frame-back-step') { if (estimatedFps > 0) { video.pause(); video.currentTime = Math.max(0, video.currentTime + (request.action === 'frame-step' ? 1 : -1) / estimatedFps); } else context.onState(stateEnvelope(context, 'diagnostic', { diagnostic: { code: 'FRAME_STEP_UNAVAILABLE', severity: 'warning', phase: 'frame-step', message: 'Chromium 尚未获得可靠源帧率，未执行近似逐帧', recoverable: true } })); }
        else if (request.action === 'volume') video.volume = Math.max(0, Math.min(1, (Number(request.value) || 0) / 100));
        else if (request.action === 'mute') video.muted = Boolean(request.value);
        else if (request.action === 'speed') video.playbackRate = Math.max(0.25, Math.min(4, Number(request.value) || 1));
        else if (request.action === 'transform') { transform = normalizeVideoTransform(request.transform); Object.assign(video.style, chromiumVideoStyle(transform)); }
        else if (request.action === 'statistics-level') { statisticsLevel = request.statisticsLevel || 'off'; updateStatisticsTimer(); emitStatistics(); }
        else if (request.action === 'subtitle-select') { for (const [id, item] of browserSubtitles) item.element.track.mode = id === String(request.value || '') ? 'showing' : 'disabled'; emitSubtitles(); }
        else if (request.action === 'subtitle-visible') { const selected = [...browserSubtitles.values()].find(item => item.element.track.mode !== 'disabled'); if (selected) selected.element.track.mode = request.value ? 'showing' : 'hidden'; emitSubtitles(); }
        else if (request.action === 'subtitle-delay') { subtitleDelay = Math.max(-30, Math.min(30, Number(request.value) || 0)); applyBrowserSubtitleDelay(); emitSubtitles(); }
        else if (request.action === 'stop') { video.pause(); video.currentTime = 0; }
      },
      setBounds: () => undefined,
      capture: async mode => {
        if (!video.videoWidth || !video.videoHeight) return { success: false, error: '当前视频帧尚未就绪' };
        const canvas = document.createElement('canvas');
        const captureTransform = mode === 'sourceFrame' ? DEFAULT_VIDEO_TRANSFORM : transform;
        const size = transformedFrameSize(video.videoWidth, video.videoHeight, captureTransform);
        canvas.width = size.width; canvas.height = size.height;
        const drawing = canvas.getContext('2d');
        if (!drawing) return { success: false, error: '无法创建视频截图画布' };
        drawTransformedVideoFrame(drawing, video, captureTransform);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) return { success: false, error: '无法生成当前视频帧' };
        return context.electronApi.publishVideoPlayerFrame(context.filePath, new Uint8Array(await blob.arrayBuffer()));
      },
      chooseSubtitle: async () => {
        const chosen = await context.electronApi.chooseVideoSubtitleFile();
        if (!chosen.success || chosen.cancelled) return chosen;
        if (chosen.format !== 'vtt' || !chosen.mediaUrl) return { success: false, error: `${String(chosen.format || '').toUpperCase()} 字幕需要支持该格式的高级播放后端`, requiresFeature: `subtitle-format:${chosen.format || 'unknown'}` };
        const id = `chromium-vtt-${++subtitleSequence}`; const name = chosen.name || `字幕 ${subtitleSequence}`;
        const element = document.createElement('track'); element.kind = 'subtitles'; element.label = name; element.src = chosen.mediaUrl; element.default = true;
        const item = { element, stableId: `external:${name.toLowerCase()}:0`, name, originalTimes: new WeakMap<TextTrackCue, { start: number; end: number }>() };
        browserSubtitles.set(id, item); element.addEventListener('load', () => { element.track.mode = 'showing'; applyBrowserSubtitleDelay(); emitSubtitles(); }, { once: true });
        video.appendChild(element); element.track.mode = 'showing'; emitSubtitles(); return { success: true, path: name };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        globalThis.clearInterval(statisticsTimer);
        events.forEach(([name, listener]) => video.removeEventListener(name, listener));
        for (const item of browserSubtitles.values()) item.element.remove(); browserSubtitles.clear();
        video.pause();
        video.removeAttribute('src');
        video.load();
      },
    };
  }
}

export class BrokeredPlaybackBackend implements VideoPlaybackBackend {
  readonly descriptor: VideoPlaybackBackendDescriptor;
  constructor(descriptor: VideoPlaybackBackendDescriptor) { this.descriptor = descriptor; }

  async start(context: PlaybackBackendContext): Promise<PlaybackSession> {
    let sessionId = '';
    let closed = false;
    let ready = false;
    let loadError: Error | null = null;
    let resolveLoaded!: () => void;
    const loaded = new Promise<void>(resolve => { resolveLoaded = resolve; });
    const unsubscribe = context.electronApi.onVideoPlayerState(update => {
      if (update.playerId !== context.playerId || update.requestId !== context.requestId) return;
      if (sessionId && update.sessionId !== sessionId) return;
      if (update.type === 'fatal' || update.type === 'error' || update.type === 'stopped') {
        const error = update.error || '高级视频解码组件意外退出';
        if (ready && !closed) context.onRuntimeFailure(error, update.errorCode || 'BACKEND_CRASHED');
        else { loadError = new PlaybackFailure(update.errorCode || 'DECODE_INITIALIZATION_FAILED', error); resolveLoaded(); }
        return;
      }
      if (update.type === 'file-loaded') resolveLoaded();
      context.onState(update);
    });
    let result;
    try {
      result = await context.electronApi.startVideoPlayer(context.filePath, context.settings, context.playerId, context.requestId, this.descriptor.backendId);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    if (!result.success || !result.sessionId) {
      unsubscribe();
      throw new PlaybackFailure(result.errorCode || 'BACKEND_UNAVAILABLE', result.error || '高级视频解码组件无法启动', result.recoverable !== false, [], result.suggestedFallback || 'component');
    }
    sessionId = result.sessionId;
    let timer = 0;
    try {
      await Promise.race([
        loaded,
        new Promise<never>((_resolve, reject) => { timer = window.setTimeout(() => reject(new Error('高级视频播放后端打开媒体超时')), 8000); }),
      ]);
      if (loadError) throw loadError;
    } catch (error) {
      unsubscribe();
      await context.electronApi.stopVideoPlayer(sessionId);
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
    ready = true;
    return {
      id: sessionId,
      backendId: this.descriptor.backendId,
      control: request => context.electronApi.controlVideoPlayer(sessionId, request),
      setBounds: bounds => context.electronApi.setVideoPlayerBounds(sessionId, bounds),
      capture: mode => context.electronApi.captureVideoPlayerFrame(sessionId, mode || 'displayedFrame'),
      chooseSubtitle: () => context.electronApi.chooseVideoSubtitle(sessionId),
      close: async () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        context.electronApi.setVideoPlayerBounds(sessionId, { x: 0, y: 0, width: 0, height: 0, visible: false });
        await context.electronApi.stopVideoPlayer(sessionId);
      },
    };
  }
}

const MIME_HINTS: Record<string, string> = {
  '.avi': 'video/x-msvideo', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.ogv': 'video/ogg',
  '.ogg': 'video/ogg', '.webm': 'video/webm',
};

export const chromiumContainerProbe = (video: HTMLVideoElement, filePath: string): 'probably' | 'maybe' | 'unknown' => {
  const cleanPath = filePath.split(/[?#]/, 1)[0];
  const dot = cleanPath.lastIndexOf('.');
  const mime = MIME_HINTS[dot >= 0 ? cleanPath.slice(dot).toLowerCase() : ''];
  if (!mime) return 'unknown';
  const result = video.canPlayType(mime);
  return result === 'probably' || result === 'maybe' ? result : 'unknown';
};

export const discoverPlaybackBackends = async (context: Pick<PlaybackBackendContext, 'filePath' | 'video' | 'electronApi'>): Promise<VideoPlaybackBackend[]> => {
  const result = await context.electronApi.getVideoPlaybackBackends(context.filePath, chromiumContainerProbe(context.video, context.filePath));
  if (!result.success) throw new Error(result.error || '无法发现视频播放后端');
  return result.backends.map(descriptor => descriptor.transport === 'chromium'
    ? new ChromiumPlaybackBackend(descriptor)
    : new BrokeredPlaybackBackend(descriptor));
};

const languageMatches = (trackLanguage: string | undefined, preferredLanguage: string) => {
  const track = String(trackLanguage || '').trim().replaceAll('_', '-').toLowerCase();
  const preferred = String(preferredLanguage || '').trim().replaceAll('_', '-').toLowerCase();
  return Boolean(track && preferred && (track === preferred || track.startsWith(`${preferred}-`) || preferred.startsWith(`${track}-`)));
};

const initialSnapshot = (settings: VideoPlaybackSettings): PlaybackSessionSnapshot => ({
  time: 0, paused: false, volume: 100, muted: false, speed: 1,
  subtitle: { mode: 'default', visible: settings.subtitlesEnabled === true, delay: 0 },
  subtitleStyle: { fontSize: settings.subtitleSize, style: settings.subtitleStyle },
  transform: { ...DEFAULT_VIDEO_TRANSFORM }, hdrMode: settings.hdrMode || 'auto', toneMapping: settings.toneMapping || 'auto', targetPeakNits: Math.max(100, Math.min(4000, settings.targetPeakNits || 400)), statisticsLevel: 'off', audio: {},
});
const cloneSnapshot = (value: PlaybackSessionSnapshot): PlaybackSessionSnapshot => ({
  ...value, subtitle: { ...value.subtitle }, subtitleStyle: { ...value.subtitleStyle }, transform: { ...value.transform }, audio: { ...value.audio },
});

const selectedStableId = (state: VideoPlayerState) => state.subtitleTracks?.find(track => track.id === String(state.subtitleTrackId ?? '') || track.selected)?.stableId;

export const startPlaybackSession = async ({ backends, context }: {
  backends: VideoPlaybackBackend[];
  context: Omit<PlaybackBackendContext, 'onRuntimeFailure'>;
}): Promise<PlaybackSession> => {
  const attempted = new Set<PlaybackBackendId>();
  const attempts: PlaybackAttempt[] = [];
  let current: PlaybackSession | null = null;
  let currentTracks: VideoSubtitleTrack[] = [];
  let currentAudioTracks: VideoAudioTrack[] = [];
  let currentSubtitleState: VideoPlayerState | null = null;
  let currentAudioState: VideoPlayerState | null = null;
  let closed = false;
  let switching = false;
  let fallbackPromise: Promise<void> | null = null;
  let suppressBackendState = false;
  let lastError = '';
  let lastBounds: PlaybackBounds | null = null;
  let snapshot = initialSnapshot(context.settings);

  const updateSnapshotFromState = (state: VideoPlayerState) => {
    if (Number.isFinite(state.time)) snapshot.time = Math.max(0, Number(state.time));
    if (typeof state.paused === 'boolean') snapshot.paused = state.paused;
    if (Number.isFinite(state.volume)) snapshot.volume = Math.max(0, Math.min(100, Number(state.volume)));
    if (typeof state.muted === 'boolean') snapshot.muted = state.muted;
    if (Number.isFinite(state.speed)) snapshot.speed = Math.max(0.25, Math.min(4, Number(state.speed)));
    // Before the initial backend is bound, a selected flag is only a decoder
    // fact. It must not replace the application's default subtitle policy.
    const stableId = current ? selectedStableId(state) : undefined;
    if (Number.isFinite(state.subtitleDelay)) snapshot.subtitle.delay = Math.max(-30, Math.min(30, Number(state.subtitleDelay)));
    if (typeof state.subtitleVisible === 'boolean' && (snapshot.subtitle.mode !== 'default' || stableId)) snapshot.subtitle.visible = state.subtitleVisible;
    if (stableId) snapshot.subtitle = { ...snapshot.subtitle, mode: 'track', stableId };
    const selectedAudio = state.audioTracks?.find(track => track.id === String(state.audioTrackId ?? '') || track.selected);
    if (selectedAudio) snapshot.audio = { stableId: selectedAudio.stableId, language: selectedAudio.language };
  };

  const applySubtitleSnapshot = (session: PlaybackSession, tracks: VideoSubtitleTrack[], value = snapshot) => {
    session.control({ action: 'subtitle-delay', value: value.subtitle.delay });
    let track: VideoSubtitleTrack | undefined;
    if (value.subtitle.mode === 'track') track = tracks.find(item => item.stableId === value.subtitle.stableId);
    else if (value.subtitle.mode === 'default' && context.settings.subtitlesEnabled) {
      for (const language of context.settings.subtitlePreferredLanguages || []) {
        track = tracks.find(item => languageMatches(item.language, language));
        if (track) break;
      }
      track ||= tracks[0];
    }
    if (!track || value.subtitle.mode === 'off') {
      session.control({ action: 'subtitle-select', value: '' });
      return;
    }
    value.subtitle = { ...value.subtitle, mode: 'track', stableId: track.stableId };
    session.control({ action: 'subtitle-select', value: track.id });
    session.control({ action: 'subtitle-visible', value: value.subtitle.visible });
  };

  const handleBackendState = (state: VideoPlayerState) => {
    if (!suppressBackendState) updateSnapshotFromState(state);
    if (state.type === 'subtitle-tracks') {
      currentTracks = state.subtitleTracks || [];
      currentSubtitleState = state;
      if (current) applySubtitleSnapshot(current, currentTracks);
    }
    if (state.type === 'audio-tracks') { currentAudioTracks = state.audioTracks || []; currentAudioState = state; }
    if (!suppressBackendState) context.onState(state);
  };

  const restoreSnapshot = (session: PlaybackSession, value: PlaybackSessionSnapshot) => {
    session.control({ action: 'pause' });
    session.control({ action: 'volume', value: value.volume });
    session.control({ action: 'mute', value: value.muted });
    session.control({ action: 'speed', value: value.speed });
    session.control({ action: 'seek', value: value.time });
    session.control({ action: 'subtitle-style', fontSize: value.subtitleStyle.fontSize, style: value.subtitleStyle.style });
    session.control({ action: 'transform', transform: value.transform });
    session.control({ action: 'hdr-mode', hdrMode: value.hdrMode });
    session.control({ action: 'tone-mapping', toneMapping: value.toneMapping, targetPeakNits: value.targetPeakNits });
    session.control({ action: 'statistics-level', statisticsLevel: value.statisticsLevel });
    applySubtitleSnapshot(session, currentTracks, value);
    const audioTrack = currentAudioTracks.find(item => item.stableId === value.audio.stableId) || currentAudioTracks.find(item => value.audio.language && item.language === value.audio.language);
    if (audioTrack) session.control({ action: 'audio-select', value: audioTrack.id });
    if (!value.paused) session.control({ action: 'play' });
  };

  const startNext = async (preferredBackendId = ''): Promise<PlaybackSession> => {
    if (closed) throw new Error('视频播放会话已经关闭');
    const backend = (preferredBackendId ? backends.find(candidate => candidate.descriptor.backendId === preferredBackendId && !attempted.has(candidate.descriptor.backendId)) : null)
      || backends.find(candidate => !attempted.has(candidate.descriptor.backendId));
    if (!backend) throw new PlaybackFailure('BACKEND_UNAVAILABLE', lastError || 'Chromium 与高级视频解码组件均无法播放此视频', false, attempts.map(item => ({ ...item })), 'system-player');
    attempted.add(backend.descriptor.backendId);
    const attempt: PlaybackAttempt = { backendId: backend.descriptor.backendId, phase: 'start', startedAt: Date.now(), endedAt: 0, automatic: !preferredBackendId };
    attempts.push(attempt);
    currentTracks = [];
    currentAudioTracks = [];
    currentAudioState = null;
    currentSubtitleState = null;
    try {
      const started = await backend.start({
        ...context,
        onState: handleBackendState,
        onRuntimeFailure: (error, code) => { void beginSwitch(error, '', code); },
      });
      attempt.endedAt = Date.now();
      if (closed) {
        await started.close();
        throw new Error('视频播放会话已经关闭');
      }
      return started;
    } catch (error) {
      const failure = classifyPlaybackError(error, 'BACKEND_UNAVAILABLE'); attempt.endedAt = Date.now(); attempt.errorCode = failure.code; attempt.message = failure.message;
      lastError = failure.message;
      if (closed) throw error;
      return startNext();
    }
  };
  const switchAfterFailure = async (error: string, preferredBackendId = '', errorCode: PlaybackErrorCode = 'BACKEND_CRASHED') => {
    if (closed || switching) return;
    switching = true;
    suppressBackendState = true;
    const preserved = cloneSnapshot(snapshot);
    if (current) attempts.push({ backendId: current.backendId, phase: 'runtime', startedAt: Date.now(), endedAt: Date.now(), errorCode, message: error, automatic: !preferredBackendId });
    lastError = error;
    const failed = current;
    current = null;
    await failed?.close().catch(() => undefined);
    if (!closed) context.onState(stateEnvelope(context, 'loading', { buffering: true, subtitleTracks: [], subtitleTrackId: null, subtitleVisible: false }));
    try {
      const next = await startNext(preferredBackendId);
      if (closed) {
        await next.close();
        return;
      }
      current = next;
      snapshot = preserved;
      if (lastBounds) current.setBounds(lastBounds);
      restoreSnapshot(current, snapshot);
      if (currentSubtitleState) {
        const restoredTrack = currentTracks.find(item => item.stableId === snapshot.subtitle.stableId);
        context.onState({ ...currentSubtitleState, subtitleTrackId: restoredTrack?.id ?? null, subtitleVisible: snapshot.subtitle.visible, subtitleDelay: snapshot.subtitle.delay });
      }
      if(currentAudioState){const restoredAudio=currentAudioTracks.find(item=>item.stableId===snapshot.audio.stableId)||currentAudioTracks.find(item=>snapshot.audio.language&&item.language===snapshot.audio.language);context.onState({...currentAudioState,audioTrackId:restoredAudio?.id??null});}
      context.onState(stateEnvelope(context, 'state', {
        time: snapshot.time, paused: snapshot.paused, volume: snapshot.volume, muted: snapshot.muted, speed: snapshot.speed,
        subtitleDelay: snapshot.subtitle.delay, subtitleVisible: snapshot.subtitle.visible, buffering: false,
      }));
    } catch (terminalError) {
      if (!closed) context.onState(stateEnvelope(context, 'fatal', { errorCode: 'BACKEND_UNAVAILABLE', suggestedFallback: 'system-player', attempts: attempts.map(item => ({ ...item })), error: `视频无法播放：${terminalError instanceof Error ? terminalError.message : String(terminalError)}。请安装或修复高级解码组件，或使用系统播放器。` }));
    } finally {
      suppressBackendState = false;
      switching = false;
    }
  };
  const beginSwitch = (error: string, preferredBackendId = '', errorCode: PlaybackErrorCode = 'BACKEND_CRASHED') => {
    if (!fallbackPromise) fallbackPromise = switchAfterFailure(error, preferredBackendId, errorCode).finally(() => { fallbackPromise = null; });
    return fallbackPromise;
  };

  current = await startNext();
  // Native stdout may deliver file-loaded and subtitle-tracks before start()
  // resolves. Apply only the application-owned subtitle policy here; full
  // state restoration is reserved for an actual backend switch.
  if (currentTracks.length) applySubtitleSnapshot(current, currentTracks);
  current.control({ action: 'transform', transform: snapshot.transform });
  current.control({ action: 'hdr-mode', hdrMode: snapshot.hdrMode });
  current.control({ action: 'tone-mapping', toneMapping: snapshot.toneMapping, targetPeakNits: snapshot.targetPeakNits });
  return {
    get id() { return current?.id || context.requestId; },
    get backendId() { return current?.backendId || backends[0]?.descriptor.backendId || 'unavailable'; },
    get attempts() { return attempts.map(item => ({ ...item })); },
    control: request => {
      if (request.action === 'play') snapshot.paused = false;
      else if (request.action === 'pause' || request.action === 'stop') snapshot.paused = true;
      else if (request.action === 'seek') snapshot.time = Math.max(0, Number(request.value) || 0);
      else if (request.action === 'volume') snapshot.volume = Math.max(0, Math.min(100, Number(request.value) || 0));
      else if (request.action === 'mute') snapshot.muted = Boolean(request.value);
      else if (request.action === 'speed') snapshot.speed = Math.max(0.25, Math.min(4, Number(request.value) || 1));
      else if (request.action === 'subtitle-delay') snapshot.subtitle.delay = Math.max(-30, Math.min(30, Number(request.value) || 0));
      else if (request.action === 'subtitle-visible') snapshot.subtitle.visible = Boolean(request.value);
      else if (request.action === 'subtitle-select') {
        const track = currentTracks.find(item => item.id === String(request.value || ''));
        snapshot.subtitle = track ? { ...snapshot.subtitle, mode: 'track', stableId: track.stableId } : { ...snapshot.subtitle, mode: 'off', stableId: undefined, visible: false };
      } else if (request.action === 'subtitle-style') snapshot.subtitleStyle = { fontSize: request.fontSize ?? snapshot.subtitleStyle.fontSize, style: request.style ?? snapshot.subtitleStyle.style };
      else if (request.action === 'audio-select') { const track = currentAudioTracks.find(item => item.id === String(request.value || '')); if (track) snapshot.audio = { stableId: track.stableId, language: track.language }; }
      else if (request.action === 'transform') snapshot.transform = normalizeVideoTransform(request.transform);
      else if (request.action === 'hdr-mode') snapshot.hdrMode = request.hdrMode || 'auto';
      else if (request.action === 'tone-mapping') { snapshot.toneMapping = request.toneMapping || 'auto'; snapshot.targetPeakNits = Math.max(100, Math.min(4000, request.targetPeakNits || 400)); }
      else if (request.action === 'statistics-level') snapshot.statisticsLevel = request.statisticsLevel || 'off';
      current?.control(request);
    },
    setBounds: bounds => {
      lastBounds = bounds;
      current?.setBounds(bounds);
    },
    capture: mode => current?.capture(mode) || Promise.resolve({ success: false, error: '视频播放会话不存在' }),
    chooseSubtitle: () => current?.chooseSubtitle() || Promise.resolve({ success: false, error: '视频播放会话不存在' }),
    availableBackends: backends.map(item => item.descriptor),
    switchBackend: async backendId => {
      if (closed) return { success: false, error: '视频播放会话已经关闭' };
      if (current?.backendId === backendId) return { success: true };
      if (!backends.some(item => item.descriptor.backendId === backendId)) return { success: false, error: '播放后端不存在' };
      if (attempted.has(backendId)) return { success: false, error: '当前媒体已尝试过此后端；请重新打开视频后再试' };
      await beginSwitch('用户请求切换播放后端', backendId);
      return current?.backendId === backendId ? { success: true } : { success: false, error: lastError || '无法切换播放后端' };
    },
    close: async () => {
      closed = true;
      const active = current;
      current = null;
      await active?.close();
      await fallbackPromise;
    },
  };
};
