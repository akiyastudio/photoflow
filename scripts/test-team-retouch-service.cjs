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
const configPath = path.join(sandbox, 'config.json');
const selectedReturn = path.join(sandbox, 'selected-return.jpg');
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'one.jpg'), 'fixture');
fs.writeFileSync(configPath, JSON.stringify({ personDetection: { useGpu: false, oversizeCropMode: 'expand' } }));
fs.writeFileSync(selectedReturn, 'returned');

const broker = new ComponentCapabilityBroker();
const bundles = new Map();
const taskHandles = new Map();
const backgroundTasks = {
  create(definition) {
    const task = { ...definition, state: 'queued', progress: 0, metadata: definition.metadata || {} };
    const handle = {
      task, finished: false,
      context: { signal: { aborted: false }, report(progress, message, metadata) { Object.assign(task, { progress, message, metadata: { ...task.metadata, ...metadata } }); }, saveCheckpoint() {} },
      async waitForStart() { task.state = 'running'; }, isFinished() { return this.finished; },
      complete(message) { this.finished = true; Object.assign(task, { state: 'completed', progress: 100, message }); },
      fail(error) { this.finished = true; Object.assign(task, { state: 'failed', error: error.message }); }, snapshot() { return { ...task }; },
    };
    taskHandles.set(task.id, handle); return handle;
  },
  cancel(id) { const handle = taskHandles.get(id); if (!handle) return false; handle.context.signal.aborted = true; return true; },
  get(id) { return taskHandles.get(id)?.snapshot() || null; }, list() { return [...taskHandles.values()].map(handle => handle.snapshot()); },
};
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
    listTeamPatches: async () => ({ tasks: [{ id: 'task-1', photoId: 'photo-1', baseVersionId: 'version-1', personIndex: 1, patchPath: path.join(dataRoot, 'authorized-patch.png') }] }),
    updateTeamPatch: async () => ({ success: true }),
  },
  IMAGE_EXTENSIONS: new Set(['.jpg']),
  path,
  fs,
  crypto: require('crypto'),
  getConfigPath: () => configPath,
  readSavedConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
  getProjectPath: (_root, status, projectName) => path.join(workspace, status, projectName),
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedReturn] }) }, mainWindow: {},
  mediaService: { grantPath: value => value, authorizeInput: async token => token.replace(/^media-token:/, '') },
  shell: { openPath: async () => '' }, backgroundTasks,
});
const descriptor = { componentId: 'team-retouch', service: { capabilities: ['component.storage.v1', 'project.media.read.v1', 'project.output.authorize.v1', 'version.register.v1', 'tasks.report.v1', 'dialogs.open.v1', 'component.settings.v1'] } };
const context = { workspacePath: workspace, projectId: 'project-1', projectName: 'Project', projectStatus: 'active' };
assert.throws(() => broker.invoke(descriptor, 'component.storage.v1', { namespace: 'arbitrary' }, context), /Unknown component storage namespace/);
assert.rejects(() => broker.invoke({ componentId: 'other-component', service: { capabilities: ['component.settings.v1'] } }, 'component.settings.v1', { action: 'get' }, context), /Unknown component settings namespace/);
assert.rejects(() => broker.invoke(descriptor, 'project.output.authorize.v1', { action: 'stage-inputs', tokens: ['C:/arbitrary.jpg'] }, context), /selector tokens/);
assert.rejects(() => broker.invoke(descriptor, 'version.register.v1', { action: 'team-return', photoId: 'other-photo', baseVersionId: 'version-1', taskId: 'task-1', stageId: '12345678', inputName: 'escape.jpg' }, context), /bound project/);

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
    db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('task-1', 'photo-1', 'version-1', 1, '人物 1', '{}', '{}', path.join(dataRoot, 'authorized-patch.png'), 1, 1);
    db.close();
    fs.writeFileSync(path.join(dataRoot, 'authorized-patch.png'), Buffer.alloc(1024 * 1024, 7));
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
    await invoke('team.identity.assign.v1', { photoId: 'photo-1', baseVersionId: 'version-1', personIndex: 1, identityId: saved.identityId, completed: false });
    assert.equal((await invoke('team.project.get.v1')).assignments[0].identityId, saved.identityId);
    const workflowSettings = await invoke('team.workflow.settings.save.v1', { preferredIdentityOrder: [saved.identityId], sameWeekIdentityIds: [] });
    assert.deepEqual(workflowSettings.workflowSettings.preferredIdentityOrder, [saved.identityId]);
    const similarityDirectory = path.join(dataRoot, 'team-retouch', 'identity-similarities');
    fs.mkdirSync(similarityDirectory, { recursive: true });
    fs.writeFileSync(path.join(similarityDirectory, `${require('crypto').createHash('sha256').update('Project').digest('hex')}.json`), JSON.stringify({ similarities: [{ left: 'a', right: 'b', score: .8 }] }));
    assert.equal((await invoke('team.identity.similarities.v1')).similarities[0].score, .8);
    assert.deepEqual((await invoke('component.settings.get.v1')).settings, { useGpu: false, oversizeCropMode: 'expand' });
    assert.deepEqual((await invoke('component.settings.update.v1', { useGpu: true, oversizeCropMode: 'face-centered' })).settings, { useGpu: true, oversizeCropMode: 'face-centered' });
    const generated = await invoke('team.workflow.generate.v1', { operationId: 'workflow-real-process', replace: true, preferredIdentityOrder: [saved.identityId], groups: [{ week: 1, identityId: saved.identityId, identityName: '人物 A', items: [{ photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1, photoName: 'one' }] }] });
    assert.equal(generated.success, true, `a real supervised-style service process must generate workflow files: ${generated.error || ''}`);
    assert.equal(fs.existsSync(path.join(projectRoot, '团片协作', '第1周', '人物 A', 'one_人物1.png')), true);
    assert.equal((await invoke('team.workflow.status.v1')).job.state, 'completed');
    assert.equal((await invoke('team.workflow.cancel.v1', { operationId: 'missing-operation' })).cancelled, false);
    const workflowDirectory = path.join(projectRoot, '团片协作');
    const rollbackMarker = path.join(workflowDirectory, 'pre-replacement.marker');
    fs.writeFileSync(rollbackMarker, 'preserve-on-crash');
    const workflowDataDirectory = path.join(dataRoot, 'team-retouch', 'workflows');
    fs.rmSync(workflowDataDirectory, { recursive: true, force: true });
    fs.writeFileSync(workflowDataDirectory, 'simulate manifest-store crash');
    const rolledBack = await invoke('team.workflow.generate.v1', { operationId: 'workflow-rollback', replace: true, preferredIdentityOrder: [saved.identityId], groups: [{ week: 1, identityId: saved.identityId, identityName: '人物 A', items: [{ photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1, photoName: 'one' }] }] });
    assert.equal(rolledBack.success, false, 'a manifest-store crash must fail the replacement transaction');
    assert.equal(fs.readFileSync(rollbackMarker, 'utf8'), 'preserve-on-crash', 'a failed commit must restore the previous workflow directory');
    fs.rmSync(workflowDataDirectory, { force: true });
    fs.mkdirSync(workflowDataDirectory, { recursive: true });
    const selected = await invoke('team.patch.select-returns.v1');
    assert.equal(selected.files[0].startsWith('media-token:'), true, 'the selector must return authorization tokens instead of paths');
    const migratedArtifacts = await invoke('team.workflow.artifact.migrate.v1', { from: { status: 'active', projectName: 'Project' }, to: { status: 'active', projectName: 'Project Renamed' } });
    assert.equal(migratedArtifacts.some(item => item.state === 'migrated'), true, 'artifact identity migration must execute inside the real component service process');
    await invoke('team.identity.delete.v1', { identityId: saved.identityId });
    assert.equal((await invoke('team.project.get.v1')).identities.length, 0);
    console.log('Team-retouch component service integration tests passed');
  } finally {
    lines.close();
    child.kill();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
