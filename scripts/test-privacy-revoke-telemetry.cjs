const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePrivacyConsentWithConfig } = require('../electron/modules/system-ipc.cjs');
const { createConfigMutationService } = require('../electron/services/config-mutation-service.cjs');
const { createTelemetryService } = require('../electron/services/telemetry-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-privacy-revoke-'));
const configPath = path.join(root, 'config.json');
const queuePath = path.join(root, 'telemetry-queue.json');
const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
const readQueue = () => JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const systemIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
assert(mainSource.includes('telemetry: hasCoreConsent'), 'production config reads project core privacy consent onto telemetry');
assert(mainSource.includes(': { enabled: false, crashReports: false }'), 'revoked core consent projects both telemetry switches off');
assert.equal(systemIpcSource.includes('CORE_CONSENT_GUARD'), false, 'system IPC must not monkey-patch the shared telemetry service');
assert.equal(systemIpcSource.includes('guardTelemetryWithCoreConsent'), false);

(async () => {
  fs.writeFileSync(configPath, JSON.stringify({ theme: 'light', telemetry: { enabled: true, crashReports: true }, concurrentValue: 0 }));
  const configMutationService = createConfigMutationService({ fs, crypto, getConfigPath: () => configPath, readSavedConfig: readConfig });
  await configMutationService.ready;
  let hasCoreConsent = true;
  let finishPrivacySave;
  const privacySaveGate = new Promise(resolve => { finishPrivacySave = resolve; });
  const privacyService = {
    hasCoreConsent: () => hasCoreConsent,
    saveConsent: async request => {
      await privacySaveGate;
      if (request.revokeCore) hasCoreConsent = false;
      return { coreConsentGranted: hasCoreConsent, experienceProgramGranted: true };
    },
  };
  const getProjectedConfig = () => {
    const config = readConfig();
    return { ...config, telemetry: hasCoreConsent ? config.telemetry : { enabled: false, crashReports: false } };
  };
  const telemetryService = createTelemetryService({
    app: { isPackaged: true, getPath: () => root, getVersion: () => '26.8.31' },
    fs, path, crypto, getConfig: readConfig, getLogDir: () => root, writeLog: () => undefined, apiBaseUrl: '', ingestKey: 'test',
  });
  telemetryService.start();
  assert.equal(telemetryService.track('feature_opened', { feature: 'settings' }), true);
  assert.equal(telemetryService.reportCrash('main', new Error('before revoke')), true);
  assert(readQueue().length >= 2, 'enabled telemetry has queued data before withdrawal');

  const revoke = savePrivacyConsentWithConfig({ request: { revokeCore: true }, privacyService, configMutationService, telemetryService });
  const concurrentSave = configMutationService.mutate(current => ({ ...current, theme: 'dark', concurrentValue: current.concurrentValue + 1 }));
  finishPrivacySave();
  const [result] = await Promise.all([revoke, concurrentSave]);
  assert.equal(result.success, true);
  assert.deepEqual(readConfig().telemetry, { enabled: false, crashReports: false }, 'withdrawal atomically persists both telemetry switches as disabled');
  assert.equal(readConfig().theme, 'dark', 'a concurrent ordinary config save is preserved');
  assert.equal(readConfig().concurrentValue, 1, 'serialized withdrawal does not lose concurrent fields');
  assert.deepEqual(readQueue(), [], 'withdrawal clears analytics and crash queues');
  assert.equal(telemetryService.track('feature_opened', { feature: 'home' }), false, 'tracking cannot enqueue after withdrawal without another settings save');
  assert.equal(telemetryService.reportCrash('main', new Error('after revoke')), false, 'crash reporting cannot enqueue after withdrawal');
  assert.deepEqual(readQueue(), []);

  const restartedTelemetry = createTelemetryService({
    app: { isPackaged: true, getPath: () => root, getVersion: () => '26.8.31' },
    fs, path, crypto, getConfig: readConfig, getLogDir: () => root, writeLog: () => undefined, apiBaseUrl: '', ingestKey: 'test',
  });
  restartedTelemetry.start();
  assert.equal(restartedTelemetry.track('feature_opened', { feature: 'home' }), false, 'restart reads the persisted opt-out');
  assert.equal(restartedTelemetry.reportCrash('main', new Error('restart crash')), false);
  assert.deepEqual(readQueue(), []);

  fs.writeFileSync(configPath, JSON.stringify({ ...readConfig(), telemetry: { enabled: true, crashReports: true } }));
  const staleConfigTelemetry = createTelemetryService({
    app: { isPackaged: true, getPath: () => root, getVersion: () => '26.8.31' },
    fs, path, crypto, getConfig: getProjectedConfig, getLogDir: () => root, writeLog: () => undefined, apiBaseUrl: '', ingestKey: 'test',
  });
  staleConfigTelemetry.start();
  assert.equal(staleConfigTelemetry.track('feature_opened', { feature: 'home' }), false, 'main-style privacy projection disables stale telemetry=true after core withdrawal');
  assert.equal(staleConfigTelemetry.reportCrash('main', new Error('stale restart crash')), false);
  assert.deepEqual(readQueue(), []);

  hasCoreConsent = true;
  let mutationStartedResolve; let releaseRevokeMutation;
  const mutationStarted = new Promise(resolve => { mutationStartedResolve = resolve; });
  const revokeMutationGate = new Promise(resolve => { releaseRevokeMutation = resolve; });
  const gatedConfigMutationService = {
    mutate: mutator => configMutationService.mutate(async current => {
      mutationStartedResolve();
      await revokeMutationGate;
      return mutator(current);
    }),
  };
  const revokeBeforeSave = savePrivacyConsentWithConfig({ request: { revokeCore: true }, privacyService, configMutationService: gatedConfigMutationService, telemetryService });
  await mutationStarted;
  const saveAfterRevoke = configMutationService.mutate(current => ({ ...current, theme: 'system', concurrentValue: current.concurrentValue + 1 }));
  releaseRevokeMutation();
  await Promise.all([revokeBeforeSave, saveAfterRevoke]);
  assert.deepEqual(readConfig().telemetry, { enabled: false, crashReports: false }, 'an ordinary save queued after withdrawal preserves the persisted opt-out');
  assert.equal(readConfig().theme, 'system');
  assert.equal(readConfig().concurrentValue, 2, 'updates queued on either side of withdrawal are retained');

  let acceptedMutationCalls = 0;
  const accepted = await savePrivacyConsentWithConfig({
    request: { acceptCore: true },
    privacyService: { saveConsent: async () => ({ coreConsentGranted: true }) },
    configMutationService: { mutate: async () => { acceptedMutationCalls += 1; } },
    telemetryService,
  });
  assert.equal(accepted.success, true);
  assert.equal(acceptedMutationCalls, 0, 'accepting core terms never re-enables telemetry the user disabled');

  for (const invalidRequest of [null, [], { acceptCore: 'yes' }, { revokeCore: 1 }, { acceptCore: true, revokeCore: true }]) {
    let privacyCalls = 0; let mutationCalls = 0; let disableCalls = 0;
    const invalid = await savePrivacyConsentWithConfig({
      request: invalidRequest,
      privacyService: { saveConsent: async () => { privacyCalls += 1; return {}; } },
      configMutationService: { mutate: async () => { mutationCalls += 1; return {}; } },
      telemetryService: { disableAndPurge: () => { disableCalls += 1; }, syncConsent: () => undefined },
    });
    assert.equal(invalid.success, false);
    assert.equal(privacyCalls, 0, 'invalid or contradictory requests are rejected before privacy state changes');
    assert.equal(mutationCalls, 0);
    assert.equal(disableCalls, 0);
  }
  const conflict = await savePrivacyConsentWithConfig({
    request: { acceptCore: true, revokeCore: true },
    privacyService: { saveConsent: async () => { throw new Error('must not run'); } },
    configMutationService: { mutate: async () => { throw new Error('must not run'); } },
    telemetryService: { disableAndPurge: () => { throw new Error('must not run'); }, syncConsent: () => { throw new Error('must not run'); } },
  });
  assert.deepEqual(conflict, { success: false, error: '不能同时接受和撤回核心同意' }, 'conflicting core request has a stable failure result');

  const partialFailure = await savePrivacyConsentWithConfig({
    request: { revokeCore: true },
    privacyService: { saveConsent: async () => ({ coreConsentGranted: false }) },
    configMutationService: { mutate: async () => { throw new Error('disk denied'); } },
    telemetryService: { disableAndPurge: () => true, syncConsent: () => undefined },
  });
  assert.equal(partialFailure.success, false, 'a persisted-config failure cannot be reported as complete withdrawal success');
  assert.equal(partialFailure.consentRevoked, true);
  assert.equal(partialFailure.telemetryDisabled, true);
  assert.equal(partialFailure.configPersisted, false);

  await telemetryService.stop();
  await restartedTelemetry.stop();
  await staleConfigTelemetry.stop();
  console.log('Privacy withdrawal telemetry/config transaction tests passed');
})().finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });
