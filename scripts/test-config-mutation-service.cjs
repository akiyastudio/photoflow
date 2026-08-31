const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createConfigMutationService, adoptLegacyComponentSettings: adoptLegacyComponentSettingsWithPolicy, nextComponentRevision, normalizeComponentRevision, readConfigFileWithRecovery, configSnapshotExists, registerConfigDrainBeforeQuit } = require('../electron/services/config-mutation-service.cjs');
const { createComponentDataAdoptionPolicy } = require('../electron/compatibility/component-data-adoption-policy.cjs');

const adoptionPolicy = createComponentDataAdoptionPolicy({ version: 1, legacyDomainDatabaseOwners: [], legacySettingsAdoptions: [{ componentId: 'fixture-adopter', topLevelKey: 'legacyFixture' }] });
const adoptLegacyComponentSettings = (config, descriptors) => adoptLegacyComponentSettingsWithPolicy(config, descriptors, adoptionPolicy);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-config-mutation-'));
const configPath = path.join(root, 'config.json');
const readSavedConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
fs.writeFileSync(configPath, JSON.stringify({ theme: 'light', componentSettings: { fixture: { quality: 80 } }, componentSettingsRevisions: { fixture: 1 } }));
const service = createConfigMutationService({ fs, crypto, getConfigPath: () => configPath, readSavedConfig });

(async () => {
  const staleRendererDraft = { theme: 'dark', componentSettings: { fixture: { quality: 80 } }, componentSettingsRevisions: { fixture: 1 } };
  await Promise.all([
    service.mutate(current => ({ ...current, componentSettings: { ...current.componentSettings, fixture: { quality: 95 } }, componentSettingsRevisions: { ...current.componentSettingsRevisions, fixture: 2 } })),
    service.mutate(current => service.mergeRendererConfig(staleRendererDraft, current)),
  ]);
  assert.deepEqual(readSavedConfig(), { theme: 'dark', componentSettings: { fixture: { quality: 95 } }, componentSettingsRevisions: { fixture: 2 } }, 'ordinary config saves must preserve the latest opaque component settings and revision');

  await service.mutate(current => service.mergeRendererConfig({ ...current, theme: 'system', componentSettings: { fixture: { quality: 70 } }, componentSettingsRevisions: { fixture: 2 } }, current));
  assert.deepEqual(readSavedConfig(), { theme: 'system', componentSettings: { fixture: { quality: 70 } }, componentSettingsRevisions: { fixture: 2 } }, 'a renderer draft with the current revision may retain intentional same-revision maintenance changes');

  const revisions = await Promise.all([1, 2, 3].map(quality => service.mutate(current => {
    const revision = Number(current.componentSettingsRevisions.fixture) + 1;
    return { ...current, componentSettings: { ...current.componentSettings, fixture: { quality } }, componentSettingsRevisions: { ...current.componentSettingsRevisions, fixture: revision } };
  }).then(config => config.componentSettingsRevisions.fixture)));
  assert.deepEqual(revisions, [3, 4, 5], 'serialized config mutations observe monotonic component revisions');
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '4', null]) assert.equal(normalizeComponentRevision(invalid), 0, 'invalid component revisions normalize to zero');
  assert.equal(nextComponentRevision(5), 6); assert.throws(() => nextComponentRevision(Number.MAX_SAFE_INTEGER), /exhausted/);
  const adoption = [{ componentId: 'fixture-adopter', legacySettingsAdoptions: [{ topLevelKey: 'legacyFixture' }] }];
  for (const topLevelKey of ['componentSettings', 'componentSettingsRevisions', 'workspacePath', 'backup', 'unrelatedGlobal']) {
    assert.throws(() => adoptLegacyComponentSettings({ [topLevelKey]: { secret: true } }, [{ componentId: 'malicious-component', legacySettingsAdoptions: [{ topLevelKey }] }]), /Unauthorized legacy settings adoption/, `a component cannot adopt ${topLevelKey}`);
  }
  assert.throws(() => adoptLegacyComponentSettings({}, [adoption[0], structuredClone(adoption[0])]), /more than one|claimed more than once/, 'a legacy key has exactly one global claimant');
  assert.throws(() => adoptLegacyComponentSettings({}, [adoption[0], { componentId: 'malicious-component', legacySettingsAdoptions: [{ topLevelKey: 'legacyFixture' }] }]), /claimed more than once|Unauthorized/, 'another component cannot claim an authorized component legacy key');
  const legacyOnly = { legacyFixture: { useGpu: false, oversizeCropMode: 'expand' }, componentSettings: {}, componentSettingsRevisions: {} };
  const adopted = adoptLegacyComponentSettings(legacyOnly, adoption);
  assert.deepEqual(adopted.componentSettings['fixture-adopter'], legacyOnly.legacyFixture, 'a declared legacy top-level value is adopted into the component namespace');
  assert.equal(adopted.componentSettingsRevisions['fixture-adopter'], 1); assert.deepEqual(adopted.legacyFixture, legacyOnly.legacyFixture, 'adoption preserves the legacy source');
  assert.notStrictEqual(adopted.componentSettings['fixture-adopter'], legacyOnly.legacyFixture, 'adoption clones legacy settings instead of sharing mutable references');
  legacyOnly.legacyFixture.useGpu = true; assert.equal(adopted.componentSettings['fixture-adopter'].useGpu, false, 'later legacy source mutation cannot alter the adopted namespace'); legacyOnly.legacyFixture.useGpu = false;
  for (const invalidLegacyValue of [null, [], 'settings', 7, false]) {
    const invalidLegacy = { legacyFixture: invalidLegacyValue, componentSettings: {}, componentSettingsRevisions: {} };
    const skipped = adoptLegacyComponentSettings(invalidLegacy, adoption);
    assert.strictEqual(skipped, invalidLegacy); assert.deepEqual(skipped.componentSettingsRevisions, {}, 'invalid legacy values remain retryable and do not create a tombstone/revision');
  }
  assert.strictEqual(adoptLegacyComponentSettings(adopted, adoption), adopted, 'repeated adoption is idempotent');
  const newWins = adoptLegacyComponentSettings({ ...legacyOnly, componentSettings: { 'fixture-adopter': { useGpu: true } }, componentSettingsRevisions: { 'fixture-adopter': 7 } }, adoption);
  assert.deepEqual(newWins.componentSettings['fixture-adopter'], { useGpu: true }); assert.equal(newWins.componentSettingsRevisions['fixture-adopter'], 7, 'an existing namespace and revision win over legacy settings');
  const tombstoneWins = adoptLegacyComponentSettings({ ...legacyOnly, componentSettingsRevisions: { 'fixture-adopter': 9 } }, adoption);
  assert.equal(Object.hasOwn(tombstoneWins.componentSettings, 'fixture-adopter'), false); assert.equal(tombstoneWins.componentSettingsRevisions['fixture-adopter'], 9, 'a newer namespace tombstone prevents resurrection');
  const restoredRevision = service.mergeRestoredConfig({ componentSettings: { fixture: { old: true } }, componentSettingsRevisions: { fixture: 3 } }, { componentSettings: { fixture: { restored: true } }, componentSettingsRevisions: { fixture: -9 } }, 'D:/restored');
  assert.deepEqual(restoredRevision.componentSettings.fixture, { restored: true }); assert.equal(restoredRevision.componentSettingsRevisions.fixture, 4, 'backup restore normalizes invalid revisions before issuing a newer revision');
  const restoredTombstone = service.mergeRestoredConfig({ componentSettings: { fixture: { stale: true } }, componentSettingsRevisions: { fixture: 2 } }, { componentSettings: {}, componentSettingsRevisions: { fixture: 7 } }, 'D:/restored');
  assert.equal(Object.hasOwn(restoredTombstone.componentSettings, 'fixture'), false, 'a restored no-value revision is an explicit tombstone that removes the current namespace');
  assert.equal(restoredTombstone.componentSettingsRevisions.fixture, 8, 'restored tombstones receive a new monotonic revision');
  const machineLocal = service.mergeRestoredConfig(
    { telemetry: { enabled: false, crashReports: true }, workspacePath: 'C:/current', workspacePaths: ['C:/current'], backup: { targetPath: 'E:/current' }, componentSettings: {}, componentSettingsRevisions: {} },
    { telemetry: { enabled: true, crashReports: false }, workspacePath: 'C:/snapshot', workspacePaths: ['C:/snapshot'], backup: { targetPath: 'F:/snapshot' }, componentSettings: {}, componentSettingsRevisions: {} },
    'D:/restored',
  );
  assert.deepEqual(machineLocal.telemetry, { enabled: false, crashReports: true }, 'restore preserves the current telemetry choice');
  assert.deepEqual(machineLocal.backup, { targetPath: 'E:/current' }, 'restore preserves current backup settings');
  assert.deepEqual(machineLocal.workspacePaths, [path.resolve('D:/restored')], 'restore replaces snapshot workspace roots with one canonical destination');
  const restoredLegacy = service.mergeRestoredConfig({ componentSettings: {}, componentSettingsRevisions: {} }, legacyOnly, 'D:/restored');
  assert.equal(Object.hasOwn(restoredLegacy.componentSettings, 'fixture-adopter'), false, 'undeclared services do not interpret component-specific legacy settings');
  const declaredPath = path.join(root, 'declared-config.json'); fs.writeFileSync(declaredPath, JSON.stringify(legacyOnly));
  const declaredService = createConfigMutationService({ fs, crypto, getConfigPath: () => declaredPath, readSavedConfig: () => JSON.parse(fs.readFileSync(declaredPath, 'utf8')), legacySettingsAdoptions: adoption, adoptionPolicy });
  await declaredService.adoptLegacySettings(); const declaredSaved = JSON.parse(fs.readFileSync(declaredPath, 'utf8'));
  assert.deepEqual(declaredSaved.componentSettings['fixture-adopter'], legacyOnly.legacyFixture); assert.equal(declaredSaved.componentSettingsRevisions['fixture-adopter'], 1);
  await declaredService.mutate(current => declaredService.mergeRendererConfig(legacyOnly, current));
  assert.deepEqual(JSON.parse(fs.readFileSync(declaredPath, 'utf8')).componentSettings['fixture-adopter'], legacyOnly.legacyFixture, 'a pre-adoption renderer snapshot cannot erase the adopted namespace through CAS');
  await declaredService.adoptLegacySettings(); assert.deepEqual(JSON.parse(fs.readFileSync(declaredPath, 'utf8')), declaredSaved, 'startup adoption remains byte/semantic idempotent');
  const restoreAdopted = declaredService.mergeRestoredConfig({ componentSettings: {}, componentSettingsRevisions: {} }, legacyOnly, 'D:/restored');
  assert.deepEqual(restoreAdopted.componentSettings['fixture-adopter'], legacyOnly.legacyFixture); assert.equal(restoreAdopted.componentSettingsRevisions['fixture-adopter'], 1, 'backup restore applies declared legacy adoption atomically');
  const restoreNewWins = declaredService.mergeRestoredConfig({ componentSettings: { 'fixture-adopter': { useGpu: true } }, componentSettingsRevisions: { 'fixture-adopter': 12 } }, legacyOnly, 'D:/restored');
  assert.deepEqual(restoreNewWins.componentSettings['fixture-adopter'], { useGpu: true }); assert.equal(restoreNewWins.componentSettingsRevisions['fixture-adopter'], 12, 'current namespaced settings outrank a legacy-only backup');
  const restoredNamespaceWins = declaredService.mergeRestoredConfig({ componentSettings: {}, componentSettingsRevisions: {} }, { ...legacyOnly, componentSettings: { 'fixture-adopter': { useGpu: true } }, componentSettingsRevisions: { 'fixture-adopter': 4 } }, 'D:/restored');
  assert.deepEqual(restoredNamespaceWins.componentSettings['fixture-adopter'], { useGpu: true }); assert.equal(restoredNamespaceWins.componentSettingsRevisions['fixture-adopter'], 5, 'a restored namespace outranks its legacy source');
  const restoredNamespaceTombstone = declaredService.mergeRestoredConfig({ componentSettings: {}, componentSettingsRevisions: {} }, { ...legacyOnly, componentSettingsRevisions: { 'fixture-adopter': 4 } }, 'D:/restored');
  assert.equal(Object.hasOwn(restoredNamespaceTombstone.componentSettings, 'fixture-adopter'), false); assert.equal(restoredNamespaceTombstone.componentSettingsRevisions['fixture-adopter'], 5, 'a restored namespace tombstone cannot be resurrected by its legacy source');

  const dynamicPath = path.join(root, 'dynamic-config.json'); fs.writeFileSync(dynamicPath, JSON.stringify(legacyOnly));
  let installedDescriptors = [];
  const dynamicService = createConfigMutationService({ fs, crypto, getConfigPath: () => dynamicPath, readSavedConfig: () => JSON.parse(fs.readFileSync(dynamicPath, 'utf8')), legacySettingsAdoptionsProvider: () => installedDescriptors, adoptionPolicy });
  await dynamicService.adoptLegacySettings(); assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(dynamicPath, 'utf8')).componentSettings, 'fixture-adopter'), false, 'an uninstalled component cannot claim legacy settings');
  installedDescriptors = adoption; await dynamicService.adoptLegacySettings();
  assert.deepEqual(JSON.parse(fs.readFileSync(dynamicPath, 'utf8')).componentSettings['fixture-adopter'], legacyOnly.legacyFixture, 'runtime installation uses the current descriptor set and adopts settings on the serialized mutation tail');

  const beforeClear = readSavedConfig();
  const staleBeforeClear = JSON.parse(JSON.stringify(beforeClear));
  await service.mutate(current => { const componentSettings = { ...current.componentSettings }; delete componentSettings.fixture; return { ...current, componentSettings, componentSettingsRevisions: { ...current.componentSettingsRevisions, fixture: service.nextRevision(current.componentSettingsRevisions.fixture) } }; });
  await service.mutate(current => service.mergeRendererConfig(staleBeforeClear, current));
  assert.equal(Object.hasOwn(readSavedConfig().componentSettings, 'fixture'), false, 'a stale renderer draft cannot revive settings after a tombstone clear');
  assert.equal(readSavedConfig().componentSettingsRevisions.fixture, 6, 'clear retains a monotonic tombstone revision');

  let releaseInflight;
  const inflightGate = new Promise(resolve => { releaseInflight = resolve; });
  const acceptedWrite = service.mutate(async current => { await inflightGate; return { ...current, componentSettings: { ...current.componentSettings, fixture: { quality: 44 } }, componentSettingsRevisions: { ...current.componentSettingsRevisions, fixture: service.nextRevision(current.componentSettingsRevisions.fixture) } }; });
  const clearAfterAcceptedWrite = service.mutate(current => { const componentSettings = { ...current.componentSettings }; delete componentSettings.fixture; return { ...current, componentSettings, componentSettingsRevisions: { ...current.componentSettingsRevisions, fixture: service.nextRevision(current.componentSettingsRevisions.fixture) } }; });
  releaseInflight(); await Promise.all([acceptedWrite, clearAfterAcceptedWrite]);
  assert.equal(Object.hasOwn(readSavedConfig().componentSettings, 'fixture'), false, 'an accepted in-flight settings write completes before a later clear mutation');
  assert.equal(readSavedConfig().componentSettingsRevisions.fixture, 8);

  const makeRecoveryFixture = name => {
    const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, 'config.json');
    const read = () => JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { filePath, read, create: faultInjector => createConfigMutationService({ fs, crypto, getConfigPath: () => filePath, readSavedConfig: read, faultInjector }) };
  };
  const missingMain = makeRecoveryFixture('missing-main');
  fs.writeFileSync(`${missingMain.filePath}.recovery`, JSON.stringify({ value: 'recovered' }));
  assert.deepEqual(await missingMain.create().read(), { value: 'recovered' }, 'startup restores a fixed recovery file when the primary path is missing');

  const bothExist = makeRecoveryFixture('both-exist');
  fs.writeFileSync(bothExist.filePath, JSON.stringify({ value: 'committed' })); fs.writeFileSync(`${bothExist.filePath}.recovery`, JSON.stringify({ value: 'old' }));
  assert.deepEqual(await bothExist.create().read(), { value: 'committed' });
  assert.equal(fs.existsSync(`${bothExist.filePath}.recovery`), false, 'a committed primary wins over stale recovery data');

  const backupFault = makeRecoveryFixture('backup-fault');
  fs.writeFileSync(backupFault.filePath, JSON.stringify({ value: 'old' }));
  const failing = backupFault.create(stage => { if (stage === 'after-backup') throw new Error('fault after backup'); });
  await assert.rejects(failing.mutate(() => ({ value: 'new' })), /fault after backup/);
  assert.deepEqual(backupFault.read(), { value: 'old' }, 'a pre-commit fault restores the previous primary');

  const cleanupFault = makeRecoveryFixture('cleanup-fault');
  fs.writeFileSync(cleanupFault.filePath, JSON.stringify({ value: 'old' }));
  await cleanupFault.create(stage => { if (stage === 'before-recovery-cleanup') throw new Error('cleanup denied'); }).mutate(() => ({ value: 'new' }));
  assert.deepEqual(cleanupFault.read(), { value: 'new' }, 'recovery cleanup failure cannot turn a committed save into failure');

  const postCommitFault = makeRecoveryFixture('post-commit-fault');
  fs.writeFileSync(postCommitFault.filePath, JSON.stringify({ value: 'old' }));
  await assert.rejects(postCommitFault.create(stage => { if (stage === 'after-commit') throw new Error('simulated crash'); }).mutate(() => ({ value: 'committed' })), /simulated crash/);
  assert(fs.existsSync(`${postCommitFault.filePath}.recovery`));
  assert.deepEqual(await postCommitFault.create().read(), { value: 'committed' }, 'startup recovery keeps the committed primary after a post-commit crash');
  assert.equal(fs.existsSync(`${postCommitFault.filePath}.recovery`), false);

  const onlineRead = makeRecoveryFixture('online-read'); fs.writeFileSync(onlineRead.filePath, JSON.stringify({ value: 'old-online' }));
  let afterBackupReached; let releaseAfterBackup;
  const afterBackupGate = new Promise(resolve => { releaseAfterBackup = resolve; });
  const gatedService = onlineRead.create(async stage => { if (stage === 'after-backup') { afterBackupReached?.(); await afterBackupGate; } });
  const reachedBackup = new Promise(resolve => { afterBackupReached = resolve; });
  const gatedMutation = gatedService.mutate(() => ({ value: 'new-online' })); await reachedBackup;
  assert.equal(configSnapshotExists(fs, onlineRead.filePath), true, 'loadConfig/startup snapshot presence checks accept the fixed recovery file during rename');
  assert.equal(gatedService.hasSnapshot(), true);
  assert.deepEqual(readConfigFileWithRecovery(fs, onlineRead.filePath), { value: 'old-online' }, 'direct config reads use the fixed recovery snapshot while the primary path is between renames');
  releaseAfterBackup(); await gatedMutation; assert.deepEqual(onlineRead.read(), { value: 'new-online' });

  let releaseDrain; const drainGate = new Promise(resolve => { releaseDrain = resolve; });
  const drainingMutation = service.mutate(async current => { await drainGate; return { ...current, drained: true }; });
  await assert.rejects(service.drain({ timeoutMs: 10 }), error => error.code === 'CONFIG_BUSY');
  releaseDrain(); await drainingMutation; await service.drain({ timeoutMs: 1000 });

  let releaseQuit; const quitGate = new Promise(resolve => { releaseQuit = resolve; });
  const quitMutation = service.mutate(async current => { await quitGate; return { ...current, quitFlushed: true }; });
  const events = new EventEmitter(); let cleanupCalls = 0; let quitCalls = 0;
  const fakeApp = { on: (...args) => events.on(...args), quit: () => { quitCalls += 1; events.emit('before-quit', { preventDefault() {} }); } };
  const quitState = registerConfigDrainBeforeQuit({ app: fakeApp, getConfigMutationService: () => service, onQuit: () => { cleanupCalls += 1; }, timeoutMs: 1000 });
  let prevented = false; events.emit('before-quit', { preventDefault: () => { prevented = true; } }); events.emit('before-quit', { preventDefault() {} });
  assert(prevented); assert.equal(quitState(), 'draining'); assert.equal(cleanupCalls, 0, 're-entrant quit events cannot bypass the pending config drain');
  releaseQuit(); await quitMutation; await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitCalls, 1); assert.equal(cleanupCalls, 1); assert.equal(quitState(), 'ready');
  console.log('Config mutation concurrency tests passed');
})().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
