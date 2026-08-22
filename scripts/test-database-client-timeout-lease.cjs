const assert = require('assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const path = require('path');

class MockStream extends EventEmitter {
  setEncoding() {}
}

const stdout = new MockStream();
const stderr = new MockStream();
const stdin = new MockStream();
const child = new EventEmitter();
child.stdout = stdout;
child.stderr = stderr;
child.stdin = stdin;
child.killed = false;
child.exitCode = null;
const lifecycle = [];
stdin.write = (_line, callback) => callback?.();
stdin.end = () => lifecycle.push('stdin-end');
stdin.destroy = () => lifecycle.push('stdin-destroy');
child.kill = signal => {
  lifecycle.push(signal === 'SIGKILL' ? 'force-kill' : 'terminate');
  child.killed = true;
  return true;
};
let spawnedChild = child;

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'child_process') return { spawn: () => spawnedChild };
  return originalLoad.call(this, request, parent, isMain);
};

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

(async () => {
  try {
    const databaseClientPath = path.resolve(__dirname, '..', 'electron', 'repositories', 'database-client.cjs');
    const coordinatorPath = path.resolve(__dirname, '..', 'electron', 'services', 'workspace-sqlite-coordinator.cjs');
    delete require.cache[databaseClientPath];
    const { PythonDatabaseClient } = require(databaseClientPath);
    const { WorkspaceSqliteCoordinator } = require(coordinatorPath);
    const coordinator = new WorkspaceSqliteCoordinator();
    const client = new PythonDatabaseClient({
      coordinator,
      getRunConfig: () => ({ command: 'python', args: [] }),
      getDatabasePath: () => 'C:/workspace.sqlite3',
      writeLog: () => undefined,
      defaultTimeoutMs: 15,
      processStopTimeoutMs: 1000,
      rollbackSettleMs: 10,
    });

    let firstSettled = false;
    const timedOut = client.call('C:/workspace', 'legacy_timeout_write', {}).finally(() => { firstSettled = true; });
    await delay(35);
    assert.equal(firstSettled, false, 'timeout must not reject while the old child is still exiting');
    assert.deepEqual(lifecycle.slice(0, 3), ['stdin-end', 'stdin-destroy', 'terminate']);

    let nextWriterEntered = false;
    const nextWriter = coordinator.run({
      databases: [{ path: 'C:/workspace.sqlite3', mode: 'write' }],
      label: 'next-writer',
    }, () => { nextWriterEntered = true; });
    await delay(15);
    assert.equal(nextWriterEntered, false, 'next writer must remain queued until old child exit and rollback settle');

    child.exitCode = 0;
    child.emit('exit', 0, null);
    await assert.rejects(timedOut, error => error.code === 'DATABASE_TIMEOUT');
    await nextWriter;
    assert.equal(nextWriterEntered, true);
    assert.equal(coordinator.status().activeDatabases, 0);

    const stuckChild = new EventEmitter();
    stuckChild.stdout = new MockStream();
    stuckChild.stderr = new MockStream();
    stuckChild.stdin = new MockStream();
    stuckChild.stdin.write = (_line, callback) => callback?.();
    stuckChild.stdin.end = () => undefined;
    stuckChild.stdin.destroy = () => undefined;
    stuckChild.killed = false;
    stuckChild.exitCode = null;
    stuckChild.kill = () => { stuckChild.killed = true; return true; };
    spawnedChild = stuckChild;
    const quarantinedCoordinator = new WorkspaceSqliteCoordinator();
    const quarantinedClient = new PythonDatabaseClient({
      coordinator: quarantinedCoordinator,
      getRunConfig: () => ({ command: 'python', args: [] }),
      getDatabasePath: () => 'C:/stuck.sqlite3',
      writeLog: () => undefined,
      defaultTimeoutMs: 10,
      processStopTimeoutMs: 30,
      rollbackSettleMs: 0,
    });
    await assert.rejects(
      quarantinedClient.call('C:/workspace', 'legacy_timeout_write', {}),
      error => error.code === 'PROCESS_TERMINATION_FAILED',
    );
    assert.equal(quarantinedClient.status().quarantined, true, 'an unconfirmed process exit quarantines the database client');
    assert.equal(quarantinedCoordinator.status().quarantinedDatabases, 1);
    await assert.rejects(
      quarantinedClient.call('C:/workspace', 'next_write', {}),
      error => error.code === 'DATABASE_QUARANTINED',
    );

    const abortChild = new EventEmitter();
    abortChild.stdout = new MockStream();
    abortChild.stderr = new MockStream();
    abortChild.stdin = new MockStream();
    abortChild.stdin.write = (_line, callback) => callback?.();
    abortChild.stdin.end = () => undefined;
    abortChild.stdin.destroy = () => undefined;
    abortChild.killed = false;
    abortChild.exitCode = null;
    abortChild.kill = () => { abortChild.killed = true; return true; };
    spawnedChild = abortChild;
    const abortCoordinator = new WorkspaceSqliteCoordinator();
    const abortClient = new PythonDatabaseClient({
      coordinator: abortCoordinator,
      getRunConfig: () => ({ command: 'python', args: [] }),
      getDatabasePath: () => 'C:/abort.sqlite3',
      writeLog: () => undefined,
      defaultTimeoutMs: 1000,
      processStopTimeoutMs: 1000,
      rollbackSettleMs: 0,
    });
    const controller = new AbortController();
    let abortSettled = false;
    const aborted = abortClient.call('C:/workspace', 'active_abort_write', {}, 1000, { signal: controller.signal }).finally(() => { abortSettled = true; });
    const abortedRejection = assert.rejects(aborted, error => error.code === 'ABORT_ERR');
    await delay(0);
    controller.abort();
    await delay(15);
    assert.equal(abortSettled, false, 'abort must not reject before the child exit fence');
    abortChild.exitCode = 0;
    abortChild.emit('exit', 0, null);
    await abortedRejection;
    assert.equal(abortCoordinator.status().activeDatabases, 0);
    console.log('database client timeout lease tests passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch(error => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
