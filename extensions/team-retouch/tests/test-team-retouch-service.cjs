const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHostSimulator } = require('./host-simulator.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-protocol-'));
const dataPath = path.join(sandbox, 'component-storage'); fs.mkdirSync(dataPath, { recursive: true });
const calls = [];
const ok = result => payload => { calls.push(payload); return result; };
const simulator = createHostSimulator({
  service: path.join(__dirname, '..', 'service.cjs'),
  context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'project-1', projectName: 'Project', projectStatus: 'active' },
  capabilities: {
    'component.storage.v2': ok({ apiVersion: 2, dataPath, databasePath: path.join(dataPath, 'storage.sqlite3'), projectId: 'project-1', ownership: 'component-private' }),
    'component.settings.v2': payload => payload.action === 'get' ? { apiVersion: 2, revision: 0, settings: {} } : { apiVersion: 2, revision: 1, settings: payload.settings || {} },
    'project.media.page.v2': ok({ apiVersion: 2, items: [], page: { hasMore: false, cursor: null, pageSize: 100 } }),
    'project.progress.v2': ok({ apiVersion: 2, progress: [], edges: [] }),
    'tasks.v2': ok({ apiVersion: 2, task: null, cancelled: false }),
    'component.events.v2': ok({ apiVersion: 2, emitted: true }),
    'notifications.v2': ok({ apiVersion: 2, accepted: true })
  }
});
(async () => {
  try {
    const settings = await simulator.request('team.settings.get.v1');
    assert.equal(typeof settings, 'object');
    const project = await simulator.request('team.project.get.v1');
    assert.equal(project.success, true);
    assert.equal(Array.isArray(project.photos), true);
    assert(fs.existsSync(path.join(dataPath, 'storage.sqlite3')));
    const updated = await simulator.request('team.settings.update.v1', { useGpu: false });
    assert.equal(typeof updated, 'object');
    console.log('Team-retouch independent service protocol integration passed');
  } finally { simulator.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
