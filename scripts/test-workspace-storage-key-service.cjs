const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createWorkspaceStorageKeyService } = require('../electron/services/workspace-storage-key-service.cjs');
const { createBackupService, STORE_DIRECTORY } = require('../electron/services/backup-service.cjs');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createComponentDataAdoptionPolicy } = require('../electron/compatibility/component-data-adoption-policy.cjs');

const main = async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-workspace-key-'));
  try {
    const databaseDir = path.join(temporary, 'workspace-data'); const root = path.join(temporary, 'restored');
    fs.mkdirSync(databaseDir, { recursive: true }); fs.mkdirSync(root);
    const first = createWorkspaceStorageKeyService({ fs, path, crypto, databaseDir });
    const warmedKey = first.get(root); const restoredKey = 'a'.repeat(32);
    assert.notEqual(warmedKey, restoredKey); await first.bindForRestore(root, restoredKey);
    assert.equal(first.get(root), restoredKey, 'restore binding invalidates a pre-warmed path-derived cache key');
    assert.equal(first.getDataRootForKey(restoredKey), path.join(databaseDir, restoredKey));
    const restarted = createWorkspaceStorageKeyService({ fs, path, crypto, databaseDir });
    assert.equal(restarted.get(root), restoredKey, 'recreated storage-key service reads the same restored identity');
    const conflictRoot = path.join(temporary, 'conflict'); fs.mkdirSync(conflictRoot);
    const conflictService = createWorkspaceStorageKeyService({ fs, path, crypto, databaseDir }); const conflictKey = conflictService.get(conflictRoot);
    fs.mkdirSync(path.join(databaseDir, conflictKey), { recursive: true }); fs.writeFileSync(path.join(databaseDir, conflictKey, 'state'), 'occupied');
    await assert.rejects(conflictService.bindForRestore(conflictRoot, 'b'.repeat(32)), error => error?.code === 'WORKSPACE_STORAGE_KEY_CONFLICT');
    assert.equal(conflictService.get(conflictRoot), conflictKey, 'conflicting old storage is never rebound');

    const restoreRoot = path.join(temporary, 'workspace-restore'); fs.mkdirSync(restoreRoot);
    const restoreKeys = createWorkspaceStorageKeyService({ fs, path, crypto, databaseDir }); const prewarmedKey = restoreKeys.get(restoreRoot);
    const backupTarget = path.join(temporary, 'backup'); const objectRoot = path.join(backupTarget, STORE_DIRECTORY, 'objects');
    const store = (name, body) => {
      const buffer = Buffer.from(body); const hash = crypto.createHash('sha256').update(buffer).digest('hex'); const destination = path.join(objectRoot, hash.slice(0, 2), hash.slice(2));
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, buffer); return { path: name, hash, size: buffer.length, mtimeMs: 1 };
    };
    const core = store('workspace.sqlite3', 'core-k2'); const operations = store('operations.sqlite3', 'operations-k2'); const component = store('offline-fixture/storage.sqlite3', 'component-k2'); const componentExtra = store('offline-fixture/private/extra.bin', 'extra-k2'); const legacyComponent = store('offline-fixture.sqlite3', 'redundant-legacy');
    const snapshotId = 'workspace-key-e2e'; const manifest = {
      formatVersion: 1, id: snapshotId, complete: true, createdAt: 1, appVersion: 'test', workspace: { id: restoredKey, root: 'C:/old', dataRoot: 'C:/old-data' }, database: core, projects: [],
      files: [{ scope: 'domain-database', ...operations }, { scope: 'component-storage', ...component }, { scope: 'component-storage', ...componentExtra }, { scope: 'domain-database', ...legacyComponent }],
      componentBackups: [{ componentId: 'offline-fixture', componentVersion: '1', sources: [{ scope: 'component-storage', path: component.path, format: 'component-storage-v1' }, { scope: 'domain-database', path: legacyComponent.path, format: 'legacy-domain-v1' }] }],
    };
    const snapshotRoot = path.join(backupTarget, STORE_DIRECTORY, 'snapshots', snapshotId); fs.mkdirSync(snapshotRoot, { recursive: true }); fs.writeFileSync(path.join(snapshotRoot, 'manifest.json'), JSON.stringify(manifest));
    const keyForRoot = candidate => restoreKeys.get(candidate); const dataForRoot = candidate => restoreKeys.getDataRootForKey(keyForRoot(candidate));
    const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() }); const config = { backup: { targetPath: backupTarget } }; let failBindOnce = false;
    const componentDataAdoptionPolicy = createComponentDataAdoptionPolicy({ version: 1, legacyDomainDatabaseOwners: [{ componentId: 'offline-fixture', paths: ['offline-fixture.sqlite3'] }], legacySettingsAdoptions: [] });
    const backup = createBackupService({
      app: { getVersion: () => 'test' }, backgroundTasks, readSavedConfig: () => config,
      configMutationService: { read: async () => config, mutate: async worker => worker(config), mergeRestoredConfig: (current, _restored, workspacePath) => ({ ...current, workspacePath }) },
      getConfigPath: () => path.join(temporary, 'config.json'), getUserBirthdaysPath: () => path.join(temporary, 'birthdays.json'), getManagedExternalLinkRegistryPath: () => path.join(temporary, 'links.json'), getManagedExternalLinks: () => [],
      getWorkspaceDataRoot: dataForRoot, getWorkspaceDataRootForKey: restoreKeys.getDataRootForKey, bindWorkspaceStorageKeyForRestore: async (...args) => { if (failBindOnce) { failBindOnce = false; throw new Error('simulated post-plan bind failure'); } return restoreKeys.bindForRestore(...args); },
      getWorkspaceDatabasePath: candidate => path.join(databaseDir, `${keyForRoot(candidate)}.sqlite3`),
      getWorkspaceOperationsDatabasePath: candidate => path.join(dataForRoot(candidate), 'databases', 'operations.sqlite3'), getWorkspaceMediaDatabasePath: candidate => path.join(dataForRoot(candidate), 'databases', 'media.sqlite3'), getWorkspaceVersioningDatabasePath: candidate => path.join(dataForRoot(candidate), 'databases', 'versioning.sqlite3'),
      workspaceSqliteCoordinator: { run: async (_options, worker) => worker() }, prepareDomainRecovery: async () => async () => undefined,
      runPythonJsonAction: async (_script, args) => { const source = args[args.indexOf('--source') + 1]; const destination = args[args.indexOf('--destination') + 1]; fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); return {}; }, shell: {}, credentialService: {}, writeLog: () => undefined,
      componentServiceManager: { backupRestoreDescriptors: () => [], invokeBackupRestore: async () => { throw new Error('unexpected hook'); }, prepareBackupRestore: async () => true },
      componentDataAdoptionPolicy,
    });
    backup.approveTarget(backupTarget);
    const resumedWorkspaceId = 'c'.repeat(32); const resumedTaskId = 'workspace-key-planned-resume';
    fs.writeFileSync(path.join(path.dirname(restoreRoot), `.pfr-${crypto.randomUUID()}.next`), JSON.stringify({ schemaVersion: 1, state: 'planned', destinationRoot: restoreRoot, workspaceId: resumedWorkspaceId, snapshotId, restoreSessionId: resumedTaskId, taskId: resumedTaskId }));
    const restored = await backup.restoreWorkspace('', snapshotId, restoreRoot, { id: resumedTaskId, metadata: { restoreSessionId: resumedTaskId }, checkpoint: {}, progress: 0 }); assert.equal(restored.task.state, 'completed');
    const boundKey = fs.readFileSync(path.join(restoreRoot, '.photoflow-workspace-id'), 'utf8').trim(); assert.equal(boundKey, resumedWorkspaceId, 'resume claims the unique validated parent-directory planned marker identity'); assert.notEqual(prewarmedKey, boundKey);
    const restartedKeys = createWorkspaceStorageKeyService({ fs, path, crypto, databaseDir }); assert.equal(restartedKeys.get(restoreRoot), boundKey);
    const restartedDataRoot = restartedKeys.getDataRootForKey(boundKey);
    assert.equal(fs.readFileSync(path.join(databaseDir, `${boundKey}.sqlite3`), 'utf8'), 'core-k2');
    assert.equal(fs.readFileSync(path.join(restartedDataRoot, 'databases', 'operations.sqlite3'), 'utf8'), 'operations-k2');
    assert.equal(fs.readFileSync(path.join(restartedDataRoot, 'components', 'offline-fixture', 'storage.sqlite3'), 'utf8'), 'component-k2');
    assert.equal(fs.readFileSync(path.join(restartedDataRoot, 'components', 'offline-fixture', 'private', 'extra.bin'), 'utf8'), 'extra-k2');
    assert.equal(restored.result.componentRestore[0].redundantLegacySourceCount, 1, 'uninstalled transition restore preserves current storage and skips its redundant legacy database');
    assert.equal(fs.existsSync(path.join(restartedDataRoot, 'offline-fixture.sqlite3')), false);
    const oldSnapshotId = 'workspace-key-old-transition'; const oldManifest = { ...structuredClone(manifest), id: oldSnapshotId }; delete oldManifest.componentBackups;
    const oldSnapshotRoot = path.join(backupTarget, STORE_DIRECTORY, 'snapshots', oldSnapshotId); fs.mkdirSync(oldSnapshotRoot, { recursive: true }); fs.writeFileSync(path.join(oldSnapshotRoot, 'manifest.json'), JSON.stringify(oldManifest));
    const oldRestoreRoot = path.join(temporary, 'old-transition-restore'); fs.mkdirSync(oldRestoreRoot); restoreKeys.get(oldRestoreRoot);
    const oldRestored = await backup.restoreWorkspace('', oldSnapshotId, oldRestoreRoot); assert.equal(oldRestored.task.state, 'completed');
    const oldKey = fs.readFileSync(path.join(oldRestoreRoot, '.photoflow-workspace-id'), 'utf8').trim(); const oldDataRoot = restoreKeys.getDataRootForKey(oldKey);
    assert.equal(fs.readFileSync(path.join(oldDataRoot, 'components', 'offline-fixture', 'storage.sqlite3'), 'utf8'), 'component-k2');
    assert.equal(oldRestored.result.componentRestore[0].redundantLegacySourceCount, 1, 'old metadata-less transition snapshot uses only the exact policy-owned current main database');
    await assert.rejects(backup.restoreProject(oldRestoreRoot, oldSnapshotId, 'missing-project'), error => error?.code === 'COMPONENT_PROJECT_RESTORE_UNSUPPORTED', 'project restore still requires an installed owner hook');
    const missingMainId = 'workspace-key-old-transition-missing-main'; const missingMain = structuredClone(oldManifest); missingMain.id = missingMainId; missingMain.files = missingMain.files.filter(entry => entry.path !== 'offline-fixture/storage.sqlite3');
    const missingMainRoot = path.join(backupTarget, STORE_DIRECTORY, 'snapshots', missingMainId); fs.mkdirSync(missingMainRoot, { recursive: true }); fs.writeFileSync(path.join(missingMainRoot, 'manifest.json'), JSON.stringify(missingMain));
    const rejectedOldRoot = path.join(temporary, 'old-transition-rejected');
    await assert.rejects(backup.restoreWorkspace('', missingMainId, rejectedOldRoot), error => error?.code === 'COMPONENT_LEGACY_RESTORE_OWNER_MISSING');
    assert.equal(fs.existsSync(rejectedOldRoot), false);

    const formalRoot = path.join(temporary, 'formal-planned-resume'); fs.mkdirSync(formalRoot);
    const formalTaskId = 'workspace-key-formal-resume'; const formalKey = 'd'.repeat(32);
    fs.writeFileSync(path.join(formalRoot, '.photoflow-restore-incomplete'), JSON.stringify({ schemaVersion: 1, state: 'planned', destinationRoot: formalRoot, workspaceId: formalKey, snapshotId, restoreSessionId: formalTaskId, taskId: formalTaskId }));
    const formalRestored = await backup.restoreWorkspace('', snapshotId, formalRoot, { id: formalTaskId, metadata: { restoreSessionId: formalTaskId }, checkpoint: { newWorkspaceId: formalKey }, progress: 0 });
    assert.equal(formalRestored.task.state, 'completed'); assert.equal(restoreKeys.get(formalRoot), formalKey, 'formal planned resume binds its declared workspace key');
    const formalDataRoot = restoreKeys.getDataRootForKey(formalKey);
    assert.equal(fs.readFileSync(path.join(databaseDir, `${formalKey}.sqlite3`), 'utf8'), 'core-k2');
    assert.equal(fs.readFileSync(path.join(formalDataRoot, 'databases', 'operations.sqlite3'), 'utf8'), 'operations-k2');
    assert.equal(fs.readFileSync(path.join(formalDataRoot, 'components', 'offline-fixture', 'storage.sqlite3'), 'utf8'), 'component-k2');

    const mismatchRoot = path.join(temporary, 'candidate-checkpoint-mismatch'); fs.mkdirSync(mismatchRoot);
    const mismatchTaskId = 'workspace-key-mismatch'; const candidateKey = 'e'.repeat(32); const checkpointKey = 'f'.repeat(32);
    const mismatchCandidate = path.join(path.dirname(mismatchRoot), `.pfr-${crypto.randomUUID()}.next`);
    fs.writeFileSync(mismatchCandidate, JSON.stringify({ schemaVersion: 1, state: 'planned', destinationRoot: mismatchRoot, workspaceId: candidateKey, snapshotId, restoreSessionId: mismatchTaskId, taskId: mismatchTaskId }));
    await assert.rejects(backup.restoreWorkspace('', snapshotId, mismatchRoot, { id: mismatchTaskId, metadata: { restoreSessionId: mismatchTaskId }, checkpoint: { newWorkspaceId: checkpointKey }, progress: 0 }), error => error?.code === 'WORKSPACE_STORAGE_KEY_CONFLICT');
    assert.equal(fs.existsSync(mismatchCandidate), true, 'mismatched checkpoint never claims or renames the parent planned marker');
    assert.equal(fs.existsSync(path.join(mismatchRoot, '.photoflow-restore-incomplete')), false);

    const longRoot = path.join(temporary, `long-${'x'.repeat(196)}`); fs.mkdirSync(longRoot);
    const longRestored = await backup.restoreWorkspace('', snapshotId, longRoot); assert.equal(longRestored.task.state, 'completed', 'fixed short parent plan name supports a near-limit destination basename');
    const longKey = fs.readFileSync(path.join(longRoot, '.photoflow-workspace-id'), 'utf8').trim(); const longDataRoot = restoreKeys.getDataRootForKey(longKey);
    assert.equal(fs.readFileSync(path.join(longDataRoot, 'components', 'offline-fixture', 'storage.sqlite3'), 'utf8'), 'component-k2');

    const retryRoot = path.join(temporary, 'background-retry-lineage'); failBindOnce = true;
    await assert.rejects(backup.restoreWorkspace('', snapshotId, retryRoot), /simulated post-plan bind failure/);
    const failedTask = backgroundTasks.list().find(task => task.type === 'workspace-restore' && task.metadata?.targetPath === path.resolve(retryRoot) && task.state === 'failed'); assert(failedTask);
    const retryStart = await backgroundTasks.retry(failedTask.id); const retryExecution = await retryStart.completion;
    assert.notEqual(retryStart.replacementTaskId, failedTask.id); assert.equal(retryExecution.task.state, 'completed');
    const retryKey = fs.readFileSync(path.join(retryRoot, '.photoflow-workspace-id'), 'utf8').trim(); const retryDataRoot = restoreKeys.getDataRootForKey(retryKey);
    assert.equal(fs.readFileSync(path.join(databaseDir, `${retryKey}.sqlite3`), 'utf8'), 'core-k2');
    assert.equal(fs.readFileSync(path.join(retryDataRoot, 'components', 'offline-fixture', 'storage.sqlite3'), 'utf8'), 'component-k2');
    await backgroundTasks.destroy?.();
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  console.log('Workspace storage key restore binding tests passed');
};
main().catch(error => { console.error(error); process.exitCode = 1; });
