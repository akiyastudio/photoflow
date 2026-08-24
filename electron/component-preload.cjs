const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') throw new TypeError('Component lifecycle callback must be a function');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const COMPONENT_EVENTS = Object.freeze({
  'advanced.progress': 'team-retouch-advanced-progress',
  'workflow.progress': 'workspace-team-workflow-progress',
  'patch.detect.progress': 'workspace-team-patch-detect-progress',
  'patch.detect-batch.progress': 'workspace-team-patch-detect-batch-progress',
  'patch.return-batch.progress': 'workspace-team-patch-return-batch-progress',
});

contextBridge.exposeInMainWorld('photoFlowComponent', Object.freeze({
  contractVersion: 1,
  getContext: () => ipcRenderer.invoke('component-sdk:get-context'),
  rpc: (method, payload) => ipcRenderer.invoke('component-sdk:rpc', String(method || ''), payload),
  onEvent: (topic, callback) => {
    const normalizedTopic = String(topic || '');
    if (typeof callback !== 'function') throw new TypeError('Component event callback must be a function');
    const channel = COMPONENT_EVENTS[normalizedTopic];
    if (channel) {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
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
