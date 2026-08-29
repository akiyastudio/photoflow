const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const { readJson, validateMpvManifest } = require(path.join(root, 'scripts', 'vendor', 'runtime-policy.cjs'));
const { createComponentIntegrityManifest } = require(path.join(root, 'scripts', 'vendor', 'component-integrity.cjs'));
const { normalizeDotnetAssembly } = require(path.join(root, 'scripts', 'vendor', 'deterministic-dotnet-assembly.cjs'));
const { verifyPeDependencyClosure } = require(path.join(root, 'scripts', 'vendor', 'pe-dependency-closure.cjs'));

const sourceRoot = root;
const templatePath = path.join(sourceRoot, 'component.template.json');
const manifest = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
const argumentValue = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
};
if (process.argv.includes('--dry-run')) {
  for (const required of ['media-runtime.lock.json', 'component.template.json', 'src/AdvancedVideoDecoder.cs', 'media-runtime/build-libmpv-lgpl-windows.sh']) {
    if (!fs.existsSync(path.join(root, required))) throw new Error(`独立构建资源缺失：${required}`);
  }
  console.log(`视频播放器组件独立构建边界验证通过：${root}`);
  process.exit(0);
}
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('“视频播放器”组件当前只支持 Windows x64');
}
const configuredRoot = argumentValue('--mpv-root') || process.env.PHOTOFLOW_MPV_ROOT;
const mpvRoot = path.resolve(configuredRoot || path.join(sourceRoot, 'vendor'));
const runtimeManifestPath = path.join(mpvRoot, 'runtime-manifest.json');
const sourceDateEpoch = Number.parseInt(process.env.SOURCE_DATE_EPOCH || '0', 10);
if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) throw new Error('SOURCE_DATE_EPOCH 必须是非负整数秒');
const buildDate = new Date(sourceDateEpoch * 1000);
const zipTimestamp = new Date(Math.max(sourceDateEpoch, 315532800) * 1000);

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

const normalizeZipTimestamps = (archivePath, epochSeconds) => {
  const image = fs.readFileSync(archivePath);
  let endOfCentralDirectory = -1;
  for (let offset = image.length - 22; offset >= Math.max(0, image.length - 65557); offset--) {
    if (image.readUInt32LE(offset) === 0x06054b50) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  if (endOfCentralDirectory < 0) throw new Error('视频播放器组件 ZIP 缺少中央目录');

  const normalizeExtraFields = (start, length) => {
    const end = start + length;
    for (let cursor = start; cursor + 4 <= end;) {
      const fieldId = image.readUInt16LE(cursor);
      const fieldLength = image.readUInt16LE(cursor + 2);
      const fieldEnd = cursor + 4 + fieldLength;
      if (fieldEnd > end) throw new Error('视频播放器组件 ZIP 扩展字段损坏');
      if (fieldId === 0x5455 && fieldLength >= 1) {
        const flags = image[cursor + 4];
        let timestampOffset = cursor + 5;
        for (const flag of [1, 2, 4]) {
          if (!(flags & flag)) continue;
          if (timestampOffset + 4 > fieldEnd) throw new Error('视频播放器组件 ZIP 时间字段损坏');
          image.writeUInt32LE(epochSeconds, timestampOffset);
          timestampOffset += 4;
        }
      }
      cursor = fieldEnd;
    }
  };

  const entryCount = image.readUInt16LE(endOfCentralDirectory + 10);
  let centralOffset = image.readUInt32LE(endOfCentralDirectory + 16);
  for (let index = 0; index < entryCount; index++) {
    if (image.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('视频播放器组件 ZIP 中央目录损坏');
    const nameLength = image.readUInt16LE(centralOffset + 28);
    const extraLength = image.readUInt16LE(centralOffset + 30);
    const commentLength = image.readUInt16LE(centralOffset + 32);
    const localOffset = image.readUInt32LE(centralOffset + 42);
    if (image.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('视频播放器组件 ZIP 本地条目损坏');

    image.writeUInt16LE(0, localOffset + 10);
    image.writeUInt16LE(33, localOffset + 12);
    image.writeUInt16LE(0, centralOffset + 12);
    image.writeUInt16LE(33, centralOffset + 14);
    const localNameLength = image.readUInt16LE(localOffset + 26);
    const localExtraLength = image.readUInt16LE(localOffset + 28);
    normalizeExtraFields(localOffset + 30 + localNameLength, localExtraLength);
    normalizeExtraFields(centralOffset + 46 + nameLength, extraLength);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  fs.writeFileSync(archivePath, image);
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
if (!frameworkRoot) throw new Error('找不到 Windows C# 编译器，无法构建视频播放器桥接程序');

const releaseRoot = path.join(root, 'dist');
const outputRoot = path.resolve(argumentValue('--output-root') || path.join(releaseRoot, 'components'));
const relativeOutputRoot = path.relative(releaseRoot, outputRoot);
if (relativeOutputRoot.startsWith('..') || path.isAbsolute(relativeOutputRoot)) throw new Error(`组件输出目录必须位于安装包目录内：${outputRoot}`);
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
  path.join(sourceRoot, 'src', 'AdvancedVideoDecoder.cs'),
], { cwd: root, encoding: 'utf8', windowsHide: true });
if (compile.status !== 0) throw new Error(`视频播放器桥接程序构建失败：${compile.stderr || compile.stdout}`);
normalizeDotnetAssembly(executable);

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
verifyPeDependencyClosure(target, ['libmpv-2.dll']);

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
const integrityManifest = createComponentIntegrityManifest(target, manifest.id, manifest.version);
const serializedIntegrity = `${JSON.stringify(integrityManifest, null, 2)}\n`;
fs.writeFileSync(path.join(target, 'component-integrity.json'), serializedIntegrity, 'utf8');

const files = fs.readdirSync(target, { withFileTypes: true })
  .filter(entry => entry.isFile())
  .sort((left, right) => left.name.localeCompare(right.name, 'en'))
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
  builtAt: buildDate.toISOString(),
  mediaRuntime: {
    mpvVersion: runtimeManifest.mpv?.version || '',
    mpvCommit: runtimeManifest.mpv?.commit || runtimeManifest.mpv?.ref || '',
    license: runtimeManifest.license,
    mesonOptions: runtimeManifest.mesonOptions,
    linkedFfmpeg: runtimeManifest.linkedFfmpeg,
  },
  files,
}, null, 2));

const archiveEntries = fs.readdirSync(target, { withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => entry.name)
  .sort((left, right) => left.localeCompare(right, 'en'));
const runtimePackageExtensions = new Set(['.dll', '.exe', '.json', '.md', '.txt', '.zip']);
const unexpectedPackageEntries = archiveEntries.filter(name => !runtimePackageExtensions.has(path.extname(name).toLowerCase()));
if (unexpectedPackageEntries.length) {
  throw new Error(`视频播放器运行时包含非运行时/清单/许可证文件：${unexpectedPackageEntries.join(', ')}`);
}
for (const name of archiveEntries) fs.utimesSync(path.join(target, name), zipTimestamp, zipTimestamp);
fs.utimesSync(target, zipTimestamp, zipTimestamp);

const artifactName = `PhotoFlow-${manifest.id}-${manifest.version}-${process.platform}-${process.arch}.zip`;
const artifactPath = path.join(releaseRoot, artifactName);
for (const existingName of fs.readdirSync(releaseRoot)) {
  if (existingName.startsWith(`PhotoFlow-${manifest.id}-`) && existingName.endsWith(`-${process.platform}-${process.arch}.zip`)) {
    fs.rmSync(path.join(releaseRoot, existingName), { force: true });
  }
}
const archive = spawnSync('tar.exe', ['-a', '-c', '-f', artifactPath,
  ...archiveEntries.map(name => path.join(manifest.id, name))], {
  cwd: outputRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (archive.status !== 0) throw new Error(`视频播放器组件打包失败：${archive.stderr || archive.stdout}`);
normalizeZipTimestamps(artifactPath, Math.floor(zipTimestamp.getTime() / 1000));
console.log(`视频播放器组件已生成：${artifactPath}`);
