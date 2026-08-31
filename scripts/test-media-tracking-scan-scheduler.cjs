const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { coalesceMediaChanges, createMediaTrackingScanScheduler } = require('../electron/services/media-tracking-scan-scheduler.cjs');
const { MEDIA_RESCAN_POLICY_VERSION } = require('../electron/services/background-task-policy-versions.cjs');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const run = async () => {
  const parent = { path: 'C:/workspace/Project/Folder', eventType: 'change', kind: 'directory' };
  const coalesced = coalesceMediaChanges([
    { path: 'C:/workspace/Project/a.jpg', eventType: 'change', kind: 'file' },
    { path: 'C:/workspace/Project/a.jpg', eventType: 'rename', kind: 'file' },
    { path: 'C:/workspace/Project/notes.txt', eventType: 'change', kind: 'file' },
    parent,
    { path: 'C:/workspace/Project/Folder/child.jpg', eventType: 'rename', kind: 'file' },
  ]);
  assert.deepEqual(coalesced.map(change => [path.basename(change.path), change.eventType]), [['a.jpg', 'rename'], ['Folder', 'change']], 'rename must dominate change, ordinary files must drop, and a parent directory must cover descendants');
  assert.equal(coalesceMediaChanges(Array.from({ length: 100 }, (_, index) => ({ path: `C:/workspace/Project-${index}/notes.txt`, eventType: 'change', kind: 'file' }))).length, 0, '100 projects of ordinary file noise must produce zero media sync changes');
  assert.equal(coalesceMediaChanges([{ path: 'C:/workspace/Project/notes.txt', eventType: 'rename', kind: 'missing', previousKind: 'file', previousExtension: '.txt' }]).length, 0, 'deleting notes.txt must create zero media tasks');
  const dismissedLegacyTasks = [];
  let restartPolicy;
  createMediaTrackingScanScheduler({
    backgroundTasks: {
      list: () => [
        {
          id: 'legacy-noise', type: 'version-media-rescan', state: 'interrupted',
          metadata: { workspaceRoot: 'C:/workspace', projectName: 'Project', fullScan: false },
        },
        {
          id: 'legacy-full', type: 'version-media-rescan', state: 'interrupted',
          metadata: { workspaceRoot: 'C:/workspace', projectName: 'Project', fullScan: true },
        },
        {
          id: 'v2-incremental', type: 'version-media-rescan', state: 'interrupted',
          metadata: { workspaceRoot: 'C:/workspace', projectName: 'Project', fullScan: false, mediaRescanPolicyVersion: MEDIA_RESCAN_POLICY_VERSION },
        },
      ],
      dismiss: id => { dismissedLegacyTasks.push(id); return true; },
      registerTypeRestartFactory: (_type, _factory, options) => { restartPolicy = options; return () => undefined; },
    },
    mediaScanService: { syncProject: async () => ({ thumbnailCandidates: [] }), syncChangedPaths: async () => ({ thumbnailCandidates: [] }) },
    versionStaleDetectionService: { schedule: () => undefined, cancel: () => undefined },
    getProject: () => null,
  }).stop();
  assert.deepEqual(dismissedLegacyTasks, [], 'persisted history migration must not be duplicated in the scheduler');
  assert.equal(restartPolicy.canRestart({ metadata: { workspaceRoot: 'C:/workspace', projectName: 'Project', fullScan: true } }), true, 'explicit legacy full scans must remain restartable');
  assert.equal(restartPolicy.canRestart({ metadata: { workspaceRoot: 'C:/workspace', projectName: 'Project', fullScan: false, mediaRescanPolicyVersion: MEDIA_RESCAN_POLICY_VERSION } }), true, 'current-policy incremental work must remain restartable');
  assert.equal(restartPolicy.autoRestartDelayMs, 30000, 'restored media scans must yield startup priority to database maintenance');

  const recoveryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-media-recovery-'));
  try {
    const persistencePath = path.join(recoveryDirectory, 'tasks.json');
    const oldSnapshotId = '11111111-1111-4111-8111-111111111111';
    const oldPath = path.resolve('C:/recovery-workspace/Project/old.jpg');
    const freshPath = path.resolve('C:/recovery-workspace/Project/fresh.jpg');
    const beforeRestart = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath });
    const interrupted = beforeRestart.create({
      id: 'persisted-media-replay', type: 'version-media-rescan', title: 'persisted replay',
      resources: [],
      metadata: {
        workspaceRoot: 'C:/recovery-workspace', projectName: 'Project', fullScan: false,
        changes: [{ path: oldPath, eventType: 'rename', kind: 'file' }], changedPaths: [oldPath],
        snapshotId: oldSnapshotId, mediaRescanPolicyVersion: MEDIA_RESCAN_POLICY_VERSION,
      },
    });
    await interrupted.waitForStart();
    beforeRestart.stop();

    const restoredTasks = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath });
    assert.equal(restoredTasks.get('persisted-media-replay')?.state, 'interrupted');
    const recoveryCalls = [];
    const recoveryScheduler = createMediaTrackingScanScheduler({
      backgroundTasks: {
        ...restoredTasks,
        registerTypeRestartFactory: (type, factory, options) => restoredTasks.registerTypeRestartFactory(type, factory, { ...options, autoRestart: false }),
      },
      delayMs: 1000,
      mediaScanService: {
        syncProject: async (root, projectName) => {
          recoveryCalls.push({ kind: 'full', root, projectName });
          return { thumbnailCandidates: [] };
        },
        syncChangedPaths: async (root, projectName, changes, _removed, options) => {
          recoveryCalls.push({ kind: 'incremental', root, projectName, changes, snapshotId: options.snapshotId });
          return { thumbnailCandidates: [] };
        },
      },
      versionStaleDetectionService: { schedule: () => undefined, cancel: () => undefined },
      getProject: () => ({ relative_path: 'Project', availability: 'available' }),
    });
    await recoveryScheduler.workspaceAdmission.acquire(path.resolve('C:/recovery-workspace').toLocaleLowerCase());
    const freshTicket = recoveryScheduler.schedule('C:/recovery-workspace', 'Project', [{ path: freshPath, eventType: 'rename', kind: 'file' }]);
    const replayPromise = restoredTasks.restart('persisted-media-replay');
    await wait(20);
    const normalStateBeforeReplay = recoveryScheduler.runner.getState(freshTicket.key);
    assert.equal(normalStateBeforeReplay?.generation, 1, 'fresh watcher delta must remain pending on the normal lane');
    assert.equal(normalStateBeforeReplay?.completedGeneration, 0, 'persisted replay must not acknowledge the normal lane generation');
    recoveryScheduler.workspaceAdmission.release(path.resolve('C:/recovery-workspace').toLocaleLowerCase());
    await replayPromise;
    await recoveryScheduler.flush({ key: freshTicket.key, generation: 2 });
    assert.deepEqual(recoveryCalls.map(call => call.kind), ['incremental', 'full'], 'old manifest replay and fresh full catch-up must execute as separate tasks');
    assert.equal(recoveryCalls[0].snapshotId, oldSnapshotId, 'replay must keep the persisted immutable snapshot id');
    const completedRecoveryTasks = restoredTasks.list().filter(task => task.type === 'version-media-rescan' && task.state === 'completed');
    assert.equal(completedRecoveryTasks.length, 2);
    const catchUpTask = completedRecoveryTasks.find(task => task.id !== 'persisted-media-replay');
    assert(catchUpTask, 'fresh catch-up must create a distinct BackgroundTask');
    assert.notEqual(catchUpTask.metadata.snapshotId, oldSnapshotId, 'fresh catch-up must use a new snapshot id');
    assert.equal(catchUpTask.metadata.fullScan, true, 'catch-up must be a full scan because watcher events are not persisted');
    assert(catchUpTask.metadata.changedPaths.includes(freshPath), 'fresh watcher delta must survive until the full catch-up batch');
    recoveryScheduler.stop();
    restoredTasks.stop();
  } finally {
    fs.rmSync(recoveryDirectory, { recursive: true, force: true });
  }

  const replayTask = {
    id: 'replay-only',
    metadata: {
      workspaceRoot: 'C:/replay-only-workspace', projectName: 'Project', fullScan: false,
      changes: [{ path: 'C:/replay-only-workspace/Project/old.jpg', eventType: 'rename', kind: 'file' }],
      snapshotId: '22222222-2222-4222-8222-222222222222', mediaRescanPolicyVersion: MEDIA_RESCAN_POLICY_VERSION,
    },
  };
  let replayOnlyFactory;
  const replayOnlyDefinitions = [];
  const replayOnlyScheduler = createMediaTrackingScanScheduler({
    backgroundTasks: {
      run: async (definition, worker) => {
        replayOnlyDefinitions.push(definition);
        return { task: definition, result: await worker({ report: () => undefined }) };
      },
      registerTypeRestartFactory: (_type, factory) => { replayOnlyFactory = factory; return () => undefined; },
    },
    delayMs: 0,
    mediaScanService: { syncProject: async () => ({ thumbnailCandidates: [] }), syncChangedPaths: async () => ({ thumbnailCandidates: [] }) },
    versionStaleDetectionService: { schedule: () => undefined, cancel: () => undefined },
    getProject: () => ({ relative_path: 'Project', availability: 'available' }),
  });
  await replayOnlyFactory(replayTask);
  await wait(20);
  assert.equal(replayOnlyDefinitions.length, 2, 'a replay without fresh watcher work must still schedule exactly one full catch-up');
  assert.equal(replayOnlyDefinitions[0].metadata.snapshotId, replayTask.metadata.snapshotId);
  assert.equal(replayOnlyDefinitions[1].metadata.fullScan, true);
  assert.notEqual(replayOnlyDefinitions[1].metadata.snapshotId, replayTask.metadata.snapshotId);
  replayOnlyScheduler.stop();

  const assertReplayWaiterTerminated = async action => {
    let restartFactory;
    let created = 0;
    const scheduler = createMediaTrackingScanScheduler({
      backgroundTasks: {
        run: async () => { created += 1; return { result: { thumbnailCandidates: [] } }; },
        registerTypeRestartFactory: (_type, factory) => { restartFactory = factory; return () => undefined; },
      },
      delayMs: 0,
      mediaScanService: { syncProject: async () => ({ thumbnailCandidates: [] }), syncChangedPaths: async () => ({ thumbnailCandidates: [] }) },
      versionStaleDetectionService: { schedule: () => undefined, cancel: () => undefined },
      getProject: () => ({ relative_path: 'Project', availability: 'available' }),
    });
    const admissionKey = path.resolve(replayTask.metadata.workspaceRoot).toLocaleLowerCase();
    await scheduler.workspaceAdmission.acquire(admissionKey);
    const replay = restartFactory(replayTask);
    await wait(10);
    action(scheduler);
    await assert.rejects(replay, error => ['ADMISSION_CANCELLED', 'ADMISSION_QUEUE_STOPPED', 'DIRTY_RUNNER_CANCELLED'].includes(error?.code));
    scheduler.workspaceAdmission.release(admissionKey);
    await wait(10);
    assert.equal(created, 0, 'terminated replay admission waiters must not create BackgroundTasks');
    scheduler.stop();
  };
  await assertReplayWaiterTerminated(scheduler => scheduler.cancel(replayTask.metadata.workspaceRoot, replayTask.metadata.projectName));
  await assertReplayWaiterTerminated(scheduler => scheduler.stop());

  let releaseAdmissionScan;
  const admissionGate = new Promise(resolve => { releaseAdmissionScan = resolve; });
  let createdTasks = 0;
  const admissionScheduler = createMediaTrackingScanScheduler({
    backgroundTasks: {
      run: async () => { createdTasks += 1; await admissionGate; return { result: { thumbnailCandidates: [] } }; },
      registerTypeRestartFactory: () => () => undefined,
    },
    delayMs: 0,
    mediaScanService: { syncProject: async () => ({ thumbnailCandidates: [] }), syncChangedPaths: async () => ({ thumbnailCandidates: [] }) },
    versionStaleDetectionService: { schedule: () => undefined, cancel: () => undefined },
    getProject: (_root, projectName) => ({ relative_path: projectName, availability: 'available' }),
  });
  for (let index = 0; index < 20; index += 1) {
    admissionScheduler.schedule('C:/admission-workspace', `Project-${index}`, [`C:/admission-workspace/Project-${index}/image.jpg`]);
  }
  await wait(30);
  assert.equal(createdTasks, 1, 'same-workspace admission must create only one BackgroundTask instead of one running plus 19 queued');
  assert.equal(admissionScheduler.workspaceAdmission.waitingCount(path.resolve('C:/admission-workspace').toLocaleLowerCase()), 19);
  admissionScheduler.stop();
  releaseAdmissionScan();
  await wait(10);
  assert.equal(createdTasks, 1, 'stopping the scheduler must reject admission waiters before they create tasks');

  let releaseCancelScan;
  const cancelGate = new Promise(resolve => { releaseCancelScan = resolve; });
  let cancelCreatedTasks = 0;
  const cancelScheduler = createMediaTrackingScanScheduler({
    backgroundTasks: {
      run: async () => { cancelCreatedTasks += 1; await cancelGate; return { result: { thumbnailCandidates: [] } }; },
      registerTypeRestartFactory: () => () => undefined,
    },
    delayMs: 0,
    mediaScanService: { syncProject: async () => ({ thumbnailCandidates: [] }), syncChangedPaths: async () => ({ thumbnailCandidates: [] }) },
    versionStaleDetectionService: { schedule: () => undefined, cancel: () => undefined },
    getProject: (_root, projectName) => ({ relative_path: projectName, availability: 'available' }),
  });
  cancelScheduler.schedule('C:/cancel-workspace', 'First', ['C:/cancel-workspace/First/a.jpg']);
  cancelScheduler.schedule('C:/cancel-workspace', 'Waiting', ['C:/cancel-workspace/Waiting/b.jpg']);
  await wait(20);
  assert.equal(cancelCreatedTasks, 1);
  cancelScheduler.cancel('C:/cancel-workspace', 'Waiting');
  releaseCancelScan();
  await wait(20);
  assert.equal(cancelCreatedTasks, 1, 'cancelling an admission waiter must prevent later BackgroundTask creation');
  cancelScheduler.stop();

  let releaseParallelScans;
  const parallelGate = new Promise(resolve => { releaseParallelScans = resolve; });
  let runningTasks = 0;
  let maximumRunningTasks = 0;
  const parallelScheduler = createMediaTrackingScanScheduler({
    backgroundTasks: {
      run: async () => {
        runningTasks += 1;
        maximumRunningTasks = Math.max(maximumRunningTasks, runningTasks);
        await parallelGate;
        runningTasks -= 1;
        return { result: { thumbnailCandidates: [] } };
      },
      registerTypeRestartFactory: () => () => undefined,
    },
    delayMs: 0,
    mediaScanService: { syncProject: async () => ({ thumbnailCandidates: [] }), syncChangedPaths: async () => ({ thumbnailCandidates: [] }) },
    versionStaleDetectionService: { schedule: () => undefined, cancel: () => undefined },
    getProject: () => ({ relative_path: 'Project', availability: 'available' }),
  });
  parallelScheduler.schedule('C:/workspace-a', 'Project', ['C:/workspace-a/Project/a.jpg']);
  parallelScheduler.schedule('C:/workspace-b', 'Project', ['C:/workspace-b/Project/b.jpg']);
  await wait(30);
  assert.equal(runningTasks, 2, 'two workspaces must each admit one running media task');
  assert.equal(maximumRunningTasks, 2);
  releaseParallelScans();
  await wait(10);
  parallelScheduler.stop();

  const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
  const blocker = backgroundTasks.create({
    id: 'workspace-writer', type: 'test', title: 'workspace writer',
    resources: [{ path: 'photoflow-workspace-database/C:/workspace', access: 'write' }],
  });
  await blocker.waitForStart();

  let releaseFirstScan;
  const firstScanGate = new Promise(resolve => { releaseFirstScan = resolve; });
  const scanCalls = [];
  const staleCalls = [];
  const scheduler = createMediaTrackingScanScheduler({
    backgroundTasks,
    delayMs: 0,
    mediaScanService: {
      syncProject: async (root, projectName) => {
        scanCalls.push({ root, projectName });
        if (scanCalls.length === 1) await firstScanGate;
        return { thumbnailCandidates: [] };
      },
      syncChangedPaths: async (root, projectName, changes) => {
        scanCalls.push({ root, projectName, changes });
        if (scanCalls.length === 1) await firstScanGate;
        return { thumbnailCandidates: [] };
      },
    },
    versionStaleDetectionService: {
      schedule: (...args) => staleCalls.push(args),
      cancel: () => undefined,
    },
    getProject: () => ({ relative_path: 'Project', availability: 'available' }),
  });

  scheduler.schedule('C:/workspace', 'Project', ['C:/workspace/Project/first.jpg']);
  await wait(20);
  assert.equal(scanCalls.length, 0, 'automatic scans must wait for the shared workspace writer');
  blocker.complete();
  await wait(20);
  assert.equal(scanCalls.length, 1);

  scheduler.schedule('C:/workspace', 'Project', ['C:/workspace/Project/second.jpg']);
  releaseFirstScan();
  await wait(30);
  assert.equal(scanCalls.length, 2, 'a change received during an active media scan must trigger one follow-up scan');
  assert(scanCalls.every(call => Array.isArray(call.changes)), 'fullScan=false must call syncChangedPaths instead of syncProject');
  assert.equal(staleCalls.length, 2, 'every scheduled media change must also reach stale detection');
  assert.equal(scheduler.pendingCount(), 0);
  scheduler.stop();
  assert.equal(scheduler.schedule('C:/workspace', 'Project', ['C:/workspace/Project/late.jpg']), null, 'a delayed watcher callback cannot revive a stopped scheduler');
  await wait(10);
  assert.equal(scanCalls.length, 2, 'stopped admission queues must never receive post-stop scan retries');

  const missingStaleCalls = [];
  const missingScheduler = createMediaTrackingScanScheduler({
    backgroundTasks: createBackgroundTaskService({ eventBus: new EventEmitter() }),
    delayMs: 0,
    mediaScanService: { syncProject: async () => { throw new Error('missing projects must not scan'); }, syncChangedPaths: async () => { throw new Error('missing projects must not scan'); } },
    versionStaleDetectionService: { schedule: (...args) => missingStaleCalls.push(args), cancel: () => undefined },
    getProject: () => null,
  });
  assert.equal(missingScheduler.schedule('C:/workspace', 'Not registered', ['C:/workspace/Not registered/a.jpg']), null);
  await wait(10);
  assert.equal(missingStaleCalls.length, 0, 'unknown projects must be rejected before catalog-backed stale detection is scheduled');
  assert.equal(missingScheduler.pendingCount(), 0);
  missingScheduler.stop();

  const retryTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
  let retryAttempts = 0;
  const candidates = [];
  const retryScheduler = createMediaTrackingScanScheduler({
    backgroundTasks: retryTasks,
    delayMs: 0,
    runnerRetryDelays: [5],
    mediaScanService: {
      syncProject: async () => {
        retryAttempts += 1;
        if (retryAttempts === 1) throw new Error('transient scan failure');
        return { thumbnailCandidates: [{ photoId: 'photo', versionId: `version-${retryAttempts}`, filePath: 'C:/workspace/Project/a.jpg' }] };
      },
      syncChangedPaths: async () => { throw new Error('full scan retries must stay full'); },
    },
    versionStaleDetectionService: { schedule: () => undefined, cancel: () => undefined },
    getProject: () => ({ relative_path: 'Project', availability: 'available' }),
    onThumbnailCandidate: candidate => candidates.push(candidate),
  });
  retryScheduler.schedule('C:/workspace', 'Project', [], true);
  await wait(30);
  assert.equal(retryAttempts, 2, 'automatic retry must re-enter the runner wrapper');
  assert.equal(candidates.length, 1, 'automatic retry must process thumbnail candidates in the wrapper');
  const failedTask = retryTasks.list().find(task => task.type === 'version-media-rescan' && task.state === 'failed');
  assert(failedTask?.retryable, 'failed background scan must expose the runner-backed manual retry');
  const manualRetry = await retryTasks.retry(failedTask.id);
  await manualRetry.completion;
  assert.equal(retryAttempts, 3);
  assert.equal(candidates.length, 2, 'manual retry must use the same candidate-processing wrapper');
  retryScheduler.stop();
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8').replace(/\r\n?/g, '\n');
  const watcherStop = mainSource.slice(mainSource.indexOf('const stopWorkspaceWatcher'), mainSource.indexOf('const stopFileRootWatchers'));
  const watcherStart = mainSource.slice(mainSource.indexOf('const watchWorkspace'), mainSource.indexOf('const buildWorkspaceCatalog'));
  assert.match(watcherStop, /if \(previousWorkspaceRoot\) for \(const project of [^\n]+\) mediaTrackingScanScheduler\?\.cancel\(previousWorkspaceRoot, project\.name\);\n  if \(stopSchedulers\) \{\n    mediaTrackingScanScheduler\?\.stop\(\);/, 'workspace watcher teardown must always cancel scans for the previous workspace, while scheduler stop remains conditional');
  assert.match(watcherStart, /const watchWorkspace = \(root\) => \{\n  if \(watchedWorkspacePath === root && workspaceWatcher\) return;\n  stopWorkspaceWatcher\(\);/, 'switching workspaces must use non-terminal watcher teardown');
  assert.match(mainSource, /onQuit: \(\) => \{[\s\S]*?stopWorkspaceWatcher\(true\);/, 'final application shutdown must perform terminal scheduler teardown');
  console.log('media tracking scan scheduler tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
