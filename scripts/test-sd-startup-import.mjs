import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { configuredSdDriveVideoActions, migrateLegacySdDeviceRecords, normalizeSavedSdDeviceRecords, normalizeSavedSdDriveVideoActions, reconcileConfiguredSdDevices, removeConfiguredSdDevice, resolveConfiguredSdDevices, storageDeviceMatchesId, upsertConfiguredSdDevice } from '../src/features/tools/sd-startup-import-model.ts';
import { createStorageDeviceInventoryController, isFreshStorageDeviceInventory, shouldPollStorageDeviceInventory } from '../src/features/tools/storage-device-inventory-model.ts';
import { decideStartupSdAutoImport, handledStartupRequestAfterBatchStart, shouldDeleteSourceForImportBatch } from '../src/features/tools/startup-sd-auto-import-model.ts';
import { availableComponentIds, componentRuntimeIsAvailable, componentUnavailableMessage } from '../src/features/components/component-availability-model.ts';
import { appendImportSuccess, createImportCompletion, createImportProtocolState, describeImportCompletion, pendingImportGraphKey, reduceImportProtocolEvent, shouldForgetImportSession } from '../src/features/tools/import-completion-model.ts';

const require = createRequire(import.meta.url);
const { collectProcessOutput, listWindowsStorageDevices, normalizeMountPath, parseDiskutilInfoPlist, parseWindowsLogicalDisks, parseWindowsMountvolOutput, parseWindowsVolOutput, probeWindowsStorageDevice, summarizeDarwinStorageDeviceResults, summarizeWindowsStorageDeviceResults } = require('../electron/services/storage-device-service.cjs');
const storageDeviceServiceSource = readFileSync(new URL('../electron/services/storage-device-service.cjs', import.meta.url), 'utf8');

const config = (paths, ids = {}, types = {}) => ({
  sdPath: paths[0] || '',
  sdPaths: paths,
  sdDriveTypes: types,
  sdDriveVideoActions: {},
  sdDeviceIds: ids,
  sdDevices: Object.entries(ids).map(([lastMountPath, deviceId]) => ({
    deviceId,
    lastMountPath,
    type: types[lastMountPath] === 'broll' ? 'broll' : 'work',
    splitVideosOnImport: false,
    transcodeVideosOnImport: false,
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

assert.equal(appendImportSuccess(createImportCompletion(), { sourceType: 'work', importedCount: 0, skipped: true }).outcome, 'skipped');
assert.equal(appendImportSuccess(createImportCompletion(), { sourceType: 'work', importedCount: 2, failedCount: 1 }).outcome, 'partial');
const legacyPartialFailure = appendImportSuccess(createImportCompletion(), { sourceType: 'work', projectNames: ['A'], importedCount: 2, partialFailure: true });
assert.equal(legacyPartialFailure.outcome, 'partial', 'legacy success payloads with partialFailure must retain their successful imports and render as partial');
assert.equal(legacyPartialFailure.importedCount, 2);
assert.deepEqual(legacyPartialFailure.projectNames, ['A']);
const explicitZeroPartialFailure = appendImportSuccess(createImportCompletion(), { sourceType: 'work', importedCount: 2, failedCount: 0, partialFailure: true });
assert.equal(explicitZeroPartialFailure.outcome, 'partial', 'an explicit zero failedCount must not erase partialFailure semantics');
assert.equal(explicitZeroPartialFailure.failedCount, 1, 'partialFailure with zero failedCount must contribute exactly one fallback failure');
assert.equal(appendImportSuccess(createImportCompletion(), { sourceType: 'work', importedCount: 2, failedCount: 2, partialFailure: true }).failedCount, 2, 'a positive failedCount and partialFailure must not be counted twice');
assert.equal(appendImportSuccess(createImportCompletion(), { sourceType: 'work', importedCount: 2, relationPending: true }).outcome, 'relation-pending');
const earlierPartialThenSuccess = appendImportSuccess(
  appendImportSuccess(createImportCompletion(), { sourceType: 'work', importedCount: 2, failedCount: 1 }),
  { sourceType: 'broll', importedCount: 3, failedCount: 0 },
);
assert.equal(earlierPartialThenSuccess.outcome, 'partial', 'a final successful card must not erase an earlier partial result');
assert.equal(describeImportCompletion(earlierPartialThenSuccess), '本批次成功导入 5 个文件，1 项未完成。', 'completion detail must describe the aggregate batch, not the final event');
const runImportEvents = events => events.reduce(reduceImportProtocolEvent, createImportProtocolState());
const pngPartialEvent = {
  type: 'partial',
  message: '处理完成！成功转换 1/2 个文件，1 个文件失败。',
  data: {
    successCount: 1,
    failedCount: 1,
    totalCount: 2,
    failedSources: ['damaged.png'],
  },
};
assert.deepEqual(runImportEvents([
  pngPartialEvent,
  { type: 'complete', data: { exitCode: 0 } },
]), { terminal: 'partial', failureMessage: '' }, 'the renderer must map the PNG converter partial payload to partial and keep it sticky through complete');
assert.deepEqual(runImportEvents([
  { type: 'error', message: '警告：导入数量不匹配' },
  { type: 'complete', data: { exitCode: 0 } },
]), { terminal: 'failed', failureMessage: '警告：导入数量不匹配' }, 'error severity must come from its structured type, not Chinese message text');
assert.deepEqual(runImportEvents([
  { type: 'warning', message: '警告：源文件会保留' },
  { type: 'success', data: { importedCount: 2 } },
  { type: 'complete', data: { exitCode: 0 } },
]), { terminal: 'success', failureMessage: '' }, 'only a structured warning may remain non-fatal');
assert.deepEqual(runImportEvents([
  { type: 'complete', data: { exitCode: 0 } },
]), { terminal: 'failed', failureMessage: '导入进程已结束，但未返回成功、部分完成、等待输入或取消结果。' }, 'complete-only is a protocol failure and must not be reported as success');
assert.deepEqual(runImportEvents([
  { type: 'ask_user', data: { kind: 'project_routing', requiresChoice: true } },
  { type: 'complete', data: { exitCode: 0 } },
]), { terminal: 'awaiting-input', failureMessage: '' }, 'a successful plan exit must preserve a required routing decision');
assert.deepEqual(runImportEvents([
  { type: 'ask_user', data: { need_split: true } },
  { type: 'complete', data: { exitCode: 7 } },
]), { terminal: 'failed', failureMessage: '导入进程异常退出（代码 7）' }, 'a nonzero exit while awaiting input must still fail');
let activeInvocation = { requestId: 'plan-request', state: createImportProtocolState() };
const acceptInvocationEvent = event => {
  if (event.requestId !== activeInvocation.requestId) return;
  activeInvocation.state = reduceImportProtocolEvent(activeInvocation.state, event);
};
acceptInvocationEvent({ requestId: 'plan-request', type: 'ask_user', data: { kind: 'project_routing', requiresChoice: false } });
assert.equal(activeInvocation.state.terminal, 'awaiting-input');
const planRequestId = activeInvocation.requestId;
activeInvocation = { requestId: 'import-request', state: createImportProtocolState() };
acceptInvocationEvent({ requestId: planRequestId, type: 'complete', data: { exitCode: 0 } });
assert.equal(activeInvocation.state.terminal, 'pending', 'the old plan complete must be filtered after auto-routing starts a new invocation');
acceptInvocationEvent({ requestId: 'import-request', type: 'success', data: { importedCount: 2 } });
acceptInvocationEvent({ requestId: 'import-request', type: 'complete', data: { exitCode: 0 } });
assert.equal(activeInvocation.state.terminal, 'success', 'the isolated import invocation must complete successfully');

const sameNameManifest = { projectName: 'same', importSessionId: 'session', manifestId: 'manifest-a' };
assert.notEqual(
  pendingImportGraphKey('workspace', sameNameManifest),
  pendingImportGraphKey('workspace', { ...sameNameManifest, manifestId: 'manifest-b' }),
  'renderer pending graph keys must prioritize manifestId for same-name manifests in one session',
);
assert.equal(
  pendingImportGraphKey('workspace', { projectName: 'same', importSessionId: 'session' }),
  'workspace\0legacy:same\0session',
  'legacy pending graph records without an ID must retain the project/session fallback key',
);
assert.deepEqual(runImportEvents([
  { type: 'success', data: { importedCount: 2 } },
  { type: 'complete', data: { exitCode: 7 } },
]), { terminal: 'success', failureMessage: '' }, 'success must remain sticky when a later complete reports a nonzero exit code');
assert.deepEqual(runImportEvents([
  { type: 'partial', data: { importedCount: 2, failedCount: 1 } },
  { type: 'complete', data: { exitCode: 7 } },
]), { terminal: 'partial', failureMessage: '' }, 'partial must remain sticky when a later complete reports a nonzero exit code');
assert.deepEqual(runImportEvents([
  { type: 'error', message: '导入数量不匹配' },
  { type: 'complete', data: { exitCode: 0 } },
]), { terminal: 'failed', failureMessage: '导入数量不匹配' }, 'failed must remain sticky when a later complete reports success');
assert.deepEqual(runImportEvents([
  { type: 'cancelled', message: '用户取消' },
  { type: 'complete', data: { exitCode: 7 } },
]), { terminal: 'cancelled', failureMessage: '' }, 'cancelled must remain sticky when a later complete reports a nonzero exit code');
const stagedSession = { persistedSession: { session: 'session-1', stagingComplete: true }, requestId: 'request-1', stage: 'routing', currentDrive: 'G:/', currentSession: 'session-1', currentSessionKey: 'dest\0G:/\0work', busy: true };
const persistedSessions = new Map([['dest\0G:/\0work', stagedSession.persistedSession]]);
if (shouldForgetImportSession('destination-missing')) persistedSessions.delete('dest\0G:/\0work');
assert.equal(persistedSessions.has('dest\0G:/\0work'), true, 'destination loss must preserve a staged resumable session');
let resolveDiscard;
const discardTerminal = new Promise(resolve => { resolveDiscard = resolve; });
resolveDiscard(false);
const firstDiscardSucceeded = await discardTerminal;
if (shouldForgetImportSession(firstDiscardSucceeded ? 'discard-success' : 'cancel-failed')) persistedSessions.delete('dest\0G:/\0work');
assert.equal(persistedSessions.has('dest\0G:/\0work'), true, 'a failed discard must preserve the staged session index');
if (shouldForgetImportSession('discard-success')) persistedSessions.delete('dest\0G:/\0work');
assert.equal(persistedSessions.has('dest\0G:/\0work'), false, 'only a confirmed discard success may forget the staged session index');
const invalidSessionKey = 'dest\0H:/\0work';
const invalidSessions = new Map([[invalidSessionKey, { session: 'invalid-session', stagingComplete: true }]]);
let generatedSession = 0;
const startWithPersistedSession = () => invalidSessions.get(invalidSessionKey)?.session || `new-session-${++generatedSession}`;
const firstStartSession = startWithPersistedSession();
assert.equal(firstStartSession, 'invalid-session');
await Promise.resolve();
if (shouldForgetImportSession('session-invalid')) invalidSessions.delete(invalidSessionKey);
const secondStartSession = startWithPersistedSession();
assert.notEqual(secondStartSession, firstStartSession, 'a second start must not reuse a session that the backend explicitly declared invalid');
assert.equal(secondStartSession, 'new-session-1');
assert.equal(shouldForgetImportSession('error'), false);
assert.equal(shouldForgetImportSession('destination-missing'), false);
assert.equal(shouldForgetImportSession('cancel-failed'), false);

assert.equal(normalizeMountPath('h:\\DCIM', 'win32'), 'H:/');
const silentChild = new (require('events').EventEmitter)();
silentChild.stdout = new (require('stream').PassThrough)(); silentChild.stderr = new (require('stream').PassThrough)(); silentChild.kill = () => true;
await assert.rejects(collectProcessOutput('silent-probe', [], { timeoutMs: 5, terminationGraceMs: 5, spawnImpl: () => silentChild }), /timed out/, 'timeout must settle even when a child never emits close');
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

const windowsProbeOutput = (mountPath, label = 'CAMERA') => JSON.stringify({ Name: mountPath, DriveType: 2, VolumeLabel: label, HasSupportedMedia: true });
const probeBase = parseWindowsLogicalDisks(JSON.stringify({ Name: 'H:\\', DriveType: 2 }))[0];
const canonicalWithGuid = await probeWindowsStorageDevice(probeBase, async (command, args) => {
  if (command === 'powershell.exe') return windowsProbeOutput('H:\\');
  if (args.includes('vol')) return 'Volume Serial Number is AB12-CD34';
  return '\\\\?\\Volume{F3444F32-8514-11F1-AB45-94E70BB1E2C4}\\';
});
const canonicalWithoutGuid = await probeWindowsStorageDevice(probeBase, async (command, args) => {
  if (command === 'powershell.exe') return windowsProbeOutput('H:\\');
  if (args.includes('vol')) return 'Volume Serial Number is AB12-CD34';
  throw new Error('mountvol timeout');
});
const guidFallback = await probeWindowsStorageDevice(probeBase, async (command, args) => {
  if (command === 'powershell.exe') return windowsProbeOutput('H:\\');
  if (args.includes('vol')) throw new Error('vol failed');
  return '\\\\?\\Volume{F3444F32-8514-11F1-AB45-94E70BB1E2C4}\\';
});
assert.equal(canonicalWithGuid.device.id, 'win-volume:AB12-CD34');
assert.equal(canonicalWithoutGuid.device.id, canonicalWithGuid.device.id, 'mountvol availability must never change the public device ID');
assert.deepEqual(canonicalWithGuid.device.aliases, ['win-volume-guid:F3444F32-8514-11F1-AB45-94E70BB1E2C4']);
assert.equal(guidFallback.device.id, 'win-volume-guid:F3444F32-8514-11F1-AB45-94E70BB1E2C4', 'a stable GUID must replace the path fallback when vol fails');

const duplicateSerials = summarizeWindowsStorageDeviceResults([
  { recognized: true, device: device('win-volume:DUPL-0001', 'H:/') },
  { recognized: true, device: device('win-volume:DUPL-0001', 'I:/') },
]);
assert(duplicateSerials.devices.every(item => item.identityStable === false), 'a serial collision must invalidate both identities');
assert(duplicateSerials.deviceErrors.some(item => item.error.includes('重复设备标识')));
const sharedGuid = 'win-volume-guid:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const duplicateAliases = summarizeWindowsStorageDeviceResults([
  { recognized: true, device: device('win-volume:1111-AAAA', 'H:/', { aliases: [sharedGuid] }) },
  { recognized: true, device: device('win-volume:2222-BBBB', 'I:/', { aliases: [sharedGuid] }) },
]);
assert(duplicateAliases.devices.every(item => item.identityStable === false && item.eligibleForSdImport === false), 'a shared GUID alias must invalidate both otherwise-distinct serial identities');

const isolatedWindowsInventory = await listWindowsStorageDevices({ collect: async (command, args) => {
  const commandText = args.join(' ');
  if (command === 'powershell.exe' && commandText.includes('GetDrives')) {
    return JSON.stringify([{ Name: 'H:\\', DriveType: 2 }, { Name: 'I:\\', DriveType: 2 }]);
  }
  if (command === 'powershell.exe' && commandText.includes("'H:/'")) throw new Error('H probe timeout');
  if (command === 'powershell.exe') return windowsProbeOutput('I:\\', 'HEALTHY');
  if (args.includes('vol') && args.includes('I:')) return 'Volume Serial Number is 1111-2222';
  if (args.includes('mountvol') && args.includes('I:')) return '\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\';
  throw new Error('simulated broken device probe');
} });
assert.equal(isolatedWindowsInventory.complete, true, 'one failed device probe must not invalidate recognized cards');
assert.deepEqual(isolatedWindowsInventory.devices.map(item => item.id), ['win-volume:1111-2222']);
assert(isolatedWindowsInventory.deviceErrors.some(item => item.mountPath === 'H:/'), 'the failed card must remain visible as a per-device error');

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
]), { devices: [validMacSdDevice], complete: true, deviceErrors: [{ mountPath: '/Volumes/NETWORK', error: '/Volumes/NETWORK: not a disk' }], warning: '有 1 个设备探测步骤失败，其他存储卡仍可使用' }, 'an unrelated macOS volume failure must be reported without blocking a validated removable device');
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

const perDeviceActionsConfig = config(['G:/', 'H:/'], { 'G:/': 'card-g', 'H:/': 'card-h' });
perDeviceActionsConfig.sdDevices[0].transcodeVideosOnImport = true;
perDeviceActionsConfig.sdDevices[1].splitVideosOnImport = true;
assert.deepEqual(configuredSdDriveVideoActions(perDeviceActionsConfig, []), {
  'G:/': { splitVideosOnImport: false, transcodeVideosOnImport: true },
  'H:/': { splitVideosOnImport: true, transcodeVideosOnImport: false },
}, 'each recorded card must retain its own video-processing behavior');
assert.deepEqual(configuredSdDriveVideoActions(perDeviceActionsConfig, [device('card-g', 'K:/')])['K:/'], {
  splitVideosOnImport: false,
  transcodeVideosOnImport: true,
}, 'per-card video behavior must follow the device identity when its drive letter changes');

const migratedVideoActions = normalizeSavedSdDeviceRecords(
  [{ deviceId: 'legacy-card', lastMountPath: 'G:/', type: 'broll', confirmedAt: 1, enabled: true }],
  ['G:/'],
  { 'G:/': 'legacy-card' },
  { 'G:/': 'broll' },
  { broll: { splitVideosOnImport: false, transcodeVideosOnImport: true } },
);
assert.equal(migratedVideoActions[0].transcodeVideosOnImport, true, 'legacy type-level video settings must migrate onto each recorded device');
assert.deepEqual(normalizeSavedSdDriveVideoActions(undefined, ['G:/'], { 'G:/': 'work' }, {
  work: { splitVideosOnImport: true, transcodeVideosOnImport: false },
}), { 'G:/': { splitVideosOnImport: true, transcodeVideosOnImport: false } }, 'a legacy path-only record must receive its own migrated video behavior');
assert.deepEqual(normalizeSavedSdDriveVideoActions(undefined, ['g:/'], { 'G:\\': 'broll' }, {
  work: { splitVideosOnImport: false, transcodeVideosOnImport: false },
  broll: { splitVideosOnImport: true, transcodeVideosOnImport: true },
}), { 'g:/': { splitVideosOnImport: true, transcodeVideosOnImport: true } }, 'legacy video defaults must use a case/slash-insensitive path lookup');
const caseInsensitiveSavedRecords = normalizeSavedSdDeviceRecords(undefined, ['g:/'], { 'G:\\': 'CARD-G' }, { 'G:/': 'broll' }, {
  broll: { splitVideosOnImport: true, transcodeVideosOnImport: true },
});
assert.equal(caseInsensitiveSavedRecords[0]?.deviceId, 'CARD-G');
assert.equal(caseInsensitiveSavedRecords[0]?.type, 'broll');
assert.equal(caseInsensitiveSavedRecords[0]?.splitVideosOnImport, true);
assert.equal(caseInsensitiveSavedRecords[0]?.transcodeVideosOnImport, true);
assert.deepEqual(migrateLegacySdDeviceRecords({ sdPath: 'g:/', sdPaths: ['g:/'], sdDeviceIds: { 'G:\\': 'CARD-G' }, sdDriveTypes: { 'G:/': 'broll' } }).map(record => [record.deviceId, record.type]), [['CARD-G', 'broll']], 'legacy record migration must use path identity for IDs and types');

const legacyPathWithActions = config(['g:/'], {}, { 'g:/': 'work' });
legacyPathWithActions.sdDriveVideoActions = { 'g:/': { splitVideosOnImport: false, transcodeVideosOnImport: true } };
assert.deepEqual(configuredSdDriveVideoActions(legacyPathWithActions, [])['g:/'], {
  splitVideosOnImport: false,
  transcodeVideosOnImport: true,
}, 'a legacy path-only record must expose its configured action before identity confirmation');
const enrolledLegacyPath = upsertConfiguredSdDevice(legacyPathWithActions, device('card-g', 'G:/'), 'work', 99);
assert.equal(enrolledLegacyPath.sdDevices[0].transcodeVideosOnImport, true, 'identity confirmation must carry the legacy path behavior onto the device record');

const movedCard = resolveConfiguredSdDevices(
  config(['H:/'], { 'H:/': 'card-a' }),
  [device('card-a', 'K:/')],
);
assert.equal(movedCard[0]?.mountPath, 'K:/', 'a known volume must follow its identity when its drive letter changes');

const legacyGuid = 'win-volume-guid:F3444F32-8514-11F1-AB45-94E70BB1E2C4';
const canonicalCard = device('win-volume:AB12-CD34', 'K:/', { aliases: [legacyGuid] });
assert.equal(storageDeviceMatchesId(canonicalCard, legacyGuid), true);
assert.equal(resolveConfiguredSdDevices(config(['H:/'], { 'H:/': legacyGuid }), [canonicalCard])[0]?.deviceId, 'win-volume:AB12-CD34', 'legacy GUID enrollment must resolve through the canonical serial identity');
const migratedGuidConfig = reconcileConfiguredSdDevices(config(['H:/'], { 'H:/': legacyGuid }), [canonicalCard]);
assert.equal(migratedGuidConfig.sdDevices[0].deviceId, 'win-volume:AB12-CD34', 'legacy GUID enrollment must be rewritten to the canonical ID');
assert.deepEqual(migratedGuidConfig.sdDeviceIds, { 'K:/': 'win-volume:AB12-CD34' }, 'canonical migration must remove the old GUID mirror and drive letter');
assert.deepEqual(removeConfiguredSdDevice(migratedGuidConfig, canonicalCard.id).sdPaths, [], 'removing a migrated device must not resurrect its legacy path');
const caseAliasConfig = config(['g:/'], { 'G:/': 'CARD-ALIAS' });
caseAliasConfig.sdDriveTypes = { 'G:/': 'work' };
caseAliasConfig.sdDriveVideoActions = { 'G:/': { splitVideosOnImport: true, transcodeVideosOnImport: false } };
const removedCaseAlias = removeConfiguredSdDevice(caseAliasConfig, 'card-alias');
assert.deepEqual(removedCaseAlias.sdPaths, [], 'device removal must match case-insensitive identity aliases');
assert.deepEqual(removedCaseAlias.sdDeviceIds, {}, 'device removal must clear case-insensitive path mirrors');
assert.deepEqual(removedCaseAlias.sdDriveTypes, {});
assert.deepEqual(removedCaseAlias.sdDriveVideoActions, {});

const guidWithoutAliasConfig = reconcileConfiguredSdDevices(
  config(['H:/'], { 'H:/': legacyGuid }),
  [device('win-volume:AB12-CD34', 'H:/')],
);
assert.equal(guidWithoutAliasConfig.sdDevices[0].confirmedAt, 0, 'a legacy GUID without a live alias must require explicit confirmation instead of trusting the drive letter');
const reconfirmedGuidConfig = upsertConfiguredSdDevice(guidWithoutAliasConfig, device('win-volume:AB12-CD34', 'H:/'), 'work', 99);
assert.deepEqual(reconfirmedGuidConfig.sdDevices.map(record => record.deviceId), ['win-volume:AB12-CD34'], 'explicit confirmation must replace the pending GUID record in place');
assert.deepEqual(reconfirmedGuidConfig.sdDeviceIds, { 'H:/': 'win-volume:AB12-CD34' });

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
pendingLoads.shift()({ devices: [device('card-a', 'H:/')], complete: true, warning: 'one probe failed', deviceErrors: [{ mountPath: 'I:/', error: 'timeout' }] });
await new Promise(resolve => setImmediate(resolve));
assert.equal(snapshots.at(-1).status, 'ready');
assert.equal(snapshots.at(-1).warning, 'one probe failed');
assert.deepEqual(snapshots.at(-1).deviceErrors, [{ mountPath: 'I:/', error: 'timeout' }]);
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

const settingsSource = readFileSync(new URL('../src/features/settings/SettingsFeature.tsx', import.meta.url), 'utf8');
const toolsSource = readFileSync(new URL('../src/features/tools/ToolViews.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const workspaceSource = readFileSync(new URL('../src/features/workspace/ProjectWorkspace.tsx', import.meta.url), 'utf8');
assert(settingsSource.includes('需要安装视频处理组件') || settingsSource.includes("componentCapabilityUnavailableMessage(components, 'media.video.processing', '视频处理组件')"));
assert(settingsSource.includes('disabled={!videoToolsAvailable}') && settingsSource.includes('视频切割、转码及参数入口已停用'), 'missing video-tools disables per-device actions and explains why');
assert(toolsSource.includes("if (!videoToolsAvailable) return { splitVideosOnImport: false, transcodeVideosOnImport: false }"), 'saved legacy flags must not reach the import worker when video-tools is unavailable');
assert(/const runCmd = \(stage: string, args: string\[\] = \[\]\) => \{\s*const requestId = crypto\.randomUUID\(\);\s*importProtocolStateRef\.current = createImportProtocolState\(\);\s*importRequestIdRef\.current = requestId;/s.test(toolsSource), 'every plan/import/broll invocation must begin with a fresh request ID and protocol state');
assert(toolsSource.includes("['--import_session', currentImportSessionRef.current]"), 'fresh invocation IDs must not replace the stable import session ID');
assert(toolsSource.includes('], requestId);') && !toolsSource.includes('], importRequestIdRef.current);'), 'runCmd must pass its immutable local request ID to Electron');
assert(appSource.includes('videoToolsAvailable={videoToolsAvailable}'));
assert(workspaceSource.includes('videoToolsAvailable={videoToolsAvailable}'), 'project and direct-source imports must share the runtime availability gate');
const availableVideoTools = { id: 'video-tools', installed: true, enabled: true, compatible: true, runtimeAvailable: true, status: 'installed' };
assert.equal(componentRuntimeIsAvailable([availableVideoTools], 'video-tools'), true);
assert.equal(componentRuntimeIsAvailable([{ ...availableVideoTools, enabled: false }], 'video-tools'), false);
assert.equal(componentRuntimeIsAvailable([{ ...availableVideoTools, runtimeAvailable: false }], 'video-tools'), false);
assert.equal(availableComponentIds([availableVideoTools]).has('video-tools'), true);
assert.equal(componentUnavailableMessage([], 'video-tools', '视频处理组件'), '需要安装视频处理组件');

console.log('SD startup import model tests passed.');
