const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyComponentPackage } = require('./verify-component-packages.cjs');
const { writeZip } = require('./test-helpers/zip-fixture.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-verifier-test-'));
const source = path.join(root, 'sample');
const archive = path.join(root, `PhotoFlow-verifier-fixture-1.2.3-${process.platform}-${process.arch}.zip`);
const manifest = { apiVersion: 1, id: 'verifier-fixture', version: '1.2.3', platforms: [process.platform], architectures: [process.arch], entrypoints: { default: 'worker.cjs' }, requiredFiles: ['worker.cjs'] };

const zip = writeZip;
const expectFailure = async (target, pattern) => assert.rejects(verifyComponentPackage(target), pattern);

(async () => {
  try {
    fs.mkdirSync(source, { recursive: true });
    const goodEntries = [['sample/component.json', JSON.stringify(manifest)], ['sample/worker.cjs', 'module.exports = true;']];
    zip(archive, goodEntries);
    const result = await verifyComponentPackage(archive);
    assert.equal(result.componentId, manifest.id);

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

    const wrongName = path.join(root, `PhotoFlow-wrong-id-1.2.3-${process.platform}-${process.arch}.zip`);
    zip(wrongName, goodEntries);
    await expectFailure(wrongName, /文件名身份不匹配/);

    const emptyRoot = path.join(root, 'empty');
    fs.mkdirSync(emptyRoot);
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'verify-component-packages.cjs'), '--package-root', emptyRoot], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0);
    assert.match(`${cli.stdout}\n${cli.stderr}`, /组件包缺失/);
    console.log('Component package verifier tests passed.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
