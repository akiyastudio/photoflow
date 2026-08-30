const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');

const root = path.resolve(__dirname, '..', 'examples', 'declarative-settings-v1');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
const descriptor = parseComponentHostManifest(manifest, root);
assert.equal(descriptor.settingsForms.length, 1);
assert.equal(descriptor.settingsForms[0].form.schemaVersion, 1);
assert.equal(descriptor.settingsPages.length, 0, 'declarative settings do not create an isolated custom page');

const schema2020 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron', 'contracts', 'schemas', 'component-manifest-v2.schema.json'), 'utf8'));
const schema = JSON.parse(JSON.stringify(schema2020).replaceAll('#/$defs/', '#/definitions/')); schema.definitions = schema.$defs; delete schema.$defs; delete schema.$schema; delete schema.$id;
const validate = new Ajv({ allErrors: true }).compile(schema);
assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
const hybridManifest = structuredClone(manifest); hybridManifest.componentHost.contributions.find(item => item.type === 'application.settingsForm').customPage = { title: 'Advanced', entry: 'ui/index.html', rpcMethods: ['example.ping.v1'] };
const hybridDescriptor = parseComponentHostManifest(hybridManifest, root);
assert.equal(hybridDescriptor.settingsForms[0].customPage.title, 'Advanced'); assert.equal(validate(hybridManifest), true, JSON.stringify(validate.errors));
assert.equal(ComponentViewManager.prototype.listSettingsPages.call({ registry: { list: () => [hybridDescriptor] } })[0].renderMode, 'hybrid');
const invalidHybrid = structuredClone(hybridManifest); invalidHybrid.componentHost.contributions.find(item => item.type === 'application.settingsForm').customPage.rpcMethods = ['example.missing.v1'];
assert.throws(() => parseComponentHostManifest(invalidHybrid, root), /not declared by the service/);

let settings = { enabled: false, mode: 'not-valid', quality: 90 }; let revision = 3; let serviceInvocations = 0;
const broker = { invoke: async (_descriptor, method, payload, context) => {
  if (method === 'dialogs') return { apiVersion: 7, confirmed: true };
  assert.equal(method, 'component.settings'); assert.equal(context.surface, 'application.settings');
  if (payload.action === 'merge') { settings = { ...settings, ...payload.settings }; revision += 1; }
  return { apiVersion: 7, revision, settings };
} };
const handlers = new Map();
const manager = new ComponentViewManager({
  WebContentsView: function unused() {}, mainWindow: {}, registry: { list: () => [descriptor], resolve: id => id === descriptor.componentId ? descriptor : null },
  preloadPath: 'preload.cjs', ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, capabilityBroker: broker,
  serviceManager: { invoke: () => { serviceInvocations += 1; throw new Error('declarative settings must not start the component service'); } },
});
(async () => {
  try {
    const listed = manager.listSettingsPages(); assert.equal(listed.length, 1); assert.equal(listed[0].renderMode, 'declarative'); assert.equal(listed[0].form.groups[0].fields.length, 4);
    const read = await manager.readSettingsForm({ componentId: descriptor.componentId, pageId: 'settings' });
    assert.deepEqual(read.values, { enabled: false, mode: 'balanced', displayName: '', quality: 90 }, 'invalid stored values fall back to declared defaults');
    const updated = await manager.updateSettingsForm({ componentId: descriptor.componentId, pageId: 'settings', patch: { mode: 'quality', displayName: 'Example' } });
    assert.equal(updated.revision, 4); assert.equal(updated.values.mode, 'quality'); assert.equal(updated.values.displayName, 'Example');
    await assert.rejects(manager.updateSettingsForm({ componentId: descriptor.componentId, pageId: 'settings', patch: { quality: 1000 } }), /Invalid settings form value/);
    assert.equal(serviceInvocations, 0);
    const sender = { id: 42 }; manager.senderBindings.set(sender.id, { view: { webContents: sender }, descriptor, context: { componentId: descriptor.componentId, surface: 'application.settings' } });
    assert.deepEqual(await handlers.get('component-sdk:dialog')({ sender }, { kind: 'confirm', title: 'Confirm' }), { apiVersion: 7, confirmed: true }, 'custom settings pages receive the versioned frontend dialog interface');
    manager.senderBindings.delete(sender.id);
    const missingCapability = structuredClone(manifest); missingCapability.componentHost.service.capabilities = [];
    assert.throws(() => parseComponentHostManifest(missingCapability, root), /require component.settings/);
    console.log('Declarative component settings Host rendering/storage contract tests passed');
  } finally { manager.destroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
