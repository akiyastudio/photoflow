const path = require('path');
const { createDirtyCoalescingRunner } = require('./dirty-coalescing-runner.cjs');

const mergeMediaScanBatch = (current, delta) => {
  const left = current || {};
  const right = delta || {};
  return {
    root: right.root || left.root,
    projectName: right.projectName || left.projectName,
    changedPaths: new Set([...(left.changedPaths || []), ...(right.changedPaths || [])]),
    fullScan: Boolean(left.fullScan || right.fullScan),
    restartTask: right.restartTask || left.restartTask || null,
  };
};

const createMediaTrackingScanScheduler = ({
  backgroundTasks,
  mediaScanService,
  versionStaleDetectionService,
  getProject,
  onThumbnailCandidate = () => undefined,
  thumbnailPriority,
  writeLog = () => undefined,
  delayMs = 1500,
  runnerRetryDelays = undefined,
}) => {
  const keyFor = (root, projectName) => `${path.resolve(root).toLocaleLowerCase()}\0${String(projectName || '').toLocaleLowerCase()}`;
  let runner;

  const enqueueRetry = (key, batch, restartTask = null) => {
    const ticket = runner.enqueue(key, { ...batch, restartTask });
    return runner.flush(ticket);
  };

  const executeWrapper = async ({ key, batch }) => {
    const project = getProject(batch.root, batch.projectName);
    if (!project || project.availability === 'missing') return { skipped: true };
    const projectPath = path.resolve(batch.root, project.relative_path);
    const execution = await backgroundTasks.run({
      ...(batch.restartTask?.id ? { id: batch.restartTask.id } : {}),
      type: 'version-media-rescan',
      title: '更新版本媒体索引',
      concurrencyGroup: 'disk-io',
      concurrencyLimit: 3,
      concurrencyWriteLimit: 2,
      resourceAccess: 'read',
      cancellable: false,
      resources: [
        { path: projectPath, access: 'read' },
        { path: `photoflow-workspace-database/${batch.root}`, access: 'write' },
      ],
      metadata: {
        workspaceRoot: batch.root, projectName: batch.projectName, projectPath,
        changedPaths: [...batch.changedPaths], fullScan: batch.fullScan,
      },
    }, async task => {
      task.report(5, '正在扫描项目媒体文件');
      const result = await mediaScanService.syncProject(batch.root, batch.projectName);
      task.report(95, '正在完成版本媒体索引');
      return result;
    }, () => enqueueRetry(key, batch));
    // Candidate fan-out is part of the wrapper. Manual and automatic retries
    // therefore cannot report success while skipping thumbnail scheduling.
    for (const candidate of (execution.result?.thumbnailCandidates || []).slice(0, 750)) {
      onThumbnailCandidate({
        workspaceRoot: batch.root,
        photoId: candidate.photoId,
        versionId: candidate.versionId,
        filePath: candidate.filePath,
        priority: thumbnailPriority,
      });
    }
    return execution;
  };

  runner = createDirtyCoalescingRunner({
    merge: mergeMediaScanBatch,
    hasWork: batch => Boolean(batch?.root && batch?.projectName),
    worker: executeWrapper,
    delayMs,
    ...(runnerRetryDelays ? { retryDelays: runnerRetryDelays } : {}),
    onError: (error, context) => writeLog('warn', 'Media version tracking scan deferred', {
      projectName: context.batch?.projectName, retryAttempt: context.retryAttempt,
      willRetry: context.willRetry, error: error.message || String(error),
    }),
  });

  backgroundTasks?.registerTypeRestartFactory?.('version-media-rescan', task => enqueueRetry(
    keyFor(task.metadata?.workspaceRoot, task.metadata?.projectName),
    mergeMediaScanBatch(null, {
      root: task.metadata?.workspaceRoot, projectName: task.metadata?.projectName,
      changedPaths: task.metadata?.changedPaths || [], fullScan: task.metadata?.fullScan !== false,
    }),
    task,
  ), {
    canRestart: task => Boolean(task.metadata?.workspaceRoot && task.metadata?.projectName),
    autoRestart: true,
  });

  const schedule = (root, projectName, changedPaths = [], fullScan = false) => {
    if (!projectName) return null;
    versionStaleDetectionService.schedule(root, projectName, changedPaths, fullScan);
    const project = getProject(root, projectName);
    if (!project || project.availability === 'missing') return null;
    return runner.enqueue(keyFor(root, projectName), {
      root: path.resolve(root), projectName: String(projectName),
      changedPaths: changedPaths.map(value => path.resolve(value)), fullScan,
    });
  };

  const cancel = (root, projectName) => {
    if (!projectName) return;
    runner.cancel(keyFor(root, projectName));
    versionStaleDetectionService.cancel(root, projectName);
  };

  return { schedule, cancel, stop: runner.stop, pendingCount: runner.pendingCount, flush: runner.flush, runner };
};

module.exports = { createMediaTrackingScanScheduler, mergeMediaScanBatch };
