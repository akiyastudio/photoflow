const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { AsyncLocalStorage } = require('async_hooks');
const { defaultComponentDataAdoptionPolicy, ownsLegacyComponentDomainDatabase, isOwnedLegacyComponentDomainDatabase, legacyComponentOwnerForDomainDatabase } = require('../compatibility/component-data-adoption-policy.cjs');
const {
  MANAGED_EXTERNAL_FOLDER_PREFIX,
  MANAGED_EXTERNAL_FILE_PREFIX,
  MANAGED_EXTERNAL_ID_MARKER,
} = require('./project-virtual-path-service.cjs');

const STORE_FORMAT_VERSION = 1;
const SNAPSHOT_FORMAT_VERSION = 1;
const STORE_DIRECTORY = '.photoflow-backup';
const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_RETENTION = Object.freeze({ daily: 7, weekly: 4, monthly: 12 });

const exists = filePath => fs.promises.access(filePath).then(() => true, () => false);
const normalizeKey = value => String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const snapshotId = () => new Date().toISOString().replace(/[:.]/g, '-');
const validObjectHash = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const insideTimeWindow = (start = '09:00', end = '18:00', date = new Date()) => {
  const minutes = value => { const [hour, minute] = String(value).split(':').map(Number); return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0; };
  const current = date.getHours() * 60 + date.getMinutes();
  const from = minutes(start);
  const to = minutes(end);
  return from === to || (from < to ? current >= from && current < to : current >= from || current < to);
};
const safeDestination = (root, relative) => {
  const segments = normalizeKey(relative).split('/').filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..')) throw new Error('备份清单包含无效路径');
  const destination = path.resolve(root, ...segments);
  if (!inside(root, destination) || destination === path.resolve(root)) throw new Error('备份清单包含越界路径');
  return destination;
};
const sha256File = async filePath => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};
const durableSync = async filePath => {
  const handle = await fs.promises.open(filePath, 'r');
  try { await handle.sync().catch(error => { if (!['EINVAL', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error; }); }
  finally { await handle.close(); }
};
const durableSyncDirectory = async directory => {
  try { await durableSync(directory); }
  catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error?.code)) throw error; }
};
const writeDurableJsonReplace = async (filePath, value) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  await durableSync(temporary);
  await fs.promises.rename(temporary, filePath).catch(async error => {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await fs.promises.rm(filePath, { force: true });
    await fs.promises.rename(temporary, filePath);
  });
  await durableSyncDirectory(path.dirname(filePath));
};
const captureSqlitePreimage = async (databasePath, preimageRoot, name) => {
  const files = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    const stat = await fs.promises.lstat(source).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) { if (!suffix) throw new Error(`SQLite preimage 源不存在：${databasePath}`); continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`SQLite preimage 源不是普通文件：${source}`);
    const destination = path.join(preimageRoot, `${name}${suffix}`);
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await durableSync(destination);
    const after = await fs.promises.lstat(source);
    const hash = await sha256File(destination);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await sha256File(source) !== hash) throw new Error(`SQLite preimage 源在捕获期间发生变化：${source}`);
    files.push({ suffix, path: destination, size: stat.size, hash });
  }
  await durableSyncDirectory(preimageRoot);
  return { databasePath: path.resolve(databasePath), files };
};
const restoreSqlitePreimage = async (preimage, authorizedRoot) => {
  if (!preimage || !inside(authorizedRoot, preimage.databasePath) || !Array.isArray(preimage.files)) throw new Error('SQLite preimage 日志无效');
  const bySuffix = new Map(preimage.files.map(item => [item.suffix, item]));
  if (!bySuffix.has('')) throw new Error('SQLite preimage 缺少主数据库');
  for (const suffix of ['', '-wal', '-shm']) {
    const destination = `${preimage.databasePath}${suffix}`;
    const item = bySuffix.get(suffix);
    if (!item) { await fs.promises.rm(destination, { force: true }); continue; }
    if (!inside(authorizedRoot, item.path) || !validObjectHash(item.hash)) throw new Error('SQLite preimage 文件路径或哈希无效');
    const stat = await fs.promises.lstat(item.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(item.size) || await sha256File(item.path) !== item.hash) throw new Error('SQLite preimage 文件缺失或损坏');
    const temporary = `${destination}.${crypto.randomUUID()}.preimage`;
    await fs.promises.copyFile(item.path, temporary, fs.constants.COPYFILE_EXCL);
    await durableSync(temporary);
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination);
  }
  await durableSyncDirectory(path.dirname(preimage.databasePath));
};
const inventoryUnsafe = message => Object.assign(new Error(message), { code: 'BACKUP_INVENTORY_UNSAFE' });
const assertNoReparseAncestorsBeforeCreate = async candidate => {
  let cursor = path.resolve(candidate);
  while (true) {
    const stat = await fs.promises.lstat(cursor).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat) {
      if (stat.isSymbolicLink()) { const error = new Error(`恢复目标祖先包含链接或重解析点：${cursor}`); error.code = 'COMPONENT_RESTORE_TARGET_UNSAFE'; throw error; }
      const real = await fs.promises.realpath(cursor).catch(error => ['EPERM', 'EACCES'].includes(error?.code) ? null : Promise.reject(error));
      if (!real) { const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; continue; }
      const normalize = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
      if (normalize(real) !== normalize(cursor)) { const error = new Error(`恢复目标祖先解析到其他位置：${cursor}`); error.code = 'COMPONENT_RESTORE_TARGET_UNSAFE'; throw error; }
    }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
};
const COMPONENT_SOURCE_MANIFEST_SCHEMA = 'component-backup-restore-sources-v1';
const COMPONENT_RECEIPT_SCHEMA = 'component-backup-restore-receipt-v1';
const componentSourceKey = (scope, relativePath) => `${scope}\0${normalizeKey(relativePath)}`;
const isComponentHostControlStoragePath = value => {
  const segments = normalizeKey(value).split('/');
  const first = segments[1] || '';
  return ['inputs', 'staging', '.component-restore-transactions'].includes(first)
    || first.startsWith('.photoflow-restore-') || first.startsWith('.component-restore-') || first.startsWith('.restore-staging-');
};
const writeHashedJson = async (filePath, value) => {
  const body = `${JSON.stringify(value)}\n`;
  await fs.promises.writeFile(filePath, body, { encoding: 'utf8', flag: 'wx' });
  return { path: filePath, sha256: crypto.createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body) };
};
const readHashedJson = async (root, filePath, expectedHash, label) => {
  const resolved = path.resolve(String(filePath || ''));
  if (!inside(root, resolved) || resolved === path.resolve(root)) throw new Error(`${label} 路径越界`);
  const rootStat = await fs.promises.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`${label} 根目录不允许链接路径`);
  const rootReal = await fs.promises.realpath(root);
  let cursor = resolved;
  while (inside(root, cursor) && cursor !== path.resolve(root)) {
    const linkStat = await fs.promises.lstat(cursor);
    if (linkStat.isSymbolicLink()) throw new Error(`${label} 不允许链接路径`);
    cursor = path.dirname(cursor);
  }
  const resolvedReal = await fs.promises.realpath(resolved);
  if (!inside(rootReal, resolvedReal)) throw new Error(`${label} 真实路径越界`);
  const stat = await fs.promises.lstat(resolved);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error(`${label} 大小无效`);
  if (await sha256File(resolved) !== expectedHash) throw new Error(`${label} 哈希校验失败`);
  return JSON.parse(await fs.promises.readFile(resolved, 'utf8'));
};

const createBackupService = context => {
  const {
    app,
    backgroundTasks,
    getConfigPath,
    getUserBirthdaysPath,
    getManagedExternalLinkRegistryPath,
    getManagedExternalLinks,
    getWorkspaceDatabasePath,
    getWorkspaceOperationsDatabasePath,
    getWorkspaceMediaDatabasePath,
    getWorkspaceVersioningDatabasePath,
    getWorkspaceDataRoot,
    getWorkspaceDataRootForKey,
    bindWorkspaceStorageKeyForRestore,
    workspaceSqliteCoordinator,
    credentialService,
    prepareDomainRecovery,
    readSavedConfig,
    configMutationService,
    runPythonJsonAction,
    componentDataAdoptionPolicy = defaultComponentDataAdoptionPolicy,
    shell,
    writeLog,
    componentServiceManager,
  } = context;
  if (!configMutationService?.read || !configMutationService?.mutate) throw new Error('Backup service requires the shared config mutation service');
  const recoveryDatabaseGetters = {
    core: getWorkspaceDatabasePath,
    operations: getWorkspaceOperationsDatabasePath,
    media: getWorkspaceMediaDatabasePath,
    versioning: getWorkspaceVersioningDatabasePath,
  };
  const recoveryDatabases = (workspaceRoot, domains) => domains.map(domain => {
    const databasePath = recoveryDatabaseGetters[domain]?.(workspaceRoot);
    if (!databasePath) throw new Error(`数据库恢复缺少 ${domain} 数据库路径`);
    return { path: databasePath, mode: 'exclusive' };
  });
  const recoveryLeaseContext = new AsyncLocalStorage();
  const runRecoveryPythonAction = async (scriptName, args, timeoutMs) => {
    const action = String(args?.[0] || '');
    const restoreTool = ['backup_db.py', 'domain_recovery.py'].includes(scriptName)
      && (action.startsWith('restore-') || action === 'reset');
    if (restoreTool) {
      const lease = recoveryLeaseContext.getStore();
      const destinationIndex = args.indexOf('--destination');
      const destination = destinationIndex >= 0 ? path.resolve(String(args[destinationIndex + 1] || '')) : '';
      if (!lease || !destination || !lease.databases.has(destination)) {
        throw new Error(`恢复工具禁止在目标 SQLite exclusive 租约外执行：${scriptName} ${action}`);
      }
      const remainingMs = Number.isFinite(lease.deadlineAt) ? Math.max(0, lease.deadlineAt - Date.now()) : timeoutMs;
      try {
        return await runPythonJsonAction(scriptName, args, Math.min(timeoutMs, remainingMs), undefined, lease.signal, lease.deadlineAt);
      } catch (error) {
        if (error?.code === 'PROCESS_TERMINATION_FAILED') {
          workspaceSqliteCoordinator.quarantine?.(
            [...lease.databases].map(databasePath => ({ path: databasePath, mode: 'exclusive' })),
            error,
          );
        }
        throw error;
      }
    }
    return runPythonJsonAction(scriptName, args, timeoutMs);
  };

  const withWorkspaceRecoveryLease = async ({ workspaceRoot, domains = [], signal, deadlineAt } = {}, worker) => {
    if (!workspaceSqliteCoordinator?.run) throw new Error('工作区数据库恢复缺少 SQLite 协调器');
    if (typeof prepareDomainRecovery !== 'function') throw new Error('工作区数据库恢复缺少 client 暂停器');
    if (typeof worker !== 'function') throw new TypeError('工作区数据库恢复 worker 必须是函数');
    const root = path.resolve(workspaceRoot);
    const requested = recoveryDatabases(root, domains);
    if (!requested.length) throw new Error('工作区数据库恢复至少需要一个目标数据库');
    return workspaceSqliteCoordinator.run({
      databases: requested,
      signal,
      deadlineAt,
      label: `workspace-recovery:${root}:${domains.join(',')}`,
    }, async () => {
      const resume = await prepareDomainRecovery({ workspaceRoot: root, databases: requested, domains: [...domains] });
      if (typeof resume !== 'function') throw new Error('client 暂停器未返回恢复函数');
      try {
        return await recoveryLeaseContext.run({
          workspaceRoot: root,
          databases: new Set(requested.map(database => path.resolve(database.path))),
          signal,
          deadlineAt,
        }, worker);
      } finally {
        // Resume while the physical exclusive lease is still held. The
        // coordinator releases it only after this worker (including cleanup)
        // has completely settled.
        await resume();
      }
    });
  };
  const connectionStates = new Map();
  const approvedTargets = new Set();
  const approveTarget = value => {
    if (!value) return '';
    const resolved = path.resolve(value);
    approvedTargets.add(process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved);
    return resolved;
  };
  const isApprovedTarget = value => {
    if (!value) return false;
    const resolved = path.resolve(value);
    return approvedTargets.has(process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved);
  };
  approveTarget(readSavedConfig()?.backup?.targetPath);

  const isNasTarget = target => Boolean(credentialService?.isUncPath?.(target));
  const ensureTargetConnection = async (target, backupConfig = readSavedConfig()?.backup || {}) => {
    if (!isNasTarget(target)) return;
    const credentialRef = backupConfig.nas?.credentialRef || '';
    if (credentialRef) await credentialService.connectNas(target, credentialRef);
  };
  const diskCapacity = async target => {
    if (typeof fs.promises.statfs !== 'function') return {};
    const stat = await fs.promises.statfs(target).catch(() => null);
    return stat ? { totalBytes: Number(stat.blocks) * Number(stat.bsize), freeBytes: Number(stat.bavail) * Number(stat.bsize) } : {};
  };
  const testConnection = async () => {
    const backupConfig = readSavedConfig()?.backup || {};
    const target = String(backupConfig.targetPath || '').trim();
    if (!target || !isApprovedTarget(target)) throw new Error('请先选择备份位置');
    const startedAt = Date.now();
    try {
      await ensureTargetConnection(target, backupConfig);
      await fs.promises.mkdir(target, { recursive: true });
      const probe = path.join(target, `.photoflow-connection-${crypto.randomUUID()}.tmp`);
      const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a);
      const writeStartedAt = Date.now();
      await fs.promises.writeFile(probe, payload, { flag: 'wx' });
      const elapsedMs = Math.max(1, Date.now() - writeStartedAt);
      await fs.promises.rm(probe, { force: true });
      const capacity = await diskCapacity(target);
      const state = { connected: true, isNas: isNasTarget(target), checkedAt: Date.now(), latencyMs: Date.now() - startedAt, speedMBps: Number((payload.length / 1024 / 1024 / (elapsedMs / 1000)).toFixed(1)), ...capacity };
      connectionStates.set(path.resolve(target).toLocaleLowerCase(), state);
      return state;
    } catch (error) {
      const state = { connected: false, isNas: isNasTarget(target), checkedAt: Date.now(), error: error.message || String(error) };
      connectionStates.set(path.resolve(target).toLocaleLowerCase(), state);
      throw error;
    }
  };

  const storeRoot = target => path.join(path.resolve(target), STORE_DIRECTORY);
  const objectsRoot = target => path.join(storeRoot(target), 'objects');
  const snapshotsRoot = target => path.join(storeRoot(target), 'snapshots');
  const temporaryRoot = target => path.join(storeRoot(target), 'temporary');
  const objectPath = (target, hash) => path.join(objectsRoot(target), hash.slice(0, 2), hash.slice(2));
  const markerPath = workspaceRoot => path.join(workspaceRoot, '.photoflow-workspace-id');
  const readWorkspaceId = async workspaceRoot => (await fs.promises.readFile(markerPath(workspaceRoot), 'utf8')).trim();
  const ensureStore = async target => {
    const descriptor = path.join(storeRoot(target), 'store.json');
    if (await exists(storeRoot(target)) && !await exists(descriptor)) {
      const entries = await fs.promises.readdir(storeRoot(target));
      if (entries.length) throw inventoryUnsafe('备份存储缺少版本描述文件，拒绝初始化或修改');
    }
    if (await exists(descriptor)) {
      let stored;
      try { stored = JSON.parse(await fs.promises.readFile(descriptor, 'utf8')); }
      catch { throw inventoryUnsafe('备份存储描述文件不可读或已损坏'); }
      if (stored?.formatVersion !== STORE_FORMAT_VERSION) throw inventoryUnsafe(`不支持的备份存储版本：${stored?.formatVersion ?? 'unknown'}`);
    }
    await fs.promises.mkdir(objectsRoot(target), { recursive: true });
    await fs.promises.mkdir(snapshotsRoot(target), { recursive: true });
    await fs.promises.mkdir(temporaryRoot(target), { recursive: true });
    if (!await exists(descriptor)) {
      const temporary = `${descriptor}.${crypto.randomUUID()}.tmp`;
      await fs.promises.writeFile(temporary, JSON.stringify({ formatVersion: STORE_FORMAT_VERSION, createdAt: Date.now(), product: 'PhotoFlow' }, null, 2), 'utf8');
      await fs.promises.rename(temporary, descriptor);
      await durableSync(descriptor);
      await durableSyncDirectory(storeRoot(target));
    }
  };

  const assertStoreSupported = async target => {
    const descriptor = path.join(storeRoot(target), 'store.json');
    let stored;
    try { stored = JSON.parse(await fs.promises.readFile(descriptor, 'utf8')); }
    catch { throw inventoryUnsafe('备份存储描述文件不可读或已损坏'); }
    if (stored?.formatVersion !== STORE_FORMAT_VERSION) throw inventoryUnsafe(`不支持的备份存储版本：${stored?.formatVersion ?? 'unknown'}`);
  };
  const assertStoreLayoutPhysical = async target => {
    await assertNoReparseAncestorsBeforeCreate(target);
    const targetReal = await fs.promises.realpath(target);
    for (const candidate of [storeRoot(target), snapshotsRoot(target), objectsRoot(target)]) {
      const stat = await fs.promises.lstat(candidate).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw inventoryUnsafe(`备份存储目录不是安全的物理目录：${candidate}`);
      if (!inside(targetReal, await fs.promises.realpath(candidate))) throw inventoryUnsafe(`备份存储目录真实路径越界：${candidate}`);
    }
  };

  const collectFiles = async (root, scope, shouldSkip) => {
    const output = [];
    if (!await exists(root)) return output;
    const pending = [{ absolute: path.resolve(root), relative: '' }];
    while (pending.length) {
      const directory = pending.pop();
      const entries = await fs.promises.readdir(directory.absolute, { withFileTypes: true });
      for (const item of entries) {
        const relative = normalizeKey(path.join(directory.relative, item.name));
        if (shouldSkip?.(relative, item)) continue;
        const absolute = path.join(directory.absolute, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) pending.push({ absolute, relative });
        else if (item.isFile()) output.push({ scope, relative, absolute });
      }
    }
    return output;
  };

  const snapshotComponentStorage = async (workspaceDataRoot, stage) => {
    const sourceRoot = path.join(workspaceDataRoot, 'components');
    if (!await exists(sourceRoot)) return { files: [], componentBackups: [] };
    if (!componentServiceManager?.quiesceForStorageSnapshot) throw new Error('组件数据包快照缺少通用 service quiesce 边界');
    const resume = await componentServiceManager.quiesceForStorageSnapshot();
    const snapshotRoot = path.join(stage, 'component-storage');
    try {
      const snapshotDescriptors = componentServiceManager.backupSnapshotDescriptors?.() || componentRestoreDescriptors();
      const frozenDescriptors = snapshotDescriptors.map(descriptor => ({ descriptor, token: componentRestoreDescriptorToken(descriptor) }));
      const liveFiles = await collectFiles(sourceRoot, 'component-storage', (relative, item) => {
        if (item.isSymbolicLink()) throw new Error('组件数据包包含不允许的符号链接');
        const segments = normalizeKey(relative).split('/');
        const privateRelative = segments.slice(1).join('/');
        // These paths are Host/service transport state, never component-owned
        // durable data. Including them can recursively back up restore inputs,
        // journals, or an interrupted transaction.
        return Boolean(privateRelative) && isComponentHostControlStoragePath(relative);
      });
      for (const file of liveFiles) {
        const destination = safeDestination(snapshotRoot, file.relative);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        const before = await fs.promises.stat(file.absolute);
        await fs.promises.copyFile(file.absolute, destination, fs.constants.COPYFILE_EXCL);
        const after = await fs.promises.stat(file.absolute);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
          || await sha256File(file.absolute) !== await sha256File(destination)) throw new Error('组件数据包在 quiesce 快照期间发生变化');
      }
      const files = await collectFiles(snapshotRoot, 'component-storage');
      const currentDescriptors = componentServiceManager.backupSnapshotDescriptors?.() || componentRestoreDescriptors();
      if (currentDescriptors.length !== frozenDescriptors.length) throw new Error('组件清单在数据包快照期间发生变化');
      for (const frozen of frozenDescriptors) {
        const current = currentDescriptors.find(item => item.componentId === frozen.descriptor.componentId);
        if (!current || componentRestoreDescriptorToken(current) !== frozen.token) throw new Error(`组件 ${frozen.descriptor.componentId} 在数据包快照期间发生升级`);
      }
      const frozenById = new Map(frozenDescriptors.map(item => [item.descriptor.componentId, item.descriptor]));
      const storageComponentIds = [...new Set(files.map(file => componentIdFromStoragePath(file.relative)).filter(Boolean))].sort();
      const componentBackups = storageComponentIds.map(componentId => {
        const descriptor = frozenById.get(componentId);
        return {
        componentId,
        componentVersion: String(descriptor?.componentVersion || 'unversioned'),
        sources: (descriptor?.service?.backupRestore?.sources || []).filter(source => files.some(entry => entry.scope === source.scope && entry.relative === source.path))
          .map(source => ({ scope: source.scope, path: normalizeKey(source.path), format: source.format })),
      };
      });
      return { files, componentBackups };
    } finally {
      await resume();
    }
  };

  const componentRestoreDescriptors = () => componentServiceManager?.backupRestoreDescriptors?.() || [];
  const componentIdFromStoragePath = value => normalizeKey(value).split('/')[0] || '';
  const snapshotComponentRecord = (manifest, componentId) => Array.isArray(manifest.componentBackups)
    ? manifest.componentBackups.find(item => item?.componentId === componentId)
    : null;
  const matchingComponentSources = (manifest, descriptor) => {
    const snapshotRecord = snapshotComponentRecord(manifest, descriptor.componentId);
    const inferredOpaqueSources = snapshotRecord?.sources?.length === 0
      ? (descriptor.service.backupRestore.sources || []).filter(source => source.scope === 'component-storage'
        && componentIdFromStoragePath(source.path) === descriptor.componentId
        && manifest.files.some(item => item.scope === source.scope && item.path === source.path))
        .map(source => ({ ...source, format: 'unversioned', metadataOrigin: 'inferred' }))
      : [];
    const declarations = snapshotRecord
      ? (snapshotRecord.sources.length ? snapshotRecord.sources.map(source => ({ ...source, metadataOrigin: 'snapshot' })) : inferredOpaqueSources)
      : (descriptor.service.backupRestore.sources || []).map(source => ({ ...source, format: 'unversioned', metadataOrigin: 'legacy-manifest' }));
    return (declarations || []).flatMap(source => {
      const entry = manifest.files.find(item => item.scope === source.scope && item.path === source.path);
      return entry ? [{ declaration: source, entry, sourceVersion: snapshotRecord?.componentVersion || 'unversioned', metadataOrigin: source.metadataOrigin }] : [];
    });
  };
  const validateComponentBackupMetadata = (manifest, descriptors = [], { restoreCompatibility = false } = {}) => {
    const metadataInvalid = message => { const error = new Error(message); error.code = 'COMPONENT_BACKUP_METADATA_INVALID'; return error; };
    const reservedDomainDatabases = new Set(['core.sqlite3', 'operations.sqlite3', 'media.sqlite3', 'versioning.sqlite3']);
    const invalidLegacyDomain = manifest.files.find(item => item.scope === 'domain-database'
      && !reservedDomainDatabases.has(item.path) && !isOwnedLegacyComponentDomainDatabase(item.path, componentDataAdoptionPolicy));
    if (invalidLegacyDomain) {
      const error = new Error(`备份包含未授权的历史域数据库：${invalidLegacyDomain.path}`);
      error.code = 'COMPONENT_LEGACY_RESTORE_OWNER_MISSING'; error.sourcePath = invalidLegacyDomain.path; throw error;
    }
    if (manifest.componentBackups == null) return;
    if (!Array.isArray(manifest.componentBackups)) throw metadataInvalid('备份组件元数据无效');
    const owners = new Map();
    const componentRecords = new Set();
    for (const record of manifest.componentBackups) {
      if (!record || typeof record.componentId !== 'string' || !record.componentId || typeof record.componentVersion !== 'string'
        || !Array.isArray(record.sources)) throw metadataInvalid('备份组件元数据无效');
      if (componentRecords.has(record.componentId)) throw metadataInvalid(`备份组件元数据重复：${record.componentId}`);
      componentRecords.add(record.componentId);
      for (const source of record.sources) {
        if (!source || !['component-storage', 'domain-database'].includes(source.scope)
          || typeof source.path !== 'string' || !source.path || typeof source.format !== 'string' || !source.format) throw metadataInvalid('备份组件源元数据无效');
        if (source.scope === 'domain-database' && (reservedDomainDatabases.has(source.path)
          || !ownsLegacyComponentDomainDatabase(record.componentId, source.path, componentDataAdoptionPolicy))) {
          const error = new Error(`备份组件不得认领宿主数据库：${source.path}`);
          error.code = 'COMPONENT_RESTORE_SOURCE_UNAUTHORIZED'; error.componentId = record.componentId; error.sourcePath = source.path; throw error;
        }
        if (source.scope === 'component-storage' && componentIdFromStoragePath(source.path) !== record.componentId) {
          const error = new Error(`备份组件元数据归属无效：${source.path}`);
          error.code = 'COMPONENT_RESTORE_SOURCE_UNAUTHORIZED'; error.componentId = record.componentId; error.sourcePath = source.path; throw error;
        }
        const installed = descriptors.find(item => item.componentId === record.componentId);
        if (restoreCompatibility && installed) {
          const authorized = installed.service?.backupRestore?.sources?.some(item => item.scope === source.scope && item.path === source.path);
          if (!authorized) { const error = new Error(`备份组件源不在当前组件授权清单：${source.path}`); error.code = 'COMPONENT_RESTORE_SOURCE_MISSING'; error.componentId = record.componentId; error.sourcePath = source.path; throw error; }
        }
        const key = componentSourceKey(source.scope, source.path);
        if (owners.has(key)) throw metadataInvalid(`备份组件源被重复认领：${source.path}`);
        owners.set(key, record.componentId);
        const entry = manifest.files.find(item => item.scope === source.scope && item.path === source.path);
        if (!entry) { const error = new Error(`备份组件元数据对应对象缺失：${source.path}`); error.code = 'COMPONENT_RESTORE_SOURCE_MISSING'; throw error; }
      }
    }
    const storedComponentIds = new Set(manifest.files.filter(item => item.scope === 'component-storage' && !isComponentHostControlStoragePath(item.path))
      .map(item => componentIdFromStoragePath(item.path)).filter(Boolean));
    if (storedComponentIds.size !== componentRecords.size || [...storedComponentIds].some(componentId => !componentRecords.has(componentId))) throw metadataInvalid('备份组件元数据未完整覆盖组件存储');
  };
  const componentRestoreOperationId = (...parts) => crypto.createHash('sha256').update(parts.map(String).join('\0')).digest('hex');
  const componentRestoreDescriptorToken = descriptor => crypto.createHash('sha256').update(JSON.stringify({
    componentId: descriptor.componentId, componentVersion: descriptor.componentVersion,
    backupRestore: descriptor.service?.backupRestore || null, rpcMethods: descriptor.service?.rpcMethods || [],
  })).digest('hex');
  const preflightComponentRestore = (manifest, mode) => {
    if (!componentServiceManager?.invokeBackupRestore) throw new Error('组件数据恢复缺少通用 component-owned restore hook');
    const descriptors = componentRestoreDescriptors();
    validateComponentBackupMetadata(manifest, descriptors, { restoreCompatibility: true });
    const reservedDomainDatabases = new Set(['core.sqlite3', 'operations.sqlite3', 'media.sqlite3', 'versioning.sqlite3']);
    const declaredLegacySources = new Set(descriptors.flatMap(descriptor => descriptor.service.backupRestore.sources || [])
      .filter(source => source.scope === 'domain-database').map(source => source.path));
    const redundantLegacySources = new Map();
    const hasCompleteCurrentSnapshot = componentId => {
      const record = snapshotComponentRecord(manifest, componentId);
      const currentFiles = manifest.files.filter(item => item.scope === 'component-storage' && !isComponentHostControlStoragePath(item.path)
        && componentIdFromStoragePath(item.path) === componentId);
      if (!currentFiles.length) return false;
      if (!record) return manifest.componentBackups == null && currentFiles.some(item => item.path === `${componentId}/storage.sqlite3`);
      const declaredCurrent = (record.sources || []).filter(source => source.scope === 'component-storage');
      return declaredCurrent.length
        ? declaredCurrent.some(source => currentFiles.some(item => item.path === source.path))
        : currentFiles.some(item => item.path === `${componentId}/storage.sqlite3`);
    };
    const orphanedLegacyEntry = manifest.files.find(item => item.scope === 'domain-database'
      && !reservedDomainDatabases.has(item.path) && !declaredLegacySources.has(item.path)
      && (() => {
        const owner = legacyComponentOwnerForDomainDatabase(item.path, componentDataAdoptionPolicy);
        if (owner && hasCompleteCurrentSnapshot(owner)) {
          if (mode === 'workspace') { const paths = redundantLegacySources.get(owner) || []; paths.push(item.path); redundantLegacySources.set(owner, paths); }
          return false;
        }
        return true;
      })());
    if (orphanedLegacyEntry) {
      const error = new Error(`备份包含未安装或未注册组件的历史数据源：${orphanedLegacyEntry.path}`);
      error.code = 'COMPONENT_LEGACY_RESTORE_OWNER_MISSING'; error.sourcePath = orphanedLegacyEntry.path; throw error;
    }
    const componentIds = new Set(manifest.files.filter(item => item.scope === 'component-storage' && !isComponentHostControlStoragePath(item.path)).map(item => componentIdFromStoragePath(item.path)).filter(Boolean));
    if (mode === 'project') {
      for (const componentId of componentIds) {
        const descriptor = descriptors.find(item => item.componentId === componentId);
        if (!descriptor?.service?.backupRestore?.project) {
          const error = new Error(`组件 ${componentId} 的备份包含私有数据，但该组件未声明项目级恢复支持`);
          error.code = 'COMPONENT_PROJECT_RESTORE_UNSUPPORTED'; error.componentId = componentId; throw error;
        }
        const ownsDeclaredSource = matchingComponentSources(manifest, descriptor).some(source => source.entry.scope === 'component-storage'
          && componentIdFromStoragePath(source.entry.path) === componentId);
        if (!ownsDeclaredSource) {
          const error = new Error(`组件 ${componentId} 的备份包含私有数据，但缺少该组件声明的主恢复源`);
          error.code = 'COMPONENT_RESTORE_SOURCE_MISSING'; error.componentId = componentId; throw error;
        }
      }
    } else {
      for (const componentId of componentIds) {
        const descriptor = descriptors.find(item => item.componentId === componentId);
        if (!descriptor?.service?.backupRestore?.workspace) continue;
        const ownsDeclaredSource = matchingComponentSources(manifest, descriptor).some(source => source.entry.scope === 'component-storage'
          && componentIdFromStoragePath(source.entry.path) === componentId);
        if (!ownsDeclaredSource) {
          const error = new Error(`组件 ${componentId} 的备份包含私有数据，但缺少该组件声明的主恢复源`);
          error.code = 'COMPONENT_RESTORE_SOURCE_MISSING'; error.componentId = componentId; throw error;
        }
      }
    }
    for (const descriptor of descriptors) {
      if (descriptor.service.backupRestore.transactionProtocolVersion !== 1
        || descriptor.service.backupRestore.sourceManifestProtocolVersion !== 1
        || descriptor.service.backupRestore.receiptProtocolVersion !== 1) {
        const error = new Error(`组件 ${descriptor.componentId} 的备份恢复协议版本不受支持`);
        error.code = 'COMPONENT_RESTORE_PROTOCOL_UNSUPPORTED'; throw error;
      }
      const matched = matchingComponentSources(manifest, descriptor);
      const hasCurrentMatched = matched.some(source => source.entry.scope === 'component-storage');
      const hasSelectedLegacy = !hasCurrentMatched && matched.some(source => source.entry.scope === 'domain-database');
      const mayOpaquePreserveWorkspace = mode === 'workspace' && hasCurrentMatched && !hasSelectedLegacy;
      if (matched.length && !descriptor.service.backupRestore[mode] && !mayOpaquePreserveWorkspace) {
        const error = new Error(`组件 ${descriptor.componentId} 的备份包含私有数据，但未声明${mode === 'project' ? '项目级' : '工作区级'}恢复支持`);
        error.code = mode === 'project' ? 'COMPONENT_PROJECT_RESTORE_UNSUPPORTED' : 'COMPONENT_WORKSPACE_RESTORE_UNSUPPORTED';
        error.componentId = descriptor.componentId; throw error;
      }
      for (const hook of [descriptor.service.backupRestore.workspace, descriptor.service.backupRestore.project].filter(Boolean)) {
        if (componentServiceManager.supports?.(descriptor.componentId, hook.method)) {
          const error = new Error(`组件 ${descriptor.componentId} 的恢复 hook 被错误暴露为普通 RPC`);
          error.code = 'COMPONENT_RESTORE_HOOK_PUBLIC'; error.componentId = descriptor.componentId; throw error;
        }
      }
    }
    const actionable = descriptors.filter(descriptor => matchingComponentSources(manifest, descriptor).length && descriptor.service.backupRestore[mode]);
    const opaquePreserved = mode === 'workspace' ? [...new Set([...componentIds]
      .filter(componentId => !descriptors.some(descriptor => descriptor.componentId === componentId))
      .concat(descriptors.filter(descriptor => {
      const matched = matchingComponentSources(manifest, descriptor); return matched.some(source => source.entry.scope === 'component-storage')
        && !descriptor.service.backupRestore.workspace;
      }).map(descriptor => descriptor.componentId)))] : [];
    return Object.freeze({ mode, opaquePreserved: Object.freeze(opaquePreserved), redundantLegacySources: Object.freeze([...redundantLegacySources].map(([componentId, paths]) => Object.freeze({ componentId, paths: Object.freeze(paths.sort()) }))), descriptors: Object.freeze(actionable.map(descriptor => Object.freeze({ descriptor, token: componentRestoreDescriptorToken(descriptor) }))) });
  };
  const verifyComponentRestoreSources = async (target, manifest, plan, task) => {
    const required = [manifest.database, ...manifest.files].sort((left, right) => `${left.scope || ''}\0${left.path || ''}`.localeCompare(`${right.scope || ''}\0${right.path || ''}`));
    const nextDigest = (previous, entry, stat) => crypto.createHash('sha256').update([previous, entry.hash, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino || 0].join('\0')).digest('hex');
    let identityDigest = '0'.repeat(64);
    for (const [index, entry] of required.entries()) {
      task?.throwIfCancelled?.();
      const source = objectPath(target, entry.hash);
      const stat = await fs.promises.lstat(source).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || (entry.size != null && stat.size !== Number(entry.size))) {
        const error = new Error(`备份对象缺失或大小不符：${entry.path || 'workspace.sqlite3'}`);
        error.code = 'BACKUP_OBJECT_PREFLIGHT_FAILED'; error.sourcePath = entry.path || 'workspace.sqlite3'; error.componentId = entry.scope === 'component-storage' ? componentIdFromStoragePath(entry.path) : undefined; throw error;
      }
      if (await sha256File(source) !== entry.hash) {
        const error = new Error(`备份对象预检哈希失败：${entry.path || 'workspace.sqlite3'}`);
        error.code = 'BACKUP_OBJECT_PREFLIGHT_FAILED'; error.sourcePath = entry.path || 'workspace.sqlite3'; error.componentId = entry.scope === 'component-storage' ? componentIdFromStoragePath(entry.path) : undefined; throw error;
      }
      identityDigest = nextDigest(identityDigest, entry, stat);
      task?.report?.((index + 1) / Math.max(1, required.length) * 2, `正在预检恢复对象 ${index + 1}/${required.length}`);
      if ((index + 1) % 64 === 0 || index + 1 === required.length) task?.saveCheckpoint?.({ ...task.getCheckpoint(), phase: 'verifying', verification: { verifiedIndex: index + 1, identityDigest } }, (index + 1) / Math.max(1, required.length) * 2, `已验证恢复对象 ${index + 1}/${required.length}`);
    }
    if (componentServiceManager?.prepareBackupRestore) {
      await componentServiceManager.prepareBackupRestore(plan.descriptors.map(item => item.descriptor.componentId));
    }
    return true;
  };
  const restoreOwnedComponentDataUnderLease = async ({ target, manifest, mode, task, sourceWorkspace, targetWorkspace, project, plan, invokeBackupRestore, beforeTargetWrite, continuation }) => {
    if (!plan || plan.mode !== mode) throw new Error('组件恢复缺少已验证的 preflight plan');
    const currentDescriptors = componentRestoreDescriptors();
    for (const item of plan.descriptors) {
      const current = currentDescriptors.find(descriptor => descriptor.componentId === item.descriptor.componentId);
      if (!current || componentRestoreDescriptorToken(current) !== item.token) {
        const error = new Error(`组件 ${item.descriptor.componentId} 在恢复 preflight 后发生变化`);
        error.code = 'COMPONENT_RESTORE_PLAN_CHANGED'; throw error;
      }
    }
    const descriptors = plan.descriptors.map(item => item.descriptor);
    const authorizedDataRoot = path.resolve(targetWorkspace.dataRoot);
    await assertNoReparseAncestorsBeforeCreate(targetWorkspace.root);
    await assertNoReparseAncestorsBeforeCreate(authorizedDataRoot);
    const existingDataRootReal = await fs.promises.realpath(authorizedDataRoot).catch(() => null);
    const targetComponentIds = [...new Set([...descriptors.map(descriptor => descriptor.componentId), ...(plan.opaquePreserved || [])])];
    for (const candidate of [authorizedDataRoot, path.join(authorizedDataRoot, 'components'), ...targetComponentIds.map(componentId => path.join(authorizedDataRoot, 'components', componentId))]) {
      const stat = await fs.promises.lstat(candidate).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat?.isSymbolicLink()) { const error = new Error('组件恢复目标包含符号链接或重解析边界'); error.code = 'COMPONENT_RESTORE_TARGET_UNSAFE'; throw error; }
      if (stat && existingDataRootReal && !inside(existingDataRootReal, await fs.promises.realpath(candidate))) { const error = new Error('组件恢复目标越过授权数据根目录'); error.code = 'COMPONENT_RESTORE_TARGET_UNSAFE'; throw error; }
    }
    const operationIds = new Map(descriptors.map(descriptor => [descriptor.componentId,
      componentRestoreOperationId(task.id, manifest.id || manifest.createdAt, mode, descriptor.componentId, project?.id || targetWorkspace.root)]));
    const prepared = [];
    const phaseContext = { projectId: project?.id, projectName: project?.targetName, projectStatus: project?.targetStatus, workspacePath: targetWorkspace.root };
    const releasePrepared = async phase => {
      const failures = [];
      const released = new Set();
      for (const item of [...prepared].reverse()) {
        try {
          const result = await invokeBackupRestore(item.descriptor.componentId, mode, {
            schemaVersion: 1, phase, operationId: item.operationId, mode, quiesceToken: item.quiesceToken,
            sourceWorkspace, targetWorkspace, ...(project ? { project } : {}),
          }, phaseContext);
          if (!result || result.operationId !== item.operationId) throw new Error(`组件 ${item.descriptor.componentId} 返回了无效的 ${phase} 回执`);
          released.add(item);
        } catch (error) { failures.push(error); }
      }
      for (let index = prepared.length - 1; index >= 0; index -= 1) if (released.has(prepared[index])) prepared.splice(index, 1);
      if (failures.length) throw new AggregateError(failures, `组件恢复 ${phase} 阶段失败`);
    };
    const settlePrepared = async phase => {
      let lastError = null;
      for (let attempt = 0; attempt < 2 && prepared.length; attempt += 1) try { await releasePrepared(phase); } catch (error) { lastError = error; }
      if (!prepared.length) return { pending: false, error: lastError };
      const stopFailures = [];
      for (const item of [...prepared]) {
        try { await componentServiceManager.stop(item.descriptor.componentId, `component-restore-${phase}-failed`); prepared.splice(prepared.indexOf(item), 1); }
        catch (error) { componentServiceManager.quarantine?.(item.descriptor.componentId, `component-restore-${phase}-pending`); stopFailures.push(error); }
      }
      return { pending: prepared.length > 0, error: stopFailures.length ? new AggregateError(stopFailures, `组件恢复 ${phase} token 无法释放`) : lastError };
    };
    try {
      for (const descriptor of descriptors) {
        const operationId = operationIds.get(descriptor.componentId);
        const result = await invokeBackupRestore(descriptor.componentId, mode, {
          schemaVersion: 1, phase: 'prepare', operationId, mode, sourceWorkspace, targetWorkspace,
          sourceVersion: snapshotComponentRecord(manifest, descriptor.componentId)?.componentVersion || 'unversioned',
          targetVersion: String(descriptor.componentVersion || 'unversioned'), ...(project ? { project } : {}),
        }, phaseContext);
        if (!result || result.operationId !== operationId || result.status !== 'prepared' || typeof result.quiesceToken !== 'string' || !result.quiesceToken) throw new Error(`组件 ${descriptor.componentId} 返回了无效的 prepare 回执`);
        prepared.push({ descriptor, operationId, quiesceToken: result.quiesceToken });
      }
    } catch (error) {
      const release = await settlePrepared('finalize');
      if (release.pending) throw new AggregateError([error, release.error], '组件恢复 prepare 失败且已准备组件已隔离');
      throw error;
    }
    let transactionCommitted = false;
    let activeTransactionRoot = null;
    try {
    await beforeTargetWrite?.();
    const transactionsRoot = path.join(targetWorkspace.dataRoot, '.component-restore-transactions');
    for (const candidate of [targetWorkspace.dataRoot, path.join(targetWorkspace.dataRoot, 'components'), transactionsRoot]) {
      const stat = await fs.promises.lstat(candidate).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat?.isSymbolicLink()) { const error = new Error('组件恢复目标包含符号链接或重解析边界'); error.code = 'COMPONENT_RESTORE_TARGET_UNSAFE'; throw error; }
    }
    const rejectSymlinks = async root => {
      if (!await exists(root)) return;
      const pending = [root];
      while (pending.length) {
        const currentDirectory = pending.pop();
        for (const entry of await fs.promises.readdir(currentDirectory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) { const error = new Error('组件恢复事务不允许符号链接'); error.code = 'COMPONENT_RESTORE_SYMLINK_UNSAFE'; throw error; }
          if (entry.isDirectory()) pending.push(path.join(currentDirectory, entry.name));
        }
      }
    };
    const writeDurableJson = async (filePath, value) => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const next = `${filePath}.${crypto.randomUUID()}.next`;
      await fs.promises.writeFile(next, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
      const handle = await fs.promises.open(next, 'r+');
      try { await handle.sync().catch(error => { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error; }); }
      finally { await handle.close(); }
      await fs.promises.rename(next, filePath);
      const directory = await fs.promises.open(path.dirname(filePath), 'r').catch(() => null);
      try { await directory?.sync().catch(error => { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error; }); }
      finally { await directory?.close(); }
    };
    const writeTransactionJournal = (transactionRoot, value) => writeDurableJson(path.join(transactionRoot, `journal.${value.state}.json`), value);
    const rollbackTransaction = async (transactionRoot, { preserve = false } = {}) => {
      let journal = null;
      for (const state of ['committed', 'applying', 'planned']) {
        journal = await fs.promises.readFile(path.join(transactionRoot, `journal.${state}.json`), 'utf8').then(JSON.parse, () => null);
        if (journal) break;
      }
      if (!journal?.components || journal.state === 'planned' || journal.state === 'committed') { await fs.promises.rm(transactionRoot, { recursive: true, force: true }); return; }
      for (const item of journal.components) {
        const backupRoot = safeDestination(path.join(transactionRoot, 'backups'), item.componentId);
        const liveRoot = safeDestination(path.join(targetWorkspace.dataRoot, 'components'), item.componentId);
        const liveStat = await fs.promises.lstat(liveRoot).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (liveStat?.isSymbolicLink()) { const error = new Error(`组件 ${item.componentId} 的恢复目标变成了链接`); error.code = 'COMPONENT_RESTORE_TARGET_UNSAFE'; throw error; }
        if (item.existed && !await exists(backupRoot)) {
          const error = new Error(`组件 ${item.componentId} 的恢复事务备份缺失，拒绝删除当前数据`);
          error.code = 'COMPONENT_RESTORE_ROLLBACK_BACKUP_MISSING'; throw error;
        }
        if (item.existed) {
          await rejectSymlinks(backupRoot);
          const files = await collectFiles(backupRoot, 'rollback');
          const byRelative = new Map(files.map(file => [file.relative, file.absolute]));
          if (!Array.isArray(item.backupFiles) || byRelative.size !== item.backupFiles.length) { const error = new Error(`组件 ${item.componentId} 的恢复事务备份清单不完整`); error.code = 'COMPONENT_RESTORE_ROLLBACK_BACKUP_INVALID'; throw error; }
          for (const expected of item.backupFiles) if (!byRelative.has(expected.relative) || (await fs.promises.stat(byRelative.get(expected.relative))).size !== expected.size
            || await sha256File(byRelative.get(expected.relative)) !== expected.sha256) { const error = new Error(`组件 ${item.componentId} 的恢复事务备份已损坏`); error.code = 'COMPONENT_RESTORE_ROLLBACK_BACKUP_INVALID'; throw error; }
        }
      }
      for (const item of [...journal.components].reverse()) {
        const targetRoot = safeDestination(path.join(targetWorkspace.dataRoot, 'components'), item.componentId);
        const backupRoot = safeDestination(path.join(transactionRoot, 'backups'), item.componentId);
        const donePath = safeDestination(path.join(transactionRoot, 'rollback-progress'), `${item.componentId}.done.json`);
        const targetMatchesBackup = async () => {
          const files = await collectFiles(targetRoot, 'rollback'); const byRelative = new Map(files.map(file => [file.relative, file.absolute]));
          if (byRelative.size !== item.backupFiles.length) return false;
          for (const expected of item.backupFiles) if (!byRelative.has(expected.relative) || (await fs.promises.stat(byRelative.get(expected.relative))).size !== expected.size
            || await sha256File(byRelative.get(expected.relative)) !== expected.sha256) return false;
          return true;
        };
        if (await exists(donePath)) {
          const progress = await fs.promises.readFile(donePath, 'utf8').then(JSON.parse, () => null);
          if (!progress || progress.componentId !== item.componentId || !['absent', 'backup'].includes(progress.restored)) { const error = new Error(`组件 ${item.componentId} 的恢复事务进度文件无效`); error.code = 'COMPONENT_RESTORE_ROLLBACK_PROGRESS_INVALID'; throw error; }
          const replayValid = item.existed ? await exists(targetRoot) && await targetMatchesBackup() : !await exists(targetRoot);
          if (replayValid) continue;
          await fs.promises.rm(donePath, { force: true });
        }
        if (!item.existed) {
          if (await exists(targetRoot)) await fs.promises.rm(targetRoot, { recursive: true, force: true });
          await writeDurableJson(donePath, { componentId: item.componentId, restored: 'absent' });
          continue;
        }
        const replacement = safeDestination(path.join(transactionRoot, 'rollback-replacements'), item.componentId);
        const displaced = safeDestination(path.join(transactionRoot, 'rollback-displaced'), item.componentId);
        if (await exists(displaced) && await exists(targetRoot) && !await exists(replacement) && await targetMatchesBackup()) {
          await writeDurableJson(donePath, { componentId: item.componentId, restored: 'backup' }); await fs.promises.rm(displaced, { recursive: true, force: true }); continue;
        }
        await fs.promises.rm(replacement, { recursive: true, force: true }); await fs.promises.mkdir(path.dirname(replacement), { recursive: true });
        await fs.promises.cp(backupRoot, replacement, { recursive: true, errorOnExist: true, force: false });
        const replacementFiles = await collectFiles(replacement, 'rollback');
        const replacementByRelative = new Map(replacementFiles.map(file => [file.relative, file.absolute]));
        if (replacementByRelative.size !== item.backupFiles.length) throw Object.assign(new Error(`组件 ${item.componentId} 的回滚替换副本不完整`), { code: 'COMPONENT_RESTORE_ROLLBACK_REPLACE_INVALID' });
        for (const expected of item.backupFiles) {
          const filePath = replacementByRelative.get(expected.relative);
          if (!filePath || (await fs.promises.stat(filePath)).size !== expected.size || await sha256File(filePath) !== expected.sha256) throw Object.assign(new Error(`组件 ${item.componentId} 的回滚替换副本校验失败`), { code: 'COMPONENT_RESTORE_ROLLBACK_REPLACE_INVALID' });
          const fileHandle = await fs.promises.open(filePath, 'r+'); try { await fileHandle.sync().catch(error => { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error; }); } finally { await fileHandle.close(); }
        }
        if (await exists(displaced) && await exists(targetRoot) && !await targetMatchesBackup()) await fs.promises.rm(targetRoot, { recursive: true, force: true });
        if (await exists(targetRoot) && !await exists(displaced)) { await fs.promises.mkdir(path.dirname(displaced), { recursive: true }); await fs.promises.rename(targetRoot, displaced); }
        if (!await exists(targetRoot)) await fs.promises.rename(replacement, targetRoot);
        if (!await targetMatchesBackup()) { const error = new Error(`组件 ${item.componentId} 的恢复事务替换校验失败`); error.code = 'COMPONENT_RESTORE_ROLLBACK_REPLACE_INVALID'; throw error; }
        const targetParentHandle = await fs.promises.open(path.dirname(targetRoot), 'r').catch(() => null);
        try { await targetParentHandle?.sync().catch(error => { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error; }); } finally { await targetParentHandle?.close(); }
        await writeDurableJson(donePath, { componentId: item.componentId, restored: 'backup' });
        await fs.promises.rm(displaced, { recursive: true, force: true });
      }
      if (!preserve) await fs.promises.rm(transactionRoot, { recursive: true, force: true });
    };
    const recoverPendingRelease = async transactionRoot => {
      for (const state of ['committed', 'rolled-back']) {
        const journal = await fs.promises.readFile(path.join(transactionRoot, `journal.${state}.json`), 'utf8').then(JSON.parse, () => null);
        if (!journal) continue;
        const pending = state === 'committed' ? journal.finalizePending : journal.releasePending;
        if (!Array.isArray(pending) || !pending.length) { await fs.promises.rm(transactionRoot, { recursive: true, force: true }); return true; }
        const phase = state === 'committed' ? 'finalize' : 'rollback';
        const failures = [];
        for (const item of pending) {
          const descriptor = currentDescriptors.find(value => value.componentId === item?.componentId);
          if (!descriptor || typeof item?.operationId !== 'string' || typeof item?.quiesceToken !== 'string') { failures.push(new Error('组件恢复待释放日志无效')); continue; }
          try {
            const result = await invokeBackupRestore(item.componentId, mode, {
              schemaVersion: 1, phase, operationId: item.operationId, mode, quiesceToken: item.quiesceToken,
              sourceWorkspace, targetWorkspace, ...(project ? { project } : {}),
            }, phaseContext);
            if (!result || result.operationId !== item.operationId) throw new Error(`组件 ${item.componentId} 返回了无效的 ${phase} 恢复回执`);
          } catch (error) { failures.push(error); componentServiceManager.quarantine?.(item.componentId, `component-restore-${phase}-pending`); }
        }
        if (failures.length) throw new AggregateError(failures, `组件恢复 ${phase} 待处理日志恢复失败`);
        await fs.promises.rm(transactionRoot, { recursive: true, force: true });
        return true;
      }
      return false;
    };
    for (const entry of await fs.promises.readdir(transactionsRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        const transactionRoot = path.join(transactionsRoot, entry.name);
        if (!await recoverPendingRelease(transactionRoot)) await rollbackTransaction(transactionRoot);
      }
    }
    const transactionId = componentRestoreOperationId(task.id, manifest.id || manifest.createdAt, mode, project?.id || targetWorkspace.root);
    const transactionRoot = safeDestination(transactionsRoot, transactionId);
    activeTransactionRoot = transactionRoot;
    const transactionComponents = [];
    for (const descriptor of descriptors) {
      const targetRoot = safeDestination(path.join(targetWorkspace.dataRoot, 'components'), descriptor.componentId);
      const existed = await exists(targetRoot);
      transactionComponents.push({ componentId: descriptor.componentId, existed });
    }
    await fs.promises.mkdir(transactionRoot, { recursive: true });
    await writeTransactionJournal(transactionRoot, { schemaVersion: 1, state: 'planned', components: transactionComponents });
    await fs.promises.mkdir(path.join(transactionRoot, 'backups'), { recursive: true });
    for (const descriptor of descriptors) {
      const targetRoot = safeDestination(path.join(targetWorkspace.dataRoot, 'components'), descriptor.componentId);
      const backupRoot = safeDestination(path.join(transactionRoot, 'backups'), descriptor.componentId);
      const existed = transactionComponents.find(item => item.componentId === descriptor.componentId).existed;
      if (existed) {
        await rejectSymlinks(targetRoot);
        await fs.promises.cp(targetRoot, backupRoot, { recursive: true, errorOnExist: true, force: false });
        const [before, after] = await Promise.all([collectFiles(targetRoot, 'transaction'), collectFiles(backupRoot, 'transaction')]);
        if (before.length !== after.length) throw new Error(`组件 ${descriptor.componentId} 恢复事务快照不完整`);
        const afterByRelative = new Map(after.map(file => [file.relative, file.absolute]));
        for (const file of before) if (!afterByRelative.has(file.relative) || await sha256File(file.absolute) !== await sha256File(afterByRelative.get(file.relative))) throw new Error(`组件 ${descriptor.componentId} 恢复事务快照校验失败`);
        const transactionItem = transactionComponents.find(item => item.componentId === descriptor.componentId);
        transactionItem.backupFiles = [];
        for (const file of after) {
          const stat = await fs.promises.stat(file.absolute); transactionItem.backupFiles.push({ relative: file.relative, size: stat.size, sha256: await sha256File(file.absolute) });
          const handle = await fs.promises.open(file.absolute, 'r+'); try { await handle.sync().catch(error => { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error; }); } finally { await handle.close(); }
        }
        const backupDirectories = [...new Set([backupRoot, path.dirname(backupRoot), path.join(transactionRoot, 'backups'), transactionRoot,
          ...after.map(file => path.dirname(file.absolute))])].sort((left, right) => right.length - left.length);
        for (const directoryPath of backupDirectories) {
          const handle = await fs.promises.open(directoryPath, 'r').catch(() => null);
          try { await handle?.sync().catch(error => { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error; }); } finally { await handle?.close(); }
        }
      }
    }
    await writeTransactionJournal(transactionRoot, { schemaVersion: 1, state: 'applying', components: transactionComponents });
    const results = (plan.opaquePreserved || []).map(componentId => {
      const paths = manifest.files.filter(item => item.scope === 'component-storage' && !isComponentHostControlStoragePath(item.path) && componentIdFromStoragePath(item.path) === componentId).map(item => item.path).sort();
      const redundantLegacy = plan.redundantLegacySources?.find(item => item.componentId === componentId)?.paths || [];
      return { componentId, schemaVersion: 1, status: 'opaque-preserved', pathCount: paths.length, pathsDigest: crypto.createHash('sha256').update(paths.join('\0')).digest('hex'),
        redundantLegacySourceCount: redundantLegacy.length, redundantLegacySourcesDigest: crypto.createHash('sha256').update(redundantLegacy.join('\0')).digest('hex') };
    });
    const handled = new Set();
    const stageRoot = path.join(temporaryRoot(target), `component-restore-${crypto.randomUUID()}`);
    try {
      for (const descriptor of descriptors) {
        const hasCurrentOpaqueStorage = manifest.files.some(item => item.scope === 'component-storage' && !isComponentHostControlStoragePath(item.path)
          && componentIdFromStoragePath(item.path) === descriptor.componentId);
        const matchedSources = matchingComponentSources(manifest, descriptor);
        const currentDeclaredSources = matchedSources.filter(source => source.entry.scope === 'component-storage');
        const declaredSources = currentDeclaredSources.length ? currentDeclaredSources : matchedSources.filter(source => source.entry.scope === 'domain-database').slice(0, 1);
        const hasLegacySource = declaredSources.some(source => source.entry.scope === 'domain-database');
        if (mode === 'workspace' && hasCurrentOpaqueStorage && !hasLegacySource && !descriptor.service.backupRestore.workspace) {
          const paths = manifest.files.filter(item => item.scope === 'component-storage' && !isComponentHostControlStoragePath(item.path) && componentIdFromStoragePath(item.path) === descriptor.componentId).map(item => item.path).sort();
          results.push({ componentId: descriptor.componentId, schemaVersion: 1, status: 'opaque-preserved', pathCount: paths.length, pathsDigest: crypto.createHash('sha256').update(paths.join('\0')).digest('hex') });
          continue;
        }
        const declaredKeys = new Set(declaredSources.map(source => `${source.entry.scope}\0${source.entry.path}`));
        const opaqueSources = hasCurrentOpaqueStorage
          ? manifest.files.filter(item => item.scope === 'component-storage' && !isComponentHostControlStoragePath(item.path) && componentIdFromStoragePath(item.path) === descriptor.componentId && !declaredKeys.has(`${item.scope}\0${item.path}`))
            .map(entry => ({ declaration: { format: 'component-storage-opaque-v1' }, entry }))
          : [];
        const sources = [...declaredSources, ...opaqueSources];
        if (!sources.length) continue;
        const hook = descriptor.service.backupRestore[mode];
        if (!hook) {
          const error = new Error(`组件 ${descriptor.componentId} 的备份包含私有数据，但未声明${mode === 'project' ? '项目级' : '工作区级'}恢复支持`);
          error.code = mode === 'project' ? 'COMPONENT_PROJECT_RESTORE_UNSUPPORTED' : 'COMPONENT_WORKSPACE_RESTORE_UNSUPPORTED';
          error.componentId = descriptor.componentId;
          throw error;
        }
        const componentStage = safeDestination(stageRoot, descriptor.componentId);
        const staged = [];
        for (const source of sources) {
          const destination = safeDestination(componentStage, `${source.entry.scope}/${source.entry.path}`);
          await materialize(target, source.entry, destination, task);
          if (await sha256File(destination) !== source.entry.hash) throw new Error(`组件 ${descriptor.componentId} 恢复源哈希校验失败`);
          staged.push({
            sourceKey: componentSourceKey(source.entry.scope, source.entry.path),
            scope: source.entry.scope,
            format: source.declaration.format,
            sourceVersion: source.sourceVersion || snapshotComponentRecord(manifest, descriptor.componentId)?.componentVersion || 'unversioned',
            metadataOrigin: source.metadataOrigin || source.declaration.metadataOrigin || 'snapshot',
            relativePath: source.entry.path,
            path: destination,
            sha256: source.entry.hash,
            size: source.entry.size,
            required: declaredSources.includes(source),
          });
        }
        const operationId = operationIds.get(descriptor.componentId);
        const preparedComponent = prepared.find(item => item.descriptor.componentId === descriptor.componentId);
        const targetComponentRoot = safeDestination(path.join(targetWorkspace.dataRoot, 'components'), descriptor.componentId);
        const componentControlPath = safeDestination(path.join(transactionRoot, 'component-work'), descriptor.componentId);
        await fs.promises.mkdir(componentControlPath, { recursive: true });
        const currentStorage = descriptor.service.backupRestore.sources.find(source => source.scope === 'component-storage' && componentIdFromStoragePath(source.path) === descriptor.componentId);
        const currentRelativePath = currentStorage ? normalizeKey(currentStorage.path).split('/').slice(1).join('/') : 'storage.sqlite3';
        const targetDatabasePath = safeDestination(targetComponentRoot, currentRelativePath);
        const sourceManifestValue = {
          schema: COMPONENT_SOURCE_MANIFEST_SCHEMA,
          schemaVersion: 1,
          operationId,
          componentId: descriptor.componentId,
          sourceVersion: snapshotComponentRecord(manifest, descriptor.componentId)?.componentVersion || 'unversioned',
          targetVersion: String(descriptor.componentVersion || 'unversioned'),
          mode,
          receiptContract: {
            schema: COMPONENT_RECEIPT_SCHEMA,
            version: 1,
            keyField: 'sourceKey',
            dispositionField: 'disposition',
            destinationField: 'destinationRelativePath',
            reasonField: 'reason',
            messageField: 'message',
            actions: { applied: 'applied', skipped: 'intentionally-skipped', hostPreserved: 'host-preserved' },
            skipReasons: ['other-project', 'rebuildable-cache', 'non-authoritative-audit', 'host-control', 'redundant-transition-source'],
            allowHostPreserved: mode === 'workspace',
          },
          entries: staged.map(source => ({ ...source, absolutePath: source.path, path: undefined })),
        };
        const sourceManifest = await writeHashedJson(path.join(componentStage, 'source-manifest.json'), sourceManifestValue);
        const hookPayload = {
          schemaVersion: 1, phase: 'apply', operationId, mode, quiesceToken: preparedComponent.quiesceToken,
          sourceManifestPath: sourceManifest.path,
          sourceManifestSha256: sourceManifest.sha256,
          sourceCount: staged.length,
          sourceVersion: sourceManifestValue.sourceVersion,
          targetVersion: sourceManifestValue.targetVersion,
          sourceWorkspace, targetWorkspace,
          targetStorage: { dataPath: targetComponentRoot, databasePath: targetDatabasePath, controlPath: componentControlPath },
          ...(project ? { project } : {}),
        };
        // Kept non-enumerable for in-process compatibility tests only. It can
        // never cross the JSON-line service boundary, so RPC size is bounded.
        Object.defineProperty(hookPayload, 'sources', { value: staged, enumerable: false });
        const rawResult = await invokeBackupRestore(descriptor.componentId, mode, hookPayload,
          { projectId: project?.id, projectName: project?.targetName, projectStatus: project?.targetStatus, workspacePath: targetWorkspace.root });
        let result = rawResult;
        let receiptDispositionStatuses = null;
        if (rawResult?.receiptPath) {
          result = await readHashedJson(componentStage, rawResult.receiptPath, rawResult.receiptSha256, `组件 ${descriptor.componentId} 恢复回执`);
          if (result.schema !== COMPONENT_RECEIPT_SCHEMA || result.sourceManifestSha256 !== sourceManifest.sha256
            || Number(rawResult.dispositionCount) !== result.dispositions?.length) throw new Error(`组件 ${descriptor.componentId} 返回了无效的文件恢复回执`);
          const receiptKeys = new Set();
          const receiptContract = sourceManifestValue.receiptContract;
          const allowedSkipReasons = new Set(receiptContract.skipReasons);
          const allowedActions = new Set(Object.values(receiptContract.actions));
          for (const item of result.dispositions) {
            const sourceKey = item?.[receiptContract.keyField]; const disposition = item?.[receiptContract.dispositionField];
            if (!item || typeof sourceKey !== 'string' || receiptKeys.has(sourceKey)
              || !allowedActions.has(disposition)
              || disposition === receiptContract.actions.hostPreserved && !receiptContract.allowHostPreserved
              || disposition === receiptContract.actions.skipped && !allowedSkipReasons.has(item[receiptContract.reasonField])) {
              throw new Error(`组件 ${descriptor.componentId} 的文件恢复回执处置无效`);
            }
            receiptKeys.add(sourceKey);
          }
          if (receiptKeys.size !== staged.length || staged.some(item => !receiptKeys.has(item.sourceKey))) throw new Error(`组件 ${descriptor.componentId} 的文件恢复回执未逐项处置全部来源`);
          receiptDispositionStatuses = new Map(result.dispositions.map(item => [item[receiptContract.keyField], item[receiptContract.dispositionField]]));
          result = {
            ...result,
            consumedPaths: result.dispositions.filter(item => item[receiptContract.dispositionField] === receiptContract.actions.applied).map(item => item[receiptContract.keyField]),
            pathDispositions: result.dispositions.filter(item => item[receiptContract.dispositionField] !== receiptContract.actions.applied).map(item => ({
              relativePath: item[receiptContract.keyField],
              disposition: item[receiptContract.dispositionField] === receiptContract.actions.hostPreserved ? 'preserved' : 'rebuildable',
              warning: item[receiptContract.reasonField] || '',
            })),
          };
        }
        if (!result || result.schemaVersion !== 1 || result.operationId !== operationId || !['committed', 'already-committed'].includes(result.status)) throw new Error(`组件 ${descriptor.componentId} 返回了无效的恢复回执`);
        if (!Array.isArray(result.consumedPaths) || result.consumedPaths.some(value => typeof value !== 'string')) throw new Error(`组件 ${descriptor.componentId} 的恢复回执缺少 consumedPaths`);
        const usesSourceKeys = rawResult?.receiptPath;
        const stagedByPath = new Map(staged.map((source, index) => [usesSourceKeys ? source.sourceKey : source.relativePath, { source, original: sources[index] }]));
        const consumedPaths = new Set(result.consumedPaths);
        if (consumedPaths.size !== result.consumedPaths.length || [...consumedPaths].some(relativePath => !stagedByPath.has(relativePath))) throw new Error(`组件 ${descriptor.componentId} 的恢复回执包含无效 consumedPaths`);
        const dispositions = Array.isArray(result.pathDispositions) ? result.pathDispositions : [];
        const dispositionByPath = new Map();
        for (const disposition of dispositions) {
          const relativePath = String(disposition?.relativePath || ''); const kind = String(disposition?.disposition || '');
          if (!stagedByPath.has(relativePath) || consumedPaths.has(relativePath) || dispositionByPath.has(relativePath)
            || !['preserved', 'rebuildable'].includes(kind) || kind === 'rebuildable' && !String(disposition.warning || '').trim()) throw new Error(`组件 ${descriptor.componentId} 的恢复回执包含无效 pathDispositions`);
          dispositionByPath.set(relativePath, { disposition: kind, warning: String(disposition.warning || '') });
        }
        const requiredDeclaredPaths = declaredSources.map(source => usesSourceKeys ? componentSourceKey(source.entry.scope, source.entry.path) : source.entry.path);
        if (requiredDeclaredPaths.some(relativePath => !consumedPaths.has(relativePath))) throw new Error(`组件 ${descriptor.componentId} 未消费声明的主恢复源`);
        if ((mode === 'project' || usesSourceKeys) && staged.some(source => {
          const key = usesSourceKeys ? source.sourceKey : source.relativePath;
          return !consumedPaths.has(key) && !dispositionByPath.has(key);
        })) throw new Error(`组件 ${descriptor.componentId} 未说明全部恢复源的处理结果`);
        for (const relativePath of [...consumedPaths, ...dispositionByPath.keys()]) {
          if (receiptDispositionStatuses?.get(relativePath) === sourceManifestValue.receiptContract.actions.hostPreserved) continue;
          const original = stagedByPath.get(relativePath).original.entry;
          handled.add(`${original.scope}\0${original.path}`);
        }
        const hostPreservedPaths = mode === 'workspace' ? [...new Set(staged.filter(source => {
          const key = usesSourceKeys ? source.sourceKey : source.relativePath;
          return usesSourceKeys
            ? receiptDispositionStatuses?.get(key) === sourceManifestValue.receiptContract.actions.hostPreserved
            : !consumedPaths.has(key) && !dispositionByPath.has(key);
        }).map(source => usesSourceKeys ? source.sourceKey : source.relativePath))].sort() : [];
        const hostPreservedDigest = crypto.createHash('sha256').update(hostPreservedPaths.join('\0')).digest('hex');
        results.push(usesSourceKeys ? {
          componentId: descriptor.componentId,
          schemaVersion: 1,
          operationId,
          status: result.status,
          appliedCount: consumedPaths.size,
          dispositionCount: staged.length,
          receiptSha256: rawResult.receiptSha256,
          warnings: (Array.isArray(result.warnings) ? result.warnings : []).slice(0, 32).map(value => String(value).slice(0, 512)),
          hostPreservedCount: hostPreservedPaths.length,
          hostPreservedDigest,
        } : { componentId: descriptor.componentId, ...result, hostPreservedPaths });
      }
      const componentRestore = { results, handled };
      const continuationResult = continuation ? await continuation(componentRestore) : componentRestore;
      await writeTransactionJournal(transactionRoot, { schemaVersion: 1, state: 'committed', components: transactionComponents,
        finalizePending: prepared.map(item => ({ componentId: item.descriptor.componentId, operationId: item.operationId, quiesceToken: item.quiesceToken })) });
      transactionCommitted = true;
      let finalizeWarning = null;
      let cleanupPending = false;
      for (let attempt = 0; attempt < 2 && prepared.length; attempt += 1) {
        try { await releasePrepared('finalize'); }
        catch (error) { finalizeWarning = error; }
      }
      if (prepared.length) {
        const stopFailures = [];
        for (const item of [...prepared]) {
          try { await componentServiceManager.stop(item.descriptor.componentId, 'component-restore-finalize-failed'); prepared.splice(prepared.indexOf(item), 1); }
          catch (error) { stopFailures.push(error); }
        }
        if (stopFailures.length) {
          cleanupPending = true;
          for (const item of prepared) componentServiceManager.quarantine?.(item.descriptor.componentId, 'component-restore-finalize-pending');
          finalizeWarning = new AggregateError(stopFailures, '组件恢复已提交；未释放的组件服务已隔离并等待清理');
        }
      }
      if (!cleanupPending) {
        try { await fs.promises.rm(transactionRoot, { recursive: true, force: true }); }
        catch (error) { cleanupPending = true; finalizeWarning = error; writeLog('warn', '组件恢复事务已提交但清理延后', { transactionRoot, error: error.message || String(error) }); }
      }
      return finalizeWarning && continuationResult && typeof continuationResult === 'object'
        ? { ...continuationResult, componentRestoreWarnings: [cleanupPending ? '组件恢复已提交；组件服务已隔离并等待 finalize 清理' : '组件恢复已提交；finalize 失败后已隔离组件服务'], cleanupPending } : continuationResult;
    } catch (error) {
      if (transactionCommitted) throw error;
      try {
        await rollbackTransaction(transactionRoot, { preserve: true });
        await writeTransactionJournal(transactionRoot, { schemaVersion: 1, state: 'rolled-back', components: transactionComponents,
          releasePending: prepared.map(item => ({ componentId: item.descriptor.componentId, operationId: item.operationId, quiesceToken: item.quiesceToken })) });
      }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], '组件恢复失败且事务回滚未完成'); }
      throw error;
    } finally { await fs.promises.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined); }
    } catch (error) {
      if (!transactionCommitted && prepared.length) {
        const release = await settlePrepared('rollback');
        if (!release.pending && activeTransactionRoot) await fs.promises.rm(activeTransactionRoot, { recursive: true, force: true }).catch(() => undefined);
        if (release.pending) throw new AggregateError([error, release.error], '组件恢复失败且 quiesce token 已隔离等待释放');
      }
      throw error;
    }
  };
  const restoreOwnedComponentData = async options => {
    const componentIds = options.plan.descriptors.map(item => item.descriptor.componentId);
    if (componentServiceManager.withBackupRestoreLease) {
      return componentServiceManager.withBackupRestoreLease(componentIds, invokeBackupRestore => restoreOwnedComponentDataUnderLease({ ...options, invokeBackupRestore }));
    }
    return restoreOwnedComponentDataUnderLease({ ...options, invokeBackupRestore: componentServiceManager.invokeBackupRestore.bind(componentServiceManager) });
  };

  const storeFile = async (target, sourcePath, task, progress, backupConfig = {}) => {
    const nas = isNasTarget(target);
    const retryDelays = [5000, 15000, 30000, 60000, 120000];
    let sourceMutationRetries = 0;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      task.throwIfCancelled();
      const before = await fs.promises.lstat(sourcePath);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(`备份输入不是普通文件：${sourcePath}`);
      const temporary = path.join(temporaryRoot(target), `${crypto.randomUUID()}.part`);
      const hash = crypto.createHash('sha256');
      let copied = 0;
      const limit = Number(backupConfig.nas?.bandwidthLimitMBps || 0);
      const limited = nas && backupConfig.nas?.limitEnabled === true && Number.isFinite(limit) && limit > 0
        && insideTimeWindow(backupConfig.nas?.limitStart, backupConfig.nas?.limitEnd);
      const throttleStartedAt = Date.now();
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          copied += chunk.length;
          progress?.(chunk.length);
          if (!limited) { callback(null, chunk); return; }
          const expectedMs = copied / (limit * 1024 * 1024) * 1000;
          const waitMs = Math.max(0, expectedMs - (Date.now() - throttleStartedAt));
          if (waitMs > 2) setTimeout(() => callback(null, chunk), Math.min(waitMs, 1000));
          else callback(null, chunk);
        },
      });
      try {
        await pipeline(fs.createReadStream(sourcePath), meter, fs.createWriteStream(temporary, { flags: 'wx' }));
        const after = await fs.promises.lstat(sourcePath);
        if (!after.isFile() || after.isSymbolicLink()) throw new Error(`备份输入在读取期间不再是普通文件：${sourcePath}`);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          await fs.promises.rm(temporary, { force: true });
          if (copied && progress) progress(-copied);
          if (sourceMutationRetries++ === 0) continue;
          throw new Error(`文件在备份期间持续变化：${sourcePath}`);
        }
        const digest = hash.digest('hex');
        const stableSource = await fs.promises.lstat(sourcePath);
        if (!stableSource.isFile() || stableSource.isSymbolicLink() || stableSource.size !== after.size || stableSource.mtimeMs !== after.mtimeMs
          || await sha256File(sourcePath) !== digest) {
          await fs.promises.rm(temporary, { force: true });
          if (copied && progress) progress(-copied);
          if (sourceMutationRetries++ === 0) continue;
          throw new Error(`文件内容在备份期间持续变化：${sourcePath}`);
        }
        const destination = objectPath(target, digest);
        if (!await exists(destination)) {
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          await durableSync(temporary);
          try { await fs.promises.rename(temporary, destination); }
          catch (error) {
            if (!await exists(destination)) throw error;
            await fs.promises.rm(temporary, { force: true });
          }
        } else await fs.promises.rm(temporary, { force: true });
        const storedStat = await fs.promises.lstat(destination);
        if (!storedStat.isFile() || storedStat.isSymbolicLink() || storedStat.size !== after.size || await sha256File(destination) !== digest) {
          throw Object.assign(new Error(`备份对象发生碰撞或已损坏：${digest}`), { code: 'BACKUP_OBJECT_COLLISION' });
        }
        await durableSync(destination);
        await durableSyncDirectory(path.dirname(destination));
        return { hash: digest, size: after.size, mtimeMs: after.mtimeMs };
      } catch (error) {
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
        if (copied && progress) progress(-copied);
        const transientNetworkError = nas && ['ENOENT', 'EIO', 'ENETUNREACH', 'ENETDOWN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'UNKNOWN'].includes(String(error?.code || '').toUpperCase());
        if (transientNetworkError && attempt < retryDelays.length) {
          const waitMs = retryDelays[attempt];
          task.report(5, `NAS 连接中断，${Math.round(waitMs / 1000)} 秒后重试`, { connectionState: 'waiting-network', retryAt: Date.now() + waitMs });
          await new Promise((resolve, reject) => {
            const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELLED' })); };
            const timer = setTimeout(() => { task.signal.removeEventListener('abort', onAbort); resolve(); }, waitMs);
            task.signal.addEventListener('abort', onAbort, { once: true });
          });
          await ensureTargetConnection(target, backupConfig).catch(() => undefined);
          continue;
        }
        throw error;
      }
    }
    throw new Error(`无法获得稳定的文件快照：${sourcePath}`);
  };

  const inventoryManifests = async target => {
    const root = snapshotsRoot(target);
    if (!await exists(root)) return { manifests: [], unsafe: [] };
    const directories = await fs.promises.readdir(root, { withFileTypes: true });
    const manifests = [];
    const unsafe = [];
    for (const directory of directories) {
      if (!directory.isDirectory() || directory.isSymbolicLink() || !/^[A-Za-z0-9_-]+$/.test(directory.name)) { unsafe.push(directory.name); continue; }
      try {
        const manifest = JSON.parse(await fs.promises.readFile(path.join(root, directory.name, 'manifest.json'), 'utf8'));
        if (manifest?.complete !== true || manifest.formatVersion !== SNAPSHOT_FORMAT_VERSION || manifest.id !== directory.name
          || !validObjectHash(manifest.database?.hash) || !Array.isArray(manifest.files)
          || manifest.files.some(entry => !validObjectHash(entry?.hash))) { unsafe.push(directory.name); continue; }
        manifests.push(manifest);
      } catch { unsafe.push(directory.name); }
    }
    return { manifests: manifests.sort((left, right) => right.createdAt - left.createdAt), unsafe };
  };
  const listManifests = async (target, { requireSafe = false } = {}) => {
    const inventory = await inventoryManifests(target);
    if (requireSafe && inventory.unsafe.length) throw inventoryUnsafe(`备份快照库存包含不可读、损坏、不支持或未完成项目：${inventory.unsafe.join(', ')}`);
    return inventory.manifests;
  };

  const manifestFor = async (target, id) => {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new Error('备份快照标识无效');
    await assertStoreLayoutPhysical(target);
    await assertStoreSupported(target);
    const manifest = JSON.parse(await fs.promises.readFile(path.join(snapshotsRoot(target), String(id), 'manifest.json'), 'utf8'));
    if (!manifest?.complete || manifest.formatVersion !== SNAPSHOT_FORMAT_VERSION) throw new Error('备份快照无效或尚未完成');
    if (manifest.id !== String(id)) throw new Error('备份清单标识与物理目录不一致');
    if (!validObjectHash(manifest.database?.hash) || !Array.isArray(manifest.files)
      || manifest.files.some(entry => !validObjectHash(entry?.hash))) throw new Error('备份清单包含无效对象');
    return manifest;
  };

  const retainedSnapshotIds = (manifests, backupConfig) => {
    if (!manifests.length) return new Set();
    if (backupConfig.mode === 'latest') return new Set([manifests[0].id]);
    const keep = new Set([manifests[0].id]);
    const buckets = [
      { count: FIXED_RETENTION.daily, key: date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` },
      { count: FIXED_RETENTION.weekly, key: date => { const first = new Date(date.getFullYear(), 0, 1); return `${date.getFullYear()}-${Math.floor((date - first) / (7 * DAY_MS))}`; } },
      { count: FIXED_RETENTION.monthly, key: date => `${date.getFullYear()}-${date.getMonth()}` },
    ];
    for (const bucket of buckets) {
      const seen = new Set();
      for (const manifest of manifests) {
        const key = bucket.key(new Date(manifest.createdAt));
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size <= bucket.count) keep.add(manifest.id);
      }
    }
    return keep;
  };

  const assertObjectInventorySafe = async (target, manifests = []) => {
    if (!await exists(objectsRoot(target))) {
      if (manifests.length) throw inventoryUnsafe('备份对象目录缺失');
      return;
    }
    const seen = new Map();
    for (const prefix of await fs.promises.readdir(objectsRoot(target), { withFileTypes: true })) {
      if (!prefix.isDirectory() || prefix.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(prefix.name)) throw inventoryUnsafe(`备份对象库存包含无效项目：${prefix.name}`);
      for (const item of await fs.promises.readdir(path.join(objectsRoot(target), prefix.name), { withFileTypes: true })) {
        if (!item.isFile() || item.isSymbolicLink() || !/^[a-f0-9]{62}$/.test(item.name)) throw inventoryUnsafe(`备份对象库存包含无效对象：${prefix.name}${item.name}`);
        const hash = `${prefix.name}${item.name}`;
        const absolute = path.join(objectsRoot(target), prefix.name, item.name);
        const stat = await fs.promises.lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || await sha256File(absolute) !== hash) throw inventoryUnsafe(`备份对象已损坏：${hash}`);
        seen.set(hash, stat.size);
      }
    }
    for (const manifest of manifests) for (const entry of [manifest.database, ...manifest.files]) {
      if (!seen.has(entry.hash) || (entry.size != null && seen.get(entry.hash) !== Number(entry.size))) throw inventoryUnsafe(`备份清单引用缺失或大小不符的对象：${entry.hash}`);
    }
  };

  const cleanupRetention = async (target, backupConfig, workspaceId) => {
    await assertStoreLayoutPhysical(target);
    await assertStoreSupported(target);
    const allManifests = await listManifests(target, { requireSafe: true });
    await assertObjectInventorySafe(target, allManifests);
    const workspaceManifests = allManifests.filter(manifest => manifest.workspace?.id === workspaceId);
    const retained = retainedSnapshotIds(workspaceManifests, backupConfig);
    let removedSnapshots = 0;
    for (const manifest of workspaceManifests) {
      if (!retained.has(manifest.id)) {
        if (!/^[A-Za-z0-9_-]+$/.test(manifest.id)) throw inventoryUnsafe('拒绝删除标识无效的备份快照');
        const candidate = path.join(snapshotsRoot(target), manifest.id);
        if (!inside(snapshotsRoot(target), candidate)) throw inventoryUnsafe('拒绝删除越界备份快照');
        await fs.promises.rm(candidate, { recursive: true, force: true });
        removedSnapshots += 1;
      }
    }
    const referenced = new Set();
    for (const manifest of await listManifests(target, { requireSafe: true })) {
      referenced.add(manifest.database.hash);
      for (const entry of manifest.files) referenced.add(entry.hash);
    }
    if (!await exists(objectsRoot(target))) return { removedSnapshots, removedObjects: 0, reclaimedBytes: 0 };
    let removedObjects = 0;
    let reclaimedBytes = 0;
    for (const prefix of await fs.promises.readdir(objectsRoot(target), { withFileTypes: true })) {
      if (!prefix.isDirectory() || prefix.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(prefix.name)) throw inventoryUnsafe(`备份对象库存包含无效项目：${prefix.name}`);
      const directory = path.join(objectsRoot(target), prefix.name);
      for (const item of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (!item.isFile() || item.isSymbolicLink() || !/^[a-f0-9]{62}$/.test(item.name)) throw inventoryUnsafe(`备份对象库存包含无效对象：${prefix.name}${item.name}`);
        if (!referenced.has(`${prefix.name}${item.name}`)) {
          const candidate = path.join(directory, item.name);
          reclaimedBytes += (await fs.promises.stat(candidate).catch(() => ({ size: 0 }))).size;
          await fs.promises.rm(candidate, { force: true });
          removedObjects += 1;
        }
      }
      await fs.promises.rmdir(directory).catch(() => undefined);
    }
    return { removedSnapshots, removedObjects, reclaimedBytes };
  };

  const listStoredObjects = async target => {
    const objects = new Map();
    if (!await exists(objectsRoot(target))) return objects;
    for (const prefix of await fs.promises.readdir(objectsRoot(target), { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const directory = path.join(objectsRoot(target), prefix.name);
      for (const item of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const hash = `${prefix.name}${item.name}`;
        if (!item.isFile() || !validObjectHash(hash)) continue;
        const absolute = path.join(directory, item.name);
        objects.set(hash, { path: absolute, size: (await fs.promises.stat(absolute)).size });
      }
    }
    return objects;
  };

  const spaceStatus = async workspaceRoot => {
    const backupConfig = readSavedConfig()?.backup || {};
    const target = String(backupConfig.targetPath || '').trim();
    if (!target || !isApprovedTarget(target) || !await exists(target)) throw new Error('备份位置当前不可用');
    const manifests = await listManifests(target);
    const objects = await listStoredObjects(target);
    const referenced = new Set();
    const current = new Set();
    const internal = new Set();
    let logicalBytes = 0;
    const latestByWorkspace = new Map();
    for (const manifest of manifests) {
      if (!latestByWorkspace.has(manifest.workspace?.id || manifest.id)) latestByWorkspace.set(manifest.workspace?.id || manifest.id, manifest);
      const entries = [{ hash: manifest.database.hash, size: manifest.database.size || 0, scope: 'database' }, ...manifest.files];
      for (const entry of entries) {
        referenced.add(entry.hash);
        logicalBytes += Number(entry.size || 0);
        if (entry.scope === 'database' || entry.scope === 'workspace-data' || entry.scope === 'app-config') internal.add(entry.hash);
      }
    }
    for (const manifest of latestByWorkspace.values()) {
      current.add(manifest.database.hash);
      for (const entry of manifest.files) current.add(entry.hash);
    }
    const bytesFor = hashes => [...hashes].reduce((sum, hash) => sum + Number(objects.get(hash)?.size || 0), 0);
    const actualBytes = [...objects.values()].reduce((sum, item) => sum + item.size, 0);
    const referencedBytes = bytesFor(referenced);
    const currentBytes = bytesFor(current);
    const capacity = await diskCapacity(target);
    let workspaceSnapshotCount = manifests.length;
    let expiredSnapshotCount = 0;
    let estimatedReclaimableBytes = Math.max(0, actualBytes - referencedBytes);
    if (workspaceRoot && await exists(markerPath(path.resolve(workspaceRoot)))) {
      const workspaceId = await readWorkspaceId(path.resolve(workspaceRoot));
      const workspaceManifests = manifests.filter(manifest => manifest.workspace?.id === workspaceId);
      workspaceSnapshotCount = workspaceManifests.length;
      const retained = retainedSnapshotIds(workspaceManifests, backupConfig);
      const expiredIds = new Set(workspaceManifests.filter(manifest => !retained.has(manifest.id)).map(manifest => manifest.id));
      expiredSnapshotCount = expiredIds.size;
      const postCleanupReferenced = new Set();
      for (const manifest of manifests) {
        if (manifest.workspace?.id === workspaceId && expiredIds.has(manifest.id)) continue;
        postCleanupReferenced.add(manifest.database.hash);
        for (const entry of manifest.files) postCleanupReferenced.add(entry.hash);
      }
      estimatedReclaimableBytes = Math.max(0, actualBytes - bytesFor(postCleanupReferenced));
    }
    return {
      success: true,
      targetPath: target,
      snapshotCount: manifests.length,
      workspaceSnapshotCount,
      objectCount: objects.size,
      logicalBytes,
      actualBytes,
      referencedBytes,
      deduplicatedBytes: Math.max(0, logicalBytes - referencedBytes),
      currentBytes,
      historyBytes: Math.max(0, referencedBytes - currentBytes),
      internalBytes: bytesFor(internal),
      reclaimableBytes: Math.max(0, actualBytes - referencedBytes),
      expiredSnapshotCount,
      estimatedReclaimableBytes,
      ...capacity,
    };
  };

  const cleanup = async (workspaceRoot, restartTask = null) => {
    const backupConfig = readSavedConfig()?.backup || {};
    const target = String(backupConfig.targetPath || '').trim();
    if (!target || !isApprovedTarget(target)) throw new Error('备份位置当前不可用');
    const root = path.resolve(workspaceRoot);
    const workspaceId = await readWorkspaceId(root);
    const run = () => backgroundTasks.run({
      ...(restartTask?.id ? { id: restartTask.id } : {}),
      type: 'backup-cleanup',
      title: '清理备份空间',
      dedupeKey: `backup-cleanup:${target}`,
      cancellable: true,
      resources: [target],
      metadata: { workspacePath: root, targetPath: target },
    }, async task => {
      await ensureTargetConnection(target, backupConfig);
      task.report(10, '正在应用快照保留策略');
      const result = await cleanupRetention(target, backupConfig, workspaceId);
      await fs.promises.rm(temporaryRoot(target), { recursive: true, force: true });
      await fs.promises.mkdir(temporaryRoot(target), { recursive: true });
      const manifests = await listManifests(target);
      const referenced = [...new Set(manifests.flatMap(manifest => [manifest.database.hash, ...manifest.files.map(entry => entry.hash)]))].sort();
      const sample = referenced.filter((_hash, index) => index % Math.max(1, Math.floor(referenced.length / 20)) === 0).slice(0, 20);
      for (const [index, hash] of sample.entries()) {
        task.throwIfCancelled();
        if (await sha256File(objectPath(target, hash)) !== hash) throw new Error(`清理后抽检失败：${hash.slice(0, 12)}`);
        task.report(70 + (index + 1) / Math.max(1, sample.length) * 30, `正在抽检剩余对象 ${index + 1}/${sample.length}`);
      }
      return { ...result, sampledObjects: sample.length };
    }, run);
    return run();
  };

  const snapshotWorkspaceDatabases = async (root, stage, task) => {
    const liveDatabasePath = path.resolve(getWorkspaceDatabasePath(root));
    const liveOperationsDatabasePath = getWorkspaceOperationsDatabasePath?.(root);
    const liveMediaDatabasePath = getWorkspaceMediaDatabasePath?.(root);
    const liveVersioningDatabasePath = getWorkspaceVersioningDatabasePath?.(root);
    const available = async value => Boolean(value && await exists(value));
    const domains = ['core'];
    if (await available(liveOperationsDatabasePath)) domains.push('operations');
    if (await available(liveMediaDatabasePath)) domains.push('media');
    if (await available(liveVersioningDatabasePath)) domains.push('versioning');
    return withWorkspaceRecoveryLease({ workspaceRoot: root, domains, signal: task.signal, deadlineAt: Date.now() + 30 * 60 * 1000 }, async () => {
      task.report(1, '正在创建数据库快照');
      const databaseSnapshot = path.join(stage, 'workspace.sqlite3');
      let mediaSnapshot = null; let mediaDatabaseInfo = null;
      if (domains.includes('media')) {
        mediaSnapshot = path.join(stage, 'media.sqlite3');
        mediaDatabaseInfo = await runPythonJsonAction('domain_recovery.py', ['snapshot', '--domain', 'media', '--source', liveMediaDatabasePath, '--destination', mediaSnapshot], 30 * 60 * 1000);
      }
      let versioningSnapshot = null; let versioningDatabaseInfo = null;
      if (domains.includes('versioning')) {
        versioningSnapshot = path.join(stage, 'versioning.sqlite3');
        versioningDatabaseInfo = await runPythonJsonAction('domain_recovery.py', ['snapshot', '--domain', 'versioning', '--source', liveVersioningDatabasePath, '--destination', versioningSnapshot], 30 * 60 * 1000);
      }
      const databaseInfo = await runPythonJsonAction('backup_db.py', [
        'snapshot', '--source', liveDatabasePath, '--destination', databaseSnapshot,
        ...(domains.includes('media') ? ['--media', liveMediaDatabasePath] : []),
      ], 30 * 60 * 1000);
      let operationsSnapshot = null; let operationsDatabaseInfo = null;
      if (domains.includes('operations')) {
        operationsSnapshot = path.join(stage, 'operations.sqlite3');
        operationsDatabaseInfo = await runPythonJsonAction('operations_db.py', ['snapshot', '--source', liveOperationsDatabasePath, '--destination', operationsSnapshot], 30 * 60 * 1000);
      }
      return { databaseSnapshot, databaseInfo, liveDatabasePath, liveOperationsDatabasePath, liveMediaDatabasePath, liveVersioningDatabasePath,
        mediaSnapshot, mediaDatabaseInfo, versioningSnapshot, versioningDatabaseInfo, operationsSnapshot, operationsDatabaseInfo };
    });
  };

  const runBackup = async (workspaceRoot, reason = 'manual', resumeTask = null) => {
    const config = await configMutationService.read();
    const backupConfig = config?.backup || {};
    const target = String(backupConfig.targetPath || '').trim();
    if (!backupConfig.enabled || !target) throw new Error('请先在设置中启用备份并选择备份位置');
    if (!isApprovedTarget(target)) throw new Error('备份位置需要通过系统文件夹选择器授权');
    const root = path.resolve(workspaceRoot);
    await assertNoReparseAncestorsBeforeCreate(root);
    await assertNoReparseAncestorsBeforeCreate(target);
    if (inside(root, target) || inside(target, root)) throw new Error('备份位置不能位于工作区内部，也不能包含工作区');
    const run = () => backgroundTasks.run({
      ...(resumeTask?.id ? { id: resumeTask.id } : {}),
      type: 'workspace-backup',
      title: '备份工作区',
      dedupeKey: `workspace-backup:${root}`,
      cancellable: true,
      resources: [root, target],
      resumable: true,
      checkpoint: resumeTask?.checkpoint,
      progress: resumeTask?.progress,
      metadata: { workspacePath: root, targetPath: target, reason },
      resumeFactory: snapshot => runBackup(root, reason, snapshot),
    }, async task => {
      await ensureTargetConnection(target, backupConfig);
      await assertStoreLayoutPhysical(target);
      await ensureStore(target);
      await assertStoreLayoutPhysical(target);
      const [rootReal, targetReal] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(target)]);
      if (inside(rootReal, targetReal) || inside(targetReal, rootReal)) throw new Error('备份位置不能位于工作区内部，也不能包含工作区');
      const id = snapshotId();
      const stage = path.join(temporaryRoot(target), `snapshot-${id}-${crypto.randomUUID()}`);
      await fs.promises.mkdir(stage, { recursive: true });
      try {
      const { databaseSnapshot, databaseInfo, liveDatabasePath, liveOperationsDatabasePath, liveMediaDatabasePath, liveVersioningDatabasePath,
        mediaSnapshot, mediaDatabaseInfo, versioningSnapshot, versioningDatabaseInfo, operationsSnapshot, operationsDatabaseInfo } = await snapshotWorkspaceDatabases(root, stage, task);
      const workspaceId = await readWorkspaceId(root);
      const previousManifest = (await listManifests(target)).find(manifest => manifest.workspace?.id === workspaceId);
      const previousByInput = new Map((previousManifest?.files || []).map(entry => [`${entry.scope}:${normalizeKey(entry.path)}`, entry]));
      if (previousManifest?.database) previousByInput.set('database:workspace.sqlite3', previousManifest.database);
      const workspaceDataRoot = getWorkspaceDataRoot(root);
      const workspaceFiles = await collectFiles(root, 'workspace', (relative, item) =>
        item.isDirectory() && (relative === '_photoflow_safety_temp' || path.basename(relative).startsWith('.photoflow-')));
      const materializedArchiveProjectIds = [];
      for (const project of databaseInfo.projects || []) {
        const archivePath = String(project.extra?.archive?.path || '');
        if (!archivePath || !await exists(archivePath)) continue;
        const archivedFiles = await collectFiles(archivePath, 'workspace');
        for (const item of archivedFiles) item.relative = normalizeKey(path.join(project.relativePath, item.relative));
        workspaceFiles.push(...archivedFiles);
        materializedArchiveProjectIds.push(project.id);
      }
      const databaseRelative = normalizeKey(path.relative(workspaceDataRoot, liveDatabasePath));
      const operationsDatabaseRelative = liveOperationsDatabasePath
        ? normalizeKey(path.relative(workspaceDataRoot, liveOperationsDatabasePath))
        : '';
      const mediaDatabaseRelative = liveMediaDatabasePath ? normalizeKey(path.relative(workspaceDataRoot, liveMediaDatabasePath)) : '';
      const versioningDatabaseRelative = liveVersioningDatabasePath ? normalizeKey(path.relative(workspaceDataRoot, liveVersioningDatabasePath)) : '';
      const workspaceDataFiles = await collectFiles(workspaceDataRoot, 'workspace-data', (relative, item) => {
        const normalized = normalizeKey(relative);
        const first = normalized.split('/')[0];
        return (item.isDirectory() && ['thumbnails', 'backups', 'domain-backups', 'domain-restore', 'components', '.component-restore-transactions'].includes(first))
          || normalized === databaseRelative
          || normalized === `${databaseRelative}-wal`
          || normalized === `${databaseRelative}-shm`
          || normalized === operationsDatabaseRelative
          || normalized === `${operationsDatabaseRelative}-wal`
          || normalized === `${operationsDatabaseRelative}-shm`
          || normalized === mediaDatabaseRelative
          || normalized === `${mediaDatabaseRelative}-wal`
          || normalized === `${mediaDatabaseRelative}-shm`
          || normalized === versioningDatabaseRelative
          || normalized === `${versioningDatabaseRelative}-wal`
          || normalized === `${versioningDatabaseRelative}-shm`;
      });
      // Component Host V2 owns this complete tree. The host treats it as an
      // opaque, hash-addressed data package and never opens a component file
      // or assumes a database/schema layout.
      const componentStorageSnapshot = await snapshotComponentStorage(workspaceDataRoot, stage);
      const componentStorageFiles = componentStorageSnapshot.files;
      const appFiles = [];
      const linearizedConfigPath = path.join(stage, 'photoflow-config-snapshot.json');
      await fs.promises.writeFile(linearizedConfigPath, JSON.stringify(config, null, 2), 'utf8');
      for (const [relative, absolute] of [['photoflow_config.json', linearizedConfigPath], ['birthdays.json', getUserBirthdaysPath()]]) {
        if (await exists(absolute)) appFiles.push({ scope: 'app-config', relative, absolute });
      }
      const externalRegistryPath = getManagedExternalLinkRegistryPath?.();
      if (externalRegistryPath && await exists(externalRegistryPath)) {
        const registry = await fs.promises.readFile(externalRegistryPath, 'utf8').then(value => {
          try { return JSON.parse(value); }
          catch { return { version: 1, links: {} }; }
        });
        const usedLinkIds = new Set();
        for (const project of databaseInfo.projects || []) {
          const archivePath = String(project.extra?.archive?.path || '');
          const projectRoot = archivePath && await exists(archivePath)
            ? path.resolve(archivePath)
            : path.resolve(root, project.relativePath || project.relative_path || '');
          for (const link of getManagedExternalLinks?.(projectRoot) || []) if (link.linkId) usedLinkIds.add(String(link.linkId));
        }
        const scopedRegistry = {
          version: 1,
          links: Object.fromEntries(Object.entries(registry?.links || {}).filter(([linkId]) => usedLinkIds.has(linkId))),
        };
        const scopedRegistryPath = path.join(stage, 'managed-external-links.json');
        await fs.promises.writeFile(scopedRegistryPath, JSON.stringify(scopedRegistry), 'utf8');
        appFiles.push({ scope: 'app-config', relative: 'managed-external-links.json', absolute: scopedRegistryPath });
      }
      const inputs = [
        ...workspaceFiles,
        ...workspaceDataFiles,
        ...componentStorageFiles,
        ...appFiles,
        { scope: 'database', relative: 'workspace.sqlite3', absolute: databaseSnapshot },
        ...(mediaSnapshot ? [{ scope: 'domain-database', relative: 'media.sqlite3', absolute: mediaSnapshot, schemaVersion: mediaDatabaseInfo?.schemaVersion || 0 }] : []),
        ...(versioningSnapshot ? [{ scope: 'domain-database', relative: 'versioning.sqlite3', absolute: versioningSnapshot, schemaVersion: versioningDatabaseInfo?.schemaVersion || 0 }] : []),
        ...(operationsSnapshot ? [{
          scope: 'domain-database',
          relative: 'operations.sqlite3',
          absolute: operationsSnapshot,
          schemaVersion: operationsDatabaseInfo?.schemaVersion || 0,
        }] : []),
      ];
      const totalBytes = (await Promise.all(inputs.map(item => fs.promises.stat(item.absolute).then(stat => stat.size)))).reduce((sum, size) => sum + size, 0);
      let copiedBytes = 0;
      let transferredBytes = 0;
      let reusedBytes = 0;
      let reusedFiles = 0;
      let completedFiles = 0;
      const savedCheckpoint = task.getCheckpoint() || {};
      const checkpointInputs = new Map(Array.isArray(savedCheckpoint.inputs) ? savedCheckpoint.inputs : []);
      const maxPersistedCheckpointInputs = 4096;
      let lastCheckpointAt = 0;
      const projectAssociations = new Map();
      for (const project of databaseInfo.projects || []) {
        const projectPrefix = normalizeKey(project.relativePath).replace(/\/$/, '') + '/';
        for (const item of workspaceFiles) {
          const key = normalizeKey(item.relative);
          if (key === projectPrefix.slice(0, -1) || key.startsWith(projectPrefix)) {
            const set = projectAssociations.get(`workspace:${key}`) || new Set();
            set.add(project.id);
            projectAssociations.set(`workspace:${key}`, set);
          }
        }
        for (const item of workspaceDataFiles) {
          const key = normalizeKey(item.relative);
          if ((project.workspaceDataPrefixes || []).some(prefix => key.startsWith(normalizeKey(prefix)))
            || (project.workspaceDataFiles || []).map(normalizeKey).includes(key)) {
            const set = projectAssociations.get(`workspace-data:${key}`) || new Set();
            set.add(project.id);
            projectAssociations.set(`workspace-data:${key}`, set);
          }
        }
      }
      const stored = [];
      let databaseStored;
      for (const input of inputs) {
        task.throwIfCancelled();
        const inputKey = `${input.scope}:${normalizeKey(input.relative)}`;
        const checkpointEntry = checkpointInputs.get(inputKey);
        const previous = checkpointEntry || previousByInput.get(inputKey);
        const sourceStat = await fs.promises.lstat(input.absolute);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`备份输入不是普通文件：${input.absolute}`);
        let canReuse = previous
          && validObjectHash(previous.hash)
          && Number(previous.size) === sourceStat.size
          && Math.abs(Number(previous.mtimeMs) - sourceStat.mtimeMs) < 1
          && await exists(objectPath(target, previous.hash));
        if (canReuse) {
          const objectStat = await fs.promises.lstat(objectPath(target, previous.hash));
          const sourceHash = objectStat.isFile() && !objectStat.isSymbolicLink() && objectStat.size === sourceStat.size ? await sha256File(input.absolute) : '';
          const stableStat = await fs.promises.lstat(input.absolute);
          canReuse = objectStat.isFile() && !objectStat.isSymbolicLink() && objectStat.size === sourceStat.size
            && stableStat.isFile() && !stableStat.isSymbolicLink() && stableStat.size === sourceStat.size && stableStat.mtimeMs === sourceStat.mtimeMs
            && sourceHash === previous.hash && await sha256File(objectPath(target, previous.hash)) === previous.hash;
        }
        let result;
        if (canReuse) {
          result = { hash: previous.hash, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs };
          copiedBytes += sourceStat.size;
          reusedBytes += sourceStat.size;
          reusedFiles += 1;
          const progress = totalBytes ? 5 + copiedBytes / totalBytes * 90 : 95;
          task.report(progress, `正在复用未变化文件 ${completedFiles + 1}/${inputs.length}`, { copiedBytes: transferredBytes, reusedBytes, totalBytes, completedFiles, totalFiles: inputs.length });
        } else {
          result = await storeFile(target, input.absolute, task, delta => {
            copiedBytes += delta;
            transferredBytes += delta;
            const progress = totalBytes ? 5 + copiedBytes / totalBytes * 90 : 95;
            task.report(progress, `正在备份 ${completedFiles + 1}/${inputs.length} 个文件`, { copiedBytes: Math.max(0, transferredBytes), reusedBytes, totalBytes, completedFiles, totalFiles: inputs.length });
          }, backupConfig);
        }
        completedFiles += 1;
        checkpointInputs.set(inputKey, { hash: result.hash, size: result.size, mtimeMs: result.mtimeMs });
        while (checkpointInputs.size > maxPersistedCheckpointInputs) checkpointInputs.delete(checkpointInputs.keys().next().value);
        const checkpointProgress = totalBytes ? 5 + copiedBytes / totalBytes * 90 : 95;
        const checkpointDue = completedFiles === inputs.length || completedFiles % 64 === 0 || Date.now() - lastCheckpointAt >= 2000;
        if (checkpointDue) {
          lastCheckpointAt = Date.now();
          const compactInputs = [...checkpointInputs.entries()].slice(-maxPersistedCheckpointInputs);
          task.saveCheckpoint({ version: 1, phase: 'storing-files', inputs: compactInputs, completedFiles }, checkpointProgress, `已保存 ${completedFiles}/${inputs.length} 个文件`, {
            copiedBytes: Math.max(0, transferredBytes), reusedBytes, totalBytes, completedFiles, totalFiles: inputs.length,
          });
        }
        if (input.scope === 'database') {
          databaseStored = result;
          continue;
        }
        stored.push({
          scope: input.scope,
          path: normalizeKey(input.relative),
          ...result,
          ...(input.scope === 'domain-database' ? { schemaVersion: input.schemaVersion || 0 } : {}),
          projectIds: [...(projectAssociations.get(`${input.scope}:${normalizeKey(input.relative)}`) || [])],
        });
      }
      if (!databaseStored) throw new Error('未能保存数据库快照');
      const componentBackups = componentStorageSnapshot.componentBackups;
      const manifest = {
        formatVersion: SNAPSHOT_FORMAT_VERSION,
        id,
        complete: true,
        createdAt: Date.now(),
        appVersion: app.getVersion(),
        reason,
        mode: backupConfig.mode === 'latest' ? 'latest' : 'history',
        workspace: { id: workspaceId, root, dataRoot: workspaceDataRoot },
        database: { ...databaseStored, schemaVersion: databaseInfo.schemaVersion },
        projects: databaseInfo.projects || [],
        materializedArchiveProjectIds,
        componentBackups,
        files: stored,
        totals: { files: stored.length + 1, bytes: databaseStored.size + stored.reduce((sum, item) => sum + item.size, 0) },
        incremental: { reusedFiles, reusedBytes, transferredBytes: Math.max(0, transferredBytes) },
      };
      const finalDirectory = path.join(snapshotsRoot(target), id);
      await fs.promises.mkdir(finalDirectory, { recursive: false });
      const manifestTemporary = path.join(finalDirectory, 'manifest.json.tmp');
      await fs.promises.writeFile(manifestTemporary, JSON.stringify(manifest, null, 2), 'utf8');
      await durableSync(manifestTemporary);
      await fs.promises.rename(manifestTemporary, path.join(finalDirectory, 'manifest.json'));
      await durableSyncDirectory(finalDirectory);
      await durableSyncDirectory(snapshotsRoot(target));
      task.report(97, '正在应用备份保留策略');
      try { await cleanupRetention(target, backupConfig, workspaceId); }
      catch (error) {
        writeLog?.('warn', 'Backup retention deferred after snapshot commit', { snapshotId: id, error: error.message || String(error) });
        task.report(99, '备份已完成，空间清理将在稍后重试', { snapshotId: id, cleanupWarning: error.message || String(error) });
      }
      task.report(100, '备份完成', { snapshotId: id, copiedBytes: Math.max(0, transferredBytes), reusedBytes, totalBytes, completedFiles: inputs.length, totalFiles: inputs.length });
      return manifest;
      } finally {
        await fs.promises.rm(stage, { recursive: true, force: true }).catch(error => writeLog?.('warn', 'Backup staging cleanup failed', { stage, error: error.message || String(error) }));
      }
    }, run);
    return run();
  };

  const status = async workspaceRoot => {
    const config = readSavedConfig();
    const backupConfig = config?.backup || {};
    const target = String(backupConfig.targetPath || '').trim();
    if (!backupConfig.enabled || !target) return { success: true, state: 'unconfigured', enabled: false, snapshots: [] };
    if (!await exists(target) && isNasTarget(target)) await ensureTargetConnection(target, backupConfig).catch(() => undefined);
    if (!await exists(target)) return { success: true, state: 'offline', enabled: true, targetPath: target, isNas: isNasTarget(target), connection: connectionStates.get(path.resolve(target).toLocaleLowerCase()), snapshots: [] };
    try {
      let manifests = await listManifests(target);
      if (workspaceRoot && await exists(markerPath(path.resolve(workspaceRoot)))) {
        const id = await readWorkspaceId(path.resolve(workspaceRoot));
        manifests = manifests.filter(item => item.workspace?.id === id);
      }
      const latest = manifests[0];
      const active = backgroundTasks.list().find(task => task.type === 'workspace-backup' && ['queued', 'running'].includes(task.state) && task.metadata?.workspacePath === path.resolve(workspaceRoot));
      const connection = connectionStates.get(path.resolve(target).toLocaleLowerCase()) || { connected: true, isNas: isNasTarget(target) };
      return {
        success: true,
        enabled: true,
        state: active ? 'running' : latest ? 'protected' : 'never-backed-up',
        targetPath: target,
        isNas: isNasTarget(target),
        connection,
        mode: backupConfig.mode === 'latest' ? 'latest' : 'history',
        latestAt: latest?.createdAt || 0,
        latestSnapshotId: latest?.id || '',
        snapshotCount: manifests.length,
        task: active || undefined,
        snapshots: manifests.map(item => ({ id: item.id, createdAt: item.createdAt, files: item.totals?.files || 0, bytes: item.totals?.bytes || 0, projects: item.projects?.length || 0, projectItems: (item.projects || []).map(project => ({ id: project.id, name: project.name, status: project.status, relativePath: project.relativePath })), reason: item.reason, mode: item.mode })),
      };
    } catch (error) {
      return { success: false, enabled: true, state: 'error', targetPath: target, snapshots: [], error: error.message || String(error) };
    }
  };

  const materialize = async (target, entry, destination, task) => {
    task?.throwIfCancelled();
    const source = objectPath(target, entry.hash);
    if (!await exists(source)) throw new Error(`备份对象缺失：${entry.hash}`);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${crypto.randomUUID()}.photoflow-restore`;
    await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    const digest = await sha256File(temporary);
    if (digest !== entry.hash) {
      await fs.promises.rm(temporary, { force: true });
      throw new Error(`备份对象校验失败：${entry.path}`);
    }
    await fs.promises.rename(temporary, destination);
  };
  const materializeRestoreEntry = async (target, entry, destination, task) => {
    await assertNoReparseAncestorsBeforeCreate(path.dirname(destination));
    const current = await fs.promises.lstat(destination).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (current) {
      if (!current.isFile() || current.isSymbolicLink() || current.size !== Number(entry.size) || await sha256File(destination) !== entry.hash) {
        const error = new Error(`恢复目标与备份对象冲突：${entry.path}`); error.code = 'RESTORE_TARGET_CONFLICT'; throw error;
      }
      return { adopted: true };
    }
    await materialize(target, entry, destination, task);
    if (await sha256File(destination) !== entry.hash) throw new Error(`恢复对象发布后哈希校验失败：${entry.path}`);
    return { adopted: false };
  };

  const externalTargetKey = value => {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
  };

  const restoredExternalLinkEntries = (restored, shortcutPaths) => {
    if (!shell?.readShortcutLink || !restored?.links || typeof restored.links !== 'object') return {};
    const scoped = {};
    for (const shortcutPath of shortcutPaths) {
      if (path.extname(shortcutPath).toLowerCase() !== '.lnk') continue;
      const stat = fs.lstatSync(shortcutPath, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      let details;
      try { details = shell.readShortcutLink(shortcutPath); }
      catch { continue; }
      const description = String(details?.description || '');
      const kind = description.startsWith(MANAGED_EXTERNAL_FOLDER_PREFIX) ? 'folder'
        : description.startsWith(MANAGED_EXTERNAL_FILE_PREFIX) ? 'file' : '';
      const markerIndex = description.lastIndexOf(MANAGED_EXTERNAL_ID_MARKER);
      const linkId = markerIndex >= 0 ? description.slice(markerIndex + MANAGED_EXTERNAL_ID_MARKER.length).trim() : '';
      const registered = linkId ? restored.links[linkId] : null;
      const shortcutTarget = String(details?.target || '').trim();
      const registeredTarget = String(registered?.target || '').trim();
      if (!kind || !registered || registered.kind !== kind || !path.isAbsolute(shortcutTarget) || !path.isAbsolute(registeredTarget)) continue;
      if (externalTargetKey(shortcutTarget) !== externalTargetKey(registeredTarget)) continue;
      scoped[linkId] = registered;
    }
    return scoped;
  };

  const mergeExternalLinkRegistry = async (target, manifest, temporaryRoot, shortcutPaths, task) => {
    const externalLinksEntry = manifest.files.find(entry => entry.scope === 'app-config' && entry.path === 'managed-external-links.json');
    const registryPath = getManagedExternalLinkRegistryPath?.();
    if (!externalLinksEntry || !registryPath) return false;
    const temporaryRegistry = path.join(temporaryRoot, `.photoflow-restored-external-links-${crypto.randomUUID()}.json`);
    await materialize(target, externalLinksEntry, temporaryRegistry, task);
    try {
      const restored = JSON.parse(await fs.promises.readFile(temporaryRegistry, 'utf8'));
      const current = await fs.promises.readFile(registryPath, 'utf8').then(value => {
        try { return JSON.parse(value); }
        catch { return { version: 1, links: {} }; }
      }, () => ({ version: 1, links: {} }));
      const restoredLinks = restoredExternalLinkEntries(restored, shortcutPaths);
      if (!Object.keys(restoredLinks).length) return false;
      const merged = { version: 1, links: { ...restoredLinks, ...(current?.links || {}) } };
      await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
      const nextPath = `${registryPath}.restore-${crypto.randomUUID()}.tmp`;
      const backupPath = `${registryPath}.restore-${crypto.randomUUID()}.backup`;
      await fs.promises.writeFile(nextPath, JSON.stringify(merged), { encoding: 'utf8', flag: 'wx' });
      try {
        if (await exists(registryPath)) await fs.promises.rename(registryPath, backupPath);
        await fs.promises.rename(nextPath, registryPath);
        await fs.promises.rm(backupPath, { force: true });
      } catch (error) {
        if (!await exists(registryPath) && await exists(backupPath)) await fs.promises.rename(backupPath, registryPath);
        throw error;
      } finally {
        await fs.promises.rm(nextPath, { force: true });
        await fs.promises.rm(backupPath, { force: true });
      }
      return true;
    } finally {
      await fs.promises.rm(temporaryRegistry, { force: true });
    }
  };

  const restoreWorkspace = async (workspaceRoot, snapshot, targetRoot, resumeTask = null) => {
    const config = await configMutationService.read();
    const target = String(config?.backup?.targetPath || '').trim();
    if (!isApprovedTarget(target)) throw new Error('备份位置未经授权');
    const destination = path.resolve(targetRoot);
    if (workspaceRoot && inside(path.resolve(workspaceRoot), destination)) throw new Error('恢复位置不能位于当前工作区内部');
    const existing = await fs.promises.readdir(destination).catch(error => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const incompleteMarker = path.join(destination, '.photoflow-restore-incomplete');
    const onlyUnboundIdentityMarker = existing.length > 0 && existing.every(name => name === '.photoflow-workspace-id');
    if (existing.length && !onlyUnboundIdentityMarker && !(resumeTask?.id && await exists(incompleteMarker))) throw new Error('请选择一个空文件夹作为恢复位置');
    const manifest = await manifestFor(target, snapshot);
    const componentRestorePlan = preflightComponentRestore(manifest, 'workspace');
    const restoreSessionId = String(resumeTask?.metadata?.restoreSessionId || resumeTask?.checkpoint?.restoreSessionId || crypto.randomUUID());
    const retryRestore = previous => restoreWorkspace(workspaceRoot, snapshot, destination, { id: previous?.id, metadata: previous?.metadata || {}, checkpoint: { ...(previous?.checkpoint || {}), restoreSessionId }, progress: 0 });
    const run = () => backgroundTasks.run({
      ...(resumeTask?.id ? { id: resumeTask.id } : {}),
      type: 'workspace-restore',
      title: '恢复工作区',
      dedupeKey: `workspace-restore:${destination}`,
      cancellable: true,
      resources: [destination, target],
      resumable: true,
      checkpoint: resumeTask?.checkpoint,
      progress: resumeTask?.progress,
      metadata: { workspacePath: workspaceRoot ? path.resolve(workspaceRoot) : '', snapshotId: snapshot, targetPath: destination, restoreSessionId },
      resumeFactory: taskSnapshot => restoreWorkspace(workspaceRoot, snapshot, destination, taskSnapshot),
    }, async task => {
      await verifyComponentRestoreSources(target, manifest, componentRestorePlan, task);
      const savedCheckpoint = task.getCheckpoint() || {};
      const formalPlanExists = Boolean(await fs.promises.lstat(incompleteMarker).catch(() => null));
      let plannedRestore = await fs.promises.readFile(incompleteMarker, 'utf8').then(value => { try { return JSON.parse(value); } catch { return {}; } }, () => ({}));
      if (formalPlanExists && (plannedRestore.schemaVersion !== 1 || plannedRestore.state !== 'planned' || !/^[a-f0-9]{24,64}$/.test(String(plannedRestore.workspaceId || ''))
        || plannedRestore.snapshotId !== snapshot || plannedRestore.restoreSessionId !== restoreSessionId || path.resolve(String(plannedRestore.destinationRoot || '')) !== destination)) { const error = new Error('正式恢复计划标记无效或冲突'); error.code = 'WORKSPACE_STORAGE_KEY_CONFLICT'; throw error; }
      let claimedPlanPath = '';
      if (!plannedRestore.workspaceId) {
        const candidates = [];
        for (const name of (await fs.promises.readdir(path.dirname(destination)).catch(() => [])).filter(name => /^\.pfr-[a-f0-9-]+\.next$/i.test(name))) {
          const candidatePath = path.join(path.dirname(destination), name);
          const value = await fs.promises.readFile(candidatePath, 'utf8').then(text => { try { return JSON.parse(text); } catch { return null; } }, () => null);
          if (value?.destinationRoot && path.resolve(value.destinationRoot) === destination) {
            if (value.schemaVersion !== 1 || value.state !== 'planned' || value.snapshotId !== snapshot || value.restoreSessionId !== restoreSessionId || !/^[a-f0-9]{24,64}$/.test(String(value.workspaceId || ''))) { const error = new Error('恢复计划临时文件无效或冲突'); error.code = 'WORKSPACE_STORAGE_KEY_CONFLICT'; throw error; }
            candidates.push({ path: candidatePath, value });
          }
        }
        if (candidates.length > 1) { const error = new Error('存在多个匹配的恢复计划临时文件'); error.code = 'WORKSPACE_STORAGE_KEY_CONFLICT'; throw error; }
        if (candidates.length === 1) { plannedRestore = candidates[0].value; claimedPlanPath = candidates[0].path; }
      }
      const newId = String(savedCheckpoint.newWorkspaceId || plannedRestore.workspaceId || crypto.randomUUID().replaceAll('-', ''));
      await assertNoReparseAncestorsBeforeCreate(destination);
      await fs.promises.mkdir(destination, { recursive: true });
      if (plannedRestore.workspaceId && (plannedRestore.workspaceId !== newId || plannedRestore.snapshotId !== snapshot || plannedRestore.restoreSessionId !== restoreSessionId
        || path.resolve(String(plannedRestore.destinationRoot || '')) !== destination)) { const error = new Error('恢复断点 identity 与当前任务冲突'); error.code = 'WORKSPACE_STORAGE_KEY_CONFLICT'; throw error; }
      if (claimedPlanPath) await fs.promises.rename(claimedPlanPath, incompleteMarker);
      else if (!plannedRestore.workspaceId) {
        const plannedPath = path.join(path.dirname(destination), `.pfr-${crypto.randomUUID()}.next`);
        await fs.promises.writeFile(plannedPath, JSON.stringify({ schemaVersion: 1, state: 'planned', destinationRoot: destination, workspaceId: newId, snapshotId: snapshot, restoreSessionId, taskId: task.id }), { encoding: 'utf8', flag: 'wx' });
        await fs.promises.rename(plannedPath, incompleteMarker);
      }
      if (bindWorkspaceStorageKeyForRestore) await bindWorkspaceStorageKeyForRestore(destination, newId);
      else {
        const marker = markerPath(destination); const current = await fs.promises.readFile(marker, 'utf8').catch(() => '');
        if (current.trim() && current.trim() !== newId) { const error = new Error('恢复目标 workspace identity 冲突'); error.code = 'WORKSPACE_STORAGE_KEY_CONFLICT'; throw error; }
        if (!current.trim()) await fs.promises.writeFile(marker, `${newId}\n`, { encoding: 'utf8', flag: 'wx' });
      }
      task.saveCheckpoint({ ...savedCheckpoint, version: 1, phase: 'identity-bound', newWorkspaceId: newId, restoreSessionId }, 2, '已绑定恢复工作区 identity');
      const newDataRoot = getWorkspaceDataRootForKey ? getWorkspaceDataRootForKey(newId) : getWorkspaceDataRoot(destination);
      const componentEntries = manifest.files.filter(item => item.scope === 'component-storage' && !isComponentHostControlStoragePath(item.path));
      const componentStorageRoot = path.join(newDataRoot, 'components');
      const completedWorkspace = new Set(Array.isArray(savedCheckpoint.completedWorkspace) ? savedCheckpoint.completedWorkspace : []);
      const completedData = new Set(Array.isArray(savedCheckpoint.completedData) ? savedCheckpoint.completedData : []);
      const completedComponents = new Set(Array.isArray(savedCheckpoint.completedComponents) ? savedCheckpoint.completedComponents : []);
      return restoreOwnedComponentData({
        target, manifest, mode: 'workspace', task, plan: componentRestorePlan,
        sourceWorkspace: { root: manifest.workspace.root, dataRoot: manifest.workspace.dataRoot || '' },
        targetWorkspace: { root: destination, dataRoot: newDataRoot },
        beforeTargetWrite: async () => undefined,
        continuation: async componentRestore => {
      for (const entry of componentEntries) {
        if (componentRestore.handled.has(`${entry.scope}\0${entry.path}`)) continue;
        const entryDestination = safeDestination(componentStorageRoot, entry.path);
        await materializeRestoreEntry(target, entry, entryDestination, task);
        completedComponents.add(entry.path);
        task.saveCheckpoint({ ...savedCheckpoint, version: 1, phase: 'component-data', newWorkspaceId: newId, completedWorkspace: [...completedWorkspace], completedData: [...completedData], completedComponents: [...completedComponents] }, 3, `正在恢复组件数据 ${completedComponents.size}/${componentEntries.length}`);
      }
      const workspaceEntries = manifest.files.filter(item => item.scope === 'workspace' && item.path !== '.photoflow-workspace-id');
      task.saveCheckpoint({ ...savedCheckpoint, version: 1, phase: 'preparing', newWorkspaceId: newId, completedWorkspace: [...completedWorkspace], completedData: [...completedData], completedComponents: [...completedComponents] }, Math.max(3, Number(resumeTask?.progress) || 1), '正在准备恢复工作区');
      let completed = 0;
      for (const entry of workspaceEntries) {
        const entryDestination = safeDestination(destination, entry.path);
        await materializeRestoreEntry(target, entry, entryDestination, task);
        completedWorkspace.add(entry.path);
        completed += 1;
        const progress = 5 + completed / Math.max(1, workspaceEntries.length) * 70;
        task.saveCheckpoint({ ...savedCheckpoint, version: 1, phase: 'workspace-files', newWorkspaceId: newId, completedWorkspace: [...completedWorkspace], completedData: [...completedData], completedComponents: [...completedComponents] }, progress, `正在恢复项目文件 ${completed}/${workspaceEntries.length}`, { completedFiles: completed, totalFiles: workspaceEntries.length });
      }
      const materializedArchiveIds = new Set(manifest.materializedArchiveProjectIds || []);
      for (const project of manifest.projects || []) {
        const archivePath = String(project.extra?.archive?.path || '');
        if (!archivePath || materializedArchiveIds.has(project.id) || !path.isAbsolute(archivePath)) continue;
        const linkPath = safeDestination(destination, project.relativePath);
        if (await fs.promises.lstat(linkPath).catch(() => null)) continue;
        await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
        await fs.promises.symlink(archivePath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const dataEntries = manifest.files.filter(item => item.scope === 'workspace-data');
      for (const [index, entry] of dataEntries.entries()) {
        const entryDestination = safeDestination(newDataRoot, entry.path);
        await materializeRestoreEntry(target, entry, entryDestination, task);
        completedData.add(entry.path);
        const progress = 75 + (index + 1) / Math.max(1, dataEntries.length) * 10;
        task.saveCheckpoint({ ...savedCheckpoint, version: 1, phase: 'workspace-data', newWorkspaceId: newId, completedWorkspace: [...completedWorkspace], completedData: [...completedData], completedComponents: [...completedComponents] }, progress, `正在恢复内部数据 ${index + 1}/${dataEntries.length}`);
      }
      await withWorkspaceRecoveryLease({
        workspaceRoot: destination,
        domains: ['core', 'operations', 'media', 'versioning'],
        signal: task.signal,
        deadlineAt: Date.now() + 30 * 60 * 1000,
      }, async () => {
        for (const [domain, getter] of [
          ['operations', getWorkspaceOperationsDatabasePath],
          ['media', getWorkspaceMediaDatabasePath],
          ['versioning', getWorkspaceVersioningDatabasePath],
        ]) {
          const entry = manifest.files.find(item => item.scope === 'domain-database' && item.path === `${domain}.sqlite3`);
          if (!entry || !getter) continue;
          const portable = path.join(destination, `.photoflow-${domain}-restore.sqlite3`);
          try {
            await materialize(target, entry, portable, task);
            await runRecoveryPythonAction('domain_recovery.py', [
              'restore-workspace', '--domain', domain, '--source', portable, '--destination', getter(destination),
              '--old-root', manifest.workspace.root, '--new-root', destination,
              '--old-data-root', manifest.workspace.dataRoot || '', '--new-data-root', newDataRoot,
            ], 30 * 60 * 1000);
          } finally {
            await fs.promises.rm(portable, { force: true });
          }
        }
        const portableCore = path.join(destination, `.photoflow-core-restore-${crypto.randomUUID()}.sqlite3`);
        try {
          await materialize(target, { ...manifest.database, path: 'workspace.sqlite3' }, portableCore, task);
          await runRecoveryPythonAction('backup_db.py', [
            'restore-workspace', '--source', portableCore, '--destination', getWorkspaceDatabasePath(destination),
            '--old-root', manifest.workspace.root, '--new-root', destination,
            '--old-data-root', manifest.workspace.dataRoot || '', '--new-data-root', newDataRoot,
            '--materialized-archive-project-ids', JSON.stringify(manifest.materializedArchiveProjectIds || []),
          ], 30 * 60 * 1000);
        } finally { await fs.promises.rm(portableCore, { force: true }); }
      });
      const restoredConfigEntry = manifest.files.find(entry => entry.scope === 'app-config' && entry.path === 'photoflow_config.json');
      let restoredConfig = {};
      if (restoredConfigEntry) {
        const temporaryConfig = path.join(destination, '.photoflow-restored-config.json');
        await materialize(target, restoredConfigEntry, temporaryConfig, task);
        try {
          const parsed = JSON.parse(await fs.promises.readFile(temporaryConfig, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) restoredConfig = parsed;
        }
        finally { await fs.promises.rm(temporaryConfig, { force: true }); }
      }
      const birthdaysEntry = manifest.files.find(entry => entry.scope === 'app-config' && entry.path === 'birthdays.json');
      if (birthdaysEntry) await materialize(target, birthdaysEntry, getUserBirthdaysPath(), task);
      await mergeExternalLinkRegistry(
        target,
        manifest,
        destination,
        workspaceEntries.filter(entry => path.extname(entry.path).toLowerCase() === '.lnk').map(entry => safeDestination(destination, entry.path)),
        task,
      );
      const savedConfig = await configMutationService.mutate(currentConfig => configMutationService.mergeRestoredConfig(currentConfig, restoredConfig, destination));
      task.report(100, '工作区恢复完成');
      return { workspacePath: destination, savedConfig, componentRestore: componentRestore.results };
        },
      });
    }, retryRestore);
    const execution = await run();
    if (execution.task?.state === 'completed' && backgroundTasks.flush?.() !== false) await fs.promises.rm(incompleteMarker, { force: true });
    return execution;
  };

  const restoreProject = async (workspaceRoot, snapshot, projectId, resumeTask = null) => {
    const config = readSavedConfig();
    const target = String(config?.backup?.targetPath || '').trim();
    if (!isApprovedTarget(target)) throw new Error('备份位置未经授权');
    const root = path.resolve(workspaceRoot);
    const manifest = await manifestFor(target, snapshot);
    const componentRestorePlan = preflightComponentRestore(manifest, 'project');
    const project = (manifest.projects || []).find(item => item.id === projectId);
    if (!project) throw new Error('备份快照中找不到该项目');
    const projectRoot = path.resolve(root, project.relativePath);
    if (!inside(root, projectRoot) || projectRoot === root) throw new Error('备份中的项目路径无效');
    const restoreSessionId = String(resumeTask?.metadata?.restoreSessionId || resumeTask?.checkpoint?.restoreSessionId || crypto.randomUUID());
    const markerKey = crypto.createHash('sha256').update([snapshot, project.id, restoreSessionId].join('\0')).digest('hex').slice(0, 32);
    const incompleteMarker = path.join(root, `.photoflow-project-restore-${markerKey}.incomplete`);
    const legacyMarker = /^[A-Za-z0-9_-]+$/.test(String(project.id || '')) ? path.join(root, `.photoflow-project-restore-${project.id}.incomplete`) : '';
    const hasResumeMarker = resumeTask?.id && (await exists(incompleteMarker) || (legacyMarker && await exists(legacyMarker)));
    if (await exists(projectRoot) && !hasResumeMarker) throw new Error('原项目位置已被占用，请先重命名现有目录');
    const run = () => backgroundTasks.run({
      ...(resumeTask?.id ? { id: resumeTask.id } : {}),
      type: 'project-restore',
      title: `恢复项目：${project.name}`,
      dedupeKey: `project-restore:${root}:${project.id}`,
      cancellable: true,
      resources: [projectRoot, target],
      resumable: true,
      checkpoint: resumeTask?.checkpoint,
      progress: resumeTask?.progress,
      metadata: { workspacePath: root, snapshotId: snapshot, projectId: project.id, projectName: project.name, restoreSessionId },
      resumeFactory: taskSnapshot => restoreProject(root, snapshot, project.id, taskSnapshot),
    }, async task => {
      await verifyComponentRestoreSources(target, manifest, componentRestorePlan, task);
      const savedCheckpoint = task.getCheckpoint() || {};
      const completedProject = new Set(Array.isArray(savedCheckpoint.completedProject) ? savedCheckpoint.completedProject : []);
      const completedData = new Set(Array.isArray(savedCheckpoint.completedData) ? savedCheckpoint.completedData : []);
      const newDataRoot = getWorkspaceDataRoot(root);
      return restoreOwnedComponentData({
        target, manifest, mode: 'project', task, plan: componentRestorePlan,
        sourceWorkspace: { root: manifest.workspace.root, dataRoot: manifest.workspace.dataRoot || '' },
        targetWorkspace: { root, dataRoot: newDataRoot },
        project: { id: project.id, name: project.name, sourceName: project.name, targetName: project.name, sourceStatus: project.status, targetStatus: project.status, sourceRelativePath: project.relativePath, targetRelativePath: project.relativePath },
        beforeTargetWrite: async () => {
          await assertNoReparseAncestorsBeforeCreate(projectRoot);
          const projectStat = await fs.promises.lstat(projectRoot).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
          if (projectStat && (!projectStat.isDirectory() || projectStat.isSymbolicLink()
            || !inside(await fs.promises.realpath(root), await fs.promises.realpath(projectRoot)))) { const error = new Error('项目恢复目标包含链接或越过工作区'); error.code = 'COMPONENT_RESTORE_TARGET_UNSAFE'; throw error; }
          const marker = { schemaVersion: 1, snapshotId: snapshot, projectId: project.id, restoreSessionId, taskId: task.id };
          const currentMarker = await fs.promises.readFile(incompleteMarker, 'utf8').then(value => { try { return JSON.parse(value); } catch { return null; } }, () => null);
          if (currentMarker && (currentMarker.snapshotId !== snapshot || currentMarker.projectId !== project.id || currentMarker.restoreSessionId !== restoreSessionId || currentMarker.taskId !== task.id)) throw new Error('项目恢复标记与当前任务不匹配');
          if (!currentMarker) {
            const temporaryMarker = `${incompleteMarker}.${crypto.randomUUID()}.tmp`;
            await fs.promises.writeFile(temporaryMarker, JSON.stringify(marker), { encoding: 'utf8', flag: 'wx' });
            await durableSync(temporaryMarker);
            await fs.promises.rename(temporaryMarker, incompleteMarker);
            await durableSyncDirectory(root);
          }
        },
        continuation: async componentRestore => {
      const prefix = normalizeKey(project.relativePath).replace(/\/$/, '') + '/';
      const projectEntries = manifest.files.filter(item => item.scope === 'workspace' && item.projectIds?.includes(project.id) && (item.path === prefix.slice(0, -1) || item.path.startsWith(prefix)));
      for (const [index, entry] of projectEntries.entries()) {
        const relative = entry.path.slice(prefix.length);
        const entryDestination = safeDestination(projectRoot, relative);
        await materializeRestoreEntry(target, entry, entryDestination, task);
        completedProject.add(entry.path);
        const progress = 5 + (index + 1) / Math.max(1, projectEntries.length) * 70;
        task.saveCheckpoint({ ...savedCheckpoint, version: 1, phase: 'project-files', completedProject: [...completedProject], completedData: [...completedData] }, progress, `正在恢复项目文件 ${index + 1}/${projectEntries.length}`);
      }
      const archivePath = String(project.extra?.archive?.path || '');
      if (archivePath && !(manifest.materializedArchiveProjectIds || []).includes(project.id) && path.isAbsolute(archivePath)
        && !await fs.promises.lstat(projectRoot).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
        await fs.promises.mkdir(path.dirname(projectRoot), { recursive: true });
        await fs.promises.symlink(archivePath, projectRoot, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const dataEntries = manifest.files.filter(item => item.scope === 'workspace-data' && item.projectIds?.includes(project.id));
      for (const [index, entry] of dataEntries.entries()) {
        const entryDestination = safeDestination(newDataRoot, entry.path);
        await materializeRestoreEntry(target, entry, entryDestination, task);
        completedData.add(entry.path);
        const progress = 76 + (index + 1) / Math.max(1, dataEntries.length) * 9;
        task.saveCheckpoint({ ...savedCheckpoint, version: 1, phase: 'project-data', completedProject: [...completedProject], completedData: [...completedData] }, progress, `正在恢复项目内部数据 ${index + 1}/${dataEntries.length}`);
      }
      const portableDomainRoot = path.join(newDataRoot, 'domain-restore', `.photoflow-project-domain-restore-${crypto.randomUUID()}`);
      const mediaEntry = manifest.files.find(item => item.scope === 'domain-database' && item.path === 'media.sqlite3');
      const versioningEntry = manifest.files.find(item => item.scope === 'domain-database' && item.path === 'versioning.sqlite3');
      const portableCore = path.join(portableDomainRoot, 'core.sqlite3');
      const portableMedia = mediaEntry ? path.join(portableDomainRoot, 'media.sqlite3') : '';
      const portableVersioning = versioningEntry ? path.join(portableDomainRoot, 'versioning.sqlite3') : '';
      const recoveryJournal = path.join(newDataRoot, 'domain-restore', `project-${markerKey}.journal.json`);
      const existingRecovery = await fs.promises.readFile(recoveryJournal, 'utf8').then(JSON.parse, () => null);
      if (existingRecovery && (existingRecovery.schemaVersion !== 1 || existingRecovery.snapshotId !== snapshot || existingRecovery.projectId !== project.id
        || existingRecovery.restoreSessionId !== restoreSessionId || existingRecovery.taskId !== task.id)) throw new Error('项目数据库恢复日志与当前任务不匹配');
      await fs.promises.mkdir(portableDomainRoot, { recursive: true });
      let preservePortableDomainRoot = false;
      try {
      await materialize(target, { ...manifest.database, path: 'workspace.sqlite3' }, portableCore, task);
      if (mediaEntry) await materialize(target, mediaEntry, portableMedia, task);
      if (versioningEntry) await materialize(target, versioningEntry, portableVersioning, task);
      if (existingRecovery?.state !== 'committed') {
      await withWorkspaceRecoveryLease({
        workspaceRoot: root,
        domains: ['core', 'media', 'versioning'],
        signal: task.signal,
        deadlineAt: Date.now() + 30 * 60 * 1000,
      }, async () => {
        if (['applying', 'rollbackPending'].includes(existingRecovery?.state)) {
          const attempted = Array.isArray(existingRecovery.attemptedDomains) ? existingRecovery.attemptedDomains : [];
          const preimages = existingRecovery.preimages || {};
          if (attempted.includes('versioning')) await restoreSqlitePreimage(preimages.versioning, newDataRoot);
          if (attempted.includes('media')) await restoreSqlitePreimage(preimages.media, newDataRoot);
          if (attempted.includes('core')) await restoreSqlitePreimage(preimages.core, newDataRoot);
          await writeDurableJsonReplace(recoveryJournal, { ...existingRecovery, state: 'rolled-back', recoveredAt: Date.now() });
          const recoveredPortableRoot = path.dirname(path.dirname(preimages.core.files[0].path));
          if (inside(root, recoveredPortableRoot) && path.basename(recoveredPortableRoot).startsWith('.photoflow-project-domain-restore-')) await fs.promises.rm(recoveredPortableRoot, { recursive: true, force: true });
        }
        const preimageRoot = path.join(portableDomainRoot, 'preimage');
        await fs.promises.mkdir(preimageRoot, { recursive: true });
        const preimageCore = path.join(preimageRoot, 'core.sqlite3');
        const preimageMedia = mediaEntry && getWorkspaceMediaDatabasePath ? path.join(preimageRoot, 'media.sqlite3') : '';
        const preimageVersioning = versioningEntry && mediaEntry && getWorkspaceVersioningDatabasePath ? path.join(preimageRoot, 'versioning.sqlite3') : '';
        const corePreimage = await captureSqlitePreimage(getWorkspaceDatabasePath(root), preimageRoot, path.basename(preimageCore));
        const mediaPreimage = preimageMedia ? await captureSqlitePreimage(getWorkspaceMediaDatabasePath(root), preimageRoot, path.basename(preimageMedia)) : null;
        const versioningPreimage = preimageVersioning ? await captureSqlitePreimage(getWorkspaceVersioningDatabasePath(root), preimageRoot, path.basename(preimageVersioning)) : null;
        const preimages = {
          core: corePreimage,
          ...(mediaPreimage ? { media: mediaPreimage } : {}),
          ...(versioningPreimage ? { versioning: versioningPreimage } : {}),
        };
        const journalBase = { schemaVersion: 1, snapshotId: snapshot, projectId: project.id, restoreSessionId, taskId: task.id,
          domains: ['core', ...(preimageMedia ? ['media'] : []), ...(preimageVersioning ? ['versioning'] : [])], preimages };
        await writeDurableJsonReplace(recoveryJournal, { ...journalBase, state: 'prepared', completedDomains: [] });
        const completedDomains = [];
        const attemptedDomains = [];
        try {
          attemptedDomains.push('core'); await writeDurableJsonReplace(recoveryJournal, { ...journalBase, state: 'applying', attemptedDomains, completedDomains });
          await runRecoveryPythonAction('backup_db.py', [
          'restore-project', '--source', portableCore, '--destination', getWorkspaceDatabasePath(root),
          '--project-id', project.id, '--old-root', manifest.workspace.root, '--new-root', root,
          '--target-relative-path', project.relativePath, '--old-data-root', manifest.workspace.dataRoot || '', '--new-data-root', newDataRoot,
          '--materialized-archive-project-ids', JSON.stringify(manifest.materializedArchiveProjectIds || []),
          ], 30 * 60 * 1000);
          completedDomains.push('core'); await writeDurableJsonReplace(recoveryJournal, { ...journalBase, state: 'applying', attemptedDomains, completedDomains });
        if (mediaEntry && getWorkspaceMediaDatabasePath) {
          attemptedDomains.push('media'); await writeDurableJsonReplace(recoveryJournal, { ...journalBase, state: 'applying', attemptedDomains, completedDomains });
          await runRecoveryPythonAction('domain_recovery.py', [
            'restore-project', '--domain', 'media', '--source', portableMedia,
            '--destination', getWorkspaceMediaDatabasePath(root), '--project-id', project.id,
            ...(versioningEntry ? ['--peer-source', portableVersioning] : []),
            '--old-root', manifest.workspace.root, '--new-root', root,
            '--old-data-root', manifest.workspace.dataRoot || '', '--new-data-root', newDataRoot,
          ], 30 * 60 * 1000);
          completedDomains.push('media'); await writeDurableJsonReplace(recoveryJournal, { ...journalBase, state: 'applying', attemptedDomains, completedDomains });
        }
        if (versioningEntry && mediaEntry && getWorkspaceVersioningDatabasePath) {
          attemptedDomains.push('versioning'); await writeDurableJsonReplace(recoveryJournal, { ...journalBase, state: 'applying', attemptedDomains, completedDomains });
          await runRecoveryPythonAction('domain_recovery.py', [
            'restore-project', '--domain', 'versioning', '--source', portableVersioning,
            '--destination', getWorkspaceVersioningDatabasePath(root), '--project-id', project.id,
            '--peer-source', portableMedia,
            '--old-root', manifest.workspace.root, '--new-root', root,
            '--old-data-root', manifest.workspace.dataRoot || '', '--new-data-root', newDataRoot,
          ], 30 * 60 * 1000);
          completedDomains.push('versioning'); await writeDurableJsonReplace(recoveryJournal, { ...journalBase, state: 'applying', attemptedDomains, completedDomains });
        }
          await writeDurableJsonReplace(recoveryJournal, { ...journalBase, state: 'committed', attemptedDomains, completedDomains });
        } catch (error) {
          const rollbackErrors = [];
          const rollback = async worker => { try { await worker(); } catch (rollbackError) { rollbackErrors.push(rollbackError); } };
          if (versioningPreimage && attemptedDomains.includes('versioning')) await rollback(() => restoreSqlitePreimage(versioningPreimage, newDataRoot));
          if (mediaPreimage && attemptedDomains.includes('media')) await rollback(() => restoreSqlitePreimage(mediaPreimage, newDataRoot));
          if (attemptedDomains.includes('core')) await rollback(() => restoreSqlitePreimage(corePreimage, newDataRoot));
          preservePortableDomainRoot = rollbackErrors.length > 0;
          await writeDurableJsonReplace(recoveryJournal, { ...journalBase, state: rollbackErrors.length ? 'rollbackPending' : 'rolled-back', attemptedDomains, completedDomains });
          if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], `项目数据库恢复失败且 preimage 回滚未完成：${error.message || String(error)}`);
          throw error;
        }
      });
      }
      } finally { if (!preservePortableDomainRoot) await fs.promises.rm(portableDomainRoot, { recursive: true, force: true }); }
      await mergeExternalLinkRegistry(
        target,
        manifest,
        root,
        projectEntries.filter(entry => path.extname(entry.path).toLowerCase() === '.lnk').map(entry => safeDestination(projectRoot, entry.path.slice(prefix.length))),
        task,
      );
      await fs.promises.rm(recoveryJournal, { force: true });
      task.report(100, '项目恢复完成');
      return { project, componentRestore: componentRestore.results };
        },
      });
    }, run);
    const execution = await run();
    if (execution.task?.state === 'completed' && backgroundTasks.flush?.() !== false) {
      await fs.promises.rm(incompleteMarker, { force: true });
      if (legacyMarker) await fs.promises.rm(legacyMarker, { force: true });
    }
    return execution;
  };

  const verify = async (workspaceRoot, snapshot, resumeTask = null) => {
    const config = readSavedConfig();
    const target = String(config?.backup?.targetPath || '').trim();
    if (!isApprovedTarget(target)) throw new Error('备份位置未经授权');
    const manifest = await manifestFor(target, snapshot);
    validateComponentBackupMetadata(manifest);
    const run = () => backgroundTasks.run({
      ...(resumeTask?.id ? { id: resumeTask.id } : {}),
      type: 'backup-verify',
      title: '验证备份',
      dedupeKey: `backup-verify:${snapshot}`,
      cancellable: true,
      resources: [target],
      resumable: true,
      checkpoint: resumeTask?.checkpoint,
      progress: resumeTask?.progress,
      metadata: { workspacePath: path.resolve(workspaceRoot), snapshotId: snapshot },
      resumeFactory: taskSnapshot => verify(workspaceRoot, snapshot, taskSnapshot),
    }, async task => {
      const entries = [{ path: 'workspace.sqlite3', hash: manifest.database.hash }, ...manifest.files];
      for (const [index, entry] of entries.entries()) {
        task.throwIfCancelled();
        const source = objectPath(target, entry.hash);
        const stat = await fs.promises.lstat(source).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (!stat || !stat.isFile() || stat.isSymbolicLink() || (entry.size != null && stat.size !== Number(entry.size))) throw new Error(`备份对象缺失或大小无效：${entry.path}`);
        if (await sha256File(source) !== entry.hash) throw new Error(`备份对象校验失败：${entry.path}`);
        const progress = (index + 1) / entries.length * 100;
        task.saveCheckpoint({ version: 1, phase: 'verifying', nextIndex: index + 1 }, progress, `正在验证 ${index + 1}/${entries.length} 个文件`);
      }
      return { verifiedAt: Date.now(), files: entries.length };
    }, run);
    return run();
  };

  const runIfDue = async workspaceRoot => {
    const config = readSavedConfig();
    if (!config?.backup?.enabled || config.backup.automaticDaily === false) return { skipped: true };
    const current = await status(workspaceRoot);
    if (current.latestAt && Date.now() - current.latestAt < DAY_MS) return { skipped: true };
    return runBackup(workspaceRoot, 'daily');
  };

  const domainPath = (workspaceRoot, domain) => ({
    media: getWorkspaceMediaDatabasePath,
    versioning: getWorkspaceVersioningDatabasePath,
    operations: getWorkspaceOperationsDatabasePath,
  })[domain]?.(path.resolve(workspaceRoot));

  const verifyDomain = async (workspaceRoot, domain) => {
    const database = domainPath(workspaceRoot, domain);
    if (!database) throw new Error(`不支持的业务域：${domain}`);
    return runPythonJsonAction('domain_recovery.py', ['verify', '--domain', domain, '--destination', database], 10 * 60 * 1000);
  };

  const runDomainBackup = async (workspaceRoot, domain) => {
    const root = path.resolve(workspaceRoot);
    const database = domainPath(root, domain);
    if (!database) throw new Error(`不支持的业务域：${domain}`);
    const destination = path.join(getWorkspaceDataRoot(root), 'domain-backups', domain, `${Date.now()}.sqlite3`);
    const result = await runPythonJsonAction('domain_recovery.py', [
      'snapshot', '--domain', domain, '--source', database, '--destination', destination,
    ], 30 * 60 * 1000);
    return { ...result, domain, path: destination };
  };

  const restoreDomain = async (workspaceRoot, snapshot, domain) => {
    const root = path.resolve(workspaceRoot);
    const database = domainPath(root, domain);
    if (!database) throw new Error(`不支持的业务域：${domain}`);
    const config = readSavedConfig();
    const target = String(config?.backup?.targetPath || '').trim();
    if (!isApprovedTarget(target)) throw new Error('备份位置未经授权');
    const manifest = await manifestFor(target, snapshot);
    const entry = manifest.files.find(item => item.scope === 'domain-database' && item.path === `${domain}.sqlite3`);
    if (!entry) throw new Error(`该快照不包含 ${domain} 业务域`);
    const portable = path.join(getWorkspaceDataRoot(root), 'domain-restore', `${domain}-${crypto.randomUUID()}.sqlite3`);
    await materialize(target, entry, portable, { throwIfCancelled: () => undefined });
    try {
      return await withWorkspaceRecoveryLease({
        workspaceRoot: root,
        domains: [domain],
        deadlineAt: Date.now() + 30 * 60 * 1000,
      }, async () => {
        try {
          return await runRecoveryPythonAction('domain_recovery.py', [
            'restore-workspace', '--domain', domain, '--source', portable, '--destination', database,
            '--old-root', manifest.workspace.root, '--new-root', root,
            '--old-data-root', manifest.workspace.dataRoot || '', '--new-data-root', getWorkspaceDataRoot(root),
          ], 30 * 60 * 1000);
        } finally {
          await fs.promises.rm(portable, { force: true });
        }
      });
    } finally {
      await fs.promises.rm(portable, { force: true }).catch(() => undefined);
    }
  };

  const resetDomain = async (workspaceRoot, domain) => {
    if (domain === 'versioning') throw new Error('版本域不能直接重置，请从快照恢复');
    const database = domainPath(workspaceRoot, domain);
    if (!database) throw new Error(`不支持的业务域：${domain}`);
    return withWorkspaceRecoveryLease({
      workspaceRoot,
      domains: [domain],
      deadlineAt: Date.now() + 30 * 60 * 1000,
    }, () => runRecoveryPythonAction('domain_recovery.py', ['reset', '--domain', domain, '--destination', database], 30 * 60 * 1000));
  };

  backgroundTasks.registerTypeResumeFactory?.('workspace-backup', task => runBackup(task.metadata?.workspacePath, task.metadata?.reason || 'manual', task));
  backgroundTasks.registerTypeResumeFactory?.('workspace-restore', task => restoreWorkspace(task.metadata?.workspacePath || '', task.metadata?.snapshotId, task.metadata?.targetPath, task));
  backgroundTasks.registerTypeResumeFactory?.('project-restore', task => restoreProject(task.metadata?.workspacePath, task.metadata?.snapshotId, task.metadata?.projectId, task));
  backgroundTasks.registerTypeResumeFactory?.('backup-verify', task => verify(task.metadata?.workspacePath, task.metadata?.snapshotId, task));
  backgroundTasks.registerTypeRestartFactory?.('backup-cleanup', task => cleanup(task.metadata?.workspacePath, task));

  return { approveTarget, isApprovedTarget, runBackup, runDomainBackup, runIfDue, status, restoreWorkspace, restoreProject, restoreDomain, resetDomain, verify, verifyDomain, testConnection, spaceStatus, cleanup, withWorkspaceRecoveryLease };
};

module.exports = { createBackupService, safeDestination, STORE_DIRECTORY };
