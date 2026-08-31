const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ThumbnailPipeline } = require('../../electron/thumbnail-pipeline.cjs');
const { loadOrCreateInstallationId, resolveMediaCacheNamespace } = require('../../electron/services/media-cache-namespace.cjs');

const [action, configuredDirectory, userDataPath] = process.argv.slice(2);

const run = async () => {
  const installationId = loadOrCreateInstallationId({ fs, path, crypto, userDataPath });
  const cacheRoot = resolveMediaCacheNamespace({ path, userDataPath, installationId, configuredDirectory });
  const databasePath = path.join(userDataPath, 'thumbnail-index.sqlite3');
  const sourcePath = path.join(userDataPath, 'source.jpg');
  const finalPath = path.join(cacheRoot, 'ready.jpg');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const python = process.env.PHOTOFLOW_TEST_PYTHON || path.resolve('.venv', 'Scripts', 'python.exe');
  const script = path.resolve('python', 'thumbnail_db.py');
  const pipeline = new ThumbnailPipeline({
    getRunConfig: (_scriptName, args) => ({ command: python, args: [script, ...args] }),
    databasePath,
    getCacheDir: async () => cacheRoot,
    resolveCacheDir: () => cacheRoot,
    cacheFilePath: () => finalPath,
    generateThumbnailSet: async () => [],
    toPreviewUrl: value => value,
    trimCache: async () => undefined,
    notify() {},
    log() {},
  });
  const call = (operation, payload = {}) => pipeline.database.call(operation, payload);
  try {
    if (action === 'init') {
      fs.writeFileSync(sourcePath, 'source');
      fs.writeFileSync(finalPath, `thumbnail-${installationId}`);
      const capture = await call('capture_thumbnail_publish', { file_path: sourcePath, kind: 'image', project_root: userDataPath });
      await call('commit_thumbnail_publish', {
        publish_id: `init-${installationId}-${crypto.randomUUID()}`, file_path: sourcePath,
        cache_epoch: capture.cacheEpoch, source_version: capture.sourceVersion,
        source_size: capture.sourceSize, source_mtime_ms: capture.sourceMtimeMs,
        thumbnails: [{ sizeLabel: 'small', pixelSize: 320, path: finalPath, fileSize: fs.statSync(finalPath).size }],
      });
    } else if (action === 'evict') {
      await call('begin_cache_maintenance');
      const candidates = await call('list_cache_cleanup', { before_ms: Date.now() + 1_000, cache_root: cacheRoot });
      for (const candidate of candidates.thumbnailPaths) fs.rmSync(candidate, { force: true });
      await call('invalidate_cache', { deleted_paths: candidates.thumbnailPaths });
    } else if (action !== 'inspect') {
      throw new Error(`unknown fixture action: ${action}`);
    }
    const record = await call('get_file', { file_path: sourcePath });
    const integrity = await call('check_integrity');
    process.stdout.write(`${JSON.stringify({ action, installationId, cacheRoot, databasePath, sourcePath, finalPath, finalExists: fs.existsSync(finalPath), state: record?.thumbnail_state, integrity: integrity.result })}\n`);
  } finally {
    pipeline.stop();
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
