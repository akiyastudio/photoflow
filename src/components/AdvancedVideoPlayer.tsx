import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ChevronUp, Loader2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { AdvancedVideoState } from '../types';

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

type AdvancedVideoPlayerProps = {
  filePath: string;
  poster?: string;
  onError: (message: string) => void;
  onMetadata: (metadata: { width?: number; height?: number; duration?: number }) => void;
  onNavigate?: (direction: -1 | 1) => void;
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

const AdvancedVideoPlayer = ({ filePath, poster, onError, onMetadata, onNavigate }: AdvancedVideoPlayerProps) => {
  const navigate = onNavigate || (() => undefined);
  const showNavigation = Boolean(onNavigate);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef('');
  const errorReportedRef = useRef(false);
  const metadataKeyRef = useRef('');
  const onErrorRef = useRef(onError);
  const onMetadataRef = useRef(onMetadata);
  const onNavigateRef = useRef(navigate);
  const playbackPositionRef = useRef({ time: 0, duration: 0 });
  onErrorRef.current = onError;
  onMetadataRef.current = onMetadata;
  onNavigateRef.current = navigate;
  const [sessionId, setSessionId] = useState('');
  const [starting, setStarting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureNotice, setCaptureNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [state, setState] = useState<AdvancedVideoState>(initialState);

  useEffect(() => {
    let active = true;
    errorReportedRef.current = false;
    metadataKeyRef.current = '';
    setStarting(true);
    setSessionId('');
    setCapturing(false);
    setCaptureNotice(null);
    setState(initialState());
    const unsubscribe = window.electronAPI.onAdvancedVideoState(update => {
      if (update.sessionId !== sessionRef.current) return;
      if (update.type === 'navigate') {
        onNavigateRef.current(update.direction === -1 ? -1 : 1);
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
    void window.electronAPI.startAdvancedVideo(filePath).then(result => {
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
  }, [filePath]);

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
    const visible = document.visibilityState === 'visible' && rect.width > 1 && rect.height > 1
      && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    window.electronAPI.setAdvancedVideoBounds(sessionRef.current, {
      x: Math.round(rect.left * scale),
      y: Math.round(rect.top * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
      visible,
    });
  }, []);

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
  const seekRelative = useCallback((seconds: number) => {
    if (!sessionRef.current) return;
    const current = playbackPositionRef.current;
    window.electronAPI.controlAdvancedVideo(sessionRef.current, {
      action: 'seek',
      value: Math.max(0, Math.min(current.duration || Number.MAX_SAFE_INTEGER, current.time + seconds)),
    });
  }, []);
  useEffect(() => {
    const handleSeekKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      seekRelative(event.key === 'ArrowRight' ? SKIP_SECONDS : -SKIP_SECONDS);
    };
    window.addEventListener('keydown', handleSeekKey);
    return () => window.removeEventListener('keydown', handleSeekKey);
  }, [seekRelative]);
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
    <div className="flex h-12 shrink-0 items-center gap-1 border-t border-white/10 bg-[#070b15] px-2 text-white">
        {showNavigation && <button type="button" onClick={() => onNavigateRef.current(-1)} title="上一个视频" aria-label="上一个视频" className="rounded p-1.5 text-slate-100 hover:bg-white/10"><SkipBack size={16}/></button>}
        <button type="button" disabled={!sessionId} onClick={togglePlayback} title={paused ? '播放' : '暂停'} aria-label={paused ? '播放' : '暂停'} className="rounded p-1.5 text-slate-100 hover:bg-white/10 disabled:opacity-40">{paused ? <Play size={17} fill="currentColor"/> : <Pause size={17} fill="currentColor"/>}</button>
        {showNavigation && <button type="button" onClick={() => onNavigateRef.current(1)} title="下一个视频" aria-label="下一个视频" className="rounded p-1.5 text-slate-100 hover:bg-white/10"><SkipForward size={16}/></button>}
        <span className="w-10 text-right text-[11px] tabular-nums text-slate-300">{formatTime(time)}</span>
        <input type="range" min={0} max={Math.max(0.01, duration)} step={0.01} value={Math.min(time, Math.max(0.01, duration))} disabled={!duration} onChange={event => control('seek', Number(event.currentTarget.value))} aria-label="播放进度" className="min-w-12 flex-1 accent-blue-500 disabled:opacity-40"/>
        <span className="w-10 text-[11px] tabular-nums text-slate-300">{formatTime(duration)}</span>
        <div className="relative shrink-0">
          <select
            disabled={!sessionId}
            value={speed}
            onChange={event => control('speed', Number(event.currentTarget.value))}
            title="选择播放速度"
            aria-label={`当前播放速度 ${speed} 倍`}
            className="h-7 min-w-12 cursor-pointer appearance-none rounded border-0 bg-white/10 py-0 pl-2 pr-5 text-[11px] font-semibold tabular-nums text-slate-200 outline-none hover:bg-white/15 focus:ring-1 focus:ring-blue-400 disabled:cursor-default disabled:opacity-40"
          >
            {PLAYBACK_SPEEDS.map(value => <option key={value} value={value} className="bg-[#10192c] text-white">{value}×</option>)}
          </select>
          <ChevronUp aria-hidden="true" size={12} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400"/>
        </div>
        <button type="button" disabled={!sessionId || starting || capturing} onClick={() => void captureFrame()} title="截取当前视频帧并保存到原视频目录" aria-label="截取当前视频帧" className="rounded p-1.5 text-slate-200 hover:bg-white/10 disabled:opacity-40">{capturing ? <Loader2 size={16} className="animate-spin"/> : <Camera size={16}/>}</button>
        <button type="button" onClick={() => control('mute', !muted)} title={muted ? '取消静音' : '静音'} aria-label={muted ? '取消静音' : '静音'} className="rounded p-1.5 text-slate-200 hover:bg-white/10">{muted || volume === 0 ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button>
        <input type="range" min={0} max={100} step={1} value={muted ? 0 : volume} onChange={event => control('volume', Number(event.currentTarget.value))} aria-label="音量" className="w-14 accent-blue-500"/>
        {(starting || state.buffering) && <span role="status" className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-blue-200"><Loader2 size={13} className="animate-spin"/>加载中</span>}
        {captureNotice && <span role="status" aria-live="polite" title={captureNotice.text} className={`max-w-24 truncate whitespace-nowrap text-[11px] ${captureNotice.error ? 'text-red-300' : 'text-emerald-300'}`}>{captureNotice.text}</span>}
    </div>
  </div>;
};

export { AdvancedVideoPlayer };
