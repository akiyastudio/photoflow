/* eslint-disable react-refresh/only-export-components -- directional input helpers are intentionally colocated with the player contract */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Camera, Gauge, Loader2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { AdvancedVideoComponentSettings, AdvancedVideoState } from '../types';

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

type VideoDirectionalInputGroup = 'arrows' | 'forward-back';
type VideoDirectionalAction = 'navigate' | 'seek';

const videoDirectionalAction = (arrowKeyAction: AdvancedVideoComponentSettings['arrowKeyAction'], group: VideoDirectionalInputGroup): VideoDirectionalAction => {
  if (group === 'arrows') return arrowKeyAction === 'navigate' ? 'navigate' : 'seek';
  return arrowKeyAction === 'navigate' ? 'seek' : 'navigate';
};

const videoDirectionalKeyboardInput = (key: string): { direction: -1 | 1; group: VideoDirectionalInputGroup } | null => {
  if (key === 'ArrowLeft') return { direction: -1, group: 'arrows' };
  if (key === 'ArrowRight') return { direction: 1, group: 'arrows' };
  return null;
};

type AdvancedVideoPlayerProps = {
  filePath: string;
  poster?: string;
  onError: (message: string) => void;
  onMetadata: (metadata: { width?: number; height?: number; duration?: number }) => void;
  onNavigate?: (direction: -1 | 1) => void;
  onContextMenuAt?: (x: number, y: number) => void;
  onPointerActivity?: () => void;
  topRightOverlayHole?: number;
  onEscape?: () => void;
  bottomControls?: ReactNode;
  editorSeekRequest?: { id: number; time: number; pause?: boolean };
  onPlaybackState?: (state: { time: number; duration: number; paused: boolean }) => void;
  keyboardSettings?: AdvancedVideoComponentSettings;
};

const initialState = (): AdvancedVideoState => ({
  sessionId: '',
  type: 'loading',
  paused: true,
  buffering: true,
  volume: 100,
  muted: false,
  speed: 1,
  time: 0,
  duration: 0,
});

const hasVisibleExternalModal = (surface: HTMLElement | null) => {
  if (!surface) return false;
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].some(dialog => {
    if (dialog.contains(surface) || dialog.hidden || dialog.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(dialog);
    return style.display !== 'none' && style.visibility !== 'hidden' && dialog.getClientRects().length > 0;
  });
};

const AdvancedVideoPlayer = ({ filePath, poster, onError, onMetadata, onNavigate, onContextMenuAt, onPointerActivity, topRightOverlayHole = 0, onEscape, bottomControls, editorSeekRequest, onPlaybackState, keyboardSettings = { arrowKeyAction: 'seek' } }: AdvancedVideoPlayerProps) => {
  const navigate = onNavigate || (() => undefined);
  const showNavigation = Boolean(onNavigate);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const controlPanelRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef('');
  const errorReportedRef = useRef(false);
  const metadataKeyRef = useRef('');
  const onErrorRef = useRef(onError);
  const onMetadataRef = useRef(onMetadata);
  const onNavigateRef = useRef(navigate);
  const onContextMenuAtRef = useRef(onContextMenuAt);
  const onPointerActivityRef = useRef(onPointerActivity);
  const onEscapeRef = useRef(onEscape);
  const onPlaybackStateRef = useRef(onPlaybackState);
  const playbackPositionRef = useRef({ time: 0, duration: 0 });
  const nativeContextMenuOpenRef = useRef(false);
  onErrorRef.current = onError;
  onMetadataRef.current = onMetadata;
  onNavigateRef.current = navigate;
  onContextMenuAtRef.current = onContextMenuAt;
  onPointerActivityRef.current = onPointerActivity;
  onEscapeRef.current = onEscape;
  onPlaybackStateRef.current = onPlaybackState;
  const [sessionId, setSessionId] = useState('');
  const [starting, setStarting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureNotice, setCaptureNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [controlPanel, setControlPanel] = useState<'speed' | 'volume' | null>(null);
  const [coveredByModal, setCoveredByModal] = useState(false);
  const [state, setState] = useState<AdvancedVideoState>(initialState);

  useEffect(() => {
    let frame = 0;
    const inspect = () => {
      frame = 0;
      setCoveredByModal(current => {
        const next = hasVisibleExternalModal(surfaceRef.current);
        return current === next ? current : next;
      });
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(inspect);
    };
    inspect();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden', 'aria-modal', 'class', 'hidden', 'role', 'style'] });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let active = true;
    errorReportedRef.current = false;
    metadataKeyRef.current = '';
    setStarting(true);
    setSessionId('');
    setCapturing(false);
    setCaptureNotice(null);
    setControlPanel(null);
    setState(initialState());
    const unsubscribe = window.electronAPI.onAdvancedVideoState(update => {
      if (update.sessionId !== sessionRef.current) return;
      if (update.type === 'navigate') {
        onNavigateRef.current(update.direction === -1 ? -1 : 1);
        return;
      }
      if (update.type === 'context-menu') {
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (rect) {
          nativeContextMenuOpenRef.current = true;
          if (sessionRef.current) window.electronAPI.setAdvancedVideoBounds(sessionRef.current, { x: 0, y: 0, width: 0, height: 0, visible: false });
          onContextMenuAtRef.current?.(rect.left + Number(update.x || 0), rect.top + Number(update.y || 0));
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
      if (update.type === 'fatal' || update.type === 'error') {
        if (!errorReportedRef.current) {
          errorReportedRef.current = true;
          onErrorRef.current(update.error || '高级视频解码失败');
        }
        return;
      }
      if (update.type === 'loading') setState(current => ({ ...current, ...update, buffering: true }));
      else if (update.type === 'file-loaded') {
        setStarting(false);
        setState(current => ({ ...current, ...update, buffering: false }));
      } else if (update.type === 'ended') setState(current => ({ ...current, ...update, paused: true, time: current.duration || current.time }));
      else {
        if (update.type === 'state' && update.buffering === false) setStarting(false);
        setState(current => ({ ...current, ...update }));
      }
    });
    void window.electronAPI.startAdvancedVideo(filePath, keyboardSettings.arrowKeyAction).then(result => {
      if (!result.success || !result.sessionId) {
        if (active && !errorReportedRef.current) {
          errorReportedRef.current = true;
          onErrorRef.current(result.error || '高级视频解码组件无法启动');
        }
        return;
      }
      if (!active) {
        void window.electronAPI.stopAdvancedVideo(result.sessionId);
        return;
      }
      sessionRef.current = result.sessionId;
      setSessionId(result.sessionId);
    });
    return () => {
      active = false;
      unsubscribe();
      const currentSession = sessionRef.current;
      sessionRef.current = '';
      if (currentSession) {
        window.electronAPI.setAdvancedVideoBounds(currentSession, { x: 0, y: 0, width: 0, height: 0, visible: false });
        void window.electronAPI.stopAdvancedVideo(currentSession);
      }
    };
  }, [filePath, keyboardSettings.arrowKeyAction]);

  useEffect(() => {
    if (!captureNotice) return;
    const timer = window.setTimeout(() => setCaptureNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [captureNotice]);

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
    const cornerSize = Math.max(0, Math.min(rect.width, rect.height, topRightOverlayHole));
    const cornerOverlayHole = cornerSize > 0 ? {
      x: Math.round((rect.width - cornerSize) * scale),
      y: 0,
      width: Math.round(cornerSize * scale),
      height: Math.round(cornerSize * scale),
    } : undefined;
    const visible = !coveredByModal && !nativeContextMenuOpenRef.current && document.visibilityState === 'visible' && rect.width > 1 && rect.height > 1
      && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    window.electronAPI.setAdvancedVideoBounds(sessionRef.current, {
      x: Math.round(rect.left * scale),
      y: Math.round(rect.top * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
      visible,
      overlayHole,
      cornerOverlayHole,
    });
  }, [coveredByModal, topRightOverlayHole]);

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
  }, [controlPanel, sessionId, syncBounds]);

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

  const control = (action: 'play' | 'pause' | 'seek' | 'volume' | 'mute' | 'speed' | 'stop', value?: number | boolean) => {
    if (!sessionRef.current) return;
    window.electronAPI.controlAdvancedVideo(sessionRef.current, { action, value });
  };
  const paused = state.paused !== false;
  const duration = Math.max(0, Number(state.duration) || 0);
  const time = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(state.time) || 0));
  playbackPositionRef.current = { time, duration };
  const speed = Math.max(0.25, Math.min(4, Number(state.speed) || 1));
  const muted = Boolean(state.muted);
  const volume = Math.max(0, Math.min(100, Number(state.volume) || 0));
  const togglePlayback = () => control(paused ? 'play' : 'pause');
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
    window.electronAPI.controlAdvancedVideo(sessionRef.current, {
      action: 'seek',
      value: Math.max(0, Math.min(current.duration || Number.MAX_SAFE_INTEGER, current.time + seconds)),
    });
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
    const runDirectionalAction = (direction: -1 | 1, group: VideoDirectionalInputGroup) => {
      if (videoDirectionalAction(keyboardSettings.arrowKeyAction, group) === 'navigate') onNavigateRef.current(direction);
      else seekRelative(direction * SKIP_SECONDS);
    };
    const handleDirectionalKey = (event: KeyboardEvent) => {
      const input = videoDirectionalKeyboardInput(event.key);
      if (!input) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      runDirectionalAction(input.direction, input.group);
    };
    window.addEventListener('keydown', handleDirectionalKey);
    return () => {
      window.removeEventListener('keydown', handleDirectionalKey);
    };
  }, [keyboardSettings.arrowKeyAction, seekRelative]);
  const captureFrame = async () => {
    const currentSession = sessionRef.current;
    if (!currentSession || capturing) return;
    setCapturing(true);
    setCaptureNotice(null);
    try {
      const result = await window.electronAPI.captureAdvancedVideoFrame(currentSession);
      setCaptureNotice(result.success
        ? { text: '当前帧已保存' }
        : { text: result.error || '截图失败', error: true });
    } catch (error) {
      setCaptureNotice({ text: error instanceof Error ? error.message : '截图失败', error: true });
    } finally {
      setCapturing(false);
    }
  };

  const forwardBackAction = videoDirectionalAction(keyboardSettings.arrowKeyAction, 'forward-back');
  const runForwardBackControl = (direction: -1 | 1) => {
    if (forwardBackAction === 'navigate') onNavigateRef.current(direction);
    else seekRelative(direction * SKIP_SECONDS);
  };
  const backwardControlLabel = forwardBackAction === 'navigate' ? '上一个视频' : '快退 5 秒';
  const forwardControlLabel = forwardBackAction === 'navigate' ? '下一个视频' : '快进 5 秒';

  return <div className="absolute inset-0 flex min-h-0 flex-col bg-black">
    <div
      ref={surfaceRef}
      role="button"
      tabIndex={0}
      aria-label={paused ? '播放视频' : '暂停视频'}
      title="单击播放或暂停"
      onClick={togglePlayback}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          togglePlayback();
        }
      }}
      className="relative min-h-0 flex-1 cursor-pointer bg-black bg-contain bg-center bg-no-repeat outline-none"
      style={poster ? { backgroundImage: `url(${JSON.stringify(poster).slice(1, -1)})` } : undefined}
    />
    {bottomControls || <div className="relative z-20 flex h-12 shrink-0 items-center gap-1 border-t border-white/10 bg-[#070b15] px-2 text-white">
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
    </div>}
  </div>;
};

export { AdvancedVideoPlayer, videoDirectionalAction, videoDirectionalKeyboardInput };
