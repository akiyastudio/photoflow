const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-reconcile-'));
const dataRoot = path.join(sandbox, 'data', 'team-retouch');
const databasePath = path.join(sandbox, 'data', 'databases', 'team-retouch.sqlite3');
const projectRoot = path.join(sandbox, 'project');
const projectStorageKey = require('crypto').createHash('sha256').update('project').digest('hex');
const outputDirectory = path.join(dataRoot, 'workflow-content', projectStorageKey);
const manifestPath = path.join(dataRoot, 'workflows', `${projectStorageKey}.json`);
const reviewDirectory = path.join(dataRoot, 'workflow-return-reviews', projectStorageKey);
const deliveryDirectory = path.join(dataRoot, 'legacy-work');
const taskOnePatch = path.join(deliveryDirectory, 'task-one.png');
const taskTwoPatch = path.join(deliveryDirectory, 'task-two.png');
const returnedSource = path.join(sandbox, 'returned-a.png');
fs.mkdirSync(deliveryDirectory, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(taskOnePatch, 'ORIGINAL-TASK-ONE');
fs.writeFileSync(taskTwoPatch, 'ORIGINAL-TASK-TWO');
fs.writeFileSync(returnedSource, 'RETURNED-BY-A');

const bundle = {
  relativePath: 'photo.jpg',
  photo: { id: 'photo', projectId: 'project', currentVersionId: 'base', displayName: '接力照片' },
  versions: [{ id: 'base', filePath: path.join(projectRoot, 'photo.jpg'), relativePath: 'photo.jpg', isCurrent: true }],
};
fs.writeFileSync(bundle.versions[0].filePath, 'BASE');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'extensions', 'team-retouch', 'service.cjs')], {
  env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;
let holdSecondWorkflowScope = false;
let heldWorkflowFrame = null;
let heldWorkflowResolve = null;
let workflowScopeCount = 0;
let breakManifestOnArtifactCall = 0;
let artifactScopeCount = 0;
let manifestDirectoryBackup = '';
const inputTokens = new Map(); const outputStages = new Map();
const emittedTopics = new Set();
const waitForHeldWorkflow = () => new Promise(resolve => { heldWorkflowResolve = resolve; });
const releaseHeldWorkflow = () => {
  child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: heldWorkflowFrame.id, ok: true, result: { apiVersion: 2, dataPath: dataRoot, databasePath, projectId: 'project', ownership: 'component-private' } })}\n`);
  heldWorkflowFrame = null;
};
const invoke = (method, payload = {}) => new Promise((resolve, reject) => {
  const id = String(nextId++);
  pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload, context: { componentId: 'team-retouch', componentVersion: 'test', projectId: 'project', projectName: 'Project', projectStatus: 'active' } })}\n`);
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
        if (frame.method === 'component.storage.v2') {
          artifactScopeCount += 1;
          const breakAtStorageCall = breakManifestOnArtifactCall === 2 ? 6 : breakManifestOnArtifactCall === 1 ? 3 : 0;
          if (breakAtStorageCall && artifactScopeCount === breakAtStorageCall) {
            const manifestDirectory = path.dirname(manifestPath);
            manifestDirectoryBackup = `${manifestDirectory}.backup`;
            fs.renameSync(manifestDirectory, manifestDirectoryBackup);
            fs.writeFileSync(manifestDirectory, 'block manifest writes');
          }
          workflowScopeCount += 1;
          if (holdSecondWorkflowScope && workflowScopeCount === 5) {
            heldWorkflowFrame = frame;
            heldWorkflowResolve?.();
            return;
          }
          result = { apiVersion: 2, dataPath: dataRoot, databasePath, projectId: 'project', ownership: 'component-private' };
        } else if (frame.method === 'project.media.variants.v2') {
          const token = `test-input:${bundle.versions[0].filePath}`; inputTokens.set(token, bundle.versions[0].filePath);
          result = { apiVersion: 2, mediaRef: { photoId: 'photo', versionId: 'base', relativePath: 'photo.jpg' }, metadata: { photoId: 'photo', versionId: 'base', currentVersionId: 'base', displayName: '接力照片', originalName: 'photo.jpg', relativePath: 'photo.jpg', isCurrent: true, fileMissing: false }, variants: { original: { url: 'test', byteLength: 4, derived: false } }, input: { token, expiresAt: Date.now() + 1000 } };
        } else if (frame.method === 'project.input.tokens.v2') { const source = inputTokens.get(frame.payload.token) || frame.payload.token.slice('test-input:'.length); const inputId = require('crypto').randomUUID(); const directory = path.join(dataRoot, 'inputs', inputId); fs.mkdirSync(directory, { recursive: true }); const privatePath = path.join(directory, path.basename(source)); fs.copyFileSync(source, privatePath); result = { apiVersion: 2, inputId, privatePath, byteLength: fs.statSync(privatePath).size }; }
        else if (frame.method === 'tasks.v2') result = { apiVersion: 2, task: frame.payload.action === 'complete' ? { state: 'completed' } : null, cancelled: false };
        else if (frame.method === 'component.events.v2') { emittedTopics.add(frame.payload.topic); result = { apiVersion: 2, emitted: true }; }
        else if (frame.method === 'dialogs.v2') { const token = `test-input:${returnedSource}`; inputTokens.set(token, returnedSource); result = { apiVersion: 2, cancelled: false, inputs: [{ name: path.basename(returnedSource), token, expiresAt: Date.now() + 1000 }] }; }
        else if (frame.method === 'project.output.v2') {
          if (frame.payload.action === 'stage') { const stageId = require('crypto').randomUUID(); const privatePath = path.join(dataRoot, 'v2-stages', stageId); fs.mkdirSync(privatePath, { recursive: true }); outputStages.set(stageId, { privatePath, files: [] }); result = { apiVersion: 2, stageId, privatePath, expiresAt: Date.now() + 60000 }; }
          else if (frame.payload.action === 'write') { const stage = outputStages.get(frame.payload.stageId); stage.files.push(frame.payload); result = { apiVersion: 2, stageId: frame.payload.stageId, artifactId: require('crypto').randomUUID(), byteLength: fs.statSync(path.join(stage.privatePath, frame.payload.sourceName)).size }; }
          else if (frame.payload.action === 'validate') result = { apiVersion: 2, stageId: frame.payload.stageId, valid: true, fileCount: outputStages.get(frame.payload.stageId).files.length, totalBytes: 1 };
          else if (frame.payload.action === 'commit') { const stage = outputStages.get(frame.payload.stageId); const commitId = require('crypto').randomUUID(); result = { apiVersion: 2, commitId, idempotencyKey: frame.payload.idempotencyKey, outputs: stage.files.map(file => ({ artifactId: require('crypto').randomUUID(), relativePath: file.outputRelativePath, sha256: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(stage.privatePath, file.sourceName))).digest('hex') })) }; }
          else if (frame.payload.action === 'rollback') result = { apiVersion: 2, stageId: frame.payload.stageId, rolledBack: true };
          else throw new Error(`unexpected output action ${frame.payload.action}`);
        }
        else throw new Error(`unexpected capability ${frame.method} ${JSON.stringify(frame.payload)}`);
      } catch (value) { error = value; }
      child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: !error, result, error: error?.message })}\n`);
      return;
    }
    if (frame.type === 'response') {
      const request = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.ok) request.resolve(frame.result); else request.reject(new Error(frame.error));
    }
  });
});

const manifestItem = (taskId, personIndex) => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return manifest.groups.flatMap(group => group.items || []).find(item => item.taskId === taskId && Number(item.personIndex) === personIndex);
};
const itemPath = (taskId, personIndex) => {
  const item = manifestItem(taskId, personIndex);
  return { item, filePath: path.resolve(outputDirectory, item.relativePath) };
};
const assertActive = (taskId, personIndex, expectedContent) => {
  const { item, filePath } = itemPath(taskId, personIndex);
  assert.equal(item.available, true);
  assert.equal(fs.readFileSync(filePath, 'utf8'), expectedContent);
  return filePath;
};
const assertInactive = (taskId, personIndex) => {
  const { item, filePath } = itemPath(taskId, personIndex);
  assert.equal(item.available, false);
  assert.equal(fs.existsSync(filePath), false);
};
const seedReview = (id, content) => {
  fs.rmSync(reviewDirectory, { recursive: true, force: true });
  fs.mkdirSync(reviewDirectory, { recursive: true });
  const reviewPath = path.join(reviewDirectory, `${id}.png`);
  fs.writeFileSync(reviewPath, content);
  fs.writeFileSync(path.join(reviewDirectory, 'session.json'), JSON.stringify({
    version: 2, id, status: 'active', result: { matches: [{ returnId: id, path: reviewPath, accepted: false }] },
  }));
};
const restoreManifestDirectory = () => {
  if (!manifestDirectoryBackup) return;
  fs.rmSync(path.dirname(manifestPath), { force: true });
  fs.renameSync(manifestDirectoryBackup, path.dirname(manifestPath));
  manifestDirectoryBackup = '';
};

(async () => {
  try {
    await ready;
    await invoke('team.project.get.v1');
    const db = new DatabaseSync(databasePath);
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)`).run('photo', 'project', 'base', 1, 1);
    const insertTask = db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    insertTask.run('task-1', 'photo', 'base', 1, '任务一', '{}', '{}', taskOnePatch, JSON.stringify([{ personIndex: 1 }, { personIndex: 2 }]), 1, 1);
    insertTask.run('task-2', 'photo', 'base', 3, '任务二', '{}', '{}', taskTwoPatch, JSON.stringify([{ personIndex: 3 }, { personIndex: 4 }]), 1, 1);
    const insertStage = db.prepare(`INSERT INTO team_task_stages(id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`);
    for (const [taskId, people] of [['task-1', [1, 2]], ['task-2', [3, 4]]]) for (const [index, personIndex] of people.entries()) insertStage.run(`${taskId}-stage-${personIndex}`, taskId, personIndex, index + 1, 'pending', 1, 1);
    const insertIdentity = db.prepare(`INSERT INTO team_person_identities(id,project_id,name,created_at,updated_at) VALUES(?,?,?,?,?)`);
    const insertAssignment = db.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at,task_id,stage_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const personIndex of [1, 2, 3, 4]) {
      insertIdentity.run(`identity-${personIndex}`, 'project', `人物 ${personIndex}`, 1, 1);
      const taskId = personIndex <= 2 ? 'task-1' : 'task-2';
      insertAssignment.run('project', 'photo', 'base', personIndex, `identity-${personIndex}`, 1, 'manual', 0, 1, taskId, `${taskId}-stage-${personIndex}`);
    }
    db.exec('COMMIT');
    db.close();

    const generated = await invoke('team.workflow.generate.v1', {
      operationId: 'reconcile-fixture', replace: true,
      preferredIdentityOrder: ['identity-1', 'identity-2', 'identity-3', 'identity-4'],
      groups: [
        { week: 1, identityId: 'identity-1', identityName: 'A', items: [{ photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, photoName: '任务一' }] },
        { week: 1, identityId: 'identity-3', identityName: 'C', items: [{ photoId: 'photo', baseVersionId: 'base', taskId: 'task-2', personIndex: 3, photoName: '任务二' }] },
        { week: 2, identityId: 'identity-2', identityName: 'B', items: [{ photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 2, photoName: '任务一' }] },
        { week: 2, identityId: 'identity-4', identityName: 'D', items: [{ photoId: 'photo', baseVersionId: 'base', taskId: 'task-2', personIndex: 4, photoName: '任务二' }] },
      ],
    });
    assert.equal(generated.success, true, generated.error);
    assert(emittedTopics.has('team.workflow.progress.v1'), 'workflow progress reaches the host on its declared V2 event topic');
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    const taskTwoActive = assertActive('task-2', 3, 'ORIGINAL-TASK-TWO');
    assertInactive('task-1', 2);
    assertInactive('task-2', 4);

    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: true, completionKind: 'no-retouch' });
    const taskOneB = assertActive('task-1', 2, 'ORIGINAL-TASK-ONE');
    assertInactive('task-1', 1);
    assert.equal(fs.readFileSync(taskTwoActive, 'utf8'), 'ORIGINAL-TASK-TWO', 'reconciling task one must not alter task two');
    const beforeRepeat = fs.statSync(taskOneB).mtimeMs;
    const beforeNames = fs.readdirSync(path.dirname(taskOneB)).sort();
    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: true, completionKind: 'no-retouch' });
    assert.equal(fs.statSync(taskOneB).mtimeMs, beforeRepeat, 'repeated reconciliation reuses the correct published input');
    assert.deepEqual(fs.readdirSync(path.dirname(taskOneB)).sort(), beforeNames, 'repeated reconciliation creates no duplicate files');

    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false });
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    assertInactive('task-1', 2);
    assertActive('task-2', 3, 'ORIGINAL-TASK-TWO');

    await invoke('team.patch.upload.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assertActive('task-1', 2, 'RETURNED-BY-A');
    assertInactive('task-1', 1);
    assertActive('task-2', 3, 'ORIGINAL-TASK-TWO');
    const identityDb = new DatabaseSync(databasePath);
    assert.equal(identityDb.prepare(`SELECT identity_id FROM team_person_assignments WHERE photo_id='photo' AND base_version_id='base' AND person_index=1`).get().identity_id, 'identity-1', 'Alice identity survives return upload');
    identityDb.close();

    await invoke('team.patch.remove-upload.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    assertInactive('task-1', 2);
    assertActive('task-2', 3, 'ORIGINAL-TASK-TWO');
    assertInactive('task-2', 4);

    seedReview('concurrent-return', 'CONCURRENT-RETURN');
    holdSecondWorkflowScope = true;
    workflowScopeCount = 0;
    const held = waitForHeldWorkflow();
    const confirmation = invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'concurrent-return', returnId: 'concurrent-return', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    await held;
    let undoResolved = false;
    const concurrentUndo = invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false }).then(value => { undoResolved = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(undoResolved, false, 'same-photo completion cannot enter between return archival and reconciliation');
    releaseHeldWorkflow();
    assert.equal((await confirmation).success, true);
    await concurrentUndo;
    holdSecondWorkflowScope = false;
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    assertInactive('task-1', 2);

    seedReview('recoverable-return', 'RECOVERABLE-RETURN');
    breakManifestOnArtifactCall = 2;
    artifactScopeCount = 0;
    const recoverable = await invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'recoverable-return', returnId: 'recoverable-return', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assert.equal(recoverable.success, true, 'a committed return must not be reported as an upload failure');
    assert.equal(recoverable.reconcilePending, true);
    assert.match(recoverable.warning, /无需重复操作/);
    const pendingDb = new DatabaseSync(databasePath);
    const archived = pendingDb.prepare(`SELECT a.completed,a.artifact_id,r.artifact_path FROM team_person_assignments a JOIN team_task_artifacts r ON r.id=a.artifact_id WHERE a.photo_id='photo' AND a.base_version_id='base' AND a.person_index=1`).get();
    assert.equal(archived.completed, 1);
    assert.equal(fs.readFileSync(archived.artifact_path, 'utf8'), 'RECOVERABLE-RETURN');
    assert.equal(pendingDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending').get().count, 1);
    pendingDb.close();
    restoreManifestDirectory();
    breakManifestOnArtifactCall = 0;
    const reload = await invoke('team.project.get.v1'); assert.equal(reload.migration.state, 'pending'); await invoke('team.project.migrate-step.v1');
    const recoveredDb = new DatabaseSync(databasePath);
    assert.equal(recoveredDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending').get().count, 0, 'project reload clears a successfully reconciled pending task');
    recoveredDb.close();
    assertActive('task-1', 2, 'RECOVERABLE-RETURN');
    assertInactive('task-1', 1);
    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false });
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    artifactScopeCount = 0;
    breakManifestOnArtifactCall = 1;
    const savedNoRetouch = await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: true, completionKind: 'no-retouch' });
    assert.equal(savedNoRetouch.success, true, 'committed no-retouch state must not be reported as a failed operation');
    assert.equal(savedNoRetouch.reconcilePending, true);
    assert.match(savedNoRetouch.warning, /无需重复操作/);
    const noRetouchPendingDb = new DatabaseSync(databasePath);
    assert.equal(noRetouchPendingDb.prepare(`SELECT completed,completion_kind FROM team_person_assignments WHERE photo_id='photo' AND base_version_id='base' AND person_index=1`).get().completion_kind, 'no-retouch');
    assert.equal(noRetouchPendingDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending').get().count, 1);
    noRetouchPendingDb.close();
    restoreManifestDirectory();
    breakManifestOnArtifactCall = 0;
    const noRetouchReload = await invoke('team.project.get.v1'); assert.equal(noRetouchReload.migration.state, 'pending'); await invoke('team.project.migrate-step.v1');
    assertActive('task-1', 2, 'ORIGINAL-TASK-ONE');
    const noRetouchRecoveredDb = new DatabaseSync(databasePath);
    assert.equal(noRetouchRecoveredDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending').get().count, 0);
    noRetouchRecoveredDb.close();
    await invoke('team.identity.assign.v1', { photoId: 'photo', baseVersionId: 'base', personIndex: 1, identityId: null, completed: false });
    const cleared = await invoke('team.project.get.v1');
    assert.equal(cleared.assignments.find(item => item.personIndex === 1).identityId, null, 'explicit empty identity assignment restores the unlabelled state');
    console.log('Team-retouch workflow task-chain reconciliation tests passed');
  } finally {
    lines.close();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (error) { if (error.code !== 'EPERM') throw error; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
