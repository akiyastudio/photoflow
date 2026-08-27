const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const compile = relativePath => ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const load = (relativePath, dependencies = {}) => {
  const module = { exports: {} };
  const localRequire = request => {
    if (request in dependencies) return dependencies[request];
    throw new Error(`unexpected renderer-model dependency: ${request}`);
  };
  new Function('require', 'module', 'exports', compile(relativePath))(localRequire, module, module.exports);
  return module.exports;
};

const toastModel = load('src/features/background-tasks/task-toast-model.ts');
const streamModel = load('src/features/background-tasks/background-task-stream-model.ts', {
  './task-toast-model': toastModel,
});

const task = (id, state = 'failed', updatedAt = 1, extra = {}) => ({
  id, type: 'test', title: id, state, progress: state === 'completed' ? 100 : 0, message: '',
  cancellable: false, retryable: state === 'failed', resumable: false, resumeAvailable: false,
  restartAvailable: false, capabilities: { cancellable: false, pausable: false, resumable: false, retryable: state === 'failed' },
  resumePolicy: 'atomic', notificationPolicy: 'error-only', taskCenterPolicy: 'always', historyPolicy: 'persistent', retryAttempt: 0,
  retryPending: false, metadata: {}, createdAt: updatedAt, updatedAt, startedAt: 0, finishedAt: updatedAt,
  ...extra,
});
const delta = (revision, upserts = [], removeIds = []) => ({ revision, upserts, removeIds });

const localTimestamp = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute).getTime();
const referenceTime = localTimestamp(2026, 8, 25, 18, 0);
assert.equal(toastModel.formatBackgroundTaskStartedAt(localTimestamp(2026, 8, 25, 9, 5), referenceTime), '09:05', 'tasks started today must show only the local clock time');
assert.equal(toastModel.formatBackgroundTaskStartedAt(localTimestamp(2026, 8, 24, 23, 7), referenceTime), '08/24 23:07', 'tasks started on another day this year must include month and day');
assert.equal(toastModel.formatBackgroundTaskStartedAt(localTimestamp(2025, 12, 31, 23, 59), referenceTime), '2025/12/31 23:59', 'tasks started in another year must include the year');
assert.equal(toastModel.formatBackgroundTaskStartedAt(0, referenceTime), '', 'queued tasks and legacy records without a start time must not render a fake date');
assert.equal(toastModel.formatBackgroundTaskStartedAt(Number.NaN, referenceTime), '', 'invalid start times must be ignored safely');

const indicatorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'background-tasks', 'BackgroundTaskIndicator.tsx'), 'utf8');
assert((indicatorSource.match(/formatBackgroundTaskStartedAt\(task\.startedAt\)/g) || []).length >= 2 && !indicatorSource.includes('开始时间'), 'every task card must render its start timestamp beside the status without an extra label');

let state = streamModel.initialBackgroundTaskStreamState();
state = streamModel.receiveBackgroundTaskDelta(state, delta(5, [task('new', 'running', 5)]));
assert.equal(state.hydrated, false);
state = streamModel.receiveBackgroundTaskSnapshot(state, { revision: 4, tasks: [task('old-a'), task('old-b')] });
assert.equal(state.revision, 5);
assert.deepEqual(new Set(state.tasks.map(item => item.id)), new Set(['old-a', 'old-b', 'new']), 'a delta arriving before the snapshot must replay over the complete snapshot');

state = streamModel.receiveBackgroundTaskDelta(state, delta(7, [task('gap', 'running', 7)]));
assert.equal(state.hydrated, false, 'a revision gap must request a fresh snapshot instead of applying incomplete history');
assert.equal(state.bufferedDeltas[0].revision, 7);
state = streamModel.receiveBackgroundTaskSnapshot(state, { revision: 6, tasks: [task('server', 'running', 6)] });
assert.equal(state.hydrated, true);
assert.equal(state.revision, 7);
assert.deepEqual(new Set(state.tasks.map(item => item.id)), new Set(['server', 'gap']));
assert.strictEqual(streamModel.receiveBackgroundTaskDelta(state, delta(7, [task('duplicate')])), state, 'duplicate revisions must be ignored');

state = streamModel.receiveBackgroundTaskDelta(state, delta(8, [task('replacement', 'completed', 8, { retryOfTaskId: 'server' })], ['server']));
assert(!state.tasks.some(item => item.id === 'server'), 'atomic remove/upsert deltas must remove the superseded task');
assert.deepEqual(new Set(state.tasks.map(item => item.id)), new Set(['gap', 'replacement']), 'atomic replacement must preserve unrelated tasks');

const history = Array.from({ length: 205 }, (_, index) => task(`history-${index}`, 'failed', index));
const normalized = toastModel.normalizeBackgroundTaskSnapshots([
  task('active', 'running', 999),
  task('silent', 'failed', 1000, { historyPolicy: 'ephemeral' }),
  ...history,
]);
assert.equal(normalized.length, 200);
assert(normalized.some(item => item.id === 'active'));
assert(!normalized.some(item => item.id === 'silent'));
assert(!normalized.some(item => item.id === 'history-0'));

const predecessor = task('predecessor', 'failed', 1, { retryPending: true, replacedByTaskId: 'retry' });
const replacement = task('retry', 'running', 2, { retryOfTaskId: 'predecessor' });
assert.deepEqual(toastModel.collapseRetryPredecessors([predecessor, replacement]).map(item => item.id), ['retry']);

assert.equal(toastModel.isBackgroundTaskCenterVisible(task('automatic-running', 'running', 3, { taskCenterPolicy: 'attention-only' })), false, 'routine automatic work must stay out of the task center while healthy');
assert.equal(toastModel.isBackgroundTaskCenterVisible(task('automatic-failed', 'failed', 4, { taskCenterPolicy: 'attention-only' })), true, 'automatic failures must remain visible and retryable');
assert.equal(toastModel.isBackgroundTaskCenterVisible(task('automatic-interrupted', 'interrupted', 5, { taskCenterPolicy: 'attention-only' })), false, 'safe-restart automatic work must remain quiet while it is being recovered');
assert.equal(toastModel.isBackgroundTaskCenterVisible(task('hidden-failed', 'failed', 5, { taskCenterPolicy: 'hidden' })), false, 'hidden tasks must never enter the task center');
assert.equal(toastModel.isBackgroundTaskCenterVisible(task('manual-running', 'running', 6, { type: 'cache-cleanup', notificationPolicy: 'result-only' })), true, 'manual maintenance must continue to expose progress');

const moveRunning = task('move-toast', 'running', 100, { type: 'project-file-operation', notificationPolicy: 'progress-and-result' });
const moveCompleted = task('move-toast', 'completed', 110, { type: 'project-file-operation', notificationPolicy: 'progress-and-result', message: '文件移动完成' });
assert.equal(toastModel.isActiveProjectFileTask(moveRunning, 100), true, 'combined project-file notification must show progress while running');
assert.equal(toastModel.taskToastExpiresAt(moveCompleted), 6110, 'combined project-file completion must remain visible for the result interval');
assert.equal(toastModel.isActiveProjectFileTask(moveCompleted, 6109), true, 'combined project-file completion remains visible before expiry');
assert.equal(toastModel.isActiveProjectFileTask(moveCompleted, 6110), false, 'combined project-file completion expires at the result deadline');
assert.equal(toastModel.isActiveProjectFileTask(task('progress-complete', 'completed', 110, { notificationPolicy: 'progress-toast' }), 111), false, 'progress-only tasks must not gain a terminal result toast');
assert.equal(toastModel.isActiveProjectFileTask(task('result-running', 'running', 110, { notificationPolicy: 'result-only' }), 111), false, 'result-only tasks stay hidden while running');
assert.equal(toastModel.isActiveProjectFileTask(task('result-complete', 'completed', 110, { notificationPolicy: 'result-only' }), 111), true, 'result-only tasks retain their completion toast');

let transition = streamModel.receiveBackgroundTaskSnapshot(streamModel.initialBackgroundTaskStreamState(), { revision: 20, tasks: [moveRunning] });
transition = streamModel.receiveBackgroundTaskDelta(transition, delta(21, [moveCompleted]));
assert.equal(transition.tasks.length, 1, 'running-to-completed task updates replace the same task identity');
assert.deepEqual(toastModel.selectProjectFileTaskToasts(transition.tasks, new Set(), 4, 111).visible.map(item => item.id), ['move-toast'], 'the progress card must become exactly one completion card');

let fastCompletion = streamModel.receiveBackgroundTaskSnapshot(streamModel.initialBackgroundTaskStreamState(), { revision: 30, tasks: [] });
fastCompletion = streamModel.receiveBackgroundTaskDelta(fastCompletion, delta(31, [task('fast-move', 'completed', 120, { type: 'project-file-operation', notificationPolicy: 'progress-and-result', message: '文件移动完成' })]));
assert.deepEqual(toastModel.selectProjectFileTaskToasts(fastCompletion.tasks, new Set(), 4, 121).visible.map(item => item.id), ['fast-move'], 'a move completing before any progress paint must still show one result toast');

console.log('background task renderer model tests passed');
