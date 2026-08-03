const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createBackupService, STORE_DIRECTORY } = require('../electron/services/backup-service.cjs');

const runPython = (script, args, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const executable = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
  const child = spawn(executable, [path.join(__dirname, '..', 'python', script), ...args], {
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

const prepareWorkspace = async (temporaryRoot, name, id) => {
  const root = path.join(temporaryRoot, name);
  const project = path.join(root, '待处理', `${name}-项目`);
  const dataRoot = path.join(temporaryRoot, 'workspace-data', id);
  const database = path.join(dataRoot, 'workspace.sqlite3');
  await fs.promises.mkdir(project, { recursive: true });
  await fs.promises.mkdir(dataRoot, { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, 'team-retouch'), { recursive: true });
  await fs.promises.writeFile(path.join(root, '.photoflow-workspace-id'), `${id}\n`, 'utf8');
  await fs.promises.writeFile(path.join(project, '原片.jpg'), `photo-${id}`, 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'team-retouch', 'shared.json'), `internal-${id}`, 'utf8');
  await runPython('workspace_db.py', ['catalog_sync', '--root', root, '--database', database, '--payload', '{}']);
  return { root, project, dataRoot, database };
};

const main = async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-backup-service-'));
  try {
    const target = path.join(temporaryRoot, 'backup-target');
    const configPath = path.join(temporaryRoot, 'photoflow_config.json');
    const birthdaysPath = path.join(temporaryRoot, 'birthdays.json');
    await fs.promises.mkdir(target);
    await fs.promises.writeFile(birthdaysPath, '[]', 'utf8');
    const first = await prepareWorkspace(temporaryRoot, 'workspace-one', 'workspace-one-id');
    const second = await prepareWorkspace(temporaryRoot, 'workspace-two', 'workspace-two-id');
    let currentWorkspace = first;
    const config = {
      workspacePath: first.root,
      backup: { enabled: true, targetPath: target, mode: 'latest', automaticDaily: true, afterImport: true, retention: { daily: 7, weekly: 4, monthly: 12 } },
    };
    await fs.promises.writeFile(configPath, JSON.stringify(config), 'utf8');
    const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const service = createBackupService({
      app: { getVersion: () => 'test' },
      backgroundTasks,
      getConfigPath: () => configPath,
      getUserBirthdaysPath: () => birthdaysPath,
      getWorkspaceDatabasePath: () => currentWorkspace.database,
      getWorkspaceDataRoot: () => currentWorkspace.dataRoot,
      readSavedConfig: () => config,
      runPythonJsonAction: runPython,
      writeLog: () => undefined,
    });

    const firstRun = await service.runBackup(first.root, 'manual');
    assert.strictEqual(firstRun.task.state, 'completed');
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
    const restoredDataRoot = path.join(temporaryRoot, 'restored-data');
    const restoredDatabase = path.join(restoredDataRoot, 'workspace.sqlite3');
    const originalDataRoot = currentWorkspace.dataRoot;
    const originalDatabase = currentWorkspace.database;
    currentWorkspace = { ...first, dataRoot: restoredDataRoot, database: restoredDatabase };
    const restored = await service.restoreWorkspace(first.root, replacementRun.result.id, restoreRoot);
    assert.strictEqual(restored.task.state, 'completed');
    assert.strictEqual(await fs.promises.readFile(path.join(restoreRoot, '待处理', 'workspace-one-项目', '新增文件.txt'), 'utf8'), 'incremental-content');
    assert.ok(await fs.promises.readFile(path.join(restoreRoot, '.photoflow-workspace-id'), 'utf8'));
    assert.ok((await fs.promises.stat(restoredDatabase)).isFile());
    assert.ok((await fs.promises.readdir(path.join(target, STORE_DIRECTORY, 'objects'))).length > 0);
    currentWorkspace = { ...first, dataRoot: originalDataRoot, database: originalDatabase };

    console.log('Backup service integration tests passed.');
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
