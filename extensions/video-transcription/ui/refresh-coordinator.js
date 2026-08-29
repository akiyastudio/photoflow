(function exposeRefreshCoordinator(root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.VideoTranscriptionRefreshCoordinator = model;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';
  const createRefreshCoordinator = ({ refresh, debounceMs = 400, pollMs = 3000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) => {
    let active = false; let debounceTimer = 0; let pollTimer = 0; let inFlight = false; let queued = false;
    const execute = async () => {
      if (!active) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      try { await refresh(); }
      finally {
        inFlight = false;
        if (active && queued) { queued = false; void execute(); }
      }
    };
    const request = ({ immediate = false } = {}) => {
      if (!active) return;
      if (immediate) { if (debounceTimer) clearTimeoutFn(debounceTimer); debounceTimer = 0; void execute(); return; }
      if (debounceTimer) return;
      debounceTimer = setTimeoutFn(() => { debounceTimer = 0; void execute(); }, debounceMs);
    };
    return {
      request,
      event() { request(); },
      activate() { if (active) return; active = true; pollTimer = setIntervalFn(() => request({ immediate: true }), pollMs); request({ immediate: true }); },
      deactivate() { active = false; queued = false; if (debounceTimer) clearTimeoutFn(debounceTimer); if (pollTimer) clearIntervalFn(pollTimer); debounceTimer = 0; pollTimer = 0; },
      inspect() { return { active, inFlight, queued, debouncing: Boolean(debounceTimer) }; },
    };
  };
  return { createRefreshCoordinator };
});
