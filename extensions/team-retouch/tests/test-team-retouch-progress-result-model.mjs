import assert from 'node:assert/strict';
import { normalizeLegacyProgressResult, resolveLegacyTeamWorkflowProgressId } from '../renderer/src/legacy/legacy-progress-result-model.ts';

const workflow = {
  id: 'team-workflow', mediaKind: 'image', nodeRole: 'workflow', versionKey: 'team-workspace', displayName: '团片协作',
  artifactKind: 'team_workspace', sourceMetadata: { componentId: 'team-retouch' },
};
const folders = [{ id: 'source', mediaKind: 'image', nodeRole: 'progress' }, workflow];

assert.equal(resolveLegacyTeamWorkflowProgressId(folders), 'team-workflow', 'an existing migrated team workflow is recovered when the component snapshot omitted workflowNode');
assert.equal(resolveLegacyTeamWorkflowProgressId(folders, 'team-workflow'), 'team-workflow');
assert.equal(resolveLegacyTeamWorkflowProgressId(folders, 'missing-workflow'), 'team-workflow', 'a stale preferred id falls back to the owned workflow node');
assert.equal(resolveLegacyTeamWorkflowProgressId([{ id: 'other', mediaKind: 'image', nodeRole: 'workflow', sourceMetadata: { componentId: 'other-component' } }]), '');
assert.deepEqual(normalizeLegacyProgressResult({ progressFolders: folders, edges: [{ id: 'edge' }] }).graphEdges, [{ id: 'edge' }]);

console.log('Team-retouch progress-result model tests passed');
