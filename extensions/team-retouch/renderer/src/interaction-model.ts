import { scheduleWorkflowWeeks, type WorkflowScheduleEntry } from './workflow-schedule.ts';

export type Json = Record<string, any>;
export type Tab = 'detect' | 'people' | 'workflow' | 'returns' | 'merge' | 'settings';
export type Crop = { x: number; y: number; width: number; height: number };
export type CropHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type CompareMode = 'side-by-side' | 'overlay' | 'blink' | 'difference' | 'split';
export type WorkflowStage = 'detect' | 'assignment' | 'relay' | 'review';
export type StageState = 'complete' | 'current' | 'available' | 'blocked';

export type StageSummary = {
  id: WorkflowStage;
  number: number;
  label: string;
  completion: string;
  state: StageState;
  complete: boolean;
  count: string;
  blockedReason?: string;
};

export const WORKFLOW_STAGES: ReadonlyArray<Pick<StageSummary, 'id' | 'number' | 'label' | 'completion'>> = [
  { id: 'detect', number: 1, label: '提交工作图', completion: '完成识别、裁剪并人工确认全部人物' },
  { id: 'assignment', number: 2, label: '设置任务分配', completion: '接收人和自动排期已确认，协作流程已生成' },
  { id: 'relay', number: 3, label: '分发任务与返图', completion: '全部接力任务已返图或明确标记不用修' },
  { id: 'review', number: 4, label: '审核与输出', completion: '返图审核通过且合并阻断项为零' },
];

export const normalizeWorkspace = (value: Json | undefined): Json => {
  const workspace = value && typeof value === 'object' ? value : {};
  const photos = Array.isArray(workspace.photos) ? workspace.photos.map((photo: Json) => ({
    ...photo,
    tasks: Array.isArray(photo?.tasks) ? photo.tasks.map((task: Json) => ({
      ...task,
      members: Array.isArray(task?.members) ? task.members : task?.personIndex === undefined ? [] : [{ personIndex: task.personIndex, bbox: task.bbox }],
    })) : [],
  })) : [];
  return {
    ...workspace,
    photos,
    identities: Array.isArray(workspace.identities) ? workspace.identities : [],
    assignments: Array.isArray(workspace.assignments) ? workspace.assignments : [],
    workflowSettings: workspace.workflowSettings && typeof workspace.workflowSettings === 'object' ? workspace.workflowSettings : {},
  };
};

const generatedIdentity = (identity: Json | undefined) => /^待确认人物\s+\d+$/.test(String(identity?.name || ''));
export const isIdentityConfirmed = (assignment: Json | undefined, identity: Json | undefined) => {
  if (!assignment?.identityId || !identity || generatedIdentity(identity)) return false;
  if (typeof assignment.identityConfirmed === 'boolean') return assignment.identityConfirmed;
  if (assignment.identityConfirmedAt || assignment.confirmedAt) return true;
  return ['manual', 'manual-group'].includes(String(assignment.source || ''));
};

export const workflowStageSummaries = (value: Json | undefined, active: WorkflowStage = 'detect'): StageSummary[] => {
  const workspace = normalizeWorkspace(value);
  const subjects = subjectsFromWorkspace(workspace);
  const tasks = workspace.photos.flatMap((photo: Json) => photo.tasks || []);
  const confirmed = subjects.filter((subject: Json) => isIdentityConfirmed(subject.assignment, subject.identity)).length;
  const cropReview = tasks.filter((task: Json) => Boolean(task.needsReview || task.patchMissing)).length;
  const eligible = subjects.filter((subject: Json) => isIdentityConfirmed(subject.assignment, subject.identity));
  const completed = eligible.filter((subject: Json) => Boolean(subject.assignment?.completed)).length;
  const returned = eligible.filter((subject: Json) => subject.assignment?.completionKind === 'returned' && !subject.assignment?.returnMissing).length;
  const missingReturns = eligible.filter((subject: Json) => Boolean(subject.assignment?.returnMissing)).length;
  const pendingReviews = Number(workspace.pendingReturnReviewCount ?? workspace.reviewCount ?? 0) || 0;
  const mergeBlockers = mergeAudit(workspace).blockers.length;
  const merged = workspace.photos.filter((photo: Json) => (photo.tasks || []).length && (photo.tasks || []).every((task: Json) => task.status === 'merged')).length;
  const detectComplete = Boolean(workspace.photos.length && tasks.length && subjects.length && confirmed === subjects.length && cropReview === 0);
  const assignmentComplete = Boolean(detectComplete && workspace.workflowGenerated && !workspace.workflowNeedsRegeneration);
  const relayComplete = Boolean(assignmentComplete && eligible.length && completed === eligible.length && missingReturns === 0 && pendingReviews === 0);
  const stageComplete: Record<WorkflowStage, boolean> = { detect: detectComplete, assignment: assignmentComplete, relay: relayComplete, review: Boolean(relayComplete && workspace.photos.length && merged === workspace.photos.length && mergeBlockers === 0) };
  const reasons: Record<WorkflowStage, string> = {
    detect: '',
    assignment: !workspace.photos.length ? '请先明确选择并识别工作图' : cropReview ? `还有 ${cropReview} 张工作图需要复核` : confirmed < subjects.length ? `还有 ${subjects.length - confirmed} 个人物需要人工确认` : '',
    relay: !stageComplete.detect ? '请先完成识别、裁剪和人物确认' : !stageComplete.assignment ? '请先确认接收人和排期并生成协作流程' : '',
    review: !stageComplete.detect ? '请先完成识别、裁剪和人物确认' : !stageComplete.assignment ? '请先生成协作流程' : '',
  };
  const counts: Record<WorkflowStage, string> = {
    detect: `${confirmed}/${subjects.length} 人已确认`,
    assignment: `${new Set(eligible.map((subject: Json) => subject.identity?.id).filter(Boolean)).size} 人 · ${tasks.length} 工作图`,
    relay: `${completed}/${eligible.length} 已完成 · ${returned} 已返图`,
    review: `${merged}/${workspace.photos.length} 已输出 · ${mergeBlockers} 阻断`,
  };
  return WORKFLOW_STAGES.map(stage => {
    const blockedReason = reasons[stage.id];
    return { ...stage, complete: stageComplete[stage.id], count: counts[stage.id], blockedReason: blockedReason || undefined, state: stage.id === active ? 'current' : stageComplete[stage.id] ? 'complete' : blockedReason ? 'blocked' : 'available' };
  });
};

export const canEnterWorkflowStage = (workspace: Json | undefined, stage: WorkflowStage) => {
  const summary = workflowStageSummaries(workspace, stage).find(item => item.id === stage)!;
  return { allowed: !summary.blockedReason, reason: summary.blockedReason || '' };
};

export const workflowLayoutMode = (width: number) => Number.isFinite(width) && width < 760 ? 'compact-menu' : width < 1120 ? 'scrollable-steps' : 'full-steps';

export const workingImageMetrics = (task: Json, photo: Json = {}) => {
  const generation = task?.generation && typeof task.generation === 'object' ? task.generation : {};
  const crop = task?.crop || {};
  const width = Math.max(0, Number(generation.workWidth ?? task?.workWidth ?? crop.width ?? task?.width ?? 0));
  const height = Math.max(0, Number(generation.workHeight ?? task?.workHeight ?? crop.height ?? task?.height ?? 0));
  const sourceWidth = Math.max(width, Number(generation.sourceWidth ?? task?.sourceWidth ?? photo?.width ?? 0));
  const sourceHeight = Math.max(height, Number(generation.sourceHeight ?? task?.sourceHeight ?? photo?.height ?? 0));
  const coverageValue = generation.sourceCoverage ?? task?.sourceCoverage;
  const reportedCoverage = coverageValue === undefined || coverageValue === null || coverageValue === '' ? Number.NaN : Number(coverageValue);
  const areaRatio = Number.isFinite(reportedCoverage) ? Math.max(0, Math.min(1, reportedCoverage)) : sourceWidth && sourceHeight ? Math.min(1, width * height / (sourceWidth * sourceHeight)) : undefined;
  const fullFrameValue = generation.fullFrame ?? task?.fullFrame;
  const fullFrame = typeof fullFrameValue === 'boolean' ? fullFrameValue : undefined;
  const manualCropValue = generation.requiresManualCrop ?? task?.requiresManualCrop;
  const requiresManualCrop = typeof manualCropValue === 'boolean' ? manualCropValue : undefined;
  const exceedsValue = generation.exceedsWorkTileEdge ?? task?.exceedsWorkTileEdge;
  const exceedsWorkTileEdge = typeof exceedsValue === 'boolean' ? exceedsValue : width && height ? width > 4000 || height > 4000 : undefined;
  const detector = String(task?.detector || task?.detectionBackend || task?.backend || task?.engine || '');
  const backend = detector === 'rtmdet-pairdetr-sam2' || /advanced|pairdetr|sam2/i.test(detector) ? '增强' : detector === 'rtmdet-ins-m' || /basic|ins-m/i.test(detector) ? '基础' : '未知';
  const fallbackReason = String(task?.fallbackReason || task?.backendFallbackReason || task?.detectionFallbackReason || '');
  const reason = String(generation.reason || task?.reason || '');
  return { width, height, sourceWidth, sourceHeight, areaRatio, entire: fullFrame === true, fullFrame, requiresManualCrop, over4000: exceedsWorkTileEdge === true, exceedsWorkTileEdge, backend, detector, fallbackReason, reason };
};

export type RelayNode = { key: string; label: string; kind: 'source' | 'return' | 'holder' | 'waiting'; state: 'done' | 'current' | 'waiting' | 'warning'; reason?: string };
export const relayChainForItems = (items: Json[]) => {
  const ordered = [...items].sort((left, right) => Number(left.week || 0) - Number(right.week || 0) || Number(left.personIndex || 0) - Number(right.personIndex || 0));
  const nodes: RelayNode[] = [{ key: 'source', label: '原始裁图', kind: 'source', state: 'done' }];
  let predecessorReady = true;
  for (const item of ordered) {
    const name = String(item.identity?.name || item.personName || `人物 ${item.personIndex || ''}`).trim();
    const assignment = item.assignment || {};
    const returned = assignment.completionKind === 'returned' && !assignment.returnMissing;
    const skipped = Boolean(assignment.completed) && assignment.completionKind !== 'returned';
    const ready = predecessorReady && item.ready !== false;
    const reason = assignment.returnMissing ? '返图文件缺失' : returned ? '' : ready ? `当前持有人：${name}` : `等待 ${item.blockedBy?.join('、') || '上一位返图'}`;
    nodes.push({ key: String(item.key || `${item.task?.id || item.taskId}:${item.personIndex}`), label: returned ? `${name} 返图` : skipped ? `${name} · 不用修` : name, kind: returned ? 'return' : ready ? 'holder' : 'waiting', state: assignment.returnMissing ? 'warning' : returned || skipped ? 'done' : ready ? 'current' : 'waiting', reason: reason || undefined });
    predecessorReady = predecessorReady && Boolean(assignment.completed) && !assignment.returnMissing;
  }
  return nodes;
};

export const returnModificationAssessment = (match: Json) => {
  const evidence = match.editEvidence && typeof match.editEvidence === 'object' ? match.editEvidence : {};
  const warnings = Array.isArray(match.returnWarnings) ? match.returnWarnings.filter(Boolean) : match.returnWarnings ? [match.returnWarnings] : [];
  const finiteMetric = (value: unknown) => value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value);
  const changedFraction = finiteMetric(evidence.changedFraction);
  const meanAbsoluteDifference = finiteMetric(evidence.meanAbsoluteDifference);
  const score = changedFraction ?? finiteMetric(match.modificationScore ?? match.changeScore ?? match.editScore);
  const unchangedProbability = Number(match.unchangedProbability ?? match.sameImageProbability);
  const explicitlyUnchanged = evidence.reallyModified === false || match.modified === false || match.isModified === false || match.unchanged === true;
  const evidenceWarning = evidence.exactSame === true || evidence.nearUnchanged === true || evidence.mistakenFullOriginal === true || evidence.abnormalDimensions === true;
  const suspicious = Boolean(warnings.length || explicitlyUnchanged || evidenceWarning || score !== undefined && score < .03 || Number.isFinite(unchangedProbability) && unchangedProbability >= .85);
  const known = Boolean(Object.keys(evidence).length || warnings.length || explicitlyUnchanged || score !== undefined || Number.isFinite(unchangedProbability) || typeof match.modified === 'boolean' || typeof match.isModified === 'boolean');
  return { known, suspicious, label: !known ? '修改有效性待人工查看' : suspicious ? '返图疑似未修改 / 需人工核对' : '检测到有效修改', score, changedFraction, meanAbsoluteDifference, warnings, evidence };
};

export const returnMatchAssessment = (match: Json) => {
  const scoreValue = match.score ?? match.matchScore;
  const numericScore = scoreValue === undefined || scoreValue === null || scoreValue === '' ? Number.NaN : Number(scoreValue);
  const score = Number.isFinite(numericScore) ? numericScore : undefined;
  const confidence = ['high', 'medium', 'low', 'unknown', 'review'].includes(String(match.matchConfidence)) ? String(match.matchConfidence) : '';
  const labels: Record<string, string> = { high: '任务匹配度高', medium: '任务匹配度中', low: '任务匹配度低', unknown: '任务匹配度未知', review: '任务匹配需人工确认' };
  if (confidence) return { score, confidence, label: labels[confidence], needsManualMatch: !match.taskId || ['low', 'unknown', 'review'].includes(confidence) };
  return { score, confidence: '', label: score === undefined ? '任务匹配度未知' : score >= .85 ? '任务匹配度高' : score >= .6 ? '任务匹配度中' : '任务匹配度低', needsManualMatch: !match.taskId || score === undefined || score < .6 };
};

export const mergeAudit = (value: Json | undefined) => {
  const workspace = normalizeWorkspace(value);
  const subjects = subjectsFromWorkspace(workspace);
  const blockers: Array<{ code: string; label: string; count: number }> = [];
  const unconfirmed = subjects.filter((subject: Json) => !isIdentityConfirmed(subject.assignment, subject.identity)).length;
  const incomplete = subjects.filter((subject: Json) => isIdentityConfirmed(subject.assignment, subject.identity) && !subject.assignment?.completed).length;
  const missing = subjects.filter((subject: Json) => Boolean(subject.assignment?.returnMissing)).length;
  const cropReview = workspace.photos.flatMap((photo: Json) => photo.tasks || []).filter((task: Json) => Boolean(task.needsReview || task.patchMissing)).length;
  const pendingReview = Number(workspace.pendingReturnReviewCount ?? workspace.reviewCount ?? 0) || 0;
  if (unconfirmed) blockers.push({ code: 'unconfirmed-identity', label: '人物未确认', count: unconfirmed });
  if (cropReview) blockers.push({ code: 'crop-review', label: '工作图待复核', count: cropReview });
  if (incomplete) blockers.push({ code: 'incomplete-task', label: '任务未完成', count: incomplete });
  if (missing) blockers.push({ code: 'missing-return', label: '返图缺失', count: missing });
  if (pendingReview) blockers.push({ code: 'pending-return-review', label: '返图待审核', count: pendingReview });
  return { blockers, ready: blockers.length === 0, photoCount: workspace.photos.length, completedPhotoCount: workspace.photos.filter((photo: Json) => (photo.tasks || []).length && (photo.tasks || []).every((task: Json) => task.status === 'merged')).length };
};

export const assignmentKey = (photoId: unknown, baseVersionId: unknown, personIndex: unknown) =>
  `${String(photoId || '')}:${String(baseVersionId || '')}:${Number(personIndex || 0)}`;

export const taskMembers = (task: Json) => Array.isArray(task.members) && task.members.length
  ? task.members
  : [{ personIndex: task.personIndex, bbox: task.bbox }];

export const subjectsFromWorkspace = (workspace: Json): Json[] => {
  const identities = new Map((workspace.identities || []).map((identity: Json) => [String(identity.id), identity]));
  const assignments = new Map((workspace.assignments || []).map((assignment: Json) => [assignmentKey(assignment.photoId, assignment.baseVersionId, assignment.personIndex), assignment]));
  return (workspace.photos || []).flatMap((photo: Json) => (photo.tasks || []).flatMap((task: Json) => taskMembers(task).map((member: Json) => {
    const key = assignmentKey(photo.photoId, photo.baseVersionId, member.personIndex);
    const assignment = assignments.get(key) as Json | undefined;
    return { key, photo, task, personIndex: Number(member.personIndex), bbox: member.bbox || task.bbox, assignment, identity: assignment?.identityId ? identities.get(String(assignment.identityId)) : undefined };
  })));
};

export const workflowGroups = (workspace: Json, preferredIdentityOrder: string[], manualWeeks: Record<string, number> = {}) => {
  const identities = new Map((workspace.identities || []).map((identity: Json) => [String(identity.id), identity]));
  const entries: Array<WorkflowScheduleEntry & Json> = subjectsFromWorkspace(workspace).flatMap((subject: Json) => {
    const identity = subject.assignment?.identityId ? identities.get(String(subject.assignment.identityId)) as Json | undefined : undefined;
    if (!identity || /^待确认人物\s+\d+$/.test(String(identity.name || ''))) return [];
    return [{ key: subject.key, taskId: String(subject.task.id), personIndex: subject.personIndex, identityId: String(identity.id), identityName: String(identity.name), photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, photoName: subject.photo.name || subject.photo.displayName || subject.photo.photoId }];
  });
  const scheduled = scheduleWorkflowWeeks(entries, { preferredIdentityOrder });
  const groups = new Map<string, Json>();
  for (const entry of entries) {
    const week = Math.max(1, Number(manualWeeks[String(entry.identityId)] || scheduled.get(entry.key) || 1));
    const key = `${week}:${entry.identityId}`;
    const group = groups.get(key) || { week, identityId: entry.identityId, identityName: entry.identityName, items: [] };
    group.items.push({ photoId: entry.photoId, baseVersionId: entry.baseVersionId, personIndex: entry.personIndex, taskId: entry.taskId, photoName: entry.photoName });
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.week - right.week || String(left.identityName).localeCompare(String(right.identityName), 'zh-CN'));
};

export const progressCandidates = (result: Json, sourcePaths: string[] = []) => {
  const normalizedSources = sourcePaths.map(value => value.replace(/\\/g, '/').toLocaleLowerCase());
  return (result.progressFolders || []).filter((folder: Json) => folder.mediaKind === 'image' && !folder.folderMissing && folder.nodeRole === 'progress' && folder.relationKind !== 'auxiliary' && !normalizedSources.some(source => {
    const folderPath = String(folder.folderPath || '').replace(/\\/g, '/').toLocaleLowerCase();
    return source === folderPath || source.startsWith(`${folderPath}/`);
  }));
};

export const clampCrop = (crop: Crop, bounds: { width: number; height: number }): Crop => {
  const width = Math.max(1, Number.isFinite(bounds.width) ? Math.round(bounds.width) : 1);
  const height = Math.max(1, Number.isFinite(bounds.height) ? Math.round(bounds.height) : 1);
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  const x = Math.max(0, Math.min(width - 1, Math.round(finite(crop.x, 0))));
  const y = Math.max(0, Math.min(height - 1, Math.round(finite(crop.y, 0))));
  return { x, y, width: Math.max(1, Math.min(width - x, Math.round(finite(crop.width, 1)))), height: Math.max(1, Math.min(height - y, Math.round(finite(crop.height, 1)))) };
};

export const resizeCrop = (start: Crop, handle: CropHandle, dx: number, dy: number, bounds: { width: number; height: number }): Crop => {
  if (handle === 'move') return clampCrop({ ...start, x: Math.max(0, Math.min(bounds.width - start.width, start.x + dx)), y: Math.max(0, Math.min(bounds.height - start.height, start.y + dy)) }, bounds);
  let left = start.x; let top = start.y; let right = start.x + start.width; let bottom = start.y + start.height;
  if (handle.includes('w')) left = Math.min(right - 1, left + dx);
  if (handle.includes('e')) right = Math.max(left + 1, right + dx);
  if (handle.includes('n')) top = Math.min(bottom - 1, top + dy);
  if (handle.includes('s')) bottom = Math.max(top + 1, bottom + dy);
  left = Math.max(0, left); top = Math.max(0, top); right = Math.min(bounds.width, right); bottom = Math.min(bounds.height, bottom);
  return clampCrop({ x: left, y: top, width: right - left, height: bottom - top }, bounds);
};

export const expandCrop = (crop: Crop, bounds: { width: number; height: number }, ratio = .1) => clampCrop({ x: crop.x - crop.width * ratio, y: crop.y - crop.height * ratio, width: crop.width * (1 + ratio * 2), height: crop.height * (1 + ratio * 2) }, bounds);

export const fitCropToMembers = (members: Json[], bounds: { width: number; height: number }, padding = .12): Crop => {
  const boxes = members.map(item => item.bbox || item).filter(box => [box?.x, box?.y, box?.width, box?.height].every(Number.isFinite) && box.width > 0 && box.height > 0);
  if (!boxes.length) return clampCrop({ x: 0, y: 0, width: bounds.width, height: bounds.height }, bounds);
  const left = Math.min(...boxes.map(box => box.x)); const top = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width)); const bottom = Math.max(...boxes.map(box => box.y + box.height));
  const padX = (right - left) * padding; const padY = (bottom - top) * padding;
  return clampCrop({ x: left - padX, y: top - padY, width: right - left + padX * 2, height: bottom - top + padY * 2 }, bounds);
};

export const rankIdentityCandidates = (subject: Json, subjects: Json[], identities: Json[], similarities: Json[]) => {
  const byKey = new Map(subjects.map(item => [item.key, item]));
  const best = new Map<string, Json>();
  for (const pair of similarities) {
    const otherKey = pair.leftKey === subject.key ? pair.rightKey : pair.rightKey === subject.key ? pair.leftKey : '';
    const other = byKey.get(otherKey) as Json | undefined;
    const identityId = String(other?.assignment?.identityId || '');
    if (!identityId) continue;
    const current = best.get(identityId);
    if (!current || Number(pair.score || 0) > Number(current.score || 0)) best.set(identityId, pair);
  }
  return identities.map((identity): Json => ({ identity, ...(best.get(String(identity.id)) || {}), confidence: Number(best.get(String(identity.id))?.score || 0) >= .72 ? '高' : Number(best.get(String(identity.id))?.score || 0) >= .5 ? '中' : '低' }))
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || String(left.identity.name).localeCompare(String(right.identity.name), 'zh-CN'));
};

export const returnCandidates = (item: Json) => {
  const seen = new Set<string>();
  return [item, ...(item.alternatives || [])].filter(candidate => {
    const key = `${candidate.photoId}:${candidate.baseVersionId}:${candidate.personIndex}:${candidate.taskId}`;
    if (!candidate.taskId || seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
};

export const clampZoom = (value: number) => Math.max(1, Math.min(5, Number.isFinite(value) ? value : 1));
export const normalizeRotation = (value: number) => ((Math.round(value / 90) * 90) % 360 + 360) % 360;
export const shouldBlink = (mode: CompareMode, active: boolean) => mode === 'blink' && active;

export const returnReviewItems = (review: Json | undefined) => review?.items || review?.matches || review?.returns || [];
