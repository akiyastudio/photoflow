const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHostSimulator } = require('./host-simulator.cjs');
const { ensureSchema } = require('../service.cjs');

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-project-parallel-'));
  const dataPath = path.join(sandbox, 'storage'); const databasePath = path.join(dataPath, 'storage.sqlite3');
  fs.mkdirSync(dataPath, { recursive: true });
  ensureSchema(databasePath).close();
  let arrivals = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const simulator = projectId => {
    let firstStorage = true;
    return createHostSimulator({
      service: path.join(__dirname, '..', 'service.cjs'),
      context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId, projectName: projectId, projectStatus: 'active' },
      capabilities: { 'component.storage': async () => {
        if (firstStorage) {
          firstStorage = false; arrivals += 1;
          if (arrivals === 2) release();
          await gate;
        }
        return { dataPath, databasePath, projectId, ownership: 'component-private' };
      } },
    });
  };
  const left = simulator('parallel-left'); const right = simulator('parallel-right');
  try {
    const completed = await Promise.race([
      Promise.all([
        left.request('team.identity.save.v1', { name: 'Left', assignments: [], expectedRevision: '0' }),
        right.request('team.identity.save.v1', { name: 'Right', assignments: [], expectedRevision: '0' }),
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('different-project mutations were globally serialized')), 3000)),
    ]);
    assert.equal(arrivals, 2, 'different projects enter their storage/revision boundaries concurrently');
    assert.deepEqual(completed.map(item => item.revision), ['1', '1']);
    console.log('Team-retouch different-project mutation parallelism passed');
  } finally {
    release(); await Promise.all([left.close(), right.close()]);
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 }); } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
