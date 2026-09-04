const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const extensionRoot = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'video-transcription-service-'));
const projectRoot = path.join(sandbox, 'project');
const privateRoot = path.join(sandbox, 'private');
fs.mkdirSync(projectRoot, { recursive: true }); fs.mkdirSync(privateRoot, { recursive: true });
const testModelRoot = path.join(extensionRoot, 'models', 'tiny');
const createdTestModel = !fs.existsSync(testModelRoot);
if (createdTestModel) { fs.mkdirSync(testModelRoot, { recursive: true }); for (const name of ['config.json', 'model.bin', 'tokenizer.json']) fs.writeFileSync(path.join(testModelRoot, name), name === 'model.bin' ? 'fixture' : '{}'); }

const sources = {
  good: path.join(projectRoot, 'Library', 'clip.mp4'),
  slow: path.join(projectRoot, 'Library', 'slow.mp4'),
  slowPanel: path.join(projectRoot, 'Library', 'slow-panel.mp4'),
  reconcile: path.join(projectRoot, 'Library', 'reconcile.mp4'),
};
fs.mkdirSync(path.dirname(sources.good), { recursive: true });
fs.writeFileSync(sources.good, '第一条字幕\n可搜索字幕');
fs.writeFileSync(sources.slow, 'SLOW_TRANSCRIPTION\n不应完成');
fs.writeFileSync(sources.slowPanel, 'SLOW_TRANSCRIPTION\n后台取消');
fs.writeFileSync(sources.reconcile, '完成状态恢复');
fs.writeFileSync(path.join(projectRoot, 'manual.srt'), '\uFEFF1\n00:00:03,000 --> 00:00:04,000\n手工字幕\n');

const child = spawn(process.execPath, [path.join(extensionRoot, 'service.cjs')], {
  cwd: extensionRoot, stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, PHOTOFLOW_TRANSCRIBER_EXECUTABLE: process.execPath, PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX: JSON.stringify([path.join(__dirname, 'fake-transcriber.cjs')]) },
});
const pending = new Map(); const requestProjects = new Map(); const tokens = new Map(); const taskState = new Map(); const stages = new Map(); const receipts = new Map(); const idempotency = new Map(); const capabilityCalls = [];
let nextId = 1; let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
const request = (method, payload = {}, projectId = 'project-test', selection = []) => new Promise((resolve, reject) => { const id = `req-${nextId++}`; pending.set(id, { resolve, reject }); requestProjects.set(id, projectId); send({ type: 'request', id, method, payload, context: { surface: 'project', projectId, projectName: projectId, scopeRelativePath: '', selectedRelativePaths: selection } }); });
const relative = file => path.relative(projectRoot, file).replace(/\\/g, '/');
const walkFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => { const file = path.join(directory, entry.name); return entry.isDirectory() ? walkFiles(file) : [file]; });
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const receiptFor = (commitId, output) => ({  commitId, outputs: [output] });

const capability = async frame => {
  const payload = frame.payload || {}; const projectId = requestProjects.get(frame.parentId) || 'project-test'; capabilityCalls.push({ method: frame.method, payload, projectId });
  if (frame.method === 'component.settings') return {  revision: 1, settings: { language: 'zh', model: 'tiny', device: 'cpu', computeType: 'int8', beamSize: 2, vadFilter: true, simplifyChinese: true, cpuFallback: true } };
  if (frame.method === 'project.media.page') {
    const items = walkFiles(projectRoot).filter(file => /\.(?:mp4|mov|mkv)$/i.test(file)).map(file => ({ name: path.basename(file), relativePath: relative(file), mediaRef: { relativePath: relative(file) }, kind: 'video' }));
    return {  items, page: { hasMore: false, cursor: null } };
  }
  if (frame.method === 'project.files.page') {
    const items = walkFiles(projectRoot).filter(file => !/\.(?:mp4|mov|mkv)$/i.test(file)).map(file => { const stat = fs.statSync(file); return { name: path.basename(file), relativePath: relative(file), kind: 'file', extension: path.extname(file).toLowerCase(), size: stat.size, updatedAt: stat.mtimeMs }; });
    return {  items, page: { hasMore: false, cursor: null, pageSize: 200, truncated: false } };
  }
  if (frame.method === 'project.media.variants') { const source = path.join(projectRoot, payload.relativePath); if (!fs.existsSync(source)) throw new Error('media missing'); const token = `test-input:${crypto.randomUUID()}`; tokens.set(token, source); return {  input: { token, expiresAt: Date.now() + 60_000 }, variants: {} }; }
  if (frame.method === 'project.input.tokens') { const source = tokens.get(payload.token); if (!source) throw new Error('expired token'); const directory = path.join(privateRoot, 'inputs', crypto.randomUUID()); fs.mkdirSync(directory, { recursive: true }); const privatePath = path.join(directory, path.basename(source)); fs.copyFileSync(source, privatePath); return {  inputId: path.basename(directory), privatePath, byteLength: fs.statSync(privatePath).size }; }
  if (frame.method === 'tasks') { const key = `${projectId}:${payload.operationId}`; const state = taskState.get(key) || { cancelled: false, actions: [] }; state.actions.push(payload.action); if (payload.action === 'cancel') state.cancelled = true; if (['start', 'resume'].includes(payload.action)) state.cancelled = false; taskState.set(key, state); return {  task: { state: payload.action }, cancelled: state.cancelled, checkpoint: payload.checkpoint || {} }; }
  if (frame.method === 'component.events') return {  emitted: true };
  if (frame.method === 'project.output') {
    if (payload.action === 'stage') { const stageId = crypto.randomUUID(); const privatePath = path.join(privateRoot, 'stages', stageId); fs.mkdirSync(privatePath, { recursive: true }); stages.set(stageId, { privatePath }); return {  stageId, privatePath, expiresAt: Date.now() + 60_000 }; }
    if (payload.action === 'adopt') { const item = payload.outputs[0]; const filePath = path.join(projectRoot, item.relativePath); if (!fs.existsSync(filePath)) throw new Error('missing adoption source'); const bytes = fs.readFileSync(filePath); const commitId = crypto.randomUUID(); const output = { artifactId: crypto.randomUUID(), relativePath: item.relativePath, size: bytes.length, sha256: digest(bytes) }; const receipt = receiptFor(commitId, output); receipts.set(commitId, receipt); return receipt; }
    if (payload.action === 'materializeOwned') { const receipt = receipts.get(payload.commitId); const output = receipt?.outputs.find(item => item.artifactId === payload.artifactId); if (!output) throw new Error('unknown output'); const directory = path.join(privateRoot, 'reads', crypto.randomUUID()); fs.mkdirSync(directory, { recursive: true }); const privatePath = path.join(directory, path.basename(output.relativePath)); fs.copyFileSync(path.join(projectRoot, output.relativePath), privatePath); return {  privatePath, byteLength: fs.statSync(privatePath).size, sha256: output.sha256, outputRef: { commitId: payload.commitId, artifactId: payload.artifactId } }; }
    if (payload.action === 'write') { const stage = stages.get(payload.stageId); const bytes = fs.readFileSync(path.join(stage.privatePath, payload.sourceName)); const target = path.join(projectRoot, payload.outputRelativePath); if (fs.existsSync(target)) { assert.equal(payload.replace, true, 'existing SRT requires a controlled replacement'); const old = receipts.get(payload.previousCommitId)?.outputs.find(item => item.artifactId === payload.previousArtifactId); assert(old && old.sha256 === payload.expectedDigest && old.sha256 === digest(fs.readFileSync(target)), 'replacement digest must own the current SRT'); } else assert.equal(payload.replace, undefined); stage.output = { artifactId: crypto.randomUUID(), relativePath: payload.outputRelativePath, size: bytes.length, sha256: digest(bytes), bytes }; return {  stageId: payload.stageId, artifactId: stage.output.artifactId, byteLength: bytes.length }; }
    if (payload.action === 'validate') return {  stageId: payload.stageId, valid: true, fileCount: 1, totalBytes: stages.get(payload.stageId).output.size };
    if (payload.action === 'commit') { if (idempotency.has(payload.idempotencyKey)) return idempotency.get(payload.idempotencyKey); const stage = stages.get(payload.stageId); const target = path.join(projectRoot, stage.output.relativePath); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, stage.output.bytes); const commitId = crypto.randomUUID(); const receipt = receiptFor(commitId, { ...stage.output, bytes: undefined }); receipts.set(commitId, receipt); idempotency.set(payload.idempotencyKey, receipt); fs.rmSync(stage.privatePath, { recursive: true, force: true }); stages.delete(payload.stageId); if (stage.output.relativePath === 'Library/reconcile.srt') await new Promise(resolve => setTimeout(resolve, 2200)); return receipt; }
    if (payload.action === 'rollback') { const stage = stages.get(payload.stageId); if (stage) fs.rmSync(stage.privatePath, { recursive: true, force: true }); stages.delete(payload.stageId); return {  stageId: payload.stageId, rolledBack: true }; }
  }
  if (frame.method === 'dialogs') return {  opened: true, outputRef: { commitId: payload.commitId, artifactId: payload.artifactId } };
  throw new Error(`Unhandled capability ${frame.method}`);
};

readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'ready') { readyResolve(); return; }
  if (frame.type === 'response') { const item = pending.get(frame.id); if (!item) return; pending.delete(frame.id); requestProjects.delete(frame.id); frame.ok ? item.resolve(frame.result) : item.reject(new Error(frame.error)); return; }
  if (frame.type === 'capability') Promise.resolve(capability(frame)).then(result => send({ type: 'capability-response', id: frame.id, ok: true, result }), error => send({ type: 'capability-response', id: frame.id, ok: false, error: error.message, errorCode: error.code || 'COMPONENT_HOST_INTERNAL' }));
});
const assertPublic = value => { const serialized = JSON.stringify(value); assert(!serialized.includes(sandbox)); assert(!serialized.includes('privatePath')); };

(async () => {
  try {
    await ready;
    const preview = await request('transcript.selection.preview.v1', { relativePaths: ['Library'] }); assert.deepEqual(preview.files.map(file => file.relativeName).sort(), ['Library/clip.mp4', 'Library/reconcile.mp4', 'Library/slow-panel.mp4', 'Library/slow.mp4']);
    const started = await request('transcript.project.start.v1', { relativePaths: ['Library/clip.mp4'] }); assertPublic(started);
    const completed = await request('transcript.operation.run.v1', { operationId: started.operationId }); assert.equal(completed.state, 'completed'); assert.equal(completed.succeeded, 1); assertPublic(completed);
    const progressEvents = capabilityCalls.filter(call => call.method === 'component.events' && call.payload.event?.operationId === started.operationId).map(call => call.payload.event); assert(progressEvents.some(event => event.state === 'running' && event.file?.progress > 0), 'algorithm progress emits a live component event'); assert.equal(progressEvents.at(-1)?.state, 'completed', 'the final component event announces completion');
    assert(progressEvents.some(event => event.state === 'running' && event.file?.state === 'running' && event.file.progress === 0), 'the current file is visible while its input is being prepared');
    const outputPath = path.join(projectRoot, 'Library', 'clip.srt'); assert(fs.existsSync(outputPath), 'SRT is committed directly beside its video'); assert.match(fs.readFileSync(outputPath, 'utf8'), /可搜索字幕/);
    assert(!fs.existsSync(path.join(privateRoot, 'storage.sqlite3')), 'the component creates no user database'); assert.equal(capabilityCalls.some(call => call.method === 'component.storage'), false, 'the component never requests database storage');

    const detail = await request('transcript.file.get.v1', { fileId: completed.files[0].id }); assert.equal(detail.segments.length, 2); assert.equal(detail.segments[0].text, '第一条字幕');
    const listed = await request('transcript.operation.list.v1'); const library = listed.operations.find(item => item.id === 'srt-library'); assert.equal(library.total, 2, 'library directly traverses generated and manual SRT files');
    const libraryDetail = await request('transcript.operation.get.v1', { operationId: 'srt-library' }); assert(libraryDetail.operation.files.some(file => file.relativeName === 'manual.srt'));
    const all = await request('transcript.operation.transcript.page.v1', { operationId: completed.id, pageSize: 200 }); assert(all.items.some(item => item.text === '手工字幕'), 'browse-all traverses every project SRT, not only the current task');
    const searched = await request('transcript.search.v1', { query: '手工' }); assert.equal(searched.results[0].relativeName, 'manual.srt');

    fs.writeFileSync(sources.good, '替换后的字幕');
    const replaceStart = await request('transcript.project.start.v1', { relativePaths: ['Library/clip.mp4'] }); const replaced = await request('transcript.operation.run.v1', { operationId: replaceStart.operationId }); assert.equal(replaced.state, 'completed'); assert.match(fs.readFileSync(outputPath, 'utf8'), /替换后的字幕/); assert(capabilityCalls.some(call => call.method === 'project.output' && call.payload.action === 'write' && call.payload.replace === true), 'repeat transcription safely replaces the existing SRT');

    const reconcileStart = await request('transcript.project.start.v1', { relativePaths: ['Library/reconcile.mp4'] }); const reconcileRun = request('transcript.operation.run.v1', { operationId: reconcileStart.operationId }); const reconcileOutput = path.join(projectRoot, 'Library', 'reconcile.srt'); for (let attempt = 0; attempt < 50 && !fs.existsSync(reconcileOutput); attempt += 1) await new Promise(resolve => setTimeout(resolve, 20)); assert(fs.existsSync(reconcileOutput), 'the SRT becomes visible before the delayed commit response'); await new Promise(resolve => setTimeout(resolve, 1600)); const reconciled = await request('transcript.operation.get.v1', { operationId: reconcileStart.operationId }); assert.equal(reconciled.operation.state, 'completed', 'a freshly published SRT recovers a stale final in-memory state'); assert.equal(reconciled.operation.files[0].state, 'completed'); await reconcileRun;

    const cancelStart = await request('transcript.project.start.v1', { relativePaths: ['Library/slow.mp4'] }); const cancelRun = request('transcript.operation.run.v1', { operationId: cancelStart.operationId }); await new Promise(resolve => setTimeout(resolve, 180)); const cancelAt = Date.now(); await request('transcript.operation.cancel.v1', { operationId: cancelStart.operationId }); const cancelled = await cancelRun; assert.equal(cancelled.state, 'cancelled'); assert(Date.now() - cancelAt < 1200, 'page cancellation terminates the active algorithm process promptly'); assert(!fs.existsSync(path.join(projectRoot, 'Library', 'slow.srt')), 'cancel rolls back the unfinished SRT');

    const panelStart = await request('transcript.project.start.v1', { relativePaths: ['Library/slow-panel.mp4'] }); const panelRun = request('transcript.operation.run.v1', { operationId: panelStart.operationId }); await new Promise(resolve => setTimeout(resolve, 250)); const panelCancelAt = Date.now(); taskState.get(`project-test:${panelStart.operationId}`).cancelled = true; const panelCancelled = await panelRun; assert.equal(panelCancelled.state, 'cancelled'); assert(Date.now() - panelCancelAt < 1200, 'Host background-task cancellation is observed independently of transcription progress'); assert(!fs.existsSync(path.join(projectRoot, 'Library', 'slow-panel.srt')));

    await assert.rejects(request('transcript.operation.get.v1', { operationId: completed.id }, 'project-other'), /找不到/);
    console.log('video-transcription direct SRT persistence, filesystem browsing, safe replacement, and immediate background cancellation tests passed');
  } finally { child.kill(); fs.rmSync(sandbox, { recursive: true, force: true }); if (createdTestModel) fs.rmSync(testModelRoot, { recursive: true, force: true }); }
})().catch(error => { console.error(error); child.kill(); fs.rmSync(sandbox, { recursive: true, force: true }); if (createdTestModel) fs.rmSync(testModelRoot, { recursive: true, force: true }); process.exitCode = 1; });
