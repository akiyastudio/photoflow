const assert = require('assert/strict');
const { createWorkspaceReconcileTask } = require('../electron/services/workspace-reconcile-task.cjs');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

(async () => {
  const workers = [];
  const deduped = new Map();
  let restartFactory;
  const backgroundTasks = {
    registerTypeRestartFactory: (_type, factory) => { restartFactory = factory; },
    run: (definition, work) => {
      if (deduped.has(definition.dedupeKey)) return deduped.get(definition.dedupeKey);
      const gate = deferred();
      const worker = { definition, gate };
      workers.push(worker);
      const promise = gate.promise.then(() => work({ report: () => {} }));
      deduped.set(definition.dedupeKey, promise);
      return promise;
    },
  };
  let reconcileCount = 0;
  const task = createWorkspaceReconcileTask({
    backgroundTasks,
    getWatchedWorkspacePath: () => '/workspace',
    getProjects: () => [],
    reconcileWorkspaceCatalog: async () => ({ projects: [], worker: ++reconcileCount }),
    writeLog: () => {},
  });
  assert.equal(typeof restartFactory, 'function');

  const oldRun = task.run('/workspace');
  assert.equal(workers.length, 1);
  assert.match(workers[0].definition.dedupeKey, /:0$/);
  task.reset();
  const newRun = task.run('/workspace');
  assert.equal(workers.length, 2, 'reset must use a new background-task dedupe generation while the old run is unsettled');
  assert.match(workers[1].definition.dedupeKey, /:1$/);

  workers[0].gate.resolve();
  const oldResult = await oldRun;
  assert.equal(oldResult.worker, 1);
  const joinedNewRun = task.run('/workspace');
  assert.equal(workers.length, 2, 'same-generation callers must join the keyed promise instead of starting or faking another worker');
  workers[1].gate.resolve();
  const [newResult, joinedResult] = await Promise.all([newRun, joinedNewRun]);
  assert.equal(newResult.worker, 2);
  assert.deepEqual(joinedResult, newResult);

  task.reset();
  const thirdRun = task.run('/workspace');
  assert.equal(workers.length, 3);
  assert.match(workers[2].definition.dedupeKey, /:2$/);
  workers[2].gate.resolve();
  await thirdRun;
  assert.equal(reconcileCount, 3, 'each generation must execute a real reconcile worker exactly once');
  console.log('workspace reconcile task tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
