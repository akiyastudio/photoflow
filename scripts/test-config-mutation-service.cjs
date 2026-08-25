const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createConfigMutationService, nextComponentRevision, normalizeComponentRevision, readConfigFileWithRecovery, configSnapshotExists, registerConfigDrainBeforeQuit } = require('../electron/services/config-mutation-service.cjs');

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
  const restoredRevision = service.mergeRestoredConfig({ componentSettings: { fixture: { old: true } }, componentSettingsRevisions: { fixture: 3 } }, { componentSettings: { fixture: { restored: true } }, componentSettingsRevisions: { fixture: -9 } }, 'D:/restored');
  assert.deepEqual(restoredRevision.componentSettings.fixture, { restored: true }); assert.equal(restoredRevision.componentSettingsRevisions.fixture, 4, 'backup restore normalizes invalid revisions before issuing a newer revision');
  const restoredTombstone = service.mergeRestoredConfig({ componentSettings: { fixture: { stale: true } }, componentSettingsRevisions: { fixture: 2 } }, { componentSettings: {}, componentSettingsRevisions: { fixture: 7 } }, 'D:/restored');
  assert.equal(Object.hasOwn(restoredTombstone.componentSettings, 'fixture'), false, 'a restored no-value revision is an explicit tombstone that removes the current namespace');
  assert.equal(restoredTombstone.componentSettingsRevisions.fixture, 8, 'restored tombstones receive a new monotonic revision');

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

