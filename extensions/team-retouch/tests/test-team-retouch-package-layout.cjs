const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { copyServiceRuntime } = require('../scripts/package-layout.cjs');

const sourceRoot = path.resolve(__dirname, '..');
const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-package-layout-'));
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'component.template.json'), 'utf8'));
  copyServiceRuntime(sourceRoot, isolatedRoot);

  // Fill non-JavaScript production assets with isolated fixtures. The service
  // runtime files above are the real packaged bytes.
  for (const relativePath of manifest.requiredFiles) {
    const target = path.join(isolatedRoot, relativePath);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'isolated package fixture');
    }
  }
  for (const relativePath of manifest.requiredFiles) {
    assert(fs.statSync(path.join(isolatedRoot, relativePath)).isFile(), `packaged requiredFile is missing: ${relativePath}`);
  }

  const child = spawnSync(process.execPath, ['-e', "require('./service.cjs'); require('./compatibility/storage-restore.cjs')"], {
    cwd: isolatedRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(child.status, 0, `isolated packaged service failed to load:\n${child.stderr || child.stdout}`);
  console.log('Team-retouch isolated production package layout tests passed');
} finally {
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
}
