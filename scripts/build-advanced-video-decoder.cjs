const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, validateMpvManifest } = require('./media-runtime/runtime-policy.cjs');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('“高级视频解码”组件当前只支持 Windows x64');
}

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'components', 'video-playback-mpv');
const templatePath = path.join(sourceRoot, 'component.template.json');
const manifest = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
const argumentIndex = process.argv.indexOf('--mpv-root');
const configuredRoot = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.PHOTOFLOW_MPV_ROOT;
const mpvRoot = path.resolve(configuredRoot || path.join(sourceRoot, 'vendor'));
const runtimeManifestPath = path.join(mpvRoot, 'runtime-manifest.json');

if (!fs.existsSync(runtimeManifestPath)) {
  throw new Error(`找不到 libmpv LGPL 运行时清单：${runtimeManifestPath}\n组件构建不接受无法证明许可证、构建参数和文件哈希的第三方二进制。`);
}
const runtimeManifest = validateMpvManifest(readJson(runtimeManifestPath), mpvRoot);
const mediaRuntimeLock = readJson(path.join(root, 'media-runtime.lock.json'));
if (runtimeManifest.mpv?.version !== mediaRuntimeLock.mpv.version
  || String(runtimeManifest.mpv?.commit || '') !== mediaRuntimeLock.mpv.commit) {
  throw new Error('libmpv 运行时与 media-runtime.lock.json 固定版本不一致');
}
if (runtimeManifest.linkedFfmpeg?.commit !== mediaRuntimeLock.ffmpeg.commit) {
  throw new Error('libmpv 链接的 FFmpeg 与 media-runtime.lock.json 固定版本不一致');
}
const lockedDependencies = { zlib: mediaRuntimeLock.zlib, ...mediaRuntimeLock.mpvDependencies };
for (const [name, locked] of Object.entries(lockedDependencies)) {
  const actual = runtimeManifest.components.find(component => component.name === name);
  if (!actual || actual.version !== locked.version || actual.commit !== locked.commit || actual.license !== locked.license) {
    throw new Error(`libmpv 依赖与 media-runtime.lock.json 固定版本不一致：${name}`);
  }
}

const findFile = (directory, names) => {
  const pending = [directory];
  const lowered = new Set(names.map(name => name.toLowerCase()));
  while (pending.length) {
    const current = pending.shift();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && lowered.has(entry.name.toLowerCase())) return entryPath;
    }
  }
  return '';
};

const declaredMpvFile = runtimeManifest.files.find(entry => /^(?:lib)?mpv-2\.dll$/i.test(path.basename(entry.file)));
const mpvLibrary = declaredMpvFile ? path.resolve(mpvRoot, declaredMpvFile.file) : findFile(mpvRoot, ['libmpv-2.dll', 'mpv-2.dll']);
if (!mpvLibrary) {
  throw new Error(`找不到 libmpv-2.dll 或 mpv-2.dll：${mpvRoot}\n请通过 --mpv-root 指定完整的 Windows x64 libmpv 运行目录。`);
}
const peHeader = fs.readFileSync(mpvLibrary);
const peOffset = peHeader.length >= 0x40 ? peHeader.readUInt32LE(0x3c) : -1;
const peMachine = peOffset >= 0 && peOffset + 6 <= peHeader.length && peHeader.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0'
  ? peHeader.readUInt16LE(peOffset + 4)
  : 0;
if (peMachine !== 0x8664) throw new Error(`libmpv 不是 Windows x64 DLL：${mpvLibrary}`);

const frameworkRoots = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319'),
];
const frameworkRoot = frameworkRoots.find(candidate => fs.existsSync(path.join(candidate, 'csc.exe')));
if (!frameworkRoot) throw new Error('找不到 Windows C# 编译器，无法构建高级视频解码桥接程序');

const outputRoot = path.join(root, 'release', 'components');
const target = path.join(outputRoot, manifest.id);
const relativeTarget = path.relative(outputRoot, target);
if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new Error(`不安全的组件输出路径：${target}`);
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

const executable = path.join(target, manifest.entrypoints['win32-x64']);
const compile = spawnSync(path.join(frameworkRoot, 'csc.exe'), [
  '/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${executable}`,
  `/reference:${path.join(frameworkRoot, 'System.Windows.Forms.dll')}`,
  `/reference:${path.join(frameworkRoot, 'System.Drawing.dll')}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(sourceRoot, 'AdvancedVideoDecoder.cs'),
], { cwd: root, encoding: 'utf8', windowsHide: true });
if (compile.status !== 0) throw new Error(`高级视频解码桥接程序构建失败：${compile.stderr || compile.stdout}`);

const runtimeRoot = path.dirname(mpvLibrary);
const copiedNames = new Set();
for (const entry of runtimeManifest.files) {
  if (path.extname(entry.file).toLowerCase() !== '.dll') continue;
  const sourcePath = path.resolve(mpvRoot, entry.file);
  const destinationName = path.resolve(sourcePath) === path.resolve(mpvLibrary) ? 'libmpv-2.dll' : path.basename(entry.file);
  if (copiedNames.has(destinationName.toLowerCase())) throw new Error(`libmpv 清单包含重名 DLL：${destinationName}`);
  copiedNames.add(destinationName.toLowerCase());
  fs.copyFileSync(sourcePath, path.join(target, destinationName));
}

for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !/^(license|copying|copyright|readme|build)/i.test(entry.name)) continue;
  fs.copyFileSync(path.join(runtimeRoot, entry.name), path.join(target, `upstream-${entry.name}`));
}
for (const name of ['README.md', 'LICENSES.md']) fs.copyFileSync(path.join(sourceRoot, name), path.join(target, name));
fs.copyFileSync(runtimeManifestPath, path.join(target, 'runtime-manifest.json'));
for (const entry of Object.values(runtimeManifest.complianceArtifacts)) {
  fs.copyFileSync(path.resolve(mpvRoot, entry.file), path.join(target, path.basename(entry.file)));
}
fs.copyFileSync(templatePath, path.join(target, 'component.json'));

const files = fs.readdirSync(target, { withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => {
    const filePath = path.join(target, entry.name);
    return {
      name: entry.name,
      sizeBytes: fs.statSync(filePath).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    };
  });
fs.writeFileSync(path.join(target, 'build-info.json'), JSON.stringify({
  componentId: manifest.id,
  version: manifest.version,
  builtAt: new Date().toISOString(),
  mediaRuntime: {
    mpvVersion: runtimeManifest.mpv?.version || '',
    mpvCommit: runtimeManifest.mpv?.commit || runtimeManifest.mpv?.ref || '',
    license: runtimeManifest.license,
    mesonOptions: runtimeManifest.mesonOptions,
    linkedFfmpeg: runtimeManifest.linkedFfmpeg,
  },
  files,
}, null, 2));

const releaseRoot = path.join(root, 'release');
const artifactName = `PhotoFlow-${manifest.id}-${manifest.version}-${process.platform}-${process.arch}.zip`;
const artifactPath = path.join(releaseRoot, artifactName);
for (const existingName of fs.readdirSync(releaseRoot)) {
  if (existingName.startsWith(`PhotoFlow-${manifest.id}-`) && existingName.endsWith(`-${process.platform}-${process.arch}.zip`)) {
    fs.rmSync(path.join(releaseRoot, existingName), { force: true });
  }
}
const archive = spawnSync('tar.exe', ['-a', '-c', '-f', artifactPath, manifest.id], {
  cwd: outputRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (archive.status !== 0) throw new Error(`高级视频解码组件打包失败：${archive.stderr || archive.stdout}`);
console.log(`高级视频解码组件已生成：${artifactPath}`);
