const registerVersionIpc = context => {
  const { Array, Boolean, Error, IMAGE_EXTENSIONS, JSON, Math, Number, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, buildVersionBatchImportKey, cleanVersionName, copyFileAtomic, crypto, dialog, ensureTrackedVersionThumbnail, ensureWorkspace, fs, getProjectPath, getWorkspaceDataRoot, ipcMain, mainWindow, mediaService, path, pluginService, readSavedConfig, recycleBinService, refreshWorkspaceCatalog, resolveProjectEntry, runPythonEventAction, shell, supportedVersionFileKind, thumbnailService, undefined, uniqueDestination, versionService, workspaceCatalogs, writeLog } = context;
  const teamDataDirectory = (workspaceRoot, photoId, baseVersionId) => path.join(getWorkspaceDataRoot(workspaceRoot), 'team-retouch', photoId, baseVersionId);
  const deliveryName = (photo, basePath) => path.parse(photo?.originalName || photo?.displayName || basePath).name;
  const deliveryDirectory = (photo, basePath) => path.join(path.dirname(photo?.originalFilePath || basePath), `${deliveryName(photo, basePath)}_裁切`);
  const deliveryPath = (photo, basePath, personIndex) => path.join(deliveryDirectory(photo, basePath), `${deliveryName(photo, basePath)}_人物${String(personIndex).padStart(2, '0')}.png`);
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
      return { success: false, error: error.message || String(error), progressFolders: [] };
    }
  });

  ipcMain.handle('workspace-selection-baseline-ensure', async (_event, workspacePath, status, projectName) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const folderPath = path.join(projectPath, '图片选片');
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        return { success: true, registered: false, count: 0 };
      }
      const imageFiles = (await fs.promises.readdir(folderPath, { withFileTypes: true }))
        .filter(entry => entry.isFile())
        .filter(entry => IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || RAW_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
      if (!imageFiles.length) return { success: true, registered: false, count: 0 };
      const registered = await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: 'image',
        versionKey: '0',
        displayName: '图片选片（原图）',
        folderPath,
        trackingEnabled: true,
      });
      const baseline = await versionService.registerBatchBaseline(workspaceRoot, {
        projectName,
        folderPath,
        versionName: '图片选片（原图）',
      });
      return { success: true, registered: true, count: imageFiles.length, progressFolder: registered.progressFolder, batch: baseline.batch };
    } catch (error) {
      writeLog('error', 'Unable to ensure selection baseline', { projectName, error: error.message || String(error) });
      return { success: false, registered: false, count: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-final-version-summary', async (_event, workspacePath, projectName) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const result = await versionService.listFinalVersions(workspaceRoot, projectName);
      return {
        success: true,
        count: Number(result.count) || 0,
        availableCount: Number(result.availableCount) || 0,
        missingCount: Number(result.missingCount) || 0,
      };
    } catch (error) {
      return { success: false, count: 0, availableCount: 0, missingCount: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-final-version-browse', async (_event, workspacePath, status, projectName) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const result = await versionService.listFinalVersions(workspaceRoot, projectName);
      const versions = Array.isArray(result.versions) ? result.versions : [];
      const entries = [];
      let unavailableCount = 0;
      for (const version of versions) {
        try {
          const filePath = path.resolve(String(version.filePath || ''));
          const relative = path.relative(projectPath, filePath);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || version.fileMissing) throw new Error('最终版文件不可用');
          const stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) throw new Error('最终版文件不是文件');
          const extension = path.extname(filePath).toLowerCase();
          const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : RAW_EXTENSIONS.has(extension) ? 'raw' : null;
          if (!kind) throw new Error('最终版不是支持的图片');
          entries.push({
            name: path.basename(filePath),
            path: filePath,
            relativePath: relative.replace(/\\/g, '/'),
            kind,
            extension,
            size: stat.size,
            createdAt: stat.birthtimeMs || stat.ctimeMs,
            updatedAt: stat.mtimeMs,
          });
        } catch {
          unavailableCount += 1;
        }
      }
      return { success: true, count: versions.length, availableCount: entries.length, missingCount: unavailableCount, entries };
    } catch (error) {
      return { success: false, count: 0, availableCount: 0, missingCount: 0, entries: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-final-version-export', async (_event, workspacePath, status, projectName) => {
    let folderPath = '';
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const finalResult = await versionService.listFinalVersions(workspaceRoot, projectName);
      const versions = Array.isArray(finalResult.versions) ? finalResult.versions : [];
      if (!versions.length) throw new Error('当前项目还没有标记最终版的图片');
      const missing = versions.filter(version => version.fileMissing || !fs.existsSync(version.filePath));
      if (missing.length) throw new Error(`有 ${missing.length} 个最终版文件已被删除或移动，请先重新定位`);

      const progressResult = await versionService.listProgress(workspaceRoot, projectName);
      const imageRoots = (progressResult.progressFolders || [])
        .filter(progress => progress.mediaKind === 'image' && /^\d+$/.test(progress.versionKey))
        .sort((left, right) => Number(left.versionKey) - Number(right.versionKey));
      const latestRoot = imageRoots.at(-1);
      const versionKey = String((latestRoot ? Number(latestRoot.versionKey) : 0) + 1);
      const displayName = `图片后期_${versionKey}_最终版`;
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      folderPath = path.resolve(projectPath, displayName);
      if (!folderPath.startsWith(projectPath + path.sep)) throw new Error('最终版进度文件夹路径无效');
      if (fs.existsSync(folderPath)) throw new Error(`文件夹“${displayName}”已经存在`);

      await fs.promises.mkdir(folderPath);
      const reserved = new Set();
      const copiedFiles = [];
      for (const version of versions) {
        const sourcePath = await mediaService.authorizeInput(version.filePath);
        const destinationPath = uniqueDestination(folderPath, path.basename(sourcePath), reserved);
        await copyFileAtomic(sourcePath, destinationPath);
        copiedFiles.push(destinationPath);
      }
      const registered = await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: 'image',
        versionKey,
        parentProgressId: latestRoot?.id,
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
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const folderPath = resolveProjectEntry(workspacePath, status, projectName, request.relativePath);
      if (!fs.statSync(folderPath).isDirectory()) throw new Error('版本进度文件夹不存在');
      return await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: request.mediaKind,
        versionKey: request.versionKey,
        parentProgressId: request.parentProgressId,
        displayName: request.displayName || path.basename(folderPath),
        folderPath,
        trackingEnabled: Boolean(request.trackingEnabled),
        progressId: request.progressId,
      });
    } catch (error) {
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
  
  ipcMain.handle('workspace-version-compare-preview', async (_event, workspacePath, status, projectName, referenceRelativePath, sourceRelativePath) => {
    try {
      const folderA = resolveProjectEntry(workspacePath, status, projectName, referenceRelativePath);
      const folderB = resolveProjectEntry(workspacePath, status, projectName, sourceRelativePath);
      if (!fs.statSync(folderA).isDirectory() || !fs.statSync(folderB).isDirectory()) throw new Error('版本对比必须选择两个文件夹');
      if (folderA.toLocaleLowerCase() === folderB.toLocaleLowerCase()) throw new Error('上一版本和新版本不能是同一个文件夹');
      const events = await runPythonEventAction('rename.py', ['--folder_a', folderA, '--folder_b', folderB, '--preview'], 60 * 60 * 1000);
      const preview = events.find(event => event.type === 'preview');
      if (!preview) throw new Error('版本对比没有返回匹配结果');
      return {
        success: true,
        matches: Array.isArray(preview.data?.matches) ? preview.data.matches : [],
        unmatched: Array.isArray(preview.data?.unmatched) ? preview.data.unmatched : [],
        unmatchedReference: Array.isArray(preview.data?.unmatchedReference) ? preview.data.unmatchedReference : [],
      };
    } catch (error) {
      writeLog('error', 'Unable to compare progress version folders', { projectName, referenceRelativePath, sourceRelativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), matches: [], unmatched: [], unmatchedReference: [] };
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
        if (!reference || path.basename(reference) !== reference || !source || path.basename(source) !== source) throw new Error('匹配结果包含无效文件名');
        return {
          reference,
          source,
          target: String(match.target || source),
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
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: '重新定位版本文件',
        properties: ['openFile'],
        filters: [{ name: '图片和视频', extensions: [...new Set([...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS, ...VIDEO_EXTENSIONS])].map(value => value.slice(1)) }, { name: '所有文件', extensions: ['*'] }]
      });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, versions: [] };
      const filePath = path.resolve(choice.filePaths[0]);
      let result = await versionService.relocateVersion(workspaceRoot, {
        versionId: request.versionId,
        filePath,
        force: false,
      });
      if (result.fingerprintMismatch) {
        const confirmation = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '文件内容不一致',
          message: '所选文件与原版本的内容指纹不一致',
          detail: '继续会保留原 Photo ID 和 Version ID，但把该版本标记为“内容已变化”。',
          buttons: ['仍然重新定位', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (confirmation.response !== 0) return { success: true, cancelled: true, versions: [] };
        result = await versionService.relocateVersion(workspaceRoot, {
          versionId: request.versionId,
          filePath,
          force: true,
        });
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
      await removeCleanupArtifacts(workspaceRoot, result);
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
      const removedArtifactCount = await removeCleanupArtifacts(workspaceRoot, result);
      return { ...result, removedArtifactCount };
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
  
  ipcMain.handle('workspace-team-patches', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const filePath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      const extension = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('多人修脸目前支持 JPG、PNG、TIFF、HEIC 等成片格式，不直接处理 RAW 或视频');
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
      return { ...bundle, tasks };
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
      if (!IMAGE_EXTENSIONS.has(path.extname(base.filePath).toLowerCase())) throw new Error('多人修脸目前不直接处理 RAW 或视频');
      const outputDirectory = path.join(teamDataDirectory(workspaceRoot, request.photoId, request.baseVersionId), 'analysis');
      const exportDirectory = deliveryDirectory(bundle.photo, base.filePath);
      const detectionArgs = ['detect', '--input', base.filePath, '--output-dir', outputDirectory, '--delivery-dir', exportDirectory, '--delivery-prefix', deliveryName(bundle.photo, base.filePath)];
      const personDetection = readSavedConfig().personDetection || {};
      const useGpu = personDetection.useGpu !== false;
      const oversizeCropMode = personDetection.oversizeCropMode === 'expand' ? 'expand' : 'face-centered';
      pluginService.requireCapability('team-retouch.detect');
      const detected = await pluginService.runJson(
        'team-retouch',
        [...detectionArgs, '--provider', useGpu ? 'auto' : 'cpu', '--oversize-crop-mode', oversizeCropMode],
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
      await removeCleanupArtifacts(workspaceRoot, { teamArtifactPaths: patchResult.artifactPaths || [] });
      writeLog('info', 'Team retouch people detected', { projectName, photoId: request.photoId, baseVersionId: request.baseVersionId, personCount: detected.personCount || patchResult.tasks.length, workTileCount: patchResult.tasks.length, detector: detected.detector });
      return { success: true, photo: bundle.photo, versions: bundle.versions, tasks: patchResult.tasks, detection: { detector: detected.detector, backend: detected.backend || 'cpu', provider: detected.provider || '', width: detected.width, height: detected.height, personCount: detected.personCount || patchResult.tasks.length, workTileEdge: detected.workTileEdge || 4000, needsReviewCount: detected.needsReviewCount || 0, fallbackReason: detected.fallbackReason || '' } };
    } catch (error) {
      writeLog('error', 'Unable to detect team retouch subjects', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), versions: [], tasks: [] };
    }
  });

  ipcMain.handle('workspace-team-patch-detect-batch', async (event, workspacePath, status, projectName, request = {}) => {
    let manifestPath = '';
    try {
      const relativePaths = [...new Set((request.relativePaths || []).map(value => String(value)))];
      if (relativePaths.length < 2) throw new Error('批量多人修脸至少需要选择两张图片');
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
          },
        });
      }
      const batchDirectory = path.join(getWorkspaceDataRoot(workspaceRoot), 'team-retouch', 'batches');
      await fs.promises.mkdir(batchDirectory, { recursive: true });
      manifestPath = path.join(batchDirectory, `detect-${crypto.randomUUID()}.json`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ items: prepared.map(item => item.engineItem) }, null, 2), 'utf8');
      const personDetection = readSavedConfig().personDetection || {};
      const useGpu = personDetection.useGpu !== false;
      const oversizeCropMode = personDetection.oversizeCropMode === 'expand' ? 'expand' : 'face-centered';
      const detected = await pluginService.runJson(
        'team-retouch',
        ['detect-batch', '--manifest', manifestPath, '--provider', useGpu ? 'auto' : 'cpu', '--oversize-crop-mode', oversizeCropMode],
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
        await removeCleanupArtifacts(workspaceRoot, { teamArtifactPaths: patchResult.artifactPaths || [] });
        results.push({
          relativePath: item.relativePath, name: item.name, success: true,
          photoId: item.bundle.photo.id, baseVersionId: item.base.id,
          personCount: result.personCount || patchResult.tasks.length,
          workTileCount: patchResult.tasks.length,
        });
      }
      writeLog('info', 'Team retouch batch completed', {
        projectName, count: prepared.length, successCount: results.filter(item => item.success).length,
        persistentBackend: Boolean(detected.persistentBackend),
      });
      return {
        success: results.some(item => item.success), results,
        persistentBackend: Boolean(detected.persistentBackend),
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
    try {
      pluginService.requireCapability('team-retouch.detect');
      const payload = {
        taskId: request.taskId,
        ...(request.personName !== undefined ? { personName: String(request.personName).trim().slice(0, 80) || '未命名人物' } : {}),
        ...(request.assignee !== undefined ? { assignee: String(request.assignee).trim().slice(0, 80) } : {}),
        ...(request.needsReview !== undefined ? { needsReview: Boolean(request.needsReview) } : {}),
        ...(request.reviewReason !== undefined ? { reviewReason: String(request.reviewReason).trim().slice(0, 300) } : {}),
      };
      return await versionService.updateTeamPatch(ensureWorkspace(workspacePath), payload);
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
      const removedArtifactCount = await removeCleanupArtifacts(workspaceRoot, {
        teamArtifactPaths: result.artifactPaths || [],
        teamDataKeys: [{ photoId: request.photoId, baseVersionId: request.baseVersionId }],
      });
      return { success: true, photo: bundle.photo, versions: bundle.versions, tasks: result.tasks || [], removedArtifactCount };
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
      copiedPath = path.join(uploadDirectory, `${task.id}${path.extname(sourcePath).toLowerCase()}`);
      await fs.promises.copyFile(sourcePath, copiedPath);
      const updated = await versionService.updateTeamPatch(workspaceRoot, {
        taskId: task.id,
        editedPatchPath: copiedPath,
        status: 'uploaded',
      });
      copiedPath = '';
      return updated;
    } catch (error) {
      if (copiedPath) await fs.promises.rm(copiedPath, { force: true }).catch(() => undefined);
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
      const nextNumber = Math.max(-1, ...(bundle.versions || []).map(version => Number(version.versionNumber))) + 1;
      const versionId = crypto.randomUUID();
      const versionDirectory = path.dirname(base.filePath);
      const originalStem = cleanVersionName(path.parse(bundle.photo?.originalName || base.filePath).name) || '素材';
      createdPath = uniqueDestination(versionDirectory, `${originalStem}_多人修图_${nextNumber + 1}.tif`);
      const mergeDirectory = path.join(teamDataDirectory(workspaceRoot, request.photoId, base.id), 'merge');
      await fs.promises.mkdir(mergeDirectory, { recursive: true });
      manifestPath = path.join(mergeDirectory, `merge-${versionId}.json`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ photoId: request.photoId, baseVersionId: base.id, tasks }, null, 2), 'utf8');
      const merged = await pluginService.runJson('team-retouch', ['merge', '--input', base.filePath, '--manifest', manifestPath, '--output', createdPath], 60 * 60 * 1000);
      const versionName = cleanVersionName(request.versionName) || `多人修脸合成 ${nextNumber}`;
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
      createdPath = '';
      writeLog('info', 'Team retouch patches merged', { projectName, photoId: request.photoId, versionId, mergedCount: merged.mergedCount, conflictPixels: merged.conflictPixels });
      return { ...versionBundle, tasks: updatedTasks.tasks, merge: { ...merged, needsReview } };
    } catch (error) {
      if (createdPath) await fs.promises.rm(createdPath, { force: true }).catch(() => undefined);
      writeLog('error', 'Unable to merge team retouch patches', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), versions: [], tasks: [] };
    } finally {
      if (manifestPath) await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
    }
  };

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
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: `批量提交 ${projectName} 的手机修图结果`,
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '修图结果', extensions: [...IMAGE_EXTENSIONS].map(value => value.slice(1)) }, { name: '所有文件', extensions: ['*'] }],
      });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, matches: [], merges: [] };
      const returned = choice.filePaths.map((filePath, index) => ({
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
          merges.push({ photoId: item.bundle.photo.id, photoName: item.photoName, success: false, skipped: true, error: '仍有工作图未可靠匹配' });
          continue;
        }
        if (!event.sender.isDestroyed()) event.sender.send('workspace-team-patch-return-batch-progress', {
          phase: 'merging', progress: 90 + 10 * index / Math.max(1, touchedGroups.length),
          message: `正在合成 ${item.photoName}`,
        });
        const result = await mergeTeamPatchPhoto(workspaceRoot, projectName, {
          photoId: item.bundle.photo.id, baseVersionId: item.base.id, versionName: '批量回传自动合成',
        });
        merges.push({ photoId: item.bundle.photo.id, photoName: item.photoName, success: result.success, outputPath: result.merge?.outputPath, needsReview: result.merge?.needsReview, error: result.error });
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

  ipcMain.handle('workspace-team-patch-merge', async (_event, workspacePath, status, projectName, request = {}) => {
    return mergeTeamPatchPhoto(ensureWorkspace(workspacePath), projectName, request);
  });
};

module.exports = { registerVersionIpc };
