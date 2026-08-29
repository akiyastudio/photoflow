const { contextBridge, ipcRenderer, webUtils } = require('electron');

const notificationFailure = (code, message) => Object.freeze({ apiVersion: 7, accepted: false, error: Object.freeze({ code, message, retryable: false }) });
const normalizeNotification = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return notificationFailure('NOTIFICATION_INVALID_PAYLOAD', 'Notification payload must be an object');
  const unknown = Object.keys(value).find(key => !['tone', 'message', 'dedupeKey'].includes(key));
  if (unknown) return notificationFailure('NOTIFICATION_INVALID_PAYLOAD', `Unknown notification field: ${unknown}`);
  if (!['info', 'success', 'warning', 'error'].includes(value.tone)) return notificationFailure('NOTIFICATION_INVALID_TONE', 'Notification tone is invalid');
  if (typeof value.message !== 'string' || value.message.length > 360 || !value.message.trim()) return notificationFailure('NOTIFICATION_INVALID_MESSAGE', 'Notification message must contain 1-360 characters');
  if (value.dedupeKey !== undefined && (typeof value.dedupeKey !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(value.dedupeKey))) return notificationFailure('NOTIFICATION_INVALID_DEDUPE_KEY', 'Notification dedupeKey is invalid');
  return Object.freeze({ tone: value.tone, message: value.message.trim(), ...(value.dedupeKey ? { dedupeKey: value.dedupeKey } : {}) });
};
const notify = payload => { const normalized = normalizeNotification(payload); return normalized.accepted === false ? Promise.resolve(normalized) : ipcRenderer.invoke('component-sdk:notify', normalized); };
let contentSizeFrame = 0;
let lastContentSize = '';
const reportContentSize = () => {
  contentSizeFrame = 0;
  const body = document.body;
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const computed = getComputedStyle(body);
  const marginX = (Number.parseFloat(computed.marginLeft) || 0) + (Number.parseFloat(computed.marginRight) || 0);
  const marginY = (Number.parseFloat(computed.marginTop) || 0) + (Number.parseFloat(computed.marginBottom) || 0);
  const size = { width: Math.ceil(rect.width + marginX), height: Math.ceil(rect.height + marginY) };
  if (size.width < 1 || size.height < 1 || size.width > 20000 || size.height > 20000) return;
  const identity = `${size.width}:${size.height}`;
  if (identity === lastContentSize) return;
  lastContentSize = identity;
  void ipcRenderer.invoke('component-sdk:content-size', size).catch(() => undefined);
};
const scheduleContentSize = () => { if (!contentSizeFrame) contentSizeFrame = requestAnimationFrame(reportContentSize); };
window.addEventListener('DOMContentLoaded', () => {
  const observer = new ResizeObserver(scheduleContentSize);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  const mutations = new MutationObserver(scheduleContentSize);
  if (document.body) mutations.observe(document.body, { attributes: true, childList: true, subtree: true });
  scheduleContentSize();
}, { once: true });

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
  authorizeFiles: files => {
    const filePaths = Array.from(files || []).slice(0, 120).map(file => {
      try { return webUtils.getPathForFile(file); } catch { return ''; }
    }).filter(Boolean);
    return ipcRenderer.invoke('component-sdk:authorize-files', filePaths);
  },
  notify,
  dialog: payload => ipcRenderer.invoke('component-sdk:dialog', payload),
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
