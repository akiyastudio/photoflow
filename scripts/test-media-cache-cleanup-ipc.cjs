const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { registerMediaIpc } = require('../electron/modules/media-ipc.cjs');

const handlers = new Map();
const definitions = [];
const dismissed = [];
const sequence = [];
let releaseRecovery;
let dailyCleanupSlices = 0;
const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });

const backgroundTasks = {
  list: () => [{ id: 'legacy-daily', type: 'cache-cleanup', state: 'interrupted', metadata: { olderThanDays: 30 } }],
  run: async (definition, worker) => {
    definitions.push(definition);
    sequence.push(`task:${definition.metadata.origin}`);
    const task = {
      id: `task-${definitions.length}`,
      state: 'running',
      signal: new AbortController().signal,
      throwIfCancelled: () => undefined,
      report: () => undefined,
    };
    const result = await worker(task);
    task.state = 'completed';
    return { task, result };
  },
  dismiss: id => { dismissed.push(id); return true; },
  registerTypeRestartFactory: () => () => undefined,
};

registerMediaIpc({
  Buffer, Date, Error, Math, Number, Object, Promise, String, undefined,
  IMAGE_EXTENSIONS: new Set(['.jpg']), IMAGE_PREVIEW_CONVERSION_EXTENSIONS: new Set(),
  RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(), PRIORITY: { visible: 0 },
  approvedMediaCacheDirectories: new Set(), backgroundTasks, clearTimeout, setTimeout,
  convertedImagePreviewPath: async () => '', rawPreviewPath: async () => '',
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  exiftool: { readRaw: async () => ({}) }, findImportedVideoPreview: async () => '',
  flattenMetadataValue: () => [], fs, path, getMediaCacheDir: () => path.resolve('cache'),
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, mainWindow: null,
  mediaCacheIndexes: new Map(), mediaMetadataCache: new Map(), mediaRuntimeState: {},
  mediaService: {}, normalizeMediaCacheSizeGB: value => value, rawOrientationCorrection: async () => ({}),
  refreshMediaCacheIndex: async () => ({ totalBytes: 0, files: new Map() }), trimMediaCache: () => undefined,
  thumbnailService: {
    waitForStartupRecovery: async () => {
      sequence.push('recovery:wait');
      await recoveryGate;
      sequence.push('recovery:complete');
    },
    evictCache: async options => {
      sequence.push('cleanup:run');
      if (options.maxDetachBatches) dailyCleanupSlices += 1;
      const maintenanceComplete = !options.maxDetachBatches || dailyCleanupSlices >= 2;
      return {
        deletedCount: 1, prunedSourceCount: 1, processedCount: 2,
        detachComplete: maintenanceComplete, pruneComplete: maintenanceComplete,
        recoveryComplete: maintenanceComplete, maintenanceComplete,
        recoveryCursor: { afterRowId: dailyCleanupSlices },
      };
    },
  },
  writeLog: () => undefined,
});

(async () => {
  const clearMediaCache = handlers.get('media-cache-clear');
  assert(clearMediaCache, 'media cache cleanup IPC handler was not registered');
  assert.deepEqual(dismissed, [], 'historical cleanup migration belongs to the background task service');

  const automatic = clearMediaCache({}, {}, 30, { origin: 'daily-auto' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(definitions.length, 0, 'daily cleanup must not create a queued task while startup recovery is active');
  releaseRecovery();
  const automaticResult = await automatic;
  assert.equal(automaticResult.success, true, automaticResult.error);
  assert.deepEqual(sequence.slice(0, 5), ['recovery:wait', 'recovery:complete', 'task:daily-auto', 'cleanup:run', 'cleanup:run']);
  assert.equal(automaticResult.deletedCount, 2, 'daily cleanup must aggregate bounded maintenance slices');
  assert.equal(definitions[0].notificationPolicy, 'error-only');
  assert.equal(definitions[0].metadata.taskCenterVisibility, undefined);

  const manualResult = await clearMediaCache({}, {}, undefined);
  assert.equal(manualResult.success, true, manualResult.error);
  assert.equal(definitions[1].notificationPolicy, undefined, 'manual cleanup must keep the configured result/progress policy');
  assert.equal(definitions[1].metadata.origin, 'manual');
  assert.equal(definitions[1].metadata.taskCenterVisibility, undefined, 'manual cleanup progress must remain visible');
  assert.deepEqual(dismissed, [], 'cleanup IPC must not own history policy');
  console.log('media cache cleanup IPC tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
