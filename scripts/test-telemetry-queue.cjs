const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTelemetryService } = require('../electron/services/telemetry-service.cjs');

const uuid = () => crypto.randomUUID();
const client = {
  installId: uuid(),
  sessionId: uuid(),
  appVersion: '26.8.31',
  platform: process.platform,
  arch: process.arch,
};

const makeEvent = overrides => ({
  id: uuid(),
  eventName: 'feature_used',
  clientTime: new Date().toISOString(),
  localDate: new Date().toISOString().slice(0, 10),
  timezoneOffsetMin: 0,
  properties: { feature: 'home' },
  ...overrides,
});

const largeProperties = () => ({
  first_launch: '同意状态竞态'.repeat(32).slice(0, 160),
  feature: '功能'.repeat(80),
  planning_folder: '目录'.repeat(80),
  count_bucket: '1-20',
  source: '来源'.repeat(80),
  preserve_original: '保留'.repeat(80),
  media_kind: '媒体'.repeat(80),
  update_available: '更新'.repeat(80),
  reason: '原因'.repeat(80),
  exit_code: '代码'.repeat(80),
});

async function assertSplitUploadCancellation(root, mode) {
  const sandbox = path.join(root, `split-${mode}`);
  fs.mkdirSync(sandbox);
  const queuePath = path.join(sandbox, 'telemetry-queue.json');
  const statePath = path.join(sandbox, 'telemetry-state.json');
  const items = Array.from({ length: 50 }, () => ({
    kind: 'event',
    payload: makeEvent({ properties: largeProperties() }),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify({ ...client, events: items.map(item => item.payload) }), 'utf8') > 80 * 1024);
  fs.writeFileSync(queuePath, JSON.stringify(items));
  let config = { telemetry: { enabled: true, crashReports: false } };
  let releaseFirst;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return new Promise(resolve => { releaseFirst = () => resolve({ ok: true, status: 202 }); });
    }
    return { ok: true, status: 202 };
  };
  const service = createTelemetryService({
    app: { isPackaged: true, getPath: () => sandbox, getVersion: () => client.appVersion },
    fs,
    path,
    crypto,
    getConfig: () => config,
    getLogDir: () => sandbox,
    writeLog: () => undefined,
    apiBaseUrl: 'https://telemetry.invalid',
    ingestKey: 'public-protocol-marker',
  });
  const oldInstallId = JSON.parse(fs.readFileSync(statePath, 'utf8')).installId;
  let replacementEventId = '';
  const flushing = service.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1, `${mode}: only the first split is in flight`);
  assert.ok(requests[0].events.length < items.length, `${mode}: the oversized legal batch was split`);
  assert.ok(Buffer.byteLength(JSON.stringify(requests[0]), 'utf8') <= 80 * 1024, `${mode}: each request stays byte bounded`);
  if (mode === 'revoke') {
    config = { telemetry: { enabled: false, crashReports: false } };
    service.syncConsent(config.telemetry);
  } else {
    service.clearLocalData();
    assert.notEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).installId, oldInstallId);
    assert.equal(service.track('feature_used', { feature: 'settings' }), true);
    replacementEventId = JSON.parse(fs.readFileSync(queuePath, 'utf8'))[0].payload.id;
  }
  releaseFirst();
  await flushing;
  assert.equal(requests.length, 1, `${mode}: a stale epoch cannot send the second split`);
  assert.equal(requests[0].installId, oldInstallId);
  const remaining = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  if (mode === 'revoke') assert.deepStrictEqual(remaining, [], 'revoke: queue stays cleared');
  else assert.deepStrictEqual(remaining.map(item => item.payload.id), [replacementEventId], 'clear: the new-identity event remains queued');
}

async function assertClearResetsBackoff(root) {
  const sandbox = path.join(root, 'clear-backoff');
  fs.mkdirSync(sandbox);
  const queuePath = path.join(sandbox, 'telemetry-queue.json');
  let config = { telemetry: { enabled: true, crashReports: false } };
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: false, status: 429, headers: { get: () => '900' } };
  };
  const service = createTelemetryService({
    app: { isPackaged: true, getPath: () => sandbox, getVersion: () => client.appVersion },
    fs,
    path,
    crypto,
    getConfig: () => config,
    getLogDir: () => sandbox,
    writeLog: () => undefined,
    apiBaseUrl: 'https://telemetry.invalid',
    ingestKey: 'public-protocol-marker',
  });
  service.track('feature_used', { feature: 'home' });
  assert.equal(await service.flush(), false);
  assert.equal(fetchCalls, 1);
  service.clearLocalData();
  service.track('feature_used', { feature: 'settings' });
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 202 };
  };
  assert.equal(await service.flush(), true, 'a new identity is not delayed by the old Retry-After');
  assert.equal(fetchCalls, 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')), []);
}

async function assertFeedbackDoesNotResetEventBackoff(root) {
  const sandbox = path.join(root, 'feedback-backoff');
  fs.mkdirSync(sandbox);
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  let eventCalls = 0;
  let feedbackCalls = 0;
  const config = { telemetry: { enabled: true, crashReports: false } };
  global.fetch = async url => {
    if (url.endsWith('/v1/events')) {
      eventCalls += 1;
      return { ok: false, status: 429, headers: { get: () => '900' } };
    }
    feedbackCalls += 1;
    return { ok: true, status: 202 };
  };
  try {
    const service = createTelemetryService({
      app: { isPackaged: true, getPath: () => sandbox, getVersion: () => client.appVersion },
      fs,
      path,
      crypto,
      getConfig: () => config,
      getLogDir: () => sandbox,
      writeLog: () => undefined,
      apiBaseUrl: 'https://telemetry.invalid',
      ingestKey: 'public-protocol-marker',
    });
    service.track('feature_used', { feature: 'home' });
    assert.equal(await service.flush(), false);
    assert.deepStrictEqual(await service.submitFeedback('feedback succeeds independently'), { success: true });
    assert.equal(await service.flush(), false);
    assert.deepStrictEqual({ eventCalls, feedbackCalls }, { eventCalls: 1, feedbackCalls: 1 }, 'feedback success cannot clear event Retry-After');
  } finally {
    Date.now = realNow;
  }
}

async function assertEventAndCrashBackoffsAreIndependent(root) {
  const sandbox = path.join(root, 'kind-backoffs');
  fs.mkdirSync(sandbox);
  const queuePath = path.join(sandbox, 'telemetry-queue.json');
  fs.writeFileSync(queuePath, JSON.stringify([
    { kind: 'event', payload: makeEvent() },
    { kind: 'crash', payload: { id: uuid(), clientTime: new Date().toISOString() } },
  ]));
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  let eventCalls = 0;
  let crashCalls = 0;
  let eventSucceeds = false;
  let crashSucceeds = false;
  const config = { telemetry: { enabled: true, crashReports: true } };
  global.fetch = async url => {
    if (url.endsWith('/v1/events')) {
      eventCalls += 1;
      return eventSucceeds ? { ok: true, status: 202 } : { ok: false, status: 429, headers: { get: () => '120' } };
    }
    crashCalls += 1;
    return crashSucceeds ? { ok: true, status: 202 } : { ok: false, status: 429, headers: { get: () => '300' } };
  };
  try {
    const service = createTelemetryService({
      app: { isPackaged: true, getPath: () => sandbox, getVersion: () => client.appVersion },
      fs,
      path,
      crypto,
      getConfig: () => config,
      getLogDir: () => sandbox,
      writeLog: () => undefined,
      apiBaseUrl: 'https://telemetry.invalid',
      ingestKey: 'public-protocol-marker',
    });
    assert.equal(await service.flush(), false);
    assert.deepStrictEqual({ eventCalls, crashCalls }, { eventCalls: 1, crashCalls: 1 });
    assert.equal(await service.flush(), false);
    assert.deepStrictEqual({ eventCalls, crashCalls }, { eventCalls: 1, crashCalls: 1 });
    fakeNow += 120_001;
    eventSucceeds = true;
    assert.equal(await service.flush(), false);
    assert.deepStrictEqual({ eventCalls, crashCalls }, { eventCalls: 2, crashCalls: 1 }, 'event expiry does not clear crash backoff');
    fakeNow += 180_000;
    crashSucceeds = true;
    assert.equal(await service.flush(), true);
    assert.deepStrictEqual({ eventCalls, crashCalls }, { eventCalls: 2, crashCalls: 2 });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')), []);
  } finally {
    Date.now = realNow;
  }
}

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-telemetry-queue-'));
  const queuePath = path.join(sandbox, 'telemetry-queue.json');
  let config = { telemetry: { enabled: true, crashReports: true } };
  const originalFetch = global.fetch;
  const originalDateNow = Date.now;
  try {
    const valid = makeEvent();
    const rejected = makeEvent({ clientTime: 'invalid' });
    const removedLegacy = makeEvent({ eventName: 'legacy_poison' });
    const crash = { id: uuid(), clientTime: new Date().toISOString() };
    fs.writeFileSync(queuePath, JSON.stringify([
      { kind: 'event', payload: rejected },
      { kind: 'event', payload: valid },
      { kind: 'event', payload: removedLegacy },
      { kind: 'crash', payload: crash },
    ]));

    const eventBatchSizes = [];
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/v1/events')) {
        eventBatchSizes.push(body.events.length);
        return { ok: body.events.every(event => event.clientTime !== 'invalid'), status: 400 };
      }
      return { ok: false, status: 422 };
    };
    const service = createTelemetryService({
      app: { isPackaged: true, getPath: () => sandbox, getVersion: () => client.appVersion },
      fs,
      path,
      crypto,
      getConfig: () => config,
      getLogDir: () => sandbox,
      writeLog: () => undefined,
      apiBaseUrl: 'https://telemetry.invalid',
      ingestKey: 'public-protocol-marker',
    });

    await service.flush();
    assert.deepStrictEqual(eventBatchSizes, [2, 1, 1], 'a deterministic batch rejection is bisected');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')), [], 'poison events and rejected crashes are discarded without blocking valid records');

    service.track('feature_used', { feature: 'project' });
    let fakeNow = originalDateNow();
    Date.now = () => fakeNow;
    global.fetch = async () => ({ ok: false, status: 503 });
    assert.strictEqual(await service.flush(), false);
    assert.equal(JSON.parse(fs.readFileSync(queuePath, 'utf8')).length, 1, '5xx failures retain records for retry');
    fakeNow += 5_001;
    global.fetch = async () => ({ ok: true, status: 202 });
    assert.strictEqual(await service.flush(), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')), []);

    service.track('feature_used', { feature: 'home' });
    let rateLimitedFetches = 0;
    Date.now = () => fakeNow;
    global.fetch = async () => {
      rateLimitedFetches += 1;
      return { ok: false, status: 429, headers: { get: name => name === 'retry-after' ? '120' : null } };
    };
    assert.strictEqual(await service.flush(), false);
    assert.equal(JSON.parse(fs.readFileSync(queuePath, 'utf8')).length, 1, '429 retains queued telemetry');
    assert.strictEqual(await service.flush(), false);
    assert.equal(rateLimitedFetches, 1, 'Retry-After prevents an early retry');
    fakeNow += 120_001;
    global.fetch = async () => ({ ok: true, status: 202 });
    assert.strictEqual(await service.flush(), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')), [], 'queue uploads after Retry-After expires');
    Date.now = originalDateNow;

    await assertSplitUploadCancellation(sandbox, 'revoke');
    await assertSplitUploadCancellation(sandbox, 'clear');
    await assertClearResetsBackoff(sandbox);
    await assertFeedbackDoesNotResetEventBackoff(sandbox);
    await assertEventAndCrashBackoffsAreIndependent(sandbox);

    service.track('feature_used', { feature: 'settings' });
    let rejectUpload;
    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      rejectUpload = reject;
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const firstFlush = service.flush();
    const concurrentFlush = service.flush();
    assert.strictEqual(firstFlush, concurrentFlush, 'concurrent flushes share one upload');
    await new Promise(resolve => setImmediate(resolve));
    config = { telemetry: { enabled: false, crashReports: false } };
    service.syncConsent(config.telemetry);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')), [], 'consent revocation clears unsent data immediately');
    rejectUpload?.(new Error('cancelled'));
    await firstFlush;

    assert.strictEqual(service.start(), true);
    assert.strictEqual(service.start(), false, 'start is idempotent');
    await service.stop();
  } finally {
    global.fetch = originalFetch;
    Date.now = originalDateNow;
    const relative = path.relative(os.tmpdir(), sandbox);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().then(() => console.log('Telemetry queue tests passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
