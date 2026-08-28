import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useHostRendererToken } from '../../components/LayerProvider';
import { FileTransferToast, useFileTransferToastPresentation } from '../background-tasks/FileTransferToast';
import { clearTopToastNoticeTimers, purgeComponentTopToastNotices, removeTopToastNotice, upsertTopToastNotice, type TopToastNotice } from './top-toast-notice-model';
import { hostNoticeTone, topToastTonePolicy, topToastTonePresentation } from './top-toast-tone-model';

export type ToastTone = NonNullable<TopToastNotice['tone']>;
export type ToastLifecycle = 'auto' | 'persistent';
export interface ToastOptions { tone?: ToastTone; dedupeKey?: string; lifecycle?: ToastLifecycle; durationMs?: number }
export interface ToastUpdate extends ToastOptions { message?: string }
export interface ToastHandle { readonly id: number; update: (update: string | ToastUpdate) => void; dismiss: () => void }
export interface ToastActivityHandle extends ToastHandle {
  succeed: (message: string, options?: Omit<ToastOptions, 'dedupeKey'>) => void;
  fail: (message: string, options?: Omit<ToastOptions, 'dedupeKey'>) => void;
}
export interface ToastApi {
  show: (message: string, options?: ToastOptions | ToastTone | number) => ToastHandle;
  update: (idOrKey: number | string, update: string | ToastUpdate) => void;
  dismiss: (idOrKey: number | string) => void;
  activity: (message: string, options?: Omit<ToastOptions, 'tone'>) => ToastActivityHandle;
}

type ToastContextValue = { api: ToastApi; notices: TopToastNotice[]; stackRef: React.RefObject<HTMLDivElement> };
const ToastContext = createContext<ToastContextValue | null>(null);

const normalizeOptions = (message: string, options?: ToastOptions | ToastTone | number): ToastOptions => {
  if (typeof options === 'string') return { tone: options };
  if (typeof options === 'number') return { durationMs: options };
  return options || { tone: hostNoticeTone(message) };
};

export const TopToastProvider = ({ children }: { children: ReactNode }) => {
  const [notices, setNotices] = useState<TopToastNotice[]>([]);
  const noticesRef = useRef<TopToastNotice[]>([]);
  const timersRef = useRef(new Map<number, number>());
  const sequenceRef = useRef(0);
  const stackRef = useRef<HTMLDivElement>(null);
  const rendererToken = useHostRendererToken();
  const readinessRevisionRef = useRef(0);

  const commit = useCallback((updater: (current: TopToastNotice[]) => TopToastNotice[]) => {
    const next = updater(noticesRef.current);
    noticesRef.current = next;
    setNotices(next);
  }, []);
  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);
  const dismiss = useCallback((idOrKey: number | string) => {
    const target = typeof idOrKey === 'number' ? noticesRef.current.find(notice => notice.id === idOrKey) : noticesRef.current.find(notice => notice.dedupeKey === idOrKey);
    if (!target) return;
    clearTimer(target.id);
    commit(current => removeTopToastNotice(current, target.id));
  }, [clearTimer, commit]);
  const schedule = useCallback((id: number, options: ToastOptions, tone: ToastTone) => {
    clearTimer(id);
    const durationMs = options.lifecycle === 'persistent' ? null : options.durationMs ?? topToastTonePolicy(tone).durationMs;
    if (durationMs !== null) timersRef.current.set(id, window.setTimeout(() => dismiss(id), Math.max(500, durationMs)));
    return { persistent: durationMs === null };
  }, [clearTimer, dismiss]);
  const update = useCallback((idOrKey: number | string, value: string | ToastUpdate) => {
    const target = typeof idOrKey === 'number' ? noticesRef.current.find(notice => notice.id === idOrKey) : noticesRef.current.find(notice => notice.dedupeKey === idOrKey);
    if (!target) return;
    const patch = typeof value === 'string' ? { message: value } : value;
    const message = (patch.message ?? target.message).trim() || '发生未知错误';
    const tone = patch.tone || target.tone || hostNoticeTone(message);
    const lifecycle = patch.lifecycle || (target.persistent ? 'persistent' : 'auto');
    const policy = schedule(target.id, { ...patch, lifecycle }, tone);
    commit(current => current.map(notice => notice.id === target.id ? { ...notice, ...policy, message, tone, dedupeKey: patch.dedupeKey ?? notice.dedupeKey } : notice));
  }, [commit, schedule]);
  const show = useCallback((rawMessage: string, rawOptions?: ToastOptions | ToastTone | number): ToastHandle => {
    const message = rawMessage.trim() || '发生未知错误';
    const options = normalizeOptions(message, rawOptions);
    const tone = options.tone || hostNoticeTone(message);
    const existing = options.dedupeKey ? noticesRef.current.find(notice => notice.dedupeKey === options.dedupeKey) : undefined;
    if (existing) {
      update(existing.id, { ...options, message, tone, lifecycle: options.lifecycle || 'auto' });
      return { id: existing.id, update: value => update(existing.id, value), dismiss: () => dismiss(existing.id) };
    }
    const defaultDuration = topToastTonePolicy(tone).durationMs;
    const persistentDuplicate = !options.dedupeKey && (options.lifecycle === 'persistent' || (options.durationMs === undefined && defaultDuration === null))
      ? noticesRef.current.find(notice => notice.persistent && notice.message === message)
      : undefined;
    if (persistentDuplicate) {
      commit(current => current.map(notice => notice.id === persistentDuplicate.id ? { ...notice, count: notice.count + 1 } : notice));
      return { id: persistentDuplicate.id, update: value => update(persistentDuplicate.id, value), dismiss: () => dismiss(persistentDuplicate.id) };
    }
    const id = ++sequenceRef.current;
    const incoming: TopToastNotice = { id, message, tone, dedupeKey: options.dedupeKey, count: 1, ...schedule(id, options, tone) };
    commit(current => {
      const result = upsertTopToastNotice(current, incoming);
      clearTopToastNoticeTimers(timersRef.current, result.evictedIds, timer => window.clearTimeout(timer));
      return result.notices;
    });
    return { id, update: value => update(id, value), dismiss: () => dismiss(id) };
  }, [commit, dismiss, schedule, update]);
  const activity = useCallback((message: string, options: Omit<ToastOptions, 'tone'> = {}): ToastActivityHandle => {
    const handle = show(message, { ...options, tone: 'info', lifecycle: options.lifecycle || 'persistent' });
    return { ...handle,
      succeed: (next, nextOptions = {}) => update(handle.id, { ...nextOptions, message: next, tone: 'success', lifecycle: nextOptions.lifecycle || 'auto' }),
      fail: (next, nextOptions = {}) => update(handle.id, { ...nextOptions, message: next, tone: 'error', lifecycle: nextOptions.lifecycle || 'persistent' }),
    };
  }, [show, update]);
  const api = useMemo<ToastApi>(() => ({ show, update, dismiss, activity }), [activity, dismiss, show, update]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onComponentNotification(value => {
      if (value.type === 'purge') {
        commit(current => {
          const removed = current.filter(notice => notice.sourceComponentId === value.componentId);
          clearTopToastNoticeTimers(timersRef.current, removed.map(notice => notice.id), timer => window.clearTimeout(timer));
          return purgeComponentTopToastNotices(current, value.componentId);
        });
        return;
      }
      const dedupeKey = `component:${value.componentId}:${value.notification.dedupeKey || value.id}`;
      const existing = noticesRef.current.find(notice => notice.dedupeKey === dedupeKey);
      const handle = show(value.notification.message, { tone: value.notification.tone, dedupeKey });
      if (!existing) commit(current => current.map(notice => notice.id === handle.id ? { ...notice, sourceComponentId: value.componentId } : notice));
    });
    void window.electronAPI.setComponentNotificationReady({ rendererToken, revision: readinessRevisionRef.current++, ready: true });
    return () => { void window.electronAPI.setComponentNotificationReady({ rendererToken, revision: readinessRevisionRef.current++, ready: false }); unsubscribe(); };
  }, [commit, rendererToken, show]);
  useEffect(() => () => { for (const timer of timersRef.current.values()) window.clearTimeout(timer); timersRef.current.clear(); }, []);

  return <ToastContext.Provider value={{ api, notices, stackRef }}>{children}</ToastContext.Provider>;
};

// Provider, viewport, and hook deliberately share the same private Context so
// consumers cannot import or mount a second notification state container.
// eslint-disable-next-line react-refresh/only-export-components
export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside TopToastProvider');
  return context.api;
};

export const TopToastViewport = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('TopToastViewport must be used inside TopToastProvider');
  const { notices, stackRef } = context;
  const presentation = useFileTransferToastPresentation();
  const snapshotRevisionRef = useRef(0);
  const snapshotFrameRef = useRef<number | null>(null);
  const flushSnapshot = useCallback(() => {
    snapshotFrameRef.current = null;
    const stack = stackRef.current;
    const rect = stack?.getBoundingClientRect();
    const hasContent = Boolean(stack && stack.childElementCount > 0);
    const contentWidth = hasContent && stack ? Math.max(...Array.from(stack.children, child => Math.ceil(child.getBoundingClientRect().width)), 0) : 0;
    void window.electronAPI.updateToastView({
      revision: snapshotRevisionRef.current++,
      dark: document.documentElement.classList.contains('dark'),
      top: hasContent && rect ? Math.max(0, Math.round(rect.top)) : 0,
      width: contentWidth,
      height: hasContent && rect ? Math.max(0, Math.ceil(rect.height)) : 0,
      notices,
      tasks: presentation.visibleTasks,
      overflowCount: presentation.overflowCount,
    }).catch(() => undefined);
  }, [notices, presentation.overflowCount, presentation.visibleTasks, stackRef]);
  const scheduleSnapshot = useCallback(() => {
    if (snapshotFrameRef.current !== null) return;
    snapshotFrameRef.current = window.requestAnimationFrame(flushSnapshot);
  }, [flushSnapshot]);
  useLayoutEffect(scheduleSnapshot, [notices, presentation.overflowCount, presentation.visibleTasks, scheduleSnapshot]);
  useEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const observer = new ResizeObserver(scheduleSnapshot);
    observer.observe(stack);
    return () => observer.disconnect();
  }, [scheduleSnapshot, stackRef]);
  useEffect(() => window.electronAPI.onToastViewAction(value => {
    if (value.action === 'notice-dismiss' && /^\d+$/.test(value.id)) {
      context.api.dismiss(Number(value.id));
      return;
    }
    const task = presentation.visibleTasks.find(item => item.id === value.id);
    if (!task) return;
    if (value.action === 'task-dismiss') void presentation.dismissBackgroundTask(task.id);
    else if (value.action === 'task-minimize') presentation.minimizeTaskToast(task.id);
    else if (value.action === 'task-pause' && task.capabilities.pausable) void window.electronAPI.pauseBackgroundTask(task.id);
    else if (value.action === 'task-continue' && task.capabilities.pausable) void window.electronAPI.continueBackgroundTask(task.id);
    else if (value.action === 'task-cancel' && task.cancellable) {
      if (task.type === 'selection-operation') void window.electronAPI.cancelSelectionOperation(String(task.metadata?.operationId || ''));
      else void window.electronAPI.cancelBackgroundTask(task.id);
    }
  }), [context.api, presentation]);
  useEffect(() => () => {
    if (snapshotFrameRef.current !== null) window.cancelAnimationFrame(snapshotFrameRef.current);
    void window.electronAPI.updateToastView({ revision: snapshotRevisionRef.current++, dark: false, top: 0, width: 0, height: 0, notices: [], tasks: [], overflowCount: 0 }).catch(() => undefined);
  }, []);
  return <>
    <div ref={stackRef} className="top-toast-stack top-toast-stack--model" data-toast-view-model aria-hidden="true">
      {notices.map(notice => { const presentation = topToastTonePresentation(notice.tone || 'info'); const ToneIcon = presentation.icon === 'check' ? CheckCircle2 : presentation.icon === 'warning' ? AlertTriangle : presentation.icon === 'error' ? XCircle : Info; return <div key={notice.id} data-top-toast-id={`notice:${notice.id}`} data-toast-tone={presentation.tone} role={presentation.role} aria-live={presentation.ariaLive} className="app-notice-toast animate-in fade-in slide-in-from-top-2">
        <ToneIcon size={16} aria-hidden="true" className="app-notice-toast__tone-icon shrink-0"/><span className="app-notice-toast__message">{notice.message}{notice.count > 1 && <span className="ml-2 text-xs font-bold text-slate-300">×{notice.count}</span>}</span><button onClick={() => context.api.dismiss(notice.id)} aria-label="关闭提示" title="关闭提示" className="rounded p-0.5 text-slate-300 hover:bg-white/15 hover:text-white"><X size={15}/></button>
      </div>; })}
      <FileTransferToast stackRef={stackRef} presentation={presentation}/>
    </div>
  </>;
};
