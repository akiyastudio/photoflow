const assert = require('assert/strict');
const { EventEmitter } = require('events');
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
  console.log('media tracking scan scheduler tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
