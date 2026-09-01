const assert = require('assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const path = require('path');

class MockStream extends EventEmitter { setEncoding() {} }

const makeChild = responseBytes => {
  const stdout = new MockStream();
  const child = new EventEmitter();
  child.stdout = stdout; child.stderr = new MockStream(); child.stdin = new MockStream();
  child.killed = false; child.exitCode = null;
  child.stdin.end = () => undefined; child.stdin.destroy = () => undefined;
  child.kill = () => {
    child.killed = true; child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  child.stdin.write = (line, callback) => {
    const id = JSON.parse(line).id;
    const response = Buffer.from(JSON.stringify({ id, success: true, result: { blob: 'x'.repeat(responseBytes) } }));
    const chunkSize = 128 * 1024;
    const total = Math.ceil(response.length / chunkSize);
    const frames = [];
    for (let index = 0; index < total; index += 1) {
      frames.push(JSON.stringify({
        id, protocol: 'json-chunk-v1', index, total,
        data: response.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64'),
      }));
    }
    // Deliver all newline-delimited frames in one event. The line bound must
    // apply per frame, not reject a valid multi-frame response as one buffer.
    setImmediate(() => stdout.emit('data', `${frames.join('\n')}\n`));
    callback?.();
  };
  return child;
};

let spawnedChild;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'child_process') return { spawn: () => spawnedChild };
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const clientPath = path.resolve(__dirname, '..', 'electron', 'repositories', 'database-client.cjs');
    delete require.cache[clientPath];
    const { PythonDatabaseClient } = require(clientPath);
    const { WorkspaceSqliteCoordinator } = require('../electron/services/workspace-sqlite-coordinator.cjs');
    const createClient = maximumProtocolResponse => new PythonDatabaseClient({
      coordinator: new WorkspaceSqliteCoordinator(),
      getRunConfig: () => ({ command: 'python', args: [] }),
      getDatabasePath: () => 'C:/chunked.sqlite3', writeLog: () => undefined,
      maximumProtocolResponse, rollbackSettleMs: 0,
    });

    spawnedChild = makeChild(2 * 1024 * 1024);
    const large = await createClient(3 * 1024 * 1024).call('root', 'legacy_action', {}, 10000);
    assert.equal(large.blob.length, 2 * 1024 * 1024, 'valid responses larger than 1 MiB are reassembled compatibly');

    spawnedChild = makeChild(2 * 1024 * 1024);
    await assert.rejects(
      createClient(1024 * 1024).call('root', 'legacy_action', {}, 10000),
      error => error.code === 'DATABASE_PROTOCOL_ERROR',
    );
    assert.equal(spawnedChild.killed, true, 'the complete response remains bounded');
    console.log('database client chunked response tests passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch(error => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
