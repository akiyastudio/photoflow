const fs = require('fs');
const path = require('path');

function comparablePath(filePath, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalized = pathApi.resolve(filePath);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsReferToSameLocation(left, right, platform = process.platform) {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

function assertPrivateVenvRoot(venvRoot, { fsImpl = fs, platform = process.platform } = {}) {
  const declaredPath = path.resolve(venvRoot);
  let stats;
  try {
    stats = fsImpl.lstatSync(declaredPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { declaredPath, exists: false };
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing linked private Python environment root: ${declaredPath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Private Python environment root is not a directory: ${declaredPath}`);
  }

  const realpath = fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(declaredPath)
    : fsImpl.realpathSync(declaredPath);
  if (!pathsReferToSameLocation(realpath, declaredPath, platform)) {
    throw new Error(`Refusing redirected private Python environment root: ${declaredPath} -> ${realpath}`);
  }
  return { declaredPath, exists: true };
}

module.exports = { assertPrivateVenvRoot, pathsReferToSameLocation };
