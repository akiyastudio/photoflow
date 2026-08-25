const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { WorkspaceSqliteCoordinator } = require('../electron/services/workspace-sqlite-coordinator.cjs');
const { PythonDatabaseClient } = require('../electron/repositories/database-client.cjs');
const { createWorkspaceRepository } = require('../electron/repositories/workspace-repository.cjs');
const { createMediaRepository } = require('../electron/repositories/media-repository.cjs');
const { createOperationsRepository } = require('../electron/repositories/operations-repository.cjs');
const { createBackupService, safeDestination, STORE_DIRECTORY } = require('../electron/services/backup-service.cjs');
const { createConfigMutationService } = require('../electron/services/config-mutation-service.cjs');
const { LEGACY_PYTHON_TOOL_ENTRIES } = require('../electron/compatibility/component-v1-metadata.cjs');
const VENV_PYTHON = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
const TEST_PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : process.env.PYTHON || 'python';

const waitForCoordinatorQueue = async (coordinator, minimum, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (coordinator.status().waiting < minimum) {
    if (Date.now() >= deadline) throw new Error(`coordinator queue did not reach ${minimum}`);
    await new Promise(resolve => setImmediate(resolve));
  }
};

const runPython = (script, args, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const executable = TEST_PYTHON;
  const baseName = path.basename(script, '.py');
  const developmentEntry = LEGACY_PYTHON_TOOL_ENTRIES[baseName];
  const scriptPath = developmentEntry ? path.join(__dirname, '..', 'python', ...developmentEntry) : path.join(__dirname, '..', 'python', script);
  const child = spawn(executable, [scriptPath, ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => {
    clearTimeout(timer);
    if (code !== 0) return reject(new Error(stderr || `Python exited with ${code}`));
    try { resolve(JSON.parse(stdout.trim())); }
    catch (error) { reject(new Error(`Invalid Python output: ${stdout}\n${error.message}`)); }
  });
});

const quickCheck = databasePath => new Promise((resolve, reject) => {
  const executable = TEST_PYTHON;
  const child = spawn(executable, ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("PRAGMA quick_check").fetchone()[0]); c.close()', databasePath], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 && stdout.trim() === 'ok' ? resolve('ok') : reject(new Error(stderr || `quick_check failed: ${stdout}`)));
});

const prepareWorkspace = async (temporaryRoot, name, id) => {
  const root = path.join(temporaryRoot, name);
  const project = path.join(root, '待处理', `${name}-项目`);
  const dataRoot = path.join(temporaryRoot, 'workspace-data', id);
  const database = path.join(temporaryRoot, 'workspace-data', `${id}.sqlite3`);
  const operationsDatabase = path.join(dataRoot, 'databases', 'operations.sqlite3');
  const sampleComponentDatabase = path.join(dataRoot, 'databases', 'sample-component.sqlite3');
  const mediaDatabase = path.join(dataRoot, 'databases', 'media.sqlite3');
  const versioningDatabase = path.join(dataRoot, 'databases', 'versioning.sqlite3');
  await fs.promises.mkdir(project, { recursive: true });
  await fs.promises.mkdir(dataRoot, { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, 'sample-component'), { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, 'components', 'sample-component', 'private'), { recursive: true });
  await fs.promises.writeFile(path.join(root, '.photoflow-workspace-id'), `${id}\n`, 'utf8');
  await fs.promises.writeFile(path.join(project, '原片.jpg'), `photo-${id}`, 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'sample-component', 'shared.json'), `internal-${id}`, 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'components', 'sample-component', 'storage.sqlite3'), `opaque-database-${id}`, 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'components', 'sample-component', 'private', 'state.json'), JSON.stringify({ id }), 'utf8');
  await runPython('workspace_db.py', ['catalog_sync', '--root', root, '--database', database, '--payload', '{}']);
  await runPython('workspace_db.py', ['component_patch_list', '--root', root, '--database', database, '--payload', JSON.stringify({ photoId: 'missing' })]);
  await runPython('operations_db.py', ['undo_record_add', '--database', operationsDatabase, '--payload', JSON.stringify({
    id: `${id}-undo`, kind: 'trash', payload: { items: [] }, legacyDatabase: database,
  })]);
  return { root, project, dataRoot, database, operationsDatabase, sampleComponentDatabase, mediaDatabase, versioningDatabase };
};

const main = async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-backup-service-'));
  try {
    assert.throws(() => safeDestination(path.join(temporaryRoot, 'component-restore'), '../escaped.bin'), /无效路径|越界/);
    assert.throws(() => safeDestination(path.join(temporaryRoot, 'component-restore'), 'sample/../../escaped.bin'), /无效路径|越界/);
    const target = path.join(temporaryRoot, 'backup-target');
    const configPath = path.join(temporaryRoot, 'photoflow_config.json');
    const birthdaysPath = path.join(temporaryRoot, 'birthdays.json');
    const externalLinksPath = path.join(temporaryRoot, 'managed-external-links.json');
    const backedTarget = path.join(temporaryRoot, 'original-media');
    const unrelatedTarget = path.join(temporaryRoot, 'unrelated-media');
    await fs.promises.mkdir(target);
    await fs.promises.writeFile(birthdaysPath, '[]', 'utf8');
    await fs.promises.writeFile(externalLinksPath, JSON.stringify({ version: 1, links: {
      'backed-link': { target: backedTarget, kind: 'folder', createdAt: 1 },
      'unrelated-link': { target: unrelatedTarget, kind: 'folder', createdAt: 1 },
    } }), 'utf8');
    const first = await prepareWorkspace(temporaryRoot, 'workspace-one', 'workspace-one-id');
    await fs.promises.writeFile(path.join(first.project, '原片外链.lnk'), JSON.stringify({
      target: backedTarget,
      description: 'PhotoFlow 外链文件夹：原片 | PhotoFlow-ID:backed-link',
    }), 'utf8');
    const second = await prepareWorkspace(temporaryRoot, 'workspace-two', 'workspace-two-id');
    let currentWorkspace = first;
    const config = {
      theme: 'light', defaultFolderSort: 'name', workspacePaths: [first.root], componentSettings: {}, componentSettingsRevisions: {},
      workspacePath: first.root,
      backup: { enabled: true, targetPath: target, mode: 'latest', automaticDaily: true, afterImport: true, retention: { daily: 7, weekly: 4, monthly: 12 } },
    };
    await fs.promises.writeFile(configPath, JSON.stringify(config), 'utf8');
    const readSavedConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const configMutationService = createConfigMutationService({ fs, crypto: require('crypto'), getConfigPath: () => configPath, readSavedConfig });
    await configMutationService.ready;
    const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const physicalCoordinator = new WorkspaceSqliteCoordinator();
    const recoveryLeases = [];
    const recoveryEvents = [];
    const recoveryActionOptions = [];
    const databaseLogs = [];
    let rejectRecoveryPause = false;
    let componentServicesActive = true;
    let componentQuiesceCount = 0;
    let componentResumeCount = 0;
    let nextRecoveryBarrier = null;
    const armRecoveryBarrier = () => {
      let admit;
      let release;
      const admitted = new Promise(resolve => { admit = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      nextRecoveryBarrier = { admit, released };
      return { admitted, release };
    };
    const service = createBackupService({
      app: { getVersion: () => 'test' },
      backgroundTasks,
      configMutationService,
      getConfigPath: () => configPath,
      getUserBirthdaysPath: () => birthdaysPath,
      getManagedExternalLinkRegistryPath: () => externalLinksPath,
      getManagedExternalLinks: () => currentWorkspace === first ? [{ linkId: 'backed-link' }] : [],
      getWorkspaceDatabasePath: () => currentWorkspace.database,
      getWorkspaceOperationsDatabasePath: () => currentWorkspace.operationsDatabase,
      getLegacyComponentDatabasePath: () => currentWorkspace.sampleComponentDatabase,
      getWorkspaceMediaDatabasePath: () => currentWorkspace.mediaDatabase,
      getWorkspaceVersioningDatabasePath: () => currentWorkspace.versioningDatabase,
      getWorkspaceDataRoot: () => currentWorkspace.dataRoot,
      workspaceSqliteCoordinator: {
        run: (options, worker) => {
          recoveryLeases.push(options);
          return physicalCoordinator.run(options, worker);
        },
      },
      prepareDomainRecovery: async () => {
        if (rejectRecoveryPause) throw new Error('simulated client shutdown failure');
        recoveryEvents.push('suspended');
        assert(physicalCoordinator.status().activeDatabases > 0, 'clients must be suspended after the physical lease is granted');
        const barrier = nextRecoveryBarrier;
        nextRecoveryBarrier = null;
        if (barrier) {
          barrier.admit();
          await barrier.released;
        }
        return async () => {
          assert(physicalCoordinator.status().activeDatabases > 0, 'clients must resume before the physical lease is released');
          recoveryEvents.push('resumed');
        };
      },
      readSavedConfig,
      runPythonJsonAction: (...args) => {
        if (args.length >= 6) recoveryActionOptions.push({ timeoutMs: args[2], signal: args[4], deadlineAt: args[5] });
        return runPython(...args);
      },
      shell: { readShortcutLink: shortcutPath => JSON.parse(fs.readFileSync(shortcutPath, 'utf8')) },
      componentServiceManager: {
        quiesceForStorageSnapshot: async () => {
          assert.equal(componentServicesActive, true);
          componentServicesActive = false;
          componentQuiesceCount += 1;
          return async () => { componentServicesActive = true; componentResumeCount += 1; };
        },
      },
      writeLog: (...args) => databaseLogs.push(args.map(String).join(' ')),
    });

    const createClient = (getDatabasePath, scriptName = 'workspace_db.py', id = scriptName) => new PythonDatabaseClient({
      coordinator: physicalCoordinator,
      getRunConfig: (requestedScript, args) => ({
        command: TEST_PYTHON,
        args: [path.join(__dirname, '..', 'python', requestedScript), ...args],
      }),
      getDatabasePath,
      writeLog: (...args) => databaseLogs.push(args.map(String).join(' ')),
      scriptName,
      processId: `backup-concurrency:${id}`,
      defaultTimeoutMs: 120000,
    });
    const maintenanceClient = createClient(() => first.database, 'workspace_db.py', 'maintenance');
    const writerClient = createClient(() => first.database, 'workspace_db.py', 'interactive');
    const domainWriterClient = createClient(() => first.database, 'workspace_db.py', 'domain-writer');
    const operationsClient = createClient(() => first.operationsDatabase, 'operations_db.py', 'operations-writer');
    const maintenanceRepository = createWorkspaceRepository(maintenanceClient);
    const writerRepository = createWorkspaceRepository(writerClient);
    const mediaRepository = createMediaRepository(domainWriterClient);
    const operationsRepository = createOperationsRepository(operationsClient, () => first.database);

    let releaseConfigMutation;
    const configGate = new Promise(resolve => { releaseConfigMutation = resolve; });
    const acceptedConfigMutation = configMutationService.mutate(async current => { await configGate; return { ...current, linearizedBackupMarker: 'committed-before-snapshot' }; });
    const firstRunPromise = service.runBackup(first.root, 'manual');
    await new Promise(resolve => setImmediate(resolve)); releaseConfigMutation();
    const [firstRun] = await Promise.all([firstRunPromise, acceptedConfigMutation.then(() => null)]);
    assert.strictEqual(firstRun.task.state, 'completed');
    assert.ok(firstRun.result.files.some(entry => entry.scope === 'domain-database' && entry.path === 'operations.sqlite3'), 'operations database must use a consistent online snapshot');
    assert.ok(firstRun.result.files.some(entry => entry.scope === 'domain-database' && entry.path === 'sample-component.sqlite3'), 'sample-component database must use a consistent online snapshot');
    const componentEntries = firstRun.result.files.filter(entry => entry.scope === 'component-storage');
    assert.deepStrictEqual(componentEntries.map(entry => entry.path).sort(), ['sample-component/private/state.json', 'sample-component/storage.sqlite3']);
    assert(componentEntries.every(entry => /^[a-f0-9]{64}$/.test(entry.hash)), 'component package entries must be content-addressed');
    assert.equal(componentServicesActive, true, 'component services must resume after the immutable package is staged');
    assert.ok(firstRun.result.files.some(entry => entry.scope === 'domain-database' && entry.path === 'media.sqlite3'), 'media database must use a consistent online snapshot');
    assert.ok(firstRun.result.files.some(entry => entry.scope === 'domain-database' && entry.path === 'versioning.sqlite3'), 'versioning database must use a consistent online snapshot');
    const backedConfigEntry = firstRun.result.files.find(entry => entry.scope === 'app-config' && entry.path === 'photoflow_config.json');
    const backedConfigObject = path.join(target, STORE_DIRECTORY, 'objects', backedConfigEntry.hash.slice(0, 2), backedConfigEntry.hash.slice(2));
    assert.equal(JSON.parse(await fs.promises.readFile(backedConfigObject, 'utf8')).linearizedBackupMarker, 'committed-before-snapshot', 'backup creation reads a linearized config snapshot after earlier mutations');
    assert.strictEqual((await service.status(first.root)).snapshotCount, 1);
    await service.verify(first.root, firstRun.result.id);

    currentWorkspace = second;
    config.workspacePath = second.root;
    const secondRun = await service.runBackup(second.root, 'manual');
    assert.strictEqual(secondRun.task.state, 'completed');

    currentWorkspace = first;
    config.workspacePath = first.root;
    await fs.promises.writeFile(path.join(first.project, '新增文件.txt'), 'incremental-content', 'utf8');
    const replacementRun = await service.runBackup(first.root, 'manual');
    assert.strictEqual(replacementRun.task.state, 'completed');
    assert.ok(replacementRun.result.incremental.reusedFiles > 0, 'unchanged files must reuse their existing backup objects');
    assert.ok(replacementRun.result.incremental.reusedBytes > 0, 'incremental backup must avoid retransferring unchanged bytes');
    assert.ok(replacementRun.result.incremental.transferredBytes < replacementRun.result.totals.bytes, 'incremental backup must transfer less than the full logical snapshot');
    assert.strictEqual((await service.status(first.root)).snapshotCount, 1, 'latest mode should retain one snapshot for the current workspace');
    await fs.promises.writeFile(externalLinksPath, JSON.stringify({ version: 1, links: { 'current-link': { target: 'E:/current-media', kind: 'folder', createdAt: 2 } } }), 'utf8');
    const backedProject = replacementRun.result.projects[0];
    assert.ok(backedProject, 'the backup manifest must include a project for project-level restore');
    const backedProjectRoot = path.resolve(first.root, backedProject.relativePath);
    await fs.promises.rm(backedProjectRoot, { recursive: true, force: true });
    assert.strictEqual(fs.existsSync(backedProjectRoot), false);
    const projectBarrier = armRecoveryBarrier();
    const restoredProjectPromise = service.restoreProject(first.root, replacementRun.result.id, backedProject.id);
    await projectBarrier.admitted;
    const queuedMaintenance = maintenanceRepository.runMaintenance(first.root);
    const queuedWriter = writerRepository.syncCatalog(first.root);
    await waitForCoordinatorQueue(physicalCoordinator, 2);
    assert.equal(maintenanceClient.process, null, 'maintenance must not enter its Python worker while restore owns exclusive');
    assert.equal(writerClient.process, null, 'interactive writer must not enter its Python worker while restore owns exclusive');
    assert(physicalCoordinator.status().waiting >= 2, 'maintenance and writer must both be queued behind restore');
    projectBarrier.release();
    const [restoredProject] = await Promise.all([restoredProjectPromise, queuedMaintenance, queuedWriter]);
    assert.strictEqual(restoredProject.task.state, 'completed');
    assert.equal(recoveryLeases.at(-1).databases.length, 4, 'project restore must lock core/media/versioning/sample-component only');
    assert(recoveryLeases.at(-1).databases.every(database => database.mode === 'exclusive'));
    assert(recoveryActionOptions.some(options => options.signal && Number.isFinite(options.deadlineAt) && options.timeoutMs <= options.deadlineAt - Date.now() + 1000), 'recovery tools must receive the active AbortSignal and remaining deadline');
    const mediaBarrier = armRecoveryBarrier();
    const mediaRestore = service.restoreDomain(first.root, replacementRun.result.id, 'media');
    await mediaBarrier.admitted;
    const mediaWrite = mediaRepository.prepareMediaSync(first.root, backedProject.name, []);
    await waitForCoordinatorQueue(physicalCoordinator, 1);
    assert.equal(domainWriterClient.process, null, 'media writer must remain queued behind media restore');
    mediaBarrier.release();
    await Promise.all([mediaRestore, mediaWrite]);
    assert.deepStrictEqual(recoveryLeases.at(-1).databases, [{ path: path.resolve(first.mediaDatabase), mode: 'exclusive' }], 'domain restore must lock only its target database');

    const versioningBarrier = armRecoveryBarrier();
    const versioningRestore = service.restoreDomain(first.root, replacementRun.result.id, 'versioning');
    await versioningBarrier.admitted;
    const versioningWrite = domainWriterClient.call(first.root, 'progress_snapshot', { projectName: backedProject.name, includeMissing: true });
    await waitForCoordinatorQueue(physicalCoordinator, 1);
    versioningBarrier.release();
    await Promise.all([versioningRestore, versioningWrite]);

    const componentBarrier = armRecoveryBarrier();
    const componentRestore = service.restoreDomain(first.root, replacementRun.result.id, 'sample-component');
    await componentBarrier.admitted;
    const componentWrite = physicalCoordinator.run({ databases: [{ path: first.sampleComponentDatabase, mode: 'write' }] }, async () => true);
    await waitForCoordinatorQueue(physicalCoordinator, 1);
    componentBarrier.release();
    await Promise.all([componentRestore, componentWrite]);

    const operationsBarrier = armRecoveryBarrier();
    const operationsReset = service.resetDomain(first.root, 'operations');
    await operationsBarrier.admitted;
    const operationsWrite = operationsRepository.addUndoRecord(first.root, { id: 'queued-after-reset', kind: 'trash', payload: { items: [] } });
    await waitForCoordinatorQueue(physicalCoordinator, 1);
    assert.equal(operationsClient.process, null, 'operations writer must remain queued behind operations reset');
    operationsBarrier.release();
    await Promise.all([operationsReset, operationsWrite]);
    assert.deepStrictEqual(recoveryLeases.at(-1).databases, [{ path: path.resolve(first.operationsDatabase), mode: 'exclusive' }], 'domain reset must lock only its target database');
    assert.equal(databaseLogs.some(line => /SQLITE_BUSY|database is locked/i.test(line)), false, 'recovery concurrency logs must not contain SQLite lock failures');
    assert.deepStrictEqual(await Promise.all([
      first.database, first.mediaDatabase, first.versioningDatabase, first.sampleComponentDatabase, first.operationsDatabase,
    ].map(quickCheck)), ['ok', 'ok', 'ok', 'ok', 'ok']);
    rejectRecoveryPause = true;
    let recoveryWorkerCalled = false;
    await assert.rejects(
      service.withWorkspaceRecoveryLease({ workspaceRoot: first.root, domains: ['media'] }, async () => { recoveryWorkerCalled = true; }),
      /simulated client shutdown failure/,
    );
    rejectRecoveryPause = false;
    assert.strictEqual(recoveryWorkerCalled, false, 'restore worker must not run when a client cannot be stopped');
    assert.strictEqual(physicalCoordinator.status().activeDatabases, 0, 'failed client suspension must release the physical lease');
    assert.strictEqual(await fs.promises.readFile(path.join(first.project, '新增文件.txt'), 'utf8'), 'incremental-content');
    const restoredExternalLinks = JSON.parse(await fs.promises.readFile(externalLinksPath, 'utf8'));
    assert.ok(restoredExternalLinks.links['backed-link'], 'project restore must restore external-link authorization identities from the snapshot');
    assert.ok(restoredExternalLinks.links['current-link'], 'project restore must preserve newer external-link authorization identities');
    assert.strictEqual(restoredExternalLinks.links['unrelated-link'], undefined, 'project restore must not restore unrelated global external-link identities');
    const spaceBeforeCleanup = await service.spaceStatus(first.root);
    assert.ok(spaceBeforeCleanup.actualBytes > 0 && spaceBeforeCleanup.logicalBytes >= spaceBeforeCleanup.referencedBytes);
    assert.ok(spaceBeforeCleanup.deduplicatedBytes > 0, 'repeated content across workspace snapshots should be reported as deduplicated');
    const orphanHash = require('crypto').createHash('sha256').update('orphan-object').digest('hex');
    const orphanPath = path.join(target, STORE_DIRECTORY, 'objects', orphanHash.slice(0, 2), orphanHash.slice(2));
    await fs.promises.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.promises.writeFile(orphanPath, 'orphan-object', 'utf8');
    const currentSnapshotPath = path.join(target, STORE_DIRECTORY, 'snapshots', replacementRun.result.id);
    const expiredSnapshotPath = path.join(target, STORE_DIRECTORY, 'snapshots', 'expired-preview-test');
    await fs.promises.cp(currentSnapshotPath, expiredSnapshotPath, { recursive: true });
    const expiredManifestPath = path.join(expiredSnapshotPath, 'manifest.json');
    const expiredManifest = JSON.parse(await fs.promises.readFile(expiredManifestPath, 'utf8'));
    expiredManifest.id = 'expired-preview-test';
    expiredManifest.createdAt = 1;
    await fs.promises.writeFile(expiredManifestPath, JSON.stringify(expiredManifest, null, 2), 'utf8');
    const cleanupPreview = await service.spaceStatus(first.root);
    assert.strictEqual(cleanupPreview.expiredSnapshotCount, 1, 'cleanup preview must count snapshots outside the retention policy');
    assert.ok(cleanupPreview.reclaimableBytes > 0);
    assert.ok(cleanupPreview.estimatedReclaimableBytes >= cleanupPreview.reclaimableBytes, 'cleanup preview must include existing orphaned objects');
    const cleaned = await service.cleanup(first.root);
    assert.strictEqual(cleaned.task.state, 'completed');
    assert.strictEqual(fs.existsSync(orphanPath), false, 'cleanup must remove only unreferenced objects');
    assert.strictEqual(fs.existsSync(expiredSnapshotPath), false, 'cleanup must remove snapshots shown in the preview');

    currentWorkspace = second;
    config.workspacePath = second.root;
    assert.strictEqual((await service.status(second.root)).snapshotCount, 1, 'cleanup must preserve snapshots that belong to another workspace');

    currentWorkspace = first;
    config.workspacePath = first.root;
    const restoreRoot = path.join(temporaryRoot, 'restored');
    await fs.promises.mkdir(restoreRoot);
    const restoredDataRoot = path.join(temporaryRoot, 'workspace-data', 'restored-id');
    const restoredDatabase = path.join(temporaryRoot, 'workspace-data', 'restored-id.sqlite3');
    const restoredOperationsDatabase = path.join(restoredDataRoot, 'databases', 'operations.sqlite3');
    const restoredSampleComponentDatabase = path.join(restoredDataRoot, 'databases', 'sample-component.sqlite3');
    const originalDataRoot = currentWorkspace.dataRoot;
    const originalDatabase = currentWorkspace.database;
    currentWorkspace = { ...first, dataRoot: restoredDataRoot, database: restoredDatabase, operationsDatabase: restoredOperationsDatabase, sampleComponentDatabase: restoredSampleComponentDatabase };
    await fs.promises.writeFile(externalLinksPath, JSON.stringify({ version: 1, links: { 'current-link': { target: 'E:/current-media', kind: 'folder', createdAt: 2 } } }), 'utf8');
    await configMutationService.mutate(current => ({ ...current, theme: 'dark', defaultFolderSort: 'size', componentSettings: { ...(current.componentSettings || {}), 'concurrent-fixture': { enabled: true } }, componentSettingsRevisions: { ...(current.componentSettingsRevisions || {}), 'concurrent-fixture': 10 } }));
    const restored = await service.restoreWorkspace(first.root, replacementRun.result.id, restoreRoot);
    assert.strictEqual(restored.task.state, 'completed');
    assert.equal(restored.result.savedConfig.theme, 'light'); assert.equal(restored.result.savedConfig.defaultFolderSort, 'name', 'workspace restore returns the canonical ordinary settings from the snapshot');
    assert.equal(restored.result.savedConfig.workspacePath, path.resolve(restoreRoot));
    assert.deepEqual(readSavedConfig().theme, 'light'); assert.equal(readSavedConfig().defaultFolderSort, 'name', 'restored ordinary settings remain on disk instead of being overwritten by the pre-restore draft');
    assert.deepEqual(restored.result.savedConfig.backup, config.backup, 'the current backup connection policy remains preserved');
    assert.equal(recoveryLeases.at(-1).databases.length, 5, 'workspace restore must also lock operations');
    assert(recoveryEvents.every((event, index) => event === (index % 2 === 0 ? 'suspended' : 'resumed')), 'every recovery lease must suspend and then resume all clients');
    assert.strictEqual(await fs.promises.readFile(path.join(restoreRoot, '待处理', 'workspace-one-项目', '新增文件.txt'), 'utf8'), 'incremental-content');
    assert.ok(await fs.promises.readFile(path.join(restoreRoot, '.photoflow-workspace-id'), 'utf8'));
    assert.ok((await fs.promises.stat(restoredDatabase)).isFile());
    const restoredUndo = await runPython('operations_db.py', ['undo_record_latest', '--database', restoredOperationsDatabase, '--payload', '{}']);
    assert.strictEqual(restoredUndo.record.id, 'workspace-one-id-undo', 'workspace restore must restore the operations journal');
    assert.ok((await fs.promises.stat(restoredSampleComponentDatabase)).isFile(), 'workspace restore must restore the sample-component store');
    assert.equal(await fs.promises.readFile(path.join(restoredDataRoot, 'components', 'sample-component', 'storage.sqlite3'), 'utf8'), 'opaque-database-workspace-one-id');
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(restoredDataRoot, 'components', 'sample-component', 'private', 'state.json'), 'utf8')).id, 'workspace-one-id');
    const workspaceRestoredExternalLinks = JSON.parse(await fs.promises.readFile(externalLinksPath, 'utf8'));
    assert.ok(workspaceRestoredExternalLinks.links['backed-link'], 'workspace restore must restore identities referenced by restored shortcuts');
    assert.ok(workspaceRestoredExternalLinks.links['current-link'], 'workspace restore must preserve current identities');
    assert.strictEqual(workspaceRestoredExternalLinks.links['unrelated-link'], undefined, 'workspace restore must not restore unrelated global identities');
    const canonicalRestoredConfig = readSavedConfig();
    assert.deepEqual(canonicalRestoredConfig.componentSettings['concurrent-fixture'], { enabled: true });
    assert.equal(canonicalRestoredConfig.componentSettingsRevisions['concurrent-fixture'], 10, 'workspace restore preserves newer opaque component settings through the shared mutation queue');
    assert.ok((await fs.promises.readdir(path.join(target, STORE_DIRECTORY, 'objects'))).length > 0);
    assert.equal(componentQuiesceCount, componentResumeCount, 'every component storage quiesce must resume even across the complete backup suite');
    currentWorkspace = { ...first, dataRoot: originalDataRoot, database: originalDatabase };

    await Promise.all([maintenanceClient.stop(), writerClient.stop(), domainWriterClient.stop(), operationsClient.stop()]);

    console.log('Backup service integration tests passed.');
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
