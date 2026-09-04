const assert = require('assert');
// Plugin-owned regression test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const servicePath = require.resolve('../service.cjs');
const serviceModule = require(servicePath);
const { ensureSchema, startService, migrateAdoptedPrivatePaths, migrationStateFromDb, pendingLegacyArtifactItems, projectMigrationCommittedKey, revisionRequestContext, writeMigrationState } = serviceModule;
assert.equal((fs.readFileSync(servicePath, 'utf8').match(/module\.exports\s*=/g) || []).length, 1, 'team-retouch service must have one authoritative CommonJS export assignment');
for (const [name, value] of Object.entries({ ensureSchema, startService, migrateAdoptedPrivatePaths, migrationStateFromDb, pendingLegacyArtifactItems, projectMigrationCommittedKey, writeMigrationState })) assert.equal(typeof value, 'function', `team-retouch service export missing: ${name}`);
assert.equal(typeof revisionRequestContext?.run, 'function', 'team-retouch service export missing: revisionRequestContext');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-schema-'));
const databasePath = path.join(root, 'legacy.sqlite3');
try {
  const futurePath = path.join(root, 'future.sqlite3'); const future = new DatabaseSync(futurePath);
  future.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','99')"); future.close();
  assert.throws(() => ensureSchema(futurePath), /高于当前支持的 10/, 'future schema versions fail closed instead of downgrading markers');
  const futureCheck = new DatabaseSync(futurePath); assert.equal(futureCheck.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '99'); futureCheck.close();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','1');
    CREATE TABLE team_patch_tasks (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
      person_index INTEGER NOT NULL, person_name TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '',
      detector TEXT NOT NULL DEFAULT '', bbox_json TEXT NOT NULL, crop_json TEXT NOT NULL,
      patch_path TEXT NOT NULL, mask_path TEXT, mask_json TEXT NOT NULL DEFAULT '{}',
      members_json TEXT NOT NULL DEFAULT '[]', needs_review INTEGER NOT NULL DEFAULT 0,
      review_reason TEXT NOT NULL DEFAULT '', edited_patch_path TEXT, status TEXT NOT NULL DEFAULT 'exported',
      merge_metrics_json TEXT NOT NULL DEFAULT '{}', merged_version_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE team_retouch_photos (photo_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, base_version_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO team_retouch_photos VALUES('photo','project','base',1,1);
    CREATE TABLE team_person_identities (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#2563eb', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE team_person_assignments (
      project_id TEXT NOT NULL, photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL, person_index INTEGER NOT NULL,
      identity_id TEXT, confidence REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual',
      completed INTEGER NOT NULL DEFAULT 0, completion_kind TEXT NOT NULL DEFAULT '', edited_patch_path TEXT,
      return_missing INTEGER NOT NULL DEFAULT 0, return_missing_since INTEGER, completed_at INTEGER,
      updated_at INTEGER NOT NULL, PRIMARY KEY (photo_id, base_version_id, person_index)
    );
    CREATE TABLE team_person_exclusions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL, bbox_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'false-positive', created_at INTEGER NOT NULL);
    INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,edited_patch_path,created_at,updated_at)
      VALUES('task-a','photo','base',1,'人物 1','{}','{}','work-a.png','[{"personIndex":1}]','return-a.png',1,10);
    INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,edited_patch_path,created_at,updated_at)
      VALUES('task-b','photo','base',2,'人物 2','{}','{}','work-b.png','[{"personIndex":2}]','return-b.png',2,20);
    INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,completed,completion_kind,edited_patch_path,completed_at,updated_at)
      VALUES('project','photo','base',1,1,'returned','return-a.png',10,10);
    INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,completed,completion_kind,edited_patch_path,completed_at,updated_at)
      VALUES('project','photo','base',2,1,'returned','return-b.png',20,20);
  `);
  legacy.close();

  let migrated = ensureSchema(databasePath);
  assert.equal(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '10');
  const assignments = migrated.prepare('SELECT person_index,task_id,stage_id,artifact_id FROM team_person_assignments ORDER BY person_index').all();
  assert.equal(assignments[0].task_id, 'task-a');
  assert.equal(assignments[1].task_id, 'task-b');
  assert(assignments.every(item => item.stage_id && item.artifact_id));
  assert.equal(migrated.prepare('SELECT COUNT(*) count FROM team_task_artifacts').get().count, 2);
  migrated.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,display_name,relative_path,relative_path_state,file_missing,calibrated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('photo', 'project-b', 'base', 'B', 'b.jpg', 'ready', 0, 1, 1, 1);
  migrated.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,assignee,detector,bbox_json,crop_json,patch_path,mask_json,members_json,needs_review,review_reason,status,merge_metrics_json,generation_json,created_at,updated_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('project-b', 'task-a', 'photo', 'base', 1, 'B', '', '', '{}', '{}', 'b.png', '{}', '[]', 0, '', 'exported', '{}', '{}', 1, 1, 0);
  assert.equal(migrated.prepare("SELECT COUNT(*) count FROM team_patch_tasks WHERE id='task-a'").get().count, 2, 'migrated v8 database accepts the same task id in two projects');
  migrated.close();

  migrated = ensureSchema(databasePath);
  assert.equal(migrated.prepare('SELECT COUNT(*) count FROM team_task_artifacts').get().count, 2, 'migration is idempotent');
  assert.equal(migrated.prepare('SELECT COUNT(*) count FROM team_task_stages').get().count, 2, 'stage migration is idempotent');
  migrated.close();

  const malformedV9Path = path.join(root, 'malformed-v9.sqlite3');
  const malformedV9 = new DatabaseSync(malformedV9Path);
  malformedV9.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','9');
    CREATE TABLE team_workflow_reconcile_pending(
      task_id TEXT,photo_id TEXT,error TEXT,updated_at INT,attempt_count INT,next_attempt_at INT,last_error TEXT,history_json TEXT,project_id TEXT
    );
    INSERT INTO team_workflow_reconcile_pending VALUES('task-shared','photo-null','用户打开任务文件夹，等待后台准备',10,NULL,NULL,NULL,NULL,'project-a');
    INSERT INTO team_workflow_reconcile_pending VALUES('task-shared','photo-valid','失败',20,2,123,'真实错误','[]','project-b');
  `);
  malformedV9.close();
  const faultV9Path = path.join(root, 'fault-v9.sqlite3');
  fs.copyFileSync(malformedV9Path, faultV9Path);
  process.env.PHOTOFLOW_TEST_FAULT_SCHEMA_V10 = 'after-copy';
  try { assert.throws(() => ensureSchema(faultV9Path), /injected schema v10 rebuild failure/, 'schema v10 repair rolls back when interrupted after copying'); }
  finally { delete process.env.PHOTOFLOW_TEST_FAULT_SCHEMA_V10; }
  const rolledBackV9 = new DatabaseSync(faultV9Path);
  assert.equal(rolledBackV9.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '9');
  assert.equal(rolledBackV9.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending').get().count, 2);
  assert.equal(rolledBackV9.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='v10_pending'").get().count, 0, 'failed repair leaves no partial replacement table');
  rolledBackV9.close();
  const repairedV10 = ensureSchema(malformedV9Path);
  assert.equal(repairedV10.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '10');
  const repairedColumns = new Map(repairedV10.prepare('PRAGMA table_info(team_workflow_reconcile_pending)').all().map(column => [column.name, column]));
  for (const name of ['attempt_count','next_attempt_at','last_error','history_json']) assert.equal(repairedColumns.get(name).notnull, 1, `${name} regains its NOT NULL contract`);
  assert.equal(repairedColumns.get('attempt_count').dflt_value, '0');
  assert.equal(repairedColumns.get('next_attempt_at').dflt_value, '0');
  assert.equal(repairedColumns.get('last_error').dflt_value, "''");
  assert.equal(repairedColumns.get('history_json').dflt_value, "'[]'");
  assert.equal(repairedColumns.get('project_id').pk, 1); assert.equal(repairedColumns.get('task_id').pk, 2);
  assert.equal(repairedV10.prepare("SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE task_id='task-shared'").get().count, 2, 'schema v10 preserves the same task id independently in two projects');
  assert.deepEqual(repairedV10.prepare("SELECT attempt_count,next_attempt_at,last_error,history_json FROM team_workflow_reconcile_pending WHERE project_id='project-a'").get(), { attempt_count: 0, next_attempt_at: 0, last_error: '', history_json: '[]' }, 'schema v10 wakes NULL retry rows without changing their project ownership');
  assert.deepEqual(repairedV10.prepare("SELECT attempt_count,next_attempt_at,last_error FROM team_workflow_reconcile_pending WHERE project_id='project-b'").get(), { attempt_count: 2, next_attempt_at: 123, last_error: '真实错误' }, 'valid retry diagnostics survive schema repair');
  repairedV10.prepare('INSERT INTO team_workflow_reconcile_pending(project_id,task_id,photo_id,updated_at) VALUES(?,?,?,?)').run('project-a', 'task-defaults', 'photo-defaults', 30);
  assert.deepEqual(repairedV10.prepare("SELECT error,attempt_count,next_attempt_at,last_error,history_json FROM team_workflow_reconcile_pending WHERE task_id='task-defaults'").get(), { error: '', attempt_count: 0, next_attempt_at: 0, last_error: '', history_json: '[]' }, 'future queue inserts receive canonical defaults');
  assert.equal(repairedV10.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='trigger' AND name LIKE 'team_workflow_reconcile_pending_revision_%'").get().count, 6, 'schema repair restores every revision guard and bump trigger');
  repairedV10.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run('project-a', 0);
  repairedV10.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run('v10-current', 'project-a', 0, 0, 1);
  revisionRequestContext.run({ requestId: 'v10-current', projectId: 'project-a' }, () => repairedV10.prepare("UPDATE team_workflow_reconcile_pending SET error='updated' WHERE project_id='project-a' AND task_id='task-shared'").run());
  assert.equal(repairedV10.prepare("SELECT revision FROM team_project_revisions WHERE project_id='project-a'").get().revision, 1, 'repaired queue mutation advances the project revision exactly once');
  repairedV10.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run('v10-stale', 'project-a', 0, 0, 2);
  assert.throws(() => revisionRequestContext.run({ requestId: 'v10-stale', projectId: 'project-a' }, () => repairedV10.prepare("UPDATE team_workflow_reconcile_pending SET error='stale' WHERE project_id='project-a' AND task_id='task-shared'").run()), /TEAM_REVISION_CONFLICT/, 'repaired queue rejects a stale guarded mutation');
  repairedV10.close();
  const recoveredFaultV10 = ensureSchema(faultV9Path); assert.equal(recoveredFaultV10.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '10'); recoveredFaultV10.close();
  console.log('Team-retouch schema v10 migration tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const committedReceipt = legacyDataRoot => ({ schemaVersion: 1, kind: 'component-storage-adoption', state: 'committed', componentId: 'team-retouch', fromHostApiVersion: 1, toHostApiVersion: 2, adoptedDataRoot: true, legacyDataRoot });
const seedAdoptionTask = (databasePath, values) => {
  const db = ensureSchema(databasePath); const insert = db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,mask_path,edited_patch_path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,?,?,'uploaded',1,1)`);
  insert.run('test-project', values.id, values.id, 'base', 1, '人物 1', values.patch, values.mask, values.edited); db.close();
};

(async () => {
  const scaleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-adoption-scale-'));
  try {
    const legacyDataRoot = path.join(scaleRoot, 'legacy'); const dataPath = path.join(scaleRoot, 'v2'); const databasePath = path.join(dataPath, 'storage.sqlite3');
    fs.mkdirSync(legacyDataRoot, { recursive: true }); fs.mkdirSync(dataPath, { recursive: true });
    const db = ensureSchema(databasePath); const insert = db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,mask_path,edited_patch_path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,?,?,'uploaded',1,1)`);
    db.exec('BEGIN');
    for (let index = 0; index < 800; index += 1) {
      const relative = [`files/${index}-patch.bin`, `files/${index}-mask.bin`, `files/${index}-edited.bin`];
      for (const name of relative) { const source = path.join(legacyDataRoot, name); const target = path.join(dataPath, name); fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(source, 'x'); fs.writeFileSync(target, 'x'); }
      insert.run('scale-project', `scale-${index}`, `photo-${index}`, 'base', 1, '人物 1', ...relative.map(name => path.join(legacyDataRoot, name)));
    }
    db.exec('COMMIT'); db.close();
    const originalCreateReadStream = fs.createReadStream; fs.createReadStream = () => { throw new Error('fileSha256 must not run during adopted private path migration'); };
    const startedAt = Date.now();
    try { await migrateAdoptedPrivatePaths({ dataPath, databasePath, adoption: committedReceipt(legacyDataRoot) }); }
    finally { fs.createReadStream = originalCreateReadStream; }
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs < 2000, `2400-path metadata-only adoption exceeded budget: ${elapsedMs}ms`);
    const verified = ensureSchema(databasePath);
    const paths = verified.prepare('SELECT patch_path,mask_path,edited_patch_path FROM team_patch_tasks').all().flatMap(row => Object.values(row));
    assert.equal(paths.length, 2400); assert(paths.every(value => value.startsWith(dataPath)), 'all legacy absolute paths are rewritten');
    assert.equal(verified.prepare("SELECT value FROM meta WHERE key='storage_path_adoption_v2'").get().value, 'committed'); verified.close();
    assert(fs.existsSync(path.join(legacyDataRoot, 'files', '0-patch.bin')), 'legacy source remains available for rollback');

    const unsafeRoot = path.join(scaleRoot, 'unsafe'); const unsafeLegacy = path.join(unsafeRoot, 'legacy'); const unsafeTarget = path.join(unsafeRoot, 'v2'); const unsafeDb = path.join(unsafeTarget, 'storage.sqlite3');
    fs.mkdirSync(unsafeLegacy, { recursive: true }); fs.mkdirSync(unsafeTarget, { recursive: true });
    const unsafeSource = path.join(unsafeLegacy, 'missing.bin'); seedAdoptionTask(unsafeDb, { id: 'missing', patch: unsafeSource, mask: '', edited: '' }); fs.writeFileSync(unsafeSource, 'x');
    await assert.rejects(migrateAdoptedPrivatePaths({ dataPath: unsafeTarget, databasePath: unsafeDb, adoption: committedReceipt(unsafeLegacy) }), /副本缺失/);
    let unsafe = ensureSchema(unsafeDb); assert.equal(unsafe.prepare("SELECT value FROM meta WHERE key='storage_path_adoption_v2'").get(), undefined, 'failed validation must not commit marker'); unsafe.close();
    await assert.rejects(migrateAdoptedPrivatePaths({ dataPath: unsafeTarget, databasePath: unsafeDb, adoption: { ...committedReceipt(unsafeLegacy), componentId: 'other-component' } }), /凭据无效/);
    const outside = path.join(unsafeRoot, 'outside.bin'); fs.writeFileSync(outside, 'x'); const linked = path.join(unsafeTarget, 'missing.bin');
    try {
      fs.symlinkSync(outside, linked, 'file');
      await assert.rejects(migrateAdoptedPrivatePaths({ dataPath: unsafeTarget, databasePath: unsafeDb, adoption: committedReceipt(unsafeLegacy) }), /副本缺失/);
    } catch (error) { if (!['EPERM', 'EACCES'].includes(error?.code)) throw error; }
    unsafe = ensureSchema(unsafeDb); assert.equal(unsafe.prepare("SELECT value FROM meta WHERE key='storage_path_adoption_v2'").get(), undefined); unsafe.close();

    const scopedDbPath = path.join(scaleRoot, 'scoped', 'storage.sqlite3'); const scoped = ensureSchema(scopedDbPath);
    scoped.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('photo-a', 'project-a', 'base-a', 1, 1);
    scoped.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('photo-b', 'project-b', 'base-b', 1, 1);
    const scopedInsert = scoped.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,edited_patch_path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,?,'uploaded',1,1)`);
    scopedInsert.run('project-a', 'task-a', 'photo-a', 'base-a', 1, 'A', path.join(scaleRoot, 'outside-a.bin'), path.join(scaleRoot, 'return-a.bin'));
    scopedInsert.run('project-b', 'task-b', 'photo-b', 'base-b', 1, 'B', path.join(scaleRoot, 'outside-b.bin'), path.join(scaleRoot, 'missing-b.bin'));
    assert.deepEqual([...new Set(pendingLegacyArtifactItems(scoped, path.dirname(scopedDbPath), 'project-a').map(item => item.row.id))], ['task-a'], 'project A migration never reads project B media');
    assert.deepEqual([...new Set(pendingLegacyArtifactItems(scoped, path.dirname(scopedDbPath), 'project-b').map(item => item.row.id))], ['task-b'], 'project B retains an independent retry queue');
    writeMigrationState(scoped, 'project-a', { state: 'pending', phase: 'outputs', processedCount: 0, pendingCount: 2, attemptCount: 1, lastError: '可恢复', retryable: true });
    assert.equal(migrationStateFromDb(scoped, 'project-a').attemptCount, 1, 'failed project A step checkpoints its retry state under A only');
    assert.equal(migrationStateFromDb(scoped, 'project-b').attemptCount, 0, 'project A retry state never leaks into project B');
    scoped.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(projectMigrationCommittedKey('project-a'), 'committed');
    assert.equal(migrationStateFromDb(scoped, 'project-a').state, 'committed'); assert.equal(migrationStateFromDb(scoped, 'project-b').state, 'pending', 'project A marker does not mask project B'); scoped.close();
    console.log(`Team-retouch storage adoption performance passed: 2400 paths in ${elapsedMs}ms without file hashing`);
  } finally { try { fs.rmSync(scaleRoot, { recursive: true, force: true }); } catch { /* a failed assertion may leave SQLite handles for process cleanup */ } }
})().catch(error => { console.error(error); process.exitCode = 1; });
