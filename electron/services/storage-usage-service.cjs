const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BACKUP_STORE_DIRECTORY = '.photoflow-backup';

const exists = filePath => fs.promises.access(filePath).then(() => true, () => false);
const comparable = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const volumeRoot = value => {
  const resolved = path.resolve(value);
  if (process.platform === 'win32') {
    const unc = resolved.match(/^(\\\\[^\\]+\\[^\\]+)/);
    if (unc) return `${unc[1]}\\`;
  }
  return path.parse(resolved).root || resolved;
};
const roleDetails = {
  workspace: { label: '工作区项目', priority: 1 },
  inspiration: { label: '灵感库', priority: 2 },
  cache: { label: '缓存和数据', priority: 3 },
  internal: { label: '缓存和数据', priority: 3 },
  archive: { label: '归档项目', priority: 4 },
  backup: { label: '备份数据', priority: 5 },
};

const createStorageUsageService = ({ app, backgroundTasks, eventBus, getWorkspaceDatabasePath, getWorkspaceDataRoot, readSavedConfig, writeLog }) => {
  const cachePath = path.join(app.getPath('userData'), 'storage-usage-cache.json');
  const invalidatingTaskTypes = new Set(['project-file-operation', 'project-archive', 'project-unarchive', 'workspace-backup', 'backup-cleanup', 'workspace-restore', 'project-restore', 'cache-cleanup', 'deleted-project-cleanup']);
  let invalidatedAt = 0;
  eventBus?.on('background-task:changed', delta => {
    if (delta?.upserts?.some(task => task.state === 'completed' && invalidatingTaskTypes.has(task.type))) invalidatedAt = Date.now();
  });

  const workspaceId = async root => {
    try { return (await fs.promises.readFile(path.join(root, '.photoflow-workspace-id'), 'utf8')).trim(); }
    catch { return ''; }
  };

  const configuredSources = async () => {
    const config = readSavedConfig() || {};
    const workspaceRoots = [config.workspacePath, ...(Array.isArray(config.workspacePaths) ? config.workspacePaths : [])]
      .map(value => String(value || '').trim())
      .filter((value, index, values) => value && values.findIndex(candidate => comparable(candidate) === comparable(value)) === index);
    const sources = [];
    const add = (kind, sourcePath) => {
      if (!sourcePath) return;
      const absolute = path.resolve(sourcePath);
      const key = `${kind}:${comparable(absolute)}`;
      if (!sources.some(item => item.key === key)) sources.push({ key, kind, label: roleDetails[kind].label, path: absolute });
    };
    const workspaceIds = [];
    for (const workspaceRoot of workspaceRoots) {
      add('workspace', workspaceRoot);
      const id = await workspaceId(workspaceRoot);
      if (id) {
        workspaceIds.push(id);
        add('internal', getWorkspaceDataRoot(workspaceRoot));
        add('internal', getWorkspaceDatabasePath(workspaceRoot));
      }
    }
    const inspirationRoot = String(config.inspirationLibrary?.rootPath || '').trim();
    if (inspirationRoot) add('inspiration', inspirationRoot);
    const archiveTarget = String(config.archive?.targetPath || '').trim();
    if (archiveTarget) for (const id of workspaceIds) add('archive', path.join(archiveTarget, id));
    const backupTarget = String(config.backup?.targetPath || '').trim();
    if (backupTarget) add('backup', path.join(backupTarget, BACKUP_STORE_DIRECTORY));
    const cacheRoot = String(config.mediaCache?.directory || '').trim() || path.join(app.getPath('userData'), 'media-cache');
    add('cache', cacheRoot);
    return sources.sort((left, right) => left.key.localeCompare(right.key));
  };

  const signatureFor = sources => JSON.stringify(sources.map(item => [item.kind, comparable(item.path)]));
  const readCache = async signature => {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
      if (parsed?.version !== CACHE_VERSION || parsed.signature !== signature || !Array.isArray(parsed.sources)) return null;
      return parsed;
    } catch { return null; }
  };
  const writeCache = async value => {
    const temporary = `${cachePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await fs.promises.rm(cachePath, { force: true });
    await fs.promises.rename(temporary, cachePath);
  };

  const scanPath = async (sourcePath, task, state, excludedPaths = new Set()) => {
    const initial = await fs.promises.lstat(sourcePath).catch(() => null);
    if (!initial) return { bytes: 0, files: 0, online: false };
    if (initial.isSymbolicLink()) return { bytes: 0, files: 0, online: true };
    if (initial.isFile()) return { bytes: initial.size, files: 1, online: true };
    let bytes = 0;
    let files = 0;
    const pending = [sourcePath];
    while (pending.length) {
      task.throwIfCancelled();
      const directory = pending.pop();
      const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (excludedPaths.has(comparable(absolute))) continue;
        if (entry.isDirectory()) pending.push(absolute);
        else if (entry.isFile()) {
          const stat = await fs.promises.stat(absolute).catch(() => null);
          if (stat) { bytes += stat.size; files += 1; }
        }
        state.processed += 1;
        if (state.processed % 256 === 0) {
          task.report(Math.min(95, 5 + state.processed / 2000), `正在统计文件，占用 ${Math.round(bytes / 1024 / 1024)} MB`, { processedEntries: state.processed });
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    }
    return { bytes, files, online: true };
  };

  const capacityFor = async sourcePath => {
    if (typeof fs.promises.statfs !== 'function') return { online: await exists(sourcePath) };
    let probe = path.resolve(sourcePath);
    const root = volumeRoot(probe);
    while (!await exists(probe)) {
      if (comparable(probe) === comparable(root)) return { online: false };
      const parent = path.dirname(probe);
      if (parent === probe) return { online: false };
      probe = parent;
    }
    const stat = await fs.promises.statfs(probe).catch(() => null);
    return stat ? { online: true, totalBytes: Number(stat.blocks) * Number(stat.bsize), freeBytes: Number(stat.bavail) * Number(stat.bsize) } : { online: true };
  };

  const runScan = async (sources, signature, restartTask = null) => backgroundTasks.run({
    ...(restartTask?.id ? { id: restartTask.id } : {}),
    type: 'storage-usage-scan',
    title: '统计 PhotoFlow 存储占用',
    dedupeKey: 'storage-usage-scan',
    cancellable: true,
    metadata: { signature, sourceCount: sources.length },
  }, async task => {
    const state = { processed: 0 };
    const measured = [];
    for (const [index, source] of sources.entries()) {
      task.report(index / Math.max(1, sources.length) * 95, `正在统计${source.label}`);
      const excludedPaths = new Set(sources.filter(other => other.key !== source.key && inside(source.path, other.path)).map(other => comparable(other.path)));
      const result = await scanPath(source.path, task, state, excludedPaths);
      measured.push({ ...source, ...result });
    }
    const cache = { version: CACHE_VERSION, signature, updatedAt: Date.now(), sources: measured };
    await writeCache(cache);
    task.report(100, '存储占用统计完成', { updatedAt: cache.updatedAt });
    return cache;
  });

  const overview = async (force = false) => {
    const sources = await configuredSources();
    const signature = signatureFor(sources);
    let cache = await readCache(signature);
    const active = backgroundTasks.list().some(task => task.type === 'storage-usage-scan' && ['queued', 'running'].includes(task.state));
    const stale = !cache || Number(cache.updatedAt || 0) < invalidatedAt || Date.now() - Number(cache.updatedAt || 0) >= CACHE_MAX_AGE_MS;
    if ((force || stale) && !active) {
      void runScan(sources, signature).catch(error => writeLog?.('warn', 'Storage usage scan failed', { error: error.message || String(error) }));
    }
    if (!cache) cache = { updatedAt: 0, sources: [] };
    const cachedByKey = new Map(cache.sources.map(item => [item.key, item]));
    const volumes = new Map();
    for (const source of sources) {
      const root = volumeRoot(source.path);
      const id = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
      if (!volumes.has(id)) {
        const capacity = await capacityFor(source.path);
        volumes.set(id, { id, label: root.replace(/[\\/]$/, '') || root, root, online: capacity.online, totalBytes: capacity.totalBytes, freeBytes: capacity.freeBytes, photoflowBytes: 0, items: [] });
      }
      const volume = volumes.get(id);
      const cached = cachedByKey.get(source.key);
      const bytes = Number(cached?.bytes || 0);
      volume.photoflowBytes += bytes;
      volume.items.push({ kind: source.kind, label: source.label, path: source.path, bytes, measured: Boolean(cached) });
    }
    for (const volume of volumes.values()) {
      volume.items.sort((left, right) => roleDetails[left.kind].priority - roleDetails[right.kind].priority || left.path.localeCompare(right.path));
      const used = Number(volume.totalBytes || 0) - Number(volume.freeBytes || 0);
      volume.otherBytes = Math.max(0, used - volume.photoflowBytes);
    }
    const nowActive = backgroundTasks.list().some(task => task.type === 'storage-usage-scan' && ['queued', 'running'].includes(task.state));
    const orderedVolumes = [...volumes.values()].sort((left, right) => {
      const priority = volume => Math.min(...volume.items.map(item => roleDetails[item.kind].priority));
      return priority(left) - priority(right)
        || String(left.label || left.root).localeCompare(String(right.label || right.root), undefined, { numeric: true, sensitivity: 'base' });
    });
    return { success: true, updatedAt: Number(cache.updatedAt || 0), scanning: nowActive || ((force || stale) && !active), stale, volumes: orderedVolumes };
  };

  backgroundTasks.registerTypeRestartFactory?.('storage-usage-scan', async task => {
    const sources = await configuredSources();
    return runScan(sources, signatureFor(sources), task);
  }, { autoRestart: true });

  return { overview };
};

module.exports = { createStorageUsageService };
