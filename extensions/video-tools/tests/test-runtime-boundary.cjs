const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
assert.equal(manifest.entrypoints['win32-x64'], 'runtime/video-tools-worker.exe');
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
const playback = fs.readFileSync(path.join(repo, 'plugins', 'video-playback-backend', 'src', 'AdvancedVideoDecoder.cs'), 'utf8');
assert(playback.includes('--timeline-request') && playback.includes('ExtractTimelineFrames'));
console.log('Video tools runtime is physically isolated and playback owns timeline extraction');
