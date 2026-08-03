const PHASE_MESSAGES = {
  scanning: '正在准备文件',
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
  concurrencyLimit = 2,
  cancellable = true,
  cancelledCode = 'FILE_OPERATION_CANCELLED',
  emitLegacyProgress = false,
}) => {
  const definition = {
    id: operationId,
    type: 'project-file-operation',
    title,
    message: '等待可用的磁盘任务名额',
    runningMessage: '正在准备文件',
    cancellable,
    concurrencyGroup,
    concurrencyLimit,
    resources,
    metadata: { operation, projectName, phase: 'queued' },
  };
  const handle = backgroundTasks?.create?.(definition) || null;
  const job = { cancelled: false, finishing: false, taskId: operationId };
  if (handle?.context?.signal) {
    handle.context.signal.addEventListener('abort', () => { job.cancelled = true; }, { once: true });
  }

  const publish = payload => {
    if (emitLegacyProgress && !event.sender.isDestroyed()) {
      event.sender.send('workspace-file-operation-progress', { operationId, operation, projectName, ...payload });
    }
    if (!handle || handle.deduplicated) return;
    const message = payload.currentName || PHASE_MESSAGES[payload.phase] || title;
    handle.context.report(payload.progress, message, {
      operation,
      projectName,
      phase: payload.phase,
      currentName: payload.currentName || '',
      bytesCopied: payload.bytesCopied,
      totalBytes: payload.totalBytes,
      filesCopied: payload.filesCopied,
      totalFiles: payload.totalFiles,
      processedCount: payload.processedCount,
      totalCount: payload.totalCount,
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
