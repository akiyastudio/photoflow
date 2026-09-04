const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawn, spawnSync } = require('child_process');
const { createFilePublicationService, publicationBatchTimeoutMs, runPublicationJson } = require('../electron/services/file-publication-service.cjs');
const { collectCopyPlan, copyPlannedFiles } = require('../electron/services/file-transfer-service.cjs');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const run = async () => {
  if (process.platform !== 'win32') { console.log('native file publication tests skipped outside Windows'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-native-publication-'));
  const manifestSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'native', 'FilePublicationService.manifest'), 'utf8');
  const buildSource = fs.readFileSync(path.join(__dirname, 'build-file-publication-service.cjs'), 'utf8');
  assert(manifestSource.includes('<ws2:longPathAware>true</ws2:longPathAware>') && buildSource.includes('/win32manifest:'));
  const service = createFilePublicationService({ app: { isPackaged: false }, projectRoot: path.resolve(__dirname, '..') });
  try {
    for (const directoryCase of [false, true]) {
      const source = path.join(root, directoryCase ? 'source-dir' : 'source.txt');
      const target = path.join(root, directoryCase ? 'target-dir' : 'target.txt');
      if (directoryCase) { fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'owned.txt'), 'owned'); }
      else fs.writeFileSync(source, 'owned');
      await service.moveNoReplace(source, target);
      assert.strictEqual(fs.existsSync(source), false);
      assert.strictEqual(fs.existsSync(target), true);
    }
    const conflictSource = path.join(root, 'conflict-source.txt'); const conflictTarget = path.join(root, 'conflict-target.txt');
    fs.writeFileSync(conflictSource, 'source'); fs.writeFileSync(conflictTarget, 'unknown');
    await assert.rejects(service.moveNoReplace(conflictSource, conflictTarget), error => error.code === 'EEXIST');
    assert.strictEqual(fs.readFileSync(conflictSource, 'utf8'), 'source'); assert.strictEqual(fs.readFileSync(conflictTarget, 'utf8'), 'unknown');
    const batchSource = path.join(root, 'batch-source'); const batchTarget = path.join(root, 'batch-target'); fs.mkdirSync(batchSource);
    for (let index = 0; index < 200; index += 1) fs.writeFileSync(path.join(batchSource, `${index}.bin`), Buffer.from([index & 0xff]));
    const batchPlan = []; await collectCopyPlan(batchSource, batchTarget, batchPlan);
    let helperSpawns = 0;
    const supervisedService = createFilePublicationService({ app: { isPackaged: false }, projectRoot: path.resolve(__dirname, '..'), processSupervisor: { launch: spec => { helperSpawns += 1; return { child: spawn(spec.command, spec.args, { ...spec.options, windowsHide: true }) }; } } });
    const baselineRoot = path.join(root, 'batch-baseline'); fs.mkdirSync(baselineRoot);
    const baselineStarted = process.hrtime.bigint(); for (let index = 0; index < 200; index += 1) fs.copyFileSync(path.join(batchSource, `${index}.bin`), path.join(baselineRoot, `${index}.bin`)); const baselineMs = Number(process.hrtime.bigint() - baselineStarted) / 1e6;
    const batchStarted = process.hrtime.bigint(); await copyPlannedFiles(batchPlan, { nativePublicationService: supervisedService, smallFileConcurrency: 16 }); const batchMs = Number(process.hrtime.bigint() - batchStarted) / 1e6;
    assert(helperSpawns <= 8, `a 200-small-file plan must use bounded chunk helpers, not one process per item (got ${helperSpawns})`);
    assert(batchMs < Math.max(3000, baselineMs * 12), `batched 200-file publication is unexpectedly slow: ${batchMs.toFixed(1)}ms vs ${baselineMs.toFixed(1)}ms baseline`);
    assert.strictEqual(fs.readdirSync(batchTarget).length, 200);
    console.log(`small-file batch performance: ${batchMs.toFixed(1)}ms (copy baseline ${baselineMs.toFixed(1)}ms, helper spawns ${helperSpawns})`);
    const partialSources = [0, 1, 2].map(index => path.join(root, `partial-source-${index}.bin`)); const partialTargets = [0, 1, 2].map(index => path.join(root, `partial-target-${index}.bin`));
    partialSources.forEach((candidate, index) => fs.writeFileSync(candidate, Buffer.from([index]))); fs.writeFileSync(partialTargets[1], 'conflict');
    const partialInspections = await service.inspectPathsBatch(partialSources);
    await assert.rejects(service.moveNoReplaceBatch(partialSources.map((sourcePath, index) => ({ source: sourcePath, target: partialTargets[index], identity: partialInspections[index].identity }))), error => {
      assert.strictEqual(error.code, 'EEXIST'); assert.strictEqual(error.failedIndex, 1); assert.deepStrictEqual(error.completed.map(item => item.index), [0]); return true;
    });
    assert(!fs.existsSync(partialSources[0]) && fs.existsSync(partialTargets[0]), 'items before a batch conflict are precisely reported as published');
    assert(fs.existsSync(partialSources[1]) && fs.existsSync(partialSources[2]), 'the failed and later items remain untouched');
    assert.strictEqual(fs.readFileSync(partialTargets[1], 'utf8'), 'conflict'); assert(!fs.existsSync(partialTargets[2]));
    const deleteTarget = path.join(root, 'delete-owned.txt'); const content = Buffer.from('delete owned'); fs.writeFileSync(deleteTarget, content);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const deleteIdentity = (await service.inspectPath(deleteTarget)).identity;
    await assert.rejects(service.compareDeleteFile({ target: deleteTarget, sha256: '0'.repeat(64), size: content.length, identity: deleteIdentity }));
    assert.strictEqual(fs.existsSync(deleteTarget), true);
    await service.compareDeleteFile({ target: deleteTarget, sha256, size: content.length, identity: deleteIdentity });
    assert.strictEqual(fs.existsSync(deleteTarget), false);
    const fastCutSources = [0, 1, 2].map(index => path.join(root, `fast-cut-source-${index}.bin`)); const fastCutTargets = [0, 1, 2].map(index => path.join(root, `fast-cut-target-${index}.bin`));
    fastCutSources.forEach((candidate, index) => fs.writeFileSync(candidate, Buffer.alloc(1024 * 1024, index + 1))); const fastCutSnapshots = await service.inspectPathsBatch(fastCutSources);
    const fastCutResults = await service.copyCutFilesBatch(fastCutSources.map((sourcePath, index) => ({ source: sourcePath, target: fastCutTargets[index], identity: fastCutSnapshots[index].identity, size: fastCutSnapshots[index].size, lastWriteTime: fastCutSnapshots[index].lastWriteTime, changeTime: fastCutSnapshots[index].changeTime })));
    assert(fastCutResults.every(result => result.sourceDeleted && result.published && /^[a-f0-9]{64}$/.test(result.sha256)), 'native fast cut returns identity-bound copy credentials'); assert(fastCutSources.every(candidate => !fs.existsSync(candidate))); assert(fastCutTargets.every((candidate, index) => fs.statSync(candidate).size === 1024 * 1024 && fs.readFileSync(candidate).every(byte => byte === index + 1)));
    const fastCutConflictSource = path.join(root, 'fast-cut-conflict-source.bin'); const fastCutConflictTarget = path.join(root, 'fast-cut-conflict-target.bin'); fs.writeFileSync(fastCutConflictSource, content); fs.writeFileSync(fastCutConflictTarget, 'occupied'); const fastCutConflictSnapshot = (await service.inspectPathsBatch([fastCutConflictSource]))[0];
    await assert.rejects(service.copyCutFilesBatch([{ source: fastCutConflictSource, target: fastCutConflictTarget, identity: fastCutConflictSnapshot.identity, size: fastCutConflictSnapshot.size, lastWriteTime: fastCutConflictSnapshot.lastWriteTime, changeTime: fastCutConflictSnapshot.changeTime }]), error => error.code === 'EEXIST'); assert.strictEqual(fs.readFileSync(fastCutConflictSource, 'utf8'), content.toString()); assert.strictEqual(fs.readFileSync(fastCutConflictTarget, 'utf8'), 'occupied');
    const fastCutChangedSource = path.join(root, 'fast-cut-changed-source.bin'); const fastCutChangedTarget = path.join(root, 'fast-cut-changed-target.bin'); fs.writeFileSync(fastCutChangedSource, 'before'); const fastCutChangedSnapshot = (await service.inspectPathsBatch([fastCutChangedSource]))[0]; fs.writeFileSync(fastCutChangedSource, 'after!');
    await assert.rejects(service.copyCutFilesBatch([{ source: fastCutChangedSource, target: fastCutChangedTarget, identity: fastCutChangedSnapshot.identity, size: fastCutChangedSnapshot.size, lastWriteTime: fastCutChangedSnapshot.lastWriteTime, changeTime: fastCutChangedSnapshot.changeTime }]), error => error.code === 'PUBLISH_OWNERSHIP_CONFLICT'); assert.strictEqual(fs.readFileSync(fastCutChangedSource, 'utf8'), 'after!'); assert.strictEqual(fs.existsSync(fastCutChangedTarget), false);
    const replacedDelete = path.join(root, 'delete-replaced.txt'); const retainedDelete = `${replacedDelete}.original`;
    fs.writeFileSync(replacedDelete, content); const replacedDeleteIdentity = (await service.inspectPath(replacedDelete)).identity; fs.renameSync(replacedDelete, retainedDelete); fs.writeFileSync(replacedDelete, content);
    await assert.rejects(service.compareDeleteFile({ target: replacedDelete, sha256, size: content.length, identity: replacedDeleteIdentity }), error => error.code === 'PUBLISH_OWNERSHIP_CONFLICT');
    assert.strictEqual(fs.readFileSync(replacedDelete, 'utf8'), content.toString()); assert(fs.existsSync(retainedDelete));
    const readOnlyDelete = path.join(root, 'delete-readonly.txt'); fs.writeFileSync(readOnlyDelete, content); fs.chmodSync(readOnlyDelete, 0o444); const readOnlyIdentity = (await service.inspectPath(readOnlyDelete)).identity;
    await service.compareDeleteFile({ target: readOnlyDelete, sha256, size: content.length, identity: readOnlyIdentity }); assert(!fs.existsSync(readOnlyDelete), 'owned read-only staging must be removed');
    const replacedSource = path.join(root, 'commit-replaced-source.txt'); const retainedSource = `${replacedSource}.original`; const replacedStaged = path.join(root, 'commit-replaced-staged.txt'); const replacedTarget = path.join(root, 'commit-replaced-target.txt');
    fs.writeFileSync(replacedSource, content); const replacedSourceIdentity = (await service.inspectPath(replacedSource)).identity; fs.renameSync(replacedSource, retainedSource); fs.writeFileSync(replacedSource, content); fs.writeFileSync(replacedStaged, content);
    await assert.rejects(service.commitCrossVolumeFile({ source: replacedSource, staged: replacedStaged, target: replacedTarget, sha256, size: content.length, sourceIdentity: replacedSourceIdentity }), error => error.code === 'PUBLISH_OWNERSHIP_CONFLICT');
    assert.strictEqual(fs.readFileSync(replacedSource, 'utf8'), content.toString()); assert(fs.existsSync(retainedSource)); assert(fs.existsSync(replacedStaged), 'pre-publish identity rejection retains owned staging'); assert(!fs.existsSync(replacedTarget), 'pre-publish identity rejection creates no target');
    let longRoot = root;
    while (longRoot.length < 440) longRoot = path.join(longRoot, `segment-${String(longRoot.length).padStart(4, '0')}`);
    fs.mkdirSync(longRoot, { recursive: true });
    const longSource = path.join(longRoot, 'long-source.txt'); const longTarget = path.join(longRoot, 'long-target.txt');
    fs.writeFileSync(longSource, 'long file'); assert(longSource.length > 431); await service.moveNoReplace(longSource, longTarget); assert.strictEqual(fs.readFileSync(longTarget, 'utf8'), 'long file');
    const longDirectorySource = path.join(longRoot, 'long-directory-source'); const longDirectoryTarget = path.join(longRoot, 'long-directory-target'); fs.mkdirSync(longDirectorySource); fs.writeFileSync(path.join(longDirectorySource, 'inside.txt'), 'inside'); await service.moveNoReplace(longDirectorySource, longDirectoryTarget); assert.strictEqual(fs.readFileSync(path.join(longDirectoryTarget, 'inside.txt'), 'utf8'), 'inside');
    const longConflictSource = path.join(longRoot, 'long-conflict-source'); const longConflictTarget = path.join(longRoot, 'long-conflict-target'); fs.writeFileSync(longConflictSource, 'source'); fs.writeFileSync(longConflictTarget, 'unknown'); await assert.rejects(service.moveNoReplace(longConflictSource, longConflictTarget), error => error.code === 'EEXIST'); assert.strictEqual(fs.readFileSync(longConflictSource, 'utf8'), 'source'); assert.strictEqual(fs.readFileSync(longConflictTarget, 'utf8'), 'unknown');
    for (const invalid of ['relative\\file.txt', '\\\\.\\PhysicalDrive0', '\\\\?\\C:\\device.txt', '\\\\server-only']) {
      const result = spawnSync(service.executable(), ['move-no-replace', '--source', invalid, '--target', path.join(root, 'invalid-target')], { encoding: 'utf8', windowsHide: true });
      const payload = JSON.parse(String(result.stdout).trim().split(/\r?\n/).filter(Boolean).pop()); assert.strictEqual(payload.code, 'EINVAL', `invalid path must map to EINVAL: ${invalid}`);
    }
    const overlongComponent = 'x'.repeat(300);
    const overlongResult = spawnSync(service.executable(), ['move-no-replace', '--source', path.join(root, overlongComponent), '--target', path.join(root, `${overlongComponent}y`)], { encoding: 'utf8', windowsHide: true });
    const overlongPayload = JSON.parse(String(overlongResult.stdout).trim().split(/\r?\n/).filter(Boolean).pop());
    assert.strictEqual(overlongPayload.code, 'ENAMETOOLONG', 'Win32 long-name failures must not leak WIN32_123/WIN32_206');
    const nativeSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'native', 'FilePublicationService.cs'), 'utf8');
    assert(nativeSource.includes('code == 123 || code == 206') && nativeSource.includes('return "ENAMETOOLONG"'), 'both ERROR_INVALID_NAME and ERROR_FILENAME_EXCED_RANGE must map to ENAMETOOLONG');
    assert(nativeSource.includes('PostCommitException') && nativeSource.includes('failure["published"] = true') && nativeSource.includes('failed["outcomeUnknown"] = true'), 'directory and batch post-commit verification failures must not masquerade as unpublished failures');
    assert(nativeSource.includes('GetFileInformationByHandleEx') && nativeSource.includes('SetBasicInformationByHandle') && nativeSource.includes('RestoreAttributes(SafeFileHandle') && !nativeSource.includes('RestoreAttributes(string filePath'), 'read-only attributes must be captured and restored through the verified object handle, never a replaceable path');
    assert(nativeSource.includes('OpenLocked(filePath, GENERIC_READ | DELETE);') && nativeSource.includes('OpenLocked(filePath, GENERIC_READ | DELETE | FILE_WRITE_ATTRIBUTES)') && nativeSource.includes('(originalAttributes.FileAttributes & FILE_ATTRIBUTE_READONLY) == 0'), 'ordinary deletes must not require FILE_WRITE_ATTRIBUTES; only verified read-only objects are reopened with attribute-write access');
    let cleanupRecovery = Buffer.from(path.join(root, 'cleanup.photoflow-quarantine-1'), 'utf8').toString('base64');
    const cleanupProtocol = createFilePublicationService({ app: { isPackaged: false }, projectRoot: root, invokeOverride: async operation => operation === 'delete-paths-batch' ? { success: true, results: [{ index: 0, success: false, recoveryPathBase64: cleanupRecovery }] } : null });
    const cleanupResult = await cleanupProtocol.deletePathsBatch([{ path: path.join(root, 'cleanup'), identity: 'identity' }]); assert(cleanupResult[0].recoveryPath.endsWith('cleanup.photoflow-quarantine-1'));
    cleanupRecovery = Buffer.from(`${root}${path.sep}nested${path.sep}..${path.sep}cleanup.photoflow-quarantine-2`, 'utf8').toString('base64');
    await assert.rejects(cleanupProtocol.deletePathsBatch([{ path: path.join(root, 'cleanup'), identity: 'identity' }]), error => error.code === 'FILE_PUBLICATION_PROTOCOL_ERROR');
    const makeChild = ({ killReturns = true } = {}) => { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.kill = () => killReturns; return child; };
    const postCommitChild = makeChild(); const postCommit = assert.rejects(runPublicationJson('helper', [], 1000, null, { spawnImpl: () => postCommitChild }), error => error.published === true && error.outcomeUnknown === true && error.recoveryPath === 'recovery' && error.identity === 'identity'); postCommitChild.stdout.end(JSON.stringify({ success: false, code: 'EIO', error: 'durability unknown', published: true, outcomeUnknown: true, recoveryPath: 'recovery', identity: 'identity' })); postCommitChild.exitCode = 1; postCommitChild.emit('close', 1, null); await postCommit;
    const cleanupChild = makeChild(); const cleanupFailure = assert.rejects(runPublicationJson('helper', [], 1000, null, { spawnImpl: () => cleanupChild }), error => error.deleted === true && error.outcomeUnknown === true && error.cleanupWarning === true && error.phase === 'post-unlink-cleanup' && error.recoveryPath === undefined); cleanupChild.stdout.end(JSON.stringify({ success: false, code: 'EIO', error: 'cleanup durability unknown', deleted: true, outcomeUnknown: true, cleanupWarning: true, phase: 'post-unlink-cleanup' })); cleanupChild.exitCode = 1; cleanupChild.emit('close', 1, null); await cleanupFailure;
    for (const supervised of [false, true]) {
      const child = makeChild(); let settled = false;
      const pending = runPublicationJson('helper', [], 10, supervised ? { launch: () => ({ child }) } : null, { spawnImpl: () => child, terminationTimeoutMs: 200 }).finally(() => { settled = true; });
      const rejected = assert.rejects(pending, error => error.code === 'FILE_PUBLICATION_TIMEOUT'); await delay(30); assert.strictEqual(settled, false, 'timeout must wait for the helper exit fence'); child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); await rejected;
    }
    const successfulTaskkillChild = makeChild(); successfulTaskkillChild.pid = 12345; let successfulTaskkillSettled = false;
    const successfulTaskkillTimeout = runPublicationJson('helper', [], 10, null, { spawnImpl: () => successfulTaskkillChild, terminationTimeoutMs: 200, terminationOptions: { platform: 'win32', execFileImpl: (_file, _args, _options, callback) => callback(null) } }).finally(() => { successfulTaskkillSettled = true; });
    const successfulTaskkillRejected = assert.rejects(successfulTaskkillTimeout, error => error.code === 'FILE_PUBLICATION_TIMEOUT'); await delay(20); successfulTaskkillChild.exitCode = 0; successfulTaskkillChild.emit('exit', 0, null); await delay(30); assert.strictEqual(successfulTaskkillSettled, false, 'raw Windows publication timeout must wait for close after successful taskkill'); successfulTaskkillChild.emit('close', 0, null); await successfulTaskkillRejected;
    const stuck = makeChild({ killReturns: false }); await assert.rejects(runPublicationJson('helper', [], 5, null, { spawnImpl: () => stuck, terminationTimeoutMs: 30 }), error => error.code === 'FILE_PUBLICATION_TIMEOUT' && error.outcomeUnknown === true && error.terminationError?.code === 'PROCESS_TERMINATION_FAILED');
    assert.strictEqual(publicationBatchTimeoutMs(1), 120000); assert.strictEqual(publicationBatchTimeoutMs(2048), 600000); assert.strictEqual(publicationBatchTimeoutMs(1000000), 600000, 'batch timeout is hard-capped at ten minutes');
    const hungSource = path.join(root, 'hung-batch-source'); const hungTarget = path.join(root, 'hung-batch-target'); fs.writeFileSync(hungSource, 'hung'); const hungIdentity = (await service.inspectPath(hungSource)).identity; let hungKilled = false; let lateWrite;
    const hungChild = makeChild(); hungChild.kill = () => { hungKilled = true; clearTimeout(lateWrite); setImmediate(() => { hungChild.exitCode = 1; hungChild.emit('exit', 1, null); hungChild.emit('close', 1, null); }); return true; };
    lateWrite = setTimeout(() => fs.writeFileSync(hungTarget, 'late helper write'), 80);
    const timedBatchService = createFilePublicationService({ app: { isPackaged: false }, projectRoot: path.resolve(__dirname, '..'), spawnImpl: () => hungChild, batchTimeoutMs: () => 10 });
    await assert.rejects(timedBatchService.moveNoReplaceBatch([{ source: hungSource, target: hungTarget, identity: hungIdentity }]), error => error.code === 'FILE_PUBLICATION_TIMEOUT' && error.operation === 'move-no-replace-batch');
    assert.strictEqual(hungKilled, true, 'batch timeout terminates the helper before returning'); await delay(100); assert.strictEqual(fs.existsSync(hungTarget), false, 'a timed-out batch helper cannot write after the exit fence');
    console.log('native file publication service tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
run().catch(error => { console.error(error); process.exitCode = 1; });
