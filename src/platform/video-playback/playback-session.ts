import type { VideoPlaybackSettings, VideoPlayerState } from '../../types';

export type PlaybackBackendKind = 'chromium' | 'component';
export type PlaybackControl = {
  action: 'play' | 'pause' | 'seek' | 'volume' | 'mute' | 'speed' | 'stop' | 'subtitle-select' | 'subtitle-visible' | 'subtitle-delay' | 'subtitle-style';
  value?: number | boolean | string;
  fontSize?: VideoPlaybackSettings['subtitleSize'];
  style?: VideoPlaybackSettings['subtitleStyle'];
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
  readonly backend: PlaybackBackendKind;
  control(request: PlaybackControl): void;
  setBounds(bounds: PlaybackBounds): void;
  capture(): Promise<{ success: boolean; path?: string; error?: string }>;
  chooseSubtitle(): Promise<{ success: boolean; cancelled?: boolean; path?: string; error?: string }>;
  close(): Promise<void>;
}

export interface VideoPlaybackBackend {
  readonly kind: PlaybackBackendKind;
  start(context: PlaybackBackendContext): Promise<PlaybackSession>;
}

type ElectronApi = Window['electronAPI'];

export type PlaybackBackendContext = {
  filePath: string;
  settings: VideoPlaybackSettings;
  playerId: string;
  requestId: string;
  video: HTMLVideoElement;
  electronApi: ElectronApi;
  onState: (state: VideoPlayerState) => void;
  onRuntimeFailure: (error: string) => void;
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
  readonly kind = 'chromium' as const;

  async start(context: PlaybackBackendContext): Promise<PlaybackSession> {
    const source = await context.electronApi.getVideoPlaybackSource(context.filePath);
    if (!source.success || !source.mediaUrl) throw new Error(source.error || '无法授权 Chromium 读取视频');
    const { video } = context;
    let closed = false;
    let loaded = false;
    let runtimeFailureReported = false;
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
      context.onRuntimeFailure(video.error?.message || 'Chromium 视频解码失败');
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
    } catch (error) {
      events.forEach(([name, listener]) => video.removeEventListener(name, listener));
      video.removeAttribute('src');
      video.load();
      throw error;
    }

    return {
      id: context.requestId,
      backend: this.kind,
      control: request => {
        if (closed) return;
        if (request.action === 'play') void video.play().catch(error => {
          if (error instanceof DOMException && error.name === 'NotAllowedError') emitState();
          else onError();
        });
        else if (request.action === 'pause') video.pause();
        else if (request.action === 'seek') video.currentTime = Math.max(0, Number(request.value) || 0);
        else if (request.action === 'volume') video.volume = Math.max(0, Math.min(1, (Number(request.value) || 0) / 100));
        else if (request.action === 'mute') video.muted = Boolean(request.value);
        else if (request.action === 'speed') video.playbackRate = Math.max(0.25, Math.min(4, Number(request.value) || 1));
        else if (request.action === 'stop') video.pause();
      },
      setBounds: () => undefined,
      capture: async () => {
        if (!video.videoWidth || !video.videoHeight) return { success: false, error: '当前视频帧尚未就绪' };
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d')?.drawImage(video, 0, 0);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) return { success: false, error: '无法生成当前视频帧' };
        return context.electronApi.publishVideoPlayerFrame(context.filePath, new Uint8Array(await blob.arrayBuffer()));
      },
      chooseSubtitle: async () => ({ success: false, error: '当前视频需要高级解码组件才能加载外部字幕' }),
      close: async () => {
        if (closed) return;
        closed = true;
        events.forEach(([name, listener]) => video.removeEventListener(name, listener));
        video.pause();
        video.removeAttribute('src');
        video.load();
      },
    };
  }
}

export class ComponentPlaybackBackend implements VideoPlaybackBackend {
  readonly kind = 'component' as const;

  async start(context: PlaybackBackendContext): Promise<PlaybackSession> {
    let sessionId = '';
    let closed = false;
    let ready = false;
    const unsubscribe = context.electronApi.onVideoPlayerState(update => {
      if (update.playerId !== context.playerId || update.requestId !== context.requestId) return;
      if (sessionId && update.sessionId !== sessionId) return;
      if (update.type === 'fatal' || update.type === 'error' || update.type === 'stopped') {
        if (ready && !closed) context.onRuntimeFailure(update.error || '高级视频解码组件意外退出');
        return;
      }
      context.onState(update);
    });
    let result;
    try {
      result = await context.electronApi.startVideoPlayer(context.filePath, context.settings, context.playerId, context.requestId);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    if (!result.success || !result.sessionId) {
      unsubscribe();
      throw new Error(result.error || '高级视频解码组件无法启动');
    }
    sessionId = result.sessionId;
    ready = true;
    return {
      id: sessionId,
      backend: this.kind,
      control: request => context.electronApi.controlVideoPlayer(sessionId, request),
      setBounds: bounds => context.electronApi.setVideoPlayerBounds(sessionId, bounds),
      capture: () => context.electronApi.captureVideoPlayerFrame(sessionId),
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

const chromiumFirstExtensions = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.ogg']);

export const preferredPlaybackBackends = (filePath: string): PlaybackBackendKind[] => {
  const cleanPath = filePath.split(/[?#]/, 1)[0];
  const dot = cleanPath.lastIndexOf('.');
  const extension = dot >= 0 ? cleanPath.slice(dot).toLowerCase() : '';
  return chromiumFirstExtensions.has(extension) ? ['chromium', 'component'] : ['component', 'chromium'];
};

export const startPlaybackSession = async ({ backends, context }: {
  backends: VideoPlaybackBackend[];
  context: Omit<PlaybackBackendContext, 'onRuntimeFailure'>;
}): Promise<PlaybackSession> => {
  const attempted = new Set<PlaybackBackendKind>();
  let current: PlaybackSession | null = null;
  let closed = false;
  let switching = false;
  let lastError = '';
  let lastBounds: PlaybackBounds | null = null;
  const ordered = preferredPlaybackBackends(context.filePath)
    .map(kind => backends.find(backend => backend.kind === kind))
    .filter((backend): backend is VideoPlaybackBackend => Boolean(backend));

  const startNext = async (): Promise<PlaybackSession> => {
    const backend = ordered.find(candidate => !attempted.has(candidate.kind));
    if (!backend) throw new Error(lastError || 'Chromium 与高级视频解码组件均无法播放此视频');
    attempted.add(backend.kind);
    try {
      return await backend.start({
        ...context,
        onRuntimeFailure: error => { void switchAfterFailure(error); },
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return startNext();
    }
  };
  const switchAfterFailure = async (error: string) => {
    if (closed || switching) return;
    switching = true;
    lastError = error;
    const failed = current;
    current = null;
    await failed?.close().catch(() => undefined);
    context.onState(stateEnvelope(context, 'loading', { buffering: true, subtitleTracks: [], subtitleTrackId: null, subtitleVisible: false }));
    try {
      current = await startNext();
      if (lastBounds) current.setBounds(lastBounds);
    } catch (terminalError) {
      context.onState(stateEnvelope(context, 'fatal', { error: `视频无法播放：${terminalError instanceof Error ? terminalError.message : String(terminalError)}。请安装或修复高级解码组件，或使用系统播放器。` }));
    } finally {
      switching = false;
    }
  };

  current = await startNext();
  return {
    get id() { return current?.id || context.requestId; },
    get backend() { return current?.backend || ordered[0]?.kind || 'chromium'; },
    control: request => current?.control(request),
    setBounds: bounds => {
      lastBounds = bounds;
      current?.setBounds(bounds);
    },
    capture: () => current?.capture() || Promise.resolve({ success: false, error: '视频播放会话不存在' }),
    chooseSubtitle: () => current?.chooseSubtitle() || Promise.resolve({ success: false, error: '视频播放会话不存在' }),
    close: async () => {
      closed = true;
      const active = current;
      current = null;
      await active?.close();
    },
  };
};
