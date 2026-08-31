const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createProcessSupervisor } = require('../electron/services/process-supervisor.cjs');
const { createJsonCommandRunner } = require('../electron/services/json-command-runner.cjs');
const { createDevelopmentPythonResolver, developmentPythonPath } = require('../electron/services/python-environment-service.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

  await worker.stop('test-complete', { rollbackSettleMs: 0 });
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

  const jsonChild = new EventEmitter();
  jsonChild.stdin = new PassThrough();
  jsonChild.stdout = new PassThrough();
  jsonChild.stderr = new PassThrough();
  jsonChild.exitCode = null;
  jsonChild.signalCode = null;
  jsonChild.killed = false;
  jsonChild.kill = () => { jsonChild.killed = true; return true; };
  const runJsonCommand = createJsonCommandRunner({ spawnJob: () => jsonChild, terminationTimeoutMs: 200 });
  let jsonSettled = false;
  const timedJson = runJsonCommand({ command: 'python', args: [] }, 'json-test', 10).finally(() => { jsonSettled = true; });
  const timedJsonRejection = assert.rejects(timedJson, error => error.code === 'PROCESS_TIMEOUT');
  await delay(30);
  assert.equal(jsonSettled, false, 'runJsonCommand timeout must wait for the child exit fence');
  jsonChild.exitCode = 0;
  jsonChild.emit('exit', 0, null);
  await timedJsonRejection;

  const largeJsonChild = new EventEmitter();
  largeJsonChild.stdout = new PassThrough();
  largeJsonChild.stderr = new PassThrough();
  largeJsonChild.kill = () => true;
  const largeRunner = createJsonCommandRunner({ spawnJob: () => largeJsonChild });
  const unicodePaths = Array.from({ length: 2000 }, (_, index) => `C:/项目/${'很长的中文目录/'.repeat(80)}图片-${index}.jpg`);
  const largeResultPromise = largeRunner({ command: 'python', args: [] }, 'large-json');
  const encodedLargeResult = JSON.stringify({ success: true, files: unicodePaths });
  assert.ok(Buffer.byteLength(encodedLargeResult, 'utf8') > 2 * 1024 * 1024, 'fixture must cover the former 2 MiB tail window');
  for (let offset = 0; offset < encodedLargeResult.length; offset += 8191) largeJsonChild.stdout.write(encodedLargeResult.slice(offset, offset + 8191));
  largeJsonChild.stdout.write('\n');
  largeJsonChild.emit('close', 0, null);
  const largeResult = await largeResultPromise;
  assert.equal(largeResult.files.length, 2000);
  assert.equal(largeResult.files[1999], unicodePaths[1999], 'large Unicode JSON messages must remain complete');

  const rejectingJsonChild = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); });
      return true;
    };
    return child;
  };
  const assertOversizedProtocolRejected = async (writePayload, label) => {
    const child = rejectingJsonChild();
    const runner = createJsonCommandRunner({ spawnJob: () => child, terminationTimeoutMs: 200 });
    const pending = runner({ command: 'python', args: [] }, label);
    writePayload(child.stdout);
    await assert.rejects(pending, error => error.code === 'PROCESS_PROTOCOL_MESSAGE_TOO_LARGE');
    assert.equal(child.killed, true, `${label} must terminate the oversized producer`);
  };
  await assertOversizedProtocolRejected(stdout => stdout.write(`${'x'.repeat(34_603_034)}\n`), 'oversized-complete-line');
  await assertOversizedProtocolRejected(stdout => {
    stdout.write('x'.repeat(20 * 1024 * 1024));
    stdout.write('x'.repeat(13 * 1024 * 1024));
    stdout.write('x');
  }, 'oversized-cross-chunk-without-newline');

  const historyChild = new EventEmitter();
  historyChild.stdout = new PassThrough();
  historyChild.stderr = new PassThrough();
  historyChild.kill = () => true;
  let historyMessageCount = 0;
  const historyRunner = createJsonCommandRunner({ spawnJob: () => historyChild });
  const historyPromise = historyRunner({ command: 'python', args: [] }, 'bounded-history', 1000, () => { historyMessageCount += 1; });
  historyChild.stdout.write(`${JSON.stringify({ type: 'error', message: 'evicted-old-error' })}\n`);
  for (let index = 0; index < 256; index += 1) historyChild.stdout.write(`${JSON.stringify({ type: 'progress', index })}\n`);
  historyChild.stdout.write(`${JSON.stringify({ success: true, marker: 'latest-result' })}\n`);
  historyChild.emit('close', 0, null);
  await assert.rejects(historyPromise, /evicted-old-error/);
  assert.equal(historyMessageCount, 258, 'all parsed messages must still reach the progress callback');

  const protocolCase = async (lines, onMessage) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true; };
    const pending = createJsonCommandRunner({ spawnJob: () => child, terminationTimeoutMs: 200 })({}, 'terminal-state', 1000, onMessage);
    child.stdout.write(lines); child.emit('close', 0, null); return pending;
  };
  await assert.rejects(protocolCase(`${JSON.stringify({ type: 'error', message: '' })}\n`), /返回错误/);
  await assert.rejects(protocolCase(`${JSON.stringify({ type: 'progress', progress: 100 })}\n`), /未返回有效结果/);
  let tailDelivered = false;
  const tailResult = await protocolCase(JSON.stringify({ success: true, tail: true }), () => { tailDelivered = true; });
  assert.equal(tailResult.tail, true); assert.equal(tailDelivered, true, 'the unterminated tail must use the same callback path');
  const lastSuccess = await protocolCase(`${JSON.stringify({ success: true, sequence: 1 })}\n${JSON.stringify({ success: true, sequence: 2 })}\n`);
  assert.equal(lastSuccess.sequence, 2, 'multiple successful terminal messages must preserve the legacy last-result behavior');
  await assert.rejects(protocolCase(`${JSON.stringify({ type: 'progress' })}\n`, () => { throw new Error('callback crash'); }), error => error.code === 'PROCESS_MESSAGE_CALLBACK_FAILED');

  let expiredSpawned = false;
  const expiredRunner = createJsonCommandRunner({ spawnJob: () => { expiredSpawned = true; return jsonChild; } });
  await assert.rejects(expiredRunner({ command: 'python', args: [] }, 'expired-json', 1000, undefined, undefined, Date.now() - 1), error => error.code === 'PROCESS_TIMEOUT');
  assert.equal(expiredSpawned, false, 'expired JSON commands must not spawn a child');

  let playbackCleanup = 0;
  supervisor.launch({ id: 'playback:owned', kind: 'media-playback-backend', protocol: 'media-playback-backend-v1', owner: { componentId: 'fixture-player', playbackSessionId: 'session-owned' }, command: 'player.exe', onExitCleanup: () => { playbackCleanup += 1; } });
  assert.equal(supervisor.list().find(item => item.id === 'playback:owned').owner.componentId, 'fixture-player');
  assert.equal(await supervisor.stopWhere(status => status.owner?.componentId === 'fixture-player', 'component-uninstall'), 1);
  await delay(5); assert.equal(playbackCleanup, 1, 'owner-scoped stop must run playback cleanup exactly once');

  await supervisor.stopAll();
  assert.deepStrictEqual(supervisor.list(), []);
  const pythonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-python-resolver-'));
  try {
    const pythonPath = developmentPythonPath(pythonRoot);
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
    fs.mkdirSync(path.join(pythonRoot, '.venv', process.platform === 'win32' ? 'Lib' : 'lib'), { recursive: true });
    fs.mkdirSync(path.join(pythonRoot, 'scripts'));
    fs.writeFileSync(pythonPath, 'python');
    fs.writeFileSync(path.join(pythonRoot, '.venv', 'pyvenv.cfg'), 'home=test');
    fs.writeFileSync(path.join(pythonRoot, 'scripts', 'verify-python-environment.py'), 'pass');
    let validationSpawns = 0;
    let capturedEnvironment = null;
    const resolver = createDevelopmentPythonResolver({ projectRoot: pythonRoot, spawnSyncImpl: (_command, _args, options) => {
      validationSpawns += 1; capturedEnvironment = options.env;
      return { status: 0, stdout: '', stderr: '' };
    } });
    assert.equal(resolver(), pythonPath); assert.equal(resolver(), pythonPath);
    assert.equal(validationSpawns, 1, 'unchanged cheap sentinels must share one validation and never rescan the venv tree');
    assert.equal(capturedEnvironment.PYTHONPATH, undefined); assert.equal(capturedEnvironment.PYTHONHOME, undefined);

    let failedValidationCalls = 0;
    const failingResolver = createDevelopmentPythonResolver({ projectRoot: pythonRoot, spawnSyncImpl: () => {
      failedValidationCalls += 1;
      const deadline = Date.now() + 25;
      while (Date.now() < deadline) { /* simulate a delayed quick verifier */ }
      return { status: 1, stdout: '', stderr: 'delayed verification failure' };
    } });
    const validationStartedAt = Date.now();
    assert.throws(() => failingResolver(), /delayed verification failure/, 'the first task must not receive a Python path before quick validation succeeds');
    assert(Date.now() - validationStartedAt >= 20, 'the synchronous resolver must wait for delayed first-call validation');
    assert.equal(failedValidationCalls, 1);

    fs.writeFileSync(path.join(pythonRoot, '.venv', 'pyvenv.cfg'), 'home=changed');
    assert.equal(resolver(), pythonPath);
    assert.equal(validationSpawns, 2, 'a sentinel change must synchronously revalidate exactly once');
    for (let index = 0; index < 1000; index += 1) assert.equal(resolver(), pythonPath);
    assert.equal(validationSpawns, 2, 'stable consecutive calls must remain an O(fixed sentinel stat) fast path');
  } finally { fs.rmSync(pythonRoot, { recursive: true, force: true }); }
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.match(mainSource, /processId:\s*'python:workspace-catalog'/);
  assert.match(mainSource, /processId:\s*'python:media-interaction'/);
  assert.match(mainSource, /processSupervisor\.stopAll\(\)/);
  for (const relative of [
    'electron/services/recycle-bin-service.cjs',
    'electron/services/file-clipboard-service.cjs',
    'electron/services/file-publication-service.cjs',
    'electron/services/video-playback-process-service.cjs',
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
