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
  assert.deepEqual(calls, ['block', 'request-stop', 'service', 'processes', 'close', 'network', 'drain', 'promote', 'state:false', 'release']);
  assert.deepEqual(await transitionComponentEnabled({ ...dependencies, enabled: true }), { componentId, enabled: true });
  assert.equal(enabled, true, 're-enable restores registry discovery without reinstalling files');
  calls.length = 0; let failStop = true;
  const retryDependencies = { ...dependencies, processSupervisor: { stopWhere: async () => { calls.push('processes'); if (failStop) { failStop = false; throw Object.assign(new Error('termination failed'), { code: 'PROCESS_TERMINATION_FAILED' }); } } } };
  await assert.rejects(transitionComponentEnabled({ ...retryDependencies, enabled: false }), error => error.code === 'PROCESS_TERMINATION_FAILED');
  assert.equal(enabled, true, 'failed process-tree stop cannot mutate enabled state');
  assert.equal(calls.includes('state:false'), false); assert.equal(calls.at(-1), 'release', 'failed transition releases its busy barrier');
  calls.length = 0;
  assert.deepEqual(await transitionComponentEnabled({ ...retryDependencies, enabled: false }), { componentId, enabled: false });
  assert.equal(enabled, false, 'retry succeeds after the termination failure clears');
  console.log('Component enable transition tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
