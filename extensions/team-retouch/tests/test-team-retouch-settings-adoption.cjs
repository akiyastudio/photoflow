const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfigMutationService } = require('../../../electron/services/config-mutation-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-settings-adoption-'));
const configPath = path.join(root, 'config.json');
const legacy = { personDetection: { useGpu: false, oversizeCropMode: 'expand' }, componentSettings: {}, componentSettingsRevisions: {} };
fs.writeFileSync(configPath, JSON.stringify(legacy));
const service = createConfigMutationService({
  fs,
  crypto,
  getConfigPath: () => configPath,
  readSavedConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
  legacySettingsAdoptionsProvider: () => [{ componentId: 'team-retouch', legacySettingsAdoptions: [{ topLevelKey: 'personDetection' }] }],
});

(async () => {
  await service.adoptLegacySettings();
  const adopted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(adopted.componentSettings['team-retouch'], legacy.personDetection);
  assert.equal(adopted.componentSettingsRevisions['team-retouch'], 1);
  assert.deepEqual(adopted.personDetection, legacy.personDetection, 'the historical source remains available');
  await service.adoptLegacySettings();
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), adopted, 'the real policy adoption is idempotent');
  console.log('Team-retouch host-authorized legacy settings adoption passed');
})().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
