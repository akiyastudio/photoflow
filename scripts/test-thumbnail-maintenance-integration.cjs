const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ThumbnailPipeline } = require('../electron/thumbnail-pipeline.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const pythonExecutable = path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe');
const withTimeout = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

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
