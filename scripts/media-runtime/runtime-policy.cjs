const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const FORBIDDEN_FFMPEG_FLAGS = [
  '--enable-nonfree',
  '--enable-libxvid',
  '--enable-avisynth',
  '--enable-librubberband',
];
const REQUIRED_FFMPEG_FLAGS = [
  '--enable-gpl',
  '--enable-libx264',
  '--enable-libx265',
  '--enable-zlib',
  '--disable-autodetect',
  '--disable-network',
];
const REQUIRED_ENCODER_LITE_FLAGS = ['--enable-libass', '--enable-libzimg'];
const REQUIRED_GPU_FFMPEG_FLAGS = [
  '--enable-mediafoundation',
  '--enable-d3d11va',
  '--enable-ffnvcodec',
  '--enable-nvenc',
];

const sha256File = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const readJson = filePath => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const asFlags = value => Array.isArray(value) ? value.map(String) : String(value || '').split(/\s+/).filter(Boolean);

function assertHash(filePath, expected, label = path.basename(filePath)) {
  if (!SHA256_PATTERN.test(String(expected || ''))) throw new Error(`${label} 缺少有效 SHA-256`);
  const actual = sha256File(filePath);
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} SHA-256 不匹配：期望 ${expected}，实际 ${actual}`);
  }
}

function validateFfmpegManifest(manifest, artifactRoot) {
  if (![1, 2, 3].includes(manifest.schemaVersion) || manifest.kind !== 'photoflow-ffmpeg-runtime') throw new Error('FFmpeg 运行时清单格式无效');
  if (manifest.platform !== 'windows-x64') throw new Error(`FFmpeg 运行时平台不受支持：${manifest.platform || '未声明'}`);
  if (manifest.license !== 'GPL-2.0-or-later') throw new Error(`FFmpeg 运行时许可证必须是 GPL-2.0-or-later，实际为 ${manifest.license || '未声明'}`);
  if (manifest.reproducibleSource !== true) throw new Error('FFmpeg 清单未确认包含精确对应源码与构建材料');
  if (!manifest.ffmpeg?.version || !/^[a-f0-9]{40}$/i.test(String(manifest.ffmpeg?.commit || ''))) throw new Error('FFmpeg 清单缺少精确版本或完整提交哈希');
  const flags = asFlags(manifest.configureFlags);
  for (const flag of REQUIRED_FFMPEG_FLAGS) if (!flags.includes(flag)) throw new Error(`FFmpeg 缺少必需构建参数：${flag}`);
  if (manifest.schemaVersion >= 3) for (const flag of REQUIRED_ENCODER_LITE_FLAGS) if (!flags.includes(flag)) throw new Error(`FFmpeg 缺少 Media Encoder Lite 构建参数：${flag}`);
  if (manifest.schemaVersion >= 2) {
    for (const flag of REQUIRED_GPU_FFMPEG_FLAGS) if (!flags.includes(flag)) throw new Error(`FFmpeg 缺少硬件加速构建参数：${flag}`);
  }
  for (const flag of FORBIDDEN_FFMPEG_FLAGS) if (flags.includes(flag)) throw new Error(`FFmpeg 含有禁止构建参数：${flag}`);
  const x264 = Array.isArray(manifest.components) ? manifest.components.find(item => item.name === 'x264') : null;
  if (!x264 || !/^[a-f0-9]{40}$/i.test(String(x264.commit || ''))) throw new Error('FFmpeg 清单未声明固定版本和完整提交哈希的 x264');
  const x265 = Array.isArray(manifest.components) ? manifest.components.find(item => item.name === 'x265') : null;
  if (!x265 || !/^[a-f0-9]{40}$/i.test(String(x265.commit || ''))) throw new Error('FFmpeg 清单未声明固定版本和完整提交哈希的 x265');
  const zlib = Array.isArray(manifest.components) ? manifest.components.find(item => item.name === 'zlib') : null;
  if (!zlib || !/^[a-f0-9]{40}$/i.test(String(zlib.commit || ''))) throw new Error('FFmpeg 清单未声明固定版本和完整提交哈希的 zlib');
  if (manifest.schemaVersion >= 3) {
    for (const name of ['zimg', 'freetype', 'fribidi', 'harfbuzz', 'libass']) {
      const component = Array.isArray(manifest.components) ? manifest.components.find(item => item.name === name) : null;
      if (!component || !/^[a-f0-9]{40}$/i.test(String(component.commit || ''))) throw new Error(`FFmpeg 清单未声明固定版本和完整提交哈希的 ${name}`);
    }
  }
  const nvCodecHeaders = Array.isArray(manifest.components) ? manifest.components.find(item => item.name === 'nv-codec-headers') : null;
  if (manifest.schemaVersion >= 2 && (!nvCodecHeaders || !/^[a-f0-9]{40}$/i.test(String(nvCodecHeaders.commit || '')))) {
    throw new Error('FFmpeg 清单未声明固定版本和完整提交哈希的 nv-codec-headers');
  }
  for (const required of ['runtimeArchive', 'sourceArchive', 'licenseArchive']) {
    const entry = manifest.artifacts?.[required];
    if (!entry?.file || !entry.sha256) throw new Error(`FFmpeg 清单缺少 ${required}`);
    const filePath = path.resolve(artifactRoot, entry.file);
    const relative = path.relative(path.resolve(artifactRoot), filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath)) throw new Error(`${required} 文件不存在或路径不安全`);
    assertHash(filePath, entry.sha256, required);
  }
  return manifest;
}

module.exports = {
  FORBIDDEN_FFMPEG_FLAGS,
  REQUIRED_FFMPEG_FLAGS,
  REQUIRED_GPU_FFMPEG_FLAGS,
  assertHash,
  readJson,
  sha256File,
  validateFfmpegManifest,
};
