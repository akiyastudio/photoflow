const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-office-ipc-'));
const projectRoot = path.join(temporaryRoot, '项目');
const firstDocument = path.join(projectRoot, '方案.docx');
const secondDocument = path.join(projectRoot, '损坏.docx');
const outputFolder = path.join(projectRoot, '方案_media');
fs.mkdirSync(outputFolder, { recursive: true });
fs.writeFileSync(firstDocument, 'fixture');
fs.writeFileSync(secondDocument, 'fixture');
fs.writeFileSync(path.join(outputFolder, 'image1.png'), 'image');

const handlers = new Map();
const fileChangeEvents = [];
let extractionPayload;
const assertInside = (root, candidate) => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path escaped root');
  return resolvedCandidate;
};

registerWorkspaceIpc({
  Array, Boolean, Date, Error, Math, Object, Promise, Set, String,
  HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(), WORKSPACE_STATUSES: [],
  fs, path, crypto, assertInside, assertExistingInside: assertInside,
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  ensureWorkspace: value => value,
  getProjectPath: () => projectRoot,
  getWorkspaceDataRoot: () => path.join(temporaryRoot, '.data'),
  pathExists: async value => fs.existsSync(value),
  projectVirtualPaths: {
    resolve: (root, relativePath) => ({
      projectRoot: root,
      virtualPath: relativePath,
      physicalPath: assertInside(root, path.resolve(root, relativePath)),
      mediaRoot: root,
      viaExternalLink: false,
      isExternalLinkRoot: false,
    }),
    createManagedExternalLinksBatch: () => undefined,
    listManagedExternalLinks: () => [],
  },
  runPythonJsonAction: async () => extractionPayload,
  mainWindow: { webContents: { send: (channel, payload) => fileChangeEvents.push([channel, payload]) } },
  writeLog: () => undefined,
});

const extractOfficeImages = handlers.get('workspace-extract-office-images');
assert.equal(typeof extractOfficeImages, 'function');

(async () => {
  extractionPayload = {
    success: false,
    documentCount: 2,
    successfulCount: 1,
    failedCount: 1,
    imageCount: 1,
    error: '一个文档提取失败',
    results: [
      { document: firstDocument, documentName: '方案.docx', success: true, count: 1, outputFolder },
      { document: secondDocument, documentName: '损坏.docx', success: false, count: 0, error: '文档损坏' },
    ],
  };
  const partial = await extractOfficeImages(null, temporaryRoot, '进行中', '项目', ['方案.docx', '损坏.docx']);
  assert.equal(partial.success, false, 'partial completion keeps the batch status');
  assert.equal(partial.results.length, 2, 'successful outputs must survive a partial batch failure');
  assert.equal(partial.results[0].outputFolder, outputFolder);
  assert.equal(fileChangeEvents.length, 1, 'partial completion must refresh published files');
  assert.equal(partial.acceptedCount, 2);
  assert.equal(partial.skippedCount, 0);

  const overLimit = await extractOfficeImages(null, temporaryRoot, '进行中', '项目', Array.from({ length: 51 }, (_, index) => `文档-${index}.docx`));
  assert.equal(overLimit.success, false);
  assert.equal(overLimit.requestedCount, 51);
  assert.equal(overLimit.acceptedCount, 0);
  assert.equal(overLimit.skippedCount, 51);
  assert.match(overLimit.error, /最多处理 50/);

  extractionPayload = {
    success: false,
    documentCount: 1,
    successfulCount: 0,
    failedCount: 1,
    imageCount: 0,
    error: '文档损坏',
    results: [{ document: firstDocument, documentName: '方案.docx', success: false, count: 0, error: '文档损坏' }],
  };
  const failed = await extractOfficeImages(null, temporaryRoot, '进行中', '项目', ['方案.docx']);
  assert.equal(failed.success, false);
  assert.equal(failed.error, '文档损坏');
  assert.deepEqual(failed.results, [], 'an entirely failed batch remains a failure state');

  extractionPayload = {
    success: true,
    documentCount: 1,
    successfulCount: 1,
    failedCount: 0,
    imageCount: 1,
    results: [{ document: firstDocument, documentName: '方案.docx', success: true, count: 1, outputFolder: path.join(temporaryRoot, '已落盘但不在发布根内') }],
  };
  const publishFailed = await extractOfficeImages(null, temporaryRoot, '进行中', '项目', ['方案.docx']);
  assert.equal(publishFailed.success, false);
  assert.equal(publishFailed.results.length, 1, 'post-processing failure must preserve the extracted result');
  assert.equal(publishFailed.results[0].success, true);
  assert.equal(publishFailed.results[0].publishSuccess, false);
  assert.match(publishFailed.error, /可从输出目录恢复/);

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  console.log('Office image extraction IPC tests passed');
})().catch(error => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
