const assert = require('assert/strict');
const { WorkspaceSqliteCoordinator, normalizeDatabasePath } = require('../electron/services/workspace-sqlite-coordinator.cjs');
const { WorkspaceDatabaseOperationPolicy } = require('../electron/repositories/workspace-database-operation-policy.cjs');
const { CoordinatedDatabaseClient } = require('../electron/repositories/coordinated-database-client.cjs');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const run = async () => {
  const coordinator = new WorkspaceSqliteCoordinator();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const order = [];
  const first = coordinator.run({ databases: [{ path: 'C:/Data/A.sqlite3', mode: 'write' }] }, async () => {
    order.push('first');
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;
  const second = coordinator.run({ databases: [{ path: 'c:/data/../Data/A.sqlite3', mode: 'write' }] }, () => order.push('second'));
  const reader = coordinator.run({ databases: [{ path: 'C:/Data/A.sqlite3', mode: 'read' }] }, () => order.push('reader'));
  await reader;
  assert.deepEqual(order, ['first', 'reader'], 'WAL reader may overlap one writer');
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'reader', 'second'], 'same physical database has one writer');

  const exclusiveStarted = deferred();
  const releaseExclusive = deferred();
  const maintenance = coordinator.run({ databases: [{ path: 'C:/Data/A.sqlite3', mode: 'exclusive' }] }, async () => {
    exclusiveStarted.resolve();
    await releaseExclusive.promise;
  });
  await exclusiveStarted.promise;
  let entered = false;
  const blockedRead = coordinator.run({ databases: [{ path: 'C:/Data/A.sqlite3', mode: 'read' }] }, () => { entered = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(entered, false, 'exclusive blocks readers');
  releaseExclusive.resolve();
  await Promise.all([maintenance, blockedRead]);

  const policy = new WorkspaceDatabaseOperationPolicy();
  const unknown = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'legacy_action' });
  assert.equal(unknown.mode, 'write', 'unclassified actions default to write');
  assert.equal(policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'maintenance_run' }).mode, 'exclusive');
  const multi = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'media_sync_apply_batch' });
  assert.equal(new Set(multi.databases.map(item => normalizeDatabasePath(item.path))).size, 3, 'media operations acquire catalog, media, and versioning databases together');

  const retryCoordinator = new WorkspaceSqliteCoordinator();
  const attemptEvents = [];
  let attempts = 0;
  const client = new CoordinatedDatabaseClient({
    coordinator: retryCoordinator,
    operationPolicy: policy,
    getDatabasePath: () => 'C:/Data/workspace.sqlite3',
    scriptName: 'workspace_db.py',
    retryDelays: [1],
    waitForRetry: async () => {
      await retryCoordinator.run({ databases: [{ path: 'C:/Data/workspace.sqlite3', mode: 'write' }] }, () => attemptEvents.push('between-attempts'));
    },
    execute: async () => {
      attempts += 1;
      attemptEvents.push(`attempt-${attempts}`);
      if (attempts === 1) throw Object.assign(new Error('not parsed'), { code: 'SQLITE_BUSY' });
      return { success: true };
    },
  });
  assert.deepEqual(await client.call('root', 'version_tree_layout_get', {}, { timeoutMs: 1000 }), { success: true });
  assert.deepEqual(attemptEvents, ['attempt-1', 'between-attempts', 'attempt-2'], 'retry releases its lease before backoff');

  attempts = 0;
  await assert.rejects(client.call('root', 'legacy_action', {}, { timeoutMs: 1000 }), error => error.code === 'SQLITE_BUSY');
  assert.equal(attempts, 1, 'unclassified non-idempotent action is never retried');
  console.log('workspace sqlite coordinator tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
