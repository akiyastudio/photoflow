const fs = require('fs');
const path = require('path');
const { readJson, validateMpvManifest } = require('../scripts/vendor/runtime-policy.cjs');
const { verifyPeDependencyClosure } = require('../scripts/vendor/pe-dependency-closure.cjs');

const [kind = 'mpv', rootArg] = process.argv.slice(2);
if (kind !== 'mpv') throw new Error(`独立播放器插件只验证 mpv 运行时：${kind}`);
const defaultRoot = path.resolve(__dirname, '..', 'vendor');
const root = path.resolve(rootArg || defaultRoot);
const manifestName = kind === 'mpv' ? 'runtime-manifest.json' : 'ffmpeg-runtime-manifest.json';
const manifestPath = path.join(root, manifestName);
if (!fs.existsSync(manifestPath)) throw new Error(`找不到运行时清单：${manifestPath}`);
const manifest = readJson(manifestPath);
const validated = validateMpvManifest(manifest, root);
verifyPeDependencyClosure(root, validated.files.map(entry => path.basename(entry.file)));
console.log(`${kind} 运行时许可证、构建参数与哈希校验通过：${root}`);
