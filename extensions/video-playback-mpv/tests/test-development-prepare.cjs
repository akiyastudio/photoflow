const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareDevelopmentBackend } = require('../scripts/prepare-development.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-playback-development-'));
const write = (relative, value) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
try {
  const lock = { mpv: { version: 'fixture', commit: 'mpv-commit' }, ffmpeg: { commit: 'ffmpeg-commit' } };
  write('media-runtime.lock.json', JSON.stringify(lock));
  write('component.template.json', JSON.stringify({ id: 'video-playback-mpv', entrypoints: { 'win32-x64': 'advanced-video-decoder.exe' } }));
  write('scripts/vendor/playback-runtime-capabilities.cjs', 'fixture');
  for (const file of ['src/AdvancedVideoDecoder.cs', 'scripts/build.cjs', 'scripts/prepare-development.cjs', 'scripts/vendor/runtime-policy.cjs', 'scripts/vendor/component-integrity.cjs', 'scripts/vendor/deterministic-dotnet-assembly.cjs', 'scripts/vendor/pe-dependency-closure.cjs']) write(file, 'fixture');
  const runtime = { mpv: lock.mpv, linkedFfmpeg: lock.ffmpeg, files: [{ file: 'libmpv-2.dll' }, { file: 'dependency.dll' }], complianceArtifacts: { sourceArchive: { file: 'source.zip' }, licenseArchive: { file: 'licenses.zip' } } };
  const runtimeRelative = 'artifacts/installers/media-runtime/libmpv-lgpl-windows-x64';
  write(`${runtimeRelative}/runtime-manifest.json`, JSON.stringify(runtime));
  for (const name of ['libmpv-2.dll', 'dependency.dll', 'source.zip', 'licenses.zip']) write(`${runtimeRelative}/${name}`, 'fixture runtime');
  let builds = 0, failBuild = false;
  const options = {
    componentRoot: root, environment: {}, platform: 'win32', arch: 'x64', log: () => undefined,
    spawnSyncImpl: (_command, args, spawnOptions) => {
      builds += 1;
      assert(args.includes('--development'), 'development startup must not produce a release ZIP');
      assert.equal(spawnOptions.windowsHide, true);
      assert.equal(args[args.indexOf('--mpv-root') + 1], path.join(root, runtimeRelative));
      if (failBuild) return { status: 1 };
      for (const name of ['advanced-video-decoder.exe', 'libmpv-2.dll', 'dependency.dll']) write(`dist/components/video-playback-mpv/${name}`, `compiled-${builds}`);
      return { status: 0 };
    },
  };
  assert.equal(prepareDevelopmentBackend(options).rebuilt, true);
  assert.equal(builds, 1);
  assert.equal(prepareDevelopmentBackend(options).rebuilt, false);
  assert.equal(builds, 1, 'unchanged startup reuses compiled files');
  fs.unlinkSync(path.join(root, 'dist/components/video-playback-mpv/dependency.dll'));
  assert.equal(prepareDevelopmentBackend(options).rebuilt, true);
  assert.equal(builds, 2, 'missing transitive DLL triggers repair');
  write('src/AdvancedVideoDecoder.cs', 'changed source');
  assert.equal(prepareDevelopmentBackend(options).rebuilt, true);
  assert.equal(builds, 3, 'source changes invalidate preparation');
  const stamp = fs.readFileSync(path.join(root, '.cache/development-backend.json'), 'utf8');
  failBuild = true; write('src/AdvancedVideoDecoder.cs', 'another source change');
  assert.throws(() => prepareDevelopmentBackend(options), /构建失败/);
  assert.equal(fs.readFileSync(path.join(root, '.cache/development-backend.json'), 'utf8'), stamp, 'failed build must not publish a ready stamp');
  fs.unlinkSync(path.join(root, runtimeRelative, 'licenses.zip'));
  assert.throws(() => prepareDevelopmentBackend(options), /构建输入不完整/);
  assert.equal(prepareDevelopmentBackend({ ...options, platform: 'linux' }).skipped, true);
  console.log('Playback development preparation: first build, reuse, missing DLL, changed source and failed build tests passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
