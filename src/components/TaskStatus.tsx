import React from 'react';
import type { LogEntry } from '../types';

interface TaskStatusProps {
  logs: LogEntry[];
}

export const TaskStatus: React.FC<TaskStatusProps> = ({ logs }) => {
  const latest = logs[logs.length - 1];
  if (!latest) return null;
  const color = latest.type === 'error' ? 'text-red-500' : latest.type === 'success' ? 'text-emerald-600' : latest.type === 'warning' ? 'text-amber-600' : 'text-slate-500';
  return <p className={`mt-4 min-h-5 text-sm ${color}`} role="status" aria-live="polite">{latest.message}</p>;
};
