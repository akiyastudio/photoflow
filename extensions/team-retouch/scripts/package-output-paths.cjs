const path = require('node:path');
const componentRoot = path.resolve(__dirname, '..');
const installersRoot = path.resolve(componentRoot, '..', '..', 'artifacts', 'installers');
const advancedRuntimeRoot = path.join(installersRoot, 'advanced-runtime');
const advancedPackagePath = name => path.join(advancedRuntimeRoot, name);
const advancedPackageRelativePath = name => path.relative(componentRoot, advancedPackagePath(name)).split(path.sep).join('/');

module.exports = {
  installersRoot,
  baseOutputRoot: path.join(installersRoot, 'base'),
  advancedOutputRoot: path.join(installersRoot, 'advanced'),
  advancedRuntimeRoot,
  candidateRoot: path.join(advancedRuntimeRoot, 'candidates'),
  advancedPackagePath,
  advancedPackageRelativePath,
};
