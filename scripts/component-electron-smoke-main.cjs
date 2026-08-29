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
  const v7Page = path.join(fixtureRoot, 'v7.html');
  const legacyPage = path.join(fixtureRoot, 'legacy.html');
  await fs.promises.writeFile(v7Page, `<!doctype html><div id="root"></div><script>
    const root = document.getElementById('root');
    root.textContent = window.photoFlowComponent ? 'v7-mounted' : '';
    window.photoFlowComponent.onEvent('sample.changed.v2', value => { window.receivedEvent = value; root.dataset.event = value.value; });
  </script>`);
  await fs.promises.writeFile(legacyPage, '<!doctype html><div id="root"></div>');

  const v7 = { componentId: 'smoke-v7', componentVersion: '1.0.0', contractVersion: 2, hostApiVersion: 7,
    fullPage: { id: 'main', title: 'V7', entry: v7Page }, toolbarAction: { id: 'open', label: 'V7' }, service: { events: ['sample.changed.v2'], permissions: [] } };
  const legacy = { componentId: 'smoke-legacy', componentVersion: '1.0.0', contractVersion: 1, hostApiVersion: 7,
    fullPage: { id: 'main', title: 'Legacy', entry: legacyPage }, toolbarAction: { id: 'open', label: 'Legacy' }, service: { events: [], permissions: [] } };
  const descriptors = new Map([[v7.componentId, v7], [legacy.componentId, legacy]]);
  const logs = [];
  const mainWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const manager = new ComponentViewManager({
    WebContentsView, mainWindow, registry: { list: () => [...descriptors.values()], resolve: id => descriptors.get(id) },
    preloadPath: path.resolve(__dirname, '..', 'electron', 'component-preload.cjs'), ipcMain,
    writeLog: (level, message, details) => logs.push({ level, message, details }),
  });
  const request = descriptor => ({ componentId: descriptor.componentId, pageId: 'main', workspacePath: fixtureRoot, projectId: descriptor.componentId });

  try {
    const v7Public = await manager.open(request(v7));
    const v7Instance = manager.instances.get(componentPageKey(request(v7)));
    const v7Mounted = await v7Instance.view.webContents.executeJavaScript(`({ api: !!window.photoFlowComponent, notify: typeof window.photoFlowComponent?.notify === 'function', dialog: typeof window.photoFlowComponent?.dialog === 'function', bridgeContract: window.photoFlowComponent?.contractVersion, root: document.getElementById('root')?.textContent })`);
    v7Instance.context.emitComponentEvent('sample.changed.v2', { value: 'delivered-v7' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const v7Event = await v7Instance.view.webContents.executeJavaScript(`window.receivedEvent`);
    let legacyRejected = false;
    try { await manager.open(request(legacy)); } catch (error) { legacyRejected = /Unsupported component preload contract/.test(String(error?.message || error)); }
    const failures = logs.filter(item => item.level === 'error');
    process.stdout.write(`PHOTOFLOW_COMPONENT_SMOKE_RESULT=${JSON.stringify({ v7Public, v7Mounted, v7Event, legacyRejected, failures })}\n`);
    if (!v7Mounted.api || v7Mounted.bridgeContract !== 1 || !v7Mounted.root || v7Event?.value !== 'delivered-v7' || !legacyRejected || failures.length) process.exitCode = 1;
  } finally {
    manager.destroy();
    mainWindow.destroy();
    await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
    app.quit();
  }
};

app.whenReady().then(run).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
