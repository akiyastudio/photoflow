const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
assert.equal(manifest.entrypoints['win32-x64'], 'runtime/video-tools-worker.exe');
for (const relative of ['requirements.txt', 'scripts/setup-python.cjs', 'media-runtime.lock.json', 'media-runtime/vendor/windows-x64/ffmpeg-runtime-windows-x64.zip', 'media-runtime/vendor/windows-x64/ffmpeg-runtime-manifest.json', 'scripts/media-runtime/runtime-policy.cjs']) assert(fs.existsSync(path.join(root, relative)), `component source boundary is missing ${relative}`);
for (const name of ['ffmpeg_transcode.py', 'cut_video.py', 'ffmpeg_utils.py', 'video_preview.py']) {
  assert(fs.existsSync(path.join(root, 'runtime', name)), `component runtime is missing ${name}`);
  assert(!fs.existsSync(path.join(repo, 'python', name)), `base Python worker still owns ${name}`);
}
const worker = fs.readFileSync(path.join(root, 'runtime', 'worker.py'), 'utf8');
assert(worker.includes("parsed.tool == 'ffmpeg_transcode'") && worker.includes("parsed.tool == 'cut_video'") && worker.includes("parsed.tool == 'video_preview'"));
assert(!fs.readFileSync(path.join(root, 'runtime', 'cut_video.py'), 'utf8').includes('--timeline-frames'), 'timeline extraction must not remain in video-tools');
const buildPython = fs.readFileSync(path.join(repo, 'scripts', 'build-python.cjs'), 'utf8');
assert(!buildPython.includes("'--hidden-import', 'ffmpeg_transcode'") && !buildPython.includes("'--hidden-import', 'cut_video'") && !buildPython.includes("'--hidden-import', 'video_preview'"));
const packageJson = fs.readFileSync(path.join(repo, 'package.json'), 'utf8');
assert(!packageJson.includes('"to": "python/ffmpeg.zip"'), 'base installer must not carry the encoder FFmpeg archive');
assert(!fs.existsSync(path.join(repo, 'media-runtime.lock.json')) && !fs.existsSync(path.join(repo, 'media-runtime')) && !fs.existsSync(path.join(repo, 'scripts', 'prepare-ffmpeg.cjs')) && !fs.existsSync(path.join(repo, 'scripts', 'media-runtime')), 'encoder build materials must not remain at repository root');
const componentPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const developmentRuntime = componentPackage.photoflowComponent.development.runtime;
assert.equal(componentPackage.photoflowComponent.development.prepare, 'prepare:dev');
assert.equal(developmentRuntime.command.win32, '.venv/Scripts/python.exe');
assert(!fs.existsSync(path.join(root, 'dev-python.cmd')), 'development runtime must not pass a batch file directly to child_process.spawn');
if (process.platform === 'win32') {
  const command = path.join(root, developmentRuntime.command.win32);
  const result = spawnSync(command, [...developmentRuntime.argsPrefix, path.join(root, developmentRuntime.entry), 'ffmpeg_transcode', '--inspect-only', '--skip-capability-probe'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined, `direct development runtime spawn failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"type":\s*"success"/, 'direct development runtime must complete a real JSONL inspection');
}
const packageScript = fs.readFileSync(path.join(root, 'scripts', 'package-component.cjs'), 'utf8');
assert(!packageScript.includes("path.resolve(root, '..', '..')") && !packageScript.includes('artifacts/python') && packageScript.includes("path.join(root, '.venv'"), 'component packaging must use only component-local build inputs');
assert(packageScript.includes("process.argv.indexOf('--output-dir')") && packageScript.includes('path.join(archiveRoot, `PhotoFlow-${manifest.id}-'), 'component packaging must honor the host build output directory');
const playback = fs.readFileSync(path.join(repo, 'extensions', 'video-playback-mpv', 'src', 'AdvancedVideoDecoder.cs'), 'utf8');
assert(playback.includes('--timeline-request') && playback.includes('ExtractTimelineFrames'));
console.log('Video tools runtime is physically isolated and playback owns timeline extraction');
