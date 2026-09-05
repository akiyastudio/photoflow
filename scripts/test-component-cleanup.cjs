const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureComponentTreeIdentity, cleanupOwnedComponentPath, validateComponentCleanupReceipt } = require('../electron/component-package-archive.cjs');
const { componentTemporaryCleanupTargets, createDurableCleanupAdmission } = require('../electron/modules/system-ipc.cjs');
const { nodeIdentity } = require('../electron/services/component-transaction-service.cjs');
const makeTree = async target => {
  await fs.promises.mkdir(path.join(target, 'nested'), { recursive: true });
  await fs.promises.writeFile(path.join(target, 'a'), 'one');
  await fs.promises.writeFile(path.join(target, 'nested', 'b'), 'two');
  return { path: target, kind: 'directory', nodeIdentity: nodeIdentity(await fs.promises.lstat(target)), treeIdentity: await captureComponentTreeIdentity(target) };
};
const run = async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-component-cleanup-'));
  try {
    for (const crashPoint of ['cleanup:before-delete', 'cleanup:file-deleted', 'cleanup:directory-deleted', 'cleanup:after-delete']) {
      const receipt = await makeTree(path.join(root, crypto.randomUUID()));
      let persisted = false;
      let fired = false;
      await assert.rejects(cleanupOwnedComponentPath(receipt, { root, beforeDelete: async () => { persisted = true; }, fault: async point => {
        assert(persisted, 'deletion starts only after durable admission');
        if (!fired && point === crashPoint) { fired = true; throw new Error('crash'); }
      } }), /crash/);
      await cleanupOwnedComponentPath(receipt, { root, allowPartial: true, allowMissing: true });
      assert.equal(fs.existsSync(receipt.path), false);
      assert.equal((await cleanupOwnedComponentPath(receipt, { root, allowPartial: true, allowMissing: true })).alreadyMissing, true);
    }
    const unavailable = await makeTree(path.join(root, 'not-admitted'));
    await assert.rejects(cleanupOwnedComponentPath(unavailable, { root, beforeDelete: async () => { throw new Error('cannot persist'); } }), /cannot persist/);
    assert.equal(fs.readFileSync(path.join(unavailable.path, 'a'), 'utf8'), 'one');
    const edited = await makeTree(path.join(root, 'edited-after-preflight'));
    await assert.rejects(cleanupOwnedComponentPath(edited, { root, beforeDelete: () => fs.promises.writeFile(path.join(edited.path, 'a'), 'new') }), /内容发生变化/);
    assert.equal(fs.readFileSync(path.join(edited.path, 'a'), 'utf8'), 'new', 'a same-size edit made during cleanup is preserved');
    for (const change of ['added', 'changed', 'replaced', 'missing', 'root-replaced', 'link']) {
      const receipt = await makeTree(path.join(root, change));
      const target = path.join(receipt.path, 'a');
      if (change === 'added') await fs.promises.writeFile(path.join(receipt.path, 'user-file'), 'preserve');
      if (change === 'changed') await fs.promises.writeFile(target, 'new');
      if (change === 'replaced') { await fs.promises.rename(target, path.join(root, 'displaced-file')); await fs.promises.writeFile(target, 'one'); }
      if (change === 'missing') await fs.promises.unlink(target);
      if (change === 'root-replaced') { await fs.promises.rename(receipt.path, `${receipt.path}.original`); await makeTree(receipt.path); }
      if (change === 'link') {
        const outside = path.join(root, 'outside-link-target'); await fs.promises.mkdir(outside);
        await fs.promises.writeFile(path.join(outside, 'precious'), 'preserve');
        await fs.promises.symlink(outside, path.join(receipt.path, 'link'), 'junction');
      }
      await assert.rejects(cleanupOwnedComponentPath(receipt, { root }), /收据|身份|符号链接|发生变化/);
      assert(fs.existsSync(path.join(receipt.path, 'nested', 'b')), 'preflight failure deletes nothing');
    }
    const outside = await makeTree(path.join(root, 'outside'));
    const managed = path.join(root, 'managed'); await fs.promises.mkdir(managed);
    await assert.rejects(cleanupOwnedComponentPath(outside, { root: managed }), /越过/);
    await assert.rejects(cleanupOwnedComponentPath({ ...outside, path: root }, { root }), /越过/);
    const parentLink = path.join(root, 'parent-link'); await fs.promises.symlink(outside.path, parentLink, 'junction');
    await assert.rejects(cleanupOwnedComponentPath({ ...outside, path: path.join(parentLink, 'nested') }, { root }), /链接/);
    const invalidTree = { ...outside, treeIdentity: [...outside.treeIdentity, outside.treeIdentity[0]] };
    assert.throws(() => validateComponentCleanupReceipt(invalidTree), /重复/);

    // Only application-created scratch directories may use compact ownership.
    // A large extraction never inserts its file list into background-task history.
    const temporary = path.join(root, `photoflow-component-package-fixture-${crypto.randomUUID()}`);
    const scratch = await makeTree(temporary);
    scratch.treeIdentity = Array.from({ length: 20000 }, () => scratch.treeIdentity[0]);
    const compact = componentTemporaryCleanupTargets({ path, tempRoot: root, installRoot: managed, receipts: [scratch, scratch] });
    assert.equal(compact.length, 1);
    assert(JSON.stringify(compact).length < 1024);
    assert.throws(() => validateComponentCleanupReceipt(compact[0]), /收据/);
    for (const wrongPath of [root, outside.path, path.join(managed, 'fixture', 'runtime'), path.join(root, 'user-data')]) {
      assert.throws(() => componentTemporaryCleanupTargets({ path, tempRoot: root, installRoot: managed, receipts: [{ ...scratch, path: wrongPath }] }), /只允许/);
    }
    await cleanupOwnedComponentPath(compact[0], { root, disposable: true, allowPartial: true, allowMissing: true });
    assert.equal(fs.existsSync(temporary), false);
    const tasks = [];
    const admission = createDurableCleanupAdmission({ start: worker => { const pending = Promise.resolve().then(() => worker({})); tasks.push(pending); return pending; }, flush: () => false, worker: () => { throw new Error('must never delete'); }, receipts: compact });
    assert.equal(admission.admitted, false);
    await assert.rejects(admission.completion, /持久 admission/);
    assert(!(await fs.promises.readdir(root)).some(name => name.includes('.cleanup-')), 'cleanup creates no proof files');
    console.log('Component receipt cleanup and temporary ownership tests passed');
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
};
run().catch(error => { console.error(error); process.exitCode = 1; });
