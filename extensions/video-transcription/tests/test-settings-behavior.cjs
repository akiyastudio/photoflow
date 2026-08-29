const assert = require('node:assert/strict');
const { createDebouncedSerialSaver } = require('../ui/settings-save-model.js');
const timers = new Map(); let timerId = 0;
const setTimer = callback => { const id = ++timerId; timers.set(id, callback); return id; };
const clearTimer = id => timers.delete(id);
const calls = []; const states = []; const deferred = [];
const saver = createDebouncedSerialSaver({
  setTimer, clearTimer,
  save: (value, revision) => { calls.push({ value, revision }); return new Promise((resolve, reject) => deferred.push({ resolve, reject })); },
  onState: (state, revision) => states.push({ state, revision }),
});
(async () => {
  assert.equal(saver.schedule({ language: 'zh', model: 'small' }), 1);
  assert.equal(saver.schedule({ language: 'auto', model: 'large-v3' }), 2);
  saver.flush(); await Promise.resolve(); assert.deepEqual(calls, [{ value: { language: 'auto', model: 'large-v3' }, revision: 2 }], 'debounce keeps the newest complete page value');
  saver.schedule({ language: 'zh', model: 'large-v3' }); saver.flush(); await Promise.resolve(); assert.equal(calls.length, 1, 'saves stay serial while one RPC is active');
  deferred[0].resolve({ settings: calls[0].value }); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 2); assert.deepEqual(calls[1], { value: { language: 'zh', model: 'large-v3' }, revision: 3 });
  deferred[1].resolve({ settings: calls[1].value }); await new Promise(resolve => setImmediate(resolve)); assert(states.some(item => item.state === 'saved' && item.revision === 3));
  console.log('video-transcription model/language settings debounce and serial save tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
