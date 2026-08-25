const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ComponentNotificationService, DURATION_MAX_MS, DURATION_MIN_MS, MESSAGE_MAX_LENGTH } = require('../electron/services/component-notification-service.cjs');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');
const { createComponentNotifyInvoker } = require('../electron/component-notify-bridge.cjs');
const { normalizeComponentNotificationRendererEvent, subscribeComponentNotification } = require('../electron/contracts/component-notification-renderer-event.cjs');

const sent = [];
const mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } };
let now = 10000;
const service = new ComponentNotificationService({ mainWindow, now: () => now });
service.setRendererReady(true);
const descriptor = componentId => ({ componentId, hostApiVersion: 4, service: { capabilities: ['notifications.v2'], permissions: ['notifications'] } });
const project = { surface: 'project' };

let result = service.publish(descriptor('alpha'), { tone: 'success', message: '  saved  ' }, project);
assert.deepStrictEqual(result, { apiVersion: 2, accepted: true, id: 'alpha:1' });
assert.deepStrictEqual(sent[0][1].notification, { tone: 'success', message: 'saved', durationMs: 3500 });
assert.equal(sent[0][0], 'component-host:notification.v2');
assert.equal(service.publish(descriptor('alpha'), { tone: 'success', message: 'saved' }, project).code, 'NOTIFICATION_DEDUPLICATED');
assert.equal(service.publish(descriptor('beta'), { tone: 'success', message: 'saved' }, project).accepted, true, 'dedupe is isolated by component');

for (const [payload, code] of [
  [{ tone: 'other', message: 'x' }, 'NOTIFICATION_INVALID_TONE'],
  [{ tone: 'info', message: ' ' }, 'NOTIFICATION_INVALID_MESSAGE'],
  [{ tone: 'info', message: 'x'.repeat(MESSAGE_MAX_LENGTH + 1) }, 'NOTIFICATION_INVALID_MESSAGE'],
  [{ tone: 'info', message: 'x', durationMs: DURATION_MIN_MS - 1 }, 'NOTIFICATION_INVALID_DURATION'],
  [{ tone: 'info', message: 'x', durationMs: DURATION_MAX_MS + 1 }, 'NOTIFICATION_INVALID_DURATION'],
  [{ tone: 'info', message: 'x', dedupeKey: '../bad' }, 'NOTIFICATION_INVALID_DEDUPE_KEY'],
  [{ tone: 'info', message: 'x', html: '<b>x</b>' }, 'NOTIFICATION_INVALID_PAYLOAD'],
]) assert.equal(service.publish(descriptor('validation'), payload, project).error.code, code);
assert.equal(service.publish({ ...descriptor('old'), hostApiVersion: 3 }, { tone: 'info', message: 'x' }, project).error.code, 'NOTIFICATION_HOST_API_REQUIRED');
assert.equal(service.publish({ ...descriptor('missing-cap'), service: { capabilities: [], permissions: ['notifications'] } }, { tone: 'info', message: 'x' }, project).error.code, 'NOTIFICATION_CAPABILITY_NOT_GRANTED');
assert.equal(service.publish({ ...descriptor('missing-perm'), service: { capabilities: ['notifications.v2'], permissions: [] } }, { tone: 'info', message: 'x' }, project).error.code, 'NOTIFICATION_PERMISSION_DENIED');
assert.equal(service.publish(descriptor('settings'), { tone: 'info', message: 'settings' }, { surface: 'application.settings' }).accepted, true);
assert.equal(service.publish(descriptor('validation-space'), { tone: 'info', message: `${' '.repeat(100000)}x` }, project).error.code, 'NOTIFICATION_INVALID_MESSAGE', 'raw length is bounded before trim');

for (let index = 0; index < 3; index += 1) assert.equal(service.publish(descriptor('rate'), { tone: 'info', message: `message-${index}` }, project).accepted, true);
assert.equal(service.publish(descriptor('rate'), { tone: 'info', message: 'message-4' }, project).error.code, 'NOTIFICATION_RATE_LIMITED');
assert.equal(service.publish(descriptor('rate'), { tone: 'error', message: 'critical-1' }, project).accepted, true, 'normal burst cannot suppress a critical error');
assert.equal(service.publish(descriptor('rate'), { tone: 'error', message: 'critical-2' }, project).accepted, true);
assert.equal(service.publish(descriptor('rate'), { tone: 'error', message: 'critical-3' }, project).error.code, 'NOTIFICATION_RATE_LIMITED', 'errors retain their own bounded quota');
now += 1001;
assert.equal(service.publish(descriptor('rate'), { tone: 'info', message: 'after-burst' }, project).accepted, true);
service.clearComponent('rate');
assert.equal(service.publish(descriptor('rate'), { tone: 'info', message: 'after-clear' }, project).accepted, true, 'unload/upgrade cleanup resets component state');

const unavailable = new ComponentNotificationService({ mainWindow: { isDestroyed: () => true } });
assert.equal(unavailable.publish(descriptor('alpha'), { tone: 'error', message: 'failure' }, project).error.code, 'NOTIFICATION_HOST_UNAVAILABLE');
const throwing = new ComponentNotificationService({ mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send() { throw new Error('destroyed-race'); } } } });
throwing.setRendererReady(true);
assert.deepStrictEqual(throwing.publish(descriptor('throwing'), { tone: 'error', message: 'failure' }, project).error, { code: 'NOTIFICATION_HOST_UNAVAILABLE', message: 'Main notification host is unavailable', retryable: true });

const bufferedSent = [];
const buffered = new ComponentNotificationService({ mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => bufferedSent.push(args) } }, now: () => now });
assert.equal(buffered.publish(descriptor('buffered'), { tone: 'info', message: 'before-ready' }, project).accepted, true);
assert.equal(bufferedSent.length, 0, 'accepted notifications wait for renderer readiness');
assert.deepStrictEqual(buffered.setRendererReady(true), { ready: true, flushed: 1 });
assert.equal(bufferedSent[0][1].notification.message, 'before-ready');
const reloadContents = new EventEmitter(); reloadContents.isDestroyed = () => false; reloadContents.send = (...args) => bufferedSent.push(args);
const reloadBuffered = new ComponentNotificationService({ mainWindow: { isDestroyed: () => false, webContents: reloadContents }, now: () => now });
reloadBuffered.setRendererReady(true); reloadContents.emit('did-start-loading');
assert.equal(reloadBuffered.publish(descriptor('reload'), { tone: 'info', message: 'during-reload' }, project).accepted, true);
assert.notEqual(bufferedSent.at(-1)[1].notification?.message, 'during-reload');
assert.equal(reloadBuffered.setRendererReady(true).flushed, 1, 'renderer reload buffers until the new React subscriber acknowledges readiness');
buffered.clearComponent('buffered');
assert.equal(bufferedSent.at(-1)[1].type, 'purge', 'component cleanup purges already rendered notifications');

let bridgeInvocations = 0;
const bridge = createComponentNotifyInvoker(async payload => { bridgeInvocations += 1; return payload; });
void bridge({ tone: 'info', message: `${' '.repeat(100000)}x` }).then(result => assert.equal(result.error.code, 'NOTIFICATION_INVALID_MESSAGE'));
void bridge({ tone: { deep: { value: 'info' } }, message: 'x' }).then(result => assert.equal(result.error.code, 'NOTIFICATION_INVALID_TONE'));
assert.equal(bridgeInvocations, 0, 'invalid renderer payloads never cross IPC');

const broker = new ComponentCapabilityBroker();
broker.register('notifications.v2', (payload, context, owned) => service.publish(owned, payload, context));
assert.equal(broker.invoke(descriptor('broker'), 'notifications.v2', { tone: 'info', message: 'broker' }, { surface: 'application.settings' }).accepted, true);
assert.throws(() => broker.invoke({ ...descriptor('broker-denied'), service: { capabilities: [], permissions: [] } }, 'notifications.v2', { tone: 'info', message: 'x' }, project), /not granted/);

const handlers = new Map();
const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
const directCalls = [];
const manager = new ComponentViewManager({ WebContentsView: function unused() {}, mainWindow: {}, registry: {}, preloadPath: 'component-preload.cjs', ipcMain, notificationService: { publish: (...args) => { directCalls.push(args); return { apiVersion: 2, accepted: true, id: 'direct' }; } } });
const notifyHandler = handlers.get('component-sdk:notify');
const sender = { id: 42 }; const otherSender = { id: 43 };
const instance = { view: { webContents: sender }, descriptor: descriptor('owner'), context: { componentId: 'owner', surface: 'project' } };
manager.senderBindings.set(sender.id, instance);
assert.equal(notifyHandler({ sender }, { tone: 'info', message: 'owned' }).accepted, true);
assert.equal(directCalls[0][0].componentId, 'owner');
assert.throws(() => notifyHandler({ sender: otherSender }, { tone: 'info', message: 'forged' }), error => error.code === 'NOTIFICATION_UNAUTHORIZED_SENDER');

const projectBounds = []; const settingsBounds = [];
const projectInstance = { instanceId: 'project', requestedBounds: { x: 10, y: 40, width: 800, height: 600 }, view: { setBounds: value => projectBounds.push(value) } };
const settingsInstance = { instanceId: 'settings', requestedBounds: { x: 0, y: 40, width: 1000, height: 700 }, view: { setBounds: value => settingsBounds.push(value) } };
projectInstance.logicalActive = true; settingsInstance.logicalActive = false; manager.activeInstanceId = 'project';
manager.instancesById.set('project', projectInstance); manager.instancesById.set('settings', settingsInstance);
manager.instances.set('project', projectInstance); manager.instances.set('settings', settingsInstance);
manager.setBounds('project', projectInstance.requestedBounds); manager.setBounds('settings', settingsInstance.requestedBounds);
manager.setHostToastReservation({ rendererToken: 'renderer-a', revision: 0, bottom: 112 });
assert.deepStrictEqual(projectBounds.at(-1), { x: 10, y: 112, width: 800, height: 528 });
manager.activeInstanceId = 'settings'; projectInstance.logicalActive = false; settingsInstance.logicalActive = true; manager.applyBounds(projectInstance); manager.applyBounds(settingsInstance);
assert.deepStrictEqual(settingsBounds.at(-1), { x: 0, y: 112, width: 1000, height: 628 }, 'settings surface uses the same visible host reservation');
assert.deepStrictEqual(projectBounds.at(-1), { x: 10, y: 40, width: 800, height: 600 }, 'switching tabs restores inactive component geometry');
manager.activeInstanceId = 'project'; projectInstance.logicalActive = true; settingsInstance.logicalActive = false;
manager.setHostToastReservation({ rendererToken: 'renderer-a', revision: 1, bottom: 180 });
assert.equal(projectBounds.at(-1).y, 180, 'multiple toast growth updates native geometry');
manager.setHostToastReservation({ rendererToken: 'renderer-a', revision: 2, bottom: 0 });
assert.deepStrictEqual(projectBounds.at(-1), { x: 10, y: 40, width: 800, height: 600 }, 'dismissal/expiry restores exact requested bounds');
assert.equal(manager.setHostToastReservation({ rendererToken: 'renderer-a', revision: 1, bottom: 300 }), false, 'stale revisions cannot reapply an overlay');

assert.deepStrictEqual(normalizeComponentNotificationRendererEvent({ apiVersion: 2, type: 'notification', id: 'alpha:1', componentId: 'alpha', surface: 'project', notification: { tone: 'success', message: 'saved', durationMs: 3500 } }).notification, { tone: 'success', message: 'saved', durationMs: 3500 });
assert.equal(normalizeComponentNotificationRendererEvent({ apiVersion: 2, type: 'notification', id: 'x', componentId: 'alpha', surface: 'project', notification: { tone: 'info', message: ' padded ', durationMs: 3500 } }), null);
assert.deepStrictEqual(normalizeComponentNotificationRendererEvent({ apiVersion: 2, type: 'purge', componentId: 'alpha' }), { apiVersion: 2, type: 'purge', componentId: 'alpha' });
const rendererEvents = new EventEmitter(); const normalizedEvents = [];
const unsubscribeRenderer = subscribeComponentNotification(rendererEvents, value => normalizedEvents.push(value));
rendererEvents.emit('component-host:notification.v2', {}, { apiVersion: 2, type: 'notification', id: 'alpha:2', componentId: 'alpha', surface: 'application.settings', notification: { tone: 'warning', message: 'review', durationMs: 3500 } });
assert.equal(normalizedEvents.length, 1); unsubscribeRenderer();
rendererEvents.emit('component-host:notification.v2', {}, { apiVersion: 2, type: 'purge', componentId: 'alpha' });
assert.equal(normalizedEvents.length, 1, 'preload subscription cleanup removes the private listener');

for (const file of ['legacy-main.tsx', 'settings-main.tsx', 'main.tsx']) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'team-retouch', 'renderer', 'src', file), 'utf8');
  assert(!/fixed bottom-5 (?:left-1\/2|right-5).*\{notice\}/.test(source), `${file} must not render a local bottom notification`);
}
console.log('component notification tests passed');
