import assert from 'node:assert/strict';
import { normalizeLegacyProgressResult, resolveLegacyTeamWorkflowProgressId } from '../renderer/src/legacy/legacy-progress-result-model.ts';

const workflow = {
  id: 'team-workflow', mediaKind: 'image', nodeRole: 'workflow', versionKey: 'team-workspace', displayName: '团片协作',
  sourceMetadata: { componentId: 'team-retouch' },
};
const folders = [{ id: 'source', mediaKind: 'image', nodeRole: 'progress' }, workflow];

assert.equal(resolveLegacyTeamWorkflowProgressId(folders), 'team-workflow', 'the current component-owned workflow node is resolved');
assert.equal(resolveLegacyTeamWorkflowProgressId(folders, 'team-workflow'), 'team-workflow');
assert.equal(resolveLegacyTeamWorkflowProgressId(folders, 'missing-workflow'), 'team-workflow', 'a stale preferred id falls back to the owned workflow node');
assert.equal(resolveLegacyTeamWorkflowProgressId([{ id: 'other', mediaKind: 'image', nodeRole: 'workflow', sourceMetadata: { componentId: 'other-component' } }]), '');
assert.deepEqual(normalizeLegacyProgressResult({ progressFolders: folders, graphEdges: [{ id: 'edge' }] }).graphEdges, [{ id: 'edge' }]);
assert.deepEqual(normalizeLegacyProgressResult({ progressFolders: folders, edges: [{ id: 'old-edge' }] }).graphEdges, []);

console.log('Team-retouch progress-result model tests passed');
