const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ThumbnailPipeline, PRIORITY } = require('../electron/thumbnail-pipeline.cjs');

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(124), Buffer.from([0xff, 0xd9])]);

const createPipeline = ({ root, target, generate, notify = () => undefined, log = () => undefined }) => {
  const pipeline = new ThumbnailPipeline({
    getRunConfig: () => { throw new Error('database service must not start during this test'); },
    databasePath: path.join(root, 'thumbnail-index.sqlite3'),
    getCacheDir: () => root,
    cacheFilePath: () => target,
    generateThumbnailSet: generate,
    toPreviewUrl: filePath => filePath,
    trimCache: () => undefined,
    notify,
    log,
    concurrency: 1,
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
