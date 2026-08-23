const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { parseComponentHostManifest, createComponentHostRegistry } = require('../electron/component-host-contract.cjs');
const { ComponentViewManager, componentPageKey, validBounds } = require('../electron/services/component-view-manager.cjs');
const { registerComponentIconProtocol } = require('../electron/modules/component-icon-protocol.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-host-'));
try {
  const componentRoot = path.join(sandbox, 'sample-component');
  fs.mkdirSync(path.join(componentRoot, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(componentRoot, 'ui', 'index.html'), '<!doctype html><title>Sample</title>');
  fs.writeFileSync(path.join(componentRoot, 'ui', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#6558e8"/></svg>');
  const manifest = {
    apiVersion: 1,
    id: 'sample-component',
    version: '3.4.5',
    icon: 'ui/icon.svg',
    componentHost: {
      contractVersion: 1,
      compatibility: { minHostApiVersion: 1, maxHostApiVersion: 2 },
      contributions: [
        { type: 'workspace.toolbarAction', id: 'open', label: '示例组件', pageId: 'main' },
        { type: 'component.fullPage', id: 'main', title: '示例整页', entry: 'ui/index.html' },
      ],
    },
  };
  fs.writeFileSync(path.join(componentRoot, 'component.json'), JSON.stringify(manifest));
  const parsed = parseComponentHostManifest(manifest, componentRoot);
  assert.equal(parsed.toolbarAction.pageId, 'main');
  assert.equal(parsed.fullPage.entry, path.join(componentRoot, 'ui', 'index.html'));
  assert.deepEqual({ relativeEntry: parsed.icon.relativeEntry, mimeType: parsed.icon.mimeType }, { relativeEntry: 'ui/icon.svg', mimeType: 'image/svg+xml' });
  assert.equal(parseComponentHostManifest({ id: 'legacy', version: '1' }, componentRoot), null, 'legacy native V1 components remain accepted outside the UI host');
  assert.throws(() => parseComponentHostManifest({ ...manifest, apiVersion: 2 }, componentRoot), /Unsupported component apiVersion/);
  assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: [{ type: 'media.previewButton', id: 'bad' }, manifest.componentHost.contributions[1]] } }, componentRoot), /Unknown component host contribution type/);
  assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 2, maxHostApiVersion: 3 } } }, componentRoot), /outside supported range/);
  assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: [manifest.componentHost.contributions[0], { ...manifest.componentHost.contributions[1], entry: '../escape.html' }] } }, componentRoot), /escapes component root/);
  assert.throws(() => parseComponentHostManifest({ ...manifest, icon: 'https://example.com/icon.svg' }, componentRoot), /package-local/);
  assert.throws(() => parseComponentHostManifest({ ...manifest, icon: '../escape.svg' }, componentRoot), /escapes component root/);
  fs.writeFileSync(path.join(componentRoot, 'ui', 'active.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.throws(() => parseComponentHostManifest({ ...manifest, icon: 'ui/active.svg' }, componentRoot), /active or external content/);
  fs.writeFileSync(path.join(componentRoot, 'ui', 'fake.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.throws(() => parseComponentHostManifest({ ...manifest, icon: 'ui/fake.png' }, componentRoot), /invalid signature/);
  fs.writeFileSync(path.join(componentRoot, 'ui', 'icon.html'), '<svg></svg>');
  assert.throws(() => parseComponentHostManifest({ ...manifest, icon: 'ui/icon.html' }, componentRoot), /must be SVG or PNG/);
  assert.equal(parseComponentHostManifest({ ...manifest, icon: undefined }, componentRoot).icon, null, 'icons are optional so the renderer can use the generic fallback');
  const registry = createComponentHostRegistry({ roots: [{ source: 'user', path: sandbox }] });
  assert.deepEqual(registry.list().map(item => item.componentId), ['sample-component'], 'host registration discovers manifests dynamically without a business-component catalog entry');
  const protocolHandlers = new Map();
  registerComponentIconProtocol({ protocol: { handle: (scheme, handler) => protocolHandlers.set(scheme, handler) }, registry, fs });
  const componentPreload = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'component-preload.cjs'), 'utf8');
  assert(componentPreload.includes("exposeInMainWorld('photoFlowComponent'") && !componentPreload.includes("exposeInMainWorld('electronAPI'"), 'component preload exposes the restricted SDK instead of the application bridge');
  const projectWorkspaceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const projectWorkspaceLayoutSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspaceLayout.tsx'), 'utf8');
  assert.equal((`${projectWorkspaceSource}\n${projectWorkspaceLayoutSource}`.match(/component-toolbar-actions/g) || []).length, 1, 'declarative UI component actions have one dedicated project-toolbar group');
  assert(!projectWorkspaceSource.includes('dangerouslySetInnerHTML') && !projectWorkspaceSource.includes('<iframe'), 'component page code is never injected into the workspace React DOM');

  class FakeWebContents extends EventEmitter {
    static nextId = 10;
    constructor() { super(); this.id = FakeWebContents.nextId++; this.sent = []; this.destroyed = false; this.session = { setPermissionCheckHandler: handler => { this.permissionCheck = handler; }, setPermissionRequestHandler: handler => { this.permissionRequest = handler; } }; }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    send(channel) { this.sent.push(channel); }
    loadFile(entry) { this.loadedEntry = entry; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('destroyed'); }
  }
  class FakeView {
    constructor(options) { this.options = options; this.webContents = new FakeWebContents(); this.bounds = []; this.visible = true; FakeView.created.push(this); }
    setBounds(bounds) { this.bounds.push(bounds); }
    setVisible(value) { this.visible = value; }
  }
  FakeView.created = [];
  const children = [];
  const mainWindow = { contentView: { addChildView: view => children.push(view), removeChildView: view => children.splice(children.indexOf(view), 1) } };
  const handlers = new Map();
  const rawIpc = { handle: (channel, handler) => handlers.set(channel, handler) };
  const manager = new ComponentViewManager({ WebContentsView: FakeView, mainWindow, registry, preloadPath: 'host-preload.cjs', ipcMain: rawIpc });
  const request = { componentId: 'sample-component', pageId: 'main', workspacePath: 'C:\\Work', projectId: 'project-1', projectName: '项目一', projectStatus: '后期中' };
  Promise.resolve().then(async () => {
    const iconResponse = await protocolHandlers.get('photoflow-component')({ method: 'GET', url: 'photoflow-component://icon/sample-component?v=3.4.5' });
    assert.equal(iconResponse.status, 200);
    assert.equal(iconResponse.headers.get('content-type'), 'image/svg+xml');
    assert.match(iconResponse.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await iconResponse.text(), /^<svg/);
    assert.equal((await protocolHandlers.get('photoflow-component')({ method: 'GET', url: 'photoflow-component://icon/unknown' })).status, 404, 'the protocol cannot read arbitrary component paths');
    assert.equal((await protocolHandlers.get('photoflow-component')({ method: 'POST', url: 'photoflow-component://icon/sample-component' })).status, 404, 'the icon protocol is read-only');
    const first = await manager.open(request);
    const second = await manager.open({ ...request, workspacePath: 'c:/work' });
    assert.equal(first.instanceId, second.instanceId, 'same componentId + workspace + project focuses one page');
    assert.equal(FakeView.created.length, 1);
    const view = FakeView.created[0];
    assert.deepEqual(view.options.webPreferences, { preload: 'host-preload.cjs', nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false });
    assert.deepEqual(view.webContents.windowOpenHandler(), { action: 'deny' });
    const navigation = { prevented: false, preventDefault() { this.prevented = true; } };
    view.webContents.emit('will-navigate', navigation, 'https://example.com');
    assert(navigation.prevented && view.webContents.permissionCheck() === false, 'navigation and permissions are denied');
    assert(validBounds({ x: 0, y: 40, width: 800, height: 600 }));
    assert(!validBounds({ x: 0, y: 0, width: -1, height: 1 }));
    assert(manager.setBounds(first.instanceId, { x: 2, y: 40, width: 800, height: 600 }));
    const context = await handlers.get('component-sdk:get-context')({ sender: view.webContents });
    assert.equal(context.projectId, 'project-1');
    assert.equal(context.workspacePath, undefined, 'component pages receive project identity but never the private workspace path');
    assert.throws(() => handlers.get('component-sdk:get-context')({ sender: new FakeWebContents() }), /Unauthorized component sender/);
    manager.registerRpcMethod('sample.echo.v1', (_event, payload, boundContext) => ({ payload, projectId: boundContext.projectId }), 'sample-component');
    assert.deepEqual(await handlers.get('component-sdk:rpc')({ sender: view.webContents }, 'sample.echo.v1', { value: 1 }), { payload: { value: 1 }, projectId: 'project-1' });
    assert.throws(() => handlers.get('component-sdk:rpc')({ sender: view.webContents }, 'unknown.v1', {}), /Unknown component RPC method/);
    assert.equal(manager.closeProject('C:/WORK', 'project-1'), 1);
    assert(view.webContents.destroyed && children.length === 0, 'project close explicitly destroys and detaches the component view');
    assert.equal(manager.close(first.instanceId), false, 'destroy is idempotent');
    assert.equal(componentPageKey(request), componentPageKey({ ...request, workspacePath: 'c:/work' }));

    const pageModel = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'components', 'component-page-model.ts')).href);
    const action = manager.listToolbarActions()[0];
    assert.match(action.iconUrl, /^photoflow-component:\/\/icon\/sample-component\?v=3\.4\.5$/, 'the renderer only receives a host-issued component icon URL');
    const project = { id: 'project-1', name: '项目一', path: 'C:/Work/项目一', status: '后期中', updatedAt: 1 };
    const one = pageModel.ensureComponentPage([], action, project, 'C:/Work', 'project-page:active');
    const focused = pageModel.ensureComponentPage(one.pages, action, project, 'c:/work', 'home');
    assert.equal(focused.created, false);
    assert.strictEqual(focused.pages, one.pages, 'duplicate toolbar clicks preserve component tab identity');
    assert.equal(focused.page.insertAfterTabId, 'project-page:active', 'reactivating an existing component tab must preserve its original position');
    assert.equal(focused.page.iconUrl, action.iconUrl);
    assert.equal(pageModel.closeProjectComponentPages(one.pages, 'c:/WORK', 'project-1').length, 0);
    console.log('Component Host V1 tests passed');
  }).catch(error => { console.error(error); process.exitCode = 1; });
} finally {
  process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true }));
}
