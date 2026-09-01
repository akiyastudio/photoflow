const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { normalizeProjectDate, readProjectDate } = require('../electron/modules/workspace/project-date.cjs');
const { normalizeProjectFileListFilter } = require('../electron/modules/workspace/file-list-contract.cjs');
const { createDeletedProjectCleanup } = require('../electron/modules/workspace/deleted-project-cleanup.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-workspace-transaction-'));
const workspaceIdFor = root => crypto.createHash('sha256').update(fs.realpathSync.native(path.resolve(root))).digest('hex').slice(0, 32);
const persistentClaimPath = (root, id) => {
  const canonicalRoot = fs.realpathSync.native(path.resolve(root));
  const directory = path.join(canonicalRoot, '.photoflow-undo-claims'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const digest = crypto.createHash('sha256').update(`${workspaceIdFor(root)}\0${id}`).digest('hex');
  return path.join(directory, `${digest}.json`);
};
const claimMarkers = root => [
  ...fs.readdirSync(root).filter(name => name.startsWith('.photoflow-undo-claim-')),
  ...fs.existsSync(path.join(root, '.photoflow-undo-claims')) ? fs.readdirSync(path.join(root, '.photoflow-undo-claims')) : [],
];
const writeClaimMarker = (root, id, { kind = 'trash', createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), body } = {}) => {
  const markerPath = persistentClaimPath(root, id);
  fs.writeFileSync(markerPath, body === undefined ? `${JSON.stringify({ schema: 2, workspaceId: workspaceIdFor(root), id, kind, createdAt, nonce: crypto.randomUUID() })}\n` : body);
  return markerPath;
};
const writeLegacyClaimMarker = (root, id, options = {}) => {
  const createdAt = options.createdAt || new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const digest = crypto.createHash('sha256').update(`legacy-path\0${id}`).digest('hex');
  const markerPath = path.join(root, `.photoflow-undo-claim-${digest}.json`);
  fs.writeFileSync(markerPath, options.body === undefined ? `${JSON.stringify({ schema: 1, id, kind: options.kind || 'trash', createdAt, nonce: crypto.randomUUID() })}\n` : options.body);
  return markerPath;
};
const context = (handlers, overrides = {}) => {
  const result = ({
  Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto, fs, path,
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, WORKSPACE_STATUSES: ['策划中'],
  HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(),
  cleanProjectName: value => String(value || '').trim(), ensureWorkspace: value => path.resolve(value),
  persistentUndoWorkspaceId: async root => workspaceIdFor(root),
  getProjectPath: (root, _status, name) => path.join(root, name), getWorkspaceDataRoot: root => path.join(root, '.data'),
  assertInside: (root, candidate) => { const relative = path.relative(root, candidate); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside'); return candidate; },
  pathExists: async candidate => fs.existsSync(candidate), workspaceCatalogs: new Map(), activeProjectFileOperations: new Map(),
  pushUndoOperation: async () => undefined, renameHistory: [], writeLog: () => undefined, ...overrides,
  });
  if (result.workspaceRepository?.latestUndoRecord) {
    const latestUndoRecord = result.workspaceRepository.latestUndoRecord.bind(result.workspaceRepository);
    result.workspaceRepository = { ...result.workspaceRepository, latestUndoRecord: async root => {
      const response = await latestUndoRecord(root); const record = response?.record;
      if (record && !record.claimToken) record.claimToken = crypto.createHash('sha256').update(JSON.stringify([record.id, record.kind, record.payload, record.state || 'ready', record.created_at || 0, record.updated_at || 0])).digest('hex');
      return response;
    } };
  }
  if (result.workspaceRepository && !result.workspaceRepository.retireUndoRecordClaim) {
    result.workspaceRepository = { ...result.workspaceRepository, retireUndoRecordClaim: async (root, id) => {
      const records = (await result.workspaceRepository.listUndoRecords?.(root))?.records || [];
      const record = records.find(candidate => candidate.id === id);
      return { success: true, retired: !record || ['unavailable', 'retired'].includes(record.state) };
    } };
  }
  if (result.workspaceRepository && !result.workspaceRepository.claimUndoRecordExecution) {
    result.workspaceRepository = { ...result.workspaceRepository, claimUndoRecordExecution: async (root, id, claimToken) => {
      assert.match(String(claimToken || ''), /^[0-9a-f]{64}$/u);
      await result.workspaceRepository.markUndoRecordUnavailable?.(root, id);
      return { success: true, claimed: true };
    } };
  }
  return result;
};

const run = async () => {
  const workspaceIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'workspace-ipc.cjs'), 'utf8');
  const claimImplementation = workspaceIpcSource.slice(workspaceIpcSource.indexOf("const persistentUndoClaimPrefix"), workspaceIpcSource.indexOf('const pruneBlockedPersistentUndos'));
  assert.doesNotMatch(claimImplementation, /fs\.promises\.(?:unlink|rm|rename)\s*\(|publishPathNoClobber/, 'persistent claim GC must delegate deletion to the identity-bound file-transfer primitive');
  assert.doesNotMatch(claimImplementation, /listUndoRecords|runPersistentUndoClaimGcLegacyImplementation/, 'claim GC must contain only the atomic retire-CAS implementation');

  const gcRoot = path.join(temporaryRoot, 'claim-gc'); fs.mkdirSync(gcRoot);
  const readyMarker = writeClaimMarker(gcRoot, 'ready-old');
  const unavailableMarker = writeClaimMarker(gcRoot, 'unavailable-old');
  const absentMarker = writeClaimMarker(gcRoot, 'absent-old');
  const gcNow = Date.now() + 9 * 24 * 60 * 60 * 1000;
  const youngMarker = writeClaimMarker(gcRoot, 'absent-young', { createdAt: new Date(gcNow).toISOString() });
  const invalidMarker = path.join(gcRoot, '.photoflow-undo-claim-' + 'a'.repeat(64) + '.json'); fs.writeFileSync(invalidMarker, '{bad json');
  const hugeMarker = path.join(gcRoot, '.photoflow-undo-claim-' + 'b'.repeat(64) + '.json'); fs.writeFileSync(hugeMarker, Buffer.alloc(5000));
  const gcHandlers = new Map();
  const gcController = registerWorkspaceIpc(context(gcHandlers, {
    persistentUndoClaimRetentionMs: 7 * 24 * 60 * 60 * 1000, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0, persistentUndoClaimScanBudgetMs: 10000,
    workspaceRepository: { listUndoRecords: async () => ({ records: [{ id: 'ready-old', kind: 'trash', state: 'ready' }, { id: 'unavailable-old', kind: 'trash', state: 'unavailable' }] }) },
  }));
  const gcResult = await gcController.runPersistentUndoClaimGc(gcRoot);
  assert.strictEqual(fs.existsSync(readyMarker), true, 'ready tombstones are never collected');
  assert.strictEqual(fs.existsSync(unavailableMarker), false, 'old unavailable tombstones are collected');
  assert.strictEqual(fs.existsSync(absentMarker), false, 'old absent tombstones are collected');
  assert.strictEqual(fs.existsSync(youngMarker), true, 'young tombstones are retained');
  assert.strictEqual(fs.existsSync(invalidMarker), true, 'invalid tombstones are retained');
  assert.strictEqual(fs.existsSync(hugeMarker), true, 'oversized tombstones are retained');
  assert.strictEqual(gcResult.removed, 2); assert(gcResult.warnings.length >= 2);
  const deterministicGcNowMs = () => Date.now() + 60 * 1000;

  const recreatedRoot = path.join(temporaryRoot, 'claim-gc-recreated'); fs.mkdirSync(recreatedRoot); const recreatedMarker = writeClaimMarker(recreatedRoot, 'recreated-old-body');
  const recreatedController = registerWorkspaceIpc(context(new Map(), { persistentUndoClaimRetentionMs: 7 * 24 * 60 * 60 * 1000, persistentUndoClaimThrottleMs: 0, workspaceRepository: { listUndoRecords: async () => ({ records: [] }) } }));
  const recreatedGc = await recreatedController.runPersistentUndoClaimGc(recreatedRoot);
  assert.strictEqual(recreatedGc.removed, 0); assert.strictEqual(fs.existsSync(recreatedMarker), true, 'a recently recreated file with an old marker body is retained by handle metadata retention');

  const failedQueryRoot = path.join(temporaryRoot, 'claim-gc-query-failure'); fs.mkdirSync(failedQueryRoot); const failedQueryMarker = writeClaimMarker(failedQueryRoot, 'query-failure-old');
  const failedQueryController = registerWorkspaceIpc(context(new Map(), { persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: deterministicGcNowMs, persistentUndoClaimThrottleMs: 0, workspaceRepository: { listUndoRecords: async () => { throw new Error('operations unavailable'); } } }));
  const failedQueryGc = await failedQueryController.runPersistentUndoClaimGc(failedQueryRoot);
  assert.strictEqual(fs.existsSync(failedQueryMarker), true, 'journal CAS failures retain every tombstone'); assert.match(failedQueryGc.warnings.join('\n'), /journal-retire-failed/);

  const symlinkTarget = path.join(gcRoot, 'symlink-target.json'); fs.writeFileSync(symlinkTarget, '{}');
  const symlinkMarker = path.join(gcRoot, '.photoflow-undo-claim-' + 'c'.repeat(64) + '.json'); let symlinkCreated = false;
  try { fs.symlinkSync(symlinkTarget, symlinkMarker, 'file'); symlinkCreated = true; } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error; }
  if (symlinkCreated) { await gcController.runPersistentUndoClaimGc(gcRoot); assert.strictEqual(fs.lstatSync(symlinkMarker).isSymbolicLink(), true, 'symlink markers are retained without following them'); }

  const gcRaceRoot = path.join(temporaryRoot, 'claim-gc-race'); fs.mkdirSync(gcRaceRoot); const raceMarker = writeClaimMarker(gcRaceRoot, 'race-old'); const gcRaceOriginal = fs.readFileSync(raceMarker); const raceTimes = fs.statSync(raceMarker);
  let raced = false;
  const raceController = registerWorkspaceIpc(context(new Map(), {
    persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: deterministicGcNowMs, persistentUndoClaimThrottleMs: 0, workspaceRepository: { listUndoRecords: async () => ({ records: [] }) },
    afterPersistentUndoClaimGcHandleRead: async () => { if (!raced) { raced = true; fs.unlinkSync(raceMarker); fs.writeFileSync(raceMarker, Buffer.alloc(gcRaceOriginal.length, 0x78)); fs.utimesSync(raceMarker, raceTimes.atime, raceTimes.mtime); } },
  }));
  const raceGc = await raceController.runPersistentUndoClaimGc(gcRaceRoot);
  assert.strictEqual(raced, true, 'the handle-read replacement hook must execute'); assert.strictEqual(raceGc.removed, 0); assert.strictEqual(fs.readFileSync(raceMarker).equals(Buffer.alloc(gcRaceOriginal.length, 0x78)), true, 'a same-size/mtime marker replacement after handle read is retained');

  const recheckRoot = path.join(temporaryRoot, 'claim-gc-recheck'); fs.mkdirSync(recheckRoot); const recheckMarker = writeClaimMarker(recheckRoot, 'recheck-ready');
  const recheckController = registerWorkspaceIpc(context(new Map(), { persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: deterministicGcNowMs, persistentUndoClaimThrottleMs: 0, workspaceRepository: { retireUndoRecordClaim: async () => ({ retired: false }) } }));
  const recheckGc = await recheckController.runPersistentUndoClaimGc(recheckRoot);
  assert.strictEqual(recheckGc.removed, 0); assert.strictEqual(fs.existsSync(recheckMarker), true, 'a tombstone that becomes ready during the scan is retained by the deletion-time journal recheck');

  const claimBoundedRoot = path.join(temporaryRoot, 'claim-gc-bounded'); fs.mkdirSync(claimBoundedRoot);
  for (let index = 0; index < 4; index += 1) writeClaimMarker(claimBoundedRoot, `bounded-${index}`);
  const boundedController = registerWorkspaceIpc(context(new Map(), { persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: deterministicGcNowMs, persistentUndoClaimThrottleMs: 60000, persistentUndoClaimScanLimit: 2, persistentUndoClaimScanBudgetMs: 10000, workspaceRepository: { listUndoRecords: async () => ({ records: [] }) } }));
  const boundedFirst = await boundedController.runPersistentUndoClaimGc(claimBoundedRoot); const boundedSecond = await boundedController.runPersistentUndoClaimGc(claimBoundedRoot);
  assert.strictEqual(boundedFirst.checked, 2); assert.strictEqual(boundedFirst.truncated, true); assert.strictEqual(boundedSecond.throttled, true); assert.strictEqual(boundedSecond.checked, 0);
  const visitedRoot = path.join(temporaryRoot, 'claim-gc-visited'); fs.mkdirSync(visitedRoot); const visitedReadyMarker = writeClaimMarker(visitedRoot, 'visited-ready');
  for (let index = 0; index < 40; index += 1) fs.writeFileSync(path.join(visitedRoot, `ordinary-${String(index).padStart(3, '0')}.txt`), 'ordinary');
  const visitedController = registerWorkspaceIpc(context(new Map(), { persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: deterministicGcNowMs, persistentUndoClaimThrottleMs: 0, persistentUndoClaimScanBudgetMs: 10000, persistentUndoClaimMaxVisitedEntries: 7, workspaceRepository: { listUndoRecords: async () => ({ records: [{ id: 'visited-ready', kind: 'trash', state: 'ready' }] }) } }));
  const visitedGc = await visitedController.runPersistentUndoClaimGc(visitedRoot);
  assert.strictEqual(visitedGc.visited, 7, 'streaming GC never visits beyond the independent root-entry cap'); assert.strictEqual(visitedGc.truncated, true); assert.strictEqual(fs.existsSync(visitedReadyMarker), true, 'bounded traversal never deletes a ready marker');

  const continuationRoot = path.join(temporaryRoot, 'claim-gc-v2-continuation'); fs.mkdirSync(continuationRoot);
  for (let index = 0; index < 80; index += 1) writeClaimMarker(continuationRoot, `young-prefix-${String(index).padStart(3, '0')}`, { createdAt: new Date(gcNow).toISOString() });
  const continuationEligible = writeClaimMarker(continuationRoot, 'eligible-after-prefix');
  const continuationController = registerWorkspaceIpc(context(new Map(), {
    persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0,
    persistentUndoClaimScanLimit: 3, persistentUndoClaimMaxVisitedEntries: 3, persistentUndoClaimScanBudgetMs: 10000,
    workspaceRepository: { retireUndoRecordClaim: async (_root, id) => ({ retired: id === 'eligible-after-prefix' }) },
  }));
  const continuationFirst = await continuationController.runPersistentUndoClaimGc(continuationRoot);
  assert.strictEqual(continuationFirst.truncated, true);
  for (let attempt = 0; attempt < 100 && fs.existsSync(continuationEligible); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.strictEqual(fs.existsSync(continuationEligible), false, 'v2 continuation eventually reaches an eligible marker after a retained prefix');

  const legacyContinuationRoot = path.join(temporaryRoot, 'claim-gc-legacy-continuation'); fs.mkdirSync(legacyContinuationRoot);
  for (let index = 0; index < 80; index += 1) fs.writeFileSync(path.join(legacyContinuationRoot, `ordinary-${String(index).padStart(3, '0')}.txt`), 'ordinary');
  const legacyContinuationMarker = writeLegacyClaimMarker(legacyContinuationRoot, 'legacy-after-ordinary');
  const legacyContinuationController = registerWorkspaceIpc(context(new Map(), {
    persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0,
    persistentUndoClaimMaxVisitedEntries: 4, persistentUndoClaimScanLimit: 4, persistentUndoClaimScanBudgetMs: 10000,
    workspaceRepository: { retireUndoRecordClaim: async (_root, id) => ({ retired: id === 'legacy-after-ordinary' }) },
  }));
  await legacyContinuationController.runPersistentUndoClaimGc(legacyContinuationRoot);
  for (let attempt = 0; attempt < 100 && fs.existsSync(legacyContinuationMarker); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.strictEqual(fs.existsSync(legacyContinuationMarker), false, 'legacy continuation eventually passes ordinary root entries');

  const delayedCasRoot = path.join(temporaryRoot, 'claim-gc-delayed-cas'); fs.mkdirSync(delayedCasRoot); const delayedMarker = writeClaimMarker(delayedCasRoot, 'delayed-retire'); let delayedCalls = 0;
  const delayedController = registerWorkspaceIpc(context(new Map(), {
    persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0, persistentUndoClaimScanBudgetMs: 50,
    workspaceRepository: { retireUndoRecordClaim: async () => { delayedCalls += 1; await new Promise(resolve => setTimeout(resolve, 100)); return { retired: true }; } },
  }));
  const delayedFirst = await delayedController.runPersistentUndoClaimGc(delayedCasRoot);
  const delayedCasRootTwo = path.join(temporaryRoot, 'claim-gc-delayed-cas-two'); fs.mkdirSync(delayedCasRootTwo); const delayedMarkerTwo = writeClaimMarker(delayedCasRootTwo, 'delayed-retire-two');
  const delayedControllerTwo = registerWorkspaceIpc(context(new Map(), {
    persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0, persistentUndoClaimScanBudgetMs: 50,
    workspaceRepository: { retireUndoRecordClaim: async () => { delayedCalls += 1; await new Promise(resolve => setTimeout(resolve, 100)); return { retired: true }; } },
  }));
  const delayedSecond = await delayedControllerTwo.runPersistentUndoClaimGc(delayedCasRootTwo);
  for (let attempt = 0; attempt < 100 && (fs.existsSync(delayedMarker) || fs.existsSync(delayedMarkerTwo)); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert(delayedCalls >= 2); assert.strictEqual(fs.existsSync(delayedMarker), false); assert.strictEqual(fs.existsSync(delayedMarkerTwo), false, 'a confirmed retired marker is deleted by a fresh-deadline continuation'); assert.strictEqual(delayedFirst.truncated, true); assert.strictEqual(delayedSecond.truncated, true);

  const pendingRetryRoot = path.join(temporaryRoot, 'claim-gc-pending-retry'); fs.mkdirSync(pendingRetryRoot); const pendingRetryMarker = writeClaimMarker(pendingRetryRoot, 'pending-retry'); let pendingDeleteHooks = 0;
  const pendingRetryController = registerWorkspaceIpc(context(new Map(), {
    persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0, persistentUndoClaimScanBudgetMs: 50,
    workspaceRepository: { retireUndoRecordClaim: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { retired: true }; } },
    beforePersistentUndoClaimGcDelete: async () => { pendingDeleteHooks += 1; if (pendingDeleteHooks <= 2) await new Promise(resolve => setTimeout(resolve, 75)); },
  }));
  await pendingRetryController.runPersistentUndoClaimGc(pendingRetryRoot);
  for (let attempt = 0; attempt < 100 && fs.existsSync(pendingRetryMarker); attempt += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(fs.existsSync(pendingRetryMarker), false, 'bounded backoff retries pending cleanup after two delete-hook deadline overruns'); assert(pendingDeleteHooks >= 3);

  const pendingReplacementRoot = path.join(temporaryRoot, 'claim-gc-pending-replacement'); fs.mkdirSync(pendingReplacementRoot); const pendingReplacementMarker = writeClaimMarker(pendingReplacementRoot, 'pending-replacement'); const pendingReplacementBytes = fs.readFileSync(pendingReplacementMarker); let pendingReplacementDone = false;
  const pendingReplacementController = registerWorkspaceIpc(context(new Map(), { persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0, persistentUndoClaimScanBudgetMs: 50, workspaceRepository: { retireUndoRecordClaim: async () => { await new Promise(resolve => setTimeout(resolve, 50)); if (!pendingReplacementDone) { pendingReplacementDone = true; fs.unlinkSync(pendingReplacementMarker); fs.writeFileSync(pendingReplacementMarker, Buffer.alloc(pendingReplacementBytes.length, 0x78)); } await new Promise(resolve => setTimeout(resolve, 50)); return { retired: true }; } } }));
  await pendingReplacementController.runPersistentUndoClaimGc(pendingReplacementRoot); await new Promise(resolve => setTimeout(resolve, 250));
  assert.strictEqual(pendingReplacementDone, true); assert.strictEqual(fs.existsSync(pendingReplacementMarker), true, 'pending cleanup retains a path replacement that no longer matches the retired marker identity');

  const capacityRootA = path.join(temporaryRoot, 'claim-gc-pending-capacity-a'); const capacityRootB = path.join(temporaryRoot, 'claim-gc-pending-capacity-b'); fs.mkdirSync(capacityRootA); fs.mkdirSync(capacityRootB); const capacityMarkerA = writeClaimMarker(capacityRootA, 'capacity-a'); const capacityMarkerB = writeClaimMarker(capacityRootB, 'capacity-b');
  const capacityController = registerWorkspaceIpc(context(new Map(), { persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0, persistentUndoClaimScanBudgetMs: 50, persistentUndoPendingCleanupCapacity: 1, workspaceRepository: { retireUndoRecordClaim: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { retired: true }; } } }));
  await Promise.all([capacityController.runPersistentUndoClaimGc(capacityRootA), capacityController.runPersistentUndoClaimGc(capacityRootB)]);
  for (let attempt = 0; attempt < 150 && (fs.existsSync(capacityMarkerA) || fs.existsSync(capacityMarkerB)); attempt += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(fs.existsSync(capacityMarkerA), false); assert.strictEqual(fs.existsSync(capacityMarkerB), false, 'capacity eviction schedules unthrottled rescans so every retired marker is eventually collected');

  const sqliteGcRoot = path.join(temporaryRoot, 'claim-gc-real-sqlite'); fs.mkdirSync(sqliteGcRoot); const sqliteGcMarker = writeClaimMarker(sqliteGcRoot, 'sqlite-gc-race'); const sqliteOperations = path.join(temporaryRoot, 'claim-gc-operations.sqlite3');
  const python = fs.existsSync(path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')) ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe') : 'python';
  const operationsScript = path.join(__dirname, '..', 'python', 'operations_db.py');
  const runOperations = (action, payload) => {
    const invoked = spawnSync(python, [operationsScript, action, '--database', sqliteOperations, '--payload', JSON.stringify(payload)], { encoding: 'utf8' });
    if (invoked.status !== 0) throw Object.assign(new Error(invoked.stderr || invoked.stdout), { invocation: invoked });
    return JSON.parse(invoked.stdout.trim());
  };
  runOperations('init', {}); let sqliteAddRejected = false;
  const sqliteGcController = registerWorkspaceIpc(context(new Map(), {
    persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0, persistentUndoClaimScanBudgetMs: 10000,
    workspaceRepository: { retireUndoRecordClaim: async (_root, id) => runOperations('undo_record_retire_claim', { id }) },
    beforePersistentUndoClaimGcDelete: async () => {
      const add = spawnSync(python, [operationsScript, 'undo_record_add', '--database', sqliteOperations, '--payload', JSON.stringify({ id: 'sqlite-gc-race', kind: 'trash', payload: { revived: true } })], { encoding: 'utf8' });
      sqliteAddRejected = add.status !== 0 && /permanently retired|UndoRecordRetiredError/u.test(`${add.stderr}\n${add.stdout}`);
    },
  }));
  const sqliteGc = await sqliteGcController.runPersistentUndoClaimGc(sqliteGcRoot);
  assert.strictEqual(sqliteAddRejected, true, 'a real SQLite add racing at the delete hook is rejected by the retired ID'); assert.strictEqual(sqliteGc.removed, 1); assert.strictEqual(fs.existsSync(sqliteGcMarker), false);
  const sqliteState = spawnSync(python, ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT state FROM undo_records WHERE id=?",(sys.argv[2],)).fetchone()[0])', sqliteOperations, 'sqlite-gc-race'], { encoding: 'utf8' });
  assert.strictEqual(sqliteState.stdout.trim(), 'retired', 'marker deletion cannot leave a ready journal row');

  const loadGcRoot = path.join(temporaryRoot, 'claim-gc-workspace-load'); fs.mkdirSync(loadGcRoot); const loadGcMarker = writeClaimMarker(loadGcRoot, 'workspace-load-gc'); const loadGcHandlers = new Map();
  registerWorkspaceIpc(context(loadGcHandlers, {
    workspaceCatalogs: new Map([[loadGcRoot, { projects: [] }]]), watchWorkspace: () => undefined, reconcileWorkspaceCatalog: async () => undefined,
    persistentUndoClaimRetentionMs: 0, persistentUndoClaimNowMs: () => gcNow, persistentUndoClaimThrottleMs: 0,
    workspaceRepository: { retireUndoRecordClaim: async () => ({ retired: true }) },
  }));
  await loadGcHandlers.get('workspace-projects')(null, loadGcRoot);
  for (let attempt = 0; attempt < 100 && fs.existsSync(loadGcMarker); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(fs.existsSync(loadGcMarker), false, 'normal workspace project-list loading schedules non-blocking undo claim GC');
  assert.throws(() => normalizeProjectDate({ year: '', month: 1 }), /年份不能为空/);
  assert.strictEqual(readProjectDate({ extra_json: '{"projectDate":{"year":1999,"month":1}}' }), undefined);
  assert.throws(() => normalizeProjectFileListFilter({ extensions: Array.from({ length: 65 }, (_, i) => `.x${i}`) }), /最多/);

  const materializeLimitHandlers = new Map(); let materializeProgressReads = 0;
  registerWorkspaceIpc(context(materializeLimitHandlers, { versionService: { listProgress: async () => { materializeProgressReads += 1; return { progressFolders: [] }; } } }));
  const materialize = materializeLimitHandlers.get('workspace-materialize-external-links');
  const tooManyMaterializePaths = await materialize(null, temporaryRoot, '策划中', 'limit-project', Array.from({ length: 513 }, (_, index) => `link-${index}.lnk`));
  assert.strictEqual(tooManyMaterializePaths.success, false); assert.match(tooManyMaterializePaths.error, /一次最多移动 512 个外链/);
  const oversizedMaterializePaths = await materialize(null, temporaryRoot, '策划中', 'limit-project', ['a'.repeat(40000), 'b'.repeat(40000)]);
  assert.strictEqual(oversizedMaterializePaths.success, false); assert.match(oversizedMaterializePaths.error, /总长度过大/); assert.strictEqual(materializeProgressReads, 0, 'explicit materialize request limits are enforced before project scanning');

  const createRoot = path.join(temporaryRoot, 'create'); fs.mkdirSync(createRoot, { recursive: true });
  const createHandlers = new Map(); const empty = { projects: [], byName: new Map() };
  registerWorkspaceIpc(context(createHandlers, {
    workspaceCatalogs: new Map([[createRoot, empty]]), workspaceRepository: { addProject: async () => ({ success: true }) },
    refreshWorkspaceCatalog: async () => { throw new Error('refresh failed'); }, reconcileWorkspaceCatalog: async () => { throw new Error('reconcile failed'); },
    telemetryService: { track: () => undefined },
  }));
  const created = await createHandlers.get('workspace-create-project')(null, createRoot, null, 'pending-id', { createPlanningFolder: false });
  assert.strictEqual(created.success, false); assert.strictEqual(created.committed, true); assert.strictEqual(created.catalogRefreshPending, true);
  assert.strictEqual(created.project, undefined, 'catalog-pending responses must not expose a temporary project identity');
  assert.strictEqual(fs.existsSync(path.join(createRoot, 'pending-id')), true);

  const noClobberRename = async (sourcePath, destinationPath) => {
    if (fs.existsSync(destinationPath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    await fs.promises.rename(sourcePath, destinationPath); return {};
  };
  const executeRejectedCreate = async ({ label, readCatalog, readError = null, createPlanningFolder = false }) => {
    const outcomeRoot = path.join(temporaryRoot, label); fs.mkdirSync(outcomeRoot, { recursive: true });
    const handlers = new Map(); let syncCalls = 0;
    registerWorkspaceIpc(context(handlers, {
      workspaceCatalogs: new Map([[outcomeRoot, { projects: [], byName: new Map() }]]),
      workspaceRepository: { addProject: async () => { throw new Error('mutation response disconnected'); } },
      refreshWorkspaceCatalog: async () => { if (readError) throw readError; return readCatalog; },
      reconcileWorkspaceCatalog: async () => { syncCalls += 1; return readCatalog; },
      publishPathNoClobber: noClobberRename, telemetryService: { track: () => undefined },
    }));
    const result = await handlers.get('workspace-create-project')(null, outcomeRoot, null, 'Probe', { createPlanningFolder });
    await new Promise(resolve => setTimeout(resolve, 10));
    return { result, projectPath: path.join(outcomeRoot, 'Probe'), syncCalls };
  };

  const emptyRead = { projects: [], byName: new Map() };
  const notCommitted = await executeRejectedCreate({ label: 'probe-not-committed', readCatalog: emptyRead });
  assert.strictEqual(notCommitted.result.success, false);
  assert.strictEqual(notCommitted.syncCalls, 0, 'a successful read-only negative probe must never call syncCatalog');
  assert.strictEqual(fs.existsSync(notCommitted.projectPath), false, 'definitely uncommitted filesystem creation is identity-cleaned');
  assert.strictEqual(emptyRead.projects.length, 0, 'read-only probing must not create a missing/unclassified catalog row');
  const planningNotCommitted = await executeRejectedCreate({ label: 'probe-planning-not-committed', readCatalog: emptyRead, createPlanningFolder: true });
  assert.strictEqual(fs.existsSync(planningNotCommitted.projectPath), false, 'a failed default project layout removes the owned empty planning directory before the owned empty root');

  const occupiedCreateRoot = path.join(temporaryRoot, 'probe-new-child'); fs.mkdirSync(occupiedCreateRoot); const occupiedCreateHandlers = new Map();
  registerWorkspaceIpc(context(occupiedCreateHandlers, {
    workspaceCatalogs: new Map([[occupiedCreateRoot, { projects: [], byName: new Map() }]]),
    workspaceRepository: { addProject: async () => { fs.writeFileSync(path.join(occupiedCreateRoot, 'Probe', 'new-project.txt'), 'later project'); throw new Error('mutation rejected'); } },
    refreshWorkspaceCatalog: async () => ({ projects: [], byName: new Map() }), telemetryService: { track: () => undefined },
  }));
  const occupiedCreate = await occupiedCreateHandlers.get('workspace-create-project')(null, occupiedCreateRoot, null, 'Probe', {});
  assert.strictEqual(occupiedCreate.success, false); assert.strictEqual(fs.readFileSync(path.join(occupiedCreateRoot, 'Probe', 'new-project.txt'), 'utf8'), 'later project', 'a newly occupied project directory is retained instead of recursively removed');
  assert.strictEqual(fs.statSync(path.join(occupiedCreateRoot, 'Probe', '策划')).isDirectory(), true, 'the complete automatically-created layout is retained when an unowned child appears');

  const committedRow = { id: 'committed-id', name: 'Probe', status: '策划中', relative_path: 'Probe' };
  const committed = await executeRejectedCreate({ label: 'probe-committed', readCatalog: { projects: [committedRow], byName: new Map([['probe', committedRow]]) } });
  assert.strictEqual(committed.result.success, true, committed.result.error);
  assert.strictEqual(committed.result.project.id, 'committed-id');
  assert.strictEqual(committed.syncCalls, 0, 'a successful committed read probe must never call syncCatalog');
  assert.strictEqual(fs.existsSync(committed.projectPath), true);

  const unknown = await executeRejectedCreate({ label: 'probe-unknown', readCatalog: emptyRead, readError: new Error('read unavailable') });
  assert.strictEqual(unknown.result.success, false);
  assert.strictEqual(unknown.result.outcomeUnknown, true);
  assert.strictEqual(unknown.result.errorCode, 'WORKSPACE_MUTATION_OUTCOME_UNKNOWN');
  assert.strictEqual(fs.existsSync(unknown.projectPath), true, 'unknown outcome preserves filesystem content');
  assert.strictEqual(unknown.syncCalls > 0, true, 'only a failed read-only probe queues reconcile');

  const importRoot = path.join(temporaryRoot, 'import'); const importSource = path.join(temporaryRoot, 'incoming');
  fs.mkdirSync(importSource, { recursive: true }); fs.writeFileSync(path.join(importSource, 'photo.jpg'), 'image'); fs.mkdirSync(importRoot, { recursive: true });
  const importHandlers = new Map();
  registerWorkspaceIpc(context(importHandlers, {
    IMAGE_EXTENSIONS: new Set(['.jpg']), workspaceCatalogs: new Map([[importRoot, { projects: [], byName: new Map() }]]),
    workspaceRepository: { addProject: async () => ({ success: true }) }, refreshWorkspaceCatalog: async () => { throw new Error('refresh failed'); }, reconcileWorkspaceCatalog: async () => { throw new Error('reconcile failed'); },
    assertDiskSpace: async () => undefined, throwIfCancelled: () => undefined, removeCopiedSources: async () => undefined,
    collectCopyPlan: async (sourceRoot, destinationRoot, plan) => { plan.push({ kind: 'directory', source: sourceRoot, destination: destinationRoot, size: 0 }); plan.push({ kind: 'file', source: path.join(sourceRoot, 'photo.jpg'), destination: path.join(destinationRoot, 'photo.jpg'), size: 5 }); },
    copyPlannedFiles: async (plan, options) => { for (const entry of plan) { if (entry.kind === 'directory') await fs.promises.mkdir(entry.destination); else await fs.promises.copyFile(entry.source, entry.destination); options.onCreated?.(entry.destination); } return {}; },
    rebaseCleanupOwnership: async () => ({ success: true }),
    publishPathNoClobber: async (sourcePath, destinationPath) => { if (fs.existsSync(destinationPath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); await fs.promises.rename(sourcePath, destinationPath); return {}; },
  }));
  const imported = await importHandlers.get('workspace-import-existing-project')({ sender: { isDestroyed: () => false, send: () => undefined } }, importRoot, importSource, { name: 'Imported', mode: 'copy' });
  assert.strictEqual(imported.success, false); assert.strictEqual(imported.committed, true); assert.strictEqual(imported.catalogRefreshPending, true);
  assert.strictEqual(imported.project, undefined, 'catalog-pending import must not expose a temporary project identity');
  assert.strictEqual(fs.readFileSync(path.join(importRoot, 'Imported', 'photo.jpg'), 'utf8'), 'image');

  const importRollbackRoot = path.join(temporaryRoot, 'import-rebase-rollback'); fs.mkdirSync(importRollbackRoot); const importRollbackHandlers = new Map(); let importRollbackCleanupCalls = 0;
  registerWorkspaceIpc(context(importRollbackHandlers, {
    IMAGE_EXTENSIONS: new Set(['.jpg']), workspaceCatalogs: new Map([[importRollbackRoot, { projects: [], byName: new Map() }]]),
    workspaceRepository: { addProject: async () => { throw new Error('catalog rejected'); } }, refreshWorkspaceCatalog: async () => ({ projects: [], byName: new Map() }),
    assertDiskSpace: async () => undefined, throwIfCancelled: () => undefined, collectCopyPlan: async (sourceRoot, destinationRoot, plan) => { plan.push({ kind: 'directory', source: sourceRoot, destination: destinationRoot, size: 0 }); plan.push({ kind: 'file', source: path.join(sourceRoot, 'photo.jpg'), destination: path.join(destinationRoot, 'photo.jpg'), size: 5 }); },
    copyPlannedFiles: async plan => { for (const entry of plan) { if (entry.kind === 'directory') await fs.promises.mkdir(entry.destination); else await fs.promises.copyFile(entry.source, entry.destination); } },
    publishPathNoClobber: noClobberRename, rebaseCleanupOwnership: async () => ({ success: true }),
    removeCreatedPasteTargets: async targets => { importRollbackCleanupCalls += 1; fs.rmSync(targets[0], { recursive: true }); return { success: true, outcomes: [] }; },
  }));
  const importRollback = await importRollbackHandlers.get('workspace-import-existing-project')({ sender: { isDestroyed: () => false, send: () => undefined } }, importRollbackRoot, importSource, { name: 'Rollback', mode: 'copy' });
  assert.strictEqual(importRollback.success, false); assert.strictEqual(importRollbackCleanupCalls, 1); assert.strictEqual(fs.existsSync(path.join(importRollbackRoot, 'Rollback')), false, 'a successfully rebased published import tree uses ledger cleanup when catalog insertion is definitely absent');

  const statGapRoot = path.join(temporaryRoot, 'stat-gap'); fs.mkdirSync(statGapRoot, { recursive: true }); const statGapHandlers = new Map();
  registerWorkspaceIpc(context(statGapHandlers, {
    IMAGE_EXTENSIONS: new Set(['.jpg']), workspaceCatalogs: new Map([[statGapRoot, { projects: [], byName: new Map() }]]),
    workspaceRepository: { addProject: async () => { throw new Error('DB must not run after identity gap'); } }, refreshWorkspaceCatalog: async () => ({ projects: [], byName: new Map() }), reconcileWorkspaceCatalog: async () => ({ projects: [], byName: new Map() }),
    assertDiskSpace: async () => undefined, throwIfCancelled: () => undefined, removeCopiedSources: async () => undefined,
    collectCopyPlan: async (sourceRoot, destinationRoot, plan) => { plan.push({ kind: 'directory', source: sourceRoot, destination: destinationRoot, size: 0 }); plan.push({ kind: 'file', source: path.join(sourceRoot, 'photo.jpg'), destination: path.join(destinationRoot, 'photo.jpg'), size: 5 }); },
    copyPlannedFiles: async (plan, options) => { for (const entry of plan) { if (entry.kind === 'directory') await fs.promises.mkdir(entry.destination); else await fs.promises.copyFile(entry.source, entry.destination); options.onCreated?.(entry.destination); } return {}; },
    publishPathNoClobber: noClobberRename,
    capturePathIdentity: async candidate => {
      if (path.basename(candidate) === 'Stat gap') throw new Error('post-publish stat failed');
      const stat = await fs.promises.stat(candidate, { bigint: true }); return { path: candidate, device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), modifiedNs: String(stat.mtimeNs), directory: stat.isDirectory() };
    },
  }));
  const statGap = await statGapHandlers.get('workspace-import-existing-project')({ sender: { isDestroyed: () => false, send: () => undefined } }, statGapRoot, importSource, { name: 'Stat gap', mode: 'copy' });
  assert.strictEqual(statGap.success, false); assert.strictEqual(statGap.outcomeUnknown, true); assert.strictEqual(statGap.errorCode, 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN');
  assert.strictEqual(fs.existsSync(path.join(statGapRoot, 'Stat gap', 'photo.jpg')), true, 'post-publish identity failure preserves recovery content');

  const cleanupRoot = path.join(temporaryRoot, 'cleanup'); const dataRoot = path.join(cleanupRoot, '.data'); const artifact = path.join(dataRoot, 'thumbnails', 'photo-id');
  fs.mkdirSync(artifact, { recursive: true }); fs.writeFileSync(path.join(artifact, 'thumb'), 'thumbnail'); let purgeCalls = 0;
  const cleanupFs = { ...fs, promises: { ...fs.promises, rm: async (candidate, options) => { if (String(candidate).includes('.photoflow-deleted-project-cleanup-')) throw new Error('quarantine delete failed'); return fs.promises.rm(candidate, options); } } };
  const cleanup = createDeletedProjectCleanup({
    backgroundTasks: null, fs: cleanupFs, getWorkspaceDataRoot: () => dataRoot, path, pathExists: async candidate => fs.existsSync(candidate),
    recycleBinService: { nativeAvailable: () => true }, renameHistory: [], setTimeout, thumbnailService: { evictCache: async () => undefined },
    workspaceRepository: { getDeletedProjectCleanupPlan: async () => ({ artifactPaths: [artifact], photoIds: [], sourcePaths: [] }), purgeDeletedProject: async () => { purgeCalls += 1; return {}; } }, writeLog: () => undefined,
  });
  await assert.rejects(() => cleanup.purgeConfirmedDeletedProject(cleanupRoot, { id: 'deleted-id', name: 'Deleted', relativePath: 'Deleted', permanent: true }), /等待安全清理/);
  assert.strictEqual(fs.existsSync(path.join(artifact, 'thumb')), true, 'failed quarantine deletion restores the artifact to its original path');
  assert.strictEqual(purgeCalls, 0, 'artifact cleanup failure must prevent catalog purge');
  const staleArtifact = path.join(dataRoot, 'thumbnails', 'stale-photo'); fs.mkdirSync(staleArtifact, { recursive: true }); fs.writeFileSync(path.join(staleArtifact, 'thumb'), 'stale');
  const deferredMissing = await cleanup.purgeStaleMissingProject(cleanupRoot, { id: 'missing-id', name: 'Missing for 30 days', relativePath: 'Missing for 30 days' });
  assert.deepStrictEqual(deferredMissing, { cleaned: false, status: 'deferred', reason: 'cleanup-plan-unavailable' });
  assert.strictEqual(purgeCalls, 0, 'stale missing maintenance must not invoke a destructive DB purge');
  assert.strictEqual(fs.existsSync(path.join(staleArtifact, 'thumb')), true, 'stale missing artifacts remain untouched while cleanup planning is unavailable');

  const relinkWorkspace = path.join(temporaryRoot, 'relink'); const relinkProject = path.join(relinkWorkspace, 'Project'); const oldTarget = path.join(temporaryRoot, 'old-target'); const newTarget = path.join(temporaryRoot, 'new-target');
  fs.mkdirSync(relinkProject, { recursive: true }); fs.mkdirSync(oldTarget); fs.mkdirSync(newTarget); const shortcutPath = path.join(relinkProject, 'external.lnk'); fs.writeFileSync(shortcutPath, 'old-link');
  const relinkHandlers = new Map(); let releases = 0; const bindings = [];
  registerWorkspaceIpc(context(relinkHandlers, {
    getProjectPath: () => relinkProject, ensureWorkspace: () => relinkWorkspace, publishPathNoClobber: noClobberRename,
    projectVirtualPaths: {
      listManagedExternalLinks: () => [], readManagedExternalLink: () => null,
      resolve: () => ({ isExternalLinkRoot: true, shortcutPath, shortcutVirtualPath: 'external.lnk', externalTargetRoot: oldTarget, externalTargetKind: 'folder', externalDisplayName: 'external', linkId: 'old-link' }),
      createManagedExternalLink: (candidate, request) => { fs.writeFileSync(candidate, request.target); return { linkId: 'new-link' }; }, revokeManagedExternalLinkIds: () => undefined,
    },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [newTarget] }) }, versionService: { listProgress: async () => ({ progressFolders: [] }), detectProgressStale: async () => ({ success: true }) },
    mediaService: { grantRoot: () => undefined }, acquireFileRootWatcher: (candidate, options) => { if (path.resolve(candidate) === path.resolve(newTarget)) return { success: false, error: 'new watcher failed' }; bindings.push({ candidate, options }); return { success: true }; },
    releaseFileRootWatcher: () => { releases += 1; }, mainWindow: { webContents: { send: () => { throw new Error('renderer gone'); } } },
  }));
  const watched = await relinkHandlers.get('workspace-watch-file-root')(null, relinkWorkspace, '策划中', 'Project', { reconcile: false }); assert.strictEqual(watched.success, true);
  const relinked = await relinkHandlers.get('workspace-relink-external-folder')(null, relinkWorkspace, '策划中', 'Project', 'external.lnk');
  assert.strictEqual(relinked.success, true); assert.strictEqual(relinked.watchDegraded, true); assert.match(relinked.warning, /监听/);
  assert.strictEqual(releases, 0, 'failed new watcher acquisition must not release the old binding'); assert.strictEqual(bindings.length, 1, 'old watcher binding remains installed');
  assert.strictEqual(fs.readFileSync(shortcutPath, 'utf8'), newTarget, 'committed relink survives watcher and renderer notification failures');

  const replacementRelinkWorkspace = path.join(temporaryRoot, 'relink-replacement'); const replacementRelinkProject = path.join(replacementRelinkWorkspace, 'Project'); const replacementOldTarget = path.join(temporaryRoot, 'replacement-old-target'); const replacementNewTarget = path.join(temporaryRoot, 'replacement-new-target');
  fs.mkdirSync(replacementRelinkProject, { recursive: true }); fs.mkdirSync(replacementOldTarget); fs.mkdirSync(replacementNewTarget); const replacementShortcut = path.join(replacementRelinkProject, 'external.lnk'); fs.writeFileSync(replacementShortcut, 'old-link');
  const replacementRelinkHandlers = new Map(); let revokeCalls = 0;
  registerWorkspaceIpc(context(replacementRelinkHandlers, {
    getProjectPath: () => replacementRelinkProject, ensureWorkspace: () => replacementRelinkWorkspace,
    projectVirtualPaths: {
      resolve: () => ({ isExternalLinkRoot: true, shortcutPath: replacementShortcut, shortcutVirtualPath: 'external.lnk', externalTargetRoot: replacementOldTarget, externalTargetKind: 'folder', externalDisplayName: 'external', linkId: 'old-link' }),
      createManagedExternalLink: candidate => { fs.writeFileSync(candidate, 'new-link'); return { linkId: 'created-link' }; },
      revokeManagedExternalLinkIds: () => { revokeCalls += 1; if (revokeCalls === 1) { fs.unlinkSync(replacementShortcut); fs.writeFileSync(replacementShortcut, 'later shortcut replacement'); throw new Error('revoke failed after replacement'); } },
    },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [replacementNewTarget] }) }, versionService: { listProgress: async () => ({ progressFolders: [] }) },
  }));
  const replacementRelink = await replacementRelinkHandlers.get('workspace-relink-external-folder')(null, replacementRelinkWorkspace, '策划中', 'Project', 'external.lnk');
  assert.strictEqual(replacementRelink.success, false); assert.strictEqual(fs.readFileSync(replacementShortcut, 'utf8'), 'later shortcut replacement', 'a shortcut replacement created after installation is retained during relink rollback');

  const progressRollbackRoot = path.join(temporaryRoot, 'progress-rollback'); const progressRollbackProject = path.join(progressRollbackRoot, 'Project'); fs.mkdirSync(progressRollbackProject, { recursive: true }); const progressRollbackHandlers = new Map();
  registerWorkspaceIpc(context(progressRollbackHandlers, {
    getProjectPath: () => progressRollbackProject, workspaceCatalogs: new Map([[progressRollbackRoot, { projects: [], byName: new Map() }]]),
    versionService: { registerProgress: async (_root, request) => { fs.writeFileSync(path.join(request.folderPath, 'later-project.txt'), 'later content'); throw new Error('registration failed'); } },
  }));
  const progressRollback = await progressRollbackHandlers.get('workspace-create-progress-folder')(null, progressRollbackRoot, '策划中', 'Project', { displayName: 'Version 1', mediaKind: 'image', versionKey: '1' });
  assert.strictEqual(progressRollback.success, false); assert.strictEqual(fs.readFileSync(path.join(progressRollbackProject, 'Version 1', 'later-project.txt'), 'utf8'), 'later content', 'a failed progress registration retains a directory that gained a new child');

  const boundedRoot = path.join(temporaryRoot, 'bounded'); fs.mkdirSync(boundedRoot); for (let index = 0; index < 513; index += 1) fs.writeFileSync(path.join(boundedRoot, `${index}.lnk`), 'link');
  const boundedHandlers = new Map(); let boundedReads = 0;
  registerWorkspaceIpc(context(boundedHandlers, { getProjectPath: () => boundedRoot, projectVirtualPaths: { readManagedExternalLink: candidate => { boundedReads += 1; return { target: `${candidate}.missing`, targetKindHint: 'file', linkId: path.basename(candidate) }; }, listManagedExternalLinks: () => { throw new Error('unbounded API must not be called'); } } }));
  const boundedTree = await boundedHandlers.get('workspace-folder-tree')(null, temporaryRoot, '策划中', 'Bounded');
  assert.strictEqual(boundedTree.success, true); assert.strictEqual(boundedTree.truncated, true, 'managed-link prescan reports its hard cap'); assert.strictEqual(boundedReads, 512, 'bounded link enumeration stops exactly at its result cap');

  const truncatedLinks = []; truncatedLinks.truncated = true; const watchHandlers = new Map();
  registerWorkspaceIpc(context(watchHandlers, { getProjectPath: () => boundedRoot, ensureWorkspace: () => temporaryRoot, projectVirtualPaths: { listManagedExternalLinks: () => truncatedLinks }, mediaService: { grantRoot: () => undefined }, acquireFileRootWatcher: () => ({ success: true }), releaseFileRootWatcher: () => undefined, versionService: { detectProgressStale: async () => ({ success: true }) } }));
  const truncatedWatch = await watchHandlers.get('workspace-watch-file-root')(null, temporaryRoot, '策划中', 'Bounded', { reconcile: false });
  assert.strictEqual(truncatedWatch.success, true); assert.strictEqual(truncatedWatch.degraded, true); assert.match(truncatedWatch.warning, /安全枚举上限/); assert.strictEqual(truncatedWatch.failedRoots.length, 1);

  const renameRoot = path.join(temporaryRoot, 'rename'); const source = path.join(renameRoot, 'Archive'); const destination = path.join(renameRoot, 'Archive renamed');
  fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, 'marker'), 'target');
  const symlinkFs = { ...fs, promises: { ...fs.promises, lstat: async candidate => { const stat = await fs.promises.lstat(candidate); return [source, destination].map(path.resolve).includes(path.resolve(candidate)) ? { ...stat, isSymbolicLink: () => true } : stat; } } };
  const row = { id: 'archive-id', name: 'Archive', status: '策划中', relative_path: 'Archive', extra_json: '{}' };
  const catalog = { projects: [row], byName: new Map([['archive', row]]) }; const renameHandlers = new Map();
  const token = { publishRoot: renameRoot, virtualPrefix: 'Archive', onChanged: () => undefined }; let resumed; const projectPublisherCalls = [];
  const projectPublisher = async (sourcePath, destinationPath) => { projectPublisherCalls.push({ sourcePath, destinationPath }); if (fs.existsSync(destinationPath)) throw Object.assign(new Error('occupied'), { code: 'EEXIST' }); await fs.promises.rename(sourcePath, destinationPath); return {}; };
  registerWorkspaceIpc(context(renameHandlers, {
    fs: symlinkFs, workspaceCatalogs: new Map([[renameRoot, catalog]]), workspaceRepository: { renameProject: async () => { throw new Error('DB rejected'); } },
    reconcileWorkspaceCatalog: async () => catalog, refreshWorkspaceCatalog: async () => catalog,
    publishPathNoClobber: projectPublisher, suspendFileRootWatcher: () => token,
    resumeFileRootWatcher: (_path, value) => { resumed = value; }, suppressWorkspaceWatchPath: () => undefined, releaseWorkspaceWatchPath: () => undefined, cancelMediaTrackingScan: () => undefined,
  }));
  const renamed = await renameHandlers.get('workspace-rename-project')(null, renameRoot, '策划中', 'Archive', 'Archive renamed');
  assert.strictEqual(renamed.success, false); assert.strictEqual(fs.existsSync(source), true); assert.strictEqual(fs.existsSync(destination), false); assert.strictEqual(resumed, token);
  assert.strictEqual(projectPublisherCalls.length, 2, 'junction publish and DB rollback both use the common no-clobber publisher');

  const normalHandlers = new Map(); const renamedRow = { ...row, name: 'Archive renamed', relative_path: 'Archive renamed' }; const renamedCatalog = { projects: [renamedRow], byName: new Map([['archive renamed', renamedRow]]) };
  registerWorkspaceIpc(context(normalHandlers, { fs: symlinkFs, workspaceCatalogs: new Map([[renameRoot, catalog]]), workspaceRepository: { renameProject: async () => ({ success: true }) }, refreshWorkspaceCatalog: async () => renamedCatalog, publishPathNoClobber: projectPublisher, suppressWorkspaceWatchPath: () => undefined, releaseWorkspaceWatchPath: () => undefined, cancelMediaTrackingScan: () => undefined }));
  const normalRename = await normalHandlers.get('workspace-rename-project')(null, renameRoot, '策划中', 'Archive', 'Archive renamed');
  assert.strictEqual(normalRename.success, true, normalRename.error); assert.strictEqual(fs.existsSync(source), false); assert.strictEqual(fs.readFileSync(path.join(destination, 'marker'), 'utf8'), 'target');

  const occupiedSource = path.join(renameRoot, 'Occupied source'); const occupiedTarget = path.join(renameRoot, 'Occupied target'); fs.mkdirSync(occupiedSource); fs.mkdirSync(occupiedTarget); fs.writeFileSync(path.join(occupiedTarget, 'occupant'), 'keep');
  const occupiedRow = { id: 'occupied-id', name: 'Occupied source', status: '策划中', relative_path: 'Occupied source', extra_json: '{}' }; const occupiedCatalog = { projects: [occupiedRow], byName: new Map([['occupied source', occupiedRow]]) }; const occupiedHandlers = new Map(); let occupiedDbCalls = 0;
  registerWorkspaceIpc(context(occupiedHandlers, { workspaceCatalogs: new Map([[renameRoot, occupiedCatalog]]), workspaceRepository: { renameProject: async () => { occupiedDbCalls += 1; } }, refreshWorkspaceCatalog: async () => occupiedCatalog, publishPathNoClobber: projectPublisher, suppressWorkspaceWatchPath: () => undefined, releaseWorkspaceWatchPath: () => undefined, cancelMediaTrackingScan: () => undefined }));
  const occupiedRename = await occupiedHandlers.get('workspace-rename-project')(null, renameRoot, '策划中', 'Occupied source', 'Occupied target');
  assert.strictEqual(occupiedRename.success, false); assert.strictEqual(occupiedRename.error.includes('同名项目'), true); assert.strictEqual(occupiedDbCalls, 0);
  assert.strictEqual(fs.existsSync(occupiedSource), true); assert.strictEqual(fs.readFileSync(path.join(occupiedTarget, 'occupant'), 'utf8'), 'keep');

  const ordinaryHistory = [{ kind: 'folder', source: path.join(temporaryRoot, 'ordinary-source'), destination: path.join(temporaryRoot, 'ordinary-destination') }]; const ordinaryHandlers = new Map();
  registerWorkspaceIpc(context(ordinaryHandlers, { renameHistory: ordinaryHistory, assertUndoIdentity: async () => { throw new Error('ordinary failure'); } }));
  const ordinaryUndoFailure = await ordinaryHandlers.get('workspace-undo-rename')(null, '');
  assert.deepStrictEqual(ordinaryUndoFailure, { success: false, error: 'ordinary failure' }); assert.strictEqual(ordinaryHistory.length, 1, 'ordinary deterministic failures remain retryable');

  const unknownOriginal = path.join(temporaryRoot, 'unknown-restore'); const unknownHistory = [{ kind: 'trash', items: [{ original: unknownOriginal, originalIdentity: null, recyclePidl: 'unknown-pidl' }] }]; const unknownHandlers = new Map();
  registerWorkspaceIpc(context(unknownHandlers, { renameHistory: unknownHistory, recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { throw Object.assign(new Error('restore transport disconnected'), { code: 'RESTORE_OUTCOME_UNKNOWN', outcomeUnknown: true, recoveryPath: 'C:\\Recovery\\item', published: true, originalMissing: true, sourceRetained: false, cleanupWarning: 'temporary artifact retained', recoveryRequired: true, partial: true, identityVerified: false, deleted: true, rollbackPending: true, nativeError: 'native detail', transferStage: 'restore', stagingExists: true, targetExists: false, recoveryAvailable: true, attemptedStagingPath: 'C:\\Recovery\\staging', publicationState: 'outcome-unknown', publishedConfirmed: false, phase: 'restore-publish' }); } } }));
  const unknownUndoFailure = await unknownHandlers.get('workspace-undo-rename')(null, '');
  assert.strictEqual(unknownUndoFailure.success, false); assert.strictEqual(unknownUndoFailure.code, 'RESTORE_OUTCOME_UNKNOWN'); assert.strictEqual(unknownUndoFailure.errorCode, 'RESTORE_OUTCOME_UNKNOWN'); assert.strictEqual(unknownUndoFailure.outcomeUnknown, true); assert.strictEqual(unknownUndoFailure.recoveryPath, 'C:\\Recovery\\item'); assert.strictEqual(unknownUndoFailure.published, true); assert.strictEqual(unknownUndoFailure.originalMissing, true); assert.strictEqual(unknownUndoFailure.sourceRetained, false); assert.strictEqual(unknownUndoFailure.cleanupWarning, 'temporary artifact retained');
  assert.match(unknownUndoFailure.error, /恢复结果待确认/); assert.match(unknownUndoFailure.error, /C:\\Recovery\\item/); assert.strictEqual(unknownHistory.length, 0, 'unknown restore outcomes must not be blindly retried');
  for (const field of ['recoveryRequired', 'partial', 'identityVerified', 'deleted', 'rollbackPending', 'nativeError', 'transferStage', 'stagingExists', 'targetExists']) assert.strictEqual(unknownUndoFailure[field], { recoveryRequired: true, partial: true, identityVerified: false, deleted: true, rollbackPending: true, nativeError: 'native detail', transferStage: 'restore', stagingExists: true, targetExists: false }[field]);
  assert.deepStrictEqual({ recoveryAvailable: unknownUndoFailure.recoveryAvailable, attemptedStagingPath: unknownUndoFailure.attemptedStagingPath, publicationState: unknownUndoFailure.publicationState, publishedConfirmed: unknownUndoFailure.publishedConfirmed, phase: unknownUndoFailure.phase }, { recoveryAvailable: true, attemptedStagingPath: 'C:\\Recovery\\staging', publicationState: 'outcome-unknown', publishedConfirmed: false, phase: 'restore-publish' });

  const persistentRoot = path.join(temporaryRoot, 'persistent-restore'); fs.mkdirSync(persistentRoot); const persistentOriginal = path.join(persistentRoot, 'occupied.txt'); fs.writeFileSync(persistentOriginal, 'occupant');
  const persistentOperation = { kind: 'trash', workspaceRoot: persistentRoot, persistentId: 'persistent-undo', items: [{ original: persistentOriginal, originalIdentity: { device: '-1', inode: '-1', directory: false }, recyclePidl: 'primary-pidl' }] };
  const persistentHistory = [persistentOperation]; const unavailable = new Set(); let restoreCalls = 0; let latestCalls = 0; const persistentHandlers = new Map();
  const compareIdentity = async (candidate, expected) => { try { const stat = await fs.promises.stat(candidate, { bigint: true }); return String(stat.dev) === expected?.device && String(stat.ino) === expected?.inode && stat.isDirectory() === expected?.directory; } catch { return false; } };
  registerWorkspaceIpc(context(persistentHandlers, {
    renameHistory: persistentHistory, resolveWorkspaceRoot: value => value, samePathIdentity: compareIdentity, persistentUndoQuarantineTtlMs: 1,
    workspaceRepository: {
      markUndoRecordUnavailable: async (_root, id) => { unavailable.add(id); },
      latestUndoRecord: async () => { latestCalls += 1; return unavailable.has('persistent-undo') ? { record: null } : { record: { id: 'persistent-undo', kind: 'trash', payload: persistentOperation } }; },
    },
    recycleBinService: {
      probe: async () => ({ exists: true }),
      trash: async candidate => { fs.rmSync(candidate); return { recyclePidl: 'replacement-pidl' }; },
      restore: async ({ recyclePidl }) => { restoreCalls += 1; if (recyclePidl === 'primary-pidl') throw Object.assign(new Error('primary restore unknown'), { code: 'PRIMARY_UNKNOWN', outcomeUnknown: true, recoveryPath: 'C:\\Recovery\\primary', published: true }); throw Object.assign(new Error('replacement rollback unknown'), { code: 'ROLLBACK_UNKNOWN', outcomeUnknown: true, recoveryPath: 'C:\\Recovery\\rollback', deleted: true, cleanupWarning: 'rollback artifact retained' }); },
    },
  }));
  const dualRecovery = await persistentHandlers.get('workspace-undo-rename')(null, '', { restoreConflictPolicy: 'overwrite' });
  assert.strictEqual(dualRecovery.code, 'PRIMARY_UNKNOWN'); assert.strictEqual(dualRecovery.recoveryPath, 'C:\\Recovery\\primary'); assert.strictEqual(dualRecovery.rollbackRecovery.code, 'ROLLBACK_UNKNOWN'); assert.strictEqual(dualRecovery.rollbackRecovery.recoveryPath, 'C:\\Recovery\\rollback');
  assert.strictEqual(dualRecovery.recoveries.length, 2); assert.strictEqual(dualRecovery.recoveries[0].code, 'PRIMARY_UNKNOWN'); assert.strictEqual(dualRecovery.recoveries[1].code, 'ROLLBACK_UNKNOWN'); assert.match(dualRecovery.error, /C:\\Recovery\\primary/); assert.match(dualRecovery.error, /C:\\Recovery\\rollback/);
  assert.strictEqual(unavailable.has('persistent-undo'), true); assert.strictEqual(restoreCalls, 2);
  await new Promise(resolve => setTimeout(resolve, 10));
  const secondPersistentUndo = await persistentHandlers.get('workspace-undo-rename')(null, persistentRoot);
  assert.strictEqual(secondPersistentUndo.error, '没有可撤销的操作'); assert.strictEqual(latestCalls, 3); assert.strictEqual(restoreCalls, 2, 'terminal persistent recovery must not execute again');

  const blockedRoot = path.join(temporaryRoot, 'blocked-persistent'); fs.mkdirSync(blockedRoot); const blockedOriginal = path.join(blockedRoot, 'restore.txt');
  const blockedPayload = { items: [{ original: blockedOriginal, originalIdentity: null, recyclePidl: 'blocked-pidl' }] }; const blockedOperation = { kind: 'trash', workspaceRoot: blockedRoot, persistentId: 'blocked-undo', ...blockedPayload };
  const blockedHistory = [blockedOperation]; const blockedHandlers = new Map(); let blockedRestoreCalls = 0; let blockedClaimCalls = 0; let blockedLatestCalls = 0;
  registerWorkspaceIpc(context(blockedHandlers, {
    renameHistory: blockedHistory, resolveWorkspaceRoot: value => value, persistentUndoQuarantineTtlMs: 1,
    workspaceRepository: { claimUndoRecordExecution: async () => { blockedClaimCalls += 1; throw new Error('operations DB offline'); }, latestUndoRecord: async () => { blockedLatestCalls += 1; return { record: { id: 'blocked-undo', kind: 'trash', payload: blockedPayload } }; } },
    recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { blockedRestoreCalls += 1; throw Object.assign(new Error('blocked restore unknown'), { code: 'BLOCKED_UNKNOWN', outcomeUnknown: true, recoveryPath: 'C:\\Recovery\\blocked' }); } },
  }));
  const firstBlocked = await blockedHandlers.get('workspace-undo-rename')(null, '');
  await new Promise(resolve => setTimeout(resolve, 10));
  const secondBlocked = await blockedHandlers.get('workspace-undo-rename')(null, blockedRoot);
  assert.strictEqual(firstBlocked.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(secondBlocked.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.match(firstBlocked.error, /operations DB offline/);
  assert.strictEqual(blockedRestoreCalls, 0, 'failed execution CAS stops before restore'); assert.strictEqual(blockedLatestCalls, 3); assert.strictEqual(blockedClaimCalls, 1, 'an existing tombstone never retries execution CAS as a loser'); assert.strictEqual(blockedHistory.length, 0);
  assert.strictEqual(claimMarkers(blockedRoot).length, 1, 'failed marking retains the durable claim');

  const rejectedClaimRoot = path.join(temporaryRoot, 'execution-claim-rejected'); fs.mkdirSync(rejectedClaimRoot); let rejectedClaimRestores = 0;
  const rejectedClaimHandlers = new Map(); registerWorkspaceIpc(context(rejectedClaimHandlers, {
    resolveWorkspaceRoot: value => value,
    workspaceRepository: { latestUndoRecord: async () => ({ record: { id: 'execution-claim-rejected', kind: 'trash', payload: { items: [{ original: path.join(rejectedClaimRoot, 'restore.txt'), recyclePidl: 'rejected-pidl' }] } } }), claimUndoRecordExecution: async () => ({ claimed: false }) },
    recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { rejectedClaimRestores += 1; } },
  }));
  const rejectedClaim = await rejectedClaimHandlers.get('workspace-undo-rename')(null, rejectedClaimRoot);
  assert.strictEqual(rejectedClaim.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(rejectedClaimRestores, 0); assert.strictEqual(claimMarkers(rejectedClaimRoot).length, 1, 'a false execution CAS retains its marker with zero restore side effects');

  const versionRaceRoot = path.join(temporaryRoot, 'execution-version-race'); fs.mkdirSync(versionRaceRoot); const versionRaceOldPayload = { items: [{ original: path.join(versionRaceRoot, 'old.txt'), recyclePidl: 'old-pidl' }] }; const versionRaceNewPayload = { items: [{ original: path.join(versionRaceRoot, 'new.txt'), recyclePidl: 'new-pidl' }] }; let versionRaceLatestCalls = 0; let versionRaceClaimCalls = 0; let versionRaceRestores = 0;
  const oldVersionToken = '1'.repeat(64); const newVersionToken = '2'.repeat(64);
  const versionRaceHandlers = new Map(); registerWorkspaceIpc(context(versionRaceHandlers, {
    renameHistory: [{ kind: 'trash', workspaceRoot: versionRaceRoot, persistentId: 'same-id-version-race', items: [{ original: path.join(versionRaceRoot, 'memory.txt'), recyclePidl: 'memory-pidl' }] }],
    workspaceRepository: { latestUndoRecord: async () => ({ record: versionRaceLatestCalls++ === 0 ? { id: 'same-id-version-race', kind: 'trash', payload: versionRaceOldPayload, claimToken: oldVersionToken } : { id: 'same-id-version-race', kind: 'trash', payload: versionRaceNewPayload, claimToken: newVersionToken } }), claimUndoRecordExecution: async () => { versionRaceClaimCalls += 1; return { claimed: true }; } },
    recycleBinService: { probe: async pidl => ({ exists: pidl === 'old-pidl' }), restore: async () => { versionRaceRestores += 1; } },
  }));
  const versionRace = await versionRaceHandlers.get('workspace-undo-rename')(null, '');
  assert.strictEqual(versionRace.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(versionRaceClaimCalls, 0); assert.strictEqual(versionRaceRestores, 0, 'same-ID replacement between bind and CAS cannot restore the old DB payload'); assert.strictEqual(claimMarkers(versionRaceRoot).length, 1);

  const crossRoot = path.join(temporaryRoot, 'cross-process-unknown'); fs.mkdirSync(crossRoot); const crossId = 'cross-process-undo'; const crossOriginal = path.join(crossRoot, 'restore.txt');
  const crossPayload = { items: [{ original: crossOriginal, originalIdentity: null, recyclePidl: 'cross-pidl' }] }; let crossRestoreCalls = 0; let crossProbeCalls = 0; let crossMarkCalls = 0;
  let crossClaimCalls = 0;
  const crossRepository = { latestUndoRecord: async () => ({ record: { id: crossId, kind: 'trash', payload: crossPayload } }), claimUndoRecordExecution: async () => { crossClaimCalls += 1; return { claimed: true }; }, markUndoRecordUnavailable: async () => { crossMarkCalls += 1; } };
  const crossRecycle = { probe: async () => { crossProbeCalls += 1; return { exists: true }; }, restore: async () => { crossRestoreCalls += 1; throw Object.assign(new Error('restore outcome unknown'), { code: 'RESTORE_OUTCOME_UNKNOWN', outcomeUnknown: true }); } };
  const crossFirstHandlers = new Map(); const crossSecondHandlers = new Map();
  registerWorkspaceIpc(context(crossFirstHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: crossRepository, recycleBinService: crossRecycle }));
  registerWorkspaceIpc(context(crossSecondHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: crossRepository, recycleBinService: crossRecycle }));
  const crossFirst = await crossFirstHandlers.get('workspace-undo-rename')(null, crossRoot);
  const crossSecond = await crossSecondHandlers.get('workspace-undo-rename')(null, crossRoot);
  assert.strictEqual(crossFirst.code, 'RESTORE_OUTCOME_UNKNOWN', JSON.stringify(crossFirst)); assert.strictEqual(crossSecond.code, 'PERSISTENT_UNDO_RECOVERY_PENDING', JSON.stringify(crossSecond));
  assert.strictEqual(crossRestoreCalls, 1, 'a new IPC instance cannot repeat an outcome-unknown restore'); assert.strictEqual(crossProbeCalls, 1, 'an existing claim bypasses probing'); assert.strictEqual(crossClaimCalls, 1, 'only the marker winner obtains DB execution rights'); assert.strictEqual(crossMarkCalls, 1, 'terminal recovery bookkeeping cannot revive the retired row');

  const crashRoot = path.join(temporaryRoot, 'cross-process-crash'); fs.mkdirSync(crashRoot); const crashId = 'crash-before-mark'; const crashOriginal = path.join(crashRoot, 'restore.txt');
  const crashPayload = { items: [{ original: crashOriginal, originalIdentity: null, recyclePidl: 'crash-pidl' }] }; let crashRestoreCalls = 0; let crashProbeCalls = 0; let crashState = 'ready'; let crashClaimCalls = 0;
  const crashFirstHandlers = new Map(); const crashSecondHandlers = new Map();
  const crashRepository = { latestUndoRecord: async () => ({ record: crashState === 'ready' ? { id: crashId, kind: 'trash', payload: crashPayload } : null }), claimUndoRecordExecution: async () => { crashClaimCalls += 1; if (crashState !== 'ready') return { claimed: false }; crashState = 'retired'; return { claimed: true }; }, markUndoRecordUnavailable: async () => undefined };
  registerWorkspaceIpc(context(crashFirstHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: crashRepository, afterPersistentUndoExecutionClaim: async () => { throw new Error('simulated process crash after execution claim'); }, recycleBinService: { probe: async () => { crashProbeCalls += 1; return { exists: true }; }, restore: async () => { crashRestoreCalls += 1; } } }));
  registerWorkspaceIpc(context(crashSecondHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: crashRepository, recycleBinService: { probe: async () => { crashProbeCalls += 1; return { exists: true }; }, restore: async () => { crashRestoreCalls += 1; } } }));
  const crashedClaim = await crashFirstHandlers.get('workspace-undo-rename')(null, crashRoot);
  const recoveredClaim = await crashSecondHandlers.get('workspace-undo-rename')(null, crashRoot);
  assert.match(crashedClaim.error, /simulated process crash/); assert.strictEqual(recoveredClaim.error, '没有可撤销的操作');
  assert.strictEqual(crashState, 'retired'); assert.strictEqual(crashClaimCalls, 1); assert.strictEqual(crashRestoreCalls, 0); assert.strictEqual(crashProbeCalls, 1, 'a crash after DB execution claim cannot expose the record as ready again');

  const raceRoot = path.join(temporaryRoot, 'claim-race'); fs.mkdirSync(raceRoot); const raceId = 'concurrent-undo'; const raceOriginal = path.join(raceRoot, 'restore.txt'); const racePayload = { items: [{ original: raceOriginal, originalIdentity: null, recyclePidl: 'race-pidl' }] };
  let raceRestoreCalls = 0; let raceProbeCalls = 0; let raceClaimCalls = 0; let raceState = 'ready'; let releaseRaceProbes; const bothProbed = new Promise(resolve => { releaseRaceProbes = resolve; });
  const raceRepository = { latestUndoRecord: async () => ({ record: raceState === 'ready' ? { id: raceId, kind: 'trash', payload: racePayload } : null }), claimUndoRecordExecution: async () => { raceClaimCalls += 1; if (raceState !== 'ready') return { claimed: false }; raceState = 'retired'; return { claimed: true }; }, removeUndoRecord: async () => undefined };
  const raceRecycle = { probe: async () => { raceProbeCalls += 1; if (raceProbeCalls === 2) releaseRaceProbes(); await bothProbed; return { exists: true }; }, restore: async ({ originalPath }) => { raceRestoreCalls += 1; fs.writeFileSync(originalPath, 'restored'); } };
  const raceHandlersA = new Map(); const raceHandlersB = new Map();
  registerWorkspaceIpc(context(raceHandlersA, { resolveWorkspaceRoot: value => value, workspaceRepository: raceRepository, recycleBinService: raceRecycle }));
  registerWorkspaceIpc(context(raceHandlersB, { resolveWorkspaceRoot: value => value, workspaceRepository: raceRepository, recycleBinService: raceRecycle }));
  const raceResults = await Promise.all([raceHandlersA.get('workspace-undo-rename')(null, raceRoot), raceHandlersB.get('workspace-undo-rename')(null, raceRoot)]);
  assert.strictEqual(raceResults.filter(result => result.success).length, 1); assert.strictEqual(raceRestoreCalls, 1, 'atomic marker plus DB CAS admits exactly one concurrent restore'); assert.strictEqual(raceClaimCalls, 1); assert.strictEqual(raceState, 'retired'); assert.strictEqual(claimMarkers(raceRoot).length, 1, 'successful restore retains a permanent tombstone');

  const existingRoot = path.join(temporaryRoot, 'claim-exists'); fs.mkdirSync(existingRoot); const existingId = 'existing-claim'; const existingOriginal = path.join(existingRoot, 'restore.txt');
  fs.writeFileSync(persistentClaimPath(existingRoot, existingId), '{"foreign":true}'); let existingRestoreCalls = 0; let existingProbeCalls = 0; let existingMarkCalls = 0;
  const existingHandlers = new Map(); registerWorkspaceIpc(context(existingHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: { id: existingId, kind: 'trash', payload: { items: [{ original: existingOriginal, originalIdentity: null, recyclePidl: 'existing-pidl' }] } } }), markUndoRecordUnavailable: async () => { existingMarkCalls += 1; } }, recycleBinService: { probe: async () => { existingProbeCalls += 1; return { exists: true }; }, restore: async () => { existingRestoreCalls += 1; } } }));
  const existingResult = await existingHandlers.get('workspace-undo-rename')(null, existingRoot);
  assert.strictEqual(existingResult.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(existingProbeCalls, 0); assert.strictEqual(existingRestoreCalls, 0, 'EEXIST fails closed'); assert.strictEqual(existingMarkCalls, 0, 'startup loser does not modify the journal');

  const legacyPreflightRoot = path.join(temporaryRoot, 'legacy-preflight-full-scan'); fs.mkdirSync(legacyPreflightRoot);
  for (let index = 0; index < 150; index += 1) fs.writeFileSync(path.join(legacyPreflightRoot, `ordinary-${String(index).padStart(3, '0')}.txt`), 'ordinary');
  writeLegacyClaimMarker(legacyPreflightRoot, 'legacy-preflight-id'); let legacyPreflightRestores = 0; let legacyPreflightProbes = 0;
  const legacyPreflightHandlers = new Map(); registerWorkspaceIpc(context(legacyPreflightHandlers, {
    resolveWorkspaceRoot: value => value,
    workspaceRepository: { latestUndoRecord: async () => ({ record: { id: 'legacy-preflight-id', kind: 'trash', payload: { items: [{ original: path.join(legacyPreflightRoot, 'restore.txt'), recyclePidl: 'legacy-pidl' }] } } }) },
    recycleBinService: { probe: async () => { legacyPreflightProbes += 1; return { exists: true }; }, restore: async () => { legacyPreflightRestores += 1; } },
  }));
  const legacyPreflight = await legacyPreflightHandlers.get('workspace-undo-rename')(null, legacyPreflightRoot);
  assert.strictEqual(legacyPreflight.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(legacyPreflightProbes, 0); assert.strictEqual(legacyPreflightRestores, 0, 'schema-1 tombstones are found by a complete streaming preflight');
  for (let attempt = 0; attempt < 100 && legacyPreflightProbes === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  const legacyPreflightAgain = await legacyPreflightHandlers.get('workspace-undo-rename')(null, legacyPreflightRoot);
  assert.strictEqual(legacyPreflightAgain.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(legacyPreflightProbes, 0, 'background completion keeps a discovered legacy marker permanently blocking');

  const legacyAbsentRoot = path.join(temporaryRoot, 'legacy-preflight-absent'); fs.mkdirSync(legacyAbsentRoot); for (let index = 0; index < 180; index += 1) fs.writeFileSync(path.join(legacyAbsentRoot, `ordinary-${String(index).padStart(3, '0')}.txt`), 'ordinary'); let legacyAbsentState = 'ready'; let legacyAbsentRestores = 0;
  const legacyAbsentPayload = { items: [{ original: path.join(legacyAbsentRoot, 'restore.txt'), recyclePidl: 'legacy-absent-pidl' }] }; const legacyAbsentHandlers = new Map(); registerWorkspaceIpc(context(legacyAbsentHandlers, {
    resolveWorkspaceRoot: value => value, persistentUndoInteractiveVisitedLimit: 4, persistentUndoInteractiveBudgetMs: 10000,
    workspaceRepository: { latestUndoRecord: async () => ({ record: legacyAbsentState === 'ready' ? { id: 'legacy-absent-id', kind: 'trash', payload: legacyAbsentPayload } : null }), claimUndoRecordExecution: async () => { legacyAbsentState = 'retired'; return { claimed: true }; }, removeUndoRecord: async () => undefined },
    recycleBinService: { probe: async () => ({ exists: true }), restore: async ({ originalPath }) => { legacyAbsentRestores += 1; fs.writeFileSync(originalPath, 'restored'); } },
  }));
  const legacyAbsentFirst = await legacyAbsentHandlers.get('workspace-undo-rename')(null, legacyAbsentRoot); assert.strictEqual(legacyAbsentFirst.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(legacyAbsentRestores, 0);
  let legacyAbsentSecond;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
    legacyAbsentSecond = await legacyAbsentHandlers.get('workspace-undo-rename')(null, legacyAbsentRoot);
    if (legacyAbsentSecond.success) break;
  }
  assert.strictEqual(legacyAbsentSecond.success, true, legacyAbsentSecond.error); assert.strictEqual(legacyAbsentRestores, 1, 'undo proceeds only after the background legacy scan reaches EOF');

  const capacityInteractiveRoots = ['a', 'b'].map(name => path.join(temporaryRoot, `legacy-interactive-capacity-${name}`)); for (const root of capacityInteractiveRoots) { fs.mkdirSync(root); for (let index = 0; index < 20; index += 1) fs.writeFileSync(path.join(root, `ordinary-${index}.txt`), 'ordinary'); }
  const capacityInteractiveStates = new Map(capacityInteractiveRoots.map(root => [root, 'ready'])); const capacityInteractiveHandlers = new Map(); registerWorkspaceIpc(context(capacityInteractiveHandlers, {
    resolveWorkspaceRoot: value => value, persistentUndoInteractiveCapacity: 1, persistentUndoInteractiveVisitedLimit: 1, persistentUndoInteractiveBudgetMs: 10000,
    workspaceRepository: { latestUndoRecord: async root => ({ record: capacityInteractiveStates.get(root) === 'ready' ? { id: `capacity-${path.basename(root)}`, kind: 'trash', payload: { items: [{ original: path.join(root, 'restore.txt'), recyclePidl: `pidl-${path.basename(root)}` }] } } : null }), claimUndoRecordExecution: async root => { capacityInteractiveStates.set(root, 'retired'); return { claimed: true }; }, removeUndoRecord: async () => undefined },
    recycleBinService: { probe: async () => ({ exists: true }), restore: async ({ originalPath }) => { fs.writeFileSync(originalPath, 'restored'); } },
  }));
  for (const root of capacityInteractiveRoots) assert.strictEqual((await capacityInteractiveHandlers.get('workspace-undo-rename')(null, root)).code, 'PERSISTENT_UNDO_RECOVERY_PENDING');
  for (const root of [...capacityInteractiveRoots].reverse()) {
    let outcome;
    for (let attempt = 0; attempt < 100; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); outcome = await capacityInteractiveHandlers.get('workspace-undo-rename')(null, root); if (outcome.success) break; }
    assert.strictEqual(outcome.success, true, `capacity-one interactive scan must eventually admit ${root}`);
  }

  const unsafeDirectoryRoot = path.join(temporaryRoot, 'claim-directory-symlink'); fs.mkdirSync(unsafeDirectoryRoot); const unsafeTarget = path.join(temporaryRoot, 'claim-directory-target'); fs.mkdirSync(unsafeTarget); let unsafeDirectoryCreated = false;
  try { fs.symlinkSync(unsafeTarget, path.join(unsafeDirectoryRoot, '.photoflow-undo-claims'), process.platform === 'win32' ? 'junction' : 'dir'); unsafeDirectoryCreated = true; } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error; }
  if (unsafeDirectoryCreated) {
    let unsafeRestores = 0; const unsafeHandlers = new Map(); registerWorkspaceIpc(context(unsafeHandlers, {
      resolveWorkspaceRoot: value => value,
      workspaceRepository: { latestUndoRecord: async () => ({ record: { id: 'unsafe-directory-id', kind: 'trash', payload: { items: [{ original: path.join(unsafeDirectoryRoot, 'restore.txt'), recyclePidl: 'unsafe-pidl' }] } } }) },
      recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { unsafeRestores += 1; } },
    }));
    const unsafeResult = await unsafeHandlers.get('workspace-undo-rename')(null, unsafeDirectoryRoot);
    assert.strictEqual(unsafeResult.code, 'CLAIM_PERSIST_FAILED'); assert.strictEqual(unsafeRestores, 0, 'a symlink/junction claim directory fails closed');
  }

  const renameOriginalRoot = path.join(temporaryRoot, 'claim-workspace-before-rename'); fs.mkdirSync(renameOriginalRoot); const renameWorkspaceId = '0123456789abcdef0123456789abcdef'; fs.writeFileSync(path.join(renameOriginalRoot, '.photoflow-workspace-id'), `${renameWorkspaceId}\n`);
  const renameRecordId = 'rename-stable-marker'; const renamePayload = { items: [{ original: path.join(renameOriginalRoot, 'restore.txt'), originalIdentity: null, recyclePidl: 'rename-pidl' }] }; let renameState = 'ready'; let renameRestoreCalls = 0;
  const renameRepository = { latestUndoRecord: async () => ({ record: renameState === 'ready' ? { id: renameRecordId, kind: 'trash', payload: renamePayload } : null }), markUndoRecordUnavailable: async () => { renameState = 'unavailable'; }, removeUndoRecord: async () => { renameState = 'absent'; } };
  const renameFirstHandlers = new Map(); registerWorkspaceIpc(context(renameFirstHandlers, { persistentUndoWorkspaceId: undefined, resolveWorkspaceRoot: value => value, workspaceRepository: renameRepository, recycleBinService: { probe: async () => ({ exists: true }), restore: async ({ originalPath }) => { renameRestoreCalls += 1; fs.writeFileSync(originalPath, 'restored'); } } }));
  const renameFirst = await renameFirstHandlers.get('workspace-undo-rename')(null, renameOriginalRoot); assert.strictEqual(renameFirst.success, true, renameFirst.error); assert.strictEqual(renameRestoreCalls, 1);
  const renamedRoot = path.join(temporaryRoot, 'claim-workspace-after-rename'); fs.renameSync(renameOriginalRoot, renamedRoot); renameState = 'ready';
  const renameSecondHandlers = new Map(); registerWorkspaceIpc(context(renameSecondHandlers, { persistentUndoWorkspaceId: undefined, resolveWorkspaceRoot: value => value, workspaceRepository: renameRepository, recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { renameRestoreCalls += 1; } } }));
  const renameSecond = await renameSecondHandlers.get('workspace-undo-rename')(null, renamedRoot);
  assert.strictEqual(renameSecond.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(renameRestoreCalls, 1, 'workspace rename retains the stable v2 claim and prevents a second restore');

  const claimFailureCase = async (label, openFailure) => {
    const root = path.join(temporaryRoot, label); fs.mkdirSync(root); const id = `${label}-id`; const original = path.join(root, 'restore.txt'); let restoreCount = 0;
    const failingFs = { ...fs, promises: { ...fs.promises, open: async (candidate, flags, mode) => {
      if (path.basename(path.dirname(candidate)) === '.photoflow-undo-claims') return openFailure(candidate, flags, mode);
      return fs.promises.open(candidate, flags, mode);
    } } };
    const handlers = new Map(); registerWorkspaceIpc(context(handlers, { fs: failingFs, resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: { id, kind: 'trash', payload: { items: [{ original, originalIdentity: null, recyclePidl: `${id}-pidl` }] } } }), markUndoRecordUnavailable: async () => undefined }, recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { restoreCount += 1; } } }));
    const result = await handlers.get('workspace-undo-rename')(null, root); return { result, restoreCount, root };
  };
  const writeFailure = await claimFailureCase('claim-write-failure', async (candidate, flags, mode) => { const handle = await fs.promises.open(candidate, flags, mode); return { writeFile: async () => { throw new Error('claim write failed'); }, sync: (...args) => handle.sync(...args), stat: (...args) => handle.stat(...args), close: (...args) => handle.close(...args) }; });
  assert.strictEqual(writeFailure.result.code, 'CLAIM_PERSIST_FAILED'); assert.strictEqual(writeFailure.restoreCount, 0); assert.strictEqual(claimMarkers(writeFailure.root).length, 1);
  const unknownClaim = await claimFailureCase('claim-outcome-unknown', async () => { throw Object.assign(new Error('claim publication unknown'), { outcomeUnknown: true }); });
  assert.strictEqual(unknownClaim.result.code, 'CLAIM_PERSIST_FAILED'); assert.strictEqual(unknownClaim.restoreCount, 0); assert.strictEqual(claimMarkers(unknownClaim.root).length, 0);

  const parentSyncRoot = path.join(temporaryRoot, 'claim-parent-sync-failure'); fs.mkdirSync(parentSyncRoot); const parentSyncId = 'parent-sync-id'; const parentSyncOriginal = path.join(parentSyncRoot, 'restore.txt'); let parentSyncRestoreCalls = 0;
  const parentSyncFs = { ...fs, promises: { ...fs.promises, open: async (candidate, flags, mode) => {
    const handle = await fs.promises.open(candidate, flags, mode);
    if (path.resolve(candidate) !== path.resolve(parentSyncRoot) || flags !== 'r') return handle;
    return { sync: async () => { throw new Error('parent fsync failed'); }, close: (...args) => handle.close(...args) };
  } } };
  const parentSyncHandlers = new Map(); registerWorkspaceIpc(context(parentSyncHandlers, { fs: parentSyncFs, platform: 'linux', resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: { id: parentSyncId, kind: 'trash', payload: { items: [{ original: parentSyncOriginal, originalIdentity: null, recyclePidl: 'parent-sync-pidl' }] } } }), markUndoRecordUnavailable: async () => undefined }, recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { parentSyncRestoreCalls += 1; } } }));
  const parentSyncFailure = await parentSyncHandlers.get('workspace-undo-rename')(null, parentSyncRoot);
  assert.strictEqual(parentSyncFailure.code, 'CLAIM_PERSIST_FAILED'); assert.strictEqual(parentSyncRestoreCalls, 0, 'POSIX parent fsync failure stops before restore'); assert.strictEqual(claimMarkers(parentSyncRoot).length, 0, 'directory publication failure stops before marker creation');

  const staleNullRoot = path.join(temporaryRoot, 'claim-stale-null'); fs.mkdirSync(staleNullRoot); const staleNullId = 'stale-null-id'; let staleNullMarkCalls = 0; let staleNullRestoreCalls = 0;
  const staleNullHandlers = new Map(); registerWorkspaceIpc(context(staleNullHandlers, { renameHistory: [{ kind: 'trash', workspaceRoot: staleNullRoot, persistentId: staleNullId, items: [{ original: path.join(staleNullRoot, 'restore.txt'), originalIdentity: null, recyclePidl: 'stale-null-pidl' }] }], workspaceRepository: { latestUndoRecord: async () => ({ record: null }), markUndoRecordUnavailable: async () => { staleNullMarkCalls += 1; } }, recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { staleNullRestoreCalls += 1; } } }));
  const staleNull = await staleNullHandlers.get('workspace-undo-rename')(null, ''); assert.strictEqual(staleNull.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(staleNullMarkCalls, 0); assert.strictEqual(staleNullRestoreCalls, 0); assert.strictEqual(claimMarkers(staleNullRoot).length, 0, 'an unbound memory operation stops before marker creation');

  const staleOtherRoot = path.join(temporaryRoot, 'claim-stale-other'); fs.mkdirSync(staleOtherRoot); const staleOtherId = 'stale-other-id'; let staleOtherMarkCalls = 0; let staleOtherRestoreCalls = 0;
  const staleOtherHandlers = new Map(); registerWorkspaceIpc(context(staleOtherHandlers, { renameHistory: [{ kind: 'trash', workspaceRoot: staleOtherRoot, persistentId: staleOtherId, items: [{ original: path.join(staleOtherRoot, 'restore.txt'), originalIdentity: null, recyclePidl: 'stale-other-pidl' }] }], workspaceRepository: { latestUndoRecord: async () => ({ record: { id: 'different-ready-id', kind: 'trash', payload: { items: [] } } }), markUndoRecordUnavailable: async () => { staleOtherMarkCalls += 1; } }, recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { staleOtherRestoreCalls += 1; } } }));
  const staleOther = await staleOtherHandlers.get('workspace-undo-rename')(null, ''); assert.strictEqual(staleOther.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(staleOtherMarkCalls, 0); assert.strictEqual(staleOtherRestoreCalls, 0); assert.strictEqual(claimMarkers(staleOtherRoot).length, 0, 'different-id binding fails before marker creation');

  const successRoot = path.join(temporaryRoot, 'claim-success'); fs.mkdirSync(successRoot); const successId = 'success-id'; const successOriginal = path.join(successRoot, 'restore.txt'); let successState = 'ready'; let successClaimCalls = 0; let successRestoreCalls = 0; let successUnlinkCalls = 0;
  const successFs = { ...fs, promises: { ...fs.promises, unlink: async () => { successUnlinkCalls += 1; throw new Error('marker unlink must never run'); } } };
  const successHandlers = new Map(); registerWorkspaceIpc(context(successHandlers, { fs: successFs, resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: successState === 'ready' ? { id: successId, kind: 'trash', payload: { items: [{ original: successOriginal, originalIdentity: null, recyclePidl: 'success-pidl' }] } } : null }), claimUndoRecordExecution: async () => { successClaimCalls += 1; successState = 'retired'; return { claimed: true }; }, removeUndoRecord: async () => undefined }, recycleBinService: { probe: async () => ({ exists: true }), restore: async ({ originalPath }) => { successRestoreCalls += 1; fs.writeFileSync(originalPath, 'restored'); } } }));
  const successUndo = await successHandlers.get('workspace-undo-rename')(null, successRoot); assert.strictEqual(successUndo.success, true, successUndo.error); assert.strictEqual(successState, 'retired'); assert.strictEqual(claimMarkers(successRoot).length, 1, 'normal success retains the permanent tombstone'); assert.strictEqual(successUnlinkCalls, 0, 'normal success never unlinks a claim path');
  const repeatedSuccessUndo = await successHandlers.get('workspace-undo-rename')(null, successRoot); assert.strictEqual(repeatedSuccessUndo.error, '没有可撤销的操作'); assert.strictEqual(successRestoreCalls, 1); assert.strictEqual(successClaimCalls, 1); assert.strictEqual(successUnlinkCalls, 0);

  const removeFailureRoot = path.join(temporaryRoot, 'claim-remove-failure'); fs.mkdirSync(removeFailureRoot); const removeFailureId = 'remove-failure-id'; const removeFailureOriginal = path.join(removeFailureRoot, 'restore.txt');
  const removeFailureHandlers = new Map(); registerWorkspaceIpc(context(removeFailureHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: { id: removeFailureId, kind: 'trash', payload: { items: [{ original: removeFailureOriginal, originalIdentity: null, recyclePidl: 'remove-failure-pidl' }] } } }), markUndoRecordUnavailable: async () => undefined, removeUndoRecord: async () => { throw new Error('DB remove failed'); } }, recycleBinService: { probe: async () => ({ exists: true }), restore: async ({ originalPath }) => { fs.writeFileSync(originalPath, 'restored'); } } }));
  const removeFailure = await removeFailureHandlers.get('workspace-undo-rename')(null, removeFailureRoot); assert.strictEqual(removeFailure.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(claimMarkers(removeFailureRoot).length, 1, 'DB removal failure retains claim');

  const retryRoot = path.join(temporaryRoot, 'claim-preflight-retry'); fs.mkdirSync(retryRoot); const retryVolume = path.join(retryRoot, 'offline-volume'); const retryConflict = path.join(retryRoot, 'conflict.txt'); fs.writeFileSync(retryConflict, 'occupant');
  const volumePayload = { items: [{ original: path.join(retryVolume, 'item.txt'), originalIdentity: null, recyclePidl: 'volume-pidl' }] };
  const volumeHandlers = new Map(); registerWorkspaceIpc(context(volumeHandlers, { renameHistory: [{ kind: 'trash', workspaceRoot: retryRoot, persistentId: 'volume-id', ...volumePayload }], workspaceRepository: { latestUndoRecord: async () => ({ record: { id: 'volume-id', kind: 'trash', payload: volumePayload } }) }, pathExists: async candidate => candidate !== path.parse(path.join(retryVolume, 'item.txt')).root, recycleBinService: { probe: async () => ({ exists: true }) } }));
  const volumeRetry = await volumeHandlers.get('workspace-undo-rename')(null, ''); assert.strictEqual(volumeRetry.code, 'RESTORE_VOLUME_UNAVAILABLE'); assert.strictEqual(claimMarkers(retryRoot).length, 0, 'volume preflight errors precede claim creation');
  const conflictPayload = { items: [{ original: retryConflict, originalIdentity: null, recyclePidl: 'conflict-pidl' }] };
  const conflictHandlers = new Map(); registerWorkspaceIpc(context(conflictHandlers, { renameHistory: [{ kind: 'trash', workspaceRoot: retryRoot, persistentId: 'conflict-id', ...conflictPayload }], workspaceRepository: { latestUndoRecord: async () => ({ record: { id: 'conflict-id', kind: 'trash', payload: conflictPayload } }) }, samePathIdentity: async () => false, capturePathIdentity: async candidate => { const stat = await fs.promises.stat(candidate, { bigint: true }); return { device: String(stat.dev), inode: String(stat.ino), directory: stat.isDirectory() }; }, recycleBinService: { probe: async () => ({ exists: true }) } }));
  const conflictRetry = await conflictHandlers.get('workspace-undo-rename')(null, ''); assert.strictEqual(conflictRetry.requiresDecision.kind, 'restore-conflict'); assert.strictEqual(claimMarkers(retryRoot).length, 0, 'conflict decision precedes claim creation');

  const overflowRoot = path.join(temporaryRoot, 'overflow-persistent'); fs.mkdirSync(overflowRoot); const overflowHistory = []; const overflowHandlers = new Map(); let overflowRestoreCalls = 0; let overflowMarkCalls = 0; let overflowLatestId = 'overflow-a';
  const overflowOperation = id => ({ kind: 'trash', workspaceRoot: overflowRoot, persistentId: id, items: [{ original: path.join(overflowRoot, `${id}.txt`), originalIdentity: null, recyclePidl: `${id}-pidl` }] });
  overflowHistory.push(overflowOperation('overflow-a'));
  registerWorkspaceIpc(context(overflowHandlers, {
    renameHistory: overflowHistory, resolveWorkspaceRoot: value => value, persistentUndoQuarantineCapacity: 1, persistentUndoQuarantineTtlMs: 1,
    workspaceRepository: { markUndoRecordUnavailable: async () => { overflowMarkCalls += 1; throw new Error('persistent store unavailable'); }, latestUndoRecord: async () => ({ record: { id: overflowLatestId, kind: 'trash', payload: { items: overflowOperation(overflowLatestId).items } } }) },
    recycleBinService: { probe: async () => ({ exists: true }), restore: async ({ recyclePidl }) => { overflowRestoreCalls += 1; throw Object.assign(new Error(`terminal ${recyclePidl}`), { code: 'OVERFLOW_TERMINAL', outcomeUnknown: true }); } },
  }));
  const overflowFirst = await overflowHandlers.get('workspace-undo-rename')(null, ''); assert.strictEqual(overflowFirst.code, 'PERSISTENT_UNDO_RECOVERY_PENDING');
  await new Promise(resolve => setTimeout(resolve, 10));
  overflowLatestId = 'overflow-b'; overflowHistory.push(overflowOperation('overflow-b'));
  const overflowSecond = await overflowHandlers.get('workspace-undo-rename')(null, ''); assert.strictEqual(overflowSecond.code, 'PERSISTENT_UNDO_RECOVERY_PENDING');
  overflowLatestId = 'overflow-c';
  const overflowThird = await overflowHandlers.get('workspace-undo-rename')(null, overflowRoot);
  assert.strictEqual(overflowThird.code, 'PERSISTENT_UNDO_QUARANTINE_OVERFLOW'); assert.match(overflowThird.error, /安全隔离已达到容量上限/);
  assert.strictEqual(overflowRestoreCalls, 0, 'failed claiming and overflow both stop before restore'); assert.strictEqual(overflowMarkCalls, 5);

  const missingPersistentRoot = path.join(temporaryRoot, 'missing-persistent'); fs.mkdirSync(missingPersistentRoot); const missingPersistentPayload = { items: [{ original: path.join(missingPersistentRoot, 'gone'), originalIdentity: null, recyclePidl: 'gone-pidl' }] };
  const missingPersistentHistory = [{ kind: 'trash', workspaceRoot: missingPersistentRoot, persistentId: 'missing-undo', ...missingPersistentPayload }]; const missingPersistentHandlers = new Map(); let missingProbeCalls = 0; let missingMarkCalls = 0; let missingPersistentState = 'ready';
  registerWorkspaceIpc(context(missingPersistentHandlers, {
    renameHistory: missingPersistentHistory, resolveWorkspaceRoot: value => value,
    workspaceRepository: { markUndoRecordUnavailable: async () => { missingMarkCalls += 1; throw new Error('mark unavailable failed'); }, latestUndoRecord: async () => ({ record: missingPersistentState === 'ready' ? { id: 'missing-undo', kind: 'trash', payload: missingPersistentPayload } : null }), claimUndoRecordExecution: async () => { if (missingPersistentState !== 'ready') return { claimed: false }; missingPersistentState = 'retired'; return { claimed: true }; } },
    recycleBinService: { probe: async () => { missingProbeCalls += 1; return { exists: false }; } },
  }));
  const firstMissingPersistent = await missingPersistentHandlers.get('workspace-undo-rename')(null, '');
  const secondMissingPersistent = await missingPersistentHandlers.get('workspace-undo-rename')(null, missingPersistentRoot);
  assert.strictEqual(firstMissingPersistent.code, 'RECYCLE_ITEM_MISSING'); assert.match(firstMissingPersistent.cleanupWarning, /mark unavailable failed/); assert.strictEqual(secondMissingPersistent.error, '没有可撤销的操作');
  assert.strictEqual(missingPersistentState, 'retired'); assert.strictEqual(missingProbeCalls, 1, 'terminal missing is version-CAS retired before another instance can probe'); assert.strictEqual(missingMarkCalls, 3); assert.strictEqual(missingPersistentHistory.length, 0);

  const missingHistory = [{ kind: 'trash', items: [{ original: path.join(temporaryRoot, 'missing-restore'), originalIdentity: null, recyclePidl: 'missing-pidl' }] }]; const missingHandlers = new Map();
  registerWorkspaceIpc(context(missingHandlers, { renameHistory: missingHistory, recycleBinService: { probe: async () => ({ exists: false }) } }));
  const missingUndoFailure = await missingHandlers.get('workspace-undo-rename')(null, '');
  assert.strictEqual(missingUndoFailure.code, 'RECYCLE_ITEM_MISSING'); assert.strictEqual(missingHistory.length, 0, 'missing recycle items remain unavailable instead of being requeued');
  console.log('workspace transaction safety execution tests passed');
};

run().finally(() => fs.rmSync(temporaryRoot, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
