const crypto = require('crypto');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

const createBackgroundTaskService = ({ eventBus, maxHistory = 200, now = () => Date.now() }) => {
  const tasks = new Map();
  const retryFactories = new Map();
  const activeByKey = new Map();

  const publicTask = task => {
    const { controller: _controller, ...value } = task;
    return { ...value };
  };
  const publish = task => {
    eventBus.emit('background-task:changed', publicTask(task));
    if (tasks.size <= maxHistory) return;
    const removable = [...tasks.values()]
      .filter(item => TERMINAL_STATES.has(item.state))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (tasks.size > maxHistory && removable.length) {
      const oldest = removable.shift();
      tasks.delete(oldest.id);
      retryFactories.delete(oldest.id);
    }
  };
  const update = (task, patch) => {
    Object.assign(task, patch, { updatedAt: now() });
    publish(task);
  };

  const run = async (definition, worker, retryFactory = null) => {
    const dedupeKey = definition.dedupeKey || '';
    const activeId = dedupeKey ? activeByKey.get(dedupeKey) : '';
    if (activeId) return { task: publicTask(tasks.get(activeId)), deduplicated: true };
    const createdAt = now();
    const task = {
      id: crypto.randomUUID(),
      type: definition.type,
      title: definition.title || definition.type,
      state: 'queued',
      progress: 0,
      message: definition.message || '',
      cancellable: definition.cancellable !== false,
      retryable: Boolean(retryFactory),
      metadata: definition.metadata || {},
      createdAt,
      updatedAt: createdAt,
      startedAt: 0,
      finishedAt: 0,
      controller: new AbortController(),
    };
    tasks.set(task.id, task);
    if (dedupeKey) activeByKey.set(dedupeKey, task.id);
    if (retryFactory) retryFactories.set(task.id, retryFactory);
    publish(task);
    update(task, { state: 'running', startedAt: now() });
    const context = {
      id: task.id,
      signal: task.controller.signal,
      report: (progress, message = task.message, metadata) => {
        if (task.controller.signal.aborted) return;
        update(task, {
          progress: Math.max(0, Math.min(100, Number(progress) || 0)),
          message,
          ...(metadata ? { metadata: { ...task.metadata, ...metadata } } : {}),
        });
      },
      throwIfCancelled: () => {
        if (task.controller.signal.aborted) {
          const error = new Error('任务已取消');
          error.code = 'TASK_CANCELLED';
          throw error;
        }
      },
    };
    try {
      const result = await worker(context);
      context.throwIfCancelled();
      update(task, { state: 'completed', progress: 100, finishedAt: now(), message: task.message || '已完成' });
      return { task: publicTask(task), result };
    } catch (error) {
      const cancelled = task.controller.signal.aborted || error?.code === 'TASK_CANCELLED';
      update(task, {
        state: cancelled ? 'cancelled' : 'failed',
        finishedAt: now(),
        error: cancelled ? '' : (error?.message || String(error)),
        message: cancelled ? '已取消' : (error?.message || String(error)),
      });
      if (!cancelled) throw error;
      return { task: publicTask(task), cancelled: true };
    } finally {
      if (dedupeKey && activeByKey.get(dedupeKey) === task.id) activeByKey.delete(dedupeKey);
    }
  };

  const cancel = id => {
    const task = tasks.get(id);
    if (!task || TERMINAL_STATES.has(task.state) || !task.cancellable) return false;
    task.controller.abort();
    update(task, { message: '正在取消…' });
    return true;
  };

  const retry = async id => {
    const factory = retryFactories.get(id);
    const task = tasks.get(id);
    if (!factory || !task || task.state !== 'failed') throw new Error('该任务不能重试');
    return factory();
  };

  return {
    run,
    cancel,
    retry,
    list: () => [...tasks.values()].map(publicTask).sort((left, right) => right.createdAt - left.createdAt),
    get: id => tasks.has(id) ? publicTask(tasks.get(id)) : null,
    stop: () => {
      for (const task of tasks.values()) if (!TERMINAL_STATES.has(task.state)) task.controller.abort();
    },
  };
};

module.exports = { createBackgroundTaskService };
