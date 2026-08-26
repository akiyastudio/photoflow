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
const deliveryDirectory = path.join(dataRoot, 'legacy-work');
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
const inputTokens = new Map(); const outputStages = new Map();
const emittedTopics = new Set();
const capabilityCounts = new Map();
const waitForHeldWorkflow = () => new Promise(resolve => { heldWorkflowResolve = resolve; });
const releaseHeldWorkflow = () => {
  child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: heldWorkflowFrame.id, ok: true, result: { apiVersion: 2, dataPath: dataRoot, databasePath, projectId: 'project', ownership: 'component-private' } })}\n`);
  heldWorkflowFrame = null;
};
const invoke = (method, payload = {}) => new Promise((resolve, reject) => {
  const id = String(nextId++);
  pending.set(id, { resolve, reject, method, payload });
  child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload, context: { componentId: 'team-retouch', componentVersion: 'test', projectId: 'project', projectName: 'Project', projectStatus: 'active' } })}\n`);
});
const ready = new Promise((resolve, reject) => {
  child.once('exit', code => reject(new Error(`service exited ${code}`)));
  lines.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'ready') { resolve(); return; }
    if (frame.type === 'capability') {
      capabilityCounts.set(frame.method, (capabilityCounts.get(frame.method) || 0) + 1);
      let result;
      let error;
      try {
        if (frame.method === 'component.storage.v2') {
          artifactScopeCount += 1;
          workflowScopeCount += 1;
          if (holdSecondWorkflowScope && workflowScopeCount === 1) {
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
          if (breakManifestOnArtifactCall && !outputFaultInjected && frame.payload.action === 'stage') {
            const manifestDirectory = path.dirname(manifestPath); manifestDirectoryBackup = `${manifestDirectory}.backup`;
            fs.renameSync(manifestDirectory, manifestDirectoryBackup); fs.writeFileSync(manifestDirectory, 'block manifest writes'); outputFaultInjected = true;
          }
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
    version: 2, id, status: 'active', result: { matches: [{ returnId: id, path: reviewPath, accepted: false }] },
  }));
};
const seedReviewMatches = (id, matches) => {
  fs.rmSync(reviewDirectory, { recursive: true, force: true });
  fs.mkdirSync(reviewDirectory, { recursive: true });
  const stored = matches.map((match, index) => {
    const reviewPath = path.join(reviewDirectory, `${id}-${index + 1}.png`);
    fs.writeFileSync(reviewPath, match.content);
    return { returnId: match.returnId, path: reviewPath, sourceName: `${match.returnId}.png`, accepted: false };
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
    const insertTask = db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,bbox_json,crop_json,patch_path,members_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    insertTask.run('task-1', 'photo', 'base', 1, '任务一', '{}', '{}', taskOnePatch, JSON.stringify([{ personIndex: 1 }, { personIndex: 2 }]), 1, 1);
    insertTask.run('task-2', 'photo', 'base', 3, '任务二', '{}', '{}', taskTwoPatch, JSON.stringify([{ personIndex: 3 }, { personIndex: 4 }]), 1, 1);
    insertTask.run('task-3', 'photo-b', 'base-b', 5, '任务三', '{}', '{}', taskThreePatch, JSON.stringify([{ personIndex: 5 }, { personIndex: 6 }]), 1, 1);
    insertTask.run('foreign-task', 'foreign-photo', 'foreign-base', 5, '外部项目任务', '{}', '{}', taskOnePatch, JSON.stringify([{ personIndex: 5 }]), 1, 1);
    const insertStage = db.prepare(`INSERT INTO team_task_stages(id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`);
    for (const [taskId, people] of [['task-1', [1, 2]], ['task-2', [3, 4]], ['task-3', [5, 6]]]) for (const [index, personIndex] of people.entries()) insertStage.run(`${taskId}-stage-${personIndex}`, taskId, personIndex, index + 1, 'pending', 1, 1);
    const insertIdentity = db.prepare(`INSERT INTO team_person_identities(id,project_id,name,created_at,updated_at) VALUES(?,?,?,?,?)`);
    const insertAssignment = db.prepare(`INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at,task_id,stage_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const personIndex of [1, 2, 3, 4, 5, 6]) {
      insertIdentity.run(`identity-${personIndex}`, 'project', `人物 ${personIndex}`, 1, 1);
      const taskId = personIndex <= 2 ? 'task-1' : personIndex <= 4 ? 'task-2' : 'task-3';
      insertAssignment.run('project', personIndex <= 4 ? 'photo' : 'photo-b', personIndex <= 4 ? 'base' : 'base-b', personIndex, `identity-${personIndex}`, 1, 'manual', 0, 1, taskId, `${taskId}-stage-${personIndex}`);
    }
    db.exec('COMMIT');
    assert.throws(() => resolveWorkflowTaskBinding(db, 'project', 'foreign-task', [{ item: { photoId: 'legacy-photo', baseVersionId: 'foreign-base' } }]), /不属于当前项目/, 'a stable task id cannot rebind a workflow chain across projects');
    assert.throws(() => resolveWorkflowTaskBinding(db, 'project', 'task-1', [{ item: { photoId: 'legacy-photo', baseVersionId: 'wrong-base' } }]), /错误的照片版本/, 'a legacy photo id never relaxes the exact base-version binding');
    assert.deepEqual(resolveWorkflowTaskBinding(db, 'project', 'task-1', [{ item: { photoId: 'legacy-photo', baseVersionId: 'base' } }]).legacyPhotoIds, ['legacy-photo']);
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
    missingManifestDb.prepare(`INSERT INTO team_workflow_reconcile_pending(task_id,photo_id,error,updated_at) VALUES(?,?,?,?)`).run('task-1', 'photo', 'missing manifest fixture', 0);
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
    assert.equal((await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 })).state, 'ready');

    const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const item of legacyManifest.groups.flatMap(group => group.items || []).filter(item => item.taskId === 'task-1')) item.photoId = 'legacy-photo-id';
    fs.writeFileSync(manifestPath, JSON.stringify(legacyManifest, null, 2));
    const legacyPendingDb = new DatabaseSync(databasePath);
    legacyPendingDb.prepare(`INSERT INTO team_workflow_reconcile_pending(task_id,photo_id,error,updated_at) VALUES(?,?,?,?)`).run('task-1', 'legacy-photo-id', '工作流程 task 链跨越了错误的照片版本', 1);
    legacyPendingDb.close();
    const legacyStatus = await invoke('team.project.get.v1');
    assert.deepEqual({ state: legacyStatus.migration.state, phase: legacyStatus.migration.phase, pending: legacyStatus.migration.maintenancePendingCount }, { state: 'pending', phase: 'workflow-reconcile', pending: 1 });
    await invoke('team.project.migrate-step.v1');
    assert(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).groups.flatMap(group => group.items || []).filter(item => item.taskId === 'task-1').every(item => item.photoId === 'photo'), 'all items in the stable task/base chain are atomically rewritten to the current project photo id');
    const healedDb = new DatabaseSync(databasePath);
    assert.equal(healedDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE task_id=?').get('task-1').count, 0, 'a healed legacy photo id clears its reconcile retry');
    healedDb.prepare(`INSERT INTO team_workflow_reconcile_pending(task_id,photo_id,error,updated_at) VALUES(?,?,?,?)`).run('task-1', 'photo', 'idempotency check', 2);
    healedDb.close();
    const auditPath = path.join(dataRoot, 'command-log', 'operations.ndjson');
    const repairAuditCount = () => fs.readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(item => item.state === 'legacy-photo-id-repaired' && item.taskId === 'task-1').length;
    assert.equal(repairAuditCount(), 1, 'the legacy id repair writes one auditable command record');
    await invoke('team.project.migrate-step.v1');
    assert.equal(repairAuditCount(), 1, 'repeating an already-healed reconciliation has no duplicate repair audit');

    const conflictManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const item of conflictManifest.groups.flatMap(group => group.items || []).filter(item => item.taskId === 'task-2')) { item.photoId = 'legacy-conflict-photo'; item.baseVersionId = 'wrong-base'; }
    fs.writeFileSync(manifestPath, JSON.stringify(conflictManifest, null, 2));
    const rejectedDb = new DatabaseSync(databasePath);
    rejectedDb.prepare(`INSERT INTO team_workflow_reconcile_pending(task_id,photo_id,error,updated_at) VALUES(?,?,?,?)`).run('task-2', 'legacy-conflict-photo', 'version conflict fixture', 3);
    rejectedDb.close();
    await invoke('team.project.migrate-step.v1');
    const rejectedItems = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).groups.flatMap(group => group.items || []).filter(item => item.taskId === 'task-2');
    assert(rejectedItems.every(item => item.photoId === 'legacy-conflict-photo' && item.baseVersionId === 'wrong-base'), 'a base-version conflict rejects the whole chain without partially rewriting photo ids');
    const rejectedStateDb = new DatabaseSync(databasePath);
    assert.match(rejectedStateDb.prepare('SELECT error FROM team_workflow_reconcile_pending WHERE task_id=?').get('task-2').error, /错误的照片版本/);
    rejectedStateDb.prepare('DELETE FROM team_workflow_reconcile_pending WHERE task_id=?').run('task-2');
    rejectedStateDb.prepare(`INSERT INTO team_workflow_reconcile_pending(task_id,photo_id,error,updated_at) VALUES(?,?,?,?)`).run('foreign-task', 'foreign-photo', 'cross-project fixture', 4);
    rejectedStateDb.close();
    await invoke('team.project.migrate-step.v1');
    const crossProjectDb = new DatabaseSync(databasePath);
    assert.equal(crossProjectDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE task_id=?').get('foreign-task').count, 1, 'a foreign-project task id is never drained or rebound by the current project migration');
    crossProjectDb.prepare('DELETE FROM team_workflow_reconcile_pending WHERE task_id=?').run('foreign-task');
    crossProjectDb.close();
    const restoredConflictManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const item of restoredConflictManifest.groups.flatMap(group => group.items || []).filter(item => item.taskId === 'task-2')) { item.photoId = 'photo'; item.baseVersionId = 'base'; }
    fs.writeFileSync(manifestPath, JSON.stringify(restoredConflictManifest, null, 2));

    const laterFailureManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const item of laterFailureManifest.groups.flatMap(group => group.items || []).filter(item => item.taskId === 'task-1')) item.photoId = 'legacy-photo-before-later-failure';
    fs.writeFileSync(manifestPath, JSON.stringify(laterFailureManifest, null, 2));
    const laterFailureDb = new DatabaseSync(databasePath);
    laterFailureDb.prepare(`INSERT INTO team_workflow_reconcile_pending(task_id,photo_id,error,updated_at) VALUES(?,?,?,?)`).run('task-1', 'legacy-photo-before-later-failure', 'retry after legacy id', 3);
    laterFailureDb.close();
    artifactScopeCount = 0;
    breakManifestOnArtifactCall = 2;
    outputFaultInjected = false;
    await invoke('team.project.migrate-step.v1');
    restoreManifestDirectory();
    breakManifestOnArtifactCall = 0;
    const repairedBeforeFailure = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).groups.flatMap(group => group.items || []).filter(item => item.taskId === 'task-1');
    assert(repairedBeforeFailure.every(item => item.photoId === 'photo'), 'the safe photo-id repair is durable even when later artifact reconciliation fails');
    const stillPendingDb = new DatabaseSync(databasePath);
    assert.equal(stillPendingDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE task_id=?').get('task-1').count, 1, 'a later non-binding failure remains queued without rolling back the safe manifest repair');
    stillPendingDb.close();
    await invoke('team.project.migrate-step.v1');

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
      { returnId: 'double-b', content: 'DOUBLE-B' },
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
    const mediaReadsBeforeConfirm = capabilityCounts.get('project.media.variants.v2') || 0;
    const outputCallsBeforeConfirm = capabilityCounts.get('project.output.v2') || 0;
    const confirmation = await invoke('team.workflow.return-confirm.v1', { reviewSessionId: 'concurrent-return', returnId: 'concurrent-return', photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assert.equal(confirmation.success, true);
    assert.equal(confirmation.reconcilePending, true, 'manual confirmation returns after durable archival instead of waiting for relay publication');
    assert.match(confirmation.warning, /后台更新/);
    assert.equal(workflowScopeCount, 1, 'manual confirmation resolves component storage only once');
    assert.equal(capabilityCounts.get('project.media.variants.v2') || 0, mediaReadsBeforeConfirm, 'manual confirmation never reloads the project media catalog');
    assert.equal(capabilityCounts.get('project.output.v2') || 0, outputCallsBeforeConfirm, 'manual confirmation never waits for project-output publication');
    const queuedDb = new DatabaseSync(databasePath);
    assert.equal(queuedDb.prepare(`SELECT completed FROM team_person_assignments WHERE photo_id='photo' AND base_version_id='base' AND person_index=1`).get().completed, 1);
    assert.equal(queuedDb.prepare("SELECT COUNT(*) count FROM team_workflow_reconcile_pending WHERE task_id='task-1'").get().count, 1);
    queuedDb.close();
    holdSecondWorkflowScope = true;
    workflowScopeCount = 0;
    const held = waitForHeldWorkflow();
    const backgroundReconcile = invoke('team.project.migrate-step.v1');
    await held;
    let undoResolved = false;
    const concurrentUndo = invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false }).then(value => { undoResolved = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(undoResolved, true, 'a completion may commit while drain is still reading its queue; the later photo lock must reconcile the newest durable state');
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
    const reload = await invoke('team.project.get.v1'); assert.equal(reload.migration.state, 'pending'); await invoke('team.project.migrate-step.v1');
    const recoveredDb = new DatabaseSync(databasePath);
    assert.equal(recoveredDb.prepare('SELECT COUNT(*) count FROM team_workflow_reconcile_pending').get().count, 0, 'project reload clears a successfully reconciled pending task');
    recoveredDb.close();
    assertActive('task-1', 2, 'RECOVERABLE-RETURN');
    assertInactive('task-1', 1);
    await invoke('team.identity.complete.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1, completed: false });
    await invoke('team.workflow.reconcile-drain.v1', { maxItems: 20 });
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
