const assert = require('node:assert/strict');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');

const descriptor = {
  componentId: 'fixture.component',
  service: { capabilities: ['component.settings'], permissions: ['component.settings'] },
};

const runCase = async handler => {
  let acquired = 0; let released = 0; let observedContext;
  const lease = { componentId: descriptor.componentId, token: Symbol('lease'), release: () => { released += 1; } };
  const broker = new ComponentCapabilityBroker({ lifecycleCoordinator: {
    acquireWork: (componentId, operation) => {
      acquired += 1;
      assert.equal(componentId, descriptor.componentId);
      assert.equal(operation, 'capability:component.settings');
      return lease;
    },
  } });
  broker.register('component.settings', (payload, context) => {
    assert.deepEqual(payload, { action: 'get' });
    assert.equal(Object.hasOwn(payload, 'lifecycleLease'), false, 'lease never enters plugin payload');
    observedContext = context;
    return handler();
  });
  return { broker, counts: () => ({ acquired, released }), lease, context: () => observedContext };
};

(async () => {
  const sync = await runCase(() => ({ ok: true }));
  assert.deepEqual(sync.broker.invoke(descriptor, 'component.settings', { action: 'get' }, { surface: 'project' }), { ok: true });
  assert.equal(sync.context().lifecycleLease, sync.lease);
  assert.deepEqual(sync.counts(), { acquired: 1, released: 1 });

  let resolveAsync;
  const asyncCase = await runCase(() => new Promise(resolve => { resolveAsync = resolve; }));
  const pending = asyncCase.broker.invoke(descriptor, 'component.settings', { action: 'get' }, { surface: 'project' });
  assert.deepEqual(asyncCase.counts(), { acquired: 1, released: 0 });
  resolveAsync({ ok: true });
  await pending;
  assert.deepEqual(asyncCase.counts(), { acquired: 1, released: 1 });

  const failure = await runCase(() => { throw new Error('fixture failure'); });
  assert.throws(() => failure.broker.invoke(descriptor, 'component.settings', { action: 'get' }, { surface: 'project' }), /fixture failure/);
  assert.deepEqual(failure.counts(), { acquired: 1, released: 1 });

  console.log('Component capability lifecycle lease tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
