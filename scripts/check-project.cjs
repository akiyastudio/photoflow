const { spawnSync } = require('child_process');

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this check through npm.');
const testsOnly = process.argv.includes('--tests-only');
const releaseReady = process.argv.includes('--release-ready');

const steps = [
  ['Python environment', ['run', 'check:python']],
  ...(!testsOnly ? [
    ['lint', ['run', 'lint']],
    ['typecheck', ['run', 'typecheck']],
  ] : []),
  ['privacy consent and telemetry', ['run', 'test:privacy']],
  ['法律证据结构', ['run', 'test:legal-release-evidence']],
  ...(releaseReady ? [['法律发布批准严格门禁', ['run', 'check:legal-release-ready']]] : []),
  ['architecture', ['run', 'test:architecture']],
  ['domain contracts', ['run', 'test:domain-contracts']],
  ['operations storage', ['run', 'test:operations-storage']],
  ['component service and migrations', ['run', 'test:component-service']],
  ['component host contracts and leases', ['run', 'test:component-host-api']],
  ['component host views', ['run', 'test:component-host']],
  ['component package catalog', ['run', 'test:component-catalog']],
  ['video tools Python environment', ['run', 'setup:video-tools-python']],
  ['component package layout', ['run', 'test:component-package-layout:prepared']],
  ['backup service and component restore', ['run', 'test:backup-service']],
  ['media/versioning storage', ['run', 'test:domain-storage']],
  ['domain command journal', ['run', 'test:domain-journal']],
  ['domain health', ['run', 'test:domain-health']],
  ['domain recovery', ['run', 'test:domain-recovery']],
  ['source boundaries', ['run', 'test:source-boundaries']],
  ['global search 100k', ['run', 'test:global-search']],
  ['SD startup import', ['run', 'test:sd-startup-import']],
  ['startup catalog hydration', ['run', 'test:startup-catalog']],
  ['file entry interaction', ['run', 'test:file-entry-interaction']],
  ['file entry sort', ['run', 'test:file-entry-sort']],
  ['Electron security', ['run', 'test:electron-security']],
  ['CloudBase telemetry privacy and package', ['run', 'test:cloudbase-telemetry']],
  ['filesystem native prerequisites', ['run', 'build:filesystem-native-services']],
  ['filesystem safety', ['run', 'test:filesystem-safety:prepared']],
  ['file transfer rollback', ['run', 'test:file-transfer:prepared']],
  ['native file publication', ['run', 'test:file-publication-service:prepared']],
  ['POSIX file publication abstraction', ['run', 'test:file-publication-platform']],
  ['native file and folder drag', ['run', 'test:native-file-drag']],
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

process.stdout.write(releaseReady
  ? '\nProject checks and the strict legal release approval gate passed.\n'
  : '\nProject checks passed. Legal evidence structure was checked; this does not mean the release is approved or publishable.\n');
