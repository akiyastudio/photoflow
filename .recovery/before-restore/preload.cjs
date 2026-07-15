const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  runScript: (scriptName, args) => ipcRenderer.send('run-python', scriptName, args),
  onLog: (callback) => {
    const subscription = (_event, value) => callback(value);
    ipcRenderer.on('python-log', subscription);
    return () => ipcRenderer.removeListener('python-log', subscription);
  },
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
  checkScript: (scriptName) => ipcRenderer.invoke('check-script', scriptName),
  getDrives: () => ipcRenderer.invoke('getDrives'),
});