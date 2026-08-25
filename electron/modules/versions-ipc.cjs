const { registerVersionTrackingIpc } = require('./version-tracking-ipc.cjs');

const registerVersionIpc = context => {
  const { Array, Boolean, Error, IMAGE_EXTENSIONS, JSON, Math, Number, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, backgroundTasks, buildVersionBatchImportKey, cleanVersionName, copyFileAtomic, crypto, dialog, ensureTrackedVersionThumbnail, ensureWorkspace, fs, getProjectPath, getWorkspaceDataRoot, ipcMain, mainWindow, mediaRatingService, mediaScanService, mediaService, path, projectVirtualPaths, recycleBinService, refreshWorkspaceCatalog, releaseWorkspaceWatchPath, resolveProjectEntry, runPythonEventAction, scheduleMediaTrackingScan, supportedVersionFileKind, suppressWorkspaceWatchPath, thumbnailService, versionService, trackingScanService = mediaScanService || versionService, undefined, uniqueDestination, workspaceCatalogs, writeLog } = context;
  const listRatedProjectMedia = projectPath => mediaRatingService.listProject(projectPath);
  const validProgressFolderName = value => Boolean(value && path.basename(value) === value && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value));
  const isValidProgressParent = (folder, mediaKind) => Boolean(folder && !folder.folderMissing
    && folder.mediaKind === mediaKind
    && (folder.nodeRole === 'original' && !folder.artifactKind
      || folder.nodeRole === 'progress' && folder.parentProgressId && folder.relationKind === 'main'));
  const isInside = (root, candidate) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
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
    await thumbnailService.evictCache({ sourcePaths: cleanup.sourcePaths || [] }).catch(error => {
      writeLog('warn', 'Unable to clear deleted version thumbnail cache', { error: error.message || String(error) });
    });
    return removed.size;
  };

  const queueCleanupArtifacts = (workspaceRoot, cleanup = {}, title = '清理版本内部文件', restartTask = null) => {
    const snapshot = {
      deletedVersions: [...(cleanup.deletedVersions || [])],
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
      ...(restartTask?.id ? { id: restartTask.id } : {}),
      type: 'internal-artifact-cleanup',
      title,
      dedupeKey,
      cancellable: false,
      metadata: { workspaceRoot, snapshot, title },
    }, execute, run);
    if (restartTask?.id) return run();
    setTimeout(() => void run().catch(error => writeLog('warn', 'Deferred artifact cleanup failed', { error: error.message || String(error) })), 250);
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
      return await versionService.snapshotProgress(workspaceRoot, projectName);
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

  ipcMain.handle('workspace-progress-unregister', async (_event, workspacePath, projectName, progressId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const progress = (listed.progressFolders || []).find(folder => folder.id === String(progressId || ''));
      if (!progress || progress.nodeRole !== 'progress') throw new Error('要取消登记的版本进度不存在或角色不允许');
      return await versionService.unregisterProgress(workspaceRoot, { projectName, progressId: progress.id });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
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
      if (!isValidProgressParent(explicitParent, 'image')) {
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
      const allowed = ['relativePath', 'mediaKind', 'versionKey', 'parentProgressId', 'displayName', 'trackingEnabled', 'trackingState', 'renameFromParent', 'copyMissingFromParent', 'progressId', 'moveToRoot'];
      if (!request || Object.keys(request).some(key => !allowed.includes(key))) {
        throw new Error('progress_payload_invalid: renderer 不能提交节点角色、绝对路径或关系类型');
      }
      const mediaKind = String(request.mediaKind || '');
      const parentProgressId = String(request.parentProgressId || '').trim();
      const progressId = String(request.progressId || '').trim();
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const existing = progressId ? (listed.progressFolders || []).find(folder => folder.id === progressId) : null;
      const parent = (listed.progressFolders || []).find(folder => folder.id === parentProgressId);
      if (!['image', 'video'].includes(mediaKind) || !parentProgressId || !isValidProgressParent(parent, mediaKind)) {
        throw new Error('progress_parent_required: 版本进度必须选择同媒体类型的原始素材或进度父节点');
      }
      if (progressId && (!existing || existing.nodeRole !== 'progress')) {
        throw new Error('progress_target_invalid: 只能更新普通版本进度');
      }
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const resolution = projectVirtualPaths.resolve(projectPath, request.relativePath, { externalRootMode: 'target' });
      let folderPath = resolution.physicalPath;
      let shortcutRelativePath = resolution.viaExternalLink ? resolution.virtualPath : '';
      if (resolution.viaExternalLink && resolution.externalTargetKind !== 'folder') throw new Error('只有文件夹外链可以纳入版本管理');
      if (!fs.statSync(folderPath).isDirectory()) throw new Error('版本进度文件夹不存在');
      if (request.moveToRoot && !shortcutRelativePath && path.dirname(folderPath).toLocaleLowerCase() !== projectPath.toLocaleLowerCase()) {
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
        mediaKind,
        versionKey: request.versionKey,
        parentProgressId,
        displayName: request.displayName || path.basename(folderPath),
        folderPath,
        externalLinkRelativePath: shortcutRelativePath || undefined,
        trackingEnabled: Boolean(request.trackingEnabled),
        trackingState: request.trackingState,
        nodeRole: 'progress',
        relationKind: 'main',
        renameFromParent: Boolean(request.renameFromParent),
        copyMissingFromParent: Boolean(request.copyMissingFromParent),
        progressId: progressId || undefined,
      });
      if (!registered?.success || !registered.progressFolder) throw new Error(registered?.error || '无法登记版本进度');
      return {
        ...registered,
        relativePath: shortcutRelativePath || path.relative(projectPath, folderPath).replace(/\\/g, '/'),
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
      const allowedProgressFields = ['progressId', 'relativePath', 'mediaKind', 'versionKey', 'parentProgressId', 'displayName', 'trackingEnabled', 'trackingState', 'renameFromParent', 'copyMissingFromParent', 'moveToRoot'];
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
      const updatesProgress = Object.entries(progress).some(([key, value]) => key !== 'progressId' && value !== undefined);
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
        const parentProgressId = String(progress.parentProgressId || '').trim();
        const listed = await versionService.listProgress(workspaceRoot, projectName, true);
        const parent = (listed.progressFolders || []).find(folder => folder.id === parentProgressId);
        if (existing && existing.nodeRole !== 'progress') throw new Error('progress_graph_target_invalid: 只能更新普通版本进度');
        if (!validProgressFolderName(displayName) || !['image', 'video'].includes(mediaKind) || !versionKey
          || !parentProgressId || !isValidProgressParent(parent, mediaKind)) {
          throw new Error('progress_graph_payload_invalid: 新进度字段无效');
        }
        let folderResolution = progress.relativePath !== undefined
          ? projectVirtualPaths.resolve(projectPath, String(progress.relativePath || ''), { externalRootMode: 'target' })
          : null;
        let folderPath = folderResolution?.physicalPath
          || (existing?.folderPath ? path.resolve(existing.folderPath) : path.resolve(projectPath, displayName));
        let shortcutRelativePath = '';
        if (folderResolution?.viaExternalLink) {
          if (folderResolution.externalTargetKind !== 'folder') throw new Error('progress_graph_folder_invalid: 只有文件夹外链可以纳入版本管理');
          shortcutRelativePath = folderResolution.virtualPath;
        } else if (existing?.externalLinkRelativePath && progress.relativePath === undefined) {
          shortcutRelativePath = existing.externalLinkRelativePath;
        }
        if (!shortcutRelativePath && !isInside(projectPath, folderPath)) throw new Error('progress_graph_folder_invalid: 进度目录必须位于当前项目内');
        if (!fs.existsSync(folderPath)) {
          if (progress.relativePath !== undefined || existing) throw new Error('progress_graph_folder_invalid: 要登记的文件夹不存在');
          await fs.promises.mkdir(folderPath);
          createdDirectory = folderPath;
        } else if (!fs.statSync(folderPath).isDirectory()) {
          throw new Error(`同名路径不是文件夹：${displayName}`);
        }
        if (progress.moveToRoot && !shortcutRelativePath && path.dirname(folderPath).toLocaleLowerCase() !== projectPath.toLocaleLowerCase()) {
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
          externalLinkRelativePath: shortcutRelativePath || undefined,
          parentProgressId,
          relationKind: 'main',
          trackingEnabled: Boolean(progress.trackingEnabled),
          trackingState: progress.trackingState || undefined,
          renameFromParent: Boolean(progress.renameFromParent),
          copyMissingFromParent: Boolean(progress.copyMissingFromParent),
        };
        databaseProgress.shortcutRelativePath = shortcutRelativePath;
      }
      const shortcutRelativePath = String(databaseProgress.shortcutRelativePath || '');
      delete databaseProgress.shortcutRelativePath;
      const registered = await versionService.registerProgressWithGraph(workspaceRoot, {
        projectName, progress: databaseProgress, workflowInputProgressIds,
      });
      if (!registered?.success || !registered.progressFolder) throw new Error(registered?.error || '进度和工作流关系提交失败');
      const relativePath = shortcutRelativePath || path.relative(projectPath, registered.progressFolder.folderPath).replace(/\\/g, '/');
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
        || !['original', 'companion', 'preview', 'transcode', 'broll'].includes(mode)
        || (mode === 'broll' ? mediaKind !== 'mixed' : !['image', 'video'].includes(mediaKind))
        || mode === 'transcode' && mediaKind !== 'video') {
        throw new Error('media_adopt_payload_invalid: 项目内相对路径和素材类型必填');
      }
      if ((mode === 'original' || mode === 'broll') && sourceProgressId || (mode === 'companion' || mode === 'preview' || mode === 'transcode') && !sourceProgressId) {
        throw new Error('media_adopt_payload_invalid: 来源节点无效');
      }
      const resolution = projectVirtualPaths.resolve(path.resolve(getProjectPath(workspacePath, status, projectName)), relativePath, { externalRootMode: 'target' });
      const folderPath = resolution.physicalPath;
      if (resolution.viaExternalLink && resolution.externalTargetKind !== 'folder') throw new Error('media_adopt_folder_invalid: 只有文件夹外链可以纳入版本树');
      if (!fs.statSync(folderPath).isDirectory()) throw new Error('media_adopt_folder_invalid: 目标必须是文件夹');
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const source = sourceProgressId ? (listed.progressFolders || []).find(folder => folder.id === sourceProgressId) : null;
      if (sourceProgressId && (mode === 'companion'
        ? !source || source.folderMissing || source.mediaKind !== mediaKind || source.nodeRole !== 'original' || source.artifactKind
        : !isValidProgressParent(source, mediaKind))) {
        throw new Error('media_adopt_source_invalid: 来源不属于当前项目');
      }
      return await versionService.adoptMediaFolder(workspaceRoot, {
        projectName, folderPath, mode, mediaKind,
        ...(resolution.viaExternalLink ? { externalLinkRelativePath: resolution.virtualPath } : {}),
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
      const child = (listed.progressFolders || []).find(folder => folder.id === String(request.childProgressId || ''));
      const childProgressId = String(request.childProgressId || '');
      const parentProgressId = request.parentProgressId == null ? null : String(request.parentProgressId);
      if (!projectNodeIds.has(childProgressId) || parentProgressId && !projectNodeIds.has(parentProgressId)) {
        throw new Error('relation_project_mismatch: 父子节点不属于当前项目');
      }
      if (child?.nodeRole === 'progress' && parentProgressId === null) {
        throw new Error('progress_detach_requires_unregister: 断开进度必须显式取消版本登记');
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
      || !['media_companion', 'derived_preview', 'derived_transcode', 'workflow_input'].includes(edgeKind)) {
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
      const action = request.action === 'keep-independent' ? 'keep-independent' : 'connect';
      const projectNodeIds = new Set((listed.progressFolders || []).map(folder => folder.id));
      const repairIds = new Set((listed.legacySelectionRelationRepairs || []).map(repair => repair.progressId));
      if (!repairIds.has(progressId) || !projectNodeIds.has(progressId) || action === 'connect' && !projectNodeIds.has(sourceProgressId)) {
        throw new Error('legacy_selection_repair_project_mismatch: 修复节点不属于当前项目');
      }
      return await versionService.repairLegacySelectionRelation(workspaceRoot, action === 'keep-independent'
        ? { progressId, action }
        : { progressId, sourceProgressId });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-update', async (_event, workspacePath, status, projectName, request = {}) => {
    const completedMoves = [];
    const stagedMoves = [];
    let mutationHandle = null;
    let mutationToken = '';
    let mutationWorkspaceRoot = '';
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      mutationWorkspaceRoot = workspaceRoot;
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      mutationHandle = backgroundTasks?.create?.({
        type: 'version-tree-update',
        title: '修改版本树',
        message: '等待版本比较和其他文件操作完成',
        runningMessage: '正在修改版本树',
        cancellable: false,
        resources: [projectPath],
        concurrencyGroup: 'disk-io',
        concurrencyLimit: 3,
        concurrencyWriteLimit: 2,
        resourceAccess: 'write',
        metadata: { projectName, progressId: String(request.progressId || '') },
      }) || null;
      await mutationHandle?.waitForStart?.();
      const mutation = await versionService.beginProgressTreeUpdate(workspaceRoot, { projectName });
      mutationToken = mutation.mutationToken;
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
      const requestedParentId = String(request.parentProgressId || '').trim();
      if (!requestedParentId) throw new Error('progress_parent_required: 版本进度必须保留有效父节点');
      if (requestedParentId && subtreeIds.has(requestedParentId)) throw new Error('进度不能移动到自己的后代版本下');
      const requestedParent = requestedParentId ? progressFolders.find(progress => progress.id === requestedParentId) : null;
      if (!isValidProgressParent(requestedParent, current.mediaKind)) throw new Error('父版本进度不存在');
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
          folderPath: request.preserveFolderPath || progress.externalLinkRelativePath
            ? path.resolve(progress.folderPath)
            : path.resolve(projectPath, nextDisplayName),
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
        mutationToken,
        primaryProgressId: replacementTarget?.id || current.id,
        replacementProgressId: replacementTarget ? current.id : undefined,
        updates: databaseUpdates,
      });
      // The write reservation above ends with the tree mutation. The deferred
      // project rescan is read-only, so its project-wide read reservation remains
      // compatible with focused version comparisons while still excluding later
      // filesystem writers.
      if (scheduleMediaTrackingScan) setTimeout(() => scheduleMediaTrackingScan(workspaceRoot, projectName, [], true), 250);
      const updatedFolderPath = updates.find(update => update.id === current.id)?.folderPath || current.folderPath;
      mutationToken = '';
      mutationHandle?.complete?.('版本树已更新');
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
      if (mutationToken && mutationWorkspaceRoot) {
        await versionService.finishProgressTreeUpdate(mutationWorkspaceRoot, { projectName, mutationToken }).catch(finishError => {
          writeLog('error', 'Unable to release progress-tree mutation lease', { projectName, error: finishError.message || String(finishError) });
        });
      }
      mutationHandle?.fail?.(error);
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

  registerVersionTrackingIpc({ backgroundTasks, copyFileAtomic, crypto, ensureWorkspace, fs, getWorkspaceDataRoot, ipcMain, path, refreshWorkspaceCatalog, runPythonEventAction, trackingScanService, versionService, workspaceCatalogs, writeLog });
  
  ipcMain.handle('workspace-version-compare-preview', async (_event, workspacePath, status, projectName, referenceRelativePath, sourceRelativePath, sourceNames) => {
    let sourceManifestPath = '';
    try {
      const folderA = resolveProjectEntry(workspacePath, status, projectName, referenceRelativePath);
      const folderB = resolveProjectEntry(workspacePath, status, projectName, sourceRelativePath);
      if (!fs.statSync(folderA).isDirectory() || !fs.statSync(folderB).isDirectory()) throw new Error('版本对比必须选择两个文件夹');
      if (folderA.toLocaleLowerCase() === folderB.toLocaleLowerCase()) throw new Error('上一版本和新版本不能是同一个文件夹');
      const selectedSourceNames = Array.isArray(sourceNames) ? [...new Set(sourceNames.map(value => String(value || '')).filter(value => value && path.basename(value) === value))] : [];
      if (selectedSourceNames.length) {
        const trackingDataDirectory = path.join(getWorkspaceDataRoot(workspacePath), 'version-tracking');
        fs.mkdirSync(trackingDataDirectory, { recursive: true });
        sourceManifestPath = path.join(trackingDataDirectory, `${crypto.randomUUID()}-sources.json`);
        fs.writeFileSync(sourceManifestPath, JSON.stringify(selectedSourceNames), 'utf8');
      }
      writeLog('info', 'Comparing progress version folders', { projectName, folderA, folderB, selectedSourceCount: selectedSourceNames.length });
      const events = await runPythonEventAction('rename.py', ['--folder_a', folderA, '--folder_b', folderB, '--preview', ...(sourceManifestPath ? ['--source_files_file', sourceManifestPath] : [])], 60 * 60 * 1000);
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
    } finally {
      if (sourceManifestPath) {
        try { fs.unlinkSync(sourceManifestPath); } catch {}
      }
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

};

module.exports = { registerVersionIpc };
