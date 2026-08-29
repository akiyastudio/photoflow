const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = value => fs.readFileSync(path.join(root, value), 'utf8');
const decoder = read('extensions/video-playback-mpv/AdvancedVideoDecoder.cs');
const player = read('src/components/AdvancedVideoPlayer.tsx');
const preload = read('electron/preload.cjs');
const ipc = read('electron/modules/advanced-video-ipc.cjs');
const workspace = read('src/features/workspace/ProjectWorkspace.tsx');
const hoverThumbnail = read('src/components/VideoHoverThumbnail.tsx');
const versions = read('src/components/VersionManager.tsx');
const config = read('src/features/app/app-config.ts');
const ts = require('typescript');

const sizeJavaScript = ts.transpileModule(read('src/features/app/video-player-settings.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const sizeModule = { exports: {} };
new Function('exports', 'module', 'require', sizeJavaScript)(sizeModule.exports, sizeModule, require);
const { DEFAULT_SUBTITLE_FONT_SIZE, MIN_SUBTITLE_FONT_SIZE, MAX_SUBTITLE_FONT_SIZE, normalizeSubtitleFontSize } = sizeModule.exports;

const memoryJavaScript = ts.transpileModule(read('src/components/video-subtitle-memory.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const memoryModule = { exports: {} };
new Function('exports', 'module', 'require', memoryJavaScript)(memoryModule.exports, memoryModule, require);
const {
  MAX_SUBTITLE_MEMORIES,
  findSubtitleMemory,
  normalizeVideoMemoryFileKey,
  parseSubtitleMemoryStore,
  resolveRememberedSubtitle,
  updateSubtitleMemoryStore,
} = memoryModule.exports;

assert.strictEqual(normalizeVideoMemoryFileKey(' C:\\Shoot\\\\DAY1\\Clip.MOV '), 'c:/shoot/day1/clip.mov');
assert.strictEqual(normalizeVideoMemoryFileKey('c:/shoot/day1/clip.mov'), 'c:/shoot/day1/clip.mov');
const migrated = parseSubtitleMemoryStore(null, JSON.stringify({
  'C:\\Shoot\\Clip.MOV': { stableId: 'embedded:zh:title:ass:0', delay: 50, visible: false, updatedAt: 7 },
}));
assert.deepStrictEqual(findSubtitleMemory(migrated, 'c:/shoot//clip.mov'), {
  fileKey: 'c:/shoot/clip.mov', selection: { mode: 'track', stableId: 'embedded:zh:title:ass:0' }, delay: 30, visible: false, updatedAt: 7,
});
let store = parseSubtitleMemoryStore(null);
store = updateSubtitleMemoryStore(store, 'C:\\shoot\\clip.mov', { selection: { mode: 'off' }, delay: -2, visible: false, updatedAt: 0 }, 10);
assert.strictEqual(resolveRememberedSubtitle(findSubtitleMemory(store, 'c:/SHOOT/clip.mov'), []).mode, 'off', 'an explicit off selection must survive reopening even without tracks');
store = updateSubtitleMemoryStore(store, 'c:/shoot/clip.mov', { selection: { mode: 'track', stableId: 'external:clip.zh.srt:0' }, delay: 1.5, visible: true, updatedAt: 0 }, 11);
const rememberedTrack = { id: '4', stableId: 'external:clip.zh.srt:0', source: 'external', selected: false };
assert.deepStrictEqual(resolveRememberedSubtitle(findSubtitleMemory(store, 'C:\\SHOOT\\CLIP.MOV'), [rememberedTrack]), { mode: 'track', track: rememberedTrack, delay: 1.5, visible: true });
assert.strictEqual(resolveRememberedSubtitle(findSubtitleMemory(store, 'c:/shoot/clip.mov'), []).mode, 'missing', 'a vanished track must not select an unrelated subtitle');
for (let index = 0; index < MAX_SUBTITLE_MEMORIES + 5; index += 1) {
  store = updateSubtitleMemoryStore(store, `c:/video/${index}.mov`, { selection: { mode: 'off' }, delay: 0, visible: false, updatedAt: 0 }, 100 + index);
}
assert.strictEqual(store.entries.length, 100);
assert.strictEqual(findSubtitleMemory(store, 'c:/video/0.mov'), undefined, 'the oldest per-video memory must be evicted');
assert.strictEqual(DEFAULT_SUBTITLE_FONT_SIZE, 55);
assert.strictEqual(normalizeSubtitleFontSize('default'), 55);
assert.strictEqual(normalizeSubtitleFontSize('large'), 74);
assert.strictEqual(normalizeSubtitleFontSize(63.6), 64);
assert.strictEqual(normalizeSubtitleFontSize(1), 16);
assert.strictEqual(normalizeSubtitleFontSize(999), 120);
assert.deepStrictEqual([MIN_SUBTITLE_FONT_SIZE, MAX_SUBTITLE_FONT_SIZE], [16, 120]);

assert(decoder.includes('SetOption("sub-auto", "no")') && decoder.includes('SetOption("sid", "no")') && decoder.includes('SetOption("sub-visibility", "no")'), 'subtitle discovery must start hidden');
for (const extension of ['.srt', '.ass', '.ssa', '.vtt']) assert(decoder.includes(`extension == "${extension}"`), `${extension} sidecars must be supported`);
for (const command of ['subtitle-select', 'subtitle-visible', 'subtitle-delay', 'subtitle-style', 'subtitle-add']) assert(decoder.includes(`name == "${command}"`), `${command} must be handled by libmpv`);
assert(decoder.includes('stableId') && decoder.includes('source') && decoder.includes('language') && decoder.includes('format') && decoder.includes('external-filename'), 'track protocol must expose stable typed metadata');
assert(player.includes('添加本地字幕') && player.includes('提前') && player.includes('延后') && player.includes('归零') && player.includes("{ label: '小', value: 20 }") && player.includes("{ label: '中', value: 30 }") && player.includes("{ label: '大', value: 40 }"), 'CC menu must expose 20/30/40 small, medium and large subtitle shortcuts');
assert(player.includes('disableSubtitles') && player.includes("selection: { mode: 'off' }") && player.includes('resolveRememberedSubtitle'), 'the CC menu must persist explicit off and restore through the memory state model');
assert(preload.includes("ipcRenderer.invoke('video-player-subtitle-choose'") && ipc.includes("properties: ['openFile']") && ipc.includes("extensions: ['srt', 'ass', 'ssa', 'vtt']"), 'local subtitle selection must stay behind the Electron native-dialog boundary');
assert(config.includes('subtitlesEnabled: false') && config.includes('subtitleSize: DEFAULT_SUBTITLE_FONT_SIZE') && config.includes("subtitleStyle: 'standard'"), 'global subtitle defaults must remain disabled and numerically normalized');
assert(read('src/features/settings/SettingsFeature.tsx').includes('type="range"') && read('src/features/settings/SettingsFeature.tsx').includes('step={1}') && read('src/features/settings/SettingsFeature.tsx').includes('aria-label="字幕字号"'), 'global subtitle size must use a one-step slider with a numeric readout');
assert(decoder.includes('ReadSubtitleFontSize') && decoder.includes('sub-font-size') && decoder.includes('normalized / 55.0'), 'native subtitle sizing must accept bounded integer values while preserving legacy scale behavior');
assert(hoverThumbnail.includes('<video ref={videoRef}')
  && hoverThumbnail.includes('muted playsInline')
  && hoverThumbnail.includes('activeHoverVideo')
  && hoverThumbnail.includes('onMouseMove')
  && hoverThumbnail.includes('onEnded={restartPlayback}')
  && workspace.includes('HOVER_VIDEO_PLAY_DELAY_MS = 300'),
'thumbnail hover previews must use one delayed, muted, seekable, looping Chromium playback surface');
assert(player.includes("backend === 'chromium'") && player.includes('<video') && !workspace.includes('<video') && !versions.includes('<video'), 'formal playback paths must share one native-first player with an internal Chromium fallback');
assert(decoder.includes('GetProperty("track-list/count")') && decoder.includes('"track-list/" + index') && !decoder.includes('GetProperty("track-list")'), 'libmpv node arrays must be read through indexed scalar properties');
assert(decoder.indexOf('player.LoadPendingSidecars()') > decoder.indexOf('type == "file-loaded"') && decoder.indexOf('Run("loadfile"') < decoder.indexOf('player.LoadPendingSidecars()'), 'sidecars must be attached only after the active file-loaded event');
assert(decoder.includes('Path.GetFileName(path)') && !decoder.includes('Path.GetFullPath(path)).ToLowerInvariant()'), 'external stable ids must not embed an absolute machine path');
assert(decoder.includes('if (selectedId != null) break;') && decoder.includes('SubtitleLanguageMatches'), 'preferred-language selection must stop at the first matching preference and accept language subtags');

console.log('Video player subtitle contracts passed.');
