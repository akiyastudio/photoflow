const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');

const MAX_MEDIA_PAGE_SIZE = 200;
const MAX_INPUT_TOKENS = 2000;
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_INLINE_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_STAGE_BYTES = 2 * 1024 * 1024 * 1024;
const INPUT_TOKEN_TTL_MS = 10 * 60 * 1000;
const CURSOR_TTL_MS = 5 * 60 * 1000;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SAFE_STAGE_ID = /^[a-f0-9-]{16,80}$/i;
const EVENT_TOPIC = /^[a-z][a-z0-9.-]{0,119}\.v[1-9][0-9]*$/;

const inputGrants = new Map();
const listSessions = new Map();
const outputStages = new Map();
const componentTaskHandles = new Map();
const committedOutputs = new Map();
const createdVersions = new Map();

const insideOrEqual = (path, root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const inside = (path, root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const normalizeRelativePath = value => String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '');
const assertRelativePath = (path, value, field = 'relativePath') => {
  const normalized = normalizeRelativePath(value);
  if (!normalized || normalized.length > 1024 || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw hostError(CODES.INVALID_REQUEST, `Invalid ${field}`);
  }
  if (path.isAbsolute(normalized)) throw hostError(CODES.INVALID_REQUEST, `Invalid ${field}`);
  return normalized;
};
const scopeKey = (descriptor, context) => `${descriptor.componentId}\0${context.workspacePath}\0${context.projectId}`;
const boundedObject = (value, maxBytes, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw hostError(CODES.INVALID_REQUEST, `${label} must be an object`);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maxBytes) throw hostError(CODES.LIMIT_EXCEEDED, `${label} is too large`);
  return JSON.parse(serialized);
};
const pruneExpiringMaps = now => {
  for (const [key, value] of inputGrants) if (value.expiresAt <= now) inputGrants.delete(key);
  for (const [key, value] of listSessions) if (value.expiresAt <= now) listSessions.delete(key);
};
const replaceJsonAtomic = async ({ fs, crypto, filePath, value }) => {
  await fs.promises.mkdir(require('path').dirname(filePath), { recursive: true });
  const token = crypto.randomUUID();
  const pending = `${filePath}.${token}.tmp`;
  const backup = `${filePath}.${token}.backup`;
  let backedUp = false;
  await fs.promises.writeFile(pending, JSON.stringify(value, null, 2), 'utf8');
  try {
    if (fs.existsSync(filePath)) { await fs.promises.rename(filePath, backup); backedUp = true; }
    await fs.promises.rename(pending, filePath);
    if (backedUp) await fs.promises.rm(backup, { force: true });
  } catch (error) {
    await fs.promises.rm(pending, { force: true }).catch(() => undefined);
    if (backedUp && !fs.existsSync(filePath)) await fs.promises.rename(backup, filePath).catch(() => undefined);
    throw error;
  }
};
const readJson = async (fs, filePath) => {
  try { return JSON.parse(await fs.promises.readFile(filePath, 'utf8')); } catch { return null; }
};

const registerComponentProjectCapabilities = ({
  broker, ensureWorkspace, getWorkspaceDataRoot, resolveProjectEntry, versionService,
  IMAGE_EXTENSIONS, VIDEO_EXTENSIONS = new Set(), RAW_EXTENSIONS = new Set(),
  path, fs, crypto, getConfigPath, readSavedConfig, getProjectPath, dialog, mainWindow,
  mediaService, backgroundTasks, ensureTrackedVersionThumbnail, getBoundProject = null,
}) => {
  const bound = (context, descriptor) => {
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const project = getBoundProject?.(workspaceRoot, context.projectName) || { id: context.projectId, name: context.projectName, status: context.projectStatus };
    if (!project || String(project.id || '') !== String(context.projectId || '')) throw hostError(CODES.NOT_FOUND, 'Bound project is unavailable');
    const projectRoot = path.resolve(getProjectPath(workspaceRoot, project.status || context.projectStatus, project.name || context.projectName));
    const componentRoot = path.join(getWorkspaceDataRoot(workspaceRoot), 'components', descriptor.componentId);
    return { workspaceRoot, project, projectRoot, componentRoot, key: scopeKey(descriptor, context) };
  };
  const kindFor = filePath => {
    const extension = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) ? 'image' : RAW_EXTENSIONS.has(extension) ? 'raw' : VIDEO_EXTENSIONS.has(extension) ? 'video' : 'file';
  };
  const resolveSafeMedia = async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    if (payload.photoId) {
      const bundle = await versionService.getPhoto(scope.workspaceRoot, String(payload.photoId));
      if (String(bundle?.photo?.projectId || '') !== String(scope.project.id)) throw hostError(CODES.TOKEN_SCOPE, 'Media is outside the bound project');
      const versions = bundle.versions || [];
      const version = payload.versionId
        ? versions.find(item => String(item.id) === String(payload.versionId))
        : versions.find(item => item.isCurrent) || versions.at(-1);
      if (!version) throw hostError(CODES.NOT_FOUND, 'Media version was not found');
      const filePath = path.resolve(String(version.filePath || ''));
      if (!insideOrEqual(path, scope.projectRoot, filePath)) throw hostError(CODES.PERMISSION_DENIED, 'Media version is outside the project content root');
      return { ...scope, bundle, version, filePath };
    }
    const relativePath = assertRelativePath(path, payload.relativePath, 'media relativePath');
    const filePath = path.resolve(resolveProjectEntry(context.workspacePath, context.projectStatus, context.projectName, relativePath));
    if (!insideOrEqual(path, scope.projectRoot, filePath)) throw hostError(CODES.PERMISSION_DENIED, 'Media path escapes the project');
    const bundle = await versionService.getMedia(scope.workspaceRoot, { projectName: context.projectName, filePath });
    if (String(bundle?.photo?.projectId || '') !== String(scope.project.id)) throw hostError(CODES.TOKEN_SCOPE, 'Media is outside the bound project');
    const version = (bundle.versions || []).find(item => path.resolve(String(item.filePath || '')) === filePath)
      || (bundle.versions || []).find(item => item.isCurrent) || (bundle.versions || []).at(-1);
    return { ...scope, bundle, version, filePath, relativePath };
  };
  const grantInput = (filePath, descriptor, context) => {
    pruneExpiringMaps(Date.now());
    if (inputGrants.size >= MAX_INPUT_TOKENS) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many active component input grants');
    const token = `component-input:v2:${crypto.randomUUID()}`;
    const expiresAt = Date.now() + INPUT_TOKEN_TTL_MS;
    inputGrants.set(token, { filePath, scope: scopeKey(descriptor, context), expiresAt, usesRemaining: 1 });
    return { token, expiresAt };
  };
  const consumeInput = (token, descriptor, context, consume = true) => {
    pruneExpiringMaps(Date.now());
    const grant = inputGrants.get(String(token || ''));
    if (!grant) throw hostError(CODES.TOKEN_EXPIRED, 'Component input token is missing or expired');
    if (grant.scope !== scopeKey(descriptor, context)) throw hostError(CODES.TOKEN_SCOPE, 'Component input token belongs to another component or project');
    if (consume && --grant.usesRemaining <= 0) inputGrants.delete(String(token));
    return grant.filePath;
  };

  broker.register('project.media.page.v2', async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    pruneExpiringMaps(Date.now());
    const pageSize = Math.min(MAX_MEDIA_PAGE_SIZE, Math.max(1, Number(payload.pageSize) || 100));
    const requestedKinds = Array.isArray(payload.kinds) ? new Set(payload.kinds.map(String)) : new Set(['image', 'raw', 'video']);
    let session = payload.cursor ? listSessions.get(String(payload.cursor)) : null;
    if (payload.cursor && (!session || session.scope !== scope.key)) throw hostError(CODES.TOKEN_EXPIRED, 'Media page cursor is missing or expired');
    if (!session) {
      const cursor = crypto.randomUUID();
      session = { cursor, scope: scope.key, root: scope.projectRoot, pending: [{ directory: scope.projectRoot, relative: '' }], expiresAt: Date.now() + CURSOR_TTL_MS };
      listSessions.set(cursor, session);
    }
    const items = [];
    let inspected = 0;
    while (session.pending.length && items.length < pageSize && inspected < 1000) {
      const current = session.pending.shift();
      const children = await fs.promises.readdir(current.directory, { withFileTypes: true }).catch(() => []);
      children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      let childIndex = Math.max(0, Number(current.offset) || 0);
      for (; childIndex < children.length; childIndex += 1) {
        const child = children[childIndex];
        if (inspected++ >= 1000) break;
        if (child.isSymbolicLink() || child.name.startsWith('.photoflow-')) continue;
        const candidate = path.join(current.directory, child.name);
        const relativePath = [current.relative, child.name].filter(Boolean).join('/');
        if (child.isDirectory()) { session.pending.push({ directory: candidate, relative: relativePath }); continue; }
        if (!child.isFile()) continue;
        const kind = kindFor(candidate);
        if (!requestedKinds.has(kind)) continue;
        const stat = await fs.promises.stat(candidate);
        items.push({ mediaRef: { relativePath }, relativePath, name: child.name, kind, extension: path.extname(child.name).toLowerCase(), size: stat.size, updatedAt: stat.mtimeMs });
        if (items.length >= pageSize) { childIndex += 1; break; }
      }
      if (childIndex < children.length) session.pending.unshift({ ...current, offset: childIndex });
    }
    const hasMore = session.pending.length > 0;
    session.expiresAt = Date.now() + CURSOR_TTL_MS;
    if (!hasMore) listSessions.delete(session.cursor);
    return { apiVersion: 2, items, page: { hasMore, cursor: hasMore ? session.cursor : null, pageSize } };
  });

  broker.register('project.media.variants.v2', async (payload, context, descriptor) => {
    const media = await resolveSafeMedia(payload, context, descriptor);
    const stat = await fs.promises.lstat(media.filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw hostError(CODES.NOT_FOUND, 'Media file is missing or unsafe');
    mediaService.grantPath(media.filePath);
    const originalUrl = mediaService.toUrl(media.filePath, true);
    const requested = new Set(Array.isArray(payload.variants) ? payload.variants : ['thumbnail', 'preview']);
    if ([...requested].some(value => !['thumbnail', 'preview', 'original'].includes(value))) throw hostError(CODES.INVALID_REQUEST, 'Unknown media variant');
    const result = {};
    const requestVariant = async (name, requestedSize) => {
      const generated = await mediaService.requestThumbnail({ filePath: media.filePath, kind: kindFor(media.filePath), cacheConfig: (readSavedConfig() || {}).mediaCache || {}, requestedSize, priority: 0, queueOrder: 0 });
      const url = generated?.previewUrl || generated?.mediaUrl;
      if (!url || (name === 'thumbnail' && url === originalUrl)) throw hostError(CODES.VARIANT_UNAVAILABLE, `${name} variant could not be generated`);
      result[name] = { url, maxEdge: requestedSize, derived: true };
    };
    if (requested.has('thumbnail')) await requestVariant('thumbnail', 320);
    if (requested.has('preview')) await requestVariant('preview', 1600);
    if (requested.has('original')) result.original = { url: originalUrl, byteLength: stat.size, derived: false };
    const grant = grantInput(media.filePath, descriptor, context);
    return { apiVersion: 2, mediaRef: { photoId: media.bundle?.photo?.id, versionId: media.version?.id, relativePath: media.relativePath }, variants: result, input: grant };
  });

  broker.register('project.input.tokens.v2', async (payload, context, descriptor) => {
    if (payload.action !== 'materialize') throw hostError(CODES.INVALID_REQUEST, 'Unknown input token action');
    const source = consumeInput(payload.token, descriptor, context);
    const scope = bound(context, descriptor);
    const directory = path.join(scope.componentRoot, 'inputs', crypto.randomUUID());
    await fs.promises.mkdir(directory, { recursive: true });
    const destination = path.join(directory, path.basename(source));
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    return { apiVersion: 2, inputId: path.basename(directory), privatePath: destination, byteLength: (await fs.promises.stat(destination)).size };
  });

  broker.register('component.storage.v2', async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    await fs.promises.mkdir(scope.componentRoot, { recursive: true });
    return { apiVersion: 2, dataPath: scope.componentRoot, databasePath: path.join(scope.componentRoot, 'storage.sqlite3'), projectId: String(scope.project.id), ownership: 'component-private' };
  });

  broker.register('component.settings.v2', async (payload, _context, descriptor) => {
    const componentId = String(descriptor.componentId || '');
    const config = readSavedConfig() || {};
    const current = boundedObject(config.componentSettings?.[componentId] || {}, MAX_SETTINGS_BYTES, 'Stored component settings');
    if (payload.action === 'get') return { apiVersion: 2, revision: Number(config.componentSettingsRevisions?.[componentId]) || 0, settings: current };
    if (!['replace', 'merge'].includes(payload.action)) throw hostError(CODES.INVALID_REQUEST, 'Unknown component settings action');
    const request = boundedObject(payload.settings || {}, MAX_SETTINGS_BYTES, 'Component settings');
    const settings = payload.action === 'merge' ? { ...current, ...request } : request;
    boundedObject(settings, MAX_SETTINGS_BYTES, 'Component settings');
    const revision = (Number(config.componentSettingsRevisions?.[componentId]) || 0) + 1;
    const next = { ...config, componentSettings: { ...(config.componentSettings || {}), [componentId]: settings }, componentSettingsRevisions: { ...(config.componentSettingsRevisions || {}), [componentId]: revision } };
    await replaceJsonAtomic({ fs, crypto, filePath: getConfigPath(), value: next });
    return { apiVersion: 2, revision, settings };
  });

  const resolveStage = (payload, context, descriptor) => {
    const id = String(payload.stageId || '');
    if (!SAFE_STAGE_ID.test(id)) throw hostError(CODES.INVALID_REQUEST, 'Invalid output stage id');
    const stage = outputStages.get(id);
    if (!stage) throw hostError(CODES.NOT_FOUND, 'Output stage was not found');
    if (stage.scope !== scopeKey(descriptor, context)) throw hostError(CODES.TOKEN_SCOPE, 'Output stage belongs to another component or project');
    return stage;
  };
  const validateStage = async stage => {
    if (!stage.files.length) throw hostError(CODES.INVALID_REQUEST, 'Output stage is empty');
    let totalBytes = 0;
    for (const file of stage.files) {
      const stat = await fs.promises.lstat(file.stagePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || !inside(path, stage.root, file.stagePath)) throw hostError(CODES.PERMISSION_DENIED, 'Output stage contains an unsafe file');
      const realStageRoot = await fs.promises.realpath(stage.root);
      const realFile = await fs.promises.realpath(file.stagePath);
      if (!inside(path, realStageRoot, realFile)) throw hostError(CODES.PERMISSION_DENIED, 'Output stage escapes through a linked directory');
      totalBytes += stat.size;
      if (totalBytes > MAX_STAGE_BYTES) throw hostError(CODES.LIMIT_EXCEEDED, 'Output stage is too large');
    }
    return { fileCount: stage.files.length, totalBytes };
  };
  broker.register('project.output.v2', async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    if (payload.action === 'stage') {
      const stageId = crypto.randomUUID();
      const root = path.join(scope.componentRoot, 'staging', stageId);
      await fs.promises.mkdir(root, { recursive: true });
      outputStages.set(stageId, { id: stageId, scope: scope.key, root, projectRoot: scope.projectRoot, files: [], createdAt: Date.now(), componentId: descriptor.componentId, projectId: context.projectId });
      return { apiVersion: 2, stageId, privatePath: root, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    }
    if (payload.action === 'commit') {
      const replayKey = String(payload.idempotencyKey || '');
      if (!ID.test(replayKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
      const replay = committedOutputs.get(`${scope.key}\0${replayKey}`);
      if (replay) return replay;
      const receiptPath = path.join(scope.componentRoot, 'receipts', `commit-${crypto.createHash('sha256').update(`${context.projectId}\0${replayKey}`).digest('hex')}.json`);
      const receipt = await readJson(fs, receiptPath);
      if (receipt?.idempotencyKey === replayKey && receipt?.projectId === String(context.projectId)) {
        const restored = { apiVersion: 2, commitId: receipt.commitId, idempotencyKey: replayKey, outputs: receipt.outputs };
        committedOutputs.set(`${scope.key}\0${replayKey}`, restored);
        committedOutputs.set(restored.commitId, { ...restored, scope: scope.key });
        return restored;
      }
    }
    if (payload.action === 'rollback') {
      const stageId = String(payload.stageId || '');
      if (!SAFE_STAGE_ID.test(stageId)) throw hostError(CODES.INVALID_REQUEST, 'Invalid output stage id');
      const existingStage = outputStages.get(stageId);
      if (!existingStage) return { apiVersion: 2, stageId, rolledBack: true };
      if (existingStage.scope !== scope.key) throw hostError(CODES.TOKEN_SCOPE, 'Output stage belongs to another component or project');
    }
    const stage = resolveStage(payload, context, descriptor);
    if (payload.action === 'write') {
      if (stage.files.length >= 2000) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many staged output files');
      const name = assertRelativePath(path, payload.name, 'output name');
      if (name.includes('/')) throw hostError(CODES.INVALID_REQUEST, 'Output name must be a file name');
      const outputRelativePath = assertRelativePath(path, payload.outputRelativePath, 'output relativePath');
      let stagePath = path.join(stage.root, `${crypto.randomUUID()}-${name}`);
      if (payload.sourceName) {
        stagePath = path.resolve(stage.root, assertRelativePath(path, payload.sourceName, 'staged sourceName'));
        if (!inside(path, stage.root, stagePath)) throw hostError(CODES.PERMISSION_DENIED, 'Staged source escapes its output stage');
      } else if (payload.inputToken) await fs.promises.copyFile(consumeInput(payload.inputToken, descriptor, context), stagePath, fs.constants.COPYFILE_EXCL);
      else {
        const bytes = Buffer.from(String(payload.base64 || ''), 'base64');
        if (!bytes.length || bytes.length > MAX_INLINE_WRITE_BYTES) throw hostError(CODES.LIMIT_EXCEEDED, 'Inline output must be between 1 byte and 8 MiB');
        await fs.promises.writeFile(stagePath, bytes, { flag: 'wx' });
      }
      const stagedStat = await fs.promises.lstat(stagePath).catch(() => null);
      if (!stagedStat?.isFile() || stagedStat.isSymbolicLink()) throw hostError(CODES.INVALID_REQUEST, 'Staged output source is missing or unsafe');
      if (!inside(path, await fs.promises.realpath(stage.root), await fs.promises.realpath(stagePath))) throw hostError(CODES.PERMISSION_DENIED, 'Staged output source escapes through a linked directory');
      const artifactId = crypto.randomUUID();
      stage.files.push({ artifactId, stagePath, outputRelativePath });
      return { apiVersion: 2, stageId: stage.id, artifactId, byteLength: stagedStat.size };
    }
    if (payload.action === 'validate') return { apiVersion: 2, stageId: stage.id, valid: true, ...(await validateStage(stage)) };
    if (payload.action === 'rollback') {
      outputStages.delete(stage.id);
      await fs.promises.rm(stage.root, { recursive: true, force: true });
      return { apiVersion: 2, stageId: stage.id, rolledBack: true };
    }
    if (payload.action !== 'commit') throw hostError(CODES.INVALID_REQUEST, 'Unknown output action');
    const idempotencyKey = String(payload.idempotencyKey || '');
    if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
    const commitKey = `${stage.scope}\0${idempotencyKey}`;
    if (committedOutputs.has(commitKey)) return committedOutputs.get(commitKey);
    await validateStage(stage);
    const outputs = [];
    const created = [];
    try {
      for (const file of stage.files) {
        const destination = path.resolve(stage.projectRoot, file.outputRelativePath);
        if (!inside(path, stage.projectRoot, destination)) throw hostError(CODES.PERMISSION_DENIED, 'Output target escapes the project');
        if (fs.existsSync(destination)) throw hostError(CODES.CONFLICT, `Output already exists: ${file.outputRelativePath}`);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        const realProjectRoot = await fs.promises.realpath(stage.projectRoot);
        const realDestinationParent = await fs.promises.realpath(path.dirname(destination));
        if (!insideOrEqual(path, realProjectRoot, realDestinationParent)) throw hostError(CODES.PERMISSION_DENIED, 'Output target escapes through a linked directory');
        const pending = `${destination}.${crypto.randomUUID()}.photoflow-pending`;
        await fs.promises.copyFile(file.stagePath, pending, fs.constants.COPYFILE_EXCL);
        await fs.promises.rename(pending, destination);
        created.push(destination);
        outputs.push({ artifactId: file.artifactId, relativePath: file.outputRelativePath, filePath: destination });
      }
    } catch (error) {
      await Promise.all(created.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => undefined)));
      throw error;
    }
    const result = { apiVersion: 2, commitId: crypto.randomUUID(), idempotencyKey, outputs };
    committedOutputs.set(commitKey, result);
    committedOutputs.set(result.commitId, { ...result, scope: stage.scope });
    await replaceJsonAtomic({ fs, crypto, filePath: path.join(scope.componentRoot, 'receipts', `commit-${crypto.createHash('sha256').update(`${context.projectId}\0${idempotencyKey}`).digest('hex')}.json`), value: { ...result, projectId: String(context.projectId) } });
    outputStages.delete(stage.id);
    await fs.promises.rm(stage.root, { recursive: true, force: true });
    return result;
  });

  broker.register('version.create.v2', async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    const commit = committedOutputs.get(String(payload.commitId || ''));
    if (!commit || commit.scope !== scope.key) throw hostError(CODES.TOKEN_SCOPE, 'Committed output does not belong to this component project');
    const artifact = commit.outputs.find(item => item.artifactId === String(payload.artifactId || ''));
    if (!artifact) throw hostError(CODES.NOT_FOUND, 'Committed output artifact was not found');
    const bundle = await versionService.getPhoto(scope.workspaceRoot, String(payload.photoId || ''));
    if (String(bundle?.photo?.projectId || '') !== String(scope.project.id)) throw hostError(CODES.TOKEN_SCOPE, 'Version photo is outside the bound project');
    if (!(bundle.versions || []).some(item => String(item.id) === String(payload.parentVersionId || ''))) throw hostError(CODES.NOT_FOUND, 'Parent version was not found');
    const idempotencyKey = String(payload.idempotencyKey || '');
    if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
    const versionKey = `${scope.key}\0${idempotencyKey}`;
    if (createdVersions.has(versionKey)) return createdVersions.get(versionKey);
    const receiptPath = path.join(scope.componentRoot, 'receipts', `version-${crypto.createHash('sha256').update(`${context.projectId}\0${idempotencyKey}`).digest('hex')}.json`);
    const receipt = await readJson(fs, receiptPath);
    if (receipt?.idempotencyKey === idempotencyKey && receipt?.projectId === String(context.projectId)) {
      const restored = { apiVersion: 2, versionId: receipt.versionId, result: receipt.result };
      createdVersions.set(versionKey, restored);
      return restored;
    }
    const versionId = crypto.randomUUID();
    const result = await versionService.createVersion(scope.workspaceRoot, {
      photoId: String(payload.photoId), parentVersionId: String(payload.parentVersionId), versionId,
      filePath: artifact.filePath, versionName: String(payload.name || '组件输出').slice(0, 120),
      versionType: String(payload.type || 'component').slice(0, 40), note: String(payload.note || '').slice(0, 2000),
      isFinal: payload.isFinal === true, status: String(payload.status || 'draft').slice(0, 40),
    });
    void ensureTrackedVersionThumbnail?.({ workspaceRoot: scope.workspaceRoot, photoId: payload.photoId, versionId, filePath: artifact.filePath });
    const response = { apiVersion: 2, versionId, result };
    createdVersions.set(versionKey, response);
    await replaceJsonAtomic({ fs, crypto, filePath: receiptPath, value: { ...response, idempotencyKey, projectId: String(context.projectId) } });
    return response;
  });

  broker.register('tasks.v2', async (payload, context, descriptor) => {
    const operationId = String(payload.operationId || '');
    if (!ID.test(operationId)) throw hostError(CODES.INVALID_REQUEST, 'Invalid component task operationId');
    const key = `${scopeKey(descriptor, context)}\0${operationId}`;
    let handle = componentTaskHandles.get(key);
    if (['start', 'resume'].includes(payload.action)) {
      if (!handle || handle.isFinished()) {
        handle = backgroundTasks.create({
          id: `component:${descriptor.componentId}:${context.projectId}:${operationId}`,
          type: 'component-operation', title: String(payload.title || '组件任务').slice(0, 120), message: String(payload.message || '').slice(0, 500),
          cancellable: true, resumable: true, resumePolicy: 'checkpoint', checkpoint: payload.checkpoint,
          metadata: { componentId: descriptor.componentId, projectId: context.projectId, operationId },
        });
        await handle.waitForStart(); componentTaskHandles.set(key, handle);
      }
    } else if (payload.action === 'report') {
      if (!handle) throw hostError(CODES.NOT_FOUND, 'Component task was not found');
      handle.context.report(Math.max(0, Math.min(100, Number(payload.progress) || 0)), String(payload.message || '').slice(0, 500), { phase: String(payload.phase || '').slice(0, 80) });
      if (payload.checkpoint !== undefined) handle.context.saveCheckpoint(boundedObject(payload.checkpoint, MAX_SETTINGS_BYTES, 'Task checkpoint'), payload.progress, payload.message, { phase: payload.phase });
    } else if (payload.action === 'complete') handle?.complete(String(payload.message || 'Completed').slice(0, 500));
    else if (payload.action === 'fail') handle?.fail(hostError(CODES.INTERNAL, String(payload.error || 'Component task failed').slice(0, 1000)));
    else if (payload.action === 'cancel') { if (handle && !handle.isFinished()) backgroundTasks.cancel(handle.task.id); }
    else if (payload.action !== 'status') throw hostError(CODES.INVALID_REQUEST, 'Unknown component task action');
    const task = handle ? backgroundTasks.get(handle.task.id) || handle.snapshot() : null;
    return { apiVersion: 2, task, cancelled: Boolean(handle?.context.signal.aborted), checkpoint: task?.checkpoint };
  });

  broker.register('dialogs.v2', async (payload, context, descriptor) => {
    if (payload.kind === 'confirm') {
      const response = await dialog.showMessageBox(mainWindow, { type: 'question', title: String(payload.title || '组件确认').slice(0, 120), message: String(payload.message || '').slice(0, 1000), buttons: ['取消', '继续'], defaultId: 0, cancelId: 0, noLink: true });
      return { apiVersion: 2, confirmed: response.response === 1 };
    }
    if (payload.kind !== 'openFiles') throw hostError(CODES.INVALID_REQUEST, 'Unknown safe dialog kind');
    const extensions = [...new Set((payload.extensions || []).map(value => String(value).replace(/^\./, '').toLowerCase()).filter(value => /^[a-z0-9]{1,12}$/.test(value)))].slice(0, 64);
    const choice = await dialog.showOpenDialog(mainWindow, { title: String(payload.title || '选择输入文件').slice(0, 120), properties: ['openFile', ...(payload.multiple === false ? [] : ['multiSelections'])], ...(extensions.length ? { filters: [{ name: '允许的文件', extensions }] } : {}) });
    if (choice.canceled) return { apiVersion: 2, cancelled: true, inputs: [] };
    const inputs = [];
    for (const selected of choice.filePaths.slice(0, MAX_INPUT_TOKENS)) {
      const filePath = path.resolve(selected);
      const stat = await fs.promises.lstat(filePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      if (extensions.length && !extensions.includes(path.extname(filePath).slice(1).toLowerCase())) continue;
      inputs.push({ name: path.basename(filePath), ...grantInput(filePath, descriptor, context) });
    }
    return { apiVersion: 2, cancelled: false, inputs };
  });

  broker.register('component.events.v2', async (payload, context, descriptor) => {
    const topic = String(payload.topic || '');
    if (!EVENT_TOPIC.test(topic) || !descriptor.service?.events?.includes(topic)) throw hostError(CODES.PERMISSION_DENIED, 'Component event topic is not declared');
    const event = boundedObject(payload.event || {}, MAX_SETTINGS_BYTES, 'Component event');
    context.emitComponentEvent?.(topic, event);
    return { apiVersion: 2, emitted: true };
  });

  broker.register('component.lifecycle.v2', async (payload, _context, descriptor) => {
    if (payload.action !== 'describe') throw hostError(CODES.PERMISSION_DENIED, 'Component lifecycle mutations are host-owned');
    return { apiVersion: 2, componentId: descriptor.componentId, componentVersion: descriptor.componentVersion, negotiatedHostApiVersion: descriptor.hostApiVersion, permissions: descriptor.service?.permissions || [], events: descriptor.service?.events || [], state: 'active' };
  });
};

module.exports = {
  CURSOR_TTL_MS,
  INPUT_TOKEN_TTL_MS,
  MAX_INLINE_WRITE_BYTES,
  MAX_MEDIA_PAGE_SIZE,
  MAX_SETTINGS_BYTES,
  MAX_STAGE_BYTES,
  assertRelativePath,
  normalizeRelativePath,
  registerComponentProjectCapabilities,
};
