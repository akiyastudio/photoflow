const { app, BrowserWindow, ipcMain, Menu, shell, dialog, protocol, net, nativeImage, clipboard, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { pathToFileURL } = require('url');
const { exiftool } = require('exiftool-vendored');
const { ThumbnailPipeline, THUMBNAIL_VERSION, PRIORITY } = require('./thumbnail-pipeline.cjs');

// Keep user-facing OS labels localized while runtime data stays in a stable,
// Latin-only application directory name.
app.setPath('userData', path.join(app.getPath('appData'), 'Photoflow'));
app.setName('照片流');

protocol.registerSchemesAsPrivileged([{ scheme: 'photoflow-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const toMediaUrl = filePath => `photoflow-media://file/${Buffer.from(filePath, 'utf8').toString('base64url')}`;

let cachedPhotoshopPath;
let photoshopDiscoveryPromise = null;
const queryPhotoshopRegistry = () => new Promise(resolve => {
  const child = spawn('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe', '/ve'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => { output = (output + data).slice(-16000); });
  child.on('error', () => resolve(''));
  child.on('close', code => resolve(code === 0 ? output : ''));
});

const findLatestPhotoshop = () => {
  if (cachedPhotoshopPath !== undefined) return Promise.resolve(cachedPhotoshopPath);
  if (photoshopDiscoveryPromise) return photoshopDiscoveryPromise;
  photoshopDiscoveryPromise = (async () => {
    if (process.platform !== 'win32') {
      cachedPhotoshopPath = null;
      return cachedPhotoshopPath;
    }

    const candidates = [];
    const addCandidate = (executable, version = []) => {
      if (executable && fs.existsSync(executable)) candidates.push({ executable, version });
    };
    for (const root of [...new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean))]) {
      const adobeRoot = path.join(root, 'Adobe');
      if (!fs.existsSync(adobeRoot)) continue;
      for (const entry of fs.readdirSync(adobeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^Adobe Photoshop\b/i.test(entry.name) || /beta/i.test(entry.name)) continue;
        const version = (entry.name.match(/\d+(?:\.\d+)*/g) || []).flatMap(value => value.split('.').map(Number));
        addCandidate(path.join(adobeRoot, entry.name, 'Photoshop.exe'), version);
      }
    }

    if (!candidates.length) {
      const registryOutput = await queryPhotoshopRegistry();
      const match = registryOutput.match(/REG_SZ\s+(.+Photoshop\.exe)\s*$/im);
      if (match) addCandidate(match[1].trim());
    }

    candidates.sort((left, right) => {
      const length = Math.max(left.version.length, right.version.length);
      for (let index = 0; index < length; index += 1) {
        const difference = (right.version[index] || 0) - (left.version[index] || 0);
        if (difference) return difference;
      }
      return right.executable.localeCompare(left.executable, undefined, { numeric: true });
    });
    cachedPhotoshopPath = candidates[0]?.executable || null;
    return cachedPhotoshopPath;
  })().finally(() => { photoshopDiscoveryPromise = null; });
  return photoshopDiscoveryPromise;
};

let mainWindow;
let workspaceWatcher = null;
let watchedWorkspacePath = '';
let workspaceWatchTimer = null;
let projectFileClipboard = null;
const activeProjectFileOperations = new Map();
const mediaMetadataCache = new Map();
const rawOrientationCache = new Map();
const renameHistory = [];
const workspaceCatalogs = new Map();
let shellThumbnailProcess = null;
let shellThumbnailOutput = '';
let shellThumbnailRequestId = 0;
let shellThumbnailWorkChain = Promise.resolve();
const shellThumbnailRequests = new Map();
let shellThumbnailUnavailableLogged = false;
let thumbnailPipeline = null;
let thumbnailImageWorkerPool = null;
let originalImageWorkerPool = null;
let activeMediaCacheConfig = { maxSizeGB: 50, directory: '' };
const normalizeMediaCacheSizeGB = (value, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};
const workspaceWatchChanges = new Set();
const nativeConsoleLog = console.log.bind(console);
const nativeConsoleError = console.error.bind(console);

// Persist operational logs outside of the installation directory so they are
// available after an app restart or a packaged-app update.
const getLogDir = () => {
  const logDir = path.join(getConfigDir(), 'logs');
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

// Query Explorer's cache first, then optionally ask the installed provider to
// extract in the isolated helper process. Provider work never blocks Electron.
const copyWindowsShellThumbnailNow = (sourcePath, targetPath, requestedSize, cacheOnly = true) => new Promise(resolve => {
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
  }, cacheOnly ? 1500 : 10000);
  shellThumbnailRequests.set(requestId, { resolve, timer, targetPath });
  const encode = value => Buffer.from(value, 'utf8').toString('base64');
  child.stdin.write(`${requestId}\t${requestedSize}\t${encode(sourcePath)}\t${encode(targetPath)}\t${cacheOnly ? 'cache' : 'generate'}\n`, error => {
    if (!error) return;
    const request = shellThumbnailRequests.get(requestId);
    if (!request) return;
    shellThumbnailRequests.delete(requestId);
    clearTimeout(request.timer);
    request.resolve(false);
  });
});

const copyWindowsShellThumbnail = (sourcePath, targetPath, requestedSize, cacheOnly = true) => {
  // The COM helper is single-threaded. Serialize callers here so later requests
  // do not time out while an earlier provider is still decoding a large video.
  const job = shellThumbnailWorkChain.then(() => copyWindowsShellThumbnailNow(sourcePath, targetPath, requestedSize, cacheOnly));
  shellThumbnailWorkChain = job.catch(() => false);
  return job;
};

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
const MERGED_PYTHON_TOOLS = new Set(['classify', 'png_to_jpg', 'catch', 'cut_video', 'rename', 'research', 'thumbnail_db', 'video_preview']);

const getRunConfig = (scriptName, args) => {
  // 移除 .py 后缀 (兼容前端传入 'classify.py' 或 'classify')
  const baseName = scriptName.replace('.py', '');

  const isWin = process.platform === 'win32';

  if (app.isPackaged) {
    // 生产环境：根据平台决定是否有 .exe 后缀
    const exeSuffix = isWin ? '.exe' : '';
    if (baseName === 'thumbnail_image') {
      return {
        command: path.join(process.resourcesPath, 'python', 'thumbnail-image-worker', `thumbnail-image-worker${exeSuffix}`),
        args
      };
    }
    if (baseName === 'workspace_db') {
      return {
        command: path.join(process.resourcesPath, 'python', 'workspace-db-worker', `workspace-db-worker${exeSuffix}`),
        args
      };
    }
    if (MERGED_PYTHON_TOOLS.has(baseName)) {
      return {
        command: path.join(process.resourcesPath, 'python', 'tools', `tools${exeSuffix}`),
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
  // Keep runtime data under an ASCII-only path. This also prevents legacy
  // command-line tools from corrupting cache paths on Chinese Windows.
  const configDir = app.getPath('userData');
  fs.mkdirSync(configDir, { recursive: true });
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
    const executableName = baseName === 'thumbnail_image' ? 'thumbnail-image-worker' : baseName === 'workspace_db' ? 'workspace-db-worker' : MERGED_PYTHON_TOOLS.has(baseName) ? 'tools' : baseName;
    const scriptPath = path.join(process.resourcesPath, 'python', executableName, `${executableName}${exeSuffix}`);
    return fs.existsSync(scriptPath);
    
  } catch (error) {
    console.error("检查脚本失败:", error);
    return false;
  }
});

// 获取系统盘符列表

const WORKSPACE_STATUSES = ['未分类', '策划中', '待拍摄', '后期中', '已归档'];

const getWorkspaceDatabasePath = root => {
  const databaseDir = path.join(app.getPath('userData'), 'workspace-data');
  fs.mkdirSync(databaseDir, { recursive: true });
  const identity = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
  const fileName = `${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}.sqlite3`;
  return path.join(databaseDir, fileName);
};

class WorkspaceDatabaseClient {
  constructor() {
    this.process = null;
    this.output = '';
    this.nextId = 0;
    this.pending = new Map();
    this.stopping = false;
  }

  ensureProcess() {
    if (this.process && !this.process.killed) return this.process;
    const run = getRunConfig('workspace_db.py', ['--server']);
    const child = spawn(run.command, run.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    this.output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      this.output += data;
      const lines = this.output.split(/\r?\n/);
      this.output = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          const request = this.pending.get(response.id);
          if (!request) continue;
          this.pending.delete(response.id);
          clearTimeout(request.timer);
          if (response.success) request.resolve(response.result);
          else request.reject(new Error(response.error || '工作区数据库操作失败'));
        } catch (error) {
          writeLog('warn', 'Unable to parse workspace database response', { error: error.message, line: line.slice(0, 500) });
        }
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    const finish = error => {
      if (this.process === child) this.process = null;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      if (!this.stopping) writeLog('warn', 'Workspace database service stopped', { error: error.message || String(error) });
    };
    child.on('error', finish);
    child.on('exit', code => finish(new Error(stderr.trim() || `Workspace database service exited with code ${code}`)));
    return child;
  }

  call(root, action, payload = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const child = this.ensureProcess();
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`工作区数据库操作超时：${action}`));
        if (this.process === child) {
          this.process = null;
          if (!child.killed) child.kill();
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const request = { id, root, database: getWorkspaceDatabasePath(root), action, payload };
      child.stdin.write(`${JSON.stringify(request)}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  stop() {
    this.stopping = true;
    const child = this.process;
    this.process = null;
    if (child && !child.killed) child.kill();
  }
}

const workspaceDatabase = new WorkspaceDatabaseClient();
const runWorkspaceDatabase = (root, action, payload = {}) => workspaceDatabase.call(root, action, payload);

const refreshWorkspaceCatalog = async root => {
  const response = await runWorkspaceDatabase(root, 'init');
  const projects = Array.isArray(response.projects) ? response.projects : [];
  const catalog = { projects, byName: new Map(projects.map(project => [project.name.toLocaleLowerCase(), project])) };
  workspaceCatalogs.set(root, catalog);
  return catalog;
};

const mutateWorkspaceCatalog = async (root, action, payload) => {
  await runWorkspaceDatabase(root, action, payload);
  return refreshWorkspaceCatalog(root);
};

const ensureWorkspace = (workspacePath) => {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) throw new Error('尚未选择工作目录');
  const requestedPath = path.resolve(workspacePath.trim());
  const isDriveRoot = requestedPath === path.parse(requestedPath).root;
  // Never create or alter a drive root. A root selection uses its dedicated app folder.
  const root = isDriveRoot ? path.join(requestedPath, '照片流') : requestedPath;
  fs.mkdirSync(root, { recursive: true });
  return root;
};

const getProjectPath = (workspacePath, status, projectName) => {
  if (!WORKSPACE_STATUSES.includes(status)) throw new Error('无效的项目状态');
  const root = ensureWorkspace(workspacePath);
  const row = workspaceCatalogs.get(root)?.byName.get(String(projectName).toLocaleLowerCase());
  const relativePath = row?.relative_path || projectName;
  const projectPath = path.resolve(root, relativePath);
  if (!projectPath.startsWith(root + path.sep)) throw new Error('无效的项目路径');
  return projectPath;
};

const cleanProjectName = (value) => value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

const stopWorkspaceWatcher = () => {
  if (workspaceWatchTimer) clearTimeout(workspaceWatchTimer);
  workspaceWatchTimer = null;
  if (workspaceWatcher) workspaceWatcher.close();
  workspaceWatcher = null;
  watchedWorkspacePath = '';
  workspaceWatchChanges.clear();
};

const watchWorkspace = (root) => {
  if (watchedWorkspacePath === root && workspaceWatcher) return;
  stopWorkspaceWatcher();
  try {
    workspaceWatcher = fs.watch(root, { recursive: process.platform !== 'linux' }, (_eventType, fileName) => {
      if (fileName) workspaceWatchChanges.add(String(fileName));
      if (workspaceWatchTimer) clearTimeout(workspaceWatchTimer);
      workspaceWatchTimer = setTimeout(() => {
        const changedNames = [...workspaceWatchChanges];
        workspaceWatchChanges.clear();
        if (thumbnailPipeline) {
          const changesByProject = new Map();
          for (const changedName of changedNames) {
            const segments = changedName.split(/[\\/]/).filter(Boolean);
            if (segments.length < 2) continue;
            const projectRoot = path.join(root, segments[0]);
            if (!changesByProject.has(projectRoot)) changesByProject.set(projectRoot, []);
            changesByProject.get(projectRoot).push(path.join(root, changedName));
          }
          for (const [projectRoot, changedPaths] of changesByProject) {
            void thumbnailPipeline.syncChangedPaths(projectRoot, changedPaths, activeMediaCacheConfig).catch(error => {
              writeLog('warn', 'Unable to update thumbnail index from file watcher', { projectRoot, error: error.message || String(error) });
            });
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          for (const changedName of changedNames.length ? changedNames : ['']) {
            mainWindow.webContents.send('workspace-files-changed', { root, fileName: changedName });
          }
          if (changedNames.some(changedName => changedName.split(/[\\/]/).filter(Boolean).length === 1)) {
            mainWindow.webContents.send('workspace-projects-changed', { root });
          }
        }
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
    const catalog = await refreshWorkspaceCatalog(root);
    const statuses = WORKSPACE_STATUSES.map(status => {
      const projects = catalog.projects
        .filter(project => project.status === status)
        .map(project => {
          const projectPath = path.resolve(root, project.relative_path);
          return { name: project.name, path: projectPath, status, updatedAt: fs.existsSync(projectPath) ? fs.statSync(projectPath).mtimeMs : project.updated_at };
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
    const root = ensureWorkspace(workspacePath);
    const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
    if (catalog.byName.has(projectName.toLocaleLowerCase())) throw new Error('同名项目已存在');
    const projectPath = getProjectPath(workspacePath, '策划中', projectName);
    if (fs.existsSync(projectPath)) throw new Error('同名项目已存在');
    fs.mkdirSync(projectPath, { recursive: false });
    fs.mkdirSync(path.join(projectPath, '策划'), { recursive: true });
    await mutateWorkspaceCatalog(root, 'add', { name: projectName, status: '策划中', relativePath: path.relative(root, projectPath) });
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
    const root = ensureWorkspace(workspacePath);
    const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
    const existingProject = catalog.byName.get(cleanedName.toLocaleLowerCase());
    if (existingProject && existingProject.name.toLocaleLowerCase() !== projectName.toLocaleLowerCase()) throw new Error('同名项目已存在');
    const source = getProjectPath(workspacePath, status, projectName);
    const destination = path.join(path.dirname(source), cleanedName);
    if (!fs.existsSync(source)) throw new Error('项目不存在');
    if (fs.existsSync(destination)) throw new Error('同名项目已存在');
    fs.renameSync(source, destination);
    await mutateWorkspaceCatalog(root, 'rename', { name: projectName, nextName: cleanedName, relativePath: path.relative(root, destination) });
    renameHistory.push({ kind: 'project', source, destination, status, workspaceRoot: root, beforeName: projectName, afterName: cleanedName });
    return { success: true, project: { name: cleanedName, path: destination, status, updatedAt: Date.now() } };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});
ipcMain.handle('workspace-create-project-folder', async (_event, workspacePath, status, projectName, folderName, relativePath = '', makeUnique = false) => {
  try {
    const cleanedName = cleanProjectName(folderName || '');
    if (!cleanedName) throw new Error('文件夹名称不能为空');
    const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
    const parentPath = path.resolve(projectPath, relativePath || '.');
    if (parentPath !== projectPath && !parentPath.startsWith(projectPath + path.sep)) throw new Error('无效的文件夹位置');
    let actualName = cleanedName;
    let folderPath = path.resolve(parentPath, actualName);
    if (!folderPath.startsWith(parentPath + path.sep)) throw new Error('无效的文件夹名称');
    if (makeUnique) {
      let index = 2;
      while (fs.existsSync(folderPath)) {
        actualName = `${cleanedName} (${index++})`;
        folderPath = path.resolve(parentPath, actualName);
      }
    } else if (fs.existsSync(folderPath)) throw new Error('同名文件夹已存在');
    fs.mkdirSync(folderPath);
    return { success: true, folder: { name: actualName, path: folderPath, relativePath: path.relative(projectPath, folderPath), updatedAt: Date.now() } };
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
      await mutateWorkspaceCatalog(operation.workspaceRoot, 'rename', { name: operation.afterName, nextName: operation.beforeName, relativePath: path.relative(operation.workspaceRoot, operation.source) });
      response.project = { name: operation.beforeName, path: operation.source, status: operation.status, updatedAt: Date.now() };
    }
    return response;
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('workspace-move-project', async (_event, workspacePath, currentStatus, projectName, nextStatus) => {
  try {
    if (!WORKSPACE_STATUSES.includes(nextStatus)) throw new Error('无效的项目状态');
    if (nextStatus === '未分类') throw new Error('未分类仅用于自动发现的新文件夹');
    const root = ensureWorkspace(workspacePath);
    if (!workspaceCatalogs.has(root)) await refreshWorkspaceCatalog(root);
    const source = getProjectPath(workspacePath, currentStatus, projectName);
    if (!fs.existsSync(source)) throw new Error('项目不存在');
    await mutateWorkspaceCatalog(root, 'status', { name: projectName, status: nextStatus });
    return { success: true, project: { name: projectName, path: source, status: nextStatus, updatedAt: Date.now() } };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('workspace-archive-imports', async (_event, workspacePath) => {
  try {
    const root = ensureWorkspace(workspacePath);
    const plannedStatus = '待拍摄';
    const catalog = await refreshWorkspaceCatalog(root);
    const importedFolders = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_') && !WORKSPACE_STATUSES.includes(entry.name) && !catalog.byName.has(entry.name.toLocaleLowerCase()));
    const projects = [];

    for (const folder of importedFolders) {
      const projectPath = path.join(root, folder.name);
      await runWorkspaceDatabase(root, 'add', { name: folder.name, status: plannedStatus, relativePath: folder.name });

      projects.push({ name: folder.name, path: projectPath, status: plannedStatus, updatedAt: fs.statSync(projectPath).mtimeMs });
    }

    if (projects.length) await refreshWorkspaceCatalog(root);

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
    const root = ensureWorkspace(workspacePath);
    await mutateWorkspaceCatalog(root, 'delete', { name: projectName });
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

const mediaCacheIndexes = new Map();

const refreshMediaCacheIndex = async cacheDir => {
  const directory = path.resolve(cacheDir);
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files = new Map();
  let totalBytes = 0;
  await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      files.set(filePath, { size: stat.size, used: stat.atimeMs || stat.mtimeMs });
      totalBytes += stat.size;
    } catch { /* file changed while the cache snapshot was being built */ }
  }));
  const previous = mediaCacheIndexes.get(directory);
  const state = previous || { pendingPaths: new Set(), timer: null, running: false, maxBytes: 50 * 1024 ** 3 };
  state.files = files;
  state.totalBytes = totalBytes;
  state.initialized = true;
  mediaCacheIndexes.set(directory, state);
  return state;
};

const getMediaCacheIndex = async cacheDir => {
  const directory = path.resolve(cacheDir);
  const current = mediaCacheIndexes.get(directory);
  if (current?.initialized) return current;
  if (current?.initializing) return current.initializing;
  const state = current || { pendingPaths: new Set(), timer: null, running: false, maxBytes: 50 * 1024 ** 3 };
  state.initializing = refreshMediaCacheIndex(directory).finally(() => { state.initializing = null; });
  mediaCacheIndexes.set(directory, state);
  return state.initializing;
};

const updateMediaCacheIndex = async (state, changedPaths) => {
  for (const filePath of changedPaths) {
    const resolved = path.resolve(filePath);
    const previous = state.files.get(resolved);
    try {
      const stat = await fs.promises.stat(resolved);
      state.files.set(resolved, { size: stat.size, used: stat.atimeMs || stat.mtimeMs });
      state.totalBytes += stat.size - (previous?.size || 0);
    } catch {
      if (previous) state.totalBytes -= previous.size;
      state.files.delete(resolved);
    }
  }
};

const runMediaCacheMaintenance = async cacheDir => {
  const directory = path.resolve(cacheDir);
  const state = await getMediaCacheIndex(directory);
  if (state.running) return;
  state.running = true;
  try {
    const changedPaths = [...state.pendingPaths];
    state.pendingPaths.clear();
    await updateMediaCacheIndex(state, changedPaths);
    if (state.totalBytes <= state.maxBytes) return;
    // Access times only need a full refresh when eviction is actually needed.
    const refreshed = await refreshMediaCacheIndex(directory);
    const oldest = [...refreshed.files.entries()].sort((left, right) => left[1].used - right[1].used);
    for (const [filePath, record] of oldest) {
      if (refreshed.totalBytes <= refreshed.maxBytes) break;
      try { await fs.promises.unlink(filePath); } catch { continue; }
      refreshed.files.delete(filePath);
      refreshed.totalBytes -= record.size;
    }
  } finally {
    state.running = false;
    if (state.pendingPaths.size) trimMediaCache(directory, state.maxBytes / 1024 ** 3, []);
  }
};

const trimMediaCache = (cacheDir, maxSizeGB, changedPaths = []) => {
  const directory = path.resolve(cacheDir);
  const state = mediaCacheIndexes.get(directory) || { pendingPaths: new Set(), timer: null, running: false, maxBytes: 50 * 1024 ** 3 };
  state.maxBytes = normalizeMediaCacheSizeGB(maxSizeGB) * 1024 ** 3;
  for (const filePath of changedPaths) state.pendingPaths.add(path.resolve(filePath));
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void runMediaCacheMaintenance(directory).catch(error => writeLog('warn', 'Media cache maintenance failed', { directory, error: error.message || String(error) }));
  }, 500);
  mediaCacheIndexes.set(directory, state);
};

const isCompleteJpegFile = filePath => {
  try {
    const fileStat = fs.statSync(filePath);
    if (!fileStat.isFile() || fileStat.size < 128) return false;
    const handle = fs.openSync(filePath, 'r');
    try {
      const markers = Buffer.alloc(4);
      fs.readSync(handle, markers, 0, 2, 0);
      fs.readSync(handle, markers, 2, 2, fileStat.size - 2);
      return markers[0] === 0xff && markers[1] === 0xd8 && markers[2] === 0xff && markers[3] === 0xd9;
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
};

const rawPreviewPath = async (sourcePath, stat, cacheConfig) => {
  const cacheDir = getMediaCacheDir(cacheConfig);
  const target = rawPreviewCacheFile(sourcePath, stat, cacheDir);
  if (isCompleteJpegFile(target)) return target;
  if (fs.existsSync(target)) void fs.promises.unlink(target).catch(() => undefined);
  try {
    await generateOriginalImagePreviewFile(sourcePath, 'raw', [{ sizeLabel: 'raw-preview', pixels: 0, path: target }]);
    if (!isCompleteJpegFile(target)) return null;
    trimMediaCache(cacheDir, cacheConfig?.maxSizeGB, [target]);
    return target;
  } catch (error) {
    writeLog('warn', 'RAW embedded preview extraction failed', { sourcePath, error: error.message || String(error) });
    return null;
  }
};

const mediaSourceCacheKey = sourcePath => process.platform === 'win32' ? path.resolve(sourcePath).toLowerCase() : path.resolve(sourcePath);
const rawPreviewCacheFile = (sourcePath, stat, cacheDir) => path.join(cacheDir, crypto.createHash('sha256').update(`${mediaSourceCacheKey(sourcePath)}|${stat.size}|${stat.mtimeMs}`).digest('hex') + '.jpg');
const mediaThumbnailCacheFile = (sourcePath, stat, cacheDir, requestedSize, version = THUMBNAIL_VERSION) => path.join(cacheDir, crypto.createHash('sha256').update(`thumbnail|v${version}|${requestedSize}|${mediaSourceCacheKey(sourcePath)}|${stat.size}|${stat.mtimeMs}`).digest('hex') + '.jpg');

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

const writeThumbnailJpeg = (target, image, quality) => {
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, image.toJPEG(quality));
    if (fs.existsSync(target)) fs.unlinkSync(temporary);
    else fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
};

class ThumbnailImageWorkerPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.nextId = 0;
    this.stopped = false;
  }

  run(source, kind, outputs, urgent = false) {
    if (this.stopped) return Promise.reject(new Error('图片解码服务已经停止'));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.nextId, source, kind, outputs, resolve, reject };
      if (urgent) this.queue.unshift(job);
      else this.queue.push(job);
      this.pump();
    });
  }

  createWorker() {
    const { command, args } = getRunConfig('thumbnail_image.py', ['--server']);
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const worker = { child, output: '', stderr: '', job: null, timer: null, dead: false };
    this.workers.push(worker);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      worker.output += data;
      const lines = worker.output.split(/\r?\n/);
      worker.output = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (!worker.job || response.id !== worker.job.id) continue;
        const job = worker.job;
        worker.job = null;
        clearTimeout(worker.timer);
        worker.timer = null;
        if (response.success) job.resolve(response.generated || []);
        else job.reject(new Error(response.error || '图片解码失败'));
        this.pump();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { worker.stderr = (worker.stderr + data).slice(-4000); });
    const finish = error => {
      if (worker.dead) return;
      worker.dead = true;
      clearTimeout(worker.timer);
      if (worker.job) worker.job.reject(error);
      worker.job = null;
      this.workers = this.workers.filter(item => item !== worker);
      if (!this.stopped) this.pump();
    };
    child.on('error', finish);
    child.on('exit', code => finish(new Error(worker.stderr.trim() || `图片解码服务退出，代码 ${code}`)));
    return worker;
  }

  pump() {
    if (this.stopped) return;
    while (this.workers.length < this.size && this.queue.length > this.workers.filter(worker => !worker.job && !worker.dead).length) this.createWorker();
    for (const worker of this.workers) {
      if (worker.dead || worker.job || !this.queue.length) continue;
      const job = this.queue.shift();
      worker.job = job;
      worker.timer = setTimeout(() => {
        if (worker.job === job) worker.child.kill();
      }, 120000);
      worker.child.stdin.write(`${JSON.stringify({ id: job.id, source: job.source, kind: job.kind, outputs: job.outputs })}\n`, error => {
        if (error && !worker.dead) worker.child.kill();
      });
    }
  }

  stop() {
    this.stopped = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('图片解码服务已经停止'));
    for (const worker of this.workers) if (!worker.child.killed) worker.child.kill();
  }
}

const generateImageThumbnailFiles = (sourcePath, kind, outputs, urgent = false) => {
  if (!thumbnailImageWorkerPool) thumbnailImageWorkerPool = new ThumbnailImageWorkerPool(2);
  return thumbnailImageWorkerPool.run(sourcePath, kind, outputs, urgent);
};

const generateOriginalImagePreviewFile = (sourcePath, kind, outputs) => {
  // Full preview extraction must never wait behind project thumbnail warming.
  // A dedicated one-worker pool keeps selection latency bounded even while the
  // background scheduler is decoding hundreds of files.
  if (!originalImageWorkerPool) originalImageWorkerPool = new ThumbnailImageWorkerPool(1);
  return originalImageWorkerPool.run(sourcePath, kind, outputs, true);
};

const generateVideoCoverSource = (sourcePath, stat, cacheDir, requestedSize) => new Promise((resolve, reject) => {
  const cacheKey = crypto.createHash('sha256').update(`scheduler-video-cover|v${THUMBNAIL_VERSION}|${requestedSize}|${sourcePath}|${stat.size}|${stat.mtimeMs}`).digest('hex');
  const toolArgs = ['--source', sourcePath, '--output_dir', cacheDir, '--cache_key', cacheKey, '--size', String(requestedSize), '--cover_only'];
  const { command, args } = getRunConfig('video_preview.py', toolArgs);
  const child = spawn(command, args, { windowsHide: true });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill(), 120000);
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => {
    clearTimeout(timer);
    try {
      const payloads = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const payload = [...payloads].reverse().find(item => Array.isArray(item.frames) && item.frames.length);
      const errorPayload = [...payloads].reverse().find(item => item?.error);
      if (code !== 0 || !payload || !fs.existsSync(payload.frames[0])) throw new Error(stderr.trim() || errorPayload?.error || 'FFmpeg 未能生成视频封面');
      resolve(payload.frames[0]);
    } catch (error) { reject(error); }
  });
});

// Generate only the tiers requested by the scheduler. Windows' provider and
// Python decoding both run outside Electron's main event loop.
const generateThumbnailSet = async (sourcePath, stat, kind, cacheConfig, sizes) => {
  const cacheDir = getMediaCacheDir(cacheConfig);
  const ordered = [...sizes].sort((left, right) => right.pixels - left.pixels);
  const targets = new Map(ordered.map(size => [size.label, mediaThumbnailCacheFile(sourcePath, stat, cacheDir, size.pixels, THUMBNAIL_VERSION)]));
  let missing = ordered.filter(size => !fs.existsSync(targets.get(size.label)));
  if (!missing.length) return ordered.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: targets.get(size.label) }));

  const largest = missing[0];
  const largestTarget = targets.get(largest.label);
  let generatedByShell = await copyWindowsShellThumbnail(sourcePath, largestTarget, largest.pixels, true);
  if (!generatedByShell) generatedByShell = await copyWindowsShellThumbnail(sourcePath, largestTarget, largest.pixels, false);
  if (generatedByShell) {
    missing = missing.slice(1);
    if (missing.length) {
      await generateImageThumbnailFiles(largestTarget, 'image', missing.map(size => ({ sizeLabel: size.label, pixels: size.pixels, path: targets.get(size.label) })));
    }
  } else if (kind === 'video') {
    const coverPath = await generateVideoCoverSource(sourcePath, stat, cacheDir, largest.pixels);
    await generateImageThumbnailFiles(coverPath, 'image', missing.map(size => ({ sizeLabel: size.label, pixels: size.pixels, path: targets.get(size.label) })));
  } else {
    try {
      await generateImageThumbnailFiles(sourcePath, kind === 'raw' ? 'raw' : 'image', missing.map(size => ({ sizeLabel: size.label, pixels: size.pixels, path: targets.get(size.label) })));
    } catch (decodeError) {
      // Retain Electron's decoder only as a compatibility fallback for
      // formats supplied by an installed OS codec but unsupported by Pillow.
      if (kind === 'raw') throw decodeError;
      for (const size of missing) {
        const target = targets.get(size.label);
        let thumbnail = nativeImage.createEmpty();
        try { thumbnail = await nativeImage.createThumbnailFromPath(sourcePath, { width: size.pixels, height: size.pixels }); }
        catch { /* reported below if every requested tier is still absent */ }
        if (!thumbnail.isEmpty()) writeThumbnailJpeg(target, thumbnail, size.pixels >= 960 ? 84 : 80);
      }
    }
  }
  return ordered.filter(size => fs.existsSync(targets.get(size.label))).map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: targets.get(size.label) }));
};

thumbnailPipeline = new ThumbnailPipeline({
  getRunConfig,
  databasePath: path.join(getConfigDir(), 'thumbnail-index.sqlite3'),
  getCacheDir: getMediaCacheDir,
  cacheFilePath: mediaThumbnailCacheFile,
  generateThumbnailSet,
  toPreviewUrl: toMediaUrl,
  trimCache: trimMediaCache,
  notify: update => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('thumbnail-state-changed', update);
  },
  log: writeLog,
  concurrency: Math.max(2, Math.min(4, Math.floor((os.availableParallelism?.() || os.cpus().length || 4) / 4))),
  maxBackgroundTasks: 1000,
});

ipcMain.handle('workspace-browse-files', async (_event, workspacePath, status, projectName, relativePath = '', cacheConfig = {}) => {
  try {
    const projectPath = getProjectPath(workspacePath, status, projectName);
    const root = path.resolve(projectPath);
    const currentPath = path.resolve(root, relativePath || '.');
    if (currentPath !== root && !currentPath.startsWith(root + path.sep)) throw new Error('无效的文件夹路径');
    const currentStat = await fs.promises.stat(currentPath);
    if (!currentStat.isDirectory()) throw new Error('文件夹不存在');
    activeMediaCacheConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
    const directoryEntries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    const entries = directoryEntries
      .filter(entry => !entry.name.startsWith('.') && !HIDDEN_SYSTEM_ENTRY_NAMES.has(entry.name.toLowerCase()))
      .map(entry => {
        const entryPath = path.join(currentPath, entry.name);
        const extension = entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase();
        const kind = entry.isDirectory() ? 'folder' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
        return { name: entry.name, path: entryPath, relativePath: path.relative(root, entryPath), kind, extension, size: -1, createdAt: 0, updatedAt: 0 };
      })
      .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    const directoryIndex = thumbnailPipeline.indexDirectory(root, currentPath, entries, activeMediaCacheConfig);
    if (!relativePath) {
      void directoryIndex.then(indexed => indexed && thumbnailPipeline.scanProject(root, activeMediaCacheConfig));
    }
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
        return { relativePath: path.relative(root, filePath), size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs, updatedAt: stat.mtimeMs };
      } catch { return null; }
    }))).filter(Boolean);
    return { success: true, details };
  } catch (error) { return { success: false, details: [], error: error.message || String(error) }; }
});

const findImportedVideoPreview = sourcePath => {
  const sourceDir = path.dirname(sourcePath);
  const sourceFolder = path.basename(sourceDir).toLocaleLowerCase();
  if (sourceFolder === 'mov_预览'.toLocaleLowerCase()) return sourcePath;
  if (sourceFolder !== 'mov') return null;

  const previewDir = path.join(path.dirname(sourceDir), 'mov_预览');
  if (!fs.existsSync(previewDir)) return null;
  const sourceStem = path.parse(sourcePath).name;
  const exactPath = path.join(previewDir, `${sourceStem}.mp4`);
  try {
    if (fs.statSync(exactPath).isFile()) return exactPath;
  } catch {}

  // Re-running import preview generation keeps the previous file and adds a
  // timestamp. Prefer the newest matching result without scanning elsewhere.
  const escapedStem = sourceStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const timestampedName = new RegExp(`^${escapedStem}_\\d+\\.mp4$`, 'i');
  try {
    return fs.readdirSync(previewDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && timestampedName.test(entry.name))
      .map(entry => {
        const previewPath = path.join(previewDir, entry.name);
        return { path: previewPath, mtimeMs: fs.statSync(previewPath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path || null;
  } catch {
    return null;
  }
};

ipcMain.handle('media-thumbnail', async (_event, filePath, kind, cacheConfig = {}, requestedSize = 640, priority = PRIORITY.visible, queueOrder = Number.MAX_SAFE_INTEGER) => {
  try {
    const sourcePath = path.resolve(filePath);
    const extension = path.extname(sourcePath).toLowerCase();
    const supported = kind === 'raw' ? RAW_EXTENSIONS.has(extension) : kind === 'video' ? VIDEO_EXTENSIONS.has(extension) : IMAGE_EXTENSIONS.has(extension);
    if (!supported || !fs.existsSync(sourcePath)) throw new Error('文件不存在或格式不受支持');
    activeMediaCacheConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
    const result = await thumbnailPipeline.request({ filePath: sourcePath, kind, cacheConfig: activeMediaCacheConfig, requestedSize, priority, queueOrder });
    if (kind !== 'video') return result;
    const isImportedOriginal = path.basename(path.dirname(sourcePath)).toLocaleLowerCase() === 'mov';
    const importedPreview = findImportedVideoPreview(sourcePath);
    return {
      ...result,
      mediaUrl: importedPreview ? toMediaUrl(importedPreview) : isImportedOriginal ? undefined : toMediaUrl(sourcePath),
      usingImportedPreview: Boolean(importedPreview),
      importedVideoWithoutPreview: isImportedOriginal && !importedPreview
    };
  } catch (error) { return { success: false, error: error.message || String(error) }; }
});

ipcMain.handle('media-thumbnail-cancel', async (_event, filePath, requestedSize = 640) => {
  try { return { success: true, cancelled: thumbnailPipeline.cancel(path.resolve(filePath), requestedSize) }; }
  catch (error) { return { success: false, cancelled: false, error: error.message || String(error) }; }
});

ipcMain.handle('media-original', async (_event, filePath, kind, cacheConfig = {}) => {
  try {
    thumbnailPipeline?.noteForegroundActivity();
    const sourcePath = path.resolve(filePath);
    const extension = path.extname(sourcePath).toLowerCase();
    const supported = kind === 'raw' ? RAW_EXTENSIONS.has(extension) : kind === 'image' ? IMAGE_EXTENSIONS.has(extension) : false;
    if (!supported || !fs.existsSync(sourcePath)) throw new Error('图片不存在或格式不受支持');
    if (kind === 'image') return { success: true, mediaUrl: toMediaUrl(sourcePath), original: true };

    // Chromium cannot decode camera RAW containers directly. Use the largest
    // camera-embedded JPEG, which is the closest displayable source preview.
    const stat = fs.statSync(sourcePath);
    const previewPath = await rawPreviewPath(sourcePath, stat, cacheConfig);
    if (!previewPath) throw new Error('RAW 文件中没有可显示的内嵌原图');
    let orientationTimer;
    const orientation = await Promise.race([
      rawOrientationCorrection(sourcePath, previewPath, stat),
      new Promise(resolve => {
        orientationTimer = setTimeout(() => resolve({ matrix: [1, 0, 0, 1], swapsAxes: false, rawOrientation: 1, embeddedOrientation: 1 }), 3000);
      })
    ]);
    clearTimeout(orientationTimer);
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
    const isImportedOriginal = path.basename(path.dirname(sourcePath)).toLocaleLowerCase() === 'mov';
    const importedPreview = findImportedVideoPreview(sourcePath);
    if (isImportedOriginal && !importedPreview) return { success: true, cached: false, complete: false, duration: 0, frameUrls: [] };
    const previewSource = importedPreview || sourcePath;
    const stat = fs.statSync(previewSource);
    const size = Math.max(320, Math.min(1600, Math.round(Number(requestedSize) || 640)));
    const cacheDir = getMediaCacheDir(cacheConfig);
    const cacheKey = crypto.createHash('sha256').update(`video-preview|v2|${size}|${previewSource}|${stat.size}|${stat.mtimeMs}`).digest('hex');
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
        const toolArgs = ['--source', previewSource, '--output_dir', cacheDir, '--cache_key', cacheKey, '--size', String(size)];
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
            trimMediaCache(cacheDir, cacheConfig?.maxSizeGB, [manifestPath, ...finalManifest.frames]);
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
    const preview = await rawPreviewPath(sourcePath, fs.statSync(sourcePath), cacheConfig);
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

ipcMain.on('workspace-start-file-drag', async (event, workspacePath, status, projectName, relativePaths = []) => {
  let validatedRelativePaths = [];
  try {
    if (!Array.isArray(relativePaths) || !relativePaths.length || relativePaths.length > 500) throw new Error('没有可拖动的文件');
    const root = path.resolve(getProjectPath(workspacePath, status, projectName));
    const sources = Array.from(new Set(relativePaths.map(relativePath => {
      if (typeof relativePath !== 'string' || !relativePath) throw new Error('无效的文件路径');
      const source = path.resolve(root, relativePath);
      if (source === root || !source.startsWith(root + path.sep)) throw new Error('文件不在当前项目中');
      if (!fs.existsSync(source)) throw new Error(`文件不存在：${path.basename(source)}`);
      return source;
    })));
    validatedRelativePaths = sources.map(source => path.relative(root, source));

    let icon = nativeImage.createEmpty();
    try {
      icon = await app.getFileIcon(sources[0], { size: 'normal' });
    } catch (error) {
      writeLog('warn', 'Unable to create native file drag icon', error);
    }
    if (event.sender.isDestroyed()) return;
    event.sender.startDrag({ file: sources[0], files: sources, icon });
    writeLog('info', 'Native project file drag started', { count: sources.length });
  } catch (error) {
    writeLog('error', 'Unable to start native project file drag', error);
    if (!event.sender.isDestroyed()) event.sender.send('app-error', error.message || String(error));
  } finally {
    if (!event.sender.isDestroyed()) {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const contentBounds = ownerWindow?.getContentBounds();
      const cursor = screen.getCursorScreenPoint();
      const clientX = contentBounds ? cursor.x - contentBounds.x : -1;
      const clientY = contentBounds ? cursor.y - contentBounds.y : -1;
      const insideWindow = Boolean(contentBounds && clientX >= 0 && clientY >= 0 && clientX < contentBounds.width && clientY < contentBounds.height);
      event.sender.send('workspace-file-drag-ended', { paths: validatedRelativePaths, clientX, clientY, insideWindow });
    }
  }
});

ipcMain.handle('workspace-file-clipboard-status', async () => {
  const internalSources = projectFileClipboard?.sources?.filter(source => fs.existsSync(source)) || [];
  if (internalSources.length) return { success: true, hasFiles: true };
  try {
    const systemClipboard = await readSystemFileClipboard();
    const systemSources = systemClipboard?.sources?.filter(source => fs.existsSync(path.resolve(source))) || [];
    return { success: true, hasFiles: systemSources.length > 0 };
  } catch {
    return { success: true, hasFiles: Boolean(projectFileClipboard?.sources?.some(source => fs.existsSync(source))) };
  }
});

ipcMain.handle('workspace-file-operation', async (event, workspacePath, status, projectName, operation, relativePaths = [], targetRelativePath = '', nextName = '', options = {}) => {
  try {
    const root = path.resolve(getProjectPath(workspacePath, status, projectName));
    const resolveInsideProject = relativePath => {
      const target = path.resolve(root, relativePath || '.');
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error('无效的文件路径');
      return target;
    };
    if (operation === 'import') {
      if (!Array.isArray(relativePaths) || !relativePaths.length || relativePaths.length > 500) throw new Error('没有可导入的文件');
      const destinationDir = resolveInsideProject(targetRelativePath);
      if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('目标文件夹不存在');
      const sources = Array.from(new Set(relativePaths.map(source => {
        if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('无效的外部文件路径');
        const resolvedSource = path.resolve(source);
        if (!fs.existsSync(resolvedSource)) throw new Error(`文件不存在：${path.basename(resolvedSource)}`);
        if (resolvedSource === destinationDir || destinationDir.startsWith(resolvedSource + path.sep)) throw new Error('不能将文件夹复制到自身或其子文件夹中');
        return resolvedSource;
      })));
      const reservedDestinations = new Set();
      const importPlan = sources.map(source => {
        const stat = fs.statSync(source);
        let destination = path.join(destinationDir, path.basename(source));
        const parsed = path.parse(destination);
        let index = 1;
        while (fs.existsSync(destination) || reservedDestinations.has(destination.toLowerCase())) {
          destination = stat.isDirectory()
            ? path.join(destinationDir, `${path.basename(source)} (${index++})`)
            : path.join(destinationDir, `${parsed.name} (${index++})${parsed.ext}`);
        }
        reservedDestinations.add(destination.toLowerCase());
        return { source, destination };
      });
      const createdTargets = [];
      try {
        for (const entry of importPlan) {
          createdTargets.push(entry.destination);
          await fs.promises.cp(entry.source, entry.destination, { recursive: true, errorOnExist: true, preserveTimestamps: true });
        }
      } catch (error) {
        await removeCreatedPasteTargets(createdTargets);
        throw error;
      }
      writeLog('info', 'External files imported by drag and drop', { projectName, targetRelativePath, count: importPlan.length });
      return { success: true, count: importPlan.length };
    }
    const sources = relativePaths.map(resolveInsideProject);
    if (operation === 'move') {
      if (!sources.length) throw new Error('没有可移动的文件');
      const destinationDir = resolveInsideProject(targetRelativePath);
      if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('目标文件夹不存在');
      const reservedDestinations = new Set();
      const movePlan = sources.map(source => {
        if (!fs.existsSync(source)) throw new Error(`文件不存在：${path.basename(source)}`);
        const stat = fs.statSync(source);
        if (source === destinationDir || destinationDir.startsWith(source + path.sep)) throw new Error('不能将文件夹移动到自身或其子文件夹中');
        let destination = path.join(destinationDir, path.basename(source));
        const parsed = path.parse(destination);
        let index = 1;
        while (fs.existsSync(destination) || reservedDestinations.has(destination.toLowerCase())) {
          destination = stat.isDirectory()
            ? path.join(destinationDir, `${path.basename(source)} (${index++})`)
            : path.join(destinationDir, `${parsed.name} (${index++})${parsed.ext}`);
        }
        reservedDestinations.add(destination.toLowerCase());
        return { source, destination };
      });
      for (const entry of movePlan) await fs.promises.rename(entry.source, entry.destination);
      writeLog('info', 'Project files moved by internal drag', { projectName, targetRelativePath, count: movePlan.length });
      return { success: true, count: movePlan.length };
    }
    if (operation === 'copy' || operation === 'cut') {
      if (!sources.length) throw new Error('未选择文件');
      projectFileClipboard = { operation, sources };
      void writeSystemFileClipboard(sources, operation).catch(error => writeLog('warn', 'Unable to sync project files to the system clipboard', error));
      return { success: true, count: sources.length };
    }
    if (operation === 'paste') {
      if (activeProjectFileOperations.size) throw new Error('已有文件粘贴任务正在进行');
      const destinationDir = resolveInsideProject(targetRelativePath);
      if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('目标文件夹不存在');
      let clipboardSnapshot = projectFileClipboard?.sources?.length ? { operation: projectFileClipboard.operation, sources: [...projectFileClipboard.sources] } : null;
      if (!clipboardSnapshot) {
        try {
          const systemClipboard = await readSystemFileClipboard();
          if (systemClipboard?.sources?.length) clipboardSnapshot = { operation: systemClipboard.operation, sources: systemClipboard.sources.map(source => path.resolve(source)) };
        } catch (error) {
          writeLog('warn', 'Unable to read project files from the system clipboard', error);
        }
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
      const explicitNames = Array.isArray(options.renameNames) && options.renameNames.length === sources.length ? options.renameNames.map(name => String(name).trim()) : null;
      const destinations = sources.map((source, index) => {
        const extension = path.extname(source);
        const fileName = explicitNames ? explicitNames[index] : sources.length === 1 ? baseName : `${baseName}_${String(index + 1).padStart(2, '0')}${extension}`;
        if (!fileName || path.basename(fileName) !== fileName || /[<>:"/\\|?*\x00-\x1f]/.test(fileName) || /[. ]$/.test(fileName)) throw new Error(`无效的文件名：${fileName || '空文件名'}`);
        return path.join(path.dirname(source), fileName);
      });
      const normalizedDestinations = destinations.map(destination => path.resolve(destination).toLocaleLowerCase());
      if (new Set(normalizedDestinations).size !== normalizedDestinations.length) throw new Error('生成的新文件名存在重复');
      const normalizedSources = new Set(sources.map(source => path.resolve(source).toLocaleLowerCase()));
      for (const destination of destinations) {
        if (path.resolve(destination) === root || !path.resolve(destination).startsWith(root + path.sep)) throw new Error('无效的文件名');
        if (fs.existsSync(destination) && !normalizedSources.has(path.resolve(destination).toLocaleLowerCase())) throw new Error(`已有同名文件：${path.basename(destination)}`);
      }
      const moves = sources.map((source, index) => ({ source, destination: destinations[index] })).filter(move => path.resolve(move.source) !== path.resolve(move.destination));
      const staged = [];
      try {
        for (const move of moves) {
          const temporary = path.join(path.dirname(move.source), `.photoflow-rename-${crypto.randomUUID()}${path.extname(move.source)}`);
          fs.renameSync(move.source, temporary);
          staged.push({ ...move, temporary, completed: false });
        }
        for (const move of staged) {
          fs.renameSync(move.temporary, move.destination);
          move.completed = true;
        }
      } catch (error) {
        for (const move of [...staged].reverse()) {
          try {
            if (move.completed && fs.existsSync(move.destination) && !fs.existsSync(move.source)) fs.renameSync(move.destination, move.source);
            else if (!move.completed && fs.existsSync(move.temporary) && !fs.existsSync(move.source)) fs.renameSync(move.temporary, move.source);
          } catch { /* best-effort rollback; original error is reported below */ }
        }
        throw error;
      }
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

ipcMain.handle('choose-workspace-directory', async (_event, currentPath = '') => {
  const defaultPath = currentPath && fs.existsSync(currentPath) && fs.statSync(currentPath).isDirectory() ? currentPath : undefined;
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作文件夹',
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  });
  return choice.canceled ? { cancelled: true } : { path: choice.filePaths[0] };
});

ipcMain.handle('media-cache-info', async (_event, cacheConfig = {}) => {
  try {
    const normalizedConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
    const cacheDir = getMediaCacheDir(normalizedConfig);
    const state = await refreshMediaCacheIndex(cacheDir);
    trimMediaCache(cacheDir, normalizedConfig.maxSizeGB);
    return { success: true, path: cacheDir, sizeBytes: state.totalBytes, fileCount: state.files.size };
  }
  catch (error) { return { success: false, path: '', sizeBytes: 0, fileCount: 0, error: error.message || String(error) }; }
});

ipcMain.handle('media-cache-clear', async (_event, cacheConfig = {}, olderThanDays) => {
  try {
    const cacheDir = getMediaCacheDir(cacheConfig);
    const days = Number(olderThanDays);
    const cutoff = Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
    const deletedPaths = [];
    const entries = (await fs.promises.readdir(cacheDir, { withFileTypes: true })).filter(entry => entry.isFile());
    for (let offset = 0; offset < entries.length; offset += 64) {
      await Promise.all(entries.slice(offset, offset + 64).map(async entry => {
        const filePath = path.join(cacheDir, entry.name);
        try {
          if (cutoff !== null && (await fs.promises.stat(filePath)).mtimeMs >= cutoff) return;
          await fs.promises.unlink(filePath);
          deletedPaths.push(filePath);
        } catch { /* cache files can disappear while cleanup is running */ }
      }));
    }
    void thumbnailPipeline.invalidateDeleted(deletedPaths, cutoff).catch(error => writeLog('warn', 'Unable to invalidate deleted thumbnail metadata', { error: error.message || String(error) }));
    mediaCacheIndexes.delete(path.resolve(cacheDir));
    return { success: true, deletedCount: deletedPaths.length };
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

ipcMain.handle('photoshop-status', async () => {
  const executable = await findLatestPhotoshop();
  return { available: Boolean(executable) };
});

ipcMain.handle('workspace-open-entry-photoshop', async (_event, workspacePath, status, projectName, relativePath) => {
  try {
    const executable = await findLatestPhotoshop();
    if (!executable) throw new Error('未检测到 Photoshop');
    const target = resolveProjectEntry(workspacePath, status, projectName, relativePath);
    if (!fs.statSync(target).isFile()) throw new Error('只能用 Photoshop 打开文件');
    return await new Promise(resolve => {
      const child = spawn(executable, [target], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', error => resolve({ success: false, error: error.message || String(error) }));
      child.once('spawn', () => {
        child.unref();
        resolve({ success: true });
      });
    });
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
  workspaceDatabase.stop();
  thumbnailImageWorkerPool?.stop();
  originalImageWorkerPool?.stop();
  thumbnailPipeline?.stop();
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
