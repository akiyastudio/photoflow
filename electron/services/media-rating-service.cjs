const createMediaRatingService = ({ exiftool, fs, path, imageExtensions, rawExtensions, releaseWorkspaceWatchPath, suppressWorkspaceWatchPath, versionService, projectVirtualPaths, writeLog, pendingRatingsPath = '', onInvalidate = () => undefined }) => {
  const cache = new Map();
  const pendingFile = pendingRatingsPath ? path.resolve(pendingRatingsPath) : '';
  const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
  const pendingRatings = new Map();
  const optimisticRatings = new Map();
  const activeWrites = new Set();
  let writeSequence = 0;
  if (pendingFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
        if (!item?.filePath || !item?.workspaceRoot) continue;
        const key = pathKey(item.filePath);
        const entry = { ...item, filePath: path.resolve(item.filePath), workspaceRoot: path.resolve(item.workspaceRoot) };
        pendingRatings.set(key, entry);
        optimisticRatings.set(key, Number(item.rating) || 0);
      }
    } catch { /* a missing or invalid outbox starts empty */ }
  }
  const savePendingRatings = () => {
    if (!pendingFile) return;
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    const temporary = `${pendingFile}.tmp-${process.pid}-${Date.now()}-${++writeSequence}`;
    const backup = `${pendingFile}.backup-${process.pid}-${Date.now()}-${++writeSequence}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, items: [...pendingRatings.values()] }), { encoding: 'utf8', flag: 'wx' });
    try {
      if (fs.existsSync(pendingFile)) fs.renameSync(pendingFile, backup);
      fs.renameSync(temporary, pendingFile);
      fs.rmSync(backup, { force: true });
    } catch (error) {
      if (!fs.existsSync(pendingFile) && fs.existsSync(backup)) fs.renameSync(backup, pendingFile);
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
      fs.rmSync(backup, { force: true });
    }
  };
  const normalize = value => Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
  const fromTags = tags => {
    const entries = Object.entries(tags || {});
    const direct = entries.find(([name]) => /^XMP[^:]*:Rating$/i.test(name)) || entries.find(([name]) => /(?:^|:)Rating$/i.test(name));
    if (direct) return normalize(direct[1]);
    const percent = Number(entries.find(([name]) => /(?:^|:)RatingPercent$/i.test(name))?.[1]);
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    if (percent <= 1) return 1;
    if (percent <= 25) return 2;
    if (percent <= 50) return 3;
    if (percent <= 75) return 4;
    return 5;
  };
  const read = async (filePath, knownUpdatedAt) => {
    const optimistic = optimisticRatings.get(pathKey(filePath));
    if (optimistic !== undefined) return optimistic;
    const stat = await fs.promises.stat(filePath);
    const updatedAt = Number(knownUpdatedAt) || stat.mtimeMs;
    const cacheKey = `${path.resolve(filePath)}|${updatedAt}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const tags = await exiftool.readRaw(filePath, ['-G1', '-Rating#', '-RatingPercent#', '-n', '-api', 'largefilesupport=1']);
    const rating = fromTags(tags);
    if (cache.size >= 4000) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, rating);
    return rating;
  };
  const invalidate = filePath => {
    const prefix = `${path.resolve(filePath)}|`;
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    onInvalidate(filePath);
  };
  const drainRating = key => {
    if (activeWrites.has(key)) return;
    activeWrites.add(key);
    void (async () => {
      let retry = false;
      try {
        while (pendingRatings.has(key)) {
          const item = pendingRatings.get(key);
          const suppressedPaths = [item.filePath, `${item.filePath}_exiftool_tmp`, `${item.filePath}_original`];
          suppressedPaths.forEach(suppressedPath => suppressWorkspaceWatchPath(suppressedPath));
          try {
            await exiftool.write(item.filePath, { 'XMP:Rating': item.rating }, { writeArgs: ['-overwrite_original', '-P'] });
          } finally {
            suppressedPaths.forEach(suppressedPath => releaseWorkspaceWatchPath(suppressedPath));
          }
          const current = pendingRatings.get(key);
          if (current?.token !== item.token) continue;
          pendingRatings.delete(key);
          optimisticRatings.delete(key);
          try { savePendingRatings(); }
          catch (error) {
            pendingRatings.set(key, item);
            optimisticRatings.set(key, item.rating);
            throw error;
          }
          invalidate(item.filePath);
          void versionService.refreshMetadataFingerprint(item.workspaceRoot, { filePath: item.filePath }).catch(error => {
            writeLog('warn', 'Unable to refresh tracked fingerprint after metadata rating write', { filePath: item.filePath, error: error.message || String(error) });
          });
        }
      } catch (error) {
        retry = true;
        writeLog('warn', 'Media rating metadata write remains queued for retry', { filePath: pendingRatings.get(key)?.filePath, error: error.message || String(error) });
      } finally {
        activeWrites.delete(key);
        if (retry && pendingRatings.has(key)) {
          const timer = setTimeout(() => drainRating(key), 30000);
          timer.unref?.();
        }
        else if (pendingRatings.has(key)) drainRating(key);
      }
    })();
  };
  const write = async (workspaceRoot, filePath, value) => {
    const rating = normalize(value);
    const resolvedFilePath = path.resolve(filePath);
    const key = pathKey(resolvedFilePath);
    const token = `${Date.now()}-${++writeSequence}`;
    const previousPending = pendingRatings.get(key);
    const previousOptimistic = optimisticRatings.get(key);
    pendingRatings.set(key, { workspaceRoot: path.resolve(workspaceRoot), filePath: resolvedFilePath, rating, token, updatedAt: Date.now() });
    optimisticRatings.set(key, rating);
    try { savePendingRatings(); }
    catch (error) {
      if (previousPending) pendingRatings.set(key, previousPending); else pendingRatings.delete(key);
      if (previousOptimistic !== undefined) optimisticRatings.set(key, previousOptimistic); else optimisticRatings.delete(key);
      throw error;
    }
    invalidate(filePath);
    drainRating(key);
    return rating;
  };
  const listProject = async projectPath => {
    const candidates = [];
    const directories = [{ path: projectPath, virtualPath: '', viaExternalLink: false }];
    for (const link of projectVirtualPaths?.listManagedExternalLinks(projectPath) || []) {
      if (link.offline) continue;
      if (link.externalTargetKind === 'file') {
        const extension = path.extname(link.externalTargetRoot).toLowerCase();
        if (imageExtensions.has(extension) || rawExtensions.has(extension)) candidates.push({ filePath: link.externalTargetRoot, extension, virtualPath: link.shortcutVirtualPath, viaExternalLink: true });
      } else directories.push({ path: link.externalTargetRoot, virtualPath: link.shortcutVirtualPath, viaExternalLink: true });
    }
    const visited = new Set();
    while (directories.length) {
      const directory = directories.pop();
      const realDirectory = await fs.promises.realpath(directory.path);
      const directoryKey = process.platform === 'win32' ? realDirectory.toLocaleLowerCase() : realDirectory;
      if (visited.has(directoryKey)) continue;
      visited.add(directoryKey);
      for (const entry of await fs.promises.readdir(realDirectory, { withFileTypes: true })) {
        const filePath = path.join(realDirectory, entry.name);
        const virtualPath = [directory.virtualPath, entry.name].filter(Boolean).join('/');
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.photoflow-') && !/^图片后期_\d+(?:_\d+)*_喜爱$/u.test(entry.name)) directories.push({ path: filePath, virtualPath, viaExternalLink: directory.viaExternalLink });
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (imageExtensions.has(extension) || rawExtensions.has(extension)) candidates.push({ filePath, extension, virtualPath, viaExternalLink: directory.viaExternalLink });
      }
    }
    const entries = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(6, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor++];
        try {
          const rating = await read(candidate.filePath);
          if (!rating) continue;
          const stat = await fs.promises.stat(candidate.filePath);
          entries.push({ name: path.basename(candidate.filePath), path: candidate.filePath, relativePath: candidate.virtualPath, kind: imageExtensions.has(candidate.extension) ? 'image' : 'raw', extension: candidate.extension, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs, updatedAt: stat.mtimeMs, rating, ...(candidate.viaExternalLink ? { viaShortcut: true, viaExternalLink: true, readOnly: false } : {}) });
        } catch (error) {
          writeLog('warn', 'Unable to inspect media rating', { filePath: candidate.filePath, error: error.message || String(error) });
        }
      }
    });
    await Promise.all(workers);
    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  };
  for (const key of pendingRatings.keys()) {
    const timer = setTimeout(() => drainRating(key), 0);
    timer.unref?.();
  }
  return { invalidate, listProject, normalize, read, write };
};

module.exports = { createMediaRatingService };
