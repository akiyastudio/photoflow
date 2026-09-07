const path = require('node:path');
const componentRoot = path.resolve(__dirname, '..');
const installersRoot = path.resolve(componentRoot, '..', '..', 'artifacts', 'installers');
const advancedRuntimeRoot = path.join(installersRoot, 'advanced-runtime');
const advancedPackagePath = name => path.join(advancedRuntimeRoot, name);
const advancedPackageRelativePath = name => path.relative(componentRoot, advancedPackagePath(name)).split(path.sep).join('/');
const advancedReleaseLockPath = version => path.join(installersRoot, 'metadata', `team-retouch-advanced-${version}.release-lock.json`);
const advancedPackageVersion = manifest => {
  const version = manifest.advancedRuntime?.packageVersion ?? manifest.version;
  if (typeof version !== 'string' || !/^\d+(?:\.\d+)+$/.test(version)) throw new Error('Invalid pinned advanced runtime package version');
  return version;
};

module.exports = {
  installersRoot,
  baseOutputRoot: installersRoot,
  advancedOutputRoot: path.join(installersRoot, 'advanced'),
  advancedRuntimeRoot,
  candidateRoot: path.join(advancedRuntimeRoot, 'candidates'),
  advancedPackagePath,
  advancedPackageRelativePath,
  advancedPackageVersion,
  advancedReleaseLockPath,
};
