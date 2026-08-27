const assert = require('assert/strict');
const { migrateBackgroundTaskPayload } = require('../electron/services/background-task-migrations.cjs');
const { resolveBackgroundTaskPolicy } = require('../electron/services/background-task-policies.cjs');
const { BACKGROUND_TASK_PERSISTENCE_VERSION, MEDIA_RESCAN_POLICY_VERSION } = require('../electron/services/background-task-policy-versions.cjs');

const record = (id, type, state = 'interrupted', metadata = {}, extra = {}) => ({
  id, type, state, metadata, createdAt: 1, updatedAt: 2, startedAt: 1, finishedAt: 0, ...extra,
});
const input = { version: 2, tasks: [
  record('thumbnail', 'thumbnail-generate'),
  record('maintenance', 'workspace-database-maintenance', 'running'),
  record('legacy-cleanup', 'cache-cleanup', 'interrupted', { olderThanDays: 30 }),
  record('auto-cleanup', 'cache-cleanup', 'interrupted', { origin: 'daily-auto', olderThanDays: 30 }),
  record('manual-cleanup', 'cache-cleanup', 'interrupted', { origin: 'manual', olderThanDays: 30 }),
  record('restart-recovery', 'thumbnail-cache-recovery'),
  record('retained-scan', 'storage-usage-scan'),
  record('legacy-incremental', 'version-media-rescan', 'interrupted', { fullScan: false }),
  record('explicit-full', 'version-media-rescan', 'interrupted', { fullScan: true }),
  record('v2-incremental', 'version-media-rescan', 'interrupted', { fullScan: false, mediaRescanPolicyVersion: MEDIA_RESCAN_POLICY_VERSION }),
  record('failed-auto', 'cache-cleanup', 'failed', { origin: 'daily-auto' }),
  record('retry-source', 'thumbnail-generate', 'failed', {}, { replacedByTaskId: 'retry', retryPending: true }),
  record('retry', 'thumbnail-generate', 'failed', {}, { retryOfTaskId: 'retry-source' }),
  null, {}, { id: '', type: 'bad' },
] };
const migrated = migrateBackgroundTaskPayload(input);
assert.equal(migrated.version, BACKGROUND_TASK_PERSISTENCE_VERSION);
assert.deepEqual(migrated.tasks.map(task => task.id), ['manual-cleanup', 'restart-recovery', 'retained-scan', 'explicit-full', 'v2-incremental', 'failed-auto', 'retry-source', 'retry']);
assert.equal(migrated.tasks.find(task => task.id === 'retry-source').replacedByTaskId, 'retry');
assert.equal(migrated.tasks.find(task => task.id === 'retry').retryOfTaskId, 'retry-source');
assert.deepEqual(migrateBackgroundTaskPayload(migrated), migrated, 'migration must be idempotent');
assert.deepEqual(migrateBackgroundTaskPayload({ version: 2, tasks: ['bad', 1, null] }), { version: BACKGROUND_TASK_PERSISTENCE_VERSION, tasks: [] }, 'invalid task data must be ignored safely');
assert.equal(resolveBackgroundTaskPolicy({ type: 'thumbnail-generate' }).taskCenterPolicy, 'attention-only');
assert.equal(resolveBackgroundTaskPolicy({ type: 'project-file-operation' }).notificationPolicy, 'progress-and-result', 'project file operations must keep one toast from progress through the terminal result');
assert.equal(resolveBackgroundTaskPolicy({ type: 'thumbnail-generate', taskCenterPolicy: 'always', resumePolicy: 'atomic', notificationPolicy: 'progress-toast' }).taskCenterPolicy, 'attention-only', 'registered central policy must override persisted presentation fields');
assert.equal(resolveBackgroundTaskPolicy({ type: 'thumbnail-generate', resumePolicy: 'atomic' }).resumePolicy, 'safe-restart');
assert.equal(resolveBackgroundTaskPolicy({ type: 'cache-cleanup', metadata: { origin: 'daily-auto' } }).taskCenterPolicy, 'attention-only');
assert.equal(resolveBackgroundTaskPolicy({ type: 'cache-cleanup', metadata: { origin: 'manual' } }).taskCenterPolicy, 'always');
const normalizedCentral = migrateBackgroundTaskPayload({ tasks: [record('old-policy', 'thumbnail-generate', 'failed', 'bad-metadata', {
  taskCenterPolicy: 'always', resumePolicy: 'atomic', notificationPolicy: 'progress-toast',
})] }).tasks[0];
assert.equal(normalizedCentral.taskCenterPolicy, 'attention-only');
assert.equal(normalizedCentral.resumePolicy, 'safe-restart');
assert.equal(normalizedCentral.notificationPolicy, 'error-only');
assert.deepEqual(normalizedCentral.metadata, {});
const normalizedExternal = migrateBackgroundTaskPayload({ tasks: [record('external', 'plugin-external-task', 'completed', {}, {
  taskCenterPolicy: 'hidden', resumePolicy: 'checkpoint', notificationPolicy: 'result-only',
})] }).tasks[0];
assert.equal(normalizedExternal.taskCenterPolicy, 'hidden', 'unregistered external task types may retain explicit policy');
const normalizedProgressAndResult = migrateBackgroundTaskPayload({ tasks: [record('external-progress-result', 'plugin-external-task', 'completed', {}, {
  notificationPolicy: 'progress-and-result',
})] }).tasks[0];
assert.equal(normalizedProgressAndResult.notificationPolicy, 'progress-and-result', 'the combined progress/result policy must survive persistence migration');
const invalidExternalPolicy = migrateBackgroundTaskPayload({ tasks: [record('external-normalized', 'plugin-external-task', 'completed', [], {
  taskCenterPolicy: 'invalid', resumePolicy: 'invalid', notificationPolicy: 'invalid',
})] }).tasks[0];
assert.equal(invalidExternalPolicy.taskCenterPolicy, 'always');
assert.equal(invalidExternalPolicy.resumePolicy, 'atomic');
assert.equal(invalidExternalPolicy.notificationPolicy, 'error-only');
assert.deepEqual(invalidExternalPolicy.metadata, {});
assert.deepEqual(migrateBackgroundTaskPayload({ tasks: [
  record('bad-state', 'cache-cleanup', 'nonsense'), { id: 'bad\n', type: 'cache-cleanup', state: 'failed' },
  { id: 'bad-type', type: 'cache\ncleanup', state: 'failed' },
] }).tasks, [], 'invalid IDs, types and states must be discarded');
console.log('background task migration tests passed');
