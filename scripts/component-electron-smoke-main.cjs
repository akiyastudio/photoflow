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
  const v2Page = path.join(fixtureRoot, 'v2.html');
  const v1Page = path.join(fixtureRoot, 'v1.html');
  await fs.promises.writeFile(v2Page, `<!doctype html><div id="root"></div><script>
    const root = document.getElementById('root');
    root.textContent = window.photoFlowComponent ? 'v2-mounted' : '';
    window.photoFlowComponent.onEvent('sample.changed.v2', value => { window.receivedEvent = value; root.dataset.event = value.value; });
  </script>`);
  await fs.promises.writeFile(v1Page, `<!doctype html><div id="root"></div><script>
    const root = document.getElementById('root');
    root.textContent = window.photoFlowComponent ? 'v1-mounted' : '';
    window.photoFlowComponent.onEvent('workflow.progress', value => { window.receivedEvent = value; root.dataset.event = value.value; });
  </script>`);

  const v2 = { componentId: 'smoke-v2', componentVersion: '1.0.0', contractVersion: 2, hostApiVersion: 2,
    fullPage: { id: 'main', title: 'V2', entry: v2Page }, toolbarAction: { id: 'open', label: 'V2' }, service: { events: ['sample.changed.v2'], permissions: [] } };
  const v1 = { componentId: 'smoke-v1', componentVersion: '1.0.0', contractVersion: 1, hostApiVersion: 1,
    fullPage: { id: 'main', title: 'V1', entry: v1Page }, toolbarAction: { id: 'open', label: 'V1' }, service: { events: [], permissions: [] } };
  const descriptors = new Map([[v2.componentId, v2], [v1.componentId, v1]]);
  const logs = [];
  const mainWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const manager = new ComponentViewManager({
    WebContentsView, mainWindow, registry: { list: () => [...descriptors.values()], resolve: id => descriptors.get(id) },
    preloadPath: path.resolve(__dirname, '..', 'electron', 'component-preload.cjs'), ipcMain,
    writeLog: (level, message, details) => logs.push({ level, message, details }),
  });
  const request = descriptor => ({ componentId: descriptor.componentId, pageId: 'main', workspacePath: fixtureRoot, projectId: descriptor.componentId });

  try {
    const v2Public = await manager.open(request(v2));
    const v2Instance = manager.instances.get(componentPageKey(request(v2)));
    const v2Mounted = await v2Instance.view.webContents.executeJavaScript(`({ api: !!window.photoFlowComponent, bridgeContract: window.photoFlowComponent?.contractVersion, root: document.getElementById('root')?.textContent })`);
    v2Instance.context.emitComponentEvent('sample.changed.v2', { value: 'delivered-v2' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const v2Event = await v2Instance.view.webContents.executeJavaScript(`window.receivedEvent`);

    await manager.open(request(v1));
    const v1Instance = manager.instances.get(componentPageKey(request(v1)));
    const v1Mounted = await v1Instance.view.webContents.executeJavaScript(`({ api: !!window.photoFlowComponent, bridgeContract: window.photoFlowComponent?.contractVersion, root: document.getElementById('root')?.textContent })`);
    v1Instance.context.emitComponentEvent('workflow.progress', { value: 'delivered-v1' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const v1Event = await v1Instance.view.webContents.executeJavaScript(`window.receivedEvent`);
    const failures = logs.filter(item => item.level === 'error');
    process.stdout.write(`PHOTOFLOW_COMPONENT_SMOKE_RESULT=${JSON.stringify({ v2Public, v2Mounted, v2Event, v1Mounted, v1Event, failures })}\n`);
    if (!v2Mounted.api || v2Mounted.bridgeContract !== 1 || !v2Mounted.root || v2Event?.value !== 'delivered-v2'
      || !v1Mounted.api || v1Mounted.bridgeContract !== 1 || !v1Mounted.root || v1Event?.value !== 'delivered-v1' || failures.length) process.exitCode = 1;
  } finally {
    manager.destroy();
    mainWindow.destroy();
    await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
    app.quit();
  }
};

app.whenReady().then(run).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
