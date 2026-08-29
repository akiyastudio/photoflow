(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VideoTranscriptionSettingsSave = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';
  const createDebouncedSerialSaver = ({ save, onState, delay = 350, maxWait = 1200, setTimer = setTimeout, clearTimer = clearTimeout }) => {
    let debounceTimer;
    let maxTimer;
    let pending;
    let running = false;
    let revision = 0;
    const clearTimers = () => {
      if (debounceTimer !== undefined) clearTimer(debounceTimer);
      if (maxTimer !== undefined) clearTimer(maxTimer);
      debounceTimer = undefined;
      maxTimer = undefined;
    };
    const drain = async () => {
      clearTimers();
      if (running || !pending) return;
      const job = pending;
      pending = undefined;
      running = true;
      onState?.('saving', job.revision);
      try {
        const result = await save(job.value, job.revision);
        onState?.('saved', job.revision, result);
      } catch (error) {
        onState?.('failed', job.revision, error);
      } finally {
        running = false;
        if (pending) void drain();
      }
    };
    const schedule = value => {
      revision += 1;
      pending = { value, revision };
      if (debounceTimer !== undefined) clearTimer(debounceTimer);
      debounceTimer = setTimer(() => void drain(), delay);
      if (maxTimer === undefined) maxTimer = setTimer(() => void drain(), maxWait);
      return revision;
    };
    return { schedule, flush: () => void drain(), getRevision: () => revision };
  };
  return { createDebouncedSerialSaver };
});
