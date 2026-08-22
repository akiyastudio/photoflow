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
    lastResult: undefined,
  });

  const settleCompleted = state => {
    const remaining = [];
    for (const waiter of state.waiters) {
      if (waiter.generation <= state.completedGeneration) waiter.resolve(state.lastResult);
      else remaining.push(waiter);
    }
    state.waiters = remaining;
  };

  const rejectWaiters = (state, error) => {
    const waiters = state.waiters;
    state.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  };

  const schedule = (state, waitMs) => {
    if (state.cancelled || state.executionPromise || state.retryTimer || !hasWork(state.pendingBatch)) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      void execute(state);
    }, Math.max(0, Number(waitMs) || 0));
  };

  const execute = state => {
    if (state.cancelled || state.executionPromise || !hasWork(state.pendingBatch)) return state.executionPromise;
    state.inFlightBatch = state.pendingBatch;
    state.inFlightGeneration = state.generation;
    state.pendingBatch = null;
    const batch = state.inFlightBatch;
    const generation = state.inFlightGeneration;
    const execution = Promise.resolve().then(() => worker({ key: state.key, batch, generation }));
    state.executionPromise = execution;
    void execution.then(result => {
      if (state.cancelled || states.get(state.key) !== state) return;
      // Only success acknowledges the in-flight delta.
      state.inFlightBatch = null;
      state.completedGeneration = Math.max(state.completedGeneration, generation);
      state.retryAttempt = 0;
      state.lastResult = result;
      settleCompleted(state);
    }, error => {
      if (state.cancelled || states.get(state.key) !== state) return;
      // Merge failed work before changes that arrived during execution. The
      // merge contract must preserve dominant flags such as fullScan.
      state.pendingBatch = merge(state.inFlightBatch, state.pendingBatch);
      state.inFlightBatch = null;
      const retryIndex = state.retryAttempt;
      state.retryAttempt += 1;
      const willRetry = retryIndex < retryDelays.length;
      onError(error, { key: state.key, batch: state.pendingBatch, generation, willRetry, retryAttempt: state.retryAttempt });
      if (willRetry) state.nextRetryDelay = retryDelays[retryIndex];
      else rejectWaiters(state, error);
    }).finally(() => {
      if (state.executionPromise === execution) state.executionPromise = null;
      if (state.cancelled || states.get(state.key) !== state) return;
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
    });
    return execution;
  };

  const enqueue = (key, delta) => {
    const normalizedKey = String(key || '');
    if (!normalizedKey) throw new TypeError('dirty runner key is required');
    let state = states.get(normalizedKey);
    if (!state) {
      state = createState(normalizedKey);
      states.set(normalizedKey, state);
    }
    state.cancelled = false;
    state.pendingBatch = merge(state.pendingBatch, delta);
    state.generation += 1;
    // New external work reopens an exhausted retry cycle.
    if (!state.executionPromise && !state.retryTimer && state.retryAttempt > retryDelays.length) state.retryAttempt = 0;
    schedule(state, delayMs);
    return Object.freeze({ key: normalizedKey, generation: state.generation });
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
    const promise = new Promise((resolve, reject) => state.waiters.push({ generation, resolve, reject }));
    if (!state.executionPromise) void execute(state);
    return promise;
  };

  const cancel = key => {
    const normalizedKey = String(key || '');
    const state = states.get(normalizedKey);
    if (!state) return false;
    state.cancelled = true;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.pendingBatch = null;
    rejectWaiters(state, cancelledError(normalizedKey));
    states.delete(normalizedKey);
    return true;
  };

  const stop = () => {
    for (const key of [...states.keys()]) cancel(key);
  };

  const pendingCount = () => [...states.values()].filter(state => (
    hasWork(state.pendingBatch) || state.inFlightBatch || state.executionPromise || state.retryTimer
  )).length;

  const getState = key => {
    const state = states.get(String(key || ''));
    return state ? { ...state, waiters: state.waiters.length } : null;
  };

  return { enqueue, flush, cancel, stop, pendingCount, getState };
};

module.exports = { createDirtyCoalescingRunner };
