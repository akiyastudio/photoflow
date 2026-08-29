const fs = require('fs');
const path = require('path');
const { readJson, validateFfmpegManifest } = require('./runtime-policy.cjs');

const [kind = 'ffmpeg', rootArg] = process.argv.slice(2);
if (kind !== 'ffmpeg') throw new Error(`主程序媒体运行时只验证 ffmpeg：${kind}`);
const defaultRoot = path.resolve('media-runtime', 'vendor', 'windows-x64');
const root = path.resolve(rootArg || defaultRoot);
const manifestName = 'ffmpeg-runtime-manifest.json';
const manifestPath = path.join(root, manifestName);
if (!fs.existsSync(manifestPath)) throw new Error(`找不到运行时清单：${manifestPath}`);
const manifest = readJson(manifestPath);
validateFfmpegManifest(manifest, root);
console.log(`${kind} 运行时许可证、构建参数与哈希校验通过：${root}`);
