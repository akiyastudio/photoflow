const { app, BrowserWindow, ipcMain, WebContentsView } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ComponentViewManager, componentPageKey } = require('../electron/services/component-view-manager.cjs');

app.commandLine.appendSwitch('disable-gpu');
const smokeUserData = path.join(os.tmpdir(), `photoflow-component-electron-${process.pid}`);
fs.mkdirSync(smokeUserData, { recursive: true });
app.setPath('userData', smokeUserData);

const run = async () => {
  const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-component-pages-'));
  const hostPage = path.join(fixtureRoot, 'host.html');
  const legacyPage = path.join(fixtureRoot, 'legacy.html');
  await fs.promises.writeFile(hostPage, `<!doctype html><div id="root"></div><script>
    const root = document.getElementById('root');
    root.textContent = window.photoFlowComponent ? 'host-mounted' : '';
    window.photoFlowComponent.onEvent('sample.changed.v2', value => { window.receivedEvent = value; root.dataset.event = value.value; });
  </script>`);
  await fs.promises.writeFile(legacyPage, '<!doctype html><div id="root"></div>');

  const host = { componentId: 'smoke-host', componentVersion: '1.0.0', contractVersion: 2,
    fullPage: { id: 'main', title: 'Host', entry: hostPage }, toolbarAction: { id: 'open', label: 'Host' }, service: { events: ['sample.changed.v2'], permissions: [] } };
  const legacy = { componentId: 'smoke-legacy', componentVersion: '1.0.0', contractVersion: 1,
    fullPage: { id: 'main', title: 'Legacy', entry: legacyPage }, toolbarAction: { id: 'open', label: 'Legacy' }, service: { events: [], permissions: [] } };
  const descriptors = new Map([[host.componentId, host], [legacy.componentId, legacy]]);
  const logs = [];
  const mainWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const manager = new ComponentViewManager({
    WebContentsView, mainWindow, registry: { list: () => [...descriptors.values()], resolve: id => descriptors.get(id) },
    preloadPath: path.resolve(__dirname, '..', 'electron', 'component-preload.cjs'), ipcMain,
    writeLog: (level, message, details) => logs.push({ level, message, details }),
  });
  const request = descriptor => ({ componentId: descriptor.componentId, pageId: 'main', workspacePath: fixtureRoot, projectId: descriptor.componentId });

  try {
    const hostPublic = await manager.open(request(host));
    const hostInstance = manager.instances.get(componentPageKey(request(host)));
    const hostMounted = await hostInstance.view.webContents.executeJavaScript(`({ api: !!window.photoFlowComponent, notify: typeof window.photoFlowComponent?.notify === 'function', dialog: typeof window.photoFlowComponent?.dialog === 'function', bridgeContract: window.photoFlowComponent?.contractVersion, root: document.getElementById('root')?.textContent })`);
    hostInstance.context.emitComponentEvent('sample.changed.v2', { value: 'delivered-host' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const hostEvent = await hostInstance.view.webContents.executeJavaScript(`window.receivedEvent`);
    let legacyRejected = false;
    try { await manager.open(request(legacy)); } catch (error) { legacyRejected = /Unsupported component preload contract/.test(String(error?.message || error)); }
    const failures = logs.filter(item => item.level === 'error');
    process.stdout.write(`PHOTOFLOW_COMPONENT_SMOKE_RESULT=${JSON.stringify({ hostPublic, hostMounted, hostEvent, legacyRejected, failures })}\n`);
    if (!hostMounted.api || hostMounted.bridgeContract !== 1 || !hostMounted.root || hostEvent?.value !== 'delivered-host' || !legacyRejected || failures.length) process.exitCode = 1;
  } finally {
    manager.destroy();
    mainWindow.destroy();
    await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
    app.quit();
  }
};

app.whenReady().then(run).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
