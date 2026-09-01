const assert = require('node:assert/strict');
const { createPluginService } = require('../electron/services/plugin-service.cjs');

const component = {
  id: 'fixture-runtime-component', installed: true, enabled: true, compatible: true,
  capabilities: ['fixture.runtime.cli'], command: 'fixture-runtime.exe', argsPrefix: ['component-prefix'],
  manifest: { runtimeCommandCapabilities: { 'fixture.runtime.cli': { argsPrefix: ['capability-prefix'] } } },
};
const calls = [];
const service = createPluginService({
  app: { isPackaged: false },
  registry: { list: () => [component], resolve: id => id === component.id ? component : null },
  runJsonCommand: async (run, label) => { calls.push({ run, label }); return { success: true }; },
});

(async () => {
  await service.runJsonForComponentCapability(component.id, 'fixture.runtime.cli', ['opaque-value'], 1000);
  assert.deepEqual(calls[0].run, { command: 'fixture-runtime.exe', args: ['component-prefix', 'capability-prefix', 'opaque-value'] });
  assert.match(calls[0].label, /fixture\.runtime\.cli/);
  assert.throws(() => service.runJsonForComponentCapability(component.id, 'undeclared.runtime', [], 1000), error => error.code === 'PLUGIN_MISSING');
  console.log('Plugin service manifest runtime capability resolution tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
