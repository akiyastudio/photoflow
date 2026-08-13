const PHASE_MESSAGES = {
  scanning: '正在统计',
  copying: '正在复制文件',
  moving: '正在移动文件',
  splitting: '正在分割视频',
  trashing: '正在移入回收站',
  finishing: '正在完成数据登记',
};

const createProjectFileTask = ({
  backgroundTasks,
  event,
  operationId,
  operation,
  title,
  projectName,
  resources = [],
  concurrencyGroup = 'disk-io',
  concurrencyLimit = 3,
  concurrencyWriteLimit = 2,
  cancellable = true,
  cancelledCode = 'FILE_OPERATION_CANCELLED',
  emitLegacyProgress = false,
}) => {
  const definition = {
    id: operationId,
    type: 'project-file-operation',
    title,
    message: '等待其他文件操作完成',
    runningMessage: '正在统计',
    cancellable,
    concurrencyGroup,
    concurrencyLimit,
    concurrencyWriteLimit,
    resourceAccess: 'write',
    resources,
    metadata: { operation, projectName, phase: 'queued' },
  };
  const handle = backgroundTasks?.create?.(definition) || null;
  const job = { cancelled: false, finishing: false, taskId: operationId };
  let highestProgress = 0;
  if (handle?.context?.signal) {
    handle.context.signal.addEventListener('abort', () => { job.cancelled = true; }, { once: true });
  }

  const publish = payload => {
    const requestedProgress = Math.max(0, Math.min(100, Number(payload.progress) || 0));
    const terminalFailure = payload.phase === 'failed' || payload.phase === 'cancelled';
    const progress = terminalFailure ? requestedProgress : Math.max(highestProgress, requestedProgress);
    if (!terminalFailure) highestProgress = progress;
    const monotonicPayload = { ...payload, progress };
    if (emitLegacyProgress && !event.sender.isDestroyed()) {
      event.sender.send('workspace-file-operation-progress', { operationId, operation, projectName, ...monotonicPayload });
    }
    if (!handle || handle.deduplicated) return;
    const message = monotonicPayload.currentName || PHASE_MESSAGES[monotonicPayload.phase] || title;
    handle.context.report(monotonicPayload.progress, message, {
      operation,
      projectName,
      phase: monotonicPayload.phase,
      currentName: monotonicPayload.currentName || '',
      bytesCopied: monotonicPayload.bytesCopied,
      totalBytes: monotonicPayload.totalBytes,
      filesCopied: monotonicPayload.filesCopied,
      totalFiles: monotonicPayload.totalFiles,
      processedCount: monotonicPayload.processedCount,
      totalCount: monotonicPayload.totalCount,
    });
  };

  return {
    job,
    publish,
    start: async nextResources => {
      if (Array.isArray(nextResources)) definition.resources = nextResources;
      if (!handle || handle.deduplicated) return;
      try {
        await handle.waitForStart();
      } catch (error) {
        if (handle.context.signal.aborted || error?.code === 'TASK_CANCELLED') {
          throw Object.assign(new Error('文件操作已取消'), { code: cancelledCode });
        }
        throw error;
      }
    },
    cancel: () => backgroundTasks?.cancel?.(operationId),
    complete: message => handle && !handle.deduplicated && handle.complete(message),
    fail: error => handle && !handle.deduplicated && handle.fail(error),
    cancelled: () => handle && !handle.deduplicated && handle.cancelled(),
    isFinished: () => !handle || handle.deduplicated || handle.isFinished(),
  };
};

module.exports = { createProjectFileTask };
