const assert = require('assert');
const { ComponentServiceManager } = require('../electron/services/component-service-manager.cjs');

(async () => {
  const descriptor = { componentId: 'sample-component', componentVersion: '1', hostApiVersion: 7, service: { rpcMethods: ['sample.write.v1'], capabilities: [], permissions: [], protocolVersion: 1, runtime: 'node', entry: __filename } };
  let stopped = 0;
  let writtenFrame;
  const managed = {
    released: false,
    child: { stdin: { writable: true, write: line => { writtenFrame = JSON.parse(line); } } },
    stop: async () => { stopped += 1; managed.released = true; },
  };
  const manager = new ComponentServiceManager({
    registry: { resolve: () => descriptor },
    capabilityBroker: { assertCapabilities: () => true },
    processSupervisor: { launch: () => ({ released: false, on: () => undefined, stop: async () => undefined }) },
  });
  const session = { descriptor, version: '1', pending: new Map(), ready: Promise.resolve(), managed };
  manager.sessions.set(descriptor.componentId, session);
  const request = manager.invoke(descriptor.componentId, 'sample.write.v1', { value: 1 }, { componentId: descriptor.componentId, componentVersion: '1', projectId: 'p', projectName: 'P', projectStatus: 'active' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(manager.quiesceForStorageSnapshot({ timeoutMs: 10 }), error => error.code === 'COMPONENT_BUSY');
  assert.equal(stopped, 0, 'busy component process must never be stopped for backup');
  assert.equal(session.pending.size, 1, 'busy request must remain pending after backup deferral');
  await manager.handleFrame(session, { type: 'response', id: writtenFrame.id, ok: true, result: { success: true } }, managed);
  assert.deepStrictEqual(await request, { success: true }, 'the long request must complete normally');
  const resume = await manager.quiesceForStorageSnapshot({ timeoutMs: 100 });
  assert.equal(stopped, 1, 'idle component may be stopped at the snapshot boundary');
  await resume();
  assert.equal(manager.storageSnapshotBarrier, null);

  const failureManager = new ComponentServiceManager({ registry: { resolve: () => descriptor }, capabilityBroker: {}, processSupervisor: {} });
  const descriptors = ['one', 'two'].map(componentId => ({ ...descriptor, componentId }));
  for (const item of descriptors) failureManager.sessions.set(item.componentId, { descriptor: item });
  const restored = new Set();
  failureManager.stop = async componentId => { if (componentId === 'two') throw new Error('simulated partial stop failure'); failureManager.sessions.delete(componentId); return true; };
  failureManager.ensureSession = async item => { restored.add(item.componentId); return {}; };
  await assert.rejects(failureManager.quiesceForStorageSnapshot(), AggregateError);
  assert.deepStrictEqual([...restored].sort(), ['one', 'two'], 'all previously active descriptors must be restored after partial stop failure');
  assert.equal(failureManager.storageSnapshotBarrier, null, 'partial stop failure must release the barrier');

  const resumeFailureManager = new ComponentServiceManager({ registry: { resolve: () => descriptor }, capabilityBroker: {}, processSupervisor: {} });
  resumeFailureManager.sessions.set('one', { descriptor: descriptors[0] });
  resumeFailureManager.stop = async componentId => { resumeFailureManager.sessions.delete(componentId); return true; };
  resumeFailureManager.ensureSession = async () => { throw new Error('simulated resume failure'); };
  const failingResume = await resumeFailureManager.quiesceForStorageSnapshot();
  await assert.rejects(failingResume(), AggregateError);
  assert.equal(resumeFailureManager.storageSnapshotBarrier, null, 'resume failure must release the barrier');
  console.log('Component storage quiesce busy/resume tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
