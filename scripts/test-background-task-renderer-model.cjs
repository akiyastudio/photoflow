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
  resumePolicy: 'atomic', notificationPolicy: 'error-only', historyPolicy: 'persistent', retryAttempt: 0,
  retryPending: false, metadata: {}, createdAt: updatedAt, updatedAt, startedAt: 0, finishedAt: updatedAt,
  ...extra,
});
const delta = (revision, upserts = [], removeIds = []) => ({ revision, upserts, removeIds });

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

console.log('background task renderer model tests passed');
