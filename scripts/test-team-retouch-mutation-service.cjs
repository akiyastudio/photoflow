const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

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
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.writeFileSync(basePath, 'base');
fs.writeFileSync(failingBasePath, 'base');
fs.writeFileSync(secondBasePath, 'base');
fs.writeFileSync(enginePath, `
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1];
if (args[0] === 'detect-batch') {
  const countPath = ${JSON.stringify(batchCountPath)};
  fs.writeFileSync(countPath, String(Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0) + 1));
  const manifest = JSON.parse(fs.readFileSync(value('--manifest'), 'utf8'));
  const results = manifest.items.map((item, index) => {
    const target = path.join(item.deliveryDir, item.deliveryPrefix + '_人物01.png');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'patch');
    return { success: true, key: item.key, detector: 'fake-batch', personCount: 1, tasks: [{ id: 'batch-task-' + index, personIndex: 1, bbox: { x: 1, y: 1, width: 10, height: 10 }, crop: { x: 0, y: 0, width: 20, height: 20 }, patchPath: target }] };
  });
  console.log(JSON.stringify({ success: true, results, persistentBackend: true, requestedMode: 'auto' })); process.exit(0);
}
if (args[0] !== 'detect') process.exit(3);
const target = path.join(value('--delivery-dir'), value('--delivery-prefix') + '_人物01.png');
fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'patch');
if (value('--input').includes('fail')) process.exit(9);
console.log(JSON.stringify({ detector: 'fake-child', personCount: 1, tasks: [{ id: 'task-1', personIndex: 1, bbox: { x: 1, y: 1, width: 10, height: 10 }, crop: { x: 0, y: 0, width: 20, height: 20 }, patchPath: target }] }));
`);

let currentBasePath = basePath;
const child = spawn(process.execPath, [path.join(__dirname, '..', 'extensions', 'team-retouch', 'service.cjs')], {
  env: { SystemRoot: process.env.SystemRoot, PHOTOFLOW_TEAM_TEST_ENGINE: enginePath, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
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
        if (frame.method === 'component.storage.v1') result = { dataRoot, databasePath };
        else if (frame.method === 'component.settings.v1') result = { success: true, settings: { useGpu: false, oversizeCropMode: 'expand' } };
        else if (frame.method === 'tasks.report.v1') result = { reported: true, cancelled: false };
        else if (frame.method === 'project.media.read.v1') {
          if (frame.payload.relativePaths) {
            result = { items: [
              { relativePath: 'one.jpg', photo: { id: 'photo-1', projectId: 'project-1', currentVersionId: 'version-1', displayName: 'Base' }, versions: [{ id: 'version-1', filePath: basePath, isCurrent: true }] },
              { relativePath: 'two.jpg', photo: { id: 'photo-2', projectId: 'project-1', currentVersionId: 'version-2', displayName: 'Second' }, versions: [{ id: 'version-2', filePath: secondBasePath, isCurrent: true }] },
            ] };
          } else {
          if (frame.payload.photoIds?.some(id => id !== 'photo-1')) throw new Error('outside the bound project');
          result = { items: [{ photo: { id: 'photo-1', projectId: 'project-1', currentVersionId: 'version-1', displayName: 'Base' }, versions: [{ id: 'version-1', filePath: currentBasePath, isCurrent: true }] }] };
          }
        } else if (frame.method === 'project.output.authorize.v1') {
          if (!['photo-1', 'photo-2'].includes(frame.payload.photoId)) throw new Error('outside the bound project');
          const itemRoot = path.join(dataRoot, frame.payload.photoId, frame.payload.baseVersionId);
          result = { dataDirectory: itemRoot, analysisDirectory: path.join(itemRoot, 'analysis'), uploadDirectory: path.join(itemRoot, 'uploads'), mergeDirectory: path.join(itemRoot, 'merge'), deliveryDirectory: path.join(deliveryDirectory, frame.payload.photoId), deliveryPrefix: frame.payload.photoId };
        } else throw new Error(`unexpected capability ${frame.method}`);
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
    assert(!JSON.stringify(detected).includes(deliveryDirectory), 'service responses must not disclose authorized host paths');
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
    console.log('Team-retouch mutation subprocess, privilege, and rollback tests passed');
  } finally {
    lines.close(); child.kill(); fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
