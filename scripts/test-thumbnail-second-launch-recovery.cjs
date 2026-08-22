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
const pythonExecutable = path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe');

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

    const count = execFileSync(pythonExecutable, ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0])', databasePath], { encoding: 'utf8' }).trim();
    assert.equal(count, '0', 'the missing READY thumbnail row must be removed');
    console.log(`second-launch recovery evidence: first=${firstGeneration} second=${secondGeneration} repaired=1 state=STALE quick_check=ok`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
