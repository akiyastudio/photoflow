const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');
const { MAX_PROGRESS_ITEMS, MAX_PROGRESS_SCAN, registerComponentProjectReadCapabilities, resetComponentProjectReadCapabilityStateForTest } = require('../electron/services/component-project-read-capabilities.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-host-read-'));
const componentRoot = path.join(root, 'component'); const workspaceRoot = path.join(root, 'workspace'); const projectRoot = path.join(workspaceRoot, 'active', 'Project');
fs.mkdirSync(path.join(componentRoot, 'ui'), { recursive: true }); fs.mkdirSync(path.join(projectRoot, 'nested'), { recursive: true });
fs.writeFileSync(path.join(componentRoot, 'ui', 'index.html'), '<!doctype html>'); fs.writeFileSync(path.join(componentRoot, 'service.cjs'), '');
fs.writeFileSync(path.join(projectRoot, 'photo.jpg'), 'image'); fs.writeFileSync(path.join(projectRoot, 'photo.xmp'), 'sidecar');
fs.writeFileSync(path.join(projectRoot, 'notes.txt'), 'notes'); fs.writeFileSync(path.join(projectRoot, 'nested', 'clip.mp4'), 'video');
fs.writeFileSync(path.join(projectRoot, 'missing-metadata.jpg'), 'image'); const outsideProgress = path.join(projectRoot, 'outside-progress'); fs.mkdirSync(outsideProgress);

const capabilities = ['project.files.page', 'project.files.search', 'project.media.metadata', 'project.versions.page', 'project.version.graph', 'project.media.ratings'];
const permissions = ['project.files.read', 'project.media.read', 'project.versions.read', 'project.media.ratings.read'];
const manifest = { apiVersion: 1, id: 'host-read-fixture', version: '1.0.0', componentHost: { contractVersion: 2,
   contributions: [
    { type: 'workspace.toolbarAction', id: 'open', label: 'Open', pageId: 'main' },
    { type: 'component.fullPage', id: 'main', title: 'Fixture', entry: 'ui/index.html' },
  ], service: { protocolVersion: 1, runtime: 'node', entrypoints: { default: 'service.cjs' }, rpcMethods: ['fixture.run.v1'], capabilities, permissions, events: [] } } };

const descriptor = parseComponentHostManifest(manifest, componentRoot);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, service: { ...manifest.componentHost.service, permissions: permissions.filter(item => item !== 'project.files.read') } } }, componentRoot), /requires permission project.files.read/);

const photoBundle = { photo: { id: 'photo-1', projectId: 'project-1' }, versions: [
  { id: 'v1', photoId: 'photo-1', filePath: path.join(projectRoot, 'photo.jpg'), versionName: 'Original', status: 'ready', isCurrent: false, createdAt: 10, updatedAt: 11 },
  { id: 'v2', photoId: 'photo-1', parentVersionId: 'v1', filePath: path.join(projectRoot, 'photo.jpg'), versionName: 'Edit', note: 'ok', status: 'draft', isCurrent: true, createdAt: 20, updatedAt: 21 },
] };
const missingProgressPath = path.join(projectRoot, 'nested', 'missing-progress');
const normalProgress = [
  { id: 'p1', nodeRole: 'original', mediaKind: 'image', displayName: 'Inside', folderPath: path.join(projectRoot, 'nested'), updatedAt: 2 },
  { id: 'p2', nodeRole: 'progress', mediaKind: 'image', displayName: 'Outside', folderPath: outsideProgress, parentProgressId: 'p1', updatedAt: 3 },
  { id: 'p-missing', nodeRole: 'progress', mediaKind: 'image', displayName: 'Missing', folderPath: missingProgressPath, folderMissing: true, updatedAt: 4 },
  { id: 'p-missing-path', nodeRole: 'progress', mediaKind: 'image', displayName: 'Unscoped', folderMissing: true, updatedAt: 5 },
  { id: 'p-external', nodeRole: 'progress', mediaKind: 'image', displayName: 'External', folderPath: path.join(root, 'external-progress'), folderMissing: true, externalLinkRelativePath: 'external', updatedAt: 6 },
];
let progressFixture = normalProgress; let progressEdgesFixture = [{ sourceProgressId: 'p1', targetProgressId: 'p2', kind: 'source' }, { sourceProgressId: 'p1', targetProgressId: 'p-missing', kind: 'source' }]; let versionSnapshotTruncated = true;
const broker = new ComponentCapabilityBroker();
registerComponentProjectReadCapabilities({ broker, ensureWorkspace: value => path.resolve(value), getProjectPath: rootPath => path.join(rootPath, 'active', 'Project'),
  getBoundProject: () => ({ id: 'project-1', name: 'Project', status: 'active' }), path, fs, crypto,
  IMAGE_EXTENSIONS: new Set(['.jpg']), VIDEO_EXTENSIONS: new Set(['.mp4']), RAW_EXTENSIONS: new Set(),
  versionService: {
    getMedia: async () => assert.fail('write-style media_get must not be used'),
    listProgress: async () => assert.fail('write-style progress_list must not be used'),
    snapshotProjectVersions: async () => ({ versions: photoBundle.versions, truncated: versionSnapshotTruncated }),
    snapshotProgress: async () => ({ progressFolders: progressFixture, graphEdges: progressEdgesFixture }),
  },
  mediaRatingService: { read: async () => 4 },
  exiftool: { readRaw: async filePath => filePath.endsWith('missing-metadata.jpg') ? { 'File:ImageWidth': null, 'File:ImageHeight': '', 'EXIF:ISO': false, 'EXIF:FNumber': ' ', 'EXIF:FocalLength': 'not-a-number' } : ({ 'File:ImageWidth': 6000, 'File:ImageHeight': 4000, 'EXIF:Make': 'FixtureCam', 'EXIF:Model': 'X1', 'EXIF:LensModel': '50mm', 'QuickTime:Duration': filePath.endsWith('.mp4') ? 12.5 : undefined, 'QuickTime:VideoFrameRate': 24, 'QuickTime:VideoCodec': 'h264' }) },
});
broker.assertCapabilities(descriptor);
const context = { surface: 'project', workspacePath: workspaceRoot, projectId: 'project-1', projectName: 'Project', projectStatus: 'active', scopeRelativePath: '' };

(async () => {
  try {
    const first = await broker.invoke(descriptor, 'project.files.page', { pageSize: 2 }, context);
    assert.equal(first.items.length, 2); assert(first.page.cursor); assert(first.items.every(item => !item.relativePath.endsWith('.jpg') && !item.relativePath.endsWith('.mp4')));
    const second = await broker.invoke(descriptor, 'project.files.page', { pageSize: 2, cursor: first.page.cursor }, context);
    assert(second.items.some(item => item.kind === 'sidecar')); assert(second.items.every(item => !('path' in item)));
    const search = await broker.invoke(descriptor, 'project.files.search', { query: 'notes', pageSize: 10 }, context);
    assert.deepEqual(search.items.map(item => item.relativePath), ['notes.txt']);
    const metadata = await broker.invoke(descriptor, 'project.media.metadata', { relativePath: 'photo.jpg' }, context);
    assert.equal(metadata.dimensions.width, 6000); assert.equal(metadata.camera.make, 'FixtureCam'); assert(!JSON.stringify(metadata).includes(projectRoot));
    const videoMetadata = await broker.invoke(descriptor, 'project.media.metadata', { relativePath: 'nested/clip.mp4' }, context);
    assert.equal(videoMetadata.video.codec, 'h264'); assert.equal(videoMetadata.video.durationSeconds, 12.5);
    const missingMetadata = await broker.invoke(descriptor, 'project.media.metadata', { relativePath: 'missing-metadata.jpg' }, context);
    assert.deepEqual(missingMetadata.dimensions, { width: null, height: null }); assert.equal(missingMetadata.capture.iso, null); assert.equal(missingMetadata.capture.aperture, null); assert.equal(missingMetadata.capture.focalLength, null);
    const versions = await broker.invoke(descriptor, 'project.versions.page', { pageSize: 10 }, context);
    assert.deepEqual(versions.items.map(item => item.id), ['v2', 'v1']); assert(versions.items.every(item => !('filePath' in item))); assert.equal(versions.page.truncated, true);
    const versionFirst = await broker.invoke(descriptor, 'project.versions.page', { pageSize: 1 }, context);
    const versionSecond = await broker.invoke(descriptor, 'project.versions.page', { pageSize: 1, cursor: versionFirst.page.cursor }, context);
    assert.equal(versionSecond.page.truncated, true, 'truncated survives cursor continuation');
    versionSnapshotTruncated = false;
    const graph = await broker.invoke(descriptor, 'project.version.graph', {}, context);
    assert(graph.edges.some(edge => edge.sourceId === 'v1' && edge.targetId === 'v2')); assert(graph.edges.some(edge => edge.sourceId === 'p1' && edge.targetId === 'p2'));
    assert.deepEqual(graph.progress.map(item => item.id), ['p1', 'p2'], 'root scope sees all reliable physical project progress');
    const scopedGraph = await broker.invoke(descriptor, 'project.version.graph', {}, { ...context, scopeRelativePath: 'nested' });
    assert.deepEqual(scopedGraph.progress.map(item => item.id), ['p1']);
    assert(!scopedGraph.edges.some(edge => edge.sourceId.startsWith('p') || edge.targetId.startsWith('p')), 'scope graph removes edges whose endpoints are not both visible');
    const missingGraph = await broker.invoke(descriptor, 'project.version.graph', { includeMissing: true }, { ...context, scopeRelativePath: 'nested' });
    assert.deepEqual(missingGraph.progress.map(item => item.id), ['p1', 'p-missing']); assert.equal(missingGraph.progress.find(item => item.id === 'p-missing').missing, true);
    assert(missingGraph.edges.some(edge => edge.sourceId === 'p1' && edge.targetId === 'p-missing')); assert(!missingGraph.progress.some(item => item.id === 'p-external'));
    progressFixture = [...Array.from({ length: 1001 }, (_value, index) => ({ id: `outside-${index}`, nodeRole: 'progress', mediaKind: 'image', displayName: 'Outside', folderPath: outsideProgress, updatedAt: index + 10 })), { id: 'inside-late', nodeRole: 'progress', mediaKind: 'image', displayName: 'Inside late', folderPath: path.join(projectRoot, 'nested'), updatedAt: 2000 }]; progressEdgesFixture = [];
    const starvationGraph = await broker.invoke(descriptor, 'project.version.graph', {}, { ...context, scopeRelativePath: 'nested' });
    assert.deepEqual(starvationGraph.progress.map(item => item.id), ['inside-late'], 'scope filtering happens before the 1000 public-node limit'); assert.equal(starvationGraph.truncated, false);
    progressFixture = Array.from({ length: MAX_PROGRESS_ITEMS + 1 }, (_value, index) => ({ id: `visible-${index}`, nodeRole: 'progress', mediaKind: 'image', displayName: 'Visible', folderPath: path.join(projectRoot, 'nested'), updatedAt: index + 10 }));
    const visibleOverflowGraph = await broker.invoke(descriptor, 'project.version.graph', {}, { ...context, scopeRelativePath: 'nested' });
    assert.equal(visibleOverflowGraph.progress.length, MAX_PROGRESS_ITEMS); assert.equal(visibleOverflowGraph.truncated, true, 'visible node overflow is explicit');
    progressFixture = Array.from({ length: MAX_PROGRESS_SCAN + 1 }, (_value, index) => ({ id: `scan-${index}`, nodeRole: 'progress', mediaKind: 'image', displayName: 'Outside', folderPath: outsideProgress, updatedAt: index + 10 }));
    const scanOverflowGraph = await broker.invoke(descriptor, 'project.version.graph', {}, { ...context, scopeRelativePath: 'nested' });
    assert.equal(scanOverflowGraph.progress.length, 0); assert.equal(scanOverflowGraph.truncated, true, 'scan overflow is explicit');
    progressFixture = normalProgress; progressEdgesFixture = [{ sourceProgressId: 'p1', targetProgressId: 'p2', kind: 'source' }, { sourceProgressId: 'p1', targetProgressId: 'p-missing', kind: 'source' }];
    const ratings = await broker.invoke(descriptor, 'project.media.ratings', { mediaRefs: [{ relativePath: 'photo.jpg' }, { relativePath: 'nested/clip.mp4' }] }, context);
    assert.deepEqual(ratings.supported, { rating: true, labels: false, selectionState: false }); assert.equal(ratings.items[0].rating, 4); assert.equal(ratings.items[1].rating, null);
    for (const invalid of [{ pageSize: 0 }, { pageSize: 1.5 }, { pageSize: '2' }, { pageSize: 201 }, { cursor: 'x' }, { cursor: 'x'.repeat(81) }, { unknown: true }]) await assert.rejects(broker.invoke(descriptor, 'project.files.page', invalid, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    await assert.rejects(broker.invoke(descriptor, 'project.files.search', { pageSize: 1 }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    const mismatchPage = await broker.invoke(descriptor, 'project.files.page', { pageSize: 1 }, context);
    await assert.rejects(broker.invoke(descriptor, 'project.files.page', { pageSize: 2, cursor: mismatchPage.page.cursor }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    const searchCursor = await broker.invoke(descriptor, 'project.files.search', { query: 'o', pageSize: 1 }, context);
    await assert.rejects(broker.invoke(descriptor, 'project.files.search', { query: 'other', pageSize: 1, cursor: searchCursor.page.cursor }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    await assert.rejects(broker.invoke(descriptor, 'project.media.metadata', { relativePath: 'photo.jpg', extra: true }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    await assert.rejects(broker.invoke(descriptor, 'project.version.graph', { includeMissing: 'yes' }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    await assert.rejects(broker.invoke(descriptor, 'project.version.graph', { extra: true }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    await assert.rejects(broker.invoke(descriptor, 'project.versions.page', { extra: true }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    await assert.rejects(broker.invoke(descriptor, 'project.media.ratings', { mediaRefs: [{ relativePath: 'photo.jpg' }, { relativePath: 'photo.jpg' }] }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    await assert.rejects(broker.invoke(descriptor, 'project.media.ratings', { mediaRefs: [{ relativePath: 'photo.jpg', extra: true }] }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    await assert.rejects(broker.invoke(descriptor, 'project.media.ratings', { mediaRefs: ['photo.jpg'] }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    await assert.rejects(broker.invoke(descriptor, 'project.media.metadata', { relativePath: '../secret.jpg' }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
    const scoped = { ...context, scopeRelativePath: 'nested' };
    await assert.rejects(broker.invoke(descriptor, 'project.media.metadata', { relativePath: 'photo.jpg' }, scoped), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED');
    const otherDescriptor = { ...descriptor, componentId: 'other', service: descriptor.service };
    const cursorPage = await broker.invoke(descriptor, 'project.files.page', { pageSize: 1 }, context);
    await assert.rejects(broker.invoke(otherDescriptor, 'project.files.page', { cursor: cursorPage.page.cursor }, context), error => error.code === 'COMPONENT_HOST_TOKEN_EXPIRED');
    const restoredWorkspace = path.join(root, 'restored-workspace'); fs.mkdirSync(path.join(restoredWorkspace, 'active', 'Project'), { recursive: true });
    await assert.rejects(broker.invoke(descriptor, 'project.files.page', { pageSize: 1, cursor: cursorPage.page.cursor }, { ...context, workspacePath: restoredWorkspace }), error => error.code === 'COMPONENT_HOST_TOKEN_EXPIRED');
    assert.throws(() => broker.invoke({ ...descriptor, service: { ...descriptor.service, capabilities: descriptor.service.capabilities.filter(item => item !== 'project.files.page') } }, 'project.files.page', {}, context), /not granted/);
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    try {
      const linkedScope = path.join(projectRoot, 'linked-scope');
      fs.symlinkSync(outside, linkedScope, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(broker.invoke(descriptor, 'project.files.page', {}, { ...context, scopeRelativePath: 'linked-scope' }), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED');
      fs.rmdirSync(linkedScope);
      fs.symlinkSync(outside, path.join(projectRoot, 'nested', 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(broker.invoke(descriptor, 'project.files.page', {}, context), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED');
    } catch (error) { if (!['EPERM', 'EACCES'].includes(error?.code)) throw error; }
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron', 'contracts', 'schemas', 'component-host-api.schema.json'), 'utf8'));
    for (const name of ['publicVersion', 'progressNode', 'graphEdge']) assert.equal(schema.$defs[name].additionalProperties, false, `${name} is closed`);
    for (const name of ['dimensions', 'camera', 'capture']) assert.equal(schema.$defs.projectMediaMetadata.properties.result.properties[name].additionalProperties, false, `${name} metadata is closed`);
    assert.equal(schema.$defs.projectMediaRatings.properties.result.additionalProperties, false); assert.equal(schema.$defs.projectMediaRatings.properties.result.properties.items.items.additionalProperties, false);
    console.log('Component Host API project read capability tests passed');
  } finally { resetComponentProjectReadCapabilityStateForTest(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
