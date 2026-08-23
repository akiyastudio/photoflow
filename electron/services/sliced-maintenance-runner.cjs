const defaultYield = delayMs => new Promise(resolve => setTimeout(resolve, delayMs));

const mergeNumericMetrics = (current, delta) => {
  const merged = { ...current };
  for (const [key, value] of Object.entries(delta || {})) {
    if (Number.isFinite(Number(value))) merged[key] = (Number(merged[key]) || 0) + Number(value);
  }
  return merged;
};

const runSlicedMaintenance = async ({
  task,
  initialState,
  initialMetrics = {},
  sliceDeadlineMs,
  yieldMs = 0,
  runSlice,
  mergeMetrics = mergeNumericMetrics,
  reportProgress = () => undefined,
  reportSliceMetrics = () => undefined,
  stateFingerprint = state => JSON.stringify(state),
  maxStalledSlices = 3,
  now = () => Date.now(),
  yieldBetweenSlices = defaultYield,
}) => {
  let state = initialState;
  let metrics = initialMetrics;
  let processedCount = 0;
  let firstSlice = true;
  let complete = false;
  let progress = 0;
  let sliceCount = 0;
  let stalledSlices = 0;

  const throwIfCancelled = () => {
    if (typeof task?.throwIfCancelled === 'function') task.throwIfCancelled();
    else if (task?.signal?.aborted) throw Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELLED' });
  };
  const report = (nextProgress, message, metadata) => {
    progress = Math.max(progress, Math.max(0, Math.min(100, Number(nextProgress) || 0)));
    task?.report?.(progress, message, metadata);
    return progress;
  };

  try {
    while (!complete) {
      throwIfCancelled();
      const deadlineAt = now() + Math.max(1, Number(sliceDeadlineMs) || 1);
      const sliceStartedAt = now();
      const previousFingerprint = stateFingerprint(state);
      const result = await runSlice({ state, firstSlice, deadlineAt, signal: task?.signal });
      throwIfCancelled();
      state = result?.nextState === undefined ? state : result.nextState;
      metrics = mergeMetrics(metrics, result?.metricsDelta || {});
      processedCount += Math.max(0, Number(result?.processedDelta) || 0);
      complete = result?.complete === true;
      const cursorAdvanced = typeof result?.cursorAdvanced === 'boolean'
        ? result.cursorAdvanced : stateFingerprint(state) !== previousFingerprint;
      const processedDelta = Math.max(0, Number(result?.processedDelta) || 0);
      stalledSlices = !complete && !cursorAdvanced && processedDelta === 0 ? stalledSlices + 1 : 0;
      sliceCount += 1;
      reportSliceMetrics({
        maintenanceSliceMs: Math.max(0, now() - sliceStartedAt),
        inspectedCount: Number(result?.metricsDelta?.recoveryInspectedCount || result?.metricsDelta?.inspectedCount) || 0,
        deletedCount: Number(result?.metricsDelta?.deletedCount) || 0,
        cursorAdvanced,
        pendingPhase: complete ? 'complete' : result?.phase || 'pending',
        foregroundWaitMs: Math.max(0, Number(result?.foregroundWaitMs) || 0),
      });
      reportProgress({ state, metrics, processedCount, phase: result?.phase, deadlineAt, complete, firstSlice, sliceCount, progress, report });
      if (stalledSlices >= Math.max(1, Number(maxStalledSlices) || 1)) {
        throw Object.assign(new Error(`maintenance made no progress for ${stalledSlices} consecutive slices`), { code: 'SLICED_MAINTENANCE_STALLED' });
      }
      firstSlice = false;
      if (!complete) {
        throwIfCancelled();
        await yieldBetweenSlices(yieldMs);
        throwIfCancelled();
      }
    }
    return { complete, state, metrics, processedCount, sliceCount, progress };
  } catch (error) {
    if (error && typeof error === 'object') {
      error.lastCommittedState = state;
      error.metrics = metrics;
      error.processedCount = processedCount;
      error.sliceCount = sliceCount;
    }
    throw error;
  }
};

module.exports = { runSlicedMaintenance, mergeNumericMetrics };
