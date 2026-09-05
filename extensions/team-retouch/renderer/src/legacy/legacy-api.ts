import { rpc, type ComponentContext } from '../sdk.ts';
import { expireLegacyMedia, scheduleLegacyMedia } from './legacy-media-scheduler.ts';
import { createTeamRevisionCoordinator, retryOnceAfterRevisionConflict } from './legacy-revision-model.ts';
import { createScopedPromiseCache } from './scoped-promise-cache.ts';
import { assertTeamProjectPhotos } from './team-project-photo.ts';

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
  if (parts.length !== 8 || parts[0] !== 'photoflow-ref') return undefined;
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
  const photos: Json[] = assertTeamProjectPhotos(workspace.photos || []).map((photo: Json) => {
    const reference = mediaRef('original', String(photo.photoId), String(photo.baseVersionId));
    const sourcePath = projectEntryPaths.get(normalizedRelativePath(String(photo.relativePath || ''))) || reference;
    mediaAliases.set(sourcePath, reference);
    return { ...photo, sourcePath, tasks: (photo.tasks || []).map((task: Json) => hydrateTask(task, String(photo.photoId), String(photo.baseVersionId))) };
  });
  const photoByVersion = new Map(photos.map((photo: Json) => [`${String(photo.photoId)}\0${String(photo.baseVersionId)}`, photo]));
  const taskBySubject = new Map<string, Json>();
  for (const photo of photos) for (const task of photo.tasks || []) for (const member of task.members || []) taskBySubject.set(`${String(photo.photoId)}\0${String(photo.baseVersionId)}\0${Number(member.personIndex)}`, task);
  const assignments = (workspace.assignments || []).map((assignment: Json) => {
    const photo = photoByVersion.get(`${String(assignment.photoId)}\0${String(assignment.baseVersionId)}`);
    const task = photo ? taskBySubject.get(`${String(assignment.photoId)}\0${String(assignment.baseVersionId)}\0${Number(assignment.personIndex)}`) : undefined;
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
const revisionCoordinator = createTeamRevisionCoordinator();
const ok = <T extends Json = Json>(method: string, value?: Json) => revisionCoordinator.run<T>(method, value, request => rpc<T>(method, request));
export const teamProjectRpc = <T extends Json = Json>(method: string, value?: Json) => ok<T>(method, value);
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
const progressQueries = createScopedPromiseCache<Json>(2_000);
const readProgressCached = (projectId: string, queryKey = 'all') => progressQueries.get(queryKey, () => ok('team.progress.list.v1', { projectId, queryKey }));
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
  const advancedAvailable = state.advancedAvailable === true;
  const advancedState = ['ready', 'not-installed', 'repair-needed', 'unavailable'].includes(String(state.state || '')) ? state.state : 'unavailable';
  return {
    id: 'team-retouch', installed: true, runtimeAvailable: true, identityAvailable: true,
    advancedAvailable, advancedState,
    advancedError: String(state.advancedError || state.error || ''),
    ...(state.errorCategory ? { advancedErrorCategory: String(state.errorCategory) } : {}),
    ...(state.runtimeSource ? { advancedRuntimeSource: String(state.runtimeSource) } : {}),
    provider: '内置人物检测',
  };
};

export const legacyApi = {
  setMediaAuthorizationScope: (scope: string) => {
    const next = String(scope || '');
    if (next === mediaAuthorizationScope) return;
    mediaAuthorizationGeneration += 1; expireLegacyMedia(); mediaAliases.clear(); mediaAuthorizationScope = next; revisionCoordinator.setScope(next); progressQueries.setScope(next);
  },
  getMediaAuthorizationScope: () => mediaAuthorizationScope,
  getTeamPatches: async (request: { relativePath: string; baseVersionId: string }) => hydrateLegacyBundle(await ok('team.patch.get.v1', { relativePath: request.relativePath }), request.baseVersionId),
  getTeamProjectWorkspace: async () => hydrateLegacyWorkspace(await ok('team.project.get.v1')),
  detectTeamPatchPeople: async (request: Json) => hydrateLegacyBundle(await durable('team.patch.detect.v1', request)),
  detectTeamPatchBatch: (request: Json) => durable('team.patch.detect-batch.v1', request),
  updateTeamPatch: async (request: Json) => hydrateLegacyBundle(await durable('team.patch.update.v1', request)),
  deleteTeamPatch: async (request: Json) => hydrateLegacyBundle(await ok('team.patch.delete.v1', request)),
  removeProjectTeamPhoto: (request: Json) => ok('team.project.remove-photo.v1', request),
  excludeTeamPerson: async (request: Json) => hydrateLegacyWorkspace(await durable('team.person.exclude.v1', request)),
  saveTeamIdentity: async (request: Json) => hydrateLegacyWorkspace(await ok('team.identity.save.v1', request)),
  assignTeamIdentity: async (request: Json) => hydrateLegacyWorkspace(await ok('team.identity.assign.v1', request)),
  confirmTeamIdentityGroup: async (request: Json) => hydrateLegacyWorkspace(await ok('team.identity.confirm-group.v1', request)),
  deleteTeamIdentity: async (request: Json) => hydrateLegacyWorkspace(await ok('team.identity.delete.v1', request)),
  suggestTeamIdentities: async () => hydrateLegacyWorkspace(await durable('team.identity.suggest.v1', {})),
  getTeamIdentitySimilarities: () => ok('team.identity.similarities.v1'),
  completeTeamIdentity: (request: Json) => ok('team.identity.complete.v1', request),
  uploadTeamPatch: (request: Json) => ok('team.patch.upload.v1', request),
  removeTeamPatchUpload: (request: Json) => ok('team.patch.remove-upload.v1', request),
  mergeTeamPatches: (request: Json) => durable('team.patch.merge.v1', request),
  saveTeamWorkflowSettings: (request: Json) => ok('team.workflow.settings.save.v1', request),
  getTeamWorkflowGenerationStatus: () => ok('team.workflow.status.v1'),
  generateTeamWorkflow: (request: Json) => durable('team.workflow.generate.v1', request),
  cancelTeamWorkflowGeneration: (request: { operationId: string }) => ok('team.operation.cancel.v1', request),
  exportTeamIdentityTasks: (request: Json) => ok('team.workflow.open-export.v1', request),
  selectTeamPatchReturns: () => ok('team.patch.select-returns.v1'),
  returnTeamWorkflowBatch: async (request: Json) => hydrateReviewResult(await durable('team.workflow.return-batch.v1', request)),
  getTeamWorkflowReturnReview: async () => { const result = await ok('team.workflow.return-review.get.v1'); return { ...result, review: result.review ? hydrateReviewResult(result.review) : result.review }; },
  discardTeamWorkflowReturnReview: (request: { reviewSessionId: string }) => ok('team.workflow.return-review.discard.v1', request),
  ignoreTeamWorkflowReturnReview: (request: { reviewSessionId: string; returnId: string }) => ok('team.workflow.return-review.ignore.v1', request),
  confirmTeamWorkflowReturn: (request: Json) => {
    const scope = revisionCoordinator.getScope();
    return retryOnceAfterRevisionConflict(
      () => ok('team.workflow.return-confirm.v1', request),
      async () => {
        await ok('team.project.get.v1');
        if (revisionCoordinator.getScope() !== scope) throw new Error('项目已切换，已取消旧项目的返图确认');
      },
    );
  },
  drainTeamWorkflowReconciles: ({ maxItems = 20, taskIds = [] }: { maxItems?: number; taskIds?: string[] } = {}) => ok('team.workflow.reconcile-drain.v1', { maxItems, ...(taskIds.length ? { taskIds } : {}) }),
  getProgressFolders: ({ projectId }: { projectId: string; queryKey?: string }) => readProgressCached(projectId, 'all'),
  registerProgressWithGraph: async (request: Json) => {
    const result = await ok('team.progress.create.v1', request);
    progressQueries.clear();
    return result;
  },
  openTeamPatch: async ({ reference }: { reference: string }) => { const ref = parseLegacyMediaRef(reference); return ref?.kind === 'working' ? ok('team.patch.open.v1', ref) : { success: false, error: '工作图引用已失效' }; },
  getMediaThumbnail: async ({ reference, priority = 0 }: { reference: string; priority?: number }): Promise<Json> => { const ref = parseLegacyMediaRef(reference) || parseLegacyMediaRef(mediaAliases.get(reference) || ''); if (!ref) return { success: false, state: 'MISSING', error: '预览引用尚未建立' }; try { const result = await authorizeMedia(ref, 'preview', priority); if (result.success === false) return { ...result, state: result.state || 'MISSING' }; return { ...result, state: 'READY', previewUrl: result.url, previewUrls: { small: result.url, medium: result.url, large: result.url } }; } catch { return missingMediaResult('thumbnail'); } },
  getMediaOriginal: async ({ reference }: { reference: string }): Promise<Json> => { const ref = parseLegacyMediaRef(reference) || parseLegacyMediaRef(mediaAliases.get(reference) || ''); if (!ref) return { success: false, state: 'MISSING', error: '原图引用尚未建立' }; try { const result = await authorizeMedia(ref, 'original', 100); if (result.success === false) return { ...result, state: result.state || 'MISSING' }; return { ...result, state: 'READY', mediaUrl: result.url, orientation: { matrix: [1, 0, 0, 1] } }; } catch { return missingMediaResult('original'); } },
  onTeamPatchDetectionProgress: (callback: (value: any) => void) => event('team.patch.detect.progress.v1', callback),
  onTeamPatchBatchProgress: (callback: (value: any) => void) => event('team.patch.detect-batch.progress.v1', callback),
  onTeamPatchReturnBatchProgress: (callback: (value: any) => void) => event('team.return.progress.v1', callback),
  onTeamWorkflowGenerationProgress: (callback: (value: any) => void) => event('team.workflow.progress.v1', callback),
  getComponents: async () => { const state: Json = await ok('team.advanced.status.v1'); return { success: true, components: [componentStatusFromAdvancedPreflight(state)] }; },
  getContext: (): Promise<ComponentContext> => window.photoFlowComponent.getContext(),
  setProjectEntries: (entries: Json[]) => { projectEntryPaths.clear(); for (const entry of entries || []) if (entry.relativePath && entry.path) projectEntryPaths.set(normalizedRelativePath(String(entry.relativePath)), String(entry.path)); },
};

export const legacyMediaRef = mediaRef;
