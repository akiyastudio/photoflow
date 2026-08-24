const assert = require('assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
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

    const brokenSource = path.join(root, 'still-writing.png');
    const brokenTarget = path.join(root, '.staging', 'broken.jpg');
    fs.writeFileSync(brokenSource, 'incomplete png');
    const diagnosticRuntime = createImageThumbnailRuntime({
      crypto,
      fs,
      nativeImage: {
        createEmpty: () => ({ isEmpty: () => true }),
        createThumbnailFromPath: async () => ({ isEmpty: () => true }),
      },
      spawn: () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        child.kill = () => { child.killed = true; child.emit('exit', 0); };
        child.stdin.on('data', chunk => {
          const request = JSON.parse(chunk.toString('utf8').trim());
          process.nextTick(() => child.stdout.write(`${JSON.stringify({ id: request.id, success: false, error: 'decoder reported truncated PNG' })}\n`));
        });
        return child;
      },
      getRunConfig: () => ({ command: 'thumbnail-worker', args: [] }),
      runPythonJsonAction: async () => { throw new Error('RAW fallback must not start'); },
      getMediaCacheDir: () => root,
      mediaThumbnailCacheFile: () => brokenTarget,
      copyWindowsShellThumbnail: async () => false,
      thumbnailVersion: 4,
    });
    await assert.rejects(
      diagnosticRuntime.generateThumbnailSet(brokenSource, fs.statSync(brokenSource), 'image', {}, [
        { label: 'small', pixels: 320, path: brokenTarget },
      ]),
      error => error.code === 'EIMAGEDECODE' && /truncated PNG/.test(error.message),
      'a failed native fallback must preserve the original decoder diagnostic',
    );
    diagnosticRuntime.stop();
    console.log('image thumbnail runtime tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
