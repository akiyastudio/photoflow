const fs = require('node:fs');
const path = require('node:path');

const LOCAL_CONFIG = '.photoflow-paths.local.json';
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const physicalPath = value => {
  let parent = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) break;
    missing.unshift(path.basename(parent)); parent = next;
  }
  return path.resolve(fs.realpathSync(parent), ...missing);
};
const installersRootFor = repositoryRoot => path.join(path.resolve(repositoryRoot), 'artifacts', 'installers');
const privateRootFor = (repositoryRoot, env = process.env) => {
  const root = path.resolve(repositoryRoot);
  const configFile = path.join(root, LOCAL_CONFIG);
  const configured = env.PHOTOFLOW_PRIVATE_ROOT || (fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')).privateRoot : '');
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error(`Configure an absolute PHOTOFLOW_PRIVATE_ROOT or privateRoot in ${LOCAL_CONFIG}; private output cannot fall back into the source repository.`);
  const target = physicalPath(configured);
  if (within(physicalPath(root), target)) throw new Error('Private output root must be outside the source repository.');
  return target;
};
const privateOutputPath = (repositoryRoot, ...parts) => {
  const root = privateRootFor(repositoryRoot);
  const target = physicalPath(path.resolve(root, ...parts));
  if (!within(root, target)) throw new Error('Private output path escaped the configured root.');
  return target;
};
const releaseOperationsRoot = repositoryRoot => privateOutputPath(repositoryRoot, 'operations', 'releases');
const assertLegacyReleaseStateAbsent = (repositoryRoot, name) => {
  const legacy = path.join(repositoryRoot, 'artifacts', name);
  const stat = fs.statSync(legacy, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || fs.readdirSync(legacy).length)) throw new Error(`Legacy release state must be reviewed and migrated before continuing: ${legacy}`);
};

module.exports = { LOCAL_CONFIG, installersRootFor, privateRootFor, privateOutputPath, releaseOperationsRoot, assertLegacyReleaseStateAbsent };
