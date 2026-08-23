const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ThumbnailPipeline, PRIORITY } = require('../electron/thumbnail-pipeline.cjs');

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(124), Buffer.from([0xff, 0xd9])]);
const repositoryRoot = path.resolve(__dirname, '..');
const pythonExecutable = process.env.PHOTOFLOW_TEST_PYTHON || path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe');
const withTimeout = (promise, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ambiguous publish test timed out')), timeoutMs);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

const run = async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-thumbnail-ambiguous-'));
  const cacheRoot = path.join(temporaryRoot, 'cache');
  const source = path.join(temporaryRoot, 'source.jpg');
  const finalPath = path.join(cacheRoot, 'published.jpg');
  fs.mkdirSync(cacheRoot);
  fs.writeFileSync(source, 'source');
  let processStarts = 0;
  let terminalResolve;
  const terminal = new Promise(resolve => { terminalResolve = resolve; });
  const pipeline = new ThumbnailPipeline({
    getRunConfig: (scriptName, args) => {
      processStarts += 1;
      return { command: pythonExecutable, args: [path.join(repositoryRoot, 'python', scriptName), ...args] };
    },
    databasePath: path.join(temporaryRoot, 'thumbnail-index.sqlite3'),
    databaseServiceArgs: ['--crash-after-publish-commit'],
    getCacheDir: () => cacheRoot,
    cacheFilePath: () => finalPath,
    generateThumbnailSet: async (_filePath, _stat, _kind, _config, sizes) => {
      for (const size of sizes) fs.writeFileSync(size.path, jpeg);
      return sizes.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: size.path }));
    },
    toPreviewUrl: value => value,
    trimCache: () => undefined,
    notify: update => {
      if (update.state === 'READY' || update.state === 'FAILED') terminalResolve(update);
    },
    log: () => undefined,
    concurrency: 1,
  });
  try {
    const queued = await pipeline.request({ filePath: source, kind: 'image', requestedSize: 320, priority: PRIORITY.visible });
    assert.equal(queued.state, 'QUEUED');
    const result = await withTimeout(terminal, 10000);
    assert.equal(result.state, 'READY', 'committed token must recover READY after response loss');
    assert.equal(fs.existsSync(finalPath), true, 'ambiguous commit recovery must preserve the committed final');
    assert(processStarts >= 2, 'publish-result lookup must reconnect after the injected worker exit');
    const indexed = await pipeline.database.call('get_file', { file_path: source });
    assert.equal(indexed.thumbnail_state, 'READY');
  } finally {
    await pipeline.database.stop();
    pipeline.stop();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log('thumbnail ambiguous publish tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
