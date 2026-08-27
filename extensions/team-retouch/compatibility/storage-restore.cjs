const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// The host deliberately treats component storage as opaque.  This list and all
// project/path semantics therefore remain owned by the component.
const PROJECT_TABLES = Object.freeze([
  'team_retouch_photos', 'team_person_identities', 'team_patch_tasks',
  'team_person_assignments', 'team_person_exclusions', 'team_task_stages',
  'team_task_artifacts', 'team_workflow_reconcile_pending',
  'team_workflow_review_confirmations', 'team_durable_operations',
  'team_workflow_settings', 'team_workflow_state', 'team_review_state',
]);
const INSERT_ORDER = Object.freeze([
  'team_retouch_photos', 'team_person_identities', 'team_patch_tasks',
  'team_person_assignments', 'team_person_exclusions', 'team_task_stages',
  'team_task_artifacts', 'team_workflow_reconcile_pending',
  'team_workflow_review_confirmations', 'team_durable_operations',
  'team_workflow_settings', 'team_workflow_state', 'team_review_state',
]);
const DELETE_ORDER = Object.freeze([...INSERT_ORDER].reverse());
const PATH_COLUMNS = Object.freeze({
  team_patch_tasks: ['patch_path', 'mask_path', 'edited_patch_path'],
  team_person_assignments: ['edited_patch_path'],
  team_task_artifacts: ['artifact_path'],
  team_retouch_photos: ['relative_path'],
});
const JSON_COLUMNS = Object.freeze({
  team_patch_tasks: ['generation_json', 'bbox_json', 'crop_json', 'mask_json', 'members_json', 'merge_metrics_json'],
  team_task_artifacts: ['metadata_json'],
  team_workflow_reconcile_pending: ['history_json'],
  team_durable_operations: ['request_json', 'checkpoint_json', 'result_json'],
  team_workflow_settings: ['settings_json'],
});
const projectMigrationMetaKeys = projectId => {
  const suffix = crypto.createHash('sha256').update(String(projectId)).digest('hex').slice(0, 24);
  return [`legacy_project_artifacts_v2_state:${suffix}`, `legacy_project_artifacts_v2:${suffix}`];
};
const selectRestoreSource = sources => (sources || []).find(item => item.format === 'component-storage-v1')
  || (sources || []).find(item => item.format === 'legacy-domain-v1');

const quote = value => `"${String(value).replace(/"/g, '""')}"`;
const tableExists = (db, schema, table) => Boolean(db.prepare(`SELECT 1 FROM ${quote(schema)}.sqlite_master WHERE type='table' AND name=?`).get(table));
const columns = (db, schema, table) => db.prepare(`PRAGMA ${quote(schema)}.table_info(${quote(table)})`).all().map(row => String(row.name));

const normalizeForMatch = value => path.resolve(String(value || '')).replace(/[\\/]+/g, path.sep).toLowerCase();
const buildReplacements = payload => {
  const pairs = [];
  const add = (from, to) => { if (from && to && normalizeForMatch(from) !== normalizeForMatch(to)) pairs.push([String(from), String(to)]); };
  add(payload.sourceWorkspace?.dataRoot, payload.targetWorkspace?.dataRoot);
  add(payload.sourceWorkspace?.root, payload.targetWorkspace?.root);
  if (payload.project?.sourceRelativePath && payload.project?.targetRelativePath) {
    add(payload.project.sourceRelativePath, payload.project.targetRelativePath);
    add(path.join(String(payload.sourceWorkspace?.root || ''), payload.project.sourceRelativePath), path.join(String(payload.targetWorkspace?.root || ''), payload.project.targetRelativePath));
  }
  return pairs.sort((left, right) => right[0].length - left[0].length);
};
const replacePath = (value, pairs) => {
  if (typeof value !== 'string' || !value) return value;
  const normalized = normalizeForMatch(value);
  for (const [from, to] of pairs) {
    const old = normalizeForMatch(from);
    if (normalized === old || normalized.startsWith(`${old}${path.sep}`)) {
      const relative = path.relative(path.resolve(from), path.resolve(value));
      return path.normalize(relative ? path.join(to, relative) : to);
    }
    const slashValue = value.replace(/\\/g, '/'); const slashFrom = from.replace(/\\/g, '/').replace(/\/$/, '');
    if (slashValue === slashFrom || slashValue.startsWith(`${slashFrom}/`)) return `${to.replace(/\\/g, '/').replace(/\/$/, '')}${slashValue.slice(slashFrom.length)}`;
  }
  return value;
};
const rewriteJson = (value, pairs) => {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return value; }
  const visit = item => {
    if (typeof item === 'string') return replacePath(item, pairs);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return JSON.stringify(visit(parsed));
};
const rewriteProjectIdentityJson = (value, payload) => {
  const sourceId = String(payload.project?.sourceId || payload.project?.id || ''); const targetId = String(payload.project?.id || '');
  const sourceName = String(payload.project?.sourceName || payload.project?.name || '');
  const targetName = String(payload.project?.targetName || payload.project?.name || sourceName);
  const sourceStatus = String(payload.project?.sourceStatus || payload.project?.status || '');
  const targetStatus = String(payload.project?.targetStatus || payload.project?.status || sourceStatus);
  if ((!sourceId || !targetId || sourceId === targetId) && (!sourceName || sourceName === targetName)
    && (!sourceStatus || sourceStatus === targetStatus)) return value;
  let parsed; try { parsed = JSON.parse(value); } catch { return value; }
  const visit = (item, key = '') => {
    if (key === 'projectId' && sourceId && targetId && (item === sourceId || item === undefined || item === null || item === '')) return targetId;
    if (key === 'projectName' && sourceName && (item === sourceName || item === undefined || item === null || item === '')) return targetName;
    if ((key === 'projectStatus' || key === 'status') && sourceStatus && (item === sourceStatus || item === undefined || item === null || item === '')) return targetStatus;
    if (typeof item === 'string') return item === sourceId ? targetId : item;
    if (Array.isArray(item)) return item.map(child => visit(child));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey === sourceId ? targetId : childKey, visit(child, childKey)]));
    return item;
  };
  return JSON.stringify(visit(parsed));
};

const readBoundJson = (source, binding, kind) => {
  try {
    const value = JSON.parse(fs.readFileSync(source.path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = String(value.projectId || '');
    if (id && id !== binding.projectId) return null;
    if (String(value.projectName || '') !== binding.projectName || String(value.status || '') !== binding.projectStatus) return null;
    if (kind === 'workflow' && (Number(value.version) < 2 || !Array.isArray(value.groups)
      || !value.groups.every(group => group && typeof group === 'object' && !Array.isArray(group)
        && Array.isArray(group.items) && group.items.every(item => item && typeof item === 'object' && !Array.isArray(item))))) return null;
    return value;
  } catch { return null; }
};
const projectJsonMatchesBinding = (source, binding) => {
  if (!String(source.relativePath || '').toLowerCase().endsWith('.json')) return true;
  try {
    const value = JSON.parse(fs.readFileSync(source.path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.projectId != null && String(value.projectId) !== binding.projectId) return false;
    if (value.projectName != null && String(value.projectName) !== binding.projectName) return false;
    if (value.projectStatus != null && String(value.projectStatus) !== binding.projectStatus) return false;
    return true;
  } catch { return false; }
};

const digestFile = filePath => {
  const hash = crypto.createHash('sha256'); const descriptor = fs.openSync(filePath, 'r'); const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { for (;;) { const count = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
};
const SOURCE_MANIFEST_SCHEMA = 'component-backup-restore-sources-v1';
const RECEIPT_SCHEMA = 'component-backup-restore-receipt-v1';
const insidePath = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const loadRestoreSources = payload => {
  if (!payload?.sourceManifestPath) return { sources: payload?.sources || [], manifest: null };
  const manifestPath = path.resolve(String(payload.sourceManifestPath));
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024 * 1024 || Number(payload.sourceCount) < 0 || Number(payload.sourceCount) > 200000) throw new Error('团片恢复来源清单大小或数量超出安全边界');
  if (digestFile(manifestPath) !== String(payload.sourceManifestSha256 || '').toLowerCase()) throw new Error('团片恢复来源清单摘要不匹配');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.schema !== SOURCE_MANIFEST_SCHEMA || manifest.schemaVersion !== 1
    || manifest.operationId !== payload.operationId || manifest.componentId !== 'team-retouch'
    || !Array.isArray(manifest.entries) || manifest.entries.length !== Number(payload.sourceCount)) throw new Error('团片恢复来源清单无效');
  const contract = manifest.receiptContract;
  if (!contract || contract.version !== 1 || contract.schema !== RECEIPT_SCHEMA
    || !['keyField', 'dispositionField', 'destinationField', 'reasonField', 'messageField'].every(field => typeof contract[field] === 'string' && contract[field])
    || !contract.actions || !['applied', 'skipped', 'hostPreserved'].every(action => typeof contract.actions[action] === 'string' && contract.actions[action])
    || !Array.isArray(contract.skipReasons)) throw new Error('团片恢复回执契约无效');
  const stageRoot = path.dirname(manifestPath); const keys = new Set();
  const sources = manifest.entries.map(entry => {
    const absolutePath = path.resolve(String(entry.absolutePath || ''));
    if (!insidePath(stageRoot, absolutePath) || keys.has(entry.sourceKey)) throw new Error('团片恢复来源清单包含越界或重复来源');
    keys.add(entry.sourceKey);
    const stat = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== Number(entry.size) || digestFile(absolutePath) !== String(entry.sha256 || '').toLowerCase()) throw new Error('团片恢复来源对象校验失败');
    const relativePath = String(entry.destinationRelativePath || entry.relativePath || entry.sourceKey || '').replace(/\\/g, '/');
    let format = String(entry.format || '');
    // Old manifests had no component metadata. Compatibility is deliberately
    // limited to Team Retouch's two exact, historically-owned database paths.
    if (format === 'unversioned') {
      if (entry.scope === 'component-storage' && relativePath === 'team-retouch/storage.sqlite3') format = 'component-storage-v1';
      else if (entry.scope === 'domain-database' && relativePath === 'team-retouch.sqlite3') format = 'legacy-domain-v1';
    }
    return { ...entry, relativePath, format, path: absolutePath };
  });
  return { sources, manifest };
};
const writeRestoreReceipt = (payload, manifest, sources, result) => {
  if (!manifest) return result;
  const contract = manifest.receiptContract || {
    keyField: 'sourceKey', dispositionField: 'disposition', destinationField: 'destinationRelativePath', reasonField: 'reason', messageField: 'message',
    actions: { applied: 'applied', skipped: 'intentionally-skipped', hostPreserved: 'host-preserved' },
  };
  const consumed = new Set(result.consumedPaths || []);
  const mappings = new Map((result.consumedPathMappings || []).map(item => [String(item.path), String(item.destinationRelativePath || '')]));
  const skipped = new Map((result.pathDispositions || []).map(item => [String(item.path || item.relativePath), item]));
  const dispositions = sources.map(source => {
    const sourceRelativePath = String(source.relativePath || '');
    if (consumed.has(sourceRelativePath)) return {
      [contract.keyField]: source.sourceKey,
      [contract.dispositionField]: contract.actions.applied,
      ...(mappings.get(sourceRelativePath) ? { [contract.destinationField]: mappings.get(sourceRelativePath) } : {}),
    };
    const item = skipped.get(sourceRelativePath);
    const action = String(item?.action || item?.disposition || (payload.mode === 'workspace' ? 'host-preserved' : 'intentionally-skipped'));
    return {
      [contract.keyField]: source.sourceKey,
      [contract.dispositionField]: action === 'preserved' || action === 'host-preserved' ? contract.actions.hostPreserved
        : action === 'rebuildable' || action === 'intentionally-skipped' ? contract.actions.skipped : action,
      [contract.reasonField]: String(item?.reason || item?.warning || (payload.mode === 'workspace' ? 'host-control' : 'other-project')),
      ...(item?.message ? { [contract.messageField]: String(item.message) } : {}),
    };
  });
  const receipt = {
    schema: RECEIPT_SCHEMA, schemaVersion: 1, operationId: payload.operationId,
    sourceManifestSha256: payload.sourceManifestSha256,
    status: result.status, imported: result.imported || {}, warnings: result.warnings || [], dispositions,
  };
  const receiptPath = path.join(path.dirname(payload.sourceManifestPath), `receipt-${crypto.randomUUID()}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', flag: 'wx' });
  return {
    schemaVersion: 1, operationId: payload.operationId, status: result.status,
    receiptPath, receiptSha256: digestFile(receiptPath), dispositionCount: dispositions.length,
  };
};
const safeStorageRelativePath = relativePath => {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized.startsWith('team-retouch/') || normalized.includes('\0')) return '';
  const child = normalized.slice('team-retouch/'.length);
  if (!child || path.posix.isAbsolute(child) || child.split('/').some(segment => !segment || segment === '.' || segment === '..')) return '';
  return child;
};
const isHostControlPath = child => child === 'restore-receipts.json' || child.startsWith('restore-receipts/') || child.startsWith('.host-');
const assertStorageRoot = rootPath => {
  const root = path.resolve(rootPath); const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error('团片恢复拒绝链接或重解析的组件存储根目录');
  if (stat) {
    const actual = fs.realpathSync.native(root); const normalize = value => path.resolve(value).toLowerCase();
    if (normalize(actual) !== normalize(root)) throw new Error('团片恢复拒绝重解析的组件存储根目录');
  }
};
const assertNoStorageLinks = (rootPath, candidatePath) => {
  const root = path.resolve(rootPath); const candidate = path.resolve(candidatePath);
  assertStorageRoot(root);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error('团片恢复私有文件路径越界');
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`团片恢复拒绝链接或重解析点：${current}`);
  }
};
const snapshotDatabase = databasePath => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-team-db-rollback-'));
  const present = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    if (fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
      fs.copyFileSync(source, path.join(temporaryRoot, `database${suffix}`)); present.push(suffix);
    }
  }
  return {
    restore: () => {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${databasePath}${suffix}`, { force: true });
      for (const suffix of present) fs.copyFileSync(path.join(temporaryRoot, `database${suffix}`), `${databasePath}${suffix}`);
    },
    cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
  };
};
const publishWorkspacePrivateFiles = ({ sources, destinationDataPath, payload, fault }) => {
  if (!destinationDataPath) throw new Error('团片工作区恢复缺少组件私有文件目录');
  const databaseNames = new Set(['storage.sqlite3', 'storage.sqlite3-wal', 'storage.sqlite3-shm']);
  const replacements = buildReplacements(payload);
  const entries = [];
  for (const source of sources || []) {
    const child = safeStorageRelativePath(source.relativePath);
    if (!child || databaseNames.has(child) || isHostControlPath(child)) continue;
    const stat = fs.lstatSync(source.path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`团片恢复拒绝非普通私有文件：${source.relativePath}`);
    if (Number.isSafeInteger(Number(source.size)) && Number(source.size) !== stat.size) throw new Error(`团片恢复私有文件大小不匹配：${source.relativePath}`);
    if (source.sha256 && digestFile(source.path) !== String(source.sha256).toLowerCase()) throw new Error(`团片恢复私有文件摘要不匹配：${source.relativePath}`);
    entries.push({ source, child, destination: path.resolve(destinationDataPath, ...child.split('/')) });
  }
  const root = path.resolve(destinationDataPath);
  if (entries.some(entry => entry.destination === root || !entry.destination.startsWith(`${root}${path.sep}`))) throw new Error('团片恢复私有文件路径越界');
  // Publish staging and backups live beside the destination so the final
  // rename is same-volume even when the OS temp directory is on another disk.
  const controlRoot = path.resolve(String(payload.targetStorage?.controlPath || root));
  assertStorageRoot(controlRoot); fs.mkdirSync(controlRoot, { recursive: true }); assertStorageRoot(controlRoot);
  const stagingRoot = fs.mkdtempSync(path.join(controlRoot, '.team-retouch-restore-'));
  const touched = [];
  try {
    for (const [index, entry] of entries.entries()) {
      const staged = path.join(stagingRoot, 'staged', String(index)); fs.mkdirSync(path.dirname(staged), { recursive: true });
      if (entry.child.toLowerCase().endsWith('.json')) {
        const original = fs.readFileSync(entry.source.path, 'utf8');
        fs.writeFileSync(staged, rewriteProjectIdentityJson(rewriteJson(original, replacements), payload), 'utf8');
      } else fs.copyFileSync(entry.source.path, staged);
      entry.staged = staged;
    }
    for (const [index, entry] of entries.entries()) {
      assertNoStorageLinks(root, entry.destination);
      fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
      assertNoStorageLinks(root, entry.destination);
      const backup = path.join(stagingRoot, 'backup', String(index));
      touched.push(entry);
      if (fs.statSync(entry.destination, { throwIfNoEntry: false })?.isFile()) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.renameSync(entry.destination, backup); entry.backup = backup; }
      if (fault === 'after-private-backup' || process.env.PHOTOFLOW_TEST_FAULT_COMPONENT_RESTORE === 'after-private-backup') throw new Error('injected team-retouch private file publish failure');
      fs.renameSync(entry.staged, entry.destination); entry.published = true;
      if (fault === 'after-private-file' || process.env.PHOTOFLOW_TEST_FAULT_COMPONENT_RESTORE === 'after-private-file') throw new Error('injected team-retouch private file restore failure');
    }
    return entries.map(entry => String(entry.source.originalRelativePath || entry.source.relativePath));
  } catch (error) {
    for (const entry of [...touched].reverse()) {
      if (entry.published) fs.rmSync(entry.destination, { force: true });
      if (entry.backup) fs.renameSync(entry.backup, entry.destination);
    }
    throw error;
  } finally { fs.rmSync(stagingRoot, { recursive: true, force: true }); }
};

const importRows = (db, table, sourceProjectId, targetProjectId, replacements) => {
  if (!tableExists(db, 'portable', table)) return 0;
  const targetColumns = columns(db, 'main', table);
  const sourceColumns = new Set(columns(db, 'portable', table));
  const selected = targetColumns.filter(name => sourceColumns.has(name));
  if (!selected.includes('project_id')) throw new Error(`团片恢复源表 ${table} 缺少项目归属；已拒绝不安全导入`);
  const rows = db.prepare(`SELECT ${selected.map(quote).join(',')} FROM portable.${quote(table)} WHERE project_id=?`).all(sourceProjectId);
  if (!rows.length) return 0;
  const statement = db.prepare(`INSERT INTO main.${quote(table)}(${selected.map(quote).join(',')}) VALUES(${selected.map(() => '?').join(',')})`);
  for (const row of rows) {
    const values = selected.map(name => {
      if (name === 'project_id') return targetProjectId;
      if ((PATH_COLUMNS[table] || []).includes(name)) return replacePath(row[name], replacements);
      if ((JSON_COLUMNS[table] || []).includes(name)) return rewriteJson(row[name], replacements);
      return row[name];
    });
    statement.run(...values);
  }
  return rows.length;
};

const preparePortable = (sourcePath, ensureSchema) => {
  if (!sourcePath || !fs.statSync(sourcePath, { throwIfNoEntry: false })?.isFile()) throw new Error('团片恢复源数据库不存在');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-team-restore-'));
  const portablePath = path.join(temporaryRoot, 'portable.sqlite3');
  fs.copyFileSync(sourcePath, portablePath, fs.constants.COPYFILE_EXCL);
  // Backup staging is quiesced by the Host, but a SQLite snapshot may still
  // legitimately carry committed WAL pages. Keep its sidecars paired with the
  // main file before opening the private compatibility copy.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${sourcePath}${suffix}`;
    if (fs.statSync(sidecar, { throwIfNoEntry: false })?.isFile()) fs.copyFileSync(sidecar, `${portablePath}${suffix}`, fs.constants.COPYFILE_EXCL);
  }
  const portable = ensureSchema(portablePath); portable.exec('PRAGMA wal_checkpoint(TRUNCATE)'); portable.close();
  return { portablePath, cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) };
};

const restoreProjectStorage = ({ sourcePath, destinationPath, payload, ensureSchema, fault }) => {
  const operationId = String(payload.operationId || '');
  const targetProjectId = String(payload.project?.id || '');
  const sourceProjectId = String(payload.project?.sourceId || targetProjectId);
  if (!operationId || !targetProjectId) throw new Error('团片项目恢复缺少 operationId 或 project.id');
  const prepared = preparePortable(sourcePath, ensureSchema);
  const db = ensureSchema(destinationPath);
  try {
    const marker = `restore_operation:${operationId}`;
    if (db.prepare('SELECT value FROM meta WHERE key=?').get(marker)) return { schemaVersion: 1, status: 'already-committed', operationId, imported: {} };
    db.prepare('ATTACH DATABASE ? AS portable').run(prepared.portablePath);
    const replacements = buildReplacements(payload); const imported = {};
    db.exec('BEGIN IMMEDIATE');
    try {
      // Request guards describe in-flight compare-and-swap requests, not
      // durable project state. A restored project must never inherit them.
      db.prepare('DELETE FROM team_revision_guards WHERE project_id=?').run(targetProjectId);
      for (const key of projectMigrationMetaKeys(targetProjectId)) db.prepare('DELETE FROM meta WHERE key=?').run(key);
      for (const table of DELETE_ORDER) db.prepare(`DELETE FROM ${quote(table)} WHERE project_id=?`).run(targetProjectId);
      if (fault === 'after-delete' || process.env.PHOTOFLOW_TEST_FAULT_COMPONENT_RESTORE === 'after-delete') throw new Error('injected team-retouch restore failure');
      for (const table of INSERT_ORDER) imported[table] = importRows(db, table, sourceProjectId, targetProjectId, replacements);
      const previousRevision = Number(db.prepare('SELECT revision FROM team_project_revisions WHERE project_id=?').get(targetProjectId)?.revision || 0);
      const sourceRevision = Number(db.prepare('SELECT revision FROM portable.team_project_revisions WHERE project_id=?').get(sourceProjectId)?.revision || 0);
      db.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision').run(targetProjectId, Math.max(previousRevision + 1, sourceRevision));
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(marker, JSON.stringify({ projectId: targetProjectId, sourceProjectId, committedAt: Date.now() }));
      if (fault === 'before-commit' || process.env.PHOTOFLOW_TEST_FAULT_COMPONENT_RESTORE === 'before-commit') throw new Error('injected team-retouch restore failure');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { schemaVersion: 1, status: 'committed', operationId, imported };
  } finally { try { db.exec('DETACH DATABASE portable'); } catch {} db.close(); prepared.cleanup(); }
};

const restoreWorkspaceStorage = ({ sourcePath, destinationPath, payload, ensureSchema, fault }) => {
  const operationId = String(payload.operationId || '');
  if (!operationId) throw new Error('团片工作区恢复缺少 operationId');
  const prepared = preparePortable(sourcePath, ensureSchema); const source = ensureSchema(prepared.portablePath);
  let projectIds;
  try {
    const discovered = new Set(source.prepare('SELECT project_id FROM team_project_revisions').all().map(row => String(row.project_id)).filter(Boolean));
    for (const table of PROJECT_TABLES) {
      if (!tableExists(source, 'main', table) || !columns(source, 'main', table).includes('project_id')) continue;
      for (const row of source.prepare(`SELECT DISTINCT project_id FROM ${quote(table)} WHERE project_id<>''`).all()) discovered.add(String(row.project_id));
    }
    projectIds = [...discovered];
  }
  finally { source.close(); }
  const imported = {}; const db = ensureSchema(destinationPath);
  try {
    const marker = `restore_operation:${operationId}`;
    if (db.prepare('SELECT value FROM meta WHERE key=?').get(marker)) return { schemaVersion: 1, status: 'already-committed', operationId, imported: {} };
    db.prepare('ATTACH DATABASE ? AS portable').run(prepared.portablePath);
    const replacements = buildReplacements(payload);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM team_revision_guards');
      db.exec("DELETE FROM meta WHERE key LIKE 'legacy_project_artifacts_v2_state:%' OR key LIKE 'legacy_project_artifacts_v2:%'");
      for (const table of DELETE_ORDER) db.exec(`DELETE FROM ${quote(table)}`);
      db.exec('DELETE FROM team_project_revisions');
      if (fault === 'after-delete' || process.env.PHOTOFLOW_TEST_FAULT_COMPONENT_RESTORE === 'after-delete') throw new Error('injected team-retouch restore failure');
      for (const projectId of [...new Set(projectIds)]) {
        imported[projectId] = {};
        for (const table of INSERT_ORDER) imported[projectId][table] = importRows(db, table, projectId, projectId, replacements);
        const revision = Number(db.prepare('SELECT revision FROM portable.team_project_revisions WHERE project_id=?').get(projectId)?.revision || 0);
        db.prepare('INSERT INTO team_project_revisions(project_id,revision) VALUES(?,?)').run(projectId, Math.max(1, revision));
      }
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(marker, JSON.stringify({ committedAt: Date.now(), projectIds }));
      if (fault === 'before-commit' || process.env.PHOTOFLOW_TEST_FAULT_COMPONENT_RESTORE === 'before-commit') throw new Error('injected team-retouch restore failure');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { schemaVersion: 1, status: 'committed', operationId, imported };
  } finally { try { db.exec('DETACH DATABASE portable'); } catch {} db.close(); prepared.cleanup(); }
};

const restoreWorkspaceBundle = ({ source, sources, destinationPath, destinationDataPath, payload, ensureSchema, fault }) => {
  const rollback = snapshotDatabase(destinationPath);
  try {
    const result = restoreWorkspaceStorage({ sourcePath: source.path, destinationPath, payload, ensureSchema, fault });
    const consumedPaths = [String(source.relativePath || '')].filter(Boolean);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = (sources || []).find(item => item.relativePath === `${source.relativePath}${suffix}`);
      if (sidecar) consumedPaths.push(String(sidecar.relativePath));
    }
    consumedPaths.push(...publishWorkspacePrivateFiles({ sources, destinationDataPath, payload, fault }));
    const applied = [...new Set(consumedPaths)];
    const pathDispositions = (sources || []).filter(item => !applied.includes(String(item.relativePath || ''))).map(item => ({
      path: String(item.relativePath || ''), action: 'host-preserved',
      reason: item.format === 'legacy-domain-v1' && source.format === 'component-storage-v1' ? 'redundant-transition-source' : isHostControlPath(safeStorageRelativePath(item.relativePath)) ? 'host-control' : 'outside-component-storage',
    }));
    return { ...result, consumedPaths: applied, pathDispositions };
  } catch (error) { rollback.restore(); throw error; }
  finally { rollback.cleanup(); }
};

const projectPrivateSources = ({ source, sources, payload }) => {
  const sourceProjectId = String(payload.project?.sourceId || payload.project?.id || '');
  const targetProjectId = String(payload.project?.id || '');
  const sourceName = String(payload.project?.sourceName || payload.project?.name || '');
  const targetName = String(payload.project?.targetName || payload.project?.name || sourceName);
  const sourceStatus = String(payload.project?.sourceStatus || payload.project?.status || '');
  const selected = []; const warnings = []; let ownershipLedger = null;
  const portable = preparePortable(source.path, databasePath => new DatabaseSync(databasePath));
  let db;
  try {
    db = new DatabaseSync(portable.portablePath);
    const photos = tableExists(db, 'main', 'team_retouch_photos')
      ? db.prepare('SELECT photo_id,base_version_id FROM team_retouch_photos WHERE project_id=?').all(sourceProjectId)
      : [];
    const mediaPrefixes = photos.map(row => `team-retouch/media/${String(row.photo_id)}/${String(row.base_version_id)}/`);
    const reviewSource = `team-retouch/workflow-return-reviews/${crypto.createHash('sha256').update(sourceProjectId).digest('hex')}/`;
    const reviewTarget = `team-retouch/workflow-return-reviews/${crypto.createHash('sha256').update(targetProjectId).digest('hex')}/`;
    const sourceProjectHash = crypto.createHash('sha256').update(sourceProjectId).digest('hex');
    const targetProjectHash = crypto.createHash('sha256').update(targetProjectId).digest('hex');
    const legacyWorkflowHash = sourceName && sourceStatus ? crypto.createHash('sha256').update(`${sourceStatus}\0${sourceName}`).digest('hex') : '';
    const legacyReviewHash = sourceName ? crypto.createHash('sha256').update(sourceName).digest('hex') : '';
    const byPath = new Map((sources || []).map(item => [String(item.relativePath || '').replace(/\\/g, '/'), item]));
    const legacyWorkflowPath = legacyWorkflowHash ? `team-retouch/workflows/${legacyWorkflowHash}.json` : '';
    const legacyWorkflow = legacyWorkflowPath ? byPath.get(legacyWorkflowPath) : null;
    const canonicalWorkflowPresent = byPath.has(`team-retouch/workflows/${sourceProjectHash}.json`);
    const legacyWorkflowOwned = Boolean(!canonicalWorkflowPresent && legacyWorkflow && readBoundJson(legacyWorkflow, {
      projectId: sourceProjectId, projectName: sourceName, projectStatus: sourceStatus,
    }, 'workflow'));
    const legacyReviewPrefix = legacyReviewHash ? `team-retouch/workflow-return-reviews/${legacyReviewHash}/` : '';
    const legacyReviewSession = legacyReviewPrefix ? byPath.get(`${legacyReviewPrefix}session.json`) : null;
    const canonicalReviewPresent = byPath.has(`${reviewSource}session.json`);
    const legacyReviewOwned = Boolean(!canonicalReviewPresent && legacyReviewSession && readBoundJson(legacyReviewSession, {
      projectId: sourceProjectId, projectName: sourceName, projectStatus: sourceStatus,
    }, 'review'));
    const named = new Map();
    if (sourceName) for (const directory of ['workflow-settings', 'identity-similarities']) {
      named.set(`team-retouch/${directory}/${crypto.createHash('sha256').update(sourceName).digest('hex')}.json`, `team-retouch/${directory}/${crypto.createHash('sha256').update(targetName).digest('hex')}.json`);
    }
    for (const item of sources || []) {
      const relativePath = String(item.relativePath || '').replace(/\\/g, '/');
      let targetRelativePath = mediaPrefixes.some(prefix => relativePath.startsWith(prefix)) ? relativePath : named.get(relativePath);
      if (!targetRelativePath && relativePath.startsWith(reviewSource)) targetRelativePath = `${reviewTarget}${relativePath.slice(reviewSource.length)}`;
      if (!targetRelativePath && relativePath === `team-retouch/workflows/${sourceProjectHash}.json`) targetRelativePath = `team-retouch/workflows/${targetProjectHash}.json`;
      if (!targetRelativePath && relativePath.startsWith(`team-retouch/workflow-content/${sourceProjectHash}/`)) targetRelativePath = `team-retouch/workflow-content/${targetProjectHash}/${relativePath.slice(`team-retouch/workflow-content/${sourceProjectHash}/`.length)}`;
      if (!targetRelativePath && legacyWorkflowOwned && relativePath === legacyWorkflowPath) targetRelativePath = `team-retouch/workflows/${targetProjectHash}.json`;
      if (!targetRelativePath && legacyWorkflowOwned && relativePath.startsWith(`team-retouch/workflow-content/${legacyWorkflowHash}/`)
        && projectJsonMatchesBinding(item, { projectId: sourceProjectId, projectName: sourceName, projectStatus: sourceStatus })) targetRelativePath = `team-retouch/workflow-content/${targetProjectHash}/${relativePath.slice(`team-retouch/workflow-content/${legacyWorkflowHash}/`.length)}`;
      if (!targetRelativePath && legacyReviewOwned && relativePath.startsWith(legacyReviewPrefix)) targetRelativePath = `${reviewTarget}${relativePath.slice(legacyReviewPrefix.length)}`;
      if (!targetRelativePath && relativePath.startsWith(`team-retouch/output-ownership/${sourceProjectHash}/`)) targetRelativePath = `team-retouch/output-ownership/${targetProjectHash}/${relativePath.slice(`team-retouch/output-ownership/${sourceProjectHash}/`.length)}`;
      if (!targetRelativePath && relativePath.startsWith('team-retouch/workflow-jobs/') && relativePath.endsWith('.json')) {
        try {
          const value = JSON.parse(fs.readFileSync(item.path, 'utf8'));
          if (String(value.projectId || '') === sourceProjectId) {
            const targetStatus = String(payload.project?.targetStatus || payload.project?.status || value.projectStatus || '');
            targetRelativePath = `team-retouch/workflow-jobs/${crypto.createHash('sha256').update(`${targetProjectId}:${targetStatus}:${targetName}`).digest('hex')}.json`;
          }
        } catch { throw new Error(`团片项目恢复无法验证 workflow job 归属：${relativePath}`); }
      }
      if (targetRelativePath) selected.push({ ...item, originalRelativePath: relativePath, relativePath: targetRelativePath });
      else if (relativePath.startsWith('team-retouch/batches/')) warnings.push({ path: relativePath, classification: 'rebuildable-cache', message: '临时算法批次不会进入项目恢复，可在下次操作时重建' });
      else if (relativePath === 'team-retouch/output-ownership/working-images.json') ownershipLedger = item;
      else if (relativePath.startsWith('team-retouch/command-log/')) warnings.push({ path: relativePath, classification: 'non-authoritative-audit', message: '共享审计日志保持当前工作区版本，项目权威状态已由数据库恢复' });
      else if (relativePath.startsWith('team-retouch/') && !['team-retouch/storage.sqlite3', 'team-retouch/storage.sqlite3-wal', 'team-retouch/storage.sqlite3-shm'].includes(relativePath)) warnings.push({ path: relativePath, classification: 'other-project', message: '该私有文件不属于目标项目，已保持当前工作区版本' });
    }
  } finally { db?.close(); portable.cleanup(); }
  return { selected, warnings, ownershipLedger };
};

const mergeProjectOwnershipLedger = ({ source, destinationDataPath, payload }) => {
  if (!source) return [];
  const stat = fs.lstatSync(source.path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('团片项目恢复拒绝无效 ownership ledger');
  if (source.sha256 && digestFile(source.path) !== String(source.sha256).toLowerCase()) throw new Error('团片项目恢复 ownership ledger 摘要不匹配');
  const sourceLedger = JSON.parse(fs.readFileSync(source.path, 'utf8') || '{}');
  const targetPath = path.join(destinationDataPath, 'output-ownership', 'working-images.json');
  assertNoStorageLinks(destinationDataPath, targetPath);
  const targetLedger = fs.statSync(targetPath, { throwIfNoEntry: false })?.isFile() ? JSON.parse(fs.readFileSync(targetPath, 'utf8') || '{}') : {};
  const sourcePrefix = String(payload.project?.sourceRelativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const targetPrefix = String(payload.project?.targetRelativePath || sourcePrefix).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!sourcePrefix || !targetPrefix) return [{ path: source.relativePath, classification: 'non-authoritative-audit', message: '缺少项目相对路径，旧共享 ownership ledger 未安全合并' }];
  const inside = (key, prefix) => key === prefix || key.startsWith(`${prefix}/`);
  for (const key of Object.keys(targetLedger)) if (inside(key, targetPrefix)) delete targetLedger[key];
  for (const [key, value] of Object.entries(sourceLedger)) if (inside(key, sourcePrefix)) targetLedger[`${targetPrefix}${key.slice(sourcePrefix.length)}`] = value;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const pending = path.join(path.dirname(targetPath), `.working-images-${crypto.randomUUID()}.tmp`);
  const backup = path.join(path.dirname(targetPath), `.working-images-${crypto.randomUUID()}.backup`); let backedUp = false;
  try {
    fs.writeFileSync(pending, rewriteJson(JSON.stringify(targetLedger), buildReplacements(payload)), 'utf8');
    if (fs.existsSync(targetPath)) { fs.renameSync(targetPath, backup); backedUp = true; }
    fs.renameSync(pending, targetPath);
    if (backedUp) fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.rmSync(pending, { force: true });
    if (backedUp) { fs.rmSync(targetPath, { force: true }); fs.renameSync(backup, targetPath); }
    throw error;
  } finally { fs.rmSync(pending, { force: true }); fs.rmSync(backup, { force: true }); }
  return [];
};

const restoreProjectBundle = ({ source, sources, destinationPath, destinationDataPath, payload, ensureSchema, fault }) => {
  const rollback = snapshotDatabase(destinationPath);
  try {
    const privatePlan = source.format === 'component-storage-v1' ? projectPrivateSources({ source, sources, payload }) : { selected: [], warnings: [] };
    const result = restoreProjectStorage({ sourcePath: source.path, destinationPath, payload, ensureSchema, fault });
    const consumedPaths = [String(source.relativePath || '')].filter(Boolean);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = (sources || []).find(item => item.relativePath === `${source.relativePath}${suffix}`);
      if (sidecar) consumedPaths.push(String(sidecar.relativePath));
    }
    consumedPaths.push(...publishWorkspacePrivateFiles({ sources: privatePlan.selected, destinationDataPath, payload, fault }));
    const ledgerWarnings = mergeProjectOwnershipLedger({ source: privatePlan.ownershipLedger, destinationDataPath, payload });
    if (privatePlan.ownershipLedger && !ledgerWarnings.length) consumedPaths.push(String(privatePlan.ownershipLedger.relativePath));
    const applied = [...new Set(consumedPaths)]; const warnings = [...privatePlan.warnings, ...ledgerWarnings];
    const warningByPath = new Map(warnings.map(item => [String(item.path), item]));
    const pathDispositions = (sources || []).filter(item => !applied.includes(String(item.relativePath || ''))).map(item => {
      const pathValue = String(item.relativePath || ''); const warning = warningByPath.get(pathValue);
      return { path: pathValue, action: 'intentionally-skipped', reason: warning?.classification || (item.format === 'legacy-domain-v1' ? 'redundant-transition-source' : 'other-project'), ...(warning?.message ? { message: warning.message } : {}) };
    });
    const consumedPathMappings = privatePlan.selected.filter(item => item.originalRelativePath !== item.relativePath).map(item => ({ path: item.originalRelativePath, destinationRelativePath: item.relativePath }));
    return { ...result, consumedPaths: applied, consumedPathMappings, pathDispositions, warnings };
  } catch (error) { rollback.restore(); throw error; }
  finally { rollback.cleanup(); }
};

module.exports = { restoreProjectStorage, restoreWorkspaceStorage, restoreWorkspaceBundle, restoreProjectBundle, publishWorkspacePrivateFiles, projectPrivateSources, mergeProjectOwnershipLedger, selectRestoreSource, replacePath, rewriteJson, loadRestoreSources, writeRestoreReceipt };
