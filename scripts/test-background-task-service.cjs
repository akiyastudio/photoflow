const assert = require('assert');
const { EventEmitter } = require('events');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { normalizeExternalProgress } = require('../electron/modules/background-tasks-ipc.cjs');
const { pythonToolResourcePaths } = require('../electron/modules/system-ipc.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectFileTaskSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'project-file-task-service.cjs'), 'utf8');
const versionsIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'versions-ipc.cjs'), 'utf8');
assert(projectFileTaskSource.includes("scanning: '正在统计'") && projectFileTaskSource.includes('concurrencyLimit = 3') && projectFileTaskSource.includes('concurrencyWriteLimit = 2'), 'file tasks must allow three total disk tasks while retaining the two-writer limit');
const deferredMediaScanStart = versionsIpcSource.indexOf("type: 'version-media-rescan'");
const deferredMediaScanBlock = versionsIpcSource.slice(deferredMediaScanStart, versionsIpcSource.indexOf('const updatedFolderPath', deferredMediaScanStart));
assert(deferredMediaScanBlock.includes("resourceAccess: 'read'") && deferredMediaScanBlock.includes('resources: [projectPath]'), 'deferred media maintenance must declare its project path as read-only');
assert(deferredMediaScanBlock.includes("task.report(5, '正在扫描项目媒体文件')"), 'deferred media maintenance must leave 0% immediately after it starts');
const resourcePathsFor = (scriptName, args) => pythonToolResourcePaths(scriptName, args, path.win32).map(resource => resource.path);
assert.deepStrictEqual(resourcePathsFor('png_to_jpg.py', ['--quality', '95', '--keep-original', 'C:\\project\\images\\a.png']), ['C:\\project\\images'], 'PNG conversion must lock the directory where it writes JPG output');
assert.deepStrictEqual(resourcePathsFor('research.py', ['--path', 'C:\\project\\video\\clip.mp4', '--sensitivity', 'standard']), ['C:\\project\\video'], 'research must lock the directory where it exports frames');
assert.deepStrictEqual(resourcePathsFor('ffmpeg_transcode.py', ['C:\\project\\video\\clip.mp4', '--output-mode', 'new', '--source-folder', 'C:\\project\\video']), ['C:\\project\\video', 'C:\\project'], 'folder transcode must lock both direct output directories and the parent where it creates its sibling output folder');
assert.deepStrictEqual(resourcePathsFor('cut_video.py', ['C:\\project\\video\\clip.mp4', '--output-dir', 'D:\\exports']), ['C:\\project\\video', 'D:\\exports'], 'video splitting must lock its source-adjacent and explicit output directories');

const queued = async promise => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  return !settled;
};

const main = async () => {
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
  const monotonic = service.create({ id: 'monotonic', type: 'test', title: 'monotonic', concurrencyGroup: 'progress', concurrencyLimit: 1 });
  await monotonic.waitForStart();
  monotonic.context.report(60, 'phase one');
  monotonic.context.report(40, 'phase two');
  assert.equal(service.get('monotonic').progress, 60, 'background task progress must never move backwards between phases');
  monotonic.context.setCancellable(false);
  assert.equal(service.get('monotonic').cancellable, false, 'a running task must be able to disable cancellation before its atomic commit phase');
  assert.equal(service.cancel('monotonic'), false, 'a task in its atomic commit phase must reject cancellation');
  monotonic.complete();
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
    persistentService.upsertExternal({ id: 'external-progress', type: 'selection-operation', title: '外部进度', state: 'running', progress: 42, message: '正在处理' });
    persistentService.stop();

    const restoredService = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath });
    const restoredTask = restoredService.get('persistent');
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
    restoredService.stop();
  } finally {
    fs.rmSync(persistenceDirectory, { recursive: true, force: true });
  }

  console.log('background task scheduler tests passed');
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
