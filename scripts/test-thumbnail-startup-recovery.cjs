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
      if (failRecovery) throw Object.assign(new Error('simulated startup recovery failure'), { code: 'RECOVERY_TEST_FAILURE' });
      if (options.completeMigrationKey) maintenanceStates.set(options.completeMigrationKey, { completed: true, completedAt: Date.now(), cursor: { migrationVersion: 'thumbnail-cache-migration-v2' } });
      maintenanceStates.set(options.completeMaintenanceKey, {
        completed: true,
        completedAt: Date.now(),
        cursor: { ...options.recoveryCursor, lastCompletedAt: Date.now() },
      });
      return { success: true, repairedMissingCount: 2, deletedCount: 3, failedCount: 0, prunedSourceCount: 1 };
    },
    stop: () => undefined,
  };
  const service = createThumbnailService({ pipeline, backgroundTasks });
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

  const nextLaunchService = createThumbnailService({ pipeline, backgroundTasks });
  await nextLaunchService.recoverCache(customConfig);
  assert.equal(evictionOptions.length, evictionCount + 1, 'a new application launch must start a fresh reconciliation generation');
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

  console.log('thumbnail startup recovery task tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
