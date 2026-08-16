const fs = require('fs');
const path = require('path');
const { readJson, validateFfmpegManifest, validateMpvManifest } = require('./runtime-policy.cjs');
const { verifyPeDependencyClosure } = require('./pe-dependency-closure.cjs');

const [kind = 'ffmpeg', rootArg] = process.argv.slice(2);
const defaultRoot = kind === 'mpv'
  ? path.resolve('extensions', 'video-playback-mpv', 'vendor')
  : path.resolve('media-runtime', 'vendor', 'windows-x64');
const root = path.resolve(rootArg || defaultRoot);
const manifestName = kind === 'mpv' ? 'runtime-manifest.json' : 'ffmpeg-runtime-manifest.json';
const manifestPath = path.join(root, manifestName);
if (!fs.existsSync(manifestPath)) throw new Error(`找不到运行时清单：${manifestPath}`);
const manifest = readJson(manifestPath);
if (kind === 'mpv') {
  const validated = validateMpvManifest(manifest, root);
  verifyPeDependencyClosure(root, validated.files.map(entry => path.basename(entry.file)));
}
else if (kind === 'ffmpeg') validateFfmpegManifest(manifest, root);
else throw new Error(`未知运行时类型：${kind}`);
console.log(`${kind} 运行时许可证、构建参数与哈希校验通过：${root}`);
