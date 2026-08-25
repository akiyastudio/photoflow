const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const vm = require('vm');
const { parseComponentHostManifest, createComponentHostRegistry } = require('../electron/component-host-contract.cjs');
const { ComponentViewManager, componentPageKey, normalizeOpenScope, normalizeResolvedTheme, validBounds } = require('../electron/services/component-view-manager.cjs');
const { registerComponentIconProtocol } = require('../electron/modules/component-icon-protocol.cjs');
const { registerComponentHostIpc } = require('../electron/modules/component-host-ipc.cjs');

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
  assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: { minHostApiVersion: 5, maxHostApiVersion: 6 } } }, componentRoot), /do not overlap/);
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
  assert.deepEqual(createComponentHostRegistry({ roots: [{ source: 'user', path: sandbox }], admitDescriptor: () => false }).list(), [], 'components rejected by installation/integrity admission cannot contribute host UI');
  const repositoryRoot = path.resolve(__dirname, '..');
  const teamSourceRoot = path.join(repositoryRoot, 'extensions', 'team-retouch');
  assert(fs.existsSync(path.join(teamSourceRoot, 'component.template.json')) && !fs.existsSync(path.join(teamSourceRoot, 'component.json')), 'the source checkout intentionally contains only the development template');
  const developmentRegistry = createComponentHostRegistry({
    roots: [{ source: 'development', path: path.join(repositoryRoot, 'extensions') }],
    developmentRendererRoot: path.join(repositoryRoot, 'artifacts', 'component-renderers'),
    developmentAlgorithmRuntimes: {
      'team-retouch': { command: path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe'), argsPrefix: [path.join(teamSourceRoot, 'team_retouch.py')] },
    },
  });
  const developmentTeam = developmentRegistry.resolve('team-retouch');
  assert(developmentTeam, 'the real team-retouch source template must register with Component Host');
  assert.equal(developmentTeam.source, 'development');
  assert.equal(developmentTeam.fullPage.entry, path.join(repositoryRoot, 'artifacts', 'component-renderers', 'team-retouch', 'index.html'));
  assert.equal(developmentTeam.icon.entry, path.join(teamSourceRoot, 'renderer', 'team-retouch.svg'));
  assert.equal(developmentTeam.service.entry, path.join(teamSourceRoot, 'service.cjs'));
  assert.deepEqual(developmentTeam.algorithmRuntime, { command: path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe'), argsPrefix: [path.join(teamSourceRoot, 'team_retouch.py')] }, 'development Host descriptor explicitly pins the repository Python algorithm runtime');
  assert.deepEqual(developmentTeam.advancedRuntime, { apiVersion: 1, compatibleLegacyComponentVersions: ['26.7.30.1'] }, 'development template registration must preserve the reviewed legacy advanced-runtime compatibility policy');

  const packagedTemplateRoot = path.join(sandbox, 'packaged-template-root');
  fs.mkdirSync(path.join(packagedTemplateRoot, 'template-only'), { recursive: true });
  fs.writeFileSync(path.join(packagedTemplateRoot, 'template-only', 'component.template.json'), JSON.stringify(manifest));
  assert.deepStrictEqual(createComponentHostRegistry({ roots: [{ source: 'user', path: packagedTemplateRoot }], developmentRendererRoot: path.join(sandbox, 'renderers') }).list(), [], 'packaged/user roots must ignore component templates even when a development renderer root is supplied');

  const invalidDevelopmentRoot = path.join(sandbox, 'invalid-development');
  const invalidComponentRoot = path.join(invalidDevelopmentRoot, 'bad-template');
  const invalidRendererRoot = path.join(sandbox, 'invalid-renderers', 'bad-template');
  fs.mkdirSync(path.join(invalidComponentRoot, 'renderer'), { recursive: true });
  fs.mkdirSync(invalidRendererRoot, { recursive: true });
  fs.writeFileSync(path.join(invalidRendererRoot, 'escape.html'), '<!doctype html>');
  fs.writeFileSync(path.join(invalidComponentRoot, 'renderer', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(invalidComponentRoot, 'component.template.json'), JSON.stringify({ ...manifest, id: 'bad-template', icon: 'ui/icon.svg', componentHost: { ...manifest.componentHost, contributions: [manifest.componentHost.contributions[0], { ...manifest.componentHost.contributions[1], entry: '../escape.html' }] } }));
  const invalidDevelopmentRegistry = createComponentHostRegistry({ roots: [{ source: 'development', path: invalidDevelopmentRoot }], developmentRendererRoot: path.join(sandbox, 'invalid-renderers') });
  assert.deepStrictEqual(invalidDevelopmentRegistry.list(), [], 'development renderer overrides must not rescue a template whose declared page escapes the component root');
  const protocolHandlers = new Map();
  registerComponentIconProtocol({ protocol: { handle: (scheme, handler) => protocolHandlers.set(scheme, handler) }, registry, fs });
  const componentPreload = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'component-preload.cjs'), 'utf8');
  assert(componentPreload.includes("exposeInMainWorld('photoFlowComponent'") && !componentPreload.includes("exposeInMainWorld('electronAPI'"), 'component preload exposes the restricted SDK instead of the application bridge');
  const preloadIpc = new EventEmitter();
  preloadIpc.invoke = async () => ({});
  preloadIpc.removeListener = preloadIpc.removeListener.bind(preloadIpc);
  const exposedWorlds = new Map();
  vm.runInNewContext(componentPreload, {
    Object, String, TypeError, Error,
    require: requestPath => requestPath === 'electron'
      ? { contextBridge: { exposeInMainWorld: (name, value) => exposedWorlds.set(name, value) }, ipcRenderer: preloadIpc }
      : requestPath === './compatibility/component-v1-metadata.cjs' ? { LEGACY_PRELOAD_EVENTS: Object.freeze({}) }
        : requestPath === './component-notify-bridge.cjs' ? require('../electron/component-notify-bridge.cjs') : require(requestPath),
  });
  assert.equal(exposedWorlds.has('electronAPI'), false, 'component preload behavior must not expose the application bridge');
  const restrictedSdk = exposedWorlds.get('photoFlowComponent');
  assert.equal(restrictedSdk.contractVersion, 1, 'bridge ABI stays at V1 even for Host API V2 components');
  assert.throws(() => restrictedSdk.onEvent('invalid-topic', () => undefined), /Invalid component event topic/, 'preload rejects non-versioned topics');
  const receivedEvents = [];
  const unsubscribeEvent = restrictedSdk.onEvent('sample.changed.v1', payload => receivedEvents.push(payload));
  preloadIpc.emit('component-sdk:event', {}, { topic: 'other.changed.v1', payload: { ignored: true } });
  preloadIpc.emit('component-sdk:event', {}, { topic: 'sample.changed.v1', payload: { value: 7 } });
  assert.deepStrictEqual(receivedEvents, [{ value: 7 }], 'preload forwards only the matching versioned topic payload');
  unsubscribeEvent();
  const projectWorkspaceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const projectWorkspaceLayoutSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspaceLayout.tsx'), 'utf8');
  assert(projectWorkspaceLayoutSource.includes("overflow ? 'component-toolbar-actions-overflow' : 'component-toolbar-actions flex shrink-0 items-center gap-1'") && projectWorkspaceSource.includes('<ComponentToolbarActions overflow actions={componentHostActions}'), 'declarative UI component actions provide dedicated wide-toolbar and overflow-menu presentations');
  assert(projectWorkspaceLayoutSource.includes('title={action.label}') && !projectWorkspaceLayoutSource.includes('在独立组件页中打开'), 'component toolbar hover text is owned by the component label and does not expose host implementation details');
  assert(!projectWorkspaceSource.includes('dangerouslySetInnerHTML') && !projectWorkspaceSource.includes('<iframe'), 'component page code is never injected into the workspace React DOM');

  class FakeWebContents extends EventEmitter {
    static nextId = 10;
    constructor() { super(); this.id = FakeWebContents.nextId++; this.sent = []; this.destroyed = false; this.session = { setPermissionCheckHandler: handler => { this.permissionCheck = handler; }, setPermissionRequestHandler: handler => { this.permissionRequest = handler; } }; }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    send(channel, payload) { this.sent.push({ channel, payload }); }
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
  const componentLogs = [];
  let activeSampleDescriptor = { ...registry.resolve('sample-component'), service: { events: ['sample.changed.v1', 'team.return.progress.v1'] } };
  const liveRegistry = {
    list: () => registry.list().map(item => item.componentId === 'sample-component' ? activeSampleDescriptor : item),
    resolve: componentId => componentId === 'sample-component' ? activeSampleDescriptor : registry.resolve(componentId),
  };
  const manager = new ComponentViewManager({ WebContentsView: FakeView, mainWindow, registry: liveRegistry, preloadPath: 'host-preload.cjs', compatibilityPreloadPath: 'host-preload-v1.cjs', ipcMain: rawIpc, writeLog: (level, message, details) => componentLogs.push({ level, message, details }) });
  const request = { componentId: 'sample-component', pageId: 'main', workspacePath: 'C:\\Work', projectId: 'project-1', projectName: '项目一', projectStatus: '后期中', scopeRelativePath: '图片后期_1', selectedRelativePaths: ['图片后期_1/a.jpg'], sourcePageId: 'project-page-1' };
  Promise.resolve().then(async () => {
    const hostLayerModel = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'components', 'host-layer-state.ts')).href);
    const hostLayerStates = [];
    const hostLayers = hostLayerModel.createHostLayerRegistry(state => hostLayerStates.push(state));
    const releaseOuter = hostLayers.acquire('outer');
    const releaseNested = hostLayers.acquire('nested');
    assert.deepEqual(hostLayers.snapshot(), { revision: 2, suspended: true, referenceCount: 2 }, 'nested host layers use reference counting');
    releaseOuter();
    assert.deepEqual(hostLayers.snapshot(), { revision: 3, suspended: true, referenceCount: 1 }, 'releasing one layer cannot resume external surfaces while another layer remains');
    releaseOuter();
    assert.equal(hostLayers.snapshot().revision, 3, 'a stale duplicate cleanup cannot advance or corrupt the host layer revision');
    releaseNested();
    assert.deepEqual(hostLayers.snapshot(), { revision: 4, suspended: false, referenceCount: 0 }, 'the final cleanup resumes host surfaces');
    assert.equal(hostLayerStates.length, 4);
    const hostIpcHandlers = new Map();
    const hostRenderer = new FakeWebContents();
    const hostIpcManager = { setHostSurfaceSuspended: update => update.suspended };
    registerComponentHostIpc({ ipcMain: { handle: (channel, handler) => hostIpcHandlers.set(channel, handler) }, manager: hostIpcManager, mainWindow: { isDestroyed: () => false, webContents: hostRenderer } });
    assert.deepEqual(hostIpcHandlers.get('component-host-set-suspended')({ sender: hostRenderer }, { suspended: true }), { success: true }, 'the application renderer may suspend host surfaces');
    assert.throws(() => hostIpcHandlers.get('component-host-set-suspended')({ sender: new FakeWebContents() }, { suspended: false }), /Unauthorized host surface sender/, 'a component or unrelated renderer cannot control host surface visibility');
    const iconResponse = await protocolHandlers.get('photoflow-component')({ method: 'GET', url: 'photoflow-component://icon/sample-component?v=3.4.5' });
    assert.equal(iconResponse.status, 200);
    assert.equal(iconResponse.headers.get('content-type'), 'image/svg+xml');
    assert.match(iconResponse.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await iconResponse.text(), /^<svg/);
    assert.equal((await protocolHandlers.get('photoflow-component')({ method: 'GET', url: 'photoflow-component://icon/unknown' })).status, 404, 'the protocol cannot read arbitrary component paths');
    assert.equal((await protocolHandlers.get('photoflow-component')({ method: 'POST', url: 'photoflow-component://icon/sample-component' })).status, 404, 'the icon protocol is read-only');
    assert.equal(normalizeResolvedTheme('dark'), 'dark'); assert.equal(normalizeResolvedTheme('light'), 'light'); assert.equal(normalizeResolvedTheme('system'), 'light');
    assert.deepEqual(normalizeOpenScope(request), { scopeRelativePath: '图片后期_1', selectedRelativePaths: ['图片后期_1/a.jpg'], sourcePageId: 'project-page-1' });
    assert.throws(() => normalizeOpenScope({ scopeRelativePath: '../escape' }), /Invalid component scope/);
    assert.throws(() => normalizeOpenScope({ scopeRelativePath: 'C:\\escape' }), /Invalid component scope/);
    assert.throws(() => normalizeOpenScope({ scopeRelativePath: '/escape' }), /Invalid component scope/);
    assert.throws(() => normalizeOpenScope({ scopeRelativePath: 'safe', selectedRelativePaths: ['other/a.jpg'] }), /escapes its folder scope/);
    manager.setResolvedTheme('dark');
    const first = await manager.open(request);
    const second = await manager.open({ ...request, workspacePath: 'c:/work', projectName: '项目一（已改名）', projectStatus: '已完成', scopeRelativePath: '图片后期_2', selectedRelativePaths: ['图片后期_2/b.jpg'], sourcePageId: 'project-page-2' });
    assert.equal(first.instanceId, second.instanceId, 'same componentId + workspace + project focuses one page');
    assert.equal(FakeView.created.length, 1);
    const view = FakeView.created[0];
    const boundInstance = manager.instances.get(componentPageKey(request));
    boundInstance.context.emitComponentEvent('sample.undeclared.v1', { hidden: true });
    assert.equal(view.webContents.sent.some(item => item.channel === 'component-sdk:event' && item.payload.topic === 'sample.undeclared.v1'), false, 'undeclared component event topics are not forwarded');
    boundInstance.context.emitComponentEvent('sample.changed.v1', { value: 9 });
    assert.deepStrictEqual(view.webContents.sent.find(item => item.channel === 'component-sdk:event' && item.payload.topic === 'sample.changed.v1')?.payload, { topic: 'sample.changed.v1', payload: { value: 9 } }, 'manifest-declared event topics forward their payload through the single component event channel');
    boundInstance.context.emitComponentEvent('team.return.progress.v1', { operationId: 'return-1', phase: 'matching', progress: 61, message: '正在比对返图' });
    assert.deepStrictEqual(view.webContents.sent.find(item => item.channel === 'component-sdk:event' && item.payload.topic === 'team.return.progress.v1')?.payload, { topic: 'team.return.progress.v1', payload: { operationId: 'return-1', phase: 'matching', progress: 61, message: '正在比对返图' } }, 'Host V2 routes the declared team return progress event and payload to the component page');
    assert.deepEqual(view.options.webPreferences, { preload: 'host-preload-v1.cjs', nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false });
    view.webContents.emit('preload-error', {}, 'C:\\private\\component-preload.cjs', Object.assign(new Error('failed at C:\\private\\secret.txt'), { code: 'ERR_PRELOAD' }));
    view.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///C:/private/component.html', true);
    view.webContents.emit('console-message', {}, { level: 'error', message: `private file:///C:/private/secret.html ${'x'.repeat(400)}`, lineNumber: 12 });
    assert(componentLogs.some(item => item.message === 'Component preload failed' && item.details.errorCode === 'ERR_PRELOAD' && !JSON.stringify(item.details).includes('secret.txt')), 'preload failures are logged without private message or path content');
    assert(componentLogs.some(item => item.message === 'Component page failed to load' && item.details.errorCode === -6), 'main-frame load failures are logged');
    const consoleDiagnostic = componentLogs.find(item => item.message === 'Component renderer console error');
    assert(consoleDiagnostic && consoleDiagnostic.details.messageLength === 439 && !JSON.stringify(consoleDiagnostic.details).includes('secret.html'), 'critical console diagnostics retain bounded metadata without private message content');
    assert.deepEqual(view.webContents.windowOpenHandler(), { action: 'deny' });
    const navigation = { prevented: false, preventDefault() { this.prevented = true; } };
    view.webContents.emit('will-navigate', navigation, 'https://example.com');
    assert(navigation.prevented && view.webContents.permissionCheck() === false, 'navigation and permissions are denied');
    assert(validBounds({ x: 0, y: 40, width: 800, height: 600 }));
    assert(!validBounds({ x: 0, y: 0, width: -1, height: 1 }));
    assert(manager.setBounds(first.instanceId, { x: 2, y: 40, width: 800, height: 600 }));
    const context = await handlers.get('component-sdk:get-context')({ sender: view.webContents });
    assert.equal(context.projectId, 'project-1');
    assert.equal(context.projectName, '项目一（已改名）'); assert.equal(context.projectStatus, '已完成', 'reopening refreshes mutable project metadata in component context');
    assert.equal(context.resolvedTheme, 'dark'); assert.equal(context.themeContractVersion, 1, 'resolved app theme is versioned in component context');
    assert.deepEqual({ scopeRelativePath: context.scopeRelativePath, selectedRelativePaths: context.selectedRelativePaths, sourcePageId: context.sourcePageId }, { scopeRelativePath: '图片后期_2', selectedRelativePaths: ['图片后期_2/b.jpg'], sourcePageId: 'project-page-2' }, 'reopening an existing component updates its controlled browser scope');
    assert(view.webContents.sent.some(item => item.channel === 'component-sdk:context-changed' && item.payload.scopeRelativePath === '图片后期_2'));
    assert(manager.setResolvedTheme('light'));
    assert(view.webContents.sent.some(item => item.channel === 'component-sdk:theme-changed' && item.payload.resolvedTheme === 'light'), 'open component views receive runtime theme changes');
    assert.equal(context.workspacePath, undefined, 'component pages receive project identity but never the private workspace path');
    assert.throws(() => handlers.get('component-sdk:get-context')({ sender: new FakeWebContents() }), /Unauthorized component sender/);
    manager.registerRpcMethod('sample.echo.v1', (_event, payload, boundContext) => ({ payload, projectId: boundContext.projectId }), 'sample-component');
    assert.deepEqual(await handlers.get('component-sdk:rpc')({ sender: view.webContents }, 'sample.echo.v1', { value: 1 }), { payload: { value: 1 }, projectId: 'project-1' });
    assert.throws(() => handlers.get('component-sdk:rpc')({ sender: view.webContents }, 'unknown.v1', {}), /Unknown component RPC method/);
    activeSampleDescriptor = parseComponentHostManifest({ ...manifest, version: '3.4.6' }, componentRoot);
    const upgraded = await manager.open({ ...request, workspacePath: 'c:/work' });
    assert.notEqual(upgraded.instanceId, first.instanceId, 'an installed component version change replaces the stale renderer view');
    assert(view.webContents.destroyed && FakeView.created.length === 2, 'the old renderer is destroyed before the updated component page loads');
    assert.equal(manager.closeProject('C:/WORK', 'project-1'), 1);
    assert(view.webContents.destroyed && children.length === 0, 'project close explicitly destroys and detaches the component view');
    assert.equal(manager.close(first.instanceId), false, 'destroy is idempotent');
    assert.equal(componentPageKey(request), componentPageKey({ ...request, workspacePath: 'c:/work' }));

    const developmentHandlers = new Map();
    const invokedSettingsMethods = [];
    const developmentManager = new ComponentViewManager({ WebContentsView: FakeView, mainWindow, registry: developmentRegistry, preloadPath: 'host-preload.cjs', ipcMain: { handle: (channel, handler) => developmentHandlers.set(channel, handler) }, serviceManager: { supports: () => true, invoke: (_componentId, method, _payload, context) => { invokedSettingsMethods.push({ method, surface: context.surface }); return { success: true }; } } });
    const developmentAction = developmentManager.listToolbarActions().find(item => item.componentId === 'team-retouch');
    assert.match(developmentAction.iconUrl, /^photoflow-component:\/\/icon\/team-retouch\?v=/, 'the development toolbar action uses the component-owned icon protocol URL');
    const developmentPage = await developmentManager.open({ ...request, componentId: 'team-retouch', pageId: 'main' });
    const developmentView = FakeView.created.at(-1);
    assert.equal(developmentView.options.webPreferences.preload, 'host-preload.cjs', 'Host API V2 selects the core preload without changing its bridge ABI');
    assert.equal(developmentView.webContents.loadedEntry, path.join(repositoryRoot, 'artifacts', 'component-renderers', 'team-retouch', 'index.html'), 'clicking the development toolbar action loads the prepared independent renderer');
    assert.equal(developmentPage.componentId, 'team-retouch');
    developmentManager.activate('');
    assert.equal(developmentView.visible, false, 'entering application settings hides the active project component before the settings entry starts loading');
    const settingsContribution = developmentManager.listSettingsPages().find(item => item.componentId === 'team-retouch');
    assert.equal(settingsContribution.label, '团片协作');
    const developmentSettingsPage = await developmentManager.openSettings({ componentId: 'team-retouch', pageId: 'settings', leaseId: 'settings-lease-primary' });
    const developmentSettingsView = FakeView.created.at(-1);
    assert.equal(developmentSettingsView.webContents.loadedEntry, path.join(repositoryRoot, 'artifacts', 'component-renderers', 'team-retouch', 'settings.html'));
    const settingsContext = await developmentHandlers.get('component-sdk:get-context')({ sender: developmentSettingsView.webContents });
    assert.equal(developmentSettingsPage.surface, 'application.settings');
    assert.deepEqual({ surface: settingsContext.surface, projectId: settingsContext.projectId, projectName: settingsContext.projectName, projectStatus: settingsContext.projectStatus, scopeRelativePath: settingsContext.scopeRelativePath, selectedRelativePaths: settingsContext.selectedRelativePaths, events: settingsContext.events }, { surface: 'application.settings', projectId: '', projectName: '', projectStatus: '', scopeRelativePath: '', selectedRelativePaths: [], events: [] });
    await developmentHandlers.get('component-sdk:rpc')({ sender: developmentSettingsView.webContents }, 'team.settings.get.v1', {});
    assert.deepEqual(invokedSettingsMethods, [{ method: 'team.settings.get.v1', surface: 'application.settings' }]);
    assert.throws(() => developmentHandlers.get('component-sdk:rpc')({ sender: developmentSettingsView.webContents }, 'team.project.get.v1', {}), /not allowed on the application settings surface/);
    assert(developmentManager.releaseSettings({ componentId: 'team-retouch', pageId: 'settings', leaseId: 'settings-lease-primary' }));
    await new Promise(resolve => setImmediate(resolve));

    let resolveDelayedSettings;
    const originalLoadFile = FakeWebContents.prototype.loadFile;
    FakeWebContents.prototype.loadFile = function delayedLoadFile(entry) { this.loadedEntry = entry; return new Promise(resolve => { resolveDelayedSettings = resolve; }); };
    const firstLeaseOpen = developmentManager.openSettings({ componentId: 'team-retouch', pageId: 'settings', leaseId: 'settings-lease-strict-a' });
    assert(developmentManager.releaseSettings({ componentId: 'team-retouch', pageId: 'settings', leaseId: 'settings-lease-strict-a' }), 'StrictMode cleanup releases the first pending lease before load resolves');
    const secondLeaseOpen = developmentManager.openSettings({ componentId: 'team-retouch', pageId: 'settings', leaseId: 'settings-lease-strict-b' });
    await new Promise(resolve => setImmediate(resolve));
    const delayedView = FakeView.created.at(-1);
    assert.equal(delayedView.webContents.destroyed, false, 'a replacement lease acquired in the same turn keeps the loading singleton alive');
    resolveDelayedSettings();
    await assert.rejects(firstLeaseOpen, /lease was released/);
    const secondLeasePage = await secondLeaseOpen;
    assert.strictEqual(developmentManager.instancesById.get(secondLeasePage.instanceId)?.view, delayedView, 'the surviving lease resolves to the delayed singleton');
    assert(developmentManager.releaseSettings({ componentId: 'team-retouch', pageId: 'settings', leaseId: 'settings-lease-strict-b' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delayedView.webContents.destroyed, true, 'the final settings lease destroys the shared view');
    FakeWebContents.prototype.loadFile = originalLoadFile;
    developmentManager.destroy();

    const replacementLoads = [];
    FakeWebContents.prototype.loadFile = function generationLoadFile(entry) { this.loadedEntry = entry; let resolve; const promise = new Promise(done => { resolve = done; }); replacementLoads.push({ resolve, view: this }); return promise; };
    let replacementDescriptor = { ...developmentTeam, componentVersion: 'generation-a' };
    const replacementManager = new ComponentViewManager({ WebContentsView: FakeView, mainWindow, registry: { list: () => [replacementDescriptor], resolve: () => replacementDescriptor }, preloadPath: 'host-preload.cjs', ipcMain: { handle() {} } });
    const replacementRequest = { ...request, componentId: 'team-retouch', pageId: 'main', projectId: 'generation-project' };
    const staleGenerationOpen = replacementManager.open(replacementRequest);
    await new Promise(resolve => setImmediate(resolve));
    replacementDescriptor = { ...replacementDescriptor, componentVersion: 'generation-b' };
    const currentGenerationOpen = replacementManager.open(replacementRequest);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replacementLoads.length, 2); replacementLoads[0].resolve();
    await assert.rejects(staleGenerationOpen, /superseded/);
    replacementLoads[1].resolve(); const currentGeneration = await currentGenerationOpen;
    assert.equal(replacementManager.instancesById.get(currentGeneration.instanceId)?.descriptor.componentVersion, 'generation-b', 'a stale load completion cannot delete the newer same-key instance');
    replacementManager.destroy(); FakeWebContents.prototype.loadFile = originalLoadFile;

    const suspensionManager = new ComponentViewManager({ WebContentsView: FakeView, mainWindow, registry: liveRegistry, preloadPath: 'host-preload.cjs', ipcMain: { handle() {} } });
    assert(suspensionManager.setHostSurfaceSuspended({ rendererToken: 'renderer-a', revision: 1, suspended: true }));
    const suspendedFirst = await suspensionManager.open({ ...request, projectId: 'suspended-a' });
    const suspendedFirstView = FakeView.created.at(-1);
    assert.equal(suspendedFirstView.visible, false, 'a view created during host suspension stays visually hidden while becoming logically active');
    const suspendedSecond = await suspensionManager.open({ ...request, projectId: 'suspended-b' });
    const suspendedSecondView = FakeView.created.at(-1);
    assert.equal(suspendedFirstView.visible, false); assert.equal(suspendedSecondView.visible, false, 'switching component pages during suspension must not reveal either view');
    assert.equal(suspendedFirstView.webContents.sent.filter(item => item.channel === 'component-sdk:deactivate').length, 1, 'logical page switching still emits one business deactivation');
    assert.equal(suspendedSecondView.webContents.sent.filter(item => item.channel === 'component-sdk:deactivate').length, 0, 'visual suspension is not reported as business deactivation');
    assert(suspensionManager.setHostSurfaceSuspended({ rendererToken: 'renderer-a', revision: 2, suspended: false }));
    assert.equal(suspendedFirstView.visible, false); assert.equal(suspendedSecondView.visible, true, 'resuming restores only the latest logically active component page');
    assert.equal(suspensionManager.setHostSurfaceSuspended({ rendererToken: 'renderer-a', revision: 1, suspended: true }), false, 'an old renderer revision cannot re-suspend a restored page');
    assert.equal(suspendedSecondView.visible, true);
    assert(suspensionManager.setHostSurfaceSuspended({ rendererToken: 'renderer-after-reload', revision: 0, suspended: true }), 'a renderer reload starts a fresh revision namespace');
    assert.equal(suspendedSecondView.visible, false);
    assert.equal(suspendedSecondView.webContents.sent.filter(item => item.channel === 'component-sdk:deactivate').length, 1, 'renderer reload clears the stale logical activation instead of restoring an orphaned view');
    suspensionManager.activate(suspendedFirst.instanceId);
    assert.equal(suspendedFirstView.visible, false, 'activation remains visual-only hidden during a post-reload suspension');
    assert(suspensionManager.setHostSurfaceSuspended({ rendererToken: 'renderer-after-reload', revision: 1, suspended: false }));
    assert.equal(suspendedFirstView.visible, true); assert.equal(suspendedSecondView.visible, false);
    suspensionManager.close(suspendedSecond.instanceId);
    suspensionManager.destroy();

    const pageModel = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'components', 'component-page-model.ts')).href);
    const action = manager.listToolbarActions()[0];
    assert.match(action.iconUrl, /^photoflow-component:\/\/icon\/sample-component\?v=3\.4\.6$/, 'the renderer only receives a host-issued component icon URL for the active component version');
    const project = { id: 'project-1', name: '项目一', path: 'C:/Work/项目一', status: '后期中', updatedAt: 1 };
    const one = pageModel.ensureComponentPage([], action, project, 'C:/Work', 'project-page:active');
    assert.equal(one.page.componentVersion, action.componentVersion);
    assert(pageModel.componentPageIsAvailable(one.page, [{ id: action.componentId, version: action.componentVersion, installed: true, compatible: true, status: 'installed' }]));
    assert.equal(pageModel.componentPageIsAvailable(one.page, [{ id: action.componentId, version: '99.0.0', installed: true, compatible: true, status: 'installed' }]), false, 'upgraded components invalidate stale project page instances');
    assert.equal(pageModel.componentPageIsAvailable(one.page, [{ id: action.componentId, version: action.componentVersion, installed: true, compatible: false, status: 'invalid' }]), false);
    assert.equal(pageModel.componentPageActivationSucceeded({ success: false }), false, 'failed native activation is treated as a stale page instead of a successful blank tab');
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
