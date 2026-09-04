const assert = require('node:assert/strict');
const { transitionComponentEnabled } = require('../electron/modules/system-ipc.cjs');

(async () => {
  const componentId = 'fixture-adopter';
  let enabled = true;
  const calls = [];
  const pluginService = {
    list: () => [{ id: componentId, installed: true, compatible: true, enabled }],
    setComponentEnabled: (_id, next) => { enabled = next; calls.push(`state:${next}`); return { componentId, enabled: next }; },
  };
  const barrier = { drain: async () => { calls.push('drain'); }, release: () => { calls.push('release'); } };
  const transitionLease = { requestStop: () => { calls.push('request-stop'); }, promote: async () => { calls.push('promote'); } };
  const dependencies = {
    componentId, pluginService, transitionLease,
    componentCapabilityBroker: { blockComponent: () => { calls.push('block'); return barrier; } },
    componentViewManager: { closeComponentAndWait: async () => { calls.push('close'); } },
    processSupervisor: { stopWhere: async () => { calls.push('processes'); } },
    componentServiceManager: { stop: async () => { calls.push('service'); } },
    abortComponentNetworkRequests: () => { calls.push('network'); },
  };

  assert.deepEqual(await transitionComponentEnabled({ ...dependencies, enabled: false }), { componentId, enabled: false });
  assert.equal(enabled, false);
  assert.deepEqual(calls, ['block', 'request-stop', 'processes', 'service', 'close', 'network', 'drain', 'promote', 'state:false', 'release']);
  assert.deepEqual(await transitionComponentEnabled({ ...dependencies, enabled: true }), { componentId, enabled: true });
  assert.equal(enabled, true, 're-enable restores registry discovery without reinstalling files');
  console.log('Component enable transition tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
