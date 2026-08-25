const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { registerComponentProjectCapabilities } = require('../electron/services/component-project-capabilities.cjs');
const { capabilityError, ensureSchema, migrationErrorState } = require('../extensions/team-retouch/service.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-v2-migration-'));
const workspace = path.join(sandbox, 'workspace'); const dataRoot = path.join(workspace, '.data');
const projectRoot = path.join(workspace, 'active', 'Project'); const basePath = path.join(projectRoot, '图片后期_1', '618A8206.jpg');
const legacyRoot = path.join(dataRoot, 'team-retouch'); const legacyDatabase = path.join(dataRoot, 'databases', 'team-retouch.sqlite3');
const legacyPrivatePatch = path.join(legacyRoot, 'photo-1', 'version-1', 'delivery', 'one_人物01.png');
const legacyProjectReturn = path.join(projectRoot, 'raw', '618A8206_裁切', '618A8206_人物01.png');
const additionalLegacyOutputs = Array.from({ length: 74 }, (_, index) => path.join(projectRoot, 'raw', `618A8206_${String(index + 2).padStart(2, '0')}_裁切`, `618A8206_人物${String(index + 2).padStart(2, '0')}.png`));
const legacyWorkflowFile = path.join(projectRoot, '团片协作', '第1周', '人物 A', 'one_人物1.png');
for (const file of [basePath, legacyPrivatePatch, legacyProjectReturn, legacyWorkflowFile, ...additionalLegacyOutputs]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, path.basename(file)); }
const bulkLegacyDirectory = path.join(legacyRoot, 'bulk'); fs.mkdirSync(bulkLegacyDirectory, { recursive: true });
for (let index = 0; index < 2400; index += 1) fs.writeFileSync(path.join(bulkLegacyDirectory, `${index}.mock`), 'x');
fs.mkdirSync(path.dirname(legacyDatabase), { recursive: true });
const seeded = ensureSchema(legacyDatabase); const now = Date.now();
seeded.prepare('INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('photo-1', 'project-1', 'version-1', now, now);
seeded.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,edited_patch_path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('task-1', 'photo-1', 'version-1', 1, '人物 1', '{}', '{}', legacyPrivatePatch, legacyProjectReturn, 'uploaded', now, now);
const insertLegacyTask = seeded.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
for (const [index, outputPath] of additionalLegacyOutputs.entries()) insertLegacyTask.run(`task-extra-${index + 2}`, 'photo-1', 'version-1', index + 2, `人物 ${index + 2}`, '{}', '{}', outputPath, 'detected', now, now);
seeded.prepare(`INSERT INTO team_person_identities(id,project_id,name,created_at,updated_at) VALUES(?,?,?,?,?)`).run('identity-1', 'project-1', '人物 A', now, now);
seeded.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,completion_kind,edited_patch_path,completed_at,updated_at,task_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('project-1', 'photo-1', 'version-1', 1, 'identity-1', 1, 'manual', 1, 'returned', legacyProjectReturn, now, now, 'task-1');
seeded.close();
const oldManifestKey = crypto.createHash('sha256').update('active\0Project').digest('hex');
fs.mkdirSync(path.join(legacyRoot, 'workflows'), { recursive: true });
fs.writeFileSync(path.join(legacyRoot, 'workflows', `${oldManifestKey}.json`), JSON.stringify({ version: 2, projectName: 'Project', status: 'active', groups: [{ week: 1, identityId: 'identity-1', items: [{ taskId: 'task-1', photoId: 'photo-1', baseVersionId: 'version-1', personIndex: 1, relativePath: '第1周/人物 A/one_人物1.png', available: true }] }] }));
const oldReviewDirectory = path.join(legacyRoot, 'workflow-return-reviews', crypto.createHash('sha256').update('Project').digest('hex')); const oldReviewFile = path.join(oldReviewDirectory, 'return-1.png');
fs.mkdirSync(oldReviewDirectory, { recursive: true }); fs.writeFileSync(oldReviewFile, 'review-return'); fs.writeFileSync(path.join(oldReviewDirectory, 'session.json'), JSON.stringify({ version: 1, id: 'review-1', projectName: 'Project', status: 'active', result: { matches: [{ returnId: 'return-1', path: oldReviewFile, accepted: false }] } }));

const bundle = { photo: { id: 'photo-1', projectId: 'project-1', currentVersionId: 'version-1', displayName: '618A8206', originalName: '618A8206.jpg' }, versions: [{ id: 'version-1', filePath: basePath, relativePath: '图片后期_1/618A8206.jpg', isCurrent: true }] };
const broker = new ComponentCapabilityBroker();
let releaseAdoption; const adoptionGate = new Promise(resolve => { releaseAdoption = resolve; });
const taskHandles = new Map();
const backgroundTasks = { create(definition) { const task = { ...definition, state: 'running', metadata: definition.metadata || {} }; const handle = { task, context: { signal: { aborted: false }, report() {}, saveCheckpoint() {} }, waitForStart: async () => undefined, isFinished: () => false, complete: message => { task.state = 'completed'; task.message = message; }, fail: error => { task.state = 'failed'; task.error = error.message; }, snapshot: () => task }; taskHandles.set(task.id, handle); return handle; }, get: id => taskHandles.get(id)?.snapshot() || null, cancel: () => true, list: () => [...taskHandles.values()].map(item => item.snapshot()) };
registerComponentProjectCapabilities({
  broker, ensureWorkspace: value => value, getWorkspaceDataRoot: () => dataRoot,
  resolveProjectEntry: (_workspace, status, name, relativePath) => path.join(workspace, status, name, relativePath),
  versionService: { getPhoto: async (_root, photoId) => photoId === 'photo-1' ? bundle : null, getMedia: async () => bundle, listProgress: async () => ({ progressFolders: [{ id: 'progress-original', mediaKind: 'image', nodeRole: 'original', folderPath: projectRoot }], edges: [] }) },
  IMAGE_EXTENSIONS: new Set(['.jpg', '.png']), path, fs, crypto, getConfigPath: () => path.join(sandbox, 'config.json'), readSavedConfig: () => ({}),
  getProjectPath: (_root, status, name) => path.join(workspace, status, name), dialog: {}, mainWindow: {}, shell: { openPath: async () => '', showItemInFolder() {} },
  mediaService: { grantPath() {}, grantRoot() {}, toUrl: file => `photoflow-media:${path.basename(file)}`, requestThumbnail: async request => ({ previewUrl: `photoflow-media:preview-${path.basename(request.filePath)}` }) },
  backgroundTasks, getBoundProject: () => ({ id: 'project-1', name: 'Project', status: 'active' }), adoptionInteractiveBudgetMs: 0,
  adoptionFaultInjector: phase => phase === 'before-journal' ? adoptionGate : undefined,
});
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extensions', 'team-retouch', 'component.template.json'), 'utf8'));
const descriptor = { componentId: 'team-retouch', componentVersion: manifest.version, contractVersion: 2, hostApiVersion: 3, migrations: manifest.componentHost.migrations, service: manifest.componentHost.service };
broker.register('component.lifecycle.v2', () => ({ apiVersion: 2, success: true, action: 'preflight', taskId: 'test', message: 'ok' }));
assert.equal(broker.assertCapabilities(descriptor), true);
const context = { workspacePath: workspace, projectId: 'project-1', projectName: 'Project', projectStatus: 'active', emitComponentEvent() {} };

const child = spawn(process.execPath, [path.join(__dirname, '..', 'extensions', 'team-retouch', 'service.cjs')], { env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity }); const pending = new Map(); let nextId = 1;
const invoke = (method, payload = {}) => new Promise((resolve, reject) => { const id = String(nextId++); pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload, context: { componentId: 'team-retouch', componentVersion: manifest.version, projectId: 'project-1', projectName: 'Project', projectStatus: 'active' } })}\n`); });
const ready = new Promise((resolve, reject) => { child.once('exit', code => reject(new Error(`service exited ${code}`))); lines.on('line', line => { const frame = JSON.parse(line); if (frame.type === 'ready') return resolve(); if (frame.type === 'capability') { assert(frame.method.endsWith('.v2') && descriptor.service.capabilities.includes(frame.method)); Promise.resolve(broker.invoke(descriptor, frame.method, frame.payload, context)).then(result => child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: true, result })}\n`), error => child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: false, error: error.message })}\n`)); return; } if (frame.type === 'response') { const request = pending.get(frame.id); pending.delete(frame.id); frame.ok ? request.resolve(frame.result) : request.reject(new Error(frame.error)); } }); });

(async () => {
  try {
    for (const [code, category] of [['COMPONENT_HOST_NOT_FOUND', 'legacy-output-missing'], ['COMPONENT_HOST_CONFLICT', 'legacy-output-conflict'], ['COMPONENT_HOST_PERMISSION_DENIED', 'legacy-output-boundary']]) {
      const restored = capabilityError({ error: 'C:\\private\\secret.png', errorCode: code, retryable: true }); assert.equal(restored.code, code); assert.equal(restored.retryable, true);
      const diagnostic = migrationErrorState(restored);
      assert.equal(diagnostic.errorCategory, category); assert(!diagnostic.lastError.includes('private') && !diagnostic.lastError.includes('secret'), `${category} diagnostic must not leak source paths`);
    }
    await ready; const startedAt = Date.now(); const firstSnapshot = await invoke('team.project.get.v1'); const firstSnapshotElapsedMs = Date.now() - startedAt;
    assert(firstSnapshotElapsedMs < 2000, 'first unadopted historical snapshot must return migration state within the interactive latency budget');
    assert.equal(firstSnapshot.migration.phase, 'host-storage-adoption', 'large first adoption runs outside the ordinary project.get request');
    await assert.rejects(invoke('team.project.register.v1', { relativePaths: ['one.jpg'] }), /首次安全迁移/, 'mutations fail closed while Host storage adoption is pending');
    await assert.rejects(invoke('team.patch.detect.v1', { photoId: 'photo-1', baseVersionId: 'version-1' }), /首次安全迁移/, 'detect cannot write private artifacts while Host storage adoption is pending');
    assert.equal(fs.existsSync(path.join(dataRoot, 'components', 'team-retouch', 'storage.sqlite3')), false, 'pending mutations never create or write the V2 component root');
    releaseAdoption();
    let snapshot = firstSnapshot;
    for (let attempt = 0; snapshot.migration.phase === 'host-storage-adoption' && attempt < 300; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 100)); snapshot = await invoke('team.project.get.v1'); }
    assert.equal(snapshot.photos[0]?.photoId, 'photo-1', JSON.stringify(snapshot));
    assert.equal(snapshot.migration.state, 'pending'); assert(snapshot.migration.pendingCount >= 1, 'snapshot exposes recoverable output migration state');
    assert(fs.existsSync(legacyRoot) && fs.existsSync(legacyPrivatePatch), 'Host adoption retains the legacy source for rollback');
    const concurrentSteps = await Promise.all(Array.from({ length: 3 }, () => invoke('team.project.migrate-step.v1')));
    assert(concurrentSteps.every(item => item.processedCount === concurrentSteps[0].processedCount), 'concurrent migration requests share one checkpoint operation');
    let migration = concurrentSteps[0]; let steps = 0;
    while (migration.state !== 'committed' && steps++ < 100) migration = await invoke('team.project.migrate-step.v1');
    assert.equal(migration.state, 'committed', 'all 75 project outputs eventually migrate and commit idempotently');
    assert.equal((await invoke('team.project.migrate-step.v1')).state, 'committed', 'completed migration remains idempotent');
    const storage = await broker.invoke(descriptor, 'component.storage.v2', {}, context); const migrated = new DatabaseSync(storage.databasePath);
    const task = migrated.prepare("SELECT patch_path,edited_patch_path FROM team_patch_tasks WHERE id='task-1'").get(); const assignment = migrated.prepare("SELECT edited_patch_path FROM team_person_assignments WHERE photo_id='photo-1'").get();
    for (const value of [task.patch_path, task.edited_patch_path, assignment.edited_patch_path]) { assert(value.startsWith(storage.dataPath)); assert(!value.startsWith(legacyRoot)); assert(fs.existsSync(value)); }
    assert.equal(migrated.prepare(`SELECT COUNT(*) count FROM team_patch_tasks WHERE (patch_path IS NOT NULL AND patch_path NOT LIKE ?) OR (edited_patch_path IS NOT NULL AND edited_patch_path NOT LIKE ?)`).get(`${storage.dataPath}%`, `${storage.dataPath}%`).count, 0, 'all 75 legacy project output references checkpoint into component-private materializations');
    migrated.close();
    fs.renameSync(legacyRoot, `${legacyRoot}.removed`); fs.renameSync(legacyProjectReturn, `${legacyProjectReturn}.removed`);
    assert((await invoke('team.media.authorize.v1', { kind: 'working', variant: 'preview', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1' })).url);
    assert((await invoke('team.media.authorize.v1', { kind: 'returned', variant: 'preview', photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1 })).url);
    assert((await invoke('team.workflow.return-review.get.v1')).review, 'legacy review session remains readable after V2 adoption');
    assert((await invoke('team.media.authorize.v1', { kind: 'review-return', variant: 'preview', reviewSessionId: 'review-1', returnId: 'return-1' })).url, 'legacy review media is served only from adopted private storage');
    await invoke('team.identity.complete.v1', { photoId: 'photo-1', baseVersionId: 'version-1', taskId: 'task-1', personIndex: 1, completed: false });
    assert(fs.existsSync(path.join(projectRoot, '团片协作', '第1周', '人物 A', 'one_人物1.png')), 'reconcile republishes the relay file through V2 output ownership');
    console.log(`Team-retouch V1 storage/output to Host V2 migration regression passed; first 2400-file unadopted snapshot ${firstSnapshotElapsedMs}ms`);
  } finally { lines.close(); const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; fs.rmSync(sandbox, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
