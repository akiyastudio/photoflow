import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTeamRevisionCoordinator, isTeamRevisionConflict, retryOnceAfterRevisionConflict, TEAM_REVISION_MUTATIONS } from '../renderer/src/legacy/legacy-revision-model.ts';

const service = fs.readFileSync(new URL('../service.cjs', import.meta.url), 'utf8');
const guardedBlock = service.match(/const MUTATING_METHODS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
const guardedServiceMethods = [...guardedBlock.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
assert.deepEqual([...TEAM_REVISION_MUTATIONS].sort(), guardedServiceMethods, 'renderer and service mutation surfaces must remain identical');

const coordinator = createTeamRevisionCoordinator();
coordinator.setScope('project-a');
await coordinator.run('team.project.get.v1', undefined, async () => ({ revision: '5' }));
assert.equal(coordinator.revision(), 5, 'workspace reads seed the shared project revision');

await coordinator.run('team.project.get.v1', undefined, async () => ({ revision: '4' }));
assert.equal(coordinator.revision(), 5, 'a late stale response cannot move the revision cache backwards');

let releaseFirst;
const requests = [];
const first = coordinator.run('team.workflow.return-confirm.v1', { returnId: 'a' }, request => new Promise(resolve => {
  requests.push(request);
  releaseFirst = () => resolve({ success: true, revision: '6' });
}));
const second = coordinator.run('team.workflow.reconcile-drain.v1', {}, async request => {
  requests.push(request);
  return { success: true, revision: '7' };
});
await Promise.resolve();
assert.equal(requests.length, 1, 'same-project mutations are serialized');
assert.equal(requests[0].expectedRevision, '5');
releaseFirst();
await first;
await second;
assert.equal(requests[1].expectedRevision, '6', 'queued mutations use the revision current at execution time');
assert.equal(coordinator.revision(), 7);

coordinator.setScope('project-b');
await coordinator.run('team.project.get.v1', undefined, async () => ({ revision: '2' }));
assert.equal(coordinator.revision(), 2, 'revision state is isolated by project');
assert.equal(coordinator.revision('project-a'), 7);

coordinator.setScope('switch-a');
await coordinator.run('team.project.get.v1', undefined, async () => ({ revision: '1' }));
let releaseRunning;
let queuedInvoked = false;
const runningBeforeSwitch = coordinator.run('team.identity.save.v1', {}, () => new Promise(resolve => { releaseRunning = () => resolve({ success: true, revision: '2' }); }));
const queuedBeforeSwitch = coordinator.run('team.identity.assign.v1', {}, async () => { queuedInvoked = true; return { success: true, revision: '3' }; });
await Promise.resolve();
coordinator.setScope('switch-b');
releaseRunning();
await runningBeforeSwitch;
await assert.rejects(queuedBeforeSwitch, /项目已切换/, 'a queued mutation is cancelled rather than sent through the next project context');
assert.equal(queuedInvoked, false);

let attempts = 0;
let refreshes = 0;
const recovered = await retryOnceAfterRevisionConflict(async () => {
  attempts += 1;
  if (attempts === 1) throw new Error('图片数据已被其他操作更新，请刷新后重试');
  return 'confirmed';
}, async () => { refreshes += 1; });
assert.equal(recovered, 'confirmed');
assert.equal(attempts, 2, 'confirmation retries exactly once after a revision conflict');
assert.equal(refreshes, 1);
assert.equal(isTeamRevisionConflict(new Error('团片数据已被其他操作更新，请刷新后重试')), true);

let repeatedConflictAttempts = 0;
await assert.rejects(
  retryOnceAfterRevisionConflict(async () => { repeatedConflictAttempts += 1; throw new Error('团片数据已被其他操作更新，请刷新后重试'); }, async () => undefined),
  /已被其他操作更新/,
  'a second conflict is surfaced instead of entering an unsafe retry loop',
);
assert.equal(repeatedConflictAttempts, 2);

await assert.rejects(
  retryOnceAfterRevisionConflict(async () => { throw new Error('候选任务当前不可确认'); }, async () => { refreshes += 1; }),
  /候选任务当前不可确认/,
  'business validation errors are never retried',
);
assert.equal(refreshes, 1);

for (const method of ['team.project.migrate-step.v1', 'team.project.calibrate-step.v1', 'team.workflow.reconcile-drain.v1', 'team.workflow.return-confirm.v1', 'team.operation.run.v1']) {
  assert.equal(TEAM_REVISION_MUTATIONS.has(method), true, `${method} must participate in the shared mutation queue`);
}

console.log('Team-retouch shared revision coordinator tests passed');
