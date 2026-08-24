/**
 * @deprecated Team-retouch Component Host V1 compatibility only.
 *
 * This module is intentionally outside the generic host implementation. New
 * components must use the versioned V2 capabilities from
 * services/component-project-capabilities.cjs. Do not add new public methods.
 */
const { DatabaseSync } = require('node:sqlite');

const MAX_MEDIA_ITEMS = 2000;
const componentTaskHandles = new Map();

const insideOrEqual = (path, root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const normalizeRelativePath = value => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
const versionProjectPath = ({ version, projectRoot, projectVirtualPaths, externalLinks = [], path, fs }) => {
  if (!version?.filePath) return { relativePath: '', relativePathState: 'unresolvable' };
  const filePath = path.resolve(String(version.filePath));
  const root = path.resolve(projectRoot);
  if (insideOrEqual(path, root, filePath)) {
    const relativePath = normalizeRelativePath(path.relative(root, filePath));
    if (!relativePath) return { relativePath: '', relativePathState: 'unresolvable' };
    if (!version.fileMissing && fs.existsSync(filePath)) {
      try {
        if (projectVirtualPaths?.resolve) projectVirtualPaths.resolve(root, relativePath, { externalRootMode: 'target' });
        else if (!insideOrEqual(path, fs.realpathSync(root), fs.realpathSync(filePath))) return { relativePath: '', relativePathState: 'outside-project' };
      } catch { return { relativePath: '', relativePathState: 'outside-project' }; }
    }
    return { relativePath, relativePathState: version.fileMissing || !fs.existsSync(filePath) ? 'missing' : 'ready' };
  }
  for (const link of externalLinks) {
    const targetRoot = path.resolve(String(link.externalTargetRoot || ''));
    const targetKind = link.externalTargetKind === 'file' ? 'file' : 'folder';
    const relative = path.relative(targetRoot, filePath);
    const belongs = targetKind === 'file' ? !relative : (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative)));
    if (!belongs) continue;
    let relativePath;
    try {
      relativePath = projectVirtualPaths?.toVirtualPath
        ? normalizeRelativePath(projectVirtualPaths.toVirtualPath(root, filePath, link))
        : [normalizeRelativePath(link.shortcutVirtualPath), targetKind === 'folder' ? normalizeRelativePath(relative) : ''].filter(Boolean).join('/');
    } catch { return { relativePath: '', relativePathState: 'outside-project' }; }
    if (!relativePath) return { relativePath: '', relativePathState: 'unresolvable' };
    if (!version.fileMissing && fs.existsSync(filePath) && projectVirtualPaths?.resolve) {
      try { projectVirtualPaths.resolve(root, relativePath, { externalRootMode: 'target' }); }
      catch { return { relativePath: '', relativePathState: 'outside-project' }; }
    }
    return { relativePath, relativePathState: link.offline || version.fileMissing || !fs.existsSync(filePath) ? 'missing' : 'external' };
  }
  return { relativePath: '', relativePathState: 'outside-project' };
};

const registerDeprecatedTeamRetouchV1Capabilities = ({
  broker, ensureWorkspace, getWorkspaceDataRoot,
  resolveProjectEntry, versionService, IMAGE_EXTENSIONS, path, fs, crypto, getConfigPath, readSavedConfig,
  getProjectPath, dialog, mainWindow, mediaService, shell, backgroundTasks,
  uniqueDestination, ensureTrackedVersionThumbnail, projectVirtualPaths = null, getBoundProject = null,
  RAW_EXTENSIONS = new Set(), IMAGE_PREVIEW_CONVERSION_EXTENSIONS = new Set(),
}) => {
  const boundProject = (workspaceRoot, context) => getBoundProject?.(workspaceRoot, context.projectName) || { id: context.projectId, name: context.projectName, status: context.projectStatus };
  broker.register('component.storage.v1', (payload, context, descriptor) => {
    if (payload.namespace !== 'domain') throw new Error('Unknown component storage namespace');
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const componentId = String(descriptor.componentId || '');
    const dataRoot = path.join(getWorkspaceDataRoot(workspaceRoot), componentId);
    const databasePath = path.join(getWorkspaceDataRoot(workspaceRoot), 'databases', `${componentId}.sqlite3`);
    const project = boundProject(workspaceRoot, context);
    return { databasePath, dataRoot, projectId: String(project?.id || context.projectId || '') };
  });

  broker.register('project.media.read.v1', async (payload, context) => {
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const project = boundProject(workspaceRoot, context);
    const projectRoot = path.resolve(getProjectPath(workspaceRoot, context.projectStatus, context.projectName));
    const externalLinks = projectVirtualPaths?.listManagedExternalLinks?.(projectRoot) || [];
    const withProjectPaths = bundle => ({ ...bundle, versions: (bundle?.versions || []).map(version => ({ ...version, ...versionProjectPath({ version, projectRoot, projectVirtualPaths, externalLinks, path, fs }) })) });
    const relativePaths = Array.isArray(payload.relativePaths) ? payload.relativePaths : [];
    const photoIds = Array.isArray(payload.photoIds) ? payload.photoIds : [];
    if (relativePaths.length + photoIds.length > MAX_MEDIA_ITEMS) throw new Error('Too many component media inputs');
    const items = [];
    const seen = new Set();
    for (const value of photoIds) {
      const photoId = String(value || '').trim();
      if (!photoId || seen.has(photoId)) continue;
      const bundle = await versionService.getPhoto(workspaceRoot, photoId);
      if (String(bundle.photo?.projectId || '') !== String(project?.id || context.projectId || '')) continue;
      seen.add(photoId);
      items.push(withProjectPaths(bundle));
    }
    for (const value of relativePaths) {
      const relativePath = String(value || '');
      const filePath = resolveProjectEntry(context.workspacePath, context.projectStatus, context.projectName, relativePath);
      if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error(`Unsupported component image input: ${path.basename(filePath)}`);
      const bundle = await versionService.getMedia(workspaceRoot, { projectName: context.projectName, filePath });
      if (String(bundle.photo?.projectId || '') !== String(project?.id || context.projectId || '')) throw new Error('Component media input is outside the bound project');
      if (seen.has(String(bundle.photo.id))) continue;
      seen.add(String(bundle.photo.id));
      items.push({ ...withProjectPaths(bundle), relativePath });
    }
    return { items };
  });

  broker.register('project.identity.complete.v1', async (payload, context, descriptor) => {
    if (descriptor.componentId !== 'team-retouch') throw new Error('Unknown component identity namespace');
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const photoId = String(payload.photoId || ''); const baseVersionId = String(payload.baseVersionId || '');
    const bundle = await versionService.getPhoto(workspaceRoot, photoId);
    if (String(bundle?.photo?.projectId || '') !== String(context.projectId || '')) throw new Error('Component identity is outside the bound project');
    if (!(bundle.versions || []).some(version => String(version.id || '') === baseVersionId)) throw new Error('Component identity version is outside the bound photo');
    const personIndex = Number(payload.personIndex);
    if (!Number.isInteger(personIndex) || personIndex < 0) throw new Error('Invalid component identity person index');
    const databasePath = path.join(getWorkspaceDataRoot(workspaceRoot), 'databases', 'team-retouch.sqlite3');
    const db = new DatabaseSync(databasePath);
    try {
      const result = db.prepare(`UPDATE team_person_assignments
        SET completed=?,completion_kind=?,completed_at=?,updated_at=?
        WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`)
        .run(payload.completed === true ? 1 : 0, String(payload.completionKind || '').slice(0, 80), payload.completed === true ? Date.now() : null, Date.now(), String(context.projectId || ''), photoId, baseVersionId, personIndex);
      return { success: true, updatedCount: Number(result.changes) || 0 };
    } finally { db.close(); }
  });

  const componentRoot = (workspaceRoot, componentId) => path.join(getWorkspaceDataRoot(workspaceRoot), componentId);
  const projectKey = context => crypto.createHash('sha256').update(`${context.projectId}\0${context.projectStatus}\0${context.projectName}`).digest('hex');
  const safeStageId = value => {
    const id = String(value || '');
    if (!/^[a-f0-9-]{8,80}$/i.test(id)) throw new Error('Invalid component stage identity');
    return id;
  };
  const inside = (root, candidate) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const workflowScope = context => {
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const projectRoot = path.resolve(getProjectPath(workspaceRoot, context.projectStatus, context.projectName));
    const outputDirectory = path.join(projectRoot, '团片协作');
    if (!inside(projectRoot, outputDirectory)) throw new Error('Invalid component workflow output scope');
    const dataRoot = componentRoot(workspaceRoot, 'team-retouch');
    return {
      outputDirectory,
      manifestPath: path.join(dataRoot, 'workflows', `${crypto.createHash('sha256').update(`${context.projectStatus}\0${context.projectName}`).digest('hex')}.json`),
      reviewDirectory: path.join(dataRoot, 'workflow-return-reviews', crypto.createHash('sha256').update(context.projectName).digest('hex')),
    };
  };

  const authorizeComponentWorkspaceOutput = async (payload, context, descriptor) => {
    if (descriptor.componentId !== 'team-retouch') throw new Error('Unknown component output namespace');
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    if (payload.operation) {
      const bundle = await versionService.getPhoto(workspaceRoot, String(payload.photoId || ''));
      if (String(bundle.photo?.projectId || '') !== String(context.projectId || '')) throw new Error('Component output photo is outside the bound project');
      const base = (bundle.versions || []).find(item => String(item.id) === String(payload.baseVersionId || ''));
      if (!base) throw new Error('Component output base version is missing');
      const componentDataRoot = path.join(getWorkspaceDataRoot(workspaceRoot), descriptor.componentId);
      if (payload.operation === 'artifacts') {
        const stem = path.parse(bundle.photo?.originalName || bundle.photo?.displayName || base.filePath).name;
        return {
          dataDirectory: path.join(componentDataRoot, String(bundle.photo.id), String(base.id)),
          analysisDirectory: path.join(componentDataRoot, String(bundle.photo.id), String(base.id), 'analysis'),
          uploadDirectory: path.join(componentDataRoot, String(bundle.photo.id), String(base.id), 'uploads'),
          mergeDirectory: path.join(componentDataRoot, String(bundle.photo.id), String(base.id), 'merge'),
          deliveryDirectory: path.join(path.dirname(bundle.photo?.originalFilePath || base.filePath), `${stem}_裁切`),
          deliveryPrefix: stem,
        };
      }
      if (payload.operation !== 'merge') throw new Error('Unknown component output operation');
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
      return { dataDirectory: path.join(componentDataRoot, String(bundle.photo.id), String(base.id)), mergeDirectory: path.join(componentDataRoot, String(bundle.photo.id), String(base.id), 'merge'), outputPath, outputProgressId: progress.id, nextNumber };
    }
    if (payload.action === 'workflow') return workflowScope(context);
    if (payload.action === 'stage-inputs') {
      const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
      if (!tokens.length || tokens.length > MAX_MEDIA_ITEMS || tokens.some(token => typeof token !== 'string' || !token.startsWith('media-token:'))) throw new Error('Component inputs require bounded selector tokens');
      const stageId = crypto.randomUUID();
      const stageRoot = path.join(componentRoot(workspaceRoot, descriptor.componentId), 'staging', projectKey(context), stageId);
      await fs.promises.mkdir(stageRoot, { recursive: true });
      const items = [];
      try {
        for (const [index, token] of tokens.entries()) {
          const source = path.resolve(await mediaService.authorizeInput(token));
          const extension = path.extname(source).toLowerCase();
          if (!IMAGE_EXTENSIONS.has(extension)) continue;
          const destination = path.join(stageRoot, `${String(index + 1).padStart(4, '0')}${extension}`);
          await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
          items.push({ id: `input-${index + 1}`, name: path.basename(source), path: destination });
        }
        if (!items.length) throw new Error('No supported component image inputs');
        return { stageId, items };
      } catch (error) {
        await fs.promises.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    if (payload.action === 'discard-stage') {
      const stageRoot = path.join(componentRoot(workspaceRoot, descriptor.componentId), 'staging', projectKey(context), safeStageId(payload.stageId));
      await fs.promises.rm(stageRoot, { recursive: true, force: true });
      return { success: true };
    }
    if (payload.action === 'cleanup-workflow-backup') {
      const name = String(payload.backupName || '');
      if (!/^\.photoflow-team-workflow-previous-[a-f0-9-]{36}$/i.test(name)) throw new Error('Invalid workflow backup cleanup grant');
      const projectRoot = path.resolve(getProjectPath(workspaceRoot, context.projectStatus, context.projectName));
      const target = path.join(projectRoot, name);
      if (!inside(projectRoot, target)) throw new Error('Workflow backup cleanup escapes project');
      const execution = backgroundTasks.start({
        type: 'component-workflow-cleanup', title: '清理旧的团队工作流目录', message: '正在清理旧工作流',
        cancellable: false, resources: [projectRoot], resourceAccess: 'write',
        metadata: { componentId: descriptor.componentId, projectId: context.projectId, backupName: name },
      }, async () => { await fs.promises.rm(target, { recursive: true, force: true }); });
      return { success: true, taskId: execution.task.id };
    }
    if (payload.action) throw new Error('Unknown component output action');
    return null;
  };

  broker.register('project.output.authorize.v1', authorizeComponentWorkspaceOutput);

  const taskMediaRow = (databasePath, projectId, payload) => {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('PRAGMA busy_timeout=30000;');
      return db.prepare(`SELECT t.id,t.patch_path,t.edited_patch_path,
        (SELECT a.edited_patch_path FROM team_person_assignments a WHERE a.project_id=? AND a.photo_id=t.photo_id AND a.base_version_id=t.base_version_id AND a.person_index=? LIMIT 1) AS assignment_edited_path
        FROM team_patch_tasks t WHERE t.id=? AND t.photo_id=? AND t.base_version_id=? AND t.is_deleted=0`)
        .get(String(projectId || ''), Number(payload.personIndex ?? -1), String(payload.taskId || ''), String(payload.photoId || ''), String(payload.baseVersionId || '')) || null;
    } finally { db.close(); }
  };
  const reviewMediaPath = (dataRoot, context, payload) => {
    const directory = path.join(dataRoot, 'workflow-return-reviews', crypto.createHash('sha256').update(String(context.projectName || '')).digest('hex'));
    const sessionPath = path.join(directory, 'session.json');
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (String(session.id || '') !== String(payload.reviewSessionId || '') || String(session.projectName || '') !== String(context.projectName || '')) throw new Error('Component review media is outside the bound project');
    const match = (session.result?.matches || []).find(item => String(item.returnId || '') === String(payload.returnId || ''));
    const candidate = path.resolve(String(match?.path || ''));
    if (!match || !inside(directory, candidate)) throw new Error('Component review media is outside its review session');
    return candidate;
  };
  broker.register('project.media.access.v1', async (payload, context, descriptor) => {
    if (descriptor.componentId !== 'team-retouch') throw new Error('Unknown component media namespace');
    if (!['authorize', 'open'].includes(payload.action)) throw new Error('Unknown component media action');
    if (!['original', 'working', 'returned', 'review-return'].includes(payload.kind)) throw new Error('Unknown component media kind');
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const project = boundProject(workspaceRoot, context);
    const projectRoot = path.resolve(getProjectPath(workspaceRoot, project?.status || context.projectStatus, project?.name || context.projectName));
    const componentDataRoot = path.join(getWorkspaceDataRoot(workspaceRoot), descriptor.componentId);
    let candidate;
    let basePath = null;
    if (payload.kind === 'review-return') candidate = reviewMediaPath(componentDataRoot, context, payload);
    else {
      const bundle = await versionService.getPhoto(workspaceRoot, String(payload.photoId || ''));
      if (String(bundle?.photo?.projectId || '') !== String(project?.id || context.projectId || '')) throw new Error('Component media photo is outside the bound project');
      const base = (bundle.versions || []).find(version => String(version.id || '') === String(payload.baseVersionId || ''));
      if (!base) throw new Error('Component media base version is outside the bound photo');
      const externalLinks = projectVirtualPaths?.listManagedExternalLinks?.(projectRoot) || [];
      basePath = versionProjectPath({ version: base, projectRoot, projectVirtualPaths, externalLinks, path, fs });
      if (!basePath.relativePath || basePath.relativePathState === 'outside-project') throw new Error('Component media base version has no safe project path');
      if (payload.kind === 'original') candidate = path.resolve(base.filePath);
      else {
        const databasePath = path.join(getWorkspaceDataRoot(workspaceRoot), 'databases', `${descriptor.componentId}.sqlite3`);
        const task = taskMediaRow(databasePath, String(project?.id || context.projectId || ''), payload);
        if (!task) throw new Error('Component media task is outside the bound photo version');
        const returnedPath = payload.personIndex !== undefined ? task.assignment_edited_path : task.edited_patch_path;
        candidate = path.resolve(payload.kind === 'returned' ? String(returnedPath || '') : String(task.patch_path || ''));
        if (!candidate || (payload.kind === 'returned' && !returnedPath)) throw new Error('Component returned media is unavailable');
      }
    }
    if (!fs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) throw new Error('Component media file is missing');
    try { await mediaService.authorizeInput(candidate); }
    catch (error) {
      if (!basePath?.relativePath || !projectVirtualPaths?.resolve) throw error;
      const resolution = projectVirtualPaths.resolve(projectRoot, basePath.relativePath, { externalRootMode: 'target' });
      if (!resolution.viaExternalLink || !insideOrEqual(path, resolution.mediaRoot, candidate)) throw error;
      mediaService.grantRoot(resolution.mediaRoot);
      await mediaService.authorizeInput(candidate);
    }
    if (payload.action === 'open') {
      const error = await shell.openPath(candidate);
      if (error) throw new Error(error);
      return { success: true };
    }
    const originalUrl = mediaService.toUrl(candidate, true);
    if (payload.kind !== 'original') return { success: true, url: originalUrl, previewUrl: originalUrl, originalUrl };
    const extension = path.extname(candidate).toLowerCase();
    if (!RAW_EXTENSIONS.has(extension) && !IMAGE_PREVIEW_CONVERSION_EXTENSIONS.has(extension)) return { success: true, url: originalUrl, previewUrl: originalUrl, originalUrl };
    const config = readSavedConfig() || {};
    const thumbnail = await mediaService.requestThumbnail({ filePath: candidate, kind: RAW_EXTENSIONS.has(extension) ? 'raw' : 'image', cacheConfig: config.mediaCache || {}, requestedSize: 1600, priority: 0, queueOrder: 0 });
    const previewUrl = thumbnail?.previewUrl || thumbnail?.mediaUrl;
    if (!previewUrl) throw new Error(thumbnail?.error || 'Component media preview could not be generated');
    return { success: true, url: previewUrl, previewUrl, originalUrl };
  });

  broker.register('dialogs.open.v1', async (payload, context, descriptor) => {
    if (descriptor.componentId !== 'team-retouch') throw new Error('Unknown component dialog namespace');
    if (payload.kind === 'image') {
      const choice = await dialog.showOpenDialog(mainWindow, { title: String(payload.title || '选择图片'), properties: ['openFile'], filters: [{ name: '图片', extensions: [...IMAGE_EXTENSIONS].map(value => value.slice(1)) }] });
      if (choice.canceled || !choice.filePaths.length) return { cancelled: true };
      const filePath = path.resolve(choice.filePaths[0]);
      if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('请选择支持的图片文件');
      return { cancelled: false, filePath };
    }
    if (payload.action === 'select-images') {
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: `选择 ${String(context.projectName || '')} 的返图`, properties: ['openFile', 'multiSelections'],
        filters: [{ name: '修图结果', extensions: [...IMAGE_EXTENSIONS].map(value => value.slice(1)) }],
      });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, tokens: [] };
      return { success: true, tokens: choice.filePaths.slice(0, MAX_MEDIA_ITEMS).map(filePath => `media-token:${mediaService.grantPath(path.resolve(filePath))}`) };
    }
    if (payload.action === 'open-workflow') {
      const scope = workflowScope(context);
      const relativePath = String(payload.relativePath || '').replace(/\\/g, '/');
      const target = path.resolve(scope.outputDirectory, relativePath || '.');
      if (target !== path.resolve(scope.outputDirectory) && !inside(scope.outputDirectory, target)) throw new Error('Component open target escapes workflow output');
      const stat = await fs.promises.stat(target);
      const directory = stat.isDirectory() ? target : path.dirname(target);
      const error = await shell.openPath(directory);
      if (error) throw new Error(error);
      return { success: true };
    }
    throw new Error('Unknown component dialog action');
  });

  broker.register('tasks.report.v1', async (payload, context, descriptor) => {
    if (payload.topic) {
      if (descriptor.componentId !== 'team-retouch') throw new Error('Unknown component task namespace');
      const channels = { 'patch.detect.progress': 'workspace-team-patch-detect-progress', 'patch.detect-batch.progress': 'workspace-team-patch-detect-batch-progress' };
      const channel = channels[String(payload.topic || '')];
      if (!channel) throw new Error('Unknown component progress topic');
      const cancelled = Boolean(context.eventSender?.isDestroyed?.());
      if (!cancelled && context.eventSender) context.eventSender.send(channel, payload.value || {});
      return { reported: !cancelled, cancelled };
    }
    const operationId = String(payload.operationId || '');
    if (payload.action === 'latest') {
      const task = backgroundTasks.list().find(item => item.metadata?.componentId === descriptor.componentId && item.metadata?.projectId === context.projectId && item.type === String(payload.kind || 'workspace-team-workflow')) || null;
      return { task, cancelled: false };
    }
    if (!operationId || operationId.length > 100) throw new Error('Invalid component task operation');
    const key = `${descriptor.componentId}:${context.projectId}:${operationId}`;
    let handle = componentTaskHandles.get(key);
    if (payload.action === 'start') {
      if (!handle || handle.isFinished()) {
        handle = backgroundTasks.create({
          id: `component:${descriptor.componentId}:${operationId}`, type: String(payload.kind || 'component-workflow'),
          title: String(payload.title || '组件任务').slice(0, 120), message: String(payload.message || ''), cancellable: true,
          resumable: true, resumePolicy: 'checkpoint', checkpoint: payload.checkpoint,
          metadata: { componentId: descriptor.componentId, projectId: context.projectId, projectName: context.projectName, operationId },
        });
        await handle.waitForStart();
        componentTaskHandles.set(key, handle);
      }
    } else if (payload.action === 'report') {
      if (!handle) throw new Error('Unknown component task');
      handle.context.report(payload.progress, String(payload.message || ''), { phase: payload.phase, operationId, ...(payload.metadata || {}) });
      if (payload.checkpoint !== undefined) handle.context.saveCheckpoint(payload.checkpoint, payload.progress, String(payload.message || ''), { phase: payload.phase, operationId });
    } else if (payload.action === 'complete') {
      handle?.complete(String(payload.message || '已完成'));
    } else if (payload.action === 'failed') {
      handle?.fail(new Error(String(payload.error || '组件任务失败')));
    } else if (payload.action === 'cancel') {
      if (handle && !handle.isFinished()) backgroundTasks.cancel(handle.task.id);
    } else if (payload.action !== 'status') throw new Error('Unknown component task action');
    const task = handle ? backgroundTasks.get(handle.task.id) || handle.snapshot() : backgroundTasks.list().find(item => item.metadata?.componentId === descriptor.componentId && item.metadata?.projectId === context.projectId && item.metadata?.operationId === operationId) || null;
    if (payload.eventTopic && context.emitComponentEvent) context.emitComponentEvent(String(payload.eventTopic), payload.event || {});
    return { task, cancelled: Boolean(handle?.context.signal.aborted) };
  });

  broker.register('version.register.v1', async (payload, context, descriptor) => {
    if (payload.action !== 'team-return') {
      const workspaceRoot = ensureWorkspace(context.workspacePath);
      const bundle = await versionService.getPhoto(workspaceRoot, String(payload.photoId || ''));
      if (String(bundle.photo?.projectId || '') !== String(context.projectId || '')) throw new Error('Version photo is outside the bound project');
      const registered = await versionService.createVersion(workspaceRoot, payload);
      void ensureTrackedVersionThumbnail?.({ workspaceRoot, photoId: payload.photoId, versionId: payload.versionId, filePath: payload.filePath });
      return registered;
    }
    if (descriptor.componentId !== 'team-retouch' || payload.action !== 'team-return') throw new Error('Unknown component version registration');
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const bundle = await versionService.getPhoto(workspaceRoot, String(payload.photoId || ''));
    if (String(bundle?.photo?.projectId || '') !== String(context.projectId || '')) throw new Error('Component return photo is outside the bound project');
    const databasePath = path.join(getWorkspaceDataRoot(workspaceRoot), 'databases', `${descriptor.componentId}.sqlite3`);
    const task = taskMediaRow(databasePath, String(context.projectId || ''), payload);
    if (!task) throw new Error('Component return task is outside the bound photo version');
    const sourceRoot = payload.reviewSessionId
      ? workflowScope(context).reviewDirectory
      : path.join(componentRoot(workspaceRoot, descriptor.componentId), 'staging', projectKey(context), safeStageId(payload.stageId));
    const source = path.resolve(sourceRoot, String(payload.inputName || ''));
    if (!inside(sourceRoot, source) || !fs.existsSync(source) || !IMAGE_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('Component return input is outside its staging grant');
    if (payload.reviewSessionId) {
      const session = JSON.parse(await fs.promises.readFile(path.join(sourceRoot, 'session.json'), 'utf8'));
      if (String(session.id) !== String(payload.reviewSessionId) || !(session.result?.matches || []).some(item => String(item.returnId) === String(payload.returnId) && path.basename(String(item.path || '')) === path.basename(source))) throw new Error('Component review input is outside its review session');
    }
    const uploadRoot = path.join(componentRoot(workspaceRoot, descriptor.componentId), String(payload.photoId), String(payload.baseVersionId), 'uploads');
    await fs.promises.mkdir(uploadRoot, { recursive: true });
    const destination = path.join(uploadRoot, `${task.id}-${crypto.randomUUID()}${path.extname(source).toLowerCase()}`);
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    try {
      const db = new DatabaseSync(databasePath);
      try {
        db.exec('PRAGMA busy_timeout=30000; BEGIN IMMEDIATE;');
        db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status='uploaded',needs_review=0,review_reason='',updated_at=? WHERE id=?`)
          .run(destination, Date.now(), task.id);
        if (payload.complete) db.prepare(`UPDATE team_person_assignments SET completed=1,completion_kind='returned',edited_patch_path=?,completed_at=?,updated_at=?
          WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`)
          .run(destination, Date.now(), Date.now(), String(context.projectId || ''), String(payload.photoId || ''), String(payload.baseVersionId || ''), Number(payload.personIndex));
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* transaction did not start */ }
        throw error;
      } finally { db.close(); }
      return { success: true, artifactPath: destination };
    } catch (error) {
      await fs.promises.rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
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

};

module.exports = {
  MAX_MEDIA_ITEMS,
  normalizeRelativePath,
  registerDeprecatedTeamRetouchV1Capabilities,
  versionProjectPath,
};
