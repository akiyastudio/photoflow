const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { canUseSameVolumeCut, canUseSingleRenameMove, registerFileOperationsIpc, sameFilesystemDevice } = require('../electron/modules/files-ipc.cjs');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { registerBrollImportIpc } = require('../electron/modules/broll-import.cjs');
const { createProjectVirtualPathService } = require('../electron/services/project-virtual-path-service.cjs');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createWorkspaceService } = require('../electron/services/workspace-service.cjs');
const { addUndoIdentities, assertUndoIdentity, capturePathIdentity, physicalPathKey, samePathIdentity } = require('../electron/services/file-identity-service.cjs');
const {
  CANCELLED_CODE,
  PUBLISH_PARTIAL_CODE,
  SOURCE_CLEANUP_INCOMPLETE_CODE,
  DEFAULT_SMALL_FILE_CONCURRENCY,
  assertCopyPlanSourcesUnchanged,
  assertDiskSpace,
  assertExistingInside,
  assertInside,
  collectCopyPlan,
  commitTemporaryFile,
  configureNativePublicationService,
  copyFileAtomic,
  copySmallFileAtomic,
  copyPlannedFiles,
  moveFileAtomic,
  movePathAtomic,
  publishPathNoClobber,
  releaseCleanupOwnership,
  getCleanupOwnershipStats,
  removeCopiedSources,
  removeCreatedPasteTargets,
  throwIfCancelled,
  uniqueDestination,
} = require('../electron/services/file-transfer-service.cjs');
const { createFilePublicationService } = require('../electron/services/file-publication-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-transfer-test-'));
const filesIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'files-ipc.cjs'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');

assert(mainSource.includes('createFileClipboardService') && !mainSource.includes('runWindowsClipboardScript'), 'file clipboard access must use the native service instead of inline PowerShell');
assert(filesIpcSource.includes('const clearClipboardIfSnapshotCurrent') && filesIpcSource.includes('clearSystemFileClipboardIfCurrent(snapshot)'), 'cut clipboard clearing must delegate sequence and path validation to the native helper');
assert.strictEqual((filesIpcSource.match(/await clearClipboardIfSnapshotCurrent\(clipboardSnapshot\)/g) || []).length, 2, 'both paste completion branches must verify clipboard ownership before clearing');
assert(filesIpcSource.includes('sourceCleanupOutcome = await removeCopiedSources') && filesIpcSource.includes('cleanupWarning: sourceCleanupOutcome?.cleanupWarning'), 'cut IPC success responses must expose terminal native cleanup warnings without retaining the source');
assert(filesIpcSource.includes('missingCutSources') && filesIpcSource.includes('剪切源已被其他粘贴任务移动或删除'), 'a later paste sharing an already-consumed cut snapshot must return a clear source error');
assert(filesIpcSource.includes('if (moves.length === 1 && sources.length === 1)') && filesIpcSource.includes('await fs.promises.rename(moves[0].source, moves[0].destination)'), 'single rename must have a one-call direct fast path');
assert(filesIpcSource.includes('if (!sameVolumeCut) {') && filesIpcSource.indexOf('await collectCopyPlan(target.source') > filesIpcSource.indexOf('if (!sameVolumeCut) {'), 'same-volume cut-paste must bypass recursive copy planning');
const singleMoveFastPathStart = filesIpcSource.indexOf('const singleSameVolumeMove');
const singleMoveFastPathSource = filesIpcSource.slice(singleMoveFastPathStart, filesIpcSource.indexOf("if (operation === 'copy' || operation === 'cut')", singleMoveFastPathStart));
assert(singleMoveFastPathSource.includes('canUseSingleRenameMove(process.platform, movePlan, destinationStat)') && singleMoveFastPathSource.includes('await publishPathNoClobber(entry.source, entry.destination, { ownershipToken: operationId })'), 'single internal move fast path must require matching filesystem device identities and use token-bound no-clobber publication');
assert(singleMoveFastPathSource.includes('if (!singleSameVolumeMove) task.publish') && singleMoveFastPathSource.includes('await movePathAtomic(entry.source, entry.destination'), 'only the non-fast move path may scan or fall back to copy');
const sameVolumeCutStart = filesIpcSource.indexOf('if (sameVolumeCut) {');
const sameVolumeCutSource = filesIpcSource.slice(sameVolumeCutStart, filesIpcSource.indexOf('const totalBytes = plan.reduce', sameVolumeCutStart));
assert(sameVolumeCutSource.includes('await publishPathNoClobber(item.source, item.destination)') && !sameVolumeCutSource.includes('movePathAtomic('), 'same-volume cut-paste must use the atomic no-clobber publisher, including rollback');
assert(filesIpcSource.includes('topLevelTargets.map(item => sourceStatsByPath.get(pathKey(item.source)))'), 'cut-paste fast path must compare every cached source device with the real destination device');
assert.strictEqual(sameFilesystemDevice({ dev: 401 }, { dev: 401 }), true, 'matching real device identities keep single move and cut-paste on the rename fast path');
assert.strictEqual(sameFilesystemDevice({ dev: 401 }, { dev: 902 }), false, 'same-drive-letter paths on different mounted devices cannot enter either rename-only fast path');
assert.strictEqual(sameFilesystemDevice({ dev: 0 }, { dev: 0 }), false, 'unavailable zero device identities conservatively disable fast paths');
assert.strictEqual(sameFilesystemDevice({}, { dev: 401 }), false, 'missing source device identity conservatively disables fast paths');
assert.strictEqual(sameFilesystemDevice({ dev: 401 }, {}), false, 'missing destination device identity conservatively disables fast paths');
assert.strictEqual(sameFilesystemDevice({ dev: 401n }, { dev: 401n }), true, 'bigint device identities are compared without precision loss');
assert.strictEqual(sameFilesystemDevice(Object.defineProperty({}, 'dev', { get: () => { throw new Error('stat dev unavailable'); } }), { dev: 401 }), false, 'device identity read failure conservatively disables fast paths');
const sameDriveDifferentDeviceMove = [{ source: 'C:\\mount\\source.txt', destination: 'C:\\target\\source.txt', sourceStat: { dev: 401 } }];
assert.strictEqual(canUseSingleRenameMove('win32', sameDriveDifferentDeviceMove, { dev: 902 }), false, 'single move on the same drive letter but a different mounted volume must use movePathAtomic fallback');
assert.strictEqual(canUseSingleRenameMove('win32', sameDriveDifferentDeviceMove, { dev: 401 }), true, 'single move with matching real device identity keeps the direct rename path');
assert.strictEqual(canUseSameVolumeCut('win32', 'cut', [{ dev: 401 }], { dev: 902 }), false, 'cut-paste on the same drive letter but a different mounted volume must use copy planning');
assert.strictEqual(canUseSameVolumeCut('win32', 'cut', [{ dev: 401 }], { dev: 401 }), true, 'cut-paste with matching real device identity keeps the rename path');
assert.strictEqual(canUseSameVolumeCut('win32', 'cut', [{ dev: 401 }, {}], { dev: 401 }), false, 'one unavailable source device disables the whole cut-paste rename fast path');

const run = async () => {
  try {
    const nativePublication = createFilePublicationService({ app: { isPackaged: false }, projectRoot: path.resolve(__dirname, '..') });
    configureNativePublicationService(nativePublication);
    const configuredInspirationRoot = path.join(root, 'configured-inspiration');
    const unconfiguredInspirationRoot = path.join(root, 'renderer-selected-root');
    fs.mkdirSync(configuredInspirationRoot);
    fs.mkdirSync(unconfiguredInspirationRoot);
    const inspirationWorkspaceService = createWorkspaceService({
      repository: {}, catalogs: new Map(), assertInside, assertExistingInside,
      getConfiguredInspirationRoot: () => configuredInspirationRoot,
    });
    assert.strictEqual(
      inspirationWorkspaceService.getProjectPath(configuredInspirationRoot, '未分类', '.__photoflow_inspiration__'),
      path.resolve(configuredInspirationRoot),
      'the saved inspiration root remains browseable and writable',
    );
    assert.throws(
      () => inspirationWorkspaceService.getProjectPath(unconfiguredInspirationRoot, '未分类', '.__photoflow_inspiration__'),
      /未获用户配置授权/,
      'the renderer cannot promote an arbitrary existing directory to an inspiration write root',
    );

    const source = path.join(root, 'source.bin');
    const copy = path.join(root, 'copy.bin');
    fs.writeFileSync(source, Buffer.alloc(8 * 1024 * 1024, 0x5a));
    let lastProgress = 0;
    await copyFileAtomic(source, copy, { onProgress: value => { lastProgress = value.bytesCopied; } });
    assert.strictEqual(lastProgress, fs.statSync(source).size);
    assert.deepStrictEqual(fs.readFileSync(copy), fs.readFileSync(source));

    const changingSource = path.join(root, 'changing-small.bin');
    const changingTarget = path.join(root, 'changing-small-copy.bin');
    fs.writeFileSync(changingSource, 'AAAA');
    const changingPlan = [];
    await collectCopyPlan(changingSource, changingTarget, changingPlan);
    const originalCopyFile = fs.promises.copyFile;
    fs.promises.copyFile = async (...args) => {
      const result = await originalCopyFile(...args);
      if (path.resolve(args[0]) === path.resolve(changingSource)) fs.writeFileSync(changingSource, 'BBBB');
      return result;
    };
    try {
      await assert.rejects(copySmallFileAtomic(changingPlan[0]), error => error?.code === 'SOURCE_CHANGED_DURING_COPY');
    } finally { fs.promises.copyFile = originalCopyFile; }
    assert.strictEqual(fs.existsSync(changingTarget), false, 'a same-size source rewrite during copy must not publish a target');

    const replacedCleanupSource = path.join(root, 'cleanup-owned-source.txt');
    const replacedCleanupTarget = path.join(root, 'cleanup-owned-target.txt');
    fs.writeFileSync(replacedCleanupSource, 'owned');
    await copyFileAtomic(replacedCleanupSource, replacedCleanupTarget);
    fs.unlinkSync(replacedCleanupTarget);
    fs.writeFileSync(replacedCleanupTarget, 'later replacement');
    await removeCreatedPasteTargets([replacedCleanupTarget]);
    assert.strictEqual(fs.readFileSync(replacedCleanupTarget, 'utf8'), 'later replacement', 'rollback must retain a target replaced after publication');

    const overlapSourceA = path.join(root, 'overlap-a.txt'); const overlapSourceB = path.join(root, 'overlap-b.txt'); const overlapTarget = path.join(root, 'overlap-target.txt');
    fs.writeFileSync(overlapSourceA, 'owner-a'); fs.writeFileSync(overlapSourceB, 'owner-b');
    const overlapA = await copyFileAtomic(overlapSourceA, overlapTarget, { ownershipToken: 'overlap-owner-a' });
    const overlapPlan = []; await collectCopyPlan(overlapSourceB, overlapTarget, overlapPlan);
    const overlapB = await copyPlannedFiles(overlapPlan, { ownershipToken: 'overlap-owner-b', isEntryComplete: async () => true });
    const ambiguousCleanup = await removeCreatedPasteTargets([overlapTarget]);
    assert.strictEqual(ambiguousCleanup.success, false, 'legacy cleanup without a token must reject overlapping owners');
    assert.strictEqual(fs.readFileSync(overlapTarget, 'utf8'), 'owner-a');
    const staleOwnerCleanup = await removeCreatedPasteTargets([overlapTarget], { ownershipToken: overlapA.ownershipToken });
    assert.strictEqual(staleOwnerCleanup.success, false, 'one shared owner cannot clean an object still owned by another operation');
    assert.strictEqual(fs.readFileSync(overlapTarget, 'utf8'), 'owner-a');
    const currentOwnerCleanup = await removeCreatedPasteTargets([overlapTarget], { ownershipToken: overlapB.ownershipToken });
    assert.strictEqual(currentOwnerCleanup.success, true, 'the matching overlapping operation can clean only its own identity');
    assert.strictEqual(fs.existsSync(overlapTarget), false);
    const overlapSourceC = path.join(root, 'overlap-c.txt'); fs.writeFileSync(overlapSourceC, 'owner-c');
    await copyFileAtomic(overlapSourceC, overlapTarget, { ownershipToken: 'overlap-owner-c' });
    const cleanupC = await removeCreatedPasteTargets([overlapTarget]);
    assert.strictEqual(cleanupC.success, true, 'A/B terminal cleanup must not leave C permanently ambiguous');
    const stalePath = path.join(root, 'stale-owner-target.txt'); const staleSourceA = path.join(root, 'stale-owner-a.txt'); const staleSourceB = path.join(root, 'stale-owner-b.txt'); fs.writeFileSync(staleSourceA, 'stale-a'); fs.writeFileSync(staleSourceB, 'stale-b');
    const staleA = await copyFileAtomic(staleSourceA, stalePath, { ownershipToken: 'stale-owner-a' }); fs.unlinkSync(stalePath);
    const staleB = await copyFileAtomic(staleSourceB, stalePath, { ownershipToken: 'stale-owner-b' });
    const staleAttempt = await removeCreatedPasteTargets([stalePath], { ownershipToken: staleA.ownershipToken });
    assert.strictEqual(staleAttempt.success, false); assert.strictEqual(fs.readFileSync(stalePath, 'utf8'), 'stale-b', 'registering B must prune stale A without letting A delete B'); releaseCleanupOwnership(staleB.ownershipToken); fs.unlinkSync(stalePath);
    const ledgerBeforeReleaseLoop = getCleanupOwnershipStats();
    for (let index = 0; index < 12; index += 1) {
      const loopSource = path.join(root, `release-source-${index}.txt`); const loopTarget = path.join(root, `release-target-${index}.txt`); fs.writeFileSync(loopSource, `release-${index}`);
      const loopCopy = await copyFileAtomic(loopSource, loopTarget); releaseCleanupOwnership(loopCopy.ownershipToken); fs.unlinkSync(loopTarget);
    }
    assert.deepStrictEqual(getCleanupOwnershipStats(), ledgerBeforeReleaseLoop, 'successful operation token release must keep long-running ledger size bounded');
    const implicitTargets = [];
    for (let index = 0; index < 80; index += 1) {
      const implicitTarget = path.join(root, `implicit-complete-${index}.txt`); fs.writeFileSync(implicitTarget, `implicit-${index}`); implicitTargets.push(implicitTarget);
      await copyPlannedFiles([{ kind: 'file', source: implicitTarget, destination: implicitTarget, size: fs.statSync(implicitTarget).size, sourceIdentity: await capturePathIdentity(implicitTarget), mode: fs.statSync(implicitTarget).mode, atime: fs.statSync(implicitTarget).atime, mtime: fs.statSync(implicitTarget).mtime }], { isEntryComplete: async () => true });
    }
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepStrictEqual(getCleanupOwnershipStats(), ledgerBeforeReleaseLoop, 'high-frequency implicit successful calls must auto-release instead of accumulating random tokens');
    for (const implicitTarget of implicitTargets) fs.unlinkSync(implicitTarget);

    const quarantineRaceSource = path.join(root, 'quarantine-race-source.txt'); const quarantineRaceTarget = path.join(root, 'quarantine-race-target.txt');
    fs.writeFileSync(quarantineRaceSource, 'owned-race');
    const quarantineRace = await copyFileAtomic(quarantineRaceSource, quarantineRaceTarget, { ownershipToken: 'quarantine-file-owner' });
    const racedFileCleanup = await removeCreatedPasteTargets([quarantineRaceTarget], {
      ownershipToken: quarantineRace.ownershipToken,
      beforeQuarantineMove: async () => { fs.unlinkSync(quarantineRaceTarget); fs.writeFileSync(quarantineRaceTarget, 'replacement-after-check'); },
    });
    assert.strictEqual(racedFileCleanup.success, false);
    assert.strictEqual(fs.readFileSync(quarantineRaceTarget, 'utf8'), 'replacement-after-check', 'file replacement after the initial check must be restored, not deleted');

    const occupiedRaceSource = path.join(root, 'occupied-race-source.txt'); const occupiedRaceTarget = path.join(root, 'occupied-race-target.txt'); fs.writeFileSync(occupiedRaceSource, 'owned-occupied');
    const occupiedRace = await copyFileAtomic(occupiedRaceSource, occupiedRaceTarget, { ownershipToken: 'occupied-file-owner' });
    const occupiedCleanup = await removeCreatedPasteTargets([occupiedRaceTarget], { ownershipToken: occupiedRace.ownershipToken, afterQuarantineMove: async item => { fs.writeFileSync(occupiedRaceTarget, 'new occupant'); fs.writeFileSync(item.quarantine, 'tampered quarantine'); } });
    assert.strictEqual(occupiedCleanup.success, false);
    assert.strictEqual(fs.readFileSync(occupiedRaceTarget, 'utf8'), 'new occupant');
    assert.strictEqual(fs.existsSync(occupiedCleanup.recoveryPaths[0]), true, 'an occupied original path must retain the mismatched quarantine as an explicit recoveryPath');

    const nativeCleanupSource = path.join(root, 'native-cleanup-source.txt'); const nativeCleanupTarget = path.join(root, 'native-cleanup-target.txt'); fs.writeFileSync(nativeCleanupSource, 'native-cleanup'); let nativeCompareDeletes = 0;
    const identityDeleteNative = { ...nativePublication, compareDeleteFile: async request => { nativeCompareDeletes += 1; return nativePublication.compareDeleteFile(request); } };
    const nativeCleanupCopy = await copyFileAtomic(nativeCleanupSource, nativeCleanupTarget, { ownershipToken: 'native-cleanup-owner', nativePublicationService: identityDeleteNative });
    const nativeCleanup = await removeCreatedPasteTargets([nativeCleanupTarget], { ownershipToken: nativeCleanupCopy.ownershipToken, nativePublicationService: identityDeleteNative });
    assert.strictEqual(nativeCleanup.success, true); assert.strictEqual(nativeCompareDeletes, 1, 'available native cleanup must use identity-bound compareDeleteFile instead of JS pathname unlink');
    const portableCleanupTarget = path.join(root, 'portable-cleanup-target.txt'); fs.writeFileSync(portableCleanupTarget, 'portable-owned'); const portableIdentity = await capturePathIdentity(portableCleanupTarget, { digest: true });
    const portableCleanup = await removeCreatedPasteTargets([{ path: portableCleanupTarget, identity: portableIdentity, ownershipToken: 'portable-cleanup-owner' }], { ownershipToken: 'portable-cleanup-owner', nativePublicationService: { nativeAvailable: () => false }, beforePortableDelete: async item => { fs.writeFileSync(item.quarantine, 'portable-replacement'); } });
    assert.strictEqual(portableCleanup.success, false); assert.strictEqual(fs.existsSync(portableCleanup.recoveryPaths[0]), true, 'portable cleanup must retain the private 0700 recovery when the quarantine changes before final delete');

    const quarantineDirectory = path.join(root, 'quarantine-directory-race'); fs.mkdirSync(quarantineDirectory);
    const quarantineDirectoryIdentity = await capturePathIdentity(quarantineDirectory);
    const racedDirectoryCleanup = await removeCreatedPasteTargets([{ path: quarantineDirectory, identity: quarantineDirectoryIdentity, ownershipToken: 'quarantine-directory-owner' }], {
      ownershipToken: 'quarantine-directory-owner',
      beforeQuarantineMove: async () => { fs.rmdirSync(quarantineDirectory); fs.mkdirSync(quarantineDirectory); },
    });
    assert.strictEqual(racedDirectoryCleanup.success, false);
    assert.strictEqual(fs.statSync(quarantineDirectory).isDirectory(), true, 'directory replacement after the initial check must be restored, not removed');

    const nativePostCommitSource = path.join(root, 'native-post-commit-source.txt'); const nativePostCommitTarget = path.join(root, 'native-post-commit-target.txt');
    fs.writeFileSync(nativePostCommitSource, 'native-post-commit');
    await assert.rejects(publishPathNoClobber(nativePostCommitSource, nativePostCommitTarget, { nativePublicationService: { nativeAvailable: () => true, moveNoReplace: async (sourcePath, targetPath) => { fs.renameSync(sourcePath, targetPath); throw Object.assign(new Error('native reply lost after commit'), { published: true, publishedPath: targetPath, identity: 'native-post-id' }); }, inspectPath: async () => ({ success: true, identity: 'native-post-id' }) } }), error => error.code === PUBLISH_PARTIAL_CODE && error.published === true && error.publishedIdentity?.nativeIdentity === 'native-post-id');
    assert.strictEqual(fs.readFileSync(nativePostCommitTarget, 'utf8'), 'native-post-commit');
    const reconcileRaceSource = path.join(root, 'native-reconcile-race-source.txt'); const reconcileRaceTarget = path.join(root, 'native-reconcile-race-target.txt'); fs.writeFileSync(reconcileRaceSource, 'published-original'); let reconcileInspectCount = 0;
    await assert.rejects(publishPathNoClobber(reconcileRaceSource, reconcileRaceTarget, { nativePublicationService: { nativeAvailable: () => true, moveNoReplace: async (sourcePath, targetPath) => { fs.renameSync(sourcePath, targetPath); throw Object.assign(new Error('post-commit race'), { published: true, publishedPath: targetPath, identity: 'original-native-id' }); }, inspectPath: async () => ({ success: true, identity: reconcileInspectCount++ === 0 ? 'original-native-id' : 'replacement-native-id' }) }, nativeReconcileHook: async () => { fs.unlinkSync(reconcileRaceTarget); fs.writeFileSync(reconcileRaceTarget, 'replacement-between-inspect-and-capture'); } }), error => error.code === PUBLISH_PARTIAL_CODE && error.published === false && error.outcomeUnknown === true && !error.publishedIdentity);
    assert.strictEqual(fs.readFileSync(reconcileRaceTarget, 'utf8'), 'replacement-between-inspect-and-capture', 'replacement between native inspect and physical capture must never be claimed');
    const nativeUnknownSource = path.join(root, 'native-unknown-source.txt'); const nativeUnknownTarget = path.join(root, 'native-unknown-target.txt'); fs.writeFileSync(nativeUnknownSource, 'unknown');
    await assert.rejects(publishPathNoClobber(nativeUnknownSource, nativeUnknownTarget, { nativePublicationService: { nativeAvailable: () => true, moveNoReplace: async () => { throw Object.assign(new Error('native timeout'), { outcomeUnknown: true }); } } }), error => error.code === PUBLISH_PARTIAL_CODE && error.outcomeUnknown === true && error.recoveryRequired === true);
    assert.strictEqual(fs.readFileSync(nativeUnknownSource, 'utf8'), 'unknown');
    const unrelatedSource = path.join(root, 'native-unrelated-source.txt'); const unrelatedTarget = path.join(root, 'native-unrelated-target.txt'); fs.writeFileSync(unrelatedSource, 'source-still-here');
    await assert.rejects(publishPathNoClobber(unrelatedSource, unrelatedTarget, { nativePublicationService: { nativeAvailable: () => true, moveNoReplace: async (_sourcePath, targetPath) => { fs.writeFileSync(targetPath, 'unrelated occupant'); throw Object.assign(new Error('false published claim'), { published: true, publishedPath: targetPath, identity: 'unrelated-id' }); }, inspectPath: async () => ({ success: true, identity: 'unrelated-id' }) } }), error => error.code === PUBLISH_PARTIAL_CODE && error.published === false && error.outcomeUnknown === true && !error.publishedIdentity);
    assert.strictEqual(fs.readFileSync(unrelatedSource, 'utf8'), 'source-still-here'); assert.strictEqual(fs.readFileSync(unrelatedTarget, 'utf8'), 'unrelated occupant');

    const linkTargetDirectory = path.join(root, 'link-publish-target'); const linkPublishSource = path.join(root, 'link-publish-source'); const linkPublishDestination = path.join(root, 'link-publish-destination'); fs.mkdirSync(linkTargetDirectory);
    let linkFixtureCreated = false;
    try { fs.symlinkSync(linkTargetDirectory, linkPublishSource, process.platform === 'win32' ? 'junction' : 'dir'); linkFixtureCreated = true; }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error; }
    if (linkFixtureCreated) {
      const linkPublish = await publishPathNoClobber(linkPublishSource, linkPublishDestination);
      assert.strictEqual(linkPublish.identity.kind, 'symlink');
      assert.strictEqual(fs.existsSync(linkPublishSource), false);
      assert.strictEqual(fs.lstatSync(linkPublishDestination).isSymbolicLink(), true);
      assert.strictEqual(await samePathIdentity(linkPublishDestination, linkPublish.identity, { destructive: true }), true, 'published link identity must describe the link object rather than its target');
      assert.strictEqual(fs.statSync(linkTargetDirectory).isDirectory(), true, 'publishing a junction/symlink must never move or delete its target');
    }

    const fallbackTemporary = path.join(root, '.fallback.photoflow-part');
    const fallbackTarget = path.join(root, 'fallback.bin');
    fs.writeFileSync(fallbackTemporary, 'rename fallback');
    const fallbackResult = await commitTemporaryFile(fallbackTemporary, fallbackTarget, {
      allowCopyFallback: true,
      maxAttempts: 1,
      linkFile: async () => { throw Object.assign(new Error('simulated Windows scanner lock'), { code: 'EPERM' }); },
    });
    assert.strictEqual(fallbackResult.strategy, 'win32-move-no-replace');
    assert.strictEqual(fs.readFileSync(fallbackTarget, 'utf8'), 'rename fallback');
    assert.strictEqual(fs.existsSync(fallbackTemporary), false);

    for (const directoryCase of [false, true]) {
      const lateSource = path.join(root, `native-late-${directoryCase ? 'directory' : 'file'}-source`);
      const lateTarget = path.join(root, `native-late-${directoryCase ? 'directory' : 'file'}-target`);
      if (directoryCase) { fs.mkdirSync(lateSource); fs.writeFileSync(path.join(lateSource, 'source.txt'), 'source survives'); }
      else fs.writeFileSync(lateSource, 'source survives');
      const racingNative = {
        nativeAvailable: () => true,
        moveNoReplace: async (sourcePath, targetPath) => {
          if (directoryCase) { fs.mkdirSync(targetPath); fs.writeFileSync(path.join(targetPath, 'late.txt'), 'late unknown'); }
          else fs.writeFileSync(targetPath, 'late unknown');
          return nativePublication.moveNoReplace(sourcePath, targetPath);
        },
      };
      await assert.rejects(publishPathNoClobber(lateSource, lateTarget, { nativePublicationService: racingNative }), error => error.code === 'EEXIST');
      assert.strictEqual(directoryCase ? fs.readFileSync(path.join(lateTarget, 'late.txt'), 'utf8') : fs.readFileSync(lateTarget, 'utf8'), 'late unknown');
      assert.strictEqual(fs.existsSync(lateSource), true, 'native no-replace keeps the source when a late target wins');
    }

    const durableSource = path.join(root, 'durable-source.bin');
    const durableTarget = path.join(root, 'durable-target.bin');
    fs.writeFileSync(durableSource, Buffer.alloc(3 * 1024 * 1024, 0x2d));
    await copyFileAtomic(durableSource, durableTarget, { durable: true });
    assert.deepStrictEqual(fs.readFileSync(durableTarget), fs.readFileSync(durableSource));

    const readOnlySource = path.join(root, 'read-only-source.xmp');
    const readOnlyTarget = path.join(root, 'read-only-target.xmp');
    fs.writeFileSync(readOnlySource, '<xmpmeta>read-only</xmpmeta>');
    fs.chmodSync(readOnlySource, 0o444);
    const readOnlyStat = fs.statSync(readOnlySource);
    try {
      await copyPlannedFiles([{
        kind: 'file', source: readOnlySource, destination: readOnlyTarget,
        size: readOnlyStat.size, mode: readOnlyStat.mode,
        atime: readOnlyStat.atime, mtime: readOnlyStat.mtime,
      }], { destinationRoot: root, durable: true });
      assert.strictEqual(fs.readFileSync(readOnlyTarget, 'utf8'), '<xmpmeta>read-only</xmpmeta>');
      assert.strictEqual(fs.statSync(readOnlyTarget).mode & 0o222, readOnlyStat.mode & 0o222, 'the published file must preserve the source read-only mode');
    } finally {
      fs.chmodSync(readOnlySource, 0o666);
      if (fs.existsSync(readOnlyTarget)) fs.chmodSync(readOnlyTarget, 0o666);
    }

    const moveSource = path.join(root, 'move-source.bin');
    const moveTarget = path.join(root, 'move-target.bin');
    fs.writeFileSync(moveSource, 'move');
    let sameVolumePublishCalls = 0;
    const sameVolumeMove = await movePathAtomic(moveSource, moveTarget, { nativePublicationService: { nativeAvailable: () => true, moveNoReplace: async (source, destination) => { sameVolumePublishCalls += 1; return nativePublication.moveNoReplace(source, destination); } } });
    assert.strictEqual(sameVolumeMove.copied, false);
    assert.strictEqual(sameVolumePublishCalls, 1, 'same-volume single move uses one atomic no-clobber publication without scanning or copying');
    assert.strictEqual(fs.existsSync(moveSource), false);
    assert.strictEqual(fs.readFileSync(moveTarget, 'utf8'), 'move');

    const crossVolumeSource = path.join(root, 'cross-volume-source.bin');
    const crossVolumeTarget = path.join(root, 'cross-volume-target.bin');
    fs.writeFileSync(crossVolumeSource, 'cross-volume move');
    const simulatedCrossNative = {
      nativeAvailable: () => true,
      moveNoReplace: async (source, destination) => path.resolve(source) === path.resolve(crossVolumeSource)
        ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' }))
        : nativePublication.moveNoReplace(source, destination),
      inspectPath: value => nativePublication.inspectPath(value),
      commitCrossVolumeFile: async ({ source, staged, target }) => { await nativePublication.moveNoReplace(staged, target); fs.unlinkSync(source); return { strategy: 'simulated-cross-volume-locked-commit' }; },
      compareDeleteFile: request => nativePublication.compareDeleteFile(request),
    };
    const crossVolumeResult = await movePathAtomic(crossVolumeSource, crossVolumeTarget, {
      nativePublicationService: simulatedCrossNative,
    });
    assert.strictEqual(crossVolumeResult.copied, true);
    assert.strictEqual(fs.existsSync(crossVolumeSource), false);
    assert.strictEqual(fs.readFileSync(crossVolumeTarget, 'utf8'), 'cross-volume move');

    const deletedWarningSource = path.join(root, 'cross-volume-deleted-warning-source.bin'); const deletedWarningTarget = path.join(root, 'cross-volume-deleted-warning-target.bin'); fs.writeFileSync(deletedWarningSource, 'deleted cleanup warning'); let deletedWarningCommits = 0;
    const deletedWarningNative = { ...nativePublication, nativeAvailable: () => true, moveNoReplace: async (source, destination) => path.resolve(source) === path.resolve(deletedWarningSource) ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' })) : nativePublication.moveNoReplace(source, destination), commitCrossVolumeFile: async ({ source, staged, target }) => { deletedWarningCommits += 1; const published = await nativePublication.moveNoReplace(staged, target); fs.unlinkSync(source); throw Object.assign(new Error('post-unlink parent fsync failed'), { code: 'EIO', published: true, deleted: true, cleanupWarning: true, phase: 'post-unlink-cleanup', outcomeUnknown: true, identity: published.identity }); } };
    const deletedWarningResult = await moveFileAtomic(deletedWarningSource, deletedWarningTarget, { nativePublicationService: deletedWarningNative }); assert.strictEqual(deletedWarningCommits, 1, 'post-unlink cleanup warning must not retry cross-volume commit'); assert.strictEqual(deletedWarningResult.cleanupWarning, true); assert.strictEqual(deletedWarningResult.cleanupPhase, 'post-unlink-cleanup'); assert.strictEqual(deletedWarningResult.outcomeUnknown, true); assert.strictEqual(deletedWarningResult.sourceRetained, false); assert.strictEqual(deletedWarningResult.recoveryPath, undefined); assert(!fs.existsSync(deletedWarningSource)); assert.strictEqual(fs.readFileSync(deletedWarningTarget, 'utf8'), 'deleted cleanup warning');

    const replacedPublishedSource = path.join(root, 'cross-volume-replaced-published-source.bin'); const replacedPublishedTarget = path.join(root, 'cross-volume-replaced-published-target.bin'); const replacedPublishedOwned = `${replacedPublishedTarget}.owned`; fs.writeFileSync(replacedPublishedSource, 'owned published target'); let replacedPublishedCommits = 0;
    const replacedPublishedNative = { ...nativePublication, nativeAvailable: () => true, moveNoReplace: async (source, destination) => path.resolve(source) === path.resolve(replacedPublishedSource) ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' })) : nativePublication.moveNoReplace(source, destination), commitCrossVolumeFile: async ({ source, staged, target }) => { replacedPublishedCommits += 1; const published = await nativePublication.moveNoReplace(staged, target); fs.unlinkSync(source); fs.renameSync(target, replacedPublishedOwned); fs.writeFileSync(target, 'replacement target'); throw Object.assign(new Error('cleanup warning after target replacement'), { code: 'EIO', published: true, deleted: true, cleanupWarning: true, phase: 'post-unlink-cleanup', outcomeUnknown: true, identity: published.identity }); } };
    await assert.rejects(moveFileAtomic(replacedPublishedSource, replacedPublishedTarget, { nativePublicationService: replacedPublishedNative }), error => error.deleted === true && error.outcomeUnknown === true && error.published === undefined && error.publishedConfirmed === false && error.publicationState === 'unknown' && error.publishedIdentity === undefined && error.recoveryRequired === false && error.recoveryPaths.length === 0 && error.uncertainPaths.includes(replacedPublishedTarget)); assert.strictEqual(replacedPublishedCommits, 1, 'target replacement after commit must not trigger a blind retry'); assert(!fs.existsSync(replacedPublishedSource)); assert.strictEqual(fs.readFileSync(replacedPublishedTarget, 'utf8'), 'replacement target'); assert.strictEqual(fs.readFileSync(replacedPublishedOwned, 'utf8'), 'owned published target');

    const retainedRecoverySource = path.join(root, 'cross-volume-retained-recovery-source.bin'); const retainedRecoveryTarget = path.join(root, 'cross-volume-retained-recovery-target.bin'); const retainedRecoveryPath = path.join(root, 'cross-volume-retained-native-recovery.bin'); fs.writeFileSync(retainedRecoverySource, 'owned retained source');
    const retainedRecoveryNative = { ...nativePublication, nativeAvailable: () => true, moveNoReplace: async (source, destination) => path.resolve(source) === path.resolve(retainedRecoverySource) ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' })) : nativePublication.moveNoReplace(source, destination), commitCrossVolumeFile: async ({ source, staged, target }) => { const published = await nativePublication.moveNoReplace(staged, target); fs.renameSync(source, retainedRecoveryPath); fs.writeFileSync(source, 'new source occupant'); throw Object.assign(new Error('pre-unlink source recovery retained'), { code: 'EACCES', published: true, recoveryPath: retainedRecoveryPath, identity: published.identity }); } };
    await assert.rejects(moveFileAtomic(retainedRecoverySource, retainedRecoveryTarget, { nativePublicationService: retainedRecoveryNative }), error => error.code === PUBLISH_PARTIAL_CODE && error.published === true && error.publishedConfirmed === true && error.publicationState === 'published' && error.publishedIdentity && error.recoveryRequired === true && error.recoveryPaths.length === 1 && error.recoveryPaths[0] === retainedRecoveryPath && error.recoveryPaths.every(candidate => fs.existsSync(candidate)) && error.sourceRetained === false && error.uncertainPaths.includes(retainedRecoverySource)); assert.strictEqual(fs.readFileSync(retainedRecoverySource, 'utf8'), 'new source occupant'); assert.strictEqual(fs.readFileSync(retainedRecoveryPath, 'utf8'), 'owned retained source'); assert.strictEqual(fs.readFileSync(retainedRecoveryTarget, 'utf8'), 'owned retained source');

    const retainedSourceSource = path.join(root, 'cross-volume-retained-source.bin'); const retainedSourceTarget = path.join(root, 'cross-volume-retained-source-target.bin'); fs.writeFileSync(retainedSourceSource, 'verified source retained');
    const retainedSourceNative = { ...nativePublication, nativeAvailable: () => true, moveNoReplace: async (source, destination) => path.resolve(source) === path.resolve(retainedSourceSource) ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' })) : nativePublication.moveNoReplace(source, destination), commitCrossVolumeFile: async ({ staged, target }) => { const published = await nativePublication.moveNoReplace(staged, target); throw Object.assign(new Error('pre-unlink cleanup denied'), { code: 'EACCES', published: true, identity: published.identity }); } };
    await assert.rejects(moveFileAtomic(retainedSourceSource, retainedSourceTarget, { nativePublicationService: retainedSourceNative }), error => error.code === PUBLISH_PARTIAL_CODE && error.published === true && error.publishedConfirmed === true && error.sourceRetained === true && error.recoveryRequired === true && error.recoveryPaths.includes(retainedSourceSource) && error.recoveryPaths.every(candidate => fs.existsSync(candidate))); assert.strictEqual(fs.readFileSync(retainedSourceSource, 'utf8'), 'verified source retained'); assert.strictEqual(fs.readFileSync(retainedSourceTarget, 'utf8'), 'verified source retained');

    const combinedSource = path.join(root, 'cross-volume-combined-source.bin'); const combinedTarget = path.join(root, 'cross-volume-combined-target.bin'); const combinedRecovery = path.join(root, 'cross-volume-combined-recovery.bin'); const combinedOwnedTarget = `${combinedTarget}.owned`; fs.writeFileSync(combinedSource, 'combined owned payload');
    const combinedNative = { ...nativePublication, nativeAvailable: () => true, moveNoReplace: async (source, destination) => path.resolve(source) === path.resolve(combinedSource) ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' })) : nativePublication.moveNoReplace(source, destination), commitCrossVolumeFile: async ({ source, staged, target }) => { const published = await nativePublication.moveNoReplace(staged, target); fs.renameSync(source, combinedRecovery); fs.writeFileSync(source, 'combined source replacement'); fs.renameSync(target, combinedOwnedTarget); fs.writeFileSync(target, 'combined target replacement'); throw Object.assign(new Error('retained recovery with target replacement'), { code: 'EACCES', published: true, recoveryPath: combinedRecovery, identity: published.identity }); } };
    await assert.rejects(moveFileAtomic(combinedSource, combinedTarget, { nativePublicationService: combinedNative }), error => error.code === PUBLISH_PARTIAL_CODE && error.published !== true && error.publishedConfirmed === false && error.publicationState === 'unknown' && error.outcomeUnknown === true && error.publishedIdentity === undefined && error.recoveryPaths.length === 1 && error.recoveryPaths[0] === combinedRecovery && error.recoveryPaths.every(candidate => fs.existsSync(candidate)) && error.sourceRetained === false && error.uncertainPaths.includes(combinedSource) && error.uncertainPaths.includes(combinedTarget) && /结果待确认/.test(error.message) && !/内容已发布/.test(error.message)); assert.strictEqual(fs.readFileSync(combinedRecovery, 'utf8'), 'combined owned payload'); assert.strictEqual(fs.readFileSync(combinedSource, 'utf8'), 'combined source replacement'); assert.strictEqual(fs.readFileSync(combinedTarget, 'utf8'), 'combined target replacement'); assert.strictEqual(fs.readFileSync(combinedOwnedTarget, 'utf8'), 'combined owned payload');

    const stagedRaceSource = path.join(root, 'cross-volume-staging-race-source.bin');
    const stagedRaceTarget = path.join(root, 'cross-volume-staging-race-target.bin');
    fs.writeFileSync(stagedRaceSource, 'same bytes replacement');
    let stagedRaceCancelled = false; let stagedRaceReplacement; let stagedRaceOriginal;
    const stagedRaceNative = {
      ...nativePublication,
      nativeAvailable: () => true,
      moveNoReplace: async (source, destination) => path.resolve(source) === path.resolve(stagedRaceSource)
        ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' }))
        : nativePublication.moveNoReplace(source, destination),
    };
    await assert.rejects(moveFileAtomic(stagedRaceSource, stagedRaceTarget, {
      nativePublicationService: stagedRaceNative,
      isCancelled: () => stagedRaceCancelled,
      onProgress: () => {
        if (stagedRaceCancelled) return;
        const stagedName = fs.readdirSync(root).find(name => name.includes('.cross-volume-staging-race-target.bin.') && name.endsWith('.photoflow-cross-volume'));
        if (!stagedName) return;
        stagedRaceReplacement = path.join(root, stagedName); stagedRaceOriginal = `${stagedRaceReplacement}.original`;
        fs.renameSync(stagedRaceReplacement, stagedRaceOriginal);
        fs.writeFileSync(stagedRaceReplacement, 'same bytes replacement');
        stagedRaceCancelled = true;
      },
    }), error => error.code === PUBLISH_PARTIAL_CODE && error.cleanupCode === 'PUBLISH_OWNERSHIP_CONFLICT');
    assert.strictEqual(fs.readFileSync(stagedRaceSource, 'utf8'), 'same bytes replacement', 'cancel retains the move source');
    assert.strictEqual(fs.readFileSync(stagedRaceReplacement, 'utf8'), 'same bytes replacement', 'compare-delete must retain a same-byte staging replacement');
    assert(fs.existsSync(stagedRaceOriginal), 'the originally published staging object remains explicit in the injected race');
    assert(!fs.existsSync(stagedRaceTarget));

    const readOnlyCancelSource = path.join(root, 'cross-volume-readonly-cancel-source.bin'); const readOnlyCancelTarget = path.join(root, 'cross-volume-readonly-cancel-target.bin');
    fs.writeFileSync(readOnlyCancelSource, 'readonly cancellation'); fs.chmodSync(readOnlyCancelSource, 0o444); let readOnlyCancelled = false;
    const readOnlyCancelNative = { ...nativePublication, nativeAvailable: () => true, moveNoReplace: async (source, destination) => path.resolve(source) === path.resolve(readOnlyCancelSource) ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' })) : nativePublication.moveNoReplace(source, destination) };
    await assert.rejects(moveFileAtomic(readOnlyCancelSource, readOnlyCancelTarget, { nativePublicationService: readOnlyCancelNative, isCancelled: () => readOnlyCancelled, onProgress: () => { if (fs.readdirSync(root).some(name => name.includes('.cross-volume-readonly-cancel-target.bin.') && name.endsWith('.photoflow-cross-volume'))) readOnlyCancelled = true; } }), error => error.code === CANCELLED_CODE);
    assert(fs.existsSync(readOnlyCancelSource)); assert(!fs.existsSync(readOnlyCancelTarget)); assert(!fs.readdirSync(root).some(name => name.includes('.cross-volume-readonly-cancel-target.bin.') && name.endsWith('.photoflow-cross-volume')), 'owned read-only staging is removed on cancellation');

    const sourceRaceSource = path.join(root, 'cross-volume-source-race-source.bin');
    const sourceRaceTarget = path.join(root, 'cross-volume-source-race-target.bin');
    const sourceRaceOriginal = `${sourceRaceSource}.original`;
    fs.writeFileSync(sourceRaceSource, 'same bytes source replacement');
    let sourceRaceInjected = false;
    const sourceRaceNative = {
      ...nativePublication,
      nativeAvailable: () => true,
      moveNoReplace: async (source, destination) => path.resolve(source) === path.resolve(sourceRaceSource)
        ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' }))
        : nativePublication.moveNoReplace(source, destination),
    };
    let sourceRaceError;
    await assert.rejects(moveFileAtomic(sourceRaceSource, sourceRaceTarget, {
      nativePublicationService: sourceRaceNative,
      onProgress: () => {
        if (sourceRaceInjected || !fs.readdirSync(root).some(name => name.includes('.cross-volume-source-race-target.bin.') && name.endsWith('.photoflow-cross-volume'))) return;
        fs.renameSync(sourceRaceSource, sourceRaceOriginal);
        fs.writeFileSync(sourceRaceSource, 'same bytes source replacement');
        sourceRaceInjected = true;
      },
    }), error => { sourceRaceError = error; return error.code === PUBLISH_PARTIAL_CODE && error.cleanupCode === 'PUBLISH_OWNERSHIP_CONFLICT' && error.published === false && error.transferStage === 'recovery-staging'; });
    assert(sourceRaceInjected, 'source replacement must be injected only after the staging copy was published');
    assert.strictEqual(fs.readFileSync(sourceRaceSource, 'utf8'), 'same bytes source replacement', 'pre-copy source identity rejects deletion of a same-byte replacement');
    assert(fs.existsSync(sourceRaceOriginal)); assert(!fs.existsSync(sourceRaceTarget)); assert(fs.existsSync(sourceRaceError.recoveryPath), 'owned staging remains recoverable after pre-publish identity rejection'); assert(!sourceRaceError.message.includes('内容已发布'), 'staging-only recovery must not claim the destination was published'); assert.strictEqual(sourceRaceError.destinationPath, sourceRaceTarget);

    const crossVolumeDirectorySource = path.join(root, 'cross-volume-directory-source');
    const crossVolumeDirectoryTarget = path.join(root, 'cross-volume-directory-target');
    fs.mkdirSync(path.join(crossVolumeDirectorySource, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(crossVolumeDirectorySource, 'nested', 'photo.jpg'), 'directory move');
    await movePathAtomic(crossVolumeDirectorySource, crossVolumeDirectoryTarget, {
      nativePublicationService: { ...nativePublication, nativeAvailable: () => true, moveNoReplace: async (source, target) => path.resolve(source) === path.resolve(crossVolumeDirectorySource) ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' })) : nativePublication.moveNoReplace(source, target) },
    });
    assert.strictEqual(fs.existsSync(crossVolumeDirectorySource), false, 'normal cross-volume directory move deletes the verified source tree');
    assert.strictEqual(fs.readFileSync(path.join(crossVolumeDirectoryTarget, 'nested', 'photo.jpg'), 'utf8'), 'directory move');
    assert.strictEqual(fs.readdirSync(root).some(name => name.endsWith('.photoflow-part')), false);

    const cleanupFailureSource = path.join(root, 'cross-volume-cleanup-failure-source');
    const cleanupFailureTarget = path.join(root, 'cross-volume-cleanup-failure-target');
    const cleanupFailureFiles = ['first.raw', 'nested/second.jpg', 'nested/third.mov'];
    for (const [index, relativePath] of cleanupFailureFiles.entries()) {
      const sourcePath = path.join(cleanupFailureSource, relativePath);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, `original-${index}`);
    }
    let sourceDeleteAttempt = 0;
    await assert.rejects(
      movePathAtomic(cleanupFailureSource, cleanupFailureTarget, {
        nativePublicationService: { ...nativePublication, nativeAvailable: () => true, moveNoReplace: async (source, target) => path.resolve(source) === path.resolve(cleanupFailureSource) ? Promise.reject(Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' })) : nativePublication.moveNoReplace(source, target), commitTreeFile: async request => { sourceDeleteAttempt += 1; if (sourceDeleteAttempt === 2) throw Object.assign(new Error('simulated source cleanup failure'), { code: 'EACCES' }); return nativePublication.commitTreeFile(request); } },
        removeFile: async (sourcePath, removeOptions) => {
          sourceDeleteAttempt += 1;
          if (sourceDeleteAttempt === 2) throw Object.assign(new Error('simulated source cleanup failure'), { code: 'EACCES' });
          await fs.promises.rm(sourcePath, removeOptions);
        },
      }),
      error => error.code === PUBLISH_PARTIAL_CODE && error.recoveryRequired && error.sourceRetained === true && error.recoveryPaths.length > 0 && error.recoveryPaths.every(candidate => fs.existsSync(candidate)),
    );
    assert.strictEqual(sourceDeleteAttempt, 2, 'the injected failure occurs at the second locked per-file commit');
    assert.strictEqual(fs.existsSync(path.join(cleanupFailureSource, cleanupFailureFiles[0])), false, 'the first source was deleted only after its target was locked and verified');
    assert.strictEqual(fs.existsSync(path.join(cleanupFailureSource, cleanupFailureFiles[1])), true, 'the failed source deletion must leave that source file in place');
    assert.strictEqual(fs.existsSync(cleanupFailureTarget), true, 'a committed target directory must survive source cleanup failure');
    for (const [index, relativePath] of cleanupFailureFiles.entries()) {
      const sourcePath = path.join(cleanupFailureSource, relativePath);
      const targetPath = path.join(cleanupFailureTarget, relativePath);
      assert(fs.existsSync(sourcePath) || fs.existsSync(targetPath), `${relativePath} must remain in at least one location`);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), `original-${index}`, `the target copy of ${relativePath} must remain complete`);
    }

    const rollbackProject = path.join(root, 'move-rollback-project');
    const rollbackDestination = path.join(rollbackProject, 'destination');
    fs.mkdirSync(rollbackDestination, { recursive: true });
    fs.writeFileSync(path.join(rollbackProject, 'first.txt'), 'first');
    fs.writeFileSync(path.join(rollbackProject, 'second.txt'), 'second');
    const rollbackHandlers = new Map();
    let moveAttempt = 0;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => rollbackHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => rollbackProject, activeProjectFileOperations: new Map(),
      assertInside, movePathAtomic: async (sourcePath, destinationPath, options) => {
        moveAttempt += 1;
        if (moveAttempt === 2) throw Object.assign(new Error('simulated middle move failure'), { code: 'EIO' });
        return movePathAtomic(sourcePath, destinationPath, options);
      },
      pushUndoOperation: async () => undefined, writeLog: () => undefined,
    });
    const rollbackResult = await rollbackHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'move', ['first.txt', 'second.txt'], 'destination',
    );
    assert.strictEqual(rollbackResult.success, false);
    assert.strictEqual(fs.readFileSync(path.join(rollbackProject, 'first.txt'), 'utf8'), 'first', 'a failed batch move must roll back earlier items');
    assert.strictEqual(fs.readFileSync(path.join(rollbackProject, 'second.txt'), 'utf8'), 'second');
    assert.strictEqual(fs.readdirSync(rollbackDestination).length, 0, 'rollback must leave no moved item in the destination');
    assert(rollbackResult.operationId && rollbackResult.affectedDirectories.includes('destination'));

    const deviceMoveProject = path.join(root, 'device-aware-move-project');
    const sameDeviceDestination = path.join(deviceMoveProject, 'same-device-target');
    const differentDeviceDestination = path.join(deviceMoveProject, 'mounted-volume-target');
    const sameDeviceSource = path.join(deviceMoveProject, 'same-device.txt');
    const differentDeviceSource = path.join(deviceMoveProject, 'different-device.txt');
    fs.mkdirSync(sameDeviceDestination, { recursive: true });
    fs.mkdirSync(differentDeviceDestination, { recursive: true });
    fs.writeFileSync(sameDeviceSource, 'same-device');
    fs.writeFileSync(differentDeviceSource, 'different-device');
    const mockedDeviceByPath = new Map([
      [path.resolve(sameDeviceSource).toLowerCase(), 7101],
      [path.resolve(sameDeviceDestination).toLowerCase(), 7101],
      [path.resolve(differentDeviceSource).toLowerCase(), 7101],
      [path.resolve(differentDeviceDestination).toLowerCase(), 9202],
    ]);
    let directDevicePublishCalls = 0;
    let fallbackDeviceMoveCalls = 0;
    const deviceAwareFs = {
      ...fs,
      statSync: (targetPath, options) => {
        const stat = fs.statSync(targetPath, options);
        const mockedDevice = mockedDeviceByPath.get(path.resolve(targetPath).toLowerCase());
        if (mockedDevice === undefined) return stat;
        return new Proxy(stat, {
          get: (target, property, receiver) => {
            if (property === 'dev') return mockedDevice;
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      promises: {
        ...fs.promises,
        rename: fs.promises.rename.bind(fs.promises),
      },
    };
    const deviceMoveHandlers = new Map();
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => deviceMoveHandlers.set(name, handler), on: () => {} },
      fs: deviceAwareFs, path, getProjectPath: () => deviceMoveProject, activeProjectFileOperations: new Map(),
      assertInside,
      publishPathNoClobber: (sourcePath, destinationPath) => { directDevicePublishCalls += 1; return publishPathNoClobber(sourcePath, destinationPath); },
      movePathAtomic: async (sourcePath, destinationPath, options) => {
        fallbackDeviceMoveCalls += 1;
        return movePathAtomic(sourcePath, destinationPath, options);
      },
      pushUndoOperation: async () => undefined, throwIfCancelled, writeLog: () => undefined,
    });
    const deviceMoveHandler = deviceMoveHandlers.get('workspace-file-operation');
    const sameDeviceMoveResult = await deviceMoveHandler(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'move', ['same-device.txt'], 'same-device-target',
    );
    assert.strictEqual(sameDeviceMoveResult.success, true, sameDeviceMoveResult.error);
    assert.strictEqual(fs.existsSync(sameDeviceSource), false, 'same-device direct move removes the source');
    assert.strictEqual(fs.readFileSync(path.join(sameDeviceDestination, 'same-device.txt'), 'utf8'), 'same-device', 'same-device direct move creates the destination');
    assert.strictEqual(directDevicePublishCalls, 1, 'same-device handler move uses the direct atomic no-clobber path');
    assert.strictEqual(fallbackDeviceMoveCalls, 0, 'same-device handler move does not invoke movePathAtomic');

    const postCommitMoveSource = path.join(deviceMoveProject, 'post-commit-move.txt'); fs.writeFileSync(postCommitMoveSource, 'post-commit-move'); mockedDeviceByPath.set(path.resolve(postCommitMoveSource).toLowerCase(), 7101); const postCommitMoveHandlers = new Map(); let postCommitMoveUndo = null;
    registerFileOperationsIpc({ Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto, ipcMain: { handle: (name, handler) => postCommitMoveHandlers.set(name, handler), on: () => {} }, fs: deviceAwareFs, path, getProjectPath: () => deviceMoveProject, activeProjectFileOperations: new Map(), assertInside, publishPathNoClobber: (sourcePath, destinationPath, options) => publishPathNoClobber(sourcePath, destinationPath, { ...options, nativePublicationService: { nativeAvailable: () => true, moveNoReplace: async (source, target) => { fs.renameSync(source, target); throw Object.assign(new Error('parent fsync reply lost'), { published: true, publishedPath: target, identity: 'post-commit-move-native' }); }, inspectPath: async () => ({ success: true, identity: 'post-commit-move-native' }) } }), movePathAtomic, pushUndoOperation: async operation => { postCommitMoveUndo = operation; return { undoToken: 'post-commit-move-undo' }; }, throwIfCancelled, writeLog: () => undefined });
    const postCommitMoveResult = await postCommitMoveHandlers.get('workspace-file-operation')({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'move', ['post-commit-move.txt'], 'same-device-target');
    const postCommitMoveTarget = path.join(sameDeviceDestination, 'post-commit-move.txt');
    assert.strictEqual(postCommitMoveResult.success, false); assert.strictEqual(postCommitMoveResult.published, true); assert.strictEqual(postCommitMoveResult.outcomeUnknown, false); assert.deepStrictEqual(postCommitMoveResult.recovery.publishedPaths, [postCommitMoveTarget]); assert.strictEqual(postCommitMoveUndo.kind, 'move', 'proven post-commit single move must record a safe move undo'); assert.strictEqual(fs.readFileSync(postCommitMoveTarget, 'utf8'), 'post-commit-move'); assert.strictEqual(fs.existsSync(postCommitMoveSource), false);

    directDevicePublishCalls = 0;
    const differentDeviceMoveResult = await deviceMoveHandler(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'move', ['different-device.txt'], 'mounted-volume-target',
    );
    assert.strictEqual(differentDeviceMoveResult.success, true, differentDeviceMoveResult.error);
    assert.strictEqual(fs.existsSync(differentDeviceSource), false, 'different-device fallback move removes the source');
    assert.strictEqual(fs.readFileSync(path.join(differentDeviceDestination, 'different-device.txt'), 'utf8'), 'different-device', 'different-device fallback move creates the destination');
    assert.strictEqual(directDevicePublishCalls, 0, 'different-device handler move never enters the same-device direct publish path');
    assert.strictEqual(fallbackDeviceMoveCalls, 1, 'different-device handler move invokes movePathAtomic fallback');

    const cancelSource = path.join(root, 'cancel-source.bin');
    const cancelTarget = path.join(root, 'cancel-target.bin');
    fs.writeFileSync(cancelSource, Buffer.alloc(12 * 1024 * 1024, 0x3c));
    let cancel = false;
    await assert.rejects(
      copyFileAtomic(cancelSource, cancelTarget, {
        isCancelled: () => cancel,
        onProgress: value => { if (value.bytesCopied >= 4 * 1024 * 1024) cancel = true; },
      }),
      error => error.code === CANCELLED_CODE,
    );
    assert.strictEqual(fs.existsSync(cancelTarget), false);
    assert.strictEqual(fs.readdirSync(root).some(name => name.endsWith('.photoflow-part')), false);

    const batchSource = path.join(root, 'batch-source');
    const batchTarget = path.join(root, 'batch-target');
    fs.mkdirSync(path.join(batchSource, 'nested', 'empty'), { recursive: true });
    for (let index = 0; index < 96; index += 1) {
      const directory = index % 2 ? batchSource : path.join(batchSource, 'nested');
      fs.writeFileSync(path.join(directory, `small-${index}.bin`), Buffer.alloc(8 * 1024, index));
    }
    fs.writeFileSync(path.join(batchSource, 'large.bin'), Buffer.alloc(3 * 1024 * 1024, 0x4b));
    const batchPlan = [];
    await collectCopyPlan(batchSource, batchTarget, batchPlan);
    let batchBytesCopied = 0;
    let batchFilesCopied = 0;
    const batchCreated = [];
    const batchStats = await copyPlannedFiles(batchPlan, {
      destinationRoot: root,
      onCreated: target => batchCreated.push(target),
      onProgress: progress => {
        batchBytesCopied += progress.bytesDelta;
        if (progress.fileCompleted) batchFilesCopied += 1;
      },
    });
    assert.strictEqual(batchStats.smallFilesCopied, 96);
    assert.strictEqual(batchStats.largeFilesCopied, 1);
    assert.strictEqual(batchStats.peakSmallConcurrency, DEFAULT_SMALL_FILE_CONCURRENCY);
    let replayWrites = 0;
    const replayStats = await copyPlannedFiles(batchPlan, {
      destinationRoot: root,
      isEntryComplete: async entry => {
        const stat = await fs.promises.stat(entry.destination).catch(() => null);
        return entry.kind === 'directory' ? Boolean(stat?.isDirectory()) : Boolean(stat?.isFile() && stat.size === entry.size);
      },
      onEntryComplete: async () => { replayWrites += 1; },
    });
    assert.strictEqual(replayStats.resumedFiles, 97, 'a resumed copy must skip every previously committed file');
    assert.strictEqual(replayStats.smallFilesCopied, 0);
    assert.strictEqual(replayStats.largeFilesCopied, 0);
    assert.strictEqual(replayWrites, 0, 'skipped checkpoint entries must not be committed again');
    const pausedSource = path.join(root, 'paused-source.bin');
    const pausedTarget = path.join(root, 'paused-target.bin');
    fs.writeFileSync(pausedSource, Buffer.alloc(4 * 1024 * 1024, 0x2a));
    const pausedPlan = [];
    await collectCopyPlan(pausedSource, pausedTarget, pausedPlan);
    let releasePause;
    let paused = true;
    const pausePromise = new Promise(resolve => { releasePause = resolve; });
    const pausedCopy = copyPlannedFiles(pausedPlan, {
      destinationRoot: root,
      waitIfPaused: async () => { if (paused) await pausePromise; },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(fs.existsSync(pausedTarget), false, 'a paused transfer must not commit its target');
    paused = false;
    releasePause();
    await pausedCopy;
    assert.strictEqual(fs.statSync(pausedTarget).size, fs.statSync(pausedSource).size, 'continued transfer must complete the target');

    const resumedPasteProject = path.join(root, 'resumed-paste-project');
    const resumedPasteSources = path.join(root, 'resumed-paste-sources');
    fs.mkdirSync(resumedPasteProject);
    fs.mkdirSync(resumedPasteSources);
    const resumeSourceA = path.join(resumedPasteSources, 'first.bin');
    const resumeSourceB = path.join(resumedPasteSources, 'second.bin');
    const resumeSourceFolder = path.join(resumedPasteSources, 'folder');
    fs.writeFileSync(resumeSourceA, Buffer.alloc(1024, 0x31));
    fs.writeFileSync(resumeSourceB, Buffer.alloc(2048, 0x32));
    fs.mkdirSync(resumeSourceFolder);
    fs.writeFileSync(path.join(resumeSourceFolder, 'nested.txt'), 'resumed-folder');
    const resumeOperationId = 'paste-resume-test';
    const resumeCheckpoint = {
      version: 1, kind: 'paste-copy-v1', phase: 'copying', workspacePath: 'workspace', status: '策划中', projectName: 'project', targetRelativePath: '',
      files: [resumeSourceA, resumeSourceB, resumeSourceFolder].map((source, index) => {
        const stat = fs.statSync(source);
        return { source, destinationName: path.basename(source), stagedName: `${index}-${path.basename(source)}`, size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() };
      }),
    };
    const resumePersistencePath = path.join(root, 'paste-resume-tasks.json');
    const interruptedPasteTasks = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath: resumePersistencePath });
    const interruptedPaste = interruptedPasteTasks.create({ id: resumeOperationId, type: 'project-file-operation', title: '粘贴恢复测试' });
    await interruptedPaste.waitForStart();
    interruptedPaste.context.saveCheckpoint(resumeCheckpoint, 40, '正在粘贴');
    const incomingResumeRoot = path.join(resumedPasteProject, `.photoflow-paste-${resumeOperationId}`);
    fs.mkdirSync(incomingResumeRoot);
    const resumeFingerprintPlan = [];
    for (const item of resumeCheckpoint.files) await collectCopyPlan(item.source, path.join(incomingResumeRoot, item.stagedName), resumeFingerprintPlan);
    resumeCheckpoint.planFingerprint = crypto.createHash('sha256').update(resumeFingerprintPlan.map(entry => JSON.stringify({ kind: entry.kind, source: path.resolve(entry.source), size: Number(entry.size) || 0, identity: entry.sourceIdentity || {}, children: entry.children || [] })).sort().join('\n')).digest('hex');
    interruptedPaste.context.saveCheckpoint(resumeCheckpoint, 40, '正在粘贴');
    const completedStage = path.join(incomingResumeRoot, resumeCheckpoint.files[0].stagedName);
    fs.copyFileSync(resumeSourceA, completedStage);
    fs.utimesSync(completedStage, fs.statSync(resumeSourceA).atime, fs.statSync(resumeSourceA).mtime);
    interruptedPasteTasks.stop();
    const restoredPasteTasks = createBackgroundTaskService({ eventBus: new EventEmitter(), persistencePath: resumePersistencePath });
    let resumedPasteUndo = null;
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: () => undefined, on: () => undefined }, fs, path,
      getProjectPath: () => resumedPasteProject, activeProjectFileOperations: new Map(), backgroundTasks: restoredPasteTasks,
      assertInside, assertDiskSpace, collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      pushUndoOperation: async operation => { resumedPasteUndo = operation; }, writeLog: () => undefined,
    });
    assert.strictEqual(restoredPasteTasks.get(resumeOperationId).resumeAvailable, true, 'an interrupted plain file paste must expose continue');
    const resumedPaste = await restoredPasteTasks.resume(resumeOperationId);
    assert.strictEqual(resumedPaste.task.state, 'completed');
    assert.strictEqual(fs.readFileSync(path.join(resumedPasteProject, 'first.bin')).length, 1024);
    assert.strictEqual(fs.readFileSync(path.join(resumedPasteProject, 'second.bin')).length, 2048);
    assert.strictEqual(fs.readFileSync(path.join(resumedPasteProject, 'folder', 'nested.txt'), 'utf8'), 'resumed-folder');
    assert.strictEqual(fs.existsSync(incomingResumeRoot), false);
    assert.deepStrictEqual(resumedPasteUndo.paths.sort(), [path.join(resumedPasteProject, 'first.bin'), path.join(resumedPasteProject, 'second.bin'), path.join(resumedPasteProject, 'folder')].sort());
    restoredPasteTasks.stop();
    assert.strictEqual(batchFilesCopied, 97);
    assert.strictEqual(batchBytesCopied, batchPlan.reduce((sum, entry) => sum + entry.size, 0));
    assert(batchCreated.includes(batchTarget));
    assert.strictEqual(fs.readFileSync(path.join(batchTarget, 'nested', 'small-0.bin'))[0], 0);
    assert.strictEqual(fs.statSync(path.join(batchTarget, 'large.bin')).size, 3 * 1024 * 1024);
    assert(fs.statSync(path.join(batchTarget, 'nested', 'empty')).isDirectory());

    const cancelBatchSource = path.join(root, 'cancel-batch-source');
    const cancelBatchTarget = path.join(root, 'cancel-batch-target');
    fs.mkdirSync(cancelBatchSource);
    for (let index = 0; index < 32; index += 1) {
      fs.writeFileSync(path.join(cancelBatchSource, `small-${index}.bin`), Buffer.alloc(512 * 1024, index));
    }
    const cancelBatchPlan = [];
    await collectCopyPlan(cancelBatchSource, cancelBatchTarget, cancelBatchPlan);
    let cancelBatch = false;
    await assert.rejects(
      copyPlannedFiles(cancelBatchPlan, {
        isCancelled: () => cancelBatch,
        onProgress: progress => { if (progress.fileCompleted) cancelBatch = true; },
      }),
      error => error.code === CANCELLED_CODE,
    );
    assert.strictEqual(fs.readdirSync(root, { recursive: true }).some(name => String(name).endsWith('.photoflow-part')), false);
    await removeCreatedPasteTargets([cancelBatchTarget]);
    assert.strictEqual(fs.existsSync(cancelBatchTarget), false);

    const partialBatchRoot = path.join(root, 'partial-batch-ownership'); fs.mkdirSync(partialBatchRoot); const partialBatchPlan = [];
    for (let index = 0; index < 2; index += 1) { const sourcePath = path.join(partialBatchRoot, `source-${index}.txt`); fs.writeFileSync(sourcePath, `batch-${index}`); await collectCopyPlan(sourcePath, path.join(partialBatchRoot, `target-${index}.txt`), partialBatchPlan); }
    let partialBatchInspectCalls = 0;
    const partialBatchNative = { nativeAvailable: () => true, inspectPathsBatch: async paths => { partialBatchInspectCalls += 1; if (partialBatchInspectCalls === 1) return paths.map((candidate, index) => ({ success: true, identity: `batch-stage-${index}`, path: candidate })); return [{ success: false }, { success: true, identity: 'batch-stage-1' }, { success: true, identity: 'batch-stage-0' }, { success: false }]; }, moveNoReplaceBatch: async requests => { fs.renameSync(requests[0].source, requests[0].target); throw Object.assign(new Error('second batch result unknown'), { completed: [{ index: 0, identity: requests[0].identity, strategy: 'test-batch' }], failedIndex: 1, outcomeUnknown: true, published: false }); }, deletePathsBatch: async requests => requests.map((request, index) => { if (fs.existsSync(request.path)) fs.unlinkSync(request.path); return { index, success: true }; }) };
    let partialBatchError;
    await assert.rejects(copyPlannedFiles(partialBatchPlan, { ownershipToken: 'partial-batch-owner', nativePublicationService: partialBatchNative }), error => { partialBatchError = error; return error.code === PUBLISH_PARTIAL_CODE && error.outcomeUnknown === true; });
    const provenBatchTarget = path.join(partialBatchRoot, 'target-0.txt'); const uncertainBatchTarget = path.join(partialBatchRoot, 'target-1.txt');
    Object.assign(partialBatchError, { nativeCode: 'NATIVE_BATCH_UNKNOWN', rollbackError: 'rollback diagnostic', attemptedStagingPath: path.join(partialBatchRoot, '.attempted-stage'), stagingExists: false, targetExists: true });
    assert.deepStrictEqual(partialBatchError.ownershipSnapshot.map(item => path.resolve(item.path)), [path.resolve(provenBatchTarget)], 'batch partial ownership must retain the proven first item and exclude the unknown second item'); assert.strictEqual(fs.existsSync(uncertainBatchTarget), false);
    releaseCleanupOwnership(partialBatchError.ownershipToken);
    assert.deepStrictEqual(partialBatchError.ownershipSnapshot.map(item => path.resolve(item.path)), [path.resolve(provenBatchTarget)], 'releasing the ledger must not erase the error recovery snapshot already returned to IPC');

    const partialBatchIpcHandlers = new Map(); let partialBatchUndo = null; const partialBatchImportSource = path.join(root, 'partial-batch-import-source.txt'); fs.writeFileSync(partialBatchImportSource, 'import');
    registerFileOperationsIpc({ Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto, ipcMain: { handle: (name, handler) => partialBatchIpcHandlers.set(name, handler), on: () => {} }, fs, path, getProjectPath: () => partialBatchRoot, activeProjectFileOperations: new Map(), fileOperationState: { projectFileClipboard: null }, writeLog: () => {}, assertInside, assertDiskSpace, collectCopyPlan, capturePathIdentity, samePathIdentity, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination, copyPlannedFiles: async () => { throw partialBatchError; }, backgroundTasks: { create: () => ({ deduplicated: false, context: { signal: new AbortController().signal, report: () => {}, acquireResourceLease: async () => ({ release: () => true }) }, waitForStart: async () => {}, complete: () => {}, fail: () => {}, cancelled: () => {}, isFinished: () => false }), cancel: () => false }, pushUndoOperation: async operation => { partialBatchUndo = operation; return { undoToken: 'partial-batch-undo' }; } });
    const partialBatchIpcResult = await partialBatchIpcHandlers.get('workspace-file-operation')({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'import', [partialBatchImportSource], '');
    assert.deepStrictEqual(partialBatchIpcResult.recovery.publishedPaths.map(item => path.resolve(item)), [path.resolve(provenBatchTarget)]); assert.deepStrictEqual(partialBatchUndo.paths.map(item => path.resolve(item)), [path.resolve(provenBatchTarget)], 'IPC must build recovery undo for the proven completed batch item after ledger release');
    assert.deepStrictEqual(partialBatchIpcResult.recoveryPaths, partialBatchError.recoveryPaths); assert.strictEqual(partialBatchIpcResult.nativeCode, 'NATIVE_BATCH_UNKNOWN'); assert.strictEqual(partialBatchIpcResult.rollbackError, 'rollback diagnostic'); assert.strictEqual(partialBatchIpcResult.attemptedStagingPath, partialBatchError.attemptedStagingPath); assert.strictEqual(partialBatchIpcResult.stagingExists, false); assert.strictEqual(partialBatchIpcResult.targetExists, true);
    const runExplicitUncertainOwnership = async uncertainPath => {
      const operationId = `uncertain-owner-${crypto.randomUUID()}`; const handlers = new Map(); let undoCalls = 0;
      const ownership = partialBatchError.ownershipSnapshot[0];
      const uncertaintyError = Object.assign(new Error('explicit uncertain ownership'), { code: PUBLISH_PARTIAL_CODE, published: true, publishedIdentity: ownership.identity, destinationPath: provenBatchTarget, ownershipToken: operationId, ownershipSnapshot: [{ ...ownership, ownershipToken: operationId }], uncertainPaths: [uncertainPath] });
      registerFileOperationsIpc({ Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto: { ...crypto, randomUUID: () => operationId }, ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} }, fs, path, getProjectPath: () => partialBatchRoot, activeProjectFileOperations: new Map(), fileOperationState: { projectFileClipboard: null }, writeLog: () => {}, assertInside, assertDiskSpace, collectCopyPlan, capturePathIdentity, samePathIdentity, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination, copyPlannedFiles: async () => { throw uncertaintyError; }, backgroundTasks: { create: () => ({ deduplicated: false, context: { signal: new AbortController().signal, report: () => {}, acquireResourceLease: async () => ({ release: () => true }) }, waitForStart: async () => {}, complete: () => {}, fail: () => {}, cancelled: () => {}, isFinished: () => false }), cancel: () => false }, pushUndoOperation: async () => { undoCalls += 1; } });
      const result = await handlers.get('workspace-file-operation')({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'import', [partialBatchImportSource], '');
      assert.deepStrictEqual(result.recovery.publishedPaths, [], 'an explicitly uncertain path must never be upgraded by a matching ownership snapshot'); assert.strictEqual(undoCalls, 0, 'explicitly uncertain ownership must not create remove-created undo'); assert(result.uncertainPaths.some(candidate => physicalPathKey(candidate) === physicalPathKey(provenBatchTarget)), 'explicit uncertainty remains reported');
    };
    await runExplicitUncertainOwnership(provenBatchTarget);
    if (process.platform === 'win32') await runExplicitUncertainOwnership(provenBatchTarget.toUpperCase());
    fs.unlinkSync(provenBatchTarget); fs.writeFileSync(provenBatchTarget, 'replacement after ownership snapshot'); partialBatchUndo = null;
    const replacedBatchIpcResult = await partialBatchIpcHandlers.get('workspace-file-operation')({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'import', [partialBatchImportSource], '');
    assert.deepStrictEqual(replacedBatchIpcResult.recovery.publishedPaths, [], 'identity-changed ownership must be excluded from destructive recovery'); assert.strictEqual(partialBatchUndo, null, 'identity-changed ownership must not create an undo claim'); assert(replacedBatchIpcResult.uncertainPaths.map(candidate => path.resolve(candidate)).includes(path.resolve(provenBatchTarget)), 'identity-changed ownership is reported as uncertain'); assert.strictEqual(fs.readFileSync(provenBatchTarget, 'utf8'), 'replacement after ownership snapshot'); fs.unlinkSync(provenBatchTarget);

    assert.strictEqual(assertInside(root, path.join(root, 'child'), 'test'), path.join(root, 'child'));
    assert.throws(() => assertInside(root, path.join(root, '..', 'outside'), 'test'), /超出允许的目录/);
    const reserved = new Set();
    const first = uniqueDestination(root, 'new.jpg', reserved);
    const second = uniqueDestination(root, 'new.jpg', reserved);
    assert.notStrictEqual(first, second);
    const dottedFolderReserved = new Set();
    const dottedFolder = uniqueDestination(root, 'photos.raw', dottedFolderReserved, true);
    const dottedFolderCopy = uniqueDestination(root, 'photos.raw', dottedFolderReserved, true);
    assert.strictEqual(path.basename(dottedFolder), 'photos.raw');
    assert.strictEqual(path.basename(dottedFolderCopy), 'photos.raw (1)');

    const changedSource = path.join(root, 'changed-after-copy.txt');
    fs.writeFileSync(changedSource, 'before');
    const changedPlan = [];
    await collectCopyPlan(changedSource, path.join(root, 'changed-copy.txt'), changedPlan);
    fs.appendFileSync(changedSource, '-changed');
    await assert.rejects(assertCopyPlanSourcesUnchanged(changedPlan), /发生变化/);
    await assert.rejects(removeCopiedSources(changedPlan), /发生变化/);
    assert.strictEqual(fs.existsSync(changedSource), true);

    const growingSource = path.join(root, 'growing-source');
    fs.mkdirSync(growingSource);
    fs.writeFileSync(path.join(growingSource, 'copied.txt'), 'copied');
    const growingPlan = [];
    await collectCopyPlan(growingSource, path.join(root, 'growing-copy'), growingPlan);
    fs.writeFileSync(path.join(growingSource, 'new.txt'), 'new during copy');
    await assert.rejects(removeCopiedSources(growingPlan), /发生变化/);
    assert.strictEqual(fs.readFileSync(path.join(growingSource, 'new.txt'), 'utf8'), 'new during copy');

    const cleanupRootsBeforePostUnlink = new Set(fs.readdirSync(root).filter(name => name.startsWith('.photoflow-cleanup-'))); const postUnlinkSource = path.join(root, 'post-unlink-cut-source.txt'); fs.writeFileSync(postUnlinkSource, 'post-unlink-cut'); const postUnlinkPlan = []; await collectCopyPlan(postUnlinkSource, path.join(root, 'post-unlink-cut-target.txt'), postUnlinkPlan); let postUnlinkDeletes = 0;
    const postUnlinkNative = { ...nativePublication, compareDeleteFile: async ({ target }) => { postUnlinkDeletes += 1; fs.unlinkSync(target); throw Object.assign(new Error('post-unlink fsync failed'), { code: 'EIO', deleted: true, cleanupWarning: true, outcomeUnknown: true, phase: 'post-unlink-cleanup', originalMissing: true }); } };
    const postUnlinkOutcome = await removeCopiedSources(postUnlinkPlan, { ownershipToken: 'post-unlink-cut', nativePublicationService: postUnlinkNative });
    assert.strictEqual(postUnlinkOutcome.success, true); assert.strictEqual(postUnlinkOutcome.outcomeUnknown, true); assert.match(postUnlinkOutcome.cleanupWarning, /持久化确认失败/); assert.strictEqual(postUnlinkOutcome.phase, 'post-unlink-cleanup'); assert.deepStrictEqual(postUnlinkOutcome.recoveryPaths, []); assert.strictEqual(fs.existsSync(postUnlinkSource), false); assert.deepStrictEqual(new Set(fs.readdirSync(root).filter(name => name.startsWith('.photoflow-cleanup-'))), cleanupRootsBeforePostUnlink, 'empty owned outer quarantine is removed after terminal post-unlink success');
    fs.writeFileSync(postUnlinkSource, 'replacement after terminal delete'); await assert.rejects(removeCopiedSources(postUnlinkPlan, { ownershipToken: 'post-unlink-cut-retry', nativePublicationService: postUnlinkNative }), /发生变化/); assert.strictEqual(postUnlinkDeletes, 1, 'retry must stop before deleting a replacement at the original source path'); assert.strictEqual(fs.readFileSync(postUnlinkSource, 'utf8'), 'replacement after terminal delete');

    const batchDeletedSource = path.join(root, 'batch-deleted-cut-source.txt'); fs.writeFileSync(batchDeletedSource, 'batch-deleted-cut'); const batchDeletedPlan = []; await collectCopyPlan(batchDeletedSource, path.join(root, 'batch-deleted-cut-target.txt'), batchDeletedPlan);
    const batchDeletedNative = { ...nativePublication, compareDeleteFile: undefined, deletePathsBatch: async requests => requests.map(({ path: target }) => { fs.unlinkSync(target); return { success: false, code: 'EIO', deleted: true, cleanupWarning: 'batch post-unlink warning', outcomeUnknown: true, phase: 'batch-post-unlink', originalMissing: true }; }) };
    const batchDeletedOutcome = await removeCopiedSources(batchDeletedPlan, { ownershipToken: 'batch-deleted-cut', nativePublicationService: batchDeletedNative });
    assert.strictEqual(batchDeletedOutcome.success, true); assert.match(batchDeletedOutcome.cleanupWarning, /batch post-unlink warning/); assert.strictEqual(batchDeletedOutcome.outcomeUnknown, true); assert.strictEqual(batchDeletedOutcome.phase, 'batch-post-unlink'); assert.deepStrictEqual(batchDeletedOutcome.recoveryPaths, []); assert.strictEqual(fs.existsSync(batchDeletedSource), false);

    const dragImportProject = path.join(root, 'drag-import-project');
    const dragImportSource = path.join(root, 'drag-import-source');
    fs.mkdirSync(dragImportProject);
    fs.mkdirSync(path.join(dragImportSource, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dragImportSource, 'nested', 'photo.jpg'), Buffer.alloc(2 * 1024 * 1024, 0x6a));
    const dragImportHandlers = new Map();
    const dragImportReports = [];
    let dragImportCompleted = '';
    let dragImportUndo;
    const dragImportAbort = new AbortController();
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => dragImportHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => dragImportProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, writeLog: () => {},
      assertInside, assertDiskSpace, collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      backgroundTasks: {
        create: () => ({
          deduplicated: false,
          context: {
            signal: dragImportAbort.signal,
            report: (progress, message, metadata) => dragImportReports.push({ progress, message, metadata }),
            acquireResourceLease: async () => ({ release: () => true }),
          },
          waitForStart: async () => {},
          complete: message => { dragImportCompleted = message; },
          fail: error => { throw error; },
          cancelled: () => {},
          isFinished: () => false,
        }),
        cancel: () => dragImportAbort.abort(),
      },
      pushUndoOperation: async operation => { dragImportUndo = operation; },
    });
    const dragImportResult = await dragImportHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'import', [dragImportSource], '',
    );
    assert.strictEqual(dragImportResult.success, true);
    assert.strictEqual(fs.statSync(path.join(dragImportProject, 'drag-import-source', 'nested', 'photo.jpg')).size, 2 * 1024 * 1024);
    assert(dragImportReports.some(report => report.progress === 100 && report.metadata.operation === 'import'), 'drag import must publish completion through the shared file-transfer task');
    assert(dragImportReports.some(report => report.metadata.totalBytes === 2 * 1024 * 1024 && report.metadata.totalFiles === 1), 'drag import must publish byte and file totals');
    assert.strictEqual(dragImportCompleted, '文件导入完成');
    assert.strictEqual(dragImportUndo.kind, 'remove-created');

    const cancelledDragProject = path.join(root, 'cancelled-drag-project');
    const cancelledDragSource = path.join(root, 'cancelled-drag-source');
    fs.mkdirSync(cancelledDragProject);
    fs.mkdirSync(cancelledDragSource);
    fs.writeFileSync(path.join(cancelledDragSource, 'partial.bin'), Buffer.alloc(1024, 0x2a));
    const cancelledDragHandlers = new Map();
    const cancelledDragAbort = new AbortController();
    let cancelledDragReported = false;
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => cancelledDragHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => cancelledDragProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, writeLog: () => {},
      assertInside, assertDiskSpace, collectCopyPlan, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      copyPlannedFiles: async (plan, options) => {
        const fileEntry = plan.find(entry => entry.kind === 'file');
        fs.mkdirSync(path.dirname(fileEntry.destination), { recursive: true });
        options.onCreated(path.dirname(fileEntry.destination));
        fs.writeFileSync(fileEntry.destination, 'partial');
        cancelledDragAbort.abort();
        throwIfCancelled(options.isCancelled);
      },
      backgroundTasks: {
        create: () => ({
          deduplicated: false,
          context: { signal: cancelledDragAbort.signal, report: () => {}, acquireResourceLease: async () => ({ release: () => true }) },
          waitForStart: async () => {},
          complete: () => {},
          fail: () => {},
          cancelled: () => { cancelledDragReported = true; },
          isFinished: () => false,
        }),
        cancel: () => cancelledDragAbort.abort(),
      },
      pushUndoOperation: async () => {},
    });
    const cancelledDragResult = await cancelledDragHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'import', [cancelledDragSource], '',
    );
    assert.strictEqual(cancelledDragResult.cancelled, true);
    assert.strictEqual(cancelledDragReported, true);
    assert.strictEqual(fs.existsSync(path.join(cancelledDragProject, 'cancelled-drag-source')), true, 'rollback must retain targets created by an unowned injected writer');

    const unknownImportProject = path.join(root, 'unknown-import-project'); const unknownImportSource = path.join(root, 'unknown-import-source.txt'); fs.mkdirSync(unknownImportProject); fs.writeFileSync(unknownImportSource, 'source'); const unknownImportHandlers = new Map(); let unknownImportUndo = null;
    registerFileOperationsIpc({ Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto, ipcMain: { handle: (name, handler) => unknownImportHandlers.set(name, handler), on: () => {} }, fs, path, getProjectPath: () => unknownImportProject, activeProjectFileOperations: new Map(), fileOperationState: { projectFileClipboard: null }, writeLog: () => {}, assertInside, assertDiskSpace, collectCopyPlan, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination, copyPlannedFiles: async plan => { const destination = plan.find(entry => entry.kind === 'file').destination; fs.writeFileSync(destination, 'unrelated replacement'); throw Object.assign(new Error('unknown import publication'), { code: PUBLISH_PARTIAL_CODE, transferStage: 'commit-target-outcome', destinationPath: destination, outcomeUnknown: true, published: false, recoveryRequired: true, sourceRetained: true, ownershipToken: 'unknown-import-token', ownershipSnapshot: [] }); }, backgroundTasks: { create: () => ({ deduplicated: false, context: { signal: new AbortController().signal, report: () => {}, acquireResourceLease: async () => ({ release: () => true }) }, waitForStart: async () => {}, complete: () => {}, fail: () => {}, cancelled: () => {}, isFinished: () => false }), cancel: () => false }, pushUndoOperation: async operation => { unknownImportUndo = operation; } });
    const unknownImportResult = await unknownImportHandlers.get('workspace-file-operation')({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'import', [unknownImportSource], '');
    assert.strictEqual(unknownImportResult.success, false); assert.strictEqual(unknownImportResult.outcomeUnknown, true); assert.strictEqual(unknownImportResult.published, false); assert.deepStrictEqual(unknownImportResult.recovery.publishedPaths, []); assert.strictEqual(unknownImportUndo, null, 'unknown/preexisting import targets must never create destructive undo'); assert.strictEqual(fs.readFileSync(path.join(unknownImportProject, 'unknown-import-source.txt'), 'utf8'), 'unrelated replacement');

    const conflictProject = path.join(root, 'conflict-project');
    const conflictExternal = path.join(root, 'conflict-external');
    fs.mkdirSync(conflictProject);
    fs.mkdirSync(conflictExternal);
    const staleInternal = path.join(conflictExternal, 'old.txt');
    const currentSystem = path.join(conflictExternal, 'same.jpg');
    fs.writeFileSync(staleInternal, 'old clipboard');
    fs.writeFileSync(currentSystem, 'new clipboard');
    fs.writeFileSync(path.join(conflictProject, 'same.jpg'), 'existing destination');
    const handlers = new Map();
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => conflictProject, activeProjectFileOperations: new Map(),
      assertInside, assertExistingInside, capturePathIdentity, samePathIdentity,
      fileOperationState: { projectFileClipboard: { operation: 'copy', sources: [staleInternal] } },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [currentSystem] }),
      mainWindow: null, writeLog: () => {},
    });
    const conflictResult = await handlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '',
    );
    assert.strictEqual(conflictResult.success, true);
    assert.strictEqual(conflictResult.requiresDecision.kind, 'paste-conflict');
    assert(conflictResult.requiresDecision.message.includes('same.jpg'), 'the current Windows clipboard item must drive conflict detection');
    assert.strictEqual(fs.readFileSync(path.join(conflictProject, 'same.jpg'), 'utf8'), 'existing destination', 'decision preflight must not modify the destination');

    const protectedReplaceProject = path.join(root, 'protected-replace-project');
    const protectedReplaceSources = path.join(root, 'protected-replace-sources');
    fs.mkdirSync(protectedReplaceProject);
    fs.mkdirSync(protectedReplaceSources);
    const protectedRaw = path.join(protectedReplaceProject, 'RAW');
    const protectedVersions = path.join(protectedReplaceProject, 'versions');
    const protectedProgress = path.join(protectedVersions, 'v1');
    const protectedExternalLink = path.join(protectedReplaceProject, 'external-progress.lnk');
    const protectedManagedLink = path.join(protectedReplaceProject, 'ordinary-link.lnk');
    fs.mkdirSync(protectedRaw);
    fs.writeFileSync(path.join(protectedRaw, 'identity.txt'), 'raw identity');
    fs.mkdirSync(protectedProgress, { recursive: true });
    fs.writeFileSync(path.join(protectedProgress, 'identity.txt'), 'progress identity');
    fs.writeFileSync(protectedExternalLink, 'external progress identity');
    fs.writeFileSync(protectedManagedLink, 'ordinary managed identity');
    const replacementSources = {
      RAW: path.join(protectedReplaceSources, 'RAW'),
      versions: path.join(protectedReplaceSources, 'versions'),
      progress: path.join(protectedReplaceSources, 'progress-source', 'v1'),
      externalProgress: path.join(protectedReplaceSources, 'external-progress.lnk'),
      ordinaryLink: path.join(protectedReplaceSources, 'ordinary-link.lnk'),
    };
    fs.mkdirSync(replacementSources.RAW);
    fs.writeFileSync(path.join(replacementSources.RAW, 'incoming.txt'), 'incoming raw');
    fs.mkdirSync(replacementSources.versions);
    fs.writeFileSync(path.join(replacementSources.versions, 'incoming.txt'), 'incoming versions');
    fs.mkdirSync(replacementSources.progress, { recursive: true });
    fs.writeFileSync(path.join(replacementSources.progress, 'incoming.txt'), 'incoming progress');
    fs.writeFileSync(replacementSources.externalProgress, 'incoming external progress link');
    fs.writeFileSync(replacementSources.ordinaryLink, 'incoming ordinary link');
    let protectedReplaceClipboard = { operation: 'copy', sources: [replacementSources.RAW] };
    let protectedReplaceUndoCalls = 0;
    const protectedReplaceHandlers = new Map();
    const managedLinkPaths = new Set([path.resolve(protectedExternalLink), path.resolve(protectedManagedLink)]);
    const protectedReplaceVirtualPaths = {
      listManagedExternalLinks: () => [
        { shortcutPath: protectedExternalLink, shortcutVirtualPath: 'external-progress.lnk' },
        { shortcutPath: protectedManagedLink, shortcutVirtualPath: 'ordinary-link.lnk' },
      ],
      readManagedExternalLink: candidate => managedLinkPaths.has(path.resolve(candidate)) ? { linkId: 'managed' } : null,
      resolve: (projectRoot, relativePath) => ({
        projectRoot,
        physicalPath: path.resolve(projectRoot, relativePath || '.'),
        virtualPath: String(relativePath || '').replace(/\\/g, '/'),
        viaExternalLink: false,
        isExternalLinkRoot: false,
      }),
      toVirtualPath: (projectRoot, physicalPath) => path.relative(projectRoot, physicalPath).replace(/\\/g, '/'),
    };
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => protectedReplaceHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => protectedReplaceProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, ensureWorkspace: () => root,
      projectVirtualPaths: protectedReplaceVirtualPaths,
      versionService: { listProgress: async () => ({ success: true, progressFolders: [
        { id: 'local-progress', nodeRole: 'progress', displayName: 'V1', folderPath: protectedProgress },
        { id: 'external-progress', nodeRole: 'progress', displayName: 'External', folderPath: path.join(root, 'external-target'), externalLinkRelativePath: 'external-progress.lnk' },
      ] }) },
      readSystemFileClipboard: async () => protectedReplaceClipboard,
      writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, removeCopiedSources, throwIfCancelled, uniqueDestination,
      pushUndoOperation: async () => { protectedReplaceUndoCalls += 1; },
      recycleBinService: { trash: async () => { throw new Error('protected targets must never reach replacement recycling'); } },
      clearSystemFileClipboardIfCurrent: async () => ({ cleared: true }),
    });
    const protectedPaste = protectedReplaceHandlers.get('workspace-file-operation');
    for (const testCase of [
      { label: 'core directory', source: replacementSources.RAW, target: protectedRaw },
      { label: 'registered progress ancestor', source: replacementSources.versions, target: protectedVersions },
      { label: 'registered progress root', source: replacementSources.progress, target: protectedProgress, targetRelativePath: 'versions' },
      { label: 'external progress link', source: replacementSources.externalProgress, target: protectedExternalLink },
      { label: 'ordinary managed link', source: replacementSources.ordinaryLink, target: protectedManagedLink },
    ]) {
      protectedReplaceClipboard = { operation: 'copy', sources: [testCase.source] };
      const before = fs.statSync(testCase.target).isDirectory()
        ? fs.readdirSync(testCase.target, { recursive: true }).map(String).sort()
        : fs.readFileSync(testCase.target, 'utf8');
      const result = await protectedPaste(
        { sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], testCase.targetRelativePath || '', '', { pasteConflictPolicy: 'replace' },
      );
      assert.strictEqual(result.success, false, `${testCase.label} replacement must be rejected`);
      assert.match(result.error, /受保护的项目目标/);
      const after = fs.statSync(testCase.target).isDirectory()
        ? fs.readdirSync(testCase.target, { recursive: true }).map(String).sort()
        : fs.readFileSync(testCase.target, 'utf8');
      assert.deepStrictEqual(after, before, `${testCase.label} keeps its content and identity-bearing entry intact`);
      assert.strictEqual(fs.readdirSync(protectedReplaceProject).some(name => name.startsWith('.photoflow-')), false, 'protected replacement rejection is atomic and creates no staging root');
    }
    protectedReplaceClipboard = { operation: 'cut', sources: [replacementSources.ordinaryLink] };
    const blockedCutReplace = await protectedPaste(
      { sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], '', '', { pasteConflictPolicy: 'replace' },
    );
    assert.strictEqual(blockedCutReplace.success, false, 'cut-paste cannot bypass managed-link destination protection');
    assert.strictEqual(fs.readFileSync(replacementSources.ordinaryLink, 'utf8'), 'incoming ordinary link', 'rejected cut keeps its source in place');
    assert.strictEqual(fs.readFileSync(protectedManagedLink, 'utf8'), 'ordinary managed identity', 'rejected cut keeps destination identity intact');
    assert.strictEqual(protectedReplaceUndoCalls, 0, 'atomic destination rejection creates no misleading rollback or undo record');
    protectedReplaceClipboard = { operation: 'copy', sources: [replacementSources.RAW] };
    const keptBoth = await protectedPaste(
      { sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], '', '', { pasteConflictPolicy: 'keep-both' },
    );
    assert.strictEqual(keptBoth.success, true, keptBoth.error);
    assert.strictEqual(fs.readFileSync(path.join(protectedRaw, 'identity.txt'), 'utf8'), 'raw identity', 'keep-both does not touch the protected conflict target');
    assert(keptBoth.createdItems[0].name !== 'RAW' && fs.existsSync(path.join(protectedReplaceProject, keptBoth.createdItems[0].name, 'incoming.txt')), 'keep-both publishes only to its newly generated unprotected path');
    assert.strictEqual(protectedReplaceUndoCalls, 1, 'successful keep-both retains normal undo behavior');

    const watcherPasteProject = path.join(root, 'watcher-cut-paste-project');
    const watcherPasteTarget = path.join(watcherPasteProject, 'moved');
    const watcherPasteSource = path.join(watcherPasteProject, 'linked-ancestor');
    const watcherPasteSibling = path.join(watcherPasteProject, 'sibling.txt');
    fs.mkdirSync(watcherPasteSource, { recursive: true });
    fs.mkdirSync(watcherPasteTarget);
    fs.writeFileSync(path.join(watcherPasteSource, 'tracked.lnk'), 'managed watcher entry');
    fs.writeFileSync(watcherPasteSibling, 'sibling');
    const watcherPasteHandlers = new Map();
    const watcherPasteOperations = new Map();
    let watcherPasteRefreshes = 0;
    let watcherPastePublishFailure = true;
    let watcherPrefixAtRefresh = '';
    const listWatcherLinks = () => {
      const oldShortcut = path.join(watcherPasteProject, 'linked-ancestor', 'tracked.lnk');
      const newShortcut = path.join(watcherPasteTarget, 'linked-ancestor', 'tracked.lnk');
      const shortcutPath = fs.existsSync(newShortcut) ? newShortcut : oldShortcut;
      return fs.existsSync(shortcutPath) ? [{
        shortcutPath,
        shortcutVirtualPath: path.relative(watcherPasteProject, shortcutPath).replace(/\\/g, '/'),
      }] : [];
    };
    const watcherPasteVirtualPaths = {
      listManagedExternalLinks: listWatcherLinks,
      readManagedExternalLink: () => null,
      resolve: (projectRoot, relativePath) => ({
        projectRoot,
        physicalPath: path.resolve(projectRoot, relativePath || '.'),
        virtualPath: String(relativePath || '').replace(/\\/g, '/'),
        viaExternalLink: false,
        isExternalLinkRoot: false,
      }),
      toVirtualPath: (projectRoot, physicalPath) => path.relative(projectRoot, physicalPath).replace(/\\/g, '/'),
    };
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process: { platform: 'win32' }, undefined, crypto,
      ipcMain: { handle: (name, handler) => watcherPasteHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => watcherPasteProject, activeProjectFileOperations: watcherPasteOperations,
      fileOperationState: { projectFileClipboard: null }, ensureWorkspace: () => root,
      projectVirtualPaths: watcherPasteVirtualPaths,
      versionService: { listProgress: async () => ({ success: true, progressFolders: [] }) },
      readSystemFileClipboard: async () => ({ operation: 'cut', sources: [watcherPasteSource, watcherPasteSibling] }),
      writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, removeCopiedSources, throwIfCancelled, uniqueDestination,
      clearSystemFileClipboardIfCurrent: async () => ({ cleared: true }),
      pushUndoOperation: async () => undefined,
      refreshManagedExternalWatchers: async () => {
        watcherPasteRefreshes += 1;
        watcherPrefixAtRefresh = listWatcherLinks()[0]?.shortcutVirtualPath || '';
      },
      publishPathNoClobber: async (source, destination) => {
        if (watcherPastePublishFailure && path.resolve(source) === path.resolve(watcherPasteSibling)) {
          watcherPastePublishFailure = false;
          throw Object.assign(new Error('simulated cancelled second cut publication'), { code: CANCELLED_CODE });
        }
        return publishPathNoClobber(source, destination);
      },
    });
    const watcherPaste = watcherPasteHandlers.get('workspace-file-operation');
    const rolledBackWatcherPaste = await watcherPaste(
      { sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], 'moved', '', {},
    );
    assert.strictEqual(rolledBackWatcherPaste.success, false);
    assert.strictEqual(rolledBackWatcherPaste.cancelled, true, 'a cancelled cut-paste reports cancellation after rolling back prior moves');
    assert.strictEqual(watcherPasteRefreshes, 0, 'failed/cancelled cut-paste keeps the old watcher and never refreshes early');
    assert.strictEqual(fs.existsSync(path.join(watcherPasteSource, 'tracked.lnk')), true, 'rollback restores the managed-link ancestor at its old route');
    assert.strictEqual(fs.existsSync(path.join(watcherPasteTarget, 'linked-ancestor')), false);
    const committedWatcherPaste = await watcherPaste(
      { sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], 'moved', '', {},
    );
    assert.strictEqual(committedWatcherPaste.success, true, committedWatcherPaste.error);
    assert.strictEqual(watcherPasteRefreshes, 1, 'a committed cut-paste refreshes managed external watchers exactly once');
    assert.strictEqual(watcherPrefixAtRefresh, 'moved/linked-ancestor/tracked.lnk', 'the rebuilt watcher observes the managed link under its new virtual prefix');
    assert.strictEqual(fs.existsSync(path.join(watcherPasteTarget, 'linked-ancestor', 'tracked.lnk')), true);

    const concurrentPublishProject = path.join(root, 'concurrent-publish-project');
    const concurrentPublishSourceRoot = path.join(root, 'concurrent-publish-source');
    fs.mkdirSync(concurrentPublishProject);
    fs.mkdirSync(concurrentPublishSourceRoot);
    const concurrentPublishSource = path.join(concurrentPublishSourceRoot, 'arriving.txt');
    const concurrentPublishTarget = path.join(concurrentPublishProject, 'arriving.txt');
    fs.writeFileSync(concurrentPublishSource, 'clipboard content');
    const concurrentPublishHandlers = new Map();
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => concurrentPublishHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => concurrentPublishProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [concurrentPublishSource] }),
      mainWindow: null, writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace,
      collectCopyPlan, copyPlannedFiles: async (plan, options) => {
        const result = await copyPlannedFiles(plan, options);
        fs.writeFileSync(concurrentPublishTarget, 'concurrent rename winner');
        return result;
      },
      removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
    });
    const concurrentPublishResult = await concurrentPublishHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '',
    );
    assert.strictEqual(concurrentPublishResult.success, false, 'a target created after scan must abort publication');
    assert.match(concurrentPublishResult.error, /目标已存在|同名项目/);
    assert.strictEqual(fs.readFileSync(concurrentPublishTarget, 'utf8'), 'concurrent rename winner', 'late concurrent content must never be overwritten');
    assert.strictEqual(fs.readdirSync(concurrentPublishProject).some(name => name.startsWith('.photoflow-paste-')), false, 'failed no-clobber publication must roll back its staging root');

    const screenshotProject = path.join(root, 'screenshot-paste-project');
    fs.mkdirSync(screenshotProject);
    const screenshotHandlers = new Map();
    let screenshotUndo;
    const screenshotBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => screenshotHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => screenshotProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null },
      clipboard: { readImage: () => ({ isEmpty: () => false, toPNG: () => screenshotBytes }) },
      readSystemFileClipboard: async () => null,
      writeLog: () => {}, assertInside, assertExistingInside, throwIfCancelled, uniqueDestination,
      pushUndoOperation: async operation => { screenshotUndo = operation; },
    });
    const screenshotStatus = await screenshotHandlers.get('workspace-file-clipboard-status')();
    assert.strictEqual(screenshotStatus.hasImage, true, 'clipboard image data must enable paste');
    const screenshotResult = await screenshotHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '',
    );
    assert.strictEqual(screenshotResult.success, true);
    assert.strictEqual(screenshotResult.count, 1);
    const screenshotPath = path.join(screenshotProject, screenshotResult.createdItems[0].name);
    assert.deepStrictEqual(fs.readFileSync(screenshotPath), screenshotBytes, 'clipboard screenshot must be persisted as PNG');
    assert.strictEqual(screenshotUndo.kind, 'remove-created');
    assert.strictEqual(screenshotUndo.label, '粘贴截图');

    const unknownScreenshotProject = path.join(root, 'unknown-screenshot-project'); fs.mkdirSync(unknownScreenshotProject); const unknownScreenshotHandlers = new Map(); let unknownScreenshotUndo = null; let unknownScreenshotInspect = 0;
    registerFileOperationsIpc({ Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto, ipcMain: { handle: (name, handler) => unknownScreenshotHandlers.set(name, handler), on: () => {} }, fs, path, getProjectPath: () => unknownScreenshotProject, activeProjectFileOperations: new Map(), fileOperationState: { projectFileClipboard: null }, clipboard: { readImage: () => ({ isEmpty: () => false, toPNG: () => screenshotBytes }) }, readSystemFileClipboard: async () => null, writeLog: () => {}, assertInside, assertExistingInside, throwIfCancelled, uniqueDestination, publishPathNoClobber: (sourcePath, destinationPath, options) => publishPathNoClobber(sourcePath, destinationPath, { ...options, nativePublicationService: { nativeAvailable: () => true, moveNoReplace: async (source, target) => { fs.renameSync(source, target); throw Object.assign(new Error('screenshot post-rename reply lost'), { published: true, publishedPath: target, identity: 'screenshot-original-native' }); }, inspectPath: async target => { if (unknownScreenshotInspect++ === 0) { fs.unlinkSync(target); fs.writeFileSync(target, 'screenshot replacement'); return { success: true, identity: 'screenshot-original-native' }; } return { success: true, identity: 'screenshot-replacement-native' }; } } }), pushUndoOperation: async operation => { unknownScreenshotUndo = operation; } });
    const unknownScreenshotResult = await unknownScreenshotHandlers.get('workspace-file-operation')({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], '');
    assert.strictEqual(unknownScreenshotResult.success, false); assert.strictEqual(unknownScreenshotResult.outcomeUnknown, true); assert.strictEqual(unknownScreenshotResult.published, false); assert.deepStrictEqual(unknownScreenshotResult.recovery.publishedPaths, []); assert.strictEqual(unknownScreenshotUndo, null, 'unknown screenshot replacement must not create destructive undo'); assert(Array.isArray(unknownScreenshotResult.uncertainPaths) && unknownScreenshotResult.uncertainPaths.length === 2); const unknownScreenshotTarget = fs.readdirSync(unknownScreenshotProject).map(name => path.join(unknownScreenshotProject, name)).find(candidate => !path.basename(candidate).startsWith('.photoflow-')); assert.strictEqual(fs.readFileSync(unknownScreenshotTarget, 'utf8'), 'screenshot replacement');

    const failureProject = path.join(root, 'replacement-failure-project');
    const failureExternal = path.join(root, 'replacement-failure-external');
    fs.mkdirSync(failureProject);
    fs.mkdirSync(failureExternal);
    const failureSource = path.join(failureExternal, 'same.txt');
    const failureTarget = path.join(failureProject, 'same.txt');
    fs.writeFileSync(failureSource, 'new content');
    fs.writeFileSync(failureTarget, 'original content');
    const failureHandlers = new Map();
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => failureHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => failureProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [failureSource] }),
      mainWindow: null, writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles: async () => { throw new Error('simulated copy failure'); },
      removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
    });
    const failureResult = await failureHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '', '', { pasteConflictPolicy: 'replace' },
    );
    assert.strictEqual(failureResult.success, false);
    assert.strictEqual(fs.readFileSync(failureTarget, 'utf8'), 'original content', 'a failed replacement must not touch the old target');
    assert.strictEqual(fs.readdirSync(failureProject).some(name => name.startsWith('.photoflow-')), true, 'an unowned injected staging root must be retained instead of path-deleted');

    const replacementRaceProject = path.join(root, 'replacement-race-project');
    const replacementRaceExternal = path.join(root, 'replacement-race-external');
    fs.mkdirSync(replacementRaceProject);
    fs.mkdirSync(replacementRaceExternal);
    const replacementRaceSource = path.join(replacementRaceExternal, 'same.txt');
    const replacementRaceTarget = path.join(replacementRaceProject, 'same.txt');
    fs.writeFileSync(replacementRaceSource, 'new replacement');
    fs.writeFileSync(replacementRaceTarget, 'old replacement');
    const replacementRaceHandlers = new Map();
    const replacementRaceFs = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (source, destination) => {
          await fs.promises.rename(source, destination);
          if (path.resolve(source) === path.resolve(replacementRaceTarget) && String(destination).includes('.photoflow-replace-')) {
            fs.writeFileSync(replacementRaceTarget, 'concurrent replacement');
          }
        },
      },
    };
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => replacementRaceHandlers.set(name, handler), on: () => {} },
      fs: replacementRaceFs, path, getProjectPath: () => replacementRaceProject, activeProjectFileOperations: new Map(),
      publishPathNoClobber: async (publishSource, publishDestination, options) => {
        const result = await publishPathNoClobber(publishSource, publishDestination, options);
        if (path.resolve(publishSource) === path.resolve(replacementRaceTarget) && String(publishDestination).includes('.photoflow-replace-')) {
          fs.writeFileSync(replacementRaceTarget, 'concurrent replacement');
        }
        return result;
      },
      fileOperationState: { projectFileClipboard: null },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [replacementRaceSource] }),
      mainWindow: null, writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
    });
    const replacementRaceResult = await replacementRaceHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '', '', { pasteConflictPolicy: 'replace' },
    );
    assert.strictEqual(replacementRaceResult.success, false, 'a replacement target recreated after staging must abort publication');
    assert.strictEqual(fs.readFileSync(replacementRaceTarget, 'utf8'), 'concurrent replacement', 'rollback must never delete a later replacement occupant');
    const retainedReplacementRoot = fs.readdirSync(replacementRaceProject).find(name => name.startsWith('.photoflow-replace-'));
    assert(retainedReplacementRoot, 'the displaced original must remain recoverable when its name is concurrently reused');
    const retainedReplacementPath = path.join(replacementRaceProject, retainedReplacementRoot, fs.readdirSync(path.join(replacementRaceProject, retainedReplacementRoot))[0]);
    assert.strictEqual(fs.readFileSync(retainedReplacementPath, 'utf8'), 'old replacement');
    assert.strictEqual(fs.readFileSync(replacementRaceSource, 'utf8'), 'new replacement', 'failed copy replacement preserves its source');

    const partialReplaceProject = path.join(root, 'partial-replace-project');
    const partialReplaceExternal = path.join(root, 'partial-replace-external');
    fs.mkdirSync(partialReplaceProject);
    fs.mkdirSync(partialReplaceExternal);
    const partialReplaceSource = path.join(partialReplaceExternal, 'same.txt');
    const partialReplaceTarget = path.join(partialReplaceProject, 'same.txt');
    fs.writeFileSync(partialReplaceSource, 'partial new');
    fs.writeFileSync(partialReplaceTarget, 'partial old');
    const partialReplaceHandlers = new Map();
    const partialReplaceUndoHistory = [];
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => partialReplaceHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => partialReplaceProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [partialReplaceSource] }),
      mainWindow: null, writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      publishPathNoClobber: (publishSource, publishDestination) => publishPathNoClobber(publishSource, publishDestination,
        path.resolve(publishDestination) === path.resolve(partialReplaceTarget) && String(publishSource).includes('.photoflow-paste-')
          ? {
              removeSource: async () => { throw Object.assign(new Error('simulated staging ACL'), { code: 'EACCES' }); },
              removePublished: async () => { throw Object.assign(new Error('simulated published lock'), { code: 'EBUSY' }); },
            }
          : {}),
      pushUndoOperation: async operation => {
        const stored = { ...await addUndoIdentities(operation), undoToken: crypto.randomUUID() };
        partialReplaceUndoHistory.push(stored);
        return stored;
      },
    });
    const partialReplaceResult = await partialReplaceHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '', '', { pasteConflictPolicy: 'replace' },
    );
    assert.strictEqual(partialReplaceResult.success, true, partialReplaceResult.error);
    assert.strictEqual(partialReplaceUndoHistory.length, 1, 'native atomic replace creates its normal usable undo record');
    assert.strictEqual(fs.readFileSync(partialReplaceTarget, 'utf8'), 'partial new');
    const partialReplaceUndoHandlers = new Map();
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => partialReplaceUndoHandlers.set(name, handler) }, fs, path, renameHistory: partialReplaceUndoHistory,
      assertUndoIdentity, movePathAtomic, pathExists: async value => fs.existsSync(value), samePathIdentity,
      recycleBinService: { probe: async () => ({ exists: false }) },
    });
    const recoveredPartialReplace = await partialReplaceUndoHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(recoveredPartialReplace.success, true, recoveredPartialReplace.error);
    assert.strictEqual(fs.readFileSync(partialReplaceTarget, 'utf8'), 'partial old', 'partial replace undo restores the hidden old content');

    const successProject = path.join(root, 'replacement-success-project');
    const successExternal = path.join(root, 'replacement-success-external');
    fs.mkdirSync(successProject);
    fs.mkdirSync(successExternal);
    const successSource = path.join(successExternal, 'same.txt');
    const successTarget = path.join(successProject, 'same.txt');
    fs.writeFileSync(successSource, 'replacement content');
    fs.writeFileSync(successTarget, 'restorable original');
    const successHandlers = new Map();
    let replacementUndo;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => successHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => successProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, clipboard: { clear: () => {} },
      readSystemFileClipboard: async () => ({ operation: 'copy', sources: [successSource] }),
      mainWindow: null, writeLog: () => {}, assertInside, assertExistingInside, assertDiskSpace, capturePathIdentity, samePathIdentity,
      collectCopyPlan, copyPlannedFiles, removeCreatedPasteTargets, throwIfCancelled, uniqueDestination,
      recycleBinService: { trash: async () => { throw new Error('simulated recycle failure'); } },
      pushUndoOperation: async operation => { replacementUndo = await addUndoIdentities(operation); },
    });
    const successResult = await successHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'paste', [], '', '', { pasteConflictPolicy: 'replace' },
    );
    assert.strictEqual(successResult.success, true);
    assert.strictEqual(successResult.replacedRetainedCount, 1);
    assert.strictEqual(fs.readFileSync(successTarget, 'utf8'), 'replacement content');
    assert.strictEqual(replacementUndo.kind, 'paste-replace');
    assert.strictEqual(fs.existsSync(replacementUndo.items[0].backup), true);

    const trashProject = path.join(root, 'batch-trash-project');
    fs.mkdirSync(trashProject);
    const trashNames = ['first.txt', 'second.txt'];
    for (const name of trashNames) fs.writeFileSync(path.join(trashProject, name), name);
    const trashHandlers = new Map();
    let trashBatchCalls = 0;
    let trashBatchSourceCount = 0;
    let trashUndo;
    let rejectTrashUndoPersistence = false;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => trashHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => trashProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, ensureWorkspace: () => root,
      capturePathIdentity, writeLog: () => {},
      recycleBinService: {
        trash: async source => {
          fs.rmSync(source, { recursive: true });
          return { success: true, originalPath: source, recyclePidl: 'pidl-single', preciseRestore: true, permanent: false };
        },
        trashMany: async sources => {
          trashBatchCalls += 1;
          trashBatchSourceCount = sources.length;
          for (const source of sources) fs.unlinkSync(source);
          return { success: true, items: sources.map((source, index) => ({ success: true, originalPath: source, recyclePidl: `pidl-${index}`, preciseRestore: true, permanent: false })) };
        },
      },
      workspaceRepository: { addUndoRecord: async () => {
        if (rejectTrashUndoPersistence) throw new Error('No pyvenv.cfg file');
        return { id: 'batch-trash-undo' };
      } },
      pushUndoOperation: async operation => { trashUndo = operation; },
    });
    const trashResult = await trashHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'trash', [trashNames[0], trashNames[0], trashNames[1]],
    );
    assert.strictEqual(trashResult.success, true);
    assert.strictEqual(trashResult.count, 2);
    assert.strictEqual(trashBatchCalls, 1, 'multi-selection trash must use one native batch request');
    assert.strictEqual(trashBatchSourceCount, 2, 'batch trash must collapse duplicate physical paths before invoking the native helper');
    assert.deepStrictEqual(trashUndo.items.map(item => item.recyclePidl), ['pidl-0', 'pidl-1']);
    assert(trashUndo.items.every(item => item.originalIdentity), 'batch trash must preserve every source identity for safe undo');

    const duplicateTrashFolder = path.join(trashProject, 'duplicate-folder');
    fs.mkdirSync(duplicateTrashFolder);
    fs.writeFileSync(path.join(duplicateTrashFolder, 'inside.txt'), 'inside');
    const duplicateTrashResult = await trashHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'trash', ['duplicate-folder', 'duplicate-folder'],
    );
    assert.strictEqual(duplicateTrashResult.success, true, duplicateTrashResult.error);
    assert.strictEqual(duplicateTrashResult.count, 1, 'duplicate virtual selections must delete one physical folder once');
    assert.strictEqual(trashBatchCalls, 1, 'a duplicate-only selection must collapse to the single-item recycle path');
    assert.strictEqual(fs.existsSync(duplicateTrashFolder), false);
    assert.deepStrictEqual(trashUndo.items.map(item => item.recyclePidl), ['pidl-single']);

    const protectedProgressProject = path.join(root, 'protected-progress-project');
    const protectedProgressParent = path.join(protectedProgressProject, 'versions');
    const protectedProgressFolder = path.join(protectedProgressParent, 'v1');
    const protectedProgressPasteTarget = path.join(protectedProgressProject, 'target');
    fs.mkdirSync(protectedProgressFolder, { recursive: true });
    fs.mkdirSync(protectedProgressPasteTarget);
    fs.writeFileSync(path.join(protectedProgressFolder, 'photo.jpg'), 'tracked');
    const progressHandlers = new Map();
    let progressClipboardWrites = 0;
    const progressRows = [{ id: 'progress-v1', nodeRole: 'progress', displayName: 'V1', folderPath: protectedProgressFolder }];
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => progressHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => protectedProgressProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, ensureWorkspace: () => root,
      versionService: { listProgress: async () => ({ success: true, progressFolders: progressRows }) },
      readSystemFileClipboard: async () => ({ operation: 'cut', sources: [protectedProgressParent] }),
      writeSystemFileClipboard: async () => { progressClipboardWrites += 1; return { sequence: 1 }; },
      capturePathIdentity, removeCreatedPasteTargets, writeLog: () => {},
      recycleBinService: { trash: async source => { fs.rmSync(source, { recursive: true }); return { success: true, originalPath: source, recyclePidl: 'progress-trash', preciseRestore: true, permanent: false }; } },
      workspaceRepository: { addUndoRecord: async () => ({ id: 'progress-trash-undo' }) },
      pushUndoOperation: async () => undefined,
    });
    const ancestorMove = await progressHandlers.get('workspace-file-operation')(null, 'workspace', '策划中', 'project', 'move', ['versions'], '', '');
    assert.strictEqual(ancestorMove.success, false, 'moving a local progress ancestor must be blocked');
    assert.match(ancestorMove.error, /祖先目录迁移/);
    const ancestorCut = await progressHandlers.get('workspace-file-operation')(null, 'workspace', '策划中', 'project', 'cut', ['versions'], '', '');
    assert.strictEqual(ancestorCut.success, false, 'cutting a progress ancestor must be blocked before clipboard publication');
    assert.strictEqual(progressClipboardWrites, 0);
    const ancestorTrash = await progressHandlers.get('workspace-file-operation')(null, 'workspace', '策划中', 'project', 'trash', ['versions'], '', '');
    assert.strictEqual(ancestorTrash.success, false, 'trashing a progress ancestor must not split registered paths');
    assert.strictEqual(fs.existsSync(protectedProgressFolder), true);
    const pastedAncestor = await progressHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], 'target', '',
    );
    assert.strictEqual(pastedAncestor.success, false, 'a system clipboard cut cannot bypass progress ancestor protection');
    assert.match(pastedAncestor.error, /祖先目录迁移/);
    assert.strictEqual(fs.existsSync(protectedProgressFolder), true, 'rejected cut-paste leaves the registered tree in place');
    const directProgressTrash = await progressHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'trash', ['versions/v1'], '', '',
    );
    assert.strictEqual(directProgressTrash.success, true, directProgressTrash.error);
    assert.strictEqual(fs.existsSync(protectedProgressFolder), false, 'direct trash keeps the DB row but makes its folder missing');
    assert.strictEqual(progressRows[0].id, 'progress-v1', 'direct trash never unregisters the progress node');

    const undoFailureTrashFolder = path.join(trashProject, 'undo-failure-folder');
    fs.mkdirSync(undoFailureTrashFolder);
    rejectTrashUndoPersistence = true;
    const undoFailureTrashResult = await trashHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'trash', ['undo-failure-folder'],
    );
    rejectTrashUndoPersistence = false;
    assert.strictEqual(undoFailureTrashResult.success, true, 'a completed recycle operation must not be reported as a deletion failure when only undo persistence is unavailable');
    assert.strictEqual(undoFailureTrashResult.undoUnavailable, true);
    assert.match(undoFailureTrashResult.warning, /应用内撤销记录未能保存/);
    assert.strictEqual(fs.existsSync(undoFailureTrashFolder), false);

    const aliasedPhysicalFolder = path.join(root, 'aliased-trash-folder');
    fs.mkdirSync(aliasedPhysicalFolder);
    fs.writeFileSync(path.join(aliasedPhysicalFolder, 'inside.txt'), 'inside');
    const aliasedTrashHandlers = new Map();
    let aliasedTrashCalls = 0;
    let aliasedTrashUndo;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => aliasedTrashHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => trashProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, ensureWorkspace: () => root,
      capturePathIdentity, writeLog: () => {},
      projectVirtualPaths: {
        listManagedExternalLinks: () => [],
        resolve: (_projectRoot, relativePath) => ({
          projectRoot: trashProject,
          virtualPath: String(relativePath).replace(/\\/g, '/'),
          physicalPath: aliasedPhysicalFolder,
          viaExternalLink: true,
          isExternalLinkRoot: false,
        }),
      },
      recycleBinService: {
        trash: async source => {
          aliasedTrashCalls += 1;
          fs.rmSync(source, { recursive: true });
          return { success: true, originalPath: source, recyclePidl: 'pidl-alias', preciseRestore: true, permanent: false };
        },
      },
      workspaceRepository: { addUndoRecord: async () => ({ id: 'alias-trash-undo' }) },
      pushUndoOperation: async operation => { aliasedTrashUndo = operation; },
    });
    const aliasedTrashResult = await aliasedTrashHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'trash', ['alias-a/folder', 'alias-b/folder'],
    );
    assert.strictEqual(aliasedTrashResult.success, true, aliasedTrashResult.error);
    assert.strictEqual(aliasedTrashResult.count, 1, 'virtual aliases resolving to one folder must delete that physical target once');
    assert.strictEqual(aliasedTrashCalls, 1);
    assert.deepStrictEqual(aliasedTrashResult.affectedDirectories, ['alias-a', 'alias-b'], 'all virtual aliases must be refreshed after their shared physical target is deleted');
    assert.deepStrictEqual(aliasedTrashUndo.items.map(item => item.recyclePidl), ['pidl-alias']);

    const partialTrashProject = path.join(root, 'partial-trash-project');
    fs.mkdirSync(partialTrashProject);
    fs.writeFileSync(path.join(partialTrashProject, 'deleted.txt'), 'deleted');
    fs.writeFileSync(path.join(partialTrashProject, 'retained.txt'), 'retained');
    const partialTrashHandlers = new Map();
    let partialTrashUndo;
    let partialTrashWatcherRefreshes = 0;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => partialTrashHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => partialTrashProject, activeProjectFileOperations: new Map(),
      fileOperationState: { projectFileClipboard: null }, ensureWorkspace: () => root,
      capturePathIdentity, writeLog: () => {},
      projectVirtualPaths: {
        listManagedExternalLinks: () => [],
        resolve: (_projectRoot, relativePath) => ({
          projectRoot: partialTrashProject,
          virtualPath: String(relativePath).replace(/\\/g, '/'),
          physicalPath: path.join(partialTrashProject, relativePath),
          viaExternalLink: relativePath === 'deleted.txt',
          isExternalLinkRoot: relativePath === 'deleted.txt',
        }),
      },
      refreshManagedExternalWatchers: async () => { partialTrashWatcherRefreshes += 1; },
      recycleBinService: {
        trashMany: async sources => {
          fs.unlinkSync(sources[0]);
          return { success: true, items: [{ success: true, originalPath: sources[0], recyclePidl: 'pidl-partial', preciseRestore: true, permanent: false }] };
        },
      },
      workspaceRepository: { addUndoRecord: async () => ({ id: 'partial-trash-undo' }) },
      pushUndoOperation: async operation => { partialTrashUndo = operation; },
    });
    const partialTrashResult = await partialTrashHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      'workspace', '策划中', 'project', 'trash', ['deleted.txt', 'retained.txt'],
    );
    assert.strictEqual(partialTrashResult.success, false);
    assert.strictEqual(partialTrashResult.errorCode, 'RECYCLE_BIN_FAILED');
    assert.strictEqual(partialTrashResult.count, 1, 'a partial native response must report how many paths were actually deleted');
    assert.strictEqual(fs.existsSync(path.join(partialTrashProject, 'deleted.txt')), false);
    assert.strictEqual(fs.existsSync(path.join(partialTrashProject, 'retained.txt')), true);
    assert.deepStrictEqual(partialTrashUndo.items.map(item => item.recyclePidl), ['pidl-partial'], 'successfully deleted paths must remain undoable when another batch item fails');
    assert.strictEqual(partialTrashWatcherRefreshes, 1, 'partial trash success must refresh managed external watchers before reporting the remaining failure');

    const renameFastPathProject = path.join(root, 'rename-fast-path-project');
    fs.mkdirSync(renameFastPathProject);
    const renameFastPathHandlers = new Map();
    const renameCalls = [];
    let failRenameCall = 0;
    let clipboardWriteCalls = 0;
    let failClipboardWrite = false;
    const countedRenameFs = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (source, destination) => {
          renameCalls.push({ source, destination });
          if (failRenameCall && renameCalls.length === failRenameCall) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
          return fs.promises.rename(source, destination);
        },
      },
    };
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => renameFastPathHandlers.set(name, handler), on: () => {} },
      fs: countedRenameFs, path, getProjectPath: () => renameFastPathProject, activeProjectFileOperations: new Map(),
      publishPathNoClobber: async (publishSource, publishDestination) => {
        renameCalls.push({ source: publishSource, destination: publishDestination });
        if (failRenameCall && renameCalls.length === failRenameCall) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
        return publishPathNoClobber(publishSource, publishDestination);
      },
      fileOperationState: { projectFileClipboard: null }, ensureWorkspace: () => root,
      writeSystemFileClipboard: async (sources, operation) => {
        clipboardWriteCalls += 1;
        if (failClipboardWrite) throw new Error('injected clipboard write failure');
        return { sequence: clipboardWriteCalls, sources, operation };
      },
      pushUndoOperation: async () => undefined, writeLog: () => undefined,
    });
    fs.writeFileSync(path.join(renameFastPathProject, 'single.txt'), 'single');
    let renameResult = await renameFastPathHandlers.get('workspace-file-operation')(
      null, 'workspace', '策划中', 'project', 'rename', ['single.txt'], '', 'renamed.txt',
    );
    assert.strictEqual(renameResult.success, true, renameResult.error);
    assert.strictEqual(renameCalls.length, 1, 'ordinary single rename must invoke the no-clobber publisher exactly once');
    assert.strictEqual(fs.readFileSync(path.join(renameFastPathProject, 'renamed.txt'), 'utf8'), 'single');

    renameCalls.length = 0;
    failRenameCall = 1;
    fs.writeFileSync(path.join(renameFastPathProject, 'direct-failure.txt'), 'retained');
    renameResult = await renameFastPathHandlers.get('workspace-file-operation')(
      null, 'workspace', '策划中', 'project', 'rename', ['direct-failure.txt'], '', 'never-created.txt',
    );
    failRenameCall = 0;
    assert.strictEqual(renameResult.success, false);
    assert.strictEqual(renameCalls.length, 1, 'failed direct rename is not retried through staging');
    assert.strictEqual(fs.readFileSync(path.join(renameFastPathProject, 'direct-failure.txt'), 'utf8'), 'retained');
    assert.strictEqual(fs.existsSync(path.join(renameFastPathProject, 'never-created.txt')), false);
    let clipboardResult = await renameFastPathHandlers.get('workspace-file-operation')(
      null, 'workspace', '策划中', 'project', 'copy', ['renamed.txt'], '', '',
    );
    assert.strictEqual(clipboardResult.success, true, clipboardResult.error);
    assert.strictEqual(clipboardWriteCalls, 1, 'copy selection performs one system clipboard write and no file transfer');
    failClipboardWrite = true;
    clipboardResult = await renameFastPathHandlers.get('workspace-file-operation')(
      null, 'workspace', '策划中', 'project', 'cut', ['renamed.txt'], '', '',
    );
    failClipboardWrite = false;
    assert.strictEqual(clipboardResult.success, false);
    assert.strictEqual(clipboardWriteCalls, 2, 'failed cut clipboard write is reported without a staging retry');

    renameCalls.length = 0;
    fs.writeFileSync(path.join(renameFastPathProject, 'CaseOnly.txt'), 'case-only');
    renameResult = await renameFastPathHandlers.get('workspace-file-operation')(
      null, 'workspace', '策划中', 'project', 'rename', ['CaseOnly.txt'], '', 'caseonly.txt',
    );
    assert.strictEqual(renameResult.success, true, renameResult.error);
    assert.strictEqual(renameCalls.length, 1, 'case-only single rename must also use the direct path');
    assert.strictEqual(fs.readFileSync(path.join(renameFastPathProject, 'caseonly.txt'), 'utf8'), 'case-only');

    renameCalls.length = 0;
    fs.writeFileSync(path.join(renameFastPathProject, 'one.txt'), 'one');
    fs.writeFileSync(path.join(renameFastPathProject, 'two.txt'), 'two');
    renameResult = await renameFastPathHandlers.get('workspace-file-operation')(
      null, 'workspace', '策划中', 'project', 'rename', ['one.txt', 'two.txt'], '', 'batch', { renameNames: ['two.txt', 'one.txt'] },
    );
    assert.strictEqual(renameResult.success, true, renameResult.error);
    assert.strictEqual(renameCalls.length, 4, 'a two-item swap must retain two-phase staging');
    assert.strictEqual(fs.readFileSync(path.join(renameFastPathProject, 'one.txt'), 'utf8'), 'two');
    assert.strictEqual(fs.readFileSync(path.join(renameFastPathProject, 'two.txt'), 'utf8'), 'one');

    fs.renameSync(path.join(renameFastPathProject, 'one.txt'), path.join(renameFastPathProject, 'rollback-one.txt'));
    fs.renameSync(path.join(renameFastPathProject, 'two.txt'), path.join(renameFastPathProject, 'rollback-two.txt'));
    renameCalls.length = 0;
    failRenameCall = 4;
    renameResult = await renameFastPathHandlers.get('workspace-file-operation')(
      null, 'workspace', '策划中', 'project', 'rename', ['rollback-one.txt', 'rollback-two.txt'], '', 'batch', { renameNames: ['rollback-two.txt', 'rollback-one.txt'] },
    );
    failRenameCall = 0;
    assert.strictEqual(renameResult.success, false, 'an injected publish failure must be reported');
    assert.strictEqual(fs.readFileSync(path.join(renameFastPathProject, 'rollback-one.txt'), 'utf8'), 'two', 'batch rollback restores the first source');
    assert.strictEqual(fs.readFileSync(path.join(renameFastPathProject, 'rollback-two.txt'), 'utf8'), 'one', 'batch rollback restores the second source');
    assert.strictEqual(fs.readdirSync(renameFastPathProject).some(name => name.startsWith('.photoflow-rename-')), false, 'batch rollback leaves no staging entries');

    const undoHandlers = new Map();
    const renameHistory = [replacementUndo];
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => undoHandlers.set(name, handler) }, fs, path, renameHistory,
      assertUndoIdentity, movePathAtomic, pathExists: async value => fs.existsSync(value),
      recycleBinService: { probe: async () => ({ exists: false }), restore: async () => { throw new Error('unexpected recycle restore'); } },
    });
    const undoReplacementResult = await undoHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(undoReplacementResult.success, true);
    assert.strictEqual(fs.readFileSync(successTarget, 'utf8'), 'restorable original');
    assert.strictEqual(fs.readdirSync(successProject).some(name => name.startsWith('.photoflow-')), false);

    for (const directoryCase of [false, true]) {
      const label = directoryCase ? 'directory' : 'file';
      const undoRaceRoot = path.join(root, `undo-replace-race-${label}`);
      const undoRaceDestination = path.join(undoRaceRoot, `same-${label}`);
      const undoRaceBackupRoot = path.join(undoRaceRoot, '.old-backup');
      const undoRaceBackup = path.join(undoRaceBackupRoot, `same-${label}`);
      fs.mkdirSync(undoRaceBackupRoot, { recursive: true });
      if (directoryCase) {
        fs.mkdirSync(undoRaceDestination, { recursive: true });
        fs.writeFileSync(path.join(undoRaceDestination, 'new.txt'), 'new directory');
        fs.mkdirSync(undoRaceBackup, { recursive: true });
        fs.writeFileSync(path.join(undoRaceBackup, 'old.txt'), 'old directory');
      } else {
        fs.writeFileSync(undoRaceDestination, 'new file');
        fs.writeFileSync(undoRaceBackup, 'old file');
      }
      const undoRaceOperation = await addUndoIdentities({
        kind: 'paste-replace', mode: 'copy',
        moves: [{ source: path.join(root, `source-${label}`), destination: undoRaceDestination }],
        items: [{ original: undoRaceDestination, backup: undoRaceBackup, backupRoot: undoRaceBackupRoot, permanent: false }],
      });
      const undoRaceHistory = [undoRaceOperation];
      const undoRaceHandlers = new Map();
      let lateOccupantCreated = false;
      registerWorkspaceIpc({
        Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
        ipcMain: { handle: (name, handler) => undoRaceHandlers.set(name, handler) }, fs, path, renameHistory: undoRaceHistory,
        assertUndoIdentity, movePathAtomic, pathExists: async value => fs.existsSync(value), samePathIdentity,
        publishPathNoClobber: async (publishSource, publishDestination) => {
          const result = await publishPathNoClobber(publishSource, publishDestination);
          if (!lateOccupantCreated && path.resolve(publishSource) === path.resolve(undoRaceDestination) && String(publishDestination).includes('.photoflow-undo-paste-')) {
            lateOccupantCreated = true;
            if (directoryCase) { fs.mkdirSync(undoRaceDestination); fs.writeFileSync(path.join(undoRaceDestination, 'late.txt'), 'late directory'); }
            else fs.writeFileSync(undoRaceDestination, 'late file');
          }
          return result;
        },
        recycleBinService: { probe: async () => ({ exists: false }) },
      });
      const conflictedUndo = await undoRaceHandlers.get('workspace-undo-rename')(null, '');
      assert.strictEqual(conflictedUndo.success, false, `${label} replace undo must report a late conflict`);
      assert.match(conflictedUndo.error, /晚到同名占用|目标已存在/);
      assert.strictEqual(directoryCase ? fs.readFileSync(path.join(undoRaceDestination, 'late.txt'), 'utf8') : fs.readFileSync(undoRaceDestination, 'utf8'), directoryCase ? 'late directory' : 'late file', 'late unknown content is preserved');
      assert.strictEqual(fs.existsSync(undoRaceBackup), true, 'old replacement backup remains recoverable');
      assert.strictEqual(undoRaceHistory.length, 1, 'conflicted replacement undo remains retryable');
      const partialUndoRoot = undoRaceHistory[0].partialUndoState?.undoRoot;
      assert(partialUndoRoot && fs.existsSync(partialUndoRoot), 'new pasted content remains in the undo recovery root');
      fs.rmSync(undoRaceDestination, { recursive: true, force: true });
      const recoveredUndo = await undoRaceHandlers.get('workspace-undo-rename')(null, '');
      assert.strictEqual(recoveredUndo.success, true, recoveredUndo.error);
      assert.strictEqual(directoryCase ? fs.readFileSync(path.join(undoRaceDestination, 'old.txt'), 'utf8') : fs.readFileSync(undoRaceDestination, 'utf8'), directoryCase ? 'old directory' : 'old file');
      assert.strictEqual(fs.existsSync(partialUndoRoot), false, 'successful retry clears the undo recovery root');
    }

    const occupiedRestorePath = path.join(root, 'occupied-restore.txt');
    const renamedRestorePath = path.join(root, 'occupied-restore (已恢复).txt');
    fs.writeFileSync(occupiedRestorePath, 'new occupant');
    const restoreHandlers = new Map();
    const restoreCalls = [];
    const restoreHistory = [{
      kind: 'trash',
      items: [{ original: occupiedRestorePath, originalIdentity: { device: '-1', inode: '-1', size: '0', modifiedNs: '0', directory: false }, recyclePidl: 'restore-item' }],
    }];
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => restoreHandlers.set(name, handler) }, fs, path, renameHistory: restoreHistory,
      pathExists: async value => fs.existsSync(value), samePathIdentity,
      recycleBinService: {
        probe: async () => ({ exists: true }),
        restore: async ({ originalPath, targetPath = originalPath }) => {
          restoreCalls.push({ originalPath, targetPath });
          fs.writeFileSync(targetPath, 'restored item');
        },
      },
    });
    const restoreDecision = await restoreHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(restoreDecision.requiresDecision.kind, 'restore-conflict');
    assert.strictEqual(fs.readFileSync(occupiedRestorePath, 'utf8'), 'new occupant', 'restore decision preflight must not replace the occupied path');
    assert.strictEqual(restoreHistory.length, 1, 'a deferred restore must remain undoable after cancelling the dialog');
    const renamedRestore = await restoreHandlers.get('workspace-undo-rename')(null, '', { restoreConflictPolicy: 'rename' });
    assert.strictEqual(renamedRestore.success, true);
    assert.strictEqual(fs.readFileSync(occupiedRestorePath, 'utf8'), 'new occupant');
    assert.deepStrictEqual(restoreCalls, [{ originalPath: occupiedRestorePath, targetPath: renamedRestorePath }], 'restore keeps immutable recycle evidence separate from the conflict-renamed target');
    assert.strictEqual(fs.readFileSync(renamedRestorePath, 'utf8'), 'restored item');

    const projectRenameHandlers = new Map();
    const renameWorkspaceRoot = path.join(root, 'rename-workspace');
    const renameSourceName = '26-8-16 临时占用测试';
    const renameTargetName = '26-8-18 临时占用测试';
    const renameSource = path.join(renameWorkspaceRoot, renameSourceName);
    const renameTarget = path.join(renameWorkspaceRoot, renameTargetName);
    fs.mkdirSync(renameSource, { recursive: true });
    let projectRenameAttempts = 0;
    let suspendedRenameWatchers = 0;
    let resumedRenameWatchers = 0;
    let projectFolderMkdirCalls = 0;
    let failProjectFolderMkdir = false;
    const renameFs = {
      ...fs,
      mkdirSync: (targetPath, options) => {
        projectFolderMkdirCalls += 1;
        if (failProjectFolderMkdir) throw Object.assign(new Error('injected mkdir failure'), { code: 'EIO' });
        return fs.mkdirSync(targetPath, options);
      },
      promises: {
        ...fs.promises,
        rename: async (sourcePath, destinationPath) => {
          if (sourcePath === renameSource && destinationPath === renameTarget && projectRenameAttempts++ < 2) {
            throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
          }
          return fs.promises.rename(sourcePath, destinationPath);
        },
      },
    };
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => projectRenameHandlers.set(name, handler) }, fs: renameFs, path,
      WORKSPACE_STATUSES: ['策划中'], HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(),
      cleanProjectName: value => String(value).trim(), ensureWorkspace: () => renameWorkspaceRoot,
      assertInside,
      projectVirtualPaths: {
        resolve: (projectRoot, relativePath) => ({
          projectRoot,
          virtualPath: String(relativePath || '').replace(/\\/g, '/'),
          physicalPath: assertInside(projectRoot, path.resolve(projectRoot, relativePath || '.'), '项目路径', true),
          mediaRoot: projectRoot,
          viaExternalLink: false,
          isExternalLinkRoot: false,
        }),
        listManagedExternalLinks: () => [],
      },
      getProjectPath: (_workspacePath, _status, name) => path.join(renameWorkspaceRoot, name),
      getWorkspaceDataRoot: () => path.join(renameWorkspaceRoot, '.data'),
      workspaceCatalogs: new Map([[renameWorkspaceRoot, { byName: new Map([[renameSourceName.toLocaleLowerCase(), { name: renameSourceName, extra_json: '{}' }]]) }]]),
      mutateWorkspaceCatalog: async () => undefined, pushUndoOperation: async () => undefined,
      cancelMediaTrackingScan: () => undefined, suppressWorkspaceWatchPath: () => undefined, releaseWorkspaceWatchPath: () => undefined,
      suspendFileRootWatcher: () => { suspendedRenameWatchers += 1; return 1; },
      resumeFileRootWatcher: () => { resumedRenameWatchers += 1; return { success: true }; },
      writeLog: () => undefined,
    });
    const projectRenameResult = await projectRenameHandlers.get('workspace-rename-project')(null, renameWorkspaceRoot, '策划中', renameSourceName, { year: 2026, month: 8, day: 18 }, '临时占用测试');
    assert.strictEqual(projectRenameResult.success, true, projectRenameResult.error);
    assert.strictEqual(projectRenameAttempts, 3, 'project rename should retry transient Windows locks');
    assert.strictEqual(suspendedRenameWatchers, 1, 'project rename should suspend its recursive watcher before renaming');
    assert.strictEqual(resumedRenameWatchers, 0, 'a successful rename should let the renderer attach a watcher to the new path');
    assert.strictEqual(fs.existsSync(renameTarget), true);
    const createdFolder = await projectRenameHandlers.get('workspace-create-project-folder')(
      null, renameWorkspaceRoot, '策划中', renameTargetName, '新建文件夹', '', true,
    );
    assert.strictEqual(createdFolder.success, true, createdFolder.error);
    assert.strictEqual(projectFolderMkdirCalls, 1, 'ordinary folder creation uses one mkdir call');
    failProjectFolderMkdir = true;
    const failedFolder = await projectRenameHandlers.get('workspace-create-project-folder')(
      null, renameWorkspaceRoot, '策划中', renameTargetName, '失败文件夹', '', true,
    );
    failProjectFolderMkdir = false;
    assert.strictEqual(failedFolder.success, false);
    assert.strictEqual(projectFolderMkdirCalls, 2, 'failed mkdir is not retried through staging');
    assert.strictEqual(fs.existsSync(path.join(renameTarget, '失败文件夹')), false, 'failed mkdir leaves no optimistic backend artifact');

    const importProjectHandlers = new Map();
    const importWorkspaceRoot = path.join(root, 'import-existing-workspace');
    const importSource = path.join(root, 'outside-existing-project');
    fs.mkdirSync(path.join(importWorkspaceRoot, '策划中'), { recursive: true });
    fs.mkdirSync(path.join(importSource, 'RAW'), { recursive: true });
    fs.mkdirSync(path.join(importSource, 'JPG'), { recursive: true });
    fs.mkdirSync(path.join(importSource, '图片后期_2'), { recursive: true });
    fs.writeFileSync(path.join(importSource, 'RAW', 'IMG_0001.CR3'), 'raw');
    fs.writeFileSync(path.join(importSource, 'JPG', 'IMG_0001.JPG'), 'proxy');
    fs.writeFileSync(path.join(importSource, '图片后期_2', 'IMG_0001.jpg'), 'edited');
    let importedCatalogEntry = null;
    let importCopyPlanCalls = 0;
    let importInspectionReadCalls = 0;
    let externallyOpenedPath = '';
    let progressRegistrationPath = '';
    let failProgressRelocation = false;
    let failShortcutRemoval = false;
    let failExternalAdoptionRollback = false;
    let failImportUndoOperation = false;
    let failManagedLinkRevoke = false;
    let failManagedExternalWatcher = false;
    let failCreatedTargetRemoval = false;
    let escapedCleanupTarget = '';
    let managedWatcherAcquisitions = 0;
    let trackingReconciliations = 0;
    let materializedProgressFolders = [];
    const importUndoOperations = [];
    const revertedExternalAdoptions = [];
    const unregisteredExternalProgress = [];
    const importFs = {
      ...fs,
      promises: {
        ...fs.promises,
        readdir: async (...args) => { importInspectionReadCalls += 1; return fs.promises.readdir(...args); },
        realpath: async target => path.resolve(target) === path.resolve(escapedCleanupTarget || '__none__')
          ? path.join(root, 'outside-replacement-target')
          : fs.promises.realpath(target),
        rm: async (target, options) => {
          if (failShortcutRemoval && path.extname(String(target)).toLowerCase() === '.lnk') throw Object.assign(new Error('simulated shortcut lock'), { code: 'EPERM' });
          if (failCreatedTargetRemoval && String(target).includes('cleanup-copy')) throw Object.assign(new Error('simulated copied target lock'), { code: 'EPERM' });
          return fs.promises.rm(target, options);
        },
      },
    };
    const importShell = {
      writeShortcutLink: (shortcutPath, details) => {
        fs.writeFileSync(shortcutPath, JSON.stringify(details));
        return true;
      },
      readShortcutLink: shortcutPath => JSON.parse(fs.readFileSync(shortcutPath, 'utf8')),
      openPath: async target => { externallyOpenedPath = target; return ''; },
    };
    const importProjectVirtualPaths = createProjectVirtualPathService({
      shell: importShell,
      registryPath: path.join(root, 'managed-external-links.json'),
    });
    const revokeImportedManagedLinks = importProjectVirtualPaths.revokeManagedExternalLinkIds;
    importProjectVirtualPaths.revokeManagedExternalLinkIds = linkIds => {
      if (failManagedLinkRevoke) throw new Error('simulated managed-link registry write failure');
      return revokeImportedManagedLinks(linkIds);
    };
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => importProjectHandlers.set(name, handler) }, fs: importFs, path,
      CANCELLED_CODE, WORKSPACE_STATUSES: ['策划中'], HIDDEN_SYSTEM_ENTRY_NAMES: new Set(),
      IMAGE_EXTENSIONS: new Set(['.jpg', '.jpeg']), RAW_EXTENSIONS: new Set(['.cr3']), VIDEO_EXTENSIONS: new Set(['.mov']),
      cleanProjectName: value => String(value).trim(), ensureWorkspace: () => importWorkspaceRoot,
      getProjectPath: (_workspacePath, status, name) => path.join(importWorkspaceRoot, status, name),
      resolveProjectEntry: (_workspacePath, status, name, relativePath) => path.join(importWorkspaceRoot, status, name, relativePath),
      getWorkspaceDataRoot: () => path.join(importWorkspaceRoot, '.data'),
      workspaceCatalogs: new Map([[importWorkspaceRoot, { byName: new Map(), projects: [] }]]),
      mutateWorkspaceCatalog: async (_root, _operation, entry) => {
        importedCatalogEntry = entry;
        return { byName: new Map([[entry.name.toLocaleLowerCase(), { id: 'imported-project-id', name: entry.name }]]), projects: [] };
      },
      activeProjectFileOperations: new Map(), assertDiskSpace, assertInside, assertExistingInside, uniqueDestination, movePathAtomic,
      collectCopyPlan: async (...args) => { importCopyPlanCalls += 1; return collectCopyPlan(...args); },
      copyPlannedFiles, removeCopiedSources, throwIfCancelled, shell: importShell,
      projectVirtualPaths: importProjectVirtualPaths,
      acquireFileRootWatcher: watchedRoot => {
        managedWatcherAcquisitions += 1;
        if (failManagedExternalWatcher && path.resolve(watchedRoot) !== path.resolve(fileLinkProjectPath)) return { success: false, error: 'simulated external watcher failure' };
        return { success: true };
      },
      releaseFileRootWatcher: () => undefined,
      mediaRuntimeState: {}, mediaService: { grantRoot: () => undefined }, normalizeMediaCacheSizeGB: value => value || 1,
      thumbnailService: { indexDirectory: () => undefined },
      versionService: {
        listProgress: async () => ({ progressFolders: materializedProgressFolders }),
        detectProgressStale: async () => { trackingReconciliations += 1; return { success: true, staleProgressIds: [] }; },
        adoptMediaFolder: async (_workspaceRoot, request) => ({ success: true, created: true, progressFolder: { id: `adopted-${path.basename(request.folderPath)}` } }),
        revertExternalAdoptions: async (_workspaceRoot, request) => {
          revertedExternalAdoptions.push(request);
          if (failExternalAdoptionRollback) throw new Error('simulated external adoption rollback failure');
          return { success: true, removedProgressIds: request.progressIds };
        },
        unregisterProgress: async (_workspaceRoot, request) => { unregisteredExternalProgress.push(request); return { success: true }; },
        registerProgress: async (_workspaceRoot, request) => {
          if (failProgressRelocation) return { success: false, error: 'simulated progress relocation failure' };
          progressRegistrationPath = request.folderPath;
          return { success: true, progressFolder: { ...request, id: request.progressId || 'progress-id' } };
        },
      },
      renameHistory: importUndoOperations,
      assertUndoIdentity: async (_operation, target) => {
        if (!fs.existsSync(target)) throw Object.assign(new Error('missing undo target'), { code: 'UNDO_IDENTITY_MISMATCH' });
      },
      pushUndoOperation: async operation => {
        if (failImportUndoOperation) throw new Error('simulated undo persistence failure');
        const stored = { ...operation, undoToken: crypto.randomUUID() };
        importUndoOperations.push(stored);
        return stored;
      },
      removeUndoOperation: undoToken => {
        const index = importUndoOperations.findIndex(operation => operation.undoToken === undoToken);
        if (index < 0) return false;
        importUndoOperations.splice(index, 1);
        return true;
      }, writeLog: () => undefined, mainWindow: null,
    });
    const importedProject = await importProjectHandlers.get('workspace-import-existing-project')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      importWorkspaceRoot, importSource, { name: '接管测试', mode: 'copy' },
    );
    assert.strictEqual(importedProject.success, true, importedProject.error);
    assert.strictEqual(fs.readFileSync(path.join(importWorkspaceRoot, '策划中', '接管测试', 'RAW', 'IMG_0001.CR3'), 'utf8'), 'raw');
    assert.strictEqual(fs.existsSync(importSource), true, 'copy import must preserve the external project');
    assert.strictEqual(importedCatalogEntry.name, '接管测试');
    assert.strictEqual(importedProject.candidates[0].name, 'RAW', 'RAW should be proposed as the adoption baseline');
    assert(!importedProject.candidates.some(candidate => candidate.name === 'JPG'), 'a companion JPG folder should be treated as a RAW proxy instead of a second progress');
    const externallyOpenedFolder = await importProjectHandlers.get('workspace-open-entry')(
      null, importWorkspaceRoot, '策划中', '接管测试', 'RAW',
    );
    assert.strictEqual(externallyOpenedFolder.success, true, externallyOpenedFolder.error);
    assert.strictEqual(externallyOpenedPath, path.join(importWorkspaceRoot, '策划中', '接管测试', 'RAW'), 'folder details external-open must delegate to the system shell');

    const linkSource = path.join(root, 'outside-linked-project');
    fs.mkdirSync(path.join(linkSource, 'RAW'), { recursive: true });
    fs.writeFileSync(path.join(linkSource, 'RAW', 'LINK_0001.CR3'), 'linked-raw');
    const inspectedLinkProject = await importProjectHandlers.get('workspace-inspect-existing-project')(null, linkSource);
    assert.strictEqual(inspectedLinkProject.success, true, inspectedLinkProject.error);
    assert(inspectedLinkProject.inspectionToken, 'project inspection must return a reusable server-side token');
    assert.strictEqual(importProjectHandlers.has('workspace-import-existing-project-link'), false, 'project import must not expose a dedicated link-only IPC');
    const forcedLinkProject = await importProjectHandlers.get('workspace-import-existing-project')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      importWorkspaceRoot, linkSource, { name: 'forced-linked-project', mode: 'link', operationId: '12345678-1234-4123-8123-123456789abc', inspectionToken: inspectedLinkProject.inspectionToken },
    );
    assert.strictEqual(forcedLinkProject.success, false, 'forcing project link mode through IPC must be rejected');
    assert.match(forcedLinkProject.error, /只支持复制并接管或剪切并接管/);
    assert.strictEqual(fs.readFileSync(path.join(linkSource, 'RAW', 'LINK_0001.CR3'), 'utf8'), 'linked-raw');
    const linkedProjectPath = path.join(importWorkspaceRoot, '策划中', 'linked-project');
    assert.strictEqual(fs.existsSync(linkedProjectPath), false, 'rejected link mode must not create a project');

    const fileLinkProjectName = 'file-link-project';
    const fileLinkProjectPath = path.join(importWorkspaceRoot, '策划中', fileLinkProjectName);
    const linkedFolderSource = path.join(root, 'linked-folder-source');
    const linkedFileSource = path.join(root, 'linked-file-source.jpg');
    fs.mkdirSync(fileLinkProjectPath, { recursive: true });
    fs.mkdirSync(linkedFolderSource, { recursive: true });
    fs.writeFileSync(path.join(linkedFolderSource, 'inside.jpg'), 'inside');
    fs.writeFileSync(linkedFileSource, 'linked-file');
    const linkedFiles = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', { linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [linkedFolderSource, linkedFileSource] },
    );
    assert.strictEqual(linkedFiles.success, true, linkedFiles.error);
    assert.strictEqual(linkedFiles.linked, true);
    assert.deepStrictEqual(linkedFiles.items.map(item => ({ relativePath: item.relativePath, kind: item.kind })), [
      { relativePath: 'linked-folder-source.lnk', kind: 'folder' },
      { relativePath: 'linked-file-source.jpg.lnk', kind: 'file' },
    ], 'link-only imports must return the exact managed entries so semantic import flows can register their version-tree roles');
    assert.deepStrictEqual(linkedFiles.items.map(item => ({ relativePath: item.relativePath, kind: item.kind })), [
      { relativePath: 'linked-folder-source.lnk', kind: 'folder' },
      { relativePath: 'linked-file-source.jpg.lnk', kind: 'file' },
    ], 'link-only imports must return the exact managed entries so semantic import flows can register their version-tree roles');
    assert.strictEqual(fs.readFileSync(path.join(linkedFolderSource, 'inside.jpg'), 'utf8'), 'inside');
    assert.strictEqual(fs.readFileSync(linkedFileSource, 'utf8'), 'linked-file');
    const linkedProjectRoot = await importProjectHandlers.get('workspace-browse-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {},
    );
    assert.strictEqual(linkedProjectRoot.success, true, linkedProjectRoot.error);
    const managedExternalFolder = linkedProjectRoot.entries.find(entry => entry.externalLink);
    assert.strictEqual(managedExternalFolder.externalLinkTarget, linkedFolderSource, 'managed external roots must expose their validated target for version-tree identity matching');
    const browsedManagedExternalFolder = await importProjectHandlers.get('workspace-browse-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, managedExternalFolder.relativePath, {},
    );
    assert.strictEqual(browsedManagedExternalFolder.success, true, browsedManagedExternalFolder.error);
    assert(browsedManagedExternalFolder.entries.some(entry => entry.name === 'inside.jpg' && entry.viaExternalLink), 'managed external folders must browse through the normal in-app folder route');
    assert.deepStrictEqual(fs.readdirSync(fileLinkProjectPath).sort(), ['linked-file-source.jpg.lnk', 'linked-folder-source.lnk']);

    const inspirationProjectName = '.__photoflow_inspiration__';
    const inspirationProjectRoot = path.join(root, 'inspiration-virtual-project');
    const inspirationMoveTarget = path.join(inspirationProjectRoot, 'moved');
    fs.mkdirSync(inspirationMoveTarget, { recursive: true });
    fs.writeFileSync(path.join(inspirationProjectRoot, 'rename-me.txt'), 'rename');
    fs.writeFileSync(path.join(inspirationProjectRoot, 'move-me.txt'), 'move');
    fs.writeFileSync(path.join(inspirationProjectRoot, 'trash-me.txt'), 'trash');
    fs.writeFileSync(path.join(inspirationProjectRoot, 'conflict-source.txt'), 'source');
    fs.writeFileSync(path.join(inspirationProjectRoot, 'conflict-target.txt'), 'target');
    fs.writeFileSync(path.join(inspirationProjectRoot, 'watch-link.lnk'), 'managed external link');
    fs.writeFileSync(path.join(inspirationProjectRoot, 'watch-move.lnk'), 'managed external link move');
    fs.writeFileSync(path.join(inspirationProjectRoot, 'watch-trash.lnk'), 'managed external link trash');
    for (const ancestorName of ['watch-ancestor-rename', 'watch-ancestor-move', 'watch-ancestor-trash']) {
      fs.mkdirSync(path.join(inspirationProjectRoot, ancestorName));
      fs.writeFileSync(path.join(inspirationProjectRoot, ancestorName, 'tracked.lnk'), 'managed nested external link');
    }
    const escapedInspirationPath = path.join(root, 'outside-inspiration.txt');
    fs.writeFileSync(escapedInspirationPath, 'outside');
    const inspirationHandlers = new Map();
    let inspirationListProgressCalls = 0;
    let inspirationWatcherRefreshes = 0;
    const inspirationVirtualPaths = {
      listManagedExternalLinks: () => ['watch-ancestor-rename/tracked.lnk', 'watch-ancestor-move/tracked.lnk', 'watch-ancestor-trash/tracked.lnk'].map(shortcutVirtualPath => ({ shortcutVirtualPath })),
      resolve: (projectRoot, relativePath) => {
        const physicalPath = path.resolve(projectRoot, relativePath || '.');
        const relative = path.relative(projectRoot, physicalPath);
        if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) throw new Error('项目路径无效');
        const virtualPath = String(relativePath || '').replace(/\\/g, '/');
        const isExternalLinkRoot = virtualPath.endsWith('.lnk');
        return {
          projectRoot,
          virtualPath,
          physicalPath,
          mediaRoot: projectRoot,
          viaExternalLink: isExternalLinkRoot,
          isExternalLinkRoot,
          shortcutPath: isExternalLinkRoot ? physicalPath : undefined,
          shortcutVirtualPath: isExternalLinkRoot ? virtualPath : undefined,
        };
      },
      toVirtualPath: (projectRoot, physicalPath) => path.relative(projectRoot, physicalPath).replace(/\\/g, '/'),
    };
    registerFileOperationsIpc({
      Array, Boolean, CANCELLED_CODE, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => inspirationHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: (_workspacePath, _status, projectName) => {
        assert.strictEqual(projectName, inspirationProjectName);
        return inspirationProjectRoot;
      },
      ensureWorkspace: () => inspirationProjectRoot,
      projectVirtualPaths: inspirationVirtualPaths,
      activeProjectFileOperations: new Map(), fileOperationState: { projectFileClipboard: null },
      versionService: { listProgress: async () => {
        inspirationListProgressCalls += 1;
        throw Object.assign(new Error('项目未登记，请先刷新项目列表'), { code: 'INVALID_DATABASE_OPERATION' });
      } },
      refreshManagedExternalWatchers: async () => { inspirationWatcherRefreshes += 1; },
      movePathAtomic, capturePathIdentity, throwIfCancelled,
      recycleBinService: { trash: async source => {
        fs.rmSync(source, { recursive: true });
        return { success: true, originalPath: source, recyclePidl: 'inspiration-trash', preciseRestore: true, permanent: false };
      } },
      workspaceRepository: { addUndoRecord: async () => ({ id: 'inspiration-trash-undo' }) },
      pushUndoOperation: async () => undefined, writeLog: () => undefined,
    });
    const inspirationOperation = inspirationHandlers.get('workspace-file-operation');
    let inspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'rename', ['rename-me.txt'], '', 'renamed.txt',
    );
    assert.strictEqual(inspirationResult.success, true, inspirationResult.error);
    assert.strictEqual(fs.readFileSync(path.join(inspirationProjectRoot, 'renamed.txt'), 'utf8'), 'rename');
    inspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'move', ['move-me.txt'], 'moved', '',
    );
    assert.strictEqual(inspirationResult.success, true, inspirationResult.error);
    assert.strictEqual(fs.readFileSync(path.join(inspirationMoveTarget, 'move-me.txt'), 'utf8'), 'move');
    inspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'trash', ['trash-me.txt'], '', '',
    );
    assert.strictEqual(inspirationResult.success, true, inspirationResult.error);
    assert.strictEqual(fs.existsSync(path.join(inspirationProjectRoot, 'trash-me.txt')), false);
    inspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'rename', ['watch-link.lnk'], '', 'watch-renamed',
    );
    assert.strictEqual(inspirationResult.success, true, inspirationResult.error);
    assert.strictEqual(fs.existsSync(path.join(inspirationProjectRoot, 'watch-renamed.lnk')), true);
    inspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'move', ['watch-move.lnk'], 'moved', '',
    );
    assert.strictEqual(inspirationResult.success, true, inspirationResult.error);
    assert.strictEqual(fs.existsSync(path.join(inspirationMoveTarget, 'watch-move.lnk')), true);
    inspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'trash', ['watch-trash.lnk'], '', '',
    );
    assert.strictEqual(inspirationResult.success, true, inspirationResult.error);
    assert.strictEqual(fs.existsSync(path.join(inspirationProjectRoot, 'watch-trash.lnk')), false);
    inspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'rename', ['watch-ancestor-rename'], '', 'watch-ancestor-renamed',
    );
    assert.strictEqual(inspirationResult.success, true, inspirationResult.error);
    inspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'move', ['watch-ancestor-move'], 'moved', '',
    );
    assert.strictEqual(inspirationResult.success, true, inspirationResult.error);
    inspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'trash', ['watch-ancestor-trash'], '', '',
    );
    assert.strictEqual(inspirationResult.success, true, inspirationResult.error);
    assert.strictEqual(inspirationListProgressCalls, 0, 'inspiration file operations must never query registered project progress');
    assert.strictEqual(inspirationWatcherRefreshes, 6, 'renaming, moving, and trashing external roots or ordinary ancestors must rebuild managed watchers with current virtual paths');
    const escapedInspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'rename', ['../outside-inspiration.txt'], '', 'escaped.txt',
    );
    assert.strictEqual(escapedInspirationResult.success, false, 'inspiration paths must remain confined to the inspiration root');
    assert.match(escapedInspirationResult.error, /项目路径无效/);
    assert.strictEqual(fs.readFileSync(escapedInspirationPath, 'utf8'), 'outside');
    const conflictedInspirationResult = await inspirationOperation(
      null, inspirationProjectRoot, '未分类', inspirationProjectName, 'rename', ['conflict-source.txt'], '', 'conflict-target.txt',
    );
    assert.strictEqual(conflictedInspirationResult.success, false, 'inspiration rename must preserve target conflict checks');
    assert.match(conflictedInspirationResult.error, /目标名称已被占用/);
    assert.strictEqual(fs.readFileSync(path.join(inspirationProjectRoot, 'conflict-source.txt'), 'utf8'), 'source');
    assert.strictEqual(fs.readFileSync(path.join(inspirationProjectRoot, 'conflict-target.txt'), 'utf8'), 'target');
    assert.strictEqual(inspirationListProgressCalls, 0, 'failed inspiration safety checks must not fall through to version registration');

    const managedRootGuardHandlers = new Map();
    const registeredProgressFolder = path.join(fileLinkProjectPath, '客户自由目录');
    const externalProgressTarget = path.join(root, 'external-progress-target');
    const externalProgressAncestor = path.join(fileLinkProjectPath, 'external-ancestor');
    const externalProgressShortcut = path.join(externalProgressAncestor, 'tracked.lnk');
    fs.mkdirSync(registeredProgressFolder);
    fs.mkdirSync(externalProgressTarget);
    fs.mkdirSync(externalProgressAncestor);
    importProjectVirtualPaths.createManagedExternalLink(externalProgressShortcut, { target: externalProgressTarget, kind: 'folder', displayName: 'tracked' });
    let externalProgressTrashedPath = '';
    let externalProgressExistsAfterRecycle = true;
    let managedRootListProgressCalls = 0;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => managedRootGuardHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => fileLinkProjectPath, ensureWorkspace: () => importWorkspaceRoot,
      projectVirtualPaths: importProjectVirtualPaths, activeProjectFileOperations: new Map(),
      versionService: { listProgress: async () => {
        managedRootListProgressCalls += 1;
        return { success: true, progressFolders: [
          { externalLinkRelativePath: 'linked-folder-source.lnk' },
          { id: 'registered-progress', nodeRole: 'progress', displayName: '客户自由目录', folderPath: registeredProgressFolder },
          { id: 'external-progress', nodeRole: 'progress', displayName: '外链进度', folderPath: externalProgressTarget, externalLinkRelativePath: 'external-ancestor/tracked.lnk' },
        ] };
      } },
      capturePathIdentity,
      recycleBinService: { trash: async source => { externalProgressTrashedPath = source; fs.unlinkSync(source); externalProgressExistsAfterRecycle = fs.existsSync(source); return { success: true, originalPath: source, recyclePidl: 'external-progress-trash', preciseRestore: true, permanent: false }; } },
      workspaceRepository: { addUndoRecord: async () => ({ id: 'external-progress-trash-undo' }) },
      pushUndoOperation: async () => undefined, writeLog: () => undefined,
    });
    const requestedMetadataPath = process.platform === 'win32'
      ? 'linked-folder-source.lnk\\inside.jpg'
      : 'linked-folder-source.lnk/inside.jpg';
    const externalFileDetails = await managedRootGuardHandlers.get('workspace-file-details')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, [requestedMetadataPath],
    );
    assert.strictEqual(externalFileDetails.success, true, externalFileDetails.error);
    assert.strictEqual(externalFileDetails.details.length, 1);
    assert.strictEqual(externalFileDetails.details[0].relativePath, requestedMetadataPath,
      'file-detail responses must preserve the requested path identity so Windows metadata hydration can match browse entries');
    assert.strictEqual(externalFileDetails.details[0].size, 6);
    const blockedRegisteredRename = await managedRootGuardHandlers.get('workspace-file-operation')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'rename', ['客户自由目录'], '', '绕过改名',
    );
    assert.strictEqual(blockedRegisteredRename.success, false);
    assert.match(blockedRegisteredRename.error, /已登记的版本进度/,
      'ordinary files IPC must use the registered progress identity, independent of legacy folder-name patterns');
    assert.strictEqual(managedRootListProgressCalls, 1, 'ordinary project rename must still query registered progress roots');
    assert.strictEqual(fs.existsSync(registeredProgressFolder), true);
    const blockedExternalAncestorRename = await managedRootGuardHandlers.get('workspace-file-operation')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'rename', ['external-ancestor'], '', 'external-renamed',
    );
    assert.strictEqual(blockedExternalAncestorRename.success, false, 'an external progress virtual ancestor must be protected');
    assert.match(blockedExternalAncestorRename.error, /祖先目录迁移/);
    const directExternalProgressTrash = await managedRootGuardHandlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } }, importWorkspaceRoot, '策划中', fileLinkProjectName, 'trash', ['external-ancestor/tracked.lnk'], '', '',
    );
    assert.strictEqual(directExternalProgressTrash.success, true, directExternalProgressTrash.error);
    assert.strictEqual(directExternalProgressTrash.count, 1, `external progress trash must process its shortcut (${externalProgressTrashedPath})`);
    assert.strictEqual(path.resolve(externalProgressTrashedPath), path.resolve(externalProgressShortcut), 'external progress trash must target the managed shortcut rather than its external folder');
    assert.strictEqual(externalProgressExistsAfterRecycle, false, 'the recycle helper removes the external progress shortcut');
    assert.strictEqual(fs.existsSync(externalProgressShortcut), false, 'direct external progress trash removes only the managed shortcut and leaves its DB identity missing');
    assert.strictEqual(fs.existsSync(externalProgressTarget), true, 'trashing an external progress link never deletes the external target content');
    const blockedTrackedMove = await managedRootGuardHandlers.get('workspace-file-operation')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'move', ['linked-folder-source.lnk'], '',
    );
    assert.strictEqual(blockedTrackedMove.success, false);
    assert.match(blockedTrackedMove.error, /已纳入版本树的外链不能使用普通移动或重命名/);
    const blockedTrackedRename = await managedRootGuardHandlers.get('workspace-file-operation')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'rename', ['linked-folder-source.lnk'], '', 'renamed-link',
    );
    assert.strictEqual(blockedTrackedRename.success, false);
    assert.match(blockedTrackedRename.error, /已纳入版本树的外链不能使用普通移动或重命名/);
    const blockedManagedCopy = await managedRootGuardHandlers.get('workspace-file-operation')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'copy', ['linked-folder-source.lnk'], '',
    );
    assert.strictEqual(blockedManagedCopy.success, false);
    assert.match(blockedManagedCopy.error, /外链根不能通过普通复制或剪切/);

    const preservedAdoptionSource = path.join(root, 'preserved-adoption-source');
    const preservedAdoptionShortcut = path.join(fileLinkProjectPath, 'preserved-adoption-source.lnk');
    fs.mkdirSync(preservedAdoptionSource, { recursive: true });
    fs.writeFileSync(path.join(preservedAdoptionSource, 'preserved.jpg'), 'preserved');
    failImportUndoOperation = true;
    failExternalAdoptionRollback = true;
    const failedAdoptionRollback = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [preservedAdoptionSource], adoptAsOriginal: true, mediaKind: 'image',
      },
    );
    failImportUndoOperation = false;
    failExternalAdoptionRollback = false;
    assert.strictEqual(failedAdoptionRollback.success, false, 'the original import failure must still be reported');
    assert.strictEqual(failedAdoptionRollback.recoveryRequired, true, 'a failed database rollback must advertise recovery state');
    assert.match(failedAdoptionRollback.error, /部分导入结果已保留/);
    assert(failedAdoptionRollback.recovery.cleanupErrors.some(item => item.path === 'external-adoption-registry'));
    assert.strictEqual(fs.existsSync(preservedAdoptionShortcut), true, 'a link still referenced by the database must be preserved');
    assert(importProjectVirtualPaths.readManagedExternalLink(preservedAdoptionShortcut), 'the preserved shortcut must retain its managed identity');

    failManagedExternalWatcher = true;
    const degradedWatch = await importProjectHandlers.get('workspace-watch-file-root')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, { reconcile: true },
    );
    assert.strictEqual(degradedWatch.success, true, 'the healthy project watcher must remain usable');
    assert.strictEqual(degradedWatch.degraded, true, 'one failed external watcher must degrade the aggregate result');
    assert(degradedWatch.failedRoots.some(item => item.external && item.virtualPath), 'failed external roots must be reported to the renderer');
    assert.strictEqual(trackingReconciliations > 0, true, 'watcher installation must reconcile changes missed while inactive');

    const degradedImportSource = path.join(root, 'degraded-watcher-import');
    fs.mkdirSync(degradedImportSource, { recursive: true });
    const undoCountBeforeDegradedImport = importUndoOperations.length;
    const degradedImport = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [degradedImportSource],
      },
    );
    assert.strictEqual(degradedImport.success, true, degradedImport.error);
    assert.strictEqual(degradedImport.watchDegraded, true, 'watch failure must use polling fallback instead of rolling back a valid import');
    assert.strictEqual(importUndoOperations.length, undoCountBeforeDegradedImport + 1, 'watch failure must leave exactly one valid undo record');
    failManagedExternalWatcher = false;

    const lockedRollbackSource = path.join(root, 'locked-rollback-source');
    const lockedRollbackShortcut = path.join(fileLinkProjectPath, 'locked-rollback-source.lnk');
    fs.mkdirSync(lockedRollbackSource, { recursive: true });
    failImportUndoOperation = true;
    failShortcutRemoval = true;
    const lockedRollback = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [lockedRollbackSource], adoptAsOriginal: true, mediaKind: 'image',
      },
    );
    failImportUndoOperation = false;
    failShortcutRemoval = false;
    assert.strictEqual(lockedRollback.recoveryRequired, true);
    assert(lockedRollback.recovery.cleanupErrors.some(item => item.path === lockedRollbackShortcut));
    assert.strictEqual(fs.existsSync(lockedRollbackShortcut), true, 'a locked shortcut must be reported and retained');
    assert(importProjectVirtualPaths.readManagedExternalLink(lockedRollbackShortcut), 'a retained shortcut must keep its managed identity');

    const cleanupCopySource = path.join(root, 'cleanup-copy-source.jpg');
    const cleanupCopyTarget = path.join(fileLinkProjectPath, 'cleanup-copy-source.jpg');
    fs.writeFileSync(cleanupCopySource, 'copy-cleanup');
    failImportUndoOperation = true;
    failCreatedTargetRemoval = true;
    const failedCopyCleanup = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        deleteSourceAfterImport: false, sourcePaths: [cleanupCopySource],
      },
    );
    failImportUndoOperation = false;
    failCreatedTargetRemoval = false;
    assert.strictEqual(failedCopyCleanup.recoveryRequired, true, 'ordinary copy cleanup failures must be surfaced');
    assert(failedCopyCleanup.recovery.leftoverPaths.includes(cleanupCopyTarget));
    assert.strictEqual(fs.existsSync(cleanupCopyTarget), true);

    const normalRollbackSource = path.join(root, 'normal-rollback-source.jpg');
    const normalRollbackTarget = path.join(fileLinkProjectPath, 'normal-rollback-source.jpg');
    fs.writeFileSync(normalRollbackSource, 'normal-rollback');
    failImportUndoOperation = true;
    const normalRollback = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        deleteSourceAfterImport: false, sourcePaths: [normalRollbackSource],
      },
    );
    failImportUndoOperation = false;
    assert.strictEqual(normalRollback.success, false, 'post-copy failure must report failure after rollback');
    assert.strictEqual(normalRollback.recoveryRequired, undefined, 'a normal rollback must not request recovery');
    assert.strictEqual(fs.existsSync(normalRollbackTarget), false, 'normal failure rollback must remove this transaction\'s created target');

    const escapedRollbackSource = path.join(root, 'escaped-rollback-source.jpg');
    const escapedRollbackTarget = path.join(fileLinkProjectPath, 'escaped-rollback-source.jpg');
    fs.writeFileSync(escapedRollbackSource, 'escaped-rollback');
    failImportUndoOperation = true;
    escapedCleanupTarget = escapedRollbackTarget;
    const escapedRollback = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        deleteSourceAfterImport: false, sourcePaths: [escapedRollbackSource],
      },
    );
    escapedCleanupTarget = '';
    failImportUndoOperation = false;
    assert.strictEqual(escapedRollback.recoveryRequired, true, 'a replaced target resolving outside allowed roots must require recovery');
    assert(escapedRollback.recovery.leftoverPaths.includes(escapedRollbackTarget));
    assert(escapedRollback.recovery.cleanupErrors.some(item => /realpath.*逃逸/.test(item.error)));
    assert.strictEqual(fs.existsSync(escapedRollbackTarget), true, 'cleanup must refuse to delete an out-of-bounds replacement');

    const retryableUndoSource = path.join(root, 'retryable-undo-source');
    fs.mkdirSync(retryableUndoSource, { recursive: true });
    const retryableUndoImport = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [retryableUndoSource],
      },
    );
    assert.strictEqual(retryableUndoImport.success, true, retryableUndoImport.error);
    const retryableUndoShortcut = path.join(fileLinkProjectPath, 'retryable-undo-source.lnk');
    assert.deepStrictEqual(importUndoOperations.at(-1).managedExternalWatcher, {
      workspacePath: importWorkspaceRoot, status: '策划中', projectName: fileLinkProjectName,
    });
    const watcherAcquisitionsBeforeUndo = managedWatcherAcquisitions;
    failManagedLinkRevoke = true;
    const firstUndoAttempt = await importProjectHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(firstUndoAttempt.success, false, 'a registry failure must be reported without losing the undo operation');
    assert.strictEqual(fs.existsSync(retryableUndoShortcut), false, 'the shortcut removal may already have committed before the registry failure');
    failManagedLinkRevoke = false;
    const retriedUndo = await importProjectHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(retriedUndo.success, true, retriedUndo.error);
    assert(managedWatcherAcquisitions > watcherAcquisitionsBeforeUndo, 'undoing an external link must rebuild the project watcher bindings');

    const adoptedFolderSource = path.join(root, 'adopted-external-original');
    fs.mkdirSync(adoptedFolderSource, { recursive: true });
    fs.writeFileSync(path.join(adoptedFolderSource, 'original.jpg'), 'original');
    const adoptedLink = await importProjectHandlers.get('workspace-import-files')(
      null, importWorkspaceRoot, path.basename(path.dirname(fileLinkProjectPath)), fileLinkProjectName, '', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [adoptedFolderSource], adoptAsOriginal: true, mediaKind: 'image',
      },
    );
    assert.strictEqual(adoptedLink.success, true, adoptedLink.error);
    assert.deepStrictEqual(importUndoOperations.at(-1).externalAdoptionUndo.progressIds, ['adopted-adopted-external-original']);
    const undoneAdoptedLink = await importProjectHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(undoneAdoptedLink.success, true, undoneAdoptedLink.error);
    assert.deepStrictEqual(revertedExternalAdoptions.at(-1), { projectName: fileLinkProjectName, progressIds: ['adopted-adopted-external-original'] });
    assert.strictEqual(fs.existsSync(path.join(fileLinkProjectPath, 'adopted-external-original.lnk')), false);

    const copiedFolderSource = path.join(root, 'copied-folder-source');
    fs.mkdirSync(path.join(copiedFolderSource, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(copiedFolderSource, 'nested', 'inside.txt'), 'folder-copy');
    const copiedFolder = await importProjectHandlers.get('workspace-import-files')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      importWorkspaceRoot, '策划中', fileLinkProjectName, '', { deleteSourceAfterImport: false, sourcePaths: [copiedFolderSource] },
    );
    assert.strictEqual(copiedFolder.success, true, copiedFolder.error);
    assert.strictEqual(fs.readFileSync(path.join(copiedFolderSource, 'nested', 'inside.txt'), 'utf8'), 'folder-copy', 'copying an imported folder must preserve its source');
    assert.strictEqual(fs.readFileSync(path.join(fileLinkProjectPath, 'copied-folder-source', 'nested', 'inside.txt'), 'utf8'), 'folder-copy', 'normal file import must preserve a dropped folder tree');

    const progressLinkSource = path.join(root, 'progress-link-source');
    fs.mkdirSync(progressLinkSource, { recursive: true });
    fs.writeFileSync(path.join(progressLinkSource, 'progress.jpg'), 'progress');
    const linkedProgress = await importProjectHandlers.get('workspace-import-progress-files')(
      null, importWorkspaceRoot, '策划中', fileLinkProjectName, 'linked-progress', {
        linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [progressLinkSource], mediaKind: 'image', versionKey: '1', parentProgressId: 'original-id', trackingEnabled: true, trackingState: 'pending_compare',
      },
    );
    assert.strictEqual(linkedProgress.success, true, linkedProgress.error);
    assert.strictEqual(fs.readFileSync(path.join(progressLinkSource, 'progress.jpg'), 'utf8'), 'progress');
    assert.strictEqual(fs.existsSync(path.join(fileLinkProjectPath, 'linked-progress.lnk')), true);
    assert.strictEqual(progressRegistrationPath, progressLinkSource, 'linked progress must register the external target without copying it');
    const undoneLinkedProgress = await importProjectHandlers.get('workspace-undo-rename')(null, '');
    assert.strictEqual(undoneLinkedProgress.success, true, undoneLinkedProgress.error);
    assert.deepStrictEqual(unregisteredExternalProgress.at(-1), { projectName: fileLinkProjectName, progressId: 'progress-id', allowMissing: true });
    assert.strictEqual(fs.existsSync(path.join(fileLinkProjectPath, 'linked-progress.lnk')), false);

    const brollHandlers = new Map();
    const brollProjectName = 'broll-link-project';
    const brollProjectPath = path.join(importWorkspaceRoot, '策划中', brollProjectName);
    const brollSource = path.join(root, 'linked-broll.mov');
    fs.mkdirSync(brollProjectPath, { recursive: true });
    fs.writeFileSync(brollSource, 'broll');
    registerBrollImportIpc({
      ipcMain: { handle: (name, handler) => brollHandlers.set(name, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell: importShell,
      projectVirtualPaths: importProjectVirtualPaths,
      recycleBinService: {}, getMainWindow: () => null,
      getProjectPath: () => brollProjectPath, getRunConfig: () => { throw new Error('link import must not start media workers'); },
      writeLog: () => undefined, pushUndoOperation: async () => undefined, activeOperations: new Map(), backgroundTasks: null, getTelemetry: () => null,
    });
    const linkedBroll = await brollHandlers.get('workspace-import-broll')(
      null, importWorkspaceRoot, '策划中', brollProjectName, { linkOnly: true, deleteSourceAfterImport: false, sourcePaths: [brollSource] },
    );
    assert.strictEqual(linkedBroll.success, true, linkedBroll.error);
    assert.strictEqual(linkedBroll.linked, true);
    assert.strictEqual(fs.readFileSync(brollSource, 'utf8'), 'broll');
    assert.strictEqual(fs.existsSync(path.join(brollProjectPath, '花絮', 'linked-broll.mov.lnk')), true);

    const brollFolderSource = path.join(root, 'broll-folder-source');
    fs.mkdirSync(path.join(brollFolderSource, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(brollFolderSource, 'nested', 'folder-broll.jpg'), 'folder-broll');
    fs.writeFileSync(path.join(brollFolderSource, 'nested', 'ignore.txt'), 'ignore');
    const importedBrollFolder = await brollHandlers.get('workspace-import-broll')(
      { sender: { isDestroyed: () => false, send: () => {} } },
      importWorkspaceRoot, '策划中', brollProjectName, { deleteSourceAfterImport: false, sourcePaths: [brollFolderSource] },
    );
    assert.strictEqual(importedBrollFolder.success, true, importedBrollFolder.error);
    assert.strictEqual(fs.readFileSync(path.join(brollProjectPath, '花絮', 'folder-broll.jpg'), 'utf8'), 'folder-broll', 'b-roll import must recursively accept a dropped folder');
    assert.strictEqual(fs.existsSync(path.join(brollProjectPath, '花絮', 'ignore.txt')), false, 'b-roll folder import must ignore unsupported files');

    const materializeProjectName = 'materialize-project';
    const materializeProjectPath = path.join(importWorkspaceRoot, '策划中', materializeProjectName);
    const materializeSource = path.join(root, 'materialize-source');
    fs.mkdirSync(materializeProjectPath, { recursive: true });
    fs.mkdirSync(materializeSource, { recursive: true });
    fs.writeFileSync(path.join(materializeSource, 'tracked.jpg'), 'tracked');
    const materializeShortcut = path.join(materializeProjectPath, 'external-folder.lnk');
    importProjectVirtualPaths.createManagedExternalLink(materializeShortcut, { target: materializeSource, kind: 'folder', displayName: 'external-folder' });
    materializedProgressFolders = [{ id: 'external-progress', mediaKind: 'image', versionKey: '1', displayName: 'external-progress', folderPath: materializeSource, externalLinkRelativePath: 'external-folder.lnk', trackingEnabled: true, trackingState: 'pending_compare', nodeRole: 'progress', relationKind: 'main', renameFromParent: false, copyMissingFromParent: false }];
    const materialized = await importProjectHandlers.get('workspace-materialize-external-links')(
      null, importWorkspaceRoot, '策划中', materializeProjectName, ['external-folder.lnk'],
    );
    assert.strictEqual(materialized.success, true, materialized.error);
    const materializedDestination = path.join(materializeProjectPath, 'external-folder');
    assert.strictEqual(fs.existsSync(materializeSource), false);
    assert.strictEqual(fs.readFileSync(path.join(materializedDestination, 'tracked.jpg'), 'utf8'), 'tracked');
    assert.strictEqual(fs.existsSync(materializeShortcut), false);
    assert.strictEqual(progressRegistrationPath, materializedDestination, 'materializing a tracked external folder must relocate its database path');

    const rollbackSource = path.join(root, 'materialize-rollback-source');
    fs.mkdirSync(rollbackSource, { recursive: true });
    fs.writeFileSync(path.join(rollbackSource, 'rollback.jpg'), 'rollback');
    const rollbackShortcut = path.join(materializeProjectPath, 'rollback-folder.lnk');
    importProjectVirtualPaths.createManagedExternalLink(rollbackShortcut, { target: rollbackSource, kind: 'folder', displayName: 'rollback-folder' });
    materializedProgressFolders = [{ ...materializedProgressFolders[0], id: 'rollback-progress', folderPath: rollbackSource, externalLinkRelativePath: 'rollback-folder.lnk' }];
    failProgressRelocation = true;
    const rolledBackMaterialization = await importProjectHandlers.get('workspace-materialize-external-links')(
      null, importWorkspaceRoot, '策划中', materializeProjectName, ['rollback-folder.lnk'],
    );
    failProgressRelocation = false;
    assert.strictEqual(rolledBackMaterialization.success, false, 'database relocation failure must fail the materialization');
    assert.strictEqual(fs.readFileSync(path.join(rollbackSource, 'rollback.jpg'), 'utf8'), 'rollback');
    assert.strictEqual(fs.existsSync(rollbackShortcut), true, 'failed materialization must restore the shortcut');

    const lockedShortcutSource = path.join(root, 'materialize-locked-shortcut-source');
    fs.mkdirSync(lockedShortcutSource, { recursive: true });
    fs.writeFileSync(path.join(lockedShortcutSource, 'locked.jpg'), 'locked');
    const lockedShortcut = path.join(materializeProjectPath, 'locked-folder.lnk');
    importProjectVirtualPaths.createManagedExternalLink(lockedShortcut, { target: lockedShortcutSource, kind: 'folder', displayName: 'locked-folder' });
    materializedProgressFolders = [];
    failShortcutRemoval = true;
    const lockedShortcutMaterialization = await importProjectHandlers.get('workspace-materialize-external-links')(
      null, importWorkspaceRoot, '策划中', materializeProjectName, ['locked-folder.lnk'],
    );
    failShortcutRemoval = false;
    assert.strictEqual(lockedShortcutMaterialization.success, false, 'shortcut removal failure must fail the materialization');
    assert.strictEqual(fs.readFileSync(path.join(lockedShortcutSource, 'locked.jpg'), 'utf8'), 'locked', 'a post-move shortcut failure must move the folder back');
    assert.strictEqual(fs.existsSync(lockedShortcut), true, 'a post-move shortcut failure must retain the original shortcut');

    const failoverHandlers = new Map();
    const fullWorkspace = path.join(root, 'full-workspace');
    const healthyWorkspace = path.join(root, 'healthy-workspace');
    fs.mkdirSync(fullWorkspace, { recursive: true });
    fs.mkdirSync(healthyWorkspace, { recursive: true });
    fs.mkdirSync(path.join(fullWorkspace, '策划中'), { recursive: true });
    fs.mkdirSync(path.join(healthyWorkspace, '策划中'), { recursive: true });
    let healthyWorkspaceFull = false;
    const failoverFs = {
      ...fs,
      promises: {
        ...fs.promises,
        statfs: async directory => path.resolve(directory) === path.resolve(fullWorkspace) || healthyWorkspaceFull
          ? { bavail: 1, bsize: 4096 }
          : { bavail: 1024 * 1024, bsize: 4096 },
      },
    };
    const failoverCatalogs = new Map([
      [fullWorkspace, { byName: new Map(), projects: [] }],
      [healthyWorkspace, { byName: new Map(), projects: [] }],
    ]);
    let createdWorkspaceRoot = '';
    registerWorkspaceIpc({
      Array, Boolean, Date, Error, Math, Object, Promise, Set, String, undefined, crypto,
      ipcMain: { handle: (name, handler) => failoverHandlers.set(name, handler) }, fs: failoverFs, path,
      CANCELLED_CODE, WORKSPACE_STATUSES: ['策划中'], HIDDEN_SYSTEM_ENTRY_NAMES: new Set(),
      IMAGE_EXTENSIONS: new Set(['.jpg']), RAW_EXTENSIONS: new Set(['.cr3']), VIDEO_EXTENSIONS: new Set(['.mov']),
      cleanProjectName: value => String(value).trim(),
      ensureWorkspace: candidate => path.resolve(candidate),
      getProjectPath: (workspaceRoot, status, name) => path.join(workspaceRoot, status, name),
      getWorkspaceDataRoot: workspaceRoot => path.join(workspaceRoot, '.data'),
      workspaceCatalogs: failoverCatalogs,
      refreshWorkspaceCatalog: async workspaceRoot => failoverCatalogs.get(workspaceRoot),
      mutateWorkspaceCatalog: async (workspaceRoot, _operation, entry) => {
        createdWorkspaceRoot = workspaceRoot;
        return { byName: new Map([[entry.name.toLocaleLowerCase(), { id: 'failover-project-id', name: entry.name }]]), projects: [] };
      },
      pushUndoOperation: async () => undefined, writeLog: () => undefined, telemetryService: { track: () => undefined },
    });
    const failoverProject = await failoverHandlers.get('workspace-create-project')(
      null, fullWorkspace, null, 'failover-project', { workspacePaths: [fullWorkspace, healthyWorkspace], createPlanningFolder: false },
    );
    assert.strictEqual(failoverProject.success, true, failoverProject.error);
    assert.strictEqual(failoverProject.storageSwitched, true);
    assert.strictEqual(createdWorkspaceRoot, healthyWorkspace);
    assert.strictEqual(failoverProject.project.workspacePath, healthyWorkspace);
    const fullOnlyProject = await failoverHandlers.get('workspace-create-project')(
      null, fullWorkspace, null, 'full-only-project', { workspacePaths: [fullWorkspace], createPlanningFolder: false },
    );
    assert.strictEqual(fullOnlyProject.success, false, 'a full single workspace must reject project creation');
    assert.match(fullOnlyProject.error, /添加新的项目工作目录/);
    healthyWorkspaceFull = true;
    const allFullProject = await failoverHandlers.get('workspace-create-project')(
      null, fullWorkspace, null, 'all-full-project', { workspacePaths: [fullWorkspace, healthyWorkspace], createPlanningFolder: false },
    );
    assert.strictEqual(allFullProject.success, false, 'project creation must stop when every configured workspace is full');
    assert.match(allFullProject.error, /设置 → 存储/);

    const concurrencyHandlers = new Map();
    const activeOperations = new Map();
    let releaseClipboardRead;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, undefined, crypto,
      ipcMain: { handle: (name, handler) => concurrencyHandlers.set(name, handler), on: () => {} },
      fs, path, getProjectPath: () => conflictProject, activeProjectFileOperations: activeOperations,
      fileOperationState: { projectFileClipboard: null }, assertInside, assertExistingInside,
      readSystemFileClipboard: async () => new Promise(resolve => { releaseClipboardRead = resolve; }),
      mainWindow: null, writeLog: () => {},
    });
    const concurrentHandler = concurrencyHandlers.get('workspace-file-operation');
    const firstPaste = concurrentHandler({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], '');
    await new Promise(resolve => setImmediate(resolve));
    const secondPaste = await concurrentHandler({ sender: { isDestroyed: () => false, send: () => {} } }, 'workspace', '策划中', 'project', 'paste', [], '');
    assert.strictEqual(secondPaste.success, false);
    assert.match(secondPaste.error, /已有文件粘贴任务/);
    releaseClipboardRead(null);
    await firstPaste;
    assert.strictEqual(activeOperations.size, 0);
    console.log('file transfer service tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const testTimeout = setTimeout(() => {
  console.error('file transfer service tests timed out before completing');
  process.exit(1);
}, 60000);
run().then(() => clearTimeout(testTimeout)).catch(error => {
  clearTimeout(testTimeout);
  console.error(error);
  process.exit(1);
});
