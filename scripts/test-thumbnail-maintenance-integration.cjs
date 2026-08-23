const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ThumbnailPipeline } = require('../electron/thumbnail-pipeline.cjs');
const { runSlicedMaintenance } = require('../electron/services/sliced-maintenance-runner.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const pythonExecutable = process.env.PHOTOFLOW_TEST_PYTHON || path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe');
const withTimeout = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const samePath = (left, right) => path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();

const run = async () => {
  process.env.PYTHONDONTWRITEBYTECODE = '1';
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-thumbnail-maintenance-'));
  const projectRoot = path.join(temporaryRoot, 'project');
  const cacheRoot = path.join(temporaryRoot, 'cache');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(cacheRoot);
  for (let index = 0; index < 520; index += 1) {
    fs.writeFileSync(path.join(projectRoot, `image-${String(index).padStart(4, '0')}.jpg`), `image-${index}`);
  }

  const pipeline = new ThumbnailPipeline({
    getRunConfig: (scriptName, args) => ({
      command: pythonExecutable,
      args: [path.join(repositoryRoot, 'python', scriptName), ...args],
    }),
    databasePath: path.join(temporaryRoot, 'thumbnail-index.sqlite3'),
    getCacheDir: () => cacheRoot,
    cacheFilePath: (_filePath, _stat, _cacheDir, size) => path.join(cacheRoot, `${size}.jpg`),
    generateThumbnailSet: async () => [],
    toPreviewUrl: value => value,
    trimCache: () => undefined,
    notify: () => undefined,
    log: () => undefined,
    maxBackgroundTasks: 0,
  });
  pipeline.lastForegroundActivityAt = 0;

  try {
    await pipeline.database.call('sync_directory', { project_root: projectRoot, directory: projectRoot }, 60 * 1000);
    assert.equal(pipeline.database.lastHandshake?.type, 'ready', 'the database process must acknowledge readiness before its first request completes');
    const indexedSource = path.join(projectRoot, 'image-0000.jpg');
    const indexedSourceStat = fs.statSync(indexedSource);
    const cachedPaths = [];
    const thumbnailRows = [];
    for (let index = 0; index < 520; index += 1) {
      const cachedPath = path.join(cacheRoot, `${index.toString(16).padStart(64, '0')}.jpg`);
      fs.writeFileSync(cachedPath, Buffer.alloc(128, index % 255));
      cachedPaths.push(cachedPath);
      thumbnailRows.push({
        sizeLabel: `batch-${index}`,
        pixelSize: 320,
        path: cachedPath,
        fileSize: 128,
      });
    }
    await pipeline.database.call('mark_ready', {
      file_path: indexedSource,
      source_mtime_ms: indexedSourceStat.mtimeMs,
      source_digest: null,
      thumbnails: thumbnailRows,
    }, 60 * 1000);

    const scan = pipeline.scanProject(projectRoot, {});
    assert.equal(pipeline.activeProjectScans, 1, 'the real project scanner must be active before maintenance is requested');
    let activeScansWhenMaintenanceStarted = -1;
    const maintenance = pipeline.runDatabaseMaintenance(async () => {
      activeScansWhenMaintenanceStarted = pipeline.activeProjectScans;
      return pipeline.evictCache({ cacheRoot, all: true });
    });
    const [scanResult, maintenanceResult] = await withTimeout(Promise.all([scan, maintenance]), 30000, 'real thumbnail scan and maintenance');
    assert.equal(scanResult.fileCount, 520);
    assert.equal(activeScansWhenMaintenanceStarted, 0, 'maintenance must start only after the real SQLite scanner releases its connection');
    assert.equal(maintenanceResult.detachedCount, 520, 'real maintenance must detach more than one SQLite batch');
    assert.equal(maintenanceResult.deletedCount, 520, 'Node must delete every path returned by detached batches');
    const indexedRecord = await pipeline.database.call('get_file', { file_path: indexedSource });
    assert.equal(indexedRecord.thumbnail_state, 'STALE');
    assert.equal(cachedPaths.some(cachedPath => fs.existsSync(cachedPath)), false);
    assert.equal(pipeline.activeProjectScans, 0);

    const missingRows = Array.from({ length: 130 }, (_, index) => ({
      sizeLabel: `missing-${index}`,
      pixelSize: 320,
      path: path.join(cacheRoot, `missing-${index}.jpg`),
      fileSize: 128,
    }));
    await pipeline.database.call('mark_ready', {
      file_path: indexedSource,
      source_mtime_ms: indexedSourceStat.mtimeMs,
      source_digest: null,
      thumbnails: missingRows,
    }, 60 * 1000);
    const markerKey = 'sliced-recovery-integration';
    let recoveryCursor = { generation: 'sliced-generation', generationMaxRowId: 0, afterRowId: 0, lastCompletedAt: 0, directory: {} };
    const epochBeforeSlices = (await pipeline.database.call('get_cache_epoch')).cacheEpoch;
    const sliceResults = [];
    for (let slice = 0; slice < 5; slice += 1) {
      const result = await pipeline.evictCache({
        cacheRoot,
        recoverOrphans: true,
        scanRootOrphans: false,
        completeMaintenanceKey: markerKey,
        recoveryCursor,
        recoveryInspectLimit: 64,
        recoveryDeleteLimit: 64,
        maxRecoveryPages: 1,
        bumpCacheEpoch: slice === 0,
        deadlineAt: Date.now() + 30 * 1000,
      });
      sliceResults.push(result);
      recoveryCursor = result.recoveryCursor;
      const foregroundRead = await withTimeout(pipeline.database.call('get_file', { file_path: indexedSource }), 2000, 'foreground read between recovery slices');
      assert(foregroundRead, 'foreground thumbnail reads must run between bounded maintenance slices');
      if (result.recoveryComplete) break;
    }
    assert.equal(sliceResults.length, 3, '130 rows with a 64-row bound must complete in three maintenance slices');
    assert.deepEqual(sliceResults.map(result => result.repairedMissingCount), [64, 64, 2]);
    assert.equal(sliceResults.at(-1).recoveryComplete, true);
    assert.equal((await pipeline.database.call('get_cache_epoch')).cacheEpoch, epochBeforeSlices + 1, 'continuation slices must not repeatedly invalidate cache publications');
    const slicedMarker = await pipeline.maintenanceState(markerKey);
    assert.equal(slicedMarker.completed, true);
    assert(slicedMarker.cursor.lastCompletedAt > 0);

    const scanPaths = Array.from({ length: 10 }, (_, index) => path.join(cacheRoot, `${String(index).repeat(64)}.jpg`));
    for (const scanPath of scanPaths) {
      fs.writeFileSync(scanPath, Buffer.alloc(32));
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      fs.utimesSync(scanPath, old, old);
    }
    fs.utimesSync(scanPaths[4], new Date(), new Date());
    await pipeline.database.call('mark_ready', {
      file_path: indexedSource,
      source_mtime_ms: indexedSourceStat.mtimeMs,
      source_digest: null,
      thumbnails: [{ sizeLabel: 'indexed-orphan-page', pixelSize: 320, path: scanPaths[3], fileSize: 32 }],
    }, 60 * 1000);
    const queueSlices = [];
    let firstQueueSlice = true;
    const queuedRecovery = await runSlicedMaintenance({
      task: { throwIfCancelled() {}, report() {} },
      initialState: { recoveryCursor: { generation: 'fixed-cursor-generation', generationMaxRowId: 0, afterRowId: 0, lastCompletedAt: 0, directory: {} } },
      sliceDeadlineMs: 30 * 1000,
      yieldBetweenSlices: async () => undefined,
      runSlice: async ({ state, firstSlice }) => {
        const result = await pipeline.evictCache({
          cacheRoot,
          recoverOrphans: true,
          orphanBeforeMs: Date.now() - 24 * 60 * 60 * 1000,
          completeMaintenanceKey: 'fixed-cursor-queue-integration',
          recoveryCursor: state.recoveryCursor,
          recoveryInspectLimit: 2,
          recoveryDeleteLimit: 2,
          recoveryDirectoryInspectLimit: 2,
          maxRecoveryPages: 1,
          bumpCacheEpoch: firstSlice,
          deadlineAt: Date.now() + 30 * 1000,
        });
        queueSlices.push(result);
        if (firstQueueSlice) {
          firstQueueSlice = false;
          fs.rmSync(scanPaths[2]);
        }
        if (!result.maintenanceComplete) await pipeline.database.stop();
        return {
          complete: result.maintenanceComplete,
          nextState: { recoveryCursor: result.recoveryCursor },
          processedDelta: result.processedCount,
          metricsDelta: { orphanScanConsumedCount: result.orphanScanConsumedCount, deletedCount: result.deletedCount },
        };
      },
    });
    assert(queueSlices.length >= 6, 'ten queued entries with a two-entry page require more than three fixed-cursor tail slices');
    assert.equal(new Set(queueSlices.slice(0, 5).map(result => result.recoveryCursor.directory.rootIndex)).size, 1, 'the external directory cursor stays fixed while the durable scan queue drains');
    assert.equal(queueSlices[1].deletedCount, 0, 'the indexed and already-missing page performs no physical deletion');
    assert.equal(queueSlices[1].orphanScanConsumedCount, 2, 'indexed and already-missing scan rows still count as consumed work');
    assert(queuedRecovery.metrics.orphanScanConsumedCount > queuedRecovery.metrics.deletedCount, 'a too-new scan row counts as progress without being deleted');
    assert(queuedRecovery.processedCount >= 10, 'all durable scan entries contribute to sliced progress');
    assert.equal(fs.existsSync(scanPaths[3]), true, 'an indexed thumbnail must survive orphan recovery');
    assert.equal(fs.existsSync(scanPaths[4]), true, 'a too-new orphan must survive the cutoff');
    console.log(`thumbnail queue progress evidence: slices=${queueSlices.length} perPageProcessRestart=true consumed=${queuedRecovery.processedCount} secondSliceDeleted=${queueSlices[1].deletedCount}`);

    const commitReadyPath = async (thumbnailPath, sizeLabel) => {
      const capture = await pipeline.database.call('capture_thumbnail_publish', {
        file_path: indexedSource, kind: 'image', project_root: projectRoot,
      });
      return pipeline.database.call('commit_thumbnail_publish', {
        publish_id: crypto.randomUUID(), file_path: indexedSource,
        cache_epoch: capture.cacheEpoch, source_version: capture.sourceVersion,
        source_size: capture.sourceSize, source_mtime_ms: capture.sourceMtimeMs,
        thumbnails: [{ sizeLabel, pixelSize: 320, path: thumbnailPath, fileSize: fs.statSync(thumbnailPath).size }],
      });
    };

    const detachRacePath = path.join(cacheRoot, `${'a'.repeat(64)}.jpg`);
    fs.writeFileSync(detachRacePath, 'detach-race');
    await commitReadyPath(detachRacePath, 'detach-race');
    const detachRealCall = pipeline.database.call.bind(pipeline.database);
    let detachPublisher = null;
    pipeline.database.call = async (operation, args, timeoutMs) => {
      const result = await detachRealCall(operation, args, timeoutMs);
      if (operation === 'detach_cache_batch' && result.thumbnailPaths?.some(value => samePath(value, detachRacePath))) {
        detachPublisher = pipeline.coordinator.withPublisher(async () => {
          const capture = await detachRealCall('capture_thumbnail_publish', { file_path: indexedSource, kind: 'image', project_root: projectRoot });
          return detachRealCall('commit_thumbnail_publish', {
            publish_id: crypto.randomUUID(), file_path: indexedSource,
            cache_epoch: capture.cacheEpoch, source_version: capture.sourceVersion,
            source_size: capture.sourceSize, source_mtime_ms: capture.sourceMtimeMs,
            thumbnails: [{ sizeLabel: 'detach-race', pixelSize: 320, path: detachRacePath, fileSize: fs.statSync(detachRacePath).size }],
          });
        });
      }
      return result;
    };
    const detachRaceResult = await pipeline.evictCache({ cacheRoot, thumbnailPaths: [detachRacePath], deadlineAt: Date.now() + 30 * 1000 });
    await detachPublisher;
    pipeline.database.call = detachRealCall;
    assert.equal(detachRaceResult.deletedPaths.some(value => samePath(value, detachRacePath)), false, 'a path republished during detach yield must be revalidated and retained');
    assert.equal(fs.existsSync(detachRacePath), true);
    assert.equal((await pipeline.database.call('get_file', { file_path: indexedSource })).thumbnail_state, 'READY');

    const orphanRacePath = path.join(cacheRoot, `${'b'.repeat(64)}.jpg`);
    const unindexedControlPath = path.join(cacheRoot, `${'c'.repeat(64)}.jpg`);
    fs.writeFileSync(orphanRacePath, 'orphan-race');
    fs.writeFileSync(unindexedControlPath, 'true-orphan');
    const oldOrphanTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(orphanRacePath, oldOrphanTime, oldOrphanTime);
    fs.utimesSync(unindexedControlPath, oldOrphanTime, oldOrphanTime);
    const orphanRealCall = pipeline.database.call.bind(pipeline.database);
    let orphanPublisher = null;
    pipeline.database.call = async (operation, args, timeoutMs) => {
      const result = await orphanRealCall(operation, args, timeoutMs);
      if (operation === 'recover_cache_publications' && result.orphanPaths?.some(value => samePath(value, orphanRacePath))) {
        orphanPublisher = pipeline.coordinator.withPublisher(async () => {
          const capture = await orphanRealCall('capture_thumbnail_publish', { file_path: indexedSource, kind: 'image', project_root: projectRoot });
          return orphanRealCall('commit_thumbnail_publish', {
            publish_id: crypto.randomUUID(), file_path: indexedSource,
            cache_epoch: capture.cacheEpoch, source_version: capture.sourceVersion,
            source_size: capture.sourceSize, source_mtime_ms: capture.sourceMtimeMs,
            thumbnails: [{ sizeLabel: 'orphan-race', pixelSize: 320, path: orphanRacePath, fileSize: fs.statSync(orphanRacePath).size }],
          });
        });
      }
      return result;
    };
    const orphanRaceResult = await pipeline.evictCache({
      cacheRoot, recoverOrphans: true, orphanBeforeMs: Date.now() - 24 * 60 * 60 * 1000,
      recoveryCursor: { generation: 'orphan-publish-race', generationMaxRowId: -1, afterRowId: 0, directory: {} },
      recoveryDeleteLimit: 64, recoveryDirectoryInspectLimit: 128, deadlineAt: Date.now() + 30 * 1000,
    });
    await orphanPublisher;
    pipeline.database.call = orphanRealCall;
    assert.equal(orphanRaceResult.deletedPaths.some(value => samePath(value, orphanRacePath)), false, 'an orphan candidate published during yield must be revalidated and retained');
    assert.equal(fs.existsSync(orphanRacePath), true);
    assert.equal(fs.existsSync(unindexedControlPath), false, 'a truly unindexed orphan must still be deleted');

    const delayedDeletePath = path.join(cacheRoot, `${'d'.repeat(64)}.jpg`);
    fs.writeFileSync(delayedDeletePath, 'old-ready-file');
    await commitReadyPath(delayedDeletePath, 'delayed-delete');
    const originalUnlink = fs.promises.unlink;
    let releaseDelayedUnlink;
    let signalDelayedUnlink;
    const delayedUnlinkStarted = new Promise(resolve => { signalDelayedUnlink = resolve; });
    const delayedUnlinkGate = new Promise(resolve => { releaseDelayedUnlink = resolve; });
    let delayedUnlinkSettled = false;
    fs.promises.unlink = async filePath => {
      if (!samePath(filePath, delayedDeletePath)) return originalUnlink(filePath);
      signalDelayedUnlink();
      await delayedUnlinkGate;
      const result = await originalUnlink(filePath);
      delayedUnlinkSettled = true;
      return result;
    };
    try {
      const delayedMaintenance = pipeline.evictCache({
        cacheRoot, thumbnailPaths: [delayedDeletePath], deadlineAt: Date.now() + 25,
      });
      await delayedUnlinkStarted;
      let publisherAdmittedBeforeSettle = false;
      const delayedPublisher = pipeline.coordinator.withPublisher(async () => {
        publisherAdmittedBeforeSettle = !delayedUnlinkSettled;
        fs.writeFileSync(delayedDeletePath, 'new-ready-file');
        return commitReadyPath(delayedDeletePath, 'delayed-delete');
      });
      await new Promise(resolve => setTimeout(resolve, 40));
      releaseDelayedUnlink();
      await assert.rejects(delayedMaintenance, error => error.code === 'THUMBNAIL_MAINTENANCE_DEADLINE');
      await delayedPublisher;
      assert.equal(publisherAdmittedBeforeSettle, false, 'publisher admission must wait for a timed-out unlink to settle');
      assert.equal(fs.existsSync(delayedDeletePath), true, 'late unlink must not remove the subsequently published READY file');
      const delayedRecord = await pipeline.database.call('get_file', { file_path: indexedSource });
      assert.equal(delayedRecord.thumbnail_state, 'READY');
      const delayedIndex = await pipeline.database.call('prepare_thumbnail_deletions', { thumbnail_paths: [delayedDeletePath] });
      assert(delayedIndex.indexedPaths.some(value => samePath(value, delayedDeletePath)));
    } finally {
      releaseDelayedUnlink?.();
      fs.promises.unlink = originalUnlink;
    }

    const indexedRetryPaths = Array.from({ length: 8 }, (_, index) => path.join(cacheRoot, `${index.toString(16).padStart(64, 'e')}.jpg`));
    for (const retryPath of indexedRetryPaths) fs.writeFileSync(retryPath, 'indexed-retry');
    await pipeline.database.call('record_orphan_delete_failures', {
      cache_root: cacheRoot,
      failures: indexedRetryPaths.map(retryPath => ({ path: retryPath, error: 'previously busy' })),
    });
    const retryCapture = await pipeline.database.call('capture_thumbnail_publish', { file_path: indexedSource, kind: 'image', project_root: projectRoot });
    await pipeline.database.call('commit_thumbnail_publish', {
      publish_id: crypto.randomUUID(), file_path: indexedSource,
      cache_epoch: retryCapture.cacheEpoch, source_version: retryCapture.sourceVersion,
      source_size: retryCapture.sourceSize, source_mtime_ms: retryCapture.sourceMtimeMs,
      thumbnails: indexedRetryPaths.map((retryPath, index) => ({ sizeLabel: `indexed-retry-${index}`, pixelSize: 320, path: retryPath, fileSize: fs.statSync(retryPath).size })),
    });
    const indexedRetrySlices = [];
    const indexedRetryRun = await runSlicedMaintenance({
      task: { throwIfCancelled() {}, report() {} },
      initialState: { recoveryCursor: { generation: 'indexed-retry-generation', generationMaxRowId: -1, afterRowId: 0, lastCompletedAt: 0, directory: { rootIndex: 2 } } },
      sliceDeadlineMs: 30 * 1000,
      yieldBetweenSlices: async () => undefined,
      runSlice: async ({ state, firstSlice }) => {
        const result = await pipeline.evictCache({
          cacheRoot, recoverOrphans: true, recoveryCursor: state.recoveryCursor,
          recoveryDeleteLimit: 2, maxRecoveryPages: 1, bumpCacheEpoch: firstSlice,
          deadlineAt: Date.now() + 30 * 1000,
        });
        indexedRetrySlices.push(result);
        return {
          complete: result.maintenanceComplete,
          nextState: { recoveryCursor: result.recoveryCursor },
          processedDelta: result.processedCount,
          metricsDelta: { retryConsumedCount: result.retryConsumedCount, deletedCount: result.deletedCount },
        };
      },
    });
    assert(indexedRetrySlices.length > 3, 'indexed retry cleanup must span more than three fixed-cursor pages');
    assert.equal(indexedRetryRun.metrics.retryConsumedCount, indexedRetryPaths.length, 're-indexed retry rows must count as real progress when cleared');
    assert.equal(indexedRetryRun.metrics.deletedCount, 0);
    assert(indexedRetryPaths.every(retryPath => fs.existsSync(retryPath)), 're-indexed retry files must not be deleted');

    const persistentRetryPaths = [
      path.join(cacheRoot, `${'f'.repeat(64)}.jpg`),
      path.join(cacheRoot, `${'9'.repeat(64)}.jpg`),
    ];
    for (const retryPath of persistentRetryPaths) fs.writeFileSync(retryPath, 'persistent-retry');
    await pipeline.database.call('record_orphan_delete_failures', {
      cache_root: cacheRoot,
      failures: persistentRetryPaths.map(retryPath => ({ path: retryPath, error: 'volume remains busy' })),
    });
    const retryUnlink = fs.promises.unlink;
    fs.promises.unlink = async filePath => {
      if (persistentRetryPaths.some(value => samePath(value, filePath))) {
        throw Object.assign(new Error('simulated persistent sharing violation'), { code: 'EPERM' });
      }
      return retryUnlink(filePath);
    };
    let persistentRetryAttempts = 0;
    try {
      await assert.rejects(runSlicedMaintenance({
        task: { throwIfCancelled() {}, report() {} },
        initialState: { recoveryCursor: { generation: 'persistent-retry-generation', generationMaxRowId: -1, afterRowId: 0, lastCompletedAt: 0, directory: { rootIndex: 2, entryOffset: 0 }, orphanRecheckAt: 0 } },
        sliceDeadlineMs: 30 * 1000,
        yieldBetweenSlices: async () => undefined,
        runSlice: async ({ state, firstSlice }) => {
          persistentRetryAttempts += 1;
          const result = await pipeline.evictCache({
            cacheRoot, recoverOrphans: true, recoveryCursor: state.recoveryCursor,
            recoveryDeleteLimit: 2, maxRecoveryPages: 1, bumpCacheEpoch: firstSlice,
            deadlineAt: Date.now() + 30 * 1000,
          });
          return {
            complete: result.maintenanceComplete,
            nextState: { recoveryCursor: result.recoveryCursor },
            processedDelta: result.processedCount,
            metricsDelta: { retryConsumedCount: result.retryConsumedCount, deletedCount: result.deletedCount },
          };
        },
      }), error => error.code === 'SLICED_MAINTENANCE_STALLED' && error.sliceCount === 3);
    } finally {
      fs.promises.unlink = retryUnlink;
    }
    assert.equal(persistentRetryAttempts, 3, 'an unchanged full retry page must trip the normal three-slice fuse');
    assert(persistentRetryPaths.every(retryPath => fs.existsSync(retryPath)), 'persistent retry failures must remain recorded without deleting files');
    const persistedRetryPage = await pipeline.database.call('recover_cache_publications', {
      cache_root: cacheRoot, scan_root_orphans: true, generation: 'persistent-retry-audit',
      generation_max_row_id: -1, after_row_id: 0, directory_cursor: { rootIndex: 2 }, delete_limit: 2,
    });
    assert.deepEqual(new Set(persistedRetryPage.orphanPaths.map(value => path.resolve(value).toLocaleLowerCase())), new Set(persistentRetryPaths.map(value => path.resolve(value).toLocaleLowerCase())));
  } finally {
    pipeline.stop();
    const resolvedRoot = path.resolve(temporaryRoot);
    if (path.dirname(resolvedRoot) === path.resolve(os.tmpdir()) && path.basename(resolvedRoot).startsWith('photoflow-thumbnail-maintenance-')) {
      fs.rmSync(resolvedRoot, { recursive: true, force: true });
    }
  }
  console.log('thumbnail maintenance integration tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
