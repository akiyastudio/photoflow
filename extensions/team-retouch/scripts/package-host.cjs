const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashFile, validateReleaseLock: validateStrictReleaseLock } = require('./advanced-release-validator.cjs');

const root = path.resolve(__dirname, '..');
const template = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
const packageName = `PhotoFlow-team-retouch-advanced-${template.version}-win32-x64.zip`;
const packagePath = path.join(root, 'dist', packageName);
const lockPath = path.join(root, 'advanced', 'release-lock.json');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`${command} failed with code ${result.status}`);
}
function validateReleaseLock() {
  if (!fs.existsSync(lockPath)) throw new Error('Reviewed advanced dependency/checkpoint lock is missing; Host packaging is fail-closed.');
  return validateStrictReleaseLock(root, lockPath, { componentVersion: template.version, advancedRuntimeApiVersion: Number(template.advancedRuntime.apiVersion) }, packagePath, `dist/${packageName}`);
}
function validateReleaseInputs(lock = validateReleaseLock()) {
  if (!fs.existsSync(packagePath)) throw new Error(`Trusted advanced package is missing: ${packagePath}`);
  const digest = hashFile(packagePath);
  if (lock.advancedPackage.sha256 !== digest) throw new Error('Advanced ZIP does not match the reviewed release lock.');
  return { lock, digest };
}
function validateBundle(expectedDigest, componentRoot = path.join(root, 'dist', 'component'), expectedPackageName = packageName) {
  const manifestPath = path.join(componentRoot, 'component.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const declared = manifest.advancedRuntime?.offlinePackage;
  if (!declared || declared.path !== expectedPackageName || declared.sha256 !== expectedDigest) throw new Error('Final component manifest does not bind the trusted advanced ZIP.');
  if (!manifest.requiredFiles.includes(expectedPackageName) || !fs.existsSync(path.join(componentRoot, expectedPackageName))) throw new Error('Final component bundle is missing its declared advanced ZIP.');
}
function parseArguments(values) {
  let outputDirectory = '';
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== '--output-dir') throw new Error(`Unknown package:host argument: ${value}`);
    if (index + 1 >= values.length || values[index + 1].startsWith('--')) throw new Error('--output-dir requires a path');
    outputDirectory = path.resolve(values[++index]);
  }
  return { outputDirectory };
}
const componentArguments = outputDirectory => [path.join(__dirname, 'package-component.cjs'), '--with-advanced', ...(outputDirectory ? ['--output-dir', outputDirectory] : [])];

if (require.main === module) {
  const { outputDirectory } = parseArguments(process.argv.slice(2));
  const lock = validateReleaseLock();
  const { digest } = validateReleaseInputs(lock);
  run(process.execPath, [path.join(__dirname, 'setup-python.cjs')]);
  run(process.execPath, componentArguments(outputDirectory));
  validateBundle(digest);
  console.log(`Host bundle verified with trusted advanced package ${packageName} (${digest})`);
}
module.exports = { hashFile, validateReleaseLock, validateReleaseInputs, validateBundle, parseArguments, componentArguments, packageName, packagePath, lockPath };
