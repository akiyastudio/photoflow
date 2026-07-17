const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  runScript: (scriptName, args) => ipcRenderer.send('run-python', scriptName, args),
  getBirthdays: () => ipcRenderer.invoke('get-birthdays'),
  saveBirthdays: (data) => ipcRenderer.invoke('save-birthdays', data),
  onPythonEvent: (callback) => {
    const subscription = (_event, value) => callback(value);
    ipcRenderer.on('python-event', subscription);
    return () => ipcRenderer.removeListener('python-event', subscription);
  },
  loadConfig: () => ipcRenderer.invoke('loadConfig'),
  saveConfig: (config) => ipcRenderer.invoke('saveConfig', config),
  getUserPath: () => ipcRenderer.invoke('getUserPath'),
  onUpdateAvailable: (callback) => {
    const subscription = (_event, value) => callback(value);
    ipcRenderer.on('update-available', subscription);
    return () => ipcRenderer.removeListener('update-available', subscription);
  },
  openExternal: (url) => ipcRenderer.send('open-external', url),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  checkScript: (scriptName) => ipcRenderer.invoke('check-script', scriptName),
  getDrives: () => ipcRenderer.invoke('getDrives'),
  getWorkspaceProjects: (workspacePath) => ipcRenderer.invoke('workspace-projects', workspacePath),
  onWorkspaceFilesChanged: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('workspace-files-changed', subscription); return () => ipcRenderer.removeListener('workspace-files-changed', subscription); },
  createWorkspaceProject: (workspacePath, date, name) => ipcRenderer.invoke('workspace-create-project', workspacePath, date, name),
  renameWorkspaceProject: (workspacePath, status, name, nextName) => ipcRenderer.invoke('workspace-rename-project', workspacePath, status, name, nextName),
  renameProjectFolder: (workspacePath, status, name, folderName, nextName) => ipcRenderer.invoke('workspace-rename-project-folder', workspacePath, status, name, folderName, nextName),
  createProjectFolder: (workspacePath, status, name, folderName) => ipcRenderer.invoke('workspace-create-project-folder', workspacePath, status, name, folderName),
  undoLastRename: () => ipcRenderer.invoke('workspace-undo-rename'),
  moveWorkspaceProject: (workspacePath, status, name, nextStatus) => ipcRenderer.invoke('workspace-move-project', workspacePath, status, name, nextStatus),
  archiveImportedProjects: (workspacePath) => ipcRenderer.invoke('workspace-archive-imports', workspacePath),
  trashWorkspaceProject: (workspacePath, status, name) => ipcRenderer.invoke('workspace-trash-project', workspacePath, status, name),
  getProjectContents: (workspacePath, status, name) => ipcRenderer.invoke('workspace-project-contents', workspacePath, status, name),
  browseProjectFiles: (workspacePath, status, name, relativePath, cacheConfig) => ipcRenderer.invoke('workspace-browse-files', workspacePath, status, name, relativePath, cacheConfig),
  getProjectFileDetails: (workspacePath, status, name, relativePaths) => ipcRenderer.invoke('workspace-file-details', workspacePath, status, name, relativePaths),
  getMediaThumbnail: (filePath, kind, cacheConfig, requestedSize) => ipcRenderer.invoke('media-thumbnail', filePath, kind, cacheConfig, requestedSize),
  getMediaOriginal: (filePath, kind, cacheConfig) => ipcRenderer.invoke('media-original', filePath, kind, cacheConfig),
  getMediaMetadata: (filePath) => ipcRenderer.invoke('media-metadata', filePath),
  getVideoHoverPreview: (filePath, cacheConfig, requestedSize, cacheOnly, generateHoverFrames) => ipcRenderer.invoke('media-video-hover-preview', filePath, cacheConfig, requestedSize, cacheOnly, generateHoverFrames),
  reportRendererError: (message, details) => ipcRenderer.send('renderer-error-log', message, details),
  onAppError: (callback) => { const subscription = (_event, message) => callback(message); ipcRenderer.on('app-error', subscription); return () => ipcRenderer.removeListener('app-error', subscription); },
  getRawPreview: (filePath, cacheConfig) => ipcRenderer.invoke('media-raw-preview', filePath, cacheConfig),
  folderHasPng: (folderPath) => ipcRenderer.invoke('folder-has-png', folderPath),
  projectFileOperation: (workspacePath, status, projectName, operation, paths, targetRelativePath, nextName, options) => ipcRenderer.invoke('workspace-file-operation', workspacePath, status, projectName, operation, paths, targetRelativePath, nextName, options),
  onProjectFileOperationProgress: (callback) => { const subscription = (_event, value) => callback(value); ipcRenderer.on('workspace-file-operation-progress', subscription); return () => ipcRenderer.removeListener('workspace-file-operation-progress', subscription); },
  cancelProjectFileOperation: (operationId) => ipcRenderer.invoke('workspace-cancel-file-operation', operationId),
  chooseCacheDirectory: () => ipcRenderer.invoke('choose-cache-directory'),
  getMediaCacheInfo: (cacheConfig) => ipcRenderer.invoke('media-cache-info', cacheConfig),
  clearMediaCache: (cacheConfig) => ipcRenderer.invoke('media-cache-clear', cacheConfig),
  openWorkspaceProject: (workspacePath, status, name, folderName) => ipcRenderer.invoke('workspace-open-project', workspacePath, status, name, folderName),
  openProjectEntry: (workspacePath, status, name, relativePath) => ipcRenderer.invoke('workspace-open-entry', workspacePath, status, name, relativePath),
  copyProjectEntryPath: (workspacePath, status, name, relativePath) => ipcRenderer.invoke('workspace-copy-entry-path', workspacePath, status, name, relativePath),
  getFileIcon: (filePath) => ipcRenderer.invoke('workspace-entry-file-icon', filePath),
  importBroll: (workspacePath, status, name, options) => ipcRenderer.invoke('workspace-import-broll', workspacePath, status, name, options),
  checkCompareFolders: (folderPaths) => ipcRenderer.invoke('workspace-check-compare-folders', folderPaths),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window-toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isWindowMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onWindowMaximizedChange: (callback) => { const subscription = (_event, maximized) => callback(maximized); ipcRenderer.on('window-maximized-change', subscription); return () => ipcRenderer.removeListener('window-maximized-change', subscription); },
});
