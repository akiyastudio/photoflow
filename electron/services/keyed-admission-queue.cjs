const admissionError = (code, message) => Object.assign(new Error(message), { code });

const createKeyedAdmissionQueue = () => {
  const states = new Map();
  let stopped = false;

  const acquire = (rawKey, options = {}) => {
    const key = String(rawKey || '');
    if (!key) return Promise.reject(admissionError('ADMISSION_KEY_REQUIRED', 'admission key is required'));
    if (stopped) return Promise.reject(admissionError('ADMISSION_QUEUE_STOPPED', 'admission queue is stopped'));
    if (options.signal?.aborted) return Promise.reject(admissionError('ADMISSION_CANCELLED', `admission cancelled: ${key}`));
    let state = states.get(key);
    if (!state) {
      state = { active: true, waiters: [] };
      states.set(key, state);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal: options.signal, onAbort: null };
      waiter.onAbort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        reject(admissionError('ADMISSION_CANCELLED', `admission cancelled: ${key}`));
      };
      options.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      state.waiters.push(waiter);
    });
  };

  const release = rawKey => {
    const key = String(rawKey || '');
    const state = states.get(key);
    if (!state) return false;
    while (state.waiters.length) {
      const waiter = state.waiters.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) continue;
      waiter.resolve();
      return true;
    }
    states.delete(key);
    return true;
  };

  const stop = () => {
    stopped = true;
    for (const [key, state] of states) {
      const waiting = state.waiters.splice(0);
      for (const waiter of waiting) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.reject(admissionError('ADMISSION_QUEUE_STOPPED', `admission queue stopped: ${key}`));
      }
      if (!state.active) states.delete(key);
    }
  };

  const waitingCount = rawKey => states.get(String(rawKey || ''))?.waiters.length || 0;
  return { acquire, release, stop, waitingCount };
};

module.exports = { createKeyedAdmissionQueue };
