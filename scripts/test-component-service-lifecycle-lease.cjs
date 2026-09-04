const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ComponentServiceManager } = require('../electron/services/component-service-manager.cjs');

class Child extends EventEmitter {
  constructor() {
    super();
    this.pid = 1234;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = { writable: true, write: data => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'request') queueMicrotask(() => this.stdout.write(`${JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { ok: true } })}\n`));
    } };
  }
}

(async () => {
  const descriptor = {
    componentId: 'fixture.component', componentVersion: '1', componentRoot: __dirname,
    service: { protocolVersion: 1, runtime: 'node', entry: __filename, rpcMethods: ['fixture.echo'], capabilities: [], permissions: [] },
  };
  let released = 0; const acquisitions = [];
  const lifecycleCoordinator = { acquireWork: (componentId, operation) => {
    const lease = { componentId, operation, token: Symbol(operation), release: () => { released += 1; } };
    acquisitions.push(lease);
    return lease;
  } };
  let launchSpecification;
  const processSupervisor = { launch: specification => {
    launchSpecification = specification;
    const child = new Child();
    const managed = new EventEmitter();
    Object.assign(managed, { child, released: false, markHealthy: () => undefined, recycle: () => undefined, stop: async () => { managed.released = true; child.emit('exit', 0); } });
    specification.onSpawn(child, managed);
    queueMicrotask(() => child.stdout.write('{"type":"ready","protocolVersion":1}\n'));
    return managed;
  } };
  const manager = new ComponentServiceManager({
    registry: { resolve: componentId => componentId === descriptor.componentId ? descriptor : null },
    processSupervisor, capabilityBroker: { assertCapabilities: () => undefined }, lifecycleCoordinator,
    requestTimeoutMs: 1000,
  });
  assert.deepEqual(await manager.invoke(descriptor.componentId, 'fixture.echo', {}, { surface: 'project' }), { ok: true });
  assert.equal(acquisitions.length, 1, 'outer RPC acquires one lifecycle lease');
  assert.equal(launchSpecification.lifecycleLease, acquisitions[0], 'session launch receives the exact outer RPC lease');
  assert.equal(released, 1);
  await manager.destroy();
  console.log('Component service lifecycle lease tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
