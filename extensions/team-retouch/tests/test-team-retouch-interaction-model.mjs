import assert from 'node:assert/strict';
// Plugin-owned regression test.
import { assignmentKey, beginWorkflowReturnProgress, canEnterWorkflowStage, clampCrop, clampZoom, expandCrop, fitCropToMembers, isIdentityConfirmed, isPhotoMergeComplete, latestWorkflowStage, mergeAudit, normalizeRotation, normalizeWorkspace, progressCandidates, rankIdentityCandidates, relayChainForItems, resizeCrop, returnCandidates, returnMatchAssessment, returnModificationAssessment, returnReviewItems, shouldBlink, subjectsFromWorkspace, updateWorkflowReturnProgress, workflowGroups, workflowLayoutMode, workflowStageSummaries, workingImageMetrics } from '../renderer/src/interaction-model.ts';

const workspace = {
  identities: [{ id: 'alice', name: 'Alice' }, { id: 'pending', name: '待确认人物 2' }],
  assignments: [
    { photoId: 'p1', baseVersionId: 'v1', personIndex: 1, identityId: 'alice', completed: false },
    { photoId: 'p1', baseVersionId: 'v1', personIndex: 2, identityId: 'pending', completed: false },
  ],
  photos: [{ photoId: 'p1', baseVersionId: 'v1', name: 'group.jpg', tasks: [{ id: 'task', crop: { x: 0, y: 0, width: 100, height: 80 }, members: [{ personIndex: 1, bbox: { x: 1, y: 2, width: 20, height: 30 } }, { personIndex: 2, bbox: { x: 30, y: 2, width: 20, height: 30 } }] }] }],
};

assert.equal(assignmentKey('p1', 'v1', 2), 'p1:v1:2');
const selectingReturns = beginWorkflowReturnProgress('return-operation-1');
assert.deepEqual({ active: selectingReturns.active, phase: selectingReturns.phase, progress: selectingReturns.progress }, { active: true, phase: 'selecting', progress: 0 });
const matchingReturns = updateWorkflowReturnProgress(selectingReturns, { operationId: 'return-operation-1', phase: 'matching', progress: 63, message: '比对图片 2/4' });
assert.deepEqual({ active: matchingReturns.active, phase: matchingReturns.phase, progress: matchingReturns.progress, message: matchingReturns.message }, { active: true, phase: 'matching', progress: 63, message: '比对图片 2/4' }, 'return progress keeps the real matching phase visible');
assert.equal(updateWorkflowReturnProgress(matchingReturns, { operationId: 'stale-operation', phase: 'matching', progress: 99 }).progress, 63, 'a stale return operation cannot overwrite the active batch');
assert.equal(updateWorkflowReturnProgress(matchingReturns, { operationId: 'return-operation-1', phase: 'reading', progress: 12 }).progress, 63, 'out-of-order events cannot move return progress backwards');
assert.equal(updateWorkflowReturnProgress(matchingReturns, { operationId: 'return-operation-1', state: 'completed', phase: 'complete', progress: 100 }).active, false, 'completed return progress collapses');
assert.equal(updateWorkflowReturnProgress(matchingReturns, { operationId: 'return-operation-1', state: 'failed', phase: 'failed' }).active, false, 'failed return progress collapses');
assert.equal(updateWorkflowReturnProgress(matchingReturns, { operationId: 'return-operation-1', state: 'cancelled', phase: 'cancelled' }).active, false, 'cancelled return progress collapses');
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
  { id: 'source', mediaKind: 'image', nodeRole: 'progress', contentRef: { relativeDirectory: 'C:/project/raw' } },
  { id: 'target', mediaKind: 'image', nodeRole: 'progress', contentRef: { relativeDirectory: 'C:/project/output' } },
  { id: 'missing', mediaKind: 'image', nodeRole: 'progress', folderMissing: true },
  { id: 'aux', mediaKind: 'image', nodeRole: 'progress', relationKind: 'auxiliary' },
] }, ['C:/project/raw/a.jpg']);
assert.deepEqual(candidates.map(item => item.id), ['target'], 'merge target choices must reject source, missing, and auxiliary progress nodes');

assert.deepEqual(returnReviewItems({ matches: [{ returnId: 'r1' }] }), [{ returnId: 'r1' }]);
assert.deepEqual(returnReviewItems(undefined), []);

const currentWorkspace = normalizeWorkspace({ photos: [{ photoId: 'current', baseVersionId: 'v0', tasks: [{ id: 'task', members: [{ personIndex: 1 }] }] }] });
assert.deepEqual(currentWorkspace.identities, []);
assert.deepEqual(currentWorkspace.assignments, []);
assert.equal(currentWorkspace.photos[0].tasks[0].members[0].personIndex, 1);
assert.equal(isIdentityConfirmed({ identityId: 'alice', source: 'suggested', identityConfirmed: true }, { id: 'alice', name: 'Alice' }), true, 'current explicit confirmation enables the identity');
assert.equal(isIdentityConfirmed({ identityId: 'alice', source: 'suggested', identityConfirmed: false }, { id: 'alice', name: 'Alice' }), false, 'an explicit rejection still overrides the automatic default');
assert.equal(isIdentityConfirmed({ identityId: 'alice', source: 'manual-group' }, { id: 'alice', name: 'Alice' }), false, 'source labels do not substitute for current confirmation state');

const guardedWorkspace = {
  photos: [{ photoId: 'p1', baseVersionId: 'v1', tasks: [{ id: 't1', personIndex: 1, members: [{ personIndex: 1, bbox: { x: 0, y: 0, width: 10, height: 10 } }], bbox: { x: 0, y: 0, width: 10, height: 10 }, crop: { x: 0, y: 0, width: 20, height: 20 } }] }],
  identities: [{ id: 'alice', name: 'Alice' }], assignments: [],
};
assert.equal(canEnterWorkflowStage(guardedWorkspace, 'assignment').allowed, false, 'stage 2 must be guarded until every person has an accepted identity');
assert.equal(latestWorkflowStage(guardedWorkspace), 'detect');
const confirmedWorkspace = { ...guardedWorkspace, assignments: [{ photoId: 'p1', baseVersionId: 'v1', personIndex: 1, identityId: 'alice', identityConfirmed: true, source: 'manual' }] };
assert.equal(canEnterWorkflowStage(confirmedWorkspace, 'assignment').allowed, true);
assert.equal(latestWorkflowStage(confirmedWorkspace), 'assignment');
const automaticallyAcceptedWorkspace = { ...guardedWorkspace, assignments: [{ photoId: 'p1', baseVersionId: 'v1', personIndex: 1, identityId: 'alice', identityConfirmed: true, source: 'suggested', completed: true, completionKind: 'no-retouch' }] };
assert.equal(canEnterWorkflowStage(automaticallyAcceptedWorkspace, 'assignment').allowed, true, 'automatic candidates satisfy identity assignment without a confirmation click');
assert.equal(mergeAudit(automaticallyAcceptedWorkspace).ready, true, 'automatic candidates must not create a final merge blocker');
assert.equal(canEnterWorkflowStage(confirmedWorkspace, 'relay').allowed, false, 'stage 3 must wait for generated assignment workflow');
const generatedWorkspace = { ...confirmedWorkspace, workflowGenerated: true, workflowNeedsRegeneration: false, workflowParticipantKeys: ['p1:v1:1'] };
assert.equal(canEnterWorkflowStage(generatedWorkspace, 'relay').allowed, true);
assert.equal(latestWorkflowStage(generatedWorkspace), 'relay');
const workflowAwaitingRegeneration = { ...generatedWorkspace, workflowNeedsRegeneration: true };
assert.equal(canEnterWorkflowStage(workflowAwaitingRegeneration, 'assignment').allowed, true, 'stage 2 remains available so a changed historical workflow can be regenerated');
assert.equal(canEnterWorkflowStage(workflowAwaitingRegeneration, 'relay').allowed, true, 'an existing relay remains inspectable while its changed schedule awaits regeneration');
assert.equal(workflowStageSummaries(workflowAwaitingRegeneration, 'detect').find(item => item.id === 'relay').count, '0/1 已完成 · 0 已返图');
assert.equal(canEnterWorkflowStage(generatedWorkspace, 'review').allowed, false, 'stage 4 must wait until every relay task is complete');
assert.match(canEnterWorkflowStage(generatedWorkspace, 'review').reason, /1 个接力任务未完成/);
const returnedWorkspace = { ...generatedWorkspace, assignments: [{ ...confirmedWorkspace.assignments[0], completed: true, completionKind: 'returned' }] };
assert.equal(canEnterWorkflowStage(returnedWorkspace, 'review').allowed, true, 'stage 4 unlocks after relay completion');
assert.equal(latestWorkflowStage(returnedWorkspace), 'review');
assert.equal(latestWorkflowStage({ ...generatedWorkspace, photos: generatedWorkspace.photos.map(photo => ({ ...photo, tasks: photo.tasks.map(task => ({ ...task, status: 'merged', mergedVersionId: 'output-v1' })) })) }), 'review', 'any existing output resumes directly on the review/output page');
const historicalMixedMerge = {
  photos: [{ photoId: 'mixed', baseVersionId: 'mixed-base', tasks: [{ id: 'returned-task', personIndex: 1, status: 'merged', mergedVersionId: 'output-v1' }, { id: 'no-retouch-task', personIndex: 2, status: 'exported' }] }],
  assignments: [{ photoId: 'mixed', baseVersionId: 'mixed-base', personIndex: 1, completed: true, completionKind: 'returned' }, { photoId: 'mixed', baseVersionId: 'mixed-base', personIndex: 2, completed: true, completionKind: 'no-retouch' }],
};
assert.equal(isPhotoMergeComplete(historicalMixedMerge, historicalMixedMerge.photos[0]), true, 'an existing merged photo stays complete when its artifact-free task was explicitly marked no-retouch');
assert.equal(mergeAudit(historicalMixedMerge).completedPhotoCount, 1, 'historical mixed return/no-retouch photos must not remain in the pending merge count');
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
const completedBlockedRelay = relayChainForItems([{ key: 'a', week: 1, identity: { name: 'A' }, ready: false, blockedBy: ['协作流程重新生成'], assignment: { completed: true, completionKind: 'no-retouch' } }]);
assert.equal(completedBlockedRelay[1].state, 'done');
assert.equal(completedBlockedRelay[1].reason, undefined, 'a completed no-retouch node must render the done-state fallback instead of a stale waiting reason');

const unknownEdit = returnModificationAssessment({});
assert.equal(unknownEdit.known, false); assert.equal(unknownEdit.suspicious, false); assert.equal(unknownEdit.label, '修改有效性待人工查看');
assert.equal(returnModificationAssessment({ editEvidence: { changedFraction: .01 } }).suspicious, true, 'near-identical returns must warn as potentially unmodified');
assert.equal(returnModificationAssessment({ editEvidence: { changedFraction: .4 } }).suspicious, false);
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
  detector: 'rtmdet-pairdetr-sam2',
  generation: { sourceWidth: 8000, sourceHeight: 6000, workWidth: 4000, workHeight: 3000, fullFrame: false, sourceCoverage: .25, requiresManualCrop: true, exceedsWorkTileEdge: false, reason: '多人靠近画面边缘', fallbackReason: '显存不足，已回退基础检测' },
});
assert.equal(metrics.width, 4000); assert.equal(metrics.height, 3000); assert.equal(metrics.sourceWidth, 8000); assert.equal(metrics.sourceHeight, 6000);
assert.equal(metrics.areaRatio, .25); assert.equal(metrics.fullFrame, false); assert.equal(metrics.requiresManualCrop, true); assert.equal(metrics.exceedsWorkTileEdge, false); assert.equal(metrics.backend, '增强'); assert.equal(metrics.detector, 'rtmdet-pairdetr-sam2'); assert.equal(metrics.fallbackReason, '显存不足，已回退基础检测'); assert.equal(metrics.reason, '多人靠近画面边缘');
const rejectedTopLevelMetrics = workingImageMetrics({ workWidth: 5000, fullFrame: true, sourceCoverage: .5, detector: 'rtmdet-ins-m' });
assert.equal(rejectedTopLevelMetrics.width, 0); assert.equal(rejectedTopLevelMetrics.fullFrame, undefined); assert.equal(rejectedTopLevelMetrics.backend, '基础');

const audit = mergeAudit({ ...generatedWorkspace, assignments: [{ ...confirmedWorkspace.assignments[0], completed: false }] });
assert.equal(audit.ready, false);
assert.equal(audit.blockers.find(item => item.code === 'incomplete-task').count, 1);
assert.equal(workflowLayoutMode(620), 'compact-menu');
assert.equal(workflowLayoutMode(900), 'scrollable-steps');
assert.equal(workflowLayoutMode(1400), 'full-steps');

console.log('Team-retouch interaction model tests passed');
