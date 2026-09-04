const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const hostScript = path.join(root, 'scripts', 'package-host.cjs');
const componentSource = fs.readFileSync(path.join(root, 'scripts', 'package-component.cjs'), 'utf8');
const hostSource = fs.readFileSync(hostScript, 'utf8');
assert.match(componentSource, /Buffer\.allocUnsafe\(8 \* 1024 \* 1024\)/);
assert.match(hostSource, /Buffer\.allocUnsafe\(8 \* 1024 \* 1024\)/);
assert.doesNotMatch(componentSource, /update\(fs\.readFileSync\(advancedPackageSource\)\)/);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-large-hash-'));
try {
  const largeZip = path.join(temporary, 'fixture.zip');
  const handle = fs.openSync(largeZip, 'w');
  fs.writeSync(handle, Buffer.from('ZIP-FIXTURE'));
  fs.writeSync(handle, Buffer.from([1]), 0, 1, 24 * 1024 * 1024 - 1);
  fs.closeSync(handle);
  const expected = crypto.createHash('sha256');
  const stream = fs.createReadStream(largeZip);
  stream.on('data', chunk => expected.update(chunk));
  stream.on('end', () => {
    const original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (String(file).toLowerCase().endsWith('.zip')) throw new Error('whole ZIP read forbidden');
      return original.call(this, file, ...args);
    };
    try {
      delete require.cache[require.resolve('../scripts/package-host.cjs')];
      const { hashFile, validateBundle } = require('../scripts/package-host.cjs');
      assert.equal(hashFile(largeZip), expected.digest('hex'));
      const component = path.join(temporary, 'component'); fs.mkdirSync(component);
      const embedded = path.join(component, 'small-advanced.zip'); fs.writeFileSync(embedded, 'small trusted ZIP fixture');
      const digest = hashFile(embedded);
      fs.writeFileSync(path.join(component, 'component.json'), JSON.stringify({advancedRuntime:{offlinePackage:{path:'small-advanced.zip',sha256:digest}},requiredFiles:['small-advanced.zip']}));
      validateBundle(digest, component, 'small-advanced.zip');
    } finally { fs.readFileSync = original; }
    const rejected = spawnSync(process.execPath, [hostScript, '--unknown'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /Unknown package:host argument/);
    console.log('Team-retouch Host packaging streaming and argument tests passed');
    fs.rmSync(temporary, { recursive: true, force: true });
  });
} catch (error) {
  fs.rmSync(temporary, { recursive: true, force: true });
  throw error;
}
