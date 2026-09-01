const assert = require('assert/strict');
const { createDirtyCoalescingRunner } = require('../electron/services/dirty-coalescing-runner.cjs');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const merge = (current, delta) => ({
  paths: new Set([...(current?.paths || []), ...(delta?.paths || [])]),
  fullScan: Boolean(current?.fullScan || delta?.fullScan),
});

const run = async () => {
  const firstStarted = deferred();
  const releaseFailure = deferred();
  const batches = [];
  let attempts = 0;
  const runner = createDirtyCoalescingRunner({
    merge,
    hasWork: batch => Boolean(batch?.fullScan || batch?.paths?.size),
    delayMs: 0,
    retryDelays: [5],
    worker: async ({ batch }) => {
      attempts += 1;
      batches.push({ fullScan: batch.fullScan, paths: [...batch.paths] });
      if (attempts === 1) {
        firstStarted.resolve();
        await releaseFailure.promise;
        throw new Error('first attempt failed');
      }
      return `attempt-${attempts}`;
    },
  });
  const firstTicket = runner.enqueue('project', { paths: ['a.jpg'], fullScan: false });
  const firstFlush = runner.flush(firstTicket);
  await firstStarted.promise;
  const fullTicket = runner.enqueue('project', { paths: ['b.jpg'], fullScan: true });
  let state = runner.getState('project');
  assert(state.inFlightBatch.paths.has('a.jpg'));
  assert(state.pendingBatch.paths.has('b.jpg'));
  releaseFailure.resolve();
  assert.equal(await firstFlush, 'attempt-2');
  assert.equal(await runner.flush(fullTicket), 'attempt-2');
  assert.deepEqual(batches, [
    { fullScan: false, paths: ['a.jpg'] },
    { fullScan: true, paths: ['a.jpg', 'b.jpg'] },
  ], 'failed in-flight work and fullScan must merge back into pending before retry');
  state = runner.getState('project');
  assert.equal(state.pendingBatch, null);
  assert.equal(state.inFlightBatch, null);
  assert.equal(state.completedGeneration, 2);
  assert.equal(state.executionPromise, null);
  assert.equal(state.retryTimer, null);

  const successGate = deferred();
  const followups = [];
  let successCalls = 0;
  const rerun = createDirtyCoalescingRunner({
    merge,
    hasWork: batch => Boolean(batch?.paths?.size),
    delayMs: 0,
    worker: async ({ batch }) => {
      successCalls += 1;
      followups.push([...batch.paths]);
      if (successCalls === 1) await successGate.promise;
    },
  });
  const runningTicket = rerun.enqueue('project', { paths: ['first.jpg'] });
  const runningFlush = rerun.flush(runningTicket);
  await wait(0);
  const followupTicket = rerun.enqueue('project', { paths: ['second.jpg'] });
  successGate.resolve();
  await runningFlush;
  await rerun.flush(followupTicket);
  assert.deepEqual(followups, [['first.jpg'], ['second.jpg']], 'changes received during success remain pending for a follow-up run');
  assert.equal(rerun.cancel('project'), true);
  runner.stop();
  assert.throws(() => runner.enqueue('project', { paths: ['late.jpg'] }), error => error.code === 'DIRTY_RUNNER_STOPPED', 'stop must permanently reject late enqueue calls');
  console.log('dirty coalescing runner tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
