const crypto = require('crypto');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

const createBackgroundTaskService = ({ eventBus, maxHistory = 200, now = () => Date.now() }) => {
  const tasks = new Map();
  const retryFactories = new Map();
  const activeByKey = new Map();
  const resourceWaiters = [];
  const reservations = new Map();

  const normalizeResource = value => String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
  const resourcesConflict = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  const canReserve = waiter => {
    const group = waiter.group || '';
    if (group) {
      const activeInGroup = [...reservations.values()].filter(item => item.group === group).length;
      if (activeInGroup >= waiter.limit) return false;
    }
    return ![...reservations.values()].some(active => waiter.resources.some(left => active.resources.some(right => resourcesConflict(left, right))));
  };
  const drainResourceWaiters = () => {
    for (let index = 0; index < resourceWaiters.length;) {
      const waiter = resourceWaiters[index];
      if (waiter.signal.aborted) {
        resourceWaiters.splice(index, 1);
        waiter.reject(Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELLED' }));
        continue;
      }
      if (!canReserve(waiter)) { index += 1; continue; }
      resourceWaiters.splice(index, 1);
      reservations.set(waiter.id, { group: waiter.group, resources: waiter.resources });
      waiter.resolve();
    }
  };
  const acquireResources = (task, definition) => {
    const resources = [...new Set((definition.resources || []).map(normalizeResource).filter(Boolean))];
    const group = String(definition.concurrencyGroup || '');
    if (!resources.length && !group) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        id: task.id,
        resources,
        group,
        limit: Math.max(1, Number(definition.concurrencyLimit) || 1),
        signal: task.controller.signal,
        resolve,
        reject,
      };
      resourceWaiters.push(waiter);
      task.controller.signal.addEventListener('abort', drainResourceWaiters, { once: true });
      drainResourceWaiters();
    });
  };
  const releaseResources = id => {
    reservations.delete(id);
    const waiterIndex = resourceWaiters.findIndex(waiter => waiter.id === id);
    if (waiterIndex >= 0) resourceWaiters.splice(waiterIndex, 1);
    drainResourceWaiters();
  };

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

  const createHandle = (definition, retryFactory = null) => {
    const dedupeKey = definition.dedupeKey || '';
    const activeId = dedupeKey ? activeByKey.get(dedupeKey) : '';
    if (activeId) return { deduplicated: true, task: publicTask(tasks.get(activeId)) };
    const requestedId = String(definition.id || '');
    const existing = requestedId ? tasks.get(requestedId) : null;
    if (existing && !TERMINAL_STATES.has(existing.state)) return { deduplicated: true, task: publicTask(existing) };
    const createdAt = now();
    const task = {
      id: requestedId || crypto.randomUUID(),
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
    let finished = false;
    const finish = patch => {
      if (finished) return;
      finished = true;
      update(task, { ...patch, finishedAt: now() });
      releaseResources(task.id);
      if (dedupeKey && activeByKey.get(dedupeKey) === task.id) activeByKey.delete(dedupeKey);
    };
    return {
      deduplicated: false,
      task: publicTask(task),
      context,
      waitForStart: async () => {
        await acquireResources(task, definition);
        context.throwIfCancelled();
        update(task, { state: 'running', startedAt: now(), message: definition.runningMessage || task.message });
      },
      complete: (message = task.message || '已完成') => finish({ state: 'completed', progress: 100, message }),
      fail: error => finish({ state: 'failed', error: error?.message || String(error), message: error?.message || String(error) }),
      cancelled: () => finish({ state: 'cancelled', error: '', message: '已取消' }),
      isFinished: () => finished,
    };
  };

  const run = async (definition, worker, retryFactory = null) => {
    const handle = createHandle(definition, retryFactory);
    if (handle.deduplicated) return { task: handle.task, deduplicated: true };
    try {
      await handle.waitForStart();
      const result = await worker(handle.context);
      handle.context.throwIfCancelled();
      handle.complete();
      return { task: tasks.has(handle.task.id) ? publicTask(tasks.get(handle.task.id)) : handle.task, result };
    } catch (error) {
      const cancelled = handle.context.signal.aborted || error?.code === 'TASK_CANCELLED';
      if (cancelled) handle.cancelled();
      else handle.fail(error);
      if (!cancelled) throw error;
      return { task: tasks.has(handle.task.id) ? publicTask(tasks.get(handle.task.id)) : handle.task, cancelled: true };
    }
  };

  const cancel = id => {
    const task = tasks.get(id);
    if (!task || TERMINAL_STATES.has(task.state) || !task.cancellable) return false;
    task.controller.abort();
    update(task, { message: '正在取消…', cancellable: false });
    return true;
  };

  const retry = async id => {
    const factory = retryFactories.get(id);
    const task = tasks.get(id);
    if (!factory || !task || task.state !== 'failed') throw new Error('该任务不能重试');
    return factory();
  };

  const dismiss = id => {
    const task = tasks.get(id);
    if (!task || !TERMINAL_STATES.has(task.state)) return false;
    tasks.delete(id);
    retryFactories.delete(id);
    return true;
  };

  return {
    run,
    create: createHandle,
    cancel,
    retry,
    dismiss,
    list: () => [...tasks.values()].map(publicTask).sort((left, right) => right.createdAt - left.createdAt),
    get: id => tasks.has(id) ? publicTask(tasks.get(id)) : null,
    stop: () => {
      for (const task of tasks.values()) if (!TERMINAL_STATES.has(task.state)) task.controller.abort();
    },
  };
};

module.exports = { createBackgroundTaskService };
