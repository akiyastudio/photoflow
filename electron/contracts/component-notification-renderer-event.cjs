const TONES = new Set(['info', 'success', 'warning', 'error']);
const DEDUPE_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

const normalizeComponentNotificationRendererEvent = value => {
  if (!value || typeof value !== 'object' || value.apiVersion !== 7 || typeof value.componentId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.componentId)) return null;
  if (value.type === 'purge') return Object.freeze({ apiVersion: 7, type: 'purge', componentId: value.componentId });
  if (value.type !== 'notification' || typeof value.id !== 'string' || !['project', 'application.settings', 'component.sidePanel', 'media.contextAction', 'project.contextAction', 'project.importProvider', 'project.exportProvider', 'application.command'].includes(value.surface)) return null;
  const notification = value.notification;
  if (!notification || Object.keys(notification).some(key => !['tone', 'message', 'dedupeKey'].includes(key)) || !TONES.has(notification.tone) || typeof notification.message !== 'string' || notification.message !== notification.message.trim() || notification.message.length < 1 || notification.message.length > 360 || (notification.dedupeKey !== undefined && (typeof notification.dedupeKey !== 'string' || !DEDUPE_KEY.test(notification.dedupeKey)))) return null;
  return Object.freeze({ apiVersion: 7, type: 'notification', id: value.id, componentId: value.componentId, surface: value.surface, notification: Object.freeze({ tone: notification.tone, message: notification.message, ...(notification.dedupeKey ? { dedupeKey: notification.dedupeKey } : {}) }) });
};

const subscribeComponentNotification = (ipcRenderer, callback) => {
  if (typeof callback !== 'function') throw new TypeError('Component notification callback must be a function');
  const listener = (_event, value) => { const normalized = normalizeComponentNotificationRendererEvent(value); if (normalized) callback(normalized); };
  ipcRenderer.on('component-host:notification.v7', listener);
  return () => ipcRenderer.removeListener('component-host:notification.v7', listener);
};

module.exports = { normalizeComponentNotificationRendererEvent, subscribeComponentNotification };
