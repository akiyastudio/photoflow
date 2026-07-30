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
    schemaVersion: 1,
    kind: 'photoflow-ffmpeg-runtime',
    platform: 'windows-x64',
    license: 'GPL-2.0-or-later',
    reproducibleSource: true,
    ffmpeg: { version: '7.1.1', commit: 'a'.repeat(40) },
    configureFlags: ['--enable-gpl', '--enable-libx264', '--enable-zlib', '--disable-autodetect', '--disable-network'],
    components: [{ name: 'x264', commit: 'b'.repeat(40) }, { name: 'zlib', commit: 'e'.repeat(40) }],
    artifacts,
  };
  assert.doesNotThrow(() => validateFfmpegManifest(ffmpeg, root));
  assert.throws(() => validateFfmpegManifest({ ...ffmpeg, configureFlags: [...ffmpeg.configureFlags, '--enable-libx265'] }, root), /禁止构建参数/);

  const dll = create('libmpv-2.dll');
  const sourceArchive = create('libmpv-source.zip');
  const licenseArchive = create('libmpv-licenses.zip');
  const mpv = {
    schemaVersion: 1,
    kind: 'photoflow-libmpv-runtime',
    platform: 'windows-x64',
    license: 'LGPL-2.1-or-later',
    mpv: { version: '0.41.0', commit: 'c'.repeat(40) },
    mesonOptions: ['-Dgpl=false', '-Dlibmpv=true'],
    linkedFfmpeg: { version: '7.1.1', commit: 'd'.repeat(40), license: 'LGPL-2.1-or-later', configureFlags: ['--disable-autodetect', '--disable-network', '--disable-gpl', '--disable-nonfree'] },
    files: [dll],
    complianceArtifacts: { sourceArchive, licenseArchive },
  };
  assert.doesNotThrow(() => validateMpvManifest(mpv, root));
  assert.throws(() => validateMpvManifest({ ...mpv, mesonOptions: ['-Dlibmpv=true'] }, root), /-Dgpl=false/);
  assert.throws(() => validateMpvManifest({ ...mpv, linkedFfmpeg: { license: 'GPL-2.0-or-later', configureFlags: ['--enable-gpl'] } }, root), /必须是 LGPL/);
  console.log('媒体运行时策略测试通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
