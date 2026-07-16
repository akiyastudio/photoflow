import React from 'react';
import type { LogEntry } from '../types';

interface TaskProgressProps {
  logs: LogEntry[];
  progress: number;
  isRunning: boolean;
  idleMessage?: string;
  action?: React.ReactNode;
}

/** Shared execution area used by every tool. The newest script output is the status title. */
export const TaskProgress: React.FC<TaskProgressProps> = ({
  logs,
  progress,
  isRunning,
  idleMessage = '进度',
  action
}) => {
  const latest = logs[logs.length - 1];
  const message = latest?.message || (progress >= 100 ? '处理完成' : idleMessage);
  const color = latest?.type === 'error' ? 'text-red-500' : latest?.type === 'success' || progress >= 100 ? 'text-emerald-600' : latest?.type === 'warning' ? 'text-amber-600' : 'text-slate-800';
  const percentage = Math.min(100, Math.max(0, progress));

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-4" aria-live="polite" aria-busy={isRunning}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between gap-4 text-sm">
            <p className={`min-w-0 truncate font-medium ${color}`} title={message} role="status">{message}</p>
            <span className="shrink-0 font-mono text-blue-600">{percentage.toFixed(Number.isInteger(percentage) ? 0 : 1)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-blue-500 transition-all duration-300" style={{ width: `${percentage}%` }} />
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </section>
  );
};
