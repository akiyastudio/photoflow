const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { verifyStagedRelease, assertStagedReleaseUnchanged } = require('./release-staging.cjs');
const { acquireReleaseLock, releaseLock } = require('./release-lock.cjs');

const root = path.resolve(__dirname, '..');
const manifestIndex = process.argv.indexOf('--manifest');
const manifestPath = manifestIndex >= 0 ? path.resolve(process.argv[manifestIndex + 1] || '') : '';
if (!manifestPath) throw new Error('最终发布门禁必须显式提供 --manifest <不可变 staging/DELIVERY-MANIFEST.json>');

(async () => {
  const lock = acquireReleaseLock(root);
  try {
    const evidence = await verifyStagedRelease({ repositoryRoot: root, manifestPath });
    const legal = spawnSync(process.execPath, [path.join(__dirname, 'test-legal-release-evidence.cjs'), '--require-ready', '--installer', evidence.setup.path, '--delivery-manifest', evidence.manifestPath], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (legal.error) throw legal.error;
    if (legal.status !== 0) throw new Error('最终 Setup 与完整交付清单的人工批准门禁未通过');
    assertStagedReleaseUnchanged(evidence);
    console.log('\nFinal staged release checks passed. This command did not rerun tests, publish, or upload anything.');
  } finally { releaseLock(lock); }
})().catch(error => { console.error(`Final release-ready check failed: ${error.message || error}`); process.exitCode = 1; });
