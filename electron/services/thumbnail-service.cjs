const crypto = require('crypto');
const path = require('path');

const RECOVERY_TYPE = 'thumbnail-cache-recovery';
const MIGRATION_VERSION = 'thumbnail-cache-migration-v2';
const RECONCILIATION_VERSION = 'thumbnail-reconcile-publications-v1';
const ACTIVE_STATES = new Set(['queued', 'running', 'pausing', 'paused', 'resuming']);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accepted, failed) => { resolve = accepted; reject = failed; });
  return { promise, resolve, reject };
};

const createThumbnailService = ({ pipeline, backgroundTasks }) => {
  const recoveryRuns = new Map();
  const startupGeneration = crypto.randomUUID();
  let unregisterRecoveryRestart = null;

  const recoveryDescriptor = (cacheConfig = {}) => {
    const cacheRoot = path.resolve(pipeline.cacheDirectory(cacheConfig));
    const rootIdentity = process.platform === 'win32' ? cacheRoot.toLocaleLowerCase() : cacheRoot;
    const rootHash = crypto.createHash('sha256').update(rootIdentity).digest('hex');
    const migrationKey = MIGRATION_VERSION;
    const maintenanceKey = `${RECONCILIATION_VERSION}:${rootHash}`;
    return { cacheConfig, cacheRoot, migrationKey, maintenanceKey };
  };

  const startRecovery = (cacheConfig = {}, restartTask = null) => {
    const descriptor = recoveryDescriptor(cacheConfig);
    const admission = deferred();
    let admitted = false;
    let taskId = restartTask?.id || null;
    const admit = details => {
      if (admitted) return;
      admitted = true;
      admission.resolve({ taskId, maintenanceKey: descriptor.maintenanceKey, ...details });
    };
    const retryFactory = () => startRecovery(cacheConfig);
    const execution = backgroundTasks.start({
      ...(restartTask?.id ? { id: restartTask.id } : {}),
      type: RECOVERY_TYPE,
      title: '修复缩略图缓存索引',
      dedupeKey: `${RECOVERY_TYPE}:${descriptor.maintenanceKey}`,
      notificationPolicy: 'error-only',
      resumePolicy: 'safe-restart',
      cancellable: false,
      metadata: {
        cacheConfig, cacheRoot: descriptor.cacheRoot, migrationVersion: MIGRATION_VERSION,
        reconciliationVersion: RECONCILIATION_VERSION, migrationKey: descriptor.migrationKey, maintenanceKey: descriptor.maintenanceKey,
      },
    }, async task => {
      const cacheRoot = path.resolve(await pipeline.ensureCacheDirectory(cacheConfig));
      if (cacheRoot !== descriptor.cacheRoot) throw new Error('缩略图缓存目录在恢复入队前发生变化');
      const deadlineAt = Date.now() + 10 * 60 * 1000;
      let lastPhaseReportAt = 0;
      task.report(5, '正在检查缩略图缓存一致性', { maintenancePhase: 'startup-recovery', deadlineAt });
      const [migrationState, reconciliationState] = await Promise.all([
        pipeline.maintenanceState(descriptor.migrationKey),
        pipeline.maintenanceState(descriptor.maintenanceKey),
      ]);
      const previousCursor = reconciliationState.cursor && typeof reconciliationState.cursor === 'object'
        ? reconciliationState.cursor : {};
      if (previousCursor.generation === startupGeneration && Number(previousCursor.lastCompletedAt) > 0) {
        admit({ skipped: true });
        return { success: true, skipped: true, completedAt: previousCursor.lastCompletedAt, generation: startupGeneration };
      }
      const recoveryCursor = previousCursor.generation && !Number(previousCursor.lastCompletedAt)
        ? previousCursor
        : { generation: startupGeneration, generationMaxRowId: 0, afterRowId: 0, lastCompletedAt: 0, directory: {} };
      await pipeline.saveMaintenanceState(descriptor.maintenanceKey, recoveryCursor);
      const result = await pipeline.evictCache({
        cacheRoot,
        verifyIntegrity: !migrationState.completed,
        completeMigrationKey: migrationState.completed ? '' : descriptor.migrationKey,
        migrationVersion: MIGRATION_VERSION,
        migrationCursor: migrationState.cursor || {},
        recoverOrphans: true,
        scanRootOrphans: !String(cacheConfig?.directory || '').trim(),
        orphanBeforeMs: Date.now() - 24 * 60 * 60 * 1000,
        pruneMissing: true,
        failOnDeleteError: true,
        completeMaintenanceKey: descriptor.maintenanceKey,
        recoveryCursor,
        task,
        signal: task.signal,
        deadlineAt,
        onAdmitted: details => admit({ maintenance: details }),
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
    }, retryFactory);
    taskId = execution.task.id;
    const completion = execution.completion.then(result => {
      if (!admitted) admit({ completedBeforeAdmission: true });
      if (result.task.state === 'completed') backgroundTasks.dismiss(result.task.id);
      return result;
    }, error => {
      if (!admitted) admission.reject(error);
      throw error;
    }).finally(() => {
      if (recoveryRuns.get(descriptor.maintenanceKey)?.completion === completion) recoveryRuns.delete(descriptor.maintenanceKey);
    });
    const run = { ...execution, admitted: admission.promise, completion, descriptor };
    void completion.catch(() => undefined);
    recoveryRuns.set(descriptor.maintenanceKey, run);
    return run;
  };

  const activateStartupRecovery = () => {
    if (unregisterRecoveryRestart) return;
    unregisterRecoveryRestart = backgroundTasks.registerTypeRestartFactory?.(RECOVERY_TYPE, task => (
      startRecovery(task.metadata?.cacheConfig || {}, task)
    ), {
      canRestart: task => Boolean(task.metadata?.maintenanceKey && task.metadata?.cacheRoot),
      autoRestart: true,
      autoRestartDelayMs: 5000,
    }) || (() => undefined);
  };

  const ensureStartupRecovery = (cacheConfig = {}) => {
    const descriptor = recoveryDescriptor(cacheConfig);
    const existing = backgroundTasks.list().find(task => (
      task.type === RECOVERY_TYPE
      && task.metadata?.maintenanceKey === descriptor.maintenanceKey
      && (ACTIVE_STATES.has(task.state) || task.state === 'failed' || task.state === 'interrupted')
    ));
    if (!existing) return startRecovery(cacheConfig);
    if (ACTIVE_STATES.has(existing.state)) {
      const active = recoveryRuns.get(descriptor.maintenanceKey);
      return active || { task: existing, admitted: Promise.resolve({ taskId: existing.id, reused: true }), completion: null, descriptor };
    }
    if (existing.state === 'failed') {
      return { task: existing, admitted: Promise.resolve({ taskId: existing.id, failed: true, reused: true }), completion: null, descriptor };
    }
    const admitted = backgroundTasks.restart(existing.id).then(run => run?.admitted || { taskId: existing.id, restarted: true });
    return { task: existing, admitted, completion: null, descriptor };
  };

  const recoverCache = (cacheConfig = {}, restartTask = null) => startRecovery(cacheConfig, restartTask).completion;
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
    activateStartupRecovery,
    ensureStartupRecovery,
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
  return service;
};

module.exports = { createThumbnailService };
