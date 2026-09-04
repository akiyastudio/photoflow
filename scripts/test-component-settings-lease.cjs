const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let nextId = 1;
const views = [];
const pageLoad = deferred();
class Contents extends EventEmitter {
  constructor() {
    super();
    this.id = nextId++;
    this.destroyed = false;
    this.session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
  }
  isDestroyed() { return this.destroyed; }
  loadFile() { return pageLoad.promise; }
  send() {}
  setWindowOpenHandler() {}
  insertCSS() { return Promise.resolve(`css-${this.id}`); }
  removeInsertedCSS() { return Promise.resolve(); }
  close() { this.destroyed = true; this.emit('destroyed'); }
}
class View {
  constructor() { this.webContents = new Contents(); views.push(this); }
  setBounds() {}
  setVisible() {}
}

const descriptor = {
  componentId: 'settings-fixture', componentVersion: '1', contractVersion: 2,
  settingsPages: [],
  settingsForms: [{ id: 'settings', title: 'Settings', form: { schemaVersion: 1, groups: [] }, customPage: { title: 'Advanced', entry: 'settings.html', rpcMethods: ['fixture.settings.v1'] } }],
  service: { permissions: [], events: [] },
};

(async () => {
  const manager = new ComponentViewManager({
    WebContentsView: View,
    mainWindow: { contentView: { addChildView() {}, removeChildView() {} } },
    registry: { resolve: id => id === descriptor.componentId ? descriptor : null },
    preloadPath: 'preload.cjs',
    ipcMain: { handle() {} },
    settingsCloseGraceMs: 5,
  });
  try {
    const request = leaseId => ({ componentId: descriptor.componentId, pageId: 'settings', leaseId });
    const firstRequest = request('settings-first-lease');
    const secondRequest = request('settings-second-lease');
    const firstOpen = manager.openSettings(firstRequest);
    assert.equal(manager.releaseSettings(firstRequest), true, 'StrictMode cleanup releases the first lease while its page is loading');
    const secondOpen = manager.openSettings(secondRequest);
    assert.equal(views.length, 1, 'a remount reuses the in-flight settings WebContentsView');
    pageLoad.resolve();
    await assert.rejects(firstOpen, /lease was released/);
    const second = await secondOpen;
    assert.equal(views.length, 1);
    assert.equal(views[0].webContents.isDestroyed(), false);
    await wait(10);
    assert.equal(views[0].webContents.isDestroyed(), false, 'the stale release timer cannot close a reacquired settings page');
    assert.equal(manager.releaseSettings(secondRequest), true);
    await wait(10);
    assert.equal(views[0].webContents.isDestroyed(), true, 'the final lease release closes the retained page after the grace period');
    assert.equal(second.instanceId.startsWith('component-page-'), true);
    console.log('Hybrid component settings StrictMode lease reuse tests passed');
  } finally {
    manager.destroy();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
