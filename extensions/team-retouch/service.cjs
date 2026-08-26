const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { CANCELLED_CODE, buildWorkflowPlan, copyWorkflowPlan } = require('./workflow-generation.cjs');
const { createTeamWorkflowArtifactService } = require('./workflow-artifact.cjs');
const { createWorkflowManifestResolver } = require('./workflow-manifest.cjs');

const MAX_ITEMS = 2000;
const DB_BUSY_TIMEOUT_MS = 750;
const RETURN_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']);
const pendingCapabilities = new Map();
const activeAlgorithms = new Set();
const workflowJobs = new Map();
const photoOperations = new Map();
const activeRequestControls = new Map();
let advancedRuntimeProbeCache = null;
let nextCapabilityId = 1;

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

const resolveAlgorithmRuntime = () => {
  const runtime = hostAlgorithmRuntime || { command: path.join(__dirname, process.platform === 'win32' ? 'team-retouch.exe' : 'team-retouch'), argsPrefix: [] };
  const stat = fs.statSync(runtime.command, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`团片组件算法不可用：运行时不存在（${hostAlgorithmRuntime ? '开发 Python 环境' : '组件完整性运行时'}）`);
  for (const argument of runtime.argsPrefix) {
    const candidate = path.resolve(argument);
    const argumentStat = fs.statSync(candidate, { throwIfNoEntry: false });
    if (!argumentStat?.isFile()) throw new Error('团片组件算法不可用：开发算法入口不存在');
  }
  return runtime;
};

const writeFrame = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const migrationMetric = (migration, phase, startedAt, values = {}) => writeFrame({
  type: 'metric', migration, phase, elapsedMs: Date.now() - startedAt,
  itemCount: Math.max(0, Number(values.itemCount) || 0), byteCount: Math.max(0, Number(values.byteCount) || 0),
  state: String(values.state || ''),
});
const parseJson = (value, fallback) => {
  try { return JSON.parse(value || ''); } catch { return fallback; }
};
const uniqueText = values => [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const safeSegment = (value, fallback) => String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 60) || fallback;
const weekName = value => `第${Math.max(1, Math.floor(Number(value) || 1))}周`;
const assertDecodableImage = filePath => {
  if (['.heic', '.heif'].includes(path.extname(String(filePath || '')).toLowerCase())) throw new Error('HEIC/HEIF 当前未接入可验证的通用解码器；请先转换为 JPEG、PNG、TIFF 或 WebP 后再处理');
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
    await fs.promises.rename(pending, destination);
  } finally { await fs.promises.rm(pending, { force: true }).catch(() => undefined); }
};

const readJson = async (filePath, fallback) => {
  try { return JSON.parse(await fs.promises.readFile(filePath, 'utf8')); } catch { return fallback; }
};

const replaceJsonAtomic = async (filePath, value) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const token = crypto.randomUUID();
  const pendingPath = `${filePath}.${token}.tmp`;
  const backupPath = `${filePath}.${token}.backup`;
  let backedUp = false;
  try {
    await fs.promises.writeFile(pendingPath, JSON.stringify(value, null, 2), 'utf8');
    if (fs.existsSync(filePath)) {
      await fs.promises.rename(filePath, backupPath);
      backedUp = true;
    }
    await fs.promises.rename(pendingPath, filePath);
    if (backedUp) await fs.promises.rm(backupPath, { force: true });
  } catch (error) {
    await fs.promises.rm(pendingPath, { force: true }).catch(() => undefined);
    if (backedUp && !fs.existsSync(filePath)) await fs.promises.rename(backupPath, filePath).catch(() => undefined);
    throw error;
  }
};

const callHostV2 = (parentId, method, payload = {}) => new Promise((resolve, reject) => {
  const id = `cap-${nextCapabilityId++}`;
  pendingCapabilities.set(id, { parentId: String(parentId), resolve, reject });
  writeFrame({ type: 'capability', id, parentId, method, payload });
});

const materializeInput = async (parentId, token) => callHostV2(parentId, 'project.input.tokens.v2', { action: 'materialize', token });
const readMediaV2 = async (parentId, payload) => {
  const refs = Array.isArray(payload.mediaRefs) ? payload.mediaRefs
    : [...(payload.photoIds || []).map(photoId => ({ photoId })), ...(payload.relativePaths || []).map(relativePath => ({ relativePath }))];
  const items = [];
  const selected = refs.slice(0, MAX_ITEMS); let cursor = 0;
  const workers = Array.from({ length: Math.min(16, selected.length) }, async () => { while (cursor < selected.length) {
    const ref = selected[cursor++];
    try {
      const variant = await callHostV2(parentId, 'project.media.variants.v2', { ...ref, variants: [] });
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
      if (photoId && versionId) items.push({ photo: { id: photoId, currentVersionId: versionId, displayName: path.basename(relativePath) || photoId, originalName: path.basename(relativePath) || photoId }, versions: [{ id: versionId, photoId, relativePath, relativePathState: 'missing', fileMissing: true, isCurrent: true, mediaRef: { photoId, versionId, relativePath } }], relativePath });
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
      const variant = await callHostV2(parentId, 'project.media.variants.v2', { ...ref, variants: ['original'] });
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
  const dataDirectory = path.join(storage.dataPath, 'media', safeSegment(payload.photoId, 'photo'), safeSegment(payload.baseVersionId, 'version'));
  return { dataDirectory, analysisDirectory: path.join(dataDirectory, 'analysis'), uploadDirectory: path.join(dataDirectory, 'uploads'), mergeDirectory: path.join(dataDirectory, 'merge'), deliveryDirectory: path.join(dataDirectory, 'delivery'), legacyDataRoot: storage.dataPath, deliveryPrefix: safeSegment(payload.deliveryPrefix || payload.photoId, 'photo') };
};
const artifactGrantV2 = async (parentId, payload) => artifactGrantForStorage(await hostStorage(parentId), payload);
const inputStages = new Map();
const storageMigrationOperations = new Map();
const rawHostStorage = async parentId => {
  const value = await callHostV2(parentId, 'component.storage.v2', {}); const storage = { ...value, ...(value.dataPath ? { dataRoot: value.dataPath } : {}) };
  if (value.adoption?.legacyDataRoot) {
    let operation = storageMigrationOperations.get(value.databasePath);
    if (!operation) { operation = migrateAdoptedPrivatePaths(storage).finally(() => storageMigrationOperations.delete(value.databasePath)); storageMigrationOperations.set(value.databasePath, operation); }
    await operation;
  }
  return storage;
};
const hostStorage = async parentId => {
  const storage = await rawHostStorage(parentId);
  if (storage.adoption?.state === 'pending') throw new Error('团片历史正在完成首次安全迁移，请稍后重试；当前操作尚未写入');
  return storage;
};
const readMedia = (parentId, payload) => readMediaV2(parentId, payload);
const artifactsScope = (parentId, payload) => artifactGrantV2(parentId, payload);
const hostSettings = (parentId, settings) => callHostV2(parentId, 'component.settings.v2', settings === undefined ? { action: 'get' } : { action: 'merge', settings });
const selectInputFiles = (parentId, { title = '选择图片', multiple = true } = {}) => callHostV2(parentId, 'dialogs.v2', { kind: 'openFiles', title, extensions: [...RETURN_IMAGE_EXTENSIONS].map(value => value.slice(1)), multiple });
const materializeInputStage = async (parentId, tokens) => {
  const stageId = crypto.randomUUID(); const items = [];
  for (const [index, token] of (tokens || []).entries()) { const input = await materializeInput(parentId, token); items.push({ id: input.inputId, name: path.basename(input.privatePath), path: input.privatePath, index }); }
  inputStages.set(stageId, items.map(item => path.dirname(item.path))); return { stageId, items };
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
  return callHostV2(parentId, 'component.events.v2', { topic: declaredTopic, event });
};
const hostTask = async (parentId, operationId, action, update = {}, topic = '') => {
  const mapped = action === 'failed' ? 'fail' : action;
  if (mapped === 'latest') return { task: null, cancelled: false };
  const result = await callHostV2(parentId, 'tasks.v2', { action: mapped, operationId: String(operationId || 'team-operation'), title: update.title, message: update.message, progress: update.progress, phase: update.phase, checkpoint: update.checkpoint, error: update.error });
  if (topic) await emitProgress(parentId, topic, update).catch(() => undefined);
  return result;
};
const lifecycleAction = (parentId, action) => callHostV2(parentId, 'component.lifecycle.v2', { action });

const publishProjectFileV2 = async (parentId, sourcePath, outputRelativePath, idempotencyKey, replacement = null) => {
  const stage = await callHostV2(parentId, 'project.output.v2', { action: 'stage' });
  const name = path.basename(sourcePath);
  const sourceName = `${crypto.randomUUID()}-${name}`;
  const stagedPath = path.join(stage.privatePath, sourceName);
  try {
    await fs.promises.copyFile(sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
    await callHostV2(parentId, 'project.output.v2', { action: 'write', stageId: stage.stageId, name, sourceName, outputRelativePath, ...(replacement ? { replace: true, previousCommitId: replacement.commitId, previousArtifactId: replacement.artifactId, expectedDigest: replacement.sha256 } : {}) });
    await callHostV2(parentId, 'project.output.v2', { action: 'validate', stageId: stage.stageId });
    return await callHostV2(parentId, 'project.output.v2', { action: 'commit', stageId: stage.stageId, idempotencyKey });
  } finally { await callHostV2(parentId, 'project.output.v2', { action: 'rollback', stageId: stage.stageId }).catch(() => undefined); }
};
const publishProjectFilesV2 = async (parentId, files, idempotencyKey, replacements = new Map()) => {
  const stage = await callHostV2(parentId, 'project.output.v2', { action: 'stage' });
  try {
    for (const [index, file] of files.entries()) {
      const name = path.basename(file.sourcePath); const sourceName = `${String(index + 1).padStart(4, '0')}-${name}`;
      await fs.promises.copyFile(file.sourcePath, path.join(stage.privatePath, sourceName), fs.constants.COPYFILE_EXCL);
      const previous = replacements.get(file.outputRelativePath);
      await callHostV2(parentId, 'project.output.v2', { action: 'write', stageId: stage.stageId, name, sourceName, outputRelativePath: file.outputRelativePath, ...(previous ? { replace: true, previousCommitId: previous.commitId, previousArtifactId: previous.artifactId, expectedDigest: previous.sha256 } : {}) });
    }
    await callHostV2(parentId, 'project.output.v2', { action: 'validate', stageId: stage.stageId });
    return await callHostV2(parentId, 'project.output.v2', { action: 'commit', stageId: stage.stageId, idempotencyKey });
  } finally { await callHostV2(parentId, 'project.output.v2', { action: 'rollback', stageId: stage.stageId }).catch(() => undefined); }
};
const publishWorkingImageV2 = async (parentId, storage, sourcePath, baseRelativePath, operationKey) => {
  const normalizedBase = String(baseRelativePath || '').replace(/\\/g, '/'); const parsed = path.posix.parse(normalizedBase);
  const outputRelativePath = [parsed.dir, `${parsed.name}_裁切`, path.basename(sourcePath)].filter(Boolean).join('/');
  const ledgerPath = path.join(storage.dataPath, 'output-ownership', 'working-images.json'); const ledger = await readJson(ledgerPath, {});
  let previous = ledger[outputRelativePath] || null;
  if (!previous) {
    try { const adopted = await callHostV2(parentId, 'project.output.v2', { action: 'adopt', migrationId: `working-${sha256(outputRelativePath).slice(0, 24)}`, outputs: [{ relativePath: outputRelativePath }] }); const output = adopted.outputs?.[0]; if (output) previous = { commitId: adopted.commitId, artifactId: output.artifactId, sha256: output.sha256 }; } catch { /* A new working image has no legacy target to adopt. */ }
  }
  const committed = await publishProjectFileV2(parentId, sourcePath, outputRelativePath, `working-${sha256(operationKey).slice(0, 24)}`, previous);
  const output = committed.outputs[0]; const imported = await callHostV2(parentId, 'project.output.v2', { action: 'materializeOwned', commitId: committed.commitId, artifactId: output.artifactId });
  ledger[outputRelativePath] = { commitId: committed.commitId, artifactId: output.artifactId, sha256: output.sha256 };
  await replaceJsonAtomic(ledgerPath, ledger);
  return { privatePath: imported.privatePath, outputRelativePath, ownership: ledger[outputRelativePath] };
};

const ensureSchema = databasePath => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout=${DB_BUSY_TIMEOUT_MS}; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS team_patch_tasks (
      id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
      person_index INTEGER NOT NULL, person_name TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '',
      detector TEXT NOT NULL DEFAULT '', bbox_json TEXT NOT NULL, crop_json TEXT NOT NULL,
      patch_path TEXT NOT NULL, mask_path TEXT, mask_json TEXT NOT NULL DEFAULT '{}',
      members_json TEXT NOT NULL DEFAULT '[]', needs_review INTEGER NOT NULL DEFAULT 0,
      review_reason TEXT NOT NULL DEFAULT '', edited_patch_path TEXT, status TEXT NOT NULL DEFAULT 'exported',
      merge_metrics_json TEXT NOT NULL DEFAULT '{}', merged_version_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS team_patch_photo ON team_patch_tasks(photo_id, base_version_id, is_deleted);
    CREATE TABLE IF NOT EXISTS team_retouch_photos (
      photo_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_retouch_photo_project ON team_retouch_photos(project_id, updated_at);
    CREATE TABLE IF NOT EXISTS team_person_identities (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#2563eb',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_person_assignments (
      project_id TEXT NOT NULL, photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL, person_index INTEGER NOT NULL,
      identity_id TEXT, confidence REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual',
      completed INTEGER NOT NULL DEFAULT 0, completion_kind TEXT NOT NULL DEFAULT '', edited_patch_path TEXT,
      return_missing INTEGER NOT NULL DEFAULT 0, return_missing_since INTEGER, completed_at INTEGER,
      updated_at INTEGER NOT NULL, PRIMARY KEY (photo_id, base_version_id, person_index)
    );
    CREATE TABLE IF NOT EXISTS team_person_exclusions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, photo_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
      bbox_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'false-positive', created_at INTEGER NOT NULL
    );
  `);
  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  const addColumn = (table, name, definition) => {
    if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addColumn('team_patch_tasks', 'generation_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('team_person_assignments', 'task_id', 'TEXT');
  addColumn('team_person_assignments', 'stage_id', 'TEXT');
  addColumn('team_person_assignments', 'artifact_id', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_task_stages (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, person_index INTEGER NOT NULL,
      stage_order INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(task_id, person_index),
      FOREIGN KEY(task_id) REFERENCES team_patch_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS team_stage_task_order ON team_task_stages(task_id, stage_order);
    CREATE TABLE IF NOT EXISTS team_task_artifacts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage_id TEXT, person_index INTEGER,
      kind TEXT NOT NULL, artifact_path TEXT NOT NULL, digest TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(task_id) REFERENCES team_patch_tasks(id), FOREIGN KEY(stage_id) REFERENCES team_task_stages(id)
    );
    CREATE INDEX IF NOT EXISTS team_artifact_chain ON team_task_artifacts(task_id, created_at, is_deleted);
    CREATE TABLE IF NOT EXISTS team_workflow_reconcile_pending (
      task_id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      FOREIGN KEY(task_id) REFERENCES team_patch_tasks(id)
    );
  `);
  const storedSchemaVersion = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0);
  if (storedSchemaVersion < 4) {
    const now = Date.now();
    const tasks = db.prepare('SELECT * FROM team_patch_tasks').all();
    const insertStage = db.prepare(`INSERT OR IGNORE INTO team_task_stages(id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`);
    const updateAssignmentLink = db.prepare(`UPDATE team_person_assignments SET task_id=COALESCE(task_id,?),stage_id=COALESCE(stage_id,?) WHERE photo_id=? AND base_version_id=? AND person_index=?`);
    const insertArtifact = db.prepare(`INSERT OR IGNORE INTO team_task_artifacts(id,task_id,stage_id,person_index,kind,artifact_path,created_at) VALUES(?,?,?,?,?,?,?)`);
    for (const task of tasks) {
      const members = parseJson(task.members_json, []).length ? parseJson(task.members_json, []) : [{ personIndex: task.person_index }];
      for (const [order, member] of members.entries()) {
        const personIndex = Number(member.personIndex);
        const stageId = `legacy-stage:${task.id}:${personIndex}`;
        insertStage.run(stageId, task.id, personIndex, order + 1, 'migrated', Number(task.created_at || now), now);
        updateAssignmentLink.run(task.id, stageId, task.photo_id, task.base_version_id, personIndex);
        const assignment = db.prepare('SELECT edited_patch_path,artifact_id,completed_at FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?').get(task.photo_id, task.base_version_id, personIndex);
        if (assignment?.edited_patch_path) {
          const artifactId = assignment.artifact_id || `legacy-artifact:${task.id}:${personIndex}`;
          insertArtifact.run(artifactId, task.id, stageId, personIndex, 'returned', assignment.edited_patch_path, Number(assignment.completed_at || task.updated_at || now));
          db.prepare('UPDATE team_person_assignments SET artifact_id=? WHERE photo_id=? AND base_version_id=? AND person_index=? AND artifact_id IS NULL').run(artifactId, task.photo_id, task.base_version_id, personIndex);
        }
      }
      if (task.edited_patch_path && !db.prepare('SELECT 1 FROM team_task_artifacts WHERE task_id=? AND artifact_path=?').get(task.id, task.edited_patch_path)) {
        insertArtifact.run(`legacy-task-artifact:${task.id}`, task.id, null, null, 'returned', task.edited_patch_path, Number(task.updated_at || now));
      }
    }
  }
  db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version','5') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
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
const assertOrdinaryParentSegments = async (root, relative, verified = new Set()) => {
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean).slice(0, -1)) {
    current = path.join(current, segment);
    if (verified.has(current)) continue;
    const stat = await fs.promises.lstat(current).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('旧组件私有文件副本缺失或路径不安全');
    verified.add(current);
  }
};

const serializeTask = row => {
  const generation = parseJson(row.generation_json, {});
  return ({
  id: row.id, photoId: row.photo_id, baseVersionId: row.base_version_id,
  personIndex: row.person_index, personName: row.person_name, assignee: row.assignee,
  detector: row.detector, bbox: parseJson(row.bbox_json, {}), crop: parseJson(row.crop_json, {}),
  patchPath: row.patch_path, maskPath: row.mask_path, mask: parseJson(row.mask_json, {}),
  members: parseJson(row.members_json, []), needsReview: Boolean(row.needs_review),
  reviewReason: row.review_reason, editedPatchPath: row.edited_patch_path, status: row.status,
  mergeMetrics: parseJson(row.merge_metrics_json, {}), mergedVersionId: row.merged_version_id,
  generation, requiresManualCrop: Boolean(generation.requiresManualCrop), fullFrame: Boolean(generation.fullFrame), sourceCoverage: generation.sourceCoverage,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
};

const withPhotoOperation = (key, worker) => {
  const normalized = String(key || 'global');
  const previous = photoOperations.get(normalized) || Promise.resolve();
  const current = previous.catch(() => undefined).then(worker);
  photoOperations.set(normalized, current);
  return current.finally(() => { if (photoOperations.get(normalized) === current) photoOperations.delete(normalized); });
};
const withPhotoOperations = (keys, worker) => [...new Set(keys.map(String))].sort().reduceRight(
  (next, key) => () => withPhotoOperation(key, next), worker,
)();

const createArtifact = (db, row, personIndex, artifactPath, kind = 'returned', metadata = {}) => {
  const stage = db.prepare('SELECT * FROM team_task_stages WHERE task_id=? AND person_index=?').get(row.id, Number(personIndex));
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO team_task_artifacts(id,task_id,stage_id,person_index,kind,artifact_path,digest,metadata_json,created_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,0)`)
    .run(id, row.id, stage?.id || null, Number(personIndex), kind, artifactPath, '', JSON.stringify(metadata), Date.now());
  return { id, stageId: stage?.id || null };
};

const currentTaskArtifact = (db, taskId) => db.prepare(`SELECT * FROM team_task_artifacts WHERE task_id=? AND is_deleted=0 ORDER BY created_at DESC,id DESC LIMIT 1`).get(String(taskId || ''));

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
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.appendFile(path.join(directory, 'operations.ndjson'), `${JSON.stringify({ at: Date.now(), ...operation })}\n`, 'utf8');
};

const runAlgorithm = (parentId, args, { timeoutMs = 60 * 60 * 1000, topic = '', progress = {} } = {}) => new Promise((resolve, reject) => {
  let runtime;
  try { runtime = resolveAlgorithmRuntime(); } catch (error) { reject(error); return; }
  const child = spawn(runtime.command, [...runtime.argsPrefix, ...args.map(value => String(value))], {
    cwd: __dirname, env: Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  let result;
  let cancelled = false;
  let settled = false;
  const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
  activeAlgorithms.add(child);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const timer = setTimeout(() => { child.kill(); finish(reject, new Error('团片组件算法运行超时')); }, timeoutMs);
  timer.unref?.();
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8000); });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.type === 'progress' && topic) void emitProgress(parentId, topic, { ...progress, ...message }).catch(() => undefined);
    else if (message?.type === 'result') result = message.result;
    else if (message && typeof message === 'object') result = message;
  });
  child.once('error', error => { finish(reject, error); });
  child.once('exit', code => {
    activeAlgorithms.delete(child);
    lines.close();
    if (cancelled) finish(reject, Object.assign(new Error('团片组件算法已取消'), { code: CANCELLED_CODE }));
    else if (code !== 0) finish(reject, new Error(stderr.trim() || `团片组件算法退出（${code}）`));
    else if (!result) finish(reject, new Error('团片组件算法没有返回结果'));
    else finish(resolve, result);
  });
});
const advancedRuntimeStatus = async (parentId, { refresh = false } = {}) => {
  const now = Date.now();
  if (!refresh && advancedRuntimeProbeCache?.expiresAt > now) return advancedRuntimeProbeCache.value;
  try {
    const probe = await runAlgorithm(parentId, ['probe-advanced-runtime'], { timeoutMs: 30 * 1000 });
    const advancedAvailable = probe?.pairDetrReady === true && probe?.sam2Ready === true;
    const value = { success: true, advancedAvailable, state: advancedAvailable ? 'ready' : 'repair-needed', pairDetrReady: probe?.pairDetrReady === true, sam2Ready: probe?.sam2Ready === true, message: advancedAvailable ? '增强人物检测运行时已就绪' : '增强人物检测未完全就绪；基础人物检测仍可正常使用' };
    advancedRuntimeProbeCache = { expiresAt: now + 30_000, value }; return value;
  } catch (error) {
    const notInstalled = /运行时不存在|not found|ENOENT/i.test(String(error?.message || ''));
    const value = { success: true, advancedAvailable: false, state: notInstalled ? 'not-installed' : 'repair-needed', pairDetrReady: false, sam2Ready: false, advancedError: notInstalled ? '增强人物检测尚未安装' : '增强人物检测运行时需要检查或修复', message: notInstalled ? '当前使用基础人物检测；可在设置中安装增强版' : '当前使用基础人物检测；可在设置中检查或修复增强版' };
    advancedRuntimeProbeCache = { expiresAt: now + 10_000, value }; return value;
  }
};

const taskRows = (db, photoId, baseVersionId) => db.prepare(`SELECT * FROM team_patch_tasks WHERE photo_id=? AND (?='' OR base_version_id=?) AND is_deleted=0 ORDER BY created_at,person_index`).all(String(photoId), String(baseVersionId || ''), String(baseVersionId || ''));
const listTasks = (db, photoId, baseVersionId = '') => taskRows(db, photoId, baseVersionId).map(serializeTask);
const registerPhoto = (db, context, photoId, baseVersionId) => db.prepare(`INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(photo_id) DO UPDATE SET project_id=excluded.project_id,base_version_id=excluded.base_version_id,updated_at=excluded.updated_at`).run(String(photoId), String(context.projectId), String(baseVersionId), Date.now(), Date.now());

const replacePatches = (db, context, photoId, baseVersionId, tasks) => {
  const old = listTasks(db, photoId, baseVersionId);
  db.prepare('UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE photo_id=? AND base_version_id=? AND is_deleted=0').run(Date.now(), String(photoId), String(baseVersionId));
  db.prepare('DELETE FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=?').run(String(context.projectId), String(photoId), String(baseVersionId));
  const insert = db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,assignee,detector,bbox_json,crop_json,patch_path,mask_path,mask_json,members_json,needs_review,review_reason,edited_patch_path,status,merge_metrics_json,merged_version_id,generation_json,created_at,updated_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
  const insertStage = db.prepare(`INSERT OR IGNORE INTO team_task_stages(id,task_id,person_index,stage_order,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`);
  const now = Date.now();
  for (const task of tasks || []) {
    const taskId = String(task.id || crypto.randomUUID());
    insert.run(taskId, String(photoId), String(baseVersionId), Number(task.personIndex || 0), String(task.personName || `人物 ${Number(task.personIndex || 0) + 1}`), String(task.assignee || ''), String(task.detector || ''), JSON.stringify(task.bbox || {}), JSON.stringify(task.crop || {}), String(task.patchPath || ''), task.maskPath ? String(task.maskPath) : null, JSON.stringify(task.mask || {}), JSON.stringify(task.members || []), task.needsReview ? 1 : 0, String(task.reviewReason || ''), task.editedPatchPath ? String(task.editedPatchPath) : null, String(task.status || 'exported'), JSON.stringify(task.mergeMetrics || {}), task.mergedVersionId ? String(task.mergedVersionId) : null, JSON.stringify(task.generation || {}), now, now);
    const members = task.members?.length ? task.members : [{ personIndex: task.personIndex }];
    for (const [order, member] of members.entries()) insertStage.run(crypto.randomUUID(), taskId, Number(member.personIndex), order + 1, 'pending', now, now);
  }
  if ((tasks || []).length) registerPhoto(db, context, photoId, baseVersionId);
  else db.prepare('DELETE FROM team_retouch_photos WHERE photo_id=? AND project_id=?').run(String(photoId), String(context.projectId));
  return { old, tasks: listTasks(db, photoId, baseVersionId) };
};

const removeArtifacts = async paths => {
  for (const filePath of uniqueText(paths)) await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
};

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const assertAuthorizedArtifacts = async (parentId, rows) => {
  const grants = new Map();
  for (const row of rows || []) {
    const key = `${row.photo_id}:${row.base_version_id}`;
    if (!grants.has(key)) grants.set(key, await artifactsScope(parentId, { photoId: row.photo_id, baseVersionId: row.base_version_id }));
    const grant = grants.get(key);
    for (const filePath of [row.patch_path, row.mask_path, row.edited_patch_path].filter(Boolean)) {
      if (![grant.dataDirectory, grant.deliveryDirectory, grant.legacyDataRoot].some(root => isInside(root, filePath))) throw new Error('团片文件超出组件授权目录');
    }
  }
};
const publishStagedFile = async (sourcePath, destinationPath, operationId) => {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const pendingPath = `${destinationPath}.${operationId}.pending`;
  const backupPath = `${destinationPath}.${operationId}.backup`;
  await fs.promises.copyFile(sourcePath, pendingPath, fs.constants.COPYFILE_EXCL);
  let backedUp = false;
  try {
    if (fs.existsSync(destinationPath)) { await fs.promises.rename(destinationPath, backupPath); backedUp = true; }
    await fs.promises.rename(pendingPath, destinationPath);
    return { destinationPath, backupPath: backedUp ? backupPath : '' };
  } catch (error) {
    await fs.promises.rm(pendingPath, { force: true }).catch(() => undefined);
    if (backedUp && !fs.existsSync(destinationPath)) await fs.promises.rename(backupPath, destinationPath).catch(() => undefined);
    throw error;
  }
};
const rollbackPublished = async published => {
  for (const item of [...published].reverse()) {
    await fs.promises.rm(item.destinationPath, { force: true }).catch(() => undefined);
    if (item.backupPath) await fs.promises.rename(item.backupPath, item.destinationPath).catch(() => undefined);
  }
};
const commitPublished = async published => Promise.all(published.map(item => item.backupPath ? fs.promises.rm(item.backupPath, { force: true }) : undefined));

const detectPhoto = async (parentId, payload, context) => {
  const described = await readMedia(parentId, { strict: true, mediaRefs: [{ photoId: payload.photoId, versionId: payload.baseVersionId }] });
  const metadataBase = described.items?.[0]?.versions?.find(version => String(version.id) === String(payload.baseVersionId));
  if (!metadataBase || metadataBase.fileMissing) throw new Error('基础版本文件不存在');
  const authorized = await artifactsScope(parentId, { photoId: payload.photoId, baseVersionId: payload.baseVersionId, deliveryPrefix: path.posix.parse(String(metadataBase.relativePath || '').replace(/\\/g, '/')).name });
  const settings = (await hostSettings(parentId)).settings || {};
  const storage = await hostStorage(parentId);
  const db = ensureSchema(storage.databasePath);
  const materialized = await materializeMediaForOperation(parentId, [{ photoId: payload.photoId, versionId: payload.baseVersionId }]);
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
    const detected = await runAlgorithm(parentId, ['detect', '--input', base.filePath, '--output-dir', stagingAnalysis, '--delivery-dir', stagingDelivery, '--delivery-prefix', authorized.deliveryPrefix, '--excluded-boxes', JSON.stringify(exclusions), '--provider', settings.useGpu === false ? 'cpu' : 'auto', '--oversize-crop-mode', settings.oversizeCropMode === 'expand' ? 'expand' : 'face-centered', '--advanced-mode', 'auto'], { topic: 'patch.detect.progress', progress: { photoId: payload.photoId, baseVersionId: payload.baseVersionId } });
    const missing = (detected.tasks || []).filter(task => !task.patchPath || !fs.existsSync(task.patchPath));
    if (missing.length) throw new Error(`切好的图片没有成功保存（缺少 ${missing.length} 个文件）`);
    const publishedTasks = [];
    for (const task of detected.tasks || []) {
      const working = await publishWorkingImageV2(parentId, storage, task.patchPath, metadataBase.relativePath, `${operationId}\0${task.id || task.personIndex}`);
      const patchTarget = working.privatePath;
      let maskTarget = null;
      if (task.maskPath) { maskTarget = path.join(authorized.analysisDirectory, path.basename(task.maskPath)); published.push(await publishStagedFile(task.maskPath, maskTarget, operationId)); }
      publishedTasks.push({ ...task, patchPath: patchTarget, maskPath: maskTarget });
    }
    db.exec('BEGIN IMMEDIATE');
    let replaced;
    try {
      replaced = replacePatches(db, context, payload.photoId, payload.baseVersionId, publishedTasks);
      if (payload.restoreExcluded) db.prepare('DELETE FROM team_person_exclusions WHERE project_id=? AND photo_id=? AND base_version_id=?').run(String(context.projectId), String(payload.photoId), String(payload.baseVersionId));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await appendCommand(storage, { operationId, type: 'detect', state: 'committed' });
    await commitPublished(published);
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
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE id=? AND photo_id=? AND is_deleted=0').get(String(payload.taskId || ''), String(payload.photoId || ''));
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
      backupPath = `${row.patch_path}.${operationId}.backup`;
      await fs.promises.rename(row.patch_path, backupPath);
      await fs.promises.rename(stagedPath, row.patch_path);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const generation = crop ? { ...parseJson(row.generation_json, {}), version: 2, strategy: 'manual', workWidth: crop.width, workHeight: crop.height, fileDigest: crypto.createHash('sha256').update(fs.readFileSync(row.patch_path)).digest('hex'), requiresManualCrop: false, reason: '人工调整工作图范围' } : null;
      db.prepare(`UPDATE team_patch_tasks SET person_name=COALESCE(?,person_name),assignee=COALESCE(?,assignee),crop_json=COALESCE(?,crop_json),generation_json=COALESCE(?,generation_json),needs_review=COALESCE(?,needs_review),review_reason=COALESCE(?,review_reason),updated_at=? WHERE id=? AND is_deleted=0`).run(payload.personName === undefined ? null : String(payload.personName).trim().slice(0, 80) || '未命名人物', payload.assignee === undefined ? null : String(payload.assignee).trim().slice(0, 80), crop ? JSON.stringify(crop) : null, generation ? JSON.stringify(generation) : null, payload.needsReview === undefined ? null : payload.needsReview ? 1 : 0, payload.reviewReason === undefined ? null : String(payload.reviewReason).trim().slice(0, 300), Date.now(), row.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (backupPath) await fs.promises.rm(backupPath, { force: true });
    await appendCommand(storage, { operationId, type: crop ? 'recrop' : 'patch-update', state: 'committed', taskId: row.id });
    return { success: true, tasks: listTasks(db, row.photo_id).map(publicTask) };
  } catch (error) {
    if (backupPath && fs.existsSync(backupPath)) { await fs.promises.rm(row.patch_path, { force: true }).catch(() => undefined); await fs.promises.rename(backupPath, row.patch_path).catch(() => undefined); }
    if (stagedPath) await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined);
    await appendCommand(storage, { operationId, type: crop ? 'recrop' : 'patch-update', state: 'rolled-back', taskId: row.id, error: error.message || String(error) }).catch(() => undefined);
    throw error;
  }
});

const deletePatch = (parentId, payload) => withDomain(parentId, async (db, storage) => {
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE id=? AND photo_id=? AND is_deleted=0').get(String(payload.taskId || ''), String(payload.photoId || ''));
  if (!row) throw new Error('人物工作图不存在');
  await assertAuthorizedArtifacts(parentId, [row]);
  const operationId = crypto.randomUUID();
  await appendCommand(storage, { operationId, type: 'patch-delete', state: 'prepared', taskId: row.id });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE id=?').run(Date.now(), row.id);
    db.prepare('DELETE FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index IN (SELECT CAST(value AS INTEGER) FROM json_each(?))').run(row.photo_id, row.base_version_id, JSON.stringify((parseJson(row.members_json, []).length ? parseJson(row.members_json, []).map(item => item.personIndex) : [row.person_index])));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); await appendCommand(storage, { operationId, type: 'patch-delete', state: 'rolled-back', error: error.message || String(error) }); throw error; }
  await appendCommand(storage, { operationId, type: 'patch-delete', state: 'committed' });
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
    db.prepare('UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE photo_id=? AND base_version_id=? AND is_deleted=0').run(Date.now(), String(payload.photoId), String(payload.baseVersionId));
    db.prepare('DELETE FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=?').run(String(context.projectId), String(payload.photoId), String(payload.baseVersionId));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); await appendCommand(storage, { operationId, type: 'patch-cleanup', state: 'rolled-back', error: error.message || String(error) }); throw error; }
  await appendCommand(storage, { operationId, type: 'patch-cleanup', state: 'committed' });
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
    db.prepare('UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE photo_id=? AND is_deleted=0').run(Date.now(), String(payload.photoId));
    db.prepare('DELETE FROM team_retouch_photos WHERE project_id=? AND photo_id=?').run(String(context.projectId), String(payload.photoId));
    db.prepare('DELETE FROM team_person_assignments WHERE project_id=? AND photo_id=?').run(String(context.projectId), String(payload.photoId));
    db.prepare('DELETE FROM team_person_exclusions WHERE project_id=? AND photo_id=?').run(String(context.projectId), String(payload.photoId));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); await appendCommand(storage, { operationId, type: 'project-remove-photo', state: 'rolled-back', error: error.message || String(error) }); throw error; }
  await appendCommand(storage, { operationId, type: 'project-remove-photo', state: 'committed' });
  await removeArtifacts(rows.flatMap(row => [row.patch_path, row.mask_path, row.edited_patch_path]));
  return { success: true, cleanupQueued: true };
});

const uploadPatch = (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE id=? AND photo_id=? AND is_deleted=0').get(String(payload.taskId || ''), String(payload.photoId || ''));
  if (!row) throw new Error('人物修图任务不存在');
  const members = parseJson(row.members_json, []).length ? parseJson(row.members_json, []) : [{ personIndex: row.person_index }];
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
    await fs.promises.rename(stagedPath, outputPath);
    db.exec('BEGIN IMMEDIATE');
    try {
      const artifact = createArtifact(db, row, personIndex, outputPath, 'manual-upload');
      db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status='uploaded',updated_at=? WHERE id=?`).run(outputPath, Date.now(), row.id);
      db.prepare(`${upsertAssignmentSql}`).run(String(context.projectId), row.photo_id, row.base_version_id, personIndex, existingAssignment?.identity_id || null, 1, 'manual', 1, Date.now());
      db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,artifact_id=?,edited_patch_path=?,completed=1,completion_kind='retouched',return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=? WHERE photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, artifact.stageId, artifact.id, outputPath, Date.now(), Date.now(), row.photo_id, row.base_version_id, personIndex);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await appendCommand(storage, { operationId, type: 'patch-upload', state: 'committed' });
    committed = true;
    return finalizeReconcile(parentId, context, { taskId: row.id, photoId: row.photo_id }, { success: true, tasks: listTasks(db, row.photo_id).map(publicTask) }, db);
  } catch (error) {
    if (!committed) {
      await removeArtifacts([stagedPath, outputPath]);
      await appendCommand(storage, { operationId, type: 'patch-upload', state: 'rolled-back', error: error.message || String(error) }).catch(() => undefined);
    } else await appendCommand(storage, { operationId, type: 'workflow-reconcile', state: 'pending-retry', taskId: row.id, error: error.message || String(error) }).catch(() => undefined);
    throw error;
  }
});

const removeUpload = (parentId, payload, context) => withDomain(parentId, async (db, storage) => {
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE id=? AND photo_id=? AND is_deleted=0').get(String(payload.taskId || ''), String(payload.photoId || ''));
  if (!row) throw new Error('人物修图任务不存在');
  const personIndex = Number(payload.personIndex);
  const assignment = db.prepare('SELECT * FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?').get(row.photo_id, row.base_version_id, personIndex);
  if (assignment?.task_id && String(assignment.task_id) !== String(row.id)) throw new Error('返图阶段不属于这个修图任务');
  const removedArtifact = assignment?.artifact_id
    ? db.prepare('SELECT * FROM team_task_artifacts WHERE id=? AND task_id=? AND is_deleted=0').get(assignment.artifact_id, row.id)
    : db.prepare('SELECT * FROM team_task_artifacts WHERE task_id=? AND person_index=? AND is_deleted=0 ORDER BY created_at DESC,id DESC LIMIT 1').get(row.id, personIndex);
  const removedPath = removedArtifact?.artifact_path || assignment?.edited_patch_path || '';
  await assertAuthorizedArtifacts(parentId, [row]);
  const operationId = crypto.randomUUID();
  await appendCommand(storage, { operationId, type: 'patch-remove-upload', state: 'prepared', taskId: row.id, personIndex });
  db.exec('BEGIN IMMEDIATE');
  try {
    if (removedArtifact) db.prepare('UPDATE team_task_artifacts SET is_deleted=1 WHERE id=? AND task_id=?').run(removedArtifact.id, row.id);
    db.prepare(`UPDATE team_person_assignments SET completed=0,completion_kind='',artifact_id=NULL,edited_patch_path=NULL,completed_at=NULL,updated_at=? WHERE photo_id=? AND base_version_id=? AND person_index=?`).run(Date.now(), row.photo_id, row.base_version_id, personIndex);
    const predecessor = currentTaskArtifact(db, row.id)?.artifact_path || null;
    db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status=?,merged_version_id=NULL,merge_metrics_json='{}',updated_at=? WHERE id=?`).run(predecessor, predecessor ? 'uploaded' : 'exported', Date.now(), row.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); await appendCommand(storage, { operationId, type: 'patch-remove-upload', state: 'rolled-back', error: error.message || String(error) }); throw error; }
  await appendCommand(storage, { operationId, type: 'patch-remove-upload', state: 'committed' });
  if (removedPath) await removeArtifacts([removedPath]);
  return finalizeReconcile(parentId, context, { taskId: row.id, photoId: row.photo_id }, { success: true, tasks: listTasks(db, row.photo_id).map(publicTask), cleanupQueued: Boolean(removedPath) }, db);
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
  const subjects = (photo?.tasks || []).flatMap(task => (task.members?.length ? task.members : [{ personIndex: task.personIndex, bbox: task.bbox }]).map(member => ({ task, personIndex: Number(member.personIndex), bbox: member.bbox || task.bbox })));
  const selected = subjects.find(item => item.personIndex === Number(payload.personIndex));
  if (!selected) throw new Error('人物实例不存在，可能已经被移除');
  if ((photo.tasks || []).some(task => task.editedPatchPath || !['', 'exported'].includes(String(task.status || 'exported')))) throw new Error('这张图片已有返图或合成记录，不能重新计算工作图；请先清理对应返图');
  const oldAssignments = before.assignments.filter(item => item.photoId === payload.photoId && item.baseVersionId === payload.baseVersionId && item.personIndex !== Number(payload.personIndex));
  await withDomain(parentId, db => db.prepare('INSERT INTO team_person_exclusions(id,project_id,photo_id,base_version_id,bbox_json,reason,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), String(context.projectId), String(payload.photoId), String(payload.baseVersionId), JSON.stringify(selected.bbox || {}), 'false-positive', Date.now()));
  try {
    const detected = await detectPhoto(parentId, { photoId: payload.photoId, baseVersionId: payload.baseVersionId, restoreExcluded: false }, context);
    await withDomain(parentId, db => {
      const nextSubjects = listTasks(db, payload.photoId, payload.baseVersionId).flatMap(task => (task.members?.length ? task.members : [{ personIndex: task.personIndex, bbox: task.bbox }]).map(member => ({ personIndex: Number(member.personIndex), bbox: member.bbox || task.bbox })));
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
  const media = materialized;
  const bundle = media.items?.[0];
  const base = bundle?.versions?.find(item => String(item.id) === String(payload.baseVersionId));
  if (!base || !fs.existsSync(base.filePath)) { await materialized.cleanup(); throw new Error('基础版本文件不存在'); }
  const tasks = listTasks(db, payload.photoId, payload.baseVersionId).filter(task => task.editedPatchPath && fs.existsSync(task.editedPatchPath));
  if (!tasks.length) throw new Error('请至少上传一张工作图的修图结果');
  await assertAuthorizedArtifacts(parentId, taskRows(db, payload.photoId, payload.baseVersionId));
  const progress = await callHostV2(parentId, 'project.progress.v2', { action: 'list' });
  const outputProgress = (progress.progress || []).find(item => String(item.id) === String(payload.outputProgressId));
  const relativeDirectory = String(outputProgress?.contentRef?.relativeDirectory || '');
  if (!outputProgress || outputProgress.mediaKind !== 'image' || !relativeDirectory) throw new Error('合成结果的目标图片进度不存在或不在项目内容边界内');
  const output = await artifactGrantV2(parentId, { operation: 'artifacts', photoId: payload.photoId, baseVersionId: payload.baseVersionId });
  await fs.promises.mkdir(output.mergeDirectory, { recursive: true });
  const fingerprintTasks = await Promise.all([...tasks].sort((left, right) => String(left.id).localeCompare(String(right.id))).map(async task => ({ id: String(task.id), editedSha256: await fileSha256(task.editedPatchPath), crop: task.crop || {}, generation: task.generation || {} })));
  const mergeFingerprint = sha256(JSON.stringify({ projectId: String(context.projectId), photoId: String(payload.photoId), baseVersionId: String(payload.baseVersionId), outputProgressId: String(payload.outputProgressId), strategyVersion: 1, tasks: fingerprintTasks }));
  const operationId = `merge-${mergeFingerprint.slice(0, 32)}`;
  const manifestPath = path.join(output.mergeDirectory, `merge-${operationId}.json`);
  const outputName = `${safeSegment(path.parse(bundle.photo?.originalName || bundle.photo?.displayName || payload.photoId).name, '素材')}_多人修图_${mergeFingerprint.slice(0, 12)}.tif`;
  const privateOutputPath = path.join(output.mergeDirectory, outputName);
  const outputRelativePath = [relativeDirectory, outputName].filter(Boolean).join('/');
  await appendCommand(storage, { operationId, type: 'patch-merge', state: 'prepared', photoId: payload.photoId, outputRelativePath });
  try {
    await fs.promises.rm(privateOutputPath, { force: true }).catch(() => undefined);
    await fs.promises.writeFile(manifestPath, JSON.stringify({ photoId: payload.photoId, baseVersionId: base.id, tasks }), 'utf8');
    const merged = await runAlgorithm(parentId, ['merge', '--input', base.filePath, '--manifest', manifestPath, '--output', privateOutputPath]);
    if (!fs.existsSync(privateOutputPath)) throw new Error('合成算法没有生成输出文件');
    const threshold = Math.max(500, Number(merged.width || 0) * Number(merged.height || 0) * .00005);
    const needsReview = Boolean(merged.needsReview) || Number(merged.conflictPixels || 0) > threshold;
    const committed = await publishProjectFileV2(parentId, privateOutputPath, outputRelativePath, `merge-${mergeFingerprint.slice(0, 40)}`);
    const artifact = committed.outputs[0];
    const registered = await callHostV2(parentId, 'version.create.v2', { commitId: committed.commitId, artifactId: artifact.artifactId, photoId: payload.photoId, parentVersionId: base.id, idempotencyKey: `merge-version-${mergeFingerprint.slice(0, 40)}`, name: String(payload.versionName || '').trim().slice(0, 80) || '团片协作合成', type: 'team-retouch', note: `由 ${merged.mergedCount} 张人物工作图自动合回原尺寸；重叠冲突像素 ${merged.conflictPixels}（复核阈值 ${Math.round(threshold)}）；边界评分 ${Number(merged.seamScore || 0).toFixed(2)}`, status: needsReview ? 'needs-review' : 'draft', isFinal: false });
    const versionId = registered.versionId;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const task of tasks) db.prepare(`UPDATE team_patch_tasks SET status='merged',merged_version_id=?,merge_metrics_json=?,updated_at=? WHERE id=?`).run(versionId, JSON.stringify(merged.metrics?.find(item => item.taskId === task.id) || {}), Date.now(), task.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await appendCommand(storage, { operationId, type: 'patch-merge', state: 'committed', versionId });
    return { ...publicBundle(registered.result), tasks: listTasks(db, payload.photoId).map(publicTask), merge: { ...merged, outputPath: undefined, outputProgressId: outputProgress.id, versionId, needsReview } };
  } catch (error) {
    await fs.promises.rm(privateOutputPath, { force: true }).catch(() => undefined);
    await appendCommand(storage, { operationId, type: 'patch-merge', state: 'rolled-back', error: error.message || String(error) }).catch(() => undefined);
    throw error;
  } finally { await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined); await materialized.cleanup(); }
});
async function migrateAdoptedPrivatePaths(storage) {
  const startedAt = Date.now();
  const legacyRoot = path.resolve(String(storage.adoption?.legacyDataRoot || ''));
  const targetRoot = path.resolve(String(storage.dataPath || ''));
  const receipt = storage.adoption || {};
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'component-storage-adoption' || receipt.state !== 'committed'
    || receipt.componentId !== 'team-retouch' || receipt.fromHostApiVersion !== 1 || receipt.toHostApiVersion !== 2 || receipt.adoptedDataRoot !== true) {
    throw new Error('Host 存储迁移凭据无效，已停止路径改写；请重启应用后重试');
  }
  if (!legacyRoot || legacyRoot === targetRoot || !isInside(path.dirname(legacyRoot), legacyRoot)) throw new Error('Host 存储迁移凭据中的旧目录无效');
  const db = ensureSchema(storage.databasePath);
  try {
    if (db.prepare("SELECT value FROM meta WHERE key='storage_path_adoption_v2'").get()?.value === 'committed') return;
    const specs = [
      ['team_patch_tasks', 'id', ['patch_path', 'mask_path', 'edited_patch_path']],
      ['team_person_assignments', 'rowid', ['edited_patch_path']],
      ['team_task_artifacts', 'id', ['artifact_path']],
    ];
    const updates = []; const verifiedDirectories = new Set(); let byteCount = 0;
    for (const [table, key, fields] of specs) for (const row of db.prepare(`SELECT ${key} AS migration_key,${fields.join(',')} FROM ${table}`).all()) for (const field of fields) {
      const current = String(row[field] || ''); if (!current || !path.isAbsolute(current) || !isInside(legacyRoot, current)) continue;
      const relative = path.relative(legacyRoot, current); const target = path.resolve(targetRoot, relative);
      if (!isInside(targetRoot, target)) throw new Error('旧组件私有路径迁移超出 V2 storage');
      await assertOrdinaryParentSegments(targetRoot, relative, verifiedDirectories);
      const targetStat = await fs.promises.lstat(target).catch(() => null);
      if (!targetStat?.isFile() || targetStat.isSymbolicLink()) throw new Error(`旧组件私有文件副本缺失：${path.basename(current)}`);
      const sourceStat = await fs.promises.lstat(current).catch(() => null);
      if (!sourceStat?.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== targetStat.size) throw new Error(`旧组件私有文件源缺失或大小不一致：${path.basename(current)}`);
      byteCount += targetStat.size;
      updates.push({ table, key, field, previous: current, value: target, migrationKey: row.migration_key });
    }
    migrationMetric('storage-path-adoption-v2', 'validated-metadata', startedAt, { itemCount: updates.length, byteCount, state: 'prepared' });
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of updates) {
        const changed = db.prepare(`UPDATE ${item.table} SET ${item.field}=? WHERE ${item.key}=? AND ${item.field}=?`).run(item.value, item.migrationKey, item.previous);
        if (changed.changes !== 1 && db.prepare(`SELECT ${item.field} value FROM ${item.table} WHERE ${item.key}=?`).get(item.migrationKey)?.value !== item.value) throw new Error('旧组件私有路径在迁移期间发生变化，请稍后重试');
      }
      db.prepare("INSERT INTO meta(key,value) VALUES('storage_path_adoption_v2','committed') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      db.exec('COMMIT');
      migrationMetric('storage-path-adoption-v2', 'database-commit', startedAt, { itemCount: updates.length, byteCount, state: 'committed' });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

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
    const stagingRoot = path.join(storage.dataRoot, '.batch-staging', operationId);
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
      const detectedBatch = await runAlgorithm(parentId, ['detect-batch', '--manifest', manifestPath, '--provider', settings.useGpu === false ? 'cpu' : 'auto', '--oversize-crop-mode', settings.oversizeCropMode === 'expand' ? 'expand' : 'face-centered', '--advanced-mode', 'auto'], { topic: 'patch.detect-batch.progress' });
      const byKey = new Map((detectedBatch.results || []).map(item => [String(item.key), item]));
      const results = [];
      for (const item of entries) {
        const detected = byKey.get(item.key);
        if (!detected?.success) { results.push({ relativePath: item.relativePath, name: item.bundle.photo?.displayName || '', success: false, error: detected?.error || '批量算法没有返回这一项' }); continue; }
        const published = [];
        try {
          const publishedTasks = [];
          for (const task of detected.tasks || []) {
            const working = await publishWorkingImageV2(parentId, storage, task.patchPath, item.base.relativePath, `${operationId}\0${item.bundle.photo.id}\0${task.id || task.personIndex}`);
            const patchTarget = working.privatePath;
            let maskTarget = null;
            if (task.maskPath) { maskTarget = path.join(item.authorized.analysisDirectory, path.basename(task.maskPath)); published.push(await publishStagedFile(task.maskPath, maskTarget, operationId)); }
            publishedTasks.push({ ...task, patchPath: patchTarget, maskPath: maskTarget });
          }
          db.exec('BEGIN IMMEDIATE');
          let replaced;
          try { replaced = replacePatches(db, context, item.bundle.photo.id, item.base.id, publishedTasks); db.exec('COMMIT'); }
          catch (error) { db.exec('ROLLBACK'); throw error; }
          await commitPublished(published);
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
  const storage = await hostStorage(parentId);
  const db = ensureSchema(storage.databasePath);
  try { return await worker(db, storage); } finally { db.close(); }
};

const cleanupGeneratedIdentities = (db, projectId) => {
  const rows = db.prepare(`SELECT identity.id,identity.name FROM team_person_identities identity
    LEFT JOIN team_person_assignments assignment ON assignment.identity_id=identity.id
    WHERE identity.project_id=? GROUP BY identity.id HAVING COUNT(assignment.identity_id)=0`).all(projectId);
  const remove = db.prepare('DELETE FROM team_person_identities WHERE id=?');
  for (const row of rows) if (/^待确认人物 \d+$/.test(String(row.name || ''))) remove.run(row.id);
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

const upsertAssignmentSql = `INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(photo_id,base_version_id,person_index) DO UPDATE SET
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
      const existing = db.prepare('SELECT id FROM team_person_identities WHERE id=? AND project_id=?').get(identityId, projectId);
      if (existing) db.prepare('UPDATE team_person_identities SET name=?,updated_at=? WHERE id=?').run(name, now, identityId);
      else {
        const colors = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#059669', '#0891b2', '#4f46e5'];
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM team_person_identities WHERE project_id=?').get(projectId).count);
        db.prepare('INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(identityId, projectId, name, colors[count % colors.length], now, now);
      }
      const upsert = db.prepare(upsertAssignmentSql);
      for (const item of assignments) {
        const previous = db.prepare('SELECT identity_id,completed FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?').get(String(item.photoId), String(item.baseVersionId), Number(item.personIndex));
        const completed = previous?.identity_id === identityId ? Boolean(previous.completed) : Boolean(item.completed);
        upsert.run(projectId, String(item.photoId), String(item.baseVersionId), Number(item.personIndex), identityId, Number(item.confidence ?? 1), String(item.source || 'manual'), completed ? 1 : 0, now);
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
    const previous = db.prepare('SELECT identity_id,completed FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?').get(String(payload.photoId), String(payload.baseVersionId), Number(payload.personIndex));
    const completed = Boolean(identityId && previous?.identity_id === identityId && payload.completed);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(upsertAssignmentSql).run(projectId, String(payload.photoId), String(payload.baseVersionId), Number(payload.personIndex), identityId, Number(payload.confidence ?? 1), String(payload.source || 'manual'), completed ? 1 : 0, Date.now());
      if (previous?.identity_id && previous.identity_id !== identityId) cleanupGeneratedIdentities(db, projectId);
      db.exec('COMMIT');
      return { success: true };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
};

const confirmIdentityGroup = async (parentId, payload, context) => {
  const snapshot = await workspaceSnapshot(parentId, context);
  const subjects = new Map(snapshot.photos.flatMap(photo => photo.tasks.flatMap(task => (task.members?.length ? task.members : [{ personIndex: task.personIndex }]).map(member => ({
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
          db.prepare('UPDATE team_person_identities SET name=?,updated_at=? WHERE id=?').run(requestedName, now, identityId);
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
        const previous = db.prepare('SELECT identity_id,completed FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?').get(item.photoId, item.baseVersionId, item.personIndex);
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
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE team_person_assignments SET completed=0,completion_kind='',edited_patch_path=NULL,return_missing=0,return_missing_since=NULL,completed_at=NULL WHERE identity_id=? AND project_id=?`).run(String(payload.identityId || ''), projectId);
    db.prepare('DELETE FROM team_person_identities WHERE id=? AND project_id=?').run(String(payload.identityId || ''), projectId);
    db.exec('COMMIT');
    return { success: true };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
});

const readIdentitySimilarities = async (parentId, _payload, context) => {
  const storage = await hostStorage(parentId);
  const payload = await readJson(path.join(storage.dataRoot, 'identity-similarities', `${sha256(context.projectName)}.json`), {});
  return { success: true, similarities: Array.isArray(payload.similarities) ? payload.similarities : [] };
};

const subjectKey = item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`;
const isGeneratedIdentity = identity => /^待确认人物\s+\d+$/.test(String(identity?.name || ''));

const suggestIdentities = async (parentId, _payload, context) => {
  const initial = await workspaceSnapshot(parentId, context);
  const materialized = await materializeMediaForOperation(parentId, initial.photos.map(photo => ({ photoId: photo.photoId, versionId: photo.baseVersionId })));
  const sourceByPhoto = new Map(materialized.items.map(item => [String(item.photo.id), item.versions[0]?.filePath]));
  const subjects = initial.photos.flatMap(photo => photo.tasks.flatMap(task => (
    task.members?.length ? task.members : [{ personIndex: task.personIndex }]
  ).map(member => ({
    key: `${photo.photoId}:${photo.baseVersionId}:${Number(member.personIndex)}`,
    photoId: photo.photoId,
    baseVersionId: photo.baseVersionId,
    personIndex: Number(member.personIndex),
    sourcePath: sourceByPhoto.get(String(photo.photoId)),
    patchPath: task.patchPath,
    bbox: member.bbox || task.bbox,
    faceBox: member.faceBox || null,
  }))));
  if (!subjects.length) { await materialized.cleanup(); throw new Error('项目里还没有已识别的人物'); }
  const storage = await hostStorage(parentId);
  const batchDirectory = path.join(storage.dataRoot, 'batches');
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
  await replaceJsonAtomic(path.join(storage.dataRoot, 'identity-similarities', `${sha256(context.projectName)}.json`), { updatedAt: Date.now(), similarities: suggested.similarities || [] });
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
  await replaceJsonAtomic(path.join(storage.dataRoot, 'workflow-settings', `${sha256(context.projectName)}.json`), { updatedAt: Date.now(), ...workflowSettings });
  return { success: true, workflowSettings };
};

const componentSettings = async (parentId, payload) => payload.action === 'get' ? hostSettings(parentId) : hostSettings(parentId, payload.settings || {});
const listProjectProgress = async parentId => { const value = await callHostV2(parentId, 'project.progress.v2', { action: 'list' }); const graphEdges = Array.isArray(value.graphEdges) ? value.graphEdges : Array.isArray(value.edges) ? value.edges : []; return { success: true, progressFolders: Array.isArray(value.progressFolders) ? value.progressFolders : Array.isArray(value.progress) ? value.progress : [], graphEdges, edges: graphEdges }; };
const createProjectProgress = async (parentId, payload) => {
  const listed = await callHostV2(parentId, 'project.progress.v2', { action: 'list' });
  const raw = payload.progress || payload; const parentProgressId = String(raw.parentProgressId || payload.workflowInputProgressIds?.[0] || (listed.progress || []).find(item => item.nodeRole === 'original')?.id || '');
  if (!parentProgressId) throw new Error('创建输出进度需要一个来源进度');
  const displayName = String(raw.displayName || '团片协作输出').slice(0, 120);
  const relativePath = String(raw.relativePath || safeSegment(displayName, '团片协作输出')).replace(/\\/g, '/');
  const result = await callHostV2(parentId, 'project.progress.v2', { action: 'create', relativePath, mediaKind: raw.mediaKind === 'video' ? 'video' : 'image', versionKey: String(raw.versionKey || Date.now()), parentProgressId, displayName, trackingEnabled: raw.trackingEnabled === true, sourceProgressIds: payload.workflowInputProgressIds || [] });
  return { success: true, progressFolder: result.progress, edges: result.edges || [] };
};
const listProjectMediaPage = async (parentId, payload) => { const value = await callHostV2(parentId, 'project.media.page.v2', { pageSize: Math.min(200, Math.max(1, Number(payload.pageSize) || 200)), ...(payload.cursor ? { cursor: payload.cursor } : {}), kinds: ['image', 'raw'] }); return { success: true, items: value.items || [], hasMore: Boolean(value.page?.hasMore), cursor: value.page?.cursor || null }; };

const archiveReturnedFile = async (source, destination, storageRoot) => {
  if (storageRoot && isInside(storageRoot, source)) {
    try {
      await fs.promises.link(source, destination);
      return 'linked';
    } catch (error) {
      if (error?.code === 'EEXIST') throw error;
    }
  }
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  return 'copied';
};

const markWorkflowReconcilePending = (db, payload, error) => db.prepare(`INSERT INTO team_workflow_reconcile_pending(task_id,photo_id,error,updated_at) VALUES(?,?,?,?)
  ON CONFLICT(task_id) DO UPDATE SET photo_id=excluded.photo_id,error=excluded.error,updated_at=excluded.updated_at`)
  .run(String(payload.taskId), String(payload.photoId), error?.message || String(error || '等待后台更新接力任务'), Date.now());

const storeReturnedPatchInDomain = async (db, storage, sourcePath, payload, context) => {
  const source = path.resolve(sourcePath);
  const sourceStat = await fs.promises.stat(source).catch(() => null);
  const extension = path.extname(source).toLowerCase();
  if (['.heic', '.heif'].includes(extension)) throw new Error('HEIC/HEIF 返图当前无法可靠解码；请先在系统照片或修图软件中导出为 JPEG、PNG、TIFF 或 WebP 后重试');
  if (!sourceStat?.isFile() || !RETURN_IMAGE_EXTENSIONS.has(extension)) throw new Error('返图格式不受支持；请导出为 JPEG、PNG、TIFF 或 WebP');
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE id=? AND photo_id=? AND base_version_id=? AND is_deleted=0').get(String(payload.taskId || ''), String(payload.photoId || ''), String(payload.baseVersionId || ''));
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
      db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status='uploaded',needs_review=?,review_reason=?,updated_at=? WHERE id=?`).run(destination, warnings.length ? 1 : 0, warnings.join('；'), Date.now(), row.id);
      if (payload.complete) {
        const personIndex = Number(payload.personIndex);
        const existingAssignment = db.prepare('SELECT identity_id FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(String(context.projectId), row.photo_id, row.base_version_id, personIndex);
        db.prepare(upsertAssignmentSql).run(String(context.projectId), row.photo_id, row.base_version_id, personIndex, existingAssignment?.identity_id || null, 1, 'manual', 1, Date.now());
        db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,artifact_id=?,edited_patch_path=?,completed=1,completion_kind='returned',return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=? WHERE photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, artifact.stageId, artifact.id, destination, Date.now(), Date.now(), row.photo_id, row.base_version_id, personIndex);
      }
      if (payload.deferReconcile) markWorkflowReconcilePending(db, { taskId: row.id, photoId: row.photo_id }, new Error('返图已确认，等待后台更新接力任务'));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (payload.deferReconcile) void appendCommand(storage, { operationId: crypto.randomUUID(), type: 'workflow-reconcile', state: 'pending-retry', taskId: row.id, photoId: row.photo_id, error: '返图已确认，等待后台更新接力任务' }).catch(() => undefined);
    return {
      success: true,
      artifactPath: destination,
      ...(payload.deferReconcile ? { reconcilePending: true, warning: '返图已确认；下一位接力任务正在后台更新，可以继续核对其他返图' } : {}),
    };
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => undefined);
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
const componentMediaV2 = async (parentId, payload, action = 'variants') => {
  const variant = String(payload.variant || '');
  if (action === 'variants' && !TEAM_MEDIA_VARIANTS.has(variant)) throw new Error('Unsupported team media variant; expected preview or original');
  if (payload.kind === 'original') {
    if (action !== 'variants') return { success: false, error: '原图由项目媒体查看器打开' };
    let media;
    try { media = await callHostV2(parentId, 'project.media.variants.v2', { photoId: payload.photoId, versionId: payload.baseVersionId, variants: [variant] }); }
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
    const match = (session?.result?.matches || []).find(item => String(item.returnId) === String(payload.returnId));
    candidate = String(match?.path || '');
  } else {
    const db = ensureSchema(storage.databasePath);
    try {
      const owner = db.prepare('SELECT project_id FROM team_retouch_photos WHERE photo_id=?').get(String(payload.photoId || ''));
      if (owner && String(owner.project_id) !== String(storage.projectId)) throw new Error('组件媒体 outside the bound project');
      const row = db.prepare('SELECT * FROM team_patch_tasks WHERE id=? AND photo_id=? AND base_version_id=? AND is_deleted=0').get(String(payload.taskId || ''), String(payload.photoId || ''), String(payload.baseVersionId || ''));
      if (!row) throw new Error('组件媒体 outside the bound photo version');
      if (payload.kind === 'working') candidate = String(row.patch_path || '');
      else {
        const assignment = Number.isInteger(Number(payload.personIndex)) ? db.prepare('SELECT edited_patch_path FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?').get(String(payload.photoId), String(payload.baseVersionId), Number(payload.personIndex)) : null;
        candidate = String(assignment?.edited_patch_path || row.edited_patch_path || '');
      }
    } finally { db.close(); }
  }
  if (!candidate) return unavailableMedia(variant, 'history-reference-missing');
  if (!isInside(storage.dataPath, candidate)) throw new Error('组件媒体 outside the bound component storage');
  const relativePath = path.relative(storage.dataPath, candidate).replace(/\\/g, '/');
  if (action === 'open') return callHostV2(parentId, 'component.media.v2', { action: 'open', relativePath });
  let media;
  try { media = await callHostV2(parentId, 'component.media.v2', { action: 'variants', relativePath, variants: [variant] }); }
  catch (error) { const expected = expectedMediaError(error, variant); if (expected) return expected; throw error; }
  const url = media.variants?.[variant]?.url;
  if (!url) return unavailableMedia(variant, 'variant-unavailable');
  return { success: true, variant, url, ...(variant === 'preview' ? { previewUrl: url } : { originalUrl: url }), opaqueRef: media.opaqueRef };
};
const completeIdentity = (parentId, payload, context) => withDomain(parentId, async db => {
  const photoId = String(payload.photoId || '');
  const baseVersionId = String(payload.baseVersionId || '');
  const personIndex = Number(payload.personIndex);
  if (!photoId || !baseVersionId || !Number.isInteger(personIndex)) throw new Error('人物完成状态参数无效');
  const candidates = taskRows(db, photoId, baseVersionId).filter(row => {
    const members = parseJson(row.members_json, []).length ? parseJson(row.members_json, []) : [{ personIndex: row.person_index }];
    return members.some(member => Number(member.personIndex) === personIndex);
  });
  const row = payload.taskId ? candidates.find(item => String(item.id) === String(payload.taskId)) : candidates[0];
  if (!row || (!payload.taskId && candidates.length > 1)) throw new Error('人物完成状态 outside the bound photo version，或无法唯一绑定到组件修图任务');
  const stage = db.prepare('SELECT * FROM team_task_stages WHERE task_id=? AND person_index=?').get(row.id, personIndex);
  const existing = db.prepare('SELECT * FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').get(String(context.projectId), photoId, baseVersionId, personIndex);
  let removedPath = '';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(upsertAssignmentSql).run(String(context.projectId), photoId, baseVersionId, personIndex, existing?.identity_id || null, Number(existing?.confidence || 1), existing?.source || 'manual', payload.completed === false ? 0 : 1, Date.now());
    if (payload.completed === false) {
      if (existing?.artifact_id) {
        const artifact = db.prepare('SELECT * FROM team_task_artifacts WHERE id=? AND task_id=? AND is_deleted=0').get(existing.artifact_id, row.id);
        if (artifact) { removedPath = artifact.artifact_path; db.prepare('UPDATE team_task_artifacts SET is_deleted=1 WHERE id=?').run(artifact.id); }
      }
      const predecessor = currentTaskArtifact(db, row.id)?.artifact_path || null;
      db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,artifact_id=NULL,completed=0,completion_kind='',edited_patch_path=NULL,completed_at=NULL,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, stage?.id || null, Date.now(), String(context.projectId), photoId, baseVersionId, personIndex);
      db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status=?,updated_at=? WHERE id=?`).run(predecessor, predecessor ? 'uploaded' : 'exported', Date.now(), row.id);
    } else {
      db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,completed=1,completion_kind=?,return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, stage?.id || null, String(payload.completionKind || 'no-retouch'), Date.now(), Date.now(), String(context.projectId), photoId, baseVersionId, personIndex);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (removedPath) await fs.promises.rm(removedPath, { force: true }).catch(() => undefined);
  return finalizeReconcile(parentId, context, { taskId: row.id, photoId: row.photo_id }, { success: true, completed: payload.completed !== false, taskId: row.id, personIndex }, db);
});
const publicWorkspace = value => ({
  ...value,
  photos: (value?.photos || []).map(photo => ({
    ...Object.fromEntries(Object.entries(photo).filter(([field]) => !['sourcePath', 'originalFilePath', 'previewUrl'].includes(field))),
    tasks: (photo.tasks || []).map(task => Object.fromEntries(Object.entries(task).filter(([field]) => !['patchPath', 'maskPath', 'editedPatchPath', 'uploadPath', 'returnedPath', 'previewUrl', 'patchUrl'].includes(field)))),
  })),
  assignments: (value?.assignments || []).map(assignment => Object.fromEntries(Object.entries(assignment).filter(([field]) => !['editedPatchPath', 'returnedPath'].includes(field)))),
});

const migrateWorkflowArtifacts = async (parentId, payload) => {
  const storage = await hostStorage(parentId);
  const artifacts = createTeamWorkflowArtifactService({ crypto, fs, getWorkspaceDataRoot: () => path.dirname(storage.dataRoot), path, writeLog: () => undefined });
  return artifacts.migrate('', payload.from || {}, payload.to || {});
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
    ]).slice(0, MAX_ITEMS);
    const versionByPhoto = new Map([...registered.map(row => [String(row.photo_id), String(row.base_version_id)]), ...assignments.map(row => [String(row.photo_id), String(row.base_version_id)])]);
    const media = candidatePhotoIds.length
      ? await readMedia(parentId, { mediaRefs: candidatePhotoIds.map(photoId => ({ photoId, ...(versionByPhoto.get(String(photoId)) ? { versionId: versionByPhoto.get(String(photoId)) } : {}) })) })
      : { items: [] };
    const bundles = new Map((media.items || []).map(item => [String(item.photo?.id || ''), item]));
    const registrations = new Map(registered.map(row => [String(row.photo_id), row]));
    const tasksByPhoto = new Map();
    if (candidatePhotoIds.length) {
      const placeholders = candidatePhotoIds.map(() => '?').join(',');
      for (const row of db.prepare(`SELECT * FROM team_patch_tasks WHERE is_deleted=0 AND photo_id IN (${placeholders}) ORDER BY created_at,person_index`).all(...candidatePhotoIds)) {
        const values = tasksByPhoto.get(String(row.photo_id)) || [];
        values.push(row);
        tasksByPhoto.set(String(row.photo_id), values);
      }
    }
    const photos = [];
    for (const [photoId, bundle] of bundles) {
      const rows = tasksByPhoto.get(photoId) || [];
      const registration = registrations.get(photoId);
      if (!rows.length && !registration) continue;
      const grouped = new Map();
      for (const row of rows) {
        const values = grouped.get(String(row.base_version_id)) || [];
        values.push(row);
        grouped.set(String(row.base_version_id), values);
      }
      const currentVersionId = String(bundle.photo?.currentVersionId || '');
      let baseVersionId = String(registration?.base_version_id || '');
      if (!baseVersionId) baseVersionId = grouped.has(currentVersionId) ? currentVersionId : [...grouped.keys()].at(-1) || '';
      const base = (bundle.versions || []).find(version => String(version.id) === baseVersionId);
      if (!base) continue;
      photos.push({
        photoId, baseVersionId, name: bundle.photo?.displayName || path.parse(bundle.photo?.originalName || base.relativePath || '').name,
        relativePath: base.relativePath || '', relativePathState: base.relativePathState || 'unresolvable', fileMissing: Boolean(base.fileMissing), mediaRef: { photoId, versionId: baseVersionId, relativePath: base.relativePath || '' },
        tasks: (grouped.get(baseVersionId) || []).map(serializeTask),
        excludedPersonCount: Number(db.prepare('SELECT COUNT(*) AS count FROM team_person_exclusions WHERE project_id=? AND photo_id=? AND base_version_id=?').get(projectId, photoId, baseVersionId)?.count || 0),
      });
    }
    const identities = db.prepare('SELECT id,name,color,created_at AS createdAt,updated_at AS updatedAt FROM team_person_identities WHERE project_id=? ORDER BY created_at').all(projectId);
    const normalizedAssignments = assignments.map(row => ({
      photoId: row.photo_id, baseVersionId: row.base_version_id, personIndex: row.person_index,
      identityId: row.identity_id, confidence: row.confidence, source: row.source,
      completed: Boolean(row.completed) && !Boolean(row.return_missing), completionKind: row.completion_kind,
      editedPatchPath: row.edited_patch_path, returnMissing: Boolean(row.return_missing),
      returnMissingSince: row.return_missing_since, completedAt: row.completed_at, updatedAt: row.updated_at,
    }));
    const settings = readJsonFile(path.join(storage.dataRoot, 'workflow-settings', `${sha256(context.projectName)}.json`)) || {};
    const identityIds = new Set(identities.map(identity => String(identity.id)));
    const preferredIdentityOrder = uniqueText(settings.preferredIdentityOrder).filter(id => identityIds.has(id));
    const requestedSameWeek = new Set(uniqueText(settings.sameWeekIdentityIds));
    const sameWeekIdentityIds = preferredIdentityOrder.slice(1).filter(id => requestedSameWeek.has(id));
    const { manifest } = await workflowDirectoryResolver(storage, context);
    const generatedSettings = manifest?.workflowSettings;
    const generatedOrder = uniqueText(generatedSettings?.preferredIdentityOrder);
    const generatedSameWeek = new Set(uniqueText(generatedSettings?.sameWeekIdentityIds));
    const workflowItems = (manifest?.groups || []).flatMap(group => group.items || []);
    const workflowAvailableItems = workflowItems.filter(item => item.available && item.relativePath);
    return {
      success: true, photos, identities, assignments: normalizedAssignments,
      workflowGenerated: Boolean(manifest && Number(manifest.version) >= 2),
      workflowNeedsRegeneration: Boolean(manifest && generatedSettings && (JSON.stringify(generatedOrder) !== JSON.stringify(preferredIdentityOrder)
        || JSON.stringify(generatedOrder.slice(1).filter(id => generatedSameWeek.has(id))) !== JSON.stringify(sameWeekIdentityIds))),
      workflowAvailableKeys: workflowAvailableItems.map(item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowAvailableSubjectKeys: workflowAvailableItems.map(item => `${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowParticipantKeys: workflowItems.map(item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowParticipantSubjectKeys: workflowItems.map(item => `${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowSettings: { preferredIdentityOrder, preferredIdentityId: preferredIdentityOrder[0] || undefined, sameWeekIdentityIds },
    };
  } finally { db.close(); }
};

const writeJsonAtomic = async (target, value) => {
  const pending = `${target}.${crypto.randomUUID()}.tmp`;
  const backup = `${target}.${crypto.randomUUID()}.backup`;
  let backedUp = false;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.writeFile(pending, JSON.stringify(value, null, 2), 'utf8');
    if (fs.existsSync(target)) { await fs.promises.rename(target, backup); backedUp = true; }
    await fs.promises.rename(pending, target);
    if (backedUp) await fs.promises.rm(backup, { force: true });
  } catch (error) {
    await fs.promises.rm(pending, { force: true }).catch(() => undefined);
    if (backedUp && !fs.existsSync(target)) await fs.promises.rename(backup, target).catch(() => undefined);
    throw error;
  }
};

const workflowDirectoryResolver = createWorkflowManifestResolver({ crypto, fs, path, writeJsonAtomic });
const workflowScopeForStorage = (storage, context) => workflowDirectoryResolver(storage, context);
const workflowScope = async (parentId, context) => workflowScopeForStorage(await hostStorage(parentId), context);
const readWorkflowManifest = (parentId, context) => workflowScope(parentId, context);

const reportTask = async (parentId, operationId, action, update = {}, topic = '') => hostTask(parentId, operationId, action, { title: '生成团片协作工作流', operationId, ...update }, topic);

const generateWorkflow = async (parentId, payload, context) => {
  const operationId = String(payload.operationId || crypto.randomUUID());
  const key = `${context.projectId}:${context.projectStatus}:${context.projectName}`;
  const existing = workflowJobs.get(key);
  if (existing?.state === 'running') return { success: true, alreadyRunning: true, operationId: existing.operationId };
  const job = { operationId, cancelled: false, state: 'running', phase: 'preparing', progress: 0, message: '正在准备工作流程' };
  workflowJobs.set(key, job);
  const jobStorage = await hostStorage(parentId); const jobStatePath = path.join(jobStorage.dataPath, 'workflow-jobs', `${sha256(key)}.json`);
  let jobPersistence = Promise.resolve(); const persistJob = () => { const snapshot = { ...job }; jobPersistence = jobPersistence.catch(() => undefined).then(() => replaceJsonAtomic(jobStatePath, snapshot)); return jobPersistence; };
  await persistJob();
  const publish = async update => {
    Object.assign(job, update);
    await persistJob();
    const host = await reportTask(parentId, operationId, update.state === 'completed' ? 'complete' : update.state === 'failed' ? 'failed' : 'report', update, 'workflow.progress');
    if (host?.cancelled) job.cancelled = true;
  };
  let stagingDirectory = '';
  let backupDirectory = '';
  let checkpointReady = false;
  try {
    await reportTask(parentId, operationId, 'start', { message: job.message, checkpoint: { projectId: context.projectId, operationId } }, 'workflow.progress');
    const scope = await workflowScope(parentId, context);
    const previousManifest = scope.manifest;
    if ((fs.existsSync(scope.outputDirectory) || previousManifest) && !payload.replace) return { success: true, requiresConfirmation: true, operationId };
    const snapshot = await workspaceSnapshot(parentId, context);
    const projectDirectory = path.dirname(scope.outputDirectory);
    stagingDirectory = path.join(projectDirectory, '.photoflow-team-workflow-staging');
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
    if (fs.existsSync(stagingDirectory) && checkpoint?.fingerprint !== fingerprint) await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
    await fs.promises.mkdir(stagingDirectory, { recursive: true });
    for (const group of plan.manifestGroups) if ((group.items || []).some(item => item.available)) await fs.promises.mkdir(path.join(stagingDirectory, group.relativePath), { recursive: true });
    await writeJsonAtomic(checkpointPath, { version: 1, fingerprint, projectName: context.projectName, status: context.projectStatus, updatedAt: Date.now() });
    checkpointReady = true;
    await publish({ phase: 'copying', totalFiles: plan.files.length, totalBytes: plan.totalBytes, message: checkpoint?.fingerprint === fingerprint ? '正在续传工作图…' : '正在复制工作图…' });
    await copyWorkflowPlan({
      files: plan.files, totalBytes: plan.totalBytes, copyFileAtomic, concurrency: 3,
      isCancelled: () => job.cancelled,
      onProgress: update => { void publish({ ...update, message: update.phase === 'resuming' ? '正在复用已完成的工作图…' : update.phase === 'finalizing' ? '正在提交工作流程…' : '正在复制工作图…' }); },
    });
    if (job.cancelled) throw Object.assign(new Error('工作流程生成已取消'), { code: CANCELLED_CODE });
    const manifest = { version: 2, projectId: String(context.projectId), projectName: context.projectName, status: context.projectStatus, generatedAt: Date.now(), workflowSettings, groups: plan.manifestGroups };
    if (fs.existsSync(scope.outputDirectory)) {
      backupDirectory = path.join(projectDirectory, `.photoflow-team-workflow-previous-${crypto.randomUUID()}`);
      await fs.promises.rename(scope.outputDirectory, backupDirectory);
    }
    try { await fs.promises.rename(stagingDirectory, scope.outputDirectory); stagingDirectory = ''; }
    catch (error) {
      if (backupDirectory && fs.existsSync(backupDirectory) && !fs.existsSync(scope.outputDirectory)) await fs.promises.rename(backupDirectory, scope.outputDirectory).catch(() => undefined);
      throw error;
    }
    try {
      const replacements = new Map(Object.entries(previousManifest?.outputOwnership || {}).map(([relativePath, value]) => [relativePath, value]));
      if (!replacements.size && previousManifest?.groups?.length) {
        const legacyOutputs = previousManifest.groups.flatMap(group => (group.items || []).filter(item => item.available && item.relativePath).map(item => ({ relativePath: `团片协作/${String(item.relativePath).replace(/\\/g, '/')}` })));
        if (legacyOutputs.length) {
          const adopted = await callHostV2(parentId, 'project.output.v2', { action: 'adopt', migrationId: `workflow-${sha256(String(context.projectId)).slice(0, 24)}`, outputs: legacyOutputs });
          for (const item of adopted.outputs || []) replacements.set(item.relativePath, { commitId: adopted.commitId, artifactId: item.artifactId, sha256: item.sha256 });
        }
      }
      const outputFiles = manifest.groups.flatMap(group => (group.items || []).filter(item => item.available && item.relativePath).map(item => ({ sourcePath: path.resolve(scope.outputDirectory, item.relativePath), outputRelativePath: `团片协作/${String(item.relativePath).replace(/\\/g, '/')}` })));
      const committed = await publishProjectFilesV2(parentId, outputFiles, `workflow-${sha256(fingerprint).slice(0, 24)}`, replacements);
      manifest.outputOwnership = Object.fromEntries((committed.outputs || []).map(item => [item.relativePath, { commitId: committed.commitId, artifactId: item.artifactId, sha256: item.sha256 }]));
      await writeJsonAtomic(scope.manifestPath, manifest);
    }
    catch (error) {
      await fs.promises.rm(scope.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (backupDirectory && fs.existsSync(backupDirectory)) await fs.promises.rename(backupDirectory, scope.outputDirectory).catch(() => undefined);
      throw error;
    }
    checkpointReady = false;
    if (backupDirectory) await fs.promises.rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    await publish({ state: 'completed', phase: 'complete', progress: 100, completedFiles: plan.files.length, totalFiles: plan.files.length, copiedBytes: plan.totalBytes, totalBytes: plan.totalBytes, message: '工作流程生成完成' });
    return { success: true, operationId, count: plan.files.length, groupCount: manifest.groups.length };
  } catch (error) {
    const cancelled = job.cancelled || error?.code === CANCELLED_CODE;
    job.state = cancelled ? 'cancelled' : 'failed';
    job.message = cancelled ? '工作流程生成已取消，可在下次继续' : error.message || String(error);
    await persistJob().catch(() => undefined);
    await reportTask(parentId, operationId, cancelled ? 'cancel' : 'failed', { ...job, error: cancelled ? '' : job.message }, 'workflow.progress').catch(() => undefined);
    if (backupDirectory && fs.existsSync(backupDirectory)) {
      const scope = await workflowScope(parentId, context).catch(() => null);
      if (scope && !fs.existsSync(scope.outputDirectory)) await fs.promises.rename(backupDirectory, scope.outputDirectory).catch(() => undefined);
    }
    if (stagingDirectory && !checkpointReady) await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    return { success: false, cancelled, resumable: checkpointReady, operationId, error: cancelled ? undefined : job.message };
  }
};

const workflowStatus = async (parentId, _payload, context) => {
  const reconciliation = await retryPendingWorkflowReconciles(parentId, context).catch(() => ({ pendingCount: 0, recoveredCount: 0 }));
  const key = `${context.projectId}:${context.projectStatus}:${context.projectName}`;
  const job = workflowJobs.get(key) || null;
  if (!job) {
    const storage = await hostStorage(parentId); const recovered = await readJson(path.join(storage.dataPath, 'workflow-jobs', `${sha256(key)}.json`), null);
    return { success: true, job: recovered, reconciliation };
  }
  const host = await reportTask(parentId, job.operationId, 'status').catch(() => null);
  return { success: true, job: { ...job, task: host?.task || undefined }, reconciliation };
};

const cancelWorkflow = async (parentId, payload) => {
  const operationId = String(payload.operationId || '');
  const job = [...workflowJobs.values()].find(item => item.operationId === operationId && item.state === 'running');
  if (job) { job.cancelled = true; job.phase = 'cancelling'; job.message = '正在安全停止，已完成文件可续传'; }
  await reportTask(parentId, operationId, 'cancel', job || {}).catch(() => undefined);
  return { success: true, cancelled: Boolean(job) };
};

const exportWorkflow = async (parentId, payload, context, open = false) => {
  let { outputDirectory, manifest } = await readWorkflowManifest(parentId, context);
  if (!manifest) throw new Error('请先生成工作流程');
  let group = (manifest.groups || []).find(item => Number(item.week) === Number(payload.week) && String(item.identityId || '') === String(payload.identityId || ''));
  const availableCount = () => (group?.items || []).filter(item => item.available && item.relativePath && isInside(outputDirectory, path.resolve(outputDirectory, item.relativePath)) && fs.existsSync(path.resolve(outputDirectory, item.relativePath))).length;
  let directory = path.resolve(outputDirectory, String(group?.relativePath || ''));
  const expectedAvailable = (group?.items || []).some(item => item.available);
  if (group?.relativePath && isInside(outputDirectory, directory) && (expectedAvailable && (!fs.existsSync(directory) || !availableCount()))) {
    for (const taskId of uniqueText((group.items || []).map(item => item.taskId))) await reconcileWorkflowTaskChain(parentId, context, taskId);
    ({ outputDirectory, manifest } = await readWorkflowManifest(parentId, context));
    group = (manifest?.groups || []).find(item => Number(item.week) === Number(payload.week) && String(item.identityId || '') === String(payload.identityId || ''));
    directory = path.resolve(outputDirectory, String(group?.relativePath || ''));
  }
  if (!group?.relativePath || !isInside(outputDirectory, directory) || !fs.existsSync(directory)) throw new Error('任务文件夹不存在，且无法从当前工作图与返图记录安全重建');
  const count = availableCount();
  if (!count) throw new Error('本周任务仍在等待上一位返图');
  if (open) {
    const first = (group.items || []).find(item => item.available && item.relativePath);
    const owned = first ? manifest.outputOwnership?.[`团片协作/${String(first.relativePath).replace(/\\/g, '/')}`] : null;
    if (!owned) throw new Error('任务输出尚未进入 Host V2 ownership，请重新生成工作流程');
    await callHostV2(parentId, 'dialogs.v2', { kind: 'revealOutput', commitId: owned.commitId, artifactId: owned.artifactId });
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
const readReviewFromStorage = async (storage, context) => {
  const target = await reviewTargetForStorage(storage, context);
  let session = await readJson(target.sessionPath, null);
  if (session && Number(session.version || 1) < 2) {
    session = { ...session, version: 2, updatedAt: Date.now(), result: { ...session.result, matches: (session.result?.matches || []).map(match => ({ matchConfidence: match.matchConfidence || match.confidence || 'unknown', editEvidence: match.editEvidence || { reallyModified: false, legacyUnknown: true }, returnWarnings: match.returnWarnings || ['旧版返图审核记录缺少修改证据，请人工确认'], needsReview: match.accepted !== true, ...match })) } };
    await writeJsonAtomic(target.sessionPath, session);
  }
  return { ...target, session };
};
const readReview = async (parentId, context) => readReviewFromStorage(await hostStorage(parentId), context);
const retireReviewTarget = async target => {
  const retiredDirectory = `${target.directory}.completed-${crypto.randomUUID()}`;
  try {
    await fs.promises.rename(target.directory, retiredDirectory);
    void fs.promises.rm(retiredDirectory, { recursive: true, force: true }).catch(() => undefined);
  } catch {
    await fs.promises.rm(target.directory, { recursive: true, force: true });
  }
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
  for (const photo of snapshot.photos || []) for (const task of photo.tasks || []) for (const member of task.members?.length ? task.members : [{ personIndex: task.personIndex }]) {
    const key = `${photo.photoId}:${photo.baseVersionId}:${Number(member.personIndex)}:${task.id}`;
    if (requestedKeys.size && !requestedKeys.has(key)) continue;
    const assignment = assignments.get(`${photo.photoId}:${photo.baseVersionId}:${Number(member.personIndex)}`);
    const identity = identities.get(String(assignment?.identityId || ''));
    if (!identity || assignment?.completed) continue;
    candidates.push({ taskId: task.id, photoId: photo.photoId, baseVersionId: photo.baseVersionId, personIndex: Number(member.personIndex), identityId: identity.id, photoName: photo.name, personName: identity.name, originalPath: photo.sourcePath, patchPath: task.editedPatchPath && fs.existsSync(task.editedPatchPath) ? task.editedPatchPath : task.patchPath });
  }
  return candidates.filter(item => item.patchPath && fs.existsSync(item.patchPath));
};

const readyWorkflowCandidateFromDb = (db, context, payload) => {
  const task = db.prepare(`SELECT task.* FROM team_patch_tasks task
    JOIN team_retouch_photos registered ON registered.photo_id=task.photo_id AND registered.base_version_id=task.base_version_id
    WHERE task.id=? AND task.photo_id=? AND task.base_version_id=? AND registered.project_id=? AND task.is_deleted=0`)
    .get(String(payload.taskId || ''), String(payload.photoId || ''), String(payload.baseVersionId || ''), String(context.projectId));
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

const runMatcher = async (returned, candidates, onProgress = () => undefined) => {
  const runtime = resolveAlgorithmRuntime();
  const manifestPath = path.join(path.dirname(returned[0].path), `match-${crypto.randomUUID()}.json`);
  await fs.promises.writeFile(manifestPath, JSON.stringify({ returned, candidates }), 'utf8');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(runtime.command, [...runtime.argsPrefix, 'match-batch', '--manifest', manifestPath], { cwd: __dirname, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let result;
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message?.type === 'progress') onProgress(message);
        else if (message?.type === 'result') result = message.result;
        else if (message && typeof message === 'object') result = message;
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => {
        lines.close();
        if (code !== 0) { reject(new Error(stderr.trim() || `返图匹配进程退出：${code}`)); return; }
        if (!result) { reject(new Error('返图匹配进程没有返回结果')); return; }
        resolve(result);
      });
    });
  } finally { await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined); }
};

const resolveWorkflowTaskBinding = (db, projectId, taskId, chain) => {
  const task = db.prepare(`SELECT task.* FROM team_patch_tasks task
    JOIN team_retouch_photos registered ON registered.photo_id=task.photo_id AND registered.base_version_id=task.base_version_id
    WHERE task.id=? AND task.is_deleted=0 AND registered.project_id=?`).get(String(taskId), String(projectId));
  if (!task) throw new Error('工作流程引用的修图任务不属于当前项目');
  if (chain.some(entry => String(entry.item.baseVersionId) !== String(task.base_version_id))) throw new Error('工作流程 task 链跨越了错误的照片版本');
  return { task, legacyPhotoIds: uniqueText(chain.map(entry => entry.item.photoId).filter(photoId => String(photoId) !== String(task.photo_id))) };
};

const reconcileWorkflowTaskChain = async (parentId, context, taskId, existingDb = null) => {
  const scope = await readWorkflowManifest(parentId, context);
  if (!scope.manifest) return { reconciled: false, reason: 'workflow-missing' };
  const chain = [];
  for (const [groupIndex, group] of (scope.manifest.groups || []).entries()) for (const [itemIndex, item] of (group.items || []).entries()) if (String(item.taskId) === String(taskId)) chain.push({ group, item, groupIndex, itemIndex });
  chain.sort((a, b) => Number(a.group.week) - Number(b.group.week) || a.groupIndex - b.groupIndex || a.itemIndex - b.itemIndex);
  if (!chain.length) return { reconciled: false, reason: 'task-not-in-workflow' };
  const reconcile = async db => {
    const { task, legacyPhotoIds } = resolveWorkflowTaskBinding(db, context.projectId, taskId, chain);
    if (legacyPhotoIds.length) {
      for (const entry of chain) entry.item.photoId = task.photo_id;
      await writeJsonAtomic(scope.manifestPath, scope.manifest);
      try {
        const storage = await hostStorage(parentId);
        await appendCommand(storage, { operationId: crypto.randomUUID(), type: 'workflow-reconcile', state: 'legacy-photo-id-repaired', taskId: task.id, projectId: String(context.projectId), baseVersionId: task.base_version_id, previousPhotoIds: legacyPhotoIds, photoId: task.photo_id, itemCount: chain.length });
      } catch { /* The canonical repair is already durable; audit logging is best effort. */ }
    }
    const artifactGrant = await artifactsScope(parentId, { photoId: task.photo_id, baseVersionId: task.base_version_id });
    const artifactRoots = [artifactGrant.dataDirectory, artifactGrant.deliveryDirectory, artifactGrant.legacyDataRoot].filter(Boolean);
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
          ? db.prepare('SELECT * FROM team_task_artifacts WHERE id=? AND task_id=? AND is_deleted=0').get(boundAssignment.artifact_id, task.id)
          : db.prepare('SELECT * FROM team_task_artifacts WHERE task_id=? AND person_index=? AND is_deleted=0 ORDER BY created_at DESC,id DESC LIMIT 1').get(task.id, personIndex);
        if (!artifact || !assertSource(artifact.artifact_path)) {
          completed = false;
          db.prepare('UPDATE team_person_assignments SET return_missing=1,return_missing_since=COALESCE(return_missing_since,?),updated_at=? WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?').run(Date.now(), Date.now(), String(context.projectId), task.photo_id, task.base_version_id, personIndex);
        }
      }
      stages.push({ entry, personIndex, completed, inputPath: sourcePath, artifact });
      const stage = db.prepare('SELECT id FROM team_task_stages WHERE task_id=? AND person_index=?').get(task.id, personIndex);
      if (stage) db.prepare('UPDATE team_task_stages SET state=?,updated_at=? WHERE id=?').run(completed ? 'complete' : activeIndex < 0 ? 'ready' : 'pending', Date.now(), stage.id);
      if (!completed) { if (activeIndex < 0) activeIndex = index; continue; }
      if (artifact) sourcePath = artifact.artifact_path;
    }
    if (activeIndex >= 0) {
      for (const [index, stage] of stages.entries()) {
        const stored = db.prepare('SELECT id FROM team_task_stages WHERE task_id=? AND person_index=?').get(task.id, stage.personIndex);
        if (stored) db.prepare('UPDATE team_task_stages SET state=?,updated_at=? WHERE id=?').run(index === activeIndex ? 'ready' : index < activeIndex ? 'complete' : 'pending', Date.now(), stored.id);
      }
    }
    let activeTarget = '';
    const activeSource = activeIndex >= 0 ? stages[activeIndex].inputPath : '';
    const priorOutputs = [];
    for (const [index, stage] of stages.entries()) {
      const relativePath = String(stage.entry.item.relativePath || '');
      if (relativePath) priorOutputs.push({ index, relativePath: `团片协作/${relativePath.replace(/\\/g, '/')}`, ownership: scope.manifest.outputOwnership?.[`团片协作/${relativePath.replace(/\\/g, '/')}`] || null });
      const currentTarget = relativePath ? path.resolve(scope.outputDirectory, relativePath) : '';
      if (!currentTarget || !isInside(scope.outputDirectory, currentTarget)) throw new Error('工作流程阶段路径超出授权输出目录');
      stage.entry.item.available = false;
      if (index === activeIndex) {
        const parsed = path.parse(currentTarget);
        activeTarget = path.join(parsed.dir, `${parsed.name}${path.extname(activeSource) || parsed.ext || '.png'}`);
        if (!isInside(scope.outputDirectory, activeTarget)) throw new Error('工作流程发布路径超出授权输出目录');
        if (path.resolve(activeTarget) !== path.resolve(currentTarget)) await fs.promises.rm(currentTarget, { force: true }).catch(() => undefined);
      } else {
        await fs.promises.rm(currentTarget, { force: true }).catch(() => undefined);
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
        await fs.promises.rm(activeTarget, { force: true }).catch(() => undefined);
        await copyFileAtomic(activeSource, activeTarget);
      }
      const active = stages[activeIndex].entry.item;
      active.relativePath = path.relative(scope.outputDirectory, activeTarget).replace(/\\/g, '/');
      active.available = true;
    }
    const ownership = { ...(scope.manifest.outputOwnership || {}) };
    for (const previous of priorOutputs) if (!previous.ownership) {
      try {
        const adopted = await callHostV2(parentId, 'project.output.v2', { action: 'adopt', migrationId: `relay-${sha256(`${task.id}\0${previous.relativePath}`).slice(0, 24)}`, outputs: [{ relativePath: previous.relativePath }] });
        const output = adopted.outputs?.[0]; if (output) previous.ownership = { commitId: adopted.commitId, artifactId: output.artifactId, sha256: output.sha256 };
      } catch { /* A missing historical relay file is reconstructed below when active. */ }
    }
    const activeRelativePath = activeIndex >= 0 ? `团片协作/${stages[activeIndex].entry.item.relativePath}` : '';
    if (activeIndex >= 0) {
      const prior = priorOutputs.find(item => item.relativePath === activeRelativePath)?.ownership || ownership[activeRelativePath] || null;
      const committed = await publishProjectFileV2(parentId, activeTarget, activeRelativePath, `relay-${sha256(`${task.id}\0${activeIndex}\0${await fileSha256(activeTarget)}`).slice(0, 24)}`, prior);
      const output = committed.outputs[0]; ownership[activeRelativePath] = { commitId: committed.commitId, artifactId: output.artifactId, sha256: output.sha256 };
    }
    for (const previous of priorOutputs) if (previous.relativePath !== activeRelativePath && previous.ownership) {
      await callHostV2(parentId, 'project.output.v2', { action: 'delete', previousCommitId: previous.ownership.commitId, previousArtifactId: previous.ownership.artifactId, expectedDigest: previous.ownership.sha256, idempotencyKey: `relay-delete-${sha256(`${task.id}\0${previous.relativePath}`).slice(0, 20)}` }).catch(() => undefined);
      delete ownership[previous.relativePath];
    }
    scope.manifest.outputOwnership = ownership;
    await writeJsonAtomic(scope.manifestPath, scope.manifest);
    return { reconciled: true, taskId: task.id, activePersonIndex: activeIndex >= 0 ? stages[activeIndex].personIndex : null, complete: activeIndex < 0 };
  };
  return existingDb ? reconcile(existingDb) : withDomain(parentId, reconcile);
};

const queueWorkflowReconcile = async (parentId, payload, error) => {
  const storage = await hostStorage(parentId);
  const db = ensureSchema(storage.databasePath);
  try { markWorkflowReconcilePending(db, payload, error); }
  finally { db.close(); }
  await appendCommand(storage, { operationId: crypto.randomUUID(), type: 'workflow-reconcile', state: 'pending-retry', taskId: payload.taskId, photoId: payload.photoId, error: error.message || String(error) }).catch(() => undefined);
};

const finalizeReconcile = async (parentId, context, payload, result = { success: true }, existingDb = null) => {
  try {
    await reconcileWorkflowTaskChain(parentId, context, payload.taskId, existingDb);
    if (existingDb) existingDb.prepare('DELETE FROM team_workflow_reconcile_pending WHERE task_id=?').run(String(payload.taskId));
    else await withDomain(parentId, db => db.prepare('DELETE FROM team_workflow_reconcile_pending WHERE task_id=?').run(String(payload.taskId)));
    return result;
  } catch (error) {
    await queueWorkflowReconcile(parentId, payload, error);
    return { ...result, success: true, reconcilePending: true, warning: '操作已安全保存，但工作流程目录暂未更新；组件将在下次加载时自动重试，无需重复操作' };
  }
};

const storeReturnedAndReconcile = (parentId, sourcePath, payload, context) => withPhotoOperation(payload.photoId, async () => {
  const registered = await storeReturnedPatch(parentId, sourcePath, payload, context);
  return finalizeReconcile(parentId, context, payload, registered);
});
const storeReturnedPatch = (parentId, sourcePath, payload, context) => withDomain(parentId, (db, storage) => storeReturnedPatchInDomain(db, storage, sourcePath, payload, context));

const retryPendingWorkflowReconciles = async (parentId, context, maxItems = 1) => {
  const pending = await withDomain(parentId, db => db.prepare(`SELECT pending.task_id,pending.photo_id FROM team_workflow_reconcile_pending pending
    JOIN team_patch_tasks task ON task.id=pending.task_id
    JOIN team_retouch_photos registered ON registered.photo_id=task.photo_id AND registered.base_version_id=task.base_version_id
    WHERE registered.project_id=? ORDER BY pending.updated_at LIMIT ?`).all(String(context.projectId), Math.max(1, Number(maxItems) || 1)));
  let recovered = 0;
  for (const item of pending) await withPhotoOperation(item.photo_id, async () => {
    try {
      await reconcileWorkflowTaskChain(parentId, context, item.task_id);
      await withDomain(parentId, db => db.prepare('DELETE FROM team_workflow_reconcile_pending WHERE task_id=?').run(item.task_id));
      recovered += 1;
    } catch (error) {
      await withDomain(parentId, db => db.prepare('UPDATE team_workflow_reconcile_pending SET error=?,updated_at=? WHERE task_id=?').run(error.message || String(error), Date.now(), item.task_id)).catch(() => undefined);
    }
  });
  return { pendingCount: Math.max(0, pending.length - recovered), recoveredCount: recovered };
};

const returnBatch = async (parentId, payload, context, workflowMode) => {
  const returnOperationId = String(payload.operationId || `returns-${crypto.randomUUID()}`);
  let lastProgress = 0;
  let materialized;
  let staged;
  let matcherProgressReports = Promise.resolve();
  const progressUpdate = (phase, progress, message, extra = {}) => ({ state: 'running', phase, progress, message, ...extra });
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
    if (existing?.session) throw new Error('还有一批返图等待确认，请先继续处理或放弃');
    const snapshot = await workspaceSnapshot(parentId, context);
    throwIfCancelled();
    await report('report', progressUpdate('reading', 14, '正在整理可匹配的协作任务'));
    const requestedPaths = new Set(uniqueText(payload.relativePaths));
    let candidates = workflowMode ? readyWorkflowCandidates(snapshot, payload.items) : (snapshot.photos || []).filter(photo => !requestedPaths.size || requestedPaths.has(String(photo.relativePath || ''))).flatMap(photo => (photo.tasks || []).map(task => ({ taskId: task.id, photoId: photo.photoId, baseVersionId: photo.baseVersionId, personIndex: task.personIndex, photoName: photo.name, personName: task.personName, patchPath: task.editedPatchPath && fs.existsSync(task.editedPatchPath) ? task.editedPatchPath : task.patchPath })).filter(item => item.patchPath && fs.existsSync(item.patchPath)));
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
    const returned = staged.items.map((item, index) => ({ returnId: `${workflowMode ? 'workflow-' : ''}return-${index + 1}`, path: item.path, sourceName: item.name, inputName: path.basename(item.path) }));
    const stagedSources = new Set(staged.items.map(item => path.resolve(item.path)));
    const matched = await runMatcher(returned, candidates, message => {
      const matcherProgress = Math.max(0, Math.min(100, Number(message.progress) || 0));
      matcherProgressReports = matcherProgressReports.catch(() => undefined).then(() => report('report', progressUpdate('matching', 40 + matcherProgress * 0.42, String(message.message || '正在比对返图内容')))).catch(() => undefined);
    });
    await matcherProgressReports;
    throwIfCancelled();
    await report('report', progressUpdate('matching', 82, '内容匹配完成，正在整理结果'));
    const accepted = [];
    const high = (matched.matches || []).filter(item => item.confidence === 'high' && item.taskId);
    for (const [index, match] of high.entries()) {
      throwIfCancelled();
      if (!stagedSources.has(path.resolve(match.path))) throw new Error('Matched return escaped its component staging grant');
      const registered = await storeReturnedAndReconcile(parentId, match.path, { photoId: match.photoId, baseVersionId: match.baseVersionId, taskId: match.taskId, personIndex: match.personIndex, complete: workflowMode, matchConfidence: match.matchConfidence, editEvidence: match.editEvidence, returnWarnings: match.returnWarnings }, context);
      accepted.push({ ...match, path: undefined, patchPath: undefined, accepted: true, reconcilePending: Boolean(registered.reconcilePending), warning: registered.warning });
      await report('report', progressUpdate('importing', 82 + 12 * (index + 1) / Math.max(1, high.length), `正在归档返图 ${index + 1}/${high.length}`));
    }
    const acceptedById = new Map(accepted.map(item => [String(item.returnId), item]));
    let matches = (matched.matches || []).map(item => acceptedById.get(String(item.returnId)) || { ...item, path: undefined, patchPath: undefined, accepted: false });
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
        const session = { version: 2, id: reviewId, projectId: String(context.projectId), projectName: context.projectName, status: context.projectStatus, createdAt: Date.now(), updatedAt: Date.now(), result: { ...result, reviewSessionId: reviewId, matches } };
        await fs.promises.writeFile(path.join(pending, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
        await fs.promises.rename(pending, target.directory);
        finalResult = presentReview(session);
      } catch (error) { await fs.promises.rm(pending, { recursive: true, force: true }).catch(() => undefined); throw error; }
    }
    await report('complete', { state: 'completed', phase: 'complete', progress: 100, message: '返图处理完成' });
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

const reviewGet = async (parentId, _payload, context) => {
  const { session } = await readReview(parentId, context);
  return { success: true, review: session && (!session.projectId || String(session.projectId) === String(context.projectId)) && String(session.status) === String(context.projectStatus) ? presentReview(session) : null };
};
const reviewDiscard = async (parentId, payload, context) => {
  const target = await readReview(parentId, context);
  if (target.session && String(target.session.id) !== String(payload.reviewSessionId)) throw new Error('待确认返图批次已经变化');
  if (target.session) await fs.promises.rm(target.directory, { recursive: true, force: true });
  return { success: true, discarded: Boolean(target.session) };
};
const reviewIgnore = async (parentId, payload, context) => {
  const target = await readReview(parentId, context);
  if (!target.session || String(target.session.id) !== String(payload.reviewSessionId)) throw new Error('待确认返图批次已经变化');
  const match = target.session.result.matches.find(item => String(item.returnId) === String(payload.returnId));
  if (!match || match.accepted) throw new Error('这张返图已经处理');
  target.session.result.matches = target.session.result.matches.filter(item => item !== match);
  target.session.result.reviewCount = target.session.result.matches.filter(item => !item.accepted).length;
  if (match.path && isInside(target.directory, match.path)) await fs.promises.rm(match.path, { force: true });
  if (target.session.result.reviewCount) await writeJsonAtomic(target.sessionPath, target.session);
  else await fs.promises.rm(target.directory, { recursive: true, force: true });
  return { success: true, reviewSessionCompleted: !target.session.result.reviewCount };
};
const legacyProjectMigrationOperations = new Map();
const projectMigrationMetaKey = projectId => `legacy_project_artifacts_v2_state:${sha256(String(projectId)).slice(0, 24)}`;
const projectMigrationCommittedKey = projectId => `legacy_project_artifacts_v2:${sha256(String(projectId)).slice(0, 24)}`;
const migrationStateFromDb = (db, projectId, fallback = {}) => {
  const stored = parseJson(db.prepare('SELECT value FROM meta WHERE key=?').get(projectMigrationMetaKey(projectId))?.value, {});
  const committed = db.prepare('SELECT value FROM meta WHERE key=?').get(projectMigrationCommittedKey(projectId))?.value === 'committed'
    || db.prepare("SELECT value FROM meta WHERE key='legacy_project_artifacts_v2'").get()?.value === 'committed';
  return { state: committed ? 'committed' : String(stored.state || fallback.state || 'pending'), phase: String(stored.phase || fallback.phase || 'outputs'), processedCount: Math.max(0, Number(stored.processedCount) || 0), pendingCount: Math.max(0, Number(stored.pendingCount ?? fallback.pendingCount) || 0), attemptCount: Math.max(0, Number(stored.attemptCount) || 0), lastError: String(stored.lastError || ''), errorCategory: String(stored.errorCategory || ''), retryable: stored.retryable !== false, updatedAt: Math.max(0, Number(stored.updatedAt) || 0) };
};
const migrationErrorState = error => {
  const code = String(error?.code || '');
  if (code.includes('NOT_FOUND')) return { errorCategory: 'legacy-output-missing', lastError: '旧项目输出文件缺失；已暂停自动迁移，请恢复原文件后手动重试' };
  if (code.includes('CONFLICT')) return { errorCategory: 'legacy-output-conflict', lastError: '旧项目输出已变化或存在冲突；已暂停自动迁移，请确认文件后手动重试' };
  if (code.includes('PERMISSION') || code.includes('INVALID_REQUEST')) return { errorCategory: 'legacy-output-boundary', lastError: '旧项目输出不在当前项目安全边界内；已保留历史引用，请检查项目位置后手动重试' };
  return { errorCategory: 'legacy-output-unavailable', lastError: '旧项目输出暂时不可用；已暂停自动迁移，请保留原文件后手动重试' };
};
const writeMigrationState = (db, projectId, state) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(projectMigrationMetaKey(projectId), JSON.stringify({ ...state, updatedAt: Date.now() }));
const pendingLegacyArtifactItems = (db, dataPath, projectId) => {
  const items = [];
  for (const row of db.prepare(`SELECT task.id,task.photo_id,task.base_version_id,task.patch_path,task.mask_path,task.edited_patch_path
    FROM team_patch_tasks task JOIN team_retouch_photos registered
      ON registered.photo_id=task.photo_id AND registered.base_version_id=task.base_version_id
    WHERE task.is_deleted=0 AND registered.project_id=? ORDER BY task.id`).all(String(projectId))) {
    for (const field of ['patch_path', 'mask_path', 'edited_patch_path']) {
      const current = String(row[field] || '');
      if (current && path.isAbsolute(current) && !isInside(dataPath, current)) items.push({ row, field, current });
    }
  }
  return items;
};
const legacyProjectMigrationStatus = async parentId => {
  const storage = await rawHostStorage(parentId);
  if (storage.adoption?.state === 'pending') return { state: 'pending', phase: 'host-storage-adoption', processedCount: 0, pendingCount: 1, attemptCount: 0, lastError: '', retryable: true, updatedAt: Number(storage.adoption.startedAt) || 0 };
  const db = ensureSchema(storage.databasePath);
  try {
    const projectId = String(storage.projectId); const pendingCount = pendingLegacyArtifactItems(db, storage.dataPath, projectId).length;
    const maintenancePendingCount = Number(db.prepare(`SELECT COUNT(*) count FROM team_workflow_reconcile_pending pending
      JOIN team_patch_tasks task ON task.id=pending.task_id
      JOIN team_retouch_photos registered ON registered.photo_id=task.photo_id AND registered.base_version_id=task.base_version_id
      WHERE registered.project_id=?`).get(projectId)?.count) || 0;
    const state = migrationStateFromDb(db, projectId, { state: pendingCount ? 'pending' : 'committed', pendingCount });
    return { ...state, state: state.state === 'committed' && maintenancePendingCount ? 'pending' : state.state, phase: state.state === 'committed' && maintenancePendingCount ? 'workflow-reconcile' : state.phase, maintenancePendingCount };
  } finally { db.close(); }
};
const migrateLegacyProjectArtifacts = async (parentId, context, control = {}) => {
  const storage = await rawHostStorage(parentId);
  if (storage.adoption?.state === 'pending') return { state: 'pending', phase: 'host-storage-adoption', processedCount: 0, pendingCount: 1, attemptCount: 0, lastError: '', retryable: true, updatedAt: Number(storage.adoption.startedAt) || 0 };
  const projectId = String(storage.projectId || context.projectId); const key = `${storage.databasePath}\0${projectId}`;
  if (legacyProjectMigrationOperations.has(key)) return legacyProjectMigrationOperations.get(key);
  const operation = (async () => {
    const startedAt = Date.now();
    const db = ensureSchema(storage.databasePath);
    try {
      if (control.signal?.aborted || Date.now() >= Number(control.deadlineAt || Infinity)) return migrationStateFromDb(db, projectId);
      const pending = pendingLegacyArtifactItems(db, storage.dataPath, projectId);
      if (!pending.length) {
        const target = await workflowScope(parentId, context);
        const legacyReview = path.join(storage.dataPath, 'workflow-return-reviews', sha256(context.projectName));
        const legacyReviewSource = storage.adoption?.legacyDataRoot ? path.join(storage.adoption.legacyDataRoot, 'workflow-return-reviews', sha256(context.projectName)) : legacyReview;
        if (!fs.existsSync(target.reviewDirectory) && fs.existsSync(legacyReview)) await fs.promises.cp(legacyReview, target.reviewDirectory, { recursive: true, errorOnExist: true, force: false });
        const reviewSessionPath = path.join(target.reviewDirectory, 'session.json'); const reviewSession = await readJson(reviewSessionPath, null);
        if (reviewSession) {
          const rewrite = value => Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([field, item]) => [field, rewrite(item)])) : typeof value === 'string' && path.isAbsolute(value) && isInside(legacyReviewSource, value) ? path.join(target.reviewDirectory, path.relative(legacyReviewSource, value)) : value;
          await writeJsonAtomic(reviewSessionPath, rewrite(reviewSession));
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(projectMigrationCommittedKey(projectId), 'committed');
          const prior = migrationStateFromDb(db, projectId); writeMigrationState(db, projectId, { ...prior, state: 'committed', phase: 'complete', pendingCount: 0, retryable: false });
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        const state = migrationStateFromDb(db, projectId); migrationMetric('legacy-project-artifacts-v2', 'complete', startedAt, { itemCount: state.processedCount, state: state.state }); return state;
      }
      const item = pending[0]; const { row, field, current } = item;
      try {
        const migrationId = `artifact-${sha256(`${row.id}\0${field}\0${current}`).slice(0, 24)}`;
        const adopted = await callHostV2(parentId, 'project.output.v2', { action: 'adopt', migrationId, outputs: [{ sourcePath: current }] });
        const output = adopted.outputs?.[0]; if (!output) throw new Error('旧项目输出文件暂时缺失');
        const imported = await callHostV2(parentId, 'project.output.v2', { action: 'materializeOwned', commitId: adopted.commitId, artifactId: output.artifactId });
        if (control.signal?.aborted) return migrationStateFromDb(db, projectId);
        const targetStat = await fs.promises.lstat(imported.privatePath).catch(() => null);
        if (!targetStat?.isFile() || targetStat.isSymbolicLink() || !isInside(storage.dataPath, imported.privatePath)) throw new Error('Host 返回的旧项目输出副本无效');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`UPDATE team_patch_tasks SET ${field}=? WHERE id=? AND ${field}=?`).run(imported.privatePath, row.id, current);
          db.prepare('UPDATE team_person_assignments SET edited_patch_path=? WHERE task_id=? AND edited_patch_path=?').run(imported.privatePath, row.id, current);
          db.prepare('UPDATE team_task_artifacts SET artifact_path=? WHERE task_id=? AND artifact_path=?').run(imported.privatePath, row.id, current);
          const prior = migrationStateFromDb(db, projectId); writeMigrationState(db, projectId, { state: 'pending', phase: 'outputs', processedCount: prior.processedCount + 1, pendingCount: Math.max(0, pending.length - 1), attemptCount: prior.attemptCount + 1, lastError: '', errorCategory: '', retryable: true });
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        const state = migrationStateFromDb(db, projectId); migrationMetric('legacy-project-artifacts-v2', 'output-checkpoint', startedAt, { itemCount: 1, byteCount: targetStat.size, state: state.state }); return state;
      } catch (error) {
        const prior = migrationStateFromDb(db, projectId); const diagnostic = migrationErrorState(error); writeMigrationState(db, projectId, { ...prior, state: 'pending', phase: 'paused', pendingCount: pending.length, attemptCount: prior.attemptCount + 1, ...diagnostic, retryable: true });
        migrationMetric('legacy-project-artifacts-v2', 'deferred', startedAt, { itemCount: 0, state: 'pending' });
        return migrationStateFromDb(db, projectId);
      }
    } finally { db.close(); }
  })().finally(() => legacyProjectMigrationOperations.delete(key));
  legacyProjectMigrationOperations.set(key, operation); return operation;
};
const returnConfirm = async (parentId, payload, context) => {
  const storage = await hostStorage(parentId);
  const target = await readReviewFromStorage(storage, context);
  if (!target.session || String(target.session.id) !== String(payload.reviewSessionId)) throw new Error('待确认返图批次已经变化');
  const match = target.session.result.matches.find(item => String(item.returnId) === String(payload.returnId));
  if (!match || match.accepted) throw new Error('这张返图已经处理');
  if (!match.path || !isInside(target.directory, match.path)) throw new Error('Reviewed return escaped its component review grant');
  const registered = await withPhotoOperation(payload.photoId, async () => {
    const db = ensureSchema(storage.databasePath);
    try {
      const candidate = readyWorkflowCandidateFromDb(db, context, payload);
      if (!candidate || String(candidate.taskId) !== String(payload.taskId)) throw new Error('候选任务当前不可确认');
      return await storeReturnedPatchInDomain(db, storage, match.path, { photoId: candidate.photoId, baseVersionId: candidate.baseVersionId, taskId: candidate.taskId, personIndex: candidate.personIndex, complete: true, deferReconcile: true }, context);
    } finally { db.close(); }
  });
  const candidate = { photoId: String(payload.photoId), baseVersionId: String(payload.baseVersionId), taskId: String(payload.taskId), personIndex: Number(payload.personIndex) };
  match.accepted = true; match.confidence = 'manual'; match.photoId = candidate.photoId; match.baseVersionId = candidate.baseVersionId; match.taskId = candidate.taskId; match.personIndex = candidate.personIndex;
  target.session.result.reviewCount = target.session.result.matches.filter(item => !item.accepted).length;
  target.session.result.acceptedCount = target.session.result.matches.filter(item => item.accepted).length;
  if (target.session.result.reviewCount) await writeJsonAtomic(target.sessionPath, target.session);
  else await retireReviewTarget(target);
  return { success: true, warning: registered.warning, reconcilePending: Boolean(registered.reconcilePending) };
};

const handlers = {
  'team.project.get.v1': async (parentId, _payload, context) => {
    const startedAt = Date.now();
    const migration = await legacyProjectMigrationStatus(parentId);
    if (migration.phase === 'host-storage-adoption') {
      migrationMetric('team-project-get-v1', 'storage-adoption-pending', startedAt, { itemCount: 0, state: migration.state });
      return { success: true, photos: [], identities: [], assignments: [], workflowGenerated: false, workflowNeedsRegeneration: false, workflowAvailableKeys: [], workflowAvailableSubjectKeys: [], workflowSettings: { preferredIdentityOrder: [], sameWeekIdentityIds: [] }, migration };
    }
    const snapshot = publicWorkspace(await workspaceSnapshot(parentId, context));
    migrationMetric('team-project-get-v1', 'snapshot', startedAt, { itemCount: snapshot.photos?.length || 0, state: migration.state });
    return { ...snapshot, migration };
  },
  'team.project.migrate-step.v1': async (parentId, _payload, context) => {
    const migration = await migrateLegacyProjectArtifacts(parentId, context, { signal: context.signal, deadlineAt: Date.now() + 1000 });
    if (migration.state === 'committed' && !context.signal?.aborted) await retryPendingWorkflowReconciles(parentId, context, 1);
    return legacyProjectMigrationStatus(parentId);
  },
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
          registerPhoto(db, context, photoId, String(base.id));
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    return publicWorkspace(await workspaceSnapshot(parentId, context));
  },
  'team.project.remove-photo.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => removeProjectPhoto(parentId, payload, context)),
  'team.identity.save.v1': saveIdentity,
  'team.identity.assign.v1': assignIdentity,
  'team.identity.confirm-group.v1': async (parentId, payload, context) => publicWorkspace(await confirmIdentityGroup(parentId, payload, context)),
  'team.identity.delete.v1': deleteIdentity,
  'team.person.exclude.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => excludePerson(parentId, payload, context)),
  'team.patch.get.v1': getPatchBundle,
  'team.patch.detect.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => detectPhoto(parentId, payload, context)),
  'team.patch.detect-batch.v1': detectBatch,
  'team.patch.update.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => updatePatch(parentId, payload, context)),
  'team.patch.delete.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => deletePatch(parentId, payload, context)),
  'team.patch.cleanup.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => cleanupPatches(parentId, payload, context)),
  'team.patch.upload.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => uploadPatch(parentId, payload, context)),
  'team.patch.remove-upload.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => removeUpload(parentId, payload, context)),
  'team.patch.merge.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => mergePatches(parentId, payload, context)),
  'team.identity.similarities.v1': readIdentitySimilarities,
  'team.identity.suggest.v1': suggestIdentities,
  'team.identity.complete.v1': (parentId, payload, context) => withPhotoOperation(payload.photoId, () => completeIdentity(parentId, payload, context)),
  'team.media.page.v1': (parentId, payload) => listProjectMediaPage(parentId, payload),
  'team.media.authorize.v1': (parentId, payload) => componentMediaV2(parentId, mediaRequest(payload)),
  'team.patch.open.v1': (parentId, payload) => componentMediaV2(parentId, mediaRequest({ ...payload, kind: 'working' }), 'open'),
  'team.workflow.settings.save.v1': saveWorkflowSettings,
  'team.workflow.status.v1': workflowStatus,
  'team.workflow.cancel.v1': cancelWorkflow,
  'team.workflow.generate.v1': generateWorkflow,
  'team.workflow.export.v1': (parentId, payload, context) => exportWorkflow(parentId, payload, context, false),
  'team.workflow.open-export.v1': (parentId, payload, context) => exportWorkflow(parentId, payload, context, true),
  'team.workflow.return-review.get.v1': reviewGet,
  'team.workflow.return-review.discard.v1': reviewDiscard,
  'team.workflow.return-review.ignore.v1': reviewIgnore,
  'team.workflow.return-batch.v1': (parentId, payload, context) => returnBatch(parentId, payload, context, true),
  'team.workflow.return-confirm.v1': returnConfirm,
  'team.patch.select-returns.v1': selectReturns,
  'team.patch.return-batch.v1': (parentId, payload, context) => returnBatch(parentId, payload, context, false),
  'team.workflow.artifact.migrate.v1': migrateWorkflowArtifacts,
  'team.progress.list.v1': parentId => listProjectProgress(parentId),
  'team.progress.create.v1': (parentId, payload) => createProjectProgress(parentId, payload),
  'team.settings.get.v1': parentId => componentSettings(parentId, { action: 'get' }),
  'team.settings.update.v1': (parentId, payload) => componentSettings(parentId, { action: 'update', settings: payload }),
  'team.advanced.status.v1': parentId => advancedRuntimeStatus(parentId),
  'team.advanced.preflight.v1': async parentId => {
    try { return await lifecycleAction(parentId, 'preflight'); }
    catch (error) { return { success: false, state: 'repair-needed', errorCategory: 'installation-prerequisite', message: String(error?.message || '增强人物检测安装条件未满足') }; }
  },
  'team.advanced.install.v1': async (parentId, payload) => {
    const installed = await lifecycleAction(parentId, payload.repair === true ? 'repair' : 'install');
    advancedRuntimeProbeCache = null;
    const probe = await advancedRuntimeStatus(parentId, { refresh: true });
    if (!probe.advancedAvailable) return { ...installed, success: false, state: probe.state, error: probe.advancedError || probe.message };
    return { ...installed, advancedAvailable: true, state: 'ready' };
  },
  'team.advanced.uninstall.v1': async parentId => { const result = await lifecycleAction(parentId, 'uninstall'); advancedRuntimeProbeCache = null; return result; },
};

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
    for (const [capabilityId, pending] of pendingCapabilities) if (pending.parentId === requestId) {
      pendingCapabilities.delete(capabilityId);
      pending.reject(Object.assign(new Error('团片请求已超时取消，可从上次安全进度重试'), { code: 'COMPONENT_REQUEST_CANCELLED' }));
    }
    return;
  }
  if (frame?.type !== 'request') return;
  const id = String(frame.id || '');
  const handler = handlers[String(frame.method || '')];
  const control = new AbortController(); activeRequestControls.set(id, control);
  Promise.resolve(handler ? handler(id, frame.payload || {}, { ...(frame.context || {}), signal: control.signal }) : Promise.reject(new Error('Unknown team-retouch service method')))
    .then(result => writeFrame({ type: 'response', id, ok: true, result }))
    .catch(error => writeFrame({ type: 'response', id, ok: false, error: error.message || String(error) }))
    .finally(() => activeRequestControls.delete(id));
});

writeFrame({ type: 'ready', protocolVersion: 1 });
process.once('exit', () => { for (const child of activeAlgorithms) child.kill(); });
};

if (require.main === module) startService();
module.exports = { ensureSchema, startService, capabilityError, migrateAdoptedPrivatePaths, migrateLegacyProjectArtifacts, migrationStateFromDb, migrationErrorState, pendingLegacyArtifactItems, projectMigrationCommittedKey, projectMigrationMetaKey, writeMigrationState, resolveAlgorithmRuntime, resolveWorkflowTaskBinding, runMatcher };
