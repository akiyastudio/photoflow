const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { copyFileAtomic, uniqueDestination } = require('../electron/services/file-transfer-service.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-inspiration-gather-'));
const sourceRoot = path.join(temporaryRoot, '灵感库');
const targetRoot = path.join(temporaryRoot, '项目');
fs.mkdirSync(path.join(sourceRoot, '参考目录'), { recursive: true });
fs.mkdirSync(targetRoot, { recursive: true });
fs.writeFileSync(path.join(sourceRoot, '参考目录', '说明.txt'), 'folder target');
fs.writeFileSync(path.join(sourceRoot, '画面.jpg'), 'image payload');
fs.writeFileSync(path.join(sourceRoot, '.photoflow-workspace-id'), 'inspiration-workspace-id');

const handlers = new Map();
const undoOperations = [];
const readDirectories = [];
const watchedRoots = [];
const releasedRoots = [];
const handlerFs = {
  ...fs,
  promises: new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'readdir') return async (...args) => {
        readDirectories.push(path.resolve(args[0]));
        return fs.promises.readdir(...args);
      };
      return Reflect.get(target, property);
    },
  }),
};
const assertExistingInside = (root, candidate) => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path escaped root');
  if (!fs.existsSync(resolvedCandidate)) throw new Error('path is missing');
  return resolvedCandidate;
};
const assertInside = (root, candidate) => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path escaped root');
  return resolvedCandidate;
};

registerWorkspaceIpc({
  Array, Boolean, Date, Error, Math, Object, Promise, Set, String,
  HIDDEN_SYSTEM_ENTRY_NAMES: new Set(['.photoflow-workspace-id']), IMAGE_EXTENSIONS: new Set(['.jpg']), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(), WORKSPACE_STATUSES: ['未分类', '策划中'],
  fs: handlerFs, path, crypto, copyFileAtomic, uniqueDestination, assertInside, assertExistingInside,
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  acquireFileRootWatcher: root => { watchedRoots.push(path.resolve(root)); return { success: true, root: path.resolve(root) }; },
  releaseFileRootWatcher: root => releasedRoots.push(path.resolve(root)),
  ensureWorkspace: workspacePath => workspacePath,
  getProjectPath: (_workspacePath, _status, projectName) => projectName === '.__photoflow_inspiration__' ? sourceRoot : targetRoot,
  resolveProjectEntry: (_workspacePath, _status, _projectName, relativePath) => path.resolve(sourceRoot, relativePath),
  normalizeMediaCacheSizeGB: value => value,
  mediaRuntimeState: {},
  mediaService: { grantRoot: () => sourceRoot },
  thumbnailService: { indexDirectory: async () => false, scanProject: async () => undefined },
  scheduleMediaTrackingScan: () => undefined,
  shell: {
    writeShortcutLink: (shortcutPath, options) => { fs.writeFileSync(shortcutPath, options.target); return true; },
    readShortcutLink: shortcutPath => ({ target: fs.readFileSync(shortcutPath, 'utf8') }),
  },
  pushUndoOperation: async operation => undoOperations.push(operation),
  mainWindow: { webContents: { send: () => undefined } },
  writeLog: () => undefined,
});

(async () => {
  try {
    const watchFileRoot = handlers.get('workspace-watch-file-root');
    const unwatchFileRoot = handlers.get('workspace-unwatch-file-root');
    assert(watchFileRoot && unwatchFileRoot, 'file-root watcher IPC handlers were not registered');
    const watchResult = await watchFileRoot({}, sourceRoot, '未分类', '.__photoflow_inspiration__');
    assert.strictEqual(watchResult.success, true, watchResult.error);
    await unwatchFileRoot({}, sourceRoot, '未分类', '.__photoflow_inspiration__');
    assert.deepStrictEqual(watchedRoots, [path.resolve(sourceRoot)]);
    assert.deepStrictEqual(releasedRoots, [path.resolve(sourceRoot)]);
    const browseFiles = handlers.get('workspace-browse-files');
    assert(browseFiles, 'browse-files IPC handler was not registered');
    const browseResult = await browseFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__');
    assert.strictEqual(browseResult.success, true, browseResult.error);
    assert(!browseResult.entries.some(entry => entry.name === '.photoflow-workspace-id'), 'the inspiration library must hide its workspace identity marker');
    const gather = handlers.get('workspace-add-inspiration-to-project');
    assert(gather, 'inspiration gather IPC handler was not registered');
    const result = await gather({}, sourceRoot, temporaryRoot, '策划中', '项目', ['参考目录', '画面.jpg']);
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.shortcutCount, 1);
    assert.strictEqual(result.fileCount, 1);
    assert.strictEqual(fs.readFileSync(path.join(targetRoot, '策划', '画面.jpg'), 'utf8'), 'image payload');
    assert.strictEqual(fs.readFileSync(path.join(targetRoot, '策划', '参考目录.lnk'), 'utf8'), path.join(sourceRoot, '参考目录'));
    if (process.platform === 'win32') {
      const resolveShortcut = handlers.get('workspace-resolve-shortcut');
      assert(resolveShortcut, 'shortcut resolution IPC handler was not registered');
      const shortcutResult = await resolveShortcut({}, temporaryRoot, '策划中', '项目', path.join('策划', '参考目录.lnk'));
      assert.strictEqual(shortcutResult.success, true, shortcutResult.error);
      assert.strictEqual(shortcutResult.target, path.join(sourceRoot, '参考目录'));
      assert.strictEqual(shortcutResult.targetKind, 'folder');
    }
    assert.strictEqual(undoOperations.length, 1);
    assert.strictEqual(undoOperations[0].kind, 'remove-created');
    assert.strictEqual(undoOperations[0].paths.length, 2);
    const recentFiles = handlers.get('workspace-recent-files');
    assert(recentFiles, 'recent-files IPC handler was not registered');
    const expiredRecentResult = await recentFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', 1, 'expired-cursor');
    assert.strictEqual(expiredRecentResult.success, false);
    assert.strictEqual(expiredRecentResult.errorCode, 'RECENT_FILES_SESSION_EXPIRED');
    readDirectories.length = 0;
    const recentResult = await recentFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', 1);
    assert.strictEqual(recentResult.success, true, recentResult.error);
    assert.strictEqual(recentResult.entries.length, 1);
    assert.strictEqual(recentResult.entries[0].name, '画面.jpg');
    assert(recentResult.entries[0].updatedAt > 0);
    assert.strictEqual(recentResult.truncated, true);
    assert.deepStrictEqual(readDirectories, [path.resolve(sourceRoot)], 'the recent view must stop before recursively reading an older child directory once its result limit is satisfied');
    const nextRecentResult = await recentFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', 1, recentResult.cursor);
    assert.strictEqual(nextRecentResult.success, true, nextRecentResult.error);
    assert.strictEqual(nextRecentResult.entries.length, 1);
    assert.strictEqual(nextRecentResult.entries[0].name, '说明.txt');
    assert.deepStrictEqual(readDirectories, [path.resolve(sourceRoot), path.resolve(sourceRoot, '参考目录')], 'the next recent page must continue its directory cursor without rescanning the root');
    if (process.platform === 'win32') {
      readDirectories.length = 0;
      const shortcutRecentResult = await recentFiles({}, temporaryRoot, '策划中', '项目', '', 10);
      assert.strictEqual(shortcutRecentResult.success, true, shortcutRecentResult.error);
      const linkedEntry = shortcutRecentResult.entries.find(entry => entry.relativePath.replace(/\\/g, '/') === '策划/参考目录.lnk/说明.txt');
      assert(linkedEntry, 'recent recursive browsing must include files reached through a folder shortcut');
      assert.strictEqual(linkedEntry.path, path.join(sourceRoot, '参考目录', '说明.txt'));
      assert.strictEqual(linkedEntry.viaShortcut, true);
      assert(readDirectories.includes(path.resolve(sourceRoot, '参考目录')), 'recent recursive browsing must read the shortcut target directory');
    }
    console.log('Inspiration gather workflow passed.');
  } finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    assert(resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
