const path = require('path');

const createVersionStaleDetectionService = ({ versionService, delayMs = 1500, writeLog = () => undefined }) => {
  const pending = new Map();
  const keyFor = (root, projectName) => `${path.resolve(root).toLocaleLowerCase()}\0${String(projectName || '').toLocaleLowerCase()}`;

  const schedule = (root, projectName, changedPaths = [], fullScan = false) => {
    if (!projectName) return;
    const key = keyFor(root, projectName);
    const previous = pending.get(key);
    if (previous?.timer) clearTimeout(previous.timer);
    const state = {
      root: path.resolve(root),
      projectName: String(projectName),
      changedPaths: new Set([...(previous?.changedPaths || []), ...changedPaths.map(value => path.resolve(value))]),
      fullScan: Boolean(fullScan || previous?.fullScan),
      timer: null,
    };
    state.timer = setTimeout(() => {
      pending.delete(key);
      void versionService.detectProgressStale(state.root, {
        projectName: state.projectName,
        changedPaths: state.fullScan ? [] : [...state.changedPaths],
      }).catch(error => {
        writeLog('warn', 'Unable to detect stale version tracking nodes', {
          projectName: state.projectName, error: error.message || String(error),
        });
      });
    }, Math.max(0, Number(delayMs) || 0));
    pending.set(key, state);
  };

  const cancel = (root, projectName) => {
    const key = keyFor(root, projectName);
    const state = pending.get(key);
    if (state?.timer) clearTimeout(state.timer);
    pending.delete(key);
  };

  const stop = () => {
    for (const state of pending.values()) if (state.timer) clearTimeout(state.timer);
    pending.clear();
  };

  return { schedule, cancel, stop, pendingCount: () => pending.size };
};

module.exports = { createVersionStaleDetectionService };
