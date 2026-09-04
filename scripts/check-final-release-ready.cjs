const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { captureArtifactIdentity, assertSourceIdentity } = require('./verify-component-packages.cjs');

const root = path.resolve(__dirname, '..');
const installerIndex = process.argv.indexOf('--installer');
const installer = installerIndex >= 0 ? String(process.argv[installerIndex + 1] || '') : '';
if (!installer || installer.startsWith('--')) throw new Error('最终发布门禁必须显式提供 --installer <最终 Setup EXE>');
const installerPath = path.resolve(installer);
const installerIdentity = captureArtifactIdentity(installerPath);

const FINAL_STEPS = Object.freeze([
  ['legal final-artifact approval', 'test-legal-release-evidence.cjs', ['--require-ready', '--installer', installerPath]],
  ['delivery manifest and component receipts', 'generate-delivery-manifest.cjs', ['--installer', installerPath]],
]);

for (const [label, script, args] of FINAL_STEPS) {
  console.log(`\n[release-final] ${label}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
assertSourceIdentity(installerPath, installerIdentity);
const approval = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'legal', 'RELEASE_APPROVAL.json'), 'utf8'));
const delivery = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'installers', 'DELIVERY-MANIFEST.json'), 'utf8'));
const setup = delivery.artifacts.find(artifact => artifact.type === 'setup' && artifact.fileName === path.basename(installerPath));
if (!setup || String(setup.sha256).toLowerCase() !== String(approval.installerSha256).toLowerCase()) throw new Error('最终批准哈希与交付清单 Setup 哈希不一致');
console.log('\nFinal release-ready checks passed. This command did not publish or upload anything.');
