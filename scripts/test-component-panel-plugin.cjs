const assert = require('assert').strict;
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
    service: { protocolVersion: 1, runtime: 'node', entrypoints: { default: 'service.cjs' }, rpcMethods: ['fixture.run.v1'], capabilities: [], permissions: [], events: [] },
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
    assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: [manifest.componentHost.contributions[0], { type: 'component.fullPage', id: 'unused-ui', title: 'Unused', entry: 'ui/panel.html' }] } }, root), /toolbar action or side panel/);

    const handlers = new Map();
    const manager = new ComponentViewManager({
      WebContentsView: View,
      mainWindow: { contentView: { addChildView() {}, removeChildView() {} } },
      registry: { list: () => [descriptor], resolve: id => id === descriptor.componentId ? descriptor : null },
      preloadPath: 'component-preload.cjs',
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      serviceManager: { supports: () => true, invoke: async () => ({ ok: true }) },
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
    manager.destroy();

    const panelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'components', 'ComponentToolPanelSurface.tsx'), 'utf8');
    for (const marker of ['tool-panel-backdrop', 'tool-panel-window', 'tool-panel-header', 'tool-panel-body', '关闭插件面板', 'setComponentPageBounds']) assert(panelSource.includes(marker));
    const dockSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'components', 'ComponentContributionDock.tsx'), 'utf8');
    assert(dockSource.includes("opened?.contribution.type === 'component.sidePanel'") && dockSource.includes('<ComponentToolPanelSurface'), 'side panels must use the unified file-page panel surface');
    const nativePanelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'workspace', 'ProjectToolModal.tsx'), 'utf8');
    assert(!nativePanelSource.includes('ComponentToolPanelSurface'), 'existing native panel properties and behavior must remain independent');
    console.log('Panel-only component manifest, file-page ownership, and unified panel host tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
