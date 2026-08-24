const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { registerComponentProjectCapabilities, versionProjectPath } = require('../electron/services/component-project-capabilities.cjs');

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
assert.deepEqual(versionProjectPath({ version: { filePath: path.join(projectRoot, 'missing.jpg'), fileMissing: true }, projectRoot, path, fs }), { relativePath: 'missing.jpg', relativePathState: 'missing' }, 'missing versions retain their safe historical project path');
assert.deepEqual(versionProjectPath({ version: { filePath: path.join(sandbox, 'outside.jpg'), fileMissing: true }, projectRoot, path, fs }), { relativePath: '', relativePathState: 'outside-project' }, 'unmanaged paths outside the bound project are never exposed');
const externalRoot = path.join(sandbox, 'external-media');
assert.deepEqual(versionProjectPath({ version: { filePath: path.join(externalRoot, 'nested', 'linked.jpg'), fileMissing: true }, projectRoot, externalLinks: [{ shortcutVirtualPath: 'RAW.lnk', externalTargetRoot: externalRoot, externalTargetKind: 'folder', offline: false }], path, fs }), { relativePath: 'RAW.lnk/nested/linked.jpg', relativePathState: 'missing' }, 'managed external versions retain only their virtual project path');
fs.mkdirSync(path.join(externalRoot, 'nested'), { recursive: true });
fs.writeFileSync(path.join(externalRoot, 'nested', 'linked.jpg'), 'external');
let externalMappingUsed = false;
const managedExternalPaths = { toVirtualPath: () => { externalMappingUsed = true; return 'RAW.lnk/nested/linked.jpg'; }, resolve: () => ({ physicalPath: path.join(externalRoot, 'nested', 'linked.jpg') }) };
assert.deepEqual(versionProjectPath({ version: { filePath: path.join(externalRoot, 'nested', 'linked.jpg'), fileMissing: false }, projectRoot, projectVirtualPaths: managedExternalPaths, externalLinks: [{ shortcutVirtualPath: 'RAW.lnk', externalTargetRoot: externalRoot, externalTargetKind: 'folder', offline: false }], path, fs }), { relativePath: 'RAW.lnk/nested/linked.jpg', relativePathState: 'external' });
assert(externalMappingUsed, 'online external media paths must use the existing managed virtual-path mapping');

const broker = new ComponentCapabilityBroker();
const bundles = new Map();
const requestedPhotoIds = [];
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
  resolveProjectEntry: (_workspace, status, projectName, relativePath) => path.join(workspace, status, projectName, relativePath),
  versionService: {
    getPhoto: async (_root, photoId) => { requestedPhotoIds.push(photoId); return bundles.get(photoId); },
    getMedia: async (_root, request) => {
      const existing = [...bundles.values()].find(item => (item.versions || []).some(version => path.resolve(version.filePath) === path.resolve(request.filePath)));
      if (existing) return existing;
      const bundle = {
        success: true, relativePath: 'one.jpg',
        photo: { id: 'photo-1', projectId: 'project-1', currentVersionId: 'version-1', displayName: 'one' },
        versions: [{ id: 'version-1', filePath: request.filePath, isCurrent: true }],
      };
      bundles.set('photo-1', bundle);
      return bundle;
    },
    completeTeamIdentity: async (_root, payload) => payload.photoId === 'photo-1' && payload.baseVersionId === 'version-1'
      ? { success: true }
      : Promise.reject(new Error('identity ownership rejected')),
  },
  IMAGE_EXTENSIONS: new Set(['.jpg']),
  path,
  fs,
  crypto: require('crypto'),
  getConfigPath: () => configPath,
  readSavedConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
  getProjectPath: (_root, status, projectName) => path.join(workspace, status, projectName),
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedReturn] }) }, mainWindow: {},
  mediaService: { grantPath: value => value, grantRoot: value => value, authorizeInput: async token => token.replace(/^media-token:/, ''), toUrl: value => `photoflow-media:${path.basename(value)}`, requestThumbnail: async () => ({ success: true, previewUrl: 'photoflow-media:generated-preview' }) },
  shell: { openPath: async () => '' }, backgroundTasks,
  getBoundProject: () => ({ id: 'project-1', name: 'Project', status: 'active' }),
  RAW_EXTENSIONS: new Set(['.dng']), IMAGE_PREVIEW_CONVERSION_EXTENSIONS: new Set(['.heic']),
});
broker.register('component.lifecycle.v1', payload => Object.keys(payload).every(field => ['action', 'repair'].includes(field)) ? { success: true, action: payload.action } : Promise.reject(new Error('lifecycle injection rejected')));
const descriptor = { componentId: 'team-retouch', service: { runtimeActions: [], capabilities: ['component.storage.v1', 'project.media.read.v1', 'project.output.authorize.v1', 'version.register.v1', 'tasks.report.v1', 'dialogs.open.v1', 'project.media.access.v1', 'project.identity.complete.v1', 'component.settings.v1', 'component.lifecycle.v1'] } };
assert.equal(broker.assertCapabilities(descriptor), true, 'every capability declared by the real team service manifest must have a registered broker implementation');
const context = { workspacePath: workspace, projectId: 'project-1', projectName: 'Project', projectStatus: 'active' };
assert.throws(() => broker.invoke(descriptor, 'component.storage.v1', { namespace: 'arbitrary' }, context), /Unknown component storage namespace/);
assert.rejects(() => broker.invoke({ componentId: 'other-component', service: { capabilities: ['component.settings.v1'] } }, 'component.settings.v1', { action: 'get' }, context), /Unknown component settings namespace/);
assert.rejects(() => broker.invoke(descriptor, 'project.output.authorize.v1', { action: 'stage-inputs', tokens: ['C:/arbitrary.jpg'] }, context), /selector tokens/);
assert.rejects(() => broker.invoke(descriptor, 'version.register.v1', { action: 'team-return', photoId: 'other-photo', baseVersionId: 'version-1', taskId: 'task-1', stageId: '12345678', inputName: 'escape.jpg' }, context), /outside the bound project/);

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
      Promise.resolve().then(() => broker.invoke(descriptor, frame.method, frame.payload, context)).then(
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
    const startupStartedAt = Date.now();
    const [emptyStartupSnapshot, startupSettings, startupPreflight] = await Promise.all([
      invoke('team.project.get.v1'), invoke('component.settings.get.v1'), invoke('component.advanced.preflight.v1'),
    ]);
    assert.equal(emptyStartupSnapshot.photos.length, 0);
    assert.deepEqual(startupSettings.settings, { useGpu: false, oversizeCropMode: 'expand' });
    assert.equal(startupPreflight.action, 'advanced.preflight');
    assert(Date.now() - startupStartedAt < 2000, 'project, settings, and preflight startup requests must not serialize into a self-wait');
    const registered = await invoke('team.project.register.v1', { relativePaths: ['one.jpg'], workspacePath: 'C:/escape' });
    assert.equal(registered.success, true);
    assert.equal(registered.photos.length, 1); assert.equal(registered.photos[0].photoId, 'photo-1');
    assert.equal((await invoke('team.project.get.v1')).photos[0].relativePath, 'one.jpg', 'registration must persist immediately and survive a fresh project snapshot');
    assert.equal((await invoke('team.project.register.v1', { relativePaths: ['one.jpg'] })).photos.length, 1, 're-registering the same controlled bundle is idempotent');
    const databasePath = path.join(dataRoot, 'databases', 'team-retouch.sqlite3');
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM team_retouch_photos WHERE project_id=? AND photo_id=?').get('project-1', 'photo-1').count, 1, 'register RPC writes the isolated team domain idempotently');
    db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('task-1', 'photo-1', 'version-1', 1, '人物 1', '{}', '{}', path.join(dataRoot, 'authorized-patch.png'), 1, 1);
    db.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('photo-other', 'project-other', 'version-other', 1, 1);
    const insertTask = db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    insertTask.run('task-other', 'photo-other', 'version-other', 1, '其他项目人物', '{}', '{}', path.join(dataRoot, 'other.png'), 1, 1);
    insertTask.run('task-orphan', 'photo-orphan', 'version-orphan', 1, '旧版孤立人物', '{}', '{}', path.join(dataRoot, 'orphan.png'), 1, 1);
    db.close();
    fs.writeFileSync(path.join(dataRoot, 'authorized-patch.png'), Buffer.alloc(1024 * 1024, 7));
    bundles.set('photo-1', {
      success: true,
      photo: { id: 'photo-1', projectId: 'project-1', currentVersionId: 'version-current', displayName: 'one' },
      versions: [{ id: 'version-1', filePath: path.join(projectRoot, 'one.jpg'), isCurrent: false }, { id: 'version-current', filePath: path.join(projectRoot, 'merged-output.jpg'), fileMissing: true, isCurrent: true }],
    });
    bundles.set('photo-other', { success: true, photo: { id: 'photo-other', projectId: 'project-other', currentVersionId: 'version-other' }, versions: [{ id: 'version-other', filePath: path.join(projectRoot, 'other.jpg') }] });
    bundles.set('photo-orphan', { success: true, photo: { id: 'photo-orphan', projectId: 'project-other', currentVersionId: 'version-orphan' }, versions: [{ id: 'version-orphan', filePath: path.join(projectRoot, 'orphan.jpg') }] });
    requestedPhotoIds.length = 0;
    const snapshot = await invoke('team.project.get.v1');
    assert.equal(snapshot.success, true);
    assert.equal(snapshot.photos[0].photoId, 'photo-1');
    assert.equal(snapshot.photos[0].relativePath, 'one.jpg', 'snapshot paths must follow the registered base version instead of the current merged output');
    assert.equal(snapshot.photos[0].sourcePath, undefined);
    assert.equal(snapshot.photos[0].tasks[0].patchPath, undefined, 'renderer responses must not disclose host media paths');
    assert(requestedPhotoIds.includes('photo-1') && requestedPhotoIds.includes('photo-orphan'), 'the current project and genuinely ownerless legacy tasks must be resolved through the host');
    assert(!requestedPhotoIds.includes('photo-other'), 'registered tasks owned by another project must not expand the current project media query');
    assert(!snapshot.photos.some(photo => photo.photoId === 'photo-orphan' || photo.photoId === 'photo-other'), 'host-filtered orphan or foreign tasks must never leak into the snapshot');
    const originalAccess = await invoke('team.media.authorize.v1', { kind: 'original', photoId: 'photo-1', baseVersionId: 'version-1' });
    assert.equal(originalAccess.url, 'photoflow-media:one.jpg');
    assert.equal((await invoke('team.media.authorize.v1', { kind: 'working', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', filePath: 'C:/escape' })).url, 'photoflow-media:authorized-patch.png');
    assert.equal((await invoke('team.patch.open.v1', { photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1' })).success, true);
    const returnedPath = path.join(dataRoot, 'returned-patch.png'); fs.writeFileSync(returnedPath, 'returned');
    const returnedDb = new DatabaseSync(databasePath); returnedDb.prepare('UPDATE team_patch_tasks SET edited_patch_path=?,status=? WHERE id=?').run(returnedPath, 'uploaded', 'task-1'); returnedDb.close();
    assert.equal((await invoke('team.media.authorize.v1', { kind: 'returned', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1' })).url, 'photoflow-media:returned-patch.png');
    const returnedAuthorizations = await Promise.all(Array.from({ length: 141 }, () => invoke('team.media.authorize.v1', { kind: 'returned', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1' })));
    assert.equal(returnedAuthorizations.filter(result => result.url === 'photoflow-media:returned-patch.png').length, 141, 'returned media authorization remains stable for production assignment fan-out');
    const reviewDirectory = path.join(dataRoot, 'team-retouch', 'workflow-return-reviews', require('crypto').createHash('sha256').update('Project').digest('hex'));
    fs.mkdirSync(reviewDirectory, { recursive: true }); const reviewPath = path.join(reviewDirectory, 'return-1.jpg'); fs.writeFileSync(reviewPath, 'review');
    fs.writeFileSync(path.join(reviewDirectory, 'session.json'), JSON.stringify({ id: 'review-session', projectName: 'Project', result: { matches: [{ returnId: 'return-1', path: reviewPath }] } }));
    assert.equal((await invoke('team.media.authorize.v1', { kind: 'review-return', reviewSessionId: 'review-session', returnId: 'return-1' })).url, 'photoflow-media:return-1.jpg');
    fs.rmSync(reviewDirectory, { recursive: true, force: true });
    const resetReturnedDb = new DatabaseSync(databasePath); resetReturnedDb.prepare('UPDATE team_patch_tasks SET edited_patch_path=NULL,status=? WHERE id=?').run('exported', 'task-1'); resetReturnedDb.close();
    const rawPath = path.join(projectRoot, 'camera.dng'); fs.writeFileSync(rawPath, 'raw');
    bundles.set('photo-raw', { success: true, photo: { id: 'photo-raw', projectId: 'project-1', currentVersionId: 'version-raw' }, versions: [{ id: 'version-raw', filePath: rawPath, isCurrent: true }] });
    const rawAccess = await invoke('team.media.authorize.v1', { kind: 'original', photoId: 'photo-raw', baseVersionId: 'version-raw' });
    assert.deepEqual({ url: rawAccess.url, previewUrl: rawAccess.previewUrl, originalUrl: rawAccess.originalUrl }, { url: 'photoflow-media:generated-preview', previewUrl: 'photoflow-media:generated-preview', originalUrl: 'photoflow-media:camera.dng' }, 'RAW originals use a generated display preview while retaining a distinct original URL');
    await assert.rejects(invoke('team.patch.open.v1', { photoId: 'photo-other', baseVersionId: 'version-other', taskId: 'task-other' }), /outside the bound project/, 'cross-project photo IDs must fail through the real service process');
    await assert.rejects(invoke('team.media.authorize.v1', { kind: 'working', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-other' }), /outside the bound photo version/, 'a task from another photo must not authorize media');
    await assert.rejects(invoke('team.identity.complete.v1', { photoId: 'photo-1', baseVersionId: 'other-version', personIndex: 1 }), /outside the bound photo/, 'cross-version completion must fail through the real service process');
    assert.equal((await invoke('component.advanced.preflight.v1')).action, 'advanced.preflight');
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

    const scaleDb = new DatabaseSync(databasePath);
    const insertPhoto = scaleDb.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)');
    const insertScaleTask = scaleDb.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (let index = 2; index <= 27; index += 1) {
      const photoId = `photo-${index}`; const versionId = `version-${index}`;
      insertPhoto.run(photoId, 'project-1', versionId, index, index);
      const photoPath = path.join(projectRoot, `${photoId}.jpg`); fs.writeFileSync(photoPath, 'photo');
      bundles.set(photoId, { success: true, photo: { id: photoId, projectId: 'project-1', currentVersionId: versionId, displayName: photoId }, versions: [{ id: versionId, filePath: photoPath }] });
    }
    for (let index = 2; index <= 79; index += 1) {
      const photoNumber = 2 + ((index - 2) % 26); const photoId = `photo-${photoNumber}`; const versionId = `version-${photoNumber}`;
      const patchPath = path.join(dataRoot, `current-${index}.png`); fs.writeFileSync(patchPath, 'patch');
      insertScaleTask.run(`task-current-${index}`, photoId, versionId, index, `人物 ${index}`, '{}', '{}', patchPath, index, index);
    }
    for (let index = 2; index <= 57; index += 1) insertPhoto.run(`photo-other-${index}`, 'project-other', `version-other-${index}`, index, index);
    for (let index = 2; index <= 163; index += 1) {
      const photoNumber = 2 + ((index - 2) % 56);
      insertScaleTask.run(`task-other-${index}`, `photo-other-${photoNumber}`, `version-other-${photoNumber}`, index, `其他人物 ${index}`, '{}', '{}', path.join(dataRoot, `other-${index}.png`), index, index);
    }
    scaleDb.close();
    requestedPhotoIds.length = 0;
    const scaleStartedAt = Date.now();
    const scaledSnapshot = await invoke('team.project.get.v1');
    const scaleElapsedMs = Date.now() - scaleStartedAt;
    const scaleBytes = Buffer.byteLength(JSON.stringify(scaledSnapshot));
    const snapshotMediaReadCount = requestedPhotoIds.length;
    assert.equal(scaledSnapshot.photos.length, 27, 'a production-sized snapshot returns only the bound project photos');
    assert.equal(new Set(scaledSnapshot.photos.map(photo => photo.relativePath)).size, 27, 'every registered photo keeps one unique project-relative base path');
    assert(scaledSnapshot.photos.every(photo => photo.relativePath && !path.isAbsolute(photo.relativePath) && !photo.relativePath.split(/[\\/]/).includes('..')), 'all snapshot paths remain non-empty and inside the project namespace');
    const originalAuthorizations = await Promise.all(scaledSnapshot.photos.map(photo => invoke('team.media.authorize.v1', { kind: 'original', photoId: photo.photoId, baseVersionId: photo.baseVersionId })));
    assert.equal(originalAuthorizations.filter(result => result.url).length, 27, 'all production-sized original previews receive a loadable URL');
    const workingRequests = scaledSnapshot.photos.flatMap(photo => photo.tasks.map(task => ({ kind: 'working', photoId: photo.photoId, baseVersionId: photo.baseVersionId, taskId: task.id })));
    const workingAuthorizations = await Promise.all(workingRequests.map(request => invoke('team.media.authorize.v1', request)));
    assert.equal(workingAuthorizations.filter(result => result.url).length, 79, 'all production-sized working previews receive a loadable URL');
    assert.equal(scaledSnapshot.photos.reduce((total, photo) => total + photo.tasks.length, 0), 79, 'a production-sized snapshot retains all bound project tasks');
    assert(snapshotMediaReadCount <= 28, `84 registered photos plus one legacy orphan must require at most 28 snapshot media reads, received ${snapshotMediaReadCount}`);
    assert(scaleBytes < 2 * 1024 * 1024, `the production-sized snapshot must fit one bounded protocol frame, received ${scaleBytes} bytes`);
    assert(scaleElapsedMs < 5000, `the production-sized snapshot should not approach the 60s RPC timeout, took ${scaleElapsedMs}ms`);
    const patchBundles = await Promise.all(scaledSnapshot.photos.map(photo => invoke('team.patch.get.v1', { relativePath: photo.relativePath })));
    assert(patchBundles.every(bundle => bundle.success !== false), 'every restored project path must resolve through team.patch.get.v1');
    assert.equal(patchBundles.reduce((total, bundle) => total + bundle.tasks.length, 0), 79, 'restored project paths must associate all existing tasks with their registered photos');
    console.log(`Production-sized team snapshot: ${scaledSnapshot.photos.length} photos / ${scaledSnapshot.photos.reduce((total, photo) => total + photo.tasks.length, 0)} tasks / ${snapshotMediaReadCount} snapshot media reads / ${scaleBytes} bytes / ${scaleElapsedMs}ms`);
    const assignmentReturnedPath = path.join(dataRoot, 'assignment-returned.png'); fs.writeFileSync(assignmentReturnedPath, 'assignment-returned');
    const assignmentReturnedDb = new DatabaseSync(databasePath); assignmentReturnedDb.prepare('UPDATE team_person_assignments SET edited_patch_path=?,completed=1,completion_kind=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').run(assignmentReturnedPath, 'returned', 'project-1', 'photo-1', 'version-1', 1); assignmentReturnedDb.close();
    assert.equal((await invoke('team.media.authorize.v1', { kind: 'returned', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1 })).url, 'photoflow-media:assignment-returned.png', 'person-scoped returned references resolve the assignment artifact instead of the shared task return');
    await invoke('team.identity.delete.v1', { identityId: saved.identityId });
    assert.equal((await invoke('team.project.get.v1')).identities.length, 0);
    console.log('Team-retouch component service integration tests passed');
  } finally {
    lines.close();
    child.kill();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
