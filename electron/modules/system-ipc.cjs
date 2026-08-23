const { validateRendererPythonInvocation } = require('../security-policy.cjs');
const { listStorageDevices } = require('../services/storage-device-service.cjs');
const { decideComponentStatusRefresh, nextComponentProbeTimestamps } = require('../services/component-status-refresh-policy.cjs');

const normalizeSdImportAutoMove = value => value !== false;

const PYTHON_BACKGROUND_TASK_PROFILES = Object.freeze({
  'png_to_jpg.py': Object.freeze({ title: 'PNG 转 JPG', type: 'python-tool', concurrencyGroup: 'disk-io', concurrencyLimit: 3, concurrencyWriteLimit: 2 }),
  'research.py': Object.freeze({ title: '截取分镜帧', type: 'python-tool', concurrencyGroup: 'heavy-media', concurrencyLimit: 1, concurrencyWriteLimit: 1 }),
  'ffmpeg_transcode.py': Object.freeze({ title: '视频转码', type: 'python-tool', concurrencyGroup: 'heavy-media', concurrencyLimit: 1, concurrencyWriteLimit: 1 }),
  'cut_video.py': Object.freeze({ title: '视频切割', type: 'python-tool', concurrencyGroup: 'heavy-media', concurrencyLimit: 1, concurrencyWriteLimit: 1 }),
});

const normalizePythonTaskPresentation = value => {
  if (!value || typeof value !== 'object') return null;
  const ownerPageId = String(value.ownerPageId || '').trim().slice(0, 160);
  const panelKind = String(value.panelKind || '').trim().slice(0, 80);
  const title = String(value.title || '').trim().slice(0, 160);
  return ownerPageId && panelKind ? { ownerPageId, panelKind, title } : null;
};

const pythonToolResourcePaths = (scriptName, args, pathApi) => {
  const paths = [];
  const addDirectoryFor = value => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const resolved = pathApi.resolve(normalized);
    if (resolved) paths.push(pathApi.dirname(resolved));
  };
  const addDirectory = value => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const resolved = pathApi.resolve(normalized);
    if (resolved) paths.push(resolved);
  };
  if (scriptName === 'research.py') {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--path' && args[index + 1]) addDirectoryFor(args[++index]);
    }
  } else {
    const valueOptions = new Set(scriptName === 'png_to_jpg.py'
      ? ['--quality']
      : scriptName === 'ffmpeg_transcode.py'
        ? ['--container', '--video-mode', '--quality', '--resolution', '--frame-rate', '--audio-mode', '--output-mode', '--source-folder']
        : ['--output-dir', '--output-stem', '--trim-start', '--trim-end', '--output-path', '--timeline-frames']);
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (valueOptions.has(value)) {
        const optionValue = args[++index];
        if (value === '--source-folder') addDirectoryFor(optionValue);
        else if (value === '--output-dir') addDirectory(optionValue);
        else if (value === '--output-path') addDirectoryFor(optionValue);
        continue;
      }
      if (!String(value || '').startsWith('--')) addDirectoryFor(value);
    }
  }
  return [...new Set(paths)].map(resourcePath => ({ path: resourcePath, access: 'write' }));
};

const RESERVED_PROJECT_CATEGORIES = new Set(['未分类', '策划中', '待拍摄', '后期中', '已归档']);
const normalizeCustomProjectCategories = value => {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const name = String(item || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    const hasControlCharacter = [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!name || name.length > 24 || hasControlCharacter || RESERVED_PROJECT_CATEGORIES.has(name) || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= 50) break;
  }
  return result;
};
const normalizeProjectCategoryOrder = (value, customCategories) => {
  const available = ['策划中', '待拍摄', '后期中', '已归档', ...customCategories];
  const byKey = new Map(available.map(name => [name.toLocaleLowerCase(), name]));
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const key = String(item || '').trim().toLocaleLowerCase();
    const name = byKey.get(key);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  for (const name of available) {
    const key = name.toLocaleLowerCase();
    if (!seen.has(key)) result.push(name);
  }
  return result;
};
const normalizeProgressNamePresets = value => {
  const source = Array.isArray(value) ? value : ['调色后', '修脸后', '完成版'];
  const result = [];
  const seen = new Set();
  for (const item of source) {
    const name = String(item || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    const invalid = [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!name || name.length > 24 || invalid || seen.has(key)) continue;
    seen.add(key); result.push(name);
    if (result.length >= 50) break;
  }
  return result;
};

const registerSystemIpc = context => {
  const { Array, Boolean, BrowserWindow, Date, Error, JSON, Object, String, app, approvedMediaCacheDirectories, backgroundTasks, checkForUpdates, console, crypto, dialog, domainCommandJournal, domainHealthService, exiftoolPath, findLatestPhotoshop, fs, getConfigPath, getLogDir, getResourceBirthdaysPath, getRunConfig, getUserBirthdaysPath, ipcMain, mainWindow, mediaRuntimeState, openAllowedExternalUrl, path, pluginService, privacyService, process, processSupervisor, readSavedConfig, releaseWorkspaceWatchPath, screen, shell, spawn, suppressWorkspaceWatchPath, telemetryService, thumbnailService, undefined, writeLog } = context;
  ipcMain.handle('domain-health-status', () => ({
    success: true,
    domains: domainHealthService?.status?.() || [],
    commands: domainCommandJournal?.status?.().filter(command => command.status !== 'completed') || [],
  }));
  ipcMain.handle('domain-command-retry', (_event, commandId) => {
    const normalized = String(commandId || '').trim();
    if (!/^[a-z0-9._:-]{1,128}$/i.test(normalized)) return { success: false, error: '无效的跨域任务标识' };
    const retried = Boolean(domainCommandJournal?.retryDead?.(normalized));
    return retried ? { success: true } : { success: false, error: '任务不存在或尚未进入失败队列' };
  });
  const activePythonTasks = new Map();
  const rememberPythonTask = (requestId, invocationId, task) => {
    const requests = activePythonTasks.get(requestId) || new Map();
    requests.set(invocationId, task);
    activePythonTasks.set(requestId, requests);
  };
  const forgetPythonTask = (requestId, invocationId) => {
    const requests = activePythonTasks.get(requestId);
    if (!requests) return;
    requests.delete(invocationId);
    if (!requests.size) activePythonTasks.delete(requestId);
  };
  let advancedOperation = null;

  const componentRoot = componentId => path.join(pluginService.installRoot, String(componentId));
  const teamRetouchRoot = () => componentRoot('team-retouch');
  const advancedStateRoot = () => path.join(teamRetouchRoot(), 'advanced');
  const defaultAdvancedInstallRoot = () => path.join(advancedStateRoot(), 'wsl', 'PhotoFlowNative');
  const legacyAdvancedInstallRoot = () => path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'PhotoFlow', 'wsl', 'PhotoFlowNative');
  const readAdvancedStorage = async () => {
    let installRoot = '';
    try {
      const raw = await fs.promises.readFile(path.join(advancedStateRoot(), 'install-state.json'), 'utf8');
      installRoot = String(JSON.parse(raw.replace(/^\uFEFF/, '')).installRoot || '');
    } catch { /* fall through to known locations */ }
    const candidates = [installRoot, defaultAdvancedInstallRoot(), legacyAdvancedInstallRoot()].filter(Boolean);
    let vhdPath = '';
    let sizeBytes = 0;
    for (const candidate of candidates) {
      const possibleVhd = path.join(candidate, 'ext4.vhdx');
      const stat = await fs.promises.stat(possibleVhd).catch(() => null);
      if (!stat?.isFile()) continue;
      installRoot = candidate;
      vhdPath = possibleVhd;
      sizeBytes = stat.size;
      break;
    }
    installRoot ||= defaultAdvancedInstallRoot();
    let probePath = installRoot;
    while (!fs.existsSync(probePath) && path.dirname(probePath) !== probePath) probePath = path.dirname(probePath);
    const disk = await fs.promises.statfs(probePath).catch(() => null);
    const freeBytes = disk ? Number(disk.bavail) * Number(disk.bsize) : 0;
    return { installRoot, vhdPath, sizeBytes, freeBytes };
  };

  const componentStatusCachePath = path.join(app.getPath('userData'), 'component-status-cache.json');
  const componentRuntimeProbeTtlMs = 24 * 60 * 60 * 1000;
  const componentRuntimeRetryDelayMs = 30 * 60 * 1000;
  let componentStatusCache = { updatedAt: 0, lastDetailedAt: 0, lastDetailedAttemptAt: 0, components: [], integrityTokens: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(componentStatusCachePath, 'utf8'));
    if (Array.isArray(parsed?.components)) componentStatusCache = parsed;
  } catch { /* the cache is optional */ }
  let componentStatusDirty = false;
  let componentStatusRefreshActive = false;
  let componentStatusRefreshActiveForce = false;
  let componentStatusGeneration = 0;
  let componentStatusRefreshTimer = null;
  let componentStatusForceQueued = false;

  const mergeCachedComponentStatuses = components => components.map(component => {
    const cached = componentStatusCache.components.find(item => item.id === component.id);
    const compatibleCache = cached
      && cached.installed === component.installed
      && String(cached.version || '') === String(component.version || '');
    return {
      ...(compatibleCache ? cached : {}),
      ...component,
      sizeBytes: compatibleCache ? Number(cached.sizeBytes || 0) : Number(component.sizeBytes || 0),
      packagePath: componentRoot(component.id),
    };
  });

  const refreshDetailedComponentStatuses = async (task, { forceRuntimeProbe = false } = {}) => {
    const refreshGeneration = componentStatusGeneration;
    task?.report(5, '正在后台读取组件占用空间');
    const listedComponents = pluginService.list();
    const integrityTokens = {};
    for (const component of listedComponents) {
      if (!component.installed || component.source !== 'user') continue;
      try { integrityTokens[component.id] = pluginService.componentIntegrityToken(component.id, component.path); }
      catch { integrityTokens[component.id] = ''; }
    }
    const reusableIntegrity = listedComponents.every(component => {
      const cached = componentStatusCache.components.find(item => item.id === component.id);
      if (!cached || cached.installed !== component.installed || String(cached.version || '') !== String(component.version || '')) return false;
      if (!component.installed || component.source !== 'user') return true;
      return Boolean(integrityTokens[component.id] && componentStatusCache.integrityTokens?.[component.id] === integrityTokens[component.id]);
    });
    const policy = decideComponentStatusRefresh({
      force: forceRuntimeProbe,
      dirty: componentStatusDirty,
      integrityReusable: reusableIntegrity,
      lastDetailedAt: componentStatusCache.lastDetailedAt,
      lastDetailedAttemptAt: componentStatusCache.lastDetailedAttemptAt,
      runtimeProbeTtlMs: componentRuntimeProbeTtlMs,
      failureRetryDelayMs: componentRuntimeRetryDelayMs,
    });
    if (!reusableIntegrity) {
      for (const component of listedComponents) {
        const token = integrityTokens[component.id];
        if (token && componentStatusCache.integrityTokens?.[component.id] === token) pluginService.seedIntegrityToken(component.id, component.path, token);
      }
    }
    const components = reusableIntegrity ? mergeCachedComponentStatuses(listedComponents) : await pluginService.listWithSizes();
    for (const component of components) component.packagePath = componentRoot(component.id);
    const gpu = components.find(component => component.id === 'team-retouch');
    let runtimeProbeSucceeded = true;
    if (gpu?.installed && policy.shouldProbeRuntime) {
      try {
        const probe = await pluginService.runJson('team-retouch', ['probe'], 60000);
        const runtimeAvailable = Boolean(probe.componentAvailable ?? probe.cpuAvailable);
        Object.assign(gpu, {
          runtimeAvailable,
          gpuAvailable: Boolean(probe.gpuAvailable),
          advancedAvailable: Boolean(probe.advancedAvailable),
          mergeAvailable: Boolean(probe.mergeAvailable),
          identityAvailable: Boolean(probe.identityAvailable),
          faceBackend: probe.faceBackend || '',
          bodyBackend: probe.bodyBackend || '',
          identityError: probe.identityError || '',
          provider: probe.provider || '',
          advancedProvider: probe.advancedAvailable ? 'PairDETR + SAM 2.1 · NVIDIA CUDA' : '',
          providers: Array.isArray(probe.providers) ? probe.providers : [],
          runtimeError: runtimeAvailable ? '' : (probe.runtimeError || probe.error || ''),
          gpuError: probe.gpuAvailable || !runtimeAvailable ? '' : (probe.gpuError || probe.error || ''),
          advancedError: probe.advancedAvailable ? '' : (probe.advancedError || ''),
        });
      } catch (error) {
        runtimeProbeSucceeded = false;
        const runtimeError = error.message || String(error);
        Object.assign(gpu, {
          runtimeAvailable: false,
          gpuAvailable: false,
          advancedAvailable: false,
          mergeAvailable: false,
          identityAvailable: false,
          faceBackend: '',
          bodyBackend: '',
          identityError: runtimeError,
          provider: '',
          advancedProvider: '',
          providers: [],
          runtimeError,
          gpuError: runtimeError,
          advancedError: runtimeError,
        });
      }
      const storage = await readAdvancedStorage();
      Object.assign(gpu, {
        advancedSizeBytes: storage.sizeBytes,
        advancedFreeBytes: storage.freeBytes,
        advancedState: gpu.advancedAvailable ? 'ready' : storage.vhdPath ? 'repair-needed' : 'not-installed',
      });
    }
    const probeTimestamps = nextComponentProbeTimestamps({
      attempted: policy.shouldProbeRuntime,
      succeeded: runtimeProbeSucceeded,
      lastDetailedAt: componentStatusCache.lastDetailedAt,
      lastDetailedAttemptAt: componentStatusCache.lastDetailedAttemptAt,
    });
    componentStatusCache = {
      updatedAt: Date.now(),
      ...probeTimestamps,
      components,
      integrityTokens,
    };
    componentStatusDirty = componentStatusGeneration !== refreshGeneration;
    await fs.promises.writeFile(componentStatusCachePath, JSON.stringify(componentStatusCache), 'utf8').catch(error => {
      writeLog('warn', 'Unable to persist component status cache', { error: error.message || String(error) });
    });
    task?.report(100, '组件状态已刷新');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('components-status-changed', {
      success: true,
      components,
      installPath: pluginService.installRoot,
    });
    return { count: components.length };
  };

  const queueComponentStatusRefresh = (force = false) => {
    if (componentStatusRefreshActive) {
      componentStatusForceQueued ||= force && !componentStatusRefreshActiveForce;
      return;
    }
    if (componentStatusRefreshTimer) {
      if (!force) return;
      clearTimeout(componentStatusRefreshTimer);
      componentStatusRefreshTimer = null;
    }
    if (!force && !componentStatusDirty && Date.now() - Number(componentStatusCache.updatedAt || 0) < 5 * 60 * 1000) return;
    const execute = async task => {
      try { return await refreshDetailedComponentStatuses(task, { forceRuntimeProbe: force }); }
      finally {
        componentStatusRefreshActive = false;
        componentStatusRefreshActiveForce = false;
        if (componentStatusDirty || componentStatusForceQueued) {
          const queuedForce = componentStatusForceQueued || componentStatusDirty;
          componentStatusForceQueued = false;
          setTimeout(() => queueComponentStatusRefresh(queuedForce), 100);
        }
      }
    };
    const launch = () => {
      componentStatusRefreshTimer = null;
      if (componentStatusRefreshActive) return;
      componentStatusRefreshActive = true;
      componentStatusRefreshActiveForce = force;
      if (!backgroundTasks?.run) {
        void execute().catch(error => writeLog('warn', 'Background component status refresh failed', { error: error.message || String(error) }));
        return;
      }
      const run = () => backgroundTasks.run({
        type: 'component-status-refresh',
        title: '刷新组件状态',
        dedupeKey: 'component-status-refresh',
        cancellable: false,
      }, execute, run);
      void run().catch(error => writeLog('warn', 'Background component status refresh failed', { error: error.message || String(error) }));
    };
    componentStatusRefreshTimer = setTimeout(launch, force ? 100 : 15000);
  };

  const invalidateComponentStatus = () => {
    componentStatusGeneration += 1;
    componentStatusDirty = true;
    queueComponentStatusRefresh(true);
  };

  backgroundTasks?.registerTypeRestartFactory?.('component-status-refresh', task => {
    componentStatusRefreshActive = true;
    const execute = async taskContext => {
      try { return await refreshDetailedComponentStatuses(taskContext); }
      finally { componentStatusRefreshActive = false; }
    };
    return backgroundTasks.run({
      id: task.id,
      type: 'component-status-refresh',
      title: '刷新组件状态',
      dedupeKey: 'component-status-refresh',
      cancellable: false,
    }, execute);
  }, { autoRestart: true });

  const queueSystemFilesystemCleanup = (paths, title, restartTask = null) => {
    const allowedRoots = [app.getPath('temp'), app.getPath('userData'), pluginService.installRoot].filter(Boolean).map(candidate => path.resolve(candidate));
    const targets = [...new Set((paths || []).filter(Boolean).map(candidate => path.resolve(candidate)))].filter(target => allowedRoots.some(root => {
      const relative = path.relative(root, target);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }));
    if (!targets.length) return;
    const execute = async task => {
      task?.report(10, title);
      for (const target of targets) await fs.promises.rm(target, { recursive: true, force: true }).catch(error => {
        writeLog('warn', 'Deferred system cleanup failed', { path: target, error: error.message || String(error) });
      });
      task?.report(100, '清理完成');
      return { removedCount: targets.length };
    };
    if (!backgroundTasks?.run) {
      setTimeout(() => void execute(), 0);
      return;
    }
    const dedupeKey = `system-filesystem-cleanup:${crypto.randomUUID()}`;
    const run = () => backgroundTasks.run({
      ...(restartTask?.id ? { id: restartTask.id } : {}),
      type: 'system-filesystem-cleanup',
      title,
      dedupeKey,
      cancellable: false,
      metadata: { targets, title },
    }, execute, run);
    if (restartTask?.id) return run();
    setTimeout(() => void run().catch(error => writeLog('warn', 'Deferred system cleanup failed', { error: error.message || String(error) })), 250);
  };
  backgroundTasks?.registerTypeRestartFactory?.('system-filesystem-cleanup', task => queueSystemFilesystemCleanup(task.metadata?.targets || [], task.metadata?.title || task.title, task));

  const resolveAdvancedInstaller = (component, fileName) => app.isPackaged
    ? path.join(component.path, 'advanced-installer', fileName)
    : path.resolve(component.path, '..', '..', 'scripts', fileName);

  const resolvePreparedPackage = async (packageRoot, pattern, description) => {
    await fs.promises.mkdir(packageRoot, { recursive: true });
    const entries = await fs.promises.readdir(packageRoot, { withFileTypes: true });
    const archives = entries
      .filter(entry => entry.isFile() && pattern.test(entry.name))
      .map(entry => path.join(packageRoot, entry.name));
    if (archives.length > 1) throw new Error(`组件安装包目录中存在多个${description}版本，请只保留一个 ZIP`);
    if (archives.length === 1) return archives[0];
    throw new Error(`未在组件安装包目录中找到${description}：${packageRoot}`);
  };
  const resolveAdvancedPackage = () => resolvePreparedPackage(teamRetouchRoot(), /^PhotoFlow-team-retouch-advanced-.*\.zip$/i, '照片流高级引擎包');
  const resolveComponentPackage = componentId => resolvePreparedPackage(pluginService.installRoot, new RegExp(`^PhotoFlow-${String(componentId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(?!identity-models-|advanced-).*-${process.platform}-${process.arch}\\.zip$`, 'i'), `“${componentId}”组件包`);
  const resolvePackageForDeletion = async (kind, componentId = '') => {
    let archivePath;
    let allowedRoot;
    if (kind === 'advanced') {
      archivePath = await resolveAdvancedPackage();
      allowedRoot = teamRetouchRoot();
    } else if (kind === 'component') {
      const known = pluginService.list().find(component => component.id === componentId);
      if (!known) throw new Error(`未知组件：${componentId}`);
      archivePath = await resolveComponentPackage(componentId);
      allowedRoot = pluginService.installRoot;
    } else {
      throw new Error('不支持的安装包类型');
    }
    const resolvedRoot = path.resolve(allowedRoot);
    const resolvedArchive = path.resolve(archivePath);
    const relative = path.relative(resolvedRoot, resolvedArchive);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(resolvedArchive) !== resolvedRoot || path.extname(resolvedArchive).toLowerCase() !== '.zip') {
      throw new Error('安装包路径校验失败');
    }
    return resolvedArchive;
  };

  const runPackageCommand = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-64000); });
    child.stderr.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-64000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(output.trim() || `安装包读取失败（退出代码 ${code}）`)));
  });
  const extractPreparedPackage = async (archivePath, target) => {
    const listing = await runPackageCommand('tar.exe', ['-tf', archivePath]);
    const entries = String(listing).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!entries.length) throw new Error('安装包为空');
    for (const entry of entries) {
      const normalized = entry.replace(/\\/g, '/');
      if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some(segment => segment === '..')) throw new Error(`安装包包含不安全路径：${entry}`);
    }
    await fs.promises.mkdir(target, { recursive: true });
    await runPackageCommand('tar.exe', ['-xf', archivePath, '-C', target]);
  };

  const installerProgress = message => {
    const text = String(message || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    if (!text) return null;
    const markers = [
      ['Checking WSL', 2, '正在检查 WSL 2、NVIDIA 驱动和磁盘空间'],
      ['Extracting verified package', 8, '正在解压高级引擎离线包'],
      ['Verifying package SHA256', 48, '正在校验离线包完整性与版本'],
      ['Replacing the registered', 65, '正在替换需要修复的高级环境'],
      ['Installing PhotoFlowNative', 72, '正在安装照片流本地增强环境虚拟磁盘'],
      ['offline environment is ready', 97, '高级引擎离线环境准备完成'],
    ];
    const marker = markers.find(([needle]) => text.includes(needle));
    return marker ? { phase: 'installing', progress: marker[1], message: marker[2] } : null;
  };

  const runAdvancedPowerShell = (event, scriptPath, args = []) => new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
      cwd: path.dirname(scriptPath), windowsHide: true,
    });
    let output = '';
    const consume = chunk => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-16000);
      const progress = installerProgress(text);
      if (progress && !event.sender.isDestroyed()) event.sender.send('team-retouch-advanced-progress', progress);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(output.trim() || `高级环境操作失败（退出代码 ${code}）`)));
  });

  ipcMain.on('renderer-error-log', (_event, message, details) => {
    const text = String(message || '未知错误').slice(0, 500);
    const detailText = String(details || '').slice(0, 4000);
    const isCrash = /(?:Uncaught|界面渲染失败|React 界面渲染失败)/i.test(text)
      && !/(?:\[hmr\]|validateDOMNesting)/i.test(`${text}\n${detailText}`);
    writeLog(isCrash ? 'error' : 'warn', `Renderer: ${text}`, detailText);
    if (!isCrash) return;
    const error = new Error(String(message || 'Renderer error'));
    error.stack = String(details || error.stack || '');
    telemetryService?.reportCrash('renderer_error', error);
  });

  ipcMain.on('telemetry-track', (_event, eventName, properties) => {
    telemetryService?.track(eventName, properties);
  });
  
  ipcMain.on('open-external', (_event, url) => {
    void openAllowedExternalUrl(url).catch(error => writeLog('warn', 'Blocked external URL', { url, error: error.message || String(error) }));
  });

  ipcMain.handle('privacy-consent-state', async () => privacyService.getState());
  ipcMain.handle('privacy-consent-save', async (_event, request) => {
    try {
      const state = await privacyService.saveConsent(request);
      return { success: true, state };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  ipcMain.handle('privacy-open-legal-document', async (_event, documentId) => privacyService.openLegalDocument(documentId));
  ipcMain.handle('privacy-clear-telemetry-local-data', async () => {
    try {
      telemetryService?.clearLocalData();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('check-for-updates', async () => checkForUpdates());
  ipcMain.handle('submit-feedback', async (_event, message) => telemetryService.submitFeedback(message));
  
  ipcMain.handle('set-theme', async (_event, theme) => {
    if (!mainWindow) return;
    const isDark = theme === 'dark';
    mainWindow.setBackgroundColor(isDark ? '#030407' : '#f8fafc');
  });
  
  ipcMain.on('window-minimize', event => BrowserWindow.fromWebContents(event.sender)?.minimize());
  
  ipcMain.handle('window-toggle-maximize', event => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) return false;
    if (targetWindow.isMaximized()) targetWindow.unmaximize();
    else targetWindow.maximize();
    return targetWindow.isMaximized();
  });
  
  ipcMain.on('window-close', event => BrowserWindow.fromWebContents(event.sender)?.close());
  
  ipcMain.handle('window-is-maximized', event => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);
  ipcMain.handle('window-set-fullscreen', (event, enabled) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) return false;
    targetWindow.setFullScreen(Boolean(enabled));
    return targetWindow.isFullScreen();
  });

  ipcMain.handle('cursor-screen-point', () => screen.getCursorScreenPoint());
  
  ipcMain.handle('components-list', async (_event, force = false) => {
    const components = mergeCachedComponentStatuses(pluginService.list());
    queueComponentStatusRefresh(force === true);
    return { success: true, components, installPath: pluginService.installRoot };
  });
  
  ipcMain.handle('components-open-folder', async (_event, componentId = '') => {
    try {
      const installRoot = pluginService.ensureInstallRoot();
      let installPath = installRoot;
      if (componentId) {
        const known = pluginService.list().find(component => component.id === componentId);
        if (!known) throw new Error(`未知组件：${componentId}`);
        installPath = componentRoot(componentId);
        await fs.promises.mkdir(installPath, { recursive: true });
      }
      const error = await shell.openPath(installPath);
      if (error) throw new Error(error);
      return { success: true, path: installPath };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('logs-open-folder', async () => {
    try {
      const logDir = getLogDir();
      const error = await shell.openPath(logDir);
      if (error) throw new Error(error);
      return { success: true, path: logDir };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('logs-clear', async () => {
    try {
      let deletedCount = 0;
      const logDir = getLogDir();
      for (const fileName of await fs.promises.readdir(logDir)) {
        // Keep the operation scoped to files created by PhotoFlow's logger.
        if (!/^photoflow-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) continue;
        const filePath = path.join(logDir, fileName);
        const stat = await fs.promises.lstat(filePath).catch(() => null);
        if (!stat?.isFile()) continue;
        await fs.promises.unlink(filePath);
        deletedCount += 1;
      }
      return { success: true, deletedCount };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('interface-cache-clear', async event => {
    try {
      const targetSession = event.sender.session;
      const clearedBytes = await targetSession.getCacheSize().catch(() => 0);
      await targetSession.clearCache();
      return { success: true, clearedBytes };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('components-install', async (_event, componentId) => {
    let stagingPath = '';
    let backupPath = '';
    let packageStagePath = '';
    try {
      if (!app.isPackaged) throw new Error('开发环境组件由源码提供，请在打包版本中测试安装');
      const knownComponent = pluginService.list().find(component => component.id === componentId);
      if (!knownComponent) throw new Error(`未知组件：${componentId}`);
      const archivePath = await resolveComponentPackage(componentId);
      const packageSizeBytes = (await fs.promises.stat(archivePath)).size;
      packageStagePath = path.join(app.getPath('temp'), `photoflow-component-package-${process.pid}-${Date.now()}`);
      await extractPreparedPackage(archivePath, packageStagePath);
      const selectedPath = packageStagePath;
      const directManifest = path.join(selectedPath, 'component.json');
      const nestedPath = path.join(selectedPath, String(componentId));
      const nestedRuntimePath = path.join(nestedPath, 'runtime');
      const componentRoot = fs.existsSync(directManifest) ? selectedPath : fs.existsSync(path.join(nestedRuntimePath, 'component.json')) ? nestedRuntimePath : nestedPath;
      const manifestPath = path.join(componentRoot, 'component.json');
      if (!fs.existsSync(manifestPath)) throw new Error('所选文件夹中没有 component.json');
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      if (manifest.id !== componentId) throw new Error(`组件 ID 不匹配：需要 ${componentId}，实际为 ${manifest.id || '未填写'}`);
      if (Number(manifest.apiVersion) !== 1) throw new Error(`组件接口版本不兼容：${manifest.apiVersion || '未填写'}`);
      const entrypoints = manifest.entrypoints || {};
      const relativeEntry = entrypoints[`${process.platform}-${process.arch}`] || entrypoints[process.platform] || entrypoints.default;
      if (typeof relativeEntry !== 'string' || !relativeEntry.trim()) throw new Error('组件没有适用于当前系统的入口文件');
      const sourceEntry = path.resolve(componentRoot, relativeEntry);
      const sourceRelative = path.relative(componentRoot, sourceEntry);
      if (!sourceRelative || sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) throw new Error('组件入口路径无效');
      if (!(await fs.promises.stat(sourceEntry).catch(() => null))?.isFile()) throw new Error(`组件入口不存在：${relativeEntry}`);
      for (const relativeFile of Array.isArray(manifest.requiredFiles) ? manifest.requiredFiles : []) {
        if (typeof relativeFile !== 'string' || !relativeFile.trim()) throw new Error('组件必需文件路径无效');
        const sourceFile = path.resolve(componentRoot, relativeFile);
        const requiredRelative = path.relative(componentRoot, sourceFile);
        if (!requiredRelative || requiredRelative.startsWith('..') || path.isAbsolute(requiredRelative)) throw new Error(`组件必需文件路径无效：${relativeFile}`);
        if (!(await fs.promises.stat(sourceFile).catch(() => null))?.isFile()) throw new Error(`组件必需文件不存在：${relativeFile}`);
      }
      await pluginService.verifyComponentDirectoryAsync(componentId, componentRoot, true);

      const installRoot = pluginService.ensureInstallRoot();
      const container = path.join(installRoot, String(componentId));
      await fs.promises.mkdir(container, { recursive: true });
      const destination = path.join(container, 'runtime');
      stagingPath = path.join(installRoot, `.${componentId}-install-${process.pid}-${Date.now()}`);
      await fs.promises.cp(componentRoot, stagingPath, { recursive: true, force: false, errorOnExist: true });
      if (fs.existsSync(destination)) {
        backupPath = path.join(installRoot, `.${componentId}-backup-${process.pid}-${Date.now()}`);
        await fs.promises.rename(destination, backupPath);
      }
      try {
        await fs.promises.rename(stagingPath, destination);
        stagingPath = '';
      } catch (error) {
        if (backupPath && !fs.existsSync(destination)) await fs.promises.rename(backupPath, destination).catch(() => undefined);
        backupPath = '';
        throw error;
      }
      const cleanupPaths = [backupPath, packageStagePath].filter(Boolean);
      backupPath = '';
      packageStagePath = '';
      queueSystemFilesystemCleanup(cleanupPaths, `清理“${componentId}”组件旧文件`);
      invalidateComponentStatus();
      writeLog('info', 'Component installed', { componentId, destination });
      return { success: true, packageSizeBytes };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    } finally {
      if (stagingPath) await fs.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      if (backupPath) await fs.promises.rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
      if (packageStagePath) await fs.promises.rm(packageStagePath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('components-delete-package', async (_event, kind, componentId = '') => {
    try {
      const archivePath = await resolvePackageForDeletion(String(kind || ''), String(componentId || ''));
      const stat = await fs.promises.stat(archivePath);
      if (!stat.isFile()) throw new Error('安装包不是普通文件');
      await fs.promises.unlink(archivePath);
      writeLog('info', 'Installed package deleted after user confirmation', { kind, componentId, archivePath, deletedBytes: stat.size });
      return { success: true, deletedBytes: stat.size };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('components-uninstall', async (_event, componentId) => {
    try {
      if (!app.isPackaged) throw new Error('开发环境组件由源码提供，不能在应用内卸载');
      const component = pluginService.list().find(item => item.id === componentId);
      if (!component?.installed) throw new Error('组件尚未安装');
      if (component.source !== 'user') throw new Error('此组件不在用户组件目录中，不能通过组件管理卸载');
      const installRoot = path.resolve(pluginService.installRoot);
      const componentPath = path.resolve(component.path);
      const containerPath = path.basename(componentPath) === 'runtime' ? path.dirname(componentPath) : componentPath;
      const relative = path.relative(installRoot, containerPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(containerPath) !== componentId) throw new Error('组件目录校验失败');
      await shell.trashItem(containerPath);
      invalidateComponentStatus();
      writeLog('info', 'Component uninstalled', { componentId, componentPath: containerPath });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('team-retouch-advanced-preflight', async event => {
    if (advancedOperation) return { success: false, error: '另一项高级环境操作正在进行' };
    try {
      const component = pluginService.list().find(item => item.id === 'team-retouch');
      if (!component?.installed) throw new Error('请先安装“团片协作”基础组件');
      const installer = resolveAdvancedInstaller(component, 'setup-team-retouch-advanced.ps1');
      if (!(await fs.promises.stat(installer).catch(() => null))?.isFile()) throw new Error('高级环境离线安装器未随组件提供');
      advancedOperation = runAdvancedPowerShell(event, installer, ['-CheckOnly']);
      const output = await advancedOperation;
      const message = output.split(/\r?\n/).find(line => line.includes('OFFLINE_PREFLIGHT_OK'))?.split('|').slice(1).join(' · ') || 'WSL 2、NVIDIA 显卡与磁盘空间检查通过';
      return { success: true, message };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    } finally {
      advancedOperation = null;
    }
  });

  ipcMain.handle('team-retouch-advanced-install', async (event, options = {}) => {
    if (advancedOperation) return { success: false, error: '另一项高级环境操作正在进行' };
    try {
      const component = pluginService.list().find(item => item.id === 'team-retouch');
      if (!component?.installed) throw new Error('请先安装“团片协作”基础组件');
      const installer = resolveAdvancedInstaller(component, 'setup-team-retouch-advanced.ps1');
      if (!(await fs.promises.stat(installer).catch(() => null))?.isFile()) throw new Error('高级环境安装器未随组件提供，请重新构建或安装组件');
      const packagePath = await resolveAdvancedPackage();
      const packageSizeBytes = (await fs.promises.stat(packagePath)).size;
      const installRoot = defaultAdvancedInstallRoot();
      if (!event.sender.isDestroyed()) event.sender.send('team-retouch-advanced-progress', { phase: 'starting', progress: 1, message: '正在读取高级引擎离线包' });
      advancedOperation = runAdvancedPowerShell(event, installer, ['-InstallRoot', installRoot, '-PackagePath', packagePath, '-ExpectedComponentVersion', component.version, ...(options.repair ? ['-Repair'] : [])]);
      await advancedOperation;
      if (!event.sender.isDestroyed()) event.sender.send('team-retouch-advanced-progress', { phase: 'verifying', progress: 98, message: '正在实际加载 PairDETR 与 SAM 2.1' });
      const runtimeProbe = await pluginService.runJson('team-retouch', ['probe-advanced-runtime'], 4 * 60 * 1000);
      if (!runtimeProbe.pairDetrReady || !runtimeProbe.sam2Ready) throw new Error('高级模型服务没有全部进入可用状态');
      if (!event.sender.isDestroyed()) event.sender.send('team-retouch-advanced-progress', { phase: 'complete', progress: 100, message: '高级引擎安装并验证完成' });
      writeLog('info', 'Team retouch advanced environment installed from offline package', { installRoot, packagePath, repair: Boolean(options.repair) });
      invalidateComponentStatus();
      return { success: true, packageSizeBytes };
    } catch (error) {
      writeLog('error', 'Unable to install team retouch advanced environment', { error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    } finally {
      advancedOperation = null;
    }
  });

  ipcMain.handle('team-retouch-advanced-uninstall', async event => {
    if (advancedOperation) return { success: false, error: '另一项高级环境操作正在进行' };
    try {
      const component = pluginService.list().find(item => item.id === 'team-retouch');
      if (!component?.installed) throw new Error('团片协作组件未安装');
      const uninstaller = resolveAdvancedInstaller(component, 'uninstall-team-retouch-advanced.ps1');
      if (!(await fs.promises.stat(uninstaller).catch(() => null))?.isFile()) throw new Error('高级环境卸载器不存在');
      if (!event.sender.isDestroyed()) event.sender.send('team-retouch-advanced-progress', { phase: 'uninstalling', progress: 20, message: '正在停止并删除高级引擎' });
      advancedOperation = runAdvancedPowerShell(event, uninstaller);
      await advancedOperation;
      invalidateComponentStatus();
      writeLog('info', 'Team retouch advanced environment uninstalled');
      return { success: true };
    } catch (error) {
      writeLog('error', 'Unable to uninstall team retouch advanced environment', { error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    } finally {
      advancedOperation = null;
    }
  });

  ipcMain.handle('cancel-python', async (_event, requestId) => {
    const normalizedRequestId = String(requestId || '');
    const tasks = [...(activePythonTasks.get(normalizedRequestId)?.values() || [])];
    const coordinatorResults = tasks.map(task => task.backgroundTaskId && backgroundTasks?.cancel?.(task.backgroundTaskId) === true);
    const coordinatorCancelled = coordinatorResults.some(Boolean);
    if (!tasks.length) return coordinatorCancelled ? { success: true } : { success: false, error: '任务已经结束或不存在。' };
    try {
      const cancelFiles = [...new Set(tasks.map(task => task.cancelFile).filter(Boolean))];
      await Promise.all(cancelFiles.map(filePath => fs.promises.writeFile(filePath, 'cancel', 'utf8')));
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.on('run-python', async (event, scriptName, args = [], requestId = '', requestedPresentation) => {
    let command;
    let spawnArgs;
    try {
      const invocation = validateRendererPythonInvocation(scriptName, args, requestId);
      scriptName = invocation.scriptName;
      args = invocation.args;
      requestId = invocation.requestId;
    } catch (error) {
      writeLog('warn', 'Rejected renderer Python invocation', { scriptName, error: error.message || String(error) });
      event.sender.send('python-event', { type: 'error', message: '不允许启动该工具', scriptName: String(scriptName || ''), requestId: String(requestId || '') });
      event.sender.send('python-event', { type: 'complete', message: '任务未启动', data: { exitCode: 1 }, scriptName: String(scriptName || ''), requestId: String(requestId || '') });
      return;
    }
    const normalizedRequestId = String(requestId || '');
    const taskPresentation = normalizePythonTaskPresentation(requestedPresentation);
    const invocationId = crypto.randomUUID();
    const stageArgumentIndex = scriptName === 'classify.py' ? args.indexOf('--stage') : -1;
    const classifyStage = stageArgumentIndex >= 0 ? String(args[stageArgumentIndex + 1] || '') : '';
    const writesImportFiles = scriptName === 'classify.py' && ['plan', 'import', 'broll'].includes(classifyStage);
    const tracksImportTask = scriptName === 'classify.py' && ['plan', 'import', 'broll'].includes(classifyStage);
    const cancellableClassify = scriptName === 'classify.py' && ['plan', 'import', 'broll'].includes(classifyStage);
    const cancellable = (scriptName === 'catch.py' || scriptName === 'cut_video.py' || scriptName === 'ffmpeg_transcode.py' || cancellableClassify) && /^[a-z0-9-]{8,80}$/i.test(normalizedRequestId);
    const cancelFile = cancellable ? path.join(app.getPath('temp'), `photoflow-cancel-${normalizedRequestId}.flag`) : '';
    let runtimeArgs = cancellable ? [...args, '--cancel_file', cancelFile] : [...args];
    if (scriptName === 'classify.py' && ['plan', 'import', 'broll'].includes(classifyStage)) {
      try {
        const bundledExifTool = await exiftoolPath();
        if (bundledExifTool) runtimeArgs.push('--exiftool_path', String(bundledExifTool));
      } catch (error) {
        writeLog('warn', 'Unable to resolve bundled ExifTool for import metadata', { error: error.message || String(error) });
      }
    }
    const destinationArgumentIndex = scriptName === 'classify.py' ? args.indexOf('--dest_path') : -1;
    const importDestination = destinationArgumentIndex >= 0 ? path.resolve(String(args[destinationArgumentIndex + 1] || '')) : '';
    let backgroundTaskId = tracksImportTask ? `${normalizedRequestId}:${classifyStage}:${invocationId}` : '';
    let importTask = null;
    let toolTask = null;
    let importTargets = importDestination ? [importDestination] : [];
    if (tracksImportTask && normalizedRequestId) {
      const sdPathIndex = args.indexOf('--sd_path');
      const sourcePathsIndex = args.indexOf('--source_paths');
      const routeIndex = args.indexOf('--project_routes');
      let sourcePaths = sdPathIndex >= 0 ? [String(args[sdPathIndex + 1] || '')] : [];
      if (sourcePathsIndex >= 0) {
        try { sourcePaths = JSON.parse(String(args[sourcePathsIndex + 1] || '[]')).map(String); } catch { sourcePaths = []; }
      }
      if (routeIndex >= 0) {
        try {
          const routedTargets = Object.values(JSON.parse(String(args[routeIndex + 1] || '{}'))).map(value => String(value || '')).filter(Boolean).map(value => path.resolve(value));
          if (routedTargets.length) importTargets = [...new Set(routedTargets)];
        } catch { /* invalid route data is reported by the Python worker */ }
      }
      const directSource = args.includes('--direct_source');
      const destinationName = importDestination ? path.basename(importDestination) : '';
      const importTitle = classifyStage === 'plan' ? (directSource ? '分析底片素材' : '分析 SD 卡素材') : directSource ? '导入底片' : classifyStage === 'broll' ? '从 SD 卡导入花絮' : '从 SD 卡导入';
      importTask = backgroundTasks?.create?.({
        id: backgroundTaskId,
        type: 'project-file-operation',
        title: destinationName ? `${importTitle} · ${destinationName}` : importTitle,
        message: classifyStage === 'plan' ? '等待扫描素材' : '等待其他文件操作完成',
        runningMessage: classifyStage === 'plan' ? '正在读取拍摄日期并匹配项目' : '正在准备导入',
        concurrencyGroup: writesImportFiles ? (args.includes('--split_large_files') ? 'heavy-media' : 'disk-io') : '',
        concurrencyLimit: args.includes('--split_large_files') ? 1 : 3,
        concurrencyWriteLimit: args.includes('--split_large_files') ? 1 : 2,
        resourceAccess: writesImportFiles ? 'write' : 'read',
        resources: [...(writesImportFiles ? importTargets : []), ...sourcePaths].filter(Boolean),
        metadata: { operation: directSource ? 'import-negative' : 'import-sd', importStage: classifyStage, projectName: destinationName, phase: classifyStage === 'plan' ? 'scanning' : 'queued', destinationPath: importDestination, requestId: normalizedRequestId },
      }) || null;
      if (importTask && !importTask.deduplicated) {
        if (cancelFile) rememberPythonTask(normalizedRequestId, invocationId, { process: null, cancelFile, backgroundTaskId });
        importTask.context.signal.addEventListener('abort', () => {
          if (cancelFile) fs.promises.writeFile(cancelFile, 'cancel', 'utf8').catch(() => undefined);
        }, { once: true });
        try {
          await importTask.waitForStart();
        } catch (error) {
          importTask.cancelled();
          forgetPythonTask(normalizedRequestId, invocationId);
          if (cancelFile) fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
          event.sender.send('python-event', { type: 'cancelled', message: '导入已取消', scriptName, requestId });
          event.sender.send('python-event', { type: 'complete', message: '任务未启动', data: { exitCode: 0 }, scriptName, requestId });
          return;
        }
      }
    }
    const toolProfile = PYTHON_BACKGROUND_TASK_PROFILES[scriptName];
    if (!tracksImportTask && toolProfile && normalizedRequestId) {
      backgroundTaskId = `python-tool:${normalizedRequestId}`;
      const presentationMetadata = taskPresentation ? {
        presentationOwnerPageId: taskPresentation.ownerPageId,
        presentationPanelKind: taskPresentation.panelKind,
      } : {};
      const taskResources = pythonToolResourcePaths(scriptName, args, path);
      toolTask = backgroundTasks?.create?.({
        id: backgroundTaskId,
        type: toolProfile.type,
        title: taskPresentation?.title || toolProfile.title,
        message: '等待任务资源',
        runningMessage: '正在启动任务',
        cancellable,
        notificationPolicy: 'progress-toast',
        resumePolicy: 'atomic',
        concurrencyGroup: toolProfile.concurrencyGroup,
        concurrencyLimit: toolProfile.concurrencyLimit,
        concurrencyWriteLimit: toolProfile.concurrencyWriteLimit,
        resourceAccess: 'write',
        resources: taskResources,
        metadata: { scriptName, requestId: normalizedRequestId, phase: 'queued', ...presentationMetadata },
      }) || null;
      if (toolTask && !toolTask.deduplicated) {
        if (cancelFile) rememberPythonTask(normalizedRequestId, invocationId, { process: null, cancelFile, backgroundTaskId });
        toolTask.context.signal.addEventListener('abort', () => {
          if (cancelFile) fs.promises.writeFile(cancelFile, 'cancel', 'utf8').catch(() => undefined);
        }, { once: true });
        try {
          await toolTask.waitForStart();
        } catch (error) {
          toolTask.cancelled();
          forgetPythonTask(normalizedRequestId, invocationId);
          if (cancelFile) fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
          event.sender.send('python-event', { type: 'cancelled', message: '任务已取消', scriptName, requestId });
          event.sender.send('python-event', { type: 'complete', message: '任务未启动', data: { exitCode: 0 }, scriptName, requestId });
          return;
        }
      }
    }
    const importWatchSuppressedPaths = [];
    let importWatchFinalized = false;
    const importedMediaPaths = new Set();
    const finalizeImportWatch = succeeded => {
      if (!importWatchSuppressedPaths.length || importWatchFinalized) return;
      importWatchFinalized = true;
      for (const targetPath of importWatchSuppressedPaths) releaseWorkspaceWatchPath(targetPath, 250);
      if (!succeeded) return;
      setTimeout(() => {
        for (const targetPath of importWatchSuppressedPaths) {
          const changedPaths = [...importedMediaPaths].filter(candidate => {
            const relative = path.relative(targetPath, candidate);
            return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
          });
          if (changedPaths.length) {
            void thumbnailService?.syncChangedPaths(targetPath, changedPaths, mediaRuntimeState.activeMediaCacheConfig).catch(error => {
              writeLog('warn', 'Post-import thumbnail update deferred', { importDestination: targetPath, error: error.message || String(error) });
            });
          }
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-files-changed', {
            root: path.dirname(targetPath),
            fileName: path.basename(targetPath),
            eventType: 'rename',
          });
        }
      }, 600);
    };
    try {
      if (cancelFile) fs.rmSync(cancelFile, { force: true });
      ({ command, args: spawnArgs } = getRunConfig(scriptName, runtimeArgs));
      if (writesImportFiles) {
        for (const targetPath of importTargets) {
          if (!targetPath || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) continue;
          suppressWorkspaceWatchPath(targetPath);
          importWatchSuppressedPaths.push(targetPath);
        }
      }
    } catch (error) {
      importTask?.fail(error);
      toolTask?.fail(error);
      forgetPythonTask(normalizedRequestId, invocationId);
      event.sender.send('python-event', { type: 'error', message: error.message || String(error), scriptName, requestId });
      event.sender.send('python-event', {
        type: 'complete',
        message: '任务未启动',
        data: { exitCode: 1 },
        scriptName,
        requestId,
      });
      return;
    }
  
    // --- 插入权限修复代码开始 ---
    if (process.platform === 'darwin' && app.isPackaged) {
      try {
        // 检查文件是否存在并尝试赋予 755 权限 (rwxr-xr-x)
        if (fs.existsSync(command)) {
          fs.chmodSync(command, 0o755); 
          console.log(`Successfully set permissions for: ${command}`);
        }
      } catch (err) {
        console.error(`Failed to set permissions for ${command}:`, err);
      }
    }
  
    console.log(`Executing: ${command} ${spawnArgs.join(' ')}`);
  
    try {
      // 注意：windowsHide: true 可以隐藏弹出的黑框
      const managedProcess = processSupervisor?.launch({
        id: `python:renderer-tool:${invocationId}`,
        kind: 'python-job', command, args: spawnArgs, options: {}, ephemeral: true,
      });
      const pyProcess = managedProcess?.child || spawn(command, spawnArgs, { windowsHide: true });
      if (cancellable) rememberPythonTask(normalizedRequestId, invocationId, { process: pyProcess, cancelFile, backgroundTaskId });
      let stdoutBuffer = '';
      let importFailed = false;
      let importCancelled = false;
      let importProgress = 0;
      let toolFailed = false;
      let toolCancelled = false;
      let toolProgress = 0;
      const handlePythonOutputLine = line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const jsonMsg = JSON.parse(trimmed);
          managedProcess?.markHealthy({ protocol: 'renderer-python-events' });
          mainWindow.webContents.send('python-event', { ...jsonMsg, scriptName, requestId });
          if (jsonMsg.type === 'success' && Array.isArray(jsonMsg.data?.importedPaths)) {
            for (const importedPath of jsonMsg.data.importedPaths) {
              const resolved = path.resolve(String(importedPath || ''));
              if (importTargets.some(target => {
                const relative = path.relative(target, resolved);
                return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
              })) importedMediaPaths.add(resolved);
            }
          }
          if (importTask && !importTask.deduplicated) {
            if (jsonMsg.type === 'error') importFailed = true;
            if (jsonMsg.type === 'cancelled') importCancelled = true;
            if (jsonMsg.type === 'progress' || jsonMsg.type === 'status') {
              if (jsonMsg.type === 'progress' && Number.isFinite(Number(jsonMsg.progress))) importProgress = Number(jsonMsg.progress);
              importTask.context.report(importProgress, jsonMsg.message || '正在导入', {
                phase: jsonMsg.type === 'progress' ? 'copying' : 'scanning',
                bytesCopied: Number(jsonMsg.data?.bytesCopied) || 0,
                totalBytes: Number(jsonMsg.data?.totalBytes) || 0,
                filesCopied: Number(jsonMsg.data?.filesCopied) || 0,
                totalFiles: Number(jsonMsg.data?.totalFiles) || 0,
              });
            }
          }
          if (toolTask && !toolTask.deduplicated) {
            if (jsonMsg.type === 'error') toolFailed = true;
            if (jsonMsg.type === 'cancelled') toolCancelled = true;
            if (jsonMsg.type === 'progress' || jsonMsg.type === 'status') {
              if (jsonMsg.type === 'progress' && Number.isFinite(Number(jsonMsg.progress))) toolProgress = Number(jsonMsg.progress);
              toolTask.context.report(toolProgress, jsonMsg.message || `正在执行${toolProfile.title}`, {
                phase: jsonMsg.type === 'progress' ? 'processing' : 'starting',
                currentName: String(jsonMsg.data?.currentName || jsonMsg.data?.fileName || ''),
                processedCount: Number(jsonMsg.data?.processedCount ?? jsonMsg.data?.filesProcessed) || 0,
                totalCount: Number(jsonMsg.data?.totalCount ?? jsonMsg.data?.totalFiles) || 0,
              });
            }
          }
  
          if (jsonMsg.type === 'log' || jsonMsg.type === 'error') {
            mainWindow.webContents.send('python-log', {
              timestamp: new Date().toLocaleTimeString(),
              message: jsonMsg.message,
              type: jsonMsg.type === 'error' ? 'error' : 'info'
            });
          }
        } catch {
          console.log('Raw Python Output:', trimmed);
          mainWindow.webContents.send('python-log', {
            timestamp: new Date().toLocaleTimeString(),
            message: trimmed,
            type: 'info'
          });
        }
      };
  
      pyProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        lines.forEach(handlePythonOutputLine);
      });
  
      pyProcess.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
          console.error("Python Stderr:", message);
          mainWindow.webContents.send('python-log', {
              timestamp: new Date().toLocaleTimeString(),
              message: message,
              type: 'error'
          });
        }
      });
  
      pyProcess.on('close', (code) => {
        if (stdoutBuffer.trim()) handlePythonOutputLine(stdoutBuffer);
        stdoutBuffer = '';
        const cancelledByCoordinator = Boolean(importTask?.context?.signal.aborted);
        const toolCancelledByCoordinator = Boolean(toolTask?.context?.signal.aborted);
        if (cancelledByCoordinator && !importCancelled) {
          importCancelled = true;
          mainWindow.webContents.send('python-event', { type: 'cancelled', message: classifyStage === 'plan' ? '素材分析已取消' : '导入已取消', scriptName, requestId });
        } else if (toolCancelledByCoordinator && !toolCancelled) {
          toolCancelled = true;
          mainWindow.webContents.send('python-event', { type: 'cancelled', message: '任务已取消', scriptName, requestId });
        } else if (code !== 0 && importTask && !importFailed && !importCancelled) {
          importFailed = true;
          mainWindow.webContents.send('python-event', { type: 'error', message: classifyStage === 'plan' ? '素材分析失败' : `导入进程异常退出（代码 ${code}）`, scriptName, requestId });
        } else if (code !== 0 && toolTask && !toolFailed && !toolCancelled) {
          toolFailed = true;
          mainWindow.webContents.send('python-event', { type: 'error', message: `任务进程异常退出（代码 ${code}）`, scriptName, requestId });
        }
        // 可以在这里针对特定脚本做处理，比如 classify 退出不一定代表错误
        console.log(`${scriptName} finished with code ${code}`);
        mainWindow.webContents.send('python-log', {
            timestamp: new Date().toLocaleTimeString(),
            message: `${scriptName} Process finished`,
            type: code === 0 ? 'success' : 'warning'
        });
        mainWindow.webContents.send('python-event', {
          type: 'complete',
          message: code === 0 ? '任务进程已结束' : `任务进程异常退出（代码 ${code}）`,
          data: { exitCode: code },
          scriptName,
          requestId,
        });
        if (cancellable) {
          forgetPythonTask(normalizedRequestId, invocationId);
          fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
        }
        if (importTask && !importTask.deduplicated) {
          if (importCancelled || importTask.context.signal.aborted) importTask.cancelled();
          else if (code === 0 && !importFailed) importTask.complete(classifyStage === 'plan' ? '素材分析完成' : '导入完成');
          else importTask.fail(new Error(code === 0 ? '导入失败' : `导入进程异常退出（代码 ${code}）`));
        }
        if (toolTask && !toolTask.deduplicated) {
          if (toolCancelled || toolTask.context.signal.aborted) toolTask.cancelled();
          else if (code === 0 && !toolFailed) toolTask.complete(`${toolProfile.title}完成`);
          else toolTask.fail(new Error(code === 0 ? `${toolProfile.title}失败` : `任务进程异常退出（代码 ${code}）`));
        }
        finalizeImportWatch(classifyStage !== 'plan' && code === 0 && !importFailed && !importCancelled);
      });
      
      // 监听启动错误（比如 exe 不存在）
      pyProcess.on('error', (err) => {
         importTask?.fail(err);
         toolTask?.fail(err);
         finalizeImportWatch(false);
         if (cancellable) {
           forgetPythonTask(normalizedRequestId, invocationId);
           fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
         }
         console.error('Failed to start process:', err);
         mainWindow.webContents.send('python-event', {
           type: 'error',
           message: `Failed to launch ${scriptName}: ${err.message}`,
           scriptName,
           requestId
         });
      });
  
    } catch (e) {
      importTask?.fail(e);
      toolTask?.fail(e);
      forgetPythonTask(normalizedRequestId, invocationId);
      finalizeImportWatch(false);
      console.error("Spawn Error:", e);
      event.sender.send('python-event', {
        type: 'error',
        message: `Failed to launch ${scriptName}: ${(e && e.message) || String(e)}`,
        scriptName,
        requestId,
      });
      event.sender.send('python-event', {
        type: 'complete',
        message: '任务未启动',
        data: { exitCode: 1 },
        scriptName,
        requestId,
      });
    }
  });
  
  ipcMain.handle('getUserPath', async (event) => {
    try {
      const userPath = app.getPath('home').replace(/\\/g, '/');
      console.log('✅ User Path detected (Node.js):', userPath);
      return userPath;
  
    } catch (error) {
      console.error('❌ Error getting user path:', error);
      return "";
    }
  });
  
  ipcMain.handle('saveConfig', async (event, config) => {
    try {
      const customProjectCategories = normalizeCustomProjectCategories(config?.customProjectCategories);
      const workspacePaths = [config?.workspacePath, ...(Array.isArray(config?.workspacePaths) ? config.workspacePaths : [])]
        .map(value => String(value || '').trim())
        .filter((value, index, values) => value && values.findIndex(candidate => path.resolve(candidate).toLocaleLowerCase() === path.resolve(value).toLocaleLowerCase()) === index);
      const normalizedConfig = {
        ...config,
        smartImport: {
          ...config?.smartImport,
          autoMoveProjectAfterSdImport: normalizeSdImportAutoMove(config?.smartImport?.autoMoveProjectAfterSdImport),
        },
        workspacePath: workspacePaths[0] || '',
        workspacePaths,
        customProjectCategories,
        projectCategoryOrder: normalizeProjectCategoryOrder(config?.projectCategoryOrder, customProjectCategories),
        progressNamePresets: normalizeProgressNamePresets(config?.progressNamePresets),
        telemetry: {
          enabled: privacyService.hasCoreConsent(),
          crashReports: privacyService.hasCoreConsent(),
        },
      };
      const requestedCacheDirectory = String(config?.mediaCache?.directory || '').trim();
      const savedCacheDirectory = String(readSavedConfig()?.mediaCache?.directory || '').trim();
      if (requestedCacheDirectory && (!savedCacheDirectory || path.resolve(requestedCacheDirectory) !== path.resolve(savedCacheDirectory))
        && !approvedMediaCacheDirectories.has(path.resolve(requestedCacheDirectory))) {
        throw new Error('缓存目录必须通过系统文件夹选择器授权');
      }
      if (requestedCacheDirectory) approvedMediaCacheDirectories.add(path.resolve(requestedCacheDirectory));
      const configPath = getConfigPath();
      await fs.promises.writeFile(configPath, JSON.stringify(normalizedConfig, null, 2), 'utf-8');
      telemetryService?.syncConsent(normalizedConfig.telemetry);
      console.log('✅ Config saved to:', configPath);
      return { success: true };
    } catch (error) {
      console.error('❌ Failed to save config:', error);
      return { success: false, error: String(error) };
    }
  });

  const readBirthdays = () => {
    try {
      const userPath = getUserBirthdaysPath();
      if (!fs.existsSync(userPath)) {
        const resourcePath = getResourceBirthdaysPath();
        if (!fs.existsSync(resourcePath)) return {};
        console.log('Initialize birthdays.json from resources...');
        fs.copyFileSync(resourcePath, userPath);
      }
      const parsed = JSON.parse(fs.readFileSync(userPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      console.error('Error reading birthdays.json:', error);
      return {};
    }
  };

  const loadConfigSnapshot = () => {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return null;
    console.log('✅ Config loaded from:', configPath);
    const config = readSavedConfig();
    if (config?.mediaCache?.directory) approvedMediaCacheDirectories.add(path.resolve(config.mediaCache.directory));
    return config;
  };

  ipcMain.handle('loadConfig', async () => {
    try {
      const config = loadConfigSnapshot();
      if (config) return config;
      console.log('⚠️ No config file found, will use defaults');
      return null;
    } catch (error) {
      console.error('❌ Failed to load config:', error);
      return null;
    }
  });

  ipcMain.handle('load-startup-snapshot', async () => ({
    config: loadConfigSnapshot(),
    birthdays: readBirthdays(),
  }));
  
  ipcMain.handle('get-birthdays', async () => {
    return readBirthdays();
  });
  
  ipcMain.handle('save-birthdays', async (event, newContent) => {
    try {
      if (!newContent || typeof newContent !== 'object' || Array.isArray(newContent)) throw new Error('生日数据格式无效');
      const normalized = {};
      for (const [rawName, rawDate] of Object.entries(newContent)) {
        const name = String(rawName).trim();
        const match = String(rawDate).trim().match(/^(\d{1,2})(?:\.|月\.?)(\d{1,2})日?$/);
        if (!name || !match) throw new Error(`生日记录格式无效：${rawName || '未命名'}`);
        const month = Number(match[1]);
        const day = Number(match[2]);
        const probe = new Date(2000, month - 1, day);
        if (month < 1 || month > 12 || day < 1 || day > 31 || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
          throw new Error(`生日日期无效：${name}`);
        }
        normalized[name] = `${month}.${day}`;
      }
      // 始终写入用户目录，确保有权限
      const userPath = getUserBirthdaysPath();
      fs.writeFileSync(userPath, JSON.stringify(normalized, null, 4), 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('Error writing birthdays.json:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('getStorageDevices', async () => {
    try {
      return await listStorageDevices(process.platform);
    } catch (error) {
      console.error('Error getting storage devices:', error);
      throw error;
    }
  });

  // Kept for older renderer bundles during staged upgrades.
  ipcMain.handle('getDrives', async () => {
    try {
      return (await listStorageDevices(process.platform)).devices.map(device => device.mountPath);
    } catch (error) {
      console.error('Error getting drives:', error);
      return [];
    }
  });
  
  ipcMain.handle('choose-workspace-directory', async (_event, currentPath = '') => {
    const defaultPath = currentPath && fs.existsSync(currentPath) && fs.statSync(currentPath).isDirectory() ? currentPath : undefined;
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作文件夹',
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    });
    return choice.canceled ? { cancelled: true } : { path: choice.filePaths[0] };
  });

  ipcMain.handle('choose-import-source-files', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的底片文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '照片、RAW 与视频', extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'hif', 'arw', 'cr2', 'cr3', 'dng', 'nef', 'orf', 'mp4', 'mov', 'avi', 'crm', 'rwl', 'raf', '3fr', 'fff'] }],
    });
    return choice.canceled ? { cancelled: true, paths: [] } : { paths: choice.filePaths };
  });

  ipcMain.handle('choose-project-import-files', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的文件',
      properties: ['openFile', 'multiSelections'],
    });
    return choice.canceled ? { cancelled: true, paths: [] } : { paths: choice.filePaths };
  });

  ipcMain.handle('choose-video-files', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择视频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'crm', 'mts', 'm2ts', 'ts'] }],
    });
    return choice.canceled ? { cancelled: true, paths: [] } : { paths: choice.filePaths };
  });

  ipcMain.handle('choose-video-folder', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择包含视频的文件夹',
      properties: ['openDirectory'],
    });
    return choice.canceled ? { cancelled: true } : { path: choice.filePaths[0] };
  });
  
  ipcMain.handle('photoshop-status', async () => {
    const executable = await findLatestPhotoshop();
    return { available: Boolean(executable) };
  });
};

module.exports = { normalizeSdImportAutoMove, pythonToolResourcePaths, registerSystemIpc };
