const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../src/features/versioning/progress-relation-mutation-queue.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleValue = { exports: {} };
new Function('module', 'exports', 'require', compiled)(moduleValue, moduleValue.exports, require);
const { ProgressRelationMutationQueue } = moduleValue.exports;

(async () => {
  const queue = new ProgressRelationMutationQueue();
  let revision = 1;
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const events = [];
  const first = queue.enqueue('child', async () => {
    const expectedRevision = revision;
    events.push(`first:start:${expectedRevision}`);
    await firstGate;
    revision += 1;
    events.push(`first:end:${revision}`);
    return revision;
  });
  const second = queue.enqueue('child', async () => {
    const expectedRevision = revision;
    events.push(`second:start:${expectedRevision}`);
    assert.strictEqual(expectedRevision, 2, 'queued mutation must read the revision produced by its predecessor');
    revision += 1;
    events.push(`second:end:${revision}`);
    return revision;
  });
  assert(queue.isPending('child'), 'child must remain busy while mutations are queued');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(events, ['first:start:1'], 'second mutation must not start before the first completes');
  releaseFirst();
  assert.deepStrictEqual(await Promise.all([first, second]), [2, 3]);
  await new Promise(resolve => setImmediate(resolve));
  assert(!queue.isPending('child'), 'child must leave the busy set after the queue drains');

  let releaseA;
  const gateA = new Promise(resolve => { releaseA = resolve; });
  let otherStarted = false;
  const childA = queue.enqueue('a', async () => { await gateA; });
  const childB = queue.enqueue('b', async () => { otherStarted = true; });
  await childB;
  assert(otherStarted, 'different child IDs must not block each other');
  releaseA();
  await childA;

  const disposableQueue = new ProgressRelationMutationQueue();
  let releaseDisposing;
  const disposingGate = new Promise(resolve => { releaseDisposing = resolve; });
  let staleCallbackRan = false;
  const disposingGeneration = disposableQueue.captureGeneration();
  const activeAtDispose = disposableQueue.enqueue('closing-page', async () => { await disposingGate; });
  const queuedAtDispose = disposableQueue.enqueue('closing-page', async () => { throw new Error('queued mutation must not start after dispose'); });
  await new Promise(resolve => setImmediate(resolve));
  disposableQueue.dispose();
  releaseDisposing();
  await assert.rejects(activeAtDispose, /progress_relation_mutation_queue_disposed/);
  await assert.rejects(queuedAtDispose, /progress_relation_mutation_queue_disposed/);
  assert.strictEqual(disposableQueue.runIfCurrent(disposingGeneration, () => { staleCallbackRan = true; }), false, 'disposed pages must reject stale UI callbacks');
  assert.strictEqual(staleCallbackRan, false, 'disposed pages must not run stale notifications or state updates');
  assert.strictEqual(disposableQueue.isPending('closing-page'), false, 'dispose must clear page-owned pending relation state');

  console.log('progress relation mutation queue tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
