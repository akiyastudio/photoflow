const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerInspirationIpc } = require('../electron/modules/workspace/inspiration-ipc.cjs');
const { registerEntryDetailsIpc, registerRecentProjectFileIpc } = require('../electron/modules/workspace/project-file-query-ipc.cjs');

const registeredChannels = [];
const ipcMain = { handle: channel => registeredChannels.push(channel) };
const accessedRecentDependencies = new Set();
const recentDependencies = new Proxy({
  Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), Math, Number, Object, Promise,
  RAW_EXTENSIONS: new Set(), Set, String, VIDEO_EXTENSIONS: new Set(),
  assertExistingInside: () => undefined, assertInside: () => undefined, crypto: {}, fs: {}, getProjectPath: () => undefined,
  ipcMain, isInternalFileOperationEntry: () => false, listManagedExternalLinksBounded: () => undefined,
  mediaService: {}, path, resolveManagedExternalScope: () => undefined, shell: {}, shortcutSourceChannel: () => undefined,
  virtualPaths: {}, writeLog: () => undefined,
}, {
  get(target, property) {
    accessedRecentDependencies.add(property);
    assert(Object.hasOwn(target, property), `recent file IPC requested undeclared dependency: ${String(property)}`);
    return target[property];
  },
});
registerRecentProjectFileIpc(recentDependencies);
assert.deepEqual(registeredChannels, [
  'workspace-recent-files',
  'workspace-cancel-recent-files',
  'workspace-folder-tree',
]);
assert.deepEqual([...accessedRecentDependencies].sort(), Object.keys(recentDependencies).sort(), 'recent file IPC dependency bag must stay explicit and narrow');

const accessedInspirationDependencies = new Set();
const inspirationDependencies = new Proxy({
  Array, Error, Set, String, assertExistingInside: () => undefined, copyFileAtomic: () => undefined, fs: {},
  getProjectPath: () => undefined, ipcMain, mainWindow: {}, path, pushUndoOperation: () => undefined,
  resolveProjectEntry: () => undefined, shell: {}, uniqueDestination: () => undefined, writeLog: () => undefined,
}, {
  get(target, property) {
    accessedInspirationDependencies.add(property);
    assert(Object.hasOwn(target, property), `inspiration IPC requested undeclared dependency: ${String(property)}`);
    return target[property];
  },
});
registerInspirationIpc(inspirationDependencies);
assert.equal(registeredChannels.at(-1), 'workspace-add-inspiration-to-project');
assert.deepEqual([...accessedInspirationDependencies].sort(), Object.keys(inspirationDependencies).sort(), 'inspiration IPC dependency bag must stay explicit and narrow');

const accessedEntryDependencies = new Set();
const entryDependencies = new Proxy({
  Set, String, assertExistingInside: () => undefined, assertInside: () => undefined,
  fs: {}, getProjectPath: () => undefined, ipcMain, path, resolveManagedExternalScope: () => undefined,
}, {
  get(target, property) {
    accessedEntryDependencies.add(property);
    assert(Object.hasOwn(target, property), `entry-details IPC requested undeclared dependency: ${String(property)}`);
    return target[property];
  },
});
registerEntryDetailsIpc(entryDependencies);
assert.equal(registeredChannels.at(-1), 'workspace-entry-details');
assert.deepEqual([...accessedEntryDependencies].sort(), Object.keys(entryDependencies).sort(), 'entry-details IPC dependency bag must stay explicit and narrow');

const root = path.resolve(__dirname, '..');
const workspaceIpc = fs.readFileSync(path.join(root, 'electron/modules/workspace-ipc.cjs'), 'utf8');
const registrationMarkers = [
  "ipcMain.handle('workspace-browse-shortcut-preview'",
  '  registerRecentProjectFileIpc({',
  '  registerInspirationIpc({',
  '  registerEntryDetailsIpc({',
  '  registerWorkspaceImportIpc({',
];
for (let index = 1; index < registrationMarkers.length; index += 1) {
  assert(workspaceIpc.indexOf(registrationMarkers[index - 1]) < workspaceIpc.indexOf(registrationMarkers[index]), 'extracted handlers must retain their original registration order');
}
assert(workspaceIpc.split(/\r?\n/u).length <= 3200, 'workspace-ipc.cjs must remain within its 3200-line source budget');

console.log('Workspace IPC extraction tests passed.');
