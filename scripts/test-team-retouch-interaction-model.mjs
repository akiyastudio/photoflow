import assert from 'node:assert/strict';
import { assignmentKey, clampCrop, progressCandidates, returnReviewItems, subjectsFromWorkspace, workflowGroups } from '../extensions/team-retouch/renderer/src/interaction-model.ts';

const workspace = {
  identities: [{ id: 'alice', name: 'Alice' }, { id: 'pending', name: '待确认人物 2' }],
  assignments: [
    { photoId: 'p1', baseVersionId: 'v1', personIndex: 1, identityId: 'alice', completed: false },
    { photoId: 'p1', baseVersionId: 'v1', personIndex: 2, identityId: 'pending', completed: false },
  ],
  photos: [{ photoId: 'p1', baseVersionId: 'v1', name: 'group.jpg', tasks: [{ id: 'task', crop: { x: 0, y: 0, width: 100, height: 80 }, members: [{ personIndex: 1, bbox: { x: 1, y: 2, width: 20, height: 30 } }, { personIndex: 2, bbox: { x: 30, y: 2, width: 20, height: 30 } }] }] }],
};

assert.equal(assignmentKey('p1', 'v1', 2), 'p1:v1:2');
const subjects = subjectsFromWorkspace(workspace);
assert.equal(subjects.length, 2, 'multi-person tasks must expose one manually confirmable subject per member');
assert.equal(subjects[0].identity.name, 'Alice');

const groups = workflowGroups(workspace, ['alice', 'pending']);
assert.equal(groups.length, 1, 'pending work remains schedulable while generated placeholder identities stay excluded');
assert.equal(groups[0].identityId, 'alice');

assert.deepEqual(clampCrop({ x: -10, y: 95, width: 200, height: 30 }, { width: 100, height: 100 }), { x: 0, y: 95, width: 100, height: 5 }, 'crop must remain inside source bounds');

const candidates = progressCandidates({ progressFolders: [
  { id: 'source', mediaKind: 'image', nodeRole: 'progress', folderPath: 'C:/project/raw' },
  { id: 'target', mediaKind: 'image', nodeRole: 'progress', folderPath: 'C:/project/output' },
  { id: 'missing', mediaKind: 'image', nodeRole: 'progress', folderMissing: true },
  { id: 'aux', mediaKind: 'image', nodeRole: 'progress', relationKind: 'auxiliary' },
] }, ['C:/project/raw/a.jpg']);
assert.deepEqual(candidates.map(item => item.id), ['target'], 'merge target choices must reject source, missing, and auxiliary progress nodes');

assert.deepEqual(returnReviewItems({ matches: [{ returnId: 'r1' }] }), [{ returnId: 'r1' }]);
assert.deepEqual(returnReviewItems(undefined), []);

console.log('Team-retouch interaction model tests passed');
