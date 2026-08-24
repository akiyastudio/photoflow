const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { ComponentServiceManager, cloneRequestPayload, publicContext, serviceEnvironment } = require('../electron/services/component-service-manager.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-service-'));
const serviceEntry = path.join(sandbox, 'service.cjs');
const uiEntry = path.join(sandbox, 'ui', 'index.html');
fs.mkdirSync(path.dirname(uiEntry), { recursive: true });
fs.writeFileSync(serviceEntry, '// launched in a supervised process, never imported by Electron main\n');
fs.writeFileSync(uiEntry, '<!doctype html>');

const baseManifest = {
  apiVersion: 1, id: 'sample-component', version: '1.0.0',
  componentHost: {
    contractVersion: 1,
    compatibility: { minHostApiVersion: 1, maxHostApiVersion: 1 },
    contributions: [
      { type: 'workspace.toolbarAction', id: 'open', label: 'Sample', pageId: 'main' },
      { type: 'component.fullPage', id: 'main', title: 'Sample', entry: 'ui/index.html' },
    ],
    service: {
      protocolVersion: 1, runtime: 'node', entrypoints: { default: 'service.cjs' },
      rpcMethods: ['sample.echo.v1', 'sample.crash.v1', 'team.project.get.v1', 'component.settings.get.v1', 'component.advanced.preflight.v1'], capabilities: ['project.media.list.v1'],
    },
  },
};

const descriptor = parseComponentHostManifest(baseManifest, sandbox);
assert.equal(descriptor.service.entry, serviceEntry);
assert.deepEqual(descriptor.service.rpcMethods, ['sample.echo.v1', 'sample.crash.v1', 'team.project.get.v1', 'component.settings.get.v1', 'component.advanced.preflight.v1']);
assert.throws(() => parseComponentHostManifest({ ...baseManifest, componentHost: { ...baseManifest.componentHost, service: { ...baseManifest.componentHost.service, rpcMethods: ['unversioned'] } } }, sandbox), /versioned allowlist/);
assert.throws(() => parseComponentHostManifest({ ...baseManifest, componentHost: { ...baseManifest.componentHost, service: { ...baseManifest.componentHost.service, capabilities: ['ipc.any.v1'] } } }, sandbox), /unknown host capability/);
assert.throws(() => parseComponentHostManifest({ ...baseManifest, componentHost: { ...baseManifest.componentHost, service: { ...baseManifest.componentHost.service, entrypoints: { default: '../escape.cjs' } } } }, sandbox), /escapes component root/);
assert.throws(() => parseComponentHostManifest({ ...baseManifest, componentHost: { ...baseManifest.componentHost, service: { ...baseManifest.componentHost.service, lifecycleActions: { install: { entry: '../escape.ps1', sha256: '0'.repeat(64) } } } } }, sandbox), /lifecycle action escapes component root/);
assert.throws(() => parseComponentHostManifest({ ...baseManifest, componentHost: { ...baseManifest.componentHost, service: { ...baseManifest.componentHost.service, lifecycleActions: { install: { entry: 'action.ps1', sha256: 'renderer-value' } } } } }, sandbox), /SHA-256/);

const broker = new ComponentCapabilityBroker();
broker.register('project.media.list.v1', (payload, context) => ({ cursor: payload.cursor, workspace: context.workspacePath }));
assert.equal(broker.assertCapabilities(descriptor), true);
assert.throws(() => broker.assertCapabilities({ componentId: 'broken', service: { capabilities: ['project.media.access.v1'] } }), /declares unavailable host capabilities.*project\.media\.access\.v1/, 'allowlisting a capability without a broker implementation must fail registration consistency checks');
const boundContext = { componentId: 'sample-component', componentVersion: '1.0.0', workspacePath: 'C:/private/workspace', projectId: 'p1', projectName: 'One', projectStatus: 'active' };
assert.deepEqual(publicContext(boundContext), { componentId: 'sample-component', componentVersion: '1.0.0', projectId: 'p1', projectName: 'One', projectStatus: 'active' });
assert.throws(() => broker.invoke(descriptor, 'dialogs.open.v1', {}, boundContext), /not granted/);
assert.throws(() => cloneRequestPayload({ value: 'x'.repeat(2 * 1024 * 1024) }), /too large/);
assert.deepEqual(serviceEnvironment({ SystemRoot: 'C:/Windows', SECRET_TOKEN: 'must-not-leak' }), { SystemRoot: 'C:/Windows' });

class FakeChild extends EventEmitter {
  constructor(onInput) {
    super();
    this.pid = 42;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = { writable: true, write: data => onInput(JSON.parse(String(data).trim()), this) };
  }
}

const launched = [];
let serviceRequestCount = 0;
const fakeSupervisor = {
  launch(spec) {
    const requestFrames = new Map();
    const child = new FakeChild((frame, target) => {
      if (frame.type === 'request') {
        serviceRequestCount += 1;
        if (frame.method === 'sample.crash.v1') { process.nextTick(() => target.emit('exit', 9, null)); return true; }
        requestFrames.set(frame.id, frame);
        target.stdout.write(`${JSON.stringify({ type: 'capability', id: `cap-${frame.id}`, parentId: frame.id, method: 'project.media.list.v1', payload: { cursor: 'next' } })}\n`);
      } else if (frame.type === 'capability-response') {
        const requestId = String(frame.id).replace(/^cap-/, '');
        const requestFrame = requestFrames.get(requestId);
        requestFrames.delete(requestId);
        target.stdout.write(`${JSON.stringify({ type: 'response', id: requestFrame.id, ok: true, result: { capability: frame.result, context: requestFrame.context } })}\n`);
      }
      return true;
    });
    const managed = {
      child, released: false, healthy: false,
      markHealthy() { this.healthy = true; return true; },
      on() { return this; },
      recycle(reason) { this.recycleReason = reason; },
      async stop() { this.released = true; child.killed = true; child.emit('exit', 0, null); },
    };
    launched.push({ spec, managed });
    spec.onSpawn(child, managed);
    process.nextTick(() => child.stdout.write(`${JSON.stringify({ type: 'ready', protocolVersion: 1 })}\n`));
    return managed;
  },
};

let activeDescriptor = descriptor;
const registry = { resolve: id => id === activeDescriptor.componentId ? activeDescriptor : null };
const manager = new ComponentServiceManager({ registry, processSupervisor: fakeSupervisor, capabilityBroker: broker, executablePath: 'electron.exe' });
const keepAlive = setInterval(() => undefined, 1000);

(async () => {
  const result = await manager.invoke('sample-component', 'sample.echo.v1', { value: 1 }, boundContext);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].spec.command, 'electron.exe');
  assert.equal(launched[0].spec.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(launched[0].spec.options.env.SECRET_TOKEN, undefined, 'the component service process must not inherit arbitrary host secrets');
  assert.equal(result.capability.workspace, boundContext.workspacePath, 'the host retains the private workspace path while serving an authorized capability');
  assert.equal(result.context.workspacePath, undefined, 'raw workspace paths are never sent to the component service');
  assert.equal(result.context.projectId, 'p1');

  const beforeCoalesced = serviceRequestCount;
  const snapshots = await Promise.all(Array.from({ length: 3 }, () => manager.invoke('sample-component', 'team.project.get.v1', {}, boundContext)));
  assert.equal(serviceRequestCount - beforeCoalesced, 1, 'concurrent project snapshots for one private workspace context must share one service request');
  assert.equal(snapshots.length, 3);
  const beforeIndependentReads = serviceRequestCount;
  await Promise.all([
    manager.invoke('sample-component', 'component.settings.get.v1', {}, boundContext),
    manager.invoke('sample-component', 'component.advanced.preflight.v1', {}, boundContext),
  ]);
  assert.equal(serviceRequestCount - beforeIndependentReads, 2, 'different startup reads remain concurrent without waiting on each other');

  const launchCountBeforeUpgrade = launched.length;
  activeDescriptor = parseComponentHostManifest({ ...baseManifest, version: '2.0.0' }, sandbox);
  const upgradedContext = { ...boundContext, componentVersion: '2.0.0' };
  const upgraded = await Promise.all([
    manager.invoke('sample-component', 'sample.echo.v1', { caller: 'one' }, upgradedContext),
    manager.invoke('sample-component', 'sample.echo.v1', { caller: 'two' }, upgradedContext),
  ]);
  assert.equal(launched.length - launchCountBeforeUpgrade, 1, 'concurrent requests during a component version change must start exactly one replacement service');
  assert(launched[launchCountBeforeUpgrade - 1].managed.released, 'the previous component service is stopped before the replacement becomes active');
  assert(upgraded.every(item => item.context.componentVersion === '2.0.0'));

  const pending = manager.invoke('sample-component', 'sample.crash.v1', {}, boundContext);
  await assert.rejects(pending, /exited before completing sample-component\.sample\.crash\.v1/);
  await manager.destroy();
  for (const test of ['test-component-storage-adoption.cjs', 'test-component-storage-quiesce.cjs']) {
    const child = spawnSync(process.execPath, [path.join(__dirname, test)], { stdio: 'inherit' });
    assert.equal(child.status, 0, `${test} must pass under the component-service CI target`);
  }
  console.log('Component service protocol and capability boundary tests passed');
})().finally(() => { clearInterval(keepAlive); fs.rmSync(sandbox, { recursive: true, force: true }); }).catch(error => { console.error(error); process.exitCode = 1; });
