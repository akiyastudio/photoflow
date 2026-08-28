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

function validateMpvManifest(manifest, artifactRoot) {
  if (manifest.schemaVersion !== 2 || manifest.kind !== 'photoflow-libmpv-runtime') throw new Error('libmpv 运行时清单必须使用版本 2 格式');
  if (manifest.platform !== 'windows-x64') throw new Error(`libmpv 运行时平台不受支持：${manifest.platform || '未声明'}`);
  if (manifest.license !== 'LGPL-2.1-or-later') throw new Error(`libmpv 必须使用 LGPL-2.1-or-later 构建，实际为 ${manifest.license || '未声明'}`);
  if (manifest.reproducibleSource !== true) throw new Error('libmpv 清单未确认包含精确对应源码和构建材料');
  if (!manifest.mpv?.version || !/^[a-f0-9]{40}$/i.test(String(manifest.mpv?.commit || ''))) throw new Error('libmpv 清单缺少精确版本或完整提交哈希');
  const options = asFlags(manifest.mesonOptions);
  for (const flag of ['-Dgpl=false', '-Dlibmpv=true']) if (!options.includes(flag)) throw new Error(`libmpv 缺少必需构建参数：${flag}`);
  for (const flag of ['-Dauto_features=disabled', '-Dwasapi=enabled', '-Dd3d11=enabled', '-Dd3d-hwaccel=enabled', '-Dzlib=enabled']) {
    if (!options.includes(flag)) throw new Error(`libmpv 缺少 Windows 播放构建参数：${flag}`);
  }
  const requiredComponents = ['zlib', 'freetype', 'fribidi', 'harfbuzz', 'libass', 'spirvCross', 'libplacebo'];
  for (const name of requiredComponents) {
    const component = Array.isArray(manifest.components) ? manifest.components.find(item => item.name === name) : null;
    if (!component || !component.version || !component.license || !/^[a-f0-9]{40}$/i.test(String(component.commit || ''))) {
      throw new Error(`libmpv 清单缺少固定依赖信息：${name}`);
    }
  }
  if (manifest.linkedFfmpeg?.license !== 'LGPL-2.1-or-later') throw new Error('libmpv 链接的 FFmpeg 必须是 LGPL-2.1-or-later 构建');
  if (!manifest.linkedFfmpeg?.version || !/^[a-f0-9]{40}$/i.test(String(manifest.linkedFfmpeg?.commit || ''))) throw new Error('libmpv 清单缺少所链接 FFmpeg 的精确版本或完整提交哈希');
  const ffmpegFlags = asFlags(manifest.linkedFfmpeg?.configureFlags);
  for (const flag of ['--disable-gpl', '--disable-nonfree']) if (!ffmpegFlags.includes(flag)) throw new Error(`libmpv 链接的 FFmpeg 缺少必需构建参数：${flag}`);
  if (ffmpegFlags.some(flag => flag === '--enable-gpl' || flag === '--enable-nonfree' || flag === '--enable-libx264' || flag === '--enable-libx265' || FORBIDDEN_FFMPEG_FLAGS.includes(flag))) {
    throw new Error('libmpv 链接的 FFmpeg 含 GPL/nonfree 构建参数');
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('libmpv 清单没有文件哈希');
  for (const entry of manifest.files) {
    const filePath = path.resolve(artifactRoot, String(entry.file || ''));
    const relative = path.relative(path.resolve(artifactRoot), filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath)) throw new Error(`libmpv 文件不存在或路径不安全：${entry.file || ''}`);
    assertHash(filePath, entry.sha256, entry.file);
  }
  if (!manifest.files.some(entry => /^(?:lib)?mpv-2\.dll$/i.test(path.basename(entry.file)))) throw new Error('libmpv 清单未包含 libmpv-2.dll');
  for (const required of ['sourceArchive', 'licenseArchive']) {
    const entry = manifest.complianceArtifacts?.[required];
    if (!entry?.file || !entry.sha256) throw new Error(`libmpv 清单缺少 ${required}`);
    const filePath = path.resolve(artifactRoot, entry.file);
    const relative = path.relative(path.resolve(artifactRoot), filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath)) throw new Error(`libmpv ${required} 文件不存在或路径不安全`);
    assertHash(filePath, entry.sha256, `libmpv ${required}`);
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
  validateMpvManifest,
};
