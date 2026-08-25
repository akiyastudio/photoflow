import assert from 'node:assert/strict';
import { createLatestRequestGuard, createTeamSettingsController, runNotifiedAction } from '../extensions/team-retouch/renderer/src/team-settings-model.ts';

const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

const reads = [];
const failedInitial = createTeamSettingsController({ read: async () => { throw new Error('unavailable'); }, merge: async () => ({}) });
assert.deepEqual(failedInitial.getState(), { loaded: false, loading: true, error: '' }, 'the controller subscription bootstrap remains in loading state until the first read settles');
assert.equal(await failedInitial.refresh(), false); assert.equal(failedInitial.getState().loaded, false); assert.equal(failedInitial.getState().settings, undefined, 'failed initial reads never expose editable defaults');
const freshPatches = [];
const freshController = createTeamSettingsController({ read: async () => ({ settings: {} }), merge: async patch => { freshPatches.push(patch); return { settings: patch }; } });
assert(await freshController.refresh()); assert.deepEqual(freshController.getState().settings, { useGpu: true, oversizeCropMode: 'face-centered' }, 'fresh installs normalize an empty settings object to editable defaults');
await freshController.patch({ useGpu: false }); assert.deepEqual(freshController.getState().settings, { useGpu: false, oversizeCropMode: 'face-centered' }, 'a partial useGpu merge response retains the normalized crop default');
await freshController.patch({ oversizeCropMode: 'expand' }); assert.deepEqual(freshController.getState().settings, { useGpu: false, oversizeCropMode: 'expand' }, 'a partial crop merge response retains the previously saved GPU value');
assert.deepEqual(freshPatches, [{ useGpu: false }, { oversizeCropMode: 'expand' }]);
for (const [partial, expected] of [[{ useGpu: false }, { useGpu: false, oversizeCropMode: 'face-centered' }], [{ oversizeCropMode: 'expand' }, { useGpu: true, oversizeCropMode: 'expand' }]]) {
  const partialController = createTeamSettingsController({ read: async () => ({ settings: partial }), merge: async patch => ({ settings: patch }) });
  await partialController.refresh(); assert.deepEqual(partialController.getState().settings, expected, 'partial stored settings normalize missing fields with existing defaults');
}
for (const invalidSettings of [{ useGpu: 'yes' }, { oversizeCropMode: 'invalid' }, { useGpu: null }]) {
  const invalidController = createTeamSettingsController({ read: async () => ({ settings: invalidSettings }), merge: async patch => ({ settings: patch }) });
  assert.equal(await invalidController.refresh(), false); assert.equal(invalidController.getState().loaded, false, 'explicit invalid values remain rejected');
}
const staleController = createTeamSettingsController({ read: () => { const item = deferred(); reads.push(item); return item.promise; }, merge: async () => ({ settings: { useGpu: true, oversizeCropMode: 'face-centered' } }) });
await assert.rejects(staleController.patch({ useGpu: false }), /尚未读取完成/);
const loadA = staleController.refresh(); await tick(); assert.equal(reads.length, 1);
const loadB = staleController.refresh(); await tick(); assert.equal(reads.length, 2);
reads[1].resolve({ settings: { useGpu: false, oversizeCropMode: 'expand' } }); await loadB;
reads[0].resolve({ settings: { useGpu: true, oversizeCropMode: 'face-centered' } }); await loadA;
assert.deepEqual(staleController.getState().settings, { useGpu: false, oversizeCropMode: 'expand' }, 'a stale settings read cannot overwrite a newer generation');

const lateRefresh = deferred(); let interleavedReadCount = 0;
const interleavedController = createTeamSettingsController({ read: async () => ++interleavedReadCount === 1 ? { settings: { useGpu: true, oversizeCropMode: 'face-centered' } } : lateRefresh.promise, merge: async patch => ({ settings: patch }) });
await interleavedController.refresh(); const oldRefresh = interleavedController.refresh(); await tick();
await interleavedController.patch({ useGpu: false });
lateRefresh.resolve({ settings: { useGpu: true, oversizeCropMode: 'face-centered' } }); await oldRefresh;
assert.deepEqual(interleavedController.getState().settings, { useGpu: false, oversizeCropMode: 'face-centered' }, 'a patch advances the shared epoch so an older refresh cannot roll back its successful value');

let patchRefreshServer = { useGpu: true, oversizeCropMode: 'face-centered' }; const delayedMerge = deferred(); let patchRefreshReads = 0;
const patchRefreshController = createTeamSettingsController({ read: async () => { patchRefreshReads += 1; return { settings: { ...patchRefreshServer } }; }, merge: async patch => { await delayedMerge.promise; patchRefreshServer = { ...patchRefreshServer, ...patch }; return { settings: patchRefreshServer }; } });
await patchRefreshController.refresh(); const patchBeforeRefresh = patchRefreshController.patch({ oversizeCropMode: 'expand' }); await tick();
const refreshAfterPatch = patchRefreshController.refresh(); await tick(); assert.equal(patchRefreshReads, 1, 'refresh waits behind the active settings mutation before taking its snapshot');
delayedMerge.resolve(); await patchBeforeRefresh; await refreshAfterPatch;
assert.deepEqual(patchRefreshController.getState().settings, patchRefreshServer, 'patch then refresh cannot restore a pre-mutation server snapshot');

let server = { useGpu: true, oversizeCropMode: 'face-centered' };
const writes = [];
const queueController = createTeamSettingsController({
  read: async () => ({ settings: server }),
  merge: patch => { const item = deferred(); writes.push({ patch, item }); return item.promise; },
});
await queueController.refresh();
const saveGpu = queueController.patch({ useGpu: false });
const saveCrop = queueController.patch({ oversizeCropMode: 'expand' });
await tick(); assert.equal(writes.length, 1, 'settings patches are serialized');
server = { ...server, ...writes[0].patch }; writes[0].item.resolve({ settings: server }); await saveGpu; await tick();
assert.equal(writes.length, 2); assert.deepEqual(Object.keys(writes[0].patch), ['useGpu']); assert.deepEqual(Object.keys(writes[1].patch), ['oversizeCropMode']);
server = { ...server, ...writes[1].patch }; writes[1].item.resolve({ settings: server }); await saveCrop;
assert.deepEqual(queueController.getState().settings, { useGpu: false, oversizeCropMode: 'expand' }, 'the final queued input is persisted and remains visible');

const notices = [];
let failingServer = { useGpu: true, oversizeCropMode: 'face-centered' };
let failNext = true;
const failureController = createTeamSettingsController({ read: async () => ({ settings: failingServer }), merge: async patch => { if (failNext) { failNext = false; throw new Error('disk full'); } failingServer = { ...failingServer, ...patch }; return { settings: failingServer }; }, notice: message => notices.push(message) });
await failureController.refresh();
await assert.rejects(failureController.patch({ useGpu: false }), /disk full/);
assert.deepEqual(failureController.getState().settings, failingServer, 'failed writes re-read the authoritative settings');
await failureController.patch({ oversizeCropMode: 'expand' });
assert.equal(failureController.getState().settings.oversizeCropMode, 'expand', 'a failed write does not poison the following queue');
assert.equal(notices.length, 1);

let shared = { useGpu: true, oversizeCropMode: 'face-centered' };
const surface = () => createTeamSettingsController({ read: async () => ({ settings: shared }), merge: async patch => { shared = { ...shared, ...patch }; return { settings: shared }; } });
const surfaceA = surface(); const surfaceB = surface(); await Promise.all([surfaceA.refresh(), surfaceB.refresh()]);
await surfaceA.patch({ useGpu: false }); await surfaceB.patch({ oversizeCropMode: 'expand' });
await Promise.all([surfaceA.refresh(), surfaceB.refresh()]);
assert.deepEqual(surfaceA.getState().settings, shared); assert.deepEqual(surfaceB.getState().settings, shared, 'both renderer surfaces converge after activation refresh');

const actionNotices = [];
let uninstallRpcCalls = 0;
assert.equal(await runNotifiedAction('卸载增强版', async () => { const confirmed = false; if (!confirmed) return false; uninstallRpcCalls += 1; }, message => actionNotices.push(message)), false);
assert.deepEqual(actionNotices, [], 'cancelled lifecycle confirmation emits no success notice');
assert.equal(uninstallRpcCalls, 0);

const statusGuard = createLatestRequestGuard(); const oldStatus = statusGuard.begin(); statusGuard.invalidate();
assert.equal(statusGuard.isCurrent(oldStatus), false, 'a lifecycle result invalidates older advanced-status reads');
const activatedStatus = statusGuard.begin(); assert(statusGuard.isCurrent(activatedStatus), 'component activation starts the newest advanced-status generation');

console.log('Team settings state-machine tests passed');

