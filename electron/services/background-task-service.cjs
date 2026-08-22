const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const HISTORY_STATES = new Set([...TERMINAL_STATES, 'interrupted']);
const DISMISSIBLE_STATES = new Set([...TERMINAL_STATES, 'interrupted']);
const ACTIVE_STATES = new Set(['queued', 'running', 'pausing', 'paused', 'resuming']);

const DEFAULT_POLICY = Object.freeze({ resumePolicy: 'atomic', notificationPolicy: 'error-only', historyPolicy: 'persistent', pausable: false, resumable: false });
const TASK_POLICIES = Object.freeze({
  'project-file-operation': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'project-archive': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'project-unarchive': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'workspace-backup': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'workspace-restore': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'project-restore': { resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', resumable: true },
  'video-trim': { resumePolicy: 'safe-restart', notificationPolicy: 'progress-toast' },
  'version-tracking': { resumePolicy: 'safe-restart', notificationPolicy: 'progress-toast' },
  'version-media-rescan': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'version-fingerprint-maintenance': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'thumbnail-generate': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'thumbnail-cache-recovery': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'backup-verify': { resumePolicy: 'checkpoint', notificationPolicy: 'error-only', resumable: true },
  'workspace-reconcile': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'storage-usage-scan': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'deleted-project-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'backup-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'cache-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'result-only' },
  'internal-artifact-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'internal-filesystem-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'system-filesystem-cleanup': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
  'component-status-refresh': { resumePolicy: 'safe-restart', notificationPolicy: 'error-only' },
});

const resolvePolicy = definition => {
  const configured = TASK_POLICIES[definition.type] || DEFAULT_POLICY;
  const notificationPolicy = definition.notificationPolicy || configured.notificationPolicy;
  return {
    resumePolicy: definition.resumePolicy || configured.resumePolicy,
    notificationPolicy,
    historyPolicy: definition.historyPolicy || (notificationPolicy === 'silent' ? 'ephemeral' : configured.historyPolicy || 'persistent'),
    pausable: definition.pausable ?? configured.pausable ?? false,
    resumable: definition.resumable ?? configured.resumable ?? false,
  };
};

const createBackgroundTaskService = ({ eventBus, maxHistory = 200, now = () => Date.now(), persistencePath = '', writeLog = () => undefined }) => {
  const tasks = new Map();
  const retryFactories = new Map();
  const resumeFactories = new Map();
  const typeResumeFactories = new Map();
  const restartFactories = new Map();
  const typeRestartFactories = new Map();
  const activeByKey = new Map();
  const completionByTaskId = new Map();
  const retryStarts = new Map();
  const resourceWaiters = [];
  const reservations = new Map();
  const retryContext = new AsyncLocalStorage();
  let persistenceTimer = null;
  let revision = 0;

  const normalizeResource = value => String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
  const normalizeResourceRequest = (value, defaultAccess) => {
    const requestedPath = value && typeof value === 'object' ? value.path : value;
    const normalizedPath = normalizeResource(requestedPath);
    if (!normalizedPath) return null;
    const requestedAccess = value && typeof value === 'object' ? value.access : defaultAccess;
    return { path: normalizedPath, access: requestedAccess === 'read' ? 'read' : 'write' };
  };
  const resourcesConflict = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  const blockingReservationIds = waiter => {
    const blockers = new Set();
    const activeReservations = [...reservations.entries()];
    const group = waiter.group || '';
    if (group) {
      const activeInGroup = activeReservations.filter(([, item]) => item.group === group);
      if (activeInGroup.length >= waiter.limit) activeInGroup.forEach(([id]) => blockers.add(id));
      if (waiter.access === 'write') {
        const activeWriters = activeInGroup.filter(([, item]) => item.access === 'write');
        if (activeWriters.length >= waiter.writeLimit) activeWriters.forEach(([id]) => blockers.add(id));
      }
    }
    for (const [id, active] of activeReservations) {
      const conflicts = waiter.resources.some(left => active.resources.some(right => (
        left.access === 'write' || right.access === 'write'
      ) && resourcesConflict(left.path, right.path)));
      if (conflicts) blockers.add(id);
    }
    return [...blockers];
  };
  const drainResourceWaiters = () => {
    for (let index = 0; index < resourceWaiters.length;) {
      const waiter = resourceWaiters[index];
      if (waiter.signal.aborted) {
        resourceWaiters.splice(index, 1);
        waiter.reject(Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELLED' }));
        continue;
      }
      const blockerIds = blockingReservationIds(waiter);
      if (blockerIds.length) {
        const task = tasks.get(waiter.id);
        const blockerTitles = [...new Set(blockerIds.map(id => tasks.get(id)?.title).filter(Boolean))];
        const message = blockerTitles.length
          ? `等待“${blockerTitles.slice(0, 2).join('、')}”完成${blockerTitles.length > 2 ? '等任务' : ''}`
          : '等待其他文件操作完成';
        if (task?.state === 'queued' && (task.message !== message || String(task.blockedByTaskIds || '') !== String(blockerIds))) {
          update(task, { message, blockedByTaskIds: blockerIds });
        }
        index += 1;
        continue;
      }
      resourceWaiters.splice(index, 1);
      reservations.set(waiter.id, { group: waiter.group, resources: waiter.resources, access: waiter.access });
      waiter.resolve();
    }
  };
  const acquireResources = (task, definition) => {
    const defaultAccess = definition.resourceAccess === 'read' ? 'read' : 'write';
    const resourcesByIdentity = new Map();
    for (const requested of definition.resources || []) {
      const resource = normalizeResourceRequest(requested, defaultAccess);
      if (!resource) continue;
      const existing = resourcesByIdentity.get(resource.path);
      if (!existing || resource.access === 'write') resourcesByIdentity.set(resource.path, resource);
    }
    const resources = [...resourcesByIdentity.values()];
    const group = String(definition.concurrencyGroup || '');
    const access = resources.some(resource => resource.access === 'write') ? 'write' : defaultAccess;
    if (!resources.length && !group) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        id: task.id,
        resources,
        group,
        limit: Math.max(1, Number(definition.concurrencyLimit) || 1),
        writeLimit: Math.max(1, Number(definition.concurrencyWriteLimit) || Number(definition.concurrencyLimit) || 1),
        access,
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
    const { controller: _controller, pauseRequested: _pauseRequested, pauseWaiters: _pauseWaiters, ...value } = task;
    return { ...value };
  };
  const flushPersistence = () => {
    if (!persistencePath) return true;
    try {
      const directory = path.dirname(persistencePath);
      const temporaryPath = `${persistencePath}.tmp`;
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify({
        version: 2,
        tasks: [...tasks.values()].filter(task => task.historyPolicy !== 'ephemeral').map(publicTask),
      }), 'utf8');
      fs.renameSync(temporaryPath, persistencePath);
      return true;
    } catch (error) {
      eventBus.emit('background-task:persistence-error', { error: error?.message || String(error), path: persistencePath });
      return false;
    }
  };
  const schedulePersistence = () => {
    if (!persistencePath || persistenceTimer) return;
    persistenceTimer = setTimeout(() => {
      persistenceTimer = null;
      flushPersistence();
    }, 200);
    persistenceTimer.unref?.();
  };
  const deleteTaskInternal = id => {
    if (!tasks.has(id)) return false;
    tasks.delete(id);
    retryFactories.delete(id);
    resumeFactories.delete(id);
    restartFactories.delete(id);
    return true;
  };
  const emitDelta = (upserts = [], removeIds = []) => {
    revision += 1;
    eventBus.emit('background-task:changed', {
      revision,
      upserts: upserts.map(publicTask),
      removeIds: [...new Set(removeIds)],
    });
    schedulePersistence();
  };
  const publish = task => {
    const upserts = [];
    const removeIds = [];
    if (task.retryOfTaskId && HISTORY_STATES.has(task.state)) {
      const previous = tasks.get(task.retryOfTaskId);
      if (task.state === 'completed' || task.state === 'failed') {
        if (previous && deleteTaskInternal(previous.id)) removeIds.push(previous.id);
        if (task.historyPolicy === 'ephemeral') {
          if (task.state === 'failed') writeLog('error', 'Ephemeral background task failed', {
            taskId: task.id, type: task.type, error: task.error || task.message, metadata: task.metadata,
          });
          if (deleteTaskInternal(task.id)) removeIds.push(task.id);
        } else upserts.push(task);
      } else {
        if (deleteTaskInternal(task.id)) removeIds.push(task.id);
        if (previous) {
          const canRetry = retryFactories.has(previous.id);
          Object.assign(previous, {
            replacedByTaskId: null,
            retryPending: false,
            retryable: canRetry,
            capabilities: { ...previous.capabilities, retryable: canRetry },
            updatedAt: now(),
          });
          upserts.push(previous);
        }
      }
    } else if (task.historyPolicy === 'ephemeral' && HISTORY_STATES.has(task.state)) {
      if (task.state === 'failed') writeLog('error', 'Ephemeral background task failed', {
        taskId: task.id,
        type: task.type,
        error: task.error || task.message,
        metadata: task.metadata,
      });
      if (deleteTaskInternal(task.id)) removeIds.push(task.id);
    } else {
      upserts.push(task);
    }

    const removable = [...tasks.values()]
      .filter(item => HISTORY_STATES.has(item.state) && !item.retryPending)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (tasks.size > maxHistory && removable.length) {
      const oldest = removable.shift();
      if (deleteTaskInternal(oldest.id)) removeIds.push(oldest.id);
    }
    emitDelta(upserts.filter(item => tasks.has(item.id)), removeIds);
  };
  const update = (task, patch) => {
    Object.assign(task, patch, { updatedAt: now() });
    publish(task);
  };
  const removeTask = id => {
    if (!deleteTaskInternal(id)) return false;
    emitDelta([], [id]);
    return true;
  };

  const createHandle = (definition, retryFactory = null) => {
    const replacementContext = retryContext.getStore();
    const mayClaimRetry = definition.retryReplacement !== false;
    const dedupeKey = definition.dedupeKey || '';
    const activeId = dedupeKey ? activeByKey.get(dedupeKey) : '';
    if (activeId) {
      const activeTask = tasks.get(activeId);
      if (replacementContext && mayClaimRetry && activeTask?.retryOfTaskId === replacementContext.task.id) {
        replacementContext.claimed = true;
        replacementContext.replacement = activeTask;
        replacementContext.deduplicated = true;
        replacementContext.resolveStart(activeTask);
      } else if (replacementContext && mayClaimRetry && !replacementContext.closed) {
        replacementContext.conflict = activeTask || null;
        replacementContext.closed = true;
        replacementContext.rejectStart(retryError('RETRY_DEDUPE_CONFLICT', '等价任务已在运行，本次重试未启动'));
      }
      return { deduplicated: true, task: publicTask(activeTask) };
    }
    const retryOfTask = replacementContext && mayClaimRetry && !replacementContext.closed && !replacementContext.claimed
      && replacementContext.task && tasks.get(replacementContext.task.id) === replacementContext.task
      ? replacementContext.task : null;
    const requestedDefinitionId = String(definition.id || '');
    const requestedId = retryOfTask && requestedDefinitionId === retryOfTask.id ? '' : requestedDefinitionId;
    const existing = requestedId ? tasks.get(requestedId) : null;
    if (existing && !TERMINAL_STATES.has(existing.state)) return { deduplicated: true, task: publicTask(existing) };
    const createdAt = now();
    const policy = resolvePolicy(definition);
    const resumeFactory = typeof definition.resumeFactory === 'function' ? definition.resumeFactory : null;
    const capabilities = {
      cancellable: definition.cancellable !== false,
      pausable: Boolean(policy.pausable),
      resumable: Boolean(policy.resumable && resumeFactory),
      retryable: Boolean(retryFactory),
    };
    const task = {
      id: requestedId || crypto.randomUUID(),
      type: definition.type,
      title: definition.title || definition.type,
      state: 'queued',
      progress: Math.max(0, Math.min(100, Number(definition.progress) || 0)),
      message: definition.message || '',
      cancellable: capabilities.cancellable,
      retryable: Boolean(retryFactory),
      resumable: capabilities.resumable,
      resumeAvailable: Boolean(resumeFactory),
      restartAvailable: false,
      capabilities,
      resumePolicy: policy.resumePolicy,
      notificationPolicy: policy.notificationPolicy,
      historyPolicy: policy.historyPolicy,
      retryOfTaskId: retryOfTask?.id || null,
      replacedByTaskId: null,
      retryAttempt: retryOfTask ? Math.max(0, Number(retryOfTask.retryAttempt) || 0) + 1 : Math.max(0, Number(definition.retryAttempt) || 0),
      retryPending: false,
      checkpointVersion: Math.max(1, Number(definition.checkpointVersion) || 1),
      checkpoint: definition.checkpoint,
      metadata: definition.metadata || {},
      createdAt,
      updatedAt: createdAt,
      startedAt: 0,
      finishedAt: 0,
      controller: new AbortController(),
      pauseRequested: false,
      pauseWaiters: new Set(),
    };
    tasks.set(task.id, task);
    if (dedupeKey) activeByKey.set(dedupeKey, task.id);
    if (retryFactory) retryFactories.set(task.id, retryFactory);
    if (resumeFactory) resumeFactories.set(task.id, resumeFactory);
    if (retryOfTask) {
      replacementContext.claimed = true;
      replacementContext.replacement = task;
      Object.assign(retryOfTask, {
        replacedByTaskId: task.id,
        retryPending: true,
        retryable: false,
        capabilities: { ...retryOfTask.capabilities, retryable: false },
        updatedAt: now(),
      });
      emitDelta([retryOfTask, task], []);
      replacementContext.resolveStart(task);
    } else publish(task);
    const context = {
      id: task.id,
      signal: task.controller.signal,
      report: (progress, message = task.message, metadata) => {
        if (task.controller.signal.aborted) return;
        update(task, {
          progress: Math.max(task.progress, Math.max(0, Math.min(100, Number(progress) || 0))),
          message,
          ...(metadata ? { metadata: { ...task.metadata, ...metadata } } : {}),
        });
      },
      setCancellable: cancellable => {
        if (task.controller.signal.aborted || TERMINAL_STATES.has(task.state)) return;
        const next = Boolean(cancellable);
        update(task, { cancellable: next, capabilities: { ...task.capabilities, cancellable: next } });
      },
      setPausable: pausable => {
        if (task.controller.signal.aborted || TERMINAL_STATES.has(task.state)) return;
        const next = Boolean(pausable);
        update(task, { capabilities: { ...task.capabilities, pausable: next } });
      },
      waitIfPaused: async () => {
        if (!task.pauseRequested) return;
        if (task.state !== 'paused') update(task, { state: 'paused', message: '已暂停' });
        await new Promise(resolve => task.pauseWaiters.add(resolve));
        context.throwIfCancelled();
        if (!task.pauseRequested && (task.state === 'paused' || task.state === 'resuming')) update(task, { state: 'running', message: '正在继续任务' });
      },
      saveCheckpoint: (checkpoint, progress = task.progress, message = task.message, metadata) => {
        if (task.controller.signal.aborted || TERMINAL_STATES.has(task.state)) return;
        update(task, {
          checkpoint,
          progress: Math.max(task.progress, Math.max(0, Math.min(100, Number(progress) || 0))),
          message,
          ...(metadata ? { metadata: { ...task.metadata, ...metadata } } : {}),
        });
      },
      getCheckpoint: () => task.checkpoint,
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
        update(task, { state: 'running', startedAt: now(), message: definition.runningMessage || task.message, blockedByTaskIds: [] });
      },
      complete: (message = task.message || '已完成') => finish({ state: 'completed', progress: 100, message, checkpoint: undefined }),
      fail: error => finish({ state: 'failed', error: error?.message || String(error), message: error?.message || String(error) }),
      cancelled: () => finish({ state: 'cancelled', error: '', message: '已取消' }),
      isFinished: () => finished,
      snapshot: () => publicTask(task),
    };
  };

  const start = (definition, worker, retryFactory = null) => {
    const handle = createHandle(definition, retryFactory);
    if (handle.deduplicated) {
      const completion = completionByTaskId.get(handle.task.id) || Promise.resolve({ task: handle.task, deduplicated: true });
      return { task: handle.task, deduplicated: true, completion };
    }
    const completion = (async () => {
      try {
        await handle.waitForStart();
        const result = await worker(handle.context);
        handle.context.throwIfCancelled();
        handle.complete();
        return { task: tasks.has(handle.task.id) ? publicTask(tasks.get(handle.task.id)) : handle.snapshot(), result };
      } catch (error) {
        const cancelled = handle.context.signal.aborted || error?.code === 'TASK_CANCELLED';
        if (cancelled) handle.cancelled();
        else handle.fail(error);
        if (!cancelled) throw error;
        return { task: tasks.has(handle.task.id) ? publicTask(tasks.get(handle.task.id)) : handle.snapshot(), cancelled: true };
      }
    })();
    completionByTaskId.set(handle.task.id, completion);
    completion.then(
      () => { if (completionByTaskId.get(handle.task.id) === completion) completionByTaskId.delete(handle.task.id); },
      () => { if (completionByTaskId.get(handle.task.id) === completion) completionByTaskId.delete(handle.task.id); },
    );
    // A start() caller may intentionally rely only on task deltas. Attach a
    // rejection observer so worker failures never become unhandled promises;
    // awaiting the original promise still preserves its rejection semantics.
    void completion.catch(() => undefined);
    return { task: tasks.has(handle.task.id) ? publicTask(tasks.get(handle.task.id)) : handle.snapshot(), deduplicated: false, completion };
  };

  const run = (definition, worker, retryFactory = null) => start(definition, worker, retryFactory).completion;

  const cancel = id => {
    const task = tasks.get(id);
    if (!task || TERMINAL_STATES.has(task.state) || !task.cancellable) return false;
    task.controller.abort();
    task.pauseRequested = false;
    for (const resolve of task.pauseWaiters) resolve();
    task.pauseWaiters.clear();
    update(task, { message: '正在取消…', cancellable: false });
    return true;
  };

  const pause = id => {
    const task = tasks.get(id);
    if (!task || task.state !== 'running' || !task.capabilities?.pausable) return false;
    task.pauseRequested = true;
    update(task, { state: 'pausing', message: '正在暂停…' });
    return true;
  };

  const continuePaused = id => {
    const task = tasks.get(id);
    if (!task || !['pausing', 'paused'].includes(task.state) || !task.capabilities?.pausable) return false;
    task.pauseRequested = false;
    const hadWaiters = task.pauseWaiters.size > 0;
    update(task, { state: hadWaiters ? 'resuming' : 'running', message: hadWaiters ? '正在继续任务…' : '任务已继续' });
    for (const resolve of task.pauseWaiters) resolve();
    task.pauseWaiters.clear();
    return true;
  };

  const retryError = (code, message) => Object.assign(new Error(message), { code });
  const retry = id => {
    const factory = retryFactories.get(id);
    const task = tasks.get(id);
    if (!task || task.state !== 'failed') throw retryError('INVALID_STATE', '该任务当前不能重试');
    if (task.retryPending) {
      const replacement = tasks.get(task.replacedByTaskId);
      if (replacement && ACTIVE_STATES.has(replacement.state)) return {
        accepted: true,
        sourceTaskId: task.id,
        replacementTaskId: replacement.id,
        deduplicated: true,
        task: publicTask(replacement),
        completion: completionByTaskId.get(replacement.id) || Promise.resolve({ task: publicTask(replacement), deduplicated: true }),
      };
      throw retryError('RETRY_ALREADY_ACTIVE', '该任务的重试状态正在结算');
    }
    if (!factory) throw retryError('NOT_RETRYABLE', '该任务不支持重试');
    const pendingStart = retryStarts.get(id);
    if (pendingStart) return pendingStart.then(result => ({ ...result, deduplicated: true }));

    let resolveStart;
    let rejectStart;
    const started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    void started.catch(() => undefined);
    const replacementContext = {
      task,
      replacement: null,
      conflict: null,
      deduplicated: false,
      claimed: false,
      closed: false,
      resolveStart,
      rejectStart,
    };
    const begin = (async () => {
      let execution;
      try {
        execution = retryContext.run(replacementContext, () => factory(publicTask(task)));
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!normalized.code) normalized.code = 'FACTORY_FAILED';
        replacementContext.closed = true;
        rejectStart(normalized);
        throw normalized;
      }
      const completion = execution?.completion ? execution.completion : Promise.resolve(execution);
      void completion.then(
        () => {
          if (replacementContext.claimed || replacementContext.closed) return;
          replacementContext.closed = true;
          rejectStart(retryError('FACTORY_DID_NOT_START', '重试工厂未创建替代任务'));
        },
        error => {
          if (replacementContext.claimed || replacementContext.closed) return;
          replacementContext.closed = true;
          const normalized = error instanceof Error ? error : new Error(String(error));
          if (!normalized.code) normalized.code = 'FACTORY_FAILED';
          rejectStart(normalized);
        },
      );
      const replacement = await started;
      return {
        accepted: true,
        sourceTaskId: task.id,
        replacementTaskId: replacement.id,
        deduplicated: Boolean(replacementContext.deduplicated),
        task: publicTask(replacement),
        completion,
      };
    })();
    retryStarts.set(id, begin);
    begin.then(
      () => { if (retryStarts.get(id) === begin) retryStarts.delete(id); },
      () => { if (retryStarts.get(id) === begin) retryStarts.delete(id); },
    );
    return begin;
  };

  const resume = async id => {
    const factory = resumeFactories.get(id);
    const task = tasks.get(id);
    if (!factory || !task || task.state !== 'interrupted') throw new Error('该任务当前不能继续');
    tasks.delete(id);
    resumeFactories.delete(id);
    try {
      const result = await factory(publicTask(task));
      schedulePersistence();
      return result;
    } catch (error) {
      tasks.set(id, task);
      update(task, { state: 'failed', error: error?.message || String(error), message: error?.message || String(error), finishedAt: now(), resumeAvailable: false });
      throw error;
    }
  };

  const registerTypeResumeFactory = (type, factory, options = {}) => {
    const normalizedType = String(type || '');
    if (!normalizedType || typeof factory !== 'function') return () => undefined;
    typeResumeFactories.set(normalizedType, factory);
    for (const task of tasks.values()) {
      if (task.type !== normalizedType || task.state !== 'interrupted') continue;
      if (typeof options.canResume === 'function' && !options.canResume(publicTask(task))) continue;
      if (task.checkpoint !== undefined && Math.max(1, Number(task.checkpointVersion) || 1) !== 1) {
        update(task, {
          resumable: false,
          resumeAvailable: false,
          capabilities: { ...task.capabilities, resumable: false },
          message: '保存的任务断点版本与当前软件不兼容，请重新执行任务',
        });
        continue;
      }
      resumeFactories.set(task.id, () => factory(publicTask(task)));
      update(task, {
        resumable: true,
        resumeAvailable: true,
        capabilities: { ...task.capabilities, resumable: true },
      });
    }
    return () => {
      if (typeResumeFactories.get(normalizedType) !== factory) return;
      typeResumeFactories.delete(normalizedType);
      for (const task of tasks.values()) {
        if (task.type !== normalizedType || task.state !== 'interrupted') continue;
        resumeFactories.delete(task.id);
        update(task, { resumeAvailable: false });
      }
    };
  };

  const restart = async id => {
    const factory = restartFactories.get(id);
    const task = tasks.get(id);
    if (!factory || !task || task.state !== 'interrupted' || task.resumePolicy !== 'safe-restart') throw new Error('该任务当前不能重新执行');
    tasks.delete(id);
    restartFactories.delete(id);
    try {
      const result = await factory(publicTask(task));
      schedulePersistence();
      return result;
    } catch (error) {
      tasks.set(id, task);
      const typeFactory = typeRestartFactories.get(task.type);
      if (typeFactory) retryFactories.set(id, () => typeFactory(publicTask(task)));
      update(task, {
        state: 'failed', error: error?.message || String(error), message: error?.message || String(error), finishedAt: now(),
        restartAvailable: false, retryable: Boolean(typeFactory), capabilities: { ...task.capabilities, retryable: Boolean(typeFactory) },
      });
      throw error;
    }
  };

  const registerTypeRestartFactory = (type, factory, options = {}) => {
    const normalizedType = String(type || '');
    if (!normalizedType || typeof factory !== 'function') return () => undefined;
    typeRestartFactories.set(normalizedType, factory);
    const autoRestartIds = [];
    for (const task of tasks.values()) {
      if (task.type === normalizedType && task.state === 'failed' && !task.retryPending
          && (typeof options.canRestart !== 'function' || options.canRestart(publicTask(task)))) {
        retryFactories.set(task.id, () => factory(publicTask(task)));
        update(task, { retryable: true, capabilities: { ...task.capabilities, retryable: true } });
        continue;
      }
      if (task.type !== normalizedType || task.state !== 'interrupted' || task.resumePolicy !== 'safe-restart') continue;
      if (typeof options.canRestart === 'function' && !options.canRestart(publicTask(task))) continue;
      restartFactories.set(task.id, () => factory(publicTask(task)));
      update(task, { restartAvailable: true });
      if (options.autoRestart === true) autoRestartIds.push(task.id);
    }
    const autoRestartDelayMs = Math.max(0, Number(options.autoRestartDelayMs) || 0);
    for (const id of autoRestartIds) setTimeout(() => void restart(id).catch(() => undefined), autoRestartDelayMs);
    return () => {
      if (typeRestartFactories.get(normalizedType) !== factory) return;
      typeRestartFactories.delete(normalizedType);
      for (const task of tasks.values()) {
        if (task.type !== normalizedType) continue;
        if (task.state === 'interrupted') {
          restartFactories.delete(task.id);
          update(task, { restartAvailable: false });
        } else if (task.state === 'failed') {
          retryFactories.delete(task.id);
          update(task, { retryable: false, capabilities: { ...task.capabilities, retryable: false } });
        }
      }
    };
  };

  const dismiss = id => {
    const task = tasks.get(id);
    if (!task || !DISMISSIBLE_STATES.has(task.state) || task.retryPending) return false;
    return removeTask(id);
  };

  const upsertExternal = definition => {
    const id = String(definition?.id || '');
    if (!id || !definition?.type) return null;
    const requestedState = ['running', 'completed', 'failed', 'cancelled'].includes(definition.state) ? definition.state : 'running';
    const existing = tasks.get(id);
    const startsNewRun = !existing || (TERMINAL_STATES.has(existing.state) && requestedState === 'running');
    if (startsNewRun) createHandle({
      id,
      type: definition.type,
      title: definition.title || definition.type,
      cancellable: definition.cancellable === true,
      resumePolicy: definition.resumePolicy || 'safe-restart',
      notificationPolicy: definition.notificationPolicy || 'progress-toast',
      historyPolicy: definition.historyPolicy,
      metadata: definition.metadata || {},
    });
    const task = tasks.get(id);
    if (!task) return null;
    const progress = Math.max(0, Math.min(100, Number(definition.progress) || 0));
    const nextProgress = requestedState === 'running' && !startsNewRun ? Math.max(task.progress, progress) : progress;
    update(task, {
      state: requestedState,
      progress: requestedState === 'completed' ? 100 : nextProgress,
      message: definition.message || task.message,
      error: requestedState === 'failed' ? definition.error || definition.message || '任务失败' : '',
      metadata: { ...task.metadata, ...(definition.metadata || {}), source: 'external-progress-bridge' },
      startedAt: task.startedAt || now(),
      finishedAt: TERMINAL_STATES.has(requestedState) ? now() : 0,
    });
    return publicTask(task);
  };

  const restorePersistedTasks = () => {
    if (!persistencePath) return;
    try {
      const payload = JSON.parse(fs.readFileSync(persistencePath, 'utf8'));
      const restored = Array.isArray(payload?.tasks) ? payload.tasks : [];
      for (const value of restored) {
        if (!value?.id || !value?.type) continue;
        const policy = resolvePolicy(value);
        if ((value.historyPolicy || policy.historyPolicy) === 'ephemeral') continue;
        const wasActive = ACTIVE_STATES.has(value.state);
        const capabilities = {
          cancellable: false,
          pausable: Boolean(value.capabilities?.pausable ?? policy.pausable),
          resumable: Boolean(value.capabilities?.resumable ?? value.resumable ?? policy.resumable),
          retryable: false,
        };
        const state = wasActive ? 'interrupted' : value.state;
        const message = wasActive
          ? capabilities.resumable ? '任务在上次退出时中断，可从已保存进度继续' : value.resumePolicy === 'safe-restart' ? '任务在上次退出时中断，可安全重新执行' : '任务在上次退出时中断'
          : value.message;
        tasks.set(String(value.id), {
          ...value,
          state,
          message,
          cancellable: false,
          retryable: false,
          resumable: capabilities.resumable,
          resumeAvailable: false,
          restartAvailable: false,
          capabilities,
          resumePolicy: value.resumePolicy || policy.resumePolicy,
          notificationPolicy: value.notificationPolicy || policy.notificationPolicy,
          historyPolicy: value.historyPolicy || policy.historyPolicy,
          retryOfTaskId: value.retryOfTaskId || null,
          replacedByTaskId: value.replacedByTaskId || null,
          retryAttempt: Math.max(0, Number(value.retryAttempt) || 0),
          retryPending: Boolean(value.retryPending),
          controller: new AbortController(),
          pauseRequested: false,
          pauseWaiters: new Set(),
          updatedAt: wasActive ? now() : value.updatedAt,
        });
      }
      for (const replacement of [...tasks.values()]) {
        if (replacement.state !== 'interrupted' || !replacement.retryOfTaskId) continue;
        const previous = tasks.get(replacement.retryOfTaskId);
        deleteTaskInternal(replacement.id);
        if (previous?.state === 'failed') {
          Object.assign(previous, {
            replacedByTaskId: null,
            retryPending: false,
            retryable: false,
            capabilities: { ...previous.capabilities, retryable: false },
          });
        }
      }
      for (const previous of tasks.values()) {
        if (previous.state !== 'failed' || !previous.retryPending) continue;
        const replacement = tasks.get(previous.replacedByTaskId);
        if (replacement?.retryOfTaskId === previous.id) continue;
        Object.assign(previous, {
          replacedByTaskId: null,
          retryPending: false,
          retryable: false,
          capabilities: { ...previous.capabilities, retryable: false },
        });
      }
      const history = [...tasks.values()]
        .filter(task => HISTORY_STATES.has(task.state) && !task.retryPending)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      for (const task of history.slice(maxHistory)) deleteTaskInternal(task.id);
    } catch (_) {
      // A missing or invalid history file is equivalent to an empty task history.
    }
  };

  restorePersistedTasks();

  return {
    start,
    run,
    create: createHandle,
    cancel,
    pause,
    continuePaused,
    retry,
    resume,
    registerTypeResumeFactory,
    restart,
    registerTypeRestartFactory,
    dismiss,
    upsertExternal,
    flush: flushPersistence,
    list: () => [...tasks.values()].map(publicTask).sort((left, right) => right.createdAt - left.createdAt),
    snapshot: () => ({ revision, tasks: [...tasks.values()].map(publicTask).sort((left, right) => right.createdAt - left.createdAt) }),
    get: id => tasks.has(id) ? publicTask(tasks.get(id)) : null,
    stop: () => {
      for (const task of tasks.values()) if (!TERMINAL_STATES.has(task.state)) {
        task.controller.abort();
        for (const resolve of task.pauseWaiters) resolve();
        task.pauseWaiters.clear();
      }
      if (persistenceTimer) clearTimeout(persistenceTimer);
      persistenceTimer = null;
      flushPersistence();
    },
  };
};

module.exports = { createBackgroundTaskService };
