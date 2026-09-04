const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyComponentPackage, verifyComponentPackageReceipt, writeVerificationReceipt, receiptPathFor, captureArtifactIdentity, assertSourceIdentity } = require('./verify-component-packages.cjs');
const { writeZip } = require('./test-helpers/zip-fixture.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-verifier-test-'));
const source = path.join(root, 'sample');
const archive = path.join(root, `PhotoFlow-verifier-fixture-1.2.3-${process.platform}-${process.arch}.zip`);
const manifest = { apiVersion: 1, id: 'verifier-fixture', version: '1.2.3', platforms: [process.platform], architectures: [process.arch], entrypoints: { default: 'worker.cjs' }, requiredFiles: ['worker.cjs'] };

const zip = writeZip;
const expectFailure = async (target, pattern) => assert.rejects(verifyComponentPackage(target), pattern);
const findCentralEntry = (image, entryName) => {
  const expectedName = Buffer.from(entryName);
  for (let offset = 0; offset + 46 <= image.length; offset += 1) {
    if (image.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = image.readUInt16LE(offset + 28);
    if (nameLength === expectedName.length && image.subarray(offset + 46, offset + 46 + nameLength).equals(expectedName)) return offset;
  }
  throw new Error(`Missing central entry: ${entryName}`);
};
const rewriteDeclaredSize = (target, entryName, size, { local = true } = {}) => {
  const image = fs.readFileSync(target);
  const centralOffset = findCentralEntry(image, entryName);
  image.writeUInt32LE(size, centralOffset + 24);
  if (local) image.writeUInt32LE(size, image.readUInt32LE(centralOffset + 42) + 22);
  fs.writeFileSync(target, image);
};
const verifierTemporaryDirectories = () => new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('photoflow-component-verify-')));

(async () => {
  try {
    fs.mkdirSync(source, { recursive: true });
    const goodEntries = [['sample/component.json', JSON.stringify(manifest)], ['sample/worker.cjs', 'module.exports = true;']];
    zip(archive, goodEntries);
    const result = await verifyComponentPackage(archive);
    assert.equal(result.componentId, manifest.id);
    const expectedReceiptIdentity = { id: manifest.id, version: manifest.version, platform: process.platform, arch: process.arch };
    await assert.rejects(verifyComponentPackageReceipt(archive, expectedReceiptIdentity), /回执缺失/);
    writeVerificationReceipt(archive, { ...result, buildCommit: 'a'.repeat(40) });
    const receiptVerified = await verifyComponentPackageReceipt(archive, expectedReceiptIdentity);
    const { sourceIdentity: _sourceIdentity, ...publicResult } = result;
    assert.deepEqual({ fileName: receiptVerified.fileName, size: receiptVerified.size, sha256: receiptVerified.sha256, componentId: receiptVerified.componentId, version: receiptVerified.version, platform: receiptVerified.platform, arch: receiptVerified.arch }, publicResult);
    assert.equal(receiptVerified.verificationReceipt.status, 'passed');
    const receiptPath = receiptPathFor(archive);
    const alteredReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    alteredReceipt.archive.sha256 = '0'.repeat(64);
    fs.writeFileSync(receiptPath, JSON.stringify(alteredReceipt));
    await assert.rejects(verifyComponentPackageReceipt(archive, expectedReceiptIdentity), /审计回执不一致|必须重新完整验证/);
    fs.rmSync(receiptPath);

    const integrityManifest = { ...manifest, integrity: 'component-integrity.json' };
    const integrityText = JSON.stringify({
      schemaVersion: 1,
      componentId: manifest.id,
      version: manifest.version,
      files: [
        ['component.json', JSON.stringify(integrityManifest)],
        ['worker.cjs', 'module.exports = true;'],
      ].map(([file, value]) => ({ file, sizeBytes: Buffer.byteLength(value), sha256: crypto.createHash('sha256').update(value).digest('hex') })),
    });
    zip(archive, [['sample/component.json', JSON.stringify(integrityManifest)], ['sample/worker.cjs', 'module.exports = null;'], ['sample/component-integrity.json', integrityText]]);
    await expectFailure(archive, /SHA-256 不匹配/);

    zip(archive, [['sample/component.json', JSON.stringify(manifest)], ['sample/worker.cjs', 'tampered']]);
    const tampered = fs.readFileSync(archive); tampered[Math.floor(tampered.length / 3)] ^= 0xff; fs.writeFileSync(archive, tampered);
    await expectFailure(archive, /校验|损坏|invalid|inflate|data/i);

    zip(archive, [['sample/component.json', JSON.stringify(manifest)]]);
    await expectFailure(archive, /缺少组件文件/);

    zip(archive, [...goodEntries, ['sample/worker.cjs', 'duplicate']]);
    await expectFailure(archive, /重复|冲突/);

    zip(archive, [['sample/child/file.txt', 'child'], ['sample/child', 'file collision'], ...goodEntries]);
    await expectFailure(archive, /文件\/目录碰撞/);

    zip(archive, [['sample/component.json', JSON.stringify(manifest)], ['sample/worker.cjs', 'A'.repeat(1024 * 1024), { method: 8 }]]);
    rewriteDeclaredSize(archive, 'sample/worker.cjs', 1, { local: false });
    await expectFailure(archive, /本地条目大小或校验值与中央目录不一致/);

    zip(archive, [['sample/component.json', JSON.stringify(manifest)], ['sample/worker.cjs', 'A'.repeat(1024 * 1024), { method: 8 }]]);
    rewriteDeclaredSize(archive, 'sample/worker.cjs', 1);
    const temporaryBefore = verifierTemporaryDirectories();
    await expectFailure(archive, /实际展开大小超过声明或安全上限/);
    assert.deepEqual(verifierTemporaryDirectories(), temporaryBefore, 'failed bounded extraction must clean its temporary snapshot and output');

    const wrongName = path.join(root, `PhotoFlow-wrong-id-1.2.3-${process.platform}-${process.arch}.zip`);
    zip(wrongName, goodEntries);
    await expectFailure(wrongName, /文件名身份不匹配/);

    const fakeArchive = path.join(root, `PhotoFlow-forged-receipt-1.0.0-${process.platform}-${process.arch}.zip`);
    const fakeBytes = Buffer.alloc(46, 0x41);
    fs.writeFileSync(fakeArchive, fakeBytes);
    writeVerificationReceipt(fakeArchive, { fileName: path.basename(fakeArchive), size: fakeBytes.length, sha256: crypto.createHash('sha256').update(fakeBytes).digest('hex'), componentId: 'forged-receipt', version: '1.0.0', platform: process.platform, arch: process.arch, buildCommit: 'a'.repeat(40) });
    await assert.rejects(verifyComponentPackageReceipt(fakeArchive, { id: 'forged-receipt', version: '1.0.0', platform: process.platform, arch: process.arch }), /ZIP|组件包/);

    const fencedInstaller = path.join(root, 'Setup.exe');
    fs.writeFileSync(fencedInstaller, 'approved bytes');
    const approvedIdentity = captureArtifactIdentity(fencedInstaller);
    const replacement = path.join(root, 'replacement.exe');
    fs.writeFileSync(replacement, 'different final bytes');
    fs.renameSync(replacement, fencedInstaller);
    assert.throws(() => assertSourceIdentity(fencedInstaller, approvedIdentity), /替换或修改/);

    const emptyRoot = path.join(root, 'empty');
    fs.mkdirSync(emptyRoot);
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'verify-component-packages.cjs'), '--package-root', emptyRoot], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0);
    assert.match(`${cli.stdout}\n${cli.stderr}`, /组件包缺失/);
    console.log('Component package verifier tests passed.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
