const assert = require('node:assert/strict');
const { createDebouncedSerialSaver } = require('../ui/settings-save-model.js');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const clock = (() => {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    setTimer(callback, wait) { id += 1; timers.set(id, { callback, due: now + wait }); return id; },
    clearTimer(timerId) { timers.delete(timerId); },
    advance(wait) {
      now += wait;
      for (const [timerId, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (timer.due <= now && timers.delete(timerId)) timer.callback();
      }
    },
  };
})();

(async () => {
  const calls = [];
  const states = [];
  const first = deferred();
  const saver = createDebouncedSerialSaver({
    delay: 350,
    maxWait: 1200,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    save(value, revision) { calls.push({ value, revision }); return calls.length === 1 ? first.promise : Promise.resolve({ settings: value }); },
    onState(state, revision) { states.push({ state, revision }); },
  });

  assert.equal(saver.schedule({ model: 'small' }), 1);
  assert.equal(saver.schedule({ model: 'large-v3' }), 2);
  clock.advance(349);
  assert.equal(calls.length, 0, 'changes inside the debounce window are merged');
  clock.advance(1);
  assert.deepEqual(calls, [{ value: { model: 'large-v3' }, revision: 2 }]);

  saver.schedule({ model: 'medium' });
  saver.schedule({ model: 'large-v2' });
  clock.advance(350);
  assert.equal(calls.length, 1, 'a second save never overlaps the active RPC');
  first.resolve({ settings: { model: 'large-v3' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[1], { value: { model: 'large-v2' }, revision: 4 }, 'only the newest queued revision is serialized after the active save');

  saver.schedule({ beamSize: 4 });
  saver.schedule({ beamSize: 5 });
  saver.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), { value: { beamSize: 5 }, revision: 6 }, 'pagehide flushes the newest pending revision');
  assert(states.some(item => item.state === 'saving') && states.some(item => item.state === 'saved'));
  console.log('video-transcription bounded debounce and serial settings save tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
