const COMPONENT_RPC_METHODS = Object.freeze({
  'project.files.list.v1': { channel: 'workspace-list-files', fields: ['cursor'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, '', 200, payload.cursor || '', { kind: 'image' }] },
  'project.progress.list.v1': { channel: 'workspace-progress-folders', args: (_payload, context) => [context.workspacePath, context.projectName] },
  'project.progress.create.v1': { channel: 'workspace-progress-register-with-graph', fields: ['projectName', 'progress', 'workflowInputProgressIds'], args: (payload, context) => [context.workspacePath, context.projectStatus, { ...payload, projectName: context.projectName }] },
  'team.project.get.v1': { channel: 'workspace-team-project', args: (_payload, context) => [context.workspacePath, context.projectName, context.projectStatus] },
  'team.project.register.v1': { channel: 'workspace-team-project-register', fields: ['relativePaths'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload.relativePaths || []] },
  'team.project.remove-photo.v1': { channel: 'workspace-team-project-remove-photo', fields: ['photoId', 'baseVersionId'], args: (payload, context) => [context.workspacePath, payload] },
  'team.identity.similarities.v1': { channel: 'workspace-team-identity-similarities', args: (_payload, context) => [context.workspacePath, context.projectName] },
  'team.identity.suggest.v1': { channel: 'workspace-team-identities-suggest', args: (_payload, context) => [context.workspacePath, context.projectName] },
  'team.identity.save.v1': { channel: 'workspace-team-identity-save', fields: ['identityId', 'name', 'assignments'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName }] },
  'team.identity.assign.v1': { channel: 'workspace-team-identity-assign', fields: ['photoId', 'baseVersionId', 'personIndex', 'identityId', 'confidence', 'source', 'completed'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName }] },
  'team.identity.confirm-group.v1': { channel: 'workspace-team-identity-confirm-group', fields: ['anchorSubjectKey', 'identityId', 'name', 'assignments'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName }] },
  'team.identity.complete.v1': { channel: 'workspace-team-identity-complete', fields: ['photoId', 'baseVersionId', 'personIndex', 'completed', 'completionKind', 'taskId', 'taskOrder'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName, status: context.projectStatus }] },
  'team.identity.delete.v1': { channel: 'workspace-team-identity-delete', fields: ['identityId'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName }] },
  'team.person.exclude.v1': { channel: 'workspace-team-person-exclude', fields: ['photoId', 'baseVersionId', 'personIndex'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.patch.get.v1': { channel: 'workspace-team-patches', fields: ['relativePath'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload.relativePath] },
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
  'team.workflow.settings.save.v1': { channel: 'workspace-team-workflow-settings-save', fields: ['preferredIdentityOrder', 'preferredIdentityId', 'sameWeekIdentityIds'], args: (payload, context) => [context.workspacePath, { ...payload, projectName: context.projectName }] },
  'team.workflow.generate.v1': { channel: 'workspace-team-workflow-generate', fields: ['operationId', 'replace', 'preferredIdentityOrder', 'preferredIdentityId', 'sameWeekIdentityIds', 'groups'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.workflow.status.v1': { channel: 'workspace-team-workflow-status', args: (_payload, context) => [context.workspacePath, context.projectStatus, context.projectName] },
  'team.workflow.cancel.v1': { channel: 'workspace-team-workflow-cancel', fields: ['operationId'], args: payload => [payload.operationId] },
  'team.workflow.export.v1': { channel: 'workspace-team-identity-export', fields: ['week', 'identityId'], args: (payload, context) => [context.workspacePath, context.projectStatus, context.projectName, payload] },
  'team.workflow.return-batch.v1': { channel: 'workspace-team-workflow-return-batch', fields: ['returnedFiles', 'items'], args: (payload, context) => [context.workspacePath, context.projectName, { ...payload, status: context.projectStatus }] },
  'team.workflow.return-review.get.v1': { channel: 'workspace-team-workflow-return-review-get', args: (_payload, context) => [context.workspacePath, context.projectName, context.projectStatus] },
  'team.workflow.return-review.discard.v1': { channel: 'workspace-team-workflow-return-review-discard', fields: ['reviewSessionId'], args: (payload, context) => [context.workspacePath, context.projectName, payload.reviewSessionId] },
  'team.workflow.return-review.ignore.v1': { channel: 'workspace-team-workflow-return-review-ignore', fields: ['reviewSessionId', 'returnId'], args: (payload, context) => [context.workspacePath, context.projectName, payload.reviewSessionId, payload.returnId] },
  'team.workflow.return-confirm.v1': { channel: 'workspace-team-workflow-return-confirm', fields: ['returnedPath', 'reviewSessionId', 'returnId', 'photoId', 'baseVersionId', 'personIndex', 'taskId', 'taskOrder'], args: (payload, context) => [context.workspacePath, context.projectName, { ...payload, status: context.projectStatus }] },
  'component.settings.get.v1': { channel: 'component-settings-get', args: () => ['team-retouch'] },
  'component.settings.update.v1': { channel: 'component-settings-update', fields: ['useGpu', 'oversizeCropMode'], args: payload => ['team-retouch', payload] },
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
      if (spec.channel === channel) manager.registerRpcMethod(method, (event, payload, context) => handler(event, ...spec.args(sanitizePayload(payload, spec.fields), context)), 'team-retouch');
    }
  },
  on: (...args) => ipcMain.on(...args),
  once: (...args) => ipcMain.once(...args),
  removeHandler: (...args) => ipcMain.removeHandler(...args),
});

module.exports = { COMPONENT_RPC_METHODS, createComponentRpcIpcProxy, sanitizePayload };
