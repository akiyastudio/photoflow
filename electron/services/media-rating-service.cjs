const createMediaRatingService = ({ exiftool, fs, path, imageExtensions, rawExtensions, releaseWorkspaceWatchPath, suppressWorkspaceWatchPath, versionService, writeLog, onInvalidate = () => undefined }) => {
  const cache = new Map();
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
  const write = async (workspaceRoot, filePath, value) => {
    const rating = normalize(value);
    suppressWorkspaceWatchPath(filePath);
    try {
      await exiftool.write(filePath, { 'XMP:Rating': rating }, { writeArgs: ['-overwrite_original', '-P'] });
    } finally {
      releaseWorkspaceWatchPath(filePath);
    }
    invalidate(filePath);
    // ExifTool has already durably written the requested value. Fingerprint
    // maintenance is bookkeeping and must not extend an interactive click.
    void versionService.refreshMetadataFingerprint(workspaceRoot, { filePath }).catch(error => {
      writeLog('warn', 'Unable to refresh tracked fingerprint after metadata rating write', { filePath, error: error.message || String(error) });
    });
    return rating;
  };
  const listProject = async projectPath => {
    const candidates = [];
    const directories = [projectPath];
    while (directories.length) {
      const directory = directories.pop();
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.photoflow-') && !/^图片后期_\d+(?:_\d+)*_喜爱$/u.test(entry.name)) directories.push(filePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (imageExtensions.has(extension) || rawExtensions.has(extension)) candidates.push({ filePath, extension });
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
          entries.push({ name: path.basename(candidate.filePath), path: candidate.filePath, relativePath: path.relative(projectPath, candidate.filePath).replace(/\\/g, '/'), kind: imageExtensions.has(candidate.extension) ? 'image' : 'raw', extension: candidate.extension, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs, updatedAt: stat.mtimeMs, rating });
        } catch (error) {
          writeLog('warn', 'Unable to inspect media rating', { filePath: candidate.filePath, error: error.message || String(error) });
        }
      }
    });
    await Promise.all(workers);
    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  };
  return { invalidate, listProject, normalize, read, write };
};

module.exports = { createMediaRatingService };
