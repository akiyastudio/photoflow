const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
const { adoptLegacyStorageV1 } = require('../compatibility/component-storage-v1-adoption.cjs');

const MAX_MEDIA_PAGE_SIZE = 200;
const MAX_INPUT_TOKENS = 2000;
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_INLINE_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_STAGE_BYTES = 2 * 1024 * 1024 * 1024;
const INPUT_TOKEN_TTL_MS = 10 * 60 * 1000;
const CURSOR_TTL_MS = 5 * 60 * 1000;
const STAGE_TTL_MS = 24 * 60 * 60 * 1000;
const STAGE_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SAFE_STAGE_ID = /^[a-f0-9-]{16,80}$/i;
const EVENT_TOPIC = /^[a-z][a-z0-9.-]{0,119}\.v[1-9][0-9]*$/;

const inputGrants = new Map();
const listSessions = new Map();
const outputStages = new Map();
const componentTaskHandles = new Map();
const committedOutputs = new Map();
const createdVersions = new Map();
const commitOperations = new Map();
const versionOperations = new Map();
const storageAdoptions = new Map();

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
const stableUuid = (crypto, value) => {
  const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const sha256File = (fs, crypto, filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  input.on('error', reject);
  input.on('data', chunk => hash.update(chunk));
  input.on('end', () => resolve(hash.digest('hex')));
});
const adoptLegacyOutputV1 = async ({ fs, path, crypto, componentRoot, componentId, projectId, scopeDigest: digest, projectRoot, migrationId, outputs }) => {
  if (!ID.test(String(migrationId || '')) || !Array.isArray(outputs) || !outputs.length || outputs.length > 2000) throw hostError(CODES.INVALID_REQUEST, 'Invalid legacy output adoption request');
  const commitId = stableUuid(crypto, `component-output-v1-adoption\0${componentId}\0${projectId}\0${migrationId}`);
  const receiptPath = path.join(componentRoot, 'receipts', 'commits', `${commitId}.json`);
  if (fs.existsSync(receiptPath)) return JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
  const adopted = [];
  for (const item of outputs) {
    const relativePath = assertRelativePath(path, item.relativePath, 'legacy output relativePath');
    const filePath = path.resolve(projectRoot, relativePath);
    if (!inside(path, projectRoot, filePath)) throw hostError(CODES.PERMISSION_DENIED, 'Legacy adopted output escapes project');
    const stat = await fs.promises.lstat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw hostError(CODES.NOT_FOUND, 'Legacy adopted output is missing or unsafe');
    adopted.push({ artifactId: String(item.artifactId || stableUuid(crypto, `${commitId}\0${relativePath}`)), relativePath, size: stat.size, sha256: await sha256File(fs, crypto, filePath), published: true });
  }
  const receipt = { schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-output-commit', state: 'committed', commitId, idempotencyKey: `legacy-${migrationId}`.slice(0, 80), componentId, projectId: String(projectId), scopeDigest: digest, stageId: stableUuid(crypto, `${commitId}\0adopted-stage`), createdAt: Date.now(), committedAt: Date.now(), adoptedFromHostApiVersion: 1, outputs: adopted };
  await replaceJsonAtomic({ fs, crypto, filePath: receiptPath, value: receipt });
  return receipt;
};
const resetComponentHostCapabilityStateForTest = () => {
  inputGrants.clear(); listSessions.clear(); outputStages.clear(); componentTaskHandles.clear(); committedOutputs.clear(); createdVersions.clear(); commitOperations.clear(); versionOperations.clear(); storageAdoptions.clear();
};

const registerComponentProjectCapabilities = ({
  broker, ensureWorkspace, getWorkspaceDataRoot, resolveProjectEntry, versionService,
  IMAGE_EXTENSIONS, VIDEO_EXTENSIONS = new Set(), RAW_EXTENSIONS = new Set(),
  path, fs, crypto, getConfigPath, readSavedConfig, getProjectPath, dialog, mainWindow, shell,
  mediaService, backgroundTasks, ensureTrackedVersionThumbnail, getBoundProject = null, projectVirtualPaths = null,
  replaceJson = replaceJsonAtomic, now = Date.now,
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
  const managedBoundary = (scope, filePath, relativeHint = '') => {
    const candidate = path.resolve(filePath);
    if (insideOrEqual(path, scope.projectRoot, candidate)) return { relativePath: normalizeRelativePath(relativeHint || path.relative(scope.projectRoot, candidate)), viaExternalLink: false };
    if (!projectVirtualPaths?.resolve) throw hostError(CODES.PERMISSION_DENIED, 'Media is outside the project content boundary');
    let relativePath = normalizeRelativePath(relativeHint);
    if (!relativePath) {
      const link = (projectVirtualPaths.listManagedExternalLinks?.(scope.projectRoot) || []).find(item => {
        if (item.offline) return false;
        const target = path.resolve(String(item.externalTargetRoot || ''));
        return item.externalTargetKind === 'file' ? candidate === target : insideOrEqual(path, target, candidate);
      });
      if (!link) throw hostError(CODES.PERMISSION_DENIED, 'Media is outside managed project links');
      relativePath = projectVirtualPaths.toVirtualPath
        ? normalizeRelativePath(projectVirtualPaths.toVirtualPath(scope.projectRoot, candidate, link))
        : [normalizeRelativePath(link.shortcutVirtualPath), link.externalTargetKind === 'folder' ? normalizeRelativePath(path.relative(link.externalTargetRoot, candidate)) : ''].filter(Boolean).join('/');
    }
    let resolution;
    try { resolution = projectVirtualPaths.resolve(scope.projectRoot, relativePath, { externalRootMode: 'target' }); }
    catch { throw hostError(CODES.PERMISSION_DENIED, 'Managed media path could not be resolved'); }
    if (!resolution?.viaExternalLink || path.resolve(resolution.physicalPath) !== candidate || !insideOrEqual(path, resolution.mediaRoot, candidate)) throw hostError(CODES.PERMISSION_DENIED, 'Media escapes its managed external boundary');
    mediaService.grantRoot(resolution.mediaRoot);
    return { relativePath, viaExternalLink: true };
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
      const boundary = managedBoundary(scope, filePath);
      return { ...scope, bundle, version, filePath, ...boundary };
    }
    const relativePath = assertRelativePath(path, payload.relativePath, 'media relativePath');
    const filePath = path.resolve(resolveProjectEntry(context.workspacePath, context.projectStatus, context.projectName, relativePath));
    const boundary = managedBoundary(scope, filePath, relativePath);
    const bundle = await versionService.getMedia(scope.workspaceRoot, { projectName: context.projectName, filePath });
    if (String(bundle?.photo?.projectId || '') !== String(scope.project.id)) throw hostError(CODES.TOKEN_SCOPE, 'Media is outside the bound project');
    const version = (bundle.versions || []).find(item => path.resolve(String(item.filePath || '')) === filePath)
      || (bundle.versions || []).find(item => item.isCurrent) || (bundle.versions || []).at(-1);
    return { ...scope, bundle, version, filePath, ...boundary };
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
      const pending = [{ directory: scope.projectRoot, relative: '', viaExternalLink: false }];
      const externalFiles = [];
      for (const link of projectVirtualPaths?.listManagedExternalLinks?.(scope.projectRoot) || []) {
        if (link.offline) continue;
        if (link.externalTargetKind === 'file') externalFiles.push({ filePath: link.externalTargetRoot, relativePath: normalizeRelativePath(link.shortcutVirtualPath) });
        else pending.push({ directory: link.externalTargetRoot, relative: normalizeRelativePath(link.shortcutVirtualPath), viaExternalLink: true });
        if (link.externalTargetKind === 'file') mediaService.grantPath(link.externalTargetRoot);
        else mediaService.grantRoot(link.externalTargetRoot);
      }
      session = { cursor, scope: scope.key, root: scope.projectRoot, pending, externalFiles, expiresAt: Date.now() + CURSOR_TTL_MS };
      listSessions.set(cursor, session);
    }
    const items = [];
    let inspected = 0;
    while (session.externalFiles?.length && items.length < pageSize) {
      const external = session.externalFiles.shift();
      const stat = await fs.promises.lstat(external.filePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const kind = kindFor(external.filePath);
      if (!requestedKinds.has(kind)) continue;
      items.push({ mediaRef: { relativePath: external.relativePath }, relativePath: external.relativePath, name: path.basename(external.filePath), kind, extension: path.extname(external.filePath).toLowerCase(), size: stat.size, updatedAt: stat.mtimeMs, viaExternalLink: true });
    }
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
        if (child.isDirectory()) { session.pending.push({ directory: candidate, relative: relativePath, viaExternalLink: current.viaExternalLink }); continue; }
        if (!child.isFile()) continue;
        const kind = kindFor(candidate);
        if (!requestedKinds.has(kind)) continue;
        const stat = await fs.promises.stat(candidate);
        items.push({ mediaRef: { relativePath }, relativePath, name: child.name, kind, extension: path.extname(child.name).toLowerCase(), size: stat.size, updatedAt: stat.mtimeMs, ...(current.viaExternalLink ? { viaExternalLink: true } : {}) });
        if (items.length >= pageSize) { childIndex += 1; break; }
      }
      if (childIndex < children.length) session.pending.unshift({ ...current, offset: childIndex });
    }
    const hasMore = session.pending.length > 0 || Boolean(session.externalFiles?.length);
    session.expiresAt = Date.now() + CURSOR_TTL_MS;
    if (!hasMore) listSessions.delete(session.cursor);
    return { apiVersion: 2, items, page: { hasMore, cursor: hasMore ? session.cursor : null, pageSize } };
  });

  broker.register('project.media.variants.v2', async (payload, context, descriptor) => {
    const media = await resolveSafeMedia(payload, context, descriptor);
    const stat = await fs.promises.lstat(media.filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw hostError(CODES.NOT_FOUND, 'Media file is missing or unsafe');
    const requested = new Set(Array.isArray(payload.variants) ? payload.variants : ['thumbnail', 'preview']);
    if ([...requested].some(value => !['thumbnail', 'preview', 'original'].includes(value))) throw hostError(CODES.INVALID_REQUEST, 'Unknown media variant');
    let originalUrl = '';
    if (requested.size) { mediaService.grantPath(media.filePath); originalUrl = mediaService.toUrl(media.filePath, true); }
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
    const input = requested.has('original') ? grantInput(media.filePath, descriptor, context) : null;
    return {
      apiVersion: 2,
      mediaRef: { photoId: media.bundle?.photo?.id, versionId: media.version?.id, relativePath: media.relativePath },
      metadata: {
        photoId: String(media.bundle?.photo?.id || ''), versionId: String(media.version?.id || ''),
        currentVersionId: String(media.bundle?.photo?.currentVersionId || (media.bundle?.versions || []).find(item => item.isCurrent)?.id || media.version?.id || ''),
        displayName: String(media.bundle?.photo?.displayName || media.bundle?.photo?.originalName || path.basename(media.filePath)),
        originalName: String(media.bundle?.photo?.originalName || path.basename(media.filePath)), relativePath: media.relativePath,
        isCurrent: Boolean(media.version?.isCurrent), fileMissing: Boolean(media.version?.fileMissing),
      },
      variants: result, ...(input ? { input } : {}),
    };
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
    let adoption = null;
    if (descriptor.migrations?.legacyStorageV1) {
      const key = `${descriptor.componentId}\0${scope.workspaceRoot}`;
      let operation = storageAdoptions.get(key);
      if (!operation) {
        operation = adoptLegacyStorageV1({ fs, path, crypto, dataRoot: getWorkspaceDataRoot(scope.workspaceRoot), componentRoot: scope.componentRoot, descriptor }).finally(() => storageAdoptions.delete(key));
        storageAdoptions.set(key, operation);
      }
      adoption = await operation;
    }
    await fs.promises.mkdir(scope.componentRoot, { recursive: true });
    return { apiVersion: 2, dataPath: scope.componentRoot, databasePath: path.join(scope.componentRoot, 'storage.sqlite3'), projectId: String(scope.project.id), ownership: 'component-private', ...(adoption ? { adoption: { kind: adoption.kind, fromHostApiVersion: 1, state: adoption.state, legacyDataRoot: adoption.legacyDataRoot || '', legacyDatabasePath: adoption.legacyDatabasePath || '', databaseSha256: adoption.databaseSha256 || '' } } : {}) };
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
    await replaceJson({ fs, crypto, filePath: getConfigPath(), value: next });
    return { apiVersion: 2, revision, settings };
  });

  const scopeDigest = scope => crypto.createHash('sha256').update(scope.key).digest('hex');
  const stageRootFor = (scope, stageId) => path.join(scope.componentRoot, 'staging', stageId);
  const stageMetadataPath = stage => path.join(stage.root, 'stage.json');
  const persistStage = stage => replaceJson({ fs, crypto, filePath: stageMetadataPath(stage), value: {
    schemaVersion: STAGE_SCHEMA_VERSION, id: stage.id, componentId: stage.componentId, projectId: stage.projectId,
    scopeDigest: stage.scopeDigest, createdAt: stage.createdAt, expiresAt: stage.expiresAt,
    files: stage.files.map(file => ({ artifactId: file.artifactId, sourceName: file.sourceName, outputRelativePath: file.outputRelativePath, ...(file.replacement ? { replacement: file.replacement } : {}) })),
  } });
  const cleanupStage = async stage => {
    outputStages.delete(stage.id);
    if (SAFE_STAGE_ID.test(stage.id) && path.resolve(stage.root) === path.resolve(stageRootFor({ componentRoot: stage.componentRoot }, stage.id))) {
      await fs.promises.rm(stage.root, { recursive: true, force: true });
    }
  };
  const resolveStage = async (payload, scope, descriptor) => {
    const id = String(payload.stageId || '');
    if (!SAFE_STAGE_ID.test(id)) throw hostError(CODES.INVALID_REQUEST, 'Invalid output stage id');
    let stage = outputStages.get(id);
    if (!stage) {
      const root = stageRootFor(scope, id);
      const metadata = await readJson(fs, path.join(root, 'stage.json'));
      if (!metadata) throw hostError(CODES.NOT_FOUND, 'Output stage was not found');
      const files = Array.isArray(metadata.files) && metadata.files.length <= 2000 ? metadata.files.map(file => ({
        artifactId: String(file.artifactId || ''), sourceName: assertRelativePath(path, file.sourceName, 'staged sourceName'), outputRelativePath: assertRelativePath(path, file.outputRelativePath, 'output relativePath'),
        ...(file.replacement ? { replacement: { previousCommitId: String(file.replacement.previousCommitId || ''), previousArtifactId: String(file.replacement.previousArtifactId || ''), expectedDigest: String(file.replacement.expectedDigest || '') } } : {}),
      })) : null;
      if (metadata.schemaVersion !== STAGE_SCHEMA_VERSION || metadata.id !== id || metadata.componentId !== descriptor.componentId
        || metadata.projectId !== String(scope.project.id) || metadata.scopeDigest !== scopeDigest(scope) || !files
        || !Number.isSafeInteger(metadata.createdAt) || !Number.isSafeInteger(metadata.expiresAt)
        || Number.parseInt(id.split('-')[0], 16) !== metadata.createdAt || metadata.expiresAt !== metadata.createdAt + STAGE_TTL_MS) throw hostError(CODES.PERMISSION_DENIED, 'Output stage metadata is invalid or belongs to another scope');
      stage = { id, scope: scope.key, scopeDigest: metadata.scopeDigest, root, payloadRoot: path.join(root, 'payload'), projectRoot: scope.projectRoot, componentRoot: scope.componentRoot, componentId: descriptor.componentId, projectId: String(scope.project.id), createdAt: metadata.createdAt, expiresAt: metadata.expiresAt, files };
      outputStages.set(id, stage);
    }
    if (stage.scope !== scope.key || stage.scopeDigest !== scopeDigest(scope)) throw hostError(CODES.TOKEN_SCOPE, 'Output stage belongs to another component or project');
    if (now() >= stage.expiresAt) { await cleanupStage(stage); throw hostError(CODES.TOKEN_EXPIRED, 'Output stage expired after 24 hours'); }
    return stage;
  };
  const inspectStage = async stage => {
    if (!stage.files.length) throw hostError(CODES.INVALID_REQUEST, 'Output stage is empty');
    const realPayloadRoot = await fs.promises.realpath(stage.payloadRoot);
    let totalBytes = 0;
    const files = [];
    const targets = new Set();
    for (const file of stage.files) {
      if (!/^[a-f0-9-]{16,80}$/i.test(file.artifactId)) throw hostError(CODES.INVALID_REQUEST, 'Output stage contains an invalid artifact id');
      if (targets.has(file.outputRelativePath.toLocaleLowerCase())) throw hostError(CODES.CONFLICT, `Duplicate output target: ${file.outputRelativePath}`);
      targets.add(file.outputRelativePath.toLocaleLowerCase());
      const stagePath = path.resolve(stage.payloadRoot, file.sourceName);
      const stat = await fs.promises.lstat(stagePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || !inside(path, stage.payloadRoot, stagePath)) throw hostError(CODES.PERMISSION_DENIED, 'Output stage contains an unsafe file');
      const realFile = await fs.promises.realpath(stagePath);
      if (!inside(path, realPayloadRoot, realFile)) throw hostError(CODES.PERMISSION_DENIED, 'Output stage escapes through a linked directory');
      totalBytes += stat.size;
      if (totalBytes > MAX_STAGE_BYTES) throw hostError(CODES.LIMIT_EXCEEDED, 'Output stage is too large');
      files.push({ ...file, stagePath, size: stat.size, sha256: await sha256File(fs, crypto, stagePath) });
    }
    return { fileCount: files.length, totalBytes, files };
  };
  const commitReceiptPath = (scope, commitId) => path.join(scope.componentRoot, 'receipts', 'commits', `${commitId}.json`);
  const versionReceiptPath = (scope, versionId) => path.join(scope.componentRoot, 'receipts', 'versions', `${versionId}.json`);
  const safeDestination = async (scope, relativePath, createParent = false) => {
    const normalized = assertRelativePath(path, relativePath, 'output relativePath');
    const destination = path.resolve(scope.projectRoot, normalized);
    if (!inside(path, scope.projectRoot, destination)) throw hostError(CODES.PERMISSION_DENIED, 'Output target escapes the project');
    if (createParent) await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const parent = path.dirname(destination);
    const existingParent = await fs.promises.realpath(parent).catch(() => null);
    if (existingParent && !insideOrEqual(path, await fs.promises.realpath(scope.projectRoot), existingParent)) throw hostError(CODES.PERMISSION_DENIED, 'Output target escapes through a linked directory');
    return destination;
  };
  const outputMatches = async (scope, output) => {
    const destination = await safeDestination(scope, output.relativePath, false);
    const stat = await fs.promises.lstat(destination).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== output.size) return false;
    return (await sha256File(fs, crypto, destination)) === output.sha256;
  };
  const fileMatchesDigest = async (filePath, size, digest) => {
    const stat = await fs.promises.lstat(filePath).catch(() => null);
    return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.size === size && await sha256File(fs, crypto, filePath) === digest);
  };
  const validateCommitReceipt = (receipt, scope, commitId, idempotencyKey = null) => {
    const validOutputs = Array.isArray(receipt?.outputs) && receipt.outputs.length > 0 && receipt.outputs.length <= 2000
      && receipt.outputs.every(item => /^[a-f0-9-]{16,80}$/i.test(String(item.artifactId || '')) && /^[a-f0-9]{64}$/.test(String(item.sha256 || '')) && Number.isSafeInteger(item.size) && item.size >= 0
        && (!item.replacement || (SAFE_STAGE_ID.test(String(item.replacement.previousCommitId || '')) && SAFE_STAGE_ID.test(String(item.replacement.previousArtifactId || '')) && /^[a-f0-9]{64}$/.test(String(item.replacement.expectedDigest || '')) && Number.isSafeInteger(item.replacement.expectedSize) && item.replacement.expectedSize >= 0)));
    if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION || receipt?.kind !== 'component-output-commit' || receipt?.commitId !== commitId
      || !['prepared', 'committed'].includes(receipt?.state) || receipt?.componentId !== scope.componentId || receipt?.projectId !== String(scope.project.id)
      || receipt?.scopeDigest !== scopeDigest(scope) || !ID.test(String(receipt?.idempotencyKey || '')) || !SAFE_STAGE_ID.test(String(receipt?.stageId || '')) || !Number.isSafeInteger(receipt?.createdAt)
      || (idempotencyKey !== null && receipt?.idempotencyKey !== idempotencyKey) || !validOutputs || (receipt?.state === 'committed' && receipt.outputs.some(item => item.published !== true))) {
      throw hostError(CODES.PERMISSION_DENIED, 'Component output receipt is invalid or belongs to another scope');
    }
    receipt.outputs = receipt.outputs.map(item => ({
      artifactId: String(item.artifactId), relativePath: assertRelativePath(path, item.relativePath, 'receipt output relativePath'), size: item.size, sha256: item.sha256, published: item.published === true,
      ...(item.replacement ? { replacement: { previousCommitId: String(item.replacement.previousCommitId || ''), previousArtifactId: String(item.replacement.previousArtifactId || ''), expectedDigest: String(item.replacement.expectedDigest || ''), expectedSize: Number(item.replacement.expectedSize), backupName: item.replacement.backupName ? assertRelativePath(path, item.replacement.backupName, 'replacement backup') : '' } } : {}),
    }));
    return receipt;
  };
  const commitResponse = (scope, receipt) => ({ apiVersion: 2, commitId: receipt.commitId, idempotencyKey: receipt.idempotencyKey, outputs: receipt.outputs.map(item => ({ artifactId: item.artifactId, relativePath: item.relativePath, filePath: path.resolve(scope.projectRoot, item.relativePath), byteLength: item.size, sha256: item.sha256 })) });
  const loadCommitReceipt = async (scope, commitId, idempotencyKey = null) => {
    if (!SAFE_STAGE_ID.test(commitId)) throw hostError(CODES.INVALID_REQUEST, 'Invalid commit id');
    const receipt = await readJson(fs, commitReceiptPath(scope, commitId));
    return receipt ? validateCommitReceipt(receipt, scope, commitId, idempotencyKey) : null;
  };
  const rollbackReceiptOutputs = async (scope, receipt) => {
    const preserved = [];
    for (const output of receipt.outputs) {
      if (!output.published) continue;
      const destination = await safeDestination(scope, output.relativePath, false);
      if (await outputMatches(scope, output)) {
        if (output.replacement?.backupName) {
          const stage = { payloadRoot: path.join(stageRootFor(scope, receipt.stageId), 'payload') };
          const backup = path.resolve(stage.payloadRoot, output.replacement.backupName);
          if (inside(path, stage.payloadRoot, backup) && await fileMatchesDigest(backup, output.replacement.expectedSize, output.replacement.expectedDigest)) {
            const pending = `${destination}.${crypto.randomUUID()}.photoflow-rollback`;
            try { await fs.promises.copyFile(backup, pending, fs.constants.COPYFILE_EXCL); await fs.promises.rename(pending, destination); }
            finally { await fs.promises.rm(pending, { force: true }).catch(() => undefined); }
          } else preserved.push(output.relativePath);
        } else await fs.promises.rm(destination, { force: true });
      }
      else if (fs.existsSync(destination)) preserved.push(output.relativePath);
      output.published = false;
    }
    return preserved;
  };
  const rollbackPreparedReceiptsForStage = async (scope, stageId) => {
    const directory = path.join(scope.componentRoot, 'receipts', 'commits');
    const entries = (await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => [])).filter(item => item.isFile() && /^[a-f0-9-]{36}\.json$/i.test(item.name)).slice(0, 2000);
    for (const entry of entries) {
      const commitId = entry.name.slice(0, -5);
      const receipt = await loadCommitReceipt(scope, commitId);
      if (!receipt || receipt.state !== 'prepared' || receipt.stageId !== stageId) continue;
      const preserved = await rollbackReceiptOutputs(scope, receipt);
      if (preserved.length) throw hostError(CODES.CONFLICT, `Prepared output changed and was preserved: ${preserved.join(', ')}`);
      await fs.promises.rm(commitReceiptPath(scope, commitId), { force: true });
    }
  };
  const commitStage = async (payload, scope, descriptor) => {
    const idempotencyKey = String(payload.idempotencyKey || '');
    if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
    const commitId = stableUuid(crypto, `component-output\0${scope.key}\0${idempotencyKey}`);
    const cacheKey = `${scope.key}\0${idempotencyKey}`;
    if (committedOutputs.has(cacheKey)) return committedOutputs.get(cacheKey);
    let receipt = await loadCommitReceipt(scope, commitId, idempotencyKey);
    if (receipt?.state === 'committed') {
      for (const output of receipt.outputs) if (!await outputMatches(scope, output)) throw hostError(CODES.CONFLICT, `Committed output changed: ${output.relativePath}`);
      const restored = commitResponse(scope, receipt);
      committedOutputs.set(cacheKey, restored); committedOutputs.set(commitId, { ...restored, scope: scope.key });
      if (SAFE_STAGE_ID.test(String(receipt.stageId || ''))) { outputStages.delete(receipt.stageId); await fs.promises.rm(stageRootFor(scope, receipt.stageId), { recursive: true, force: true }).catch(() => undefined); }
      return restored;
    }
    const stage = await resolveStage(payload, scope, descriptor);
    if (receipt && receipt.stageId !== stage.id) throw hostError(CODES.CONFLICT, 'Idempotency key is already bound to another output stage');
    if (!receipt) {
      const inspected = await inspectStage(stage);
      const outputs = [];
      for (const file of inspected.files) {
        const output = { artifactId: file.artifactId, relativePath: file.outputRelativePath, size: file.size, sha256: file.sha256, published: false };
        const destinationExists = fs.existsSync(await safeDestination(scope, output.relativePath, false));
        if (file.replacement) {
          const previous = await loadCommitReceipt(scope, file.replacement.previousCommitId);
          const previousOutput = previous?.state === 'committed' ? previous.outputs.find(item => item.artifactId === file.replacement.previousArtifactId) : null;
          if (!previousOutput || previousOutput.relativePath !== output.relativePath || previousOutput.sha256 !== file.replacement.expectedDigest || !destinationExists || !await outputMatches(scope, previousOutput)) throw hostError(CODES.CONFLICT, `Controlled replacement ownership or digest mismatch: ${output.relativePath}`);
          output.replacement = { ...file.replacement, expectedSize: previousOutput.size, backupName: '' };
        } else if (destinationExists) throw hostError(CODES.CONFLICT, `Output already exists: ${output.relativePath}`);
        outputs.push(output);
      }
      receipt = { schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-output-commit', state: 'prepared', commitId, idempotencyKey, componentId: descriptor.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), stageId: stage.id, createdAt: Date.now(), outputs };
      await replaceJson({ fs, crypto, filePath: commitReceiptPath(scope, commitId), value: receipt });
    }
    const inspected = await inspectStage(stage);
    const stagedByArtifact = new Map(inspected.files.map(file => [file.artifactId, file]));
    for (const output of receipt.outputs) {
      const staged = stagedByArtifact.get(output.artifactId);
      if (!staged || staged.size !== output.size || staged.sha256 !== output.sha256 || staged.outputRelativePath !== output.relativePath
        || JSON.stringify(staged.replacement || null) !== JSON.stringify(output.replacement ? { previousCommitId: output.replacement.previousCommitId, previousArtifactId: output.replacement.previousArtifactId, expectedDigest: output.replacement.expectedDigest } : null)) throw hostError(CODES.CONFLICT, `Staged artifact changed: ${output.relativePath}`);
    }
    const receiptPath = commitReceiptPath(scope, commitId);
    try {
      for (const output of receipt.outputs) {
        const destination = await safeDestination(scope, output.relativePath, true);
        if (fs.existsSync(destination)) {
          if (!await outputMatches(scope, output)) {
            if (!output.replacement || !await fileMatchesDigest(destination, output.replacement.expectedSize, output.replacement.expectedDigest)) throw hostError(CODES.CONFLICT, `Output conflicts with prepared journal: ${output.relativePath}`);
            if (!output.replacement.backupName) {
              output.replacement.backupName = `.replacement-backups/${output.artifactId}.backup`;
              const backup = path.resolve(stage.payloadRoot, output.replacement.backupName);
              await fs.promises.mkdir(path.dirname(backup), { recursive: true });
              await fs.promises.copyFile(destination, backup, fs.constants.COPYFILE_EXCL);
              await replaceJson({ fs, crypto, filePath: receiptPath, value: receipt });
            }
            const backup = path.resolve(stage.payloadRoot, output.replacement.backupName);
            if (!inside(path, stage.payloadRoot, backup) || !await fileMatchesDigest(backup, output.replacement.expectedSize, output.replacement.expectedDigest)) throw hostError(CODES.CONFLICT, `Replacement backup is missing or changed: ${output.relativePath}`);
            const pending = `${destination}.${crypto.randomUUID()}.photoflow-pending`;
            try { await fs.promises.copyFile(stagedByArtifact.get(output.artifactId).stagePath, pending, fs.constants.COPYFILE_EXCL); await fs.promises.rename(pending, destination); }
            finally { await fs.promises.rm(pending, { force: true }).catch(() => undefined); }
          }
        } else {
          if (output.replacement) {
            const backup = output.replacement.backupName ? path.resolve(stage.payloadRoot, output.replacement.backupName) : '';
            if (!backup || !inside(path, stage.payloadRoot, backup) || !await fileMatchesDigest(backup, output.replacement.expectedSize, output.replacement.expectedDigest)) throw hostError(CODES.CONFLICT, `Replacement target and backup are unavailable: ${output.relativePath}`);
          }
          const pending = `${destination}.${crypto.randomUUID()}.photoflow-pending`;
          try { await fs.promises.copyFile(stagedByArtifact.get(output.artifactId).stagePath, pending, fs.constants.COPYFILE_EXCL); await fs.promises.rename(pending, destination); }
          finally { await fs.promises.rm(pending, { force: true }).catch(() => undefined); }
        }
        output.published = true;
        await replaceJson({ fs, crypto, filePath: receiptPath, value: receipt });
      }
      receipt.state = 'committed'; receipt.committedAt = Date.now();
      await replaceJson({ fs, crypto, filePath: receiptPath, value: receipt });
    } catch (error) {
      const preserved = await rollbackReceiptOutputs(scope, receipt);
      committedOutputs.delete(cacheKey); committedOutputs.delete(commitId);
      await fs.promises.rm(receiptPath, { force: true }).catch(() => undefined);
      if (preserved.length) throw hostError(CODES.CONFLICT, `Output changed during rollback and was preserved: ${preserved.join(', ')}`);
      throw error;
    }
    const response = commitResponse(scope, receipt);
    committedOutputs.set(cacheKey, response); committedOutputs.set(commitId, { ...response, scope: scope.key });
    await cleanupStage(stage).catch(() => undefined);
    return response;
  };
  const withOperation = (operations, key, factory) => {
    const current = operations.get(key);
    if (current) return current;
    const operation = Promise.resolve().then(factory).finally(() => { if (operations.get(key) === operation) operations.delete(key); });
    operations.set(key, operation);
    return operation;
  };
  broker.register('project.output.v2', async (payload, context, descriptor) => {
    const scope = { ...bound(context, descriptor), componentId: descriptor.componentId };
    if (payload.action === 'adoptLegacyV1') {
      if (!descriptor.migrations?.legacyOutputV1) throw hostError(CODES.PERMISSION_DENIED, 'Legacy output adoption is not declared by this component');
      const receipt = await adoptLegacyOutputV1({ fs, path, crypto, componentRoot: scope.componentRoot, componentId: descriptor.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), projectRoot: scope.projectRoot, migrationId: payload.migrationId, outputs: payload.outputs });
      const response = commitResponse(scope, receipt);
      committedOutputs.set(receipt.commitId, { ...response, scope: scope.key });
      return response;
    }
    if (payload.action === 'delete') {
      const previousCommitId = String(payload.previousCommitId || ''); const previousArtifactId = String(payload.previousArtifactId || '');
      const expectedDigest = String(payload.expectedDigest || '').toLowerCase(); const idempotencyKey = String(payload.idempotencyKey || '');
      if (!SAFE_STAGE_ID.test(previousCommitId) || !SAFE_STAGE_ID.test(previousArtifactId) || !/^[a-f0-9]{64}$/.test(expectedDigest) || !ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'Controlled deletion requires ownership, digest, and idempotency key');
      const deletionId = stableUuid(crypto, `component-output-delete\0${scope.key}\0${idempotencyKey}`);
      const deletionReceiptPath = path.join(scope.componentRoot, 'receipts', 'deletions', `${deletionId}.json`);
      const existingDeletion = await readJson(fs, deletionReceiptPath);
      if (existingDeletion?.state === 'committed') return { apiVersion: 2, deletionId, deleted: true, relativePath: existingDeletion.relativePath };
      const receipt = await loadCommitReceipt(scope, previousCommitId);
      const output = receipt?.outputs?.find(item => item.artifactId === previousArtifactId);
      if (!output || output.sha256 !== expectedDigest) throw hostError(CODES.TOKEN_SCOPE, 'Controlled deletion ownership does not match');
      const destination = await safeDestination(scope, output.relativePath, false);
      if (!await fileMatchesDigest(destination, output.size, expectedDigest)) throw hostError(CODES.CONFLICT, 'Controlled deletion target changed');
      const trashRoot = path.join(scope.componentRoot, 'staging', 'deletions'); await fs.promises.mkdir(trashRoot, { recursive: true });
      const backup = path.join(trashRoot, deletionId); await fs.promises.rename(destination, backup);
      try {
        await replaceJson({ fs, crypto, filePath: deletionReceiptPath, value: { schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-output-deletion', state: 'committed', deletionId, idempotencyKey, componentId: descriptor.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), previousCommitId, previousArtifactId, relativePath: output.relativePath, sha256: expectedDigest, deletedAt: Date.now() } });
        await fs.promises.rm(backup, { force: true });
      } catch (error) { if (!fs.existsSync(destination)) await fs.promises.rename(backup, destination).catch(() => undefined); throw error; }
      return { apiVersion: 2, deletionId, deleted: true, relativePath: output.relativePath };
    }
    if (payload.action === 'materializeOwned') {
      const commitId = String(payload.commitId || ''); const artifactId = String(payload.artifactId || '');
      const receipt = await loadCommitReceipt(scope, commitId); const output = receipt?.outputs?.find(item => item.artifactId === artifactId);
      if (!output || receipt.state !== 'committed') throw hostError(CODES.TOKEN_SCOPE, 'Owned output artifact was not found');
      if (!await outputMatches(scope, output)) throw hostError(CODES.CONFLICT, 'Owned output changed before private materialization');
      const importId = stableUuid(crypto, `component-output-import\0${scope.key}\0${commitId}\0${artifactId}`);
      const directory = path.join(scope.componentRoot, 'imported-outputs', importId); const privatePath = path.join(directory, path.basename(output.relativePath));
      const source = path.resolve(scope.projectRoot, output.relativePath); await fs.promises.mkdir(directory, { recursive: true });
      if (!await fileMatchesDigest(privatePath, output.size, output.sha256)) {
        const pending = `${privatePath}.${crypto.randomUUID()}.tmp`; await fs.promises.copyFile(source, pending, fs.constants.COPYFILE_EXCL);
        if (!await fileMatchesDigest(pending, output.size, output.sha256)) { await fs.promises.rm(pending, { force: true }); throw hostError(CODES.CONFLICT, 'Owned output digest changed during private materialization'); }
        await fs.promises.rm(privatePath, { force: true }); await fs.promises.rename(pending, privatePath);
      }
      return { apiVersion: 2, importId, privatePath, byteLength: output.size, sha256: output.sha256, outputRef: { commitId, artifactId } };
    }
    if (payload.action === 'stage') {
      const createdAt = now(); const stageId = `${createdAt.toString(16)}-${crypto.randomUUID()}`;
      const root = stageRootFor(scope, stageId); const payloadRoot = path.join(root, 'payload');
      await fs.promises.mkdir(payloadRoot, { recursive: true });
      const stage = { id: stageId, scope: scope.key, scopeDigest: scopeDigest(scope), root, payloadRoot, projectRoot: scope.projectRoot, componentRoot: scope.componentRoot, componentId: descriptor.componentId, projectId: String(scope.project.id), createdAt, expiresAt: createdAt + STAGE_TTL_MS, files: [] };
      await persistStage(stage); outputStages.set(stageId, stage);
      return { apiVersion: 2, stageId, privatePath: payloadRoot, expiresAt: stage.expiresAt };
    }
    if (payload.action === 'commit') {
      const idempotencyKey = String(payload.idempotencyKey || '');
      if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
      return withOperation(commitOperations, `${scope.key}\0${idempotencyKey}`, () => commitStage(payload, scope, descriptor));
    }
    const stageId = String(payload.stageId || '');
    if (payload.action === 'rollback' && SAFE_STAGE_ID.test(stageId) && !outputStages.has(stageId) && !fs.existsSync(stageRootFor(scope, stageId))) return { apiVersion: 2, stageId, rolledBack: true };
    const stage = await resolveStage(payload, scope, descriptor);
    if (payload.action === 'write') {
      if (stage.files.length >= 2000) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many staged output files');
      const name = assertRelativePath(path, payload.name, 'output name');
      if (name.includes('/')) throw hostError(CODES.INVALID_REQUEST, 'Output name must be a file name');
      const outputRelativePath = assertRelativePath(path, payload.outputRelativePath, 'output relativePath');
      let sourceName = `${crypto.randomUUID()}-${name}`;
      let stagePath = path.join(stage.payloadRoot, sourceName);
      let hostCreated = false;
      if (payload.sourceName) { sourceName = assertRelativePath(path, payload.sourceName, 'staged sourceName'); stagePath = path.resolve(stage.payloadRoot, sourceName); }
      else if (payload.inputToken) { await fs.promises.copyFile(consumeInput(payload.inputToken, descriptor, context), stagePath, fs.constants.COPYFILE_EXCL); hostCreated = true; }
      else {
        const bytes = Buffer.from(String(payload.base64 || ''), 'base64');
        if (!bytes.length || bytes.length > MAX_INLINE_WRITE_BYTES) throw hostError(CODES.LIMIT_EXCEEDED, 'Inline output must be between 1 byte and 8 MiB');
        await fs.promises.writeFile(stagePath, bytes, { flag: 'wx' }); hostCreated = true;
      }
      const stagedStat = await fs.promises.lstat(stagePath).catch(() => null);
      if (!stagedStat?.isFile() || stagedStat.isSymbolicLink() || !inside(path, stage.payloadRoot, stagePath)) throw hostError(CODES.INVALID_REQUEST, 'Staged output source is missing or unsafe');
      if (!inside(path, await fs.promises.realpath(stage.payloadRoot), await fs.promises.realpath(stagePath))) throw hostError(CODES.PERMISSION_DENIED, 'Staged output source escapes through a linked directory');
      const replacement = payload.replace === true ? { previousCommitId: String(payload.previousCommitId || ''), previousArtifactId: String(payload.previousArtifactId || ''), expectedDigest: String(payload.expectedDigest || '').toLowerCase() } : null;
      if (replacement && (!SAFE_STAGE_ID.test(replacement.previousCommitId) || !SAFE_STAGE_ID.test(replacement.previousArtifactId) || !/^[a-f0-9]{64}$/.test(replacement.expectedDigest))) throw hostError(CODES.INVALID_REQUEST, 'Controlled replacement requires previousCommitId, previousArtifactId, and expectedDigest');
      const file = { artifactId: crypto.randomUUID(), sourceName, outputRelativePath, ...(replacement ? { replacement } : {}) };
      stage.files.push(file);
      try { await persistStage(stage); }
      catch (error) { stage.files.pop(); if (hostCreated) await fs.promises.rm(stagePath, { force: true }).catch(() => undefined); throw error; }
      return { apiVersion: 2, stageId: stage.id, artifactId: file.artifactId, byteLength: stagedStat.size };
    }
    if (payload.action === 'validate') { const inspected = await inspectStage(stage); return { apiVersion: 2, stageId: stage.id, valid: true, fileCount: inspected.fileCount, totalBytes: inspected.totalBytes }; }
    if (payload.action === 'rollback') { await rollbackPreparedReceiptsForStage(scope, stage.id); await cleanupStage(stage); return { apiVersion: 2, stageId: stage.id, rolledBack: true }; }
    throw hostError(CODES.INVALID_REQUEST, 'Unknown output action');
  });

  const createVersion = async (payload, scope) => {
    const commitId = String(payload.commitId || '');
    const receipt = await loadCommitReceipt(scope, commitId);
    if (!receipt || receipt.state !== 'committed') throw hostError(CODES.TOKEN_SCOPE, 'Committed output does not belong to this component project');
    const artifact = receipt.outputs.find(item => item.artifactId === String(payload.artifactId || ''));
    if (!artifact) throw hostError(CODES.NOT_FOUND, 'Committed output artifact was not found');
    if (!await outputMatches(scope, artifact)) throw hostError(CODES.CONFLICT, 'Committed output changed before version creation');
    const idempotencyKey = String(payload.idempotencyKey || '');
    if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
    const versionId = stableUuid(crypto, `component-version\0${scope.key}\0${idempotencyKey}`);
    const versionKey = `${scope.key}\0${idempotencyKey}`;
    if (createdVersions.has(versionKey)) return createdVersions.get(versionKey);
    const receiptPath = versionReceiptPath(scope, versionId);
    let versionReceipt = await readJson(fs, receiptPath);
    if (versionReceipt && (versionReceipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || versionReceipt.kind !== 'component-version' || versionReceipt.versionId !== versionId
      || versionReceipt.componentId !== scope.componentId || versionReceipt.projectId !== String(scope.project.id) || versionReceipt.scopeDigest !== scopeDigest(scope)
      || versionReceipt.idempotencyKey !== idempotencyKey || versionReceipt.photoId !== String(payload.photoId) || versionReceipt.parentVersionId !== String(payload.parentVersionId)
      || versionReceipt.commitId !== commitId || versionReceipt.artifactId !== artifact.artifactId)) throw hostError(CODES.PERMISSION_DENIED, 'Component version receipt is invalid or belongs to another scope');
    let bundle = await versionService.getPhoto(scope.workspaceRoot, String(payload.photoId || ''));
    if (String(bundle?.photo?.projectId || '') !== String(scope.project.id)) throw hostError(CODES.TOKEN_SCOPE, 'Version photo is outside the bound project');
    if (!(bundle.versions || []).some(item => String(item.id) === String(payload.parentVersionId || ''))) throw hostError(CODES.NOT_FOUND, 'Parent version was not found');
    const existing = (bundle.versions || []).find(item => String(item.id) === versionId);
    if (existing) {
      const expectedFilePath = path.resolve(scope.projectRoot, artifact.relativePath);
      if (String(existing.parentVersionId || '') !== String(payload.parentVersionId) || path.resolve(String(existing.filePath || '')) !== expectedFilePath) throw hostError(CODES.CONFLICT, 'Stable component version id is already bound to different content');
      const response = { apiVersion: 2, versionId, result: { success: true, ...bundle } };
      createdVersions.set(versionKey, response);
      if (!versionReceipt || versionReceipt.state !== 'committed') await replaceJson({ fs, crypto, filePath: receiptPath, value: { ...(versionReceipt || {}), schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-version', state: 'committed', versionId, idempotencyKey, componentId: scope.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), photoId: String(payload.photoId), parentVersionId: String(payload.parentVersionId), commitId, artifactId: artifact.artifactId, committedAt: Date.now() } }).catch(() => undefined);
      return response;
    }
    if (!versionReceipt) {
      versionReceipt = { schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-version', state: 'prepared', versionId, idempotencyKey, componentId: scope.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), photoId: String(payload.photoId), parentVersionId: String(payload.parentVersionId), commitId, artifactId: artifact.artifactId, createdAt: Date.now() };
      await replaceJson({ fs, crypto, filePath: receiptPath, value: versionReceipt });
    }
    const filePath = path.resolve(scope.projectRoot, artifact.relativePath);
    const result = await versionService.createVersion(scope.workspaceRoot, { photoId: String(payload.photoId), parentVersionId: String(payload.parentVersionId), versionId, filePath, versionName: String(payload.name || '组件输出').slice(0, 120), versionType: String(payload.type || 'component').slice(0, 40), note: String(payload.note || '').slice(0, 2000), isFinal: payload.isFinal === true, status: String(payload.status || 'draft').slice(0, 40) });
    const response = { apiVersion: 2, versionId, result };
    versionReceipt.state = 'committed'; versionReceipt.committedAt = Date.now();
    try { await replaceJson({ fs, crypto, filePath: receiptPath, value: versionReceipt }); }
    catch (error) { createdVersions.delete(versionKey); throw error; }
    createdVersions.set(versionKey, response);
    void ensureTrackedVersionThumbnail?.({ workspaceRoot: scope.workspaceRoot, photoId: payload.photoId, versionId, filePath });
    return response;
  };
  broker.register('version.create.v2', async (payload, context, descriptor) => {
    const scope = { ...bound(context, descriptor), componentId: descriptor.componentId };
    const idempotencyKey = String(payload.idempotencyKey || '');
    if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
    return withOperation(versionOperations, `${scope.key}\0${idempotencyKey}`, () => createVersion(payload, scope));
  });

  broker.register('component.media.v2', async (payload, context, descriptor) => {
    const scope = { ...bound(context, descriptor), componentId: descriptor.componentId };
    const relativePath = assertRelativePath(path, payload.relativePath, 'component media relativePath');
    const filePath = path.resolve(scope.componentRoot, relativePath);
    if (!inside(path, scope.componentRoot, filePath)) throw hostError(CODES.PERMISSION_DENIED, 'Component media escapes private storage');
    const stat = await fs.promises.lstat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || !inside(path, await fs.promises.realpath(scope.componentRoot), await fs.promises.realpath(filePath))) throw hostError(CODES.NOT_FOUND, 'Component private media is missing or unsafe');
    const opaqueRef = `component-media:v2:${stableUuid(crypto, `${scope.key}\0${relativePath}`)}`;
    if (['open', 'reveal'].includes(payload.action)) {
      const error = payload.action === 'reveal' && typeof shell.showItemInFolder === 'function' ? (shell.showItemInFolder(filePath), '') : await shell.openPath(payload.action === 'reveal' ? path.dirname(filePath) : filePath);
      if (error) throw hostError(CODES.INTERNAL, String(error));
      return { apiVersion: 2, opaqueRef, action: payload.action, opened: true };
    }
    if (payload.action !== 'variants') throw hostError(CODES.INVALID_REQUEST, 'Unknown component media action');
    mediaService.grantPath(filePath);
    const originalUrl = mediaService.toUrl(filePath, true);
    const requested = new Set(Array.isArray(payload.variants) ? payload.variants : ['thumbnail', 'preview']);
    if ([...requested].some(value => !['thumbnail', 'preview', 'original'].includes(value))) throw hostError(CODES.INVALID_REQUEST, 'Unknown component media variant');
    const variants = {};
    for (const [name, requestedSize] of [['thumbnail', 320], ['preview', 1600]]) if (requested.has(name)) {
      const generated = await mediaService.requestThumbnail({ filePath, kind: kindFor(filePath), cacheConfig: (readSavedConfig() || {}).mediaCache || {}, requestedSize, priority: 0, queueOrder: 0 });
      const url = generated?.previewUrl || generated?.mediaUrl;
      if (!url || (name === 'thumbnail' && url === originalUrl)) throw hostError(CODES.VARIANT_UNAVAILABLE, `${name} variant could not be generated`);
      variants[name] = { url, maxEdge: requestedSize, derived: true };
    }
    if (requested.has('original')) variants.original = { url: originalUrl, byteLength: stat.size, derived: false };
    return { apiVersion: 2, opaqueRef, variants };
  });

  const stripProgressPaths = value => Object.fromEntries(Object.entries(value || {}).filter(([field]) => !/(?:path|url)$/i.test(field)));
  const publicProgress = (scope, value) => {
    const result = stripProgressPaths(value);
    const folderPath = path.resolve(String(value?.folderPath || ''));
    if (folderPath && insideOrEqual(path, scope.projectRoot, folderPath)) result.contentRef = { relativeDirectory: normalizeRelativePath(path.relative(scope.projectRoot, folderPath)) };
    return result;
  };
  const progressSourceMetadata = (value, componentId) => {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw hostError(CODES.INVALID_REQUEST, 'Progress sourceMetadata must be an object');
    const supplied = value || {};
    const allowed = new Set(['category', 'role', 'displayName', 'componentId', 'parentCapability']);
    if (Object.keys(supplied).some(key => !allowed.has(key))) throw hostError(CODES.INVALID_REQUEST, 'Progress sourceMetadata has an unknown field');
    const normalized = { category: 'progress', parentCapability: 'structural' };
    for (const key of ['category', 'role', 'displayName']) if (supplied[key] !== undefined) {
      if (typeof supplied[key] !== 'string' || !supplied[key].trim() || supplied[key].length > 128 || /[\x00-\x1f\x7f]/.test(supplied[key])) throw hostError(CODES.INVALID_REQUEST, `Invalid progress sourceMetadata ${key}`);
      normalized[key] = supplied[key].trim();
    }
    if (supplied.parentCapability !== undefined) {
      if (!['structural', 'workflow-input', 'none'].includes(supplied.parentCapability)) throw hostError(CODES.INVALID_REQUEST, 'Invalid progress sourceMetadata parentCapability');
      normalized.parentCapability = supplied.parentCapability;
    }
    return { ...normalized, componentId };
  };
  broker.register('project.progress.v2', async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    if (payload.action === 'list') {
      const listed = await versionService.listProgress(scope.workspaceRoot, context.projectName, payload.includeMissing === true);
      return { apiVersion: 2, progress: (listed.progressFolders || []).map(item => publicProgress(scope, item)), edges: (listed.edges || listed.graphEdges || []).map(stripProgressPaths) };
    }
    if (payload.action === 'relate') {
      const result = await versionService.updateProgressRelation(scope.workspaceRoot, { childProgressId: String(payload.childProgressId || ''), parentProgressId: String(payload.parentProgressId || ''), expectedUpdatedAt: payload.expectedUpdatedAt });
      return { apiVersion: 2, result };
    }
    if (payload.action !== 'create') throw hostError(CODES.INVALID_REQUEST, 'Unknown project progress action');
    const mediaKind = String(payload.mediaKind || '');
    if (!['image', 'video'].includes(mediaKind)) throw hostError(CODES.INVALID_REQUEST, 'Progress mediaKind must be image or video');
    const versionKey = String(payload.versionKey || '').trim(); const parentProgressId = String(payload.parentProgressId || '').trim();
    if (!versionKey || versionKey.length > 128 || !parentProgressId) throw hostError(CODES.INVALID_REQUEST, 'Progress versionKey and parentProgressId are required');
    const sourceMetadata = progressSourceMetadata(payload.sourceMetadata, descriptor.componentId);
    const relativePath = assertRelativePath(path, payload.relativePath, 'progress relativePath');
    const resolution = projectVirtualPaths?.resolve ? projectVirtualPaths.resolve(scope.projectRoot, relativePath, { externalRootMode: 'target' }) : { physicalPath: path.resolve(scope.projectRoot, relativePath), viaExternalLink: false };
    const folderPath = path.resolve(resolution.physicalPath);
    if (!resolution.viaExternalLink && !inside(path, scope.projectRoot, folderPath)) throw hostError(CODES.PERMISSION_DENIED, 'Progress folder escapes the project');
    if (resolution.viaExternalLink && resolution.externalTargetKind === 'file') throw hostError(CODES.INVALID_REQUEST, 'Progress requires a folder boundary');
    const existing = await fs.promises.lstat(folderPath).catch(() => null);
    let createdDirectory = false;
    if (!existing) { await fs.promises.mkdir(folderPath, { recursive: false }); createdDirectory = true; }
    else if (!existing.isDirectory() || existing.isSymbolicLink()) throw hostError(CODES.INVALID_REQUEST, 'Progress target is not a safe folder');
    let registered;
    try {
      registered = await versionService.registerProgressWithGraph(scope.workspaceRoot, {
        projectName: context.projectName,
        progress: { mediaKind, versionKey, parentProgressId, displayName: String(payload.displayName || path.basename(folderPath)).slice(0, 160), folderPath, externalLinkRelativePath: resolution.viaExternalLink ? relativePath : undefined, sourceMetadata, relationKind: 'main', trackingEnabled: payload.trackingEnabled === true },
        workflowInputProgressIds: Array.isArray(payload.sourceProgressIds) ? [...new Set(payload.sourceProgressIds.map(String).filter(Boolean))].slice(0, 2000) : [],
      });
    } catch (error) { if (createdDirectory) await fs.promises.rmdir(folderPath).catch(() => undefined); throw error; }
    if (!registered?.success || !registered.progressFolder?.id) throw hostError(CODES.INTERNAL, registered?.error || 'Progress registration failed');
    return { apiVersion: 2, progress: publicProgress(scope, registered.progressFolder), edges: (registered.edges || []).map(stripProgressPaths) };
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
    if (['openOutput', 'revealOutput'].includes(payload.kind)) {
      const scope = { ...bound(context, descriptor), componentId: descriptor.componentId };
      const receipt = await loadCommitReceipt(scope, String(payload.commitId || ''));
      if (!receipt || receipt.state !== 'committed') throw hostError(CODES.NOT_FOUND, 'Committed output reference was not found');
      const output = receipt.outputs.find(item => item.artifactId === String(payload.artifactId || ''));
      if (!output || !await outputMatches(scope, output)) throw hostError(CODES.CONFLICT, 'Committed output is missing or changed');
      const filePath = path.resolve(scope.projectRoot, output.relativePath);
      let error = '';
      if (payload.kind === 'revealOutput' && typeof shell.showItemInFolder === 'function') shell.showItemInFolder(filePath);
      else error = await shell.openPath(payload.kind === 'revealOutput' ? path.dirname(filePath) : filePath);
      if (error) throw hostError(CODES.INTERNAL, String(error));
      return { apiVersion: 2, opened: true, outputRef: { commitId: receipt.commitId, artifactId: output.artifactId } };
    }
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

};

module.exports = {
  CURSOR_TTL_MS,
  INPUT_TOKEN_TTL_MS,
  MAX_INLINE_WRITE_BYTES,
  MAX_MEDIA_PAGE_SIZE,
  MAX_SETTINGS_BYTES,
  MAX_STAGE_BYTES,
  RECEIPT_SCHEMA_VERSION,
  STAGE_SCHEMA_VERSION,
  STAGE_TTL_MS,
  assertRelativePath,
  normalizeRelativePath,
  adoptLegacyOutputV1,
  registerComponentProjectCapabilities,
  resetComponentHostCapabilityStateForTest,
  stableUuid,
};
