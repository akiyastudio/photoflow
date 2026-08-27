const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHostSimulator } = require('./host-simulator.cjs');
const { ensureSchema, projectMigrationMetaKey, projectMigrationCommittedKey } = require('../service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-legacy-rpc-'));
const legacyPath = path.join(root, 'snapshot', 'domain-database', 'team-retouch.sqlite3');
fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
const legacy = new DatabaseSync(legacyPath);
legacy.exec(`
  CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  INSERT INTO meta VALUES('schema_version','1');
  CREATE TABLE team_patch_tasks(id TEXT PRIMARY KEY,photo_id TEXT NOT NULL,base_version_id TEXT NOT NULL,person_index INTEGER NOT NULL,person_name TEXT NOT NULL,assignee TEXT NOT NULL DEFAULT '',detector TEXT NOT NULL DEFAULT '',bbox_json TEXT NOT NULL,crop_json TEXT NOT NULL,patch_path TEXT NOT NULL,mask_path TEXT,mask_json TEXT NOT NULL DEFAULT '{}',members_json TEXT NOT NULL DEFAULT '[]',needs_review INTEGER NOT NULL DEFAULT 0,review_reason TEXT NOT NULL DEFAULT '',edited_patch_path TEXT,status TEXT NOT NULL DEFAULT 'exported',merge_metrics_json TEXT NOT NULL DEFAULT '{}',merged_version_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE team_retouch_photos(photo_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,base_version_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE team_person_identities(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL,color TEXT NOT NULL DEFAULT '#2563eb',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE team_person_assignments(project_id TEXT NOT NULL,photo_id TEXT NOT NULL,base_version_id TEXT NOT NULL,person_index INTEGER NOT NULL,identity_id TEXT,confidence REAL NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT 'manual',completed INTEGER NOT NULL DEFAULT 0,completion_kind TEXT NOT NULL DEFAULT '',edited_patch_path TEXT,return_missing INTEGER NOT NULL DEFAULT 0,return_missing_since INTEGER,completed_at INTEGER,updated_at INTEGER NOT NULL,PRIMARY KEY(photo_id,base_version_id,person_index));
  CREATE TABLE team_person_exclusions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,photo_id TEXT NOT NULL,base_version_id TEXT NOT NULL,bbox_json TEXT NOT NULL,reason TEXT NOT NULL DEFAULT 'false-positive',created_at INTEGER NOT NULL);
  CREATE TABLE team_workflow_state(project_id TEXT PRIMARY KEY,generated_at INTEGER NOT NULL,fingerprint TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL);
`);
const oldWorkspace = path.join(root, 'old-workspace'); const newWorkspace = path.join(root, 'new-workspace');
legacy.prepare('INSERT INTO team_retouch_photos VALUES(?,?,?,?,?)').run('legacy-photo', 'legacy-project', 'legacy-version', 1, 1);
legacy.prepare('INSERT INTO team_person_identities VALUES(?,?,?,?,?,?)').run('legacy-person', 'legacy-project', 'Legacy Person', '#123456', 1, 1);
legacy.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,edited_patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-task', 'legacy-photo', 'legacy-version', 1, 'Legacy Person', '{}', '{}', path.join(oldWorkspace, '进行中', 'Legacy', 'patch.jpg'), path.join(oldWorkspace, '进行中', 'Legacy', 'return.jpg'), 1, 1);
legacy.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,completed,completion_kind,edited_patch_path,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run('legacy-project', 'legacy-photo', 'legacy-version', 1, 'legacy-person', 1, 'returned', path.join(oldWorkspace, '进行中', 'Legacy', 'return.jpg'), 1);
legacy.prepare('INSERT INTO team_workflow_state VALUES(?,?,?,?)').run('legacy-project', 1, 'legacy-workflow', 1);
legacy.close();

const runMode = async mode => {
  const dataPath = path.join(root, mode, 'data'); const databasePath = path.join(dataPath, 'storage.sqlite3');
  const collisionDb = ensureSchema(databasePath);
  collisionDb.prepare('INSERT INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run('1', 'legacy-project', 999, 0, 1);
  collisionDb.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run('legacy-project', 1);
  collisionDb.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run('other-project', 1);
  collisionDb.prepare("INSERT INTO meta(key,value) VALUES('legacy_project_artifacts_v2','committed')").run();
  collisionDb.close();
  let storageCalls = 0;
  const simulator = createHostSimulator({
    service: path.join(__dirname, '..', 'service.cjs'),
    context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'backup.restore', componentBackupRestore: true, projectId: 'legacy-project', projectName: 'Legacy' },
    capabilities: { 'component.storage.v7': () => { storageCalls += 1; return { apiVersion: 7, dataPath, databasePath, projectId: 'legacy-project', ownership: 'component-private' }; } },
  });
  try {
    const method = mode === 'workspace' ? 'team.backup-restore.workspace.v1' : 'team.backup-restore.project.v1';
    const restored = await simulator.request(method, {
      schemaVersion: 1, operationId: `legacy-${mode}`, mode,
      sources: [{ format: 'legacy-domain-v1', path: legacyPath }],
      targetStorage: { dataPath, databasePath },
      sourceWorkspace: { root: oldWorkspace, dataRoot: path.join(oldWorkspace, '.photoflow') },
      targetWorkspace: { root: newWorkspace, dataRoot: path.join(newWorkspace, '.photoflow') },
      ...(mode === 'project' ? { project: { id: 'legacy-project', sourceRelativePath: '进行中/Legacy', targetRelativePath: '进行中/Legacy' } } : {}),
    });
    assert.equal(restored.status, 'committed');
    assert.equal(storageCalls, 0, 'restore hook uses the Host-authorized targetStorage and does not require a project-bound capability');
    const actual = await simulator.request('team.project.get.v1');
    assert.equal(actual.identities[0].name, 'Legacy Person');
    assert.equal(actual.photos[0].tasks[0].id, 'legacy-task');
    assert.equal(actual.assignments[0].completionKind, 'returned');
    const restoredDb = new DatabaseSync(databasePath);
    assert.equal(restoredDb.prepare("SELECT count(*) AS count FROM team_revision_guards WHERE request_id='1'").get().count, 0, 'real restore frame id collision cannot leave a stale revision guard ahead of business-table deletion');
    if (mode === 'project') {
      assert.equal(restoredDb.prepare('SELECT count(*) AS count FROM meta WHERE key IN (?,?)').get(projectMigrationMetaKey('legacy-project'), projectMigrationCommittedKey('legacy-project')).count, 0, 'project restore clears stale target migration state so legacy private artifacts can be adopted again');
      assert.equal(restoredDb.prepare('SELECT value FROM meta WHERE key=?').get(projectMigrationCommittedKey('other-project')).value, 'committed', 'project restore preserves another project migration marker');
      assert.equal(restoredDb.prepare("SELECT count(*) AS count FROM meta WHERE key='legacy_project_artifacts_v2'").get().count, 0, 'workspace-global completion marker is expanded and retired before project restore');
    }
    assert.equal(restoredDb.prepare("SELECT fingerprint FROM team_workflow_state WHERE project_id='legacy-project'").get().fingerprint, 'legacy-workflow');
    assert.ok(restoredDb.prepare("SELECT edited_patch_path FROM team_person_assignments WHERE project_id='legacy-project'").get().edited_patch_path.startsWith(newWorkspace));
    restoredDb.close();
  } finally { simulator.close(); }
};

(async () => {
  try { await runMode('workspace'); await runMode('project'); console.log('Team-retouch legacy backup RPC restore tests passed'); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
