const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const rendererSession = read('src/platform/video-playback/playback-session.ts');
const player = read('src/components/AdvancedVideoPlayer.tsx');
const workspace = read('src/features/workspace/ProjectWorkspace.tsx');
const versions = read('src/components/VersionManager.tsx');
const settings = read('src/features/settings/SettingsFeature.tsx');
const nativeService = read('electron/services/video-playback-process-service.cjs');
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
assert(nativeService.includes('mediaInputSessionService') && nativeService.includes('captureService') && nativeService.includes('nativeSurfaceService') && nativeService.includes('subtitleInputService.discover'), 'the native adapter must use generic host security and host-authorized subtitle capabilities');
assert(workspace.includes('<VideoPlayer filePath={entry.path}') && workspace.includes('keyboardSettings={keyboardSettings}') && workspace.includes('onToggleFullscreen={() => setFullscreen(current => !current)}'), 'ProjectWorkspace must render the shared player and route workspace settings/fullscreen controls into it');
assert(versions.includes('<VideoPlayer filePath={version.filePath}') && versions.includes('keyboardSettings={videoPlaybackSettings}'), 'VersionManager must render the shared player with the application playback settings');
assert(player.includes("controlPanel === 'display'") && player.includes("action: 'transform'") && player.includes("action:'hdr-mode'") && player.includes("action:'tone-mapping'") && player.includes("action:'audio-select'"), 'rendered display, HDR/tone-map, transform, and audio controls must issue PlaybackSession commands');
assert(settings.includes('title="HDR 输出"') && settings.includes('title="色调映射算法"') && settings.includes('videoPlaybackSettings.targetPeakNits') && settings.includes('VIDEO_ACTIONS.map') && settings.includes('exportVideoShortcuts') && settings.includes('importVideoShortcuts'), 'video settings must render HDR, target peak, and complete shortcut import/export controls');

console.log('Video playback architecture ownership tests passed.');
