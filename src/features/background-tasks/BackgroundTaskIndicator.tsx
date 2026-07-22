import { useEffect, useMemo, useState } from 'react';
import { Activity, RotateCcw, X } from 'lucide-react';
import type { BackgroundTask } from '../../types';

const isVisible = (task: BackgroundTask) => task.state === 'queued' || task.state === 'running' || task.state === 'failed';

export const BackgroundTaskIndicator = () => {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void window.electronAPI.getBackgroundTasks().then(result => {
      if (active && result.success) setTasks(result.tasks);
    });
    const unsubscribe = window.electronAPI.onBackgroundTaskChanged(task => {
      setTasks(current => [task, ...current.filter(item => item.id !== task.id)].slice(0, 50));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const visibleTasks = useMemo(() => tasks.filter(isVisible), [tasks]);
  const runningCount = visibleTasks.filter(task => task.state === 'queued' || task.state === 'running').length;
  const failedCount = visibleTasks.filter(task => task.state === 'failed').length;
  if (!visibleTasks.length && !open) return null;

  return <div className="app-titlebar-control relative flex shrink-0 items-center px-1">
    <button type="button" onClick={() => setOpen(value => !value)} title="后台任务" aria-label="后台任务" className={`relative flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${failedCount ? 'text-red-600 hover:bg-red-50' : 'text-slate-500 hover:bg-slate-100'}`}>
      <Activity size={15}/><span>{runningCount || failedCount}</span>
      {runningCount > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500"/>}
    </button>
    {open && <div className="absolute right-0 top-9 z-[500] w-80 rounded-xl border border-slate-200 bg-white p-2 shadow-2xl">
      <div className="flex items-center justify-between px-2 py-1.5"><strong className="text-sm text-slate-800">后台任务</strong><button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-slate-400 hover:bg-slate-100"><X size={14}/></button></div>
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {visibleTasks.length === 0 && <p className="px-2 py-6 text-center text-xs text-slate-400">暂无进行中的任务</p>}
        {visibleTasks.map(task => <div key={task.id} className="rounded-lg border border-slate-100 p-2.5">
          <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-xs font-bold text-slate-700">{task.title}</span><span className={`shrink-0 text-[10px] ${task.state === 'failed' ? 'text-red-500' : 'text-slate-400'}`}>{task.state === 'failed' ? '失败' : task.state === 'queued' ? '等待中' : `${Math.round(task.progress)}%`}</span></div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${task.state === 'failed' ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${Math.max(2, task.progress)}%` }}/></div>
          {task.message && <p className="mt-1.5 line-clamp-2 text-[11px] text-slate-500">{task.message}</p>}
          <div className="mt-2 flex justify-end gap-1">
            {task.state === 'failed' && task.retryable && <button type="button" onClick={() => void window.electronAPI.retryBackgroundTask(task.id)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50"><RotateCcw size={11}/>重试</button>}
            {(task.state === 'queued' || task.state === 'running') && task.cancellable && <button type="button" onClick={() => void window.electronAPI.cancelBackgroundTask(task.id)} className="rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-50">取消</button>}
          </div>
        </div>)}
      </div>
    </div>}
  </div>;
};
