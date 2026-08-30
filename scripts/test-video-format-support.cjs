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
  'python/workspace_db.py',
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

console.log('video format and smooth-playback regression tests passed.');
