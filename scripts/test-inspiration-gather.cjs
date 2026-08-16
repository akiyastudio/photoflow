const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { createMediaAccessService } = require('../electron/services/media-access-service.cjs');
const { createProjectVirtualPathService } = require('../electron/services/project-virtual-path-service.cjs');
const { copyFileAtomic, uniqueDestination } = require('../electron/services/file-transfer-service.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-inspiration-gather-'));
const sourceRoot = path.join(temporaryRoot, '灵感库');
const targetRoot = path.join(temporaryRoot, '项目');
const offlinePreviewRoot = path.join(temporaryRoot, 'offline-preview');
const latePreviewRoot = path.join(temporaryRoot, 'late-preview');
fs.mkdirSync(path.join(sourceRoot, '参考目录'), { recursive: true });
fs.mkdirSync(targetRoot, { recursive: true });
fs.writeFileSync(path.join(sourceRoot, '参考目录', '说明.txt'), 'folder target');
const referenceDirectoryTimes = fs.statSync(path.join(sourceRoot, '参考目录'));
fs.mkdirSync(path.join(sourceRoot, '参考目录', '二级目录'), { recursive: true });
fs.writeFileSync(path.join(sourceRoot, '参考目录', '二级目录', '深层灵感.jpg'), 'nested inspiration');
fs.writeFileSync(path.join(sourceRoot, '画面.jpg'), 'image payload');
fs.writeFileSync(path.join(sourceRoot, '.photoflow-workspace-id'), 'inspiration-workspace-id');

const handlers = new Map();
const undoOperations = [];
const readDirectories = [];
const watchedRoots = [];
const releasedRoots = [];
const grantedRoots = [];
const shortcutDescriptions = new Map();
const shortcutDescriptionsByTarget = new Map();
const shortcutShell = {
  writeShortcutLink: (shortcutPath, options) => {
    fs.writeFileSync(shortcutPath, options.target);
    shortcutDescriptions.set(path.resolve(shortcutPath), options.description || '');
    shortcutDescriptionsByTarget.set(path.resolve(options.target), options.description || '');
    return true;
  },
  readShortcutLink: shortcutPath => {
    const target = fs.readFileSync(shortcutPath, 'utf8');
    return { target, description: shortcutDescriptions.get(path.resolve(shortcutPath)) || shortcutDescriptionsByTarget.get(path.resolve(target)) || '' };
  },
};
const projectVirtualPaths = createProjectVirtualPathService({ shell: shortcutShell, registryPath: path.join(temporaryRoot, 'managed-external-links.json') });
const mediaAccessService = createMediaAccessService({ getWorkspaceRoots: () => [targetRoot] });
const handlerFs = {
  ...fs,
  promises: new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'readdir') return async (...args) => {
        if (path.resolve(args[0]) === path.resolve(offlinePreviewRoot)) return new Promise((_, reject) => {
          setTimeout(() => reject(Object.assign(new Error('network directory unavailable'), { code: 'EHOSTUNREACH' })), 2500);
        });
        readDirectories.push(path.resolve(args[0]));
        const entries = await fs.promises.readdir(...args);
        if (path.resolve(args[0]) !== path.resolve(latePreviewRoot)) return entries;
        return entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()));
      };
      if (property === 'stat') return async candidate => path.resolve(candidate) === path.resolve(offlinePreviewRoot)
        ? { isDirectory: () => true, isFile: () => false }
        : fs.promises.stat(candidate);
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
  mediaService: {
    grantRoot: value => {
      const grantedRoot = mediaAccessService.grantRoot(value);
      grantedRoots.push(grantedRoot);
      return grantedRoot;
    },
  },
  thumbnailService: { indexDirectory: async () => false, scanProject: async () => undefined },
  scheduleMediaTrackingScan: () => undefined,
  shell: shortcutShell,
  projectVirtualPaths,
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
    const managedExternalTarget = path.join(sourceRoot, '参考目录');
    const managedExternalShortcut = path.join(targetRoot, '外部素材.lnk');
    projectVirtualPaths.createManagedExternalLink(managedExternalShortcut, { target: managedExternalTarget, kind: 'folder', displayName: '参考目录' });
    const projectRootBrowse = await browseFiles({}, temporaryRoot, '策划中', '项目');
    const managedExternalEntry = projectRootBrowse.entries.find(entry => entry.name === '外部素材.lnk');
    assert.strictEqual(managedExternalEntry?.externalLink, true, 'managed folder links must be identified as external links in the project root');
    const externalRootBrowse = await browseFiles({}, temporaryRoot, '策划中', '项目', '外部素材.lnk');
    assert.strictEqual(externalRootBrowse.success, true, externalRootBrowse.error);
    assert.strictEqual(externalRootBrowse.viaExternalLink, true);
    assert(externalRootBrowse.entries.some(entry => entry.relativePath.replace(/\\/g, '/') === '外部素材.lnk/说明.txt' && entry.path === path.join(managedExternalTarget, '说明.txt') && entry.viaExternalLink === true), 'managed external links must browse inside the app with virtual project paths and physical external file paths');
    const nestedExternalBrowse = await browseFiles({}, temporaryRoot, '策划中', '项目', '外部素材.lnk/二级目录');
    assert.strictEqual(nestedExternalBrowse.success, true, nestedExternalBrowse.error);
    assert(nestedExternalBrowse.entries.some(entry => entry.name === '深层灵感.jpg'), 'managed external-link browsing must support nested folders');
    const externalSearch = await handlers.get('workspace-search-files')({}, temporaryRoot, '策划中', '项目', '外部素材.lnk', '深层灵感');
    assert.strictEqual(externalSearch.success, true, externalSearch.error);
    assert(externalSearch.entries.some(entry => entry.relativePath.replace(/\\/g, '/') === '外部素材.lnk/二级目录/深层灵感.jpg' && entry.viaExternalLink === true), 'search must stay inside and return virtual paths for a managed external folder');
    const externalList = await handlers.get('workspace-list-files')({}, temporaryRoot, '策划中', '项目', '外部素材.lnk', 20, '', { kinds: ['image'] });
    assert.strictEqual(externalList.success, true, externalList.error);
    assert(externalList.entries.some(entry => entry.name === '深层灵感.jpg' && entry.viaExternalLink === true), 'recursive filtered listing must work inside a managed external folder');
    const externalRecent = await handlers.get('workspace-recent-files')({}, temporaryRoot, '策划中', '项目', '外部素材.lnk', 20);
    assert.strictEqual(externalRecent.success, true, externalRecent.error);
    assert(externalRecent.entries.some(entry => entry.name === '深层灵感.jpg' && entry.viaExternalLink === true), 'recent recursive browsing must work from a managed external-folder scope');
    fs.rmSync(managedExternalShortcut, { force: true });
    shortcutDescriptions.delete(path.resolve(managedExternalShortcut));
    const searchFiles = handlers.get('workspace-search-files');
    assert(searchFiles, 'search-files IPC handler was not registered');
    const searchResult = await searchFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', '深层灵感');
    assert.strictEqual(searchResult.success, true, searchResult.error);
    assert(searchResult.entries.some(entry => entry.relativePath.replace(/\\/g, '/') === '参考目录/二级目录/深层灵感.jpg'), 'inspiration search must recurse through every descendant folder');
    fs.unlinkSync(path.join(sourceRoot, '参考目录', '二级目录', '深层灵感.jpg'));
    fs.rmdirSync(path.join(sourceRoot, '参考目录', '二级目录'));
    fs.utimesSync(path.join(sourceRoot, '参考目录'), referenceDirectoryTimes.atime, referenceDirectoryTimes.mtime);
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
      const previewShortcut = handlers.get('workspace-browse-shortcut-preview');
      assert(previewShortcut, 'shortcut preview IPC handler was not registered');
      const shortcutTargetPath = path.join(sourceRoot, '参考目录');
      const shortcutTargetTimes = fs.statSync(shortcutTargetPath);
      const shortcutMediaPaths = Array.from({ length: 13 }, (_, index) => path.join(shortcutTargetPath, `cover-${index}.jpg`));
      for (const mediaPath of shortcutMediaPaths) fs.writeFileSync(mediaPath, 'preview image');
      grantedRoots.length = 0;
      const folderPreview = await previewShortcut({}, temporaryRoot, '策划中', '项目', path.join('策划', '参考目录.lnk'));
      assert.strictEqual(folderPreview.success, true, folderPreview.error);
      assert.strictEqual(folderPreview.targetKind, 'folder');
      assert.strictEqual(folderPreview.entries.length, 12);
      assert.strictEqual(folderPreview.truncated, true);
      assert(folderPreview.entries.every(entry => entry.readOnly === true && entry.viaShortcut === true));
      assert.deepStrictEqual(grantedRoots, [path.resolve(sourceRoot, '参考目录')], 'a validated folder shortcut must grant only its final target, exactly once');
      const returnedMedia = folderPreview.entries.find(entry => entry.kind === 'image');
      assert(returnedMedia, 'the bounded preview should include a media entry');
      assert.strictEqual(await mediaAccessService.authorizeInput(returnedMedia.path), await fs.promises.realpath(returnedMedia.path), 'returned external media must become authorized after preview validation');

      const fileShortcutPath = path.join(targetRoot, '策划', '画面文件.lnk');
      fs.writeFileSync(fileShortcutPath, path.join(sourceRoot, '画面.jpg'));
      const filePreview = await previewShortcut({}, temporaryRoot, '策划中', '项目', path.join('策划', '画面文件.lnk'));
      assert.strictEqual(filePreview.success, true, filePreview.error);
      assert.strictEqual(filePreview.targetKind, 'file');
      assert.deepStrictEqual(filePreview.entries, []);
      assert.strictEqual(grantedRoots.length, 1, 'file shortcut targets must not grant their parent directory');

      const invalidShortcutPath = path.join(targetRoot, '策划', '无效.lnk');
      fs.writeFileSync(invalidShortcutPath, '');
      const invalidPreview = await previewShortcut({}, temporaryRoot, '策划中', '项目', path.join('策划', '无效.lnk'));
      assert.strictEqual(invalidPreview.success, false);
      assert.strictEqual(invalidPreview.errorCode, 'SHORTCUT_INVALID');
      assert.strictEqual(grantedRoots.length, 1, 'invalid shortcuts must not grant media roots');

      const missingShortcutPath = path.join(targetRoot, '策划', '失效.lnk');
      fs.writeFileSync(missingShortcutPath, path.join(sourceRoot, '不存在'));
      const missingPreview = await previewShortcut({}, temporaryRoot, '策划中', '项目', path.join('策划', '失效.lnk'));
      assert.strictEqual(missingPreview.success, false);
      assert.strictEqual(missingPreview.errorCode, 'SHORTCUT_TARGET_MISSING');
      assert.strictEqual(grantedRoots.length, 1, 'missing shortcut targets must not grant media roots');

      const escapedPreview = await previewShortcut({}, temporaryRoot, '策划中', '项目', path.join('..', '外部.lnk'));
      assert.strictEqual(escapedPreview.success, false);
      assert.strictEqual(escapedPreview.errorCode, 'SHORTCUT_INVALID');
      assert.strictEqual(grantedRoots.length, 1, 'project-escaping shortcut requests must not grant media roots');

      const loopA = path.join(targetRoot, '策划', '循环-A.lnk');
      const loopB = path.join(targetRoot, '策划', '循环-B.lnk');
      fs.writeFileSync(loopA, loopB);
      fs.writeFileSync(loopB, loopA);
      const loopPreview = await previewShortcut({}, temporaryRoot, '策划中', '项目', path.join('策划', '循环-A.lnk'));
      assert.strictEqual(loopPreview.success, false);
      assert.strictEqual(loopPreview.errorCode, 'SHORTCUT_LOOP');
      assert.strictEqual(grantedRoots.length, 1, 'shortcut loops must not grant media roots');

      const offlineShortcut = path.join(targetRoot, '策划', '离线目录.lnk');
      fs.writeFileSync(offlineShortcut, offlinePreviewRoot);
      const offlineStartedAt = Date.now();
      const offlinePreview = await previewShortcut({}, temporaryRoot, '策划中', '项目', path.join('策划', '离线目录.lnk'));
      assert.strictEqual(offlinePreview.success, false);
      assert.strictEqual(offlinePreview.errorCode, 'SHORTCUT_TARGET_OFFLINE');
      assert(Date.now() - offlineStartedAt < 3000, 'offline shortcut previews must fail within the main-process timeout');
      assert.strictEqual(grantedRoots.length, 1, 'unreadable shortcut directories must not grant media roots');

      fs.mkdirSync(latePreviewRoot, { recursive: true });
      for (let index = 0; index < 12; index += 1) fs.mkdirSync(path.join(latePreviewRoot, `folder-${String(index).padStart(2, '0')}`));
      const lateMediaPath = path.join(latePreviewRoot, 'late-cover.jpg');
      fs.writeFileSync(lateMediaPath, 'late preview image');
      const lateShortcutPath = path.join(path.dirname(fileShortcutPath), 'late-preview.lnk');
      fs.writeFileSync(lateShortcutPath, latePreviewRoot);
      const latePreview = await previewShortcut({}, temporaryRoot, '策划中', '项目', path.relative(targetRoot, lateShortcutPath));
      assert.strictEqual(latePreview.success, true, latePreview.error);
      assert.strictEqual(latePreview.entries.length, 1, 'folder entries must not consume the 12 valid shortcut preview candidate slots');
      assert.strictEqual(latePreview.entries[0].path, lateMediaPath, 'preview scanning must continue past the first 12 folders to find later media');
      assert.strictEqual(latePreview.entries[0].kind, 'image');
      assert.strictEqual(grantedRoots.at(-1), path.resolve(latePreviewRoot));
      fs.rmSync(latePreviewRoot, { recursive: true, force: true });
      fs.rmSync(lateShortcutPath, { force: true });
      for (const mediaPath of shortcutMediaPaths) fs.unlinkSync(mediaPath);
      fs.utimesSync(shortcutTargetPath, shortcutTargetTimes.atime, shortcutTargetTimes.mtime);
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
      const shortcutRecentResult = await recentFiles({}, temporaryRoot, '策划中', '项目', '', 50);
      assert.strictEqual(shortcutRecentResult.success, true, shortcutRecentResult.error);
      const linkedEntry = shortcutRecentResult.entries.find(entry => entry.path === path.join(sourceRoot, '参考目录', '说明.txt'));
      assert(linkedEntry, `recent recursive browsing must include files reached through a folder link: ${JSON.stringify(shortcutRecentResult.entries.map(entry => entry.relativePath))}`);
      assert.strictEqual(linkedEntry.path, path.join(sourceRoot, '参考目录', '说明.txt'));
      assert.strictEqual(linkedEntry.viaShortcut, true);
      assert(readDirectories.includes(path.resolve(sourceRoot, '参考目录')), 'recent recursive browsing must read the shortcut target directory');
    }
    const bulkDirectory = path.join(sourceRoot, 'bulk');
    fs.mkdirSync(bulkDirectory);
    for (let index = 0; index < 205; index += 1) fs.writeFileSync(path.join(bulkDirectory, `image-${String(index).padStart(3, '0')}.jpg`), 'x');
    fs.writeFileSync(path.join(bulkDirectory, '.photoflow-paste-hidden.jpg'), 'hidden');
    const listFiles = handlers.get('workspace-list-files');
    const cancelListFiles = handlers.get('workspace-cancel-list-files');
    assert(listFiles && cancelListFiles, 'bounded file-list IPC handlers were not registered');
    const escapedList = await listFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '../outside', 50, '', { kinds: ['image'] });
    assert.strictEqual(escapedList.success, false, 'file-list scope must not escape the project root');
    const expiredList = await listFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', 50, 'expired-file-list-cursor', { kinds: ['image'] });
    assert.strictEqual(expiredList.errorCode, 'FILE_LIST_SESSION_EXPIRED');
    const firstListPage = await listFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', 50, '', { kinds: ['image'] });
    assert.strictEqual(firstListPage.success, true, firstListPage.error);
    assert.strictEqual(firstListPage.entries.length, 50);
    assert.strictEqual(firstListPage.hasMore, true);
    assert(firstListPage.entries.every(entry => entry.kind === 'image' && typeof entry.parentRelativePath === 'string' && entry.parentName), 'file-list entries must include filter results and parent directory metadata');
    assert(!firstListPage.entries.some(entry => entry.name.includes('photoflow')), 'file-list pages must hide internal photoflow entries');
    const mismatchedCursor = await listFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', 50, firstListPage.cursor, { kinds: ['video'] });
    assert.strictEqual(mismatchedCursor.errorCode, 'FILE_LIST_SESSION_EXPIRED', 'a cursor must be bound to its original filter');
    let cursor = firstListPage.cursor;
    let pageCount = 1;
    let listedImages = firstListPage.entries.length;
    while (cursor) {
      const page = await listFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', 50, cursor, { kinds: ['image'] });
      assert.strictEqual(page.success, true, page.error);
      pageCount += 1;
      listedImages += page.entries.length;
      cursor = page.cursor;
    }
    assert(pageCount > 1, 'large recursive listings must be returned over multiple pages');
    assert.strictEqual(listedImages, 206);
    const cancellablePage = await listFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', 1);
    assert(cancellablePage.cursor, 'a partial listing must expose a cancellable cursor');
    assert.strictEqual((await cancelListFiles({}, cancellablePage.cursor)).success, true);
    const cancelledPage = await listFiles({}, sourceRoot, '未分类', '.__photoflow_inspiration__', '', 1, cancellablePage.cursor);
    assert.strictEqual(cancelledPage.errorCode, 'FILE_LIST_CANCELLED');
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
