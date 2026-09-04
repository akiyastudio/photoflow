const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema, withRestoreLease, withRestorePhase } = require('../service.cjs');

(async () => {
  await assert.rejects(
    withRestoreLease({}, async () => undefined, []),
    error => error?.code === 'COMPONENT_RESTORE_FORBIDDEN',
    'renderer-callable context cannot authorize a restore hook',
  );
  await assert.rejects(
    withRestoreLease({ componentBackupRestore: true, surface: 'backup.restore' }, async () => undefined, ['workflow-operation']),
    error => error?.code === 'COMPONENT_BUSY' && error.retryable === true,
    'restore rejects while component-owned background work can still write',
  );
  let release;
  const first = withRestoreLease({ componentBackupRestore: true, surface: 'backup.restore' }, () => new Promise(resolve => { release = resolve; }), []);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    withRestoreLease({ componentBackupRestore: true, surface: 'backup.restore' }, async () => undefined, []),
    error => error?.code === 'COMPONENT_BUSY',
    'restore lease is exclusive',
  );
  release();
  await first;
  assert.equal(await withRestoreLease({ componentBackupRestore: true, surface: 'backup.restore' }, async () => 'released', []), 'released');
  const context = { componentBackupRestore: true, surface: 'backup.restore' };
  const phaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-restore-phase-'));
  const databasePath = path.join(phaseRoot, 'data', 'storage.sqlite3');
  const storage = { databasePath, dataPath: path.dirname(databasePath), controlPath: path.join(phaseRoot, 'control') };
  fs.mkdirSync(storage.controlPath, { recursive: true });
  ensureSchema(databasePath).close();
  const base = { operationId: 'phase-operation', targetWorkspace: { root: 'workspace-a' } };
  const prepared = await withRestorePhase(context, { ...base, phase: 'prepare' }, 'project', async () => undefined);
  assert.equal(prepared.status, 'prepared'); assert.ok(prepared.quiesceToken);
  await assert.rejects(withRestorePhase(context, { ...base, operationId: 'other-operation', phase: 'apply', quiesceToken: prepared.quiesceToken }, 'project', async () => undefined), error => error?.code === 'COMPONENT_RESTORE_HOLD_INVALID');
  assert.equal(await withRestorePhase(context, { ...base, phase: 'apply', quiesceToken: prepared.quiesceToken, targetStorage: storage }, 'project', async () => 'applied'), 'applied');
  await assert.rejects(withRestorePhase(context, { ...base, phase: 'apply', quiesceToken: prepared.quiesceToken, targetStorage: { ...storage, databasePath: path.join(phaseRoot, 'other.sqlite3') } }, 'project', async () => undefined), error => error?.code === 'COMPONENT_RESTORE_HOLD_INVALID');
  fs.rmSync(databasePath, { force: true }); fs.rmSync(`${databasePath}-wal`, { force: true }); fs.rmSync(`${databasePath}-shm`, { force: true });
  const rolledBackLegacy = new DatabaseSync(databasePath); rolledBackLegacy.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','1')"); rolledBackLegacy.close();
  assert.equal((await withRestorePhase(context, { ...base, phase: 'rollback', quiesceToken: prepared.quiesceToken }, 'project', async () => undefined)).status, 'rolled-back');
  const reopened = ensureSchema(databasePath);
  assert.equal(reopened.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '10', 'rollback invalidates the schema cache so restored old storage migrates on reopen'); reopened.close();
  assert.equal((await withRestorePhase(context, { ...base, phase: 'rollback', quiesceToken: prepared.quiesceToken }, 'project', async () => undefined)).idempotent, true);
  fs.rmSync(phaseRoot, { recursive: true, force: true });
  console.log('Team-retouch component-owned restore quiesce tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
