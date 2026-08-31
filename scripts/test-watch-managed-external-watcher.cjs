const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createManagedExternalWatcherBindings } = require('../electron/modules/workspace/managed-external-watcher.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-managed-watcher-'));
try {
  const projectRoot = path.join(root, 'status', 'project');
  const oldTarget = path.join(root, 'old-target');
  const newTarget = path.join(root, 'new-target');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(oldTarget);
  fs.mkdirSync(newTarget);
  const key = 'project-key';
  const makeBinding = target => ({ root: target, options: { publishRoot: root, virtualPrefix: 'status/project/link', onChanged: () => {} } });
  const bindings = [makeBinding(oldTarget)];
  const watchedProjectFileRoots = new Map([[key, bindings]]);
  const acquired = [];
  const released = [];
  let releaseMode = 'success';
  const manager = createManagedExternalWatcherBindings({
    fs, path,
    ensureWorkspace: value => value,
    getProjectPath: () => projectRoot,
    watchedProjectFileRoots,
    watchedProjectFileRootKey: () => key,
    acquireFileRootWatcher: (watchRoot, options) => { acquired.push({ root: watchRoot, options }); return { success: true }; },
    releaseFileRootWatcher: (watchRoot, options) => {
      released.push({ root: watchRoot, options });
      if (releaseMode === 'missing') return { success: false, missing: true, stale: true };
      if (releaseMode === 'failure') return { success: false, error: 'release failed' };
      return undefined;
    },
    externalTrackingChangeHandler: () => () => {},
    writeLog: () => {},
  });

  releaseMode = 'missing';
  const staleDifferent = bindings[0];
  assert.equal(manager.attach(root, 'status', 'project', projectRoot, 'link', newTarget).success, true);
  assert.equal(path.resolve(bindings[0].root), path.resolve(newTarget));
  assert.equal(bindings.includes(staleDifferent), false, 'missing stale binding must be removed from managed bookkeeping');
  assert.equal(released.some(item => path.resolve(item.root) === path.resolve(newTarget)), false, 'stale cleanup must not release the newly acquired healthy target');

  released.length = 0;
  const staleSame = makeBinding(newTarget);
  bindings.splice(0, bindings.length, staleSame);
  assert.equal(manager.attach(root, 'status', 'project', projectRoot, 'link', newTarget).success, true);
  assert.equal(bindings.length, 1);
  assert.notEqual(bindings[0], staleSame, 'same-target stale binding must be replaced by fresh bookkeeping');
  assert.equal(released.length, 1, 'only the stale logical release should be attempted');

  releaseMode = 'failure';
  released.length = 0;
  const workingOld = makeBinding(oldTarget);
  bindings.splice(0, bindings.length, workingOld);
  const failed = manager.attach(root, 'status', 'project', projectRoot, 'link', newTarget);
  assert.equal(failed.success, false);
  assert.equal(bindings[0], workingOld, 'a real release failure must retain prior bookkeeping');
  assert.equal(released.some(item => path.resolve(item.root) === path.resolve(newTarget)), true, 'real replacement failure must roll back the newly acquired binding');

  releaseMode = 'missing';
  manager.detach(root, 'status', 'project', 'link');
  assert.equal(bindings.length, 0, 'detach must prune an already-missing stale binding');
  console.log('managed external watcher tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
