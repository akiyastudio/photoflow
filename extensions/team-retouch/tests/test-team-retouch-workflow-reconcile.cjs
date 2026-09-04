const assert = require('assert');
// Plugin-owned regression test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { DatabaseSync: NativeDatabaseSync } = require('node:sqlite');
class DatabaseSync extends NativeDatabaseSync {
  constructor(databasePath) { super(databasePath); this.function('team_request_id', () => ''); }
}
const { resolveWorkflowTaskBinding } = require('../service.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-reconcile-'));
const dataRoot = path.join(sandbox, 'data', 'team-retouch');
const databasePath = path.join(sandbox, 'data', 'databases', 'team-retouch.sqlite3');
const projectRoot = path.join(sandbox, 'project');
const projectStorageKey = require('crypto').createHash('sha256').update('project').digest('hex');
const outputDirectory = path.join(dataRoot, 'workflow-content', projectStorageKey);
const manifestPath = path.join(dataRoot, 'workflows', `${projectStorageKey}.json`);
const reviewDirectory = path.join(dataRoot, 'workflow-return-reviews', projectStorageKey);
const deliveryDirectory = path.join(dataRoot, 'projects', projectStorageKey, 'media', 'photo', 'base', 'delivery');
const taskOnePatch = path.join(deliveryDirectory, 'task-one.png');
const taskTwoPatch = path.join(deliveryDirectory, 'task-two.png');
const taskThreePatch = path.join(deliveryDirectory, 'task-three.png');
const returnedSource = path.join(sandbox, 'returned-a.png');
fs.mkdirSync(deliveryDirectory, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(taskOnePatch, 'ORIGINAL-TASK-ONE');
fs.writeFileSync(taskTwoPatch, 'ORIGINAL-TASK-TWO');
fs.writeFileSync(taskThreePatch, 'ORIGINAL-TASK-THREE');
fs.writeFileSync(returnedSource, 'RETURNED-BY-A');

const bundle = {
  relativePath: 'photo.jpg',
  photo: { id: 'photo', projectId: 'project', currentVersionId: 'base', displayName: '接力照片' },
  versions: [{ id: 'base', filePath: path.join(projectRoot, 'photo.jpg'), relativePath: 'photo.jpg', isCurrent: true }],
};
fs.writeFileSync(bundle.versions[0].filePath, 'BASE');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'service.cjs')], {
    env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1', PHOTOFLOW_TEST_FAULT_REVIEW_SESSION_AFTER_COMMIT: 'session-write-failure', PHOTOFLOW_TEST_FAULT_REVIEW_RETIRE: 'retire-failure' }, stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
let serviceStderr = '';
child.stderr.on('data', chunk => { serviceStderr = `${serviceStderr}${chunk}`.slice(-4000); });
const pending = new Map();
let nextId = 1;
let holdSecondWorkflowScope = false;
let heldWorkflowFrame = null;
let heldWorkflowResolve = null;
let workflowScopeCount = 0;
let breakManifestOnArtifactCall = 0;
let outputFaultInjected = false;
let artifactScopeCount = 0;
let manifestDirectoryBackup = '';
let lastOutputDirectoryDialog = null;
const inputTokens = new Map(); const outputStages = new Map();
const emittedTopics = new Set();
const capabilityCounts = new Map();
const waitForHeldWorkflow = () => new Promise(resolve => { heldWorkflowResolve = resolve; });
const releaseHeldWorkflow = () => {
  child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: heldWorkflowFrame.id, ok: true, result: { dataPath: dataRoot, databasePath, projectId: 'project', ownership: 'component-private' } })}\n`);
  heldWorkflowFrame = null;
};
const invoke = (method, payload = {}) => new Promise((resolve, reject) => {
  const id = String(nextId++);
  pending.set(id, { resolve, reject, method, payload });
  child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload, context: { componentId: 'team-retouch', componentVersion: 'test', projectId: 'project', projectName: 'Project', projectStatus: 'active' } })}\n`);
});
const ready = new Promise((resolve, reject) => {
  child.once('exit', code => {
    const error = new Error(`service exited ${code}${serviceStderr ? `: ${serviceStderr}` : ''}`);
    reject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  lines.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'ready') { resolve(); return; }
    if (frame.type === 'capability') {
      capabilityCounts.set(frame.method, (capabilityCounts.get(frame.method) || 0) + 1);
      let result;
      let error;
      try {
        if (frame.method === 'component.storage') {
          artifactScopeCount += 1;
          workflowScopeCount += 1;
          if (holdSecondWorkflowScope && workflowScopeCount === 1) {
            heldWorkflowFrame = frame;
            heldWorkflowResolve?.();
            return;
          }
          result = { dataPath: dataRoot, databasePath, projectId: 'project', ownership: 'component-private' };
        } else if (frame.method === 'project.media.variants') {
          const token = `test-input:${bundle.versions[0].filePath}`; inputTokens.set(token, bundle.versions[0].filePath);
          result = { mediaRef: { photoId: 'photo', versionId: 'base', relativePath: 'photo.jpg' }, metadata: { photoId: 'photo', versionId: 'base', currentVersionId: 'base', displayName: '接力照片', originalName: 'photo.jpg', relativePath: 'photo.jpg', isCurrent: true, fileMissing: false }, variants: { original: { url: 'test', byteLength: 4, derived: false } }, input: { token, expiresAt: Date.now() + 1000 } };
        } else if (frame.method === 'project.input.tokens') { const source = inputTokens.get(frame.payload.token) || frame.payload.token.slice('test-input:'.length); const inputId = require('crypto').randomUUID(); const directory = path.join(dataRoot, 'inputs', inputId); fs.mkdirSync(directory, { recursive: true }); const privatePath = path.join(directory, path.basename(source)); fs.copyFileSync(source, privatePath); result = { inputId, privatePath, byteLength: fs.statSync(privatePath).size }; }
        else if (frame.method === 'tasks') result = { task: frame.payload.action === 'complete' ? { state: 'completed' } : null, cancelled: false };
        else if (frame.method === 'component.events') { emittedTopics.add(frame.payload.topic); result = { emitted: true }; }
        else if (frame.method === 'dialogs' && frame.payload.kind === 'openOutputDirectory') { lastOutputDirectoryDialog = frame.payload; result = { opened: true, outputRef: { commitId: frame.payload.commitId, artifactId: frame.payload.artifactId } }; }
        else if (frame.method === 'dialogs') { const token = `test-input:${returnedSource}`; inputTokens.set(token, returnedSource); result = { cancelled: false, inputs: [{ name: path.basename(returnedSource), token, expiresAt: Date.now() + 1000 }] }; }
        else if (frame.method === 'project.output') {
          if (breakManifestOnArtifactCall && !outputFaultInjected && frame.payload.action === 'stage') {
            const manifestDirectory = path.dirname(manifestPath); manifestDirectoryBackup = `${manifestDirectory}.backup`;
            fs.renameSync(manifestDirectory, manifestDirectoryBackup); fs.writeFileSync(manifestDirectory, 'block manifest writes'); outputFaultInjected = true;
          }
          if (frame.payload.action === 'stage') { const stageId = require('crypto').randomUUID(); const privatePath = path.join(dataRoot, 'stages', stageId); fs.mkdirSync(privatePath, { recursive: true }); outputStages.set(stageId, { privatePath, files: [] }); result = { stageId, privatePath, expiresAt: Date.now() + 60000 }; }
          else if (frame.payload.action === 'write') { const stage = outputStages.get(frame.payload.stageId); stage.files.push(frame.payload); result = { stageId: frame.payload.stageId, artifactId: require('crypto').randomUUID(), byteLength: fs.statSync(path.join(stage.privatePath, frame.payload.sourceName)).size }; }
          else if (frame.payload.action === 'validate') result = { stageId: frame.payload.stageId, valid: true, fileCount: outputStages.get(frame.payload.stageId).files.length, totalBytes: 1 };
          else if (frame.payload.action === 'commit') { const stage = outputStages.get(frame.payload.stageId); const commitId = require('crypto').randomUUID(); result = { commitId, idempotencyKey: frame.payload.idempotencyKey, outputs: stage.files.map(file => ({ artifactId: require('crypto').randomUUID(), relativePath: file.outputRelativePath, sha256: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(stage.privatePath, file.sourceName))).digest('hex') })) }; }
          else if (frame.payload.action === 'rollback') result = { stageId: frame.payload.stageId, rolledBack: true };
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
      if (frame.ok) request.resolve(frame.result); else request.reject(new Error(`${request.method} ${JSON.stringify(request.payload)}: ${frame.error}`));
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
    version: 2, id, projectId: 'project', status: 'active', result: { matches: [{ returnId: id, path: reviewPath, accepted: false, photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 }] },
  }));
};
const seedReviewMatches = (id, matches) => {
  fs.rmSync(reviewDirectory, { recursive: true, force: true });
  fs.mkdirSync(reviewDirectory, { recursive: true });
  const stored = matches.map((match, index) => {
    const reviewPath = path.join(reviewDirectory, `${id}-${index + 1}.png`);
    fs.writeFileSync(reviewPath, match.content);
    return { returnId: match.returnId, path: reviewPath, sourceName: `${match.returnId}.png`, accepted: false, photoId: match.photoId || 'photo', baseVersionId: match.baseVersionId || 'base', taskId: match.taskId || 'task-1', personIndex: Number(match.personIndex || 1) };
  });
  fs.writeFileSync(path.join(reviewDirectory, 'session.json'), JSON.stringify({ version: 2, id, projectId: 'project', status: 'active', result: { acceptedCount: 0, reviewCount: stored.length, matches: stored } }));
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
    db.prepare(`INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)`).run('photo-b', 'project', 'base-b', 1, 1);
    db.prepare(`INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)`).run('foreign-photo', 'other-project', 'foreign-base', 1, 1);
    const insertTask = db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,generation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const generation = JSON.stringify({ version: 2, sourceWidth: 100, sourceHeight: 100, workWidth: 100, workHeight: 100, fullFrame: true, sourceCoverage: 1, requiresManualCrop: false, exceedsWorkTileEdge: false });
    insertTask.run('project', 'task-1', 'photo', 'base', 1, '任务一', '{}', '{}', taskOnePatch, JSON.stringify([{ personIndex: 1 }, { personIndex: 2 }]), generation, 1, 1);
    insertTask.run('project', 'task-2', 'photo', 'base', 3, '任务二', '{}', '{}', taskTwoPatch, JSON.stringify([{ personIndex: 3 }, { personIndex: 4 }]), generation, 1, 1);
    insertTask.run('project', 'task-3', 'photo-b', 'base-b', 5, '任务三', '{}', '{}', taskThreePatch, JSON.stringify([{ personIndex: 5 }, { personIndex: 6 }]), generation, 1, 1);
    insertTask.run('other-project', 'foreign-task', 'foreign-photo', 'foreign-base', 5, '外部项目任务', '{}', '{}', taskOnePatch, JSON.stringify([{ personIndex: 5 }]), generation, 1, 1);
    insertTask.run('other-project', 'task-1', 'foreign-photo', 'foreign-base', 5, '外部项目同名任务', '{}', '{}', taskOnePatch, JSON.stringify([{ personIndex: 5 }]), generation, 1, 1);
    db.prepare(`INSERT INTO team_workflow_reconcile_pending(project_id,task_id,photo_id,error,attempt_count,next_attempt_at,last_error,history_json,updated_at) VALUES(?,?,?,?,0,0,'','[]',?)`).run('other-project', 'task-1', 'foreign-photo', 'foreign project isolation fixture', 1);
    const insertStage = db.prepare(`INSERT INTO team_task_stages(project_id,id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
    for (const [taskId, people] of [['task-1', [1, 2]], ['task-2', [3, 4]], ['task-3', [5, 6]]]) for (const [index, personIndex] of people.entries()) insertStage.run('project', `${taskId}-stage-${personIndex}`, taskId, personIndex, index + 1, 'pending', 1, 1);
    const insertIdentity = db.prepare(`INSERT INTO team_person_identities(id,project_id,name,created_at,updated_at) VALUES(?,?,?,?,?)`);
    const insertAssignment = db.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at,task_id,stage_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const personIndex of [1, 2, 3, 4, 5, 6]) {
      insertIdentity.run(`identity-${personIndex}`, 'project', `人物 ${personIndex}`, 1, 1);
      const taskId = personIndex <= 2 ? 'task-1' : personIndex <= 4 ? 'task-2' : 'task-3';
      insertAssignment.run('project', personIndex <= 4 ? 'photo' : 'photo-b', personIndex <= 4 ? 'base' : 'base-b', personIndex, `identity-${personIndex}`, 1, 'manual', 0, 1, taskId, `${taskId}-stage-${personIndex}`);
    }
    db.exec('COMMIT');
    assert.throws(() => resolveWorkflowTaskBinding(db, 'project', 'foreign-task', [{ item: { photoId: 'foreign-photo', baseVersionId: 'foreign-base' } }]), /不属于当前项目/, 'a stable task id cannot bind across projects');
    assert.throws(() => resolveWorkflowTaskBinding(db, 'project', 'task-1', [{ item: { photoId: 'photo', baseVersionId: 'wrong-base' } }]), /错误的照片版本/);
    assert.throws(() => resolveWorkflowTaskBinding(db, 'project', 'task-1', [{ item: { photoId: 'wrong-photo', baseVersionId: 'base' } }]), /错误的照片/);
    db.close();

    const isolatedStatus = await invoke('team.workflow.status.v1');
    assert.equal(isolatedStatus.reconciliation.pendingCount, 0, 'workflow status ignores an identically named task pending in another project');
    const cleanupReceiptPath = path.join(dataRoot, 'output-cleanup', `${projectStorageKey}.json`); fs.mkdirSync(path.dirname(cleanupReceiptPath), { recursive: true });
    const cleanupReceipt = JSON.stringify({ version: 1, projectId: 'project', pending: [{ relativePath: '团片协作/stale.png', commitId: 'old', artifactId: 'old-artifact', sha256: 'old-digest' }] }); fs.writeFileSync(cleanupReceiptPath, cleanupReceipt);
    const outputCallsBeforeStatus = capabilityCounts.get('project.output') || 0;
    await invoke('team.workflow.status.v1');
    assert.equal(capabilityCounts.get('project.output') || 0, outputCallsBeforeStatus, 'workflow status is a pure read and never drains Host output');
    assert.equal(fs.readFileSync(cleanupReceiptPath, 'utf8'), cleanupReceipt, 'workflow status never rewrites or drops cleanup receipts'); fs.rmSync(cleanupReceiptPath, { force: true });
    const isolatedWorkspace = await invoke('team.project.get.v1');
    assert.equal(isolatedWorkspace.success, true);
    assert.equal((await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 })).state, 'ready');
    const isolatedDb = new DatabaseSync(databasePath);
    assert.equal(isolatedDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE project_id=? AND task_id=?').get('other-project', 'task-1').count, 1, 'draining the current project preserves another project\'s same-id pending task');
    isolatedDb.prepare('DELETE FROM team_workflow_reconcile_pending WHERE project_id=? AND task_id=?').run('other-project', 'task-1');
    isolatedDb.prepare('DELETE FROM team_patch_tasks WHERE project_id=? AND id=?').run('other-project', 'task-1');
    isolatedDb.close();

    const workflowGroups = [
      { week: 1, identityId: 'identity-1', identityName: 'A', items: [{ photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, photoName: '任务一' }] },
      { week: 1, identityId: 'identity-3', identityName: 'C', items: [{ photoId: 'photo', baseVersionId: 'base', taskId: 'task-2', personIndex: 3, photoName: '任务二' }] },
      { week: 2, identityId: 'identity-2', identityName: 'B', items: [{ photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 2, photoName: '任务一' }] },
      { week: 2, identityId: 'identity-4', identityName: 'D', items: [{ photoId: 'photo', baseVersionId: 'base', taskId: 'task-2', personIndex: 4, photoName: '任务二' }] },
    ];
    const generated = await invoke('team.workflow.generate.v1', {
      operationId: 'reconcile-fixture', replace: true,
      preferredIdentityOrder: ['identity-1', 'identity-2', 'identity-3', 'identity-4'],
      groups: workflowGroups,
    });
    assert.equal(generated.success, true, generated.error);
    const confirmationRequired = await invoke('team.workflow.generate.v1', { operationId: 'confirm-existing-fixture', groups: [] });
    assert.equal(confirmationRequired.requiresConfirmation, true);
    assert.equal(confirmationRequired.state, 'awaiting-confirmation', 'confirmation exits the running state so restore/retry is not permanently busy');
    const replacementRetry = await invoke('team.workflow.generate.v1', { operationId: 'replace-existing-fixture', replace: true, groups: workflowGroups });
    assert.equal(replacementRetry.success, true, replacementRetry.error);
    assert.equal(replacementRetry.alreadyRunning, undefined, 'replace retry is not blocked by the prior confirmation job');
    assert(emittedTopics.has('team.workflow.progress.v1'), 'workflow progress reaches the host on its declared plugin event topic');
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    const taskTwoActive = assertActive('task-2', 3, 'ORIGINAL-TASK-TWO');
    assertInactive('task-1', 2);
    assertInactive('task-2', 4);

    const targetedDb = new DatabaseSync(databasePath);
    const queueTargeted = targetedDb.prepare(`INSERT INTO team_workflow_reconcile_pending(project_id,task_id,photo_id,error,attempt_count,next_attempt_at,last_error,history_json,updated_at) VALUES(?,?,?,?,0,0,'','[]',?)`);
    queueTargeted.run('project', 'task-1', 'photo', 'targeted task one', 1);
    queueTargeted.run('project', 'task-2', 'photo', 'unrelated task two', 2);
    targetedDb.close();
    const targetedDrain = await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20, taskIds: ['task-1'] });
    assert.deepEqual({ state: targetedDrain.state, recovered: targetedDrain.recoveredCount, pending: targetedDrain.pendingCount }, { state: 'ready', recovered: 1, pending: 0 }, 'an interactive mutation drains only its own task chain');
    const targetedAfterDb = new DatabaseSync(databasePath);
    assert.equal(targetedAfterDb.prepare("SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE project_id='project' AND task_id='task-1'").get().count, 0);
    assert.equal(targetedAfterDb.prepare("SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE project_id='project' AND task_id='task-2'").get().count, 1, 'targeted drain preserves unrelated pending work');
    targetedAfterDb.prepare("DELETE FROM team_workflow_reconcile_pending WHERE project_id='project' AND task_id='task-2'").run();
    targetedAfterDb.close();

    fs.renameSync(taskTwoActive, `${taskTwoActive}.missing-fixture`);
    const missingActiveOpen = await invoke('team.workflow.open-export.v1', { week: 1, identityId: 'identity-3' });
    assert.equal(missingActiveOpen.state, 'preparing', 'a missing ready task file enters recoverable preparation instead of claiming the week is blocked');
    const queuedOpenDb = new DatabaseSync(databasePath);
    assert.equal(queuedOpenDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE project_id=? AND task_id=?').get('project', 'task-2').count, 1, 'opening queues the exact missing task chain for reconstruction');
    assert.deepEqual(queuedOpenDb.prepare('SELECT attempt_count,next_attempt_at,last_error,history_json FROM team_workflow_reconcile_pending WHERE project_id=? AND task_id=?').get('project', 'task-2'), { attempt_count: 0, next_attempt_at: 0, last_error: '', history_json: '[]' }, 'an explicit user retry wakes the queue without depending on lost SQLite defaults');
    queuedOpenDb.close();
    assert.equal((await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 })).state, 'ready');
    const recoveredActiveOpen = await invoke('team.workflow.open-export.v1', { week: 1, identityId: 'identity-3' });
    assert.equal(recoveredActiveOpen.success, true);
    assert(fs.existsSync(taskTwoActive), 'the queued task folder file is reconstructed from its active chain source');

    const expandedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const taskThreeWeekOne = '第1周/E/任务三_人物5.png';
    const taskThreeWeekTwo = '第2周/F/任务三_人物6.png';
    expandedManifest.groups.push(
      { week: 1, identityId: 'identity-5', identityName: 'E', relativePath: '第1周/E', items: [{ photoId: 'photo-b', baseVersionId: 'base-b', taskId: 'task-3', personIndex: 5, photoName: '任务三', available: true, relativePath: taskThreeWeekOne }] },
      { week: 2, identityId: 'identity-6', identityName: 'F', relativePath: '第2周/F', items: [{ photoId: 'photo-b', baseVersionId: 'base-b', taskId: 'task-3', personIndex: 6, photoName: '任务三', available: false, relativePath: taskThreeWeekTwo }] },
    );
    fs.mkdirSync(path.dirname(path.join(outputDirectory, taskThreeWeekOne)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(outputDirectory, taskThreeWeekTwo)), { recursive: true });
    fs.copyFileSync(taskThreePatch, path.join(outputDirectory, taskThreeWeekOne));
    fs.writeFileSync(manifestPath, JSON.stringify(expandedManifest, null, 2));
    assertActive('task-3', 5, 'ORIGINAL-TASK-THREE');
    assertInactive('task-3', 6);

    const missingManifestBackup = `${manifestPath}.missing-fixture`;
    fs.renameSync(manifestPath, missingManifestBackup);
    const missingManifestDb = new DatabaseSync(databasePath);
    missingManifestDb.prepare(`INSERT INTO team_workflow_reconcile_pending(project_id,task_id,photo_id,error,updated_at) VALUES(?,?,?,?,?)`).run('project', 'task-1', 'photo', 'missing manifest fixture', 0);
    missingManifestDb.close();
    const missingDrain = await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    assert.equal(missingDrain.state, 'preparing');
    const missingAfterDb = new DatabaseSync(databasePath);
    assert.equal(missingAfterDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE task_id=?').get('task-1').count, 1, 'a missing workflow manifest must never drop its durable pending reconcile');
    assert.match(missingAfterDb.prepare('SELECT error FROM team_workflow_reconcile_pending WHERE task_id=?').get('task-1').error, /workflow-missing/, 'the retained pending row records a diagnostic reason');
    const retryDiagnostic = missingAfterDb.prepare('SELECT attempt_count,next_attempt_at,history_json FROM team_workflow_reconcile_pending WHERE task_id=?').get('task-1');
    assert.equal(retryDiagnostic.attempt_count, 1); assert(retryDiagnostic.next_attempt_at > Date.now()); assert.equal(JSON.parse(retryDiagnostic.history_json).length, 1, 'failed reconcile retains bounded diagnostic history');
    missingAfterDb.prepare('UPDATE team_workflow_reconcile_pending SET next_attempt_at=0 WHERE task_id=?').run('task-1');
    missingAfterDb.close();
    fs.renameSync(missingManifestBackup, manifestPath);
    const restoredManifestDrain = await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    assert.equal(restoredManifestDrain.state, 'ready', JSON.stringify(restoredManifestDrain));

    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: true, completionKind: 'no-retouch' });
    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    const taskOneB = assertActive('task-1', 2, 'ORIGINAL-TASK-ONE');
    assertInactive('task-1', 1);
    assert.equal(fs.readFileSync(taskTwoActive, 'utf8'), 'ORIGINAL-TASK-TWO', 'reconciling task one must not alter task two');
    const beforeRepeat = fs.statSync(taskOneB).mtimeMs;
    const beforeNames = fs.readdirSync(path.dirname(taskOneB)).sort();
    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: true, completionKind: 'no-retouch' });
    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    assert.equal(fs.statSync(taskOneB).mtimeMs, beforeRepeat, 'repeated reconciliation reuses the correct published input');
    assert.deepEqual(fs.readdirSync(path.dirname(taskOneB)).sort(), beforeNames, 'repeated reconciliation creates no duplicate files');

    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false });
    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    assertInactive('task-1', 2);
    assertActive('task-2', 3, 'ORIGINAL-TASK-TWO');

    await invoke('team.patch.upload.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    assertActive('task-1', 2, 'RETURNED-BY-A');
    assertInactive('task-1', 1);
    assertActive('task-2', 3, 'ORIGINAL-TASK-TWO');
    const identityDb = new DatabaseSync(databasePath);
    assert.equal(identityDb.prepare(`SELECT identity_id FROM team_person_assignments WHERE photo_id='photo' AND base_version_id='base' AND person_index=1`).get().identity_id, 'identity-1', 'Alice identity survives return upload');
    identityDb.close();

    await invoke('team.patch.remove-upload.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    assertInactive('task-1', 2);
    assertActive('task-2', 3, 'ORIGINAL-TASK-TWO');
    assertInactive('task-2', 4);

    await Promise.all([
      invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: true, completionKind: 'no-retouch' }),
      invoke('team.identity.complete.v1', { photoId: 'photo-b', baseVersionId: 'base-b', taskId: 'task-3', personIndex: 5, completed: true, completionKind: 'no-retouch' }),
    ]);
    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    assertActive('task-1', 2, 'ORIGINAL-TASK-ONE');
    assertActive('task-3', 6, 'ORIGINAL-TASK-THREE');
    await Promise.all([
      invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false }),
      invoke('team.identity.complete.v1', { photoId: 'photo-b', baseVersionId: 'base-b', taskId: 'task-3', personIndex: 5, completed: false }),
    ]);
    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    assertActive('task-3', 5, 'ORIGINAL-TASK-THREE');

    seedReviewMatches('confirm-ignore-lock', [
      { returnId: 'confirm-me', content: 'CONFIRM-ME' },
      { returnId: 'ignore-me', content: 'IGNORE-ME' },
    ]);
    const [lockedConfirm, lockedIgnore] = await Promise.all([
      invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'confirm-ignore-lock', returnId: 'confirm-me', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 }),
      invoke('team.workflow.return-review.ignore.v1', { reviewSessionId: 'confirm-ignore-lock', returnId: 'ignore-me' }),
    ]);
    assert.equal(lockedConfirm.success, true); assert.equal(lockedIgnore.success, true);
    assert.equal(fs.existsSync(reviewDirectory), false, 'confirm and ignore serialize their session updates and retire the completed batch once');
    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false });

    seedReviewMatches('confirm-discard-lock', [
      { returnId: 'confirm-before-discard', content: 'CONFIRM-BEFORE-DISCARD' },
      { returnId: 'discard-me', content: 'DISCARD-ME' },
    ]);
    const [confirmedBeforeDiscard, discardedAfterConfirm] = await Promise.all([
      invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'confirm-discard-lock', returnId: 'confirm-before-discard', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 }),
      invoke('team.workflow.return-review.discard.v1', { reviewSessionId: 'confirm-discard-lock' }),
    ]);
    assert.equal(confirmedBeforeDiscard.success, true); assert.equal(discardedAfterConfirm.success, true);
    assert.equal(fs.existsSync(reviewDirectory), false, 'confirm and discard serialize without resurrecting a stale session');
    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false });

    seedReviewMatches('double-confirm-lock', [
      { returnId: 'double-a', content: 'DOUBLE-A' },
      { returnId: 'double-b', content: 'DOUBLE-B', photoId: 'photo-b', baseVersionId: 'base-b', taskId: 'task-3', personIndex: 5 },
    ]);
    const artifactCountBeforeDouble = (() => { const value = new DatabaseSync(databasePath); try { return value.prepare('SELECT COUNT(*) count FROM team_task_artifacts').get().count; } finally { value.close(); } })();
    const doubleResults = await Promise.all([
      invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'double-confirm-lock', returnId: 'double-a', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 }),
      invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'double-confirm-lock', returnId: 'double-b', photoId: 'photo-b', baseVersionId: 'base-b', taskId: 'task-3', personIndex: 5 }),
    ]);
    assert(doubleResults.every(result => result.success), 'different-photo confirms in one review batch both commit');
    assert.equal(fs.existsSync(reviewDirectory), false, 'the final concurrent confirmation retires exactly one completed review batch');
    const repeatedDouble = await Promise.all([
      invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'double-confirm-lock', returnId: 'double-a', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 }),
      invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'double-confirm-lock', returnId: 'double-b', photoId: 'photo-b', baseVersionId: 'base-b', taskId: 'task-3', personIndex: 5 }),
    ]);
    assert(repeatedDouble.every(result => result.success && result.idempotent), 'lost RPC responses can retry both confirmations without requiring the retired session');
    const artifactCountAfterDouble = (() => { const value = new DatabaseSync(databasePath); try { return value.prepare('SELECT COUNT(*) count FROM team_task_artifacts').get().count; } finally { value.close(); } })();
    assert.equal(artifactCountAfterDouble, artifactCountBeforeDouble + 2, 'idempotent retries never archive duplicate returned artifacts');
    await Promise.all([
      invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false }),
      invoke('team.identity.complete.v1', { photoId: 'photo-b', baseVersionId: 'base-b', taskId: 'task-3', personIndex: 5, completed: false }),
    ]);

    seedReview('session-write-failure', 'SESSION-WRITE-FAILURE');
    const sessionFailureResult = await invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'session-write-failure', returnId: 'session-write-failure', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assert.equal(sessionFailureResult.success, true, 'a post-COMMIT review-session failure must still report the durable confirmation');
    assert.equal(sessionFailureResult.cleanupPending, true, 'the injected session failure is surfaced as recoverable cleanup work');
    const recoveredConfirmation = await invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'session-write-failure', returnId: 'session-write-failure', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assert.equal(recoveredConfirmation.success, true); assert.equal(recoveredConfirmation.idempotent, true);
    assert.equal(fs.existsSync(reviewDirectory), false, 'the durable confirmation journal repairs and retires a stale pending review on retry');
    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false });

    seedReview('retire-failure', 'RETIRE-FAILURE');
    const retireFailure = await invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'retire-failure', returnId: 'retire-failure', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assert.equal(retireFailure.success, true); assert.equal(retireFailure.cleanupPending, true);
    assert.equal(fs.existsSync(reviewDirectory), true, 'a failed background retirement leaves the completed marker available for startup recovery');
    const orphanRetiredDirectory = `${reviewDirectory}.completed-orphan-fixture`;
    fs.mkdirSync(orphanRetiredDirectory, { recursive: true }); fs.writeFileSync(path.join(orphanRetiredDirectory, 'stale'), 'stale');
    const afterCleanupRecovery = await invoke('team.workflow.return-review.get.v1');
    assert.equal(afterCleanupRecovery.review, null);
    assert.equal(fs.existsSync(reviewDirectory), false, 'the next review startup retires a previously completed live directory');
    assert.equal(fs.existsSync(orphanRetiredDirectory), false, 'startup recovery sweeps abandoned .completed-* directories');
    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false });

    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    seedReview('concurrent-return', 'CONCURRENT-RETURN');
    workflowScopeCount = 0;
    const mediaReadsBeforeConfirm = capabilityCounts.get('project.media.variants') || 0;
    const outputCallsBeforeConfirm = capabilityCounts.get('project.output') || 0;
    const confirmation = await invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'concurrent-return', returnId: 'concurrent-return', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assert.equal(confirmation.success, true);
    assert.equal(confirmation.reconcilePending, true, 'manual confirmation returns after durable archival instead of waiting for relay publication');
    assert.match(confirmation.warning, /后台更新/);
    assert.equal(workflowScopeCount, 1, 'manual confirmation resolves component storage only once');
    assert.equal(capabilityCounts.get('project.media.variants') || 0, mediaReadsBeforeConfirm, 'manual confirmation never reloads the project media catalog');
    assert.equal(capabilityCounts.get('project.output') || 0, outputCallsBeforeConfirm, 'manual confirmation never waits for project-output publication');
    const queuedDb = new DatabaseSync(databasePath);
    assert.equal(queuedDb.prepare(`SELECT completed FROM team_person_assignments WHERE photo_id='photo' AND base_version_id='base' AND person_index=1`).get().completed, 1);
    assert.equal(queuedDb.prepare("SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE task_id='task-1'").get().count, 1);
    queuedDb.close();
    holdSecondWorkflowScope = true;
    workflowScopeCount = 0;
    const held = waitForHeldWorkflow();
    const backgroundReconcile = invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    await held;
    let undoResolved = false;
    const concurrentUndo = invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false }).then(value => { undoResolved = true; return value; });
    const undoCommittedBeforeRelease = await Promise.race([
      concurrentUndo.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 2000)),
    ]);
    assert.equal(undoResolved || undoCommittedBeforeRelease, false, 'same-project mutations wait behind the active reconcile lease instead of advancing revision during publication');
    releaseHeldWorkflow();
    await backgroundReconcile;
    await concurrentUndo;
    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    holdSecondWorkflowScope = false;
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    assertInactive('task-1', 2);

    seedReview('recoverable-return', 'RECOVERABLE-RETURN');
    artifactScopeCount = 0;
    const recoverable = await invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'recoverable-return', returnId: 'recoverable-return', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assert.equal(recoverable.success, true, 'a committed return must not be reported as an upload failure');
    assert.equal(recoverable.reconcilePending, true);
    assert.match(recoverable.warning, /后台更新/);
    const pendingDb = new DatabaseSync(databasePath);
    const archived = pendingDb.prepare(`SELECT a.completed,a.artifact_id,r.artifact_path FROM team_person_assignments a JOIN team_task_artifacts r ON r.id=a.artifact_id WHERE a.photo_id='photo' AND a.base_version_id='base' AND a.person_index=1`).get();
    assert.equal(archived.completed, 1);
    assert.equal(fs.readFileSync(archived.artifact_path, 'utf8'), 'RECOVERABLE-RETURN');
    assert.equal(pendingDb.prepare("SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE task_id='task-1'").get().count, 1);
    pendingDb.close();
    const reload = await invoke('team.project.get.v1'); assert.equal(reload.success, true); await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    const recoveredDb = new DatabaseSync(databasePath);
    assert.equal(recoveredDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending').get().count, 0, 'project reload clears a successfully reconciled pending task');
    recoveredDb.close();
    assertActive('task-1', 2, 'RECOVERABLE-RETURN');
    assertInactive('task-1', 1);
    const removedReturn = await invoke('team.patch.remove-upload.v1', { photoId: 'photo', taskId: 'task-1', personIndex: 1 });
    assert.equal(removedReturn.reconcilePending, true);
    const removedPendingDb = new DatabaseSync(databasePath);
    assert.equal(removedPendingDb.prepare("SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE project_id='project' AND task_id='task-1'").get().count, 1, 'removing a return durably queues its relay chain');
    removedPendingDb.close();
    const removedDrain = await invoke('team.workflow.reconcile-drain.v1', { maxItems: 1, taskIds: ['task-1'] });
    assert.deepEqual({ state: removedDrain.state, recovered: removedDrain.recoveredCount, pending: removedDrain.pendingCount }, { state: 'ready', recovered: 1, pending: 0 }, 'the queued return removal can immediately rebuild its targeted relay chain');
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    artifactScopeCount = 0;
    breakManifestOnArtifactCall = 1;
    outputFaultInjected = false;
    const savedNoRetouch = await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: true, completionKind: 'no-retouch' });
    assert.equal(savedNoRetouch.success, true, 'committed no-retouch state must not be reported as a failed operation');
    assert.equal(savedNoRetouch.reconcilePending, true);
    assert.match(savedNoRetouch.warning, /后台更新/);
    const noRetouchPendingDb = new DatabaseSync(databasePath);
    assert.equal(noRetouchPendingDb.prepare(`SELECT completed,completion_kind FROM team_person_assignments WHERE photo_id='photo' AND base_version_id='base' AND person_index=1`).get().completion_kind, 'no-retouch');
    assert.equal(noRetouchPendingDb.prepare("SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE task_id='task-1'").get().count, 1);
    noRetouchPendingDb.close();
    restoreManifestDirectory();
    breakManifestOnArtifactCall = 0;
    const noRetouchReload = await invoke('team.project.get.v1'); assert.equal(noRetouchReload.success, true); await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
    assertActive('task-1', 2, 'ORIGINAL-TASK-ONE');
    const noRetouchRecoveredDb = new DatabaseSync(databasePath);
    assert.equal(noRetouchRecoveredDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending').get().count, 0);
    noRetouchRecoveredDb.close();
    await invoke('team.identity.assign.v1', { photoId: 'photo', baseVersionId: 'base', personIndex: 1, identityId: null, completed: false });
    const cleared = await invoke('team.project.get.v1');
    assert.equal(cleared.assignments.find(item => item.personIndex === 1).identityId, null, 'explicit empty identity assignment restores the unlabelled state');
    assert.equal(cleared.workflowNeedsRegeneration, true, 'changing a generated workflow participant identity must require regeneration after reload');
    console.log('Team-retouch workflow task-chain reconciliation tests passed');
  } finally {
    lines.close();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (error) { if (error.code !== 'EPERM') throw error; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
