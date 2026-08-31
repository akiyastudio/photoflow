import assert from 'node:assert/strict';
import { createSettingsSaveCoordinator, patchSettingsDraft, restoredWorkspaceConfig, waitForPersistedSettings } from '../src/features/settings/restored-workspace-config.ts';

const snapshot = { theme: 'light', defaultFolderSort: 'name', workspacePath: 'C:/old', workspacePaths: ['C:/old'], backup: { enabled: true, targetType: 'local', targetPath: 'E:/backup' }, componentSettings: { fixture: { enabled: true } }, componentSettingsRevisions: { fixture: 4 } };
const restored = restoredWorkspaceConfig(snapshot, 'D:/restored');
assert.equal(restored.theme, 'light'); assert.equal(restored.defaultFolderSort, 'name');
assert.equal(restored.workspacePath, 'D:/restored'); assert.equal(restored.workspacePaths[0], 'D:/restored');
assert.deepEqual(restored.backup, snapshot.backup); assert.deepEqual(restored.componentSettings, snapshot.componentSettings);
assert.notStrictEqual(restored, snapshot);

const current = { ...snapshot, telemetry: { enabled: false, crashReports: true }, workspacePath: 'C:/current', workspacePaths: ['C:/current'], backup: { enabled: false, targetType: 'nas', targetPath: '\\\\nas\\backup' } };
const merged = restoredWorkspaceConfig({ ...snapshot, telemetry: { enabled: true, crashReports: false }, workspacePaths: ['d:\\restored', 'D:/RESTORED/'] }, 'D:/restored', current);
assert.deepEqual(merged.telemetry, current.telemetry, 'restore preserves the current machine telemetry choice');
assert.deepEqual(merged.backup, current.backup, 'restore preserves the current machine backup target');
assert.deepEqual(merged.workspacePaths, ['D:/restored'], 'restore uses one canonical destination workspace path');

const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const first = deferred();
const saveCalls = [];
const drafts = [];
const failures = [];
const coordinator = createSettingsSaveCoordinator({
  initial: { value: 0 },
  normalize: value => value,
  applyDraft: value => drafts.push(value.value),
  save: async value => {
    saveCalls.push(value.value);
    if (value.value === 1) return first.promise;
    if (value.value === 6) throw new Error('rejected save');
    return value.value !== 8;
  },
  onFailure: (_value, error) => failures.push(error.message),
});
const failedSave = coordinator.enqueue({ value: 1 });
const pendingSave = coordinator.enqueue({ value: 2 });
first.resolve(false);
assert.equal(await failedSave, false);
assert.equal(await pendingSave, true);
assert.deepEqual(saveCalls, [1, 2], 'a failed save does not discard a pending newer save');
assert.equal(drafts.at(-1), 2, 'an old failed callback cannot roll back a newer draft');
assert.equal(failures.length, 1, 'false save results are surfaced');

const rejectedSave = coordinator.enqueue({ value: 6 });
const afterRejection = coordinator.enqueue({ value: 7 });
assert.equal(await rejectedSave, false); assert.equal(await afterRejection, true);
assert.equal(drafts.at(-1), 7, 'a rejected save cannot discard or overwrite its pending successor');
assert.equal(await coordinator.enqueue({ value: 8 }), false);
assert.equal(drafts.at(-1), 7, 'a latest failed draft rolls back to the last persisted configuration');
assert.equal(saveCalls.at(-1), 7, 'rollback also reconciles an optimistic parent configuration');

const runAfterPersistedSettings = async (saveCoordinator, action) => {
  const result = await waitForPersistedSettings(saveCoordinator);
  if (result.status === 'saved') await action();
  return result;
};
for (const actionName of ['run', 'cleanup', 'verify']) {
  const gate = deferred();
  let actionCalls = 0;
  const actionCoordinator = createSettingsSaveCoordinator({
    initial: { value: 0 }, normalize: value => value, applyDraft: () => undefined,
    save: () => gate.promise, onFailure: () => undefined,
  });
  const pending = actionCoordinator.enqueue({ value: 1 });
  const action = runAfterPersistedSettings(actionCoordinator, async () => { actionCalls += 1; });
  await Promise.resolve();
  assert.equal(actionCalls, 0, `${actionName} waits while its settings version is pending`);
  gate.resolve(true);
  assert.equal(await pending, true);
  assert.equal((await action).status, 'saved');
  assert.equal(actionCalls, 1, `${actionName} starts only after its settings version is persisted`);
}

let failedActionCalls = 0;
const failedActionCoordinator = createSettingsSaveCoordinator({
  initial: { value: 0 }, normalize: value => value, applyDraft: () => undefined,
  save: async value => value.value !== 1, onFailure: () => undefined,
});
const failedActionSave = failedActionCoordinator.enqueue({ value: 1 });
const failedAction = runAfterPersistedSettings(failedActionCoordinator, async () => { failedActionCalls += 1; });
assert.equal(await failedActionSave, false);
assert.equal((await failedAction).status, 'save-failed');
assert.equal(failedActionCalls, 0, 'a rolled-back settings version cannot start a dependent backup action');

const firstEdit = deferred(); const secondEdit = deferred();
let changedActionCalls = 0; let editNumber = 0;
const changedActionCoordinator = createSettingsSaveCoordinator({
  initial: { value: 0 }, normalize: value => value, applyDraft: () => undefined,
  save: () => (++editNumber === 1 ? firstEdit.promise : secondEdit.promise), onFailure: () => undefined,
});
const firstEditSave = changedActionCoordinator.enqueue({ value: 1 });
const changedAction = runAfterPersistedSettings(changedActionCoordinator, async () => { changedActionCalls += 1; });
const latestEditSave = changedActionCoordinator.enqueue({ value: 2 });
firstEdit.resolve(true); await firstEditSave;
assert.equal((await changedAction).status, 'changed');
assert.equal(changedActionCalls, 0, 'an edit made during drain is not misreported as failure and cannot start with stale settings');
secondEdit.resolve(true); await latestEditSave;
const retriedAction = await runAfterPersistedSettings(changedActionCoordinator, async () => { changedActionCalls += 1; });
assert.equal(retriedAction.status, 'saved');
assert.equal(changedActionCalls, 1, 'retry starts after the newer settings version is stable');

const connectionTest = deferred(); const testingSaved = deferred();
let nasDraft = { theme: 'light', backup: { enabled: false, targetPath: '', automaticDaily: true, nas: { limitEnabled: false } } };
let savedNasConfig = nasDraft;
const nasWrites = [];
const nasCoordinator = createSettingsSaveCoordinator({
  initial: nasDraft,
  normalize: value => value,
  applyDraft: value => { nasDraft = value; },
  save: async value => { nasWrites.push(structuredClone(value)); savedNasConfig = value; return true; },
  onFailure: () => undefined,
});
const nasTransaction = nasCoordinator.transaction(async save => {
  assert.equal(await save({ ...nasDraft, backup: { ...nasDraft.backup, enabled: false, targetPath: '\\\\nas\\backup' } }), true);
  testingSaved.resolve();
  await connectionTest.promise;
  assert.equal(await save({ ...nasDraft, backup: { ...nasDraft.backup, enabled: true, targetPath: '\\\\nas\\backup' } }, { incorporatesPending: true }), true);
});
await testingSaved.promise;
const userEdit = nasCoordinator.enqueueMutation(current => ({ ...current, backup: { ...current.backup, automaticDaily: false } }));
const userEditRevision = nasCoordinator.currentVersion();
connectionTest.resolve();
await nasTransaction; await userEdit;
assert.deepEqual(savedNasConfig, { theme: 'light', backup: { enabled: true, targetPath: '\\\\nas\\backup', automaticDaily: false, nas: { limitEnabled: false } } }, 'NAS final save merges a backup sibling edit made during connection testing');
assert.equal(nasWrites.length, 2, 'the queued stale user snapshot is skipped after the higher transaction revision persists');
assert.equal((await nasCoordinator.drain(userEditRevision)).status, 'superseded', 'the skipped queued revision has an explicit superseded acknowledgement');

const failedConnectionTest = deferred(); const failedTestingSaved = deferred();
let failedNasDraft = { theme: 'light', backup: { enabled: false, targetPath: '', automaticDaily: true, nas: { limitEnabled: false } } };
let failedNasDisk = failedNasDraft;
const failedNasCoordinator = createSettingsSaveCoordinator({
  initial: failedNasDraft,
  normalize: value => value,
  applyDraft: value => { failedNasDraft = value; },
  save: async value => {
    if (value.backup.enabled) return false;
    failedNasDisk = value;
    return true;
  },
  onFailure: () => undefined,
});
const failedNasTransaction = failedNasCoordinator.transaction(async save => {
  assert.equal(await save({ ...failedNasDraft, backup: { ...failedNasDraft.backup, enabled: false, targetPath: '\\\\nas\\backup' } }), true);
  failedTestingSaved.resolve();
  await failedConnectionTest.promise;
  assert.equal(await save({ ...failedNasDraft, backup: { ...failedNasDraft.backup, enabled: true, targetPath: '\\\\nas\\backup' } }, { incorporatesPending: true }), false);
});
await failedTestingSaved.promise;
const editBehindFailedTransaction = failedNasCoordinator.enqueueMutation(current => ({ ...current, backup: { ...current.backup, automaticDaily: false } }));
failedConnectionTest.resolve();
await failedNasTransaction; await editBehindFailedTransaction;
assert.deepEqual(failedNasDisk, { theme: 'light', backup: { enabled: false, targetPath: '\\\\nas\\backup', automaticDaily: false, nas: { limitEnabled: false } } }, 'a lower queued backup sibling edit rebases on tx1 after tx2 fails');
assert.deepEqual(failedNasDraft, failedNasDisk, 'the lower queued edit is re-applied after rollback so UI and disk remain identical');
assert.deepEqual(failedNasCoordinator.getAcknowledgement(), { latestRevision: 3, currentRevision: 2, persistedRevision: 2, lastFailedRevision: 3 });
assert.equal((await failedNasCoordinator.drain(3)).status, 'save-failed');
assert.equal((await failedNasCoordinator.drain(2)).status, 'saved');

for (const finalSucceeds of [true, false]) {
  const finalSaveCalled = deferred(); const finalSaveResult = deferred();
  let afterCallDraft = { theme: 'light', backup: { enabled: false, targetPath: '', automaticDaily: true, nas: { limitEnabled: false } } };
  let afterCallDisk = afterCallDraft;
  const afterCallCoordinator = createSettingsSaveCoordinator({
    initial: afterCallDraft,
    normalize: value => value,
    applyDraft: value => { afterCallDraft = value; },
    save: async value => {
      if (value.backup.enabled) {
        finalSaveCalled.resolve();
        const accepted = await finalSaveResult.promise;
        if (accepted) afterCallDisk = value;
        return accepted;
      }
      afterCallDisk = value;
      return true;
    },
    onFailure: () => undefined,
  });
  const afterCallTransaction = afterCallCoordinator.transaction(async save => {
    assert.equal(await save({ ...afterCallDraft, backup: { ...afterCallDraft.backup, enabled: false, targetPath: '\\\\nas\\backup' } }), true);
    return save({ ...afterCallDraft, backup: { ...afterCallDraft.backup, enabled: true, targetPath: '\\\\nas\\backup' } }, { incorporatesPending: true });
  });
  await finalSaveCalled.promise;
  const editAfterFinalCall = afterCallCoordinator.enqueueMutation(current => ({ ...current, backup: { ...current.backup, nas: { ...current.backup.nas, limitEnabled: true } } }));
  finalSaveResult.resolve(finalSucceeds);
  assert.equal(await afterCallTransaction, finalSucceeds);
  await editAfterFinalCall;
  assert.deepEqual(afterCallDisk, { theme: 'light', backup: { enabled: finalSucceeds, targetPath: '\\\\nas\\backup', automaticDaily: true, nas: { limitEnabled: true } } }, `nested backup edit after final call rebases on the ${finalSucceeds ? 'successful final' : 'testing fallback'}`);
  assert.deepEqual(afterCallDraft, afterCallDisk, 'after-call UI and disk converge');
}

for (const connectionSucceeds of [true, false]) {
  const credentialStarted = deferred(); const credentialResult = deferred();
  let credentialDraft = { backup: { enabled: false, targetType: 'local', targetPath: '', mode: 'history', automaticDaily: true, nas: { credentialRef: '', limitEnabled: false } } };
  let credentialDisk = credentialDraft;
  const credentialWrites = [];
  const credentialCoordinator = createSettingsSaveCoordinator({
    initial: credentialDraft, normalize: value => value, applyDraft: value => { credentialDraft = value; },
    save: async value => { credentialWrites.push(structuredClone(value)); credentialDisk = value; return true; }, onFailure: () => undefined,
  });
  const credentialTransaction = credentialCoordinator.transaction(async save => {
    credentialStarted.resolve();
    const credentialRef = await credentialResult.promise;
    if (!credentialRef) return;
    const latestForTesting = credentialDraft;
    await save({ ...latestForTesting, backup: { ...latestForTesting.backup, enabled: false, targetType: 'nas', targetPath: '\\\\nas\\backup', nas: { ...latestForTesting.backup.nas, credentialRef } } });
    const latestForFinal = credentialDraft;
    await save({ ...latestForFinal, backup: { ...latestForFinal.backup, enabled: connectionSucceeds, targetType: 'nas', targetPath: connectionSucceeds ? '\\\\nas\\backup' : '', nas: { ...latestForFinal.backup.nas, credentialRef } } }, { incorporatesPending: true });
  });
  await credentialStarted.promise;
  const editWhileCredentialPending = credentialCoordinator.enqueueMutation(current => ({ ...current, backup: { ...current.backup, mode: 'latest', automaticDaily: false, nas: { ...current.backup.nas, limitEnabled: true } } }));
  const pendingCredentialRevision = credentialCoordinator.currentVersion();
  credentialResult.resolve('credential:new');
  await credentialTransaction; await editWhileCredentialPending;
  assert.deepEqual(credentialDisk, { backup: { enabled: connectionSucceeds, targetType: 'nas', targetPath: connectionSucceeds ? '\\\\nas\\backup' : '', mode: 'latest', automaticDaily: false, nas: { credentialRef: 'credential:new', limitEnabled: true } } }, `credential wait edits survive connection ${connectionSucceeds ? 'success' : 'failure'}`);
  assert.deepEqual(credentialDraft, credentialDisk);
  assert.equal(credentialWrites.length, 2);
  assert.equal((await credentialCoordinator.drain(pendingCredentialRevision)).status, 'superseded', 'credential transaction only supersedes the pending edit after incorporating it');
}

const failedCredential = deferred(); const failedCredentialStarted = deferred();
let failedCredentialDraft = { backup: { enabled: false, automaticDaily: true, nas: { limitEnabled: false } } };
let failedCredentialDisk = failedCredentialDraft;
const failedCredentialWrites = [];
const failedCredentialCoordinator = createSettingsSaveCoordinator({
  initial: failedCredentialDraft, normalize: value => value, applyDraft: value => { failedCredentialDraft = value; },
  save: async value => { failedCredentialWrites.push(structuredClone(value)); failedCredentialDisk = value; return true; }, onFailure: () => undefined,
});
const failingCredentialTransaction = failedCredentialCoordinator.transaction(async save => {
  failedCredentialStarted.resolve();
  const credentialRef = await failedCredential.promise;
  if (!credentialRef) return;
  await save({ ...failedCredentialDraft, backup: { ...failedCredentialDraft.backup, enabled: false } });
});
await failedCredentialStarted.promise;
const editDuringFailedCredential = failedCredentialCoordinator.enqueueMutation(current => ({ ...current, backup: { ...current.backup, automaticDaily: false, nas: { ...current.backup.nas, limitEnabled: true } } }));
failedCredential.resolve('');
await failingCredentialTransaction; await editDuringFailedCredential;
assert.deepEqual(failedCredentialDisk, { backup: { enabled: false, automaticDaily: false, nas: { limitEnabled: true } } }, 'credential save failure does not overwrite a pending edit');
assert.deepEqual(failedCredentialDraft, failedCredentialDisk);
assert.equal(failedCredentialWrites.length, 1, 'only the ordinary edit writes after credential failure');

const targetPending = deferred(); const targetStarted = deferred();
let existingCredentialDraft = { backup: { enabled: false, automaticDaily: true, nas: { credentialRef: '', limitEnabled: false } } };
let existingCredentialDisk = existingCredentialDraft;
const existingCredentialCoordinator = createSettingsSaveCoordinator({
  initial: existingCredentialDraft, normalize: value => value, applyDraft: value => { existingCredentialDraft = value; },
  save: async value => { existingCredentialDisk = value; return true; }, onFailure: () => undefined,
});
const existingCredentialTransaction = existingCredentialCoordinator.transaction(async save => {
  targetStarted.resolve();
  await targetPending.promise;
  const credentialRef = existingCredentialDraft.backup.nas.credentialRef;
  if (!credentialRef) return;
  await save({ ...existingCredentialDraft, backup: { ...existingCredentialDraft.backup, enabled: true, nas: { ...existingCredentialDraft.backup.nas, credentialRef } } }, { incorporatesPending: true });
});
await targetStarted.promise;
const existingCredentialEdit = existingCredentialCoordinator.enqueueMutation(current => ({ ...current, backup: { ...current.backup, automaticDaily: false, nas: { ...current.backup.nas, credentialRef: 'credential:existing', limitEnabled: true } } }));
targetPending.resolve();
await existingCredentialTransaction; await existingCredentialEdit;
assert.deepEqual(existingCredentialDisk, { backup: { enabled: true, automaticDaily: false, nas: { credentialRef: 'credential:existing', limitEnabled: true } } }, 'no-new-credential path reads the latest existing credential and sibling edits after await');
assert.deepEqual(existingCredentialDraft, existingCredentialDisk);

for (const editTiming of ['before-final-call', 'after-final-call']) {
  const connectionGate = deferred(); const finalGate = deferred(); const firstSaved = deferred(); const finalCalled = deferred();
  let sameFieldDraft = { backup: { enabled: false, targetPath: '' } };
  let sameFieldDisk = sameFieldDraft;
  const sameFieldCoordinator = createSettingsSaveCoordinator({
    initial: sameFieldDraft, normalize: value => value, applyDraft: value => { sameFieldDraft = value; },
    save: async value => {
      if (value.backup.enabled) { finalCalled.resolve(); await finalGate.promise; }
      sameFieldDisk = value;
      return true;
    }, onFailure: () => undefined,
  });
  const sameFieldTransaction = sameFieldCoordinator.transaction(async save => {
    await save({ backup: { enabled: false, targetPath: '\\\\nas\\backup' } });
    firstSaved.resolve();
    await connectionGate.promise;
    await save({ backup: { enabled: true, targetPath: '\\\\nas\\backup' } }, { incorporatesPending: true });
  });
  await firstSaved.promise;
  let sameFieldEdit;
  if (editTiming === 'before-final-call') {
    sameFieldEdit = sameFieldCoordinator.enqueueMutation(current => ({ ...current, backup: { ...current.backup, enabled: false, targetPath: 'E:/user-choice' } }));
    connectionGate.resolve();
    await finalCalled.promise;
  } else {
    connectionGate.resolve();
    await finalCalled.promise;
    sameFieldEdit = sameFieldCoordinator.enqueueMutation(current => ({ ...current, backup: { ...current.backup, enabled: false } }));
  }
  finalGate.resolve();
  await sameFieldTransaction; await sameFieldEdit;
  const expected = editTiming === 'before-final-call'
    ? { backup: { enabled: true, targetPath: '\\\\nas\\backup' } }
    : { backup: { enabled: false, targetPath: '\\\\nas\\backup' } };
  assert.deepEqual(sameFieldDisk, expected, `${editTiming} follows explicit last-writer order`);
  assert.deepEqual(sameFieldDraft, sameFieldDisk);
}

for (const failureMode of ['save-failed', 'changed']) {
  const firstRestoreSave = deferred(); const secondRestoreSave = deferred();
  let restoreSaveNumber = 0; let restoreIpcCalls = 0;
  const restoreCoordinator = createSettingsSaveCoordinator({
    initial: { value: 0 }, normalize: value => value, applyDraft: () => undefined,
    save: () => (++restoreSaveNumber === 1 ? firstRestoreSave.promise : failureMode === 'save-failed' ? true : secondRestoreSave.promise), onFailure: () => undefined,
  });
  const pendingRestoreSave = restoreCoordinator.enqueue({ value: 1 });
  const restoreAttempt = runAfterPersistedSettings(restoreCoordinator, async () => { restoreIpcCalls += 1; });
  let laterRestoreSave;
  if (failureMode === 'changed') laterRestoreSave = restoreCoordinator.enqueue({ value: 2 });
  firstRestoreSave.resolve(failureMode !== 'save-failed');
  await pendingRestoreSave;
  assert.equal((await restoreAttempt).status, failureMode);
  assert.equal(restoreIpcCalls, 0, `restore IPC is not called after ${failureMode} drain`);
  if (laterRestoreSave) { secondRestoreSave.resolve(true); await laterRestoreSave; }
}

const restoreIpc = deferred(); const restoreStarted = deferred();
let restoreDraft = { workspacePath: 'C:/old', theme: 'light' };
const restoreWrites = [];
const restoreCoordinator = createSettingsSaveCoordinator({
  initial: restoreDraft, normalize: value => value, applyDraft: value => { restoreDraft = value; },
  save: async value => { restoreWrites.push(structuredClone(value)); return true; }, onFailure: () => undefined,
});
const restoring = restoreCoordinator.transaction(async (_save, adopt) => {
  restoreStarted.resolve();
  const restoredConfig = await restoreIpc.promise;
  adopt(restoredConfig);
});
await restoreStarted.promise;
const editDuringRestore = restoreCoordinator.enqueue({ ...restoreDraft, theme: 'dark' });
restoreIpc.resolve({ workspacePath: 'D:/restored', theme: 'restored' });
await restoring; await editDuringRestore;
assert.deepEqual(restoreDraft, { workspacePath: 'D:/restored', theme: 'restored' }, 'external restore adopt remains authoritative over an in-flight edit');
assert.deepEqual(restoreWrites, [], 'the queued pre-adopt edit is skipped and cannot overwrite restored config');

const manyFailuresCoordinator = createSettingsSaveCoordinator({
  initial: { value: 0 }, normalize: value => value, applyDraft: () => undefined,
  save: async () => false, onFailure: () => undefined,
});
const manyFailures = [];
for (let value = 1; value <= 4096; value += 1) manyFailures.push(manyFailuresCoordinator.enqueue({ value }));
await Promise.all(manyFailures);
assert.deepEqual(manyFailuresCoordinator.getAcknowledgement(), { latestRevision: 4096, currentRevision: 0, persistedRevision: 0, lastFailedRevision: 4096 }, 'thousands of failures use a constant-size acknowledgement instead of retaining every revision');
assert.equal((await manyFailuresCoordinator.drain(4096)).status, 'save-failed');

let delayedDraft = { theme: 'light', customProjectCategories: ['client'], projectCategoryOrder: ['client'] };
const delayedCompletion = deferred();
const removeAfterDelay = (async () => {
  await delayedCompletion.promise;
  delayedDraft = patchSettingsDraft(delayedDraft, current => ({
    customProjectCategories: current.customProjectCategories.filter(name => name !== 'client'),
    projectCategoryOrder: current.projectCategoryOrder.filter(name => name !== 'client'),
  }));
})();
delayedDraft = patchSettingsDraft(delayedDraft, () => ({ theme: 'dark' }));
delayedCompletion.resolve(); await removeAfterDelay;
assert.equal(delayedDraft.theme, 'dark', 'a delayed field patch preserves another setting changed while it was waiting');
assert.deepEqual(delayedDraft.customProjectCategories, []);
console.log('Settings restore canonical model tests passed');

