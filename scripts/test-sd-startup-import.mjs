import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { reconcileConfiguredSdDevices, resolveConfiguredSdDevices } from '../src/features/tools/sd-startup-import-model.ts';
import { createStorageDeviceInventoryController, isFreshStorageDeviceInventory, shouldPollStorageDeviceInventory } from '../src/features/tools/storage-device-inventory-model.ts';
import { decideStartupSdAutoImport, handledStartupRequestAfterBatchStart, shouldDeleteSourceForImportBatch } from '../src/features/tools/startup-sd-auto-import-model.ts';

const require = createRequire(import.meta.url);
const { normalizeMountPath, parseDiskutilInfoPlist, parseWindowsLogicalDisks, parseWindowsMountvolOutput, parseWindowsVolOutput, summarizeDarwinStorageDeviceResults } = require('../electron/services/storage-device-service.cjs');
const storageDeviceServiceSource = readFileSync(new URL('../electron/services/storage-device-service.cjs', import.meta.url), 'utf8');

const config = (paths, ids = {}, types = {}) => ({
  sdPath: paths[0] || '',
  sdPaths: paths,
  sdDriveTypes: types,
  sdDeviceIds: ids,
  sdDevices: Object.entries(ids).map(([lastMountPath, deviceId]) => ({
    deviceId,
    lastMountPath,
    type: types[lastMountPath] === 'broll' ? 'broll' : 'work',
    confirmedAt: 1,
    enabled: true,
  })),
});
const device = (id, mountPath, overrides = {}) => ({
  id,
  mountPath,
  label: '',
  removable: true,
  driveType: 2,
  identityStable: true,
  hasSupportedMedia: true,
  eligibleForSdImport: true,
  ...overrides,
});

assert.equal(normalizeMountPath('h:\\DCIM', 'win32'), 'H:/');
assert.deepEqual(parseWindowsLogicalDisks(JSON.stringify({ DeviceID: 'H:', DriveType: 2, VolumeName: 'CAMERA', VolumeSerialNumber: 'ab12-cd34' })), [{
  id: 'win-volume:AB12-CD34',
  mountPath: 'H:/',
  label: 'CAMERA',
  removable: true,
  driveType: 2,
  identityStable: true,
}]);
assert.equal(parseWindowsVolOutput('Volume Serial Number is ab12-cd34', 'h:').id, 'win-volume:AB12-CD34');
assert.equal(parseWindowsLogicalDisks(JSON.stringify({ Name: 'H:\\', DriveType: 2, HasSupportedMedia: true }))[0].hasSupportedMedia, true, 'Windows media-root probing must be returned by the bounded PowerShell inventory process');
assert.equal(parseWindowsVolOutput('', 'h:').identityStable, false, 'a path fallback must never claim to be a stable identity');
assert.equal(parseWindowsVolOutput('Volume Serial Number is 0000-0000', 'h:').identityStable, false, 'an all-zero serial is not a unique volume identity');
assert.deepEqual(parseWindowsMountvolOutput('\\\\?\\Volume{f3444f32-8514-11f1-ab45-94e70bb1e2c4}\\', 'e:'), {
  id: 'win-volume-guid:F3444F32-8514-11F1-AB45-94E70BB1E2C4',
  mountPath: 'E:/',
  identityStable: true,
});

const macDevice = parseDiskutilInfoPlist(`
  <plist><dict>
    <key>VolumeUUID</key><string>abcd-1234</string>
    <key>Internal</key><false/>
    <key>Removable</key><true/>
  </dict></plist>
`, '/Volumes/CAMERA');
assert.deepEqual(macDevice, { id: 'darwin-volume:ABCD-1234', identityStable: true, removable: true });
const macExternalFixedDevice = parseDiskutilInfoPlist(`
  <plist><dict>
    <key>VolumeUUID</key><string>fixed-1234</string>
    <key>Internal</key><false/>
    <key>RemovableMedia</key><false/>
    <key>Ejectable</key><true/>
  </dict></plist>
`, '/Volumes/EXTERNAL_SSD');
assert.equal(macExternalFixedDevice.removable, false, 'an external fixed disk must not be classified as removable media');
const macRemovableMediaDevice = parseDiskutilInfoPlist(`
  <plist><dict>
    <key>VolumeUUID</key><string>sd-1234</string>
    <key>Internal</key><true/>
    <key>RemovableMedia</key><true/>
  </dict></plist>
`, '/Volumes/SD_CARD');
assert.equal(macRemovableMediaDevice.removable, true, 'an explicitly removable medium may be accepted even when its reader is internal');
const validMacSdDevice = device('darwin-volume:SD-1234', '/Volumes/SD_CARD');
assert.deepEqual(summarizeDarwinStorageDeviceResults([
  { recognized: true, device: validMacSdDevice },
  { recognized: false, error: '/Volumes/NETWORK: not a disk' },
]), { devices: [validMacSdDevice], complete: true }, 'an unrelated macOS volume failure must not block a validated removable device');
assert.deepEqual(summarizeDarwinStorageDeviceResults([
  { recognized: false, error: '/Volumes/BROKEN: diskutil failed' },
]), { devices: [], complete: false, error: '无法识别 macOS 存储设备：/Volumes/BROKEN: diskutil failed' }, 'a systemic macOS inspection failure must remain visible');
assert(!storageDeviceServiceSource.includes('fs.promises.stat(candidate)'), 'media-root timeouts must not leave uncancelled libuv stat requests behind');
assert(!storageDeviceServiceSource.includes('.filter(device => fs.existsSync(device.mountPath))'), 'Windows inventory must filter and probe drives inside the bounded child process instead of synchronously touching every mount');

const secondCardOnly = resolveConfiguredSdDevices(
  config(['H:/', 'I:/'], { 'H:/': 'card-a', 'I:/': 'card-b' }, { 'I:/': 'broll' }),
  [device('card-b', 'I:/')],
);
assert.deepEqual(secondCardOnly.map(item => ({ path: item.mountPath, type: item.type })), [{ path: 'I:/', type: 'broll' }]);

const movedCard = resolveConfiguredSdDevices(
  config(['H:/'], { 'H:/': 'card-a' }),
  [device('card-a', 'K:/')],
);
assert.equal(movedCard[0]?.mountPath, 'K:/', 'a known volume must follow its identity when its drive letter changes');

const reusedLetter = resolveConfiguredSdDevices(
  config(['H:/'], { 'H:/': 'card-a' }),
  [device('different-card', 'H:/')],
);
assert.deepEqual(reusedLetter, [], 'a reused drive letter must not impersonate an enrolled SD card');

const legacyConfig = config(['h:/'], {}, { 'h:/': 'work' });
assert.deepEqual(resolveConfiguredSdDevices(legacyConfig, [device('card-a', 'H:/')]), [], 'legacy path-only config must not auto-enroll a device');
const unreconciledLegacy = reconcileConfiguredSdDevices(
  config(['h:/'], {}, { 'h:/': 'work' }),
  [device('card-a', 'H:/')],
);
assert.deepEqual(unreconciledLegacy, legacyConfig, 'legacy config must wait for explicit device confirmation');

assert.deepEqual(resolveConfiguredSdDevices(
  config(['H:/'], { 'H:/': 'card-a' }),
  [device('card-a', 'H:/', { identityStable: false })],
), [], 'unstable identities must be excluded from startup import');
assert.deepEqual(resolveConfiguredSdDevices(
  config(['H:/'], { 'H:/': 'card-a' }),
  [device('card-a', 'H:/', { removable: false, eligibleForSdImport: false })],
), [], 'fixed disks must be excluded from startup import');

const swappedCards = reconcileConfiguredSdDevices(
  config(['H:/', 'I:/'], { 'H:/': 'card-a', 'I:/': 'card-b' }, { 'H:/': 'work', 'I:/': 'broll' }),
  [device('card-a', 'I:/'), device('card-b', 'H:/')],
);
assert.deepEqual(swappedCards.sdDevices.map(record => ({ id: record.deviceId, path: record.lastMountPath, type: record.type })), [
  { id: 'card-a', path: 'I:/', type: 'work' },
  { id: 'card-b', path: 'H:/', type: 'broll' },
], 'two cards swapping drive letters must retain both identity records');

const oneMovedCard = reconcileConfiguredSdDevices(
  config(['H:/', 'I:/'], { 'H:/': 'card-a', 'I:/': 'card-b' }),
  [device('card-a', 'I:/')],
);
assert.equal(oneMovedCard.sdDevices.length, 2, 'an offline card must not be forgotten when another card moves onto its old path');
assert.equal(oneMovedCard.sdDevices.find(record => record.deviceId === 'card-b')?.enabled, true);

const startupRequest = { id: 1, createdAt: 1_000, expiresAt: 61_000, state: 'pending' };
const startupInput = {
  active: true,
  directSource: false,
  request: startupRequest,
  handledRequest: 0,
  ready: true,
  busy: false,
  now: 2_000,
};
assert.equal(decideStartupSdAutoImport({ ...startupInput, selectionCount: 0 }), 'wait-for-device', 'an empty first inventory must not consume the startup request');
assert.equal(decideStartupSdAutoImport({ ...startupInput, selectionCount: 1 }), 'start', 'a later inventory update must start the pending request');
assert.equal(decideStartupSdAutoImport({ ...startupInput, handledRequest: 1, selectionCount: 1 }), 'ignore', 'a completed startup request must not run twice');
assert.equal(decideStartupSdAutoImport({ ...startupInput, busy: true, selectionCount: 1 }), 'wait', 'a busy importer must keep the startup request pending');
assert.equal(decideStartupSdAutoImport({ ...startupInput, now: 61_000, selectionCount: 1 }), 'expired', 'a card inserted after the startup window must not auto-import');
assert.equal(decideStartupSdAutoImport({ ...startupInput, request: { ...startupRequest, state: 'cancelled' }, selectionCount: 1 }), 'ignore', 'turning the setting off must cancel a pending startup import');
const handledByManualStart = handledStartupRequestAfterBatchStart(startupRequest, 0, 'manual');
assert.equal(handledByManualStart, startupRequest.id, 'a successful manual batch start must consume the pending startup request');
assert.equal(decideStartupSdAutoImport({ ...startupInput, handledRequest: handledByManualStart, selectionCount: 1 }), 'ignore', 'a later inventory update must not auto-import again after a manual batch starts');
assert.equal(handledStartupRequestAfterBatchStart(startupRequest, 0, 'startup'), 0, 'the automatic path marks the request handled only after its batch actually starts');
assert.equal(shouldDeleteSourceForImportBatch(true, 'startup'), false, 'unattended startup import must preserve source files');
assert.equal(shouldDeleteSourceForImportBatch(true, 'manual'), true, 'manual import must continue to respect the user setting');

assert.equal(shouldPollStorageDeviceInventory({ section: 'import', active: true, busy: false, panelOpen: false, startupRequest }), true, 'a collapsed panel must keep polling while the startup window is pending');
assert.equal(shouldPollStorageDeviceInventory({ section: 'import', active: true, busy: false, panelOpen: false, startupRequest: { ...startupRequest, state: 'expired' } }), false, 'a collapsed panel must stop polling after the startup window expires');
assert.equal(shouldPollStorageDeviceInventory({ section: 'import', active: true, busy: false, panelOpen: true, startupRequest: null }), true, 'an open import panel must poll for devices');
assert.equal(shouldPollStorageDeviceInventory({ section: 'birthday', active: true, busy: false, panelOpen: true, startupRequest }), false, 'the birthday-only view must never poll storage devices');

const scheduled = [];
const cancelled = [];
const pendingLoads = [];
let loadCount = 0;
let now = 10_000;
const inventory = createStorageDeviceInventoryController({
  load: () => {
    loadCount += 1;
    return new Promise(resolve => pendingLoads.push(resolve));
  },
  schedule: callback => {
    scheduled.push(callback);
    return callback;
  },
  cancelSchedule: handle => { cancelled.push(handle); },
  now: () => now,
});
const snapshots = [];
const unsubscribeFirst = inventory.subscribe(snapshot => snapshots.push(snapshot));
const unsubscribeSecond = inventory.subscribe(() => undefined);
assert.equal(loadCount, 1, 'multiple mounted views must share one inventory request');
pendingLoads.shift()({ devices: [device('card-a', 'H:/')], complete: true });
await new Promise(resolve => setImmediate(resolve));
assert.equal(snapshots.at(-1).status, 'ready');
assert.equal(isFreshStorageDeviceInventory(snapshots.at(-1), now), true);
assert.equal(scheduled.length, 1, 'the next poll must be scheduled only after the active request completes');
scheduled.shift()();
assert.equal(loadCount, 2);
now = 14_000;
pendingLoads.shift()({ devices: [], complete: false, error: 'enumeration failed' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(snapshots.at(-1).status, 'error');
assert.equal(isFreshStorageDeviceInventory(snapshots.at(-1), now), false, 'an errored inventory must never be eligible for startup import');
unsubscribeFirst();
unsubscribeSecond();
assert.equal(cancelled.length, 1, 'the shared poll must stop after its final subscriber unmounts');

console.log('SD startup import model tests passed.');
