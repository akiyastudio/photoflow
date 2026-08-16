const createWorkspaceStoragePolicy = ({ fs, path, ensureWorkspace }) => {
  const workspaceCandidates = (primary, requested = []) => [primary, ...(Array.isArray(requested) ? requested : [])]
    .map(value => String(value || '').trim()).filter((value, index, values) => value
      && values.findIndex(candidate => path.resolve(candidate).toLocaleLowerCase() === path.resolve(value).toLocaleLowerCase()) === index);

  const selectWorkspaceForWrite = async (primary, requested, requiredBytes = 0) => {
    const candidates = workspaceCandidates(primary, requested);
    for (const candidate of candidates) {
      try {
        const root = ensureWorkspace(candidate);
        const stat = typeof fs.promises.statfs === 'function' ? await fs.promises.statfs(root).catch(() => null) : null;
        const available = stat ? Number(stat.bavail) * Number(stat.bsize) : Number.POSITIVE_INFINITY;
        const reserve = Math.max(256 * 1024 * 1024, Math.ceil(Math.max(0, requiredBytes) * 0.02));
        if (!Number.isFinite(available) || available >= Math.max(0, requiredBytes) + reserve) {
          return { root, switched: path.resolve(root).toLocaleLowerCase() !== path.resolve(primary).toLocaleLowerCase() };
        }
      } catch { /* try the next configured workspace */ }
    }
    throw Object.assign(new Error(candidates.length > 1
      ? '所有项目工作目录的可用空间都不足或磁盘已离线。请在“设置 → 存储”中释放空间、重新连接磁盘或添加新的工作目录。'
      : '项目工作目录的磁盘空间不足。请在“设置 → 存储”中释放空间或添加新的项目工作目录。'), { code: 'WORKSPACE_STORAGE_FULL' });
  };

  return { selectWorkspaceForWrite, workspaceCandidates };
};

module.exports = { createWorkspaceStoragePolicy };
