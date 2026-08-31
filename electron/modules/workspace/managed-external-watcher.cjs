const createManagedExternalWatcherBindings = ({
  fs, path, ensureWorkspace, getProjectPath, watchedProjectFileRoots, watchedProjectFileRootKey,
  acquireFileRootWatcher, releaseFileRootWatcher, externalTrackingChangeHandler, writeLog,
}) => {
  const foldCase = value => process.platform === 'win32' ? String(value).toLocaleLowerCase() : String(value);
  const canonicalPath = value => foldCase(path.resolve(value));
  const canonicalText = value => foldCase(String(value || '').replace(/\\/g, '/'));
  const bindingMatches = (left, right) => canonicalPath(left.root) === canonicalPath(right.root)
    && canonicalText(left.options.virtualPrefix) === canonicalText(right.options.virtualPrefix)
    && canonicalPath(left.options.fileNameFilter || left.root) === canonicalPath(right.options.fileNameFilter || right.root)
    && canonicalText(left.options.virtualFileName) === canonicalText(right.options.virtualFileName);
  const bindingVirtualPath = binding => canonicalText(binding.options.virtualFileName
    ? [binding.options.virtualPrefix, binding.options.virtualFileName].filter(Boolean).join('/')
    : binding.options.virtualPrefix);

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
      const expectedVirtualPath = canonicalText([projectPrefix, shortcutVirtualPath].filter(Boolean).join('/'));
      const previousBindings = bindings.filter(current => bindingVirtualPath(current) === expectedVirtualPath);
      const duplicate = previousBindings.length === 1 && bindingMatches(previousBindings[0], binding);
      // Acquire first so a refresh never leaves a working binding unwatched.
      const result = acquireFileRootWatcher(binding.root, binding.options);
      if (!result.success) return result;
      const released = [];
      for (const previous of previousBindings) {
        const releaseResult = releaseFileRootWatcher(previous.root, previous.options);
        if (releaseResult?.success === false && !releaseResult.missing) {
          releaseFileRootWatcher(binding.root, binding.options);
          for (const restored of released) acquireFileRootWatcher(restored.root, restored.options);
          return { success: false, error: 'Unable to replace the previous watcher binding' };
        }
        if (!releaseResult?.missing) released.push(previous);
      }
      for (const previous of previousBindings) bindings.splice(bindings.indexOf(previous), 1);
      bindings.push(binding);
      if (duplicate) return { success: true, alreadyWatched: true };
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
    const expectedPrefix = canonicalText([path.relative(publishRoot, projectRoot).replace(/\\/g, '/'), String(shortcutVirtualPath || '').replace(/\\/g, '/')].filter(Boolean).join('/'));
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const binding = bindings[index];
      const virtualPath = bindingVirtualPath(binding);
      if (virtualPath !== expectedPrefix) continue;
      const result = releaseFileRootWatcher(binding.root, binding.options);
      if (result?.success !== false || result.missing) bindings.splice(index, 1);
    }
  };
  return { attach, detach };
};

module.exports = { createManagedExternalWatcherBindings };
