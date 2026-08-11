const { spawnSync } = require('child_process');
const packageJson = require('../package.json');

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this suite through npm.');

let testScripts = Object.keys(packageJson.scripts)
  .filter(name => name.startsWith('test:') && name !== 'test:full')
  .sort((left, right) => left.localeCompare(right));
const fromArgument = process.argv.find(argument => argument.startsWith('--from='));
if (fromArgument) {
  const from = fromArgument.slice('--from='.length);
  const index = testScripts.indexOf(from);
  if (index < 0) throw new Error(`Unknown test script: ${from}`);
  testScripts = testScripts.slice(index);
}

for (const name of testScripts) {
  process.stdout.write(`\n[full-test] ${name}\n`);
  const result = spawnSync(process.execPath, [npmCli, 'run', name], { cwd: process.cwd(), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write(`\nFull test suite passed (${testScripts.length} scripts).\n`);
