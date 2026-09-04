const assert = require('node:assert/strict');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { ComponentLifecycleCoordinator } = require('../electron/services/component-lifecycle-coordinator.cjs');
const { getComponentLifecycleLease, withComponentLifecycleLease } = require('../electron/services/component-lifecycle-context.cjs');

const descriptor = {
  componentId: 'fixture.component',
  service: { capabilities: ['component.settings'], permissions: ['component.settings'] },
};

const runCase = async handler => {
  let acquired = 0; let released = 0; let observedContext;
  const lease = { componentId: descriptor.componentId, token: Symbol('lease'), release: () => { released += 1; } };
  const broker = new ComponentCapabilityBroker({ lifecycleCoordinator: {
    isActiveWorkLease: (componentId, candidate) => componentId === descriptor.componentId && candidate === lease,
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
  assert.equal(getComponentLifecycleLease(sync.context()), sync.lease);
  assert.equal(Object.keys(sync.context()).includes('lifecycleLease'), false);
  assert.equal(JSON.stringify(sync.context()).includes('lifecycleLease'), false);
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

  let nestedAcquired = 0; let nestedReleased = 0; let activeLease = null;
  const nestedBroker = new ComponentCapabilityBroker({ lifecycleCoordinator: {
    acquireWork: componentId => {
      nestedAcquired += 1;
      activeLease = { componentId, token: Symbol(componentId), release: () => { nestedReleased += 1; activeLease = null; } };
      return activeLease;
    },
    isActiveWorkLease: (componentId, lease) => lease === activeLease && lease?.componentId === componentId,
  } });
  nestedBroker.register('component.settings', (payload, context) => payload.action === 'outer'
    ? nestedBroker.invoke(descriptor, 'component.settings', { action: 'inner' }, context)
    : { ok: true });
  assert.deepEqual(nestedBroker.invoke(descriptor, 'component.settings', { action: 'outer' }, { surface: 'project' }), { ok: true });
  assert.equal(nestedAcquired, 1, 'nested capability reuses its parent lease');
  assert.equal(nestedReleased, 1, 'only the parent owner releases the reused lease');

  const retainedCoordinator = new ComponentLifecycleCoordinator();
  const parentLease = retainedCoordinator.acquireWork(descriptor.componentId, 'parent-rpc');
  let finishNested;
  const retainedBroker = new ComponentCapabilityBroker({ lifecycleCoordinator: retainedCoordinator });
  retainedBroker.register('component.settings', () => new Promise(resolve => { finishNested = resolve; }));
  const nestedPromise = retainedBroker.invoke(descriptor, 'component.settings', { action: 'get' }, withComponentLifecycleLease({ surface: 'project' }, parentLease));
  parentLease.release();
  assert.equal(retainedCoordinator.hasWork(descriptor.componentId), true, 'nested capability retains the parent lease after parent timeout/exit');
  const transition = retainedCoordinator.acquire(descriptor.componentId, 'uninstall', { stopOnly: true });
  assert.doesNotThrow(() => retainedCoordinator.assertLaunchAllowed(descriptor.componentId, getComponentLifecycleLease(withComponentLifecycleLease({}, parentLease))));
  transition.requestStop();
  assert.throws(() => retainedCoordinator.assertLaunchAllowed(descriptor.componentId, parentLease), error => error.code === 'COMPONENT_QUIESCING');
  finishNested({ ok: true });
  await nestedPromise;
  assert.equal(retainedCoordinator.hasWork(descriptor.componentId), false, 'last nested owner releases the retained lease');
  transition.release();

  console.log('Component capability lifecycle lease tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
