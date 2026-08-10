const { CANCELLED_CODE: WORKFLOW_CANCELLED_CODE, buildWorkflowPlan, copyWorkflowPlan } = require('../services/team-workflow-generation.cjs');

const workflowGenerationJobs = new Map();

const registerVersionIpc = context => {
  const { Array, Boolean, Error, IMAGE_EXTENSIONS, JSON, Math, Number, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, backgroundTasks, buildVersionBatchImportKey, cleanVersionName, copyFileAtomic, crypto, dialog, ensureTrackedVersionThumbnail, ensureWorkspace, exiftool, fs, getProjectPath, getWorkspaceDataRoot, ipcMain, mainWindow, mediaMetadataCache, mediaService, path, pluginService, privacyService, readSavedConfig, recycleBinService, refreshWorkspaceCatalog, releaseWorkspaceWatchPath, resolveProjectEntry, runPythonEventAction, shell, supportedVersionFileKind, suppressWorkspaceWatchPath, thumbnailService, undefined, uniqueDestination, versionService, workspaceCatalogs, writeLog } = context;
  const mediaRatingCache = new Map();
  const normalizedMediaRating = value => Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
  const clearMediaRatingCaches = filePath => {
    const prefix = `${path.resolve(filePath)}|`;
    for (const key of mediaRatingCache.keys()) if (key.startsWith(prefix)) mediaRatingCache.delete(key);
    for (const key of mediaMetadataCache.keys()) if (key.startsWith(`${path.resolve(filePath)}|`)) mediaMetadataCache.delete(key);
  };
  const mediaRatingFromTags = tags => {
    const entries = Object.entries(tags || {});
    const direct = entries.find(([name]) => /^XMP[^:]*:Rating$/i.test(name))
      || entries.find(([name]) => /(?:^|:)Rating$/i.test(name));
    if (direct) return normalizedMediaRating(direct[1]);
    const percent = Number(entries.find(([name]) => /(?:^|:)RatingPercent$/i.test(name))?.[1]);
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    if (percent <= 1) return 1;
    if (percent <= 25) return 2;
    if (percent <= 50) return 3;
    if (percent <= 75) return 4;
    return 5;
  };
  const readMediaRating = async (filePath, knownUpdatedAt) => {
    const stat = await fs.promises.stat(filePath);
    const updatedAt = Number(knownUpdatedAt) || stat.mtimeMs;
    const cacheKey = `${path.resolve(filePath)}|${updatedAt}`;
    if (mediaRatingCache.has(cacheKey)) return mediaRatingCache.get(cacheKey);
    const tags = await exiftool.readRaw(filePath, ['-G1', '-Rating#', '-RatingPercent#', '-n', '-api', 'largefilesupport=1']);
    const rating = mediaRatingFromTags(tags);
    if (mediaRatingCache.size >= 4000) mediaRatingCache.delete(mediaRatingCache.keys().next().value);
    mediaRatingCache.set(cacheKey, rating);
    return rating;
  };
  const shouldSkipRatedScanDirectory = name => name.startsWith('.photoflow-') || /^图片后期_\d+(?:_\d+)*_喜爱$/u.test(name);
  const listRatedProjectMedia = async projectPath => {
    const candidates = [];
    const directories = [projectPath];
    while (directories.length) {
      const directory = directories.pop();
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!shouldSkipRatedScanDirectory(entry.name)) directories.push(filePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTENSIONS.has(extension) || RAW_EXTENSIONS.has(extension)) candidates.push({ filePath, extension });
      }
    }
    const entries = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(6, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor++];
        try {
          const rating = await readMediaRating(candidate.filePath);
          if (!rating) continue;
          const stat = await fs.promises.stat(candidate.filePath);
          entries.push({
            name: path.basename(candidate.filePath),
            path: candidate.filePath,
            relativePath: path.relative(projectPath, candidate.filePath).replace(/\\/g, '/'),
            kind: IMAGE_EXTENSIONS.has(candidate.extension) ? 'image' : 'raw',
            extension: candidate.extension,
            size: stat.size,
            createdAt: stat.birthtimeMs || stat.ctimeMs,
            updatedAt: stat.mtimeMs,
            rating,
          });
        } catch (error) {
          writeLog('warn', 'Unable to inspect media rating', { filePath: candidate.filePath, error: error.message || String(error) });
        }
      }
    });
    await Promise.all(workers);
    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  };
  const teamDataDirectory = (workspaceRoot, photoId, baseVersionId) => path.join(getWorkspaceDataRoot(workspaceRoot), 'team-retouch', photoId, baseVersionId);
  const deliveryName = (photo, basePath) => path.parse(photo?.originalName || photo?.displayName || basePath).name;
  const deliveryDirectory = (photo, basePath) => path.join(path.dirname(photo?.originalFilePath || basePath), `${deliveryName(photo, basePath)}_裁切`);
  const deliveryPath = (photo, basePath, personIndex) => path.join(deliveryDirectory(photo, basePath), `${deliveryName(photo, basePath)}_人物${String(personIndex).padStart(2, '0')}.png`);
  const validProgressFolderName = value => Boolean(value && path.basename(value) === value && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value));
  const compareProgressKeys = (left, right) => {
    const leftParts = String(left || '').split('_').map(Number);
    const rightParts = String(right || '').split('_').map(Number);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
      if ((leftParts[index] ?? -1) !== (rightParts[index] ?? -1)) return (leftParts[index] ?? -1) - (rightParts[index] ?? -1);
    }
    return 0;
  };
  const resolveTeamOutputProgress = async (workspaceRoot, projectName, progressId, sourcePaths = []) => {
    if (!progressId) throw new Error('请先选择或新建合成结果的目标进度');
    const listed = await versionService.listProgress(workspaceRoot, projectName);
    const progress = (listed.progressFolders || []).find(item => item.id === progressId);
    if (!progress || progress.mediaKind !== 'image') throw new Error('合成结果的目标图片进度不存在');
    if (progress.folderMissing || !fs.existsSync(progress.folderPath)) throw new Error(`目标进度文件夹不存在：${progress.displayName}`);
    const sourceDirectories = new Set(sourcePaths.filter(Boolean).map(filePath => path.resolve(path.dirname(filePath)).toLocaleLowerCase()));
    const sourceProgress = [...(listed.progressFolders || [])]
      .filter(item => item.mediaKind === 'image' && sourceDirectories.has(path.resolve(item.folderPath).toLocaleLowerCase()))
      .sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey))
      .at(-1);
    if (sourceProgress && compareProgressKeys(progress.versionKey, sourceProgress.versionKey) <= 0) {
      throw new Error(`合成结果必须保存到高于当前来源 V${sourceProgress.versionKey} 的图片进度`);
    }
    return progress;
  };
  const isInside = (root, candidate) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const safeWorkflowSegment = (value, fallback) => String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 60) || fallback;
  const workflowGenerationKey = (workspacePath, status, projectName) => `${path.resolve(workspacePath).toLocaleLowerCase()}\0${String(status)}\0${String(projectName).toLocaleLowerCase()}`;
  const chineseWeekNumber = value => {
    const number = Math.max(1, Math.floor(Number(value) || 1));
    const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (number < 10) return digits[number];
    if (number === 10) return '十';
    if (number < 20) return `十${digits[number % 10]}`;
    if (number < 100) return `${digits[Math.floor(number / 10)]}十${digits[number % 10]}`;
    return String(number);
  };
  const teamWorkflowOutput = (workspacePath, status, projectName) => {
    const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
    const outputDirectory = path.resolve(projectPath, '团片协作');
    if (!isInside(projectPath, outputDirectory) || path.basename(outputDirectory) !== '团片协作') throw new Error('工作流程目录无效');
    const workflowDataDirectory = path.join(getWorkspaceDataRoot(workspacePath), 'team-retouch', 'workflows');
    const workflowKey = crypto.createHash('sha256').update(`${String(status)}\0${String(projectName)}`).digest('hex');
    return {
      projectPath,
      outputDirectory,
      workflowDataDirectory,
      manifestPath: path.join(workflowDataDirectory, `${workflowKey}.json`),
      legacyManifestPath: path.join(outputDirectory, '.photoflow-workflow.json'),
    };
  };
  const readTeamWorkflowManifest = async (workspaceRoot, status, projectName) => {
    const target = teamWorkflowOutput(workspaceRoot, status, projectName);
    let sourcePath = target.manifestPath;
    if (!fs.existsSync(sourcePath) && fs.existsSync(target.legacyManifestPath)) sourcePath = target.legacyManifestPath;
    if (!fs.existsSync(sourcePath)) return { ...target, manifest: null };
    const manifest = JSON.parse(await fs.promises.readFile(sourcePath, 'utf8'));
    if (sourcePath === target.legacyManifestPath) {
      await fs.promises.mkdir(target.workflowDataDirectory, { recursive: true });
      await fs.promises.writeFile(target.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      await fs.promises.rm(target.legacyManifestPath, { force: true });
    }
    return { ...target, manifest };
  };
  const replaceFileAtomic = async (sourcePath, destinationPath) => {
    if (!fs.existsSync(destinationPath)) return copyFileAtomic(sourcePath, destinationPath);
    const backupPath = `${destinationPath}.${crypto.randomUUID()}.photoflow-backup`;
    await fs.promises.rename(destinationPath, backupPath);
    try {
      await copyFileAtomic(sourcePath, destinationPath);
      await fs.promises.rm(backupPath, { force: true });
    } catch (error) {
      await fs.promises.rm(destinationPath, { force: true }).catch(() => undefined);
      await fs.promises.rename(backupPath, destinationPath).catch(() => undefined);
      throw error;
    }
  };
  const writeTeamWorkflowManifest = async (workflowDataDirectory, manifestPath, manifest) => {
    await fs.promises.mkdir(workflowDataDirectory, { recursive: true });
    const pendingPath = `${manifestPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(pendingPath, JSON.stringify(manifest, null, 2), 'utf8');
      await replaceFileAtomic(pendingPath, manifestPath);
    } finally {
      await fs.promises.rm(pendingPath, { force: true }).catch(() => undefined);
    }
  };
  const teamWorkflowReturnReviewTarget = (workspaceRoot, projectName) => {
    const reviewRoot = path.join(getWorkspaceDataRoot(workspaceRoot), 'team-retouch', 'workflow-return-reviews');
    const projectKey = crypto.createHash('sha256').update(String(projectName)).digest('hex');
    const directory = path.join(reviewRoot, projectKey);
    return { reviewRoot, directory, sessionPath: path.join(directory, 'session.json') };
  };
  const readTeamWorkflowReturnReview = async (workspaceRoot, projectName) => {
    const target = teamWorkflowReturnReviewTarget(workspaceRoot, projectName);
    if (!fs.existsSync(target.sessionPath)) return { ...target, session: null };
    const session = JSON.parse(await fs.promises.readFile(target.sessionPath, 'utf8'));
    if (String(session.projectName) !== String(projectName) || !session.id || Number(session.version) !== 1) throw new Error('待确认返图批次数据无效');
    return { ...target, session };
  };
  const presentTeamWorkflowReturnReview = session => ({
    ...session.result,
    reviewSessionId: session.id,
    matches: (session.result?.matches || []).map(match => ({
      ...match,
      mediaPath: match.path && fs.existsSync(match.path) ? `media-token:${mediaService.grantPath(path.resolve(match.path))}` : undefined,
    })),
  });
  const writeTeamWorkflowReturnReview = async (sessionPath, session) => {
    const pendingPath = `${sessionPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(pendingPath, JSON.stringify(session, null, 2), 'utf8');
      await replaceFileAtomic(pendingPath, sessionPath);
    } finally {
      await fs.promises.rm(pendingPath, { force: true }).catch(() => undefined);
    }
  };
  const discardTeamWorkflowReturnReview = async (workspaceRoot, projectName, expectedSessionId = '') => {
    const target = await readTeamWorkflowReturnReview(workspaceRoot, projectName);
    if (!target.session) return false;
    if (expectedSessionId && String(target.session.id) !== String(expectedSessionId)) throw new Error('待确认返图批次已经变化，请刷新后重试');
    await fs.promises.rm(target.directory, { recursive: true, force: true });
    return true;
  };
  const resolveWorkflowSource = async (workspaceRoot, item) => {
    const patches = await versionService.listTeamPatches(workspaceRoot, item.photoId);
    const task = patches.tasks.find(candidate => candidate.id === item.taskId && candidate.baseVersionId === item.baseVersionId);
    if (!task) return null;
    const containsPerson = (task.members?.length ? task.members : [{ personIndex: task.personIndex }]).some(member => member.personIndex === item.personIndex);
    if (!containsPerson) return null;
    const sourcePath = task.editedPatchPath && fs.existsSync(task.editedPatchPath) ? task.editedPatchPath : task.patchPath;
    return sourcePath && fs.existsSync(sourcePath) ? sourcePath : null;
  };
  const refreshDownstreamWorkflowFiles = async (workspaceRoot, status, projectName, taskId, personIndex, sourcePath) => {
    if (!status || !projectName || !sourcePath || !fs.existsSync(sourcePath)) return;
    const { outputDirectory, manifestPath, workflowDataDirectory, manifest } = await readTeamWorkflowManifest(workspaceRoot, status, projectName);
    if (!manifest) return;
    const chain = [];
    for (const [groupIndex, group] of (manifest.groups || []).entries()) {
      for (const [itemIndex, item] of (group.items || []).entries()) {
        if (String(item.taskId) === String(taskId)) chain.push({ group, item, groupIndex, itemIndex });
      }
    }
    chain.sort((left, right) => (Number(left.group.week) || 1) - (Number(right.group.week) || 1) || left.groupIndex - right.groupIndex || left.itemIndex - right.itemIndex || Number(left.item.personIndex) - Number(right.item.personIndex));
    const sourceIndex = chain.findIndex(entry => Number(entry.item.personIndex) === Number(personIndex));
    if (sourceIndex < 0) return;
    const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
    const assignments = new Map((workspace.assignments || []).map(item => [`${item.photoId}\0${item.baseVersionId}\0${Number(item.personIndex)}`, item]));

    // A task image is a baton: after one person finishes, remove every stale
    // future copy and materialize only the direct next unfinished hand-off.
    for (let index = sourceIndex; index < chain.length; index += 1) {
      const entry = chain[index];
      entry.item.available = false;
      if (!entry.item.relativePath) continue;
      const stalePath = path.resolve(outputDirectory, entry.item.relativePath);
      if (isInside(outputDirectory, stalePath)) await fs.promises.rm(stalePath, { force: true }).catch(() => undefined);
    }

    let nextIndex = sourceIndex + 1;
    while (nextIndex < chain.length) {
      const next = chain[nextIndex];
      const assignment = assignments.get(`${next.item.photoId}\0${next.item.baseVersionId}\0${Number(next.item.personIndex)}`);
      if (assignment?.completed) {
        nextIndex += 1;
        continue;
      }
      if (assignment?.completionKind === 'skip-requested') {
        await versionService.completeTeamIdentity(workspaceRoot, {
          photoId: next.item.photoId,
          baseVersionId: next.item.baseVersionId,
          personIndex: next.item.personIndex,
          completed: true,
          completionKind: 'no-retouch',
        });
        nextIndex += 1;
        continue;
      }
      if (!next.item.relativePath) break;
      const oldDestination = path.resolve(outputDirectory, next.item.relativePath);
      if (!isInside(outputDirectory, oldDestination)) break;
      const parsed = path.parse(oldDestination);
      const extension = path.extname(sourcePath).toLowerCase() || parsed.ext || '.png';
      const destination = path.join(parsed.dir, `${parsed.name}${extension}`);
      if (!isInside(outputDirectory, destination)) break;
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await replaceFileAtomic(sourcePath, destination);
      if (path.resolve(oldDestination) !== path.resolve(destination)) await fs.promises.rm(oldDestination, { force: true }).catch(() => undefined);
      next.item.relativePath = path.relative(outputDirectory, destination).replace(/\\/g, '/');
      next.item.available = true;
      break;
    }
    await writeTeamWorkflowManifest(workflowDataDirectory, manifestPath, manifest);
  };
  const rewindWorkflowFiles = async (workspaceRoot, status, projectName, taskId, personIndex, sourcePath) => {
    if (!status || !projectName || !sourcePath || !fs.existsSync(sourcePath)) return;
    const { outputDirectory, manifestPath, workflowDataDirectory, manifest } = await readTeamWorkflowManifest(workspaceRoot, status, projectName);
    if (!manifest) return;
    const chain = [];
    for (const [groupIndex, group] of (manifest.groups || []).entries()) {
      for (const [itemIndex, item] of (group.items || []).entries()) {
        if (String(item.taskId) === String(taskId)) chain.push({ group, item, groupIndex, itemIndex });
      }
    }
    chain.sort((left, right) => (Number(left.group.week) || 1) - (Number(right.group.week) || 1) || left.groupIndex - right.groupIndex || left.itemIndex - right.itemIndex);
    const targetIndex = chain.findIndex(entry => Number(entry.item.personIndex) === Number(personIndex));
    if (targetIndex < 0) return;
    for (let index = targetIndex; index < chain.length; index += 1) {
      const entry = chain[index];
      entry.item.available = index === targetIndex;
      if (!entry.item.relativePath) continue;
      const oldPath = path.resolve(outputDirectory, entry.item.relativePath);
      if (!isInside(outputDirectory, oldPath)) continue;
      if (index > targetIndex) {
        await fs.promises.rm(oldPath, { force: true }).catch(() => undefined);
        continue;
      }
      const parsed = path.parse(oldPath);
      const extension = path.extname(sourcePath).toLowerCase() || parsed.ext || '.png';
      const destination = path.join(parsed.dir, `${parsed.name}${extension}`);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await replaceFileAtomic(sourcePath, destination);
      if (path.resolve(oldPath) !== path.resolve(destination)) await fs.promises.rm(oldPath, { force: true }).catch(() => undefined);
      entry.item.relativePath = path.relative(outputDirectory, destination).replace(/\\/g, '/');
    }
    await writeTeamWorkflowManifest(workflowDataDirectory, manifestPath, manifest);
  };
  const refreshWorkflowTaskSourceFiles = async (workspaceRoot, status, projectName, taskId, sourcePath) => {
    if (!status || !projectName || !taskId || !sourcePath || !fs.existsSync(sourcePath)) return 0;
    const { outputDirectory, manifest } = await readTeamWorkflowManifest(workspaceRoot, status, projectName);
    if (!manifest) return 0;
    let refreshedCount = 0;
    for (const group of manifest.groups || []) {
      for (const item of group.items || []) {
        if (item.taskId !== taskId || !item.available || !item.relativePath) continue;
        const destination = path.resolve(outputDirectory, item.relativePath);
        if (!isInside(outputDirectory, destination)) continue;
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await replaceFileAtomic(sourcePath, destination);
        refreshedCount += 1;
      }
    }
    return refreshedCount;
  };
  const removeCleanupArtifacts = async (workspaceRoot, cleanup = {}) => {
    const dataRoot = path.resolve(getWorkspaceDataRoot(workspaceRoot));
    const removed = new Set();
    for (const item of cleanup.deletedVersions || []) {
      if (item.thumbnailPath) {
        const thumbnailPath = path.resolve(item.thumbnailPath);
        const managed = path.basename(thumbnailPath).toLocaleLowerCase() === `${item.id}.jpg`.toLocaleLowerCase()
          && path.basename(path.dirname(thumbnailPath)).toLocaleLowerCase() === String(item.photoId).toLocaleLowerCase()
          && path.basename(path.dirname(path.dirname(thumbnailPath))).toLocaleLowerCase() === 'thumbnails'
          && isInside(dataRoot, thumbnailPath);
        if (managed) {
          await fs.promises.rm(thumbnailPath, { force: true }).catch(() => undefined);
          removed.add(thumbnailPath);
        }
      }
    }
    for (const candidate of cleanup.teamArtifactPaths || []) {
      if (!candidate) continue;
      const resolved = path.resolve(candidate);
      const deliveryParent = path.dirname(resolved);
      const safeDeliveryFile = isInside(workspaceRoot, resolved) && path.basename(deliveryParent).endsWith('_裁切');
      if (!isInside(dataRoot, resolved) && !safeDeliveryFile) continue;
      await fs.promises.rm(resolved, { force: true }).catch(() => undefined);
      removed.add(resolved);
      if (safeDeliveryFile) await fs.promises.rmdir(deliveryParent).catch(() => undefined);
    }
    const teamDataKeys = cleanup.teamDataKeys || (cleanup.deletedVersions || []).map(item => ({ photoId: item.photoId, baseVersionId: item.id }));
    for (const item of teamDataKeys) {
      const directory = path.resolve(teamDataDirectory(workspaceRoot, item.photoId, item.baseVersionId));
      if (!isInside(dataRoot, directory)) continue;
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      removed.add(directory);
    }
    await thumbnailService.invalidateSources(cleanup.sourcePaths || []).catch(error => {
      writeLog('warn', 'Unable to clear deleted version thumbnail cache', { error: error.message || String(error) });
    });
    return removed.size;
  };

  const queueCleanupArtifacts = (workspaceRoot, cleanup = {}, title = '清理版本内部文件') => {
    const snapshot = {
      deletedVersions: [...(cleanup.deletedVersions || [])],
      teamArtifactPaths: [...(cleanup.teamArtifactPaths || [])],
      teamDataKeys: cleanup.teamDataKeys ? [...cleanup.teamDataKeys] : undefined,
      sourcePaths: [...(cleanup.sourcePaths || [])],
    };
    const execute = async task => {
      task?.report(20, title);
      const removedArtifactCount = await removeCleanupArtifacts(workspaceRoot, snapshot);
      task?.report(100, '内部文件清理完成');
      return { removedArtifactCount };
    };
    if (!backgroundTasks?.run) {
      setTimeout(() => void execute().catch(error => writeLog('warn', 'Deferred artifact cleanup failed', { error: error.message || String(error) })), 0);
      return;
    }
    const dedupeKey = `internal-artifact-cleanup:${crypto.randomUUID()}`;
    const run = () => backgroundTasks.run({
      type: 'internal-artifact-cleanup',
      title,
      dedupeKey,
      cancellable: false,
      metadata: { workspaceRoot },
    }, execute, run);
    setTimeout(() => void run().catch(error => writeLog('warn', 'Deferred artifact cleanup failed', { error: error.message || String(error) })), 250);
  };

  const queueFilesystemCleanup = (paths, title = '清理旧工作流文件') => {
    const targets = [...new Set((paths || []).filter(Boolean).map(candidate => path.resolve(candidate)))];
    if (!targets.length) return;
    const execute = async task => {
      task?.report(20, title);
      for (const target of targets) await fs.promises.rm(target, { recursive: true, force: true }).catch(error => {
        writeLog('warn', 'Deferred filesystem cleanup failed', { path: target, error: error.message || String(error) });
      });
      task?.report(100, '旧文件清理完成');
      return { removedCount: targets.length };
    };
    if (!backgroundTasks?.run) {
      setTimeout(() => void execute(), 0);
      return;
    }
    const dedupeKey = `internal-filesystem-cleanup:${crypto.randomUUID()}`;
    const run = () => backgroundTasks.run({
      type: 'internal-filesystem-cleanup',
      title,
      dedupeKey,
      cancellable: false,
    }, execute, run);
    setTimeout(() => void run().catch(error => writeLog('warn', 'Deferred filesystem cleanup failed', { error: error.message || String(error) })), 250);
  };

  ipcMain.handle('workspace-media-versions', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const filePath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('素材文件不存在');
      const extension = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension) && !RAW_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) throw new Error('只有图片、RAW 和视频可以建立版本');
      const result = await versionService.getMedia(workspaceRoot, { projectName, filePath });
      for (const version of result.versions || []) {
        if (!version.thumbnailPath || !fs.existsSync(version.thumbnailPath)) {
          void ensureTrackedVersionThumbnail({ workspaceRoot, photoId: result.photo.id, versionId: version.id, filePath: version.filePath });
        }
      }
      return result;
    } catch (error) {
      writeLog('error', 'Unable to load media versions', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), versions: [] };
    }
  });

  ipcMain.handle('workspace-progress-folders', async (_event, workspacePath, projectName) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      return await versionService.listProgress(workspaceRoot, projectName);
    } catch (error) {
      return { success: false, error: error.message || String(error), progressFolders: [], legacySelectionRelationRepairs: [] };
    }
  });

  ipcMain.handle('workspace-progress-delete-missing', async (_event, workspacePath, projectName, progressId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      await versionService.syncProject(workspaceRoot, projectName);
      const result = await versionService.deleteMissingProgress(workspaceRoot, { projectName, progressId });
      queueCleanupArtifacts(workspaceRoot, result, '清理已移除失效进度的内部文件');
      return { ...result, cleanupQueued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-media-rating-read', async (_event, filePath) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      const extension = path.extname(sourcePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension) && !RAW_EXTENSIONS.has(extension)) throw new Error('只有图片和 RAW 文件可以标星');
      return { success: true, rating: await readMediaRating(sourcePath) };
    } catch (error) {
      return { success: false, rating: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-media-rating-read-batch', async (_event, requestedEntries = []) => {
    const entries = Array.isArray(requestedEntries) ? requestedEntries.slice(0, 200) : [];
    if (!entries.length) return { success: true, results: [], checked: 0 };
    const results = new Array(entries.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(6, entries.length) }, async () => {
      while (cursor < entries.length) {
        const index = cursor++;
        const requested = entries[index] || {};
        const requestedPath = String(requested.path || '');
        const updatedAt = Number(requested.updatedAt) || 0;
        try {
          const sourcePath = await mediaService.authorizeInput(requestedPath);
          const extension = path.extname(sourcePath).toLowerCase();
          if (!IMAGE_EXTENSIONS.has(extension) && !RAW_EXTENSIONS.has(extension)) throw new Error('只有图片和 RAW 文件可以标星');
          results[index] = { path: requestedPath, updatedAt, success: true, rating: await readMediaRating(sourcePath, updatedAt) };
        } catch (error) {
          results[index] = { path: requestedPath, updatedAt, success: false, rating: 0, error: error.message || String(error) };
        }
      }
    });
    await Promise.all(workers);
    return { success: true, results, checked: results.length };
  });

  ipcMain.handle('workspace-media-rating-write', async (_event, workspacePath, filePath, rating) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      const extension = path.extname(sourcePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension) && !RAW_EXTENSIONS.has(extension)) throw new Error('只有图片和 RAW 文件可以标星');
      const nextRating = normalizedMediaRating(rating);
      suppressWorkspaceWatchPath(sourcePath);
      try {
        await exiftool.write(sourcePath, { 'XMP:Rating': nextRating }, { writeArgs: ['-overwrite_original', '-P'] });
      } finally {
        releaseWorkspaceWatchPath(sourcePath);
      }
      clearMediaRatingCaches(sourcePath);
      try {
        await versionService.refreshMetadataFingerprint(ensureWorkspace(workspacePath), { filePath: sourcePath });
      } catch (error) {
        writeLog('warn', 'Unable to refresh tracked fingerprint after metadata rating write', { filePath: sourcePath, error: error.message || String(error) });
      }
      return { success: true, rating: await readMediaRating(sourcePath) };
    } catch (error) {
      writeLog('warn', 'Unable to write media rating metadata', { filePath, rating, error: error.message || String(error) });
      return { success: false, rating: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-final-version-summary', async (_event, workspacePath, status, projectName) => {
    try {
      const entries = await listRatedProjectMedia(path.resolve(getProjectPath(workspacePath, status, projectName)));
      return { success: true, count: entries.length, availableCount: entries.length, missingCount: 0 };
    } catch (error) {
      return { success: false, count: 0, availableCount: 0, missingCount: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-final-version-browse', async (_event, workspacePath, status, projectName) => {
    try {
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const entries = await listRatedProjectMedia(projectPath);
      return { success: true, count: entries.length, availableCount: entries.length, missingCount: 0, entries };
    } catch (error) {
      return { success: false, count: 0, availableCount: 0, missingCount: 0, entries: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-final-version-export', async (_event, workspacePath, status, projectName, request = {}) => {
    let folderPath = '';
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const ratedEntries = await listRatedProjectMedia(projectPath);
      if (!ratedEntries.length) throw new Error('当前项目还没有标星的图片');

      const progressResult = await versionService.listProgress(workspaceRoot, projectName);
      const imageRoots = (progressResult.progressFolders || [])
        .filter(progress => progress.mediaKind === 'image' && /^\d+$/.test(progress.versionKey))
        .sort((left, right) => Number(left.versionKey) - Number(right.versionKey));
      const versionKey = String((imageRoots.at(-1) ? Number(imageRoots.at(-1).versionKey) : 0) + 1);
      const parentProgressId = String(request.parentProgressId || '');
      const explicitParent = (progressResult.progressFolders || []).find(progress => progress.id === parentProgressId);
      if (!explicitParent || explicitParent.mediaKind !== 'image' || explicitParent.folderMissing
        || explicitParent.nodeRole === 'selection' || explicitParent.relationKind === 'auxiliary') {
        throw new Error('export_parent_required: 请选择明确的图片主分支父节点');
      }
      const displayName = `图片后期_${versionKey}_喜爱`;
      folderPath = path.resolve(projectPath, displayName);
      if (!folderPath.startsWith(projectPath + path.sep)) throw new Error('喜爱图片进度文件夹路径无效');
      if (fs.existsSync(folderPath)) throw new Error(`文件夹“${displayName}”已经存在`);

      await fs.promises.mkdir(folderPath);
      const reserved = new Set();
      const copiedFiles = [];
      for (const entry of ratedEntries) {
        const sourcePath = await mediaService.authorizeInput(entry.path);
        const destinationPath = uniqueDestination(folderPath, path.basename(sourcePath), reserved);
        await copyFileAtomic(sourcePath, destinationPath);
        copiedFiles.push(destinationPath);
      }
      const registered = await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: 'image',
        versionKey,
        parentProgressId: explicitParent.id,
        displayName,
        folderPath,
        trackingEnabled: false,
      });
      writeLog('info', 'Final versions exported to progress folder', { projectName, displayName, count: copiedFiles.length });
      return {
        success: true,
        count: copiedFiles.length,
        displayName,
        versionKey,
        progressFolder: registered.progressFolder,
        folder: {
          name: displayName,
          path: folderPath,
          relativePath: path.relative(projectPath, folderPath).replace(/\\/g, '/'),
          updatedAt: Date.now(),
        },
      };
    } catch (error) {
      if (folderPath && fs.existsSync(folderPath)) await fs.promises.rm(folderPath, { recursive: true, force: true }).catch(() => undefined);
      writeLog('error', 'Unable to export final versions', { projectName, error: error.message || String(error) });
      return { success: false, count: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-register', async (_event, workspacePath, status, projectName, request = {}) => {
    let movedFrom = '';
    let movedTo = '';
    let moveRollbackError = null;
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      let folderPath = resolveProjectEntry(workspacePath, status, projectName, request.relativePath);
      if (!fs.statSync(folderPath).isDirectory()) throw new Error('版本进度文件夹不存在');
      if (request.moveToRoot && path.dirname(folderPath).toLocaleLowerCase() !== projectPath.toLocaleLowerCase()) {
        if (fs.lstatSync(folderPath).isSymbolicLink()) throw new Error('快捷方式或链接目录不能移动为版本进度');
        const targetPath = path.join(projectPath, path.basename(folderPath));
        if (fs.existsSync(targetPath)) throw new Error(`项目根目录已存在同名文件夹“${path.basename(folderPath)}”`);
        movedFrom = folderPath;
        movedTo = targetPath;
        suppressWorkspaceWatchPath(folderPath);
        suppressWorkspaceWatchPath(targetPath);
        await fs.promises.rename(folderPath, targetPath);
        folderPath = targetPath;
      }
      const registered = await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: request.mediaKind,
        versionKey: request.versionKey,
        parentProgressId: request.parentProgressId,
        displayName: request.displayName || path.basename(folderPath),
        folderPath,
        trackingEnabled: Boolean(request.trackingEnabled),
        trackingState: request.trackingState,
        nodeRole: request.nodeRole,
        relationKind: request.relationKind,
        renameFromParent: Boolean(request.renameFromParent),
        copyMissingFromParent: Boolean(request.copyMissingFromParent),
        progressId: request.progressId,
      });
      if (!registered?.success || !registered.progressFolder) throw new Error(registered?.error || '无法登记版本进度');
      return {
        ...registered,
        relativePath: path.relative(projectPath, folderPath).replace(/\\/g, '/'),
      };
    } catch (error) {
      if (movedFrom && movedTo && fs.existsSync(movedTo) && !fs.existsSync(movedFrom)) {
        try {
          await fs.promises.rename(movedTo, movedFrom);
        } catch (rollbackError) {
          moveRollbackError = rollbackError;
          writeLog('error', 'Unable to roll back progress root move after registration failure', {
            source: movedFrom, destination: movedTo, error: rollbackError.message || String(rollbackError),
          });
        }
      }
      const message = error.message || String(error);
      return { success: false, error: moveRollbackError ? `${message}；文件夹回滚失败：${moveRollbackError.message || String(moveRollbackError)}` : message };
    } finally {
      if (movedFrom) releaseWorkspaceWatchPath(movedFrom);
      if (movedTo) releaseWorkspaceWatchPath(movedTo);
    }
  });

  ipcMain.handle('workspace-progress-register-with-graph', async (_event, workspacePath, status, request = {}) => {
    let createdDirectory = '';
    let movedFrom = '';
    let movedTo = '';
    let moveRollbackError = null;
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      if (!request || Object.keys(request).some(key => !['projectName', 'progress', 'workflowInputProgressIds'].includes(key))) {
        throw new Error('progress_graph_payload_invalid: 请求字段无效');
      }
      const projectName = String(request.projectName || '').trim();
      const progress = request.progress && typeof request.progress === 'object' ? request.progress : {};
      const allowedProgressFields = ['progressId', 'relativePath', 'mediaKind', 'versionKey', 'parentProgressId', 'displayName', 'relationKind', 'trackingEnabled', 'trackingState', 'renameFromParent', 'copyMissingFromParent', 'moveToRoot'];
      if (Object.keys(progress).some(key => !allowedProgressFields.includes(key))) {
        throw new Error('progress_graph_payload_invalid: renderer 不能提交节点角色、绝对路径或图边类型');
      }
      const workflowInputProgressIds = Array.isArray(request.workflowInputProgressIds)
        ? request.workflowInputProgressIds.map(value => String(value || '').trim()) : null;
      if (!projectName || !workflowInputProgressIds || workflowInputProgressIds.some(value => !value)
        || new Set(workflowInputProgressIds).size !== workflowInputProgressIds.length) {
        throw new Error('progress_graph_payload_invalid: 项目或工作流输入无效');
      }
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      let databaseProgress = {};
      const progressId = String(progress.progressId || '').trim();
      const updatesProgress = Object.keys(progress).some(key => key !== 'progressId');
      let existing = null;
      if (progressId) {
        const listed = await versionService.listProgress(workspaceRoot, projectName, true);
        existing = (listed.progressFolders || []).find(item => item.id === progressId);
        if (!existing || existing.folderMissing) throw new Error('progress_graph_target_invalid: 目标节点不存在');
      }
      if (progressId && !updatesProgress) {
        databaseProgress = { progressId: existing.id };
      } else {
        const displayName = String(progress.displayName || '').trim();
        const mediaKind = String(progress.mediaKind || '');
        const versionKey = String(progress.versionKey || '').trim();
        if (!validProgressFolderName(displayName) || !['image', 'video'].includes(mediaKind) || !versionKey) {
          throw new Error('progress_graph_payload_invalid: 新进度字段无效');
        }
        let folderPath = progress.relativePath !== undefined
          ? resolveProjectEntry(workspacePath, status, projectName, String(progress.relativePath || ''))
          : existing?.folderPath ? path.resolve(existing.folderPath) : path.resolve(projectPath, displayName);
        if (!isInside(projectPath, folderPath)) throw new Error('progress_graph_folder_invalid: 进度目录必须位于当前项目内');
        if (!fs.existsSync(folderPath)) {
          if (progress.relativePath !== undefined || existing) throw new Error('progress_graph_folder_invalid: 要登记的文件夹不存在');
          await fs.promises.mkdir(folderPath);
          createdDirectory = folderPath;
        } else if (!fs.statSync(folderPath).isDirectory()) {
          throw new Error(`同名路径不是文件夹：${displayName}`);
        }
        if (progress.moveToRoot && path.dirname(folderPath).toLocaleLowerCase() !== projectPath.toLocaleLowerCase()) {
          if (fs.lstatSync(folderPath).isSymbolicLink()) throw new Error('快捷方式或链接目录不能移动为版本进度');
          const targetPath = path.join(projectPath, path.basename(folderPath));
          if (fs.existsSync(targetPath)) throw new Error(`项目根目录已存在同名文件夹“${path.basename(folderPath)}”`);
          movedFrom = folderPath;
          movedTo = targetPath;
          suppressWorkspaceWatchPath(folderPath);
          suppressWorkspaceWatchPath(targetPath);
          await fs.promises.rename(folderPath, targetPath);
          folderPath = targetPath;
        }
        databaseProgress = {
          progressId: progressId || undefined,
          mediaKind, versionKey, displayName, folderPath,
          parentProgressId: progress.parentProgressId ? String(progress.parentProgressId) : undefined,
          relationKind: progress.relationKind || undefined,
          trackingEnabled: Boolean(progress.trackingEnabled),
          trackingState: progress.trackingState || undefined,
          renameFromParent: Boolean(progress.renameFromParent),
          copyMissingFromParent: Boolean(progress.copyMissingFromParent),
        };
      }
      const registered = await versionService.registerProgressWithGraph(workspaceRoot, {
        projectName, progress: databaseProgress, workflowInputProgressIds,
      });
      if (!registered?.success || !registered.progressFolder) throw new Error(registered?.error || '进度和工作流关系提交失败');
      const relativePath = path.relative(projectPath, registered.progressFolder.folderPath).replace(/\\/g, '/');
      return {
        ...registered,
        relativePath,
        folder: {
          name: path.basename(registered.progressFolder.folderPath),
          path: registered.progressFolder.folderPath,
          relativePath,
          updatedAt: Date.now(),
        },
      };
    } catch (error) {
      if (movedFrom && movedTo && fs.existsSync(movedTo) && !fs.existsSync(movedFrom)) {
        try {
          await fs.promises.rename(movedTo, movedFrom);
        } catch (rollbackError) {
          moveRollbackError = rollbackError;
          writeLog('error', 'Unable to roll back progress root move after graph registration failure', {
            source: movedFrom, destination: movedTo, error: rollbackError.message || String(rollbackError),
          });
        }
      }
      if (createdDirectory && fs.existsSync(createdDirectory)) {
        try {
          if ((await fs.promises.readdir(createdDirectory)).length === 0) await fs.promises.rmdir(createdDirectory);
        } catch (cleanupError) {
          writeLog('warn', 'Unable to remove empty progress folder after graph rollback', { path: createdDirectory, error: cleanupError.message || String(cleanupError) });
        }
      }
      const message = error.message || String(error);
      return { success: false, error: moveRollbackError ? `${message}；文件夹回滚失败：${moveRollbackError.message || String(moveRollbackError)}` : message };
    } finally {
      if (movedFrom) releaseWorkspaceWatchPath(movedFrom);
      if (movedTo) releaseWorkspaceWatchPath(movedTo);
    }
  });

  ipcMain.handle('workspace-progress-adopt-media', async (_event, workspacePath, status, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const allowed = ['projectName', 'relativePath', 'mode', 'mediaKind', 'sourceProgressId'];
      if (!request || Object.keys(request).some(key => !allowed.includes(key))) {
        throw new Error('media_adopt_payload_invalid: 请求字段无效');
      }
      const projectName = String(request.projectName || '').trim();
      const relativePath = String(request.relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const mode = String(request.mode || '');
      const mediaKind = String(request.mediaKind || '');
      const sourceProgressId = String(request.sourceProgressId || '').trim();
      if (!projectName || !relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..')
        || !['original', 'companion', 'preview'].includes(mode) || !['image', 'video'].includes(mediaKind)) {
        throw new Error('media_adopt_payload_invalid: 项目内相对路径和素材类型必填');
      }
      const folderPath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      if (!fs.statSync(folderPath).isDirectory()) throw new Error('media_adopt_folder_invalid: 目标必须是文件夹');
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      if (sourceProgressId && !(listed.progressFolders || []).some(folder => folder.id === sourceProgressId && !folder.folderMissing)) {
        throw new Error('media_adopt_source_invalid: 来源不属于当前项目');
      }
      return await versionService.adoptMediaFolder(workspaceRoot, {
        projectName, folderPath, mode, mediaKind,
        ...(sourceProgressId ? { sourceProgressId } : {}),
      });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-relation-update', async (_event, workspacePath, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const projectNodeIds = new Set((listed.progressFolders || []).map(folder => folder.id));
      const childProgressId = String(request.childProgressId || '');
      const parentProgressId = request.parentProgressId == null ? null : String(request.parentProgressId);
      if (!projectNodeIds.has(childProgressId) || parentProgressId && !projectNodeIds.has(parentProgressId)) {
        throw new Error('relation_project_mismatch: 父子节点不属于当前项目');
      }
      return await versionService.updateProgressRelation(workspaceRoot, {
        childProgressId,
        parentProgressId,
        ...(request.expectedUpdatedAt == null ? {} : { expectedUpdatedAt: Number(request.expectedUpdatedAt) }),
      });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  const mutateVersionGraphEdge = async (workspacePath, request, mutation) => {
    const workspaceRoot = ensureWorkspace(workspacePath);
    if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
    const projectId = String(request?.projectId || '');
    const sourceProgressId = String(request?.sourceProgressId || '');
    const targetProgressId = String(request?.targetProgressId || '');
    const edgeKind = String(request?.edgeKind || '');
    if (!projectId || !sourceProgressId || !targetProgressId
      || !['media_companion', 'derived_preview', 'workflow_input'].includes(edgeKind)) {
      throw new Error('version_graph_edge_payload_invalid: 项目、节点或关系类型无效');
    }
    return mutation(workspaceRoot, { projectId, sourceProgressId, targetProgressId, edgeKind });
  };

  ipcMain.handle('workspace-version-graph-edge-create', async (_event, workspacePath, request = {}) => {
    try {
      return await mutateVersionGraphEdge(workspacePath, request, (root, payload) => versionService.createVersionGraphEdge(root, payload));
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-graph-edge-delete', async (_event, workspacePath, request = {}) => {
    try {
      return await mutateVersionGraphEdge(workspacePath, request, (root, payload) => versionService.deleteVersionGraphEdge(root, payload));
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-graph-edge-replace-source', async (_event, workspacePath, request = {}) => {
    try {
      const newSourceProgressId = String(request?.newSourceProgressId || '');
      if (!newSourceProgressId) throw new Error('version_graph_edge_payload_invalid: 新来源节点无效');
      return await mutateVersionGraphEdge(workspacePath, request, (root, payload) => versionService.replaceVersionGraphEdgeSource(root, {
        ...payload,
        newSourceProgressId,
      }));
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  const normalizeVersionTreeScope = value => {
    const raw = String(value || '').trim().replace(/\\/g, '/');
    if (raw.length > 1024 || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new Error('version_tree_scope_invalid: scopeKey 必须是项目内相对路径');
    const parts = raw.split('/').filter(part => part && part !== '.');
    if (parts.includes('..')) throw new Error('version_tree_scope_invalid: scopeKey 不能包含 ..');
    return parts.join('/');
  };

  const versionTreeEntryNodeBelongsToScope = (nodeKey, scopeKey) => {
    if (!nodeKey.startsWith('entry:')) return false;
    const relativePath = nodeKey.slice('entry:'.length);
    if (!relativePath || relativePath.length > 1024 || relativePath.includes('\\')) return false;
    let normalizedPath;
    try { normalizedPath = normalizeVersionTreeScope(relativePath); } catch { return false; }
    if (normalizedPath !== relativePath) return false;
    const parentScope = normalizedPath.split('/').slice(0, -1).join('/');
    return parentScope.toLocaleLowerCase('zh-CN') === scopeKey.toLocaleLowerCase('zh-CN');
  };

  ipcMain.handle('workspace-version-tree-layout-get', async (_event, workspacePath, projectName, scopeKey = '') => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      return await versionService.getVersionTreeLayout(workspaceRoot, { projectName, scopeKey: normalizeVersionTreeScope(scopeKey) });
    } catch (error) {
      return { success: false, error: error.message || String(error), revision: 0, positions: [] };
    }
  });

  ipcMain.handle('workspace-version-tree-layout-save', async (_event, workspacePath, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const scopeKey = normalizeVersionTreeScope(request.scopeKey);
      const mode = request.mode === 'patch' || request.mode === 'replace' ? request.mode : '';
      const expectedRevision = request.expectedRevision;
      const positions = Array.isArray(request.positions) ? request.positions : [];
      if (!mode || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || positions.length > 1000) throw new Error('version_tree_layout_payload_invalid: 布局请求无效');
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const allowedNodeKeys = new Set((listed.progressFolders || []).map(folder => `progress:${folder.id}`));
      const seen = new Set();
      const normalizedPositions = positions.map(position => {
        const nodeKey = String(position?.nodeKey || '');
        const x = position?.x;
        const y = position?.y;
        if ((!allowedNodeKeys.has(nodeKey) && !versionTreeEntryNodeBelongsToScope(nodeKey, scopeKey)) || seen.has(nodeKey)) throw new Error('version_tree_layout_node_invalid: 节点不属于当前项目');
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) throw new Error('version_tree_layout_coordinate_invalid: 坐标无效');
        seen.add(nodeKey);
        return { nodeKey, x, y };
      });
      return await versionService.saveVersionTreeLayout(workspaceRoot, { projectName, scopeKey, expectedRevision, mode, positions: normalizedPositions });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-legacy-selection-relation-repair', async (_event, workspacePath, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const progressId = String(request.progressId || '');
      const sourceProgressId = String(request.sourceProgressId || '');
      const projectNodeIds = new Set((listed.progressFolders || []).map(folder => folder.id));
      const repairIds = new Set((listed.legacySelectionRelationRepairs || []).map(repair => repair.progressId));
      if (!repairIds.has(progressId) || !projectNodeIds.has(progressId) || !projectNodeIds.has(sourceProgressId)) {
        throw new Error('legacy_selection_repair_project_mismatch: 修复节点不属于当前项目');
      }
      return await versionService.repairLegacySelectionRelation(workspaceRoot, { progressId, sourceProgressId });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-update', async (_event, workspacePath, status, projectName, request = {}) => {
    const completedMoves = [];
    const stagedMoves = [];
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const listed = await versionService.listProgress(workspaceRoot, projectName);
      const progressFolders = Array.isArray(listed.progressFolders) ? listed.progressFolders : [];
      const current = progressFolders.find(progress => progress.id === request.progressId);
      if (!current || current.nodeRole !== 'progress') throw new Error('要修改的进度不存在或角色不允许修改');
      if (request.mediaKind && request.mediaKind !== current.mediaKind) throw new Error('修改进度时不能改变图片或视频类型');

      const versionKey = String(request.versionKey || '').trim();
      const displayName = String(request.displayName || '').trim();
      if (!/^\d+(?:_\d+)*$/.test(versionKey)) throw new Error('无效的版本编号');
      if (!validProgressFolderName(displayName)) throw new Error('无效的进度名称');

      const childrenByParent = new Map();
      for (const progress of progressFolders) {
        if (!progress.parentProgressId || progress.relationKind !== 'main' || progress.nodeRole !== 'progress') continue;
        const children = childrenByParent.get(progress.parentProgressId) || [];
        children.push(progress);
        childrenByParent.set(progress.parentProgressId, children);
      }
      const subtree = [];
      const visit = progress => {
        subtree.push(progress);
        for (const child of childrenByParent.get(progress.id) || []) visit(child);
      };
      visit(current);
      const subtreeIds = new Set(subtree.map(progress => progress.id));
      const requestedParentId = request.parentProgressId || null;
      if (requestedParentId && subtreeIds.has(requestedParentId)) throw new Error('进度不能移动到自己的后代版本下');
      const requestedParent = requestedParentId ? progressFolders.find(progress => progress.id === requestedParentId) : null;
      if (requestedParentId && (!requestedParent || requestedParent.mediaKind !== current.mediaKind
        || requestedParent.nodeRole === 'selection' || requestedParent.relationKind === 'auxiliary')) throw new Error('父版本进度不存在');
      const replacementTarget = progressFolders.find(progress => !subtreeIds.has(progress.id)
        && progress.folderMissing
        && progress.mediaKind === current.mediaKind
        && progress.versionKey === versionKey);

      const updates = subtree.map(progress => {
        const nextVersionKey = progress.id === current.id ? versionKey : progress.versionKey;
        const nextDisplayName = progress.id === current.id ? displayName : progress.displayName;
        if (!validProgressFolderName(nextDisplayName)) throw new Error(`无效的进度名称：${nextDisplayName}`);
        return {
          id: progress.id,
          mediaKind: progress.mediaKind,
          versionKey: nextVersionKey,
          parentProgressId: progress.id === current.id ? requestedParentId : progress.parentProgressId || null,
          displayName: nextDisplayName,
          previousFolderPath: path.resolve(progress.folderPath),
          folderPath: request.preserveFolderPath ? path.resolve(progress.folderPath) : path.resolve(projectPath, nextDisplayName),
          trackingEnabled: progress.id === current.id
            ? request.trackingEnabled === undefined ? Boolean(current.trackingEnabled) : Boolean(request.trackingEnabled)
            : Boolean(progress.trackingEnabled),
          trackingState: progress.id === current.id
            ? request.trackingState || current.trackingState
            : progress.trackingState,
        };
      });

      const versionKeys = new Set();
      const displayNames = new Set();
      const destinationPaths = new Set();
      for (const update of updates) {
        const versionIdentity = `${update.mediaKind}|${update.versionKey.toLocaleLowerCase()}`;
        const nameIdentity = update.displayName.toLocaleLowerCase('zh-CN');
        const pathIdentity = update.folderPath.toLocaleLowerCase();
        if (versionKeys.has(versionIdentity)) throw new Error(`映射后版本 _${update.versionKey} 重复`);
        if (displayNames.has(nameIdentity) || destinationPaths.has(pathIdentity)) throw new Error(`映射后进度名称重复：${update.displayName}`);
        versionKeys.add(versionIdentity);
        displayNames.add(nameIdentity);
        destinationPaths.add(pathIdentity);
      }
      for (const progress of progressFolders) {
        if (subtreeIds.has(progress.id) || progress.id === replacementTarget?.id) continue;
        if (versionKeys.has(`${progress.mediaKind}|${progress.versionKey.toLocaleLowerCase()}`)) throw new Error(`版本 _${progress.versionKey} 已存在`);
        if (displayNames.has(progress.displayName.toLocaleLowerCase('zh-CN'))) throw new Error(`进度名称已存在：${progress.displayName}`);
      }

      const sourcePaths = new Set(updates.map(update => update.previousFolderPath.toLocaleLowerCase()));
      for (const update of updates) {
        if (!fs.existsSync(update.previousFolderPath) || !fs.statSync(update.previousFolderPath).isDirectory()) {
          throw new Error(`进度文件夹不存在：${path.basename(update.previousFolderPath)}`);
        }
        if (update.folderPath.toLocaleLowerCase() !== update.previousFolderPath.toLocaleLowerCase()
          && fs.existsSync(update.folderPath) && !sourcePaths.has(update.folderPath.toLocaleLowerCase())) {
          throw new Error(`文件夹“${update.displayName}”已经存在`);
        }
      }

      const moves = updates.filter(update => update.folderPath !== update.previousFolderPath);
      for (const move of moves) {
        const temporaryPath = path.join(projectPath, `.photoflow-progress-${crypto.randomUUID()}`);
        await fs.promises.rename(move.previousFolderPath, temporaryPath);
        stagedMoves.push({ ...move, temporaryPath });
      }
      for (const move of stagedMoves) {
        await fs.promises.rename(move.temporaryPath, move.folderPath);
        completedMoves.push(move);
      }

      const databaseUpdates = updates.map(update => ({
        id: replacementTarget && update.id === current.id ? replacementTarget.id : update.id,
        mediaKind: update.mediaKind,
        versionKey: update.versionKey,
        parentProgressId: replacementTarget && update.parentProgressId === current.id ? replacementTarget.id : update.parentProgressId,
        displayName: update.displayName,
        folderPath: update.folderPath,
        trackingEnabled: update.trackingEnabled,
        trackingState: update.trackingState,
      }));
      const updated = await versionService.updateProgressTree(workspaceRoot, {
        projectName,
        primaryProgressId: replacementTarget?.id || current.id,
        replacementProgressId: replacementTarget ? current.id : undefined,
        updates: databaseUpdates,
      });
      await versionService.syncProject(workspaceRoot, projectName).catch(error => {
        writeLog('warn', 'Progress tree updated but media rescan failed', { projectName, error: error.message || String(error) });
      });
      const updatedFolderPath = updates.find(update => update.id === current.id)?.folderPath || current.folderPath;
      return {
        ...updated,
        folder: {
          name: path.basename(updatedFolderPath),
          path: updatedFolderPath,
          relativePath: path.relative(projectPath, updatedFolderPath).replace(/\\/g, '/'),
          updatedAt: Date.now(),
        },
      };
    } catch (error) {
      for (const move of [...completedMoves].reverse()) {
        try {
          if (fs.existsSync(move.folderPath) && !fs.existsSync(move.previousFolderPath)) await fs.promises.rename(move.folderPath, move.previousFolderPath);
        } catch (rollbackError) {
          writeLog('error', 'Unable to roll back progress folder rename', { path: move.folderPath, error: rollbackError.message || String(rollbackError) });
        }
      }
      for (const move of [...stagedMoves].reverse()) {
        try {
          if (fs.existsSync(move.temporaryPath) && !fs.existsSync(move.previousFolderPath)) await fs.promises.rename(move.temporaryPath, move.previousFolderPath);
        } catch (rollbackError) {
          writeLog('error', 'Unable to restore staged progress folder', { path: move.temporaryPath, error: rollbackError.message || String(rollbackError) });
        }
      }
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-version-register-baseline', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const folderPath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      if (!fs.statSync(folderPath).isDirectory()) throw new Error('版本进度文件夹不存在');
      return await versionService.registerBatchBaseline(workspaceRoot, { projectName, folderPath });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  const trackingPreviewItems = (prepared, preview = {}) => {
    const pendingSources = new Set((prepared.sourceNames || []).map(String));
    const items = [];
    const append = item => {
      const sourceName = item.sourceName ? String(item.sourceName) : undefined;
      if (sourceName && !pendingSources.has(sourceName)) return;
      if (sourceName) pendingSources.delete(sourceName);
      items.push(item);
    };
    for (const match of Array.isArray(preview.matches) ? preview.matches : []) append({
      kind: 'recognized', status: 'recognized', sourceName: match.source,
      referenceName: match.reference, targetName: match.target || match.source,
      distance: Number(match.distance) || 0, confidence: String(match.confidence || ''),
    });
    for (const suggestion of Array.isArray(preview.suggestions) ? preview.suggestions : []) append({
      kind: 'new', status: 'pending_confirmation', sourceName: suggestion.source,
      referenceName: suggestion.reference, targetName: suggestion.target || suggestion.source,
      distance: Number(suggestion.distance) || 0, confidence: String(suggestion.confidence || ''),
    });
    for (const sourceName of Array.isArray(preview.unmatched) ? preview.unmatched : []) append({
      kind: 'new', status: 'pending_confirmation', sourceName: String(sourceName), targetName: String(sourceName),
      confidence: '未匹配',
    });
    for (const sourceName of pendingSources) items.push({
      kind: 'new', status: 'pending_confirmation', sourceName, targetName: sourceName, confidence: '新增或变化',
    });
    for (const referenceName of prepared.copyCandidateNames || []) items.push({
      kind: 'copy_missing', status: 'pending_confirmation', referenceName: String(referenceName),
      targetName: String(referenceName), confidence: '父版本新增',
    });
    for (const sourceName of prepared.removedNames || []) items.push({
      kind: 'missing', status: 'missing_reference', sourceName: String(sourceName), confidence: '当前版本已缺失',
    });
    return items;
  };

  const executeTrackingCompare = async (workspaceRoot, prepared, task) => {
    task?.throwIfCancelled?.();
    const totalCount = (prepared.sourceNames?.length || 0) + (prepared.copyCandidateNames?.length || 0) + (prepared.removedNames?.length || 0);
    task?.report(5, '正在准备版本媒体', {
      sessionId: prepared.sessionId, progressId: prepared.progressId,
      processedCount: 0, totalCount,
    });
    task?.report(10, '正在读取版本媒体');
    let preview = { matches: [], suggestions: [], unmatched: [], unmatchedReference: [] };
    if (prepared.sourceNames?.length) {
      const events = await runPythonEventAction('rename.py', [
        '--folder_a', prepared.parentFolderPath,
        '--folder_b', prepared.progressFolderPath,
        '--preview', '--source_files', JSON.stringify(prepared.sourceNames),
      ], 60 * 60 * 1000, task?.signal);
      task?.throwIfCancelled();
      const previewEvent = events.find(event => event.type === 'preview');
      if (!previewEvent) throw new Error('版本对比没有返回匹配结果');
      preview = previewEvent.data || preview;
    }
    task?.throwIfCancelled?.();
    task?.report(80, '正在保存待确认结果');
    const stored = await versionService.storeTrackingPreview(workspaceRoot, {
      sessionId: prepared.sessionId,
      items: trackingPreviewItems(prepared, preview),
    });
    task?.report(95, '正在保存待确认结果', {
      sessionId: prepared.sessionId, progressId: prepared.progressId,
      processedCount: totalCount, totalCount,
    });
    task?.report(100, '等待确认跟踪图片');
    return stored;
  };

  ipcMain.handle('workspace-progress-tracking-start', async (_event, workspacePath, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const progressId = String(request.progressId || '');
      const mode = request.mode === 'refresh' ? 'refresh' : 'compare';
      if (!/^[0-9a-z-]{8,128}$/i.test(progressId)) throw new Error('progressId 无效');
      const taskId = crypto.randomUUID();
      const created = await versionService.createTrackingSession(workspaceRoot, { projectName, progressId, mode });
      const handle = backgroundTasks?.create?.({
        id: taskId,
        type: 'version-tracking',
        title: mode === 'refresh' ? '刷新版本跟踪' : '比较版本跟踪',
        cancellable: true,
        resources: [created.parentFolderPath, created.progressFolderPath],
        concurrencyGroup: 'disk-io',
        concurrencyLimit: 2,
        metadata: {
          sessionId: created.sessionId, progressId: created.progressId,
          processedCount: 0, totalCount: 0,
        },
      }) || {
        context: undefined,
        waitForStart: async () => undefined,
        complete: () => undefined,
        fail: () => undefined,
        cancelled: () => undefined,
      };
      setTimeout(() => void (async () => {
        try {
          await handle?.waitForStart?.();
          const prepared = await versionService.prepareTracking(workspaceRoot, {
            projectName, progressId, mode, sessionId: created.sessionId,
          });
          await executeTrackingCompare(workspaceRoot, prepared, handle.context);
          handle.complete('等待确认跟踪图片');
        } catch (error) {
          if (handle?.context?.signal?.aborted || error?.code === 'TASK_CANCELLED') {
            await versionService.releaseTrackingSession(workspaceRoot, created.sessionId).catch(() => undefined);
            handle?.cancelled?.();
          } else {
            await versionService.failTrackingCommit(workspaceRoot, { sessionId: created.sessionId, error: error?.message || String(error) }).catch(() => undefined);
            handle?.fail?.(error);
          }
        }
      })(), 0);
      return { success: true, taskId, sessionId: created.sessionId };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-session', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sessionId = String(request.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('sessionId 无效');
      return await versionService.getTrackingSession(workspaceRoot, {
        sessionId, cursor: Number(request.cursor) || 0, limit: Number(request.limit) || 100,
      });
    } catch (error) {
      return { success: false, items: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-session-release', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sessionId = String(request.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('sessionId 无效');
      return await versionService.releaseTrackingSession(workspaceRoot, sessionId);
    } catch (error) {
      return { success: false, released: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-decide', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      return await versionService.decideTrackingItem(workspaceRoot, {
        sessionId: String(request.sessionId || ''), itemId: String(request.itemId || ''),
        status: request.status === 'accepted' ? 'accepted' : request.status === 'rejected' ? 'rejected' : '',
        ...(request.referenceName ? { referenceName: String(request.referenceName) } : {}),
      });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-commit', async (_event, workspacePath, request = {}) => {
    const copiedPaths = [];
    let workspaceRoot = '';
    const sessionId = String(request.sessionId || '');
    try {
      workspaceRoot = ensureWorkspace(workspacePath);
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('sessionId 无效');
      const plan = await versionService.getTrackingCommitPlan(workspaceRoot, sessionId);
      if (plan.alreadyCommitted) return await versionService.getTrackingSession(workspaceRoot, { sessionId, cursor: 0, limit: 200 });
      if (plan.repairBatchId) {
        const repaired = await versionService.retryBatchOperations(workspaceRoot, plan.repairBatchId);
        if (repaired.repairRequired) throw Object.assign(new Error('文件操作仍需修复后重试'), { batchId: plan.repairBatchId });
        return await versionService.completeTrackingCommit(workspaceRoot, { sessionId, batchId: plan.repairBatchId });
      }
      if (plan.copyMissingFromParent) {
        for (const reference of plan.copyReferences || []) {
          if (!reference || path.basename(reference) !== reference) throw new Error('补齐候选文件名无效');
          const sourcePath = path.join(plan.parentFolderPath, reference);
          const destinationPath = path.join(plan.progressFolderPath, reference);
          if (path.dirname(sourcePath) !== plan.parentFolderPath || path.dirname(destinationPath) !== plan.progressFolderPath) throw new Error('补齐候选越出版本目录');
          if (fs.existsSync(destinationPath)) throw new Error(`补齐目标已存在：${reference}`);
          await copyFileAtomic(sourcePath, destinationPath);
          copiedPaths.push(destinationPath);
        }
      }
      const copiedNames = copiedPaths.map(filePath => path.basename(filePath));
      if (!(plan.matches || []).length && !(plan.incrementalSources || []).length && !copiedNames.length) {
        return await versionService.completeTrackingCommit(workspaceRoot, { sessionId });
      }
      const result = await versionService.commitBatchCompare(workspaceRoot, {
        projectName: plan.projectName,
        folderA: plan.parentFolderPath,
        folderB: plan.progressFolderPath,
        importKey: `tracking:${sessionId}`,
        displayName: plan.displayName,
        renameSources: plan.renameFromParent,
        reconcileExisting: plan.mode === 'refresh',
        incrementalSources: [...new Set([...(plan.incrementalSources || []), ...copiedNames])],
        matches: [...(plan.matches || []), ...copiedNames.map(name => ({ reference: name, source: name, target: name, distance: 0, confidence: '复制补齐' }))],
      });
      if (result.repairRequired) {
        await versionService.failTrackingCommit(workspaceRoot, {
          sessionId, batchId: result.batch?.id, error: '文件操作需要修复后重试',
        });
        return { ...result, success: false, sessionId, retryable: true, items: [] };
      }
      const completed = await versionService.completeTrackingCommit(workspaceRoot, { sessionId, batchId: result.batch?.id });
      return { ...completed, batch: result.batch, renamedCount: result.renamedCount || 0 };
    } catch (error) {
      await Promise.all(copiedPaths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => undefined)));
      if (workspaceRoot && sessionId) await versionService.failTrackingCommit(workspaceRoot, {
        sessionId, batchId: error.batchId, error: error.message || String(error),
      }).catch(() => undefined);
      return { success: false, sessionId, retryable: true, items: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-main-branch-media', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      return await versionService.getMainBranchMedia(workspaceRoot, {
        progressId: String(request.progressId || ''),
        ...(request.photoId ? { photoId: String(request.photoId) } : {}),
      });
    } catch (error) {
      return { success: false, entries: [], branchProgressIds: [], error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-version-compare-preview', async (_event, workspacePath, status, projectName, referenceRelativePath, sourceRelativePath, sourceNames) => {
    try {
      const folderA = resolveProjectEntry(workspacePath, status, projectName, referenceRelativePath);
      const folderB = resolveProjectEntry(workspacePath, status, projectName, sourceRelativePath);
      if (!fs.statSync(folderA).isDirectory() || !fs.statSync(folderB).isDirectory()) throw new Error('版本对比必须选择两个文件夹');
      if (folderA.toLocaleLowerCase() === folderB.toLocaleLowerCase()) throw new Error('上一版本和新版本不能是同一个文件夹');
      const selectedSourceNames = Array.isArray(sourceNames) ? [...new Set(sourceNames.map(value => String(value || '')).filter(value => value && path.basename(value) === value))] : [];
      const events = await runPythonEventAction('rename.py', ['--folder_a', folderA, '--folder_b', folderB, '--preview', ...(selectedSourceNames.length ? ['--source_files', JSON.stringify(selectedSourceNames)] : [])], 60 * 60 * 1000);
      const preview = events.find(event => event.type === 'preview');
      if (!preview) throw new Error('版本对比没有返回匹配结果');
      return {
        success: true,
        matches: Array.isArray(preview.data?.matches) ? preview.data.matches : [],
        suggestions: Array.isArray(preview.data?.suggestions) ? preview.data.suggestions : [],
        unmatched: Array.isArray(preview.data?.unmatched) ? preview.data.unmatched : [],
        unmatchedReference: Array.isArray(preview.data?.unmatchedReference) ? preview.data.unmatchedReference : [],
      };
    } catch (error) {
      writeLog('error', 'Unable to compare progress version folders', { projectName, referenceRelativePath, sourceRelativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), matches: [], suggestions: [], unmatched: [], unmatchedReference: [] };
    }
  });
  
  ipcMain.handle('workspace-version-batch-commit', async (_event, workspacePath, status, projectName, request = {}) => {
    const copiedMissingPaths = [];
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const resolveBatchFolder = value => {
        const folderPath = path.resolve(String(value || ''));
        const relative = path.relative(projectPath, folderPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('批次必须选择项目内的两个不同子文件夹');
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) throw new Error('批次文件夹不存在');
        return folderPath;
      };
      const folderA = resolveBatchFolder(request.folderA);
      const folderB = resolveBatchFolder(request.folderB);
      if (folderA.toLocaleLowerCase() === folderB.toLocaleLowerCase()) throw new Error('对照批次和新返图不能是同一个文件夹');
      const importKey = await buildVersionBatchImportKey(folderA, folderB);
      const matches = (Array.isArray(request.matches) ? request.matches : []).slice(0, 20000).map(match => {
        const reference = String(match.reference || '');
        const source = String(match.source || '');
        const target = String(match.target || source);
        if (!reference || path.basename(reference) !== reference || !source || path.basename(source) !== source || !target || path.basename(target) !== target) throw new Error('匹配结果包含无效文件名');
        return {
          reference,
          source,
          target,
          distance: Number.isFinite(Number(match.distance)) ? Number(match.distance) : 1000000,
          confidence: String(match.confidence || '').slice(0, 20),
        };
      });
      const copyMissingErrors = [];
      const reservedDestinations = new Set();
      const missingReferences = [...new Set((Array.isArray(request.copyMissingReferences) ? request.copyMissingReferences : []).slice(0, 20000).map(value => String(value || '')))];
      for (const reference of missingReferences) {
        try {
          if (!reference || path.basename(reference) !== reference) throw new Error('无效文件名');
          const sourcePath = path.resolve(folderA, reference);
          if (path.dirname(sourcePath).toLocaleLowerCase() !== folderA.toLocaleLowerCase()) throw new Error('文件不在上一版本文件夹中');
          if (!supportedVersionFileKind(sourcePath)) throw new Error('不是支持的媒体文件');
          const destinationPath = uniqueDestination(folderB, reference, reservedDestinations);
          await copyFileAtomic(sourcePath, destinationPath);
          copiedMissingPaths.push(destinationPath);
          const copiedName = path.basename(destinationPath);
          matches.push({ reference, source: copiedName, target: copiedName, distance: 0, confidence: '复制补齐' });
        } catch (error) {
          copyMissingErrors.push({ name: reference, error: error.message || String(error) });
        }
      }
      const result = await versionService.commitBatchCompare(workspaceRoot, {
        projectName,
        folderA,
        folderB,
        importKey,
        displayName: cleanVersionName(request.displayName || path.basename(folderB)) || path.basename(folderB),
        renameSources: Boolean(request.renameSources),
        reconcileExisting: Boolean(request.reconcileExisting),
        incrementalSources: Array.isArray(request.incrementalSources) ? request.incrementalSources : [],
        matches,
      });
      writeLog('info', 'Version batch committed', { projectName, folderA, folderB, matchCount: matches.length, copiedMissingCount: copiedMissingPaths.length, copyMissingErrorCount: copyMissingErrors.length, batch: result.batch?.sequence });
      return { ...result, copiedMissingCount: copiedMissingPaths.length, copyMissingErrors };
    } catch (error) {
      await Promise.all(copiedMissingPaths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => undefined)));
      writeLog('error', 'Unable to commit version batch', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-batch-operations', async (_event, workspacePath, batchId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const normalizedBatchId = String(batchId || '');
      if (!/^[0-9a-f-]{36}$/i.test(normalizedBatchId)) throw new Error('版本批次标识无效');
      return await versionService.listBatchOperations(workspaceRoot, normalizedBatchId);
    } catch (error) {
      return { success: false, operations: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-batch-retry', async (_event, workspacePath, batchId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const normalizedBatchId = String(batchId || '');
      if (!/^[0-9a-f-]{36}$/i.test(normalizedBatchId)) throw new Error('版本批次标识无效');
      const result = await versionService.retryBatchOperations(workspaceRoot, normalizedBatchId);
      writeLog(result.success ? 'info' : 'warn', 'Version batch repair attempted', {
        batchId: normalizedBatchId,
        remainingErrors: result.renameErrors?.length || 0,
      });
      return result;
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-version-update', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      return await versionService.updateVersion(workspaceRoot, {
        versionId: request.versionId,
        ...(request.versionName !== undefined ? { versionName: cleanVersionName(request.versionName) } : {}),
        ...(request.note !== undefined ? { note: String(request.note).slice(0, 2000) } : {}),
        ...(request.isFinal !== undefined ? { isFinal: Boolean(request.isFinal) } : {}),
        ...(request.makeCurrent ? { makeCurrent: true } : {}),
      });
    } catch (error) {
      return { success: false, error: error.message || String(error), versions: [] };
    }
  });
  
  ipcMain.handle('workspace-version-relocate', async (_event, workspacePath, status, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      let filePath = request.filePath ? path.resolve(request.filePath) : '';
      if (!filePath) {
        const choice = await dialog.showOpenDialog(mainWindow, {
          title: '重新定位版本文件',
          properties: ['openFile'],
          filters: [{ name: '图片和视频', extensions: [...new Set([...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS, ...VIDEO_EXTENSIONS])].map(value => value.slice(1)) }, { name: '所有文件', extensions: ['*'] }]
        });
        if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, versions: [] };
        filePath = path.resolve(choice.filePaths[0]);
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('重新定位的文件不存在');
      const result = await versionService.relocateVersion(workspaceRoot, {
        versionId: request.versionId,
        filePath,
        force: request.force === true,
      });
      if (result.fingerprintMismatch) {
        return {
          success: true,
          versions: [],
          requiresDecision: {
            kind: 'version-fingerprint-mismatch',
            filePath,
            message: '所选文件与原版本的内容指纹不一致',
            detail: '继续会保留原 Photo ID 和 Version ID，但把该版本标记为“内容已变化”。',
          },
        };
      }
      if (!result.success) return result;
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      void ensureTrackedVersionThumbnail({ workspaceRoot, photoId: request.photoId, versionId: request.versionId, filePath });
      writeLog('info', 'Media version relocated', { projectName, photoId: request.photoId, versionId: request.versionId, filePath });
      return result;
    } catch (error) {
      return { success: false, error: error.message || String(error), versions: [] };
    }
  });
  
  ipcMain.handle('workspace-version-delete', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
      const version = bundle.versions?.find(item => item.id === request.versionId);
      if (!version) throw new Error('版本不存在');
      const result = await versionService.deleteVersion(workspaceRoot, request.versionId);
      queueCleanupArtifacts(workspaceRoot, result, '清理已删除版本的内部文件');
      let warning;
      if (request.trashFile && fs.existsSync(version.filePath)) {
        try { await recycleBinService.trash(version.filePath); }
        catch (error) { warning = `版本记录已删除，但文件移入回收站失败：${error.message || String(error)}`; }
      }
      return { ...result, warning };
    } catch (error) {
      return { success: false, error: error.message || String(error), versions: [] };
    }
  });

  ipcMain.handle('workspace-version-delete-scope', async (_event, workspacePath, versionId) => {
    try {
      return await versionService.getVersionDeleteScope(ensureWorkspace(workspacePath), versionId);
    } catch (error) {
      return { success: false, versionNumber: 0, versionCount: 0, missingCount: 0, allMissing: false, childCount: 0, selectedChildCount: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-delete-project-missing', async (_event, workspacePath, versionId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const result = await versionService.deleteProjectMissingVersion(workspaceRoot, versionId);
      queueCleanupArtifacts(workspaceRoot, result, '清理缺失版本的内部文件');
      return { ...result, cleanupQueued: true };
    } catch (error) {
      return { success: false, deletedCount: 0, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-version-compare-record', async (_event, workspacePath, request = {}) => {
    try {
      return await versionService.recordCompare(ensureWorkspace(workspacePath), request);
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  const teamSubjectKey = subject => `${subject.photoId}:${subject.baseVersionId}:${subject.personIndex}`;
  const teamIdentitySimilarityPath = (workspaceRoot, projectName) => path.join(
    getWorkspaceDataRoot(workspaceRoot), 'team-retouch', 'identity-similarities',
    `${crypto.createHash('sha256').update(String(projectName)).digest('hex')}.json`,
  );
  const teamWorkflowSettingsPath = (workspaceRoot, projectName) => path.join(
    getWorkspaceDataRoot(workspaceRoot), 'team-retouch', 'workflow-settings',
    `${crypto.createHash('sha256').update(String(projectName)).digest('hex')}.json`,
  );
  const readTeamIdentitySimilarities = async (workspaceRoot, projectName) => {
    try {
      const payload = JSON.parse(await fs.promises.readFile(teamIdentitySimilarityPath(workspaceRoot, projectName), 'utf8'));
      return Array.isArray(payload.similarities) ? payload.similarities : [];
    } catch {
      return [];
    }
  };
  const writeTeamIdentitySimilarities = async (workspaceRoot, projectName, similarities) => {
    const outputPath = teamIdentitySimilarityPath(workspaceRoot, projectName);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, JSON.stringify({ updatedAt: Date.now(), similarities }), 'utf8');
  };
  const readTeamWorkflowSettings = async (workspaceRoot, projectName) => {
    try {
      const payload = JSON.parse(await fs.promises.readFile(teamWorkflowSettingsPath(workspaceRoot, projectName), 'utf8'));
      const preferredIdentityOrder = Array.isArray(payload.preferredIdentityOrder)
        ? [...new Set(payload.preferredIdentityOrder.map(String).filter(Boolean))]
        : String(payload.preferredIdentityId || '') ? [String(payload.preferredIdentityId)] : [];
      const sameWeekIdentityIds = [...new Set((payload.sameWeekIdentityIds || []).map(String).filter(Boolean))]
        .filter(identityId => preferredIdentityOrder.slice(1).includes(identityId));
      return { preferredIdentityOrder, preferredIdentityId: preferredIdentityOrder[0] || undefined, sameWeekIdentityIds };
    } catch {
      return {};
    }
  };
  const writeTeamWorkflowSettings = async (workspaceRoot, projectName, settings) => {
    const outputPath = teamWorkflowSettingsPath(workspaceRoot, projectName);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const pendingPath = `${outputPath}.${crypto.randomUUID()}.tmp`;
    const preferredIdentityOrder = [...new Set((settings.preferredIdentityOrder || []).map(String).filter(Boolean))];
    const sameWeekIdentityIds = [...new Set((settings.sameWeekIdentityIds || []).map(String).filter(Boolean))]
      .filter(identityId => preferredIdentityOrder.slice(1).includes(identityId));
    await fs.promises.writeFile(pendingPath, JSON.stringify({
      updatedAt: Date.now(),
      preferredIdentityOrder,
      preferredIdentityId: preferredIdentityOrder[0] || undefined,
      sameWeekIdentityIds,
    }, null, 2), 'utf8');
    await fs.promises.rm(outputPath, { force: true });
    await fs.promises.rename(pendingPath, outputPath);
  };
  const isGeneratedTeamIdentity = identity => /^待确认人物\s+\d+$/.test(String(identity?.name || ''));
  const teamBboxIou = (left, right) => {
    const leftRight = Number(left?.x || 0) + Number(left?.width || 0);
    const leftBottom = Number(left?.y || 0) + Number(left?.height || 0);
    const rightRight = Number(right?.x || 0) + Number(right?.width || 0);
    const rightBottom = Number(right?.y || 0) + Number(right?.height || 0);
    const intersectionWidth = Math.max(0, Math.min(leftRight, rightRight) - Math.max(Number(left?.x || 0), Number(right?.x || 0)));
    const intersectionHeight = Math.max(0, Math.min(leftBottom, rightBottom) - Math.max(Number(left?.y || 0), Number(right?.y || 0)));
    const intersection = intersectionWidth * intersectionHeight;
    const leftArea = Math.max(0, Number(left?.width || 0)) * Math.max(0, Number(left?.height || 0));
    const rightArea = Math.max(0, Number(right?.width || 0)) * Math.max(0, Number(right?.height || 0));
    const union = leftArea + rightArea - intersection;
    return union > 0 ? intersection / union : 0;
  };
  const teamSubjects = workspace => {
    const subjects = new Map();
    const assignments = new Map((workspace.assignments || []).map(item => [teamSubjectKey(item), item]));
    const identities = new Map((workspace.identities || []).map(item => [item.id, item]));
    for (const photo of workspace.photos || []) {
      for (const task of photo.tasks || []) {
        const members = task.members?.length ? task.members : [{ personIndex: task.personIndex, bbox: task.bbox, faceBox: null }];
        for (const member of members) {
          const key = `${photo.photoId}:${photo.baseVersionId}:${member.personIndex}`;
          const assignment = assignments.get(key);
          const subject = {
            key,
            photoId: photo.photoId, baseVersionId: photo.baseVersionId, personIndex: member.personIndex,
            photoName: photo.name, path: photo.sourcePath, bbox: member.bbox, faceBox: member.faceBox || null,
            taskId: task.id,
            taskOrder: members.map(item => Number(item.personIndex)),
            manualIdentityId: assignment?.identityId && assignment.source === 'manual' ? assignment.identityId : undefined,
          };
          if (!subjects.has(subject.key)) subjects.set(subject.key, subject);
        }
      }
    }
    return [...subjects.values()];
  };
  const readyTeamWorkflowSubjects = (workspace, requestedItems = []) => {
    const assignments = new Map((workspace.assignments || []).map(item => [teamSubjectKey(item), item]));
    const identities = new Map((workspace.identities || []).map(item => [item.id, item]));
    const requested = new Map(requestedItems.map(item => [teamSubjectKey(item), item]));
    const taskSubjects = new Map();
    for (const photo of workspace.photos || []) {
      for (const task of photo.tasks || []) {
        const members = task.members?.length ? task.members : [{ personIndex: task.personIndex, bbox: task.bbox }];
        const group = [];
        for (const member of members) {
          const subject = {
            key: `${photo.photoId}:${photo.baseVersionId}:${member.personIndex}`,
            photoId: photo.photoId,
            baseVersionId: photo.baseVersionId,
            photoName: photo.name,
            task,
            personIndex: member.personIndex,
            assignment: assignments.get(`${photo.photoId}:${photo.baseVersionId}:${member.personIndex}`),
          };
          if (subject.assignment?.identityId && identities.has(subject.assignment.identityId)) {
            group.push(subject);
          }
        }
        if (group.length) taskSubjects.set(`${photo.photoId}:${photo.baseVersionId}:${task.id}`, group);
      }
    }
    const ready = [];
    for (const group of taskSubjects.values()) {
      const selected = group.map(item => ({ item, request: requested.get(item.key) })).find(candidate => candidate.request && String(candidate.request.taskId) === String(candidate.item.task.id));
      if (!selected) continue;
      const suppliedOrder = Array.isArray(selected.request.taskOrder) ? selected.request.taskOrder.map(Number) : [];
      const memberByIndex = new Map(group.map(item => [item.personIndex, item]));
      if (suppliedOrder.length !== group.length || new Set(suppliedOrder).size !== group.length || suppliedOrder.some(personIndex => !memberByIndex.has(personIndex))) continue;
      const ordered = suppliedOrder.map(personIndex => memberByIndex.get(personIndex));
      // Validate only the predecessor chain for this photo/task; unrelated work
      // in the same week must never block the next person in a later week.
      const current = ordered.find(item => !item.assignment.completed);
      if (current?.key === selected.item.key) ready.push({ ...current, identity: identities.get(current.assignment.identityId) });
    }
    return ready;
  };

  ipcMain.handle('workspace-team-project', async (_event, workspacePath, projectName, status) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      const settings = await readTeamWorkflowSettings(workspaceRoot, projectName);
      const identityIds = new Set((workspace.identities || []).map(identity => identity.id));
      const preferredIdentityOrder = (settings.preferredIdentityOrder || []).filter(identityId => identityIds.has(identityId));
      const requestedSameWeekIdentityIds = new Set((settings.sameWeekIdentityIds || []).map(String));
      const sameWeekIdentityIds = preferredIdentityOrder.slice(1).filter(identityId => requestedSameWeekIdentityIds.has(identityId));
      const workflowTarget = status ? await readTeamWorkflowManifest(workspaceRoot, status, projectName) : null;
      const workflowManifest = workflowTarget?.manifest || null;
      const workflowGenerated = Boolean(workflowManifest && Number(workflowManifest.version) >= 2);
      const generatedSettings = workflowManifest?.workflowSettings;
      const generatedOrder = Array.isArray(generatedSettings?.preferredIdentityOrder) ? generatedSettings.preferredIdentityOrder.map(String) : [];
      const generatedSameWeekSet = new Set(Array.isArray(generatedSettings?.sameWeekIdentityIds) ? generatedSettings.sameWeekIdentityIds.map(String) : []);
      const generatedSameWeekIdentityIds = generatedOrder.slice(1).filter(identityId => generatedSameWeekSet.has(identityId));
      const workflowNeedsRegeneration = Boolean(workflowGenerated && generatedSettings && (
        JSON.stringify(generatedOrder) !== JSON.stringify(preferredIdentityOrder)
        || JSON.stringify(generatedSameWeekIdentityIds) !== JSON.stringify(sameWeekIdentityIds)
      ));
      const workflowAvailableKeys = workflowGenerated
        ? (workflowManifest.groups || []).flatMap(group => (group.items || []).filter(item => {
          if (!item.available || !item.relativePath) return false;
          const itemPath = path.resolve(workflowTarget.outputDirectory, item.relativePath);
          return isInside(workflowTarget.outputDirectory, itemPath) && fs.existsSync(itemPath);
        }).map(item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`))
        : [];
      return { ...workspace, workflowGenerated, workflowNeedsRegeneration, workflowAvailableKeys, workflowSettings: { preferredIdentityOrder, preferredIdentityId: preferredIdentityOrder[0] || undefined, sameWeekIdentityIds } };
    } catch (error) {
      writeLog('error', 'Unable to load team retouch project workspace', {
        projectName: String(projectName || ''),
        error: error.message || String(error),
      });
      return { success: false, photos: [], identities: [], assignments: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-identity-similarities', async (_event, workspacePath, projectName) => {
    try {
      const similarities = await readTeamIdentitySimilarities(ensureWorkspace(workspacePath), projectName);
      return { success: true, similarities };
    } catch (error) {
      return { success: false, similarities: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-project-register', async (_event, workspacePath, status, projectName, relativePaths = []) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      for (const relativePath of [...new Set(relativePaths.map(value => String(value)))]) {
        const filePath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
        if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error(`不支持的图片：${path.basename(filePath)}`);
        const bundle = await versionService.getMedia(workspaceRoot, { projectName, filePath });
        const base = bundle.versions?.find(version => version.id === bundle.photo?.currentVersionId)
          || bundle.versions?.find(version => version.isCurrent)
          || bundle.versions?.at(-1);
        if (!bundle.photo || !base) throw new Error(`无法登记图片：${path.basename(filePath)}`);
        await versionService.registerTeamProjectPhoto(workspaceRoot, { projectName, photoId: bundle.photo.id, baseVersionId: base.id });
      }
      return await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
    } catch (error) {
      return { success: false, photos: [], identities: [], assignments: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-identities-suggest', async (_event, workspacePath, projectName) => {
    let manifestPath = '';
    try {
      if (!privacyService.hasFaceRecognitionConsent()) {
        throw new Error('使用人物身份识别前，需要单独同意《人脸信息处理规则》');
      }
      pluginService.requireCapability('team-retouch.identify');
      const workspaceRoot = ensureWorkspace(workspacePath);
      const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      const subjects = teamSubjects(workspace);
      if (!subjects.length) throw new Error('项目里还没有已识别的人物');
      const batchDirectory = path.join(getWorkspaceDataRoot(workspaceRoot), 'team-retouch', 'batches');
      await fs.promises.mkdir(batchDirectory, { recursive: true });
      manifestPath = path.join(batchDirectory, `identify-${crypto.randomUUID()}.json`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ subjects }, null, 2), 'utf8');
      const suggested = await pluginService.runJson('team-retouch', ['identify', '--manifest', manifestPath], 60 * 60 * 1000);
      await writeTeamIdentitySimilarities(workspaceRoot, projectName, suggested.similarities || []);
      // Identity inference is intentionally allowed to run in the background while
      // the user confirms people. Re-read before cleanup so a result produced from
      // an older snapshot never removes a manual choice made during inference.
      const latestWorkspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      const generatedIdentityIds = new Set((latestWorkspace.identities || []).filter(isGeneratedTeamIdentity).map(item => item.id));
      const manuallyAnchoredIds = new Set((latestWorkspace.assignments || []).filter(item => ['manual', 'manual-group'].includes(item.source) && item.identityId).map(item => item.identityId));
      for (const assignment of latestWorkspace.assignments || []) {
        if (assignment.source !== 'suggested' || !generatedIdentityIds.has(assignment.identityId)) continue;
        await versionService.assignTeamIdentity(workspaceRoot, { projectName, ...assignment, identityId: undefined, confidence: 0, source: 'suggested', completed: false });
      }
      for (const identity of latestWorkspace.identities || []) {
        if (generatedIdentityIds.has(identity.id) && !manuallyAnchoredIds.has(identity.id)) {
          await versionService.deleteTeamIdentity(workspaceRoot, { projectName, identityId: identity.id });
        }
      }
      const workingWorkspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      const currentByKey = new Map((workingWorkspace.assignments || []).map(item => [teamSubjectKey(item), item]));
      const currentIdentities = new Map((workingWorkspace.identities || []).map(item => [item.id, item]));
      const assignedKeys = new Set([...currentByKey].filter(([, assignment]) => assignment.identityId).map(([key]) => key));
      let created = 0;
      let nextCandidateNumber = Math.max(0, ...(workingWorkspace.identities || []).map(identity => Number(String(identity.name || '').match(/^待确认人物\s+(\d+)$/)?.[1] || 0))) + 1;
      for (const cluster of suggested.clusters || []) {
        const members = (cluster.members || []).map(item => subjects.find(subject => subject.key === item.key)).filter(Boolean);
        const known = new Set(members.map(member => currentByKey.get(member.key)).filter(item => item?.identityId && (item.source === 'manual' || !isGeneratedTeamIdentity(currentIdentities.get(item.identityId)))).map(item => item.identityId));
        if (known.size > 1) continue;
        const confidence = Number.isFinite(Number(cluster.score)) ? Math.max(.5, Math.min(.98, Number(cluster.score))) : cluster.confidence === 'high' ? .9 : .65;
        let identityId = [...known][0];
        if (!identityId) {
          const saved = await versionService.saveTeamIdentity(workspaceRoot, {
            projectName, name: `待确认人物 ${nextCandidateNumber++}`,
            assignments: members.map(member => ({ ...member, confidence, source: 'suggested' })),
          });
          identityId = saved.identityId;
          created += 1;
        } else {
          for (const member of members) {
            const current = currentByKey.get(member.key);
            if (current?.source === 'manual' || current?.identityId && !isGeneratedTeamIdentity(currentIdentities.get(current.identityId))) continue;
            await versionService.assignTeamIdentity(workspaceRoot, { projectName, ...member, identityId, confidence, source: 'suggested' });
          }
        }
        for (const member of members) assignedKeys.add(member.key);
      }
      // A single photo cannot prove that two people are the same identity, and
      // low-quality subjects may not enter any cluster. Still create isolated
      // review candidates so the recognition step can immediately show an
      // editable person name instead of leaving blank fields.
      for (const subject of subjects) {
        if (assignedKeys.has(subject.key)) continue;
        const saved = await versionService.saveTeamIdentity(workspaceRoot, {
          projectName,
          name: `待确认人物 ${nextCandidateNumber++}`,
          assignments: [{ ...subject, confidence: .35, source: 'suggested' }],
        });
        if (saved.identityId) {
          assignedKeys.add(subject.key);
          created += 1;
        }
      }
      return { ...(await versionService.getTeamProjectWorkspace(workspaceRoot, projectName)), similarities: suggested.similarities || [], suggestedCount: created, candidateGroupCount: suggested.clusters?.length || 0, method: suggested.method || 'sface-osnet-gallery-v3', faceBackend: suggested.faceBackend, bodyBackend: suggested.bodyBackend, unmatchedCount: suggested.unmatchedCount, provider: suggested.provider };
    } catch (error) {
      return { success: false, photos: [], identities: [], assignments: [], error: error.message || String(error) };
    } finally {
      if (manifestPath) await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('workspace-team-identity-save', async (_event, workspacePath, request = {}) => {
    try { return await versionService.saveTeamIdentity(ensureWorkspace(workspacePath), request); }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('workspace-team-identity-assign', async (_event, workspacePath, request = {}) => {
    try { return await versionService.assignTeamIdentity(ensureWorkspace(workspacePath), request); }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('workspace-team-identity-confirm-group', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const projectName = String(request.projectName || '').trim();
      if (!projectName) throw new Error('项目名称不能为空');
      const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      if (!workspace.success) throw new Error(workspace.error || '无法读取人物识别结果');
      const validSubjects = new Map(teamSubjects(workspace).map(subject => [subject.key, subject]));
      const anchorSubjectKey = String(request.anchorSubjectKey || '');
      const requestedAssignments = [];
      const requestedKeys = new Set();
      for (const item of Array.isArray(request.assignments) ? request.assignments : []) {
        const key = teamSubjectKey(item);
        const subject = validSubjects.get(key);
        if (!subject || requestedKeys.has(key)) continue;
        requestedKeys.add(key);
        requestedAssignments.push({
          key,
          photoId: subject.photoId,
          baseVersionId: subject.baseVersionId,
          personIndex: subject.personIndex,
          confidence: Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 1,
        });
      }
      if (!requestedKeys.has(anchorSubjectKey)) throw new Error('当前人物必须包含在本次标记范围内');
      const includedPhotoKeys = new Set();
      let duplicateSkippedCount = 0;
      const assignments = [
        ...requestedAssignments.filter(assignment => assignment.key === anchorSubjectKey),
        ...requestedAssignments.filter(assignment => assignment.key !== anchorSubjectKey),
      ].filter(assignment => {
        const photoKey = `${assignment.photoId}:${assignment.baseVersionId}`;
        if (includedPhotoKeys.has(photoKey)) { duplicateSkippedCount += 1; return false; }
        includedPhotoKeys.add(photoKey);
        return true;
      }).map(({ key: _key, ...assignment }) => assignment);
      const includedKeys = new Set(assignments.map(teamSubjectKey));
      if (!assignments.length) throw new Error('没有需要标记的人物');
      const targetIdentityId = String(request.identityId || '');
      const clearAssignments = [];
      const assignmentByKey = new Map((workspace.assignments || []).map(item => [teamSubjectKey(item), item]));
      for (const assignment of assignments) {
        const key = teamSubjectKey(assignment);
        const current = assignmentByKey.get(key);
        if (key !== anchorSubjectKey && targetIdentityId && current?.identityId && current.identityId !== targetIdentityId && ['manual', 'manual-group'].includes(current.source)) {
          throw new Error('候选组中包含已经人工确认的其他人物，请先取消勾选冲突项');
        }
      }
      if (targetIdentityId) {
        const includedByPhoto = new Map();
        for (const assignment of assignments) {
          const key = `${assignment.photoId}:${assignment.baseVersionId}`;
          const indexes = includedByPhoto.get(key) || new Set();
          indexes.add(Number(assignment.personIndex));
          includedByPhoto.set(key, indexes);
        }
        for (const current of workspace.assignments || []) {
          if (current.identityId !== targetIdentityId) continue;
          const currentKey = teamSubjectKey(current);
          if (!validSubjects.has(currentKey)) continue;
          const indexes = includedByPhoto.get(`${current.photoId}:${current.baseVersionId}`);
          if (!indexes || indexes.has(Number(current.personIndex))) continue;
          if (['manual', 'manual-group'].includes(current.source)) throw new Error('同一张照片中已有其他人工确认的人物使用该身份，请检查识别结果');
          clearAssignments.push({
            photoId: current.photoId,
            baseVersionId: current.baseVersionId,
            personIndex: Number(current.personIndex),
          });
        }
      }
      const confirmed = await versionService.confirmTeamIdentityGroup(workspaceRoot, {
        projectName,
        anchorSubjectKey,
        identityId: targetIdentityId || undefined,
        name: String(request.name || '').trim() || undefined,
        assignments,
        clearAssignments,
      });
      const updatedWorkspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      return { ...updatedWorkspace, identityId: confirmed.identityId, updatedCount: confirmed.updatedCount, autoReleasedCount: clearAssignments.length, duplicateSkippedCount };
    } catch (error) {
      return { success: false, photos: [], identities: [], assignments: [], error: error.message || String(error) };
    }
  });
  ipcMain.handle('workspace-team-identity-complete', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!request.taskId || !request.projectName || !request.status || !Array.isArray(request.taskOrder)) {
        return await versionService.completeTeamIdentity(workspaceRoot, request);
      }
      const workflow = await readTeamWorkflowManifest(workspaceRoot, request.status, request.projectName);
      if (!workflow.manifest) throw new Error('请先生成工作流程');
      const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, request.projectName);
      const photo = (workspace.photos || []).find(item => item.photoId === request.photoId && item.baseVersionId === request.baseVersionId);
      const task = photo?.tasks?.find(item => String(item.id) === String(request.taskId));
      if (!task) throw new Error('人物修图任务不存在');
      const assignments = new Map((workspace.assignments || [])
        .filter(item => item.photoId === request.photoId && item.baseVersionId === request.baseVersionId)
        .map(item => [Number(item.personIndex), item]));
      const ordered = request.taskOrder.map(Number).map(personIndex => assignments.get(personIndex)).filter(Boolean);
      if (ordered.length !== request.taskOrder.length || new Set(request.taskOrder.map(Number)).size !== request.taskOrder.length) throw new Error('工作流程顺序无效，请刷新后重试');
      const personIndex = Number(request.personIndex);
      const targetIndex = request.taskOrder.map(Number).indexOf(personIndex);
      if (targetIndex < 0) throw new Error('人物不属于这个工作流程任务');
      if (request.completed) {
        const current = ordered.find(item => !item.completed);
        if (!current || Number(current.personIndex) !== personIndex) {
          await versionService.completeTeamIdentity(workspaceRoot, { ...request, completed: false, completionKind: 'skip-requested' });
          return { success: true, deferred: true };
        }
        const sourcePath = task.editedPatchPath && fs.existsSync(task.editedPatchPath) ? task.editedPatchPath : task.patchPath;
        await versionService.completeTeamIdentity(workspaceRoot, { ...request, completed: true, completionKind: 'no-retouch' });
        let warning = '';
        await refreshDownstreamWorkflowFiles(workspaceRoot, request.status, request.projectName, task.id, personIndex, sourcePath).catch(error => {
          warning = `已标记不用修，但下一位任务文件生成失败：${error.message || String(error)}`;
          writeLog('warn', 'Unable to advance no-retouch workflow task', { projectName: request.projectName, taskId: task.id, error: error.message || String(error) });
        });
        return { success: true, warning: warning || undefined };
      }
      if (ordered.slice(targetIndex + 1).some(item => item.completed)) throw new Error('后续人物已经完成，请按倒序先撤销后续任务');
      const predecessorPath = ordered.slice(0, targetIndex).reverse().map(item => item.editedPatchPath).find(filePath => filePath && fs.existsSync(filePath));
      const sourcePath = predecessorPath || task.patchPath;
      await versionService.updateTeamPatch(workspaceRoot, {
        taskId: task.id,
        editedPatchPath: predecessorPath || null,
        status: predecessorPath ? 'uploaded' : 'exported',
        assignmentCompletion: { personIndex, completed: false, completionKind: '' },
      });
      await rewindWorkflowFiles(workspaceRoot, request.status, request.projectName, task.id, personIndex, sourcePath);
      return { success: true };
    }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('workspace-team-identity-delete', async (_event, workspacePath, request = {}) => {
    try { return await versionService.deleteTeamIdentity(ensureWorkspace(workspacePath), request); }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('workspace-team-workflow-settings-save', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const projectName = String(request.projectName || '').trim();
      if (!projectName) throw new Error('项目名称不能为空');
      const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      const workflowStarted = (workspace.assignments || []).some(assignment => assignment.completed || assignment.returnMissing)
        || (workspace.photos || []).some(photo => (photo.tasks || []).some(task => Boolean(task.editedPatchPath) || !['', 'exported'].includes(String(task.status || 'exported'))));
      if (workflowStarted) throw new Error('已有任务返图或完成，不能再修改优先开工人物');
      const requestedOrder = Array.isArray(request.preferredIdentityOrder)
        ? request.preferredIdentityOrder
        : request.preferredIdentityId ? [request.preferredIdentityId] : [];
      const preferredIdentityOrder = [...new Set(requestedOrder.map(String).filter(Boolean))];
      const identityIds = new Set((workspace.identities || []).map(identity => identity.id));
      const assignedIdentityIds = new Set((workspace.assignments || []).map(assignment => assignment.identityId).filter(Boolean));
      if (preferredIdentityOrder.some(identityId => !identityIds.has(identityId))) throw new Error('排序中包含不存在的人物，请刷新后重试');
      if (preferredIdentityOrder.some(identityId => !assignedIdentityIds.has(identityId))) throw new Error('排序中的人物还没有任何任务');
      const requestedSameWeekIdentityIds = [...new Set((request.sameWeekIdentityIds || []).map(String).filter(Boolean))];
      if (requestedSameWeekIdentityIds.some(identityId => !preferredIdentityOrder.slice(1).includes(identityId))) throw new Error('同周关系必须连接优先队列中相邻的人物');
      const workflowSettings = {
        preferredIdentityOrder,
        preferredIdentityId: preferredIdentityOrder[0] || undefined,
        sameWeekIdentityIds: requestedSameWeekIdentityIds,
      };
      await writeTeamWorkflowSettings(workspaceRoot, projectName, workflowSettings);
      return { success: true, workflowSettings };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  ipcMain.handle('workspace-team-person-exclude', async (event, workspacePath, status, projectName, request = {}) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      const subjectKey = `${request.photoId}:${request.baseVersionId}:${Number(request.personIndex)}`;
      const oldSubjects = teamSubjects(workspace);
      const selectedSubject = oldSubjects.find(subject => subject.key === subjectKey);
      if (!selectedSubject) throw new Error('人物实例不存在，可能已经被移除');
      const photoWorkspace = (workspace.photos || []).find(photo => photo.photoId === request.photoId && photo.baseVersionId === request.baseVersionId);
      const selectedTask = photoWorkspace?.tasks?.find(task => (task.members?.length ? task.members : [{ personIndex: task.personIndex }]).some(member => Number(member.personIndex) === Number(request.personIndex)));
      if (!selectedTask) throw new Error('找不到人物对应的工作图');
      const protectedTask = (photoWorkspace.tasks || []).find(task => task.editedPatchPath || !['', 'exported'].includes(String(task.status || 'exported')));
      if (protectedTask) {
        throw new Error('这张图片已有返图或合成记录，不能重新计算工作图；请先清理对应返图');
      }

      const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
      const base = bundle.versions?.find(version => version.id === request.baseVersionId);
      if (!base || base.fileMissing || !fs.existsSync(base.filePath)) throw new Error('基础版本文件不存在');
      const currentExclusions = await versionService.listTeamPersonExclusions(workspaceRoot, {
        projectName, photoId: request.photoId, baseVersionId: request.baseVersionId,
      });
      const excludedBoxes = [...(currentExclusions.exclusions || []).map(item => item.bbox), selectedSubject.bbox];
      const outputDirectory = path.join(teamDataDirectory(workspaceRoot, request.photoId, request.baseVersionId), 'analysis');
      const exportDirectory = deliveryDirectory(bundle.photo, base.filePath);
      const savedConfig = readSavedConfig();
      const personDetection = savedConfig.componentSettings?.['team-retouch'] || savedConfig.personDetection || {};
      const oversizeCropMode = personDetection.oversizeCropMode === 'expand' ? 'expand' : 'face-centered';
      const requestedMode = 'stored';
      await fs.promises.mkdir(outputDirectory, { recursive: true });
      const rebuildManifestPath = path.join(outputDirectory, `rebuild-${crypto.randomUUID()}.json`);
      await fs.promises.writeFile(rebuildManifestPath, JSON.stringify({
        removePersonIndex: Number(request.personIndex),
        detector: selectedTask.detector || 'stored-detection',
        tasks: photoWorkspace.tasks || [],
      }, null, 2), 'utf8');
      let detected;
      try {
        detected = await pluginService.runJson(
          'team-retouch',
          [
            'rebuild', '--input', base.filePath, '--manifest', rebuildManifestPath,
            '--output-dir', outputDirectory, '--delivery-dir', exportDirectory,
            '--delivery-prefix', deliveryName(bundle.photo, base.filePath),
            '--oversize-crop-mode', oversizeCropMode,
          ],
          60 * 60 * 1000,
          message => {
            if (message?.type !== 'progress' || event.sender.isDestroyed()) return;
            event.sender.send('workspace-team-patch-detect-progress', {
              photoId: request.photoId,
              baseVersionId: request.baseVersionId,
              progress: Math.max(0, Math.min(100, Number(message.progress) || 0)),
              message: String(message.message || '正在移除误识别人物并重新计算工作图'),
            });
          },
        );
      } finally {
        await fs.promises.rm(rebuildManifestPath, { force: true }).catch(() => undefined);
      }
      const expectedPersonCount = oldSubjects.filter(subject => subject.photoId === request.photoId && subject.baseVersionId === request.baseVersionId).length - 1;
      if (Number(detected.personCount) !== expectedPersonCount || Number(detected.removedPersonCount) !== 1) {
        throw new Error(`本地重建人物数量异常：预期 ${expectedPersonCount}，实际 ${Number(detected.personCount) || 0}`);
      }
      const missingExports = (detected.tasks || []).filter(task => !task.patchPath || !fs.existsSync(task.patchPath));
      if (missingExports.length) throw new Error(`重新生成工作图失败（缺少 ${missingExports.length} 个文件）`);

      const oldAssignments = new Map((workspace.assignments || []).map(assignment => [teamSubjectKey(assignment), assignment]));
      const detectedTasks = (detected.tasks || []).map(task => ({ ...task }));
      const taskMatches = (photoWorkspace.tasks || []).flatMap(oldTask => detectedTasks.map(newTask => ({
        oldTask,
        newTask,
        score: teamBboxIou(oldTask.bbox, newTask.bbox),
      }))).filter(match => match.score >= .2).sort((left, right) => right.score - left.score);
      const usedOldTaskIds = new Set();
      const usedNewTasks = new Set();
      for (const match of taskMatches) {
        if (usedOldTaskIds.has(match.oldTask.id) || usedNewTasks.has(match.newTask)) continue;
        usedOldTaskIds.add(match.oldTask.id);
        usedNewTasks.add(match.newTask);
        match.newTask.id = match.oldTask.id;
      }
      const patchResult = await versionService.replaceTeamPatches(workspaceRoot, {
        photoId: request.photoId,
        baseVersionId: request.baseVersionId,
        tasks: detectedTasks,
      });
      await versionService.addTeamPersonExclusion(workspaceRoot, {
        projectName,
        photoId: request.photoId,
        baseVersionId: request.baseVersionId,
        bbox: selectedSubject.bbox,
        reason: 'false-positive',
      });
      await versionService.registerTeamProjectPhoto(workspaceRoot, {
        projectName, photoId: request.photoId, baseVersionId: request.baseVersionId,
      });
      queueCleanupArtifacts(workspaceRoot, { teamArtifactPaths: patchResult.artifactPaths || [] }, '清理已替换的团队修图文件');

      // Do not read the workspace before restoring assignments. Workspace reads
      // clean empty generated identities, and replacing the patches temporarily
      // removes every assignment for this photo. Reading here used to delete a
      // temporary identity moments before it was assigned back to a matched body.
      const newSubjects = (patchResult.tasks || []).flatMap(task => {
        const members = task.members?.length ? task.members : [{ personIndex: task.personIndex, bbox: task.bbox }];
        const taskOrder = members.map(member => Number(member.personIndex));
        return members.map(member => ({
          key: `${request.photoId}:${request.baseVersionId}:${Number(member.personIndex)}`,
          photoId: request.photoId,
          baseVersionId: request.baseVersionId,
          personIndex: Number(member.personIndex),
          bbox: member.bbox,
          faceBox: member.faceBox || null,
          taskId: task.id,
          taskOrder,
        }));
      });
      const oldCandidates = oldSubjects.filter(subject => subject.key !== subjectKey && subject.photoId === request.photoId && subject.baseVersionId === request.baseVersionId && oldAssignments.get(subject.key)?.identityId);
      const matches = oldCandidates.flatMap(oldSubject => newSubjects.map(newSubject => ({
        oldSubject,
        newSubject,
        score: teamBboxIou(oldSubject.bbox, newSubject.bbox),
      }))).filter(match => match.score >= .42).sort((left, right) => right.score - left.score);
      const usedOld = new Set();
      const usedNew = new Set();
      const subjectRemap = new Map();
      for (const match of matches) {
        if (usedOld.has(match.oldSubject.key) || usedNew.has(match.newSubject.key)) continue;
        const assignment = oldAssignments.get(match.oldSubject.key);
        await versionService.assignTeamIdentity(workspaceRoot, {
          projectName,
          photoId: match.newSubject.photoId,
          baseVersionId: match.newSubject.baseVersionId,
          personIndex: match.newSubject.personIndex,
          identityId: assignment.identityId,
          confidence: assignment.confidence,
          source: assignment.source,
          completed: assignment.completed,
        });
        usedOld.add(match.oldSubject.key);
        usedNew.add(match.newSubject.key);
        subjectRemap.set(match.oldSubject.key, match.newSubject);
      }
      let workflowRefreshCount = 0;
      let workflowWarning = '';
      try {
        const workflow = await readTeamWorkflowManifest(workspaceRoot, status, projectName);
        if (workflow.manifest) {
          let changed = false;
          for (const group of workflow.manifest.groups || []) {
            const nextItems = [];
            for (const item of group.items || []) {
              if (item.photoId !== request.photoId || item.baseVersionId !== request.baseVersionId) {
                nextItems.push(item);
                continue;
              }
              const oldKey = `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`;
              const remapped = subjectRemap.get(oldKey);
              const destination = item.relativePath ? path.resolve(workflow.outputDirectory, item.relativePath) : '';
              if (!remapped) {
                if (destination && isInside(workflow.outputDirectory, destination)) await fs.promises.rm(destination, { force: true }).catch(() => undefined);
                changed = true;
                continue;
              }
              const updatedItem = {
                ...item,
                personIndex: remapped.personIndex,
                taskId: remapped.taskId,
                taskOrder: remapped.taskOrder,
              };
              const sourcePath = await resolveWorkflowSource(workspaceRoot, updatedItem);
              if (sourcePath && destination && isInside(workflow.outputDirectory, destination)) {
                await replaceFileAtomic(sourcePath, destination);
                workflowRefreshCount += 1;
              }
              nextItems.push(updatedItem);
              changed = true;
            }
            group.items = nextItems;
          }
          workflow.manifest.groups = (workflow.manifest.groups || []).filter(group => (group.items || []).length);
          if (changed) {
            await fs.promises.mkdir(workflow.workflowDataDirectory, { recursive: true });
            const pendingPath = `${workflow.manifestPath}.${crypto.randomUUID()}.tmp`;
            await fs.promises.writeFile(pendingPath, JSON.stringify(workflow.manifest, null, 2), 'utf8');
            await fs.promises.rm(workflow.manifestPath, { force: true });
            await fs.promises.rename(pendingPath, workflow.manifestPath);
          }
        }
      } catch (error) {
        workflowWarning = `误识别人物已移除，但同步已有任务文件夹失败：${error.message || String(error)}`;
        writeLog('warn', 'Unable to refresh workflow after excluding subject', {
          projectName, photoId: request.photoId, baseVersionId: request.baseVersionId,
          error: error.message || String(error),
        });
      }
      await writeTeamIdentitySimilarities(workspaceRoot, projectName, []);
      const updatedWorkspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      return {
        ...bundle,
        ...updatedWorkspace,
        tasks: patchResult.tasks || [],
        excludedPersonCount: excludedBoxes.length,
        removedPersonCount: 1,
        workflowRefreshCount,
        warning: workflowWarning || undefined,
        detection: {
          detector: detected.detector,
          backend: detected.backend || 'cpu',
          provider: detected.provider || '',
          requestedMode: detected.requestedMode || requestedMode,
          advancedBackend: Boolean(detected.advancedBackend),
          width: detected.width,
          height: detected.height,
          personCount: detected.personCount ?? 0,
          workTileEdge: detected.workTileEdge || 4000,
          needsReviewCount: detected.needsReviewCount || 0,
          fallbackReason: detected.fallbackReason || '',
        },
      };
    } catch (error) {
      writeLog('error', 'Unable to exclude false-positive team retouch subject', {
        projectName, photoId: request.photoId, baseVersionId: request.baseVersionId,
        personIndex: request.personIndex, error: error.message || String(error),
      });
      return { success: false, photos: [], identities: [], assignments: [], versions: [], tasks: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-project-remove-photo', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const listed = await versionService.listTeamPatches(workspaceRoot, request.photoId);
      const baseVersionIds = [...new Set((listed.tasks || []).map(task => task.baseVersionId))];
      const artifactPaths = [];
      for (const baseVersionId of baseVersionIds) {
        const result = await versionService.cleanupTeamPatches(workspaceRoot, { photoId: request.photoId, baseVersionId, force: true });
        artifactPaths.push(...(result.artifactPaths || []));
      }
      await versionService.unregisterTeamProjectPhoto(workspaceRoot, { photoId: request.photoId });
      queueCleanupArtifacts(workspaceRoot, {
        teamArtifactPaths: artifactPaths,
        teamDataKeys: baseVersionIds.map(baseVersionId => ({ photoId: request.photoId, baseVersionId })),
      }, '清理已移除照片的团队数据');
      return { success: true, cleanupQueued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-workflow-status', async (_event, workspacePath, status, projectName) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const job = workflowGenerationJobs.get(workflowGenerationKey(workspaceRoot, status, projectName));
      return { success: true, job: job?.snapshot || null };
    } catch (error) {
      return { success: false, job: null, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-workflow-cancel', async (_event, operationId) => {
    const job = [...workflowGenerationJobs.values()].find(candidate => candidate.operationId === String(operationId || '') && candidate.snapshot?.state === 'running');
    if (!job) return { success: true, cancelled: false };
    job.cancelled = true;
    job.snapshot = { ...job.snapshot, phase: 'cancelling', message: '正在安全停止，已完成的文件下次会直接复用' };
    return { success: true, cancelled: true };
  });

  ipcMain.handle('workspace-team-workflow-generate', async (event, workspacePath, status, projectName, request = {}) => {
    let stagingDirectory = '';
    let backupDirectory = '';
    let pendingManifestPath = '';
    let checkpointReady = false;
    let stageCommitted = false;
    let job = null;
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const { projectPath, outputDirectory, workflowDataDirectory, manifestPath, legacyManifestPath } = teamWorkflowOutput(workspaceRoot, status, projectName);
      if (fs.existsSync(outputDirectory) && !request.replace) return { success: true, requiresConfirmation: true, path: outputDirectory };
      const jobKey = workflowGenerationKey(workspaceRoot, status, projectName);
      const existingJob = workflowGenerationJobs.get(jobKey);
      if (existingJob?.snapshot?.state === 'running') {
        return { success: true, alreadyRunning: true, operationId: existingJob.operationId };
      }
      const operationId = String(request.operationId || crypto.randomUUID());
      job = {
        operationId,
        cancelled: false,
        snapshot: {
          operationId,
          projectName: String(projectName),
          state: 'running',
          phase: 'preparing',
          progress: 0,
          completedFiles: 0,
          totalFiles: 0,
          copiedBytes: 0,
          totalBytes: 0,
          currentName: '',
          message: '正在一次性读取工作图任务…',
        },
      };
      workflowGenerationJobs.set(jobKey, job);
      let lastProgressAt = 0;
      const publish = (update, force = false) => {
        const now = Date.now();
        const totalBytes = Number(update.totalBytes ?? job.snapshot.totalBytes) || 0;
        const copiedBytes = Number(update.copiedBytes ?? job.snapshot.copiedBytes) || 0;
        const totalFiles = Number(update.totalFiles ?? job.snapshot.totalFiles) || 0;
        const completedFiles = Number(update.completedFiles ?? job.snapshot.completedFiles) || 0;
        const progress = totalBytes > 0 ? copiedBytes / totalBytes * 100 : totalFiles > 0 ? completedFiles / totalFiles * 100 : Number(update.progress ?? job.snapshot.progress) || 0;
        job.snapshot = { ...job.snapshot, ...update, totalBytes, copiedBytes, totalFiles, completedFiles, progress: Math.max(0, Math.min(100, progress)) };
        if (!force && now - lastProgressAt < 120) return;
        lastProgressAt = now;
        if (!event.sender.isDestroyed()) event.sender.send('workspace-team-workflow-progress', job.snapshot);
      };
      publish({}, true);

      const currentWorkspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      if (job.cancelled) throw Object.assign(new Error('工作流程生成已取消'), { code: WORKFLOW_CANCELLED_CODE });
      stagingDirectory = path.join(projectPath, '.photoflow-team-workflow-staging');
      const workflowSettings = {
        preferredIdentityOrder: Array.isArray(request.preferredIdentityOrder) ? request.preferredIdentityOrder.map(String) : [],
        preferredIdentityId: Array.isArray(request.preferredIdentityOrder) ? String(request.preferredIdentityOrder[0] || '') || undefined : String(request.preferredIdentityId || '') || undefined,
        sameWeekIdentityIds: Array.isArray(request.sameWeekIdentityIds) ? request.sameWeekIdentityIds.map(String) : [],
      };
      const plan = await buildWorkflowPlan({
        groups: request.groups || [],
        workspace: currentWorkspace,
        stagingDirectory,
        safeSegment: safeWorkflowSegment,
        weekName: week => `第${chineseWeekNumber(week)}周`,
      });
      if (job.cancelled) throw Object.assign(new Error('工作流程生成已取消'), { code: WORKFLOW_CANCELLED_CODE });
      if (!plan.manifestGroups.length || !plan.files.length) throw new Error('没有可生成的工作流程任务');
      const fingerprint = crypto.createHash('sha256').update(`${plan.fingerprint}\0${JSON.stringify(workflowSettings)}`).digest('hex');
      const checkpointPath = path.join(stagingDirectory, '.photoflow-workflow-checkpoint.json');
      let checkpoint = null;
      if (fs.existsSync(checkpointPath)) {
        try { checkpoint = JSON.parse(await fs.promises.readFile(checkpointPath, 'utf8')); }
        catch { checkpoint = null; }
      }
      if (fs.existsSync(stagingDirectory) && checkpoint?.fingerprint !== fingerprint) {
        await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
      }
      await fs.promises.mkdir(stagingDirectory, { recursive: true });
      for (const group of plan.manifestGroups) {
        if (!(group.items || []).some(item => item.available)) continue;
        const groupDirectory = path.resolve(stagingDirectory, group.relativePath);
        if (isInside(stagingDirectory, groupDirectory)) await fs.promises.mkdir(groupDirectory, { recursive: true });
      }
      const pendingCheckpointPath = `${checkpointPath}.${crypto.randomUUID()}.tmp`;
      await fs.promises.writeFile(pendingCheckpointPath, JSON.stringify({ version: 1, fingerprint, projectName, status, updatedAt: Date.now() }, null, 2), 'utf8');
      await replaceFileAtomic(pendingCheckpointPath, checkpointPath);
      await fs.promises.rm(pendingCheckpointPath, { force: true });
      checkpointReady = true;
      publish({
        phase: 'copying',
        totalFiles: plan.files.length,
        totalBytes: plan.totalBytes,
        message: checkpoint?.fingerprint === fingerprint ? '正在检查并续传上次已完成的工作图…' : '正在并发复制工作图…',
      }, true);

      await copyWorkflowPlan({
        files: plan.files,
        totalBytes: plan.totalBytes,
        copyFileAtomic,
        concurrency: 3,
        isCancelled: () => job.cancelled,
        onProgress: value => publish({
          ...value,
          message: value.phase === 'resuming' ? '正在复用上次已完成的工作图…' : value.phase === 'finalizing' ? '正在提交工作流程…' : '正在并发复制工作图…',
        }, value.phase === 'finalizing'),
      });
      if (job.cancelled) throw Object.assign(new Error('工作流程生成已取消'), { code: WORKFLOW_CANCELLED_CODE });

      const manifest = {
        version: 2,
        projectName,
        status,
        generatedAt: Date.now(),
        workflowSettings,
        groups: plan.manifestGroups,
      };
      await fs.promises.mkdir(workflowDataDirectory, { recursive: true });
      pendingManifestPath = `${manifestPath}.${crypto.randomUUID()}.tmp`;
      await fs.promises.writeFile(pendingManifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      if (fs.existsSync(outputDirectory)) {
        backupDirectory = path.join(projectPath, `.photoflow-team-workflow-previous-${crypto.randomUUID()}`);
        await fs.promises.rename(outputDirectory, backupDirectory);
      }
      try {
        await fs.promises.rename(stagingDirectory, outputDirectory);
        stageCommitted = true;
        stagingDirectory = '';
      } catch (error) {
        if (backupDirectory && fs.existsSync(backupDirectory) && !fs.existsSync(outputDirectory)) await fs.promises.rename(backupDirectory, outputDirectory).catch(() => undefined);
        throw error;
      }
      await replaceFileAtomic(pendingManifestPath, manifestPath);
      await fs.promises.rm(pendingManifestPath, { force: true });
      pendingManifestPath = '';
      await fs.promises.rm(legacyManifestPath, { force: true });
      await fs.promises.rm(path.join(outputDirectory, path.basename(checkpointPath)), { force: true });
      checkpointReady = false;
      if (backupDirectory) {
        const previousWorkflowDirectory = backupDirectory;
        backupDirectory = '';
        queueFilesystemCleanup([previousWorkflowDirectory], '清理旧的团队工作流目录');
      }
      publish({ state: 'completed', phase: 'complete', progress: 100, completedFiles: plan.files.length, copiedBytes: plan.totalBytes, message: '工作流程生成完成' }, true);
      return { success: true, operationId, count: plan.files.length, groupCount: manifest.groups.length, path: outputDirectory };
    } catch (error) {
      const cancelled = job?.cancelled || error?.code === WORKFLOW_CANCELLED_CODE;
      if (job) {
        job.snapshot = { ...job.snapshot, state: cancelled ? 'cancelled' : 'failed', phase: cancelled ? 'cancelled' : 'failed', message: cancelled ? '已停止；再次生成会从现有进度继续' : `生成失败：${error.message || String(error)}`, error: cancelled ? undefined : error.message || String(error) };
        if (!event.sender.isDestroyed()) event.sender.send('workspace-team-workflow-progress', job.snapshot);
      }
      if (pendingManifestPath) await fs.promises.rm(pendingManifestPath, { force: true }).catch(() => undefined);
      if (stageCommitted) {
        const workspaceRoot = ensureWorkspace(workspacePath);
        const { projectPath, outputDirectory } = teamWorkflowOutput(workspaceRoot, status, projectName);
        const resumeDirectory = path.join(projectPath, '.photoflow-team-workflow-staging');
        if (fs.existsSync(outputDirectory) && !fs.existsSync(resumeDirectory)) {
          await fs.promises.rename(outputDirectory, resumeDirectory).catch(() => undefined);
          if (fs.existsSync(resumeDirectory)) {
            stagingDirectory = resumeDirectory;
            checkpointReady = true;
          }
        }
      }
      if (stagingDirectory && !checkpointReady) await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (backupDirectory && fs.existsSync(backupDirectory)) {
        const workspaceRoot = ensureWorkspace(workspacePath);
        const { outputDirectory } = teamWorkflowOutput(workspaceRoot, status, projectName);
        if (!fs.existsSync(outputDirectory)) await fs.promises.rename(backupDirectory, outputDirectory).catch(() => undefined);
      }
      return { success: false, cancelled, resumable: Boolean(checkpointReady), operationId: job?.operationId, error: cancelled ? undefined : error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-identity-export', async (_event, workspacePath, status, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const { outputDirectory, manifest } = await readTeamWorkflowManifest(workspaceRoot, status, projectName);
      if (!manifest) throw new Error('请先生成工作流程');
      const group = (manifest.groups || []).find(item => Number(item.week) === Number(request.week) && String(item.identityId || '') === String(request.identityId || ''));
      if (!group?.relativePath) throw new Error('任务文件夹不存在，请重新生成工作流程');
      const availableItems = (group.items || []).filter(item => {
        if (!item.available || !item.relativePath) return false;
        const itemPath = path.resolve(outputDirectory, item.relativePath);
        return isInside(outputDirectory, itemPath) && fs.existsSync(itemPath);
      });
      if (!availableItems.length) throw new Error('本周任务仍在等待上一位返图');
      const groupDirectory = path.resolve(outputDirectory, group.relativePath);
      if (!isInside(outputDirectory, groupDirectory) || !fs.existsSync(groupDirectory)) throw new Error('任务文件夹不存在，请重新生成工作流程');
      return { success: true, count: availableItems.length, path: groupDirectory };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-workflow-return-review-get', async (_event, workspacePath, projectName, status) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const { session } = await readTeamWorkflowReturnReview(workspaceRoot, projectName);
      if (!session || status && String(session.status) !== String(status)) return { success: true, review: null };
      return { success: true, review: presentTeamWorkflowReturnReview(session) };
    } catch (error) {
      return { success: false, review: null, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-workflow-return-review-discard', async (_event, workspacePath, projectName, reviewSessionId) => {
    try {
      const discarded = await discardTeamWorkflowReturnReview(ensureWorkspace(workspacePath), projectName, reviewSessionId);
      return { success: true, discarded };
    } catch (error) {
      return { success: false, discarded: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-workflow-return-review-ignore', async (_event, workspacePath, projectName, reviewSessionId, returnId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const reviewTarget = await readTeamWorkflowReturnReview(workspaceRoot, projectName);
      if (!reviewTarget.session || String(reviewTarget.session.id) !== String(reviewSessionId)) throw new Error('待确认返图批次已经变化，请重新进入项目后继续');
      const ignoredMatch = (reviewTarget.session.result?.matches || []).find(match => String(match.returnId) === String(returnId));
      if (!ignoredMatch || ignoredMatch.accepted) throw new Error('这张返图已经处理或不属于当前审核批次');
      const matches = reviewTarget.session.result.matches.filter(match => String(match.returnId) !== String(returnId));
      const reviewCount = matches.filter(match => !match.accepted).length;
      reviewTarget.session.updatedAt = Date.now();
      reviewTarget.session.result = {
        ...reviewTarget.session.result,
        matches,
        reviewCount,
        ignoredCount: Number(reviewTarget.session.result.ignoredCount || 0) + 1,
      };
      if (reviewCount > 0) {
        await writeTeamWorkflowReturnReview(reviewTarget.sessionPath, reviewTarget.session);
        const ignoredPath = path.resolve(String(ignoredMatch.path || ''));
        if (isInside(reviewTarget.directory, ignoredPath)) await fs.promises.rm(ignoredPath, { force: true });
      } else {
        await discardTeamWorkflowReturnReview(workspaceRoot, projectName, reviewTarget.session.id);
      }
      return { success: true, reviewSessionCompleted: reviewCount === 0 };
    } catch (error) {
      return { success: false, reviewSessionCompleted: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-workflow-return-batch', async (event, workspacePath, projectName, request = {}) => {
    let manifestPath = '';
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      const existingReview = await readTeamWorkflowReturnReview(workspaceRoot, projectName);
      if (existingReview.session) throw new Error('还有一批返图等待确认，请先继续处理或明确放弃该批次');
      const reviewTarget = teamWorkflowReturnReviewTarget(workspaceRoot, projectName);
      await fs.promises.mkdir(reviewTarget.reviewRoot, { recursive: true });
      const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      const candidates = readyTeamWorkflowSubjects(workspace, request.items || []).map(item => {
        const latestPatchPath = item.task.editedPatchPath && fs.existsSync(item.task.editedPatchPath)
          ? item.task.editedPatchPath
          : item.task.patchPath;
        return {
          taskId: item.task.id,
          photoId: item.photoId,
          baseVersionId: item.baseVersionId,
          personIndex: item.personIndex,
          identityId: item.identity.id,
          photoName: item.photoName,
          personName: item.identity.name,
          patchPath: latestPatchPath,
        };
      }).filter(item => item.patchPath && fs.existsSync(item.patchPath));
      if (!candidates.length) throw new Error('当前没有可接收返图的工作流程任务');

      const selectedFiles = await Promise.all((request.returnedFiles || []).map(filePath => mediaService.authorizeInput(String(filePath))));
      const returned = selectedFiles.map((filePath, index) => ({
        returnId: `workflow-return-${index + 1}`,
        path: path.resolve(filePath),
        mediaPath: request.returnedFiles[index],
        sourceName: path.basename(filePath),
      })).filter(item => IMAGE_EXTENSIONS.has(path.extname(item.path).toLowerCase()));
      if (!returned.length) throw new Error('请选择 JPG、PNG、TIFF、HEIC 等返图文件');

      const batchDirectory = path.join(getWorkspaceDataRoot(workspaceRoot), 'team-retouch', 'batches');
      await fs.promises.mkdir(batchDirectory, { recursive: true });
      manifestPath = path.join(batchDirectory, `workflow-return-${crypto.randomUUID()}.json`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ returned, candidates }, null, 2), 'utf8');
      const matched = await pluginService.runJson(
        'team-retouch', ['match-batch', '--manifest', manifestPath], 4 * 60 * 60 * 1000,
        message => {
          if (message?.type !== 'progress' || event.sender.isDestroyed()) return;
          event.sender.send('workspace-team-patch-return-batch-progress', {
            phase: 'matching',
            progress: Math.max(0, Math.min(82, (Number(message.progress) || 0) * .82)),
            message: String(message.message || '正在识别工作流程返图'),
          });
        },
      );

      const accepted = [];
      let handoffFailureCount = 0;
      const highMatches = (matched.matches || []).filter(item => item.confidence === 'high' && item.taskId);
      for (const [index, match] of highMatches.entries()) {
        const extension = path.extname(match.path).toLowerCase();
        const uploadDirectory = path.join(teamDataDirectory(workspaceRoot, match.photoId, match.baseVersionId), 'uploads');
        await fs.promises.mkdir(uploadDirectory, { recursive: true });
        const copiedPath = path.join(uploadDirectory, `${match.taskId}-${crypto.randomUUID()}${extension}`);
        await fs.promises.copyFile(match.path, copiedPath);
        await versionService.updateTeamPatch(workspaceRoot, {
          taskId: match.taskId,
          editedPatchPath: copiedPath,
          status: 'uploaded',
          needsReview: false,
          reviewReason: '',
        });
        await versionService.completeTeamIdentity(workspaceRoot, {
          photoId: match.photoId,
          baseVersionId: match.baseVersionId,
          personIndex: match.personIndex,
          completed: true,
          completionKind: 'returned',
          editedPatchPath: copiedPath,
        });
        await refreshDownstreamWorkflowFiles(workspaceRoot, request.status, projectName, match.taskId, match.personIndex, copiedPath).catch(error => {
          handoffFailureCount += 1;
          writeLog('warn', 'Unable to refresh downstream workflow task file', { projectName, taskId: match.taskId, error: error.message || String(error) });
        });
        accepted.push({ ...match, accepted: true });
        if (!event.sender.isDestroyed()) event.sender.send('workspace-team-patch-return-batch-progress', {
          phase: 'importing',
          progress: 82 + 18 * (index + 1) / Math.max(1, highMatches.length),
          message: `正在归档并完成工作流程任务 ${index + 1}/${highMatches.length}`,
        });
      }
      const acceptedByReturnId = new Map(accepted.map(item => [item.returnId, item]));
      const matches = (matched.matches || []).map(item => acceptedByReturnId.get(item.returnId) || { ...item, accepted: false });
      const acceptedTaskIds = new Set(accepted.map(item => item.taskId));
      const missingTaskCount = candidates.filter(item => !acceptedTaskIds.has(item.taskId)).length;
      const reviewCount = matches.filter(item => !item.accepted).length;
      if (!event.sender.isDestroyed()) event.sender.send('workspace-team-patch-return-batch-progress', {
        phase: 'complete', progress: 100, message: '工作流程批量返图处理完成',
      });
      writeLog('info', 'Team workflow returned images matched', {
        projectName, returnedCount: returned.length, candidateCount: candidates.length,
        acceptedCount: accepted.length, reviewCount,
      });
      let result = {
        success: true,
        matches,
        merges: [],
        returnedCount: returned.length,
        candidateCount: candidates.length,
        acceptedCount: accepted.length,
        reviewCount,
        missingTaskCount,
        mergedCount: 0,
        warning: handoffFailureCount ? `${handoffFailureCount} 张返图已保存，但下一位任务文件生成失败，请重新生成工作流程后继续` : undefined,
      };
      if (reviewCount > 0) {
        if (fs.existsSync(reviewTarget.directory)) throw new Error('待确认返图目录已存在，请重新进入项目后继续处理');
        const reviewSessionId = crypto.randomUUID();
        const stagingDirectory = `${reviewTarget.directory}.staging-${reviewSessionId}`;
        try {
          await fs.promises.mkdir(stagingDirectory, { recursive: false });
          const persistedMatches = [];
          for (const [index, match] of matches.entries()) {
            const sourcePath = path.resolve(String(match.path || ''));
            if (!fs.existsSync(sourcePath) || !IMAGE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) throw new Error(`第 ${index + 1} 张待确认返图文件已失效`);
            const storedName = `${String(match.returnId || index + 1).replace(/[^a-zA-Z0-9_-]/g, '_')}${path.extname(sourcePath).toLowerCase()}`;
            await fs.promises.copyFile(sourcePath, path.join(stagingDirectory, storedName), fs.constants.COPYFILE_EXCL);
            persistedMatches.push({ ...match, path: path.join(reviewTarget.directory, storedName), mediaPath: undefined });
          }
          const session = {
            version: 1,
            id: reviewSessionId,
            projectName: String(projectName),
            status: String(request.status || ''),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            result: { ...result, reviewSessionId, matches: persistedMatches },
          };
          await fs.promises.writeFile(path.join(stagingDirectory, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
          await fs.promises.rename(stagingDirectory, reviewTarget.directory);
          result = presentTeamWorkflowReturnReview(session);
        } catch (error) {
          await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }
      return result;
    } catch (error) {
      writeLog('error', 'Unable to match returned workflow images', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), matches: [], merges: [] };
    } finally {
      if (manifestPath) await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('workspace-team-workflow-return-confirm', async (_event, workspacePath, projectName, request = {}) => {
    let copiedPath = '';
    let warning = '';
    let reviewTarget = null;
    let reviewMatch = null;
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (request.reviewSessionId) {
        reviewTarget = await readTeamWorkflowReturnReview(workspaceRoot, projectName);
        if (!reviewTarget.session || String(reviewTarget.session.id) !== String(request.reviewSessionId)) throw new Error('待确认返图批次已经变化，请重新进入项目后继续');
        if (request.status && String(reviewTarget.session.status) !== String(request.status)) throw new Error('待确认返图批次不属于当前项目状态');
        reviewMatch = (reviewTarget.session.result?.matches || []).find(match => String(match.returnId) === String(request.returnId));
        if (!reviewMatch || reviewMatch.accepted) throw new Error('这张返图已经处理或不属于当前审核批次');
      }
      const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      const [candidate] = readyTeamWorkflowSubjects(workspace, [{
        photoId: request.photoId,
        baseVersionId: request.baseVersionId,
        personIndex: request.personIndex,
        taskId: request.taskId,
        taskOrder: request.taskOrder,
      }]);
      if (!candidate || String(candidate.task.id) !== String(request.taskId)) throw new Error('该候选任务当前不可确认，请刷新工作流程后重试');

      const sourcePath = reviewMatch?.path
        ? path.resolve(reviewMatch.path)
        : path.resolve(await mediaService.authorizeInput(String(request.returnedPath || '')));
      if (!fs.existsSync(sourcePath) || !IMAGE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) throw new Error('返图文件不存在或格式不受支持');
      const uploadDirectory = path.join(teamDataDirectory(workspaceRoot, candidate.photoId, candidate.baseVersionId), 'uploads');
      await fs.promises.mkdir(uploadDirectory, { recursive: true });
      copiedPath = path.join(uploadDirectory, `${candidate.task.id}-${crypto.randomUUID()}${path.extname(sourcePath).toLowerCase()}`);
      await fs.promises.copyFile(sourcePath, copiedPath);
      await versionService.updateTeamPatch(workspaceRoot, {
        taskId: candidate.task.id,
        editedPatchPath: copiedPath,
        status: 'uploaded',
        needsReview: false,
        reviewReason: '',
        assignmentCompletion: { personIndex: candidate.personIndex, completed: true },
      });
      await refreshDownstreamWorkflowFiles(workspaceRoot, request.status, projectName, candidate.task.id, candidate.personIndex, copiedPath).catch(error => {
        warning = `返图已保存，但下一位任务文件生成失败：${error.message || String(error)}`;
        writeLog('warn', 'Unable to refresh downstream workflow task file after visual confirmation', { projectName, taskId: candidate.task.id, error: error.message || String(error) });
      });
      if (reviewTarget?.session && reviewMatch) {
        try {
          const matches = reviewTarget.session.result.matches.map(match => String(match.returnId) === String(request.returnId) ? {
            ...match,
            taskId: candidate.task.id,
            photoId: candidate.photoId,
            baseVersionId: candidate.baseVersionId,
            personIndex: candidate.personIndex,
            identityId: candidate.identity?.id,
            photoName: candidate.photoName,
            personName: candidate.identity?.name,
            patchPath: candidate.task.patchPath,
            matched: true,
            accepted: true,
            confidence: 'manual',
          } : match);
          const reviewCount = matches.filter(match => !match.accepted).length;
          reviewTarget.session.updatedAt = Date.now();
          reviewTarget.session.result = {
            ...reviewTarget.session.result,
            matches,
            acceptedCount: matches.filter(match => match.accepted).length,
            reviewCount,
            missingTaskCount: Math.max(0, Number(reviewTarget.session.result.missingTaskCount || 0) - 1),
          };
          if (reviewCount > 0) await writeTeamWorkflowReturnReview(reviewTarget.sessionPath, reviewTarget.session);
          else await discardTeamWorkflowReturnReview(workspaceRoot, projectName, reviewTarget.session.id);
        } catch (error) {
          warning = [warning, `审核进度保存失败：${error.message || String(error)}`].filter(Boolean).join('；');
          writeLog('warn', 'Unable to persist workflow return review progress', { projectName, reviewSessionId: request.reviewSessionId, error: error.message || String(error) });
        }
      }
      copiedPath = '';
      return { success: true, taskId: candidate.task.id, reviewSessionCompleted: Boolean(reviewTarget?.session && reviewTarget.session.result.reviewCount === 0), warning: warning || undefined };
    } catch (error) {
      if (copiedPath) await fs.promises.rm(copiedPath, { force: true }).catch(() => undefined);
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-team-patches', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const filePath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      const extension = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('团片协作目前支持 JPG、PNG、TIFF、HEIC 等成片格式，不直接处理 RAW 或视频');
      const bundle = await versionService.getMedia(workspaceRoot, { projectName, filePath });
      const patchResult = await versionService.listTeamPatches(workspaceRoot, bundle.photo.id);
      let tasks = patchResult.tasks || [];
      const groups = new Map();
      for (const task of tasks) {
        const base = bundle.versions?.find(version => version.id === task.baseVersionId);
        if (!base || base.fileMissing || !fs.existsSync(base.filePath)) continue;
        const target = deliveryPath(bundle.photo, base.filePath, task.personIndex);
        if (path.resolve(task.patchPath || '') === path.resolve(target) && fs.existsSync(target)) continue;
        const group = groups.get(task.baseVersionId) || [];
        group.push({ task, target });
        groups.set(task.baseVersionId, group);
      }
      for (const [baseVersionId, migrations] of groups) {
          const base = bundle.versions?.find(version => version.id === baseVersionId);
          if (!base || !migrations.length) continue;
          const repairDirectory = teamDataDirectory(workspaceRoot, bundle.photo.id, baseVersionId);
          const manifestPath = path.join(repairDirectory, `restore-${crypto.randomUUID()}.json`);
          try {
            await fs.promises.mkdir(repairDirectory, { recursive: true });
            const restoreTasks = migrations.filter(item => !fs.existsSync(item.target)).map(item => ({ id: item.task.id, crop: item.task.crop, patchPath: item.target }));
            if (restoreTasks.length) {
              await fs.promises.writeFile(manifestPath, JSON.stringify({ tasks: restoreTasks }, null, 2), 'utf8');
              await pluginService.runJson('team-retouch', ['restore', '--input', base.filePath, '--manifest', manifestPath], 60 * 60 * 1000);
            }
            for (const item of migrations) {
              if (!fs.existsSync(item.target)) continue;
              await versionService.updateTeamPatch(workspaceRoot, { taskId: item.task.id, patchPath: item.target });
              tasks = tasks.map(task => task.id === item.task.id ? { ...task, patchPath: item.target } : task);
            }
            writeLog('info', 'Team retouch exports moved beside source image', { projectName, photoId: bundle.photo.id, baseVersionId, count: migrations.length });
          } catch (error) {
            writeLog('warn', 'Unable to restore missing team retouch exports', { projectName, photoId: bundle.photo.id, baseVersionId, error: error.message || String(error) });
          } finally {
            await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
          }
      }
      tasks = tasks.map(task => ({ ...task, patchMissing: !task.patchPath || !fs.existsSync(task.patchPath) }));
      const baseVersionIds = [...new Set([
        bundle.photo?.currentVersionId,
        ...(bundle.versions || []).map(version => version.id),
        ...tasks.map(task => task.baseVersionId),
      ].filter(Boolean))];
      const exclusionResults = await Promise.all(baseVersionIds.map(baseVersionId => versionService.listTeamPersonExclusions(workspaceRoot, {
        projectName, photoId: bundle.photo.id, baseVersionId,
      })));
      const excludedPersonCounts = Object.fromEntries(baseVersionIds.map((baseVersionId, index) => [
        baseVersionId, exclusionResults[index].exclusions?.length || 0,
      ]));
      return { ...bundle, tasks, excludedPersonCounts };
    } catch (error) {
      return { success: false, error: error.message || String(error), versions: [], tasks: [] };
    }
  });
  
  ipcMain.handle('workspace-team-patch-detect', async (event, workspacePath, status, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
      const base = bundle.versions?.find(version => version.id === request.baseVersionId);
      if (!base || base.fileMissing || !fs.existsSync(base.filePath)) throw new Error('基础版本文件不存在');
      if (!IMAGE_EXTENSIONS.has(path.extname(base.filePath).toLowerCase())) throw new Error('团片协作目前不直接处理 RAW 或视频');
      const outputDirectory = path.join(teamDataDirectory(workspaceRoot, request.photoId, request.baseVersionId), 'analysis');
      const exportDirectory = deliveryDirectory(bundle.photo, base.filePath);
      const listedExclusions = request.restoreExcluded ? { exclusions: [] } : await versionService.listTeamPersonExclusions(workspaceRoot, {
        projectName, photoId: request.photoId, baseVersionId: request.baseVersionId,
      });
      const detectionArgs = ['detect', '--input', base.filePath, '--output-dir', outputDirectory, '--delivery-dir', exportDirectory, '--delivery-prefix', deliveryName(bundle.photo, base.filePath), '--excluded-boxes', JSON.stringify((listedExclusions.exclusions || []).map(item => item.bbox))];
      const savedConfig = readSavedConfig();
      const personDetection = savedConfig.componentSettings?.['team-retouch'] || savedConfig.personDetection || {};
      const useGpu = personDetection.useGpu !== false;
      const oversizeCropMode = personDetection.oversizeCropMode === 'expand' ? 'expand' : 'face-centered';
      const requestedMode = 'auto';
      pluginService.requireCapability('team-retouch.detect');
      const detected = await pluginService.runJson(
        'team-retouch',
        [...detectionArgs, '--provider', useGpu ? 'auto' : 'cpu', '--oversize-crop-mode', oversizeCropMode, '--advanced-mode', requestedMode],
        60 * 60 * 1000,
        message => {
          if (message?.type !== 'progress' || event.sender.isDestroyed()) return;
          event.sender.send('workspace-team-patch-detect-progress', {
            photoId: request.photoId,
            baseVersionId: request.baseVersionId,
            progress: Math.max(0, Math.min(100, Number(message.progress) || 0)),
            message: String(message.message || '正在AI识别'),
          });
        },
      );
      const missingExports = (detected.tasks || []).filter(task => !task.patchPath || !fs.existsSync(task.patchPath));
      if (missingExports.length) throw new Error(`切好的图片没有成功保存（缺少 ${missingExports.length} 个文件）`);
      const patchResult = await versionService.replaceTeamPatches(workspaceRoot, {
        photoId: request.photoId,
        baseVersionId: request.baseVersionId,
        tasks: detected.tasks || [],
      });
      if (request.restoreExcluded) await versionService.clearTeamPersonExclusions(workspaceRoot, {
        projectName, photoId: request.photoId, baseVersionId: request.baseVersionId,
      });
      await versionService.registerTeamProjectPhoto(workspaceRoot, { projectName, photoId: request.photoId, baseVersionId: request.baseVersionId });
      queueCleanupArtifacts(workspaceRoot, { teamArtifactPaths: patchResult.artifactPaths || [] }, '清理旧人物检测文件');
      writeLog('info', 'Team retouch people detected', { projectName, photoId: request.photoId, baseVersionId: request.baseVersionId, personCount: detected.personCount || patchResult.tasks.length, workTileCount: patchResult.tasks.length, detector: detected.detector });
      return { success: true, photo: bundle.photo, versions: bundle.versions, tasks: patchResult.tasks, excludedPersonCount: request.restoreExcluded ? 0 : listedExclusions.exclusions?.length || 0, detection: { detector: detected.detector, backend: detected.backend || 'cpu', provider: detected.provider || '', requestedMode: detected.requestedMode || requestedMode, advancedBackend: Boolean(detected.advancedBackend), width: detected.width, height: detected.height, personCount: detected.personCount ?? patchResult.tasks.length, workTileEdge: detected.workTileEdge || 4000, needsReviewCount: detected.needsReviewCount || 0, fallbackReason: detected.fallbackReason || '' } };
    } catch (error) {
      writeLog('error', 'Unable to detect team retouch subjects', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), versions: [], tasks: [] };
    }
  });

  ipcMain.handle('workspace-team-patch-detect-batch', async (event, workspacePath, status, projectName, request = {}) => {
    let manifestPath = '';
    try {
      const relativePaths = [...new Set((request.relativePaths || []).map(value => String(value)))];
      if (!relativePaths.length) throw new Error('请至少选择一张图片');
      const workspaceRoot = ensureWorkspace(workspacePath);
      pluginService.requireCapability('team-retouch.detect');
      const prepared = [];
      for (const relativePath of relativePaths) {
        const filePath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
        if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error(`不支持的图片：${path.basename(filePath)}`);
        const bundle = await versionService.getMedia(workspaceRoot, { projectName, filePath });
        const base = bundle.versions?.find(version => version.id === bundle.photo?.currentVersionId)
          || bundle.versions?.find(version => version.isCurrent)
          || bundle.versions?.at(-1);
        if (!base || base.fileMissing || !fs.existsSync(base.filePath)) throw new Error(`基础版本不存在：${path.basename(filePath)}`);
        const outputDirectory = path.join(teamDataDirectory(workspaceRoot, bundle.photo.id, base.id), 'analysis');
        prepared.push({
          key: relativePath, name: bundle.photo.displayName || path.basename(filePath), relativePath,
          bundle, base,
          engineItem: {
            key: relativePath, name: bundle.photo.displayName || path.basename(filePath), input: base.filePath,
            outputDir: outputDirectory, deliveryDir: deliveryDirectory(bundle.photo, base.filePath),
            deliveryPrefix: deliveryName(bundle.photo, base.filePath),
            excludedBoxes: (await versionService.listTeamPersonExclusions(workspaceRoot, {
              projectName, photoId: bundle.photo.id, baseVersionId: base.id,
            })).exclusions?.map(exclusion => exclusion.bbox) || [],
          },
        });
      }
      const batchDirectory = path.join(getWorkspaceDataRoot(workspaceRoot), 'team-retouch', 'batches');
      await fs.promises.mkdir(batchDirectory, { recursive: true });
      manifestPath = path.join(batchDirectory, `detect-${crypto.randomUUID()}.json`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ items: prepared.map(item => item.engineItem) }, null, 2), 'utf8');
      const savedConfig = readSavedConfig();
      const personDetection = savedConfig.componentSettings?.['team-retouch'] || savedConfig.personDetection || {};
      const useGpu = personDetection.useGpu !== false;
      const oversizeCropMode = personDetection.oversizeCropMode === 'expand' ? 'expand' : 'face-centered';
      const requestedMode = 'auto';
      const detected = await pluginService.runJson(
        'team-retouch',
        ['detect-batch', '--manifest', manifestPath, '--provider', useGpu ? 'auto' : 'cpu', '--oversize-crop-mode', oversizeCropMode, '--advanced-mode', requestedMode],
        4 * 60 * 60 * 1000,
        message => {
          if (message?.type !== 'progress' || event.sender.isDestroyed()) return;
          event.sender.send('workspace-team-patch-detect-batch-progress', {
            itemIndex: Number(message.itemIndex) || 1,
            itemCount: Number(message.itemCount) || prepared.length,
            relativePath: String(message.itemKey || ''),
            itemName: String(message.itemName || ''),
            progress: Math.max(0, Math.min(100, Number(message.progress) || 0)),
            message: String(message.message || '正在AI识别'),
          });
        },
      );
      const byKey = new Map((detected.results || []).map(item => [String(item.key), item]));
      const results = [];
      for (const item of prepared) {
        const result = byKey.get(item.key);
        if (!result?.success) {
          results.push({ relativePath: item.relativePath, name: item.name, success: false, error: result?.error || '未返回识别结果' });
          continue;
        }
        const missingExports = (result.tasks || []).filter(task => !task.patchPath || !fs.existsSync(task.patchPath));
        if (missingExports.length) {
          results.push({ relativePath: item.relativePath, name: item.name, success: false, error: `缺少 ${missingExports.length} 张工作图` });
          continue;
        }
        const patchResult = await versionService.replaceTeamPatches(workspaceRoot, {
          photoId: item.bundle.photo.id, baseVersionId: item.base.id, tasks: result.tasks || [],
        });
        await versionService.registerTeamProjectPhoto(workspaceRoot, { projectName, photoId: item.bundle.photo.id, baseVersionId: item.base.id });
        queueCleanupArtifacts(workspaceRoot, { teamArtifactPaths: patchResult.artifactPaths || [] }, '清理旧人物检测文件');
        results.push({
          relativePath: item.relativePath, name: item.name, success: true,
          photoId: item.bundle.photo.id, baseVersionId: item.base.id,
          personCount: result.personCount || patchResult.tasks.length,
          workTileCount: patchResult.tasks.length,
          deliveryDirectory: item.engineItem.deliveryDir,
          detector: result.detector || '', fallbackReason: result.fallbackReason || '',
        });
      }
      writeLog('info', 'Team retouch batch completed', {
        projectName, count: prepared.length, successCount: results.filter(item => item.success).length,
        persistentBackend: Boolean(detected.persistentBackend),
      });
      return {
        success: results.some(item => item.success), results,
        persistentBackend: Boolean(detected.persistentBackend),
        requestedMode: detected.requestedMode || requestedMode,
        advancedUsedCount: Number(detected.advancedUsedCount) || 0,
        fallbackCount: Number(detected.fallbackCount) || 0,
        error: results.some(item => item.success) ? undefined : '批量识别全部失败',
      };
    } catch (error) {
      writeLog('error', 'Unable to batch detect team retouch subjects', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), results: [] };
    } finally {
      if (manifestPath) await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('workspace-team-patch-update', async (_event, workspacePath, request = {}) => {
    let cropManifestPath = '';
    let croppedPatchPath = '';
    let cropTargetPath = '';
    let cropBackupPath = '';
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      let normalizedCrop;
      if (request.crop !== undefined) {
        if (!request.photoId) throw new Error('缺少图片信息，无法调整工作图范围');
        const patchResult = await versionService.listTeamPatches(workspaceRoot, request.photoId);
        const task = (patchResult.tasks || []).find(item => item.id === request.taskId);
        if (!task) throw new Error('人物工作图不存在');
        if (task.editedPatchPath) throw new Error('已有返图的工作图不能调整范围，请先删除返图');
        normalizedCrop = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(Number(request.crop?.[key]) || 0)]));
        if (normalizedCrop.x < 0 || normalizedCrop.y < 0 || normalizedCrop.width < 1 || normalizedCrop.height < 1) throw new Error('工作图范围无效');
        const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
        const base = (bundle.versions || []).find(version => version.id === task.baseVersionId);
        if (!base || base.fileMissing || !fs.existsSync(base.filePath)) throw new Error('基础图片不存在，无法重新裁图');
        const batchDirectory = path.join(getWorkspaceDataRoot(workspaceRoot), 'team-retouch', 'batches');
        await fs.promises.mkdir(batchDirectory, { recursive: true });
        const token = crypto.randomUUID();
        cropManifestPath = path.join(batchDirectory, `recrop-${token}.json`);
        croppedPatchPath = path.join(batchDirectory, `recrop-${token}.png`);
        await fs.promises.writeFile(cropManifestPath, JSON.stringify({ tasks: [{ ...task, crop: normalizedCrop, patchPath: croppedPatchPath }] }), 'utf8');
        await pluginService.runJson('team-retouch', ['restore', '--input', base.filePath, '--manifest', cropManifestPath], 10 * 60 * 1000);
        cropTargetPath = task.patchPath;
        cropBackupPath = `${task.patchPath}.${crypto.randomUUID()}.photoflow-backup`;
        await fs.promises.rename(cropTargetPath, cropBackupPath);
        await copyFileAtomic(croppedPatchPath, cropTargetPath);
      }
      const payload = {
        taskId: request.taskId,
        ...(request.personName !== undefined ? { personName: String(request.personName).trim().slice(0, 80) || '未命名人物' } : {}),
        ...(request.assignee !== undefined ? { assignee: String(request.assignee).trim().slice(0, 80) } : {}),
        ...(normalizedCrop ? { crop: normalizedCrop } : {}),
        ...(request.needsReview !== undefined ? { needsReview: Boolean(request.needsReview) } : {}),
        ...(request.reviewReason !== undefined ? { reviewReason: String(request.reviewReason).trim().slice(0, 300) } : {}),
      };
      const updated = await versionService.updateTeamPatch(workspaceRoot, payload);
      let workflowRefreshCount = 0;
      let warning;
      if (cropTargetPath) {
        await thumbnailService.invalidateSources([cropTargetPath]).catch(error => {
          writeLog('warn', 'Unable to invalidate recropped team patch thumbnail', { taskId: request.taskId, error: error.message || String(error) });
        });
        try {
          workflowRefreshCount = await refreshWorkflowTaskSourceFiles(workspaceRoot, request.status, request.projectName, request.taskId, cropTargetPath);
        } catch (error) {
          warning = `工作图已重新裁切，但同步到已有工作区失败：${error.message || String(error)}`;
          writeLog('warn', 'Unable to refresh recropped team patch in workflow workspace', { taskId: request.taskId, error: error.message || String(error) });
        }
      }
      if (cropBackupPath) {
        await fs.promises.rm(cropBackupPath, { force: true });
        cropBackupPath = '';
      }
      return { ...updated, workflowRefreshCount, warning };
    } catch (error) {
      if (cropBackupPath && fs.existsSync(cropBackupPath)) {
        if (cropTargetPath) await fs.promises.rm(cropTargetPath, { force: true }).catch(() => undefined);
        await fs.promises.rename(cropBackupPath, cropTargetPath).catch(() => undefined);
        cropBackupPath = '';
      }
      return { success: false, error: error.message || String(error), tasks: [] };
    } finally {
      if (cropManifestPath) await fs.promises.rm(cropManifestPath, { force: true }).catch(() => undefined);
      if (croppedPatchPath) await fs.promises.rm(croppedPatchPath, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('workspace-team-patch-delete', async (_event, workspacePath, request = {}) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      const result = await versionService.deleteTeamPatch(workspaceRoot, { taskId: request.taskId });
      queueCleanupArtifacts(workspaceRoot, { teamArtifactPaths: result.artifactPaths || [] }, '清理已删除的修图任务文件');
      return { success: true, tasks: result.tasks || [], cleanupQueued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error), tasks: [] };
    }
  });

  ipcMain.handle('workspace-team-patch-cleanup', async (_event, workspacePath, request = {}) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
      const base = bundle.versions?.find(version => version.id === request.baseVersionId);
      if (!base) throw new Error('基础版本不存在');
      const result = await versionService.cleanupTeamPatches(workspaceRoot, {
        photoId: request.photoId,
        baseVersionId: request.baseVersionId,
      });
      queueCleanupArtifacts(workspaceRoot, {
        teamArtifactPaths: result.artifactPaths || [],
        teamDataKeys: [{ photoId: request.photoId, baseVersionId: request.baseVersionId }],
      }, '清理团队修图任务文件');
      return { success: true, photo: bundle.photo, versions: bundle.versions, tasks: result.tasks || [], cleanupQueued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error), versions: [], tasks: [] };
    }
  });
  
  ipcMain.handle('workspace-team-patch-upload', async (_event, workspacePath, request = {}) => {
    let copiedPath = '';
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      const patchResult = await versionService.listTeamPatches(workspaceRoot, request.photoId);
      const task = patchResult.tasks.find(item => item.id === request.taskId);
      if (!task) throw new Error('人物修图任务不存在');
      const personIndex = Number(request.personIndex);
      const taskMembers = task.members?.length ? task.members : [{ personIndex: task.personIndex }];
      if (!Number.isInteger(personIndex) || !taskMembers.some(member => Number(member.personIndex) === personIndex)) throw new Error('人物不属于这个修图任务');
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: `上传 ${task.personName} 的修图结果`,
        properties: ['openFile'],
        filters: [{ name: '修图结果', extensions: [...IMAGE_EXTENSIONS].map(value => value.slice(1)) }, { name: '所有文件', extensions: ['*'] }],
      });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, tasks: patchResult.tasks };
      const sourcePath = path.resolve(choice.filePaths[0]);
      if (!IMAGE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) throw new Error('请选择 JPG、PNG、TIFF、HEIC 等图片文件');
      const uploadDirectory = path.join(teamDataDirectory(workspaceRoot, task.photoId, task.baseVersionId), 'uploads');
      await fs.promises.mkdir(uploadDirectory, { recursive: true });
      copiedPath = path.join(uploadDirectory, `${task.id}-${crypto.randomUUID()}${path.extname(sourcePath).toLowerCase()}`);
      await fs.promises.copyFile(sourcePath, copiedPath);
      const updated = await versionService.updateTeamPatch(workspaceRoot, {
        taskId: task.id,
        editedPatchPath: copiedPath,
        status: 'uploaded',
        assignmentCompletion: { personIndex, completed: true },
      });
      let warning = '';
      await refreshDownstreamWorkflowFiles(workspaceRoot, request.status, request.projectName, task.id, personIndex, copiedPath).catch(error => {
        warning = `返图已保存，但下一位任务文件生成失败：${error.message || String(error)}`;
        writeLog('warn', 'Unable to refresh downstream workflow task file', { projectName: request.projectName, taskId: task.id, error: error.message || String(error) });
      });
      // Earlier returns remain immutable history for their exact person node.
      copiedPath = '';
      return { ...updated, warning: warning || undefined };
    } catch (error) {
      if (copiedPath) await fs.promises.rm(copiedPath, { force: true }).catch(() => undefined);
      return { success: false, error: error.message || String(error), tasks: [] };
    }
  });

  ipcMain.handle('workspace-team-patch-remove-upload', async (_event, workspacePath, request = {}) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      const patchResult = await versionService.listTeamPatches(workspaceRoot, request.photoId);
      const task = patchResult.tasks.find(item => item.id === request.taskId);
      if (!task) throw new Error('人物修图任务不存在');
      const personIndex = Number(request.personIndex);
      const taskMembers = task.members?.length ? task.members : [{ personIndex: task.personIndex }];
      if (!Number.isInteger(personIndex) || !taskMembers.some(member => Number(member.personIndex) === personIndex)) throw new Error('人物不属于这个修图任务');
      const workspace = await versionService.getTeamProjectWorkspace(workspaceRoot, request.projectName);
      const assignments = new Map((workspace.assignments || [])
        .filter(item => item.photoId === task.photoId && item.baseVersionId === task.baseVersionId)
        .map(item => [Number(item.personIndex), item]));
      const workflow = await readTeamWorkflowManifest(workspaceRoot, request.status, request.projectName);
      const chain = [];
      for (const [groupIndex, group] of (workflow.manifest?.groups || []).entries()) {
        for (const [itemIndex, item] of (group.items || []).entries()) if (String(item.taskId) === String(task.id)) chain.push({ group, item, groupIndex, itemIndex });
      }
      chain.sort((left, right) => (Number(left.group.week) || 1) - (Number(right.group.week) || 1) || left.groupIndex - right.groupIndex || left.itemIndex - right.itemIndex);
      const targetIndex = chain.findIndex(entry => Number(entry.item.personIndex) === personIndex);
      if (targetIndex < 0) throw new Error('工作流程任务不存在，请重新生成工作流程');
      if (chain.slice(targetIndex + 1).some(entry => assignments.get(Number(entry.item.personIndex))?.completed)) throw new Error('后续人物已经完成，请按倒序先删除后续返图');
      const predecessorPath = chain.slice(0, targetIndex).reverse()
        .map(entry => assignments.get(Number(entry.item.personIndex))?.editedPatchPath)
        .find(filePath => filePath && fs.existsSync(filePath));
      const editedPatchPath = assignments.get(personIndex)?.editedPatchPath || '';
      const updated = await versionService.updateTeamPatch(workspaceRoot, {
        taskId: task.id,
        editedPatchPath: predecessorPath || null,
        status: predecessorPath ? 'uploaded' : 'exported',
        mergedVersionId: null,
        mergeMetrics: {},
        assignmentCompletion: { personIndex, completed: false, completionKind: '' },
      });
      let warning = '';
      await rewindWorkflowFiles(workspaceRoot, request.status, request.projectName, task.id, personIndex, predecessorPath || task.patchPath).catch(error => {
        warning = `返图和完成标记已删除，但同步后续任务文件失败：${error.message || String(error)}`;
        writeLog('warn', 'Unable to restore downstream workflow task file', { projectName: request.projectName, taskId: task.id, error: error.message || String(error) });
      });
      if (editedPatchPath) queueCleanupArtifacts(workspaceRoot, { teamArtifactPaths: [editedPatchPath] }, '清理已移除的修图上传文件');
      writeLog('info', 'Team retouch uploaded patch removed', { photoId: task.photoId, taskId: task.id, cleanupQueued: Boolean(editedPatchPath) });
      return { ...updated, cleanupQueued: Boolean(editedPatchPath), warning: warning || undefined };
    } catch (error) {
      return { success: false, error: error.message || String(error), tasks: [] };
    }
  });

  const mergeTeamPatchPhoto = async (workspaceRoot, projectName, request = {}) => {
    let createdPath = '';
    let manifestPath = '';
    try {
      pluginService.requireCapability('team-retouch.merge');
      const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
      const base = bundle.versions?.find(version => version.id === request.baseVersionId);
      if (!base || base.fileMissing || !fs.existsSync(base.filePath)) throw new Error('基础版本文件不存在');
      const patchResult = await versionService.listTeamPatches(workspaceRoot, request.photoId);
      const tasks = patchResult.tasks.filter(task => task.baseVersionId === base.id && task.editedPatchPath && fs.existsSync(task.editedPatchPath));
      if (!tasks.length) throw new Error('请至少上传一张工作图的修图结果');
      const teamWorkspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);
      const outputProgress = await resolveTeamOutputProgress(workspaceRoot, projectName, request.outputProgressId, (teamWorkspace.photos || []).map(photo => photo.sourcePath));
      if (path.resolve(outputProgress.folderPath).toLocaleLowerCase() === path.resolve(path.dirname(base.filePath)).toLocaleLowerCase()) {
        throw new Error('合成结果不能写回当前来源进度，请选择其他进度');
      }
      const nextNumber = Math.max(-1, ...(bundle.versions || []).map(version => Number(version.versionNumber))) + 1;
      const versionId = crypto.randomUUID();
      const originalStem = cleanVersionName(path.parse(bundle.photo?.originalName || base.filePath).name) || '素材';
      createdPath = uniqueDestination(outputProgress.folderPath, `${originalStem}_多人修图_${nextNumber + 1}.tif`);
      const mergeDirectory = path.join(teamDataDirectory(workspaceRoot, request.photoId, base.id), 'merge');
      await fs.promises.mkdir(mergeDirectory, { recursive: true });
      manifestPath = path.join(mergeDirectory, `merge-${versionId}.json`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ photoId: request.photoId, baseVersionId: base.id, tasks }, null, 2), 'utf8');
      const merged = await pluginService.runJson('team-retouch', ['merge', '--input', base.filePath, '--manifest', manifestPath, '--output', createdPath], 60 * 60 * 1000);
      const versionName = cleanVersionName(request.versionName) || `团片协作合成 ${nextNumber}`;
      const conflictThreshold = Math.max(500, Number(merged.width || 0) * Number(merged.height || 0) * 0.00005);
      const needsReview = Boolean(merged.needsReview) || Number(merged.conflictPixels || 0) > conflictThreshold;
      const note = `由 ${merged.mergedCount} 张人物工作图自动合回原尺寸；重叠冲突像素 ${merged.conflictPixels}（复核阈值 ${Math.round(conflictThreshold)}）；边界评分 ${Number(merged.seamScore || 0).toFixed(2)}`;
      const versionBundle = await versionService.createVersion(workspaceRoot, {
        versionId,
        photoId: request.photoId,
        parentVersionId: base.id,
        versionName,
        versionType: 'team-retouch',
        note,
        status: needsReview ? 'needs-review' : 'draft',
        isFinal: false,
        filePath: createdPath,
      });
      for (const task of tasks) {
        const metrics = merged.metrics?.find(item => item.taskId === task.id) || {};
        await versionService.updateTeamPatch(workspaceRoot, {
          taskId: task.id,
          status: 'merged',
          mergedVersionId: versionId,
          mergeMetrics: metrics,
        });
      }
      const updatedTasks = await versionService.listTeamPatches(workspaceRoot, request.photoId);
      void ensureTrackedVersionThumbnail({ workspaceRoot, photoId: request.photoId, versionId, filePath: createdPath });
      const outputPath = createdPath;
      createdPath = '';
      writeLog('info', 'Team retouch patches merged', { projectName, photoId: request.photoId, versionId, mergedCount: merged.mergedCount, conflictPixels: merged.conflictPixels });
      return { ...versionBundle, tasks: updatedTasks.tasks, merge: { ...merged, outputPath, outputProgressId: outputProgress.id, versionId, needsReview } };
    } catch (error) {
      if (createdPath) await fs.promises.rm(createdPath, { force: true }).catch(() => undefined);
      writeLog('error', 'Unable to merge team retouch patches', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), versions: [], tasks: [] };
    } finally {
      if (manifestPath) await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
    }
  };

  ipcMain.handle('workspace-team-patch-select-returns', async (_event, projectName) => {
    try {
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: `批量提交 ${String(projectName || '')} 的手机修图结果`,
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '修图结果', extensions: [...IMAGE_EXTENSIONS].map(value => value.slice(1)) }, { name: '所有文件', extensions: ['*'] }],
      });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, files: [] };
      return { success: true, files: choice.filePaths.map(filePath => `media-token:${mediaService.grantPath(path.resolve(filePath))}`) };
    } catch (error) {
      return { success: false, error: error.message || String(error), files: [] };
    }
  });

  ipcMain.handle('workspace-team-patch-return-batch', async (event, workspacePath, status, projectName, request = {}) => {
    let manifestPath = '';
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      const relativePaths = [...new Set((request.relativePaths || []).map(value => String(value)))];
      if (!relativePaths.length) throw new Error('请先选择这个项目中需要接收修图的团片');
      const prepared = [];
      const candidates = [];
      for (const relativePath of relativePaths) {
        const filePath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
        const bundle = await versionService.getMedia(workspaceRoot, { projectName, filePath });
        const patchResult = await versionService.listTeamPatches(workspaceRoot, bundle.photo.id);
        let base = bundle.versions?.find(version => version.id === bundle.photo?.currentVersionId)
          || bundle.versions?.find(version => version.isCurrent)
          || bundle.versions?.at(-1);
        let tasks = base ? patchResult.tasks.filter(task => task.baseVersionId === base.id && task.patchPath && fs.existsSync(task.patchPath)) : [];
        if (!tasks.length) {
          const latestTask = [...patchResult.tasks].filter(task => task.patchPath && fs.existsSync(task.patchPath)).sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0];
          base = latestTask ? bundle.versions?.find(version => version.id === latestTask.baseVersionId) : undefined;
          tasks = base ? patchResult.tasks.filter(task => task.baseVersionId === base.id && task.patchPath && fs.existsSync(task.patchPath)) : [];
        }
        if (!base || base.fileMissing || !fs.existsSync(base.filePath)) continue;
        if (!tasks.length) continue;
        const photoName = bundle.photo.displayName || path.basename(filePath);
        prepared.push({ relativePath, photoName, bundle, base, tasks });
        for (const task of tasks) candidates.push({
          taskId: task.id, photoId: bundle.photo.id, baseVersionId: base.id,
          photoName, personName: task.personName, patchPath: task.patchPath,
        });
      }
      if (!candidates.length) throw new Error('所选团片还没有原始工作图，请先完成批量人物识别与裁切');
      const selectedFiles = await Promise.all((request.returnedFiles || []).map(filePath => mediaService.authorizeInput(String(filePath))));
      if (!selectedFiles.length) throw new Error('没有选择手机返回的修图结果');
      const returned = selectedFiles.map((filePath, index) => ({
        returnId: `return-${index + 1}`, path: path.resolve(filePath), sourceName: path.basename(filePath),
      })).filter(item => IMAGE_EXTENSIONS.has(path.extname(item.path).toLowerCase()));
      if (!returned.length) throw new Error('请选择 JPG、PNG、TIFF、HEIC 等图片文件');

      const batchDirectory = path.join(getWorkspaceDataRoot(workspaceRoot), 'team-retouch', 'batches');
      await fs.promises.mkdir(batchDirectory, { recursive: true });
      manifestPath = path.join(batchDirectory, `return-${crypto.randomUUID()}.json`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ returned, candidates }, null, 2), 'utf8');
      const matched = await pluginService.runJson(
        'team-retouch', ['match-batch', '--manifest', manifestPath], 4 * 60 * 60 * 1000,
        message => {
          if (message?.type !== 'progress' || event.sender.isDestroyed()) return;
          event.sender.send('workspace-team-patch-return-batch-progress', {
            phase: 'matching', progress: Math.max(0, Math.min(82, (Number(message.progress) || 0) * 0.82)),
            message: String(message.message || '正在比对返回图片'),
          });
        },
      );

      const acceptedTaskIds = new Set();
      const importedMatches = [];
      const highMatches = (matched.matches || []).filter(item => item.confidence === 'high' && item.taskId);
      for (const [index, match] of highMatches.entries()) {
        const extension = path.extname(match.path).toLowerCase();
        const uploadDirectory = path.join(teamDataDirectory(workspaceRoot, match.photoId, match.baseVersionId), 'uploads');
        await fs.promises.mkdir(uploadDirectory, { recursive: true });
        const copiedPath = path.join(uploadDirectory, `${match.taskId}${extension}`);
        await fs.promises.copyFile(match.path, copiedPath);
        await versionService.updateTeamPatch(workspaceRoot, {
          taskId: match.taskId, editedPatchPath: copiedPath, status: 'uploaded', needsReview: false, reviewReason: '',
        });
        acceptedTaskIds.add(match.taskId);
        importedMatches.push({ ...match, accepted: true });
        if (!event.sender.isDestroyed()) event.sender.send('workspace-team-patch-return-batch-progress', {
          phase: 'importing', progress: 82 + 8 * (index + 1) / highMatches.length,
          message: `正在归档高置信度结果 ${index + 1}/${highMatches.length}`,
        });
      }
      const acceptedByReturnId = new Map(importedMatches.map(item => [item.returnId, item]));
      const matches = (matched.matches || []).map(item => acceptedByReturnId.get(item.returnId) || { ...item, accepted: false });
      const assignedTaskIds = new Set(matches.filter(item => item.taskId).map(item => item.taskId));
      const missingTaskCount = prepared.reduce((count, item) => count + item.tasks.filter(task => !assignedTaskIds.has(task.id) && !(task.editedPatchPath && fs.existsSync(task.editedPatchPath))).length, 0);
      const reviewCount = matches.filter(item => !item.accepted).length + missingTaskCount;

      const merges = [];
      const touchedGroups = prepared.filter(item => item.tasks.some(task => acceptedTaskIds.has(task.id)));
      for (const [index, item] of touchedGroups.entries()) {
        const refreshed = await versionService.listTeamPatches(workspaceRoot, item.bundle.photo.id);
        const baseTasks = refreshed.tasks.filter(task => task.baseVersionId === item.base.id);
        const complete = baseTasks.length > 0 && baseTasks.every(task => task.editedPatchPath && fs.existsSync(task.editedPatchPath));
        if (!complete) {
          merges.push({ photoId: item.bundle.photo.id, photoName: item.photoName, relativePath: item.relativePath, success: false, skipped: true, error: '仍有工作图未可靠匹配' });
          continue;
        }
        if (!event.sender.isDestroyed()) event.sender.send('workspace-team-patch-return-batch-progress', {
          phase: 'merging', progress: 90 + 10 * index / Math.max(1, touchedGroups.length),
          message: `正在合成 ${item.photoName}`,
        });
        const result = await mergeTeamPatchPhoto(workspaceRoot, projectName, {
          photoId: item.bundle.photo.id, baseVersionId: item.base.id, outputProgressId: request.outputProgressId, versionName: '批量回传自动合成',
        });
        merges.push({ photoId: item.bundle.photo.id, photoName: item.photoName, relativePath: item.relativePath, baseVersionId: item.base.id, success: result.success, outputPath: result.merge?.outputPath, versionId: result.merge?.versionId, needsReview: result.merge?.needsReview, error: result.error });
      }
      if (!event.sender.isDestroyed()) event.sender.send('workspace-team-patch-return-batch-progress', { phase: 'complete', progress: 100, message: '批量回传处理完成' });
      writeLog('info', 'Team retouch returned images matched', { projectName, returnedCount: returned.length, candidateCount: candidates.length, acceptedCount: acceptedTaskIds.size, mergedCount: merges.filter(item => item.success).length });
      return {
        success: true, matches, merges, returnedCount: returned.length, candidateCount: candidates.length,
        acceptedCount: acceptedTaskIds.size, reviewCount, missingTaskCount,
        mergedCount: merges.filter(item => item.success).length,
      };
    } catch (error) {
      writeLog('error', 'Unable to match returned team retouch images', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), matches: [], merges: [] };
    } finally {
      if (manifestPath) await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('workspace-team-patch-open', async (_event, filePath) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const target = await mediaService.authorizeInput(filePath);
      const openError = await shell.openPath(target);
      if (openError) throw new Error(openError);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-patch-open-folder', async (_event, filePath) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const target = await mediaService.authorizeInput(filePath);
      const stat = await fs.promises.stat(target);
      const folder = stat.isDirectory() ? target : path.dirname(target);
      const openError = await shell.openPath(folder);
      if (openError) throw new Error(openError);
      return { success: true, path: folder };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-team-patch-merge', async (_event, workspacePath, status, projectName, request = {}) => {
    return mergeTeamPatchPhoto(ensureWorkspace(workspacePath), projectName, request);
  });
};

module.exports = { registerVersionIpc };
