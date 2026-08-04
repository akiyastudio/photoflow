const fs = require('fs');
const path = require('path');
const { readJson, validateFfmpegManifest } = require('./media-runtime/runtime-policy.cjs');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('当前固定 FFmpeg 运行时只支持 Windows x64；不得把其他平台或架构的二进制混入安装包');
}

const root = path.resolve(__dirname, '..');
const vendorRoot = path.resolve(process.env.PHOTOFLOW_FFMPEG_ARTIFACT_ROOT || path.join(root, 'media-runtime', 'vendor', 'windows-x64'));
const manifestPath = path.join(vendorRoot, 'ffmpeg-runtime-manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error([
    `找不到已审计的 FFmpeg 运行时：${manifestPath}`,
    '请运行 GitHub Actions 的 Build audited media runtime，下载完整产物到 media-runtime/vendor/windows-x64。',
    '出于 GPL 合规要求，构建不再回退到 imageio-ffmpeg。',
  ].join('\n'));
}

const manifest = validateFfmpegManifest(readJson(manifestPath), vendorRoot);
const lock = readJson(path.join(root, 'media-runtime.lock.json'));
const x264 = manifest.components.find(item => item.name === 'x264');
const x265 = manifest.components.find(item => item.name === 'x265');
const zlib = manifest.components.find(item => item.name === 'zlib');
if (manifest.ffmpeg?.version !== lock.ffmpeg.version || manifest.ffmpeg?.commit !== lock.ffmpeg.commit || x264?.commit !== lock.x264.commit || x265?.commit !== lock.x265.commit || zlib?.commit !== lock.zlib.commit) {
  throw new Error('FFmpeg/x264/x265/zlib 运行时与 media-runtime.lock.json 固定版本不一致');
}
const runtimeArchive = path.join(vendorRoot, manifest.artifacts.runtimeArchive.file);
const destinationRoot = path.join(root, 'python', 'dist');
const destination = path.join(destinationRoot, 'ffmpeg.zip');
fs.mkdirSync(destinationRoot, { recursive: true });
fs.copyFileSync(runtimeArchive, destination);
fs.copyFileSync(manifestPath, path.join(destinationRoot, 'ffmpeg-runtime-manifest.json'));
console.log(`已准备固定且合规校验通过的 FFmpeg：${destination}`);
