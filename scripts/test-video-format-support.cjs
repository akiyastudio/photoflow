const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const addedExtensions = ['.mpeg', '.mpg', '.mts', '.m2ts'];
const registries = [
  'electron/main.cjs',
  'electron/thumbnail-pipeline.cjs',
  'electron/services/watch-change-filter.cjs',
  'electron/modules/broll-import.cjs',
  'src/features/versioning/ProgressPairPreview.tsx',
  'src/platform/video-playback/playback-session.ts',
  'python/workspace_media_actions.py',
  'python/thumbnail_db.py',
  'python/classify.py',
  'python/rename.py',
  'extensions/video-tools/runtime/worker.py',
  'extensions/video-tools/runtime/ffmpeg_transcode.py',
  'extensions/video-tools/runtime/cut_video.py',
];

for (const relativePath of registries) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  for (const extension of addedExtensions) {
    assert(
      source.includes(`'${extension}'`) || source.includes(`"${extension}"`),
      `${relativePath} must recognize ${extension} as video`,
    );
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/video-playback-mpv/component.template.json'), 'utf8'));
const backend = manifest.runtimeContributions.find(item => item.type === 'media.playbackBackend');
for (const extension of addedExtensions) assert(backend.probe.extensions.includes(extension), `playback backend must declare ${extension}`);

const decoder = fs.readFileSync(path.join(root, 'extensions/video-playback-mpv/src/AdvancedVideoDecoder.cs'), 'utf8');
assert(decoder.includes('SetOption("vo", probeOnly ? "null" : "gpu-next,gpu")'), 'advanced playback must prefer gpu-next with gpu fallback');
assert.equal((decoder.match(/fflags=\+genpts\+igndts/g) || []).length, 1, 'timestamp repair must be limited to the bounded recovery path');

const bundledRuntime = fs.readFileSync(path.join(root, 'electron/services/bundled-python-runtime.cjs'), 'utf8');
assert(bundledRuntime.includes('`--video_tools_arg=${value}`') && !bundledRuntime.includes("['--video_tools_arg', value]"), 'rename must bind forwarded video runtime flags with = so argparse accepts values such as -u');
assert(bundledRuntime.includes("baseName === 'rename' && renameNeedsFrameRuntime(args, { fs, path })") && bundledRuntime.includes("error?.code !== 'PLUGIN_MISSING'") && bundledRuntime.includes('resolveLegacyRuntimeRunConfig'), 'image comparison must treat the capability-discovered video runtime as an optional frame adapter');
const { renameNeedsFrameRuntime } = require('../electron/services/rename-runtime-model.cjs');
const runtimeProbeRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'photoflow-rename-runtime-'));
try {
  const imageA = path.join(runtimeProbeRoot, 'image-a'); const imageB = path.join(runtimeProbeRoot, 'image-b');
  fs.mkdirSync(imageA); fs.mkdirSync(imageB); fs.writeFileSync(path.join(imageA, 'one.jpg'), 'jpg'); fs.writeFileSync(path.join(imageB, 'one.tif'), 'tif');
  assert.equal(renameNeedsFrameRuntime(['--folder_a', imageA, '--folder_b', imageB], { fs, path }), false, 'JPG/TIFF comparison stays independent from video-tools');
  fs.writeFileSync(path.join(imageA, 'clip.mov'), 'mov');
  assert.equal(renameNeedsFrameRuntime(['--folder_a', imageA, '--folder_b', imageB], { fs, path }), true, 'video comparison may request the optional frame runtime');
  fs.rmSync(path.join(imageA, 'clip.mov')); fs.writeFileSync(path.join(imageB, 'camera.cr3'), 'raw');
  assert.equal(renameNeedsFrameRuntime(['--folder_a', imageA, '--folder_b', imageB], { fs, path }), true, 'RAW comparison may request the optional frame runtime used for decoding');
  assert.equal(renameNeedsFrameRuntime([`--folder_a=${imageA}`, `--folder_b=${imageB}`], { fs, path }), true, 'argparse equals-form folder options must be recognized');
} finally { fs.rmSync(runtimeProbeRoot, { recursive: true, force: true }); }

console.log('video format and smooth-playback regression tests passed.');
