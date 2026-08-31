const { contextBridge, ipcRenderer, webUtils } = require('electron');
// Sandboxed preloads only expose Electron's limited preload `require`; local
// CommonJS modules are unavailable here even when the file exists on disk.
const COMPONENT_NOTIFICATION_TONES = new Set(['info', 'success', 'warning', 'error']);
const COMPONENT_NOTIFICATION_DEDUPE_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const normalizeComponentNotificationRendererEvent = value => {
  if (!value || typeof value !== 'object' || value.apiVersion !== 7 || typeof value.componentId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.componentId)) return null;
  if (value.type === 'purge') return Object.freeze({ apiVersion: 7, type: 'purge', componentId: value.componentId });
  if (value.type !== 'notification' || typeof value.id !== 'string' || !['project', 'application.settings', 'component.sidePanel', 'media.contextAction', 'project.contextAction', 'project.importProvider', 'project.exportProvider', 'application.command'].includes(value.surface)) return null;
  const notification = value.notification;
  if (!notification || Object.keys(notification).some(key => !['tone', 'message', 'dedupeKey'].includes(key)) || !COMPONENT_NOTIFICATION_TONES.has(notification.tone) || typeof notification.message !== 'string' || notification.message !== notification.message.trim() || notification.message.length < 1 || notification.message.length > 360 || (notification.dedupeKey !== undefined && (typeof notification.dedupeKey !== 'string' || !COMPONENT_NOTIFICATION_DEDUPE_KEY.test(notification.dedupeKey)))) return null;
  return Object.freeze({ apiVersion: 7, type: 'notification', id: value.id, componentId: value.componentId, surface: value.surface, notification: Object.freeze({ tone: notification.tone, message: notification.message, ...(notification.dedupeKey ? { dedupeKey: notification.dedupeKey } : {}) }) });
};
const subscribeComponentNotification = callback => {
  if (typeof callback !== 'function') throw new TypeError('Component notification callback must be a function');
  const listener = (_event, value) => { const normalized = normalizeComponentNotificationRendererEvent(value); if (normalized) callback(normalized); };
  ipcRenderer.on('component-host:notification', listener);
  return () => ipcRenderer.removeListener('component-host:notification', listener);
};

for (const channel of ['workspace-screenshot-main-image-progress', 'workspace-selection-progress']) {
  ipcRenderer.on(channel, (_event, value) => ipcRenderer.send('background-task-external-progress', channel, value));
}

const RENDERER_PYTHON_TOOLS = new Set(['catch.py', 'classify.py', 'cut_video.py', 'ffmpeg_transcode.py', 'png_to_jpg.py', 'research.py']);
const validatePythonInvocation = (scriptName, args, requestId) => {
  if (typeof scriptName !== 'string' || !RENDERER_PYTHON_TOOLS.has(scriptName)) throw new Error('Python tool is not available');
  if (!Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== 'string' || value.length > 32768 || /[\0\r\n]/.test(value))) {
    throw new TypeError('Invalid Python tool arguments');
  }
  const normalizedRequestId = String(requestId || '');
  if (normalizedRequestId && !/^[a-z0-9-]{8,80}$/i.test(normalizedRequestId)) throw new Error('Invalid Python request identifier');
  return { scriptName, args, requestId: normalizedRequestId };
};
const normalizePythonTaskPresentation = value => {
  if (!value || typeof value !== 'object') return undefined;
  const ownerPageId = String(value.ownerPageId || '').trim().slice(0, 160);
  const panelKind = String(value.panelKind || '').trim().slice(0, 80);
  const title = String(value.title || '').trim().slice(0, 160);
  return ownerPageId && panelKind ? { ownerPageId, panelKind, title } : undefined;
};

const trackFeature = feature => ipcRenderer.send('telemetry-track', 'feature_used', { feature });
const invokeFeature = (feature, channel, ...args) => {
  trackFeature(feature);
  return ipcRenderer.invoke(channel, ...args);
};
const omitUndefined = value => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

contextBridge.exposeInMainWorld('electronAPI', {
  apiContractVersion: 1,
  runScript: (scriptName, args, requestId, presentation) => {
    const invocation = validatePythonInvocation(scriptName, args, requestId);
    const feature = invocation.scriptName.replace(/\.py$/i, '').slice(0, 48);
    if (feature) trackFeature(feature);
    ipcRenderer.send('run-python', invocation.scriptName, invocation.args, invocation.requestId, normalizePythonTaskPresentation(presentation));
  },
  cancelPythonTask: (requestId) => ipcRenderer.invoke('cancel-python', requestId),
  controlPythonTask: (requestId, action) => ipcRenderer.invoke('control-python', requestId, action),
  getBirthdays: () => ipcRenderer.invoke('get-birthdays'),
  saveBirthdays: (data) => ipcRenderer.invoke('save-birthdays', data),
  onPythonEvent: (callback) => {
    const subscription = (_event, value) => callback(value);
    ipcRenderer.on('python-event', subscription);
    return () => ipcRenderer.removeListener('python-event', subscription);
  },
  loadConfig: () => ipcRenderer.invoke('loadConfig'),
  loadStartupSnapshot: () => ipcRenderer.invoke('load-startup-snapshot'),
  saveConfig: (config) => ipcRenderer.invoke('saveConfig', config),
  getPrivacyConsentState: () => ipcRenderer.invoke('privacy-consent-state'),
  savePrivacyConsent: (request) => ipcRenderer.invoke('privacy-consent-save', request),
  openLegalDocument: (documentId) => ipcRenderer.invoke('privacy-open-legal-document', documentId),
  clearTelemetryLocalData: () => ipcRenderer.invoke('privacy-clear-telemetry-local-data'),
  getUserPath: () => ipcRenderer.invoke('getUserPath'),
  onUpdateAvailable: (callback) => {
    const subscription = (_event, value) => callback(value);
    ipcRenderer.on('update-available', subscription);
    return () => ipcRenderer.removeListener('update-available', subscription);
  },
  openExternal: (url) => ipcRenderer.send('open-external', url),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  submitFeedback: (message) => ipcRenderer.invoke('submit-feedback', message),
  getComponents: (force = false) => ipcRenderer.invoke('components-list', force),
  getComponentHostActions: () => ipcRenderer.invoke('component-host-list'),
  getComponentSettingsPages: () => ipcRenderer.invoke('component-host-settings-list'),
  readComponentSettingsForm: request => ipcRenderer.invoke('component-host-settings-form-read', request),
  updateComponentSettingsForm: request => ipcRenderer.invoke('component-host-settings-form-update', request),
  getComponentContributions: () => ipcRenderer.invoke('component-host-contributions-list'),
  openComponentPage: request => ipcRenderer.invoke('component-host-open', request),
  openComponentSettingsPage: request => ipcRenderer.invoke('component-host-settings-open', request),
  openComponentContribution: request => ipcRenderer.invoke('component-host-contribution-open', request),
  onComponentPanelCloseRequested: callback => {
    if (typeof callback !== 'function') throw new TypeError('Component panel close callback must be a function');
    const listener = (_event, instanceId) => callback(String(instanceId || ''));
    ipcRenderer.on('component-host:panel-close-requested', listener);
    return () => ipcRenderer.removeListener('component-host:panel-close-requested', listener);
  },
  onComponentPanelContentSizeChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('Component panel content-size callback must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('component-host:panel-content-size', listener);
    return () => ipcRenderer.removeListener('component-host:panel-content-size', listener);
  },
  onComponentProjectDirectoryOpenRequested: callback => {
    if (typeof callback !== 'function') throw new TypeError('Component project-directory callback must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('component-host:open-project-directory', listener);
    return () => ipcRenderer.removeListener('component-host:open-project-directory', listener);
  },
  releaseComponentSettingsPage: request => ipcRenderer.invoke('component-host-settings-release', request),
  activateComponentPage: instanceId => ipcRenderer.invoke('component-host-activate', instanceId),
  setHostSurfaceSuspended: update => ipcRenderer.invoke('component-host-set-suspended', update),
  updateToastView: snapshot => ipcRenderer.invoke('toast-view:update', snapshot),
  onToastViewAction: callback => {
    if (typeof callback !== 'function') throw new TypeError('Toast view action callback must be a function');
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('toast-view:action', listener);
    return () => ipcRenderer.removeListener('toast-view:action', listener);
  },
  onToastViewPresentation: callback => {
    if (typeof callback !== 'function') throw new TypeError('Toast view presentation callback must be a function');
    const listener = (_event, presentation) => callback(presentation);
    ipcRenderer.on('toast-view:presentation', listener);
    return () => ipcRenderer.removeListener('toast-view:presentation', listener);
  },
  setComponentNotificationReady: update => ipcRenderer.invoke('component-host-notifications-ready', update),
  setComponentPageBounds: (instanceId, bounds) => ipcRenderer.invoke('component-host-set-bounds', instanceId, bounds),
  closeComponentPage: instanceId => ipcRenderer.invoke('component-host-close', instanceId),
  closeProjectComponentPages: (workspacePath, projectId) => ipcRenderer.invoke('component-host-close-project', workspacePath, projectId),
  onComponentsStatusChanged: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('components-status-changed', subscription); return () => ipcRenderer.removeListener('components-status-changed', subscription); },
  openComponentsFolder: (componentId) => ipcRenderer.invoke('components-open-folder', componentId),
  openLogsFolder: () => ipcRenderer.invoke('logs-open-folder'),
  clearLogs: () => ipcRenderer.invoke('logs-clear'),
  clearInterfaceCache: () => ipcRenderer.invoke('interface-cache-clear'),
  getCursorScreenPoint: () => ipcRenderer.invoke('cursor-screen-point'),
  installComponent: (componentId) => ipcRenderer.invoke('components-install', componentId),
  setComponentEnabled: (componentId, enabled) => ipcRenderer.invoke('components-set-enabled', componentId, enabled),
  deleteComponentPackage: (kind, componentId) => ipcRenderer.invoke('components-delete-package', kind, componentId),
  uninstallComponent: (componentId, options) => ipcRenderer.invoke('components-uninstall', componentId, options),
  getStorageDevices: () => ipcRenderer.invoke('getStorageDevices'),
  getDomainHealth: () => ipcRenderer.invoke('domain-health-status'),
  retryDomainCommand: (commandId) => ipcRenderer.invoke('domain-command-retry', commandId),
  getDrives: () => ipcRenderer.invoke('getDrives'),
  getWorkspaceProjects: (workspacePath) => ipcRenderer.invoke('workspace-projects', workspacePath),
  onWorkspaceFilesChanged: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('workspace-files-changed', subscription); return () => ipcRenderer.removeListener('workspace-files-changed', subscription); },
  onWorkspaceProjectsChanged: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('workspace-projects-changed', subscription); return () => ipcRenderer.removeListener('workspace-projects-changed', subscription); },
  createWorkspaceProject: (workspacePath, date, name, options) => ipcRenderer.invoke('workspace-create-project', workspacePath, date, name, options),
  chooseExistingProject: () => ipcRenderer.invoke('workspace-choose-existing-project'),
  inspectExistingProject: (sourcePath) => ipcRenderer.invoke('workspace-inspect-existing-project', sourcePath),
  importExistingProject: (workspacePath, sourcePath, options) => ipcRenderer.invoke('workspace-import-existing-project', workspacePath, sourcePath, options),
  renameWorkspaceProject: (workspacePath, status, name, date, nextName) => ipcRenderer.invoke('workspace-rename-project', workspacePath, status, name, date, nextName),
  renameProjectFolder: (workspacePath, status, name, folderName, nextName) => ipcRenderer.invoke('workspace-rename-project-folder', workspacePath, status, name, folderName, nextName),
  createProjectFolder: (workspacePath, status, name, folderName, relativePath, makeUnique) => ipcRenderer.invoke('workspace-create-project-folder', workspacePath, status, name, folderName, relativePath, makeUnique),
  getShellNewFileTypes: (refresh = false) => ipcRenderer.invoke('workspace-shell-new-types', refresh),
  createProjectShellNewFile: (workspacePath, status, name, relativePath, typeId) => ipcRenderer.invoke('workspace-create-shell-new-file', workspacePath, status, name, relativePath, typeId),
  undoLastRename: (workspacePath, options) => ipcRenderer.invoke('workspace-undo-rename', workspacePath, options),
  moveWorkspaceProject: (workspacePath, status, name, nextStatus) => ipcRenderer.invoke('workspace-move-project', workspacePath, status, name, nextStatus),
  finalizeSdImportedProjects: (workspacePath, projectNames, options) => ipcRenderer.invoke('workspace-finalize-sd-imports', workspacePath, projectNames, {
    moveProjectAfterImport: options?.moveProjectAfterImport === true,
    workProjectNames: Array.isArray(options?.workProjectNames) ? options.workProjectNames : [],
    importedPathsByProject: options?.importedPathsByProject && typeof options.importedPathsByProject === 'object' ? options.importedPathsByProject : {},
  }),
  trashWorkspaceProject: (workspacePath, status, name) => ipcRenderer.invoke('workspace-trash-project', workspacePath, status, name),
  cleanupDeletedWorkspaceProjects: (workspacePath) => ipcRenderer.invoke('workspace-cleanup-deleted-projects', workspacePath),
  getProjectContents: (workspacePath, status, name) => ipcRenderer.invoke('workspace-project-contents', workspacePath, status, name),
  watchFileRoot: (workspacePath, status, name, options) => ipcRenderer.invoke('workspace-watch-file-root', workspacePath, status, name, options),
  unwatchFileRoot: (workspacePath, status, name) => ipcRenderer.invoke('workspace-unwatch-file-root', workspacePath, status, name),
  browseProjectFiles: (workspacePath, status, name, relativePath, cacheConfig) => ipcRenderer.invoke('workspace-browse-files', workspacePath, status, name, relativePath, cacheConfig),
  inspectProjectToolSources: (workspacePath, status, name, relativePaths, collectVideos, collectDirectConvertibleImages, collectRecursiveConvertibleImages) => ipcRenderer.invoke('workspace-inspect-tool-sources', workspacePath, status, name, relativePaths, collectVideos, collectDirectConvertibleImages, collectRecursiveConvertibleImages),
  resolveProjectShortcut: (workspacePath, status, name, relativePath) => ipcRenderer.invoke('workspace-resolve-shortcut', workspacePath, status, name, relativePath),
  materializeProjectExternalLinks: (workspacePath, status, name, relativePaths) => ipcRenderer.invoke('workspace-materialize-external-links', workspacePath, status, name, relativePaths),
  relinkProjectExternalFolder: (workspacePath, status, name, relativePath) => ipcRenderer.invoke('workspace-relink-external-folder', workspacePath, status, name, relativePath),
  browseProjectShortcutPreview: (workspacePath, status, name, relativePath) => ipcRenderer.invoke('workspace-browse-shortcut-preview', workspacePath, status, name, relativePath),
  searchProjectFiles: (workspacePath, status, name, scopeRelativePath, query) => ipcRenderer.invoke('workspace-search-files', workspacePath, status, name, scopeRelativePath, query),
  listProjectFiles: (workspacePath, status, name, scopeRelativePath, pageSize, cursor, filter) => ipcRenderer.invoke('workspace-list-files', workspacePath, status, name, scopeRelativePath, pageSize, cursor, filter),
  cancelListProjectFiles: cursor => ipcRenderer.invoke('workspace-cancel-list-files', cursor),
  listRecentProjectFiles: (workspacePath, status, name, scopeRelativePath, limit, cursor) => ipcRenderer.invoke('workspace-recent-files', workspacePath, status, name, scopeRelativePath, limit, cursor),
  cancelRecentProjectFiles: cursor => ipcRenderer.invoke('workspace-cancel-recent-files', cursor),
  listWorkspaceFolders: (workspacePath, status, name) => ipcRenderer.invoke('workspace-folder-tree', workspacePath, status, name),
  addInspirationToProject: (inspirationRoot, targetWorkspacePath, targetStatus, targetProjectName, relativePaths) => ipcRenderer.invoke('workspace-add-inspiration-to-project', inspirationRoot, targetWorkspacePath, targetStatus, targetProjectName, relativePaths),
  extractOfficeImages: (workspacePath, status, name, relativePaths) => invokeFeature('office_media_extract', 'workspace-extract-office-images', workspacePath, status, name, relativePaths),
  extractScreenshotMainImages: (workspacePath, status, name, relativePaths, options) => invokeFeature('screenshot_main_image', 'workspace-extract-screenshot-main-images', workspacePath, status, name, relativePaths, options),
  trimProjectVideo: (workspacePath, status, name, relativePath, request) => invokeFeature('video_trim', 'workspace-trim-video', workspacePath, status, name, relativePath, request),
  cancelProjectVideoTrim: operationId => ipcRenderer.invoke('workspace-cancel-video-trim', operationId),
  onProjectVideoTrimProgress: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('workspace-video-trim-progress', subscription); return () => ipcRenderer.removeListener('workspace-video-trim-progress', subscription); },
  getProjectVideoTimelineFrames: (workspacePath, status, name, relativePath, times) => invokeFeature('video_trim', 'workspace-video-timeline-frames', workspacePath, status, name, relativePath, times),
  onScreenshotMainImageProgress: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('workspace-screenshot-main-image-progress', subscription); return () => ipcRenderer.removeListener('workspace-screenshot-main-image-progress', subscription); },
  getProjectFileDetails: (workspacePath, status, name, relativePaths) => ipcRenderer.invoke('workspace-file-details', workspacePath, status, name, relativePaths),
  getProjectEntryDetails: (workspacePath, status, name, relativePath) => ipcRenderer.invoke('workspace-entry-details', workspacePath, status, name, relativePath),
  getMediaVersions: (workspacePath, status, name, relativePath) => ipcRenderer.invoke('workspace-media-versions', workspacePath, status, name, relativePath),
  updateMediaVersion: (workspacePath, request) => ipcRenderer.invoke('workspace-version-update', workspacePath, request),
  relocateMediaVersion: (workspacePath, status, projectName, request) => ipcRenderer.invoke('workspace-version-relocate', workspacePath, status, projectName, request),
  deleteMediaVersion: (workspacePath, request) => ipcRenderer.invoke('workspace-version-delete', workspacePath, request),
  getMediaVersionDeleteScope: (workspacePath, versionId) => ipcRenderer.invoke('workspace-version-delete-scope', workspacePath, versionId),
  deleteProjectMissingMediaVersion: (workspacePath, versionId) => ipcRenderer.invoke('workspace-version-delete-project-missing', workspacePath, versionId),
  recordMediaVersionCompare: (workspacePath, request) => ipcRenderer.invoke('workspace-version-compare-record', workspacePath, request),
  openMediaVersion: (filePath) => ipcRenderer.invoke('workspace-open-version', filePath),
  getProgressFolders: (workspacePath, projectName) => ipcRenderer.invoke('workspace-progress-folders', workspacePath, projectName),
  getSelectionSourceFolders: (projectPath, request = {}) => ipcRenderer.invoke('workspace-selection-source-folders', projectPath, {
    cursor: request?.cursor,
    pageSize: request?.pageSize,
    operationId: request?.operationId,
  }),
  preflightFilenameSelection: (projectPath, request) => ipcRenderer.invoke('workspace-selection-filename-preflight', projectPath, request),
  executeFilenameSelection: (projectPath, request) => ipcRenderer.invoke('workspace-selection-filename-execute', projectPath, request),
  preflightManualSelection: (projectPath, request) => ipcRenderer.invoke('workspace-selection-manual-preflight', projectPath, request),
  executeManualSelection: (projectPath, request) => ipcRenderer.invoke('workspace-selection-manual-execute', projectPath, request),
  cancelSelectionOperation: (operationId) => ipcRenderer.invoke('workspace-selection-cancel', operationId),
  onSelectionOperationProgress: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('workspace-selection-progress', subscription); return () => ipcRenderer.removeListener('workspace-selection-progress', subscription); },
  getFinalVersionSummary: (workspacePath, status, projectName) => ipcRenderer.invoke('workspace-final-version-summary', workspacePath, status, projectName),
  browseFinalVersions: (workspacePath, status, projectName) => ipcRenderer.invoke('workspace-final-version-browse', workspacePath, status, projectName),
  exportFinalVersions: (workspacePath, status, projectName, request) => invokeFeature('final_version_export', 'workspace-final-version-export', workspacePath, status, projectName, { parentProgressId: request?.parentProgressId }),
  getMediaRating: filePath => ipcRenderer.invoke('workspace-media-rating-read', filePath),
  getMediaRatings: entries => ipcRenderer.invoke('workspace-media-rating-read-batch', entries),
  setMediaRating: (workspacePath, filePath, rating) => ipcRenderer.invoke('workspace-media-rating-write', workspacePath, filePath, rating),
  createProgressFolder: (workspacePath, status, projectName, request) => ipcRenderer.invoke('workspace-create-progress-folder', workspacePath, status, projectName, request),
  registerProgressWithGraph: (workspacePath, status, request) => ipcRenderer.invoke('workspace-progress-register-with-graph', workspacePath, status, {
    projectName: request?.projectName,
    progress: omitUndefined({
      progressId: request?.progress?.progressId,
      relativePath: request?.progress?.relativePath,
      mediaKind: request?.progress?.mediaKind,
      versionKey: request?.progress?.versionKey,
      parentProgressId: request?.progress?.parentProgressId,
      displayName: request?.progress?.displayName,
      trackingEnabled: request?.progress?.trackingEnabled,
      trackingState: request?.progress?.trackingState,
      renameFromParent: request?.progress?.renameFromParent,
      copyMissingFromParent: request?.progress?.copyMissingFromParent,
      moveToRoot: request?.progress?.moveToRoot,
    }),
    workflowInputProgressIds: request?.workflowInputProgressIds,
  }),
  adoptVersionTreeFolder: (workspacePath, status, request) => ipcRenderer.invoke('workspace-progress-adopt-media', workspacePath, status, {
    projectName: request?.projectName,
    relativePath: request?.relativePath,
    mode: request?.mode,
    mediaKind: request?.mediaKind,
    sourceProgressId: request?.sourceProgressId,
  }),
  registerProgressFolder: (workspacePath, status, projectName, request) => ipcRenderer.invoke('workspace-progress-register', workspacePath, status, projectName, request),
  updateProgressFolder: (workspacePath, status, projectName, request) => ipcRenderer.invoke('workspace-progress-update', workspacePath, status, projectName, {
    progressId: request?.progressId,
    mediaKind: request?.mediaKind,
    versionKey: request?.versionKey,
    parentProgressId: request?.parentProgressId,
    trackingEnabled: request?.trackingEnabled,
    trackingState: request?.trackingState,
    renameFromParent: request?.renameFromParent,
    copyMissingFromParent: request?.copyMissingFromParent,
  }),
  renameProgressFolder: (workspacePath, status, projectName, request) => ipcRenderer.invoke('workspace-progress-folder-rename', workspacePath, status, projectName, {
    progressId: request?.progressId,
    expectedFolderId: request?.expectedFolderId,
    expectedRelativePath: request?.expectedRelativePath,
    newName: request?.newName,
  }),
  updateProgressRelation: (workspacePath, projectName, request) => ipcRenderer.invoke('workspace-progress-relation-update', workspacePath, projectName, {
    childProgressId: request?.childProgressId,
    parentProgressId: request?.parentProgressId ?? null,
    expectedUpdatedAt: request?.expectedUpdatedAt,
  }),
  repairLegacySelectionRelation: (workspacePath, projectName, request) => ipcRenderer.invoke('workspace-legacy-selection-relation-repair', workspacePath, projectName, {
    progressId: request?.progressId,
    sourceProgressId: request?.sourceProgressId,
    action: request?.action,
  }),
  commitMediaWorkflowImport: (workspacePath, manifest) => ipcRenderer.invoke('workspace-media-workflow-import-commit', workspacePath, manifest),
  recoverMediaWorkflowImports: workspacePath => ipcRenderer.invoke('workspace-media-workflow-import-recover', workspacePath),
  createVersionGraphEdge: (workspacePath, request) => ipcRenderer.invoke('workspace-version-graph-edge-create', workspacePath, {
    projectId: request?.projectId,
    sourceProgressId: request?.sourceProgressId,
    targetProgressId: request?.targetProgressId,
    edgeKind: request?.edgeKind,
  }),
  deleteVersionGraphEdge: (workspacePath, request) => ipcRenderer.invoke('workspace-version-graph-edge-delete', workspacePath, {
    projectId: request?.projectId,
    sourceProgressId: request?.sourceProgressId,
    targetProgressId: request?.targetProgressId,
    edgeKind: request?.edgeKind,
  }),
  replaceVersionGraphEdgeSource: (workspacePath, request) => ipcRenderer.invoke('workspace-version-graph-edge-replace-source', workspacePath, {
    projectId: request?.projectId,
    sourceProgressId: request?.sourceProgressId,
    targetProgressId: request?.targetProgressId,
    edgeKind: request?.edgeKind,
    newSourceProgressId: request?.newSourceProgressId,
  }),
  getVersionTreeLayout: (workspacePath, projectName, scopeKey) => ipcRenderer.invoke('workspace-version-tree-layout-get', workspacePath, projectName, scopeKey),
  saveVersionTreeLayout: (workspacePath, projectName, request) => ipcRenderer.invoke('workspace-version-tree-layout-save', workspacePath, projectName, {
    scopeKey: request?.scopeKey,
    expectedRevision: request?.expectedRevision,
    mode: request?.mode,
    positions: Array.isArray(request?.positions) ? request.positions.map(position => ({ nodeKey: position?.nodeKey, x: position?.x, y: position?.y })) : [],
  }),
  unregisterProgressFolder: (workspacePath, projectName, progressId) => ipcRenderer.invoke('workspace-progress-unregister', workspacePath, projectName, progressId),
  deleteMissingProgressFolder: (workspacePath, projectName, progressId) => ipcRenderer.invoke('workspace-progress-delete-missing', workspacePath, projectName, progressId),
  registerVersionBaseline: (workspacePath, status, projectName, relativePath) => ipcRenderer.invoke('workspace-version-register-baseline', workspacePath, status, projectName, relativePath),
  compareVersionFolders: (workspacePath, status, projectName, referenceRelativePath, sourceRelativePath, sourceNames) => invokeFeature('version_folder_compare', 'workspace-version-compare-preview', workspacePath, status, projectName, referenceRelativePath, sourceRelativePath, sourceNames),
  commitVersionBatch: (workspacePath, status, projectName, request) => ipcRenderer.invoke('workspace-version-batch-commit', workspacePath, status, projectName, request),
  startProgressTracking: (workspacePath, projectName, request) => ipcRenderer.invoke('workspace-progress-tracking-start', workspacePath, projectName, request),
  getProgressTrackingSession: (workspacePath, request) => ipcRenderer.invoke('workspace-progress-tracking-session', workspacePath, request),
  releaseProgressTrackingSession: (workspacePath, request) => ipcRenderer.invoke('workspace-progress-tracking-session-release', workspacePath, request),
  decideProgressTrackingItem: (workspacePath, request) => ipcRenderer.invoke('workspace-progress-tracking-decide', workspacePath, request),
  commitProgressTracking: (workspacePath, request) => ipcRenderer.invoke('workspace-progress-tracking-commit', workspacePath, request),
  getProgressMainBranchMedia: (workspacePath, request) => ipcRenderer.invoke('workspace-progress-main-branch-media', workspacePath, request),
  getVersionBatchOperations: (workspacePath, batchId) => ipcRenderer.invoke('workspace-version-batch-operations', workspacePath, batchId),
  retryVersionBatchOperations: (workspacePath, batchId) => ipcRenderer.invoke('workspace-version-batch-retry', workspacePath, batchId),
  getMediaThumbnail: (filePath, kind, cacheConfig, requestedSize, priority, queueOrder) => ipcRenderer.invoke('media-thumbnail', filePath, kind, cacheConfig, requestedSize, priority, queueOrder),
  cancelMediaThumbnail: (filePath, requestedSize) => ipcRenderer.invoke('media-thumbnail-cancel', filePath, requestedSize),
  onThumbnailStateChanged: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('thumbnail-state-changed', subscription); return () => ipcRenderer.removeListener('thumbnail-state-changed', subscription); },
  startAdvancedVideo: (filePath, arrowKeyAction, playerId, requestId) => ipcRenderer.invoke('advanced-video-start', filePath, arrowKeyAction, playerId, requestId),
  startVideoPlayer: (filePath, settings, playerId, requestId, backendId) => ipcRenderer.invoke('video-player-start', filePath, settings, playerId, requestId, backendId),
  getVideoPlaybackBackends: (filePath, browserProbe) => ipcRenderer.invoke('video-playback-backends', filePath, browserProbe),
  getVideoDisplayCapabilities: () => ipcRenderer.invoke('video-display-capabilities'),
  getVideoPlaybackSource: filePath => ipcRenderer.invoke('video-playback-source', filePath),
  setVideoPlayerBounds: (sessionId, bounds) => ipcRenderer.send('video-player-bounds', sessionId, bounds),
  setAdvancedVideoBounds: (sessionId, bounds) => ipcRenderer.send('advanced-video-bounds', sessionId, bounds),
  controlAdvancedVideo: (sessionId, request) => ipcRenderer.send('advanced-video-control', sessionId, request),
  controlVideoPlayer: (sessionId, request) => ipcRenderer.send('video-player-control', sessionId, request),
  chooseVideoSubtitle: sessionId => ipcRenderer.invoke('video-player-subtitle-choose', sessionId),
  chooseVideoSubtitleFile: () => ipcRenderer.invoke('video-subtitle-choose-file'),
  addVideoSubtitle: (sessionId, filePath) => ipcRenderer.invoke('video-player-subtitle-add', sessionId, filePath),
  captureVideoPlayerFrame: (sessionId, mode) => ipcRenderer.invoke('video-player-screenshot', sessionId, mode),
  publishVideoPlayerFrame: (filePath, bytes) => ipcRenderer.invoke('video-player-publish-frame', filePath, bytes),
  stopVideoPlayer: sessionId => ipcRenderer.invoke('video-player-stop', sessionId),
  onVideoPlayerState: callback => { const subscription = (_event, value) => callback(value); ipcRenderer.on('video-player-state', subscription); return () => ipcRenderer.removeListener('video-player-state', subscription); },
  captureAdvancedVideoFrame: (sessionId) => ipcRenderer.invoke('advanced-video-screenshot', sessionId),
  stopAdvancedVideo: (sessionId) => ipcRenderer.invoke('advanced-video-stop', sessionId),
  onAdvancedVideoState: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('advanced-video-state', subscription); return () => ipcRenderer.removeListener('advanced-video-state', subscription); },
  getMediaOriginal: (filePath, kind, cacheConfig) => ipcRenderer.invoke('media-original', filePath, kind, cacheConfig),
  getMediaMetadata: (filePath) => ipcRenderer.invoke('media-metadata', filePath),
  reportRendererError: (message, details) => ipcRenderer.send('renderer-error-log', message, details),
  reportRendererInfo: (message, details) => ipcRenderer.send('renderer-info-log', message, details),
  trackTelemetry: (eventName, properties) => ipcRenderer.send('telemetry-track', eventName, properties),
  onAppError: (callback) => { const subscription = (_event, message) => callback(message); ipcRenderer.on('app-error', subscription); return () => ipcRenderer.removeListener('app-error', subscription); },
  onComponentNotification: (callback) => {
    return subscribeComponentNotification(callback);
  },
  getRawPreview: (filePath, cacheConfig) => ipcRenderer.invoke('media-raw-preview', filePath, cacheConfig),
  projectFileOperation: (workspacePath, status, projectName, operation, paths, targetRelativePath, nextName, options) => ipcRenderer.invoke('workspace-file-operation', workspacePath, status, projectName, operation, paths, targetRelativePath, nextName, options),
  getProjectFileClipboardStatus: () => ipcRenderer.invoke('workspace-file-clipboard-status'),
  cancelProjectFileCut: (workspacePath, status, projectName, paths) => ipcRenderer.invoke('workspace-cancel-file-cut', workspacePath, status, projectName, paths),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  startProjectFileDrag: (workspacePath, status, projectName, paths, context) => ipcRenderer.send('workspace-start-file-drag', workspacePath, status, projectName, paths, context),
  onProjectFileDragEnd: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('workspace-file-drag-ended', subscription); return () => ipcRenderer.removeListener('workspace-file-drag-ended', subscription); },
  onProjectFileOperationProgress: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('workspace-file-operation-progress', subscription); return () => ipcRenderer.removeListener('workspace-file-operation-progress', subscription); },
  cancelProjectFileOperation: (operationId) => ipcRenderer.invoke('workspace-cancel-file-operation', operationId),
  chooseCacheDirectory: () => ipcRenderer.invoke('choose-cache-directory'),
  chooseWorkspaceDirectory: (currentPath) => ipcRenderer.invoke('choose-workspace-directory', currentPath),
  chooseImportSourceFiles: () => ipcRenderer.invoke('choose-import-source-files'),
  chooseProjectImportFiles: () => ipcRenderer.invoke('choose-project-import-files'),
  chooseBrollSourceFiles: () => ipcRenderer.invoke('choose-broll-source-files'),
  chooseVideoFiles: () => ipcRenderer.invoke('choose-video-files'),
  chooseVideoFolder: () => ipcRenderer.invoke('choose-video-folder'),
  inspectSourcePaths: (paths, options) => ipcRenderer.invoke('inspect-source-paths', paths, options),
  getMediaCacheInfo: (cacheConfig) => ipcRenderer.invoke('media-cache-info', cacheConfig),
  clearMediaCache: (cacheConfig, olderThanDays, options) => ipcRenderer.invoke('media-cache-clear', cacheConfig, olderThanDays, options),
  getStorageUsageOverview: (force) => ipcRenderer.invoke('storage-usage-overview', force),
  getBackgroundTasks: () => ipcRenderer.invoke('background-tasks-list'),
  cancelBackgroundTask: (id) => ipcRenderer.invoke('background-task-cancel', id),
  pauseBackgroundTask: (id) => ipcRenderer.invoke('background-task-pause', id),
  continueBackgroundTask: (id) => ipcRenderer.invoke('background-task-continue', id),
  dismissBackgroundTask: (id) => ipcRenderer.invoke('background-task-dismiss', id),
  resumeBackgroundTask: (id) => ipcRenderer.invoke('background-task-resume', id),
  restartBackgroundTask: (id) => ipcRenderer.invoke('background-task-restart', id),
  retryBackgroundTask: (id) => ipcRenderer.invoke('background-task-retry', id),
  onBackgroundTaskChanged: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('background-task-changed', subscription); return () => ipcRenderer.removeListener('background-task-changed', subscription); },
  chooseBackupTarget: (currentPath) => ipcRenderer.invoke('backup-choose-target', currentPath),
  getBackupStatus: (workspacePath) => ipcRenderer.invoke('backup-status', workspacePath),
  setNasBackupTarget: (targetPath) => ipcRenderer.invoke('backup-set-nas-target', targetPath),
  saveNasCredential: (request) => ipcRenderer.invoke('backup-save-nas-credential', request),
  readNasCredential: (credentialRef) => ipcRenderer.invoke('backup-read-nas-credential', credentialRef),
  deleteNasCredential: (credentialRef) => ipcRenderer.invoke('backup-delete-nas-credential', credentialRef),
  testBackupConnection: () => ipcRenderer.invoke('backup-test-connection'),
  getBackupSpaceStatus: (workspacePath) => ipcRenderer.invoke('backup-space-status', workspacePath),
  cleanupBackup: (workspacePath) => ipcRenderer.invoke('backup-cleanup', workspacePath),
  runBackup: (workspacePath, reason) => ipcRenderer.invoke('backup-run', workspacePath, reason),
  runBackupIfDue: (workspacePath) => ipcRenderer.invoke('backup-run-if-due', workspacePath),
  verifyBackup: (workspacePath, snapshotId) => ipcRenderer.invoke('backup-verify', workspacePath, snapshotId),
  verifyDomainStorage: (workspacePath, domain) => ipcRenderer.invoke('backup-domain-verify', workspacePath, domain),
  runDomainBackup: (workspacePath, domain) => ipcRenderer.invoke('backup-domain-run', workspacePath, domain),
  restoreDomainBackup: (workspacePath, snapshotId, domain) => ipcRenderer.invoke('backup-domain-restore', workspacePath, snapshotId, domain),
  resetDomainStorage: (workspacePath, domain) => ipcRenderer.invoke('backup-domain-reset', workspacePath, domain),
  restoreBackupWorkspace: (workspacePath, snapshotId) => ipcRenderer.invoke('backup-restore-workspace', workspacePath, snapshotId),
  restoreBackupProject: (workspacePath, snapshotId, projectId) => ipcRenderer.invoke('backup-restore-project', workspacePath, snapshotId, projectId),
  openBackupTarget: () => ipcRenderer.invoke('backup-open-target'),
  chooseArchiveTarget: (currentPath) => ipcRenderer.invoke('archive-choose-target', currentPath),
  getArchiveStatus: () => ipcRenderer.invoke('archive-status'),
  archiveWorkspaceProject: (workspacePath, projectName) => ipcRenderer.invoke('archive-project', workspacePath, projectName),
  moveArchivedProjectBack: (workspacePath, projectName, statusAfter) => ipcRenderer.invoke('archive-move-back', workspacePath, projectName, statusAfter),
  openArchiveTarget: () => ipcRenderer.invoke('archive-open-target'),
  openWorkspaceProject: (workspacePath, status, name, folderName) => ipcRenderer.invoke('workspace-open-project', workspacePath, status, name, folderName),
  openProjectEntry: (workspacePath, status, name, relativePath) => ipcRenderer.invoke('workspace-open-entry', workspacePath, status, name, relativePath),
  getPhotoshopStatus: () => ipcRenderer.invoke('photoshop-status'),
  openProjectEntriesInPhotoshop: (workspacePath, status, name, relativePaths) => invokeFeature('photoshop_open', 'workspace-open-entry-photoshop', workspacePath, status, name, relativePaths),
  copyProjectEntryPath: (workspacePath, status, name, relativePath) => ipcRenderer.invoke('workspace-copy-entry-path', workspacePath, status, name, relativePath),
  getFileIcon: (filePath) => ipcRenderer.invoke('workspace-entry-file-icon', filePath),
  importProjectFiles: (workspacePath, status, name, relativePath, options) => ipcRenderer.invoke('workspace-import-files', workspacePath, status, name, relativePath, options),
  importProgressFiles: (workspacePath, status, name, folderName, options) => ipcRenderer.invoke('workspace-import-progress-files', workspacePath, status, name, folderName, options),
  importBroll: (workspacePath, status, name, options) => ipcRenderer.invoke('workspace-import-broll', workspacePath, status, name, options),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window-toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isWindowMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  setWindowFullscreen: (enabled) => ipcRenderer.invoke('window-set-fullscreen', enabled),
  onWindowMaximizedChange: (callback) => { const subscription = (_event, maximized) => callback(maximized); ipcRenderer.on('window-maximized-change', subscription); return () => ipcRenderer.removeListener('window-maximized-change', subscription); },
});
