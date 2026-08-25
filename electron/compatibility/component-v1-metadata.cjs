/**
 * @deprecated Component-specific metadata retained only for packages and data
 * produced by the Component Host V1 implementation.
 */
const path = require('path');

const LEGACY_PLUGIN_DEFINITIONS = Object.freeze({
  'team-retouch': Object.freeze({
    id: 'team-retouch',
    version: '26.8.24.5',
    name: '团片协作',
    description: 'AI识别人后规划可合并的工作图，支持人物标记、确定性任务重建并自动合回原尺寸。',
    capabilities: Object.freeze(['team-retouch.detect', 'team-retouch.identify', 'team-retouch.merge']),
    developmentEntry: Object.freeze(['extensions', 'team-retouch', 'team_retouch.py']),
    requiredAssets: Object.freeze([Object.freeze(['models', 'rtmdet-ins_m_640x640.onnx'])]),
  }),
});

const LEGACY_HOST_CAPABILITIES = Object.freeze([
  'project.media.list.v1', 'project.media.read.v1', 'project.output.authorize.v1',
  'version.register.v1', 'tasks.report.v1', 'component.settings.v1',
  'component.storage.v1', 'dialogs.open.v1', 'component.lifecycle.v1',
  'component.runtime.v1', 'project.media.access.v1', 'project.identity.complete.v1',
]);
const LEGACY_LONG_RUNNING_METHODS = Object.freeze(['team.workflow.generate.v1', 'team.workflow.return-batch.v1', 'team.patch.return-batch.v1']);
const LEGACY_COALESCED_READ_METHODS = Object.freeze(['team.project.get.v1', 'component.settings.get.v1', 'component.advanced.preflight.v1']);
const LEGACY_PYTHON_TOOL_ENTRIES = Object.freeze({
  team_retouch_db: Object.freeze(['compatibility', 'team_retouch_v1', 'database_tool.py']),
});
const LEGACY_VIEW_EVENT_CHANNELS = Object.freeze({
  'workflow.progress': 'workspace-team-workflow-progress',
  'patch.return-batch.progress': 'workspace-team-patch-return-batch-progress',
});

const LEGACY_PRELOAD_EVENTS = Object.freeze({
  'advanced.progress': 'team-retouch-advanced-progress',
  'workflow.progress': 'workspace-team-workflow-progress',
  'patch.detect.progress': 'workspace-team-patch-detect-progress',
  'patch.detect-batch.progress': 'workspace-team-patch-detect-batch-progress',
  'patch.return-batch.progress': 'workspace-team-patch-return-batch-progress',
});

const LEGACY_BACKGROUND_TASK_CHANNELS = Object.freeze({
  'team-retouch-advanced-progress': Object.freeze({ id: 'external:team-retouch-advanced', title: '高级修图引擎' }),
});

const LEGACY_DOMAIN = Object.freeze({
  id: 'team-retouch',
  displayName: '团片协作',
  databaseFile: 'team-retouch.sqlite3',
  databaseScript: 'team_retouch_db.py',
  projectFolder: '团片协作',
  advancedPackagePattern: /^PhotoFlow-team-retouch-advanced-.*\.zip$/i,
  owns: Object.freeze(['team-identities', 'person-assignments', 'retouch-patches', 'recomposition-jobs']),
  storage: Object.freeze(['team-retouch.sqlite3', 'team-workspaces']),
  artifactMigration: Object.freeze({
    componentId: 'team-retouch',
    method: 'team.workflow.artifact.migrate.v1',
  }),
});

const legacyDatabasePath = (getWorkspaceDataRoot, workspaceRoot) =>
  path.join(getWorkspaceDataRoot(workspaceRoot), 'databases', LEGACY_DOMAIN.databaseFile);

const legacyProjectArtifactPaths = (dataRoot, photoId) => [
  path.join(dataRoot, LEGACY_DOMAIN.id, String(photoId)),
];

const normalizeLegacyExternalProgress = (channel, value, stateFor) => {
  const progress = Math.max(0, Math.min(100, Number(value.progress) || 0));
  const simple = LEGACY_BACKGROUND_TASK_CHANNELS[channel];
  if (simple) return { ...simple, type: 'component-install', state: stateFor(value.phase), progress, message: value.message, resumePolicy: 'atomic', metadata: { phase: value.phase } };
  if (channel === 'workspace-team-workflow-progress') return { id: `external:team-workflow:${value.operationId}`, type: 'workspace-team-workflow', title: `生成协作流程 · ${value.projectName}`, state: value.state || stateFor(value.phase), progress, message: value.message, cancellable: true, resumePolicy: 'checkpoint', metadata: { phase: value.phase, operationId: value.operationId, projectName: value.projectName, filesCopied: value.completedFiles, totalFiles: value.totalFiles, bytesCopied: value.copiedBytes, totalBytes: value.totalBytes, currentName: value.currentName } };
  if (channel === 'workspace-team-patch-detect-progress') return { id: `external:team-patch-detect:${value.photoId}:${value.baseVersionId}`, type: 'team-patch-detection', title: '检测修图区域', state: stateFor(value.phase), progress, message: value.message, notificationPolicy: 'silent', metadata: { phase: value.phase, photoId: value.photoId, baseVersionId: value.baseVersionId } };
  if (channel === 'workspace-team-patch-detect-batch-progress') return { id: 'external:team-patch-detect-batch', type: 'team-patch-detection-batch', title: '批量检测修图区域', state: stateFor(value.phase), progress, message: value.message, metadata: { phase: value.phase, itemIndex: value.itemIndex, itemCount: value.itemCount, relativePath: value.relativePath, currentName: value.itemName } };
  if (channel === 'workspace-team-patch-return-batch-progress') return { id: 'external:team-patch-return-batch', type: 'team-patch-return-batch', title: '批量处理协作返图', state: stateFor(value.phase), progress, message: value.message, metadata: { phase: value.phase } };
  return null;
};

const invokeLegacyArtifactMigration = async ({ componentServiceManager, writeLog, workspaceRoot, from, to }) => {
  const declaration = LEGACY_DOMAIN.artifactMigration;
  if (!componentServiceManager?.supports(declaration.componentId, declaration.method)) {
    writeLog('warn', 'Legacy component artifact migration deferred because its service is unavailable', { componentId: declaration.componentId, from, to });
    return [];
  }
  return componentServiceManager.invoke(declaration.componentId, declaration.method, { from, to }, {
    componentId: declaration.componentId, componentVersion: '', workspacePath: workspaceRoot,
    projectId: `artifact:${String(from.projectName || '')}`, projectName: String(from.projectName || ''), projectStatus: String(from.status || ''),
  });
};

const resolveLegacyPackageForDeletion = async ({ fs, path: pathApi, pluginService, kind, resolvePreparedPackage }) => {
  if (kind !== 'advanced') return null;
  const packageRoot = pathApi.join(pluginService.installRoot, LEGACY_DOMAIN.id);
  return {
    archivePath: await resolvePreparedPackage(packageRoot, LEGACY_DOMAIN.advancedPackagePattern, '照片流高级引擎包'),
    allowedRoot: packageRoot,
  };
};

module.exports = {
  LEGACY_BACKGROUND_TASK_CHANNELS,
  LEGACY_DOMAIN,
  LEGACY_HOST_CAPABILITIES,
  LEGACY_LONG_RUNNING_METHODS,
  LEGACY_COALESCED_READ_METHODS,
  LEGACY_PYTHON_TOOL_ENTRIES,
  LEGACY_PLUGIN_DEFINITIONS,
  LEGACY_PRELOAD_EVENTS,
  LEGACY_VIEW_EVENT_CHANNELS,
  legacyDatabasePath,
  legacyProjectArtifactPaths,
  invokeLegacyArtifactMigration,
  normalizeLegacyExternalProgress,
  resolveLegacyPackageForDeletion,
};
