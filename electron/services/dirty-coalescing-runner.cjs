const cancelledError = key => Object.assign(new Error(`Dirty runner cancelled: ${key}`), { code: 'DIRTY_RUNNER_CANCELLED' });

const createDirtyCoalescingRunner = ({
  merge,
  worker,
  hasWork = batch => Boolean(batch),
  delayMs = 0,
  retryDelays = [250, 1000, 3000],
  onError = () => undefined,
}) => {
  if (typeof merge !== 'function' || typeof worker !== 'function') throw new TypeError('dirty runner requires merge and worker');
  const states = new Map();

  const createState = key => ({
    key,
    pendingBatch: null,
    inFlightBatch: null,
    generation: 0,
    completedGeneration: 0,
    retryTimer: null,
    executionPromise: null,
    inFlightGeneration: 0,
    retryAttempt: 0,
    nextRetryDelay: null,
    waiters: [],
    cancelled: false,
    controller: new AbortController(),
    predecessor: null,
    flushRequested: false,
    lastResult: undefined,
  });

  const settleCompleted = state => {
    const remaining = [];
    for (const waiter of state.waiters) {
      if (waiter.generation <= state.completedGeneration) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.resolve(state.lastResult);
      }
      else remaining.push(waiter);
    }
    state.waiters = remaining;
  };

  const rejectWaiters = (state, error) => {
    const waiters = state.waiters;
    state.waiters = [];
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.reject(error);
    }
  };

  const schedule = (state, waitMs) => {
    if (state.cancelled || state.executionPromise || state.retryTimer || state.predecessor || !hasWork(state.pendingBatch)) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      void execute(state);
    }, Math.max(0, Number(waitMs) || 0));
  };

  const execute = state => {
    if (state.cancelled || state.predecessor || state.executionPromise || !hasWork(state.pendingBatch)) return state.executionPromise;
    state.inFlightBatch = state.pendingBatch;
    state.inFlightGeneration = state.generation;
    state.pendingBatch = null;
    const batch = state.inFlightBatch;
    const generation = state.inFlightGeneration;
    state.flushRequested = false;
    const workerExecution = Promise.resolve().then(() => worker({ key: state.key, batch, generation, signal: state.controller.signal }));
    const execution = workerExecution.then(result => {
      if (state.cancelled || states.get(state.key) !== state) return;
      // Only success acknowledges the in-flight delta.
      state.inFlightBatch = null;
      state.completedGeneration = Math.max(state.completedGeneration, generation);
      state.retryAttempt = 0;
      state.lastResult = result;
      settleCompleted(state);
    }, async error => {
      if (state.cancelled || states.get(state.key) !== state) return;
      // Merge failed work before changes that arrived during execution. The
      // merge contract must preserve dominant flags such as fullScan.
      try {
        state.pendingBatch = merge(state.inFlightBatch, state.pendingBatch);
      } catch (mergeError) {
        state.inFlightBatch = null;
        rejectWaiters(state, mergeError);
        state.cancelled = true;
        states.delete(state.key);
        return;
      }
      state.inFlightBatch = null;
      const retryIndex = state.retryAttempt;
      state.retryAttempt += 1;
      const willRetry = retryIndex < retryDelays.length;
      // onError is an observer: wait for either sync or async settlement, but
      // never let observer failure replace the worker error or alter retry.
      await Promise.resolve().then(() => onError(error, {
        key: state.key, batch: state.pendingBatch, generation, willRetry, retryAttempt: state.retryAttempt,
      })).catch(() => undefined);
      if (state.cancelled || states.get(state.key) !== state) return;
      if (willRetry) state.nextRetryDelay = retryDelays[retryIndex];
      else rejectWaiters(state, error);
    });
    state.executionPromise = execution;
    void execution.finally(() => {
      if (state.executionPromise === execution) state.executionPromise = null;
      if (state.cancelled) {
        if (states.get(state.key) === state) states.delete(state.key);
        return;
      }
      if (states.get(state.key) !== state) return;
      if (state.nextRetryDelay != null) {
        const retryDelay = state.nextRetryDelay;
        state.nextRetryDelay = null;
        schedule(state, retryDelay);
        return;
      }
      if (hasWork(state.pendingBatch) && !state.retryTimer) {
        const retrying = state.retryAttempt > 0;
        if (!retrying) schedule(state, 0);
      }
    }).catch(error => {
      // Internal state transitions must always own their rejection.
      if (!state.cancelled && states.get(state.key) === state) {
        state.cancelled = true;
        rejectWaiters(state, error);
        states.delete(state.key);
      }
    });
    return execution;
  };

  const enqueue = (key, delta, options = {}) => {
    const normalizedKey = String(key || '');
    if (!normalizedKey) throw new TypeError('dirty runner key is required');
    if (options.signal?.aborted) throw cancelledError(normalizedKey);
    let state = states.get(normalizedKey);
    if (!state || state.cancelled) {
      const predecessor = state?.executionPromise || state?.predecessor || null;
      state = createState(normalizedKey);
      if (predecessor) {
        state.predecessor = Promise.resolve(predecessor).catch(() => undefined).then(() => {
          state.predecessor = null;
          if (state.cancelled) {
            if (states.get(normalizedKey) === state) states.delete(normalizedKey);
            return;
          }
          if (states.get(normalizedKey) !== state) return;
          if (state.flushRequested) void execute(state);
          else schedule(state, delayMs);
        });
        void state.predecessor.catch(error => {
          if (states.get(normalizedKey) !== state) return;
          state.predecessor = null;
          state.cancelled = true;
          rejectWaiters(state, error);
          states.delete(normalizedKey);
        });
      }
      states.set(normalizedKey, state);
    }
    state.pendingBatch = merge(state.pendingBatch, delta);
    state.generation += 1;
    // New external work reopens an exhausted retry cycle.
    if (!state.executionPromise && !state.retryTimer && state.retryAttempt > retryDelays.length) state.retryAttempt = 0;
    schedule(state, delayMs);
    const ticket = { key: normalizedKey, generation: state.generation, signal: options.signal || null };
    return Object.freeze(ticket);
  };

  const flush = ticket => {
    const state = states.get(String(ticket?.key || ''));
    const generation = Number(ticket?.generation) || 0;
    if (!state || state.cancelled) return Promise.reject(cancelledError(ticket?.key));
    if (state.completedGeneration >= generation) return Promise.resolve(state.lastResult);
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryAttempt = 0;
    const promise = new Promise((resolve, reject) => {
      const waiter = { generation, resolve, reject, signal: ticket?.signal, onAbort: null };
      waiter.onAbort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        reject(cancelledError(ticket?.key));
      };
      waiter.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      state.waiters.push(waiter);
    });
    if (state.predecessor) state.flushRequested = true;
    else if (!state.executionPromise) void execute(state);
    return promise;
  };

  const cancel = key => {
    const normalizedKey = String(key || '');
    const state = states.get(normalizedKey);
    if (!state) return false;
    state.cancelled = true;
    state.controller.abort();
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.pendingBatch = null;
    rejectWaiters(state, cancelledError(normalizedKey));
    if (!state.executionPromise && !state.predecessor) states.delete(normalizedKey);
    return true;
  };

  const stop = () => {
    for (const key of [...states.keys()]) cancel(key);
  };

  const pendingCount = () => [...states.values()].filter(state => (
    hasWork(state.pendingBatch) || state.inFlightBatch || state.executionPromise || state.predecessor || state.retryTimer
  )).length;

  const getState = key => {
    const state = states.get(String(key || ''));
    return state ? { ...state, waiters: state.waiters.length } : null;
  };

  return { enqueue, flush, cancel, stop, pendingCount, getState };
};

module.exports = { createDirtyCoalescingRunner };
