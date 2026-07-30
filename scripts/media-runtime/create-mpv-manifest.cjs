const fs = require('fs');
const path = require('path');
const { sha256File } = require('./runtime-policy.cjs');

const [artifactRootArg] = process.argv.slice(2);
if (!artifactRootArg) throw new Error('用法：node create-mpv-manifest.cjs <产物目录>');
const root = path.resolve(artifactRootArg);
const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'media-runtime.lock.json'), 'utf8'));
const configureFlags = fs.readFileSync(path.join(root, 'linked-ffmpeg-buildconf.txt'), 'utf8')
  .split(/\s+/).filter(flag => flag.startsWith('--'));
const mpvCommit = fs.readFileSync(path.join(root, 'mpv-commit.txt'), 'utf8').trim();
const ffmpegVersion = fs.readFileSync(path.join(root, 'linked-ffmpeg-version.txt'), 'utf8').trim();
const ffmpegCommit = fs.readFileSync(path.join(root, 'linked-ffmpeg-commit.txt'), 'utf8').trim();
const artifact = file => ({ file, sha256: sha256File(path.join(root, file)) });
const files = fs.readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.dll')
  .map(entry => artifact(entry.name));
const manifest = {
  schemaVersion: 1,
  kind: 'photoflow-libmpv-runtime',
  platform: 'windows-x64',
  license: 'LGPL-2.1-or-later',
  mpv: { version: lock.mpv.version, repository: lock.mpv.repository, ref: lock.mpv.ref, commit: mpvCommit },
  mesonOptions: ['-Dgpl=false', '-Dlibmpv=true', '-Dcplayer=false', '-Dbuild-date=false'],
  linkedFfmpeg: { version: ffmpegVersion, commit: ffmpegCommit, license: 'LGPL-2.1-or-later', configureFlags },
  files,
  complianceArtifacts: {
    sourceArchive: artifact('libmpv-lgpl-corresponding-source.zip'),
    licenseArchive: artifact('libmpv-lgpl-licenses.zip'),
  },
};
fs.writeFileSync(path.join(root, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
