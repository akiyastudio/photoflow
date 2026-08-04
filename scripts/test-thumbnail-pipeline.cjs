const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ThumbnailPipeline, PRIORITY, isThumbnailSizeSufficient } = require('../electron/thumbnail-pipeline.cjs');

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(124), Buffer.from([0xff, 0xd9])]);

const createPipeline = ({ root, target, generate, toPreviewUrl = filePath => filePath, notify = () => undefined, log = () => undefined, sourceStabilityDelayMs = 20, sourceStabilityProbeMs = 10 }) => {
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
    sourceStabilityDelayMs,
    sourceStabilityProbeMs,
  });
  pipeline.database.call = async () => ({ success: true });
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
    indexedPipeline.projectScans.set(path.resolve(temporaryRoot), Promise.resolve());
    const buildingResult = await indexedPipeline.inspectToolSources(temporaryRoot, [missingVideo], true);
    assert.equal(buildingResult.indexed, false, 'tool availability must report a queued background project scan as building');
    assert.equal(indexedCalls.length, 1, 'a building project scan must not expose stale database results');
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
