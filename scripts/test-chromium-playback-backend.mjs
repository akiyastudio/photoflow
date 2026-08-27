import assert from 'node:assert/strict';
import { ChromiumPlaybackBackend, chromiumContainerProbe } from '../src/platform/video-playback/playback-session.ts';

globalThis.HTMLMediaElement = { HAVE_FUTURE_DATA: 3 };

class FakeVideo extends EventTarget {
  constructor({ failLoad = false } = {}) {
    super();
    this.failLoad = failLoad;
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
    this.error = null;
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
        this.error = { message: 'decode failed' };
        this.dispatchEvent(new Event('error'));
      } else this.dispatchEvent(new Event('loadedmetadata'));
    });
  }
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
  }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

const descriptor = { backendId: 'core.chromium', protocolVersion: 1, transport: 'chromium', displayName: 'Chromium', priority: 100, probe: { support: 'probably', basis: 'test' } };
const settings = { arrowKeyAction: 'seek', subtitlesEnabled: false, subtitlePreferredLanguages: [], subtitleSize: 55, subtitleStyle: 'standard' };
const context = (video, states, failures, published) => ({
  filePath: 'C:/project/clip.mp4', settings, playerId: 'player-real', requestId: 'request-real', video,
  electronApi: {
    async getVideoPlaybackSource() { return { success: true, mediaUrl: 'photoflow-media://file/token' }; },
    async publishVideoPlayerFrame(filePath, bytes) { published.push({ filePath, bytes }); return { success: true, path: 'C:/project/frame.png' }; },
  },
  onState: state => states.push(state), onRuntimeFailure: error => failures.push(error),
});

{
  const video = new FakeVideo();
  const states = []; const failures = []; const published = [];
  assert.equal(chromiumContainerProbe(video, 'C:/project/clip.mp4'), 'probably');
  assert.equal(chromiumContainerProbe(video, 'C:/project/clip.mov'), 'unknown', 'extension hints must not claim unsupported codec capability');
  const session = await new ChromiumPlaybackBackend(descriptor).start(context(video, states, failures, published));
  assert.equal(video.src, 'photoflow-media://file/token');
  assert(states.some(state => state.type === 'file-loaded'));
  assert(states.some(state => state.type === 'state' && state.paused === false));
  session.control({ action: 'pause' });
  session.control({ action: 'seek', value: 33 });
  session.control({ action: 'volume', value: 40 });
  session.control({ action: 'mute', value: true });
  session.control({ action: 'speed', value: 1.5 });
  assert.deepEqual({ paused: video.paused, time: video.currentTime, volume: video.volume, muted: video.muted, speed: video.playbackRate }, { paused: true, time: 33, volume: 0.4, muted: true, speed: 1.5 });
  video.error = { message: 'runtime decode failure' };
  video.dispatchEvent(new Event('error'));
  assert.deepEqual(failures, ['runtime decode failure']);
  await session.close();
  assert.equal(video.src, '');
  assert.equal(video.paused, true);
  assert.equal(video.listenerBalance, 0, 'close must remove every Chromium media listener');
}

{
  const video = new FakeVideo({ failLoad: true });
  await assert.rejects(new ChromiumPlaybackBackend(descriptor).start(context(video, [], [], [])), /decode failed/);
  assert.equal(video.src, '');
  assert.equal(video.listenerBalance, 0, 'startup failure must clean listeners and the media source');
}

console.log('Chromium playback backend event, control, failure, and cleanup tests passed.');
