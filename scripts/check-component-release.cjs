const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this gate through npm.');

const steps = [
  ['component host API', process.execPath, [npmCli, 'run', 'test:component-host-api']],
  ['component host', process.execPath, [npmCli, 'run', 'test:component-host']],
  ['component service', process.execPath, [npmCli, 'run', 'test:component-service']],
  ['component catalog', process.execPath, [npmCli, 'run', 'test:component-catalog']],
  ['component development', process.execPath, [npmCli, 'run', 'test:component-development']],
  ['component visual contract', process.execPath, [npmCli, 'run', 'test:component-visual-contract']],
  ['component Electron smoke', process.execPath, [npmCli, 'run', 'test:component-electron-smoke']],
  ['component core', process.execPath, ['scripts/test-components.cjs']],
  ['component install adoption', process.execPath, ['scripts/test-component-install-adoption.cjs']],
  ['component install trust boundary', process.execPath, ['scripts/test-component-install-trust.mjs']],
  ['component durable transactions', process.execPath, ['scripts/test-component-transactions.cjs']],
  ['component lifecycle coordination', process.execPath, ['scripts/test-component-lifecycle-coordinator.cjs']],
  ['component runtime compatibility', process.execPath, ['scripts/test-plugin-service-runtime-capability.cjs']],
  ['component status policy', process.execPath, ['scripts/test-component-status-refresh-policy.cjs']],
  ['architecture', process.execPath, [npmCli, 'run', 'test:architecture']],
  ['process supervisor', process.execPath, [npmCli, 'run', 'test:process-supervisor']],
  ['package verifier', process.execPath, ['scripts/test-verify-component-packages.cjs']],
  ['host and builder integrity parity', process.execPath, ['scripts/test-component-integrity-parity.cjs']],
  ['release workflow order', process.execPath, ['scripts/test-release-workflow-order.cjs']],
  ['stable release staging', process.execPath, ['scripts/test-release-staging.cjs']],
  ['release publish confirmation', process.execPath, ['scripts/test-release-publish-confirmation.cjs']],
  ['release publish state machine', process.execPath, ['scripts/test-release-publish-state.cjs']],
  ['declared package layouts', process.execPath, [npmCli, 'run', 'test:component-package-layout']],
  ['video playback full package tests', process.execPath, [npmCli, '--prefix', 'extensions/video-playback-mpv', 'test']],
  ['video tools full package tests', process.execPath, [npmCli, '--prefix', 'extensions/video-tools', 'test']],
  ['video transcription full package tests', process.execPath, [npmCli, '--prefix', 'extensions/video-transcription', 'test']],
  ['team retouch full package tests', process.execPath, [npmCli, '--prefix', 'extensions/team-retouch', 'test']],
];

for (const [label, command, args] of steps) {
  process.stdout.write(`\n[component-release] ${label}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nComponent release gate passed.');
