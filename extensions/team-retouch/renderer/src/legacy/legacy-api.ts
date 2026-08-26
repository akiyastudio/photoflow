import { rpc, type ComponentContext } from '../sdk.ts';
import { expireLegacyMedia, scheduleLegacyMedia } from './legacy-media-scheduler.ts';

type Json = Record<string, any>;
type MediaKind = 'original' | 'working' | 'returned' | 'review-return';
export type LegacyMediaReference =
  | { kind: 'original'; photoId: string; baseVersionId: string }
  | { kind: 'working' | 'returned'; photoId: string; baseVersionId: string; taskId: string; personIndex?: number }
  | { kind: 'review-return'; reviewSessionId: string; returnId: string };
const projectEntryPaths = new Map<string, string>();
const mediaAliases = new Map<string, string>();
let mediaAuthorizationScope = '';
let mediaAuthorizationGeneration = 0;
const normalizedRelativePath = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
const mediaRef = (kind: MediaKind, photoId = '', baseVersionId = '', taskId = '', reviewSessionId = '', returnId = '', personIndex = '') =>
  ['photoflow-ref', kind, photoId, baseVersionId, taskId, reviewSessionId, returnId, personIndex].map((part, index) => index < 2 ? part : encodeURIComponent(part)).join(':');
export const parseLegacyMediaRef = (value = ''): LegacyMediaReference | undefined => {
  const parts = String(value).split(':');
  if (![7, 8].includes(parts.length) || parts[0] !== 'photoflow-ref') return undefined;
  const kind = parts[1] as MediaKind;
  if (!['original', 'working', 'returned', 'review-return'].includes(kind)) return undefined;
  let photoId: string; let baseVersionId: string; let taskId: string; let reviewSessionId: string; let returnId: string; let personIndex: string;
  try { [photoId, baseVersionId, taskId, reviewSessionId, returnId, personIndex = ''] = parts.slice(2).map(part => decodeURIComponent(part)); } catch { return undefined; }
  if (kind === 'original') return photoId && baseVersionId && !taskId && !reviewSessionId && !returnId && !personIndex ? { kind, photoId, baseVersionId } : undefined;
  if (kind === 'working' || kind === 'returned') return photoId && baseVersionId && taskId && !reviewSessionId && !returnId && (kind === 'returned' || !personIndex) ? { kind, photoId, baseVersionId, taskId, ...(personIndex ? { personIndex: Number(personIndex) } : {}) } : undefined;
  return !photoId && !baseVersionId && !taskId && reviewSessionId && returnId && !personIndex ? { kind, reviewSessionId, returnId } : undefined;
};
const hydrateTask = (task: Json, photoId: string, baseVersionId: string) => ({
  ...task,
  patchPath: mediaRef('working', photoId, baseVersionId, String(task.id || '')),
  ...(task.editedPatchPath || ['uploaded', 'merged'].includes(String(task.status || '')) ? { editedPatchPath: mediaRef('returned', photoId, baseVersionId, String(task.id || '')) } : {}),
});
export const resolveLegacyBundleBaseVersionId = (bundle: Json, registrationBaseVersionId = '') => String(registrationBaseVersionId || bundle.baseVersionId || bundle.tasks?.find((task: Json) => task.baseVersionId)?.baseVersionId || bundle.photo?.currentVersionId || bundle.versions?.find((version: Json) => version.isCurrent)?.id || bundle.versions?.[0]?.id || '');
export const hydrateLegacyBundle = (bundle: Json, registrationBaseVersionId = '') => {
  const photoId = String(bundle.photo?.id || bundle.photoId || '');
  const baseVersionId = resolveLegacyBundleBaseVersionId(bundle, registrationBaseVersionId);
  return {
    ...bundle,
    photo: bundle.photo ? { ...bundle.photo, originalFilePath: mediaRef('original', photoId, baseVersionId) } : bundle.photo,
    versions: (bundle.versions || []).map((version: Json) => ({ ...version, filePath: mediaRef('original', photoId, String(version.id || baseVersionId)) })),
    tasks: (bundle.tasks || []).map((task: Json) => hydrateTask(task, photoId || String(task.photoId || ''), String(task.baseVersionId || baseVersionId))),
  };
};
export const hydrateLegacyWorkspace = (workspace: Json) => {
  const photos = (workspace.photos || []).map((photo: Json) => {
    const reference = mediaRef('original', String(photo.photoId), String(photo.baseVersionId));
    const sourcePath = projectEntryPaths.get(normalizedRelativePath(String(photo.relativePath || ''))) || reference;
    mediaAliases.set(sourcePath, reference);
    return { ...photo, sourcePath, tasks: (photo.tasks || []).map((task: Json) => hydrateTask(task, String(photo.photoId), String(photo.baseVersionId))) };
  });
  const assignments = (workspace.assignments || []).map((assignment: Json) => {
    const photo = photos.find((item: Json) => String(item.photoId) === String(assignment.photoId) && String(item.baseVersionId) === String(assignment.baseVersionId));
    const task = photo?.tasks?.find((item: Json) => (item.members?.length ? item.members : [{ personIndex: item.personIndex }]).some((member: Json) => Number(member.personIndex) === Number(assignment.personIndex)));
    return { ...assignment, ...(assignment.completed && assignment.completionKind === 'returned' && task ? { editedPatchPath: mediaRef('returned', String(assignment.photoId), String(assignment.baseVersionId), String(task.id), '', '', String(assignment.personIndex)) } : {}) };
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
const workspaceRevisions = new Map<string, string>();
const currentRevisionScope = () => mediaAuthorizationScope || '__default__';
const revisionMutations = new Set(['team.project.register.v1','team.project.remove-photo.v1','team.identity.save.v1','team.identity.assign.v1','team.identity.confirm-group.v1','team.identity.delete.v1','team.identity.suggest.v1','team.person.exclude.v1','team.patch.detect.v1','team.patch.detect-batch.v1','team.patch.update.v1','team.patch.delete.v1','team.patch.cleanup.v1','team.patch.upload.v1','team.patch.remove-upload.v1','team.patch.merge.v1','team.identity.complete.v1','team.workflow.settings.save.v1','team.workflow.generate.v1','team.workflow.return-batch.v1','team.workflow.return-confirm.v1','team.patch.return-batch.v1']);
const ok = async (method: string, value?: Json) => {
  const revisionScope = currentRevisionScope(); const workspaceRevision = workspaceRevisions.get(revisionScope) || '';
  const request = revisionMutations.has(method) && workspaceRevision ? { ...(value || {}), expectedRevision: value?.expectedRevision || workspaceRevision } : value;
  const result = await rpc<Json>(method, request);
  if (result?.revision) workspaceRevisions.set(revisionScope, String(result.revision));
  return result;
};
const durable = async (method: string, value: Json) => {
  const operationId = String(value.operationId || crypto.randomUUID());
  const accepted = await ok(method, { ...value, operationId, acceptOnly: true });
  if (accepted.success === false || !accepted.accepted) return accepted;
  return ok('team.operation.run.v1', { operationId });
};
const missingMediaResult = (kind: 'thumbnail' | 'original') => ({
  success: false, state: 'MISSING',
  error: kind === 'thumbnail' ? '历史预览文件缺失或引用已失效，可重新识别或关联原图' : '历史原图缺失或引用已失效，可重新关联后重试',
});
const event = (topic: string, callback: (value: any) => void) => window.photoFlowComponent.onEvent(topic, callback);
let progressQuery: { expiresAt: number; promise: Promise<Json> } | undefined;
const readProgressCached = () => {
  if (progressQuery && progressQuery.expiresAt > Date.now()) return progressQuery.promise;
  const promise = ok('team.progress.list.v1').catch(error => { progressQuery = undefined; throw error; });
  progressQuery = { expiresAt: Date.now() + 2_000, promise };
  return promise;
};
const authorizeMedia = async (ref: LegacyMediaReference, variant: 'preview' | 'original', priority: number) => {
  const scope = mediaAuthorizationScope; const generation = mediaAuthorizationGeneration;
  const result = await scheduleLegacyMedia(`${scope}:${JSON.stringify(ref)}:${variant}`, async () => {
    const value = await ok('team.media.authorize.v1', { ...ref, variant });
    if (scope !== mediaAuthorizationScope || generation !== mediaAuthorizationGeneration) return { success: false, state: 'MISSING', error: '项目已切换，旧媒体授权已失效' };
    return value;
  }, priority);
  if (scope !== mediaAuthorizationScope || generation !== mediaAuthorizationGeneration) return { success: false, state: 'MISSING', error: '项目已切换，旧媒体授权已失效' };
  return result;
};
export const componentStatusFromAdvancedPreflight = (state: Json) => {
  const advancedAvailable = state.advancedAvailable !== undefined
    ? state.advancedAvailable === true
    : state.available !== undefined ? state.available === true : state.installed === true;
  const advancedState = ['ready', 'not-installed', 'repair-needed'].includes(String(state.state || ''))
    ? state.state
    : advancedAvailable ? 'ready' : state.installed === true ? 'repair-needed' : state.installed === false ? 'not-installed' : undefined;
  return {
    id: 'team-retouch', installed: true, runtimeAvailable: true, identityAvailable: true,
    advancedAvailable, advancedState,
    advancedError: String(state.advancedError || state.error || ''), provider: '内置人物检测',
  };
};

export const legacyApi = {
  setMediaAuthorizationScope: (scope: string) => {
    const next = String(scope || '');
    if (next === mediaAuthorizationScope) return;
    mediaAuthorizationGeneration += 1; expireLegacyMedia(); mediaAliases.clear(); mediaAuthorizationScope = next;
  },
  getMediaAuthorizationScope: () => mediaAuthorizationScope,
  getTeamPatches: async (...args: any[]) => hydrateLegacyBundle(await ok('team.patch.get.v1', { relativePath: String(args[3] || '') }), String(args[4] || '')),
  getTeamProjectWorkspace: async () => hydrateLegacyWorkspace(await ok('team.project.get.v1')),
  calibrateTeamProjectWorkspace: (maxItems = 24) => ok('team.project.calibrate-step.v1', { maxItems }),
  detectTeamPatchPeople: async (...args: any[]) => hydrateLegacyBundle(await durable('team.patch.detect.v1', payload(args))),
  detectTeamPatchBatch: (...args: any[]) => durable('team.patch.detect-batch.v1', payload(args)),
  updateTeamPatch: async (...args: any[]) => hydrateLegacyBundle(await durable('team.patch.update.v1', payload(args))),
  deleteTeamPatch: async (...args: any[]) => hydrateLegacyBundle(await ok('team.patch.delete.v1', payload(args))),
  removeProjectTeamPhoto: (...args: any[]) => ok('team.project.remove-photo.v1', payload(args)),
  excludeTeamPerson: async (...args: any[]) => hydrateLegacyWorkspace(await durable('team.person.exclude.v1', payload(args))),
  saveTeamIdentity: async (...args: any[]) => hydrateLegacyWorkspace(await ok('team.identity.save.v1', payload(args))),
  assignTeamIdentity: async (...args: any[]) => hydrateLegacyWorkspace(await ok('team.identity.assign.v1', payload(args))),
  confirmTeamIdentityGroup: async (...args: any[]) => hydrateLegacyWorkspace(await ok('team.identity.confirm-group.v1', payload(args))),
  deleteTeamIdentity: async (...args: any[]) => hydrateLegacyWorkspace(await ok('team.identity.delete.v1', payload(args))),
  suggestTeamIdentities: async () => hydrateLegacyWorkspace(await durable('team.identity.suggest.v1', {})),
  getTeamIdentitySimilarities: () => ok('team.identity.similarities.v1'),
  completeTeamIdentity: (...args: any[]) => ok('team.identity.complete.v1', payload(args)),
  uploadTeamPatch: (...args: any[]) => ok('team.patch.upload.v1', payload(args)),
  removeTeamPatchUpload: (...args: any[]) => ok('team.patch.remove-upload.v1', payload(args)),
  mergeTeamPatches: (...args: any[]) => durable('team.patch.merge.v1', payload(args)),
  saveTeamWorkflowSettings: (...args: any[]) => ok('team.workflow.settings.save.v1', payload(args)),
  getTeamWorkflowGenerationStatus: () => ok('team.workflow.status.v1'),
  generateTeamWorkflow: (...args: any[]) => durable('team.workflow.generate.v1', payload(args)),
  cancelTeamWorkflowGeneration: (operationId: string) => ok('team.operation.cancel.v1', { operationId }),
  exportTeamIdentityTasks: (...args: any[]) => ok('team.workflow.open-export.v1', payload(args)),
  openTeamPatchFolder: async () => ({ success: true }),
  selectTeamPatchReturns: () => ok('team.patch.select-returns.v1'),
  returnTeamWorkflowBatch: async (...args: any[]) => hydrateReviewResult(await durable('team.workflow.return-batch.v1', payload(args))),
  getTeamWorkflowReturnReview: async () => { const result = await ok('team.workflow.return-review.get.v1'); return { ...result, review: result.review ? hydrateReviewResult(result.review) : result.review }; },
  discardTeamWorkflowReturnReview: (...args: any[]) => ok('team.workflow.return-review.discard.v1', { reviewSessionId: String(args[2] || '') }),
  ignoreTeamWorkflowReturnReview: (...args: any[]) => ok('team.workflow.return-review.ignore.v1', { reviewSessionId: String(args[2] || ''), returnId: String(args[3] || '') }),
  confirmTeamWorkflowReturn: (...args: any[]) => ok('team.workflow.return-confirm.v1', payload(args)),
  drainTeamWorkflowReconciles: (maxItems = 20) => ok('team.workflow.reconcile-drain.v1', { maxItems }),
  getProgressFolders: () => readProgressCached(),
  registerProgressWithGraph: async (...args: any[]) => {
    const result = await ok('team.progress.create.v1', payload(args));
    progressQuery = undefined;
    return result;
  },
  openTeamPatch: async (reference: string) => { const ref = parseLegacyMediaRef(reference); return ref?.kind === 'working' ? ok('team.patch.open.v1', ref) : { success: false, error: '工作图引用已失效' }; },
  getMediaThumbnail: async (...args: any[]): Promise<Json> => { const value = String(args[0] || ''); const ref = parseLegacyMediaRef(value) || parseLegacyMediaRef(mediaAliases.get(value) || ''); if (!ref) return { success: false, state: 'MISSING', error: '预览引用尚未建立' }; try { const result = await authorizeMedia(ref, 'preview', Number(args[4]) || 0); if (result.success === false) return { ...result, state: result.state || 'MISSING' }; return { ...result, state: 'READY', previewUrl: result.url, previewUrls: { small: result.url, medium: result.url, large: result.url } }; } catch { return missingMediaResult('thumbnail'); } },
  getMediaOriginal: async (...args: any[]): Promise<Json> => { const value = String(args[0] || ''); const ref = parseLegacyMediaRef(value) || parseLegacyMediaRef(mediaAliases.get(value) || ''); if (!ref) return { success: false, state: 'MISSING', error: '原图引用尚未建立' }; try { const result = await authorizeMedia(ref, 'original', 100); if (result.success === false) return { ...result, state: result.state || 'MISSING' }; return { ...result, state: 'READY', mediaUrl: result.url, orientation: { matrix: [1, 0, 0, 1] } }; } catch { return missingMediaResult('original'); } },
  onThumbnailStateChanged: (_callback: (value: any) => void) => () => undefined,
  onTeamPatchDetectionProgress: (callback: (value: any) => void) => event('team.patch.detect.progress.v1', callback),
  onTeamPatchBatchProgress: (callback: (value: any) => void) => event('team.patch.detect-batch.progress.v1', callback),
  onTeamPatchReturnBatchProgress: (callback: (value: any) => void) => event('team.return.progress.v1', callback),
  onTeamWorkflowGenerationProgress: (callback: (value: any) => void) => event('team.workflow.progress.v1', callback),
  getComponents: async () => { const state: Json = await ok('team.advanced.status.v1'); return { success: true, components: [componentStatusFromAdvancedPreflight(state)] }; },
  getContext: (): Promise<ComponentContext> => window.photoFlowComponent.getContext(),
  setProjectEntries: (entries: Json[]) => { projectEntryPaths.clear(); for (const entry of entries || []) if (entry.relativePath && entry.path) projectEntryPaths.set(normalizedRelativePath(String(entry.relativePath)), String(entry.path)); },
};

export const legacyMediaRef = mediaRef;
