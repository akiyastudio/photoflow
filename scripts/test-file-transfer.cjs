const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerFileOperationsIpc } = require('../electron/modules/files-ipc.cjs');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { addUndoIdentities, assertUndoIdentity, capturePathIdentity, samePathIdentity } = require('../electron/services/file-identity-service.cjs');
const {
  CANCELLED_CODE,
  DEFAULT_SMALL_FILE_CONCURRENCY,
  assertCopyPlanSourcesUnchanged,
  assertDiskSpace,
  assertExistingInside,
  assertInside,
  collectCopyPlan,
  commitTemporaryFile,
  copyFileAtomic,
  copyPlannedFiles,
  moveFileAtomic,
  movePathAtomic,
  removeCopiedSources,
  removeCreatedPasteTargets,
  throwIfCancelled,
  uniqueDestination,
} = require('../electron/services/file-transfer-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-transfer-test-'));

const run = async () => {
  try {
    const source = path.join(root, 'source.bin');
    const copy = path.join(root, 'copy.bin');
    fs.writeFileSync(source, Buffer.alloc(8 * 1024 * 1024, 0x5a));
    let lastProgress = 0;
    await copyFileAtomic(source, copy, { onProgress: value => { lastProgress = value.bytesCopied; } });
    assert.strictEqual(lastProgress, fs.statSync(source).size);
    assert.deepStrictEqual(fs.readFileSync(copy), fs.readFileSync(source));

    const fallbackTemporary = path.join(root, '.fallback.photoflow-part');
    const fallbackTarget = path.join(root, 'fallback.bin');
    fs.writeFileSync(fallbackTemporary, 'rename fallback');
    const fallbackResult = await commitTemporaryFile(fallbackTemporary, fallbackTarget, {
      allowCopyFallback: true,
      maxAttempts: 1,
      renameFile: async () => { throw Object.assign(new Error('simulated Windows scanner lock'), { code: 'EPERM' }); },
    });
    assert.strictEqual(fallbackResult.strategy, 'copy-fallback');
    assert.strictEqual(fs.readFileSync(fallbackTarget, 'utf8'), 'rename fallback');
    assert.strictEqual(fs.existsSync(fallbackTemporary), false);

    const durableSource = path.join(root, 'durable-source.bin');
    const durableTarget = path.join(root, 'durable-target.bin');
    fs.writeFileSync(durableSource, Buffer.alloc(3 * 1024 * 1024, 0x2d));
    await copyFileAtomic(durableSource, durableTarget, { durable: true });
    assert.deepStrictEqual(fs.readFileSync(durableTarget), fs.readFileSync(durableSource));

    const moveSource = path.join(root, 'move-source.bin');
    const moveTarget = path.join(root, 'move-target.bin');
    fs.writeFileSync(moveSource, 'move');
    await moveFileAtomic(moveSource, moveTarget);
    assert.strictEqual(fs.existsSync(moveSource), false);
    assert.strictEqual(fs.readFileSync(moveTarget, 'utf8'), 'move');

    const crossVolumeSource = path.join(root, 'cross-volume-source.bin');
    const crossVolumeTarget = path.join(root, 'cross-volume-target.bin');
    fs.writeFileSync(crossVolumeSource, 'cross-volume move');
    const crossVolumeResult = await movePathAtomic(crossVolumeSource, crossVolumeTarget, {
      renameFile: async () => { throw Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' }); },
    });
    assert.strictEqual(crossVolumeResult.copied, true);
    assert.strictEqual(fs.existsSync(crossVolumeSource), false);
    assert.strictEqual(fs.readFileSync(crossVolumeTarget, 'utf8'), 'cross-volume move');

    const crossVolumeDirectorySource = path.join(root, 'cross-volume-directory-source');
    const crossVolumeDirectoryTarget = path.join(root, 'cross-volume-directory-target');
    fs.mkdirSync(path.join(crossVolumeDirectorySource, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(crossVolumeDirectorySource, 'nested', 'photo.jpg'), 'directory move');
    await movePathAtomic(crossVolumeDirectorySource, crossVolumeDirectoryTarget, {
      renameFile: async () => { throw Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' }); },
    });
    assert.strictEqual(fs.existsSync(crossVolumeDirectorySource), false);
    assert.strictEqual(fs.readFileSync(path.join(crossVolumeDirectoryTarget, 'nested', 'photo.jpg'), 'utf8'), 'directory move');
    assert.strictEqual(fs.readdirSync(root).some(name => name.endsWith('.photoflow-part')), false);

    const cancelSource = path.join(root, 'cancel-source.bin');
    const cancelTarget = path.join(root, 'cancel-target.bin');
    fs.writeFileSync(cancelSource, Buffer.alloc(12 * 1024 * 1024, 0x3c));
    let cancel = false;
    await assert.rejects(
      copyFileAtomic(cancelSource, cancelTarget, {
        isCancelled: () => cancel,
        onProgress: value => { if (value.bytesCopied >= 4 * 1024 * 1024) cancel = true; },
      }),
      error => error.code === CANCELLED_CODE,
    );
    assert.strictEqual(fs.existsSync(cancelTarget), false);
    assert.strictEqual(fs.readdirSync(root).some(name => name.endsWith('.photoflow-part')), false);

    const batchSource = path.join(root, 'batch-source');
    const batchTarget = path.join(root, 'batch-target');
    fs.mkdirSync(path.join(batchSource, 'nested', 'empty'), { recursive: true });
    for (let index = 0; index < 96; index += 1) {
      const directory = index % 2 ? batchSource : path.join(batchSource, 'nested');
      fs.writeFileSync(path.join(directory, `small-${index}.bin`), Buffer.alloc(8 * 1024, index));
    }
    fs.writeFileSync(path.join(batchSource, 'large.bin'), Buffer.alloc(3 * 1024 * 1024, 0x4b));
    const batchPlan = [];
    await collectCopyPlan(batchSource, batchTarget, batchPlan);
    let batchBytesCopied = 0;
    let batchFilesCopied = 0;
    const batchCreated = [];
    const batchStats = await copyPlannedFiles(batchPlan, {
      destinationRoot: root,
      onCreated: target => batchCreated.push(target),
      onProgress: progress => {
        batchBytesCopied += progress.bytesDelta;
        if (progress.fileCompleted) batchFilesCopied += 1;
      },
    });
    assert.strictEqual(batchStats.smallFilesCopied, 96);
    assert.strictEqual(batchStats.largeFilesCopied, 1);
    assert.strictEqual(batchStats.peakSmallConcurrency, DEFAULT_SMALL_FILE_CONCURRENCY);
    assert.strictEqual(batchFilesCopied, 97);
    assert.strictEqual(batchBytesCopied, batchPlan.reduce((sum, entry) => sum + entry.size, 0));
    assert(batchCreated.includes(batchTarget));
    assert.strictEqual(fs.readFileSync(path.join(batchTarget, 'nested', 'small-0.bin'))[0], 0);
    assert.strictEqual(fs.statSync(path.join(batchTarget, 'large.bin')).size, 3 * 1024 * 1024);
    assert(fs.statSync(path.join(batchTarget, 'nested', 'empty')).isDirectory());

    const cancelBatchSource = path.join(root, 'cancel-batch-source');
    const cancelBatchTarget = path.join(root, 'cancel-batch-target');
    fs.mkdirSync(cancelBatchSource);
    for (let index = 0; index < 32; index += 1) {
      fs.writeFileSync(path.join(cancelBatchSource, `small-${index}.bin`), Buffer.alloc(512 * 1024, index));
    }
    const cancelBatchPlan = [];
    await collectCopyPlan(cancelBatchSource, cancelBatchTarget, cancelBatchPlan);
    let cancelBatch = false;
    await assert.rejects(
      copyPlannedFiles(cancelBatchPlan, {
        isCancelled: () => cancelBatch,
        onProgress: progress => { if (progress.fileCompleted) cancelBatch = true; },
      }),
      error => error.code === CANCELLED_CODE,
    );
    assert.strictEqual(fs.readdirSync(root, { recursive: true }).some(name => String(name).endsWith('.photoflow-part')), false);
    await removeCreatedPasteTargets([cancelBatchTarget]);
    assert.strictEqual(fs.existsSync(cancelBatchTarget), false);

    assert.strictEqual(assertInside(root, path.join(root, 'child'), 'test'), path.join(root, 'child'));
    assert.throws(() => assertInside(root, path.join(root, '..', 'outside'), 'test'), /超出允许的目录/);
    const reserved = new Set();
    const first = uniqueDestination(root, 'new.jpg', reserved);
    const second = uniqueDestination(root, 'new.jpg', reserved);
    assert.notStrictEqual(first, second);
    const dottedFolderReserved = new Set();
    const dottedFolder = uniqueDestination(root, 'photos.raw', dottedFolderReserved, true);
    const dottedFolderCopy = uniqueDestination(root, 'photos.raw', dottedFolderReserved, true);
    assert.strictEqual(path.basename(dottedFolder), 'photos.raw');
    assert.strictEqual(path.basename(dottedFolderCopy), 'photos.raw (1)');

    const changedSource = path.join(root, 'changed-after-copy.txt');
    fs.writeFileSync(changedSource, 'before');
    const changedPlan = [];
    await collectCopyPlan(changedSource, path.join(root, 'changed-copy.txt'), changedPlan);
    fs.appendFileSync(changedSource, '-changed');
    await assert.rejects(assertCopyPlanSourcesUnchanged(changedPlan), /发生变化/);
    await assert.rejects(removeCopiedSources(changedPlan), /发生变化/);
    assert.strictEqual(fs.existsSync(changedSource), true);

    const growingSource = path.join(root, 'growing-source');
    fs.mkdirSync(growingSource);
    fs.writeFileSync(path.join(growingSource, 'copied.txt'), 'copied');
    const growingPlan = [];
    await collectCopyPlan(growingSource, path.join(root, 'growing-copy'), growingPlan);
    fs.writeFileSync(path.join(growingSource, 'new.txt'), 'new during copy');
    await assert.rejects(removeCopiedSources(growingPlan), /发生变化/);
    assert.strictEqual(fs.readFileSync(path.join(growingSource, 'new.txt'), 'utf8'), 'new during copy');

    const conflictProject = path.join(root, 'conflict-project');
    const conflictExternal = path.join(root, 'conflict-external');
    fs.mkdirSync(conflictProject);
    fs.mkdirSync(conflictExternal);
    const staleInternal = path.join(conflictExternal, 'old.txt');
    const currentSystem = path.join(conflictExternal, 'same.jpg');
    fs.writeFileSync(staleInternal, 'old clipboard');
    fs.writeFileSync(currentSystem, 'new clipboard');
    fs.writeFileSync(path.join(conflictProject, 'same.jpg'), 'existing destination');
    const handlers = new Map();
    let conflictPrompt;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => conflictProject, activeProjectFileOperations: new Map(),
      assertInside, assertExistingInside, capturePathIdentity, samePathIdentity,
      fileOperationState: { projectFileClipboard: { operation: 'copy', sources: [staleInternal] } },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [currentSystem] }),
      dialog: { showMessageBox: async (_window, options) => { conflictPrompt = options; return { response: 2 }; } },
      mainWindow: null, writeLog: () => {},
    });
    const conflictResult = await handlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '',
    );
    assert.strictEqual(conflictResult.cancelled, true);
    assert.deepStrictEqual(conflictPrompt.buttons, ['替换并继续', '保留两者', '取消']);
    assert(conflictPrompt.message.includes('same.jpg'), 'the current Windows clipboard item must drive conflict detection');

    const failureProject = path.join(root, 'replacement-failure-project');
    const failureExternal = path.join(root, 'replacement-failure-external');
    fs.mkdirSync(failureProject);
    fs.mkdirSync(failureExternal);
    const failureSource = path.join(failureExternal, 'same.txt');
    const failureTarget = path.join(failureProject, 'same.txt');
    fs.writeFileSync(failureSource, 'new content');
    fs.writeFileSync(failureTarget, 'original content');
    const failureHandlers = new Map();
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => failureHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => failureProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [failureSource] }),
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      mainWindow: null, writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles: async () => { throw new Error('simulated copy failure'); },
      removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
    });
    const failureResult = await failureHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '',
    );
    assert.strictEqual(failureResult.success, false);
    assert.strictEqual(fs.readFileSync(failureTarget, 'utf8'), 'original content', 'a failed replacement must not touch the old target');
    assert.strictEqual(fs.readdirSync(failureProject).some(name => name.startsWith('.photoflow-')), false);

    const successProject = path.join(root, 'replacement-success-project');
    const successExternal = path.join(root, 'replacement-success-external');
    fs.mkdirSync(successProject);
    fs.mkdirSync(successExternal);
    const successSource = path.join(successExternal, 'same.txt');
    const successTarget = path.join(successProject, 'same.txt');
    fs.writeFileSync(successSource, 'replacement content');
    fs.writeFileSync(successTarget, 'restorable original');
    const successHandlers = new Map();
    let replacementUndo;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => successHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => successProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, clipboard: { clear: () => {} },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [successSource] }),
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      mainWindow: null, writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      recycleBinService: { trash: async () => { throw new Error('simulated recycle failure'); } },
      pushUndoOperation: async operation => { replacementUndo = await addUndoIdentities(operation); },
    });
    const successResult = await successHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '',
    );
    assert.strictEqual(successResult.success, true);
    assert.strictEqual(successResult.replacedRetainedCount, 1);
    assert.strictEqual(fs.readFileSync(successTarget, 'utf8'), 'replacement content');
    assert.strictEqual(replacementUndo.kind, 'paste-replace');
    assert.strictEqual(fs.existsSync(replacementUndo.items[0].backup), true);

    const undoHandlers = new Map();
    const renameHistory = [replacementUndo];
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => undoHandlers.set(name, handler) }, fs, path, renameHistory,
      assertUndoIdentity, movePathAtomic, pathExists: async value => fs.existsSync(value),
      recycleBinService: { probe: async () => ({ exists: false }), restore: async () => { throw new Error('unexpected recycle restore'); } },
    });
    const undoReplacementResult = await undoHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(undoReplacementResult.success, true);
    assert.strictEqual(fs.readFileSync(successTarget, 'utf8'), 'restorable original');
    assert.strictEqual(fs.readdirSync(successProject).some(name => name.startsWith('.photoflow-')), false);

    const concurrencyHandlers = new Map();
    const activeOperations = new Map();
    let releaseClipboardRead;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => concurrencyHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => conflictProject, activeProjectFileOperations: activeOperations,
      fileOperationState: { projectFileClipboard: null }, assertInside, assertExistingInside,
      readSystemFileClipboard: async () => new Promise(resolve => { releaseClipboardRead = resolve; }),
      mainWindow: null, writeLog: () => {},
    });
    const concurrentHandler = concurrencyHandlers.get('workspace-file-operation');
    const firstPaste = concurrentHandler({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], '');
    await new Promise(resolve => setImmediate(resolve));
    const secondPaste = await concurrentHandler({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], '');
    assert.strictEqual(secondPaste.success, false);
    assert.match(secondPaste.error, /已有文件粘贴任务/);
    releaseClipboardRead(null);
    await firstPaste;
    assert.strictEqual(activeOperations.size, 0);
    console.log('file transfer service tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
