const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createProcessSupervisor } = require('../electron/services/process-supervisor.cjs');
const fs = require('fs');
const path = require('path');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const main = async () => {
  const children = [];
  const logs = [];
  const supervisor = createProcessSupervisor({
    spawnImpl: () => {
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    writeLog: (level, message, details) => logs.push({ level, message, details }),
  });

  const spawned = [];
  const worker = supervisor.launch({
    id: 'python:test-worker',
    kind: 'python-worker',
    command: 'python',
    args: ['worker.py'],
    options: { stdio: ['pipe', 'pipe', 'pipe'] },
    restart: { enabled: true, maxRestarts: 2, windowMs: 60000, backoffMs: [0] },
    onSpawn: child => spawned.push(child.pid),
  });
  assert.strictEqual(worker.status().state, 'running');
  assert.strictEqual(worker.markHealthy({ protocol: 'test' }), true);
  assert.strictEqual(worker.status().state, 'healthy');

  children[0].emit('exit', 1, null);
  await delay(10);
  assert.strictEqual(children.length, 2, 'unexpected exits must be restarted');
  assert.deepStrictEqual(spawned, [1000, 1001]);
  assert.strictEqual(worker.status().generation, 2);
  assert.ok(logs.some(entry => entry.message === 'Managed process restart scheduled'));

  worker.stop('test-complete');
  await delay(0);
  assert.strictEqual(supervisor.status('python:test-worker'), null, 'stopped processes must be released');
  const countAfterStop = children.length;
  await delay(10);
  assert.strictEqual(children.length, countAfterStop, 'intentional stops must not restart');

  const exhausted = supervisor.launch({
    id: 'component:test',
    kind: 'optional-component',
    command: 'component.exe',
    restart: { enabled: true, maxRestarts: 1, windowMs: 60000, backoffMs: [0] },
  });
  exhausted.child.emit('exit', 9, null);
  await delay(10);
  exhausted.child.emit('exit', 9, null);
  await delay(10);
  assert.strictEqual(exhausted.status().state, 'failed');
  assert.ok(logs.some(entry => entry.message === 'Managed process restart limit reached'));

  const oneShot = supervisor.launch({
    id: 'csharp:test-job', kind: 'csharp-helper', command: 'helper.exe', ephemeral: true,
  });
  oneShot.child.emit('exit', 0, null);
  assert.strictEqual(supervisor.status('csharp:test-job'), null, 'completed one-shot helpers must not remain registered');

  supervisor.stopAll();
  assert.deepStrictEqual(supervisor.list(), []);
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.match(mainSource, /processId:\s*'python:workspace-catalog'/);
  assert.match(mainSource, /processId:\s*'python:media-interaction'/);
  assert.match(mainSource, /processSupervisor\.stopAll\(\)/);
  for (const relative of [
    'electron/services/recycle-bin-service.cjs',
    'electron/services/file-clipboard-service.cjs',
    'electron/services/advanced-video-service.cjs',
    'electron/services/image-thumbnail-runtime.cjs',
    'electron/modules/broll-import.cjs',
  ]) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), /processSupervisor/, `${relative} must use process supervision`);
  }
  console.log('Process supervisor tests passed.');
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
