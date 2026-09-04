const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { componentTreeIdentityReceipt, inspectComponentArchive, reserveComponentInstallCapacity, snapshotComponentArchive, validateComponentTreeIdentityReceipt } = require('../electron/component-package-archive.cjs');
const { createComponentRegistry, readComponentPackageManifest } = require('../electron/component-registry.cjs');
const { verifyComponentPackage } = require('./verify-component-packages.cjs');
const { writeZip } = require('./test-helpers/zip-fixture.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-archive-parity-'));
const manifest = JSON.stringify({ apiVersion: 1, id: 'archive-parity', version: '1.0.0', platforms: [process.platform], architectures: [process.arch], entrypoints: { default: 'worker.cjs' }, requiredFiles: ['worker.cjs'] });
const archive = path.join(root, `PhotoFlow-archive-parity-1.0.0-${process.platform}-${process.arch}.zip`);
const base = () => [['pkg/component.json', manifest], ['pkg/worker.cjs', 'module.exports = true;']];
const rejection = fn => { try { fn(); return false; } catch { return true; } };

(async () => {
  try {
    assert.equal(validateComponentTreeIdentityReceipt(componentTreeIdentityReceipt([{ path: 'runtime', kind: 'directory', node: { dev: 1, ino: 2, birthtimeMs: 3 }, mode: 0o755 }])).schemaVersion, 1);
    assert.throws(() => validateComponentTreeIdentityReceipt({ schemaVersion: 0, entries: [] }), /版本/);
    writeZip(archive, base());
    const snapshot = path.join(root, 'snapshot.zip');
    const receipt = await snapshotComponentArchive(archive, snapshot);
    assert.equal(receipt.sha256, crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
    const inspected = inspectComponentArchive(snapshot, { inspectionToken: receipt.inspectionToken });
    assert.equal(inspected.manifest.id, 'archive-parity');
    assert.throws(() => inspectComponentArchive(archive, { inspectionToken: receipt.inspectionToken }), /令牌/);
    fs.copyFileSync(archive, `${snapshot}.replacement`); fs.renameSync(`${snapshot}.replacement`, snapshot);
    assert.throws(() => inspectComponentArchive(snapshot, { inspectionToken: receipt.inspectionToken }), /令牌/);
    assert.equal((await verifyComponentPackage(archive)).componentId, 'archive-parity');
    writeZip(archive, base().map(([name, value]) => [name, value, { dataDescriptor: true, descriptorSignature: name.endsWith('worker.cjs') }]));
    assert.equal(inspectComponentArchive(archive).manifest.id, 'archive-parity', 'signed and unsigned data descriptors are accepted when they match the central directory');

    const cases = [
      ['duplicate', [...base(), ['pkg/worker.cjs', 'again']]],
      ['case collision', [...base(), ['PKG/Worker.cjs', 'again']]],
      ['prefix collision', [['pkg', 'file'], ...base()]],
      ['local-central mismatch', [['pkg/component.json', manifest, { localName: 'other/component.json' }], ['pkg/worker.cjs', 'ok']]],
      ['CRC mismatch', [['pkg/component.json', manifest, { localCrc: 0, expectedCrc: 0 }], ['pkg/worker.cjs', 'ok']]],
      ['Windows ADS', [['pkg/component.json', manifest], ['pkg/worker.cjs:stream', 'bad']]],
      ['symlink mode', [['pkg/component.json', manifest], ['pkg/worker.cjs', 'target', { externalAttributes: (0xa000 << 16) >>> 0 }]]],
      ['bad descriptor', [['pkg/component.json', manifest, { dataDescriptor: true }], ['pkg/worker.cjs', 'ok', { dataDescriptor: true, descriptorCrc: 0 }]]],
    ];
    for (const [label, entries] of cases) {
      writeZip(archive, entries);
      assert.equal(rejection(() => inspectComponentArchive(archive)), true, `${label}: installer inspection must reject`);
      assert.equal(rejection(() => readComponentPackageManifest(archive)), true, `${label}: registry must reject identically`);
      await assert.rejects(verifyComponentPackage(archive), undefined, `${label}: release verifier must reject identically`);
    }

    writeZip(archive, base());
    await assert.rejects(snapshotComponentArchive(archive, path.join(root, 'aborted.zip'), { signal: AbortSignal.abort() }), /取消/);
    await assert.rejects(snapshotComponentArchive(archive, path.join(root, 'timed-out.zip'), { deadlineAt: Date.now() - 1 }), /超时/);
    const originalCreateWriteStream = fs.createWriteStream;
    fs.createWriteStream = () => new Transform({ transform() { /* Intentionally never completes a chunk. */ } });
    try { await assert.rejects(snapshotComponentArchive(archive, path.join(root, 'stalled.zip'), { timeoutMs: 20 }), /abort|取消|超时/i); }
    finally { fs.createWriteStream = originalCreateWriteStream; }
    writeZip(archive, [['pkg/component.json', manifest], ['pkg/worker.cjs', 'corrupt payload', { localCrc: 0, expectedCrc: 0 }]]);
    assert.equal(inspectComponentArchive(archive).manifest.id, 'archive-parity');
    const registry = createComponentRegistry({ projectRoot: path.resolve(__dirname, '..'), userComponentRoot: root, isPackaged: true, platform: process.platform, arch: process.arch });
    assert.equal(registry.resolvePackage('archive-parity').packageInspectionStatus, 'manifest-bounded');
    await assert.rejects(verifyComponentPackage(archive), /CRC-32/);

    const volume = await fs.promises.statfs(root, { bigint: true });
    const moreThanHalf = Number((volume.bavail * volume.bsize / 2n) + 1n);
    if (Number.isSafeInteger(moreThanHalf) && moreThanHalf > 0) {
      const competing = await Promise.allSettled([reserveComponentInstallCapacity(root, moreThanHalf), reserveComponentInstallCapacity(root, moreThanHalf)]);
      assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1, 'same-volume reservations are serialized atomically');
      assert.match(competing.find(result => result.status === 'rejected').reason.message, /容量已被其他安装预留/);
      await competing.find(result => result.status === 'fulfilled').value.release();
    }
    const logicalPayload = Buffer.alloc(100 * 1024 * 1024, 0x61);
    const benchmarkArchives = Array.from({ length: 3 }, (_, index) => path.join(root, `benchmark-${index}.zip`));
    for (const target of benchmarkArchives) writeZip(target, [['pkg/component.json', manifest], ['pkg/model.bin', logicalPayload, { method: 8 }], ['pkg/worker.cjs', 'ok']]);
    const benchmarkStart = performance.now();
    for (const target of benchmarkArchives) assert.equal(inspectComponentArchive(target).totalUncompressedBytes > 100 * 1024 * 1024, true);
    const benchmarkMs = performance.now() - benchmarkStart;
    assert(benchmarkMs < 5_000, `bounded inspection of three ~100 MiB logical packages regressed: ${Math.round(benchmarkMs)} ms`);
    console.log('Component archive parser parity tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
