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
  'team_output_outbox', 'team_cleanup_outbox',
]);
const INSERT_ORDER = Object.freeze([
  'team_retouch_photos', 'team_person_identities', 'team_patch_tasks',
  'team_person_assignments', 'team_person_exclusions', 'team_task_stages',
  'team_task_artifacts', 'team_workflow_reconcile_pending',
  'team_workflow_review_confirmations', 'team_durable_operations',
  'team_workflow_settings', 'team_workflow_state', 'team_review_state',
  'team_output_outbox', 'team_cleanup_outbox',
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
  team_output_outbox: ['source_json', 'target_json', 'receipt_json', 'result_json'],
  team_workflow_settings: ['settings_json'],
});
const selectRestoreSource = sources => (sources || []).find(item => item.format === 'component-storage-v1');

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
  const sourceProjectId = String(payload.project?.sourceId || payload.project?.id || '');
  const targetProjectId = String(payload.project?.id || '');
  if (sourceProjectId && targetProjectId) {
    const sourceHash = crypto.createHash('sha256').update(sourceProjectId).digest('hex');
    const targetHash = crypto.createHash('sha256').update(targetProjectId).digest('hex');
    const sourceDataRoot = String(payload.sourceWorkspace?.dataRoot || '');
    const targetComponentRoot = String(payload.targetStorage?.dataPath || path.join(String(payload.targetWorkspace?.dataRoot || ''), 'components', 'team-retouch'));
    for (const sourceComponentRoot of [path.join(sourceDataRoot, 'components', 'team-retouch'), path.join(sourceDataRoot, 'team-retouch')]) {
      add(path.join(sourceComponentRoot, 'projects', sourceHash), path.join(targetComponentRoot, 'projects', targetHash));
    }
  }
  for (const item of payload.additionalPathReplacements || []) add(item.from, item.to);
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
  if (!sourceId || !targetId || sourceId === targetId) return value;
  let parsed; try { parsed = JSON.parse(value); } catch { return value; }
  const visit = (item, key = '') => {
    if (key === 'projectId' && item === sourceId) return targetId;
    if (typeof item === 'string') return item === sourceId ? targetId : item;
    if (Array.isArray(item)) return item.map(child => visit(child));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey === sourceId ? targetId : childKey, visit(child, childKey)]));
    return item;
  };
  return JSON.stringify(visit(parsed));
};

const digestFile = filePath => {
  const hash = crypto.createHash('sha256'); const descriptor = fs.openSync(filePath, 'r'); const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { for (;;) { const count = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
};
const copyFromStableHandle = (sourcePath, destinationPath, expectedSize, expectedDigest) => {
  const source = fs.openSync(sourcePath, 'r'); let destination;
  const hash = crypto.createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const stat = fs.fstatSync(source);
    if (!stat.isFile() || stat.size !== Number(expectedSize)) throw new Error('团片恢复来源 handle 大小不匹配');
    destination = fs.openSync(destinationPath, 'wx');
    for (;;) {
      const count = fs.readSync(source, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count));
      let written = 0; while (written < count) written += fs.writeSync(destination, buffer, written, count - written);
    }
  } finally { if (destination !== undefined) fs.closeSync(destination); fs.closeSync(source); }
  if (hash.digest('hex') !== String(expectedDigest || '').toLowerCase()) { fs.rmSync(destinationPath, { force: true }); throw new Error('团片恢复来源在复制期间发生替换'); }
};
const SOURCE_MANIFEST_SCHEMA = 'component-backup-restore-sources-v1';
const RECEIPT_SCHEMA = 'component-backup-restore-receipt-v1';
const insidePath = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const loadRestoreSources = payload => {
  if (!payload?.sourceManifestPath) throw Object.assign(new Error('团片恢复必须由 Host source manifest 授权'), { code: 'COMPONENT_RESTORE_MANIFEST_REQUIRED' });
  const manifestPath = path.resolve(String(payload.sourceManifestPath));
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024 * 1024 || Number(payload.sourceCount) < 0 || Number(payload.sourceCount) > 200000) throw new Error('团片恢复来源清单大小或数量超出安全边界');
  const manifestHandle = fs.openSync(manifestPath, 'r'); let manifestBytes;
  try {
    const stableStat = fs.fstatSync(manifestHandle);
    if (!stableStat.isFile() || stableStat.size !== manifestStat.size || stableStat.size > 64 * 1024 * 1024) throw new Error('团片恢复来源清单在打开期间发生替换');
    manifestBytes = fs.readFileSync(manifestHandle);
  } finally { fs.closeSync(manifestHandle); }
  if (crypto.createHash('sha256').update(manifestBytes).digest('hex') !== String(payload.sourceManifestSha256 || '').toLowerCase()) throw new Error('团片恢复来源清单摘要不匹配');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest?.schema !== SOURCE_MANIFEST_SCHEMA || manifest.schemaVersion !== 1
    || manifest.operationId !== payload.operationId || manifest.componentId !== 'team-retouch'
    || !Array.isArray(manifest.entries) || manifest.entries.length !== Number(payload.sourceCount)) throw new Error('团片恢复来源清单无效');
  const contract = manifest.receiptContract;
  if (!contract || contract.version !== 1 || contract.schema !== RECEIPT_SCHEMA
    || !['keyField', 'dispositionField', 'destinationField', 'reasonField', 'messageField'].every(field => typeof contract[field] === 'string' && contract[field])
    || !contract.actions || !['applied', 'skipped', 'hostPreserved'].every(action => typeof contract.actions[action] === 'string' && contract.actions[action])
    || !Array.isArray(contract.skipReasons)) throw new Error('团片恢复回执契约无效');
  if (String(manifest.sourceVersion || '') !== String(payload.sourceVersion || '') || String(manifest.targetVersion || '') !== String(payload.targetVersion || '')) throw new Error('团片恢复版本绑定与 source manifest 不一致');
  const hostStageRoot = path.dirname(manifestPath); const controlRoot = path.resolve(String(payload.targetStorage?.controlPath || os.tmpdir()));
  fs.mkdirSync(controlRoot, { recursive: true }); const internalStage = fs.mkdtempSync(path.join(controlRoot, '.team-retouch-source-'));
  const keys = new Set();
  let sources;
  try { sources = manifest.entries.map((entry, index) => {
    const absolutePath = path.resolve(String(entry.absolutePath || ''));
    if (!insidePath(hostStageRoot, absolutePath) || keys.has(entry.sourceKey)) throw new Error('团片恢复来源清单包含越界或重复来源');
    keys.add(entry.sourceKey);
    const stat = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== Number(entry.size)) throw new Error('团片恢复来源对象校验失败');
    const stagedPath = path.join(internalStage, String(index));
    copyFromStableHandle(absolutePath, stagedPath, entry.size, entry.sha256);
    const relativePath = String(entry.destinationRelativePath || entry.relativePath || entry.sourceKey || '').replace(/\\/g, '/');
    return { ...entry, relativePath, format: String(entry.format || ''), path: stagedPath };
  }); }
  catch (error) { fs.rmSync(internalStage, { recursive: true, force: true }); throw error; }
  const databaseSource = selectRestoreSource(sources);
  if (databaseSource) for (const suffix of ['-wal','-shm']) {
    const sidecar = sources.find(item => item.relativePath === `${databaseSource.relativePath}${suffix}`);
    if (sidecar) fs.copyFileSync(sidecar.path, `${databaseSource.path}${suffix}`, fs.constants.COPYFILE_EXCL);
  }
  return { sources, manifest, cleanup: () => fs.rmSync(internalStage, { recursive: true, force: true }) };
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
const listOrdinaryFiles = root => {
  const result = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name); const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error(`团片 exact restore 拒绝链接或重解析点：${candidate}`);
      if (stat.isDirectory()) visit(candidate); else if (stat.isFile()) result.push(candidate);
    }
  };
  if (fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) visit(root);
  return result;
};
const publishWorkspacePrivateFiles = ({ sources, destinationDataPath, payload, fault, exactScope = null }) => {
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
        let rewritten = rewriteProjectIdentityJson(rewriteJson(original, replacements), payload);
        if (payload.mode === 'project' || payload.project?.id) {
          const normalizedChild = entry.child.replace(/\\/g, '/'); let parsed; try { parsed = JSON.parse(rewritten); } catch { parsed = null; }
          if (parsed && normalizedChild.startsWith('workflows/')) rewritten = JSON.stringify({ ...parsed, outputOwnership: {}, recovery: { state: 'needs-republish', reason: 'project-restore-host-scope' } });
          else if (parsed && normalizedChild.startsWith('output-ownership/')) rewritten = JSON.stringify({ recovery: { state: 'needs-republish', reason: 'project-restore-host-scope' } });
          else if (parsed && normalizedChild.startsWith('output-cleanup/')) rewritten = JSON.stringify({ version: 1, projectId: String(payload.project?.id || ''), pending: [], recovery: { state: 'needs-republish', reason: 'project-restore-host-scope' } });
        }
        fs.writeFileSync(staged, rewritten, 'utf8');
      } else fs.copyFileSync(entry.source.path, staged);
      entry.staged = staged;
    }
    const desired = new Set(entries.map(entry => path.resolve(entry.destination).toLowerCase()));
    const existing = [];
    if (exactScope?.workspace) existing.push(...listOrdinaryFiles(root));
    else {
      for (const exactRoot of exactScope?.roots || []) existing.push(...listOrdinaryFiles(exactRoot));
      for (const exactFile of exactScope?.files || []) if (fs.statSync(exactFile, { throwIfNoEntry: false })?.isFile()) existing.push(exactFile);
    }
    let deletionIndex = 0;
    for (const existingPath of [...new Set(existing.map(item => path.resolve(item)))]) {
      if (isInsidePath(stagingRoot, existingPath) || desired.has(existingPath.toLowerCase())) continue;
      const child = path.relative(root, existingPath).replace(/\\/g, '/');
      if (!child || child.startsWith('../') || ['storage.sqlite3','storage.sqlite3-wal','storage.sqlite3-shm'].includes(child) || isHostControlPath(child)) continue;
      assertNoStorageLinks(root, existingPath);
      const backup = path.join(stagingRoot, 'backup-delete', String(deletionIndex++)); fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.renameSync(existingPath, backup);
      touched.push({ destination: existingPath, backup, published: false, deletedOnly: true });
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
const isInsidePath = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
      db.prepare('DELETE FROM team_project_revision_leases WHERE project_id=?').run(targetProjectId);
      for (const table of DELETE_ORDER) db.prepare(`DELETE FROM ${quote(table)} WHERE project_id=?`).run(targetProjectId);
      if (fault === 'after-delete' || process.env.PHOTOFLOW_TEST_FAULT_COMPONENT_RESTORE === 'after-delete') throw new Error('injected team-retouch restore failure');
      for (const table of INSERT_ORDER) imported[table] = table === 'team_output_outbox' ? 0 : importRows(db, table, sourceProjectId, targetProjectId, replacements);
      const insertOutbox = db.prepare(`INSERT INTO team_output_outbox(project_id,id,kind,fingerprint,idempotency_key,state,stage_id,source_json,target_json,receipt_json,result_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const row of payload.safeWorkingOutboxes || []) insertOutbox.run(row.project_id,row.id,row.kind,row.fingerprint,row.idempotency_key,row.state,row.stage_id,row.source_json,row.target_json,row.receipt_json,row.result_json,row.last_error,row.created_at,row.updated_at);
      imported.team_output_outbox = (payload.safeWorkingOutboxes || []).length;
      db.prepare('DELETE FROM team_workflow_state WHERE project_id=?').run(targetProjectId);
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
      db.exec('DELETE FROM team_project_revision_leases');
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
    consumedPaths.push(...publishWorkspacePrivateFiles({ sources, destinationDataPath, payload, fault, exactScope: { workspace: true } }));
    const applied = [...new Set(consumedPaths)];
    const pathDispositions = (sources || []).filter(item => !applied.includes(String(item.relativePath || ''))).map(item => ({
      path: String(item.relativePath || ''), action: 'host-preserved',
      reason: isHostControlPath(safeStorageRelativePath(item.relativePath)) ? 'host-control' : 'outside-component-storage',
    }));
    return { ...result, consumedPaths: applied, pathDispositions };
  } catch (error) { rollback.restore(); throw error; }
  finally { rollback.cleanup(); }
};

const projectPrivateSources = ({ sources, payload }) => {
  const sourceProjectId = String(payload.project?.sourceId || payload.project?.id || '');
  const targetProjectId = String(payload.project?.id || '');
  if (!sourceProjectId || !targetProjectId) throw new Error('团片项目恢复缺少当前项目 ID 绑定');
  const sourceHash = crypto.createHash('sha256').update(sourceProjectId).digest('hex');
  const targetHash = crypto.createHash('sha256').update(targetProjectId).digest('hex');
  const selected = []; const warnings = [];
  const mappings = new Map([
    [`team-retouch/workflows/${sourceHash}.json`, `team-retouch/workflows/${targetHash}.json`],
    [`team-retouch/workflow-settings/${sourceHash}.json`, `team-retouch/workflow-settings/${targetHash}.json`],
    [`team-retouch/identity-similarities/${sourceHash}.json`, `team-retouch/identity-similarities/${targetHash}.json`],
    [`team-retouch/workflow-jobs/${sourceHash}.json`, `team-retouch/workflow-jobs/${targetHash}.json`],
    [`team-retouch/output-cleanup/${sourceHash}.json`, `team-retouch/output-cleanup/${targetHash}.json`],
  ]);
  const prefixes = [
    [`team-retouch/projects/${sourceHash}/`, `team-retouch/projects/${targetHash}/`],
    [`team-retouch/workflow-content/${sourceHash}/`, `team-retouch/workflow-content/${targetHash}/`],
    [`team-retouch/workflow-return-reviews/${sourceHash}/`, `team-retouch/workflow-return-reviews/${targetHash}/`],
    [`team-retouch/output-ownership/${sourceHash}/`, `team-retouch/output-ownership/${targetHash}/`],
  ];
  for (const item of sources || []) {
    const relativePath = String(item.relativePath || '').replace(/\\/g, '/');
    let targetRelativePath = mappings.get(relativePath) || '';
    if (!targetRelativePath) for (const [from, to] of prefixes) if (relativePath.startsWith(from)) { targetRelativePath = `${to}${relativePath.slice(from.length)}`; break; }
    if (targetRelativePath) selected.push({ ...item, originalRelativePath: relativePath, relativePath: targetRelativePath });
    else if (relativePath.startsWith('team-retouch/batches/')) warnings.push({ path: relativePath, classification: 'rebuildable-cache', message: '临时算法批次不会进入项目恢复，可在下次操作时重建' });
    else if (relativePath.startsWith('team-retouch/command-log/')) warnings.push({ path: relativePath, classification: 'non-authoritative-audit', message: '工作区审计日志不属于单个项目恢复' });
    else if (relativePath.startsWith('team-retouch/') && !['team-retouch/storage.sqlite3', 'team-retouch/storage.sqlite3-wal', 'team-retouch/storage.sqlite3-shm'].includes(relativePath)) warnings.push({ path: relativePath, classification: 'other-project', message: '该当前格式私有文件不属于目标项目' });
  }
  return { selected, warnings };
};

const restoreProjectBundle = ({ source, sources, destinationPath, destinationDataPath, payload, ensureSchema, fault }) => {
  const rollback = snapshotDatabase(destinationPath);
  try {
    const privatePlan = projectPrivateSources({ sources, payload });
    const sourceProjectId = String(payload.project?.sourceId || payload.project?.id || ''); const targetProjectId = String(payload.project?.id || ''); const targetHash = crypto.createHash('sha256').update(targetProjectId).digest('hex');
    const referencedPaths = new Set(); const recoverableWorkingRows = []; const sourceDb = new DatabaseSync(source.path, { readOnly: true });
    try {
      for (const row of sourceDb.prepare('SELECT patch_path,mask_path,edited_patch_path FROM team_patch_tasks WHERE project_id=?').all(sourceProjectId)) for (const value of Object.values(row)) if (value) referencedPaths.add(String(value));
      for (const row of sourceDb.prepare('SELECT edited_patch_path FROM team_person_assignments WHERE project_id=?').all(sourceProjectId)) if (row.edited_patch_path) referencedPaths.add(String(row.edited_patch_path));
      for (const row of sourceDb.prepare('SELECT artifact_path FROM team_task_artifacts WHERE project_id=? AND is_deleted=0').all(sourceProjectId)) if (row.artifact_path) referencedPaths.add(String(row.artifact_path));
      for (const row of sourceDb.prepare("SELECT * FROM team_output_outbox WHERE project_id=? AND kind='working-output'").all(sourceProjectId)) {
        const result = JSON.parse(row.result_json || '{}'); const plan = result.continuationPlan; const materialized = result.materialized;
        if (!plan?.domain || String(plan.projectId) !== sourceProjectId || !materialized?.privatePath || !/^[0-9a-f]{64}$/i.test(String(materialized.sha256 || ''))) { if (row.state === 'completed') continue; throw new Error(`团片项目恢复 working outbox ${row.id} continuation/materialized 无效`); }
        const normalized = String(materialized.privatePath).replace(/\\/g, '/').toLowerCase();
        if (!normalized.includes('/imported-outputs/')) throw new Error(`团片项目恢复 working outbox ${row.id} materialized 超出 Host imported-outputs`);
        referencedPaths.add(String(materialized.privatePath)); recoverableWorkingRows.push({ row, result, plan, materialized });
      }
      if (recoverableWorkingRows.length > 2000) throw new Error('团片项目恢复 working outbox 数量超出安全边界');
    } finally { sourceDb.close(); }
    payload.additionalPathReplacements = [];
    const restoredPathBySource = new Map();
    for (const item of sources || []) {
      const relative = String(item.relativePath || '').replace(/\\/g, '/');
      if (!relative.startsWith('team-retouch/imported-outputs/')) continue;
      const child = relative.slice('team-retouch/'.length); const reference = [...referencedPaths].find(value => value.replace(/\\/g, '/').toLowerCase().endsWith(`/${child.toLowerCase()}`));
      if (!reference) continue;
      if (item.sha256 && digestFile(item.path) !== String(item.sha256).toLowerCase()) throw new Error(`团片项目恢复 imported-output 摘要不匹配：${relative}`);
      const targetRelative = `team-retouch/projects/${targetHash}/restored-imported/${crypto.createHash('sha256').update(relative).digest('hex')}${path.extname(relative)}`;
      privatePlan.selected.push({ ...item, originalRelativePath: relative, relativePath: targetRelative });
      const restoredPath = path.join(destinationDataPath, ...targetRelative.slice('team-retouch/'.length).split('/'));
      payload.additionalPathReplacements.push({ from: reference, to: restoredPath }); restoredPathBySource.set(reference, { path: restoredPath, digest: String(item.sha256 || '').toLowerCase() });
    }
    payload.safeWorkingOutboxes = recoverableWorkingRows.map(({ row, result, plan, materialized }) => {
      const mapped = restoredPathBySource.get(String(materialized.privatePath));
      if (!mapped || mapped.digest !== String(materialized.sha256).toLowerCase()) throw new Error(`团片项目恢复 working outbox ${row.id} 缺少精确匹配的 imported-output source`);
      const rewrittenPlan = JSON.parse(rewriteProjectIdentityJson(rewriteJson(JSON.stringify(plan), buildReplacements(payload)), payload));
      const restoreGeneration = crypto.createHash('sha256').update(`${targetProjectId}\0${row.idempotency_key}`).digest('hex').slice(0, 20);
      const logicalTarget = JSON.parse(row.target_json || '[]')[0]?.outputRelativePath || 'working/output'; const outputRelativePath = `团片协作/恢复-${restoreGeneration}/working/${path.posix.basename(String(logicalTarget).replace(/\\/g, '/'))}`;
      rewrittenPlan.projectId = targetProjectId; rewrittenPlan.logicalOutputRelativePath = String(rewrittenPlan.logicalOutputRelativePath || logicalTarget); rewrittenPlan.outputRelativePath = outputRelativePath; rewrittenPlan.ledgerPath = path.join(destinationDataPath, 'output-ownership', targetHash, 'working-images.json'); rewrittenPlan.preHostLocalEffects = 'none';
      return { ...row, project_id: targetProjectId, id: crypto.randomUUID(), fingerprint: crypto.createHash('sha256').update(`${targetProjectId}\0${row.fingerprint}`).digest('hex'), idempotency_key: `restore-working-${restoreGeneration}`, state: 'restore_republish', stage_id: '', source_json: JSON.stringify([{ sourcePath: mapped.path, digest: mapped.digest }]), target_json: JSON.stringify([{ outputRelativePath, replacement: null }]), receipt_json: '{}', result_json: JSON.stringify({ continuationPlan: rewrittenPlan }), last_error: '', created_at: Date.now(), updated_at: Date.now() };
    });
    const result = restoreProjectStorage({ sourcePath: source.path, destinationPath, payload, ensureSchema, fault });
    const consumedPaths = [String(source.relativePath || '')].filter(Boolean);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = (sources || []).find(item => item.relativePath === `${source.relativePath}${suffix}`);
      if (sidecar) consumedPaths.push(String(sidecar.relativePath));
    }
    const exactScope = { roots: ['projects','workflow-content','workflow-return-reviews','output-ownership'].map(name => path.join(destinationDataPath, name, targetHash)), files: ['workflows','workflow-settings','identity-similarities','workflow-jobs','output-cleanup'].map(name => path.join(destinationDataPath, name, `${targetHash}.json`)) };
    consumedPaths.push(...publishWorkspacePrivateFiles({ sources: privatePlan.selected, destinationDataPath, payload, fault, exactScope }));
    const applied = [...new Set(consumedPaths)]; const warnings = privatePlan.warnings;
    const warningByPath = new Map(warnings.map(item => [String(item.path), item]));
    const pathDispositions = (sources || []).filter(item => !applied.includes(String(item.relativePath || ''))).map(item => {
      const pathValue = String(item.relativePath || ''); const warning = warningByPath.get(pathValue);
      return { path: pathValue, action: 'intentionally-skipped', reason: warning?.classification || 'other-project', ...(warning?.message ? { message: warning.message } : {}) };
    });
    const consumedPathMappings = privatePlan.selected.filter(item => item.originalRelativePath !== item.relativePath).map(item => ({ path: item.originalRelativePath, destinationRelativePath: item.relativePath }));
    return { ...result, consumedPaths: applied, consumedPathMappings, pathDispositions, warnings };
  } catch (error) { rollback.restore(); throw error; }
  finally { rollback.cleanup(); }
};

module.exports = { restoreProjectStorage, restoreWorkspaceStorage, restoreWorkspaceBundle, restoreProjectBundle, publishWorkspacePrivateFiles, projectPrivateSources, selectRestoreSource, replacePath, rewriteJson, loadRestoreSources, writeRestoreReceipt };
