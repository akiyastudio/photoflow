const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { registerFileOperationsIpc } = require('../electron/modules/files-ipc.cjs');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { registerBrollImportIpc } = require('../electron/modules/broll-import.cjs');
const { createProjectVirtualPathService } = require('../electron/services/project-virtual-path-service.cjs');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { addUndoIdentities, assertUndoIdentity, capturePathIdentity, samePathIdentity } = require('../electron/services/file-identity-service.cjs');
const {
  CANCELLED_CODE,
  SOURCE_CLEANUP_INCOMPLETE_CODE,
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
const filesIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'files-ipc.cjs'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');

assert(mainSource.includes('createFileClipboardService') && !mainSource.includes('runWindowsClipboardScript'), 'file clipboard access must use the native service instead of inline PowerShell');
assert(filesIpcSource.includes('const clearClipboardIfSnapshotCurrent') && filesIpcSource.includes('clearSystemFileClipboardIfCurrent(snapshot)'), 'cut clipboard clearing must delegate sequence and path validation to the native helper');
assert.strictEqual((filesIpcSource.match(/await clearClipboardIfSnapshotCurrent\(clipboardSnapshot\)/g) || []).length, 2, 'both paste completion branches must verify clipboard ownership before clearing');
assert(filesIpcSource.includes('missingCutSources') && filesIpcSource.includes('剪切源已被其他粘贴任务移动或删除'), 'a later paste sharing an already-consumed cut snapshot must return a clear source error');

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

    const cleanupFailureSource = path.join(root, 'cross-volume-cleanup-failure-source');
    const cleanupFailureTarget = path.join(root, 'cross-volume-cleanup-failure-target');
    const cleanupFailureFiles = ['first.raw', 'nested/second.jpg', 'nested/third.mov'];
    for (const [index, relativePath] of cleanupFailureFiles.entries()) {
      const sourcePath = path.join(cleanupFailureSource, relativePath);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, `original-${index}`);
    }
    let sourceDeleteAttempt = 0;
    await assert.rejects(
      movePathAtomic(cleanupFailureSource, cleanupFailureTarget, {
        renameFile: async () => { throw Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' }); },
        removeFile: async (sourcePath, removeOptions) => {
          sourceDeleteAttempt += 1;
          if (sourceDeleteAttempt === 2) throw Object.assign(new Error('simulated source cleanup failure'), { code: 'EACCES' });
          await fs.promises.rm(sourcePath, removeOptions);
        },
      }),
      error => error.code === SOURCE_CLEANUP_INCOMPLETE_CODE
        && error.transferStage === 'cleanup-source'
        && /源清理未完成，可能存在重复内容/.test(error.message),
    );
    assert.strictEqual(sourceDeleteAttempt, 2, 'the injected failure must occur while deleting the second source file');
    assert.strictEqual(fs.existsSync(path.join(cleanupFailureSource, cleanupFailureFiles[0])), false, 'the first source file must already be deleted before the injected failure');
    assert.strictEqual(fs.existsSync(path.join(cleanupFailureSource, cleanupFailureFiles[1])), true, 'the failed source deletion must leave that source file in place');
    assert.strictEqual(fs.existsSync(cleanupFailureTarget), true, 'a committed target directory must survive source cleanup failure');
    for (const [index, relativePath] of cleanupFailureFiles.entries()) {
      const sourcePath = path.join(cleanupFailureSource, relativePath);
      const targetPath = path.join(cleanupFailureTarget, relativePath);
      assert(fs.existsSync(sourcePath) || fs.existsSync(targetPath), `${relativePath} must remain in at least one location`);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), `original-${index}`, `the target copy of ${relativePath} must remain complete`);
    }

    const rollbackProject = path.join(root, 'move-rollback-project');
    const rollbackDestination = path.join(rollbackProject, 'destination');
    fs.mkdirSync(rollbackDestination, { recursive: true });
    fs.writeFileSync(path.join(rollbackProject, 'first.txt'), 'first');
    fs.writeFileSync(path.join(rollbackProject, 'second.txt'), 'second');
    const rollbackHandlers = new Map();
    let moveAttempt = 0;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => rollbackHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => rollbackProject, activeProjectFileOperations: new Map(),
      assertInside, movePathAtomic: async (sourcePath, destinationPath, options) => {
        moveAttempt += 1;
        if (moveAttempt === 2) throw Object.assign(new Error('simulated middle move failure'), { code: 'EIO' });
        return movePathAtomic(sourcePath, destinationPath, options);
      },
      pushUndoOperation: async () => undefined, writeLog: () => undefined,
    });
    const rollbackResult = await rollbackHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'move', ['first.txt', 'second.txt'], 'destination',
    );
    assert.strictEqual(rollbackResult.success, false);
    assert.strictEqual(fs.readFileSync(path.join(rollbackProject, 'first.txt'), 'utf8'), 'first', 'a failed batch move must roll back earlier items');
    assert.strictEqual(fs.readFileSync(path.join(rollbackProject, 'second.txt'), 'utf8'), 'second');
    assert.strictEqual(fs.readdirSync(rollbackDestination).length, 0, 'rollback must leave no moved item in the destination');
    assert(rollbackResult.operationId && rollbackResult.affectedDirectories.includes('destination'));

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
    let replayWrites = 0;
    const replayStats = await copyPlannedFiles(batchPlan, {
      destinationRoot: root,
      isEntryComplete: async entry => {
        const stat = await fs.promises.stat(entry.destination).catch(() => null);
        return entry.kind === 'directory' ? Boolean(stat?.isDirectory()) : Boolean(stat?.isFile() && stat.size === entry.size);
      },
      onEntryComplete: async () => { replayWrites += 1; },
    });
    assert.strictEqual(replayStats.resumedFiles, 97, 'a resumed copy must skip every previously committed file');
    assert.strictEqual(replayStats.smallFilesCopied, 0);
    assert.strictEqual(replayStats.largeFilesCopied, 0);
    assert.strictEqual(replayWrites, 0, 'skipped checkpoint entries must not be committed again');
    const pausedSource = path.join(root, 'paused-source.bin');
    const pausedTarget = path.join(root, 'paused-target.bin');
    fs.writeFileSync(pausedSource, Buffer.alloc(4 * 1024 * 1024, 0x2a));
    const pausedPlan = [];
    await collectCopyPlan(pausedSource, pausedTarget, pausedPlan);
    let releasePause;
    let paused = true;
    const pausePromise = new Promise(resolve => { releasePause = resolve; });
    const pausedCopy = copyPlannedFiles(pausedPlan, {
      destinationRoot: root,
      waitIfPaused: async () => { if (paused) await pausePromise; },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(fs.existsSync(pausedTarget), false, 'a paused transfer must not commit its target');
    paused = false;
    releasePause();
    await pausedCopy;
    assert.strictEqual(fs.statSync(pausedTarget).size, fs.statSync(pausedSource).size, 'continued transfer must complete the target');

    const resumedPasteProject = path.join(root, 'resumed-paste-project');
    const resumedPasteSources = path.join(root, 'resumed-paste-sources');
    fs.mkdirSync(resumedPasteProject);
    fs.mkdirSync(resumedPasteSources);
    const resumeSourceA = path.join(resumedPasteSources, 'first.bin');
    const resumeSourceB = path.join(resumedPasteSources, 'second.bin');
    const resumeSourceFolder = path.join(resumedPasteSources, 'folder');
    fs.writeFileSync(resumeSourceA, Buffer.alloc(1024, 0x31));
    fs.writeFileSync(resumeSourceB, Buffer.alloc(2048, 0x32));
    fs.mkdirSync(resumeSourceFolder);
    fs.writeFileSync(path.join(resumeSourceFolder, 'nested.txt'), 'resumed-folder');
    const resumeOperationId = 'paste-resume-test';
    const resumeCheckpoint = {
      version: 1, kind: 'paste-copy-v1', phase: 'copying', workspacePath: 'workspace', status: '策划中', projectName: 'project', targetRelativePath: '',
      files: [resumeSourceA, resumeSourceB, resumeSourceFolder].map((source, index) => {
        const stat = fs.statSync(source);
        return { source, destinationName: path.basename(source), stagedName: `${index}-${path.basename(source)}`, size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() };
      }),
    };
    const resumePersistencePath = path.join(root, 'paste-resume-tasks.json');
    const interruptedPasteTasks = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath: resumePersistencePath });
    const interruptedPaste = interruptedPasteTasks.create({ id: resumeOperationId, type: 'project-file-operation', title: '粘贴恢复测试' });
    await interruptedPaste.waitForStart();
    interruptedPaste.context.saveCheckpoint(resumeCheckpoint, 40, '正在粘贴');
    const incomingResumeRoot = path.join(resumedPasteProject, `.photoflow-paste-${resumeOperationId}`);
    fs.mkdirSync(incomingResumeRoot);
    const resumeFingerprintPlan = [];
    for (const item of resumeCheckpoint.files) await collectCopyPlan(item.source, path.join(incomingResumeRoot, item.stagedName), resumeFingerprintPlan);
    resumeCheckpoint.planFingerprint = crypto.createHash('sha256').update(resumeFingerprintPlan.map(entry => JSON.stringify({ kind: entry.kind, source: path.resolve(entry.source), size: Number(entry.size) || 0, identity: entry.sourceIdentity || {}, children: entry.children || [] })).sort().join('\n')).digest('hex');
    interruptedPaste.context.saveCheckpoint(resumeCheckpoint, 40, '正在粘贴');
    const completedStage = path.join(incomingResumeRoot, resumeCheckpoint.files[0].stagedName);
    fs.copyFileSync(resumeSourceA, completedStage);
    fs.utimesSync(completedStage, fs.statSync(resumeSourceA).atime, fs.statSync(resumeSourceA).mtime);
    interruptedPasteTasks.stop();
    const restoredPasteTasks = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath: resumePersistencePath });
    let resumedPasteUndo = null;
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: () => undefined, on: () => undefined }, fs, path,
      getProjectPath: () => resumedPasteProject, activeProjectFileOperations: new Map(), backgroundTasks: restoredPasteTasks,
      assertInside, assertDiskSpace, collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      pushUndoOperation: async operation => { resumedPasteUndo = operation; }, writeLog: () => undefined,
    });
    assert.strictEqual(restoredPasteTasks.get(resumeOperationId).resumeAvailable, true, 'an interrupted plain file paste must expose continue');
    const resumedPaste = await restoredPasteTasks.resume(resumeOperationId);
    assert.strictEqual(resumedPaste.task.state, 'completed');
    assert.strictEqual(fs.readFileSync(path.join(resumedPasteProject, 'first.bin')).length, 1024);
    assert.strictEqual(fs.readFileSync(path.join(resumedPasteProject, 'second.bin')).length, 2048);
    assert.strictEqual(fs.readFileSync(path.join(resumedPasteProject, 'folder', 'nested.txt'), 'utf8'), 'resumed-folder');
    assert.strictEqual(fs.existsSync(incomingResumeRoot), false);
    assert.deepStrictEqual(resumedPasteUndo.paths.sort(), [path.join(resumedPasteProject, 'first.bin'), path.join(resumedPasteProject, 'second.bin'), path.join(resumedPasteProject, 'folder')].sort());
    restoredPasteTasks.stop();
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
    let importCopyPlanCalls = 0;
    let importInspectionReadCalls = 0;
    let externallyOpenedPath = '';
    let progressRegistrationPath = '';
    let failProgressRelocation = false;
    let failShortcutRemoval = false;
    let failExternalAdoptionRollback = false;
    let failImportUndoOperation = false;
    let failManagedLinkRevoke = false;
    let failManagedExternalWatcher = false;
    let failCreatedTargetRemoval = false;
    let managedWatcherAcquisitions = 0;
    let trackingReconciliations = 0;
    let materializedProgressFolders = [];
    const importUndoOperations = [];
    const revertedExternalAdoptions = [];
    const unregisteredExternalProgress = [];
    const importFs = {
      ...fs,
      promises: {
        ...fs.promises,
        readdir: async (...args) => { importInspectionReadCalls += 1; return fs.promises.readdir(...args); },
        rm: async (target, options) => {
          if (failShortcutRemoval && path.extname(String(target)).toLowerCase() === '.lnk') throw Object.assign(new Error('simulated shortcut lock'), { code: 'EPERM' });
          if (failCreatedTargetRemoval && String(target).includes('cleanup-copy')) throw Object.assign(new Error('simulated copied target lock'), { code: 'EPERM' });
          return fs.promises.rm(target, options);
        },
      },
    };
    const importShell = {
      writeShortcutLink: (shortcutPath, details) => {
        fs.writeFileSync(shortcutPath, JSON.stringify(details));
        return true;
      },
      readShortcutLink: shortcutPath => JSON.parse(fs.readFileSync(shortcutPath, 'utf8')),
      openPath: async target => { externallyOpenedPath = target; return ''; },
    };
    const importProjectVirtualPaths = createProjectVirtualPathService({
      shell: importShell,
      registryPath: path.join(root, 'managed-external-links.json'),
    });
    const revokeImportedManagedLinks = importProjectVirtualPaths.revokeManagedExternalLinkIds;
    importProjectVirtualPaths.revokeManagedExternalLinkIds = linkIds => {
      if (failManagedLinkRevoke) throw new Error('simulated managed-link registry write failure');
      return revokeImportedManagedLinks(linkIds);
    };
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => importProjectHandlers.set(name, handler) }, fs: importFs, path,
      CANCELLED_CODE, WORKSPACE_STATUSES: ['策划中'], HIDDEN_SYSTEM_ENTRY_NAMES: new Set(),
      IMAGE_EXTENSIONS: new Set(['.jpg', '.jpeg']), RAW_EXTENSIONS: new Set(['.cr3']), VIDEO_EXTENSIONS: new Set(['.mov']),
      cleanProjectName: value => String(value).trim(), ensureWorkspace: () => importWorkspaceRoot,
      getProjectPath: (_workspacePath, status, name) => path.join(importWorkspaceRoot, status, name),
      resolveProjectEntry: (_workspacePath, status, name, relativePath) => path.join(importWorkspaceRoot, status, name, relativePath),
      getWorkspaceDataRoot: () => path.join(importWorkspaceRoot, '.data'),
      workspaceCatalogs: new Map([[importWorkspaceRoot, { byName: new Map(), projects: [] }]]),
      mutateWorkspaceCatalog: async (_root, _operation, entry) => {
        importedCatalogEntry = entry;
        return { byName: new Map([[entry.name.toLocaleLowerCase(), { id: 'imported-project-id', name: entry.name }]]), projects: [] };
      },
      activeProjectFileOperations: new Map(), assertDiskSpace, assertInside, assertExistingInside, uniqueDestination, movePathAtomic,
      collectCopyPlan: async (...args) => { importCopyPlanCalls += 1; return collectCopyPlan(...args); },
      copyPlannedFiles, removeCopiedSources, throwIfCancelled, shell: importShell,
      projectVirtualPaths: importProjectVirtualPaths,
      acquireFileRootWatcher: watchedRoot => {
        managedWatcherAcquisitions += 1;
        if (failManagedExternalWatcher && path.resolve(watchedRoot) !== path.resolve(fileLinkProjectPath)) return { success: false, error: 'simulated external watcher failure' };
        return { success: true };
      },
      releaseFileRootWatcher: () => undefined,
      mediaRuntimeState: {}, mediaService: { grantRoot: () => undefined }, normalizeMediaCacheSizeGB: value => value || 1,
      thumbnailService: { indexDirectory: () => undefined },
      versionService: {
        listProgress: async () => ({ progressFolders: materializedProgressFolders }),
        detectProgressStale: async () => { trackingReconciliations += 1; return { success: true, staleProgressIds: [] }; },
        adoptMediaFolder: async (_workspaceRoot, request) => ({ success: true, created: true, progressFolder: { id: `adopted-${path.basename(request.folderPath)}` } }),
        revertExternalAdoptions: async (_workspaceRoot, request) => {
          revertedExternalAdoptions.push(request);
          if (failExternalAdoptionRollback) throw new Error('simulated external adoption rollback failure');
          return { success: true, removedProgressIds: request.progressIds };
        },
        unregisterProgress: async (_workspaceRoot, request) => { unregisteredExternalProgress.push(request); return { success: true }; },
        registerProgress: async (_workspaceRoot, request) => {
          if (failProgressRelocation) return { success: false, error: 'simulated progress relocation failure' };
          progressRegistrationPath = request.folderPath;
          return { success: true, progressFolder: { ...request, id: request.progressId || 'progress-id' } };
        },
      },
      renameHistory: importUndoOperations,
      assertUndoIdentity: async (_operation, target) => {
        if (!fs.existsSync(target)) throw Object.assign(new Error('missing undo target'), { code: 'UNDO_IDENTITY_MISMATCH' });
      },
      pushUndoOperation: async operation => {
        if (failImportUndoOperation) throw new Error('simulated undo persistence failure');
        const stored = { ...operation, undoToken: crypto.randomUUID() };
        importUndoOperations.push(stored);
        return stored;
      },
      removeUndoOperation: undoToken => {
        const index = importUndoOperations.findIndex(operation => operation.undoToken === undoToken);
        if (index < 0) return false;
        importUndoOperations.splice(index, 1);
        return true;
      }, writeLog: () => undefined, mainWindow: null,
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
    const externallyOpenedFolder = await importProjectHandlers.get('workspace-open-entry')(
      null, importWorkspaceRoot, '策划中', '接管测试', 'RAW',
    );
    assert.strictEqual(externallyOpenedFolder.success, true, externallyOpenedFolder.error);
    assert.strictEqual(externallyOpenedPath, path.join(importWorkspaceRoot, '策划中', '接管测试', 'RAW'), 'folder details external-open must delegate to the system shell');

    const linkSource = path.join(root, 'outside-linked-project');
    fs.mkdirSync(path.join(linkSource, 'RAW'), { recursive: true });
    fs.writeFileSync(path.join(linkSource, 'RAW', 'LINK_0001.CR3'), 'linked-raw');
    const inspectedLinkProject = await importProjectHandlers.get('workspace-inspect-existing-project')(null, linkSource);
    assert.strictEqual(inspectedLinkProject.success, true, inspectedLinkProject.error);
    assert(inspectedLinkProject.inspectionToken, 'project inspection must return a reusable server-side token');
    assert.strictEqual(importProjectHandlers.has('workspace-import-existing-project-link'), false, 'project import must not expose a dedicated link-only IPC');
    const forcedLinkProject = await importProjectHandlers.get('workspace-import-existing-project')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      importWorkspaceRoot, linkSource, { name: 'forced-linked-project', mode: 'link', operationId: '12345678-1234-4123-8123-123456789abc', inspectionToken: inspectedLinkProject.inspectionToken },
    );
    assert.strictEqual(forcedLinkProject.success, false, 'forcing project link mode through IPC must be rejected');
    assert.match(forcedLinkProject.error, /只支持复制并接管或剪切并接管/);
    assert.strictEqual(fs.readFileSync(path.join(linkSource, 'RAW', 'LINK_0001.CR3'), 'utf8'), 'linked-raw');
    const linkedProjectPath = path.join(importWorkspaceRoot, '策划中', 'linked-project');
    assert.strictEqual(fs.existsSync(linkedProjectPath), false, 'rejected link mode must not create a project');

    const fileLinkProjectName = 'file-link-project';
    const fileLinkProjectPath = path.join(importWorkspaceRoot, '策划中', fileLinkProjectName);
    const linkedFolderSource = path.join(root, 'linked-folder-source');
    const linkedFileSource = path.join(root, 'linked-file-source.jpg');
    fs.mkdirSync(fileLinkProjectPath, { recursive: true });
    fs.mkdirSync(linkedFolderSource, { recursive: true });
    fs.writeFileSync(path.join(linkedFolderSource, 'inside.jpg'), 'inside');
    fs.writeFileSync(linkedFileSource, 'linked-file');
    const linkedFiles = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', { linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [linkedFolderSource, linkedFileSource] },
    );
    assert.strictEqual(linkedFiles.success, true, linkedFiles.error);
    assert.strictEqual(linkedFiles.linked, true);
    assert.deepStrictEqual(linkedFiles.items.map(item => ({ relativePath: item.relativePath, kind: item.kind })), [
      { relativePath: 'linked-folder-source.lnk', kind: 'folder' },
      { relativePath: 'linked-file-source.jpg.lnk', kind: 'file' },
    ], 'link-only imports must return the exact managed entries so semantic import flows can register their version-tree roles');
    assert.deepStrictEqual(linkedFiles.items.map(item => ({ relativePath: item.relativePath, kind: item.kind })), [
      { relativePath: 'linked-folder-source.lnk', kind: 'folder' },
      { relativePath: 'linked-file-source.jpg.lnk', kind: 'file' },
    ], 'link-only imports must return the exact managed entries so semantic import flows can register their version-tree roles');
    assert.strictEqual(fs.readFileSync(path.join(linkedFolderSource, 'inside.jpg'), 'utf8'), 'inside');
    assert.strictEqual(fs.readFileSync(linkedFileSource, 'utf8'), 'linked-file');
    const linkedProjectRoot = await importProjectHandlers.get('workspace-browse-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {},
    );
    assert.strictEqual(linkedProjectRoot.success, true, linkedProjectRoot.error);
    const managedExternalFolder = linkedProjectRoot.entries.find(entry => entry.externalLink);
    assert.strictEqual(managedExternalFolder.externalLinkTarget, linkedFolderSource, 'managed external roots must expose their validated target for version-tree identity matching');
    const browsedManagedExternalFolder = await importProjectHandlers.get('workspace-browse-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, managedExternalFolder.relativePath, {},
    );
    assert.strictEqual(browsedManagedExternalFolder.success, true, browsedManagedExternalFolder.error);
    assert(browsedManagedExternalFolder.entries.some(entry => entry.name === 'inside.jpg' && entry.viaExternalLink), 'managed external folders must browse through the normal in-app folder route');
    assert.deepStrictEqual(fs.readdirSync(fileLinkProjectPath).sort(), ['linked-file-source.jpg.lnk', 'linked-folder-source.lnk']);

    const managedRootGuardHandlers = new Map();
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => managedRootGuardHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => fileLinkProjectPath, ensureWorkspace: () => importWorkspaceRoot,
      projectVirtualPaths: importProjectVirtualPaths, activeProjectFileOperations: new Map(),
      versionService: { listProgress: async () => ({ success: true, progressFolders: [{ externalLinkRelativePath: 'linked-folder-source.lnk' }] }) },
      pushUndoOperation: async () => undefined, writeLog: () => undefined,
    });
    const requestedMetadataPath = process.platform === 'win32'
      ? 'linked-folder-source.lnk\\inside.jpg'
      : 'linked-folder-source.lnk/inside.jpg';
    const externalFileDetails = await managedRootGuardHandlers.get('workspace-file-details')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, [requestedMetadataPath],
    );
    assert.strictEqual(externalFileDetails.success, true, externalFileDetails.error);
    assert.strictEqual(externalFileDetails.details.length, 1);
    assert.strictEqual(externalFileDetails.details[0].relativePath, requestedMetadataPath,
      'file-detail responses must preserve the requested path identity so Windows metadata hydration can match browse entries');
    assert.strictEqual(externalFileDetails.details[0].size, 6);
    const blockedTrackedMove = await managedRootGuardHandlers.get('workspace-file-operation')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'move', ['linked-folder-source.lnk'], '',
    );
    assert.strictEqual(blockedTrackedMove.success, false);
    assert.match(blockedTrackedMove.error, /已纳入版本树的外链不能使用普通移动或重命名/);
    const blockedTrackedRename = await managedRootGuardHandlers.get('workspace-file-operation')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'rename', ['linked-folder-source.lnk'], '', 'renamed-link',
    );
    assert.strictEqual(blockedTrackedRename.success, false);
    assert.match(blockedTrackedRename.error, /已纳入版本树的外链不能使用普通移动或重命名/);
    const blockedManagedCopy = await managedRootGuardHandlers.get('workspace-file-operation')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'copy', ['linked-folder-source.lnk'], '',
    );
    assert.strictEqual(blockedManagedCopy.success, false);
    assert.match(blockedManagedCopy.error, /外链根不能通过普通复制或剪切/);

    const preservedAdoptionSource = path.join(root, 'preserved-adoption-source');
    const preservedAdoptionShortcut = path.join(fileLinkProjectPath, 'preserved-adoption-source.lnk');
    fs.mkdirSync(preservedAdoptionSource, { recursive: true });
    fs.writeFileSync(path.join(preservedAdoptionSource, 'preserved.jpg'), 'preserved');
    failImportUndoOperation = true;
    failExternalAdoptionRollback = true;
    const failedAdoptionRollback = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [preservedAdoptionSource], adoptAsOriginal: true, mediaKind: 'image',
      },
    );
    failImportUndoOperation = false;
    failExternalAdoptionRollback = false;
    assert.strictEqual(failedAdoptionRollback.success, false, 'the original import failure must still be reported');
    assert.strictEqual(failedAdoptionRollback.recoveryRequired, true, 'a failed database rollback must advertise recovery state');
    assert.match(failedAdoptionRollback.error, /部分导入结果已保留/);
    assert(failedAdoptionRollback.recovery.cleanupErrors.some(item => item.path === 'external-adoption-registry'));
    assert.strictEqual(fs.existsSync(preservedAdoptionShortcut), true, 'a link still referenced by the database must be preserved');
    assert(importProjectVirtualPaths.readManagedExternalLink(preservedAdoptionShortcut), 'the preserved shortcut must retain its managed identity');

    failManagedExternalWatcher = true;
    const degradedWatch = await importProjectHandlers.get('workspace-watch-file-root')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, { reconcile: true },
    );
    assert.strictEqual(degradedWatch.success, true, 'the healthy project watcher must remain usable');
    assert.strictEqual(degradedWatch.degraded, true, 'one failed external watcher must degrade the aggregate result');
    assert(degradedWatch.failedRoots.some(item => item.external && item.virtualPath), 'failed external roots must be reported to the renderer');
    assert.strictEqual(trackingReconciliations > 0, true, 'watcher installation must reconcile changes missed while inactive');

    const degradedImportSource = path.join(root, 'degraded-watcher-import');
    fs.mkdirSync(degradedImportSource, { recursive: true });
    const undoCountBeforeDegradedImport = importUndoOperations.length;
    const degradedImport = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [degradedImportSource],
      },
    );
    assert.strictEqual(degradedImport.success, true, degradedImport.error);
    assert.strictEqual(degradedImport.watchDegraded, true, 'watch failure must use polling fallback instead of rolling back a valid import');
    assert.strictEqual(importUndoOperations.length, undoCountBeforeDegradedImport + 1, 'watch failure must leave exactly one valid undo record');
    failManagedExternalWatcher = false;

    const lockedRollbackSource = path.join(root, 'locked-rollback-source');
    const lockedRollbackShortcut = path.join(fileLinkProjectPath, 'locked-rollback-source.lnk');
    fs.mkdirSync(lockedRollbackSource, { recursive: true });
    failImportUndoOperation = true;
    failShortcutRemoval = true;
    const lockedRollback = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [lockedRollbackSource], adoptAsOriginal: true, mediaKind: 'image',
      },
    );
    failImportUndoOperation = false;
    failShortcutRemoval = false;
    assert.strictEqual(lockedRollback.recoveryRequired, true);
    assert(lockedRollback.recovery.cleanupErrors.some(item => item.path === lockedRollbackShortcut));
    assert.strictEqual(fs.existsSync(lockedRollbackShortcut), true, 'a locked shortcut must be reported and retained');
    assert(importProjectVirtualPaths.readManagedExternalLink(lockedRollbackShortcut), 'a retained shortcut must keep its managed identity');

    const cleanupCopySource = path.join(root, 'cleanup-copy-source.jpg');
    const cleanupCopyTarget = path.join(fileLinkProjectPath, 'cleanup-copy-source.jpg');
    fs.writeFileSync(cleanupCopySource, 'copy-cleanup');
    failImportUndoOperation = true;
    failCreatedTargetRemoval = true;
    const failedCopyCleanup = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        deleteSourceAfterImport: false, sourcePaths: [cleanupCopySource],
      },
    );
    failImportUndoOperation = false;
    failCreatedTargetRemoval = false;
    assert.strictEqual(failedCopyCleanup.recoveryRequired, true, 'ordinary copy cleanup failures must be surfaced');
    assert(failedCopyCleanup.recovery.leftoverPaths.includes(cleanupCopyTarget));
    assert.strictEqual(fs.existsSync(cleanupCopyTarget), true);

    const retryableUndoSource = path.join(root, 'retryable-undo-source');
    fs.mkdirSync(retryableUndoSource, { recursive: true });
    const retryableUndoImport = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [retryableUndoSource],
      },
    );
    assert.strictEqual(retryableUndoImport.success, true, retryableUndoImport.error);
    const retryableUndoShortcut = path.join(fileLinkProjectPath, 'retryable-undo-source.lnk');
    assert.deepStrictEqual(importUndoOperations.at(-1).managedExternalWatcher, {
      workspacePath: importWorkspaceRoot, status: '策划中', projectName: fileLinkProjectName,
    });
    const watcherAcquisitionsBeforeUndo = managedWatcherAcquisitions;
    failManagedLinkRevoke = true;
    const firstUndoAttempt = await importProjectHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(firstUndoAttempt.success, false, 'a registry failure must be reported without losing the undo operation');
    assert.strictEqual(fs.existsSync(retryableUndoShortcut), false, 'the shortcut removal may already have committed before the registry failure');
    failManagedLinkRevoke = false;
    const retriedUndo = await importProjectHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(retriedUndo.success, true, retriedUndo.error);
    assert(managedWatcherAcquisitions > watcherAcquisitionsBeforeUndo, 'undoing an external link must rebuild the project watcher bindings');

    const adoptedFolderSource = path.join(root, 'adopted-external-original');
    fs.mkdirSync(adoptedFolderSource, { recursive: true });
    fs.writeFileSync(path.join(adoptedFolderSource, 'original.jpg'), 'original');
    const adoptedLink = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, path.basename(path.dirname(fileLinkProjectPath)), fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [adoptedFolderSource], adoptAsOriginal: true, mediaKind: 'image',
      },
    );
    assert.strictEqual(adoptedLink.success, true, adoptedLink.error);
    assert.deepStrictEqual(importUndoOperations.at(-1).externalAdoptionUndo.progressIds, ['adopted-adopted-external-original']);
    const undoneAdoptedLink = await importProjectHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(undoneAdoptedLink.success, true, undoneAdoptedLink.error);
    assert.deepStrictEqual(revertedExternalAdoptions.at(-1), { projectName: fileLinkProjectName, progressIds: ['adopted-adopted-external-original'] });
    assert.strictEqual(fs.existsSync(path.join(fileLinkProjectPath, 'adopted-external-original.lnk')), false);

    const copiedFolderSource = path.join(root, 'copied-folder-source');
    fs.mkdirSync(path.join(copiedFolderSource, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(copiedFolderSource, 'nested', 'inside.txt'), 'folder-copy');
    const copiedFolder = await importProjectHandlers.get('workspace-import-files')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      importWorkspaceRoot, '策划中', fileLinkProjectName, '', { deleteSourceAfterImport: false, sourcePaths: [copiedFolderSource] },
    );
    assert.strictEqual(copiedFolder.success, true, copiedFolder.error);
    assert.strictEqual(fs.readFileSync(path.join(copiedFolderSource, 'nested', 'inside.txt'), 'utf8'), 'folder-copy', 'copying an imported folder must preserve its source');
    assert.strictEqual(fs.readFileSync(path.join(fileLinkProjectPath, 'copied-folder-source', 'nested', 'inside.txt'), 'utf8'), 'folder-copy', 'normal file import must preserve a dropped folder tree');

    const progressLinkSource = path.join(root, 'progress-link-source');
    fs.mkdirSync(progressLinkSource, { recursive: true });
    fs.writeFileSync(path.join(progressLinkSource, 'progress.jpg'), 'progress');
    const linkedProgress = await importProjectHandlers.get('workspace-import-progress-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'linked-progress', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [progressLinkSource], mediaKind: 'image', versionKey: '1', trackingEnabled: true, trackingState: 'pending_compare',
      },
    );
    assert.strictEqual(linkedProgress.success, true, linkedProgress.error);
    assert.strictEqual(fs.readFileSync(path.join(progressLinkSource, 'progress.jpg'), 'utf8'), 'progress');
    assert.strictEqual(fs.existsSync(path.join(fileLinkProjectPath, 'linked-progress.lnk')), true);
    assert.strictEqual(progressRegistrationPath, progressLinkSource, 'linked progress must register the external target without copying it');
    const undoneLinkedProgress = await importProjectHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(undoneLinkedProgress.success, true, undoneLinkedProgress.error);
    assert.deepStrictEqual(unregisteredExternalProgress.at(-1), { projectName: fileLinkProjectName, progressId: 'progress-id', allowMissing: true });
    assert.strictEqual(fs.existsSync(path.join(fileLinkProjectPath, 'linked-progress.lnk')), false);

    const brollHandlers = new Map();
    const brollProjectName = 'broll-link-project';
    const brollProjectPath = path.join(importWorkspaceRoot, '策划中', brollProjectName);
    const brollSource = path.join(root, 'linked-broll.mov');
    fs.mkdirSync(brollProjectPath, { recursive: true });
    fs.writeFileSync(brollSource, 'broll');
    registerBrollImportIpc({
      ipcMain: { handle: (name, handler) => brollHandlers.set(name, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell: importShell,
      projectVirtualPaths: importProjectVirtualPaths,
      recycleBinService: {}, getMainWindow: () => null,
      getProjectPath: () => brollProjectPath, getRunConfig: () => { throw new Error('link import must not start media workers'); },
      writeLog: () => undefined, pushUndoOperation: async () => undefined, activeOperations: new Map(), backgroundTasks: null, getTelemetry: () => null,
    });
    const linkedBroll = await brollHandlers.get('workspace-import-broll')(
      null, importWorkspaceRoot, '策划中', brollProjectName, { linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [brollSource] },
    );
    assert.strictEqual(linkedBroll.success, true, linkedBroll.error);
    assert.strictEqual(linkedBroll.linked, true);
    assert.strictEqual(fs.readFileSync(brollSource, 'utf8'), 'broll');
    assert.strictEqual(fs.existsSync(path.join(brollProjectPath, '花絮', 'linked-broll.mov.lnk')), true);

    const brollFolderSource = path.join(root, 'broll-folder-source');
    fs.mkdirSync(path.join(brollFolderSource, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(brollFolderSource, 'nested', 'folder-broll.jpg'), 'folder-broll');
    fs.writeFileSync(path.join(brollFolderSource, 'nested', 'ignore.txt'), 'ignore');
    const importedBrollFolder = await brollHandlers.get('workspace-import-broll')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      importWorkspaceRoot, '策划中', brollProjectName, { deleteSourceAfterImport: false, sourcePaths: [brollFolderSource] },
    );
    assert.strictEqual(importedBrollFolder.success, true, importedBrollFolder.error);
    assert.strictEqual(fs.readFileSync(path.join(brollProjectPath, '花絮', 'folder-broll.jpg'), 'utf8'), 'folder-broll', 'b-roll import must recursively accept a dropped folder');
    assert.strictEqual(fs.existsSync(path.join(brollProjectPath, '花絮', 'ignore.txt')), false, 'b-roll folder import must ignore unsupported files');

    const materializeProjectName = 'materialize-project';
    const materializeProjectPath = path.join(importWorkspaceRoot, '策划中', materializeProjectName);
    const materializeSource = path.join(root, 'materialize-source');
    fs.mkdirSync(materializeProjectPath, { recursive: true });
    fs.mkdirSync(materializeSource, { recursive: true });
    fs.writeFileSync(path.join(materializeSource, 'tracked.jpg'), 'tracked');
    const materializeShortcut = path.join(materializeProjectPath, 'external-folder.lnk');
    importProjectVirtualPaths.createManagedExternalLink(materializeShortcut, { target: materializeSource, kind: 'folder', displayName: 'external-folder' });
    materializedProgressFolders = [{ id: 'external-progress', mediaKind: 'image', versionKey: '1', displayName: 'external-progress', folderPath: materializeSource, externalLinkRelativePath: 'external-folder.lnk', trackingEnabled: true, trackingState: 'pending_compare', nodeRole: 'progress', relationKind: 'main', renameFromParent: false, copyMissingFromParent: false }];
    const materialized = await importProjectHandlers.get('workspace-materialize-external-links')(
      null, importWorkspaceRoot, '策划中', materializeProjectName, ['external-folder.lnk'],
    );
    assert.strictEqual(materialized.success, true, materialized.error);
    const materializedDestination = path.join(materializeProjectPath, 'external-folder');
    assert.strictEqual(fs.existsSync(materializeSource), false);
    assert.strictEqual(fs.readFileSync(path.join(materializedDestination, 'tracked.jpg'), 'utf8'), 'tracked');
    assert.strictEqual(fs.existsSync(materializeShortcut), false);
    assert.strictEqual(progressRegistrationPath, materializedDestination, 'materializing a tracked external folder must relocate its database path');

    const rollbackSource = path.join(root, 'materialize-rollback-source');
    fs.mkdirSync(rollbackSource, { recursive: true });
    fs.writeFileSync(path.join(rollbackSource, 'rollback.jpg'), 'rollback');
    const rollbackShortcut = path.join(materializeProjectPath, 'rollback-folder.lnk');
    importProjectVirtualPaths.createManagedExternalLink(rollbackShortcut, { target: rollbackSource, kind: 'folder', displayName: 'rollback-folder' });
    materializedProgressFolders = [{ ...materializedProgressFolders[0], id: 'rollback-progress', folderPath: rollbackSource, externalLinkRelativePath: 'rollback-folder.lnk' }];
    failProgressRelocation = true;
    const rolledBackMaterialization = await importProjectHandlers.get('workspace-materialize-external-links')(
      null, importWorkspaceRoot, '策划中', materializeProjectName, ['rollback-folder.lnk'],
    );
    failProgressRelocation = false;
    assert.strictEqual(rolledBackMaterialization.success, false, 'database relocation failure must fail the materialization');
    assert.strictEqual(fs.readFileSync(path.join(rollbackSource, 'rollback.jpg'), 'utf8'), 'rollback');
    assert.strictEqual(fs.existsSync(rollbackShortcut), true, 'failed materialization must restore the shortcut');

    const lockedShortcutSource = path.join(root, 'materialize-locked-shortcut-source');
    fs.mkdirSync(lockedShortcutSource, { recursive: true });
    fs.writeFileSync(path.join(lockedShortcutSource, 'locked.jpg'), 'locked');
    const lockedShortcut = path.join(materializeProjectPath, 'locked-folder.lnk');
    importProjectVirtualPaths.createManagedExternalLink(lockedShortcut, { target: lockedShortcutSource, kind: 'folder', displayName: 'locked-folder' });
    materializedProgressFolders = [];
    failShortcutRemoval = true;
    const lockedShortcutMaterialization = await importProjectHandlers.get('workspace-materialize-external-links')(
      null, importWorkspaceRoot, '策划中', materializeProjectName, ['locked-folder.lnk'],
    );
    failShortcutRemoval = false;
    assert.strictEqual(lockedShortcutMaterialization.success, false, 'shortcut removal failure must fail the materialization');
    assert.strictEqual(fs.readFileSync(path.join(lockedShortcutSource, 'locked.jpg'), 'utf8'), 'locked', 'a post-move shortcut failure must move the folder back');
    assert.strictEqual(fs.existsSync(lockedShortcut), true, 'a post-move shortcut failure must retain the original shortcut');

    const failoverHandlers = new Map();
    const fullWorkspace = path.join(root, 'full-workspace');
    const healthyWorkspace = path.join(root, 'healthy-workspace');
    fs.mkdirSync(fullWorkspace, { recursive: true });
    fs.mkdirSync(healthyWorkspace, { recursive: true });
    fs.mkdirSync(path.join(fullWorkspace, '策划中'), { recursive: true });
    fs.mkdirSync(path.join(healthyWorkspace, '策划中'), { recursive: true });
    let healthyWorkspaceFull = false;
    const failoverFs = {
      ...fs,
      promises: {
        ...fs.promises,
        statfs: async directory => path.resolve(directory) === path.resolve(fullWorkspace) || healthyWorkspaceFull
          ? { bavail: 1, bsize: 4096 }
          : { bavail: 1024 * 1024, bsize: 4096 },
      },
    };
    const failoverCatalogs = new Map([
      [fullWorkspace, { byName: new Map(), projects: [] }],
      [healthyWorkspace, { byName: new Map(), projects: [] }],
    ]);
    let createdWorkspaceRoot = '';
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => failoverHandlers.set(name, handler) }, fs: failoverFs, path,
      CANCELLED_CODE, WORKSPACE_STATUSES: ['策划中'], HIDDEN_SYSTEM_ENTRY_NAMES: new Set(),
      IMAGE_EXTENSIONS: new Set(['.jpg']), RAW_EXTENSIONS: new Set(['.cr3']), VIDEO_EXTENSIONS: new Set(['.mov']),
      cleanProjectName: value => String(value).trim(),
      ensureWorkspace: candidate => path.resolve(candidate),
      getProjectPath: (workspaceRoot, status, name) => path.join(workspaceRoot, status, name),
      getWorkspaceDataRoot: workspaceRoot => path.join(workspaceRoot, '.data'),
      workspaceCatalogs: failoverCatalogs,
      refreshWorkspaceCatalog: async workspaceRoot => failoverCatalogs.get(workspaceRoot),
      mutateWorkspaceCatalog: async (workspaceRoot, _operation, entry) => {
        createdWorkspaceRoot = workspaceRoot;
        return { byName: new Map([[entry.name.toLocaleLowerCase(), { id: 'failover-project-id', name: entry.name }]]), projects: [] };
      },
      pushUndoOperation: async () => undefined, writeLog: () => undefined, telemetryService: { track: () => undefined },
    });
    const failoverProject = await failoverHandlers.get('workspace-create-project')(
      null, fullWorkspace, null, 'failover-project', { workspacePaths: [fullWorkspace, healthyWorkspace], createPlanningFolder: false },
    );
    assert.strictEqual(failoverProject.success, true, failoverProject.error);
    assert.strictEqual(failoverProject.storageSwitched, true);
    assert.strictEqual(createdWorkspaceRoot, healthyWorkspace);
    assert.strictEqual(failoverProject.project.workspacePath, healthyWorkspace);
    const fullOnlyProject = await failoverHandlers.get('workspace-create-project')(
      null, fullWorkspace, null, 'full-only-project', { workspacePaths: [fullWorkspace], createPlanningFolder: false },
    );
    assert.strictEqual(fullOnlyProject.success, false, 'a full single workspace must reject project creation');
    assert.match(fullOnlyProject.error, /添加新的项目工作目录/);
    healthyWorkspaceFull = true;
    const allFullProject = await failoverHandlers.get('workspace-create-project')(
      null, fullWorkspace, null, 'all-full-project', { workspacePaths: [fullWorkspace, healthyWorkspace], createPlanningFolder: false },
    );
    assert.strictEqual(allFullProject.success, false, 'project creation must stop when every configured workspace is full');
    assert.match(allFullProject.error, /设置 → 存储/);

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
