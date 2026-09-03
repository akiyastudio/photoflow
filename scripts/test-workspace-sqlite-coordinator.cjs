const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { WorkspaceSqliteCoordinator, normalizeDatabasePath } = require('../electron/services/workspace-sqlite-coordinator.cjs');
const { WorkspaceDatabaseOperationPolicy, CONFIRMED_READ_ACTIONS, DURABLE_PUBLICATION_ACTIONS, domainDatabasePath } = require('../electron/repositories/workspace-database-operation-policy.cjs');
const { CoordinatedDatabaseClient } = require('../electron/repositories/coordinated-database-client.cjs');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const deadline = (promise, label, milliseconds = 1000) => Promise.race([
  promise,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), milliseconds)),
]);

const run = async () => {
  const pythonSource = fs.readFileSync(path.join(__dirname, '..', 'python', 'workspace_db.py'), 'utf8');
  const durableBlocks = ['MEDIA_DURABLE_ACTIONS', 'BATCH_CROSS_DOMAIN_DURABLE_ACTIONS'].map(name => {
    const match = pythonSource.match(new RegExp(`${name} = frozenset\\(\\(([\\s\\S]*?)\\n\\)\\)`));
    assert(match, `${name} must remain discoverable for the cross-runtime publication contract`);
    return [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map(item => item[1]);
  }).flat();
  assert.deepEqual(new Set(DURABLE_PUBLICATION_ACTIONS), new Set(durableBlocks), 'Node coordinator exclusivity must cover exactly the Python staged-publication actions');
  const coordinatedReadBlock = pythonSource.match(/COORDINATED_READ_ONLY_ACTIONS = frozenset\(\(([\s\S]*?)\n\)\)/);
  assert(coordinatedReadBlock, 'the Python coordinated-read fallback contract must remain discoverable');
  const coordinatedReadActions = [...coordinatedReadBlock[1].matchAll(/"([a-z0-9_]+)"/g)].map(item => item[1]);
  assert.deepEqual(new Set(CONFIRMED_READ_ACTIONS), new Set(coordinatedReadActions), 'Node read leases and Python write-fallback guards must cover exactly the same actions');
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

  const priorityCoordinator = new WorkspaceSqliteCoordinator();
  const backgroundStarted = deferred();
  let rejectBackground;
  const background = priorityCoordinator.run({
    databases: [{ path: 'C:/Data/Priority.sqlite3', mode: 'write' }],
    priority: -10,
    preemptible: true,
    onPreempt: error => rejectBackground(error),
  }, () => new Promise((_resolve, reject) => {
    rejectBackground = reject;
    backgroundStarted.resolve();
  }));
  await backgroundStarted.promise;
  let foregroundEntered = false;
  const foreground = priorityCoordinator.run({
    databases: [{ path: 'C:/Data/Priority.sqlite3', mode: 'write' }], priority: 0,
  }, () => { foregroundEntered = true; });
  await assert.rejects(background, error => error?.code === 'DATABASE_PREEMPTED');
  await foreground;
  assert.equal(foregroundEntered, true, 'foreground database work must preempt an active low-priority scan');

  const queuedPriorityCoordinator = new WorkspaceSqliteCoordinator();
  const releaseQueuedBlocker = deferred();
  const queuedBlockerStarted = deferred();
  const queuedOrder = [];
  const queuedBlocker = queuedPriorityCoordinator.run({
    databases: [{ path: 'C:/Data/QueuedPriority.sqlite3', mode: 'write' }], priority: 0,
  }, async () => { queuedBlockerStarted.resolve(); await releaseQueuedBlocker.promise; });
  await queuedBlockerStarted.promise;
  const queuedBackground = queuedPriorityCoordinator.run({
    databases: [{ path: 'C:/Data/QueuedPriority.sqlite3', mode: 'write' }], priority: -10,
  }, () => queuedOrder.push('background'));
  const queuedForeground = queuedPriorityCoordinator.run({
    databases: [{ path: 'C:/Data/QueuedPriority.sqlite3', mode: 'write' }], priority: 0,
  }, () => queuedOrder.push('foreground'));
  releaseQueuedBlocker.resolve();
  await Promise.all([queuedBlocker, queuedBackground, queuedForeground]);
  assert.deepEqual(queuedOrder, ['foreground', 'background'], 'queued foreground work must jump ahead of older background maintenance');

  const policy = new WorkspaceDatabaseOperationPolicy();
  const clientPriorityCoordinator = new WorkspaceSqliteCoordinator();
  const backgroundClientStarted = deferred();
  const backgroundClient = new CoordinatedDatabaseClient({
    coordinator: clientPriorityCoordinator,
    operationPolicy: policy,
    getDatabasePath: () => 'C:/Data/ClientPriority.sqlite3',
    scriptName: 'workspace_db.py',
    execute: ({ signal }) => new Promise((_resolve, reject) => {
      backgroundClientStarted.resolve();
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }),
  });
  const foregroundClient = new CoordinatedDatabaseClient({
    coordinator: clientPriorityCoordinator,
    operationPolicy: policy,
    getDatabasePath: () => 'C:/Data/ClientPriority.sqlite3',
    scriptName: 'workspace_db.py',
    execute: async () => 'foreground-client',
  });
  const backgroundCall = backgroundClient.call('C:/workspace', 'media_sync_prepare', {}, { priority: -10, preemptible: true });
  await backgroundClientStarted.promise;
  const foregroundCall = foregroundClient.call('C:/workspace', 'tracking_prepare', {});
  await assert.rejects(deadline(backgroundCall, 'background client preemption'), error => error?.code === 'DATABASE_PREEMPTED');
  assert.equal(await deadline(foregroundCall, 'foreground client admission'), 'foreground-client', 'foreground clients must preempt active low-priority calls across database workers');

  const unknown = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'legacy_action' });
  assert.equal(unknown.mode, 'write', 'unclassified actions default to write');
  assert.equal(policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'maintenance_run' }).mode, 'exclusive');
  const multi = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'media_sync_apply_batch' });
  assert.equal(new Set(multi.databases.map(item => normalizeDatabasePath(item.path))).size, 3, 'media operations acquire catalog, media, and versioning databases together');
  assert(multi.databases.every(database => database.mode === 'exclusive'), 'staged media publication must exclude readers across every database it replaces');
  const progressLocations = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'progress_locations_snapshot' });
  assert.equal(progressLocations.idempotent, true, 'location synchronization retains its existing retry-safe semantics');
  assert.equal(progressLocations.mode, 'write', 'location synchronization must not enter the JS confirmed-read allowlist');
  assert(progressLocations.databases.every(database => database.mode === 'write'), 'catalog and versioning must both retain writer leases because domain attachment and location identity mutate state');
  assert.deepEqual(new Set(progressLocations.databases.map(item => normalizeDatabasePath(item.path))), new Set([
    'C:/Data/workspace.sqlite3', domainDatabasePath('C:/Data/workspace.sqlite3', 'versioning'),
  ].map(normalizeDatabasePath)), 'location synchronization locks catalog and versioning only');
  const deleteScope = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'media_version_delete_scope' });
  assert.equal(deleteScope.mode, 'read', 'version delete scope is a pure preflight query');
  assert.equal(deleteScope.idempotent, false, 'pure queries do not need durable write-operation receipts');
  assert(deleteScope.databases.every(database => database.mode === 'read'));
  const stalePrepare = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'progress_stale_prepare' });
  assert.equal(stalePrepare.mode, 'read', 'stale preparation uses a revision-checked read-only snapshot');
  assert(stalePrepare.databases.every(database => database.mode === 'read'));
  const layoutGet = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'version_tree_layout_get' });
  assert.equal(layoutGet.mode, 'read', 'version-tree layout loading is an audited query-only operation');
  assert(layoutGet.databases.every(database => database.mode === 'read'));
  const progressSnapshot = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'progress_snapshot' });
  assert.equal(progressSnapshot.mode, 'read', 'the first version-tree paint uses a query-only progress snapshot');
  const staleOverlapCoordinator = new WorkspaceSqliteCoordinator();
  const staleStarted = deferred(); const releaseStale = deferred();
  const staleRead = staleOverlapCoordinator.run({ databases: stalePrepare.databases }, async () => {
    staleStarted.resolve(); await releaseStale.promise;
  });
  await staleStarted.promise;
  let foregroundVersionTreeEntered = false;
  await staleOverlapCoordinator.run({ databases: progressLocations.databases }, () => { foregroundVersionTreeEntered = true; });
  assert.equal(foregroundVersionTreeEntered, true, 'a long stale scan must not block the foreground version-tree location refresh');
  releaseStale.resolve(); await staleRead;
  const layoutOverlapCoordinator = new WorkspaceSqliteCoordinator();
  const writerStarted = deferred(); const releaseWriter = deferred();
  const activeVersionWriter = layoutOverlapCoordinator.run({ databases: progressLocations.databases }, async () => {
    writerStarted.resolve(); await releaseWriter.promise;
  });
  await writerStarted.promise;
  let layoutReadEntered = false;
  await layoutOverlapCoordinator.run({ databases: layoutGet.databases }, () => { layoutReadEntered = true; });
  assert.equal(layoutReadEntered, true, 'layout loading must enter immediately while an unrelated versioning writer is active');
  releaseWriter.resolve(); await activeVersionWriter;
  const promotedAttempts = [];
  const promotionClient = new CoordinatedDatabaseClient({
    coordinator: new WorkspaceSqliteCoordinator(),
    operationPolicy: policy,
    getDatabasePath: () => 'C:/Data/workspace.sqlite3',
    scriptName: 'workspace_db.py',
    execute: async request => {
      promotedAttempts.push({ modes: request.databases.map(database => database.mode), payload: request.payload });
      if (promotedAttempts.length === 1) throw Object.assign(new Error('initialization required'), { code: 'DATABASE_WRITE_REQUIRED' });
      return { success: true };
    },
  });
  assert.deepEqual(await promotionClient.call('root', 'version_tree_layout_get', {}, { timeoutMs: 1000 }), { success: true });
  assert.deepEqual(promotedAttempts.map(attempt => attempt.modes), [['read', 'read'], ['write', 'write']], 'a read requiring initialization must release its read lease and retry under writer leases');
  assert.equal(promotedAttempts[1].payload._coordinatorWriteFallback, true, 'only the promoted writer attempt may authorize Python write fallback');
  assert.equal(policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'batch_commit_compare' }).idempotent, false,
    'batch compare timeout remains OUTCOME_UNKNOWN unless the caller supplies the same operationId');
  const mediaPath = domainDatabasePath('C:/Data/workspace.sqlite3', 'media');
  const mediaIsolationCoordinator = new WorkspaceSqliteCoordinator();
  const mediaWriterStarted = deferred(); const releaseMediaWriter = deferred();
  const mediaWriter = mediaIsolationCoordinator.run({ databases: [{ path: mediaPath, mode: 'write' }] }, async () => { mediaWriterStarted.resolve(); await releaseMediaWriter.promise; });
  await mediaWriterStarted.promise;
  let locationEntered = false;
  await mediaIsolationCoordinator.run({ databases: progressLocations.databases }, () => { locationEntered = true; });
  assert.equal(locationEntered, true, 'an active media writer must not block the versioning-only location snapshot');
  releaseMediaWriter.resolve(); await mediaWriter;
  mediaIsolationCoordinator.quarantine([{ path: mediaPath, mode: 'write' }], new Error('media unavailable'));
  assert.equal(await mediaIsolationCoordinator.run({ databases: progressLocations.databases }, () => 'location-ok'), 'location-ok', 'media quarantine must not reject the versioning-only location snapshot');
  const recreateProject = policy.classify({ database: 'C:/Data/workspace.sqlite3', action: 'add' });
  assert.deepEqual(new Set(recreateProject.databases.map(item => normalizeDatabasePath(item.path))), new Set([
    'C:/Data/workspace.sqlite3',
    domainDatabasePath('C:/Data/workspace.sqlite3', 'media'),
    domainDatabasePath('C:/Data/workspace.sqlite3', 'versioning'),
  ].map(normalizeDatabasePath)), 'project creation coordinates only the core catalog, media, and versioning stores');

  const componentStorageCoordinator = new WorkspaceSqliteCoordinator();
  const coreStarted = deferred(); const releaseCore = deferred();
  const coreWrite = componentStorageCoordinator.run({ databases: recreateProject.databases }, async () => {
    coreStarted.resolve(); await releaseCore.promise;
  });
  await coreStarted.promise;
  const componentStoragePath = 'C:/Data/components/fixture-component/projects/project-1/storage.sqlite3';
  let isolatedComponentEntered = false;
  await componentStorageCoordinator.run({ databases: [{ path: componentStoragePath, mode: 'write' }] }, () => { isolatedComponentEntered = true; });
  assert.equal(isolatedComponentEntered, true, 'component.storage remains independent from core workspace database leases');
  releaseCore.resolve(); await coreWrite;

  const componentStarted = deferred(); const releaseComponent = deferred(); const componentOrder = [];
  const firstComponentWrite = componentStorageCoordinator.run({ databases: [{ path: componentStoragePath, mode: 'write' }] }, async () => {
    componentOrder.push('first'); componentStarted.resolve(); await releaseComponent.promise;
  });
  await componentStarted.promise;
  const secondComponentWrite = componentStorageCoordinator.run({ databases: [{ path: 'C:/Data/components/fixture-component/projects/../projects/project-1/storage.sqlite3', mode: 'write' }] }, () => componentOrder.push('second'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(componentOrder, ['first'], 'component-private storage serializes writers by canonical database path');
  releaseComponent.resolve(); await Promise.all([firstComponentWrite, secondComponentWrite]);
  assert.deepEqual(componentOrder, ['first', 'second']);

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

  const remainingCoordinator = new WorkspaceSqliteCoordinator();
  const blockerStarted = deferred();
  const unblock = deferred();
  const blocker = remainingCoordinator.run({ databases: [{ path: 'C:/Data/workspace.sqlite3', mode: 'write' }] }, async () => {
    blockerStarted.resolve();
    await unblock.promise;
  });
  await blockerStarted.promise;
  let activeOptions = null;
  const activeSignal = new AbortController().signal;
  const remainingClient = new CoordinatedDatabaseClient({
    coordinator: remainingCoordinator,
    operationPolicy: policy,
    getDatabasePath: () => 'C:/Data/workspace.sqlite3',
    scriptName: 'workspace_db.py',
    execute: async options => { activeOptions = options; return true; },
  });
  const queuedAt = Date.now();
  const queuedCall = remainingClient.call('root', 'legacy_action', {}, { timeoutMs: 200, signal: activeSignal });
  await new Promise(resolve => setTimeout(resolve, 30));
  unblock.resolve();
  await Promise.all([blocker, queuedCall]);
  assert(activeOptions.signal && !activeOptions.signal.aborted, 'the combined caller/preemption AbortSignal must reach the active database request');
  assert(activeOptions.deadlineAt >= queuedAt + 150 && activeOptions.deadlineAt <= queuedAt + 250);
  assert(activeOptions.timeoutMs < 190, 'active request receives only the deadline remaining after coordinator queueing');

  const expiredCoordinator = new WorkspaceSqliteCoordinator();
  const expiredBlockerStarted = deferred(); const releaseExpiredBlocker = deferred();
  const expiredBlocker = expiredCoordinator.run({ databases: [{ path: 'C:/Data/expired.sqlite3', mode: 'write' }] }, async () => {
    expiredBlockerStarted.resolve(); await releaseExpiredBlocker.promise;
  });
  await expiredBlockerStarted.promise;
  let expiredExecutions = 0;
  const expiredClient = new CoordinatedDatabaseClient({
    coordinator: expiredCoordinator, operationPolicy: policy,
    getDatabasePath: () => 'C:/Data/expired.sqlite3', scriptName: 'workspace_db.py',
    execute: async () => { expiredExecutions += 1; },
  });
  await assert.rejects(
    expiredClient.call('root', 'legacy_action', {}, { timeoutMs: 15 }),
    error => error.code === 'DATABASE_COORDINATOR_TIMEOUT',
  );
  assert.equal(expiredExecutions, 0, 'a request that expires in the single-flight/lease queue must never reach or terminate the worker');
  releaseExpiredBlocker.resolve(); await expiredBlocker;

  const quarantineCoordinator = new WorkspaceSqliteCoordinator();
  quarantineCoordinator.quarantine([{ path: 'C:/Data/quarantined.sqlite3', mode: 'exclusive' }], new Error('termination failed'));
  await assert.rejects(
    quarantineCoordinator.run({ databases: [{ path: 'C:/Data/quarantined.sqlite3', mode: 'write' }] }, () => undefined),
    error => error.code === 'DATABASE_QUARANTINED',
  );
  assert.equal(await quarantineCoordinator.run({ databases: [{ path: 'C:/Data/quarantined.sqlite3', mode: 'read' }] }, () => 'readable'), 'readable');
  console.log('workspace sqlite coordinator tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
