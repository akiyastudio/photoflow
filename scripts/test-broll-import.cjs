const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const { registerBrollImportIpc, _test } = require('../electron/modules/broll-import.cjs');
const { configureNativePublicationService } = require('../electron/services/file-transfer-service.cjs');
const { createFilePublicationService } = require('../electron/services/file-publication-service.cjs');
const { samePathIdentity } = require('../electron/services/file-identity-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-broll-test-'));
configureNativePublicationService(createFilePublicationService({ app: { isPackaged: false }, projectRoot: path.resolve(__dirname, '..') }));
const runConfig = (_script, args) => ({ command: 'fixture-worker', args });
const pathEntryExistsForTest = candidate => { try { fs.lstatSync(candidate); return true; } catch { return false; } };
const workerInput = definition => definition.args[0];
const workerOutputDirectory = definition => {
  const index = definition.args.indexOf('--output-dir');
  return index >= 0 ? definition.args[index + 1] : path.dirname(workerInput(definition));
};

const workerSupervisor = onLaunch => ({
  launch(definition) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = signal => {
      if (child.exitCode != null || child.signalCode != null) return false;
      if (signal) child.signalCode = signal;
      else child.exitCode = 143;
      queueMicrotask(() => { child.emit('exit', child.exitCode, child.signalCode); child.emit('close', child.exitCode, child.signalCode); });
      return true;
    };
    const close = code => {
      if (child.exitCode != null || child.signalCode != null) return;
      child.exitCode = code;
      child.emit('exit', code);
      child.emit('close', code);
    };
    queueMicrotask(() => onLaunch({ definition, child, close }));
    return { child };
  },
});

const main = async () => {
  const scanRoot = path.join(root, 'scan');
  fs.mkdirSync(scanRoot);
  for (let index = 0; index < 501; index += 1) fs.writeFileSync(path.join(scanRoot, `${String(index).padStart(3, '0')}.jpg`), 'x');
  await assert.rejects(_test.expandBrollSourcePaths([scanRoot]), /500/, 'directory scanning must stop as soon as the 501st supported file is found');

  const identityRoot = path.join(root, 'identity');
  fs.mkdirSync(identityRoot);
  const identitySource = path.join(identityRoot, 'one.jpg');
  const identityAlias = path.join(identityRoot, 'two.jpg');
  fs.writeFileSync(identitySource, 'same inode');
  try {
    fs.linkSync(identitySource, identityAlias);
    assert.strictEqual((await _test.expandBrollSourcePaths([identitySource, identityAlias])).length, 1, 'source discovery must deduplicate platform file identities');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }
  let cancelled = true;
  await assert.rejects(_test.expandBrollSourcePaths([identityRoot], { isCancelled: () => cancelled }), error => error.code === 'EOPCANCELLED');

  const deepRoot = path.join(root, 'deep-scan');
  let deepCursor = deepRoot;
  fs.mkdirSync(deepCursor);
  for (let depth = 0; depth < 64; depth += 1) {
    deepCursor = path.join(deepCursor, `d${depth}`);
    fs.mkdirSync(deepCursor);
  }
  fs.writeFileSync(path.join(deepCursor, 'deep.jpg'), 'deep');
  const originalOpendir = fs.promises.opendir;
  let liveDirectories = 0;
  let peakDirectories = 0;
  fs.promises.opendir = async (...args) => {
    const directory = await originalOpendir.call(fs.promises, ...args);
    liveDirectories += 1;
    peakDirectories = Math.max(peakDirectories, liveDirectories);
    let closed = false;
    return {
      read: directory.read.bind(directory),
      close: async () => {
        if (!closed) { closed = true; liveDirectories -= 1; }
        return directory.close();
      },
    };
  };
  let deepFiles;
  try { deepFiles = await _test.expandBrollSourcePaths([deepRoot]); }
  finally { fs.promises.opendir = originalOpendir; }
  assert.strictEqual(deepFiles.length, 1);
  assert.strictEqual(peakDirectories, 1, 'explicit directory work stack must close each parent before opening a child');
  assert.strictEqual(liveDirectories, 0);

  const zeroInodeBase = {
    dev: 0n, ino: 0n, size: 10n, mtimeNs: 100n, birthtimeNs: 50n, ctimeNs: 100n, mode: 0o100644n,
    isDirectory: () => false, isSymbolicLink: () => false,
  };
  assert.notStrictEqual(
    _test.identityKey(zeroInodeBase, path.join(root, 'zero-inode.jpg')),
    _test.identityKey({ ...zeroInodeBase, size: 11n, mtimeNs: 101n, ctimeNs: 101n }, path.join(root, 'zero-inode.jpg')),
    'ino=0 identity fallback must detect same-path replacement metadata',
  );

  const mb = 1024 * 1024;
  const diskSource = (size, extension = '.mov', dev = 1) => ({ extension, stat: { size, dev } });
  const smallCopyEstimate = _test.estimateBrollDiskRequirements({ sources: [diskSource(mb, '.jpg')], preserveOriginal: true, destinationDev: 1 });
  assert.strictEqual(smallCopyEstimate.copyBytes, mb);
  assert(smallCopyEstimate.requiredBytes < 70 * mb, 'a normal small copy must pay one bounded safety allowance, not one allowance per phase');
  assert.strictEqual(_test.estimateBrollDiskRequirements({ sources: [diskSource(mb, '.jpg', 1)], preserveOriginal: false, destinationDev: 1 }).moveBytes, 0, 'same-volume move needs no copy-space reservation');
  assert.strictEqual(_test.estimateBrollDiskRequirements({ sources: [diskSource(mb, '.jpg', 2)], preserveOriginal: false, destinationDev: 1 }).moveBytes, mb, 'cross-volume move reserves its copy bytes');
  const splitEstimate = _test.estimateBrollDiskRequirements({ sources: [diskSource(5 * 1024 ** 3)], preserveOriginal: true, splitLargeFiles: true, destinationDev: 1 });
  assert.strictEqual(splitEstimate.copyBytes, 0);
  assert.strictEqual(splitEstimate.splitBytes, 5 * 1024 ** 3);
  const bitrateEstimate = _test.estimateBrollDiskRequirements({ sources: [diskSource(10 * mb)], preserveOriginal: true, transcodeVideos: true, transcodeSettings: { videoBitrateMbps: 40 }, destinationDev: 1 });
  assert.strictEqual(bitrateEstimate.transcodeBytes, 25 * mb, 'host admission stays moderate while the worker performs exact bitrate/duration preflight');

  const mediaRoot = path.join(root, 'media');
  fs.mkdirSync(mediaRoot);
  const source = path.join(mediaRoot, 'clip.mov');
  fs.writeFileSync(source, 'source video');

  const familyRoot = path.join(root, 'split-family');
  fs.mkdirSync(familyRoot);
  fs.writeFileSync(path.join(familyRoot, 'clip_part000.mov'), 'existing part zero');
  fs.writeFileSync(path.join(familyRoot, 'take_part002.mov'), 'existing later part');
  assert.strictEqual(await _test.splitFamilyExists(familyRoot, 'clip', '.mov'), true, 'part000 must reserve the whole split stem family');
  assert.strictEqual(await _test.splitFamilyExists(familyRoot, 'take', '.mov'), true, 'any later family member such as part002 must reserve the split stem');
  const clipSplitTarget = await _test.uniqueSplitDestination(familyRoot, 'clip.mov', new Set());
  const takeSplitTarget = await _test.uniqueSplitDestination(familyRoot, 'take.mov', new Set());
  assert.notStrictEqual(path.parse(clipSplitTarget).name, 'clip');
  assert.notStrictEqual(path.parse(takeSplitTarget).name, 'take');

  const brokenTarget = path.join(root, 'missing-junction-target');
  const brokenOutput = path.join(mediaRoot, 'clip_转码_broken.mp4');
  let brokenLinkCreated = false;
  try {
    fs.symlinkSync(brokenTarget, brokenOutput, process.platform === 'win32' ? 'junction' : 'dir');
    brokenLinkCreated = true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }
  if (brokenLinkCreated) {
    const brokenBaseline = await _test.snapshotDirectory(mediaRoot);
    assert([...brokenBaseline.keys()].some(candidate => candidate.toLowerCase() === path.resolve(brokenOutput).toLowerCase()), 'snapshotDirectory must record a broken junction/symlink name even when realpath fails');
    await assert.rejects(_test.runTranscoder({
      getRunConfig: runConfig, source, outputDirectory: mediaRoot, settings: {}, isCancelled: () => false, onProgress() {},
      processSupervisor: workerSupervisor(({ child, close }) => {
        child.stdout.write(`${JSON.stringify({ type: 'error', message: 'injected worker failure' })}\n`);
        close(1);
      }),
    }), /injected worker failure/);
    assert.strictEqual(fs.lstatSync(brokenOutput).isSymbolicLink(), true, 'a pre-existing broken junction/symlink name must remain in the snapshot baseline and survive worker cleanup');
  }

  const existing = path.join(mediaRoot, 'clip_转码.mp4');
  fs.writeFileSync(existing, 'preexisting');
  await assert.rejects(_test.runTranscoder({
    getRunConfig: runConfig, source, outputDirectory: mediaRoot, settings: {}, isCancelled: () => false, onProgress() {},
    processSupervisor: workerSupervisor(({ child, close }) => {
      child.stdout.write(`${JSON.stringify({ type: 'success', outputs: [existing] })}\n`);
      close(0);
    }),
  }), /越出目标目录/);
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'preexisting', 'validation failure must never delete a preexisting output');

  const stagedPublished = await _test.runTranscoder({
    getRunConfig: runConfig, source, outputDirectory: mediaRoot, settings: {}, isCancelled: () => false, onProgress() {},
    processSupervisor: workerSupervisor(({ definition, child, close }) => {
      const stagedOutput = path.join(workerOutputDirectory(definition), 'clip_转码.mp4');
      fs.writeFileSync(stagedOutput, 'private staging output');
      child.stdout.write(`${JSON.stringify({ type: 'success', outputs: [stagedOutput] })}\n`);
      close(0);
    }),
  });
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'preexisting', 'no-clobber staging publication must preserve a concurrent/preexisting final name');
  assert.notStrictEqual(path.resolve(stagedPublished.path), path.resolve(existing));
  assert.strictEqual(fs.readFileSync(stagedPublished.path, 'utf8'), 'private staging output');
  await _test.removeOwnedFile(stagedPublished);

  const empty = path.join(mediaRoot, 'clip_转码_2.mp4');
  await assert.rejects(_test.runTranscoder({
    getRunConfig: runConfig, source, outputDirectory: mediaRoot, settings: {}, isCancelled: () => false, onProgress() {},
    processSupervisor: workerSupervisor(({ definition, child, close }) => {
      const stagedEmpty = path.join(workerOutputDirectory(definition), path.basename(empty));
      fs.writeFileSync(stagedEmpty, '');
      child.stdout.write(`${JSON.stringify({ type: 'success', outputs: [stagedEmpty] })}\n`);
      close(0);
    }),
  }), /空文件/);
  assert.strictEqual(fs.existsSync(empty), false, 'an invalid empty output owned by this run must be removed');

  const reportedOrphan = path.join(mediaRoot, 'worker-chosen-name.mp4');
  await assert.rejects(_test.runTranscoder({
    getRunConfig: runConfig, source, outputDirectory: mediaRoot, settings: {}, isCancelled: () => false, onProgress() {},
    processSupervisor: workerSupervisor(({ definition, child, close }) => {
      const stagedOrphan = path.join(workerOutputDirectory(definition), path.basename(reportedOrphan));
      fs.writeFileSync(stagedOrphan, 'partial output');
      child.stdout.write(`${JSON.stringify({ type: 'error', message: 'injected transcode fault', outputs: [stagedOrphan] })}\n`);
      close(1);
    }),
  }), /injected transcode fault/);
  assert.strictEqual(fs.existsSync(reportedOrphan), false, 'every worker-reported orphan owned by the failed attempt must be removed');

  const directoryOutput = path.join(mediaRoot, 'clip_转码_3.mp4');
  await assert.rejects(_test.runTranscoder({
    getRunConfig: runConfig, source, outputDirectory: mediaRoot, settings: {}, isCancelled: () => false, onProgress() {},
    processSupervisor: workerSupervisor(({ definition, child, close }) => {
      const stagedDirectory = path.join(workerOutputDirectory(definition), path.basename(directoryOutput));
      fs.mkdirSync(stagedDirectory);
      child.stdout.write(`${JSON.stringify({ type: 'success', outputs: [stagedDirectory] })}\n`);
      close(0);
    }),
  }), /普通文件/);
  assert.strictEqual(fs.existsSync(directoryOutput), false, 'a directory masquerading as worker output must be rejected and cleaned');

  const outside = path.join(root, 'outside.mp4');
  await assert.rejects(_test.runTranscoder({
    getRunConfig: runConfig, source, outputDirectory: mediaRoot, settings: {}, isCancelled: () => false, onProgress() {},
    processSupervisor: workerSupervisor(({ child, close }) => {
      fs.writeFileSync(outside, 'outside');
      child.stdout.write(`${JSON.stringify({ type: 'success', outputs: [outside] })}\n`);
      close(0);
    }),
  }), /越出目标目录/);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside', 'rollback must not delete a path outside the target ownership root');

  const partial = path.join(mediaRoot, 'split_part001.mov');
  await assert.rejects(_test.runSplitter({
    getRunConfig: runConfig, source, outputDirectory: mediaRoot, outputStem: 'split', extension: '.mov', isCancelled: () => false, onProgress() {},
    processSupervisor: workerSupervisor(({ definition, child, close }) => {
      const stagedPartial = path.join(workerOutputDirectory(definition), path.basename(partial));
      fs.writeFileSync(stagedPartial, 'only one part');
      child.stdout.write(`${JSON.stringify({ type: 'success' })}\n`);
      close(0);
    }),
  }), /未生成完整分段/);
  assert.strictEqual(fs.existsSync(partial), false, 'an incomplete split must remove every output owned by this attempt');

  const concurrentSplit = path.join(mediaRoot, 'race_part000.mov');
  await assert.rejects(_test.runSplitter({
    getRunConfig: runConfig, source, outputDirectory: mediaRoot, outputStem: 'race', extension: '.mov', isCancelled: () => false, onProgress() {},
    processSupervisor: workerSupervisor(({ definition, child, close }) => {
      const staging = workerOutputDirectory(definition);
      fs.writeFileSync(path.join(staging, 'race_part000.mov'), 'staged zero');
      fs.writeFileSync(path.join(staging, 'race_part001.mov'), 'staged one');
      fs.writeFileSync(concurrentSplit, 'concurrent winner');
      child.stdout.write(`${JSON.stringify({ type: 'success' })}\n`);
      close(0);
    }),
  }), error => error?.code === 'EEXIST' || /目标已存在/.test(error?.message || ''));
  assert.strictEqual(fs.readFileSync(concurrentSplit, 'utf8'), 'concurrent winner', 'a concurrent final-family winner must never be claimed or removed');
  assert.strictEqual(fs.existsSync(path.join(mediaRoot, 'race_part001.mov')), false, 'split publication conflict must roll back only outputs already published by this attempt');
  assert.strictEqual(fs.readdirSync(mediaRoot).some(name => name.startsWith('.photoflow-broll-split-')), false, 'private split staging must be removed after a publication race');

  let terminationObserved = false;
  await assert.rejects(_test.runJsonLineWorker({
    getRunConfig: runConfig, processSupervisor: workerSupervisor(({ child }) => {
      const originalKill = child.kill;
      child.kill = signal => { terminationObserved = true; return originalKill(signal); };
      child.stdout.write('x'.repeat(65));
    }),
    prefix: 'limit', script: 'fixture.py', args: [], label: 'fixture', isCancelled: () => false, stdoutLimit: 64,
  }), error => error.code === 'BROLL_WORKER_STDOUT_LIMIT');
  assert.strictEqual(terminationObserved, true, 'stdout overflow must terminate and wait for the worker');

  let managedStopCalls = 0;
  const managedChild = new EventEmitter();
  managedChild.pid = 0; managedChild.exitCode = null; managedChild.signalCode = null;
  await _test.terminateWorkerTree({
    child: managedChild,
    managed: { stop: async () => { managedStopCalls += 1; managedChild.exitCode = 0; } },
  }, Date.now() + 1000);
  assert.strictEqual(managedStopCalls, 1, 'forced worker shutdown must prefer the process supervisor lifecycle before the raw parent fallback');

  const descendantParent = spawn(process.execPath, ['-e', "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"], {
    windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const descendantPid = await new Promise((resolve, reject) => {
    let value = '';
    const timer = setTimeout(() => reject(new Error('descendant fixture startup timed out')), 5000);
    descendantParent.stdout.on('data', chunk => {
      value += chunk.toString();
      const match = value.match(/\d+/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[0]));
    });
    descendantParent.once('error', reject);
  });
  try {
    await _test.terminateWorkerTree({ child: descendantParent, managed: null }, Date.now() + 5000);
    let descendantAlive = true;
    for (let attempt = 0; attempt < 20 && descendantAlive; attempt += 1) {
      try { process.kill(descendantPid, 0); await new Promise(resolve => setTimeout(resolve, 25)); }
      catch { descendantAlive = false; }
    }
    assert.strictEqual(descendantAlive, false, 'forced worker shutdown must terminate an unresponsive descendant process tree');
  } finally {
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already terminated */ }
    try { descendantParent.kill('SIGKILL'); } catch { /* already terminated */ }
  }

  let cancelPath = '';
  cancelled = false;
  const cancelPromise = _test.runJsonLineWorker({
    getRunConfig: runConfig, processSupervisor: workerSupervisor(({ definition, child, close }) => {
      cancelPath = definition.args.at(-1);
      const watcher = setInterval(() => {
        if (!fs.existsSync(cancelPath)) return;
        clearInterval(watcher);
        child.stdout.write(`${JSON.stringify({ type: 'cancelled' })}\n`);
        close(0);
      }, 5);
    }),
    prefix: 'cancel', script: 'fixture.py', args: [], label: 'fixture', isCancelled: () => cancelled, cancelGraceMs: 100,
  });
  cancelled = true;
  await assert.rejects(cancelPromise, error => error.code === 'EOPCANCELLED');
  assert(cancelPath && !fs.existsSync(cancelPath), 'cooperative cancellation must remove its cancellation file after worker exit');

  const transactionRoot = path.join(root, 'transaction-project');
  const transactionSource = path.join(root, 'transaction.jpg');
  fs.mkdirSync(transactionRoot);
  fs.writeFileSync(transactionSource, 'transaction source');
  const handlers = new Map();
  let trashed = false;
  const controller = new AbortController();
  registerBrollImportIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, shell: {}, projectVirtualPaths: {},
    recycleBinService: { trash: async value => { trashed = true; fs.rmSync(value); } }, getMainWindow: () => null,
    getProjectPath: () => transactionRoot, getRunConfig: runConfig, processSupervisor: null,
    writeLog: () => undefined, pushUndoOperation: async () => undefined, activeOperations: new Map(), getTelemetry: () => null,
    backgroundTasks: { create: () => ({
      context: {
        signal: controller.signal, report: progress => { if (progress === 100) throw new Error('completion notification fault'); },
        acquireResourceLease: async () => ({ release() {} }), waitIfPaused: async () => undefined,
        withResources: (_definition, worker) => worker(), setPausable() {}, setCancellable() {}, saveCheckpoint() {},
      },
      waitForStart: async () => undefined, complete() {}, fail() {}, cancelled() {}, isFinished: () => false,
    }) },
  });
  const committed = await handlers.get('workspace-import-broll')(
    { sender: { isDestroyed: () => false, send() {} } }, root, 'status', 'project',
    { sourcePaths: [transactionSource], deleteSourceAfterImport: true },
  );
  assert.strictEqual(committed.success, true, committed.error);
  assert.strictEqual(trashed, false, 'ordinary delete-source imports retain atomic move/undo behavior instead of using the recycle bin');
  assert.strictEqual(fs.existsSync(transactionSource), false);
  assert.strictEqual(fs.readFileSync(path.join(transactionRoot, '花絮', 'transaction.jpg'), 'utf8'), 'transaction source', 'a completion notification failure after commit must retain the imported target');

  const rollbackRoot = path.join(root, 'rollback-project');
  const rollbackSource = path.join(root, 'rollback.jpg');
  fs.mkdirSync(rollbackRoot);
  fs.writeFileSync(rollbackSource, 'source survives');
  const rollbackHandlers = new Map();
  registerBrollImportIpc({
    ipcMain: { handle: (name, handler) => rollbackHandlers.set(name, handler) }, dialog: {}, shell: {}, projectVirtualPaths: {},
    recycleBinService: { trash: async () => { throw new Error('must not trash before commit'); } }, getMainWindow: () => null,
    getProjectPath: () => rollbackRoot, getRunConfig: runConfig, processSupervisor: null, backgroundTasks: null,
    writeLog: () => undefined, activeOperations: new Map(), getTelemetry: () => null,
    pushUndoOperation: async () => { throw new Error('undo persistence fault'); },
  });
  const rolledBack = await rollbackHandlers.get('workspace-import-broll')(
    { sender: { isDestroyed: () => false, send() {} } }, root, 'status', 'project',
    { sourcePaths: [rollbackSource], deleteSourceAfterImport: true },
  );
  assert.strictEqual(rolledBack.success, false);
  assert.strictEqual(fs.readFileSync(rollbackSource, 'utf8'), 'source survives', 'undo persistence failure must restore an atomically moved source');
  assert.strictEqual(fs.existsSync(path.join(rollbackRoot, '花絮', 'rollback.jpg')), false);

  const moveClaimRoot = path.join(root, 'move-claim-project');
  const moveClaimSource = path.join(root, 'move-claim.jpg');
  const moveClaimTarget = path.join(moveClaimRoot, '花絮', 'move-claim.jpg');
  fs.mkdirSync(moveClaimRoot);
  fs.writeFileSync(moveClaimSource, 'move claim source');
  const moveClaimHandlers = new Map();
  registerBrollImportIpc({
    ipcMain: { handle: (name, handler) => moveClaimHandlers.set(name, handler) }, dialog: {}, shell: {}, projectVirtualPaths: {},
    recycleBinService: {}, getMainWindow: () => null, getProjectPath: () => moveClaimRoot, getRunConfig: runConfig,
    processSupervisor: null, backgroundTasks: null, writeLog: () => undefined, activeOperations: new Map(), getTelemetry: () => null,
    pushUndoOperation: async () => { throw new Error('undo must not be reached after claim fault'); },
  });
  const originalLstat = fs.promises.lstat;
  let claimFaultInjected = false;
  fs.promises.lstat = async (candidate, ...args) => {
    if (!claimFaultInjected && path.resolve(candidate) === path.resolve(moveClaimTarget) && !fs.existsSync(moveClaimSource)) {
      claimFaultInjected = true;
      throw new Error('injected post-move claim fault');
    }
    return originalLstat.call(fs.promises, candidate, ...args);
  };
  let moveClaimFailure;
  try {
    moveClaimFailure = await moveClaimHandlers.get('workspace-import-broll')(
      { sender: { isDestroyed: () => false, send() {} } }, root, 'status', 'project',
      { sourcePaths: [moveClaimSource], deleteSourceAfterImport: true },
    );
  } finally { fs.promises.lstat = originalLstat; }
  assert.strictEqual(moveClaimFailure.success, false);
  assert.strictEqual(claimFaultInjected, true);
  assert.strictEqual(fs.existsSync(moveClaimSource), true, JSON.stringify(moveClaimFailure));
  assert.strictEqual(fs.readFileSync(moveClaimSource, 'utf8'), 'move claim source', 'a post-move claim failure must use the pending move identity to restore the source');
  assert.strictEqual(fs.existsSync(moveClaimTarget), false);

  const checkpointRoot = path.join(root, 'move-checkpoint-project');
  const checkpointSource = path.join(root, 'move-checkpoint.jpg');
  fs.mkdirSync(checkpointRoot);
  fs.writeFileSync(checkpointSource, 'checkpoint source');
  const checkpointHandlers = new Map();
  const checkpointController = new AbortController();
  registerBrollImportIpc({
    ipcMain: { handle: (name, handler) => checkpointHandlers.set(name, handler) }, dialog: {}, shell: {}, projectVirtualPaths: {},
    recycleBinService: {}, getMainWindow: () => null, getProjectPath: () => checkpointRoot, getRunConfig: runConfig,
    processSupervisor: null, writeLog: () => undefined, activeOperations: new Map(), getTelemetry: () => null,
    pushUndoOperation: async () => undefined,
    backgroundTasks: { create: () => ({
      context: {
        signal: checkpointController.signal, report() {}, acquireResourceLease: async () => ({ release() {} }), waitIfPaused: async () => undefined,
        withResources: (_definition, worker) => worker(), setPausable() {}, setCancellable() {},
        saveCheckpoint: checkpoint => { if (checkpoint.moves?.[0]?.state === 'moved') throw new Error('injected moved checkpoint fault'); },
      },
      waitForStart: async () => undefined, complete() {}, fail() {}, cancelled() {}, isFinished: () => false,
    }) },
  });
  const checkpointFailure = await checkpointHandlers.get('workspace-import-broll')(
    { sender: { isDestroyed: () => false, send() {} } }, root, 'status', 'project',
    { sourcePaths: [checkpointSource], deleteSourceAfterImport: true },
  );
  assert.strictEqual(checkpointFailure.success, false);
  assert.match(checkpointFailure.error, /checkpoint fault/);
  assert.strictEqual(fs.readFileSync(checkpointSource, 'utf8'), 'checkpoint source', 'a moved-state checkpoint failure must roll back from the persisted pending move identity');

  const linkClaimRoot = path.join(root, 'link-claim-project');
  const linkSourceOne = path.join(root, 'link-one.jpg');
  const linkSourceTwo = path.join(root, 'link-two.jpg');
  fs.mkdirSync(linkClaimRoot);
  fs.writeFileSync(linkSourceOne, 'one');
  fs.writeFileSync(linkSourceTwo, 'two');
  const linkClaimHandlers = new Map();
  let revokedLinkIds = [];
  registerBrollImportIpc({
    ipcMain: { handle: (name, handler) => linkClaimHandlers.set(name, handler) }, dialog: {}, shell: {},
    projectVirtualPaths: {
      createManagedExternalLinksBatch: requests => requests.map((request, index) => {
        fs.writeFileSync(request.shortcutPath, `shortcut-${index}`);
        return { shortcutPath: request.shortcutPath, linkId: `link-${index}` };
      }),
      revokeManagedExternalLinkIds: ids => { revokedLinkIds = [...ids]; },
    },
    recycleBinService: {}, getMainWindow: () => null, getProjectPath: () => linkClaimRoot, getRunConfig: runConfig,
    processSupervisor: null, backgroundTasks: null, writeLog: () => undefined, activeOperations: new Map(), getTelemetry: () => null,
    pushUndoOperation: async () => { throw new Error('undo must not be reached after link claim fault'); },
  });
  const linkTwoShortcut = path.join(linkClaimRoot, '花絮', 'link-two.jpg.lnk');
  const originalRealpath = fs.promises.realpath;
  let linkClaimFaultInjected = false;
  fs.promises.realpath = async candidate => {
    if (!linkClaimFaultInjected && path.resolve(candidate) === path.resolve(linkTwoShortcut)) {
      linkClaimFaultInjected = true;
      throw new Error('injected link claim fault');
    }
    return originalRealpath.call(fs.promises, candidate);
  };
  let linkClaimFailure;
  try {
    linkClaimFailure = await linkClaimHandlers.get('workspace-import-broll')(
      null, root, 'status', 'project', { linkOnly: true, sourcePaths: [linkSourceOne, linkSourceTwo] },
    );
  } finally { fs.promises.realpath = originalRealpath; }
  assert.strictEqual(linkClaimFailure.success, false);
  assert.strictEqual(linkClaimFaultInjected, true);
  assert.deepStrictEqual(revokedLinkIds, ['link-0', 'link-1'], 'all batch link IDs must be registered before the first asynchronous claim');
  assert.strictEqual(pathEntryExistsForTest(path.join(linkClaimRoot, '花絮', 'link-one.jpg.lnk')), false);
  assert.strictEqual(pathEntryExistsForTest(linkTwoShortcut), false, 'a mid-claim failure must clean every shortcut with its synchronously captured batch identity');

  const pushReplaceRoot = path.join(root, 'push-replace-project');
  const pushReplaceSource = path.join(root, 'push-replace.jpg');
  fs.mkdirSync(pushReplaceRoot);
  fs.writeFileSync(pushReplaceSource, 'publication-owned');
  const pushReplaceHandlers = new Map();
  let persistedUndoOperation = null;
  let preInvalidationIdentity = null;
  registerBrollImportIpc({
    ipcMain: { handle: (name, handler) => pushReplaceHandlers.set(name, handler) }, dialog: {}, shell: {}, projectVirtualPaths: {},
    recycleBinService: {}, getMainWindow: () => null, getProjectPath: () => pushReplaceRoot, getRunConfig: runConfig,
    processSupervisor: null, backgroundTasks: null, writeLog: () => undefined, activeOperations: new Map(), getTelemetry: () => null,
    pushUndoOperation: async operation => {
      persistedUndoOperation = { ...operation, paths: [...operation.paths], identities: { ...operation.identities }, metadata: { stored: true } };
      const target = operation.paths[0];
      preInvalidationIdentity = operation.identities[path.resolve(target)];
      fs.rmSync(target);
      fs.writeFileSync(target, 'replacement-during-push');
      return persistedUndoOperation;
    },
  });
  const pushReplaceFailure = await pushReplaceHandlers.get('workspace-import-broll')(
    { sender: { isDestroyed: () => false, send() {} } }, root, 'status', 'project',
    { sourcePaths: [pushReplaceSource], deleteSourceAfterImport: false },
  );
  const pushReplaceTarget = path.join(pushReplaceRoot, '花絮', 'push-replace.jpg');
  assert.strictEqual(pushReplaceFailure.success, false, 'replacement while pushUndoOperation resolves must not cross the success boundary');
  assert.strictEqual(pushReplaceFailure.recoveryRequired, true);
  assert.strictEqual(fs.readFileSync(pushReplaceTarget, 'utf8'), 'replacement-during-push', 'commit-boundary rollback must preserve the replacement');
  assert(persistedUndoOperation.undoToken && preInvalidationIdentity, 'undo persistence must receive the publication identity and a preallocated token');
  assert.strictEqual(await samePathIdentity(pushReplaceTarget, preInvalidationIdentity), false, 'pre-push undo identity must reject the replacement rather than target it');
  assert.strictEqual(persistedUndoOperation.kind, 'remove-created');
  assert.deepStrictEqual(persistedUndoOperation.paths, [], 'post-check failure must invalidate the actual stored history object into a poppable no-op');
  assert.deepStrictEqual(persistedUndoOperation.moves, []);
  assert.deepStrictEqual(persistedUndoOperation.identities, {});
  assert.strictEqual(persistedUndoOperation.metadata.invalidated, true);

  const replacementRoot = path.join(root, 'replacement-project');
  const replacementSource = path.join(root, 'replacement.jpg');
  fs.mkdirSync(replacementRoot);
  fs.writeFileSync(replacementSource, 'owned move target');
  const replacementHandlers = new Map();
  registerBrollImportIpc({
    ipcMain: { handle: (name, handler) => replacementHandlers.set(name, handler) }, dialog: {}, shell: {}, projectVirtualPaths: {},
    recycleBinService: {}, getMainWindow: () => null, getProjectPath: () => replacementRoot, getRunConfig: runConfig,
    processSupervisor: null, backgroundTasks: null, writeLog: () => undefined, activeOperations: new Map(), getTelemetry: () => null,
    pushUndoOperation: async operation => {
      const destination = operation.moves[0].destination;
      fs.rmSync(destination);
      fs.writeFileSync(destination, 'late replacement');
      throw new Error('undo persistence fault after replacement');
    },
  });
  const replacementFailure = await replacementHandlers.get('workspace-import-broll')(
    { sender: { isDestroyed: () => false, send() {} } }, root, 'status', 'project',
    { sourcePaths: [replacementSource], deleteSourceAfterImport: true },
  );
  assert.strictEqual(replacementFailure.success, false);
  assert.strictEqual(fs.readFileSync(path.join(replacementRoot, '花絮', 'replacement.jpg'), 'utf8'), 'late replacement', 'rollback must not delete a replacement with a different file identity');
};

main().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
  console.log('b-roll import tests passed');
}, error => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
