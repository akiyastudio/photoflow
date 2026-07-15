const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;
const nativeConsoleLog = console.log.bind(console);
const nativeConsoleError = console.error.bind(console);

// Persist operational logs outside of the installation directory so they are
// available after an app restart or a packaged-app update.
const getLogDir = () => {
  const logDir = path.join(app.getPath('userData'), 'photoflow', 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  return logDir;
};

const LOG_RETENTION_DAYS = 7;
const cleanupExpiredLogs = () => {
  const expiresBefore = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    for (const fileName of fs.readdirSync(getLogDir())) {
      // Only remove files created by this logger; never touch user files.
      if (!/^photoflow-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) continue;

      const filePath = path.join(getLogDir(), fileName);
      if (fs.statSync(filePath).mtimeMs < expiresBefore) {
        fs.unlinkSync(filePath);
        deletedCount += 1;
      }
    }
  } catch (error) {
    nativeConsoleError('Failed to clean up expired application logs:', error);
  }

  return deletedCount;
};
const formatLogValue = (value) => {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const writeLog = (level, message, details) => {
  const timestamp = new Date().toISOString();
  const suffix = details === undefined ? '' : ` ${formatLogValue(details)}`;
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}\n`;
  const consoleMethod = level === 'error' ? nativeConsoleError : nativeConsoleLog;
  consoleMethod(line.trim());

  try {
    const date = timestamp.slice(0, 10);
    fs.appendFileSync(path.join(getLogDir(), `photoflow-${date}.log`), line, 'utf8');
  } catch (error) {
    nativeConsoleError('Failed to write application log:', error);
  }
};

// Mirror existing main-process console output to the persistent log without
// requiring every call site to be rewritten.
console.log = (...values) => writeLog('info', values.map(formatLogValue).join(' '));
console.warn = (...values) => writeLog('warn', values.map(formatLogValue).join(' '));
console.error = (...values) => writeLog('error', values.map(formatLogValue).join(' '));

function createWindow() {
  // 2. 彻底移除顶部菜单栏 (File, Edit, View...)
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    backgroundColor: '#f8fafc',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f8fafc',
      symbolColor: '#334155',
      height: 32
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    //mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// 根据环境获取可执行文件和参数
const getRunConfig = (scriptName, args) => {
  // 移除 .py 后缀 (兼容前端传入 'classify.py' 或 'classify')
  const baseName = scriptName.replace('.py', '');

  const isWin = process.platform === 'win32';

  if (app.isPackaged) {
    // 生产环境：根据平台决定是否有 .exe 后缀
    const exeSuffix = isWin ? '.exe' : '';
    return {
      command: path.join(process.resourcesPath, 'python', `${baseName}${exeSuffix}`),
      args: args
    };
  } else {
    // 【开发环境】使用 python 解释器运行对应的 .py 脚本
    const rootDir = path.join(__dirname, '..');
    
    // 寻找 Python 解释器
    const venvPython = isWin
      ? path.join(rootDir, '.venv', 'Scripts', 'python.exe')
      : path.join(rootDir, '.venv', 'bin', 'python');
    
    const pythonExec = fs.existsSync(venvPython) ? venvPython : 'python';
    
    // 脚本路径: python/classify.py
    const scriptPath = path.join(rootDir, 'python', `${baseName}.py`);
    
    return {
      command: pythonExec,
      args: ['-u', scriptPath, ...args] // -u 强制无缓冲输出
    };
  }
};

// 检查更新
const UPDATE_CONFIG = {
  owner: 'akiyastudio',
  repo: 'photoflow'
};

const checkForUpdates = async () => {
  if (!mainWindow) return;
  
  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/latest`, {
      headers: { 'User-Agent': 'PhotoFlow-App' }
    });
    
    if (!response.ok) return;
    
    const data = await response.json();
    const latestVersion = data.tag_name.replace(/^v/, ''); // 去除 'v' 前缀，如 v1.0.1 -> 1.0.1
    const currentVersion = app.getVersion(); // 获取 package.json 中的 version

    console.log(`Current: ${currentVersion}, Latest: ${latestVersion}`);

    // 简单的版本比较逻辑 (如果你需要更严格的 semver 比较，可以引入 semver 库)
    if (latestVersion !== currentVersion && compareVersions(latestVersion, currentVersion) > 0) {
      mainWindow.webContents.send('update-available', {
        version: latestVersion,
        url: data.html_url, // GitHub Release 页面地址
        notes: data.body    // Release Note
      });
    }
  } catch (error) {
    console.error('Update check failed:', error);
  }
};

// 简单的版本号比较函数 (1.0.1 > 1.0.0)
const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (nb > na) return -1;
  }
  return 0;
};

// 添加打开外部链接的 IPC 处理
ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});
ipcMain.handle('set-theme', async (_event, theme) => {
  if (!mainWindow) return;
  const isDark = theme === 'dark';
  mainWindow.setTitleBarOverlay({
    color: isDark ? '#0f172a' : '#f8fafc',
    symbolColor: isDark ? '#e2e8f0' : '#334155',
    height: 32,
  });
});

// 运行 Python 脚本
ipcMain.on('run-python', (event, scriptName, args = []) => {
  const { command, args: spawnArgs } = getRunConfig(scriptName, args);

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
    
    // --- 下面的监听逻辑保持不变 ---
    pyProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const jsonMsg = JSON.parse(trimmed);
          mainWindow.webContents.send('python-event', jsonMsg);
          
          if (jsonMsg.type === 'log' || jsonMsg.type === 'error') {
             mainWindow.webContents.send('python-log', {
                timestamp: new Date().toLocaleTimeString(),
                message: jsonMsg.message,
                type: jsonMsg.type === 'error' ? 'error' : 'info'
             });
          }
        } catch (e) {
          console.log("Raw Python Output:", trimmed);
          mainWindow.webContents.send('python-log', {
              timestamp: new Date().toLocaleTimeString(),
              message: trimmed,
              type: 'info'
          });
        }
      });
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
         message: `Failed to launch ${scriptName}: ${err.message}`
       });
    });

  } catch (e) {
    console.error("Spawn Error:", e);
  }
});

const getConfigDir = () => {
  // 在用户数据目录下创建 config 文件夹
  const userDataPath = app.getPath('userData');
  const configDir = path.join(userDataPath, 'photoflow');
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  return configDir;
};

const getConfigPath = () => {
  return path.join(getConfigDir(), 'photoflow_config.json');
};

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
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
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
      const data = fs.readFileSync(configPath, 'utf-8');
      console.log('✅ Config loaded from:', configPath);
      return JSON.parse(data);
    }
    console.log('⚠️ No config file found, will use defaults');
    return null;
  } catch (error) {
    console.error('❌ Failed to load config:', error);
    return null;
  }
});

// 生日数据管理

const getUserBirthdaysPath = () => {
  return path.join(getConfigDir(), 'birthdays.json');
};

const getResourceBirthdaysPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python', 'birthdays.json');
  }
  return path.join(__dirname, '../python/birthdays.json');
};

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
    if (!app.isPackaged) {
      console.log(`[开发模式] 自动放行组件检查: ${scriptName}`);
      return true; 
    }

    const baseName = scriptName.replace('.py', '');
    const isWin = process.platform === 'win32';
    const exeSuffix = isWin ? '.exe' : '';
    // 打包后去 resources/python 目录下寻找 Python 引擎文件
    const scriptPath = path.join(process.resourcesPath, 'python', `${baseName}${exeSuffix}`);
    return fs.existsSync(scriptPath);
    
  } catch (error) {
    console.error("检查脚本失败:", error);
    return false;
  }
});

// 获取系统盘符列表

const WORKSPACE_STATUSES = ['未策划', '已策划', '进行中', '已归档'];

const ensureWorkspace = (workspacePath) => {
  const requestedPath = path.resolve(workspacePath);
  const isDriveRoot = requestedPath === path.parse(requestedPath).root;
  // Never create or alter a drive root. A root selection uses its dedicated app folder.
  const root = isDriveRoot ? path.join(requestedPath, '照片流') : requestedPath;
  fs.mkdirSync(root, { recursive: true });
  WORKSPACE_STATUSES.forEach(status => fs.mkdirSync(path.join(root, status), { recursive: true }));
  return root;
};

const getProjectPath = (workspacePath, status, projectName) => {
  if (!WORKSPACE_STATUSES.includes(status)) throw new Error('无效的项目状态');
  const root = ensureWorkspace(workspacePath);
  const statusPath = path.resolve(root, status);
  const projectPath = path.resolve(statusPath, projectName);
  if (!projectPath.startsWith(statusPath + path.sep)) throw new Error('无效的项目路径');
  return projectPath;
};

const cleanProjectName = (value) => value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

ipcMain.handle('workspace-projects', async (_event, workspacePath) => {
  try {
    const root = ensureWorkspace(workspacePath);
    const statuses = WORKSPACE_STATUSES.map(status => {
      const statusPath = path.join(root, status);
      const projects = fs.readdirSync(statusPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => {
          const projectPath = path.join(statusPath, entry.name);
          return { name: entry.name, path: projectPath, status, updatedAt: fs.statSync(projectPath).mtimeMs };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'zh-CN'));
      return { status, projects };
    });
    return { success: true, root, statuses };
  } catch (error) {
    writeLog('error', 'Unable to load workspace projects', error);
    return { success: false, error: String(error), statuses: [] };
  }
});

ipcMain.handle('workspace-create-project', async (_event, workspacePath, date, name) => {
  try {
    const datePart = cleanProjectName(date || '');
    const namePart = cleanProjectName(name || '');
    const projectName = [datePart, namePart].filter(Boolean).join(' ');
    if (!projectName) throw new Error('请至少填写日期或名称');
    const projectPath = getProjectPath(workspacePath, '未策划', projectName);
    if (fs.existsSync(projectPath)) throw new Error('同名项目已存在');
    fs.mkdirSync(projectPath, { recursive: false });
    fs.mkdirSync(path.join(projectPath, '策划'), { recursive: true });
    writeLog('info', 'Project created', { projectName, projectPath });
    return { success: true, project: { name: projectName, path: projectPath, status: '未策划', updatedAt: Date.now() } };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('workspace-rename-project', async (_event, workspacePath, status, projectName, nextName) => {
  try {
    const cleanedName = cleanProjectName(nextName || '');
    if (!cleanedName) throw new Error('项目名称不能为空');
    const source = getProjectPath(workspacePath, status, projectName);
    const destination = getProjectPath(workspacePath, status, cleanedName);
    if (!fs.existsSync(source)) throw new Error('项目不存在');
    if (fs.existsSync(destination)) throw new Error('同名项目已存在');
    fs.renameSync(source, destination);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('workspace-move-project', async (_event, workspacePath, currentStatus, projectName, nextStatus) => {
  try {
    const source = getProjectPath(workspacePath, currentStatus, projectName);
    const destination = getProjectPath(workspacePath, nextStatus, projectName);
    if (!fs.existsSync(source)) throw new Error('项目不存在');
    if (fs.existsSync(destination)) throw new Error('目标状态中已有同名项目');
    fs.renameSync(source, destination);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('workspace-trash-project', async (_event, workspacePath, status, projectName) => {
  try {
    const projectPath = getProjectPath(workspacePath, status, projectName);
    if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
    await shell.trashItem(projectPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
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
      const volumes = fs.readdirSync('/Volumes');
      volumes.forEach(v => drives.push('/Volumes/' + v));
    }
  } catch (error) {
    console.error('Error getting drives:', error);
  }
  return drives;
});


ipcMain.handle('workspace-project-contents', async (_event, workspacePath, status, projectName) => {
  try {
    const projectPath = getProjectPath(workspacePath, status, projectName);
    if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
    const folders = fs.readdirSync(projectPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => {
        const folderPath = path.join(projectPath, entry.name);
        return { name: entry.name, path: folderPath, updatedAt: fs.statSync(folderPath).mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return { success: true, folders };
  } catch (error) {
    return { success: false, error: error.message || String(error), folders: [] };
  }
});

ipcMain.handle('workspace-open-project', async (_event, workspacePath, status, projectName, folderName) => {
  try {
    const projectPath = getProjectPath(workspacePath, status, projectName);
    const target = folderName ? path.resolve(projectPath, folderName) : projectPath;
    if (!target.startsWith(projectPath) || !fs.existsSync(target)) throw new Error('目标文件夹不存在');
    const error = await shell.openPath(target);
    return { success: !error, error };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('workspace-import-broll', async (_event, workspacePath, status, projectName) => {
  try {
    const projectPath = getProjectPath(workspacePath, status, projectName);
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择花絮文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '媒体文件', extensions: ['jpg', 'jpeg', 'png', 'heic', 'mp4', 'mov', 'avi', 'm4v'] }, { name: '所有文件', extensions: ['*'] }]
    });
    if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0 };
    const destinationDir = path.join(projectPath, '花絮');
    fs.mkdirSync(destinationDir, { recursive: true });
    let count = 0;
    for (const sourcePath of choice.filePaths) {
      const parsed = path.parse(sourcePath);
      let targetPath = path.join(destinationDir, parsed.base);
      if (fs.existsSync(targetPath)) targetPath = path.join(destinationDir, `${parsed.name}_${Date.now()}_${count}${parsed.ext}`);
      fs.copyFileSync(sourcePath, targetPath);
      count += 1;
    }
    writeLog('info', 'B-roll imported', { projectPath, count });
    return { success: true, count };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});
app.whenReady().then(() => {
  const deletedLogFiles = cleanupExpiredLogs();
  writeLog('info', 'Application started', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, deletedExpiredLogFiles: deletedLogFiles });
  createWindow();

  setTimeout(checkForUpdates, 3000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  writeLog('info', 'All application windows closed');
  if (process.platform !== 'darwin') app.quit();
});
process.on('uncaughtException', (error) => {
  writeLog('error', 'Uncaught main-process exception', error);
});

process.on('unhandledRejection', (reason) => {
  writeLog('error', 'Unhandled main-process promise rejection', reason);
});
