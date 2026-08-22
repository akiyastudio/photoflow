const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const path = require('path');

class MockStream extends EventEmitter {
  setEncoding() {}
}

let writes = 0;
const stdout = new MockStream();
const stderr = new MockStream();
const stdin = new MockStream();
const child = new EventEmitter();
child.stdout = stdout;
child.stderr = stderr;
child.stdin = stdin;
child.killed = false;
child.kill = () => {
  child.killed = true;
  queueMicrotask(() => child.emit('exit', 0));
};
stdin.write = (line, callback) => {
  writes += 1;
  const request = JSON.parse(line);
  queueMicrotask(() => stdout.emit('data', `${JSON.stringify(writes < 3
    ? { id: request.id, success: false, code: 'SQLITE_BUSY', error: 'localized sqlite busy message' }
    : { id: request.id, success: true, result: { success: true, attempts: writes } })}\n`));
  callback?.();
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'child_process') return { spawn: () => child };
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const modulePath = path.resolve(__dirname, '..', 'electron', 'repositories', 'database-client.cjs');
    delete require.cache[modulePath];
    const { PythonDatabaseClient } = require(modulePath);
    const { WorkspaceSqliteCoordinator } = require('../electron/services/workspace-sqlite-coordinator.cjs');
    const client = new PythonDatabaseClient({
      coordinator: new WorkspaceSqliteCoordinator(),
      getRunConfig: () => ({ command: 'python', args: [] }),
      getDatabasePath: () => 'workspace.sqlite3',
      writeLog: () => undefined,
      defaultTimeoutMs: 5000,
    });
    const result = await client.call('workspace', 'version_tree_layout_get', {});
    assert.deepStrictEqual(result, { success: true, attempts: 3 });
    assert.strictEqual(writes, 3, 'database lock responses must be retried transparently');
    client.stop();
    console.log('database client lock retry tests passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch(error => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
