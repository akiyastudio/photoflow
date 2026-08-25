const assert = require('assert');
// Plugin-owned regression test.
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
if (args[0] === 'identify') { const manifest = JSON.parse(fs.readFileSync(value('--manifest'), 'utf8')); console.log(JSON.stringify({ clusters: [], similarities: [], unmatchedCount: manifest.subjects.length, method: 'fixture' })); process.exit(0); }
if (args[0] === 'detect-batch') {
  console.log(JSON.stringify({ type: 'progress', progress: 35, message: 'batch-progress' }));
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
console.log(JSON.stringify({ type: 'progress', progress: 25, message: 'detect-progress' }));
const target = path.join(value('--delivery-dir'), value('--delivery-prefix') + '_人物01.png');
fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'patch');
if (value('--input').includes('fail')) process.exit(9);
console.log(JSON.stringify({ detector: 'fake-child', personCount: 1, tasks: [{ id: 'task-1', personIndex: 1, bbox: { x: 1, y: 1, width: 10, height: 10 }, crop: { x: 0, y: 0, width: 20, height: 20 }, patchPath: target }] }));
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
        if (frame.method === 'component.storage.v2') result = { apiVersion: 2, dataPath: dataRoot, databasePath, projectId: 'project-1', ownership: 'component-private' };
        else if (frame.method === 'component.settings.v2') result = { apiVersion: 2, revision: 1, settings: { useGpu: false, oversizeCropMode: 'expand' } };
        else if (frame.method === 'component.events.v2') { emittedTopics.add(frame.payload.topic); emittedEvents.push(frame.payload); result = { apiVersion: 2, emitted: true }; }
        else if (frame.method === 'tasks.v2') result = { apiVersion: 2, task: null, cancelled: false };
        else if (frame.method === 'dialogs.v2') result = { apiVersion: 2, cancelled: false, inputs: [{ name: path.basename(returnedInputPath), token: `test-input:${returnedInputPath}`, expiresAt: Date.now() + 1000 }] };
        else if (frame.method === 'project.input.tokens.v2') { materializeCount += 1; const source = frame.payload.token.slice('test-input:'.length); const inputId = crypto.randomUUID(); const directory = path.join(dataRoot, 'inputs', inputId); fs.mkdirSync(directory, { recursive: true }); const privatePath = path.join(directory, path.basename(source)); fs.copyFileSync(source, privatePath); result = { apiVersion: 2, inputId, privatePath, byteLength: fs.statSync(privatePath).size }; }
        else if (frame.method === 'project.media.variants.v2') {
          const requested = frame.payload.relativePath;
          let photoId = frame.payload.photoId || (requested === 'two.jpg' ? 'photo-2' : 'photo-1');
          if (!['photo-1', 'photo-2'].includes(photoId)) throw new Error('outside the bound project');
          const versionId = frame.payload.versionId || (photoId === 'photo-2' ? 'version-2' : 'version-1');
          const filePath = requested ? (requested === 'two.jpg' ? secondBasePath : basePath) : currentBasePath;
          result = { apiVersion: 2, mediaRef: { photoId, versionId, relativePath: requested || 'one.jpg' }, metadata: { photoId, versionId, currentVersionId: versionId, displayName: photoId === 'photo-2' ? 'Second' : 'Base', originalName: path.basename(filePath), relativePath: requested || 'one.jpg', isCurrent: true, fileMissing: false }, variants: { original: { url: 'test', byteLength: 4, derived: false } }, input: { token: `test-input:${filePath}`, expiresAt: Date.now() + 1000 } };
        } else if (frame.method === 'project.output.v2') {
          if (frame.payload.action === 'stage') { const stageId = crypto.randomUUID(); const privatePath = path.join(dataRoot, 'stages', stageId); fs.mkdirSync(privatePath, { recursive: true }); outputStages.set(stageId, { privatePath, files: [] }); result = { apiVersion: 2, stageId, privatePath, expiresAt: Date.now() + 60000 }; }
          else if (frame.payload.action === 'adopt') throw new Error('legacy output missing');
          else if (frame.payload.action === 'write') { if (frame.payload.replace) controlledReplacementWrites += 1; const stage = outputStages.get(frame.payload.stageId); stage.files.push(frame.payload); result = { apiVersion: 2, stageId: frame.payload.stageId, artifactId: crypto.randomUUID(), byteLength: fs.statSync(path.join(stage.privatePath, frame.payload.sourceName)).size }; }
          else if (frame.payload.action === 'validate') result = { apiVersion: 2, stageId: frame.payload.stageId, valid: true, fileCount: outputStages.get(frame.payload.stageId).files.length, totalBytes: 1 };
          else if (frame.payload.action === 'commit') { const replay = outputByIdempotencyKey.get(frame.payload.idempotencyKey); if (replay) result = replay; else { const stage = outputStages.get(frame.payload.stageId); const commitId = crypto.randomUUID(); const outputs = stage.files.map(file => { const filePath = path.join(projectOutputRoot, file.outputRelativePath); fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.copyFileSync(path.join(stage.privatePath, file.sourceName), filePath); return { artifactId: crypto.randomUUID(), relativePath: file.outputRelativePath, filePath, sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }; }); result = { apiVersion: 2, commitId, idempotencyKey: frame.payload.idempotencyKey, outputs }; outputReceipts.set(commitId, result); outputByIdempotencyKey.set(frame.payload.idempotencyKey, result); } }
          else if (frame.payload.action === 'materializeOwned') { const output = outputReceipts.get(frame.payload.commitId).outputs.find(item => item.artifactId === frame.payload.artifactId); const importId = crypto.randomUUID(); const directory = path.join(dataRoot, 'imported-outputs', importId); fs.mkdirSync(directory, { recursive: true }); const privatePath = path.join(directory, path.basename(output.filePath)); fs.copyFileSync(output.filePath, privatePath); result = { apiVersion: 2, importId, privatePath, byteLength: fs.statSync(privatePath).size, sha256: output.sha256, outputRef: { commitId: frame.payload.commitId, artifactId: frame.payload.artifactId } }; }
          else if (frame.payload.action === 'rollback') { const stage = outputStages.get(frame.payload.stageId); if (stage) fs.rmSync(stage.privatePath, { recursive: true, force: true }); outputStages.delete(frame.payload.stageId); result = { apiVersion: 2, stageId: frame.payload.stageId, rolledBack: true }; }
          else throw new Error(`unexpected output action ${frame.payload.action}`);
        } else if (frame.method === 'project.progress.v2') result = { apiVersion: 2, progress: [{ id: 'progress-2', mediaKind: 'image', contentRef: { relativeDirectory: 'merged' } }], edges: [] };
        else if (frame.method === 'version.create.v2') { result = versionsByIdempotencyKey.get(frame.payload.idempotencyKey); if (!result) { result = { apiVersion: 2, versionId: crypto.randomUUID(), result: { success: true, photo: { id: frame.payload.photoId }, versions: [] } }; versionsByIdempotencyKey.set(frame.payload.idempotencyKey, result); } }
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
    assert.equal(controlledReplacementWrites - replacementsBeforeRepeat, 2, 'regenerated working images use Host V2 controlled replacement ownership');
    const beforeIdentityMaterialize = materializeCount;
    const suggested = await invoke('team.identity.suggest.v1');
    assert.equal(suggested.success, true);
    assert.equal(materializeCount - beforeIdentityMaterialize, 2, 'identity batching materializes each unique photo/version exactly once');
    assert.equal(fs.readdirSync(path.join(dataRoot, 'inputs')).length, 0, 'identity batch inputs are removed after the operation');
    const selectedReturns = await invoke('team.patch.select-returns.v1');
    const returned = await invoke('team.patch.return-batch.v1', { operationId: 'return-progress-test', returnedFiles: selectedReturns.files, relativePaths: ['one.jpg'] });
    assert.equal(returned.acceptedCount, 1, `return matching consumes V2 selector tokens and archives into component-private storage: ${JSON.stringify(returned)}`);
    assert(emittedTopics.has('team.return.progress.v1'), 'return progress reaches the declared V2 event topic');
    const returnProgress = emittedEvents.filter(item => item.topic === 'team.return.progress.v1').map(item => item.event);
    assert(returnProgress.length >= 8, `return processing must report real multi-phase progress: ${JSON.stringify(returnProgress)}`);
    assert(returnProgress.every(item => item.operationId === 'return-progress-test'), 'every return progress event is scoped to its renderer operation');
    assert(returnProgress.some(item => item.phase === 'reading' && item.progress > 0), 'return progress covers input reading');
    assert(returnProgress.some(item => item.phase === 'matching' && item.progress > 40 && item.progress < 82 && /\u6bd4\u5bf9\u56fe\u7247/.test(item.message)), 'matcher stdout progress is forwarded continuously instead of discarded');
    assert(returnProgress.some(item => item.phase === 'importing' && item.progress > 82), 'return progress covers archive writes');
    assert.deepEqual({ state: returnProgress.at(-1).state, phase: returnProgress.at(-1).phase, progress: returnProgress.at(-1).progress }, { state: 'completed', phase: 'complete', progress: 100 }, 'return progress terminates at a real 100% completion event');
    const faultDb = new DatabaseSync(databasePath); faultDb.exec(`CREATE TRIGGER fail_merge_db_update BEFORE UPDATE OF status ON team_patch_tasks WHEN NEW.status='merged' BEGIN SELECT RAISE(ABORT,'injected merge DB failure'); END;`); faultDb.close();
    await assert.rejects(invoke('team.patch.merge.v1', { photoId: 'photo-1', baseVersionId: 'version-1', outputProgressId: 'progress-2' }), /injected merge DB failure/);
    const repairDb = new DatabaseSync(databasePath); repairDb.exec('DROP TRIGGER fail_merge_db_update'); repairDb.close();
    const merged = await invoke('team.patch.merge.v1', { photoId: 'photo-1', baseVersionId: 'version-1', outputProgressId: 'progress-2' });
    const replayed = await invoke('team.patch.merge.v1', { photoId: 'photo-1', baseVersionId: 'version-1', outputProgressId: 'progress-2' });
    assert.equal(replayed.merge.versionId, merged.merge.versionId, 'identical merge input reuses the stable version id after crash recovery');
    assert.equal([...outputByIdempotencyKey.keys()].filter(key => key.startsWith('merge-')).length, 1, 'merge crash retry creates one committed output receipt');
    assert.equal([...versionsByIdempotencyKey.keys()].filter(key => key.startsWith('merge-version-')).length, 1, 'merge crash retry creates one version');
    assert.equal(fs.readdirSync(path.join(projectOutputRoot, 'merged')).length, 1, 'stable merge output name prevents duplicate project files');
    assert.equal(outputStages.size, 0, 'commit replay and success both clean their redundant output stages');
    assert(emittedTopics.has('team.patch.detect.progress.v1') && emittedTopics.has('team.patch.detect-batch.progress.v1'), 'single and batch detection events retain distinct declared V2 topics');
    console.log('Team-retouch mutation subprocess, privilege, and rollback tests passed');
  } finally {
    lines.close(); child.kill(); fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
