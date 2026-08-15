const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startDetachedBackgroundOperation } = require('../electron/services/detached-background-operation.cjs');
const { replaceVideoFileWithRollback } = require('../electron/services/video-trim-commit-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-video-trim-'));

const run = async () => {
  try {
    let releaseBackgroundWorker;
    const backgroundWorkerGate = new Promise(resolve => { releaseBackgroundWorker = resolve; });
    let backgroundWorkerCompleted = false;
    const acknowledgement = startDetachedBackgroundOperation({
      operationId: '中文文件-后台裁剪',
      worker: async () => {
        await backgroundWorkerGate;
        backgroundWorkerCompleted = true;
      },
    });
    assert.deepStrictEqual(acknowledgement, { success: true, started: true, operationId: '中文文件-后台裁剪' });
    assert.strictEqual(backgroundWorkerCompleted, false, 'starting a trim must not await the background worker');
    releaseBackgroundWorker();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(backgroundWorkerCompleted, true, 'the detached worker must continue after the start call returns');

    const chineseDirectory = path.join(root, '中文项目', '待剪辑视频');
    fs.mkdirSync(chineseDirectory, { recursive: true });
    const source = path.join(chineseDirectory, '角色生日 录像.mp4');
    const replacement = path.join(chineseDirectory, '.photoflow-trim-output.mp4');
    fs.writeFileSync(source, 'original');
    fs.writeFileSync(replacement, 'trimmed');
    await replaceVideoFileWithRollback({ crypto, fs, path, sourcePath: source, replacementPath: replacement, retryDelays: [0] });
    assert.strictEqual(fs.readFileSync(source, 'utf8'), 'trimmed');
    assert.strictEqual(fs.existsSync(replacement), false);
    assert.strictEqual(fs.readdirSync(chineseDirectory).some(name => name.startsWith('.photoflow-trim-backup-')), false);

    const rollbackSource = path.join(root, 'rollback.mp4');
    const rollbackReplacement = path.join(root, '.photoflow-trim-rollback-output.mp4');
    fs.writeFileSync(rollbackSource, 'keep original');
    fs.writeFileSync(rollbackReplacement, 'uncommitted trim');
    const injectedFs = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from, to) => {
          if (from === rollbackReplacement && to === rollbackSource) throw Object.assign(new Error('simulated commit failure'), { code: 'EIO' });
          return fs.promises.rename(from, to);
        },
      },
    };
    await assert.rejects(
      replaceVideoFileWithRollback({ crypto, fs: injectedFs, path, sourcePath: rollbackSource, replacementPath: rollbackReplacement, retryDelays: [0] }),
      /simulated commit failure/,
    );
    assert.strictEqual(fs.readFileSync(rollbackSource, 'utf8'), 'keep original');
    assert.strictEqual(fs.readFileSync(rollbackReplacement, 'utf8'), 'uncommitted trim');
    assert.strictEqual(fs.readdirSync(root).some(name => name.startsWith('.photoflow-trim-backup-')), false);

    process.stdout.write('Video trim commit tests passed.\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
