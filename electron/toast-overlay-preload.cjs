const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastOverlay', Object.freeze({
  onSnapshot: callback => {
    if (typeof callback !== 'function') throw new TypeError('Toast snapshot callback must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('toast-overlay:snapshot', listener);
    return () => ipcRenderer.removeListener('toast-overlay:snapshot', listener);
  },
  setPointerInteractive: interactive => ipcRenderer.send('toast-overlay:pointer-interactive', interactive === true),
  sendAction: (action, id) => ipcRenderer.send('toast-overlay:action', { action: String(action || ''), id: String(id || '') }),
}));
