const path = require('path');

const createThumbnailService = ({ pipeline, backgroundTasks }) => {
  const service = {
    request: async (request, restartTask = null) => {
      const run = () => backgroundTasks.run({
        ...(restartTask?.id ? { id: restartTask.id } : {}),
        type: 'thumbnail-generate',
        title: `生成缩略图：${path.basename(request.filePath)}`,
        metadata: { filePath: request.filePath, requestedSize: request.requestedSize },
      }, async task => {
        const cancelPipeline = () => pipeline.cancel(request.filePath, request.requestedSize);
        task.signal.addEventListener('abort', cancelPipeline, { once: true });
        try {
          task.report(10, '正在生成缩略图');
          return await pipeline.request(request);
        } finally {
          task.signal.removeEventListener('abort', cancelPipeline);
        }
      }, run);
      const execution = await run();
      return { ...execution.result, taskId: execution.task.id };
    },
    cancel: (filePath, requestedSize) => pipeline.cancel(filePath, requestedSize),
    noteForegroundActivity: () => pipeline.noteForegroundActivity(),
    indexDirectory: (...args) => pipeline.indexDirectory(...args),
    scanProject: (...args) => pipeline.scanProject(...args),
    inspectToolSources: (...args) => pipeline.inspectToolSources(...args),
    syncChangedPaths: (...args) => pipeline.syncChangedPaths(...args),
    invalidateDeleted: (...args) => pipeline.invalidateDeleted(...args),
    listCacheCleanupCandidates: (...args) => pipeline.listCacheCleanupCandidates(...args),
    cleanupOrphanCache: (...args) => pipeline.cleanupOrphanCache(...args),
    invalidateSources: (...args) => pipeline.invalidateSources(...args),
    pruneMissingSources: () => pipeline.pruneMissingSources(),
    stop: () => pipeline.stop(),
  };
  backgroundTasks.registerTypeRestartFactory?.('thumbnail-generate', task => service.request({ filePath: task.metadata?.filePath, requestedSize: task.metadata?.requestedSize }, task));
  return service;
};

module.exports = { createThumbnailService };
