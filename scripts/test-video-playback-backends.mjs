import assert from 'node:assert/strict';
import { startPlaybackSession } from '../src/platform/video-playback/playback-session.ts';

const settings = { arrowKeyAction: 'seek', subtitlesEnabled: false, subtitlePreferredLanguages: [], subtitleSize: 55, subtitleStyle: 'standard' };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

const makeBackend = (kind, behavior = 'success') => {
  const calls = { starts: 0, closes: 0, runtimeFailure: null };
  return {
    kind,
    calls,
    async start(context) {
      calls.starts += 1;
      calls.runtimeFailure = context.onRuntimeFailure;
      if (behavior === 'fail') throw new Error(`${kind} startup failed`);
      return {
        id: `${kind}-session`, backend: kind,
        control() {}, setBounds() {},
        async capture() { return { success: true }; },
        async chooseSubtitle() { return { success: true }; },
        async close() { calls.closes += 1; },
      };
    },
  };
};

const contextFor = (filePath, states = []) => ({
  filePath, settings, playerId: 'player-test', requestId: `request-${states.length}`,
  video: {}, electronApi: {}, onState: state => states.push(state),
});

{
  const chromium = makeBackend('chromium');
  const component = makeBackend('component', 'fail');
  const session = await startPlaybackSession({ backends: [chromium, component], context: contextFor('C:/project/ordinary.mp4') });
  assert.equal(session.backend, 'chromium');
  assert.deepEqual([chromium.calls.starts, component.calls.starts], [1, 0], 'ordinary MP4 must not depend on the optional component');
  await session.close();
}

{
  const chromium = makeBackend('chromium', 'fail');
  const component = makeBackend('component');
  const session = await startPlaybackSession({ backends: [chromium, component], context: contextFor('C:/project/chromium-fails.mp4') });
  assert.equal(session.backend, 'component');
  assert.deepEqual([chromium.calls.starts, component.calls.starts], [1, 1], 'a Chromium startup failure must try the component once');
  await session.close();
}

{
  const states = [];
  const component = makeBackend('component');
  const chromium = makeBackend('chromium');
  const session = await startPlaybackSession({ backends: [chromium, component], context: contextFor('C:/project/camera.mov', states) });
  assert.equal(session.backend, 'component');
  component.calls.runtimeFailure('component crashed');
  await nextTurn();
  assert.equal(session.backend, 'chromium', 'a component crash must fall back to Chromium when it has not been attempted');
  assert.deepEqual([component.calls.starts, chromium.calls.starts], [1, 1]);
  chromium.calls.runtimeFailure('chromium also failed');
  await nextTurn();
  assert.deepEqual([component.calls.starts, chromium.calls.starts], [1, 1], 'one media generation may attempt each backend at most once');
  assert.equal(states.at(-1)?.type, 'fatal');
  assert.match(states.at(-1)?.error || '', /安装或修复高级解码组件|系统播放器/);
  await session.close();
}

{
  const component = makeBackend('component', 'fail');
  const chromium = makeBackend('chromium');
  const session = await startPlaybackSession({ backends: [chromium, component], context: contextFor('C:/project/component-missing.mov') });
  assert.equal(session.backend, 'chromium', 'a missing or broken component must not disable the built-in player');
  assert.deepEqual([component.calls.starts, chromium.calls.starts], [1, 1]);
  await session.close();
}

{
  const chromium = makeBackend('chromium', 'fail');
  const component = makeBackend('component', 'fail');
  await assert.rejects(
    startPlaybackSession({ backends: [chromium, component], context: contextFor('C:/project/unplayable.mp4') }),
    /startup failed/,
  );
  assert.deepEqual([chromium.calls.starts, component.calls.starts], [1, 1], 'both-backend failure must terminate without a loop');
}

console.log('Video playback backend failover tests passed.');
