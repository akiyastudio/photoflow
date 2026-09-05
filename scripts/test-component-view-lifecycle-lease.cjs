const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ComponentLifecycleCoordinator } = require('../electron/services/component-lifecycle-coordinator.cjs');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');

const loadGates = [];
let asyncDestroyNextClose = false;
class WebContents extends EventEmitter {
  constructor() {
    super();
    this.id = loadGates.length + 1;
    this.destroyed = false;
    this.session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} } };
  }
  isDestroyed() { return this.destroyed; }
  send() {}
  setWindowOpenHandler() {}
  insertCSS() { return Promise.resolve('css-key'); }
  loadFile() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    loadGates.push({ release });
    return promise;
  }
  close() {
    if (this.destroyed) return;
    const destroy = () => { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } };
    if (asyncDestroyNextClose) { asyncDestroyNextClose = false; setImmediate(destroy); } else destroy();
  }
}
class WebContentsView {
  constructor() { this.webContents = new WebContents(); }
  setBounds() {}
  setVisible() {}
}

(async () => {
  const componentId = 'fixture.component';
  const coordinator = new ComponentLifecycleCoordinator();
  let descriptor = {
    componentId, componentVersion: '1', componentRoot: __dirname, contractVersion: 2,
    fullPage: { id: 'main', title: 'Fixture', entry: __filename }, service: { permissions: [], events: [] },
  };
  let capabilityClearAttempts = 0; let failCapabilityClear = false;
  const manager = new ComponentViewManager({
    WebContentsView,
    mainWindow: { isDestroyed: () => false, webContents: { send() {} }, contentView: { addChildView() {}, removeChildView() {} } },
    registry: { resolve: id => id === componentId ? descriptor : null, list: () => [descriptor] },
    preloadPath: __filename, ipcMain: { handle() {} }, lifecycleCoordinator: coordinator,
    clearComponentCapabilityState: async () => { capabilityClearAttempts += 1; if (failCapabilityClear) { failCapabilityClear = false; throw new Error('capability clear failed'); } },
  });
  const request = { componentId, componentVersion: '1', pageId: 'main', workspacePath: __dirname, projectId: 'project', projectName: 'Project', projectStatus: 'active' };

  const cancelledOpen = manager.openSurface(request, 'component.fullPage');
  while (!loadGates[0]) await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.hasWork(componentId), true);
  const cancelledIntent = coordinator.acquire(componentId, 'uninstall', { stopOnly: true });
  cancelledIntent.release();
  loadGates[0].release();
  const first = await cancelledOpen;
  assert.equal(first.componentId, componentId, 'cancelled transition lets the admitted view finish');
  assert.equal(coordinator.hasWork(componentId), false);
  await manager.closeComponentAndWait(componentId);
  assert.equal(capabilityClearAttempts, 1, 'component close waits for capability cleanup');

  const continuedOpen = manager.openSurface(request, 'component.fullPage');
  while (!loadGates[1]) await new Promise(resolve => setImmediate(resolve));
  const continuedIntent = coordinator.acquire(componentId, 'uninstall', { stopOnly: true });
  continuedIntent.requestStop();
  let promoted = false;
  const promotion = continuedIntent.promote().then(() => { promoted = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(promoted, false, 'transition promotion waits for the in-flight view lease');
  loadGates[1].release();
  await continuedOpen;
  await promotion;
  failCapabilityClear = true;
  await assert.rejects(manager.closeComponentAndWait(componentId), /capability clear failed/);
  assert.equal(manager.instances.size, 0, 'failed async cleanup still closes the unsafe renderer');
  await manager.closeComponentAndWait(componentId);
  assert.equal(capabilityClearAttempts, 3, 'failed capability cleanup is retryable even after views are closed');
  assert.equal(manager.instances.size, 0);
  continuedIntent.release();

  const delayedContents = new EventEmitter(); delayedContents.destroyed = false; delayedContents.isDestroyed = () => delayedContents.destroyed;
  const attemptsBeforeDelayedDestroy = capabilityClearAttempts;
  const delayedClear = manager.requestComponentCapabilityClear(componentId, [delayedContents], 1000);
  const reopenedAfterClear = manager.openSurface(request, 'component.fullPage');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capabilityClearAttempts, attemptsBeforeDelayedDestroy, 'capability state remains intact while target renderer is alive');
  assert.equal(loadGates.length, 2, 'reopen does not create a renderer while prior capability clear is pending');
  delayedContents.destroyed = true; delayedContents.emit('destroyed'); await delayedClear;
  assert.equal(capabilityClearAttempts, attemptsBeforeDelayedDestroy + 1, 'destroyed prerequisite triggers exactly one clear');
  while (!loadGates[2]) await new Promise(resolve => setImmediate(resolve));
  loadGates[2].release(); await reopenedAfterClear; await manager.closeComponentAndWait(componentId);

  const transitionDelayedContents = new EventEmitter(); transitionDelayedContents.destroyed = false; transitionDelayedContents.isDestroyed = () => transitionDelayedContents.destroyed;
  const transitionDelayedClear = manager.requestComponentCapabilityClear(componentId, [transitionDelayedContents], 1000);
  const blockedReopen = manager.openSurface(request, 'component.fullPage');
  await new Promise(resolve => setImmediate(resolve));
  const blockingIntent = coordinator.acquire(componentId, 'disable', { stopOnly: true }); blockingIntent.requestStop();
  const closeDuringClear = manager.closeComponentAndWait(componentId); const blockedPromotion = blockingIntent.promote();
  transitionDelayedContents.destroyed = true; transitionDelayedContents.emit('destroyed'); await transitionDelayedClear;
  await assert.rejects(blockedReopen, error => error.code === 'COMPONENT_QUIESCING');
  await closeDuringClear; await blockedPromotion;
  assert.equal(manager.instances.size, 0, 'requestStop recheck prevents a view from escaping a pending clear barrier');
  blockingIntent.release();

  const cancelledDelayedContents = new EventEmitter(); cancelledDelayedContents.destroyed = false; cancelledDelayedContents.isDestroyed = () => cancelledDelayedContents.destroyed;
  const cancelledDelayedClear = manager.requestComponentCapabilityClear(componentId, [cancelledDelayedContents], 1000);
  const allowedReopen = manager.openSurface(request, 'component.fullPage');
  await new Promise(resolve => setImmediate(resolve));
  const cancelledClearIntent = coordinator.acquire(componentId, 'disable', { stopOnly: true }); cancelledClearIntent.release();
  cancelledDelayedContents.destroyed = true; cancelledDelayedContents.emit('destroyed'); await cancelledDelayedClear;
  while (!loadGates[3]) await new Promise(resolve => setImmediate(resolve));
  loadGates[3].release(); await allowedReopen; await manager.closeComponentAndWait(componentId);
  assert.equal(manager.instances.size, 0, 'cancelled intent permits a safe reopen after clear completion');

  const attemptsBeforeRememberedFailure = capabilityClearAttempts;
  failCapabilityClear = true;
  await assert.rejects(manager.requestComponentCapabilityClear(componentId), /capability clear failed/);
  assert.equal(manager.failedCapabilityClearIds.has(componentId), true, 'passive clear failure remains visible after its promise settles');
  await manager.closeAllAndWait();
  assert.equal(manager.failedCapabilityClearIds.has(componentId), false, 'application-wide close retries remembered passive failures');
  assert.equal(capabilityClearAttempts, attemptsBeforeRememberedFailure + 2, 'remembered failure is retried exactly once');

  descriptor = { ...descriptor, componentVersion: '1' };
  const originalForReplacement = manager.openSurface(request, 'component.fullPage');
  while (!loadGates[4]) await new Promise(resolve => setImmediate(resolve));
  loadGates[4].release(); await originalForReplacement;
  const gatesBeforeReplacement = loadGates.length; const attemptsBeforeReplacement = capabilityClearAttempts;
  asyncDestroyNextClose = true; descriptor = { ...descriptor, componentVersion: '2' };
  const replacementOpen = manager.openSurface({ ...request, componentVersion: '2' }, 'component.fullPage');
  assert.equal(loadGates.length, gatesBeforeReplacement, 'replacement renderer is not created before async destroyed cleanup is registered');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capabilityClearAttempts, attemptsBeforeReplacement + 1, 'replacement waits for old renderer destruction before clearing capability state');
  while (loadGates.length === gatesBeforeReplacement) await new Promise(resolve => setImmediate(resolve));
  loadGates.at(-1).release(); await replacementOpen; await manager.closeComponentAndWait(componentId);

  console.log('Component view lifecycle lease tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
