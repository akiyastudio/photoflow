import assert from 'node:assert/strict';
import { ChromiumPlaybackBackend, chromiumContainerProbe, startPlaybackSession } from '../src/platform/video-playback/playback-session.ts';

globalThis.HTMLMediaElement = { HAVE_FUTURE_DATA: 3 };
globalThis.document = { createElement: name => { if (name !== 'track') throw new Error(`unexpected element ${name}`); const element = new EventTarget(); element.track = { mode: 'disabled', cues: [] }; element.remove = () => { element.removed = true; }; return element; } };

class FakeVideo extends EventTarget {
  constructor({ failLoad = false, failMessage = 'decode failed' } = {}) {
    super();
    this.failLoad = failLoad;
    this.failMessage = failMessage;
    this.src = '';
    this.poster = 'poster';
    this.preload = '';
    this.playsInline = false;
    this.currentTime = 0;
    this.duration = 120;
    this.paused = true;
    this.readyState = 4;
    this.muted = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.videoWidth = 1920;
    this.videoHeight = 1080;
    this.style = {};
    this.error = null;
    this.nextPlayError = null;
    this.loads = 0;
    this.listenerBalance = 0;
  }
  addEventListener(...args) { this.listenerBalance += 1; return super.addEventListener(...args); }
  removeEventListener(...args) { this.listenerBalance -= 1; return super.removeEventListener(...args); }
  canPlayType(mime) { return mime === 'video/mp4' ? 'probably' : ''; }
  load() {
    this.loads += 1;
    if (!this.src) return;
    queueMicrotask(() => {
      if (this.failLoad) {
        this.error = { message: this.failMessage };
        this.dispatchEvent(new Event('error'));
      } else this.dispatchEvent(new Event('loadedmetadata'));
    });
  }
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    if (this.nextPlayError) { const error = this.nextPlayError; this.nextPlayError = null; throw error; }
    this.dispatchEvent(new Event('playing'));
  }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  getVideoPlaybackQuality() { return { totalVideoFrames: 120, droppedVideoFrames: 2 }; }
  appendChild(element) { queueMicrotask(() => element.dispatchEvent(new Event('load'))); return element; }
  requestVideoFrameCallback(callback) { this.frameCallback = callback; return 1; }
  emitFrame(mediaTime) { const callback = this.frameCallback; this.frameCallback = null; callback?.(0, { mediaTime }); }
}

const descriptor = { backendId: 'core.chromium', protocolVersion: 1, transport: 'chromium', displayName: 'Chromium', priority: 100, probe: { support: 'probably', basis: 'test' } };
const settings = { arrowKeyAction: 'seek', subtitlesEnabled: false, subtitlePreferredLanguages: [], subtitleSize: 55, subtitleStyle: 'standard' };
const context = (video, states, failures, published, subtitleChoice = { success: true, format: 'vtt', name: 'dialog.zh.vtt', mediaUrl: 'photoflow-media://file/subtitle' }) => ({
  filePath: 'C:/project/clip.mp4', settings, playerId: 'player-real', requestId: 'request-real', video,
  electronApi: {
    async getVideoPlaybackSource() { return { success: true, mediaUrl: 'photoflow-media://file/token' }; },
    async publishVideoPlayerFrame(filePath, bytes) { published.push({ filePath, bytes }); return { success: true, path: 'C:/project/frame.png' }; },
    async chooseVideoSubtitleFile() { return subtitleChoice; },
  },
  onState: state => states.push(state), onRuntimeFailure: error => failures.push(error),
});

{
  const video = new FakeVideo();
  const states = []; const failures = []; const published = [];
  assert.equal(chromiumContainerProbe(video, 'C:/project/clip.mp4'), 'probably');
  assert.equal(chromiumContainerProbe(video, 'C:/project/clip.mov'), 'unknown', 'extension hints must not claim unsupported codec capability');
  const session = await new ChromiumPlaybackBackend(descriptor).start(context(video, states, failures, published));
  video.emitFrame(0); video.emitFrame(1 / 24);
  assert.equal(video.src, 'photoflow-media://file/token');
  assert(states.some(state => state.type === 'file-loaded'));
  assert(states.some(state => state.type === 'state' && state.paused === false));
  session.control({ action: 'pause' });
  session.control({ action: 'seek', value: 33 });
  session.control({action:'frame-step'}); assert(Math.abs(video.currentTime-(33+1/24))<0.0001); session.control({action:'frame-back-step'});
  session.control({ action: 'volume', value: 40 });
  session.control({ action: 'mute', value: true });
  session.control({ action: 'speed', value: 1.5 });
  session.control({ action: 'transform', transform: { aspectMode: 'cover', rotation: 180, flipHorizontal: true, flipVertical: false } });
  const statisticsBefore=states.filter(state=>state.type==='statistics').length;session.control({ action: 'statistics-level', statisticsLevel: 'detailed' });await new Promise(resolve=>setTimeout(resolve,550));const statisticsDelta=states.filter(state=>state.type==='statistics').length-statisticsBefore;assert(statisticsDelta>=2&&statisticsDelta<=3,'Chromium detailed statistics must be capped at 4 Hz plus immediate sample');
  assert.deepEqual({ paused: video.paused, time: video.currentTime, volume: video.volume, muted: video.muted, speed: video.playbackRate }, { paused: true, time: 33, volume: 0.4, muted: true, speed: 1.5 });
  assert.equal(video.style.objectFit, 'cover'); assert.match(video.style.transform, /rotate\(180deg\)/); assert(states.some(state => state.type === 'statistics' && state.statistics.droppedFrames === 2));
  video.nextPlayError = new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'); session.control({ action: 'play' }); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(failures, [], 'an interrupted Chromium play promise is a lifecycle race, not a decoder failure');
  const subtitle = await session.chooseSubtitle(); assert.equal(subtitle.success, true); await new Promise(resolve => setImmediate(resolve)); assert(states.some(state => state.type === 'subtitle-tracks' && state.subtitleTracks.some(track => track.format === 'vtt' && track.selected)));
  video.error = { code: 3, message: 'runtime decode failure' };
  video.dispatchEvent(new Event('error'));
  assert.deepEqual(failures, ['runtime decode failure']);
  await session.close();
  assert.equal(video.src, '');
  assert.equal(video.paused, true);
  assert.equal(video.listenerBalance, 0, 'close must remove every Chromium media listener');
}

{
  const video = new FakeVideo(); const backend = new ChromiumPlaybackBackend(descriptor); const session = await backend.start(context(video, [], [], [], { success: true, format: 'ass', name: 'styled.ass' }));
  const result = await session.chooseSubtitle(); assert.equal(result.success, false); assert.equal(result.requiresFeature, 'subtitle-format:ass'); assert.match(result.error, /高级播放后端/); await session.close();
}

{
  const video = new FakeVideo({ failLoad: true });
  await assert.rejects(new ChromiumPlaybackBackend(descriptor).start(context(video, [], [], [])), /decode failed/);
  assert.equal(video.src, '');
  assert.equal(video.listenerBalance, 0, 'startup failure must clean listeners and the media source');
}

{
  const video = new FakeVideo({ failLoad: true, failMessage: 'HEVC Main10 unsupported codec' });
  let componentStarts = 0;
  const component = {
    descriptor: { ...descriptor, backendId: 'fixture.component', transport: 'native-process-v1', priority: 80 },
    async start() {
      componentStarts += 1;
      return { id: 'component-session', backendId: 'fixture.component', control() {}, setBounds() {}, async capture() { return { success: true }; }, async chooseSubtitle() { return { success: true }; }, async close() {} };
    },
  };
  const session = await startPlaybackSession({ backends: [new ChromiumPlaybackBackend(descriptor), component], context: context(video, [], [], []) });
  assert.equal(session.backendId, 'fixture.component');
  assert.equal(componentStarts, 1, 'a real Chromium metadata/decode failure must switch to the contributed backend exactly once');
  assert.equal(session.attempts.filter(item=>item.backendId==='core.chromium')[0].errorCode,'UNSUPPORTED_CODEC');
  await session.close();
}

console.log('Chromium playback backend event, control, failure, and cleanup tests passed.');
