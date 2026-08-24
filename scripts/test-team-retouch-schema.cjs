const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../extensions/team-retouch/service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-schema-'));
const databasePath = path.join(root, 'legacy.sqlite3');
try {
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
  assert.equal(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '5');
  const assignments = migrated.prepare('SELECT person_index,task_id,stage_id,artifact_id FROM team_person_assignments ORDER BY person_index').all();
  assert.equal(assignments[0].task_id, 'task-a');
  assert.equal(assignments[1].task_id, 'task-b');
  assert(assignments.every(item => item.stage_id && item.artifact_id));
  assert.equal(migrated.prepare('SELECT COUNT(*) count FROM team_task_artifacts').get().count, 2);
  migrated.close();

  migrated = ensureSchema(databasePath);
  assert.equal(migrated.prepare('SELECT COUNT(*) count FROM team_task_artifacts').get().count, 2, 'migration is idempotent');
  assert.equal(migrated.prepare('SELECT COUNT(*) count FROM team_task_stages').get().count, 2, 'stage migration is idempotent');
  migrated.close();
  console.log('Team-retouch schema v5 migration tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
