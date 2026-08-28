const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const rendererSession = read('src/platform/video-playback/playback-session.ts');
const player = read('src/components/AdvancedVideoPlayer.tsx');
const nativeService = read('electron/services/advanced-video-service.cjs');
const broker = read('electron/services/video-playback-broker.cjs');

for (const source of [rendererSession, player, nativeService]) {
  for (const forbidden of ['video-playback-mpv', 'advanced-video-decoder.exe', 'libmpv-2.dll', 'gpu-api', 'track-list/']) {
    assert(!source.includes(forbidden), `application playback code must not contain backend implementation knowledge: ${forbidden}`);
  }
}
assert(rendererSession.includes('VideoPlaybackBackendDescriptor') && rendererSession.includes('backendId: PlaybackBackendId') && rendererSession.includes('discoverPlaybackBackends'), 'renderer sessions must consume generic discovered descriptors');
assert(!rendererSession.includes("'chromium' | 'component'") && !player.includes('new ComponentPlaybackBackend'), 'renderer backend types must not be a fixed legacy pair');
assert(nativeService.includes('playbackBroker.resolveRunConfigAsync') && !nativeService.includes('COMPONENT_ID'), 'native session service must resolve opaque backend ids through the broker');
assert(!broker.includes('video-playback-mpv') && broker.includes('parseMediaPlaybackBackendContributions'), 'the broker must require a declared contribution instead of manufacturing a fixed legacy backend');
assert(rendererSession.includes('languageMatches'), 'subtitle default selection policy must live in the application session');
assert(nativeService.includes('mediaInputSessionService') && nativeService.includes('captureService') && nativeService.includes('nativeSurfaceService'), 'the native adapter must use generic host security capabilities');

console.log('Video playback architecture ownership tests passed.');
