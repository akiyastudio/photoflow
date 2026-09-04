const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canonical = require('../electron/component-integrity.cjs');
const vendored = require('../extensions/video-playback-mpv/scripts/vendor/component-integrity.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-integrity-parity-'));

(async () => {
  try {
    fs.writeFileSync(path.join(root, 'component.json'), '{}');
    fs.writeFileSync(path.join(root, 'worker.exe'), 'binary');
    assert.deepEqual(Object.keys(vendored).sort(), Object.keys(canonical).sort(), 'vendored integrity API must match the host API');
    const expected = canonical.createComponentIntegrityManifest(root, 'fixture', '1.0.0');
    assert.deepEqual(vendored.createComponentIntegrityManifest(root, 'fixture', '1.0.0'), expected, 'builders must cover the same files and hashes');
    fs.writeFileSync(path.join(root, 'component-integrity.json'), JSON.stringify(expected));
    assert.equal(canonical.validateComponentIntegrity(root, expected), vendored.validateComponentIntegrity(root, expected));
    assert.equal(await canonical.validateComponentIntegrityAsync(root, expected), await vendored.validateComponentIntegrityAsync(root, expected));
    const duplicate = { ...expected, files: [...expected.files, { ...expected.files[0] }] };
    for (const implementation of [canonical, vendored]) {
      assert.throws(() => implementation.validateComponentIntegrity(root, duplicate, { requireLocalManifest: false }), /重复|冲突/);
      await assert.rejects(implementation.validateComponentIntegrityAsync(root, duplicate, { requireLocalManifest: false }), /重复|冲突/);
    }
    console.log('Host and vendored component integrity parity tests passed.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
