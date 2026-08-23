const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { ThumbnailPipeline } = require('../electron/thumbnail-pipeline.cjs');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createThumbnailService } = require('../electron/services/thumbnail-service.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const pythonExecutable = process.env.PHOTOFLOW_TEST_PYTHON || path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe');

const makePipeline = (databasePath, cacheRoot) => new ThumbnailPipeline({
  getRunConfig: (scriptName, args) => ({ command: pythonExecutable, args: [path.join(repositoryRoot, 'python', scriptName), ...args] }),
  databasePath,
  getCacheDir: async () => cacheRoot,
  resolveCacheDir: () => cacheRoot,
  cacheFilePath: () => path.join(cacheRoot, 'generated.jpg'),
  generateThumbnailSet: async () => [],
  toPreviewUrl: value => value,
  trimCache: async () => undefined,
  notify() {},
  log() {},
  maxBackgroundTasks: 0,
});

const stopPipeline = async pipeline => {
  await pipeline.database.stop();
  pipeline.stop();
};

const run = async () => {
  process.env.PYTHONDONTWRITEBYTECODE = '1';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-thumbnail-second-launch-'));
  const projectRoot = path.join(root, 'project');
  const cacheRoot = path.join(root, 'cache');
  const databasePath = path.join(root, 'thumbnail-index.sqlite3');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(cacheRoot);
  const sourcePath = path.join(projectRoot, 'source.jpg');
  const finalPath = path.join(cacheRoot, `${'1'.repeat(64)}.jpg`);
  fs.writeFileSync(sourcePath, 'source-photo-must-survive');
  const cacheConfig = { directory: cacheRoot };
  let firstGeneration;
  let secondGeneration;
  try {
    const firstPipeline = makePipeline(databasePath, cacheRoot);
    const firstTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const firstService = createThumbnailService({ pipeline: firstPipeline, backgroundTasks: firstTasks });
    const firstRun = firstService.ensureStartupRecovery(cacheConfig);
    await firstRun.admitted;
    await firstRun.completion;
    const firstMarker = await firstPipeline.maintenanceState(firstRun.descriptor.maintenanceKey);
    firstGeneration = firstMarker.cursor.generation;
    assert(firstMarker.completed && firstMarker.cursor.lastCompletedAt > 0);
    assert.equal(firstTasks.list().filter(task => task.type === 'thumbnail-cache-recovery').length, 0);
    await stopPipeline(firstPipeline);

    const setupPipeline = makePipeline(databasePath, cacheRoot);
    fs.writeFileSync(finalPath, 'ready-thumbnail');
    const capture = await setupPipeline.database.call('capture_thumbnail_publish', { file_path: sourcePath, kind: 'image', project_root: projectRoot });
    await setupPipeline.database.call('commit_thumbnail_publish', {
      publish_id: crypto.randomUUID(), file_path: sourcePath,
      cache_epoch: capture.cacheEpoch, source_version: capture.sourceVersion,
      source_size: capture.sourceSize, source_mtime_ms: capture.sourceMtimeMs,
      thumbnails: [{ sizeLabel: 'small', pixelSize: 320, path: finalPath, fileSize: fs.statSync(finalPath).size }],
    });
    await stopPipeline(setupPipeline);
    fs.rmSync(finalPath);

    const secondPipeline = makePipeline(databasePath, cacheRoot);
    const secondTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const secondService = createThumbnailService({ pipeline: secondPipeline, backgroundTasks: secondTasks });
    const secondRun = secondService.ensureStartupRecovery(cacheConfig);
    await secondRun.admitted;
    const completed = await secondRun.completion;
    assert.equal(completed.task.state, 'completed');
    assert.equal(completed.result.repairedMissingCount, 1);
    const record = await secondPipeline.database.call('get_file', { file_path: sourcePath });
    assert.equal(record.thumbnail_state, 'STALE');
    assert.equal(fs.existsSync(sourcePath), true, 'startup recovery must never delete the source photo');
    const secondMarker = await secondPipeline.maintenanceState(secondRun.descriptor.maintenanceKey);
    secondGeneration = secondMarker.cursor.generation;
    assert(secondMarker.completed && secondMarker.cursor.lastCompletedAt > firstMarker.cursor.lastCompletedAt);
    assert.notEqual(secondGeneration, firstGeneration, 'a new service lifecycle must run a new generation');
    assert.equal(secondTasks.list().filter(task => task.type === 'thumbnail-cache-recovery').length, 0, 'successful recovery must not leave duplicate failed tasks');
    assert.equal((await secondPipeline.database.call('check_integrity')).result, 'ok');
    await stopPipeline(secondPipeline);

    const unchangedPipeline = makePipeline(databasePath, cacheRoot);
    let unchangedEvictions = 0;
    const originalEvictCache = unchangedPipeline.evictCache.bind(unchangedPipeline);
    unchangedPipeline.evictCache = (...args) => {
      unchangedEvictions += 1;
      return originalEvictCache(...args);
    };
    const unchangedTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const unchangedService = createThumbnailService({ pipeline: unchangedPipeline, backgroundTasks: unchangedTasks });
    const unchangedStartedAt = Date.now();
    const unchangedRun = unchangedService.ensureStartupRecovery(cacheConfig);
    await unchangedRun.admitted;
    const unchangedCompleted = await unchangedRun.completion;
    const unchangedDurationMs = Date.now() - unchangedStartedAt;
    assert.equal(unchangedCompleted.result.skipped, true, 'an unchanged cache must use the persisted completion fingerprint');
    assert.equal(unchangedCompleted.result.unchangedCache, true);
    assert.equal(unchangedEvictions, 0, 'the unchanged second startup must not repeat directory or publication reconciliation');
    await stopPipeline(unchangedPipeline);

    const retentionMs = 24 * 60 * 60 * 1000;
    const agingBaseNow = Date.now();
    const stagingRoot = path.join(cacheRoot, '.staging');
    const tooNewOrphan = path.join(stagingRoot, '00000000-0000-4000-8000-000000000001.jpg');
    fs.mkdirSync(stagingRoot, { recursive: true });
    fs.writeFileSync(tooNewOrphan, 'too-new-orphan');
    fs.utimesSync(tooNewOrphan, new Date(agingBaseNow), new Date(agingBaseNow));

    const tooNewPipeline = makePipeline(databasePath, cacheRoot);
    const tooNewTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const tooNewService = createThumbnailService({ pipeline: tooNewPipeline, backgroundTasks: tooNewTasks, now: () => agingBaseNow });
    const tooNewRun = tooNewService.ensureStartupRecovery(cacheConfig);
    await tooNewRun.admitted;
    const tooNewCompleted = await tooNewRun.completion;
    assert.equal(tooNewCompleted.result.skipped, undefined, 'a changed staging directory must run recovery');
    assert.equal(fs.existsSync(tooNewOrphan), true, 'startup recovery must retain an orphan younger than 24 hours');
    const tooNewMarker = await tooNewPipeline.maintenanceState(tooNewRun.descriptor.maintenanceKey);
    assert(tooNewMarker.cursor.orphanRecheckAt >= agingBaseNow + retentionMs - 2, 'completion must persist the earliest aging recheck time');
    await stopPipeline(tooNewPipeline);

    const beforeDuePipeline = makePipeline(databasePath, cacheRoot);
    let beforeDueEvictions = 0;
    const beforeDueOriginalEvict = beforeDuePipeline.evictCache.bind(beforeDuePipeline);
    beforeDuePipeline.evictCache = (...args) => { beforeDueEvictions += 1; return beforeDueOriginalEvict(...args); };
    const beforeDueTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const beforeDueService = createThumbnailService({ pipeline: beforeDuePipeline, backgroundTasks: beforeDueTasks, now: () => agingBaseNow + retentionMs - 1 });
    const beforeDueRun = beforeDueService.ensureStartupRecovery(cacheConfig);
    await beforeDueRun.admitted;
    const beforeDueCompleted = await beforeDueRun.completion;
    assert.equal(beforeDueCompleted.result.skipped, true);
    assert.equal(beforeDueEvictions, 0, 'unchanged cache may skip only before the persisted aging deadline');
    await stopPipeline(beforeDuePipeline);

    const duePipeline = makePipeline(databasePath, cacheRoot);
    let dueEvictions = 0;
    const dueOriginalEvict = duePipeline.evictCache.bind(duePipeline);
    duePipeline.evictCache = (...args) => { dueEvictions += 1; return dueOriginalEvict(...args); };
    const dueTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const dueService = createThumbnailService({ pipeline: duePipeline, backgroundTasks: dueTasks, now: () => agingBaseNow + retentionMs + 1 });
    const dueRun = dueService.ensureStartupRecovery(cacheConfig);
    await dueRun.admitted;
    const dueCompleted = await dueRun.completion;
    assert.equal(dueCompleted.result.skipped, undefined, 'aging deadline must force a new generation even when directory metadata is unchanged');
    assert(dueEvictions > 0);
    assert.equal(fs.existsSync(tooNewOrphan), false, 'the aged orphan must be removed after 24 hours');
    await stopPipeline(duePipeline);

    const afterAgingPipeline = makePipeline(databasePath, cacheRoot);
    let afterAgingEvictions = 0;
    const afterAgingOriginalEvict = afterAgingPipeline.evictCache.bind(afterAgingPipeline);
    afterAgingPipeline.evictCache = (...args) => { afterAgingEvictions += 1; return afterAgingOriginalEvict(...args); };
    const afterAgingTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const afterAgingService = createThumbnailService({ pipeline: afterAgingPipeline, backgroundTasks: afterAgingTasks, now: () => agingBaseNow + retentionMs + 2 });
    const afterAgingRun = afterAgingService.ensureStartupRecovery(cacheConfig);
    await afterAgingRun.admitted;
    const afterAgingCompleted = await afterAgingRun.completion;
    assert.equal(afterAgingCompleted.result.skipped, true, 'post-aging completion should restore the unchanged-cache fast path');
    assert.equal(afterAgingEvictions, 0);
    await stopPipeline(afterAgingPipeline);

    const count = execFileSync(pythonExecutable, ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0])', databasePath], { encoding: 'utf8' }).trim();
    assert.equal(count, '0', 'the missing READY thumbnail row must be removed');
    console.log(`second-launch recovery evidence: first=${firstGeneration} second=${secondGeneration} repaired=1 unchanged=${unchangedDurationMs}ms evictions=${unchangedEvictions} agingRecheck=true state=STALE quick_check=ok`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
