import { useLayoutEffect, useRef } from 'react';
import { Clock3, Loader2, Minimize2 } from 'lucide-react';
import type { BackgroundTask } from '../../types';
import { useTaskCenter } from './TaskCenter';
import { selectProjectFileTaskToasts } from './task-toast-model';

const formatBytes = (value: number) => value >= 1024 ** 3
  ? `${(value / 1024 ** 3).toFixed(1)} GB`
  : value >= 1024 ** 2
    ? `${(value / 1024 ** 2).toFixed(1)} MB`
    : value >= 1024
      ? `${Math.round(value / 1024)} KB`
      : `${value} B`;

export const FileTransferToastItem = ({ task, onMinimize }: { task: BackgroundTask; onMinimize: (id: string) => void }) => {
  const metadata = task.metadata || {};
  const filesCopied = Number(metadata.filesCopied ?? metadata.processedCount ?? 0);
  const totalFiles = Number(metadata.totalFiles ?? metadata.totalCount ?? 0);
  const operation = String(metadata.operation || '');
  const countUnit = metadata.filesCopied !== undefined || metadata.totalFiles !== undefined || ['copy', 'paste', 'import', 'import-project'].includes(operation) ? '文件' : '项';
  const bytesCopied = Number(metadata.bytesCopied || 0);
  const totalBytes = Number(metadata.totalBytes || 0);
  const progress = Math.max(0, Math.min(100, task.progress || 0));
  const queued = task.state === 'queued';
  const message = queued ? '等待磁盘任务名额' : task.message || '正在准备文件传输…';
  const details = [
    totalFiles > 0 ? `${filesCopied}/${totalFiles} ${countUnit}` : '',
    totalBytes > 0 ? `${formatBytes(bytesCopied)}/${formatBytes(totalBytes)}` : '',
  ].filter(Boolean).join(' · ');

  return <div role="status" data-top-toast-id={`task:${task.id}`} className="file-transfer-toast">
    <div className="flex min-w-0 items-center gap-3">
      {queued ? <Clock3 size={16} className="shrink-0 text-blue-600"/> : <Loader2 size={16} className="shrink-0 animate-spin text-blue-600"/>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3 text-xs"><span className="truncate font-bold text-blue-800">{message}</span>{!queued && <span className="shrink-0 font-mono font-bold tabular-nums text-blue-700">{Math.round(progress)}%</span>}</div>
        {!queued && <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width] duration-150" style={{ width: `${Math.max(2, progress)}%` }}/></div>}
        <p className="mt-1 line-clamp-1 text-[11px] tabular-nums text-blue-600">{queued ? task.title : details || '文件准备完成后会自动显示；可以继续使用软件。'}</p>
      </div>
      <button type="button" onClick={() => onMinimize(task.id)} aria-label="收起到任务中心" title="收起到任务中心，任务会继续运行" className="inline-flex shrink-0 items-center gap-1 rounded-md border border-blue-200 bg-white/70 px-2 py-1.5 text-xs font-bold text-blue-700 transition hover:border-blue-300 hover:bg-blue-100"><Minimize2 size={14}/><span>后台</span></button>
      {task.cancellable && <button type="button" onClick={() => void window.electronAPI.cancelBackgroundTask(task.id)} className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50">取消</button>}
    </div>
  </div>;
};

export const FileTransferToast = ({ stackRef }: { stackRef: React.RefObject<HTMLDivElement | null> }) => {
  const { backgroundTasks, isTaskToastMinimized, minimizeTaskToast } = useTaskCenter();
  const previousPositionsRef = useRef(new Map<string, number>());
  const minimizedTaskIds = new Set(backgroundTasks.filter(task => isTaskToastMinimized(task.id)).map(task => task.id));
  const { visible: visibleTasks, overflowCount } = selectProjectFileTaskToasts(backgroundTasks, minimizedTaskIds);

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
    {visibleTasks.map(task => <FileTransferToastItem key={task.id} task={task} onMinimize={minimizeTaskToast}/>)}
    {overflowCount > 0 && <div data-top-toast-id="task-overflow" className="file-transfer-toast-overflow">还有 {overflowCount} 个任务</div>}
  </>;
};
