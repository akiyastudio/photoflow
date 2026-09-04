import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { confirmComponentPackageInstall, validateComponentInstallRequest } = require('../electron/modules/system-ipc.cjs');

assert.deepEqual(validateComponentInstallRequest({ componentId: 'third-party.tool' }), { componentId: 'third-party.tool' });
assert.throws(() => validateComponentInstallRequest('third-party.tool'), /普通对象/);
assert.throws(() => validateComponentInstallRequest({ componentId: 'ThirdParty.Tool' }), /组件 ID 无效/);
assert.throws(() => validateComponentInstallRequest({ componentId: 'third-party.tool', ignoreSecurity: true }), /字段无效/);

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
const confirmation = integrityStatus => confirmComponentPackageInstall({ componentId: 'third-party.tool', integrityStatus, dialog, mainWindow: {} });

assert.equal(await confirmation('verified'), true);
assert.equal(await confirmation('pinned-unverified'), true);
assert.equal(dialogCalls, 0, 'app-verified and app-pinned packages do not show the unsigned warning');
assert.equal(await confirmation('unsigned'), false, 'cancel rejects the unsigned package');
assert.equal(dialogCalls, 1);
dialog.showMessageBox = async () => ({ response: 1 });
assert.equal(await confirmation('unsigned'), true, 'the explicit dangerous action authorizes this invocation');
await assert.rejects(confirmation('invalid'), /完整性状态无效/);

const preloadSource = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../electron/modules/system-ipc.cjs', import.meta.url), 'utf8');
assert.match(preloadSource, /installComponent: request => ipcRenderer\.invoke\('components-install', request\)/);
assert.match(mainSource, /resolvePackage\(componentId\)[\s\S]*copyFile\(archivePath, packageSnapshotPath\)[\s\S]*extractPreparedPackage\(packageSnapshotPath, packageStagePath\)/,
  'main snapshots the package it just resolved and installs from that snapshot, so a same-ID source replacement cannot change the confirmed bytes');
assert.match(mainSource, /extractPreparedPackage\(packageSnapshotPath, packageStagePath\)[\s\S]*JSON\.parse\(await fs\.promises\.readFile\(manifestPath, 'utf8'\)\)[\s\S]*verifyComponentDirectoryAsync[\s\S]*confirmComponentPackageInstall[\s\S]*ensureInstallRoot/,
  'main reparses and verifies the snapshotted package, then confirms unsigned code before touching the install root');
assert.match(mainSource, /if \(!confirmed\) return \{ success: false, cancelled: true \}/);
assert.match(mainSource, /if \(packageSnapshotPath\) await fs\.promises\.rm\(packageSnapshotPath/);

console.log('Component install trust-boundary tests passed');
