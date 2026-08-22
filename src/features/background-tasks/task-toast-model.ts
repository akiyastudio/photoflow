import type { BackgroundTask } from '../../types';

const FAILURE_TOAST_MS = 10_000;
const RESULT_TOAST_MS = 6_000;
const TERMINAL_TASK_STATES = new Set<BackgroundTask['state']>(['completed', 'failed', 'cancelled', 'interrupted']);
const ACTIVE_TASK_STATES = new Set<BackgroundTask['state']>(['queued', 'running', 'pausing', 'paused', 'resuming']);

export const normalizeBackgroundTaskSnapshots = (tasks: BackgroundTask[], limit = 200) => {
  const retained = tasks.filter(task => task.historyPolicy !== 'ephemeral' && !TERMINAL_TASK_STATES.has(task.state));
  const history = tasks
    .filter(task => task.historyPolicy !== 'ephemeral' && TERMINAL_TASK_STATES.has(task.state))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return [...retained, ...history.slice(0, Math.max(0, limit - retained.length))];
};

export const mergeBackgroundTaskSnapshots = (current: BackgroundTask[], incoming: BackgroundTask[], limit = 200) => {
  const merged: BackgroundTask[] = [];
  const seen = new Set<string>();
  for (const task of [...incoming, ...current]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    merged.push(task);
  }
  return normalizeBackgroundTaskSnapshots(merged, limit);
};

export const collapseRetryPredecessors = (tasks: BackgroundTask[]) => {
  const retrySources = new Set(tasks
    .filter(task => task.retryOfTaskId && ACTIVE_TASK_STATES.has(task.state))
    .map(task => String(task.retryOfTaskId)));
  return tasks.filter(task => !retrySources.has(task.id));
};

export const taskToastExpiresAt = (task: BackgroundTask) => task.state === 'failed'
  ? task.updatedAt + FAILURE_TOAST_MS
  : task.state === 'completed' && task.notificationPolicy === 'result-only'
    ? task.updatedAt + RESULT_TOAST_MS
    : 0;

export const isActiveProjectFileTask = (task: BackgroundTask, now = Date.now()) => {
  const active = task.state === 'queued' || task.state === 'running' || task.state === 'pausing' || task.state === 'paused' || task.state === 'resuming';
  const progressPolicy = task.notificationPolicy === 'progress-toast'
    || (!task.notificationPolicy && (task.type === 'project-file-operation' || task.type === 'version-tracking'));
  if (active) return progressPolicy;
  if (task.state === 'failed') return task.notificationPolicy !== 'silent' && now < taskToastExpiresAt(task);
  return task.state === 'completed' && task.notificationPolicy === 'result-only' && now < taskToastExpiresAt(task);
};

export const compareProjectFileTasks = (left: BackgroundTask, right: BackgroundTask) => {
  const priority = (task: BackgroundTask) => task.state === 'running' || task.state === 'resuming' ? 0
    : task.state === 'paused' || task.state === 'pausing' ? 1
      : task.state === 'queued' ? 2 : 3;
  if (priority(left) !== priority(right)) return priority(left) - priority(right);
  return left.createdAt - right.createdAt;
};

export const selectProjectFileTaskToasts = (tasks: BackgroundTask[], minimizedTaskIds: ReadonlySet<string>, limit = 4, now = Date.now(), queuedDelayMs = 700) => {
  const eligible = collapseRetryPredecessors(tasks).filter(task => isActiveProjectFileTask(task, now)
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
  const activeIds = new Set(tasks.filter(task => isActiveProjectFileTask(task)).map(task => task.id));
  const next = new Set([...current].filter(id => activeIds.has(id)));
  return next.size === current.size ? current : next;
};

export const isPointerInsideTaskIndicator = (
  trigger: Pick<HTMLElement, 'contains'> | null,
  panel: Pick<HTMLElement, 'contains'> | null,
  target: Node,
) => Boolean(trigger?.contains(target) || panel?.contains(target));
