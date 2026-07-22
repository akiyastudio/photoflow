const registerSystemIpc = context => {
  const { Array, Boolean, BrowserWindow, Date, Error, JSON, MERGED_PYTHON_TOOLS, Object, String, app, approvedMediaCacheDirectories, checkForUpdates, console, dialog, findLatestPhotoshop, fs, getConfigPath, getResourceBirthdaysPath, getRunConfig, getUserBirthdaysPath, ipcMain, mainWindow, path, pluginService, process, readSavedConfig, shell, spawn, undefined, writeLog } = context;

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
          mergeAvailable: Boolean(probe.mergeAvailable),
          provider: probe.provider || '',
          providers: Array.isArray(probe.providers) ? probe.providers : [],
          runtimeError: runtimeAvailable ? '' : (probe.runtimeError || probe.error || ''),
          gpuError: probe.gpuAvailable || !runtimeAvailable ? '' : (probe.gpuError || probe.error || ''),
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
