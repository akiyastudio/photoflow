const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createThumbnailService } = require('../electron/services/thumbnail-service.cjs');

const fixture = () => {
  let resolve; let ready = false; const requests = [];
  const completion = new Promise(accept => { resolve = accept; });
  const finish = outcome => { ready = outcome.state === 'READY'; resolve(outcome); };
  const pipeline = {
    cacheDirectory: () => 'C:/PhotoFlow/TestCache',
    request: async request => {
      requests.push(request);
      return ready ? { success: true, state: 'READY', previewUrl: 'photoflow-media://derived/preview.jpg' }
        : { success: true, state: 'QUEUED', completion };
    },
    stop: () => finish({ state: 'CANCELLED' }),
  };
  const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
  return { service: createThumbnailService({ pipeline, backgroundTasks }), finish, requests, backgroundTasks };
};
const request = { filePath: 'C:/Photos/current-working.png', kind: 'image', requestedSize: 1600 };

(async () => {
  const success = fixture();
  try {
    const viewport = await success.service.request(request);
    assert.equal(viewport.state, 'QUEUED', 'viewport requests remain nonblocking');
    let settled = false;
    const variant = success.service.request({ ...request, awaitReady: true }).then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'a cold capability request waits instead of reporting a missing image');
    success.finish({ state: 'READY' });
    const result = await variant;
    assert.equal(result.state, 'READY');
    assert.equal(result.previewUrl, 'photoflow-media://derived/preview.jpg');
    assert(success.requests.every(item => !Object.hasOwn(item, 'awaitReady')), 'the wait preference is not persisted into pipeline requests');
    assert.equal(success.requests.length, 3, 'the derivative URL is read once after generation');
  } finally { await success.service.stop(); }

  const failure = fixture();
  try {
    const variant = failure.service.request({ ...request, awaitReady: true });
    failure.finish({ state: 'FAILED', error: 'decode failed' });
    const result = await variant;
    assert.equal(result.success, false);
    assert.equal(result.error, 'decode failed');
    assert.equal(failure.requests.length, 1, 'decoder failure does not start an unbounded retry loop');
  } finally { await failure.service.stop(); }

  const stopping = fixture();
  const waiting = stopping.service.request({ ...request, awaitReady: true });
  await new Promise(resolve => setImmediate(resolve));
  await stopping.service.stop();
  assert.equal((await waiting).state, 'NOT_READY', 'shutdown releases waiting preview capabilities');
  console.log('Thumbnail capability readiness, failure, and shutdown tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
