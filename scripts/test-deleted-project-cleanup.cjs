const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-deleted-project-test-'));
const workspace = path.join(testRoot, 'workspace');
const database = path.join(testRoot, 'workspace.sqlite3');
const projectName = 'deleted-project';
const projectPath = path.join(workspace, projectName);
const python = process.platform === 'win32'
  ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
  : path.join(__dirname, '..', '.venv', 'bin', 'python');
const script = path.join(__dirname, '..', 'python', 'workspace_db.py');

const run = (action, payload = {}) => {
  const result = spawnSync(python, [script, action, '--root', workspace, '--database', database, '--payload', JSON.stringify(payload)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const lines = String(result.stdout || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const response = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  if (!response?.success) throw new Error(response?.error || String(result.stderr || `workspace_db exited with ${result.status}`));
  return response;
};

const syncMediaProject = project => {
  const prepared = run('media_sync_prepare', { projectName: project });
  for (let offset = 0, batchIndex = 0; offset < prepared.files.length; offset += 64, batchIndex += 1) {
    run('media_sync_apply_batch', {
      projectName: project, snapshotId: prepared.snapshotId, batchIndex,
      authorizedRoots: prepared.authorizedRoots, files: prepared.files.slice(offset, offset + 64),
    });
  }
  return run('media_sync_finalize', {
    projectName: project, snapshotId: prepared.snapshotId, authorizedRoots: prepared.authorizedRoots,
    files: prepared.files, baselineVersions: prepared.baselineVersions,
  });
};

try {
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'photo.jpg'), Buffer.from('test-image'));
  run('init');
  run('catalog_sync');
  syncMediaProject(projectName);
  run('undo_record_add', {
    kind: 'trash',
    payload: {
      items: [{ original: projectPath, recyclePidl: 'test-pidl', preciseRestore: true }],
      projectCatalog: { name: projectName, status: '未分类' },
    },
  });
  run('delete', { name: projectName });

  const deleted = run('deleted_projects_list').projects;
  assert.strictEqual(deleted.length, 1);
  assert.strictEqual(deleted[0].name, projectName);
  assert.strictEqual(deleted[0].photoCount, 1);
  assert.strictEqual(deleted[0].recyclePidl, 'test-pidl');

  fs.rmSync(projectPath, { recursive: true });
  const cleanupPlan = run('deleted_project_cleanup_plan', { projectId: deleted[0].id });
  assert.strictEqual(cleanupPlan.name, projectName);
  assert.strictEqual(cleanupPlan.photoIds.length, 1);
  assert.strictEqual(run('deleted_projects_list').projects.length, 1, 'cleanup planning must not purge recoverable database state');
  const purged = run('purge_deleted_project', { projectId: deleted[0].id });
  assert.strictEqual(purged.name, projectName);
  assert.strictEqual(purged.photoIds.length, 1);
  assert.strictEqual(run('deleted_projects_list').projects.length, 0);
  assert.strictEqual(run('undo_record_latest').record, null);

  const permanentProjectName = 'permanent-project';
  const permanentProjectPath = path.join(workspace, permanentProjectName);
  fs.mkdirSync(permanentProjectPath, { recursive: true });
  run('init');
  run('catalog_sync');
  run('undo_record_add', {
    kind: 'project-cleanup',
    payload: {
      items: [{ original: permanentProjectPath, permanent: true }],
      projectCatalog: { name: permanentProjectName, status: '未分类' },
    },
  });
  run('delete', { name: permanentProjectName });
  fs.rmSync(permanentProjectPath, { recursive: true });
  const permanentDeleted = run('deleted_projects_list').projects.find(project => project.name === permanentProjectName);
  assert(permanentDeleted);
  assert.strictEqual(permanentDeleted.permanent, true);
  assert.strictEqual(run('undo_record_latest').record, null, 'cleanup-only records must never appear as user undo operations');
  run('purge_deleted_project', { projectId: permanentDeleted.id });
  assert.strictEqual(run('deleted_projects_list').projects.length, 0);
  process.stdout.write('Deleted project cleanup tests passed.\n');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
