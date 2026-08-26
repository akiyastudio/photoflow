const assert = require('assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { probeManyIndividually } = require('../electron/services/recycle-bin-service.cjs');
const { createFileSystemService } = require('../electron/services/file-system-service.cjs');

const run = async () => {
  const result = await probeManyIndividually(['broken', 'valid'], async pidl => {
    if (pidl === 'broken') throw new Error('invalid PIDL');
    return { success: true, exists: true, name: 'valid item' };
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.items[0], { success: false, exists: false, pidl: 'broken', error: 'invalid PIDL' });
  assert.equal(result.items[1].pidl, 'valid');
  assert.equal(result.items[1].exists, true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-trash-journal-')); let trashCalls = 0;
  try {
    const target = path.join(root, 'target.txt'); const journalPath = path.join(root, 'journal', 'trash.json'); fs.writeFileSync(target, 'target');
    const fileSystem = createFileSystemService({ fs, recycleBinService: { trashMany: async targets => { trashCalls += 1; targets.forEach(item => fs.rmSync(item)); return { success: true, items: [{ success: true, recyclePidl: 'pidl', preciseRestore: true }] }; }, trash: async () => undefined, restore: async () => undefined, probe: async () => undefined } });
    const first = await fileSystem.trashManyJournaled({ targetPaths: [target], journalPath }); const repeated = await fileSystem.trashManyJournaled({ targetPaths: [target], journalPath });
    assert.deepEqual(repeated, first); assert.equal(trashCalls, 1, 'applied recycle command journal prevents a duplicate OS trash operation after caller crash');
    const replaceTarget = path.join(root, 'replace.txt'); const replaceJournal = path.join(root, 'journal', 'replace.json'); fs.writeFileSync(replaceTarget, 'replace'); const prepared = { schemaVersion: 1, kind: 'file-operations-trash-v1', state: 'prepared', targets: [path.resolve(replaceTarget)], createdAt: Date.now() }; fs.writeFileSync(replaceJournal, JSON.stringify(prepared)); let injectReplaceFailure = true;
    const failingJournalService = createFileSystemService({ fs, journalFaultInjector: async stage => { if (stage === 'after-backup-before-replace' && injectReplaceFailure) { injectReplaceFailure = false; throw new Error('injected journal replace failure'); } }, recycleBinService: { trashMany: async () => { throw new Error('OS trash must not run before executing journal is durable'); }, trash: async () => undefined, restore: async () => undefined, probe: async () => undefined } });
    await assert.rejects(failingJournalService.trashManyJournaled({ targetPaths: [replaceTarget], journalPath: replaceJournal }), /injected journal replace failure/); assert.deepEqual(JSON.parse(fs.readFileSync(replaceJournal, 'utf8')), prepared, 'failed atomic replacement restores the previous durable journal');
    const missingTarget = path.join(root, 'already-missing.txt'); const unknownJournal = path.join(root, 'journal', 'unknown.json'); fs.writeFileSync(unknownJournal, JSON.stringify({ schemaVersion: 1, kind: 'file-operations-trash-v1', state: 'executing', targets: [path.resolve(missingTarget)], createdAt: Date.now() })); const callsBeforeUnknown = trashCalls; const unknown = await fileSystem.trashManyJournaled({ targetPaths: [missingTarget], journalPath: unknownJournal }); assert.equal(unknown.outcomeUnknown, true); assert.equal(trashCalls, callsBeforeUnknown, 'executing journal with a missing source never repeats the OS trash command');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  process.stdout.write('Recycle-bin batch probe tests passed.\n');
};

run().catch(error => { console.error(error); process.exitCode = 1; });
