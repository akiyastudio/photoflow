const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const INPUT_ARTIFACTS = Object.freeze([
  'advanced/locks/pairdetr-requirements.lock',
  'advanced/locks/sam2-requirements.lock',
  'advanced/locks/checkpoints.sha256',
  'advanced/source-metadata.json',
  'advanced/pairdetr_service.py',
  'advanced/sam2_service.py',
  'advanced_geometry.py',
  'checkpoint_lock.py',
  'image_safety.py',
  'scripts/setup-advanced-wsl.sh',
  'scripts/create-advanced-offline-package.ps1',
]);
const PAIR_COMMIT = 'fbcdebdff44bb5e9e6a9d92240ff01f8eec30ebc';
const SAM_COMMIT = '2b90b9f5ceec907a1c18123530e92e794ad901a4';
const CHECKPOINT_PATHS = Object.freeze(['checkpoints/pairdetr/pytorch_model.bin','checkpoints/sam2/sam2.1_hiera_large.pt']);
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\n') !== [...keys].sort().join('\n')) throw new Error(`${label} schema is not exact.`);
};
const hashFile = file => {
  const hash = crypto.createHash('sha256'); const handle = fs.openSync(file, 'r'); const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try { for (;;) { const count = fs.readSync(handle, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } } finally { fs.closeSync(handle); }
  return hash.digest('hex');
};
function validateArtifact(root, item, allowed) {
  exactKeys(item, ['path','sha256'], 'Advanced artifact');
  if (!allowed.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`Advanced artifact is not allowlisted or hashed: ${item.path}`);
  const target = path.resolve(root, item.path); const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Advanced artifact escaped the source root: ${item.path}`);
  const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error(`Advanced artifact is missing, empty, or linked: ${item.path}`);
  if (hashFile(target) !== item.sha256) throw new Error(`Advanced artifact checksum mismatch: ${item.path}`);
}
function validateInputObject(root, lock, expected) {
  exactKeys(lock, ['schemaVersion','componentId','componentVersion','advancedRuntimeApiVersion','pairDetrCommit','sam2Commit','artifacts'], 'Advanced input lock');
  if (lock.schemaVersion !== 1 || lock.componentId !== 'team-retouch' || lock.componentVersion !== expected.componentVersion || lock.advancedRuntimeApiVersion !== expected.advancedRuntimeApiVersion || lock.pairDetrCommit !== PAIR_COMMIT || lock.sam2Commit !== SAM_COMMIT) throw new Error('Advanced input lock identity or pinned commits do not match.');
  if (!Array.isArray(lock.artifacts) || lock.artifacts.length !== INPUT_ARTIFACTS.length) throw new Error('Advanced input lock artifact set is incomplete.');
  const paths = lock.artifacts.map(item => item?.path); if (new Set(paths).size !== paths.length) throw new Error('Advanced input lock contains duplicate artifacts.');
  const allowed = new Set(INPUT_ARTIFACTS); for (const required of allowed) if (!paths.includes(required)) throw new Error(`Advanced input lock is missing ${required}`);
  for (const item of lock.artifacts) validateArtifact(root, item, allowed);
  const checkpointLines = fs.readFileSync(path.join(root, 'advanced/locks/checkpoints.sha256'), 'utf8').trim().split(/\r?\n/);
  const checkpointPaths = checkpointLines.map(line => { const match = /^([a-f0-9]{64})  ([^\s]+)$/.exec(line); if (!match) throw new Error('Checkpoint lock line is malformed.'); return match[2]; });
  if (checkpointPaths.length !== CHECKPOINT_PATHS.length || new Set(checkpointPaths).size !== checkpointPaths.length || CHECKPOINT_PATHS.some(required => !checkpointPaths.includes(required))) throw new Error('Checkpoint lock does not contain the exact canonical paths.');
  return lock;
}
function validateInputLock(root, lockPath, expected) {
  const lockStat = fs.lstatSync(lockPath); if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.size <= 0) throw new Error('Advanced input lock is missing, empty, or linked.');
  return validateInputObject(root, JSON.parse(fs.readFileSync(lockPath, 'utf8')), expected);
}
function validateReleaseLock(root, lockPath, expected, packagePath, packageRelativePath) {
  const lockStat = fs.lstatSync(lockPath); if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.size <= 0) throw new Error('Advanced release lock is missing, empty, or linked.');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  exactKeys(lock, ['schemaVersion','componentId','componentVersion','advancedRuntimeApiVersion','pairDetrCommit','sam2Commit','artifacts','advancedPackage'], 'Advanced release lock');
  const inputCopy = { ...lock }; delete inputCopy.advancedPackage;
  validateInputObject(root, inputCopy, expected);
  exactKeys(lock.advancedPackage, ['path','sha256'], 'Advanced package');
  if (lock.advancedPackage.path !== packageRelativePath || !/^[a-f0-9]{64}$/.test(lock.advancedPackage.sha256)) throw new Error('Advanced package path or digest is not canonical.');
  if (path.resolve(packagePath) !== path.resolve(root, packageRelativePath)) throw new Error('Advanced package resolved outside its canonical release path.');
  const stat = fs.lstatSync(packagePath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || hashFile(packagePath) !== lock.advancedPackage.sha256) throw new Error('Prebuilt advanced package is missing, linked, empty, or does not match its mandatory digest.');
  return lock;
}
module.exports = { INPUT_ARTIFACTS, PAIR_COMMIT, SAM_COMMIT, hashFile, validateInputLock, validateReleaseLock };
