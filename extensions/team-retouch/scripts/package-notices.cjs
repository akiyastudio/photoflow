const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function copyNotices(root, packageRoot, python, development = false) {
  const destination = path.join(packageRoot, 'licenses');
  fs.cpSync(path.join(root, 'licenses'), destination, { recursive: true });
  for (const name of ['LICENSES.md', 'MODEL-SOURCE.md', 'requirements-build.lock']) fs.copyFileSync(path.join(root, name), path.join(packageRoot, name));
  const result = spawnSync(python, [path.join(root, 'scripts/collect-release-notices.py'), '--output-dir', destination, ...(development ? ['--development'] : [])], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Python notice collection failed');
  const jsRecords = [];
  for (const name of ['react', 'react-dom', 'scheduler', 'lucide-react']) {
    const source = path.dirname(require.resolve(`${name}/package.json`, { paths: [root] }));
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    const notices = fs.readdirSync(source).filter(file => /^(license|copying|notice)(?:[._-]|$)/i.test(file));
    if (!notices.length) throw new Error(`Missing JavaScript license: ${name}`);
    for (const file of notices) {
      const target = path.join(destination, 'javascript', name, file);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(source, file), target);
    }
    jsRecords.push({ name, version: metadata.version, license: metadata.license, notices: notices.map(file => `javascript/${name}/${file}`) });
  }
  fs.writeFileSync(path.join(destination, 'javascript-runtime.json'), `${JSON.stringify(jsRecords, null, 2)}\n`);
  const files = [];
  const walk = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const target = path.join(directory, item.name); if (item.isDirectory()) walk(target); else if (item.isFile()) files.push(path.relative(packageRoot, target).split(path.sep).join('/')); else throw new Error('Notice must be a regular file'); } };
  walk(destination);
  return ['LICENSES.md', 'MODEL-SOURCE.md', 'requirements-build.lock', ...files];
}
function writePackageInventory(packageRoot, identity) {
  const files = [];
  const walk = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name); const relative = path.relative(packageRoot, target).split(path.sep).join('/');
    if (item.isDirectory()) walk(target);
    else if (item.isFile() && relative !== 'package-files.json') {
      const hash = crypto.createHash('sha256'); const fd = fs.openSync(target, 'r'); const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
      try { for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } } finally { fs.closeSync(fd); }
      files.push({ path: relative, size: fs.statSync(target).size, sha256: hash.digest('hex') });
    }
  } };
  walk(packageRoot);
  fs.writeFileSync(path.join(packageRoot, 'package-files.json'), `${JSON.stringify({ schemaVersion: 1, ...identity, files: files.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`);
}
module.exports = { copyNotices, writePackageInventory };
