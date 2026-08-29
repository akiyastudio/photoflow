const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const {
  TERMINAL_STATES, normalizeSettings,
  isSupportedMediaName, cleanName, cleanRelativeName, redactError, srtNameFor,
  openDatabase, operationSnapshot,
} = require('./core.cjs');

const pendingCapabilities = new Map();
const activeRequests = new Map();
const runningOperations = new Map();
const databaseCache = new Map();
let nextCapabilityId = 1;
const writeFrame = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const callHost = (parentId, method, payload = {}) => new Promise((resolve, reject) => {
  const id = `cap-${nextCapabilityId++}`;
  pendingCapabilities.set(id, { parentId: String(parentId), resolve, reject });
  writeFrame({ type: 'capability', id, parentId: String(parentId), method, payload });
});
const capabilityError = frame => Object.assign(new Error(String(frame.error || 'Host capability failed')), { code: frame.errorCode || 'COMPONENT_HOST_INTERNAL' });
const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const storageFor = async parentId => {
  const storage = await callHost(parentId, 'component.storage.v7', {});
  if (!storage?.databasePath || !storage?.dataPath || storage.ownership !== 'component-private') throw new Error('组件私有存储尚未就绪');
  const databasePath = path.resolve(storage.databasePath);
  let db = databaseCache.get(databasePath);
  if (!db) { db = openDatabase(databasePath); databaseCache.set(databasePath, db); }
  return { db, dataPath: path.resolve(storage.dataPath), databasePath, projectId: String(storage.projectId || '') };
};
const readSettings = async parentId => {
  const response = await callHost(parentId, 'component.settings.v7', { action: 'get' });
  return normalizeSettings(response.settings);
};
const saveSettings = async (parentId, patch) => {
  const current = await readSettings(parentId);
  const settings = normalizeSettings({ ...current, ...(patch || {}) });
  const result = await callHost(parentId, 'component.settings.v7', { action: 'replace', settings });
  return { settings: normalizeSettings(result.settings), revision: result.revision };
};

const runtimeFromArgs = () => {
  const values = process.argv.slice(2);
  const commandIndex = Math.max(values.indexOf('--photoflow-development-command'), values.indexOf('--photoflow-algorithm-command'));
  if (commandIndex < 0) return null;
  const command = String(values[commandIndex + 1] || '').trim();
  const argsPrefix = [];
  for (let index = 0; index < values.length; index += 1) if (['--photoflow-development-arg', '--photoflow-algorithm-arg-prefix'].includes(values[index])) argsPrefix.push(String(values[index + 1] || ''));
  return command ? { command, argsPrefix, source: 'host-development' } : null;
};
const resolveRuntime = () => {
  const host = runtimeFromArgs();
  if (host) return host;
  const explicit = String(process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE || '').trim();
  if (explicit) {
    let argsPrefix = [];
    try { argsPrefix = JSON.parse(process.env.PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX || '[]'); } catch { /* diagnosed when launched */ }
    return { command: explicit, argsPrefix: Array.isArray(argsPrefix) ? argsPrefix.map(String).slice(0, 16) : [], source: 'environment' };
  }
  const packaged = path.join(__dirname, '_internal', process.platform === 'win32' ? 'transcriber.exe' : 'transcriber');
  if (fs.statSync(packaged, { throwIfNoEntry: false })?.isFile()) return { command: packaged, argsPrefix: [], source: 'packaged' };
  const configuredPython = String(process.env.PHOTOFLOW_TRANSCRIPTION_PYTHON || '').trim();
  const app3Python = process.platform === 'win32' ? 'C:\\dev\\app3\\.venv\\Scripts\\python.exe' : '';
  const python = configuredPython || (app3Python && fs.existsSync(app3Python) ? app3Python : process.platform === 'win32' ? 'py' : 'python3');
  return { command: python, argsPrefix: [...(python === 'py' ? ['-3'] : []), '-u', path.join(__dirname, 'engine.py')], source: configuredPython ? 'environment-python' : app3Python && fs.existsSync(app3Python) ? 'app3-development' : 'system-python' };
};
const spawnRuntime = (runtime, extraArgs = []) => spawn(runtime.command, [...runtime.argsPrefix, ...extraArgs], {
  cwd: __dirname, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(runtime.command),
  env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
});
const runtimeStatus = () => new Promise(resolve => {
  const runtime = resolveRuntime();
  let settled = false; let stdout = ''; let stderr = '';
  let child;
  try { child = spawnRuntime(runtime, ['--diagnose']); }
  catch (error) { resolve({ ready: false, source: runtime.source, message: redactError(error) }); return; }
  const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
  const timer = setTimeout(() => { child.kill(); finish({ ready: false, source: runtime.source, message: '算法运行时诊断超时' }); }, 8000);
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.on('error', error => finish({ ready: false, source: runtime.source, message: `无法启动算法运行时：${redactError(error)}` }));
  child.on('exit', code => {
    const frames = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const result = frames.find(frame => frame.type === 'diagnostic-result');
    finish(result ? { ready: result.ready === true, source: runtime.source, missing: result.missing || [], packaged: result.packaged === true, message: result.ready ? '算法运行时可用' : `缺少依赖：${(result.missing || []).join(', ')}` } : { ready: false, source: runtime.source, message: redactError(stderr || `算法运行时退出码 ${code}`) });
  });
});

const insertOperation = (db, projectId, sourceKind, settings, files, operationId = crypto.randomUUID()) => {
  if (!projectId) throw new Error('组件存储未绑定项目');
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO transcript_operations(id,project_id,state,source_kind,total,created_at,updated_at,settings_json) VALUES(?,?,?,?,?,?,?,?)').run(operationId, projectId, 'queued', sourceKind, files.length, now, now, JSON.stringify(settings));
    const insert = db.prepare('INSERT INTO transcript_files(id,operation_id,ordinal,display_name,relative_name,source_kind,media_ref_json,private_path,state,error) VALUES(?,?,?,?,?,?,?,?,?,?)');
    files.forEach((file, ordinal) => insert.run(crypto.randomUUID(), operationId, ordinal, cleanName(file.name || file.relativeName), cleanRelativeName(file.relativeName || file.name), sourceKind, JSON.stringify(file.mediaRef || {}), String(file.privatePath || ''), file.state || 'pending', file.error || ''));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return operationId;
};
const startHostTask = (parentId, operationId, total) => callHost(parentId, 'tasks.v7', { action: 'start', operationId, title: '视频转文字', message: `等待处理 ${total} 个视频文件`, progress: 0, checkpoint: { nextOrdinal: 0, total } });
const validateMaterializedPath = (dataPath, response) => {
  const privatePath = path.resolve(String(response?.privatePath || ''));
  if (!inside(dataPath, privatePath) || privatePath === path.resolve(dataPath)) throw new Error('宿主返回了无效的组件私有输入');
  return privatePath;
};
const normalizeProjectRelativePath = value => {
  const raw = String(value || '').replace(/\\/g, '/').trim().replace(/\/+$/, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) return '';
  const parts = raw.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return '';
  return parts.map(cleanName).join('/').slice(0, 1024);
};
const isWithinProjectScope = (relativeName, scopeRelativePath) => {
  if (!scopeRelativePath) return true;
  const name = relativeName.toLocaleLowerCase('en-US');
  const scope = scopeRelativePath.toLocaleLowerCase('en-US');
  return name === scope || name.startsWith(`${scope}/`);
};
const collectProjectMedia = async (parentId, payload, context) => {
  // The Host-provided page context is forwarded by the renderer in current Component
  // Service V1 frames. Older hosts may still attach the selection to service context.
  const requestedInput = Array.isArray(payload?.relativePaths) ? payload.relativePaths
    : Array.isArray(context?.selectedRelativePaths) ? context.selectedRelativePaths : [];
  const requested = [...new Map(requestedInput.slice(0, 2000).map(normalizeProjectRelativePath).filter(Boolean).map(value => [value.toLocaleLowerCase('en-US'), value])).values()];
  if (!requested.length) return [];
  const rawScope = payload?.scopeRelativePath ?? context?.scopeRelativePath;
  const scopeRelativePath = normalizeProjectRelativePath(rawScope);
  if (rawScope && !scopeRelativePath) throw new Error('当前选择范围无效');
  if (requested.some(value => !isWithinProjectScope(value, scopeRelativePath))) throw new Error('当前选择超出文件页面范围');

  const requestedKeys = requested.map(value => value.toLocaleLowerCase('en-US'));
  const files = []; const seenMedia = new Set();
  let cursor = null; let pages = 0;
  do {
    const page = await callHost(parentId, 'project.media.page.v7', { pageSize: 200, cursor, kinds: ['video'] });
    pages += 1;
    for (const item of Array.isArray(page?.items) ? page.items : []) {
      const relativeName = normalizeProjectRelativePath(item?.relativePath || item?.name);
      if (!relativeName || !isSupportedMediaName(relativeName) || !isWithinProjectScope(relativeName, scopeRelativePath)) continue;
      const key = relativeName.toLocaleLowerCase('en-US');
      if (!requestedKeys.some(selected => key === selected || key.startsWith(`${selected}/`)) || seenMedia.has(key)) continue;
      seenMedia.add(key);
      files.push({ name: cleanName(item?.name || path.posix.basename(relativeName)), relativeName, mediaRef: item?.mediaRef || { relativePath: relativeName } });
      if (files.length >= 2000) break;
    }
    cursor = page?.page?.hasMore ? String(page.page.cursor || '') : null;
  } while (cursor && files.length < 2000 && pages < 1000);
  return files;
};
const startProjectOperation = async (parentId, payload, context) => {
  const [storage, settings, files] = await Promise.all([storageFor(parentId), readSettings(parentId), collectProjectMedia(parentId, payload, context)]);
  if (!files.length) throw new Error('当前选择中没有可处理的视频文件');
  const operationId = insertOperation(storage.db, storage.projectId, 'project-media', settings, files);
  await startHostTask(parentId, operationId, files.length);
  return { accepted: true, operationId, operation: operationSnapshot(storage.db, storage.projectId, operationId) };
};

const materializeProjectFile = async (parentId, dataPath, row) => {
  const mediaRef = JSON.parse(row.media_ref_json || '{}');
  const variant = await callHost(parentId, 'project.media.variants.v7', { ...mediaRef, variants: ['original'] });
  if (!variant.input?.token) throw new Error('项目媒体没有可用的受限输入令牌');
  const materialized = await callHost(parentId, 'project.input.tokens.v7', { action: 'materialize', token: variant.input.token });
  return validateMaterializedPath(dataPath, materialized);
};
const removePrivateInput = async (storage, candidate) => {
  const resolvedRoot = path.resolve(storage.dataPath); const resolved = path.resolve(String(candidate || ''));
  const relative = path.relative(resolvedRoot, resolved); const first = relative.split(path.sep)[0]?.toLowerCase();
  if (!relative || first !== 'inputs' || !inside(resolvedRoot, resolved) || resolved === path.resolve(storage.databasePath) || path.extname(resolved).toLowerCase() === '.srt') return false;
  const stat = await fs.promises.lstat(resolved).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return true;
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const [realRoot, realCandidate] = await Promise.all([fs.promises.realpath(resolvedRoot), fs.promises.realpath(resolved)]);
  if (!inside(realRoot, realCandidate)) return false;
  await fs.promises.unlink(resolved);
  const parent = path.dirname(resolved); const parentStat = await fs.promises.lstat(parent).catch(() => null);
  if (parentStat?.isDirectory() && !parentStat.isSymbolicLink() && inside(path.join(resolvedRoot, 'inputs'), await fs.promises.realpath(parent).catch(() => ''))) await fs.promises.rmdir(parent).catch(() => undefined);
  return true;
};
const createEngineSession = ({ operationId, signal }) => {
  const runtime = resolveRuntime(); const child = spawnRuntime(runtime); const pending = new Map();
  let stderr = ''; let closed = false; let closeResolve; const closedPromise = new Promise(resolve => { closeResolve = resolve; });
  const cancel = () => { if (!child.killed) child.kill(); };
  const rejectPending = error => { const items = [...pending.values()]; pending.clear(); for (const item of items) item.progressChain.then(() => item.rejectOnce(item.progressError || error), item.rejectOnce); };
  const operationRun = runningOperations.get(operationId);
  if (operationRun) Object.assign(operationRun, { child, killChild: cancel });
  signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    const item = pending.get(String(frame.requestId || '')); if (!item) return;
    if (frame.type === 'progress' || frame.type === 'diagnostic') {
      item.progressChain = item.progressChain.then(() => item.onProgress(frame.type === 'progress' ? Math.max(0, Math.min(99, Number(frame.progress) || 0)) : null, frame.type === 'diagnostic' ? String(frame.message || '') : ''))
        .catch(error => { item.progressError ||= error; cancel(); });
    } else if (frame.type === 'result' || frame.type === 'error') {
      pending.delete(item.requestId);
      item.progressChain.then(() => {
        if (item.progressError) item.rejectOnce(item.progressError);
        else if (frame.type === 'error') item.rejectOnce(new Error(redactError(frame.message || '算法运行失败')));
        else item.resolveOnce(frame);
      });
    }
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}\n${chunk.toString('utf8')}`.slice(-4000); });
  child.stdin.on('error', error => { if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) stderr = `${stderr}\n${error.message}`; });
  child.on('error', error => { stderr = `无法启动转录运行时：${redactError(error)}`; rejectPending(new Error(stderr)); });
  child.on('close', code => {
    if (closed) return; closed = true; signal.removeEventListener('abort', cancel); lines.close();
    const error = signal.aborted ? Object.assign(new Error('识别已取消'), { code: 'CANCELLED' }) : new Error(redactError(stderr || `转录运行时退出码 ${code}`));
    rejectPending(error); closeResolve();
  });
  return {
    child,
    transcribe: (row, settings, outputPath, onProgress) => new Promise((resolve, reject) => {
      if (closed) { reject(new Error('转录运行时已经退出')); return; }
      const requestId = row.id; let settled = false;
      const item = { requestId, onProgress, progressChain: Promise.resolve(), progressError: null,
        resolveOnce: value => { if (!settled) { settled = true; resolve(value); } },
        rejectOnce: error => { if (!settled) { settled = true; reject(error); } } };
      pending.set(requestId, item);
      child.stdin.write(`${JSON.stringify({ type: 'transcribe', requestId, inputPath: row.private_path, outputPath, options: settings })}\n`, error => {
        if (error) { pending.delete(requestId); item.rejectOnce(new Error(`转录运行时输入失败：${redactError(error)}`)); cancel(); }
      });
    }),
    close: async () => { if (!closed && !child.stdin.destroyed) child.stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`); await closedPromise; },
    cancel,
  };
};
const runEngine = async ({ row, settings, outputPath, signal, onProgress }) => {
  const session = createEngineSession({ operationId: row.operation_id, signal });
  try { return await session.transcribe(row, settings, outputPath, onProgress); }
  finally { await session.close(); }
};
const replaceSegments = (db, fileId, segments) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM transcript_segments WHERE file_id=?').run(fileId);
    const insert = db.prepare('INSERT INTO transcript_segments(file_id,seq,start,end,text) VALUES(?,?,?,?,?)');
    for (const [index, item] of (Array.isArray(segments) ? segments : []).entries()) insert.run(fileId, index + 1, Math.max(0, Number(item.start) || 0), Math.max(0, Number(item.end) || 0), String(item.text || '').slice(0, 10000));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
};
const refreshCounts = (db, projectId, operationId) => {
  const counts = db.prepare("SELECT COUNT(*) total, SUM(f.state='completed') succeeded, SUM(f.state='failed') failed FROM transcript_files f JOIN transcript_operations o ON o.id=f.operation_id WHERE f.operation_id=? AND o.project_id=?").get(operationId, projectId);
  db.prepare('UPDATE transcript_operations SET total=?,succeeded=?,failed=?,updated_at=? WHERE id=? AND project_id=?').run(Number(counts.total) || 0, Number(counts.succeeded) || 0, Number(counts.failed) || 0, Date.now(), operationId, projectId);
  return counts;
};
const emitProgress = (parentId, snapshot, file) => callHost(parentId, 'component.events.v7', { topic: 'transcript.operation.progress.v1', event: { operationId: snapshot.id, state: snapshot.state, total: snapshot.total, succeeded: snapshot.succeeded, failed: snapshot.failed, file: file ? { id: file.id, displayName: file.displayName, state: file.state, progress: file.progress } : null } }).catch(() => undefined);
const runOperation = async (parentId, payload, context) => {
  const operationId = String(payload.operationId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(operationId)) throw new Error('无效的 operationId');
  const storage = await storageFor(parentId); const { db, dataPath, projectId } = storage;
  const operation = db.prepare('SELECT * FROM transcript_operations WHERE id=? AND project_id=?').get(operationId, projectId);
  if (!operation) throw new Error('找不到识别任务');
  const runKey = `${projectId}\0${operationId}`; const existing = runningOperations.get(runKey);
  if (existing) return { accepted: true, operationId, alreadyRunning: true };
  if (TERMINAL_STATES.has(operation.state) && operation.state !== 'cancelled') return operationSnapshot(db, projectId, operationId);
  const control = new AbortController(); activeRequests.set(parentId, control);
  const running = { parentId, control, cancel: () => control.abort() }; runningOperations.set(runKey, running);
  let engine = null;
  try {
    db.prepare("UPDATE transcript_operations SET state='running',error='',updated_at=? WHERE id=? AND project_id=?").run(Date.now(), operationId, projectId);
    await callHost(parentId, 'tasks.v7', { action: 'resume', operationId, title: '视频转文字', message: '正在恢复转写', checkpoint: { nextOrdinal: 0, total: operation.total } });
    const settings = normalizeSettings(JSON.parse(operation.settings_json || '{}'));
    const rows = db.prepare(`SELECT f.* FROM transcript_files f JOIN transcript_operations o ON o.id=f.operation_id
      WHERE f.operation_id=? AND o.project_id=? AND (f.state IN ('pending','running') OR (f.state='failed' AND (f.private_path!='' OR f.source_kind='project-media'))) ORDER BY f.ordinal`).all(operationId, projectId);
    for (const row of rows) {
      if (control.signal.aborted) break;
      const task = await callHost(parentId, 'tasks.v7', { action: 'status', operationId });
      if (task.cancelled) { control.abort(); break; }
      try {
        if (!row.private_path) {
          if (row.source_kind !== 'project-media') throw new Error('外部输入副本不可用，请重新选择文件');
          row.private_path = await materializeProjectFile(parentId, dataPath, row);
          db.prepare('UPDATE transcript_files SET private_path=? WHERE id=?').run(row.private_path, row.id);
        }
        const outputDirectory = path.join(dataPath, 'subtitles', operationId);
        await fs.promises.mkdir(outputDirectory, { recursive: true });
        const outputPath = path.join(outputDirectory, `${row.id}.srt`);
        db.prepare("UPDATE transcript_files SET state='running',progress=0,error='' WHERE id=?").run(row.id);
        engine ||= createEngineSession({ operationId: runKey, signal: control.signal });
        const result = await engine.transcribe(row, settings, outputPath, async (progress, message = '') => {
          if (progress !== null) db.prepare('UPDATE transcript_files SET progress=? WHERE id=?').run(progress, row.id);
          const completedBefore = db.prepare("SELECT COUNT(*) count FROM transcript_files f JOIN transcript_operations o ON o.id=f.operation_id WHERE f.operation_id=? AND o.project_id=? AND f.state IN ('completed','failed')").get(operationId, projectId).count;
          const overall = ((Number(completedBefore) + (Number(progress) || 0) / 100) / Math.max(1, operation.total)) * 100;
          const report = await callHost(parentId, 'tasks.v7', { action: 'report', operationId, progress: overall, phase: 'transcribing', message: message || `正在识别 ${row.display_name}`, checkpoint: { nextOrdinal: row.ordinal, currentFileId: row.id, total: operation.total } });
          if (report.cancelled) control.abort();
        });
        replaceSegments(db, row.id, result.segments);
        db.prepare("UPDATE transcript_files SET state='completed',progress=100,error='',language=?,srt_path=?,segment_count=? WHERE id=?").run(String(result.language || ''), outputPath, result.segments.length, row.id);
        if (await removePrivateInput(storage, row.private_path)) db.prepare("UPDATE transcript_files SET private_path='' WHERE id=?").run(row.id);
      } catch (error) {
        if (row.source_kind === 'project-media' && row.private_path && await removePrivateInput(storage, row.private_path).catch(() => false)) db.prepare("UPDATE transcript_files SET private_path='' WHERE id=?").run(row.id);
        if (control.signal.aborted || error.code === 'CANCELLED') break;
        if (String(error.code || '').startsWith('COMPONENT_')) throw error;
        db.prepare("UPDATE transcript_files SET state='failed',progress=100,error=? WHERE id=?").run(redactError(error), row.id);
      }
      refreshCounts(db, projectId, operationId);
      const current = operationSnapshot(db, projectId, operationId); await emitProgress(parentId, current, current.files.find(file => file.id === row.id));
    }
    if (engine) { await engine.close(); engine = null; }
    refreshCounts(db, projectId, operationId);
    const counts = db.prepare('SELECT total,succeeded,failed FROM transcript_operations WHERE id=? AND project_id=?').get(operationId, projectId);
    let state; let message;
    if (control.signal.aborted) { state = 'cancelled'; message = '识别已取消，可从 checkpoint 恢复'; }
    else if (counts.failed === 0) { state = 'completed'; message = `全部 ${counts.succeeded} 个文件识别完成`; }
    else if (counts.succeeded > 0) { state = 'partial_failure'; message = `${counts.succeeded} 个完成，${counts.failed} 个失败`; }
    else { state = 'failed'; message = `${counts.failed} 个文件全部识别失败`; }
    db.prepare('UPDATE transcript_operations SET state=?,error=?,updated_at=? WHERE id=? AND project_id=?').run(state, state === 'failed' ? message : '', Date.now(), operationId, projectId);
    if (state === 'cancelled') await callHost(parentId, 'tasks.v7', { action: 'cancel', operationId });
    else if (state === 'failed') await callHost(parentId, 'tasks.v7', { action: 'fail', operationId, error: message });
    else await callHost(parentId, 'tasks.v7', { action: 'complete', operationId, message });
    const snapshot = operationSnapshot(db, projectId, operationId); await emitProgress(parentId, snapshot, null); return snapshot;
  } catch (error) {
    db.prepare("UPDATE transcript_files SET state='pending',progress=0 WHERE operation_id=? AND state='running' AND operation_id IN (SELECT id FROM transcript_operations WHERE project_id=?)").run(operationId, projectId);
    db.prepare("UPDATE transcript_operations SET state='queued',error=?,updated_at=? WHERE id=? AND project_id=?").run(redactError(error), Date.now(), operationId, projectId);
    throw error;
  } finally {
    if (engine) { engine.cancel(); await engine.close().catch(() => undefined); }
    if (activeRequests.get(parentId) === control) activeRequests.delete(parentId);
    if (runningOperations.get(runKey) === running) runningOperations.delete(runKey);
  }
};

const publishOutput = async (parentId, payload) => {
  const { db, projectId } = await storageFor(parentId); const fileId = String(payload.fileId || '');
  const row = db.prepare('SELECT f.*,o.source_kind FROM transcript_files f JOIN transcript_operations o ON o.id=f.operation_id WHERE f.id=? AND o.project_id=?').get(fileId, projectId);
  if (!row || row.state !== 'completed' || !row.srt_path || !fs.existsSync(row.srt_path)) throw new Error('字幕尚未生成');
  const content = fs.readFileSync(row.srt_path); const sha256 = crypto.createHash('sha256').update(content).digest('hex'); const size = content.length;
  const previous = JSON.parse(row.output_json || '{}');
  if (previous.commitId && previous.artifactId && previous.sha256 === sha256) return { published: true, fileId, output: previous, idempotent: true, message: previous.controlled ? '外部输入无法原路旁写；字幕已发布到当前 PhotoFlow 项目的受控输出。' : '同名 SRT 已发布到项目媒体旁。' };
  const stage = await callHost(parentId, 'project.output.v7', { action: 'stage' });
  const srtName = srtNameFor(row.relative_name);
  const outputRelativePath = row.source_kind === 'project-media' ? srtName : cleanRelativeName(`视频字幕/${row.operation_id}/${srtName}`);
  try {
    const replacement = previous.commitId && previous.artifactId && previous.sha256
      ? { replace: true, previousCommitId: previous.commitId, previousArtifactId: previous.artifactId, expectedDigest: previous.sha256 }
      : {};
    await callHost(parentId, 'project.output.v7', { action: 'write', stageId: stage.stageId, name: path.posix.basename(srtName), outputRelativePath, base64: content.toString('base64'), ...replacement });
    await callHost(parentId, 'project.output.v7', { action: 'validate', stageId: stage.stageId });
    const committed = await callHost(parentId, 'project.output.v7', { action: 'commit', stageId: stage.stageId, idempotencyKey: `srt-${row.id}-${sha256}` });
    const artifact = committed.outputs?.[0]; const output = { commitId: committed.commitId, artifactId: artifact?.artifactId, relativePath: artifact?.relativePath || outputRelativePath, sha256: artifact?.sha256 || sha256, size: Number(artifact?.size ?? artifact?.byteLength ?? size), controlled: row.source_kind !== 'project-media' };
    db.prepare(`UPDATE transcript_files SET output_json=? WHERE id=? AND operation_id IN (SELECT id FROM transcript_operations WHERE project_id=?)`).run(JSON.stringify(output), row.id, projectId);
    return { published: true, fileId, output, message: output.controlled ? '外部输入无法原路旁写；字幕已发布到当前 PhotoFlow 项目的受控输出。' : '同名 SRT 已发布到项目媒体旁。' };
  } catch (error) { await callHost(parentId, 'project.output.v7', { action: 'rollback', stageId: stage.stageId }).catch(() => undefined); throw error; }
};
const openOutput = async (parentId, payload) => {
  const { db, projectId } = await storageFor(parentId); const row = db.prepare('SELECT f.output_json FROM transcript_files f JOIN transcript_operations o ON o.id=f.operation_id WHERE f.id=? AND o.project_id=?').get(String(payload.fileId || ''), projectId);
  const output = JSON.parse(row?.output_json || '{}');
  if (!output.commitId || !output.artifactId) throw new Error('请先发布字幕');
  await callHost(parentId, 'dialogs.v7', { kind: payload.reveal ? 'revealOutput' : 'openOutput', commitId: output.commitId, artifactId: output.artifactId });
  return { opened: true, fileId: String(payload.fileId || '') };
};
const search = async (parentId, payload) => {
  const { db, projectId } = await storageFor(parentId); const query = String(payload.query || '').trim().slice(0, 200); const limit = Math.min(200, Math.max(1, Number(payload.limit) || 100));
  if (!query) return { query, results: [] };
  const like = `%${query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const rows = db.prepare(`SELECT f.id file_id,f.display_name,f.relative_name,s.seq,s.start,s.end,s.text FROM transcript_segments s JOIN transcript_files f ON f.id=s.file_id JOIN transcript_operations o ON o.id=f.operation_id WHERE o.project_id=? AND s.text LIKE ? ESCAPE '\\' ORDER BY f.display_name COLLATE NOCASE,s.start LIMIT ?`).all(projectId, like, limit);
  return { query, results: rows.map(row => ({ fileId: row.file_id, displayName: row.display_name, relativeName: row.relative_name, seq: row.seq, start: row.start, end: row.end, text: row.text })) };
};
const getFile = async (parentId, payload) => {
  const { db, projectId } = await storageFor(parentId); const row = db.prepare('SELECT f.* FROM transcript_files f JOIN transcript_operations o ON o.id=f.operation_id WHERE f.id=? AND o.project_id=?').get(String(payload.fileId || ''), projectId);
  if (!row) throw new Error('找不到字幕文件');
  const segments = db.prepare('SELECT seq,start,end,text FROM transcript_segments WHERE file_id=? ORDER BY seq LIMIT 5000').all(row.id);
  return { file: require('./core.cjs').publicFile(row), segments };
};
const cancelOperation = async (parentId, payload) => {
  const operationId = String(payload.operationId || ''); const { db, projectId } = await storageFor(parentId);
  if (!db.prepare('SELECT 1 FROM transcript_operations WHERE id=? AND project_id=?').get(operationId, projectId)) throw new Error('找不到识别任务');
  runningOperations.get(`${projectId}\0${operationId}`)?.cancel();
  db.prepare("UPDATE transcript_operations SET state='cancelled',updated_at=? WHERE id=? AND project_id=? AND state NOT IN ('completed','partial_failure','failed')").run(Date.now(), operationId, projectId);
  await callHost(parentId, 'tasks.v7', { action: 'cancel', operationId }).catch(() => undefined);
  return operationSnapshot(db, projectId, operationId);
};

const handlers = {
  'transcript.project.start.v1': startProjectOperation,
  'transcript.operation.run.v1': runOperation,
  'transcript.operation.list.v1': async parentId => { const { db, projectId } = await storageFor(parentId); return { operations: db.prepare('SELECT id FROM transcript_operations WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId).map(row => operationSnapshot(db, projectId, row.id, false)) }; },
  'transcript.operation.get.v1': async (parentId, payload) => { const { db, projectId } = await storageFor(parentId); const operation = operationSnapshot(db, projectId, String(payload.operationId || '')); if (!operation) throw new Error('找不到识别任务'); return { operation }; },
  'transcript.operation.cancel.v1': cancelOperation,
  'transcript.operation.resume.v1': async (parentId, payload) => { const { db, projectId } = await storageFor(parentId); const operationId = String(payload.operationId || ''); if (!db.prepare('SELECT 1 FROM transcript_operations WHERE id=? AND project_id=?').get(operationId, projectId)) throw new Error('找不到识别任务'); db.prepare("UPDATE transcript_operations SET state='queued',updated_at=? WHERE id=? AND project_id=? AND state IN ('cancelled','failed','partial_failure')").run(Date.now(), operationId, projectId); await callHost(parentId, 'tasks.v7', { action: 'resume', operationId, title: '视频转文字', message: '准备恢复转写', checkpoint: { resumed: true } }); return { accepted: true, operationId }; },
  'transcript.search.v1': search,
  'transcript.file.get.v1': getFile,
  'transcript.output.publish.v1': publishOutput,
  'transcript.output.open.v1': openOutput,
  'transcript.settings.get.v1': async parentId => ({ settings: await readSettings(parentId) }),
  'transcript.settings.update.v1': saveSettings,
  'transcript.runtime.status.v1': async () => runtimeStatus(),
};

const startService = () => {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    if (frame?.type === 'capability-response') {
      const pending = pendingCapabilities.get(String(frame.id || '')); if (!pending) return;
      pendingCapabilities.delete(String(frame.id)); frame.ok === false ? pending.reject(capabilityError(frame)) : pending.resolve(frame.result); return;
    }
    if (frame?.type === 'cancel') { activeRequests.get(String(frame.id || ''))?.abort(); return; }
    if (frame?.type !== 'request') return;
    const id = String(frame.id || ''); const handler = handlers[String(frame.method || '')];
    Promise.resolve().then(() => { if (!handler) throw new Error('未知的视频字幕服务方法'); return handler(id, frame.payload || {}, frame.context || {}); })
      .then(result => writeFrame({ type: 'response', id, ok: true, result }))
      .catch(error => writeFrame({ type: 'response', id, ok: false, error: redactError(error), errorCode: error.code === 'CANCELLED' ? 'COMPONENT_SERVICE_CANCELLED' : 'COMPONENT_SERVICE_REQUEST_FAILED', retryable: !TERMINAL_STATES.has(error.code) }));
  });
  writeFrame({ type: 'ready', protocolVersion: 1 });
};
if (require.main === module) startService();
process.once('exit', () => { for (const value of runningOperations.values()) value.cancel(); for (const db of databaseCache.values()) db.close(); });
module.exports = { startService, handlers, resolveRuntime, runtimeStatus, runEngine, createEngineSession, removePrivateInput, collectProjectMedia };
