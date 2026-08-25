const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => /^test-.*\.(?:cjs|mjs)$/.test(name) && !name.endsWith('-child.cjs'))
  .sort();
for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', test)], { cwd: root, stdio: 'inherit', env: { ...process.env, TEAM_RETOUCH_ROOT: root } });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
console.log(`Plugin Node tests passed (${tests.length} files).`);
