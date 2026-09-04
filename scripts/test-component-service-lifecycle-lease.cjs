const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ComponentServiceManager } = require('../electron/services/component-service-manager.cjs');

class Child extends EventEmitter {
  constructor(requestContexts) {
    super();
    this.pid = 1234;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = { writable: true, write: data => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'request') { requestContexts.push(frame.context); queueMicrotask(() => this.stdout.write(`${JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { ok: true } })}\n`)); }
    } };
  }
}

(async () => {
  const descriptor = {
    componentId: 'fixture.component', componentVersion: '1', componentRoot: __dirname,
    service: { protocolVersion: 1, runtime: 'node', entry: __filename, rpcMethods: ['fixture.echo', 'fixture.restore.project'], capabilities: [], permissions: [], backupRestore: { project: { method: 'fixture.restore.project' } } },
  };
  let released = 0; const acquisitions = []; let activeLease = null;
  const lifecycleCoordinator = { acquireWork: (componentId, operation) => {
    const lease = { componentId, operation, token: Symbol(operation), release: () => { released += 1; if (activeLease === lease) activeLease = null; } };
    activeLease = lease;
    acquisitions.push(lease);
    return lease;
  }, currentLease: () => activeLease, isActiveWorkLease: (componentId, lease) => lease === activeLease && lease?.componentId === componentId };
  let launchSpecification; let observedLaunchLease; const requestContexts = [];
  const processSupervisor = { launch: specification => {
    launchSpecification = specification;
    observedLaunchLease = specification.getLifecycleLease?.();
    const child = new Child(requestContexts);
    const managed = new EventEmitter();
    Object.assign(managed, { child, released: false, markHealthy: () => undefined, recycle: () => undefined, stop: async () => { managed.released = true; child.emit('exit', 0); } });
    specification.onSpawn(child, managed);
    queueMicrotask(() => child.stdout.write('{"type":"ready","protocolVersion":1}\n'));
    return managed;
  } };
  const manager = new ComponentServiceManager({
    registry: { resolve: componentId => componentId === descriptor.componentId ? descriptor : null, list: () => [descriptor] },
    processSupervisor, capabilityBroker: { assertCapabilities: () => undefined }, lifecycleCoordinator,
    requestTimeoutMs: 1000,
  });
  assert.deepEqual(await manager.invoke(descriptor.componentId, 'fixture.echo', {}, { surface: 'project' }), { ok: true });
  assert.equal(acquisitions.length, 1, 'outer RPC acquires one lifecycle lease');
  assert.equal(typeof launchSpecification.getLifecycleLease, 'function');
  assert.equal(observedLaunchLease, acquisitions[0], 'session launch resolves the exact active outer RPC lease');
  assert.equal(Object.hasOwn(requestContexts[0], 'lifecycleLease'), false, 'lease is not serialized to the component service');
  assert.equal(released, 1);
  await manager.prepareBackupRestore([descriptor.componentId]);
  assert.equal(released, 2, 'backup preparation holds and releases a work lease');
  await manager.invokeBackupRestore(descriptor.componentId, 'project', { operationId: 'restore' }, { surface: 'project' });
  assert.equal(released, 3, 'backup restore invocation holds one lease through its response');
  await manager.destroy();
  console.log('Component service lifecycle lease tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
