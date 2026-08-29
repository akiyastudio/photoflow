const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateFfmpegManifest } = require('./runtime-policy.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-media-policy-'));
try {
  const create = file => {
    const filePath = path.join(root, file);
    fs.writeFileSync(filePath, file);
    return { file, sha256: crypto.createHash('sha256').update(file).digest('hex') };
  };
  const artifacts = {
    runtimeArchive: create('runtime.zip'),
    sourceArchive: create('source.zip'),
    licenseArchive: create('licenses.zip'),
  };
  const ffmpeg = {
    schemaVersion: 3,
    kind: 'photoflow-ffmpeg-runtime',
    platform: 'windows-x64',
    license: 'GPL-2.0-or-later',
    reproducibleSource: true,
    ffmpeg: { version: '7.1.1', commit: 'a'.repeat(40) },
    configureFlags: ['--enable-gpl', '--enable-libx264', '--enable-libx265', '--enable-libass', '--enable-libzimg', '--enable-zlib', '--enable-mediafoundation', '--enable-d3d11va', '--enable-ffnvcodec', '--enable-nvenc', '--disable-autodetect', '--disable-network'],
    components: ['x264', 'x265', 'zlib', 'zimg', 'freetype', 'fribidi', 'harfbuzz', 'libass', 'nv-codec-headers'].map(name => ({ name, commit: 'b'.repeat(40) })),
    artifacts,
  };
  assert.doesNotThrow(() => validateFfmpegManifest(ffmpeg, root));
  assert.doesNotThrow(() => validateFfmpegManifest({
    ...ffmpeg,
    schemaVersion: 1,
    configureFlags: ffmpeg.configureFlags.filter(flag => !['--enable-mediafoundation', '--enable-d3d11va', '--enable-ffnvcodec', '--enable-nvenc'].includes(flag)),
  }, root));
  assert.throws(() => validateFfmpegManifest({
    ...ffmpeg,
    configureFlags: ffmpeg.configureFlags.filter(flag => flag !== '--enable-mediafoundation'),
  }, root), /硬件加速构建参数/);
  assert.throws(() => validateFfmpegManifest({ ...ffmpeg, configureFlags: ffmpeg.configureFlags.filter(flag => flag !== '--enable-libx265') }, root), /缺少必需构建参数/);
  assert.throws(() => validateFfmpegManifest({ ...ffmpeg, components: ffmpeg.components.filter(component => component.name !== 'x265') }, root), /未声明固定版本.*x265/);
  assert.throws(() => validateFfmpegManifest({ ...ffmpeg, configureFlags: ffmpeg.configureFlags.filter(flag => flag !== '--enable-nvenc') }, root), /硬件加速构建参数/);
  assert.throws(() => validateFfmpegManifest({ ...ffmpeg, components: ffmpeg.components.filter(component => component.name !== 'nv-codec-headers') }, root), /未声明固定版本.*nv-codec-headers/);

  console.log('媒体运行时策略测试通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
