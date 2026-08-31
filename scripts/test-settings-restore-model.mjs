import assert from 'node:assert/strict';
import { createSettingsSaveCoordinator, restoredWorkspaceConfig } from '../src/features/settings/restored-workspace-config.ts';

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

const transactionCalls = [];
const transaction = coordinator.transaction(async save => {
  assert.equal(await save({ value: 3 }), true);
  transactionCalls.push('tested');
  assert.equal(await save({ value: 4 }), true);
});
const outside = coordinator.enqueue({ value: 5 });
await transaction; await outside;
assert.deepEqual(saveCalls.slice(-3), [3, 4, 5], 'multi-stage saves remain one serial transaction');
assert.equal(drafts.at(-1), 5, 'an older transaction callback cannot overwrite a newer visible draft');
const rejectedSave = coordinator.enqueue({ value: 6 });
const afterRejection = coordinator.enqueue({ value: 7 });
assert.equal(await rejectedSave, false); assert.equal(await afterRejection, true);
assert.equal(drafts.at(-1), 7, 'a rejected save cannot discard or overwrite its pending successor');
assert.equal(await coordinator.enqueue({ value: 8 }), false);
assert.equal(drafts.at(-1), 7, 'a latest failed draft rolls back to the last persisted configuration');
assert.equal(saveCalls.at(-1), 7, 'rollback also reconciles an optimistic parent configuration');
console.log('Settings restore canonical model tests passed');

