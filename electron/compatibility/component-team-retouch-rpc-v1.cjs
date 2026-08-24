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
});

const sanitizePayload = (payload, fields = []) => {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Component RPC payload must be an object');
  const serialized = JSON.stringify(payload);
  if (serialized.length > 2 * 1024 * 1024) throw new RangeError('Component RPC payload is too large');
  return Object.fromEntries(fields.filter(field => Object.hasOwn(payload, field)).map(field => [field, payload[field]]));
};

/** @deprecated Component Host V1 renderer-to-application RPC mappings. */
const registerDeprecatedTeamRetouchRpc = ({ channel, handler, manager }) => {
    for (const [method, spec] of Object.entries(COMPONENT_RPC_METHODS)) {
      if (spec.channel === channel) manager.registerRpcMethod(method, async (event, payload, context) => {
        const result = await handler(event, ...spec.args(sanitizePayload(payload, spec.fields), context));
        return spec.result ? spec.result(result) : result;
      }, 'team-retouch');
    }
};

module.exports = { COMPONENT_RPC_METHODS, registerDeprecatedTeamRetouchRpc, sanitizePayload, stripReturnPaths, stripWorkspacePaths };
