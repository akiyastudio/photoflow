const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { normalizeProjectDate, readProjectDate } = require('../electron/modules/workspace/project-date.cjs');
const { normalizeProjectFileListFilter } = require('../electron/modules/workspace/file-list-contract.cjs');
const { createDeletedProjectCleanup } = require('../electron/modules/workspace/deleted-project-cleanup.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-workspace-transaction-'));
const persistentClaimPath = (root, id) => {
  const canonicalRoot = fs.realpathSync.native(path.resolve(root));
  const comparableRoot = process.platform === 'win32' ? canonicalRoot.toLocaleLowerCase() : canonicalRoot;
  const digest = crypto.createHash('sha256').update(`${comparableRoot}\0${id}`).digest('hex');
  return path.join(canonicalRoot, `.photoflow-undo-claim-${digest}.json`);
};
const claimMarkers = root => fs.readdirSync(root).filter(name => name.startsWith('.photoflow-undo-claim-'));
const context = (handlers, overrides = {}) => ({
  Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto, fs, path,
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, WORKSPACE_STATUSES: ['策划中'],
  HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(),
  cleanProjectName: value => String(value || '').trim(), ensureWorkspace: value => path.resolve(value),
  getProjectPath: (root, _status, name) => path.join(root, name), getWorkspaceDataRoot: root => path.join(root, '.data'),
  assertInside: (root, candidate) => { const relative = path.relative(root, candidate); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside'); return candidate; },
  pathExists: async candidate => fs.existsSync(candidate), workspaceCatalogs: new Map(), activeProjectFileOperations: new Map(),
  pushUndoOperation: async () => undefined, renameHistory: [], writeLog: () => undefined, ...overrides,
});

const run = async () => {
  const workspaceIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'workspace-ipc.cjs'), 'utf8');
  const claimImplementation = workspaceIpcSource.slice(workspaceIpcSource.indexOf("const persistentUndoClaimPrefix"), workspaceIpcSource.indexOf('const pruneBlockedPersistentUndos'));
  assert.doesNotMatch(claimImplementation, /removePersistentUndoClaim|\.unlink\s*\(|\.rename\s*\(|publishPathNoClobber/, 'persistent claim tombstones have no destructive cleanup path');
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
  const executeRejectedCreate = async ({ label, readCatalog, readError = null }) => {
    const outcomeRoot = path.join(temporaryRoot, label); fs.mkdirSync(outcomeRoot, { recursive: true });
    const handlers = new Map(); let syncCalls = 0;
    registerWorkspaceIpc(context(handlers, {
      workspaceCatalogs: new Map([[outcomeRoot, { projects: [], byName: new Map() }]]),
      workspaceRepository: { addProject: async () => { throw new Error('mutation response disconnected'); } },
      refreshWorkspaceCatalog: async () => { if (readError) throw readError; return readCatalog; },
      reconcileWorkspaceCatalog: async () => { syncCalls += 1; return readCatalog; },
      publishPathNoClobber: noClobberRename, telemetryService: { track: () => undefined },
    }));
    const result = await handlers.get('workspace-create-project')(null, outcomeRoot, null, 'Probe', { createPlanningFolder: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    return { result, projectPath: path.join(outcomeRoot, 'Probe'), syncCalls };
  };

  const emptyRead = { projects: [], byName: new Map() };
  const notCommitted = await executeRejectedCreate({ label: 'probe-not-committed', readCatalog: emptyRead });
  assert.strictEqual(notCommitted.result.success, false);
  assert.strictEqual(notCommitted.syncCalls, 0, 'a successful read-only negative probe must never call syncCatalog');
  assert.strictEqual(fs.existsSync(notCommitted.projectPath), false, 'definitely uncommitted filesystem creation is identity-cleaned');
  assert.strictEqual(emptyRead.projects.length, 0, 'read-only probing must not create a missing/unclassified catalog row');

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
    publishPathNoClobber: async (sourcePath, destinationPath) => { if (fs.existsSync(destinationPath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); await fs.promises.rename(sourcePath, destinationPath); return {}; },
  }));
  const imported = await importHandlers.get('workspace-import-existing-project')({ sender: { isDestroyed: () => false, send: () => undefined } }, importRoot, importSource, { name: 'Imported', mode: 'copy' });
  assert.strictEqual(imported.success, false); assert.strictEqual(imported.committed, true); assert.strictEqual(imported.catalogRefreshPending, true);
  assert.strictEqual(imported.project, undefined, 'catalog-pending import must not expose a temporary project identity');
  assert.strictEqual(fs.readFileSync(path.join(importRoot, 'Imported', 'photo.jpg'), 'utf8'), 'image');

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
  assert.strictEqual(secondPersistentUndo.error, '没有可撤销的操作'); assert.strictEqual(latestCalls, 2); assert.strictEqual(restoreCalls, 2, 'terminal persistent recovery must not execute again');

  const blockedRoot = path.join(temporaryRoot, 'blocked-persistent'); fs.mkdirSync(blockedRoot); const blockedOriginal = path.join(blockedRoot, 'restore.txt');
  const blockedPayload = { items: [{ original: blockedOriginal, originalIdentity: null, recyclePidl: 'blocked-pidl' }] }; const blockedOperation = { kind: 'trash', workspaceRoot: blockedRoot, persistentId: 'blocked-undo', ...blockedPayload };
  const blockedHistory = [blockedOperation]; const blockedHandlers = new Map(); let blockedRestoreCalls = 0; let blockedMarkCalls = 0; let blockedLatestCalls = 0;
  registerWorkspaceIpc(context(blockedHandlers, {
    renameHistory: blockedHistory, resolveWorkspaceRoot: value => value, persistentUndoQuarantineTtlMs: 1,
    workspaceRepository: { markUndoRecordUnavailable: async () => { blockedMarkCalls += 1; throw new Error('operations DB offline'); }, latestUndoRecord: async () => { blockedLatestCalls += 1; return { record: { id: 'blocked-undo', kind: 'trash', payload: blockedPayload } }; } },
    recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { blockedRestoreCalls += 1; throw Object.assign(new Error('blocked restore unknown'), { code: 'BLOCKED_UNKNOWN', outcomeUnknown: true, recoveryPath: 'C:\\Recovery\\blocked' }); } },
  }));
  const firstBlocked = await blockedHandlers.get('workspace-undo-rename')(null, '');
  await new Promise(resolve => setTimeout(resolve, 10));
  const secondBlocked = await blockedHandlers.get('workspace-undo-rename')(null, blockedRoot);
  assert.strictEqual(firstBlocked.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(secondBlocked.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.match(firstBlocked.cleanupWarning, /operations DB offline/);
  assert.strictEqual(blockedRestoreCalls, 0, 'failed persistent marking stops before restore'); assert.strictEqual(blockedLatestCalls, 2); assert.strictEqual(blockedMarkCalls, 3, 'an existing tombstone never marks the journal as a loser'); assert.strictEqual(blockedHistory.length, 0);
  assert.strictEqual(claimMarkers(blockedRoot).length, 1, 'failed marking retains the durable claim');

  const crossRoot = path.join(temporaryRoot, 'cross-process-unknown'); fs.mkdirSync(crossRoot); const crossId = 'cross-process-undo'; const crossOriginal = path.join(crossRoot, 'restore.txt');
  const crossPayload = { items: [{ original: crossOriginal, originalIdentity: null, recyclePidl: 'cross-pidl' }] }; let crossRestoreCalls = 0; let crossProbeCalls = 0; let crossMarkCalls = 0;
  const crossRepository = { latestUndoRecord: async () => ({ record: { id: crossId, kind: 'trash', payload: crossPayload } }), markUndoRecordUnavailable: async () => { crossMarkCalls += 1; } };
  const crossRecycle = { probe: async () => { crossProbeCalls += 1; return { exists: true }; }, restore: async () => { crossRestoreCalls += 1; throw Object.assign(new Error('restore outcome unknown'), { code: 'RESTORE_OUTCOME_UNKNOWN', outcomeUnknown: true }); } };
  const crossFirstHandlers = new Map(); const crossSecondHandlers = new Map();
  registerWorkspaceIpc(context(crossFirstHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: crossRepository, recycleBinService: crossRecycle }));
  registerWorkspaceIpc(context(crossSecondHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: crossRepository, recycleBinService: crossRecycle }));
  const crossFirst = await crossFirstHandlers.get('workspace-undo-rename')(null, crossRoot);
  const crossSecond = await crossSecondHandlers.get('workspace-undo-rename')(null, crossRoot);
  assert.strictEqual(crossFirst.code, 'RESTORE_OUTCOME_UNKNOWN', JSON.stringify(crossFirst)); assert.strictEqual(crossSecond.code, 'PERSISTENT_UNDO_RECOVERY_PENDING', JSON.stringify(crossSecond));
  assert.strictEqual(crossRestoreCalls, 1, 'a new IPC instance cannot repeat an outcome-unknown restore'); assert.strictEqual(crossProbeCalls, 1, 'an existing claim bypasses probing'); assert.strictEqual(crossMarkCalls, 1, 'restart loser does not mark a ready journal');

  const crashRoot = path.join(temporaryRoot, 'cross-process-crash'); fs.mkdirSync(crashRoot); const crashId = 'crash-before-mark'; const crashOriginal = path.join(crashRoot, 'restore.txt');
  const crashPayload = { items: [{ original: crashOriginal, originalIdentity: null, recyclePidl: 'crash-pidl' }] }; let crashRestoreCalls = 0; let crashProbeCalls = 0;
  const crashFirstHandlers = new Map(); const crashSecondHandlers = new Map();
  registerWorkspaceIpc(context(crashFirstHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: { id: crashId, kind: 'trash', payload: crashPayload } }), markUndoRecordUnavailable: async () => { throw new Error('simulated process crash after claim'); } }, recycleBinService: { probe: async () => { crashProbeCalls += 1; return { exists: true }; }, restore: async () => { crashRestoreCalls += 1; } } }));
  registerWorkspaceIpc(context(crashSecondHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: { id: crashId, kind: 'trash', payload: crashPayload } }), markUndoRecordUnavailable: async () => undefined }, recycleBinService: { probe: async () => { crashProbeCalls += 1; return { exists: true }; }, restore: async () => { crashRestoreCalls += 1; } } }));
  const crashedClaim = await crashFirstHandlers.get('workspace-undo-rename')(null, crashRoot);
  const recoveredClaim = await crashSecondHandlers.get('workspace-undo-rename')(null, crashRoot);
  assert.strictEqual(crashedClaim.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(recoveredClaim.code, 'PERSISTENT_UNDO_RECOVERY_PENDING');
  assert.strictEqual(crashRestoreCalls, 0); assert.strictEqual(crashProbeCalls, 1, 'restart with a ready journal and claim does not probe again');

  const raceRoot = path.join(temporaryRoot, 'claim-race'); fs.mkdirSync(raceRoot); const raceId = 'concurrent-undo'; const raceOriginal = path.join(raceRoot, 'restore.txt'); const racePayload = { items: [{ original: raceOriginal, originalIdentity: null, recyclePidl: 'race-pidl' }] };
  let raceRestoreCalls = 0; let raceProbeCalls = 0; let raceMarkCalls = 0; let raceState = 'ready'; let releaseRaceProbes; const bothProbed = new Promise(resolve => { releaseRaceProbes = resolve; });
  const raceRepository = { latestUndoRecord: async () => ({ record: raceState === 'ready' ? { id: raceId, kind: 'trash', payload: racePayload } : null }), markUndoRecordUnavailable: async () => { raceMarkCalls += 1; raceState = 'unavailable'; }, removeUndoRecord: async () => { raceState = 'removed'; } };
  const raceRecycle = { probe: async () => { raceProbeCalls += 1; if (raceProbeCalls === 2) releaseRaceProbes(); await bothProbed; return { exists: true }; }, restore: async ({ originalPath }) => { raceRestoreCalls += 1; fs.writeFileSync(originalPath, 'restored'); } };
  const raceHandlersA = new Map(); const raceHandlersB = new Map();
  registerWorkspaceIpc(context(raceHandlersA, { resolveWorkspaceRoot: value => value, workspaceRepository: raceRepository, recycleBinService: raceRecycle }));
  registerWorkspaceIpc(context(raceHandlersB, { resolveWorkspaceRoot: value => value, workspaceRepository: raceRepository, recycleBinService: raceRecycle }));
  const raceResults = await Promise.all([raceHandlersA.get('workspace-undo-rename')(null, raceRoot), raceHandlersB.get('workspace-undo-rename')(null, raceRoot)]);
  assert.strictEqual(raceResults.filter(result => result.success).length, 1); assert.strictEqual(raceRestoreCalls, 1, 'atomic wx claim admits exactly one concurrent restore'); assert.strictEqual(raceMarkCalls, 1, 'the tombstone loser cannot mark ahead of the winner'); assert.strictEqual(claimMarkers(raceRoot).length, 1, 'successful restore retains a permanent tombstone');

  const existingRoot = path.join(temporaryRoot, 'claim-exists'); fs.mkdirSync(existingRoot); const existingId = 'existing-claim'; const existingOriginal = path.join(existingRoot, 'restore.txt');
  fs.writeFileSync(persistentClaimPath(existingRoot, existingId), '{"foreign":true}'); let existingRestoreCalls = 0; let existingProbeCalls = 0; let existingMarkCalls = 0;
  const existingHandlers = new Map(); registerWorkspaceIpc(context(existingHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: { id: existingId, kind: 'trash', payload: { items: [{ original: existingOriginal, originalIdentity: null, recyclePidl: 'existing-pidl' }] } } }), markUndoRecordUnavailable: async () => { existingMarkCalls += 1; } }, recycleBinService: { probe: async () => { existingProbeCalls += 1; return { exists: true }; }, restore: async () => { existingRestoreCalls += 1; } } }));
  const existingResult = await existingHandlers.get('workspace-undo-rename')(null, existingRoot);
  assert.strictEqual(existingResult.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(existingProbeCalls, 0); assert.strictEqual(existingRestoreCalls, 0, 'EEXIST fails closed'); assert.strictEqual(existingMarkCalls, 0, 'startup loser does not modify the journal');

  const claimFailureCase = async (label, openFailure) => {
    const root = path.join(temporaryRoot, label); fs.mkdirSync(root); const id = `${label}-id`; const original = path.join(root, 'restore.txt'); let restoreCount = 0;
    const failingFs = { ...fs, promises: { ...fs.promises, open: async (candidate, flags, mode) => {
      if (path.basename(candidate).startsWith('.photoflow-undo-claim-')) return openFailure(candidate, flags, mode);
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
  assert.strictEqual(parentSyncFailure.code, 'CLAIM_PERSIST_FAILED'); assert.strictEqual(parentSyncRestoreCalls, 0, 'POSIX parent fsync failure stops before restore'); assert.strictEqual(claimMarkers(parentSyncRoot).length, 1, 'parent fsync failure retains the tombstone');

  const staleNullRoot = path.join(temporaryRoot, 'claim-stale-null'); fs.mkdirSync(staleNullRoot); const staleNullId = 'stale-null-id'; let staleNullMarkCalls = 0; let staleNullRestoreCalls = 0;
  const staleNullHandlers = new Map(); registerWorkspaceIpc(context(staleNullHandlers, { renameHistory: [{ kind: 'trash', workspaceRoot: staleNullRoot, persistentId: staleNullId, items: [{ original: path.join(staleNullRoot, 'restore.txt'), originalIdentity: null, recyclePidl: 'stale-null-pidl' }] }], workspaceRepository: { latestUndoRecord: async () => ({ record: null }), markUndoRecordUnavailable: async () => { staleNullMarkCalls += 1; } }, recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { staleNullRestoreCalls += 1; } } }));
  const staleNull = await staleNullHandlers.get('workspace-undo-rename')(null, ''); assert.strictEqual(staleNull.error, '没有可撤销的操作'); assert.strictEqual(staleNullMarkCalls, 0); assert.strictEqual(staleNullRestoreCalls, 0); assert.strictEqual(claimMarkers(staleNullRoot).length, 1, 'null stale reread retains tombstone');

  const staleOtherRoot = path.join(temporaryRoot, 'claim-stale-other'); fs.mkdirSync(staleOtherRoot); const staleOtherId = 'stale-other-id'; let staleOtherMarkCalls = 0; let staleOtherRestoreCalls = 0;
  const staleOtherHandlers = new Map(); registerWorkspaceIpc(context(staleOtherHandlers, { renameHistory: [{ kind: 'trash', workspaceRoot: staleOtherRoot, persistentId: staleOtherId, items: [{ original: path.join(staleOtherRoot, 'restore.txt'), originalIdentity: null, recyclePidl: 'stale-other-pidl' }] }], workspaceRepository: { latestUndoRecord: async () => ({ record: { id: 'different-ready-id', kind: 'trash', payload: { items: [] } } }), markUndoRecordUnavailable: async () => { staleOtherMarkCalls += 1; } }, recycleBinService: { probe: async () => ({ exists: true }), restore: async () => { staleOtherRestoreCalls += 1; } } }));
  const staleOther = await staleOtherHandlers.get('workspace-undo-rename')(null, ''); assert.strictEqual(staleOther.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(staleOtherMarkCalls, 0); assert.strictEqual(staleOtherRestoreCalls, 0); assert.strictEqual(claimMarkers(staleOtherRoot).length, 1, 'different-id stale reread fails closed and retains tombstone');

  const successRoot = path.join(temporaryRoot, 'claim-success'); fs.mkdirSync(successRoot); const successId = 'success-id'; const successOriginal = path.join(successRoot, 'restore.txt'); let successState = 'ready'; let successMarkCalls = 0; let successRestoreCalls = 0; let successUnlinkCalls = 0;
  const successFs = { ...fs, promises: { ...fs.promises, unlink: async () => { successUnlinkCalls += 1; throw new Error('marker unlink must never run'); } } };
  const successHandlers = new Map(); registerWorkspaceIpc(context(successHandlers, { fs: successFs, resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: successState === 'ready' ? { id: successId, kind: 'trash', payload: { items: [{ original: successOriginal, originalIdentity: null, recyclePidl: 'success-pidl' }] } } : null }), markUndoRecordUnavailable: async () => { successMarkCalls += 1; successState = 'unavailable'; }, removeUndoRecord: async () => { successState = 'removed'; } }, recycleBinService: { probe: async () => ({ exists: true }), restore: async ({ originalPath }) => { successRestoreCalls += 1; fs.writeFileSync(originalPath, 'restored'); } } }));
  const successUndo = await successHandlers.get('workspace-undo-rename')(null, successRoot); assert.strictEqual(successUndo.success, true, successUndo.error); assert.strictEqual(successState, 'removed'); assert.strictEqual(claimMarkers(successRoot).length, 1, 'normal success retains the permanent tombstone'); assert.strictEqual(successUnlinkCalls, 0, 'normal success never unlinks a claim path');
  const repeatedSuccessUndo = await successHandlers.get('workspace-undo-rename')(null, successRoot); assert.strictEqual(repeatedSuccessUndo.error, '没有可撤销的操作'); assert.strictEqual(successRestoreCalls, 1); assert.strictEqual(successMarkCalls, 1); assert.strictEqual(successUnlinkCalls, 0);

  const removeFailureRoot = path.join(temporaryRoot, 'claim-remove-failure'); fs.mkdirSync(removeFailureRoot); const removeFailureId = 'remove-failure-id'; const removeFailureOriginal = path.join(removeFailureRoot, 'restore.txt');
  const removeFailureHandlers = new Map(); registerWorkspaceIpc(context(removeFailureHandlers, { resolveWorkspaceRoot: value => value, workspaceRepository: { latestUndoRecord: async () => ({ record: { id: removeFailureId, kind: 'trash', payload: { items: [{ original: removeFailureOriginal, originalIdentity: null, recyclePidl: 'remove-failure-pidl' }] } } }), markUndoRecordUnavailable: async () => undefined, removeUndoRecord: async () => { throw new Error('DB remove failed'); } }, recycleBinService: { probe: async () => ({ exists: true }), restore: async ({ originalPath }) => { fs.writeFileSync(originalPath, 'restored'); } } }));
  const removeFailure = await removeFailureHandlers.get('workspace-undo-rename')(null, removeFailureRoot); assert.strictEqual(removeFailure.code, 'PERSISTENT_UNDO_RECOVERY_PENDING'); assert.strictEqual(claimMarkers(removeFailureRoot).length, 1, 'DB removal failure retains claim');

  const retryRoot = path.join(temporaryRoot, 'claim-preflight-retry'); fs.mkdirSync(retryRoot); const retryVolume = path.join(retryRoot, 'offline-volume'); const retryConflict = path.join(retryRoot, 'conflict.txt'); fs.writeFileSync(retryConflict, 'occupant');
  const volumeHandlers = new Map(); registerWorkspaceIpc(context(volumeHandlers, { renameHistory: [{ kind: 'trash', workspaceRoot: retryRoot, persistentId: 'volume-id', items: [{ original: path.join(retryVolume, 'item.txt'), originalIdentity: null, recyclePidl: 'volume-pidl' }] }], pathExists: async candidate => candidate !== path.parse(path.join(retryVolume, 'item.txt')).root, recycleBinService: { probe: async () => ({ exists: true }) } }));
  const volumeRetry = await volumeHandlers.get('workspace-undo-rename')(null, ''); assert.strictEqual(volumeRetry.code, 'RESTORE_VOLUME_UNAVAILABLE'); assert.strictEqual(claimMarkers(retryRoot).length, 0, 'volume preflight errors precede claim creation');
  const conflictHandlers = new Map(); registerWorkspaceIpc(context(conflictHandlers, { renameHistory: [{ kind: 'trash', workspaceRoot: retryRoot, persistentId: 'conflict-id', items: [{ original: retryConflict, originalIdentity: null, recyclePidl: 'conflict-pidl' }] }], samePathIdentity: async () => false, capturePathIdentity: async candidate => { const stat = await fs.promises.stat(candidate, { bigint: true }); return { device: String(stat.dev), inode: String(stat.ino), directory: stat.isDirectory() }; }, recycleBinService: { probe: async () => ({ exists: true }) } }));
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
  assert.strictEqual(overflowRestoreCalls, 0, 'failed marking and overflow both stop before restore'); assert.strictEqual(overflowMarkCalls, 9);

  const missingPersistentRoot = path.join(temporaryRoot, 'missing-persistent'); fs.mkdirSync(missingPersistentRoot); const missingPersistentPayload = { items: [{ original: path.join(missingPersistentRoot, 'gone'), originalIdentity: null, recyclePidl: 'gone-pidl' }] };
  const missingPersistentHistory = [{ kind: 'trash', workspaceRoot: missingPersistentRoot, persistentId: 'missing-undo', ...missingPersistentPayload }]; const missingPersistentHandlers = new Map(); let missingProbeCalls = 0; let missingMarkCalls = 0;
  registerWorkspaceIpc(context(missingPersistentHandlers, {
    renameHistory: missingPersistentHistory, resolveWorkspaceRoot: value => value,
    workspaceRepository: { markUndoRecordUnavailable: async () => { missingMarkCalls += 1; throw new Error('mark unavailable failed'); }, latestUndoRecord: async () => ({ record: { id: 'missing-undo', kind: 'trash', payload: missingPersistentPayload } }) },
    recycleBinService: { probe: async () => { missingProbeCalls += 1; return { exists: false }; } },
  }));
  const firstMissingPersistent = await missingPersistentHandlers.get('workspace-undo-rename')(null, '');
  const secondMissingPersistent = await missingPersistentHandlers.get('workspace-undo-rename')(null, missingPersistentRoot);
  assert.strictEqual(firstMissingPersistent.code, 'RECYCLE_ITEM_MISSING'); assert.strictEqual(secondMissingPersistent.code, 'RECYCLE_ITEM_MISSING'); assert.match(secondMissingPersistent.cleanupWarning, /mark unavailable failed/);
  assert.strictEqual(missingProbeCalls, 1, 'missing recycle item is not probed or executed again after persistence marking fails'); assert.strictEqual(missingMarkCalls, 6); assert.strictEqual(missingPersistentHistory.length, 0);

  const missingHistory = [{ kind: 'trash', items: [{ original: path.join(temporaryRoot, 'missing-restore'), originalIdentity: null, recyclePidl: 'missing-pidl' }] }]; const missingHandlers = new Map();
  registerWorkspaceIpc(context(missingHandlers, { renameHistory: missingHistory, recycleBinService: { probe: async () => ({ exists: false }) } }));
  const missingUndoFailure = await missingHandlers.get('workspace-undo-rename')(null, '');
  assert.strictEqual(missingUndoFailure.code, 'RECYCLE_ITEM_MISSING'); assert.strictEqual(missingHistory.length, 0, 'missing recycle items remain unavailable instead of being requeued');
  console.log('workspace transaction safety execution tests passed');
};

run().finally(() => fs.rmSync(temporaryRoot, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
