const path = require('path');
const crypto = require('crypto');
const { createDirtyCoalescingRunner } = require('./dirty-coalescing-runner.cjs');
const { createKeyedAdmissionQueue } = require('./keyed-admission-queue.cjs');
const { isMediaRelevantChange } = require('./watch-change-filter.cjs');
const { MEDIA_RESCAN_POLICY_VERSION } = require('./background-task-policy-versions.cjs');
const { MAX_CHANGED_PATHS } = require('../contracts/media-sync-limits.cjs');

const comparablePath = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);

const normalizeChange = value => typeof value === 'string'
  ? { path: path.resolve(value), eventType: 'rename', kind: 'missing' }
  : { ...value, path: path.resolve(String(value?.path || '')), eventType: value?.eventType === 'rename' ? 'rename' : 'change', kind: ['file', 'directory', 'missing'].includes(value?.kind) ? value.kind : 'missing' };

const coalesceMediaChanges = values => {
  const byPath = new Map();
  for (const raw of values || []) {
    const change = normalizeChange(raw);
    if (!change.path || !isMediaRelevantChange(change)) continue;
    const key = comparablePath(change.path);
    const previous = byPath.get(key);
    if (!previous || change.eventType === 'rename' || previous.eventType !== 'rename') byPath.set(key, previous && previous.eventType === 'rename' ? previous : change);
  }
  const ordered = [...byPath.values()].sort((left, right) => left.path.length - right.path.length);
  const collapsed = [];
  for (const change of ordered) {
    const covered = collapsed.some(parent => parent.kind === 'directory' && (() => {
      const relative = path.relative(parent.path, change.path);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    })());
    if (!covered) collapsed.push(change);
    if (collapsed.length > MAX_CHANGED_PATHS) throw new Error(`media_sync_paths_limit: 增量路径最多 ${MAX_CHANGED_PATHS} 条`);
  }
  return collapsed;
};

const mergeMediaScanBatch = (current, delta) => {
  const left = current || {};
  const right = delta || {};
  return {
    root: right.root || left.root,
    projectName: right.projectName || left.projectName,
    changes: coalesceMediaChanges([...(left.changes || left.changedPaths || []), ...(right.changes || right.changedPaths || [])]),
    fullScan: Boolean(left.fullScan || right.fullScan),
    snapshotId: right.snapshotId || left.snapshotId || crypto.randomUUID(),
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
  const replayKeyFor = (root, projectName, taskId) => `${keyFor(root, projectName)}\0replay:${String(taskId || crypto.randomUUID())}`;
  const workspaceKey = root => comparablePath(root);
  const workspaceAdmission = createKeyedAdmissionQueue();
  const admissionControllers = new Map();
  const replayKeysByProject = new Map();
  const cancellationEpochs = new Map();
  let stopped = false;
  let runner;

  const cancellationEpoch = key => cancellationEpochs.get(key) || 0;
  const trackReplayKey = (projectKey, replayKey) => {
    let keys = replayKeysByProject.get(projectKey);
    if (!keys) {
      keys = new Set();
      replayKeysByProject.set(projectKey, keys);
    }
    keys.add(replayKey);
  };
  const untrackReplayKey = (projectKey, replayKey) => {
    const keys = replayKeysByProject.get(projectKey);
    if (!keys) return;
    keys.delete(replayKey);
    if (!keys.size) replayKeysByProject.delete(projectKey);
  };

  const enqueueRetry = (key, batch, restartTask = null) => {
    const ticket = runner.enqueue(key, { ...batch, restartTask });
    return runner.flush(ticket);
  };

  const executeWrapper = async ({ key, batch }) => {
    const project = getProject(batch.root, batch.projectName);
    if (!project || project.availability === 'missing') {
      if (batch.restartTask?.id) throw new Error('项目目录尚未加载，自动索引将在目录可用后重试');
      return { skipped: true };
    }
    const projectPath = path.resolve(batch.root, project.relative_path);
    const controller = new AbortController();
    admissionControllers.set(key, controller);
    const admissionKey = workspaceKey(batch.root);
    let admitted = false;
    try {
      await workspaceAdmission.acquire(admissionKey, { signal: controller.signal });
      admitted = true;
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
        changedPaths: batch.changes.map(change => change.path), changes: batch.changes, fullScan: batch.fullScan,
        snapshotId: batch.snapshotId,
        mediaRescanPolicyVersion: MEDIA_RESCAN_POLICY_VERSION,
      },
    }, async task => {
      task.report(5, '正在扫描项目媒体文件');
      const result = batch.fullScan
        ? await mediaScanService.syncProject(batch.root, batch.projectName)
        : await mediaScanService.syncChangedPaths(batch.root, batch.projectName, batch.changes, [], { snapshotId: batch.snapshotId });
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
    } finally {
      if (admissionControllers.get(key) === controller) admissionControllers.delete(key);
      if (admitted) workspaceAdmission.release(admissionKey);
    }
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

  backgroundTasks?.registerTypeRestartFactory?.('version-media-rescan', async task => {
    const projectKey = keyFor(task.metadata?.workspaceRoot, task.metadata?.projectName);
    const replayKey = replayKeyFor(task.metadata?.workspaceRoot, task.metadata?.projectName, task.id);
    const epoch = cancellationEpoch(projectKey);
    trackReplayKey(projectKey, replayKey);
    try {
      const result = await enqueueRetry(replayKey, mergeMediaScanBatch(null, {
      root: task.metadata?.workspaceRoot, projectName: task.metadata?.projectName,
      changes: task.metadata?.changes || task.metadata?.changedPaths || [], fullScan: task.metadata?.fullScan !== false,
      snapshotId: task.metadata?.snapshotId,
      }), task);
      // Watcher events are not journaled across process downtime. A successful
      // immutable-manifest replay must therefore be followed by a fresh full
      // scan on the normal lane, using a newly generated snapshot id.
      if (!stopped && cancellationEpoch(projectKey) === epoch) {
        schedule(task.metadata?.workspaceRoot, task.metadata?.projectName, [], true);
      }
      return result;
    } finally {
      untrackReplayKey(projectKey, replayKey);
    }
  }, {
    canRestart: task => Boolean(task.metadata?.workspaceRoot && task.metadata?.projectName)
      && (task.metadata?.fullScan === true || Number(task.metadata?.mediaRescanPolicyVersion || 0) >= MEDIA_RESCAN_POLICY_VERSION),
    autoRestart: true,
    // Let startup catalog/database maintenance take the writer first. Restored
    // media work is recoverable and should not hold routine maintenance behind
    // a many-project replay wave.
    autoRestartDelayMs: 30000,
  });

  const schedule = (root, projectName, changes = [], fullScan = false) => {
    if (!projectName) return null;
    const project = getProject(root, projectName);
    if (!project || project.availability === 'missing') return null;
    const normalizedChanges = coalesceMediaChanges(changes);
    if (!fullScan && !normalizedChanges.length) return null;
    versionStaleDetectionService.schedule(root, projectName, normalizedChanges.map(change => change.path), fullScan);
    return runner.enqueue(keyFor(root, projectName), {
      root: path.resolve(root), projectName: String(projectName),
      changes: normalizedChanges, fullScan, snapshotId: crypto.randomUUID(),
    });
  };

  const cancel = (root, projectName) => {
    if (!projectName) return;
    const key = keyFor(root, projectName);
    cancellationEpochs.set(key, cancellationEpoch(key) + 1);
    admissionControllers.get(key)?.abort();
    runner.cancel(key);
    for (const replayKey of replayKeysByProject.get(key) || []) {
      admissionControllers.get(replayKey)?.abort();
      runner.cancel(replayKey);
    }
    replayKeysByProject.delete(key);
    versionStaleDetectionService.cancel(root, projectName);
  };

  const stop = () => {
    stopped = true;
    for (const controller of admissionControllers.values()) controller.abort();
    admissionControllers.clear();
    replayKeysByProject.clear();
    workspaceAdmission.stop();
    runner.stop();
  };

  return { schedule, cancel, stop, pendingCount: runner.pendingCount, flush: runner.flush, runner, workspaceAdmission };
};

module.exports = { coalesceMediaChanges, createMediaTrackingScanScheduler, mergeMediaScanBatch, MEDIA_RESCAN_POLICY_VERSION, MAX_CHANGED_PATHS };
