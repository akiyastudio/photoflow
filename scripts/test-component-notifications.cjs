const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ComponentNotificationService, MESSAGE_MAX_LENGTH } = require('../electron/services/component-notification-service.cjs');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');
const { normalizeComponentNotificationRendererEvent, subscribeComponentNotification } = require('../electron/contracts/component-notification-renderer-event.cjs');
const mainPreloadSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
assert(!mainPreloadSource.includes("require('./contracts/component-notification-renderer-event.cjs')") && mainPreloadSource.includes('const subscribeComponentNotification = callback =>'), 'sandboxed main preload must inline notification validation instead of requiring a local CommonJS module');

const sent = [];
const mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } };
let now = 10000;
const service = new ComponentNotificationService({ mainWindow, now: () => now });
service.setRendererReady({ rendererToken: 'renderer-main', revision: 0, ready: true });
const descriptor = componentId => ({ componentId, hostApiVersion: 4, service: { capabilities: ['notifications.v2'], permissions: ['notifications'] } });
const project = { surface: 'project' };

let result = service.publish(descriptor('alpha'), { tone: 'success', message: '  saved  ' }, project);
assert.deepStrictEqual(result, { apiVersion: 2, accepted: true, id: 'alpha:1' });
assert.deepStrictEqual(sent[0][1].notification, { tone: 'success', message: 'saved' });
assert.equal(sent[0][0], 'component-host:notification.v2');
assert.equal(service.publish(descriptor('alpha'), { tone: 'success', message: 'saved' }, project).code, 'NOTIFICATION_DEDUPLICATED');
assert.equal(service.publish(descriptor('beta'), { tone: 'success', message: 'saved' }, project).accepted, true, 'dedupe is isolated by component');

for (const [payload, code] of [
  [{ tone: 'other', message: 'x' }, 'NOTIFICATION_INVALID_TONE'],
  [{ tone: 'info', message: ' ' }, 'NOTIFICATION_INVALID_MESSAGE'],
  [{ tone: 'info', message: 'x'.repeat(MESSAGE_MAX_LENGTH + 1) }, 'NOTIFICATION_INVALID_MESSAGE'],
  [{ tone: 'info', message: 'x', durationMs: 3500 }, 'NOTIFICATION_INVALID_PAYLOAD'],
  [{ tone: 'info', message: 'x', dedupeKey: '../bad' }, 'NOTIFICATION_INVALID_DEDUPE_KEY'],
  [{ tone: 'info', message: 'x', html: '<b>x</b>' }, 'NOTIFICATION_INVALID_PAYLOAD'],
]) assert.equal(service.publish(descriptor('validation'), payload, project).error.code, code);
assert.equal(service.publish({ ...descriptor('old'), hostApiVersion: 3 }, { tone: 'info', message: 'x' }, project).error.code, 'NOTIFICATION_HOST_API_REQUIRED');
for (const hostApiVersion of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '4']) assert.equal(service.publish({ ...descriptor('invalid-host-api'), hostApiVersion }, { tone: 'info', message: 'x' }, project).error.code, 'NOTIFICATION_HOST_API_REQUIRED', `invalid host API ${String(hostApiVersion)} must fail closed`);
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
throwing.setRendererReady({ rendererToken: 'renderer-throwing', revision: 0, ready: true });
assert.deepStrictEqual(throwing.publish(descriptor('throwing'), { tone: 'error', message: 'failure' }, project).error, { code: 'NOTIFICATION_HOST_UNAVAILABLE', message: 'Main notification host is unavailable', retryable: true });

const bufferedSent = [];
const buffered = new ComponentNotificationService({ mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => bufferedSent.push(args) } }, now: () => now });
assert.equal(buffered.publish(descriptor('buffered'), { tone: 'info', message: 'before-ready' }, project).accepted, true);
assert.equal(bufferedSent.length, 0, 'accepted notifications wait for renderer readiness');
assert.deepStrictEqual(buffered.setRendererReady({ rendererToken: 'renderer-buffered', revision: 0, ready: true }), { ready: true, flushed: 1 });
assert.equal(bufferedSent[0][1].notification.message, 'before-ready');
const reloadContents = new EventEmitter(); reloadContents.isDestroyed = () => false; reloadContents.send = (...args) => bufferedSent.push(args);
const reloadBuffered = new ComponentNotificationService({ mainWindow: { isDestroyed: () => false, webContents: reloadContents }, now: () => now });
reloadBuffered.setRendererReady({ rendererToken: 'renderer-old', revision: 0, ready: true }); reloadContents.emit('did-start-loading');
assert.equal(reloadBuffered.publish(descriptor('reload'), { tone: 'info', message: 'during-reload' }, project).accepted, true);
assert.notEqual(bufferedSent.at(-1)[1].notification?.message, 'during-reload');
assert.equal(reloadBuffered.setRendererReady({ rendererToken: 'renderer-old', revision: 99, ready: true }).stale, true, 'reload retires the old token even when it claims a higher revision');
assert.equal(reloadBuffered.setRendererReady({ rendererToken: 'renderer-new', revision: 0, ready: true }).flushed, 1, 'renderer reload buffers until the new React subscriber acknowledges readiness');
assert.equal(reloadBuffered.setRendererReady({ rendererToken: 'renderer-old', revision: 100, ready: false }).stale, true, 'old document cleanup cannot overwrite new readiness');
reloadContents.emit('render-process-gone');
assert.equal(reloadBuffered.publish(descriptor('reload'), { tone: 'error', message: 'after-crash' }, project).accepted, true);
assert.notEqual(bufferedSent.at(-1)[1].notification?.message, 'after-crash', 'renderer crash makes delivery unready before reload starts');
assert.equal(reloadBuffered.setRendererReady({ rendererToken: 'renderer-after-crash', revision: 0, ready: true }).flushed, 1);
reloadBuffered.destroy();
assert.equal(reloadContents.listenerCount('did-start-loading'), 0); assert.equal(reloadContents.listenerCount('render-process-gone'), 0, 'destroy removes every renderer lifecycle listener');
buffered.clearComponent('buffered');
assert.equal(bufferedSent.at(-1)[1].type, 'purge', 'component cleanup purges already rendered notifications');
const ttlSent = []; let ttlNow = 50000;
const ttlBuffered = new ComponentNotificationService({ mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => ttlSent.push(args) } }, now: () => ttlNow });
for (let index = 0; index < 32; index += 1) assert.equal(ttlBuffered.publish(descriptor(`ttl-${index}`), { tone: 'info', message: `queued-${index}` }, project).accepted, true);
ttlNow += 15001;
assert.equal(ttlBuffered.publish(descriptor('ttl-fresh'), { tone: 'info', message: 'fresh' }, project).accepted, true, 'expired unready entries are pruned before buffer-full admission');
assert.equal(ttlBuffered.setRendererReady({ rendererToken: 'renderer-ttl', revision: 0, ready: true }).flushed, 1);


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
assert.deepStrictEqual(projectBounds.at(-1), { x: 10, y: 40, width: 800, height: 600 });
manager.activeInstanceId = 'settings'; projectInstance.logicalActive = false; settingsInstance.logicalActive = true; manager.applyBounds(projectInstance); manager.applyBounds(settingsInstance);
assert.deepStrictEqual(settingsBounds.at(-1), { x: 0, y: 40, width: 1000, height: 700 }, 'settings surface retains its exact requested geometry');
assert.deepStrictEqual(projectBounds.at(-1), { x: 10, y: 40, width: 800, height: 600 }, 'switching surfaces never changes component geometry');
manager.activeInstanceId = 'project'; projectInstance.logicalActive = true; settingsInstance.logicalActive = false;
manager.applyBounds(projectInstance);
assert.deepStrictEqual(projectBounds.at(-1), { x: 10, y: 40, width: 800, height: 600 }, 'toast activity has no bounds mutation path');

assert.deepStrictEqual(normalizeComponentNotificationRendererEvent({ apiVersion: 2, type: 'notification', id: 'alpha:1', componentId: 'alpha', surface: 'project', notification: { tone: 'success', message: 'saved' } }).notification, { tone: 'success', message: 'saved' });
assert.equal(normalizeComponentNotificationRendererEvent({ apiVersion: 2, type: 'notification', id: 'x', componentId: 'alpha', surface: 'project', notification: { tone: 'info', message: 'padded', durationMs: 3500 } }), null, 'legacy durationMs is rejected at the renderer boundary');
assert.deepStrictEqual(normalizeComponentNotificationRendererEvent({ apiVersion: 2, type: 'purge', componentId: 'alpha' }), { apiVersion: 2, type: 'purge', componentId: 'alpha' });
const rendererEvents = new EventEmitter(); const normalizedEvents = [];
const unsubscribeRenderer = subscribeComponentNotification(rendererEvents, value => normalizedEvents.push(value));
rendererEvents.emit('component-host:notification.v2', {}, { apiVersion: 2, type: 'notification', id: 'alpha:2', componentId: 'alpha', surface: 'application.settings', notification: { tone: 'warning', message: 'review' } });
assert.equal(normalizedEvents.length, 1); unsubscribeRenderer();
rendererEvents.emit('component-host:notification.v2', {}, { apiVersion: 2, type: 'purge', componentId: 'alpha' });
assert.equal(normalizedEvents.length, 1, 'preload subscription cleanup removes the private listener');

console.log('component notification tests passed');
