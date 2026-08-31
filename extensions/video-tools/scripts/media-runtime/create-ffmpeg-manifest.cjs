const fs = require('fs');
const path = require('path');
const { sha256File } = require('./runtime-policy.cjs');

const [artifactRootArg, configureFileArg] = process.argv.slice(2);
if (!artifactRootArg || !configureFileArg) throw new Error('用法：node create-ffmpeg-manifest.cjs <产物目录> <configure-flags.txt>');
const root = path.resolve(artifactRootArg);
const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'media-runtime.lock.json'), 'utf8'));
const configureFlags = fs.readFileSync(path.resolve(configureFileArg), 'utf8').trim().split(/\s+/).filter(Boolean);
const artifact = file => ({ file, sha256: sha256File(path.join(root, file)) });
const manifest = {
  schemaVersion: 4,
  kind: 'photoflow-ffmpeg-runtime',
  platform: 'windows-x64',
  license: 'GPL-2.0-or-later',
  reproducibleSource: true,
  ffmpeg: { version: lock.ffmpeg.version, repository: lock.ffmpeg.repository, commit: lock.ffmpeg.commit },
  components: [
    { name: 'x264', repository: lock.x264.repository, commit: lock.x264.commit, license: lock.x264.license },
    { name: 'x265', version: lock.x265.version, repository: lock.x265.repository, commit: lock.x265.commit, license: lock.x265.license },
    { name: 'zlib', version: lock.zlib.version, repository: lock.zlib.repository, commit: lock.zlib.commit, license: lock.zlib.license },
    { name: 'zimg', version: lock.zimg.version, repository: lock.zimg.repository, commit: lock.zimg.commit, license: lock.zimg.license },
    ...['freetype', 'fribidi', 'harfbuzz', 'libass'].map(name => ({ name, version: lock.mpvDependencies[name].version, repository: lock.mpvDependencies[name].repository, commit: lock.mpvDependencies[name].commit, license: lock.mpvDependencies[name].license })),
    { name: 'nv-codec-headers', version: lock.nvCodecHeaders.version, repository: lock.nvCodecHeaders.repository, commit: lock.nvCodecHeaders.commit, license: lock.nvCodecHeaders.license },
    { name: 'libplacebo', version: lock.libplacebo.version, repository: lock.libplacebo.repository, commit: lock.libplacebo.commit, license: lock.libplacebo.license },
  ],
  configureFlags,
  artifacts: {
    runtimeArchive: artifact('ffmpeg-runtime-windows-x64.zip'),
    sourceArchive: artifact('ffmpeg-corresponding-source.zip'),
    licenseArchive: artifact('ffmpeg-licenses.zip'),
  },
};
fs.writeFileSync(path.join(root, 'ffmpeg-runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const checksumFiles = ['ffmpeg-runtime-manifest.json', ...Object.values(manifest.artifacts).map(item => item.file)];
fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), `${checksumFiles.map(file => `${sha256File(path.join(root, file))}  ${file}`).join('\n')}\n`);
