import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock3, Loader2, Minimize2, Pause, Play, X, XCircle } from 'lucide-react';
import type { BackgroundTask } from '../../types';
import { useTaskCenter } from './TaskCenter';
import { selectProjectFileTaskToasts, taskToastExpiresAt } from './task-toast-model';

const formatBytes = (value: number) => value >= 1024 ** 3
  ? `${(value / 1024 ** 3).toFixed(1)} GB`
  : value >= 1024 ** 2
    ? `${(value / 1024 ** 2).toFixed(1)} MB`
    : value >= 1024
      ? `${Math.round(value / 1024)} KB`
      : `${value} B`;

export const FileTransferToastItem = ({ task, onMinimize, onDismiss }: { task: BackgroundTask; onMinimize: (id: string) => void; onDismiss: (id: string) => void }) => {
  const metadata = task.metadata || {};
  const filesCopied = Number(metadata.filesCopied ?? metadata.processedCount ?? 0);
  const totalFiles = Number(metadata.totalFiles ?? metadata.totalCount ?? 0);
  const operation = String(metadata.operation || '');
  const countUnit = metadata.filesCopied !== undefined || metadata.totalFiles !== undefined || ['copy', 'paste', 'import', 'import-project'].includes(operation) ? '文件' : '项';
  const bytesCopied = Number(metadata.bytesCopied || 0);
  const totalBytes = Number(metadata.totalBytes || 0);
  const progress = Math.max(0, Math.min(100, task.progress || 0));
  const queued = task.state === 'queued';
  const resuming = task.state === 'resuming';
  const paused = task.state === 'paused';
  const pausing = task.state === 'pausing';
  const failed = task.state === 'failed';
  const completed = task.state === 'completed';
  const versionTracking = task.type === 'version-tracking';
  const message = failed ? task.error || task.message || '任务失败' : completed ? task.message || '任务已完成' : queued
    ? task.message || '等待其他文件操作完成'
    : paused ? '已暂停' : pausing ? '正在暂停…' : task.message || (resuming ? '正在继续任务…' : versionTracking ? '正在准备版本比较…' : '正在处理任务…');
  const details = [
    totalFiles > 0 ? `${filesCopied}/${totalFiles} ${countUnit}` : '',
    totalBytes > 0 ? `${formatBytes(bytesCopied)}/${formatBytes(totalBytes)}` : '',
  ].filter(Boolean).join(' · ');
  const cancelTask = () => task.type === 'selection-operation'
    ? window.electronAPI.cancelSelectionOperation(String(task.metadata?.operationId || ''))
    : task.type === 'workspace-team-workflow'
      ? window.electronAPI.cancelTeamWorkflowGeneration(String(task.metadata?.operationId || ''))
      : window.electronAPI.cancelBackgroundTask(task.id);

  return <div role={failed ? 'alert' : 'status'} data-top-toast-id={`task:${task.id}`} className={`file-transfer-toast ${failed ? 'border-red-200 bg-red-50' : completed ? 'border-emerald-200 bg-emerald-50' : ''}`}>
    <div className="flex min-w-0 items-center gap-3">
      {failed ? <XCircle size={16} className="shrink-0 text-red-600"/> : completed ? <CheckCircle2 size={16} className="shrink-0 text-emerald-600"/> : queued ? <Clock3 size={16} className="shrink-0 text-blue-600"/> : paused || pausing ? <Pause size={16} className="shrink-0 text-amber-600"/> : <Loader2 size={16} className="shrink-0 animate-spin text-blue-600"/>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3 text-xs"><span className={`truncate font-bold ${failed ? 'text-red-800' : completed ? 'text-emerald-800' : 'text-blue-800'}`}>{message}</span>{!queued && !failed && !completed && <span className="shrink-0 font-mono font-bold tabular-nums text-blue-700">{Math.round(progress)}%</span>}</div>
        {!queued && !failed && !completed && <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width] duration-150" style={{ width: `${progress > 0 ? Math.max(2, progress) : 0}%` }}/></div>}
        <p className="mt-1 line-clamp-1 text-[11px] tabular-nums text-blue-600">{queued ? task.blockedByTaskIds?.length ? '占用任务结束后自动开始' : versionTracking ? '完成后自动开始版本比较' : '等待所需资源可用后自动开始' : details || (versionTracking ? '比较完成后可确认版本匹配' : task.title)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {failed || completed
          ? <button type="button" onClick={() => onDismiss(task.id)} aria-label="关闭通知" title="关闭通知" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"><X size={15}/></button>
          : <button type="button" onClick={() => onMinimize(task.id)} aria-label="收起到任务中心" title="收起到任务中心，任务会继续运行" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-blue-200 bg-white/70 text-blue-700 transition hover:border-blue-300 hover:bg-blue-100"><Minimize2 size={15}/></button>}
        {(task.state === 'running' || task.state === 'resuming') && task.capabilities.pausable && <button type="button" onClick={() => void window.electronAPI.pauseBackgroundTask(task.id)} aria-label="暂停任务" title="暂停任务" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-amber-700 transition hover:bg-amber-50"><Pause size={15}/></button>}
        {(paused || pausing) && task.capabilities.pausable && <button type="button" onClick={() => void window.electronAPI.continueBackgroundTask(task.id)} aria-label="继续任务" title="继续任务" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-blue-700 transition hover:bg-blue-50"><Play size={15}/></button>}
        {task.cancellable && <button type="button" onClick={() => void cancelTask()} aria-label="取消任务" title="取消任务" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-600 transition hover:bg-red-50"><X size={16}/></button>}
      </div>
    </div>
  </div>;
};

export const FileTransferToast = ({ stackRef }: { stackRef: React.RefObject<HTMLDivElement | null> }) => {
  const { backgroundTasks, dismissBackgroundTask, isTaskToastMinimized, minimizeTaskToast } = useTaskCenter();
  const [clock, setClock] = useState(() => Date.now());
  const previousPositionsRef = useRef(new Map<string, number>());
  const minimizedTaskIds = new Set(backgroundTasks.filter(task => isTaskToastMinimized(task.id)).map(task => task.id));
  const { visible: visibleTasks, overflowCount } = selectProjectFileTaskToasts(backgroundTasks, minimizedTaskIds, 4, clock);

  useEffect(() => {
    const currentTime = Date.now();
    const nextDue = backgroundTasks
      .filter(task => !isTaskToastMinimized(task.id))
      .map(task => task.state === 'queued' ? task.createdAt + 700 : taskToastExpiresAt(task))
      .filter(due => due > currentTime)
      .sort((left, right) => left - right)[0];
    if (!nextDue) return;
    const timer = window.setTimeout(() => setClock(Date.now()), nextDue - currentTime + 10);
    return () => window.clearTimeout(timer);
  }, [backgroundTasks, isTaskToastMinimized]);

  useEffect(() => { setClock(Date.now()); }, [backgroundTasks]);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const nextPositions = new Map<string, number>();
    for (const element of stack.querySelectorAll<HTMLElement>('[data-top-toast-id]')) {
      const id = element.dataset.topToastId;
      if (!id) continue;
      const top = element.getBoundingClientRect().top;
      nextPositions.set(id, top);
      const previousTop = previousPositionsRef.current.get(id);
      if (previousTop === undefined || Math.abs(previousTop - top) < 1) continue;
      element.animate([{ transform: `translateY(${previousTop - top}px)` }, { transform: 'translateY(0)' }], { duration: 200, easing: 'ease-out' });
    }
    previousPositionsRef.current = nextPositions;
  });

  if (!visibleTasks.length) return null;

  return <>
    {visibleTasks.map(task => <FileTransferToastItem key={task.id} task={task} onMinimize={minimizeTaskToast} onDismiss={id => void dismissBackgroundTask(id)}/>)}
    {overflowCount > 0 && <div data-top-toast-id="task-overflow" className="file-transfer-toast-overflow">还有 {overflowCount} 个任务</div>}
  </>;
};
