import type { BackgroundTask } from '../../types';

export const isActiveProjectFileTask = (task: BackgroundTask) => (task.type === 'project-file-operation' || task.type === 'version-tracking')
  && (task.state === 'queued' || task.state === 'running');

export const compareProjectFileTasks = (left: BackgroundTask, right: BackgroundTask) => {
  if (left.state !== right.state) return left.state === 'running' ? -1 : 1;
  return left.createdAt - right.createdAt;
};

export const selectProjectFileTaskToasts = (tasks: BackgroundTask[], minimizedTaskIds: ReadonlySet<string>, limit = 4, now = Date.now(), queuedDelayMs = 700) => {
  const eligible = tasks.filter(task => isActiveProjectFileTask(task)
    && !minimizedTaskIds.has(task.id)
    && (task.state !== 'queued' || now - task.createdAt >= queuedDelayMs)).sort(compareProjectFileTasks);
  return { visible: eligible.slice(0, limit), overflowCount: Math.max(0, eligible.length - limit) };
};

export const setTaskToastMinimized = (current: Set<string>, id: string, minimized: boolean): Set<string> => {
  if (minimized === current.has(id)) return current;
  const next = new Set(current);
  if (minimized) next.add(id);
  else next.delete(id);
  return next;
};

export const pruneFinishedTaskToastIds = (current: Set<string>, tasks: BackgroundTask[]): Set<string> => {
  const activeIds = new Set(tasks.filter(isActiveProjectFileTask).map(task => task.id));
  const next = new Set([...current].filter(id => activeIds.has(id)));
  return next.size === current.size ? current : next;
};

export const isPointerInsideTaskIndicator = (
  trigger: Pick<HTMLElement, 'contains'> | null,
  panel: Pick<HTMLElement, 'contains'> | null,
  target: Node,
) => Boolean(trigger?.contains(target) || panel?.contains(target));
