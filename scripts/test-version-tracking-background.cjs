const assert = require('assert');
const { EventEmitter } = require('events');

const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createVersionStaleDetectionService } = require('../electron/services/version-stale-detection-service.cjs');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const remainsPending = async promise => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  return !settled;
};

async function testTrackingTaskLifecycle() {
  const service = createBackgroundTaskService({ eventBus: new EventEmitter() });
  const definition = (id, resource) => ({
    id,
    type: 'version-tracking',
    title: `tracking-${id}`,
    resources: [resource],
    concurrencyGroup: 'disk-io',
    concurrencyLimit: 1,
    cancellable: true,
    metadata: { sessionId: `session-${id}`, processedCount: 0, totalCount: 2, currentName: '' },
  });

  const running = service.create(definition('running', 'C:/project/a'));
  const queued = service.create(definition('queued', 'C:/project/b'));
  await running.waitForStart();
  const queuedStart = queued.waitForStart();
  assert.strictEqual(await remainsPending(queuedStart), true);
  assert.strictEqual(service.get('queued').state, 'queued');
  assert.strictEqual(service.cancel('queued'), true);
  await assert.rejects(queuedStart, error => error?.code === 'TASK_CANCELLED');
  queued.cancelled();
  assert.strictEqual(service.get('queued').state, 'cancelled');

  running.context.report(50, 'matching', { processedCount: 1, totalCount: 2, currentName: 'one.jpg' });
  assert.strictEqual(service.get('running').metadata.currentName, 'one.jpg');
  running.complete('waiting confirmation');
  assert.strictEqual(service.get('running').state, 'completed');

  const failed = service.create(definition('failed', 'C:/project/c'));
  await failed.waitForStart();
  failed.fail(new Error('compare failed'));
  assert.strictEqual(service.get('failed').state, 'failed');

  // There is no renderer/page ownership in the worker lifecycle. Removing all
  // event listeners cannot strand a main-process task in running state.
  const independentBus = new EventEmitter();
  const independent = createBackgroundTaskService({ eventBus: independentBus });
  independentBus.removeAllListeners();
  const result = await independent.run(definition('page-closed', 'C:/project/d'), async task => {
    task.report(75, 'still running');
    return 'done';
  });
  assert.strictEqual(result.task.state, 'completed');
}

async function testWatcherDebounce() {
  const calls = [];
  const stale = createVersionStaleDetectionService({
    delayMs: 10,
    versionService: {
      detectProgressStale: async (root, payload) => { calls.push({ root, payload }); },
    },
  });
  stale.schedule('C:/workspace', 'Project', ['C:/workspace/Project/a.jpg']);
  stale.schedule('C:/workspace', 'Project', ['C:/workspace/Project/b.jpg']);
  stale.schedule('C:/workspace', 'Project', ['C:/workspace/Project/a.jpg']);
  assert.strictEqual(stale.pendingCount(), 1);
  await wait(35);
  assert.strictEqual(calls.length, 1, 'merged watcher events must trigger one stale scan');
  assert.deepStrictEqual(new Set(calls[0].payload.changedPaths), new Set([
    require('path').resolve('C:/workspace/Project/a.jpg'),
    require('path').resolve('C:/workspace/Project/b.jpg'),
  ]));

  stale.schedule('C:/workspace', 'Project', ['C:/workspace/Project/c.jpg']);
  stale.schedule('C:/workspace', 'Project', [], true);
  await wait(35);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[1].payload.changedPaths, [], 'project reopen must request a full snapshot scan');
  stale.stop();

  let releaseRunningDetection;
  const runningDetectionGate = new Promise(resolve => { releaseRunningDetection = resolve; });
  const runningCalls = [];
  const rerun = createVersionStaleDetectionService({
    delayMs: 0,
    versionService: {
      detectProgressStale: async (root, payload) => {
        runningCalls.push({ root, payload });
        if (runningCalls.length === 1) await runningDetectionGate;
      },
    },
  });
  rerun.schedule('C:/workspace', 'Project', ['C:/workspace/Project/first.jpg']);
  await wait(20);
  assert.strictEqual(runningCalls.length, 1);
  rerun.schedule('C:/workspace', 'Project', ['C:/workspace/Project/second.jpg']);
  releaseRunningDetection();
  await wait(30);
  assert.strictEqual(runningCalls.length, 2, 'changes received during a stale scan must trigger one follow-up scan');
  assert.deepStrictEqual(runningCalls[1].payload.changedPaths, [require('path').resolve('C:/workspace/Project/second.jpg')]);
  rerun.stop();

  const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
  const blocker = backgroundTasks.create({
    id: 'database-blocker', type: 'test', title: 'database blocker',
    resources: [{ path: 'photoflow-workspace-database/C:/workspace', access: 'write' }],
  });
  await blocker.waitForStart();
  const coordinatedCalls = [];
  const coordinated = createVersionStaleDetectionService({
    delayMs: 0,
    backgroundTasks,
    versionService: {
      detectProgressStale: async (root, payload) => { coordinatedCalls.push({ root, payload }); },
    },
  });
  coordinated.schedule('C:/workspace', 'Project', [], true);
  await wait(20);
  assert.strictEqual(coordinatedCalls.length, 0, 'stale detection must wait for the shared workspace database writer');
  blocker.complete();
  await wait(20);
  assert.strictEqual(coordinatedCalls.length, 1);
  coordinated.stop();
}

async function main() {
  await testTrackingTaskLifecycle();
  await testWatcherDebounce();
  console.log('version tracking background task tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
