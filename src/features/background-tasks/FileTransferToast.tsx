import { Loader2 } from 'lucide-react';
import { useTaskCenter } from './TaskCenter';

const formatBytes = (value: number) => value >= 1024 ** 3
  ? `${(value / 1024 ** 3).toFixed(1)} GB`
  : value >= 1024 ** 2
    ? `${(value / 1024 ** 2).toFixed(1)} MB`
    : value >= 1024
      ? `${Math.round(value / 1024)} KB`
      : `${value} B`;

export const FileTransferToast = () => {
  const { backgroundTasks } = useTaskCenter();
  const task = backgroundTasks.find(candidate => candidate.type === 'project-file-operation'
    && (candidate.metadata?.operation === 'paste' || candidate.metadata?.operation === 'import' || candidate.metadata?.operation === 'import-project')
    && (candidate.state === 'queued' || candidate.state === 'running'));
  if (!task) return null;

  const metadata = task.metadata || {};
  const filesCopied = Number(metadata.filesCopied || 0);
  const totalFiles = Number(metadata.totalFiles || 0);
  const bytesCopied = Number(metadata.bytesCopied || 0);
  const totalBytes = Number(metadata.totalBytes || 0);
  const progress = Math.max(0, Math.min(100, task.progress || 0));
  const message = task.state === 'queued' ? '正在等待可用的磁盘任务…' : task.message || '正在准备文件传输…';
  const details = [
    totalFiles > 0 ? `${filesCopied}/${totalFiles} 个文件` : '',
    totalBytes > 0 ? `${formatBytes(bytesCopied)}/${formatBytes(totalBytes)}` : '',
  ].filter(Boolean).join(' · ');

  return <div role="status" aria-live="polite" className="fixed left-1/2 top-10 z-[510] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 shadow-xl animate-in fade-in slide-in-from-top-2">
    <div className="flex min-w-0 items-center gap-3">
      <Loader2 size={16} className="shrink-0 animate-spin text-blue-600"/>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3 text-xs"><span className="truncate font-bold text-blue-800">{message}</span><span className="shrink-0 font-mono font-bold tabular-nums text-blue-700">{Math.round(progress)}%</span></div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width] duration-150" style={{ width: `${Math.max(2, progress)}%` }}/></div>
        <p className="mt-1 text-[11px] tabular-nums text-blue-600">{details || '文件准备完成后会自动显示；可以继续使用软件。'}</p>
      </div>
      {task.cancellable && <button type="button" onClick={() => void window.electronAPI.cancelBackgroundTask(task.id)} className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50">取消</button>}
    </div>
  </div>;
};
