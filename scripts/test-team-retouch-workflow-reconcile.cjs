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
const outputDirectory = path.join(projectRoot, '团片协作');
const manifestPath = path.join(dataRoot, 'workflows', 'manifest.json');
const reviewDirectory = path.join(dataRoot, 'reviews');
const deliveryDirectory = path.join(projectRoot, '原始工作图');
const taskOnePatch = path.join(deliveryDirectory, 'task-one.png');
const taskTwoPatch = path.join(deliveryDirectory, 'task-two.png');
const returnedSource = path.join(sandbox, 'returned-a.png');
fs.mkdirSync(deliveryDirectory, { recursive: true });
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
        if (frame.method === 'component.storage.v1') result = { dataRoot, databasePath, projectId: 'project' };
        else if (frame.method === 'project.media.read.v1') result = { items: [bundle] };
        else if (frame.method === 'tasks.report.v1') result = { cancelled: false };
        else if (frame.method === 'dialogs.open.v1') result = { cancelled: false, filePath: returnedSource };
        else if (frame.method === 'project.output.authorize.v1' && frame.payload.operation === 'artifacts') {
          const itemRoot = path.join(dataRoot, 'photo', 'base');
          result = { dataDirectory: itemRoot, analysisDirectory: path.join(itemRoot, 'analysis'), uploadDirectory: path.join(itemRoot, 'uploads'), mergeDirectory: path.join(itemRoot, 'merge'), deliveryDirectory, deliveryPrefix: 'photo' };
        } else if (frame.method === 'project.output.authorize.v1' && frame.payload.action === 'workflow') {
          result = { outputDirectory, manifestPath, reviewDirectory };
        } else if (frame.method === 'project.output.authorize.v1' && frame.payload.action === 'cleanup-workflow-backup') result = { success: true };
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

    await invoke('team.patch.remove-upload.v1', { photoId: 'photo', baseVersionId: 'base', taskId: 'task-1', personIndex: 1 });
    assertActive('task-1', 1, 'ORIGINAL-TASK-ONE');
    assertInactive('task-1', 2);
    assertActive('task-2', 3, 'ORIGINAL-TASK-TWO');
    assertInactive('task-2', 4);
    console.log('Team-retouch workflow task-chain reconciliation tests passed');
  } finally {
    lines.close();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (error) { if (error.code !== 'EPERM') throw error; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
