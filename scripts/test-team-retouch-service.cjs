const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { registerComponentProjectCapabilities } = require('../electron/services/component-project-capabilities.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-team-service-'));
const workspace = path.join(sandbox, 'workspace');
const dataRoot = path.join(sandbox, 'workspace-data', 'key');
const projectRoot = path.join(workspace, 'active', 'Project');
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'one.jpg'), 'fixture');

const broker = new ComponentCapabilityBroker();
const bundles = new Map();
registerComponentProjectCapabilities({
  broker,
  ensureWorkspace: value => { assert.equal(value, workspace); return workspace; },
  getWorkspaceDataRoot: () => dataRoot,
  getWorkspaceTeamRetouchDatabasePath: () => path.join(dataRoot, 'databases', 'team-retouch.sqlite3'),
  resolveProjectEntry: (_workspace, status, projectName, relativePath) => path.join(workspace, status, projectName, relativePath),
  versionService: {
    getPhoto: async (_root, photoId) => bundles.get(photoId),
    getMedia: async (_root, request) => ({
      success: true,
      photo: { id: 'photo-1', projectId: 'project-1', currentVersionId: 'version-1', displayName: 'one' },
      versions: [{ id: 'version-1', filePath: request.filePath, isCurrent: true }],
    }),
  },
  IMAGE_EXTENSIONS: new Set(['.jpg']),
  path,
});
const descriptor = { componentId: 'team-retouch', service: { capabilities: ['component.storage.v1', 'project.media.read.v1'] } };
const context = { workspacePath: workspace, projectId: 'project-1', projectName: 'Project', projectStatus: 'active' };
assert.throws(() => broker.invoke(descriptor, 'component.storage.v1', { namespace: 'arbitrary' }, context), /Unknown component storage namespace/);

const child = spawn(process.execPath, [path.join(__dirname, '..', 'extensions', 'team-retouch', 'service.cjs')], {
  env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
let nextRequestId = 1;
const pending = new Map();
const invoke = (method, payload = {}) => new Promise((resolve, reject) => {
  const id = String(nextRequestId++);
  pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload, context: { componentId: 'team-retouch', componentVersion: '1', projectId: 'project-1', projectName: 'Project', projectStatus: 'active' } })}\n`);
});

const ready = new Promise((resolve, reject) => {
  child.once('exit', code => reject(new Error(`service exited ${code}`)));
  lines.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'ready') { resolve(); return; }
    if (frame.type === 'capability') {
      Promise.resolve(broker.invoke(descriptor, frame.method, frame.payload, context)).then(
        result => child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: true, result })}\n`),
        error => child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: false, error: error.message })}\n`),
      );
      return;
    }
    if (frame.type === 'response') {
      const request = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.ok) request.resolve(frame.result); else request.reject(new Error(frame.error));
    }
  });
});

(async () => {
  try {
    await ready;
    const registered = await invoke('team.project.register.v1', { relativePaths: ['one.jpg'], workspacePath: 'C:/escape' });
    assert.equal(registered.success, true);
    const databasePath = path.join(dataRoot, 'databases', 'team-retouch.sqlite3');
    const db = new DatabaseSync(databasePath);
    db.prepare(`INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)`).run('photo-1', 'project-1', 'version-1', 1, 1);
    db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('task-1', 'photo-1', 'version-1', 1, '人物 1', '{}', '{}', 'authorized-patch.png', 1, 1);
    db.close();
    bundles.set('photo-1', {
      success: true,
      photo: { id: 'photo-1', projectId: 'project-1', currentVersionId: 'version-1', displayName: 'one' },
      versions: [{ id: 'version-1', filePath: path.join(projectRoot, 'one.jpg'), isCurrent: true }],
    });
    const snapshot = await invoke('team.project.get.v1');
    assert.equal(snapshot.success, true);
    assert.equal(snapshot.photos[0].photoId, 'photo-1');
    const saved = await invoke('team.identity.save.v1', { name: '人物 A', assignments: [] });
    assert(saved.identityId);
    await invoke('team.identity.assign.v1', { photoId: 'photo-1', baseVersionId: 'version-1', personIndex: 1, identityId: saved.identityId, completed: true });
    assert.equal((await invoke('team.project.get.v1')).assignments[0].identityId, saved.identityId);
    await invoke('team.identity.delete.v1', { identityId: saved.identityId });
    assert.equal((await invoke('team.project.get.v1')).identities.length, 0);
    console.log('Team-retouch component service integration tests passed');
  } finally {
    lines.close();
    child.kill();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
