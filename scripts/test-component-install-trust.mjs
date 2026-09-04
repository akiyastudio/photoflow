import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { awaitDurableCleanupRestart, confirmComponentBackgroundStop, confirmComponentPackageInstall, createComponentInstallAdmission, createDurableCleanupAdmission, enterComponentInstallTransition, prepareSafeComponentInstallContainer, rollbackComponentPublication, snapshotComponentTrust, validateComponentInstallRequest } = require('../electron/modules/system-ipc.cjs');
const { captureComponentTreeIdentity, extractComponentArchive, inspectComponentArchive, snapshotComponentArchive, verifyComponentTreeIdentity } = require('../electron/component-package-archive.cjs');

const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
const writeZip = (target, entries) => {
  const local = []; const central = []; let offset = 0;
  for (const [name, raw, options = {}] of entries) {
    const localName = Buffer.from(options.localName || name); const centralName = Buffer.from(name); const data = Buffer.from(raw);
    const method = options.method === 8 ? 8 : 0; const localMethod = options.localMethod ?? method;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data; const checksum = crc32(data);
    const declaredSize = options.declaredSize ?? data.length; const declaredCompressedSize = options.declaredCompressedSize ?? compressed.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(localMethod, 8); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(declaredCompressedSize, 18); header.writeUInt32LE(declaredSize, 22); header.writeUInt16LE(localName.length, 26);
    local.push(header, localName, compressed);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(method, 10); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(declaredCompressedSize, 20); record.writeUInt32LE(declaredSize, 24); record.writeUInt16LE(centralName.length, 28); record.writeUInt32LE(options.externalAttributes ?? 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, centralName); offset += header.length + localName.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(target, Buffer.concat([...local, directory, end]));
};

assert.deepEqual(validateComponentInstallRequest({ componentId: 'third-party.tool' }), { componentId: 'third-party.tool' });
assert.throws(() => validateComponentInstallRequest('third-party.tool'), /普通对象/);
assert.throws(() => validateComponentInstallRequest({ componentId: 'ThirdParty.Tool' }), /组件 ID 无效/);
assert.throws(() => validateComponentInstallRequest({ componentId: 'third-party.tool', ignoreSecurity: true }), /字段无效/);

const acquireInstall = createComponentInstallAdmission();
let cleanupWorkerCalls = 0;
const rejectedAdmission = createDurableCleanupAdmission({ start: worker => Promise.resolve().then(() => worker({})), flush: () => false, worker: async () => { cleanupWorkerCalls += 1; }, receipts: [{ path: 'pending' }] });
assert.equal(rejectedAdmission.admitted, false); await assert.rejects(rejectedAdmission.completion, /尚未完成持久 admission/); assert.equal(cleanupWorkerCalls, 0, 'flush failure never starts destructive cleanup');
const acceptedAdmission = createDurableCleanupAdmission({ start: worker => Promise.resolve().then(() => worker({})), flush: () => true, worker: async () => { cleanupWorkerCalls += 1; return true; }, receipts: [] });
assert.equal(acceptedAdmission.admitted, true); await acceptedAdmission.completion; assert.equal(cleanupWorkerCalls, 1);
let settleRestart; const restartWork = new Promise(resolve => { settleRestart = resolve; }); let restartSettled = false; const restarted = awaitDurableCleanupRestart(Promise.resolve({ admitted: true, completion: restartWork })).then(() => { restartSettled = true; }); await Promise.resolve(); assert.equal(restartSettled, false, 'restart factory remains pending until replacement cleanup completes'); settleRestart({ task: { state: 'completed' } }); await restarted; assert.equal(restartSettled, true);
await assert.rejects(awaitDurableCleanupRestart(Promise.resolve({ admitted: true, completion: Promise.reject(new Error('replacement cleanup failed')) })), /replacement cleanup failed/);
const releaseFirstInstall = acquireInstall('third-party.tool');
assert.throws(() => acquireInstall('third-party.tool'), /正在安装/);
const releaseOtherInstall = acquireInstall('other.tool');
releaseFirstInstall(); releaseOtherInstall();
assert.equal(typeof acquireInstall('third-party.tool'), 'function', 'the per-component admission is released after settle');

const transitionEvents = [];
const transitionBarrier = { drain: async () => transitionEvents.push('drain'), release: () => transitionEvents.push('release') };
const enteredBarrier = await enterComponentInstallTransition({
  componentId: 'third-party.tool',
  componentCapabilityBroker: { blockComponent: () => (transitionEvents.push('block'), transitionBarrier) },
  componentViewManager: { closeComponent: () => transitionEvents.push('close-view') },
  processSupervisor: { stopWhere: async () => transitionEvents.push('stop-tree') },
  componentServiceManager: { stop: async () => transitionEvents.push('stop-service') },
  abortComponentNetworkRequests: () => transitionEvents.push('abort-network'),
});
assert.equal(enteredBarrier, transitionBarrier);
assert.deepEqual(transitionEvents, ['block', 'stop-tree', 'stop-service', 'close-view', 'abort-network', 'drain']);
enteredBarrier.release();
let failedBarrierReleased = false;
await assert.rejects(enterComponentInstallTransition({
  componentId: 'third-party.tool',
  componentCapabilityBroker: { blockComponent: () => ({ drain: async () => {}, release: () => { failedBarrierReleased = true; } }) },
  componentViewManager: { closeComponent: () => {} },
  processSupervisor: { stopWhere: async () => { throw new Error('old process still running'); } },
  componentServiceManager: { stop: async () => {} },
  abortComponentNetworkRequests: () => {},
}), /old process still running/);
assert.equal(failedBarrierReleased, true, 'a failed quiesce releases the capability barrier and aborts before installation');

let dialogCalls = 0;
const dialog = {
  showMessageBox: async (_window, options) => {
    dialogCalls += 1;
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    assert.deepEqual(options.buttons, ['取消安装', '我信任来源，继续安装']);
    assert.match(options.detail, /读取或修改.*文件/);
    assert.match(options.detail, /连接网络/);
    assert.match(options.detail, /启动其他进程/);
    assert.match(options.detail, /只适用于本次安装/);
    return { response: 0 };
  },
};
const confirmation = integrityStatus => confirmComponentPackageInstall({ componentId: 'third-party.tool', componentVersion: '1.0.0', integrityStatus, dialog, mainWindow: {} });

assert.equal(await confirmation('verified'), true);
assert.equal(await confirmation('pinned-unverified'), true);
assert.equal(dialogCalls, 0, 'app-verified and app-pinned packages do not show the unsigned warning');
assert.equal(await confirmation('unsigned'), false, 'cancel rejects the unsigned package');
assert.equal(dialogCalls, 1);
dialog.showMessageBox = async () => ({ response: 1 });
assert.equal(await confirmation('unsigned'), true, 'the explicit dangerous action authorizes this invocation');
await assert.rejects(confirmation('invalid'), /完整性状态无效/);

let backgroundPrompts = 0;
const promptDialog = { showMessageBox: async (_window, options) => {
  backgroundPrompts += 1;
  assert.equal(options.defaultId, 1);
  assert.equal(options.cancelId, 1);
  assert.deepEqual(options.buttons, ['关闭后台进程并继续禁用', '取消']);
  return { response: 1 };
} };
const inactiveSupervisor = { hasWhere: () => false, hasUnconfirmedOwner: () => false };
assert.equal(await confirmComponentBackgroundStop({ componentId: 'third-party.tool', action: 'install', processSupervisor: inactiveSupervisor, lifecycleCoordinator: { hasWork: () => true }, dialog: promptDialog, mainWindow: {} }), true);
assert.equal(backgroundPrompts, 0, 'ordinary lifecycle work without a child process means no prompt');
const activeSupervisor = { hasWhere: () => true };
assert.equal(await confirmComponentBackgroundStop({ componentId: 'third-party.tool', action: 'disable', processSupervisor: activeSupervisor, dialog: promptDialog, mainWindow: {} }), false);
assert.equal(backgroundPrompts, 1);
promptDialog.showMessageBox = async (_window, options) => {
  assert.deepEqual(options.buttons, ['关闭后台进程并继续安装或更新', '取消']);
  return { response: 0 };
};
assert.equal(await confirmComponentBackgroundStop({ componentId: 'third-party.tool', action: 'install', processSupervisor: activeSupervisor, dialog: promptDialog, mainWindow: {} }), true);
promptDialog.showMessageBox = async (_window, options) => {
  assert.deepEqual(options.buttons, ['关闭后台进程并继续退出', '取消']);
  return { response: 0 };
};
assert.equal(await confirmComponentBackgroundStop({ componentId: 'third-party.tool', componentName: 'Fixture', action: 'uninstall', processSupervisor: activeSupervisor, dialog: promptDialog, mainWindow: {} }), true);
assert.equal(await confirmComponentBackgroundStop({ componentId: 'third-party.tool', componentName: 'Fixture', action: 'uninstall', processSupervisor: { hasWhere: () => false, hasUnconfirmedOwner: () => true }, dialog: promptDialog, mainWindow: {} }), true);
const preloadSource = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../electron/modules/system-ipc.cjs', import.meta.url), 'utf8');
assert.match(preloadSource, /installComponent: request => ipcRenderer\.invoke\('components-install', request\)/);
assert.match(mainSource, /snapshotComponentArchive\(archivePath, packageSnapshotPath,[\s\S]*inspectComponentArchive\(packageSnapshotPath,[\s\S]*confirmComponentPackageInstall[\s\S]*if \(!confirmed\)[\s\S]*extractComponentArchive\(snapshotPackage, packageStagePath,/);
assert.match(mainSource, /confirmComponentPackageInstall[\s\S]*confirmComponentBackgroundStop[\s\S]*enterComponentInstallTransition[\s\S]*extractComponentArchive[\s\S]*captureComponentTreeIdentity/);
assert.match(mainSource, /fs\.promises\.cp[\s\S]*captureVerifiedComponentTreeIdentity\(stagingPath[\s\S]*componentTransactions\.install/);
assert.match(mainSource, /if \(!confirmed\) return installResponse = \{ success: false, cancelled: true \}/);
assert.match(mainSource, /packageSnapshotPath && packageSnapshotReceipt[\s\S]*queueSystemFilesystemCleanup\(deferredCleanup/);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'component-install-trust-'));
try {
  const archive = path.join(temporaryRoot, 'component.zip');
  const manifest = marker => JSON.stringify({ apiVersion: 1, id: 'third-party.tool', version: '1.0.0', marker, entrypoints: { default: 'worker.cjs' }, requiredFiles: ['worker.cjs'] });
  writeZip(archive, [['old/component.json', manifest('old')], ['old/worker.cjs', 'old']]);
  inspectComponentArchive(archive);
  // Replace the same-ID source before the snapshot. Only snapshot metadata/content may drive installation.
  writeZip(archive, [['new/component.json', manifest('new')], ['new/worker.cjs', 'new']]);
  const snapshot = path.join(temporaryRoot, 'snapshot.zip'); await snapshotComponentArchive(archive, snapshot);
  const inspected = inspectComponentArchive(snapshot);
  assert.equal(inspected.manifestEntry, 'new/component.json');
  assert.equal(inspected.manifest.marker, 'new');
  const cancelledExpansion = path.join(temporaryRoot, 'cancelled-expansion');
  const snapshotTrust = snapshotComponentTrust('third-party.tool', inspected.manifest);
  assert.equal(await confirmComponentPackageInstall({ ...snapshotTrust, dialog: { showMessageBox: async () => ({ response: 0 }) }, mainWindow: {} }), false);
  assert.equal(fs.existsSync(cancelledExpansion), false, 'cancelling an unsigned snapshot does not create or write an expansion directory');
  const extracted = path.join(temporaryRoot, 'extracted');
  const extractedPackage = await extractComponentArchive(inspected, extracted);
  assert.equal(extractedPackage.manifest.marker, 'new');

  const oversized = path.join(temporaryRoot, 'oversized.zip');
  const oversizedHandle = fs.openSync(oversized, 'w'); fs.ftruncateSync(oversizedHandle, 2048); fs.closeSync(oversizedHandle);
  const rejectedSnapshot = path.join(temporaryRoot, 'rejected-snapshot.zip');
  await assert.rejects(snapshotComponentArchive(oversized, rejectedSnapshot, { maxArchiveBytes: 1024 }), /本体大小超过安全上限/);
  assert.equal(fs.existsSync(rejectedSnapshot), false, 'an oversized source is rejected before a snapshot is created');

  const componentRoot = path.join(extracted, 'new');
  const identity = await captureComponentTreeIdentity(componentRoot);
  fs.writeFileSync(path.join(componentRoot, 'worker.cjs'), 'changed while confirmation was open');
  await assert.rejects(verifyComponentTreeIdentity(componentRoot, identity), /发生变化/);
  fs.writeFileSync(path.join(componentRoot, 'worker.cjs'), 'new');
  const restoredIdentity = await captureComponentTreeIdentity(componentRoot);
  const copied = path.join(temporaryRoot, 'copied'); fs.cpSync(componentRoot, copied, { recursive: true });
  fs.writeFileSync(path.join(copied, 'worker.cjs'), 'changed during copy');
  await assert.rejects(verifyComponentTreeIdentity(copied, restoredIdentity), /发生变化/);

  const tooMany = path.join(temporaryRoot, 'too-many.zip');
  writeZip(tooMany, Array.from({ length: 10_001 }, (_, index) => [`files/${index}.txt`, '']));
  assert.throws(() => inspectComponentArchive(tooMany), /中央目录|条目/);

  const bomb = path.join(temporaryRoot, 'bomb.zip');
  writeZip(bomb, Array.from({ length: 5 }, (_, index) => [`bomb/${index}.bin`, '', { declaredSize: 0xffffffff, declaredCompressedSize: 0 }]));
  assert.throws(() => inspectComponentArchive(bomb), /ZIP64|展开大小超过安全上限/);

  const mismatch = path.join(temporaryRoot, 'mismatch.zip');
  writeZip(mismatch, [['component.json', manifest('mismatch'), { localMethod: 8 }], ['worker.cjs', 'ok']]);
  assert.throws(() => inspectComponentArchive(mismatch), /本地条目与中央目录不一致/);

  const symlink = path.join(temporaryRoot, 'symlink.zip');
  writeZip(symlink, [['component.json', manifest('link')], ['worker.cjs', 'target', { externalAttributes: (0xa000 << 16) >>> 0 }]]);
  assert.throws(() => inspectComponentArchive(symlink), /符号链接/);

  const corrupt = path.join(temporaryRoot, 'corrupt.zip');
  writeZip(corrupt, [['component.json', manifest('corrupt')], ['worker.cjs', 'payload']]);
  const bytes = fs.readFileSync(corrupt); bytes[30 + Buffer.byteLength('component.json') + Buffer.byteLength(manifest('corrupt')) + 30 + Buffer.byteLength('worker.cjs')] ^= 0xff; fs.writeFileSync(corrupt, bytes);
  const corruptInspection = inspectComponentArchive(corrupt);
  await assert.rejects(extractComponentArchive(corruptInspection, path.join(temporaryRoot, 'corrupt-out')), /CRC-32/);

  const raceRoot = path.join(temporaryRoot, 'race-install'); const raceContainer = path.join(raceRoot, 'third-party.tool');
  const raceDestination = path.join(raceContainer, 'runtime'); const raceBackup = path.join(raceRoot, '.backup'); const raceStaging = path.join(raceRoot, '.staging');
  fs.mkdirSync(raceContainer, { recursive: true });
  const safeLocation = await prepareSafeComponentInstallContainer({ fs, path, installRoot: raceRoot, componentId: 'third-party.tool' });
  assert.equal(safeLocation.container, raceContainer);
  fs.mkdirSync(raceBackup); fs.writeFileSync(path.join(raceBackup, 'old.txt'), 'old runtime');
  const backupStat = fs.lstatSync(raceBackup); const backupNodeIdentity = { dev: backupStat.dev, ino: backupStat.ino, birthtimeMs: backupStat.birthtimeMs };
  const backupTreeIdentity = await captureComponentTreeIdentity(raceBackup);
  fs.mkdirSync(raceStaging); fs.writeFileSync(path.join(raceStaging, 'new.txt'), 'new runtime');
  fs.mkdirSync(raceDestination); fs.writeFileSync(path.join(raceDestination, 'competitor.txt'), 'do not delete');
  await assert.rejects(fs.promises.rename(raceStaging, raceDestination));
  await assert.rejects(rollbackComponentPublication({ fs, destination: raceDestination, publishedByThisOperation: false, publishedNodeIdentity: null, publishedTreeIdentity: [], backupPath: raceBackup, backupNodeIdentity, backupTreeIdentity }), /其他操作占用/);
  assert.equal(fs.readFileSync(path.join(raceDestination, 'competitor.txt'), 'utf8'), 'do not delete', 'a destination created before rename is never deleted by rollback');
  assert.equal(fs.readFileSync(path.join(raceBackup, 'old.txt'), 'utf8'), 'old runtime', 'the captured backup is preserved when a competitor owns destination');

  const junctionRoot = path.join(temporaryRoot, 'junction-install'); const external = path.join(temporaryRoot, 'external-target');
  fs.mkdirSync(junctionRoot); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'sentinel.txt'), 'outside');
  fs.symlinkSync(external, path.join(junctionRoot, 'third-party.tool'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareSafeComponentInstallContainer({ fs, path, installRoot: junctionRoot, componentId: 'third-party.tool' }), /链接|真实路径/);
  assert.equal(fs.readFileSync(path.join(external, 'sentinel.txt'), 'utf8'), 'outside', 'a junction container cannot redirect installation or cleanup outside the install root');
} finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }

console.log('Component install trust-boundary tests passed');
