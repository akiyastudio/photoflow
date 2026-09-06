const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema, revisionRequestContext } = require('../service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-schema-recovery-'));
const rebuiltTables = ['team_retouch_photos','team_person_identities','team_patch_tasks','team_person_assignments','team_person_exclusions','team_task_stages','team_task_artifacts','team_workflow_review_confirmations','team_durable_operations'];
const plain = value => JSON.parse(JSON.stringify(value));
const schema = db => plain(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all());
const rows = (db, table) => plain(db.prepare(`SELECT * FROM ${table}`).all());
const seed = db => {
  for (const table of rebuiltTables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const values = columns.map(column => {
      if (column.name === 'project_id') return 'project';
      if (column.name === 'photo_id') return 'photo';
      if (column.name === 'base_version_id') return 'version';
      if (column.name === 'calibrated_at') return 12345;
      if (column.name.endsWith('_json')) return column.name === 'members_json' ? '[]' : '{}';
      if (['INTEGER','REAL'].includes(column.type)) return 1;
      return `${table}:${column.name}`;
    });
    db.prepare(`INSERT INTO ${table}(${columns.map(c => c.name).join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...values);
  }
  db.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run('project', 42);
};
const legacyDatabase = file => {
  const db = ensureSchema(file);
  seed(db);
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_lease_owner_%'").all()) db.exec(`DROP TRIGGER ${name}`);
  db.exec('DROP TABLE team_project_revision_leases; DROP TABLE team_output_outbox; DROP TABLE team_cleanup_outbox');
  // Reproduce the old CREATE TABLE AS migration with different physical column
  // order. Only synthetic rows and public schema definitions belong in fixtures.
  for (const table of rebuiltTables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).reverse();
    const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table);
    db.exec(`CREATE TABLE old_snapshot AS SELECT ${columns.join(',')}${table === 'team_retouch_photos' ? ',CAST(12345 AS INTEGER) AS calibrated_at' : ''} FROM ${table};
      DROP TABLE ${table}; ALTER TABLE old_snapshot RENAME TO ${table};`);
    for (const object of objects) db.exec(object.sql);
  }
  db.exec('UPDATE team_durable_operations SET progress=NULL,checkpoint_json=NULL,result_json=NULL,cancel_requested=NULL');
  return db;
};

try {
  const missingLeasePath = path.join(root, 'missing-lease.sqlite3');
  let db = ensureSchema(missingLeasePath);
  seed(db);
  db.exec('DROP TABLE team_project_revision_leases');
  const beforeMissingLease = rows(db, 'team_patch_tasks');
  db.close();
  db = ensureSchema(missingLeasePath);
  assert.deepEqual(rows(db, 'team_patch_tasks'), beforeMissingLease);
  assert.deepEqual(db.prepare('PRAGMA table_info(team_project_revision_leases)').all().map(c => c.name), ['project_id','request_id','expires_at']);
  db.prepare('INSERT INTO team_project_revision_leases(project_id,request_id,expires_at) VALUES(?,?,?)').run('project', 'active', Date.now() + 60_000);
  db.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,created_at) VALUES(?,?,?,?)').run('active', 'project', 42, Date.now());
  db.exec("INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,created_at,updated_at) VALUES('project','output','working-output','fingerprint','key','publish_inflight',1,1)");
  db.exec("INSERT INTO team_cleanup_outbox(project_id,id,artifact_path,created_at,updated_at) VALUES('project','cleanup','artifact',1,1)");
  const pendingTables = ['team_project_revision_leases','team_revision_guards','team_output_outbox','team_cleanup_outbox'];
  const pending = Object.fromEntries(pendingTables.map(table => [table, rows(db, table)]));
  db.close();
  db = ensureSchema(missingLeasePath);
  for (const table of pendingTables) assert.deepEqual(rows(db, table), pending[table], `reopening preserves ${table}`);
  db.close();

  const legacyPath = path.join(root, 'legacy-v10.sqlite3');
  db = legacyDatabase(legacyPath);
  const before = Object.fromEntries(rebuiltTables.map(table => [table, rows(db, table)]));
  db.close();
  db = ensureSchema(legacyPath);
  for (const table of rebuiltTables) {
    const expected = before[table].map(row => {
      const copy = { ...row }; delete copy.calibrated_at;
      if (table === 'team_durable_operations') Object.assign(copy, { progress: 0, checkpoint_json: '{}', result_json: '{}', cancel_requested: 0 });
      return copy;
    });
    assert.deepEqual(rows(db, table), expected, `${table} values survive recovery`);
    assert.ok(db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.pk > 0), `${table} regains its primary key`);
  }
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='schema10_recovery:photo_calibration'").get().value), [{ project_id: 'project', photo_id: 'photo', base_version_id: 'version', calibrated_at: 12345 }]);
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='schema10_recovery:defaulted:team_durable_operations'").get().value), [{ key: { project_id: 'project', id: 'team_durable_operations:id' }, columns: ['progress','checkpoint_json','result_json','cancel_requested'] }]);
  assert.equal(db.prepare("SELECT revision FROM team_project_revisions WHERE project_id='project'").get().revision, 42);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '10');
  assert.deepEqual(plain(db.prepare('PRAGMA quick_check').all()), [{ quick_check: 'ok' }]);
  const recoveredSchema = schema(db);
  db.close();
  db = ensureSchema(legacyPath);
  assert.deepEqual(schema(db), recoveredSchema, 'reopening does not repeat recovery');
  db.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run('request', 'project', 42, 0, Date.now());
  revisionRequestContext.run({ requestId: 'request', projectId: 'project' }, () => {
    assert.throws(() => db.prepare("UPDATE team_person_identities SET name='changed' WHERE project_id='project'").run(), /TEAM_REVISION_LEASE_LOST/);
    db.prepare('INSERT INTO team_project_revision_leases(project_id,request_id,expires_at) VALUES(?,?,?)').run('project', 'request', Date.now() + 60_000);
    db.prepare("UPDATE team_person_identities SET name='changed' WHERE project_id='project'").run();
  });
  assert.equal(db.prepare("SELECT revision FROM team_project_revisions WHERE project_id='project'").get().revision, 43);
  db.close();

  for (const fault of ['null-row','duplicate-key','invalid-trigger','unknown-column']) {
    const failedPath = path.join(root, `${fault}.sqlite3`);
    db = legacyDatabase(failedPath);
    if (fault === 'null-row') db.exec('UPDATE team_durable_operations SET state=NULL');
    if (fault === 'duplicate-key') db.exec('DROP INDEX team_task_project_id; INSERT INTO team_patch_tasks SELECT * FROM team_patch_tasks');
    if (fault === 'invalid-trigger') db.exec('DROP TRIGGER team_patch_tasks_revision_insert; CREATE TRIGGER team_patch_tasks_revision_insert AFTER INSERT ON team_patch_tasks BEGIN SELECT 1; END');
    if (fault === 'unknown-column') db.exec('ALTER TABLE team_patch_tasks ADD COLUMN unknown_field TEXT');
    const originalSchema = schema(db);
    const originalRows = Object.fromEntries(['meta', ...rebuiltTables].map(table => [table, rows(db, table)]));
    db.close();
    assert.throws(() => ensureSchema(failedPath), fault === 'null-row' ? /NOT NULL/ : fault === 'duplicate-key' ? /UNIQUE/ : fault === 'invalid-trigger' ? /trigger 语义无效/ : /表结构无效/);
    db = new DatabaseSync(failedPath);
    assert.deepEqual(schema(db), originalSchema, `${fault} rolls back every schema change`);
    for (const table of Object.keys(originalRows)) assert.deepEqual(rows(db, table), originalRows[table], `${fault} preserves ${table}`);
    db.exec('BEGIN IMMEDIATE; ROLLBACK');
    db.close();
  }
  console.log('Team-retouch schema-10 recovery and rollback tests passed');
} finally {
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('team-schema-recovery-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
