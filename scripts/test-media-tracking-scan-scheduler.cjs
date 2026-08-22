const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createMediaTrackingScanScheduler } = require('../electron/services/media-tracking-scan-scheduler.cjs');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const run = async () => {
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
          metadata: { workspaceRoot: 'C:/workspace', projectName: 'Project', fullScan: false, mediaRescanPolicyVersion: 2 },
        },
      ],
      dismiss: id => { dismissedLegacyTasks.push(id); return true; },
      registerTypeRestartFactory: (_type, _factory, options) => { restartPolicy = options; return () => undefined; },
    },
    mediaScanService: { syncProject: async () => ({ thumbnailCandidates: [] }) },
    versionStaleDetectionService: { schedule: () => undefined, cancel: () => undefined },
    getProject: () => null,
  }).stop();
  assert.deepEqual(dismissedLegacyTasks, ['legacy-noise'], 'interrupted pre-v2 watcher rescans must be discarded instead of replaying a known task storm');
  assert.equal(restartPolicy.canRestart({ metadata: { workspaceRoot: 'C:/workspace', projectName: 'Project', fullScan: true } }), true, 'explicit legacy full scans must remain restartable');
  assert.equal(restartPolicy.canRestart({ metadata: { workspaceRoot: 'C:/workspace', projectName: 'Project', fullScan: false, mediaRescanPolicyVersion: 2 } }), true, 'v2 incremental work must remain restartable');
  assert.equal(restartPolicy.autoRestartDelayMs, 30000, 'restored media scans must yield startup priority to database maintenance');

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
  assert.equal(staleCalls.length, 2, 'every scheduled media change must also reach stale detection');
  assert.equal(scheduler.pendingCount(), 0);
  scheduler.stop();

  const missingStaleCalls = [];
  const missingScheduler = createMediaTrackingScanScheduler({
    backgroundTasks: createBackgroundTaskService({ eventBus: new EventEmitter() }),
    delayMs: 0,
    mediaScanService: { syncProject: async () => { throw new Error('missing projects must not scan'); } },
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
