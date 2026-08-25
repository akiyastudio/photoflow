const { contextBridge, ipcRenderer } = require('electron');
const { createComponentNotifyInvoker } = require('./component-notify-bridge.cjs');

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') throw new TypeError('Component lifecycle callback must be a function');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('photoFlowComponent', Object.freeze({
  // Bridge ABI version; Host API negotiation is reported by getContext().
  contractVersion: 1,
  getContext: () => ipcRenderer.invoke('component-sdk:get-context'),
  notify: createComponentNotifyInvoker(payload => ipcRenderer.invoke('component-sdk:notify', payload)),
  rpc: (method, payload) => ipcRenderer.invoke('component-sdk:rpc', String(method || ''), payload),
  onEvent: (topic, callback) => {
    const normalizedTopic = String(topic || '');
    if (typeof callback !== 'function') throw new TypeError('Component event callback must be a function');
    if (!/^[a-z][a-z0-9.-]{0,119}\.v[1-9][0-9]*$/.test(normalizedTopic)) throw new Error(`Invalid component event topic: ${normalizedTopic}`);
    const listener = (_event, value) => { if (value?.topic === normalizedTopic) callback(value.payload); };
    ipcRenderer.on('component-sdk:event', listener);
    return () => ipcRenderer.removeListener('component-sdk:event', listener);
  },
  onActivate: callback => subscribe('component-sdk:activate', callback),
  onDeactivate: callback => subscribe('component-sdk:deactivate', callback),
  onThemeChange: callback => subscribe('component-sdk:theme-changed', callback),
  onContextChange: callback => subscribe('component-sdk:context-changed', callback),
}));
