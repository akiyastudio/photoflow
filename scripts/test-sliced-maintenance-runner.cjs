const assert = require('assert');
const { createBatchedSliceMetricsReporter, runSlicedMaintenance } = require('../electron/services/sliced-maintenance-runner.cjs');

const task = signal => ({ signal, throwIfCancelled() { if (signal?.aborted) throw new Error('cancelled'); }, report() {} });

(async () => {
  const yields = [];
  const firstFlags = [];
  const states = [];
  const deadlines = [];
  const progress = [];
  const sliceMetrics = [];
  let clock = 100;
  const completed = await runSlicedMaintenance({
    task: task(), initialState: { cursor: 0 }, initialMetrics: { count: 0 }, sliceDeadlineMs: 20, yieldMs: 7,
    now: () => ++clock, yieldBetweenSlices: async value => yields.push(value),
    runSlice: async ({ state, firstSlice, deadlineAt }) => {
      states.push(state.cursor); firstFlags.push(firstSlice); deadlines.push(deadlineAt);
      return { complete: state.cursor === 2, nextState: { cursor: state.cursor + 1 }, metricsDelta: { count: 2 }, processedDelta: 3, phase: `p${state.cursor}`, ignoredPaths: new Array(10000).fill('x') };
    },
    reportProgress: ({ processedCount, report }) => { progress.push(report(50 - processedCount)); },
    reportSliceMetrics: metrics => sliceMetrics.push(metrics),
  });
  assert.deepStrictEqual(yields, [7, 7], 'three slices must yield exactly twice');
  assert.deepStrictEqual(firstFlags, [true, false, false], 'firstSlice must only be true once');
  assert.deepStrictEqual(states, [0, 1, 2], 'committed cursor must flow into the next slice');
  assert.deepStrictEqual(progress, [47, 47, 47], 'reported progress must never move backwards');
  assert.equal(new Set(deadlines).size, 3, 'every slice must have a new deadline');
  assert.equal(completed.sliceCount, 3, 'completion must not execute an extra slice');
  assert.deepStrictEqual(completed.metrics, { count: 6 }, 'numeric metrics must accumulate');
  assert.equal(sliceMetrics.length, 3);
  assert.deepStrictEqual(Object.keys(sliceMetrics[0]), ['maintenanceSliceMs', 'inspectedCount', 'deletedCount', 'cursorAdvanced', 'pendingPhase', 'foregroundWaitMs'], 'slice telemetry must contain only structured counts, timing and phase');
  assert.equal(JSON.stringify(completed).includes('ignoredPaths'), false, 'large path arrays returned outside metrics must not accumulate');

  const batchedLogs = [];
  let reporterClock = 0;
  const batchedReporter = createBatchedSliceMetricsReporter({
    writeLog: (level, message, details) => batchedLogs.push({ level, message, details }),
    context: { origin: 'test' },
    intervalMs: 30_000,
    now: () => reporterClock,
  });
  batchedReporter({ maintenanceSliceMs: 9, inspectedCount: 128, deletedCount: 0, cursorAdvanced: true, pendingPhase: 'orphan-recovery', foregroundWaitMs: 2 });
  reporterClock = 29_999;
  batchedReporter({ maintenanceSliceMs: 12, inspectedCount: 128, deletedCount: 1, cursorAdvanced: true, pendingPhase: 'orphan-recovery', foregroundWaitMs: 3 });
  assert.equal(batchedLogs.length, 0, 'normal slices inside the reporting window must not write individual logs');
  reporterClock = 30_000;
  batchedReporter({ maintenanceSliceMs: 7, inspectedCount: 64, deletedCount: 0, cursorAdvanced: false, pendingPhase: 'orphan-recovery', foregroundWaitMs: 0 });
  assert.deepStrictEqual(batchedLogs[0], {
    level: 'info', message: 'Thumbnail maintenance summary', details: {
      origin: 'test', windowMs: 30_000, sliceCount: 3, inspectedCount: 320, deletedCount: 1,
      cursorAdvancedCount: 2, pendingPhase: 'orphan-recovery', foregroundWaitMs: 5, maxSliceMs: 12, outcome: 'progress',
    },
  }, 'slice telemetry must be aggregated into a bounded periodic summary');
  reporterClock = 31_000;
  batchedReporter({ maintenanceSliceMs: 5, inspectedCount: 2, deletedCount: 0, cursorAdvanced: true, pendingPhase: 'complete', foregroundWaitMs: 0 });
  assert.equal(batchedLogs.length, 2, 'completion must flush the final partial reporting window');
  assert.equal(batchedLogs[1].details.outcome, 'complete');

  const failedLogs = [];
  const failedReporter = createBatchedSliceMetricsReporter({
    writeLog: (_level, _message, details) => failedLogs.push(details), now: () => 100,
  });
  await assert.rejects(runSlicedMaintenance({
    task: task(), initialState: {}, sliceDeadlineMs: 10, reportSliceMetrics: failedReporter,
    runSlice: async () => ({ complete: false, nextState: { cursor: 1 }, processedDelta: 1, metricsDelta: { inspectedCount: 1 } }),
    reportProgress: () => { throw new Error('progress failed'); },
  }), /progress failed/);
  assert.equal(failedLogs.length, 1, 'failed maintenance must flush its pending telemetry summary');
  assert.equal(failedLogs[0].outcome, 'failed');

  const mutationTelemetry = [];
  const mutableState = { cursor: 0 };
  await runSlicedMaintenance({
    task: task(), initialState: mutableState, sliceDeadlineMs: 10, yieldBetweenSlices: async () => undefined,
    runSlice: async ({ state }) => { state.cursor += 1; return { complete: state.cursor === 2, nextState: state }; },
    reportSliceMetrics: metrics => mutationTelemetry.push(metrics),
  });
  assert.deepStrictEqual(mutationTelemetry.map(metrics => metrics.cursorAdvanced), [true, true], 'in-place cursor mutation must be detected by state fingerprints');

  let stalledAttempts = 0;
  await assert.rejects(runSlicedMaintenance({
    task: task(), initialState: { cursor: 0 }, sliceDeadlineMs: 10, maxStalledSlices: 3,
    yieldBetweenSlices: async () => undefined,
    runSlice: async ({ state }) => { stalledAttempts += 1; return { complete: false, nextState: state, processedDelta: 0 }; },
  }), error => error.code === 'SLICED_MAINTENANCE_STALLED' && error.sliceCount === 3);
  assert.equal(stalledAttempts, 3, 'no-progress protection must terminate the runner after the configured consecutive slice limit');

  let fixedCursorSlices = 0;
  const fixedCursor = await runSlicedMaintenance({
    task: task(), initialState: { cursor: 'tail' }, sliceDeadlineMs: 10,
    yieldBetweenSlices: async () => undefined,
    runSlice: async ({ state }) => {
      fixedCursorSlices += 1;
      return {
        complete: fixedCursorSlices === 5,
        nextState: state,
        processedDelta: fixedCursorSlices <= 4 ? 2 : 0,
        metricsDelta: { orphanScanConsumedCount: fixedCursorSlices <= 4 ? 2 : 0, deletedCount: 0 },
      };
    },
  });
  assert.equal(fixedCursor.sliceCount, 5, 'more than three fixed-cursor scan-queue pages must not trip the stall fuse');
  assert.equal(fixedCursor.processedCount, 8, 'consumed scan entries count as progress even without deletion');

  let attempts = 0;
  await assert.rejects(runSlicedMaintenance({
    task: task(), initialState: { cursor: 0 }, sliceDeadlineMs: 10, yieldBetweenSlices: async () => undefined,
    runSlice: async ({ state }) => { attempts += 1; if (attempts === 2) throw Object.assign(new Error('slice failed'), { expectedState: state }); return { complete: false, nextState: { cursor: 1 } }; },
  }), error => error.lastCommittedState.cursor === 1 && error.expectedState.cursor === 1, 'failure must expose the last committed state');

  const controller = new AbortController();
  let cancelledSlices = 0;
  await assert.rejects(runSlicedMaintenance({
    task: task(controller.signal), initialState: {}, sliceDeadlineMs: 10,
    runSlice: async () => { cancelledSlices += 1; controller.abort(); return { complete: false, nextState: {} }; },
  }), /cancelled/);
  assert.equal(cancelledSlices, 1, 'cancellation must prevent the next slice');
  console.log('sliced maintenance runner tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
