const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { CANCELLED_CODE, buildWorkflowPlan, copyWorkflowPlan } = require('./workflow-generation.cjs');
const { createTeamWorkflowArtifactService } = require('./workflow-artifact.cjs');

const MAX_ITEMS = 2000;
const RETURN_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']);
const pendingCapabilities = new Map();
const activeAlgorithms = new Set();
const workflowJobs = new Map();
const photoOperations = new Map();
let nextCapabilityId = 1;

const writeFrame = value => process.stdout.write(`${JSON.stringify(value)}\n`);
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

const callHost = (parentId, method, payload = {}) => new Promise((resolve, reject) => {
  const id = `cap-${nextCapabilityId++}`;
  pendingCapabilities.set(id, { resolve, reject });
  writeFrame({ type: 'capability', id, parentId, method, payload });
});

const ensureSchema = databasePath => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
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
  db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version','4') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  return db;
};
const fileSha256 = filePath => new Promise((resolve, reject) => {
  const digest = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  input.on('error', reject);
  input.on('data', chunk => digest.update(chunk));
  input.on('end', () => resolve(digest.digest('hex')));
});

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
  const testEngine = String(process.env.PHOTOFLOW_TEAM_TEST_ENGINE || '');
  const executable = testEngine ? process.execPath : path.join(__dirname, process.platform === 'win32' ? 'team-retouch.exe' : 'team-retouch');
  if ((!testEngine && !fs.existsSync(executable)) || (testEngine && !fs.existsSync(testEngine))) { reject(new Error('团片组件算法运行时不存在')); return; }
  const child = spawn(executable, [...(testEngine ? [testEngine] : []), ...args.map(value => String(value))], {
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
    if (message?.type === 'progress' && topic) void callHost(parentId, 'tasks.report.v1', { topic, value: { ...progress, ...message } }).then(report => {
      if (report?.cancelled && !cancelled) { cancelled = true; child.kill(); }
    }).catch(() => undefined);
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
    if (!grants.has(key)) grants.set(key, await callHost(parentId, 'project.output.authorize.v1', { operation: 'artifacts', photoId: row.photo_id, baseVersionId: row.base_version_id }));
    const grant = grants.get(key);
    for (const filePath of [row.patch_path, row.mask_path, row.edited_patch_path].filter(Boolean)) {
      if (![grant.dataDirectory, grant.deliveryDirectory].some(root => isInside(root, filePath))) throw new Error('团片文件超出组件授权目录');
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
  const media = await callHost(parentId, 'project.media.read.v1', { photoIds: [payload.photoId] });
  const bundle = media.items?.[0];
  const base = bundle?.versions?.find(version => String(version.id) === String(payload.baseVersionId));
  if (!base || base.fileMissing || !fs.existsSync(base.filePath)) throw new Error('基础版本文件不存在');
  assertDecodableImage(base.filePath);
  const authorized = await callHost(parentId, 'project.output.authorize.v1', { operation: 'artifacts', photoId: payload.photoId, baseVersionId: payload.baseVersionId });
  const settings = (await callHost(parentId, 'component.settings.v1', { action: 'get' })).settings || {};
  const storage = await callHost(parentId, 'component.storage.v1', { namespace: 'domain' });
  const db = ensureSchema(storage.databasePath);
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
      const patchTarget = path.join(authorized.deliveryDirectory, path.basename(task.patchPath));
      published.push(await publishStagedFile(task.patchPath, patchTarget, operationId));
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
  } finally { await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined); db.close(); }
};

const getPatchBundle = async (parentId, payload, context) => {
  const media = await callHost(parentId, 'project.media.read.v1', { relativePaths: [String(payload.relativePath || '')] });
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
      const media = await callHost(parentId, 'project.media.read.v1', { photoIds: [row.photo_id] });
      const base = media.items?.[0]?.versions?.find(item => String(item.id) === String(row.base_version_id));
      if (!base || !fs.existsSync(base.filePath)) throw new Error('基础图片不存在，无法重新裁图');
      const authorized = await callHost(parentId, 'project.output.authorize.v1', { operation: 'artifacts', photoId: row.photo_id, baseVersionId: row.base_version_id });
      await fs.promises.mkdir(authorized.dataDirectory, { recursive: true });
      const manifestPath = path.join(authorized.dataDirectory, `recrop-${operationId}.json`);
      stagedPath = path.join(authorized.dataDirectory, `recrop-${operationId}.png`);
      await fs.promises.writeFile(manifestPath, JSON.stringify({ tasks: [{ ...serializeTask(row), crop, patchPath: stagedPath }] }), 'utf8');
      await appendCommand(storage, { operationId, type: 'recrop', state: 'prepared', taskId: row.id });
      try { await runAlgorithm(parentId, ['restore', '--input', base.filePath, '--manifest', manifestPath], { timeoutMs: 10 * 60 * 1000 }); }
      finally { await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined); }
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
  const choice = await callHost(parentId, 'dialogs.open.v1', { kind: 'image', title: `上传 ${row.person_name} 的修图结果` });
  if (choice.cancelled) return { success: true, cancelled: true, tasks: listTasks(db, row.photo_id).map(publicTask) };
  const authorized = await callHost(parentId, 'project.output.authorize.v1', { operation: 'artifacts', photoId: row.photo_id, baseVersionId: row.base_version_id });
  await fs.promises.mkdir(authorized.uploadDirectory, { recursive: true });
  const operationId = crypto.randomUUID();
  const stagedPath = path.join(authorized.uploadDirectory, `.${row.id}-${operationId}.staging${path.extname(choice.filePath).toLowerCase()}`);
  const outputPath = path.join(authorized.uploadDirectory, `${row.id}-${operationId}${path.extname(choice.filePath).toLowerCase()}`);
  await appendCommand(storage, { operationId, type: 'patch-upload', state: 'prepared', taskId: row.id });
  let committed = false;
  try {
    await fs.promises.copyFile(choice.filePath, stagedPath, fs.constants.COPYFILE_EXCL);
    await fs.promises.rename(stagedPath, outputPath);
    db.exec('BEGIN IMMEDIATE');
    try {
      const artifact = createArtifact(db, row, personIndex, outputPath, 'manual-upload');
      db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status='uploaded',updated_at=? WHERE id=?`).run(outputPath, Date.now(), row.id);
      db.prepare(`${upsertAssignmentSql}`).run(String(context.projectId), row.photo_id, row.base_version_id, personIndex, null, 1, 'manual', 1, Date.now());
      db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,artifact_id=?,edited_patch_path=?,completed=1,completion_kind='retouched',return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=? WHERE photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, artifact.stageId, artifact.id, outputPath, Date.now(), Date.now(), row.photo_id, row.base_version_id, personIndex);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await appendCommand(storage, { operationId, type: 'patch-upload', state: 'committed' });
    committed = true;
    await reconcileWorkflowTaskChain(parentId, context, row.id, db);
    return { success: true, tasks: listTasks(db, row.photo_id).map(publicTask) };
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
  await reconcileWorkflowTaskChain(parentId, context, row.id, db);
  return { success: true, tasks: listTasks(db, row.photo_id).map(publicTask), cleanupQueued: Boolean(removedPath) };
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
  const media = await callHost(parentId, 'project.media.read.v1', { photoIds: [payload.photoId] });
  const bundle = media.items?.[0];
  const base = bundle?.versions?.find(item => String(item.id) === String(payload.baseVersionId));
  if (!base || !fs.existsSync(base.filePath)) throw new Error('基础版本文件不存在');
  const tasks = listTasks(db, payload.photoId, payload.baseVersionId).filter(task => task.editedPatchPath && fs.existsSync(task.editedPatchPath));
  if (!tasks.length) throw new Error('请至少上传一张工作图的修图结果');
  await assertAuthorizedArtifacts(parentId, taskRows(db, payload.photoId, payload.baseVersionId));
  const output = await callHost(parentId, 'project.output.authorize.v1', { operation: 'merge', photoId: payload.photoId, baseVersionId: payload.baseVersionId, outputProgressId: payload.outputProgressId });
  await fs.promises.mkdir(output.mergeDirectory, { recursive: true });
  const operationId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const manifestPath = path.join(output.mergeDirectory, `merge-${operationId}.json`);
  await appendCommand(storage, { operationId, type: 'patch-merge', state: 'prepared', photoId: payload.photoId, outputPath: output.outputPath });
  try {
    await fs.promises.writeFile(manifestPath, JSON.stringify({ photoId: payload.photoId, baseVersionId: base.id, tasks }), 'utf8');
    const merged = await runAlgorithm(parentId, ['merge', '--input', base.filePath, '--manifest', manifestPath, '--output', output.outputPath]);
    if (!fs.existsSync(output.outputPath)) throw new Error('合成算法没有生成输出文件');
    const threshold = Math.max(500, Number(merged.width || 0) * Number(merged.height || 0) * .00005);
    const needsReview = Boolean(merged.needsReview) || Number(merged.conflictPixels || 0) > threshold;
    const registered = await callHost(parentId, 'version.register.v1', { versionId, photoId: payload.photoId, parentVersionId: base.id, versionName: String(payload.versionName || '').trim().slice(0, 80) || `团片协作合成 ${output.nextNumber}`, versionType: 'team-retouch', note: `由 ${merged.mergedCount} 张人物工作图自动合回原尺寸；重叠冲突像素 ${merged.conflictPixels}（复核阈值 ${Math.round(threshold)}）；边界评分 ${Number(merged.seamScore || 0).toFixed(2)}`, status: needsReview ? 'needs-review' : 'draft', isFinal: false, filePath: output.outputPath });
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const task of tasks) db.prepare(`UPDATE team_patch_tasks SET status='merged',merged_version_id=?,merge_metrics_json=?,updated_at=? WHERE id=?`).run(versionId, JSON.stringify(merged.metrics?.find(item => item.taskId === task.id) || {}), Date.now(), task.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await appendCommand(storage, { operationId, type: 'patch-merge', state: 'committed', versionId });
    return { ...publicBundle(registered), tasks: listTasks(db, payload.photoId).map(publicTask), merge: { ...merged, outputPath: undefined, outputProgressId: output.outputProgressId, versionId, needsReview } };
  } catch (error) {
    await fs.promises.rm(output.outputPath, { force: true }).catch(() => undefined);
    await appendCommand(storage, { operationId, type: 'patch-merge', state: 'rolled-back', error: error.message || String(error) }).catch(() => undefined);
    throw error;
  } finally { await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined); }
});

const detectBatch = async (parentId, payload, context) => {
  const relativePaths = uniqueText(payload.relativePaths);
  if (!relativePaths.length) throw new Error('请至少选择一张图片');
  if (relativePaths.length > MAX_ITEMS) throw new Error('批量检测图片过多');
  const media = await callHost(parentId, 'project.media.read.v1', { relativePaths });
  const prepared = (media.items || []).map((bundle, index) => ({
    bundle, relativePath: bundle.relativePath || relativePaths[index],
    base: bundle.versions?.find(item => String(item.id) === String(bundle.photo?.currentVersionId)) || bundle.versions?.find(item => item.isCurrent) || bundle.versions?.at(-1),
  })).filter(item => item.bundle.photo?.id && item.base?.id);
  return withPhotoOperations(prepared.map(item => item.bundle.photo.id), async () => {
    const storage = await callHost(parentId, 'component.storage.v1', { namespace: 'domain' });
    const settings = (await callHost(parentId, 'component.settings.v1', { action: 'get' })).settings || {};
    const operationId = crypto.randomUUID();
    const stagingRoot = path.join(storage.dataRoot, '.batch-staging', operationId);
    const manifestPath = path.join(stagingRoot, 'manifest.json');
    const db = ensureSchema(storage.databasePath);
    const entries = [];
    try {
      for (const [index, item] of prepared.entries()) {
        assertDecodableImage(item.base.filePath);
        const authorized = await callHost(parentId, 'project.output.authorize.v1', { operation: 'artifacts', photoId: item.bundle.photo.id, baseVersionId: item.base.id });
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
            const patchTarget = path.join(item.authorized.deliveryDirectory, path.basename(task.patchPath));
            published.push(await publishStagedFile(task.patchPath, patchTarget, operationId));
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
    } finally { db.close(); await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined); }
  });
};

const readJsonFile = filePath => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
};

const withDomain = async (parentId, worker) => {
  const storage = await callHost(parentId, 'component.storage.v1', { namespace: 'domain' });
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
  const media = photoIds.length ? await callHost(parentId, 'project.media.read.v1', { photoIds }) : { items: [] };
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
  const storage = await callHost(parentId, 'component.storage.v1', { namespace: 'domain' });
  const payload = await readJson(path.join(storage.dataRoot, 'identity-similarities', `${sha256(context.projectName)}.json`), {});
  return { success: true, similarities: Array.isArray(payload.similarities) ? payload.similarities : [] };
};

const subjectKey = item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`;
const isGeneratedIdentity = identity => /^待确认人物\s+\d+$/.test(String(identity?.name || ''));

const suggestIdentities = async (parentId, _payload, context) => {
  const initial = await workspaceSnapshot(parentId, context);
  const subjects = initial.photos.flatMap(photo => photo.tasks.flatMap(task => (
    task.members?.length ? task.members : [{ personIndex: task.personIndex }]
  ).map(member => ({
    key: `${photo.photoId}:${photo.baseVersionId}:${Number(member.personIndex)}`,
    photoId: photo.photoId,
    baseVersionId: photo.baseVersionId,
    personIndex: Number(member.personIndex),
    sourcePath: photo.sourcePath,
    patchPath: task.patchPath,
    bbox: member.bbox || task.bbox,
    faceBox: member.faceBox || null,
  }))));
  if (!subjects.length) throw new Error('项目里还没有已识别的人物');
  const storage = await callHost(parentId, 'component.storage.v1', { namespace: 'domain' });
  const batchDirectory = path.join(storage.dataRoot, 'batches');
  const manifestPath = path.join(batchDirectory, `identify-${crypto.randomUUID()}.json`);
  let suggested;
  try {
    await fs.promises.mkdir(batchDirectory, { recursive: true });
    await fs.promises.writeFile(manifestPath, JSON.stringify({ subjects }, null, 2), 'utf8');
    suggested = await runAlgorithm(parentId, ['identify', '--manifest', manifestPath]);
  } finally {
    await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
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
  const storage = await callHost(parentId, 'component.storage.v1', { namespace: 'domain' });
  await replaceJsonAtomic(path.join(storage.dataRoot, 'workflow-settings', `${sha256(context.projectName)}.json`), { updatedAt: Date.now(), ...workflowSettings });
  return { success: true, workflowSettings };
};

const componentSettings = async (parentId, payload) => callHost(parentId, 'component.settings.v1', payload);

const storeReturnedPatch = (parentId, sourcePath, payload, context) => withDomain(parentId, async db => {
  const source = path.resolve(sourcePath);
  const sourceStat = await fs.promises.stat(source).catch(() => null);
  const extension = path.extname(source).toLowerCase();
  if (['.heic', '.heif'].includes(extension)) throw new Error('HEIC/HEIF 返图当前无法可靠解码；请先在系统照片或修图软件中导出为 JPEG、PNG、TIFF 或 WebP 后重试');
  if (!sourceStat?.isFile() || !RETURN_IMAGE_EXTENSIONS.has(extension)) throw new Error('返图格式不受支持；请导出为 JPEG、PNG、TIFF 或 WebP');
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE id=? AND photo_id=? AND base_version_id=? AND is_deleted=0').get(String(payload.taskId || ''), String(payload.photoId || ''), String(payload.baseVersionId || ''));
  if (!row) throw new Error('Component return task is outside the bound photo version');
  const authorized = await callHost(parentId, 'project.output.authorize.v1', { operation: 'artifacts', photoId: row.photo_id, baseVersionId: row.base_version_id });
  const destination = path.join(authorized.uploadDirectory, `${row.id}-${crypto.randomUUID()}${path.extname(source).toLowerCase()}`);
  await fs.promises.mkdir(authorized.uploadDirectory, { recursive: true });
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const artifact = createArtifact(db, row, Number(payload.personIndex), destination, 'returned', { matchConfidence: payload.matchConfidence, editEvidence: payload.editEvidence, returnWarnings: payload.returnWarnings || [] });
      const warnings = uniqueText(payload.returnWarnings);
      db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status='uploaded',needs_review=?,review_reason=?,updated_at=? WHERE id=?`).run(destination, warnings.length ? 1 : 0, warnings.join('；'), Date.now(), row.id);
      if (payload.complete) {
        const personIndex = Number(payload.personIndex);
        db.prepare(upsertAssignmentSql).run(String(context.projectId), row.photo_id, row.base_version_id, personIndex, null, 1, 'manual', 1, Date.now());
        db.prepare(`UPDATE team_person_assignments SET task_id=?,stage_id=?,artifact_id=?,edited_patch_path=?,completed=1,completion_kind='returned',return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=? WHERE photo_id=? AND base_version_id=? AND person_index=?`).run(row.id, artifact.stageId, artifact.id, destination, Date.now(), Date.now(), row.photo_id, row.base_version_id, personIndex);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { success: true, artifactPath: destination };
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
});
const mediaRequest = payload => Object.fromEntries(['kind', 'photoId', 'baseVersionId', 'taskId', 'personIndex', 'reviewSessionId', 'returnId'].filter(field => Object.hasOwn(payload || {}, field)).map(field => [field, payload[field]]));
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
  await reconcileWorkflowTaskChain(parentId, context, row.id, db);
  return { success: true, completed: payload.completed !== false, taskId: row.id, personIndex };
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
  const storage = await callHost(parentId, 'component.storage.v1', { namespace: 'domain' });
  const artifacts = createTeamWorkflowArtifactService({ crypto, fs, getWorkspaceDataRoot: () => path.dirname(storage.dataRoot), path, writeLog: () => undefined });
  return artifacts.migrate('', payload.from || {}, payload.to || {});
};

const workspaceSnapshot = async (parentId, context) => {
  const storage = await callHost(parentId, 'component.storage.v1', { namespace: 'domain' });
  const db = ensureSchema(storage.databasePath);
  try {
    const projectId = String(storage.projectId || context.projectId || '');
    const registered = db.prepare('SELECT * FROM team_retouch_photos WHERE project_id=? ORDER BY created_at').all(projectId);
    const assignments = db.prepare('SELECT * FROM team_person_assignments WHERE project_id=?').all(projectId);
    const candidatePhotoIds = uniqueText([
      ...registered.map(row => row.photo_id),
      ...assignments.map(row => row.photo_id),
      // Old releases could leave tasks without either ownership table. Probe
      // only those genuinely orphaned rows through the host; registered tasks
      // from another project must never expand this project's media query.
      ...db.prepare(`SELECT DISTINCT t.photo_id FROM team_patch_tasks t
        WHERE t.is_deleted=0
          AND NOT EXISTS (SELECT 1 FROM team_retouch_photos p WHERE p.photo_id=t.photo_id)
          AND NOT EXISTS (SELECT 1 FROM team_person_assignments a WHERE a.photo_id=t.photo_id)`).all().map(row => row.photo_id),
    ]).slice(0, MAX_ITEMS);
    const media = candidatePhotoIds.length
      ? await callHost(parentId, 'project.media.read.v1', { photoIds: candidatePhotoIds })
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
        photoId, baseVersionId, name: bundle.photo?.displayName || path.parse(bundle.photo?.originalName || base.filePath || '').name,
        relativePath: base.relativePath || '', relativePathState: base.relativePathState || 'unresolvable', sourcePath: base.filePath,
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
    const manifest = readJsonFile(path.join(storage.dataRoot, 'workflows', `${sha256(`${context.projectStatus}\0${context.projectName}`)}.json`));
    const generatedSettings = manifest?.workflowSettings;
    const generatedOrder = uniqueText(generatedSettings?.preferredIdentityOrder);
    const generatedSameWeek = new Set(uniqueText(generatedSettings?.sameWeekIdentityIds));
    const workflowAvailableItems = (manifest?.groups || []).flatMap(group => group.items || []).filter(item => item.available && item.relativePath);
    return {
      success: true, photos, identities, assignments: normalizedAssignments,
      workflowGenerated: Boolean(manifest && Number(manifest.version) >= 2),
      workflowNeedsRegeneration: Boolean(manifest && generatedSettings && (JSON.stringify(generatedOrder) !== JSON.stringify(preferredIdentityOrder)
        || JSON.stringify(generatedOrder.slice(1).filter(id => generatedSameWeek.has(id))) !== JSON.stringify(sameWeekIdentityIds))),
      workflowAvailableKeys: workflowAvailableItems.map(item => `${item.photoId}:${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowAvailableSubjectKeys: workflowAvailableItems.map(item => `${item.baseVersionId}:${Number(item.personIndex)}`),
      workflowSettings: { preferredIdentityOrder, preferredIdentityId: preferredIdentityOrder[0] || undefined, sameWeekIdentityIds },
    };
  } finally { db.close(); }
};

const workflowScope = parentId => callHost(parentId, 'project.output.authorize.v1', { action: 'workflow' });
const readWorkflowManifest = async parentId => {
  const scope = await workflowScope(parentId);
  return { ...scope, manifest: await readJson(scope.manifestPath, null) };
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

const reportTask = async (parentId, operationId, action, update = {}, topic = '') => callHost(parentId, 'tasks.report.v1', {
  action, operationId, kind: 'workspace-team-workflow', title: '生成团片协作工作流',
  eventTopic: topic, event: update, ...update,
});

const generateWorkflow = async (parentId, payload, context) => {
  const operationId = String(payload.operationId || crypto.randomUUID());
  const key = `${context.projectId}:${context.projectStatus}:${context.projectName}`;
  const existing = workflowJobs.get(key);
  if (existing?.state === 'running') return { success: true, alreadyRunning: true, operationId: existing.operationId };
  const job = { operationId, cancelled: false, state: 'running', phase: 'preparing', progress: 0, message: '正在准备工作流程' };
  workflowJobs.set(key, job);
  const publish = async update => {
    Object.assign(job, update);
    const host = await reportTask(parentId, operationId, update.state === 'completed' ? 'complete' : update.state === 'failed' ? 'failed' : 'report', update, 'workflow.progress');
    if (host?.cancelled) job.cancelled = true;
  };
  let stagingDirectory = '';
  let backupDirectory = '';
  let checkpointReady = false;
  try {
    await reportTask(parentId, operationId, 'start', { message: job.message, checkpoint: { projectId: context.projectId, operationId } }, 'workflow.progress');
    const scope = await workflowScope(parentId);
    if (fs.existsSync(scope.outputDirectory) && !payload.replace) return { success: true, requiresConfirmation: true, operationId };
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
    const manifest = { version: 2, projectName: context.projectName, status: context.projectStatus, generatedAt: Date.now(), workflowSettings, groups: plan.manifestGroups };
    if (fs.existsSync(scope.outputDirectory)) {
      backupDirectory = path.join(projectDirectory, `.photoflow-team-workflow-previous-${crypto.randomUUID()}`);
      await fs.promises.rename(scope.outputDirectory, backupDirectory);
    }
    try { await fs.promises.rename(stagingDirectory, scope.outputDirectory); stagingDirectory = ''; }
    catch (error) {
      if (backupDirectory && fs.existsSync(backupDirectory) && !fs.existsSync(scope.outputDirectory)) await fs.promises.rename(backupDirectory, scope.outputDirectory).catch(() => undefined);
      throw error;
    }
    try { await writeJsonAtomic(scope.manifestPath, manifest); }
    catch (error) {
      await fs.promises.rm(scope.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (backupDirectory && fs.existsSync(backupDirectory)) await fs.promises.rename(backupDirectory, scope.outputDirectory).catch(() => undefined);
      throw error;
    }
    checkpointReady = false;
    if (backupDirectory) await callHost(parentId, 'project.output.authorize.v1', { action: 'cleanup-workflow-backup', backupName: path.basename(backupDirectory) }).catch(() => undefined);
    await publish({ state: 'completed', phase: 'complete', progress: 100, completedFiles: plan.files.length, totalFiles: plan.files.length, copiedBytes: plan.totalBytes, totalBytes: plan.totalBytes, message: '工作流程生成完成' });
    return { success: true, operationId, count: plan.files.length, groupCount: manifest.groups.length };
  } catch (error) {
    const cancelled = job.cancelled || error?.code === CANCELLED_CODE;
    job.state = cancelled ? 'cancelled' : 'failed';
    job.message = cancelled ? '工作流程生成已取消，可在下次继续' : error.message || String(error);
    await reportTask(parentId, operationId, cancelled ? 'cancel' : 'failed', { ...job, error: cancelled ? '' : job.message }, 'workflow.progress').catch(() => undefined);
    if (backupDirectory && fs.existsSync(backupDirectory)) {
      const scope = await workflowScope(parentId).catch(() => null);
      if (scope && !fs.existsSync(scope.outputDirectory)) await fs.promises.rename(backupDirectory, scope.outputDirectory).catch(() => undefined);
    }
    if (stagingDirectory && !checkpointReady) await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    return { success: false, cancelled, resumable: checkpointReady, operationId, error: cancelled ? undefined : job.message };
  }
};

const workflowStatus = async (parentId, _payload, context) => {
  const key = `${context.projectId}:${context.projectStatus}:${context.projectName}`;
  const job = workflowJobs.get(key) || null;
  if (!job) {
    const recovered = await callHost(parentId, 'tasks.report.v1', { action: 'latest', kind: 'workspace-team-workflow' }).catch(() => null);
    return { success: true, job: recovered?.task ? { operationId: recovered.task.metadata?.operationId, state: recovered.task.state, phase: recovered.task.metadata?.phase, progress: recovered.task.progress, message: recovered.task.message, resumable: recovered.task.state === 'interrupted' } : null };
  }
  const host = await reportTask(parentId, job.operationId, 'status').catch(() => null);
  return { success: true, job: { ...job, task: host?.task || undefined } };
};

const cancelWorkflow = async (parentId, payload) => {
  const operationId = String(payload.operationId || '');
  const job = [...workflowJobs.values()].find(item => item.operationId === operationId && item.state === 'running');
  if (job) { job.cancelled = true; job.phase = 'cancelling'; job.message = '正在安全停止，已完成文件可续传'; }
  await reportTask(parentId, operationId, 'cancel', job || {}).catch(() => undefined);
  return { success: true, cancelled: Boolean(job) };
};

const exportWorkflow = async (parentId, payload, open = false) => {
  const { outputDirectory, manifest } = await readWorkflowManifest(parentId);
  if (!manifest) throw new Error('请先生成工作流程');
  const group = (manifest.groups || []).find(item => Number(item.week) === Number(payload.week) && String(item.identityId || '') === String(payload.identityId || ''));
  const directory = path.resolve(outputDirectory, String(group?.relativePath || ''));
  if (!group?.relativePath || !isInside(outputDirectory, directory) || !fs.existsSync(directory)) throw new Error('任务文件夹不存在，请重新生成工作流程');
  const count = (group.items || []).filter(item => item.available && item.relativePath && isInside(outputDirectory, path.resolve(outputDirectory, item.relativePath)) && fs.existsSync(path.resolve(outputDirectory, item.relativePath))).length;
  if (!count) throw new Error('本周任务仍在等待上一位返图');
  if (open) await callHost(parentId, 'dialogs.open.v1', { action: 'open-workflow', relativePath: group.relativePath });
  return { success: true, count };
};

const reviewTarget = async parentId => {
  const scope = await workflowScope(parentId);
  return { directory: scope.reviewDirectory, sessionPath: path.join(scope.reviewDirectory, 'session.json') };
};
const readReview = async parentId => {
  const target = await reviewTarget(parentId);
  let session = await readJson(target.sessionPath, null);
  if (session && Number(session.version || 1) < 2) {
    session = { ...session, version: 2, updatedAt: Date.now(), result: { ...session.result, matches: (session.result?.matches || []).map(match => ({ matchConfidence: match.matchConfidence || match.confidence || 'unknown', editEvidence: match.editEvidence || { reallyModified: false, legacyUnknown: true }, returnWarnings: match.returnWarnings || ['旧版返图审核记录缺少修改证据，请人工确认'], needsReview: match.accepted !== true, ...match })) } };
    await writeJsonAtomic(target.sessionPath, session);
  }
  return { ...target, session };
};
const publicMatch = ({ path: _path, patchPath: _patchPath, mediaPath: _mediaPath, originalPath: _originalPath, alternatives, ...item }) => ({ ...item, alternatives: (alternatives || []).map(({ path: _a, patchPath: _b, mediaPath: _c, originalPath: _d, ...alternative }) => alternative) });
const presentReview = session => ({ ...session.result, reviewSessionId: session.id, matches: (session.result?.matches || []).map(publicMatch) });

const selectReturns = async parentId => {
  const selected = await callHost(parentId, 'dialogs.open.v1', { action: 'select-images' });
  return { success: true, cancelled: Boolean(selected.cancelled), files: selected.tokens || [] };
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

const runMatcher = async (returned, candidates) => {
  const runtime = path.join(__dirname, process.platform === 'win32' ? 'team-retouch.exe' : 'team-retouch');
  if (!fs.existsSync(runtime)) {
    return { matches: returned.map((item, index) => ({ ...item, ...(candidates[index] || {}), confidence: candidates[index] ? 'review' : 'unmatched', matchConfidence: 'unknown', score: 0, needsReview: true, editEvidence: { reallyModified: false }, returnWarnings: ['返图匹配算法不可用，必须人工确认'] })) };
  }
  const manifestPath = path.join(path.dirname(returned[0].path), `match-${crypto.randomUUID()}.json`);
  await fs.promises.writeFile(manifestPath, JSON.stringify({ returned, candidates }), 'utf8');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(runtime, ['match-batch', '--manifest', manifestPath], { cwd: __dirname, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => {
        if (code !== 0) { reject(new Error(stderr.trim() || `返图匹配进程退出：${code}`)); return; }
        try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}')); } catch (error) { reject(error); }
      });
    });
  } finally { await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined); }
};

const reconcileWorkflowTaskChain = async (parentId, context, taskId, existingDb = null) => {
  const scope = await readWorkflowManifest(parentId);
  if (!scope.manifest) return { reconciled: false, reason: 'workflow-missing' };
  const chain = [];
  for (const [groupIndex, group] of (scope.manifest.groups || []).entries()) for (const [itemIndex, item] of (group.items || []).entries()) if (String(item.taskId) === String(taskId)) chain.push({ group, item, groupIndex, itemIndex });
  chain.sort((a, b) => Number(a.group.week) - Number(b.group.week) || a.groupIndex - b.groupIndex || a.itemIndex - b.itemIndex);
  if (!chain.length) return { reconciled: false, reason: 'task-not-in-workflow' };
  const reconcile = async db => {
    const task = db.prepare('SELECT * FROM team_patch_tasks WHERE id=? AND is_deleted=0').get(String(taskId));
    if (!task) throw new Error('工作流程引用的修图任务不存在');
    if (chain.some(entry => String(entry.item.photoId) !== String(task.photo_id) || String(entry.item.baseVersionId) !== String(task.base_version_id))) throw new Error('工作流程 task 链跨越了错误的照片版本');
    const artifactGrant = await callHost(parentId, 'project.output.authorize.v1', { operation: 'artifacts', photoId: task.photo_id, baseVersionId: task.base_version_id });
    const artifactRoots = [artifactGrant.dataDirectory, artifactGrant.deliveryDirectory].filter(Boolean);
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
    for (const [index, stage] of stages.entries()) {
      const relativePath = String(stage.entry.item.relativePath || '');
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
    await writeJsonAtomic(scope.manifestPath, scope.manifest);
    return { reconciled: true, taskId: task.id, activePersonIndex: activeIndex >= 0 ? stages[activeIndex].personIndex : null, complete: activeIndex < 0 };
  };
  return existingDb ? reconcile(existingDb) : withDomain(parentId, reconcile);
};

const returnBatch = async (parentId, payload, context, workflowMode) => {
  const existing = workflowMode ? await readReview(parentId) : null;
  if (existing?.session) throw new Error('还有一批返图等待确认，请先继续处理或放弃');
  const snapshot = await workspaceSnapshot(parentId, context);
  const requestedPaths = new Set(uniqueText(payload.relativePaths));
  const candidates = workflowMode ? readyWorkflowCandidates(snapshot, payload.items) : (snapshot.photos || []).filter(photo => !requestedPaths.size || requestedPaths.has(String(photo.relativePath || ''))).flatMap(photo => (photo.tasks || []).map(task => ({ taskId: task.id, photoId: photo.photoId, baseVersionId: photo.baseVersionId, personIndex: task.personIndex, photoName: photo.name, personName: task.personName, originalPath: photo.sourcePath, patchPath: task.editedPatchPath && fs.existsSync(task.editedPatchPath) ? task.editedPatchPath : task.patchPath })).filter(item => item.patchPath && fs.existsSync(item.patchPath)));
  if (!candidates.length) throw new Error('当前没有可接收返图的任务');
  const staged = await callHost(parentId, 'project.output.authorize.v1', { action: 'stage-inputs', tokens: payload.returnedFiles || [] });
  try {
    const returnOperationId = `returns-${staged.stageId}`;
    await reportTask(parentId, returnOperationId, 'start', { kind: 'team-return-batch', title: '批量处理协作返图', message: '正在识别返图' }, 'patch.return-batch.progress');
    const returned = staged.items.map((item, index) => ({ returnId: `${workflowMode ? 'workflow-' : ''}return-${index + 1}`, path: item.path, sourceName: item.name, inputName: path.basename(item.path) }));
    const stagedSources = new Set(staged.items.map(item => path.resolve(item.path)));
    const matched = await runMatcher(returned, candidates);
    const accepted = [];
    const high = (matched.matches || []).filter(item => item.confidence === 'high' && item.taskId);
    for (const [index, match] of high.entries()) {
      if (!stagedSources.has(path.resolve(match.path))) throw new Error('Matched return escaped its component staging grant');
      const registered = await withPhotoOperation(match.photoId, () => storeReturnedPatch(parentId, match.path, { photoId: match.photoId, baseVersionId: match.baseVersionId, taskId: match.taskId, personIndex: match.personIndex, complete: workflowMode, matchConfidence: match.matchConfidence, editEvidence: match.editEvidence, returnWarnings: match.returnWarnings }, context));
      await reconcileWorkflowTaskChain(parentId, context, match.taskId);
      accepted.push({ ...match, path: undefined, patchPath: undefined, accepted: true });
      await reportTask(parentId, returnOperationId, 'report', { phase: 'importing', progress: 82 + 18 * (index + 1) / Math.max(1, high.length), message: `正在归档返图 ${index + 1}/${high.length}` }, 'patch.return-batch.progress').catch(() => undefined);
    }
    const acceptedById = new Map(accepted.map(item => [String(item.returnId), item]));
    let matches = (matched.matches || []).map(item => acceptedById.get(String(item.returnId)) || { ...item, path: undefined, patchPath: undefined, accepted: false });
    matches = matches.map(publicMatch);
    const result = { success: true, matches, merges: [], returnedCount: returned.length, candidateCount: candidates.length, acceptedCount: accepted.length, reviewCount: matches.filter(item => !item.accepted).length, missingTaskCount: Math.max(0, candidates.length - accepted.length), mergedCount: 0 };
    await reportTask(parentId, returnOperationId, 'complete', { state: 'completed', phase: 'complete', progress: 100, message: '返图处理完成' }, 'patch.return-batch.progress');
    if (workflowMode && result.reviewCount) {
      const target = await reviewTarget(parentId);
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
        const session = { version: 2, id: reviewId, projectName: context.projectName, status: context.projectStatus, createdAt: Date.now(), updatedAt: Date.now(), result: { ...result, reviewSessionId: reviewId, matches } };
        await fs.promises.writeFile(path.join(pending, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
        await fs.promises.rename(pending, target.directory);
        return presentReview(session);
      } catch (error) { await fs.promises.rm(pending, { recursive: true, force: true }).catch(() => undefined); throw error; }
    }
    return result;
  } finally { await callHost(parentId, 'project.output.authorize.v1', { action: 'discard-stage', stageId: staged.stageId }).catch(() => undefined); }
};

const reviewGet = async (parentId, _payload, context) => {
  const { session } = await readReview(parentId);
  return { success: true, review: session && String(session.status) === String(context.projectStatus) ? presentReview(session) : null };
};
const reviewDiscard = async (parentId, payload) => {
  const target = await readReview(parentId);
  if (target.session && String(target.session.id) !== String(payload.reviewSessionId)) throw new Error('待确认返图批次已经变化');
  if (target.session) await fs.promises.rm(target.directory, { recursive: true, force: true });
  return { success: true, discarded: Boolean(target.session) };
};
const reviewIgnore = async (parentId, payload) => {
  const target = await readReview(parentId);
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
const returnConfirm = async (parentId, payload, context) => {
  const target = await readReview(parentId);
  if (!target.session || String(target.session.id) !== String(payload.reviewSessionId)) throw new Error('待确认返图批次已经变化');
  const match = target.session.result.matches.find(item => String(item.returnId) === String(payload.returnId));
  if (!match || match.accepted) throw new Error('这张返图已经处理');
  const candidate = readyWorkflowCandidates(await workspaceSnapshot(parentId, context), [payload])[0];
  if (!candidate || String(candidate.taskId) !== String(payload.taskId)) throw new Error('候选任务当前不可确认');
  if (!match.path || !isInside(target.directory, match.path)) throw new Error('Reviewed return escaped its component review grant');
  const registered = await withPhotoOperation(candidate.photoId, () => storeReturnedPatch(parentId, match.path, { photoId: candidate.photoId, baseVersionId: candidate.baseVersionId, taskId: candidate.taskId, personIndex: candidate.personIndex, complete: true }, context));
  await reconcileWorkflowTaskChain(parentId, context, candidate.taskId);
  match.accepted = true; match.confidence = 'manual'; match.photoId = candidate.photoId; match.baseVersionId = candidate.baseVersionId; match.taskId = candidate.taskId; match.personIndex = candidate.personIndex;
  target.session.result.reviewCount = target.session.result.matches.filter(item => !item.accepted).length;
  target.session.result.acceptedCount = target.session.result.matches.filter(item => item.accepted).length;
  if (target.session.result.reviewCount) await writeJsonAtomic(target.sessionPath, target.session);
  else await fs.promises.rm(target.directory, { recursive: true, force: true });
  return { success: true, warning: undefined };
};

const handlers = {
  'team.project.get.v1': async (parentId, _payload, context) => publicWorkspace(await workspaceSnapshot(parentId, context)),
  'team.project.register.v1': async (parentId, payload, context) => {
    const relativePaths = uniqueText(payload.relativePaths);
    if (relativePaths.length > MAX_ITEMS) throw new Error(`Too many project media items: ${relativePaths.length}`);
    const media = await callHost(parentId, 'project.media.read.v1', { relativePaths });
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
  'team.media.authorize.v1': (parentId, payload) => callHost(parentId, 'project.media.access.v1', { action: 'authorize', ...mediaRequest(payload) }),
  'team.patch.open.v1': (parentId, payload) => callHost(parentId, 'project.media.access.v1', { action: 'open', ...mediaRequest({ ...payload, kind: 'working' }) }),
  'team.workflow.settings.save.v1': saveWorkflowSettings,
  'team.workflow.status.v1': workflowStatus,
  'team.workflow.cancel.v1': cancelWorkflow,
  'team.workflow.generate.v1': generateWorkflow,
  'team.workflow.export.v1': (parentId, payload) => exportWorkflow(parentId, payload, false),
  'team.workflow.open-export.v1': (parentId, payload) => exportWorkflow(parentId, payload, true),
  'team.workflow.return-review.get.v1': reviewGet,
  'team.workflow.return-review.discard.v1': reviewDiscard,
  'team.workflow.return-review.ignore.v1': reviewIgnore,
  'team.workflow.return-batch.v1': (parentId, payload, context) => returnBatch(parentId, payload, context, true),
  'team.workflow.return-confirm.v1': returnConfirm,
  'team.patch.select-returns.v1': selectReturns,
  'team.patch.return-batch.v1': (parentId, payload, context) => returnBatch(parentId, payload, context, false),
  'team.workflow.artifact.migrate.v1': migrateWorkflowArtifacts,
  'component.settings.get.v1': parentId => componentSettings(parentId, { action: 'get' }),
  'component.settings.update.v1': (parentId, payload) => componentSettings(parentId, { action: 'update', settings: payload }),
  'component.advanced.preflight.v1': parentId => callHost(parentId, 'component.lifecycle.v1', { action: 'advanced.preflight' }),
  'component.advanced.install.v1': async (parentId, payload) => {
    const installed = await callHost(parentId, 'component.lifecycle.v1', { action: 'advanced.install', repair: payload.repair === true });
    const probe = await runAlgorithm(parentId, ['probe-advanced-runtime'], { timeoutMs: 4 * 60 * 1000 });
    if (!probe.pairDetrReady || !probe.sam2Ready) throw new Error('高级模型服务没有全部进入可用状态');
    return installed;
  },
  'component.advanced.uninstall.v1': parentId => callHost(parentId, 'component.lifecycle.v1', { action: 'advanced.uninstall' }),
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
    if (frame.ok === false) pending.reject(new Error(String(frame.error || 'Host capability failed')));
    else pending.resolve(frame.result);
    return;
  }
  if (frame?.type !== 'request') return;
  const id = String(frame.id || '');
  const handler = handlers[String(frame.method || '')];
  Promise.resolve(handler ? handler(id, frame.payload || {}, frame.context || {}) : Promise.reject(new Error('Unknown team-retouch service method')))
    .then(result => writeFrame({ type: 'response', id, ok: true, result }))
    .catch(error => writeFrame({ type: 'response', id, ok: false, error: error.message || String(error) }));
});

writeFrame({ type: 'ready', protocolVersion: 1 });
process.once('exit', () => { for (const child of activeAlgorithms) child.kill(); });
};

if (require.main === module) startService();
module.exports = { ensureSchema, startService };
