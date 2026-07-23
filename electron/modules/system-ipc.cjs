const registerSystemIpc = context => {
  const { Array, Boolean, BrowserWindow, Date, Error, JSON, MERGED_PYTHON_TOOLS, Object, String, app, approvedMediaCacheDirectories, checkForUpdates, console, dialog, findLatestPhotoshop, fs, getConfigPath, getLogDir, getResourceBirthdaysPath, getRunConfig, getUserBirthdaysPath, ipcMain, mainWindow, path, pluginService, process, readSavedConfig, shell, spawn, undefined, writeLog } = context;

  ipcMain.on('renderer-error-log', (_event, message, details) => {
    writeLog('error', `Renderer: ${String(message || '未知错误').slice(0, 500)}`, String(details || '').slice(0, 4000));
  });
  
  ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
  });
  
  ipcMain.handle('check-for-updates', async () => checkForUpdates());
  
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
  
  ipcMain.handle('components-list', async () => {
    const components = await pluginService.listWithSizes();
    const gpu = components.find(component => component.id === 'team-retouch');
    if (gpu?.installed) {
      try {
        const probe = await pluginService.runJson('team-retouch', ['probe'], 15000);
        const runtimeAvailable = Boolean(probe.componentAvailable ?? probe.cpuAvailable);
        Object.assign(gpu, {
          runtimeAvailable,
          gpuAvailable: Boolean(probe.gpuAvailable),
          advancedAvailable: Boolean(probe.advancedAvailable),
          mergeAvailable: Boolean(probe.mergeAvailable),
          provider: probe.advancedAvailable ? `${probe.provider || 'ONNX'} + PairDETR/SAM 2.1` : (probe.provider || ''),
          providers: Array.isArray(probe.providers) ? probe.providers : [],
          runtimeError: runtimeAvailable ? '' : (probe.runtimeError || probe.error || ''),
          gpuError: probe.gpuAvailable || !runtimeAvailable ? '' : (probe.gpuError || probe.error || ''),
          advancedError: probe.advancedAvailable ? '' : (probe.advancedError || ''),
        });
      } catch (error) {
        Object.assign(gpu, { runtimeAvailable: false, provider: '', providers: [], runtimeError: error.message || String(error) });
      }
    }
    return { success: true, components, installPath: pluginService.installRoot };
  });
  
  ipcMain.handle('components-open-folder', async () => {
    try {
      const installPath = pluginService.ensureInstallRoot();
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

  ipcMain.handle('components-install', async (_event, componentId) => {
    let stagingPath = '';
    let backupPath = '';
    try {
      if (!app.isPackaged) throw new Error('开发环境组件由源码提供，请在打包版本中测试安装');
      const knownComponent = (await pluginService.listWithSizes()).find(component => component.id === componentId);
      if (!knownComponent) throw new Error(`未知组件：${componentId}`);
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: `选择“${knownComponent.name}”组件文件夹`,
        properties: ['openDirectory'],
      });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true };

      const selectedPath = path.resolve(choice.filePaths[0]);
      const directManifest = path.join(selectedPath, 'component.json');
      const nestedPath = path.join(selectedPath, String(componentId));
      const componentRoot = fs.existsSync(directManifest) ? selectedPath : nestedPath;
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

      const installRoot = pluginService.ensureInstallRoot();
      const destination = path.join(installRoot, String(componentId));
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
      if (backupPath) {
        await shell.trashItem(backupPath).catch(error => writeLog('warn', 'Unable to recycle replaced component backup', { componentId, backupPath, error: error.message || String(error) }));
        backupPath = '';
      }
      writeLog('info', 'Component installed', { componentId, destination });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    } finally {
      if (stagingPath) await fs.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      if (backupPath) await fs.promises.rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('components-uninstall', async (_event, componentId) => {
    try {
      if (!app.isPackaged) throw new Error('开发环境组件由源码提供，不能在应用内卸载');
      const component = (await pluginService.listWithSizes()).find(item => item.id === componentId);
      if (!component?.installed) throw new Error('组件尚未安装');
      if (component.source !== 'application') throw new Error('此组件随应用提供，不能单独卸载');
      const installRoot = path.resolve(pluginService.installRoot);
      const componentPath = path.resolve(component.path);
      const relative = path.relative(installRoot, componentPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(componentPath) !== componentId) throw new Error('组件目录校验失败');
      await shell.trashItem(componentPath);
      writeLog('info', 'Component uninstalled', { componentId, componentPath });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.on('run-python', (event, scriptName, args = [], requestId = '') => {
    let command;
    let spawnArgs;
    try {
      ({ command, args: spawnArgs } = getRunConfig(scriptName, args));
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
        if (stdoutBuffer.trim()) handlePythonOutputLine(stdoutBuffer);
        stdoutBuffer = '';
        // 可以在这里针对特定脚本做处理，比如 classify 退出不一定代表错误
        console.log(`${scriptName} finished with code ${code}`);
        mainWindow.webContents.send('python-log', {
            timestamp: new Date().toLocaleTimeString(),
            message: `${scriptName} Process finished`,
            type: code === 0 ? 'success' : 'warning'
        });
      });
      
      // 监听启动错误（比如 exe 不存在）
      pyProcess.on('error', (err) => {
         console.error('Failed to start process:', err);
         mainWindow.webContents.send('python-event', {
           type: 'error',
           message: `Failed to launch ${scriptName}: ${err.message}`,
           scriptName,
           requestId
         });
      });
  
    } catch (e) {
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
      const requestedCacheDirectory = String(config?.mediaCache?.directory || '').trim();
      const savedCacheDirectory = String(readSavedConfig()?.mediaCache?.directory || '').trim();
      if (requestedCacheDirectory && (!savedCacheDirectory || path.resolve(requestedCacheDirectory) !== path.resolve(savedCacheDirectory))
        && !approvedMediaCacheDirectories.has(path.resolve(requestedCacheDirectory))) {
        throw new Error('缓存目录必须通过系统文件夹选择器授权');
      }
      if (requestedCacheDirectory) approvedMediaCacheDirectories.add(path.resolve(requestedCacheDirectory));
      const configPath = getConfigPath();
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
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
        const data = await fs.promises.readFile(configPath, 'utf-8');
        console.log('✅ Config loaded from:', configPath);
        const config = JSON.parse(data);
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
      // 始终写入用户目录，确保有权限
      const userPath = getUserBirthdaysPath();
      fs.writeFileSync(userPath, JSON.stringify(newContent, null, 4), 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('Error writing birthdays.json:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('check-script', async (event, scriptName) => {
    try {
      const baseName = scriptName.replace('.py', '');
      if (baseName === 'research') return Boolean(pluginService.inspect('research-tools')?.installed);
      if (!app.isPackaged) {
        console.log(`[开发模式] 自动放行组件检查: ${scriptName}`);
        return true; 
      }
  
      const isWin = process.platform === 'win32';
      const exeSuffix = isWin ? '.exe' : '';
      // 打包后去 resources/python 目录下寻找 Python 引擎文件
      const executableName = baseName === 'thumbnail_image' ? 'thumbnail-image-worker' : baseName === 'workspace_db' ? 'workspace-db-worker' : MERGED_PYTHON_TOOLS.has(baseName) ? 'tools' : baseName;
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
  
  ipcMain.handle('photoshop-status', async () => {
    const executable = await findLatestPhotoshop();
    return { available: Boolean(executable) };
  });
};

module.exports = { registerSystemIpc };
