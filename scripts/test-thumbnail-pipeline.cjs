const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ThumbnailPipeline, PRIORITY, isThumbnailSizeSufficient } = require('../electron/thumbnail-pipeline.cjs');

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(124), Buffer.from([0xff, 0xd9])]);

const createPipeline = ({ root, target, generate, toPreviewUrl = filePath => filePath, notify = () => undefined, log = () => undefined, sourceStabilityDelayMs = 20, sourceStabilityProbeMs = 10, maxBackgroundTasks }) => {
  const pipeline = new ThumbnailPipeline({
    getRunConfig: () => { throw new Error('database service must not start during this test'); },
    databasePath: path.join(root, 'thumbnail-index.sqlite3'),
    getCacheDir: () => root,
    cacheFilePath: () => target,
    generateThumbnailSet: generate,
    toPreviewUrl,
    trimCache: () => undefined,
    notify,
    log,
    concurrency: 1,
    ...(maxBackgroundTasks === undefined ? {} : { maxBackgroundTasks }),
    sourceStabilityDelayMs,
    sourceStabilityProbeMs,
  });
  pipeline.database.call = async (operation, args = {}) => {
    if (operation === 'capture_thumbnail_publish') {
      const stat = fs.statSync(args.file_path);
      return { cacheEpoch: 1, sourceVersion: 1, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs };
    }
    if (operation === 'get_cache_epoch') return { cacheEpoch: 1 };
    if (operation === 'get_thumbnail_publish') return fs.existsSync(target) ? { thumbnailPath: target } : null;
    if (operation === 'commit_thumbnail_publish') return { state: 'READY', cacheEpoch: 1, sourceVersion: 1 };
    return { success: true };
  };
  return pipeline;
};

const waitForTerminalState = (run, timeoutMs = 2000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('thumbnail test timed out')), timeoutMs);
  run(update => {
    if (!['READY', 'FAILED', 'MISSING'].includes(update.state)) return;
    clearTimeout(timer);
    resolve(update);
  });
});

const run = async () => {
  assert.equal(isThumbnailSizeSufficient(64, 96, 320), false, 'a 96px Shell image must not populate the 320px tier');
  assert.equal(isThumbnailSizeSufficient(64, 96, 640), false, 'a 96px Shell image must not populate the 640px tier');
  assert.equal(isThumbnailSizeSufficient(427, 640, 640), true, 'a full 640px thumbnail should be accepted');
  assert.equal(isThumbnailSizeSufficient(512, 384, 640), true, 'a provider may return a slightly smaller but still useful thumbnail');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-thumbnail-test-'));
  try {
    const source = path.join(temporaryRoot, 'source.jpg');
    fs.writeFileSync(source, 'source');

    const retryTarget = path.join(temporaryRoot, 'retry.jpg');
    let attempts = 0;
    let retryNotify = () => undefined;
    const retryPipeline = createPipeline({
      root: temporaryRoot,
      target: retryTarget,
      notify: update => retryNotify(update),
      generate: async (_filePath, _stat, _kind, _config, sizes) => {
        attempts += 1;
        fs.writeFileSync(retryTarget, jpeg);
        if (attempts === 1) fs.unlinkSync(retryTarget);
        return sizes.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: retryTarget }));
      },
    });
    const retryResult = await waitForTerminalState(notify => {
      retryNotify = notify;
      void retryPipeline.request({ filePath: source, kind: 'image', requestedSize: 640, priority: PRIORITY.visible });
    });
    assert.equal(retryResult.state, 'READY');
    assert.equal(attempts, 2, 'a vanished cache output should be regenerated exactly once');
    assert.equal(fs.existsSync(retryTarget), true);
    retryPipeline.stop();

    const stagedTarget = path.join(temporaryRoot, 'staged-final.jpg');
    const publishOrder = [];
    const stagingPaths = [];
    let stagedNotify = () => undefined;
    const stagedPipeline = createPipeline({
      root: temporaryRoot,
      target: stagedTarget,
      notify: update => {
        if (update.state === 'READY') publishOrder.push('ready');
        stagedNotify(update);
      },
      generate: async (_filePath, _stat, _kind, _config, sizes) => {
        for (const size of sizes) {
          stagingPaths.push(size.path);
          fs.writeFileSync(size.path, jpeg);
        }
        return sizes.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: size.path }));
      },
    });
    stagedPipeline.database.call = async (operation, args = {}) => {
      if (operation === 'capture_thumbnail_publish') {
        const sourceStat = fs.statSync(args.file_path);
        return { cacheEpoch: 7, sourceVersion: 3, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs };
      }
      if (operation === 'get_cache_epoch') return { cacheEpoch: 7 };
      if (operation === 'commit_thumbnail_publish') {
        assert.equal(fs.existsSync(args.thumbnails[0].path), true, 'final file must exist before DB commit');
        publishOrder.push('commit');
        return { state: 'READY' };
      }
      return { success: true };
    };
    const stagedResult = await waitForTerminalState(notify => {
      stagedNotify = notify;
      void stagedPipeline.request({ filePath: source, kind: 'image', requestedSize: 640, priority: PRIORITY.visible });
    });
    assert.equal(stagedResult.state, 'READY');
    assert.deepEqual(publishOrder, ['commit', 'ready'], 'DB publish commit must precede READY');
    assert(stagingPaths.every(value => path.basename(path.dirname(value)) === '.staging'));
    assert.equal(fs.existsSync(stagedTarget), true);
    assert.equal(fs.readdirSync(path.join(temporaryRoot, '.staging')).length, 0, 'successful publish must consume staging files');
    stagedPipeline.stop();

    const rejectedTarget = path.join(temporaryRoot, 'rejected-final.jpg');
    const rejectedNotifications = [];
    const rejectedPublishIds = [];
    let rejectedNotify = () => undefined;
    const rejectedPipeline = createPipeline({
      root: temporaryRoot,
      target: rejectedTarget,
      notify: update => { rejectedNotifications.push(update); rejectedNotify(update); },
      generate: async (_filePath, _stat, _kind, _config, sizes) => {
        for (const size of sizes) fs.writeFileSync(size.path, jpeg);
        return sizes.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: size.path }));
      },
    });
    rejectedPipeline.database.call = async (operation, args = {}) => {
      if (operation === 'capture_thumbnail_publish') {
        const sourceStat = fs.statSync(args.file_path);
        return { cacheEpoch: 1, sourceVersion: 1, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs };
      }
      if (operation === 'get_cache_epoch') return { cacheEpoch: 1 };
      if (operation === 'commit_thumbnail_publish') {
        rejectedPublishIds.push(args.publish_id);
        throw new Error('simulated commit failure');
      }
      if (operation === 'resolve_thumbnail_publish') return { state: 'NOT_FOUND', committed: false };
      return { success: true };
    };
    const rejectedResult = await waitForTerminalState(notify => {
      rejectedNotify = notify;
      void rejectedPipeline.request({ filePath: source, kind: 'image', requestedSize: 640, priority: PRIORITY.visible });
    });
    assert.equal(rejectedResult.state, 'FAILED');
    assert.equal(rejectedNotifications.some(update => update.state === 'READY'), false, 'commit failure must never notify READY');
    assert.equal(fs.existsSync(rejectedTarget), true, 'an unresolved commit failure must preserve the final as an orphan');
    assert(rejectedPublishIds.length > 1, 'a missing receipt must retry the commit');
    assert.equal(new Set(rejectedPublishIds).size, 1, 'ambiguous retries must reuse the exact publish ID');
    rejectedPipeline.stop();

    const unknownTarget = path.join(temporaryRoot, 'unknown-final.jpg');
    let unknownNotify = () => undefined;
    const unknownPipeline = createPipeline({
      root: temporaryRoot,
      target: unknownTarget,
      notify: update => unknownNotify(update),
      generate: async (_filePath, _stat, _kind, _config, sizes) => {
        for (const size of sizes) fs.writeFileSync(size.path, jpeg);
        return sizes.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: size.path }));
      },
    });
    unknownPipeline.database.call = async (operation, args = {}) => {
      if (operation === 'capture_thumbnail_publish') {
        const sourceStat = fs.statSync(args.file_path);
        return { cacheEpoch: 1, sourceVersion: 1, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs };
      }
      if (operation === 'get_cache_epoch') return { cacheEpoch: 1 };
      if (operation === 'commit_thumbnail_publish') throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
      return { success: true };
    };
    unknownPipeline.resolveThumbnailPublish = async () => null;
    const unknownResult = await waitForTerminalState(notify => {
      unknownNotify = notify;
      void unknownPipeline.request({ filePath: source, kind: 'image', requestedSize: 640, priority: PRIORITY.visible });
    });
    assert.equal(unknownResult.state, 'FAILED');
    assert.equal(fs.existsSync(unknownTarget), true, 'unresolved ambiguous commit must preserve a safe orphan');
    unknownPipeline.stop();

    const epochTarget = path.join(temporaryRoot, 'epoch-final.jpg');
    let epochCapture = 0;
    let epochGeneration = 0;
    let epochNotify = () => undefined;
    const epochPipeline = createPipeline({
      root: temporaryRoot,
      target: epochTarget,
      notify: update => epochNotify(update),
      generate: async (_filePath, _stat, _kind, _config, sizes) => {
        epochGeneration += 1;
        for (const size of sizes) fs.writeFileSync(size.path, jpeg);
        return sizes.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: size.path }));
      },
    });
    epochPipeline.database.call = async (operation, args = {}) => {
      if (operation === 'capture_thumbnail_publish') {
        epochCapture += 1;
        const sourceStat = fs.statSync(args.file_path);
        return { cacheEpoch: epochCapture, sourceVersion: 1, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs };
      }
      if (operation === 'get_cache_epoch') return { cacheEpoch: 2 };
      if (operation === 'commit_thumbnail_publish') return { state: 'READY' };
      return { success: true };
    };
    const epochResult = await waitForTerminalState(notify => {
      epochNotify = notify;
      void epochPipeline.request({ filePath: source, kind: 'image', requestedSize: 640, priority: PRIORITY.visible });
    });
    assert.equal(epochResult.state, 'READY');
    assert.equal(epochGeneration, 2, 'EPOCH_STALE must regenerate under the fresh epoch');
    assert.equal(fs.existsSync(epochTarget), true);
    epochPipeline.stop();

    const protectedTarget = path.join(temporaryRoot, 'protected.jpg');
    fs.writeFileSync(protectedTarget, Buffer.alloc(16));
    const protectedPipeline = createPipeline({
      root: temporaryRoot,
      target: protectedTarget,
      generate: async () => [],
    });
    protectedPipeline.schedulePump = () => undefined;
    protectedPipeline.enqueue({ filePath: source, kind: 'image', cacheConfig: {}, requestedSizes: [{ label: 'medium', pixels: 640 }] }, PRIORITY.visible);
    const queued = await protectedPipeline.request({ filePath: source, kind: 'image', requestedSize: 640, priority: PRIORITY.visible });
    assert.equal(queued.state, 'QUEUED');
    assert.equal(fs.existsSync(protectedTarget), true, 'a reader must not delete output owned by an in-flight task');
    protectedPipeline.stop();

    const cachedTarget = path.join(temporaryRoot, 'cached.jpg');
    fs.writeFileSync(cachedTarget, jpeg);
    let grants = 0;
    const cachedPipeline = createPipeline({
      root: temporaryRoot,
      target: cachedTarget,
      generate: async () => [],
      toPreviewUrl: filePath => `preview://${++grants}/${path.basename(filePath)}`,
    });
    const diskHit = await cachedPipeline.request({ filePath: source, kind: 'image', requestedSize: 640, priority: PRIORITY.visible });
    const memoryHit = await cachedPipeline.request({ filePath: source, kind: 'image', requestedSize: 640, priority: PRIORITY.visible });
    assert.equal(diskHit.cacheLayer, 'disk');
    assert.equal(memoryHit.cacheLayer, 'memory');
    assert.notEqual(memoryHit.previewUrl, diskHit.previewUrl, 'a memory hit must issue a fresh media URL instead of reusing an expiring grant');
    assert.equal(grants, 2);
    cachedPipeline.stop();

    const saturatedTarget = path.join(temporaryRoot, 'saturated.jpg');
    const saturatedPipeline = createPipeline({
      root: temporaryRoot,
      target: saturatedTarget,
      maxBackgroundTasks: 0,
      generate: async () => [],
    });
    saturatedPipeline.schedulePump = () => undefined;
    const rejectedBackground = await saturatedPipeline.request({ filePath: source, kind: 'image', requestedSize: 320, priority: PRIORITY.directory });
    assert.equal(rejectedBackground.success, false);
    assert.equal(rejectedBackground.state, 'NOT_READY', 'a saturated background queue must not claim that a dropped request is queued');
    assert.equal(saturatedPipeline.tasks.size, 0, 'a rejected background request must not leave a phantom task');
    const acceptedNearby = await saturatedPipeline.request({ filePath: source, kind: 'image', requestedSize: 320, priority: PRIORITY.nearby });
    assert.equal(acceptedNearby.state, 'QUEUED', 'visible and nearby work must bypass the background task cap');
    assert.equal(saturatedPipeline.tasks.size, 1);
    saturatedPipeline.stop();

    const directoryTarget = path.join(temporaryRoot, 'directory-target.jpg');
    let directoryGenerationCount = 0;
    const directoryPipeline = createPipeline({
      root: temporaryRoot,
      target: directoryTarget,
      generate: async () => { directoryGenerationCount += 1; return []; },
    });
    directoryPipeline.lastForegroundActivityAt = 0;
    let directoryQueuedCount = 0;
    const originalDirectoryEnqueue = directoryPipeline.enqueue.bind(directoryPipeline);
    directoryPipeline.enqueue = (...args) => { directoryQueuedCount += 1; return originalDirectoryEnqueue(...args); };
    await directoryPipeline.runDirectoryIndex(temporaryRoot, temporaryRoot, [{ path: source, kind: 'image' }], {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(directoryQueuedCount, 0, 'opening a directory must not queue every uncached source for hidden thumbnail warming');
    assert.equal(directoryGenerationCount, 0, 'directory indexing must stay metadata-only until a tile becomes visible');
    directoryPipeline.stop();

    const maintenancePipeline = createPipeline({
      root: temporaryRoot,
      target: path.join(temporaryRoot, 'maintenance.jpg'),
      generate: async () => [],
    });
    maintenancePipeline.lastForegroundActivityAt = 0;
    let releaseMaintenance;
    let maintenanceEntered = false;
    const maintenanceGate = new Promise(resolve => { releaseMaintenance = resolve; });
    const maintenanceRun = maintenancePipeline.runDatabaseMaintenance(async () => {
      maintenanceEntered = true;
      await maintenanceGate;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(maintenanceEntered, true);
    const deferredScan = maintenancePipeline.scanProject(temporaryRoot, {});
    assert.equal(maintenancePipeline.activeProjectScans, 0, 'cache maintenance must prevent a new project index writer from starting');
    assert.equal(maintenancePipeline.projectScanQueue.length, 1, 'a project scan requested during cache maintenance must remain queued');
    const queuedScan = maintenancePipeline.projectScanQueue.shift();
    maintenancePipeline.projectScans.delete(path.resolve(temporaryRoot));
    queuedScan.resolve(undefined);
    releaseMaintenance();
    await Promise.all([maintenanceRun, deferredScan]);
    const maintenanceCalls = [];
    maintenancePipeline.database.call = async (...args) => { maintenanceCalls.push(args); return { success: true }; };
    await maintenancePipeline.invalidateDeleted([], null);
    assert(maintenanceCalls[0][2] <= 10 * 60 * 1000 && maintenanceCalls[0][2] > 9 * 60 * 1000, 'cache index invalidation must use the remaining maintenance deadline instead of the interactive 30 second timeout');
    maintenancePipeline.stop();

    const cooperativePipeline = createPipeline({
      root: temporaryRoot,
      target: path.join(temporaryRoot, 'cooperative-unused.jpg'),
      generate: async () => [],
    });
    let recoveryPages = 0;
    cooperativePipeline.database.call = async operation => {
      if (operation === 'begin_cache_maintenance') return { cacheEpoch: 2 };
      if (operation === 'recover_cache_publications') {
        recoveryPages += 1;
        await new Promise(resolve => setTimeout(resolve, 40));
        return {
          done: recoveryPages === 4,
          cursor: { generation: 'cooperative', generationMaxRowId: -1, afterRowId: 0, lastCompletedAt: 0, directory: { rootIndex: 0 } },
          repairedMissingCount: 0,
          inspectedCount: 0,
          orphanScanConsumedCount: 1,
          orphanPaths: [],
        };
      }
      return { success: true };
    };
    let cooperativeMaintenanceDone = false;
    const cooperativeMaintenance = cooperativePipeline.evictCache({
      cacheRoot: temporaryRoot,
      recoverOrphans: true,
      deadlineAt: Date.now() + 2000,
    }).then(result => { cooperativeMaintenanceDone = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 5));
    const foregroundStartedAt = Date.now();
    await cooperativePipeline.coordinator.withPublisher(async () => undefined);
    const foregroundLatencyMs = Date.now() - foregroundStartedAt;
    assert.equal(cooperativeMaintenanceDone, false, 'foreground publication must finish before four-page maintenance completes');
    const cooperativeResult = await cooperativeMaintenance;
    assert.equal(cooperativeResult.orphanScanConsumedCount, 4);
    console.log(`thumbnail maintenance foreground evidence: latency=${foregroundLatencyMs}ms pages=${recoveryPages} maintenanceCompletedAfterForeground=true`);
    cooperativePipeline.stop();

    const failedDeletePath = path.join(temporaryRoot, 'delete-failure.jpg');
    fs.writeFileSync(failedDeletePath, jpeg);
    const evictionPipeline = createPipeline({
      root: temporaryRoot,
      target: path.join(temporaryRoot, 'eviction-unused.jpg'),
      generate: async () => [],
    });
    const evictionOrder = [];
    evictionPipeline.database.call = async operation => {
      if (operation === 'begin_cache_maintenance') { evictionOrder.push('begin'); return { cacheEpoch: 2 }; }
      if (operation === 'detach_cache_batch') {
        evictionOrder.push('detach');
        return { done: true, detachedCount: 1, detachedBytes: jpeg.length, thumbnailPaths: [failedDeletePath] };
      }
      if (operation === 'prepare_thumbnail_deletions') return { deletablePaths: [failedDeletePath], indexedPaths: [] };
      return { success: true };
    };
    const originalUnlink = fs.promises.unlink;
    let rejectDelete = true;
    fs.promises.unlink = async filePath => {
      if (rejectDelete && path.resolve(filePath) === path.resolve(failedDeletePath)) {
        rejectDelete = false;
        evictionOrder.push('unlink-failed');
        throw Object.assign(new Error('simulated delete failure'), { code: 'EPERM' });
      }
      evictionOrder.push('unlink-retry');
      return originalUnlink(filePath);
    };
    try {
      const failedEviction = await evictionPipeline.evictCache({ thumbnailPaths: [failedDeletePath] });
      assert.deepEqual(evictionOrder.slice(0, 3), ['begin', 'detach', 'unlink-failed'], 'index detach must commit before physical deletion');
      assert.equal(failedEviction.failedCount, 1);
      assert.equal(fs.existsSync(failedDeletePath), true, 'failed unlink must leave an unindexed orphan');
      const retriedEviction = await evictionPipeline.evictCache({ thumbnailPaths: [failedDeletePath] });
      assert.equal(retriedEviction.deletedCount, 1);
      assert.equal(fs.existsSync(failedDeletePath), false, 'a later unified eviction retries the orphan path');
    } finally {
      fs.promises.unlink = originalUnlink;
      evictionPipeline.stop();
    }

    const safeCacheRoot = path.join(temporaryRoot, 'safe-cache-root');
    fs.mkdirSync(safeCacheRoot);
    const outsideManagedName = path.join(temporaryRoot, `${'b'.repeat(64)}.jpg`);
    const userJpeg = path.join(safeCacheRoot, 'holiday.jpg');
    fs.writeFileSync(outsideManagedName, jpeg);
    fs.writeFileSync(userJpeg, jpeg);
    const unsafePipeline = createPipeline({
      root: temporaryRoot,
      target: path.join(safeCacheRoot, `${'c'.repeat(64)}.jpg`),
      generate: async () => [],
    });
    const unsafeOperations = [];
    unsafePipeline.database.call = async (operation, args) => {
      unsafeOperations.push(operation);
      if (operation === 'begin_cache_maintenance') return { cacheEpoch: 3 };
      if (operation === 'detach_cache_batch') return {
        done: true,
        detachedCount: 2,
        detachedBytes: jpeg.length * 2,
        thumbnailPaths: [outsideManagedName, userJpeg],
      };
      if (operation === 'prepare_thumbnail_deletions') return { deletablePaths: args.thumbnail_paths, indexedPaths: [] };
      return { success: true };
    };
    const unsafeResult = await unsafePipeline.evictCache({
      cacheRoot: safeCacheRoot,
      thumbnailPaths: [outsideManagedName, userJpeg],
    });
    assert.equal(unsafeResult.failedCount, 2);
    assert.equal(fs.existsSync(outsideManagedName), true, 'a corrupted cache index must never delete a path outside the approved cache root');
    assert.equal(fs.existsSync(userJpeg), true, 'a non-PhotoFlow JPEG inside a custom cache root must never be deleted');
    unsafeOperations.length = 0;
    await assert.rejects(unsafePipeline.evictCache({
      cacheRoot: safeCacheRoot,
      thumbnailPaths: [outsideManagedName, userJpeg],
      failOnDeleteError: true,
      completeMaintenanceKey: 'must-not-complete',
    }), error => error.code === 'THUMBNAIL_CACHE_RECOVERY_INCOMPLETE');
    assert(!unsafeOperations.includes('maintenance_state_complete'), 'an incomplete recovery must never write its completion marker');
    unsafePipeline.stop();

    const startupRecoveryPipeline = createPipeline({
      root: safeCacheRoot,
      target: path.join(safeCacheRoot, `${'d'.repeat(64)}.jpg`),
      generate: async () => [],
    });
    const startupRecoveryOrder = [];
    startupRecoveryPipeline.database.call = async operation => {
      startupRecoveryOrder.push(operation);
      if (operation === 'check_integrity') return { success: true, result: 'ok' };
      if (operation === 'begin_cache_maintenance') return { cacheEpoch: 4 };
      if (operation === 'prune_missing_batch') return { done: true, sourceCount: 0, thumbnailPaths: [] };
      if (operation === 'recover_cache_publications') return { done: true, repairedMissingCount: 0, orphanPaths: [] };
      if (operation === 'maintenance_state_complete') return { success: true };
      return { success: true };
    };
    await startupRecoveryPipeline.evictCache({
      cacheRoot: safeCacheRoot,
      verifyIntegrity: true,
      recoverOrphans: true,
      scanRootOrphans: false,
      pruneMissing: true,
      completeMaintenanceKey: 'startup-recovery-test',
    });
    assert(startupRecoveryOrder.indexOf('check_integrity') < startupRecoveryOrder.indexOf('begin_cache_maintenance'), 'quick_check must run under the exclusive lease before epoch mutation');
    assert.equal(startupRecoveryOrder.at(-1), 'maintenance_state_complete', 'the completion marker must be the final successful database write');
    startupRecoveryPipeline.stop();

    const cancelledPipeline = createPipeline({
      root: temporaryRoot,
      target: path.join(temporaryRoot, 'cancelled-unused.jpg'),
      generate: async () => [],
    });
    const cancellationController = new AbortController();
    let detachCalls = 0;
    cancelledPipeline.database.call = async operation => {
      if (operation === 'begin_cache_maintenance') return { cacheEpoch: 2 };
      if (operation === 'detach_cache_batch') {
        detachCalls += 1;
        cancellationController.abort(Object.assign(new Error('cancelled at batch boundary'), { code: 'TASK_CANCELLED' }));
        return { done: false, detachedCount: 512, detachedBytes: 5120, thumbnailPaths: [] };
      }
      return { success: true };
    };
    await assert.rejects(cancelledPipeline.evictCache({
      all: true,
      signal: cancellationController.signal,
      deadlineAt: Date.now() + 1000,
    }), error => error.code === 'TASK_CANCELLED');
    assert.equal(detachCalls, 1, 'cancellation must stop before the next SQLite batch');
    cancelledPipeline.stop();

    const deadlinePipeline = createPipeline({
      root: temporaryRoot,
      target: path.join(temporaryRoot, 'deadline-unused.jpg'),
      generate: async () => [],
    });
    deadlinePipeline.activeProjectScans = 1;
    await assert.rejects(deadlinePipeline.runDatabaseMaintenance(async () => undefined, {
      deadlineAt: Date.now() + 20,
    }), error => error.code === 'THUMBNAIL_MAINTENANCE_DEADLINE');
    deadlinePipeline.activeProjectScans = 0;
    deadlinePipeline.stop();

    const changedTarget = path.join(temporaryRoot, 'changed.jpg');
    const changedNotifications = [];
    let changedNotify = () => undefined;
    let changedSizes = [];
    const changedPipeline = createPipeline({
      root: temporaryRoot,
      target: changedTarget,
      notify: update => { changedNotifications.push(update); changedNotify(update); },
      generate: async (_filePath, _stat, _kind, _config, sizes) => {
        changedSizes = sizes.map(size => size.label);
        fs.writeFileSync(changedTarget, jpeg);
        return sizes.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: changedTarget }));
      },
    });
    fs.writeFileSync(source, 'externally modified source');
    const changedResultPromise = waitForTerminalState(notify => { changedNotify = notify; });
    const changedSync = await changedPipeline.syncChangedPaths(temporaryRoot, [source], {});
    const changedResult = await changedResultPromise;
    const sourceStat = fs.statSync(source);
    const staleUpdate = changedNotifications.find(update => update.state === 'STALE');
    assert.equal(changedSync.queued, 1);
    assert.equal(staleUpdate?.sourceSize, sourceStat.size, 'a stale notification must publish the new source size');
    assert.equal(staleUpdate?.sourceMtimeMs, sourceStat.mtimeMs, 'a stale notification must publish the new source mtime');
    assert.deepEqual(changedSizes, ['small'], 'the watcher should warm only the small tier; visible renderers request their actual tier');
    assert.equal(changedResult.state, 'READY');
    changedPipeline.stop();

    const missingVideo = path.join(temporaryRoot, 'deleted-video.mp4');
    const watcherCalls = [];
    const watcherPipeline = createPipeline({
      root: temporaryRoot,
      target: path.join(temporaryRoot, 'unused.jpg'),
      generate: async () => [],
    });
    watcherPipeline.database.call = async (operation, args) => {
      watcherCalls.push({ operation, args });
      return { success: true };
    };
    await watcherPipeline.syncChangedPaths(temporaryRoot, [missingVideo], {});
    assert.deepEqual(
      watcherCalls.find(call => call.operation === 'sync_paths')?.args.paths,
      [missingVideo],
      'a deleted media path must be marked missing in the persistent project index',
    );
    const transientVideo = path.join(temporaryRoot, '.clip.123.photoflow-transcode.mp4');
    fs.writeFileSync(transientVideo, 'incomplete transcode');
    const watcherCallCount = watcherCalls.length;
    const transientSync = await watcherPipeline.syncChangedPaths(temporaryRoot, [transientVideo], {});
    assert.equal(transientSync.queued, 0, 'an in-progress transcode must not queue thumbnail generation');
    assert.equal(transientSync.projectScanScheduled, false, 'an in-progress transcode must not trigger a project scan');
    assert.equal(watcherCalls.length, watcherCallCount, 'an in-progress transcode must not enter the persistent media index');
    watcherPipeline.stop();

    const indexedPipeline = createPipeline({
      root: temporaryRoot,
      target: path.join(temporaryRoot, 'unused-index.jpg'),
      generate: async () => [],
    });
    const indexedCalls = [];
    indexedPipeline.database.call = async (operation, args) => {
      indexedCalls.push({ operation, args });
      return { indexed: true, hasVideo: true, hasPng: false, videoPaths: [missingVideo], pngPaths: [] };
    };
    const indexedResult = await indexedPipeline.inspectToolSources(temporaryRoot, [missingVideo], true, true);
    assert.equal(indexedResult.hasVideo, true);
    assert.equal(indexedCalls[0]?.operation, 'inspect_tool_sources', 'tool availability must read the existing project index');
    assert.equal(indexedCalls[0]?.args.collect_direct_png, true, 'folder menu inspection must request direct PNG children');
    await indexedPipeline.inspectToolSources(temporaryRoot, [missingVideo], false, false, true);
    assert.equal(indexedCalls[1]?.args.collect_recursive_png, true, 'PNG conversion must request recursive PNG source collection');
    indexedPipeline.projectScans.set(path.resolve(temporaryRoot), Promise.resolve());
    const buildingResult = await indexedPipeline.inspectToolSources(temporaryRoot, [missingVideo], true);
    assert.equal(buildingResult.indexed, false, 'tool availability must report a queued background project scan as building');
    assert.equal(indexedCalls.length, 2, 'a building project scan must not expose stale database results');
    indexedPipeline.stop();

    const failureTarget = path.join(temporaryRoot, 'failure.jpg');
    let failureNotify = () => undefined;
    const failurePipeline = createPipeline({
      root: temporaryRoot,
      target: failureTarget,
      notify: update => failureNotify(update),
      generate: async () => { throw Object.assign(new Error('simulated cache output loss'), { code: 'ENOENT' }); },
    });
    const failureResult = await waitForTerminalState(notify => {
      failureNotify = notify;
      void failurePipeline.request({ filePath: source, kind: 'image', requestedSize: 640, priority: PRIORITY.visible });
    });
    assert.equal(failureResult.state, 'FAILED', 'cache failure must not mark an existing source as missing');
    failurePipeline.stop();
  } finally {
    const resolvedRoot = path.resolve(temporaryRoot);
    const resolvedTemp = path.resolve(os.tmpdir());
    if (path.dirname(resolvedRoot) === resolvedTemp && path.basename(resolvedRoot).startsWith('photoflow-thumbnail-test-')) {
      fs.rmSync(resolvedRoot, { recursive: true, force: true });
    }
  }
};

run().then(() => {
  console.log('thumbnail pipeline regression tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
