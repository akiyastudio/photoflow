const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { MAX_ARCHIVE_BYTES, MAX_ENTRY_BYTES, MAX_PACKAGE_BYTES, captureComponentTreeIdentity, captureVerifiedComponentTreeIdentity, cleanupOwnedComponentPath: cleanupOwnedComponentPathImplementation, componentCleanupIntentPaths, componentSubtreeIdentity, componentTreeIdentityDigest, componentTreeIdentityReceipt, createComponentCleanupOrchestrator, extractComponentArchive, finalizeComponentCleanupProof: finalizeComponentCleanupProofRaw, inspectComponentArchive, persistComponentCleanupIntent, reserveComponentInstallCapacity, snapshotComponentArchive, validateComponentTreeIdentityReceipt } = require('../electron/component-package-archive.cjs');
const { createComponentRegistry, readComponentPackageManifest } = require('../electron/component-registry.cjs');
const { verifyComponentPackage } = require('./verify-component-packages.cjs');
const { writeZip } = require('./test-helpers/zip-fixture.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-archive-parity-'));
const manifest = JSON.stringify({ apiVersion: 1, id: 'archive-parity', version: '1.0.0', platforms: [process.platform], architectures: [process.arch], entrypoints: { default: 'worker.cjs' }, requiredFiles: ['worker.cjs'] });
const archive = path.join(root, `PhotoFlow-archive-parity-1.0.0-${process.platform}-${process.arch}.zip`);
const base = () => [['pkg/component.json', manifest], ['pkg/worker.cjs', 'module.exports = true;']];
const rejection = fn => { try { fn(); return false; } catch { return true; } };
const testDeleteOwned = async ({ receipt, isolatedPath }) => { const stat = fs.lstatSync(isolatedPath); assert.equal(stat.dev, receipt.nodeIdentity.dev); assert.equal(stat.ino, receipt.nodeIdentity.ino); if (receipt.kind === 'directory') await fs.promises.rm(isolatedPath, { recursive: true, force: false }); else await fs.promises.unlink(isolatedPath); };
const testCaptureNativeProof = async ({ receipt, proof }) => ({ rootIdentity: `${receipt.nodeIdentity.dev}:${receipt.nodeIdentity.ino}`, ...(proof.kind === 'directory' ? { entries: proof.entries.map(entry => ({ path: entry.path, identity: `${entry.node.dev}:${entry.node.ino}` })) } : {}) });
const testPrepareSidecars = async items => items.map(item => ({ path: item.path, role: item.role, size: item.expectedContent.length, sha256: crypto.createHash('sha256').update(item.expectedContent).digest('hex'), nativeIdentity: `native:${item.path}` }));
const cleanupOwnedComponentPathRaw = (receipt, options = {}) => cleanupOwnedComponentPathImplementation(receipt, { captureNativeProof: testCaptureNativeProof, prepareSidecars: testPrepareSidecars, persistPrepared: async () => true, ...options });
const cleanupOwnedComponentPath = async receipt => { const result = await cleanupOwnedComponentPathRaw(receipt, { captureNativeProof: testCaptureNativeProof, deleteOwned: testDeleteOwned, prepareSidecars: testPrepareSidecars, persistPrepared: async () => true }); if (result?.preparedReceipt) Object.assign(receipt, result.preparedReceipt); return result; };
const receiptForFile = filePath => { const stat = fs.lstatSync(filePath); return { path: filePath, kind: 'file', nodeIdentity: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }, size: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), mode: stat.mode & 0o777 }; };
const testDeleteSidecar = async ({ path: sidecarPath, size, sha256 }) => { const value = fs.readFileSync(sidecarPath); assert.equal(value.length, size); assert.equal(crypto.createHash('sha256').update(value).digest('hex'), sha256); await fs.promises.unlink(sidecarPath); };
const finalizeComponentCleanupProof = (receipt, options = {}) => finalizeComponentCleanupProofRaw(receipt, { ...options, deleteSidecar: testDeleteSidecar });

(async () => {
  try {
    const currentFourPackageBaseline = { maxArchiveBytes: 294_486_162, maxDeclaredExpandedBytes: 451_802_764, maxEntryBytes: 115_736_422 };
    assert(MAX_ARCHIVE_BYTES >= Math.ceil(currentFourPackageBaseline.maxArchiveBytes * 1.5), 'archive limit must preserve at least 50% headroom over the current four-package release set');
    assert(MAX_PACKAGE_BYTES >= currentFourPackageBaseline.maxDeclaredExpandedBytes * 2, 'expanded limit must preserve 2x headroom over the current release set');
    assert(MAX_ENTRY_BYTES >= currentFourPackageBaseline.maxEntryBytes * 2, 'entry limit must preserve 2x headroom over the current largest entry');
    assert.equal(validateComponentTreeIdentityReceipt(componentTreeIdentityReceipt([{ path: 'runtime', kind: 'directory', node: { dev: 1, ino: 2, birthtimeMs: 3 }, mode: 0o755 }])).schemaVersion, 1);
    assert.throws(() => validateComponentTreeIdentityReceipt({ schemaVersion: 0, entries: [] }), /版本/);
    writeZip(archive, base());
    const snapshot = path.join(root, 'snapshot.zip');
    const receipt = await snapshotComponentArchive(archive, snapshot);
    assert.equal(receipt.sha256, crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
    const inspected = inspectComponentArchive(snapshot, { inspectionToken: receipt.inspectionToken });
    assert.equal(inspected.manifest.id, 'archive-parity');
    assert.throws(() => inspectComponentArchive(archive, { inspectionToken: receipt.inspectionToken }), /令牌/);
    fs.copyFileSync(archive, `${snapshot}.replacement`); fs.renameSync(`${snapshot}.replacement`, snapshot);
    assert.throws(() => inspectComponentArchive(snapshot, { inspectionToken: receipt.inspectionToken }), /令牌/);
    assert.equal((await verifyComponentPackage(archive)).componentId, 'archive-parity');
    writeZip(archive, base().map(([name, value]) => [name, value, { dataDescriptor: true, descriptorSignature: name.endsWith('worker.cjs') }]));
    assert.equal(inspectComponentArchive(archive).manifest.id, 'archive-parity', 'signed and unsigned data descriptors are accepted when they match the central directory');
    writeZip(archive, [...base(), ['pkg/..foo', 'legal sibling name'], ['pkg/__proto__', 'prototype-safe'], ['pkg/constructor', 'constructor-safe']]);
    assert.equal(inspectComponentArchive(archive).entries.some(entry => entry.name === 'pkg/..foo'), true, 'a legal ..foo segment is not confused with parent traversal');
    assert.equal(inspectComponentArchive(archive).entries.some(entry => entry.name === 'pkg/__proto__'), true, 'prototype-like path names remain ordinary proof entries');

    const outputRaceInspection = inspectComponentArchive(archive);
    const outputRaceRoot = path.join(root, 'output-race');
    const originalOutputLstat = fs.promises.lstat;
    let outputReplaced = false;
    fs.promises.lstat = async target => {
      if (!outputReplaced && path.resolve(target) === path.join(outputRaceRoot, 'pkg', 'worker.cjs') && fs.existsSync(target)) {
        outputReplaced = true;
        fs.renameSync(target, `${target}.displaced`);
        fs.writeFileSync(target, 'replacement');
      }
      return originalOutputLstat(target);
    };
    try { await assert.rejects(extractComponentArchive(outputRaceInspection, outputRaceRoot), /输出路径.*替换/); }
    finally { fs.promises.lstat = originalOutputLstat; }

    writeZip(archive, base());
    const trustedExtractRoot = path.join(root, 'trusted-extract');
    const trustedExtract = await extractComponentArchive(inspectComponentArchive(archive), trustedExtractRoot);
    const trustedSubtree = componentSubtreeIdentity(trustedExtract.treeIdentity, trustedExtract.manifestEntry);
    const trustedComponentRoot = path.join(trustedExtractRoot, 'pkg');
    fs.writeFileSync(path.join(trustedComponentRoot, 'worker.cjs'), 'module.exports = null;');
    await assert.rejects(captureVerifiedComponentTreeIdentity(trustedComponentRoot, trustedSubtree, { includeNode: true }), /发生变化/);
    fs.writeFileSync(path.join(trustedComponentRoot, 'worker.cjs'), 'module.exports = true;');
    const copyRoot = path.join(root, 'copy-race'); fs.cpSync(trustedComponentRoot, copyRoot, { recursive: true });
    fs.writeFileSync(path.join(copyRoot, 'worker.cjs'), 'module.exports = null;');
    await assert.rejects(captureVerifiedComponentTreeIdentity(copyRoot, trustedSubtree), /发生变化/);

    const cases = [
      ['duplicate', [...base(), ['pkg/worker.cjs', 'again']]],
      ['case collision', [...base(), ['PKG/Worker.cjs', 'again']]],
      ['prefix collision', [['pkg', 'file'], ...base()]],
      ['local-central mismatch', [['pkg/component.json', manifest, { localName: 'other/component.json' }], ['pkg/worker.cjs', 'ok']]],
      ['CRC mismatch', [['pkg/component.json', manifest, { localCrc: 0, expectedCrc: 0 }], ['pkg/worker.cjs', 'ok']]],
      ['Windows ADS', [['pkg/component.json', manifest], ['pkg/worker.cjs:stream', 'bad']]],
      ['symlink mode', [['pkg/component.json', manifest], ['pkg/worker.cjs', 'target', { externalAttributes: (0xa000 << 16) >>> 0 }]]],
      ['bad descriptor', [['pkg/component.json', manifest, { dataDescriptor: true }], ['pkg/worker.cjs', 'ok', { dataDescriptor: true, descriptorCrc: 0 }]]],
      ['directory with CRC', [['pkg/component.json', manifest], ['pkg/', '', { localCrc: 1, expectedCrc: 1 }], ['pkg/worker.cjs', 'ok']]],
    ];
    for (const [label, entries] of cases) {
      writeZip(archive, entries);
      assert.equal(rejection(() => inspectComponentArchive(archive)), true, `${label}: installer inspection must reject`);
      assert.equal(rejection(() => readComponentPackageManifest(archive)), true, `${label}: registry must reject identically`);
      await assert.rejects(verifyComponentPackage(archive), undefined, `${label}: release verifier must reject identically`);
    }

    writeZip(archive, base());
    const racedSnapshot = path.join(root, 'raced-snapshot.zip');
    const displacedSnapshot = `${racedSnapshot}.displaced`;
    const originalLstat = fs.promises.lstat;
    let replacedDuringBinding = false;
    fs.promises.lstat = async target => {
      if (!replacedDuringBinding && path.resolve(target) === path.resolve(racedSnapshot) && fs.existsSync(racedSnapshot)) {
        replacedDuringBinding = true;
        fs.renameSync(racedSnapshot, displacedSnapshot);
        fs.copyFileSync(archive, racedSnapshot);
      }
      return originalLstat(target);
    };
    try { await assert.rejects(snapshotComponentArchive(archive, racedSnapshot), /替换|截断/); }
    finally { fs.promises.lstat = originalLstat; }
    assert.equal(fs.existsSync(racedSnapshot), true, 'snapshot cleanup must not unlink a replacement it does not own');
    fs.rmSync(racedSnapshot); fs.rmSync(displacedSnapshot);

    const rewrittenSnapshot = path.join(root, 'rewritten-after-sync.zip');
    const originalOpen = fs.promises.open;
    let rewrittenAfterSync = false;
    fs.promises.open = async (target, ...args) => {
      const opened = await originalOpen(target, ...args);
      if (path.resolve(target) === path.resolve(rewrittenSnapshot)) {
        const originalSync = opened.sync.bind(opened);
        opened.sync = async () => { await originalSync(); if (!rewrittenAfterSync) { rewrittenAfterSync = true; const bytes = fs.readFileSync(rewrittenSnapshot); bytes[0] ^= 0xff; fs.writeFileSync(rewrittenSnapshot, bytes); } };
      }
      return opened;
    };
    let rewrittenCleanupReceipt = null;
    try { await assert.rejects(snapshotComponentArchive(archive, rewrittenSnapshot), error => { rewrittenCleanupReceipt = error.cleanupPendingReceipts?.[0]; return /输出内容与源文件不一致/.test(error.message) && rewrittenCleanupReceipt?.path === rewrittenSnapshot; }); }
    finally { fs.promises.open = originalOpen; }
    assert.equal(fs.existsSync(rewrittenSnapshot), true, 'library layer retains a failed snapshot for identity-bound cleanup');
    await cleanupOwnedComponentPath(rewrittenCleanupReceipt); await finalizeComponentCleanupProof(rewrittenCleanupReceipt);

    const excessiveParents = path.join(root, 'excessive-implicit-parents.zip');
    writeZip(excessiveParents, [['component.json', manifest], ...Array.from({ length: 6_667 }, (_, index) => [`roots-${index}/a/b/file.bin`, ''])]);
    assert.throws(() => inspectComponentArchive(excessiveParents), /隐式目录数量|路径.*数量/);

    writeZip(archive, base());
    await assert.rejects(snapshotComponentArchive(archive, path.join(root, 'aborted.zip'), { signal: AbortSignal.abort() }), /取消/);
    await assert.rejects(snapshotComponentArchive(archive, path.join(root, 'timed-out.zip'), { deadlineAt: Date.now() - 1 }), /超时/);
    const originalCreateWriteStream = fs.createWriteStream;
    fs.createWriteStream = () => new Transform({ transform() { /* Intentionally never completes a chunk. */ } });
    try { await assert.rejects(snapshotComponentArchive(archive, path.join(root, 'stalled.zip'), { timeoutMs: 20 }), /abort|取消|超时/i); }
    finally { fs.createWriteStream = originalCreateWriteStream; }
    writeZip(archive, [['pkg/component.json', manifest], ['pkg/worker.cjs', 'corrupt payload', { localCrc: 0, expectedCrc: 0 }]]);
    assert.equal(inspectComponentArchive(archive).manifest.id, 'archive-parity');
    const registry = createComponentRegistry({ projectRoot: path.resolve(__dirname, '..'), userComponentRoot: root, isPackaged: true, platform: process.platform, arch: process.arch });
    assert.equal(registry.resolvePackage('archive-parity').packageInspectionStatus, 'manifest-bounded');
    await assert.rejects(verifyComponentPackage(archive), /CRC-32/);
    const failedInspection = inspectComponentArchive(archive);
    const originalRm = fs.promises.rm;
    let partialDeletionInjected = false;
    fs.promises.rm = async (target, options) => {
      if (!partialDeletionInjected && String(target).includes('.cleanup-')) {
        partialDeletionInjected = true;
        const victim = fs.readdirSync(target, { recursive: true }).map(relative => path.join(target, relative)).find(candidate => fs.lstatSync(candidate).isFile());
        await originalRm(victim, { force: true });
        throw Object.assign(new Error('injected partial cleanup denial'), { code: 'EACCES' });
      }
      return originalRm(target, options);
    };
    let retainedRecoveryPath = '';
    let retainedReceipt = null;
    try {
      await assert.rejects(extractComponentArchive(failedInspection, path.join(root, 'injected-cleanup-failure')), error => {
        retainedRecoveryPath = error.recoveryPath;
        retainedReceipt = error.cleanupPendingReceipts?.[0];
        return Array.isArray(error.cleanupPendingPaths) && error.cleanupPendingPaths.includes(error.recoveryPath) && componentCleanupIntentPaths(retainedReceipt).isolatedPath === error.recoveryPath && fs.existsSync(error.recoveryPath);
      });
    } finally { fs.promises.rm = originalRm; }
    assert.equal(fs.existsSync(componentCleanupIntentPaths(retainedReceipt).intentPath), true, 'deferred cleanup retains a durable intent before native proof is available');
    await cleanupOwnedComponentPath(retainedReceipt);
    assert.equal(fs.existsSync(retainedRecoveryPath), false, 'a retained quarantine converges when durable cleanup retries');
    assert.equal((await cleanupOwnedComponentPath(retainedReceipt)).alreadyMissing, true, 'receipt-bound ENOENT retry converges without reprocessing deleted nodes');
    await assert.rejects(cleanupOwnedComponentPath({ path: retainedRecoveryPath }), /缺少身份收据/);
    const compactLargeTreeReceipt = { path: retainedRecoveryPath, kind: 'directory', nodeIdentity: { dev: 1, ino: 2, birthtimeMs: 3 }, treeDigest: componentTreeIdentityDigest(Array.from({ length: 6_000 }, (_, index) => ({ path: `f-${index}`, kind: 'file', size: 1, sha256: 'a'.repeat(64), node: { dev: 1, ino: index, birthtimeMs: 1 }, mode: 0o600 }))) };
    assert(JSON.stringify(compactLargeTreeReceipt).length < 1_000, 'durable cleanup metadata remains O(1) for trees beyond 5,000 files');

    const receiptForDirectory = async directory => { const stat = fs.lstatSync(directory); return { path: directory, kind: 'directory', nodeIdentity: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }, treeDigest: componentTreeIdentityDigest(await captureComponentTreeIdentity(directory)) }; };
    const intentOnlyRoot = path.join(root, 'intent-only-crash'); fs.mkdirSync(intentOnlyRoot); fs.writeFileSync(path.join(intentOnlyRoot, 'a'), 'a');
    const intentOnlyReceipt = await receiptForDirectory(intentOnlyRoot); await persistComponentCleanupIntent(intentOnlyReceipt); await cleanupOwnedComponentPath(intentOnlyReceipt);
    assert.equal(fs.existsSync(intentOnlyRoot), false, 'metadata-flushed-before-rename crash converges');
    await finalizeComponentCleanupProof(intentOnlyReceipt);
    assert.equal(fs.readdirSync(root).filter(name => name.startsWith('intent-only-crash.cleanup-')).length, 0, 'durably completed cleanup reclaims normal sidecars');
    for (let index = 0; index < 5; index += 1) { const target = path.join(root, `bounded-sidecars-${index}`); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'a'), 'a'); const boundedReceipt = await receiptForDirectory(target); await cleanupOwnedComponentPath(boundedReceipt); await finalizeComponentCleanupProof(boundedReceipt); }
    assert.equal(fs.readdirSync(root).filter(name => name.includes('bounded-sidecars-') && name.includes('.cleanup-')).length, 0, 'repeated successful cleanup does not accumulate intent, marker, or tmp sidecars');
    const orchestratedRoot = path.join(root, 'orchestrated-cleanup'); fs.mkdirSync(orchestratedRoot); fs.writeFileSync(path.join(orchestratedRoot, 'a'), 'a'); const orchestratedReceipt = await receiptForDirectory(orchestratedRoot); const phases = []; const orchestrator = createComponentCleanupOrchestrator({ captureNativeProof: testCaptureNativeProof, prepareSidecars: testPrepareSidecars, persistPrepared: async () => true, deleteOwned: testDeleteOwned, deleteSidecar: testDeleteSidecar, persistPhase: async phase => { phases.push(phase); return true; } }); const orchestrated = await orchestrator.run(orchestratedReceipt); assert.equal(orchestrated.status, 'complete'); assert.deepEqual(phases, ['pending', 'data-complete']); assert.equal((await orchestrator.finalize(orchestrated.receipt)).status, 'pending'); assert.equal((await orchestrator.finalize(orchestrated.receipt, { completionFlushed: true })).status, 'complete');
    const rejectedPreparedRoot = path.join(root, 'rejected-prepared'); fs.mkdirSync(rejectedPreparedRoot); fs.writeFileSync(path.join(rejectedPreparedRoot, 'a'), 'a'); const rejectedPreparedReceipt = await receiptForDirectory(rejectedPreparedRoot); let rejectedDeleteCalls = 0; let rejectedPreparedCandidate; const rejectedOptions = { captureNativeProof: testCaptureNativeProof, prepareSidecars: testPrepareSidecars, persistPrepared: async () => false, deleteOwned: async () => { rejectedDeleteCalls += 1; } }; await assert.rejects(cleanupOwnedComponentPathImplementation(rejectedPreparedReceipt, rejectedOptions), error => { rejectedPreparedCandidate = error.cleanupPendingReceipts?.[0]; return error.preparedPersisted === false; }); await assert.rejects(cleanupOwnedComponentPathImplementation(rejectedPreparedCandidate, rejectedOptions), error => error.preparedPersisted === false); assert.equal(rejectedDeleteCalls, 0); assert(JSON.stringify(rejectedPreparedCandidate.sidecarReceipts).length < 16_000, 'prepared metadata stays compact and excludes proof contents');
    for (const sidecarKind of ['verifiedPath', 'proofPath', 'intentPath']) { const target = path.join(root, `sidecar-swap-${sidecarKind}`); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'a'), 'a'); const sidecarReceipt = await receiptForDirectory(target); await cleanupOwnedComponentPath(sidecarReceipt); const sidecarPaths = componentCleanupIntentPaths(sidecarReceipt); const swappedSidecar = sidecarPaths[sidecarKind]; const ownedSidecar = `${swappedSidecar}.owned`; await assert.rejects(finalizeComponentCleanupProofRaw(sidecarReceipt, { dataCleanupCompletePersisted: true, deleteSidecar: async request => { if (request.path !== swappedSidecar) return testDeleteSidecar(request); const identicalBytes = fs.readFileSync(request.path); fs.renameSync(request.path, ownedSidecar); fs.writeFileSync(request.path, identicalBytes); throw Object.assign(new Error('native sidecar compare-delete rejected replacement'), { code: 'COMPONENT_CLEANUP_REPLACEMENT_CONFLICT' }); } }), error => error.code === 'COMPONENT_CLEANUP_REPLACEMENT_CONFLICT'); assert.equal(fs.existsSync(swappedSidecar), true); assert.equal(fs.existsSync(ownedSidecar), true); }

    const renamedCrashRoot = path.join(root, 'renamed-before-delete-crash'); fs.mkdirSync(renamedCrashRoot); fs.writeFileSync(path.join(renamedCrashRoot, 'a'), 'a');
    const renamedCrashReceipt = await receiptForDirectory(renamedCrashRoot); await persistComponentCleanupIntent(renamedCrashReceipt); const renamedCrashPaths = componentCleanupIntentPaths(renamedCrashReceipt); fs.renameSync(renamedCrashRoot, renamedCrashPaths.isolatedPath); await cleanupOwnedComponentPath(renamedCrashReceipt);
    assert.equal(fs.existsSync(renamedCrashPaths.isolatedPath), false, 'rename-before-delete crash converges from deterministic isolation path');

    const emptyMarkerRoot = path.join(root, 'empty-marker-crash'); fs.mkdirSync(emptyMarkerRoot); fs.writeFileSync(path.join(emptyMarkerRoot, 'a'), 'a'); const emptyMarkerReceipt = await receiptForDirectory(emptyMarkerRoot); await persistComponentCleanupIntent(emptyMarkerReceipt); const emptyMarkerPaths = componentCleanupIntentPaths(emptyMarkerReceipt); fs.renameSync(emptyMarkerRoot, emptyMarkerPaths.isolatedPath); fs.writeFileSync(emptyMarkerPaths.verifiedPath, ''); await cleanupOwnedComponentPath(emptyMarkerReceipt);
    assert.equal(fs.existsSync(emptyMarkerPaths.isolatedPath), false, 'crash after marker create but before write is safely rebuilt from the intact receipt');

    const halfMarkerRoot = path.join(root, 'half-marker-crash'); fs.mkdirSync(halfMarkerRoot); fs.writeFileSync(path.join(halfMarkerRoot, 'a'), 'a'); const halfMarkerReceipt = await receiptForDirectory(halfMarkerRoot); await persistComponentCleanupIntent(halfMarkerReceipt); const halfMarkerPaths = componentCleanupIntentPaths(halfMarkerReceipt); fs.renameSync(halfMarkerRoot, halfMarkerPaths.isolatedPath); fs.writeFileSync(`${halfMarkerPaths.verifiedPath}.tmp`, 'half'); await cleanupOwnedComponentPath(halfMarkerReceipt);
    assert.equal(fs.existsSync(halfMarkerPaths.isolatedPath), false, 'crash after partial marker tmp write is safely rebuilt from the intact receipt');
    for (let crashIndex = 0; crashIndex < 2; crashIndex += 1) { const diagnosticRoot = path.join(root, `diagnostic-retry-${crashIndex}`); fs.mkdirSync(diagnosticRoot); fs.writeFileSync(path.join(diagnosticRoot, 'a'), 'a'); const diagnosticReceipt = await receiptForDirectory(diagnosticRoot); await persistComponentCleanupIntent(diagnosticReceipt); const diagnosticPaths = componentCleanupIntentPaths(diagnosticReceipt); fs.renameSync(diagnosticRoot, diagnosticPaths.isolatedPath); fs.writeFileSync(diagnosticPaths.verifiedPath, 'bad'); fs.writeFileSync(`${diagnosticPaths.verifiedPath}.tmp`, 'half'); await cleanupOwnedComponentPath(diagnosticReceipt); const diagnostics = diagnosticReceipt.sidecarReceipts.filter(item => item.role === 'diagnostic'); assert.equal(diagnostics.length, 2); let diagnosticDeleteIndex = 0; await assert.rejects(finalizeComponentCleanupProofRaw(diagnosticReceipt, { dataCleanupCompletePersisted: true, deleteSidecar: async sidecar => { await testDeleteSidecar(sidecar); if (sidecar.role === 'diagnostic' && diagnosticDeleteIndex++ === crashIndex) throw new Error('crash after diagnostic deletion'); } }), /crash after diagnostic deletion/); await finalizeComponentCleanupProof(diagnosticReceipt, { dataCleanupCompletePersisted: true }); }

    const partialCrashRoot = path.join(root, 'partial-delete-crash'); fs.mkdirSync(partialCrashRoot); fs.writeFileSync(path.join(partialCrashRoot, 'a'), 'a'); fs.writeFileSync(path.join(partialCrashRoot, 'b'), 'b');
    const partialCrashReceipt = await receiptForDirectory(partialCrashRoot); const originalCleanupRm = fs.promises.rm; let partialCrashInjected = false;
    fs.promises.rm = async (target, options) => { if (!partialCrashInjected && String(target).includes('.cleanup-')) { partialCrashInjected = true; await originalCleanupRm(path.join(target, 'a')); throw Object.assign(new Error('crash after partial delete'), { code: 'EACCES' }); } return originalCleanupRm(target, options); };
    try { await assert.rejects(cleanupOwnedComponentPath(partialCrashReceipt), /partial delete/); } finally { fs.promises.rm = originalCleanupRm; }
    await cleanupOwnedComponentPath(partialCrashReceipt); assert.equal(fs.existsSync(componentCleanupIntentPaths(partialCrashReceipt).isolatedPath), false, 'partial-delete crash resumes without revisiting deleted nodes');

    const missingProofRoot = path.join(root, 'missing-proof-after-partial'); fs.mkdirSync(missingProofRoot); fs.writeFileSync(path.join(missingProofRoot, 'a'), 'a'); fs.writeFileSync(path.join(missingProofRoot, 'b'), 'b'); const missingProofReceipt = await receiptForDirectory(missingProofRoot);
    await assert.rejects(cleanupOwnedComponentPathRaw(missingProofReceipt, { captureNativeProof: testCaptureNativeProof, deleteOwned: async ({ isolatedPath }) => { await fs.promises.unlink(path.join(isolatedPath, 'a')); throw new Error('partial before proof loss'); } }), /partial before proof loss/);
    const missingProofPaths = componentCleanupIntentPaths(missingProofReceipt); fs.rmSync(missingProofPaths.proofPath);
    await assert.rejects(cleanupOwnedComponentPath(missingProofReceipt), /完整证明与原始目录收据不一致/);

    const unknownAfterPartialRoot = path.join(root, 'unknown-after-partial'); fs.mkdirSync(unknownAfterPartialRoot); fs.writeFileSync(path.join(unknownAfterPartialRoot, 'a'), 'a'); fs.writeFileSync(path.join(unknownAfterPartialRoot, 'b'), 'b'); const unknownAfterPartialReceipt = await receiptForDirectory(unknownAfterPartialRoot);
    await assert.rejects(cleanupOwnedComponentPathRaw(unknownAfterPartialReceipt, { captureNativeProof: testCaptureNativeProof, deleteOwned: async ({ isolatedPath }) => { await fs.promises.unlink(path.join(isolatedPath, 'a')); throw new Error('partial stop'); } }), /partial stop/);
    const unknownAfterPartialPaths = componentCleanupIntentPaths(unknownAfterPartialReceipt); fs.writeFileSync(path.join(unknownAfterPartialPaths.isolatedPath, 'unknown'), 'injected');
    await assert.rejects(cleanupOwnedComponentPath(unknownAfterPartialReceipt), /新增或变化节点/); assert.equal(fs.existsSync(path.join(unknownAfterPartialPaths.isolatedPath, 'unknown')), true);

    const swappedFile = path.join(root, 'cleanup-swap.txt'); fs.writeFileSync(swappedFile, 'owned'); const swappedReceipt = receiptForFile(swappedFile); const ownedElsewhere = `${swappedFile}.owned`;
    const originalRename = fs.promises.rename; let cleanupSwapInjected = false;
    fs.promises.rename = async (sourcePath, destinationPath) => { if (!cleanupSwapInjected && path.resolve(sourcePath) === path.resolve(swappedFile)) { cleanupSwapInjected = true; await originalRename(sourcePath, ownedElsewhere); fs.writeFileSync(swappedFile, 'replacement'); } return originalRename(sourcePath, destinationPath); };
    try { await assert.rejects(cleanupOwnedComponentPath(swappedReceipt), error => error.code === 'COMPONENT_CLEANUP_REPLACEMENT_CONFLICT' || error.code === 'COMPONENT_CLEANUP_PROOF_MISMATCH'); } finally { fs.promises.rename = originalRename; }
    assert.equal(fs.readFileSync(swappedFile, 'utf8'), 'replacement'); assert.equal(fs.readFileSync(ownedElsewhere, 'utf8'), 'owned', 'path swap preserves both replacement and originally owned node');

    const swappedDirectory = path.join(root, 'cleanup-swap-directory'); fs.mkdirSync(swappedDirectory); fs.writeFileSync(path.join(swappedDirectory, 'owned'), 'owned'); const swappedDirectoryReceipt = await receiptForDirectory(swappedDirectory); const ownedDirectoryElsewhere = `${swappedDirectory}.owned`;
    cleanupSwapInjected = false;
    fs.promises.rename = async (sourcePath, destinationPath) => { if (!cleanupSwapInjected && path.resolve(sourcePath) === path.resolve(swappedDirectory)) { cleanupSwapInjected = true; await originalRename(sourcePath, ownedDirectoryElsewhere); fs.mkdirSync(swappedDirectory); fs.writeFileSync(path.join(swappedDirectory, 'replacement'), 'replacement'); } return originalRename(sourcePath, destinationPath); };
    try { await assert.rejects(cleanupOwnedComponentPath(swappedDirectoryReceipt), error => error.code === 'COMPONENT_CLEANUP_REPLACEMENT_CONFLICT' || error.code === 'COMPONENT_CLEANUP_PROOF_MISMATCH'); } finally { fs.promises.rename = originalRename; }
    assert.equal(fs.readFileSync(path.join(swappedDirectory, 'replacement'), 'utf8'), 'replacement'); assert.equal(fs.readFileSync(path.join(ownedDirectoryElsewhere, 'owned'), 'utf8'), 'owned', 'directory path swap preserves replacement and owned tree');

    const finalSwapFile = path.join(root, 'final-delete-swap.txt'); fs.writeFileSync(finalSwapFile, 'owned'); const finalSwapReceipt = receiptForFile(finalSwapFile); const finalSwapOwned = `${finalSwapFile}.owned-final`;
    await assert.rejects(cleanupOwnedComponentPathRaw(finalSwapReceipt, { captureNativeProof: testCaptureNativeProof, deleteOwned: async ({ isolatedPath, proof }) => { assert.equal(proof.native.rootIdentity, `${finalSwapReceipt.nodeIdentity.dev}:${finalSwapReceipt.nodeIdentity.ino}`); await originalRename(isolatedPath, finalSwapOwned); fs.writeFileSync(isolatedPath, 'replacement'); throw new Error('bound delete rejected swapped final path'); } }), error => ['COMPONENT_CLEANUP_PROOF_MISMATCH', 'COMPONENT_CLEANUP_REPLACEMENT_CONFLICT'].includes(error.code));
    assert.equal(fs.readFileSync(componentCleanupIntentPaths(finalSwapReceipt).isolatedPath, 'utf8'), 'replacement'); assert.equal(fs.readFileSync(finalSwapOwned, 'utf8'), 'owned');

    const finalSwapDirectory = path.join(root, 'final-delete-swap-directory'); fs.mkdirSync(finalSwapDirectory); fs.writeFileSync(path.join(finalSwapDirectory, 'owned'), 'owned'); const finalSwapDirectoryReceipt = await receiptForDirectory(finalSwapDirectory); const finalSwapDirectoryOwned = `${finalSwapDirectory}.owned-final`;
    await assert.rejects(cleanupOwnedComponentPathRaw(finalSwapDirectoryReceipt, { captureNativeProof: testCaptureNativeProof, deleteOwned: async ({ isolatedPath, proof }) => { assert.equal(proof.native.rootIdentity, `${finalSwapDirectoryReceipt.nodeIdentity.dev}:${finalSwapDirectoryReceipt.nodeIdentity.ino}`); await originalRename(isolatedPath, finalSwapDirectoryOwned); fs.mkdirSync(isolatedPath); fs.writeFileSync(path.join(isolatedPath, 'replacement'), 'replacement'); throw new Error('bound recursive delete rejected swapped final path'); } }), error => ['COMPONENT_CLEANUP_PROOF_MISMATCH', 'COMPONENT_CLEANUP_REPLACEMENT_CONFLICT'].includes(error.code));
    assert.equal(fs.readFileSync(path.join(componentCleanupIntentPaths(finalSwapDirectoryReceipt).isolatedPath, 'replacement'), 'utf8'), 'replacement'); assert.equal(fs.readFileSync(path.join(finalSwapDirectoryOwned, 'owned'), 'utf8'), 'owned');

    const oversizedSidecarRoot = path.join(root, 'oversized-sidecar'); fs.mkdirSync(oversizedSidecarRoot); fs.writeFileSync(path.join(oversizedSidecarRoot, 'owned'), 'owned'); const oversizedSidecarReceipt = await receiptForDirectory(oversizedSidecarRoot); const oversizedPaths = componentCleanupIntentPaths(oversizedSidecarReceipt); fs.writeFileSync(oversizedPaths.intentPath, Buffer.alloc(20 * 1024));
    await assert.rejects(cleanupOwnedComponentPath(oversizedSidecarReceipt), /大小无效/); assert.equal(fs.existsSync(oversizedSidecarRoot), true);
    for (let index = 0; index < 4; index += 1) fs.writeFileSync(oversizedPaths.intentPath, Buffer.alloc(20 * 1024, index));
    assert.equal(fs.readdirSync(root).filter(name => name.startsWith('oversized-sidecar.cleanup-')).length, 1, 'repeated oversized/corrupt intent cannot create unbounded sidecars');
    fs.rmSync(oversizedPaths.intentPath); await persistComponentCleanupIntent(oversizedSidecarReceipt); fs.renameSync(oversizedSidecarRoot, oversizedPaths.isolatedPath); fs.writeFileSync(oversizedPaths.verifiedPath, Buffer.alloc(20 * 1024));
    await assert.rejects(cleanupOwnedComponentPath(oversizedSidecarReceipt), /大小无效/); assert.equal(fs.existsSync(oversizedPaths.isolatedPath), true, 'oversized marker never authorizes deletion');

    const replacedProofRoot = path.join(root, 'replaced-proof'); fs.mkdirSync(replacedProofRoot); fs.writeFileSync(path.join(replacedProofRoot, 'a'), 'a'); const replacedProofReceipt = await receiptForDirectory(replacedProofRoot);
    await assert.rejects(cleanupOwnedComponentPathRaw(replacedProofReceipt, { captureNativeProof: testCaptureNativeProof, deleteOwned: async () => { throw new Error('stop after marker'); } }), /stop after marker/); const replacedProofPaths = componentCleanupIntentPaths(replacedProofReceipt); fs.writeFileSync(replacedProofPaths.proofPath, JSON.stringify({ schemaVersion: 1, kind: 'directory', entries: [] }));
    await assert.rejects(cleanupOwnedComponentPath(replacedProofReceipt), /未绑定原始收据|完整证明/);
    const systemIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
    const archiveSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'component-package-archive.cjs'), 'utf8');
    assert.doesNotMatch(archiveSource, /snapshotComponentArchive[\s\S]*catch \(error\)[\s\S]{0,1800}unlink\(targetPath\)/, 'snapshot failure never performs a path-based final unlink');
    assert.doesNotMatch(systemIpcSource, /components-delete-package[\s\S]{0,2000}unlink\(archivePath\)/, 'component package deletion is native identity-bound');
    assert.match(systemIpcSource, /error\?\.cleanupPendingReceipts[\s\S]*pendingCleanup[\s\S]*queueSystemFilesystemCleanup\(pendingCleanup/);
    assert.match(systemIpcSource, /filter\(candidate => candidate && typeof candidate === 'object'[\s\S]*candidate\.nodeIdentity/);
    assert.doesNotMatch(systemIpcSource, /typeof candidate === 'string' \? \{ path:/, 'automatic cleanup has no raw-path fallback');
    assert.doesNotMatch(systemIpcSource, /setTimeout\(\(\) => void run\(/, 'cleanup admission is never delayed behind an unpersisted timer');
    assert.match(systemIpcSource, /assertInstallActive\(\);[\s\S]*fs\.promises\.cp[\s\S]*captureVerifiedComponentTreeIdentity[\s\S]*assertInstallActive\(\)/, 'deadline checks bracket copy and receipt verification');
    assert.match(systemIpcSource, /dataCleanupComplete[\s\S]*backgroundTasks\?\.flush[\s\S]*finalizeComponentCleanupProof[\s\S]*state === 'completed'[\s\S]*backgroundTasks\.flush/);
    assert.match(systemIpcSource, /inspectPathsBatch[\s\S]*compareDeleteFilesBatch[\s\S]*deleteDirectoriesBatch/, 'large-tree native cleanup uses bounded batches rather than one helper per node');
    assert.match(systemIpcSource, /retryFactory = failedTask =>[\s\S]*admit\(failedTask\)/, 'manual retry passes the latest failed task into durable admission');
    assert.match(systemIpcSource, /dataCleanupComplete = sourceTask\?\.metadata\?\.dataCleanupComplete/, 'cleanup execution derives phase from the supplied task snapshot');

    const originalStatfs = fs.promises.statfs;
    fs.promises.statfs = async () => ({ bavail: 1_000n, bsize: 1n });
    try {
      const competing = await Promise.allSettled([reserveComponentInstallCapacity(root, 600), reserveComponentInstallCapacity(root, 600)]);
      assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1, 'same-volume reservations are serialized atomically');
      assert.match(competing.find(result => result.status === 'rejected').reason.message, /容量已被其他安装预留/);
      await competing.find(result => result.status === 'fulfilled').value.release();
    } finally { fs.promises.statfs = originalStatfs; }
    const logicalPayload = Buffer.alloc(100 * 1024 * 1024, 0x61);
    const benchmarkArchives = Array.from({ length: 3 }, (_, index) => path.join(root, `benchmark-${index}.zip`));
    for (const target of benchmarkArchives) writeZip(target, [['pkg/component.json', manifest], ['pkg/model.bin', logicalPayload, { method: 8 }], ['pkg/worker.cjs', 'ok']]);
    const benchmarkStart = performance.now();
    for (const target of benchmarkArchives) assert.equal(inspectComponentArchive(target).totalUncompressedBytes > 100 * 1024 * 1024, true);
    const benchmarkMs = performance.now() - benchmarkStart;
    assert(benchmarkMs < 5_000, `bounded inspection of three ~100 MiB logical packages regressed: ${Math.round(benchmarkMs)} ms`);
    console.log('Component archive parser parity tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
