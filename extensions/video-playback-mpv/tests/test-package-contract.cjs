const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, '26.8.28.3');
const backend = manifest.runtimeContributions.find(item => item.type === 'media.playbackBackend');
assert.equal(backend.backendVersion, '1.2.1');
assert.equal(backend.protocolVersion, 1);
assert.equal(backend.features.transforms.crop, false);
assert.equal(backend.features.hardwareDecoding.selectable, false);
assert.deepEqual(backend.features.capture, { sourceFrame: true, displayedFrame: true });
assert.equal(pkg.photoflowComponent.manifest, 'component.template.json');
assert.equal(pkg.photoflowComponent.development.runtime.command, 'dist/components/video-playback-mpv/advanced-video-decoder.exe');
assert.deepEqual(pkg.photoflowComponent.development.files, {
  'advanced-video-decoder.exe': 'dist/components/video-playback-mpv/advanced-video-decoder.exe',
  'libmpv-2.dll': 'dist/components/video-playback-mpv/libmpv-2.dll',
});
for (const script of ['build', 'build:runtime', 'build:release', 'test', 'sign', 'verify', 'install', 'repair', 'upgrade', 'uninstall']) assert(pkg.scripts[script]);
for (const required of [
  'media-runtime.lock.json',
  'scripts/vendor/runtime-policy.cjs',
  'scripts/vendor/component-integrity.cjs',
  'scripts/vendor/deterministic-dotnet-assembly.cjs',
  'scripts/vendor/pe-dependency-closure.cjs',
  'media-runtime/build-libmpv-lgpl-windows.sh',
  'media-runtime/build-libmpv-dependencies-windows.sh',
  'media-runtime/create-mpv-manifest.cjs',
  'media-runtime/verify-runtime.cjs',
  'scripts/build-release.cjs',
  'protocol/index.d.ts',
  'protocol/component-manifest-v2.schema.json',
  'protocol/media-playback-backend-v1.schema.json',
  'protocol/media-playback-backend-wire-v1.schema.json',
]) assert(fs.existsSync(path.join(root, required)), `missing standalone resource ${required}`);
for (const schema of ['component-manifest-v2.schema.json', 'media-playback-backend-v1.schema.json', 'media-playback-backend-wire-v1.schema.json']) JSON.parse(fs.readFileSync(path.join(root, 'protocol', schema), 'utf8'));
const ownedBuildSources = ['scripts/build.cjs', 'scripts/build-release.cjs', 'media-runtime/build-libmpv-lgpl-windows.sh', 'media-runtime/build-libmpv-dependencies-windows.sh'].map(file => fs.readFileSync(path.join(root, file), 'utf8'));
for (const buildSource of ownedBuildSources) assert(!buildSource.includes('repoRoot') && !buildSource.includes('scripts/media-runtime') && !buildSource.includes('extensions/video-playback-mpv'), 'build may not reference an enclosing repository');
if (process.platform === 'win32') {
  const framework = ['Framework64', 'Framework'].map(name => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', name, 'v4.0.30319')).find(value => fs.existsSync(path.join(value, 'csc.exe')));
  const output = path.join(os.tmpdir(), `photoflow-playback-backend-${process.pid}.exe`);
  const result = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', `/out:${output}`, `/reference:${path.join(framework, 'System.Windows.Forms.dll')}`, `/reference:${path.join(framework, 'System.Drawing.dll')}`, `/reference:${path.join(framework, 'System.Web.Extensions.dll')}`, path.join(root, 'src', 'AdvancedVideoDecoder.cs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.rmSync(output, { force: true });
}
console.log('Independent playback backend package/version/build/lifecycle contract tests passed.');
