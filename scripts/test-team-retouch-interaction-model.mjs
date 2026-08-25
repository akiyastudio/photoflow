import assert from 'node:assert/strict';
import { assignmentKey, canEnterWorkflowStage, clampCrop, clampZoom, expandCrop, fitCropToMembers, isIdentityConfirmed, mergeAudit, normalizeRotation, normalizeWorkspace, progressCandidates, rankIdentityCandidates, relayChainForItems, resizeCrop, returnCandidates, returnMatchAssessment, returnModificationAssessment, returnReviewItems, shouldBlink, subjectsFromWorkspace, workflowGroups, workflowLayoutMode, workflowStageSummaries, workingImageMetrics } from '../extensions/team-retouch/renderer/src/interaction-model.ts';

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

const legacyWorkspace = normalizeWorkspace({ photos: [{ photoId: 'old', baseVersionId: 'v0', tasks: [{ id: 'old-task', personIndex: 1 }] }] });
assert.deepEqual(legacyWorkspace.identities, []);
assert.deepEqual(legacyWorkspace.assignments, []);
assert.equal(legacyWorkspace.photos[0].tasks[0].members[0].personIndex, 1, 'old single-person tasks must normalize without new fields');
assert.equal(isIdentityConfirmed({ identityId: 'alice', completed: true, completionKind: 'manual', source: 'suggested' }, { id: 'alice', name: 'Alice' }), false, 'retouch completion must never confirm identity');
assert.equal(isIdentityConfirmed({ identityId: 'alice', source: 'manual-group' }, { id: 'alice', name: 'Alice' }), true, 'legacy manual identity confirmation remains supported');

const guardedWorkspace = {
  photos: [{ photoId: 'p1', baseVersionId: 'v1', tasks: [{ id: 't1', personIndex: 1, bbox: { x: 0, y: 0, width: 10, height: 10 }, crop: { x: 0, y: 0, width: 20, height: 20 } }] }],
  identities: [{ id: 'alice', name: 'Alice' }], assignments: [],
};
assert.equal(canEnterWorkflowStage(guardedWorkspace, 'assignment').allowed, false, 'stage 2 must be guarded until identity is manually confirmed');
const confirmedWorkspace = { ...guardedWorkspace, assignments: [{ photoId: 'p1', baseVersionId: 'v1', personIndex: 1, identityId: 'alice', source: 'manual' }] };
assert.equal(canEnterWorkflowStage(confirmedWorkspace, 'assignment').allowed, true);
assert.equal(canEnterWorkflowStage(confirmedWorkspace, 'relay').allowed, false, 'stage 3 must wait for generated assignment workflow');
const generatedWorkspace = { ...confirmedWorkspace, workflowGenerated: true, workflowNeedsRegeneration: false, workflowParticipantKeys: ['p1:v1:1'] };
assert.equal(canEnterWorkflowStage(generatedWorkspace, 'relay').allowed, true);
const stageStates = workflowStageSummaries(generatedWorkspace, 'relay');
assert.equal(stageStates.find(item => item.id === 'detect').complete, true);
assert.equal(stageStates.find(item => item.id === 'relay').state, 'current');

const historicalProjects = [
  { photoCount: 21, taskCount: 64, identityCount: 9, assignmentCount: 140, completedCount: 60, returnedCount: 57 },
  { photoCount: 23, taskCount: 63, identityCount: 10, assignmentCount: 196, completedCount: 171, returnedCount: 110 },
  { photoCount: 27, taskCount: 79, identityCount: 11, assignmentCount: 296, completedCount: 162, returnedCount: 141 },
];
for (const [fixtureIndex, fixture] of historicalProjects.entries()) {
  const identities = Array.from({ length: fixture.identityCount }, (_, index) => ({ id: `legacy-${fixtureIndex}-identity-${index}`, name: `历史人物 ${index + 1}` }));
  const assignments = Array.from({ length: fixture.assignmentCount }, (_, index) => ({
    photoId: `legacy-${fixtureIndex}-photo-${(index % fixture.taskCount) % fixture.photoCount}`, baseVersionId: `legacy-${fixtureIndex}-version-${(index % fixture.taskCount) % fixture.photoCount}`,
    personIndex: index + 1, identityId: identities[index % identities.length].id, source: index % 3 ? 'suggested' : 'manual',
    completed: index < fixture.completedCount, completionKind: index < fixture.returnedCount ? 'returned' : index < fixture.completedCount ? 'no-retouch' : '',
  }));
  const photos = Array.from({ length: fixture.photoCount }, (_, photoIndex) => ({
    photoId: `legacy-${fixtureIndex}-photo-${photoIndex}`, baseVersionId: `legacy-${fixtureIndex}-version-${photoIndex}`,
    tasks: Array.from({ length: fixture.taskCount }, (_, taskIndex) => taskIndex).filter(taskIndex => taskIndex % fixture.photoCount === photoIndex).map(taskIndex => ({
      id: `legacy-task-${fixtureIndex}-${taskIndex}`, needsReview: true,
      members: assignments.filter((_, assignmentIndex) => assignmentIndex % fixture.taskCount === taskIndex).map(item => ({ personIndex: item.personIndex })),
    })),
  }));
  assert.equal(photos.flatMap(photo => photo.tasks).length, fixture.taskCount);
  const subjectAssignments = new Set(photos.flatMap(photo => photo.tasks.flatMap(task => task.members.map(member => `${photo.photoId}:${photo.baseVersionId}:${member.personIndex}`))));
  const historical = { photos, identities, assignments, workflowGenerated: true, workflowNeedsRegeneration: false, workflowParticipantKeys: [...subjectAssignments] };
  const stages = workflowStageSummaries(historical, 'relay');
  assert.equal(canEnterWorkflowStage(historical, 'relay').allowed, true, 'verified historical workflows may enter relay despite suggested identity sources');
  assert.equal(stages.find(item => item.id === 'detect').complete, true);
  const eligibleAssignments = assignments.filter(item => subjectAssignments.has(`${item.photoId}:${item.baseVersionId}:${item.personIndex}`));
  assert.equal(stages.find(item => item.id === 'relay').count, `${eligibleAssignments.filter(item => item.completed).length}/${eligibleAssignments.length} 已完成 · ${eligibleAssignments.filter(item => item.completionKind === 'returned').length} 已返图`, 'relay counts include suggested assignments proven by the manifest');
  assert.equal(mergeAudit(historical).ready, false, 'historical stage compatibility never relaxes merge confirmation and completion blockers');
}
const forgedGenerated = { ...guardedWorkspace, workflowGenerated: true, workflowNeedsRegeneration: false };
assert.equal(canEnterWorkflowStage(forgedGenerated, 'relay').allowed, false, 'a renderer boolean without verified manifest participants cannot bypass identity confirmation');

const relay = relayChainForItems([
  { key: 'a', week: 1, personIndex: 1, identity: { name: 'A' }, ready: true, assignment: { completed: true, completionKind: 'returned' } },
  { key: 'b', week: 2, personIndex: 2, identity: { name: 'B' }, ready: true, assignment: { completed: false } },
]);
assert.deepEqual(relay.map(node => node.label), ['原始裁图', 'A 返图', 'B']);
assert.equal(relay[2].kind, 'holder');
assert.match(relay[2].reason, /当前持有人/);
const waitingRelay = relayChainForItems([{ key: 'a', week: 1, identity: { name: 'A' }, ready: false, blockedBy: ['上一位'] }]);
assert.equal(waitingRelay[1].state, 'waiting');
assert.match(waitingRelay[1].reason, /等待/);

const unknownEdit = returnModificationAssessment({});
assert.equal(unknownEdit.known, false); assert.equal(unknownEdit.suspicious, false); assert.equal(unknownEdit.label, '修改有效性待人工查看');
assert.equal(returnModificationAssessment({ modificationScore: .01 }).suspicious, true, 'near-identical returns must warn as potentially unmodified');
assert.equal(returnModificationAssessment({ modificationScore: .4 }).suspicious, false);
for (const editEvidence of [
  { reallyModified: false }, { exactSame: true }, { nearUnchanged: true }, { mistakenFullOriginal: true }, { abnormalDimensions: true },
]) assert.equal(returnModificationAssessment({ editEvidence }).suspicious, true, `backend editEvidence must require review: ${JSON.stringify(editEvidence)}`);
const backendEdit = returnModificationAssessment({ editEvidence: { reallyModified: true, exactSame: false, nearUnchanged: false, changedFraction: .17, meanAbsoluteDifference: 8.2, mistakenFullOriginal: false, abnormalDimensions: false } });
assert.equal(backendEdit.known, true); assert.equal(backendEdit.suspicious, false); assert.equal(backendEdit.score, .17); assert.equal(backendEdit.changedFraction, .17); assert.equal(backendEdit.meanAbsoluteDifference, 8.2);
assert.equal(returnModificationAssessment({ editEvidence: { reallyModified: true }, returnWarnings: ['色彩空间异常'] }).suspicious, true, 'any backend returnWarnings must force manual review');
assert.equal(returnMatchAssessment({ taskId: 't1', score: .91 }).needsManualMatch, false);
assert.equal(returnMatchAssessment({ score: .4 }).needsManualMatch, true);
assert.equal(returnMatchAssessment({ taskId: 't1', matchConfidence: 'low', score: .99 }).needsManualMatch, true, 'matchConfidence must take priority over numeric score');
assert.equal(returnMatchAssessment({ taskId: 't1', matchConfidence: 'medium', score: .1 }).label, '任务匹配度中');
assert.equal(returnMatchAssessment({ taskId: 't1', matchConfidence: 'review', score: .99 }).label, '任务匹配需人工确认');

const unknownMetrics = workingImageMetrics({}, {});
assert.equal(unknownMetrics.width, 0); assert.equal(unknownMetrics.fullFrame, undefined); assert.equal(unknownMetrics.requiresManualCrop, undefined); assert.equal(unknownMetrics.backend, '未知');
const metrics = workingImageMetrics({
  detector: 'rtmdet-pairdetr-sam2', fallbackReason: '显存不足，已回退基础检测',
  generation: { sourceWidth: 8000, sourceHeight: 6000, workWidth: 4000, workHeight: 3000, fullFrame: false, sourceCoverage: .25, requiresManualCrop: true, exceedsWorkTileEdge: false, reason: '多人靠近画面边缘' },
});
assert.equal(metrics.width, 4000); assert.equal(metrics.height, 3000); assert.equal(metrics.sourceWidth, 8000); assert.equal(metrics.sourceHeight, 6000);
assert.equal(metrics.areaRatio, .25); assert.equal(metrics.fullFrame, false); assert.equal(metrics.requiresManualCrop, true); assert.equal(metrics.exceedsWorkTileEdge, false); assert.equal(metrics.backend, '增强'); assert.equal(metrics.detector, 'rtmdet-pairdetr-sam2'); assert.equal(metrics.fallbackReason, '显存不足，已回退基础检测'); assert.equal(metrics.reason, '多人靠近画面边缘');
const legacyTopLevelMetrics = workingImageMetrics({ workWidth: 5000, workHeight: 2500, sourceWidth: 5000, sourceHeight: 5000, fullFrame: true, sourceCoverage: .5, requiresManualCrop: false, exceedsWorkTileEdge: true, detector: 'rtmdet-ins-m', reason: 'legacy top-level' });
assert.equal(legacyTopLevelMetrics.areaRatio, .5); assert.equal(legacyTopLevelMetrics.fullFrame, true); assert.equal(legacyTopLevelMetrics.over4000, true); assert.equal(legacyTopLevelMetrics.backend, '基础'); assert.equal(legacyTopLevelMetrics.reason, 'legacy top-level');

const audit = mergeAudit({ ...generatedWorkspace, assignments: [{ ...confirmedWorkspace.assignments[0], completed: false }] });
assert.equal(audit.ready, false);
assert.equal(audit.blockers.find(item => item.code === 'incomplete-task').count, 1);
assert.equal(workflowLayoutMode(620), 'compact-menu');
assert.equal(workflowLayoutMode(900), 'scrollable-steps');
assert.equal(workflowLayoutMode(1400), 'full-steps');

console.log('Team-retouch interaction model tests passed');
