const assert = require('assert').strict;
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Ajv = require('ajv');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-panel-plugin-'));
fs.mkdirSync(path.join(root, 'ui'));
fs.writeFileSync(path.join(root, 'ui', 'panel.html'), '<!doctype html>');
fs.writeFileSync(path.join(root, 'service.cjs'), '');

const manifest = {
  apiVersion: 1,
  id: 'panel-only-fixture',
  version: '1.0.0',
  componentHost: {
    contractVersion: 2,
    compatibility: { minHostApiVersion: 7, maxHostApiVersion: 7 },
    contributions: [
      { type: 'component.fullPage', id: 'panel-ui', title: 'Fixture panel', entry: 'ui/panel.html' },
      { type: 'component.sidePanel', id: 'panel', label: 'Fixture', title: 'Fixture panel', description: 'Fixture panel description.', pageId: 'panel-ui', rpcMethods: ['fixture.run.v1'] },
    ],
    service: { protocolVersion: 1, runtime: 'node', entrypoints: { default: 'service.cjs' }, rpcMethods: ['fixture.run.v1'], capabilities: ['dialogs.v7'], permissions: ['dialogs'], events: [] },
  },
};

let nextId = 1;
const views = [];
class Contents extends EventEmitter {
  constructor() { super(); this.id = nextId++; this.destroyed = false; this.session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }; }
  isDestroyed() { return this.destroyed; }
  loadFile() { return Promise.resolve(); }
  send() {}
  setWindowOpenHandler() {}
  insertCSS(value) { this.insertedCss = value; return Promise.resolve(`css-${this.id}`); }
  removeInsertedCSS() { return Promise.resolve(); }
  close() { this.destroyed = true; this.emit('destroyed'); }
}
class View {
  constructor() { this.webContents = new Contents(); views.push(this); }
  setBounds(value) { this.bounds = value; }
  setBorderRadius(value) { this.borderRadius = value; }
  setVisible(value) { this.visible = value; }
}

(async () => {
  try {
    const descriptor = parseComponentHostManifest(manifest, root);
    assert.equal(descriptor.toolbarAction, null, 'panel-only components must not synthesize a toolbar action');
    assert.equal(descriptor.fullPage, null, 'panel-only components must not expose a tab page');
    assert.equal(descriptor.pages.length, 1);
    assert.equal(descriptor.contributions[0].type, 'component.sidePanel');
    const entryOnlyManifest = { ...manifest, componentHost: { ...manifest.componentHost, contributions: [manifest.componentHost.contributions[0], { type: 'component.fullPage', id: 'unused-ui', title: 'Unused', entry: 'ui/panel.html' }] } };
    assert.throws(() => parseComponentHostManifest(entryOnlyManifest, root), /toolbar action or side panel/);
    const schema2020 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron', 'contracts', 'schemas', 'component-manifest-v2.schema.json'), 'utf8'));
    const schema = JSON.parse(JSON.stringify(schema2020).replaceAll('#/$defs/', '#/definitions/'));
    schema.definitions = schema.$defs; delete schema.$defs; delete schema.$schema; delete schema.$id;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
    assert.equal(validate(entryOnlyManifest), false, 'the public schema must require a toolbar action or side panel');
    const exampleRoot = path.join(__dirname, '..', 'examples', 'panel-only-v7');
    const exampleDescriptor = parseComponentHostManifest(JSON.parse(fs.readFileSync(path.join(exampleRoot, 'component.json'), 'utf8')), exampleRoot);
    assert.equal(exampleDescriptor.toolbarAction, null);
    assert.equal(exampleDescriptor.contributions[0].type, 'component.sidePanel');
    const videoToolsRoot = path.join(__dirname, '..', 'extensions', 'video-tools');
    const videoToolsManifest = JSON.parse(fs.readFileSync(path.join(videoToolsRoot, 'component.json'), 'utf8'));
    assert.equal(validate(videoToolsManifest), true, JSON.stringify(validate.errors));
    const videoToolsDescriptor = parseComponentHostManifest(videoToolsManifest, videoToolsRoot);
    assert.deepEqual(videoToolsDescriptor.contributions.map(item => [item.id, item.placement]), [['transcode', 'workspace.videoTools'], ['split', 'workspace.videoTools']]);
    assert.equal(videoToolsDescriptor.contributions.find(item => item.id === 'transcode').description, '转换视频封装、编码、画质与音频。');

    const handlers = new Map();
    const hostMessages = [];
    const manager = new ComponentViewManager({
      WebContentsView: View,
      mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => hostMessages.push(args) }, contentView: { addChildView() {}, removeChildView() {} } },
      registry: { list: () => [descriptor], resolve: id => id === descriptor.componentId ? descriptor : null },
      preloadPath: 'component-preload.cjs',
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      serviceManager: { supports: () => true, invoke: async () => ({ ok: true }) },
      inputGrantService: { grantDroppedInputs: async paths => ({ apiVersion: 7, inputs: paths.map((name, index) => ({ name, token: `token-${index}` })) }) },
    });
    assert.deepEqual(manager.listToolbarActions(), [], 'panel-only components must not create a new-page toolbar action');
    assert.equal(manager.listContributions()[0].description, 'Fixture panel description.', 'panel descriptions pass through the generic Host contribution contract');

    const open = sourcePageId => manager.openContribution({
      componentId: descriptor.componentId,
      contributionId: 'panel',
      type: 'component.sidePanel',
      workspacePath: 'C:/workspace',
      projectId: 'project',
      projectName: 'Project',
      projectStatus: 'active',
      scopeRelativePath: 'folder',
      selectedRelativePaths: ['folder/image.jpg'],
      sourcePageId,
    });
    const first = await open('page-a');
    const second = await open('page-b');
    assert.notEqual(first.instanceId, second.instanceId, 'each file page must own its component panel instance');
    assert.equal(views.length, 2);
    assert(views.every(view => view.borderRadius === 15), 'native component side-panel views must clip to the Host panel radius instead of covering the bottom corners');
    assert.equal((await open('page-a')).instanceId, first.instanceId, 'the same file page must reuse its panel instance');
    assert(views.every(view => view.webContents.insertedCss.includes('::-webkit-scrollbar') && view.webContents.insertedCss.includes('::-webkit-scrollbar-button{display:none') && view.webContents.insertedCss.includes('--pf-panel-body:#ffffff') && view.webContents.insertedCss.includes('.pf-panel-section') && view.webContents.insertedCss.includes('body{margin:0;padding:22px}') && view.webContents.insertedCss.includes('padding:.55rem .9rem;font-size:.875rem')), 'every isolated component panel inherits Host spacing, controls, tokens, primitives, and scrollbar styling');
    const context = await handlers.get('component-sdk:get-context')({ sender: views[0].webContents });
    assert.equal(context.uiContractVersion, 1); assert.equal(context.panelStyleContractVersion, 1); assert.equal(context.panelLayoutContractVersion, 1);
    const measured = await handlers.get('component-sdk:content-size')({ sender: views[0].webContents }, { width: 928, height: 412 });
    assert.deepEqual(measured, { accepted: true, changed: true });
    assert.deepEqual(hostMessages.at(-1), ['component-host:panel-content-size', { instanceId: first.instanceId, width: 928, height: 412 }], 'isolated component content height is forwarded to the owning Host panel');
    const authorizedDrop = await handlers.get('component-sdk:authorize-files')({ sender: views[0].webContents }, ['dropped.mp4']);
    assert.deepEqual(authorizedDrop.inputs, [{ name: 'dropped.mp4', token: 'token-0' }], 'component preload can exchange real dropped File objects for scoped input tokens');
    let escapePrevented = false;
    views[0].webContents.emit('before-input-event', { preventDefault: () => { escapePrevented = true; } }, { type: 'keyDown', key: 'Escape' });
    assert.equal(escapePrevented, true);
    assert.deepEqual(hostMessages.at(-1), ['component-host:panel-close-requested', first.instanceId], 'Escape from the native panel content must request the unified panel to close');
    manager.destroy();

    const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'components', 'ComponentToolPanelSurface.tsx'), 'utf8');
    for (const marker of ['tool-panel-backdrop', 'tool-panel-window', 'tool-panel-header', 'tool-panel-body', '关闭插件面板', '收起到后台', 'isActivePresentedBackgroundTaskForPanel', 'onComponentPanelCloseRequested', 'setComponentPageBounds', 'onComponentPanelContentSizeChanged', 'contentHeight + 60']) assert(panelSource.includes(marker));
    assert(!panelSource.includes("height: 'min(720px, 90vh)'"), 'component panels must not retain a fixed 720px body');
    assert(panelSource.includes('contribution.description') && !panelSource.includes('>插件面板<'), 'component panels render the declared native-panel description instead of a plugin-only subtitle');
    const dockSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'components', 'ComponentContributionDock.tsx'), 'utf8');
    assert(dockSource.includes("opened?.contribution.type === 'component.sidePanel'") && dockSource.includes('<ComponentToolPanelSurface'), 'side panels must use the unified file-page panel surface');
    assert(dockSource.includes('componentPanelTaskKind') && dockSource.includes('photoflow:restore-panel-task') && dockSource.includes('setComponentPanelOpen(false)') && !dockSource.includes('if (!active && opened) { void window.electronAPI.setComponentPageBounds(opened.instanceId, { x: 0, y: 0, width: 0, height: 0 }); void window.electronAPI.activateComponentPage(\'\'); void window.electronAPI.closeComponentPage'), 'component panels preserve their live instance while minimized and restore through the shared task center');
    const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
    assert(workspaceSource.includes("item.placement === 'workspace.videoTools'") && workspaceSource.includes('videoTranscodeContribution') && workspaceSource.includes('videoSplitContribution'), 'grouped video component panels must remain under the file-page video tools menu');
    assert(!workspaceSource.includes("open={panel === 'video-transcode'}") && !workspaceSource.includes("open={panel === 'video-split'}"), 'the file page must not retain duplicate built-in transcode or split panels');
    const nativePanelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectToolModal.tsx'), 'utf8');
    assert(!nativePanelSource.includes('ComponentToolPanelSurface'), 'existing native panel properties and behavior must remain independent');
    const componentPreload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'component-preload.cjs'), 'utf8');
    assert(componentPreload.includes("ipcRenderer.invoke('component-sdk:content-size'") && componentPreload.includes('new ResizeObserver(scheduleContentSize)'), 'component preload reports live intrinsic content size without exposing DOM access to Host renderer');
    console.log('Panel-only component manifest, file-page ownership, and unified panel host tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
