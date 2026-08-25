import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useHostRendererToken } from '../../components/LayerProvider';
import { FileTransferToast } from '../background-tasks/FileTransferToast';
import { clearTopToastNoticeTimers, enqueueTopToastNoticeWithEvictions, purgeComponentTopToastNotices, removeTopToastNotice, type TopToastNotice } from './top-toast-notice-model';
import { hostNoticeTone, topToastTonePolicy, topToastTonePresentation } from './top-toast-tone-model';

export const useTopToastStack = () => {
  const [notices, setNotices] = useState<TopToastNotice[]>([]);
  const timersRef = useRef(new Map<number, number>());
  const sequenceRef = useRef(0);
  const lastNoticeRef = useRef({ message: '', shownAt: 0 });
  const stackRef = useRef<HTMLDivElement>(null);
  const rendererToken = useHostRendererToken();
  const readinessRevisionRef = useRef(0);

  const enqueueNotice = useCallback((notice: TopToastNotice) => {
    setNotices(current => {
      const result = enqueueTopToastNoticeWithEvictions(current, notice);
      clearTopToastNoticeTimers(timersRef.current, result.evictedIds, timer => window.clearTimeout(timer));
      return result.notices;
    });
  }, []);

  const dismissNotice = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(id);
    setNotices(current => removeTopToastNotice(current, id));
  }, []);

  const showNotice = useCallback((message: string, durationOrTone?: number | TopToastNotice['tone'], explicitTone?: TopToastNotice['tone']) => {
    const cleanMessage = message.trim() || '发生未知错误';
    const tone = explicitTone || (typeof durationOrTone === 'string' ? durationOrTone : undefined) || hostNoticeTone(cleanMessage);
    const policy = topToastTonePolicy(tone);
    const isFailure = policy.persistent;
    const now = Date.now();
    if (!isFailure && lastNoticeRef.current.message === cleanMessage && now - lastNoticeRef.current.shownAt < 800) return () => undefined;
    lastNoticeRef.current = { message: cleanMessage, shownAt: now };
    const id = ++sequenceRef.current;
    if (policy.durationMs !== null) timersRef.current.set(id, window.setTimeout(() => dismissNotice(id), policy.durationMs));
    enqueueNotice({ id, message: cleanMessage, persistent: policy.persistent, count: 1, tone });
    return () => dismissNotice(id);
  }, [dismissNotice, enqueueNotice]);

  const showComponentNotification = useCallback((value: { type: 'notification'; id: string; componentId: string; notification: { tone: 'info' | 'success' | 'warning' | 'error'; message: string } } | { type: 'purge'; componentId: string }) => {
    if (value.type === 'purge') {
      setNotices(current => {
        const removed = current.filter(notice => notice.sourceComponentId === value.componentId);
        clearTopToastNoticeTimers(timersRef.current, removed.map(notice => notice.id), timer => window.clearTimeout(timer));
        return purgeComponentTopToastNotices(current, value.componentId);
      });
      return;
    }
    const cleanMessage = value.notification.message.trim();
    if (!cleanMessage) return;
    const id = ++sequenceRef.current;
    const policy = topToastTonePolicy(value.notification.tone);
    if (policy.durationMs !== null) timersRef.current.set(id, window.setTimeout(() => dismissNotice(id), policy.durationMs));
    enqueueNotice({ id, message: cleanMessage, persistent: policy.persistent, count: 1, tone: value.notification.tone, sourceComponentId: value.componentId });
  }, [dismissNotice, enqueueNotice]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onComponentNotification(showComponentNotification);
    void window.electronAPI.setComponentNotificationReady({ rendererToken, revision: readinessRevisionRef.current++, ready: true });
    return () => { void window.electronAPI.setComponentNotificationReady({ rendererToken, revision: readinessRevisionRef.current++, ready: false }); unsubscribe(); };
  }, [rendererToken, showComponentNotification]);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    void window.electronAPI.updateToastOverlay({ html: stack.innerHTML, dark: document.documentElement.classList.contains('dark') }).catch(() => undefined);
  });

  useEffect(() => window.electronAPI.onToastOverlayAction(value => {
    if (value.action === 'notice-dismiss' && /^\d+$/.test(value.id)) dismissNotice(Number(value.id));
  }), [dismissNotice]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const topToastStack = <div ref={stackRef} className="top-toast-stack" data-host-toast-model aria-label="通知" aria-hidden="true">
    {notices.map(notice => { const presentation = topToastTonePresentation(notice.tone || 'info'); const ToneIcon = presentation.icon === 'check' ? CheckCircle2 : presentation.icon === 'warning' ? AlertTriangle : presentation.icon === 'error' ? XCircle : Info; return <div key={notice.id} data-top-toast-id={`notice:${notice.id}`} data-toast-tone={presentation.tone} role={presentation.role} aria-live={presentation.ariaLive} className="app-notice-toast animate-in fade-in slide-in-from-top-2">
      <ToneIcon size={16} aria-hidden="true" className="app-notice-toast__tone-icon shrink-0"/><span className="app-notice-toast__message">{notice.message}{notice.count > 1 && <span className="ml-2 text-xs font-bold text-slate-300">×{notice.count}</span>}</span><button data-toast-overlay-action="notice-dismiss" data-toast-overlay-id={String(notice.id)} onClick={() => dismissNotice(notice.id)} aria-label="关闭提示" className="rounded p-0.5 text-slate-300 hover:bg-white/15 hover:text-white"><X size={15}/></button>
    </div>; })}
    <FileTransferToast stackRef={stackRef}/>
  </div>;

  return { showNotice, topToastStack };
};
