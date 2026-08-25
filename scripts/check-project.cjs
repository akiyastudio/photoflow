const { spawnSync } = require('child_process');

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this check through npm.');
const testsOnly = process.argv.includes('--tests-only');

const steps = [
  ['Python environment', ['run', 'check:python']],
  ...(!testsOnly ? [
    ['lint', ['run', 'lint']],
    ['typecheck', ['run', 'typecheck']],
  ] : []),
  ['architecture', ['run', 'test:architecture']],
  ['domain contracts', ['run', 'test:domain-contracts']],
  ['operations storage', ['run', 'test:operations-storage']],
  ['team-retouch storage', ['run', 'test:team-storage']],
  ['component service and migrations', ['run', 'test:component-service']],
  ['component host contracts and leases', ['run', 'test:component-host-v2']],
  ['component host views', ['run', 'test:component-host']],
  ['component package catalog', ['run', 'test:component-catalog']],
  ['team-retouch component renderer', ['run', 'test:component-team-retouch']],
  ['media/versioning storage', ['run', 'test:domain-storage']],
  ['domain command journal', ['run', 'test:domain-journal']],
  ['domain health', ['run', 'test:domain-health']],
  ['domain recovery', ['run', 'test:domain-recovery']],
  ['source boundaries', ['run', 'test:source-boundaries']],
  ['SD startup import', ['run', 'test:sd-startup-import']],
  ['startup catalog hydration', ['run', 'test:startup-catalog']],
  ['file entry interaction', ['run', 'test:file-entry-interaction']],
  ['file entry sort', ['run', 'test:file-entry-sort']],
  ['Electron security', ['run', 'test:electron-security']],
  ['filesystem safety', ['run', 'test:filesystem-safety']],
  ['file transfer rollback', ['run', 'test:file-transfer']],
  ['project virtual paths', ['run', 'test:project-virtual-path']],
  ['media rating outbox', ['run', 'test:media-rating']],
  ['background tasks', ['run', 'test:background-tasks']],
  ['process supervisor', ['run', 'test:process-supervisor']],
  ['database migrations', ['run', 'test:database-migrations']],
];

for (const [label, args] of steps) {
  process.stdout.write(`\n[check] ${label}\n`);
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: process.cwd(), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write('\nProject checks passed.\n');
