const { app, BrowserWindow, ipcMain, Menu, shell, dialog, protocol, net, nativeImage, clipboard, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { pathToFileURL } = require('url');
const { exiftool } = require('exiftool-vendored');
const { ThumbnailPipeline, THUMBNAIL_VERSION, PRIORITY, isThumbnailSizeSufficient } = require('./thumbnail-pipeline.cjs');
const { createComponentRegistry } = require('./component-registry.cjs');
const { registerBrollImportIpc } = require('./modules/broll-import.cjs');
const { registerSystemIpc } = require('./modules/system-ipc.cjs');
const { registerWorkspaceIpc } = require('./modules/workspace-ipc.cjs');
const { registerFileOperationsIpc } = require('./modules/files-ipc.cjs');
const { registerMediaIpc } = require('./modules/media-ipc.cjs');
const { registerVersionIpc } = require('./modules/versions-ipc.cjs');
const { createRecycleBinService } = require('./services/recycle-bin-service.cjs');
const { createMediaAccessService } = require('./services/media-access-service.cjs');
const { PythonDatabaseClient } = require('./repositories/database-client.cjs');
const { createWorkspaceRepository } = require('./repositories/workspace-repository.cjs');
const { createMediaRepository } = require('./repositories/media-repository.cjs');
const { createEventBus } = require('./services/event-bus.cjs');
const { createBackgroundTaskService } = require('./services/background-task-service.cjs');
const { createPluginService } = require('./services/plugin-service.cjs');
const { createWorkspaceService } = require('./services/workspace-service.cjs');
const { createFileSystemService } = require('./services/file-system-service.cjs');
const { createThumbnailService } = require('./services/thumbnail-service.cjs');
const { createMediaService } = require('./services/media-service.cjs');
const { createVersionService } = require('./services/version-service.cjs');
const { registerBackgroundTasksIpc } = require('./modules/background-tasks-ipc.cjs');

// Keep user-facing OS labels localized while runtime data stays in a stable,
// Latin-only application directory name.
app.setPath('userData', path.join(app.getPath('appData'), 'Photoflow'));
app.setName('照片流');

const projectRoot = path.join(__dirname, '..');
const componentRegistry = createComponentRegistry({
  resourcesPath: process.resourcesPath,
  executablePath: process.execPath,
  projectRoot,
  isPackaged: app.isPackaged,
});

protocol.registerSchemesAsPrivileged([{ scheme: 'photoflow-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let mediaAccessService;
const toMediaUrl = (filePath, fresh = false) => `photoflow-media://file/${mediaAccessService.grantPath(filePath)}${fresh ? `?request=${crypto.randomUUID()}` : ''}`;

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
      for (const entry of await fs.promises.readdir(adobeRoot, { withFileTypes: true })) {
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
let workspaceReconciliationTimer = null;
let workspaceReconciliationRunning = false;
const fileOperationState = { projectFileClipboard: null };
const activeProjectFileOperations = new Map();
const mediaMetadataCache = new Map();
const rawOrientationCache = new Map();
const approvedMediaCacheDirectories = new Set([path.resolve(path.join(app.getPath('userData'), 'media-cache'))]);
const renameHistory = [];
const MAX_UNDO_HISTORY = 50;
const discardUndoOperation = operation => {
  if (operation?.kind !== 'trash' && operation?.kind !== 'import-with-sources') return;
  for (const item of operation.items || []) {
    if (item.backupRoot) void fs.promises.rm(item.backupRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};
const pushUndoOperation = async operation => {
  renameHistory.push(await addUndoIdentities(operation));
  // Keep undo data bounded. Entries that fall off the stack intentionally
  // become permanent, matching the behaviour of standard file managers.
  if (renameHistory.length > MAX_UNDO_HISTORY) discardUndoOperation(renameHistory.shift());
};
const workspaceCatalogs = new Map();
let shellThumbnailProcess = null;
let shellThumbnailOutput = '';
let shellThumbnailRequestId = 0;
let shellThumbnailWorkChain = Promise.resolve();
const shellThumbnailRequests = new Map();
let shellThumbnailUnavailableLogged = false;
let thumbnailPipeline = null;
let thumbnailService = null;
let mediaService = null;
let thumbnailImageWorkerPool = null;
let originalImageWorkerPool = null;
const mediaRuntimeState = {
  activeMediaCacheConfig: { maxSizeGB: 50, directory: '' },
  videoPreviewWorkChain: Promise.resolve(),
};
const normalizeMediaCacheSizeGB = (value, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};
const workspaceWatchChanges = new Set();
const mediaTrackingTimers = new Map();
const trackedVersionThumbnailCopies = new Map();
const nativeConsoleLog = console.log.bind(console);
const nativeConsoleError = console.error.bind(console);

const recycleBinService = createRecycleBinService({ app, shell, projectRoot });
const fileSystemService = createFileSystemService({ recycleBinService });
const {
  assertExistingInside,
  assertInside,
  assertRegularFile,
  CANCELLED_CODE,
  collectCopyPlan,
  copyFileAtomic,
  copyPlannedFiles,
  moveFileAtomic,
  removeCreatedPasteTargets,
  throwIfCancelled,
  uniqueDestination,
  capturePathIdentity,
  addUndoIdentities,
  assertUndoIdentity,
  samePathIdentity,
} = fileSystemService;
const eventBus = createEventBus();
const backgroundTasks = createBackgroundTaskService({ eventBus });
mediaAccessService = createMediaAccessService({
  getWorkspaceRoots: () => [...workspaceCatalogs.keys()],
  getAdditionalRoots: () => [
    mediaRuntimeState.activeMediaCacheConfig.directory && approvedMediaCacheDirectories.has(path.resolve(mediaRuntimeState.activeMediaCacheConfig.directory)) ? mediaRuntimeState.activeMediaCacheConfig.directory : '',
    path.join(app.getPath('userData'), 'media-cache'),
  ],
});
const pathExists = async candidate => fs.promises.access(candidate).then(() => true, () => false);

// Persist operational logs outside of the installation directory so they are
// available after an app restart or a packaged-app update.
const getLogDir = () => {
  const logDir = path.join(getConfigDir(), 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  return logDir;
};

const LOG_RETENTION_DAYS = 7;
const cleanupExpiredLogs = async () => {
  const expiresBefore = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    for (const fileName of await fs.promises.readdir(getLogDir())) {
      // Only remove files created by this logger; never touch user files.
      if (!/^photoflow-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) continue;

      const filePath = path.join(getLogDir(), fileName);
      if ((await fs.promises.stat(filePath)).mtimeMs < expiresBefore) {
        await fs.promises.unlink(filePath);
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
      let accepted = fields[1] === '1' && fs.existsSync(request.targetPath);
      if (accepted) {
        const thumbnail = nativeImage.createFromPath(request.targetPath);
        const size = thumbnail.isEmpty() ? { width: 0, height: 0 } : thumbnail.getSize();
        accepted = isThumbnailSizeSufficient(size.width, size.height, request.requestedSize);
        if (!accepted) {
          try { fs.unlinkSync(request.targetPath); } catch { /* the decoder fallback will recreate it */ }
          writeLog('warn', 'Rejected undersized Windows Shell thumbnail', {
            requestedSize: request.requestedSize,
            actualWidth: size.width,
            actualHeight: size.height,
            sourcePath: request.sourcePath,
          });
        }
      }
      request.resolve(accepted);
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
  shellThumbnailRequests.set(requestId, { resolve, timer, targetPath, requestedSize, sourcePath });
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
const MERGED_PYTHON_TOOLS = new Set(['classify', 'png_to_jpg', 'catch', 'cut_video', 'rename', 'thumbnail_db', 'video_preview']);

const getDevelopmentPython = () => {
  const isWin = process.platform === 'win32';
  const venvPython = isWin
    ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(projectRoot, '.venv', 'bin', 'python');
  return fs.existsSync(venvPython) ? venvPython : 'python';
};
let pluginService;

const getRunConfig = (scriptName, args) => {
  // 移除 .py 后缀 (兼容前端传入 'classify.py' 或 'classify')
  const baseName = scriptName.replace('.py', '');

  const isWin = process.platform === 'win32';

  if (baseName === 'research') return pluginService.resolveRunConfig('research-tools', args);

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
    // 脚本路径: python/classify.py
    const scriptPath = path.join(projectRoot, 'python', `${baseName}.py`);

    return {
      command: getDevelopmentPython(),
      args: ['-u', scriptPath, ...args] // -u 强制无缓冲输出
    };
  }
};

const runJsonCommand = (run, label, timeoutMs = 20 * 60 * 1000) => new Promise((resolve, reject) => {
  const child = spawn(run.command, run.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let finished = false;
  const settle = callback => value => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    callback(value);
  };
  const succeed = settle(resolve);
  const fail = settle(reject);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-2 * 1024 * 1024); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  child.on('error', error => fail(error));
  child.on('close', code => {
    if (code !== 0) return fail(new Error(stderr.trim() || `${label} 处理失败（代码 ${code}）`));
    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { return succeed(JSON.parse(lines[index])); }
      catch { /* keep looking for the last JSON result */ }
    }
    fail(new Error(stderr.trim() || `${label} 未返回有效结果`));
  });
  const timer = setTimeout(() => {
    if (!child.killed) child.kill();
    fail(new Error(`${label} 处理超时`));
  }, timeoutMs);
});

pluginService = createPluginService({ app, projectRoot, registry: componentRegistry, getDevelopmentPython, runJsonCommand });

const runPythonJsonAction = (scriptName, args, timeoutMs = 20 * 60 * 1000) =>
  runJsonCommand(getRunConfig(scriptName, args), scriptName, timeoutMs);

const runPythonEventAction = (scriptName, args, timeoutMs = 20 * 60 * 1000) => new Promise((resolve, reject) => {
  const run = getRunConfig(scriptName, args);
  const child = spawn(run.command, run.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let finished = false;
  const settle = callback => value => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    callback(value);
  };
  const succeed = settle(resolve);
  const fail = settle(reject);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-16 * 1024 * 1024); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  child.on('error', fail);
  child.on('close', code => {
    if (code !== 0) return fail(new Error(stderr.trim() || `${scriptName} 处理失败（代码 ${code}）`));
    const events = stdout.split(/\r?\n/).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const errorEvent = events.find(event => event.type === 'error');
    if (errorEvent) return fail(new Error(errorEvent.message || `${scriptName} 处理失败`));
    succeed(events);
  });
  const timer = setTimeout(() => {
    if (!child.killed) child.kill();
    fail(new Error(`${scriptName} 处理超时`));
  }, timeoutMs);
});

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












// 运行 Python 脚本


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

const readSavedConfig = () => {
  try {
    const configPath = getConfigPath();
    return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  } catch (error) {
    writeLog('warn', 'Unable to read saved configuration', { error: error.message || String(error) });
    return {};
  }
};







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







// 获取系统盘符列表

const WORKSPACE_STATUSES = ['未分类', '策划中', '待拍摄', '后期中', '已归档'];

const getWorkspaceStorageKey = root => {
  const identity = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
};

const getWorkspaceDatabasePath = root => {
  const databaseDir = path.join(app.getPath('userData'), 'workspace-data');
  fs.mkdirSync(databaseDir, { recursive: true });
  const fileName = `${getWorkspaceStorageKey(root)}.sqlite3`;
  return path.join(databaseDir, fileName);
};

const getTrackedVersionThumbnailPath = (workspaceRoot, photoId, versionId) => {
  const safeSegment = (value, label) => {
    const segment = String(value || '');
    if (!/^[a-z0-9_-]+$/i.test(segment)) throw new Error(`Invalid ${label}`);
    return segment;
  };
  return path.join(
    app.getPath('userData'),
    'workspace-data',
    getWorkspaceStorageKey(workspaceRoot),
    'thumbnails',
    safeSegment(photoId, 'photo ID'),
    `${safeSegment(versionId, 'version ID')}.jpg`,
  );
};

const workspaceDatabase = new PythonDatabaseClient({ getRunConfig, getDatabasePath: getWorkspaceDatabasePath, writeLog });
const workspaceRepository = createWorkspaceRepository(workspaceDatabase);
// Media scans can hash files and must never block project navigation/status
// updates. A second worker shares the WAL database safely while keeping the
// catalog service responsive.
const mediaDatabase = new PythonDatabaseClient({
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  defaultTimeoutMs: 30 * 60 * 1000,
});
const mediaRepository = createMediaRepository(mediaDatabase);
const versionService = createVersionService({ repository: mediaRepository });
const workspaceService = createWorkspaceService({
  repository: workspaceRepository,
  catalogs: workspaceCatalogs,
  statuses: WORKSPACE_STATUSES,
  assertInside,
  assertExistingInside,
});
const resolveWorkspaceRoot = workspaceService.resolveRoot;
const ensureWorkspace = workspaceService.ensureRoot;
const refreshWorkspaceCatalog = workspaceService.refreshCatalog;
const mutateWorkspaceCatalog = workspaceService.mutateCatalog;
const getProjectPath = workspaceService.getProjectPath;
const cleanProjectName = workspaceService.cleanProjectName;

const stopWorkspaceWatcher = () => {
  if (workspaceWatchTimer) clearTimeout(workspaceWatchTimer);
  workspaceWatchTimer = null;
  if (workspaceWatcher) workspaceWatcher.close();
  workspaceWatcher = null;
  watchedWorkspacePath = '';
  workspaceWatchChanges.clear();
  if (workspaceReconciliationTimer) clearInterval(workspaceReconciliationTimer);
  workspaceReconciliationTimer = null;
  workspaceReconciliationRunning = false;
  for (const timer of mediaTrackingTimers.values()) clearTimeout(timer);
  mediaTrackingTimers.clear();
};

const reconcileWorkspaceState = async root => {
  if (workspaceReconciliationRunning || watchedWorkspacePath !== root) return;
  workspaceReconciliationRunning = true;
  try {
    await backgroundTasks.run({
      type: 'workspace-reconcile',
      title: '工作区文件与数据库对账',
      dedupeKey: `workspace-reconcile:${root}`,
      cancellable: false,
      metadata: { root },
    }, async task => {
      task.report(5, '正在读取项目目录');
      const catalog = await refreshWorkspaceCatalog(root);
      let completed = 0;
      for (const project of catalog.projects) {
        scheduleMediaTrackingScan(root, project.name);
        if (thumbnailService) {
          await thumbnailService.scanProject(path.join(root, project.relative_path), mediaRuntimeState.activeMediaCacheConfig);
        }
        completed += 1;
        task.report(10 + Math.round((completed / Math.max(1, catalog.projects.length)) * 85), `正在核对 ${project.name}`);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('workspace-projects-changed', { root, reconciled: true });
        mainWindow.webContents.send('workspace-files-changed', { root, fileName: '', reconciled: true });
      }
      writeLog('info', 'Periodic workspace reconciliation completed', { root, projects: catalog.projects.length });
      return catalog;
    });
  } catch (error) {
    writeLog('warn', 'Periodic workspace reconciliation deferred', { root, error: error.message || String(error) });
  } finally {
    workspaceReconciliationRunning = false;
  }
};

const startWorkspaceReconciliation = root => {
  if (workspaceReconciliationTimer) clearInterval(workspaceReconciliationTimer);
  workspaceReconciliationTimer = setInterval(() => { void reconcileWorkspaceState(root); }, 5 * 60 * 1000);
};

const scheduleMediaTrackingScan = (root, projectName) => {
  if (!projectName) return;
  const key = `${root}\0${projectName.toLocaleLowerCase()}`;
  const previous = mediaTrackingTimers.get(key);
  if (previous) clearTimeout(previous);
  mediaTrackingTimers.set(key, setTimeout(() => {
    mediaTrackingTimers.delete(key);
    void versionService.syncProject(root, projectName).then(result => {
      const row = workspaceCatalogs.get(root)?.byName.get(projectName.toLocaleLowerCase());
      if (!row) return;
      for (const candidate of (result.thumbnailCandidates || []).slice(0, 750)) {
        void ensureTrackedVersionThumbnail({
          workspaceRoot: root,
          photoId: candidate.photoId,
          versionId: candidate.versionId,
          filePath: candidate.filePath,
          priority: PRIORITY.project,
        });
      }
    }).catch(error => {
      writeLog('warn', 'Media version tracking scan deferred', { projectName, error: error.message || String(error) });
    });
  }, 1500));
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
        if (thumbnailService) {
          const changesByProject = new Map();
          for (const changedName of changedNames) {
            const segments = changedName.split(/[\\/]/).filter(Boolean);
            if (segments.length < 2) continue;
            const projectRoot = path.join(root, segments[0]);
            if (!changesByProject.has(projectRoot)) changesByProject.set(projectRoot, []);
            changesByProject.get(projectRoot).push(path.join(root, changedName));
          }
          for (const [projectRoot, changedPaths] of changesByProject) {
            void thumbnailService.syncChangedPaths(projectRoot, changedPaths, mediaRuntimeState.activeMediaCacheConfig).catch(error => {
              writeLog('warn', 'Unable to update thumbnail index from file watcher', { projectRoot, error: error.message || String(error) });
            });
          }
        }
        const catalog = workspaceCatalogs.get(root);
        const knownProjectPaths = new Set((catalog?.projects || []).map(project => project.relative_path.toLocaleLowerCase()));
        const changedSegments = changedNames.map(changedName => changedName.split(/[\\/]/).filter(Boolean));
        const changedTopLevelNames = new Set(changedSegments.map(segments => segments[0]).filter(Boolean));
        const catalogMayHaveChanged = !changedNames.length || changedSegments.some(segments => segments.length === 1 || !knownProjectPaths.has(String(segments[0] || '').toLocaleLowerCase()));
        const changedProjects = new Set();
        for (const changedName of changedNames) {
          const firstSegment = changedName.split(/[\\/]/).filter(Boolean)[0];
          const project = catalog?.projects.find(item => item.relative_path.toLocaleLowerCase() === String(firstSegment || '').toLocaleLowerCase());
          if (project) changedProjects.add(project.name);
        }
        if (!changedNames.length) for (const project of catalog?.projects || []) changedProjects.add(project.name);
        for (const projectName of changedProjects) scheduleMediaTrackingScan(root, projectName);
        if (mainWindow && !mainWindow.isDestroyed()) {
          for (const changedName of changedNames.length ? changedNames : ['']) {
            mainWindow.webContents.send('workspace-files-changed', { root, fileName: changedName });
          }
        }
        if (catalogMayHaveChanged) {
          void refreshWorkspaceCatalog(root).then(refreshedCatalog => {
            for (const topLevelName of changedTopLevelNames) {
              const project = refreshedCatalog.projects.find(item => item.relative_path.toLocaleLowerCase() === String(topLevelName).toLocaleLowerCase());
              if (project) scheduleMediaTrackingScan(root, project.name);
            }
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-projects-changed', { root });
          }).catch(error => {
            writeLog('warn', 'Unable to reconcile workspace catalog after file change', { root, error: error.message || String(error) });
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-projects-changed', { root });
          });
        }
      }, 200);
    });
    workspaceWatcher.on('error', error => {
      writeLog('warn', 'Workspace file watcher stopped', { root, error: error.message || String(error) });
      if (workspaceWatcher) workspaceWatcher.close();
      workspaceWatcher = null;
      watchedWorkspacePath = '';
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-projects-changed', { root });
    });
    watchedWorkspacePath = root;
    startWorkspaceReconciliation(root);
  } catch (error) {
    writeLog('warn', 'Unable to watch workspace for file changes', error);
    // A failed watcher makes periodic reconciliation more important, not less.
    watchedWorkspacePath = root;
    startWorkspaceReconciliation(root);
  }
};




















const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.crm']);
const RAW_EXTENSIONS = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']);
const HIDDEN_SYSTEM_ENTRY_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

const getMediaCacheDir = (config = {}) => {
  const requested = typeof config.directory === 'string' ? config.directory.trim() : '';
  const cacheDir = requested || path.join(getConfigDir(), 'media-cache');
  if (!approvedMediaCacheDirectories.has(path.resolve(cacheDir))) throw new Error('媒体缓存目录未经授权');
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
    const protectedCachePaths = new Set([...trackedVersionThumbnailCopies.values()].map(pending => {
      const resolved = path.resolve(pending.cachePath);
      return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
    }));
    for (const [filePath, record] of oldest) {
      if (refreshed.totalBytes <= refreshed.maxBytes) break;
      const cacheKey = process.platform === 'win32' ? path.resolve(filePath).toLocaleLowerCase() : path.resolve(filePath);
      if (protectedCachePaths.has(cacheKey)) continue;
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

const isCompleteJpegBuffer = buffer => buffer.length >= 128
  && buffer[0] === 0xff && buffer[1] === 0xd8
  && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;

const readCompleteJpegBuffer = async filePath => {
  let handle;
  try {
    // Keep the handle open until the complete payload is in memory. On Windows
    // this also prevents a concurrent cache cleanup from deleting the source.
    handle = await fs.promises.open(filePath, 'r');
    const buffer = await handle.readFile();
    return isCompleteJpegBuffer(buffer) ? buffer : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const writeVersionThumbnailAtomically = async (targetPath, buffer) => {
  if (isCompleteJpegFile(targetPath)) return;
  const temporaryPath = `${targetPath}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.promises.writeFile(temporaryPath, buffer, { flag: 'wx' });
    try {
      await fs.promises.rename(temporaryPath, targetPath);
    } catch (error) {
      // Another finalizer may have won the race. Keep its complete thumbnail;
      // replace only an incomplete leftover.
      if (isCompleteJpegFile(targetPath)) return;
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      await fs.promises.unlink(targetPath).catch(unlinkError => {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      });
      await fs.promises.rename(temporaryPath, targetPath);
    }
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const finalizeTrackedVersionThumbnail = async pending => {
  await fs.promises.mkdir(path.dirname(pending.targetPath), { recursive: true });
  if (!isCompleteJpegFile(pending.targetPath)) {
    const buffer = await readCompleteJpegBuffer(pending.cachePath);
    if (!buffer) return false;
    await writeVersionThumbnailAtomically(pending.targetPath, buffer);
  }
  await versionService.setThumbnail(pending.workspaceRoot, {
    versionId: pending.versionId,
    thumbnailPath: pending.targetPath,
  });
  return true;
};

const persistTrackedVersionThumbnail = async pending => {
  if (pending.finalizing) return;
  pending.finalizing = true;
  const sourceKey = mediaSourceCacheKey(pending.filePath);
  try {
    if (trackedVersionThumbnailCopies.get(sourceKey) !== pending) return;
    if (await finalizeTrackedVersionThumbnail(pending)) {
      if (trackedVersionThumbnailCopies.get(sourceKey) === pending) trackedVersionThumbnailCopies.delete(sourceKey);
      return;
    }
    if (pending.retryCount >= 1) {
      if (trackedVersionThumbnailCopies.get(sourceKey) === pending) trackedVersionThumbnailCopies.delete(sourceKey);
      writeLog('warn', 'Unable to finalize ID-based version thumbnail after retry', { versionId: pending.versionId, filePath: pending.filePath });
      return;
    }
    pending.retryCount += 1;
    const result = await thumbnailService.request({
      filePath: pending.filePath,
      kind: pending.kind,
      cacheConfig: pending.cacheConfig,
      requestedSize: 640,
      priority: pending.priority,
      requireDisk: true,
      forceRegenerate: true,
    });
    if (result.state === 'READY') {
      if (await finalizeTrackedVersionThumbnail(pending)) {
        if (trackedVersionThumbnailCopies.get(sourceKey) === pending) trackedVersionThumbnailCopies.delete(sourceKey);
      } else {
        if (trackedVersionThumbnailCopies.get(sourceKey) === pending) trackedVersionThumbnailCopies.delete(sourceKey);
        writeLog('warn', 'Unable to finalize ID-based version thumbnail after retry', { versionId: pending.versionId, filePath: pending.filePath });
      }
    } else if (result.state === 'FAILED' || result.state === 'MISSING') {
      if (trackedVersionThumbnailCopies.get(sourceKey) === pending) trackedVersionThumbnailCopies.delete(sourceKey);
    }
  } catch (error) {
    if (trackedVersionThumbnailCopies.get(sourceKey) === pending) trackedVersionThumbnailCopies.delete(sourceKey);
    writeLog('warn', 'Unable to finalize ID-based version thumbnail', { versionId: pending.versionId, filePath: pending.filePath, error: error.message || String(error) });
  } finally {
    pending.finalizing = false;
  }
};

const ensureTrackedVersionThumbnail = async ({ workspaceRoot, photoId, versionId, filePath, priority = PRIORITY.nearby }) => {
  try {
    if (!thumbnailService || !fs.existsSync(filePath)) return;
    const stat = await fs.promises.stat(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const kind = RAW_EXTENSIONS.has(extension) ? 'raw' : VIDEO_EXTENSIONS.has(extension) ? 'video' : IMAGE_EXTENSIONS.has(extension) ? 'image' : '';
    if (!kind) return;
    const cacheConfig = { ...mediaRuntimeState.activeMediaCacheConfig };
    const pending = {
      workspaceRoot,
      versionId,
      filePath,
      kind,
      cacheConfig,
      priority,
      retryCount: 0,
      finalizing: false,
      cachePath: mediaThumbnailCacheFile(filePath, stat, getMediaCacheDir(cacheConfig), 640, THUMBNAIL_VERSION),
      targetPath: getTrackedVersionThumbnailPath(workspaceRoot, photoId, versionId),
    };
    if (await finalizeTrackedVersionThumbnail(pending)) return;
    trackedVersionThumbnailCopies.set(mediaSourceCacheKey(filePath), pending);
    const result = await thumbnailService.request({ filePath, kind, cacheConfig, requestedSize: 640, priority, requireDisk: true });
    if (result.state === 'READY') await persistTrackedVersionThumbnail(pending);
    else if (result.state === 'FAILED' || result.state === 'MISSING') trackedVersionThumbnailCopies.delete(mediaSourceCacheKey(filePath));
  } catch (error) {
    trackedVersionThumbnailCopies.delete(mediaSourceCacheKey(filePath));
    writeLog('warn', 'Unable to persist ID-based version thumbnail', { versionId, filePath, error: error.message || String(error) });
  }
};

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

const writeThumbnailJpeg = async (target, image, quality) => {
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.promises.writeFile(temporary, image.toJPEG(quality));
    if (await pathExists(target)) await fs.promises.unlink(temporary);
    else await fs.promises.rename(temporary, target);
  } finally {
    if (await pathExists(temporary)) await fs.promises.unlink(temporary);
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
        if (!thumbnail.isEmpty()) await writeThumbnailJpeg(target, thumbnail, size.pixels >= 960 ? 84 : 80);
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
    const trackedThumbnail = trackedVersionThumbnailCopies.get(mediaSourceCacheKey(update.filePath));
    if (trackedThumbnail && update.state === 'READY') {
      void persistTrackedVersionThumbnail(trackedThumbnail);
    } else if (trackedThumbnail && (update.state === 'FAILED' || update.state === 'MISSING')) {
      trackedVersionThumbnailCopies.delete(mediaSourceCacheKey(update.filePath));
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('thumbnail-state-changed', update);
  },
  log: writeLog,
  concurrency: Math.max(2, Math.min(4, Math.floor((os.availableParallelism?.() || os.cpus().length || 4) / 4))),
  maxBackgroundTasks: 1000,
});
thumbnailService = createThumbnailService({ pipeline: thumbnailPipeline, backgroundTasks });
mediaService = createMediaService({ accessService: mediaAccessService, thumbnailService, toMediaUrl });







const findImportedVideoPreview = async sourcePath => {
  const sourceDir = path.dirname(sourcePath);
  const sourceFolder = path.basename(sourceDir).toLocaleLowerCase();
  if (sourceFolder === 'mov_预览'.toLocaleLowerCase()) return sourcePath;
  if (sourceFolder !== 'mov') return null;

  const previewDir = path.join(path.dirname(sourceDir), 'mov_预览');
  if (!await pathExists(previewDir)) return null;
  const sourceStem = path.parse(sourcePath).name;
  const exactPath = path.join(previewDir, `${sourceStem}.mp4`);
  try {
    if ((await fs.promises.stat(exactPath)).isFile()) return exactPath;
  } catch {}

  // Re-running import preview generation keeps the previous file and adds a
  // timestamp. Prefer the newest matching result without scanning elsewhere.
  const escapedStem = sourceStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const timestampedName = new RegExp(`^${escapedStem}_\\d+\\.mp4$`, 'i');
  try {
    const entries = await fs.promises.readdir(previewDir, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter(entry => entry.isFile() && timestampedName.test(entry.name))
      .map(async entry => {
        const previewPath = path.join(previewDir, entry.name);
        return { path: previewPath, mtimeMs: (await fs.promises.stat(previewPath)).mtimeMs };
      }));
    return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path || null;
  } catch {
    return null;
  }
};







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



const videoPreviewJobs = new Map();






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

















const resolveProjectEntry = (workspacePath, status, projectName, relativePath = '') => {
  const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
  const target = path.resolve(projectPath, relativePath || '.');
  assertInside(projectPath, target, '项目路径', true);
  if (!fs.existsSync(target)) throw new Error('文件或文件夹不存在');
  return assertExistingInside(projectPath, target, '项目路径', true);
};

const cleanVersionName = value => String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 80);
const supportedVersionFileKind = filePath => {
  const extension = path.extname(filePath).toLowerCase();
  if (RAW_EXTENSIONS.has(extension)) return 'raw';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return '';
};















const buildVersionBatchImportKey = async (folderA, folderB) => {
  const folderStat = await fs.promises.stat(folderA);
  const parentIdentity = folderStat.ino ? `${folderStat.dev}:${folderStat.ino}` : path.resolve(folderA).toLocaleLowerCase();
  const tokens = [`parent:${parentIdentity}`];
  const entries = await fs.promises.readdir(folderB, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(folderB, entry.name);
    if (!supportedVersionFileKind(filePath)) continue;
    const stat = await fs.promises.stat(filePath);
    const sampleSize = Math.min(64 * 1024, stat.size);
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const head = Buffer.alloc(sampleSize);
      if (sampleSize) await handle.read(head, 0, sampleSize, 0);
      const tail = Buffer.alloc(sampleSize);
      if (sampleSize && stat.size > sampleSize) await handle.read(tail, 0, sampleSize, stat.size - sampleSize);
      const content = crypto.createHash('sha256').update(head).update(tail).digest('hex').slice(0, 24);
      // File identity and sampled content make the key stable across the
      // optional source rename while still changing when a return folder is
      // edited or receives additional files.
      tokens.push(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${content}`);
    } finally {
      await handle.close();
    }
  }
  tokens.sort();
  return `folder-snapshot:${crypto.createHash('sha256').update(tokens.join('|')).digest('hex')}`;
};











































registerBrollImportIpc({
  ipcMain,
  dialog,
  shell,
  recycleBinService,
  getMainWindow: () => mainWindow,
  getProjectPath,
  getRunConfig,
  writeLog,
  pushUndoOperation,
  activeOperations: activeProjectFileOperations,
});
registerBackgroundTasksIpc({ ipcMain, eventBus, backgroundTasks, getMainWindow: () => mainWindow });
app.whenReady().then(async () => {
  protocol.handle('photoflow-media', async request => {
    try {
      const token = new URL(request.url).pathname.replace(/^\//, '');
      const filePath = mediaAccessService.resolveToken(token);
      if (!filePath || !(await fs.promises.stat(filePath).catch(() => null))?.isFile()) return new Response('Not found', { status: 404 });
      // Forward Range headers so video metadata and sampled hover frames do not
      // require reading the entire source file.
      return await net.fetch(pathToFileURL(filePath).toString(), { method: request.method, headers: request.headers });
    } catch (error) {
      writeLog('warn', 'Media protocol request failed', { url: request.url, error: error.message || String(error) });
      return new Response('Bad request', { status: 400 });
    }
  });
  const deletedLogFiles = await cleanupExpiredLogs();
  writeLog('info', 'Application started', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, deletedExpiredLogFiles: deletedLogFiles });
  createWindow();

  registerSystemIpc({ Array, Boolean, BrowserWindow, Date, Error, JSON, MERGED_PYTHON_TOOLS, Object, String, app, approvedMediaCacheDirectories, checkForUpdates, console, dialog, findLatestPhotoshop, fs, getConfigPath, getResourceBirthdaysPath, getRunConfig, getUserBirthdaysPath, ipcMain, mainWindow, path, pluginService, process, readSavedConfig, shell, spawn, undefined, writeLog });
  registerWorkspaceIpc({ Array, Boolean, Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES, IMAGE_EXTENSIONS, Object, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, WORKSPACE_STATUSES, app, assertExistingInside, assertInside, assertRegularFile, assertUndoIdentity, capturePathIdentity, cleanProjectName, clipboard, copyFileAtomic, crypto, dialog, ensureWorkspace, findLatestPhotoshop, fs, getProjectPath, ipcMain, mainWindow, mediaRuntimeState, mediaService, moveFileAtomic, mutateWorkspaceCatalog, normalizeMediaCacheSizeGB, path, pathExists, pushUndoOperation, recycleBinService, refreshWorkspaceCatalog, renameHistory, resolveProjectEntry, resolveWorkspaceRoot, samePathIdentity, scheduleMediaTrackingScan, shell, spawn, thumbnailService, undefined, uniqueDestination, versionService, watchWorkspace, workspaceCatalogs, workspaceRepository, writeLog });
  registerFileOperationsIpc({ Array, Boolean, BrowserWindow, CANCELLED_CODE, Date, Error, IMAGE_EXTENSIONS, Math, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, activeProjectFileOperations, app, assertExistingInside, assertInside, capturePathIdentity, clipboard, collectCopyPlan, copyFileAtomic, copyPlannedFiles, crypto, dialog, ensureWorkspace, fileOperationState, fs, getProjectPath, ipcMain, mainWindow, nativeImage, path, process, pushUndoOperation, readSystemFileClipboard, recycleBinService, removeCreatedPasteTargets, screen, throwIfCancelled, workspaceRepository, writeLog, writeSystemFileClipboard });
  registerMediaIpc({ Array, Boolean, Buffer, Date, Error, IMAGE_EXTENSIONS, JSON, Math, Number, Object, PRIORITY, Promise, RAW_EXTENSIONS, String, VIDEO_EXTENSIONS, approvedMediaCacheDirectories, backgroundTasks, clearInterval, clearTimeout, crypto, dialog, exiftool, findImportedVideoPreview, flattenMetadataValue, fs, getMediaCacheDir, getRunConfig, ipcMain, mainWindow, mediaCacheIndexes, mediaMetadataCache, mediaRuntimeState, mediaService, normalizeMediaCacheSizeGB, path, rawOrientationCorrection, rawPreviewPath, refreshMediaCacheIndex, setInterval, setTimeout, spawn, thumbnailService, trimMediaCache, undefined, videoPreviewJobs, writeLog });
  registerVersionIpc({ Array, Boolean, Error, IMAGE_EXTENSIONS, JSON, Math, Number, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, buildVersionBatchImportKey, cleanVersionName, crypto, dialog, ensureTrackedVersionThumbnail, ensureWorkspace, fs, getProjectPath, ipcMain, mainWindow, mediaService, path, pluginService, readSavedConfig, recycleBinService, refreshWorkspaceCatalog, resolveProjectEntry, runPythonEventAction, shell, supportedVersionFileKind, undefined, versionService, workspaceCatalogs, writeLog });

  setTimeout(checkForUpdates, 3000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopWorkspaceWatcher();
  stopShellThumbnailProcess();
  workspaceDatabase.stop();
  mediaDatabase.stop();
  thumbnailImageWorkerPool?.stop();
  originalImageWorkerPool?.stop();
  thumbnailService?.stop();
  backgroundTasks.stop();
  eventBus.clear();
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
