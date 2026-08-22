const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createThumbnailService } = require('../electron/services/thumbnail-service.cjs');

const run = async () => {
  const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
  let completed = false;
  let failRecovery = false;
  const evictionOptions = [];
  const pipeline = {
    cacheDirectory: config => config.directory || 'C:/Photoflow/media-cache',
    maintenanceState: async () => ({ completed, completedAt: completed ? 123 : 0 }),
    evictCache: async options => {
      evictionOptions.push(options);
      if (failRecovery) throw Object.assign(new Error('simulated startup recovery failure'), { code: 'RECOVERY_TEST_FAILURE' });
      completed = true;
      return { success: true, repairedMissingCount: 2, deletedCount: 3, failedCount: 0, prunedSourceCount: 1 };
    },
    stop: () => undefined,
  };
  const service = createThumbnailService({ pipeline, backgroundTasks });
  const customConfig = { directory: 'C:/Shared/Cache', maxSizeGB: 50 };

  await service.recoverCache(customConfig);
  assert.equal(backgroundTasks.list().filter(task => task.type === 'thumbnail-cache-recovery').length, 0, 'successful startup recovery must not retain task history');
  assert.equal(evictionOptions[0].verifyIntegrity, true);
  assert.equal(evictionOptions[0].pruneMissing, true);
  assert.equal(evictionOptions[0].recoverOrphans, true);
  assert.equal(evictionOptions[0].scanRootOrphans, false, 'custom cache roots must not scan arbitrary root JPEGs as orphans');
  assert.match(evictionOptions[0].completeMaintenanceKey, /^thumbnail-cache-recovery-v1:/);

  const evictionCount = evictionOptions.length;
  await service.recoverCache(customConfig);
  assert.equal(evictionOptions.length, evictionCount, 'a completed root/version marker must skip repeated startup repair');

  completed = false;
  failRecovery = true;
  await assert.rejects(service.recoverCache(customConfig), /simulated startup recovery failure/);
  const failed = backgroundTasks.list().find(task => task.type === 'thumbnail-cache-recovery' && task.state === 'failed');
  assert(failed?.retryable, 'failed startup recovery must remain visible and retryable');
  failRecovery = false;
  const accepted = await backgroundTasks.retry(failed.id);
  await accepted.completion;
  assert.equal(backgroundTasks.get(failed.id), null);
  assert.equal(backgroundTasks.list().filter(task => task.type === 'thumbnail-cache-recovery').length, 0);

  console.log('thumbnail startup recovery task tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
