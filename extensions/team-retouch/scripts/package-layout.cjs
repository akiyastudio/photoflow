const fs = require('node:fs');
const path = require('node:path');

const SERVICE_FILES = Object.freeze([
  'service.cjs',
  'workflow-generation.cjs',
  'workflow-manifest.cjs',
  'backup-restore.cjs',
]);

const copyServiceRuntime = (sourceRoot, packageRoot) => {
  for (const relativePath of SERVICE_FILES) {
    const destination = path.join(packageRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relativePath), destination);
  }
};

module.exports = { SERVICE_FILES, copyServiceRuntime };
