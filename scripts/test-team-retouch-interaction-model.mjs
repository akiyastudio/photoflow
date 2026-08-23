import assert from 'node:assert/strict';
import { assignmentKey, clampCrop, clampZoom, expandCrop, fitCropToMembers, normalizeRotation, progressCandidates, rankIdentityCandidates, resizeCrop, returnCandidates, returnReviewItems, shouldBlink, subjectsFromWorkspace, workflowGroups } from '../extensions/team-retouch/renderer/src/interaction-model.ts';

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
assert.deepEqual(clampCrop({ x: Number.NaN, y: 0, width: Number.NaN, height: 20 }, { width: 100, height: 100 }), { x: 0, y: 0, width: 1, height: 20 }, 'numeric crop inputs must never persist NaN');
assert.deepEqual(resizeCrop({ x: 20, y: 20, width: 40, height: 30 }, 'nw', -30, -40, { width: 100, height: 80 }), { x: 0, y: 0, width: 60, height: 50 });
assert.deepEqual(resizeCrop({ x: 20, y: 20, width: 40, height: 30 }, 'e', 70, 0, { width: 100, height: 80 }), { x: 20, y: 20, width: 80, height: 30 });
assert.deepEqual(resizeCrop({ x: 20, y: 20, width: 40, height: 30 }, 'move', 80, 70, { width: 100, height: 80 }), { x: 60, y: 50, width: 40, height: 30 });
assert.deepEqual(expandCrop({ x: 10, y: 10, width: 50, height: 40 }, { width: 100, height: 80 }, .1), { x: 5, y: 6, width: 60, height: 48 });
assert.deepEqual(fitCropToMembers([{ bbox: { x: 10, y: 20, width: 20, height: 30 } }, { bbox: { x: 60, y: 10, width: 30, height: 50 } }], { width: 100, height: 80 }, 0), { x: 10, y: 10, width: 80, height: 50 }, 'fit-to-members must union every person box');

const candidateSubjects = [
  { key: 'a', assignment: {} },
  { key: 'b', assignment: { identityId: 'alice' } },
  { key: 'c', assignment: { identityId: 'bob' } },
];
const ranked = rankIdentityCandidates(candidateSubjects[0], candidateSubjects, [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }], [
  { leftKey: 'a', rightKey: 'c', score: .55, bodyScore: .7, evidence: 'body-only' },
  { leftKey: 'b', rightKey: 'a', score: .86, faceScore: .9, bodyScore: .75, evidence: 'face+body' },
]);
assert.deepEqual(ranked.map(item => item.identity.id), ['alice', 'bob'], 'identity candidates must rank by best symmetric subject evidence');
assert.equal(ranked[0].faceScore, .9); assert.equal(ranked[0].confidence, '高'); assert.equal(ranked[1].evidence, 'body-only');

assert.deepEqual(returnCandidates({ taskId: 't1', photoId: 'p1', baseVersionId: 'v1', personIndex: 1, score: .7, alternatives: [{ taskId: 't2', photoId: 'p2', baseVersionId: 'v2', personIndex: 2, score: .9 }, { taskId: 't1', photoId: 'p1', baseVersionId: 'v1', personIndex: 1, score: .7 }] }).map(item => item.taskId), ['t2', 't1'], 'return candidates must deduplicate and sort by confidence');
assert.equal(clampZoom(9), 5); assert.equal(clampZoom(.2), 1); assert.equal(normalizeRotation(-90), 270);
assert.equal(shouldBlink('blink', true), true); assert.equal(shouldBlink('blink', false), false, 'deactivation must stop blink animation');

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
