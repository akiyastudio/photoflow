import assert from 'node:assert/strict';
import { prepareAndOpenWorkflowTaskFolder } from '../renderer/src/legacy/legacy-task-folder-model.ts';

let openCalls = 0;
const drainLimits = [];
let preparingNotices = 0;
const recovered = await prepareAndOpenWorkflowTaskFolder({
  open: async () => ++openCalls < 3 ? { success: true, state: 'preparing', pendingCount: 8 } : { success: true, count: 8 },
  drain: async maxItems => { drainLimits.push(maxItems); return { success: true, state: 'preparing', recoveredCount: 8 }; },
  onPreparing: () => { preparingNotices += 1; },
});
assert.equal(recovered.result.count, 8);
assert.equal(recovered.preparationAttempted, true);
assert.equal(recovered.attempts, 2);
assert.deepEqual(drainLimits, [20, 20]);
assert.equal(preparingNotices, 1, 'folder recovery announces preparation once instead of stacking one toast per pass');

let stalledOpenCalls = 0;
const stalled = await prepareAndOpenWorkflowTaskFolder({
  open: async () => { stalledOpenCalls += 1; return { success: true, state: 'preparing', pendingCount: 80 }; },
  drain: async maxItems => ({ success: true, state: 'preparing', recoveredCount: 0, requested: maxItems, error: '等待重试' }),
});
assert.equal(stalledOpenCalls, 2, 'a stalled reconcile stops instead of repeatedly re-queuing the same folder');
assert.equal(stalled.reconciliation.requested, 50);
assert.equal(stalled.result.state, 'preparing');

let readyDrainCalls = 0;
const ready = await prepareAndOpenWorkflowTaskFolder({
  open: async () => ({ success: true, count: 4 }),
  drain: async () => { readyDrainCalls += 1; return {}; },
});
assert.equal(ready.result.count, 4);
assert.equal(ready.preparationAttempted, false);
assert.equal(readyDrainCalls, 0, 'an already materialized folder opens without background maintenance');

console.log('Team-retouch task-folder recovery tests passed');
