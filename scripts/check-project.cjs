const { spawnSync } = require('child_process');

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this check through npm.');
const testsOnly = process.argv.includes('--tests-only');

const steps = [
  ...(!testsOnly ? [
    ['lint', ['run', 'lint']],
    ['typecheck', ['run', 'typecheck']],
  ] : []),
  ['architecture', ['run', 'test:architecture']],
  ['file entry interaction', ['run', 'test:file-entry-interaction']],
  ['Electron security', ['run', 'test:electron-security']],
  ['filesystem safety', ['run', 'test:filesystem-safety']],
  ['background tasks', ['run', 'test:background-tasks']],
  ['database migrations', ['run', 'test:database-migrations']],
];

for (const [label, args] of steps) {
  process.stdout.write(`\n[check] ${label}\n`);
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: process.cwd(), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write('\nProject checks passed.\n');
