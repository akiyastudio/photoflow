const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseComponentHostManifest, HOST_CAPABILITIES } = require('../electron/component-host-contract.cjs');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { registerComponentProjectCapabilities } = require('../electron/services/component-project-capabilities.cjs');
const { createMediaRepository } = require('../electron/domains/media/public.cjs');
const { createVersionService } = require('../electron/services/version-service.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-host-v2-'));
const workspaceRoot = path.join(sandbox, 'workspace');
const projectRoot = path.join(workspaceRoot, 'active', 'Project');
const dataRoot = path.join(workspaceRoot, '.data');
const imagePath = path.join(projectRoot, 'images', 'one.jpg');
const configPath = path.join(sandbox, 'config.json');
fs.mkdirSync(path.dirname(imagePath), { recursive: true });
fs.mkdirSync(dataRoot, { recursive: true });
fs.writeFileSync(imagePath, Buffer.from('jpeg-fixture'));
fs.writeFileSync(configPath, '{}');

const calls = [];
const bundle = {
  photo: { id: 'photo-1', projectId: 'project-1', originalName: 'one.jpg' },
  versions: [{ id: 'version-1', photoId: 'photo-1', filePath: imagePath, isCurrent: true }],
};
const databaseClient = {
  call: async (_root, action, payload) => {
    calls.push({ action, payload });
    if (action === 'media_get' || action === 'media_get_photo') return bundle;
    if (action === 'media_create_version') return { success: true, created: payload, ...bundle };
    throw new Error(`Unexpected media repository action: ${action}`);
  },
  stop() {},
};
const repository = createMediaRepository(databaseClient);
const versionService = createVersionService({ repository });
assert.equal(typeof versionService.createVersion, 'function');
assert.equal(versionService.completeTeamIdentity, undefined, 'the production media repository composition exposes only generic version operations');
assert.equal(versionService.listTeamPatches, undefined, 'the production media repository composition must not pretend to expose component-owned tables');

const manifestRoot = path.join(sandbox, 'manifest');
fs.mkdirSync(path.join(manifestRoot, 'ui'), { recursive: true });
fs.writeFileSync(path.join(manifestRoot, 'ui', 'index.html'), '<!doctype html>');
fs.writeFileSync(path.join(manifestRoot, 'service.cjs'), '');
const allV2Capabilities = [...HOST_CAPABILITIES].filter(value => value.endsWith('.v2'));
const allPermissions = ['project.media.read', 'project.input.read', 'project.output.write', 'project.version.create', 'component.storage', 'component.settings', 'tasks', 'dialogs', 'events', 'component.lifecycle.read'];
const manifest = {
  apiVersion: 1, id: 'fixture-component', version: '1.0.0',
  componentHost: {
    contractVersion: 2, compatibility: { minHostApiVersion: 2, maxHostApiVersion: 3 },
    contributions: [
      { type: 'workspace.toolbarAction', id: 'open', label: 'Fixture', pageId: 'main' },
      { type: 'component.fullPage', id: 'main', title: 'Fixture', entry: 'ui/index.html' },
    ],
    service: {
      protocolVersion: 1, runtime: 'node', entrypoints: { default: 'service.cjs' }, rpcMethods: ['fixture.run.v1'],
      capabilities: allV2Capabilities, permissions: allPermissions, events: ['fixture.progress.v1'], runtimeActions: [],
    },
  },
};
const descriptor = parseComponentHostManifest(manifest, manifestRoot);
assert.equal(descriptor.hostApiVersion, 2);
assert.deepEqual(descriptor.service.permissions, allPermissions);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, service: { ...manifest.componentHost.service, permissions: allPermissions.filter(value => value !== 'project.output.write') } } }, manifestRoot), /requires permission project\.output\.write/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 3, maxHostApiVersion: 4 } } }, manifestRoot), /do not overlap/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, unsafeExtension: true } }, manifestRoot), /Unknown component host field/);
for (const schema of ['component-manifest-v2.schema.json', 'component-host-api-v2.schema.json']) JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'contracts', 'schemas', schema), 'utf8'));

const broker = new ComponentCapabilityBroker();
const thumbnailRequests = [];
let returnOriginalAsThumbnail = false;
const originalUrl = 'photoflow-media://original/one.jpg';
const mediaService = {
  grantPath: value => value,
  toUrl: () => originalUrl,
  requestThumbnail: async request => {
    thumbnailRequests.push(request);
    return { previewUrl: returnOriginalAsThumbnail ? originalUrl : `photoflow-media://derived/${request.requestedSize}/one.jpg` };
  },
};
const taskHandles = new Map();
const backgroundTasks = {
  create(definition) {
    let finished = false;
    const controller = new AbortController();
    const snapshot = { id: definition.id, state: 'running', checkpoint: definition.checkpoint, metadata: definition.metadata };
    const handle = {
      task: snapshot,
      context: { signal: controller.signal, report: (progress, message) => Object.assign(snapshot, { progress, message }), saveCheckpoint: checkpoint => { snapshot.checkpoint = checkpoint; } },
      waitForStart: async () => undefined, isFinished: () => finished, snapshot: () => ({ ...snapshot }),
      complete: message => { finished = true; Object.assign(snapshot, { state: 'completed', message }); },
      fail: error => { finished = true; Object.assign(snapshot, { state: 'failed', error: error.message }); },
    };
    taskHandles.set(snapshot.id, { handle, controller }); return handle;
  },
  get: id => taskHandles.get(id)?.handle.snapshot() || null,
  cancel: id => { const found = taskHandles.get(id); if (!found) return false; found.controller.abort(); found.handle.task.state = 'cancelled'; return true; },
};
let config = {};
registerComponentProjectCapabilities({
  broker, ensureWorkspace: value => path.resolve(value), getWorkspaceDataRoot: () => dataRoot,
  resolveProjectEntry: (_workspace, _status, _name, relative) => path.join(projectRoot, relative),
  versionService, IMAGE_EXTENSIONS: new Set(['.jpg']), VIDEO_EXTENSIONS: new Set(['.mp4']), RAW_EXTENSIONS: new Set(['.cr3']),
  path, fs, crypto, getConfigPath: () => configPath, readSavedConfig: () => config,
  getProjectPath: () => projectRoot,
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 1 }) }, mainWindow: {},
  mediaService, backgroundTasks, ensureTrackedVersionThumbnail: async () => undefined,
  getBoundProject: () => ({ id: 'project-1', name: 'Project', status: 'active' }),
});
assert(broker.assertCapabilities(descriptor));
const context = { componentId: descriptor.componentId, componentVersion: descriptor.componentVersion, workspacePath: workspaceRoot, projectId: 'project-1', projectName: 'Project', projectStatus: 'active', emitComponentEvent: (topic, event) => { context.lastEvent = { topic, event }; } };

(async () => {
  const firstPage = await broker.invoke(descriptor, 'project.media.page.v2', { pageSize: 1, kinds: ['image'] }, context);
  assert.equal(firstPage.items[0].relativePath, 'images/one.jpg');
  const variants = await broker.invoke(descriptor, 'project.media.variants.v2', { photoId: 'photo-1', versionId: 'version-1', variants: ['thumbnail', 'preview', 'original'] }, context);
  assert.notEqual(variants.variants.thumbnail.url, variants.variants.original.url, 'a JPEG thumbnail must be a generated derivative rather than its original URL');
  assert.deepEqual(thumbnailRequests.map(item => item.requestedSize), [320, 1600]);
  returnOriginalAsThumbnail = true;
  await assert.rejects(broker.invoke(descriptor, 'project.media.variants.v2', { relativePath: 'images/one.jpg', variants: ['thumbnail'] }, context), error => error.code === 'COMPONENT_HOST_VARIANT_UNAVAILABLE');
  returnOriginalAsThumbnail = false;

  const materialized = await broker.invoke(descriptor, 'project.input.tokens.v2', { action: 'materialize', token: variants.input.token }, context);
  assert(fs.existsSync(materialized.privatePath));
  await assert.rejects(broker.invoke(descriptor, 'project.input.tokens.v2', { action: 'materialize', token: variants.input.token }, context), error => error.code === 'COMPONENT_HOST_TOKEN_EXPIRED', 'input grants are single-use');

  const storage = await broker.invoke(descriptor, 'component.storage.v2', {}, context);
  assert(storage.dataPath.startsWith(path.join(dataRoot, 'components', descriptor.componentId)));
  const saved = await broker.invoke(descriptor, 'component.settings.v2', { action: 'replace', settings: { quality: 90 } }, context);
  assert.equal(saved.revision, 1); config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.componentSettings[descriptor.componentId].quality, 90);

  const stage = await broker.invoke(descriptor, 'project.output.v2', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output.v2', { action: 'write', stageId: stage.stageId, name: 'result.jpg', outputRelativePath: 'exports/result.jpg', base64: Buffer.from('output').toString('base64') }, context);
  const validated = await broker.invoke(descriptor, 'project.output.v2', { action: 'validate', stageId: stage.stageId }, context);
  assert.equal(validated.fileCount, 1);
  const committed = await broker.invoke(descriptor, 'project.output.v2', { action: 'commit', stageId: stage.stageId, idempotencyKey: 'export-001' }, context);
  assert(fs.existsSync(path.join(projectRoot, 'exports', 'result.jpg')));
  const replay = await broker.invoke(descriptor, 'project.output.v2', { action: 'commit', stageId: stage.stageId, idempotencyKey: 'export-001' }, context);
  assert.equal(replay.commitId, committed.commitId, 'commit retries return the first result without addressing the consumed stage');

  const created = await broker.invoke(descriptor, 'version.create.v2', { commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, photoId: 'photo-1', parentVersionId: 'version-1', idempotencyKey: 'version-001', name: 'Fixture output' }, context);
  const createdAgain = await broker.invoke(descriptor, 'version.create.v2', { commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, photoId: 'photo-1', parentVersionId: 'version-1', idempotencyKey: 'version-001', name: 'Fixture output' }, context);
  assert.equal(createdAgain.versionId, created.versionId);
  assert.equal(calls.filter(item => item.action === 'media_create_version').length, 1, 'generic version creation is idempotent through the real media repository/service composition');

  const started = await broker.invoke(descriptor, 'tasks.v2', { action: 'start', operationId: 'fixture-task', title: 'Fixture' }, context);
  await broker.invoke(descriptor, 'tasks.v2', { action: 'report', operationId: 'fixture-task', progress: 25, checkpoint: { page: 1 } }, context);
  await broker.invoke(descriptor, 'tasks.v2', { action: 'complete', operationId: 'fixture-task', message: 'Paused fixture' }, context);
  const resumed = await broker.invoke(descriptor, 'tasks.v2', { action: 'resume', operationId: 'fixture-task', checkpoint: { page: 1 } }, context);
  const cancelled = await broker.invoke(descriptor, 'tasks.v2', { action: 'cancel', operationId: 'fixture-task' }, context);
  assert(started.task && resumed.task.checkpoint.page === 1 && cancelled.cancelled);
  assert((await broker.invoke(descriptor, 'dialogs.v2', { kind: 'confirm', title: 'Confirm', message: 'Continue?' }, context)).confirmed);
  await broker.invoke(descriptor, 'component.events.v2', { topic: 'fixture.progress.v1', event: { progress: 50 } }, context);
  assert.deepEqual(context.lastEvent, { topic: 'fixture.progress.v1', event: { progress: 50 } });
  assert.equal((await broker.invoke(descriptor, 'component.lifecycle.v2', { action: 'describe' }, context)).negotiatedHostApiVersion, 2);

  const genericSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'services', 'component-project-capabilities.cjs'), 'utf8');
  for (const forbidden of ['team-retouch', 'edited_patch_path', 'team_patch_tasks', '团片']) assert(!genericSource.includes(forbidden), `generic host source must not contain ${forbidden}`);
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  assert(!packageJson.scripts.build.includes('team-retouch') && !genericSource.includes('extensions/'), 'the main application build and V2 host must not require a component source package');
  console.log('Component Host API V2 contract and integration tests passed');
})().finally(() => fs.rmSync(sandbox, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
