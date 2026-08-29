const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { finalizeComponentRuntimeInstall, transitionComponentEnabled } = require('../electron/modules/system-ipc.cjs');
const { createConfigMutationService } = require('../electron/services/config-mutation-service.cjs');
const { createComponentDataAdoptionPolicy } = require('../electron/compatibility/component-data-adoption-policy.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-install-adoption-'));
const configPath = path.join(root, 'config.json');
const componentId = 'fixture-adopter'; const legacyKey = 'legacyFixtureSettings';
const adoptionPolicy = createComponentDataAdoptionPolicy({ version: 1, legacyDomainDatabaseOwners: [], legacySettingsAdoptions: [{ componentId, topLevelKey: legacyKey }] });
const legacyConfig = { [legacyKey]: { enabled: false }, componentSettings: {}, componentSettingsRevisions: {} };
fs.writeFileSync(configPath, JSON.stringify(legacyConfig));
const configMutationService = createConfigMutationService({
  fs, crypto,
  getConfigPath: () => configPath,
  readSavedConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
  legacySettingsAdoptionsProvider: () => [{ componentId, legacySettingsAdoptions: [{ topLevelKey: legacyKey }] }],
  adoptionPolicy,
  faultInjector: stage => { if (stage === 'after-backup') throw new Error('injected adoption write failure'); },
});

(async () => {
  const container = path.join(root, componentId);
  const destination = path.join(container, 'runtime');
  const backupPath = path.join(root, '.component-backup');
  fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'runtime.txt'), 'old-runtime');
  fs.renameSync(destination, backupPath);
  fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'runtime.txt'), 'new-runtime');
  const stops = []; let closes = 0; let invalidations = 0;
  const lifecycle = {
    componentViewManager: { closeComponent: () => { closes += 1; } },
    componentServiceManager: { stop: async (_id, reason) => { stops.push(reason); } },
    invalidateComponentStatus: () => { invalidations += 1; },
  };
  await assert.rejects(finalizeComponentRuntimeInstall({ componentId, destination, backupPath, fs, configMutationService, ...lifecycle }), /injected adoption write failure/);
  assert.equal(fs.readFileSync(path.join(destination, 'runtime.txt'), 'utf8'), 'old-runtime', 'an adoption failure restores the prior runtime');
  assert.equal(fs.existsSync(backupPath), false, 'a successfully restored backup no longer remains in the staging location');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), legacyConfig, 'the failed config adoption rolls back atomically');
  assert.deepEqual(stops, ['component-upgrade', 'component-install-rollback']);
  assert.equal(closes, 2); assert.equal(invalidations, 1);

  const firstInstallDestination = path.join(root, 'first-install', 'runtime');
  fs.mkdirSync(firstInstallDestination, { recursive: true }); fs.writeFileSync(path.join(firstInstallDestination, 'runtime.txt'), 'new-runtime');
  await assert.rejects(finalizeComponentRuntimeInstall({ componentId, destination: firstInstallDestination, fs, configMutationService, ...lifecycle }), /injected adoption write failure/);
  assert.equal(fs.existsSync(firstInstallDestination), false, 'a failed first install removes the uncommitted runtime');

  let enabled = true; const transitionCalls = [];
  const pluginService = {
    list: () => [{ id: componentId, installed: true, compatible: true, enabled }],
    setComponentEnabled: (_id, next) => { enabled = next; transitionCalls.push(`state:${next}`); return { componentId, enabled: next }; },
  };
  const barrier = { drain: async () => { transitionCalls.push('drain'); }, release: () => { transitionCalls.push('release'); } };
  const transitionDependencies = {
    componentId, pluginService,
    componentCapabilityBroker: { blockComponent: () => { transitionCalls.push('block'); return barrier; } },
    componentViewManager: { closeComponent: () => { transitionCalls.push('close'); } },
    processSupervisor: { stopWhere: async () => { transitionCalls.push('processes'); } },
    componentServiceManager: { stop: async () => { transitionCalls.push('service'); } },
    abortComponentNetworkRequests: () => { transitionCalls.push('network'); },
  };
  assert.deepEqual(await transitionComponentEnabled({ ...transitionDependencies, enabled: false }), { componentId, enabled: false });
  assert.equal(enabled, false);
  assert.deepEqual(transitionCalls, ['block', 'state:false', 'close', 'processes', 'service', 'network', 'drain', 'release'], 'disable quiesces every component runtime surface');
  assert.deepEqual(await transitionComponentEnabled({ ...transitionDependencies, enabled: true }), { componentId, enabled: true });
  assert.equal(enabled, true, 're-enable restores registry discovery without reinstalling files');
  console.log('Component install legacy-settings adoption rollback tests passed');
})().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
