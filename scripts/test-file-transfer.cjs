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

    const dragImportProject = path.join(root, 'drag-import-project');
    const dragImportSource = path.join(root, 'drag-import-source');
    fs.mkdirSync(dragImportProject);
    fs.mkdirSync(path.join(dragImportSource, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dragImportSource, 'nested', 'photo.jpg'), Buffer.alloc(2 * 1024 * 1024, 0x6a));
    const dragImportHandlers = new Map();
    const dragImportReports = [];
    let dragImportCompleted = '';
    let dragImportUndo;
    const dragImportAbort = new AbortController();
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => dragImportHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => dragImportProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, writeLog: () => {},
      assertInside, assertDiskSpace, collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      backgroundTasks: {
        create: () => ({
          deduplicated: false,
          context: {
            signal: dragImportAbort.signal,
            report: (progress, message, metadata) => dragImportReports.push({ progress, message, metadata }),
          },
          waitForStart: async () => {},
          complete: message => { dragImportCompleted = message; },
          fail: error => { throw error; },
          cancelled: () => {},
          isFinished: () => false,
        }),
        cancel: () => dragImportAbort.abort(),
      },
      pushUndoOperation: async operation => { dragImportUndo = operation; },
    });
    const dragImportResult = await dragImportHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'import', [dragImportSource], '',
    );
    assert.strictEqual(dragImportResult.success, true);
    assert.strictEqual(fs.statSync(path.join(dragImportProject, 'drag-import-source', 'nested', 'photo.jpg')).size, 2 * 1024 * 1024);
    assert(dragImportReports.some(report => report.progress === 100 && report.metadata.operation === 'import'), 'drag import must publish completion through the shared file-transfer task');
    assert(dragImportReports.some(report => report.metadata.totalBytes === 2 * 1024 * 1024 && report.metadata.totalFiles === 1), 'drag import must publish byte and file totals');
    assert.strictEqual(dragImportCompleted, '文件导入完成');
    assert.strictEqual(dragImportUndo.kind, 'remove-created');

    const cancelledDragProject = path.join(root, 'cancelled-drag-project');
    const cancelledDragSource = path.join(root, 'cancelled-drag-source');
    fs.mkdirSync(cancelledDragProject);
    fs.mkdirSync(cancelledDragSource);
    fs.writeFileSync(path.join(cancelledDragSource, 'partial.bin'), Buffer.alloc(1024, 0x2a));
    const cancelledDragHandlers = new Map();
    const cancelledDragAbort = new AbortController();
    let cancelledDragReported = false;
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => cancelledDragHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => cancelledDragProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, writeLog: () => {},
      assertInside, assertDiskSpace, collectCopyPlan, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      copyPlannedFiles: async (plan, options) => {
        const fileEntry = plan.find(entry => entry.kind === 'file');
        fs.mkdirSync(path.dirname(fileEntry.destination), { recursive: true });
        options.onCreated(path.dirname(fileEntry.destination));
        fs.writeFileSync(fileEntry.destination, 'partial');
        cancelledDragAbort.abort();
        throwIfCancelled(options.isCancelled);
      },
      backgroundTasks: {
        create: () => ({
          deduplicated: false,
          context: { signal: cancelledDragAbort.signal, report: () => {} },
          waitForStart: async () => {},
          complete: () => {},
          fail: () => {},
          cancelled: () => { cancelledDragReported = true; },
          isFinished: () => false,
        }),
        cancel: () => cancelledDragAbort.abort(),
      },
      pushUndoOperation: async () => {},
    });
    const cancelledDragResult = await cancelledDragHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'import', [cancelledDragSource], '',
    );
    assert.strictEqual(cancelledDragResult.cancelled, true);
    assert.strictEqual(cancelledDragReported, true);
    assert.strictEqual(fs.existsSync(path.join(cancelledDragProject, 'cancelled-drag-source')), false, 'cancelled drag import must roll back partial targets');

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
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => conflictProject, activeProjectFileOperations: new Map(),
      assertInside, assertExistingInside, capturePathIdentity, samePathIdentity,
      fileOperationState: { projectFileClipboard: { operation: 'copy', sources: [staleInternal] } },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [currentSystem] }),
      mainWindow: null, writeLog: () => {},
    });
    const conflictResult = await handlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '',
    );
    assert.strictEqual(conflictResult.success, true);
    assert.strictEqual(conflictResult.requiresDecision.kind, 'paste-conflict');
    assert(conflictResult.requiresDecision.message.includes('same.jpg'), 'the current Windows clipboard item must drive conflict detection');
    assert.strictEqual(fs.readFileSync(path.join(conflictProject, 'same.jpg'), 'utf8'), 'existing destination', 'decision preflight must not modify the destination');

    const screenshotProject = path.join(root, 'screenshot-paste-project');
    fs.mkdirSync(screenshotProject);
    const screenshotHandlers = new Map();
    let screenshotUndo;
    const screenshotBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => screenshotHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => screenshotProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null },
      clipboard: { readImage: () => ({ isEmpty: () => false, toPNG: () => screenshotBytes }) },
      readSystemFileClipboard: async () => null,
      writeLog: () => {}, assertInside, assertExistingInside, throwIfCancelled, uniqueDestination,
      pushUndoOperation: async operation => { screenshotUndo = operation; },
    });
    const screenshotStatus = await screenshotHandlers.get('workspace-file-clipboard-status')();
    assert.strictEqual(screenshotStatus.hasImage, true, 'clipboard image data must enable paste');
    const screenshotResult = await screenshotHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '',
    );
    assert.strictEqual(screenshotResult.success, true);
    assert.strictEqual(screenshotResult.count, 1);
    const screenshotPath = path.join(screenshotProject, screenshotResult.createdItems[0].name);
    assert.deepStrictEqual(fs.readFileSync(screenshotPath), screenshotBytes, 'clipboard screenshot must be persisted as PNG');
    assert.strictEqual(screenshotUndo.kind, 'remove-created');
    assert.strictEqual(screenshotUndo.label, '粘贴截图');

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
      mainWindow: null, writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles: async () => { throw new Error('simulated copy failure'); },
      removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
    });
    const failureResult = await failureHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '', '', { pasteConflictPolicy: 'replace' },
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
      mainWindow: null, writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      recycleBinService: { trash: async () => { throw new Error('simulated recycle failure'); } },
      pushUndoOperation: async operation => { replacementUndo = await addUndoIdentities(operation); },
    });
    const successResult = await successHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '', '', { pasteConflictPolicy: 'replace' },
    );
    assert.strictEqual(successResult.success, true);
    assert.strictEqual(successResult.replacedRetainedCount, 1);
    assert.strictEqual(fs.readFileSync(successTarget, 'utf8'), 'replacement content');
    assert.strictEqual(replacementUndo.kind, 'paste-replace');
    assert.strictEqual(fs.existsSync(replacementUndo.items[0].backup), true);

    const trashProject = path.join(root, 'batch-trash-project');
    fs.mkdirSync(trashProject);
    const trashNames = ['first.txt', 'second.txt'];
    for (const name of trashNames) fs.writeFileSync(path.join(trashProject, name), name);
    const trashHandlers = new Map();
    let trashBatchCalls = 0;
    let trashUndo;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => trashHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => trashProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, ensureWorkspace: () => root,
      capturePathIdentity, writeLog: () => {},
      recycleBinService: {
        trashMany: async sources => {
          trashBatchCalls += 1;
          for (const source of sources) fs.unlinkSync(source);
          return { success: true, items: sources.map((source, index) => ({ success: true, originalPath: source, recyclePidl: `pidl-${index}`, preciseRestore: true, permanent: false })) };
        },
      },
      workspaceRepository: { addUndoRecord: async () => ({ id: 'batch-trash-undo' }) },
      pushUndoOperation: async operation => { trashUndo = operation; },
    });
    const trashResult = await trashHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'trash', trashNames,
    );
    assert.strictEqual(trashResult.success, true);
    assert.strictEqual(trashResult.count, 2);
    assert.strictEqual(trashBatchCalls, 1, 'multi-selection trash must use one native batch request');
    assert.deepStrictEqual(trashUndo.items.map(item => item.recyclePidl), ['pidl-0', 'pidl-1']);
    assert(trashUndo.items.every(item => item.originalIdentity), 'batch trash must preserve every source identity for safe undo');

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

    const occupiedRestorePath = path.join(root, 'occupied-restore.txt');
    fs.writeFileSync(occupiedRestorePath, 'new occupant');
    const restoreHandlers = new Map();
    const restoreHistory = [{
      kind: 'trash',
      items: [{ original: occupiedRestorePath, originalIdentity: { device: '-1', inode: '-1', size: '0', modifiedNs: '0', directory: false }, recyclePidl: 'restore-item' }],
    }];
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => restoreHandlers.set(name, handler) }, fs, path, renameHistory: restoreHistory,
      pathExists: async value => fs.existsSync(value), samePathIdentity,
      recycleBinService: {
        probe: async () => ({ exists: true }),
        restore: async ({ originalPath }) => { fs.writeFileSync(originalPath, 'restored item'); },
      },
    });
    const restoreDecision = await restoreHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(restoreDecision.requiresDecision.kind, 'restore-conflict');
    assert.strictEqual(fs.readFileSync(occupiedRestorePath, 'utf8'), 'new occupant', 'restore decision preflight must not replace the occupied path');
    assert.strictEqual(restoreHistory.length, 1, 'a deferred restore must remain undoable after cancelling the dialog');
    const renamedRestore = await restoreHandlers.get('workspace-undo-rename')(null, '', { restoreConflictPolicy: 'rename' });
    assert.strictEqual(renamedRestore.success, true);
    assert.strictEqual(fs.readFileSync(occupiedRestorePath, 'utf8'), 'new occupant');
    assert.strictEqual(fs.readFileSync(path.join(root, 'occupied-restore (已恢复).txt'), 'utf8'), 'restored item');

    const projectRenameHandlers = new Map();
    const renameWorkspaceRoot = path.join(root, 'rename-workspace');
    const renameSourceName = '26-8-16 临时占用测试';
    const renameTargetName = '26-8-18 临时占用测试';
    const renameSource = path.join(renameWorkspaceRoot, renameSourceName);
    const renameTarget = path.join(renameWorkspaceRoot, renameTargetName);
    fs.mkdirSync(renameSource, { recursive: true });
    let projectRenameAttempts = 0;
    let suspendedRenameWatchers = 0;
    let resumedRenameWatchers = 0;
    const renameFs = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (sourcePath, destinationPath) => {
          if (sourcePath === renameSource && destinationPath === renameTarget && projectRenameAttempts++ < 2) {
            throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
          }
          return fs.promises.rename(sourcePath, destinationPath);
        },
      },
    };
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => projectRenameHandlers.set(name, handler) }, fs: renameFs, path,
      WORKSPACE_STATUSES: ['策划中'], HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(),
      cleanProjectName: value => String(value).trim(), ensureWorkspace: () => renameWorkspaceRoot,
      getProjectPath: (_workspacePath, _status, name) => path.join(renameWorkspaceRoot, name),
      getWorkspaceDataRoot: () => path.join(renameWorkspaceRoot, '.data'),
      workspaceCatalogs: new Map([[renameWorkspaceRoot, { byName: new Map([[renameSourceName.toLocaleLowerCase(), { name: renameSourceName, extra_json: '{}' }]]) }]]),
      mutateWorkspaceCatalog: async () => undefined, pushUndoOperation: async () => undefined,
      cancelMediaTrackingScan: () => undefined, suppressWorkspaceWatchPath: () => undefined, releaseWorkspaceWatchPath: () => undefined,
      suspendFileRootWatcher: () => { suspendedRenameWatchers += 1; return 1; },
      resumeFileRootWatcher: () => { resumedRenameWatchers += 1; return { success: true }; },
      writeLog: () => undefined,
    });
    const projectRenameResult = await projectRenameHandlers.get('workspace-rename-project')(null, renameWorkspaceRoot, '策划中', renameSourceName, { year: 2026, month: 8, day: 18 }, '临时占用测试');
    assert.strictEqual(projectRenameResult.success, true, projectRenameResult.error);
    assert.strictEqual(projectRenameAttempts, 3, 'project rename should retry transient Windows locks');
    assert.strictEqual(suspendedRenameWatchers, 1, 'project rename should suspend its recursive watcher before renaming');
    assert.strictEqual(resumedRenameWatchers, 0, 'a successful rename should let the renderer attach a watcher to the new path');
    assert.strictEqual(fs.existsSync(renameTarget), true);

    const importProjectHandlers = new Map();
    const importWorkspaceRoot = path.join(root, 'import-existing-workspace');
    const importSource = path.join(root, 'outside-existing-project');
    fs.mkdirSync(path.join(importWorkspaceRoot, '策划中'), { recursive: true });
    fs.mkdirSync(path.join(importSource, 'RAW'), { recursive: true });
    fs.mkdirSync(path.join(importSource, 'JPG'), { recursive: true });
    fs.mkdirSync(path.join(importSource, '图片后期_2'), { recursive: true });
    fs.writeFileSync(path.join(importSource, 'RAW', 'IMG_0001.CR3'), 'raw');
    fs.writeFileSync(path.join(importSource, 'JPG', 'IMG_0001.JPG'), 'proxy');
    fs.writeFileSync(path.join(importSource, '图片后期_2', 'IMG_0001.jpg'), 'edited');
    let importedCatalogEntry = null;
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => importProjectHandlers.set(name, handler) }, fs, path,
      CANCELLED_CODE, WORKSPACE_STATUSES: ['策划中'], HIDDEN_SYSTEM_ENTRY_NAMES: new Set(),
      IMAGE_EXTENSIONS: new Set(['.jpg', '.jpeg']), RAW_EXTENSIONS: new Set(['.cr3']), VIDEO_EXTENSIONS: new Set(['.mov']),
      cleanProjectName: value => String(value).trim(), ensureWorkspace: () => importWorkspaceRoot,
      getProjectPath: (_workspacePath, status, name) => path.join(importWorkspaceRoot, status, name),
      getWorkspaceDataRoot: () => path.join(importWorkspaceRoot, '.data'),
      workspaceCatalogs: new Map([[importWorkspaceRoot, { byName: new Map(), projects: [] }]]),
      mutateWorkspaceCatalog: async (_root, _operation, entry) => { importedCatalogEntry = entry; },
      activeProjectFileOperations: new Map(), assertDiskSpace, collectCopyPlan, copyPlannedFiles, removeCopiedSources, throwIfCancelled,
      pushUndoOperation: async () => undefined, writeLog: () => undefined, mainWindow: null,
    });
    const importedProject = await importProjectHandlers.get('workspace-import-existing-project')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      importWorkspaceRoot, importSource, { name: '接管测试', mode: 'copy' },
    );
    assert.strictEqual(importedProject.success, true, importedProject.error);
    assert.strictEqual(fs.readFileSync(path.join(importWorkspaceRoot, '策划中', '接管测试', 'RAW', 'IMG_0001.CR3'), 'utf8'), 'raw');
    assert.strictEqual(fs.existsSync(importSource), true, 'copy import must preserve the external project');
    assert.strictEqual(importedCatalogEntry.name, '接管测试');
    assert.strictEqual(importedProject.candidates[0].name, 'RAW', 'RAW should be proposed as the adoption baseline');
    assert(!importedProject.candidates.some(candidate => candidate.name === 'JPG'), 'a companion JPG folder should be treated as a RAW proxy instead of a second progress');

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
