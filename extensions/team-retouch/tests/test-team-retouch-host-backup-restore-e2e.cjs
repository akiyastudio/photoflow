const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createBackupService, STORE_DIRECTORY } = require('../../../electron/services/backup-service.cjs');
const { createBackgroundTaskService } = require('../../../electron/services/background-task-service.cjs');
const { ComponentServiceManager } = require('../../../electron/services/component-service-manager.cjs');
const { createProcessSupervisor } = require('../../../electron/services/process-supervisor.cjs');
const { ensureSchema } = require('../service.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
const bundledPython = path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe');
const testPython = fs.existsSync(bundledPython) ? bundledPython : process.env.PYTHON || 'python';

const runWorkspaceDatabase = (action, root, database, payload = undefined) => {
  const args = [path.join(repositoryRoot, 'python', 'workspace_db.py'), action, '--root', root, '--database', database];
  if (payload !== undefined) args.push('--payload', JSON.stringify(payload));
  const child = spawnSync(testPython, args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(child.error, undefined, `workspace database fixture failed to start: ${child.error?.message || ''}`);
  assert.equal(child.status, 0, `workspace database fixture failed: ${child.stderr || child.stdout}`);
  assert.doesNotThrow(() => JSON.parse(child.stdout.trim()), 'workspace database initializer returns JSON');
};

const assertCoreDatabaseFixture = (database, expectedProjectId = undefined) => {
  assert.equal(fs.statSync(database).isFile(), true, 'core database fixture is a regular file');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok', 'core database fixture passes SQLite quick_check');
    assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value), 33, 'core database fixture uses the current workspace schema');
    if (expectedProjectId) assert.equal(db.prepare('SELECT id FROM projects WHERE id=?').get(expectedProjectId)?.id, expectedProjectId, 'source core fixture contains the restored project');
  } finally { db.close(); }
};

const seedCoreProjectFixture = (database, project) => {
  const db = new DatabaseSync(database);
  try {
    db.prepare('INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(project.id, project.name, project.status, project.relativePath, 1, 1);
  } finally { db.close(); }
};

const digest = filePath => {
  const hash = crypto.createHash('sha256'); const descriptor = fs.openSync(filePath, 'r'); const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { for (;;) { const count = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
};

const main = async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-restore-e2e-'));
  const target = path.join(sandbox, 'backup'); const workspace = path.join(sandbox, 'workspace'); const dataRoot = path.join(sandbox, 'data');
  const sourceRoot = path.join(sandbox, 'old-workspace'); const sourceDataRoot = path.join(sandbox, 'old-data');
  const sourceStage = path.join(sandbox, 'source'); const liveComponentRoot = path.join(dataRoot, 'components', 'team-retouch');
  fs.mkdirSync(sourceStage, { recursive: true }); fs.mkdirSync(liveComponentRoot, { recursive: true }); fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.photoflow-workspace-id'), 'target-workspace\n');
  fs.mkdirSync(path.join(sourceRoot, '待处理', 'A'), { recursive: true });
  const core = path.join(sourceStage, 'workspace.sqlite3');
  runWorkspaceDatabase('init', sourceRoot, core);
  seedCoreProjectFixture(core, { id: 'project-a', name: 'A', status: 'active', relativePath: '待处理/A' });
  runWorkspaceDatabase('init', workspace, path.join(dataRoot, 'workspace.sqlite3'));
  assertCoreDatabaseFixture(core, 'project-a');
  assertCoreDatabaseFixture(path.join(dataRoot, 'workspace.sqlite3'));
  const sourceDatabasePath = path.join(sourceStage, 'storage.sqlite3');
  const sourceDb = ensureSchema(sourceDatabasePath);
  sourceDb.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  sourceDb.prepare('INSERT INTO team_retouch_photos(project_id,photo_id,base_version_id,display_name,relative_path,relative_path_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('project-a', 'photo-a', 'version-a', 'A', '待处理/A/a.jpg', 'ready', 1, 1);
  sourceDb.prepare('INSERT INTO team_person_identities(project_id,id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('project-a', 'person-a', 'Person A', '#fff', 1, 1);
  sourceDb.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run('project-a', 7);
  const liveDatabasePath = path.join(liveComponentRoot, 'storage.sqlite3'); const liveDb = ensureSchema(liveDatabasePath);
  liveDb.prepare('INSERT INTO team_retouch_photos(project_id,photo_id,base_version_id,display_name,relative_path,relative_path_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('project-b', 'photo-b', 'version-b', 'B', '待处理/B/b.jpg', 'ready', 1, 1);
  liveDb.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run('project-b', 3); liveDb.close();
  fs.mkdirSync(path.join(liveComponentRoot, 'media', 'photo-b', 'version-b', 'analysis'), { recursive: true });
  const targetB = path.join(liveComponentRoot, 'media', 'photo-b', 'version-b', 'analysis', 'mask.bin'); fs.writeFileSync(targetB, 'target-b-unchanged');
  const privateA = path.join(sourceStage, 'a.bin'); const privateB = path.join(sourceStage, 'b.bin'); fs.writeFileSync(privateA, 'source-a'); fs.writeFileSync(privateB, 'source-b');
  const storeObject = filePath => {
    const hash = digest(filePath); const destination = path.join(target, STORE_DIRECTORY, 'objects', hash.slice(0, 2), hash.slice(2));
    fs.mkdirSync(path.dirname(destination), { recursive: true }); if (!fs.existsSync(destination)) fs.copyFileSync(filePath, destination);
    return { hash, size: fs.statSync(filePath).size, mtimeMs: fs.statSync(filePath).mtimeMs };
  };
  // Keep the source connection open so committed rows remain represented by
  // the paired WAL object rather than relying on an implicit checkpoint.
  const componentInputs = [
    ['team-retouch/storage.sqlite3', sourceDatabasePath],
    ...(fs.existsSync(`${sourceDatabasePath}-wal`) ? [['team-retouch/storage.sqlite3-wal', `${sourceDatabasePath}-wal`]] : []),
    ['team-retouch/media/photo-a/version-a/analysis/mask.bin', privateA],
    ['team-retouch/media/photo-b/version-b/analysis/mask.bin', privateB],
  ];
  assert(componentInputs.some(([entryPath]) => entryPath === 'team-retouch/storage.sqlite3-wal'), 'fixture keeps the committed project A row in a separate WAL object');
  const files = componentInputs.map(([entryPath, filePath]) => ({ scope: 'component-storage', path: entryPath, ...storeObject(filePath), projectIds: [] }));
  const database = storeObject(core); const snapshotId = 'component-e2e';
  const manifest = {
    formatVersion: 1, id: snapshotId, complete: true, createdAt: Date.now(), appVersion: 'test',
    workspace: { id: 'source-workspace', root: sourceRoot, dataRoot: sourceDataRoot }, database,
    projects: [{ id: 'project-a', name: 'A', status: 'active', relativePath: '待处理/A' }], files,
    componentBackups: [{ componentId: 'team-retouch', componentVersion: '1.0.0', sources: [{ scope: 'component-storage', path: 'team-retouch/storage.sqlite3', format: 'component-storage-v1' }] }],
  };
  const snapshotRoot = path.join(target, STORE_DIRECTORY, 'snapshots', snapshotId); fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.writeFileSync(path.join(snapshotRoot, 'manifest.json'), JSON.stringify(manifest));

  const descriptor = {
    componentId: 'team-retouch', componentVersion: '2.0.0',
    service: {
      protocolVersion: 1, runtime: 'node', entry: path.join(__dirname, '..', 'service.cjs'),
      rpcMethods: ['team.backup-restore.workspace.v1', 'team.backup-restore.project.v1'], capabilities: [], permissions: [], events: [],
      backupRestore: {
        transactionProtocolVersion: 1, sourceManifestProtocolVersion: 1, receiptProtocolVersion: 1,
        workspace: { method: 'team.backup-restore.workspace.v1' }, project: { method: 'team.backup-restore.project.v1' },
        sources: [{ scope: 'component-storage', path: 'team-retouch/storage.sqlite3', format: 'component-storage-v1' }],
      },
    },
  };
  const serviceLogs = [];
  const captureLog = (...values) => serviceLogs.push(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  const supervisor = createProcessSupervisor({ writeLog: captureLog });
  const manager = new ComponentServiceManager({
    registry: { resolve: id => id === 'team-retouch' ? descriptor : null, list: () => [descriptor] },
    processSupervisor: supervisor, capabilityBroker: { assertCapabilities: () => true, invoke: async () => { throw new Error('unexpected capability'); } },
    requestTimeoutMs: 15_000, longRequestTimeoutMs: 120_000, writeLog: captureLog,
  });
  const phases = []; const applyReceipts = []; let tamperReceipt = false;
  const originalLease = manager.withBackupRestoreLease.bind(manager);
  manager.withBackupRestoreLease = (componentIds, worker) => originalLease(componentIds, invoke => worker(async (componentId, mode, payload, context) => {
    phases.push(payload.phase);
    if (payload.phase === 'apply') {
      assert.equal(Object.prototype.propertyIsEnumerable.call(payload, 'sources'), false, 'large sources are not enumerable on the Host RPC payload');
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 64 * 1024, 'Host restore RPC payload remains bounded');
    }
    const result = await invoke(componentId, mode, payload, context);
    if (payload.phase === 'apply') {
      assert.equal(typeof result.receiptPath, 'string', 'the JSONL child returns a file receipt rather than inline dispositions');
      const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
      assert.equal(receipt.sourceManifestSha256, payload.sourceManifestSha256, 'receipt authenticates the exact Host source manifest');
      applyReceipts.push(receipt);
    }
    return tamperReceipt && payload.phase === 'apply' ? { ...result, receiptSha256: '0'.repeat(64) } : result;
  }));
  const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
  const config = { backup: { enabled: true, targetPath: target } };
  const service = createBackupService({
    app: { getVersion: () => 'test' }, backgroundTasks,
    configMutationService: { read: async () => config, mutate: async worker => worker(config) }, readSavedConfig: () => config,
    getConfigPath: () => path.join(sandbox, 'config.json'), getUserBirthdaysPath: () => path.join(sandbox, 'birthdays.json'),
    getManagedExternalLinkRegistryPath: () => path.join(sandbox, 'links.json'), getManagedExternalLinks: () => [],
    getWorkspaceDatabasePath: () => path.join(dataRoot, 'workspace.sqlite3'), getWorkspaceOperationsDatabasePath: () => path.join(dataRoot, 'operations.sqlite3'),
    getWorkspaceMediaDatabasePath: () => path.join(dataRoot, 'media.sqlite3'), getWorkspaceVersioningDatabasePath: () => path.join(dataRoot, 'versioning.sqlite3'),
    getWorkspaceDataRoot: () => dataRoot,
    workspaceSqliteCoordinator: { run: async (_options, worker) => worker() }, prepareDomainRecovery: async () => async () => undefined,
    credentialService: {}, runPythonJsonAction: async () => ({}), shell: {}, writeLog: captureLog, componentServiceManager: manager,
  });
  service.approveTarget(target);
  try {
    const withTimeout = promise => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`E2E timeout\n${serviceLogs.join('\n')}`)), 20_000);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    let restored;
    try { restored = await withTimeout(service.restoreProject(workspace, snapshotId, 'project-a')); }
    catch (error) { error.message += `\n${serviceLogs.join('\n')}`; throw error; }
    assert.equal(restored.task.state, 'completed'); assert(phases.includes('prepare') && phases.includes('apply') && phases.includes('finalize'), `observed phases: ${phases.join(',')}`);
    assert.ok(Buffer.byteLength(JSON.stringify(restored)) < 64 * 1024, 'persisted/background-task result remains bounded');
    assert.equal(JSON.stringify(restored).includes('dispositions'), false, 'full receipt dispositions are not copied into the task result');
    const successfulReceipt = applyReceipts.at(-1);
    const dispositionByKey = new Map(successfulReceipt.dispositions.map(item => [item.sourceKey, item]));
    assert.equal(dispositionByKey.get('component-storage\0team-retouch/media/photo-a/version-a/analysis/mask.bin')?.disposition, 'applied', 'project A private file is applied');
    assert.equal(dispositionByKey.get('component-storage\0team-retouch/media/photo-b/version-b/analysis/mask.bin')?.disposition, 'intentionally-skipped', 'project B private file is explicitly skipped');
    assert.equal(dispositionByKey.get('component-storage\0team-retouch/media/photo-b/version-b/analysis/mask.bin')?.reason, 'other-project');
    assert.equal(dispositionByKey.get('component-storage\0team-retouch/storage.sqlite3-wal')?.disposition, 'applied', 'the WAL sidecar has an explicit applied disposition');
    const restoredDb = new DatabaseSync(liveDatabasePath);
    assert.equal(restoredDb.prepare("SELECT name FROM team_person_identities WHERE project_id='project-a'").get().name, 'Person A');
    assert.equal(restoredDb.prepare("SELECT display_name FROM team_retouch_photos WHERE project_id='project-b'").get().display_name, 'B'); restoredDb.close();
    assert.equal(fs.readFileSync(path.join(liveComponentRoot, 'media', 'photo-a', 'version-a', 'analysis', 'mask.bin'), 'utf8'), 'source-a');
    assert.equal(fs.readFileSync(targetB, 'utf8'), 'target-b-unchanged');
    assert.equal(fs.readdirSync(path.join(target, STORE_DIRECTORY, 'temporary')).some(name => name.startsWith('component-restore-')), false, 'source/receipt stage is cleaned after finalize');

    const beforeFailure = fs.readFileSync(targetB);
    fs.writeFileSync(path.join(liveComponentRoot, 'media', 'photo-a', 'version-a', 'analysis', 'mask.bin'), 'target-a-before-failed-restore');
    const beforeFailedA = fs.readFileSync(path.join(liveComponentRoot, 'media', 'photo-a', 'version-a', 'analysis', 'mask.bin'));
    tamperReceipt = true; phases.length = 0;
    await assert.rejects(withTimeout(service.restoreProject(workspace, snapshotId, 'project-a')), /回执|哈希/);
    assert(phases.includes('apply') && phases.includes('rollback'), 'invalid real service receipt drives Host rollback phase');
    assert.deepEqual(fs.readFileSync(path.join(liveComponentRoot, 'media', 'photo-a', 'version-a', 'analysis', 'mask.bin')), beforeFailedA, 'Host rollback restores project A bytes changed by the rejected apply');
    assert.deepEqual(fs.readFileSync(targetB), beforeFailure, 'real service failure restores unrelated component bytes');
    assert.equal(fs.readdirSync(path.join(target, STORE_DIRECTORY, 'temporary')).some(name => name.startsWith('component-restore-')), false, 'source/receipt stage is cleaned after rollback');
  } finally {
    sourceDb.close(); await manager.destroy().catch(() => undefined); await supervisor.stopAll('test-complete').catch(() => undefined);
    await backgroundTasks.destroy?.(); fs.rmSync(sandbox, { recursive: true, force: true });
  }
  console.log('BackupService -> ComponentServiceManager -> Team Retouch file-protocol E2E passed');
};
main().catch(error => { console.error(error); process.exitCode = 1; });
