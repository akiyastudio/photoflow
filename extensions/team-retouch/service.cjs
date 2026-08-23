const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const MAX_ITEMS = 2000;
const pendingCapabilities = new Map();
const activeAlgorithms = new Set();
let nextCapabilityId = 1;

const writeFrame = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const parseJson = (value, fallback) => {
  try { return JSON.parse(value || ''); } catch { return fallback; }
};
const uniqueText = values => [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

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
    INSERT INTO meta(key,value) VALUES('schema_version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  `);
  return db;
};

const serializeTask = row => ({
  id: row.id, photoId: row.photo_id, baseVersionId: row.base_version_id,
  personIndex: row.person_index, personName: row.person_name, assignee: row.assignee,
  detector: row.detector, bbox: parseJson(row.bbox_json, {}), crop: parseJson(row.crop_json, {}),
  patchPath: row.patch_path, maskPath: row.mask_path, mask: parseJson(row.mask_json, {}),
  members: parseJson(row.members_json, []), needsReview: Boolean(row.needs_review),
  reviewReason: row.review_reason, editedPatchPath: row.edited_patch_path, status: row.status,
  mergeMetrics: parseJson(row.merge_metrics_json, {}), mergedVersionId: row.merged_version_id,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

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
  activeAlgorithms.add(child);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const timer = setTimeout(() => { child.kill(); reject(new Error('团片组件算法运行超时')); }, timeoutMs);
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
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => {
    activeAlgorithms.delete(child);
    clearTimeout(timer); lines.close();
    if (cancelled) reject(new Error('团片组件算法已取消'));
    else if (code !== 0) reject(new Error(stderr.trim() || `团片组件算法退出（${code}）`));
    else if (!result) reject(new Error('团片组件算法没有返回结果'));
    else resolve(result);
  });
});

const taskRows = (db, photoId, baseVersionId) => db.prepare(`SELECT * FROM team_patch_tasks WHERE photo_id=? AND (?='' OR base_version_id=?) AND is_deleted=0 ORDER BY created_at,person_index`).all(String(photoId), String(baseVersionId || ''), String(baseVersionId || ''));
const listTasks = (db, photoId, baseVersionId = '') => taskRows(db, photoId, baseVersionId).map(serializeTask);
const registerPhoto = (db, context, photoId, baseVersionId) => db.prepare(`INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(photo_id) DO UPDATE SET project_id=excluded.project_id,base_version_id=excluded.base_version_id,updated_at=excluded.updated_at`).run(String(photoId), String(context.projectId), String(baseVersionId), Date.now(), Date.now());

const replacePatches = (db, context, photoId, baseVersionId, tasks) => {
  const old = listTasks(db, photoId, baseVersionId);
  db.prepare('UPDATE team_patch_tasks SET is_deleted=1,updated_at=? WHERE photo_id=? AND base_version_id=? AND is_deleted=0').run(Date.now(), String(photoId), String(baseVersionId));
  db.prepare('DELETE FROM team_person_assignments WHERE project_id=? AND photo_id=? AND base_version_id=?').run(String(context.projectId), String(photoId), String(baseVersionId));
  const insert = db.prepare(`INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,assignee,detector,bbox_json,crop_json,patch_path,mask_path,mask_json,members_json,needs_review,review_reason,edited_patch_path,status,merge_metrics_json,merged_version_id,created_at,updated_at,is_deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
  const now = Date.now();
  for (const task of tasks || []) insert.run(String(task.id || crypto.randomUUID()), String(photoId), String(baseVersionId), Number(task.personIndex || 0), String(task.personName || `人物 ${Number(task.personIndex || 0) + 1}`), String(task.assignee || ''), String(task.detector || ''), JSON.stringify(task.bbox || {}), JSON.stringify(task.crop || {}), String(task.patchPath || ''), task.maskPath ? String(task.maskPath) : null, JSON.stringify(task.mask || {}), JSON.stringify(task.members || []), task.needsReview ? 1 : 0, String(task.reviewReason || ''), task.editedPatchPath ? String(task.editedPatchPath) : null, String(task.status || 'exported'), JSON.stringify(task.mergeMetrics || {}), task.mergedVersionId ? String(task.mergedVersionId) : null, now, now);
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
      db.prepare(`UPDATE team_patch_tasks SET person_name=COALESCE(?,person_name),assignee=COALESCE(?,assignee),crop_json=COALESCE(?,crop_json),needs_review=COALESCE(?,needs_review),review_reason=COALESCE(?,review_reason),updated_at=? WHERE id=? AND is_deleted=0`).run(payload.personName === undefined ? null : String(payload.personName).trim().slice(0, 80) || '未命名人物', payload.assignee === undefined ? null : String(payload.assignee).trim().slice(0, 80), crop ? JSON.stringify(crop) : null, payload.needsReview === undefined ? null : payload.needsReview ? 1 : 0, payload.reviewReason === undefined ? null : String(payload.reviewReason).trim().slice(0, 300), Date.now(), row.id);
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
  try {
    await fs.promises.copyFile(choice.filePath, stagedPath, fs.constants.COPYFILE_EXCL);
    await fs.promises.rename(stagedPath, outputPath);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status='uploaded',updated_at=? WHERE id=?`).run(outputPath, Date.now(), row.id);
      db.prepare(`${upsertAssignmentSql}`).run(String(context.projectId), row.photo_id, row.base_version_id, personIndex, null, 1, 'manual', 1, Date.now());
      db.prepare(`UPDATE team_person_assignments SET edited_patch_path=?,completed=1,completion_kind='retouched',completed_at=?,updated_at=? WHERE photo_id=? AND base_version_id=? AND person_index=?`).run(outputPath, Date.now(), Date.now(), row.photo_id, row.base_version_id, personIndex);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await appendCommand(storage, { operationId, type: 'patch-upload', state: 'committed' });
    return { success: true, tasks: listTasks(db, row.photo_id).map(publicTask) };
  } catch (error) {
    await removeArtifacts([stagedPath, outputPath]);
    await appendCommand(storage, { operationId, type: 'patch-upload', state: 'rolled-back', error: error.message || String(error) }).catch(() => undefined);
    throw error;
  }
});

const removeUpload = (parentId, payload) => withDomain(parentId, async (db, storage) => {
  const row = db.prepare('SELECT * FROM team_patch_tasks WHERE id=? AND photo_id=? AND is_deleted=0').get(String(payload.taskId || ''), String(payload.photoId || ''));
  if (!row) throw new Error('人物修图任务不存在');
  const personIndex = Number(payload.personIndex);
  const assignment = db.prepare('SELECT * FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?').get(row.photo_id, row.base_version_id, personIndex);
  const removedPath = assignment?.edited_patch_path || row.edited_patch_path || '';
  await assertAuthorizedArtifacts(parentId, [row]);
  const operationId = crypto.randomUUID();
  await appendCommand(storage, { operationId, type: 'patch-remove-upload', state: 'prepared', taskId: row.id, personIndex });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE team_person_assignments SET completed=0,completion_kind='',edited_patch_path=NULL,completed_at=NULL,updated_at=? WHERE photo_id=? AND base_version_id=? AND person_index=?`).run(Date.now(), row.photo_id, row.base_version_id, personIndex);
    const predecessor = db.prepare(`SELECT edited_patch_path FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND completed=1 AND edited_patch_path IS NOT NULL ORDER BY completed_at DESC LIMIT 1`).get(row.photo_id, row.base_version_id)?.edited_patch_path || null;
    db.prepare(`UPDATE team_patch_tasks SET edited_patch_path=?,status=?,merged_version_id=NULL,merge_metrics_json='{}',updated_at=? WHERE id=?`).run(predecessor, predecessor ? 'uploaded' : 'exported', Date.now(), row.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); await appendCommand(storage, { operationId, type: 'patch-remove-upload', state: 'rolled-back', error: error.message || String(error) }); throw error; }
  await appendCommand(storage, { operationId, type: 'patch-remove-upload', state: 'committed' });
  if (removedPath) await removeArtifacts([removedPath]);
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
  const results = [];
  for (const [index, bundle] of (media.items || []).entries()) {
    const base = bundle.versions?.find(item => String(item.id) === String(bundle.photo?.currentVersionId)) || bundle.versions?.find(item => item.isCurrent) || bundle.versions?.at(-1);
    const relativePath = bundle.relativePath || relativePaths[index];
    await callHost(parentId, 'tasks.report.v1', { topic: 'patch.detect-batch.progress', value: { itemIndex: index + 1, itemCount: media.items.length, relativePath, itemName: bundle.photo?.displayName || '', progress: 100 * index / Math.max(1, media.items.length), message: '正在AI识别' } });
    try {
      const detected = await detectPhoto(parentId, { photoId: bundle.photo.id, baseVersionId: base.id, restoreExcluded: false }, context);
      results.push({ relativePath, name: bundle.photo?.displayName || '', success: true, photoId: bundle.photo.id, baseVersionId: base.id, personCount: detected.detection.personCount, workTileCount: detected.tasks.length, detector: detected.detection.detector, fallbackReason: detected.detection.fallbackReason });
    } catch (error) { results.push({ relativePath, name: bundle.photo?.displayName || '', success: false, error: error.message || String(error) }); }
  }
  return { success: results.some(item => item.success), results, persistentBackend: false, requestedMode: 'auto', advancedUsedCount: results.filter(item => item.advancedBackend).length, fallbackCount: results.filter(item => item.fallbackReason).length, error: results.some(item => item.success) ? undefined : '批量识别全部失败' };
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

const workspaceSnapshot = async (parentId, context) => {
  const storage = await callHost(parentId, 'component.storage.v1', { namespace: 'domain' });
  const db = ensureSchema(storage.databasePath);
  try {
    const projectId = String(context.projectId || '');
    const registered = db.prepare('SELECT * FROM team_retouch_photos WHERE project_id=? ORDER BY created_at').all(projectId);
    const assignments = db.prepare('SELECT * FROM team_person_assignments WHERE project_id=?').all(projectId);
    const candidatePhotoIds = uniqueText([
      ...registered.map(row => row.photo_id),
      ...assignments.map(row => row.photo_id),
      ...db.prepare('SELECT DISTINCT photo_id FROM team_patch_tasks WHERE is_deleted=0').all().map(row => row.photo_id),
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
      if (!baseVersionId || !grouped.has(baseVersionId)) {
        baseVersionId = grouped.has(currentVersionId) ? currentVersionId : [...grouped.keys()].at(-1) || baseVersionId;
      }
      const base = (bundle.versions || []).find(version => String(version.id) === baseVersionId);
      if (!base) continue;
      photos.push({
        photoId, baseVersionId, name: bundle.photo?.displayName || path.parse(bundle.photo?.originalName || base.filePath || '').name,
        relativePath: bundle.relativePath || '', sourcePath: base.filePath,
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

const handlers = {
  'team.project.get.v1': (parentId, _payload, context) => workspaceSnapshot(parentId, context),
  'team.project.register.v1': async (parentId, payload, context) => {
    const relativePaths = uniqueText(payload.relativePaths);
    if (relativePaths.length > MAX_ITEMS) throw new Error(`Too many project media items: ${relativePaths.length}`);
    await callHost(parentId, 'project.media.read.v1', { relativePaths });
    return workspaceSnapshot(parentId, context);
  },
  'team.project.remove-photo.v1': removeProjectPhoto,
  'team.identity.save.v1': saveIdentity,
  'team.identity.assign.v1': assignIdentity,
  'team.identity.confirm-group.v1': confirmIdentityGroup,
  'team.identity.delete.v1': deleteIdentity,
  'team.person.exclude.v1': excludePerson,
  'team.patch.get.v1': getPatchBundle,
  'team.patch.detect.v1': detectPhoto,
  'team.patch.detect-batch.v1': detectBatch,
  'team.patch.update.v1': updatePatch,
  'team.patch.delete.v1': deletePatch,
  'team.patch.cleanup.v1': cleanupPatches,
  'team.patch.upload.v1': uploadPatch,
  'team.patch.remove-upload.v1': removeUpload,
  'team.patch.merge.v1': mergePatches,
  'team.identity.similarities.v1': readIdentitySimilarities,
  'team.workflow.settings.save.v1': saveWorkflowSettings,
  'component.settings.get.v1': parentId => componentSettings(parentId, { action: 'get' }),
  'component.settings.update.v1': (parentId, payload) => componentSettings(parentId, { action: 'update', settings: payload }),
};

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
