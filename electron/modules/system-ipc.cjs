const registerSystemIpc = context => {
  const { Array, Boolean, BrowserWindow, Date, Error, INSPIRATION_PYTHON_TOOLS, JSON, MERGED_PYTHON_TOOLS, Object, String, app, approvedMediaCacheDirectories, backgroundTasks, checkForUpdates, console, crypto, dialog, findLatestPhotoshop, fs, getConfigPath, getLogDir, getResourceBirthdaysPath, getRunConfig, getUserBirthdaysPath, ipcMain, mainWindow, mediaRuntimeState, path, pluginService, privacyService, process, readSavedConfig, releaseWorkspaceWatchPath, screen, shell, spawn, suppressWorkspaceWatchPath, telemetryService, thumbnailService, undefined, writeLog } = context;
  const activePythonTasks = new Map();
  let advancedOperation = null;
  let activeClassifyWrite = null;

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
  let componentStatusCache = { updatedAt: 0, components: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(componentStatusCachePath, 'utf8'));
    if (Array.isArray(parsed?.components)) componentStatusCache = parsed;
  } catch { /* the cache is optional */ }
  let componentStatusDirty = false;
  let componentStatusRefreshActive = false;
  let componentStatusGeneration = 0;

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

  const refreshDetailedComponentStatuses = async task => {
    const refreshGeneration = componentStatusGeneration;
    task?.report(5, '正在后台读取组件占用空间');
    const components = await pluginService.listWithSizes();
    for (const component of components) component.packagePath = componentRoot(component.id);
    const gpu = components.find(component => component.id === 'team-retouch');
    if (gpu?.installed) {
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
        Object.assign(gpu, { runtimeAvailable: false, provider: '', providers: [], runtimeError: error.message || String(error) });
      }
      const storage = await readAdvancedStorage();
      Object.assign(gpu, {
        advancedSizeBytes: storage.sizeBytes,
        advancedFreeBytes: storage.freeBytes,
        advancedState: gpu.advancedAvailable ? 'ready' : storage.vhdPath ? 'repair-needed' : 'not-installed',
      });
    }
    componentStatusCache = { updatedAt: Date.now(), components };
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
    if (componentStatusRefreshActive) return;
    if (!force && !componentStatusDirty && Date.now() - Number(componentStatusCache.updatedAt || 0) < 5 * 60 * 1000) return;
    componentStatusRefreshActive = true;
    const execute = async task => {
      try { return await refreshDetailedComponentStatuses(task); }
      finally {
        componentStatusRefreshActive = false;
        if (componentStatusDirty) setTimeout(() => queueComponentStatusRefresh(true), 100);
      }
    };
    if (!backgroundTasks?.run) {
      setTimeout(() => void execute().catch(error => writeLog('warn', 'Background component status refresh failed', { error: error.message || String(error) })), 0);
      return;
    }
    const run = () => backgroundTasks.run({
      type: 'component-status-refresh',
      title: '刷新组件状态',
      dedupeKey: 'component-status-refresh',
      cancellable: false,
    }, execute, run);
    setTimeout(() => void run().catch(error => writeLog('warn', 'Background component status refresh failed', { error: error.message || String(error) })), 100);
  };

  const invalidateComponentStatus = () => {
    componentStatusGeneration += 1;
    componentStatusDirty = true;
    queueComponentStatusRefresh(true);
  };

  const queueSystemFilesystemCleanup = (paths, title) => {
    const targets = [...new Set((paths || []).filter(Boolean).map(candidate => path.resolve(candidate)))];
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
      type: 'system-filesystem-cleanup',
      title,
      dedupeKey,
      cancellable: false,
    }, execute, run);
    setTimeout(() => void run().catch(error => writeLog('warn', 'Deferred system cleanup failed', { error: error.message || String(error) })), 250);
  };

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
  
  ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
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

  ipcMain.handle('cursor-screen-point', () => screen.getCursorScreenPoint());
  
  ipcMain.handle('components-list', async () => {
    const components = mergeCachedComponentStatuses(pluginService.list());
    queueComponentStatusRefresh();
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
    const task = activePythonTasks.get(String(requestId || ''));
    if (!task) return { success: false, error: '任务已经结束或不存在。' };
    try {
      await fs.promises.writeFile(task.cancelFile, 'cancel', 'utf8');
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.on('run-python', (event, scriptName, args = [], requestId = '') => {
    let command;
    let spawnArgs;
    const normalizedRequestId = String(requestId || '');
    const stageArgumentIndex = scriptName === 'classify.py' ? args.indexOf('--stage') : -1;
    const classifyStage = stageArgumentIndex >= 0 ? String(args[stageArgumentIndex + 1] || '') : '';
    const writesImportFiles = scriptName === 'classify.py' && (classifyStage === 'import' || classifyStage === 'broll');
    if (writesImportFiles && activeClassifyWrite?.process && !activeClassifyWrite.process.killed && activeClassifyWrite.requestId !== normalizedRequestId) {
      event.sender.send('python-event', {
        type: 'error',
        message: '已有导入任务正在运行，请等待完成后再启动另一个导入任务。',
        scriptName,
        requestId,
      });
      return;
    }
    const cancellable = scriptName === 'catch.py' && /^[a-z0-9-]{8,80}$/i.test(normalizedRequestId);
    const cancelFile = cancellable ? path.join(app.getPath('temp'), `photoflow-cancel-${normalizedRequestId}.flag`) : '';
    const runtimeArgs = cancellable ? [...args, '--cancel_file', cancelFile] : args;
    const destinationArgumentIndex = scriptName === 'classify.py' ? args.indexOf('--dest_path') : -1;
    const importDestination = destinationArgumentIndex >= 0 ? path.resolve(String(args[destinationArgumentIndex + 1] || '')) : '';
    let importWatchSuppressed = false;
    let importWatchFinalized = false;
    const finalizeImportWatch = succeeded => {
      if (!importWatchSuppressed || importWatchFinalized) return;
      importWatchFinalized = true;
      releaseWorkspaceWatchPath(importDestination, 250);
      if (!succeeded) return;
      setTimeout(() => {
        void thumbnailService?.scanProject(importDestination, mediaRuntimeState.activeMediaCacheConfig).catch(error => {
          writeLog('warn', 'Post-import thumbnail scan deferred', { importDestination, error: error.message || String(error) });
        });
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-files-changed', {
          root: path.dirname(importDestination),
          fileName: path.basename(importDestination),
          eventType: 'rename',
        });
      }, 600);
    };
    try {
      if (cancelFile) fs.rmSync(cancelFile, { force: true });
      ({ command, args: spawnArgs } = getRunConfig(scriptName, runtimeArgs));
      if (importDestination && fs.existsSync(importDestination) && fs.statSync(importDestination).isDirectory()) {
        suppressWorkspaceWatchPath(importDestination);
        importWatchSuppressed = true;
      }
    } catch (error) {
      event.sender.send('python-event', { type: 'error', message: error.message || String(error), scriptName, requestId });
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
      const pyProcess = spawn(command, spawnArgs, { windowsHide: true });
      if (writesImportFiles) activeClassifyWrite = { process: pyProcess, requestId: normalizedRequestId, stage: classifyStage };
      if (cancellable) activePythonTasks.set(normalizedRequestId, { process: pyProcess, cancelFile });
      let stdoutBuffer = '';
      const handlePythonOutputLine = line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const jsonMsg = JSON.parse(trimmed);
          mainWindow.webContents.send('python-event', { ...jsonMsg, scriptName, requestId });
  
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
        if (activeClassifyWrite?.process === pyProcess) activeClassifyWrite = null;
        if (stdoutBuffer.trim()) handlePythonOutputLine(stdoutBuffer);
        stdoutBuffer = '';
        // 可以在这里针对特定脚本做处理，比如 classify 退出不一定代表错误
        console.log(`${scriptName} finished with code ${code}`);
        mainWindow.webContents.send('python-log', {
            timestamp: new Date().toLocaleTimeString(),
            message: `${scriptName} Process finished`,
            type: code === 0 ? 'success' : 'warning'
        });
        if (cancellable) {
          activePythonTasks.delete(normalizedRequestId);
          fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
        }
        finalizeImportWatch(code === 0);
      });
      
      // 监听启动错误（比如 exe 不存在）
      pyProcess.on('error', (err) => {
         if (activeClassifyWrite?.process === pyProcess) activeClassifyWrite = null;
         finalizeImportWatch(false);
         if (cancellable) {
           activePythonTasks.delete(normalizedRequestId);
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
      finalizeImportWatch(false);
      console.error("Spawn Error:", e);
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
      const normalizedConfig = {
        ...config,
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
  
  ipcMain.handle('loadConfig', async (event) => {
    try {
      const configPath = getConfigPath();
      if (fs.existsSync(configPath)) {
        console.log('✅ Config loaded from:', configPath);
        const config = readSavedConfig();
        if (config?.mediaCache?.directory) approvedMediaCacheDirectories.add(path.resolve(config.mediaCache.directory));
        return config;
      }
      console.log('⚠️ No config file found, will use defaults');
      return null;
    } catch (error) {
      console.error('❌ Failed to load config:', error);
      return null;
    }
  });
  
  ipcMain.handle('get-birthdays', async () => {
    try {
      const userPath = getUserBirthdaysPath();
      
      // 如果用户目录没有该文件，尝试从资源目录复制一份
      if (!fs.existsSync(userPath)) {
        const resourcePath = getResourceBirthdaysPath();
        if (fs.existsSync(resourcePath)) {
          console.log('Initialize birthdays.json from resources...');
          fs.copyFileSync(resourcePath, userPath);
        } else {
          // 如果资源目录也没有，就创建一个空的
          return {}; 
        }
      }
  
      // 读取用户目录下的文件
      const data = fs.readFileSync(userPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error reading birthdays.json:', error);
      return {};
    }
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
  
  ipcMain.handle('check-script', async (event, scriptName) => {
    try {
      const baseName = scriptName.replace('.py', '');
      if (!app.isPackaged) {
        console.log(`[开发模式] 自动放行组件检查: ${scriptName}`);
        return true; 
      }
  
      const isWin = process.platform === 'win32';
      const exeSuffix = isWin ? '.exe' : '';
      // 打包后去 resources/python 目录下寻找 Python 引擎文件
      const executableName = baseName === 'thumbnail_image' ? 'thumbnail-image-worker' : baseName === 'workspace_db' ? 'workspace-db-worker' : MERGED_PYTHON_TOOLS.has(baseName) ? 'tools' : INSPIRATION_PYTHON_TOOLS.has(baseName) ? 'inspiration-tools' : baseName;
      const scriptPath = path.join(process.resourcesPath, 'python', executableName, `${executableName}${exeSuffix}`);
      return fs.existsSync(scriptPath);
      
    } catch (error) {
      console.error("检查脚本失败:", error);
      return false;
    }
  });
  
  ipcMain.handle('getDrives', async () => {
    const drives = [];
    try {
      if (process.platform === 'win32') {
        // Windows: 遍历 A-Z 盘符
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        for (let i = 0; i < letters.length; i++) {
          const drive = letters[i] + ':/';
          if (fs.existsSync(drive)) drives.push(drive);
        }
      } else if (process.platform === 'darwin') {
        // Mac: 读取 /Volumes 挂载目录
        const volumes = await fs.promises.readdir('/Volumes');
        volumes.forEach(v => drives.push('/Volumes/' + v));
      }
    } catch (error) {
      console.error('Error getting drives:', error);
    }
    return drives;
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
      filters: [{ name: '照片、RAW 与视频', extensions: ['jpg', 'jpeg', 'png', 'arw', 'cr2', 'cr3', 'dng', 'nef', 'orf', 'heic', 'mp4', 'mov', 'avi', 'crm', 'rwl', 'raf', '3fr', 'fff'] }],
    });
    return choice.canceled ? { cancelled: true, paths: [] } : { paths: choice.filePaths };
  });
  
  ipcMain.handle('photoshop-status', async () => {
    const executable = await findLatestPhotoshop();
    return { available: Boolean(executable) };
  });
};

module.exports = { registerSystemIpc };
