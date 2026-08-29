const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateMpvManifest } = require('../scripts/vendor/runtime-policy.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-libmpv-policy-'));
try {
  const create = file => {
    fs.writeFileSync(path.join(root, file), file);
    return { file, sha256: crypto.createHash('sha256').update(file).digest('hex') };
  };
  const mpv = {
    schemaVersion: 2,
    kind: 'photoflow-libmpv-runtime',
    platform: 'windows-x64',
    license: 'LGPL-2.1-or-later',
    reproducibleSource: true,
    mpv: { version: '0.41.0', commit: 'c'.repeat(40) },
    components: ['zlib', 'freetype', 'fribidi', 'harfbuzz', 'libass', 'spirvCross', 'libplacebo'].map(name => ({ name, version: '1.0.0', commit: 'e'.repeat(40), license: 'LGPL-2.1-or-later' })),
    mesonOptions: ['-Dgpl=false', '-Dlibmpv=true', '-Dauto_features=disabled', '-Dwasapi=enabled', '-Dd3d11=enabled', '-Dd3d-hwaccel=enabled', '-Dzlib=enabled'],
    linkedFfmpeg: { version: '7.1.1', commit: 'd'.repeat(40), license: 'LGPL-2.1-or-later', configureFlags: ['--disable-autodetect', '--disable-network', '--disable-gpl', '--disable-nonfree'] },
    files: [create('libmpv-2.dll')],
    complianceArtifacts: { sourceArchive: create('libmpv-source.zip'), licenseArchive: create('libmpv-licenses.zip') },
  };
  assert.doesNotThrow(() => validateMpvManifest(mpv, root));
  assert.throws(() => validateMpvManifest({ ...mpv, mesonOptions: mpv.mesonOptions.filter(option => option !== '-Dgpl=false') }, root), /-Dgpl=false/);
  assert.throws(() => validateMpvManifest({ ...mpv, reproducibleSource: false }, root), /对应源码/);
  assert.throws(() => validateMpvManifest({ ...mpv, components: mpv.components.filter(component => component.name !== 'libplacebo') }, root), /libplacebo/);
  assert.throws(() => validateMpvManifest({ ...mpv, linkedFfmpeg: { license: 'GPL-2.0-or-later', configureFlags: ['--enable-gpl'] } }, root), /必须是 LGPL/);
  assert.throws(() => validateMpvManifest({ ...mpv, linkedFfmpeg: { ...mpv.linkedFfmpeg, configureFlags: [...mpv.linkedFfmpeg.configureFlags, '--enable-libx265'] } }, root), /GPL\/nonfree/);
  console.log('Independent libmpv runtime policy tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
