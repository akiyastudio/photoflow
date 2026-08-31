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

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-telemetry-queue-'));
  const queuePath = path.join(sandbox, 'telemetry-queue.json');
  let config = { telemetry: { enabled: true, crashReports: true } };
  const originalFetch = global.fetch;
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
    global.fetch = async () => ({ ok: false, status: 503 });
    assert.strictEqual(await service.flush(), false);
    assert.equal(JSON.parse(fs.readFileSync(queuePath, 'utf8')).length, 1, '5xx failures retain records for retry');
    global.fetch = async () => ({ ok: true, status: 202 });
    assert.strictEqual(await service.flush(), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')), []);

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
    const relative = path.relative(os.tmpdir(), sandbox);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().then(() => console.log('Telemetry queue tests passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
