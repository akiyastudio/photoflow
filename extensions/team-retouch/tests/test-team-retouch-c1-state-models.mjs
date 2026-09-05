import assert from 'node:assert/strict';
import { hydrateLegacyWorkspace } from '../renderer/src/legacy/legacy-api.ts';
import { subjectsFromWorkspace } from '../renderer/src/interaction-model.ts';
import { acceptWorkspaceSnapshot, beginWorkspaceMutation, createWorkspaceScopeController, createWorkspaceState, settleWorkspaceMutation, switchWorkspaceScope } from '../renderer/src/legacy/workspace-state-model.ts';
import { createScopedPromiseCache } from '../renderer/src/legacy/scoped-promise-cache.ts';
import { idleWorkflowGeneration, reduceWorkflowGeneration } from '../renderer/src/legacy/workflow-generation-model.ts';
import { createScopedAsyncController } from '../renderer/src/legacy/scoped-async-action.ts';
import { runSequentialMergeBatch } from '../renderer/src/legacy/sequential-merge-batch.ts';
import { matchesCurrentEvent } from '../renderer/src/legacy/event-scope-model.ts';
import { navigationBlockedReason } from '../renderer/src/legacy/navigation-guard-model.ts';
import { createPhotoLoadToken, photoLoadKey } from '../renderer/src/legacy/photo-load-token.ts';
import { workspaceSeedScopeKey } from '../renderer/src/legacy/legacy-workspace-seed-model.ts';

const photo = (photoId, displayName) => ({ photoId, baseVersionId: `${photoId}-base`, displayName, relativePath: `${displayName}.jpg`, tasks: [{ id: `${photoId}-task`, members: [{ personIndex: 1 }], crop: {} }] });
const hydrated = hydrateLegacyWorkspace({ success: true, revision: '4', photos: [photo('p2', '乙'), photo('p1', '甲')], identities: [{ id: 'same', name: '同一人' }], assignments: [
  { photoId: 'p2', baseVersionId: 'p2-base', personIndex: 1, identityId: 'same', identityConfirmed: true },
  { photoId: 'p1', baseVersionId: 'p1-base', personIndex: 1, identityId: 'same', identityConfirmed: true },
] });
assert.deepEqual(hydrated.photos.map(item => item.displayName), ['乙', '甲']);
assert.deepEqual(subjectsFromWorkspace(hydrated).map(item => item.photo.displayName), ['乙', '甲']);
assert.throws(() => hydrateLegacyWorkspace({ photos: [{ ...photo('bad', '坏'), name: 'legacy' }], identities: [], assignments: [] }), /name 不是 current DTO/);

const largePhotos = Array.from({ length: 1_000 }, (_, photoIndex) => ({
  ...photo(`perf-${photoIndex}`, `性能-${photoIndex}`),
  tasks: Array.from({ length: 10 }, (_, taskIndex) => ({ id: `task-${photoIndex}-${taskIndex}`, members: [{ personIndex: taskIndex }], crop: {} })),
}));
const largeAssignments = largePhotos.flatMap(item => item.tasks.map((task, personIndex) => ({ photoId: item.photoId, baseVersionId: item.baseVersionId, personIndex, identityId: 'same', completed: true, completionKind: 'returned' })));
const hydrationStartedAt = performance.now();
const largeHydrated = hydrateLegacyWorkspace({ photos: largePhotos, identities: [{ id: 'same', name: '同一人' }], assignments: largeAssignments });
const hydrationElapsed = performance.now() - hydrationStartedAt;
assert.equal(largeHydrated.assignments.length, 10_000);
assert(hydrationElapsed < 500, `10k DTO hydration should stay near the 150ms target with CI margin; received ${hydrationElapsed.toFixed(1)}ms`);

let state = createWorkspaceState('A');
state = acceptWorkspaceSnapshot(state, 'A', { revision: 2, value: 'new' });
state = acceptWorkspaceSnapshot(state, 'A', { revision: 1, value: 'late' });
assert.equal(state.snapshot.value, 'new');
state = beginWorkspaceMutation(state);
state = acceptWorkspaceSnapshot(state, 'A', { revision: 4, value: 'latest' });
state = acceptWorkspaceSnapshot(state, 'A', { revision: 3, value: 'older' });
assert.equal(state.snapshot.value, 'new');
state = settleWorkspaceMutation(state);
assert.equal(state.snapshot.value, 'latest');
assert.equal(acceptWorkspaceSnapshot(switchWorkspaceScope(state, 'B'), 'A', { revision: 99 }).snapshot, undefined);
const wiredWorkspace = createWorkspaceScopeController('A', { revision: 100, label: 'A' });
assert.equal(wiredWorkspace.setScope('B').changed, true); assert.equal(wiredWorkspace.getState().snapshot, undefined, 'scope switch clears A synchronously before B data arrives');
assert.equal(wiredWorkspace.accept('B', { revision: 1, label: 'B' }), true); assert.equal(wiredWorkspace.getState().snapshot.label, 'B');
assert.equal(wiredWorkspace.accept('A', { revision: 101, label: 'late-A' }), false); assert.equal(wiredWorkspace.getState().snapshot.label, 'B', 'late A cannot enter B');
const mutationWorkspace = createWorkspaceScopeController('project', { revision: 5, label: 'before' });
mutationWorkspace.beginLoad('project'); mutationWorkspace.beginMutation('project');
assert.equal(mutationWorkspace.accept('project', { revision: 5, label: 'stale-read' }), false, 'reads remain hidden while a mutation is pending');
mutationWorkspace.commit('project', { revision: 6, label: 'renamed' }); mutationWorkspace.settleMutation('project');
assert.deepEqual(mutationWorkspace.getState().snapshot, { revision: 6, label: 'renamed' }, 'a stale N read cannot replace the committed N+1 mutation');
const failedMutation = createWorkspaceScopeController('project', { revision: 8, label: 'before-failure' });
failedMutation.beginMutation('project'); failedMutation.accept('project', { revision: 8, label: 'authoritative-rollback' });
assert.equal(failedMutation.settleMutation('project', false).snapshot.label, 'authoritative-rollback', 'a failed mutation may reveal an authoritative same-revision rollback');
assert.notEqual(workspaceSeedScopeKey('root', { id: 'same' }, { authoritativeGeneration: 'before-restore' }), workspaceSeedScopeKey('root', { id: 'same' }, { authoritativeGeneration: 'after-restore' }), 'same-project restore epochs create a fresh authoritative scope');

const cache = createScopedPromiseCache(10_000); let resolveA; let loads = 0;
cache.setScope('A'); const old = cache.get('query', () => new Promise(resolve => { loads += 1; resolveA = resolve; }));
cache.setScope('B'); const fresh = cache.get('query', async () => { loads += 1; return 'B'; });
resolveA('A'); assert.equal(await old, 'A'); assert.equal(await fresh, 'B'); assert.equal(await cache.get('query', async () => 'wrong'), 'B'); assert.equal(loads, 2);

const boundedCache = createScopedPromiseCache(1, 2); boundedCache.setScope('bounded');
await boundedCache.get('one', async () => 1); await new Promise(resolve => setTimeout(resolve, 2));
await boundedCache.get('two', async () => 2); await boundedCache.get('three', async () => 3);
let replacementReject; const rejectingCache = createScopedPromiseCache(10_000); rejectingCache.setScope('same');
const rejected = rejectingCache.get('key', () => new Promise((_, reject) => { replacementReject = reject; }));
rejectingCache.clear(); const replacement = rejectingCache.get('key', async () => 'replacement'); replacementReject(new Error('old failure'));
await assert.rejects(rejected, /old failure/); assert.equal(await replacement, 'replacement'); assert.equal(await rejectingCache.get('key', async () => 'wrong'), 'replacement', 'old rejection cannot clear a newer cache value');

let workflow = reduceWorkflowGeneration(idleWorkflowGeneration('A'), { projectId: 'A', operationId: 'op', state: 'running' }, 'start');
workflow = reduceWorkflowGeneration(workflow, { projectId: 'A', operationId: 'other', state: 'completed' }, 'event');
assert.equal(workflow.state, 'running');
workflow = reduceWorkflowGeneration(workflow, { projectId: 'A', operationId: 'op', requiresConfirmation: true }, 'rpc'); assert.equal(workflow.state, 'awaiting-confirmation');
workflow = reduceWorkflowGeneration(workflow, { projectId: 'A', operationId: 'op', cancelled: true }, 'rpc'); assert.equal(workflow.state, 'cancelled');

const asyncController = createScopedAsyncController('A'); let finalized = 0; let oldSuccess = 0; let release;
const pending = asyncController.run(() => new Promise(resolve => { release = resolve; }), { success: () => { oldSuccess += 1; }, finally: () => { finalized += 1; } });
asyncController.setScope('B'); release('old'); await pending; assert.equal(oldSuccess, 0); assert.equal(finalized, 0);
await assert.rejects(asyncController.run(async () => { throw 'boom'; }, { finally: () => { finalized += 1; } }), /boom/); assert.equal(finalized, 1); assert.equal(asyncController.isBusy(), false);

const visited = []; const batch = await runSequentialMergeBatch([1, 2, 3], async item => { visited.push(item); if (item === 2) return { success: false, error: 'second failed' }; return { success: true }; });
assert.deepEqual(visited, [1, 2, 3]); assert.deepEqual(batch.succeeded, [1, 3]); assert.equal(batch.failed[0].item, 2); assert.equal(batch.tone, 'warning');
assert.equal(matchesCurrentEvent({ projectId: 'A', operationId: 'op' }, { projectId: 'A', operationId: 'op' }, true), true);
assert.equal(matchesCurrentEvent({ operationId: 'op' }, { projectId: 'A', operationId: 'op' }, true), false);
assert.equal(matchesCurrentEvent({ projectId: 'A' }, { projectId: 'A', operationId: 'op' }, true), false);
assert.match(navigationBlockedReason([{ blocking: false, label: '后台生成' }, { blocking: true, label: '正在上传' }]), /正在上传/);

const token = createPhotoLoadToken(); const identity = { projectId: 'A', photoId: 'p', baseVersionId: 'v', relativePath: 'a.jpg', revision: 1 };
const first = token.begin(identity); assert.equal(token.isCurrent(first), true); assert.notEqual(photoLoadKey(identity), photoLoadKey({ ...identity, projectId: 'B' }));
token.begin({ ...identity, revision: 2 }); assert.equal(token.isCurrent(first), false);

console.log('Team-retouch C1 state model tests passed');
