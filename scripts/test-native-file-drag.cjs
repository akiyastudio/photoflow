const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNativeFileDragService } = require('../electron/services/native-file-drag-service.cjs');
const { registerFileOperationsIpc } = require('../electron/modules/files-ipc.cjs');

const createNativeHarness = () => {
  const calls = [];
  const logs = [];
  const icon = { isEmpty: () => false };
  const sender = { isDestroyed: () => false, startDrag: item => calls.push(item) };
  const service = createNativeFileDragService({
    nativeImage: {
      createFromBitmap: (bitmap, options) => {
        assert.strictEqual(bitmap.length, 32 * 32 * 4);
        assert.deepStrictEqual(options, { width: 32, height: 32, scaleFactor: 1 });
        return icon;
      },
    },
    writeLog: (...args) => logs.push(args),
  });
  return { calls, icon, logs, sender, service };
};

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

const run = async () => {
  const singleFolder = createNativeHarness();
  singleFolder.service.start(singleFolder.sender, ['C:\\project\\folder'], { directoryCount: 1, fileCount: 0, otherCount: 0 });
  assert.deepStrictEqual(singleFolder.calls[0], { file: 'C:\\project\\folder', icon: singleFolder.icon });
  assert(singleFolder.logs.some(([, message, details]) => message === 'Starting native project file drag' && details.directoryCount === 1));
  assert.strictEqual(singleFolder.logs.some(([level]) => level === 'warn'), false, 'elapsed time must not be labeled as drag failure');

  const multiple = createNativeHarness();
  multiple.service.start(multiple.sender, ['C:\\project\\one.jpg', 'C:\\project\\folder']);
  assert.deepStrictEqual(multiple.calls[0], {
    file: 'C:\\project\\one.jpg',
    files: ['C:\\project\\one.jpg', 'C:\\project\\folder'],
    icon: multiple.icon,
  });

  const throwingStart = createNativeHarness();
  throwingStart.sender.startDrag = () => { throw new Error('simulated native failure'); };
  assert.throws(() => throwingStart.service.start(throwingStart.sender, ['C:\\project\\photo.jpg']), /simulated native failure/);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-native-drag-'));
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'folder'));
    const onHandlers = new Map();
    let resolveMouseRelease;
    const releasePromise = new Promise(resolve => { resolveMouseRelease = resolve; });
    const sent = [];
    const sender = {
      isDestroyed: () => false,
      startDrag: () => undefined,
      send: (...args) => sent.push(args),
    };
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process,
      ipcMain: { handle: () => undefined, on: (name, handler) => onHandlers.set(name, handler) },
      fs, path, getProjectPath: () => temporaryRoot,
      assertInside: () => undefined,
      nativeImage: { createFromBitmap: () => ({ isEmpty: () => false }) },
      BrowserWindow: { fromWebContents: () => ({ getContentBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }) }) },
      screen: { getCursorScreenPoint: () => ({ x: 110, y: 220 }), screenToDipPoint: point => point },
      waitForLeftMouseRelease: () => releasePromise,
      activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null },
      writeLog: () => undefined,
    });
    const startDrag = onHandlers.get('workspace-start-file-drag');
    assert.strictEqual(startDrag.constructor.name, 'Function', 'native drag IPC must not be async');
    startDrag({ sender }, 'workspace', '后期中', 'project', ['folder'], {
      sessionId: 'drag-session-a', sourcePageId: 'page-a', origin: 'file-browser', pointerType: 'mouse',
    });
    assert.strictEqual(sent.length, 0, 'startDrag return alone must never authorize an internal drop');
    resolveMouseRelease({ releaseConfirmed: true, leftButtonWasDown: true, waitedMs: 34, cursorCaptured: true, screenX: 110, screenY: 220 });
    await nextTurn();
    await nextTurn();
    assert.strictEqual(sent.length, 1, 'confirmed mouse release must finish the native drag once');
    assert.strictEqual(sent[0][0], 'workspace-file-drag-ended');
    assert.deepStrictEqual(sent[0][1], {
      sessionId: 'drag-session-a', sourcePageId: 'page-a', origin: 'file-browser', paths: ['folder'],
      clientX: 100, clientY: 200, insideWindow: true, started: true, releaseConfirmed: true,
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const filesIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'files-ipc.cjs'), 'utf8');
  const dragHandler = filesIpcSource.slice(filesIpcSource.indexOf("ipcMain.on('workspace-start-file-drag'"), filesIpcSource.indexOf("ipcMain.handle('workspace-file-clipboard-status'"));
  assert(dragHandler.startsWith("ipcMain.on('workspace-start-file-drag', ("), 'the native start listener must remain synchronous');
  assert.strictEqual(/\bawait\b/.test(dragHandler), false, 'the native drag hot path must never await');
  assert(dragHandler.indexOf('mouseReleasePromise = Promise.resolve(waitForLeftMouseRelease())') < dragHandler.indexOf('nativeFileDrag.start('), 'physical release observation must be armed before entering the native drag loop');

  const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const dragStartSource = workspaceSource.slice(workspaceSource.indexOf('const startEntryDrag'), workspaceSource.indexOf('const finishEntryDrag'));
  assert(dragStartSource.includes('event.preventDefault()') && dragStartSource.includes('startProjectFileDrag('), 'every file-browser drag must start as a native file drag');
  assert(dragStartSource.indexOf('if (!dragPaths.length) return;') < dragStartSource.indexOf('fileEntrySelectionAfterDragStart('), 'only an accepted dragstart may select an unselected drag target');
  assert(dragStartSource.includes('if (!selectedPaths.includes(entry.relativePath))'), 'dragging an already-selected target must not replace or re-commit the selected group');
  assert(dragStartSource.includes('fileEntrySelectionAfterDragStart(selectedPaths, entry.relativePath, dragPaths)'), 'selected native drags preserve their full selected group');
  assert.strictEqual(dragStartSource.includes('dataTransfer.setData'), false, 'file-browser drag must not start a parallel HTML payload');
  assert(workspaceSource.includes("onStartFileDrag={(event, entry) => startEntryDrag(event, entry, 'version-tree')}"), 'version-tree Ctrl drag must carry an explicit external-only origin');
  const dragEndSource = workspaceSource.slice(workspaceSource.indexOf('onProjectFileDragEnd(result =>'), workspaceSource.indexOf('const handleSurfaceDragOver'));
  const hitTestIndex = dragEndSource.indexOf('document.elementFromPoint');
  for (const guard of ['result.sessionId !== session.id', '!result.started', '!result.releaseConfirmed', '!result.insideWindow']) {
    const guardIndex = dragEndSource.indexOf(guard);
    assert(guardIndex >= 0 && guardIndex < hitTestIndex, `${guard} must reject the session before DOM hit testing`);
  }
  assert(hitTestIndex >= 0, 'confirmed in-window file-browser drags still hit-test internal folder targets');
  assert(dragEndSource.includes('performDirectoryDrop(movablePaths, [], targetRelativePath, targetName)'), 'dropping project entries onto a folder still performs an internal move');
  assert(workspaceSource.includes("onNotice(`已${operation === 'move' ? '移动' : '导入'} ${result.count} 个项目到 ${targetName}`)"), 'successful internal moves and imports still show their completion toast');
  const inboundSource = workspaceSource.slice(workspaceSource.indexOf('const hasExternalFiles'), workspaceSource.indexOf('const getExternalFilePaths'));
  assert(inboundSource.includes('!nativeFileDragSessionRef.current') && inboundSource.includes("includes('Files')"), 'Explorer files remain importable only while no local native drag owns the page');
  assert(workspaceSource.includes('Array.from(event.dataTransfer.files)') && workspaceSource.includes('performDirectoryDrop([], externalPaths'), 'Explorer file and folder drops still flow through native path import');

  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert(appSource.includes('aria-label="拖动窗口" className="app-window-drag-region min-w-8 flex-1"'), 'the empty titlebar is always a window drag region');
  assert(appSource.includes("titlebarTabDragProps('home')") && appSource.includes('titlebarTabDragProps(projectTabId(page.id))'), 'workspace tabs retain their independent sorting gestures');
  const projectNavigatorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ProjectNavigator.tsx'), 'utf8');
  assert(projectNavigatorSource.includes('draggable={!unavailable}') && projectNavigatorSource.includes("setData('application/x-photoflow-project', project.path)"), 'projects remain draggable with the project-category MIME');
  assert(projectNavigatorSource.includes('onDrop={event => dropProjectOnStatus(event, status)}'), 'project category sections still accept project drops');
  const inspirationSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'inspiration', 'InspirationLibrary.tsx'), 'utf8');
  const folderTabSources = [
    workspaceSource,
    appSource,
    projectNavigatorSource,
    inspirationSource,
    fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'app', 'useFolderTabNavigation.ts'), 'utf8'),
  ].join('\n');
  for (const marker of ['application/x-photoflow-folder-tab', 'photoflow:folder-tab-drag-start', 'photoflow:folder-tab-drag-end', 'data-folder-tab-drop-zone']) {
    assert.strictEqual(folderTabSources.includes(marker), false, `${marker} must be completely absent from the folder and titlebar sources`);
  }
  assert(workspaceSource.includes("onStartFileDrag={(event, entry) => startEntryDrag(event, entry, 'version-tree')}"), 'version-tree Ctrl drags remain explicitly external-only');
  const versionTreeGuardIndex = dragEndSource.indexOf("session.origin === 'version-tree'");
  const internalMoveIndex = dragEndSource.indexOf('performDirectoryDrop(movablePaths, [], targetRelativePath, targetName)');
  assert(versionTreeGuardIndex > hitTestIndex && versionTreeGuardIndex < internalMoveIndex, 'version-tree Ctrl drags inspect only whether the final target needs guidance, then exit before moving');
  assert(dragEndSource.includes("onNotice('版本树中按住 Ctrl 拖动只用于拖到资源管理器，不能移动到应用内文件夹')"), 'dropping a version-tree Ctrl drag on an app folder must explain why no move occurred');
  assert(workspaceSource.includes('<FolderPlus size={14}/>在新标签页打开') && workspaceSource.includes('onOpenDirectoryPage(entry.relativePath)'), 'project folder context-menu opening in a new tab remains available');
  assert(inspirationSource.includes('<FolderPlus size={14}/>在新标签页打开') && inspirationSource.includes('onOpenInNewTab(path)'), 'inspiration folder context-menu opening in a new tab remains available');
  assert(appSource.includes('onOpenDirectoryPage={relativePath => openProjectDirectoryPage(project, relativePath)}'), 'the ProjectWorkspace onOpenDirectoryPage callback remains wired');

  console.log('native file drag tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
