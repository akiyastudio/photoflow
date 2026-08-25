const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { createConfigMutationService } = require('../electron/services/config-mutation-service.cjs');
const { registerDeprecatedTeamRetouchV1Capabilities: registerComponentProjectCapabilities, versionProjectPath } = require('../electron/compatibility/component-team-retouch-v1-adapter.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-team-service-'));
const workspace = path.join(sandbox, 'workspace');
const dataRoot = path.join(sandbox, 'workspace-data', 'key');
const componentDataRoot = path.join(dataRoot, 'team-retouch');
const projectRoot = path.join(workspace, 'active', 'Project');
const configPath = path.join(sandbox, 'config.json');
const selectedReturn = path.join(sandbox, 'selected-return.jpg');
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'one.jpg'), 'fixture');
fs.writeFileSync(configPath, JSON.stringify({ personDetection: { useGpu: false, oversizeCropMode: 'expand' } }));
fs.writeFileSync(selectedReturn, 'returned');
assert.deepEqual(versionProjectPath({ version: { filePath: path.join(projectRoot, 'missing.jpg'), fileMissing: true }, projectRoot, path, fs }), { relativePath: 'missing.jpg', relativePathState: 'missing' }, 'missing versions retain their safe historical project path');
assert.deepEqual(versionProjectPath({ version: { filePath: path.join(sandbox, 'outside.jpg'), fileMissing: true }, projectRoot, path, fs }), { relativePath: '', relativePathState: 'outside-project' }, 'unmanaged paths outside the bound project are never exposed');
const externalRoot = path.join(sandbox, 'external-media');
assert.deepEqual(versionProjectPath({ version: { filePath: path.join(externalRoot, 'nested', 'linked.jpg'), fileMissing: true }, projectRoot, externalLinks: [{ shortcutVirtualPath: 'RAW.lnk', externalTargetRoot: externalRoot, externalTargetKind: 'folder', offline: false }], path, fs }), { relativePath: 'RAW.lnk/nested/linked.jpg', relativePathState: 'missing' }, 'managed external versions retain only their virtual project path');
fs.mkdirSync(path.join(externalRoot, 'nested'), { recursive: true });
fs.writeFileSync(path.join(externalRoot, 'nested', 'linked.jpg'), 'external');
let externalMappingUsed = false;
const managedExternalPaths = { toVirtualPath: () => { externalMappingUsed = true; return 'RAW.lnk/nested/linked.jpg'; }, resolve: () => ({ physicalPath: path.join(externalRoot, 'nested', 'linked.jpg') }) };
assert.deepEqual(versionProjectPath({ version: { filePath: path.join(externalRoot, 'nested', 'linked.jpg'), fileMissing: false }, projectRoot, projectVirtualPaths: managedExternalPaths, externalLinks: [{ shortcutVirtualPath: 'RAW.lnk', externalTargetRoot: externalRoot, externalTargetKind: 'folder', offline: false }], path, fs }), { relativePath: 'RAW.lnk/nested/linked.jpg', relativePathState: 'external' });
assert(externalMappingUsed, 'online external media paths must use the existing managed virtual-path mapping');

const broker = new ComponentCapabilityBroker();
const readSavedConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
const configMutationService = createConfigMutationService({ fs, crypto: require('crypto'), getConfigPath: () => configPath, readSavedConfig });
const bundles = new Map();
const requestedPhotoIds = [];
let unavailableProjectPreviewPhotoId = '';
let hostIdentityCompletionCalls = 0;
const taskHandles = new Map();
const backgroundTasks = {
  create(definition) {
    const task = { ...definition, state: 'queued', progress: 0, metadata: definition.metadata || {} };
    const handle = {
      task, finished: false,
      context: { signal: { aborted: false }, report(progress, message, metadata) { Object.assign(task, { progress, message, metadata: { ...task.metadata, ...metadata } }); }, saveCheckpoint() {} },
      async waitForStart() { task.state = 'running'; }, isFinished() { return this.finished; },
      complete(message) { this.finished = true; Object.assign(task, { state: 'completed', progress: 100, message }); },
      fail(error) { this.finished = true; Object.assign(task, { state: 'failed', error: error.message }); }, snapshot() { return { ...task }; },
    };
    taskHandles.set(task.id, handle); return handle;
  },
  cancel(id) { const handle = taskHandles.get(id); if (!handle) return false; handle.context.signal.aborted = true; return true; },
  get(id) { return taskHandles.get(id)?.snapshot() || null; }, list() { return [...taskHandles.values()].map(handle => handle.snapshot()); },
};
registerComponentProjectCapabilities({
  broker,
  ensureWorkspace: value => { assert.equal(value, workspace); return workspace; },
  getWorkspaceDataRoot: () => dataRoot,
  resolveProjectEntry: (_workspace, status, projectName, relativePath) => path.join(workspace, status, projectName, relativePath),
  versionService: {
    getPhoto: async (_root, photoId) => { requestedPhotoIds.push(photoId); return bundles.get(photoId); },
    getMedia: async (_root, request) => {
      const existing = [...bundles.values()].find(item => (item.versions || []).some(version => path.resolve(version.filePath) === path.resolve(request.filePath)));
      if (existing) return existing;
      const bundle = {
        success: true, relativePath: 'one.jpg',
        photo: { id: 'photo-1', projectId: 'project-1', currentVersionId: 'version-1', displayName: 'one' },
        versions: [{ id: 'version-1', filePath: request.filePath, isCurrent: true }],
      };
      bundles.set('photo-1', bundle);
      return bundle;
    },
    completeTeamIdentity: async () => { hostIdentityCompletionCalls += 1; throw new Error('component must not use host identity completion'); },
  },
  IMAGE_EXTENSIONS: new Set(['.jpg']),
  path,
  fs,
  crypto: require('crypto'),
  getConfigPath: () => configPath,
  readSavedConfig, readConfig: configMutationService.read, mutateConfig: configMutationService.mutate,
  getProjectPath: (_root, status, projectName) => path.join(workspace, status, projectName),
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedReturn] }) }, mainWindow: {},
  mediaService: { grantPath: value => value, grantRoot: value => value, authorizeInput: async token => token.replace(/^media-token:/, ''), toUrl: value => `photoflow-media:${path.basename(value)}`, requestThumbnail: async () => ({ success: true, previewUrl: 'photoflow-media:generated-preview' }) },
  shell: { openPath: async () => '' }, backgroundTasks,
  getBoundProject: () => ({ id: 'project-1', name: 'Project', status: 'active' }),
  RAW_EXTENSIONS: new Set(['.dng']), IMAGE_PREVIEW_CONVERSION_EXTENSIONS: new Set(['.heic']),
});
broker.register('component.lifecycle.v1', payload => Object.keys(payload).every(field => ['action', 'repair'].includes(field)) ? { success: true, action: payload.action } : Promise.reject(new Error('lifecycle injection rejected')));
const legacyDescriptor = { componentId: 'team-retouch', service: { runtimeActions: [], capabilities: ['component.storage.v1', 'project.media.read.v1', 'project.output.authorize.v1', 'version.register.v1', 'tasks.report.v1', 'dialogs.open.v1', 'project.media.access.v1', 'component.settings.v1', 'component.lifecycle.v1'] } };
const inputTokens = new Map(); const outputStages = new Map(); const outputReceipts = new Map();
broker.register('component.storage.v2', async (_payload, ctx) => { const legacy = await broker.invoke(legacyDescriptor, 'component.storage.v1', { namespace: 'domain' }, ctx); return { apiVersion: 2, dataPath: legacy.dataRoot, databasePath: legacy.databasePath, projectId: legacy.projectId, ownership: 'component-private' }; });
broker.register('component.settings.v2', (payload, ctx) => broker.invoke(legacyDescriptor, 'component.settings.v1', payload.action === 'get' ? payload : { action: 'update', settings: payload.settings }, ctx).then(result => ({ apiVersion: 2, revision: result.revision, settings: result.settings })));
broker.register('project.media.variants.v2', async (payload, ctx) => {
  const listed = await broker.invoke(legacyDescriptor, 'project.media.read.v1', payload.relativePath ? { relativePaths: [payload.relativePath] } : { photoIds: [payload.photoId] }, ctx);
  const bundle = listed.items[0]; const version = (bundle?.versions || []).find(item => !payload.versionId || String(item.id) === String(payload.versionId)) || bundle?.versions?.find(item => item.isCurrent) || bundle?.versions?.at(-1);
  if (!bundle?.photo || !version) throw new Error('Media was not found');
  if (payload.photoId === unavailableProjectPreviewPhotoId && payload.variants?.includes('preview')) throw Object.assign(new Error('Preview variant could not be generated for C:\\private\\source.jpg'), { code: 'COMPONENT_HOST_VARIANT_UNAVAILABLE', retryable: true });
  const token = `component-input:v2:${require('crypto').randomUUID()}`; inputTokens.set(token, version.filePath);
  const original = `photoflow-media:${path.basename(version.filePath)}`;
  const preview = ['.dng', '.heic'].includes(path.extname(version.filePath).toLowerCase()) ? 'photoflow-media:generated-preview' : original;
  return { apiVersion: 2, mediaRef: { photoId: bundle.photo.id, versionId: version.id, relativePath: version.relativePath || bundle.relativePath }, metadata: { photoId: bundle.photo.id, versionId: version.id, currentVersionId: bundle.photo.currentVersionId || version.id, displayName: bundle.photo.displayName || '', originalName: bundle.photo.originalName || path.basename(version.filePath), relativePath: version.relativePath || bundle.relativePath || path.basename(version.filePath), isCurrent: Boolean(version.isCurrent), fileMissing: Boolean(version.fileMissing) }, variants: { ...(payload.variants?.includes('preview') ? { preview: { url: preview, maxEdge: 1600, derived: true } } : {}), ...(payload.variants?.includes('original') ? { original: { url: original, byteLength: fs.existsSync(version.filePath) ? fs.statSync(version.filePath).size : 0, derived: false } } : {}) }, ...(payload.variants?.includes('original') ? { input: { token, expiresAt: Date.now() + 60000 } } : {}) };
});
broker.register('project.media.page.v2', () => ({ apiVersion: 2, items: [], page: { hasMore: false, cursor: null, pageSize: 100 } }));
broker.register('project.input.tokens.v2', payload => { const source = inputTokens.get(payload.token); if (!source) throw new Error('Input token expired'); const inputId = require('crypto').randomUUID(); const directory = path.join(componentDataRoot, 'inputs', inputId); fs.mkdirSync(directory, { recursive: true }); const privatePath = path.join(directory, path.basename(source)); fs.copyFileSync(source, privatePath); return { apiVersion: 2, inputId, privatePath, byteLength: fs.statSync(privatePath).size }; });
broker.register('component.media.v2', async payload => { const filePath = path.join(dataRoot, 'team-retouch', payload.relativePath); if (!fs.existsSync(filePath)) throw Object.assign(new Error('Component private media is missing'), { code: 'COMPONENT_HOST_NOT_FOUND' }); const url = `photoflow-media:${path.basename(filePath)}`; return payload.action === 'variants' ? { apiVersion: 2, opaqueRef: `component-media:v2:${payload.relativePath}`, variants: { ...(payload.variants?.includes('preview') ? { preview: { url, maxEdge: 1600, derived: true } } : {}), ...(payload.variants?.includes('original') ? { original: { url, byteLength: fs.statSync(filePath).size, derived: false } } : {}) } } : { apiVersion: 2, opaqueRef: `component-media:v2:${payload.relativePath}`, action: payload.action, opened: true, success: true }; });
broker.register('dialogs.v2', async (payload, ctx) => { const legacy = await broker.invoke(legacyDescriptor, 'dialogs.open.v1', payload.multiple === false ? { kind: 'image', title: payload.title } : { action: 'select-images' }, ctx); const paths = legacy.filePath ? [legacy.filePath] : (legacy.tokens || []).map(token => token.replace(/^media-token:/, '')); const inputs = paths.map(filePath => { const token = `component-input:v2:${require('crypto').randomUUID()}`; inputTokens.set(token, filePath); return { name: path.basename(filePath), token, expiresAt: Date.now() + 60000 }; }); return { apiVersion: 2, cancelled: Boolean(legacy.cancelled), inputs }; });
broker.register('tasks.v2', async (payload, ctx) => { const legacy = await broker.invoke(legacyDescriptor, 'tasks.report.v1', { ...payload, kind: 'workspace-team-workflow' }, ctx); return { apiVersion: 2, task: legacy.task || null, cancelled: Boolean(legacy.cancelled) }; });
broker.register('component.events.v2', () => ({ apiVersion: 2, emitted: true }));
broker.register('component.lifecycle.v2', payload => ({ apiVersion: 2, success: true, action: payload.action, taskId: 'lifecycle-test', message: 'ok' }));
broker.register('project.progress.v2', async (_payload, ctx) => { const listed = await broker.invoke(legacyDescriptor, 'project.output.authorize.v1', { operation: 'merge', photoId: 'photo-1', baseVersionId: 'version-1', outputProgressId: 'unused' }, ctx).catch(() => null); return { apiVersion: 2, progress: listed ? [{ id: listed.outputProgressId, mediaKind: 'image', contentRef: { relativeDirectory: path.relative(projectRoot, path.dirname(listed.outputPath)).replace(/\\/g, '/') } }] : [], edges: [] }; });
broker.register('project.output.v2', async payload => {
  if (payload.action === 'stage') { const stageId = require('crypto').randomUUID(); const privatePath = path.join(dataRoot, 'team-retouch', 'v2-stages', stageId); fs.mkdirSync(privatePath, { recursive: true }); outputStages.set(stageId, { privatePath, files: [] }); return { apiVersion: 2, stageId, privatePath, expiresAt: Date.now() + 60000 }; }
  if (payload.action === 'adoptLegacyV1') { const commitId = require('crypto').randomUUID(); const outputs = payload.outputs.map(item => { const source = item.legacyAbsolutePath || path.join(projectRoot, item.relativePath); return { source, relativePath: path.relative(projectRoot, source).replace(/\\/g, '/') }; }).filter(item => fs.existsSync(item.source)).map(item => ({ artifactId: require('crypto').randomUUID(), relativePath: item.relativePath, sha256: require('crypto').createHash('sha256').update(fs.readFileSync(item.source)).digest('hex') })); const result = { apiVersion: 2, commitId, idempotencyKey: payload.migrationId, outputs }; outputReceipts.set(commitId, result); return result; }
  const stage = outputStages.get(payload.stageId);
  if (payload.action === 'write') { stage.files.push(payload); return { apiVersion: 2, stageId: payload.stageId, artifactId: require('crypto').randomUUID(), byteLength: fs.statSync(path.join(stage.privatePath, payload.sourceName)).size }; }
  if (payload.action === 'validate') return { apiVersion: 2, stageId: payload.stageId, valid: true, fileCount: stage.files.length, totalBytes: 1 };
  if (payload.action === 'rollback') { fs.rmSync(stage?.privatePath || '', { recursive: true, force: true }); return { apiVersion: 2, stageId: payload.stageId, rolledBack: true }; }
  if (payload.action === 'commit') { const commitId = require('crypto').randomUUID(); const outputs = stage.files.map(file => { const destination = path.join(projectRoot, file.outputRelativePath); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(stage.privatePath, file.sourceName), destination); return { artifactId: require('crypto').randomUUID(), relativePath: file.outputRelativePath, filePath: destination, byteLength: fs.statSync(destination).size, sha256: require('crypto').createHash('sha256').update(fs.readFileSync(destination)).digest('hex') }; }); const result = { apiVersion: 2, commitId, idempotencyKey: payload.idempotencyKey, outputs }; outputReceipts.set(commitId, result); return result; }
  throw new Error(`Unexpected output action: ${payload.action}`);
});
broker.register('version.create.v2', async (payload, ctx) => { const output = outputReceipts.get(payload.commitId)?.outputs.find(item => item.artifactId === payload.artifactId); const versionId = require('crypto').randomUUID(); const result = await broker.invoke(legacyDescriptor, 'version.register.v1', { versionId, photoId: payload.photoId, parentVersionId: payload.parentVersionId, versionName: payload.name, versionType: payload.type, note: payload.note, status: payload.status, isFinal: payload.isFinal, filePath: output.filePath }, ctx); return { apiVersion: 2, versionId, result }; });
const teamManifestService = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extensions', 'team-retouch', 'component.template.json'), 'utf8')).componentHost.service;
broker.register('notifications.v2', () => ({ apiVersion: 2, accepted: true, id: 'test-notification' }));
const manifestCapabilities = teamManifestService.capabilities;
const descriptor = { componentId: 'team-retouch', migrations: { legacyStorageV1: true, legacyOutputV1: true }, service: { runtimeActions: [], capabilities: manifestCapabilities, permissions: teamManifestService.permissions, events: teamManifestService.events } };
assert.equal(broker.assertCapabilities(descriptor), true, 'every capability declared by the real team service manifest must have a registered broker implementation');
const context = { workspacePath: workspace, projectId: 'project-1', projectName: 'Project', projectStatus: 'active' };
assert.throws(() => broker.invoke(legacyDescriptor, 'component.storage.v1', { namespace: 'arbitrary' }, context), /Unknown component storage namespace/);
assert.rejects(() => broker.invoke({ componentId: 'other-component', service: { capabilities: ['component.settings.v1'] } }, 'component.settings.v1', { action: 'get' }, context), /Unknown component settings namespace/);
assert.rejects(() => broker.invoke(legacyDescriptor, 'project.output.authorize.v1', { action: 'stage-inputs', tokens: ['C:/arbitrary.jpg'] }, context), /selector tokens/);
assert.rejects(() => broker.invoke(legacyDescriptor, 'version.register.v1', { action: 'team-return', photoId: 'other-photo', baseVersionId: 'version-1', taskId: 'task-1', stageId: '12345678', inputName: 'escape.jpg' }, context), /outside the bound project/);

const child = spawn(process.execPath, [path.join(__dirname, '..', 'extensions', 'team-retouch', 'service.cjs')], {
  env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'],
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
let nextRequestId = 1;
const pending = new Map();
const capabilityFrames = [];
const invoke = (method, payload = {}) => new Promise((resolve, reject) => {
  const id = String(nextRequestId++);
  pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload, context: { componentId: 'team-retouch', componentVersion: '1', projectId: 'project-1', projectName: 'Project', projectStatus: 'active' } })}\n`);
});

const ready = new Promise((resolve, reject) => {
  child.once('exit', code => reject(new Error(`service exited ${code}`)));
  lines.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'ready') { resolve(); return; }
    if (frame.type === 'capability') {
      capabilityFrames.push(frame);
      assert(manifestCapabilities.includes(frame.method), `service emitted undeclared capability frame: ${frame.method}`);
      assert(frame.method.endsWith('.v2'), `service emitted a non-V2 host capability frame: ${frame.method}`);
      Promise.resolve().then(() => broker.invoke(descriptor, frame.method, frame.payload, context)).then(
        result => child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: true, result })}\n`),
        error => child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: false, error: error.message, errorCode: error.code, retryable: error.retryable === true })}\n`),
      );
      return;
    }
    if (frame.type === 'response') {
      const request = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.ok) request.resolve(frame.result); else request.reject(new Error(frame.error));
    }
  });
});

(async () => {
  try {
    await ready;
    const startupStartedAt = Date.now();
    const [emptyStartupSnapshot, startupSettings, startupAdvancedStatus] = await Promise.all([
      invoke('team.project.get.v1'), invoke('team.settings.get.v1'), invoke('team.advanced.status.v1'),
    ]);
    assert.equal(emptyStartupSnapshot.photos.length, 0);
    assert.deepEqual(startupSettings.settings, { useGpu: false, oversizeCropMode: 'expand' });
    assert.equal(startupAdvancedStatus.advancedAvailable, false); assert(['not-installed', 'repair-needed'].includes(startupAdvancedStatus.state));
    assert(Date.now() - startupStartedAt < 2000, 'project, settings, and lightweight runtime status requests must not serialize into a self-wait');
    const registered = await invoke('team.project.register.v1', { relativePaths: ['one.jpg'], workspacePath: 'C:/escape' });
    assert.equal(registered.success, true);
    assert.equal(registered.photos.length, 1); assert.equal(registered.photos[0].photoId, 'photo-1');
    assert.equal((await invoke('team.project.get.v1')).photos[0].relativePath, 'one.jpg', 'registration must persist immediately and survive a fresh project snapshot');
    assert.equal((await invoke('team.project.register.v1', { relativePaths: ['one.jpg'] })).photos.length, 1, 're-registering the same controlled bundle is idempotent');
    const databasePath = path.join(dataRoot, 'databases', 'team-retouch.sqlite3');
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM team_retouch_photos WHERE project_id=? AND photo_id=?').get('project-1', 'photo-1').count, 1, 'register RPC writes the isolated team domain idempotently');
    db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('task-1', 'photo-1', 'version-1', 1, '人物 1', '{}', '{}', path.join(componentDataRoot, 'authorized-patch.png'), 1, 1);
    db.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('photo-other', 'project-other', 'version-other', 1, 1);
    const insertTask = db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    insertTask.run('task-other', 'photo-other', 'version-other', 1, '其他项目人物', '{}', '{}', path.join(componentDataRoot, 'other.png'), 1, 1);
    db.prepare('UPDATE team_patch_tasks SET edited_patch_path=? WHERE id=?').run(path.join(projectRoot, 'missing-other-return.png'), 'task-other');
    insertTask.run('task-orphan', 'photo-orphan', 'version-orphan', 1, '旧版孤立人物', '{}', '{}', path.join(componentDataRoot, 'orphan.png'), 1, 1);
    db.close();
    fs.mkdirSync(componentDataRoot, { recursive: true }); fs.writeFileSync(path.join(componentDataRoot, 'authorized-patch.png'), Buffer.alloc(1024 * 1024, 7));
    bundles.set('photo-1', {
      success: true,
      photo: { id: 'photo-1', projectId: 'project-1', currentVersionId: 'version-current', displayName: 'one' },
      versions: [{ id: 'version-1', filePath: path.join(projectRoot, 'one.jpg'), isCurrent: false }, { id: 'version-current', filePath: path.join(projectRoot, 'merged-output.jpg'), fileMissing: true, isCurrent: true }],
    });
    bundles.set('photo-other', { success: true, photo: { id: 'photo-other', projectId: 'project-other', currentVersionId: 'version-other' }, versions: [{ id: 'version-other', filePath: path.join(projectRoot, 'other.jpg') }] });
    bundles.set('photo-orphan', { success: true, photo: { id: 'photo-orphan', projectId: 'project-other', currentVersionId: 'version-orphan' }, versions: [{ id: 'version-orphan', filePath: path.join(projectRoot, 'orphan.jpg') }] });
    requestedPhotoIds.length = 0;
    const snapshot = await invoke('team.project.get.v1');
    assert.equal(snapshot.success, true);
    assert.equal(snapshot.photos[0].photoId, 'photo-1');
    assert.equal(snapshot.photos[0].relativePath, 'one.jpg', 'snapshot paths must follow the registered base version instead of the current merged output');
    assert.equal(snapshot.photos[0].sourcePath, undefined);
    assert.equal(snapshot.photos[0].tasks[0].patchPath, undefined, 'renderer responses must not disclose host media paths');
    assert(requestedPhotoIds.includes('photo-1'), 'the current project media is resolved through the host');
    assert(!requestedPhotoIds.includes('photo-orphan'), 'ownerless legacy tasks cannot borrow the current project Host scope');
    assert(!requestedPhotoIds.includes('photo-other'), 'registered tasks owned by another project must not expand the current project media query');
    assert(!snapshot.photos.some(photo => photo.photoId === 'photo-orphan' || photo.photoId === 'photo-other'), 'host-filtered orphan or foreign tasks must never leak into the snapshot');
    assert.equal(snapshot.migration.state, 'committed', 'another project missing output does not block the current project snapshot');
    const photoOneBundle = bundles.get('photo-1'); bundles.delete('photo-1'); const missingSnapshot = await invoke('team.project.get.v1'); bundles.set('photo-1', photoOneBundle);
    assert.equal(missingSnapshot.photos.find(photo => photo.photoId === 'photo-1')?.fileMissing, true, 'an expired historical media reference remains a missing card instead of rejecting the workspace');
    await invoke('team.project.migrate-step.v1');
    const markerDb = new DatabaseSync(databasePath); const markerHash = value => require('crypto').createHash('sha256').update(value).digest('hex').slice(0, 24);
    assert.equal(markerDb.prepare('SELECT value FROM meta WHERE key=?').get(`legacy_project_artifacts_v2:${markerHash('project-1')}`)?.value, 'committed');
    assert.equal(markerDb.prepare('SELECT value FROM meta WHERE key=?').get(`legacy_project_artifacts_v2:${markerHash('project-other')}`), undefined, 'project A marker must not hide project B migration'); markerDb.close();
    capabilityFrames.length = 0;
    const originalAccess = await invoke('team.media.authorize.v1', { kind: 'original', variant: 'original', photoId: 'photo-1', baseVersionId: 'version-1' });
    assert.equal(originalAccess.url, 'photoflow-media:one.jpg');
    assert.deepEqual(capabilityFrames.find(frame => frame.method === 'project.media.variants.v2')?.payload.variants, ['original']); assert.equal(originalAccess.previewUrl, undefined, 'explicit original authorization never carries an unrequested preview URL');
    assert.equal((await invoke('team.media.authorize.v1', { kind: 'working', variant: 'preview', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', filePath: 'C:/escape' })).url, 'photoflow-media:authorized-patch.png');
    assert.deepEqual(capabilityFrames.filter(frame => frame.method === 'component.media.v2').at(-1)?.payload.variants, ['preview'], 'working thumbnails request only the preview variant');
    const authorizedPatchPath = path.join(componentDataRoot, 'authorized-patch.png'); const unavailablePatchPath = `${authorizedPatchPath}.missing`; fs.renameSync(authorizedPatchPath, unavailablePatchPath);
    const missingWorkingPreview = await invoke('team.media.authorize.v1', { kind: 'working', variant: 'preview', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1' }); fs.renameSync(unavailablePatchPath, authorizedPatchPath);
    assert.deepEqual({ success: missingWorkingPreview.success, state: missingWorkingPreview.state, category: missingWorkingPreview.category, url: missingWorkingPreview.url }, { success: false, state: 'MISSING', category: 'history-reference-missing', url: undefined }, 'missing historical component media is a normal placeholder state');
    unavailableProjectPreviewPhotoId = 'photo-1'; const unavailablePreview = await invoke('team.media.authorize.v1', { kind: 'original', variant: 'preview', photoId: 'photo-1', baseVersionId: 'version-1' }); unavailableProjectPreviewPhotoId = '';
    assert.deepEqual({ success: unavailablePreview.success, state: unavailablePreview.state, category: unavailablePreview.category, url: unavailablePreview.url, originalUrl: unavailablePreview.originalUrl }, { success: false, state: 'MISSING', category: 'variant-unavailable', url: undefined, originalUrl: undefined }, 'preview generation failure is a normal path-free media state and never falls back to original');
    assert(!JSON.stringify(unavailablePreview).includes('private') && !JSON.stringify(unavailablePreview).includes('source.jpg'));
    assert.deepEqual(capabilityFrames.filter(frame => frame.method === 'project.media.variants.v2').at(-1)?.payload.variants, ['preview'], 'failed preview capability requests never include original');
    await assert.rejects(invoke('team.media.authorize.v1', { kind: 'original', variant: 'thumbnail', photoId: 'photo-1', baseVersionId: 'version-1' }), /Unsupported team media variant/, 'unknown media variants fail the strict service allowlist');
    assert.equal((await invoke('team.patch.open.v1', { photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1' })).success, true);
    const returnedPath = path.join(componentDataRoot, 'returned-patch.png'); fs.writeFileSync(returnedPath, 'returned');
    const returnedDb = new DatabaseSync(databasePath); returnedDb.prepare('UPDATE team_patch_tasks SET edited_patch_path=?,status=? WHERE id=?').run(returnedPath, 'uploaded', 'task-1'); returnedDb.close();
    assert.equal((await invoke('team.media.authorize.v1', { kind: 'returned', variant: 'preview', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1' })).url, 'photoflow-media:returned-patch.png');
    const returnedAuthorizations = await Promise.all(Array.from({ length: 141 }, () => invoke('team.media.authorize.v1', { kind: 'returned', variant: 'preview', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1' })));
    assert.equal(returnedAuthorizations.filter(result => result.url === 'photoflow-media:returned-patch.png').length, 141, 'returned media authorization remains stable for production assignment fan-out');
    const reviewDirectory = path.join(dataRoot, 'team-retouch', 'workflow-return-reviews', require('crypto').createHash('sha256').update('project-1').digest('hex'));
    fs.mkdirSync(reviewDirectory, { recursive: true }); const reviewPath = path.join(reviewDirectory, 'return-1.jpg'); fs.writeFileSync(reviewPath, 'review');
    fs.writeFileSync(path.join(reviewDirectory, 'session.json'), JSON.stringify({ id: 'review-session', projectName: 'Project', result: { matches: [{ returnId: 'return-1', path: reviewPath }] } }));
    assert.equal((await invoke('team.media.authorize.v1', { kind: 'review-return', variant: 'preview', reviewSessionId: 'review-session', returnId: 'return-1' })).url, 'photoflow-media:return-1.jpg');
    fs.rmSync(reviewDirectory, { recursive: true, force: true });
    const resetReturnedDb = new DatabaseSync(databasePath); resetReturnedDb.prepare('UPDATE team_patch_tasks SET edited_patch_path=NULL,status=? WHERE id=?').run('exported', 'task-1'); resetReturnedDb.close();
    const rawPath = path.join(projectRoot, 'camera.dng'); fs.writeFileSync(rawPath, 'raw');
    bundles.set('photo-raw', { success: true, photo: { id: 'photo-raw', projectId: 'project-1', currentVersionId: 'version-raw' }, versions: [{ id: 'version-raw', filePath: rawPath, isCurrent: true }] });
    const rawAccess = await invoke('team.media.authorize.v1', { kind: 'original', variant: 'original', photoId: 'photo-raw', baseVersionId: 'version-raw' });
    assert.deepEqual({ url: rawAccess.url, previewUrl: rawAccess.previewUrl, originalUrl: rawAccess.originalUrl }, { url: 'photoflow-media:camera.dng', previewUrl: undefined, originalUrl: 'photoflow-media:camera.dng' }, 'explicit RAW original access receives only the original URL');
    const heicPath = path.join(projectRoot, 'unsupported.heic'); fs.writeFileSync(heicPath, 'not-decodable');
    bundles.set('photo-heic', { success: true, photo: { id: 'photo-heic', projectId: 'project-1', currentVersionId: 'version-heic' }, versions: [{ id: 'version-heic', filePath: heicPath, isCurrent: true }] });
    await assert.rejects(invoke('team.patch.detect.v1', { photoId: 'photo-heic', baseVersionId: 'version-heic' }), /HEIC\/HEIF.*转换为 JPEG/, 'HEIC must be rejected with an actionable conversion error when no verified decoder is available');
    await assert.rejects(invoke('team.patch.open.v1', { photoId: 'photo-other', baseVersionId: 'version-other', taskId: 'task-other' }), /outside the bound project/, 'cross-project photo IDs must fail through the real service process');
    await assert.rejects(invoke('team.media.authorize.v1', { kind: 'working', variant: 'preview', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-other' }), /outside the bound photo version/, 'a task from another photo must not authorize media');
    await assert.rejects(invoke('team.identity.complete.v1', { photoId: 'photo-1', baseVersionId: 'other-version', personIndex: 1 }), /outside the bound photo/, 'cross-version completion must fail through the real service process');
    assert.equal((await invoke('team.advanced.preflight.v1')).action, 'preflight');
    const saved = await invoke('team.identity.save.v1', { name: '人物 A', assignments: [] });
    assert(saved.identityId);
    await invoke('team.identity.assign.v1', { photoId: 'photo-1', baseVersionId: 'version-1', personIndex: 1, identityId: saved.identityId, completed: false });
    assert.equal((await invoke('team.project.get.v1')).assignments[0].identityId, saved.identityId);
    const workflowSettings = await invoke('team.workflow.settings.save.v1', { preferredIdentityOrder: [saved.identityId], sameWeekIdentityIds: [] });
    assert.deepEqual(workflowSettings.workflowSettings.preferredIdentityOrder, [saved.identityId]);
    const similarityDirectory = path.join(dataRoot, 'team-retouch', 'identity-similarities');
    fs.mkdirSync(similarityDirectory, { recursive: true });
    fs.writeFileSync(path.join(similarityDirectory, `${require('crypto').createHash('sha256').update('Project').digest('hex')}.json`), JSON.stringify({ similarities: [{ left: 'a', right: 'b', score: .8 }] }));
    assert.equal((await invoke('team.identity.similarities.v1')).similarities[0].score, .8);
    const initialSettings = await invoke('team.settings.get.v1');
    assert.deepEqual(initialSettings.settings, { useGpu: false, oversizeCropMode: 'expand' }); assert.equal(initialSettings.revision, 0);
    const gpuPatch = await invoke('team.settings.update.v1', { useGpu: true });
    assert.deepEqual(gpuPatch.settings, { useGpu: true, oversizeCropMode: 'expand' }); assert.equal(gpuPatch.revision, 1, 'V1 adapter writes share the monotonic revision ledger');
    const cropPatch = await invoke('team.settings.update.v1', { oversizeCropMode: 'face-centered' });
    assert.deepEqual(cropPatch.settings, { useGpu: true, oversizeCropMode: 'face-centered' }); assert.equal(cropPatch.revision, 2);
    await configMutationService.mutate(current => { const componentSettings = { ...(current.componentSettings || {}) }; delete componentSettings['team-retouch']; return { ...current, personDetection: { useGpu: false, oversizeCropMode: 'expand' }, componentSettings, componentSettingsRevisions: { ...(current.componentSettingsRevisions || {}), 'team-retouch': 3 } }; });
    const tombstoneRead = await invoke('team.settings.get.v1');
    assert.deepEqual(tombstoneRead.settings, { useGpu: true, oversizeCropMode: 'face-centered' }, 'V1 adapter tombstones do not fall back to the legacy personDetection mirror');
    const tombstonePatch = await invoke('team.settings.update.v1', { useGpu: false });
    assert.deepEqual(tombstonePatch.settings, { useGpu: false, oversizeCropMode: 'face-centered' }, 'V1 updates after a tombstone start from runtime defaults rather than legacy values');
    const generated = await invoke('team.workflow.generate.v1', { operationId: 'workflow-real-process', replace: true, preferredIdentityOrder: [saved.identityId], groups: [{ week: 1, identityId: saved.identityId, identityName: '人物 A', items: [{ photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1, photoName: 'one' }] }] });
    assert.equal(generated.success, true, `a real supervised-style service process must generate workflow files: ${generated.error || ''}`);
    assert.equal(fs.existsSync(path.join(projectRoot, '团片协作', '第1周', '人物 A', 'one_人物1.png')), true);
    assert.equal((await invoke('team.workflow.status.v1')).job.state, 'completed');
    assert.equal((await invoke('team.workflow.cancel.v1', { operationId: 'missing-operation' })).cancelled, false);
    const workflowDirectory = path.join(projectRoot, '团片协作');
    const rollbackMarker = path.join(workflowDirectory, 'pre-replacement.marker');
    fs.writeFileSync(rollbackMarker, 'preserve-on-crash');
    const workflowDataDirectory = path.join(dataRoot, 'team-retouch', 'workflows');
    fs.rmSync(workflowDataDirectory, { recursive: true, force: true });
    fs.writeFileSync(workflowDataDirectory, 'simulate manifest-store crash');
    const rolledBack = await invoke('team.workflow.generate.v1', { operationId: 'workflow-rollback', replace: true, preferredIdentityOrder: [saved.identityId], groups: [{ week: 1, identityId: saved.identityId, identityName: '人物 A', items: [{ photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1, photoName: 'one' }] }] });
    assert.equal(rolledBack.success, false, 'a manifest-store crash must fail the replacement transaction');
    assert.equal(fs.readFileSync(rollbackMarker, 'utf8'), 'preserve-on-crash', 'a failed commit must restore the previous workflow directory');
    fs.rmSync(workflowDataDirectory, { force: true });
    fs.mkdirSync(workflowDataDirectory, { recursive: true });
    const selected = await invoke('team.patch.select-returns.v1');
    assert.equal(selected.files[0].startsWith('component-input:v2:'), true, 'the selector must return scoped V2 input tokens instead of paths');
    const migratedArtifacts = await invoke('team.workflow.artifact.migrate.v1', { from: { status: 'active', projectName: 'Project' }, to: { status: 'active', projectName: 'Project Renamed' } });
    assert.equal(migratedArtifacts.some(item => item.state === 'migrated'), true, 'artifact identity migration must execute inside the real component service process');
    await invoke('team.identity.complete.v1', { photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1, completed: true, completionKind: 'no-retouch' });
    assert.equal((await invoke('team.project.get.v1')).assignments[0].completionKind, 'no-retouch', 'identity completion is persisted by the component domain service');
    assert.equal(hostIdentityCompletionCalls, 0, 'identity completion no longer invokes the host-private capability');

    const chainRoot = path.join(dataRoot, 'team-retouch', 'photo-1', 'version-1', 'uploads');
    fs.mkdirSync(chainRoot, { recursive: true });
    const taskOnePrevious = path.join(chainRoot, 'task-one-previous.png');
    const taskOneLatest = path.join(chainRoot, 'task-one-latest.png');
    const taskTwoLatest = path.join(chainRoot, 'task-two-latest.png');
    const taskOneWork = path.join(chainRoot, 'task-one-work.png');
    const taskTwoWork = path.join(chainRoot, 'task-two-work.png');
    for (const filePath of [taskOnePrevious, taskOneLatest, taskTwoLatest, taskOneWork, taskTwoWork]) fs.writeFileSync(filePath, path.basename(filePath));
    const chainDb = new DatabaseSync(databasePath);
    chainDb.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,edited_patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('task-2', 'photo-1', 'version-1', 2, '人物 2', '{}', '{}', taskTwoWork, taskTwoLatest, 2, 2);
    chainDb.prepare(`INSERT OR IGNORE INTO team_task_stages(id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run('stage-task-1', 'task-1', 1, 1, 'complete', 1, 1);
    const taskOneStageId = chainDb.prepare(`SELECT id FROM team_task_stages WHERE task_id='task-1' AND person_index=1`).get().id;
    chainDb.prepare(`INSERT OR IGNORE INTO team_task_stages(id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run('stage-task-2', 'task-2', 2, 1, 'complete', 1, 1);
    const insertArtifact = chainDb.prepare(`INSERT INTO team_task_artifacts(id,task_id,stage_id,person_index,kind,artifact_path,created_at) VALUES(?,?,?,?,?,?,?)`);
    insertArtifact.run('artifact-task-1-old', 'task-1', taskOneStageId, 1, 'returned', taskOnePrevious, 100);
    insertArtifact.run('artifact-task-1-new', 'task-1', taskOneStageId, 1, 'returned', taskOneLatest, 200);
    insertArtifact.run('artifact-task-2-new', 'task-2', 'stage-task-2', 2, 'returned', taskTwoLatest, 300);
    chainDb.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status='uploaded' WHERE id='task-1'`).run(taskOneLatest);
    chainDb.prepare(`UPDATE team_patch_tasks SET patch_path=? WHERE id='task-1'`).run(taskOneWork);
    chainDb.prepare(`UPDATE team_person_assignments SET task_id='task-1',stage_id=?,artifact_id='artifact-task-1-new',edited_patch_path=?,completed=1,completion_kind='returned' WHERE photo_id='photo-1' AND base_version_id='version-1' AND person_index=1`).run(taskOneStageId, taskOneLatest);
    chainDb.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,confidence,source,completed,completion_kind,edited_patch_path,completed_at,updated_at,task_id,stage_id,artifact_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('project-1', 'photo-1', 'version-1', 2, 1, 'manual', 1, 'returned', taskTwoLatest, 300, 300, 'task-2', 'stage-task-2', 'artifact-task-2-new');
    chainDb.close();
    await invoke('team.patch.remove-upload.v1', { photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1 });
    const verifiedChainDb = new DatabaseSync(databasePath);
    assert.equal(verifiedChainDb.prepare("SELECT edited_patch_path FROM team_patch_tasks WHERE id='task-1'").get().edited_patch_path, taskOnePrevious, 'undo restores only the predecessor from the same task');
    assert.equal(verifiedChainDb.prepare("SELECT edited_patch_path FROM team_patch_tasks WHERE id='task-2'").get().edited_patch_path, taskTwoLatest, 'undo never borrows or changes another task return on the same photo');
    assert.equal(verifiedChainDb.prepare("SELECT is_deleted FROM team_task_artifacts WHERE id='artifact-task-1-new'").get().is_deleted, 1);
    assert.equal(verifiedChainDb.prepare("SELECT is_deleted FROM team_task_artifacts WHERE id='artifact-task-2-new'").get().is_deleted, 0);
    verifiedChainDb.close();

    const scaleDb = new DatabaseSync(databasePath);
    const insertPhoto = scaleDb.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)');
    const insertScaleTask = scaleDb.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (let index = 2; index <= 27; index += 1) {
      const photoId = `photo-${index}`; const versionId = `version-${index}`;
      insertPhoto.run(photoId, 'project-1', versionId, index, index);
      const photoPath = path.join(projectRoot, `${photoId}.jpg`); fs.writeFileSync(photoPath, 'photo');
      bundles.set(photoId, { success: true, photo: { id: photoId, projectId: 'project-1', currentVersionId: versionId, displayName: photoId }, versions: [{ id: versionId, filePath: photoPath }] });
    }
    for (let index = 2; index <= 79; index += 1) {
      const photoNumber = 2 + ((index - 2) % 26); const photoId = `photo-${photoNumber}`; const versionId = `version-${photoNumber}`;
      const patchPath = path.join(componentDataRoot, `current-${index}.png`); fs.writeFileSync(patchPath, 'patch');
      insertScaleTask.run(`task-current-${index}`, photoId, versionId, index, `人物 ${index}`, '{}', '{}', patchPath, index, index);
    }
    for (let index = 2; index <= 57; index += 1) insertPhoto.run(`photo-other-${index}`, 'project-other', `version-other-${index}`, index, index);
    for (let index = 2; index <= 163; index += 1) {
      const photoNumber = 2 + ((index - 2) % 56);
      insertScaleTask.run(`task-other-${index}`, `photo-other-${photoNumber}`, `version-other-${photoNumber}`, index, `其他人物 ${index}`, '{}', '{}', path.join(componentDataRoot, `other-${index}.png`), index, index);
    }
    scaleDb.close();
    requestedPhotoIds.length = 0;
    capabilityFrames.length = 0;
    const scaleStartedAt = Date.now();
    const scaledSnapshot = await invoke('team.project.get.v1');
    const scaleElapsedMs = Date.now() - scaleStartedAt;
    const scaleBytes = Buffer.byteLength(JSON.stringify(scaledSnapshot));
    const snapshotMediaReadCount = requestedPhotoIds.length;
    assert.equal(scaledSnapshot.photos.length, 27, 'a production-sized snapshot returns only the bound project photos');
    assert.equal(capabilityFrames.filter(frame => frame.method === 'project.input.tokens.v2').length, 0, 'project snapshots describe media without materializing original pixels');
    assert(!JSON.stringify(scaledSnapshot).includes('privatePath'), 'project snapshots retain stable IDs and opaque refs rather than materialized paths');
    capabilityFrames.length = 0; await invoke('team.project.get.v1');
    assert.equal(capabilityFrames.filter(frame => frame.method === 'project.input.tokens.v2').length, 0, 'repeated project loads do not grow component-private inputs');
    assert.equal(new Set(scaledSnapshot.photos.map(photo => photo.relativePath)).size, 27, 'every registered photo keeps one unique project-relative base path');
    assert(scaledSnapshot.photos.every(photo => photo.relativePath && !path.isAbsolute(photo.relativePath) && !photo.relativePath.split(/[\\/]/).includes('..')), 'all snapshot paths remain non-empty and inside the project namespace');
    const originalAuthorizations = await Promise.all(scaledSnapshot.photos.map(photo => invoke('team.media.authorize.v1', { kind: 'original', variant: 'preview', photoId: photo.photoId, baseVersionId: photo.baseVersionId })));
    assert.equal(originalAuthorizations.filter(result => result.url).length, 27, 'all production-sized original previews receive a loadable URL');
    const workingRequests = scaledSnapshot.photos.flatMap(photo => photo.tasks.map(task => ({ kind: 'working', variant: 'preview', photoId: photo.photoId, baseVersionId: photo.baseVersionId, taskId: task.id })));
    const workingAuthorizations = await Promise.all(workingRequests.map(request => invoke('team.media.authorize.v1', request)));
    assert.equal(workingAuthorizations.filter(result => result.url).length, 80, 'all production-sized working previews receive a loadable URL');
    assert.equal(scaledSnapshot.photos.reduce((total, photo) => total + photo.tasks.length, 0), 80, 'a production-sized snapshot retains all bound project tasks');
    assert(snapshotMediaReadCount <= 28, `84 registered photos plus one legacy orphan must require at most 28 snapshot media reads, received ${snapshotMediaReadCount}`);
    assert(scaleBytes < 2 * 1024 * 1024, `the production-sized snapshot must fit one bounded protocol frame, received ${scaleBytes} bytes`);
    assert(scaleElapsedMs < 5000, `the production-sized snapshot should not approach the 60s RPC timeout, took ${scaleElapsedMs}ms`);
    const patchBundles = await Promise.all(scaledSnapshot.photos.map(photo => invoke('team.patch.get.v1', { relativePath: photo.relativePath })));
    assert(patchBundles.every(bundle => bundle.success !== false), 'every restored project path must resolve through team.patch.get.v1');
    assert.equal(patchBundles.reduce((total, bundle) => total + bundle.tasks.length, 0), 80, 'restored project paths must associate all existing tasks with their registered photos');
    console.log(`Production-sized team snapshot: ${scaledSnapshot.photos.length} photos / ${scaledSnapshot.photos.reduce((total, photo) => total + photo.tasks.length, 0)} tasks / ${snapshotMediaReadCount} snapshot media reads / ${scaleBytes} bytes / ${scaleElapsedMs}ms`);
    const assignmentReturnedPath = path.join(componentDataRoot, 'assignment-returned.png'); fs.writeFileSync(assignmentReturnedPath, 'assignment-returned');
    const assignmentReturnedDb = new DatabaseSync(databasePath); assignmentReturnedDb.prepare('UPDATE team_person_assignments SET edited_patch_path=?,completed=1,completion_kind=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').run(assignmentReturnedPath, 'returned', 'project-1', 'photo-1', 'version-1', 1); assignmentReturnedDb.close();
    assert.equal((await invoke('team.media.authorize.v1', { kind: 'returned', variant: 'preview', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1 })).url, 'photoflow-media:assignment-returned.png', 'person-scoped returned references resolve the assignment artifact instead of the shared task return');
    await invoke('team.identity.delete.v1', { identityId: saved.identityId });
    assert.equal((await invoke('team.project.get.v1')).identities.length, 0);
    console.log('Team-retouch component service integration tests passed');
  } finally {
    lines.close();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (error) { if (error.code !== 'EPERM') throw error; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
