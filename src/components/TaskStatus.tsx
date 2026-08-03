import React, { useEffect } from 'react';
import type { LogEntry } from '../types';
import { ProgressBar } from './ProgressBar';
import { usePanelTaskReporter } from '../features/background-tasks/TaskCenter';

interface TaskProgressProps {
  logs: LogEntry[];
  progress: number;
  isRunning: boolean;
  idleMessage?: string;
  action?: React.ReactNode;
  reportToTaskCenter?: boolean;
}

/** Shared execution area used by every tool. The newest script output is the status title. */
export const TaskProgress: React.FC<TaskProgressProps> = ({
  logs,
  progress,
  isRunning,
  idleMessage = '进度',
  action,
  reportToTaskCenter = true,
}) => {
  const latest = logs[logs.length - 1];
  const message = latest?.message || (progress >= 100 ? '处理完成' : idleMessage);
  const color = latest?.type === 'error' ? 'text-red-500' : latest?.type === 'success' || progress >= 100 ? 'text-emerald-600' : latest?.type === 'warning' ? 'text-amber-600' : 'text-slate-800';
  const percentage = Math.min(100, Math.max(0, progress));
  const reporter = usePanelTaskReporter();
  const latestType = latest?.type;

  useEffect(() => {
    if (!reporter || !reportToTaskCenter) return;
    reporter({
      state: isRunning ? 'running' : latestType === 'error' ? 'failed' : percentage >= 100 ? 'completed' : 'idle',
      progress: percentage,
      message,
      logs,
    });
  }, [isRunning, latestType, logs, message, percentage, reporter, reportToTaskCenter]);

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-4" aria-live="polite" aria-busy={isRunning}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between gap-4 text-sm">
            <p className={`min-w-0 truncate font-medium ${color}`} title={message} role="status">{message}</p>
            <span className="shrink-0 font-mono text-blue-600">{percentage.toFixed(Number.isInteger(percentage) ? 0 : 1)}%</span>
          </div>
          <ProgressBar value={percentage} trackClassName="h-2 overflow-hidden rounded-full bg-slate-200" barClassName="h-full rounded-full bg-blue-500 transition-all duration-300"/>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </section>
  );
};
