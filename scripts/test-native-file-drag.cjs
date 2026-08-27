const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createFallbackDragIcon } = require('../electron/services/native-file-drag-service.cjs');
const { registerFileOperationsIpc } = require('../electron/modules/files-ipc.cjs');

const run = async () => {
  const {
    nativeFileDragOwnerIdentity,
    nativeFileDragSessionMustReset,
    nativeFileDragTargetFromElement,
    tryStartNativeFileDrag,
  } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'native-file-drag-session-model.ts')).href);

  let fallbackBitmap;
  const fallback = createFallbackDragIcon({ createFromBitmap: bitmap => {
    fallbackBitmap = bitmap;
    return { isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }) };
  } });
  assert(fallback && fallbackBitmap.length === 32 * 32 * 4);
  assert(Array.from({ length: 32 * 32 }, (_, index) => fallbackBitmap[index * 4 + 3]).some(alpha => alpha > 0), 'fallback drag icon must remain visible');

  const ownerA = nativeFileDragOwnerIdentity('page-a', 'C:/project-a');
  assert.strictEqual(nativeFileDragSessionMustReset(ownerA, ownerA, true), false);
  assert.strictEqual(nativeFileDragSessionMustReset(ownerA, nativeFileDragOwnerIdentity('page-b', 'C:/project-a'), true), true);
  assert.strictEqual(nativeFileDragSessionMustReset(ownerA, ownerA, false), true);
  let startFailure = 0;
  assert.strictEqual(tryStartNativeFileDrag(() => { throw new Error('bridge unavailable'); }, () => { startFailure += 1; }), false);
  assert.strictEqual(startFailure, 1);

  const folderElement = {
    dataset: { entryKind: 'folder', entryPath: 'folder' },
    title: 'folder',
    closest: selector => selector.includes('[data-entry-path]') ? folderElement : null,
  };
  const surface = { contains: element => element === folderElement };
  assert.strictEqual(nativeFileDragTargetFromElement({ element: folderElement, surface, currentRelativePath: '', rootLabel: 'project', normalize: value => value })?.relativePath, 'folder');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-native-drag-simple-'));
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'folder'));
    fs.mkdirSync(path.join(temporaryRoot, 'folder-2'));
    const onHandlers = new Map();
    const handleHandlers = new Map();
    const dragItems = [];
    const sent = [];
    const overlayLifecycle = [];
    const shellCalls = [];
    const shellIcon = { name: 'shell', isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }) };
    const sender = {
      isDestroyed: () => false,
      startDrag: item => { overlayLifecycle.push('startDrag'); dragItems.push(item); },
      send: (...args) => sent.push(args),
    };
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process,
      ipcMain: { handle: (name, handler) => handleHandlers.set(name, handler), on: (name, handler) => onHandlers.set(name, handler) },
      fs, path, getProjectPath: () => temporaryRoot,
      assertInside: () => undefined,
      app: { getFileIcon: async (physicalPath, options) => { shellCalls.push([physicalPath, options]); return shellIcon; } },
      nativeImage: { createFromBitmap: () => ({ isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }) }) },
      BrowserWindow: { fromWebContents: () => ({ getContentBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }) }) },
      screen: { getCursorScreenPoint: () => ({ x: 110, y: 220 }) },
      activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null },
      suspendToastOverlayForNativeDrag: () => overlayLifecycle.push('suspend'),
      resumeToastOverlayAfterNativeDrag: () => overlayLifecycle.push('resume'),
      writeLog: () => undefined,
    });

    const startDrag = onHandlers.get('workspace-start-file-drag');
    assert(startDrag && startDrag.constructor.name === 'AsyncFunction', 'the restored main flow may await the real Shell icon before starting');
    await startDrag({ sender }, 'workspace', '后期中', 'project', ['folder'], {
      sessionId: 'session-a', sourcePageId: 'page-a', origin: 'file-browser',
    });
    assert.strictEqual(dragItems.length, 1);
    assert.deepStrictEqual(overlayLifecycle.slice(0, 3), ['suspend', 'startDrag', 'resume'], 'the overlay HWND stays hidden for exactly the blocking native drag interval');
    assert.strictEqual(dragItems[0].icon, shellIcon, 'each drag passes the freshly returned Shell icon directly to startDrag');
    assert.deepStrictEqual(shellCalls[0], [path.join(temporaryRoot, 'folder'), { size: 'normal' }]);
    assert.deepStrictEqual(sent.filter(([channel]) => channel === 'workspace-file-drag-ended').at(-1)[1], {
      sessionId: 'session-a', sourcePageId: 'page-a', origin: 'file-browser', paths: ['folder'],
      clientX: 100, clientY: 200, insideWindow: true, started: true,
    });

    await startDrag({ sender }, 'workspace', '后期中', 'project', ['folder', 'folder-2'], {
      sessionId: 'session-multi', sourcePageId: 'page-a', origin: 'file-browser',
    });
    assert.deepStrictEqual(dragItems.at(-1).files, [path.join(temporaryRoot, 'folder'), path.join(temporaryRoot, 'folder-2')]);
    assert.strictEqual(shellCalls.length, 2, 'every gesture performs a fresh Shell icon lookup instead of reusing a cached NativeImage');

    const endedBeforeInvalid = sent.filter(([channel]) => channel === 'workspace-file-drag-ended').length;
    await startDrag({ sender }, 'workspace', '后期中', 'project', ['missing'], {
      sessionId: 'session-invalid', sourcePageId: 'page-a', origin: 'file-browser',
    });
    const invalidEnds = sent.filter(([channel, result]) => channel === 'workspace-file-drag-ended' && result.sessionId === 'session-invalid');
    assert.strictEqual(invalidEnds.length, 1, 'a failed session completes exactly once');
    assert.strictEqual(invalidEnds[0][1].started, false);
    assert.strictEqual(sent.filter(([channel]) => channel === 'workspace-file-drag-ended').length, endedBeforeInvalid + 1);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const filesIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'files-ipc.cjs'), 'utf8');
  const dragHandler = filesIpcSource.slice(filesIpcSource.indexOf("ipcMain.on('workspace-start-file-drag'"), filesIpcSource.indexOf("ipcMain.handle('workspace-file-clipboard-status'"));
  assert(dragHandler.startsWith("ipcMain.on('workspace-start-file-drag', async"), 'main drag flow is restored to the old async Shell-icon path');
  assert(dragHandler.indexOf("await app.getFileIcon(resolved.sources[0], { size: 'normal' })") < dragHandler.indexOf('event.sender.startDrag('));
  assert(!filesIpcSource.includes('workspace-prepare-file-drag') && !dragHandler.includes('nativeFileDrag.prepare') && !dragHandler.includes('nativeFileDrag.start'));
  assert(!filesIpcSource.includes('workspace-file-drag-renderer-release') && !filesIpcSource.includes('workspace-file-drag-renderer-cancel'));
  assert(!dragHandler.includes('waitForLeftMouseRelease') && !dragHandler.includes('rendererEvidence') && !dragHandler.includes('releaseConfirmed'));

  const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const dragEndSource = workspaceSource.slice(workspaceSource.indexOf('onProjectFileDragEnd(result =>'), workspaceSource.indexOf('const handleSurfaceDragOver'));
  assert(dragEndSource.includes('result.sessionId !== session.id') && dragEndSource.includes('result.sourcePageId !== pageId'), 'renderer keeps session and page identity checks');
  assert(dragEndSource.indexOf('nativeFileDragSessionRef.current = null') < dragEndSource.indexOf('document.elementFromPoint'), 'a session is consumed before processing its final target');
  assert(dragEndSource.includes('if (internalDropHandledRef.current)') && dragEndSource.includes('if (!result.started)') && dragEndSource.includes('if (!result.insideWindow)'), 'renderer keeps only cheap duplicate, start, and window guards');
  assert(!workspaceSource.includes('confirmProjectFileDragRelease') && !workspaceSource.includes('cancelProjectFileDrag'));
  assert(!workspaceSource.includes('prepareProjectFileDrag') && !workspaceSource.includes('nativeDraggingRelativePath') && !workspaceSource.includes('data-native-file-dragging'));
  assert(!dragEndSource.includes('releaseConfirmed') && !dragEndSource.includes('trustedNativeFileDragTarget') && !dragEndSource.includes('stale-target-rejected'));

  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
  assert(!preloadSource.includes('workspace-prepare-file-drag') && !preloadSource.includes('workspace-file-drag-renderer-release') && !preloadSource.includes('workspace-file-drag-renderer-cancel'));
  const cssSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8');
  assert(!cssSource.includes('[data-native-file-dragging="true"]'));
  console.log('native file drag tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
