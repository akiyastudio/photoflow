const path = require('path');

const createThumbnailService = ({ pipeline, backgroundTasks }) => {
  const service = {
    request: async request => {
      const run = () => backgroundTasks.run({
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
    syncChangedPaths: (...args) => pipeline.syncChangedPaths(...args),
    invalidateDeleted: (...args) => pipeline.invalidateDeleted(...args),
    invalidateSources: (...args) => pipeline.invalidateSources(...args),
    pruneMissingSources: () => pipeline.pruneMissingSources(),
    stop: () => pipeline.stop(),
  };
  return service;
};

module.exports = { createThumbnailService };
