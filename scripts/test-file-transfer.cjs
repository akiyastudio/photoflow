const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CANCELLED_CODE,
  DEFAULT_SMALL_FILE_CONCURRENCY,
  assertInside,
  collectCopyPlan,
  copyFileAtomic,
  copyPlannedFiles,
  moveFileAtomic,
  removeCreatedPasteTargets,
  uniqueDestination,
} = require('../electron/services/file-transfer-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-transfer-test-'));

const run = async () => {
  try {
    const source = path.join(root, 'source.bin');
    const copy = path.join(root, 'copy.bin');
    fs.writeFileSync(source, Buffer.alloc(8 * 1024 * 1024, 0x5a));
    let lastProgress = 0;
    await copyFileAtomic(source, copy, { onProgress: value => { lastProgress = value.bytesCopied; } });
    assert.strictEqual(lastProgress, fs.statSync(source).size);
    assert.deepStrictEqual(fs.readFileSync(copy), fs.readFileSync(source));

    const moveSource = path.join(root, 'move-source.bin');
    const moveTarget = path.join(root, 'move-target.bin');
    fs.writeFileSync(moveSource, 'move');
    await moveFileAtomic(moveSource, moveTarget);
    assert.strictEqual(fs.existsSync(moveSource), false);
    assert.strictEqual(fs.readFileSync(moveTarget, 'utf8'), 'move');

    const cancelSource = path.join(root, 'cancel-source.bin');
    const cancelTarget = path.join(root, 'cancel-target.bin');
    fs.writeFileSync(cancelSource, Buffer.alloc(12 * 1024 * 1024, 0x3c));
    let cancel = false;
    await assert.rejects(
      copyFileAtomic(cancelSource, cancelTarget, {
        isCancelled: () => cancel,
        onProgress: value => { if (value.bytesCopied >= 4 * 1024 * 1024) cancel = true; },
      }),
      error => error.code === CANCELLED_CODE,
    );
    assert.strictEqual(fs.existsSync(cancelTarget), false);
    assert.strictEqual(fs.readdirSync(root).some(name => name.endsWith('.photoflow-part')), false);

    const batchSource = path.join(root, 'batch-source');
    const batchTarget = path.join(root, 'batch-target');
    fs.mkdirSync(path.join(batchSource, 'nested', 'empty'), { recursive: true });
    for (let index = 0; index < 96; index += 1) {
      const directory = index % 2 ? batchSource : path.join(batchSource, 'nested');
      fs.writeFileSync(path.join(directory, `small-${index}.bin`), Buffer.alloc(8 * 1024, index));
    }
    fs.writeFileSync(path.join(batchSource, 'large.bin'), Buffer.alloc(3 * 1024 * 1024, 0x4b));
    const batchPlan = [];
    await collectCopyPlan(batchSource, batchTarget, batchPlan);
    let batchBytesCopied = 0;
    let batchFilesCopied = 0;
    const batchCreated = [];
    const batchStats = await copyPlannedFiles(batchPlan, {
      destinationRoot: root,
      onCreated: target => batchCreated.push(target),
      onProgress: progress => {
        batchBytesCopied += progress.bytesDelta;
        if (progress.fileCompleted) batchFilesCopied += 1;
      },
    });
    assert.strictEqual(batchStats.smallFilesCopied, 96);
    assert.strictEqual(batchStats.largeFilesCopied, 1);
    assert.strictEqual(batchStats.peakSmallConcurrency, DEFAULT_SMALL_FILE_CONCURRENCY);
    assert.strictEqual(batchFilesCopied, 97);
    assert.strictEqual(batchBytesCopied, batchPlan.reduce((sum, entry) => sum + entry.size, 0));
    assert(batchCreated.includes(batchTarget));
    assert.strictEqual(fs.readFileSync(path.join(batchTarget, 'nested', 'small-0.bin'))[0], 0);
    assert.strictEqual(fs.statSync(path.join(batchTarget, 'large.bin')).size, 3 * 1024 * 1024);
    assert(fs.statSync(path.join(batchTarget, 'nested', 'empty')).isDirectory());

    const cancelBatchSource = path.join(root, 'cancel-batch-source');
    const cancelBatchTarget = path.join(root, 'cancel-batch-target');
    fs.mkdirSync(cancelBatchSource);
    for (let index = 0; index < 32; index += 1) {
      fs.writeFileSync(path.join(cancelBatchSource, `small-${index}.bin`), Buffer.alloc(512 * 1024, index));
    }
    const cancelBatchPlan = [];
    await collectCopyPlan(cancelBatchSource, cancelBatchTarget, cancelBatchPlan);
    let cancelBatch = false;
    await assert.rejects(
      copyPlannedFiles(cancelBatchPlan, {
        isCancelled: () => cancelBatch,
        onProgress: progress => { if (progress.fileCompleted) cancelBatch = true; },
      }),
      error => error.code === CANCELLED_CODE,
    );
    assert.strictEqual(fs.readdirSync(root, { recursive: true }).some(name => String(name).endsWith('.photoflow-part')), false);
    await removeCreatedPasteTargets([cancelBatchTarget]);
    assert.strictEqual(fs.existsSync(cancelBatchTarget), false);

    assert.strictEqual(assertInside(root, path.join(root, 'child'), 'test'), path.join(root, 'child'));
    assert.throws(() => assertInside(root, path.join(root, '..', 'outside'), 'test'), /超出允许的目录/);
    const reserved = new Set();
    const first = uniqueDestination(root, 'new.jpg', reserved);
    const second = uniqueDestination(root, 'new.jpg', reserved);
    assert.notStrictEqual(first, second);
    console.log('file transfer service tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
