const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHostSimulator } = require('./host-simulator.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-adoption-'));
const context = { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'project-1', projectName: 'Project', projectStatus: 'active' };
const storage = state => state === 'pending'
  ? { apiVersion: 2, projectId: 'project-1', ownership: 'component-private', adoption: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'pending', componentId: 'team-retouch', fromHostApiVersion: 1, toHostApiVersion: 2, startedAt: 1 } }
  : { apiVersion: 2, dataPath: root, databasePath: path.join(root, 'storage.sqlite3'), projectId: 'project-1', ownership: 'component-private' };
const create = state => createHostSimulator({ service: path.join(__dirname, '..', 'service.cjs'), context, capabilities: {
  'component.storage.v2': () => storage(state),
  'component.settings.v2': () => ({ apiVersion: 2, revision: 0, settings: {} }),
  'project.media.page.v2': () => ({ apiVersion: 2, items: [], page: { hasMore: false, cursor: null, pageSize: 100 } }),
  'project.progress.v2': () => ({ apiVersion: 2, progress: [], edges: [] }),
  'tasks.v2': () => ({ apiVersion: 2, cancelled: false }),
  'component.events.v2': () => ({ apiVersion: 2, emitted: true })
} });
(async () => {
  const pending = create('pending');
  await assert.rejects(pending.request('team.project.register.v1', { relativePaths: ['one.jpg'] }), /首次安全迁移|正在完成/);
  pending.close();
  const committed = create('committed');
  const first = await committed.request('team.project.get.v1');
  const second = await committed.request('team.project.get.v1');
  assert.deepEqual(second.migration, first.migration, 'reopening an adopted empty store is idempotent');
  assert(fs.existsSync(path.join(root, 'storage.sqlite3')));
  committed.close(); fs.rmSync(root, { recursive: true, force: true });
  console.log('Team-retouch adoption pending/idempotency regression passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
