const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtimeScript = path.join(root, 'media-runtime', 'build-libmpv-lgpl-windows.sh');
const packageScript = path.join(root, 'scripts', 'build.cjs');
for (const required of [runtimeScript, packageScript, path.join(root, 'media-runtime.lock.json')]) {
  if (!fs.existsSync(required)) throw new Error(`独立发布资源缺失：${path.relative(root, required)}`);
}
if (process.argv.includes('--dry-run')) {
  console.log(`视频播放器组件一键源码构建边界验证通过：${root}`);
  process.exit(0);
}
const runtimeRoot = path.join(root, 'artifacts', 'installers', 'media-runtime', 'libmpv-lgpl-windows-x64');
const runtime = spawnSync('bash', [runtimeScript], {
  cwd: root,
  env: process.env,
  encoding: 'utf8',
  windowsHide: true,
  stdio: 'inherit',
});
if (runtime.status !== 0) throw new Error(`libmpv 固定运行时构建失败（exit ${runtime.status ?? 'spawn'}）`);
const packaged = spawnSync(process.execPath, [packageScript, '--mpv-root', runtimeRoot], {
  cwd: root,
  env: process.env,
  encoding: 'utf8',
  windowsHide: true,
  stdio: 'inherit',
});
if (packaged.status !== 0) throw new Error(`播放器组件打包失败（exit ${packaged.status ?? 'spawn'}）`);
