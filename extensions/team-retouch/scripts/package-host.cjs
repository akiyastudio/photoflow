const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const template = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
const packageName = `PhotoFlow-team-retouch-advanced-${template.version}-win32-x64.zip`;
const packagePath = path.join(root, 'dist', packageName);
const lockPath = path.join(root, 'advanced', 'release-lock.json');

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try { for (;;) { const count = fs.readSync(handle, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } }
  finally { fs.closeSync(handle); }
  return hash.digest('hex');
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`${command} failed with code ${result.status}`);
}
function validateReleaseLock() {
  if (!fs.existsSync(lockPath)) throw new Error('Reviewed advanced dependency/checkpoint lock is missing; Host packaging is fail-closed.');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.version !== 1 || lock.componentVersion !== template.version || !Array.isArray(lock.artifacts) || !lock.artifacts.length || lock.artifacts.some(item => !item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(String(item.sha256 || '')))) throw new Error('Advanced release lock is incomplete or does not match this component version.');
  return lock;
}
function validateReleaseInputs(lock = validateReleaseLock()) {
  if (!fs.existsSync(packagePath)) throw new Error(`Trusted advanced package is missing: ${packagePath}`);
  const digest = hashFile(packagePath);
  if (lock.advancedPackageSha256 && lock.advancedPackageSha256 !== digest) throw new Error('Advanced ZIP does not match the reviewed release lock.');
  return { lock, digest };
}
function validateBundle(expectedDigest, componentRoot = path.join(root, 'dist', 'component'), expectedPackageName = packageName) {
  const manifestPath = path.join(componentRoot, 'component.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const declared = manifest.advancedRuntime?.offlinePackage;
  if (!declared || declared.path !== expectedPackageName || declared.sha256 !== expectedDigest) throw new Error('Final component manifest does not bind the trusted advanced ZIP.');
  if (!manifest.requiredFiles.includes(expectedPackageName) || !fs.existsSync(path.join(componentRoot, expectedPackageName))) throw new Error('Final component bundle is missing its declared advanced ZIP.');
}

if (require.main === module) {
  const allowed = new Set(['--output-dir','--skip-checks']);
  let outputDirectory = '';
  let skipChecks = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (!allowed.has(value)) throw new Error(`Unknown package:host argument: ${value}`);
    if (value === '--skip-checks') skipChecks = true;
    else {
      if (index + 1 >= process.argv.length || process.argv[index + 1].startsWith('--')) throw new Error('--output-dir requires a path');
      outputDirectory = path.resolve(process.argv[++index]);
    }
  }
  const lock = validateReleaseLock();
  if (!fs.existsSync(packagePath)) run(process.execPath, [path.join(__dirname, 'build-advanced-package.cjs')]);
  const { digest } = validateReleaseInputs(lock);
  const componentArgs = [path.join(__dirname, 'package-component.cjs'), '--with-advanced'];
  if (skipChecks) componentArgs.push('--skip-checks');
  if (outputDirectory) componentArgs.push('--output-dir', outputDirectory);
  run(process.execPath, componentArgs);
  validateBundle(digest);
  console.log(`Host bundle verified with trusted advanced package ${packageName} (${digest})`);
}
module.exports = { hashFile, validateReleaseLock, validateReleaseInputs, validateBundle, packageName, packagePath, lockPath };
