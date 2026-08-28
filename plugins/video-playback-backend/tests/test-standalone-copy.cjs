const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.env.PHOTOFLOW_STANDALONE_COPY_TEST !== '1') {
  const source = path.resolve(__dirname, '..');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-playback-plugin-standalone-'));
  const copy = path.join(sandbox, 'video-playback-backend');
  try {
    fs.cpSync(source, copy, {
      recursive: true,
      filter: candidate => !['dist', 'installed', 'vendor'].some(name => path.resolve(candidate) === path.join(source, name)),
    });
    const npmCli = process.env.npm_execpath;
    assert(npmCli && fs.existsSync(npmCli), 'npm CLI path is required for the standalone copy test');
    const environment = { ...process.env, PHOTOFLOW_STANDALONE_COPY_TEST: '1' };
    const test = spawnSync(process.execPath, [npmCli, 'test'], { cwd: copy, env: environment, encoding: 'utf8', windowsHide: true });
    assert.equal(test.status, 0, test.stderr || test.stdout);
    const dryRun = spawnSync(process.execPath, [npmCli, 'run', 'build', '--', '--dry-run'], { cwd: copy, env: environment, encoding: 'utf8', windowsHide: true });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, /独立构建边界验证通过/);
    const releaseDryRun = spawnSync(process.execPath, [npmCli, 'run', 'build:release', '--', '--dry-run'], { cwd: copy, env: environment, encoding: 'utf8', windowsHide: true });
    assert.equal(releaseDryRun.status, 0, releaseDryRun.stderr || releaseDryRun.stdout);
    assert.match(releaseDryRun.stdout, /一键源码构建边界验证通过/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
console.log('Playback backend temp-copy standalone test passed.');
