const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createNativeFileDragService } = require('../electron/services/native-file-drag-service.cjs');

const validImage = name => ({ name, isEmpty: () => false });
const emptyImage = { isEmpty: () => true };
const ownerWindow = { isDestroyed: () => false, isVisible: () => true };

const createHarness = ({ platform = 'win32', times = [100, 120], shellIcon = validImage('shell'), offscreen = false } = {}) => {
  const calls = [];
  const logs = [];
  let clockIndex = 0;
  const fallback = validImage('fallback');
  const sender = {
    isDestroyed: () => false,
    getLastWebPreferences: () => ({ offscreen }),
    startDrag: item => calls.push(item),
  };
  const service = createNativeFileDragService({
    app: { getFileIcon: async () => shellIcon },
    BrowserWindow: { fromWebContents: () => ownerWindow },
    Date: { now: () => times[Math.min(clockIndex++, times.length - 1)] },
    nativeImage: { createFromBitmap: (bitmap, options) => {
      assert.strictEqual(bitmap.length, 32 * 32 * 4);
      assert.deepStrictEqual(options, { width: 32, height: 32, scaleFactor: 1 });
      return fallback;
    } },
    process: { platform },
    writeLog: (...args) => logs.push(args),
  });
  return { calls, fallback, logs, sender, service, shellIcon };
};

const run = async () => {
  const singleFile = createHarness();
  const singleResult = singleFile.service.start(singleFile.sender, ['C:\\project\\photo.jpg']);
  assert.strictEqual(singleResult.status, 'completed');
  assert.deepStrictEqual(singleFile.calls[0], { file: 'C:\\project\\photo.jpg', icon: singleFile.fallback });
  assert.strictEqual('files' in singleFile.calls[0], false, 'single selection must use only Electron file');
  assert(singleFile.logs.some(([, message]) => message === 'Starting native project file drag'));
  assert(singleFile.logs.some(([, message, details]) => message === 'Native project file drag returned' && details.durationMs === 20));

  const singleFolder = createHarness();
  singleFolder.service.start(singleFolder.sender, ['C:\\project\\folder']);
  assert.strictEqual(singleFolder.calls[0].file, 'C:\\project\\folder', 'a real folder path must retain folder semantics');

  const multiple = createHarness();
  assert.deepStrictEqual(await multiple.service.prepare('C:\\project\\one.jpg'), { success: true });
  multiple.service.start(multiple.sender, ['C:\\project\\one.jpg', 'C:\\project\\folder']);
  assert.deepStrictEqual(multiple.calls[0], {
    files: ['C:\\project\\one.jpg', 'C:\\project\\folder'],
    icon: multiple.shellIcon,
  });
  assert.strictEqual('file' in multiple.calls[0], false, 'multiple selection must use only Electron files');

  const emptyShellIcon = createHarness({ shellIcon: emptyImage });
  const prepareFailure = await emptyShellIcon.service.prepare('C:\\project\\folder');
  assert.strictEqual(prepareFailure.success, false);
  emptyShellIcon.service.start(emptyShellIcon.sender, ['C:\\project\\folder']);
  assert.strictEqual(emptyShellIcon.calls[0].icon, emptyShellIcon.fallback, 'empty Shell icons must never reach startDrag');

  const fastWindowsReturn = createHarness({ times: [100, 102] });
  assert.strictEqual(fastWindowsReturn.service.start(fastWindowsReturn.sender, ['C:\\project\\photo.jpg']).status, 'failed-fast');
  assert(fastWindowsReturn.logs.some(([level, message]) => level === 'warn' && message === 'Native project file drag returned'));

  const nonWindows = createHarness({ platform: 'darwin', times: [100, 100] });
  assert.strictEqual(nonWindows.service.start(nonWindows.sender, ['/project/photo.jpg']).status, 'completed', 'non-Windows keeps Electron behavior without the Windows timing guard');

  const offscreenHarness = createHarness({ offscreen: true });
  assert.throws(() => offscreenHarness.service.start(offscreenHarness.sender, ['C:\\project\\photo.jpg']), /离屏页面/);
  assert.strictEqual(offscreenHarness.calls.length, 0);

  const hiddenOwner = createHarness();
  ownerWindow.isVisible = () => false;
  assert.throws(() => hiddenOwner.service.start(hiddenOwner.sender, ['C:\\project\\photo.jpg']), /窗口不可见/);
  ownerWindow.isVisible = () => true;

  const throwingStart = createHarness({ times: [100, 105] });
  throwingStart.sender.startDrag = () => { throw new Error('simulated native failure'); };
  assert.throws(() => throwingStart.service.start(throwingStart.sender, ['C:\\project\\photo.jpg']), error => error.nativeDrag?.status === 'failed' && error.nativeDrag.durationMs === 5);
  assert(throwingStart.logs.some(([level, message, details]) => level === 'error' && message === 'Native project file drag threw' && details.durationMs === 5));

  const filesIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'files-ipc.cjs'), 'utf8');
  const dragHandler = filesIpcSource.slice(filesIpcSource.indexOf("ipcMain.on('workspace-start-file-drag'"), filesIpcSource.indexOf("ipcMain.handle('workspace-file-clipboard-status'"));
  assert(dragHandler.startsWith("ipcMain.on('workspace-start-file-drag', ("), 'the start IPC listener must be synchronous');
  assert.strictEqual(dragHandler.includes('await app.getFileIcon'), false, 'the drag hot path must not await Shell icon lookup');
  assert(dragHandler.includes('nativeFileDrag.start(event.sender, resolved.sources)'));

  const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  assert(workspaceSource.includes("result.nativeDrag?.status === 'failed-fast'"), 'failed native drags must be cleared without internal move fallback');
  assert(workspaceSource.includes('prepareProjectFileDrag(workspacePath'), 'pointer-down must preload the Shell drag icon');

  console.log('native file drag tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
