const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const { DatabaseSync } = require('node:sqlite');
const { CANCELLED_CODE, buildWorkflowPlan, copyWorkflowPlan } = require('./workflow-generation.cjs');
const { createWorkflowManifestResolver, findOwnedWorkflowOutput, workflowOutputOwnershipKey } = require('./workflow-manifest.cjs');
const { restoreProjectBundle, restoreWorkspaceBundle, selectRestoreSource, loadRestoreSources, writeRestoreReceipt } = require('./backup-restore.cjs');

const MAX_ITEMS = 2000;
const DB_BUSY_TIMEOUT_MS = 750;
const RETURN_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']);
const pendingCapabilities = new Map();
const activeAlgorithms = new Set();
const unconfirmedAlgorithmTrees = new Set();
const workflowJobs = new Map();
const photoOperations = new Map();
const reviewSessionOperations = new Map();
const projectWorkflowOperations = new Map();
const durableOperationRuns = new Map();
const durableOperationParentIds = new Map();
const durableOperationSecrets = new Map();
const workingOwnershipOperations = new Map();
const projectRequestOperations = new Map();
const projectRevisionLeaseHeartbeats = new Map();
const projectRevisionLeaseStates = new Map();
const persistentFileFenceDatabases = new Map();
const revisionControlDatabases = new Map();
const MAX_DATABASE_CACHE_ENTRIES = 8;
const algorithmControlsByParent = new Map();
const requestStoragePromises = new Map();
const activeRequestControls = new Map();
const injectedTestFaults = new Set();
const schemaReadyPaths = new Map();
let advancedRuntimeProbeCache = null;
const advancedRuntimeProbePending = new Map();
let nextCapabilityId = 1;
let restoreLeaseHeld = false;
let restoreHold = null;
const completedRestoreHolds = new Map();
const advancedLifecycleRuns = new Map();
const advancedLifecycleRecords = new Map();
const metricSamples = new Map();
const revisionRequestContext = new AsyncLocalStorage();
const activeProjectId = () => String(revisionRequestContext.getStore()?.projectId || '');
const trimDatabaseCache = cache => {
  if (cache.size <= MAX_DATABASE_CACHE_ENTRIES) return;
  const activePaths = new Set([...projectRevisionLeaseStates.values()].map(state => path.resolve(state.databasePath).toLowerCase()));
  for (const [databasePath, value] of cache) {
    if (cache.size <= MAX_DATABASE_CACHE_ENTRIES) break;
    if (activePaths.has(path.resolve(databasePath).toLowerCase())) continue;
    try { (value?.db || value).close(); } catch { /* idle cache eviction */ }
    cache.delete(databasePath);
  }
};

const hostAlgorithmRuntime = (() => {
  const values = process.argv.slice(2);
  const commandIndex = Math.max(values.indexOf('--photoflow-development-command'), values.indexOf('--photoflow-algorithm-command'));
  if (commandIndex < 0) return null;
  const command = String(values[commandIndex + 1] || '').trim();
  const argsPrefix = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--photoflow-development-arg' || values[index] === '--photoflow-algorithm-arg-prefix') argsPrefix.push(String(values[index + 1] || ''));
  }
  return command ? Object.freeze({ command, argsPrefix: Object.freeze(argsPrefix) }) : null;
})();

const validateAlgorithmRuntime = runtime => {
  const stat = fs.statSync(runtime.command, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`团片组件算法不可用：运行时不存在（${hostAlgorithmRuntime ? '开发 Python 环境' : '组件完整性运行时'}）`);
  for (const argument of runtime.argsPrefix) {
    // Development argsPrefix contains interpreter switches followed by the
    // validated component entry file. Switches such as Python's `-u` are not
    // filesystem paths and must not be rejected as missing entries.
    if (String(argument).startsWith('-')) continue;
    const candidate = path.resolve(argument);
    const argumentStat = fs.statSync(candidate, { throwIfNoEntry: false });
    if (!argumentStat?.isFile()) throw new Error('团片组件算法不可用：开发算法入口不存在');
  }
  return runtime;
};
const resolveAlgorithmRuntime = () => validateAlgorithmRuntime(hostAlgorithmRuntime || { command: path.join(__dirname, process.platform === 'win32' ? 'team-retouch.exe' : 'team-retouch'), argsPrefix: [] });

const writeFrame = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const migrationMetric = (migration, phase, startedAt, values = {}) => {
  const elapsedMs = Date.now() - startedAt;
  const key = `${migration}:${phase}`; const samples = [...(metricSamples.get(key) || []), elapsedMs].slice(-128).sort((a, b) => a - b); metricSamples.set(key, samples);
  const percentile = value => samples[Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * value) - 1))] || 0;
  writeFrame({
    type: 'metric', migration, phase, elapsedMs, sampleCount: samples.length, p50Ms: percentile(.5), p95Ms: percentile(.95),
    itemCount: Math.max(0, Number(values.itemCount) || 0), byteCount: Math.max(0, Number(values.byteCount) || 0),
    queueMs: Math.max(0, Number(values.queueMs) || 0), ackMs: Math.max(0, Number(values.ackMs) || 0),
    cacheHit: values.cacheHit === true, fallback: values.fallback === true,
    outcome: String(values.outcome || values.state || ''), state: String(values.state || ''),
  });
};
const parseJson = (value, fallback) => {
  try { return JSON.parse(value || ''); } catch { return fallback; }
};
const cancelledRequestError = () => Object.assign(new Error('团片请求已取消'), { code: CANCELLED_CODE, retryable: true });
const assertNotAborted = signal => {
  if (!signal?.aborted) return;
  const code = String(signal.reason?.code || '');
  if (code === CANCELLED_CODE || code.startsWith('COMPONENT_')) throw signal.reason;
  throw cancelledRequestError();
};
const uniqueText = values => [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const safeSegment = (value, fallback) => {
  let segment = String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 60).replace(/[. ]+$/g, '');
  if (!segment || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) segment = `_${segment || String(fallback || 'item')}`;
  return segment.slice(0, 60).replace(/[. ]+$/g, '') || 'item';
};
const weekName = value => `第${Math.max(1, Math.floor(Number(value) || 1))}周`;
const assertDecodableImage = filePath => {
  if (['.heic', '.heif'].includes(path.extname(String(filePath || '')).toLowerCase())) throw new Error('HEIC/HEIF 当前未接入可验证的通用解码器；请先转换为 JPEG、PNG、TIFF 或 WebP 后再处理');
};

// Persistent filesystem publication is part of the project revision lease, not
// merely preceded by a lease check. BEGIN IMMEDIATE excludes a new owner while
// the short, synchronous rename/link/delete sequence is in flight. Expensive
// copies always happen before this fence into request-unique staging paths.
const withPersistentFileFence = (action, providedDb = null) => {
  assertNotAborted(revisionRequestContext.getStore()?.signal);
  const requestId = String(revisionRequestContext.getStore()?.requestId || '');
  if (!requestId) return action();
  const state = projectRevisionLeaseStates.get(requestId);
  if (!state || state.lost) throw state?.error || revisionLeaseLostError();
  let pooled = persistentFileFenceDatabases.get(state.databasePath);
  if (!providedDb && !pooled) {
    const db = new DatabaseSync(state.databasePath);
    db.exec(`PRAGMA busy_timeout=${DB_BUSY_TIMEOUT_MS}`);
    pooled = { db };
    persistentFileFenceDatabases.set(state.databasePath, pooled);
    trimDatabaseCache(persistentFileFenceDatabases);
  }
  const db = providedDb || pooled.db;
  try {
    db.exec(`PRAGMA busy_timeout=${DB_BUSY_TIMEOUT_MS}; BEGIN IMMEDIATE`);
    const lease = providedDb
      ? db.prepare('SELECT 1 ok FROM team_project_revision_leases WHERE project_id=? AND request_id=? AND expires_at>?').get(state.projectId, requestId, Date.now())
      : db.prepare('SELECT 1 ok FROM team_project_revision_leases WHERE project_id=? AND request_id=? AND expires_at>?').get(state.projectId, requestId, Date.now());
    if (!lease) throw revisionLeaseLostError();
    const result = action(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
    if (error?.code === 'COMPONENT_BUSY' || /TEAM_REVISION_LEASE_LOST/.test(String(error?.message || ''))) markRevisionLeaseLost(requestId, error);
    throw projectRevisionLeaseStates.get(requestId)?.error || error;
  }
};

const replacePersistentFromStage = (stagedPath, destinationPath, token = crypto.randomUUID()) => withPersistentFileFence(() => {
  const backupPath = `${destinationPath}.${token}.backup`;
  let backedUp = false;
  try {
    if (fs.existsSync(destinationPath)) { fs.renameSync(destinationPath, backupPath); backedUp = true; }
    fs.renameSync(stagedPath, destinationPath);
    return { destinationPath, backupPath: backedUp ? backupPath : '' };
  } catch (error) {
    // This restoration occurs while the same SQLite write lock and verified
    // fence are held. A stale owner can therefore never restore over a successor.
    if (backedUp && !fs.existsSync(destinationPath)) fs.renameSync(backupPath, destinationPath);
    throw error;
  }
});

const rollbackPersistentReplacements = replacements => withPersistentFileFence(() => {
  const discarded = [];
  for (const item of [...replacements].reverse()) {
    if (fs.existsSync(item.destinationPath)) {
      const discardPath = `${item.destinationPath}.${crypto.randomUUID()}.discarded`;
      fs.renameSync(item.destinationPath, discardPath); discarded.push(discardPath);
    }
    if (item.backupPath && fs.existsSync(item.backupPath)) fs.renameSync(item.backupPath, item.destinationPath);
  }
  for (const discardedPath of discarded) void fs.promises.rm(discardedPath, { recursive: true, force: true }).catch(() => undefined);
});

const removePersistentPaths = paths => {
  const retired = withPersistentFileFence(() => {
    const moved = [];
    try {
      for (const filePath of uniqueText(paths)) if (fs.existsSync(filePath)) {
        const retiredPath = `${filePath}.${crypto.randomUUID()}.retired`;
        fs.renameSync(filePath, retiredPath); moved.push({ filePath, retiredPath });
      }
      return moved;
    } catch (error) {
      for (const item of moved.reverse()) if (!fs.existsSync(item.filePath) && fs.existsSync(item.retiredPath)) fs.renameSync(item.retiredPath, item.filePath);
      throw error;
    }
  });
  for (const item of retired) {
    // The retired name is request-unique and no successor can adopt it.
    void fs.promises.rm(item.retiredPath, { recursive: true, force: true }).catch(() => undefined);
  }
};

const copyFileAtomic = async (source, destination, { isCancelled = () => false, onProgress = () => undefined } = {}) => {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const pending = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    if (isCancelled()) throw Object.assign(new Error('工作流程生成已取消'), { code: CANCELLED_CODE });
    await fs.promises.copyFile(source, pending);
    const stat = await fs.promises.stat(source);
    onProgress({ bytesCopied: stat.size, totalBytes: stat.size });
    if (isCancelled()) throw Object.assign(new Error('工作流程生成已取消'), { code: CANCELLED_CODE });
    await fs.promises.utimes(pending, stat.atime, stat.mtime);
    if (revisionRequestContext.getStore()?.requestId) replacePersistentFromStage(pending, destination);
    else await fs.promises.rename(pending, destination);
  } finally { await fs.promises.rm(pending, { force: true }).catch(() => undefined); }
};

const readJson = async (filePath, fallback) => {
  try { return JSON.parse(await fs.promises.readFile(filePath, 'utf8')); } catch { return fallback; }
};

const replaceJsonAtomic = async (filePath, value) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const token = crypto.randomUUID();
  const pendingPath = `${filePath}.${token}.tmp`;
  let published = null;
  try {
    await fs.promises.writeFile(pendingPath, JSON.stringify(value, null, 2), 'utf8');
    published = replacePersistentFromStage(pendingPath, filePath, token);
    if (published.backupPath) await fs.promises.rm(published.backupPath, { force: true });
  } catch (error) {
    await fs.promises.rm(pendingPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const callHost = async (parentId, method, payload = {}) => {
  assertNotAborted(revisionRequestContext.getStore()?.signal);
  await assertCurrentRevisionLease();
  return new Promise((resolve, reject) => {
  const id = `cap-${nextCapabilityId++}`;
  pendingCapabilities.set(id, { parentId: String(parentId), resolve, reject });
  writeFrame({ type: 'capability', id, parentId, method, payload });
  });
};

const materializeInput = async (parentId, token) => callHost(parentId, 'project.input.tokens', { action: 'materialize', token });
const readHostMedia = async (parentId, payload) => {
  const refs = Array.isArray(payload.mediaRefs) ? payload.mediaRefs
    : [...(payload.photoIds || []).map(photoId => ({ photoId })), ...(payload.relativePaths || []).map(relativePath => ({ relativePath }))];
  const items = [];
  const selected = refs.slice(0, MAX_ITEMS); let cursor = 0;
  const workers = Array.from({ length: Math.min(16, selected.length) }, async () => { while (cursor < selected.length) {
    const ref = selected[cursor++];
    try {
      const variant = await callHost(parentId, 'project.media.variants', { ...ref, variants: [] });
      const metadata = variant.metadata || {};
      const photoId = String(metadata.photoId || variant.mediaRef?.photoId || ref.photoId || '');
      const versionId = String(metadata.versionId || variant.mediaRef?.versionId || ref.versionId || '');
      const relativePath = String(metadata.relativePath || variant.mediaRef?.relativePath || ref.relativePath || '');
      items.push({
        photo: { id: photoId, currentVersionId: String(metadata.currentVersionId || versionId), displayName: metadata.displayName || metadata.originalName || path.basename(relativePath), originalName: metadata.originalName || path.basename(relativePath) },
        versions: [{ id: versionId, photoId, relativePath, relativePathState: metadata.fileMissing ? 'missing' : 'ready', fileMissing: Boolean(metadata.fileMissing), isCurrent: Boolean(metadata.isCurrent || metadata.currentVersionId === versionId), mediaRef: variant.mediaRef }],
        relativePath,
      });
    } catch (error) {
      if (payload.strict) throw error;
      const photoId = String(ref.photoId || ''); const versionId = String(ref.versionId || ''); const relativePath = String(ref.relativePath || '');
      if (photoId && versionId) items.push({ photo: { id: photoId, currentVersionId: versionId, displayName: path.basename(relativePath) || photoId, originalName: path.basename(relativePath) || photoId }, versions: [{ id: versionId, photoId, relativePath, relativePathState: 'missing', fileMissing: true, isCurrent: true, mediaRef: { photoId, versionId, relativePath } }], relativePath, metadataLookupFailed: true });
    }
  } });
  await Promise.all(workers);
  return { items };
};
const materializeMediaForOperation = async (parentId, refs) => {
  const unique = new Map();
  for (const ref of refs || []) unique.set(ref.photoId ? `${ref.photoId}\0${ref.versionId || ''}` : `path\0${ref.relativePath || ''}`, ref);
  const items = []; const directories = new Set();
  try {
    for (const ref of unique.values()) {
      const variant = await callHost(parentId, 'project.media.variants', { ...ref, variants: ['original'] });
      if (!variant.input?.token) throw new Error('Host did not grant materialization for requested media');
      const input = await materializeInput(parentId, variant.input.token); directories.add(path.dirname(input.privatePath));
      const metadata = variant.metadata || {}; const photoId = String(metadata.photoId || variant.mediaRef?.photoId || ref.photoId || ''); const versionId = String(metadata.versionId || variant.mediaRef?.versionId || ref.versionId || '');
      const relativePath = metadata.relativePath || variant.mediaRef?.relativePath || ref.relativePath || '';
      items.push({ relativePath, photo: { id: photoId, currentVersionId: String(metadata.currentVersionId || versionId), displayName: metadata.displayName || metadata.originalName || '', originalName: metadata.originalName || '' }, versions: [{ id: versionId, photoId, filePath: input.privatePath, relativePath, fileMissing: Boolean(metadata.fileMissing), isCurrent: Boolean(metadata.isCurrent || metadata.currentVersionId === versionId) }] });
    }
    return { items, cleanup: async () => { for (const directory of directories) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined); } };
  } catch (error) { for (const directory of directories) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined); throw error; }
};
const artifactGrantForStorage = (storage, payload) => {
  if (!storage.projectId) throw new Error('Host component storage is missing the bound project id');
  const dataDirectory = path.join(storage.dataPath, 'projects', sha256(String(storage.projectId)), 'media', safeSegment(payload.photoId, 'photo'), safeSegment(payload.baseVersionId, 'version'));
  return { storageRoot: storage.dataPath, dataDirectory, analysisDirectory: path.join(dataDirectory, 'analysis'), uploadDirectory: path.join(dataDirectory, 'uploads'), mergeDirectory: path.join(dataDirectory, 'merge'), deliveryDirectory: path.join(dataDirectory, 'delivery'), deliveryPrefix: safeSegment(payload.deliveryPrefix || payload.photoId, 'photo') };
};
const artifactGrantForHost = async (parentId, payload) => artifactGrantForStorage(await hostStorage(parentId), payload);
const inputStages = new Map();
const loadRawHostStorage = async parentId => {
  const value = await callHost(parentId, 'component.storage', {});
  return { ...value, ...(value.dataPath ? { dataRoot: value.dataPath } : {}) };
};
const rawHostStorage = parentId => {
  const key = String(parentId); let promise = requestStoragePromises.get(key);
  if (!promise) { promise = loadRawHostStorage(parentId); requestStoragePromises.set(key, promise); }
  return promise;
};
const hostStorage = async parentId => {
  return rawHostStorage(parentId);
};
const readMedia = (parentId, payload) => readHostMedia(parentId, payload);
const artifactsScope = (parentId, payload) => artifactGrantForHost(parentId, payload);
const hostSettings = (parentId, settings) => callHost(parentId, 'component.settings', settings === undefined ? { action: 'get' } : { action: 'merge', settings });
const selectInputFiles = (parentId, { title = '选择图片', multiple = true } = {}) => callHost(parentId, 'dialogs', { kind: 'openFiles', title, extensions: [...RETURN_IMAGE_EXTENSIONS].map(value => value.slice(1)), multiple });
const materializeInputStage = async (parentId, tokens) => {
  const stageId = crypto.randomUUID(); const items = []; const directories = new Set();
  try {
    for (const [index, token] of (tokens || []).entries()) { const input = await materializeInput(parentId, token); directories.add(path.dirname(input.privatePath)); items.push({ id: input.inputId, name: path.basename(input.privatePath), path: input.privatePath, index }); }
    inputStages.set(stageId, [...directories]); return { stageId, items };
  } catch (error) { for (const directory of directories) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined); throw error; }
};
const discardInputStage = async stageId => {
  for (const directory of inputStages.get(String(stageId)) || []) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  inputStages.delete(String(stageId));
};
const PROGRESS_EVENTS = Object.freeze({
  'patch.detect.progress': 'team.patch.detect.progress.v1',
  'patch.detect-batch.progress': 'team.patch.detect-batch.progress.v1',
  'patch.return-batch.progress': 'team.return.progress.v1',
  'workflow.progress': 'team.workflow.progress.v1',
});
const emitProgress = (parentId, topic, event) => {
  const declaredTopic = PROGRESS_EVENTS[String(topic || '')];
  if (!declaredTopic) return Promise.reject(new Error(`Unknown component progress topic: ${topic}`));
  return callHost(parentId, 'component.events', { topic: declaredTopic, event });
};
const hostTask = async (parentId, operationId, action, update = {}, topic = '') => {
  const mapped = action === 'failed' ? 'fail' : action;
  if (mapped === 'latest') return { task: null, cancelled: false };
  const result = await callHost(parentId, 'tasks', { action: mapped, operationId: String(operationId || 'team-operation'), title: update.title, message: update.message, progress: update.progress, phase: update.phase, checkpoint: update.checkpoint, error: update.error });
  if (topic) await emitProgress(parentId, topic, update).catch(() => undefined);
  return result;
};
const lifecycleAction = (parentId, action) => callHost(parentId, 'component.lifecycle', { action });
const OUTPUT_OUTBOX = Symbol('team-output-outbox');
const attachOutputOutbox = (receipt, record) => { if (receipt && typeof receipt === 'object') Object.defineProperty(receipt, OUTPUT_OUTBOX, { value: record, enumerable: false }); return receipt; };

const outputOutboxFingerprint = ({ idempotencyKey, files }) => sha256(JSON.stringify({
  idempotencyKey: String(idempotencyKey),
  files: files.map(file => ({ outputRelativePath: String(file.outputRelativePath), digest: String(file.digest), replacement: file.replacement || null })),
}));
const readOutputOutbox = (db, projectId, fingerprint) => db.prepare('SELECT * FROM team_output_outbox WHERE project_id=? AND fingerprint=?').get(String(projectId), String(fingerprint));
const readOutputOutboxByKey = (db, projectId, idempotencyKey) => db.prepare('SELECT * FROM team_output_outbox WHERE project_id=? AND idempotency_key=?').get(String(projectId), String(idempotencyKey));
const updateOutputOutbox = (db, projectId, fingerprint, state, values = {}) => {
  db.prepare(`UPDATE team_output_outbox SET state=?,stage_id=COALESCE(?,stage_id),receipt_json=COALESCE(?,receipt_json),result_json=COALESCE(?,result_json),last_error=?,updated_at=? WHERE project_id=? AND fingerprint=?`)
    .run(state, values.stageId === undefined ? null : String(values.stageId), values.receipt === undefined ? null : JSON.stringify(values.receipt), values.result === undefined ? null : JSON.stringify(values.result), String(values.error || ''), Date.now(), String(projectId), String(fingerprint));
};
const prepareOutputOutbox = async (parentId, files, idempotencyKey, kind = 'project-output', continuationPlan = null) => {
  const storage = await hostStorage(parentId); const projectId = String(storage.projectId || activeProjectId());
  if (!projectId) throw new Error('Host component storage is missing the bound project id');
  let lookupDb; let byKey;
  try { lookupDb = ensureSchema(storage.databasePath); byKey = readOutputOutboxByKey(lookupDb, projectId, idempotencyKey); }
  finally { try { lookupDb?.close(); } catch { /* no leaked SQLite handle */ } }
  if (byKey) {
    const storedSources = parseJson(byKey.source_json, []); const storedTargets = parseJson(byKey.target_json, []);
    const described = storedTargets.map((target, index) => ({ sourcePath: storedSources[index]?.sourcePath || files[index]?.sourcePath || '', digest: storedSources[index]?.digest || '', outputRelativePath: target.outputRelativePath, replacement: target.replacement || null }));
    const incomingTargets = files.map(file => ({ outputRelativePath: String(file.outputRelativePath), replacement: file.replacement || null }));
    if (JSON.stringify(incomingTargets) !== JSON.stringify(storedTargets)) throw Object.assign(new Error('Host output idempotency key is already bound to another publication plan'), { code: 'COMPONENT_OUTPUT_IDEMPOTENCY_CONFLICT' });
    const storedPlan = parseJson(byKey.result_json, {}).continuationPlan;
    if (continuationPlan && JSON.stringify(storedPlan || null) !== JSON.stringify(continuationPlan)) throw Object.assign(new Error('Host output continuation plan conflicts with the persisted idempotency key'), { code: 'COMPONENT_OUTPUT_CONTINUATION_CONFLICT' });
    return { storage, projectId, fingerprint: byKey.fingerprint, files: described, row: byKey };
  }
  const described = [];
  for (const file of files) described.push({ ...file, digest: await fileSha256(file.sourcePath), replacement: file.replacement || null });
  const fingerprint = outputOutboxFingerprint({ idempotencyKey, files: described });
  let db;
  try {
    db = ensureSchema(storage.databasePath);
    const existing = readOutputOutbox(db, projectId, fingerprint);
    if (!existing) db.prepare(`INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,stage_id,source_json,target_json,receipt_json,result_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,'planned','',?,?,'{}',?,'',?,?)`)
      .run(projectId, crypto.randomUUID(), kind, fingerprint, String(idempotencyKey), JSON.stringify(described.map(file => ({ sourcePath: file.sourcePath, digest: file.digest }))), JSON.stringify(described.map(file => ({ outputRelativePath: file.outputRelativePath, replacement: file.replacement || null }))), JSON.stringify({ continuationPlan }), Date.now(), Date.now());
    return { storage, projectId, fingerprint, files: described, row: readOutputOutbox(db, projectId, fingerprint) };
  } finally { db.close(); }
};
const validateOutputReceipt = (record, receipt) => {
  if (!receipt?.commitId || String(receipt.idempotencyKey || '') !== String(record.row.idempotency_key)) throw Object.assign(new Error('Host output receipt key or commit is invalid'), { code: 'COMPONENT_OUTPUT_RECEIPT_MISMATCH' });
  const outputs = Array.isArray(receipt.outputs) ? receipt.outputs : [];
  if (outputs.length !== record.files.length) throw Object.assign(new Error('Host output receipt item count does not match the plan'), { code: 'COMPONENT_OUTPUT_RECEIPT_MISMATCH' });
  for (const file of record.files) {
    const output = outputs.find(item => String(item.relativePath) === String(file.outputRelativePath));
    if (!output?.artifactId || String(output.sha256 || '').toLowerCase() !== String(file.digest || '').toLowerCase()) throw Object.assign(new Error(`Host output receipt does not match ${file.outputRelativePath}`), { code: 'COMPONENT_OUTPUT_RECEIPT_MISMATCH' });
  }
  return receipt;
};
const outboxState = async (record, state, values = {}) => {
  const db = ensureSchema(record.storage.databasePath);
  try {
    if (values.result) values = { ...values, result: { ...parseJson(record.row.result_json, {}), ...values.result } };
    updateOutputOutbox(db, record.projectId, record.fingerprint, state, values); record.row = readOutputOutbox(db, record.projectId, record.fingerprint);
  }
  finally { db.close(); }
};
const deleteUncommittedOutputOutbox = async (record, expectedState) => {
  await assertCurrentRevisionLease(); const db = ensureSchema(record.storage.databasePath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const removed = db.prepare('DELETE FROM team_output_outbox WHERE project_id=? AND id=? AND fingerprint=? AND state=? AND receipt_json=?').run(record.projectId, record.row.id, record.fingerprint, expectedState, '{}').changes;
    if (removed !== 1) throw recoveryRequiredError(`outbox ${record.row.id} 未提交状态在终结时发生变化`);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
};

const publishProjectFile = async (parentId, sourcePath, outputRelativePath, idempotencyKey, replacement = null, kind = 'project-output', continuationPlan = null) => {
  const record = await prepareOutputOutbox(parentId, [{ sourcePath, outputRelativePath, replacement }], idempotencyKey, kind, continuationPlan);
  const priorReceipt = parseJson(record.row.receipt_json, {});
  if (record.row.state === 'completed' || Object.keys(priorReceipt).length) return attachOutputOutbox(validateOutputReceipt(record, priorReceipt), record);
  let stage = record.row.stage_id ? { stageId: record.row.stage_id, privatePath: parseJson(record.row.result_json, {}).stagePrivatePath } : null;
  try {
    if (!stage?.stageId) {
      stage = await callHost(parentId, 'project.output', { action: 'stage' });
      await outboxState(record, 'host_staging', { stageId: stage.stageId, result: { stagePrivatePath: stage.privatePath } });
    }
    if (!['host_staged','commit_inflight'].includes(record.row.state)) {
      if (!stage.privatePath) throw Object.assign(new Error('团片输出 stage 回执不完整，无法安全续跑'), { code: 'COMPONENT_OUTPUT_STAGE_LOST', retryable: true });
      const file = record.files[0]; const name = path.basename(file.sourcePath); const sourceName = `0001-${name}`; const stagedPath = path.join(stage.privatePath, sourceName);
      if (!fs.existsSync(stagedPath)) await fs.promises.copyFile(file.sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
      if (await fileSha256(stagedPath) !== file.digest) throw new Error('团片输出 stage 文件摘要不匹配');
      await callHost(parentId, 'project.output', { action: 'write', stageId: stage.stageId, name, sourceName, outputRelativePath, ...(replacement ? { replace: true, previousCommitId: replacement.commitId, previousArtifactId: replacement.artifactId, expectedDigest: replacement.sha256 } : {}) });
      await callHost(parentId, 'project.output', { action: 'validate', stageId: stage.stageId });
      await outboxState(record, 'host_staged');
    }
    await outboxState(record, 'commit_inflight');
    const receipt = await callHost(parentId, 'project.output', { action: 'commit', stageId: stage.stageId, idempotencyKey });
    validateOutputReceipt(record, receipt); await outboxState(record, 'output_committed', { receipt });
    return attachOutputOutbox(receipt, record);
  } catch (error) { await outboxState(record, record.row.state || 'planned', { error: error.message || String(error) }).catch(() => undefined); throw error; }
  finally { if (stage?.stageId && parseJson(record.row.receipt_json, {})?.commitId) void callHost(parentId, 'project.output', { action: 'rollback', stageId: stage.stageId }).catch(() => undefined); }
};
const publishProjectFiles = async (parentId, files, idempotencyKey, replacements = new Map(), continuationPlan = null) => {
  const record = await prepareOutputOutbox(parentId, files.map(file => ({ ...file, replacement: replacements.get(file.outputRelativePath) || null })), idempotencyKey, 'workflow-output', continuationPlan);
  const priorReceipt = parseJson(record.row.receipt_json, {});
  if (record.row.state === 'completed' || Object.keys(priorReceipt).length) return attachOutputOutbox(validateOutputReceipt(record, priorReceipt), record);
  let stage = record.row.stage_id ? { stageId: record.row.stage_id, privatePath: parseJson(record.row.result_json, {}).stagePrivatePath } : null;
  try {
    if (!stage?.stageId) { stage = await callHost(parentId, 'project.output', { action: 'stage' }); await outboxState(record, 'host_staging', { stageId: stage.stageId, result: { stagePrivatePath: stage.privatePath } }); }
    if (!['host_staged','commit_inflight'].includes(record.row.state)) {
      if (!stage.privatePath) throw Object.assign(new Error('团片输出 stage 回执不完整，无法安全续跑'), { code: 'COMPONENT_OUTPUT_STAGE_LOST', retryable: true });
      for (const [index, file] of record.files.entries()) {
        const name = path.basename(file.sourcePath); const sourceName = `${String(index + 1).padStart(4, '0')}-${name}`; const stagedPath = path.join(stage.privatePath, sourceName);
        if (!fs.existsSync(stagedPath)) await fs.promises.copyFile(file.sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
        if (await fileSha256(stagedPath) !== file.digest) throw new Error('团片输出 stage 文件摘要不匹配');
        const previous = file.replacement;
        await callHost(parentId, 'project.output', { action: 'write', stageId: stage.stageId, name, sourceName, outputRelativePath: file.outputRelativePath, ...(previous ? { replace: true, previousCommitId: previous.commitId, previousArtifactId: previous.artifactId, expectedDigest: previous.sha256 } : {}) });
      }
      await callHost(parentId, 'project.output', { action: 'validate', stageId: stage.stageId }); await outboxState(record, 'host_staged');
    }
    await outboxState(record, 'commit_inflight');
    const receipt = await callHost(parentId, 'project.output', { action: 'commit', stageId: stage.stageId, idempotencyKey });
    validateOutputReceipt(record, receipt); await outboxState(record, 'output_committed', { receipt }); return attachOutputOutbox(receipt, record);
  } catch (error) { await outboxState(record, record.row.state || 'planned', { error: error.message || String(error) }).catch(() => undefined); throw error; }
  finally { if (stage?.stageId && parseJson(record.row.receipt_json, {})?.commitId) void callHost(parentId, 'project.output', { action: 'rollback', stageId: stage.stageId }).catch(() => undefined); }
};
const createVersionFromOutput = async (parentId, committed, payload) => {
  const record = committed?.[OUTPUT_OUTBOX];
  if (!record) return callHost(parentId, 'version.create', payload);
  const stored = parseJson(record.row.result_json, {});
  if (stored.versionPayload && JSON.stringify(stored.versionPayload) !== JSON.stringify(payload)) throw Object.assign(new Error('Version idempotency tuple conflicts with the persisted output plan'), { code: 'COMPONENT_VERSION_IDEMPOTENCY_CONFLICT' });
  if (stored.versionResult?.versionId) return stored.versionResult;
  await outboxState(record, 'version_inflight', { result: { ...stored, versionPayload: payload } });
  const result = await callHost(parentId, 'version.create', payload);
  if (!result?.versionId || (result.result?.photo?.id && String(result.result.photo.id) !== String(payload.photoId))) throw Object.assign(new Error('Host version receipt does not match the planned photo tuple'), { code: 'COMPONENT_VERSION_RECEIPT_MISMATCH' });
  await outboxState(record, 'domain_pending', { result: { ...parseJson(record.row.result_json, {}), versionPayload: payload, versionResult: result } });
  return result;
};
const completeOutputPublication = async committed => {
  const record = committed?.[OUTPUT_OUTBOX];
  if (record) { await outboxState(record, 'domain_committed'); await outboxState(record, 'completed'); }
};
const recoveryRequiredError = detail => Object.assign(new Error(`团片输出恢复需要人工处理：${detail}`), { code: 'COMPONENT_RECOVERY_REQUIRED', retryable: false });
const recoverProjectOutputOutbox = async (parentId, context, batchSize = 20) => {
  const storage = await hostStorage(parentId); let attempted = 0; let recovered = 0;
  for (let batch = 0; batch < 256; batch += 1) {
    const db = ensureSchema(storage.databasePath); let rows;
    try { rows = db.prepare("SELECT * FROM team_output_outbox WHERE project_id=? AND state<>'completed' ORDER BY created_at,id LIMIT ?").all(String(context.projectId), Math.max(1, Number(batchSize) || 1)); }
    finally { db.close(); }
    if (!rows.length) return { attempted, recovered, pending: 0 };
    const plannedRows = rows.filter(row => row.state === 'planned');
    if (plannedRows.length) {
      for (const row of plannedRows) {
        const plan = parseJson(row.result_json, {}).continuationPlan;
        if (!plan || Number(plan.version) !== 1 || String(plan.projectId) !== String(context.projectId) || String(plan.kind) !== String(row.kind) || plan.preHostLocalEffects !== 'none') throw recoveryRequiredError(`outbox ${row.id} planned 无法证明 continuation/本地副作`);
      }
      const deleteDb = ensureSchema(storage.databasePath);
      try {
        deleteDb.exec('BEGIN IMMEDIATE'); const remove = deleteDb.prepare("DELETE FROM team_output_outbox WHERE project_id=? AND id=? AND state='planned' AND receipt_json='{}'");
        for (const row of plannedRows) if (remove.run(String(context.projectId), row.id).changes !== 1) throw recoveryRequiredError(`outbox ${row.id} planned 状态已变化`);
        deleteDb.exec('COMMIT');
      } catch (error) { try { deleteDb.exec('ROLLBACK'); } catch {} throw error; }
      finally { deleteDb.close(); }
      attempted += plannedRows.length; recovered += plannedRows.length; rows = rows.filter(row => row.state !== 'planned');
    }
    for (const row of rows) {
      attempted += 1; assertNotAborted(context.signal);
      const sources = parseJson(row.source_json, []); const targets = parseJson(row.target_json, []); let result = parseJson(row.result_json, {});
      const plan = result.continuationPlan;
      if (!plan || Number(plan.version) !== 1 || String(plan.projectId) !== String(context.projectId) || String(plan.kind) !== String(row.kind)) throw recoveryRequiredError(`outbox ${row.id} 缺少完整 continuation plan`);
      const record = { storage, projectId: String(context.projectId), fingerprint: row.fingerprint, row, files: targets.map((target, index) => ({ ...target, sourcePath: sources[index]?.sourcePath || '', digest: sources[index]?.digest || '' })) };
      let receipt = parseJson(row.receipt_json, {});
      if (row.state === 'restore_republish') {
        const source = record.files[0]; if (!source?.sourcePath || !fs.existsSync(source.sourcePath) || await fileSha256(source.sourcePath) !== source.digest) throw recoveryRequiredError(`working restore outbox ${row.id} 私有副本缺失或摘要不匹配`);
        const committed = await publishProjectFile(parentId, source.sourcePath, source.outputRelativePath, row.idempotency_key, null, row.kind, plan);
        receipt = committed; record.row = committed[OUTPUT_OUTBOX].row; result = parseJson(record.row.result_json, {});
      }
      if (row.state === 'host_staging') {
        if (!row.stage_id) throw recoveryRequiredError(`outbox ${row.id} host_staging 缺少 stageId`);
        let rollback;
        try { rollback = await callHost(parentId, 'project.output', { action: 'rollback', stageId: row.stage_id }); }
        catch (error) { throw recoveryRequiredError(`outbox ${row.id} Host stage rollback 失败：${error.message || error}`); }
        if (rollback?.rolledBack !== true || (rollback.stageId && String(rollback.stageId) !== String(row.stage_id))) throw recoveryRequiredError(`outbox ${row.id} Host stage rollback 未确认`);
        if (plan.preHostLocalEffects !== 'none') throw recoveryRequiredError(`outbox ${row.id} Host stage 前存在未证明的本地副作`);
        await deleteUncommittedOutputOutbox(record, 'host_staging'); recovered += 1; continue;
      }
      if (['host_staged','commit_inflight'].includes(row.state)) {
        await outboxState(record, 'commit_inflight');
        receipt = await callHost(parentId, 'project.output', { action: 'commit', stageId: row.stage_id, idempotencyKey: row.idempotency_key });
        validateOutputReceipt(record, receipt); await outboxState(record, 'output_committed', { receipt }); result = parseJson(record.row.result_json, {});
      } else if (receipt.commitId) validateOutputReceipt(record, receipt);
      if (!receipt.commitId && !['domain_committed','cleanup_pending'].includes(record.row.state)) throw recoveryRequiredError(`outbox ${row.id} 状态 ${record.row.state} 没有 Host receipt`);
      if (['domain_committed','cleanup_pending'].includes(record.row.state)) { await outboxState(record, 'completed'); recovered += 1; continue; }
      const output = receipt.outputs?.[0];
      if (row.kind === 'working-output') {
        if (!plan.domain) throw recoveryRequiredError(`working outbox ${row.id} 缺少 task/photo continuation`);
        let materialized = result.materialized;
        if (!materialized?.privatePath) {
          await outboxState(record, 'materialize_inflight');
          materialized = await callHost(parentId, 'project.output', { action: 'materializeOwned', commitId: receipt.commitId, artifactId: output.artifactId });
          await outboxState(record, 'domain_pending', { result: { materialized } }); result = parseJson(record.row.result_json, {});
        }
        const ledger = await readJson(plan.ledgerPath, {}); ledger[plan.outputRelativePath] = { commitId: receipt.commitId, artifactId: output.artifactId, sha256: output.sha256 };
        await replaceJsonAtomic(plan.ledgerPath, ledger);
        const domainDb = ensureSchema(storage.databasePath);
        try { domainDb.exec('BEGIN IMMEDIATE'); restoreWorkingTaskDomain(domainDb, context, plan.domain, materialized.privatePath); domainDb.exec('COMMIT'); }
        catch (error) { try { domainDb.exec('ROLLBACK'); } catch {} throw error; }
        finally { domainDb.close(); }
      } else if (row.kind === 'workflow-output') {
        if (!plan.localSwap?.outputDirectory || !plan.localSwap?.stagingDirectory || !plan.localSwap?.swapToken) throw recoveryRequiredError(`workflow outbox ${row.id} 缺少本地 swap plan`);
        const distinctStage = path.resolve(plan.localSwap.stagingDirectory) !== path.resolve(plan.localSwap.outputDirectory);
        if (distinctStage && fs.existsSync(plan.localSwap.stagingDirectory)) {
          replacePersistentFromStage(plan.localSwap.stagingDirectory, plan.localSwap.outputDirectory, plan.localSwap.swapToken);
        } else {
          const expectedFiles = (plan.outputs || []).map(item => String(item.relativePath || '')).filter(Boolean).sort();
          const actualFiles = (await listRelativeFiles(plan.localSwap.outputDirectory)).filter(item => item !== '.photoflow-workflow-checkpoint.json').sort();
          if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw recoveryRequiredError(`workflow outbox ${row.id} current 文件集与计划不精确一致`);
          for (const item of plan.outputs || []) {
            const currentPath = path.resolve(plan.localSwap.outputDirectory, item.relativePath || '');
            if (!item.relativePath || !isInside(plan.localSwap.outputDirectory, currentPath) || !item.digest || await fileSha256(currentPath) !== item.digest) throw recoveryRequiredError(`workflow outbox ${row.id} current 摘要与计划不一致`);
          }
        }
        const manifest = JSON.parse(JSON.stringify(plan.manifest));
        manifest.outputOwnership = Object.fromEntries((receipt.outputs || []).map(item => {
          const planned = (plan.outputs || []).find(value => value.outputRelativePath === item.relativePath);
          return [planned?.ownershipKey || item.relativePath, { commitId: receipt.commitId, artifactId: item.artifactId, sha256: item.sha256, publishedRelativePath: item.relativePath }];
        }));
        await writeJsonAtomic(plan.manifestPath, manifest);
        const domainDb = ensureSchema(storage.databasePath);
        try {
          domainDb.exec('BEGIN IMMEDIATE'); domainDb.prepare('INSERT INTO team_workflow_state(project_id,generated_at,fingerprint,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET generated_at=excluded.generated_at,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at').run(String(context.projectId), Number(plan.workflowState.generatedAt), String(plan.workflowState.fingerprint), Date.now());
          if (plan.localSwap.backupDirectory && fs.existsSync(plan.localSwap.backupDirectory)) queueCleanupArtifacts(domainDb, context.projectId, [plan.localSwap.backupDirectory]); domainDb.exec('COMMIT');
        } catch (error) { try { domainDb.exec('ROLLBACK'); } catch {} throw error; }
        finally { domainDb.close(); }
        if (Array.isArray(plan.retiredOutputs) && plan.retiredOutputs.length) await retryWorkflowOutputCleanup(parentId, storage, context, plan.retiredOutputs);
      } else if (row.kind === 'relay-output') {
        const manifest = JSON.parse(JSON.stringify(plan.manifest)); manifest.outputOwnership = { ...(manifest.outputOwnership || {}), [plan.activeRelativePath]: { commitId: receipt.commitId, artifactId: output.artifactId, sha256: output.sha256, publishedRelativePath: output.relativePath } };
        await writeJsonAtomic(plan.manifestPath, manifest);
      } else if (row.kind === 'merge-output') {
        let versionPayload = result.versionPayload;
        if (!versionPayload) versionPayload = { ...plan.versionPayloadTemplate, commitId: receipt.commitId, artifactId: output.artifactId };
        if (!result.versionResult?.versionId) {
          await outboxState(record, 'version_inflight', { result: { versionPayload } });
          const versionResult = await callHost(parentId, 'version.create', versionPayload);
          if (!versionResult?.versionId || (versionResult.result?.photo?.id && String(versionResult.result.photo.id) !== String(versionPayload.photoId))) throw Object.assign(new Error('Recovered Host version receipt mismatched the persisted tuple'), { code: 'COMPONENT_VERSION_RECEIPT_MISMATCH' });
          await outboxState(record, 'domain_pending', { result: { versionPayload, versionResult } }); result = parseJson(record.row.result_json, {});
        }
        const domainDb = ensureSchema(storage.databasePath);
        try {
          domainDb.exec('BEGIN IMMEDIATE');
          for (const task of plan.domain.tasks) {
            const changed = domainDb.prepare("UPDATE team_patch_tasks SET status='merged',merged_version_id=?,merge_metrics_json=?,updated_at=? WHERE project_id=? AND id=? AND photo_id=? AND base_version_id=? AND is_deleted=0").run(String(result.versionResult.versionId), JSON.stringify(plan.domain.mergeMetrics.find(item => item.taskId === task.id) || {}), Date.now(), String(context.projectId), task.id, plan.domain.photoId, plan.domain.baseVersionId).changes;
            if (changed !== 1) throw recoveryRequiredError(`merge task ${task.id} 已变化`);
          }
          domainDb.exec('COMMIT');
        } catch (error) { try { domainDb.exec('ROLLBACK'); } catch {} throw error; }
        finally { domainDb.close(); }
      } else throw recoveryRequiredError(`outbox ${row.id} kind ${row.kind} 不可恢复`);
      await outboxState(record, 'domain_committed'); await outboxState(record, 'completed'); recovered += 1;
    }
  }
  const finalDb = ensureSchema(storage.databasePath); let remaining;
  try { remaining = Number(finalDb.prepare("SELECT COUNT(*) count FROM team_output_outbox WHERE project_id=? AND state<>'completed'").get(String(context.projectId))?.count) || 0; }
  finally { finalDb.close(); }
  if (!remaining) return { attempted, recovered, pending: 0 };
  throw recoveryRequiredError('outbox drain 超过有界批次，无法证明状态稳定前进');
};
const publishWorkingImageUnlocked = async (parentId, storage, sourcePath, baseRelativePath, domainPlan = null) => {
  const normalizedBase = String(baseRelativePath || '').replace(/\\/g, '/'); const parsed = path.posix.parse(normalizedBase);
  const outputRelativePath = [parsed.dir, `${parsed.name}_裁切`, path.basename(sourcePath)].filter(Boolean).join('/');
  const ledgerPath = path.join(storage.dataPath, 'output-ownership', sha256(String(storage.projectId)), 'working-images.json'); const ledger = await readJson(ledgerPath, {});
  const previous = ledger[outputRelativePath] || null;
  const sourceDigest = await fileSha256(sourcePath);
  const stableBusinessKey = `${storage.projectId}\0${normalizedBase}\0${outputRelativePath}\0${sourceDigest}\0${JSON.stringify(previous || null)}`;
  const continuationPlan = { version: 1, kind: 'working-output', projectId: String(storage.projectId), preHostLocalEffects: 'none', ledgerPath, outputRelativePath, domain: domainPlan };
  const committed = await publishProjectFile(parentId, sourcePath, outputRelativePath, `working-${sha256(stableBusinessKey).slice(0, 40)}`, previous, 'working-output', continuationPlan);
  const output = committed.outputs[0]; const record = committed[OUTPUT_OUTBOX]; let imported = parseJson(record?.row?.result_json, {}).materialized;
  if (!imported?.privatePath) {
    if (record) await outboxState(record, 'materialize_inflight', { result: { ...parseJson(record.row.result_json, {}) } });
    imported = await callHost(parentId, 'project.output', { action: 'materializeOwned', commitId: committed.commitId, artifactId: output.artifactId });
    if (record) await outboxState(record, 'materialized', { result: { ...parseJson(record.row.result_json, {}), materialized: imported } });
  }
  if (record) await outboxState(record, 'domain_pending', { result: { ...parseJson(record.row.result_json, {}), materialized: imported, ledgerPath, outputRelativePath } });
  ledger[outputRelativePath] = { commitId: committed.commitId, artifactId: output.artifactId, sha256: output.sha256 };
  await replaceJsonAtomic(ledgerPath, ledger);
  return { privatePath: imported.privatePath, outputRelativePath, ownership: ledger[outputRelativePath], publication: committed };
};
const publishWorkingImage = (parentId, storage, sourcePath, baseRelativePath, domainPlan = null) => withKeyedOperation(
  workingOwnershipOperations, String(storage.projectId),
  () => publishWorkingImageUnlocked(parentId, storage, sourcePath, baseRelativePath, domainPlan),
);

const ensureSchema = databasePath => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const schemaSignature = () => ['', '-wal'].map(suffix => { const stat = fs.statSync(`${databasePath}${suffix}`, { throwIfNoEntry: false }); return stat ? `${stat.size}:${stat.mtimeMs}` : '-'; }).join('|');
  const beforeSignature = schemaSignature();
  const db = new DatabaseSync(databasePath);
  db.function('team_request_id', () => String(revisionRequestContext.getStore()?.requestId || ''));
  db.function('team_now_ms', () => Date.now());
  db.exec(`PRAGMA busy_timeout=${DB_BUSY_TIMEOUT_MS}; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);
  if (schemaReadyPaths.get(databasePath) === beforeSignature) return db;
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const storedVersion = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  const userTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'meta'").all();
  if (storedVersion !== undefined && String(storedVersion) !== '10') { db.close(); throw new Error(`团片数据库版本 ${storedVersion} 不是当前首发 schema 10；已拒绝迁移打开`); }
  if (storedVersion === undefined && userTables.length) { db.close(); throw new Error('团片数据库缺少当前 schema_version=10 标记；已拒绝兼容推断'); }
  const requiredColumns = {
    team_project_revisions: ['project_id','revision'], team_revision_guards: ['request_id','project_id','expected_revision','bumped','created_at'], team_project_revision_leases: ['project_id','request_id','expires_at'],
    team_patch_tasks: ['project_id','id','photo_id','base_version_id','person_index','person_name','assignee','detector','bbox_json','crop_json','patch_path','mask_path','mask_json','members_json','needs_review','review_reason','edited_patch_path','status','merge_metrics_json','merged_version_id','generation_json','created_at','updated_at','is_deleted'],
    team_retouch_photos: ['photo_id','project_id','base_version_id','display_name','relative_path','relative_path_state','file_missing','created_at','updated_at'],
    team_person_identities: ['id','project_id','name','color','created_at','updated_at'], team_person_assignments: ['project_id','photo_id','base_version_id','person_index','identity_id','confidence','source','completed','completion_kind','edited_patch_path','return_missing','return_missing_since','completed_at','task_id','stage_id','artifact_id','updated_at'], team_person_exclusions: ['id','project_id','photo_id','base_version_id','bbox_json','reason','created_at'],
    team_task_stages: ['project_id','id','task_id','person_index','stage_order','state','created_at','updated_at'], team_task_artifacts: ['project_id','id','task_id','stage_id','person_index','kind','artifact_path','digest','metadata_json','created_at','is_deleted'], team_workflow_reconcile_pending: ['project_id','task_id','photo_id','error','attempt_count','next_attempt_at','last_error','history_json','updated_at'],
    team_workflow_review_confirmations: ['project_id','review_session_id','return_id','task_id','photo_id','base_version_id','person_index','created_at'], team_durable_operations: ['id','project_id','kind','state','phase','progress','request_json','checkpoint_json','result_json','error','cancel_requested','base_revision','created_at','updated_at'], team_workflow_settings: ['project_id','settings_json','updated_at'], team_workflow_state: ['project_id','generated_at','fingerprint','updated_at'], team_review_state: ['project_id','updated_at'],
    team_output_outbox: ['project_id','id','kind','fingerprint','idempotency_key','state','stage_id','source_json','target_json','receipt_json','result_json','last_error','created_at','updated_at'],
    team_cleanup_outbox: ['project_id','id','artifact_path','state','attempt_count','last_error','created_at','updated_at'],
  };
  const primaryKeys = {
    team_project_revisions: ['project_id'], team_revision_guards: ['request_id'], team_project_revision_leases: ['project_id'], team_patch_tasks: ['project_id','id'], team_retouch_photos: ['project_id','photo_id'], team_person_identities: ['project_id','id'], team_person_assignments: ['project_id','photo_id','base_version_id','person_index'], team_person_exclusions: ['project_id','id'], team_task_stages: ['project_id','id'], team_task_artifacts: ['project_id','id'], team_workflow_reconcile_pending: ['project_id','task_id'], team_workflow_review_confirmations: ['project_id','review_session_id','return_id'], team_durable_operations: ['project_id','id'], team_workflow_settings: ['project_id'], team_workflow_state: ['project_id'], team_review_state: ['project_id'], team_output_outbox: ['project_id','id'], team_cleanup_outbox: ['project_id','id'],
  };
  const realColumns = new Set(['confidence','progress']);
  const integerColumns = new Set(['revision','expected_revision','bumped','created_at','updated_at','expires_at','person_index','needs_review','is_deleted','file_missing','completed','return_missing','return_missing_since','completed_at','stage_order','attempt_count','next_attempt_at','cancel_requested','base_revision','generated_at']);
  const nullableColumns = new Set(['team_patch_tasks.mask_path','team_patch_tasks.edited_patch_path','team_patch_tasks.merged_version_id','team_person_assignments.identity_id','team_person_assignments.edited_patch_path','team_person_assignments.return_missing_since','team_person_assignments.completed_at','team_person_assignments.task_id','team_person_assignments.stage_id','team_person_assignments.artifact_id','team_task_artifacts.stage_id','team_task_artifacts.person_index']);
  const inlinePrimaryKeys = new Set(['team_project_revisions.project_id','team_revision_guards.request_id','team_project_revision_leases.project_id','team_workflow_settings.project_id','team_workflow_state.project_id','team_review_state.project_id']);
  const defaults = {
    'team_project_revisions.revision': '0','team_revision_guards.bumped': '0','team_patch_tasks.assignee': "''",'team_patch_tasks.detector': "''",'team_patch_tasks.mask_json': "'{}'",'team_patch_tasks.members_json': "'[]'",'team_patch_tasks.needs_review': '0','team_patch_tasks.review_reason': "''",'team_patch_tasks.status': "'exported'",'team_patch_tasks.merge_metrics_json': "'{}'",'team_patch_tasks.generation_json': "'{}'",'team_patch_tasks.is_deleted': '0',
    'team_retouch_photos.display_name': "''",'team_retouch_photos.relative_path': "''",'team_retouch_photos.relative_path_state': "'unresolvable'",'team_retouch_photos.file_missing': '0','team_person_identities.color': "'#2563eb'",'team_person_assignments.confidence': '0','team_person_assignments.source': "'manual'",'team_person_assignments.completed': '0','team_person_assignments.completion_kind': "''",'team_person_assignments.return_missing': '0','team_person_exclusions.reason': "'false-positive'",'team_task_stages.state': "'pending'",'team_task_artifacts.digest': "''",'team_task_artifacts.metadata_json': "'{}'",'team_task_artifacts.is_deleted': '0',
    'team_workflow_reconcile_pending.error': "''",'team_workflow_reconcile_pending.attempt_count': '0','team_workflow_reconcile_pending.next_attempt_at': '0','team_workflow_reconcile_pending.last_error': "''",'team_workflow_reconcile_pending.history_json': "'[]'",'team_durable_operations.phase': "'accepted'",'team_durable_operations.progress': '0','team_durable_operations.request_json': "'{}'",'team_durable_operations.checkpoint_json': "'{}'",'team_durable_operations.result_json': "'{}'",'team_durable_operations.error': "''",'team_durable_operations.cancel_requested': '0','team_durable_operations.base_revision': '0','team_workflow_settings.settings_json': "'{}'",'team_workflow_state.fingerprint': "''",
    'team_output_outbox.stage_id': "''",'team_output_outbox.source_json': "'[]'",'team_output_outbox.target_json': "'[]'",'team_output_outbox.receipt_json': "'{}'",'team_output_outbox.result_json': "'{}'",'team_output_outbox.last_error': "''",'team_cleanup_outbox.state': "'pending'",'team_cleanup_outbox.attempt_count': '0','team_cleanup_outbox.last_error': "''",
  };
  const validateCurrentTables = ({ allowMissingInfrastructure = false } = {}) => {
    for (const [table, required] of Object.entries(requiredColumns)) {
      const actual = db.prepare(`PRAGMA table_xinfo(${table})`).all();
      if (!actual.length && allowMissingInfrastructure && ['team_output_outbox','team_cleanup_outbox'].includes(table)) continue;
      if (actual.length !== required.length || actual.some((column, index) => column.name !== required[index] || Number(column.hidden) !== 0)) throw new Error(`团片 schema 10 表结构无效（列集合）：${table}`);
      const pk = primaryKeys[table] || [];
      for (const column of actual) {
        const expectedType = realColumns.has(column.name) ? 'REAL' : integerColumns.has(column.name) ? 'INTEGER' : 'TEXT';
        const expectedPk = pk.indexOf(column.name) + 1;
        const expectedNotNull = nullableColumns.has(`${table}.${column.name}`) || inlinePrimaryKeys.has(`${table}.${column.name}`) ? 0 : 1;
        const expectedDefault = defaults[`${table}.${column.name}`] ?? null;
        if (String(column.type).toUpperCase() !== expectedType || Number(column.pk) !== expectedPk || Number(column.notnull) !== expectedNotNull || column.dflt_value !== expectedDefault) throw new Error(`团片 schema 10 列约束无效：${table}.${column.name}`);
      }
      if (db.prepare(`PRAGMA foreign_key_list(${table})`).all().length) throw new Error(`团片 schema 10 包含未声明外键：${table}`);
    }
  };
  if (storedVersion !== undefined) {
    try { validateCurrentTables({ allowMissingInfrastructure: true }); }
    catch (error) { db.close(); throw error; }
  }
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS team_project_revisions (project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS team_revision_guards (request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, expected_revision INTEGER NOT NULL, bumped INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS team_project_revision_leases (project_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS team_patch_tasks (
      project_id TEXT NOT NULL, id TEXT NOT NULL, photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
      person_index INTEGER NOT NULL, person_name TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '',
      detector TEXT NOT NULL DEFAULT '', bbox_json TEXT NOT NULL, crop_json TEXT NOT NULL,
      patch_path TEXT NOT NULL, mask_path TEXT, mask_json TEXT NOT NULL DEFAULT '{}',
      members_json TEXT NOT NULL DEFAULT '[]', needs_review INTEGER NOT NULL DEFAULT 0,
      review_reason TEXT NOT NULL DEFAULT '', edited_patch_path TEXT, status TEXT NOT NULL DEFAULT 'exported',
      merge_metrics_json TEXT NOT NULL DEFAULT '{}', merged_version_id TEXT,
      generation_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id,id)
    );
    CREATE INDEX IF NOT EXISTS team_patch_photo ON team_patch_tasks(photo_id, base_version_id, is_deleted);
    CREATE TABLE IF NOT EXISTS team_retouch_photos (
      photo_id TEXT NOT NULL, project_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '', relative_path TEXT NOT NULL DEFAULT '',
      relative_path_state TEXT NOT NULL DEFAULT 'unresolvable', file_missing INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,photo_id)
    );
    CREATE INDEX IF NOT EXISTS team_retouch_photo_project ON team_retouch_photos(project_id, updated_at);
    CREATE TABLE IF NOT EXISTS team_person_identities (
      id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#2563eb',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS team_person_assignments (
      project_id TEXT NOT NULL, photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL, person_index INTEGER NOT NULL,
      identity_id TEXT, confidence REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual',
      completed INTEGER NOT NULL DEFAULT 0, completion_kind TEXT NOT NULL DEFAULT '', edited_patch_path TEXT,
      return_missing INTEGER NOT NULL DEFAULT 0, return_missing_since INTEGER, completed_at INTEGER,
      task_id TEXT, stage_id TEXT, artifact_id TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY (project_id,photo_id,base_version_id,person_index)
    );
    CREATE TABLE IF NOT EXISTS team_person_exclusions (
      id TEXT NOT NULL, project_id TEXT NOT NULL, photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
      bbox_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'false-positive', created_at INTEGER NOT NULL, PRIMARY KEY(project_id,id)
    );
    CREATE TABLE IF NOT EXISTS team_task_stages (
      project_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL, person_index INTEGER NOT NULL,
      stage_order INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,id), UNIQUE(project_id,task_id,person_index)
    );
    CREATE INDEX IF NOT EXISTS team_stage_task_order ON team_task_stages(task_id, stage_order);
    CREATE TABLE IF NOT EXISTS team_task_artifacts (
      project_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL, stage_id TEXT, person_index INTEGER,
      kind TEXT NOT NULL, artifact_path TEXT NOT NULL, digest TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id,id)
    );
    CREATE INDEX IF NOT EXISTS team_artifact_chain ON team_task_artifacts(task_id, created_at, is_deleted);
    CREATE TABLE IF NOT EXISTS team_workflow_reconcile_pending (
      project_id TEXT NOT NULL, task_id TEXT NOT NULL, photo_id TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '', history_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,task_id)
    );
    CREATE TABLE IF NOT EXISTS team_workflow_review_confirmations (
      project_id TEXT NOT NULL, review_session_id TEXT NOT NULL, return_id TEXT NOT NULL, task_id TEXT NOT NULL,
      photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL, person_index INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,review_session_id,return_id)
    );
    CREATE TABLE IF NOT EXISTS team_durable_operations (
      id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'accepted', progress REAL NOT NULL DEFAULT 0,
      request_json TEXT NOT NULL DEFAULT '{}', checkpoint_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '',
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      base_revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,id)
    );
    CREATE INDEX IF NOT EXISTS team_operation_project_state ON team_durable_operations(project_id,state,updated_at);
    CREATE TABLE IF NOT EXISTS team_workflow_settings (
      project_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_workflow_state (
      project_id TEXT PRIMARY KEY, generated_at INTEGER NOT NULL, fingerprint TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_review_state (project_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS team_output_outbox (
      project_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL,stage_id TEXT NOT NULL DEFAULT '',source_json TEXT NOT NULL DEFAULT '[]',target_json TEXT NOT NULL DEFAULT '[]',
      receipt_json TEXT NOT NULL DEFAULT '{}',result_json TEXT NOT NULL DEFAULT '{}',last_error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,id),UNIQUE(project_id,fingerprint)
    );
    CREATE TABLE IF NOT EXISTS team_cleanup_outbox (
      project_id TEXT NOT NULL,id TEXT NOT NULL,artifact_path TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(project_id,id),UNIQUE(project_id,artifact_path)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS team_photo_project_id ON team_retouch_photos(project_id,photo_id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_identity_project_id ON team_person_identities(project_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_task_project_id ON team_patch_tasks(project_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_assignment_project_subject ON team_person_assignments(project_id,photo_id,base_version_id,person_index);
    CREATE UNIQUE INDEX IF NOT EXISTS team_exclusion_project_id ON team_person_exclusions(project_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_stage_project_id ON team_task_stages(project_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_stage_project_task_person ON team_task_stages(project_id,task_id,person_index);
    CREATE UNIQUE INDEX IF NOT EXISTS team_artifact_project_id ON team_task_artifacts(project_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_pending_project_task ON team_workflow_reconcile_pending(project_id,task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_confirmation_project_return ON team_workflow_review_confirmations(project_id,review_session_id,return_id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_operation_project_id ON team_durable_operations(project_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_output_outbox_fingerprint ON team_output_outbox(project_id,fingerprint);
    CREATE UNIQUE INDEX IF NOT EXISTS team_output_outbox_idempotency ON team_output_outbox(project_id,idempotency_key);
    CREATE INDEX IF NOT EXISTS team_cleanup_outbox_state ON team_cleanup_outbox(project_id,state,updated_at);
    INSERT INTO meta(key,value) VALUES('schema_version','10') ON CONFLICT(key) DO NOTHING;
    COMMIT;
  `);
  validateCurrentTables();
  if (db.prepare('PRAGMA foreign_key_check').all().length) { db.close(); throw new Error('团片 schema 10 外键校验失败'); }
  const guardedTables = ['team_retouch_photos','team_person_identities','team_person_assignments','team_person_exclusions','team_patch_tasks','team_task_stages','team_task_artifacts','team_workflow_reconcile_pending','team_workflow_review_confirmations','team_workflow_settings','team_workflow_state','team_review_state'];
  for (const table of guardedTables) for (const action of ['INSERT','UPDATE','DELETE']) db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_lease_owner_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM team_revision_guards WHERE request_id=team_request_id())
        AND NOT EXISTS(SELECT 1 FROM team_revision_guards guard JOIN team_project_revision_leases lease ON lease.project_id=guard.project_id AND lease.request_id=guard.request_id WHERE guard.request_id=team_request_id() AND lease.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
        THEN RAISE(ABORT,'TEAM_REVISION_LEASE_LOST') END;
    END;
    CREATE TRIGGER IF NOT EXISTS ${table}_revision_guard_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM team_revision_guards WHERE request_id=team_request_id() AND bumped=0) AND (SELECT expected_revision FROM team_revision_guards WHERE request_id=team_request_id())>=0 AND (SELECT expected_revision FROM team_revision_guards WHERE request_id=team_request_id())<>COALESCE((SELECT revision FROM team_project_revisions WHERE project_id=(SELECT project_id FROM team_revision_guards WHERE request_id=team_request_id())),0) THEN RAISE(ABORT,'TEAM_REVISION_CONFLICT') END;
    END;
    CREATE TRIGGER IF NOT EXISTS ${table}_revision_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN
      INSERT INTO team_project_revisions(project_id,revision) SELECT project_id,0 FROM team_revision_guards WHERE request_id=team_request_id() ON CONFLICT(project_id) DO NOTHING;
      UPDATE team_project_revisions SET revision=revision+1 WHERE project_id=(SELECT project_id FROM team_revision_guards WHERE request_id=team_request_id()) AND EXISTS(SELECT 1 FROM team_revision_guards WHERE request_id=team_request_id() AND bumped=0);
      UPDATE team_revision_guards SET bumped=1 WHERE request_id=team_request_id();
    END;`);
  const expectedIndexes = {
    team_patch_photo: [0,['photo_id','base_version_id','is_deleted']], team_retouch_photo_project: [0,['project_id','updated_at']], team_stage_task_order: [0,['task_id','stage_order']], team_artifact_chain: [0,['task_id','created_at','is_deleted']], team_operation_project_state: [0,['project_id','state','updated_at']],
    team_photo_project_id: [1,['project_id','photo_id']], team_identity_project_id: [1,['project_id','id']], team_task_project_id: [1,['project_id','id']], team_assignment_project_subject: [1,['project_id','photo_id','base_version_id','person_index']], team_exclusion_project_id: [1,['project_id','id']], team_stage_project_id: [1,['project_id','id']], team_stage_project_task_person: [1,['project_id','task_id','person_index']], team_artifact_project_id: [1,['project_id','id']], team_pending_project_task: [1,['project_id','task_id']], team_confirmation_project_return: [1,['project_id','review_session_id','return_id']], team_operation_project_id: [1,['project_id','id']], team_output_outbox_fingerprint: [1,['project_id','fingerprint']], team_output_outbox_idempotency: [1,['project_id','idempotency_key']], team_cleanup_outbox_state: [0,['project_id','state','updated_at']],
  };
  for (const [name, [unique, names]] of Object.entries(expectedIndexes)) {
    const row = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(name);
    if (!row) { db.close(); throw new Error(`团片 schema 10 缺少索引：${name}`); }
    const listed = db.prepare(`PRAGMA index_list(${row.tbl_name})`).all().find(item => item.name === name);
    const actualNames = db.prepare(`PRAGMA index_info(${name})`).all().map(item => item.name);
    if (Number(listed?.unique) !== unique || JSON.stringify(actualNames) !== JSON.stringify(names)) { db.close(); throw new Error(`团片 schema 10 索引语义无效：${name}`); }
  }
  const expectedTriggers = new Set();
  for (const table of guardedTables) for (const action of ['insert','update','delete']) for (const family of ['lease_owner','revision_guard','revision']) expectedTriggers.add(`${table}_${family}_${action}`);
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'team_%'").all();
  if (triggers.length !== expectedTriggers.size || triggers.some(item => !expectedTriggers.has(item.name))) { db.close(); throw new Error('团片 schema 10 trigger 集合无效'); }
  for (const trigger of triggers) {
    const sql = String(trigger.sql || '').toLowerCase().replace(/\s+/g, ' ');
    const valid = trigger.name.includes('_lease_owner_') ? sql.includes('team_project_revision_leases') && sql.includes("raise(abort,'team_revision_lease_lost')") && sql.includes('team_request_id()')
      : trigger.name.includes('_revision_guard_') ? sql.includes("raise(abort,'team_revision_conflict')") && sql.includes('expected_revision') && sql.includes('team_request_id()')
        : sql.includes('team_project_revisions') && sql.includes('revision=revision+1') && sql.includes('bumped=1') && sql.includes('team_request_id()');
    if (!valid) { db.close(); throw new Error(`团片 schema 10 trigger 语义无效：${trigger.name}`); }
  }
  schemaReadyPaths.set(databasePath, schemaSignature());
  return db;
};
const fileSha256 = filePath => new Promise((resolve, reject) => {
  const digest = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  input.on('error', reject);
  input.on('data', chunk => digest.update(chunk));
  input.on('end', () => resolve(digest.digest('hex')));
});
const capabilityError = frame => Object.assign(new Error(String(frame.error || 'Host capability failed')), {
  code: String(frame.errorCode || 'COMPONENT_HOST_INTERNAL'),
  retryable: frame.retryable === true,
});
const strictRowMembers = row => {
  const members = parseJson(row.members_json, []);
  if (!Array.isArray(members) || !members.length || members.some(member => !Number.isInteger(Number(member?.personIndex)) || Number(member.personIndex) < 1)) throw new Error(`团片当前任务成员格式无效：${row.id}`);
  return members;
};
const serializeTask = row => {
  const generation = parseJson(row.generation_json, {});
  const members = strictRowMembers(row);
  if (Number(generation.version) !== 2) throw new Error(`团片当前任务 generation 格式无效：${row.id}`);
  return ({
  id: row.id, photoId: row.photo_id, baseVersionId: row.base_version_id,
  personIndex: row.person_index, personName: row.person_name, assignee: row.assignee,
  detector: row.detector, bbox: parseJson(row.bbox_json, {}), crop: parseJson(row.crop_json, {}),
  patchPath: row.patch_path, maskPath: row.mask_path, mask: parseJson(row.mask_json, {}),
  members, needsReview: Boolean(row.needs_review),
  reviewReason: row.review_reason, editedPatchPath: row.edited_patch_path, status: row.status,
  mergeMetrics: parseJson(row.merge_metrics_json, {}), mergedVersionId: row.merged_version_id,
  generation, requiresManualCrop: Boolean(generation.requiresManualCrop), fullFrame: Boolean(generation.fullFrame), sourceCoverage: generation.sourceCoverage,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
};

const withPhotoOperation = (key, worker, signal = revisionRequestContext.getStore()?.signal) => {
  const normalized = String(key || 'global');
  const previous = photoOperations.get(normalized) || Promise.resolve();
  assertNotAborted(signal);
  const current = previous.catch(() => undefined).then(() => { assertNotAborted(signal); return worker(); });
  photoOperations.set(normalized, current);
  return current.finally(() => { if (photoOperations.get(normalized) === current) photoOperations.delete(normalized); });
};
const withKeyedOperation = (operations, key, worker, signal = revisionRequestContext.getStore()?.signal) => {
  const normalized = String(key || 'global');
  const previous = operations.get(normalized) || Promise.resolve();
  assertNotAborted(signal);
  const current = previous.catch(() => undefined).then(() => { assertNotAborted(signal); return worker(); });
  operations.set(normalized, current);
  return current.finally(() => { if (operations.get(normalized) === current) operations.delete(normalized); });
};
const projectOperationKey = (context, value) => `${String(context?.projectId || '')}\0${String(value || '')}`;
const withReviewSessionOperation = (key, worker) => withKeyedOperation(reviewSessionOperations, key, worker);
const withProjectWorkflowOperation = (key, worker) => withKeyedOperation(projectWorkflowOperations, key, worker);
const withPhotoOperations = (keys, worker) => [...new Set(keys.map(String))].sort().reduceRight(
  (next, key) => () => withPhotoOperation(key, next), worker,
)();

const createArtifact = (db, row, personIndex, artifactPath, kind = 'returned', metadata = {}) => {
  const projectId = String(row.project_id || activeProjectId());
  const stage = db.prepare('SELECT * FROM team_task_stages WHERE project_id=? AND task_id=? AND person_index=?').get(projectId, row.id, Number(personIndex));
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO team_task_artifacts(project_id,id,task_id,stage_id,person_index,kind,artifact_path,digest,metadata_json,created_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,0)`)
    .run(projectId, id, row.id, stage?.id || null, Number(personIndex), kind, artifactPath, '', JSON.stringify(metadata), Date.now());
  return { id, stageId: stage?.id || null };
};

const currentTaskArtifact = (db, taskId, projectId = activeProjectId()) => db.prepare(`SELECT * FROM team_task_artifacts WHERE project_id=? AND task_id=? AND is_deleted=0 ORDER BY created_at DESC,id DESC LIMIT 1`).get(String(projectId), String(taskId || ''));

const publicTask = task => {
  const { patchPath, maskPath, editedPatchPath, uploadPath, returnedPath, previewUrl, patchUrl, ...value } = task || {};
  return value;
};
const publicBundle = bundle => ({
  success: bundle?.success !== false,
  photo: bundle?.photo ? Object.fromEntries(Object.entries(bundle.photo).filter(([key]) => !['originalFilePath', 'previewUrl'].includes(key))) : bundle?.photo,
  versions: (bundle?.versions || []).map(version => Object.fromEntries(Object.entries(version).filter(([key]) => !['filePath', 'previewUrl'].includes(key)))),
});

const appendCommand = async (storage, operation) => {
  const directory = path.join(storage.dataRoot, 'command-log');
  const line = `${JSON.stringify({ at: Date.now(), ...operation })}\n`;
  if (!revisionRequestContext.getStore()?.requestId) {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.appendFile(path.join(directory, 'operations.ndjson'), line, 'utf8');
    return;
  }
  withPersistentFileFence(() => {
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, 'operations.ndjson'), line, 'utf8');
  });
};
const waitForReadableDrain = stream => new Promise(resolve => {
  let drained = false;
  const finishDrain = () => { if (!drained) { drained = true; resolve(); } };
  stream.once('end', finishDrain);
  stream.once('close', finishDrain);
  stream.once('error', finishDrain);
});
const terminateProcessTree = child => {
  if (!child?.pid) return Promise.resolve(true);
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => { try { child.kill(); } catch { /* process already exited */ } resolve(false); });
      killer.once('exit', code => { if (code !== 0) { try { child.kill(); } catch { /* process already exited */ } } resolve(code === 0); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { return Promise.resolve(true); }
    return new Promise(resolve => {
      const started = Date.now(); const poll = () => {
        try { process.kill(-child.pid, 0); }
        catch { resolve(true); return; }
        if (Date.now() - started >= 2000) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } resolve(false); return; }
        setTimeout(poll, 25);
      }; poll();
    });
  }
};

const runAlgorithm = (parentId, args, { timeoutMs = 60 * 60 * 1000, topic = '', progress = {}, signal = null, onProgress = () => undefined } = {}) => new Promise((resolve, reject) => {
  let runtime;
  try { runtime = resolveAlgorithmRuntime(); } catch (error) { reject(error); return; }
  const child = spawn(runtime.command, [...runtime.argsPrefix, ...args.map(value => String(value))], {
    cwd: __dirname, env: Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'PHOTOFLOW_TEST_GRANDCHILD_PID'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  });
  let stderr = '';
  let result;
  let progressReports = Promise.resolve();
  let cancelled = false;
  let timedOut = false;
  let terminationPromise = null;
  let settled = false;
  const stdoutComplete = waitForReadableDrain(child.stdout);
  activeAlgorithms.add(child);
  const controls = algorithmControlsByParent.get(String(parentId)) || new Set();
  const control = { cancel: () => { cancelled = true; terminationPromise ||= terminateProcessTree(child); } };
  controls.add(control); algorithmControlsByParent.set(String(parentId), controls);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  // Keep the process registered as active until the entire spawned tree has
  // actually exited and stdout has closed. Restore and later mutations remain
  // blocked if termination cannot be confirmed.
  const timer = setTimeout(() => { timedOut = true; terminationPromise ||= terminateProcessTree(child); }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timer); signal?.removeEventListener('abort', control.cancel); lines.close();
    activeAlgorithms.delete(child); controls.delete(control);
    if (!controls.size) algorithmControlsByParent.delete(String(parentId));
  };
  const finish = (callback, value) => { if (settled) return; settled = true; cleanup(); callback(value); };
  timer.unref?.();
  if (signal?.aborted) control.cancel(); else signal?.addEventListener('abort', control.cancel, { once: true });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8000); });
  lines.on('line', line => {
    if (Buffer.byteLength(line, 'utf8') > 1024 * 1024) { timedOut = true; terminationPromise ||= terminateProcessTree(child); return; }
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.type === 'progress') {
      try { onProgress(message); } catch { /* Progress observers cannot fail the algorithm. */ }
      if (topic) progressReports = progressReports.catch(() => undefined).then(() => emitProgress(parentId, topic, { ...progress, ...message })).catch(() => undefined);
    }
    else if (message?.type === 'result') result = message.result;
    else if (message && typeof message === 'object') result = message;
  });
  child.once('error', error => { finish(reject, error); });
  child.once('exit', async code => {
    await stdoutComplete;
    await progressReports;
    if (terminationPromise && !await terminationPromise) {
      unconfirmedAlgorithmTrees.add(`${child.pid}:${Date.now()}`);
      finish(reject, Object.assign(new Error('无法确认算法进程树已退出；为保护恢复与后续写入，必须重启组件服务'), { code: 'COMPONENT_RESTART_REQUIRED', retryable: false })); return;
    }
    if (timedOut) finish(reject, Object.assign(new Error('团片组件算法运行超时，进程树已退出'), { code: 'COMPONENT_ALGORITHM_TIMEOUT', retryable: true }));
    else if (cancelled) finish(reject, Object.assign(new Error('团片组件算法已取消'), { code: CANCELLED_CODE }));
    else if (code !== 0) finish(reject, new Error(stderr.trim() || `团片组件算法退出（${code}）`));
    else if (!result) finish(reject, new Error('团片组件算法没有返回结果'));
    else finish(resolve, result);
  });
});
const advancedRuntimeFailureStatus = (error, { development = Boolean(hostAlgorithmRuntime) } = {}) => {
  const detail = String(error?.message || error || '');
  const runtimeSource = development ? 'development' : 'packaged';
  if (/timed out after|TimeoutExpired|WSL[^\n]*超时|启动[^\n]*超时/i.test(detail)) return {
    success: true, advancedAvailable: false, state: 'unavailable', errorCategory: 'wsl-start-timeout', runtimeSource,
    pairDetrReady: false, sam2Ready: false,
    advancedError: '增强人物检测启动超时',
    message: 'WSL 启动时间超过本次检查限制；请稍候后重新检查',
  };
  if (/E_ACCESSDENIED|拒绝访问|access (?:is )?denied|permission denied/i.test(detail)) return {
    success: true, advancedAvailable: false, state: 'unavailable', errorCategory: 'wsl-access-denied', runtimeSource,
    pairDetrReady: false, sam2Ready: false,
    advancedError: development ? '开发运行进程无权访问 WSL' : '照片流当前无权访问 WSL',
    message: development ? '请从具有 WSL 权限的普通终端启动开发应用；安装或修复模型不能解决此权限问题' : '请使用安装高级环境时的 Windows 用户运行照片流，并确认该用户可以启动 WSL',
  };
  const notInstalled = /运行时不存在|not found|ENOENT|WSL_E_DISTRO_NOT_FOUND|没有可用的团片协作 WSL 发行版/i.test(detail);
  return {
    success: true, advancedAvailable: false, state: notInstalled ? 'not-installed' : 'repair-needed', errorCategory: notInstalled ? 'not-installed' : 'runtime-incomplete', runtimeSource,
    pairDetrReady: false, sam2Ready: false,
    advancedError: notInstalled ? '增强人物检测尚未安装' : '增强人物检测运行时需要检查或修复',
    message: notInstalled ? '当前使用基础人物检测；可在设置中安装增强版' : '当前使用基础人物检测；可在设置中检查或修复增强版',
  };
};
const performAdvancedRuntimeStatus = async (parentId, { full = false } = {}) => {
  const now = Date.now();
  try {
    // Page-open status is intentionally a lightweight WSL/file probe. A full
    // CUDA/model load belongs to install verification and real detection, not
    // to rendering a settings page.
    const action = full ? 'probe-advanced-runtime' : 'probe-advanced-installation';
    const configuredTimeout = Number(process.env.PHOTOFLOW_TEST_ALGORITHM_TIMEOUT_MS) || (full ? 2 * 60 * 1000 : 30 * 1000);
    const probe = await runAlgorithm(parentId, [action], { timeoutMs: Math.max(50, configuredTimeout) });
    const advancedAvailable = full ? probe?.pairDetrReady === true && probe?.sam2Ready === true : probe?.advancedAvailable === true;
    if (!advancedAvailable && probe?.advancedError) {
      const value = advancedRuntimeFailureStatus(probe.advancedError);
      advancedRuntimeProbeCache = { expiresAt: now + 60_000, value }; return value;
    }
    const value = { success: true, advancedAvailable, installed: advancedAvailable, state: advancedAvailable ? 'ready' : 'repair-needed', errorCategory: advancedAvailable ? '' : 'runtime-incomplete', runtimeSource: hostAlgorithmRuntime ? 'development' : 'packaged', verification: full ? 'runtime' : 'installation', pairDetrReady: probe?.pairDetrReady === true, sam2Ready: probe?.sam2Ready === true, message: advancedAvailable ? '增强人物检测运行时已就绪' : '增强人物检测未完全就绪；基础人物检测仍可正常使用' };
    advancedRuntimeProbeCache = { expiresAt: now + (advancedAvailable ? 5 * 60_000 : 10_000), value }; return value;
  } catch (error) {
    const value = advancedRuntimeFailureStatus(error);
    advancedRuntimeProbeCache = { expiresAt: now + 60_000, value }; return value;
  }
};
const advancedRuntimeStatus = async (parentId, { refresh = false, full = false } = {}) => {
  const now = Date.now();
  if (!refresh && advancedRuntimeProbeCache?.expiresAt > now) return advancedRuntimeProbeCache.value;
  const key = full ? 'full' : 'installation';
  if (!refresh && advancedRuntimeProbePending.has(key)) return advancedRuntimeProbePending.get(key);
  const pending = performAdvancedRuntimeStatus(parentId, { full });
  if (!refresh) advancedRuntimeProbePending.set(key, pending);
  try { return await pending; }
  finally { if (advancedRuntimeProbePending.get(key) === pending) advancedRuntimeProbePending.delete(key); }
};

const taskRows = (db, photoId, baseVersionId, projectId = activeProjectId()) => db.prepare(`SELECT * FROM team_patch_tasks WHERE project_id=? AND photo_id=? AND (?='' OR base_version_id=?) AND is_deleted=0 ORDER BY created_at,person_index`).all(String(projectId), String(photoId), String(baseVersionId || ''), String(baseVersionId || ''));
const listTasks = (db, photoId, baseVersionId = '') => taskRows(db, photoId, baseVersionId).map(serializeTask);
const registerPhoto = (db, context, photoId, baseVersionId, metadata = {}) => db.prepare(`INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,display_name,relative_path,relative_path_state,file_missing,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,photo_id) DO UPDATE SET
  project_id=excluded.project_id,base_version_id=excluded.base_version_id,
  display_name=CASE WHEN excluded.display_name<>'' THEN excluded.display_name ELSE team_retouch_photos.display_name END,
  relative_path=CASE WHEN excluded.relative_path<>'' THEN excluded.relative_path ELSE team_retouch_photos.relative_path END,
  relative_path_state=CASE WHEN excluded.relative_path<>'' THEN excluded.relative_path_state ELSE team_retouch_photos.relative_path_state END,
  file_missing=CASE WHEN excluded.relative_path<>'' THEN excluded.file_missing ELSE team_retouch_photos.file_missing END,
  updated_at=excluded.updated_at`)
  .run(String(photoId), String(context.projectId), String(baseVersionId), String(metadata.displayName || ''), String(metadata.relativePath || ''), String(metadata.relativePathState || (metadata.relativePath ? 'ready' : 'unresolvable')), metadata.fileMissing ? 1 : 0, Date.now(), Date.now());

const replacePatches = (db, context, photoId, baseVersionId, tasks) => {
  const old = listTasks(db, photoId, baseVersionId);
  db.prepare('UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND is_deleted=0').run(Date.now(), String(context.projectId), String(photoId), String(baseVersionId));
  db.prepare('DELETE FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=?').run(String(context.projectId), String(photoId), String(baseVersionId));
  const insert = db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,assignee,detector,bbox_json,crop_json,patch_path,mask_path,mask_json,members_json,needs_review,review_reason,edited_patch_path,status,merge_metrics_json,merged_version_id,generation_json,created_at,updated_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
  const insertStage = db.prepare(`INSERT OR IGNORE INTO team_task_stages(project_id,id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  for (const task of tasks || []) {
    if (!Array.isArray(task.members) || !task.members.length) throw new Error('人物检测结果缺少当前 members 契约');
    if (Number(task.generation?.version) !== 2) throw new Error('人物检测结果缺少当前 generation v2 契约');
    const taskId = String(task.id || crypto.randomUUID());
    insert.run(String(context.projectId), taskId, String(photoId), String(baseVersionId), Number(task.personIndex || 0), String(task.personName || `人物 ${Number(task.personIndex || 0) + 1}`), String(task.assignee || ''), String(task.detector || ''), JSON.stringify(task.bbox || {}), JSON.stringify(task.crop || {}), String(task.patchPath || ''), task.maskPath ? String(task.maskPath) : null, JSON.stringify(task.mask || {}), JSON.stringify(task.members), task.needsReview ? 1 : 0, String(task.reviewReason || ''), task.editedPatchPath ? String(task.editedPatchPath) : null, String(task.status || 'exported'), JSON.stringify(task.mergeMetrics || {}), task.mergedVersionId ? String(task.mergedVersionId) : null, JSON.stringify(task.generation), now, now);
    for (const [order, member] of task.members.entries()) insertStage.run(String(context.projectId), crypto.randomUUID(), taskId, Number(member.personIndex), order + 1, 'pending', now, now);
  }
  if ((tasks || []).length) registerPhoto(db, context, photoId, baseVersionId);
  else db.prepare('DELETE FROM team_retouch_photos WHERE photo_id=? AND project_id=?').run(String(photoId), String(context.projectId));
  return { old, tasks: listTasks(db, photoId, baseVersionId) };
};
const restoreWorkingTaskDomain = (db, context, plan, materializedPath) => {
  const task = plan?.task;
  if (!task?.id || !Array.isArray(task.members) || !task.members.length || Number(task.generation?.version) !== 2) throw recoveryRequiredError('working continuation task 不完整');
  if (task.maskPath && !fs.existsSync(task.maskPath)) throw recoveryRequiredError(`working task ${task.id} mask 缺失`);
  const ids = uniqueText(plan.allTaskIds); if (!ids.includes(String(task.id))) throw recoveryRequiredError(`working task ${task.id} 不在 generation 集合`);
  if (ids.length) db.prepare(`UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND id NOT IN (${ids.map(() => '?').join(',')})`).run(Date.now(), String(context.projectId), String(plan.photoId), String(plan.baseVersionId), ...ids);
  db.prepare(`INSERT INTO team_patch_tasks(project_id,id,photo_id,base_version_id,person_index,person_name,assignee,detector,bbox_json,crop_json,patch_path,mask_path,mask_json,members_json,needs_review,review_reason,edited_patch_path,status,merge_metrics_json,merged_version_id,generation_json,created_at,updated_at,is_deleted)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(project_id,id) DO UPDATE SET photo_id=excluded.photo_id,base_version_id=excluded.base_version_id,person_index=excluded.person_index,person_name=excluded.person_name,assignee=excluded.assignee,detector=excluded.detector,bbox_json=excluded.bbox_json,crop_json=excluded.crop_json,patch_path=excluded.patch_path,mask_path=excluded.mask_path,mask_json=excluded.mask_json,members_json=excluded.members_json,needs_review=excluded.needs_review,review_reason=excluded.review_reason,generation_json=excluded.generation_json,updated_at=excluded.updated_at,is_deleted=0`)
    .run(String(context.projectId), String(task.id), String(plan.photoId), String(plan.baseVersionId), Number(task.personIndex || 0), String(task.personName || ''), String(task.assignee || ''), String(task.detector || ''), JSON.stringify(task.bbox || {}), JSON.stringify(task.crop || {}), String(materializedPath), task.maskPath || null, JSON.stringify(task.mask || {}), JSON.stringify(task.members), task.needsReview ? 1 : 0, String(task.reviewReason || ''), null, 'exported', '{}', null, JSON.stringify(task.generation), Date.now(), Date.now());
  const stage = db.prepare('INSERT OR IGNORE INTO team_task_stages(project_id,id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  for (const [index, member] of task.members.entries()) stage.run(String(context.projectId), crypto.randomUUID(), String(task.id), Number(member.personIndex), index + 1, 'pending', Date.now(), Date.now());
  registerPhoto(db, context, plan.photoId, plan.baseVersionId, plan.photo || {});
};

const queueCleanupArtifacts = (db, projectId, paths) => {
  const now = Date.now(); const insert = db.prepare(`INSERT INTO team_cleanup_outbox(project_id,id,artifact_path,state,attempt_count,last_error,created_at,updated_at) VALUES(?,?,?,'pending',0,'',?,?) ON CONFLICT(project_id,artifact_path) DO UPDATE SET state='pending',updated_at=excluded.updated_at`);
  for (const filePath of uniqueText(paths)) insert.run(String(projectId), crypto.randomUUID(), filePath, now, now);
};
const drainCleanupOutbox = async (databasePath, projectId, limit = 50) => {
  const db = ensureSchema(databasePath);
  try {
    const rows = db.prepare("SELECT * FROM team_cleanup_outbox WHERE project_id=? AND state='pending' ORDER BY updated_at LIMIT ?").all(String(projectId), Math.max(1, Number(limit) || 1));
    for (const row of rows) {
      try {
        if (revisionRequestContext.getStore()?.requestId) removePersistentPaths([row.artifact_path]);
        else await fs.promises.rm(row.artifact_path, { recursive: true, force: true });
        db.prepare('DELETE FROM team_cleanup_outbox WHERE project_id=? AND id=?').run(String(projectId), row.id);
      } catch (error) {
        db.prepare("UPDATE team_cleanup_outbox SET attempt_count=attempt_count+1,last_error=?,updated_at=? WHERE project_id=? AND id=?").run(String(error.message || error).slice(0, 500), Date.now(), String(projectId), row.id);
      }
    }
  } finally { db.close(); }
};
const removeArtifacts = async paths => {
  const requestId = String(revisionRequestContext.getStore()?.requestId || ''); const state = projectRevisionLeaseStates.get(requestId);
  if (state?.databasePath) {
    let db;
    try { db = ensureSchema(state.databasePath); queueCleanupArtifacts(db, state.projectId, paths); }
    catch { /* intent should already have been queued in the business transaction */ }
    finally { try { db?.close(); } catch { /* best effort */ } }
    await drainCleanupOutbox(state.databasePath, state.projectId).catch(() => undefined);
    return;
  }
  for (const filePath of uniqueText(paths)) await fs.promises.rm(filePath, { recursive: true, force: true }).catch(() => undefined);
};

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const listRelativeFiles = async root => {
  const files = []; const visit = async (directory, prefix = '') => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative); else if (entry.isFile()) files.push(relative.replace(/\\/g, '/'));
    }
  };
  if (fs.existsSync(root)) await visit(root); return files.sort();
};
const assertAuthorizedArtifacts = async (parentId, rows) => {
  const storage = await hostStorage(parentId);
  const projectRoot = path.join(storage.dataPath, 'projects', sha256(String(storage.projectId)));
  const materializedReceipts = new Set(); const receiptDb = ensureSchema(storage.databasePath);
  try {
    for (const row of receiptDb.prepare('SELECT result_json FROM team_output_outbox WHERE project_id=?').all(String(storage.projectId))) {
      const privatePath = parseJson(row.result_json, {})?.materialized?.privatePath;
      if (privatePath) materializedReceipts.add(path.resolve(String(privatePath)).toLowerCase());
    }
  } finally { receiptDb.close(); }
  for (const row of rows || []) {
    for (const filePath of [row.patch_path, row.mask_path, row.edited_patch_path].filter(Boolean)) {
      const exactHostMaterialization = materializedReceipts.has(path.resolve(filePath).toLowerCase());
      if (!isInside(projectRoot, filePath) && !exactHostMaterialization) throw new Error('团片文件超出当前项目授权 namespace');
    }
  }
};
const publishStagedFile = async (sourcePath, destinationPath, operationId) => {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const pendingPath = `${destinationPath}.${operationId}.pending`;
  await fs.promises.copyFile(sourcePath, pendingPath, fs.constants.COPYFILE_EXCL);
  try {
    return replacePersistentFromStage(pendingPath, destinationPath, operationId);
  } catch (error) {
    await fs.promises.rm(pendingPath, { force: true }).catch(() => undefined);
    throw error;
  }
};
const rollbackPublished = async published => {
  rollbackPersistentReplacements(published);
};
const commitPublished = async published => Promise.all(published.map(item => item.backupPath ? fs.promises.rm(item.backupPath, { recursive: true, force: true }).catch(() => undefined) : undefined));

const detectPhoto = async (parentId, payload, context) => {
  const described = await readMedia(parentId, { strict: true, mediaRefs: [{ photoId: payload.photoId, versionId: payload.baseVersionId }] });
  const metadataBase = described.items?.[0]?.versions?.find(version => String(version.id) === String(payload.baseVersionId));
  if (!metadataBase || metadataBase.fileMissing) throw new Error('基础版本文件不存在');
  const authorized = await artifactsScope(parentId, { photoId: payload.photoId, baseVersionId: payload.baseVersionId, deliveryPrefix: path.posix.parse(String(metadataBase.relativePath || '').replace(/\\/g, '/')).name });
  const settings = (await hostSettings(parentId)).settings || {};
  const storage = await hostStorage(parentId);
  const db = ensureSchema(storage.databasePath);
  let materialized;
  try { materialized = await materializeMediaForOperation(parentId, [{ photoId: payload.photoId, versionId: payload.baseVersionId }]); }
  catch (error) { db.close(); throw error; }
  const bundle = materialized.items?.[0]; const base = bundle?.versions?.[0];
  if (!base || !fs.existsSync(base.filePath)) { await materialized.cleanup(); db.close(); throw new Error('基础版本文件不存在'); }
  try { assertDecodableImage(base.filePath); } catch (error) { await materialized.cleanup(); db.close(); throw error; }
  const operationId = crypto.randomUUID();
  const stagingRoot = path.join(authorized.dataDirectory, '.staging', operationId);
  const stagingAnalysis = path.join(stagingRoot, 'analysis');
  const stagingDelivery = path.join(stagingRoot, 'delivery');
  const published = [];
  try {
    await assertAuthorizedArtifacts(parentId, taskRows(db, payload.photoId, payload.baseVersionId));
    await appendCommand(storage, { operationId, type: 'detect', state: 'prepared', photoId: payload.photoId, baseVersionId: payload.baseVersionId });
    const exclusions = payload.restoreExcluded ? [] : db.prepare('SELECT bbox_json FROM team_person_exclusions WHERE project_id=? AND photo_id=? AND base_version_id=?').all(String(context.projectId), String(payload.photoId), String(payload.baseVersionId)).map(row => parseJson(row.bbox_json, {}));
    await fs.promises.mkdir(stagingAnalysis, { recursive: true });
    await fs.promises.mkdir(stagingDelivery, { recursive: true });
    const detected = await runAlgorithm(parentId, ['detect', '--input', base.filePath, '--output-dir', stagingAnalysis, '--delivery-dir', stagingDelivery, '--delivery-prefix', authorized.deliveryPrefix, '--excluded-boxes', JSON.stringify(exclusions), '--provider', settings.useGpu === false ? 'cpu' : 'auto', '--oversize-crop-mode', settings.oversizeCropMode === 'expand' ? 'expand' : 'face-centered', '--advanced-mode', 'auto'], { topic: 'patch.detect.progress', progress: { projectId: String(context.projectId), projectName: context.projectName, photoId: payload.photoId, baseVersionId: payload.baseVersionId } });
    const missing = (detected.tasks || []).filter(task => !task.patchPath || !fs.existsSync(task.patchPath));
    if (missing.length) throw new Error(`切好的图片没有成功保存（缺少 ${missing.length} 个文件）`);
    const publishedTasks = [];
    const workingPublications = [];
    for (const task of detected.tasks || []) {
      let maskTarget = null;
      if (task.maskPath) { maskTarget = path.join(authorized.analysisDirectory, path.basename(task.maskPath)); published.push(await publishStagedFile(task.maskPath, maskTarget, operationId)); }
      const domainPlan = { version: 1, photoId: String(payload.photoId), baseVersionId: String(payload.baseVersionId), allTaskIds: (detected.tasks || []).map(item => String(item.id)), task: { ...task, maskPath: maskTarget }, photo: { displayName: bundle.photo?.displayName || bundle.photo?.originalName || '', relativePath: metadataBase.relativePath || '', relativePathState: metadataBase.relativePathState || 'ready', fileMissing: Boolean(metadataBase.fileMissing) } };
      const working = await publishWorkingImage(parentId, storage, task.patchPath, metadataBase.relativePath, domainPlan);
      workingPublications.push(working.publication);
      const patchTarget = working.privatePath;
      publishedTasks.push({ ...task, patchPath: patchTarget, maskPath: maskTarget });
    }
    db.exec('BEGIN IMMEDIATE');
    let replaced;
    try {
      replaced = replacePatches(db, context, payload.photoId, payload.baseVersionId, publishedTasks);
      registerPhoto(db, context, payload.photoId, payload.baseVersionId, { displayName: bundle.photo?.displayName || bundle.photo?.originalName, relativePath: metadataBase.relativePath, relativePathState: metadataBase.relativePathState, fileMissing: metadataBase.fileMissing });
      if (payload.restoreExcluded) db.prepare('DELETE FROM team_person_exclusions WHERE project_id=? AND photo_id=? AND base_version_id=?').run(String(context.projectId), String(payload.photoId), String(payload.baseVersionId));
      queueCleanupArtifacts(db, context.projectId, replaced.old.flatMap(task => [task.patchPath, task.maskPath, task.editedPatchPath]).filter(filePath => filePath && !publishedTasks.some(task => task.patchPath === filePath || task.maskPath === filePath)));
      queueCleanupArtifacts(db, context.projectId, published.map(item => item.backupPath));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await appendCommand(storage, { operationId, type: 'detect', state: 'committed' }).catch(() => undefined);
    for (const publication of workingPublications) await completeOutputPublication(publication);
    await commitPublished(published).catch(() => undefined);
    await removeArtifacts(replaced.old.flatMap(task => [task.patchPath, task.maskPath, task.editedPatchPath]).filter(filePath => filePath && !publishedTasks.some(task => task.patchPath === filePath || task.maskPath === filePath)));
    return { success: true, ...publicBundle(bundle), tasks: replaced.tasks.map(publicTask), excludedPersonCount: exclusions.length, detection: { detector: detected.detector, backend: detected.backend || 'cpu', provider: detected.provider || '', requestedMode: detected.requestedMode || 'auto', advancedBackend: Boolean(detected.advancedBackend), width: detected.width, height: detected.height, personCount: detected.personCount ?? replaced.tasks.length, workTileEdge: detected.workTileEdge || 4000, needsReviewCount: detected.needsReviewCount || 0, fallbackReason: detected.fallbackReason || '' } };
  } catch (error) {
    await rollbackPublished(published);
    await appendCommand(storage, { operationId, type: 'detect', state: 'rolled-back', error: error.message || String(error) }).catch(() => undefined);
    throw error;
  } finally { await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined); await materialized.cleanup(); db.close(); }
};

const getPatchBundle = async (parentId, payload, context) => {
  const media = await readMedia(parentId, { relativePaths: [String(payload.relativePath || '')] });
  const bundle = media.items?.[0];
  if (!bundle) throw new Error('团片图片不存在');
  return withDomain(parentId, db => {
    const tasks = listTasks(db, bundle.photo.id).map(task => ({ ...publicTask(task), patchMissing: !task.patchPath || !fs.existsSync(task.patchPath) }));
    const baseIds = uniqueText([bundle.photo.currentVersionId, ...(bundle.versions || []).map(item => item.id), ...tasks.map(item => item.baseVersionId)]);
    const excludedPersonCounts = Object.fromEntries(baseIds.map(id => [id, Number(db.prepare('SELECT COUNT(*) AS count FROM team_person_exclusions WHERE project_id=? AND photo_id=? AND base_version_id=?').get(String(context.projectId), String(bundle.photo.id), id)?.count || 0)]));
    return { ...publicBundle(bundle), tasks, excludedPersonCounts };
  });
};

const updatePatch = async (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE project_id=? AND id=? AND photo_id=? AND is_deleted=0').get(String(context.projectId), String(payload.taskId || ''), String(payload.photoId || ''));
  if (!row) throw new Error('人物工作图不存在');
  await assertAuthorizedArtifacts(parentId, [row]);
  let crop = payload.crop === undefined ? null : Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(Number(payload.crop?.[key]) || 0)]));
  if (crop && (crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1)) throw new Error('工作图范围无效');
  if (crop && row.edited_patch_path) throw new Error('已有返图的工作图不能调整范围，请先删除返图');
  const operationId = crypto.randomUUID();
  let backupPath = '';
  let stagedPath = '';
  try {
    if (crop) {
      const materialized = await materializeMediaForOperation(parentId, [{ photoId: row.photo_id, versionId: row.base_version_id }]);
      const media = materialized;
      const base = media.items?.[0]?.versions?.find(item => String(item.id) === String(row.base_version_id));
      if (!base || !fs.existsSync(base.filePath)) { await materialized.cleanup(); throw new Error('基础图片不存在，无法重新裁图'); }
      const authorized = await artifactsScope(parentId, { photoId: row.photo_id, baseVersionId: row.base_version_id });
      await fs.promises.mkdir(authorized.dataDirectory, { recursive: true });
      const manifestPath = path.join(authorized.dataDirectory, `recrop-${operationId}.json`);
      stagedPath = path.join(authorized.dataDirectory, `recrop-${operationId}.png`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ tasks: [{ ...serializeTask(row), crop, patchPath: stagedPath }] }), 'utf8');
      await appendCommand(storage, { operationId, type: 'recrop', state: 'prepared', taskId: row.id });
      try { await runAlgorithm(parentId, ['restore', '--input', base.filePath, '--manifest', manifestPath], { timeoutMs: 10 * 60 * 1000 }); }
      finally { await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined); await materialized.cleanup(); }
      if (!fs.existsSync(stagedPath)) throw new Error('重新裁切没有生成工作图');
      const publication = replacePersistentFromStage(stagedPath, row.patch_path, operationId);
      backupPath = publication.backupPath;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const generation = crop ? { ...parseJson(row.generation_json, {}), version: 2, strategy: 'manual', workWidth: crop.width, workHeight: crop.height, fileDigest: crypto.createHash('sha256').update(fs.readFileSync(row.patch_path)).digest('hex'), requiresManualCrop: false, reason: '人工调整工作图范围' } : null;
      db.prepare(`UPDATE team_patch_tasks SET person_name=COALESCE(?,person_name),assignee=COALESCE(?,assignee),crop_json=COALESCE(?,crop_json),generation_json=COALESCE(?,generation_json),needs_review=COALESCE(?,needs_review),review_reason=COALESCE(?,review_reason),updated_at=? WHERE project_id=? AND id=? AND is_deleted=0`).run(payload.personName === undefined ? null : String(payload.personName).trim().slice(0, 80) || '未命名人物', payload.assignee === undefined ? null : String(payload.assignee).trim().slice(0, 80), crop ? JSON.stringify(crop) : null, generation ? JSON.stringify(generation) : null, payload.needsReview === undefined ? null : payload.needsReview ? 1 : 0, payload.reviewReason === undefined ? null : String(payload.reviewReason).trim().slice(0, 300), Date.now(), String(context.projectId), row.id);
      if (backupPath) queueCleanupArtifacts(db, context.projectId, [backupPath]);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (backupPath) await fs.promises.rm(backupPath, { force: true }).catch(() => undefined);
    await appendCommand(storage, { operationId, type: crop ? 'recrop' : 'patch-update', state: 'committed', taskId: row.id }).catch(() => undefined);
    return { success: true, tasks: listTasks(db, row.photo_id).map(publicTask) };
  } catch (error) {
    if (backupPath && fs.existsSync(backupPath)) rollbackPersistentReplacements([{ destinationPath: row.patch_path, backupPath }]);
    if (stagedPath) await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined);
    await appendCommand(storage, { operationId, type: crop ? 'recrop' : 'patch-update', state: 'rolled-back', taskId: row.id, error: error.message || String(error) }).catch(() => undefined);
    throw error;
  }
});

const deletePatch = (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE project_id=? AND id=? AND photo_id=? AND is_deleted=0').get(String(context.projectId), String(payload.taskId || ''), String(payload.photoId || ''));
  if (!row) throw new Error('人物工作图不存在');
  await assertAuthorizedArtifacts(parentId, [row]);
  const operationId = crypto.randomUUID();
  await appendCommand(storage, { operationId, type: 'patch-delete', state: 'prepared', taskId: row.id });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE project_id=? AND id=?').run(Date.now(), String(context.projectId), row.id);
    db.prepare('DELETE FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index IN (SELECT CAST(value AS INTEGER) FROM json_each(?))').run(String(context.projectId), row.photo_id, row.base_version_id, JSON.stringify(strictRowMembers(row).map(item => item.personIndex)));
    db.prepare('DELETE FROM team_workflow_reconcile_pending WHERE project_id=? AND task_id=?').run(String(context.projectId), row.id);
    queueCleanupArtifacts(db, context.projectId, [row.patch_path, row.mask_path, row.edited_patch_path]);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); await appendCommand(storage, { operationId, type: 'patch-delete', state: 'rolled-back', error: error.message || String(error) }); throw error; }
  await appendCommand(storage, { operationId, type: 'patch-delete', state: 'committed' }).catch(() => undefined);
  await removeArtifacts([row.patch_path, row.mask_path, row.edited_patch_path]);
  return { success: true, tasks: listTasks(db, row.photo_id).map(publicTask), cleanupQueued: true };
});

const cleanupPatches = (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const rows = taskRows(db, payload.photoId, payload.baseVersionId);
  await assertAuthorizedArtifacts(parentId, rows);
  const operationId = crypto.randomUUID();
  await appendCommand(storage, { operationId, type: 'patch-cleanup', state: 'prepared', photoId: payload.photoId, baseVersionId: payload.baseVersionId });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND is_deleted=0').run(Date.now(), String(context.projectId), String(payload.photoId), String(payload.baseVersionId));
    db.prepare('DELETE FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=?').run(String(context.projectId), String(payload.photoId), String(payload.baseVersionId));
    db.prepare('DELETE FROM team_workflow_reconcile_pending WHERE project_id=? AND task_id IN (SELECT id FROM team_patch_tasks WHERE project_id=? AND photo_id=? AND base_version_id=?)').run(String(context.projectId), String(context.projectId), String(payload.photoId), String(payload.baseVersionId));
    queueCleanupArtifacts(db, context.projectId, rows.flatMap(row => [row.patch_path, row.mask_path, row.edited_patch_path]));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); await appendCommand(storage, { operationId, type: 'patch-cleanup', state: 'rolled-back', error: error.message || String(error) }); throw error; }
  await appendCommand(storage, { operationId, type: 'patch-cleanup', state: 'committed' }).catch(() => undefined);
  await removeArtifacts(rows.flatMap(row => [row.patch_path, row.mask_path, row.edited_patch_path]));
  return { success: true, tasks: listTasks(db, payload.photoId).map(publicTask), cleanupQueued: true };
});

const removeProjectPhoto = (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const rows = taskRows(db, payload.photoId, '');
  await assertAuthorizedArtifacts(parentId, rows);
  const operationId = crypto.randomUUID();
  await appendCommand(storage, { operationId, type: 'project-remove-photo', state: 'prepared', photoId: payload.photoId });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE project_id=? AND photo_id=? AND is_deleted=0').run(Date.now(), String(context.projectId), String(payload.photoId));
    db.prepare('DELETE FROM team_retouch_photos WHERE project_id=? AND photo_id=?').run(String(context.projectId), String(payload.photoId));
    db.prepare('DELETE FROM team_person_assignments WHERE project_id=? AND photo_id=?').run(String(context.projectId), String(payload.photoId));
    db.prepare('DELETE FROM team_person_exclusions WHERE project_id=? AND photo_id=?').run(String(context.projectId), String(payload.photoId));
    db.prepare('DELETE FROM team_workflow_reconcile_pending WHERE project_id=? AND photo_id=?').run(String(context.projectId), String(payload.photoId));
    db.prepare('DELETE FROM team_workflow_review_confirmations WHERE project_id=? AND photo_id=?').run(String(context.projectId), String(payload.photoId));
    queueCleanupArtifacts(db, context.projectId, rows.flatMap(row => [row.patch_path, row.mask_path, row.edited_patch_path]));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); await appendCommand(storage, { operationId, type: 'project-remove-photo', state: 'rolled-back', error: error.message || String(error) }); throw error; }
  await appendCommand(storage, { operationId, type: 'project-remove-photo', state: 'committed' }).catch(() => undefined);
  await removeArtifacts(rows.flatMap(row => [row.patch_path, row.mask_path, row.edited_patch_path]));
  return { success: true, cleanupQueued: true };
});

const uploadPatch = (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE project_id=? AND id=? AND photo_id=? AND is_deleted=0').get(String(context.projectId), String(payload.taskId || ''), String(payload.photoId || ''));
  if (!row) throw new Error('人物修图任务不存在');
  const members = strictRowMembers(row);
  const personIndex = Number(payload.personIndex);
  if (!Number.isInteger(personIndex) || !members.some(member => Number(member.personIndex) === personIndex)) throw new Error('人物不属于这个修图任务');
  const existingAssignment = db.prepare('SELECT identity_id FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(String(context.projectId), row.photo_id, row.base_version_id, personIndex);
  const choice = await selectInputFiles(parentId, { title: `上传 ${row.person_name} 的修图结果`, multiple: false });
  if (choice.cancelled || !choice.inputs?.length) return { success: true, cancelled: true, tasks: listTasks(db, row.photo_id).map(publicTask) };
  const materialized = await materializeInput(parentId, choice.inputs[0].token);
  const choicePath = materialized.privatePath;
  const authorized = await artifactsScope(parentId, { photoId: row.photo_id, baseVersionId: row.base_version_id });
  await fs.promises.mkdir(authorized.uploadDirectory, { recursive: true });
  const operationId = crypto.randomUUID();
  const stagedPath = path.join(authorized.uploadDirectory, `.${row.id}-${operationId}.staging${path.extname(choicePath).toLowerCase()}`);
  const outputPath = path.join(authorized.uploadDirectory, `${row.id}-${operationId}${path.extname(choicePath).toLowerCase()}`);
  await appendCommand(storage, { operationId, type: 'patch-upload', state: 'prepared', taskId: row.id });
  let committed = false;
  try {
    await fs.promises.copyFile(choicePath, stagedPath, fs.constants.COPYFILE_EXCL);
    replacePersistentFromStage(stagedPath, outputPath, operationId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const artifact = createArtifact(db, row, personIndex, outputPath, 'manual-upload');
      db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status='uploaded',updated_at=? WHERE project_id=? AND id=?`).run(outputPath, Date.now(), String(context.projectId), row.id);
      db.prepare(`${upsertAssignmentSql}`).run(String(context.projectId), row.photo_id, row.base_version_id, personIndex, existingAssignment?.identity_id || null, 1, 'manual', 1, Date.now());
      db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,artifact_id=?,edited_patch_path=?,completed=1,completion_kind='retouched',return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, artifact.stageId, artifact.id, outputPath, Date.now(), Date.now(), String(context.projectId), row.photo_id, row.base_version_id, personIndex);
      markWorkflowReconcilePending(db, { taskId: row.id, photoId: row.photo_id }, new Error('返图已上传，等待后台更新接力任务'));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    committed = true;
    await appendCommand(storage, { operationId, type: 'patch-upload', state: 'committed' }).catch(() => undefined);
    await appendCommand(storage, { operationId: crypto.randomUUID(), type: 'workflow-reconcile', state: 'pending-retry', taskId: row.id, photoId: row.photo_id, error: '返图已上传，等待后台更新接力任务' }).catch(() => undefined);
    return { success: true, tasks: listTasks(db, row.photo_id).map(publicTask), reconcilePending: true, relayState: 'preparing', warning: '返图已安全上传；下一位接力任务正在后台准备' };
  } catch (error) {
    if (!committed) {
      await removeArtifacts([stagedPath, outputPath]);
      await appendCommand(storage, { operationId, type: 'patch-upload', state: 'rolled-back', error: error.message || String(error) }).catch(() => undefined);
    } else await appendCommand(storage, { operationId, type: 'workflow-reconcile', state: 'pending-retry', taskId: row.id, error: error.message || String(error) }).catch(() => undefined);
    throw error;
  }
});

const removeUpload = (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE project_id=? AND id=? AND photo_id=? AND is_deleted=0').get(String(context.projectId), String(payload.taskId || ''), String(payload.photoId || ''));
  if (!row) throw new Error('人物修图任务不存在');
  const personIndex = Number(payload.personIndex);
  const assignment = db.prepare('SELECT * FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(String(context.projectId), row.photo_id, row.base_version_id, personIndex);
  if (assignment?.task_id && String(assignment.task_id) !== String(row.id)) throw new Error('返图阶段不属于这个修图任务');
  const removedArtifact = assignment?.artifact_id
    ? db.prepare('SELECT * FROM team_task_artifacts WHERE project_id=? AND id=? AND task_id=? AND is_deleted=0').get(String(context.projectId), assignment.artifact_id, row.id)
    : db.prepare('SELECT * FROM team_task_artifacts WHERE project_id=? AND task_id=? AND person_index=? AND is_deleted=0 ORDER BY created_at DESC,id DESC LIMIT 1').get(String(context.projectId), row.id, personIndex);
  const removedPath = removedArtifact?.artifact_path || assignment?.edited_patch_path || '';
  await assertAuthorizedArtifacts(parentId, [row]);
  const operationId = crypto.randomUUID();
  await appendCommand(storage, { operationId, type: 'patch-remove-upload', state: 'prepared', taskId: row.id, personIndex });
  db.exec('BEGIN IMMEDIATE');
  try {
    if (removedArtifact) db.prepare('UPDATE team_task_artifacts SET is_deleted=1 WHERE project_id=? AND id=? AND task_id=?').run(String(context.projectId), removedArtifact.id, row.id);
    db.prepare(`UPDATE team_person_assignments SET completed=0,completion_kind='',artifact_id=NULL,edited_patch_path=NULL,completed_at=NULL,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`).run(Date.now(), String(context.projectId), row.photo_id, row.base_version_id, personIndex);
    const predecessor = currentTaskArtifact(db, row.id)?.artifact_path || null;
    db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status=?,merged_version_id=NULL,merge_metrics_json='{}',updated_at=? WHERE project_id=? AND id=?`).run(predecessor, predecessor ? 'uploaded' : 'exported', Date.now(), String(context.projectId), row.id);
    markWorkflowReconcilePending(db, { taskId: row.id, photoId: row.photo_id }, new Error('返图已撤销，等待后台更新接力任务'));
    if (removedPath) queueCleanupArtifacts(db, context.projectId, [removedPath]);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); await appendCommand(storage, { operationId, type: 'patch-remove-upload', state: 'rolled-back', error: error.message || String(error) }); throw error; }
  await appendCommand(storage, { operationId, type: 'patch-remove-upload', state: 'committed' }).catch(() => undefined);
  await appendCommand(storage, { operationId: crypto.randomUUID(), type: 'workflow-reconcile', state: 'pending-retry', taskId: row.id, photoId: row.photo_id, error: '返图已撤销，等待后台更新接力任务' }).catch(() => undefined);
  if (removedPath) await removeArtifacts([removedPath]);
  return { success: true, tasks: listTasks(db, row.photo_id).map(publicTask), cleanupQueued: Boolean(removedPath), reconcilePending: true, relayState: 'preparing', warning: '返图撤销已保存；接力任务正在后台更新' };
});

const bboxIou = (left, right) => {
  const x1 = Math.max(Number(left?.x || 0), Number(right?.x || 0)); const y1 = Math.max(Number(left?.y || 0), Number(right?.y || 0));
  const x2 = Math.min(Number(left?.x || 0) + Number(left?.width || 0), Number(right?.x || 0) + Number(right?.width || 0));
  const y2 = Math.min(Number(left?.y || 0) + Number(left?.height || 0), Number(right?.y || 0) + Number(right?.height || 0));
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = Number(left?.width || 0) * Number(left?.height || 0) + Number(right?.width || 0) * Number(right?.height || 0) - overlap;
  return union > 0 ? overlap / union : 0;
};

const excludePerson = async (parentId, payload, context) => {
  const before = await workspaceSnapshot(parentId, context);
  const photo = before.photos.find(item => item.photoId === payload.photoId && item.baseVersionId === payload.baseVersionId);
  const subjects = (photo?.tasks || []).flatMap(task => task.members.map(member => ({ task, personIndex: Number(member.personIndex), bbox: member.bbox || task.bbox })));
  const selected = subjects.find(item => item.personIndex === Number(payload.personIndex));
  if (!selected) throw new Error('人物实例不存在，可能已经被移除');
  if ((photo.tasks || []).some(task => task.editedPatchPath || !['', 'exported'].includes(String(task.status || 'exported')))) throw new Error('这张图片已有返图或合成记录，不能重新计算工作图；请先清理对应返图');
  const oldAssignments = before.assignments.filter(item => item.photoId === payload.photoId && item.baseVersionId === payload.baseVersionId && item.personIndex !== Number(payload.personIndex));
  await withDomain(parentId, db => db.prepare('INSERT INTO team_person_exclusions(id,project_id,photo_id,base_version_id,bbox_json,reason,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), String(context.projectId), String(payload.photoId), String(payload.baseVersionId), JSON.stringify(selected.bbox || {}), 'false-positive', Date.now()));
  try {
    const detected = await detectPhoto(parentId, { photoId: payload.photoId, baseVersionId: payload.baseVersionId, restoreExcluded: false }, context);
    await withDomain(parentId, db => {
      const nextSubjects = listTasks(db, payload.photoId, payload.baseVersionId).flatMap(task => task.members.map(member => ({ personIndex: Number(member.personIndex), bbox: member.bbox || task.bbox })));
      const used = new Set();
      for (const assignment of oldAssignments) {
        const old = subjects.find(item => item.personIndex === Number(assignment.personIndex));
        const match = nextSubjects.filter(item => !used.has(item.personIndex)).map(item => ({ item, score: bboxIou(old?.bbox, item.bbox) })).filter(item => item.score >= .42).sort((a, b) => b.score - a.score)[0];
        if (!match) continue;
        used.add(match.item.personIndex);
        db.prepare(upsertAssignmentSql).run(String(context.projectId), String(payload.photoId), String(payload.baseVersionId), match.item.personIndex, assignment.identityId || null, Number(assignment.confidence || 0), String(assignment.source || 'manual'), assignment.completed ? 1 : 0, Date.now());
      }
    });
    return { ...detected, ...(await workspaceSnapshot(parentId, context)), removedPersonCount: 1 };
  } catch (error) {
    await withDomain(parentId, db => db.prepare('DELETE FROM team_person_exclusions WHERE project_id=? AND photo_id=? AND base_version_id=? AND bbox_json=?').run(String(context.projectId), String(payload.photoId), String(payload.baseVersionId), JSON.stringify(selected.bbox || {}))).catch(() => undefined);
    throw error;
  }
};

const mergePatches = async (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const materialized = await materializeMediaForOperation(parentId, [{ photoId: payload.photoId, versionId: payload.baseVersionId }]);
  try {
  const media = materialized;
  const bundle = media.items?.[0];
  const base = bundle?.versions?.find(item => String(item.id) === String(payload.baseVersionId));
  if (!base || !fs.existsSync(base.filePath)) throw new Error('基础版本文件不存在');
  const registeredPhoto = db.prepare('SELECT 1 ok FROM team_retouch_photos WHERE project_id=? AND photo_id=? AND base_version_id=?').get(String(context.projectId), String(payload.photoId), String(payload.baseVersionId));
  if (!registeredPhoto) throw new Error('当前项目没有这张照片版本的精确登记');
  const photoTasks = listTasks(db, payload.photoId, payload.baseVersionId);
  if (!photoTasks.length) throw new Error('这张照片没有可合成的当前任务');
  const assignments = db.prepare(`SELECT * FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=?`).all(String(context.projectId), String(payload.photoId), String(payload.baseVersionId));
  const assignmentByPerson = new Map(assignments.map(item => [Number(item.person_index), item]));
  const mergeTasks = [];
  for (const task of photoTasks) {
    const memberArtifacts = [];
    for (const [memberOrder, member] of task.members.entries()) {
      const personIndex = Number(member.personIndex); const assignment = assignmentByPerson.get(personIndex);
      if (!assignment?.completed || assignment.return_missing) throw new Error(`任务 ${task.id} 的人物 ${personIndex} 未完成或返图缺失`);
      const completionKind = String(assignment.completion_kind || '');
      if (completionKind === 'no-retouch') { memberArtifacts.push({ personIndex, memberOrder, completionKind, noRetouch: true }); continue; }
      if (!['returned','retouched'].includes(completionKind) || !assignment.artifact_id) throw new Error(`任务 ${task.id} 的人物 ${personIndex} 没有有效返图 artifact`);
      const artifact = db.prepare('SELECT * FROM team_task_artifacts WHERE project_id=? AND id=? AND task_id=? AND person_index=? AND is_deleted=0').get(String(context.projectId), String(assignment.artifact_id), String(task.id), personIndex);
      if (!artifact || String(assignment.task_id || '') !== String(task.id) || !artifact.artifact_path || !fs.existsSync(artifact.artifact_path)) throw new Error(`任务 ${task.id} 的人物 ${personIndex} artifact 已失效`);
      memberArtifacts.push({ personIndex, memberOrder, completionKind, artifactId: artifact.id, artifactPath: artifact.artifact_path });
    }
    const latestArtifact = memberArtifacts.filter(item => item.artifactPath).sort((left, right) => right.memberOrder - left.memberOrder)[0];
    if (latestArtifact) mergeTasks.push({ ...task, editedPatchPath: latestArtifact.artifactPath, memberArtifacts });
  }
  await assertAuthorizedArtifacts(parentId, taskRows(db, payload.photoId, payload.baseVersionId));
  const progress = await callHost(parentId, 'project.progress', { action: 'list' });
  const outputProgress = (progress.progress || []).find(item => String(item.id) === String(payload.outputProgressId));
  const relativeDirectory = String(outputProgress?.contentRef?.relativeDirectory || '');
  if (!outputProgress || outputProgress.mediaKind !== 'image' || !relativeDirectory) throw new Error('合成结果的目标图片进度不存在或不在项目内容边界内');
  const output = await artifactGrantForHost(parentId, { operation: 'artifacts', photoId: payload.photoId, baseVersionId: payload.baseVersionId });
  await fs.promises.mkdir(output.mergeDirectory, { recursive: true });
  const orderedTasks = [...mergeTasks].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const fingerprintTasks = new Array(orderedTasks.length); let fingerprintCursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, orderedTasks.length) }, async () => {
    while (fingerprintCursor < orderedTasks.length) {
      const index = fingerprintCursor++; const task = orderedTasks[index];
      fingerprintTasks[index] = {
        id: String(task.id),
        memberArtifacts: await Promise.all(task.memberArtifacts.map(async item => ({ personIndex: item.personIndex, completionKind: item.completionKind, artifactId: item.artifactId || '', digest: item.artifactPath ? await fileSha256(item.artifactPath) : '' }))),
        editedSha256: await fileSha256(task.editedPatchPath),
        maskSha256: task.maskPath && fs.existsSync(task.maskPath) ? await fileSha256(task.maskPath) : '',
        crop: task.crop || {}, generation: task.generation || {},
      };
    }
  }));
  const rebuildToken = String(payload.rebuildToken || '').trim().slice(0, 120);
  const mergeFingerprintInput = { projectId: String(context.projectId), photoId: String(payload.photoId), baseVersionId: String(payload.baseVersionId), outputProgressId: String(payload.outputProgressId), strategyVersion: 3, tasks: fingerprintTasks };
  if (rebuildToken) mergeFingerprintInput.rebuildToken = rebuildToken;
  const mergeFingerprint = sha256(JSON.stringify(mergeFingerprintInput));
  const operationId = `merge-${mergeFingerprint.slice(0, 32)}`;
  const mergeStage = path.join(output.mergeDirectory, '.staging', `${operationId}-${crypto.randomUUID()}`);
  const manifestPath = path.join(mergeStage, 'manifest.json');
  const outputName = `${safeSegment(path.parse(bundle.photo?.originalName || bundle.photo?.displayName || payload.photoId).name, '素材')}_多人修图_${mergeFingerprint.slice(0, 12)}.tif`;
  const privateOutputPath = path.join(mergeStage, outputName);
  const outputRelativePath = [relativeDirectory, outputName].filter(Boolean).join('/');
  await appendCommand(storage, { operationId, type: 'patch-merge', state: 'prepared', photoId: payload.photoId, outputRelativePath });
  try {
    await fs.promises.mkdir(path.dirname(mergeStage), { recursive: true });
    await fs.promises.mkdir(mergeStage, { recursive: false });
    await fs.promises.writeFile(manifestPath, JSON.stringify({ photoId: payload.photoId, baseVersionId: base.id, tasks: mergeTasks }), 'utf8');
    const merged = mergeTasks.length
      ? await runAlgorithm(parentId, ['merge', '--input', base.filePath, '--manifest', manifestPath, '--output', privateOutputPath], { signal: context.signal })
      : (await fs.promises.copyFile(base.filePath, privateOutputPath), { mergedCount: 0, conflictPixels: 0, seamScore: 1, metrics: [], noRetouch: true });
    if (!fs.existsSync(privateOutputPath)) throw new Error('合成算法没有生成输出文件');
    const threshold = Math.max(500, Number(merged.width || 0) * Number(merged.height || 0) * .00005);
    const needsReview = Boolean(merged.needsReview) || Number(merged.conflictPixels || 0) > threshold;
    const versionPayloadTemplate = { photoId: payload.photoId, parentVersionId: base.id, idempotencyKey: `merge-version-${mergeFingerprint.slice(0, 40)}`, name: String(payload.versionName || '').trim().slice(0, 80) || '团片协作合成', type: 'team-retouch', note: merged.noRetouch ? '所有人物均确认无需修图；已将原图作为零修改输出登记' : `由 ${merged.mergedCount} 张人物工作图自动合回原尺寸；重叠冲突像素 ${merged.conflictPixels}（复核阈值 ${Math.round(threshold)}）；边界评分 ${Number(merged.seamScore || 0).toFixed(2)}`, status: needsReview ? 'needs-review' : 'draft', isFinal: false };
    const continuationPlan = { version: 1, kind: 'merge-output', projectId: String(context.projectId), preHostLocalEffects: 'none', outputProgressId: String(outputProgress.id), outputRelativePath, versionPayloadTemplate, domain: { photoId: String(payload.photoId), baseVersionId: String(payload.baseVersionId), tasks: photoTasks.map(task => ({ id: String(task.id), members: task.members.map(member => Number(member.personIndex)), completion: fingerprintTasks.find(item => item.id === String(task.id))?.memberArtifacts || [] })), finalStatus: 'merged', mergeMetrics: merged.metrics || [] } };
    const committed = await publishProjectFile(parentId, privateOutputPath, outputRelativePath, `merge-${mergeFingerprint.slice(0, 40)}`, null, 'merge-output', continuationPlan);
    const artifact = committed.outputs[0];
    const registered = await createVersionFromOutput(parentId, committed, { ...versionPayloadTemplate, commitId: committed.commitId, artifactId: artifact.artifactId });
    const versionId = registered.versionId;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const task of photoTasks) db.prepare(`UPDATE team_patch_tasks SET status='merged',merged_version_id=?,merge_metrics_json=?,updated_at=? WHERE project_id=? AND id=?`).run(versionId, JSON.stringify(merged.metrics?.find(item => item.taskId === task.id) || {}), Date.now(), String(context.projectId), task.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await completeOutputPublication(committed);
    await appendCommand(storage, { operationId, type: 'patch-merge', state: 'committed', versionId }).catch(() => undefined);
    return { ...publicBundle(registered.result), tasks: listTasks(db, payload.photoId).map(publicTask), merge: { ...merged, outputPath: undefined, outputProgressId: outputProgress.id, versionId, needsReview } };
  } catch (error) {
    await fs.promises.rm(privateOutputPath, { force: true }).catch(() => undefined);
    await appendCommand(storage, { operationId, type: 'patch-merge', state: 'rolled-back', error: error.message || String(error) }).catch(() => undefined);
    throw error;
  } finally { await fs.promises.rm(mergeStage, { recursive: true, force: true }).catch(() => undefined); }
  } finally { await materialized.cleanup(); }
});
const detectBatch = async (parentId, payload, context) => {
  const relativePaths = uniqueText(payload.relativePaths);
  if (!relativePaths.length) throw new Error('请至少选择一张图片');
  if (relativePaths.length > MAX_ITEMS) throw new Error('批量检测图片过多');
  const materialized = await materializeMediaForOperation(parentId, relativePaths.map(relativePath => ({ relativePath })));
  const media = materialized;
  const prepared = (media.items || []).map((bundle, index) => ({
    bundle, relativePath: bundle.relativePath || relativePaths[index],
    base: bundle.versions?.find(item => String(item.id) === String(bundle.photo?.currentVersionId)) || bundle.versions?.find(item => item.isCurrent) || bundle.versions?.at(-1),
  })).filter(item => item.bundle.photo?.id && item.base?.id);
  return withPhotoOperations(prepared.map(item => item.bundle.photo.id), async () => {
    const storage = await hostStorage(parentId);
    const settings = (await hostSettings(parentId)).settings || {};
    const operationId = crypto.randomUUID();
    const stagingRoot = path.join(storage.dataRoot, 'projects', sha256(String(context.projectId)), '.batch-staging', operationId);
    const manifestPath = path.join(stagingRoot, 'manifest.json');
    const db = ensureSchema(storage.databasePath);
    const entries = [];
    try {
      for (const [index, item] of prepared.entries()) {
        assertDecodableImage(item.base.filePath);
        const authorized = await artifactsScope(parentId, { photoId: item.bundle.photo.id, baseVersionId: item.base.id, deliveryPrefix: path.posix.parse(String(item.base.relativePath || '').replace(/\\/g, '/')).name });
        const itemRoot = path.join(stagingRoot, String(index + 1));
        const exclusions = db.prepare('SELECT bbox_json FROM team_person_exclusions WHERE project_id=? AND photo_id=? AND base_version_id=?').all(String(context.projectId), String(item.bundle.photo.id), String(item.base.id)).map(row => parseJson(row.bbox_json, {}));
        entries.push({ ...item, authorized, key: `${index}`, outputDir: path.join(itemRoot, 'analysis'), deliveryDir: path.join(itemRoot, 'delivery'), exclusions });
      }
      for (const item of entries) { await fs.promises.mkdir(item.outputDir, { recursive: true }); await fs.promises.mkdir(item.deliveryDir, { recursive: true }); }
      await fs.promises.writeFile(manifestPath, JSON.stringify({ items: entries.map(item => ({ key: item.key, name: item.bundle.photo?.displayName || '', input: item.base.filePath, outputDir: item.outputDir, deliveryDir: item.deliveryDir, deliveryPrefix: item.authorized.deliveryPrefix, excludedBoxes: item.exclusions })) }), 'utf8');
      const detectedBatch = await runAlgorithm(parentId, ['detect-batch', '--manifest', manifestPath, '--provider', settings.useGpu === false ? 'cpu' : 'auto', '--oversize-crop-mode', settings.oversizeCropMode === 'expand' ? 'expand' : 'face-centered', '--advanced-mode', 'auto'], { topic: 'patch.detect-batch.progress', progress: { projectId: String(context.projectId), projectName: context.projectName } });
      const byKey = new Map((detectedBatch.results || []).map(item => [String(item.key), item]));
      const results = [];
      for (const item of entries) {
        const detected = byKey.get(item.key);
        if (!detected?.success) { results.push({ relativePath: item.relativePath, name: item.bundle.photo?.displayName || '', success: false, error: detected?.error || '批量算法没有返回这一项' }); continue; }
        const published = [];
        try {
          const publishedTasks = [];
          const workingPublications = [];
          for (const task of detected.tasks || []) {
            let maskTarget = null;
            if (task.maskPath) { maskTarget = path.join(item.authorized.analysisDirectory, path.basename(task.maskPath)); published.push(await publishStagedFile(task.maskPath, maskTarget, operationId)); }
            const domainPlan = { version: 1, photoId: String(item.bundle.photo.id), baseVersionId: String(item.base.id), allTaskIds: (detected.tasks || []).map(value => String(value.id)), task: { ...task, maskPath: maskTarget }, photo: { displayName: item.bundle.photo?.displayName || item.bundle.photo?.originalName || '', relativePath: item.base.relativePath || '', relativePathState: item.base.relativePathState || 'ready', fileMissing: Boolean(item.base.fileMissing) } };
            const working = await publishWorkingImage(parentId, storage, task.patchPath, item.base.relativePath, domainPlan);
            workingPublications.push(working.publication);
            const patchTarget = working.privatePath;
            publishedTasks.push({ ...task, patchPath: patchTarget, maskPath: maskTarget });
          }
          db.exec('BEGIN IMMEDIATE');
          let replaced;
          try {
            replaced = replacePatches(db, context, item.bundle.photo.id, item.base.id, publishedTasks);
            registerPhoto(db, context, item.bundle.photo.id, item.base.id, { displayName: item.bundle.photo?.displayName || item.bundle.photo?.originalName, relativePath: item.base.relativePath, relativePathState: item.base.relativePathState, fileMissing: item.base.fileMissing });
            queueCleanupArtifacts(db, context.projectId, replaced.old.flatMap(task => [task.patchPath, task.maskPath, task.editedPatchPath]).filter(filePath => filePath && !publishedTasks.some(task => task.patchPath === filePath || task.maskPath === filePath)));
            queueCleanupArtifacts(db, context.projectId, published.map(item => item.backupPath));
            db.exec('COMMIT');
          }
          catch (error) { db.exec('ROLLBACK'); throw error; }
          await commitPublished(published);
          for (const publication of workingPublications) await completeOutputPublication(publication);
          await removeArtifacts(replaced.old.flatMap(task => [task.patchPath, task.maskPath, task.editedPatchPath]).filter(filePath => filePath && !publishedTasks.some(task => task.patchPath === filePath || task.maskPath === filePath)));
          results.push({ relativePath: item.relativePath, name: item.bundle.photo?.displayName || '', success: true, photoId: item.bundle.photo.id, baseVersionId: item.base.id, personCount: detected.personCount, workTileCount: publishedTasks.length, detector: detected.detector, advancedBackend: detected.advancedBackend, fallbackReason: detected.fallbackReason });
        } catch (error) { await rollbackPublished(published); results.push({ relativePath: item.relativePath, name: item.bundle.photo?.displayName || '', success: false, error: error.message || String(error) }); }
      }
      return { success: results.some(item => item.success), results, persistentBackend: Boolean(detectedBatch.persistentBackend), requestedMode: detectedBatch.requestedMode || 'auto', advancedUsedCount: results.filter(item => item.advancedBackend).length, fallbackCount: results.filter(item => item.fallbackReason).length, error: results.some(item => item.success) ? undefined : '批量识别全部失败' };
    } finally { db.close(); await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined); await materialized.cleanup(); }
  });
};

const readJsonFile = filePath => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
};

const withDomain = async (parentId, worker) => {
  await assertCurrentRevisionLease();
  const storage = await hostStorage(parentId);
  const db = ensureSchema(storage.databasePath);
  try { return await worker(db, storage); } finally { db.close(); }
};

const cleanupGeneratedIdentities = (db, projectId) => {
  const rows = db.prepare(`SELECT identity.id,identity.name FROM team_person_identities identity
    LEFT JOIN team_person_assignments assignment ON assignment.project_id=identity.project_id AND assignment.identity_id=identity.id
    WHERE identity.project_id=? GROUP BY identity.id HAVING COUNT(assignment.identity_id)=0`).all(projectId);
  const remove = db.prepare('DELETE FROM team_person_identities WHERE project_id=? AND id=?');
  for (const row of rows) if (/^待确认人物 \d+$/.test(String(row.name || ''))) remove.run(String(projectId), row.id);
};

const assertOwnedSubjects = async (parentId, projectId, assignments) => {
  const photoIds = uniqueText(assignments.map(item => item.photoId));
  const media = photoIds.length ? await readMedia(parentId, { strict: true, mediaRefs: assignments.map(item => ({ photoId: item.photoId, versionId: item.baseVersionId })) }) : { items: [] };
  const versions = new Map((media.items || []).map(bundle => [String(bundle.photo?.id || ''), new Set((bundle.versions || []).map(version => String(version.id)))]));
  for (const item of assignments) {
    if (!versions.get(String(item.photoId))?.has(String(item.baseVersionId))) throw new Error('人物实例不属于当前团片协作项目');
  }
  if (String(projectId || '') === '') throw new Error('Component project identity is missing');
};
const assertOwnedSubjectsInDb = (db, projectId, assignments) => {
  const check = db.prepare(`SELECT 1 ok FROM team_retouch_photos photo
    JOIN team_patch_tasks task ON task.project_id=photo.project_id AND task.photo_id=photo.photo_id AND task.base_version_id=photo.base_version_id AND task.is_deleted=0
    JOIN json_each(task.members_json) member ON CAST(json_extract(member.value,'$.personIndex') AS INTEGER)=?
    WHERE photo.project_id=? AND photo.photo_id=? AND photo.base_version_id=? LIMIT 1`);
  for (const item of assignments) {
    const personIndex = Number(item.personIndex);
    if (!Number.isInteger(personIndex) || !check.get(personIndex, String(projectId), String(item.photoId), String(item.baseVersionId))) throw new Error('人物实例不属于当前项目有效任务');
  }
};

const upsertAssignmentSql = `INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,photo_id,base_version_id,person_index) DO UPDATE SET
  identity_id=excluded.identity_id,confidence=excluded.confidence,source=excluded.source,completed=excluded.completed,
  completion_kind=CASE WHEN excluded.completed=1 THEN team_person_assignments.completion_kind ELSE '' END,
  edited_patch_path=CASE WHEN excluded.completed=1 THEN team_person_assignments.edited_patch_path ELSE NULL END,
  return_missing=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing ELSE 0 END,
  return_missing_since=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing_since ELSE NULL END,
  completed_at=CASE WHEN excluded.completed=1 THEN team_person_assignments.completed_at ELSE NULL END,updated_at=excluded.updated_at`;

const saveIdentity = async (parentId, payload, context) => {
  const assignments = Array.isArray(payload.assignments) ? payload.assignments : [];
  await assertOwnedSubjects(parentId, context.projectId, assignments);
  return withDomain(parentId, db => {
    const projectId = String(context.projectId);
    const now = Date.now();
    const identityId = String(payload.identityId || crypto.randomUUID());
    const name = String(payload.name || '未命名人物').trim().slice(0, 80) || '未命名人物';
    db.exec('BEGIN IMMEDIATE');
    try {
      assertOwnedSubjectsInDb(db, projectId, assignments);
      const existing = db.prepare('SELECT id FROM team_person_identities WHERE id=? AND project_id=?').get(identityId, projectId);
      if (existing) db.prepare('UPDATE team_person_identities SET name=?,updated_at=? WHERE project_id=? AND id=?').run(name, now, projectId, identityId);
      else {
        const colors = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#059669', '#0891b2', '#4f46e5'];
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM team_person_identities WHERE project_id=?').get(projectId).count);
        db.prepare('INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(identityId, projectId, name, colors[count % colors.length], now, now);
      }
      const upsert = db.prepare(upsertAssignmentSql);
      for (const item of assignments) {
        const previous = db.prepare('SELECT identity_id,completed FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(projectId, String(item.photoId), String(item.baseVersionId), Number(item.personIndex));
        const completed = previous?.identity_id === identityId ? Boolean(previous.completed) : false;
        upsert.run(projectId, String(item.photoId), String(item.baseVersionId), Number(item.personIndex), identityId, Number(item.confidence ?? 1), 'manual', completed ? 1 : 0, now);
      }
      db.exec('COMMIT');
      return { success: true, identityId };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
};

const assignIdentity = async (parentId, payload, context) => {
  await assertOwnedSubjects(parentId, context.projectId, [payload]);
  return withDomain(parentId, db => {
    const projectId = String(context.projectId);
    const identityId = String(payload.identityId || '') || null;
    if (identityId && !db.prepare('SELECT id FROM team_person_identities WHERE id=? AND project_id=?').get(identityId, projectId)) throw new Error('人物身份不存在');
    const previous = db.prepare('SELECT identity_id,completed FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(projectId, String(payload.photoId), String(payload.baseVersionId), Number(payload.personIndex));
    const completed = Boolean(identityId && previous?.identity_id === identityId && previous.completed);
    db.exec('BEGIN IMMEDIATE');
    try {
      assertOwnedSubjectsInDb(db, projectId, [payload]);
      db.prepare(upsertAssignmentSql).run(projectId, String(payload.photoId), String(payload.baseVersionId), Number(payload.personIndex), identityId, Number(payload.confidence ?? 1), 'manual', completed ? 1 : 0, Date.now());
      if (previous?.identity_id && previous.identity_id !== identityId) cleanupGeneratedIdentities(db, projectId);
      db.exec('COMMIT');
      return { success: true };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
};

const confirmIdentityGroup = async (parentId, payload, context) => {
  const snapshot = await workspaceSnapshot(parentId, context);
  const subjects = new Map(snapshot.photos.flatMap(photo => photo.tasks.flatMap(task => task.members.map(member => ({
    key: `${photo.photoId}:${photo.baseVersionId}:${Number(member.personIndex)}`,
    photoId: photo.photoId, baseVersionId: photo.baseVersionId, personIndex: Number(member.personIndex),
  })))).map(item => [item.key, item]));
  const requested = [];
  const requestedKeys = new Set();
  for (const item of Array.isArray(payload.assignments) ? payload.assignments : []) {
    const key = `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`;
    const subject = subjects.get(key);
    if (!subject || requestedKeys.has(key)) continue;
    requestedKeys.add(key);
    requested.push({ ...subject, confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 1))) });
  }
  const anchor = String(payload.anchorSubjectKey || '');
  if (!requestedKeys.has(anchor)) throw new Error('当前人物必须包含在本次标记范围内');
  const includedPhotos = new Set();
  let duplicateSkippedCount = 0;
  const assignments = [...requested.filter(item => item.key === anchor), ...requested.filter(item => item.key !== anchor)].filter(item => {
    const photoKey = `${item.photoId}:${item.baseVersionId}`;
    if (includedPhotos.has(photoKey)) { duplicateSkippedCount += 1; return false; }
    includedPhotos.add(photoKey); return true;
  });
  const targetIdentityId = String(payload.identityId || '');
  const currentByKey = new Map(snapshot.assignments.map(item => [`${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`, item]));
  for (const item of assignments) {
    const current = currentByKey.get(item.key);
    if (item.key !== anchor && targetIdentityId && current?.identityId && current.identityId !== targetIdentityId && ['manual', 'manual-group'].includes(current.source)) throw new Error('候选组中包含已经人工确认的其他人物，请先取消勾选冲突项');
  }
  const clearAssignments = [];
  if (targetIdentityId) {
    for (const current of snapshot.assignments) {
      if (current.identityId !== targetIdentityId || !subjects.has(`${current.photoId}:${current.baseVersionId}:${Number(current.personIndex)}`)) continue;
      if (!includedPhotos.has(`${current.photoId}:${current.baseVersionId}`) || assignments.some(item => item.key === `${current.photoId}:${current.baseVersionId}:${Number(current.personIndex)}`)) continue;
      if (['manual', 'manual-group'].includes(current.source)) throw new Error('同一张照片中已有其他人工确认的人物使用该身份，请检查识别结果');
      clearAssignments.push(current);
    }
  }
  await assertOwnedSubjects(parentId, context.projectId, assignments);
  const confirmed = await withDomain(parentId, db => {
    const projectId = String(context.projectId);
    const now = Date.now();
    const requestedName = String(payload.name || '').trim().slice(0, 80);
    let identityId = targetIdentityId || null;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (requestedName) {
        const same = db.prepare('SELECT id FROM team_person_identities WHERE project_id=? AND lower(trim(name))=lower(trim(?)) LIMIT 1').get(projectId, requestedName);
        if (same && same.id !== identityId) identityId = String(same.id);
        else if (identityId) {
          if (!db.prepare('SELECT id FROM team_person_identities WHERE id=? AND project_id=?').get(identityId, projectId)) throw new Error('人物身份不存在');
          db.prepare('UPDATE team_person_identities SET name=?,updated_at=? WHERE project_id=? AND id=?').run(requestedName, now, projectId, identityId);
        } else {
          identityId = crypto.randomUUID();
          const colors = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#059669', '#0891b2', '#4f46e5'];
          const count = Number(db.prepare('SELECT COUNT(*) AS count FROM team_person_identities WHERE project_id=?').get(projectId).count);
          db.prepare('INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(identityId, projectId, requestedName, colors[count % colors.length], now, now);
        }
      } else if (identityId && !db.prepare('SELECT id FROM team_person_identities WHERE id=? AND project_id=?').get(identityId, projectId)) throw new Error('人物身份不存在');
      for (const item of clearAssignments) db.prepare('DELETE FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').run(projectId, item.photoId, item.baseVersionId, Number(item.personIndex));
      const upsert = db.prepare(upsertAssignmentSql);
      for (const item of assignments) {
        const previous = db.prepare('SELECT identity_id,completed FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(projectId, item.photoId, item.baseVersionId, item.personIndex);
        upsert.run(projectId, item.photoId, item.baseVersionId, item.personIndex, identityId, item.confidence, item.key === anchor ? 'manual' : 'manual-group', previous?.identity_id === identityId && previous.completed ? 1 : 0, now);
      }
      cleanupGeneratedIdentities(db, projectId);
      db.exec('COMMIT');
      return { identityId, updatedCount: assignments.length };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  return { ...(await workspaceSnapshot(parentId, context)), ...confirmed, autoReleasedCount: clearAssignments.length, duplicateSkippedCount };
};

const deleteIdentity = (parentId, payload, context) => withDomain(parentId, db => {
  const projectId = String(context.projectId);
  const identityId = String(payload.identityId || '');
  const affectedTasks = db.prepare('SELECT DISTINCT task_id,photo_id FROM team_person_assignments WHERE project_id=? AND identity_id=? AND task_id IS NOT NULL').all(projectId, identityId);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE team_person_assignments SET identity_id=NULL,confidence=0,source='',completed=0,completion_kind='',edited_patch_path=NULL,return_missing=0,return_missing_since=NULL,completed_at=NULL,updated_at=? WHERE identity_id=? AND project_id=?`).run(Date.now(), identityId, projectId);
    db.prepare('DELETE FROM team_person_identities WHERE id=? AND project_id=?').run(identityId, projectId);
    const settingsRow = db.prepare('SELECT settings_json FROM team_workflow_settings WHERE project_id=?').get(projectId);
    if (settingsRow) {
      const settings = parseJson(settingsRow.settings_json, {});
      const preferredIdentityOrder = uniqueText(settings.preferredIdentityOrder).filter(id => id !== identityId);
      const sameWeekIdentityIds = uniqueText(settings.sameWeekIdentityIds).filter(id => id !== identityId && preferredIdentityOrder.includes(id));
      db.prepare('UPDATE team_workflow_settings SET settings_json=?,updated_at=? WHERE project_id=?').run(JSON.stringify({ ...settings, preferredIdentityOrder, preferredIdentityId: preferredIdentityOrder[0] || undefined, sameWeekIdentityIds }), Date.now(), projectId);
    }
    for (const task of affectedTasks) markWorkflowReconcilePending(db, { taskId: task.task_id, photoId: task.photo_id }, new Error('人物身份已删除，等待工作流失效重建'));
    db.exec('COMMIT');
    return { success: true, workflowNeedsRegeneration: affectedTasks.length > 0, reconcilePendingCount: affectedTasks.length };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
});

const readIdentitySimilarities = async (parentId, _payload, context) => {
  const storage = await hostStorage(parentId);
  const payload = await readJson(path.join(storage.dataRoot, 'identity-similarities', `${sha256(String(context.projectId))}.json`), {});
  return { success: true, similarities: Array.isArray(payload.similarities) ? payload.similarities : [] };
};

const subjectKey = item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`;
const isGeneratedIdentity = identity => /^待确认人物\s+\d+$/.test(String(identity?.name || ''));

const suggestIdentities = async (parentId, _payload, context) => {
  const initial = await workspaceSnapshot(parentId, context);
  const assignmentBySubject = new Map(initial.assignments.map(item => [subjectKey(item), item]));
  const materialized = await materializeMediaForOperation(parentId, initial.photos.map(photo => ({ photoId: photo.photoId, versionId: photo.baseVersionId })));
  const sourceByPhoto = new Map(materialized.items.map(item => [String(item.photo.id), item.versions[0]?.filePath]));
  const subjects = initial.photos.flatMap(photo => photo.tasks.flatMap(task => (
    task.members
  ).map(member => ({
    key: `${photo.photoId}:${photo.baseVersionId}:${Number(member.personIndex)}`,
    photoId: photo.photoId,
    baseVersionId: photo.baseVersionId,
    personIndex: Number(member.personIndex),
    path: sourceByPhoto.get(String(photo.photoId)),
    manualIdentityId: (() => {
      const assignment = assignmentBySubject.get(`${photo.photoId}:${photo.baseVersionId}:${Number(member.personIndex)}`);
      return assignment?.identityId && ['manual', 'manual-group'].includes(String(assignment.source || '')) ? String(assignment.identityId) : null;
    })(),
    patchPath: task.patchPath,
    bbox: member.bbox || task.bbox,
    faceBox: member.faceBox || null,
  }))));
  if (!subjects.length) { await materialized.cleanup(); throw new Error('项目里还没有已识别的人物'); }
  const storage = await hostStorage(parentId);
  const batchDirectory = path.join(storage.dataRoot, 'batches', sha256(String(context.projectId)));
  const manifestPath = path.join(batchDirectory, `identify-${crypto.randomUUID()}.json`);
  let suggested;
  try {
    await fs.promises.mkdir(batchDirectory, { recursive: true });
    await fs.promises.writeFile(manifestPath, JSON.stringify({ subjects }, null, 2), 'utf8');
    suggested = await runAlgorithm(parentId, ['identify', '--manifest', manifestPath]);
  } finally {
    await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
    await materialized.cleanup();
  }
  await withDomain(parentId, db => {
    const projectId = String(context.projectId);
    const generated = db.prepare('SELECT id FROM team_person_identities WHERE project_id=? AND name GLOB ?').all(projectId, '待确认人物 *').map(row => String(row.id));
    if (!generated.length) return;
    const placeholders = generated.map(() => '?').join(',');
    const anchored = new Set(db.prepare(`SELECT DISTINCT identity_id FROM team_person_assignments WHERE project_id=? AND identity_id IN (${placeholders}) AND source IN ('manual','manual-group')`).all(projectId, ...generated).map(row => String(row.identity_id)));
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE team_person_assignments SET identity_id=NULL,confidence=0,completed=0,completion_kind='',edited_patch_path=NULL,return_missing=0,return_missing_since=NULL,completed_at=NULL,updated_at=? WHERE project_id=? AND identity_id IN (${placeholders}) AND source='suggested'`).run(Date.now(), projectId, ...generated);
      const removable = generated.filter(id => !anchored.has(id));
      if (removable.length) db.prepare(`DELETE FROM team_person_identities WHERE project_id=? AND id IN (${removable.map(() => '?').join(',')})`).run(projectId, ...removable);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  let current = await workspaceSnapshot(parentId, context);
  const currentByKey = new Map(current.assignments.map(item => [subjectKey(item), item]));
  const currentIdentities = new Map(current.identities.map(item => [String(item.id), item]));
  const assignedKeys = new Set([...currentByKey].filter(([, assignment]) => assignment.identityId).map(([key]) => key));
  let created = 0;
  let nextCandidateNumber = Math.max(0, ...current.identities.map(identity => Number(String(identity.name || '').match(/^待确认人物\s+(\d+)$/)?.[1] || 0))) + 1;
  for (const cluster of suggested.clusters || []) {
    const members = (cluster.members || []).map(item => subjects.find(subject => subject.key === item.key)).filter(Boolean);
    const known = new Set(members.map(member => currentByKey.get(member.key)).filter(item => item?.identityId && (item.source === 'manual' || !isGeneratedIdentity(currentIdentities.get(String(item.identityId))))).map(item => String(item.identityId)));
    if (known.size > 1) continue;
    const confidence = Number.isFinite(Number(cluster.score)) ? Math.max(.5, Math.min(.98, Number(cluster.score))) : cluster.confidence === 'high' ? .9 : .65;
    let identityId = [...known][0];
    if (!identityId) {
      const saved = await saveIdentity(parentId, { name: `待确认人物 ${nextCandidateNumber++}`, assignments: members.map(member => ({ ...member, confidence, source: 'suggested' })) }, context);
      identityId = saved.identityId;
      created += 1;
    } else {
      for (const member of members) {
        const assignment = currentByKey.get(member.key);
        if (assignment?.source === 'manual' || assignment?.identityId && !isGeneratedIdentity(currentIdentities.get(String(assignment.identityId)))) continue;
        await assignIdentity(parentId, { ...member, identityId, confidence, source: 'suggested' }, context);
      }
    }
    for (const member of members) assignedKeys.add(member.key);
  }
  for (const subject of subjects) {
    if (assignedKeys.has(subject.key)) continue;
    const saved = await saveIdentity(parentId, { name: `待确认人物 ${nextCandidateNumber++}`, assignments: [{ ...subject, confidence: .35, source: 'suggested' }] }, context);
    if (saved.identityId) { assignedKeys.add(subject.key); created += 1; }
  }
  await replaceJsonAtomic(path.join(storage.dataRoot, 'identity-similarities', `${sha256(String(context.projectId))}.json`), { updatedAt: Date.now(), similarities: suggested.similarities || [] });
  current = await workspaceSnapshot(parentId, context);
  return publicWorkspace({ ...current, similarities: suggested.similarities || [], suggestedCount: created, candidateGroupCount: suggested.clusters?.length || 0, method: suggested.method || 'sface-osnet-gallery-v3', faceBackend: suggested.faceBackend, bodyBackend: suggested.bodyBackend, unmatchedCount: suggested.unmatchedCount, provider: suggested.provider });
};

const saveWorkflowSettings = async (parentId, payload, context) => {
  const snapshot = await workspaceSnapshot(parentId, context);
  const workflowStarted = snapshot.assignments.some(assignment => assignment.completed || assignment.returnMissing)
    || snapshot.photos.some(photo => photo.tasks.some(task => Boolean(task.editedPatchPath) || !['', 'exported'].includes(String(task.status || 'exported'))));
  if (workflowStarted) throw new Error('已有任务返图或完成，不能再修改优先开工人物');
  const requestedOrder = Array.isArray(payload.preferredIdentityOrder)
    ? payload.preferredIdentityOrder
    : payload.preferredIdentityId ? [payload.preferredIdentityId] : [];
  const preferredIdentityOrder = uniqueText(requestedOrder);
  const identityIds = new Set(snapshot.identities.map(identity => String(identity.id)));
  const assignedIdentityIds = new Set(snapshot.assignments.map(assignment => String(assignment.identityId || '')).filter(Boolean));
  if (preferredIdentityOrder.some(identityId => !identityIds.has(identityId))) throw new Error('排序中包含不存在的人物，请刷新后重试');
  if (preferredIdentityOrder.some(identityId => !assignedIdentityIds.has(identityId))) throw new Error('排序中的人物还没有任何任务');
  const sameWeekIdentityIds = uniqueText(payload.sameWeekIdentityIds);
  if (sameWeekIdentityIds.some(identityId => !preferredIdentityOrder.slice(1).includes(identityId))) throw new Error('同周关系必须连接优先队列中相邻的人物');
  const workflowSettings = {
    preferredIdentityOrder,
    preferredIdentityId: preferredIdentityOrder[0] || undefined,
    sameWeekIdentityIds,
  };
  const storage = await hostStorage(parentId);
  const db = ensureSchema(storage.databasePath); const now = Date.now();
  try {
    db.exec('BEGIN IMMEDIATE');
    try { db.prepare('INSERT INTO team_workflow_settings(project_id,settings_json,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at').run(String(context.projectId), JSON.stringify(workflowSettings), now); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
  await replaceJsonAtomic(path.join(storage.dataRoot, 'workflow-settings', `${sha256(String(context.projectId))}.json`), { updatedAt: now, ...workflowSettings }).catch(() => undefined);
  return { success: true, workflowSettings };
};

const componentSettings = async (parentId, payload) => payload.action === 'get' ? hostSettings(parentId) : hostSettings(parentId, payload.settings || {});
const listProjectProgress = async parentId => { const value = await callHost(parentId, 'project.progress', { action: 'list' }); return { success: true, progressFolders: Array.isArray(value.progress) ? value.progress : [], graphEdges: Array.isArray(value.edges) ? value.edges : [] }; };
const createProjectProgress = async (parentId, payload) => {
  const listed = await callHost(parentId, 'project.progress', { action: 'list' });
  const raw = payload.progress || payload;
  const existingProgressId = String(raw.progressId || '');
  if (existingProgressId) {
    const existing = listed.progress.find(item => String(item.id) === existingProgressId);
    if (!existing || existing.nodeRole !== 'progress' || existing.mediaKind !== 'image' || existing.missing) throw new Error('合成结果的目标图片进度不存在');
    const edges = listed.edges.filter(edge => String(edge.sourceProgressId) === existingProgressId || String(edge.targetProgressId) === existingProgressId);
    return { success: true, progressFolder: existing, edges };
  }
  const parentProgressId = String(raw.parentProgressId || payload.workflowInputProgressIds?.[0] || listed.progress.find(item => item.nodeRole === 'original')?.id || '');
  if (!parentProgressId) throw new Error('创建输出进度需要一个来源进度');
  const displayName = String(raw.displayName || '团片协作输出').slice(0, 120);
  const relativePath = String(raw.relativePath || safeSegment(displayName, '团片协作输出')).replace(/\\/g, '/');
  const result = await callHost(parentId, 'project.progress', { action: 'create', relativePath, mediaKind: raw.mediaKind === 'video' ? 'video' : 'image', versionKey: String(raw.versionKey || Date.now()), parentProgressId, displayName, trackingEnabled: raw.trackingEnabled === true, sourceProgressIds: payload.workflowInputProgressIds || [] });
  return { success: true, progressFolder: result.progress, graphEdges: result.edges };
};
const listProjectMediaPage = async (parentId, payload) => { const value = await callHost(parentId, 'project.media.page', { pageSize: Math.min(200, Math.max(1, Number(payload.pageSize) || 200)), ...(payload.cursor ? { cursor: payload.cursor } : {}), kinds: ['image', 'raw'] }); return { success: true, items: value.items || [], hasMore: Boolean(value.page?.hasMore), cursor: value.page?.cursor || null }; };

const archiveReturnedFile = async (source, destination, storageRoot) => {
  const pending = `${destination}.${safeSegment(revisionRequestContext.getStore()?.requestId || crypto.randomUUID(), 'request')}.pending`;
  if (storageRoot && isInside(storageRoot, source)) {
    try {
      await fs.promises.link(source, pending);
      replacePersistentFromStage(pending, destination);
      return 'linked';
    } catch (error) {
      if (error?.code === 'EEXIST') throw error;
      await fs.promises.rm(pending, { force: true }).catch(() => undefined);
    }
  }
  await fs.promises.copyFile(source, pending, fs.constants.COPYFILE_EXCL);
  try { replacePersistentFromStage(pending, destination); }
  catch (error) { await fs.promises.rm(pending, { force: true }).catch(() => undefined); throw error; }
  return 'copied';
};

const markWorkflowReconcilePending = (db, payload, error) => {
  const message = String(error?.message || error || '等待后台更新接力任务').slice(0, 500);
  return db.prepare(`INSERT INTO team_workflow_reconcile_pending(project_id,task_id,photo_id,error,attempt_count,next_attempt_at,last_error,history_json,updated_at) VALUES(?,?,?,?,0,0,?,'[]',?)
    ON CONFLICT(project_id,task_id) DO UPDATE SET photo_id=excluded.photo_id,error=excluded.error,attempt_count=0,next_attempt_at=0,last_error=excluded.last_error,updated_at=excluded.updated_at`)
    .run(activeProjectId(), String(payload.taskId), String(payload.photoId), message, message, Date.now());
};

const storeReturnedPatchInDomain = async (db, storage, sourcePath, payload, context) => {
  const source = path.resolve(sourcePath);
  const sourceStat = await fs.promises.stat(source).catch(() => null);
  const extension = path.extname(source).toLowerCase();
  if (['.heic', '.heif'].includes(extension)) throw new Error('HEIC/HEIF 返图当前无法可靠解码；请先在系统照片或修图软件中导出为 JPEG、PNG、TIFF 或 WebP 后重试');
  if (!sourceStat?.isFile() || !RETURN_IMAGE_EXTENSIONS.has(extension)) throw new Error('返图格式不受支持；请导出为 JPEG、PNG、TIFF 或 WebP');
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE project_id=? AND id=? AND photo_id=? AND base_version_id=? AND is_deleted=0').get(String(context.projectId), String(payload.taskId || ''), String(payload.photoId || ''), String(payload.baseVersionId || ''));
  if (!row) throw new Error('Component return task is outside the bound photo version');
  const authorized = artifactGrantForStorage(storage, { photoId: row.photo_id, baseVersionId: row.base_version_id });
  const destination = path.join(authorized.uploadDirectory, `${row.id}-${crypto.randomUUID()}${path.extname(source).toLowerCase()}`);
  await fs.promises.mkdir(authorized.uploadDirectory, { recursive: true });
  await archiveReturnedFile(source, destination, storage.dataPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const artifact = createArtifact(db, row, Number(payload.personIndex), destination, 'returned', { matchConfidence: payload.matchConfidence, editEvidence: payload.editEvidence, returnWarnings: payload.returnWarnings || [] });
      const warnings = uniqueText(payload.returnWarnings);
      db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status='uploaded',needs_review=?,review_reason=?,updated_at=? WHERE project_id=? AND id=?`).run(destination, warnings.length ? 1 : 0, warnings.join('；'), Date.now(), String(context.projectId), row.id);
      if (payload.complete) {
        const personIndex = Number(payload.personIndex);
        const existingAssignment = db.prepare('SELECT identity_id FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(String(context.projectId), row.photo_id, row.base_version_id, personIndex);
        db.prepare(upsertAssignmentSql).run(String(context.projectId), row.photo_id, row.base_version_id, personIndex, existingAssignment?.identity_id || null, 1, 'manual', 1, Date.now());
        db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,artifact_id=?,edited_patch_path=?,completed=1,completion_kind='returned',return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, artifact.stageId, artifact.id, destination, Date.now(), Date.now(), String(context.projectId), row.photo_id, row.base_version_id, personIndex);
      }
      if (payload.reviewSessionId && payload.returnId) db.prepare(`INSERT INTO team_workflow_review_confirmations(project_id,review_session_id,return_id,task_id,photo_id,base_version_id,person_index,created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,review_session_id,return_id) DO NOTHING`)
        .run(String(context.projectId), String(payload.reviewSessionId), String(payload.returnId), row.id, row.photo_id, row.base_version_id, Number(payload.personIndex), Date.now());
      if (payload.deferReconcile) markWorkflowReconcilePending(db, { taskId: row.id, photoId: row.photo_id }, new Error('返图已确认，等待后台更新接力任务'));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (payload.deferReconcile) await appendCommand(storage, { operationId: crypto.randomUUID(), type: 'workflow-reconcile', state: 'pending-retry', taskId: row.id, photoId: row.photo_id, error: '返图已确认，等待后台更新接力任务' }).catch(() => undefined);
    return {
      success: true,
      artifactPath: destination,
      ...(payload.deferReconcile ? { reconcilePending: true, warning: '返图已确认；下一位接力任务正在后台更新，可以继续核对其他返图' } : {}),
    };
  } catch (error) {
    // If ownership was lost, this deliberately fails closed and leaves the
    // request-unique artifact for later garbage collection.
    removePersistentPaths([destination]);
    throw error;
  }
};
const TEAM_MEDIA_VARIANTS = new Set(['preview', 'original']);
const mediaRequest = payload => Object.fromEntries(['kind', 'variant', 'photoId', 'baseVersionId', 'taskId', 'personIndex', 'reviewSessionId', 'returnId'].filter(field => Object.hasOwn(payload || {}, field)).map(field => [field, payload[field]]));
const unavailableMedia = (variant, category) => ({ success: false, state: 'MISSING', category, variant, error: category === 'variant-unavailable' ? (variant === 'preview' ? '预览暂时无法生成，可重试或明确打开原图' : '原图暂时无法读取，请检查历史文件后重试') : '历史媒体引用缺失或文件暂时不可用' });
const expectedMediaError = (error, variant) => {
  const code = String(error?.code || '');
  if (code === 'COMPONENT_HOST_VARIANT_UNAVAILABLE') return unavailableMedia(variant, 'variant-unavailable');
  if (code === 'COMPONENT_HOST_NOT_FOUND') return unavailableMedia(variant, 'history-reference-missing');
  return null;
};
const componentMedia = async (parentId, payload, action = 'variants') => {
  const variant = String(payload.variant || '');
  if (action === 'variants' && !TEAM_MEDIA_VARIANTS.has(variant)) throw new Error('Unsupported team media variant; expected preview or original');
  if (payload.kind === 'original') {
    if (action !== 'variants') return { success: false, error: '原图由项目媒体查看器打开' };
    let media;
    try { media = await callHost(parentId, 'project.media.variants', { photoId: payload.photoId, versionId: payload.baseVersionId, variants: [variant] }); }
    catch (error) { const expected = expectedMediaError(error, variant); if (expected) return expected; throw error; }
    const url = media.variants?.[variant]?.url;
    if (!url) return unavailableMedia(variant, 'variant-unavailable');
    return { success: true, variant, url, ...(variant === 'preview' ? { previewUrl: url } : { originalUrl: url }), opaqueRef: media.mediaRef };
  }
  const storage = await hostStorage(parentId);
  let candidate = '';
  if (payload.kind === 'review-return') {
    const directory = path.join(storage.dataPath, 'workflow-return-reviews', sha256(String(storage.projectId)));
    const session = await readJson(path.join(directory, 'session.json'), null);
    if (!session || String(session.id || '') !== String(payload.reviewSessionId || '') || String(session.projectId || '') !== String(storage.projectId || '')) throw new Error('返图审核 session 已过期或不属于当前项目');
    const match = (session?.result?.matches || []).find(item => String(item.returnId) === String(payload.returnId));
    if (payload.photoId && String(match?.photoId || '') !== String(payload.photoId)) throw new Error('返图审核照片绑定不匹配');
    if (payload.baseVersionId && String(match?.baseVersionId || '') !== String(payload.baseVersionId)) throw new Error('返图审核版本绑定不匹配');
    candidate = String(match?.path || '');
  } else {
    const db = ensureSchema(storage.databasePath);
    try {
      const row = db.prepare('SELECT * FROM team_patch_tasks WHERE project_id=? AND id=? AND photo_id=? AND base_version_id=? AND is_deleted=0').get(String(storage.projectId), String(payload.taskId || ''), String(payload.photoId || ''), String(payload.baseVersionId || ''));
      if (!row) throw new Error('组件媒体 outside the bound photo version');
      if (payload.kind === 'working') candidate = String(row.patch_path || '');
      else {
        const assignment = Number.isInteger(Number(payload.personIndex)) ? db.prepare('SELECT edited_patch_path FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(String(storage.projectId), String(payload.photoId), String(payload.baseVersionId), Number(payload.personIndex)) : null;
        candidate = String(assignment?.edited_patch_path || row.edited_patch_path || '');
      }
    } finally { db.close(); }
  }
  if (!candidate) return unavailableMedia(variant, 'history-reference-missing');
  const currentProjectRoot = path.join(storage.dataPath, 'projects', sha256(String(storage.projectId)));
  const reviewRoot = path.join(storage.dataPath, 'workflow-return-reviews', sha256(String(storage.projectId)));
  let exactMaterialized = false;
  if (!isInside(currentProjectRoot, candidate) && !isInside(reviewRoot, candidate)) {
    const db = ensureSchema(storage.databasePath);
    try { exactMaterialized = db.prepare('SELECT result_json FROM team_output_outbox WHERE project_id=?').all(String(storage.projectId)).some(row => path.resolve(String(parseJson(row.result_json, {})?.materialized?.privatePath || '')).toLowerCase() === path.resolve(candidate).toLowerCase()); }
    finally { db.close(); }
  }
  if (!isInside(currentProjectRoot, candidate) && !isInside(reviewRoot, candidate) && !exactMaterialized) throw new Error('组件媒体 outside the bound project namespace');
  if (!isInside(storage.dataPath, candidate)) throw new Error('Host-owned materialization cannot be served through component.media without a Host receipt URL');
  const relativePath = path.relative(storage.dataPath, candidate).replace(/\\/g, '/');
  if (action === 'open') return callHost(parentId, 'component.media', { action: 'open', relativePath });
  let media;
  try { media = await callHost(parentId, 'component.media', { action: 'variants', relativePath, variants: [variant] }); }
  catch (error) { const expected = expectedMediaError(error, variant); if (expected) return expected; throw error; }
  const url = media.variants?.[variant]?.url;
  if (!url) return unavailableMedia(variant, 'variant-unavailable');
  return { success: true, variant, url, ...(variant === 'preview' ? { previewUrl: url } : { originalUrl: url }), opaqueRef: media.opaqueRef };
};
const completeIdentity = (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const photoId = String(payload.photoId || '');
  const baseVersionId = String(payload.baseVersionId || '');
  const personIndex = Number(payload.personIndex);
  if (!photoId || !baseVersionId || !Number.isInteger(personIndex)) throw new Error('人物完成状态参数无效');
  const candidates = taskRows(db, photoId, baseVersionId).filter(row => {
    const members = strictRowMembers(row);
    return members.some(member => Number(member.personIndex) === personIndex);
  });
  const row = payload.taskId ? candidates.find(item => String(item.id) === String(payload.taskId)) : candidates[0];
  if (!row || (!payload.taskId && candidates.length > 1)) throw new Error('人物完成状态 outside the bound photo version，或无法唯一绑定到组件修图任务');
  const stage = db.prepare('SELECT * FROM team_task_stages WHERE project_id=? AND task_id=? AND person_index=?').get(String(context.projectId), row.id, personIndex);
  const existing = db.prepare('SELECT * FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(String(context.projectId), photoId, baseVersionId, personIndex);
  let removedPath = '';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(upsertAssignmentSql).run(String(context.projectId), photoId, baseVersionId, personIndex, existing?.identity_id || null, Number(existing?.confidence || 1), existing?.source || 'manual', payload.completed === false ? 0 : 1, Date.now());
    if (payload.completed === false) {
      if (existing?.artifact_id) {
        const artifact = db.prepare('SELECT * FROM team_task_artifacts WHERE project_id=? AND id=? AND task_id=? AND is_deleted=0').get(String(context.projectId), existing.artifact_id, row.id);
        if (artifact) { removedPath = artifact.artifact_path; db.prepare('UPDATE team_task_artifacts SET is_deleted=1 WHERE project_id=? AND id=?').run(String(context.projectId), artifact.id); }
      }
      const predecessor = currentTaskArtifact(db, row.id)?.artifact_path || null;
      db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,artifact_id=NULL,completed=0,completion_kind='',edited_patch_path=NULL,completed_at=NULL,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, stage?.id || null, Date.now(), String(context.projectId), photoId, baseVersionId, personIndex);
      db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status=?,updated_at=? WHERE project_id=? AND id=?`).run(predecessor, predecessor ? 'uploaded' : 'exported', Date.now(), String(context.projectId), row.id);
    } else {
      db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,completed=1,completion_kind=?,return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, stage?.id || null, String(payload.completionKind || 'no-retouch'), Date.now(), Date.now(), String(context.projectId), photoId, baseVersionId, personIndex);
    }
    markWorkflowReconcilePending(db, { taskId: row.id, photoId: row.photo_id }, new Error(payload.completed === false ? '完成状态已撤销，等待后台更新接力任务' : '完成状态已保存，等待后台更新接力任务'));
    if (removedPath) queueCleanupArtifacts(db, context.projectId, [removedPath]);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (removedPath) await drainCleanupOutbox(storage.databasePath, context.projectId).catch(() => undefined);
  await appendCommand(storage, { operationId: crypto.randomUUID(), type: 'workflow-reconcile', state: 'pending-retry', taskId: row.id, photoId: row.photo_id, error: payload.completed === false ? '完成状态已撤销，等待后台更新接力任务' : '完成状态已保存，等待后台更新接力任务' }).catch(() => undefined);
  return { success: true, completed: payload.completed !== false, taskId: row.id, personIndex, reconcilePending: true, relayState: 'preparing', warning: '状态已安全保存；接力任务正在后台更新' };
});
const publicWorkspace = value => ({
  ...value,
  photos: (value?.photos || []).map(photo => ({
    ...Object.fromEntries(Object.entries(photo).filter(([field]) => !['sourcePath', 'originalFilePath', 'previewUrl'].includes(field))),
    tasks: (photo.tasks || []).map(task => Object.fromEntries(Object.entries(task).filter(([field]) => !['patchPath', 'maskPath', 'editedPatchPath', 'uploadPath', 'returnedPath', 'previewUrl', 'patchUrl'].includes(field)))),
  })),
  assignments: (value?.assignments || []).map(assignment => Object.fromEntries(Object.entries(assignment).filter(([field]) => !['editedPatchPath', 'returnedPath'].includes(field)))),
});
const domainRevision = (db, projectId) => {
  return String(Number(db.prepare('SELECT revision FROM team_project_revisions WHERE project_id=?').get(String(projectId))?.revision) || 0);
};

const workspaceSnapshot = async (parentId, context) => {
  const storage = await hostStorage(parentId);
  const db = ensureSchema(storage.databasePath);
  try {
    const projectId = String(storage.projectId || context.projectId || '');
    const registered = db.prepare('SELECT * FROM team_retouch_photos WHERE project_id=? ORDER BY created_at').all(projectId);
    const assignments = db.prepare('SELECT * FROM team_person_assignments WHERE project_id=?').all(projectId);
    const candidatePhotoIds = uniqueText([
      ...registered.map(row => row.photo_id),
      ...assignments.map(row => row.photo_id),
    ]);
    if (candidatePhotoIds.length > MAX_ITEMS) throw new Error(`团片项目包含 ${candidatePhotoIds.length} 张照片，超过单次 workspace 上限 ${MAX_ITEMS}；请分页打开而不是静默截断`);
    const registrations = new Map(registered.map(row => [String(row.photo_id), row]));
    const versionByPhoto = new Map([...registered.map(row => [String(row.photo_id), String(row.base_version_id)]), ...assignments.map(row => [String(row.photo_id), String(row.base_version_id)])]);
    const tasksByPhoto = new Map();
    const excludedByVersion = new Map();
    if (candidatePhotoIds.length) {
      const placeholders = candidatePhotoIds.map(() => '?').join(',');
      for (const row of db.prepare(`SELECT * FROM team_patch_tasks WHERE project_id=? AND is_deleted=0 AND photo_id IN (${placeholders}) ORDER BY created_at,person_index`).all(projectId, ...candidatePhotoIds)) {
        const values = tasksByPhoto.get(String(row.photo_id)) || [];
        values.push(row);
        tasksByPhoto.set(String(row.photo_id), values);
      }
      for (const row of db.prepare(`SELECT photo_id,base_version_id,COUNT(*) count FROM team_person_exclusions WHERE project_id=? AND photo_id IN (${placeholders}) GROUP BY photo_id,base_version_id`).all(projectId, ...candidatePhotoIds)) {
        excludedByVersion.set(`${row.photo_id}\0${row.base_version_id}`, Number(row.count) || 0);
      }
    }
    const photos = [];
    for (const photoId of candidatePhotoIds) {
      const rows = tasksByPhoto.get(photoId) || [];
      const registration = registrations.get(photoId);
      if (!rows.length && !registration) continue;
      const grouped = new Map();
      for (const row of rows) {
        const values = grouped.get(String(row.base_version_id)) || [];
        values.push(row);
        grouped.set(String(row.base_version_id), values);
      }
      let baseVersionId = String(registration?.base_version_id || '');
      if (!baseVersionId) baseVersionId = String(versionByPhoto.get(photoId) || [...grouped.keys()].at(-1) || '');
      if (!baseVersionId) continue;
      const relativePath = String(registration?.relative_path || '');
      photos.push({
        photoId, baseVersionId, displayName: String(registration?.display_name || path.parse(relativePath).name || photoId),
        relativePath, relativePathState: String(registration?.relative_path_state || 'unresolvable'), fileMissing: Boolean(registration?.file_missing), mediaRef: { photoId, versionId: baseVersionId, relativePath },
        tasks: (grouped.get(baseVersionId) || []).map(serializeTask),
        excludedPersonCount: excludedByVersion.get(`${photoId}\0${baseVersionId}`) || 0,
      });
    }
    const identities = db.prepare('SELECT id,name,color,created_at AS createdAt,updated_at AS updatedAt FROM team_person_identities WHERE project_id=? ORDER BY created_at').all(projectId);
    const normalizedAssignments = assignments.map(row => ({
      photoId: row.photo_id, baseVersionId: row.base_version_id, personIndex: row.person_index,
      identityId: row.identity_id, identityConfirmed: Boolean(row.identity_id) && ['manual', 'manual-group', 'suggested'].includes(String(row.source)), confidence: row.confidence, source: row.source,
      completed: Boolean(row.completed) && !Boolean(row.return_missing), completionKind: row.completion_kind,
      editedPatchPath: row.edited_patch_path, returnMissing: Boolean(row.return_missing),
      returnMissingSince: row.return_missing_since, completedAt: row.completed_at, updatedAt: row.updated_at,
    }));
    const settings = parseJson(db.prepare('SELECT settings_json FROM team_workflow_settings WHERE project_id=?').get(projectId)?.settings_json, null)
      || readJsonFile(path.join(storage.dataRoot, 'workflow-settings', `${sha256(String(context.projectId))}.json`)) || {};
    const identityIds = new Set(identities.map(identity => String(identity.id)));
    const preferredIdentityOrder = uniqueText(settings.preferredIdentityOrder).filter(id => identityIds.has(id));
    const requestedSameWeek = new Set(uniqueText(settings.sameWeekIdentityIds));
    const sameWeekIdentityIds = preferredIdentityOrder.slice(1).filter(id => requestedSameWeek.has(id));
    const { manifest: resolvedManifest } = await workflowDirectoryResolver(storage, context);
    const workflowState = db.prepare('SELECT generated_at,fingerprint FROM team_workflow_state WHERE project_id=?').get(projectId);
    const manifest = workflowState && resolvedManifest && Number(workflowState.generated_at) === Number(resolvedManifest.generatedAt) && String(workflowState.fingerprint || '') === String(resolvedManifest.fingerprint || '') && String(resolvedManifest.projectId || '') === projectId ? resolvedManifest : null;
    const generatedSettings = manifest?.workflowSettings;
    const generatedOrder = uniqueText(generatedSettings?.preferredIdentityOrder);
    const generatedSameWeek = new Set(uniqueText(generatedSettings?.sameWeekIdentityIds));
    const workflowItems = (manifest?.groups || []).flatMap(group => group.items || []);
    const recoveryRequired = resolvedManifest?.recovery?.state === 'needs-republish' ? { required: true, state: 'needs-republish', resources: ['workflow-output'], action: 'team.workflow.reconcile-drain.v1' } : null;
    const assignmentIdentityBySubject = new Map(normalizedAssignments.map(item => [`${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`, String(item.identityId || '')]));
    const assignmentIdentityByStableSubject = new Map(normalizedAssignments.map(item => [`${item.baseVersionId}:${Number(item.personIndex)}`, String(item.identityId || '')]));
    const workflowItemIdentity = item => {
      const exactKey = `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`;
      if (assignmentIdentityBySubject.has(exactKey)) return assignmentIdentityBySubject.get(exactKey);
      return assignmentIdentityByStableSubject.get(`${item.baseVersionId}:${Number(item.personIndex)}`);
    };
    const generatedIdentityChanged = Boolean(manifest && (manifest.groups || []).some(group => (group.items || []).some(item =>
      workflowItemIdentity(item) !== String(group.identityId || '')
    )));
    const workflowAvailableItems = workflowItems.filter(item => item.available && item.relativePath);
    return {
      success: true, photos, identities, assignments: normalizedAssignments,
      snapshotVersion: 1,
      revision: domainRevision(db, projectId),
      workflowGenerated: Boolean(manifest && Number(manifest.version) >= 2),
      workflowNeedsRegeneration: Boolean(manifest && (generatedIdentityChanged || generatedSettings && (JSON.stringify(generatedOrder) !== JSON.stringify(preferredIdentityOrder)
        || JSON.stringify(generatedOrder.slice(1).filter(id => generatedSameWeek.has(id))) !== JSON.stringify(sameWeekIdentityIds)))),
      workflowAvailableKeys: workflowAvailableItems.map(item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowAvailableSubjectKeys: workflowAvailableItems.map(item => `${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowParticipantKeys: workflowItems.map(item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowParticipantSubjectKeys: workflowItems.map(item => `${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowSettings: { preferredIdentityOrder, preferredIdentityId: preferredIdentityOrder[0] || undefined, sameWeekIdentityIds },
      recoveryRequired,
    };
  } finally { db.close(); }
};

const writeJsonAtomic = replaceJsonAtomic;

const workflowDirectoryResolver = createWorkflowManifestResolver({ crypto, fs, path, writeJsonAtomic });
const workflowScopeForStorage = (storage, context) => workflowDirectoryResolver(storage, context);
const workflowScope = async (parentId, context) => workflowScopeForStorage(await hostStorage(parentId), context);
const readWorkflowManifest = async (parentId, context) => {
  const storage = await hostStorage(parentId); const scope = await workflowScopeForStorage(storage, context);
  if (!scope.manifest) return scope;
  const db = ensureSchema(storage.databasePath);
  try {
    const state = db.prepare('SELECT generated_at,fingerprint FROM team_workflow_state WHERE project_id=?').get(String(context.projectId));
    if (!state || Number(state.generated_at) !== Number(scope.manifest.generatedAt) || String(state.fingerprint || '') !== String(scope.manifest.fingerprint || '') || String(scope.manifest.projectId || '') !== String(context.projectId)) return { ...scope, manifest: null, source: 'stale-current' };
    return scope;
  } finally { db.close(); }
};
const workflowCleanupReceiptPath = (storage, projectId) => path.join(storage.dataPath, 'output-cleanup', `${sha256(String(projectId))}.json`);
const retryWorkflowOutputCleanup = async (parentId, storage, context, additions = []) => {
  const receiptPath = workflowCleanupReceiptPath(storage, context.projectId);
  const prior = await readJson(receiptPath, { pending: [] });
  const pending = [...(Array.isArray(prior.pending) ? prior.pending : []), ...additions];
  if (pending.length) await replaceJsonAtomic(receiptPath, { version: 1, projectId: String(context.projectId), pending, updatedAt: Date.now() });
  const failed = [];
  for (const item of pending) {
    try {
      await callHost(parentId, 'project.output', { action: 'delete', previousCommitId: item.commitId, previousArtifactId: item.artifactId, expectedDigest: item.sha256, idempotencyKey: `workflow-delete-${sha256(`${context.projectId}\0${item.relativePath}\0${item.artifactId}`).slice(0, 24)}` });
    } catch (error) { failed.push({ ...item, lastError: String(error?.message || error), updatedAt: Date.now() }); }
  }
  if (failed.length) await replaceJsonAtomic(receiptPath, { version: 1, projectId: String(context.projectId), pending: failed, updatedAt: Date.now() });
  else removePersistentPaths([receiptPath]);
  return { attempted: pending.length, pending: failed.length };
};

const reportTask = async (parentId, operationId, action, update = {}, topic = '') => hostTask(parentId, operationId, action, { title: '生成团片协作工作流', operationId, ...update }, topic);

const generateWorkflowUnlocked = async (parentId, payload, context) => {
  const operationId = String(payload.operationId || crypto.randomUUID());
  const key = String(context.projectId);
  const existing = workflowJobs.get(key);
  if (existing?.state === 'running') return { success: true, alreadyRunning: true, operationId: existing.operationId };
  const job = { operationId, projectId: String(context.projectId), cancelled: false, state: 'running', phase: 'preparing', progress: 0, message: '正在准备工作流程' };
  workflowJobs.set(key, job);
  const jobStorage = await hostStorage(parentId); const jobStatePath = path.join(jobStorage.dataPath, 'workflow-jobs', `${sha256(key)}.json`);
  let jobPersistence = Promise.resolve(); const persistJob = () => { const snapshot = { ...job }; jobPersistence = jobPersistence.catch(() => undefined).then(() => replaceJsonAtomic(jobStatePath, snapshot)); return jobPersistence; };
  await persistJob();
  const publish = async update => {
    const scopedUpdate = { ...update, projectId: String(context.projectId), operationId };
    delete scopedUpdate.projectName;
    Object.assign(job, scopedUpdate);
    await persistJob();
    const host = await reportTask(parentId, operationId, scopedUpdate.state === 'completed' ? 'complete' : scopedUpdate.state === 'failed' ? 'failed' : 'report', scopedUpdate, 'workflow.progress');
    if (host?.cancelled) job.cancelled = true;
  };
  let stagingDirectory = '';
  let backupDirectory = '';
  let checkpointReady = false;
  let hostPublicationCommitted = false;
  try {
    await retryWorkflowOutputCleanup(parentId, jobStorage, context).catch(() => undefined);
    await reportTask(parentId, operationId, 'start', { message: job.message, checkpoint: { projectId: context.projectId, operationId } }, 'workflow.progress');
    const scope = await readWorkflowManifest(parentId, context);
    const previousManifest = scope.manifest;
    if ((fs.existsSync(scope.outputDirectory) || previousManifest) && !payload.replace) {
      await publish({ state: 'awaiting-confirmation', phase: 'awaiting-confirmation', message: '已有团片工作流，等待确认替换' });
      return { success: true, requiresConfirmation: true, operationId, state: job.state };
    }
    const snapshot = await workspaceSnapshot(parentId, context);
    const projectDirectory = path.dirname(scope.outputDirectory);
    const stagePrefix = `.photoflow-team-workflow-staging-${sha256(String(context.projectId)).slice(0, 16)}-`;
    const ownerToken = sha256(String(revisionRequestContext.getStore()?.requestId || crypto.randomUUID())).slice(0, 20);
    stagingDirectory = path.join(projectDirectory, `${stagePrefix}${ownerToken}`);
    const plan = await buildWorkflowPlan({ groups: Array.isArray(payload.groups) ? payload.groups : [], workspace: snapshot, stagingDirectory, safeSegment, weekName });
    if (!plan.manifestGroups.length || !plan.files.length) throw new Error('没有可生成的工作流程任务');
    const workflowSettings = {
      preferredIdentityOrder: uniqueText(payload.preferredIdentityOrder),
      preferredIdentityId: uniqueText(payload.preferredIdentityOrder)[0] || String(payload.preferredIdentityId || '') || undefined,
      sameWeekIdentityIds: uniqueText(payload.sameWeekIdentityIds),
    };
    const fingerprint = sha256(`${plan.fingerprint}\0${JSON.stringify(workflowSettings)}`);
    const checkpointPath = path.join(stagingDirectory, '.photoflow-workflow-checkpoint.json');
    const checkpoint = await readJson(checkpointPath, null);
    await fs.promises.mkdir(stagingDirectory, { recursive: true });
    for (const group of plan.manifestGroups) if ((group.items || []).some(item => item.available)) await fs.promises.mkdir(path.join(stagingDirectory, group.relativePath), { recursive: true });
    // A successor never writes or deletes a predecessor's stage. Matching old
    // stages are untrusted read-only caches: each candidate is hashed before
    // and again by copyWorkflowPlan after copying into this owner's stage.
    const stageEntries = await fs.promises.readdir(projectDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of stageEntries.filter(item => item.isDirectory() && item.name.startsWith(stagePrefix) && item.name !== path.basename(stagingDirectory)).slice(-4)) {
      const candidateRoot = path.join(projectDirectory, entry.name);
      const candidateCheckpoint = await readJson(path.join(candidateRoot, '.photoflow-workflow-checkpoint.json'), null);
      if (candidateCheckpoint?.fingerprint !== fingerprint || String(candidateCheckpoint.projectId || '') !== String(context.projectId)) continue;
      for (const file of plan.files) {
        const relative = path.relative(stagingDirectory, file.destination);
        const candidate = path.join(candidateRoot, relative);
        try {
          const stat = await fs.promises.stat(candidate);
          if (!stat.isFile() || stat.size !== file.size || await fileSha256(candidate) !== file.sha256) continue;
          await fs.promises.copyFile(candidate, file.destination, fs.constants.COPYFILE_EXCL);
        } catch { /* stale/untrusted cache entries are ignored */ }
      }
    }
    await writeJsonAtomic(checkpointPath, { version: 1, projectId: String(context.projectId), ownerToken, fingerprint, updatedAt: Date.now() });
    checkpointReady = true;
    await publish({ phase: 'copying', totalFiles: plan.files.length, totalBytes: plan.totalBytes, message: checkpoint?.fingerprint === fingerprint ? '正在续传工作图…' : '正在复制工作图…' });
    let progressReports = Promise.resolve();
    await copyWorkflowPlan({
      files: plan.files, totalBytes: plan.totalBytes, copyFileAtomic, concurrency: 3,
      isCancelled: () => job.cancelled || context.signal?.aborted,
      onProgress: update => {
        progressReports = progressReports.catch(() => undefined).then(() => publish({ ...update, message: update.phase === 'resuming' ? '正在复用已完成的工作图…' : update.phase === 'finalizing' ? '正在提交工作流程…' : '正在复制工作图…' }));
      },
    });
    await progressReports;
    if (job.cancelled || context.signal?.aborted) throw Object.assign(new Error('工作流程生成已取消'), { code: CANCELLED_CODE });
    const manifest = { version: 2, projectId: String(context.projectId), generatedAt: Date.now(), fingerprint, workflowSettings, groups: plan.manifestGroups };
    try {
      const replacements = new Map(Object.entries(previousManifest?.outputOwnership || {}).map(([relativePath, value]) => [relativePath, value]));
      const outputFiles = manifest.groups.flatMap(group => (group.items || []).filter(item => item.available && item.relativePath).map(item => {
        const ownershipKey = `团片协作/${String(item.relativePath).replace(/\\/g, '/')}`; const prior = replacements.get(ownershipKey);
        return { sourcePath: path.resolve(stagingDirectory, item.relativePath), ownershipKey, outputRelativePath: String(prior?.publishedRelativePath || ownershipKey), replacement: prior || null };
      }));
      const swapToken = crypto.randomUUID();
      const nextOwnershipKeys = new Set(outputFiles.map(file => file.ownershipKey));
      const plannedRetiredOutputs = Object.entries(previousManifest?.outputOwnership || {}).filter(([key]) => !nextOwnershipKeys.has(key)).map(([key, ownership]) => ({ relativePath: ownership.publishedRelativePath || key, ...ownership }));
      const continuationPlan = { version: 1, kind: 'workflow-output', projectId: String(context.projectId), preHostLocalEffects: 'none', manifestPath: scope.manifestPath, manifest: { ...manifest, outputOwnership: {} }, workflowState: { generatedAt: Number(manifest.generatedAt), fingerprint }, outputs: outputFiles.map((file, index) => ({ outputRelativePath: file.outputRelativePath, ownershipKey: file.ownershipKey, relativePath: path.relative(stagingDirectory, file.sourcePath).replace(/\\/g, '/'), digest: plan.files[index]?.sha256 || '' })), localSwap: { stagingDirectory, outputDirectory: scope.outputDirectory, swapToken, backupDirectory: `${scope.outputDirectory}.${swapToken}.backup` }, retiredOutputs: plannedRetiredOutputs };
      const committed = await publishProjectFiles(parentId, outputFiles, `workflow-${sha256(fingerprint).slice(0, 24)}`, new Map(outputFiles.filter(file => file.replacement).map(file => [file.outputRelativePath, file.replacement])), continuationPlan);
      hostPublicationCommitted = true;
      const workflowPublication = replacePersistentFromStage(stagingDirectory, scope.outputDirectory, swapToken);
      backupDirectory = workflowPublication.backupPath;
      stagingDirectory = '';
      manifest.outputOwnership = Object.fromEntries((committed.outputs || []).map(item => {
        const planned = outputFiles.find(file => file.outputRelativePath === item.relativePath); return [planned?.ownershipKey || item.relativePath, { commitId: committed.commitId, artifactId: item.artifactId, sha256: item.sha256, publishedRelativePath: item.relativePath }];
      }));
      if (committed[OUTPUT_OUTBOX]) await outboxState(committed[OUTPUT_OUTBOX], 'domain_pending', { result: { ...parseJson(committed[OUTPUT_OUTBOX].row.result_json, {}), workflow: { manifestPath: scope.manifestPath, generatedAt: manifest.generatedAt, fingerprint } } });
      await writeJsonAtomic(scope.manifestPath, manifest);
      await withDomain(parentId, db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO team_workflow_state(project_id,generated_at,fingerprint,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET generated_at=excluded.generated_at,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at').run(String(context.projectId), Number(manifest.generatedAt), fingerprint, Date.now());
          if (backupDirectory) queueCleanupArtifacts(db, context.projectId, [backupDirectory]);
          db.exec('COMMIT');
        }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      const retiredOutputs = plannedRetiredOutputs;
      if (retiredOutputs.length) await retryWorkflowOutputCleanup(parentId, jobStorage, context, retiredOutputs).catch(() => undefined);
      await completeOutputPublication(committed);
    }
    catch (error) {
      if (!hostPublicationCommitted) {
        rollbackPersistentReplacements([{ destinationPath: scope.outputDirectory, backupPath: backupDirectory, directory: true }]);
        backupDirectory = '';
      }
      throw error;
    }
    checkpointReady = false;
    if (backupDirectory) await drainCleanupOutbox(jobStorage.databasePath, context.projectId).catch(() => undefined);
    const retiredStages = (await fs.promises.readdir(projectDirectory, { withFileTypes: true }).catch(() => []))
      .filter(item => item.isDirectory() && item.name.startsWith(stagePrefix)).map(item => path.join(projectDirectory, item.name));
    if (retiredStages.length > 4) removePersistentPaths(retiredStages.slice(0, retiredStages.length - 4));
    await publish({ state: 'completed', phase: 'complete', progress: 100, completedFiles: plan.files.length, totalFiles: plan.files.length, copiedBytes: plan.totalBytes, totalBytes: plan.totalBytes, message: '工作流程生成完成' });
    return { success: true, operationId, count: plan.files.length, groupCount: manifest.groups.length };
  } catch (error) {
    const cancelled = job.cancelled || error?.code === CANCELLED_CODE;
    job.state = cancelled ? 'cancelled' : 'failed';
    job.message = cancelled ? '工作流程生成已取消，可在下次继续' : error.message || String(error);
    await persistJob().catch(() => undefined);
    await reportTask(parentId, operationId, cancelled ? 'cancel' : 'failed', { ...job, error: cancelled ? '' : job.message }, 'workflow.progress').catch(() => undefined);
    if (!hostPublicationCommitted && backupDirectory && fs.existsSync(backupDirectory)) {
      const scope = await workflowScope(parentId, context).catch(() => null);
      if (scope && !fs.existsSync(scope.outputDirectory)) rollbackPersistentReplacements([{ destinationPath: scope.outputDirectory, backupPath: backupDirectory, directory: true }]);
    }
    if (stagingDirectory && !checkpointReady) await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    return { success: false, cancelled, resumable: checkpointReady, operationId, error: cancelled ? undefined : job.message };
  }
};
const generateWorkflow = (parentId, payload, context) => withProjectWorkflowOperation(context.projectId, () => generateWorkflowUnlocked(parentId, payload, context));

const workflowStatus = async (parentId, _payload, context) => {
  const key = String(context.projectId);
  const job = workflowJobs.get(key) || null;
  const reconciliation = await withDomain(parentId, db => {
    const row = db.prepare(`SELECT COUNT(*) pendingCount,MIN(pending.updated_at) oldestAt,MIN(CASE WHEN pending.next_attempt_at>0 THEN pending.next_attempt_at END) nextAttemptAt,MAX(pending.attempt_count) maxAttemptCount FROM team_workflow_reconcile_pending pending
      JOIN team_patch_tasks task ON task.project_id=pending.project_id AND task.id=pending.task_id
      JOIN team_retouch_photos registered ON registered.project_id=task.project_id AND registered.photo_id=task.photo_id AND registered.base_version_id=task.base_version_id
      WHERE pending.project_id=?`).get(String(context.projectId));
    const latest = db.prepare(`SELECT pending.last_error FROM team_workflow_reconcile_pending pending
      JOIN team_patch_tasks task ON task.project_id=pending.project_id AND task.id=pending.task_id
      JOIN team_retouch_photos registered ON registered.project_id=task.project_id AND registered.photo_id=task.photo_id AND registered.base_version_id=task.base_version_id
      WHERE pending.project_id=? ORDER BY pending.updated_at DESC LIMIT 1`).get(String(context.projectId));
    const outputPendingCount = Number(db.prepare("SELECT COUNT(*) count FROM team_output_outbox WHERE project_id=? AND state<>'completed'").get(String(context.projectId))?.count) || 0;
    const cleanupPendingCount = Number(db.prepare("SELECT COUNT(*) count FROM team_cleanup_outbox WHERE project_id=? AND state='pending'").get(String(context.projectId))?.count) || 0;
    return { state: Number(row?.pendingCount) ? 'preparing' : 'ready', pendingCount: Number(row?.pendingCount) || 0, outputPendingCount, cleanupPendingCount, maintenanceRequired: outputPendingCount > 0 || cleanupPendingCount > 0, oldestAt: Number(row?.oldestAt) || 0, nextAttemptAt: Number(row?.nextAttemptAt) || 0, maxAttemptCount: Number(row?.maxAttemptCount) || 0, lastError: String(latest?.last_error || '') };
  });
  if (!job) {
    const storage = await hostStorage(parentId); const recovered = await readJson(path.join(storage.dataPath, 'workflow-jobs', `${sha256(key)}.json`), null);
    return { success: true, job: recovered, reconciliation };
  }
  const host = await reportTask(parentId, job.operationId, 'status').catch(() => null);
  return { success: true, job: { ...job, task: host?.task || undefined }, reconciliation };
};

const cancelWorkflow = async (parentId, payload, context = {}) => {
  const operationId = String(payload.operationId || '');
  const projectId = String(context.projectId || '');
  const job = [...workflowJobs.values()].find(item => item.operationId === operationId && (!projectId || String(item.projectId || '') === projectId) && item.state === 'running');
  if (job) { job.cancelled = true; job.phase = 'cancelling'; job.message = '正在安全停止，已完成文件可续传'; }
  if (projectId) {
    await withDomain(parentId, db => db.prepare("UPDATE team_durable_operations SET cancel_requested=1,state=CASE WHEN state='accepted' THEN 'cancelled' ELSE state END,phase=CASE WHEN state='accepted' THEN 'cancelled' ELSE 'cancelling' END,updated_at=? WHERE project_id=? AND id=?")
      .run(Date.now(), projectId, operationId)).catch(() => undefined);
    const runningParentId = durableOperationParentIds.get(projectOperationKey(context, operationId));
    if (runningParentId) {
      activeRequestControls.get(runningParentId)?.abort(cancelledRequestError());
      for (const control of algorithmControlsByParent.get(runningParentId) || []) control.cancel();
    }
  }
  // Cancellation is a control-plane acknowledgement. Host task reporting must
  // never delay the caller or wait behind the operation being cancelled.
  void reportTask(parentId, operationId, 'cancel', job || {}).catch(() => undefined);
  return { success: true, cancelled: Boolean(job) };
};

const exportWorkflow = async (parentId, payload, context, open = false) => {
  let { outputDirectory, manifest, manifestPath } = await readWorkflowManifest(parentId, context);
  if (!manifest) throw new Error('请先生成工作流程');
  let group = (manifest.groups || []).find(item => Number(item.week) === Number(payload.week) && String(item.identityId || '') === String(payload.identityId || ''));
  const availableCount = () => (group?.items || []).filter(item => item.available && item.relativePath && isInside(outputDirectory, path.resolve(outputDirectory, item.relativePath)) && fs.existsSync(path.resolve(outputDirectory, item.relativePath))).length;
  let directory = path.resolve(outputDirectory, String(group?.relativePath || ''));
  const expectedAvailable = (group?.items || []).some(item => item.available);
  if (group?.relativePath && isInside(outputDirectory, directory) && (expectedAvailable && (!fs.existsSync(directory) || !availableCount()))) {
    if (open) {
      const taskIds = uniqueText((group.items || []).filter(item => item.available).map(item => item.taskId));
      await withDomain(parentId, db => {
        const insert = db.prepare(`INSERT INTO team_workflow_reconcile_pending(project_id,task_id,photo_id,error,attempt_count,next_attempt_at,last_error,history_json,updated_at) VALUES(?,?,?,?,0,0,'','[]',?)
          ON CONFLICT(project_id,task_id) DO UPDATE SET photo_id=excluded.photo_id,error=excluded.error,attempt_count=0,next_attempt_at=0,last_error='',history_json='[]',updated_at=excluded.updated_at`);
        for (const taskId of taskIds) {
          const task = db.prepare('SELECT photo_id FROM team_patch_tasks WHERE project_id=? AND id=? AND is_deleted=0').get(String(context.projectId), taskId);
          if (task) insert.run(String(context.projectId), taskId, task.photo_id, '用户打开任务文件夹，等待后台准备', Date.now());
        }
      });
      return { success: true, state: 'preparing', count: 0, pendingCount: taskIds.length, message: '任务文件夹需要重建' };
    }
  }
  if (!group?.relativePath || !isInside(outputDirectory, directory) || !fs.existsSync(directory)) throw new Error('任务文件夹不存在，且无法从当前工作图与返图记录安全重建');
  const count = availableCount();
  if (!count) throw new Error('本周任务仍在等待上一位返图');
  if (open) {
    const owned = findOwnedWorkflowOutput(group, manifest.outputOwnership);
    if (!owned) throw new Error('任务文件夹尚无可用的 Host ownership，请重新生成工作流程');
    await callHost(parentId, 'dialogs', { kind: 'openOutputDirectory', commitId: owned.ownership.commitId, artifactId: owned.ownership.artifactId });
  }
  return { success: true, count };
};

const reviewTargetForStorage = (storage, context) => {
  const projectId = String(storage.projectId || context?.projectId || '');
  if (!projectId) throw new Error('返图审核缺少项目 ID');
  const directory = path.join(storage.dataPath, 'workflow-return-reviews', sha256(projectId));
  return { directory, sessionPath: path.join(directory, 'session.json') };
};
const reviewTarget = async (parentId, context) => reviewTargetForStorage(await hostStorage(parentId), context);
const sweepRetiredReviewTargets = async target => {
  const parent = path.dirname(target.directory);
  const prefix = `${path.basename(target.directory)}.completed-`;
  const entries = await fs.promises.readdir(parent, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => fs.promises.rm(path.join(parent, entry.name), { recursive: true, force: true }).catch(() => undefined)));
};
const readReviewFromStorage = async (storage, context) => {
  const target = await reviewTargetForStorage(storage, context);
  await sweepRetiredReviewTargets(target);
  let session = await readJson(target.sessionPath, null);
  if (session && (Number(session.version) !== 2 || String(session.projectId || '') !== String(context.projectId))) throw new Error('返图审核记录不符合当前格式或项目绑定');
  if (session?.status === 'completed' || session?.status === 'discarded') {
    await retireReviewTarget({ ...target, session }).catch(() => undefined);
    session = null;
  }
  return { ...target, session };
};
const readReview = async (parentId, context) => readReviewFromStorage(await hostStorage(parentId), context);
const retireReviewTarget = async target => {
  if (!fs.existsSync(target.directory)) return { retired: true, cleanupPending: false };
  if (process.env.PHOTOFLOW_TEST_FAULT_REVIEW_RETIRE === String(target.session?.id || '') && !injectedTestFaults.has(`retire:${target.session.id}`)) {
    injectedTestFaults.add(`retire:${target.session.id}`);
    return { retired: false, cleanupPending: true, error: 'injected review retirement failure' };
  }
  const retiredDirectory = `${target.directory}.completed-${crypto.randomUUID()}`;
  try {
    withPersistentFileFence(() => fs.renameSync(target.directory, retiredDirectory));
    void fs.promises.rm(retiredDirectory, { recursive: true, force: true }).catch(() => undefined);
    return { retired: true, cleanupPending: false };
  } catch (error) { return { retired: false, cleanupPending: true, error: error.message || String(error) }; }
};
const publicMatch = ({ path: _path, patchPath: _patchPath, mediaPath: _mediaPath, originalPath: _originalPath, alternatives, ...item }) => ({ ...item, alternatives: (alternatives || []).map(({ path: _a, patchPath: _b, mediaPath: _c, originalPath: _d, ...alternative }) => alternative) });
const presentReview = session => ({ ...session.result, reviewSessionId: session.id, matches: (session.result?.matches || []).map(publicMatch) });

const selectReturns = async parentId => {
  const selected = await selectInputFiles(parentId, { title: '选择返图', multiple: true });
  return { success: true, cancelled: Boolean(selected.cancelled), files: (selected.inputs || []).map(item => item.token) };
};

const readyWorkflowCandidates = (snapshot, requested = []) => {
  const requestedKeys = new Set((requested || []).map(item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}:${item.taskId}`));
  const identities = new Map(snapshot.identities.map(item => [String(item.id), item]));
  const assignments = new Map(snapshot.assignments.map(item => [`${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`, item]));
  const candidates = [];
  for (const photo of snapshot.photos || []) for (const task of photo.tasks || []) for (const member of task.members) {
    const key = `${photo.photoId}:${photo.baseVersionId}:${Number(member.personIndex)}:${task.id}`;
    if (requestedKeys.size && !requestedKeys.has(key)) continue;
    const assignment = assignments.get(`${photo.photoId}:${photo.baseVersionId}:${Number(member.personIndex)}`);
    const identity = identities.get(String(assignment?.identityId || ''));
    if (!identity || assignment?.completed) continue;
    candidates.push({ taskId: task.id, photoId: photo.photoId, baseVersionId: photo.baseVersionId, personIndex: Number(member.personIndex), identityId: identity.id, photoName: photo.displayName, personName: identity.name, originalPath: photo.sourcePath, patchPath: task.editedPatchPath && fs.existsSync(task.editedPatchPath) ? task.editedPatchPath : task.patchPath });
  }
  return candidates.filter(item => item.patchPath && fs.existsSync(item.patchPath));
};

const readyWorkflowCandidateFromDb = (db, context, payload) => {
  const task = db.prepare(`SELECT task.* FROM team_patch_tasks task
    JOIN team_retouch_photos registered ON registered.project_id=task.project_id AND registered.photo_id=task.photo_id AND registered.base_version_id=task.base_version_id
    WHERE task.project_id=? AND task.id=? AND task.photo_id=? AND task.base_version_id=? AND task.is_deleted=0`)
    .get(String(context.projectId), String(payload.taskId || ''), String(payload.photoId || ''), String(payload.baseVersionId || ''));
  if (!task) return null;
  const personIndex = Number(payload.personIndex);
  const members = parseJson(task.members_json, []);
  if ((members.length ? members : [{ personIndex: task.person_index }]).every(member => Number(member.personIndex) !== personIndex)) return null;
  const assignment = db.prepare(`SELECT * FROM team_person_assignments
    WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`)
    .get(String(context.projectId), task.photo_id, task.base_version_id, personIndex);
  if (!assignment?.identity_id || assignment.completed || assignment.return_missing || assignment.task_id && String(assignment.task_id) !== String(task.id)) return null;
  const identity = db.prepare('SELECT id,name FROM team_person_identities WHERE id=? AND project_id=?').get(String(assignment.identity_id), String(context.projectId));
  if (!identity) return null;
  const patchPath = task.edited_patch_path && fs.existsSync(task.edited_patch_path) ? task.edited_patch_path : task.patch_path;
  if (!patchPath || !fs.existsSync(patchPath)) return null;
  return { taskId: task.id, photoId: task.photo_id, baseVersionId: task.base_version_id, personIndex, identityId: identity.id, personName: identity.name, patchPath };
};

const runMatcher = async (parentId, returned, candidates, onProgress = () => undefined, signal = null) => {
  const manifestPath = path.join(path.dirname(returned[0].path), `match-${crypto.randomUUID()}.json`);
  await fs.promises.writeFile(manifestPath, JSON.stringify({ returned, candidates }), 'utf8');
  try {
    return await runAlgorithm(parentId, ['match-batch', '--manifest', manifestPath], { timeoutMs: 30 * 60 * 1000, signal, onProgress });
  } finally { await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined); }
};

const resolveWorkflowTaskBinding = (db, projectId, taskId, chain) => {
  const task = db.prepare(`SELECT task.* FROM team_patch_tasks task
    JOIN team_retouch_photos registered ON registered.project_id=task.project_id AND registered.photo_id=task.photo_id AND registered.base_version_id=task.base_version_id
    WHERE task.project_id=? AND task.id=? AND task.is_deleted=0`).get(String(projectId), String(taskId));
  if (!task) throw new Error('工作流程引用的修图任务不属于当前项目');
  if (chain.some(entry => String(entry.item.baseVersionId) !== String(task.base_version_id))) throw new Error('工作流程 task 链跨越了错误的照片版本');
  if (chain.some(entry => String(entry.item.photoId) !== String(task.photo_id))) throw new Error('工作流程 task 链跨越了错误的照片');
  return { task };
};

const reconcileWorkflowTaskChainUnlocked = async (parentId, context, taskId, existingDb = null) => {
  const scope = await readWorkflowManifest(parentId, context);
  if (!scope.manifest) return { reconciled: false, reason: 'workflow-missing' };
  const chain = [];
  for (const [groupIndex, group] of (scope.manifest.groups || []).entries()) for (const [itemIndex, item] of (group.items || []).entries()) if (String(item.taskId) === String(taskId)) chain.push({ group, item, groupIndex, itemIndex });
  chain.sort((a, b) => Number(a.group.week) - Number(b.group.week) || a.groupIndex - b.groupIndex || a.itemIndex - b.itemIndex);
  if (!chain.length) return { reconciled: false, reason: 'task-not-in-workflow' };
  const reconcile = async db => {
    const { task } = resolveWorkflowTaskBinding(db, context.projectId, taskId, chain);
    const artifactGrant = await artifactsScope(parentId, { photoId: task.photo_id, baseVersionId: task.base_version_id });
    const artifactRoots = [artifactGrant.storageRoot, artifactGrant.dataDirectory, artifactGrant.deliveryDirectory].filter(Boolean);
    const assertSource = sourcePath => {
      if (!sourcePath || !fs.existsSync(sourcePath)) return false;
      if (!artifactRoots.some(root => isInside(root, sourcePath))) throw new Error('工作流程输入超出组件授权目录');
      return true;
    };
    if (!assertSource(task.patch_path)) throw new Error('原始工作图不存在，无法重建任务链');
    let sourcePath = task.patch_path;
    let activeIndex = -1;
    const stages = [];
    for (const [index, entry] of chain.entries()) {
      const personIndex = Number(entry.item.personIndex);
      const assignment = db.prepare(`SELECT * FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`).get(String(context.projectId), task.photo_id, task.base_version_id, personIndex);
      const boundAssignment = assignment && (!assignment.task_id || String(assignment.task_id) === String(task.id)) ? assignment : null;
      let completed = Boolean(boundAssignment?.completed) && !Boolean(boundAssignment?.return_missing);
      let artifact = null;
      if (completed && ['returned', 'retouched'].includes(String(boundAssignment?.completion_kind || ''))) {
        artifact = boundAssignment.artifact_id
          ? db.prepare('SELECT * FROM team_task_artifacts WHERE project_id=? AND id=? AND task_id=? AND is_deleted=0').get(String(context.projectId), boundAssignment.artifact_id, task.id)
          : db.prepare('SELECT * FROM team_task_artifacts WHERE project_id=? AND task_id=? AND person_index=? AND is_deleted=0 ORDER BY created_at DESC,id DESC LIMIT 1').get(String(context.projectId), task.id, personIndex);
        if (!artifact || !assertSource(artifact.artifact_path)) {
          completed = false;
          db.prepare('UPDATE team_person_assignments SET return_missing=1,return_missing_since=COALESCE(return_missing_since,?),updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').run(Date.now(), Date.now(), String(context.projectId), task.photo_id, task.base_version_id, personIndex);
        }
      }
      stages.push({ entry, personIndex, completed, inputPath: sourcePath, artifact });
      const stage = db.prepare('SELECT id FROM team_task_stages WHERE project_id=? AND task_id=? AND person_index=?').get(String(context.projectId), task.id, personIndex);
      if (stage) db.prepare('UPDATE team_task_stages SET state=?,updated_at=? WHERE project_id=? AND id=?').run(completed ? 'complete' : activeIndex < 0 ? 'ready' : 'pending', Date.now(), String(context.projectId), stage.id);
      if (!completed) { if (activeIndex < 0) activeIndex = index; continue; }
      if (artifact) sourcePath = artifact.artifact_path;
    }
    if (activeIndex >= 0) {
      for (const [index, stage] of stages.entries()) {
        const stored = db.prepare('SELECT id FROM team_task_stages WHERE project_id=? AND task_id=? AND person_index=?').get(String(context.projectId), task.id, stage.personIndex);
        if (stored) db.prepare('UPDATE team_task_stages SET state=?,updated_at=? WHERE project_id=? AND id=?').run(index === activeIndex ? 'ready' : index < activeIndex ? 'complete' : 'pending', Date.now(), String(context.projectId), stored.id);
      }
    }
    let activeTarget = '';
    const activeSource = activeIndex >= 0 ? stages[activeIndex].inputPath : '';
    const priorOutputs = [];
    for (const [index, stage] of stages.entries()) {
      const relativePath = String(stage.entry.item.relativePath || '');
      if (relativePath) {
        const ownershipKey = `团片协作/${relativePath.replace(/\\/g, '/')}`; const priorOwnership = scope.manifest.outputOwnership?.[ownershipKey] || null;
        priorOutputs.push({ index, ownershipKey, relativePath: String(priorOwnership?.publishedRelativePath || ownershipKey), ownership: priorOwnership });
      }
      const currentTarget = relativePath ? path.resolve(scope.outputDirectory, relativePath) : '';
      if (!currentTarget || !isInside(scope.outputDirectory, currentTarget)) throw new Error('工作流程阶段路径超出授权输出目录');
      stage.entry.item.available = false;
      if (index === activeIndex) {
        const parsed = path.parse(currentTarget);
        activeTarget = path.join(parsed.dir, `${parsed.name}${path.extname(activeSource) || parsed.ext || '.png'}`);
        if (!isInside(scope.outputDirectory, activeTarget)) throw new Error('工作流程发布路径超出授权输出目录');
        if (path.resolve(activeTarget) !== path.resolve(currentTarget)) {
          if (revisionRequestContext.getStore()?.requestId) removePersistentPaths([currentTarget]);
          else await fs.promises.rm(currentTarget, { force: true }).catch(() => undefined);
        }
      } else {
        if (revisionRequestContext.getStore()?.requestId) removePersistentPaths([currentTarget]);
        else await fs.promises.rm(currentTarget, { force: true }).catch(() => undefined);
      }
    }
    if (activeIndex >= 0) {
      const sourceStat = await fs.promises.stat(activeSource);
      let reusable = false;
      try {
        const targetStat = await fs.promises.stat(activeTarget);
        reusable = targetStat.isFile() && targetStat.size === sourceStat.size && await fileSha256(activeTarget) === await fileSha256(activeSource);
      } catch { reusable = false; }
      if (!reusable) {
        if (revisionRequestContext.getStore()?.requestId) removePersistentPaths([activeTarget]);
        else await fs.promises.rm(activeTarget, { force: true }).catch(() => undefined);
        await copyFileAtomic(activeSource, activeTarget);
      }
      const active = stages[activeIndex].entry.item;
      active.relativePath = path.relative(scope.outputDirectory, activeTarget).replace(/\\/g, '/');
      active.available = true;
    }
    const ownership = { ...(scope.manifest.outputOwnership || {}) };
    const committedPublications = [];
    const activeOwnershipKey = activeIndex >= 0 ? `团片协作/${stages[activeIndex].entry.item.relativePath}` : '';
    if (activeIndex >= 0) {
      const priorEntry = priorOutputs.find(item => item.ownershipKey === activeOwnershipKey); const prior = priorEntry?.ownership || ownership[activeOwnershipKey] || null;
      const activePublishedPath = String(prior?.publishedRelativePath || activeOwnershipKey);
      const activeDigest = await fileSha256(activeTarget);
      if (!prior || String(prior.sha256 || '').toLowerCase() !== activeDigest.toLowerCase()) {
        const relayContinuation = { version: 1, kind: 'relay-output', projectId: String(context.projectId), preHostLocalEffects: 'workflow-current-mutated', manifestPath: scope.manifestPath, activeRelativePath: activeOwnershipKey, publishedRelativePath: activePublishedPath, manifest: scope.manifest };
        const committed = await publishProjectFile(parentId, activeTarget, activePublishedPath, `relay-${sha256(`${task.id}\0${activeIndex}\0${activeDigest}\0${JSON.stringify(prior || null)}`).slice(0, 24)}`, prior, 'relay-output', relayContinuation);
        committedPublications.push(committed);
        const output = committed.outputs[0]; ownership[activeOwnershipKey] = { commitId: committed.commitId, artifactId: output.artifactId, sha256: output.sha256, publishedRelativePath: output.relativePath };
      }
    }
    for (const previous of priorOutputs) if (previous.ownershipKey !== activeOwnershipKey && previous.ownership) {
      try {
        await retryWorkflowOutputCleanup(parentId, await hostStorage(parentId), context, [{ relativePath: previous.relativePath, ...previous.ownership }]);
        const cleanup = await readJson(workflowCleanupReceiptPath(await hostStorage(parentId), context.projectId), { pending: [] });
        if (!(cleanup.pending || []).some(item => item.relativePath === previous.relativePath && item.artifactId === previous.ownership.artifactId)) delete ownership[previous.ownershipKey];
      } catch { /* receipt and ledger entry remain for a later drain */ }
    }
    scope.manifest.outputOwnership = ownership;
    await writeJsonAtomic(scope.manifestPath, scope.manifest);
    for (const committed of committedPublications) await completeOutputPublication(committed);
    return { reconciled: true, taskId: task.id, activePersonIndex: activeIndex >= 0 ? stages[activeIndex].personIndex : null, complete: activeIndex < 0 };
  };
  return existingDb ? reconcile(existingDb) : withDomain(parentId, reconcile);
};
const reconcileWorkflowTaskChain = (parentId, context, taskId, existingDb = null) => withProjectWorkflowOperation(context.projectId, () => reconcileWorkflowTaskChainUnlocked(parentId, context, taskId, existingDb));

const storeReturnedPatch = (parentId, sourcePath, payload, context) => withDomain(parentId, (db, storage) => storeReturnedPatchInDomain(db, storage, sourcePath, payload, context));

const retryPendingWorkflowReconciles = async (parentId, context, maxItems = 1, taskIds = []) => {
  const maintenanceStorage = await hostStorage(parentId);
  const restoredScope = await workflowScopeForStorage(maintenanceStorage, context);
  if (restoredScope.manifest?.recovery?.state === 'needs-republish') {
    const restoredManifest = JSON.parse(JSON.stringify(restoredScope.manifest)); delete restoredManifest.recovery;
    const restoreGeneration = sha256(`${context.projectId}\0${restoredManifest.fingerprint}`).slice(0, 20);
    const outputFiles = (restoredManifest.groups || []).flatMap(group => (group.items || []).filter(item => item.available && item.relativePath).map(item => ({ sourcePath: path.resolve(restoredScope.outputDirectory, item.relativePath), ownershipKey: `团片协作/${String(item.relativePath).replace(/\\/g, '/')}`, outputRelativePath: `团片协作/恢复-${restoreGeneration}/${String(item.relativePath).replace(/\\/g, '/')}` })));
    if (!outputFiles.length || outputFiles.some(item => !isInside(restoredScope.outputDirectory, item.sourcePath) || !fs.existsSync(item.sourcePath))) throw recoveryRequiredError('恢复的 workflow 缺少可重发布的当前私有文件');
    for (const file of outputFiles) { file.relativePath = path.relative(restoredScope.outputDirectory, file.sourcePath).replace(/\\/g, '/'); file.digest = await fileSha256(file.sourcePath); }
    const continuationPlan = { version: 1, kind: 'workflow-output', projectId: String(context.projectId), preHostLocalEffects: 'none', manifestPath: restoredScope.manifestPath, manifest: { ...restoredManifest, outputOwnership: {} }, workflowState: { generatedAt: Number(restoredManifest.generatedAt), fingerprint: String(restoredManifest.fingerprint) }, outputs: outputFiles.map(file => ({ outputRelativePath: file.outputRelativePath, ownershipKey: file.ownershipKey, relativePath: file.relativePath, digest: file.digest })), localSwap: { stagingDirectory: restoredScope.outputDirectory, outputDirectory: restoredScope.outputDirectory, swapToken: `restore-${restoreGeneration}`, backupDirectory: '' } };
    const committed = await publishProjectFiles(parentId, outputFiles, `restore-workflow-${sha256(`${context.projectId}\0${restoredManifest.fingerprint}`).slice(0, 32)}`, new Map(), continuationPlan);
    restoredManifest.outputOwnership = Object.fromEntries((committed.outputs || []).map(item => [outputFiles.find(file => file.outputRelativePath === item.relativePath)?.ownershipKey || item.relativePath, { commitId: committed.commitId, artifactId: item.artifactId, sha256: item.sha256, publishedRelativePath: item.relativePath }]));
    await writeJsonAtomic(restoredScope.manifestPath, restoredManifest);
    await withDomain(parentId, db => db.prepare('INSERT INTO team_workflow_state(project_id,generated_at,fingerprint,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET generated_at=excluded.generated_at,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at').run(String(context.projectId), Number(restoredManifest.generatedAt), String(restoredManifest.fingerprint), Date.now()));
    await completeOutputPublication(committed);
  }
  await retryWorkflowOutputCleanup(parentId, maintenanceStorage, context).catch(() => undefined);
  await drainCleanupOutbox(maintenanceStorage.databasePath, context.projectId, 50).catch(() => undefined);
  const selectedTaskIds = uniqueText(Array.isArray(taskIds) ? taskIds : []).slice(0, 50);
  const taskFilter = selectedTaskIds.length ? ` AND pending.task_id IN (${selectedTaskIds.map(() => '?').join(',')})` : '';
  const pending = await withDomain(parentId, db => db.prepare(`SELECT pending.* FROM team_workflow_reconcile_pending pending
    JOIN team_patch_tasks task ON task.project_id=pending.project_id AND task.id=pending.task_id
    WHERE pending.project_id=? AND COALESCE(pending.next_attempt_at,0)<=?${taskFilter} ORDER BY COALESCE(pending.next_attempt_at,0),pending.updated_at LIMIT ?`).all(String(context.projectId), Date.now(), ...selectedTaskIds, Math.max(1, Number(maxItems) || 1)));
  let recovered = 0;
  for (const item of pending) await withPhotoOperation(projectOperationKey(context, item.photo_id), async () => {
    try {
      const reconciliation = await reconcileWorkflowTaskChain(parentId, context, item.task_id);
      if (!reconciliation.reconciled) throw new Error(`接力更新未完成：${reconciliation.reason || 'unknown'}`);
      await withDomain(parentId, db => db.prepare('DELETE FROM team_workflow_reconcile_pending WHERE project_id=? AND task_id=?').run(String(context.projectId), item.task_id));
      recovered += 1;
    } catch (error) {
      const message = String(error.message || error).slice(0, 500);
      const attemptCount = Math.max(1, Number(item.attempt_count) + 1);
      const nextAttemptAt = Date.now() + Math.min(5 * 60_000, 1000 * (2 ** Math.min(8, attemptCount - 1)));
      const history = [...parseJson(item.history_json, []), { at: Date.now(), attemptCount, error: message }].slice(-8);
      await withDomain(parentId, db => db.prepare('UPDATE team_workflow_reconcile_pending SET error=?,last_error=?,attempt_count=?,next_attempt_at=?,history_json=?,updated_at=? WHERE project_id=? AND task_id=?').run(message, message, attemptCount, nextAttemptAt, JSON.stringify(history), Date.now(), String(context.projectId), item.task_id)).catch(() => undefined);
    }
  });
  const remaining = await withDomain(parentId, db => db.prepare(`SELECT pending.error,pending.last_error,pending.attempt_count,pending.next_attempt_at,pending.updated_at FROM team_workflow_reconcile_pending pending
    WHERE pending.project_id=?${taskFilter} ORDER BY pending.updated_at DESC LIMIT 1`).get(String(context.projectId), ...selectedTaskIds));
  const pendingCount = await withDomain(parentId, db => Number(db.prepare(`SELECT COUNT(*) count FROM team_workflow_reconcile_pending pending
    WHERE pending.project_id=?${taskFilter}`).get(String(context.projectId), ...selectedTaskIds)?.count) || 0);
  return { success: true, state: pendingCount ? 'preparing' : 'ready', pendingCount, recoveredCount: recovered, attemptedCount: pending.length, deferredCount: Math.max(0, pendingCount - pending.length), attemptCount: Number(remaining?.attempt_count) || 0, nextAttemptAt: Number(remaining?.next_attempt_at) || 0, error: String(remaining?.last_error || '') };
};

const returnBatch = async (parentId, payload, context, workflowMode) => {
  const returnOperationId = String(payload.operationId || `returns-${crypto.randomUUID()}`);
  let lastProgress = 0;
  let materialized;
  let staged;
  let matcherProgressReports = Promise.resolve();
  const progressUpdate = (phase, progress, message, extra = {}) => ({ projectId: String(context.projectId), projectName: context.projectName, state: 'running', phase, progress, message, ...extra });
  const report = async (action, update) => {
    lastProgress = Math.max(lastProgress, Number(update.progress) || 0);
    return reportTask(parentId, returnOperationId, action, update, 'patch.return-batch.progress');
  };
  const throwIfCancelled = () => {
    if (context.signal?.aborted) throw Object.assign(new Error('返图处理已取消'), { code: CANCELLED_CODE });
  };
  try {
    await report('start', { kind: 'team-return-batch', title: '批量处理协作返图', ...progressUpdate('reading', 6, '正在读取协作任务') });
    const existing = workflowMode ? await readReview(parentId, context) : null;
    if (existing?.session) {
      if (String(existing.session.operationId || '') === returnOperationId) return presentReview(existing.session);
      throw new Error('还有一批返图等待确认，请先继续处理或放弃');
    }
    const snapshot = await workspaceSnapshot(parentId, context);
    throwIfCancelled();
    await report('report', progressUpdate('reading', 14, '正在整理可匹配的协作任务'));
    const requestedPaths = new Set(uniqueText(payload.relativePaths));
    let candidates = workflowMode ? readyWorkflowCandidates(snapshot, payload.items) : (snapshot.photos || []).filter(photo => !requestedPaths.size || requestedPaths.has(String(photo.relativePath || ''))).flatMap(photo => (photo.tasks || []).map(task => ({ taskId: task.id, photoId: photo.photoId, baseVersionId: photo.baseVersionId, personIndex: task.personIndex, photoName: photo.displayName, personName: task.personName, patchPath: task.editedPatchPath && fs.existsSync(task.editedPatchPath) ? task.editedPatchPath : task.patchPath })).filter(item => item.patchPath && fs.existsSync(item.patchPath)));
    if (!candidates.length) throw new Error('当前没有可接收返图的任务');
    await report('report', progressUpdate('reading', 20, `正在读取 ${candidates.length} 个任务的原图`));
    materialized = await materializeMediaForOperation(parentId, candidates.map(item => ({ photoId: item.photoId, versionId: item.baseVersionId })));
    const originals = new Map(materialized.items.map(item => [`${item.photo.id}:${item.versions[0]?.id}`, item.versions[0]?.filePath]));
    candidates = candidates.map(item => ({ ...item, originalPath: originals.get(`${item.photoId}:${item.baseVersionId}`) }));
    throwIfCancelled();
    await report('report', progressUpdate('reading', 28, '正在读取已选择的返图'));
    staged = await materializeInputStage(parentId, payload.returnedFiles || []);
    if (!staged.items.length) throw new Error('未收到可处理的返图');
    throwIfCancelled();
    await report('report', progressUpdate('matching', 38, `已读取 ${staged.items.length} 张返图，正在准备内容匹配`));
    let returnCheckpoint = {};
    if (payload.operationId) returnCheckpoint = await withDomain(parentId, db => parseJson(db.prepare('SELECT checkpoint_json FROM team_durable_operations WHERE project_id=? AND id=?').get(String(context.projectId), returnOperationId)?.checkpoint_json, {}));
    const returned = await Promise.all(staged.items.map(async (item, index) => ({ returnId: `${workflowMode ? 'workflow-' : ''}return-${index + 1}`, path: item.path, sourceName: item.name, inputName: path.basename(item.path), digest: await fileSha256(item.path) })));
    const resumed = []; const pendingReturned = [];
    for (const item of returned) {
      const prior = Object.values(returnCheckpoint.completed || {}).find(value => value?.digest === item.digest);
      if (prior) resumed.push({ ...prior, returnId: item.returnId, sourceName: item.sourceName, confidence: 'high', accepted: true, resumed: true });
      else pendingReturned.push(item);
    }
    const stagedSources = new Set(staged.items.map(item => path.resolve(item.path)));
    const returnedById = new Map(returned.map(item => [String(item.returnId), path.resolve(item.path)]));
    const candidateTuples = new Set(candidates.map(item => `${item.taskId}\0${item.photoId}\0${item.baseVersionId}\0${Number(item.personIndex)}`));
    const matched = pendingReturned.length ? await runMatcher(parentId, pendingReturned, candidates, message => {
      const matcherProgress = Math.max(0, Math.min(100, Number(message.progress) || 0));
      matcherProgressReports = matcherProgressReports.catch(() => undefined).then(() => report('report', progressUpdate('matching', 40 + matcherProgress * 0.42, String(message.message || '正在比对返图内容')))).catch(() => undefined);
    }, context.signal) : { matches: [] };
    await matcherProgressReports;
    throwIfCancelled();
    for (const match of matched.matches || []) {
      const source = path.resolve(String(match.path || ''));
      if (!returnedById.has(String(match.returnId)) || returnedById.get(String(match.returnId)) !== source || !stagedSources.has(source)) throw new Error('Matcher returned a path outside the staged return set');
      if (match.taskId && !candidateTuples.has(`${match.taskId}\0${match.photoId}\0${match.baseVersionId}\0${Number(match.personIndex)}`)) throw new Error('Matcher returned a candidate tuple outside the original candidate set');
    }
    await report('report', progressUpdate('matching', 82, '内容匹配完成，正在整理结果'));
    const accepted = [...resumed];
    const high = (matched.matches || []).filter(item => item.confidence === 'high' && item.taskId);
    for (const [index, match] of high.entries()) {
      throwIfCancelled();
      if (!stagedSources.has(path.resolve(match.path))) throw new Error('Matched return escaped its component staging grant');
      const returnDigest = await fileSha256(match.path);
      const registered = await withPhotoOperation(projectOperationKey(context, match.photoId), () => storeReturnedPatch(parentId, match.path, { photoId: match.photoId, baseVersionId: match.baseVersionId, taskId: match.taskId, personIndex: match.personIndex, complete: workflowMode, deferReconcile: true, matchConfidence: match.matchConfidence, editEvidence: match.editEvidence, returnWarnings: match.returnWarnings }, context));
      accepted.push({ ...match, path: undefined, patchPath: undefined, accepted: true, reconcilePending: Boolean(registered.reconcilePending), warning: registered.warning });
      if (payload.operationId) await withDomain(parentId, db => {
        const row = db.prepare('SELECT checkpoint_json FROM team_durable_operations WHERE project_id=? AND id=?').get(String(context.projectId), returnOperationId);
        const checkpoint = parseJson(row?.checkpoint_json, {}); const completed = { ...(checkpoint.completed || {}) };
        const tuple = `${match.taskId}\0${match.photoId}\0${match.baseVersionId}\0${Number(match.personIndex)}`;
        completed[`${returnDigest}\0${tuple}`] = { digest: returnDigest, taskId: match.taskId, photoId: match.photoId, baseVersionId: match.baseVersionId, personIndex: Number(match.personIndex) };
        returnCheckpoint = { ...checkpoint, completed };
        db.prepare('UPDATE team_durable_operations SET checkpoint_json=?,phase=?,progress=?,updated_at=? WHERE project_id=? AND id=?').run(JSON.stringify(returnCheckpoint), 'importing', 82 + 12 * (index + 1) / Math.max(1, high.length), Date.now(), String(context.projectId), returnOperationId);
      });
      await report('report', progressUpdate('importing', 82 + 12 * (index + 1) / Math.max(1, high.length), `正在归档返图 ${index + 1}/${high.length}`));
    }
    const acceptedById = new Map(accepted.map(item => [String(item.returnId), item]));
    let matches = [...resumed, ...(matched.matches || []).map(item => acceptedById.get(String(item.returnId)) || { ...item, path: undefined, patchPath: undefined, accepted: false })];
    matches = matches.map(publicMatch);
    const reconcilePending = accepted.some(item => item.reconcilePending);
    const result = { success: true, matches, merges: [], returnedCount: returned.length, candidateCount: candidates.length, acceptedCount: accepted.length, reviewCount: matches.filter(item => !item.accepted).length, missingTaskCount: Math.max(0, candidates.length - accepted.length), mergedCount: 0, reconcilePending, warning: reconcilePending ? '部分返图已安全归档，工作流程目录将在下次加载时自动修复，无需重复上传' : undefined };
    let finalResult = result;
    if (workflowMode && result.reviewCount) {
      await report('report', progressUpdate('review', 96, `正在保存 ${result.reviewCount} 张待确认返图`));
      const target = await reviewTarget(parentId, context);
      const reviewId = crypto.randomUUID();
      const pending = `${target.directory}.staging-${reviewId}`;
      await fs.promises.mkdir(path.dirname(target.directory), { recursive: true });
      try {
        await fs.promises.mkdir(pending, { recursive: false });
        matches = await Promise.all((matched.matches || []).map(async (match, index) => {
          const source = path.resolve(String(match.path || ''));
          const storedName = `${safeSegment(match.returnId, String(index + 1))}${path.extname(source)}`;
          await fs.promises.copyFile(source, path.join(pending, storedName), fs.constants.COPYFILE_EXCL);
          return { ...match, path: path.join(target.directory, storedName), patchPath: undefined, accepted: Boolean(acceptedById.get(String(match.returnId))) };
        }));
        const session = { version: 2, id: reviewId, operationId: returnOperationId, projectId: String(context.projectId), createdAt: Date.now(), updatedAt: Date.now(), result: { ...result, reviewSessionId: reviewId, matches } };
        await fs.promises.writeFile(path.join(pending, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
        replacePersistentFromStage(pending, target.directory, reviewId);
        finalResult = presentReview(session);
      } catch (error) { await fs.promises.rm(pending, { recursive: true, force: true }).catch(() => undefined); throw error; }
    }
    await report('complete', { state: 'completed', phase: 'complete', progress: 100, message: '返图处理完成' }).catch(() => undefined);
    return finalResult;
  } catch (error) {
    const cancelled = context.signal?.aborted || error?.code === CANCELLED_CODE;
    await report(cancelled ? 'cancel' : 'failed', { state: cancelled ? 'cancelled' : 'failed', phase: cancelled ? 'cancelled' : 'failed', progress: lastProgress, message: cancelled ? '返图处理已取消' : `返图处理失败：${error.message || String(error)}`, error: cancelled ? '' : error.message || String(error) }).catch(() => undefined);
    throw error;
  } finally {
    if (staged) await discardInputStage(staged.stageId).catch(() => undefined);
    if (materialized) await materialized.cleanup();
  }
};

const recoverReviewConfirmations = async (storage, target) => {
  if (!target.session) return { session: null, recoveredCount: 0, cleanupPending: false };
  const db = ensureSchema(storage.databasePath);
  let confirmations;
  try { confirmations = db.prepare('SELECT * FROM team_workflow_review_confirmations WHERE project_id=? AND review_session_id=? ORDER BY created_at,return_id').all(String(storage.projectId), String(target.session.id)); }
  finally { db.close(); }
  let recoveredCount = 0;
  for (const confirmation of confirmations) {
    const match = (target.session.result?.matches || []).find(item => String(item.returnId) === String(confirmation.return_id));
    if (!match || match.accepted) continue;
    Object.assign(match, { accepted: true, confidence: 'manual', relayState: 'preparing', photoId: confirmation.photo_id, baseVersionId: confirmation.base_version_id, taskId: confirmation.task_id, personIndex: confirmation.person_index });
    recoveredCount += 1;
  }
  if (!recoveredCount) return { session: target.session, recoveredCount: 0, cleanupPending: false };
  target.session.updatedAt = Date.now();
  target.session.result.reviewCount = target.session.result.matches.filter(item => !item.accepted).length;
  target.session.result.acceptedCount = target.session.result.matches.filter(item => item.accepted).length;
  if (process.env.PHOTOFLOW_TEST_FAULT_REVIEW_SESSION_AFTER_COMMIT === String(target.session.id) && !injectedTestFaults.has(target.session.id)) {
    injectedTestFaults.add(target.session.id);
    throw new Error('injected review session write failure after COMMIT');
  }
  if (target.session.result.reviewCount) {
    await writeJsonAtomic(target.sessionPath, target.session);
    return { session: target.session, recoveredCount, cleanupPending: false };
  }
  target.session.status = 'completed';
  await writeJsonAtomic(target.sessionPath, target.session);
  const retired = await retireReviewTarget(target);
  return { session: null, recoveredCount, cleanupPending: retired.cleanupPending };
};
const reviewGet = async (parentId, _payload, context) => {
  const storage = await hostStorage(parentId);
  const initial = await readReviewFromStorage(storage, context);
  if (!initial.session) return { success: true, review: null };
  return withReviewSessionOperation(projectOperationKey(context, initial.session.id), async () => {
    const target = await readReviewFromStorage(storage, context);
    const recovered = await recoverReviewConfirmations(storage, target);
    const session = recovered.session;
    return { success: true, review: session ? presentReview(session) : null, recoveredCount: recovered.recoveredCount, cleanupPending: recovered.cleanupPending };
  });
};
const touchReviewState = (parentId, context) => withDomain(parentId, db => {
  db.exec('BEGIN IMMEDIATE');
  try { db.prepare('INSERT INTO team_review_state(project_id,updated_at) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET updated_at=excluded.updated_at').run(String(context.projectId), Date.now()); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
});
const reviewDiscard = (parentId, payload, context) => withReviewSessionOperation(projectOperationKey(context, payload.reviewSessionId), async () => {
  const target = await readReview(parentId, context);
  if (target.session && String(target.session.id) !== String(payload.reviewSessionId)) throw new Error('待确认返图批次已经变化');
  if (!target.session) return { success: true, discarded: false };
  target.session.status = 'discarded'; target.session.updatedAt = Date.now();
  await writeJsonAtomic(target.sessionPath, target.session);
  const retired = await retireReviewTarget(target);
  await touchReviewState(parentId, context);
  return { success: true, discarded: true, cleanupPending: retired.cleanupPending };
});
const reviewIgnore = (parentId, payload, context) => withReviewSessionOperation(projectOperationKey(context, payload.reviewSessionId), async () => {
  const target = await readReview(parentId, context);
  if (!target.session || String(target.session.id) !== String(payload.reviewSessionId)) throw new Error('待确认返图批次已经变化');
  const match = target.session.result.matches.find(item => String(item.returnId) === String(payload.returnId));
  if (!match || match.accepted) throw new Error('这张返图已经处理');
  target.session.result.matches = target.session.result.matches.filter(item => item !== match);
  target.session.result.reviewCount = target.session.result.matches.filter(item => !item.accepted).length;
  target.session.updatedAt = Date.now();
  if (target.session.result.reviewCount) await writeJsonAtomic(target.sessionPath, target.session);
  else { target.session.status = 'completed'; await writeJsonAtomic(target.sessionPath, target.session); }
  if (match.path && isInside(target.directory, match.path)) removePersistentPaths([match.path]);
  const retired = target.session.result.reviewCount ? { cleanupPending: false } : await retireReviewTarget(target);
  await touchReviewState(parentId, context);
  return { success: true, reviewSessionCompleted: !target.session.result.reviewCount, cleanupPending: retired.cleanupPending };
});
const returnConfirm = (parentId, payload, context) => withReviewSessionOperation(projectOperationKey(context, payload.reviewSessionId), async () => {
  const storage = await hostStorage(parentId);
  const target = await readReviewFromStorage(storage, context);
  const candidate = { photoId: String(payload.photoId), baseVersionId: String(payload.baseVersionId), taskId: String(payload.taskId), personIndex: Number(payload.personIndex) };
  const priorDb = ensureSchema(storage.databasePath);
  let prior;
  try { prior = priorDb.prepare('SELECT * FROM team_workflow_review_confirmations WHERE project_id=? AND review_session_id=? AND return_id=?').get(String(context.projectId), String(payload.reviewSessionId), String(payload.returnId)); }
  finally { priorDb.close(); }
  if (prior) {
    if (String(prior.task_id) !== candidate.taskId || String(prior.photo_id) !== candidate.photoId || String(prior.base_version_id) !== candidate.baseVersionId || Number(prior.person_index) !== candidate.personIndex) throw new Error('这张返图已确认到另一个任务');
    const recovered = target.session ? await recoverReviewConfirmations(storage, target).catch(() => ({ session: target.session, cleanupPending: true })) : { session: null, cleanupPending: false };
    return { success: true, idempotent: true, confirmationState: 'confirmed', relayState: 'preparing', reconcilePending: true, reviewSessionCompleted: !recovered.session, cleanupPending: recovered.cleanupPending, warning: '返图已确认；接力任务仍在准备中' };
  }
  if (!target.session || String(target.session.id) !== String(payload.reviewSessionId)) throw new Error('待确认返图批次已经变化');
  const match = target.session.result.matches.find(item => String(item.returnId) === String(payload.returnId));
  if (!match) throw new Error('这张返图已经处理');
  if (match.accepted) throw new Error('这张返图已经处理');
  if (String(target.session.projectId || '') !== String(context.projectId) || String(match.photoId || '') !== candidate.photoId || String(match.baseVersionId || '') !== candidate.baseVersionId || String(match.taskId || '') !== candidate.taskId || Number(match.personIndex) !== candidate.personIndex) throw new Error('返图审核 session 的项目、版本或候选 tuple 不匹配');
  if (!match.path || !isInside(target.directory, match.path)) throw new Error('Reviewed return escaped its component review grant');
  const registered = await withPhotoOperation(projectOperationKey(context, payload.photoId), async () => {
    const db = ensureSchema(storage.databasePath);
    try {
      const ready = readyWorkflowCandidateFromDb(db, context, payload);
      if (!ready || String(ready.taskId) !== candidate.taskId) throw new Error('候选任务当前不可确认');
      return await storeReturnedPatchInDomain(db, storage, match.path, { ...candidate, complete: true, deferReconcile: true, reviewSessionId: payload.reviewSessionId, returnId: payload.returnId }, context);
    } finally { db.close(); }
  });
  let recovered;
  try { recovered = await recoverReviewConfirmations(storage, target); }
  catch (error) {
    return { success: true, confirmationState: 'confirmed', relayState: 'preparing', reconcilePending: true, reviewSessionCompleted: false, cleanupPending: true, warning: `返图已确认；审核记录和接力任务将在后台恢复（${error.message || String(error)}）` };
  }
  return { success: true, confirmationState: 'confirmed', relayState: 'preparing', warning: registered.warning, reconcilePending: true, reviewSessionCompleted: !recovered.session, cleanupPending: recovered.cleanupPending };
});

const acceptDurableOperation = async (parentId, payload, context, kind, extra = {}) => {
  const startedAt = Date.now();
  const operationId = String(payload.operationId || crypto.randomUUID());
  const acceptedAt = Date.now();
  if (kind === 'return-batch' && Array.isArray(payload.returnedFiles)) durableOperationSecrets.set(projectOperationKey(context, operationId), { returnedFiles: [...payload.returnedFiles], expiresAt: acceptedAt + 30_000 });
  const accepted = await withDomain(parentId, db => {
    const existing = db.prepare('SELECT * FROM team_durable_operations WHERE id=? AND project_id=?').get(operationId, String(context.projectId));
    if (existing) {
      if (['completed','cancelled','failed'].includes(String(existing.state))) durableOperationSecrets.delete(projectOperationKey(context, operationId));
      return { success: true, accepted: true, operationId, state: existing.state, phase: existing.phase, cacheHit: true, resumable: true, ...(kind === 'return-batch' ? { restartPolicy: 'reselect-to-resume', limitation: '返图选择凭据不跨进程保存；使用同一 operationId 重新选择后从持久 checkpoint 续跑' } : {}) };
    }
    const now = acceptedAt;
    const persistablePayload = { ...payload }; delete persistablePayload.returnedFiles; delete persistablePayload.acceptOnly;
    const baseRevision = Number(domainRevision(db, String(context.projectId))) || 0;
    db.prepare(`INSERT INTO team_durable_operations(id,project_id,kind,state,phase,request_json,base_revision,created_at,updated_at) VALUES(?,?,?,'accepted','accepted',?,?,?,?)`)
      .run(operationId, String(context.projectId), kind, JSON.stringify({ ...persistablePayload, operationId, ...extra }), baseRevision, now, now);
    return { success: true, accepted: true, operationId, state: 'accepted', phase: 'accepted', resumable: true, ...(kind === 'return-batch' ? { restartPolicy: 'reselect-to-resume', limitation: '返图选择凭据不跨进程保存；使用同一 operationId 重新选择后从持久 checkpoint 续跑' } : {}) };
  });
  migrationMetric(`team-operation-${kind}`, 'ack', startedAt, { ackMs: Date.now() - startedAt, itemCount: Array.isArray(payload.groups) ? payload.groups.reduce((count, group) => count + (group.items?.length || 0), 0) : Array.isArray(payload.items) ? payload.items.length : payload.photoId ? 1 : 0, cacheHit: accepted.cacheHit === true, outcome: accepted.state });
  return accepted;
};

const durableOperationSnapshot = row => row ? ({
  operationId: row.id, kind: row.kind, state: row.state, phase: row.phase, progress: Number(row.progress) || 0,
  checkpoint: parseJson(row.checkpoint_json, {}), result: parseJson(row.result_json, {}), error: row.error || '',
  cancelRequested: Boolean(row.cancel_requested), resumable: true, ...(row.kind === 'return-batch' ? { restartPolicy: 'reselect-to-resume', limitation: '返图选择凭据不跨进程保存；使用同一 operationId 重新选择后从持久 checkpoint 续跑' } : {}), createdAt: row.created_at, updatedAt: row.updated_at,
}) : null;

const runDurableOperationUnlocked = async (parentId, payload, context) => {
  const operationId = String(payload.operationId || '');
  const operationKey = projectOperationKey(context, operationId);
  const storage = await hostStorage(parentId); const db = ensureSchema(storage.databasePath);
  let row;
  try {
    row = db.prepare('SELECT * FROM team_durable_operations WHERE id=? AND project_id=?').get(operationId, String(context.projectId));
    if (!row) throw new Error('持久化操作不存在或不属于当前项目');
    if (['completed','cancelled'].includes(row.state)) return { ...parseJson(row.result_json, {}), success: row.state === 'completed', cancelled: row.state === 'cancelled', operationId, operation: durableOperationSnapshot(row) };
    if (row.cancel_requested) return { success: false, cancelled: true, operationId };
    db.prepare("UPDATE team_durable_operations SET state='running',phase='running',updated_at=? WHERE project_id=? AND id=?").run(Date.now(), String(context.projectId), operationId);
  } finally { db.close(); }
  const request = parseJson(row.request_json, {});
  if (request.expectedRevision === undefined) request.expectedRevision = String(row.base_revision);
  if (row.kind === 'return-batch') {
    const secret = durableOperationSecrets.get(operationKey);
    if (!secret || secret.expiresAt <= Date.now()) throw Object.assign(new Error('返图选择授权已过期；请重新选择返图'), { code: 'COMPONENT_INPUT_RESELECTION_REQUIRED', retryable: true });
    request.returnedFiles = secret.returnedFiles;
  }
  durableOperationParentIds.set(operationKey, String(parentId));
  try {
    await updateRevisionGuardExpected(parentId, context, request.expectedRevision);
    let result;
    if (row.kind === 'workflow-generate') result = await generateWorkflow(parentId, request, context);
    else if (row.kind === 'return-batch') result = await returnBatch(parentId, request, context, request.workflowMode === true);
    else if (row.kind === 'merge') result = await withPhotoOperation(projectOperationKey(context, request.photoId), () => mergePatches(parentId, request, context));
    else if (row.kind === 'detect') result = await withPhotoOperation(projectOperationKey(context, request.photoId), () => detectPhoto(parentId, request, context));
    else if (row.kind === 'detect-batch') result = await detectBatch(parentId, request, context);
    else if (row.kind === 'identity-suggest') result = await suggestIdentities(parentId, request, context);
    else if (row.kind === 'patch-update') result = await withPhotoOperation(projectOperationKey(context, request.photoId), () => updatePatch(parentId, request, context));
    else if (row.kind === 'person-exclude') result = await withPhotoOperation(projectOperationKey(context, request.photoId), () => excludePerson(parentId, request, context));
    else if (row.kind === 'advanced-lifecycle') {
      if (request.action === 'preflight') result = await lifecycleAction(parentId, 'preflight');
      else {
        result = await lifecycleAction(parentId, request.action);
        advancedRuntimeProbeCache = null;
        if (['install', 'repair'].includes(request.action)) {
          const probe = await advancedRuntimeStatus(parentId, { refresh: true, full: true });
          result = probe.advancedAvailable ? { ...result, advancedAvailable: true, state: 'ready' } : { ...result, success: false, state: probe.state, error: probe.advancedError || probe.message };
        }
      }
    }
    else throw new Error(`未知持久化操作类型：${row.kind}`);
    const cancellationDb = ensureSchema(storage.databasePath); let cancelRequested = false;
    try { cancelRequested = Boolean(cancellationDb.prepare('SELECT cancel_requested FROM team_durable_operations WHERE project_id=? AND id=?').get(String(context.projectId), operationId)?.cancel_requested); } finally { cancellationDb.close(); }
    const cancelled = result?.cancelled || cancelRequested || context.signal?.aborted;
    const finalState = cancelled ? 'cancelled' : result?.requiresConfirmation ? 'accepted' : result?.success === false ? 'failed' : 'completed';
    const finalDb = ensureSchema(storage.databasePath);
    try { finalDb.prepare('UPDATE team_durable_operations SET state=?,phase=?,progress=?,result_json=?,error=?,updated_at=? WHERE project_id=? AND id=?').run(finalState, result?.requiresConfirmation ? 'confirmation' : finalState, finalState === 'completed' ? 100 : 0, JSON.stringify(result || {}), String(result?.error || ''), Date.now(), String(context.projectId), operationId); }
    finally { finalDb.close(); }
    return { ...result, operationId };
  } catch (error) {
    const failedDb = ensureSchema(storage.databasePath);
    const cancelled = error?.code === CANCELLED_CODE || context.signal?.aborted;
    try { failedDb.prepare("UPDATE team_durable_operations SET state=?,phase=?,error=?,updated_at=? WHERE project_id=? AND id=?").run(cancelled ? 'cancelled' : 'failed', cancelled ? 'cancelled' : 'failed', cancelled ? '' : error.message || String(error), Date.now(), String(context.projectId), operationId); }
    finally { failedDb.close(); }
    throw error;
  } finally { durableOperationParentIds.delete(operationKey); durableOperationSecrets.delete(operationKey); }
};
const runDurableOperation = (parentId, payload, context) => withKeyedOperation(durableOperationRuns, projectOperationKey(context, payload.operationId), () => runDurableOperationUnlocked(parentId, payload, context));

const acceptAdvancedLifecycle = (parentId, payload, action) => {
  const operationId = String(payload.operationId || `advanced-${crypto.randomUUID()}`);
  const existing = advancedLifecycleRecords.get(operationId);
  if (!existing) advancedLifecycleRecords.set(operationId, { operationId, kind: 'advanced-lifecycle', parentId: String(parentId), action, state: 'accepted', phase: 'accepted', progress: 0, result: {}, error: '', createdAt: Date.now(), updatedAt: Date.now() });
  return { success: true, accepted: true, operationId, state: existing?.state || 'accepted', phase: existing?.phase || 'accepted', scope: 'application.settings' };
};
const runAdvancedLifecycle = async (parentId, payload, context) => {
  const operationId = String(payload.operationId || '');
  const record = advancedLifecycleRecords.get(operationId);
  if (!record) throw Object.assign(new Error('高级环境操作不存在'), { code: 'COMPONENT_OPERATION_NOT_FOUND' });
  return withKeyedOperation(advancedLifecycleRuns, 'application.settings', async () => {
    assertNotAborted(context.signal);
    if (record.state === 'completed') return { ...record.result, operationId, operation: { ...record } };
    record.state = 'running'; record.phase = record.action; record.updatedAt = Date.now();
    try {
      let result;
      if (record.action === 'preflight') result = await lifecycleAction(parentId, 'preflight');
      else {
        result = await lifecycleAction(parentId, record.action);
        advancedRuntimeProbeCache = null;
        if (['install', 'repair'].includes(record.action)) {
          const probe = await advancedRuntimeStatus(parentId, { refresh: true, full: true });
          result = probe.advancedAvailable ? { ...result, advancedAvailable: true, state: 'ready' } : { ...result, success: false, state: probe.state, error: probe.advancedError || probe.message };
        }
      }
      record.result = result || {}; record.state = result?.success === false ? 'failed' : 'completed'; record.phase = record.state; record.progress = record.state === 'completed' ? 100 : 0; record.error = String(result?.error || ''); record.updatedAt = Date.now();
      return { ...result, operationId, operation: { ...record } };
    } catch (error) {
      record.state = context.signal?.aborted ? 'cancelled' : 'failed'; record.phase = record.state; record.error = String(error.message || error); record.updatedAt = Date.now(); throw error;
    }
  }, context.signal);
};

const getDurableOperation = (parentId, payload, context) => withDomain(parentId, db => {
  const row = db.prepare('SELECT * FROM team_durable_operations WHERE id=? AND project_id=?').get(String(payload.operationId || ''), String(context.projectId));
  return { success: true, operation: durableOperationSnapshot(row) };
});

const cancelDurableOperation = async (parentId, payload, context) => {
  const operationId = String(payload.operationId || '');
  const advanced = advancedLifecycleRecords.get(operationId);
  if (advanced) {
    advanced.state = advanced.state === 'accepted' ? 'cancelled' : 'cancelling'; advanced.phase = advanced.state; advanced.updatedAt = Date.now();
    activeRequestControls.get(String(advanced.parentId || ''))?.abort(cancelledRequestError());
    return { success: true, operationId, cancelRequested: true, state: advanced.state, scope: 'application.settings' };
  }
  const operationKey = projectOperationKey(context, operationId);
  await withDomain(parentId, db => db.prepare("UPDATE team_durable_operations SET cancel_requested=1,state=CASE WHEN state='accepted' THEN 'cancelled' ELSE state END,phase=CASE WHEN state='accepted' THEN 'cancelled' ELSE 'cancelling' END,updated_at=? WHERE id=? AND project_id=?").run(Date.now(), operationId, String(context.projectId)));
  const runningParentId = durableOperationParentIds.get(operationKey);
  if (runningParentId) {
    activeRequestControls.get(runningParentId)?.abort();
    for (const control of algorithmControlsByParent.get(runningParentId) || []) control.cancel();
    for (const [capabilityId, pending] of pendingCapabilities) if (pending.parentId === runningParentId) { pendingCapabilities.delete(capabilityId); pending.reject(Object.assign(new Error('团片 operation 已请求取消'), { code: CANCELLED_CODE })); }
  }
  await cancelWorkflow(parentId, { operationId }, context).catch(() => undefined);
  if (!runningParentId) durableOperationSecrets.delete(operationKey);
  return { success: true, operationId, cancelRequested: true, state: runningParentId ? 'cancel-requested' : 'cancelled' };
};

const MUTATING_METHODS = new Set([
  'team.workflow.reconcile-drain.v1',
  'team.project.register.v1','team.project.remove-photo.v1','team.identity.save.v1','team.identity.assign.v1','team.identity.confirm-group.v1','team.identity.delete.v1','team.identity.suggest.v1',
  'team.person.exclude.v1','team.patch.detect.v1','team.patch.detect-batch.v1','team.patch.update.v1','team.patch.delete.v1','team.patch.cleanup.v1','team.patch.upload.v1','team.patch.remove-upload.v1','team.patch.merge.v1',
  'team.identity.complete.v1','team.workflow.settings.save.v1','team.workflow.generate.v1','team.workflow.open-export.v1','team.workflow.return-batch.v1','team.workflow.return-confirm.v1','team.patch.return-batch.v1','team.operation.run.v1',
  'team.workflow.return-review.discard.v1','team.workflow.return-review.ignore.v1',
]);
const REVISION_LEASE_TTL_MS = Math.max(100, Number(process.env.PHOTOFLOW_TEST_REVISION_LEASE_TTL_MS) || 45_000);
const REVISION_LEASE_RENEW_MS = Math.max(25, Math.min(REVISION_LEASE_TTL_MS / 2, Number(process.env.PHOTOFLOW_TEST_REVISION_LEASE_RENEW_MS) || 10_000));
const readDomainRevision = (parentId, context) => withDomain(parentId, db => domainRevision(db, String(context.projectId)));
const revisionLeaseLostError = cause => Object.assign(new Error('团片写入租约已失效，请安全重试'), { code: 'COMPONENT_BUSY', retryable: true, cause });
const markRevisionLeaseLost = (requestId, cause) => {
  const state = projectRevisionLeaseStates.get(String(requestId));
  if (!state || state.lost) return;
  state.lost = true; state.error = revisionLeaseLostError(cause);
  activeRequestControls.get(String(state.parentId))?.abort(state.error);
};
const assertCurrentRevisionLease = async () => {
  const requestId = String(revisionRequestContext.getStore()?.requestId || '');
  if (!requestId) return;
  const state = projectRevisionLeaseStates.get(requestId);
  if (!state || state.lost) throw state?.error || revisionLeaseLostError();
  let db;
  try {
    db = new DatabaseSync(state.databasePath);
    db.exec(`PRAGMA busy_timeout=${DB_BUSY_TIMEOUT_MS}`);
    const lease = db.prepare('SELECT 1 ok FROM team_project_revision_leases WHERE project_id=? AND request_id=? AND expires_at>?').get(state.projectId, requestId, Date.now());
    if (!lease) { markRevisionLeaseLost(requestId); throw projectRevisionLeaseStates.get(requestId)?.error || revisionLeaseLostError(); }
  } catch (error) {
    markRevisionLeaseLost(requestId, error);
    throw projectRevisionLeaseStates.get(requestId)?.error || revisionLeaseLostError(error);
  } finally { try { db?.close(); } catch { /* best-effort read handle cleanup */ } }
};
const renewRevisionLease = async (parentId, context, requestId) => {
  try {
    if (process.env.PHOTOFLOW_TEST_REVISION_LEASE_RENEW_FAULT === 'sqlite') throw new Error('injected revision lease SQLite failure');
    const changes = await withDomain(parentId, db => db.prepare('UPDATE team_project_revision_leases SET expires_at=? WHERE project_id=? AND request_id=? AND expires_at>?')
      .run(Date.now() + REVISION_LEASE_TTL_MS, String(context.projectId), String(requestId), Date.now()).changes);
    if (changes !== 1) throw revisionLeaseLostError();
  } catch (error) { markRevisionLeaseLost(requestId, error); throw projectRevisionLeaseStates.get(String(requestId))?.error || revisionLeaseLostError(error); }
};
const prepareRevisionGuard = async (parentId, payload, context, requestId) => {
  assertNotAborted(context.signal);
  const storage = await hostStorage(parentId);
  assertNotAborted(context.signal);
  let db = revisionControlDatabases.get(storage.databasePath);
  if (!db) { db = ensureSchema(storage.databasePath); revisionControlDatabases.set(storage.databasePath, db); trimDatabaseCache(revisionControlDatabases); }
  try {
  const projectId = String(context.projectId);
  const expected = payload.expectedRevision === undefined || payload.expectedRevision === '' ? -1 : Number(payload.expectedRevision);
  if (!Number.isSafeInteger(expected) || expected < -1) throw Object.assign(new Error('团片 revision 无效，请刷新后重试'), { code: 'COMPONENT_HOST_CONFLICT', retryable: true });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM team_project_revision_leases WHERE expires_at<?').run(Date.now());
    try { db.prepare('INSERT INTO team_project_revision_leases(project_id,request_id,expires_at) VALUES(?,?,?)').run(projectId, String(requestId), Date.now() + REVISION_LEASE_TTL_MS); }
    catch (error) { throw Object.assign(new Error('同一项目已有写入操作，请稍后重试'), { code: 'COMPONENT_BUSY', retryable: true, cause: error }); }
    db.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,0) ON CONFLICT(project_id) DO NOTHING').run(projectId);
    const actual = Number(domainRevision(db, projectId));
    if (expected >= 0 && expected !== actual) throw Object.assign(new Error('团片数据已被其他操作更新，请刷新后重试'), { code: 'COMPONENT_HOST_CONFLICT', retryable: true });
    // Acquiring the project lease is not a domain mutation. The first guarded
    // domain-table write advances the revision atomically through the triggers.
    db.prepare('INSERT OR REPLACE INTO team_revision_guards(request_id,project_id,expected_revision,bumped,created_at) VALUES(?,?,?,?,?)').run(String(requestId), projectId, expected, 0, Date.now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { /* shared revision-control connection */ }
  projectRevisionLeaseStates.set(String(requestId), { parentId: String(parentId), projectId: String(context.projectId), databasePath: storage.databasePath, lost: false, error: null });
  const heartbeat = setInterval(() => renewRevisionLease(parentId, context, requestId).catch(() => undefined), REVISION_LEASE_RENEW_MS);
  heartbeat.unref?.();
  projectRevisionLeaseHeartbeats.set(String(requestId), heartbeat);
};
const updateRevisionGuardExpected = (parentId, context, expectedRevision) => {
  if (expectedRevision === undefined || expectedRevision === '') return Promise.resolve();
  const requestId = String(revisionRequestContext.getStore()?.requestId || '');
  return withDomain(parentId, db => {
    const expected = Number(expectedRevision); const actual = Number(domainRevision(db, String(context.projectId)));
    if (!Number.isSafeInteger(expected) || expected !== actual) throw Object.assign(new Error('团片数据已被其他操作更新，请刷新后重试'), { code: 'COMPONENT_HOST_CONFLICT', retryable: true });
    db.prepare('UPDATE team_revision_guards SET expected_revision=? WHERE request_id=? AND project_id=?').run(expected, requestId, String(context.projectId));
  });
};
const finishRevisionGuard = async (parentId, context, requestId) => {
  const heartbeat = projectRevisionLeaseHeartbeats.get(String(requestId));
  if (heartbeat) clearInterval(heartbeat);
  projectRevisionLeaseHeartbeats.delete(String(requestId));
  const state = projectRevisionLeaseStates.get(String(requestId));
  let db;
  try {
    const databasePath = state?.databasePath || (await hostStorage(parentId)).databasePath;
    db = revisionControlDatabases.get(databasePath) || new DatabaseSync(databasePath);
    db.exec(`PRAGMA busy_timeout=${DB_BUSY_TIMEOUT_MS}; BEGIN IMMEDIATE`);
    db.prepare('DELETE FROM team_revision_guards WHERE request_id=?').run(String(requestId));
    db.prepare('DELETE FROM team_project_revision_leases WHERE project_id=? AND request_id=?').run(String(context.projectId), String(requestId));
    db.exec('COMMIT');
    return domainRevision(db, String(context.projectId));
  } catch (error) { try { db?.exec('ROLLBACK'); } catch { /* transaction may not have started */ } throw error; }
  finally { projectRevisionLeaseStates.delete(String(requestId)); }
};
const normalizeRevisionError = error => {
  if (/TEAM_REVISION_CONFLICT/.test(String(error?.message || ''))) return Object.assign(new Error('团片数据已被其他操作更新，请刷新后重试'), { code: 'COMPONENT_HOST_CONFLICT', retryable: true });
  if (/TEAM_REVISION_LEASE_LOST/.test(String(error?.message || ''))) return revisionLeaseLostError(error);
  return error;
};
const restoreBusyReasons = () => {
  const reasons = [];
  if ([...workflowJobs.values()].some(job => job?.state === 'running')) reasons.push('workflow-job');
  if (photoOperations.size) reasons.push('photo-operation');
  if (reviewSessionOperations.size) reasons.push('review-operation');
  if (projectWorkflowOperations.size) reasons.push('workflow-operation');
  if (durableOperationRuns.size || durableOperationParentIds.size) reasons.push('durable-operation');
  if (activeAlgorithms.size) reasons.push('algorithm-process');
  if (unconfirmedAlgorithmTrees.size) reasons.push('unconfirmed-algorithm-tree');
  // The restore request itself is present in this map. Any additional request
  // means the Host barrier was violated or a detached request is still live.
  if (activeRequestControls.size > 1) reasons.push('rpc-request');
  return reasons;
};
const withRestoreLease = async (context, worker, busyReasons = restoreBusyReasons()) => {
  if (context?.componentBackupRestore !== true || context?.surface !== 'backup.restore') throw Object.assign(new Error('团片恢复方法仅允许 Host 备份恢复调度器调用'), { code: 'COMPONENT_RESTORE_FORBIDDEN' });
  if (restoreLeaseHeld || busyReasons.length) throw Object.assign(new Error(`团片组件仍有后台写入，暂不能恢复${busyReasons.length ? `（${busyReasons.join(', ')}）` : ''}`), { code: 'COMPONENT_BUSY', retryable: true });
  restoreLeaseHeld = true;
  try { return await worker(); }
  finally { restoreLeaseHeld = false; }
};
const restoreTokenFrom = payload => String(payload?.quiesceToken || payload?.holdToken || payload?.token || '');
const restoreBinding = (payload, mode) => `${mode}\0${String(payload?.operationId || '')}\0${String(payload?.targetWorkspace?.root || payload?.targetWorkspace?.dataRoot || '')}`;
const restoreStorageBinding = payload => {
  const storage = payload?.targetStorage || {}; const normalize = value => value ? path.resolve(String(value)) : '';
  return { databasePath: normalize(storage.databasePath), dataPath: normalize(storage.dataPath), controlPath: normalize(storage.controlPath) };
};
const bindRestoreStorage = (hold, incoming) => {
  for (const key of ['databasePath', 'dataPath', 'controlPath']) {
    const current = String(hold?.[key] || ''); const next = String(incoming?.[key] || '');
    if (current && next && current.toLowerCase() !== next.toLowerCase()) return false;
    if (!current && next) hold[key] = next;
  }
  hold.storageBound = Boolean(hold.databasePath || hold.dataPath || hold.controlPath);
  return true;
};
const closeDatabaseCachesForRestore = databasePath => {
  const resolved = databasePath ? path.resolve(String(databasePath)).toLowerCase() : '';
  for (const cache of [persistentFileFenceDatabases, revisionControlDatabases]) for (const [cachedPath, value] of cache) {
    if (resolved && path.resolve(cachedPath).toLowerCase() !== resolved) continue;
    try { (value?.db || value).close(); } catch { /* quiescent best-effort close */ }
    cache.delete(cachedPath);
  }
};
const withRestorePhase = async (context, payload, mode, worker) => {
  const phase = String(payload?.phase || 'standalone');
  if (phase === 'standalone') return withRestoreLease(context, async () => { closeDatabaseCachesForRestore(payload?.targetStorage?.databasePath); return worker(); });
  if (context?.componentBackupRestore !== true || context?.surface !== 'backup.restore') throw Object.assign(new Error('团片恢复方法仅允许 Host 备份恢复调度器调用'), { code: 'COMPONENT_RESTORE_FORBIDDEN' });
  if (phase === 'prepare') {
    const busy = restoreBusyReasons();
    if (restoreLeaseHeld || busy.length) throw Object.assign(new Error(`团片组件仍有后台写入，暂不能恢复${busy.length ? `（${busy.join(', ')}）` : ''}`), { code: 'COMPONENT_BUSY', retryable: true });
    const quiesceToken = crypto.randomUUID(); restoreLeaseHeld = true;
    const storage = restoreStorageBinding(payload);
    closeDatabaseCachesForRestore(storage.databasePath);
    restoreHold = { quiesceToken, mode, binding: restoreBinding(payload, mode), operationId: String(payload.operationId || ''), ...storage, storageBound: Boolean(storage.databasePath || storage.dataPath || storage.controlPath) };
    if (restoreHold.databasePath) schemaReadyPaths.delete(restoreHold.databasePath);
    return { schemaVersion: 1, operationId: restoreHold.operationId, status: 'prepared', quiesceToken };
  }
  const token = restoreTokenFrom(payload);
  const completed = completedRestoreHolds.get(token);
  if (!restoreHold && completed && completed.binding === restoreBinding(payload, mode) && (phase === 'finalize' || phase === 'rollback')) return { schemaVersion: 1, operationId: String(payload.operationId || ''), status: completed.status, idempotent: true };
  if (!restoreHold || restoreHold.quiesceToken !== token || restoreHold.mode !== mode || restoreHold.binding !== restoreBinding(payload, mode)) throw Object.assign(new Error('团片恢复 quiesce token 无效、跨操作或已释放'), { code: 'COMPONENT_RESTORE_HOLD_INVALID' });
  const incomingStorage = restoreStorageBinding(payload);
  const hasIncomingStorage = Boolean(incomingStorage.databasePath || incomingStorage.dataPath || incomingStorage.controlPath);
  if (hasIncomingStorage && !bindRestoreStorage(restoreHold, incomingStorage)) throw Object.assign(new Error('团片恢复目标存储在 quiesce 期间发生变化'), { code: 'COMPONENT_RESTORE_HOLD_INVALID' });
  if (phase === 'apply') {
    if (!restoreHold.databasePath || !restoreHold.dataPath || !restoreHold.controlPath) throw Object.assign(new Error('团片恢复 apply 缺少冻结的 Host 存储边界'), { code: 'COMPONENT_RESTORE_HOLD_INVALID' });
    schemaReadyPaths.delete(restoreHold.databasePath);
    return worker();
  }
  if (phase === 'finalize' || phase === 'rollback') {
    if (restoreHold.databasePath) schemaReadyPaths.delete(restoreHold.databasePath);
    const status = phase === 'rollback' ? 'rolled-back' : 'finalized';
    completedRestoreHolds.set(token, { binding: restoreHold.binding, status });
    while (completedRestoreHolds.size > 128) completedRestoreHolds.delete(completedRestoreHolds.keys().next().value);
    restoreHold = null; restoreLeaseHeld = false;
    return { schemaVersion: 1, operationId: String(payload.operationId || ''), status };
  }
  throw Object.assign(new Error(`团片恢复阶段不受支持：${phase}`), { code: 'COMPONENT_RESTORE_PHASE_UNSUPPORTED' });
};
const handlers = {
  'team.backup-restore.workspace.v1': async (parentId, payload, context) => withRestorePhase(context, payload, 'workspace', async () => {
    if (!context.componentVersion || String(payload.sourceVersion) !== String(context.componentVersion) || String(payload.targetVersion) !== String(context.componentVersion)) throw Object.assign(new Error('团片恢复要求 sourceVersion、targetVersion 与当前组件版本完全一致'), { code: 'COMPONENT_RESTORE_VERSION_MISMATCH' });
    const loaded = loadRestoreSources(payload);
    try {
      const source = selectRestoreSource(loaded.sources);
      if (!source?.path) throw Object.assign(new Error('团片工作区恢复格式不受支持'), { code: 'COMPONENT_RESTORE_FORMAT_UNSUPPORTED' });
      const databasePath = String(payload.targetStorage?.databasePath || '');
      if (!databasePath) throw new Error('团片工作区恢复缺少 Host 授权的目标组件存储');
      const result = restoreWorkspaceBundle({ source, sources: loaded.sources, destinationPath: databasePath, destinationDataPath: payload.targetStorage?.dataPath, payload, ensureSchema });
      return writeRestoreReceipt(payload, loaded.manifest, loaded.sources, result);
    } finally { loaded.cleanup?.(); }
  }),
  'team.backup-restore.project.v1': async (parentId, payload, context) => withRestorePhase(context, payload, 'project', async () => {
    if (!context.componentVersion || String(payload.sourceVersion) !== String(context.componentVersion) || String(payload.targetVersion) !== String(context.componentVersion)) throw Object.assign(new Error('团片恢复要求 sourceVersion、targetVersion 与当前组件版本完全一致'), { code: 'COMPONENT_RESTORE_VERSION_MISMATCH' });
    const loaded = loadRestoreSources(payload);
    try {
      const source = selectRestoreSource(loaded.sources);
      if (!source?.path) throw Object.assign(new Error('团片项目恢复格式不受支持'), { code: 'COMPONENT_RESTORE_FORMAT_UNSUPPORTED' });
      const databasePath = String(payload.targetStorage?.databasePath || '');
      if (!databasePath) throw new Error('团片项目恢复缺少 Host 授权的目标组件存储');
      const result = restoreProjectBundle({ source, sources: loaded.sources, destinationPath: databasePath, destinationDataPath: payload.targetStorage?.dataPath, payload, ensureSchema });
      return writeRestoreReceipt(payload, loaded.manifest, loaded.sources, result);
    } finally { loaded.cleanup?.(); }
  }),
  'team.project.get.v1': async (parentId, _payload, context) => {
    const startedAt = Date.now();
    const snapshot = publicWorkspace(await workspaceSnapshot(parentId, context));
    migrationMetric('team-project-get-v1', 'snapshot', startedAt, { itemCount: snapshot.photos?.length || 0, outcome: 'completed' });
    return snapshot;
  },
  'team.workflow.reconcile-drain.v1': (parentId, payload, context) => retryPendingWorkflowReconciles(parentId, context, Math.min(50, Math.max(1, Number(payload.maxItems) || 20)), payload.taskIds),
  'team.project.register.v1': async (parentId, payload, context) => {
    const relativePaths = uniqueText(payload.relativePaths);
    if (relativePaths.length > MAX_ITEMS) throw new Error(`Too many project media items: ${relativePaths.length}`);
    const media = await readMedia(parentId, { relativePaths });
    await withDomain(parentId, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const bundle of media.items || []) {
          const photoId = String(bundle.photo?.id || '');
          const base = (bundle.versions || []).find(version => String(version.id) === String(bundle.photo?.currentVersionId))
            || (bundle.versions || []).find(version => version.isCurrent) || (bundle.versions || []).at(-1);
          if (!photoId || !base?.id) throw new Error('无法登记缺少照片或当前版本的团片图片');
          registerPhoto(db, context, photoId, String(base.id), { displayName: bundle.photo?.displayName || bundle.photo?.originalName, relativePath: base.relativePath, relativePathState: base.relativePathState, fileMissing: base.fileMissing });
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    return publicWorkspace(await workspaceSnapshot(parentId, context));
  },
  'team.project.remove-photo.v1': (parentId, payload, context) => withPhotoOperation(projectOperationKey(context, payload.photoId), () => removeProjectPhoto(parentId, payload, context)),
  'team.identity.save.v1': saveIdentity,
  'team.identity.assign.v1': assignIdentity,
  'team.identity.confirm-group.v1': async (parentId, payload, context) => publicWorkspace(await confirmIdentityGroup(parentId, payload, context)),
  'team.identity.delete.v1': deleteIdentity,
  'team.person.exclude.v1': (parentId, payload, context) => payload.acceptOnly ? acceptDurableOperation(parentId, payload, context, 'person-exclude') : withPhotoOperation(projectOperationKey(context, payload.photoId), () => excludePerson(parentId, payload, context)),
  'team.patch.get.v1': getPatchBundle,
  'team.patch.detect.v1': (parentId, payload, context) => payload.acceptOnly ? acceptDurableOperation(parentId, payload, context, 'detect') : withPhotoOperation(projectOperationKey(context, payload.photoId), () => detectPhoto(parentId, payload, context)),
  'team.patch.detect-batch.v1': (parentId, payload, context) => payload.acceptOnly ? acceptDurableOperation(parentId, payload, context, 'detect-batch') : detectBatch(parentId, payload, context),
  'team.patch.update.v1': (parentId, payload, context) => payload.acceptOnly ? acceptDurableOperation(parentId, payload, context, 'patch-update') : withPhotoOperation(projectOperationKey(context, payload.photoId), () => updatePatch(parentId, payload, context)),
  'team.patch.delete.v1': (parentId, payload, context) => withPhotoOperation(projectOperationKey(context, payload.photoId), () => deletePatch(parentId, payload, context)),
  'team.patch.cleanup.v1': (parentId, payload, context) => withPhotoOperation(projectOperationKey(context, payload.photoId), () => cleanupPatches(parentId, payload, context)),
  'team.patch.upload.v1': (parentId, payload, context) => withPhotoOperation(projectOperationKey(context, payload.photoId), () => uploadPatch(parentId, payload, context)),
  'team.patch.remove-upload.v1': (parentId, payload, context) => withPhotoOperation(projectOperationKey(context, payload.photoId), () => removeUpload(parentId, payload, context)),
  'team.patch.merge.v1': (parentId, payload, context) => payload.acceptOnly ? acceptDurableOperation(parentId, payload, context, 'merge') : withPhotoOperation(projectOperationKey(context, payload.photoId), () => mergePatches(parentId, payload, context)),
  'team.identity.similarities.v1': readIdentitySimilarities,
  'team.identity.suggest.v1': (parentId, payload, context) => payload.acceptOnly ? acceptDurableOperation(parentId, payload, context, 'identity-suggest') : suggestIdentities(parentId, payload, context),
  'team.identity.complete.v1': (parentId, payload, context) => withPhotoOperation(projectOperationKey(context, payload.photoId), () => completeIdentity(parentId, payload, context)),
  'team.media.page.v1': (parentId, payload) => listProjectMediaPage(parentId, payload),
  'team.media.authorize.v1': (parentId, payload) => componentMedia(parentId, mediaRequest(payload)),
  'team.patch.open.v1': (parentId, payload) => componentMedia(parentId, mediaRequest({ ...payload, kind: 'working' }), 'open'),
  'team.workflow.settings.save.v1': saveWorkflowSettings,
  'team.workflow.status.v1': workflowStatus,
  'team.workflow.cancel.v1': cancelWorkflow,
  'team.workflow.generate.v1': (parentId, payload, context) => payload.acceptOnly ? acceptDurableOperation(parentId, payload, context, 'workflow-generate') : generateWorkflow(parentId, payload, context),
  'team.workflow.export.v1': (parentId, payload, context) => exportWorkflow(parentId, payload, context, false),
  'team.workflow.open-export.v1': (parentId, payload, context) => withProjectWorkflowOperation(context.projectId, () => exportWorkflow(parentId, payload, context, true)),
  'team.workflow.return-review.get.v1': reviewGet,
  'team.workflow.return-review.discard.v1': reviewDiscard,
  'team.workflow.return-review.ignore.v1': reviewIgnore,
  'team.workflow.return-batch.v1': (parentId, payload, context) => payload.acceptOnly ? acceptDurableOperation(parentId, payload, context, 'return-batch', { workflowMode: true }) : returnBatch(parentId, payload, context, true),
  'team.workflow.return-confirm.v1': returnConfirm,
  'team.patch.select-returns.v1': selectReturns,
  'team.patch.return-batch.v1': (parentId, payload, context) => payload.acceptOnly ? acceptDurableOperation(parentId, payload, context, 'return-batch', { workflowMode: false }) : returnBatch(parentId, payload, context, false),
  'team.operation.run.v1': (parentId, payload, context) => advancedLifecycleRecords.has(String(payload.operationId || '')) ? runAdvancedLifecycle(parentId, payload, context) : runDurableOperation(parentId, payload, context),
  'team.operation.get.v1': (parentId, payload, context) => {
    const advanced = advancedLifecycleRecords.get(String(payload.operationId || ''));
    return advanced ? { success: true, operation: { ...advanced }, scope: 'application.settings' } : getDurableOperation(parentId, payload, context);
  },
  'team.operation.cancel.v1': cancelDurableOperation,
  'team.progress.list.v1': parentId => listProjectProgress(parentId),
  'team.progress.create.v1': (parentId, payload) => createProjectProgress(parentId, payload),
  'team.settings.get.v1': parentId => componentSettings(parentId, { action: 'get' }),
  'team.settings.update.v1': (parentId, payload) => componentSettings(parentId, { action: 'update', settings: payload }),
  'team.advanced.status.v1': parentId => advancedRuntimeStatus(parentId),
  'team.advanced.preflight.v1': async (parentId, payload, context) => {
    if (payload.acceptOnly) return acceptAdvancedLifecycle(parentId, payload, 'preflight');
    try { return await withKeyedOperation(advancedLifecycleRuns, 'application.settings', () => lifecycleAction(parentId, 'preflight'), context.signal); }
    catch (error) { return { success: false, state: 'repair-needed', errorCategory: 'installation-prerequisite', message: String(error?.message || '增强人物检测安装条件未满足') }; }
  },
  'team.advanced.install.v1': async (parentId, payload, context) => {
    if (payload.acceptOnly) return acceptAdvancedLifecycle(parentId, payload, payload.repair === true ? 'repair' : 'install');
    const installed = await withKeyedOperation(advancedLifecycleRuns, 'application.settings', () => lifecycleAction(parentId, payload.repair === true ? 'repair' : 'install'), context.signal);
    advancedRuntimeProbeCache = null;
    const probe = await advancedRuntimeStatus(parentId, { refresh: true, full: true });
    if (!probe.advancedAvailable) return { ...installed, success: false, state: probe.state, error: probe.advancedError || probe.message };
    return { ...installed, advancedAvailable: true, state: 'ready' };
  },
  'team.advanced.uninstall.v1': async (parentId, payload, context) => {
    if (payload.acceptOnly) return acceptAdvancedLifecycle(parentId, payload, 'uninstall');
    const result = await withKeyedOperation(advancedLifecycleRuns, 'application.settings', () => lifecycleAction(parentId, 'uninstall'), context.signal); advancedRuntimeProbeCache = null; return result;
  },
};

if (process.env.PHOTOFLOW_TEST_REVISION_LEASES === '1') {
  const testMethod = 'team.test.revision-lease.v1';
  MUTATING_METHODS.add(testMethod);
  handlers[testMethod] = async (parentId, payload, context) => {
    const delayMs = Math.max(0, Number(payload.delayMs) || 0);
    if (payload.boundary === 'workflow-stage') {
      const storage = await hostStorage(parentId);
      const root = path.join(storage.dataPath, 'lease-workflow-test');
      const owner = safeSegment(revisionRequestContext.getStore()?.requestId, 'request');
      const stage = path.join(root, `.stage-${owner}`); const destination = path.join(root, 'workflow');
      await fs.promises.mkdir(stage, { recursive: true });
      await fs.promises.writeFile(path.join(stage, 'owner.txt'), String(payload.marker || ''), 'utf8');
      await writeJsonAtomic(path.join(stage, '.photoflow-workflow-checkpoint.json'), { projectId: String(context.projectId), fingerprint: 'test', owner });
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      replacePersistentFromStage(stage, destination);
      return { success: true };
    }
    if (payload.blockEventLoop === true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    else if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (payload.boundary === 'host') return lifecycleAction(parentId, 'preflight');
    if (payload.boundary === 'file') {
      const storage = await hostStorage(parentId);
      await replaceJsonAtomic(path.join(storage.dataPath, 'lease-test.json'), { request: String(payload.marker || '') });
      return { success: true };
    }
    if (payload.boundary === 'journal') {
      const storage = await hostStorage(parentId);
      await appendCommand(storage, { operationId: String(payload.marker || ''), type: 'lease-test', state: 'committed' });
      return { success: true };
    }
    return withDomain(parentId, db => {
      const now = Date.now(); const id = `lease-test-${String(payload.marker || crypto.randomUUID())}`;
      db.prepare('INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, String(context.projectId), id, '#000000', now, now);
      return { success: true };
    });
  };
  handlers['team.test.revision-lease-state.v1'] = async parentId => {
    const storage = await hostStorage(parentId); const db = ensureSchema(storage.databasePath);
    try { return { leases: Number(db.prepare('SELECT COUNT(*) count FROM team_project_revision_leases').get().count), guards: Number(db.prepare('SELECT COUNT(*) count FROM team_revision_guards').get().count), timers: projectRevisionLeaseHeartbeats.size, states: projectRevisionLeaseStates.size }; }
    finally { db.close(); }
  };
}
if (process.env.PHOTOFLOW_TEST_OUTPUT_OUTBOX === '1') {
  const testMethod = 'team.test.output-publish.v1'; MUTATING_METHODS.add(testMethod);
  handlers[testMethod] = async (parentId, payload, context) => { const committed = await publishProjectFile(parentId, String(payload.sourcePath), String(payload.outputRelativePath), String(payload.idempotencyKey), null, 'working-output', { version: 1, kind: 'working-output', projectId: String(context.projectId), preHostLocalEffects: 'none', ledgerPath: String(payload.ledgerPath), outputRelativePath: String(payload.outputRelativePath), domain: { testOnly: true } }); await completeOutputPublication(committed); return committed; };
}

const startService = () => {
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame?.type === 'capability-response') {
    const pending = pendingCapabilities.get(String(frame.id || ''));
    if (!pending) return;
    pendingCapabilities.delete(String(frame.id));
    if (frame.ok === false) pending.reject(capabilityError(frame));
    else pending.resolve(frame.result);
    return;
  }
  if (frame?.type === 'cancel') {
    const requestId = String(frame.id || ''); activeRequestControls.get(requestId)?.abort();
    for (const control of algorithmControlsByParent.get(requestId) || []) control.cancel();
    for (const [capabilityId, pending] of pendingCapabilities) if (pending.parentId === requestId) {
      pendingCapabilities.delete(capabilityId);
      pending.reject(Object.assign(new Error('团片请求已超时取消，可从上次安全进度重试'), { code: 'COMPONENT_REQUEST_CANCELLED' }));
    }
    return;
  }
  if (frame?.type !== 'request') return;
  const id = String(frame.id || '');
  const handler = handlers[String(frame.method || '')];
  const rpcStartedAt = Date.now();
  const control = new AbortController(); activeRequestControls.set(id, control);
  const requestContext = { ...(frame.context || {}), signal: control.signal };
  const method = String(frame.method || '');
  const isControlPlane = method === 'team.workflow.cancel.v1' || method === 'team.operation.cancel.v1';
  const isAdvancedLifecycle = method.startsWith('team.advanced.') || (['team.operation.run.v1','team.operation.get.v1'].includes(method) && advancedLifecycleRecords.has(String(frame.payload?.operationId || '')));
  const guardedMutation = MUTATING_METHODS.has(method) && !isControlPlane && !isAdvancedLifecycle;
  const revisionGuardId = `${String(requestContext.projectId || '')}\0${process.pid}\0${id}`;
  let finalRevision = '';
  const performRequest = async () => {
    if (!handler) throw new Error('Unknown team-retouch service method');
    assertNotAborted(requestContext.signal);
    const guarded = guardedMutation;
    if (guarded && (restoreLeaseHeld || restoreHold)) throw Object.assign(new Error('团片恢复快照期间禁止普通写入，请稍后重试'), { code: 'COMPONENT_BUSY', retryable: true });
    if (guarded && unconfirmedAlgorithmTrees.size) throw Object.assign(new Error('上一个算法进程树未能确认退出，必须重启组件服务后再写入'), { code: 'COMPONENT_RESTART_REQUIRED', retryable: false });
    if (guarded) await prepareRevisionGuard(id, frame.payload || {}, requestContext, revisionGuardId);
    try {
      assertNotAborted(requestContext.signal);
      return await revisionRequestContext.run({ requestId: guarded ? revisionGuardId : '', projectId: String(requestContext.projectId || ''), signal: requestContext.signal }, async () => {
        if (guarded) await recoverProjectOutputOutbox(id, requestContext);
        return handler(id, frame.payload || {}, requestContext);
      });
    }
    catch (error) { throw normalizeRevisionError(error); }
    finally { if (guarded) finalRevision = await finishRevisionGuard(id, requestContext, revisionGuardId); }
  };
  const executeRequest = () => guardedMutation
    ? withKeyedOperation(projectRequestOperations, String(requestContext.projectId || ''), performRequest, requestContext.signal)
    : performRequest();
  Promise.resolve(executeRequest())
    .then(async result => {
      if (guardedMutation && result && typeof result === 'object') result = { ...result, revision: finalRevision || await readDomainRevision(id, requestContext) };
      const itemCount = Array.isArray(result?.photos) ? result.photos.length : Array.isArray(result?.results) ? result.results.length : Array.isArray(result?.matches) ? result.matches.length : Number(result?.count) || 0;
      migrationMetric('team-rpc', String(frame.method || 'unknown'), rpcStartedAt, { ackMs: Date.now() - rpcStartedAt, itemCount, cacheHit: result?.cacheHit === true, fallback: result?.fallback === true, outcome: result?.state || 'completed' });
      writeFrame({ type: 'response', id, ok: true, result });
    })
    .catch(error => { migrationMetric('team-rpc', String(frame.method || 'unknown'), rpcStartedAt, { ackMs: Date.now() - rpcStartedAt, outcome: error?.code === CANCELLED_CODE ? 'cancelled' : 'failed' }); writeFrame({ type: 'response', id, ok: false, error: error.message || String(error), errorCode: String(error?.code || 'COMPONENT_INTERNAL'), retryable: error?.retryable === true }); })
    .finally(() => { activeRequestControls.delete(id); requestStoragePromises.delete(id); });
});

writeFrame({ type: 'ready', protocolVersion: 1 });
process.once('exit', () => { for (const child of activeAlgorithms) child.kill(); });
};

if (require.main === module) startService();
module.exports = { ensureSchema, startService, capabilityError, resolveAlgorithmRuntime, validateAlgorithmRuntime, resolveWorkflowTaskBinding, runMatcher, waitForReadableDrain, revisionRequestContext, advancedRuntimeFailureStatus, restoreBusyReasons, withRestoreLease, withRestorePhase };
