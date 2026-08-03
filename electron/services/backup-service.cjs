const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

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

const createBackupService = context => {
  const {
    app,
    backgroundTasks,
    getConfigPath,
    getUserBirthdaysPath,
    getWorkspaceDatabasePath,
    getWorkspaceDataRoot,
    credentialService,
    readSavedConfig,
    runPythonJsonAction,
    writeLog,
  } = context;
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
    await fs.promises.mkdir(objectsRoot(target), { recursive: true });
    await fs.promises.mkdir(snapshotsRoot(target), { recursive: true });
    await fs.promises.mkdir(temporaryRoot(target), { recursive: true });
    const descriptor = path.join(storeRoot(target), 'store.json');
    if (!await exists(descriptor)) {
      const temporary = `${descriptor}.${crypto.randomUUID()}.tmp`;
      await fs.promises.writeFile(temporary, JSON.stringify({ formatVersion: STORE_FORMAT_VERSION, createdAt: Date.now(), product: 'PhotoFlow' }, null, 2), 'utf8');
      await fs.promises.rename(temporary, descriptor);
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

  const storeFile = async (target, sourcePath, task, progress, backupConfig = {}) => {
    const nas = isNasTarget(target);
    const retryDelays = [5000, 15000, 30000, 60000, 120000];
    let sourceMutationRetries = 0;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      task.throwIfCancelled();
      const before = await fs.promises.stat(sourcePath);
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
        const after = await fs.promises.stat(sourcePath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          await fs.promises.rm(temporary, { force: true });
          if (copied && progress) progress(-copied);
          if (sourceMutationRetries++ === 0) continue;
          throw new Error(`文件在备份期间持续变化：${sourcePath}`);
        }
        const digest = hash.digest('hex');
        const destination = objectPath(target, digest);
        if (!await exists(destination)) {
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          try { await fs.promises.rename(temporary, destination); }
          catch (error) {
            if (!await exists(destination)) throw error;
            await fs.promises.rm(temporary, { force: true });
          }
        } else await fs.promises.rm(temporary, { force: true });
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

  const listManifests = async target => {
    const root = snapshotsRoot(target);
    if (!await exists(root)) return [];
    const directories = await fs.promises.readdir(root, { withFileTypes: true });
    const manifests = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      try {
        const manifest = JSON.parse(await fs.promises.readFile(path.join(root, directory.name, 'manifest.json'), 'utf8'));
        if (manifest?.complete === true && manifest.formatVersion === SNAPSHOT_FORMAT_VERSION) manifests.push(manifest);
      } catch { /* incomplete snapshots are ignored */ }
    }
    return manifests.sort((left, right) => right.createdAt - left.createdAt);
  };

  const manifestFor = async (target, id) => {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new Error('备份快照标识无效');
    const manifest = JSON.parse(await fs.promises.readFile(path.join(snapshotsRoot(target), String(id), 'manifest.json'), 'utf8'));
    if (!manifest?.complete || manifest.formatVersion !== SNAPSHOT_FORMAT_VERSION) throw new Error('备份快照无效或尚未完成');
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

  const cleanupRetention = async (target, backupConfig, workspaceId) => {
    const allManifests = await listManifests(target);
    const workspaceManifests = allManifests.filter(manifest => manifest.workspace?.id === workspaceId);
    const retained = retainedSnapshotIds(workspaceManifests, backupConfig);
    let removedSnapshots = 0;
    for (const manifest of workspaceManifests) {
      if (!retained.has(manifest.id)) {
        await fs.promises.rm(path.join(snapshotsRoot(target), manifest.id), { recursive: true, force: true });
        removedSnapshots += 1;
      }
    }
    const referenced = new Set();
    for (const manifest of await listManifests(target)) {
      referenced.add(manifest.database.hash);
      for (const entry of manifest.files) referenced.add(entry.hash);
    }
    if (!await exists(objectsRoot(target))) return { removedSnapshots, removedObjects: 0, reclaimedBytes: 0 };
    let removedObjects = 0;
    let reclaimedBytes = 0;
    for (const prefix of await fs.promises.readdir(objectsRoot(target), { withFileTypes: true })) {
      if (!prefix.isDirectory()) continue;
      const directory = path.join(objectsRoot(target), prefix.name);
      for (const item of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (!item.isFile()) continue;
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

  const cleanup = async workspaceRoot => {
    const backupConfig = readSavedConfig()?.backup || {};
    const target = String(backupConfig.targetPath || '').trim();
    if (!target || !isApprovedTarget(target)) throw new Error('备份位置当前不可用');
    const root = path.resolve(workspaceRoot);
    const workspaceId = await readWorkspaceId(root);
    const run = () => backgroundTasks.run({
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

  const runBackup = async (workspaceRoot, reason = 'manual') => {
    const config = readSavedConfig();
    const backupConfig = config?.backup || {};
    const target = String(backupConfig.targetPath || '').trim();
    if (!backupConfig.enabled || !target) throw new Error('请先在设置中启用备份并选择备份位置');
    if (!isApprovedTarget(target)) throw new Error('备份位置需要通过系统文件夹选择器授权');
    const root = path.resolve(workspaceRoot);
    if (inside(root, target) || inside(target, root)) throw new Error('备份位置不能位于工作区内部，也不能包含工作区');
    const run = () => backgroundTasks.run({
      type: 'workspace-backup',
      title: '备份工作区',
      dedupeKey: `workspace-backup:${root}`,
      cancellable: true,
      resources: [root, target],
      metadata: { workspacePath: root, targetPath: target, reason },
    }, async task => {
      await ensureTargetConnection(target, backupConfig);
      await ensureStore(target);
      const id = snapshotId();
      const stage = path.join(temporaryRoot(target), `snapshot-${id}-${crypto.randomUUID()}`);
      await fs.promises.mkdir(stage, { recursive: true });
      const databaseSnapshot = path.join(stage, 'workspace.sqlite3');
      const liveDatabasePath = path.resolve(getWorkspaceDatabasePath(root));
      task.report(1, '正在创建数据库快照');
      const databaseInfo = await runPythonJsonAction('backup_db.py', ['snapshot', '--source', liveDatabasePath, '--destination', databaseSnapshot], 30 * 60 * 1000);
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
      const workspaceDataFiles = await collectFiles(workspaceDataRoot, 'workspace-data', (relative, item) => {
        const normalized = normalizeKey(relative);
        const first = normalized.split('/')[0];
        return (item.isDirectory() && ['thumbnails', 'backups'].includes(first))
          || normalized === databaseRelative
          || normalized === `${databaseRelative}-wal`
          || normalized === `${databaseRelative}-shm`;
      });
      const appFiles = [];
      for (const [relative, absolute] of [['photoflow_config.json', getConfigPath()], ['birthdays.json', getUserBirthdaysPath()]]) {
        if (await exists(absolute)) appFiles.push({ scope: 'app-config', relative, absolute });
      }
      const inputs = [...workspaceFiles, ...workspaceDataFiles, ...appFiles, { scope: 'database', relative: 'workspace.sqlite3', absolute: databaseSnapshot }];
      const totalBytes = (await Promise.all(inputs.map(item => fs.promises.stat(item.absolute).then(stat => stat.size)))).reduce((sum, size) => sum + size, 0);
      let copiedBytes = 0;
      let transferredBytes = 0;
      let reusedBytes = 0;
      let reusedFiles = 0;
      let completedFiles = 0;
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
        const previous = previousByInput.get(inputKey);
        const sourceStat = await fs.promises.stat(input.absolute);
        const canReuse = previous
          && validObjectHash(previous.hash)
          && Number(previous.size) === sourceStat.size
          && Math.abs(Number(previous.mtimeMs) - sourceStat.mtimeMs) < 1
          && await exists(objectPath(target, previous.hash));
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
        if (input.scope === 'database') {
          databaseStored = result;
          continue;
        }
        stored.push({
          scope: input.scope,
          path: normalizeKey(input.relative),
          ...result,
          projectIds: [...(projectAssociations.get(`${input.scope}:${normalizeKey(input.relative)}`) || [])],
        });
      }
      if (!databaseStored) throw new Error('未能保存数据库快照');
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
        files: stored,
        totals: { files: stored.length + 1, bytes: databaseStored.size + stored.reduce((sum, item) => sum + item.size, 0) },
        incremental: { reusedFiles, reusedBytes, transferredBytes: Math.max(0, transferredBytes) },
      };
      const finalDirectory = path.join(snapshotsRoot(target), id);
      await fs.promises.mkdir(finalDirectory, { recursive: false });
      const manifestTemporary = path.join(finalDirectory, 'manifest.json.tmp');
      await fs.promises.writeFile(manifestTemporary, JSON.stringify(manifest, null, 2), 'utf8');
      await fs.promises.rename(manifestTemporary, path.join(finalDirectory, 'manifest.json'));
      await fs.promises.rm(stage, { recursive: true, force: true });
      task.report(97, '正在应用备份保留策略');
      await cleanupRetention(target, backupConfig, workspaceId);
      task.report(100, '备份完成', { snapshotId: id, copiedBytes: Math.max(0, transferredBytes), reusedBytes, totalBytes, completedFiles: inputs.length, totalFiles: inputs.length });
      return manifest;
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

  const restoreWorkspace = async (workspaceRoot, snapshot, targetRoot) => {
    const config = readSavedConfig();
    const target = String(config?.backup?.targetPath || '').trim();
    if (!isApprovedTarget(target)) throw new Error('备份位置未经授权');
    const destination = path.resolve(targetRoot);
    if (workspaceRoot && inside(path.resolve(workspaceRoot), destination)) throw new Error('恢复位置不能位于当前工作区内部');
    const existing = await fs.promises.readdir(destination).catch(() => []);
    if (existing.length) throw new Error('请选择一个空文件夹作为恢复位置');
    const manifest = await manifestFor(target, snapshot);
    const run = () => backgroundTasks.run({
      type: 'workspace-restore',
      title: '恢复工作区',
      dedupeKey: `workspace-restore:${destination}`,
      cancellable: true,
      resources: [destination, target],
      metadata: { snapshotId: snapshot, targetPath: destination },
    }, async task => {
      await fs.promises.mkdir(destination, { recursive: true });
      await fs.promises.writeFile(path.join(destination, '.photoflow-restore-incomplete'), String(Date.now()), 'utf8');
      const workspaceEntries = manifest.files.filter(item => item.scope === 'workspace' && item.path !== '.photoflow-workspace-id');
      let completed = 0;
      for (const entry of workspaceEntries) {
        await materialize(target, entry, safeDestination(destination, entry.path), task);
        completed += 1;
        task.report(5 + completed / Math.max(1, workspaceEntries.length) * 70, `正在恢复项目文件 ${completed}/${workspaceEntries.length}`);
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
      const newId = crypto.randomUUID().replaceAll('-', '');
      await fs.promises.writeFile(markerPath(destination), `${newId}\n`, 'utf8');
      const newDataRoot = getWorkspaceDataRoot(destination);
      const dataEntries = manifest.files.filter(item => item.scope === 'workspace-data');
      for (const [index, entry] of dataEntries.entries()) {
        await materialize(target, entry, safeDestination(newDataRoot, entry.path), task);
        task.report(75 + (index + 1) / Math.max(1, dataEntries.length) * 10, `正在恢复内部数据 ${index + 1}/${dataEntries.length}`);
      }
      const databaseSource = objectPath(target, manifest.database.hash);
      await runPythonJsonAction('backup_db.py', [
        'restore-workspace', '--source', databaseSource, '--destination', getWorkspaceDatabasePath(destination),
        '--old-root', manifest.workspace.root, '--new-root', destination,
        '--old-data-root', manifest.workspace.dataRoot || '', '--new-data-root', newDataRoot,
        '--materialized-archive-project-ids', JSON.stringify(manifest.materializedArchiveProjectIds || []),
      ], 30 * 60 * 1000);
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
      await fs.promises.rm(path.join(destination, '.photoflow-restore-incomplete'), { force: true });
      const savedConfig = readSavedConfig();
      await fs.promises.writeFile(getConfigPath(), JSON.stringify({ ...savedConfig, ...restoredConfig, workspacePath: destination, backup: savedConfig?.backup || restoredConfig.backup }, null, 2), 'utf8');
      task.report(100, '工作区恢复完成');
      return { workspacePath: destination };
    }, run);
    return run();
  };

  const restoreProject = async (workspaceRoot, snapshot, projectId) => {
    const config = readSavedConfig();
    const target = String(config?.backup?.targetPath || '').trim();
    if (!isApprovedTarget(target)) throw new Error('备份位置未经授权');
    const root = path.resolve(workspaceRoot);
    const manifest = await manifestFor(target, snapshot);
    const project = (manifest.projects || []).find(item => item.id === projectId);
    if (!project) throw new Error('备份快照中找不到该项目');
    const projectRoot = path.resolve(root, project.relativePath);
    if (!inside(root, projectRoot) || projectRoot === root) throw new Error('备份中的项目路径无效');
    if (await exists(projectRoot)) throw new Error('原项目位置已被占用，请先重命名现有目录');
    const run = () => backgroundTasks.run({
      type: 'project-restore',
      title: `恢复项目：${project.name}`,
      dedupeKey: `project-restore:${root}:${project.id}`,
      cancellable: true,
      resources: [projectRoot, target],
      metadata: { snapshotId: snapshot, projectId: project.id, projectName: project.name },
    }, async task => {
      const prefix = normalizeKey(project.relativePath).replace(/\/$/, '') + '/';
      const projectEntries = manifest.files.filter(item => item.scope === 'workspace' && item.projectIds?.includes(project.id) && (item.path === prefix.slice(0, -1) || item.path.startsWith(prefix)));
      for (const [index, entry] of projectEntries.entries()) {
        const relative = entry.path.slice(prefix.length);
        await materialize(target, entry, safeDestination(projectRoot, relative), task);
        task.report(5 + (index + 1) / Math.max(1, projectEntries.length) * 70, `正在恢复项目文件 ${index + 1}/${projectEntries.length}`);
      }
      const archivePath = String(project.extra?.archive?.path || '');
      if (archivePath && !(manifest.materializedArchiveProjectIds || []).includes(project.id) && path.isAbsolute(archivePath)
        && !await fs.promises.lstat(projectRoot).catch(() => null)) {
        await fs.promises.mkdir(path.dirname(projectRoot), { recursive: true });
        await fs.promises.symlink(archivePath, projectRoot, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const newDataRoot = getWorkspaceDataRoot(root);
      const dataEntries = manifest.files.filter(item => item.scope === 'workspace-data' && item.projectIds?.includes(project.id));
      for (const [index, entry] of dataEntries.entries()) {
        await materialize(target, entry, safeDestination(newDataRoot, entry.path), task);
        task.report(76 + (index + 1) / Math.max(1, dataEntries.length) * 9, `正在恢复项目内部数据 ${index + 1}/${dataEntries.length}`);
      }
      await runPythonJsonAction('backup_db.py', [
        'restore-project', '--source', objectPath(target, manifest.database.hash), '--destination', getWorkspaceDatabasePath(root),
        '--project-id', project.id, '--old-root', manifest.workspace.root, '--new-root', root,
        '--target-relative-path', project.relativePath, '--old-data-root', manifest.workspace.dataRoot || '', '--new-data-root', newDataRoot,
        '--materialized-archive-project-ids', JSON.stringify(manifest.materializedArchiveProjectIds || []),
      ], 30 * 60 * 1000);
      task.report(100, '项目恢复完成');
      return { project };
    }, run);
    return run();
  };

  const verify = async (workspaceRoot, snapshot) => {
    const config = readSavedConfig();
    const target = String(config?.backup?.targetPath || '').trim();
    if (!isApprovedTarget(target)) throw new Error('备份位置未经授权');
    const manifest = await manifestFor(target, snapshot);
    const run = () => backgroundTasks.run({
      type: 'backup-verify',
      title: '验证备份',
      dedupeKey: `backup-verify:${snapshot}`,
      cancellable: true,
      resources: [target],
      metadata: { workspacePath: path.resolve(workspaceRoot), snapshotId: snapshot },
    }, async task => {
      const entries = [{ path: 'workspace.sqlite3', hash: manifest.database.hash }, ...manifest.files];
      for (const [index, entry] of entries.entries()) {
        task.throwIfCancelled();
        const source = objectPath(target, entry.hash);
        if (!await exists(source)) throw new Error(`备份对象缺失：${entry.path}`);
        if (await sha256File(source) !== entry.hash) throw new Error(`备份对象校验失败：${entry.path}`);
        task.report((index + 1) / entries.length * 100, `正在验证 ${index + 1}/${entries.length} 个文件`);
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

  return { approveTarget, isApprovedTarget, runBackup, runIfDue, status, restoreWorkspace, restoreProject, verify, testConnection, spaceStatus, cleanup };
};

module.exports = { createBackupService, STORE_DIRECTORY };
