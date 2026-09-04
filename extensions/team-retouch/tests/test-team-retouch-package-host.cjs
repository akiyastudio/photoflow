const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { INPUT_ARTIFACTS, PAIR_COMMIT, SAM_COMMIT, hashFile, validateInputLock, validateReleaseLock } = require('../scripts/advanced-release-validator.cjs');
const host = require('../scripts/package-host.cjs');

const sourceRoot = path.resolve(__dirname, '..');
const componentSource = fs.readFileSync(path.join(sourceRoot, 'scripts', 'package-component.cjs'), 'utf8');
const validatorSource = fs.readFileSync(path.join(sourceRoot, 'scripts', 'advanced-release-validator.cjs'), 'utf8');
assert.match(componentSource, /Buffer\.allocUnsafe\(8 \* 1024 \* 1024\)/);
assert.match(validatorSource, /Buffer\.allocUnsafe\(8 \* 1024 \* 1024\)/);
assert.doesNotMatch(componentSource, /update\(fs\.readFileSync\(advancedPackageSource\)\)/);
assert.throws(() => host.parseArguments(['--skip-checks']), /Unknown/);
const output = path.join(os.tmpdir(), 'team-retouch-output');
assert.deepEqual(host.componentArguments(host.parseArguments(['--output-dir', output]).outputDirectory).slice(-2), ['--output-dir', path.resolve(output)]);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-release-lock-'));
try {
  for (const [index, relative] of INPUT_ARTIFACTS.entries()) {
    const target = path.join(temporary, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `reviewed fixture ${index}`);
  }
  fs.writeFileSync(path.join(temporary, 'advanced/locks/checkpoints.sha256'), `${'1'.repeat(64)}  checkpoints/pairdetr/pytorch_model.bin\n${'2'.repeat(64)}  checkpoints/sam2/sam2.1_hiera_large.pt\n`);
  const packageRelative = 'dist/PhotoFlow-team-retouch-advanced-1.2.3-win32-x64.zip';
  const packagePath = path.join(temporary, packageRelative); fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  const handle = fs.openSync(packagePath, 'w'); fs.writeSync(handle, Buffer.from('ZIP')); fs.writeSync(handle, Buffer.from([1]), 0, 1, 24 * 1024 * 1024 - 1); fs.closeSync(handle);
  const artifacts = INPUT_ARTIFACTS.map(relative => ({ path: relative, sha256: hashFile(path.join(temporary, relative)) }));
  const base = { schemaVersion: 1, componentId: 'team-retouch', componentVersion: '1.2.3', advancedRuntimeApiVersion: 1, pairDetrCommit: PAIR_COMMIT, sam2Commit: SAM_COMMIT, artifacts };
  const inputPath = path.join(temporary, 'advanced/build-input-lock.json'); fs.writeFileSync(inputPath, JSON.stringify(base));
  assert.equal(validateInputLock(temporary, inputPath, { componentVersion: '1.2.3', advancedRuntimeApiVersion: 1 }).artifacts.length, INPUT_ARTIFACTS.length);
  const releasePath = path.join(temporary, 'advanced/release-lock.json');
  const release = { ...base, advancedPackage: { path: packageRelative, sha256: hashFile(packagePath) } }; fs.writeFileSync(releasePath, JSON.stringify(release));
  assert.equal(validateReleaseLock(temporary, releasePath, { componentVersion: '1.2.3', advancedRuntimeApiVersion: 1 }, packagePath, packageRelative).advancedPackage.sha256, hashFile(packagePath));
  for (const invalid of [
    { ...release, advancedPackage: { path: packageRelative, sha256: '0'.repeat(64) } },
    { ...release, advancedPackage: { path: packageRelative } },
    { ...release, artifacts: artifacts.slice(1) },
    { ...release, artifacts: [...artifacts.slice(0, -1), artifacts[0]] },
    { ...release, artifacts: [{ ...artifacts[0], path: 'advanced/locks/unknown.lock' }, ...artifacts.slice(1)] },
  ]) {
    fs.writeFileSync(releasePath, JSON.stringify(invalid));
    assert.throws(() => validateReleaseLock(temporary, releasePath, { componentVersion: '1.2.3', advancedRuntimeApiVersion: 1 }, packagePath, packageRelative));
  }
  fs.writeFileSync(path.join(temporary, INPUT_ARTIFACTS[0]), ''); fs.writeFileSync(releasePath, JSON.stringify(release));
  assert.throws(() => validateReleaseLock(temporary, releasePath, { componentVersion: '1.2.3', advancedRuntimeApiVersion: 1 }, packagePath, packageRelative), /empty/);
  fs.writeFileSync(path.join(temporary, INPUT_ARTIFACTS[0]), 'tampered'); fs.writeFileSync(releasePath, JSON.stringify(release));
  assert.throws(() => validateReleaseLock(temporary, releasePath, { componentVersion: '1.2.3', advancedRuntimeApiVersion: 1 }, packagePath, packageRelative), /checksum/);
  console.log('Team-retouch strict advanced release lock and output-dir tests passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
