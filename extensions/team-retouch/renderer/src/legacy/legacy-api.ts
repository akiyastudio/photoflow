import { rpc, type ComponentContext } from '../sdk.ts';

type Json = Record<string, any>;
type MediaKind = 'original' | 'working' | 'returned' | 'review-return';
export type LegacyMediaReference =
  | { kind: 'original'; photoId: string; baseVersionId: string }
  | { kind: 'working' | 'returned'; photoId: string; baseVersionId: string; taskId: string }
  | { kind: 'review-return'; reviewSessionId: string; returnId: string };
const projectEntryPaths = new Map<string, string>();
const mediaAliases = new Map<string, string>();
const normalizedRelativePath = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
const mediaRef = (kind: MediaKind, photoId = '', baseVersionId = '', taskId = '', reviewSessionId = '', returnId = '') =>
  ['photoflow-ref', kind, photoId, baseVersionId, taskId, reviewSessionId, returnId].map((part, index) => index < 2 ? part : encodeURIComponent(part)).join(':');
export const parseLegacyMediaRef = (value = ''): LegacyMediaReference | undefined => {
  const parts = String(value).split(':');
  if (parts.length !== 7 || parts[0] !== 'photoflow-ref') return undefined;
  const kind = parts[1] as MediaKind;
  if (!['original', 'working', 'returned', 'review-return'].includes(kind)) return undefined;
  let photoId: string; let baseVersionId: string; let taskId: string; let reviewSessionId: string; let returnId: string;
  try { [photoId, baseVersionId, taskId, reviewSessionId, returnId] = parts.slice(2).map(part => decodeURIComponent(part)); } catch { return undefined; }
  if (kind === 'original') return photoId && baseVersionId && !taskId && !reviewSessionId && !returnId ? { kind, photoId, baseVersionId } : undefined;
  if (kind === 'working' || kind === 'returned') return photoId && baseVersionId && taskId && !reviewSessionId && !returnId ? { kind, photoId, baseVersionId, taskId } : undefined;
  return !photoId && !baseVersionId && !taskId && reviewSessionId && returnId ? { kind, reviewSessionId, returnId } : undefined;
};
const hydrateTask = (task: Json, photoId: string, baseVersionId: string) => ({
  ...task,
  patchPath: mediaRef('working', photoId, baseVersionId, String(task.id || '')),
  ...(task.editedPatchPath || ['uploaded', 'merged'].includes(String(task.status || '')) ? { editedPatchPath: mediaRef('returned', photoId, baseVersionId, String(task.id || '')) } : {}),
});
const hydrateBundle = (bundle: Json) => {
  const photoId = String(bundle.photo?.id || bundle.photoId || '');
  const baseVersionId = String(bundle.photo?.currentVersionId || bundle.baseVersionId || bundle.versions?.[0]?.id || '');
  return {
    ...bundle,
    photo: bundle.photo ? { ...bundle.photo, originalFilePath: mediaRef('original', photoId, baseVersionId) } : bundle.photo,
    versions: (bundle.versions || []).map((version: Json) => ({ ...version, filePath: mediaRef('original', photoId, String(version.id || baseVersionId)) })),
    tasks: (bundle.tasks || []).map((task: Json) => hydrateTask(task, photoId || String(task.photoId || ''), String(task.baseVersionId || baseVersionId))),
  };
};
const hydrateWorkspace = (workspace: Json) => {
  const photos = (workspace.photos || []).map((photo: Json) => {
    const reference = mediaRef('original', String(photo.photoId), String(photo.baseVersionId));
    const sourcePath = projectEntryPaths.get(normalizedRelativePath(String(photo.relativePath || ''))) || reference;
    mediaAliases.set(sourcePath, reference);
    return { ...photo, sourcePath, tasks: (photo.tasks || []).map((task: Json) => hydrateTask(task, String(photo.photoId), String(photo.baseVersionId))) };
  });
  const assignments = (workspace.assignments || []).map((assignment: Json) => {
    const photo = photos.find((item: Json) => String(item.photoId) === String(assignment.photoId) && String(item.baseVersionId) === String(assignment.baseVersionId));
    const task = photo?.tasks?.find((item: Json) => (item.members?.length ? item.members : [{ personIndex: item.personIndex }]).some((member: Json) => Number(member.personIndex) === Number(assignment.personIndex)));
    return { ...assignment, ...(assignment.completed && assignment.completionKind === 'returned' && task ? { editedPatchPath: mediaRef('returned', String(assignment.photoId), String(assignment.baseVersionId), String(task.id)) } : {}) };
  });
  return { ...workspace, photos, assignments };
};
const hydrateReviewResult = (result: Json) => {
  const reviewSessionId = String(result.reviewSessionId || result.id || '');
  const matches = (result.matches || []).map((match: Json) => {
    const candidateRef = (candidate: Json) => ({ ...candidate, patchPath: candidate.taskId ? mediaRef('working', String(candidate.photoId || ''), String(candidate.baseVersionId || ''), String(candidate.taskId)) : undefined });
    return { ...candidateRef(match), mediaPath: mediaRef('review-return', '', '', '', reviewSessionId, String(match.returnId || '')), alternatives: (match.alternatives || []).map(candidateRef) };
  });
  return { ...result, matches };
};
const payload = (args: any[]) => { for (let index = args.length - 1; index >= 0; index -= 1) { const value = args[index]; if (value && typeof value === 'object' && !Array.isArray(value)) return value; } return {}; };
const ok = async (method: string, value?: Json) => rpc<Json>(method, value);
const event = (topic: string, callback: (value: any) => void) => window.photoFlowComponent.onEvent(topic, callback);

export const legacyApi = {
  getTeamPatches: async (...args: any[]) => hydrateBundle(await ok('team.patch.get.v1', { relativePath: String(args[3] || '') })),
  getTeamProjectWorkspace: async () => hydrateWorkspace(await ok('team.project.get.v1')),
  detectTeamPatchPeople: async (...args: any[]) => hydrateBundle(await ok('team.patch.detect.v1', payload(args))),
  detectTeamPatchBatch: (...args: any[]) => ok('team.patch.detect-batch.v1', payload(args)),
  updateTeamPatch: async (...args: any[]) => hydrateBundle(await ok('team.patch.update.v1', payload(args))),
  deleteTeamPatch: async (...args: any[]) => hydrateBundle(await ok('team.patch.delete.v1', payload(args))),
  removeProjectTeamPhoto: (...args: any[]) => ok('team.project.remove-photo.v1', payload(args)),
  excludeTeamPerson: async (...args: any[]) => hydrateWorkspace(await ok('team.person.exclude.v1', payload(args))),
  saveTeamIdentity: async (...args: any[]) => hydrateWorkspace(await ok('team.identity.save.v1', payload(args))),
  assignTeamIdentity: async (...args: any[]) => hydrateWorkspace(await ok('team.identity.assign.v1', payload(args))),
  confirmTeamIdentityGroup: async (...args: any[]) => hydrateWorkspace(await ok('team.identity.confirm-group.v1', payload(args))),
  deleteTeamIdentity: async (...args: any[]) => hydrateWorkspace(await ok('team.identity.delete.v1', payload(args))),
  suggestTeamIdentities: async () => hydrateWorkspace(await ok('team.identity.suggest.v1')),
  getTeamIdentitySimilarities: () => ok('team.identity.similarities.v1'),
  completeTeamIdentity: (...args: any[]) => ok('team.identity.complete.v1', payload(args)),
  uploadTeamPatch: (...args: any[]) => ok('team.patch.upload.v1', payload(args)),
  removeTeamPatchUpload: (...args: any[]) => ok('team.patch.remove-upload.v1', payload(args)),
  mergeTeamPatches: (...args: any[]) => ok('team.patch.merge.v1', payload(args)),
  saveTeamWorkflowSettings: (...args: any[]) => ok('team.workflow.settings.save.v1', payload(args)),
  getTeamWorkflowGenerationStatus: () => ok('team.workflow.status.v1'),
  generateTeamWorkflow: (...args: any[]) => ok('team.workflow.generate.v1', payload(args)),
  cancelTeamWorkflowGeneration: (operationId: string) => ok('team.workflow.cancel.v1', { operationId }),
  exportTeamIdentityTasks: (...args: any[]) => ok('team.workflow.open-export.v1', payload(args)),
  openTeamPatchFolder: async () => ({ success: true }),
  selectTeamPatchReturns: () => ok('team.patch.select-returns.v1'),
  returnTeamWorkflowBatch: async (...args: any[]) => hydrateReviewResult(await ok('team.workflow.return-batch.v1', payload(args))),
  getTeamWorkflowReturnReview: async () => { const result = await ok('team.workflow.return-review.get.v1'); return { ...result, review: result.review ? hydrateReviewResult(result.review) : result.review }; },
  discardTeamWorkflowReturnReview: (...args: any[]) => ok('team.workflow.return-review.discard.v1', { reviewSessionId: String(args[2] || '') }),
  ignoreTeamWorkflowReturnReview: (...args: any[]) => ok('team.workflow.return-review.ignore.v1', { reviewSessionId: String(args[2] || ''), returnId: String(args[3] || '') }),
  confirmTeamWorkflowReturn: (...args: any[]) => ok('team.workflow.return-confirm.v1', payload(args)),
  getProgressFolders: () => ok('project.progress.list.v1'),
  registerProgressWithGraph: (...args: any[]) => ok('project.progress.create.v1', payload(args)),
  openTeamPatch: async (reference: string) => { const ref = parseLegacyMediaRef(reference); return ref?.kind === 'working' ? ok('team.patch.open.v1', ref) : { success: false, error: '工作图引用已失效' }; },
  getMediaThumbnail: async (...args: any[]): Promise<Json> => { const value = String(args[0] || ''); const ref = parseLegacyMediaRef(value) || parseLegacyMediaRef(mediaAliases.get(value) || ''); if (!ref) return { success: false, state: 'MISSING', error: '预览引用尚未建立' }; const result = await ok('team.media.authorize.v1', ref); return { ...result, state: result.success === false ? 'FAILED' : 'READY', previewUrl: result.url, previewUrls: { small: result.url, medium: result.url, large: result.url } }; },
  getMediaOriginal: async (...args: any[]): Promise<Json> => { const value = String(args[0] || ''); const ref = parseLegacyMediaRef(value) || parseLegacyMediaRef(mediaAliases.get(value) || ''); if (!ref) return { success: false, error: '原图引用尚未建立' }; const result = await ok('team.media.authorize.v1', ref); return { ...result, mediaUrl: result.url, orientation: { matrix: [1, 0, 0, 1] } }; },
  onThumbnailStateChanged: (_callback: (value: any) => void) => () => undefined,
  onTeamPatchDetectionProgress: (callback: (value: any) => void) => event('patch.detect.progress', callback),
  onTeamPatchBatchProgress: (callback: (value: any) => void) => event('patch.detect-batch.progress', callback),
  onTeamPatchReturnBatchProgress: (callback: (value: any) => void) => event('patch.return-batch.progress', callback),
  onTeamWorkflowGenerationProgress: (callback: (value: any) => void) => event('workflow.progress', callback),
  getComponents: async () => { const state: Json = await ok('component.advanced.preflight.v1').catch(() => ({} as Json)); return { success: true, components: [{ id: 'team-retouch', installed: true, runtimeAvailable: true, identityAvailable: true, advancedAvailable: state.success !== false && Boolean(state.available || state.installed), advancedState: state.state, advancedError: state.error, provider: '内置人物检测' }] }; },
  getContext: (): Promise<ComponentContext> => window.photoFlowComponent.getContext(),
  setProjectEntries: (entries: Json[]) => { projectEntryPaths.clear(); for (const entry of entries || []) if (entry.relativePath && entry.path) projectEntryPaths.set(normalizedRelativePath(String(entry.relativePath)), String(entry.path)); },
};

export const legacyMediaRef = mediaRef;
