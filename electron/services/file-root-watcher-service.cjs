const fs = require('fs');
const path = require('path');
const { describeActionableWatchChanges, forgetMissingWatchChanges, recordActionableWatchEntry } = require('./watch-change-filter.cjs');

const createFileRootWatcherService = ({
  getMainWindow,
  getThumbnailService,
  getMediaCacheConfig,
  isInternalChange,
  isSuppressedChange,
  writeLog,
}) => {
  const watchers = new Map();
  const comparable = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
  };
  const pathIsInside = (parent, candidate) => {
    const relative = path.relative(parent, candidate);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const publish = (state, changes) => {
    const mainWindow = getMainWindow();
    for (const binding of state.bindings.values()) {
      const publishedEntries = [];
      for (const change of changes) {
        const changedName = path.relative(state.root, change.path);
        const { eventType } = change;
        if (binding.fileNameFilter && comparable(path.join(state.root, changedName)) !== binding.fileNameFilter) continue;
        const fileName = [binding.virtualPrefix, binding.virtualFileName || changedName].filter(Boolean).join('/').replace(/\\/g, '/');
        publishedEntries.push({ ...change, fileName, sourcePath: change.path });
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-files-changed', { root: binding.publishRoot, fileName, eventType, viaExternalLink: Boolean(binding.virtualPrefix || binding.virtualFileName) });
      }
      if (publishedEntries.length && binding.onChanged) {
        try { binding.onChanged(publishedEntries); }
        catch (error) { writeLog('warn', 'Unable to publish file-root tracking changes', { root: state.root, error: error.message || String(error) }); }
      }
    }
  };
  const acquire = (rootPath, options = {}) => {
    const root = path.resolve(rootPath);
    const key = comparable(root);
    const publishRoot = path.resolve(options.publishRoot || root);
    const virtualPrefix = String(options.virtualPrefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const fileNameFilter = options.fileNameFilter ? comparable(options.fileNameFilter) : '';
    const virtualFileName = String(options.virtualFileName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const bindingKey = `${comparable(publishRoot)}\0${virtualPrefix.toLocaleLowerCase()}\0${fileNameFilter}\0${virtualFileName.toLocaleLowerCase()}`;
    const existing = watchers.get(key);
    if (existing) {
      existing.references += 1;
      const binding = existing.bindings.get(bindingKey) || { publishRoot, virtualPrefix, fileNameFilter, virtualFileName, onChanged: options.onChanged, references: 0 };
      if (options.onChanged) binding.onChanged = options.onChanged;
      binding.references += 1;
      existing.bindings.set(bindingKey, binding);
      return { success: true, root };
    }
    const state = { root, references: 1, watcher: null, timer: null, changes: new Map(), knownEntries: new Map(), bindings: new Map([[bindingKey, { publishRoot, virtualPrefix, fileNameFilter, virtualFileName, onChanged: options.onChanged, references: 1 }]]) };
    try {
      state.watcher = fs.watch(root, { recursive: process.platform !== 'linux' }, (eventType, fileName) => {
        if (!fileName || isInternalChange(fileName) || isSuppressedChange(root, fileName)) return;
        const changedName = String(fileName);
        const normalizedEventType = eventType === 'rename' ? 'rename' : 'change';
        recordActionableWatchEntry(state.changes, state.knownEntries, root, changedName, normalizedEventType, fs);
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = null;
          const changes = describeActionableWatchChanges(root, [...state.changes], fs);
          state.changes.clear();
          forgetMissingWatchChanges(state.knownEntries, root, changes);
          if (!changes.length) return;
          const thumbnailService = getThumbnailService();
          if (thumbnailService && changes.length) {
            const changedPaths = changes.map(change => change.path);
            void thumbnailService.syncChangedPaths(root, changedPaths, getMediaCacheConfig()).catch(error => {
              writeLog('warn', 'Unable to update file-root thumbnails', { root, error: error.message || String(error) });
            });
          }
          publish(state, changes);
        }, 200);
      });
      state.watcher.on('error', error => {
        writeLog('warn', 'File-root watcher stopped', { root, error: error.message || String(error) });
        if (state.timer) clearTimeout(state.timer);
        state.watcher?.close();
        watchers.delete(key);
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) for (const binding of state.bindings.values()) {
          mainWindow.webContents.send('workspace-files-changed', { root: binding.publishRoot, fileName: binding.virtualPrefix, eventType: 'rename', watcherFailed: true, viaExternalLink: Boolean(binding.virtualPrefix) });
        }
      });
      watchers.set(key, state);
      return { success: true, root };
    } catch (error) {
      writeLog('warn', 'Unable to watch file root', { root, error: error.message || String(error) });
      return { success: false, root, error: error.message || String(error) };
    }
  };
  const release = (rootPath, options = {}) => {
    const key = comparable(rootPath);
    const state = watchers.get(key);
    if (!state) return;
    const publishRoot = path.resolve(options.publishRoot || rootPath);
    const virtualPrefix = String(options.virtualPrefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const fileNameFilter = options.fileNameFilter ? comparable(options.fileNameFilter) : '';
    const virtualFileName = String(options.virtualFileName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const bindingKey = `${comparable(publishRoot)}\0${virtualPrefix.toLocaleLowerCase()}\0${fileNameFilter}\0${virtualFileName.toLocaleLowerCase()}`;
    const binding = state.bindings.get(bindingKey);
    if (binding) {
      binding.references -= 1;
      if (binding.references <= 0) state.bindings.delete(bindingKey);
    }
    state.references -= 1;
    if (state.references > 0) return;
    if (state.timer) clearTimeout(state.timer);
    state.watcher?.close();
    watchers.delete(key);
  };
  const suspend = rootPath => {
    const key = comparable(rootPath);
    const state = watchers.get(key);
    if (!state) return 0;
    if (state.timer) clearTimeout(state.timer);
    state.watcher?.close();
    watchers.delete(key);
    return Math.max(1, state.references || 1);
  };
  const resume = (rootPath, references = 1) => {
    const referenceCount = Math.max(0, Number(references) || 0);
    if (!referenceCount) return { success: true, root: path.resolve(rootPath) };
    const result = acquire(rootPath);
    if (result.success) {
      const state = watchers.get(comparable(rootPath));
      if (state) state.references = referenceCount;
    }
    return result;
  };
  const discardChangesInside = targetPath => {
    const suppressed = comparable(targetPath);
    for (const state of watchers.values()) {
      for (const changedName of state.changes.keys()) {
        const candidate = comparable(path.resolve(state.root, changedName));
        if (pathIsInside(suppressed, candidate)) state.changes.delete(changedName);
      }
    }
  };
  const stop = () => {
    for (const state of watchers.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.watcher?.close();
    }
    watchers.clear();
  };
  return { acquire, release, suspend, resume, discardChangesInside, stop };
};

module.exports = { createFileRootWatcherService };
