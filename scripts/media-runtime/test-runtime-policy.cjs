const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateFfmpegManifest, validateMpvManifest } = require('./runtime-policy.cjs');

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
    schemaVersion: 2,
    kind: 'photoflow-ffmpeg-runtime',
    platform: 'windows-x64',
    license: 'GPL-2.0-or-later',
    reproducibleSource: true,
    ffmpeg: { version: '7.1.1', commit: 'a'.repeat(40) },
    configureFlags: ['--enable-gpl', '--enable-libx264', '--enable-libx265', '--enable-zlib', '--enable-mediafoundation', '--enable-d3d11va', '--enable-ffnvcodec', '--enable-nvenc', '--disable-autodetect', '--disable-network'],
    components: [{ name: 'x264', commit: 'b'.repeat(40) }, { name: 'x265', commit: 'c'.repeat(40) }, { name: 'zlib', commit: 'e'.repeat(40) }, { name: 'nv-codec-headers', commit: 'f'.repeat(40) }],
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

  const dll = create('libmpv-2.dll');
  const sourceArchive = create('libmpv-source.zip');
  const licenseArchive = create('libmpv-licenses.zip');
  const mpv = {
    schemaVersion: 2,
    kind: 'photoflow-libmpv-runtime',
    platform: 'windows-x64',
    license: 'LGPL-2.1-or-later',
    reproducibleSource: true,
    mpv: { version: '0.41.0', commit: 'c'.repeat(40) },
    components: ['zlib', 'freetype', 'fribidi', 'harfbuzz', 'libass', 'spirvCross', 'libplacebo']
      .map(name => ({ name, version: '1.0.0', commit: 'e'.repeat(40), license: 'LGPL-2.1-or-later' })),
    mesonOptions: ['-Dgpl=false', '-Dlibmpv=true', '-Dauto_features=disabled', '-Dwasapi=enabled', '-Dd3d11=enabled', '-Dd3d-hwaccel=enabled', '-Dzlib=enabled'],
    linkedFfmpeg: { version: '7.1.1', commit: 'd'.repeat(40), license: 'LGPL-2.1-or-later', configureFlags: ['--disable-autodetect', '--disable-network', '--disable-gpl', '--disable-nonfree'] },
    files: [dll],
    complianceArtifacts: { sourceArchive, licenseArchive },
  };
  assert.doesNotThrow(() => validateMpvManifest(mpv, root));
  assert.throws(() => validateMpvManifest({ ...mpv, mesonOptions: mpv.mesonOptions.filter(option => option !== '-Dgpl=false') }, root), /-Dgpl=false/);
  assert.throws(() => validateMpvManifest({ ...mpv, reproducibleSource: false }, root), /对应源码/);
  assert.throws(() => validateMpvManifest({ ...mpv, components: mpv.components.filter(component => component.name !== 'libplacebo') }, root), /libplacebo/);
  assert.throws(() => validateMpvManifest({ ...mpv, linkedFfmpeg: { license: 'GPL-2.0-or-later', configureFlags: ['--enable-gpl'] } }, root), /必须是 LGPL/);
  assert.throws(() => validateMpvManifest({ ...mpv, linkedFfmpeg: { ...mpv.linkedFfmpeg, configureFlags: [...mpv.linkedFfmpeg.configureFlags, '--enable-libx265'] } }, root), /GPL\/nonfree/);
  console.log('媒体运行时策略测试通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
