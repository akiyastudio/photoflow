const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureSchema } = require('../service.cjs');
const { restoreProjectStorage, restoreWorkspaceStorage, selectRestoreSource } = require('../backup-restore.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-backup-restore-'));
const sourcePath = path.join(root, 'source', 'storage.sqlite3');
const destinationPath = path.join(root, 'destination', 'storage.sqlite3');
const seed = (databasePath, projectId, tag) => {
  const db = ensureSchema(databasePath); const now = Date.now();
  db.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run(projectId, 3);
  db.prepare('INSERT INTO team_retouch_photos(project_id,photo_id,base_version_id,display_name,relative_path,relative_path_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(projectId, `photo-${tag}`, `version-${tag}`, tag, `${tag}.jpg`, 'ready', now, now);
  db.prepare('INSERT INTO team_person_identities(project_id,id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(projectId, `identity-${tag}`, `Person ${tag}`, '#fff', now, now);
  db.close();
};

try {
  assert.equal(selectRestoreSource([{ format: 'component-storage-v1', path: 'current' }]).path, 'current');
  assert.equal(selectRestoreSource([{ format: 'unknown-format', path: 'unknown' }]), undefined);
  seed(sourcePath, 'project-a', 'A'); seed(sourcePath, 'project-b', 'B');
  seed(destinationPath, 'project-a', 'X'); seed(destinationPath, 'project-b', 'Y');
  const projectPayload = { operationId: 'project-restore', project: { id: 'project-a' }, sourceWorkspace: {}, targetWorkspace: {} };
  const untouched = (() => { const db=ensureSchema(destinationPath); try { return db.prepare("SELECT * FROM team_retouch_photos WHERE project_id='project-b'").get(); } finally { db.close(); } })();
  assert.equal(restoreProjectStorage({ sourcePath, destinationPath, payload: projectPayload, ensureSchema }).status, 'committed');
  let db = ensureSchema(destinationPath);
  assert.equal(db.prepare("SELECT display_name FROM team_retouch_photos WHERE project_id='project-a'").get().display_name, 'A');
  assert.deepEqual(db.prepare("SELECT * FROM team_retouch_photos WHERE project_id='project-b'").get(), untouched);
  db.close();
  assert.equal(restoreProjectStorage({ sourcePath, destinationPath, payload: projectPayload, ensureSchema }).status, 'already-committed');
  assert.throws(() => restoreProjectStorage({ sourcePath, destinationPath, payload: { ...projectPayload, operationId: 'fault' }, ensureSchema, fault: 'after-delete' }), /injected/);
  db = ensureSchema(destinationPath); assert.equal(db.prepare("SELECT display_name FROM team_retouch_photos WHERE project_id='project-a'").get().display_name, 'A'); db.close();

  const workspacePath = path.join(root, 'workspace', 'storage.sqlite3'); seed(workspacePath, 'obsolete', 'Z');
  assert.equal(restoreWorkspaceStorage({ sourcePath, destinationPath: workspacePath, payload: { operationId: 'workspace-restore' }, ensureSchema }).status, 'committed');
  db = ensureSchema(workspacePath);
  assert.deepEqual(db.prepare('SELECT project_id FROM team_retouch_photos ORDER BY project_id').all().map(row => row.project_id), ['project-a','project-b']);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); db.close();
  console.log('Team-retouch current backup/restore transaction tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
