const crypto = require('crypto');
const path = require('path');

const createThumbnailService = ({ pipeline, backgroundTasks }) => {
  const recoverCache = (cacheConfig = {}, restartTask = null) => {
    const cacheRoot = pipeline.cacheDirectory(cacheConfig);
    const repairVersion = 'thumbnail-cache-recovery-v1';
    const rootIdentity = process.platform === 'win32' ? path.resolve(cacheRoot).toLocaleLowerCase() : path.resolve(cacheRoot);
    const maintenanceKey = `${repairVersion}:${crypto.createHash('sha256').update(rootIdentity).digest('hex')}`;
    const run = () => backgroundTasks.run({
      ...(restartTask?.id ? { id: restartTask.id } : {}),
      type: 'thumbnail-cache-recovery',
      title: '修复缩略图缓存索引',
      dedupeKey: `thumbnail-cache-recovery:${path.resolve(cacheRoot).toLocaleLowerCase()}`,
      notificationPolicy: 'error-only',
      cancellable: false,
      metadata: { cacheConfig, cacheRoot, repairVersion, maintenanceKey },
    }, async task => {
      const deadlineAt = Date.now() + 10 * 60 * 1000;
      let lastPhaseReportAt = 0;
      task.report(5, '正在检查缩略图缓存一致性', { maintenancePhase: 'startup-recovery', deadlineAt });
      const state = await pipeline.maintenanceState(maintenanceKey);
      if (state.completed) return { success: true, skipped: true, completedAt: state.completedAt };
      const result = await pipeline.evictCache({
        cacheRoot,
        verifyIntegrity: true,
        recoverOrphans: true,
        scanRootOrphans: !String(cacheConfig?.directory || '').trim(),
        // A second application instance may still be publishing recent staging
        // files. Only reclaim app-owned orphan files older than one day.
        orphanBeforeMs: Date.now() - 24 * 60 * 60 * 1000,
        pruneMissing: true,
        failOnDeleteError: true,
        completeMaintenanceKey: maintenanceKey,
        task,
        signal: task.signal,
        deadlineAt,
        onBlocked: ({ phase, processedCount }) => {
          if (Date.now() - lastPhaseReportAt < 250) return;
          lastPhaseReportAt = Date.now();
          task.report(Math.min(95, 5 + Math.floor(Number(processedCount || 0) / 64)), `缓存修复：${phase}，已处理 ${processedCount || 0} 条`, {
            maintenancePhase: phase,
            processedCount: processedCount || 0,
            deadlineAt,
          });
        },
      });
      task.report(100, `缓存索引修复完成：${result.repairedMissingCount || 0} 条缺失缓存，${result.deletedCount || 0} 个孤立文件`);
      return result;
    }, () => recoverCache(cacheConfig));
    return run().then(execution => {
      if (execution.task.state === 'completed') backgroundTasks.dismiss(execution.task.id);
      return execution;
    });
  };

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
    runDatabaseMaintenance: (worker, options) => pipeline.runDatabaseMaintenance(worker, options),
    recoverCache,
    evictCache: options => pipeline.evictCache(options),
    invalidateDeleted: (...args) => pipeline.invalidateDeleted(...args),
    listCacheCleanupCandidates: (...args) => pipeline.listCacheCleanupCandidates(...args),
    cleanupOrphanCache: (...args) => pipeline.cleanupOrphanCache(...args),
    invalidateSources: (...args) => pipeline.invalidateSources(...args),
    pruneMissingSources: () => pipeline.pruneMissingSources(),
    stop: () => pipeline.stop(),
  };
  backgroundTasks.registerTypeRestartFactory?.('thumbnail-generate', task => service.request({ filePath: task.metadata?.filePath, requestedSize: task.metadata?.requestedSize }, task));
  backgroundTasks.registerTypeRestartFactory?.('thumbnail-cache-recovery', task => recoverCache(task.metadata?.cacheConfig || {}, task), {
    canRestart: task => Boolean(task.metadata?.cacheRoot || task.metadata?.cacheConfig),
    autoRestart: true,
    autoRestartDelayMs: 5000,
  });
  return service;
};

module.exports = { createThumbnailService };
