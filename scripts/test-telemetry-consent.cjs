const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTelemetryService } = require('../electron/services/telemetry-service.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-telemetry-consent-'));
let config = { telemetry: { enabled: false, crashReports: false } };
const queuePath = path.join(sandbox, 'telemetry-queue.json');
const statePath = path.join(sandbox, 'telemetry-state.json');
const readQueue = () => JSON.parse(fs.readFileSync(queuePath, 'utf8'));

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const systemIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
assert(mainSource.includes("typeof configuredTelemetry.enabled === 'boolean' ? configuredTelemetry.enabled : initialExperienceConsent"));
assert(systemIpcSource.includes("config?.telemetry?.enabled === true"));
assert(systemIpcSource.includes("config?.telemetry?.crashReports === true"));

try {
  fs.writeFileSync(statePath, JSON.stringify({ installId: 'corrupt-install-id', createdAt: 'not-a-date' }));
  const service = createTelemetryService({
    app: { isPackaged: true, getPath: key => key === 'userData' ? sandbox : sandbox, getVersion: () => '26.8.30' },
    fs,
    path,
    crypto,
    getConfig: () => config,
    getLogDir: () => sandbox,
    writeLog: () => undefined,
    apiBaseUrl: '',
    ingestKey: 'test',
  });

  const repairedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.match(repairedState.installId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(new Date(repairedState.createdAt).toISOString(), repairedState.createdAt);
  assert.notEqual(repairedState.installId, 'corrupt-install-id', 'corrupt identity is replaced before any upload');

  service.start();
  assert.strictEqual(service.track('feature_opened', { feature: 'home' }), false, 'opted-out analytics must not enqueue events');
  assert.strictEqual(service.reportCrash('main', new Error('test crash')), false, 'opted-out crash reporting must not enqueue crashes');
  assert.deepStrictEqual(readQueue(), []);

  config = { telemetry: { enabled: true, crashReports: false } };
  service.syncConsent(config.telemetry);
  assert.deepStrictEqual(readQueue().map(item => item.kind), ['event'], 'enabling analytics starts a consented session');

  config = { telemetry: { enabled: false, crashReports: true } };
  service.syncConsent(config.telemetry);
  assert.deepStrictEqual(readQueue(), [], 'disabling analytics deletes unsent analytics events');
  assert.strictEqual(service.reportCrash('main', new Error('consented crash')), true);
  assert.deepStrictEqual(readQueue().map(item => item.kind), ['crash']);

  config = { telemetry: { enabled: false, crashReports: false } };
  service.syncConsent(config.telemetry);
  assert.deepStrictEqual(readQueue(), [], 'disabling crash reports deletes unsent crash reports');

  const previousInstallId = JSON.parse(fs.readFileSync(statePath, 'utf8')).installId;
  service.clearLocalData();
  assert.notStrictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).installId, previousInstallId);
  service.stop();
  console.log('Telemetry consent tests passed');
} finally {
  const resolved = path.resolve(sandbox);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(resolved, { recursive: true, force: true });
}
