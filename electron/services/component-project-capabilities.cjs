const MAX_MEDIA_ITEMS = 2000;

const registerComponentProjectCapabilities = ({
  broker, ensureWorkspace, getWorkspaceDataRoot, getWorkspaceTeamRetouchDatabasePath,
  resolveProjectEntry, versionService, IMAGE_EXTENSIONS, path, fs, crypto, getConfigPath, readSavedConfig,
  dialog, mainWindow, uniqueDestination, ensureTrackedVersionThumbnail,
}) => {
  broker.register('component.storage.v1', (payload, context, descriptor) => {
    if (payload.namespace !== 'domain') throw new Error('Unknown component storage namespace');
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const componentId = String(descriptor.componentId || '');
    const dataRoot = path.join(getWorkspaceDataRoot(workspaceRoot), componentId);
    const databasePath = componentId === 'team-retouch'
      ? getWorkspaceTeamRetouchDatabasePath(workspaceRoot)
      : path.join(getWorkspaceDataRoot(workspaceRoot), 'databases', `${componentId}.sqlite3`);
    return { databasePath, dataRoot };
  });

  broker.register('project.media.read.v1', async (payload, context) => {
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const relativePaths = Array.isArray(payload.relativePaths) ? payload.relativePaths : [];
    const photoIds = Array.isArray(payload.photoIds) ? payload.photoIds : [];
    if (relativePaths.length + photoIds.length > MAX_MEDIA_ITEMS) throw new Error('Too many component media inputs');
    const items = [];
    const seen = new Set();
    for (const value of photoIds) {
      const photoId = String(value || '').trim();
      if (!photoId || seen.has(photoId)) continue;
      const bundle = await versionService.getPhoto(workspaceRoot, photoId);
      if (String(bundle.photo?.projectId || '') !== String(context.projectId || '')) continue;
      seen.add(photoId);
      items.push(bundle);
    }
    for (const value of relativePaths) {
      const relativePath = String(value || '');
      const filePath = resolveProjectEntry(context.workspacePath, context.projectStatus, context.projectName, relativePath);
      if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error(`Unsupported component image input: ${path.basename(filePath)}`);
      const bundle = await versionService.getMedia(workspaceRoot, { projectName: context.projectName, filePath });
      if (String(bundle.photo?.projectId || '') !== String(context.projectId || '')) throw new Error('Component media input is outside the bound project');
      if (seen.has(String(bundle.photo.id))) continue;
      seen.add(String(bundle.photo.id));
      items.push({ ...bundle, relativePath });
    }
    return { items };
  });

  broker.register('component.settings.v1', async (payload, _context, descriptor) => {
    const componentId = String(descriptor.componentId || '');
    if (componentId !== 'team-retouch') throw new Error('Unknown component settings namespace');
    const config = readSavedConfig() || {};
    const legacy = config.personDetection || {};
    const stored = config.componentSettings?.[componentId] || legacy;
    const current = { useGpu: stored.useGpu !== false, oversizeCropMode: stored.oversizeCropMode === 'expand' ? 'expand' : 'face-centered' };
    if (payload.action === 'get') return { success: true, settings: current };
    if (payload.action !== 'update') throw new Error('Unknown component settings action');
    const request = payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings) ? payload.settings : {};
    const settings = { useGpu: request.useGpu !== false, oversizeCropMode: request.oversizeCropMode === 'expand' ? 'expand' : 'face-centered' };
    const next = { ...config, componentSettings: { ...(config.componentSettings || {}), [componentId]: settings } };
    const configPath = getConfigPath();
    const token = crypto.randomUUID();
    const pendingPath = `${configPath}.${token}.tmp`;
    const backupPath = `${configPath}.${token}.backup`;
    let backedUp = false;
    try {
      await fs.promises.writeFile(pendingPath, JSON.stringify(next, null, 2), 'utf8');
      if (fs.existsSync(configPath)) { await fs.promises.rename(configPath, backupPath); backedUp = true; }
      await fs.promises.rename(pendingPath, configPath);
      if (backedUp) await fs.promises.rm(backupPath, { force: true });
    } catch (error) {
      await fs.promises.rm(pendingPath, { force: true }).catch(() => undefined);
      if (backedUp && !fs.existsSync(configPath)) await fs.promises.rename(backupPath, configPath).catch(() => undefined);
      throw error;
    }
    return { success: true, settings };
  });

  broker.register('project.output.authorize.v1', async (payload, context, descriptor) => {
    if (descriptor.componentId !== 'team-retouch') throw new Error('Unknown component output namespace');
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const bundle = await versionService.getPhoto(workspaceRoot, String(payload.photoId || ''));
    if (String(bundle.photo?.projectId || '') !== String(context.projectId || '')) throw new Error('Component output photo is outside the bound project');
    const base = (bundle.versions || []).find(item => String(item.id) === String(payload.baseVersionId || ''));
    if (!base) throw new Error('Component output base version is missing');
    const componentRoot = path.join(getWorkspaceDataRoot(workspaceRoot), descriptor.componentId);
    const operation = String(payload.operation || 'artifacts');
    if (operation === 'artifacts') {
      const stem = path.parse(bundle.photo?.originalName || bundle.photo?.displayName || base.filePath).name;
      return {
        dataDirectory: path.join(componentRoot, String(bundle.photo.id), String(base.id)),
        analysisDirectory: path.join(componentRoot, String(bundle.photo.id), String(base.id), 'analysis'),
        uploadDirectory: path.join(componentRoot, String(bundle.photo.id), String(base.id), 'uploads'),
        mergeDirectory: path.join(componentRoot, String(bundle.photo.id), String(base.id), 'merge'),
        deliveryDirectory: path.join(path.dirname(bundle.photo?.originalFilePath || base.filePath), `${stem}_裁切`),
        deliveryPrefix: stem,
      };
    }
    if (operation !== 'merge') throw new Error('Unknown component output operation');
    if (base.fileMissing || !fs.existsSync(base.filePath)) throw new Error('Component output base version file is missing');
    const listed = await versionService.listProgress(workspaceRoot, context.projectName);
    const progress = (listed.progressFolders || []).find(item => String(item.id) === String(payload.outputProgressId || ''));
    if (!progress || progress.mediaKind !== 'image' || progress.folderMissing || !fs.existsSync(progress.folderPath)) throw new Error('合成结果的目标图片进度不存在');
    const compareProgressKeys = (left, right) => {
      const leftParts = String(left || '').split('_').map(Number); const rightParts = String(right || '').split('_').map(Number);
      for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) if ((leftParts[index] ?? -1) !== (rightParts[index] ?? -1)) return (leftParts[index] ?? -1) - (rightParts[index] ?? -1);
      return 0;
    };
    const sourceDirectory = path.resolve(path.dirname(base.filePath)).toLocaleLowerCase();
    if (path.resolve(progress.folderPath).toLocaleLowerCase() === sourceDirectory) throw new Error('合成结果不能写回当前来源进度');
    const sourceProgress = [...(listed.progressFolders || [])].filter(item => item.mediaKind === 'image' && path.resolve(item.folderPath).toLocaleLowerCase() === sourceDirectory).sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)).at(-1);
    if (sourceProgress && compareProgressKeys(progress.versionKey, sourceProgress.versionKey) <= 0) throw new Error(`合成结果必须保存到高于当前来源 V${sourceProgress.versionKey} 的图片进度`);
    const nextNumber = Math.max(-1, ...(bundle.versions || []).map(version => Number(version.versionNumber))) + 1;
    const originalStem = String(path.parse(bundle.photo?.originalName || base.filePath).name || '素材').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const outputPath = uniqueDestination(progress.folderPath, `${originalStem}_多人修图_${nextNumber + 1}.tif`);
    return { dataDirectory: path.join(componentRoot, String(bundle.photo.id), String(base.id)), mergeDirectory: path.join(componentRoot, String(bundle.photo.id), String(base.id), 'merge'), outputPath, outputProgressId: progress.id, nextNumber };
  });

  broker.register('version.register.v1', async (payload, context) => {
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const bundle = await versionService.getPhoto(workspaceRoot, String(payload.photoId || ''));
    if (String(bundle.photo?.projectId || '') !== String(context.projectId || '')) throw new Error('Version photo is outside the bound project');
    const registered = await versionService.createVersion(workspaceRoot, payload);
    void ensureTrackedVersionThumbnail?.({ workspaceRoot, photoId: payload.photoId, versionId: payload.versionId, filePath: payload.filePath });
    return registered;
  });

  broker.register('dialogs.open.v1', async (payload, _context, descriptor) => {
    if (descriptor.componentId !== 'team-retouch' || payload.kind !== 'image') throw new Error('Unknown component dialog request');
    const choice = await dialog.showOpenDialog(mainWindow, { title: String(payload.title || '选择图片'), properties: ['openFile'], filters: [{ name: '图片', extensions: [...IMAGE_EXTENSIONS].map(value => value.slice(1)) }] });
    if (choice.canceled || !choice.filePaths.length) return { cancelled: true };
    const filePath = path.resolve(choice.filePaths[0]);
    if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('请选择支持的图片文件');
    return { cancelled: false, filePath };
  });

  broker.register('tasks.report.v1', (payload, context, descriptor) => {
    if (descriptor.componentId !== 'team-retouch') throw new Error('Unknown component task namespace');
    const channels = { 'patch.detect.progress': 'workspace-team-patch-detect-progress', 'patch.detect-batch.progress': 'workspace-team-patch-detect-batch-progress' };
    const channel = channels[String(payload.topic || '')];
    if (!channel) throw new Error('Unknown component progress topic');
    const cancelled = Boolean(context.eventSender?.isDestroyed?.());
    if (!cancelled && context.eventSender) context.eventSender.send(channel, payload.value || {});
    return { reported: !cancelled, cancelled };
  });
};

module.exports = { MAX_MEDIA_ITEMS, registerComponentProjectCapabilities };
