import { scheduleWorkflowWeeks, type WorkflowScheduleEntry } from './workflow-schedule.ts';

export type Json = Record<string, any>;
export type Tab = 'detect' | 'people' | 'workflow' | 'returns' | 'merge' | 'settings';
export type Crop = { x: number; y: number; width: number; height: number };

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
  const x = Math.max(0, Math.min(bounds.width - 1, Math.round(crop.x)));
  const y = Math.max(0, Math.min(bounds.height - 1, Math.round(crop.y)));
  return { x, y, width: Math.max(1, Math.min(bounds.width - x, Math.round(crop.width))), height: Math.max(1, Math.min(bounds.height - y, Math.round(crop.height))) };
};

export const returnReviewItems = (review: Json | undefined) => review?.items || review?.matches || review?.returns || [];
