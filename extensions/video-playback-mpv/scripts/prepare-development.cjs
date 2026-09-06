const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fileToken = file => {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) return null;
  return [stat.size, stat.mtimeMs, stat.ctimeMs];
};
const containedFile = (root, relative) => {
  const file = path.resolve(root, relative);
  const relativePath = path.relative(root, file);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw new Error(`运行时清单路径越界：${relative}`);
  return file;
};

const prepareDevelopmentBackend = ({
  componentRoot = path.resolve(__dirname, '..'), environment = process.env,
  platform = process.platform, arch = process.arch, spawnSyncImpl = spawnSync, log = console.log,
} = {}) => {
  if (platform !== 'win32' || arch !== 'x64') { log('当前平台不需要准备 Windows 高级视频解码组件。'); return { skipped: true }; }
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const lock = readJson(path.join(componentRoot, 'media-runtime.lock.json'));
  const manifest = readJson(path.join(componentRoot, 'component.template.json'));
  const candidates = environment.PHOTOFLOW_MPV_ROOT ? [path.resolve(environment.PHOTOFLOW_MPV_ROOT)] : [
    path.join(componentRoot, 'vendor'),
    path.join(componentRoot, 'artifacts', 'installers', 'media-runtime', 'libmpv-lgpl-windows-x64'),
  ];
  const runtimeRoot = candidates.find(candidate => {
    try {
      const runtime = readJson(path.join(candidate, 'runtime-manifest.json'));
      return runtime.mpv?.version === lock.mpv.version && runtime.mpv?.commit === lock.mpv.commit && runtime.linkedFfmpeg?.commit === lock.ffmpeg.commit;
    } catch { return false; }
  });
  if (!runtimeRoot) throw new Error('高级视频解码组件缺少匹配的 libmpv 运行时。请先在组件目录运行 npm run build:release，或设置 PHOTOFLOW_MPV_ROOT 指向已验证的运行时。');
  const runtime = readJson(path.join(runtimeRoot, 'runtime-manifest.json'));
  const target = path.join(componentRoot, 'dist', 'components', manifest.id);
  const runtimeFiles = (runtime.files || []).map(item => containedFile(runtimeRoot, item.file));
  const inputFiles = [
    'component.template.json', 'media-runtime.lock.json', 'src/AdvancedVideoDecoder.cs',
    'scripts/build.cjs', 'scripts/prepare-development.cjs', 'scripts/vendor/runtime-policy.cjs',
    'scripts/vendor/component-integrity.cjs', 'scripts/vendor/deterministic-dotnet-assembly.cjs', 'scripts/vendor/pe-dependency-closure.cjs',
  ].map(name => path.join(componentRoot, name));
  inputFiles.push(path.join(runtimeRoot, 'runtime-manifest.json'), ...runtimeFiles,
    ...Object.values(runtime.complianceArtifacts || {}).map(item => containedFile(runtimeRoot, item.file)));
  const inputs = inputFiles.map(file => [file, fileToken(file)]);
  if (inputs.some(([, token]) => !token)) throw new Error('高级视频解码的构建输入不完整或包含不安全文件，请重新准备组件运行时。');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const outputs = [path.join(target, manifest.entrypoints['win32-x64']), ...runtimeFiles.filter(file => path.extname(file).toLowerCase() === '.dll').map(file => path.join(target, /^(?:lib)?mpv-2\.dll$/i.test(path.basename(file)) ? 'libmpv-2.dll' : path.basename(file)))];
  const outputTokens = () => outputs.map(file => [file, fileToken(file)]);
  const stampPath = path.join(componentRoot, '.cache', 'development-backend.json');
  let stamp;
  try { stamp = readJson(stampPath); } catch { /* first build or incomplete cache */ }
  const currentOutputs = outputTokens();
  if (stamp?.fingerprint === fingerprint && currentOutputs.every(([, token]) => token) && JSON.stringify(stamp.outputs) === JSON.stringify(currentOutputs)) {
    log('高级视频解码开发运行文件已就绪。');
    return { rebuilt: false, target };
  }
  const built = spawnSyncImpl(process.execPath, [path.join(componentRoot, 'scripts', 'build.cjs'), '--development', '--mpv-root', runtimeRoot], {
    cwd: componentRoot, env: environment, stdio: 'inherit', windowsHide: true,
  });
  if (built.error) throw built.error;
  if (built.status !== 0) throw new Error(`高级视频解码开发运行文件构建失败（退出代码 ${built.status ?? 'unknown'}）`);
  const preparedOutputs = outputTokens();
  if (preparedOutputs.some(([, token]) => !token)) throw new Error('高级视频解码构建未生成完整的 EXE 和 DLL。');
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify({ fingerprint, outputs: preparedOutputs }, null, 2)}\n`);
  return { rebuilt: true, target };
};

if (require.main === module) {
  try { prepareDevelopmentBackend(); }
  catch (error) { console.error(error.message || String(error)); process.exitCode = 1; }
}
module.exports = { prepareDevelopmentBackend };
