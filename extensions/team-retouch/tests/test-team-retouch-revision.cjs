const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureSchema, revisionRequestContext } = require('../service.cjs');
const { createHostSimulator } = require('./host-simulator.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-revision-'));
const dataPath = path.join(sandbox, 'storage'); const databasePath = path.join(dataPath, 'storage.sqlite3'); fs.mkdirSync(dataPath, { recursive: true });
let db = ensureSchema(databasePath);
const workingPath = path.join(dataPath, 'media', 'photo-a', 'version-a', 'working-a.png'); fs.mkdirSync(path.dirname(workingPath), { recursive: true }); fs.writeFileSync(workingPath, 'working');
db.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('photo-a', 'project-a', 'version-a', 1, 1);
db.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('photo-a', 'project-b', 'version-a', 1, 1);
db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,'[]',1,1)`).run('project-a', 'task-a', 'photo-a', 'version-a', 1, '项目 A 人物', workingPath);
db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,'[]',1,1)`).run('project-b', 'task-a', 'photo-a', 'version-a', 1, '项目 B 人物', workingPath);
db.close();

const simulator = projectId => createHostSimulator({
  service: path.join(__dirname, '..', 'service.cjs'),
  context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId, projectName: projectId, projectStatus: 'active' },
  capabilities: { 'component.storage': () => ({ apiVersion: 7, dataPath, databasePath, projectId, ownership: 'component-private' }) },
});

(async () => {
  const projectA = simulator('project-a'); const projectB = simulator('project-b');
  try {
    const sameRevision = await Promise.allSettled([
      projectA.request('team.identity.save.v1', { name: 'Alice', assignments: [], expectedRevision: '0' }),
      projectA.request('team.identity.save.v1', { name: 'Bob', assignments: [], expectedRevision: '0' }),
    ]);
    assert.equal(sameRevision.filter(item => item.status === 'fulfilled').length, 1, 'only one concurrent mutation with the same expected revision commits');
    assert.equal(sameRevision.filter(item => item.status === 'rejected').length, 1);
    const committed = sameRevision.find(item => item.status === 'fulfilled').value;
    assert.equal(committed.revision, '1');

    const taskUpdate = await projectA.request('team.patch.update.v1', { photoId: 'photo-a', taskId: 'task-a', personName: '更新人物', expectedRevision: '1' });
    assert.equal(taskUpdate.revision, '2', 'task/read-model mutation advances the monotonic project revision');
    await assert.rejects(projectA.request('team.identity.save.v1', { name: 'Stale', assignments: [], expectedRevision: '1' }), /已被其他操作更新/);

    const projectBMutation = await projectB.request('team.identity.save.v1', { name: 'Project B', assignments: [], expectedRevision: '0' });
    assert.equal(projectBMutation.revision, '1', 'project B accepts its own revision 0 after project A advanced independently');
    db = ensureSchema(databasePath);
    assert.equal(db.prepare('SELECT person_name FROM team_patch_tasks WHERE project_id=? AND id=?').get('project-a', 'task-a').person_name, '更新人物');
    assert.equal(db.prepare('SELECT person_name FROM team_patch_tasks WHERE project_id=? AND id=?').get('project-b', 'task-a').person_name, '项目 B 人物', 'same task/photo/person IDs in project B are never updated by project A');
    db.close();

    db = ensureSchema(databasePath);
    db.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run('exclude-request', 'project-a', 2, 0, Date.now());
    revisionRequestContext.run({ requestId: 'exclude-request' }, () => db.prepare(`INSERT INTO team_person_exclusions(id,project_id,photo_id,base_version_id,bbox_json,created_at) VALUES(?,?,?,?,?,?)`).run('exclude-a', 'project-a', 'photo-a', 'version-a', '{}', Date.now()));
    assert.equal(db.prepare('SELECT revision FROM team_project_revisions WHERE project_id=?').get('project-a').revision, 3, 'exclusion mutation advances revision in the same SQLite transaction');
    db.close();
    console.log('Team-retouch project-scoped monotonic revision contracts passed');
  } finally { projectA.close(); projectB.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
