import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveTeamRetouchEntriesForOpen } from '../renderer/src/legacy/legacy-entry-scope.ts';
import { resolveLegacyTeamSourceProgressIds } from '../renderer/src/legacy/legacy-progress-scope.ts';
import { createActivationRefreshGate, createHistoryContextLoadCoordinator, createLatestHistoryLoadGuard, historyLoadPresentation } from '../renderer/src/legacy/legacy-history-load-model.ts';
import { readableComponentRpcError } from '../renderer/src/sdk.ts';
import { normalizeLegacyProgressResult } from '../renderer/src/legacy/legacy-progress-result-model.ts';

const workspace = { photos: [
  { photoId: 'p1', baseVersionId: 'v1', displayName: 'a.jpg', relativePath: 'raw/a.jpg', fileMissing: false, tasks: [] },
  { photoId: 'p2', baseVersionId: 'v2', displayName: 'b.jpg', relativePath: 'raw/b.jpg', fileMissing: true, tasks: [] },
] };
const resolution = resolveTeamRetouchEntriesForOpen(workspace, ['raw/a.jpg','selected/c.jpg']);
assert.deepEqual(resolution.entries.map(item => item.relativePath), ['raw/a.jpg','__photoflow_missing_team_history__/p2','selected/c.jpg']);
assert.equal(resolution.historyPhotoCount, 2); assert.equal(resolution.missingHistoryCount, 1); assert.equal(resolution.ownershipPendingCount, 0);
assert.deepEqual(resolveLegacyTeamSourceProgressIds(['raw/a.jpg'], [{ id: 'progress', mediaKind: 'image', folderMissing: false, nodeRole: 'progress', contentRef: { relativeDirectory: 'raw' } }]), ['progress']);
assert.deepEqual(normalizeLegacyProgressResult({ progressFolders: [{ id: 'p' }], graphEdges: [{ id: 'e' }] }), { progressFolders: [{ id: 'p' }], graphEdges: [{ id: 'e' }] });
assert.deepEqual(normalizeLegacyProgressResult({ progressFolders: [{ id: 'p' }], edges: [{ id: 'old' }] }), { progressFolders: [{ id: 'p' }], edges: [{ id: 'old' }], graphEdges: [] });
assert.deepEqual(historyLoadPresentation({ initialLoading: true, loadError: '', entriesLoaded: false, entryCount: 0 }), { phase: 'loading', title: '团片协作 · 正在读取团片历史' });
const guard = createLatestHistoryLoadGuard(); const first=guard.begin(); const second=guard.begin(); assert.equal(guard.isCurrent(first), false); assert.equal(guard.isCurrent(second), true);
const activation = createActivationRefreshGate(); assert.equal(activation.activate(), false); activation.deactivate(); assert.equal(activation.activate(), true);
const context = { componentId: 'team-retouch', componentVersion: '1', projectId: 'p', projectName: 'P', projectStatus: 'active', selectedRelativePaths: [], sourcePageId: 'files' };
let loads=0; const coordinator=createHistoryContextLoadCoordinator(async () => { loads += 1; });
await coordinator.request(context); await coordinator.request({ ...context }); assert.equal(loads, 1);
await coordinator.request(context, { force: true }); assert.equal(loads, 2);
assert.match(readableComponentRpcError('team.project.get.v1', new Error('SQLITE_BUSY: database is locked')), /正在整理/);
const entry=fs.readFileSync(new URL('../renderer/src/legacy-main.tsx', import.meta.url),'utf8');
assert(entry.includes("teamProjectRpc<Json>('team.project.get.v1')") && entry.includes("teamProjectRpc<Json>('team.project.register.v1'"));
assert.equal(/migrate-step|calibrat|HostStorageAdoption|legacyMigration/.test(entry), false);
assert(entry.includes('onThemeChange') && entry.includes('value.contractVersion === 1'));
console.log('Team-retouch current Host context and entry-scope tests passed');
