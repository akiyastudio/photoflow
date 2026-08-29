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
      { type: 'component.sidePanel', id: 'panel', label: 'Fixture', title: 'Fixture panel', pageId: 'panel-ui', rpcMethods: ['fixture.run.v1'] },
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
  close() { this.destroyed = true; this.emit('destroyed'); }
}
class View {
  constructor() { this.webContents = new Contents(); views.push(this); }
  setBounds(value) { this.bounds = value; }
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
    assert.equal((await open('page-a')).instanceId, first.instanceId, 'the same file page must reuse its panel instance');
    const authorizedDrop = await handlers.get('component-sdk:authorize-files')({ sender: views[0].webContents }, ['dropped.mp4']);
    assert.deepEqual(authorizedDrop.inputs, [{ name: 'dropped.mp4', token: 'token-0' }], 'component preload can exchange real dropped File objects for scoped input tokens');
    let escapePrevented = false;
    views[0].webContents.emit('before-input-event', { preventDefault: () => { escapePrevented = true; } }, { type: 'keyDown', key: 'Escape' });
    assert.equal(escapePrevented, true);
    assert.deepEqual(hostMessages.at(-1), ['component-host:panel-close-requested', first.instanceId], 'Escape from the native panel content must request the unified panel to close');
    manager.destroy();

    const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'components', 'ComponentToolPanelSurface.tsx'), 'utf8');
    for (const marker of ['tool-panel-backdrop', 'tool-panel-window', 'tool-panel-header', 'tool-panel-body', '关闭插件面板', 'setComponentPageBounds']) assert(panelSource.includes(marker));
    const dockSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'components', 'ComponentContributionDock.tsx'), 'utf8');
    assert(dockSource.includes("opened?.contribution.type === 'component.sidePanel'") && dockSource.includes('<ComponentToolPanelSurface'), 'side panels must use the unified file-page panel surface');
    const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
    assert(workspaceSource.includes("item.placement === 'workspace.videoTools'") && workspaceSource.includes('videoTranscodeContribution') && workspaceSource.includes('videoSplitContribution'), 'grouped video component panels must remain under the file-page video tools menu');
    assert(!workspaceSource.includes("open={panel === 'video-transcode'}") && !workspaceSource.includes("open={panel === 'video-split'}"), 'the file page must not retain duplicate built-in transcode or split panels');
    const nativePanelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectToolModal.tsx'), 'utf8');
    assert(!nativePanelSource.includes('ComponentToolPanelSurface'), 'existing native panel properties and behavior must remain independent');
    console.log('Panel-only component manifest, file-page ownership, and unified panel host tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
