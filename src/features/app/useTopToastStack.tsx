import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useHostRendererToken } from '../../components/LayerProvider';
import { FileTransferToast } from '../background-tasks/FileTransferToast';
import { clearTopToastNoticeTimers, enqueueTopToastNoticeWithEvictions, purgeComponentTopToastNotices, removeTopToastNotice, type TopToastNotice } from './top-toast-notice-model';
import { topToastTonePresentation } from './top-toast-tone-model';
import { hostToastReservationBottom } from './top-toast-host-reservation-model';

export const useTopToastStack = () => {
  const [notices, setNotices] = useState<TopToastNotice[]>([]);
  const timersRef = useRef(new Map<number, number>());
  const sequenceRef = useRef(0);
  const lastNoticeRef = useRef({ message: '', shownAt: 0 });
  const stackRef = useRef<HTMLDivElement>(null);
  const rendererToken = useHostRendererToken();
  const reservationRevisionRef = useRef(0);
  const reservedBottomRef = useRef(-1);

  const reportToastReservation = useCallback((forcedBottom?: number) => {
    const stack = stackRef.current;
    const bottom = forcedBottom ?? hostToastReservationBottom(stack);
    if (bottom === reservedBottomRef.current) return;
    reservedBottomRef.current = bottom;
    void window.electronAPI.setHostToastReservation({ rendererToken, revision: reservationRevisionRef.current++, bottom });
  }, [rendererToken]);

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

  const showNotice = useCallback((message: string, duration = 3500) => {
    const cleanMessage = message.trim() || '发生未知错误';
    const isFailure = /失败|错误|异常|无法/.test(cleanMessage);
    const now = Date.now();
    if (!isFailure && lastNoticeRef.current.message === cleanMessage && now - lastNoticeRef.current.shownAt < 800) return () => undefined;
    lastNoticeRef.current = { message: cleanMessage, shownAt: now };
    const id = ++sequenceRef.current;
    enqueueNotice({ id, message: cleanMessage, persistent: isFailure, count: 1 });
    if (!isFailure) timersRef.current.set(id, window.setTimeout(() => dismissNotice(id), duration));
    return () => dismissNotice(id);
  }, [dismissNotice, enqueueNotice]);

  const showComponentNotification = useCallback((value: { type: 'notification'; id: string; componentId: string; notification: { tone: 'info' | 'success' | 'warning' | 'error'; message: string; durationMs: number } } | { type: 'purge'; componentId: string }) => {
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
    enqueueNotice({ id, message: cleanMessage, persistent: false, count: 1, tone: value.notification.tone, sourceComponentId: value.componentId });
    timersRef.current.set(id, window.setTimeout(() => dismissNotice(id), value.notification.durationMs));
  }, [dismissNotice, enqueueNotice]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onComponentNotification(showComponentNotification);
    void window.electronAPI.setComponentNotificationReady(true);
    return () => { void window.electronAPI.setComponentNotificationReady(false); unsubscribe(); };
  }, [showComponentNotification]);

  useLayoutEffect(() => { reportToastReservation(); });
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const observer = new ResizeObserver(() => reportToastReservation());
    const handleResize = () => reportToastReservation();
    observer.observe(stack);
    window.addEventListener('resize', handleResize);
    reportToastReservation();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
      reportToastReservation(0);
    };
  }, [reportToastReservation]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const topToastStack = <div ref={stackRef} className="top-toast-stack" aria-label="通知">
    {notices.map(notice => { const presentation = topToastTonePresentation(notice.tone || 'info'); const ToneIcon = presentation.icon === 'check' ? CheckCircle2 : presentation.icon === 'warning' ? AlertTriangle : presentation.icon === 'error' ? XCircle : Info; return <div key={notice.id} data-top-toast-id={`notice:${notice.id}`} data-toast-tone={presentation.tone} role={presentation.role} aria-live={presentation.ariaLive} className="app-notice-toast animate-in fade-in slide-in-from-top-2">
      <ToneIcon size={16} aria-hidden="true" className="app-notice-toast__tone-icon shrink-0"/><span>{notice.message}{notice.count > 1 && <span className="ml-2 text-xs font-bold text-slate-300">×{notice.count}</span>}</span><button onClick={() => dismissNotice(notice.id)} aria-label="关闭提示" className="rounded p-0.5 text-slate-300 hover:bg-white/15 hover:text-white"><X size={15}/></button>
    </div>; })}
    <FileTransferToast stackRef={stackRef}/>
  </div>;

  return { showNotice, topToastStack };
};
