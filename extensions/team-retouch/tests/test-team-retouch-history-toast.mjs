import assert from 'node:assert/strict';
import { historyToastTransition } from '../renderer/src/history-toast-model.ts';

const key = 'team-retouch:history-load';
const failed = historyToastTransition({ previous: undefined, currentMessage: '历史读取失败', currentTone: 'error', inFlight: false, recoveredMessage: '历史已恢复', dedupeKey: key });
assert.deepEqual(failed.notice, { message: '历史读取失败', tone: 'error', dedupeKey: key });

const retrying = historyToastTransition({ previous: failed.next, currentMessage: '', currentTone: 'error', inFlight: true, recoveredMessage: '历史已恢复', dedupeKey: key });
assert.equal(retrying.notice, undefined, 'clearing React error state at retry start must not announce premature recovery');
assert.deepEqual(retrying.next, failed.next, 'the persistent toast snapshot remains until retry settles');

const recovered = historyToastTransition({ previous: retrying.next, currentMessage: '', currentTone: 'error', inFlight: false, recoveredMessage: '历史已恢复', dedupeKey: key });
assert.deepEqual(recovered.notice, { message: '历史已恢复', tone: 'success', dedupeKey: key }, 'successful retry replaces the persistent error using the same key');
assert.equal(recovered.next, undefined);

const warningKey = 'team-retouch:history-migration';
const paused = historyToastTransition({ previous: undefined, currentMessage: '迁移已暂停', currentTone: 'warning', inFlight: false, recoveredMessage: '迁移已恢复', dedupeKey: warningKey });
const resumed = historyToastTransition({ previous: paused.next, currentMessage: '', currentTone: 'info', inFlight: false, recoveredMessage: '迁移已恢复', dedupeKey: warningKey });
assert.deepEqual(resumed.notice, { message: '迁移已恢复', tone: 'success', dedupeKey: warningKey }, 'migration recovery replaces its persistent warning card');

console.log('Team-retouch history toast lifecycle tests passed');
