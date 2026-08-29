const assert = require('assert');
const { EventEmitter } = require('events');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createProjectFileTask } = require('../electron/services/project-file-task-service.cjs');
const { normalizeExternalProgress, registerBackgroundTasksIpc } = require('../electron/modules/background-tasks-ipc.cjs');
const { pythonToolResourcePaths, resolvePythonWorkerResourceLease, shouldTrackPythonToolAsBackgroundTask } = require('../electron/modules/system-ipc.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectFileTaskSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'project-file-task-service.cjs'), 'utf8');
const versionsIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'versions-ipc.cjs'), 'utf8');
const mediaScanSchedulerSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'media-tracking-scan-scheduler.cjs'), 'utf8');
const brollImportSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'broll-import.cjs'), 'utf8');
assert(projectFileTaskSource.includes("scanning: '正在统计'") && projectFileTaskSource.includes('concurrencyLimit = 3') && projectFileTaskSource.includes('concurrencyWriteLimit = 2'), 'file tasks must allow three total disk tasks while retaining the two-writer limit');
assert(brollImportSource.includes("concurrencyGroup: 'disk-io'") && brollImportSource.includes("task.withResources({\n              capacities: [{ key: 'heavy-media'"), 'b-roll imports must reserve heavy media capacity only around their actual split/transcode phases');
const deferredMediaScanStart = mediaScanSchedulerSource.indexOf("type: 'version-media-rescan'");
const deferredMediaScanBlock = mediaScanSchedulerSource.slice(deferredMediaScanStart, mediaScanSchedulerSource.indexOf('runner = createDirtyCoalescingRunner', deferredMediaScanStart));
assert(deferredMediaScanBlock.includes("{ path: projectPath, access: 'read' }") && deferredMediaScanBlock.includes('photoflow-workspace-database/'), 'deferred media maintenance must read project files while reserving the shared workspace database writer');
assert(deferredMediaScanBlock.includes("task.report(5, '正在扫描项目媒体文件')"), 'deferred media maintenance must leave 0% immediately after it starts');
assert(versionsIpcSource.includes('scheduleMediaTrackingScan(workspaceRoot, projectName, [], true)') && !versionsIpcSource.includes('runVersionMediaRescan'), 'deferred rescan and retry must enter the shared scheduler wrapper');
const resourcePathsFor = (scriptName, args) => pythonToolResourcePaths(scriptName, args, path.win32).map(resource => resource.path);
assert.deepStrictEqual(resourcePathsFor('png_to_jpg.py', ['--quality', '95', '--keep-original', 'C:\\project\\images\\a.webp']), ['C:\\project\\images'], 'image conversion must lock the directory where it writes JPG output');
assert.deepStrictEqual(resourcePathsFor('research.py', ['--path', 'C:\\project\\video\\clip.mp4', '--sensitivity', 'standard']), ['C:\\project\\video'], 'research must lock the directory where it exports frames');
assert.deepStrictEqual(resourcePathsFor('ffmpeg_transcode.py', ['C:\\project\\video\\clip.mp4', '--output-mode', 'new', '--source-folder', 'C:\\project\\video']), ['C:\\project\\video', 'photoflow-transcode-destination/c:/project/video'], 'folder transcode must coordinate its output family without locking unrelated sibling folders in the project');
assert.deepStrictEqual(resourcePathsFor('cut_video.py', ['C:\\project\\video\\clip.mp4', '--output-dir', 'D:\\exports']), ['C:\\project\\video', 'D:\\exports'], 'video splitting must lock its source-adjacent and explicit output directories');
assert.equal(shouldTrackPythonToolAsBackgroundTask('ffmpeg_transcode.py', ['C:\\project\\video\\clip.mp4', '--output-mode', 'new']), true, 'real video encoding must remain a formal background task');
assert.equal(shouldTrackPythonToolAsBackgroundTask('ffmpeg_transcode.py', ['C:\\project\\video\\clip.mp4', '--inspect-only']), false, 'automatic media inspection must remain panel-local and stay out of the background task center');
assert.equal(shouldTrackPythonToolAsBackgroundTask('cut_video.py', ['C:\\project\\video\\clip.mp4']), true, 'other real Python tools must retain their background task identity');
const splitWorkerLease = resolvePythonWorkerResourceLease('classify.py', { leaseId: 'lease-12345678', profile: 'video-split', phase: '分割大视频' });
assert.deepStrictEqual(splitWorkerLease.definition.capacities, [{ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 }]);
assert.equal(splitWorkerLease.definition.runningMessage, '分割大视频');
assert.throws(() => resolvePythonWorkerResourceLease('classify.py', { leaseId: 'lease-12345678', profile: 'arbitrary-host-resource' }), /unsupported resource profile/);

const queued = async promise => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  return !settled;
};

const main = async () => {
  const ipcHandlers = new Map();
  const ipcMain = {
    on: () => undefined,
    handle: (channel, handler) => ipcHandlers.set(channel, handler),
    removeListener: () => undefined,
  };
  registerBackgroundTasksIpc({
    ipcMain,
    eventBus: { on: () => () => undefined },
    backgroundTasks: {
      snapshot: () => ({ revision: 0, tasks: [] }), list: () => [], get: () => null,
      cancel: () => false, pause: () => false, continuePaused: () => false, dismiss: () => false,
      resume: async () => ({}), restart: async () => ({}), upsertExternal: () => undefined,
      retry: async () => ({
        accepted: true, sourceTaskId: 'source', replacementTaskId: 'replacement', deduplicated: false,
        task: { id: 'replacement' }, completion: Promise.resolve({}),
      }),
    },
    getMainWindow: () => null,
  });
  const retryResponse = await ipcHandlers.get('background-task-retry')(null, 'source');
  assert.equal(retryResponse.success, true);
  assert.equal(retryResponse.accepted, true);
  assert.equal(retryResponse.replacementTaskId, 'replacement');
  assert.equal('completion' in retryResponse, false, 'retry IPC must return acceptance immediately without serializing the completion promise');

  assert.equal(normalizeExternalProgress('workspace-selection-progress', { operationId: 'folder-listing', phase: 'listing_source_folders' }), null, 'opening filename selection must not create a background task for folder discovery');
  assert.equal(normalizeExternalProgress('workspace-selection-progress', { operationId: 'preflight-scan', phase: 'scanning_source' }), null, 'filename preflight scans must not create duplicate 0% background tasks');
  assert.equal(normalizeExternalProgress('workspace-selection-progress', { phase: 'copying', progress: 50 }), null, 'selection progress without an operation id must not create a shared invalid task');
  const selectionCopyTask = normalizeExternalProgress('workspace-selection-progress', { operationId: 'selection-copy', phase: 'copying', progress: 50, fileName: 'IMG_0001.CR3' });
  assert.equal(selectionCopyTask.id, 'external:selection:selection-copy');
  assert.equal(selectionCopyTask.state, 'running');
  assert.equal(selectionCopyTask.message, 'IMG_0001.CR3');
  const selectionCompleteTask = normalizeExternalProgress('workspace-selection-progress', { operationId: 'selection-copy', phase: 'complete', progress: 100 });
  assert.equal(selectionCompleteTask.state, 'completed', 'a real selection copy must still publish its terminal task state');

  const service = createBackgroundTaskService({ eventBus: new EventEmitter() });
  const fileTask = createProjectFileTask({
    backgroundTasks: service,
    event: { sender: { isDestroyed: () => false, send: () => undefined } },
    operationId: 'leased-file-task', operation: 'import', title: '导入文件', projectName: 'project',
    resources: ['C:/projects/leased-target'],
  });
  await fileTask.start();
  const conflictingFileTask = service.create({
    id: 'conflicting-file-task', type: 'test', title: '冲突文件任务',
    resources: ['C:/projects/leased-target/child'], concurrencyGroup: 'disk-io', concurrencyLimit: 3, concurrencyWriteLimit: 2,
  });
  const conflictingFileStart = conflictingFileTask.waitForStart();
  assert.equal(await queued(conflictingFileStart), true, 'a project file task must protect its paths through an explicit operation lease');
  fileTask.complete('导入完成');
  await conflictingFileStart;
  conflictingFileTask.complete();
  const monotonic = service.create({ id: 'monotonic', type: 'test', title: 'monotonic', concurrencyGroup: 'progress', concurrencyLimit: 1 });
  await monotonic.waitForStart();
  monotonic.context.report(60, 'phase one');
  monotonic.context.report(40, 'phase two');
  assert.equal(service.get('monotonic').progress, 60, 'background task progress must never move backwards between phases');
  monotonic.context.setCancellable(false);
  assert.equal(service.get('monotonic').cancellable, false, 'a running task must be able to disable cancellation before its atomic commit phase');
  assert.equal(service.cancel('monotonic'), false, 'a task in its atomic commit phase must reject cancellation');
  monotonic.complete();
  let retryRuns = 0;
  const runRetryReplacement = definition => service.run({
    ...(definition || {}),
    type: 'test-retry',
    title: 'retry replacement',
  }, async () => {
    retryRuns += 1;
    if (retryRuns === 1) throw new Error('transient failure');
    return { success: true };
  }, () => runRetryReplacement());
  await assert.rejects(runRetryReplacement({ id: 'retry-original' }), /transient failure/);
  assert.equal(service.get('retry-original').state, 'failed');
  const retryAccepted = await service.retry('retry-original');
  const retried = await retryAccepted.completion;
  assert.equal(service.get('retry-original'), null, 'a successful replacement retry must remove the superseded failure');
  assert.equal(retried.task.state, 'completed');
  const pausable = service.create({ id: 'pausable', type: 'project-file-operation', title: 'pausable', pausable: true });
  await pausable.waitForStart();
  assert.equal(service.pause('pausable'), true, 'a pausable running task must accept pause');
  assert.equal(service.get('pausable').state, 'pausing');
  let pauseGateReleased = false;
  const pauseGate = pausable.context.waitIfPaused().then(() => { pauseGateReleased = true; });
  await Promise.resolve();
  assert.equal(service.get('pausable').state, 'paused', 'a task must acknowledge pause at its next safe point');
  assert.equal(pauseGateReleased, false, 'the worker must remain blocked while paused');
  assert.equal(service.continuePaused('pausable'), true, 'a paused task must accept continue');
  await pauseGate;
  assert.equal(pauseGateReleased, true);
  assert.equal(service.get('pausable').state, 'running');
  pausable.context.setPausable(false);
  assert.equal(service.pause('pausable'), false, 'an atomic finalization phase must reject pause');
  pausable.complete();
  const definition = (id, resource, { limit = 3, writeLimit = 2, access = 'write' } = {}) => ({
    id,
    type: 'test',
    title: id,
    resources: [resource],
    concurrencyGroup: 'disk-io',
    concurrencyLimit: limit,
    concurrencyWriteLimit: writeLimit,
    resourceAccess: access,
  });

  const first = service.create(definition('first', 'C:/projects/a'));
  const second = service.create(definition('second', 'C:/projects/b'));
  const third = service.create(definition('third', 'C:/projects/c'));
  await Promise.all([first.waitForStart(), second.waitForStart()]);
  assert.equal(service.get('first').state, 'running', 'independent disk tasks must keep running concurrently');
  assert.equal(service.get('second').state, 'running', 'the two-writer limit must allow the second independent write');
  const thirdStart = third.waitForStart();
  assert.equal(await queued(thirdStart), true, '第三个磁盘写入任务应等待写入名额');
  assert.equal(service.get('third').state, 'queued', 'a third writer must remain queued');
  const readThird = service.create(definition('read-third', 'C:/projects/d', { access: 'read' }));
  await readThird.waitForStart();
  assert.equal(service.get('read-third').state, 'running', 'a read task must be allowed to use the third disk slot');
  const readFourth = service.create(definition('read-fourth', 'C:/projects/e', { access: 'read' }));
  const readFourthStart = readFourth.waitForStart();
  assert.equal(await queued(readFourthStart), true, '第四个磁盘任务应等待总并发名额');
  readThird.complete();
  await readFourthStart;
  readFourth.complete();
  first.complete();
  await thirdStart;
  second.complete();
  third.complete();

  const parent = service.create(definition('parent', 'C:/projects/shared'));
  const child = service.create(definition('child', 'c:\\projects\\shared\\subfolder'));
  await parent.waitForStart();
  const childStart = child.waitForStart();
  assert.equal(await queued(childStart), true, '父子路径重叠的任务应自动排队');
  assert.equal(service.get('child').state, 'queued', 'path-conflicting tasks must remain queued without changing the concurrency limit');
  assert.match(service.get('child').message, /等待“parent”完成/, 'a queued task must name the task holding its resource');
  assert.deepEqual(service.get('child').blockedByTaskIds, ['parent'], 'queued task metadata must retain the blocker identity');
  parent.complete();
  await childStart;
  child.complete();

  const maintenance = service.create(definition('maintenance-scan', 'C:/projects/shared', { access: 'read' }));
  const focusedCompare = service.create(definition('focused-compare', 'C:/projects/shared/version-2', { access: 'read' }));
  await Promise.all([maintenance.waitForStart(), focusedCompare.waitForStart()]);
  assert.equal(service.get('focused-compare').state, 'running', 'overlapping read tasks must run concurrently');
  const overlappingWrite = service.create(definition('overlapping-write', 'C:/projects/shared/version-2/output'));
  const overlappingWriteStart = overlappingWrite.waitForStart();
  assert.equal(await queued(overlappingWriteStart), true, 'a write overlapping active reads must wait');
  assert.match(service.get('overlapping-write').message, /maintenance-scan|focused-compare/, 'a blocked write must expose its active read blocker');
  maintenance.complete();
  focusedCompare.complete();
  await overlappingWriteStart;
  overlappingWrite.complete();

  const activeTranscode = service.create({
    id: 'active-transcode', type: 'python-tool', title: '视频转码',
    concurrencyGroup: 'heavy-media', concurrencyLimit: 1, concurrencyWriteLimit: 1,
    resources: pythonToolResourcePaths('ffmpeg_transcode.py', ['C:\\project\\mov\\clip.mp4', '--output-mode', 'new', '--source-folder', 'C:\\project\\mov'], path.win32),
  });
  await activeTranscode.waitForStart();
  const phasedImport = service.create({
    id: 'phased-import', type: 'project-file-operation', title: '导入花絮',
    resources: ['C:/project/花絮'], concurrencyGroup: 'disk-io', concurrencyLimit: 3, concurrencyWriteLimit: 2,
  });
  await phasedImport.waitForStart();
  assert.equal(service.get('phased-import').state, 'running', 'an import must be able to scan and copy while an unrelated video transcode is active');
  let heavyPhaseStarted = false;
  const heavyPhase = phasedImport.context.withResources({
    concurrencyGroup: 'heavy-media', concurrencyLimit: 1, concurrencyWriteLimit: 1, runningMessage: '正在转码花絮视频',
  }, async () => { heavyPhaseStarted = true; });
  assert.equal(await queued(heavyPhase), true, 'only the import heavy-media phase must wait for the active transcode');
  assert.equal(service.get('phased-import').state, 'running', 'waiting for a scoped phase must not put the whole import back into the queued state');
  assert.match(service.get('phased-import').message, /等待“视频转码”完成/);
  activeTranscode.complete();
  await heavyPhase;
  assert.equal(heavyPhaseStarted, true);
  const laterTranscode = service.create({
    id: 'later-transcode', type: 'python-tool', title: '后续视频转码',
    concurrencyGroup: 'heavy-media', concurrencyLimit: 1, concurrencyWriteLimit: 1,
  });
  await laterTranscode.waitForStart();
  assert.equal(service.get('later-transcode').state, 'running', 'the heavy-media slot must be released as soon as the import transcode phase ends');
  laterTranscode.complete();
  phasedImport.complete();

  const cpuHolder = service.create({ id: 'cpu-holder', type: 'test', title: 'CPU holder' });
  const gpuHolder = service.create({ id: 'gpu-holder', type: 'test', title: 'GPU holder' });
  const multiResourceTask = service.create({ id: 'multi-resource', type: 'test', title: 'multi resource' });
  await Promise.all([cpuHolder.waitForStart(), gpuHolder.waitForStart(), multiResourceTask.waitForStart()]);
  const cpuLease = await cpuHolder.context.acquireResourceLease({ capacities: [{ key: 'cpu-heavy', limit: 1, writeLimit: 1 }] });
  const gpuLease = await gpuHolder.context.acquireResourceLease({ capacities: [{ key: 'gpu-heavy', limit: 1, writeLimit: 1 }] });
  let multiResourceStarted = false;
  const multiResourceLease = multiResourceTask.context.acquireResourceLease({
    capacities: [
      { key: 'cpu-heavy', limit: 1, writeLimit: 1 },
      { key: 'gpu-heavy', limit: 1, writeLimit: 1 },
    ],
    runningMessage: '正在执行 CPU/GPU 阶段',
  }).then(lease => { multiResourceStarted = true; return lease; });
  assert.equal(await queued(multiResourceLease), true, 'a phase requesting multiple capacities must wait until every capacity is available');
  cpuLease.release();
  assert.equal(await queued(multiResourceLease), true, 'a multi-capacity lease must not start after only one blocker is released');
  assert.equal(multiResourceStarted, false);
  gpuLease.release();
  const acquiredMultiResourceLease = await multiResourceLease;
  assert.equal(multiResourceStarted, true);
  acquiredMultiResourceLease.release();
  cpuHolder.complete();
  gpuHolder.complete();
  multiResourceTask.complete();

  const terminationHolder = service.create({ id: 'termination-holder', type: 'test', title: 'termination holder' });
  const terminatedWaiter = service.create({ id: 'terminated-waiter', type: 'test', title: 'terminated waiter' });
  await Promise.all([terminationHolder.waitForStart(), terminatedWaiter.waitForStart()]);
  const terminationLease = await terminationHolder.context.acquireResourceLease({ capacities: [{ key: 'termination-capacity', limit: 1, writeLimit: 1 }] });
  const abandonedLeaseRequest = terminatedWaiter.context.acquireResourceLease({ capacities: [{ key: 'termination-capacity', limit: 1, writeLimit: 1 }] });
  assert.equal(await queued(abandonedLeaseRequest), true);
  terminatedWaiter.complete();
  await assert.rejects(abandonedLeaseRequest, error => error?.code === 'TASK_FINISHED');
  terminationLease.release();
  terminationHolder.complete();

  const mediaIndex = service.create({
    id: 'workspace-media-index', type: 'test', title: 'media index',
    resources: [
      { path: 'D:/workspace/project', access: 'read' },
      { path: 'photoflow-workspace-database/D:/workspace', access: 'write' },
    ],
  });
  await mediaIndex.waitForStart();
  const databaseMaintenance = service.create({
    id: 'workspace-database-maintenance', type: 'test', title: 'database maintenance',
    resources: [{ path: 'photoflow-workspace-database/d:/workspace', access: 'write' }],
  });
  const databaseMaintenanceStart = databaseMaintenance.waitForStart();
  assert.equal(await queued(databaseMaintenanceStart), true, 'workspace maintenance must wait for a media index writer on the same SQLite database');
  mediaIndex.complete();
  await databaseMaintenanceStart;
  databaseMaintenance.complete();

  const sourceScan = service.create(definition('source-scan', 'C:/projects/source', { access: 'read' }));
  await sourceScan.waitForStart();
  const copyPaste = service.create({
    ...definition('copy-paste', 'C:/projects/unused'),
    resources: [
      { path: 'C:/projects/source/photos', access: 'read' },
      { path: 'C:/projects/destination', access: 'write' },
    ],
  });
  await copyPaste.waitForStart();
  assert.equal(service.get('copy-paste').state, 'running', 'copy-paste must share a source read lock with maintenance while keeping its destination write lock');
  copyPaste.complete();
  sourceScan.complete();

  const blocker = service.create(definition('blocker', 'C:/projects/x', { limit: 1, writeLimit: 1 }));
  const cancelled = service.create(definition('cancelled', 'C:/projects/y', { limit: 1, writeLimit: 1 }));
  await blocker.waitForStart();
  const cancelledStart = cancelled.waitForStart();
  assert.equal(service.cancel('cancelled'), true);
  await assert.rejects(cancelledStart, error => error?.code === 'TASK_CANCELLED');
  cancelled.cancelled();
  assert.equal(service.get('cancelled').state, 'cancelled');
  assert.equal(service.dismiss('cancelled'), true);
  assert.equal(service.get('cancelled'), null);
  blocker.complete();

  const replacementEvents = [];
  const replacementBus = new EventEmitter();
  replacementBus.on('background-task:changed', delta => replacementEvents.push(delta));
  const replacementService = createBackgroundTaskService({ eventBus: replacementBus });
  const createFailedRetryable = async (id, replacementWorker, factoryFailure = null) => {
    const retryFactory = factoryFailure
      ? async () => { throw factoryFailure; }
      : () => replacementService.run({ type: 'retry-test', title: `replacement-${id}` }, replacementWorker, retryFactory);
    await assert.rejects(replacementService.run(
      { id, type: 'retry-test', title: id },
      async () => { throw new Error(`failed-${id}`); },
      retryFactory,
    ));
    return retryFactory;
  };

  await createFailedRetryable('retry-completed', async () => 'ok');
  const completedAccepted = await replacementService.retry('retry-completed');
  const completedRetry = await completedAccepted.completion;
  assert.equal(replacementService.get('retry-completed'), null);
  assert.equal(completedRetry.task.state, 'completed');
  assert.equal(completedRetry.task.retryOfTaskId, 'retry-completed');
  assert.equal(completedRetry.task.retryAttempt, 1);
  const completedDelta = replacementEvents.at(-1);
  assert(completedDelta.removeIds.includes('retry-completed') && completedDelta.upserts.some(task => task.state === 'completed'), 'replacement completion must atomically remove the old failure');

  await createFailedRetryable('retry-failed', async () => { throw new Error('replacement failed'); });
  const failedAccepted = await replacementService.retry('retry-failed');
  await assert.rejects(failedAccepted.completion, /replacement failed/);
  assert.equal(replacementService.get('retry-failed'), null);
  const replacementFailures = replacementService.list().filter(task => task.type === 'retry-test' && task.state === 'failed');
  assert.equal(replacementFailures.filter(task => task.retryOfTaskId === 'retry-failed').length, 1, 'new failure must atomically replace the old failure card');

  await createFailedRetryable('retry-cancelled', async () => {
    throw Object.assign(new Error('cancel replacement'), { code: 'TASK_CANCELLED' });
  });
  const cancelledAccepted = await replacementService.retry('retry-cancelled');
  const cancelledRetry = await cancelledAccepted.completion;
  assert.equal(cancelledRetry.cancelled, true);
  const restoredFailure = replacementService.get('retry-cancelled');
  assert.equal(restoredFailure.state, 'failed');
  assert.equal(restoredFailure.retryPending, false);
  assert.equal(restoredFailure.retryable, true, 'cancelled replacement must restore the old retry button');

  const factoryFailure = new Error('factory did not start');
  await createFailedRetryable('retry-factory-failed', null, factoryFailure);
  const beforeFactoryFailure = replacementService.get('retry-factory-failed');
  await assert.rejects(replacementService.retry('retry-factory-failed'), /factory did not start/);
  assert.deepEqual(replacementService.get('retry-factory-failed'), beforeFactoryFailure, 'factory startup failure must leave the old failure untouched');
  assert(replacementEvents.every((delta, index) => index === 0 || delta.revision > replacementEvents[index - 1].revision), 'task deltas must have strictly increasing revisions');

  const asyncRetryService = createBackgroundTaskService({ eventBus: new EventEmitter() });
  let asyncFactoryCalls = 0;
  let releaseAsyncReplacement;
  const asyncReplacementGate = new Promise(resolve => { releaseAsyncReplacement = resolve; });
  let asyncRetryFactory;
  asyncRetryFactory = async () => {
    asyncFactoryCalls += 1;
    await Promise.resolve();
    return asyncRetryService.run(
      { type: 'async-retry-test', title: 'async replacement' },
      async () => { await asyncReplacementGate; return 'async-ok'; },
      asyncRetryFactory,
    );
  };
  await assert.rejects(asyncRetryService.run(
    { id: 'async-retry-source', type: 'async-retry-test', title: 'async source' },
    async () => { throw new Error('async source failed'); },
    asyncRetryFactory,
  ));
  const firstAsyncStart = asyncRetryService.retry('async-retry-source');
  const secondAsyncStart = asyncRetryService.retry('async-retry-source');
  const [firstAsyncAccepted, secondAsyncAccepted] = await Promise.all([firstAsyncStart, secondAsyncStart]);
  assert.equal(asyncFactoryCalls, 1, 'double-click retry must share one asynchronous factory start');
  assert.equal(firstAsyncAccepted.replacementTaskId, secondAsyncAccepted.replacementTaskId);
  assert.equal(secondAsyncAccepted.deduplicated, true);
  assert.equal(asyncRetryService.get('async-retry-source').retryPending, true);
  assert.equal(asyncRetryService.dismiss('async-retry-source'), false, 'a failure with an active replacement must not be dismissible');
  releaseAsyncReplacement();
  const asyncCompleted = await firstAsyncAccepted.completion;
  assert.equal(asyncCompleted.result, 'async-ok');
  assert.equal(asyncRetryService.get('async-retry-source'), null);

  const conflictService = createBackgroundTaskService({ eventBus: new EventEmitter() });
  let releaseConflict;
  const conflictGate = new Promise(resolve => { releaseConflict = resolve; });
  const activeConflict = conflictService.start(
    { id: 'active-conflict', type: 'conflict-test', title: 'active conflict', dedupeKey: 'same-logical-task' },
    async () => { await conflictGate; },
  );
  await assert.rejects(conflictService.run(
    { id: 'conflict-source', type: 'conflict-test', title: 'conflict source' },
    async () => { throw new Error('conflict source failed'); },
    () => conflictService.run(
      { type: 'conflict-test', title: 'deduped replacement', dedupeKey: 'same-logical-task' },
      async () => undefined,
    ),
  ));
  await assert.rejects(conflictService.retry('conflict-source'), error => error?.code === 'RETRY_DEDUPE_CONFLICT');
  assert.equal(conflictService.get('conflict-source').retryPending, false);
  releaseConflict();
  await activeConflict.completion;

  const pendingHistoryService = createBackgroundTaskService({ eventBus: new EventEmitter(), maxHistory: 1 });
  let pendingRetryFactory;
  pendingRetryFactory = () => pendingHistoryService.run(
    { type: 'pending-history-test', title: 'pending replacement' },
    task => new Promise(resolve => task.signal.addEventListener('abort', resolve, { once: true })),
    pendingRetryFactory,
  );
  await assert.rejects(pendingHistoryService.run(
    { id: 'pending-history-source', type: 'pending-history-test', title: 'pending source' },
    async () => { throw new Error('pending source failed'); },
    pendingRetryFactory,
  ));
  const pendingAccepted = await pendingHistoryService.retry('pending-history-source');
  assert(pendingHistoryService.get('pending-history-source'), 'history pruning must retain a failure while its replacement is active');
  assert.equal(pendingHistoryService.cancel(pendingAccepted.replacementTaskId), true);
  await pendingAccepted.completion;
  assert.equal(pendingHistoryService.get('pending-history-source').state, 'failed');

  const ephemeralLogs = [];
  const ephemeralService = createBackgroundTaskService({
    eventBus: new EventEmitter(),
    writeLog: (...args) => ephemeralLogs.push(args),
  });
  await ephemeralService.run({ id: 'ephemeral-completed', type: 'silent-test', title: 'silent', notificationPolicy: 'silent' }, async () => undefined);
  await assert.rejects(ephemeralService.run({ id: 'ephemeral-failed', type: 'silent-test', title: 'silent fail', notificationPolicy: 'silent' }, async () => { throw new Error('silent failure'); }));
  assert.equal(ephemeralService.list().length, 0, 'ephemeral tasks must disappear for every terminal state');
  assert(ephemeralLogs.some(([, message, details]) => message === 'Ephemeral background task failed' && details.taskId === 'ephemeral-failed'), 'ephemeral failures must produce a structured log');

  const cappedService = createBackgroundTaskService({ eventBus: new EventEmitter(), maxHistory: 10 });
  for (let index = 0; index < 14; index += 1) {
    const handle = cappedService.create({ id: `history-failure-${index}`, type: 'history-test', title: `history-${index}` });
    await handle.waitForStart();
    handle.fail(new Error('history failure'));
  }
  assert.equal(cappedService.list().length, 10, 'failed history must obey the same cap as completed history');

  const persistenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-background-tasks-'));
  const persistencePath = path.join(persistenceDirectory, 'tasks.json');
  try {
    const persistentService = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath });
    const persistentTask = persistentService.create({ id: 'persistent', type: 'workspace-backup', title: '持久化备份测试' });
    await persistentTask.waitForStart();
    persistentTask.context.saveCheckpoint({ completedFiles: 3 }, 45, '已完成 3 个文件');
    const restartableTask = persistentService.create({ id: 'restartable', type: 'storage-usage-scan', title: '安全重跑测试' });
    await restartableTask.waitForStart();
    restartableTask.context.report(35, '正在扫描');
    const incompatibleTask = persistentService.create({ id: 'incompatible', type: 'workspace-backup', title: '旧版断点测试', checkpointVersion: 2 });
    await incompatibleTask.waitForStart();
    incompatibleTask.context.saveCheckpoint({ legacy: true }, 20, '旧版断点');
    const automaticTask = persistentService.create({ id: 'automatic-restart', type: 'component-status-refresh', title: '自动重跑测试' });
    await automaticTask.waitForStart();
    automaticTask.context.report(50, '刷新中');
    const restartFactoryFailureTask = persistentService.create({ id: 'restart-factory-failure', type: 'thumbnail-cache-recovery', title: '恢复工厂失败测试' });
    await restartFactoryFailureTask.waitForStart();
    const ephemeralActive = persistentService.create({ id: 'ephemeral-active', type: 'silent-persist-test', title: 'silent active', notificationPolicy: 'silent' });
    await ephemeralActive.waitForStart();
    persistentService.upsertExternal({ id: 'external-progress', type: 'selection-operation', title: '外部进度', state: 'running', progress: 42, message: '正在处理' });
    let releaseInterruptedReplacement;
    const interruptedReplacementGate = new Promise(resolve => { releaseInterruptedReplacement = resolve; });
    let interruptedRetryFactory;
    interruptedRetryFactory = () => persistentService.run(
      { type: 'storage-usage-scan', title: 'interrupted replacement' },
      async () => { await interruptedReplacementGate; },
      interruptedRetryFactory,
    );
    await assert.rejects(persistentService.run(
      { id: 'retry-interrupted-old', type: 'storage-usage-scan', title: 'retry interrupted old' },
      async () => { throw new Error('old failure'); },
      interruptedRetryFactory,
    ));
    const interruptedRetryPromise = persistentService.retry('retry-interrupted-old').catch(() => undefined);
    await new Promise(resolve => setImmediate(resolve));
    const interruptedReplacementId = persistentService.get('retry-interrupted-old').replacedByTaskId;
    assert(interruptedReplacementId && persistentService.get(interruptedReplacementId)?.state === 'running');
    persistentService.stop();

    const restoredService = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath });
    const restoredTask = restoredService.get('persistent');
    assert.equal(restoredService.get('ephemeral-active'), null, 'ephemeral tasks must never enter persisted history');
    assert.equal(restoredService.get(interruptedReplacementId), null, 'interrupted replacement must be removed during recovery');
    assert.equal(restoredService.get('retry-interrupted-old').retryPending, false, 'interrupted replacement must restore the old failure');
    assert.equal(restoredService.get('external-progress').state, 'interrupted', 'external progress tasks must participate in restart recovery');
    assert.equal(restoredService.get('external-progress').progress, 42, 'external progress tasks must retain their progress');
    assert.equal(restoredTask.state, 'interrupted', 'running tasks must be restored as interrupted after restart');
    assert.equal(restoredTask.progress, 45, 'restored tasks must retain their last progress');
    assert.deepEqual(restoredTask.checkpoint, { completedFiles: 3 }, 'restored tasks must retain their checkpoint');
    assert.equal(restoredTask.resumePolicy, 'checkpoint', 'task policy must survive persistence');
    assert.equal(restoredTask.notificationPolicy, 'progress-toast', 'task notification policy must survive persistence');
    assert.equal(restoredTask.resumable, false, 'a checkpoint policy without a registered resume worker must not claim resumability');
    let resumedCheckpoint = null;
    restoredService.registerTypeResumeFactory('workspace-backup', async task => {
      resumedCheckpoint = task.checkpoint;
      return { task };
    });
    assert.equal(restoredService.get('persistent').resumeAvailable, true, 'registering a type resume worker must make interrupted tasks resumable');
    await restoredService.resume('persistent');
    assert.deepEqual(resumedCheckpoint, { completedFiles: 3 }, 'resume workers must receive the persisted checkpoint');
    assert.equal(restoredService.get('incompatible').resumeAvailable, false, 'incompatible checkpoints must not expose a continue action');
    let restartedTaskId = '';
    restoredService.registerTypeRestartFactory('storage-usage-scan', async task => {
      restartedTaskId = task.id;
      return { task };
    });
    assert.equal(restoredService.get('retry-interrupted-old').retryable, true, 'restored old failure must regain retry after its safe worker registers');
    assert.equal(restoredService.get('restartable').restartAvailable, true, 'safe restart workers must expose a restart action');
    await restoredService.restart('restartable');
    assert.equal(restartedTaskId, 'restartable', 'restart workers must receive the interrupted task identity');
    let automaticRestarted = false;
    restoredService.registerTypeRestartFactory('component-status-refresh', async task => {
      automaticRestarted = task.id === 'automatic-restart';
      return { task };
    }, { autoRestart: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(automaticRestarted, true, 'whitelisted safe tasks must restart automatically after registration');
    restoredService.registerTypeRestartFactory('thumbnail-cache-recovery', async () => { throw new Error('restart factory unavailable'); });
    await assert.rejects(restoredService.restart('restart-factory-failure'), /restart factory unavailable/);
    assert.equal(restoredService.get('restart-factory-failure').state, 'failed');
    assert.equal(restoredService.get('restart-factory-failure').retryable, true, 'a failed restart factory must leave the restored card retryable');
    restoredService.stop();
    releaseInterruptedReplacement();
    await interruptedRetryPromise;
    fs.writeFileSync(persistencePath, JSON.stringify({
      version: 2,
      tasks: [{
        id: 'dangling-retry-source', type: 'storage-usage-scan', title: 'dangling retry', state: 'failed',
        progress: 10, message: 'failed', error: 'failed', cancellable: false, retryable: false,
        resumable: false, resumeAvailable: false, restartAvailable: false,
        capabilities: { cancellable: false, pausable: false, resumable: false, retryable: false },
        resumePolicy: 'safe-restart', notificationPolicy: 'error-only', historyPolicy: 'persistent',
        retryOfTaskId: null, replacedByTaskId: 'missing-replacement', retryAttempt: 0, retryPending: true,
        metadata: {}, createdAt: 1, updatedAt: 2, startedAt: 1, finishedAt: 2,
      }],
    }), 'utf8');
    const danglingService = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath });
    assert.equal(danglingService.get('dangling-retry-source').retryPending, false, 'a missing replacement must not leave a restored failure permanently retry-pending');
    assert.equal(danglingService.get('dangling-retry-source').replacedByTaskId, null);
    danglingService.stop();
  } finally {
    fs.rmSync(persistenceDirectory, { recursive: true, force: true });
  }

  console.log('background task scheduler tests passed');
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
