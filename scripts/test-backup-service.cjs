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
  const database = path.join(temporaryRoot, 'workspace-data', `${id}.sqlite3`);
  const operationsDatabase = path.join(dataRoot, 'databases', 'operations.sqlite3');
  const teamRetouchDatabase = path.join(dataRoot, 'databases', 'team-retouch.sqlite3');
  const mediaDatabase = path.join(dataRoot, 'databases', 'media.sqlite3');
  const versioningDatabase = path.join(dataRoot, 'databases', 'versioning.sqlite3');
  await fs.promises.mkdir(project, { recursive: true });
  await fs.promises.mkdir(dataRoot, { recursive: true });
  await fs.promises.mkdir(path.join(dataRoot, 'team-retouch'), { recursive: true });
  await fs.promises.writeFile(path.join(root, '.photoflow-workspace-id'), `${id}\n`, 'utf8');
  await fs.promises.writeFile(path.join(project, '原片.jpg'), `photo-${id}`, 'utf8');
  await fs.promises.writeFile(path.join(dataRoot, 'team-retouch', 'shared.json'), `internal-${id}`, 'utf8');
  await runPython('workspace_db.py', ['catalog_sync', '--root', root, '--database', database, '--payload', '{}']);
  await runPython('workspace_db.py', ['team_patch_list', '--root', root, '--database', database, '--payload', JSON.stringify({ photoId: 'missing' })]);
  await runPython('operations_db.py', ['undo_record_add', '--database', operationsDatabase, '--payload', JSON.stringify({
    id: `${id}-undo`, kind: 'trash', payload: { items: [] }, legacyDatabase: database,
  })]);
  return { root, project, dataRoot, database, operationsDatabase, teamRetouchDatabase, mediaDatabase, versioningDatabase };
};

const main = async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-backup-service-'));
  try {
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
      getManagedExternalLinkRegistryPath: () => externalLinksPath,
      getManagedExternalLinks: () => currentWorkspace === first ? [{ linkId: 'backed-link' }] : [],
      getWorkspaceDatabasePath: () => currentWorkspace.database,
      getWorkspaceOperationsDatabasePath: () => currentWorkspace.operationsDatabase,
      getWorkspaceTeamRetouchDatabasePath: () => currentWorkspace.teamRetouchDatabase,
      getWorkspaceMediaDatabasePath: () => currentWorkspace.mediaDatabase,
      getWorkspaceVersioningDatabasePath: () => currentWorkspace.versioningDatabase,
      getWorkspaceDataRoot: () => currentWorkspace.dataRoot,
      readSavedConfig: () => config,
      runPythonJsonAction: runPython,
      shell: { readShortcutLink: shortcutPath => JSON.parse(fs.readFileSync(shortcutPath, 'utf8')) },
      writeLog: () => undefined,
    });

    const firstRun = await service.runBackup(first.root, 'manual');
    assert.strictEqual(firstRun.task.state, 'completed');
    assert.ok(firstRun.result.files.some(entry => entry.scope === 'domain-database' && entry.path === 'operations.sqlite3'), 'operations database must use a consistent online snapshot');
    assert.ok(firstRun.result.files.some(entry => entry.scope === 'domain-database' && entry.path === 'team-retouch.sqlite3'), 'team-retouch database must use a consistent online snapshot');
    assert.ok(firstRun.result.files.some(entry => entry.scope === 'domain-database' && entry.path === 'media.sqlite3'), 'media database must use a consistent online snapshot');
    assert.ok(firstRun.result.files.some(entry => entry.scope === 'domain-database' && entry.path === 'versioning.sqlite3'), 'versioning database must use a consistent online snapshot');
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
    const restoredProject = await service.restoreProject(first.root, replacementRun.result.id, backedProject.id);
    assert.strictEqual(restoredProject.task.state, 'completed');
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
    const restoredTeamRetouchDatabase = path.join(restoredDataRoot, 'databases', 'team-retouch.sqlite3');
    const originalDataRoot = currentWorkspace.dataRoot;
    const originalDatabase = currentWorkspace.database;
    currentWorkspace = { ...first, dataRoot: restoredDataRoot, database: restoredDatabase, operationsDatabase: restoredOperationsDatabase, teamRetouchDatabase: restoredTeamRetouchDatabase };
    await fs.promises.writeFile(externalLinksPath, JSON.stringify({ version: 1, links: { 'current-link': { target: 'E:/current-media', kind: 'folder', createdAt: 2 } } }), 'utf8');
    const restored = await service.restoreWorkspace(first.root, replacementRun.result.id, restoreRoot);
    assert.strictEqual(restored.task.state, 'completed');
    assert.strictEqual(await fs.promises.readFile(path.join(restoreRoot, '待处理', 'workspace-one-项目', '新增文件.txt'), 'utf8'), 'incremental-content');
    assert.ok(await fs.promises.readFile(path.join(restoreRoot, '.photoflow-workspace-id'), 'utf8'));
    assert.ok((await fs.promises.stat(restoredDatabase)).isFile());
    const restoredUndo = await runPython('operations_db.py', ['undo_record_latest', '--database', restoredOperationsDatabase, '--payload', '{}']);
    assert.strictEqual(restoredUndo.record.id, 'workspace-one-id-undo', 'workspace restore must restore the operations journal');
    assert.ok((await fs.promises.stat(restoredTeamRetouchDatabase)).isFile(), 'workspace restore must restore the team-retouch store');
    const workspaceRestoredExternalLinks = JSON.parse(await fs.promises.readFile(externalLinksPath, 'utf8'));
    assert.ok(workspaceRestoredExternalLinks.links['backed-link'], 'workspace restore must restore identities referenced by restored shortcuts');
    assert.ok(workspaceRestoredExternalLinks.links['current-link'], 'workspace restore must preserve current identities');
    assert.strictEqual(workspaceRestoredExternalLinks.links['unrelated-link'], undefined, 'workspace restore must not restore unrelated global identities');
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
