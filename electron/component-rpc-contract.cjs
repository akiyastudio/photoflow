const omitFields = (value, fields) => Object.fromEntries(Object.entries(value || {}).filter(([field]) => !fields.includes(field)));
const stripTaskPaths = task => omitFields(task, ['patchPath', 'maskPath', 'editedPatchPath', 'uploadPath', 'returnedPath', 'previewUrl', 'patchUrl']);
const stripWorkspacePaths = value => ({
  ...value,
  photos: (value?.photos || []).map(photo => ({ ...omitFields(photo, ['sourcePath', 'originalFilePath', 'previewUrl']), tasks: (photo.tasks || []).map(stripTaskPaths) })),
});
const stripReturnPaths = value => ({
  ...omitFields(value, ['path', 'returnedPath', 'mediaPath', 'patchPath']),
  matches: (value?.matches || []).map(match => ({
    ...omitFields(match, ['path', 'mediaPath', 'returnedPath', 'patchPath', 'previewUrl']),
    alternatives: (match.alternatives || []).map(item => omitFields(item, ['path', 'patchPath', 'previewUrl'])),
  })),
});
const sanitizeReturnItems = items => Array.isArray(items) ? items.slice(0, 10000).map(item => sanitizePayload(item, ['photoId', 'baseVersionId', 'personIndex', 'taskId', 'taskOrder'])) : [];

const COMPONENT_RPC_METHODS = Object.freeze({
  'project.files.list.v1': { channel: 'workspace-list-files', fields: ['cursor'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, '', 200, payload.cursor || '', { kind: 'image' }] },
  'project.progress.list.v1': { channel: 'workspace-progress-folders', args: (_payload, context) => [context.workspacePath, context.projectName] },
  'project.progress.create.v1': { channel: 'workspace-progress-register-with-graph', fields: ['projectName', 'progress', 'workflowInputProgressIds'], args: (payload, context) => [context.workspacePath, context.projectStatus, { ...payload, projectName: context.projectName }] },
  'team.project.remove-photo.v1': { channel: 'workspace-team-project-remove-photo', fields: ['photoId', 'baseVersionId'], args: (payload, context) => [context.workspacePath, payload] },
  'team.media.authorize.v1': { channel: 'workspace-team-media-authorize', fields: ['kind', 'photoId', 'baseVersionId', 'taskId', 'reviewSessionId', 'returnId'], args: (payload, context) => [context.workspacePath, context.projectName, context.projectStatus, payload] },
  'team.patch.open.v1': { channel: 'workspace-team-patch-open-by-id', fields: ['photoId', 'baseVersionId', 'taskId'], args: (payload, context) => [context.workspacePath, context.projectName, payload] },
  'team.identity.suggest.v1': { channel: 'workspace-team-identities-suggest', args: (_payload, context) => [context.workspacePath, context.projectName], result: stripWorkspacePaths },
  'team.identity.complete.v1': { channel: 'workspace-team-identity-complete', fields: ['photoId', 'baseVersionId', 'personIndex', 'completed', 'completionKind', 'taskId', 'taskOrder'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName, status: context.projectStatus }] },
  'team.person.exclude.v1': { channel: 'workspace-team-person-exclude', fields: ['photoId', 'baseVersionId', 'personIndex'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.patch.get.v1': { channel: 'workspace-team-patches', fields: ['relativePath'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload.relativePath], result: value => ({ ...omitFields(value, ['filePath']), photo: value?.photo ? omitFields(value.photo, ['originalFilePath', 'previewUrl']) : value?.photo, versions: (value?.versions || []).map(item => omitFields(item, ['filePath', 'previewUrl'])), tasks: (value?.tasks || []).map(stripTaskPaths) }) },
  'team.patch.detect.v1': { channel: 'workspace-team-patch-detect', fields: ['photoId', 'baseVersionId', 'restoreExcluded'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.patch.detect-batch.v1': { channel: 'workspace-team-patch-detect-batch', fields: ['relativePaths'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.patch.update.v1': { channel: 'workspace-team-patch-update', fields: ['photoId', 'taskId', 'personName', 'assignee', 'crop', 'needsReview', 'reviewReason'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName, status: context.projectStatus }] },
  'team.patch.delete.v1': { channel: 'workspace-team-patch-delete', fields: ['photoId', 'taskId'], args: (payload, context) => [context.workspacePath, payload] },
  'team.patch.cleanup.v1': { channel: 'workspace-team-patch-cleanup', fields: ['photoId', 'baseVersionId'], args: (payload, context) => [context.workspacePath, payload] },
  'team.patch.upload.v1': { channel: 'workspace-team-patch-upload', fields: ['photoId', 'taskId', 'personIndex'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName, status: context.projectStatus }] },
  'team.patch.remove-upload.v1': { channel: 'workspace-team-patch-remove-upload', fields: ['photoId', 'taskId', 'personIndex'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName, status: context.projectStatus }] },
  'team.patch.select-returns.v1': { channel: 'workspace-team-patch-select-returns', args: (_payload, context) => [context.projectName] },
  'team.patch.return-batch.v1': { channel: 'workspace-team-patch-return-batch', fields: ['relativePaths', 'returnedFiles', 'outputProgressId'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.patch.merge.v1': { channel: 'workspace-team-patch-merge', fields: ['photoId', 'baseVersionId', 'outputProgressId', 'versionName'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.workflow.generate.v1': { channel: 'workspace-team-workflow-generate', fields: ['operationId', 'replace', 'preferredIdentityOrder', 'preferredIdentityId', 'sameWeekIdentityIds', 'groups'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.workflow.status.v1': { channel: 'workspace-team-workflow-status', args: (_payload, context) => [context.workspacePath, context.projectStatus, context.projectName] },
  'team.workflow.cancel.v1': { channel: 'workspace-team-workflow-cancel', fields: ['operationId'], args: payload => [payload.operationId] },
  'team.workflow.export.v1': { channel: 'workspace-team-identity-export', fields: ['week', 'identityId'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload], result: value => omitFields(value, ['path']) },
  'team.workflow.open-export.v1': { channel: 'workspace-team-identity-open-export', fields: ['week', 'identityId'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.workflow.return-batch.v1': { channel: 'workspace-team-workflow-return-batch', fields: ['returnedFiles', 'items'], args: (payload, context) => [context.workspacePath, context.projectName, { ...payload, items: sanitizeReturnItems(payload.items), status: context.projectStatus }], result: stripReturnPaths },
  'team.workflow.return-review.get.v1': { channel: 'workspace-team-workflow-return-review-get', args: (_payload, context) => [context.workspacePath, context.projectName, context.projectStatus], result: value => ({ ...value, review: value?.review ? stripReturnPaths(value.review) : value?.review }) },
  'team.workflow.return-review.discard.v1': { channel: 'workspace-team-workflow-return-review-discard', fields: ['reviewSessionId'], args: (payload, context) => [context.workspacePath, context.projectName, payload.reviewSessionId] },
  'team.workflow.return-review.ignore.v1': { channel: 'workspace-team-workflow-return-review-ignore', fields: ['reviewSessionId', 'returnId'], args: (payload, context) => [context.workspacePath, context.projectName, payload.reviewSessionId, payload.returnId] },
  'team.workflow.return-confirm.v1': { channel: 'workspace-team-workflow-return-confirm', fields: ['reviewSessionId', 'returnId', 'photoId', 'baseVersionId', 'personIndex', 'taskId', 'taskOrder'], args: (payload, context) => [context.workspacePath, context.projectName, { ...payload, status: context.projectStatus }] },
  'component.advanced.preflight.v1': { channel: 'team-retouch-advanced-preflight', args: () => [] },
  'component.advanced.install.v1': { channel: 'team-retouch-advanced-install', fields: ['repair'], args: payload => [payload] },
  'component.advanced.uninstall.v1': { channel: 'team-retouch-advanced-uninstall', args: () => [] },
});

const sanitizePayload = (payload, fields = []) => {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Component RPC payload must be an object');
  const serialized = JSON.stringify(payload);
  if (serialized.length > 2 * 1024 * 1024) throw new RangeError('Component RPC payload is too large');
  return Object.fromEntries(fields.filter(field => Object.hasOwn(payload, field)).map(field => [field, payload[field]]));
};

const createComponentRpcIpcProxy = ({ ipcMain, manager }) => ({
  ...ipcMain,
  handle(channel, handler) {
    ipcMain.handle(channel, handler);
    for (const [method, spec] of Object.entries(COMPONENT_RPC_METHODS)) {
      if (spec.channel === channel) manager.registerRpcMethod(method, async (event, payload, context) => {
        const result = await handler(event, ...spec.args(sanitizePayload(payload, spec.fields), context));
        return spec.result ? spec.result(result) : result;
      }, 'team-retouch');
    }
  },
  on: (...args) => ipcMain.on(...args),
  once: (...args) => ipcMain.once(...args),
  removeHandler: (...args) => ipcMain.removeHandler(...args),
});

module.exports = { COMPONENT_RPC_METHODS, createComponentRpcIpcProxy, sanitizePayload, stripReturnPaths, stripWorkspacePaths };
