const assert = require('node:assert/strict');
const { createRefreshCoordinator } = require('../ui/refresh-coordinator.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  let timeoutId = 0; const timeouts = new Map(); let intervalId = 0; const intervals = new Map(); let calls = 0; let resolves = [];
  const coordinator = createRefreshCoordinator({
    refresh: () => { calls += 1; return new Promise(resolve => resolves.push(resolve)); }, debounceMs: 400, pollMs: 3000,
    setTimeoutFn: fn => { const id = ++timeoutId; timeouts.set(id, fn); return id; }, clearTimeoutFn: id => timeouts.delete(id),
    setIntervalFn: fn => { const id = ++intervalId; intervals.set(id, fn); return id; }, clearIntervalFn: id => intervals.delete(id),
  });
  coordinator.activate(); assert.equal(calls, 1); assert.equal(intervals.size, 1);
  for (let index = 0; index < 100; index += 1) coordinator.event(); assert.equal(timeouts.size, 1, '100 events share one debounce timer');
  [...timeouts.values()][0](); timeouts.clear(); assert.equal(calls, 1, 'event during in-flight refresh does not overlap'); assert.equal(coordinator.inspect().queued, true);
  resolves.shift()(); await flush(); assert.equal(calls, 2, 'in-flight events request exactly one queued refresh');
  for (let index = 0; index < 20; index += 1) coordinator.request({ immediate: true }); assert.equal(calls, 2, 'immediate refreshes do not overlap');
  resolves.shift()(); await flush(); assert.equal(calls, 3, 'many in-flight requests collapse to one follow-up'); resolves.shift()(); await flush();
  coordinator.deactivate(); assert.equal(intervals.size, 0); coordinator.event(); assert.equal(timeouts.size, 0, 'inactive coordinator ignores events'); assert.equal(coordinator.inspect().active, false);
  console.log('video-transcription refresh debounce, single-flight, queued refresh, and deactivate tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
