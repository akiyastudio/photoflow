const { app, BrowserWindow, ipcMain, Menu, shell, dialog, protocol, net, nativeImage, clipboard } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { exiftool } = require('exiftool-vendored');

app.setName('照片流');

protocol.registerSchemesAsPrivileged([{ scheme: 'photoflow-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const toMediaUrl = filePath => `photoflow-media://file/${Buffer.from(filePath, 'utf8').toString('base64url')}`;

let mainWindow;
let workspaceWatcher = null;
let watchedWorkspacePath = '';
let workspaceWatchTimer = null;
let projectFileClipboard = null;
const activeProjectFileOperations = new Map();
const mediaMetadataCache = new Map();
const rawOrientationCache = new Map();
const renameHistory = [];
let shellThumbnailProcess = null;
let shellThumbnailOutput = '';
let shellThumbnailRequestId = 0;
const shellThumbnailRequests = new Map();
let shellThumbnailUnavailableLogged = false;
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

const getShellThumbnailExecutable = () => app.isPackaged
  ? path.join(process.resourcesPath, 'shell-thumbnail.exe')
  : path.join(__dirname, 'bin', 'shell-thumbnail.exe');

const finishShellThumbnailRequests = () => {
  for (const request of shellThumbnailRequests.values()) {
    clearTimeout(request.timer);
    request.resolve(false);
  }
  shellThumbnailRequests.clear();
};

const stopShellThumbnailProcess = () => {
  const child = shellThumbnailProcess;
  shellThumbnailProcess = null;
  shellThumbnailOutput = '';
  finishShellThumbnailRequests();
  if (child && !child.killed) child.kill();
};

const ensureShellThumbnailProcess = () => {
  if (process.platform !== 'win32') return null;
  if (shellThumbnailProcess && !shellThumbnailProcess.killed) return shellThumbnailProcess;
  const executable = getShellThumbnailExecutable();
  if (!fs.existsSync(executable)) {
    if (!shellThumbnailUnavailableLogged) {
      shellThumbnailUnavailableLogged = true;
      writeLog('warn', 'Windows Shell thumbnail cache helper is unavailable', { executable });
    }
    return null;
  }

  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  shellThumbnailProcess = child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    shellThumbnailOutput += data;
    const lines = shellThumbnailOutput.split(/\r?\n/);
    shellThumbnailOutput = lines.pop() || '';
    for (const rawLine of lines) {
      const fields = rawLine.replace(/^\uFEFF/, '').split('\t');
      const request = shellThumbnailRequests.get(fields[0]);
      if (!request) continue;
      shellThumbnailRequests.delete(fields[0]);
      clearTimeout(request.timer);
      request.resolve(fields[1] === '1' && fs.existsSync(request.targetPath));
    }
  });
  child.on('error', error => {
    writeLog('warn', 'Windows Shell thumbnail cache helper failed to start', { error: error.message || String(error) });
  });
  child.on('exit', (code, signal) => {
    if (shellThumbnailProcess === child) shellThumbnailProcess = null;
    shellThumbnailOutput = '';
    finishShellThumbnailRequests();
    if (code && code !== 0) writeLog('warn', 'Windows Shell thumbnail cache helper exited', { code, signal });
  });
  return child;
};

// Query only Explorer's existing thumbnail cache. The helper deliberately uses
// SIIGBF_INCACHEONLY | SIIGBF_THUMBNAILONLY so a cache miss never starts video
// decoding on the Electron main thread.
const copyWindowsShellCachedThumbnail = (sourcePath, targetPath, requestedSize) => new Promise(resolve => {
  const child = ensureShellThumbnailProcess();
  if (!child?.stdin?.writable) return resolve(false);
  const requestId = String(++shellThumbnailRequestId);
  const timer = setTimeout(() => {
    shellThumbnailRequests.delete(requestId);
    resolve(false);
    // A cache-only lookup should finish almost immediately. Restart the helper
    // if a cloud/offline Shell provider stalls so later thumbnails are not
    // trapped behind the same blocked COM request.
    if (shellThumbnailProcess === child) stopShellThumbnailProcess();
  }, 2000);
  shellThumbnailRequests.set(requestId, { resolve, timer, targetPath });
  const encode = value => Buffer.from(value, 'utf8').toString('base64');
  child.stdin.write(`${requestId}\t${requestedSize}\t${encode(sourcePath)}\t${encode(targetPath)}\n`, error => {
    if (!error) return;
    const request = shellThumbnailRequests.get(requestId);
    if (!request) return;
    shellThumbnailRequests.delete(requestId);
    clearTimeout(request.timer);
    request.resolve(false);
  });
});

// Mirror existing main-process console output to the persistent log without
// requiring every call site to be rewritten.
console.log = (...values) => writeLog('info', values.map(formatLogValue).join(' '));
console.warn = (...values) => writeLog('warn', values.map(formatLogValue).join(' '));
console.error = (...values) => writeLog('error', values.map(formatLogValue).join(' '));

ipcMain.on('renderer-error-log', (_event, message, details) => {
  writeLog('error', `Renderer: ${String(message || '未知错误').slice(0, 500)}`, String(details || '').slice(0, 4000));
});

function createWindow() {
  // 2. 彻底移除顶部菜单栏 (File, Edit, View...)
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    icon: app.isPackaged ? undefined : path.join(__dirname, '../build/icon.ico'),
    backgroundColor: '#f8fafc',
    frame: false,
    // Keep the Windows resize frame so Aero Snap and drag-to-top maximize work
    // with the custom title bar. Interactive title-bar regions are controlled
    // in the renderer; the old full-width transparent drag overlay is gone.
    thickFrame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sendMaximizedState = () => {
    if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('window-maximized-change', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);
  mainWindow.center();

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    //mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// 根据环境获取可执行文件和参数
const MERGED_PYTHON_TOOLS = new Set(['classify', 'png_to_jpg', 'catch', 'cut_video', 'rename', 'research', 'video_preview']);

const getRunConfig = (scriptName, args) => {
  // 移除 .py 后缀 (兼容前端传入 'classify.py' 或 'classify')
  const baseName = scriptName.replace('.py', '');

  const isWin = process.platform === 'win32';

  if (app.isPackaged) {
    // 生产环境：根据平台决定是否有 .exe 后缀
    const exeSuffix = isWin ? '.exe' : '';
    if (MERGED_PYTHON_TOOLS.has(baseName)) {
      return {
        command: path.join(process.resourcesPath, 'python', `tools${exeSuffix}`),
        args: [baseName, ...args]
      };
    }
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
  if (!mainWindow) return { success: false, error: '主窗口尚未就绪' };
  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/latest`, { headers: { 'User-Agent': 'PhotoFlow-App' } });
    if (!response.ok) return { success: false, error: `更新服务返回 ${response.status}` };
    const data = await response.json();
    const latestVersion = data.tag_name.replace(/^v/, '');
    const currentVersion = app.getVersion();
    const updateAvailable = latestVersion !== currentVersion && compareVersions(latestVersion, currentVersion) > 0;
    console.log(`Current: ${currentVersion}, Latest: ${latestVersion}`);
    if (updateAvailable) mainWindow.webContents.send('update-available', { version: latestVersion, url: data.html_url, notes: data.body || '' });
    return { success: true, updateAvailable, currentVersion, latestVersion, url: data.html_url, notes: data.body || '' };
  } catch (error) {
    console.error('Update check failed:', error);
    return { success: false, error: error.message || String(error) };
  }
};

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
          mainWindow.webContents.send('python-event', { ...jsonMsg, scriptName });
          
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
         message: `Failed to launch ${scriptName}: ${err.message}`,
         scriptName
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
    const executableName = MERGED_PYTHON_TOOLS.has(baseName) ? 'tools' : baseName;
    const scriptPath = path.join(process.resourcesPath, 'python', `${executableName}${exeSuffix}`);
    return fs.existsSync(scriptPath);
    
  } catch (error) {
    console.error("检查脚本失败:", error);
    return false;
  }
});

// 获取系统盘符列表

const WORKSPACE_STATUSES = ['策划中', '待拍摄', '后期中', '已归档'];
const LEGACY_WORKSPACE_STATUS_MAP = new Map([
  ['未策划', '策划中'],
  ['已策划', '待拍摄'],
  ['进行中', '后期中']
]);

const getAvailableLegacyPath = destinationPath => {
  const parsed = path.parse(destinationPath);
  let index = 1;
  let candidate;
  do candidate = path.join(parsed.dir, `${parsed.name}_legacy_${index++}${parsed.ext}`);
  while (fs.existsSync(candidate));
  return candidate;
};

const mergeLegacyStatusDirectory = (source, destination) => {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    let destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destinationPath)) fs.renameSync(sourcePath, destinationPath);
      else if (fs.statSync(destinationPath).isDirectory()) mergeLegacyStatusDirectory(sourcePath, destinationPath);
      else fs.renameSync(sourcePath, getAvailableLegacyPath(destinationPath));
      continue;
    }
    if (fs.existsSync(destinationPath)) destinationPath = getAvailableLegacyPath(destinationPath);
    fs.renameSync(sourcePath, destinationPath);
  }
  fs.rmdirSync(source);
};

const ensureWorkspace = (workspacePath) => {
  const requestedPath = path.resolve(workspacePath);
  const isDriveRoot = requestedPath === path.parse(requestedPath).root;
  // Never create or alter a drive root. A root selection uses its dedicated app folder.
  const root = isDriveRoot ? path.join(requestedPath, '照片流') : requestedPath;
  fs.mkdirSync(root, { recursive: true });
  for (const [legacyStatus, nextStatus] of LEGACY_WORKSPACE_STATUS_MAP) {
    const legacyPath = path.join(root, legacyStatus);
    if (!fs.existsSync(legacyPath)) continue;
    const nextPath = path.join(root, nextStatus);
    if (fs.existsSync(nextPath)) mergeLegacyStatusDirectory(legacyPath, nextPath);
    else fs.renameSync(legacyPath, nextPath);
    writeLog('info', 'Workspace status migrated', { legacyStatus, nextStatus });
  }
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

const stopWorkspaceWatcher = () => {
  if (workspaceWatchTimer) clearTimeout(workspaceWatchTimer);
  workspaceWatchTimer = null;
  if (workspaceWatcher) workspaceWatcher.close();
  workspaceWatcher = null;
  watchedWorkspacePath = '';
};

const watchWorkspace = (root) => {
  if (watchedWorkspacePath === root && workspaceWatcher) return;
  stopWorkspaceWatcher();
  try {
    workspaceWatcher = fs.watch(root, { recursive: process.platform !== 'linux' }, (_eventType, fileName) => {
      if (workspaceWatchTimer) clearTimeout(workspaceWatchTimer);
      workspaceWatchTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-files-changed', { root, fileName: fileName || '' });
      }, 200);
    });
    watchedWorkspacePath = root;
  } catch (error) {
    writeLog('warn', 'Unable to watch workspace for file changes', error);
  }
};
ipcMain.handle('workspace-projects', async (_event, workspacePath) => {
  try {
    const root = ensureWorkspace(workspacePath);
    watchWorkspace(root);
    const statuses = WORKSPACE_STATUSES.map(status => {
      const statusPath = path.join(root, status);
      const projects = fs.readdirSync(statusPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => {
          const projectPath = path.join(statusPath, entry.name);
          return { name: entry.name, path: projectPath, status, updatedAt: fs.statSync(projectPath).mtimeMs };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
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
    const projectPath = getProjectPath(workspacePath, '策划中', projectName);
    if (fs.existsSync(projectPath)) throw new Error('同名项目已存在');
    fs.mkdirSync(projectPath, { recursive: false });
    fs.mkdirSync(path.join(projectPath, '策划'), { recursive: true });
    writeLog('info', 'Project created', { projectName, projectPath });
    return { success: true, project: { name: projectName, path: projectPath, status: '策划中', updatedAt: Date.now() } };
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
    renameHistory.push({ kind: 'project', source, destination, status, beforeName: projectName, afterName: cleanedName });
    return { success: true, project: { name: cleanedName, path: destination, status, updatedAt: Date.now() } };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});
ipcMain.handle('workspace-create-project-folder', async (_event, workspacePath, status, projectName, folderName) => {
  try {
    const cleanedName = cleanProjectName(folderName || '');
    if (!cleanedName) throw new Error('文件夹名称不能为空');
    const projectPath = getProjectPath(workspacePath, status, projectName);
    const folderPath = path.resolve(projectPath, cleanedName);
    if (!folderPath.startsWith(projectPath + path.sep)) throw new Error('无效的文件夹名称');
    if (fs.existsSync(folderPath)) throw new Error('同名文件夹已存在');
    fs.mkdirSync(folderPath);
    return { success: true, folder: { name: cleanedName, path: folderPath, updatedAt: Date.now() } };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('workspace-rename-project-folder', async (_event, workspacePath, status, projectName, folderName, nextName) => {
  try {
    const cleanedName = cleanProjectName(nextName || '');
    if (!cleanedName) throw new Error('文件夹名称不能为空');
    const projectPath = getProjectPath(workspacePath, status, projectName);
    const source = path.resolve(projectPath, folderName);
    const destination = path.resolve(projectPath, cleanedName);
    if (!source.startsWith(projectPath + path.sep) || !destination.startsWith(projectPath + path.sep)) throw new Error('无效的文件夹路径');
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('文件夹不存在');
    if (fs.existsSync(destination)) throw new Error('同名文件夹已存在');
    fs.renameSync(source, destination);
    renameHistory.push({ kind: 'folder', source, destination, beforeName: folderName, afterName: cleanedName });
    return { success: true, folder: { name: cleanedName, path: destination, updatedAt: Date.now() } };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('workspace-undo-rename', async () => {
  try {
    const operation = renameHistory.pop();
    if (!operation) return { success: false, error: '没有可撤销的重命名操作' };
    if (!fs.existsSync(operation.destination)) {
      renameHistory.push(operation);
      throw new Error('重命名后的文件夹已不存在，无法撤销');
    }
    if (fs.existsSync(operation.source)) {
      renameHistory.push(operation);
      throw new Error('原名称已被占用，无法撤销');
    }
    fs.renameSync(operation.destination, operation.source);
    const response = { success: true, message: `已撤销重命名：${operation.afterName} → ${operation.beforeName}` };
    if (operation.kind === 'project') {
      response.project = { name: operation.beforeName, path: operation.source, status: operation.status, updatedAt: Date.now() };
    }
    return response;
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
    return { success: true, project: { name: projectName, path: destination, status: nextStatus, updatedAt: Date.now() } };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

const mergeProjectDirectories = (source, destination) => {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    let destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      mergeProjectDirectories(sourcePath, destinationPath);
      continue;
    }
    if (fs.existsSync(destinationPath)) {
      const extension = path.extname(entry.name);
      const basename = path.basename(entry.name, extension);
      let index = 1;
      do {
        destinationPath = path.join(destination, `${basename}_imported_${Date.now()}_${index}${extension}`);
        index += 1;
      } while (fs.existsSync(destinationPath));
    }
    fs.renameSync(sourcePath, destinationPath);
  }
  fs.rmdirSync(source);
};

ipcMain.handle('workspace-archive-imports', async (_event, workspacePath) => {
  try {
    const root = ensureWorkspace(workspacePath);
    const plannedStatus = '待拍摄';
    const plannedPath = path.join(root, plannedStatus);
    const importedFolders = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_') && !WORKSPACE_STATUSES.includes(entry.name) && !LEGACY_WORKSPACE_STATUS_MAP.has(entry.name));
    const projects = [];

    for (const folder of importedFolders) {
      const importedPath = path.join(root, folder.name);
      let existing = null;
      for (const status of WORKSPACE_STATUSES) {
        const candidate = path.join(root, status, folder.name);
        if (fs.existsSync(candidate)) {
          existing = { path: candidate, status };
          break;
        }
      }

      if (existing) {
        mergeProjectDirectories(importedPath, existing.path);
        if (existing.status !== plannedStatus) {
          const plannedProjectPath = path.join(plannedPath, folder.name);
          if (fs.existsSync(plannedProjectPath)) {
            mergeProjectDirectories(existing.path, plannedProjectPath);
          } else {
            fs.renameSync(existing.path, plannedProjectPath);
          }
        }
      } else {
        fs.renameSync(importedPath, path.join(plannedPath, folder.name));
      }

      const projectPath = path.join(plannedPath, folder.name);
      projects.push({ name: folder.name, path: projectPath, status: plannedStatus, updatedAt: fs.statSync(projectPath).mtimeMs });
    }

    writeLog('info', 'Imported folders archived', { root, count: projects.length });
    return { success: true, projects };
  } catch (error) {
    writeLog('error', 'Unable to archive imported folders', error);
    return { success: false, error: error.message || String(error), projects: [] };
  }
});
ipcMain.handle('workspace-trash-project', async (event, workspacePath, status, projectName) => {
  const operationId = crypto.randomUUID();
  const publish = payload => {
    if (!event.sender.isDestroyed()) event.sender.send('workspace-file-operation-progress', { operationId, operation: 'trash', ...payload });
  };
  try {
    const projectPath = getProjectPath(workspacePath, status, projectName);
    if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
    publish({ phase: 'trashing', progress: 0, currentName: projectName, processedCount: 0, totalCount: 1 });
    await shell.trashItem(projectPath);
    publish({ phase: 'complete', progress: 100, currentName: projectName, processedCount: 1, totalCount: 1 });
    return { success: true, operationId };
  } catch (error) {
    publish({ phase: 'failed', progress: 0, currentName: projectName, error: error.message || String(error) });
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

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
const RAW_EXTENSIONS = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']);
const HIDDEN_SYSTEM_ENTRY_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

const getMediaCacheDir = (config = {}) => {
  const requested = typeof config.directory === 'string' ? config.directory.trim() : '';
  const cacheDir = requested || path.join(getConfigDir(), 'media-cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
};

const getDirectorySize = (directory) => {
  let sizeBytes = 0;
  let fileCount = 0;
  if (!fs.existsSync(directory)) return { sizeBytes, fileCount };
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) { sizeBytes += fs.statSync(entryPath).size; fileCount += 1; }
    }
  };
  visit(directory);
  return { sizeBytes, fileCount };
};

const trimMediaCache = (cacheDir, maxSizeGB) => {
  const maxBytes = Math.max(1, Number(maxSizeGB) || 1) * 1024 * 1024 * 1024;
  const files = fs.readdirSync(cacheDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => { const filePath = path.join(cacheDir, entry.name); const stat = fs.statSync(filePath); return { filePath, size: stat.size, used: stat.atimeMs || stat.mtimeMs }; })
    .sort((a, b) => a.used - b.used);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (total <= maxBytes) break;
    fs.unlinkSync(file.filePath);
    total -= file.size;
  }
};

const rawPreviewPath = (sourcePath, stat, cacheConfig) => {
  const cacheDir = getMediaCacheDir(cacheConfig);
  const target = rawPreviewCacheFile(sourcePath, stat, cacheDir);
  if (fs.existsSync(target)) return target;
  // Most RAW files embed a camera-generated JPEG. Extracting it avoids a large
  // decoder dependency and is fast enough for a browse thumbnail.
  const source = fs.readFileSync(sourcePath);
  let best = null;
  let start = source.indexOf(Buffer.from([0xff, 0xd8]));
  while (start >= 0) {
    const end = source.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) break;
    const length = end + 2 - start;
    if (!best || length > best.length) best = { start, length };
    start = source.indexOf(Buffer.from([0xff, 0xd8]), end + 2);
  }
  if (!best || best.length < 8 * 1024) return null;
  fs.writeFileSync(target, source.subarray(best.start, best.start + best.length));
  trimMediaCache(cacheDir, cacheConfig?.maxSizeGB);
  return target;
};

const rawPreviewCacheFile = (sourcePath, stat, cacheDir) => path.join(cacheDir, crypto.createHash('sha256').update(`${sourcePath}|${stat.size}|${stat.mtimeMs}`).digest('hex') + '.jpg');
const mediaThumbnailCacheFile = (sourcePath, stat, cacheDir, requestedSize) => path.join(cacheDir, crypto.createHash('sha256').update(`thumbnail|${requestedSize}|${sourcePath}|${stat.size}|${stat.mtimeMs}`).digest('hex') + '.jpg');

const EXIF_ORIENTATION_MATRICES = {
  1: [1, 0, 0, 1],
  2: [-1, 0, 0, 1],
  3: [-1, 0, 0, -1],
  4: [1, 0, 0, -1],
  5: [0, 1, 1, 0],
  6: [0, 1, -1, 0],
  7: [0, -1, -1, 0],
  8: [0, -1, 1, 0]
};
const readExifOrientation = async filePath => {
  try {
    const tags = await exiftool.readRaw(filePath, ['-G1', '-Orientation#', '-n', '-api', 'largefilesupport=1']);
    const candidates = Object.entries(tags).filter(([name, value]) => /(^|:)Orientation$/i.test(name) && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 8);
    const priority = name => /(^|:)IFD0:Orientation$/i.test(name) ? 0 : 1;
    candidates.sort(([left], [right]) => priority(left) - priority(right));
    return candidates.length ? Number(candidates[0][1]) : 1;
  } catch {
    return 1;
  }
};
const multiplyOrientationMatrices = (left, right) => [
  left[0] * right[0] + left[2] * right[1],
  left[1] * right[0] + left[3] * right[1],
  left[0] * right[2] + left[2] * right[3],
  left[1] * right[2] + left[3] * right[3]
];
const rawOrientationCorrection = async (sourcePath, previewPath, stat) => {
  const cacheKey = `${sourcePath}|${stat.size}|${stat.mtimeMs}`;
  const cached = rawOrientationCache.get(cacheKey);
  if (cached) return cached;
  const [rawOrientation, embeddedOrientation] = await Promise.all([readExifOrientation(sourcePath), readExifOrientation(previewPath)]);
  const rawMatrix = EXIF_ORIENTATION_MATRICES[rawOrientation] || EXIF_ORIENTATION_MATRICES[1];
  const embeddedMatrix = EXIF_ORIENTATION_MATRICES[embeddedOrientation] || EXIF_ORIENTATION_MATRICES[1];
  // The browser already applies the embedded JPEG orientation. Apply only the
  // missing difference required by the outer RAW container.
  const embeddedInverse = [embeddedMatrix[0], embeddedMatrix[2], embeddedMatrix[1], embeddedMatrix[3]];
  const matrix = multiplyOrientationMatrices(rawMatrix, embeddedInverse).map(value => Object.is(value, -0) ? 0 : value);
  const result = { matrix, swapsAxes: Math.abs(matrix[1]) === 1 || Math.abs(matrix[2]) === 1, rawOrientation, embeddedOrientation };
  if (rawOrientationCache.size >= 64) rawOrientationCache.delete(rawOrientationCache.keys().next().value);
  rawOrientationCache.set(cacheKey, result);
  return result;
};

// Keep the browser from decoding full camera images just to fill a small tile.
// The renderer asks for these only when a tile approaches the viewport.
const mediaThumbnailPath = async (sourcePath, stat, kind, cacheConfig, requestedSize = 640) => {
  const cacheDir = getMediaCacheDir(cacheConfig);
  const size = Math.max(160, Math.min(1600, Math.round(Number(requestedSize) || 640)));
  const target = mediaThumbnailCacheFile(sourcePath, stat, cacheDir, size);
  if (fs.existsSync(target)) return target;
  // Explorer feels instant because it reuses the shared Windows thumbnail
  // cache. Query that cache first for every media type, without triggering a
  // Shell extraction on a cache miss; the normal decoder remains the fallback.
  const foundInWindowsCache = await copyWindowsShellCachedThumbnail(sourcePath, target, size);
  if (foundInWindowsCache) {
    trimMediaCache(cacheDir, cacheConfig?.maxSizeGB);
    return target;
  }
  if (kind === 'video') return null;
  let thumbnail = nativeImage.createEmpty();
  try {
    thumbnail = await nativeImage.createThumbnailFromPath(sourcePath, { width: size, height: size });
  } catch { /* no system thumbnail provider for this format */ }
  // On Windows this first attempt uses the installed Shell/WIC RAW thumbnail
  // provider, matching Explorer. Fall back to the camera's embedded JPEG when
  // no system codec is available for this RAW format.
  if (thumbnail.isEmpty() && kind === 'raw') {
    const previewSource = rawPreviewPath(sourcePath, stat, cacheConfig);
    if (previewSource) {
      try {
        thumbnail = await nativeImage.createThumbnailFromPath(previewSource, { width: size, height: size });
      } catch { /* malformed or unsupported embedded preview */ }
    }
  }
  if (thumbnail.isEmpty()) return null;
  fs.writeFileSync(target, thumbnail.toJPEG(size >= 960 ? 84 : 80));
  trimMediaCache(cacheDir, cacheConfig?.maxSizeGB);
  return target;
};

ipcMain.handle('workspace-browse-files', async (_event, workspacePath, status, projectName, relativePath = '', cacheConfig = {}) => {
  try {
    const projectPath = getProjectPath(workspacePath, status, projectName);
    const root = path.resolve(projectPath);
    const currentPath = path.resolve(root, relativePath || '.');
    if (currentPath !== root && !currentPath.startsWith(root + path.sep)) throw new Error('无效的文件夹路径');
    const currentStat = await fs.promises.stat(currentPath);
    if (!currentStat.isDirectory()) throw new Error('文件夹不存在');
    const directoryEntries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    const entries = directoryEntries
      .filter(entry => !entry.name.startsWith('.') && !HIDDEN_SYSTEM_ENTRY_NAMES.has(entry.name.toLowerCase()))
      .map(entry => {
        const entryPath = path.join(currentPath, entry.name);
        const extension = entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase();
        const kind = entry.isDirectory() ? 'folder' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
        return { name: entry.name, path: entryPath, relativePath: path.relative(root, entryPath), kind, extension, size: -1, updatedAt: 0 };
      })
      .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN'));
    return { success: true, path: path.relative(root, currentPath), entries };
  } catch (error) {
    writeLog('warn', 'Unable to browse project directory', { projectName, relativePath, error: error.message || String(error) });
    return { success: false, error: error.message || String(error), entries: [] };
  }
});

ipcMain.handle('workspace-file-details', async (_event, workspacePath, status, projectName, relativePaths = []) => {
  try {
    const root = path.resolve(getProjectPath(workspacePath, status, projectName));
    const requested = Array.isArray(relativePaths) ? relativePaths.slice(0, 500) : [];
    const details = (await Promise.all(requested.map(async relativePath => {
      const filePath = path.resolve(root, relativePath);
      if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
      try {
        const stat = await fs.promises.stat(filePath);
        return { relativePath: path.relative(root, filePath), size: stat.size, updatedAt: stat.mtimeMs };
      } catch { return null; }
    }))).filter(Boolean);
    return { success: true, details };
  } catch (error) { return { success: false, details: [], error: error.message || String(error) }; }
});

ipcMain.handle('media-thumbnail', async (_event, filePath, kind, cacheConfig = {}, requestedSize = 640) => {
  try {
    const sourcePath = path.resolve(filePath);
    const extension = path.extname(sourcePath).toLowerCase();
    const supported = kind === 'raw' ? RAW_EXTENSIONS.has(extension) : kind === 'video' ? VIDEO_EXTENSIONS.has(extension) : IMAGE_EXTENSIONS.has(extension);
    if (!supported || !fs.existsSync(sourcePath)) throw new Error('文件不存在或格式不受支持');
    const thumbnail = await mediaThumbnailPath(sourcePath, fs.statSync(sourcePath), kind, cacheConfig, requestedSize);
    if (thumbnail) return { success: true, previewUrl: toMediaUrl(thumbnail), mediaUrl: kind === 'video' ? toMediaUrl(sourcePath) : undefined };
    if (kind === 'video') return { success: true, mediaUrl: toMediaUrl(sourcePath) };
    return { success: false, error: '无法生成缩略图' };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

ipcMain.handle('media-original', async (_event, filePath, kind, cacheConfig = {}) => {
  try {
    const sourcePath = path.resolve(filePath);
    const extension = path.extname(sourcePath).toLowerCase();
    const supported = kind === 'raw' ? RAW_EXTENSIONS.has(extension) : kind === 'image' ? IMAGE_EXTENSIONS.has(extension) : false;
    if (!supported || !fs.existsSync(sourcePath)) throw new Error('图片不存在或格式不受支持');
    if (kind === 'image') return { success: true, mediaUrl: toMediaUrl(sourcePath), original: true };

    // Chromium cannot decode camera RAW containers directly. Use the largest
    // camera-embedded JPEG, which is the closest displayable source preview.
    const stat = fs.statSync(sourcePath);
    const previewPath = rawPreviewPath(sourcePath, stat, cacheConfig);
    if (!previewPath) throw new Error('RAW 文件中没有可显示的内嵌原图');
    const orientation = await rawOrientationCorrection(sourcePath, previewPath, stat);
    return { success: true, mediaUrl: toMediaUrl(previewPath), original: false, orientation };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

const formatMetadataValue = value => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(formatMetadataValue).filter(Boolean).join(', ');
  try {
    return JSON.stringify(value, (_key, nestedValue) => typeof nestedValue === 'bigint' ? String(nestedValue) : nestedValue);
  } catch {
    return String(value);
  }
};

const flattenMetadataValue = (group, name, value, depth = 0) => {
  if (depth < 5 && Array.isArray(value) && value.some(item => item && typeof item === 'object')) {
    return value.flatMap((item, index) => flattenMetadataValue(group, `${name}.${index + 1}`, item, depth + 1));
  }
  if (depth < 5 && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([childName, childValue]) => flattenMetadataValue(group, `${name}.${childName}`, childValue, depth + 1));
  }
  const formatted = formatMetadataValue(value);
  return formatted ? [{ group, name, value: formatted }] : [];
};

ipcMain.handle('media-metadata', async (_event, filePath) => {
  try {
    const sourcePath = path.resolve(filePath);
    const extension = path.extname(sourcePath).toLowerCase();
    if (![...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...RAW_EXTENSIONS].includes(extension) || !fs.existsSync(sourcePath)) throw new Error('媒体文件不存在或格式不受支持');
    const stat = fs.statSync(sourcePath);
    const cacheKey = `${sourcePath}|${stat.size}|${stat.mtimeMs}`;
    const cached = mediaMetadataCache.get(cacheKey);
    if (cached) return cached;

    const tags = await exiftool.readRaw(sourcePath, ['-G1', '-struct', '-api', 'largefilesupport=1']);
    const fields = Object.entries(tags).flatMap(([qualifiedName, rawValue]) => {
      if (qualifiedName === 'SourceFile') return [];
      const separatorIndex = qualifiedName.indexOf(':');
      const group = separatorIndex > 0 ? qualifiedName.slice(0, separatorIndex) : '其他';
      const name = separatorIndex > 0 ? qualifiedName.slice(separatorIndex + 1) : qualifiedName;
      return flattenMetadataValue(group, name, rawValue);
    });
    const result = { success: true, fields };
    if (mediaMetadataCache.size >= 32) mediaMetadataCache.delete(mediaMetadataCache.keys().next().value);
    mediaMetadataCache.set(cacheKey, result);
    return result;
  } catch (error) {
    writeLog('warn', 'Unable to read media metadata', { filePath, error: error.message || String(error) });
    return { success: false, fields: [], error: error.message || String(error) };
  }
});

const videoPreviewJobs = new Map();
let videoPreviewWorkChain = Promise.resolve();
ipcMain.handle('media-video-hover-preview', async (_event, filePath, cacheConfig = {}, requestedSize = 640, cacheOnly = false, generateHoverFrames = false) => {
  try {
    const sourcePath = path.resolve(filePath);
    if (!VIDEO_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()) || !fs.existsSync(sourcePath)) throw new Error('视频文件不存在或格式不受支持');
    const stat = fs.statSync(sourcePath);
    const size = Math.max(320, Math.min(1600, Math.round(Number(requestedSize) || 640)));
    const cacheDir = getMediaCacheDir(cacheConfig);
    const cacheKey = crypto.createHash('sha256').update(`video-preview|${size}|${sourcePath}|${stat.size}|${stat.mtimeMs}`).digest('hex');
    const manifestPath = path.join(cacheDir, `${cacheKey}.json`);
    const readCached = () => {
      if (!fs.existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!Array.isArray(manifest.frames) || !manifest.frames.length || !manifest.frames.every(frame => fs.existsSync(frame))) return null;
        return { success: true, cached: true, complete: manifest.complete === true, duration: Number(manifest.duration) || 0, frameUrls: manifest.frames.map(toMediaUrl) };
      } catch { return null; }
    };
    const cached = readCached();
    if (cached?.complete || cacheOnly || (cached && !generateHoverFrames)) return cached || { success: true, cached: false, complete: false, duration: 0, frameUrls: [] };

    if (!videoPreviewJobs.has(cacheKey)) {
      const runPreviewJob = () => new Promise((resolve, reject) => {
        const toolArgs = ['--source', sourcePath, '--output_dir', cacheDir, '--cache_key', cacheKey, '--size', String(size)];
        if (generateHoverFrames && cached) toolArgs.push('--remaining_only');
        else if (!generateHoverFrames) toolArgs.push('--cover_only');
        const { command, args } = getRunConfig('video_preview.py', toolArgs);
        const child = spawn(command, args, { windowsHide: true });
        let stdoutBuffer = '';
        let stderr = '';
        let previewDuration = 0;
        let publishedFrameCount = 0;
        let progressTimer;
        const isCompleteJpeg = framePath => {
          try {
            const frameStat = fs.statSync(framePath);
            if (frameStat.size < 1024) return false;
            const handle = fs.openSync(framePath, 'r');
            const ending = Buffer.alloc(2);
            fs.readSync(handle, ending, 0, 2, frameStat.size - 2);
            fs.closeSync(handle);
            return ending[0] === 0xff && ending[1] === 0xd9;
          } catch { return false; }
        };
        const publishFinishedFrames = () => {
          if (!previewDuration) return;
          const frames = Array.from({ length: 5 }, (_value, index) => path.join(cacheDir, `${cacheKey}-${index + 1}.jpg`)).filter(isCompleteJpeg);
          if (frames.length <= publishedFrameCount) return;
          publishedFrameCount = frames.length;
          fs.writeFileSync(manifestPath, JSON.stringify({ duration: previewDuration, frames, complete: frames.length === 5 }), 'utf8');
        };
        const consumeOutput = (flush = false) => {
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = flush ? '' : lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const payload = JSON.parse(trimmed);
              if (payload.error) throw new Error(payload.error);
              if (Array.isArray(payload.frames) && payload.frames.length && payload.frames.every(frame => fs.existsSync(frame))) {
                previewDuration = Number(payload.duration) || previewDuration;
                fs.writeFileSync(manifestPath, JSON.stringify(payload), 'utf8');
                publishedFrameCount = Math.max(publishedFrameCount, payload.frames.length);
                if (!progressTimer && payload.complete !== true) progressTimer = setInterval(publishFinishedFrames, 100);
              }
            } catch (error) {
              writeLog('warn', 'Unable to process video preview progress', { filePath, error: error.message || String(error) });
            }
          }
        };
        child.stdout.on('data', data => { stdoutBuffer += data.toString(); consumeOutput(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('error', reject);
        child.on('close', code => {
          try {
            if (progressTimer) clearInterval(progressTimer);
            if (stdoutBuffer.trim()) { stdoutBuffer += '\n'; consumeOutput(true); }
            publishFinishedFrames();
            const finalManifest = readCached();
            if (code !== 0 || !finalManifest || (generateHoverFrames && !finalManifest.complete)) throw new Error(stderr.trim() || '视频抽样进程失败');
            trimMediaCache(cacheDir, cacheConfig?.maxSizeGB);
            resolve(finalManifest);
          } catch (error) { reject(error); }
        });
      });
      const job = generateHoverFrames ? runPreviewJob() : videoPreviewWorkChain.then(runPreviewJob);
      if (!generateHoverFrames) videoPreviewWorkChain = job.catch(() => undefined);
      const trackedJob = job.finally(() => videoPreviewJobs.delete(cacheKey));
      trackedJob.catch(() => undefined);
      videoPreviewJobs.set(cacheKey, trackedJob);
    }
    if (cached && !generateHoverFrames) return cached;
    const job = videoPreviewJobs.get(cacheKey);
    while (videoPreviewJobs.has(cacheKey)) {
      const progressive = readCached();
      if (progressive) return progressive;
      await Promise.race([job.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 50))]);
    }
    const generated = readCached();
    if (!generated) throw new Error('视频代表帧未能写入缓存');
    return generated;
  } catch (error) {
    writeLog('warn', 'Video hover preview failed', { filePath, error: error.message || String(error) });
    return { success: false, cached: false, complete: false, duration: 0, frameUrls: [], error: error.message || String(error) };
  }
});

ipcMain.handle('media-raw-preview', async (_event, filePath, cacheConfig = {}) => {
  try {
    const sourcePath = path.resolve(filePath);
    if (!RAW_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()) || !fs.existsSync(sourcePath)) throw new Error('RAW 文件不存在或格式不受支持');
    const preview = rawPreviewPath(sourcePath, fs.statSync(sourcePath), cacheConfig);
    return preview ? { success: true, previewUrl: toMediaUrl(preview) } : { success: false, error: '未找到内嵌预览' };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

ipcMain.handle('folder-has-png', async (_event, folderPath) => {
  try {
    const target = path.resolve(folderPath);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('文件夹不存在');
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const handle = fs.openSync(path.join(target, entry.name), 'r');
      const header = Buffer.alloc(8);
      fs.readSync(handle, header, 0, 8, 0);
      fs.closeSync(handle);
      if (header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { success: true, hasPng: true };
    }
    return { success: true, hasPng: false };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

class FileOperationCancelledError extends Error {
  constructor() { super('操作已取消'); this.name = 'FileOperationCancelledError'; }
}

const assertFileOperationActive = job => {
  if (job.cancelled) throw new FileOperationCancelledError();
};

const collectCopyPlan = async (source, destination, plan, job) => {
  assertFileOperationActive(job);
  const stat = await fs.promises.lstat(source);
  if (stat.isDirectory()) {
    plan.push({ kind: 'directory', source, destination, size: 0 });
    const entries = await fs.promises.readdir(source);
    for (const name of entries) await collectCopyPlan(path.join(source, name), path.join(destination, name), plan, job);
    return;
  }
  if (!stat.isFile()) throw new Error(`不支持复制此文件类型：${path.basename(source)}`);
  plan.push({ kind: 'file', source, destination, size: stat.size, mode: stat.mode, atime: stat.atime, mtime: stat.mtime });
};

const copyFileWithProgress = async (entry, job, onBytes, onCreated) => {
  const sourceHandle = await fs.promises.open(entry.source, 'r');
  let destinationHandle;
  try {
    destinationHandle = await fs.promises.open(entry.destination, 'wx', entry.mode);
    onCreated();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      assertFileOperationActive(job);
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      await destinationHandle.write(buffer, 0, bytesRead, position);
      position += bytesRead;
      onBytes(bytesRead);
    }
    await destinationHandle.sync();
    await fs.promises.utimes(entry.destination, entry.atime, entry.mtime);
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    destinationHandle = undefined;
    await fs.promises.rm(entry.destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await sourceHandle.close().catch(() => undefined);
    await destinationHandle?.close().catch(() => undefined);
  }
};

const removeCreatedPasteTargets = async targets => {
  for (const target of targets.slice().reverse()) await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
};

const runWindowsClipboardScript = script => new Promise((resolve, reject) => {
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodedCommand], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) reject(error);
    else resolve(value);
  };
  const timeout = setTimeout(() => {
    child.kill();
    finish(new Error('系统剪贴板响应超时'));
  }, 8000);
  child.stdout.on('data', data => { stdout += data.toString('utf8'); });
  child.stderr.on('data', data => { stderr += data.toString('utf8'); });
  child.on('error', error => finish(error));
  child.on('close', code => finish(code === 0 ? null : new Error(stderr.trim() || `PowerShell 退出，代码 ${code}`), stdout.trim()));
});

const writeSystemFileClipboard = async (sources, operation) => {
  if (process.platform !== 'win32') return false;
  const payload = Buffer.from(JSON.stringify({ sources, operation }), 'utf8').toString('base64');
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payload}'))
$payload = ConvertFrom-Json $json
$files = New-Object System.Collections.Specialized.StringCollection
foreach ($file in $payload.sources) { [void]$files.Add([string]$file) }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($files)
$effect = if ($payload.operation -eq 'cut') { 2 } else { 1 }
$data.SetData('Preferred DropEffect', (New-Object System.IO.MemoryStream(,[System.BitConverter]::GetBytes([int]$effect))))
for ($attempt = 0; $attempt -lt 5; $attempt++) {
  try { [System.Windows.Forms.Clipboard]::SetDataObject($data, $true); exit 0 }
  catch { if ($attempt -eq 4) { throw }; Start-Sleep -Milliseconds 80 }
}`;
  await runWindowsClipboardScript(script);
  return true;
};

const readSystemFileClipboard = async () => {
  if (process.platform !== 'win32') return null;
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$files = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ })
$operation = 'copy'
if ($data -and $data.GetDataPresent('Preferred DropEffect')) {
  $effectData = $data.GetData('Preferred DropEffect')
  if ($effectData -is [System.IO.Stream]) {
    $effectData.Position = 0
    $effect = $effectData.ReadByte()
  } elseif ($effectData -is [byte[]] -and $effectData.Length) {
    $effect = $effectData[0]
  }
  if (($effect -band 2) -eq 2) { $operation = 'cut' }
}
@{ sources = $files; operation = $operation } | ConvertTo-Json -Compress`;
  const output = await runWindowsClipboardScript(script);
  return output ? JSON.parse(output) : null;
};

ipcMain.handle('workspace-cancel-file-operation', async (_event, operationId) => {
  const job = activeProjectFileOperations.get(operationId);
  if (!job || job.finishing) return { success: false, error: job?.finishing ? '文件已复制完成，正在整理源文件' : '操作已结束' };
  job.cancelled = true;
  return { success: true };
});

ipcMain.handle('workspace-file-operation', async (event, workspacePath, status, projectName, operation, relativePaths = [], targetRelativePath = '', nextName = '', options = {}) => {
  try {
    const root = path.resolve(getProjectPath(workspacePath, status, projectName));
    const resolveInsideProject = relativePath => {
      const target = path.resolve(root, relativePath || '.');
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error('无效的文件路径');
      return target;
    };
    const sources = relativePaths.map(resolveInsideProject);
    if (operation === 'copy' || operation === 'cut') {
      if (!sources.length) throw new Error('未选择文件');
      projectFileClipboard = { operation, sources };
      try {
        await writeSystemFileClipboard(sources, operation);
      } catch (error) {
        writeLog('warn', 'Unable to sync project files to the system clipboard', error);
      }
      return { success: true, count: sources.length };
    }
    if (operation === 'paste') {
      if (activeProjectFileOperations.size) throw new Error('已有文件粘贴任务正在进行');
      const destinationDir = resolveInsideProject(targetRelativePath);
      if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('目标文件夹不存在');
      let clipboardSnapshot = null;
      try {
        const systemClipboard = await readSystemFileClipboard();
        if (systemClipboard?.sources?.length) clipboardSnapshot = { operation: systemClipboard.operation, sources: systemClipboard.sources.map(source => path.resolve(source)) };
      } catch (error) {
        writeLog('warn', 'Unable to read project files from the system clipboard', error);
      }
      if (!clipboardSnapshot && projectFileClipboard?.sources?.length) {
        clipboardSnapshot = { operation: projectFileClipboard.operation, sources: [...projectFileClipboard.sources] };
      }
      if (!clipboardSnapshot?.sources?.length) throw new Error('剪贴板中没有文件或文件夹');
      const operationId = crypto.randomUUID();
      const job = { cancelled: false, finishing: false };
      const createdTargets = [];
      activeProjectFileOperations.set(operationId, job);
      const publish = payload => {
        if (!event.sender.isDestroyed()) event.sender.send('workspace-file-operation-progress', { operationId, operation: 'paste', ...payload });
      };
      publish({ phase: 'scanning', progress: 0, currentName: '', bytesCopied: 0, totalBytes: 0 });
      try {
        const topLevelTargets = [];
        const plan = [];
        for (const source of clipboardSnapshot.sources) {
          assertFileOperationActive(job);
          if (!fs.existsSync(source)) continue;
          let destination = path.join(destinationDir, path.basename(source));
          const parsed = path.parse(destination);
          let index = 1;
          while (fs.existsSync(destination)) destination = path.join(destinationDir, `${parsed.name} (${index++})${parsed.ext}`);
          if (destination === source || destination.startsWith(source + path.sep)) throw new Error('不能将文件夹粘贴到自身内部');
          topLevelTargets.push({ source, destination });
          await collectCopyPlan(source, destination, plan, job);
        }
        const totalBytes = plan.reduce((sum, entry) => sum + entry.size, 0);
        const totalFiles = plan.filter(entry => entry.kind === 'file').length;
        let bytesCopied = 0;
        let filesCopied = 0;
        let lastPublishedAt = 0;
        const reportCopyProgress = (currentName, force = false) => {
          const now = Date.now();
          if (!force && now - lastPublishedAt < 80) return;
          lastPublishedAt = now;
          const progress = totalBytes > 0
            ? Math.min(99, Math.round(bytesCopied / totalBytes * 100))
            : Math.min(99, Math.round(filesCopied / Math.max(1, totalFiles) * 100));
          publish({ phase: 'copying', progress, currentName, bytesCopied, totalBytes, filesCopied, totalFiles });
        };
        const markCreatedTarget = destination => {
          const target = topLevelTargets.find(item => item.destination === destination);
          if (target && !createdTargets.includes(destination)) createdTargets.push(destination);
        };
        for (const entry of plan) {
          assertFileOperationActive(job);
          if (entry.kind === 'directory') {
            await fs.promises.mkdir(entry.destination, { recursive: false });
            markCreatedTarget(entry.destination);
            continue;
          }
          reportCopyProgress(path.basename(entry.source), true);
          await fs.promises.mkdir(path.dirname(entry.destination), { recursive: true });
          await copyFileWithProgress(entry, job, copied => {
            bytesCopied += copied;
            reportCopyProgress(path.basename(entry.source));
          }, () => markCreatedTarget(entry.destination));
          filesCopied += 1;
          reportCopyProgress(path.basename(entry.source), true);
        }
        assertFileOperationActive(job);
        if (clipboardSnapshot.operation === 'cut') {
          job.finishing = true;
          publish({ phase: 'finishing', progress: 99, currentName: '正在移除源文件', bytesCopied, totalBytes, filesCopied, totalFiles });
          for (const source of clipboardSnapshot.sources) await fs.promises.rm(source, { recursive: true, force: true });
          projectFileClipboard = null;
          if (process.platform === 'win32') clipboard.clear();
        }
        const count = topLevelTargets.length;
        publish({ phase: 'complete', progress: 100, currentName: '', bytesCopied, totalBytes, filesCopied, totalFiles, count });
        writeLog('info', 'Project files pasted', { projectName, targetRelativePath, count, operationId });
        return { success: true, count, operationId };
      } catch (error) {
        // Once cut finalization starts, keeping the completed copies is the only
        // data-safe fallback if removing a source fails partway through.
        if (!job.finishing) await removeCreatedPasteTargets(createdTargets);
        if (error instanceof FileOperationCancelledError) {
          publish({ phase: 'cancelled', progress: 0, currentName: '' });
          writeLog('info', 'Project file paste cancelled', { projectName, operationId });
          return { success: false, cancelled: true, operationId, error: '粘贴已取消' };
        }
        publish({ phase: 'failed', progress: 0, currentName: '', error: error.message || String(error) });
        throw error;
      } finally {
        activeProjectFileOperations.delete(operationId);
      }
    }
    if (operation === 'trash') {
      const existingSources = sources.filter(source => fs.existsSync(source));
      const operationId = crypto.randomUUID();
      const totalCount = existingSources.length;
      const publish = payload => {
        if (!event.sender.isDestroyed()) event.sender.send('workspace-file-operation-progress', { operationId, operation: 'trash', ...payload });
      };
      let processedCount = 0;
      publish({ phase: 'trashing', progress: 0, currentName: '', processedCount, totalCount });
      try {
        for (const source of existingSources) {
          publish({ phase: 'trashing', progress: Math.round(processedCount / Math.max(1, totalCount) * 100), currentName: path.basename(source), processedCount, totalCount });
          await shell.trashItem(source);
          processedCount += 1;
          publish({ phase: 'trashing', progress: Math.round(processedCount / Math.max(1, totalCount) * 100), currentName: path.basename(source), processedCount, totalCount });
        }
        publish({ phase: 'complete', progress: 100, currentName: '', processedCount, totalCount });
        writeLog('info', 'Project files moved to trash', { projectName, count: processedCount, operationId });
        return { success: true, count: processedCount, operationId };
      } catch (error) {
        publish({ phase: 'failed', progress: Math.round(processedCount / Math.max(1, totalCount) * 100), currentName: '', processedCount, totalCount, error: error.message || String(error) });
        throw error;
      }
    }
    if (operation === 'select') {
      if (!sources.length) throw new Error('未选择媒体文件');
      const imageDirName = '图片选片';
      const videoDirName = '视频选片';
      const imageTarget = path.join(root, imageDirName);
      const videoTarget = path.join(root, videoDirName);
      let count = 0;
      for (const source of sources) {
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('只能选择媒体文件');
        const extension = path.extname(source).toLowerCase();
        const isVideo = VIDEO_EXTENSIONS.has(extension);
        const isImage = IMAGE_EXTENSIONS.has(extension) || RAW_EXTENSIONS.has(extension);
        if (!isVideo && !isImage) throw new Error('只能选择媒体文件');
        const destinationDir = isVideo ? videoTarget : imageTarget;
        fs.mkdirSync(destinationDir, { recursive: true });
        let destination = path.join(destinationDir, path.basename(source));
        const parsed = path.parse(destination);
        let index = 1;
        while (fs.existsSync(destination)) destination = path.join(destinationDir, `${parsed.name} (${index++})${parsed.ext}`);
        fs.copyFileSync(source, destination);
        count += 1;
      }
      return { success: true, count };
    }
    if (operation === 'rename') {
      if (!sources.length || !nextName.trim()) throw new Error('请选择文件并输入新名称');
      const baseName = nextName.trim();
      const destinations = sources.map((source, index) => {
        const extension = path.extname(source);
        const fileName = sources.length === 1 ? baseName : `${baseName}_${String(index + 1).padStart(2, '0')}${extension}`;
        return path.join(path.dirname(source), fileName);
      });
      for (const destination of destinations) {
        if (path.resolve(destination) === root || !path.resolve(destination).startsWith(root + path.sep)) throw new Error('无效的文件名');
        if (fs.existsSync(destination)) throw new Error('已有同名文件');
      }
      for (let index = 0; index < sources.length; index += 1) fs.renameSync(sources[index], destinations[index]);
      writeLog('info', 'Project files renamed', { projectName, count: sources.length });
      return { success: true, count: sources.length };
    }
    throw new Error('不支持的文件操作');
  } catch (error) {
    writeLog('error', 'Project file operation failed', { projectName, operation, targetRelativePath, count: relativePaths.length, error: error.message || String(error) });
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('choose-cache-directory', async () => {
  const choice = await dialog.showOpenDialog(mainWindow, { title: '选择缩略图缓存目录', properties: ['openDirectory', 'createDirectory'] });
  return choice.canceled ? { cancelled: true } : { path: choice.filePaths[0] };
});

ipcMain.handle('media-cache-info', async (_event, cacheConfig = {}) => {
  try { const cacheDir = getMediaCacheDir(cacheConfig); trimMediaCache(cacheDir, cacheConfig.maxSizeGB); return { success: true, path: cacheDir, ...getDirectorySize(cacheDir) }; }
  catch (error) { return { success: false, path: '', sizeBytes: 0, fileCount: 0, error: error.message || String(error) }; }
});

ipcMain.handle('media-cache-clear', async (_event, cacheConfig = {}) => {
  try {
    const cacheDir = getMediaCacheDir(cacheConfig);
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) if (entry.isFile()) fs.unlinkSync(path.join(cacheDir, entry.name));
    return { success: true };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

// 图片对比使用 JPEG 解码流程。开始前检查所选文件夹的直接图片文件，避免
// 在处理到一半才因 PNG 等格式失败。
ipcMain.handle('workspace-check-compare-folders', async (_event, folderPaths = []) => {
  try {
    const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff', '.heic']);
    const invalidFolders = folderPaths.map(folderPath => {
      const resolvedPath = path.resolve(folderPath);
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        throw new Error('所选文件夹不存在');
      }
      const files = fs.readdirSync(resolvedPath, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .filter(entry => {
          const extension = path.extname(entry.name).toLowerCase();
          return imageExtensions.has(extension) && extension !== '.jpg' && extension !== '.jpeg';
        })
        .map(entry => entry.name);
      return { path: resolvedPath, files };
    }).filter(folder => folder.files.length > 0);
    return { success: true, invalidFolders };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

const resolveProjectEntry = (workspacePath, status, projectName, relativePath = '') => {
  const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
  const target = path.resolve(projectPath, relativePath || '.');
  if (target !== projectPath && !target.startsWith(projectPath + path.sep)) throw new Error('无效的项目路径');
  if (!fs.existsSync(target)) throw new Error('文件或文件夹不存在');
  return target;
};

ipcMain.handle('workspace-open-project', async (_event, workspacePath, status, projectName, folderName) => {
  try {
    const target = resolveProjectEntry(workspacePath, status, projectName, folderName);
    const error = await shell.openPath(target);
    return { success: !error, error };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('workspace-open-entry', async (_event, workspacePath, status, projectName, relativePath) => {
  try {
    const target = resolveProjectEntry(workspacePath, status, projectName, relativePath);
    const error = await shell.openPath(target);
    return { success: !error, error };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

ipcMain.handle('workspace-copy-entry-path', async (_event, workspacePath, status, projectName, relativePath) => {
  try {
    const target = resolveProjectEntry(workspacePath, status, projectName, relativePath);
    clipboard.writeText(target);
    return { success: true };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

ipcMain.handle('workspace-entry-file-icon', async (_event, filePath) => {
  try {
    const target = path.resolve(filePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('文件不存在');
    const icon = await app.getFileIcon(target, { size: 'normal' });
    return { success: !icon.isEmpty(), dataUrl: icon.isEmpty() ? undefined : icon.toDataURL() };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

const BROLL_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.m4v', '.mkv']);
const FOUR_GB = 4 * 1024 * 1024 * 1024;

const splitVideoAt4Gb = (videoPath) => new Promise((resolve, reject) => {
  const { command, args } = getRunConfig('cut_video.py', [videoPath]);
  const child = spawn(command, args, { windowsHide: true });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `视频分割进程退出，代码 ${code}`)));
});

ipcMain.handle('workspace-import-broll', async (_event, workspacePath, status, projectName, options = {}) => {
  try {
    const { splitLargeFiles = false, clearSource = true } = options || {};
    const projectPath = getProjectPath(workspacePath, status, projectName);
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择花絮文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '媒体文件', extensions: ['jpg', 'jpeg', 'png', 'heic', 'mp4', 'mov', 'avi', 'm4v', 'mkv'] }, { name: '所有文件', extensions: ['*'] }]
    });
    if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0, splitCount: 0, clearedCount: 0 };

    const destinationDir = path.join(projectPath, '花絮');
    fs.mkdirSync(destinationDir, { recursive: true });
    let count = 0;
    let splitCount = 0;
    let clearedCount = 0;

    for (const sourcePath of choice.filePaths) {
      const parsed = path.parse(sourcePath);
      let targetPath = path.join(destinationDir, parsed.base);
      if (fs.existsSync(targetPath)) targetPath = path.join(destinationDir, `${parsed.name}_${Date.now()}_${count}${parsed.ext}`);
      fs.copyFileSync(sourcePath, targetPath);

      const shouldSplit = splitLargeFiles && BROLL_VIDEO_EXTENSIONS.has(parsed.ext.toLowerCase()) && fs.statSync(targetPath).size > FOUR_GB;
      if (shouldSplit) {
        await splitVideoAt4Gb(targetPath);
        const splitPrefix = path.parse(targetPath).name + '_part';
        const splitExtension = path.extname(targetPath).toLowerCase();
        const segmentCount = fs.readdirSync(destinationDir).filter(fileName => fileName.startsWith(splitPrefix) && path.extname(fileName).toLowerCase() === splitExtension).length;
        if (segmentCount < 2) throw new Error('视频分割未生成完整分段：' + parsed.base);
        await shell.trashItem(targetPath);
        splitCount += 1;
      }

      if (clearSource && fs.existsSync(sourcePath)) {
        await shell.trashItem(sourcePath);
        clearedCount += 1;
      }
      count += 1;
    }

    writeLog('info', 'B-roll imported', { projectPath, count, splitCount, clearedCount });
    return { success: true, count, splitCount, clearedCount };
  } catch (error) {
    writeLog('error', 'B-roll import failed', error);
    return { success: false, error: error.message || String(error) };
  }
});
app.whenReady().then(() => {
  protocol.handle('photoflow-media', request => {
    try {
      const encodedPath = new URL(request.url).pathname.replace(/^\//, '');
      const filePath = Buffer.from(encodedPath, 'base64url').toString('utf8');
      if (!path.isAbsolute(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return new Response('Not found', { status: 404 });
      // Forward Range headers so video metadata and sampled hover frames do not
      // require reading the entire source file.
      return net.fetch(pathToFileURL(filePath).toString(), { method: request.method, headers: request.headers });
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });
  const deletedLogFiles = cleanupExpiredLogs();
  writeLog('info', 'Application started', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, deletedExpiredLogFiles: deletedLogFiles });
  createWindow();

  setTimeout(checkForUpdates, 3000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopWorkspaceWatcher();
  stopShellThumbnailProcess();
  void exiftool.end().catch(() => undefined);
});

app.on('window-all-closed', () => {
  writeLog('info', 'All application windows closed');
  if (process.platform !== 'darwin') app.quit();
});
process.on('uncaughtException', (error) => {
  writeLog('error', 'Uncaught main-process exception', error);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-error', error.message || '主进程发生未知错误');
});

process.on('unhandledRejection', (reason) => {
  writeLog('error', 'Unhandled main-process promise rejection', reason);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-error', reason instanceof Error ? reason.message : String(reason || '后台操作失败'));
});
