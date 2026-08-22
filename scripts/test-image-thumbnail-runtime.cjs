const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createImageThumbnailRuntime } = require('../electron/services/image-thumbnail-runtime.cjs');

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-image-thumbnail-runtime-'));
  try {
    const source = path.join(root, 'source.CR3');
    const target = path.join(root, '.staging', 'target.jpg');
    fs.writeFileSync(source, 'raw-source');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const runtime = createImageThumbnailRuntime({
      crypto,
      fs,
      nativeImage: { createEmpty: () => ({ isEmpty: () => true }) },
      spawn: () => { throw new Error('decoder must not start when shell copy succeeds'); },
      getRunConfig: () => { throw new Error('decoder config must not be requested'); },
      runPythonJsonAction: async () => { throw new Error('RAW fallback must not start'); },
      getMediaCacheDir: () => root,
      mediaThumbnailCacheFile: () => path.join(root, 'fallback.jpg'),
      copyWindowsShellThumbnail: async (_source, output) => {
        fs.writeFileSync(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return true;
      },
      thumbnailVersion: 4,
    });
    const generated = await runtime.generateThumbnailSet(source, fs.statSync(source), 'raw', {}, [
      { label: 'small', pixels: 320, path: target },
    ]);
    assert.equal(generated.length, 1);
    assert.equal(path.resolve(generated[0].path), path.resolve(target));
    runtime.stop();
    console.log('image thumbnail runtime tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
