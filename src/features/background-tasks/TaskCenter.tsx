/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { BackgroundTask, LogEntry } from '../../types';

export type PanelTaskState = 'idle' | 'running' | 'completed' | 'failed';

export interface PanelTaskSnapshot {
  key: string;
  scopeKey: string;
  panelKind: string;
  title: string;
  state: PanelTaskState;
  progress: number;
  message: string;
  logs: LogEntry[];
  updatedAt: number;
}

type PanelTaskReport = Omit<PanelTaskSnapshot, 'key' | 'scopeKey' | 'panelKind' | 'title' | 'updatedAt'>;

interface TaskCenterValue {
  backgroundTasks: BackgroundTask[];
  panelTasks: Record<string, PanelTaskSnapshot>;
  reportPanelTask: (identity: Pick<PanelTaskSnapshot, 'key' | 'scopeKey' | 'panelKind' | 'title'>, report: PanelTaskReport) => void;
  dismissPanelTask: (key: string) => void;
  dismissBackgroundTask: (id: string) => Promise<void>;
}

const TaskCenterContext = createContext<TaskCenterValue | null>(null);
const PanelTaskReporterContext = createContext<((report: PanelTaskReport) => void) | null>(null);

const sameLogs = (left: LogEntry[], right: LogEntry[]) => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const leftLast = left[left.length - 1];
  const rightLast = right[right.length - 1];
  return leftLast?.timestamp === rightLast?.timestamp && leftLast?.message === rightLast?.message && leftLast?.type === rightLast?.type;
};

export const TaskCenterProvider = ({ children }: { children: React.ReactNode }) => {
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [panelTasks, setPanelTasks] = useState<Record<string, PanelTaskSnapshot>>({});

  useEffect(() => {
    let active = true;
    void window.electronAPI.getBackgroundTasks().then(result => {
      if (active && result.success) setBackgroundTasks(result.tasks);
    });
    const unsubscribe = window.electronAPI.onBackgroundTaskChanged(task => {
      setBackgroundTasks(current => [task, ...current.filter(item => item.id !== task.id)].slice(0, 200));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const reportPanelTask = useCallback((identity: Pick<PanelTaskSnapshot, 'key' | 'scopeKey' | 'panelKind' | 'title'>, report: PanelTaskReport) => {
    setPanelTasks(current => {
      const previous = current[identity.key];
      if (previous && previous.state === report.state && previous.progress === report.progress && previous.message === report.message && sameLogs(previous.logs, report.logs)) return current;
      return {
        ...current,
        [identity.key]: { ...identity, ...report, updatedAt: Date.now() },
      };
    });
  }, []);

  const dismissPanelTask = useCallback((key: string) => {
    setPanelTasks(current => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const dismissBackgroundTask = useCallback(async (id: string) => {
    const result = await window.electronAPI.dismissBackgroundTask(id);
    if (result.success) setBackgroundTasks(current => current.filter(task => task.id !== id));
  }, []);

  const value = useMemo<TaskCenterValue>(() => ({ backgroundTasks, panelTasks, reportPanelTask, dismissPanelTask, dismissBackgroundTask }), [backgroundTasks, dismissBackgroundTask, dismissPanelTask, panelTasks, reportPanelTask]);
  return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>;
};

export const useTaskCenter = () => {
  const value = useContext(TaskCenterContext);
  if (!value) throw new Error('useTaskCenter must be used inside TaskCenterProvider');
  return value;
};

export const PanelTaskScope = ({ scopeKey, panelKind, title, children }: { scopeKey: string; panelKind: string; title: string; children: React.ReactNode }) => {
  const { reportPanelTask } = useTaskCenter();
  const key = `${scopeKey}:${panelKind}`;
  const reporter = useCallback((report: PanelTaskReport) => reportPanelTask({ key, scopeKey, panelKind, title }, report), [key, panelKind, reportPanelTask, scopeKey, title]);
  return <PanelTaskReporterContext.Provider value={reporter}>{children}</PanelTaskReporterContext.Provider>;
};

export const usePanelTaskReporter = () => useContext(PanelTaskReporterContext);
