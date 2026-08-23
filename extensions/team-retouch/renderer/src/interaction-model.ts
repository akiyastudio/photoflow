import { scheduleWorkflowWeeks, type WorkflowScheduleEntry } from './workflow-schedule.ts';

export type Json = Record<string, any>;
export type Tab = 'detect' | 'people' | 'workflow' | 'returns' | 'merge' | 'settings';
export type Crop = { x: number; y: number; width: number; height: number };
export type CropHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type CompareMode = 'side-by-side' | 'overlay' | 'blink' | 'difference' | 'split';

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
