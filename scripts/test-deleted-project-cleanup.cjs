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

try {
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'photo.jpg'), Buffer.from('test-image'));
  run('init');
  run('media_sync_project', { projectName });
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
  const purged = run('purge_deleted_project', { projectId: deleted[0].id });
  assert.strictEqual(purged.name, projectName);
  assert.strictEqual(purged.photoIds.length, 1);
  assert.strictEqual(run('deleted_projects_list').projects.length, 0);
  assert.strictEqual(run('undo_record_latest').record, null);
  process.stdout.write('Deleted project cleanup tests passed.\n');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
