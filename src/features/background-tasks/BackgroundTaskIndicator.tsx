import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, RotateCcw, X } from 'lucide-react';
import { ProgressBar } from '../../components/ProgressBar';
import type { BackgroundTask } from '../../types';
import { useTaskCenter } from './TaskCenter';
import { panelTaskRestoreDetail } from './panel-task-session-model';
import { isPointerInsideTaskIndicator } from './task-toast-model';

const isVisible = (task: BackgroundTask) => task.state === 'queued' || task.state === 'running' || task.state === 'failed'
  || (task.type === 'version-tracking' && (task.state === 'completed' || task.state === 'cancelled'));
const formatBytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
const taskSummary = (task: BackgroundTask) => {
  const metadata = task.metadata || {};
  const completed = Number(metadata.filesCopied ?? metadata.processedCount ?? 0);
  const total = Number(metadata.totalFiles ?? metadata.totalCount ?? 0);
  const copiedBytes = Number(metadata.bytesCopied ?? 0);
  const totalBytes = Number(metadata.totalBytes ?? 0);
  const parts: string[] = [];
  if (total > 0) parts.push(`${completed}/${total} 项`);
  if (totalBytes > 0) parts.push(`${formatBytes(copiedBytes)}/${formatBytes(totalBytes)}`);
  return parts.join(' · ');
};

export const BackgroundTaskIndicator = ({ ownerPageIds }: { ownerPageIds: ReadonlySet<string> }) => {
  const { backgroundTasks: tasks, panelTasks, dismissPanelTask, dismissBackgroundTask, isTaskToastMinimized, restoreTaskToast } = useTaskCenter();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || isPointerInsideTaskIndicator(triggerRef.current, panelRef.current, event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const visibleTasks = useMemo(() => tasks.filter(isVisible), [tasks]);
  const visiblePanelTasks = useMemo(() => Object.values(panelTasks).filter(task => task.state !== 'idle' && ownerPageIds.has(task.ownerPageId)).sort((left, right) => right.updatedAt - left.updatedAt), [ownerPageIds, panelTasks]);
  const runningCount = visibleTasks.filter(task => task.state === 'queued' || task.state === 'running').length + visiblePanelTasks.filter(task => task.state === 'running').length;
  const failedCount = visibleTasks.filter(task => task.state === 'failed').length + visiblePanelTasks.filter(task => task.state === 'failed').length;
  const visibleCount = visibleTasks.length + visiblePanelTasks.length;
  const restorePanelTask = (task: (typeof visiblePanelTasks)[number]) => {
    window.dispatchEvent(new CustomEvent('photoflow:restore-panel-task', { detail: panelTaskRestoreDetail(task.ownerPageId, task.panelKind) }));
    setOpen(false);
  };
  const cancelTask = (task: BackgroundTask) => window.electronAPI.cancelBackgroundTask(task.id);
  const showTaskProgress = (task: BackgroundTask) => {
    restoreTaskToast(task.id);
    setOpen(false);
  };
  const openTrackingConfirmation = (task: BackgroundTask) => {
    const sessionId = String(task.metadata?.sessionId || '');
    if (!sessionId) return;
    window.dispatchEvent(new CustomEvent('photoflow:open-tracking-confirmation', {
      detail: { sessionId, progressId: String(task.metadata?.progressId || ''), taskId: task.id },
    }));
    setOpen(false);
  };
  if (!visibleCount && !open) return null;

  return <div className="app-titlebar-control relative flex shrink-0 items-center px-1">
    <button ref={triggerRef} type="button" onClick={() => setOpen(value => !value)} title="后台任务" aria-label="后台任务" className={`relative flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${failedCount ? 'text-red-600 hover:bg-red-50' : 'text-slate-500 hover:bg-slate-100'}`}>
      <Activity size={15}/><span>{runningCount || failedCount || visibleCount}</span>
      {runningCount > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500"/>}
    </button>
    {open && <div ref={panelRef} className="absolute right-0 top-9 z-[500] w-80 rounded-xl border border-slate-200 bg-white p-2 shadow-2xl">
      <div className="flex items-center justify-between px-2 py-1.5"><strong className="text-sm text-slate-800">后台任务</strong><button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-slate-400 hover:bg-slate-100"><X size={14}/></button></div>
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {visibleCount === 0 && <p className="px-2 py-6 text-center text-xs text-slate-400">暂无进行中的任务</p>}
        {visiblePanelTasks.map(task => <div key={task.key} className="rounded-lg border border-slate-100 p-2.5">
          <button type="button" onClick={() => restorePanelTask(task)} className="block w-full text-left">
            <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-xs font-bold text-slate-700">{task.title}</span><span className={`shrink-0 text-[10px] ${task.state === 'failed' ? 'text-red-500' : task.state === 'completed' ? 'text-emerald-600' : 'text-blue-600'}`}>{task.state === 'failed' ? '失败' : task.state === 'completed' ? '已完成' : `${Math.round(task.progress)}%`}</span></div>
            <ProgressBar value={task.progress} minimumVisible={2} trackClassName="mt-2 h-1 overflow-hidden rounded-full bg-slate-100" barClassName={`h-full rounded-full ${task.state === 'failed' ? 'bg-red-500' : task.state === 'completed' ? 'bg-emerald-500' : 'bg-blue-500'}`}/>
            {task.message && <p className="mt-1.5 line-clamp-2 text-[11px] text-slate-500">{task.message}</p>}
          </button>
          <div className="mt-2 flex justify-end gap-1"><button type="button" onClick={() => restorePanelTask(task)} className="rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50">恢复面板</button>{task.state !== 'running' && <button type="button" onClick={() => dismissPanelTask(task.key)} className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100">清除</button>}</div>
        </div>)}
        {visibleTasks.map(task => <div key={task.id} className="rounded-lg border border-slate-100 p-2.5">
          <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-xs font-bold text-slate-700">{task.title}</span><span className={`shrink-0 text-[10px] ${task.state === 'failed' ? 'text-red-500' : 'text-slate-400'}`}>{task.state === 'failed' ? '失败' : task.state === 'queued' ? '等待中' : `${Math.round(task.progress)}%`}</span></div>
          <ProgressBar value={task.progress} minimumVisible={2} trackClassName="mt-2 h-1 overflow-hidden rounded-full bg-slate-100" barClassName={`h-full rounded-full ${task.state === 'failed' ? 'bg-red-500' : 'bg-blue-500'}`}/>
          {task.message && <p className="mt-1.5 line-clamp-2 text-[11px] text-slate-500">{task.message}</p>}
          {taskSummary(task) && <p className="mt-1 text-[10px] tabular-nums text-slate-400">{taskSummary(task)}</p>}
          <div className="mt-2 flex justify-end gap-1">
            {task.type === 'version-tracking' && (task.state === 'completed' || task.state === 'failed') && <button type="button" onClick={() => openTrackingConfirmation(task)} className="rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50">{task.state === 'failed' ? '恢复确认面板' : '打开确认面板'}</button>}
            {(task.state === 'queued' || task.state === 'running') && isTaskToastMinimized(task.id) && <button type="button" onClick={() => showTaskProgress(task)} className="rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50">显示进度</button>}
            {task.state === 'failed' && task.retryable && <button type="button" onClick={() => void window.electronAPI.retryBackgroundTask(task.id)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50"><RotateCcw size={11}/>重试</button>}
            {task.state === 'failed' && <button type="button" onClick={() => void dismissBackgroundTask(task.id)} className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100">清除</button>}
            {(task.state === 'completed' || task.state === 'cancelled') && <button type="button" onClick={() => void dismissBackgroundTask(task.id)} className="rounded px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100">清除</button>}
            {(task.state === 'queued' || task.state === 'running') && task.cancellable && <button type="button" onClick={() => void cancelTask(task)} className="rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-50">取消</button>}
          </div>
        </div>)}
      </div>
    </div>}
  </div>;
};
