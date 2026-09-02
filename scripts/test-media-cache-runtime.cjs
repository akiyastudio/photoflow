const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMediaCacheRuntime } = require('../electron/services/media-cache-runtime.cjs');

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-media-cache-runtime-'));
  const cacheRoot = path.join(root, 'media-cache');
  const namespaceRoot = path.join(cacheRoot, 'namespace');
  fs.mkdirSync(namespaceRoot, { recursive: true });
  try {
  const runtime = createMediaCacheRuntime({
    fs, path, crypto, platform: 'win32',
    resolveMediaCacheNamespace: ({ configuredDirectory }) => path.join(path.resolve(configuredDirectory || cacheRoot), 'namespace'),
    userDataPath: root,
    installationId: 'fixture-installation',
    approvedDirectories: new Set([path.resolve(cacheRoot)]),
    normalizeCacheSizeGB: value => Number(value) || 50,
    trackedVersionThumbnailPath: (_workspaceRoot, _photoId, versionId) => path.join(root, `${versionId}.jpg`),
    versionService: { setThumbnail: async () => undefined },
    mediaRuntimeState: { activeMediaCacheConfig: { directory: cacheRoot, maxSizeGB: 50 } },
    imageExtensions: new Set(['.jpg']), rawExtensions: new Set(['.cr3']), videoExtensions: new Set(['.mp4']),
    thumbnailVersion: 'fixture-v1', defaultPriority: 2, writeLog: () => undefined,
  });
  assert.equal(runtime.getMediaCacheDir({ directory: cacheRoot }), namespaceRoot);
  assert.throws(() => runtime.getMediaCacheDir({ directory: path.join(root, 'unapproved') }), /未经授权/);

  const sourcePath = path.join(root, 'Example.CR3');
  const stat = { size: 1234, mtimeMs: 5678 };
  const first = runtime.mediaThumbnailCacheFile(sourcePath, stat, namespaceRoot, 640);
  const sameCaseInsensitive = runtime.mediaThumbnailCacheFile(sourcePath.toUpperCase(), stat, namespaceRoot, 640);
  assert.equal(first, sameCaseInsensitive, 'Windows cache keys remain case-insensitive');
  assert.equal(path.extname(first), '.jpg');

  fs.writeFileSync(path.join(namespaceRoot, 'one.bin'), Buffer.alloc(17));
  fs.writeFileSync(path.join(namespaceRoot, 'two.bin'), Buffer.alloc(29));
  const index = await runtime.refreshMediaCacheIndex(namespaceRoot);
  assert.equal(index.totalBytes, 46);
  assert.equal(index.files.size, 2);
  assert.equal(runtime.indexes.get(path.resolve(namespaceRoot)), index);
    console.log('media cache runtime tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
