const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectCopyPlan, copyPlannedFiles, CANCELLED_CODE } = require('../electron/services/file-transfer-service.cjs');
const { createFilePublicationService } = require('../electron/services/file-publication-service.cjs');

const identity = candidate => { const stat = fs.lstatSync(candidate); return `${stat.dev}:${stat.ino}`; };
const inspect = paths => paths.map((candidate, index) => { try { return { index, success: true, identity: identity(candidate), directory: fs.lstatSync(candidate).isDirectory() }; } catch (error) { return { index, success: false, code: error.code }; } });
const safeDelete = requests => requests.map((request, index) => { if (!fs.existsSync(request.path) || identity(request.path) !== request.identity) return { index, success: false, code: 'PUBLISH_OWNERSHIP_CONFLICT' }; fs.unlinkSync(request.path); return { index, success: true }; });
const makePlan = async (root, name, count) => { const source = path.join(root, `${name}-source`); const target = path.join(root, `${name}-target`); fs.mkdirSync(source); for (let index = 0; index < count; index += 1) fs.writeFileSync(path.join(source, `${index}.bin`), Buffer.from([index & 255])); const plan = []; await collectCopyPlan(source, target, plan); return { source, target, plan }; };

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-batch-orchestration-'));
  try {
    const crashed = await makePlan(root, 'crash', 3); const crashCreated = []; let moved = false;
    const crashNative = { inspectPathsBatch: async paths => inspect(paths), moveNoReplaceBatch: async requests => { for (const request of requests.slice(0, 2)) await fs.promises.rename(request.source, request.target); moved = true; throw Object.assign(new Error('helper exited without JSON'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' }); }, deletePathsBatch: async requests => safeDelete(requests) };
    await assert.rejects(copyPlannedFiles(crashed.plan, { nativePublicationService: crashNative, onCreated: candidate => crashCreated.push(candidate) }), error => error.code === 'FILE_PUBLICATION_PROTOCOL_ERROR');
    assert(moved); assert.strictEqual(crashCreated.filter(candidate => candidate.endsWith('.bin')).length, 2, 'crash reconciliation accounts every published side effect'); assert(fs.existsSync(path.join(crashed.target, '0.bin')) && fs.existsSync(path.join(crashed.target, '1.bin'))); assert(!fs.existsSync(path.join(crashed.target, '2.bin')));

    const replaced = await makePlan(root, 'replaced', 2); let replacementPath;
    const replacementNative = { inspectPathsBatch: async paths => inspect(paths), moveNoReplaceBatch: async requests => { replacementPath = requests[0].source; const retained = `${replacementPath}.owned`; fs.renameSync(replacementPath, retained); const bytes = fs.readFileSync(retained); fs.writeFileSync(replacementPath, bytes); throw Object.assign(new Error('mid-batch failure'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' }); }, deletePathsBatch: async requests => safeDelete(requests) };
    await assert.rejects(copyPlannedFiles(replaced.plan, { nativePublicationService: replacementNative }), error => error.recoveryRequired === true && error.recoveryPaths.includes(replacementPath));
    assert(fs.existsSync(replacementPath), 'same-byte replacement staging is never deleted after identity mismatch');

    for (const [label, failAt, count] of [['first-inspect', 1, 3], ['later-inspect', 2, 2049]]) {
      const sample = await makePlan(root, label, count); let calls = 0;
      const failingInspect = { inspectPathsBatch: async paths => { calls += 1; if (calls === failAt) throw Object.assign(new Error('inspection timeout'), { code: 'FILE_PUBLICATION_TIMEOUT' }); return inspect(paths); }, moveNoReplaceBatch: async () => { throw new Error('must not publish'); }, deletePathsBatch: async requests => safeDelete(requests) };
      await assert.rejects(copyPlannedFiles(sample.plan, { nativePublicationService: failingInspect }), error => error.code === 'FILE_PUBLICATION_TIMEOUT' && error.recoveryRequired === true && error.recoveryPaths.length === (failAt === 1 ? count : 1));
    }

    const concurrentSource = path.join(root, 'concurrent-small.bin'); const concurrentTarget = path.join(root, 'concurrent-small-target.bin'); fs.writeFileSync(concurrentSource, 'small'); const concurrentStat = fs.statSync(concurrentSource);
    const largeSource = path.join(root, 'concurrent-large.bin'); const largeTarget = path.join(root, 'concurrent-large-target.bin'); fs.writeFileSync(largeSource, 'large');
    let rejectLarge; const largeGate = new Promise((resolve, reject) => { rejectLarge = reject; });
    const concurrentNative = { inspectPathsBatch: async () => { rejectLarge(Object.assign(new Error('large pool failed first'), { code: 'LARGE_FIRST' })); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); throw Object.assign(new Error('small inspection failed second'), { code: 'FILE_PUBLICATION_TIMEOUT' }); }, moveNoReplaceBatch: async () => { throw new Error('must not publish'); }, deletePathsBatch: async requests => safeDelete(requests) };
    await assert.rejects(copyPlannedFiles([
      { kind: 'file', source: concurrentSource, destination: concurrentTarget, size: concurrentStat.size, mode: concurrentStat.mode, atime: concurrentStat.atime, mtime: concurrentStat.mtime },
      { kind: 'file', source: largeSource, destination: largeTarget, size: 3 * 1024 * 1024, mode: concurrentStat.mode, atime: concurrentStat.atime, mtime: concurrentStat.mtime },
    ], { nativePublicationService: concurrentNative, copyLargeFileAtomic: async () => largeGate }), error => {
      assert.strictEqual(error.code, 'LARGE_FIRST'); assert.strictEqual(error.message, 'large pool failed first'); assert.strictEqual(error.recoveryRequired, true); assert.strictEqual(error.recoveryPaths.length, 1); assert(fs.existsSync(error.recoveryPaths[0])); return true;
    });

    const cancelled = await makePlan(root, 'cancel', 2049); let cancel = false; let deleteCalls = 0;
    const cancelNative = { inspectPathsBatch: async paths => inspect(paths), moveNoReplaceBatch: async requests => { const results = []; for (let index = 0; index < requests.length; index += 1) { await fs.promises.rename(requests[index].source, requests[index].target); results.push({ index, identity: requests[index].identity, strategy: 'test-batch' }); } return results; }, deletePathsBatch: async requests => { deleteCalls += 1; return requests.map((request, index) => index === 0 ? { index, success: false, recoveryPath: request.path } : safeDelete([request])[0]); } };
    await assert.rejects(copyPlannedFiles(cancelled.plan, { nativePublicationService: cancelNative, isCancelled: () => cancel, onProgress: progress => { if (progress.fileCompleted) cancel = true; } }), error => error.code === CANCELLED_CODE && error.recoveryRequired === true && error.recoveryPaths.length === 1);
    assert.strictEqual(deleteCalls, 1, 'cancelled later chunks use identity-bound cleanup once');

    let manifestCalls = 0; let accounted = 0; let cumulativeJsonBytes = 0;
    const accountingService = createFilePublicationService({ app: { isPackaged: false }, projectRoot: root, platform: 'darwin', invokeOverride: async (operation, values) => { const rows = fs.readFileSync(values.manifest, 'utf8').trim().split(/\r?\n/).filter(Boolean); assert(rows.length <= 2048); manifestCalls += 1; const results = rows.map((line, index) => ({ index, success: true, identity: `1:${accounted + index}:${'x'.repeat(96)}`, strategy: 'accounting' })); if (operation === 'move-no-replace-batch') { accounted += rows.length; cumulativeJsonBytes += Buffer.byteLength(JSON.stringify({ success: true, results })); } else assert.strictEqual(operation, 'inspect-path-batch'); return { success: true, results }; } });
    const tenThousand = Array.from({ length: 10000 }, (_, index) => ({ source: path.join(root, `s-${index}`), target: path.join(root, `t-${index}`), identity: `1:${index}` }));
    const allResults = []; for (let offset = 0; offset < tenThousand.length; offset += 2048) { const chunk = tenThousand.slice(offset, offset + 2048); await accountingService.inspectPathsBatch(chunk.map(item => item.source)); allResults.push(...await accountingService.moveNoReplaceBatch(chunk)); }
    assert.strictEqual(allResults.length, 10000); assert.strictEqual(manifestCalls, Math.ceil(10000 / 2048) * 2); assert(manifestCalls <= 10); assert(cumulativeJsonBytes > 1024 * 1024, 'chunked accounting covers an aggregate response larger than the stdout cap without truncation');
    console.log('file publication batch orchestration tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
run().catch(error => { console.error(error); process.exitCode = 1; });
