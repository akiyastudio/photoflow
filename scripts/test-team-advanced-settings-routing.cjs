const assert = require('node:assert/strict');
const path = require('node:path');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');
const { createHostSimulator } = require('../extensions/team-retouch/tests/host-simulator.cjs');
const manifest = require('../extensions/team-retouch/component.template.json');
const settingsPage = manifest.componentHost.contributions.find(item => item.type === 'application.settingsPage');
const context = { componentId: manifest.id, componentVersion: manifest.version, surface: 'application.settings' };
const lifecycleCalls = [];
const simulator = createHostSimulator({
  service: path.resolve(__dirname, '../extensions/team-retouch/service.cjs'), context,
  capabilities: { 'component.lifecycle': payload => { lifecycleCalls.push(payload.action); return { success: true }; } },
});
const handlers = new Map();
const sender = { id: 1 };
ComponentViewManager.prototype.registerComponentSdkIpc.call({
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  senderBindings: new Map([[1, { view: { webContents: sender }, context, settingsPage }]]),
  serviceManager: {
    supports: (_id, method) => manifest.componentHost.service.rpcMethods.includes(method),
    invoke: (_id, method, payload) => simulator.request(method, payload),
  },
});
const rpc = (method, payload) => handlers.get('component-sdk:rpc')({ sender }, method, payload);
(async () => {
  try {
    for (const action of ['preflight', 'uninstall']) {
      const operationId = `settings-${action}`;
      const accepted = await rpc(`team.advanced.${action}.v1`, { acceptOnly: true, operationId });
      assert.equal(accepted.accepted, true);
      const result = await rpc('team.operation.run.v1', { operationId });
      assert.equal(result.success, true);
      const status = await rpc('team.operation.get.v1', { operationId });
      assert(status);
    }
    assert.deepEqual(lifecycleCalls, ['preflight', 'uninstall']);
    assert.throws(() => rpc('team.patch.detect.v1', {}), /not allowed on the application settings surface/);
    console.log('Advanced settings tasks pass the real Host surface allowlist; project operations remain denied.');
  } finally { await simulator.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
