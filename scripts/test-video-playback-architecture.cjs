const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const rendererSession = read('src/platform/video-playback/playback-session.ts');
const player = read('src/components/AdvancedVideoPlayer.tsx');
const nativeService = read('electron/services/advanced-video-service.cjs');
const broker = read('electron/services/video-playback-broker.cjs');
const decoder = read('extensions/video-playback-mpv/AdvancedVideoDecoder.cs');
const manifest = JSON.parse(read('extensions/video-playback-mpv/component.template.json'));

for (const source of [rendererSession, player, nativeService]) {
  for (const forbidden of ['video-playback-mpv', 'advanced-video-decoder.exe', 'libmpv-2.dll', 'gpu-api', 'track-list/']) {
    assert(!source.includes(forbidden), `application playback code must not contain backend implementation knowledge: ${forbidden}`);
  }
}
assert(rendererSession.includes('VideoPlaybackBackendDescriptor') && rendererSession.includes('backendId: PlaybackBackendId') && rendererSession.includes('discoverPlaybackBackends'), 'renderer sessions must consume generic discovered descriptors');
assert(!rendererSession.includes("'chromium' | 'component'") && !player.includes('new ComponentPlaybackBackend'), 'renderer backend types must not be a fixed legacy pair');
assert(nativeService.includes('playbackBroker.resolveRunConfigAsync') && !nativeService.includes('COMPONENT_ID'), 'native session service must resolve opaque backend ids through the broker');
assert(broker.includes('LEGACY_BACKEND_COMPONENT_ID'), 'legacy package identity may exist only inside the Electron compatibility broker');
assert(manifest.runtimeContributions.some(item => item.type === 'media.playbackBackend' && item.protocolVersion === 1 && item.transport === 'native-process-v1'), 'runtime-only video component must declare media.playbackBackend@v1');
assert(!decoder.includes('TogglePause') && !decoder.includes('HandleArrowKeyInput') && !decoder.includes('arrowKeysNavigate') && !decoder.includes('set-keyboard-mode'), 'native surfaces must not interpret click or arrow-key product semantics');
assert(decoder.includes('{ "type", "input" }') && decoder.includes('"pointer-button"') && decoder.includes('"ArrowLeft"') && decoder.includes('"Escape"'), 'native surfaces must forward generic raw input');
assert(!decoder.includes('subtitlePreferredLanguages') && !decoder.includes('SubtitleLanguageMatches') && rendererSession.includes('languageMatches'), 'subtitle default selection policy must live in the application session');

console.log('Video playback architecture ownership tests passed.');
