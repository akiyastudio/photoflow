/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { BackgroundTask, LogEntry } from '../../types';
import { panelTaskSessionKey, removePanelTasksByOwnerPageId } from './panel-task-session-model';
import { mergeBackgroundTaskSnapshots, pruneFinishedTaskToastIds, setTaskToastMinimized } from './task-toast-model';

export type PanelTaskState = 'idle' | 'running' | 'completed' | 'failed';

export interface PanelTaskSnapshot {
  key: string;
  ownerPageId: string;
  panelKind: string;
  title: string;
  state: PanelTaskState;
  progress: number;
  message: string;
  logs: LogEntry[];
  updatedAt: number;
}

type PanelTaskReport = Omit<PanelTaskSnapshot, 'key' | 'ownerPageId' | 'panelKind' | 'title' | 'updatedAt'>;

interface TaskCenterValue {
  backgroundTasks: BackgroundTask[];
  panelTasks: Record<string, PanelTaskSnapshot>;
  reportPanelTask: (identity: Pick<PanelTaskSnapshot, 'key' | 'ownerPageId' | 'panelKind' | 'title'>, report: PanelTaskReport) => void;
  dismissPanelTask: (key: string) => void;
  dismissPanelTasksByOwnerPageId: (pageId: string) => void;
  dismissBackgroundTask: (id: string) => Promise<void>;
  minimizeTaskToast: (id: string) => void;
  restoreTaskToast: (id: string) => void;
  isTaskToastMinimized: (id: string) => boolean;
}

const TaskCenterContext = createContext<TaskCenterValue | null>(null);
type PanelTaskIdentity = Pick<PanelTaskSnapshot, 'key' | 'ownerPageId' | 'panelKind' | 'title'>;
type PanelTaskContextValue = {
  identity: PanelTaskIdentity;
  report: (report: PanelTaskReport) => void;
};
const PanelTaskReporterContext = createContext<PanelTaskContextValue | null>(null);

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
  const [minimizedToastTaskIds, setMinimizedToastTaskIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    void window.electronAPI.getBackgroundTasks().then(result => {
      if (active && result.success) setBackgroundTasks(current => mergeBackgroundTaskSnapshots(current, result.tasks));
    });
    const unsubscribe = window.electronAPI.onBackgroundTaskChanged(task => {
      setBackgroundTasks(current => mergeBackgroundTaskSnapshots(current, [task]));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setMinimizedToastTaskIds(current => pruneFinishedTaskToastIds(current, backgroundTasks));
  }, [backgroundTasks]);

  const reportPanelTask = useCallback((identity: Pick<PanelTaskSnapshot, 'key' | 'ownerPageId' | 'panelKind' | 'title'>, report: PanelTaskReport) => {
    setPanelTasks(current => {
      const previous = current[identity.key];
      const progress = previous?.state === 'running' && report.state === 'running' ? Math.max(previous.progress, report.progress) : report.progress;
      if (previous && previous.state === report.state && previous.progress === progress && previous.message === report.message && sameLogs(previous.logs, report.logs)) return current;
      return {
        ...current,
        [identity.key]: { ...identity, ...report, progress, updatedAt: Date.now() },
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

  const dismissPanelTasksByOwnerPageId = useCallback((pageId: string) => {
    setPanelTasks(current => removePanelTasksByOwnerPageId(current, pageId));
  }, []);

  const dismissBackgroundTask = useCallback(async (id: string) => {
    const result = await window.electronAPI.dismissBackgroundTask(id);
    if (result.success) setBackgroundTasks(current => current.filter(task => task.id !== id));
  }, []);

  const minimizeTaskToast = useCallback((id: string) => {
    setMinimizedToastTaskIds(current => setTaskToastMinimized(current, id, true));
  }, []);
  const restoreTaskToast = useCallback((id: string) => {
    setMinimizedToastTaskIds(current => setTaskToastMinimized(current, id, false));
  }, []);
  const isTaskToastMinimized = useCallback((id: string) => minimizedToastTaskIds.has(id), [minimizedToastTaskIds]);

  const value = useMemo<TaskCenterValue>(() => ({ backgroundTasks, panelTasks, reportPanelTask, dismissPanelTask, dismissPanelTasksByOwnerPageId, dismissBackgroundTask, minimizeTaskToast, restoreTaskToast, isTaskToastMinimized }), [backgroundTasks, dismissBackgroundTask, dismissPanelTask, dismissPanelTasksByOwnerPageId, isTaskToastMinimized, minimizeTaskToast, panelTasks, reportPanelTask, restoreTaskToast]);
  return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>;
};

export const useTaskCenter = () => {
  const value = useContext(TaskCenterContext);
  if (!value) throw new Error('useTaskCenter must be used inside TaskCenterProvider');
  return value;
};

export const PanelTaskScope = ({ ownerPageId, panelKind, title, children }: { ownerPageId: string; panelKind: string; title: string; children: React.ReactNode }) => {
  const { reportPanelTask } = useTaskCenter();
  const key = panelTaskSessionKey(ownerPageId, panelKind);
  const identity = useMemo<PanelTaskIdentity>(() => ({ key, ownerPageId, panelKind, title }), [key, ownerPageId, panelKind, title]);
  const report = useCallback((value: PanelTaskReport) => reportPanelTask(identity, value), [identity, reportPanelTask]);
  const value = useMemo<PanelTaskContextValue>(() => ({ identity, report }), [identity, report]);
  return <PanelTaskReporterContext.Provider value={value}>{children}</PanelTaskReporterContext.Provider>;
};

export const usePanelTaskReporter = () => useContext(PanelTaskReporterContext)?.report || null;
export const usePanelTaskIdentity = () => useContext(PanelTaskReporterContext)?.identity || null;
