const assert = require('assert');
// Plugin-owned regression test.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'service.cjs'), 'utf8');
assert(/strategyVersion:\s*3\b/.test(serviceSource), 'pixel-changing merge updates must advance the durable merge strategy version');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-team-mutations-'));
const dataRoot = path.join(sandbox, 'data', 'team-retouch');
const databasePath = path.join(sandbox, 'data', 'databases', 'team-retouch.sqlite3');
const deliveryDirectory = path.join(sandbox, 'delivery');
const analysisDirectory = path.join(dataRoot, 'photo-1', 'version-1', 'analysis');
const basePath = path.join(sandbox, 'base.jpg');
const failingBasePath = path.join(sandbox, 'fail.jpg');
const secondBasePath = path.join(sandbox, 'second.jpg');
const enginePath = path.join(sandbox, 'fake-engine.cjs');
const batchCountPath = path.join(sandbox, 'batch-count.txt');
const returnedInputPath = path.join(sandbox, 'returned-input.png');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.writeFileSync(basePath, 'base');
fs.writeFileSync(failingBasePath, 'base');
fs.writeFileSync(secondBasePath, 'base');
fs.writeFileSync(returnedInputPath, 'returned');
fs.writeFileSync(enginePath, `
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1];
if (args[0] === 'match-batch') { const manifest = JSON.parse(fs.readFileSync(value('--manifest'), 'utf8')); const returned = manifest.returned[0]; const candidate = manifest.candidates[0]; console.log(JSON.stringify({ type: 'progress', progress: 12, message: '读取返图 1/1' })); console.log(JSON.stringify({ type: 'progress', progress: 67, message: '比对图片 1/1' })); console.log(JSON.stringify({ matches: [{ ...returned, ...candidate, confidence: 'high', matchConfidence: 'high', editEvidence: { reallyModified: true }, returnWarnings: [] }] })); process.exit(0); }
if (args[0] === 'merge') { fs.mkdirSync(path.dirname(value('--output')), { recursive: true }); fs.writeFileSync(value('--output'), 'merged'); console.log(JSON.stringify({ mergedCount: 1, conflictPixels: 0, seamScore: 1, width: 100, height: 100, metrics: [] })); process.exit(0); }
if (args[0] === 'restore') { const manifest = JSON.parse(fs.readFileSync(value('--manifest'), 'utf8')); const outputs = manifest.tasks.map(task => { fs.mkdirSync(path.dirname(task.patchPath), { recursive: true }); fs.writeFileSync(task.patchPath, 'recropped-large-source'); return { id: task.id, width: 6000, height: 6000, digest: require('crypto').createHash('sha256').update(fs.readFileSync(task.patchPath)).digest('hex') }; }); console.log(JSON.stringify({ outputs })); process.exit(0); }
if (args[0] === 'identify') { const manifest = JSON.parse(fs.readFileSync(value('--manifest'), 'utf8')); console.log(JSON.stringify({ clusters: [], similarities: [], unmatchedCount: manifest.subjects.length, method: 'fixture' })); process.exit(0); }
if (args[0] === 'detect-batch') {
  console.log(JSON.stringify({ type: 'progress', progress: 35, message: 'batch-progress' }));
  const countPath = ${JSON.stringify(batchCountPath)};
  fs.writeFileSync(countPath, String(Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0) + 1));
  const manifest = JSON.parse(fs.readFileSync(value('--manifest'), 'utf8'));
  const results = manifest.items.map((item, index) => {
    const target = path.join(item.deliveryDir, item.deliveryPrefix + '_人物01.png');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'patch');
    return { success: true, key: item.key, detector: 'fake-batch', personCount: 1, tasks: [{ id: 'batch-task-' + index, personIndex: 1, members: [{ personIndex: 1, bbox: { x: 1, y: 1, width: 10, height: 10 } }], bbox: { x: 1, y: 1, width: 10, height: 10 }, crop: { x: 0, y: 0, width: 20, height: 20 }, patchPath: target, generation: { version: 2, sourceWidth: 20, sourceHeight: 20, workWidth: 20, workHeight: 20 } }] };
  });
  console.log(JSON.stringify({ success: true, results, persistentBackend: true, requestedMode: 'auto' })); process.exit(0);
}
if (args[0] !== 'detect') process.exit(3);
console.log(JSON.stringify({ type: 'progress', progress: 25, message: 'detect-progress' }));
const target = path.join(value('--delivery-dir'), value('--delivery-prefix') + '_人物01.png');
fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'patch');
if (value('--input').includes('fail')) process.exit(9);
console.log(JSON.stringify({ detector: 'fake-child', personCount: 1, tasks: [{ id: 'task-1', personIndex: 1, members: [{ personIndex: 1, bbox: { x: 1, y: 1, width: 10, height: 10 } }], bbox: { x: 1, y: 1, width: 10, height: 10 }, crop: { x: 0, y: 0, width: 20, height: 20 }, patchPath: target, generation: { version: 2, sourceWidth: 20, sourceHeight: 20, workWidth: 20, workHeight: 20 } }] }));
`);

let currentBasePath = basePath;
let materializeCount = 0;
const emittedTopics = new Set();
const emittedEvents = [];
const outputStages = new Map(); const outputReceipts = new Map(); const outputByIdempotencyKey = new Map(); const versionsByIdempotencyKey = new Map(); const projectOutputRoot = path.join(sandbox, 'project-output');
let controlledReplacementWrites = 0;
const child = spawn(process.execPath, [
  path.join(__dirname, '..', 'service.cjs'),
  '--photoflow-algorithm-command', process.execPath,
  '--photoflow-algorithm-arg-prefix', enginePath,
], {
  env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map(); let nextId = 1;
const invoke = (method, payload = {}) => new Promise((resolve, reject) => {
  const id = String(nextId++); pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload, context: { componentId: 'team-retouch', componentVersion: 'test', projectId: 'project-1', projectName: 'Project', projectStatus: 'active' } })}\n`);
});
const ready = new Promise((resolve, reject) => {
  child.once('exit', code => reject(new Error(`service exited ${code}`)));
  lines.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'ready') { resolve(); return; }
    if (frame.type === 'capability') {
      let result;
      let error;
      try {
        if (frame.method === 'component.storage') result = { dataPath: dataRoot, databasePath, projectId: 'project-1', ownership: 'component-private' };
        else if (frame.method === 'component.settings') result = { revision: 1, settings: { useGpu: false, oversizeCropMode: 'expand' } };
        else if (frame.method === 'component.events') { emittedTopics.add(frame.payload.topic); emittedEvents.push(frame.payload); result = { emitted: true }; }
        else if (frame.method === 'tasks') result = { task: null, cancelled: false };
        else if (frame.method === 'dialogs') result = { cancelled: false, inputs: [{ name: path.basename(returnedInputPath), token: `test-input:${returnedInputPath}`, expiresAt: Date.now() + 1000 }] };
        else if (frame.method === 'project.input.tokens') { materializeCount += 1; const source = frame.payload.token.slice('test-input:'.length); const inputId = crypto.randomUUID(); const directory = path.join(dataRoot, 'inputs', inputId); fs.mkdirSync(directory, { recursive: true }); const privatePath = path.join(directory, path.basename(source)); fs.copyFileSync(source, privatePath); result = { inputId, privatePath, byteLength: fs.statSync(privatePath).size }; }
        else if (frame.method === 'project.media.variants') {
          const requested = frame.payload.relativePath;
          let photoId = frame.payload.photoId || (requested === 'two.jpg' ? 'photo-2' : 'photo-1');
          if (!['photo-1', 'photo-2'].includes(photoId)) throw new Error('outside the bound project');
          const versionId = frame.payload.versionId || (photoId === 'photo-2' ? 'version-2' : 'version-1');
          const filePath = requested ? (requested === 'two.jpg' ? secondBasePath : basePath) : currentBasePath;
          result = { mediaRef: { photoId, versionId, relativePath: requested || 'one.jpg' }, metadata: { photoId, versionId, currentVersionId: versionId, displayName: photoId === 'photo-2' ? 'Second' : 'Base', originalName: path.basename(filePath), relativePath: requested || 'one.jpg', isCurrent: true, fileMissing: false }, variants: { original: { url: 'test', byteLength: 4, derived: false } }, input: { token: `test-input:${filePath}`, expiresAt: Date.now() + 1000 } };
        } else if (frame.method === 'project.output') {
          if (frame.payload.action === 'stage') { const stageId = crypto.randomUUID(); const privatePath = path.join(dataRoot, 'stages', stageId); fs.mkdirSync(privatePath, { recursive: true }); outputStages.set(stageId, { privatePath, files: [] }); result = { stageId, privatePath, expiresAt: Date.now() + 60000 }; }
          else if (frame.payload.action === 'write') { if (frame.payload.replace) controlledReplacementWrites += 1; const stage = outputStages.get(frame.payload.stageId); stage.files.push(frame.payload); result = { stageId: frame.payload.stageId, artifactId: crypto.randomUUID(), byteLength: fs.statSync(path.join(stage.privatePath, frame.payload.sourceName)).size }; }
          else if (frame.payload.action === 'validate') result = { stageId: frame.payload.stageId, valid: true, fileCount: outputStages.get(frame.payload.stageId).files.length, totalBytes: 1 };
          else if (frame.payload.action === 'commit') { const replay = outputByIdempotencyKey.get(frame.payload.idempotencyKey); if (replay) result = replay; else { const stage = outputStages.get(frame.payload.stageId); const commitId = crypto.randomUUID(); const outputs = stage.files.map(file => { const filePath = path.join(projectOutputRoot, file.outputRelativePath); fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.copyFileSync(path.join(stage.privatePath, file.sourceName), filePath); return { artifactId: crypto.randomUUID(), relativePath: file.outputRelativePath, filePath, sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }; }); result = { commitId, idempotencyKey: frame.payload.idempotencyKey, outputs }; outputReceipts.set(commitId, result); outputByIdempotencyKey.set(frame.payload.idempotencyKey, result); } }
          else if (frame.payload.action === 'materializeOwned') { const output = outputReceipts.get(frame.payload.commitId).outputs.find(item => item.artifactId === frame.payload.artifactId); const importId = crypto.randomUUID(); const directory = path.join(dataRoot, 'imported-outputs', importId); fs.mkdirSync(directory, { recursive: true }); const privatePath = path.join(directory, path.basename(output.filePath)); fs.copyFileSync(output.filePath, privatePath); result = { importId, privatePath, byteLength: fs.statSync(privatePath).size, sha256: output.sha256, outputRef: { commitId: frame.payload.commitId, artifactId: frame.payload.artifactId } }; }
          else if (frame.payload.action === 'rollback') { const stage = outputStages.get(frame.payload.stageId); if (stage) fs.rmSync(stage.privatePath, { recursive: true, force: true }); outputStages.delete(frame.payload.stageId); result = { stageId: frame.payload.stageId, rolledBack: true }; }
          else throw new Error(`unexpected output action ${frame.payload.action}`);
        } else if (frame.method === 'project.progress') result = { progress: [{ id: 'progress-2', mediaKind: 'image', contentRef: { relativeDirectory: 'merged' } }], edges: [] };
        else if (frame.method === 'version.create') { result = versionsByIdempotencyKey.get(frame.payload.idempotencyKey); if (!result) { result = { versionId: crypto.randomUUID(), result: { success: true, photo: { id: frame.payload.photoId }, versions: [] } }; versionsByIdempotencyKey.set(frame.payload.idempotencyKey, result); } }
        else throw new Error(`unexpected capability ${frame.method}`);
      } catch (value) { error = value; }
      child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: !error, result, error: error?.message })}\n`);
      return;
    }
    if (frame.type === 'response') {
      const request = pending.get(frame.id); pending.delete(frame.id);
      if (frame.ok) request.resolve(frame.result); else request.reject(new Error(frame.error));
    }
  });
});

(async () => {
  try {
    await ready;
    const detected = await invoke('team.patch.detect.v1', { photoId: 'photo-1', baseVersionId: 'version-1' });
    assert.equal(detected.tasks.length, 1, 'real child-process output must commit one patch');
    assert.equal(materializeCount, 1, 'single-photo detection materializes exactly one unique original');
    assert.equal(fs.existsSync(path.join(dataRoot, 'inputs')), true);
    assert.equal(fs.readdirSync(path.join(dataRoot, 'inputs')).length, 0, 'operation-scoped detection inputs are cleaned');
    assert(!JSON.stringify(detected).includes(deliveryDirectory), 'service responses must not disclose authorized host paths');
    let recropDb = new DatabaseSync(databasePath); recropDb.function('team_request_id', () => '');
    recropDb.prepare("UPDATE team_patch_tasks SET generation_json=? WHERE project_id='project-1' AND id='task-1'").run(JSON.stringify({ version: 2, sourceWidth: 10000, sourceHeight: 6000, workWidth: 6000, workHeight: 3600 })); recropDb.close();
    await invoke('team.patch.update.v1', { photoId: 'photo-1', taskId: 'task-1', crop: { x: 500, y: 250, width: 8000, height: 5500 } });
    recropDb = new DatabaseSync(databasePath); const recropGeneration = JSON.parse(recropDb.prepare("SELECT generation_json FROM team_patch_tasks WHERE project_id='project-1' AND id='task-1'").get().generation_json); recropDb.close();
    assert.deepEqual(recropGeneration.sourceCrop, { x: 500, y: 250, width: 8000, height: 5500 }, '>40MP source recrop persists the authoritative source crop');
    assert.deepEqual([recropGeneration.workWidth, recropGeneration.workHeight], [6000, 6000]);
    assert.match(recropGeneration.digest, /^[a-f0-9]{64}$/, '>40MP source recrop persists the generated file digest');
    const savedIdentity = await invoke('team.identity.save.v1', { name: '原子标签', assignments: [{ photoId: 'photo-1', baseVersionId: 'version-1', personIndex: 1 }] });
    let labelDb = new DatabaseSync(databasePath);
    assert.equal(labelDb.prepare("SELECT person_name FROM team_patch_tasks WHERE project_id='project-1' AND id='task-1'").get().person_name, '原子标签', 'identity save updates task labels in the same service transaction');
    labelDb.close();
    await invoke('team.identity.save.v1', { identityId: savedIdentity.identityId, name: '原子标签已改名', assignments: [] });
    labelDb = new DatabaseSync(databasePath);
    assert.equal(labelDb.prepare("SELECT person_name FROM team_patch_tasks WHERE project_id='project-1' AND id='task-1'").get().person_name, '原子标签已改名', 'identity rename updates every task with one set-based service mutation');
    labelDb.close();
    currentBasePath = failingBasePath;
    await assert.rejects(invoke('team.patch.detect.v1', { photoId: 'photo-1', baseVersionId: 'version-1' }), /退出/);
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM team_patch_tasks WHERE is_deleted=0').get().count, 1, 'algorithm crash must retain the previously committed database generation');
    db.close();
    const journal = fs.readFileSync(path.join(dataRoot, 'command-log', 'operations.ndjson'), 'utf8');
    assert(journal.includes('"state":"committed"') && journal.includes('"state":"rolled-back"'), 'command log must record commit and compensating rollback');
    await assert.rejects(invoke('team.patch.detect.v1', { photoId: 'photo-outside', baseVersionId: 'version-1' }), /outside the bound project/);
    assert.equal(fs.existsSync(path.join(dataRoot, 'photo-outside')), false, 'authorization failure must happen before component output mutation');
    const batch = await invoke('team.patch.detect-batch.v1', { relativePaths: ['one.jpg', 'two.jpg'] });
    assert.equal(batch.results.filter(item => item.success).length, 2);
    assert.equal(batch.persistentBackend, true);
    assert.equal(fs.readFileSync(batchCountPath, 'utf8'), '1', 'the service invokes one detect-batch process/model session for the whole batch');
    const replacementsBeforeRepeat = controlledReplacementWrites;
    await invoke('team.patch.detect-batch.v1', { relativePaths: ['one.jpg', 'two.jpg'] });
    assert.equal(controlledReplacementWrites - replacementsBeforeRepeat, 2, 'regenerated working images use Host Host controlled replacement ownership');
    await invoke('team.identity.assign.v1', { photoId: 'photo-1', baseVersionId: 'version-1', personIndex: 1, identityId: savedIdentity.identityId });
    await invoke('team.identity.assign.v1', { photoId: 'photo-2', baseVersionId: 'version-2', personIndex: 1, identityId: savedIdentity.identityId });
    const realSnapshot = await invoke('team.project.get.v1');
    const { hydrateLegacyWorkspace } = await import('../renderer/src/legacy/legacy-api.ts');
    const { subjectsFromWorkspace } = await import('../renderer/src/interaction-model.ts');
    const hydratedSnapshot = hydrateLegacyWorkspace(realSnapshot);
    const samePersonPhotos = subjectsFromWorkspace(hydratedSnapshot).filter(subject => subject.identity?.id === savedIdentity.identityId).map(subject => subject.photo).sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'));
    assert.deepEqual(samePersonPhotos.map(photo => photo.displayName), ['Base', 'Second'], 'real team.project.get DTO hydrates and sorts two same-person photos using displayName only');
    const beforeIdentityMaterialize = materializeCount;
    const suggested = await invoke('team.identity.suggest.v1');
    assert.equal(suggested.success, true);
    assert.equal(materializeCount - beforeIdentityMaterialize, 2, 'identity batching materializes each unique photo/version exactly once');
    assert.equal(fs.readdirSync(path.join(dataRoot, 'inputs')).length, 0, 'identity batch inputs are removed after the operation');
    const selectedReturns = await invoke('team.patch.select-returns.v1');
    const returned = await invoke('team.patch.return-batch.v1', { operationId: 'return-progress-test', returnedFiles: selectedReturns.files, relativePaths: ['one.jpg'] });
    assert.equal(returned.acceptedCount, 1, `return matching consumes Host selector tokens and archives into component-private storage: ${JSON.stringify(returned)}`);
    assert(emittedTopics.has('team.return.progress.v1'), 'return progress reaches the declared plugin event topic');
    const returnProgress = emittedEvents.filter(item => item.topic === 'team.return.progress.v1').map(item => item.event);
    assert(returnProgress.length >= 8, `return processing must report real multi-phase progress: ${JSON.stringify(returnProgress)}`);
    assert(returnProgress.every(item => item.operationId === 'return-progress-test'), 'every return progress event is scoped to its renderer operation');
    assert(returnProgress.some(item => item.phase === 'reading' && item.progress > 0), 'return progress covers input reading');
    assert(returnProgress.some(item => item.phase === 'matching' && item.progress > 40 && item.progress < 82 && /\u6bd4\u5bf9\u56fe\u7247/.test(item.message)), 'matcher stdout progress is forwarded continuously instead of discarded');
    assert(returnProgress.some(item => item.phase === 'importing' && item.progress > 82), 'return progress covers archive writes');
    assert.deepEqual({ state: returnProgress.at(-1).state, phase: returnProgress.at(-1).phase, progress: returnProgress.at(-1).progress }, { state: 'completed', phase: 'complete', progress: 100 }, 'return progress terminates at a real 100% completion event');
    let noRetouchDb = new DatabaseSync(databasePath);
    noRetouchDb.function('team_request_id', () => '');
    const sourceTask = noRetouchDb.prepare(`SELECT patch_path FROM team_patch_tasks WHERE project_id='project-1' AND photo_id='photo-1' AND base_version_id='version-1' AND is_deleted=0 LIMIT 1`).get();
    const now = Date.now();
    noRetouchDb.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,generation_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('project-1', 'task-no-retouch', 'photo-1', 'version-1', 2, 'Skipped person', '{}', '{}', sourceTask.patch_path, JSON.stringify([{ personIndex: 2 }]), JSON.stringify({ version: 2 }), 'exported', now, now);
    noRetouchDb.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,completion_kind,return_missing,completed_at,updated_at,task_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('project-1', 'photo-1', 'version-1', 2, null, 1, 'manual', 1, 'no-retouch', 0, now, now, 'task-no-retouch');
    for (const task of noRetouchDb.prepare("SELECT id,members_json FROM team_patch_tasks WHERE project_id='project-1' AND photo_id='photo-1' AND base_version_id='version-1' AND is_deleted=0").all()) for (const member of JSON.parse(task.members_json)) noRetouchDb.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,completion_kind,return_missing,completed_at,updated_at,task_id) VALUES(?,?,?,?,NULL,1,'manual',1,'no-retouch',0,?,?,?) ON CONFLICT(project_id,photo_id,base_version_id,person_index) DO UPDATE SET completed=1,completion_kind=CASE WHEN team_person_assignments.artifact_id IS NULL THEN 'no-retouch' ELSE 'returned' END,return_missing=0,task_id=excluded.task_id`).run('project-1', 'photo-1', 'version-1', Number(member.personIndex), now, now, task.id);
    noRetouchDb.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,generation_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('project-1', 'task-member-guard', 'photo-1', 'version-1', 7, 'Member guard', '{}', '{}', sourceTask.patch_path, JSON.stringify([{ personIndex: 7 }, { personIndex: 8 }]), JSON.stringify({ version: 2 }), 'exported', now, now);
    noRetouchDb.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,completion_kind,return_missing,completed_at,updated_at,task_id) VALUES(?,?,?,?,NULL,1,'manual',1,'no-retouch',0,?,?,?)`).run('project-1', 'photo-1', 'version-1', 7, now, now, 'task-member-guard');
    noRetouchDb.close();
    await assert.rejects(invoke('team.patch.merge.v1', { photoId: 'photo-1', baseVersionId: 'version-1', outputProgressId: 'progress-2' }), /人物 8 未完成/, 'one returned/no-retouch member cannot complete an entire multi-member task');
    noRetouchDb = new DatabaseSync(databasePath); noRetouchDb.function('team_request_id', () => '');
    noRetouchDb.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,completion_kind,return_missing,completed_at,updated_at,task_id) VALUES(?,?,?,?,NULL,1,'manual',1,'no-retouch',0,?,?,?)`).run('project-1', 'photo-1', 'version-1', 8, now, now, 'task-member-guard');
    for (const task of noRetouchDb.prepare("SELECT id,members_json FROM team_patch_tasks WHERE project_id='project-1' AND photo_id='photo-1' AND base_version_id='version-1' AND is_deleted=0").all()) for (const member of JSON.parse(task.members_json)) noRetouchDb.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,completion_kind,return_missing,completed_at,updated_at,task_id) VALUES(?,?,?,?,NULL,1,'manual',1,'no-retouch',0,?,?,?) ON CONFLICT(project_id,photo_id,base_version_id,person_index) DO UPDATE SET completed=1,completion_kind=CASE WHEN team_person_assignments.artifact_id IS NULL THEN 'no-retouch' ELSE 'returned' END,return_missing=0,task_id=excluded.task_id`).run('project-1', 'photo-1', 'version-1', Number(member.personIndex), now, now, task.id);
    const pureTasks = noRetouchDb.prepare("SELECT id,members_json FROM team_patch_tasks WHERE project_id='project-1' AND photo_id='photo-2' AND base_version_id='version-2' AND is_deleted=0").all();
    for (const task of pureTasks) for (const member of JSON.parse(task.members_json)) noRetouchDb.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,completion_kind,return_missing,completed_at,updated_at,task_id) VALUES(?,?,?,?,NULL,1,'manual',1,'no-retouch',0,?,?,?) ON CONFLICT(project_id,photo_id,base_version_id,person_index) DO UPDATE SET completed=1,completion_kind='no-retouch',edited_patch_path=NULL,task_id=excluded.task_id`).run('project-1', 'photo-2', 'version-2', Number(member.personIndex), now, now, task.id);
    noRetouchDb.close();
    currentBasePath = secondBasePath;
    const pureNoRetouch = await invoke('team.patch.merge.v1', { photoId: 'photo-2', baseVersionId: 'version-2', outputProgressId: 'progress-2' });
    assert.equal(pureNoRetouch.merge.noRetouch, true, 'pure no-retouch publishes the original baseline as a zero-modification version');
    const emptyDb = new DatabaseSync(databasePath); emptyDb.function('team_request_id', () => ''); emptyDb.prepare("UPDATE team_patch_tasks SET is_deleted=1 WHERE project_id='project-1' AND photo_id='photo-2' AND base_version_id='version-2'").run(); emptyDb.close();
    await assert.rejects(invoke('team.patch.merge.v1', { photoId: 'photo-2', baseVersionId: 'version-2', outputProgressId: 'progress-2' }), /没有可合成的当前任务/, 'a registered photo with zero active tasks cannot publish a merge');
    const mergeOutputsBeforeMixed = [...outputByIdempotencyKey.keys()].filter(key => key.startsWith('merge-')).length;
    const mergeVersionsBeforeMixed = [...versionsByIdempotencyKey.keys()].filter(key => key.startsWith('merge-version-')).length;
    const mergeFilesBeforeMixed = fs.readdirSync(path.join(projectOutputRoot, 'merged')).length;
    currentBasePath = basePath;
    const faultDb = new DatabaseSync(databasePath); faultDb.exec(`CREATE TRIGGER fail_merge_db_update BEFORE UPDATE OF status ON team_patch_tasks WHEN NEW.status='merged' BEGIN SELECT RAISE(ABORT,'injected merge DB failure'); END;`); faultDb.close();
    await assert.rejects(invoke('team.patch.merge.v1', { photoId: 'photo-1', baseVersionId: 'version-1', outputProgressId: 'progress-2' }), /injected merge DB failure/);
    const repairDb = new DatabaseSync(databasePath); repairDb.exec('DROP TRIGGER fail_merge_db_update'); repairDb.close();
    const merged = await invoke('team.patch.merge.v1', { photoId: 'photo-1', baseVersionId: 'version-1', outputProgressId: 'progress-2' });
    const mergedStatusDb = new DatabaseSync(databasePath);
    const mergedStatuses = mergedStatusDb.prepare(`SELECT id,status FROM team_patch_tasks WHERE project_id='project-1' AND photo_id='photo-1' AND base_version_id='version-1' AND is_deleted=0 ORDER BY id`).all().map(row => [row.id, row.status]);
    assert.equal(mergedStatuses.length, 3);
    assert(mergedStatuses.some(([id, status]) => id === 'task-no-retouch' && status === 'merged') && mergedStatuses.every(([, status]) => status === 'merged'), 'a successful photo merge must also settle tasks explicitly completed as no-retouch');
    mergedStatusDb.close();
    const replayed = await invoke('team.patch.merge.v1', { photoId: 'photo-1', baseVersionId: 'version-1', outputProgressId: 'progress-2' });
    assert.equal(replayed.merge.versionId, merged.merge.versionId, 'identical merge input reuses the stable version id after crash recovery');
    assert.equal([...outputByIdempotencyKey.keys()].filter(key => key.startsWith('merge-')).length, mergeOutputsBeforeMixed + 1, 'merge crash retry creates one committed output receipt');
    assert.equal([...versionsByIdempotencyKey.keys()].filter(key => key.startsWith('merge-version-')).length, mergeVersionsBeforeMixed + 1, 'merge crash retry creates one version');
    assert.equal(fs.readdirSync(path.join(projectOutputRoot, 'merged')).length, mergeFilesBeforeMixed + 1, 'stable merge output name prevents duplicate project files');
    const rebuilt = await invoke('team.patch.merge.v1', { photoId: 'photo-1', baseVersionId: 'version-1', outputProgressId: 'progress-2', rebuildToken: 'explicit-rebuild-1' });
    assert.notEqual(rebuilt.merge.versionId, merged.merge.versionId, 'an explicit rebuild creates a fresh output version instead of replaying the deleted output receipt');
    assert.equal([...outputByIdempotencyKey.keys()].filter(key => key.startsWith('merge-')).length, mergeOutputsBeforeMixed + 2, 'an explicit rebuild publishes one new output receipt');
    assert.equal([...versionsByIdempotencyKey.keys()].filter(key => key.startsWith('merge-version-')).length, mergeVersionsBeforeMixed + 2, 'an explicit rebuild creates one new version');
    assert.equal(fs.readdirSync(path.join(projectOutputRoot, 'merged')).length, mergeFilesBeforeMixed + 2, 'an explicit rebuild uses a new stable output name');
    assert.equal(outputStages.size, 0, 'commit replay and success both clean their redundant output stages');
    assert(emittedTopics.has('team.patch.detect.progress.v1') && emittedTopics.has('team.patch.detect-batch.progress.v1'), 'single and batch detection events retain distinct declared V2 topics');
    console.log('Team-retouch mutation subprocess, privilege, and rollback tests passed');
  } finally {
    lines.close();
    const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    child.kill();
    await exited;
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (error) { if (error?.code !== 'EPERM') throw error; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
