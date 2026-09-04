const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;

const PREPARE_STEPS = Object.freeze([
  'check:release:quality',
  'electron:build',
  'build:components',
  'release:manifest',
]);

const run = () => {
  if (!npmCli) throw new Error('npm_execpath is unavailable; run release preparation through npm.');
  for (const script of PREPARE_STEPS) {
    console.log(`\n[release-prepare] npm run ${script}`);
    const result = spawnSync(process.execPath, [npmCli, 'run', script], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
  console.log('\nRelease artifacts are built and hashed. STOP: obtain human approval for the final Setup hash, then run check:release:final with --installer. No approval was created automatically.');
};

if (require.main === module) run();

module.exports = { PREPARE_STEPS };
