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
  openWorkspaceProject: (workspacePath, status, name, folderName) => ipcRenderer.invoke('workspace-open-project', workspacePath, status, name, folderName),
  importBroll: (workspacePath, status, name, options) => ipcRenderer.invoke('workspace-import-broll', workspacePath, status, name, options),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
});
