const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { createHostSimulator } = require('./host-simulator.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-control-plane-'));
const dataPath = path.join(root, 'data'); const databasePath = path.join(dataPath, 'storage.sqlite3');
fs.mkdirSync(dataPath, { recursive: true }); let storageCalls = 0;
const simulator = createHostSimulator({
  service: path.join(__dirname, '..', 'service.cjs'),
  env: { PHOTOFLOW_TEST_REVISION_LEASES: '1' },
  context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'project', projectStatus: 'active' },
  capabilities: { 'component.storage': () => { storageCalls += 1; return { dataPath, dataRoot: dataPath, databasePath, projectId: 'project' }; }, tasks: () => ({ success: true }) },
});

(async () => {
  try {
    const running = simulator.request('team.test.revision-lease.v1', { marker: 'running', delayMs: 500 });
    await new Promise(resolve => setTimeout(resolve, 60));
    const queued = simulator.request('team.test.revision-lease.v1', { marker: 'must-not-run' });
    simulator.cancelRequest(queued.requestId);
    const started = performance.now();
    const cancelled = await simulator.request('team.workflow.cancel.v1', { operationId: 'not-running' });
    assert.equal(cancelled.success, true);
    assert(performance.now() - started < 450, 'control-plane cancel must not wait behind the 500ms project mutation queue');
    await running;
    await assert.rejects(queued, error => error.code === 'EOPCANCELLED');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) count FROM team_person_identities WHERE project_id='project' AND id LIKE '%must-not-run%'").get().count, 0);
    db.close();
    assert.equal(storageCalls, 2, 'queued cancelled mutation performs no component.storage call');
    console.log('Team-retouch control-plane cancellation and zero-side-effect queue tests passed');
  } finally { await simulator.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
})().catch(error => { console.error(error); process.exitCode = 1; });
