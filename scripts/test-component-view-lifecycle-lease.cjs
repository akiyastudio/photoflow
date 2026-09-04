const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ComponentLifecycleCoordinator } = require('../electron/services/component-lifecycle-coordinator.cjs');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');

const loadGates = [];
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
  close() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } }
}
class WebContentsView {
  constructor() { this.webContents = new WebContents(); }
  setBounds() {}
  setVisible() {}
}

(async () => {
  const componentId = 'fixture.component';
  const coordinator = new ComponentLifecycleCoordinator();
  const descriptor = {
    componentId, componentVersion: '1', componentRoot: __dirname, contractVersion: 2,
    fullPage: { id: 'main', title: 'Fixture', entry: __filename }, service: { permissions: [], events: [] },
  };
  const manager = new ComponentViewManager({
    WebContentsView,
    mainWindow: { isDestroyed: () => false, webContents: { send() {} }, contentView: { addChildView() {}, removeChildView() {} } },
    registry: { resolve: id => id === componentId ? descriptor : null, list: () => [descriptor] },
    preloadPath: __filename, ipcMain: { handle() {} }, lifecycleCoordinator: coordinator,
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
  await manager.closeComponentAndWait(componentId);
  assert.equal(manager.instances.size, 0);
  continuedIntent.release();

  console.log('Component view lifecycle lease tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
