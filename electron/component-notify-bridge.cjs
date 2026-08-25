const { normalizeNotificationPayload } = require('./services/component-notification-service.cjs');

const createComponentNotifyInvoker = invoke => payload => {
  const normalized = normalizeNotificationPayload(payload);
  return normalized.accepted === false ? Promise.resolve(normalized) : invoke(normalized);
};

module.exports = { createComponentNotifyInvoker };
