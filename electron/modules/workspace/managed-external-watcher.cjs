const createManagedExternalWatcherBindings = ({
  fs, path, ensureWorkspace, getProjectPath, watchedProjectFileRoots, watchedProjectFileRootKey,
  acquireFileRootWatcher, releaseFileRootWatcher, externalTrackingChangeHandler, writeLog,
}) => {
  const attach = (workspacePath, status, projectName, projectRoot, shortcutVirtualPath, targetRoot) => {
    try {
      const publishRoot = path.resolve(ensureWorkspace(workspacePath));
      const bindings = watchedProjectFileRoots.get(watchedProjectFileRootKey(publishRoot, status, projectName));
      if (!bindings) return { success: true, deferred: true };
      const projectPrefix = path.relative(publishRoot, projectRoot).replace(/\\/g, '/');
      const resolvedTarget = path.resolve(targetRoot);
      const targetIsFile = fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isFile();
      const onChanged = externalTrackingChangeHandler(publishRoot, projectName);
      const binding = targetIsFile
        ? { root: path.dirname(resolvedTarget), options: { publishRoot, virtualPrefix: projectPrefix, fileNameFilter: resolvedTarget, virtualFileName: shortcutVirtualPath, onChanged } }
        : { root: resolvedTarget, options: { publishRoot, virtualPrefix: [projectPrefix, shortcutVirtualPath].filter(Boolean).join('/'), onChanged } };
      const duplicate = bindings.some(current => path.resolve(current.root).toLocaleLowerCase() === path.resolve(binding.root).toLocaleLowerCase()
        && String(current.options.virtualPrefix).toLocaleLowerCase() === String(binding.options.virtualPrefix).toLocaleLowerCase()
        && String(current.options.fileNameFilter || '').toLocaleLowerCase() === String(binding.options.fileNameFilter || '').toLocaleLowerCase()
        && String(current.options.virtualFileName || '').toLocaleLowerCase() === String(binding.options.virtualFileName || '').toLocaleLowerCase());
      if (duplicate) return { success: true, alreadyWatched: true };
      const result = acquireFileRootWatcher(binding.root, binding.options);
      if (result.success) bindings.push(binding);
      return result;
    } catch (error) {
      writeLog('warn', 'Unable to attach managed external watcher', { shortcutVirtualPath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  };

  const detach = (workspacePath, status, projectName, shortcutVirtualPath) => {
    const publishRoot = path.resolve(ensureWorkspace(workspacePath));
    const bindings = watchedProjectFileRoots.get(watchedProjectFileRootKey(publishRoot, status, projectName));
    if (!bindings) return;
    const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
    const expectedPrefix = [path.relative(publishRoot, projectRoot).replace(/\\/g, '/'), String(shortcutVirtualPath || '').replace(/\\/g, '/')].filter(Boolean).join('/').toLocaleLowerCase();
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const binding = bindings[index];
      const virtualPath = binding.options.virtualFileName
        ? [binding.options.virtualPrefix, binding.options.virtualFileName].filter(Boolean).join('/').toLocaleLowerCase()
        : binding.options.virtualPrefix.toLocaleLowerCase();
      if (virtualPath !== expectedPrefix) continue;
      releaseFileRootWatcher(binding.root, binding.options);
      bindings.splice(index, 1);
    }
  };
  return { attach, detach };
};

module.exports = { createManagedExternalWatcherBindings };
