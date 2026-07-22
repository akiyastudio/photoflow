const registerVersionIpc = context => {
  const { Array, Boolean, Error, IMAGE_EXTENSIONS, JSON, Math, Number, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, buildVersionBatchImportKey, cleanVersionName, crypto, dialog, ensureTrackedVersionThumbnail, ensureWorkspace, fs, getProjectPath, ipcMain, mainWindow, mediaService, path, pluginService, readSavedConfig, recycleBinService, refreshWorkspaceCatalog, resolveProjectEntry, runPythonEventAction, shell, supportedVersionFileKind, undefined, versionService, workspaceCatalogs, writeLog } = context;

  ipcMain.handle('workspace-version-choose-file', async () => {
    try {
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: '选择新的图片或视频版本',
        properties: ['openFile'],
        filters: [{ name: '图片、RAW 和视频', extensions: [...new Set([...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS, ...VIDEO_EXTENSIONS])].map(value => value.slice(1)) }, { name: '所有文件', extensions: ['*'] }]
      });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true };
      const filePath = path.resolve(choice.filePaths[0]);
      const kind = supportedVersionFileKind(filePath);
      if (!kind || !(await fs.promises.stat(filePath)).isFile()) throw new Error('请选择可读取的图片、RAW 或视频文件');
      return { success: true, filePath: `media-token:${mediaService.grantPath(filePath)}`, fileName: path.basename(filePath), kind };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
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
      const result = await versionService.commitBatchCompare(workspaceRoot, {
        projectName,
        folderA,
        folderB,
        importKey,
        displayName: cleanVersionName(request.displayName || path.basename(folderB)) || path.basename(folderB),
        renameSources: Boolean(request.renameSources),
        matches,
      });
      writeLog('info', 'Version batch committed', { projectName, folderA, folderB, matchCount: matches.length, batch: result.batch?.sequence });
      return result;
    } catch (error) {
      writeLog('error', 'Unable to commit version batch', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-version-create', async (_event, workspacePath, status, projectName, request = {}) => {
    let createdPath = '';
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
      const parent = bundle.versions?.find(version => version.id === request.parentVersionId);
      if (!parent) throw new Error('基础版本不存在');
      if (parent.fileMissing || !fs.existsSync(parent.filePath)) throw new Error('基础版本文件已丢失，请先重新定位');
  
      let sourcePath = parent.filePath;
      if (request.mode === 'import') {
        if (request.sourceFilePath) sourcePath = await mediaService.authorizeInput(String(request.sourceFilePath));
        else {
          const choice = await dialog.showOpenDialog(mainWindow, {
            title: '选择处理后的图片或视频',
            properties: ['openFile'],
            filters: [{ name: '图片和视频', extensions: [...new Set([...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS, ...VIDEO_EXTENSIONS])].map(value => value.slice(1)) }, { name: '所有文件', extensions: ['*'] }]
          });
          if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, ...bundle };
          sourcePath = path.resolve(choice.filePaths[0]);
        }
      }
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error('选择的版本文件不存在');
      const sourceExtension = path.extname(sourcePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(sourceExtension) && !RAW_EXTENSIONS.has(sourceExtension) && !VIDEO_EXTENSIONS.has(sourceExtension)) throw new Error('选择的文件不是支持的图片或视频');
  
      const nextNumber = Number.isInteger(bundle.nextVersionNumber)
        ? bundle.nextVersionNumber
        : Math.max(-1, ...(bundle.versions || []).map(version => Number(version.versionNumber))) + 1;
      const versionId = crypto.randomUUID();
      const versionDirectory = path.join(projectPath, 'Versions', request.photoId);
      await fs.promises.mkdir(versionDirectory, { recursive: true });
      const suffix = request.mode === 'import' ? sourceExtension : path.extname(parent.filePath);
      const originalStem = cleanVersionName(path.parse(bundle.photo?.originalName || parent.filePath).name) || '素材';
      createdPath = path.join(versionDirectory, `${originalStem}_${nextNumber + 1}${suffix}`);
      if (fs.existsSync(createdPath)) createdPath = path.join(versionDirectory, `${originalStem}_${nextNumber + 1}-${versionId.slice(0, 8)}${suffix}`);
      await fs.promises.copyFile(sourcePath, createdPath, fs.constants.COPYFILE_EXCL);
      const result = await versionService.createVersion(workspaceRoot, {
        versionId,
        photoId: request.photoId,
        parentVersionId: parent.id,
        versionName: cleanVersionName(request.versionName) || `版本 ${nextNumber}`,
        versionType: request.versionType || 'custom',
        note: String(request.note || '').slice(0, 2000),
        author: String(request.author || '').slice(0, 120),
        status: request.status || 'draft',
        isFinal: Boolean(request.isFinal),
        filePath: createdPath,
      });
      void ensureTrackedVersionThumbnail({ workspaceRoot, photoId: request.photoId, versionId, filePath: createdPath });
      createdPath = '';
      writeLog('info', 'Media version created', { projectName, photoId: request.photoId, versionId, versionNumber: nextNumber, mode: request.mode || 'copy' });
      return result;
    } catch (error) {
      if (createdPath) await fs.promises.rm(createdPath, { force: true }).catch(() => undefined);
      writeLog('error', 'Unable to create media version', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), versions: [] };
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
      if (version.thumbnailPath) {
        const thumbnailPath = path.resolve(version.thumbnailPath);
        const expectedName = `${version.id}.jpg`.toLocaleLowerCase();
        const expectedPhotoDirectory = request.photoId.toLocaleLowerCase();
        const isManagedThumbnail = path.basename(thumbnailPath).toLocaleLowerCase() === expectedName
          && path.basename(path.dirname(thumbnailPath)).toLocaleLowerCase() === expectedPhotoDirectory
          && path.basename(path.dirname(path.dirname(thumbnailPath))).toLocaleLowerCase() === 'thumbnails';
        if (isManagedThumbnail) await fs.promises.rm(thumbnailPath, { force: true }).catch(() => undefined);
      }
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
      return { ...bundle, tasks: patchResult.tasks || [] };
    } catch (error) {
      return { success: false, error: error.message || String(error), versions: [], tasks: [] };
    }
  });
  
  ipcMain.handle('workspace-team-patch-detect', async (_event, workspacePath, status, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
      const base = bundle.versions?.find(version => version.id === request.baseVersionId);
      if (!base || base.fileMissing || !fs.existsSync(base.filePath)) throw new Error('基础版本文件不存在');
      if (!IMAGE_EXTENSIONS.has(path.extname(base.filePath).toLowerCase())) throw new Error('多人修脸目前不直接处理 RAW 或视频');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const outputDirectory = path.join(projectPath, 'Patches', request.photoId, request.baseVersionId, 'exports');
      const detectionArgs = ['detect', '--input', base.filePath, '--output-dir', outputDirectory];
      const useGpu = readSavedConfig().personDetection?.useGpu !== false;
      pluginService.requireCapability('team-retouch.detect');
      const detected = await pluginService.runJson('team-retouch', [...detectionArgs, '--provider', useGpu ? 'auto' : 'cpu']);
      const patchResult = await versionService.replaceTeamPatches(workspaceRoot, {
        photoId: request.photoId,
        baseVersionId: request.baseVersionId,
        tasks: detected.tasks || [],
      });
      writeLog('info', 'Team retouch people detected', { projectName, photoId: request.photoId, baseVersionId: request.baseVersionId, count: patchResult.tasks.length, detector: detected.detector });
      return { success: true, photo: bundle.photo, versions: bundle.versions, tasks: patchResult.tasks, detection: { detector: detected.detector, backend: detected.backend || 'cpu', provider: detected.provider || '', width: detected.width, height: detected.height, fallbackReason: detected.fallbackReason || '' } };
    } catch (error) {
      writeLog('error', 'Unable to detect team retouch subjects', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), versions: [], tasks: [] };
    }
  });
  
  ipcMain.handle('workspace-team-patch-update', async (_event, workspacePath, request = {}) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const payload = {
        taskId: request.taskId,
        ...(request.personName !== undefined ? { personName: String(request.personName).trim().slice(0, 80) || '未命名人物' } : {}),
        ...(request.assignee !== undefined ? { assignee: String(request.assignee).trim().slice(0, 80) } : {}),
      };
      return await versionService.updateTeamPatch(ensureWorkspace(workspacePath), payload);
    } catch (error) {
      return { success: false, error: error.message || String(error), tasks: [] };
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
      const uploadDirectory = path.join(path.dirname(path.dirname(task.patchPath)), 'uploads');
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
  
  ipcMain.handle('workspace-team-patch-open', async (_event, filePath) => {
    try {
      pluginService.requireCapability('team-retouch.detect');
      const target = await mediaService.authorizeInput(filePath);
      shell.showItemInFolder(target);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-team-patch-merge', async (_event, workspacePath, status, projectName, request = {}) => {
    let createdPath = '';
    try {
      pluginService.requireCapability('team-retouch.merge');
      const workspaceRoot = ensureWorkspace(workspacePath);
      const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
      const base = bundle.versions?.find(version => version.id === request.baseVersionId);
      if (!base || base.fileMissing || !fs.existsSync(base.filePath)) throw new Error('基础版本文件不存在');
      const patchResult = await versionService.listTeamPatches(workspaceRoot, request.photoId);
      const tasks = patchResult.tasks.filter(task => task.baseVersionId === base.id && task.editedPatchPath && fs.existsSync(task.editedPatchPath));
      if (!tasks.length) throw new Error('请至少上传一个人物的修图结果');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const nextNumber = Math.max(-1, ...(bundle.versions || []).map(version => Number(version.versionNumber))) + 1;
      const versionId = crypto.randomUUID();
      const versionDirectory = path.join(projectPath, 'Versions', request.photoId);
      await fs.promises.mkdir(versionDirectory, { recursive: true });
      createdPath = path.join(versionDirectory, `v${String(nextNumber).padStart(3, '0')}.tif`);
      if (fs.existsSync(createdPath)) throw new Error(`版本文件已存在：${path.basename(createdPath)}`);
      const mergeDirectory = path.join(projectPath, 'Patches', request.photoId, base.id);
      await fs.promises.mkdir(mergeDirectory, { recursive: true });
      const manifestPath = path.join(mergeDirectory, `merge-${versionId}.json`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ photoId: request.photoId, baseVersionId: base.id, tasks }, null, 2), 'utf8');
      const merged = await pluginService.runJson('team-retouch', ['merge', '--input', base.filePath, '--manifest', manifestPath, '--output', createdPath], 60 * 60 * 1000);
      const versionName = cleanVersionName(request.versionName) || `多人修脸合成 ${nextNumber}`;
      const conflictThreshold = Math.max(500, Number(merged.width || 0) * Number(merged.height || 0) * 0.00005);
      const needsReview = Number(merged.conflictPixels || 0) > conflictThreshold;
      const note = `由 ${merged.mergedCount} 个人物 Patch 自动回拼；重叠冲突像素 ${merged.conflictPixels}（复核阈值 ${Math.round(conflictThreshold)}）；边界评分 ${Number(merged.seamScore || 0).toFixed(2)}`;
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
    }
  });
};

module.exports = { registerVersionIpc };
