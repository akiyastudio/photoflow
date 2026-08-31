const { getProtectedProjectFolderRegistry } = require('../services/protected-project-folder.cjs');
const { createProjectFileTask } = require('../services/project-file-task-service.cjs');
const { startDetachedBackgroundOperation } = require('../services/detached-background-operation.cjs');
const { replaceVideoFileWithRollback } = require('../services/video-trim-commit-service.cjs');
const { createProjectVirtualPathService } = require('../services/project-virtual-path-service.cjs');
const { normalizeProjectFileListFilter, projectFileListEntryMatchesFilter, projectFileListSessionMatches } = require('./workspace/file-list-contract.cjs');
const { IMPORT_GRAPH_RECEIPT_NAME, createImportReceiptService, validImportSessionId } = require('./workspace/import-receipt-service.cjs');
const { createWorkspaceStoragePolicy } = require('./workspace/storage-policy.cjs');
const { cleanupImportArtifacts } = require('./workspace/import-recovery.cjs');
const { createManagedExternalWatcherBindings } = require('./workspace/managed-external-watcher.cjs');
const { scheduleSdImportedMedia } = require('./workspace/sd-import-media-scan.cjs');
const { createDeletedProjectCleanup } = require('./workspace/deleted-project-cleanup.cjs');
const { formatProjectDate, normalizeProjectDate, readProjectDate } = require('./workspace/project-date.cjs');
const { runWorkspaceMaintenanceWithRetry, workspaceDatabaseTaskResource } = require('./workspace/workspace-maintenance.cjs');
const { publishPathNoClobber: defaultPublishPathNoClobber, releaseCleanupOwnership: defaultReleaseCleanupOwnership } = require('../services/file-transfer-service.cjs');
const { registerVideoTimelineIpc } = require('./workspace/video-timeline-ipc.cjs');
const { registerEntryUtilityIpc } = require('./workspace/entry-utility-ipc.cjs');
const { isInternalWorkspacePathSegment } = require('../infrastructure/internal-workspace-path.cjs');

const MANAGED_EXTERNAL_FOLDER_PREFIX = 'PhotoFlow 外链文件夹：';
const MANAGED_EXTERNAL_FILE_PREFIX = 'PhotoFlow 外链文件：';
const MAX_EXPLICIT_MATERIALIZE_PATHS = 512;
const MAX_EXPLICIT_MATERIALIZE_PATH_BYTES = 64 * 1024;
const registerWorkspaceIpc = context => {
  const { Array, Boolean, CANCELLED_CODE, Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES, IMAGE_EXTENSIONS, Math, Object, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, WORKSPACE_STATUSES, activeProjectFileOperations, acquireFileRootWatcher, app, assertDiskSpace, assertExistingInside, assertInside, assertRegularFile, assertUndoIdentity, backgroundTasks, cancelMediaTrackingScan, capturePathIdentity, cleanProjectName, clipboard, collectCopyPlan, copyFileAtomic, copyPlannedFiles, componentServiceManager, crypto, dialog, ensureWorkspace, findLatestPhotoshop, fs, getProjectPath, getWorkspaceDataRoot, ipcMain, mainWindow, mediaRuntimeState, mediaService, moveFileAtomic, movePathAtomic, publishPathNoClobber = defaultPublishPathNoClobber, mutateWorkspaceCatalog, normalizeMediaCacheSizeGB, path, pathExists, pluginService, projectVirtualPaths, pushUndoOperation, releaseCleanupOwnership = defaultReleaseCleanupOwnership, removeUndoOperation = () => false, reconcileWorkspaceCatalog, recycleBinService, refreshWorkspaceCatalog, releaseFileRootWatcher, releaseWorkspaceWatchPath, removeCopiedSources, renameHistory, resolveProjectEntry, resolveWorkspaceRoot, resumeFileRootWatcher, runPythonJsonAction, samePathIdentity, scheduleMediaTrackingScan, shell, shellNewService, spawn, suspendFileRootWatcher, suppressWorkspaceWatchPath, telemetryService, thumbnailService, throwIfCancelled, undefined, uniqueDestination, versionService, watchWorkspace, workspaceCatalogs, workspaceMaintenanceRepository, workspaceRepository, writeLog } = context;
  const { isProtectedProjectFolderName, isProtectedProjectFolderPath } = context.protectedProjectFolders || getProtectedProjectFolderRegistry();
  const extractTimelineFrames = context.extractVideoTimelineFrames;
  registerVideoTimelineIpc({ ipcMain, extractVideoTimelineFrames: extractTimelineFrames, resolveProjectEntry, fs, path, VIDEO_EXTENSIONS, writeLog });
  const logSlowWorkspaceInteraction = (operation, startedAt, details = {}) => {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 150) writeLog('info', 'Slow workspace interaction', { operation, elapsedMs, ...details });
  };
  const comparablePath = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
  const listManagedExternalLinksBounded = async (root, maximumLinks = 512) => {
    const links = [];
    const pending = [{ directory: root, virtualDirectory: '', depth: 0 }];
    const visited = new Set();
    let inspected = 0;
    let skippedCount = 0;
    let truncated = false;
    while (pending.length && inspected < 20000 && links.length < maximumLinks) {
      const current = pending.pop();
      if (current.depth > 64) { truncated = true; skippedCount += 1; continue; }
      const directoryStat = await fs.promises.lstat(current.directory, { bigint: true }).catch(() => null);
      if (!directoryStat || directoryStat.isSymbolicLink()) { skippedCount += 1; continue; }
      const identity = `${directoryStat.dev}:${directoryStat.ino}`;
      if (visited.has(identity)) { skippedCount += 1; continue; }
      visited.add(identity);
      const entries = await fs.promises.readdir(current.directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (links.length >= maximumLinks) { truncated = true; break; }
        if (inspected++ >= 20000) { truncated = true; break; }
        const entryPath = path.join(current.directory, entry.name);
        const stat = await fs.promises.lstat(entryPath).catch(() => null);
        if (!stat || stat.isSymbolicLink()) { skippedCount += 1; continue; }
        const virtualPath = [current.virtualDirectory, entry.name].filter(Boolean).join('/');
        if (stat.isDirectory()) { pending.push({ directory: entryPath, virtualDirectory: virtualPath, depth: current.depth + 1 }); continue; }
        if (!stat.isFile() || path.extname(entry.name).toLowerCase() !== '.lnk') continue;
        const link = virtualPaths.readManagedExternalLink(entryPath);
        if (!link) continue;
        const targetStat = await fs.promises.stat(link.target).catch(() => null);
        links.push({ shortcutPath: entryPath, shortcutVirtualPath: virtualPath, externalTargetRoot: link.target, externalDisplayName: path.basename(entry.name, '.lnk'), externalTargetKind: targetStat?.isDirectory() ? 'folder' : targetStat?.isFile() ? 'file' : link.targetKindHint, linkId: link.linkId, viaExternalLink: true, offline: !targetStat });
      }
    }
    if (pending.length || links.length >= maximumLinks) truncated = true;
    return { links, truncated, skippedCount };
  };
  const plannedProjectPath = (root, projectName, status = '策划中') => {
    let candidate;
    try { candidate = path.resolve(getProjectPath(root, status, projectName)); }
    catch { candidate = path.resolve(root, projectName); }
    if (typeof assertInside === 'function') assertInside(root, candidate, '项目路径');
    else {
      const relative = path.relative(path.resolve(root), candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('项目路径无效');
    }
    return candidate;
  };
  const captureIdentity = async candidate => {
    if (typeof capturePathIdentity === 'function') return Promise.resolve(capturePathIdentity(candidate));
    const stat = await fs.promises.stat(candidate, { bigint: true });
    return { path: path.resolve(candidate), device: String(stat.dev), inode: String(stat.ino), directory: stat.isDirectory(), size: String(stat.size), modifiedNs: String(stat.mtimeNs) };
  };
  const identityMatches = async (candidate, expected) => {
    if (typeof samePathIdentity === 'function') return samePathIdentity(candidate, expected);
    const current = await captureIdentity(candidate).catch(() => null);
    return Boolean(current && expected && current.device === expected.device && current.inode === expected.inode && current.directory === expected.directory);
  };
  const removeIfOwned = async (candidate, ownership) => {
    if (!candidate || !ownership?.created || !fs.existsSync(candidate)) return false;
    if (!await identityMatches(candidate, ownership.identity)) return false;
    const quarantine = path.join(path.dirname(candidate), `.photoflow-cleanup-${crypto.randomUUID()}`);
    await publishPathNoClobber(candidate, quarantine);
    if (!await identityMatches(quarantine, ownership.identity)) {
      throw Object.assign(new Error('清理目标在隔离时已被替换，内容已保留等待恢复'), { code: 'CLEANUP_IDENTITY_MISMATCH', recoveryPath: quarantine });
    }
    await fs.promises.rm(quarantine, { recursive: true, force: true });
    return true;
  };
  const refreshAfterRepositoryCommit = async root => {
    try { return { catalog: await refreshWorkspaceCatalog(root), catalogRefreshPending: false }; }
    catch (error) {
      writeLog('warn', 'Workspace mutation committed but catalog refresh failed', { root, error: error.message || String(error) });
      if (typeof reconcileWorkspaceCatalog === 'function') {
        setTimeout(() => Promise.resolve(reconcileWorkspaceCatalog(root)).catch(reconcileError => writeLog('warn', 'Deferred workspace catalog reconcile failed', reconcileError)), 0);
      }
      return { catalog: workspaceCatalogs.get(root), catalogRefreshPending: true, warning: '项目操作已完成，目录刷新将在后台重试' };
    }
  };
  const scheduleCatalogReconcile = root => {
    if (typeof reconcileWorkspaceCatalog !== 'function') return;
    setTimeout(() => Promise.resolve(reconcileWorkspaceCatalog(root)).catch(error => writeLog('warn', 'Deferred workspace catalog reconcile failed', error)), 0);
  };
  const notifyProjectsChanged = (root, reason) => {
    try { mainWindow?.webContents.send('workspace-projects-changed', { root, reason }); }
    catch (error) { writeLog('warn', 'Unable to publish committed workspace project change', { root, reason, error: error.message || String(error) }); }
  };
  const probeProjectMutation = async (root, projectName, predicate) => {
    try {
      const catalog = await refreshWorkspaceCatalog(root);
      const row = catalog?.byName?.get(projectName.toLocaleLowerCase()) || catalog?.projects?.find(project => project.name?.toLocaleLowerCase() === projectName.toLocaleLowerCase());
      return { state: row && predicate(row) ? 'committed' : 'not-committed', catalog, row };
    } catch (error) {
      scheduleCatalogReconcile(root);
      return { state: 'unknown', error };
    }
  };
  const mutationOutcomeUnknownError = cause => Object.assign(new Error(`项目操作结果暂时无法确认，请勿重复执行；后台正在核对目录。${cause?.message ? ` ${cause.message}` : ''}`), {
    code: 'WORKSPACE_MUTATION_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true, cause,
  });
  const recoveryErrorFields = [
    'code', 'recoveryPath', 'outcomeUnknown', 'published', 'originalMissing', 'sourceRetained', 'cleanupWarning',
    'recoveryRequired', 'partial', 'identityVerified', 'deleted', 'rollbackPending', 'nativeError', 'transferStage',
    'stagingExists', 'targetExists', 'recoveryAvailable', 'attemptedStagingPath', 'publicationState', 'publishedConfirmed', 'phase',
  ];
  const recoveryDescriptor = (error, label) => {
    const descriptor = { label, error: error?.message || String(error || '未知错误') };
    for (const field of recoveryErrorFields) if (error?.[field] !== undefined) descriptor[field] = error[field];
    return descriptor;
  };
  const mergeRecoveryError = (primary, secondary, label) => {
    if (!Array.isArray(primary.recoveries)) primary.recoveries = [recoveryDescriptor(primary, '主恢复')];
    const detail = secondary?.message || String(secondary || '未知错误');
    primary.cleanupWarning = [primary.cleanupWarning, `${label}：${detail}`].filter(Boolean).join('；');
    const secondaryRecovery = recoveryDescriptor(secondary, label);
    primary.recoveries.push(secondaryRecovery);
    primary.rollbackRecovery = secondaryRecovery;
    return primary;
  };
  const terminalRecoveryResult = error => Boolean(
    error?.outcomeUnknown || error?.recoveryPath || error?.published === true || error?.deleted === true
    || error?.partial === true || error?.recoveryRequired === true || error?.rollbackPending === true
    || error?.recoveries?.some(recovery => recovery.outcomeUnknown || recovery.recoveryPath || recovery.published === true
      || recovery.deleted === true || recovery.partial === true || recovery.recoveryRequired === true || recovery.rollbackPending === true),
  );
  const serializeUndoRecoveryError = error => {
    const baseMessage = error?.message || String(error);
    const hints = [];
    if (error?.outcomeUnknown) hints.push('恢复结果待确认，请勿重复执行此操作');
    if (error?.recoveryPath) hints.push(`可恢复内容位于：${error.recoveryPath}`);
    if (error?.cleanupWarning) hints.push(`清理提示：${error.cleanupWarning}`);
    for (const recovery of error?.recoveries || []) {
      if (recovery.recoveryPath && recovery.recoveryPath !== error?.recoveryPath) hints.push(`${recovery.label || '恢复步骤'}位置：${recovery.recoveryPath}`);
    }
    const response = { success: false, error: [baseMessage, ...hints].filter(Boolean).join('；') };
    for (const field of recoveryErrorFields) if (error?.[field] !== undefined) response[field] = error[field];
    if (error?.rollbackRecovery) response.rollbackRecovery = error.rollbackRecovery;
    if (Array.isArray(error?.recoveries)) response.recoveries = error.recoveries;
    if (error?.code !== undefined) response.errorCode = error.code;
    return response;
  };
  const restoreDecisionTokens = new Map();
  const legacyRestoreDecisions = new WeakMap();
  const blockedPersistentUndos = new Map();
  const persistentUndoClaimPrefix = '.photoflow-undo-claim-';
  const persistentUndoClaimSchema = 1;
  const blockedPersistentUndoTtlMs = Math.max(1, Number(context.persistentUndoQuarantineTtlMs) || 30 * 60 * 1000);
  const blockedPersistentUndoCapacity = Math.max(1, Number(context.persistentUndoQuarantineCapacity) || 256);
  const persistentUndoClaimPlatform = context.platform || process.platform;
  let persistentUndoQuarantineOverflow = false;
  const persistentUndoKey = (workspaceRoot, persistentId) => `${comparablePath(path.resolve(String(workspaceRoot || '')))}\0${String(persistentId || '')}`;
  const persistentUndoClaimDescriptor = async operation => {
    const persistentId = typeof operation?.persistentId === 'string' ? operation.persistentId : '';
    if (!persistentId || persistentId.length > 256 || persistentId.trim() !== persistentId || /[\0\r\n]/.test(persistentId)) {
      throw Object.assign(new Error('持久撤销记录 ID 无效，已拒绝执行'), { code: 'CLAIM_PERSIST_FAILED', recoveryRequired: true, rollbackPending: true });
    }
    let workspaceRoot;
    try { workspaceRoot = await fs.promises.realpath(path.resolve(String(operation.workspaceRoot || ''))); }
    catch (cause) {
      throw Object.assign(new Error(`无法确认持久撤销工作区，已拒绝执行：${cause?.message || String(cause)}`), {
        code: 'CLAIM_PERSIST_FAILED', recoveryRequired: true, rollbackPending: true, cause,
      });
    }
    const digest = crypto.createHash('sha256').update(`${comparablePath(workspaceRoot)}\0${persistentId}`).digest('hex');
    return { workspaceRoot, persistentId, path: path.join(workspaceRoot, `${persistentUndoClaimPrefix}${digest}.json`) };
  };
  const persistentUndoClaimExists = async descriptor => {
    try { await fs.promises.lstat(descriptor.path); return true; }
    catch (cause) {
      if (cause?.code === 'ENOENT') return false;
      throw Object.assign(new Error(`无法确认持久撤销 claim 状态，已拒绝执行：${cause?.message || String(cause)}`), {
        code: 'CLAIM_PERSIST_FAILED', recoveryRequired: true, rollbackPending: true, cause,
      });
    }
  };
  const syncPersistentUndoClaimDirectory = async directory => {
    if (persistentUndoClaimPlatform === 'win32') return;
    let handle;
    try { handle = await fs.promises.open(directory, 'r'); await handle.sync(); }
    finally { await handle?.close().catch(() => undefined); }
  };
  const createPersistentUndoClaim = async (operation, descriptor) => {
    const nonce = crypto.randomUUID();
    const marker = { schema: persistentUndoClaimSchema, id: descriptor.persistentId, kind: operation.kind, createdAt: new Date().toISOString(), nonce };
    let handle;
    let opened = false;
    try {
      handle = await fs.promises.open(descriptor.path, 'wx', 0o600);
      opened = true;
      await handle.writeFile(`${JSON.stringify(marker)}\n`, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = null;
      await syncPersistentUndoClaimDirectory(descriptor.workspaceRoot);
      return { ...descriptor, nonce };
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      const exists = cause?.code === 'EEXIST';
      const error = Object.assign(new Error(exists
        ? '该持久撤销记录已被其他进程认领，当前进程不会再次恢复'
        : `无法持久认领撤销记录，已拒绝执行：${cause?.message || String(cause)}`), {
        code: exists ? 'PERSISTENT_UNDO_RECOVERY_PENDING' : 'CLAIM_PERSIST_FAILED',
        recoveryRequired: true, rollbackPending: true, cause, claimExists: exists || opened,
      });
      throw error;
    }
  };
  const pruneBlockedPersistentUndos = () => {
    const now = Date.now();
    for (const [key, entry] of blockedPersistentUndos) if (entry.markedUnavailable && entry.expiresAt <= now) blockedPersistentUndos.delete(key);
    while (blockedPersistentUndos.size > blockedPersistentUndoCapacity) {
      const removable = [...blockedPersistentUndos.entries()].find(([, entry]) => entry.markedUnavailable);
      if (!removable) { persistentUndoQuarantineOverflow = true; break; }
      blockedPersistentUndos.delete(removable[0]);
    }
  };
  const blockPersistentUndo = (operation, error) => {
    if (!operation?.persistentId || !operation?.workspaceRoot) return null;
    pruneBlockedPersistentUndos();
    const key = persistentUndoKey(operation.workspaceRoot, operation.persistentId);
    let entry = blockedPersistentUndos.get(key);
    if (!entry) {
      const unpersistedCount = [...blockedPersistentUndos.values()].filter(candidate => !candidate.markedUnavailable).length;
      if (unpersistedCount >= blockedPersistentUndoCapacity) {
        persistentUndoQuarantineOverflow = true;
        return { key, operation, error, markedUnavailable: false, overflow: true, expiresAt: Number.POSITIVE_INFINITY };
      }
      entry = { key, operation, error, markedUnavailable: false };
    }
    entry.error = error;
    entry.expiresAt = entry.markedUnavailable ? Date.now() + blockedPersistentUndoTtlMs : Number.POSITIVE_INFINITY;
    blockedPersistentUndos.set(key, entry);
    return entry;
  };
  const retryMarkPersistentUndoUnavailable = async entry => {
    if (!entry || entry.markedUnavailable) return true;
    let lastError;
    for (const delay of [0, 25, 75]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await workspaceRepository.markUndoRecordUnavailable(entry.operation.workspaceRoot, entry.operation.persistentId);
        entry.markedUnavailable = true;
        const workspaceRoot = entry.operation.workspaceRoot;
        const persistentId = entry.operation.persistentId;
        entry.operation = { workspaceRoot, persistentId };
        entry.error = Object.assign(new Error('该持久撤销记录已标记为不可用，不能再次执行'), { code: 'UNDO_RECORD_UNAVAILABLE', recoveryRequired: true });
        entry.expiresAt = Date.now() + blockedPersistentUndoTtlMs;
        if (entry.key) blockedPersistentUndos.set(entry.key, entry);
        pruneBlockedPersistentUndos();
        return true;
      } catch (error) { lastError = error; }
    }
    const warning = `无法持久标记撤销记录为不可用：${lastError?.message || String(lastError)}`;
    if (!String(entry.error.cleanupWarning || '').includes(warning)) entry.error.cleanupWarning = [entry.error.cleanupWarning, warning].filter(Boolean).join('；');
    entry.expiresAt = Number.POSITIVE_INFINITY;
    return false;
  };
  const decisionTtlMs = 10 * 60 * 1000;
  const pruneRestoreDecisionTokens = () => {
    const now = Date.now();
    for (const [token, decision] of restoreDecisionTokens) if (decision.expiresAt <= now) restoreDecisionTokens.delete(token);
    while (restoreDecisionTokens.size > 64) restoreDecisionTokens.delete(restoreDecisionTokens.keys().next().value);
  };
  const pathIsInside = (root, candidate) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const deferredInterruptedTrimTasks = [];
  for (const task of backgroundTasks?.list?.() || []) {
    if (task.type !== 'video-trim' || task.state !== 'interrupted') continue;
    const generatedPath = String(task.metadata?.generatedPath || '');
    const sourcePath = String(task.metadata?.sourcePath || '');
    if (!generatedPath || !sourcePath || comparablePath(generatedPath) === comparablePath(sourcePath)) continue;
    const generated = path.resolve(generatedPath);
    const source = path.resolve(sourcePath);
    const generatedName = path.basename(generated);
    const sourceParts = path.parse(source);
    const saveMode = task.metadata?.saveMode === 'replace' ? 'replace' : 'new';
    let projectRoot = '';
    try {
      projectRoot = path.resolve(getProjectPath(task.metadata?.workspacePath, task.metadata?.projectStatus, task.metadata?.projectName));
    } catch { deferredInterruptedTrimTasks.push(task); /* retry only after this workspace catalog is loaded */ }
    const validLocation = comparablePath(path.dirname(generated)) === comparablePath(path.dirname(source))
      || Boolean(projectRoot && pathIsInside(projectRoot, generated));
    const validName = path.extname(generated).toLocaleLowerCase() === sourceParts.ext.toLocaleLowerCase()
      && (saveMode === 'replace' ? generatedName.startsWith('.photoflow-trim-output-') : path.parse(generatedName).name.startsWith(`${sourceParts.name}_剪辑`));
    if (!validLocation || !validName) {
      writeLog('warn', 'Skipped unsafe interrupted video trim cleanup path', { generatedPath: generated, sourcePath: source, taskId: task.id });
      continue;
    }
    void (async () => {
      const identity = await captureIdentity(generated);
      if (!await identityMatches(generated, identity)) throw new Error('中断的视频输出在清理前已被替换');
      await fs.promises.rm(generated, { force: true });
    })().catch(error => writeLog('warn', 'Unable to clean interrupted video trim output', { generatedPath, error: error.message || String(error) }));
  }
  const retryDeferredInterruptedTrimCleanup = async workspaceRoot => {
    for (let index = deferredInterruptedTrimTasks.length - 1; index >= 0; index -= 1) {
      const task = deferredInterruptedTrimTasks[index];
      if (comparablePath(task.metadata?.workspacePath || '') !== comparablePath(workspaceRoot)) continue;
      let projectRoot;
      try { projectRoot = path.resolve(getProjectPath(task.metadata.workspacePath, task.metadata.projectStatus, task.metadata.projectName)); }
      catch { continue; }
      const generated = path.resolve(String(task.metadata?.generatedPath || ''));
      const source = path.resolve(String(task.metadata?.sourcePath || ''));
      const validLocation = comparablePath(path.dirname(generated)) === comparablePath(path.dirname(source)) || pathIsInside(projectRoot, generated);
      if (!validLocation || !fs.existsSync(generated)) { deferredInterruptedTrimTasks.splice(index, 1); continue; }
      try {
        const identity = await captureIdentity(generated);
        if (!await identityMatches(generated, identity)) throw new Error('中断的视频输出在延迟清理前已被替换');
        await fs.promises.rm(generated, { force: true });
        deferredInterruptedTrimTasks.splice(index, 1);
      } catch (error) { writeLog('warn', 'Unable to clean deferred interrupted video trim output', { generatedPath: generated, error: error.message || String(error) }); }
    }
  };
  const virtualPaths = projectVirtualPaths || (shell?.readShortcutLink ? createProjectVirtualPathService({ shell }) : {
    resolve: (root, relativePath) => {
      const physicalPath = assertInside(root, path.resolve(root, relativePath || '.'), '项目路径', true);
      if (!fs.existsSync(physicalPath)) throw new Error('文件或文件夹不存在');
      return { projectRoot: root, virtualPath: String(relativePath || '').replace(/\\/g, '/'), physicalPath, mediaRoot: root, viaExternalLink: false, isExternalLinkRoot: false };
    },
    listManagedExternalLinks: () => [],
  });
  const shortcutSourceChannel = shortcutPath => {
    if (!shell?.readShortcutLink) return undefined;
    try {
      const description = String(shell.readShortcutLink(shortcutPath)?.description || '').trim();
      return description.startsWith('灵感库：') ? 'inspiration' : undefined;
    } catch { return undefined; }
  };
  const resolveToolSource = (rootValue, relativePath) => {
    const root = path.resolve(rootValue);
    try {
      return virtualPaths.resolve(root, relativePath, { externalRootMode: 'target' });
    } catch (managedError) {
      const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const segments = normalized ? normalized.split('/') : [];
      if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) throw managedError;
      const shortcutIndex = segments.findIndex(segment => path.extname(segment).toLowerCase() === '.lnk');
      if (shortcutIndex < 0) throw managedError;
      const shortcutVirtualPath = segments.slice(0, shortcutIndex + 1).join('/');
      const shortcutPath = assertExistingInside(root, path.resolve(root, ...segments.slice(0, shortcutIndex + 1)), '灵感库快捷方式');
      if (shortcutSourceChannel(shortcutPath) !== 'inspiration') throw managedError;
      const details = shell.readShortcutLink(shortcutPath);
      const target = details?.target ? path.resolve(String(details.target)) : '';
      if (!target || !fs.existsSync(target)) throw Object.assign(new Error('灵感库快捷方式目标当前不可用'), { code: 'EXTERNAL_LINK_OFFLINE' });
      const targetStat = fs.statSync(target);
      const childSegments = segments.slice(shortcutIndex + 1);
      if (targetStat.isFile()) {
        if (childSegments.length) throw new Error('灵感库文件快捷方式不能包含子路径');
        const physicalPath = fs.realpathSync(target);
        return {
          projectRoot: root, virtualPath: normalized, physicalPath, mediaRoot: path.dirname(physicalPath),
          shortcutPath, shortcutVirtualPath, externalTargetRoot: physicalPath, externalTargetKind: 'file',
          externalDisplayName: path.basename(shortcutPath, path.extname(shortcutPath)), viaExternalLink: true,
          viaInspirationShortcut: true, isExternalLinkRoot: true, writable: true, offline: false,
        };
      }
      if (!targetStat.isDirectory()) throw new Error('灵感库快捷方式目标类型不受支持');
      const externalTargetRoot = fs.realpathSync(target);
      const requestedPath = assertInside(externalTargetRoot, path.resolve(externalTargetRoot, ...childSegments), '灵感库快捷方式内容', true);
      if (!fs.existsSync(requestedPath)) throw Object.assign(new Error('灵感库快捷方式中的文件或文件夹不存在'), { code: 'ENOENT' });
      const physicalPath = fs.realpathSync(requestedPath);
      assertInside(externalTargetRoot, physicalPath, '灵感库快捷方式内容', true);
      return {
        projectRoot: root, virtualPath: normalized, physicalPath, mediaRoot: externalTargetRoot,
        shortcutPath, shortcutVirtualPath, externalTargetRoot, externalTargetKind: 'folder',
        externalDisplayName: path.basename(shortcutPath, path.extname(shortcutPath)), viaExternalLink: true,
        viaInspirationShortcut: true, isExternalLinkRoot: childSegments.length === 0, writable: true, offline: false,
      };
    }
  };
  const notifyComponentArtifactRelocation = async () => [];
  const { selectWorkspaceForWrite } = createWorkspaceStoragePolicy({ fs, path, ensureWorkspace });
  const { acknowledgeImportReceipt, commitImportManifest, importStagingRoots, readImportReceipt, receiptLocationsForSession } = createImportReceiptService({ crypto, fs, path, pathExists, versionService });
  const isValidProjectStatus = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 24 && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const availableProjectStatuses = catalog => {
    const values = [...WORKSPACE_STATUSES, ...((catalog?.projects || []).map(project => project.status))];
    const seen = new Set();
    return values.filter(status => {
      if (!isValidProjectStatus(status)) return false;
      const key = status.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const isInternalFileOperationEntry = isInternalWorkspacePathSegment;
  const officeOpenXmlExtensions = new Set([
    '.docx', '.docm', '.dotx', '.dotm',
    '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppam',
    '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlam', '.xlsb',
  ]);
  const screenshotMainImageExtensions = new Set(['.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
  const missingProjectRetentionMs = 30 * 24 * 60 * 60 * 1000;
  const recentFilesSessionExpiredCode = 'RECENT_FILES_SESSION_EXPIRED';
  const recentFileSessions = new Map();
  const activeVideoTrimOperations = new Map();
  const fileListSessionExpiredCode = 'FILE_LIST_SESSION_EXPIRED';
  const fileListCancelledCode = 'FILE_LIST_CANCELLED';
  const fileListSessions = new Map();
  const fileListCursorLocks = new Map();
  const recentCursorLocks = new Map();
  const cancelledFileListCursors = new Map();
  const progressImportConflictCache = new Map();
  const workspaceMaintenanceScheduledAt = new Map();
  const workspaceMaintenanceCooldownMs = 24 * 60 * 60 * 1000;
  const acquireCursorLock = async (locks, cursor) => {
    if (!cursor) return () => undefined;
    const previous = locks.get(cursor);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    locks.set(cursor, gate);
    if (previous) await previous;
    return () => { release(); if (locks.get(cursor) === gate) locks.delete(cursor); };
  };
  const watchedProjectFileRoots = new Map();
  const watchedProjectFileRootHealth = new Map();
  const watchedProjectFileRootKey = (workspaceRoot, status, projectName) => `${process.platform === 'win32' ? path.resolve(workspaceRoot).toLocaleLowerCase() : path.resolve(workspaceRoot)}\0${String(status)}\0${process.platform === 'win32' ? String(projectName).toLocaleLowerCase() : String(projectName)}`;
  const externalTrackingChangeHandler = (publishRoot, projectName) => entries => scheduleMediaTrackingScan(
    publishRoot,
    projectName,
    entries.map(entry => ({
      path: entry.sourcePath || path.join(publishRoot, entry.fileName), eventType: entry.eventType,
      kind: entry.kind, observedMtimeMs: entry.observedMtimeMs, observedSize: entry.observedSize,
    })),
  );
  const { attach: attachManagedExternalWatcher, detach: detachManagedExternalWatcher } = createManagedExternalWatcherBindings({ fs, path, ensureWorkspace, getProjectPath, watchedProjectFileRoots, watchedProjectFileRootKey, acquireFileRootWatcher, releaseFileRootWatcher, externalTrackingChangeHandler, writeLog });
  const transientRenameErrorCodes = new Set(['EACCES', 'EBUSY', 'EPERM']);
  const renamePathWithRetry = async (source, destination) => {
    const retryDelays = [0, 80, 180, 360, 700];
    let lastError;
    for (const delay of retryDelays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await fs.promises.rename(source, destination);
        return;
      } catch (error) {
        lastError = error;
        if (!transientRenameErrorCodes.has(error?.code)) throw error;
      }
    }
    throw lastError;
  };
  const pruneRecentFileSessions = () => {
    const expiry = Date.now() - 10 * 60 * 1000;
    for (const [cursor, session] of recentFileSessions) {
      if (session.touchedAt < expiry) recentFileSessions.delete(cursor);
    }
  };
  const pruneFileListSessions = () => {
    const expiry = Date.now() - 10 * 60 * 1000;
    for (const [cursor, session] of fileListSessions) {
      if (session.touchedAt < expiry) fileListSessions.delete(cursor);
    }
    for (const [cursor, cancelledAt] of cancelledFileListCursors) {
      if (cancelledAt < expiry) cancelledFileListCursors.delete(cursor);
    }
  };
  const pruneProgressImportConflictCache = () => {
    const now = Date.now();
    for (const [key, entry] of progressImportConflictCache) {
      if (entry.expiresAt <= now) progressImportConflictCache.delete(key);
    }
    while (progressImportConflictCache.size > 32) progressImportConflictCache.delete(progressImportConflictCache.keys().next().value);
  };

  const { inspectDeletedProject, purgeConfirmedDeletedProject, purgeStaleMissingProject, queuePermanentProjectCleanup } = createDeletedProjectCleanup({
    backgroundTasks, fs, getWorkspaceDataRoot, path, pathExists, recycleBinService,
    renameHistory, setTimeout, thumbnailService, workspaceRepository, writeLog,
  });

  const queueWorkspaceMaintenance = root => {
    if (!workspaceMaintenanceRepository?.runMaintenance) return;
    const now = Date.now();
    if (now - (workspaceMaintenanceScheduledAt.get(root) || 0) < workspaceMaintenanceCooldownMs) return;
    workspaceMaintenanceScheduledAt.set(root, now);
    const run = () => backgroundTasks.run({
      type: 'workspace-database-maintenance',
      title: '维护项目数据库',
      dedupeKey: `workspace-database-maintenance:${root}`,
      cancellable: false,
      resources: [workspaceDatabaseTaskResource(root)],
      metadata: { root },
    }, async task => {
      task.report(10, '正在检查项目数据库');
      const result = await runWorkspaceMaintenanceWithRetry({ root, repository: workspaceMaintenanceRepository, task });
      task.report(100, '项目数据库维护完成');
      return result;
    }, run);
    setTimeout(() => {
      void run().catch(error => writeLog('warn', 'Workspace database maintenance deferred', {
        root,
        error: error.message || String(error),
      }));
    }, 15000);
  };

  const existingProjectInspectionCache = new Map();
  const cacheExistingProjectInspection = inspection => {
    const token = crypto.randomUUID();
    const now = Date.now();
    for (const [key, value] of existingProjectInspectionCache) {
      if (value.expiresAt <= now || existingProjectInspectionCache.size >= 32) existingProjectInspectionCache.delete(key);
    }
    existingProjectInspectionCache.set(token, { inspection, expiresAt: now + 10 * 60 * 1000 });
    return token;
  };
  const cachedExistingProjectInspection = async (token, sourcePath) => {
    const cached = existingProjectInspectionCache.get(String(token || ''));
    if (!cached || cached.expiresAt <= Date.now()) return null;
    const requestedSource = path.resolve(sourcePath);
    if (comparablePath(cached.inspection.sourcePath) !== comparablePath(requestedSource)) return null;
    const sourceStat = await fs.promises.stat(requestedSource).catch(() => null);
    if (!sourceStat?.isDirectory()) return null;
    existingProjectInspectionCache.delete(String(token));
    return cached.inspection;
  };

  ipcMain.handle('workspace-cleanup-deleted-projects', async (_event, workspacePath) => {
    try {
      const root = ensureWorkspace(workspacePath);
      await reconcileWorkspaceCatalog(root);
      const result = await workspaceRepository.listDeletedProjects(root);
      const deletedProjects = result.projects || [];
      const probeBatch = await recycleBinService.probeMany(deletedProjects.filter(project => !project.permanent && project.recyclePidl).map(project => project.recyclePidl));
      const probesByPidl = new Map((probeBatch.items || []).map(item => [item.pidl, item]));
      const outcomes = [];
      for (const project of deletedProjects) outcomes.push({ projectId: project.id, name: project.name, ...await purgeConfirmedDeletedProject(root, project, probesByPidl.get(project.recyclePidl)) });
      const staleMissing = await workspaceRepository.listMissingProjects(root, Date.now() - missingProjectRetentionMs);
      for (const project of staleMissing.projects || []) outcomes.push({ projectId: project.id, name: project.name, ...await purgeStaleMissingProject(root, project) });
      const cleanedCount = outcomes.filter(outcome => outcome.cleaned).length;
      const deferredCount = outcomes.filter(outcome => outcome.status === 'deferred').length;
      if (cleanedCount) await refreshWorkspaceCatalog(root);
      return { success: true, checkedCount: outcomes.length, cleanedCount, deferredCount, outcomes, ...(deferredCount ? { warning: `${deferredCount} 个长期离线项目已安全延迟清理，等待只读清理计划支持` } : {}) };
    } catch (error) {
      writeLog('error', 'Unable to clean deleted project data', error);
      return { success: false, checkedCount: 0, cleanedCount: 0, outcomes: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-projects', async (_event, workspacePath) => {
    try {
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      await retryDeferredInterruptedTrimCleanup(root);
      watchWorkspace(root);
      void reconcileWorkspaceCatalog(root).catch(error => {
        writeLog('warn', 'Unable to reconcile workspace catalog after project-list read', { root, error: error.message || String(error) });
      });
      queueWorkspaceMaintenance(root);
      const statuses = availableProjectStatuses(catalog).map(status => {
        const onlineProjects = catalog.projects.filter(project => project.status === status && project.availability !== 'missing');
        const offlineArchivedProjects = catalog.projects.filter(project => {
          if (project.status !== status || project.availability !== 'missing') return false;
          try { return Boolean(JSON.parse(project.extra_json || '{}')?.archive?.path); }
          catch { return false; }
        });
        const projects = [...onlineProjects, ...offlineArchivedProjects]
          .map(project => {
            const projectPath = path.resolve(root, project.relative_path);
            let archive = null;
            try { archive = JSON.parse(project.extra_json || '{}')?.archive || null; } catch { /* malformed optional metadata is ignored */ }
            return {
              id: project.id,
              name: project.name,
              path: projectPath,
              status,
              updatedAt: fs.existsSync(projectPath) ? fs.statSync(projectPath).mtimeMs : project.updated_at,
              projectDate: readProjectDate(project),
              availability: project.availability || 'available',
              missingSince: project.missing_since || undefined,
              missingChecks: project.missing_checks || 0,
              archived: Boolean(archive?.path),
              archivePath: archive?.path || undefined,
              archiveVerifiedAt: archive?.verifiedAt || undefined,
              archiveBytes: archive?.bytes || undefined,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        return { status, projects };
      });
      return { success: true, root, statuses };
    } catch (error) {
      writeLog('error', 'Unable to load workspace projects', error);
      return { success: false, error: String(error), statuses: [] };
    }
  });
  
  ipcMain.handle('workspace-create-project', async (_event, workspacePath, date, name, options) => {
    let projectPath = '';
    let projectOwnership = null;
    let repositoryCommitted = false;
    try {
      const projectDate = normalizeProjectDate(date);
      const datePart = formatProjectDate(projectDate);
      const namePart = cleanProjectName(name || '');
      const projectName = [datePart, namePart].filter(Boolean).join(' ');
      if (!projectName) throw new Error('请至少填写日期或名称');
      const selectedWorkspace = await selectWorkspaceForWrite(workspacePath, options?.workspacePaths, 0);
      const root = selectedWorkspace.root;
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      if (catalog.byName.has(projectName.toLocaleLowerCase())) throw new Error('同名项目已存在');
      projectPath = plannedProjectPath(root, projectName);
      if (fs.existsSync(projectPath)) throw new Error('同名项目已存在');
      fs.mkdirSync(projectPath, { recursive: false });
      try { projectOwnership = { created: true, identity: await captureIdentity(projectPath) }; }
      catch (error) { throw Object.assign(new Error(`项目目录已创建但无法确认身份，请勿重试；恢复路径：${projectPath}`), { code: 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true, recoveryPath: projectPath }); }
      if (options?.createPlanningFolder !== false) fs.mkdirSync(path.join(projectPath, '策划'), { recursive: true });
      const addPayload = { name: projectName, status: '策划中', relativePath: path.relative(root, projectPath), extra: projectDate ? { projectDate } : {} };
      let mutation;
      const repositoryMutationAvailable = typeof workspaceRepository?.addProject === 'function';
      try {
        mutation = repositoryMutationAvailable
          ? await workspaceRepository.addProject(root, addPayload)
          : await mutateWorkspaceCatalog(root, 'addProject', addPayload);
      } catch (error) {
        const probe = await probeProjectMutation(root, projectName, row => row.status === '策划中' && path.normalize(row.relative_path || row.relativePath || projectName) === path.normalize(path.relative(root, projectPath)));
        if (probe.state === 'committed') mutation = probe.row;
        else if (probe.state === 'unknown') { repositoryCommitted = true; throw mutationOutcomeUnknownError(error); }
        else throw error;
      }
      repositoryCommitted = true;
      const refreshed = repositoryMutationAvailable ? await refreshAfterRepositoryCommit(root) : { catalog: mutation, catalogRefreshPending: false };
      const projectId = refreshed.catalog?.byName?.get(projectName.toLocaleLowerCase())?.id || mutation?.byName?.get?.(projectName.toLocaleLowerCase())?.id || mutation?.project?.id || mutation?.id;
      if (refreshed.catalogRefreshPending || !projectId) {
        scheduleCatalogReconcile(root);
        notifyProjectsChanged(root, 'project-create-catalog-pending');
        return { success: false, committed: true, catalogRefreshPending: true, errorCode: 'WORKSPACE_CATALOG_REFRESH_PENDING', error: '项目已创建，目录正在刷新；请勿重复创建，稍后从项目列表打开。', warning: refreshed.warning };
      }
      writeLog('info', 'Project created', { projectName, projectPath });
      telemetryService?.track('project_created', { planning_folder: options?.createPlanningFolder !== false });
      return { success: true, workspacePath: root, storageSwitched: selectedWorkspace.switched, project: { id: projectId, name: projectName, path: projectPath, workspacePath: root, status: '策划中', updatedAt: Date.now(), projectDate: projectDate || undefined }, catalogRefreshPending: false };
    } catch (error) {
      if (!repositoryCommitted) await removeIfOwned(projectPath, projectOwnership).catch(cleanupError => writeLog('warn', 'Unable to clean failed project creation', cleanupError));
      return { success: false, error: error.message || String(error), errorCode: error?.code || undefined, outcomeUnknown: Boolean(error?.outcomeUnknown), catalogReconcilePending: Boolean(error?.catalogReconcilePending) };
    }
  });

  const inspectExistingProject = async sourcePath => {
    const source = path.resolve(sourcePath);
    const sourceStat = await fs.promises.stat(source);
    if (!sourceStat.isDirectory()) throw new Error('请选择一个项目文件夹');
    const topLevel = new Map();
    const queue = [{ directory: source, topLevelName: '' }];
    let fileCount = 0;
    let folderCount = 0;
    let totalBytes = 0;
    let truncated = false;
    while (queue.length) {
      const current = queue.shift();
      const entries = await fs.promises.readdir(current.directory, { withFileTypes: true });
      const filesToStat = [];
      for (const entry of entries) {
        if (fileCount + folderCount >= 100000) { truncated = true; queue.length = 0; break; }
        const entryPath = path.join(current.directory, entry.name);
        const topLevelName = current.topLevelName || entry.name;
        if (entry.isDirectory()) {
          folderCount += 1;
          if (!current.topLevelName) topLevel.set(entry.name, { relativePath: entry.name, name: entry.name, imageCount: 0, rawCount: 0, videoCount: 0, fileCount: 0 });
          queue.push({ directory: entryPath, topLevelName });
          continue;
        }
        if (!entry.isFile()) continue;
        fileCount += 1;
        filesToStat.push(entryPath);
        const candidate = topLevel.get(topLevelName);
        if (!candidate) continue;
        candidate.fileCount += 1;
        const extension = path.extname(entry.name).toLowerCase();
        if (RAW_EXTENSIONS.has(extension)) candidate.rawCount += 1;
        else if (IMAGE_EXTENSIONS.has(extension)) candidate.imageCount += 1;
        else if (VIDEO_EXTENSIONS.has(extension)) candidate.videoCount += 1;
      }
      let nextFileIndex = 0;
      await Promise.all(Array.from({ length: Math.min(16, filesToStat.length) }, async () => {
        while (nextFileIndex < filesToStat.length) {
          const entryPath = filesToStat[nextFileIndex++];
          const stat = await fs.promises.stat(entryPath);
          totalBytes += stat.size;
        }
      }));
    }
    const baselinePattern = /(raw|jpg|原片|原图|底片|选片|素材|original)/iu;
    const progressPattern = /(修图|后期|精修|调色|成片|交付|final|版本|\bv\s*\d+)/iu;
    const mediaCandidates = [...topLevel.values()].filter(item => item.imageCount + item.rawCount + item.videoCount > 0);
    const hasRawCandidate = mediaCandidates.some(item => item.rawCount > 0);
    const candidates = mediaCandidates.filter(item => !(hasRawCandidate && /^(jpg|jpeg|preview|previews|proxy|预览|代理)$/iu.test(item.name) && item.rawCount === 0)).map(item => ({
      ...item,
      mediaKind: item.videoCount > item.imageCount + item.rawCount ? 'video' : 'image',
      suggestedRole: baselinePattern.test(item.name) ? 'baseline' : progressPattern.test(item.name) ? 'progress' : 'progress',
    })).sort((left, right) => Number(right.suggestedRole === 'baseline') - Number(left.suggestedRole === 'baseline'));
    return { sourcePath: source, name: path.basename(source), fileCount, folderCount, totalBytes, truncated, candidates };
  };

  ipcMain.handle('workspace-choose-existing-project', async () => {
    try {
      const choice = await dialog.showOpenDialog(mainWindow, { title: '选择已有项目文件夹', properties: ['openDirectory'] });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true };
      const inspection = await inspectExistingProject(choice.filePaths[0]);
      return { success: true, ...inspection, inspectionToken: cacheExistingProjectInspection(inspection) };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-inspect-existing-project', async (_event, sourcePath) => {
    try {
      const inspection = await inspectExistingProject(sourcePath);
      return { success: true, ...inspection, inspectionToken: cacheExistingProjectInspection(inspection) };
    }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  const importExistingProjectHandler = async (event, workspacePath, sourcePath, options = {}) => {
    const requestedOperationId = String(options.operationId || '');
    const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedOperationId)
      ? requestedOperationId : crypto.randomUUID();
    if (activeProjectFileOperations.has(operationId)) {
      return { success: false, operationId, error: '该项目接管 operationId 正在执行，请等待原任务完成', duplicateOperation: true };
    }
    const operationReservation = { operation: 'import-project', reserved: true };
    activeProjectFileOperations.set(operationId, operationReservation);
    let task = null;
    let job = { cancelled: false, finishing: false };
    let stagedPath = '';
    let projectPath = '';
    let catalogAdded = false;
    let stagedOwnership = null;
    let stagedOwnershipPromise = null;
    let projectOwnership = null;
    const publish = payload => task?.publish(payload);
    try {
      const mode = String(options.mode || '');
      if (!['copy', 'move'].includes(mode)) throw new Error('导入项目只支持复制并接管或剪切并接管');
      const inspection = await cachedExistingProjectInspection(options.inspectionToken, sourcePath) || await inspectExistingProject(sourcePath);
      const projectName = cleanProjectName(String(options.name || inspection.name || ''));
      if (!projectName) throw new Error('项目名称不能为空');
      const selectedWorkspace = await selectWorkspaceForWrite(workspacePath, options?.workspacePaths, inspection.totalBytes);
      const root = selectedWorkspace.root;
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      if (catalog.byName.has(projectName.toLocaleLowerCase())) throw new Error('同名项目已存在');
      projectPath = plannedProjectPath(root, projectName);
      if (fs.existsSync(projectPath)) throw new Error('同名项目已存在');
      const comparableProjectPath = comparablePath(projectPath);
      const comparableSourcePath = comparablePath(inspection.sourcePath);
      if (comparableProjectPath === comparableSourcePath || comparableProjectPath.startsWith(`${comparableSourcePath}${path.sep}`)) throw new Error('不能把项目导入到它自身内部');
      stagedPath = path.join(path.dirname(projectPath), `.photoflow-import-project-${operationId}`);
      if (fs.existsSync(stagedPath)) throw Object.assign(new Error('该接管任务的暂存路径已存在'), { code: 'EEXIST' });
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-project', title: `接管项目 · ${projectName}`,
        projectName, resources: [inspection.sourcePath, path.dirname(projectPath)], cancelledCode: CANCELLED_CODE,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeProjectFileOperations.set(operationId, job);
      await task.start();
      const plan = [];
      publish({ phase: 'scanning', progress: 0, currentName: '正在扫描已有项目', bytesCopied: 0, totalBytes: inspection.totalBytes, filesCopied: 0, totalFiles: inspection.fileCount });
      await collectCopyPlan(inspection.sourcePath, stagedPath, plan, { isCancelled: () => job.cancelled });
      const totalBytes = plan.reduce((sum, entry) => sum + entry.size, 0);
      const totalFiles = plan.filter(entry => entry.kind === 'file').length;
      await assertDiskSpace(path.dirname(projectPath), totalBytes);
      let bytesCopied = 0;
      let filesCopied = 0;
      let lastPublishedAt = 0;
      const report = (currentName, force = false) => {
        const now = Date.now();
        if (!force && now - lastPublishedAt < 150) return;
        lastPublishedAt = now;
        const progress = totalBytes > 0 ? Math.min(99, Math.round(bytesCopied / totalBytes * 100)) : Math.min(99, Math.round(filesCopied / Math.max(1, totalFiles) * 100));
        publish({ phase: 'copying', progress, currentName, bytesCopied, totalBytes, filesCopied, totalFiles });
      };
      report('', true);
      await copyPlannedFiles(plan, {
        destinationRoot: path.dirname(projectPath), diskSpaceChecked: true, durable: mode === 'move', isCancelled: () => job.cancelled,
        ownershipToken: operationId,
        onCreated: target => {
          if (!stagedOwnershipPromise && comparablePath(target) === comparablePath(stagedPath)) stagedOwnershipPromise = captureIdentity(target);
        },
        onFileStart: entry => report(path.basename(entry.source)),
        onProgress: ({ entry, bytesDelta, fileCompleted }) => { bytesCopied += bytesDelta; if (fileCompleted) filesCopied += 1; report(path.basename(entry.source)); },
      });
      if (stagedOwnershipPromise) stagedOwnership = { created: true, identity: await stagedOwnershipPromise };
      throwIfCancelled(() => job.cancelled);
      const publication = await publishPathNoClobber(stagedPath, projectPath);
      try { projectOwnership = { created: true, identity: publication?.identity || await captureIdentity(projectPath) }; }
      catch (error) { throw Object.assign(new Error(`项目内容已发布，但无法确认身份，请勿重试；恢复路径：${projectPath}`), { code: 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true, recoveryPath: projectPath }); }
      stagedPath = '';
      const addPayload = { name: projectName, status: '策划中', relativePath: path.relative(root, projectPath), extra: { importedAt: Date.now(), importedFrom: inspection.sourcePath } };
      let mutation;
      const repositoryMutationAvailable = typeof workspaceRepository?.addProject === 'function';
      try {
        mutation = repositoryMutationAvailable
          ? await workspaceRepository.addProject(root, addPayload)
          : await mutateWorkspaceCatalog(root, 'addProject', addPayload);
      } catch (error) {
        const probe = await probeProjectMutation(root, projectName, row => row.status === '策划中' && path.normalize(row.relative_path || row.relativePath || projectName) === path.normalize(path.relative(root, projectPath)));
        if (probe.state === 'committed') mutation = probe.row;
        else if (probe.state === 'unknown') { catalogAdded = true; throw mutationOutcomeUnknownError(error); }
        else throw error;
      }
      catalogAdded = true;
      const refreshed = repositoryMutationAvailable ? await refreshAfterRepositoryCommit(root) : { catalog: mutation, catalogRefreshPending: false };
      const projectId = refreshed.catalog?.byName?.get(projectName.toLocaleLowerCase())?.id || mutation?.byName?.get?.(projectName.toLocaleLowerCase())?.id || mutation?.project?.id || mutation?.id;
      if (refreshed.catalogRefreshPending || !projectId) {
        scheduleCatalogReconcile(root);
        await pushUndoOperation({ kind: 'remove-created', paths: [projectPath], label: '导入已有项目' }).catch(() => undefined);
        publish({ phase: 'complete', progress: 100, currentName: '项目已接管，目录正在刷新', bytesCopied: totalBytes, totalBytes, filesCopied: totalFiles, totalFiles });
        task.complete('项目已接管，目录正在刷新');
        notifyProjectsChanged(root, 'project-import-catalog-pending');
        return { success: false, committed: true, operationId, workspacePath: root, catalogRefreshPending: true, errorCode: 'WORKSPACE_CATALOG_REFRESH_PENDING', error: '项目已接管，目录正在刷新；请勿重复导入，稍后从项目列表打开。', warning: refreshed.warning };
      }
      let sourceRetained = false;
      if (mode === 'move') {
        job.finishing = true;
        publish({ phase: 'finishing', progress: 99, currentName: '正在移除已安全复制的源文件', bytesCopied, totalBytes, filesCopied, totalFiles });
        try { await removeCopiedSources(plan, { ownershipToken: operationId }); }
        catch (error) { sourceRetained = true; writeLog('warn', 'Imported project source retained after safe copy', { sourcePath: inspection.sourcePath, error: error.message || String(error) }); }
      }
      const project = { id: projectId, name: projectName, path: projectPath, workspacePath: root, status: '策划中', updatedAt: Date.now() };
      await pushUndoOperation(mode === 'move' && !sourceRetained
        ? { kind: 'external-move', moves: [{ source: inspection.sourcePath, destination: projectPath }] }
        : { kind: 'remove-created', paths: [projectPath], label: '导入已有项目' }).catch(error => writeLog('warn', 'Unable to record imported project undo', error));
      publish({ phase: 'complete', progress: 100, currentName: '项目接管完成', bytesCopied: totalBytes, totalBytes, filesCopied: totalFiles, totalFiles });
      task.complete('项目接管完成');
      notifyProjectsChanged(root, 'project-imported');
      return { success: true, operationId, project, workspacePath: root, storageSwitched: selectedWorkspace.switched, sourceRetained, candidates: inspection.candidates, catalogRefreshPending: false };
    } catch (error) {
      const cancelled = error?.code === CANCELLED_CODE;
      if (!stagedOwnership && stagedOwnershipPromise) stagedOwnership = { created: true, identity: await stagedOwnershipPromise.catch(() => null) };
      if (stagedPath) await removeIfOwned(stagedPath, stagedOwnership).catch(() => undefined);
      if (projectPath && !catalogAdded) await removeIfOwned(projectPath, projectOwnership).catch(() => undefined);
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, currentName: '', error: error.message || String(error) });
      if (cancelled) task?.cancelled(); else task?.fail(error);
      return { success: false, cancelled, operationId, error: cancelled ? '项目接管已取消' : error.message || String(error), errorCode: error?.code || undefined, outcomeUnknown: Boolean(error?.outcomeUnknown), catalogReconcilePending: Boolean(error?.catalogReconcilePending) };
    } finally {
      releaseCleanupOwnership(operationId);
      if (activeProjectFileOperations.get(operationId) === job || activeProjectFileOperations.get(operationId) === operationReservation) activeProjectFileOperations.delete(operationId);
    }
  };
  ipcMain.handle('workspace-import-existing-project', importExistingProjectHandler);
  
  ipcMain.handle('workspace-rename-project', async (_event, workspacePath, status, projectName, dateOrNextName, nextName) => {
    let source = '';
    let destination = '';
    let suspendedWatcherToken = null;
    let renameCompleted = false;
    let repositoryCommitted = false;
    let destinationOwnership = null;
    let warning = '';
    let catalogRefreshPending = false;
    let watchPathsSuppressed = false;
    try {
      const legacyCall = typeof dateOrNextName === 'string' && nextName === undefined;
      const projectDate = legacyCall ? undefined : normalizeProjectDate(dateOrNextName);
      const cleanedName = legacyCall
        ? cleanProjectName(dateOrNextName)
        : [formatProjectDate(projectDate), cleanProjectName(nextName || '')].filter(Boolean).join(' ');
      if (!cleanedName) throw new Error('项目名称不能为空');
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      const existingProject = catalog.byName.get(cleanedName.toLocaleLowerCase());
      if (existingProject && existingProject.name.toLocaleLowerCase() !== projectName.toLocaleLowerCase()) throw new Error('同名项目已存在');
      source = getProjectPath(workspacePath, status, projectName);
      destination = path.join(path.dirname(source), cleanedName);
      if (!fs.existsSync(source)) throw new Error('项目不存在');
      if (cleanedName !== projectName) {
        if (fs.existsSync(destination)) throw new Error('同名项目已存在');
        cancelMediaTrackingScan(root, projectName);
        suppressWorkspaceWatchPath(source);
        suppressWorkspaceWatchPath(destination);
        watchPathsSuppressed = true;
        suspendedWatcherToken = typeof suspendFileRootWatcher === 'function' ? suspendFileRootWatcher(source) : null;
        if (typeof context.publishPathNoClobber === 'function') await publishPathNoClobber(source, destination);
        else await renamePathWithRetry(source, destination);
        renameCompleted = true;
        try { destinationOwnership = { created: true, identity: await captureIdentity(destination) }; }
        catch (error) {
          scheduleCatalogReconcile(root);
          return { success: false, error: `项目文件夹已移动，但身份确认失败，请勿重试；后台正在核对目录。${error.message || String(error)}`, errorCode: 'WORKSPACE_MUTATION_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true };
        }
      }
      const previousProjectDate = readProjectDate(catalog.byName.get(projectName.toLocaleLowerCase()));
      try {
        const renamePayload = { name: projectName, nextName: cleanedName, relativePath: path.relative(root, destination), ...(legacyCall ? {} : { projectDate }) };
        try {
          if (typeof workspaceRepository?.renameProject === 'function') await workspaceRepository.renameProject(root, renamePayload);
          else await mutateWorkspaceCatalog(root, 'renameProject', renamePayload);
        } catch (error) {
          const probe = await probeProjectMutation(root, cleanedName, row => row.status === status && path.normalize(row.relative_path || row.relativePath || cleanedName) === path.normalize(path.relative(root, destination)));
          if (probe.state === 'committed') repositoryCommitted = true;
          else if (probe.state === 'unknown') return { success: false, error: mutationOutcomeUnknownError(error).message, errorCode: 'WORKSPACE_MUTATION_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true };
          else throw error;
        }
        repositoryCommitted = true;
      } catch (error) {
        if (renameCompleted && !fs.existsSync(source)) {
          if (await identityMatches(destination, destinationOwnership.identity)) {
            try {
              if (typeof context.publishPathNoClobber === 'function') await publishPathNoClobber(destination, source);
              else await renamePathWithRetry(destination, source);
              renameCompleted = false;
            } catch (rollbackError) {
              writeLog('warn', 'Project rename database failure rollback is pending', { error: error.message || String(error), rollbackError: rollbackError.message || String(rollbackError) });
              return { success: false, error: error.message || String(error), outcomeUnknown: true, rollbackPending: true };
            }
          } else {
            return { success: false, error: error.message || String(error), outcomeUnknown: true, rollbackPending: true };
          }
        }
        throw error;
      }
      const refreshed = await refreshAfterRepositoryCommit(root);
      catalogRefreshPending = refreshed.catalogRefreshPending;
      warning = refreshed.warning || '';
      if (cleanedName !== projectName) {
        await notifyComponentArtifactRelocation(root,
          { status, projectName },
          { status, projectName: cleanedName }).catch(error => {
            warning = warning || '项目已改名，但关联组件刷新失败';
            writeLog('warn', 'Project rename component relocation failed after commit', error);
          });
      }
      if (cleanedName !== projectName) await pushUndoOperation({ kind: 'project', source, destination, status, workspaceRoot: root, beforeName: projectName, afterName: cleanedName, beforeProjectDate: previousProjectDate, afterProjectDate: projectDate }).catch(error => {
        warning = warning || '项目已改名，但无法记录撤销操作';
        writeLog('warn', 'Unable to record project rename undo after commit', error);
      });
      return { success: true, project: { id: catalog.byName.get(projectName.toLocaleLowerCase())?.id, name: cleanedName, path: destination, status, updatedAt: Date.now(), projectDate: projectDate === undefined ? previousProjectDate : projectDate || undefined }, catalogRefreshPending, warning: warning || undefined };
    } catch (error) {
      if (suspendedWatcherToken && !renameCompleted && source && fs.existsSync(source) && typeof resumeFileRootWatcher === 'function') {
        resumeFileRootWatcher(source, suspendedWatcherToken);
      }
      const message = transientRenameErrorCodes.has(error?.code)
        ? 'Windows 暂时占用了项目文件夹，软件已暂停内部监听并多次重试。请关闭正在浏览该项目的资源管理器窗口或其他软件后再试。'
        : error.message || String(error);
      if (repositoryCommitted) return { success: true, warning: message, catalogRefreshPending: true };
      return { success: false, error: message };
    } finally {
      if (watchPathsSuppressed) {
        releaseWorkspaceWatchPath(source);
        releaseWorkspaceWatchPath(destination);
      }
    }
  });
  
  ipcMain.handle('workspace-create-project-folder', async (_event, workspacePath, status, projectName, folderName, relativePath = '', makeUnique = false) => {
    let suppressedFolderPath = '';
    try {
      const cleanedName = cleanProjectName(folderName || '');
      if (!cleanedName) throw new Error('文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const parentResolution = virtualPaths.resolve(projectPath, relativePath, { externalRootMode: 'target' });
      const parentPath = parentResolution.physicalPath;
      if (!fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) throw new Error('无效的文件夹位置');
      let actualName = cleanedName;
      let folderPath = path.resolve(parentPath, actualName);
      if (!folderPath.startsWith(parentPath + path.sep)) throw new Error('无效的文件夹名称');
      if (makeUnique) {
        let index = 2;
        while (fs.existsSync(folderPath)) {
          actualName = `${cleanedName} (${index++})`;
          folderPath = path.resolve(parentPath, actualName);
        }
      } else if (fs.existsSync(folderPath)) throw new Error('同名文件夹已存在');
      suppressWorkspaceWatchPath?.(folderPath);
      suppressedFolderPath = folderPath;
      fs.mkdirSync(folderPath);
      await pushUndoOperation({ kind: 'remove-created', paths: [folderPath], label: '新建文件夹' });
      return { success: true, folder: { name: actualName, path: folderPath, relativePath: [parentResolution.virtualPath, actualName].filter(Boolean).join('/'), updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    } finally {
      if (suppressedFolderPath) releaseWorkspaceWatchPath?.(suppressedFolderPath);
    }
  });

  ipcMain.handle('workspace-shell-new-types', async (_event, refresh = false) => {
    try {
      return { success: true, types: await shellNewService.list({ refresh }) };
    } catch (error) {
      return { success: false, types: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-create-shell-new-file', async (_event, workspacePath, status, projectName, relativePath, typeId) => {
    let suppressedParentPath = '';
    try {
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const parentResolution = virtualPaths.resolve(projectPath, relativePath, { externalRootMode: 'target' });
      const parentPath = parentResolution.physicalPath;
      if (!(await fs.promises.stat(parentPath)).isDirectory()) throw new Error('新建文件位置不是文件夹');
      suppressWorkspaceWatchPath?.(parentPath);
      suppressedParentPath = parentPath;
      const created = await shellNewService.create(typeId, parentPath, uniqueDestination);
      await pushUndoOperation({ kind: 'remove-created', paths: [created.path], label: '新建文件' });
      return { success: true, file: { ...created, relativePath: [parentResolution.virtualPath, path.basename(created.path)].filter(Boolean).join('/'), updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    } finally {
      if (suppressedParentPath) releaseWorkspaceWatchPath?.(suppressedParentPath);
    }
  });
  
  ipcMain.handle('workspace-rename-project-folder', async (_event, workspacePath, status, projectName, folderName, nextName) => {
    try {
      const cleanedName = cleanProjectName(nextName || '');
      if (!cleanedName) throw new Error('文件夹名称不能为空');
      const projectPath = getProjectPath(workspacePath, status, projectName);
      const source = path.resolve(projectPath, folderName);
      const destination = path.resolve(projectPath, cleanedName);
      if (!source.startsWith(projectPath + path.sep) || !destination.startsWith(projectPath + path.sep)) throw new Error('无效的文件夹路径');
      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('文件夹不存在');
      if (isProtectedProjectFolderPath({ fs, path, projectRoot: projectPath, candidate: source })) {
        throw new Error('该文件夹由项目工作流管理，不能使用普通重命名');
      }
      if (isProtectedProjectFolderName(cleanedName)) throw new Error('该名称保留给项目工作流使用');
      if (fs.existsSync(destination)) throw new Error('同名文件夹已存在');
      await fs.promises.rename(source, destination);
      await pushUndoOperation({ kind: 'folder', source, destination, beforeName: folderName, afterName: cleanedName });
      return { success: true, folder: { name: cleanedName, path: destination, updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-undo-rename', async (_event, workspacePath = '', options = {}) => {
    let operation;
    let loadedFromJournal = false;
    let persistentClaimDescriptor;
    try {
      pruneBlockedPersistentUndos();
      const requestedDecisionToken = String(options?.decisionToken || '');
      pruneRestoreDecisionTokens();
      const pendingDecision = requestedDecisionToken ? restoreDecisionTokens.get(requestedDecisionToken) : null;
      if (pendingDecision) {
        operation = pendingDecision.operation;
        const queuedIndex = renameHistory.lastIndexOf(operation);
        if (queuedIndex >= 0) renameHistory.splice(queuedIndex, 1);
      } else operation = renameHistory.pop();
      if (!operation && workspacePath) {
        const workspaceRoot = resolveWorkspaceRoot(workspacePath);
        const latest = await workspaceRepository.latestUndoRecord(workspaceRoot);
        if (latest.record) {
          operation = { kind: latest.record.kind, ...latest.record.payload, persistentId: latest.record.id, workspaceRoot };
          loadedFromJournal = true;
        }
      }
      if (!operation) return { success: false, error: '没有可撤销的操作' };
      if (operation.persistentId && operation.workspaceRoot) {
        if (operation.kind === 'trash') {
          persistentClaimDescriptor = await persistentUndoClaimDescriptor(operation);
          if (await persistentUndoClaimExists(persistentClaimDescriptor)) {
            const pendingError = Object.assign(new Error('该持久撤销记录已有恢复 tombstone；当前进程不会探测、恢复或修改 journal'), {
              code: 'PERSISTENT_UNDO_RECOVERY_PENDING', recoveryRequired: true, rollbackPending: true,
            });
            const claimed = blockPersistentUndo(operation, pendingError);
            return serializeUndoRecoveryError(claimed.error);
          }
        }
        const blocked = blockedPersistentUndos.get(persistentUndoKey(operation.workspaceRoot, operation.persistentId));
        if (blocked) {
          await retryMarkPersistentUndoUnavailable(blocked);
          return serializeUndoRecoveryError(blocked.error);
        }
        if (loadedFromJournal && persistentUndoQuarantineOverflow) {
          const overflowError = Object.assign(new Error('持久撤销安全隔离已达到容量上限；为避免重复恢复，当前记录已拒绝执行，请修复操作数据库后重试维护'), {
            code: 'PERSISTENT_UNDO_QUARANTINE_OVERFLOW', recoveryRequired: true, rollbackPending: true,
          });
          const overflowEntry = { key: persistentUndoKey(operation.workspaceRoot, operation.persistentId), operation, error: overflowError, markedUnavailable: false, overflow: true, expiresAt: Number.POSITIVE_INFINITY };
          await retryMarkPersistentUndoUnavailable(overflowEntry);
          return serializeUndoRecoveryError(overflowEntry.error);
        }
      }
      if (operation.kind === 'remove-created') {
        const phase = operation.removeCreatedPhase || (operation.removeCreatedPhase = {});
        if (!phase.externalAdoptionsReverted && operation.externalAdoptionUndo?.progressIds?.length) {
          await versionService.revertExternalAdoptions(operation.externalAdoptionUndo.workspaceRoot, {
            projectName: operation.externalAdoptionUndo.projectName,
            progressIds: operation.externalAdoptionUndo.progressIds,
          });
          phase.externalAdoptionsReverted = true;
        }
        if (!phase.externalProgressUnregistered && operation.externalProgressUndo?.progressId) {
          await versionService.unregisterProgress(operation.externalProgressUndo.workspaceRoot, {
            projectName: operation.externalProgressUndo.projectName,
            progressId: operation.externalProgressUndo.progressId,
            allowMissing: true,
          });
          phase.externalProgressUnregistered = true;
        }
        const removedPaths = new Set(phase.removedPaths || []);
        if (!phase.pathsRemoved) {
          const pendingRemovalPaths = [...operation.paths, ...(operation.retainedSourceRoots || []), ...(operation.retainedSourcePaths || [])];
          for (const item of pendingRemovalPaths) {
            if (removedPaths.has(item)) continue;
            await assertUndoIdentity(operation, item);
            await fs.promises.rm(item, { recursive: true, force: true });
            removedPaths.add(item);
            phase.removedPaths = [...removedPaths];
          }
          phase.pathsRemoved = true;
        }
        if (!phase.managedExternalLinksRevoked && operation.managedExternalLinkIds?.length) {
          virtualPaths.revokeManagedExternalLinkIds(operation.managedExternalLinkIds);
          phase.managedExternalLinksRevoked = true;
        }
        if (!phase.managedExternalWatchersRefreshed && operation.managedExternalWatcher) {
          const watcher = operation.managedExternalWatcher;
          try { await watchProjectFileRoot(watcher.workspacePath, watcher.status, watcher.projectName); }
          catch (watchError) {
            writeLog('warn', 'Unable to refresh external watchers after undo', {
              workspacePath: watcher.workspacePath,
              status: watcher.status,
              projectName: watcher.projectName,
              error: watchError.message || String(watchError),
            });
          }
          phase.managedExternalWatchersRefreshed = true;
        }
        return { success: true, message: `已撤销${operation.label || '文件操作'} ${operation.paths.length} 个项目` };
      }
      if (operation.kind === 'trash') {
        const restoreConflictPolicy = ['rename', 'overwrite'].includes(options?.restoreConflictPolicy) ? options.restoreConflictPolicy : '';
        const restoreConflicts = [];
        const restorePreflight = [];
        for (const item of operation.items) {
          if (item.backup) {
            if (await pathExists(item.original) || !await pathExists(item.backup)) throw new Error('原位置已被占用，或旧版恢复副本不可用');
            restorePreflight.push({ item, action: 'backup', restoreTarget: item.original });
            continue;
          }
          if (!await pathExists(path.parse(item.original).root)) {
            throw Object.assign(new Error('原文件所在磁盘当前未连接，连接磁盘后可以再次撤销'), { code: 'RESTORE_VOLUME_UNAVAILABLE' });
          }
          const originalExists = await pathExists(item.original);
          if (originalExists && await samePathIdentity(item.original, item.originalIdentity)) {
            restorePreflight.push({ item, action: 'already-restored', restoreTarget: item.original });
            continue;
          }
          if (originalExists) restoreConflicts.push(item);
          const probe = await recycleBinService.probe(item.recyclePidl);
          if (!probe.exists) {
            throw Object.assign(new Error('系统回收站中的文件已不存在，可能已经被还原或清空'), { code: 'RECYCLE_ITEM_MISSING' });
          }
          restorePreflight.push({ item, action: originalExists ? 'conflict' : 'restore', restoreTarget: item.original });
        }
        const conflictSnapshot = [];
        for (const item of restoreConflicts) conflictSnapshot.push({ path: item.original, identity: await captureIdentity(item.original) });
        const snapshotMatches = async expected => Boolean(expected
          && expected.expiresAt > Date.now()
          && expected.persistentId === (operation.persistentId || '')
          && expected.sources.length === operation.items.length
          && expected.sources.every((source, index) => source.recyclePidl === (operation.items[index].recyclePidl || '')
            && JSON.stringify(source.originalIdentity) === JSON.stringify(operation.items[index].originalIdentity || null))
          && expected.conflicts.length === conflictSnapshot.length
          && (await Promise.all(expected.conflicts.map(conflict => identityMatches(conflict.path, conflict.identity)))).every(Boolean));
        let decisionValid = false;
        if (restoreConflictPolicy) {
          if (requestedDecisionToken) decisionValid = pendingDecision?.operation === operation && await snapshotMatches(pendingDecision);
          else {
            const legacyDecision = legacyRestoreDecisions.get(operation) || {
              operation,
              persistentId: operation.persistentId || '',
              sources: operation.items.map(item => ({ recyclePidl: item.recyclePidl || '', originalIdentity: item.originalIdentity || null })),
              conflicts: conflictSnapshot,
              expiresAt: Date.now() + decisionTtlMs,
            };
            decisionValid = await snapshotMatches(legacyDecision);
          }
        }
        if (restoreConflicts.length && (!restoreConflictPolicy || !decisionValid)) {
          renameHistory.push(operation);
          const decisionToken = crypto.randomUUID();
          const decision = {
            operation,
            persistentId: operation.persistentId || '',
            sources: operation.items.map(item => ({ recyclePidl: item.recyclePidl || '', originalIdentity: item.originalIdentity || null })),
            conflicts: conflictSnapshot,
            expiresAt: Date.now() + decisionTtlMs,
          };
          restoreDecisionTokens.set(decisionToken, decision);
          legacyRestoreDecisions.set(operation, decision);
          const names = restoreConflicts.slice(0, 6).map(item => path.basename(item.original));
          return {
            success: true,
            requiresDecision: {
              kind: 'restore-conflict',
              decisionToken,
              names,
              conflictCount: restoreConflicts.length,
              message: restoreConflicts.length === 1
                ? `“${names[0]}”的原位置已被其他项目占用`
                : `${restoreConflicts.length} 个项目的原位置已被同名项目占用`,
              detail: '可以改名恢复，也可以把当前同名项目移入系统回收站后覆盖恢复。',
            },
          };
        }
        if (requestedDecisionToken) restoreDecisionTokens.delete(requestedDecisionToken);
        legacyRestoreDecisions.delete(operation);
        for (const [token, decision] of restoreDecisionTokens) if (decision.operation === operation) restoreDecisionTokens.delete(token);
        for (const plan of restorePreflight) {
          if (plan.action !== 'conflict') continue;
          if (restoreConflictPolicy === 'rename') {
            const parsed = path.parse(plan.item.original);
            let index = 1;
            do { plan.restoreTarget = path.join(parsed.dir, `${parsed.name} (已恢复${index > 1 ? ` ${index}` : ''})${parsed.ext}`); index += 1; }
            while (await pathExists(plan.restoreTarget));
            plan.action = 'restore';
          } else {
            const confirmedConflict = conflictSnapshot.find(conflict => comparablePath(conflict.path) === comparablePath(plan.item.original));
            if (!confirmedConflict || !await identityMatches(plan.item.original, confirmedConflict.identity)) throw new Error('同名项目在确认后发生变化，请重新恢复');
            plan.action = 'overwrite';
          }
        }
        if (operation.persistentId && operation.workspaceRoot) {
          persistentClaimDescriptor ||= await persistentUndoClaimDescriptor(operation);
          try { await createPersistentUndoClaim(operation, persistentClaimDescriptor); }
          catch (claimError) {
            if (claimError.code === 'PERSISTENT_UNDO_RECOVERY_PENDING') {
              const claimed = blockPersistentUndo(operation, claimError);
              return serializeUndoRecoveryError(claimed.error);
            }
            throw claimError;
          }
          let latestAfterClaim;
          try { latestAfterClaim = await workspaceRepository.latestUndoRecord(operation.workspaceRoot); }
          catch (cause) {
            throw Object.assign(new Error(`claim 已持久化，但无法复核撤销 journal；已拒绝执行：${cause?.message || String(cause)}`), {
              code: 'PERSISTENT_UNDO_RECOVERY_PENDING', recoveryRequired: true, rollbackPending: true, cause,
            });
          }
          if (!latestAfterClaim.record) {
            return { success: false, error: '没有可撤销的操作' };
          }
          if (latestAfterClaim.record.id !== operation.persistentId) {
            const staleError = Object.assign(new Error('claim 后的最新撤销记录已变化；为避免恢复错误记录，当前 tombstone 已保留且不会执行'), {
              code: 'PERSISTENT_UNDO_RECOVERY_PENDING', recoveryRequired: true, rollbackPending: true,
            });
            blockPersistentUndo(operation, staleError);
            return serializeUndoRecoveryError(staleError);
          }
          const pendingError = Object.assign(new Error('持久撤销 claim 已建立，但数据库隔离尚未完成；不会执行恢复'), {
            code: 'PERSISTENT_UNDO_RECOVERY_PENDING', recoveryRequired: true, rollbackPending: true,
          });
          const claimed = blockPersistentUndo(operation, pendingError);
          if (!await retryMarkPersistentUndoUnavailable(claimed)) return serializeUndoRecoveryError(claimed.error);
        }
        const restoredItems = [];
        for (const plan of restorePreflight) {
          const { item } = plan;
          // Compatibility for deletion records created by older app versions.
          if (plan.action === 'backup') {
            await fs.promises.mkdir(path.dirname(item.original), { recursive: true });
            await fs.promises.cp(item.backup, item.original, { recursive: true, preserveTimestamps: true, errorOnExist: true });
            if (item.backupRoot) await fs.promises.rm(item.backupRoot, { recursive: true, force: true });
            continue;
          }
          const restoreTarget = plan.restoreTarget;
          if (plan.action === 'already-restored') {
            restoredItems.push({ item, restoreTarget, restoredIdentity: await captureIdentity(restoreTarget) });
            continue;
          }
          if (plan.action === 'overwrite') {
            const replacementIdentity = await recycleBinService.trash(item.original);
            try {
              await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: item.original });
            } catch (error) {
              try { await recycleBinService.restore({ recyclePidl: replacementIdentity.recyclePidl, originalPath: item.original }); }
              catch (rollbackError) { mergeRecoveryError(error, rollbackError, '恢复当前同名项目失败'); }
              throw error;
            }
            if (operation.workspaceRoot && replacementIdentity.recyclePidl) {
              const replacementRecord = await workspaceRepository.addUndoRecord(operation.workspaceRoot, {
                kind: 'trash', payload: { items: [{ original: item.original, recyclePidl: replacementIdentity.recyclePidl }] },
              });
              await pushUndoOperation({ kind: 'trash', workspaceRoot: operation.workspaceRoot, persistentId: replacementRecord.id, items: [{ original: item.original, recyclePidl: replacementIdentity.recyclePidl }] });
            }
            restoredItems.push({ item, restoreTarget: item.original, restoredIdentity: await captureIdentity(item.original) });
            continue;
          }
          await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: restoreTarget });
          const restoredIdentity = await captureIdentity(restoreTarget);
          if (!await identityMatches(restoreTarget, restoredIdentity)) throw new Error('恢复后的项目身份校验失败');
          restoredItems.push({ item, restoreTarget, restoredIdentity });
        }
        if (operation.projectCatalog && operation.workspaceRoot) {
          const restoredProject = restoredItems.find(entry => comparablePath(entry.item.original) === comparablePath(operation.items[0]?.original)) || restoredItems[0];
          const restoreTarget = restoredProject?.restoreTarget || operation.items[0]?.original;
          const nextName = path.basename(restoreTarget);
          if (operation.projectCatalog.id && operation.projectCatalog.projectId && operation.projectCatalog.id !== operation.projectCatalog.projectId) throw new Error('待恢复项目ID不一致');
          await workspaceRepository.restoreProject(operation.workspaceRoot, {
            ...operation.projectCatalog,
            projectId: operation.projectCatalog.projectId || operation.projectCatalog.id,
            nextName,
            relativePath: path.relative(operation.workspaceRoot, restoreTarget),
            restoreTarget,
            restoreIdentity: restoredProject?.restoredIdentity,
          });
          await refreshWorkspaceCatalog(operation.workspaceRoot);
        }
        if (operation.workspaceRoot) await refreshManagedExternalWatchersForPaths(operation.workspaceRoot, operation.items.map(item => item.original));
        if (operation.persistentId && operation.workspaceRoot) {
          try { await workspaceRepository.removeUndoRecord(operation.workspaceRoot, operation.persistentId); }
          catch (cause) {
            throw Object.assign(new Error(`恢复已完成，但撤销 journal 删除失败；claim 已保留：${cause?.message || String(cause)}`), {
              code: 'PERSISTENT_UNDO_RECOVERY_PENDING', outcomeUnknown: true, recoveryRequired: true, rollbackPending: true, cause,
            });
          }
          blockedPersistentUndos.delete(persistentUndoKey(operation.workspaceRoot, operation.persistentId));
        }
        return { success: true, message: `已恢复 ${operation.items.length} 个已删除项目` };
      }
      if (operation.kind === 'import-with-sources') {
        for (const createdPath of operation.createdPaths) await assertUndoIdentity(operation, createdPath);
        if (operation.items.some(item => fs.existsSync(item.original) || !fs.existsSync(item.backup))) throw new Error('导入源文件的恢复副本不可用');
        for (const createdPath of operation.createdPaths) await fs.promises.rm(createdPath, { recursive: true, force: true });
        for (const item of operation.items) {
          await fs.promises.mkdir(path.dirname(item.original), { recursive: true });
          await fs.promises.cp(item.backup, item.original, { recursive: true, preserveTimestamps: true, errorOnExist: true });
          await fs.promises.rm(item.backupRoot, { recursive: true, force: true });
        }
        return { success: true, message: `已撤销导入 ${operation.items.length} 个文件` };
      }
      if (operation.kind === 'paste-replace') {
        const moves = Array.isArray(operation.moves) ? operation.moves : [];
        const replacementItems = Array.isArray(operation.items) ? operation.items : [];
        if (replacementItems.some(item => item.permanent || (!item.backup && !item.recyclePidl))) {
          throw new Error('部分被替换的原项目已由 Windows 永久删除，无法完整撤销此次粘贴');
        }
        if (operation.partialUndoState) {
          const partial = operation.partialUndoState;
          const occupied = replacementItems.find(item => fs.existsSync(item.original));
          if (occupied) throw Object.assign(new Error(`无法继续撤销：“${path.basename(occupied.original)}”被后来出现的未知项目占用；新粘贴内容和旧备份均已保留在 ${partial.undoRoot}`), { code: 'UNDO_PUBLISH_CONFLICT', recoveryRequired: true });
          for (const item of replacementItems) {
            if (item.backup) await publishPathNoClobber(item.backup, item.original);
            else await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: item.original });
          }
          if (operation.mode === 'cut') {
            for (const item of partial.stagedNewItems || []) if (fs.existsSync(item.temporary)) await movePathAtomic(item.temporary, item.source);
          } else {
            for (const item of partial.stagedNewItems || []) if (fs.existsSync(item.temporary)) await fs.promises.rm(item.temporary, { recursive: true, force: true });
          }
          await fs.promises.rm(partial.undoRoot, { recursive: true, force: true }).catch(() => undefined);
          for (const retainedRoot of operation.retainedSourceRoots || []) await fs.promises.rm(retainedRoot, { recursive: true, force: true }).catch(() => undefined);
          operation.partialUndoState = null;
          return { success: true, message: `已继续撤销粘贴并恢复 ${replacementItems.length} 个被替换项目` };
        }
        for (const move of moves) await assertUndoIdentity(operation, move.destination);
        const destinationKeys = new Set(moves.map(move => path.resolve(move.destination).toLocaleLowerCase()));
        if (operation.mode === 'cut' && moves.some(move => fs.existsSync(move.source) && !destinationKeys.has(path.resolve(move.source).toLocaleLowerCase()))) {
          throw new Error('剪切源位置已被占用，无法安全撤销此次粘贴');
        }
        for (const item of replacementItems) {
          if (item.backup) {
            if (!fs.existsSync(item.backup)) throw new Error(`被替换项目“${path.basename(item.original)}”的恢复副本已不存在`);
          } else {
            const probe = await recycleBinService.probe(item.recyclePidl);
            if (!probe.exists) throw Object.assign(new Error(`回收站中的“${path.basename(item.original)}”已不存在，无法撤销替换`), { code: 'PASTE_REPLACEMENT_MISSING' });
          }
        }

        const undoRoot = path.join(path.dirname(moves[0]?.destination || replacementItems[0].original), `.photoflow-undo-paste-${crypto.randomUUID()}`);
        const stagedNewItems = [];
        const restoredOldItems = [];
        let preserveUndoRoot = false;
        await fs.promises.mkdir(undoRoot, { recursive: false });
        try {
          for (const [index, move] of moves.entries()) {
            const temporary = path.join(undoRoot, `new-${index}-${path.basename(move.destination)}`);
            await publishPathNoClobber(move.destination, temporary);
            stagedNewItems.push({ ...move, temporary, movedToSource: false });
          }
          for (const item of replacementItems) {
            if (item.backup) await publishPathNoClobber(item.backup, item.original);
            else await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: item.original });
            restoredOldItems.push(item);
          }
          if (operation.mode === 'cut') {
            for (const item of stagedNewItems) {
              await movePathAtomic(item.temporary, item.source);
              item.movedToSource = true;
            }
          } else {
            for (const item of stagedNewItems) await fs.promises.rm(item.temporary, { recursive: true, force: true });
          }
        } catch (error) {
          for (const [index, item] of [...restoredOldItems].reverse().entries()) {
            if (!fs.existsSync(item.original)) continue;
            const rollbackBackup = path.join(undoRoot, `old-${index}-${path.basename(item.original)}`);
            try {
              await publishPathNoClobber(item.original, rollbackBackup);
              item.backup = rollbackBackup;
              item.backupRoot = undoRoot;
              item.recyclePidl = '';
              item.permanent = false;
              preserveUndoRoot = true;
            } catch { /* a later recovery attempt can report the occupied path */ }
          }
          for (const item of [...stagedNewItems].reverse()) {
            try {
              if (item.movedToSource && fs.existsSync(item.source) && !fs.existsSync(item.temporary)) await movePathAtomic(item.source, item.temporary);
              if (fs.existsSync(item.temporary) && !fs.existsSync(item.destination)) await publishPathNoClobber(item.temporary, item.destination);
            } catch { /* best-effort rollback; preserve every reachable copy */ }
          }
          if (stagedNewItems.some(item => fs.existsSync(item.temporary)) || replacementItems.some(item => item.backup && fs.existsSync(item.backup))) {
            preserveUndoRoot = true;
            operation.partialUndoState = { undoRoot, stagedNewItems: stagedNewItems.map(item => ({ ...item })) };
            error.message = `${error.message || String(error)}；检测到晚到同名占用，未覆盖未知内容；新粘贴内容与旧备份已保留在 ${undoRoot}，清理占用后可再次撤销`;
            error.code = 'UNDO_PUBLISH_CONFLICT';
          }
          if (!preserveUndoRoot) await fs.promises.rm(undoRoot, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        await fs.promises.rm(undoRoot, { recursive: true, force: true }).catch(() => undefined);
        for (const retainedRoot of operation.retainedSourceRoots || []) await fs.promises.rm(retainedRoot, { recursive: true, force: true }).catch(() => undefined);
        const backupRoots = new Set(replacementItems.map(item => item.backupRoot).filter(Boolean));
        for (const backupRoot of backupRoots) await fs.promises.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
        return { success: true, message: `已撤销粘贴并恢复 ${replacementItems.length} 个被替换项目` };
      }
      if (operation.kind === 'external-move') {
        for (const move of operation.moves) await assertUndoIdentity(operation, move.destination);
        if (operation.moves.some(move => fs.existsSync(move.source))) throw new Error('原位置已经被占用，无法安全撤销');
        for (const move of operation.moves) {
          try {
            await fs.promises.rename(move.destination, move.source);
          } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await fs.promises.cp(move.destination, move.source, { recursive: true, preserveTimestamps: true, errorOnExist: true });
            await fs.promises.rm(move.destination, { recursive: true, force: true });
          }
        }
        return { success: true, message: `已撤销导入 ${operation.moves.length} 个文件` };
      }
      if (operation.kind === 'broll-import') {
        const createdPaths = Array.isArray(operation.createdPaths) ? operation.createdPaths : [];
        const moves = Array.isArray(operation.moves) ? operation.moves : [];
        for (const item of createdPaths) await assertUndoIdentity(operation, item);
        for (const move of moves) await assertUndoIdentity(operation, move.destination);
        if (moves.some(item => fs.existsSync(item.source))) throw new Error('花絮原位置已被占用，无法安全撤销');
        for (const item of createdPaths) await fs.promises.rm(item, { force: true });
        for (const move of [...moves].reverse()) {
          try {
            await fs.promises.rename(move.destination, move.source);
          } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await fs.promises.copyFile(move.destination, move.source, fs.constants.COPYFILE_EXCL);
            await fs.promises.rm(move.destination, { force: true });
          }
        }
        return { success: true, message: `已撤销导入花絮 ${createdPaths.length + moves.length} 个文件` };
      }
      if (operation.kind === 'files' || operation.kind === 'move') {
        const moves = operation.moves.map(move => ({ source: move.destination, destination: move.source }));
        const normalizedSources = new Set(moves.map(move => path.resolve(move.source).toLocaleLowerCase()));
        for (const move of moves) await assertUndoIdentity(operation, move.source);
        if (moves.some(move => fs.existsSync(move.destination) && !normalizedSources.has(path.resolve(move.destination).toLocaleLowerCase()))) {
          throw new Error('原名称已被占用，无法撤销');
        }
        const staged = [];
        try {
          for (const move of moves) {
            const temporary = path.join(path.dirname(move.source), `.photoflow-undo-rename-${crypto.randomUUID()}${path.extname(move.source)}`);
            await fs.promises.rename(move.source, temporary);
            staged.push({ ...move, temporary, completed: false });
          }
          for (const move of staged) {
            await movePathAtomic(move.temporary, move.destination);
            move.completed = true;
          }
        } catch (error) {
          for (const move of [...staged].reverse()) {
            try {
              if (move.completed && fs.existsSync(move.destination) && !fs.existsSync(move.source)) await movePathAtomic(move.destination, move.source);
              else if (!move.completed && fs.existsSync(move.temporary) && !fs.existsSync(move.source)) await fs.promises.rename(move.temporary, move.source);
            } catch { /* best-effort rollback; original error is reported below */ }
          }
          throw error;
        }
        return { success: true, message: operation.kind === 'files' ? `已撤销重命名 ${moves.length} 个文件` : `已撤销移动 ${moves.length} 个项目` };
      }
      await assertUndoIdentity(operation, operation.destination);
      if (fs.existsSync(operation.source)) {
        throw new Error('原名称已被占用，无法撤销');
      }
      await fs.promises.rename(operation.destination, operation.source);
      const response = { success: true, message: `已撤销重命名：${operation.afterName} → ${operation.beforeName}` };
      if (operation.kind === 'project') {
        await mutateWorkspaceCatalog(operation.workspaceRoot, 'renameProject', { name: operation.afterName, nextName: operation.beforeName, relativePath: path.relative(operation.workspaceRoot, operation.source), ...(Object.prototype.hasOwnProperty.call(operation, 'beforeProjectDate') ? { projectDate: operation.beforeProjectDate || null } : {}) });
        await notifyComponentArtifactRelocation(operation.workspaceRoot,
          { status: operation.status, projectName: operation.afterName },
          { status: operation.status, projectName: operation.beforeName });
        response.project = { name: operation.beforeName, path: operation.source, status: operation.status, updatedAt: Date.now(), projectDate: operation.beforeProjectDate };
      }
      return response;
    } catch (error) {
      const terminalRecovery = error.code === 'RECYCLE_ITEM_MISSING' || terminalRecoveryResult(error);
      if (operation?.persistentId && operation?.workspaceRoot && terminalRecovery) {
        const blocked = blockPersistentUndo(operation, error);
        await retryMarkPersistentUndoUnavailable(blocked);
      }
      if (operation && !terminalRecovery) renameHistory.push(operation);
      return serializeUndoRecoveryError(error);
    }
  });
  
  ipcMain.handle('workspace-move-project', async (_event, workspacePath, currentStatus, projectName, nextStatus) => {
    try {
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      if (!isValidProjectStatus(nextStatus)) throw new Error('无效的项目状态');
      if (nextStatus === '未分类') throw new Error('未分类仅用于自动发现的新文件夹');
      const source = getProjectPath(workspacePath, currentStatus, projectName);
      if (!fs.existsSync(source)) throw new Error('项目不存在');
      await mutateWorkspaceCatalog(root, 'setProjectStatus', { name: projectName, status: nextStatus });
      await notifyComponentArtifactRelocation(root,
        { status: currentStatus, projectName },
        { status: nextStatus, projectName });
      return { success: true, project: { id: catalog.byName.get(projectName.toLocaleLowerCase())?.id, name: projectName, path: source, status: nextStatus, updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-finalize-sd-imports', async (_event, workspacePath, projectNames = [], options = {}) => {
    try {
      const root = ensureWorkspace(workspacePath);
      const targetStatus = '后期中';
      const normalizedNames = values => [...new Set((Array.isArray(values) ? values : [])
        .map(value => cleanProjectName(String(value))).filter(Boolean).map(value => value.toLocaleLowerCase()))];
      const requestedNames = new Set(normalizedNames(projectNames));
      const workNames = new Set(normalizedNames(options.workProjectNames).filter(name => requestedNames.has(name)));
      const moveProjectAfterImport = options.moveProjectAfterImport === true;
      await reconcileWorkspaceCatalog(root);
      const movedNames = new Set();
      const failures = [];
      for (const requestedName of requestedNames) {
        const currentCatalog = await reconcileWorkspaceCatalog(root);
        const row = currentCatalog.projects.find(project => project.name.toLocaleLowerCase() === requestedName);
        if (!row || !workNames.has(requestedName) || !moveProjectAfterImport || row.status !== '待拍摄') continue;
        try {
          await workspaceRepository.setProjectStatus(root, { name: row.name, status: targetStatus });
          try {
            const migrationResults = await notifyComponentArtifactRelocation(root,
              { status: row.status, projectName: row.name },
              { status: targetStatus, projectName: row.name });
            if (migrationResults.some(result => result.state === 'failed')) throw new Error('团队工作流数据迁移失败');
          } catch (migrationError) {
            await workspaceRepository.setProjectStatus(root, { name: row.name, status: row.status }).catch(() => undefined);
            await notifyComponentArtifactRelocation(root,
              { status: targetStatus, projectName: row.name },
              { status: row.status, projectName: row.name }).catch(() => undefined);
            throw migrationError;
          }
          movedNames.add(requestedName);
        } catch (error) {
          failures.push({ projectName: row.name, error: error.message || String(error) });
        }
      }
      const finalCatalog = await reconcileWorkspaceCatalog(root);
      const projects = finalCatalog.projects.flatMap(row => {
        if (!requestedNames.has(row.name.toLocaleLowerCase())) return [];
        const projectPath = path.join(root, row.relative_path);
        if (!fs.existsSync(projectPath)) return [];
        return [{ id: row.id, name: row.name, path: projectPath, status: row.status, updatedAt: fs.statSync(projectPath).mtimeMs }];
      });
      await refreshWorkspaceCatalog(root);
      await scheduleSdImportedMedia({ root, projects, importedPathsByProject: options.importedPathsByProject, imageExtensions: IMAGE_EXTENSIONS, rawExtensions: RAW_EXTENSIONS, videoExtensions: VIDEO_EXTENSIONS, fs, path, scheduleMediaTrackingScan });
      mainWindow?.webContents.send('workspace-projects-changed', { root, reason: 'sd-import-finalized' });
      const movedProjects = projects.filter(project => movedNames.has(project.name.toLocaleLowerCase()));
      const unchangedProjects = projects.filter(project => !movedNames.has(project.name.toLocaleLowerCase()));
      writeLog('info', 'SD imported projects finalized', { root, requested: [...requestedNames], work: [...workNames], moved: movedProjects.length, failures: failures.length });
      return { success: true, projects, movedProjects, unchangedProjects, failures };
    } catch (error) {
      writeLog('error', 'Unable to finalize SD imported folders', error);
      return { success: false, error: error.message || String(error), projects: [], movedProjects: [], unchangedProjects: [], failures: [] };
    }
  });
  
  ipcMain.handle('workspace-trash-project', async (event, workspacePath, status, projectName) => {
    const operationId = crypto.randomUUID();
    let suppressedProjectPath = '';
    let task = null;
    const publish = payload => task?.publish(payload);
    try {
      const projectPath = getProjectPath(workspacePath, status, projectName);
      if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'trash', title: `删除项目 · ${projectName}`,
        projectName, resources: [projectPath], cancellable: false, cancelledCode: CANCELLED_CODE,
      });
      await task.start();
      publish({ phase: 'trashing', progress: 0, currentName: projectName, processedCount: 0, totalCount: 1 });
      const root = ensureWorkspace(workspacePath);
      const originalIdentity = await capturePathIdentity(projectPath);
      cancelMediaTrackingScan(root, projectName);
      suppressWorkspaceWatchPath(projectPath);
      suppressedProjectPath = projectPath;
      const recycled = await recycleBinService.trash(projectPath);
      const catalogRow = workspaceCatalogs.get(root)?.byName?.get(projectName.toLocaleLowerCase());
      const projectCatalog = { id: catalogRow?.id, projectId: catalogRow?.id, name: projectName, status, relativePath: catalogRow?.relative_path || path.relative(root, projectPath) };
      if (recycled.recyclePidl) {
        const item = { original: projectPath, originalIdentity, recyclePidl: recycled.recyclePidl, preciseRestore: recycled.preciseRestore !== false };
        const record = await workspaceRepository.addUndoRecord(root, { kind: 'trash', payload: { items: [item], projectCatalog } });
        await pushUndoOperation({ kind: 'trash', workspaceRoot: root, persistentId: record.id, items: [item], projectCatalog });
      } else if (recycled.permanent) {
        await workspaceRepository.addUndoRecord(root, {
          kind: 'project-cleanup',
          payload: { items: [{ original: projectPath, originalIdentity, permanent: true }], projectCatalog },
        });
      }
      await mutateWorkspaceCatalog(root, 'softDeleteProject', { name: projectName });
      publish({ phase: 'complete', progress: 100, currentName: projectName, processedCount: 1, totalCount: 1 });
      task.complete('项目已移入回收站');
      if (recycled.permanent) queuePermanentProjectCleanup(root, projectName);
      return { success: true, operationId, permanent: Boolean(recycled.permanent) };
    } catch (error) {
      publish({ phase: 'failed', progress: 0, currentName: projectName, error: error.message || String(error) });
      task?.fail(error);
      return { success: false, error: error.message || String(error), errorCode: error?.code || undefined };
    } finally {
      if (suppressedProjectPath) releaseWorkspaceWatchPath(suppressedProjectPath);
    }
  });
  
  ipcMain.handle('workspace-project-contents', async (_event, workspacePath, status, projectName) => {
    try {
      const projectPath = getProjectPath(workspacePath, status, projectName);
      if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
      const entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
      const folders = (await Promise.all(entries
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(async entry => {
          const folderPath = path.join(projectPath, entry.name);
          return { name: entry.name, path: folderPath, updatedAt: (await fs.promises.stat(folderPath)).mtimeMs };
        })))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      return { success: true, folders };
    } catch (error) {
      return { success: false, error: error.message || String(error), folders: [] };
    }
  });

  const watchProjectFileRoot = async (workspacePath, status, projectName, options = {}) => {
    const root = path.resolve(getProjectPath(workspacePath, status, projectName));
    const publishRoot = path.resolve(ensureWorkspace(workspacePath));
    const projectPrefix = path.relative(publishRoot, root).replace(/\\/g, '/');
    const key = watchedProjectFileRootKey(publishRoot, status, projectName);
    const previousHealth = watchedProjectFileRootHealth.get(key);
    const previousBindings = watchedProjectFileRoots.get(key) || [];
    for (const binding of previousBindings) releaseFileRootWatcher(binding.root, binding.options);
    watchedProjectFileRoots.delete(key);
    watchedProjectFileRootHealth.delete(key);
    mediaService.grantRoot(root);
    const bindings = [{ root, options: { publishRoot, virtualPrefix: projectPrefix }, virtualPath: '', external: false }];
    const onExternalChanged = externalTrackingChangeHandler(publishRoot, projectName);
    const managedLinksResult = virtualPaths.listManagedExternalLinks(root);
    const managedLinks = Array.isArray(managedLinksResult) ? managedLinksResult : managedLinksResult?.links || [];
    const managedLinksTruncated = Boolean(managedLinksResult?.truncated);
    for (const link of managedLinks) {
      if (link.offline) continue;
      mediaService.grantRoot(link.externalTargetRoot);
      if (link.externalTargetKind === 'file') bindings.push({ root: path.dirname(link.externalTargetRoot), options: { publishRoot, virtualPrefix: projectPrefix, fileNameFilter: link.externalTargetRoot, virtualFileName: link.shortcutVirtualPath, onChanged: onExternalChanged }, virtualPath: link.shortcutVirtualPath, external: true });
      else bindings.push({ root: link.externalTargetRoot, options: { publishRoot, virtualPrefix: [projectPrefix, link.shortcutVirtualPath].filter(Boolean).join('/'), onChanged: onExternalChanged }, virtualPath: link.shortcutVirtualPath, external: true });
    }
    const acquired = [];
    const failedRoots = [];
    if (managedLinksTruncated) failedRoots.push({ virtualPath: '', external: true, error: '外链数量超过安全枚举上限，仅监听已枚举项目' });
    for (const binding of bindings) {
      const result = acquireFileRootWatcher(binding.root, binding.options);
      if (!result.success) {
        failedRoots.push({ virtualPath: binding.virtualPath, external: binding.external, error: result.error || '无法监听此位置' });
        continue;
      }
      acquired.push(binding);
    }
    watchedProjectFileRoots.set(key, acquired);
    const offlineLinks = managedLinks.filter(link => link.offline).length;
    const externalFolderLinks = managedLinks.filter(link => link.externalTargetKind === 'folder').length;
    const mainWatched = acquired.includes(bindings[0]);
    let degraded = !mainWatched || failedRoots.length > 0 || offlineLinks > 0 || managedLinksTruncated;
    let reconciliationFailed = false;
    const supportsTrackingReconciliation = projectName !== '.__photoflow_inspiration__';
    let reconciled = false;
    const shouldReconcile = options.reconcile !== false || previousHealth?.degraded && !degraded;
    if (supportsTrackingReconciliation && shouldReconcile && mainWatched) {
      try {
        const reconciliation = await versionService.detectProgressStale(publishRoot, { projectName, changedPaths: [] });
        if (!reconciliation?.success) throw new Error(reconciliation?.error || '无法补扫版本跟踪状态');
        reconciled = true;
      } catch (error) {
        reconciliationFailed = true;
        degraded = true;
        writeLog('warn', 'Unable to reconcile tracking state after watcher install', { projectName, error: error.message || String(error) });
      }
    }
    watchedProjectFileRootHealth.set(key, { degraded });
    return {
      success: mainWatched, root: publishRoot, requiredRoots: bindings.length, watchedRoots: acquired.length,
      failedRoots, offlineLinks, externalFolderLinks, degraded, reconciled, reconciliationFailed,
      ...(managedLinksTruncated ? { warning: '外链数量超过安全枚举上限，仅监听已枚举项目；请整理或缩小外链范围' } : {}),
      ...(!mainWatched ? { error: '无法监听项目文件夹' } : {}),
    };
  };
  const refreshManagedExternalWatchersForPaths = async (workspaceRoot, restoredPaths) => {
    const managedPaths = (restoredPaths || []).filter(candidate => {
      try { return Boolean(virtualPaths.readManagedExternalLink(candidate)); }
      catch { return false; }
    });
    if (!managedPaths.length) return;
    const root = path.resolve(workspaceRoot);
    const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
    for (const project of catalog?.projects || []) {
      const projectRoot = path.resolve(root, project.relative_path || project.relativePath || '');
      if (!managedPaths.some(candidate => {
        const relative = path.relative(projectRoot, path.resolve(candidate));
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      })) continue;
      await watchProjectFileRoot(root, project.status, project.name);
    }
  };

  ipcMain.handle('workspace-watch-file-root', async (_event, workspacePath, status, projectName, options = {}) => {
    const startedAt = Date.now();
    try { return await watchProjectFileRoot(workspacePath, status, projectName, options); }
    catch (error) { return { success: false, error: error.message || String(error) }; }
    finally { logSlowWorkspaceInteraction('watch-file-root', startedAt, { projectName, reconcile: options.reconcile !== false }); }
  });

  ipcMain.handle('workspace-unwatch-file-root', async (_event, workspacePath, status, projectName) => {
    try {
      let root;
      try { root = path.resolve(getProjectPath(workspacePath, status, projectName)); }
      catch { root = path.resolve(String(workspacePath || '')); }
      const publishRoot = path.resolve(ensureWorkspace(workspacePath));
      const key = watchedProjectFileRootKey(publishRoot, status, projectName);
      const bindings = watchedProjectFileRoots.get(key) || [{ root, options: { publishRoot, virtualPrefix: path.relative(publishRoot, root).replace(/\\/g, '/') } }];
      for (const binding of bindings) releaseFileRootWatcher(binding.root, binding.options);
      watchedProjectFileRoots.delete(key);
      watchedProjectFileRootHealth.delete(key);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  const resolveManagedExternalScope = async (root, relativePath) => {
    const resolution = virtualPaths.resolve(root, relativePath, { externalRootMode: 'target' });
    if (!resolution.viaExternalLink) return null;
    return { ...resolution, currentPath: resolution.physicalPath, normalizedRelativePath: resolution.virtualPath };
  };
  registerEntryUtilityIpc({ ipcMain, findLatestPhotoshop, path, getProjectPath, resolveToolSource, fs, spawn, resolveManagedExternalScope, resolveProjectEntry, clipboard, mediaService, app });
  
  ipcMain.handle('workspace-browse-files', async (_event, workspacePath, status, projectName, relativePath = '', cacheConfig = {}) => {
    const startedAt = Date.now();
    try {
      const projectPath = getProjectPath(workspacePath, status, projectName);
      const root = path.resolve(projectPath);
      const normalizedRelativePath = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const pathSegments = normalizedRelativePath ? normalizedRelativePath.split('/') : [];
      if (pathSegments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('文件夹路径无效');
      const currentResolution = virtualPaths.resolve(root, normalizedRelativePath, { externalRootMode: 'target' });
      const currentPath = currentResolution.physicalPath;
      const mediaRoot = currentResolution.mediaRoot;
      const viaExternalLink = currentResolution.viaExternalLink;
      const currentStat = await fs.promises.stat(currentPath);
      if (!currentStat.isDirectory()) throw new Error('文件夹不存在');
      mediaService.grantRoot(mediaRoot);
      mediaRuntimeState.activeMediaCacheConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
      const directoryEntries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      const entries = directoryEntries
        .filter(entry => !entry.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(entry.name.toLowerCase()) && !isInternalFileOperationEntry(entry.name))
        .map(entry => {
          const entryPath = path.join(currentPath, entry.name);
          let displayPath = entryPath;
          let extension = entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase();
          let kind = entry.isDirectory() ? 'folder' : extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          let externalLink = false;
          let externalLinkTarget = '';
          let externalLinkTargetKind = '';
          let sourceChannel;
          if (!viaExternalLink && kind === 'shortcut') {
            try {
              const shortcut = virtualPaths.readManagedExternalLink(entryPath);
              externalLink = Boolean(shortcut);
              if (externalLink) {
                externalLinkTarget = path.resolve(String(shortcut?.target || ''));
                if (fs.existsSync(externalLinkTarget)) {
                  externalLinkTargetKind = fs.statSync(externalLinkTarget).isDirectory() ? 'folder' : 'file';
                  if (externalLinkTargetKind === 'file') {
                    displayPath = fs.realpathSync(externalLinkTarget);
                    mediaService.grantPath(displayPath);
                    extension = path.extname(externalLinkTarget).toLowerCase();
                    kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
                  }
                } else externalLinkTargetKind = shortcut.targetKindHint;
              }
            }
            catch { /* a broken or ordinary shortcut remains a regular shortcut */ }
            if (!externalLink) sourceChannel = shortcutSourceChannel(entryPath);
          }
          const virtualRelativePath = viaExternalLink
            ? [normalizedRelativePath, entry.name].filter(Boolean).join('/')
            : path.relative(root, entryPath).replace(/\\/g, '/');
          return { name: entry.name, path: displayPath, relativePath: virtualRelativePath, kind, extension, size: -1, createdAt: 0, updatedAt: 0, ...(sourceChannel ? { sourceChannel } : {}), ...(externalLink ? { externalLink: true, externalLinkTarget, externalLinkTargetKind, externalLinkOffline: !fs.existsSync(externalLinkTarget), shortcutBroken: !fs.existsSync(externalLinkTarget), viaShortcut: true, viaExternalLink: true, readOnly: false } : {}), ...(viaExternalLink ? { viaShortcut: true, viaExternalLink: true, readOnly: false } : {}) };
        })
        .sort((a, b) => (a.kind === 'folder' || a.externalLink && a.externalLinkTargetKind !== 'file' ? 0 : 1) - (b.kind === 'folder' || b.externalLink && b.externalLinkTargetKind !== 'file' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      // Index only the directory the user opened. Whole-project thumbnail and
      // version scans on every restored project tab made application startup
      // recursively read all source media; watcher events and explicit tools
      // already request the broader reconciliation when it is actually needed.
      void thumbnailService.indexDirectory(mediaRoot, currentPath, entries, mediaRuntimeState.activeMediaCacheConfig);
      logSlowWorkspaceInteraction('browse-files', startedAt, { projectName, relativePath: normalizedRelativePath, entryCount: entries.length });
      return { success: true, path: normalizedRelativePath, entries, viaExternalLink, externalLinkRootRelativePath: currentResolution.shortcutVirtualPath || undefined };
    } catch (error) {
      writeLog('warn', 'Unable to browse project directory', { projectName, relativePath, elapsedMs: Date.now() - startedAt, error: error.message || String(error) });
      const externalLinkOffline = error?.code === 'EXTERNAL_LINK_OFFLINE' || /(?:^|[\\/])[^\\/]+\.lnk(?:[\\/]|$)/i.test(String(relativePath || '')) && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR');
      return { success: false, missingDirectory: !externalLinkOffline && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR'), externalLinkOffline, error: externalLinkOffline ? '外链目标当前离线或不存在' : error.message || String(error), entries: [] };
    }
  });

  ipcMain.handle('workspace-inspect-tool-sources', async (_event, workspacePath, status, projectName, relativePaths = [], collectVideos = false, collectDirectConvertibleImages = false, collectRecursiveConvertibleImages = false) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requestedPaths = [...new Set((Array.isArray(relativePaths) ? relativePaths : [])
        .filter(value => typeof value === 'string' && value.length <= 32768))];
      if (!requestedPaths.length) return { success: true, indexed: true, hasVideo: false, hasConvertibleImage: false, videoPaths: [], convertibleImagePaths: [], folderPaths: [], sources: [] };
      if (requestedPaths.length > 4096) throw new Error('一次最多处理 4096 个所选文件或文件夹');
      const resolutions = requestedPaths.map(relativePath => resolveToolSource(root, relativePath));
      const targets = resolutions.map(item => item.physicalPath);
      const folderPaths = [];
      const sources = [];
      for (const target of targets) {
        try {
          const stat = await fs.promises.stat(target);
          if (stat.isDirectory()) {
            folderPaths.push(target);
            sources.push({ path: target, kind: 'folder' });
          } else if (stat.isFile()) sources.push({ path: target, kind: 'file' });
        } catch { /* inspectToolSources reports missing source details */ }
      }
      const targetGroups = new Map();
      resolutions.forEach((resolution, index) => {
        const inspectionRoot = path.resolve(resolution.viaExternalLink ? resolution.mediaRoot : root);
        const group = targetGroups.get(inspectionRoot) || [];
        group.push(targets[index]);
        targetGroups.set(inspectionRoot, group);
      });
      const inspectedGroups = [];
      for (const [inspectionRoot, groupTargets] of targetGroups) {
        mediaService.grantRoot(inspectionRoot);
        const result = await thumbnailService.inspectToolSources(inspectionRoot, groupTargets, collectVideos, collectDirectConvertibleImages, collectRecursiveConvertibleImages);
        inspectedGroups.push(result);
        if (!result.indexed) void thumbnailService.scanProject(inspectionRoot, mediaRuntimeState.activeMediaCacheConfig);
      }
      const indexed = inspectedGroups.every(result => result.indexed);
      const result = {
        indexed,
        hasVideo: inspectedGroups.some(item => item.hasVideo),
        hasConvertibleImage: inspectedGroups.some(item => item.hasConvertibleImage),
        videoPaths: [...new Set(inspectedGroups.flatMap(item => item.videoPaths || []))],
        convertibleImagePaths: [...new Set(inspectedGroups.flatMap(item => item.convertibleImagePaths || []))],
      };
      return { success: true, ...result, folderPaths, sources };
    } catch (error) {
      writeLog('warn', 'Unable to read project tool-source index', { projectName, error: error.message || String(error) });
      return { success: false, indexed: false, hasVideo: false, hasConvertibleImage: false, videoPaths: [], convertibleImagePaths: [], folderPaths: [], sources: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-resolve-shortcut', async (_event, workspacePath, status, projectName, relativePath = '') => {
    try {
      if (process.platform !== 'win32') throw new Error('快捷方式解析目前仅支持 Windows');
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requestedPath = assertInside(root, path.resolve(root, relativePath), '快捷方式路径');
      const shortcutPath = assertExistingInside(root, requestedPath, '快捷方式路径');
      if (path.extname(shortcutPath).toLowerCase() !== '.lnk') throw new Error('所选项目不是 Windows 快捷方式');
      const shortcutStat = await fs.promises.stat(shortcutPath);
      if (!shortcutStat.isFile()) throw new Error('快捷方式文件不存在');
      const details = shell.readShortcutLink(shortcutPath);
      const target = path.resolve(String(details?.target || ''));
      if (!details?.target) throw new Error('快捷方式没有有效目标');
      const targetStat = await fs.promises.stat(target);
      if (!targetStat.isDirectory() && !targetStat.isFile()) throw new Error('快捷方式目标类型不受支持');
      return { success: true, target, targetKind: targetStat.isDirectory() ? 'folder' : 'file' };
    } catch (error) {
      writeLog('warn', 'Unable to resolve project shortcut', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-materialize-external-links', async (_event, workspacePath, status, projectName, relativePaths = []) => {
    const moved = [];
    const workspaceRoot = ensureWorkspace(workspacePath);
    const root = path.resolve(getProjectPath(workspacePath, status, projectName));
    try {
      if (Array.isArray(relativePaths) && relativePaths.length > MAX_EXPLICIT_MATERIALIZE_PATHS) throw Object.assign(new Error(`一次最多移动 ${MAX_EXPLICIT_MATERIALIZE_PATHS} 个外链`), { code: 'MATERIALIZE_PATH_LIMIT_EXCEEDED' });
      const requested = Array.isArray(relativePaths) ? relativePaths.map(String).filter(Boolean) : [];
      if (requested.reduce((sum, candidate) => sum + Buffer.byteLength(candidate, 'utf8'), 0) > MAX_EXPLICIT_MATERIALIZE_PATH_BYTES) throw Object.assign(new Error('外链路径请求总长度过大'), { code: 'MATERIALIZE_PATH_BYTES_EXCEEDED' });
      const progressFolders = (await versionService.listProgress(workspaceRoot, projectName, true)).progressFolders || [];
      let scanTruncated = false;
      let skippedCount = 0;
      let candidates;
      if (requested.length) candidates = requested.map(relativePath => assertExistingInside(root, assertInside(root, path.resolve(root, relativePath), '外链路径'), '外链路径'));
      else {
        candidates = [];
        const pending = [{ directory: root, depth: 0 }];
        let inspected = 0;
        while (pending.length && inspected < 20000 && candidates.length < 5000) {
          const current = pending.pop();
          if (current.depth > 64) { scanTruncated = true; skippedCount += 1; continue; }
          const children = await fs.promises.readdir(current.directory, { withFileTypes: true }).catch(() => []);
          for (const child of children) {
            if (inspected++ >= 20000) { scanTruncated = true; skippedCount += 1; break; }
            const childPath = path.join(current.directory, child.name);
            const stat = await fs.promises.lstat(childPath).catch(() => null);
            if (!stat || stat.isSymbolicLink()) { skippedCount += 1; continue; }
            if (stat.isDirectory()) pending.push({ directory: childPath, depth: current.depth + 1 });
            else if (stat.isFile() && path.extname(child.name).toLowerCase() === '.lnk') candidates.push(childPath);
          }
        }
        if (pending.length || candidates.length >= 5000) scanTruncated = true;
      }
      const plan = [];
      for (const shortcutPath of candidates) {
        if (path.extname(shortcutPath).toLowerCase() !== '.lnk') continue;
        const details = virtualPaths.readManagedExternalLink(shortcutPath);
        if (!details) continue;
        const source = path.resolve(String(details.target || ''));
        const stat = await fs.promises.stat(source).catch(() => null);
        if (!stat || !stat.isDirectory() && !stat.isFile()) throw new Error(`外链不可用：${path.basename(shortcutPath, '.lnk')}`);
        const destination = uniqueDestination(path.dirname(shortcutPath), path.basename(shortcutPath, '.lnk') || path.basename(source), new Set(), stat.isDirectory());
        const copyPlan = [];
        await collectCopyPlan(source, destination, copyPlan);
        const shortcutVirtualPath = path.relative(root, shortcutPath).replace(/\\/g, '/');
        const affectedProgress = stat.isDirectory() ? progressFolders.filter(progress => progress.externalLinkRelativePath
          && (progress.externalLinkRelativePath === shortcutVirtualPath || progress.externalLinkRelativePath.startsWith(`${shortcutVirtualPath}/`)) && (() => {
          const relative = path.relative(source, path.resolve(progress.folderPath));
          return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
        })()) : [];
        const crossesVolume = path.parse(source).root.toLocaleLowerCase() !== path.parse(destination).root.toLocaleLowerCase();
        plan.push({ shortcutPath, source, destination, bytes: crossesVolume ? copyPlan.reduce((sum, item) => sum + item.size, 0) : 0, description: details.description, linkId: details.linkId, affectedProgress });
      }
      if (!plan.length) return { success: true, count: 0, items: [], truncated: scanTruncated, partial: scanTruncated, skippedCount, ...(scanTruncated ? { warning: '外链扫描达到安全上限，仍有项目未处理' } : {}) };
      await assertDiskSpace(root, plan.reduce((sum, item) => sum + item.bytes, 0));
      for (const item of plan) {
        const moveResult = await movePathAtomic(item.source, item.destination);
        try { item.destinationIdentity = moveResult?.identity || moveResult?.publishedIdentity || await captureIdentity(item.destination); }
        catch (error) { throw Object.assign(new Error(`外链内容已移动但无法确认身份，请勿重试；恢复路径：${item.destination}`), { code: 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN', outcomeUnknown: true, recoveryPath: item.destination }); }
        moved.push(item);
        await fs.promises.rm(item.shortcutPath, { force: true });
        for (const progress of item.affectedProgress) {
          const relative = path.relative(item.source, path.resolve(progress.folderPath));
          const relocatedPath = relative ? path.join(item.destination, relative) : item.destination;
          const updated = await versionService.registerProgress(workspaceRoot, {
            projectName,
            progressId: progress.id,
            mediaKind: progress.mediaKind,
            versionKey: progress.versionKey,
            parentProgressId: progress.parentProgressId,
            displayName: progress.displayName,
            folderPath: relocatedPath,
            trackingEnabled: progress.trackingEnabled,
            trackingState: progress.trackingState,
            nodeRole: progress.nodeRole,
            relationKind: progress.relationKind,
            renameFromParent: progress.renameFromParent,
            copyMissingFromParent: progress.copyMissingFromParent,
          });
          if (!updated?.success) throw new Error(updated?.error || `无法更新版本目录：${progress.displayName}`);
        }
      }
      for (const item of moved) detachManagedExternalWatcher(workspacePath, status, projectName, path.relative(root, item.shortcutPath).replace(/\\/g, '/'));
      mainWindow?.webContents.send('workspace-files-changed', { root, fileName: '', eventType: 'rename' });
      virtualPaths.revokeManagedExternalLinkIds(moved.map(item => item.linkId));
      return { success: true, count: moved.length, items: moved, truncated: scanTruncated, partial: scanTruncated, skippedCount, ...(scanTruncated ? { warning: '仅处理了安全扫描上限内的外链，刷新后仍会显示其余外链' } : {}) };
    } catch (error) {
      if (error?.outcomeUnknown) return { success: false, count: moved.length, items: moved, error: error.message, errorCode: error.code, outcomeUnknown: true, recoveryPath: error.recoveryPath, truncated: false };
      for (const item of [...moved].reverse()) {
        try {
          if (fs.existsSync(item.destination) && !fs.existsSync(item.source) && await identityMatches(item.destination, item.destinationIdentity)) await movePathAtomic(item.destination, item.source);
          if (!fs.existsSync(item.shortcutPath)) shell.writeShortcutLink(item.shortcutPath, { target: item.source, cwd: item.source, description: item.description });
          for (const progress of item.affectedProgress || []) {
            await versionService.registerProgress(workspaceRoot, {
              projectName,
              progressId: progress.id,
              mediaKind: progress.mediaKind,
              versionKey: progress.versionKey,
              parentProgressId: progress.parentProgressId,
              displayName: progress.displayName,
              folderPath: progress.folderPath,
              externalLinkRelativePath: progress.externalLinkRelativePath || undefined,
              trackingEnabled: progress.trackingEnabled,
              trackingState: progress.trackingState,
              nodeRole: progress.nodeRole,
              relationKind: progress.relationKind,
              renameFromParent: progress.renameFromParent,
              copyMissingFromParent: progress.copyMissingFromParent,
            });
          }
          attachManagedExternalWatcher(workspacePath, status, projectName, root, path.relative(root, item.shortcutPath).replace(/\\/g, '/'), item.source);
        } catch (rollbackError) { writeLog('error', 'Unable to roll back external-link materialization', { item, error: rollbackError.message || String(rollbackError) }); }
      }
      return { success: false, count: 0, items: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-relink-external-folder', async (_event, workspacePath, status, projectName, relativePath) => {
    const workspaceRoot = ensureWorkspace(workspacePath);
    const root = path.resolve(getProjectPath(workspacePath, status, projectName));
    const updatedProgress = [];
    let resolution;
    let nextTarget = '';
    try {
      try {
        resolution = virtualPaths.resolve(root, relativePath, { externalRootMode: 'link' });
      } catch (error) {
        // Links created by builds before managed identities existed are never
        // granted access automatically. They can only be upgraded after the
        // user explicitly chooses the target again in the system picker.
        const shortcutPath = assertExistingInside(root, assertInside(root, path.resolve(root, String(relativePath || '')), '旧版外链路径'), '旧版外链路径');
        const details = shell.readShortcutLink(shortcutPath);
        const description = String(details?.description || '');
        const targetKindHint = description.startsWith(MANAGED_EXTERNAL_FOLDER_PREFIX) ? 'folder'
          : description.startsWith(MANAGED_EXTERNAL_FILE_PREFIX) ? 'file' : '';
        if (!targetKindHint) throw error;
        resolution = {
          isExternalLinkRoot: true,
          shortcutPath,
          shortcutVirtualPath: path.relative(root, shortcutPath).replace(/\\/g, '/'),
          externalTargetRoot: path.resolve(String(details?.target || root)),
          externalTargetKind: targetKindHint,
          externalDisplayName: path.basename(shortcutPath, path.extname(shortcutPath)),
        };
      }
      if (!resolution.isExternalLinkRoot || !resolution.shortcutPath) throw new Error('只能重新定位 PhotoFlow 外链根文件夹');
      const targetKind = resolution.externalTargetKind === 'file' ? 'file' : 'folder';
      const choice = await dialog.showOpenDialog(mainWindow, { title: `重新定位外链“${resolution.externalDisplayName}”`, properties: [targetKind === 'file' ? 'openFile' : 'openDirectory'] });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true };
      nextTarget = path.resolve(choice.filePaths[0]);
      const targetStat = await fs.promises.stat(nextTarget).catch(() => null);
      if (!targetStat || (targetKind === 'file' ? !targetStat.isFile() : !targetStat.isDirectory())) throw new Error(`新的外链目标不是可用${targetKind === 'file' ? '文件' : '文件夹'}`);
      const oldTarget = path.resolve(resolution.externalTargetRoot);
      const progressFolders = (await versionService.listProgress(workspaceRoot, projectName, true)).progressFolders || [];
      const affectedProgress = targetKind === 'folder' ? progressFolders.filter(progress => progress.externalLinkRelativePath
        && (progress.externalLinkRelativePath === resolution.shortcutVirtualPath || progress.externalLinkRelativePath.startsWith(`${resolution.shortcutVirtualPath}/`)) && (() => {
        const relative = path.relative(oldTarget, path.resolve(progress.folderPath));
        return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
      })()) : [];
      for (const progress of affectedProgress) {
        const relative = path.relative(oldTarget, path.resolve(progress.folderPath));
        const folderPath = relative ? path.join(nextTarget, relative) : nextTarget;
        const updated = await versionService.registerProgress(workspaceRoot, {
          projectName, progressId: progress.id, mediaKind: progress.mediaKind, versionKey: progress.versionKey,
          parentProgressId: progress.parentProgressId, displayName: progress.displayName, folderPath,
          externalLinkRelativePath: progress.externalLinkRelativePath || resolution.shortcutVirtualPath,
          trackingEnabled: progress.trackingEnabled, trackingState: progress.trackingState,
          nodeRole: progress.nodeRole, relationKind: progress.relationKind,
          renameFromParent: progress.renameFromParent, copyMissingFromParent: progress.copyMissingFromParent,
        });
        if (!updated?.success) throw new Error(updated?.error || `无法更新版本节点：${progress.displayName}`);
        updatedProgress.push(progress);
      }
      const pendingShortcut = path.join(path.dirname(resolution.shortcutPath), `.photoflow-relink-${crypto.randomUUID()}.lnk`);
      const backupShortcut = path.join(path.dirname(resolution.shortcutPath), `.photoflow-relink-backup-${crypto.randomUUID()}.lnk`);
      let createdLinkId = '';
      let relinkCommitted = false;
      let pendingOwnership = null;
      let backupOwnership = null;
      let installedOwnership = null;
      try {
        const createdLink = virtualPaths.createManagedExternalLink(pendingShortcut, { target: nextTarget, kind: targetKind, displayName: resolution.externalDisplayName });
        createdLinkId = createdLink.linkId;
        try { pendingOwnership = { created: true, identity: createdLink.identity || await captureIdentity(pendingShortcut) }; }
        catch (error) { throw Object.assign(new Error(`新外链已创建但无法确认身份，请勿重试；恢复路径：${pendingShortcut}`), { code: 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN', outcomeUnknown: true, recoveryPath: pendingShortcut }); }
        await fs.promises.rename(resolution.shortcutPath, backupShortcut);
        try { backupOwnership = { created: true, identity: await captureIdentity(backupShortcut) }; }
        catch (error) {
          try {
            if (!fs.existsSync(resolution.shortcutPath)) await fs.promises.rename(backupShortcut, resolution.shortcutPath);
          } catch (restoreError) {
            throw Object.assign(new Error(`旧外链已隔离但无法确认或恢复，请勿重试；恢复路径：${backupShortcut}`), { code: 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN', outcomeUnknown: true, recoveryPath: backupShortcut, cause: restoreError });
          }
          throw new Error(`无法确认外链备份身份，原外链已恢复：${error.message || String(error)}`);
        }
        try {
          await fs.promises.rename(pendingShortcut, resolution.shortcutPath);
          installedOwnership = { created: true, identity: pendingOwnership.identity };
          if (resolution.linkId) virtualPaths.revokeManagedExternalLinkIds([resolution.linkId]);
          await removeIfOwned(backupShortcut, backupOwnership).catch(cleanupError => writeLog('warn', 'Unable to remove relink backup shortcut', { backupShortcut, recoveryPath: cleanupError.recoveryPath, error: cleanupError.message || String(cleanupError) }));
          relinkCommitted = true;
        } catch (error) {
          if (fs.existsSync(resolution.shortcutPath)) await removeIfOwned(resolution.shortcutPath, installedOwnership).catch(() => undefined);
          if (fs.existsSync(backupShortcut) && await identityMatches(backupShortcut, backupOwnership?.identity) && !fs.existsSync(resolution.shortcutPath)) await fs.promises.rename(backupShortcut, resolution.shortcutPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (!relinkCommitted && createdLinkId) virtualPaths.revokeManagedExternalLinkIds([createdLinkId]);
        throw error;
      } finally {
        await removeIfOwned(pendingShortcut, pendingOwnership).catch(() => undefined);
      }
      let warning;
      let watchDegraded = false;
      try {
        const attached = attachManagedExternalWatcher(workspacePath, status, projectName, root, resolution.shortcutVirtualPath, nextTarget);
        if (attached?.success === false) throw new Error(attached.error || '无法监听新的外链目标');
      } catch (watchError) {
        watchDegraded = true;
        warning = '外链已重新定位，但目录监听刷新失败';
        writeLog('warn', 'Unable to refresh external watcher after relink', { relativePath, error: watchError.message || String(watchError) });
      }
      try { mainWindow?.webContents.send('workspace-files-changed', { root: workspaceRoot, fileName: path.relative(workspaceRoot, resolution.shortcutPath).replace(/\\/g, '/'), eventType: 'rename' }); }
      catch (sendError) { warning = warning || '外链已重新定位，但页面刷新通知失败'; writeLog('warn', 'Unable to publish committed external relink change', sendError); }
      return { success: true, relativePath: resolution.shortcutVirtualPath, target: nextTarget, updatedProgressCount: updatedProgress.length, watchDegraded, warning };
    } catch (error) {
      if (resolution && updatedProgress.length) for (const progress of [...updatedProgress].reverse()) {
        await versionService.registerProgress(workspaceRoot, {
          projectName, progressId: progress.id, mediaKind: progress.mediaKind, versionKey: progress.versionKey,
          parentProgressId: progress.parentProgressId, displayName: progress.displayName, folderPath: progress.folderPath,
          externalLinkRelativePath: progress.externalLinkRelativePath || resolution.shortcutVirtualPath,
          trackingEnabled: progress.trackingEnabled, trackingState: progress.trackingState,
          nodeRole: progress.nodeRole, relationKind: progress.relationKind,
          renameFromParent: progress.renameFromParent, copyMissingFromParent: progress.copyMissingFromParent,
        }).catch(rollbackError => writeLog('error', 'Unable to roll back external relink version path', { progressId: progress.id, error: rollbackError.message || String(rollbackError) }));
      }
      return { success: false, error: error.message || String(error), errorCode: error?.code || undefined, outcomeUnknown: Boolean(error?.outcomeUnknown), recoveryPath: error?.recoveryPath };
    }
  });

  ipcMain.handle('workspace-browse-shortcut-preview', async (_event, workspacePath, status, projectName, relativePath = '') => {
    const timeoutMs = 2000;
    const withShortcutTimeout = (operation, code = 'SHORTCUT_TARGET_OFFLINE') => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('快捷方式目标暂时不可用'), { code })), timeoutMs);
      Promise.resolve(operation).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    try {
      if (process.platform !== 'win32') throw Object.assign(new Error('快捷方式预览目前仅支持 Windows'), { code: 'SHORTCUT_UNSUPPORTED' });
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw Object.assign(new Error('快捷方式相对路径无效'), { code: 'SHORTCUT_INVALID' });
      let requestedPath;
      try { requestedPath = assertInside(root, path.resolve(root, relativePath), '快捷方式路径'); }
      catch { throw Object.assign(new Error('快捷方式路径超出项目范围'), { code: 'SHORTCUT_INVALID' }); }
      let shortcutPath;
      try { shortcutPath = assertExistingInside(root, requestedPath, '快捷方式路径'); }
      catch { throw Object.assign(new Error('快捷方式文件不存在'), { code: 'SHORTCUT_INVALID' }); }
      if (path.extname(shortcutPath).toLowerCase() !== '.lnk') throw Object.assign(new Error('所选项目不是 Windows 快捷方式'), { code: 'SHORTCUT_INVALID' });
      const shortcutStat = await fs.promises.stat(shortcutPath);
      if (!shortcutStat.isFile()) throw Object.assign(new Error('快捷方式文件不存在'), { code: 'SHORTCUT_INVALID' });

      const visited = new Set([shortcutPath.toLocaleLowerCase()]);
      let target = shortcutPath;
      for (let depth = 0; depth < 8; depth += 1) {
        const details = shell.readShortcutLink(target);
        if (!details?.target) throw Object.assign(new Error('快捷方式没有有效目标'), { code: 'SHORTCUT_INVALID' });
        target = path.resolve(String(details.target));
        if (path.extname(target).toLowerCase() !== '.lnk') break;
        const key = target.toLocaleLowerCase();
        if (visited.has(key)) throw Object.assign(new Error('检测到循环快捷方式'), { code: 'SHORTCUT_LOOP' });
        visited.add(key);
        if (depth === 7) throw Object.assign(new Error('快捷方式链过深'), { code: 'SHORTCUT_LOOP' });
      }

      const targetStat = await withShortcutTimeout(fs.promises.stat(target));
      if (targetStat.isFile()) return { success: true, targetKind: 'file', entries: [] };
      if (!targetStat.isDirectory()) throw Object.assign(new Error('快捷方式目标类型不受支持'), { code: 'SHORTCUT_INVALID' });
      const children = await withShortcutTimeout(fs.promises.readdir(target, { withFileTypes: true }));
      mediaService.grantRoot(target);
      const previewLimit = 12;
      const maximumInspectedPreviewChildren = 240;
      const entries = [];
      let inspectedChildren = 0;
      for (const child of children) {
        if (entries.length >= previewLimit || inspectedChildren >= maximumInspectedPreviewChildren) break;
        inspectedChildren += 1;
        if (child.isSymbolicLink() || child.isDirectory() || !child.isFile()) continue;
        const childPath = path.join(target, child.name);
        let stat;
        try { stat = await withShortcutTimeout(fs.promises.stat(childPath)); }
        catch { continue; }
        const extension = path.extname(child.name).toLowerCase();
        const kind = extension === '.lnk' ? 'shortcut'
          : IMAGE_EXTENSIONS.has(extension) ? 'image'
            : RAW_EXTENSIONS.has(extension) ? 'raw'
              : VIDEO_EXTENSIONS.has(extension) ? 'video' : 'file';
        entries.push({ name: child.name, path: childPath, relativePath: child.name, kind, extension, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs || 0, updatedAt: stat.mtimeMs || 0, readOnly: true, viaShortcut: true });
      }
      return { success: true, targetKind: 'folder', entries, truncated: inspectedChildren < children.length };
    } catch (error) {
      const errorCode = error?.code === 'EACCES' || error?.code === 'EPERM' ? 'SHORTCUT_ACCESS_DENIED'
        : error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'SHORTCUT_TARGET_MISSING'
          : String(error?.code || '').startsWith('SHORTCUT_') ? error.code : 'SHORTCUT_TARGET_OFFLINE';
      writeLog('warn', 'Unable to browse project shortcut preview', { projectName, relativePath, errorCode, error: error.message || String(error) });
      return { success: false, targetKind: null, entries: [], errorCode, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-search-files', async (_event, workspacePath, status, projectName, scopeRelativePath = '', query = '') => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const externalScope = await resolveManagedExternalScope(root, scopeRelativePath);
      const requestedScope = externalScope ? externalScope.currentPath : assertInside(root, path.resolve(root, scopeRelativePath || '.'), '搜索范围', true);
      const scope = externalScope ? requestedScope : assertExistingInside(root, requestedScope, '搜索范围', true);
      const scopeStat = await fs.promises.stat(scope);
      if (!scopeStat.isDirectory()) throw new Error('搜索范围不是文件夹');
      mediaService.grantRoot(externalScope?.mediaRoot || root);
      const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
      const entries = [];
      const pending = [{ directory: scope, boundary: await fs.promises.realpath(scope), depth: 0, virtualPath: externalScope?.normalizedRelativePath || path.relative(root, scope).replace(/\\/g, '/'), viaExternalLink: Boolean(externalScope) }];
      const visited = new Set();
      const maximumDepth = 64;
      const maximumDirectories = 5000;
      const maximumInspectedEntries = 100000;
      const maximumResults = 2000;
      let inspectedEntries = 0;
      let scannedDirectories = 0;
      let skippedCount = 0;
      let truncated = false;
      const managedShortcutPaths = new Set();
      const managedLinkScan = externalScope ? { links: [], truncated: false, skippedCount: 0 } : await listManagedExternalLinksBounded(root);
      truncated ||= managedLinkScan.truncated;
      skippedCount += managedLinkScan.skippedCount;
      if (!externalScope) for (const link of managedLinkScan.links) {
        if (link.offline || !path.relative(scope, link.shortcutPath) || path.relative(scope, link.shortcutPath).startsWith('..')) continue;
        managedShortcutPaths.add(path.resolve(link.shortcutPath).toLocaleLowerCase());
        if (link.externalTargetKind === 'file') {
          mediaService.grantPath(link.externalTargetRoot);
          const stat = await fs.promises.stat(link.externalTargetRoot);
          const extension = path.extname(link.externalTargetRoot).toLowerCase();
          const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          const name = path.basename(link.shortcutPath);
          if (!needle || name.toLocaleLowerCase('zh-CN').includes(needle) || path.basename(link.externalTargetRoot).toLocaleLowerCase('zh-CN').includes(needle)) entries.push({ name, path: link.externalTargetRoot, relativePath: link.shortcutVirtualPath, kind, extension, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs || 0, updatedAt: stat.mtimeMs || 0, externalLink: true, externalLinkTarget: link.externalTargetRoot, externalLinkTargetKind: 'file', viaShortcut: true, viaExternalLink: true, readOnly: false });
        } else {
          mediaService.grantRoot(link.externalTargetRoot);
          pending.push({ directory: link.externalTargetRoot, boundary: await fs.promises.realpath(link.externalTargetRoot), depth: 0, virtualPath: link.shortcutVirtualPath, viaExternalLink: true });
        }
      }
      while (pending.length) {
        const current = pending.pop();
        if (current.depth > maximumDepth || scannedDirectories >= maximumDirectories || inspectedEntries >= maximumInspectedEntries || entries.length >= maximumResults) { truncated = true; skippedCount += 1; continue; }
        const directory = current.directory;
        let directoryReal;
        try { directoryReal = await fs.promises.realpath(directory); } catch { skippedCount += 1; continue; }
        const containment = path.relative(current.boundary, directoryReal);
        if (containment.startsWith('..') || path.isAbsolute(containment)) { skippedCount += 1; continue; }
        const directoryStat = await fs.promises.lstat(directory, { bigint: true }).catch(() => null);
        if (!directoryStat || directoryStat.isSymbolicLink()) { skippedCount += 1; continue; }
        const directoryIdentity = `${directoryStat.dev}:${directoryStat.ino}`;
        if (visited.has(directoryIdentity)) { skippedCount += 1; continue; }
        visited.add(directoryIdentity);
        scannedDirectories += 1;
        let children;
        try {
          children = await fs.promises.readdir(directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a project search directory', { directory, error: error.message || String(error) });
          continue;
        }
        for (const child of children) {
          if (inspectedEntries++ >= maximumInspectedEntries || entries.length >= maximumResults) { truncated = true; skippedCount += 1; break; }
          if (HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) || isInternalFileOperationEntry(child.name)) continue;
          const childPath = path.join(directory, child.name);
          const childStat = await fs.promises.lstat(childPath).catch(() => null);
          if (!childStat || childStat.isSymbolicLink()) { skippedCount += 1; continue; }
          if (managedShortcutPaths.has(path.resolve(childPath).toLocaleLowerCase())) continue;
          if (childStat.isDirectory()) {
            pending.push({ directory: childPath, boundary: current.boundary, depth: current.depth + 1, virtualPath: [current.virtualPath, child.name].filter(Boolean).join('/'), viaExternalLink: current.viaExternalLink });
            if (!needle || child.name.toLocaleLowerCase('zh-CN').includes(needle)) {
              entries.push({ name: child.name, path: childPath, relativePath: [current.virtualPath, child.name].filter(Boolean).join('/'), kind: 'folder', extension: '', size: -1, createdAt: 0, updatedAt: 0, ...(current.viaExternalLink ? { viaShortcut: true, viaExternalLink: true, readOnly: false } : {}) });
            }
            continue;
          }
          if (!childStat.isFile() || needle && !child.name.toLocaleLowerCase('zh-CN').includes(needle)) continue;
          const extension = path.extname(child.name).toLowerCase();
          const kind = extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          const sourceChannel = kind === 'shortcut' && !current.viaExternalLink ? shortcutSourceChannel(childPath) : undefined;
          entries.push({ name: child.name, path: childPath, relativePath: [current.virtualPath, child.name].filter(Boolean).join('/'), kind, extension, size: -1, createdAt: 0, updatedAt: 0, ...(sourceChannel ? { sourceChannel } : {}), ...(current.viaExternalLink ? { viaShortcut: true, viaExternalLink: true, readOnly: false } : {}) });
        }
      }
      entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      return { success: true, scope: externalScope?.normalizedRelativePath || path.relative(root, scope).replace(/\\/g, '/'), entries, viaExternalLink: Boolean(externalScope), truncated, skippedCount, scannedDirectories, inspectedEntries };
    } catch (error) {
      writeLog('warn', 'Unable to search project files', { projectName, scopeRelativePath, error: error.message || String(error) });
      return { success: false, entries: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-list-files', async (_event, workspacePath, status, projectName, scopeRelativePath = '', requestedPageSize = 120, requestedCursor = '', requestedFilter = {}) => {
    let releaseCursor = () => undefined;
    try {
      releaseCursor = await acquireCursorLock(fileListCursorLocks, String(requestedCursor || ''));
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const externalScope = await resolveManagedExternalScope(root, scopeRelativePath);
      const requestedScope = externalScope ? externalScope.currentPath : assertInside(root, path.resolve(root, scopeRelativePath || '.'), '文件枚举范围', true);
      const scope = externalScope ? requestedScope : assertExistingInside(root, requestedScope, '文件枚举范围', true);
      const scopeStat = await fs.promises.stat(scope);
      if (!scopeStat.isDirectory()) throw new Error('文件枚举范围不是文件夹');
      if (externalScope) mediaService.grantRoot(externalScope.mediaRoot);
      const pageSize = Math.min(200, Math.max(1, Number(requestedPageSize) || 120));
      const filter = normalizeProjectFileListFilter(requestedFilter);
      pruneFileListSessions();
      let cursor = String(requestedCursor || '');
      if (cursor && cancelledFileListCursors.has(cursor)) throw Object.assign(new Error('文件枚举已取消'), { code: fileListCancelledCode });
      let session = cursor ? fileListSessions.get(cursor) : null;
      if (cursor && !projectFileListSessionMatches(session, root, scope, filter)) {
        throw Object.assign(new Error('文件枚举会话已失效'), { code: fileListSessionExpiredCode });
      }
      if (!session) {
        while (fileListSessions.size >= 16) {
          const oldest = [...fileListSessions.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
          if (!oldest) break;
          fileListSessions.delete(oldest[0]);
        }
        cursor = crypto.randomUUID();
        session = {
          root,
          scope,
          filterSignature: filter.signature,
          filter,
          pending: [{ directory: scope, boundary: await fs.promises.realpath(scope), depth: 0, offset: 0, virtualPath: externalScope?.normalizedRelativePath || path.relative(root, scope).replace(/\\/g, '/'), viaExternalLink: Boolean(externalScope) }],
          visitedDirectories: new Set(),
          externalFiles: [],
          managedShortcutPaths: new Set(),
          scannedDirectories: 0,
          inspectedEntries: 0,
          touchedAt: Date.now(),
        };
        const managedLinkScan = externalScope ? { links: [], truncated: false, skippedCount: 0 } : await listManagedExternalLinksBounded(root);
        session.managedLinksTruncated = managedLinkScan.truncated;
        session.managedLinksSkippedCount = managedLinkScan.skippedCount;
        if (!externalScope) for (const link of managedLinkScan.links) {
          const relativeLink = path.relative(scope, link.shortcutPath);
          if (link.offline || !relativeLink || relativeLink.startsWith('..') || path.isAbsolute(relativeLink)) continue;
          session.managedShortcutPaths.add(comparablePath(link.shortcutPath));
          if (link.externalTargetKind === 'file') {
            mediaService.grantPath(link.externalTargetRoot);
            session.externalFiles.push(link);
          } else {
            mediaService.grantRoot(link.externalTargetRoot);
            session.pending.push({ directory: link.externalTargetRoot, boundary: await fs.promises.realpath(link.externalTargetRoot), depth: 0, offset: 0, virtualPath: link.shortcutVirtualPath, viaExternalLink: true });
          }
        }
        fileListSessions.set(cursor, session);
      }
      session.touchedAt = Date.now();
      const maximumDirectoriesPerPage = 32;
      const maximumInspectedEntriesPerPage = 1000;
      let pageScannedDirectories = 0;
      let pageInspectedEntries = 0;
      const entries = [];
      while (session.externalFiles?.length && entries.length < pageSize) {
        const link = session.externalFiles.shift();
        const stat = await fs.promises.stat(link.externalTargetRoot).catch(() => null);
        if (!stat?.isFile()) continue;
        const extension = path.extname(link.externalTargetRoot).toLowerCase();
        const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
        const name = path.basename(link.shortcutPath);
        if (!projectFileListEntryMatchesFilter(name, kind, extension, session.filter) && !projectFileListEntryMatchesFilter(path.basename(link.externalTargetRoot), kind, extension, session.filter)) continue;
        entries.push({ name, path: link.externalTargetRoot, relativePath: link.shortcutVirtualPath, parentRelativePath: path.posix.dirname(link.shortcutVirtualPath) === '.' ? '' : path.posix.dirname(link.shortcutVirtualPath), parentName: path.basename(path.dirname(link.shortcutPath)), kind, extension, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs || 0, updatedAt: stat.mtimeMs || 0, externalLink: true, externalLinkTarget: link.externalTargetRoot, externalLinkTargetKind: 'file', viaShortcut: true, viaExternalLink: true, readOnly: false });
      }
      while (session.pending.length && entries.length < pageSize && pageScannedDirectories < maximumDirectoriesPerPage && pageInspectedEntries < maximumInspectedEntriesPerPage) {
        if (session.cancelled) throw Object.assign(new Error('文件枚举已取消'), { code: fileListCancelledCode });
        const current = session.pending.shift();
        if (current.depth > 64) continue;
        const directoryReal = await fs.promises.realpath(current.directory).catch(() => '');
        const containment = directoryReal ? path.relative(current.boundary, directoryReal) : '..';
        if (!directoryReal || containment.startsWith('..') || path.isAbsolute(containment)) continue;
        const directoryStat = await fs.promises.lstat(current.directory, { bigint: true }).catch(() => null);
        if (!directoryStat || directoryStat.isSymbolicLink()) continue;
        const directoryIdentity = `${directoryStat.dev}:${directoryStat.ino}`;
        if (session.visitedDirectories.has(directoryIdentity) && !current.offset) continue;
        session.visitedDirectories.add(directoryIdentity);
        pageScannedDirectories += 1;
        session.scannedDirectories += 1;
        let children;
        try {
          children = await fs.promises.readdir(current.directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a file-list directory', { directory: current.directory, error: error.message || String(error) });
          continue;
        }
        const visibleChildren = children
          .filter(child => !child.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) && !isInternalFileOperationEntry(child.name))
          .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        let offset = Math.max(0, Number(current.offset) || 0);
        for (; offset < visibleChildren.length && entries.length < pageSize && pageInspectedEntries < maximumInspectedEntriesPerPage; offset += 1) {
          const child = visibleChildren[offset];
          const childPath = path.join(current.directory, child.name);
          if (session.managedShortcutPaths?.has(comparablePath(childPath))) continue;
          pageInspectedEntries += 1;
          session.inspectedEntries += 1;
          let stat;
          try { stat = await fs.promises.lstat(childPath); }
          catch (error) {
            writeLog('warn', 'Unable to inspect a file-list entry', { path: childPath, error: error.message || String(error) });
            continue;
          }
          if (session.cancelled) throw Object.assign(new Error('文件枚举已取消'), { code: fileListCancelledCode });
          if (stat.isDirectory()) {
            session.pending.push({ directory: childPath, boundary: current.boundary, depth: current.depth + 1, offset: 0, virtualPath: [current.virtualPath, child.name].filter(Boolean).join('/'), viaExternalLink: current.viaExternalLink });
            continue;
          }
          if (!stat.isFile()) continue;
          const extension = path.extname(child.name).toLowerCase();
          const kind = extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          if (!projectFileListEntryMatchesFilter(child.name, kind, extension, session.filter)) continue;
          const relativePath = [current.virtualPath, child.name].filter(Boolean).join('/');
          const parentRelativePath = current.virtualPath;
          const sourceChannel = kind === 'shortcut' && !current.viaExternalLink ? shortcutSourceChannel(childPath) : undefined;
          entries.push({ name: child.name, path: childPath, relativePath, parentRelativePath, parentName: path.basename(current.directory), kind, extension, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs || 0, updatedAt: stat.mtimeMs || 0, ...(sourceChannel ? { sourceChannel } : {}), ...(current.viaExternalLink ? { viaShortcut: true, viaExternalLink: true, readOnly: false } : {}) });
        }
        if (offset < visibleChildren.length) session.pending.unshift({ ...current, offset });
      }
      if (session.cancelled) throw Object.assign(new Error('文件枚举已取消'), { code: fileListCancelledCode });
      const hasMore = session.pending.length > 0 || Boolean(session.externalFiles?.length);
      if (!hasMore) fileListSessions.delete(cursor);
      return { success: true, scope: externalScope?.normalizedRelativePath || path.relative(root, scope).replace(/\\/g, '/'), entries, cursor: hasMore ? cursor : undefined, hasMore, truncated: hasMore || Boolean(session.managedLinksTruncated), skippedCount: session.managedLinksSkippedCount || 0, scannedDirectories: session.scannedDirectories, inspectedEntries: session.inspectedEntries, viaExternalLink: Boolean(externalScope) };
    } catch (error) {
      writeLog('warn', 'Unable to list project files', { projectName, scopeRelativePath, error: error.message || String(error) });
      return { success: false, entries: [], error: error.message || String(error), errorCode: error?.code === fileListCancelledCode || error?.code === fileListSessionExpiredCode ? error.code : undefined };
    } finally { releaseCursor(); }
  });

  ipcMain.handle('workspace-cancel-list-files', async (_event, requestedCursor = '') => {
    pruneFileListSessions();
    const cursor = String(requestedCursor || '');
    if (!cursor || !fileListSessions.has(cursor)) return { success: false, errorCode: fileListSessionExpiredCode, error: '文件枚举会话已失效' };
    fileListSessions.get(cursor).cancelled = true;
    fileListSessions.delete(cursor);
    cancelledFileListCursors.set(cursor, Date.now());
    return { success: true };
  });

  ipcMain.handle('workspace-recent-files', async (_event, workspacePath, status, projectName, scopeRelativePath = '', requestedLimit = 120, requestedCursor = '') => {
    let releaseCursor = () => undefined;
    try {
      releaseCursor = await acquireCursorLock(recentCursorLocks, String(requestedCursor || ''));
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const externalScope = await resolveManagedExternalScope(root, scopeRelativePath);
      const requestedScope = externalScope ? externalScope.currentPath : assertInside(root, path.resolve(root, scopeRelativePath || '.'), '最近文件范围', true);
      const scope = externalScope ? requestedScope : assertExistingInside(root, requestedScope, '最近文件范围', true);
      const scopeStat = await fs.promises.stat(scope);
      if (!scopeStat.isDirectory()) throw new Error('最近文件范围不是文件夹');
      mediaService.grantRoot(externalScope?.mediaRoot || root);
      const pageSize = Math.min(240, Math.max(1, Number(requestedLimit) || 120));
      pruneRecentFileSessions();
      let cursor = String(requestedCursor || '');
      let session = cursor ? recentFileSessions.get(cursor) : null;
      if (cursor && (!session || session.root !== root || session.scope !== scope)) {
        throw Object.assign(new Error('递归显示会话已失效，正在自动重新加载'), { code: recentFilesSessionExpiredCode });
      }
      if (!session) {
        while (recentFileSessions.size >= 16) {
          const oldest = [...recentFileSessions.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
          if (!oldest) break;
          recentFileSessions.delete(oldest[0]);
        }
        cursor = crypto.randomUUID();
        session = {
          root,
          scope,
          pending: [{ directory: scope, priority: Number.MAX_SAFE_INTEGER, offset: 0, virtualPath: externalScope?.normalizedRelativePath || path.relative(root, scope).replace(/\\/g, '/'), viaShortcut: Boolean(externalScope), viaExternalLink: Boolean(externalScope) }],
          visitedDirectories: new Set([path.resolve(scope).toLowerCase()]),
          candidates: [],
          scannedDirectories: 0,
          inspectedEntries: 0,
          touchedAt: Date.now(),
        };
        recentFileSessions.set(cursor, session);
      }
      if (!session.visitedDirectories) {
        session.visitedDirectories = new Set([
          path.resolve(scope).toLowerCase(),
          ...session.pending.map(candidate => path.resolve(candidate.directory).toLowerCase()),
        ]);
      }
      session.touchedAt = Date.now();
      const maximumDirectoriesPerPage = 64;
      const maximumInspectedEntriesPerPage = 4000;
      let pageScannedDirectories = 0;
      let pageInspectedEntries = 0;
      while (session.pending.length && pageScannedDirectories < maximumDirectoriesPerPage && pageInspectedEntries < maximumInspectedEntriesPerPage) {
        if (session.cancelled) throw Object.assign(new Error('最近文件会话已取消'), { code: recentFilesSessionExpiredCode });
        session.pending.sort((left, right) => right.priority - left.priority);
        const current = session.pending.shift();
        let children;
        try {
          children = await fs.promises.readdir(current.directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a recent-files directory', { directory: current.directory, error: error.message || String(error) });
          continue;
        }
        pageScannedDirectories += 1;
        session.scannedDirectories += 1;
        const allVisibleChildren = children
          .filter(child => !child.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) && !isInternalFileOperationEntry(child.name));
        const startOffset = Math.max(0, Number(current.offset) || 0);
        const visibleChildren = allVisibleChildren.slice(startOffset, startOffset + Math.max(0, maximumInspectedEntriesPerPage - pageInspectedEntries));
        if (startOffset + visibleChildren.length < allVisibleChildren.length) {
          session.pending.push({ ...current, offset: startOffset + visibleChildren.length });
        }
        pageInspectedEntries += visibleChildren.length;
        session.inspectedEntries += visibleChildren.length;
        for (let offset = 0; offset < visibleChildren.length; offset += 64) {
          const batch = visibleChildren.slice(offset, offset + 64);
          const inspected = await Promise.all(batch.map(async child => {
            const childPath = path.join(current.directory, child.name);
            try {
              return { child, childPath, stat: await fs.promises.stat(childPath) };
            } catch (error) {
              writeLog('warn', 'Unable to inspect a recent-files entry', { path: childPath, error: error.message || String(error) });
              return null;
            }
          }));
          if (session.cancelled) throw Object.assign(new Error('最近文件会话已取消'), { code: recentFilesSessionExpiredCode });
          for (const item of inspected) {
            if (!item) continue;
            const virtualRelativePath = [current.virtualPath, item.child.name].filter(Boolean).join('/');
            if (item.stat.isDirectory()) {
              const directoryKey = path.resolve(item.childPath).toLowerCase();
              if (!session.visitedDirectories.has(directoryKey)) {
                session.visitedDirectories.add(directoryKey);
                session.pending.push({ directory: item.childPath, priority: item.stat.mtimeMs || item.stat.birthtimeMs || 0, offset: 0, virtualPath: virtualRelativePath, viaShortcut: current.viaShortcut, viaExternalLink: current.viaExternalLink });
              }
              continue;
            }
            if (!item.stat.isFile()) continue;
            let extension = path.extname(item.child.name).toLowerCase();
            let kind = extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
            let externalLink = false;
            let shortcutDetails = null;
            if (extension === '.lnk') {
              try {
                shortcutDetails = virtualPaths.readManagedExternalLink(item.childPath);
                externalLink = Boolean(shortcutDetails);
                const externalTarget = shortcutDetails?.target ? path.resolve(String(shortcutDetails.target)) : '';
                const externalStat = externalLink && externalTarget ? await fs.promises.stat(externalTarget).catch(() => null) : null;
                if (externalStat?.isFile()) {
                  extension = path.extname(externalTarget).toLowerCase();
                  kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
                  mediaService.grantPath(externalTarget);
                  session.candidates.push({ name: item.child.name, path: externalTarget, relativePath: virtualRelativePath, kind, extension, size: externalStat.size, createdAt: externalStat.birthtimeMs || externalStat.ctimeMs || 0, updatedAt: externalStat.mtimeMs || 0, viaShortcut: true, viaExternalLink: true, readOnly: false, externalLink: true, externalLinkTarget: externalTarget, externalLinkTargetKind: 'file' });
                  continue;
                }
              }
              catch { /* an invalid shortcut remains a regular shortcut candidate */ }
            }
            const sourceChannel = extension === '.lnk' && !externalLink ? shortcutSourceChannel(item.childPath) : undefined;
            session.candidates.push({ name: item.child.name, path: item.childPath, relativePath: virtualRelativePath, kind, extension, size: item.stat.size, createdAt: item.stat.birthtimeMs || item.stat.ctimeMs || 0, updatedAt: item.stat.mtimeMs || 0, viaShortcut: Boolean(current.viaShortcut), viaExternalLink: Boolean(current.viaExternalLink), ...(sourceChannel ? { sourceChannel } : {}), ...(externalLink ? { externalLink: true } : {}) });
            if (extension === '.lnk' && process.platform === 'win32') {
              try {
                const details = shortcutDetails || shell.readShortcutLink(item.childPath);
                const target = details?.target ? path.resolve(String(details.target)) : '';
                if (!target) continue;
                const targetStat = await fs.promises.stat(target);
                const directoryKey = path.resolve(target).toLowerCase();
                if (!targetStat.isDirectory() || session.visitedDirectories.has(directoryKey)) continue;
                session.visitedDirectories.add(directoryKey);
                mediaService.grantRoot(target);
                session.pending.push({ directory: target, priority: targetStat.mtimeMs || targetStat.birthtimeMs || item.stat.mtimeMs || 0, offset: 0, virtualPath: virtualRelativePath, viaShortcut: true, viaExternalLink: externalLink });
              } catch (error) {
                writeLog('warn', 'Unable to follow a recent-files folder shortcut', { shortcut: item.childPath, error: error.message || String(error) });
              }
            }
          }
        }
        if (session.candidates.length >= pageSize) {
          const recentThreshold = [...session.candidates].sort((left, right) => right.updatedAt - left.updatedAt)[pageSize - 1]?.updatedAt || 0;
          const newestPendingDirectory = session.pending.reduce((newest, candidate) => Math.max(newest, candidate.priority), 0);
          if (newestPendingDirectory <= recentThreshold) break;
        }
      }
      session.candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      const entries = session.candidates.splice(0, pageSize);
      const hasMore = session.pending.length > 0 || session.candidates.length > 0;
      if (!hasMore) recentFileSessions.delete(cursor);
      return {
        success: true,
        scope: externalScope?.normalizedRelativePath || path.relative(root, scope).replace(/\\/g, '/'),
        entries,
        cursor: hasMore ? cursor : undefined,
        hasMore,
        truncated: hasMore,
        scannedDirectories: session.scannedDirectories,
      };
    } catch (error) {
      writeLog('warn', 'Unable to list recent project files', { projectName, scopeRelativePath, error: error.message || String(error) });
      return {
        success: false,
        entries: [],
        error: error.message || String(error),
        errorCode: error?.code === recentFilesSessionExpiredCode ? recentFilesSessionExpiredCode : undefined,
      };
    } finally { releaseCursor(); }
  });

  ipcMain.handle('workspace-cancel-recent-files', async (_event, requestedCursor = '') => {
    pruneRecentFileSessions();
    const cursor = String(requestedCursor || '');
    const session = cursor ? recentFileSessions.get(cursor) : null;
    if (!session) return { success: false, errorCode: recentFilesSessionExpiredCode, error: '最近文件会话已失效' };
    session.cancelled = true;
    recentFileSessions.delete(cursor);
    return { success: true };
  });

  ipcMain.handle('workspace-folder-tree', async (_event, workspacePath, status, projectName) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const folders = [];
      const pending = [{ directory: root, boundary: await fs.promises.realpath(root), relativePath: '', depth: 0 }];
      const maximumFolders = 20000;
      const maximumDepth = 64;
      const visited = new Set();
      const managedLinkScan = await listManagedExternalLinksBounded(root);
      let skippedCount = managedLinkScan.skippedCount;
      for (const link of managedLinkScan.links) {
        if (link.externalTargetKind === 'file') continue;
        const parentRelativePath = path.posix.dirname(link.shortcutVirtualPath);
        const depth = Math.max(0, link.shortcutVirtualPath.split('/').length - 1);
        folders.push({ name: link.externalDisplayName, relativePath: link.shortcutVirtualPath, parentRelativePath: parentRelativePath === '.' ? '' : parentRelativePath, depth, externalLink: true, externalLinkOffline: link.offline });
        if (!link.offline) pending.push({ directory: link.externalTargetRoot, boundary: await fs.promises.realpath(link.externalTargetRoot), relativePath: link.shortcutVirtualPath, depth: depth + 1, viaExternalLink: true });
      }
      while (pending.length) {
        const current = pending.pop();
        if (current.depth > maximumDepth) { skippedCount += 1; continue; }
        const directoryReal = await fs.promises.realpath(current.directory).catch(() => '');
        const containment = directoryReal ? path.relative(current.boundary, directoryReal) : '..';
        const directoryStat = await fs.promises.lstat(current.directory, { bigint: true }).catch(() => null);
        if (!directoryReal || containment.startsWith('..') || path.isAbsolute(containment) || !directoryStat || directoryStat.isSymbolicLink()) { skippedCount += 1; continue; }
        const identity = `${directoryStat.dev}:${directoryStat.ino}`;
        if (visited.has(identity)) { skippedCount += 1; continue; }
        visited.add(identity);
        let children;
        try {
          children = await fs.promises.readdir(current.directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a folder-tree directory', { directory: current.directory, error: error.message || String(error) });
          continue;
        }
        const candidateDirectories = children
          .filter(child => child.isDirectory() && !child.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) && !isInternalFileOperationEntry(child.name))
          .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        const directories = [];
        for (const child of candidateDirectories) {
          const childStat = await fs.promises.lstat(path.join(current.directory, child.name)).catch(() => null);
          if (childStat?.isDirectory() && !childStat.isSymbolicLink()) directories.push(child);
          else skippedCount += 1;
        }
        for (const child of directories) {
          const childPath = path.join(current.directory, child.name);
          const relativePath = [current.relativePath, child.name].filter(Boolean).join('/');
          folders.push({ name: child.name, relativePath, parentRelativePath: current.relativePath, depth: current.depth, ...(current.viaExternalLink ? { viaExternalLink: true } : {}) });
          if (folders.length >= maximumFolders) break;
        }
        if (folders.length >= maximumFolders) break;
        for (let index = directories.length - 1; index >= 0; index -= 1) {
          const child = directories[index];
          const childPath = path.join(current.directory, child.name);
          pending.push({ directory: childPath, boundary: current.boundary, relativePath: [current.relativePath, child.name].filter(Boolean).join('/'), depth: current.depth + 1, viaExternalLink: current.viaExternalLink });
        }
      }
      folders.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      return { success: true, folders, truncated: managedLinkScan.truncated || folders.length >= maximumFolders || skippedCount > 0, skippedCount };
    } catch (error) {
      return { success: false, folders: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-add-inspiration-to-project', async (_event, inspirationRoot, targetWorkspacePath, targetStatus, targetProjectName, relativePaths) => {
    const createdTargets = [];
    try {
      const sourceRoot = path.resolve(getProjectPath(inspirationRoot, '未分类', '.__photoflow_inspiration__'));
      const targetRoot = path.resolve(getProjectPath(targetWorkspacePath, targetStatus, targetProjectName));
      const planningFolder = path.join(targetRoot, '策划');
      await fs.promises.mkdir(planningFolder, { recursive: true });
      const requestedPaths = [...new Set((Array.isArray(relativePaths) ? relativePaths : []).map(value => String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean))];
      if (!requestedPaths.length) throw new Error('请先选择要汇聚的文件或文件夹');
      const reserved = new Set();
      let fileCount = 0;
      let shortcutCount = 0;
      for (const relativePath of requestedPaths) {
        const source = path.resolve(resolveProjectEntry(inspirationRoot, '未分类', '.__photoflow_inspiration__', relativePath));
        assertExistingInside(sourceRoot, source, '灵感素材');
        const stat = await fs.promises.stat(source);
        if (stat.isDirectory()) {
          if (process.platform !== 'win32') throw new Error('文件夹快捷方式目前仅支持 Windows');
          const shortcutPath = uniqueDestination(planningFolder, `${path.basename(source)}.lnk`, reserved);
          const created = shell.writeShortcutLink(shortcutPath, { target: source, cwd: source, description: `灵感库：${path.basename(source)}` });
          if (!created) throw new Error(`无法创建文件夹快捷方式：${path.basename(source)}`);
          createdTargets.push(shortcutPath);
          shortcutCount += 1;
          continue;
        }
        if (!stat.isFile()) throw new Error(`不支持的灵感素材：${path.basename(source)}`);
        const destination = uniqueDestination(planningFolder, path.basename(source), reserved);
        await copyFileAtomic(source, destination);
        createdTargets.push(destination);
        fileCount += 1;
      }
      if (createdTargets.length) await pushUndoOperation({ kind: 'remove-created', paths: createdTargets, label: '灵感汇聚' });
      mainWindow?.webContents.send('workspace-files-changed', { root: targetRoot, fileName: '策划', eventType: 'rename' });
      writeLog('info', 'Inspiration items added to project planning folder', { targetProjectName, fileCount, shortcutCount, planningFolder });
      return { success: true, count: createdTargets.length, fileCount, shortcutCount, planningFolder };
    } catch (error) {
      for (const target of [...createdTargets].reverse()) await fs.promises.rm(target, { force: true }).catch(() => undefined);
      writeLog('error', 'Unable to add inspiration items to project', error);
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-entry-details', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const externalEntry = await resolveManagedExternalScope(root, relativePath);
      const target = externalEntry?.currentPath || assertExistingInside(root, assertInside(root, path.resolve(root, relativePath), '文件路径', true), '文件路径', true);
      const stat = await fs.promises.stat(target);
      let size = stat.isFile() ? stat.size : 0;
      let fileCount = stat.isFile() ? 1 : 0;
      let folderCount = 0;
      let truncated = false;
      let skippedCount = 0;
      if (stat.isDirectory()) {
        const boundaryReal = await fs.promises.realpath(target);
        const pending = [{ directory: target, depth: 0 }];
        const visited = new Set();
        const maximumDepth = 64;
        const maximumEntries = 100000;
        while (pending.length) {
          const current = pending.pop();
          if (current.depth > maximumDepth || fileCount + folderCount >= maximumEntries) { truncated = true; skippedCount += 1; continue; }
          const directoryReal = await fs.promises.realpath(current.directory);
          const containment = path.relative(boundaryReal, directoryReal);
          if (containment.startsWith('..') || path.isAbsolute(containment)) { skippedCount += 1; continue; }
          const directoryStat = await fs.promises.lstat(current.directory, { bigint: true });
          const identity = `${directoryStat.dev}:${directoryStat.ino}`;
          if (visited.has(identity)) { skippedCount += 1; continue; }
          visited.add(identity);
          for (const entry of await fs.promises.readdir(current.directory, { withFileTypes: true })) {
            if (fileCount + folderCount >= maximumEntries) { truncated = true; skippedCount += 1; break; }
            const entryPath = path.join(current.directory, entry.name);
            const entryStat = await fs.promises.lstat(entryPath);
            if (entryStat.isSymbolicLink()) { skippedCount += 1; continue; }
            if (entryStat.isDirectory()) { folderCount += 1; pending.push({ directory: entryPath, depth: current.depth + 1 }); }
            else if (entryStat.isFile()) { fileCount += 1; size += entryStat.size; }
          }
        }
      }
      return { success: true, details: { size, createdAt: stat.birthtimeMs || stat.ctimeMs, updatedAt: stat.mtimeMs, fileCount, folderCount, truncated, skippedCount } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-create-progress-folder', async (_event, workspacePath, status, projectName, request = {}) => {
    let folderPath = '';
    let folderOwnership = null;
    let registrationCommitted = false;
    try {
      const cleanedName = cleanProjectName(String(request.displayName || ''));
      if (!cleanedName) throw new Error('进度文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      folderPath = path.resolve(projectPath, cleanedName);
      if (!folderPath.startsWith(projectPath + path.sep)) throw new Error('无效的进度文件夹名称');
      if (fs.existsSync(folderPath)) throw new Error('同名进度文件夹已存在');
      await fs.promises.mkdir(folderPath);
      folderOwnership = { created: true, identity: await captureIdentity(folderPath) };
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const registered = await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: request.mediaKind,
        versionKey: request.versionKey,
        parentProgressId: request.parentProgressId,
        displayName: cleanedName,
        folderPath,
        trackingEnabled: false,
      });
      registrationCommitted = true;
      let warning;
      await pushUndoOperation({ kind: 'remove-created', paths: [folderPath], label: '新建版本进度' }).catch(error => {
        warning = '进度文件夹已创建并登记，但无法记录撤销操作';
        writeLog('warn', 'Unable to record progress folder undo after registration', error);
      });
      return {
        success: true,
        progressFolder: registered.progressFolder,
        folder: { name: cleanedName, path: folderPath, relativePath: path.relative(projectPath, folderPath).replace(/\\/g, '/'), updatedAt: Date.now() },
        warning,
      };
    } catch (error) {
      if (!registrationCommitted) await removeIfOwned(folderPath, folderOwnership).catch(cleanupError => writeLog('warn', 'Unable to clean failed progress folder creation', cleanupError));
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-media-workflow-import-commit', async (_event, workspacePath, manifest = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(workspaceRoot) || await refreshWorkspaceCatalog(workspaceRoot);
      const result = await commitImportManifest(workspaceRoot, manifest);
      const locations = await receiptLocationsForSession(workspaceRoot, catalog, manifest?.importSessionId);
      for (const location of locations) await acknowledgeImportReceipt(location, String(manifest?.manifestId || manifest?.projectName || ''));
      return { success: true, ...result };
    } catch (error) {
      writeLog('error', 'Unable to commit imported media workflow graph', { error: error.message || String(error) });
      return { success: false, retryable: true, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-media-workflow-import-recover', async (_event, workspacePath) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const catalog = await reconcileWorkspaceCatalog(workspaceRoot);
      const recovered = [];
      const failures = [];
      for (const stagingRoot of importStagingRoots(workspaceRoot, catalog)) {
        let sessions = [];
        try { sessions = await fs.promises.readdir(stagingRoot, { withFileTypes: true }); } catch { continue; }
        for (const entry of sessions) {
          if (!entry.isDirectory() || !validImportSessionId(entry.name)) continue;
          const location = { sessionDir: path.join(stagingRoot, entry.name), receiptPath: path.join(stagingRoot, entry.name, IMPORT_GRAPH_RECEIPT_NAME) };
          const receipt = await readImportReceipt(location.receiptPath);
          if (!receipt || receipt.importSessionId !== entry.name) continue;
          for (const manifest of receipt.manifests) {
            const projectName = String(manifest?.projectName || '');
            if ((receipt.acknowledgedManifestIds || []).includes(manifest.manifestId)) continue;
            try {
              await commitImportManifest(workspaceRoot, manifest);
              recovered.push({ importSessionId: entry.name, projectName });
              await acknowledgeImportReceipt(location, manifest.manifestId);
            } catch (error) {
              failures.push({ importSessionId: entry.name, projectName, error: error.message || String(error) });
            }
          }
        }
      }
      return { success: failures.length === 0, recovered, failures };
    } catch (error) {
      return { success: false, recovered: [], failures: [], error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-open-version', async (_event, filePath) => {
    try {
      const target = await mediaService.authorizeInput(filePath);
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-open-project', async (_event, workspacePath, status, projectName, folderName) => {
    try {
      const target = resolveProjectEntry(workspacePath, status, projectName, folderName);
      const error = await shell.openPath(target);
      return { success: !error, error };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-open-entry', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const externalEntry = await resolveManagedExternalScope(root, relativePath);
      const target = externalEntry?.currentPath || resolveProjectEntry(workspacePath, status, projectName, relativePath);
      const error = await shell.openPath(target);
      return { success: !error, error };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('workspace-extract-office-images', async (_event, workspacePath, status, projectName, relativePaths = []) => {
    try {
      const requestedPaths = Array.isArray(relativePaths) ? relativePaths : [];
      if (!requestedPaths.length) throw new Error('没有选择 Office 文档');
      if (requestedPaths.length > 50) {
        return {
          success: false,
          error: `一次最多处理 50 个 Office 文档；已选择 ${requestedPaths.length} 个，本次未处理任何文档`,
          requestedCount: requestedPaths.length,
          acceptedCount: 0,
          skippedCount: requestedPaths.length,
          results: [],
        };
      }
      const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
      const resolutions = requestedPaths.map(relativePath => resolveToolSource(projectRoot, relativePath));
      const targets = resolutions.map(resolution => resolution.physicalPath);
      for (const target of targets) {
        if (!fs.statSync(target).isFile() || !officeOpenXmlExtensions.has(path.extname(target).toLowerCase())) {
          throw new Error(`不支持此 Office 文件：${path.basename(target)}`);
        }
      }
      const args = ['extract', ...targets.flatMap(target => ['--input', target])];
      const result = await runPythonJsonAction('office_media_extract.py', args, 20 * 60 * 1000);
      const extractionResults = Array.isArray(result?.results) ? result.results : [];
      const successfulResults = extractionResults.filter(item => item?.success);
      // A batch is reported as unsuccessful when any document fails. Preserve the
      // successful items so the renderer can show an accurate partial-completion
      // state instead of making an already-published extraction look unfinished.
      if (!result || (!result.success && !successfulResults.length)) throw new Error(result?.error || '提取图片失败');
      const publishedResults = extractionResults.map(item => ({ ...item }));
      const linkRequests = [];
      for (let index = 0; index < extractionResults.length; index += 1) {
        const item = extractionResults[index];
        if (!item?.success || !item.outputFolder) continue;
        try {
          const resolution = resolutions[index];
          const outputRoot = resolution.viaExternalLink ? resolution.mediaRoot : projectRoot;
          const outputFolder = assertExistingInside(outputRoot, path.resolve(item.outputFolder), 'Office 图片输出路径');
          if (!fs.statSync(outputFolder).isDirectory()) throw new Error('Office 图片输出不是文件夹');
          publishedResults[index].publishSuccess = true;
          if (resolution.viaExternalLink && resolution.externalTargetKind === 'file') {
            const shortcutPath = uniqueDestination(path.dirname(resolution.shortcutPath), `${path.basename(outputFolder)}.lnk`);
            linkRequests.push({ index, shortcutPath, target: outputFolder, kind: 'folder', displayName: path.basename(outputFolder) });
          }
        } catch (error) {
          publishedResults[index].publishSuccess = false;
          publishedResults[index].publishError = error.message || String(error);
        }
      }
      if (linkRequests.length) {
        try {
          virtualPaths.createManagedExternalLinksBatch(linkRequests.map(request => ({
            shortcutPath: request.shortcutPath,
            target: request.target,
            kind: request.kind,
            displayName: request.displayName,
          })));
        } catch (error) {
          for (const request of linkRequests) {
            publishedResults[request.index].publishSuccess = false;
            publishedResults[request.index].publishError = error.message || String(error);
          }
        }
      }
      mainWindow?.webContents.send('workspace-files-changed', { root: projectRoot, fileName: '' });
      const publicationFailures = publishedResults.filter(item => item?.success && item.publishSuccess === false);
      return {
        ...result,
        success: Boolean(result.success) && publicationFailures.length === 0,
        requestedCount: requestedPaths.length,
        acceptedCount: requestedPaths.length,
        skippedCount: 0,
        ...(publicationFailures.length ? { error: `已提取图片，但 ${publicationFailures.length} 个结果发布失败；可从输出目录恢复` } : {}),
        results: publishedResults,
      };
    } catch (error) {
      writeLog('warn', 'Office image extraction failed', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), results: [] };
    }
  });

  ipcMain.handle('workspace-extract-screenshot-main-images', async (event, workspacePath, status, projectName, relativePaths = [], options = {}) => {
    const requestId = String(options?.requestId || '');
    const analyzeOnly = options?.analyzeOnly === true;
    const confirmedCrops = Array.isArray(options?.crops) ? options.crops : null;
    const outputSuffix = options?.outputSuffix === '裁剪' ? '裁剪' : '主图';
    const publish = payload => {
      try {
        if (requestId && event?.sender && !event.sender.isDestroyed()) event.sender.send('workspace-screenshot-main-image-progress', { requestId, ...payload });
      } catch (error) { writeLog('warn', 'Unable to publish screenshot extraction progress', error); }
    };
    try {
      const allRequestedPaths = Array.isArray(relativePaths) ? relativePaths : [];
      const requestedPaths = allRequestedPaths.slice(0, 2000);
      const inputTruncated = allRequestedPaths.length > requestedPaths.length;
      if (!requestedPaths.length) throw new Error('没有选择图片');
      const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
      const targetResolutions = requestedPaths.map(relativePath => resolveToolSource(projectRoot, relativePath));
      const targets = targetResolutions.map(resolution => resolution.physicalPath);
      if (confirmedCrops && confirmedCrops.length !== targets.length) throw new Error('确认的裁剪范围与图片数量不一致');
      for (const target of targets) {
        if (!fs.statSync(target).isFile() || !screenshotMainImageExtensions.has(path.extname(target).toLowerCase())) {
          throw new Error(`不支持此图片格式：${path.basename(target)}`);
        }
      }
      const results = [];
      const command = analyzeOnly ? 'analyze' : confirmedCrops ? 'crop' : 'extract';
      publish({ phase: analyzeOnly ? 'analyzing' : 'extracting', progress: 0, processedCount: 0, totalCount: targets.length, message: analyzeOnly ? '正在准备分析截图主图…' : '正在准备提取截图主图…' });
      for (let offset = 0; offset < targets.length; offset += 60) {
        const chunk = targets.slice(offset, offset + 60);
        const cropChunk = confirmedCrops?.slice(offset, offset + chunk.length) || [];
        const args = [command, ...(confirmedCrops && outputSuffix === '裁剪' ? ['--output-suffix', '裁剪'] : []), ...chunk.flatMap((target, index) => {
          if (!confirmedCrops) return ['--input', target];
          const crop = cropChunk[index] || {};
          const values = ['x', 'y', 'width', 'height'].map(key => Math.round(Number(crop[key]) || 0));
          return ['--input', target, '--rectangle', values.join(',')];
        })];
        const payload = await runPythonJsonAction('screenshot_main_image.py', args, 30 * 60 * 1000, message => {
          if (message?.type !== 'progress') return;
          const processedCount = Math.max(0, Math.min(targets.length, offset + Number(message.processedCount || 0)));
          const currentName = String(message.currentName || '');
          const displayIndex = message.phase === 'item-start' ? Math.min(targets.length, processedCount + 1) : processedCount;
          publish({
            phase: analyzeOnly ? 'analyzing' : 'extracting',
            progress: Math.round(processedCount / Math.max(1, targets.length) * 100),
            processedCount,
            totalCount: targets.length,
            currentName,
            message: `${message.phase === 'item-complete' ? '已处理' : analyzeOnly ? '正在分析' : '正在裁剪'} ${displayIndex}/${targets.length}${currentName ? ` · ${currentName}` : ''}`,
          });
        });
        if (!payload?.success && !Array.isArray(payload?.results)) throw new Error(payload?.error || '提取截图主图失败');
        results.push(...(Array.isArray(payload.results) ? payload.results : []));
      }
      const croppedCount = results.filter(result => result?.cropped).length;
      const reviewCount = results.filter(result => result?.needsReview).length;
      const skippedCount = results.filter(result => result?.skipped).length;
      const failedCount = results.filter(result => !result?.success).length;
      publish({ phase: 'complete', progress: 100, processedCount: targets.length, totalCount: targets.length, message: analyzeOnly ? '主图范围分析完成' : '主图提取完成' });
      if (!analyzeOnly) {
        const outputPaths = [];
        const linkRequests = [];
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          if (!result?.cropped || !result?.output) continue;
          const resolution = targetResolutions[index];
          const outputRoot = resolution?.viaExternalLink ? resolution.mediaRoot : projectRoot;
          const outputPath = assertExistingInside(outputRoot, path.resolve(result.output), '主图输出路径');
          outputPaths.push({ path: outputPath, root: outputRoot });
          if (resolution?.viaExternalLink && resolution.externalTargetKind === 'file' && outputPath !== resolution.physicalPath) {
            const shortcutPath = uniqueDestination(path.dirname(resolution.shortcutPath), `${path.basename(outputPath)}.lnk`);
            linkRequests.push({ shortcutPath, target: outputPath, kind: 'file', displayName: path.basename(outputPath) });
          }
        }
        if (linkRequests.length) virtualPaths.createManagedExternalLinksBatch(linkRequests);
        for (const item of outputPaths) void thumbnailService.syncChangedPaths(item.root, [item.path], mediaRuntimeState.activeMediaCacheConfig).catch(error => {
          writeLog('warn', 'Unable to queue screenshot main-image thumbnails', { projectName, error: error.message || String(error) });
        });
        const workspaceRoot = path.resolve(resolveWorkspaceRoot(workspacePath));
        mainWindow?.webContents.send('workspace-files-changed', { root: workspaceRoot, fileName: path.relative(workspaceRoot, projectRoot), eventType: 'rename' });
      }
      return {
        success: failedCount < results.length,
        requestedCount: allRequestedPaths.length,
        acceptedCount: requestedPaths.length,
        truncated: inputTruncated,
        inputSkippedCount: allRequestedPaths.length - requestedPaths.length,
        inputCount: results.length,
        croppedCount,
        reviewCount,
        skippedCount,
        failedCount,
        results,
        ...(failedCount === results.length ? { error: results[0]?.error || '提取截图主图失败' } : {}),
      };
    } catch (error) {
      publish({ phase: 'failed', progress: 0, message: `提取失败：${error.message || String(error)}` });
      writeLog('warn', 'Screenshot main image extraction failed', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), results: [] };
    }
  });

  const restartVideoTrim = async interruptedTask => {
    const metadata = interruptedTask.metadata || {};
    const workspacePath = String(metadata.workspacePath || '');
    const status = String(metadata.projectStatus || '');
    const projectName = String(metadata.projectName || '');
    const relativePath = String(metadata.sourceRelativePath || '');
    const start = Number(metadata.start);
    const end = Number(metadata.end);
    const saveMode = metadata.saveMode === 'replace' ? 'replace' : 'new';
    const exportMode = metadata.exportMode === 'fast' ? 'fast' : 'exact';
    if (!workspacePath || !status || !projectName || !relativePath || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('视频裁剪重跑参数无效');
    const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
    const sourceResolution = virtualPaths.resolve(projectRoot, relativePath, { externalRootMode: 'target' });
    const sourcePath = sourceResolution.physicalPath;
    const stat = await fs.promises.stat(sourcePath);
    const extension = path.extname(sourcePath).toLowerCase();
    if (!stat.isFile() || !VIDEO_EXTENSIONS.has(extension)) throw new Error('视频源文件当前不可用');
    const parsed = path.parse(sourcePath);
    const newOutputDirectory = sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'file' ? projectRoot : parsed.dir;
    const generatedPath = saveMode === 'replace'
      ? path.join(parsed.dir, `.photoflow-trim-output-${crypto.randomUUID()}${parsed.ext}`)
      : uniqueDestination(newOutputDirectory, `${parsed.name}_剪辑${parsed.ext}`);
    const cancelDirectory = path.join(app.getPath('temp'), 'photoflow-video-trim');
    const cancelFile = path.join(cancelDirectory, `${interruptedTask.id}.cancel`);
    await fs.promises.mkdir(cancelDirectory, { recursive: true });
    await fs.promises.rm(cancelFile, { force: true });
    const run = () => backgroundTasks.run({
      id: interruptedTask.id,
      type: 'video-trim',
      title: `重新裁剪视频 · ${parsed.base}`,
      cancellable: true,
      resources: [sourcePath],
      capacities: [{ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 }],
      resumePolicy: 'safe-restart',
      metadata: { ...metadata, sourcePath, generatedPath, exportMode },
    }, async task => {
      const requestCancel = () => void fs.promises.writeFile(cancelFile, 'cancel', 'utf8').catch(() => undefined);
      task.signal.addEventListener('abort', requestCancel, { once: true });
      let committed = false;
      try {
        task.report(1, exportMode === 'fast' ? '正在快速导出视频' : '正在重新编码视频');
        const result = await runPythonJsonAction(
          'cut_video.py',
          [sourcePath, '--trim-start', String(start), '--trim-end', String(end), '--output-path', generatedPath, '--trim-mode', exportMode, '--cancel_file', cancelFile],
          60 * 60 * 1000,
          message => {
            if (message?.type !== 'progress') return;
            if (message.phase === 'saving') task.setCancellable(false);
            task.report(Math.max(1, Math.min(98, Number(message.progress) || 0)), String(message.message || (exportMode === 'fast' ? '正在快速导出视频' : '正在重新编码视频')), { phase: String(message.phase || (exportMode === 'fast' ? 'copying' : 'encoding')) });
          },
        );
        if (!result?.success || !fs.existsSync(generatedPath)) throw new Error(result?.error || '视频裁剪重跑失败');
        task.setCancellable(false);
        task.report(99, '正在完成保存', { phase: 'finalizing' });
        const outputRoot = saveMode === 'new' && sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'file'
          ? projectRoot : sourceResolution.viaExternalLink ? sourceResolution.mediaRoot : projectRoot;
        const safeGenerated = assertExistingInside(outputRoot, generatedPath, '视频裁剪输出路径');
        let safeOutput;
        if (saveMode === 'replace') {
          await replaceVideoFileWithRollback({ crypto, fs, path, sourcePath, replacementPath: safeGenerated });
          safeOutput = sourcePath;
        } else safeOutput = safeGenerated;
        committed = true;
        const thumbnailRoot = sourceResolution.viaExternalLink && !(saveMode === 'new' && sourceResolution.externalTargetKind === 'file') ? sourceResolution.mediaRoot : projectRoot;
        void thumbnailService.syncChangedPaths(thumbnailRoot, [safeOutput], mediaRuntimeState.activeMediaCacheConfig).catch(() => undefined);
        const outputRelativePath = saveMode === 'replace' ? sourceResolution.virtualPath
          : sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'folder'
            ? virtualPaths.toVirtualPath(projectRoot, safeOutput, sourceResolution)
            : path.relative(projectRoot, safeOutput).replace(/\\/g, '/');
        mainWindow?.webContents.send('workspace-files-changed', { root: projectRoot, fileName: outputRelativePath, eventType: saveMode === 'replace' ? 'change' : 'rename' });
        task.report(100, '视频导出完成', { phase: 'complete', result: { outputPath: safeOutput, relativePath: outputRelativePath, duration: end - start, replaced: saveMode === 'replace' } });
        return { outputPath: safeOutput, relativePath: outputRelativePath };
      } finally {
        task.signal.removeEventListener('abort', requestCancel);
        await fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
        if ((!committed || saveMode === 'replace') && fs.existsSync(generatedPath)) await fs.promises.rm(generatedPath, { force: true }).catch(() => undefined);
      }
    });
    return run();
  };
  backgroundTasks?.registerTypeRestartFactory?.('video-trim', restartVideoTrim, {
    canRestart: task => Boolean(task.metadata?.workspacePath && task.metadata?.projectStatus && task.metadata?.projectName && task.metadata?.sourceRelativePath),
  });

  ipcMain.handle('workspace-trim-video', async (event, workspacePath, status, projectName, relativePath, request = {}) => {
    const requestedOperationId = String(request.operationId || '');
    const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedOperationId)
      ? requestedOperationId
      : crypto.randomUUID();
    let operation = null;
    let taskHandle = null;
    const publish = payload => {
      if (!event.sender.isDestroyed()) event.sender.send('workspace-video-trim-progress', { operationId, ...payload });
      if (taskHandle && !taskHandle.deduplicated && !taskHandle.isFinished()) {
        taskHandle.context.report(payload.progress, payload.message, { phase: payload.phase });
      }
    };
    try {
      if (activeVideoTrimOperations.has(operationId)) throw new Error('该视频导出任务已在运行');
      const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
      const sourceResolution = virtualPaths.resolve(projectRoot, relativePath, { externalRootMode: 'target' });
      const sourcePath = sourceResolution.physicalPath;
      const stat = await fs.promises.stat(sourcePath);
      const extension = path.extname(sourcePath).toLowerCase();
      if (!stat.isFile() || !VIDEO_EXTENSIONS.has(extension)) throw new Error('请选择项目中的视频文件');
      const start = Number(request.start);
      const end = Number(request.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('剪辑时间范围无效');
      const saveMode = request.saveMode === 'replace' ? 'replace' : 'new';
      const exportMode = request.exportMode === 'exact' ? 'exact' : 'fast';
      const parsed = path.parse(sourcePath);
      const sourceRelativePath = sourceResolution.virtualPath;
      const requestedSourceDuration = Number(request.sourceDuration);
      const sourceDuration = Number.isFinite(requestedSourceDuration) && requestedSourceDuration >= end ? requestedSourceDuration : end;
      const newOutputDirectory = sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'file' ? projectRoot : parsed.dir;
      const generatedPath = saveMode === 'replace'
        ? path.join(parsed.dir, `.photoflow-trim-output-${crypto.randomUUID()}${parsed.ext}`)
        : uniqueDestination(newOutputDirectory, `${parsed.name}_剪辑${parsed.ext}`);
      const cancelDirectory = path.join(app.getPath('temp'), 'photoflow-video-trim');
      const cancelFile = path.join(cancelDirectory, `${operationId}.cancel`);
      await fs.promises.mkdir(cancelDirectory, { recursive: true });
      await fs.promises.unlink(cancelFile).catch(() => undefined);
      taskHandle = backgroundTasks.create({
        id: operationId,
        type: 'video-trim',
        title: `${exportMode === 'fast' ? '快速裁剪视频' : '精确裁剪视频'} · ${parsed.base}`,
        cancellable: true,
        resources: [sourcePath],
        capacities: [{ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 }],
        resumePolicy: 'safe-restart',
        metadata: { operationId, workspacePath: path.resolve(workspacePath), projectStatus: status, projectName, sourcePath, sourceRelativePath, generatedPath, saveMode, exportMode, start, end, sourceDuration },
      });
      if (taskHandle.deduplicated) throw new Error('该视频导出任务已在运行');
      operation = { cancelFile, cancelled: false, cancellable: true, taskHandle };
      activeVideoTrimOperations.set(operationId, operation);
      taskHandle.context.signal.addEventListener('abort', () => {
        if (!operation?.cancellable) return;
        operation.cancelled = true;
        void fs.promises.writeFile(cancelFile, 'cancel', 'utf8').catch(() => undefined);
      }, { once: true });
      const runInBackground = async () => {
        try {
          await taskHandle.waitForStart();
          taskHandle.context.throwIfCancelled();
          publish({ phase: 'preparing', progress: 0, message: '正在准备视频…' });
          let safeOutput = '';
          try {
            const result = await runPythonJsonAction(
              'cut_video.py',
              [sourcePath, '--trim-start', String(start), '--trim-end', String(end), '--output-path', generatedPath, '--trim-mode', exportMode, '--cancel_file', cancelFile],
              60 * 60 * 1000,
              message => {
                if (message?.type !== 'progress') return;
                if (message.phase === 'saving') {
                  operation.cancellable = false;
                  taskHandle.context.setCancellable(false);
                }
                publish({
                  phase: String(message.phase || (exportMode === 'fast' ? 'copying' : 'encoding')),
                  progress: Math.max(0, Math.min(99, Number(message.progress) || 0)),
                  message: String(message.message || '正在导出视频…'),
                });
              },
            );
            if (!result?.success || !fs.existsSync(generatedPath)) throw new Error(result?.error || '视频剪辑失败');
            operation.cancellable = false;
            taskHandle.context.setCancellable(false);
            publish({ phase: 'finalizing', progress: 99, message: '正在完成保存…' });
            const outputRoot = saveMode === 'new' && sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'file'
              ? projectRoot : sourceResolution.viaExternalLink ? sourceResolution.mediaRoot : projectRoot;
            const safeGenerated = assertExistingInside(outputRoot, generatedPath, '视频剪辑输出路径');
            if (saveMode === 'replace') {
              const commit = await replaceVideoFileWithRollback({ crypto, fs, path, sourcePath, replacementPath: safeGenerated });
              if (!commit.backupRemoved) writeLog('warn', 'Unable to remove committed video trim backup', { projectName, backupPath: commit.backupPath });
              safeOutput = sourcePath;
            } else safeOutput = safeGenerated;
          } finally {
            if (saveMode === 'replace' && fs.existsSync(generatedPath)) await fs.promises.unlink(generatedPath).catch(() => undefined);
          }
          const thumbnailRoot = sourceResolution.viaExternalLink && !(saveMode === 'new' && sourceResolution.externalTargetKind === 'file')
            ? sourceResolution.mediaRoot : projectRoot;
          void thumbnailService.syncChangedPaths(thumbnailRoot, [safeOutput], mediaRuntimeState.activeMediaCacheConfig).catch(error => {
            writeLog('warn', 'Unable to queue trimmed-video thumbnail', { projectName, error: error.message || String(error) });
          });
          const outputRelativePath = saveMode === 'replace' ? sourceResolution.virtualPath
            : sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'folder'
              ? virtualPaths.toVirtualPath(projectRoot, safeOutput, sourceResolution)
              : path.relative(projectRoot, safeOutput).replace(/\\/g, '/');
          mainWindow?.webContents.send('workspace-files-changed', { root: projectRoot, fileName: outputRelativePath, eventType: saveMode === 'replace' ? 'change' : 'rename' });
          const completedResult = { outputPath: safeOutput, relativePath: outputRelativePath, duration: end - start, replaced: saveMode === 'replace' };
          publish({ phase: 'complete', progress: 100, message: '视频导出完成' });
          taskHandle.context.report(100, '视频导出完成', { phase: 'complete', result: completedResult });
          taskHandle.complete('视频导出完成');
        } catch (error) {
          const cancelled = Boolean(operation?.cancelled || taskHandle?.context.signal.aborted || error?.code === 'TASK_CANCELLED');
          publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, message: cancelled ? '视频导出已取消' : `视频导出失败：${error.message || String(error)}` });
          if (taskHandle && !taskHandle.deduplicated && !taskHandle.isFinished()) {
            if (cancelled) taskHandle.cancelled();
            else taskHandle.fail(error);
          }
          writeLog('warn', 'Video trim failed', { projectName, relativePath, error: error.message || String(error) });
        } finally {
          activeVideoTrimOperations.delete(operationId);
          if (operation?.cancelFile) await fs.promises.unlink(operation.cancelFile).catch(() => undefined);
        }
      };
      return startDetachedBackgroundOperation({
        operationId,
        worker: runInBackground,
        onUnexpectedError: error => writeLog('error', 'Detached video trim worker failed unexpectedly', { projectName, relativePath, error: error.message || String(error) }),
      });
    } catch (error) {
      const cancelled = Boolean(operation?.cancelled || taskHandle?.context.signal.aborted || error?.code === 'TASK_CANCELLED');
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, message: cancelled ? '视频导出已取消' : `视频导出失败：${error.message || String(error)}` });
      if (taskHandle && !taskHandle.deduplicated && !taskHandle.isFinished()) {
        if (cancelled) taskHandle.cancelled();
        else taskHandle.fail(error);
      }
      writeLog('warn', 'Video trim failed', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, operationId, cancelled, error: cancelled ? '视频导出已取消' : error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-cancel-video-trim', async (_event, operationIdValue) => {
    const operationId = String(operationIdValue || '');
    const operation = activeVideoTrimOperations.get(operationId);
    if (!operation || !operation.cancellable) return { success: true, cancelled: false };
    operation.cancelled = true;
    backgroundTasks.cancel(operationId);
    await fs.promises.writeFile(operation.cancelFile, 'cancel', 'utf8');
    return { success: true, cancelled: true };
  });

  ipcMain.handle('workspace-import-files', async (event, workspacePath, status, projectName, relativePath = '', options = {}) => {
    const operationId = crypto.randomUUID();
    let taskNotificationOwned = false;
    let job = { cancelled: false, finishing: false };
    let task = null;
    const publish = payload => task?.publish(payload);
    const moves = [];
    const createdTargets = [];
    const createdManagedLinkIds = [];
    const createdManagedLinks = [];
    const adoptedProgressIds = [];
    let importWorkspaceRoot = '';
    let importUndoToken = '';
    let importCleanupRoots = [];
    try {
      const deleteSourceAfterImport = options?.deleteSourceAfterImport === true;
      const linkOnly = options?.linkOnly === true;
      const preserveOriginal = !deleteSourceAfterImport;
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      importWorkspaceRoot = ensureWorkspace(workspacePath);
      const destinationResolution = virtualPaths.resolve(projectPath, relativePath, { externalRootMode: 'target' });
      const destinationDir = destinationResolution.physicalPath;
      importCleanupRoots = [projectPath, destinationDir];
      if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('当前文件夹不存在');
      let sourcePaths = Array.isArray(options?.sourcePaths) ? options.sourcePaths.map(source => String(source)) : [];
      if (!sourcePaths.length) {
        const choice = await dialog.showOpenDialog(mainWindow, { title: '选择要导入的文件', properties: ['openFile', 'multiSelections'] });
        if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0 };
        sourcePaths = choice.filePaths;
      }
      if (sourcePaths.length > 500) throw new Error('一次最多导入 500 个文件');
      if (linkOnly) {
        const reserved = new Set();
        const linkedItems = [];
        const linkRequests = [];
        const existingManagedLinksResult = options?.adoptAsOriginal === true ? virtualPaths.listManagedExternalLinks(projectPath) : [];
        const existingManagedLinks = Array.isArray(existingManagedLinksResult) ? existingManagedLinksResult : existingManagedLinksResult?.links || [];
        if (options?.adoptAsOriginal === true && existingManagedLinksResult?.truncated) throw new Error('项目外链数量超过安全枚举上限，请先整理或缩小外链范围后再纳入原始素材');
        const adoptedTargetKeys = options?.adoptAsOriginal === true
          ? new Set(existingManagedLinks.filter(link => !link.offline).map(link => comparablePath(link.externalTargetRoot)))
          : new Set();
        for (const source of sourcePaths) {
          const sourcePath = path.resolve(source);
          const stat = await fs.promises.stat(sourcePath);
          if (!stat.isFile() && !stat.isDirectory()) throw new Error(`不支持创建外链：${path.basename(sourcePath)}`);
          if (adoptedTargetKeys.has(comparablePath(sourcePath))) throw new Error(`该原始素材外链已经存在：${path.basename(sourcePath)}`);
          const shortcutPath = uniqueDestination(destinationDir, `${path.basename(sourcePath)}.lnk`, reserved);
          linkRequests.push({ shortcutPath, target: sourcePath, kind: stat.isDirectory() ? 'folder' : 'file', displayName: path.basename(sourcePath) });
          linkedItems.push({ relativePath: [destinationResolution.virtualPath, path.basename(shortcutPath)].filter(Boolean).join('/'), sourcePath, kind: stat.isDirectory() ? 'folder' : 'file' });
        }
        const createdLinks = virtualPaths.createManagedExternalLinksBatch(linkRequests);
        createdTargets.push(...createdLinks.map(item => item.shortcutPath));
        createdManagedLinkIds.push(...createdLinks.map(item => item.linkId));
        createdManagedLinks.push(...createdLinks.map(item => ({ shortcutPath: item.shortcutPath, linkId: item.linkId })));
        if (options?.adoptAsOriginal === true) {
          const mediaKind = options?.mediaKind === 'video' ? 'video' : 'image';
          if (linkedItems.some(item => item.kind !== 'folder')) throw new Error('原始素材外链必须选择文件夹；单个文件可以作为普通外链导入，但不能独立成为版本树节点');
          for (const item of linkedItems.filter(item => item.kind === 'folder')) {
            const adopted = await versionService.adoptMediaFolder(importWorkspaceRoot, { projectName, folderPath: item.sourcePath, externalLinkRelativePath: item.relativePath, mode: 'original', mediaKind });
            if (!adopted?.success) throw new Error(adopted?.error || `无法登记原始素材外链：${path.basename(item.sourcePath)}`);
            const progressId = adopted.progressFolder?.id || adopted.progressId;
            if (progressId && adopted.created === true) adoptedProgressIds.push(progressId);
          }
        }
        const watcherResults = linkedItems.map(item => attachManagedExternalWatcher(
          workspacePath, status, projectName, projectPath, item.relativePath, item.sourcePath,
        ));
        const watchDegraded = watcherResults.some(result => !result?.success);
        if (createdTargets.length) {
          const undoOperation = await pushUndoOperation({
          kind: 'remove-created', paths: createdTargets, managedExternalLinkIds: createdManagedLinkIds,
          ...(adoptedProgressIds.length ? { externalAdoptionUndo: { workspaceRoot: importWorkspaceRoot, projectName, progressIds: [...adoptedProgressIds] } } : {}),
          managedExternalWatcher: { workspacePath, status, projectName },
          label: '导入外链',
          });
          importUndoToken = undoOperation?.undoToken || '';
        }
        return { success: true, operationId, count: createdTargets.length, linked: true, items: linkedItems, watchDegraded };
      }
      const reserved = new Set();
      const sourceInfos = [];
      const transferPlan = [];
      for (const source of sourcePaths) {
        const sourcePath = path.resolve(source);
        const stat = await fs.promises.lstat(sourcePath);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error(`不支持导入此文件类型：${path.basename(sourcePath)}`);
        const destination = uniqueDestination(destinationDir, path.basename(sourcePath), reserved, stat.isDirectory());
        const itemPlan = [];
        await collectCopyPlan(sourcePath, destination, itemPlan, { isCancelled: () => job.cancelled });
        transferPlan.push(...itemPlan);
        sourceInfos.push({
          path: sourcePath,
          stat,
          destination,
          plan: itemPlan,
          size: itemPlan.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0),
          fileCount: itemPlan.filter(entry => entry.kind === 'file').length,
        });
      }
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-files', title: `导入文件 · ${projectName}`,
        projectName, resources: [destinationDir, ...sourceInfos.map(source => source.path)], cancelledCode: CANCELLED_CODE,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeProjectFileOperations.set(operationId, job);
      taskNotificationOwned = true;
      await task.start();
      const totalBytes = sourceInfos.reduce((sum, source) => sum + source.size, 0);
      const totalFiles = sourceInfos.reduce((sum, source) => sum + source.fileCount, 0);
      let completedBytes = 0;
      let completedFiles = 0;
      let lastPublishedAt = 0;
      publish({ phase: 'scanning', progress: 0, bytesCopied: 0, totalBytes, filesCopied: 0, totalFiles });
      const report = currentName => {
        const now = Date.now();
        if (now - lastPublishedAt < 80 && completedBytes < totalBytes) return;
        lastPublishedAt = now;
        publish({ phase: preserveOriginal ? 'copying' : 'moving', progress: totalBytes ? Math.min(99, Math.round(completedBytes / totalBytes * 100)) : 0, currentName, bytesCopied: completedBytes, totalBytes, filesCopied: completedFiles, totalFiles });
      };
      if (preserveOriginal) {
        await assertDiskSpace(destinationDir, totalBytes);
        createdTargets.push(...sourceInfos.map(source => source.destination));
        await copyPlannedFiles(transferPlan, {
          destinationRoot: destinationDir,
          ownershipToken: operationId,
          diskSpaceChecked: true,
          isCancelled: () => job.cancelled,
          onProgress: ({ entry, bytesDelta, fileCompleted }) => {
            completedBytes = Math.min(totalBytes, completedBytes + Math.max(0, bytesDelta || 0));
            if (fileCompleted) completedFiles += 1;
            report(path.basename(entry.source));
          },
        });
      } else {
        for (const sourceInfo of sourceInfos) {
          if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
          let itemBytes = 0;
          let itemFiles = 0;
          await movePathAtomic(sourceInfo.path, sourceInfo.destination, {
            ownershipToken: operationId,
            isCancelled: () => job.cancelled,
            onProgress: progress => {
              const bytesDelta = Number.isFinite(progress?.bytesDelta)
                ? Math.max(0, progress.bytesDelta)
                : Math.max(0, Number(progress?.bytesCopied || 0) - itemBytes);
              itemBytes += bytesDelta;
              completedBytes = Math.min(totalBytes, completedBytes + bytesDelta);
              if (progress?.fileCompleted) {
                itemFiles += 1;
                completedFiles += 1;
              }
              report(path.basename(progress?.entry?.source || sourceInfo.path));
            },
          });
          moves.push({ source: sourceInfo.path, destination: sourceInfo.destination });
          completedBytes = Math.min(totalBytes, completedBytes + Math.max(0, sourceInfo.size - itemBytes));
          completedFiles += Math.max(0, sourceInfo.fileCount - itemFiles);
          report(path.basename(sourceInfo.path));
        }
      }
      job.finishing = true;
      publish({ phase: 'finishing', progress: 99, currentName: '正在完成文件导入', bytesCopied: totalBytes, totalBytes, filesCopied: totalFiles, totalFiles });
      if (preserveOriginal && createdTargets.length) await pushUndoOperation({ kind: 'remove-created', paths: createdTargets, label: '导入' });
      if (!preserveOriginal && moves.length) await pushUndoOperation({ kind: 'external-move', moves });
      writeLog('info', 'Files imported into current project directory', { projectName, relativePath, count: sourcePaths.length, preserveOriginal });
      telemetryService?.track('photos_imported', {
        count_bucket: telemetryService.countBucket(sourcePaths.length),
        source: 'project_files',
        preserve_original: preserveOriginal,
      });
      publish({ phase: 'complete', progress: 100, currentName: '文件导入完成', bytesCopied: totalBytes, totalBytes, filesCopied: totalFiles, totalFiles });
      task.complete('文件导入完成');
      return { success: true, operationId, taskNotificationOwned: true, count: sourcePaths.length };
    } catch (error) {
      if (importUndoToken) removeUndoOperation(importUndoToken);
      let preserveCreatedExternalLinks = false;
      const cleanupErrors = [];
      if (adoptedProgressIds.length && importWorkspaceRoot) {
        try {
          const rollback = await versionService.revertExternalAdoptions(importWorkspaceRoot, { projectName, progressIds: adoptedProgressIds });
          if (!rollback?.success) throw new Error(rollback?.error || '外链版本节点回滚失败');
        } catch (rollbackError) {
          preserveCreatedExternalLinks = true;
          cleanupErrors.push({ path: 'external-adoption-registry', error: rollbackError.message || String(rollbackError) });
          writeLog('error', 'Unable to roll back adopted external originals; preserving managed links for recovery', { progressIds: adoptedProgressIds, error: rollbackError.message || String(rollbackError) });
        }
      }
      for (const move of [...moves].reverse()) {
        try {
          if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) await movePathAtomic(move.destination, move.source);
        } catch (rollbackError) {
          cleanupErrors.push({ path: move.destination, error: rollbackError.message || String(rollbackError) });
          writeLog('error', 'Unable to roll back project file import', { move, error: rollbackError.message || String(rollbackError) });
        }
      }
      const cleaned = await cleanupImportArtifacts({ fs, virtualPaths, targets: createdTargets, managedLinks: createdManagedLinks, preserveManagedLinks: preserveCreatedExternalLinks, cleanupErrors, writeLog, logLabel: 'import', allowedRoots: importCleanupRoots, ownedTargets: createdTargets });
      preserveCreatedExternalLinks = cleaned.preserveManagedLinks;
      if (createdManagedLinks.length) {
        try { await watchProjectFileRoot(workspacePath, status, projectName, { reconcile: true }); }
        catch (watchError) {
          cleanupErrors.push({ path: 'external-watchers', error: watchError.message || String(watchError) });
        }
      }
      const cancelled = error?.code === CANCELLED_CODE;
      const leftoverPaths = cleaned.leftoverPaths;
      const recoveryRequired = preserveCreatedExternalLinks || cleanupErrors.length > 0 || leftoverPaths.length > 0;
      const recoveryMessage = recoveryRequired ? '；部分导入结果已保留，请刷新后处理，勿直接重复导入' : '';
      const failureMessage = `${error.message || String(error)}${recoveryMessage}`;
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, error: failureMessage });
      if (cancelled) task?.cancelled();
      else task?.fail(error);
      if (!cancelled) writeLog('error', 'Project file import failed', error);
      return cancelled
        ? { success: true, cancelled: true, operationId, taskNotificationOwned, count: 0, ...(recoveryRequired ? { recoveryRequired: true, recovery: { operationId, leftoverPaths, cleanupErrors, preservedProgressIds: [...adoptedProgressIds] } } : {}) }
        : { success: false, operationId, taskNotificationOwned, error: failureMessage, ...(recoveryRequired ? { recoveryRequired: true, recovery: { operationId, leftoverPaths, cleanupErrors, preservedProgressIds: [...adoptedProgressIds] } } : {}) };
    } finally {
      releaseCleanupOwnership(operationId);
      activeProjectFileOperations.delete(operationId);
    }
  });
  
  ipcMain.handle('workspace-import-progress-files', async (event, workspacePath, status, projectName, folderName, options = {}) => {
    const operationId = crypto.randomUUID();
    let taskNotificationOwned = false;
    let job = { cancelled: false, finishing: false };
    let task = null;
    const publish = payload => task?.publish(payload);
    let createdFolder = '';
    const createdTargets = [];
    const createdManagedLinks = [];
    let createdExternalProgressId = '';
    let progressWorkspaceRoot = '';
    let progressUndoToken = '';
    let progressCleanupRoots = [];
    const moves = [];
    try {
      const mediaKind = options.mediaKind === 'video' ? 'video' : 'image';
      const deleteSourceAfterImport = options?.deleteSourceAfterImport === true;
      const preserveOriginal = !deleteSourceAfterImport;
      const workspaceRoot = ensureWorkspace(workspacePath);
      progressWorkspaceRoot = workspaceRoot;
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const appendProgressId = String(options.appendProgressId || '');
      const appendProgress = appendProgressId
        ? (await versionService.listProgress(workspaceRoot, projectName)).progressFolders?.find(progress => progress.id === appendProgressId)
        : null;
      if (appendProgressId && (!appendProgress || appendProgress.folderMissing)) throw new Error('要追加的进度文件夹不存在');
      if (appendProgress && (appendProgress.nodeRole !== 'progress' || !appendProgress.parentProgressId || appendProgress.relationKind !== 'main')) throw new Error('只能向已连接有效父版本的普通进度追加文件');
      if (appendProgress && (appendProgress.mediaKind !== mediaKind || appendProgress.versionKey !== String(options.versionKey || ''))) {
        throw new Error('追加目标与所选进度类型或版本号不一致');
      }
      const cleanedName = cleanProjectName(String(appendProgress?.displayName || folderName || ''));
      if (!cleanedName) throw new Error('进度文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const destinationDir = path.resolve(appendProgress ? appendProgress.folderPath : path.join(projectPath, cleanedName));
      progressCleanupRoots = [projectPath, destinationDir];
      if (appendProgress?.externalLinkRelativePath) {
        const appendResolution = virtualPaths.resolve(projectPath, appendProgress.externalLinkRelativePath, { externalRootMode: 'target' });
        if (!appendResolution.viaExternalLink || path.resolve(appendResolution.physicalPath).toLocaleLowerCase() !== destinationDir.toLocaleLowerCase()) {
          throw new Error('外链进度位置与数据库记录不一致，请先重新定位外链');
        }
      } else if (!destinationDir.startsWith(projectPath + path.sep)) {
        throw new Error('无效的进度文件夹名称');
      }
      if (appendProgress ? !fs.existsSync(destinationDir) : fs.existsSync(destinationDir)) {
        throw new Error(appendProgress ? '要追加的进度文件夹不存在' : '同名进度文件夹已存在');
      }
      const extensions = mediaKind === 'video'
        ? [...VIDEO_EXTENSIONS].map(value => value.slice(1))
        : [...new Set([...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS])].map(value => value.slice(1));
      const progressConflictPolicy = ['skip', 'keep-both'].includes(options.progressConflictPolicy) ? options.progressConflictPolicy : '';
      let selectedSourcePaths;
      if (progressConflictPolicy) {
        if (!appendProgress) throw new Error('只能在向已有进度追加文件时处理同名冲突');
        if (!Array.isArray(options.sourcePaths) || !options.sourcePaths.length) throw new Error('同名文件冲突确认已失效，请重新选择文件');
        selectedSourcePaths = options.sourcePaths.map(value => String(value));
      } else if (Array.isArray(options.sourcePaths) && options.sourcePaths.length) {
        selectedSourcePaths = options.sourcePaths.map(value => String(value));
      } else {
        const choice = await dialog.showOpenDialog(mainWindow, {
          title: mediaKind === 'video' ? '选择要导入的视频版本' : '选择要导入的图片版本',
          properties: options.linkOnly === true ? ['openDirectory'] : ['openFile', 'multiSelections'],
          filters: options.linkOnly === true ? undefined : [{ name: mediaKind === 'video' ? '视频文件' : '图片与 RAW', extensions }],
        });
        if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0 };
        selectedSourcePaths = choice.filePaths;
      }
      if (options.linkOnly === true) {
        if (appendProgress) throw new Error('外链模式不能向已有进度追加文件，请新建一个外链进度');
        if (selectedSourcePaths.length !== 1) throw new Error('外链进度一次需要选择一个文件夹');
        const source = path.resolve(selectedSourcePaths[0]);
        const sourceStat = await fs.promises.stat(source).catch(() => null);
        if (!sourceStat?.isDirectory()) throw new Error('外链进度必须选择一个文件夹');
        const shortcutPath = path.join(projectPath, `${cleanedName}.lnk`);
        if (fs.existsSync(shortcutPath) || fs.existsSync(destinationDir)) throw new Error('同名进度文件夹或外链已存在');
        const createdLink = virtualPaths.createManagedExternalLink(shortcutPath, { target: source, kind: 'folder', displayName: path.basename(source) });
        createdTargets.push(shortcutPath);
        createdManagedLinks.push({ shortcutPath, linkId: createdLink.linkId });
        const registered = await versionService.registerProgress(workspaceRoot, {
          projectName,
          mediaKind,
          versionKey: options.versionKey,
          parentProgressId: options.parentProgressId,
          displayName: cleanedName,
          folderPath: source,
          externalLinkRelativePath: path.relative(projectPath, shortcutPath).replace(/\\/g, '/'),
          trackingEnabled: Boolean(options.trackingEnabled),
          trackingState: options.trackingState,
        });
        if (!registered?.success || !registered.progressFolder) throw new Error(registered?.error || '无法登记外链版本进度');
        createdExternalProgressId = registered.progressFolder.id;
        const watcherResult = attachManagedExternalWatcher(
          workspacePath, status, projectName, projectPath,
          path.relative(projectPath, shortcutPath).replace(/\\/g, '/'), source,
        );
        const undoOperation = await pushUndoOperation({
          kind: 'remove-created', paths: [shortcutPath], managedExternalLinkIds: [createdLink.linkId],
          externalProgressUndo: { workspaceRoot, projectName, progressId: createdExternalProgressId },
          managedExternalWatcher: { workspacePath, status, projectName },
          label: '导入外链进度',
        });
        progressUndoToken = undoOperation?.undoToken || '';
        return {
          success: true,
          operationId,
          linked: true,
          count: 1,
          importedPaths: [source],
          progressFolder: registered.progressFolder,
          watchDegraded: !watcherResult?.success,
          folder: { name: path.basename(shortcutPath), path: shortcutPath, relativePath: path.relative(projectPath, shortcutPath).replace(/\\/g, '/'), updatedAt: Date.now() },
        };
      }
      const expandedSourcePaths = [];
      const expandSource = async source => {
        const resolved = path.resolve(source);
        const stat = await fs.promises.stat(resolved);
        if (stat.isFile()) { expandedSourcePaths.push(resolved); return; }
        if (!stat.isDirectory()) throw new Error(`不支持的导入来源：${path.basename(resolved)}`);
        const children = await fs.promises.readdir(resolved, { withFileTypes: true });
        for (const child of children) await expandSource(path.join(resolved, child.name));
      };
      for (const source of selectedSourcePaths) await expandSource(source);
      selectedSourcePaths = expandedSourcePaths;
      let sourceInfos = [];
      for (const source of selectedSourcePaths) {
        const sourceInfo = await assertRegularFile(source);
        const extension = path.extname(sourceInfo.path).toLowerCase();
        const supported = mediaKind === 'video' ? VIDEO_EXTENSIONS.has(extension) : IMAGE_EXTENSIONS.has(extension) || RAW_EXTENSIONS.has(extension);
        if (!supported) throw new Error(`所选文件不属于${mediaKind === 'video' ? '视频' : '图片'}进度：${path.basename(sourceInfo.path)}`);
        sourceInfos.push(sourceInfo);
      }
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-progress', title: `导入版本进度 · ${projectName}`,
        projectName, resources: [destinationDir, ...sourceInfos.map(source => source.path)], cancelledCode: CANCELLED_CODE, emitLegacyProgress: true,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeProjectFileOperations.set(operationId, job);
      taskNotificationOwned = true;
      await task.start();
      let totalBytes = sourceInfos.reduce((sum, source) => sum + source.stat.size, 0);
      publish({ phase: 'scanning', progress: 0, currentName: '正在检查重复文件', bytesCopied: 0, totalBytes, filesCopied: 0, totalFiles: sourceInfos.length });
      let skippedCount = 0;
      const skippedNames = [];
      if (appendProgress) {
        const digestFile = filePath => new Promise((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          const stream = fs.createReadStream(filePath);
          stream.on('data', chunk => {
            if (job.cancelled) {
              stream.destroy(Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE }));
              return;
            }
            hash.update(chunk);
          });
          stream.on('error', reject);
          stream.on('end', () => resolve(hash.digest('hex')));
        });
        const collisionRecords = [];
        for (const sourceInfo of sourceInfos) {
          if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
          const existingPath = path.join(destinationDir, path.basename(sourceInfo.path));
          if (!fs.existsSync(existingPath) || !fs.statSync(existingPath).isFile()) continue;
          const [sourceStat, existingStat] = await Promise.all([fs.promises.stat(sourceInfo.path), fs.promises.stat(existingPath)]);
          collisionRecords.push({ sourcePath: sourceInfo.path, existingPath, sourceStat, existingStat });
        }
        const conflictCacheKey = crypto.createHash('sha256').update(JSON.stringify({
          destinationDir,
          files: collisionRecords.map(record => ({
            sourcePath: record.sourcePath,
            sourceSize: record.sourceStat.size,
            sourceMtimeMs: record.sourceStat.mtimeMs,
            existingPath: record.existingPath,
            existingSize: record.existingStat.size,
            existingMtimeMs: record.existingStat.mtimeMs,
          })),
        })).digest('hex');
        pruneProgressImportConflictCache();
        const cachedConflicts = progressImportConflictCache.get(conflictCacheKey);
        const exactDuplicates = new Set(cachedConflicts?.exactDuplicates || []);
        const conflicts = [...(cachedConflicts?.conflicts || [])];
        if (!cachedConflicts) {
          for (const record of collisionRecords) {
            if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
            const identical = record.sourceStat.size === record.existingStat.size
              && await digestFile(record.sourcePath) === await digestFile(record.existingPath);
            if (identical) exactDuplicates.add(record.sourcePath);
            else conflicts.push(record.sourcePath);
          }
          progressImportConflictCache.set(conflictCacheKey, {
            exactDuplicates: [...exactDuplicates],
            conflicts: [...conflicts],
            expiresAt: Date.now() + 10 * 60 * 1000,
          });
        }
        const keepConflicts = progressConflictPolicy === 'keep-both';
        if (conflicts.length) {
          if (!progressConflictPolicy) {
            const conflictNames = conflicts.slice(0, 6).map(filePath => path.basename(filePath));
            const more = conflicts.length > conflictNames.length ? `等 ${conflicts.length} 个文件` : conflictNames.map(name => `“${name}”`).join('、');
            publish({ phase: 'complete', progress: 100, currentName: '等待处理同名文件', count: 0, decisionRequired: true });
            task.complete('等待用户处理同名文件');
            return {
              success: true,
              operationId,
              count: 0,
              requiresDecision: {
                kind: 'progress-import-conflict',
                names: conflictNames,
                conflictCount: conflicts.length,
                sourcePaths: selectedSourcePaths,
                message: `追加进度时发现 ${more}与现有文件同名，但内容不同。`,
                detail: '可以跳过这些文件，或者保留两份并为新文件自动添加编号。现有进度文件不会被覆盖。',
              },
            };
          }
        }
        const skippedPaths = new Set([...exactDuplicates, ...(keepConflicts ? [] : conflicts)]);
        skippedCount = skippedPaths.size;
        skippedNames.push(...[...skippedPaths].map(filePath => path.basename(filePath)));
        sourceInfos = sourceInfos.filter(sourceInfo => !skippedPaths.has(sourceInfo.path));
      }
      if (!appendProgress) {
        await fs.promises.mkdir(destinationDir);
        createdFolder = destinationDir;
      }
      totalBytes = sourceInfos.reduce((sum, source) => sum + source.stat.size, 0);
      let completedBytes = 0;
      let completedFiles = 0;
      let lastPublishedAt = 0;
      publish({ phase: 'scanning', progress: 0, bytesCopied: 0, totalBytes, filesCopied: 0, totalFiles: sourceInfos.length });
      const report = (sourceInfo, itemBytes) => {
        const now = Date.now();
        if (now - lastPublishedAt < 80 && itemBytes < sourceInfo.stat.size) return;
        lastPublishedAt = now;
        const bytesCopied = Math.min(totalBytes, completedBytes + itemBytes);
        publish({ phase: preserveOriginal ? 'copying' : 'moving', progress: totalBytes ? Math.min(99, Math.round(bytesCopied / totalBytes * 100)) : 0, currentName: path.basename(sourceInfo.path), bytesCopied, totalBytes, filesCopied: completedFiles, totalFiles: sourceInfos.length });
      };
      const reserved = new Set();
      for (const sourceInfo of sourceInfos) {
        if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
        const destination = uniqueDestination(destinationDir, path.basename(sourceInfo.path), reserved);
        if (preserveOriginal) {
          await copyFileAtomic(sourceInfo.path, destination, { ownershipToken: operationId, isCancelled: () => job.cancelled, onProgress: progress => report(sourceInfo, progress.bytesCopied) });
          createdTargets.push(destination);
        } else {
          await moveFileAtomic(sourceInfo.path, destination, { ownershipToken: operationId, isCancelled: () => job.cancelled, onProgress: progress => report(sourceInfo, progress.bytesCopied) });
          moves.push({ source: sourceInfo.path, destination });
        }
        completedBytes += sourceInfo.stat.size;
        completedFiles += 1;
        report(sourceInfo, sourceInfo.stat.size);
      }
      job.finishing = true;
      publish({ phase: 'finishing', progress: 99, currentName: '正在登记版本进度', bytesCopied: totalBytes, totalBytes, filesCopied: sourceInfos.length, totalFiles: sourceInfos.length });
      const registered = appendProgress ? await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: appendProgress.mediaKind,
        versionKey: appendProgress.versionKey,
        parentProgressId: appendProgress.parentProgressId,
        displayName: appendProgress.displayName,
        folderPath: appendProgress.folderPath,
        externalLinkRelativePath: appendProgress.externalLinkRelativePath || undefined,
        trackingEnabled: false,
        trackingState: options.trackingState || appendProgress.trackingState,
        progressId: appendProgress.id,
      }) : await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind,
        versionKey: options.versionKey,
        parentProgressId: options.parentProgressId,
        displayName: cleanedName,
        folderPath: destinationDir,
        trackingEnabled: Boolean(options.trackingEnabled),
        trackingState: options.trackingState,
      });
      if (preserveOriginal && (appendProgress ? createdTargets.length : true)) await pushUndoOperation({ kind: 'remove-created', paths: appendProgress ? createdTargets : [destinationDir], label: appendProgress ? '追加版本进度' : '导入版本进度' });
      else if (moves.length) await pushUndoOperation({ kind: 'external-move', moves });
      writeLog('info', appendProgress ? 'Files appended to progress version' : 'Progress version files imported', { projectName, folderName: cleanedName, mediaKind, count: sourceInfos.length, skippedCount, preserveOriginal });
      telemetryService?.track('photos_imported', {
        count_bucket: telemetryService.countBucket(sourceInfos.length),
        source: appendProgress ? 'progress_version_append' : 'progress_version',
        media_kind: mediaKind,
        preserve_original: preserveOriginal,
      });
      publish({ phase: 'complete', progress: 100, currentName: '版本进度导入完成', bytesCopied: totalBytes, totalBytes, filesCopied: sourceInfos.length, totalFiles: sourceInfos.length });
      task.complete('版本进度导入完成');
      return {
        success: true,
        operationId,
        taskNotificationOwned: true,
        count: sourceInfos.length,
        skippedCount,
        skippedNames,
        appended: Boolean(appendProgress),
        importedPaths: [...createdTargets, ...moves.map(move => move.destination)],
        progressFolder: registered.progressFolder,
        folder: { name: cleanedName, path: destinationDir, relativePath: path.relative(projectPath, destinationDir).replace(/\\/g, '/'), updatedAt: Date.now() },
      };
    } catch (error) {
      if (progressUndoToken) removeUndoOperation(progressUndoToken);
      const cleanupErrors = [];
      let preserveCreatedExternalLink = false;
      if (createdExternalProgressId && progressWorkspaceRoot) {
        try {
          const rollback = await versionService.unregisterProgress(progressWorkspaceRoot, { projectName, progressId: createdExternalProgressId, allowMissing: true });
          if (!rollback?.success) throw new Error(rollback?.error || '无法回滚外链版本登记');
        } catch (rollbackError) {
          preserveCreatedExternalLink = true;
          cleanupErrors.push({ path: 'external-progress-registration', error: rollbackError.message || String(rollbackError) });
          writeLog('error', 'Unable to roll back external progress registration', rollbackError);
        }
      }
      for (const move of [...moves].reverse()) {
        try {
          if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) {
            await moveFileAtomic(move.destination, move.source);
          }
        } catch (rollbackError) {
          cleanupErrors.push({ path: move.destination, error: rollbackError.message || String(rollbackError) });
          writeLog('error', 'Unable to roll back progress import move', { move, error: rollbackError.message || String(rollbackError) });
        }
      }
      const ownedTargets = [...createdTargets, createdFolder].filter(Boolean);
      const cleaned = await cleanupImportArtifacts({ fs, virtualPaths, targets: ownedTargets, managedLinks: createdManagedLinks, preserveManagedLinks: preserveCreatedExternalLink, cleanupErrors, writeLog, logLabel: 'progress import', allowedRoots: progressCleanupRoots, ownedTargets });
      preserveCreatedExternalLink = cleaned.preserveManagedLinks;
      if (createdManagedLinks.length) {
        try { await watchProjectFileRoot(workspacePath, status, projectName, { reconcile: true }); }
        catch (watchError) { cleanupErrors.push({ path: 'external-watchers', error: watchError.message || String(watchError) }); }
      }
      const cancelled = error?.code === CANCELLED_CODE;
      const leftoverPaths = cleaned.leftoverPaths;
      const recoveryRequired = preserveCreatedExternalLink || cleanupErrors.length > 0 || leftoverPaths.length > 0;
      const failureMessage = `${error.message || String(error)}${recoveryRequired ? '；部分导入结果已保留，请刷新后处理，勿直接重复导入' : ''}`;
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, error: failureMessage });
      if (cancelled) task?.cancelled();
      else task?.fail(error);
      if (!cancelled) writeLog('error', 'Progress version import failed', { projectName, folderName, error: error.message || String(error) });
      const recovery = recoveryRequired ? { recoveryRequired: true, recovery: { operationId, leftoverPaths, cleanupErrors, preservedProgressIds: createdExternalProgressId ? [createdExternalProgressId] : [] } } : {};
      return cancelled ? { success: true, cancelled: true, operationId, taskNotificationOwned, count: 0, ...recovery } : { success: false, operationId, taskNotificationOwned, error: failureMessage, ...recovery };
    } finally {
      releaseCleanupOwnership(operationId);
      activeProjectFileOperations.delete(operationId);
    }
  });

  return {
    refreshManagedExternalWatchers: async (workspacePath, status, projectName) => {
      try { return await watchProjectFileRoot(workspacePath, status, projectName); }
      catch (error) {
        writeLog('warn', 'Unable to refresh managed external watchers after file operation', { workspacePath, status, projectName, error: error.message || String(error) });
        return { success: false, error: error.message || String(error) };
      }
    },
  };
};

module.exports = { normalizeProjectFileListFilter, projectFileListEntryMatchesFilter, projectFileListSessionMatches, registerWorkspaceIpc, runWorkspaceMaintenanceWithRetry, workspaceDatabaseTaskResource };
