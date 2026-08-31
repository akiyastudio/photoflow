const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const componentRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(componentRoot, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(componentRoot, 'component.template.json'), 'utf8'));
const runtimeLock = JSON.parse(fs.readFileSync(path.join(componentRoot, 'media-runtime.lock.json'), 'utf8'));
const outputIndex = process.argv.indexOf('--output-dir');
const outputRoot = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(componentRoot, 'dist');
const runtimeCandidates = [
  path.join(repositoryRoot, 'artifacts', 'installers', 'media-runtime', 'libmpv-lgpl-windows-x64'),
  path.join(componentRoot, 'artifacts', 'installers', 'media-runtime', 'libmpv-lgpl-windows-x64'),
];
const compatibleRuntime = candidate => {
  const manifestPath = path.join(candidate, 'runtime-manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const runtime = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return runtime.mpv?.version === runtimeLock.mpv.version
      && runtime.mpv?.commit === runtimeLock.mpv.commit
      && runtime.linkedFfmpeg?.commit === runtimeLock.ffmpeg.commit;
  } catch {
    return false;
  }
};
const runtimeRoot = runtimeCandidates.find(compatibleRuntime);

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: componentRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) throw new Error(`视频播放器组件打包失败，退出代码 ${result.status ?? 'unknown'}`);
};

if (process.argv.includes('--check-runtime')) {
  if (!runtimeRoot) throw new Error('没有找到与 media-runtime.lock.json 匹配的 libmpv 运行时');
  console.log(`Compatible libmpv runtime: ${runtimeRoot}`);
  process.exit(0);
}

if (runtimeRoot) {
  console.log(`Using compatible libmpv runtime: ${runtimeRoot}`);
  run(process.execPath, [path.join(componentRoot, 'scripts', 'build.cjs'), '--mpv-root', runtimeRoot]);
}
else if (process.platform === 'win32') run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build:release']);
else run('npm', ['run', 'build:release']);

const archiveName = `PhotoFlow-${manifest.id}-${manifest.version}-${process.platform}-${process.arch}.zip`;
const sourceArchive = path.join(componentRoot, 'dist', archiveName);
if (!fs.statSync(sourceArchive, { throwIfNoEntry: false })?.isFile()) throw new Error(`没有生成插件安装包：${sourceArchive}`);
fs.mkdirSync(outputRoot, { recursive: true });
const outputArchive = path.join(outputRoot, archiveName);
if (path.resolve(sourceArchive) !== path.resolve(outputArchive)) fs.copyFileSync(sourceArchive, outputArchive);
console.log(`Installable component package: ${outputArchive}`);
