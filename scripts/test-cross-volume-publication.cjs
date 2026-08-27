const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { configureNativePublicationService, moveFileAtomic, movePathAtomic } = require('../electron/services/file-transfer-service.cjs');
const { createFilePublicationService } = require('../electron/services/file-publication-service.cjs');

const run = async () => {
  if (process.platform !== 'win32' || !fs.existsSync('D:\\')) {
    console.log('cross-volume publication test skipped: Windows C:/D: volumes unavailable');
    return;
  }
  const id = crypto.randomUUID();
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-cross-volume-'));
  const targetRoot = path.resolve('D:\\PhotoFlowCrossVolumeTests', id);
  if (!targetRoot.toLocaleLowerCase().startsWith(path.resolve('D:\\PhotoFlowCrossVolumeTests').toLocaleLowerCase() + path.sep)) throw new Error('unsafe cross-volume test path');
  fs.mkdirSync(targetRoot, { recursive: true });
  try {
    const nativePublication = createFilePublicationService({ app: { isPackaged: false }, projectRoot: path.resolve(__dirname, '..') });
    configureNativePublicationService(nativePublication);
    const source = path.join(sourceRoot, 'source.txt');
    const target = path.join(targetRoot, 'source.txt');
    fs.writeFileSync(source, 'real C to D publication');
    const result = await moveFileAtomic(source, target);
    assert.strictEqual(result.copied, true);
    assert.strictEqual(fs.existsSync(source), false);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'real C to D publication');

    const conflictSource = path.join(sourceRoot, 'conflict.txt');
    const conflictTarget = path.join(targetRoot, 'conflict.txt');
    fs.writeFileSync(conflictSource, 'source retained on conflict');
    fs.writeFileSync(conflictTarget, 'unknown D occupant');
    await assert.rejects(moveFileAtomic(conflictSource, conflictTarget), error => error.code === 'EEXIST');
    assert.strictEqual(fs.readFileSync(conflictSource, 'utf8'), 'source retained on conflict');
    assert.strictEqual(fs.readFileSync(conflictTarget, 'utf8'), 'unknown D occupant');

    const cancelSource = path.join(sourceRoot, 'cancel.txt');
    const cancelTarget = path.join(targetRoot, 'cancel.txt');
    fs.writeFileSync(cancelSource, 'cancelled source');
    let cancelled = false; let fullReports = 0;
    await assert.rejects(moveFileAtomic(cancelSource, cancelTarget, { isCancelled: () => cancelled, onProgress: value => { if (value.bytesCopied === value.totalBytes && ++fullReports >= 2) cancelled = true; } }), error => error.code === 'EOPCANCELLED');
    assert.strictEqual(fs.readFileSync(cancelSource, 'utf8'), 'cancelled source');
    assert.strictEqual(fs.existsSync(cancelTarget), false, 'native compare-delete removes only the owned staging target on cancellation');

    const compareTarget = path.join(targetRoot, 'compare-delete.txt');
    fs.writeFileSync(compareTarget, 'unknown compare target');
    const compareIdentity = (await nativePublication.inspectPath(compareTarget)).identity;
    await assert.rejects(nativePublication.compareDeleteFile({ target: compareTarget, sha256: '0'.repeat(64), size: fs.statSync(compareTarget).size, identity: compareIdentity }));
    assert.strictEqual(fs.readFileSync(compareTarget, 'utf8'), 'unknown compare target', 'native compare-delete preserves a target with the wrong digest');

    const lockedSource = path.join(sourceRoot, 'locked-source.txt');
    const lockedStaged = path.join(targetRoot, '.locked-staged.txt');
    const lockedTarget = path.join(targetRoot, 'locked-target.txt');
    fs.writeFileSync(lockedSource, 'expected locked content');
    fs.writeFileSync(lockedStaged, 'expected locked content');
    const expectedBytes = fs.readFileSync(lockedStaged);
    const expectedSha = crypto.createHash('sha256').update(expectedBytes).digest('hex');
    const lockedIdentity = (await nativePublication.inspectPath(lockedSource)).identity;
    const retainedLockedSource = `${lockedSource}.original`; fs.renameSync(lockedSource, retainedLockedSource); fs.writeFileSync(lockedSource, expectedBytes);
    await assert.rejects(nativePublication.commitCrossVolumeFile({ source: lockedSource, staged: lockedStaged, target: lockedTarget, sha256: expectedSha, size: expectedBytes.length, sourceIdentity: lockedIdentity }), error => error.code === 'PUBLISH_OWNERSHIP_CONFLICT');
    assert.strictEqual(fs.readFileSync(lockedSource, 'utf8'), expectedBytes.toString(), 'locked commit never deletes a same-content replacement source');
    assert(fs.existsSync(retainedLockedSource), 'the original pre-copy source object remains explicitly recoverable in the injected race');
    assert.strictEqual(fs.readFileSync(lockedStaged, 'utf8'), 'expected locked content', 'pre-publish identity rejection retains the staging recovery copy');
    assert(!fs.existsSync(lockedTarget), 'pre-publish identity rejection does not publish a target');

    let longSourceRoot = sourceRoot; let longTargetRoot = targetRoot;
    while (longSourceRoot.length < 440) longSourceRoot = path.join(longSourceRoot, `long-${longSourceRoot.length}`);
    while (longTargetRoot.length < 440) longTargetRoot = path.join(longTargetRoot, `long-${longTargetRoot.length}`);
    fs.mkdirSync(longSourceRoot, { recursive: true }); fs.mkdirSync(longTargetRoot, { recursive: true });
    const longCrossSource = path.join(longSourceRoot, 'cross.txt'); const longCrossTarget = path.join(longTargetRoot, 'cross.txt'); fs.writeFileSync(longCrossSource, 'long cross volume'); assert(longCrossTarget.length > 431); await moveFileAtomic(longCrossSource, longCrossTarget); assert.strictEqual(fs.readFileSync(longCrossTarget, 'utf8'), 'long cross volume'); assert(!fs.existsSync(longCrossSource));
    const longConflictSource = path.join(longSourceRoot, 'conflict.txt'); const longConflictTarget = path.join(longTargetRoot, 'conflict.txt'); fs.writeFileSync(longConflictSource, 'source'); fs.writeFileSync(longConflictTarget, 'unknown'); await assert.rejects(moveFileAtomic(longConflictSource, longConflictTarget), error => error.code === 'EEXIST'); assert.strictEqual(fs.readFileSync(longConflictSource, 'utf8'), 'source'); assert.strictEqual(fs.readFileSync(longConflictTarget, 'utf8'), 'unknown');
    const longCancelSource = path.join(longSourceRoot, 'cancel.txt'); const longCancelTarget = path.join(longTargetRoot, 'cancel.txt'); fs.writeFileSync(longCancelSource, 'cancel'); let longCancelled = false; let longReports = 0; await assert.rejects(moveFileAtomic(longCancelSource, longCancelTarget, { isCancelled: () => longCancelled, onProgress: value => { if (value.bytesCopied === value.totalBytes && ++longReports >= 2) longCancelled = true; } }), error => error.code === 'EOPCANCELLED'); assert(fs.existsSync(longCancelSource)); assert(!fs.existsSync(longCancelTarget));

    const directorySource = path.join(sourceRoot, 'tree-normal');
    const directoryTarget = path.join(targetRoot, 'tree-normal');
    fs.mkdirSync(path.join(directorySource, 'nested', 'empty'), { recursive: true });
    for (let index = 0; index < 120; index += 1) fs.writeFileSync(path.join(directorySource, 'nested', `file-${index}.txt`), `tree-${index}`);
    const readOnlyTreeFile = path.join(directorySource, 'readonly.txt'); fs.writeFileSync(readOnlyTreeFile, 'readonly'); fs.chmodSync(readOnlyTreeFile, 0o444);
    await movePathAtomic(directorySource, directoryTarget);
    assert.strictEqual(fs.existsSync(directorySource), false);
    assert.strictEqual(fs.readFileSync(path.join(directoryTarget, 'nested', 'file-119.txt'), 'utf8'), 'tree-119');
    assert.strictEqual(fs.existsSync(path.join(directoryTarget, 'nested', 'empty')), true);
    assert.strictEqual(fs.readFileSync(path.join(directoryTarget, 'readonly.txt'), 'utf8'), 'readonly');

    const contestedTreeSource = path.join(sourceRoot, 'tree-conflict'); const contestedTreeTarget = path.join(targetRoot, 'tree-conflict');
    fs.mkdirSync(contestedTreeSource); fs.writeFileSync(path.join(contestedTreeSource, 'a.txt'), 'a'); fs.writeFileSync(path.join(contestedTreeSource, 'b.txt'), 'b');
    let treeCommitCount = 0;
    const contestedNative = { ...nativePublication, commitTreeFile: async request => { treeCommitCount += 1; if (treeCommitCount === 2) { fs.unlinkSync(request.target); fs.writeFileSync(request.target, 'unknown tree target'); } return nativePublication.commitTreeFile(request); } };
    await assert.rejects(movePathAtomic(contestedTreeSource, contestedTreeTarget, { nativePublicationService: contestedNative }), error => error.code === 'EPUBLISHPARTIAL' && error.recoveryRequired);
    assert.strictEqual(fs.existsSync(contestedTreeSource), true, 'tree conflict retains the not-yet-committed source tree');
    assert.strictEqual(fs.readFileSync(path.join(contestedTreeTarget, 'b.txt'), 'utf8'), 'unknown tree target');

    const cancelledTreeSource = path.join(sourceRoot, 'tree-cancel'); const cancelledTreeTarget = path.join(targetRoot, 'tree-cancel');
    fs.mkdirSync(cancelledTreeSource); for (let index = 0; index < 8; index += 1) fs.writeFileSync(path.join(cancelledTreeSource, `${index}.txt`), String(index));
    let cancelTree = false; let committedTreeFiles = 0;
    const cancellingNative = { ...nativePublication, commitTreeFile: async request => { const result = await nativePublication.commitTreeFile(request); committedTreeFiles += 1; if (committedTreeFiles === 3) cancelTree = true; return result; } };
    await assert.rejects(movePathAtomic(cancelledTreeSource, cancelledTreeTarget, { nativePublicationService: cancellingNative, isCancelled: () => cancelTree }), error => error.code === 'EPUBLISHPARTIAL' && error.recoveryRequired);
    assert.strictEqual(fs.existsSync(cancelledTreeTarget), true);
    assert.strictEqual(fs.existsSync(cancelledTreeSource), true, 'cancelled tree move retains uncommitted source entries for retry');
    console.log('real Windows C: to D: no-clobber publication tests passed');
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
    const parent = path.dirname(targetRoot);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
