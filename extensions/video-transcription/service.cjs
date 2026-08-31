const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const {
  TERMINAL_STATES, WHISPER_MODELS, WHISPER_MODEL_IDS, normalizeSettings,
  isSupportedMediaName, cleanName, cleanRelativeName, redactError, srtNameFor,
  parseSrt, publicFile, operationSnapshot,
} = require('./core.cjs');

const LIBRARY_OPERATION_ID = 'srt-library';
const pendingCapabilities = new Map();
const activeRequests = new Map();
const operations = new Map();
const runningOperations = new Map();
let nextCapabilityId = 1;
const writeFrame = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const callHost = (parentId, method, payload = {}) => new Promise((resolve, reject) => {
  const id = `cap-${nextCapabilityId++}`;
  pendingCapabilities.set(id, { parentId: String(parentId), resolve, reject });
  writeFrame({ type: 'capability', id, parentId: String(parentId), method, payload });
});
const capabilityError = frame => Object.assign(new Error(String(frame.error || 'Host capability failed')), { code: frame.errorCode || 'COMPONENT_HOST_INTERNAL' });
const projectIdFor = context => {
  const projectId = String(context?.projectId || '');
  if (!projectId) throw new Error('当前页面未绑定项目');
  return projectId;
};
const operationKey = (projectId, operationId) => `${projectId}\0${operationId}`;
const getOperation = (context, operationId) => operations.get(operationKey(projectIdFor(context), String(operationId || '')));
const readSettings = async parentId => normalizeSettings((await callHost(parentId, 'component.settings', { action: 'get' })).settings);

const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const MODEL_ROOT = path.join(__dirname, 'models');
const resolveSafeModelRoot = (componentRoot = __dirname, modelRoot = path.join(componentRoot, 'models')) => {
  if (path.resolve(modelRoot) !== path.join(path.resolve(componentRoot), 'models')) return '';
  try { const realComponent = fs.realpathSync(componentRoot); const realRoot = fs.realpathSync(modelRoot); return inside(realComponent, realRoot) && realComponent !== realRoot ? realRoot : ''; } catch { return ''; }
};
const isCompleteModelDirectory = modelId => {
  if (!WHISPER_MODEL_IDS.has(modelId)) return false;
  const candidate = path.join(MODEL_ROOT, modelId);
  if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) return false;
  const realRoot = resolveSafeModelRoot(); if (!realRoot) return false; let realCandidate;
  try { realCandidate = fs.realpathSync(candidate); } catch { return false; }
  if (!inside(realRoot, realCandidate) || realRoot === realCandidate) return false;
  return ['config.json', 'model.bin', 'tokenizer.json'].every(name => {
    const file = path.join(realCandidate, name); if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
    try { return inside(realCandidate, fs.realpathSync(file)); } catch { return false; }
  });
};
const listModels = () => ({ models: WHISPER_MODELS.map(item => ({ ...item, installed: isCompleteModelDirectory(item.id) })), placement: 'models/<model-id>', directory: MODEL_ROOT, downloadPolicy: 'manual-only' });
const saveSettings = async (parentId, patch) => {
  const settings = normalizeSettings({ ...(await readSettings(parentId)), ...(patch || {}) });
  if (patch && Object.hasOwn(patch, 'model')) {
    const requested = String(patch.model || '').trim();
    if (!WHISPER_MODEL_IDS.has(requested)) throw new Error('不支持的语音识别模型');
    if (!isCompleteModelDirectory(requested)) throw new Error(`模型 ${requested} 未安装；请将完整模型放入插件 models/${requested} 目录`);
  }
  const result = await callHost(parentId, 'component.settings', { action: 'replace', settings });
  return { settings: normalizeSettings(result.settings), revision: result.revision };
};

const runtimeFromArgs = () => {
  const values = process.argv.slice(2); const commandIndex = Math.max(values.indexOf('--photoflow-development-command'), values.indexOf('--photoflow-algorithm-command'));
  if (commandIndex < 0) return null;
  const command = String(values[commandIndex + 1] || '').trim(); const argsPrefix = [];
  for (let index = 0; index < values.length; index += 1) if (['--photoflow-development-arg', '--photoflow-algorithm-arg-prefix'].includes(values[index])) argsPrefix.push(String(values[index + 1] || ''));
  return command ? { command, argsPrefix, source: 'host-development' } : null;
};
const resolveRuntime = () => {
  const host = runtimeFromArgs(); if (host) return host;
  const explicit = String(process.env.PHOTOFLOW_TRANSCRIBER_EXECUTABLE || '').trim();
  if (explicit) { let argsPrefix = []; try { argsPrefix = JSON.parse(process.env.PHOTOFLOW_TRANSCRIBER_ARGS_PREFIX || '[]'); } catch {} return { command: explicit, argsPrefix: Array.isArray(argsPrefix) ? argsPrefix.map(String).slice(0, 16) : [], source: 'environment' }; }
  const packaged = path.join(__dirname, '_internal', process.platform === 'win32' ? 'transcriber.exe' : 'transcriber');
  if (fs.statSync(packaged, { throwIfNoEntry: false })?.isFile()) return { command: packaged, argsPrefix: [], source: 'packaged' };
  const configuredPython = String(process.env.PHOTOFLOW_TRANSCRIPTION_PYTHON || '').trim();
  const privatePython = process.platform === 'win32' ? path.join(__dirname, '.venv', 'Scripts', 'python.exe') : path.join(__dirname, '.venv', 'bin', 'python');
  const python = configuredPython || (fs.statSync(privatePython, { throwIfNoEntry: false })?.isFile() ? privatePython : process.platform === 'win32' ? 'py' : 'python3');
  return { command: python, argsPrefix: [...(python === 'py' ? ['-3'] : []), '-u', path.join(__dirname, 'engine.py')], source: configuredPython ? 'environment-python' : python === privatePython ? 'plugin-development' : 'system-python' };
};
const spawnRuntime = (runtime, extraArgs = []) => {
  if (/\.(?:cmd|bat)$/i.test(runtime.command)) throw new Error('转录运行时必须是可直接启动的可执行文件');
  return spawn(runtime.command, [...runtime.argsPrefix, ...extraArgs], { cwd: __dirname, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' } });
};
const runtimeStatus = () => new Promise(resolve => {
  const runtime = resolveRuntime(); let settled = false; let stdout = ''; let stderr = ''; let child;
  try { child = spawnRuntime(runtime, ['--diagnose']); } catch (error) { resolve({ ready: false, source: runtime.source, message: redactError(error) }); return; }
  const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
  const timer = setTimeout(() => { child.kill(); finish({ ready: false, source: runtime.source, message: '算法运行时诊断超时' }); }, 8000);
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); }); child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.on('error', error => finish({ ready: false, source: runtime.source, message: `无法启动算法运行时：${redactError(error)}` }));
  child.on('exit', code => { const frames = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); const result = frames.find(frame => frame.type === 'diagnostic-result'); finish(result ? { ready: result.ready === true, source: runtime.source, missing: result.missing || [], packaged: result.packaged === true, message: result.ready ? '算法运行时可用' : `缺少依赖：${(result.missing || []).join(', ')}` } : { ready: false, source: runtime.source, message: redactError(stderr || `算法运行时退出码 ${code}`) }); });
});

const normalizeProjectRelativePath = value => {
  const raw = String(value || '').replace(/\\/g, '/').trim().replace(/\/+$/, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) return '';
  const parts = raw.split('/'); if (parts.some(part => !part || part === '.' || part === '..')) return '';
  return parts.map(cleanName).join('/').slice(0, 1024);
};
const isWithinProjectScope = (relativeName, scopeRelativePath) => !scopeRelativePath || relativeName.toLocaleLowerCase('en-US') === scopeRelativePath.toLocaleLowerCase('en-US') || relativeName.toLocaleLowerCase('en-US').startsWith(`${scopeRelativePath.toLocaleLowerCase('en-US')}/`);
const PROJECT_MEDIA_LIMIT = 2000;
const collectProjectMediaResult = async (parentId, payload, context) => {
  const requestedInput = Array.isArray(payload?.relativePaths) ? payload.relativePaths : Array.isArray(context?.selectedRelativePaths) ? context.selectedRelativePaths : [];
  const selectionLimitReached = requestedInput.length > PROJECT_MEDIA_LIMIT;
  const requested = [...new Map(requestedInput.slice(0, PROJECT_MEDIA_LIMIT).map(normalizeProjectRelativePath).filter(Boolean).map(value => [value.toLocaleLowerCase('en-US'), value])).values()];
  if (!requested.length) return { files: [], limitReached: selectionLimitReached };
  const rawScope = payload?.scopeRelativePath ?? context?.scopeRelativePath; const scopeRelativePath = normalizeProjectRelativePath(rawScope);
  if (rawScope && !scopeRelativePath) throw new Error('当前选择范围无效');
  if (requested.some(value => !isWithinProjectScope(value, scopeRelativePath))) throw new Error('当前选择超出文件页面范围');
  const requestedKeys = requested.map(value => value.toLocaleLowerCase('en-US')); const files = []; const seen = new Set(); let cursor = null; let pages = 0;
  do {
    const page = await callHost(parentId, 'project.media.page', { pageSize: 200, cursor, kinds: ['video'] }); pages += 1;
    for (const item of Array.isArray(page?.items) ? page.items : []) {
      const relativeName = normalizeProjectRelativePath(item?.relativePath || item?.name);
      if (!relativeName || !isSupportedMediaName(relativeName) || !isWithinProjectScope(relativeName, scopeRelativePath)) continue;
      const key = relativeName.toLocaleLowerCase('en-US');
      if (!requestedKeys.some(selected => key === selected || key.startsWith(`${selected}/`)) || seen.has(key)) continue;
      seen.add(key); files.push({ name: cleanName(item?.name || path.posix.basename(relativeName)), relativeName, mediaRef: item?.mediaRef || { relativePath: relativeName } });
      if (files.length >= PROJECT_MEDIA_LIMIT) break;
    }
    cursor = page?.page?.hasMore ? String(page.page.cursor || '') : null;
  } while (cursor && files.length < PROJECT_MEDIA_LIMIT && pages < 1000);
  return { files, limitReached: selectionLimitReached || files.length >= PROJECT_MEDIA_LIMIT };
};
const collectProjectMedia = async (parentId, payload, context) => (await collectProjectMediaResult(parentId, payload, context)).files;
const previewProjectSelection = async (parentId, payload, context) => { const result = await collectProjectMediaResult(parentId, payload, context); return { files: result.files.map(file => ({ displayName: cleanName(file.name), relativeName: cleanRelativeName(file.relativeName) })), total: result.files.length, limit: PROJECT_MEDIA_LIMIT, limitReached: result.limitReached }; };

const startProjectOperation = async (parentId, payload, context) => {
  const [settings, files] = await Promise.all([readSettings(parentId), collectProjectMedia(parentId, payload, context)]);
  if (!files.length) throw new Error('当前选择中没有可处理的视频文件');
  if (!isCompleteModelDirectory(settings.model)) throw new Error(`模型 ${settings.model} 未安装；请在设置页查看安装引导`);
  const projectId = projectIdFor(context); const operationId = crypto.randomUUID(); const now = Date.now();
  const operation = { id: operationId, projectId, state: 'queued', sourceKind: 'project-media', settings, createdAt: now, updatedAt: now, error: '', files: files.map((file, ordinal) => ({ id: crypto.randomUUID(), operationId, ordinal, displayName: cleanName(file.name), relativeName: cleanRelativeName(file.relativeName), sourceKind: 'project-media', mediaRef: file.mediaRef, state: 'pending', progress: 0, error: '', language: '', segmentCount: 0, output: {} })) };
  operations.set(operationKey(projectId, operationId), operation);
  try { await callHost(parentId, 'tasks', { action: 'start', operationId, title: '视频转文字', message: `等待处理 ${files.length} 个视频文件`, progress: 0, checkpoint: { nextOrdinal: 0, total: files.length } }); }
  catch (error) { operations.delete(operationKey(projectId, operationId)); throw error; }
  return { accepted: true, operationId, operation: operationSnapshot(operation) };
};
const materializeProjectFile = async (parentId, file) => {
  const variant = await callHost(parentId, 'project.media.variants', { ...file.mediaRef, variants: ['original'] });
  if (!variant.input?.token) throw new Error('项目媒体没有可用的受限输入令牌');
  const materialized = await callHost(parentId, 'project.input.tokens', { action: 'materialize', token: variant.input.token });
  const privatePath = path.resolve(String(materialized?.privatePath || ''));
  if (!path.isAbsolute(privatePath) || !fs.statSync(privatePath, { throwIfNoEntry: false })?.isFile()) throw new Error('宿主返回了无效的组件私有输入');
  return privatePath;
};
const removePrivateInput = async (_storage, candidate) => {
  const resolved = path.resolve(String(candidate || '')); if (!candidate || path.extname(resolved).toLowerCase() === '.srt') return false;
  const stat = await fs.promises.lstat(resolved).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return true; if (!stat.isFile() || stat.isSymbolicLink()) return false;
  await fs.promises.unlink(resolved); await fs.promises.rmdir(path.dirname(resolved)).catch(() => undefined); return true;
};

const createEngineSession = ({ operationId, signal }) => {
  const child = spawnRuntime(resolveRuntime()); const pending = new Map(); let stderr = ''; let closed = false; let closeResolve; const closedPromise = new Promise(resolve => { closeResolve = resolve; });
  const cancel = () => { if (!child.killed) child.kill(); };
  const rejectPending = error => { const items = [...pending.values()]; pending.clear(); for (const item of items) item.progressChain.then(() => item.rejectOnce(item.progressError || error), item.rejectOnce); };
  const operationRun = runningOperations.get(operationId); if (operationRun) Object.assign(operationRun, { child, killChild: cancel });
  signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    const item = pending.get(String(frame.requestId || '')); if (!item) return;
    if (frame.type === 'progress' || frame.type === 'diagnostic') item.progressChain = item.progressChain.then(() => item.onProgress(frame.type === 'progress' ? Math.max(0, Math.min(99, Number(frame.progress) || 0)) : null, frame.type === 'diagnostic' ? String(frame.message || '') : '')).catch(error => { item.progressError ||= error; cancel(); });
    else if (frame.type === 'result' || frame.type === 'error') { pending.delete(item.requestId); item.progressChain.then(() => { if (item.progressError) item.rejectOnce(item.progressError); else if (frame.type === 'error') item.rejectOnce(new Error(redactError(frame.message || '算法运行失败'))); else item.resolveOnce(frame); }); }
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}\n${chunk.toString('utf8')}`.slice(-4000); }); child.stdin.on('error', error => { if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) stderr = `${stderr}\n${error.message}`; });
  child.on('error', error => { stderr = `无法启动转录运行时：${redactError(error)}`; rejectPending(new Error(stderr)); });
  child.on('close', code => { if (closed) return; closed = true; signal.removeEventListener('abort', cancel); lines.close(); const error = signal.aborted ? Object.assign(new Error('识别已取消'), { code: 'CANCELLED' }) : new Error(redactError(stderr || `转录运行时退出码 ${code}`)); rejectPending(error); closeResolve(); });
  return { child, transcribe: (file, settings, outputPath, onProgress) => new Promise((resolve, reject) => { if (closed) { reject(new Error('转录运行时已经退出')); return; } const requestId = file.id; let settled = false; const item = { requestId, onProgress, progressChain: Promise.resolve(), progressError: null, resolveOnce: value => { if (!settled) { settled = true; resolve(value); } }, rejectOnce: error => { if (!settled) { settled = true; reject(error); } } }; pending.set(requestId, item); child.stdin.write(`${JSON.stringify({ type: 'transcribe', requestId, inputPath: file.privatePath, outputPath, options: settings })}\n`, error => { if (error) { pending.delete(requestId); item.rejectOnce(new Error(`转录运行时输入失败：${redactError(error)}`)); cancel(); } }); }), close: async () => { if (!closed && !child.stdin.destroyed) child.stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`); await closedPromise; }, cancel };
};
const runEngine = async ({ row, settings, outputPath, signal, onProgress }) => { const session = createEngineSession({ operationId: row.operationId, signal }); try { return await session.transcribe(row, settings, outputPath, onProgress); } finally { await session.close(); } };

const listProjectSrtFiles = async parentId => {
  const result = []; let cursor = null; let pages = 0;
  do { const page = await callHost(parentId, 'project.files.page', { pageSize: 200, cursor }); for (const item of Array.isArray(page?.items) ? page.items : []) if (item?.kind !== 'directory' && String(item?.extension || path.posix.extname(item?.relativePath || '')).toLowerCase() === '.srt') result.push({ relativePath: cleanRelativeName(item.relativePath), name: cleanName(item.name), size: Number(item.size) || 0, updatedAt: Number(item.updatedAt) || 0 }); cursor = page?.page?.hasMore ? String(page.page.cursor || '') : null; pages += 1; } while (cursor && pages < 1000);
  result.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' })); return result;
};
const stableId = (prefix, value) => `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32)}`;
const adoptSrt = async (parentId, item) => {
  const migrationId = stableId('srt', `${item.relativePath}\0${item.size}\0${item.updatedAt}`);
  const receipt = await callHost(parentId, 'project.output', { action: 'adopt', migrationId, outputs: [{ relativePath: item.relativePath }] }); const output = receipt.outputs?.[0];
  if (!receipt.commitId || !output?.artifactId) throw new Error('无法取得字幕文件的受控读取权');
  return { commitId: receipt.commitId, artifactId: output.artifactId, relativePath: output.relativePath || item.relativePath, sha256: output.sha256, size: Number(output.size) || item.size };
};
const readSrtItem = async (parentId, item) => {
  const output = await adoptSrt(parentId, item); const materialized = await callHost(parentId, 'project.output', { action: 'materializeOwned', commitId: output.commitId, artifactId: output.artifactId }); const privatePath = path.resolve(String(materialized.privatePath || ''));
  try { return { output, segments: parseSrt(await fs.promises.readFile(privatePath, 'utf8')) }; }
  finally { await fs.promises.unlink(privatePath).catch(() => undefined); await fs.promises.rmdir(path.dirname(privatePath)).catch(() => undefined); }
};
const libraryOperation = async parentId => {
  const items = await listProjectSrtFiles(parentId); const files = items.map((item, ordinal) => ({ id: stableId('file', item.relativePath.toLocaleLowerCase('en-US')), operationId: LIBRARY_OPERATION_ID, ordinal, displayName: item.name, relativeName: item.relativePath, sourceKind: 'srt-file', state: 'completed', progress: 100, error: '', language: '', segmentCount: 0, updatedAt: item.updatedAt, output: {}, srtItem: item })); const updatedAt = items.reduce((latest, item) => Math.max(latest, item.updatedAt), 0); return { id: LIBRARY_OPERATION_ID, state: 'completed', sourceKind: 'srt-library', createdAt: updatedAt || Date.now(), updatedAt: updatedAt || Date.now(), error: '', files };
};
const findSrtFile = async (parentId, fileId, operation = null) => {
  const items = await listProjectSrtFiles(parentId); let relativePath = '';
  if (operation) relativePath = operation.files.find(file => file.id === fileId)?.output?.relativePath || srtNameFor(operation.files.find(file => file.id === fileId)?.relativeName || '');
  const item = relativePath ? items.find(value => value.relativePath.toLocaleLowerCase('en-US') === relativePath.toLocaleLowerCase('en-US')) : items.find(value => stableId('file', value.relativePath.toLocaleLowerCase('en-US')) === fileId);
  if (!item) throw new Error('找不到字幕文件'); return item;
};
const publishStagedSrt = async (parentId, operation, file, stage, sourceName) => {
  const content = await fs.promises.readFile(path.join(stage.privatePath, sourceName)); const sha256 = crypto.createHash('sha256').update(content).digest('hex'); const outputRelativePath = srtNameFor(file.relativeName); const existing = (await listProjectSrtFiles(parentId)).find(item => item.relativePath.toLocaleLowerCase('en-US') === outputRelativePath.toLocaleLowerCase('en-US')); let replacement = {};
  if (existing) { const owned = await adoptSrt(parentId, existing); replacement = { replace: true, previousCommitId: owned.commitId, previousArtifactId: owned.artifactId, expectedDigest: owned.sha256 }; }
  await callHost(parentId, 'project.output', { action: 'write', stageId: stage.stageId, name: path.posix.basename(outputRelativePath), outputRelativePath, sourceName, ...replacement }); await callHost(parentId, 'project.output', { action: 'validate', stageId: stage.stageId });
  const idempotencyKey = stableId('srt', `${operation.id}\0${file.id}\0${sha256}`); const committed = await callHost(parentId, 'project.output', { action: 'commit', stageId: stage.stageId, idempotencyKey }); const artifact = committed.outputs?.[0];
  return { commitId: committed.commitId, artifactId: artifact?.artifactId, relativePath: artifact?.relativePath || outputRelativePath, sha256: artifact?.sha256 || sha256, size: Number(artifact?.size ?? content.length) };
};
const startCancellationWatcher = (parentId, operationId, control) => {
  let stopped = false; let timer = null; let checking = false;
  const poll = async () => { if (stopped || control.signal.aborted || checking) return; checking = true; try { if ((await callHost(parentId, 'tasks', { action: 'status', operationId })).cancelled) control.abort(); } catch {} finally { checking = false; if (!stopped && !control.signal.aborted) timer = setTimeout(poll, 200); } };
  timer = setTimeout(poll, 0); return () => { stopped = true; if (timer) clearTimeout(timer); };
};
const emitProgress = (parentId, operation, file) => callHost(parentId, 'component.events', { topic: 'transcript.operation.progress.v1', event: { operationId: operation.id, state: operation.state, total: operation.files.length, succeeded: operation.files.filter(value => value.state === 'completed').length, failed: operation.files.filter(value => value.state === 'failed').length, file: file ? { id: file.id, displayName: file.displayName, state: file.state, progress: file.progress } : null } }).catch(() => undefined);

const runOperation = async (parentId, payload, context) => {
  const operationId = String(payload.operationId || ''); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(operationId) || operationId === LIBRARY_OPERATION_ID) throw new Error('无效的 operationId');
  const operation = getOperation(context, operationId); if (!operation) throw new Error('找不到识别任务'); const runKey = operationKey(operation.projectId, operationId); if (runningOperations.has(runKey)) return { accepted: true, operationId, alreadyRunning: true }; if (TERMINAL_STATES.has(operation.state) && operation.state !== 'cancelled') return operationSnapshot(operation);
  if (!isCompleteModelDirectory(operation.settings.model)) throw new Error(`模型 ${operation.settings.model} 未安装；请在设置页查看安装引导`);
  const control = new AbortController(); activeRequests.set(parentId, control); const running = { parentId, control, cancel: () => control.abort() }; runningOperations.set(runKey, running); const stopWatcher = startCancellationWatcher(parentId, operationId, control); let engine = null;
  try {
    operation.state = 'running'; operation.error = ''; operation.updatedAt = Date.now(); await callHost(parentId, 'tasks', { action: 'resume', operationId, title: '视频转文字', message: '正在识别并写入同目录 SRT', checkpoint: { nextOrdinal: 0, total: operation.files.length } });
    const rows = operation.files.filter(file => ['pending', 'running', 'failed'].includes(file.state));
    for (const file of rows) {
      if (control.signal.aborted) break; let stage = null; let privatePath = '';
      try {
        privatePath = await materializeProjectFile(parentId, file); file.privatePath = privatePath; stage = await callHost(parentId, 'project.output', { action: 'stage' }); const sourceName = `${file.id}.srt`; const outputPath = path.join(stage.privatePath, sourceName); file.state = 'running'; file.progress = 0; file.error = '';
        engine ||= createEngineSession({ operationId: runKey, signal: control.signal });
        const result = await engine.transcribe(file, operation.settings, outputPath, async (progress, message = '') => { if (progress !== null) file.progress = progress; operation.updatedAt = Date.now(); const completed = operation.files.filter(value => ['completed', 'failed'].includes(value.state)).length; const report = await callHost(parentId, 'tasks', { action: 'report', operationId, progress: ((completed + (Number(progress) || 0) / 100) / Math.max(1, operation.files.length)) * 100, phase: 'transcribing', message: message || `正在识别 ${file.displayName}`, checkpoint: { nextOrdinal: file.ordinal, currentFileId: file.id, total: operation.files.length } }); await emitProgress(parentId, operation, file); if (report.cancelled) control.abort(); });
        if (control.signal.aborted) throw Object.assign(new Error('识别已取消'), { code: 'CANCELLED' });
        file.output = await publishStagedSrt(parentId, operation, file, stage, sourceName); stage = null; file.state = 'completed'; file.progress = 100; file.language = String(result.language || ''); file.segmentCount = result.segments.length;
      } catch (error) {
        if (stage) await callHost(parentId, 'project.output', { action: 'rollback', stageId: stage.stageId }).catch(() => undefined);
        if (control.signal.aborted || error.code === 'CANCELLED') { file.state = 'pending'; file.progress = 0; break; }
        if (String(error.code || '').startsWith('COMPONENT_')) throw error; file.state = 'failed'; file.progress = 100; file.error = redactError(error);
      } finally { delete file.privatePath; if (privatePath) await removePrivateInput(null, privatePath).catch(() => undefined); }
      operation.updatedAt = Date.now(); await emitProgress(parentId, operation, file);
    }
    if (engine) { await engine.close(); engine = null; }
    const succeeded = operation.files.filter(file => file.state === 'completed').length; const failed = operation.files.filter(file => file.state === 'failed').length; let message;
    if (control.signal.aborted) { operation.state = 'cancelled'; message = '识别已取消'; }
    else if (!failed) { operation.state = 'completed'; message = `全部 ${succeeded} 个文件识别完成，SRT 已写入视频同目录`; }
    else if (succeeded) { operation.state = 'partial_failure'; message = `${succeeded} 个完成，${failed} 个失败`; }
    else { operation.state = 'failed'; message = `${failed} 个文件全部识别失败`; operation.error = message; }
    operation.updatedAt = Date.now();
    if (operation.state === 'cancelled') await callHost(parentId, 'tasks', { action: 'cancel', operationId }); else if (operation.state === 'failed') await callHost(parentId, 'tasks', { action: 'fail', operationId, error: message }); else await callHost(parentId, 'tasks', { action: 'complete', operationId, message });
    await emitProgress(parentId, operation, null); return operationSnapshot(operation);
  } catch (error) { for (const file of operation.files) if (file.state === 'running') { file.state = 'pending'; file.progress = 0; } operation.state = 'queued'; operation.error = redactError(error); operation.updatedAt = Date.now(); throw error; }
  finally { stopWatcher(); if (engine) { engine.cancel(); await engine.close().catch(() => undefined); } if (activeRequests.get(parentId) === control) activeRequests.delete(parentId); if (runningOperations.get(runKey) === running) runningOperations.delete(runKey); }
};

const decodeOffsetCursor = (value, kind, fingerprint = '') => { if (!value) return 0; try { const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); if (parsed.kind !== kind || parsed.fingerprint !== fingerprint || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error(); return parsed.offset; } catch { throw new Error('无效的分页游标'); } };
const encodeOffsetCursor = (kind, fingerprint, offset) => Buffer.from(JSON.stringify({ kind, fingerprint, offset }), 'utf8').toString('base64url');
const loadAllSrtSegments = async parentId => {
  const items = await listProjectSrtFiles(parentId); const output = [];
  for (const [ordinal, item] of items.entries()) { const read = await readSrtItem(parentId, item); const fileId = stableId('file', item.relativePath.toLocaleLowerCase('en-US')); for (const segment of read.segments) output.push({ fileId, operationId: LIBRARY_OPERATION_ID, ordinal, displayName: item.name, relativeName: item.relativePath, ...segment }); }
  return output;
};
const getFile = async (parentId, payload, context) => {
  const fileId = String(payload.fileId || ''); const operation = [...operations.values()].find(value => value.projectId === projectIdFor(context) && value.files.some(file => file.id === fileId)) || null; const item = await findSrtFile(parentId, fileId, operation); const read = await readSrtItem(parentId, item); const pageSize = Math.min(200, Math.max(20, Number(payload.pageSize) || 200)); let offset = Math.min(1_000_000, Math.max(0, Number.parseInt(String(payload.cursor || '0'), 10) || 0)); const targetSeq = Math.max(0, Number.parseInt(String(payload.targetSeq || '0'), 10) || 0); if (targetSeq) offset = Math.floor(Math.max(0, targetSeq - 1) / pageSize) * pageSize; const segments = read.segments.slice(offset, offset + pageSize); const runtimeFile = operation?.files.find(file => file.id === fileId); const file = runtimeFile ? publicFile(runtimeFile) : publicFile({ id: fileId, operationId: LIBRARY_OPERATION_ID, ordinal: 0, displayName: item.name, relativeName: item.relativePath, sourceKind: 'srt-file', state: 'completed', progress: 100, segmentCount: read.segments.length, updatedAt: item.updatedAt, output: read.output }); return { file, segments, page: { pageSize, offset, hasMore: offset + segments.length < read.segments.length, nextCursor: offset + segments.length < read.segments.length ? String(offset + pageSize) : null, previousCursor: offset ? String(Math.max(0, offset - pageSize)) : null } };
};
const getOperationTranscriptPage = async (parentId, payload) => { const pageSize = Math.min(200, Math.max(20, Number(payload.pageSize) || 120)); const all = await loadAllSrtSegments(parentId); const fingerprint = crypto.createHash('sha256').update(all.map(item => `${item.relativeName}:${item.seq}`).join('\0')).digest('hex').slice(0, 16); const offset = decodeOffsetCursor(payload.cursor, 'all-srt', fingerprint); const items = all.slice(offset, offset + pageSize); const nextOffset = offset + items.length; return { operationId: String(payload.operationId || LIBRARY_OPERATION_ID), items, page: { pageSize, position: offset, hasMore: nextOffset < all.length, nextCursor: nextOffset < all.length ? encodeOffsetCursor('all-srt', fingerprint, nextOffset) : null, previousCursor: offset ? encodeOffsetCursor('all-srt', fingerprint, Math.max(0, offset - pageSize)) : null } }; };
const search = async (parentId, payload) => { const query = String(payload.query || '').trim().slice(0, 200); const limit = Math.min(100, Math.max(10, Number(payload.limit) || 50)); if (!query) return { query, results: [], page: { hasMore: false, nextCursor: null } }; const all = (await loadAllSrtSegments(parentId)).filter(item => item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())); const fingerprint = crypto.createHash('sha256').update(query).digest('hex').slice(0, 16); const offset = decodeOffsetCursor(payload.cursor, 'search', fingerprint); const results = all.slice(offset, offset + limit); return { query, results, page: { hasMore: offset + results.length < all.length, nextCursor: offset + results.length < all.length ? encodeOffsetCursor('search', fingerprint, offset + results.length) : null } }; };
const cancelOperation = async (parentId, payload, context) => { const operation = getOperation(context, payload.operationId); if (!operation) throw new Error('找不到识别任务'); runningOperations.get(operationKey(operation.projectId, operation.id))?.cancel(); if (!TERMINAL_STATES.has(operation.state) || operation.state === 'cancelled') operation.state = 'cancelled'; operation.updatedAt = Date.now(); await callHost(parentId, 'tasks', { action: 'cancel', operationId: operation.id }).catch(() => undefined); return operationSnapshot(operation); };
const openOutput = async (parentId, payload, context) => { const fileId = String(payload.fileId || ''); const operation = [...operations.values()].find(value => value.projectId === projectIdFor(context) && value.files.some(file => file.id === fileId)) || null; const item = await findSrtFile(parentId, fileId, operation); const output = operation?.files.find(file => file.id === fileId)?.output?.commitId ? operation.files.find(file => file.id === fileId).output : await adoptSrt(parentId, item); await callHost(parentId, 'dialogs', { kind: payload.reveal ? 'revealOutput' : 'openOutput', commitId: output.commitId, artifactId: output.artifactId }); return { opened: true, fileId }; };

const handlers = {
  'transcript.selection.preview.v1': previewProjectSelection,
  'transcript.project.start.v1': startProjectOperation,
  'transcript.operation.run.v1': runOperation,
  'transcript.operation.list.v1': async (parentId, _payload, context) => { const projectId = projectIdFor(context); const current = [...operations.values()].filter(value => value.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt).map(value => operationSnapshot(value, false)); const library = await libraryOperation(parentId); return { operations: [operationSnapshot(library, false), ...current] }; },
  'transcript.operation.get.v1': async (parentId, payload, context) => { if (String(payload.operationId) === LIBRARY_OPERATION_ID) return { operation: operationSnapshot(await libraryOperation(parentId)) }; const operation = getOperation(context, payload.operationId); if (!operation) throw new Error('找不到识别任务'); return { operation: operationSnapshot(operation) }; },
  'transcript.operation.cancel.v1': cancelOperation,
  'transcript.operation.resume.v1': async (parentId, payload, context) => { const operation = getOperation(context, payload.operationId); if (!operation) throw new Error('找不到识别任务'); operation.state = 'queued'; operation.error = ''; operation.updatedAt = Date.now(); for (const file of operation.files) if (file.state !== 'completed') { file.state = 'pending'; file.progress = 0; } await callHost(parentId, 'tasks', { action: 'resume', operationId: operation.id, title: '视频转文字', message: '准备恢复转写', checkpoint: { resumed: true } }); return { accepted: true, operationId: operation.id }; },
  'transcript.search.v1': search,
  'transcript.file.get.v1': getFile,
  'transcript.operation.transcript.page.v1': getOperationTranscriptPage,
  'transcript.output.open.v1': openOutput,
  'transcript.settings.get.v1': async parentId => ({ settings: await readSettings(parentId) }),
  'transcript.settings.update.v1': saveSettings,
  'transcript.models.list.v1': async () => listModels(),
  'transcript.runtime.status.v1': async () => runtimeStatus(),
};
const startService = () => {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    if (frame?.type === 'capability-response') { const pending = pendingCapabilities.get(String(frame.id || '')); if (!pending) return; pendingCapabilities.delete(String(frame.id)); frame.ok === false ? pending.reject(capabilityError(frame)) : pending.resolve(frame.result); return; }
    if (frame?.type === 'cancel') { activeRequests.get(String(frame.id || ''))?.abort(); return; }
    if (frame?.type !== 'request') return;
    const id = String(frame.id || ''); const handler = handlers[String(frame.method || '')]; Promise.resolve().then(() => { if (!handler) throw new Error('未知的视频字幕服务方法'); return handler(id, frame.payload || {}, frame.context || {}); }).then(result => writeFrame({ type: 'response', id, ok: true, result })).catch(error => writeFrame({ type: 'response', id, ok: false, error: redactError(error), errorCode: error.code === 'CANCELLED' ? 'COMPONENT_SERVICE_CANCELLED' : 'COMPONENT_SERVICE_REQUEST_FAILED', retryable: !TERMINAL_STATES.has(error.code) }));
  });
  writeFrame({ type: 'ready', protocolVersion: 1 });
};
if (require.main === module) startService();
process.once('exit', () => { for (const value of runningOperations.values()) value.cancel(); });
module.exports = { startService, handlers, resolveRuntime, runtimeStatus, runEngine, createEngineSession, removePrivateInput, collectProjectMedia, collectProjectMediaResult, previewProjectSelection, listProjectSrtFiles, readSrtItem, listModels, isCompleteModelDirectory, resolveSafeModelRoot };
