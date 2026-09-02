const assert = require('assert/strict');
const path = require('path');
const { createWorkspaceWatcherRuntime } = require('../electron/services/workspace-watcher-runtime.cjs');

const run = async () => {
  let watchCallback;
  let errorCallback;
  let watcherClosed = 0;
  const sent = [];
  const scheduled = [];
  const cancelled = [];
  const discarded = [];
  const resets = [];
  const root = path.resolve('workspace-fixture');
  const catalogs = new Map([[root, {
    projects: [{ name: 'Project', relative_path: 'Project', status: '后期中', extra_json: '{}' }],
  }]]);
  const fs = {
    watch(_root, options, callback) {
      assert.equal(options.recursive, true);
      watchCallback = callback;
      return {
        close: () => { watcherClosed += 1; },
        on: (event, callbackValue) => { if (event === 'error') errorCallback = callbackValue; },
      };
    },
  };
  const runtime = createWorkspaceWatcherRuntime({
    fs,
    path,
    platform: 'win32',
    backgroundTasks: {},
    catalogs,
    reconcileCatalogDirect: async () => catalogs.get(root),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }),
    getThumbnailService: () => null,
    getFileRootWatcherService: () => ({ discardChangesInside: target => discarded.push(target) }),
    getMediaCacheConfig: () => ({ maxSizeGB: 50 }),
    getMediaTrackingScanScheduler: () => ({
      schedule: (...args) => scheduled.push(args),
      cancel: (...args) => cancelled.push(args),
      stop: () => scheduled.push(['stopped']),
    }),
    versionStaleDetectionService: { stop: () => scheduled.push(['version-stopped']) },
    isInternalChange: fileName => String(fileName).startsWith('.internal'),
    describeActionableChanges: (_root, entries) => entries.map(([name, eventType]) => ({
      path: path.join(root, name), eventType, kind: 'file',
    })),
    forgetMissingChanges: () => undefined,
    recordActionableEntry: (changes, _known, _root, name, eventType) => changes.set(name, eventType),
    createReconcileTask: options => ({ run: options.reconcileWorkspaceCatalog, reset: () => resets.push(true) }),
    writeLog: () => undefined,
  });

  runtime.watch(root);
  assert.equal(typeof watchCallback, 'function');
  runtime.suppressWorkspaceWatchPath(path.join(root, 'Project', 'suppressed'));
  assert.deepEqual(discarded, [path.join(root, 'Project', 'suppressed')]);
  watchCallback('change', path.join('Project', 'suppressed', 'one.jpg'));
  watchCallback('rename', path.join('Project', 'fresh.jpg'));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(scheduled.length, 1);
  assert.deepEqual(scheduled[0].slice(0, 2), [root, 'Project']);
  assert(sent.some(([channel, payload]) => channel === 'workspace-files-changed' && payload.fileName === path.join('Project', 'fresh.jpg')));

  errorCallback(new Error('fixture stopped'));
  assert(sent.some(([channel, payload]) => channel === 'workspace-projects-changed' && payload.root === root));
  runtime.watch(root);
  runtime.stop(true);
  assert(watcherClosed >= 2);
  assert.deepEqual(cancelled, [[root, 'Project']]);
  assert.equal(resets.length, 3);
  assert(scheduled.some(([event]) => event === 'stopped'));
  assert(scheduled.some(([event]) => event === 'version-stopped'));
  console.log('workspace watcher runtime tests passed');
};

run().catch(error => { console.error(error); process.exitCode = 1; });
