const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const installerIndex = process.argv.indexOf('--installer');
const installer = installerIndex >= 0 ? String(process.argv[installerIndex + 1] || '') : '';
if (!installer || installer.startsWith('--')) throw new Error('最终发布门禁必须显式提供 --installer <最终 Setup EXE>');

const FINAL_STEPS = Object.freeze([
  ['legal final-artifact approval', 'test-legal-release-evidence.cjs', ['--require-ready', '--installer', path.resolve(installer)]],
  ['delivery manifest and component receipts', 'generate-delivery-manifest.cjs', ['--installer', path.resolve(installer)]],
]);

for (const [label, script, args] of FINAL_STEPS) {
  console.log(`\n[release-final] ${label}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nFinal release-ready checks passed. This command did not publish or upload anything.');
