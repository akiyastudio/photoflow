const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseComponentHostManifest, HOST_CAPABILITIES } = require('../electron/component-host-contract.cjs');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { registerComponentProjectCapabilities, resetComponentHostCapabilityStateForTest, stableUuid, STAGE_TTL_MS } = require('../electron/services/component-project-capabilities.cjs');
const { createServiceHostClient } = require('../component-sdk/service.cjs');
const { createMediaRepository } = require('../electron/domains/media/public.cjs');
const { createVersionService } = require('../electron/services/version-service.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-host-v2-'));
const workspaceRoot = path.join(sandbox, 'workspace');
const projectRoot = path.join(workspaceRoot, 'active', 'Project');
const dataRoot = path.join(workspaceRoot, '.data');
const imagePath = path.join(projectRoot, 'images', 'one.jpg');
const externalRoot = path.join(sandbox, 'managed-external');
const externalImagePath = path.join(externalRoot, 'outside.jpg');
const configPath = path.join(sandbox, 'config.json');
fs.mkdirSync(path.dirname(imagePath), { recursive: true });
fs.mkdirSync(dataRoot, { recursive: true });
fs.writeFileSync(imagePath, Buffer.from('jpeg-fixture'));
fs.mkdirSync(externalRoot, { recursive: true });
fs.writeFileSync(externalImagePath, Buffer.from('external-jpeg-fixture'));
fs.writeFileSync(configPath, '{}');

const calls = [];
const bundle = {
  photo: { id: 'photo-1', projectId: 'project-1', originalName: 'one.jpg' },
  versions: [{ id: 'version-1', photoId: 'photo-1', filePath: imagePath, isCurrent: true }],
};
const externalBundle = { photo: { id: 'photo-external', projectId: 'project-1', originalName: 'outside.jpg' }, versions: [{ id: 'version-external', photoId: 'photo-external', filePath: externalImagePath, isCurrent: true }] };
const bundles = new Map([['photo-1', bundle], ['photo-external', externalBundle]]);
const databaseClient = {
  call: async (_root, action, payload) => {
    calls.push({ action, payload });
    if (action === 'media_get_photo') return bundles.get(String(payload.photoId));
    if (action === 'media_get') return path.resolve(payload.filePath) === path.resolve(externalImagePath) ? externalBundle : bundle;
    if (action === 'progress_list') return { success: true, progressFolders: [{ id: 'progress-original', mediaKind: 'image', nodeRole: 'original', folderPath: projectRoot }], edges: [] };
    if (action === 'progress_register_with_graph') return { success: true, progressFolder: { id: 'progress-created', mediaKind: payload.progress.mediaKind, nodeRole: 'progress', folderPath: payload.progress.folderPath, sourceMetadata: payload.progress.sourceMetadata }, edges: [{ id: 'edge-created', sourceProgressId: payload.progress.parentProgressId, targetProgressId: 'progress-created' }] };
    if (action === 'progress_relation_update') return { success: true, childProgressId: payload.childProgressId, parentProgressId: payload.parentProgressId };
    if (action === 'media_create_version') {
      const target = bundles.get(String(payload.photoId));
      if (!(target.versions || []).some(item => item.id === payload.versionId)) target.versions.push({ id: payload.versionId, photoId: payload.photoId, parentVersionId: payload.parentVersionId, filePath: payload.filePath, isCurrent: true });
      return { success: true, created: payload, ...target };
    }
    throw new Error(`Unexpected media repository action: ${action}`);
  },
  stop() {},
};
const repository = createMediaRepository(databaseClient);
const versionService = createVersionService({ repository });
assert.equal(typeof versionService.createVersion, 'function');
assert.equal(versionService.completeTeamIdentity, undefined, 'the production media repository composition exposes only generic version operations');
assert.equal(versionService.listComponentPrivateRows, undefined, 'the production media repository composition must not expose component-owned tables');

const manifestRoot = path.join(sandbox, 'manifest');
fs.mkdirSync(path.join(manifestRoot, 'ui'), { recursive: true });
fs.writeFileSync(path.join(manifestRoot, 'ui', 'index.html'), '<!doctype html>');
fs.writeFileSync(path.join(manifestRoot, 'ui', 'settings.html'), '<!doctype html>');
fs.writeFileSync(path.join(manifestRoot, 'service.cjs'), '');
const allV2Capabilities = [...HOST_CAPABILITIES].filter(value => value.endsWith('.v2'));
const allPermissions = ['project.media.read', 'project.input.read', 'project.output.write', 'project.version.create', 'component.storage', 'component.settings', 'tasks', 'dialogs', 'events', 'component.lifecycle.read', 'component.lifecycle.manage', 'component.media', 'project.progress'];
const manifest = {
  apiVersion: 1, id: 'fixture-component', version: '1.0.0',
  componentHost: {
    contractVersion: 2, compatibility: { minHostApiVersion: 3, maxHostApiVersion: 3 },
    adoptionGrants: ['component.storage.previous.v1', 'project.output.existing.v1'],
    contributions: [
      { type: 'workspace.toolbarAction', id: 'open', label: 'Fixture', pageId: 'main' },
      { type: 'component.fullPage', id: 'main', title: 'Fixture', entry: 'ui/index.html' },
      { type: 'application.settingsPage', id: 'settings', label: 'Fixture settings', title: 'Fixture settings page', entry: 'ui/settings.html', rpcMethods: ['fixture.settings.v1'] },
    ],
    service: {
      protocolVersion: 1, runtime: 'node', entrypoints: { default: 'service.cjs' }, rpcMethods: ['fixture.run.v1', 'fixture.settings.v1'],
      capabilities: allV2Capabilities.filter(value => value !== 'notifications.v2'), permissions: allPermissions, events: ['fixture.progress.v1'], runtimeActions: [],
    },
  },
};
const descriptor = parseComponentHostManifest(manifest, manifestRoot);
assert.equal(descriptor.hostApiVersion, 3);
const hostApi4Descriptor = parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 4, maxHostApiVersion: 4 }, service: { ...manifest.componentHost.service, capabilities: allV2Capabilities, permissions: [...allPermissions, 'notifications'] } } }, manifestRoot);
assert.equal(hostApi4Descriptor.hostApiVersion, 4, 'notifications negotiate Host API 4');
assert(hostApi4Descriptor.service.capabilities.includes('notifications.v2') && hostApi4Descriptor.service.permissions.includes('notifications'));
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, service: { ...manifest.componentHost.service, capabilities: [...manifest.componentHost.service.capabilities, 'notifications.v2'], permissions: [...allPermissions, 'notifications'] } } }, manifestRoot), /minHostApiVersion 4/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, service: { ...manifest.componentHost.service, permissions: [...allPermissions, 'notifications'] } } }, manifestRoot), /minHostApiVersion 4/, 'permission-only notification declarations also require API4');
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 4, maxHostApiVersion: 4 }, service: { ...manifest.componentHost.service, capabilities: [...allV2Capabilities, ' notifications.v2'], permissions: [...allPermissions, 'notifications'] } } }, manifestRoot), /exact and unique/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 4, maxHostApiVersion: 4 }, service: { ...manifest.componentHost.service, capabilities: allV2Capabilities, permissions: [...allPermissions, 'notifications', 'notifications'] } } }, manifestRoot), /exact and unique/);
const hostApi2Descriptor = parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 2, maxHostApiVersion: 2 }, contributions: manifest.componentHost.contributions.filter(item => item.type !== 'application.settingsPage') } }, manifestRoot);
assert.equal(hostApi2Descriptor.hostApiVersion, 2, 'existing Component Host V2 components without settings pages continue to negotiate Host API 2');
assert.deepEqual(descriptor.settingsPages.map(page => ({ id: page.id, label: page.label, relativeEntry: page.relativeEntry, rpcMethods: page.rpcMethods })), [{ id: 'settings', label: 'Fixture settings', relativeEntry: 'ui/settings.html', rpcMethods: ['fixture.settings.v1'] }]);
assert.deepEqual(descriptor.service.permissions, allPermissions);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: manifest.componentHost.contributions.map(item => item.type === 'application.settingsPage' ? { ...item, rpcMethods: ['fixture.undeclared.v1'] } : item) } }, manifestRoot), /not declared by the service/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: manifest.componentHost.contributions.map(item => item.type === 'application.settingsPage' ? { ...item, entry: '..\/escape.html' } : item) } }, manifestRoot), /escapes component root/);
for (const invalid of [
  { id: 42 }, { id: ' settings' }, { label: 42 }, { label: ` ${'x'.repeat(80)}` }, { title: { bad: true } }, { title: 'Fixture ' }, { entry: ' ui/settings.html' }, { entry: `${'x'.repeat(513)}` }, { rpcMethods: 'fixture.settings.v1' }, { rpcMethods: [] },
  { rpcMethods: [' fixture.settings.v1'] }, { rpcMethods: [`${'x'.repeat(129)}.v1`] },
  { rpcMethods: ['fixture.settings.v1', 'fixture.settings.v1'] }, { rpcMethods: ['fixture.settings.v1', 3] },
  { rpcMethods: Array.from({ length: 33 }, (_value, index) => `fixture.settings-${index}.v1`) },
]) assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: manifest.componentHost.contributions.map(item => item.type === 'application.settingsPage' ? { ...item, ...invalid } : item), service: { ...manifest.componentHost.service, rpcMethods: [...manifest.componentHost.service.rpcMethods, ...Array.from({ length: 33 }, (_value, index) => `fixture.settings-${index}.v1`)] } } }, manifestRoot), /settings page/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 2, maxHostApiVersion: 2 } } }, manifestRoot), /require Host API 3/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 2, maxHostApiVersion: 3 } } }, manifestRoot), /minHostApiVersion 3/);
const outsideSettingsRoot = path.join(sandbox, 'outside-settings');
fs.mkdirSync(outsideSettingsRoot, { recursive: true }); fs.writeFileSync(path.join(outsideSettingsRoot, 'settings.html'), '<!doctype html>');
const linkedSettings = path.join(manifestRoot, 'linked-settings');
try {
  fs.symlinkSync(outsideSettingsRoot, linkedSettings, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: manifest.componentHost.contributions.map(item => item.type === 'application.settingsPage' ? { ...item, entry: 'linked-settings/settings.html' } : item) } }, manifestRoot), /linked path/);
} catch (error) { if (!['EPERM', 'EACCES'].includes(error?.code)) throw error; }
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, service: { ...manifest.componentHost.service, permissions: allPermissions.filter(value => value !== 'project.output.write') } } }, manifestRoot), /requires permission project\.output\.write/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 5, maxHostApiVersion: 6 } } }, manifestRoot), /do not overlap/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, unsafeExtension: true } }, manifestRoot), /Unknown component host field/);
for (const schema of ['component-manifest-v2.schema.json', 'component-host-api-v2.schema.json', 'component-service-protocol-v1.schema.json']) JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'contracts', 'schemas', schema), 'utf8'));
const capabilitySchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'contracts', 'schemas', 'component-host-api-v2.schema.json'), 'utf8'));
const schemaMethods = Object.values(capabilitySchema.$defs).map(value => value?.properties?.method?.const).filter(Boolean).sort();
assert.deepEqual(schemaMethods, allV2Capabilities.slice().sort(), 'machine-readable schema must discriminate every V2 capability method');
const storageVariants = capabilitySchema.$defs.storage.properties.result.oneOf;
const pendingStorageSchema = storageVariants.find(value => value.properties?.adoption?.properties?.state?.const === 'pending');
const committedStorageSchema = storageVariants.find(value => value.properties?.adoption?.properties?.state?.const === 'committed');
assert(pendingStorageSchema && !Object.hasOwn(pendingStorageSchema.properties, 'dataPath') && !Object.hasOwn(pendingStorageSchema.properties, 'databasePath'), 'pending storage schema grants no path');
for (const field of ['schemaVersion', 'kind', 'state', 'componentId', 'fromHostApiVersion', 'toHostApiVersion', 'startedAt']) assert(pendingStorageSchema.properties.adoption.required.includes(field), `pending adoption requires ${field}`);
for (const field of ['adoptedDataRoot', 'adoptedDatabase', 'legacyDataRoot', 'legacyDatabasePath', 'databaseSha256', 'copiedFileCount', 'copiedByteCount']) assert(committedStorageSchema.properties.adoption.required.includes(field), `committed adoption requires ${field}`);
const writtenFrames = [];
const typedHostClient = createServiceHostClient({ writeFrame: frame => writtenFrames.push(frame) });
const typedCall = typedHostClient.callHost('parent-1', 'component.lifecycle.v2', { action: 'describe' });
assert(typedHostClient.acceptFrame({ type: 'capability-response', id: writtenFrames[0].id, ok: true, result: { apiVersion: 2, state: 'active' } }));

const broker = new ComponentCapabilityBroker();
const thumbnailRequests = [];
const mediaGrants = [];
let returnOriginalAsThumbnail = false;
const originalUrl = 'photoflow-media://original/one.jpg';
const mediaService = {
  grantPath: value => { mediaGrants.push(value); return value; },
  grantRoot: value => value,
  toUrl: () => originalUrl,
  requestThumbnail: async request => {
    thumbnailRequests.push(request);
    return { previewUrl: returnOriginalAsThumbnail ? originalUrl : `photoflow-media://derived/${request.requestedSize}/one.jpg` };
  },
};
const openedPaths = [];
const shell = { openPath: async filePath => { openedPaths.push(filePath); return ''; }, showItemInFolder: filePath => { openedPaths.push(filePath); } };
const managedLink = { shortcutVirtualPath: 'External', externalTargetRoot: externalRoot, externalTargetKind: 'folder', offline: false };
const projectVirtualPaths = {
  listManagedExternalLinks: () => [managedLink],
  toVirtualPath: (_root, candidate) => `External/${path.relative(externalRoot, candidate).replace(/\\/g, '/')}`,
  resolve: (_root, relativePath) => {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (normalized === 'External' || normalized.startsWith('External/')) return { physicalPath: path.join(externalRoot, normalized.slice('External'.length).replace(/^\//, '')), mediaRoot: externalRoot, viaExternalLink: true };
    return { physicalPath: path.join(projectRoot, normalized), mediaRoot: projectRoot, viaExternalLink: false };
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
const atomicJson = async ({ filePath, value }) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.promises.rm(filePath, { force: true });
  await fs.promises.rename(temporary, filePath);
};
const registrationOptions = overrides => ({
  broker, ensureWorkspace: value => path.resolve(value), getWorkspaceDataRoot: () => dataRoot,
  resolveProjectEntry: (_workspace, _status, _name, relative) => projectVirtualPaths.resolve(projectRoot, relative, { externalRootMode: 'target' }).physicalPath,
  versionService, IMAGE_EXTENSIONS: new Set(['.jpg']), VIDEO_EXTENSIONS: new Set(['.mp4']), RAW_EXTENSIONS: new Set(['.cr3']),
  path, fs, crypto, getConfigPath: () => configPath, readSavedConfig: () => config,
  readConfig: async () => config,
  mutateConfig: async mutator => { config = await mutator(config); await atomicJson({ filePath: configPath, value: config }); return config; },
  getProjectPath: () => projectRoot,
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 1 }) }, mainWindow: {},
  mediaService, backgroundTasks, ensureTrackedVersionThumbnail: async () => undefined, shell,
  getBoundProject: () => ({ id: 'project-1', name: 'Project', status: 'active' }),
  projectVirtualPaths,
  ...overrides,
});
registerComponentProjectCapabilities(registrationOptions());
broker.register('component.lifecycle.v2', (payload, _context, ownedDescriptor) => ({ apiVersion: 2, componentId: ownedDescriptor.componentId, componentVersion: ownedDescriptor.componentVersion, negotiatedHostApiVersion: ownedDescriptor.hostApiVersion, permissions: ownedDescriptor.service.permissions, events: ownedDescriptor.service.events, lifecycleActions: [], state: payload.action === 'describe' ? 'active' : 'active' }));
assert(broker.assertCapabilities(descriptor));
const context = { componentId: descriptor.componentId, componentVersion: descriptor.componentVersion, workspacePath: workspaceRoot, projectId: 'project-1', projectName: 'Project', projectStatus: 'active', emitComponentEvent: (topic, event) => { context.lastEvent = { topic, event }; } };

(async () => {
  assert.equal((await typedCall).state, 'active', 'service-side Host helper correlates capability responses');
  const firstPage = await broker.invoke(descriptor, 'project.media.page.v2', { pageSize: 10, kinds: ['image'] }, context);
  assert(firstPage.items.some(item => item.relativePath === 'images/one.jpg'));
  assert(firstPage.items.some(item => item.relativePath === 'External/outside.jpg' && item.viaExternalLink), 'managed external media participates in V2 pagination');
  const grantsBeforeMetadata = mediaGrants.length; const thumbnailsBeforeMetadata = thumbnailRequests.length;
  const metadataOnly = await broker.invoke(descriptor, 'project.media.variants.v2', { photoId: 'photo-1', versionId: 'version-1', variants: [] }, context);
  assert.equal(metadataOnly.input, undefined, 'metadata-only media descriptions do not mint input grants');
  assert.equal(mediaGrants.length, grantsBeforeMetadata, 'metadata-only media descriptions do not mint media URL grants');
  assert.equal(thumbnailRequests.length, thumbnailsBeforeMetadata, 'metadata-only media descriptions do not request thumbnails');
  const variants = await broker.invoke(descriptor, 'project.media.variants.v2', { photoId: 'photo-1', versionId: 'version-1', variants: ['thumbnail', 'preview', 'original'] }, context);
  assert.notEqual(variants.variants.thumbnail.url, variants.variants.original.url, 'a JPEG thumbnail must be a generated derivative rather than its original URL');
  assert.deepEqual(thumbnailRequests.map(item => item.requestedSize), [320, 1600]);
  returnOriginalAsThumbnail = true;
  await assert.rejects(broker.invoke(descriptor, 'project.media.variants.v2', { relativePath: 'images/one.jpg', variants: ['thumbnail'] }, context), error => error.code === 'COMPONENT_HOST_VARIANT_UNAVAILABLE');
  returnOriginalAsThumbnail = false;
  const externalVariants = await broker.invoke(descriptor, 'project.media.variants.v2', { photoId: 'photo-external', versionId: 'version-external', variants: ['original'] }, context);
  assert.equal(externalVariants.mediaRef.relativePath, 'External/outside.jpg', 'managed external photo versions retain their virtual project path');

  const materialized = await broker.invoke(descriptor, 'project.input.tokens.v2', { action: 'materialize', token: variants.input.token }, context);
  assert(fs.existsSync(materialized.privatePath));
  await assert.rejects(broker.invoke(descriptor, 'project.input.tokens.v2', { action: 'materialize', token: variants.input.token }, context), error => error.code === 'COMPONENT_HOST_TOKEN_EXPIRED', 'input grants are single-use');

  const legacyDataRoot = path.join(dataRoot, descriptor.componentId); const legacyDatabasePath = path.join(dataRoot, 'databases', `${descriptor.componentId}.sqlite3`);
  fs.mkdirSync(legacyDataRoot, { recursive: true }); fs.mkdirSync(path.dirname(legacyDatabasePath), { recursive: true }); fs.writeFileSync(path.join(legacyDataRoot, 'legacy-private.bin'), 'legacy-private'); fs.writeFileSync(legacyDatabasePath, 'legacy-database');
  let storage = await broker.invoke(descriptor, 'component.storage.v2', {}, context);
  for (let attempt = 0; storage.adoption?.state === 'pending' && attempt < 100; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); storage = await broker.invoke(descriptor, 'component.storage.v2', {}, context); }
  assert(storage.dataPath.startsWith(path.join(dataRoot, 'components', descriptor.componentId)));
  assert.equal(storage.adoption?.state, 'committed'); assert.equal(storage.adoption.legacyDataRoot, legacyDataRoot); assert.equal(fs.readFileSync(path.join(storage.dataPath, 'legacy-private.bin'), 'utf8'), 'legacy-private'); assert.equal(fs.readFileSync(storage.databasePath, 'utf8'), 'legacy-database');
  const privateMediaPath = path.join(storage.dataPath, 'previews', 'private.jpg');
  fs.mkdirSync(path.dirname(privateMediaPath), { recursive: true }); fs.writeFileSync(privateMediaPath, 'private-media');
  const privateMedia = await broker.invoke(descriptor, 'component.media.v2', { action: 'variants', relativePath: 'previews/private.jpg', variants: ['thumbnail', 'original'] }, context);
  assert(privateMedia.opaqueRef.startsWith('component-media:v2:') && privateMedia.variants.thumbnail.derived);
  await broker.invoke(descriptor, 'component.media.v2', { action: 'reveal', relativePath: 'previews/private.jpg' }, context);
  assert(openedPaths.includes(privateMediaPath));
  const listedProgress = await broker.invoke(descriptor, 'project.progress.v2', { action: 'list' }, context);
  assert.equal(listedProgress.progress[0].folderPath, undefined, 'progress responses do not expose host paths');
  const createdProgress = await broker.invoke(descriptor, 'project.progress.v2', { action: 'create', relativePath: 'progress-v2', mediaKind: 'image', versionKey: '2', parentProgressId: 'progress-original', sourceMetadata: { category: 'progress', role: 'component-output', displayName: '组件进度', componentId: 'forged-component' }, sourceProgressIds: ['progress-original'] }, context);
  assert.equal(createdProgress.progress.id, 'progress-created');
  assert.deepStrictEqual(createdProgress.progress.sourceMetadata, { category: 'progress', role: 'component-output', displayName: '组件进度', parentCapability: 'structural', componentId: descriptor.componentId });
  await broker.invoke(descriptor, 'project.progress.v2', { action: 'create', relativePath: 'progress-empty-metadata', mediaKind: 'image', versionKey: '3', parentProgressId: 'progress-original', sourceMetadata: {} }, context);
  const emptyMetadata = calls.filter(call => call.action === 'progress_register_with_graph').at(-1).payload.progress.sourceMetadata;
  await broker.invoke(descriptor, 'project.progress.v2', { action: 'create', relativePath: 'progress-default-metadata', mediaKind: 'image', versionKey: '4', parentProgressId: 'progress-original' }, context);
  const defaultMetadata = calls.filter(call => call.action === 'progress_register_with_graph').at(-1).payload.progress.sourceMetadata;
  assert.deepStrictEqual(emptyMetadata, defaultMetadata);
  assert.deepStrictEqual(defaultMetadata, { category: 'progress', parentCapability: 'structural', componentId: descriptor.componentId });
  for (const [relativePath, sourceMetadata] of [
    ['progress-unknown-metadata', { category: 'progress', unknown: true }],
    ['progress-nested-metadata', { category: 'progress', role: { nested: true } }],
    ['progress-long-metadata', { category: 'x'.repeat(129) }],
    ['progress-control-metadata', { category: 'progress\ninvalid' }],
  ]) {
    await assert.rejects(
      broker.invoke(descriptor, 'project.progress.v2', { action: 'create', relativePath, mediaKind: 'image', versionKey: '5', parentProgressId: 'progress-original', sourceMetadata }, context),
      /sourceMetadata/,
    );
    assert(!fs.existsSync(path.join(projectRoot, relativePath)), 'invalid metadata must be rejected before directory creation');
  }
  for (const invalidRevision of [-1, 1.25, Number.MAX_SAFE_INTEGER + 1]) {
    config = { componentSettings: { [descriptor.componentId]: {} }, componentSettingsRevisions: { [descriptor.componentId]: invalidRevision } };
    assert.equal((await broker.invoke(descriptor, 'component.settings.v2', { action: 'get' }, context)).revision, 0, 'invalid stored revisions never enter API responses');
  }
  config = {};
  const saved = await broker.invoke(descriptor, 'component.settings.v2', { action: 'replace', settings: { quality: 90 } }, context);
  assert.equal(saved.revision, 1); config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const orderingBroker = new ComponentCapabilityBroker(); let orderingReadCount = 0; let orderingMutateCount = 0;
  registerComponentProjectCapabilities(registrationOptions({ broker: orderingBroker, readConfig: () => { orderingReadCount += 1; return new Promise(() => undefined); }, mutateConfig: async mutator => { orderingMutateCount += 1; return mutator({ componentSettings: {}, componentSettingsRevisions: {} }); } }));
  const orderedWrite = await orderingBroker.invoke(descriptor, 'component.settings.v2', { action: 'merge', settings: { queued: true } }, context);
  assert.equal(orderedWrite.revision, 1); assert.equal(orderingMutateCount, 1); assert.equal(orderingReadCount, 0, 'settings writes enter the mutation queue without awaiting a stale pre-read');
  assert.equal(config.componentSettings[descriptor.componentId].quality, 90);

  const stage = await broker.invoke(descriptor, 'project.output.v2', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output.v2', { action: 'write', stageId: stage.stageId, name: 'result.jpg', outputRelativePath: 'exports/result.jpg', base64: Buffer.from('output').toString('base64') }, context);
  assert(fs.existsSync(path.join(path.dirname(stage.privatePath), 'stage.json')), 'stage metadata is persisted outside the component-writable payload directory');
  resetComponentHostCapabilityStateForTest();
  const validated = await broker.invoke(descriptor, 'project.output.v2', { action: 'validate', stageId: stage.stageId }, context);
  assert.equal(validated.fileCount, 1);
  const committed = await broker.invoke(descriptor, 'project.output.v2', { action: 'commit', stageId: stage.stageId, idempotencyKey: 'export-001' }, context);
  assert(fs.existsSync(path.join(projectRoot, 'exports', 'result.jpg')));
  resetComponentHostCapabilityStateForTest();
  const replay = await broker.invoke(descriptor, 'project.output.v2', { action: 'commit', stageId: stage.stageId, idempotencyKey: 'export-001' }, context);
  assert.equal(replay.commitId, committed.commitId, 'committed journal replays after Host restart without its consumed stage');
  await broker.invoke(descriptor, 'dialogs.v2', { kind: 'revealOutput', commitId: committed.commitId, artifactId: committed.outputs[0].artifactId }, context);

  resetComponentHostCapabilityStateForTest();
  const created = await broker.invoke(descriptor, 'version.create.v2', { commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, photoId: 'photo-1', parentVersionId: 'version-1', idempotencyKey: 'version-001', name: 'Fixture output' }, context);
  resetComponentHostCapabilityStateForTest();
  const createdAgain = await broker.invoke(descriptor, 'version.create.v2', { commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, photoId: 'photo-1', parentVersionId: 'version-1', idempotencyKey: 'version-001', name: 'Fixture output' }, context);
  assert.equal(createdAgain.versionId, created.versionId);
  assert.equal(calls.filter(item => item.action === 'media_create_version').length, 1, 'generic version creation is idempotent through the real media repository/service composition');

  const scopeIdentity = `${descriptor.componentId}\0${workspaceRoot}\0project-1`;
  const scopeDigest = crypto.createHash('sha256').update(scopeIdentity).digest('hex');
  const crashVersionKey = 'version-crash';
  const crashVersionId = stableUuid(crypto, `component-version\0${scopeIdentity}\0${crashVersionKey}`);
  bundle.versions.push({ id: crashVersionId, photoId: 'photo-1', parentVersionId: 'version-1', filePath: committed.outputs[0].filePath, isCurrent: true });
  const crashVersionReceipt = path.join(dataRoot, 'components', descriptor.componentId, 'receipts', 'versions', `${crashVersionId}.json`);
  await atomicJson({ filePath: crashVersionReceipt, value: { schemaVersion: 1, kind: 'component-version', state: 'prepared', versionId: crashVersionId, idempotencyKey: crashVersionKey, componentId: descriptor.componentId, projectId: 'project-1', scopeDigest, photoId: 'photo-1', parentVersionId: 'version-1', commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, createdAt: Date.now() } });
  const createCountBeforeCrashRecovery = calls.filter(item => item.action === 'media_create_version').length;
  resetComponentHostCapabilityStateForTest();
  const recoveredVersion = await broker.invoke(descriptor, 'version.create.v2', { commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, photoId: 'photo-1', parentVersionId: 'version-1', idempotencyKey: crashVersionKey }, context);
  assert.equal(recoveredVersion.versionId, crashVersionId);
  assert.equal(calls.filter(item => item.action === 'media_create_version').length, createCountBeforeCrashRecovery, 'prepared version receipt plus stable versionId recognizes a database commit after a crash');

  const replacementStage = await broker.invoke(descriptor, 'project.output.v2', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output.v2', { action: 'write', stageId: replacementStage.stageId, name: 'result.jpg', outputRelativePath: 'exports/result.jpg', base64: Buffer.from('replacement').toString('base64'), replace: true, previousCommitId: committed.commitId, previousArtifactId: committed.outputs[0].artifactId, expectedDigest: committed.outputs[0].sha256 }, context);
  const replacementCommit = await broker.invoke(descriptor, 'project.output.v2', { action: 'commit', stageId: replacementStage.stageId, idempotencyKey: 'replace-001' }, context);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'exports', 'result.jpg'), 'utf8'), 'replacement');
  const deniedReplacementStage = await broker.invoke(descriptor, 'project.output.v2', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output.v2', { action: 'write', stageId: deniedReplacementStage.stageId, name: 'result.jpg', outputRelativePath: 'exports/result.jpg', base64: Buffer.from('bad-replacement').toString('base64'), replace: true, previousCommitId: replacementCommit.commitId, previousArtifactId: replacementCommit.outputs[0].artifactId, expectedDigest: '0'.repeat(64) }, context);
  await assert.rejects(broker.invoke(descriptor, 'project.output.v2', { action: 'commit', stageId: deniedReplacementStage.stageId, idempotencyKey: 'replace-denied' }, context), error => error.code === 'COMPONENT_HOST_CONFLICT');
  assert.equal(fs.readFileSync(path.join(projectRoot, 'exports', 'result.jpg'), 'utf8'), 'replacement', 'failed controlled replacement preserves the owned output');

  const recoveryStage = await broker.invoke(descriptor, 'project.output.v2', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output.v2', { action: 'write', stageId: recoveryStage.stageId, name: 'a.jpg', outputRelativePath: 'recovery/a.jpg', base64: Buffer.from('recovery-a').toString('base64') }, context);
  await broker.invoke(descriptor, 'project.output.v2', { action: 'write', stageId: recoveryStage.stageId, name: 'b.jpg', outputRelativePath: 'recovery/b.jpg', base64: Buffer.from('recovery-b').toString('base64') }, context);
  const recoveryMetadata = JSON.parse(fs.readFileSync(path.join(path.dirname(recoveryStage.privatePath), 'stage.json'), 'utf8'));
  const recoveryKey = 'recovery-001'; const recoveryCommitId = stableUuid(crypto, `component-output\0${scopeIdentity}\0${recoveryKey}`);
  const recoveryOutputs = recoveryMetadata.files.map(file => { const bytes = fs.readFileSync(path.join(recoveryStage.privatePath, file.sourceName)); return { artifactId: file.artifactId, relativePath: file.outputRelativePath, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), published: false }; });
  fs.mkdirSync(path.join(projectRoot, 'recovery'), { recursive: true }); fs.copyFileSync(path.join(recoveryStage.privatePath, recoveryMetadata.files[0].sourceName), path.join(projectRoot, 'recovery', 'a.jpg')); recoveryOutputs[0].published = true;
  const recoveryReceiptPath = path.join(dataRoot, 'components', descriptor.componentId, 'receipts', 'commits', `${recoveryCommitId}.json`);
  await atomicJson({ filePath: recoveryReceiptPath, value: { schemaVersion: 1, kind: 'component-output-commit', state: 'prepared', commitId: recoveryCommitId, idempotencyKey: recoveryKey, componentId: descriptor.componentId, projectId: 'project-1', scopeDigest, stageId: recoveryStage.stageId, createdAt: Date.now(), outputs: recoveryOutputs } });
  resetComponentHostCapabilityStateForTest();
  const recoveredCommit = await broker.invoke(descriptor, 'project.output.v2', { action: 'commit', stageId: recoveryStage.stageId, idempotencyKey: recoveryKey }, context);
  assert.equal(recoveredCommit.commitId, recoveryCommitId); assert(fs.existsSync(path.join(projectRoot, 'recovery', 'b.jpg')), 'prepared multi-file journal finishes after Host restart');

  const conflictStage = await broker.invoke(descriptor, 'project.output.v2', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output.v2', { action: 'write', stageId: conflictStage.stageId, name: 'conflict.jpg', outputRelativePath: 'recovery/conflict.jpg', base64: Buffer.from('host-output').toString('base64') }, context);
  const conflictMeta = JSON.parse(fs.readFileSync(path.join(path.dirname(conflictStage.privatePath), 'stage.json'), 'utf8')); const conflictFile = conflictMeta.files[0]; const conflictBytes = fs.readFileSync(path.join(conflictStage.privatePath, conflictFile.sourceName));
  const conflictKey = 'recovery-conflict'; const conflictCommitId = stableUuid(crypto, `component-output\0${scopeIdentity}\0${conflictKey}`); const conflictTarget = path.join(projectRoot, 'recovery', 'conflict.jpg'); fs.writeFileSync(conflictTarget, 'user-modified');
  await atomicJson({ filePath: path.join(dataRoot, 'components', descriptor.componentId, 'receipts', 'commits', `${conflictCommitId}.json`), value: { schemaVersion: 1, kind: 'component-output-commit', state: 'prepared', commitId: conflictCommitId, idempotencyKey: conflictKey, componentId: descriptor.componentId, projectId: 'project-1', scopeDigest, stageId: conflictStage.stageId, createdAt: Date.now(), outputs: [{ artifactId: conflictFile.artifactId, relativePath: conflictFile.outputRelativePath, size: conflictBytes.length, sha256: crypto.createHash('sha256').update(conflictBytes).digest('hex'), published: true }] } });
  resetComponentHostCapabilityStateForTest();
  await assert.rejects(broker.invoke(descriptor, 'project.output.v2', { action: 'commit', stageId: conflictStage.stageId, idempotencyKey: conflictKey }, context), error => error.code === 'COMPONENT_HOST_CONFLICT');
  assert.equal(fs.readFileSync(conflictTarget, 'utf8'), 'user-modified', 'journal recovery never deletes a user-modified output');

  const expiryBroker = new ComponentCapabilityBroker(); let expiryNow = Date.now() - STAGE_TTL_MS - 10; registerComponentProjectCapabilities(registrationOptions({ broker: expiryBroker, now: () => expiryNow }));
  const expiredStage = await expiryBroker.invoke(descriptor, 'project.output.v2', { action: 'stage' }, context); const expiredRoot = path.dirname(expiredStage.privatePath); expiryNow += STAGE_TTL_MS + 20;
  const siblingStage = path.join(path.dirname(expiredRoot), 'do-not-delete'); fs.mkdirSync(siblingStage, { recursive: true }); resetComponentHostCapabilityStateForTest();
  await assert.rejects(expiryBroker.invoke(descriptor, 'project.output.v2', { action: 'validate', stageId: expiredStage.stageId }, context), error => error.code === 'COMPONENT_HOST_TOKEN_EXPIRED');
  assert(!fs.existsSync(expiredRoot) && fs.existsSync(siblingStage), 'expiry removes only the exact bound stage directory');

  const failingBroker = new ComponentCapabilityBroker();
  registerComponentProjectCapabilities(registrationOptions({ broker: failingBroker, replaceJson: async options => {
    if (options.value?.kind === 'component-output-commit' && options.value?.state === 'committed') throw new Error('simulated committed receipt failure');
    return atomicJson(options);
  } }));
  failingBroker.register('component.lifecycle.v2', () => ({ apiVersion: 2, state: 'active' }));
  const failingStage = await failingBroker.invoke(descriptor, 'project.output.v2', { action: 'stage' }, context);
  await failingBroker.invoke(descriptor, 'project.output.v2', { action: 'write', stageId: failingStage.stageId, name: 'failure.jpg', outputRelativePath: 'receipt-failure/failure.jpg', base64: Buffer.from('failure-output').toString('base64') }, context);
  await failingBroker.invoke(descriptor, 'project.output.v2', { action: 'write', stageId: failingStage.stageId, name: 'failure-2.jpg', outputRelativePath: 'receipt-failure/failure-2.jpg', base64: Buffer.from('failure-output-2').toString('base64') }, context);
  await assert.rejects(failingBroker.invoke(descriptor, 'project.output.v2', { action: 'commit', stageId: failingStage.stageId, idempotencyKey: 'receipt-failure' }, context), /simulated committed receipt failure/);
  const failedOutput = path.join(projectRoot, 'receipt-failure', 'failure.jpg'); const failedCommitId = stableUuid(crypto, `component-output\0${scopeIdentity}\0receipt-failure`);
  assert(!fs.existsSync(failedOutput) && !fs.existsSync(path.join(projectRoot, 'receipt-failure', 'failure-2.jpg')) && !fs.existsSync(path.join(dataRoot, 'components', descriptor.componentId, 'receipts', 'commits', `${failedCommitId}.json`)), 'final receipt failure rolls back every output and removes the unusable journal');

  const adoptedPath = path.join(projectRoot, 'legacy', 'adopted.jpg'); fs.mkdirSync(path.dirname(adoptedPath), { recursive: true }); fs.writeFileSync(adoptedPath, 'legacy-output');
  const adopted = await broker.invoke(descriptor, 'project.output.v2', { action: 'adopt', migrationId: 'migration-one', outputs: [{ relativePath: 'legacy/adopted.jpg' }] }, context);
  assert(adopted.commitId && adopted.outputs.length === 1);
  assert((await broker.invoke(descriptor, 'dialogs.v2', { kind: 'openOutput', commitId: adopted.commitId, artifactId: adopted.outputs[0].artifactId }, context)).opened, 'one-time V1 adoption creates a receipt consumable by generic V2 output refs');
  const importedLegacy = await broker.invoke(descriptor, 'project.output.v2', { action: 'materializeOwned', commitId: adopted.commitId, artifactId: adopted.outputs[0].artifactId }, context);
  assert.equal(fs.readFileSync(importedLegacy.privatePath, 'utf8'), 'legacy-output', 'owned legacy project output can be safely copied into component-private storage');
  const absoluteAdopted = await broker.invoke(descriptor, 'project.output.v2', { action: 'adopt', migrationId: 'migration-absolute', outputs: [{ sourcePath: adoptedPath }] }, context);
  assert.equal(absoluteAdopted.outputs[0].relativePath, 'legacy/adopted.jpg');
  assert.equal(absoluteAdopted.outputs[0].filePath, undefined, 'one-time absolute migration input is never echoed as a public disk path');
  const outsideLegacyPath = path.join(externalRoot, 'outside-legacy.jpg'); fs.writeFileSync(outsideLegacyPath, 'outside-legacy');
  await assert.rejects(broker.invoke(descriptor, 'project.output.v2', { action: 'adopt', migrationId: 'migration-outside', outputs: [{ sourcePath: outsideLegacyPath }] }, context), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED', 'absolute migration sources outside the bound project fail closed');
  for (const sourcePath of ['', `C:\\${'x'.repeat(4096)}`, `${adoptedPath}\0hidden`]) await assert.rejects(broker.invoke(descriptor, 'project.output.v2', { action: 'adopt', migrationId: `migration-invalid-${sourcePath.length}`, outputs: [{ sourcePath }] }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST', 'malformed legacy absolute migration paths are rejected before filesystem resolution');
  await assert.rejects(broker.invoke(descriptor, 'project.output.v2', { action: 'adopt', migrationId: 'migration-ambiguous', outputs: [{ relativePath: 'legacy/adopted.jpg', sourcePath: adoptedPath }] }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST', 'migration sources cannot mix relative and legacy absolute paths');
  const junctionTarget = path.join(externalRoot, 'junction-target'); const junctionPath = path.join(projectRoot, 'legacy-junction'); fs.mkdirSync(junctionTarget, { recursive: true }); fs.writeFileSync(path.join(junctionTarget, 'linked.jpg'), 'linked'); fs.symlinkSync(junctionTarget, junctionPath, 'junction');
  await assert.rejects(broker.invoke(descriptor, 'project.output.v2', { action: 'adopt', migrationId: 'migration-symlink', outputs: [{ sourcePath: path.join(junctionPath, 'linked.jpg') }] }, context), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED', 'symlinked parents cannot escape the physical bound project root');

  const started = await broker.invoke(descriptor, 'tasks.v2', { action: 'start', operationId: 'fixture-task', title: 'Fixture' }, context);
  await broker.invoke(descriptor, 'tasks.v2', { action: 'report', operationId: 'fixture-task', progress: 25, checkpoint: { page: 1 } }, context);
  await broker.invoke(descriptor, 'tasks.v2', { action: 'complete', operationId: 'fixture-task', message: 'Paused fixture' }, context);
  const resumed = await broker.invoke(descriptor, 'tasks.v2', { action: 'resume', operationId: 'fixture-task', checkpoint: { page: 1 } }, context);
  const cancelled = await broker.invoke(descriptor, 'tasks.v2', { action: 'cancel', operationId: 'fixture-task' }, context);
  assert(started.task && resumed.task.checkpoint.page === 1 && cancelled.cancelled);
  assert((await broker.invoke(descriptor, 'dialogs.v2', { kind: 'confirm', title: 'Confirm', message: 'Continue?' }, context)).confirmed);
  await broker.invoke(descriptor, 'component.events.v2', { topic: 'fixture.progress.v1', event: { progress: 50 } }, context);
  assert.deepEqual(context.lastEvent, { topic: 'fixture.progress.v1', event: { progress: 50 } });
  assert.equal((await broker.invoke(descriptor, 'component.lifecycle.v2', { action: 'describe' }, context)).negotiatedHostApiVersion, 3);
  const applicationSettingsContext = { ...context, surface: 'application.settings', workspacePath: '', projectId: '', projectName: '', projectStatus: '' };
  assert.equal((await broker.invoke(descriptor, 'component.settings.v2', { action: 'get' }, applicationSettingsContext)).revision, 1, 'application settings surface may read owner settings');
  assert.equal((await broker.invoke(descriptor, 'component.lifecycle.v2', { action: 'describe' }, applicationSettingsContext)).state, 'active', 'application settings surface may inspect declared lifecycle state');
  assert((await broker.invoke(descriptor, 'dialogs.v2', { kind: 'confirm', title: 'Confirm' }, applicationSettingsContext)).confirmed, 'application settings surface may use confirmation dialogs');
  await assert.rejects(broker.invoke(descriptor, 'dialogs.v2', { kind: 'openFiles' }, applicationSettingsContext), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED', 'application settings surface cannot mint project input tokens');
  assert.throws(() => broker.invoke(descriptor, 'project.media.page.v2', { pageSize: 10 }, applicationSettingsContext), /not available on the application settings surface/, 'project capabilities fail closed on an application surface');
  assert.throws(() => broker.invoke(descriptor, 'component.storage.v2', {}, applicationSettingsContext), /not available on the application settings surface/, 'project-scoped component storage fails closed on an application surface');
  const drainBroker = new ComponentCapabilityBroker(); let finishAcceptedCapability;
  drainBroker.register('component.settings.v2', () => new Promise(resolve => { finishAcceptedCapability = resolve; }));
  const drainDescriptor = { componentId: 'drain-fixture', service: { capabilities: ['component.settings.v2'], permissions: ['component.settings'] } };
  const acceptedCapability = drainBroker.invoke(drainDescriptor, 'component.settings.v2', { action: 'get' }, {});
  const barrier = drainBroker.blockComponent('drain-fixture'); let drained = false; const drain = barrier.drain().then(() => { drained = true; });
  assert.throws(() => drainBroker.invoke(drainDescriptor, 'component.settings.v2', { action: 'get' }, {}), /quiesced/, 'new capabilities are rejected after component quiesce begins');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false, 'quiesce waits for an already accepted capability side effect');
  finishAcceptedCapability({ revision: 1, settings: {} }); await acceptedCapability; await drain; barrier.release(); assert.equal(drained, true);
  const hangingBroker = new ComponentCapabilityBroker(); let finishHanging;
  hangingBroker.register('component.settings.v2', () => new Promise(resolve => { finishHanging = resolve; }));
  const hangingInvocation = hangingBroker.invoke(drainDescriptor, 'component.settings.v2', { action: 'get' }, {});
  const hangingBarrier = hangingBroker.blockComponent('drain-fixture');
  await assert.rejects(hangingBarrier.drain({ timeoutMs: 10 }), error => error.code === 'COMPONENT_BUSY', 'a hung accepted capability aborts bounded drain instead of allowing destructive cleanup');
  hangingBarrier.release(); finishHanging({ revision: 1, settings: {} }); await hangingInvocation;

  const genericSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'services', 'component-project-capabilities.cjs'), 'utf8');
  for (const forbidden of ['sample-component', 'edited_patch_path', 'component_patch_tasks']) assert(!genericSource.includes(forbidden), `generic host source must not contain ${forbidden}`);
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  assert(!packageJson.scripts.build.includes('sample-component') && !genericSource.includes('extensions/'), 'the main application build and V2 host must not require a component source package');
  console.log('Component Host API V2 contract and integration tests passed');
})().finally(() => fs.rmSync(sandbox, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
