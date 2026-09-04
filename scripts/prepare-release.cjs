const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { stageRelease } = require('./release-staging.cjs');
const { expectedComponentPackages, receiptPathFor } = require('./verify-component-packages.cjs');
const { captureGitSourceFence, assertGitSourceFence, assertCleanGitWorktree } = require('./release-quality-receipt.cjs');
const { acquireReleaseLock, releaseLock } = require('./release-lock.cjs');

const root = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;

const PREPARE_STEPS = Object.freeze([
  'check:release:quality',
  'electron:build',
  'build:components',
]);
const writeSessionLogBestEffort = (logRoot, attemptId, value, warn = console.warn) => {
  try { fs.mkdirSync(logRoot, { recursive: true }); fs.writeFileSync(path.join(logRoot, `${attemptId}.json`), `${JSON.stringify(value, null, 2)}\n`); return true; }
  catch (error) { warn(`发布 staging 已成功，但非信任根 session 日志写入失败：${error.message || error}`); return false; }
};
const clearCurrentReleaseOutputs = (installerRoot, version) => {
  fs.mkdirSync(installerRoot, { recursive: true });
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of fs.readdirSync(installerRoot)) if (new RegExp(`Setup\\s+${escaped}\\.exe$`, 'i').test(name)) fs.rmSync(path.join(installerRoot, name), { force: true });
  for (const component of expectedComponentPackages(installerRoot)) { fs.rmSync(component.path, { force: true }); fs.rmSync(receiptPathFor(component.path), { force: true }); }
};

const run = async () => {
  if (!npmCli) throw new Error('npm_execpath is unavailable; run release preparation through npm.');
  const lock = acquireReleaseLock(root);
  const attemptId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    assertCleanGitWorktree(root);
    const sourceFence = captureGitSourceFence(root);
    const gitCommit = sourceFence.gitCommit;
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const installerRoot = path.join(root, 'artifacts', 'installers');
    for (const script of PREPARE_STEPS) {
      if (script === 'electron:build') clearCurrentReleaseOutputs(installerRoot, packageJson.version);
      console.log(`\n[release-prepare] npm run ${script}`);
      const result = spawnSync(process.execPath, [npmCli, 'run', script], { cwd: root, stdio: 'inherit', windowsHide: true });
      results.push({ command: `npm run ${script}`, status: result.status === 0 ? 'passed' : 'failed' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`发布 session 步骤失败：npm run ${script}`);
      assertGitSourceFence(root, sourceFence); assertCleanGitWorktree(root);
    }
    const staged = await stageRelease({ repositoryRoot: root, installerRoot, product: packageJson.productName || packageJson.name, version: packageJson.version, gitCommit, gitTree: sourceFence.gitTree });
    const logRoot = path.join(root, 'artifacts', 'release-sessions');
    writeSessionLogBestEffort(logRoot, attemptId, { schemaVersion: 1, attemptId, gitCommit, startedAt, finishedAt: new Date().toISOString(), status: 'prepared', steps: results, manifestPath: staged.manifestPath });
    console.log(`\nImmutable release staging: ${staged.root}`);
    console.log(`Stable delivery manifest: ${staged.manifestPath}`);
    console.log('STOP: approve both the final Setup SHA-256 and DELIVERY-MANIFEST.json SHA-256, then run check:release:final -- --manifest <path>. No approval was created automatically.');
  } finally {
    releaseLock(lock);
  }
};

if (require.main === module) run().catch(error => { console.error(`Release preparation failed: ${error.message || error}`); process.exitCode = 1; });

module.exports = { PREPARE_STEPS, writeSessionLogBestEffort, clearCurrentReleaseOutputs };
