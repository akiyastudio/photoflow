const assert = require('assert/strict');
const { EventEmitter } = require('events');
const path = require('path');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createThumbnailService } = require('../electron/services/thumbnail-service.cjs');

const run = async () => {
  const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
  let failRecovery = false;
  let offlineDirectory = '';
  let blockedCacheRoot = '';
  let releaseBlockedRecovery = null;
  let releaseThumbnailRequest = null;
  let thumbnailRequestCount = 0;
  let thumbnailGeneration = null;
  let partialRecoverySlices = 0;
  let timeoutRecoveryOnce = false;
  const maintenanceStates = new Map();
  const evictionOptions = [];
  const pipeline = {
    cacheDirectory: config => config.directory || 'C:/Photoflow/media-cache',
    ensureCacheDirectory: async config => {
      const directory = config.directory || 'C:/Photoflow/media-cache';
      if (directory === offlineDirectory) throw new Error('cache volume offline');
      return directory;
    },
    maintenanceState: async key => maintenanceStates.get(key) || ({ completed: false, completedAt: 0, cursor: {} }),
    saveMaintenanceState: async (key, cursor) => {
      maintenanceStates.set(key, { completed: false, completedAt: 0, cursor });
      return { cursor };
    },
    evictCache: async options => {
      evictionOptions.push(options);
      options.onAdmitted?.({ waiting: 1 });
      if (path.resolve(options.cacheRoot) === blockedCacheRoot) await new Promise(resolve => { releaseBlockedRecovery = resolve; });
      if (timeoutRecoveryOnce) {
        timeoutRecoveryOnce = false;
        throw Object.assign(new Error('Thumbnail database request timed out: recover_cache_publications'), { code: 'THUMBNAIL_DATABASE_TIMEOUT' });
      }
      if (failRecovery) throw Object.assign(new Error('simulated startup recovery failure'), { code: 'RECOVERY_TEST_FAILURE' });
      if (options.completeMigrationKey) maintenanceStates.set(options.completeMigrationKey, { completed: true, completedAt: Date.now(), cursor: { migrationVersion: 'thumbnail-cache-migration-v2' } });
      const recoveryComplete = partialRecoverySlices <= 0;
      if (partialRecoverySlices > 0) partialRecoverySlices -= 1;
      const nextCursor = { ...options.recoveryCursor, afterRowId: Number(options.recoveryCursor?.afterRowId || 0) + 128, lastCompletedAt: recoveryComplete ? Date.now() : 0 };
      maintenanceStates.set(options.completeMaintenanceKey, { completed: recoveryComplete, completedAt: recoveryComplete ? Date.now() : 0, cursor: nextCursor });
      return {
        success: true, repairedMissingCount: 2, deletedCount: 3, failedCount: 0, prunedSourceCount: 1,
        detachComplete: true, pruneComplete: true, recoveryComplete, maintenanceComplete: recoveryComplete,
        recoveryCursor: nextCursor, processedCount: 3,
      };
    },
    request: async () => {
      thumbnailRequestCount += 1;
      if (!thumbnailGeneration) thumbnailGeneration = new Promise(resolve => { releaseThumbnailRequest = resolve; });
      return { success: true, state: 'QUEUED', cacheLayer: 'source', completion: thumbnailGeneration };
    },
    cancel: () => false,
    stop: () => undefined,
  };
  const service = createThumbnailService({ pipeline, backgroundTasks });

  const thumbnailRequest = { filePath: 'C:/Photos/AKI_0001.CR3', kind: 'raw', cacheConfig: { directory: 'C:/Shared/Cache' }, requestedSize: 640, priority: 0, queueOrder: 1 };
  const firstThumbnail = service.request(thumbnailRequest);
  const duplicateThumbnail = service.request(thumbnailRequest);
  await new Promise(resolve => setImmediate(resolve));
  const activeThumbnailTasks = backgroundTasks.list().filter(task => task.type === 'thumbnail-generate');
  assert.equal(thumbnailRequestCount, 2, 'each renderer request may inspect the shared pipeline job');
  assert.equal(activeThumbnailTasks.length, 1);
  assert.equal(activeThumbnailTasks[0].state, 'running');
  assert.equal(activeThumbnailTasks[0].cancellable, false, 'internal thumbnail requests must not expose a cancel action that cannot interrupt index reads');
  assert.equal(activeThumbnailTasks[0].metadata.taskCenterVisibility, 'attention-only');
  assert.equal(activeThumbnailTasks[0].metadata.kind, 'raw');
  assert.deepEqual(activeThumbnailTasks[0].metadata.cacheConfig, thumbnailRequest.cacheConfig);
  releaseThumbnailRequest({ state: 'READY' });
  await Promise.all([firstThumbnail, duplicateThumbnail]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(backgroundTasks.list().filter(task => task.type === 'thumbnail-generate').length, 0, 'successful viewport thumbnail wrappers must not leave task history');

  thumbnailGeneration = Promise.resolve({ state: 'FAILED', error: 'simulated decoder failure' });
  await service.request({ ...thumbnailRequest, filePath: 'C:/Photos/AKI_0002.CR3' });
  await new Promise(resolve => setImmediate(resolve));
  const failedThumbnail = backgroundTasks.list().find(task => task.type === 'thumbnail-generate' && task.state === 'failed');
  assert(failedThumbnail?.retryable, 'an asynchronous decoder failure must become a retryable background failure');
  assert.match(failedThumbnail.error, /simulated decoder failure/);
  backgroundTasks.dismiss(failedThumbnail.id);

  service.activateStartupRecovery();
  const customConfig = { directory: 'C:/Shared/Cache', maxSizeGB: 50 };

  await service.recoverCache(customConfig);
  assert.equal(backgroundTasks.list().filter(task => task.type === 'thumbnail-cache-recovery').length, 0, 'successful startup recovery must not retain task history');
  assert.equal(evictionOptions[0].verifyIntegrity, true);
  assert.equal(evictionOptions[0].pruneMissing, true);
  assert.equal(evictionOptions[0].recoverOrphans, true);
  assert.equal(evictionOptions[0].scanRootOrphans, false, 'custom cache roots must not scan arbitrary root JPEGs as orphans');
  assert.equal(evictionOptions[0].completeMigrationKey, 'thumbnail-cache-migration-v2');
  assert.match(evictionOptions[0].completeMaintenanceKey, /^thumbnail-reconcile-publications-v1:/);
  assert.equal(typeof evictionOptions[0].recoveryCursor.generation, 'string');
  assert.equal(evictionOptions[0].recoveryCursor.afterRowId, 0);
  const firstGeneration = evictionOptions[0].recoveryCursor.generation;

  const evictionCount = evictionOptions.length;
  await service.recoverCache(customConfig);
  assert.equal(evictionOptions.length, evictionCount, 'a completed root/version marker must skip repeated startup repair');

  const slicedConfig = { directory: 'C:/Sliced/Cache' };
  partialRecoverySlices = 1;
  const beforeSlices = evictionOptions.length;
  await service.recoverCache(slicedConfig);
  const slicedOptions = evictionOptions.slice(beforeSlices);
  assert.equal(slicedOptions.length, 2, 'incomplete startup recovery must continue from its cursor in a new maintenance slice');
  assert.equal(slicedOptions[0].maxRecoveryPages, 1);
  assert.equal(slicedOptions[0].recoveryInspectLimit, 128);
  assert.equal(slicedOptions[0].recoveryDirectoryInspectLimit, 4096);
  assert.equal(slicedOptions[0].bumpCacheEpoch, true);
  assert.equal(slicedOptions[1].bumpCacheEpoch, false, 'continuation slices must not repeatedly invalidate the cache epoch');
  assert.equal(slicedOptions[1].pruneMissing, false, 'bounded missing-source cleanup must not restart in every continuation slice');
  assert.equal(slicedOptions[1].recoveryCursor.afterRowId, 128);

  const beforeNextLaunch = evictionOptions.length;
  const nextLaunchService = createThumbnailService({ pipeline, backgroundTasks });
  await nextLaunchService.recoverCache(customConfig);
  assert.equal(evictionOptions.length, beforeNextLaunch + 1, 'a new application launch must start a fresh reconciliation generation');
  assert.notEqual(evictionOptions.at(-1).recoveryCursor.generation, firstGeneration);
  assert.equal(evictionOptions.at(-1).verifyIntegrity, false, 'one-time migration must not repeat with each reconciliation generation');

  const recoveryCursor = { generation: 'interrupted-generation', generationMaxRowId: 4096, afterRowId: 2048, lastCompletedAt: 0, directory: { rootIndex: 1, offset: 256 } };
  const reconciliationKey = [...maintenanceStates.keys()].find(key => key.startsWith('thumbnail-reconcile-publications-v1:'));
  maintenanceStates.set(reconciliationKey, { completed: false, completedAt: 0, cursor: recoveryCursor });
  failRecovery = true;
  await assert.rejects(service.recoverCache(customConfig), /simulated startup recovery failure/);
  const failed = backgroundTasks.list().find(task => task.type === 'thumbnail-cache-recovery' && task.state === 'failed');
  assert(failed?.retryable, 'failed startup recovery must remain visible and retryable');
  const reusedFailure = service.ensureStartupRecovery(customConfig);
  await reusedFailure.admitted;
  assert.equal(reusedFailure.task.id, failed.id);
  assert.equal(backgroundTasks.list().filter(task => task.type === 'thumbnail-cache-recovery' && task.metadata?.maintenanceKey === failed.metadata.maintenanceKey).length, 1, 'ensure must reuse the failed marker instead of creating a duplicate card');
  failRecovery = false;
  const accepted = await backgroundTasks.retry(failed.id);
  await accepted.completion;
  assert.equal(backgroundTasks.get(failed.id), null);
  assert.equal(backgroundTasks.list().filter(task => task.type === 'thumbnail-cache-recovery').length, 0);
  assert.deepEqual(evictionOptions.at(-1).recoveryCursor, recoveryCursor, 'startup retry must resume from the persisted cursor');

  const activeConfig = { directory: 'C:/Active/Cache' };
  blockedCacheRoot = path.resolve(activeConfig.directory);
  const active = service.ensureStartupRecovery(activeConfig);
  await active.admitted;
  const reusedActive = service.ensureStartupRecovery(activeConfig);
  await reusedActive.admitted;
  assert.equal(reusedActive.task.id, active.task.id, 'ensure must reuse an active task for the same maintenance marker');
  assert.equal(backgroundTasks.list().filter(task => task.type === 'thumbnail-cache-recovery' && task.metadata?.maintenanceKey === active.descriptor.maintenanceKey).length, 1);
  releaseBlockedRecovery();
  await active.completion;
  blockedCacheRoot = '';

  const offlineConfig = { directory: 'Z:/Offline/Cache' };
  offlineDirectory = offlineConfig.directory;
  const offline = service.ensureStartupRecovery(offlineConfig);
  assert(backgroundTasks.get(offline.task.id), 'offline cache recovery must create its task before directory I/O');
  await assert.rejects(offline.admitted, /cache volume offline/);
  const offlineFailed = backgroundTasks.get(offline.task.id);
  assert.equal(offlineFailed.state, 'failed');
  assert.equal(offlineFailed.retryable, true);

  const timeoutConfig = { directory: 'C:/Timed/Cache' };
  timeoutRecoveryOnce = true;
  const timedOut = service.ensureStartupRecovery(timeoutConfig);
  await timedOut.admitted;
  await assert.rejects(timedOut.completion, /recover_cache_publications/);
  const timeoutFailure = backgroundTasks.list().find(task => task.type === 'thumbnail-cache-recovery'
    && task.metadata?.maintenanceKey === timedOut.descriptor.maintenanceKey && task.state === 'failed');
  assert(timeoutFailure?.retryable);
  const automaticRetry = service.ensureStartupRecovery(timeoutConfig);
  const automaticAdmission = await automaticRetry.admitted;
  assert.equal(automaticAdmission.automaticRetry, true, 'a persisted timeout must resume automatically under the sliced recovery policy');
  await automaticRetry.completion;
  assert.equal(backgroundTasks.list().filter(task => task.type === 'thumbnail-cache-recovery'
    && task.metadata?.maintenanceKey === timedOut.descriptor.maintenanceKey).length, 0);

  console.log('thumbnail startup recovery task tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
