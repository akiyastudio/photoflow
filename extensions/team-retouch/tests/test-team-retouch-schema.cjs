const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema, revisionRequestContext, startService } = require('../service.cjs');

assert.equal(typeof ensureSchema, 'function');
assert.equal(typeof startService, 'function');
assert.equal(typeof revisionRequestContext?.run, 'function');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-schema-'));
try {
  const databasePath = path.join(root, 'storage.sqlite3');
  let db = ensureSchema(databasePath);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '10');
  for (const table of ['team_project_revision_leases','team_revision_guards','team_project_revisions','team_patch_tasks','team_task_stages','team_task_artifacts','team_workflow_reconcile_pending']) {
    assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE type='table' AND name=?").get(table).type, 'table', `missing current table ${table}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='trigger' AND name LIKE 'team_patch_tasks_revision_%'").get().count, 6);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='index' AND name='team_pending_project_task'").get().count, 1);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();

  db = ensureSchema(databasePath);
  db.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run('project', 0);
  db.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run('current', 'project', 0, 0, 1);
  db.prepare('INSERT INTO team_project_revision_leases(project_id,request_id,expires_at) VALUES(?,?,?)').run('project', 'current', Date.now() + 60_000);
  revisionRequestContext.run({ requestId: 'current', projectId: 'project' }, () => db.prepare('INSERT INTO team_person_identities(project_id,id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('project', 'person', 'Person', '#fff', 1, 1));
  assert.equal(db.prepare("SELECT revision FROM team_project_revisions WHERE project_id='project'").get().revision, 1);
  db.close();

  for (const version of ['1', '9', '99']) {
    const rejectedPath = path.join(root, `schema-${version}.sqlite3`);
    const rejected = new DatabaseSync(rejectedPath);
    rejected.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','${version}')`);
    rejected.close();
    assert.throws(() => ensureSchema(rejectedPath), /不是当前首发 schema 10/);
    const untouched = new DatabaseSync(rejectedPath, { readOnly: true });
    assert.equal(untouched.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, version);
    untouched.close();
  }

  const malformedPath = path.join(root, 'malformed-v10.sqlite3');
  const malformed = new DatabaseSync(malformedPath);
  malformed.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','10'); CREATE TABLE team_patch_tasks(id TEXT)");
  malformed.close();
  assert.throws(() => ensureSchema(malformedPath), /表结构无效/);

  const wrongPkPath = path.join(root, 'wrong-pk-v10.sqlite3');
  db = ensureSchema(wrongPkPath);
  const assignmentSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_person_assignments'").get().sql;
  db.exec('DROP TABLE team_person_assignments');
  db.exec(assignmentSql.replace('PRIMARY KEY (project_id,photo_id,base_version_id,person_index)', 'PRIMARY KEY (project_id,photo_id)'));
  db.close();
  assert.throws(() => ensureSchema(wrongPkPath), /列约束无效/);

  const noOpTriggerPath = path.join(root, 'noop-trigger-v10.sqlite3');
  db = ensureSchema(noOpTriggerPath);
  db.exec('DROP TRIGGER team_patch_tasks_revision_insert; CREATE TRIGGER team_patch_tasks_revision_insert AFTER INSERT ON team_patch_tasks BEGIN SELECT 1; END');
  db.close();
  assert.throws(() => ensureSchema(noOpTriggerPath), /trigger 语义无效/);
  console.log('Team-retouch strict current schema tests passed');
} finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error; } }
