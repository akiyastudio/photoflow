const assert = require('node:assert/strict');
const path = require('node:path');
const { createHostSimulator } = require('./host-simulator.cjs');

let lifecycleCalls = 0;
const simulator = createHostSimulator({
  service: path.join(__dirname, '..', 'service.cjs'),
  context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'application.settings' },
  capabilities: { 'component.lifecycle': payload => { lifecycleCalls += 1; return { success: true, action: payload.action }; } },
});

(async () => {
  try {
    const direct = await simulator.request('team.advanced.preflight.v1');
    assert.equal(direct.success, true);
    const accepted = await simulator.request('team.advanced.uninstall.v1', { acceptOnly: true, operationId: 'advanced-global' });
    assert.equal(accepted.scope, 'application.settings'); assert.equal(accepted.revision, undefined);
    const completed = await simulator.request('team.operation.run.v1', { operationId: 'advanced-global' });
    assert.equal(completed.success, true); assert.equal(lifecycleCalls, 2);
    console.log('Team-retouch application.settings lifecycle global-scope tests passed');
  } finally { await simulator.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
