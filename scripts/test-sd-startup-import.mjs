import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { reconcileConfiguredSdDevices, resolveConfiguredSdDevices } from '../src/features/tools/sd-startup-import-model.ts';

const require = createRequire(import.meta.url);
const { normalizeMountPath, parseWindowsLogicalDisks, parseWindowsVolOutput } = require('../electron/services/storage-device-service.cjs');

const config = (paths, ids = {}, types = {}) => ({
  sdPath: paths[0] || '',
  sdPaths: paths,
  sdDriveTypes: types,
  sdDeviceIds: ids,
});
const device = (id, mountPath) => ({ id, mountPath, label: '', removable: true, driveType: 2 });

assert.equal(normalizeMountPath('h:\\DCIM', 'win32'), 'H:/');
assert.deepEqual(parseWindowsLogicalDisks(JSON.stringify({ DeviceID: 'H:', DriveType: 2, VolumeName: 'CAMERA', VolumeSerialNumber: 'ab12-cd34' })), [{
  id: 'win-volume:AB12-CD34',
  mountPath: 'H:/',
  label: 'CAMERA',
  removable: true,
  driveType: 2,
}]);
assert.equal(parseWindowsVolOutput('Volume Serial Number is ab12-cd34', 'h:').id, 'win-volume:AB12-CD34');

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

const migrated = reconcileConfiguredSdDevices(
  config(['h:/'], {}, { 'h:/': 'work' }),
  [device('card-a', 'H:/')],
);
assert.deepEqual(migrated.sdPaths, ['H:/']);
assert.equal(migrated.sdDeviceIds['H:/'], 'card-a');
assert.equal(migrated.sdDriveTypes['H:/'], 'work');

console.log('SD startup import model tests passed.');
