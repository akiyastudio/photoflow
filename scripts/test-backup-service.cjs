const assert = require('assert');
const crypto = require('crypto');
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
const { defaultComponentDataAdoptionPolicy } = require('../electron/compatibility/component-data-adoption-policy.cjs');
const { cleanupRetiredCaptureTimeCache } = require('../electron/services/retired-cache-service.cjs');
const VENV_PYTHON = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
const TEST_PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : process.env.PYTHON || 'python';
const sha256FileForTest = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const waitForCoordinatorQueue = async (coordinator, minimum, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (coordinator.status().waiting < minimum) {
    if (Date.now() >= deadline) throw new Error(`coordinator queue did not reach ${minimum}`);
    await new Promise(resolve => setImmediate(resolve));
  }
};

const runPython = (script, args, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const executable = TEST_PYTHON;
  const commandArgs = script === '-c'
    ? ['-c', ...args]
    : [path.join(__dirname, '..', 'python', script), ...args];
  const child = spawn(executable, commandArgs, {
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
  const mediaDatabase = path.join(dataRoot, 'databases', 'media.sqlite3');
  const versioningDatabase = path.join(dataRoot, 'databases', 'versioning.sqlite3');
  await fs.promises.mkdir(project, { recursive: true });
  await fs.promises.mkdir(dataRoot, { recursive: true });
  await fs.promises.mkdir(path.dirname(mediaDatabase), { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, 'sample-component'), { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, 'components', 'sample-component', 'private'), { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, 'components', 'second-component'), { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, 'components', 'sample-component', '.restore-staging-crashed'), { recursive: true });
  await fs.promises.writeFile(path.join(root, '.photoflow-workspace-id'), `${id}\n`, 'utf8');
  await fs.promises.writeFile(path.join(project, '原片.jpg'), `photo-${id}`, 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'sample-component', 'shared.json'), `internal-${id}`, 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'components', 'sample-component', 'storage.sqlite3'), `opaque-database-${id}`, 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'components', 'sample-component', 'storage.sqlite3-wal'), `opaque-wal-${id}`, 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'components', 'sample-component', 'private', 'state.json'), JSON.stringify({ id }), 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'components', 'sample-component', '.restore-staging-crashed', 'control.json'), 'must-not-back-up', 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'components', 'second-component', 'storage.sqlite3'), `second-opaque-${id}`, 'utf8');
  await runPython('workspace_db.py', ['catalog_sync', '--root', root, '--database', database, '--payload', '{}']);
  await runPython('workspace_db.py', ['init', '--root', root, '--database', database]);
  await runPython('-c', [
    "import sys; sys.path.insert(0, 'python'); from workspace_db import connect; connect(sys.argv[1], sys.argv[2], include_domains=True).close(); print('{}')",
    root, database,
  ]);
  await runPython('operations_db.py', ['undo_record_add', '--database', operationsDatabase, '--payload', JSON.stringify({
    id: `${id}-undo`, kind: 'trash', payload: { items: [] }, legacyDatabase: database,
  })]);
  return { root, project, dataRoot, database, operationsDatabase, mediaDatabase, versioningDatabase };
};

const main = async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-backup-service-'));
  try {
    const retiredCacheRoot = path.join(temporaryRoot, 'retired-cache');
    await fs.promises.mkdir(retiredCacheRoot, { recursive: true });
    const retiredCachePath = path.join(retiredCacheRoot, 'capture-time-cache.sqlite3');
    await Promise.all([retiredCachePath, `${retiredCachePath}-wal`, `${retiredCachePath}-journal`].map(filePath => fs.promises.writeFile(filePath, 'retired')));
    await fs.promises.mkdir(`${retiredCachePath}-shm`);
    const retiredCount = await cleanupRetiredCaptureTimeCache({ app: { getPath: () => retiredCacheRoot }, fs, path, onError: () => { throw new Error('logger failure'); } });
    assert.equal(retiredCount, 3, 'retired cache cleanup includes the SQLite rollback journal and isolates onError failures');
    assert.equal(fs.existsSync(`${retiredCachePath}-journal`), false);
    await fs.promises.rm(`${retiredCachePath}-shm`, { recursive: true, force: true });
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
    const recoveryPythonSources = [];
    const databaseLogs = [];
    let rejectRecoveryPause = false;
    let componentServicesActive = true;
    let componentQuiesceCount = 0;
    let componentResumeCount = 0;
    const componentRestoreCalls = [];
    const componentRestorePhaseCalls = [];
    let componentRestoreFailure = null;
    let componentRollbackTamper = false;
    let componentContinuationFailure = false;
    const componentPhaseFailures = new Map();
    let secondProjectRestoreSupported = true;
    let secondCurrentSourceMatches = true;
    let lateComponentInstalled = false;
    let fileReceiptWorkspaceComponent = '';
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
        if (Array.isArray(args[1])) for (let index = 0; index < args[1].length - 1; index += 1) if (['--source', '--peer-source'].includes(args[1][index])) recoveryPythonSources.push(args[1][index + 1]);
        if (componentContinuationFailure && args[0] === 'backup_db.py' && args[1]?.includes('restore-project')) throw new Error('simulated core continuation failure');
        return runPython(...args);
      },
      shell: { readShortcutLink: shortcutPath => JSON.parse(fs.readFileSync(shortcutPath, 'utf8')) },
      componentServiceManager: {
        backupRestoreDescriptors: () => [...[{ componentId: 'sample-component', componentVersion: '1.2.3', service: { backupRestore: {
          transactionProtocolVersion: 1, sourceManifestProtocolVersion: 1, receiptProtocolVersion: 1,
          workspace: { method: 'sample.backup.workspace.v1' }, project: { method: 'sample.backup.project.v1' },
          sources: [{ scope: 'component-storage', path: 'sample-component/storage.sqlite3', format: 'component-storage-v1' }],
        } } }, { componentId: 'second-component', componentVersion: '4.5.6', service: { backupRestore: {
          transactionProtocolVersion: 1, sourceManifestProtocolVersion: 1, receiptProtocolVersion: 1,
          workspace: { method: 'second.backup.workspace.v1' }, project: secondProjectRestoreSupported ? { method: 'second.backup.project.v1' } : null,
          sources: [{ scope: 'component-storage', path: secondCurrentSourceMatches ? 'second-component/storage.sqlite3' : 'second-component/missing.sqlite3', format: 'component-storage-v1' }],
        } } }], ...(lateComponentInstalled ? [{ componentId: 'late-component', componentVersion: '2.0.0', service: { backupRestore: {
          transactionProtocolVersion: 1, sourceManifestProtocolVersion: 1, receiptProtocolVersion: 1,
          workspace: { method: 'late.backup.workspace.v1' }, project: { method: 'late.backup.project.v1' },
          sources: [{ scope: 'component-storage', path: 'late-component/storage.sqlite3', format: 'late-storage-v2' }],
        } } }] : [])],
        invokeBackupRestore: async (componentId, mode, payload) => {
          componentRestorePhaseCalls.push({ componentId, mode, payload });
          if (payload.phase === 'prepare') return { schemaVersion: 1, operationId: payload.operationId, status: 'prepared', quiesceToken: `token:${componentId}:${payload.operationId}` };
          if (payload.phase === 'finalize' || payload.phase === 'rollback') {
            const failureKey = `${componentId}:${payload.phase}`; const remaining = componentPhaseFailures.get(failureKey) || 0;
            if (remaining > 0) { componentPhaseFailures.set(failureKey, remaining - 1); throw new Error(`simulated ${payload.phase} release failure`); }
            return { schemaVersion: 1, operationId: payload.operationId, status: payload.phase === 'finalize' ? 'finalized' : 'rolled-back' };
          }
          componentRestoreCalls.push({ componentId, mode, payload });
          if (mode === 'project') { await fs.promises.mkdir(payload.targetStorage.dataPath, { recursive: true }); await fs.promises.writeFile(path.join(payload.targetStorage.dataPath, 'restore-hook-marker.txt'), componentId, 'utf8'); }
          if (componentRestoreFailure === `${componentId}:${mode}`) {
            if (componentRollbackTamper) {
              const transactionRoot = path.resolve(payload.targetStorage.controlPath, '..', '..');
              await fs.promises.rm(path.join(transactionRoot, 'backups', 'sample-component', 'storage.sqlite3'), { force: true });
            }
            throw new Error('simulated component restore failure');
          }
          if (mode === 'workspace' && fileReceiptWorkspaceComponent === componentId) {
            const sourceManifest = JSON.parse(await fs.promises.readFile(payload.sourceManifestPath, 'utf8'));
            const dispositions = [];
            for (const source of payload.sources) {
              const hostPreserved = source.relativePath.endsWith('/private/state.json');
              if (!hostPreserved && source.relativePath.startsWith(`${componentId}/`)) {
                const destination = path.join(payload.targetStorage.dataPath, source.relativePath.slice(componentId.length + 1));
                await fs.promises.mkdir(path.dirname(destination), { recursive: true });
                await fs.promises.copyFile(source.path, destination);
              }
              dispositions.push({
                sourceKey: source.sourceKey,
                disposition: hostPreserved ? 'host-preserved' : 'applied',
                destinationRelativePath: hostPreserved ? '' : source.relativePath,
                reason: hostPreserved ? 'host-control' : '',
                message: hostPreserved ? 'Host performs the opaque workspace copy' : '',
              });
            }
            const receipt = {
              schema: sourceManifest.receiptContract.schema,
              schemaVersion: 1,
              operationId: payload.operationId,
              status: 'committed',
              sourceManifestSha256: payload.sourceManifestSha256,
              dispositions,
              warnings: [],
            };
            const receiptBody = `${JSON.stringify(receipt)}\n`;
            const receiptPath = path.join(path.dirname(payload.sourceManifestPath), 'restore-receipt.json');
            await fs.promises.writeFile(receiptPath, receiptBody, 'utf8');
            return {
              schemaVersion: 1,
              operationId: payload.operationId,
              status: 'committed',
              receiptPath,
              receiptSha256: crypto.createHash('sha256').update(receiptBody).digest('hex'),
              dispositionCount: dispositions.length,
            };
          }
          const consumedPaths = payload.sources.filter(source => mode === 'project' || !source.relativePath.endsWith('/private/state.json')).map(source => source.relativePath);
          if (mode === 'workspace') for (const source of payload.sources.filter(item => consumedPaths.includes(item.relativePath) && item.relativePath.startsWith(`${componentId}/`))) {
            const destination = path.join(payload.targetStorage.dataPath, source.relativePath.slice(componentId.length + 1));
            await fs.promises.mkdir(path.dirname(destination), { recursive: true }); await fs.promises.copyFile(source.path, destination);
          }
          return { schemaVersion: 1, operationId: payload.operationId, status: 'committed', consumedPaths, imported: {} };
        },
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
    const componentEntries = firstRun.result.files.filter(entry => entry.scope === 'component-storage');
    assert.deepStrictEqual(componentEntries.map(entry => entry.path).sort(), ['sample-component/private/state.json', 'sample-component/storage.sqlite3', 'sample-component/storage.sqlite3-wal', 'second-component/storage.sqlite3']);
    assert.deepEqual(firstRun.result.componentBackups, [
      { componentId: 'sample-component', componentVersion: '1.2.3', sources: [{ scope: 'component-storage', path: 'sample-component/storage.sqlite3', format: 'component-storage-v1' }] },
      { componentId: 'second-component', componentVersion: '4.5.6', sources: [{ scope: 'component-storage', path: 'second-component/storage.sqlite3', format: 'component-storage-v1' }] },
    ], 'component source format and installed version are frozen into the same quiesced snapshot as its files');
    assert.equal(componentEntries.some(entry => entry.path.includes('.restore-staging-')), false, 'Host/component restore control residue is never snapshotted');
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
    const replacementManifestPath = path.join(target, STORE_DIRECTORY, 'snapshots', replacementRun.result.id, 'manifest.json');
    const replacementManifest = JSON.parse(await fs.promises.readFile(replacementManifestPath, 'utf8'));
    const mediaEntryIndex = replacementManifest.files.findIndex(entry => entry.scope === 'domain-database' && entry.path === 'media.sqlite3');
    const mediaEntryForVersioningPreflight = replacementManifest.files.splice(mediaEntryIndex, 1)[0];
    replacementManifest.totals.files -= 1; replacementManifest.totals.bytes -= mediaEntryForVersioningPreflight.size;
    await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    await assert.rejects(service.restoreProject(first.root, replacementRun.result.id, backedProject.id), error => error?.code === 'PROJECT_RESTORE_VERSIONING_REQUIRES_MEDIA', 'versioning-only v1 project restore must fail during preflight');
    replacementManifest.files.splice(mediaEntryIndex, 0, mediaEntryForVersioningPreflight);
    replacementManifest.totals.files += 1; replacementManifest.totals.bytes += mediaEntryForVersioningPreflight.size;
    await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    const orphanFixture = { ...replacementManifest.files.find(entry => entry.scope === 'domain-database'), path: 'uninstalled-private.sqlite3' };
    replacementManifest.files.push(orphanFixture); await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    const rejectedWorkspaceRoot = path.join(temporaryRoot, 'rejected-uninstalled-workspace');
    await assert.rejects(service.restoreWorkspace(first.root, replacementRun.result.id, rejectedWorkspaceRoot), error => error?.code === 'COMPONENT_LEGACY_RESTORE_OWNER_MISSING');
    assert.equal(fs.existsSync(rejectedWorkspaceRoot), false, 'component ownership preflight must run before creating the workspace target');
    await assert.rejects(service.restoreProject(first.root, replacementRun.result.id, backedProject.id), error => error?.code === 'COMPONENT_LEGACY_RESTORE_OWNER_MISSING');
    assert.equal(fs.existsSync(path.join(first.root, `.photoflow-project-restore-${backedProject.id}.incomplete`)), false, 'component ownership preflight must run before creating a project marker');
    replacementManifest.files.pop(); await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    replacementManifest.componentBackups.push({ componentId: 'evil-component', componentVersion: '1', sources: [{ scope: 'domain-database', path: 'media.sqlite3', format: 'stolen-media-v1' }] });
    const rejectedMetadataRoot = path.join(temporaryRoot, 'rejected-malicious-component-metadata');
    await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    await assert.rejects(service.restoreWorkspace(first.root, replacementRun.result.id, rejectedMetadataRoot), error => error?.code === 'COMPONENT_RESTORE_SOURCE_UNAUTHORIZED');
    await assert.rejects(service.verify(first.root, replacementRun.result.id), error => error?.code === 'COMPONENT_RESTORE_SOURCE_UNAUTHORIZED', 'backup verify rejects forged component ownership metadata too');
    assert.equal(fs.existsSync(rejectedMetadataRoot), false, 'malicious component metadata is rejected before any restore target write');
    replacementManifest.componentBackups.pop(); await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    replacementManifest.componentBackups.push(structuredClone(replacementManifest.componentBackups[0])); await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    await assert.rejects(service.verify(first.root, replacementRun.result.id), error => error?.code === 'COMPONENT_BACKUP_METADATA_INVALID');
    replacementManifest.componentBackups.pop();
    const removedMetadataEntry = replacementManifest.files.splice(replacementManifest.files.findIndex(entry => entry.scope === 'component-storage' && entry.path === replacementManifest.componentBackups[0].sources[0].path), 1)[0];
    await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    await assert.rejects(service.verify(first.root, replacementRun.result.id), error => error?.code === 'COMPONENT_RESTORE_SOURCE_MISSING');
    replacementManifest.files.push(removedMetadataEntry); await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    const savedComponentMetadata = replacementManifest.componentBackups; delete replacementManifest.componentBackups;
    const legacyDomainFixture = { ...replacementManifest.files.find(entry => entry.scope === 'domain-database'), path: 'evil-unowned.sqlite3' };
    replacementManifest.files.push(legacyDomainFixture); await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    await assert.rejects(service.verify(first.root, replacementRun.result.id), /未授权的历史域数据库/, 'old manifests cannot smuggle an unowned domain database through snapshot-only verification');
    legacyDomainFixture.path = defaultComponentDataAdoptionPolicy.legacyDomainDatabaseOwners[0].paths[0]; await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    assert.equal((await service.verify(first.root, replacementRun.result.id)).task.state, 'completed', 'old manifests retain statically Host-owned legacy database verification');
    replacementManifest.files.pop(); replacementManifest.componentBackups = savedComponentMetadata; await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    const checkpointSessionId = 'checkpoint-content-validation';
    const checkpointMarkerKey = crypto.createHash('sha256').update([replacementRun.result.id, backedProject.id, checkpointSessionId].join('\0')).digest('hex').slice(0, 32);
    const checkpointMarker = path.join(first.root, `.photoflow-project-restore-${checkpointMarkerKey}.incomplete`);
    await fs.promises.writeFile(checkpointMarker, JSON.stringify({ schemaVersion: 1, snapshotId: replacementRun.result.id, projectId: backedProject.id, restoreSessionId: checkpointSessionId, taskId: 'checkpoint-content-validation-task' }), 'utf8');
    const checkpointProjectEntries = replacementManifest.files.filter(entry => entry.scope === 'workspace' && entry.projectIds?.includes(backedProject.id)).slice(0, 2);
    const checkpointDataEntry = replacementManifest.files.find(entry => entry.scope === 'workspace-data' && entry.projectIds?.includes(backedProject.id));
    const corruptCheckpointEntry = checkpointProjectEntries[0];
    const corruptCheckpointPath = path.join(first.root, corruptCheckpointEntry.path);
    await fs.promises.mkdir(path.dirname(corruptCheckpointPath), { recursive: true });
    await fs.promises.writeFile(corruptCheckpointPath, Buffer.alloc(Number(corruptCheckpointEntry.size), 0x7f));
    if (checkpointDataEntry) {
      const corruptDataPath = path.join(first.dataRoot, checkpointDataEntry.path);
      await fs.promises.mkdir(path.dirname(corruptDataPath), { recursive: true });
      await fs.promises.writeFile(corruptDataPath, Buffer.alloc(Number(checkpointDataEntry.size), 0x6e));
    }
    const projectBarrier = armRecoveryBarrier();
    const restoredProjectPromise = service.restoreProject(first.root, replacementRun.result.id, backedProject.id, {
      id: 'checkpoint-content-validation-task', metadata: { restoreSessionId: checkpointSessionId },
      checkpoint: { version: 1, restoreSessionId: checkpointSessionId, completedProject: checkpointProjectEntries.map(entry => entry.path), completedData: checkpointDataEntry ? [checkpointDataEntry.path] : [] }, progress: 20,
    });
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
    for (const entry of checkpointProjectEntries) assert.equal(sha256FileForTest(path.join(first.root, entry.path)), entry.hash, 'missing/corrupt completedProject checkpoint entries are rematerialized');
    if (checkpointDataEntry) assert.equal(sha256FileForTest(path.join(first.dataRoot, checkpointDataEntry.path)), checkpointDataEntry.hash, 'corrupt completedData checkpoint entry is rematerialized');
    assert.equal(componentRestoreCalls.length, 2, 'project restore must invoke every component-owned import hook');
    const sampleRestore = componentRestoreCalls.find(call => call.componentId === 'sample-component');
    assert.equal(sampleRestore.mode, 'project');
    assert.deepEqual(sampleRestore.payload.sources.map(source => source.relativePath).sort(), ['sample-component/private/state.json', 'sample-component/storage.sqlite3', 'sample-component/storage.sqlite3-wal']);
    const stagedMain = sampleRestore.payload.sources.find(source => source.relativePath.endsWith('/storage.sqlite3'));
    const stagedWal = sampleRestore.payload.sources.find(source => source.relativePath.endsWith('/storage.sqlite3-wal'));
    assert.equal(path.dirname(stagedMain.path), path.dirname(stagedWal.path), 'SQLite main database and sidecars must remain adjacent in staging');
    assert(componentRestoreCalls.every(call => call.payload.sources.every(source => !fs.existsSync(source.path))), 'component restore staging must be removed after hooks settle');
    const opaqueFixture = { ...replacementManifest.files.find(entry => entry.scope === 'component-storage' && entry.path === 'sample-component/storage.sqlite3'), path: 'late-component/storage.sqlite3' };
    replacementManifest.files.push(opaqueFixture);
    replacementManifest.componentBackups.push({ componentId: 'late-component', componentVersion: 'unversioned', sources: [] });
    await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    lateComponentInstalled = true;
    const lateRestoreStart = componentRestoreCalls.length;
    await fs.promises.rm(backedProjectRoot, { recursive: true, force: true });
    const lateRestoreResult = await service.restoreProject(first.root, replacementRun.result.id, backedProject.id);
    assert.equal(lateRestoreResult.task.state, 'completed', 'opaque storage backed up while uninstalled becomes project-restorable after an owner is installed');
    const lateRestore = componentRestoreCalls.slice(lateRestoreStart).find(call => call.componentId === 'late-component');
    assert.equal(lateRestore.payload.sources[0].format, 'unversioned');
    assert.equal(lateRestore.payload.sources[0].sourceVersion, 'unversioned');
    assert.equal(lateRestore.payload.sources[0].metadataOrigin, 'inferred');
    lateComponentInstalled = false;
    replacementManifest.files.pop(); replacementManifest.componentBackups.pop();
    await fs.promises.writeFile(replacementManifestPath, JSON.stringify(replacementManifest), 'utf8');
    await fs.promises.rm(backedProjectRoot, { recursive: true, force: true });
    secondProjectRestoreSupported = false;
    const callsBeforeUnsupported = componentRestoreCalls.length;
    await assert.rejects(service.restoreProject(first.root, replacementRun.result.id, backedProject.id), error => error?.code === 'COMPONENT_PROJECT_RESTORE_UNSUPPORTED');
    assert.equal(componentRestoreCalls.length, callsBeforeUnsupported, 'unsupported components must be detected before any supported hook commits');
    secondProjectRestoreSupported = true;
    secondCurrentSourceMatches = false;
    await assert.rejects(service.restoreProject(first.root, replacementRun.result.id, backedProject.id), error => error?.code === 'COMPONENT_RESTORE_SOURCE_MISSING');
    assert.equal(componentRestoreCalls.length, callsBeforeUnsupported, 'missing declared component sources must fail before any hook commits');
    assert.equal((await service.verify(first.root, replacementRun.result.id)).task.state, 'completed', 'snapshot verification is independent of the currently installed component source format/path');
    secondCurrentSourceMatches = true;
    const sampleComponentRoot = path.join(first.dataRoot, 'components', 'sample-component');
    const secondComponentRoot = path.join(first.dataRoot, 'components', 'second-component');
    await Promise.all([sampleComponentRoot, secondComponentRoot].map(root => fs.promises.rm(path.join(root, 'restore-hook-marker.txt'), { force: true })));
    const beforeComponentRollback = await Promise.all([sampleComponentRoot, secondComponentRoot].map(root => fs.promises.readFile(path.join(root, 'storage.sqlite3'))));
    componentRestoreFailure = 'second-component:project'; componentRollbackTamper = true;
    await assert.rejects(service.restoreProject(first.root, replacementRun.result.id, backedProject.id), error => error instanceof AggregateError);
    componentRestoreFailure = null; componentRollbackTamper = false;
    assert.equal(fs.existsSync(path.join(sampleComponentRoot, 'restore-hook-marker.txt')), true, 'corrupt rollback backup is detected before any live component root is touched');
    await fs.promises.rm(path.join(first.dataRoot, '.component-restore-transactions'), { recursive: true, force: true });
    await Promise.all([sampleComponentRoot, secondComponentRoot].map(root => fs.promises.rm(path.join(root, 'restore-hook-marker.txt'), { force: true })));
    await fs.promises.rm(path.join(first.root, `.photoflow-project-restore-${backedProject.id}.incomplete`), { force: true });
    componentRestoreFailure = 'second-component:project';
    await assert.rejects(service.restoreProject(first.root, replacementRun.result.id, backedProject.id), /simulated component restore failure/);
    componentRestoreFailure = null;
    assert.deepEqual(await Promise.all([sampleComponentRoot, secondComponentRoot].map(root => fs.promises.readFile(path.join(root, 'storage.sqlite3')))), beforeComponentRollback, 'a later component failure must restore every component root byte-for-byte');
    assert.equal(fs.existsSync(path.join(sampleComponentRoot, 'restore-hook-marker.txt')), false, 'rollback removes writes committed by an earlier component hook');
    assert.equal(fs.existsSync(path.join(first.dataRoot, '.component-restore-transactions')), true, 'transaction parent remains available for future same-volume journals');
    assert.deepEqual(await fs.promises.readdir(path.join(first.dataRoot, '.component-restore-transactions')), [], 'successful rollback removes its journal and snapshots');
    await fs.promises.rm(path.join(first.root, `.photoflow-project-restore-${backedProject.id}.incomplete`), { force: true });
    const firstOperationId = sampleRestore.payload.operationId;
    componentPhaseFailures.set('sample-component:finalize', 1);
    const freshRestore = await service.restoreProject(first.root, replacementRun.result.id, backedProject.id);
    assert.equal(freshRestore.task.state, 'completed');
    assert(componentRestorePhaseCalls.filter(call => call.componentId === 'sample-component' && call.payload.phase === 'finalize').length >= 2, 'finalize token release retries without losing the pending token');
    const freshSampleRestore = componentRestoreCalls.filter(call => call.componentId === 'sample-component').at(-1);
    assert.notEqual(freshSampleRestore.payload.operationId, firstOperationId, 'a fresh user restore must receive a new component operation id');
    await fs.promises.rm(backedProjectRoot, { recursive: true, force: true });
    await Promise.all([sampleComponentRoot, secondComponentRoot].map(root => fs.promises.rm(path.join(root, 'restore-hook-marker.txt'), { force: true })));
    const beforeContinuationRollback = await Promise.all([sampleComponentRoot, secondComponentRoot].map(root => fs.promises.readFile(path.join(root, 'storage.sqlite3'))));
    componentContinuationFailure = true;
    await assert.rejects(service.restoreProject(first.root, replacementRun.result.id, backedProject.id), /simulated core continuation failure/);
    componentContinuationFailure = false;
    assert.deepEqual(await Promise.all([sampleComponentRoot, secondComponentRoot].map(root => fs.promises.readFile(path.join(root, 'storage.sqlite3')))), beforeContinuationRollback, 'core continuation failure rolls back all component roots while the outer lease is held');
    assert.equal(fs.existsSync(path.join(sampleComponentRoot, 'restore-hook-marker.txt')), false);
    await fs.promises.rm(path.join(first.root, `.photoflow-project-restore-${backedProject.id}.incomplete`), { force: true });
    assert.equal(recoveryLeases.at(-1).databases.length, 3, 'project restore must lock core, media and versioning databases');
    const backupObjectsRoot = `${path.resolve(target, STORE_DIRECTORY, 'objects')}${path.sep}`.toLocaleLowerCase();
    assert(recoveryPythonSources.every(source => !`${path.resolve(source)}${path.sep}`.toLocaleLowerCase().startsWith(backupObjectsRoot)), 'Python recovery only receives verified portable copies, never object-store paths');
    assert(recoveryLeases.at(-1).databases.every(database => database.mode === 'exclusive'));
    assert(recoveryActionOptions.some(options => options.signal && Number.isFinite(options.deadlineAt) && options.timeoutMs <= options.deadlineAt - Date.now() + 1000), 'recovery tools must receive the active AbortSignal and remaining deadline');
    await fs.promises.rm(backedProjectRoot, { recursive: true, force: true });
    const validRegistryBeforeFailure = await fs.promises.readFile(externalLinksPath, 'utf8');
    await fs.promises.writeFile(externalLinksPath, '{broken registry', 'utf8');
    const finalizeBeforeRegistryFailure = componentRestorePhaseCalls.filter(call => call.payload.phase === 'finalize').length;
    await assert.rejects(service.restoreProject(first.root, replacementRun.result.id, backedProject.id), /注册表|JSON|Unexpected/, 'registry parse failure must surface after the durable database commit');
    assert.equal(fs.existsSync(path.join(sampleComponentRoot, 'restore-hook-marker.txt')), true, 'post-commit registry failure must not roll component data back');
    assert(componentRestorePhaseCalls.filter(call => call.payload.phase === 'finalize').length > finalizeBeforeRegistryFailure, 'post-commit failure immediately attempts component token finalize');
    assert((await fs.promises.readdir(path.join(first.dataRoot, '.component-restore-transactions'))).length > 0, 'committed component journal remains available for replay after registry failure');
    await fs.promises.writeFile(externalLinksPath, validRegistryBeforeFailure, 'utf8');
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
      first.database, first.mediaDatabase, first.versioningDatabase, first.operationsDatabase,
    ].map(quickCheck)), ['ok', 'ok', 'ok', 'ok']);
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
    expiredManifest.createdAt = Date.now() - 400 * 24 * 60 * 60 * 1000;
    await fs.promises.writeFile(expiredManifestPath, JSON.stringify(expiredManifest, null, 2), 'utf8');
    const cleanupPreview = await service.spaceStatus(first.root);
    assert.strictEqual(cleanupPreview.expiredSnapshotCount, 1, 'cleanup preview must count snapshots outside the retention policy');
    assert.ok(cleanupPreview.reclaimableBytes > 0);
    assert.ok(cleanupPreview.estimatedReclaimableBytes >= cleanupPreview.reclaimableBytes, 'cleanup preview must include existing orphaned objects');
    const cleaned = await service.cleanup(first.root);
    assert.strictEqual(cleaned.task.state, 'completed');
    assert.strictEqual(fs.existsSync(orphanPath), false, 'cleanup must remove only unreferenced objects');
    assert.strictEqual(fs.existsSync(expiredSnapshotPath), false, 'cleanup must remove snapshots shown in the preview');
    for (const fixture of [
      { id: 'unsafe-future-created-at', mutate: manifest => { manifest.createdAt = Date.now() + 2 * 24 * 60 * 60 * 1000; } },
      { id: 'unsafe-duplicate-path', mutate: manifest => { manifest.files.push(structuredClone(manifest.files[0])); } },
    ]) {
      const unsafePath = path.join(target, STORE_DIRECTORY, 'snapshots', fixture.id);
      await fs.promises.cp(currentSnapshotPath, unsafePath, { recursive: true });
      const unsafeManifestPath = path.join(unsafePath, 'manifest.json');
      const unsafeManifest = JSON.parse(await fs.promises.readFile(unsafeManifestPath, 'utf8'));
      unsafeManifest.id = fixture.id; fixture.mutate(unsafeManifest);
      await fs.promises.writeFile(unsafeManifestPath, JSON.stringify(unsafeManifest), 'utf8');
      await assert.rejects(service.cleanup(first.root), /库存|清单语义无效/, `${fixture.id} must make GC fail closed`);
      assert.strictEqual(fs.existsSync(currentSnapshotPath), true, 'fail-closed GC must preserve the healthy snapshot');
      await fs.promises.rm(unsafePath, { recursive: true, force: true });
    }

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
    const originalDataRoot = currentWorkspace.dataRoot;
    const originalDatabase = currentWorkspace.database;
    currentWorkspace = { ...first, dataRoot: restoredDataRoot, database: restoredDatabase, operationsDatabase: restoredOperationsDatabase };
    fileReceiptWorkspaceComponent = 'sample-component';
    await fs.promises.writeFile(externalLinksPath, JSON.stringify({ version: 1, links: { 'current-link': { target: 'E:/current-media', kind: 'folder', createdAt: 2 } } }), 'utf8');
    await configMutationService.mutate(current => ({ ...current, theme: 'dark', defaultFolderSort: 'size', componentSettings: { ...(current.componentSettings || {}), 'concurrent-fixture': { enabled: true } }, componentSettingsRevisions: { ...(current.componentSettingsRevisions || {}), 'concurrent-fixture': 10 } }));
    const restored = await service.restoreWorkspace(first.root, replacementRun.result.id, restoreRoot);
    assert.strictEqual(restored.task.state, 'completed');
    const sampleWorkspaceRestore = componentRestoreCalls.filter(call => call.componentId === 'sample-component' && call.mode === 'workspace').at(-1);
    assert.deepEqual(sampleWorkspaceRestore.payload.sources.map(source => source.relativePath).sort(), ['sample-component/private/state.json', 'sample-component/storage.sqlite3', 'sample-component/storage.sqlite3-wal'], 'workspace hooks receive the complete current component tree, including SQLite sidecars and opaque files');
    assert(sampleWorkspaceRestore.payload.sources.every(source => !fs.existsSync(source.path)), 'workspace hook staging is removed after the hook settles');
    const sampleWorkspaceResult = restored.result.componentRestore.find(item => item.componentId === 'sample-component');
    const hostPreservedKey = `component-storage\0sample-component/private/state.json`;
    assert.equal(sampleWorkspaceResult.hostPreservedCount, 1, 'validated host-preserved dispositions are counted once');
    assert.equal(sampleWorkspaceResult.hostPreservedDigest, crypto.createHash('sha256').update(hostPreservedKey).digest('hex'), 'host-preserved result exposes only a stable bounded digest');
    assert.equal(Object.prototype.hasOwnProperty.call(sampleWorkspaceResult, 'hostPreservedPaths'), false, 'file receipt results do not persist the full host-preserved path list');
    assert.equal(restored.result.savedConfig.theme, 'light'); assert.equal(restored.result.savedConfig.defaultFolderSort, 'name', 'workspace restore returns the canonical ordinary settings from the snapshot');
    assert.equal(restored.result.savedConfig.workspacePath, path.resolve(restoreRoot));
    assert.deepEqual(readSavedConfig().theme, 'light'); assert.equal(readSavedConfig().defaultFolderSort, 'name', 'restored ordinary settings remain on disk instead of being overwritten by the pre-restore draft');
    assert.deepEqual(restored.result.savedConfig.backup, config.backup, 'the current backup connection policy remains preserved');
    assert.equal(recoveryLeases.at(-1).databases.length, 4, 'workspace restore must lock core domains and operations');
    assert(recoveryEvents.every((event, index) => event === (index % 2 === 0 ? 'suspended' : 'resumed')), 'every recovery lease must suspend and then resume all clients');
    assert.strictEqual(await fs.promises.readFile(path.join(restoreRoot, '待处理', 'workspace-one-项目', '新增文件.txt'), 'utf8'), 'incremental-content');
    assert.ok(await fs.promises.readFile(path.join(restoreRoot, '.photoflow-workspace-id'), 'utf8'));
    assert.ok((await fs.promises.stat(restoredDatabase)).isFile());
    const restoredUndo = await runPython('operations_db.py', ['undo_record_latest', '--database', restoredOperationsDatabase, '--payload', '{}']);
    assert.strictEqual(restoredUndo.record.id, 'workspace-one-id-undo', 'workspace restore must restore the operations journal');
    assert.equal(await fs.promises.readFile(path.join(restoredDataRoot, 'components', 'sample-component', 'storage.sqlite3'), 'utf8'), 'opaque-database-workspace-one-id');
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(restoredDataRoot, 'components', 'sample-component', 'private', 'state.json'), 'utf8')).id, 'workspace-one-id');
    assert.equal(await sha256FileForTest(path.join(restoredDataRoot, 'components', 'sample-component', 'private', 'state.json')),
      await sha256FileForTest(path.join(first.dataRoot, 'components', 'sample-component', 'private', 'state.json')),
      'the Host raw copy publishes the exact host-preserved source bytes');
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
