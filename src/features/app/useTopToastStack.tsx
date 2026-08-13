import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { FileTransferToast } from '../background-tasks/FileTransferToast';
import { enqueueTopToastNotice, removeTopToastNotice, type TopToastNotice } from './top-toast-notice-model';

export const useTopToastStack = () => {
  const [notices, setNotices] = useState<TopToastNotice[]>([]);
  const timersRef = useRef(new Map<number, number>());
  const sequenceRef = useRef(0);
  const lastNoticeRef = useRef({ message: '', shownAt: 0 });
  const stackRef = useRef<HTMLDivElement>(null);

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
    setNotices(current => enqueueTopToastNotice(current, { id, message: cleanMessage, persistent: isFailure, count: 1 }));
    if (!isFailure) timersRef.current.set(id, window.setTimeout(() => dismissNotice(id), duration));
    return () => dismissNotice(id);
  }, [dismissNotice]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const topToastStack = <div ref={stackRef} className="top-toast-stack" aria-live="polite" aria-relevant="additions removals">
    {notices.map(notice => <div key={notice.id} data-top-toast-id={`notice:${notice.id}`} className="app-notice-toast animate-in fade-in slide-in-from-top-2">
      <span>{notice.message}{notice.count > 1 && <span className="ml-2 text-xs font-bold text-slate-300">×{notice.count}</span>}</span><button onClick={() => dismissNotice(notice.id)} aria-label="关闭提示" className="rounded p-0.5 text-slate-300 hover:bg-white/15 hover:text-white"><X size={15}/></button>
    </div>)}
    <FileTransferToast stackRef={stackRef}/>
  </div>;

  return { showNotice, topToastStack };
};
