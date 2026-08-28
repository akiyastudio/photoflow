import assert from 'node:assert/strict';
import { startPlaybackSession } from '../src/platform/video-playback/playback-session.ts';

const settings = { arrowKeyAction: 'seek', subtitlesEnabled: true, subtitlePreferredLanguages: ['zh'], subtitleSize: 55, subtitleStyle: 'standard', hdrMode:'tone-map',toneMapping:'bt2390',targetPeakNits:600,shortcuts:{} };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const descriptor = backendId => ({ backendId, protocolVersion: 1, transport: 'native-process-v1', displayName: backendId, priority: 50, probe: { support: 'probably', basis: 'test' } });

const makeBackend = (backendId, { behavior = 'success', startStates = [], gate = null } = {}) => {
  const calls = { starts: 0, closes: 0, controls: [], runtimeFailure: null, onState: null };
  return {
    descriptor: descriptor(backendId), calls,
    async start(context) {
      calls.starts += 1;
      calls.runtimeFailure = context.onRuntimeFailure;
      calls.onState = state => context.onState({ sessionId: backendId, playerId: context.playerId, requestId: context.requestId, ...state });
      if (gate) await gate.promise;
      if (behavior === 'fail') throw new Error(`${backendId} startup failed`);
      for (const state of startStates) context.onState({ sessionId: backendId, playerId: context.playerId, requestId: context.requestId, ...state });
      return {
        id: `${backendId}-session`, backendId,
        control(request) { calls.controls.push(structuredClone(request)); }, setBounds() {},
        async capture() { return { success: true }; }, async chooseSubtitle() { return { success: true }; },
        async close() { calls.closes += 1; },
      };
    },
  };
};

const contextFor = (states = []) => ({
  filePath: 'C:/project/media.bin', settings, playerId: 'player-test', requestId: `request-${states.length}`,
  video: {}, electronApi: {}, onState: state => states.push(state),
});

{
  const missing = makeBackend('optional-a', { behavior: 'fail' });
  const chromium = makeBackend('core.chromium');
  const session = await startPlaybackSession({ backends: [missing, chromium], context: contextFor() });
  assert.equal(session.backendId, 'core.chromium');
  assert.deepEqual([missing.calls.starts, chromium.calls.starts], [1, 1], 'a missing contribution must not disable the built-in backend');
  await session.close();
}

{
  const startupTracks = [
    { id: 'en-1', stableId: 'embedded:en:title:srt:0', source: 'embedded', language: 'en', selected: true },
    { id: 'zh-7', stableId: 'embedded:zh:title:srt:0', source: 'embedded', language: 'zh-CN', selected: false },
  ];
  const backend = makeBackend('subtitle-policy', { startStates: [
    { type: 'file-loaded', buffering: false },
    { type: 'subtitle-tracks', subtitleTracks: startupTracks, subtitleTrackId: 'en-1', subtitleVisible: true, subtitleDelay: 0 },
  ] });
  const session = await startPlaybackSession({ backends: [backend], context: contextFor() });
  assert.deepEqual(backend.calls.controls.filter(request => request.action.startsWith('subtitle-')), [
    { action: 'subtitle-delay', value: 0 },
    { action: 'subtitle-select', value: 'zh-7' },
    { action: 'subtitle-visible', value: true },
  ], 'backend-selected startup tracks must not override the application preferred-language policy');
  assert.equal(backend.calls.controls.some(request => request.action === 'subtitle-select' && request.value === 'en-1'), false);
  await session.close();
}

{
  const chromium = makeBackend('core.chromium', { behavior: 'fail' });
  const contributed = makeBackend('vendor.decoder');
  const session = await startPlaybackSession({ backends: [chromium, contributed], context: contextFor() });
  assert.equal(session.backendId, 'vendor.decoder');
  assert.deepEqual([chromium.calls.starts, contributed.calls.starts], [1, 1]);
  await session.close();
}

{
  const states = [];
  const firstTrack = { id: 'native-3', stableId: 'embedded:zh:dialog:srt:0', source: 'embedded', language: 'zh-CN', selected: true };
  const restoredTrack = { ...firstTrack, id: 'fallback-9', selected: false };
  const firstAudio={id:'audio-1',stableId:'audio:zh:main:aac:0',language:'zh',codec:'aac',selected:true},restoredAudio={...firstAudio,id:'audio-8',selected:false};
  const first = makeBackend('vendor.primary', { startStates: [
    { type: 'subtitle-tracks', subtitleTracks: [firstTrack], subtitleTrackId: firstTrack.id, subtitleVisible: true, subtitleDelay: 1.25 },
    { type: 'state', time: 42, duration: 100, paused: true, volume: 37, muted: true, speed: 1.5, buffering: false },
    {type:'audio-tracks',audioTracks:[firstAudio],audioTrackId:'audio-1'},
  ] });
  const fallback = makeBackend('vendor.fallback', { startStates: [
    { type: 'subtitle-tracks', subtitleTracks: [restoredTrack], subtitleTrackId: null, subtitleVisible: false, subtitleDelay: 0 },
    { type: 'state', time: 0, duration: 100, paused: false, volume: 100, muted: false, speed: 1, buffering: false },
    {type:'audio-tracks',audioTracks:[restoredAudio],audioTrackId:null},
  ] });
  const session = await startPlaybackSession({ backends: [first, fallback], context: contextFor(states) });
  session.control({ action: 'seek', value: 51 });
  session.control({ action: 'pause' });
  first.calls.runtimeFailure('primary crashed');
  await nextTurn();
  assert.equal(session.backendId, 'vendor.fallback');
  assert.deepEqual(fallback.calls.controls, [
    { action: 'pause' },
    { action: 'volume', value: 37 },
    { action: 'mute', value: true },
    { action: 'speed', value: 1.5 },
    { action: 'seek', value: 51 },
    { action: 'subtitle-style', fontSize: 55, style: 'standard' },
    { action: 'transform', transform: { aspectMode: 'contain', rotation: 0, flipHorizontal: false, flipVertical: false } },
    { action: 'hdr-mode', hdrMode: 'tone-map' },
    {action:'tone-mapping',toneMapping:'bt2390',targetPeakNits:600},
    { action: 'statistics-level', statisticsLevel: 'off' },
    { action: 'subtitle-delay', value: 1.25 },
    { action: 'subtitle-select', value: 'fallback-9' },
    { action: 'subtitle-visible', value: true },
    {action:'audio-select',value:'audio-8'},
  ], 'fallback must restore normalized product state in a paused-first order');
  assert.equal(states.at(-1).time, 51);
  assert.equal(states.at(-1).paused, true);
  assert.equal(states.at(-1).volume, 37);
  assert.equal(states.at(-1).muted, true);
  assert.equal(states.at(-1).speed, 1.5);
  assert.equal(states.at(-1).subtitleDelay, 1.25);
  const restoredSubtitleState = [...states].reverse().find(state => state.type === 'subtitle-tracks');
  assert.equal(restoredSubtitleState.subtitleTrackId, 'fallback-9');
  assert.equal(restoredSubtitleState.subtitleVisible, true);
  assert.equal(restoredSubtitleState.subtitleDelay, 1.25);
  const restoredAudioState=[...states].reverse().find(state=>state.type==='audio-tracks');assert.equal(restoredAudioState.audioTrackId,'audio-8');
  await session.close();
}

{
  let release;
  const gate = { promise: new Promise(resolve => { release = resolve; }) };
  const first = makeBackend('race.primary');
  const delayed = makeBackend('race.delayed', { gate });
  const session = await startPlaybackSession({ backends: [first, delayed], context: contextFor() });
  first.calls.runtimeFailure('crash during close');
  await nextTurn();
  const closing = session.close();
  release();
  await closing;
  assert.equal(delayed.calls.starts, 1);
  assert.equal(delayed.calls.closes, 1, 'a fallback that finishes after close must be closed immediately');
}

{
  const first = makeBackend('manual.chromium'); const advanced = makeBackend('manual.advanced');
  const session = await startPlaybackSession({ backends: [first, advanced], context: contextFor() });
  session.control({ action: 'seek', value: 24 }); session.control({ action: 'pause' }); session.control({ action: 'transform', transform: { aspectMode: '1:1', rotation: 270, flipHorizontal: true, flipVertical: false, crop:{x:.1,y:.2,width:.7,height:.6} } });
  const switched = await session.switchBackend('manual.advanced'); assert.equal(switched.success, true); assert.equal(session.backendId, 'manual.advanced');
  assert(advanced.calls.controls.some(item => item.action === 'seek' && item.value === 24)); assert(advanced.calls.controls.some(item => item.action === 'transform' && item.transform.rotation === 270 && item.transform.crop.width === .7));
  assert.equal((await session.switchBackend('manual.chromium')).success, false, 'manual switching cannot create an automatic retry loop for an already attempted backend'); await session.close();
}

{
  const first = makeBackend('loop.a');
  const second = makeBackend('loop.b');
  const states = [];
  const session = await startPlaybackSession({ backends: [first, second], context: contextFor(states) });
  first.calls.runtimeFailure('first failed');
  await nextTurn();
  assert.equal(second.calls.controls.at(-1)?.action, 'play', 'a playing snapshot must resume only after state restoration');
  second.calls.runtimeFailure('second failed');
  await nextTurn();
  assert.deepEqual([first.calls.starts, second.calls.starts], [1, 1], 'each descriptor may be attempted only once per generation');
  assert.equal(states.at(-1)?.type, 'fatal');
  assert.equal(states.at(-1)?.errorCode, 'BACKEND_UNAVAILABLE'); assert.equal(states.at(-1)?.suggestedFallback,'system-player'); assert.deepEqual(states.at(-1)?.attempts.map(item => item.backendId), ['loop.a','loop.a','loop.b','loop.b']);
  await session.close();
}

console.log('Video playback backend discovery, state restoration, race, and failover tests passed.');
