const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerComponentProjectCapabilities, resetComponentHostCapabilityStateForTest } = require('../electron/services/component-project-capabilities.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-inspiration-capabilities-'));
const inspirationRoot = path.join(root, 'inspiration');
const workspaceRoot = path.join(root, 'workspace');
const dataRoot = path.join(root, 'data');
fs.mkdirSync(inspirationRoot);
fs.mkdirSync(workspaceRoot);
fs.mkdirSync(dataRoot);
fs.writeFileSync(path.join(inspirationRoot, 'clip.mp4'), Buffer.from('video-fixture'));

const handlers = new Map();
const descriptor = { componentId: 'inspiration-fixture', adoptionGrants: [] };
const context = {
  surface: 'project', contentKind: 'inspiration', contentRootPath: inspirationRoot,
  workspacePath: workspaceRoot, projectId: `inspiration:${inspirationRoot}`,
  projectName: '.__photoflow_inspiration__', projectStatus: '未分类', scopeRelativePath: '',
};
const resolveComponentContentBinding = supplied => {
  assert.equal(supplied, context);
  return { contentKind: 'inspiration', workspaceRoot, projectRoot: inspirationRoot, project: { id: context.projectId, name: context.projectName, status: context.projectStatus } };
};

registerComponentProjectCapabilities({
  broker: { register: (name, handler) => handlers.set(name, handler) },
  ensureWorkspace: () => assert.fail('trusted inspiration binding should supply the storage workspace'),
  getWorkspaceDataRoot: () => dataRoot,
  resolveProjectEntry: () => assert.fail('inspiration media should resolve directly inside the trusted library root'),
  versionService: {},
  IMAGE_EXTENSIONS: new Set(['.jpg']), VIDEO_EXTENSIONS: new Set(['.mp4']), RAW_EXTENSIONS: new Set(),
  path, fs, crypto,
  getConfigPath: () => path.join(root, 'config.json'), readSavedConfig: () => ({ mediaCache: {} }),
  getProjectPath: () => assert.fail('inspiration content must not be derived from a project category'),
  dialog: {}, mainWindow: {}, shell: {},
  mediaService: { grantPath() {}, toUrl: filePath => `media:${filePath}`, requestThumbnail: async () => ({}) },
  backgroundTasks: null, projectVirtualPaths: { listManagedExternalLinks: () => [] },
  resolveComponentContentBinding,
});

(async () => {
  try {
    const page = await handlers.get('project.media.page')({}, context, descriptor);
    assert.deepEqual(page.items.map(item => item.relativePath), ['clip.mp4']);

    const variants = await handlers.get('project.media.variants')({ relativePath: 'clip.mp4', variants: ['original'] }, context, descriptor);
    assert.equal(variants.mediaRef.relativePath, 'clip.mp4');
    assert(variants.input?.token, 'original inspiration media issues a scoped input token');
    const materialized = await handlers.get('project.input.tokens')({ action: 'materialize', token: variants.input.token }, context, descriptor);
    assert.equal(fs.readFileSync(materialized.privatePath, 'utf8'), 'video-fixture');

    const stage = await handlers.get('project.output')({ action: 'stage' }, context, descriptor);
    await handlers.get('project.output')({ action: 'write', stageId: stage.stageId, name: 'clip.srt', outputRelativePath: 'clip.srt', base64: Buffer.from('subtitle').toString('base64') }, context, descriptor);
    await handlers.get('project.output')({ action: 'validate', stageId: stage.stageId }, context, descriptor);
    const committed = await handlers.get('project.output')({ action: 'commit', stageId: stage.stageId, idempotencyKey: 'inspiration-output' }, context, descriptor);
    assert.equal(committed.outputs[0].relativePath, 'clip.srt');
    assert.equal(fs.readFileSync(path.join(inspirationRoot, 'clip.srt'), 'utf8'), 'subtitle');
    console.log('Component inspiration capability tests passed');
  } finally {
    resetComponentHostCapabilityStateForTest();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
