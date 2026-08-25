import assert from 'node:assert/strict';
import { restoredWorkspaceConfig } from '../src/features/settings/restored-workspace-config.ts';

const snapshot = { theme: 'light', defaultFolderSort: 'name', workspacePath: 'C:/old', workspacePaths: ['C:/old'], backup: { enabled: true, targetType: 'local', targetPath: 'E:/backup' }, componentSettings: { fixture: { enabled: true } }, componentSettingsRevisions: { fixture: 4 } };
const restored = restoredWorkspaceConfig(snapshot, 'D:/restored');
assert.equal(restored.theme, 'light'); assert.equal(restored.defaultFolderSort, 'name');
assert.equal(restored.workspacePath, 'D:/restored'); assert.equal(restored.workspacePaths[0], 'D:/restored');
assert.deepEqual(restored.backup, snapshot.backup); assert.deepEqual(restored.componentSettings, snapshot.componentSettings);
assert.notStrictEqual(restored, snapshot);
console.log('Settings restore canonical model tests passed');

