const { app, BrowserWindow, WebContentsView, ipcMain: electronIpcMain, Menu, shell, dialog, protocol, nativeImage, clipboard, screen, safeStorage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { exiftool, exiftoolPath } = require('exiftool-vendored');
const { ThumbnailPipeline, THUMBNAIL_VERSION, PRIORITY, isThumbnailSizeSufficient } = require('./thumbnail-pipeline.cjs');
const { createComponentRegistry } = require('./component-registry.cjs'); const { createComponentHostRegistry } = require('./component-host-contract.cjs');
const { ComponentViewManager } = require('./services/component-view-manager.cjs'); const { createComponentHostCapabilityRuntime } = require('./services/component-host-capability-runtime.cjs');
const { ToastViewManager } = require('./services/toast-view-manager.cjs');
const { ComponentServiceManager } = require('./services/component-service-manager.cjs'); const { createConfigMutationService, readConfigFileWithRecovery, registerConfigDrainBeforeQuit } = require('./services/config-mutation-service.cjs');
const { createWorkspaceStorageKeyService } = require('./services/workspace-storage-key-service.cjs');
const { createComponentRpcIpcProxy } = require('./component-rpc-contract.cjs');
const { registerComponentHostIpc } = require('./modules/component-host-ipc.cjs');
const { registerComponentIconProtocol } = require('./modules/component-icon-protocol.cjs');
const { PLUGIN_DEFINITIONS } = require('./plugins/plugin-catalog.cjs');
const { registerBrollImportIpc } = require('./modules/broll-import.cjs');
const { registerSystemIpc } = require('./modules/system-ipc.cjs');
const { registerWorkspaceIpc } = require('./modules/workspace-ipc.cjs');
const { registerFileOperationsIpc } = require('./modules/files-ipc.cjs');
const { registerMediaIpc } = require('./modules/media-ipc.cjs');
const { registerMediaRatingIpc } = require('./modules/media-rating-ipc.cjs');
const { registerVersionIpc } = require('./modules/versions-ipc.cjs');
const { registerSelectionIpc } = require('./modules/selection-ipc.cjs');
const { registerVideoPlaybackIpc } = require('./modules/video-playback-ipc.cjs');
const { registerBackupIpc } = require('./modules/backup-ipc.cjs');
const { registerArchiveIpc } = require('./modules/archive-ipc.cjs');
const { registerStorageUsageIpc } = require('./modules/storage-usage-ipc.cjs');
const { createRecycleBinService } = require('./services/recycle-bin-service.cjs');
const { createFileClipboardService } = require('./services/file-clipboard-service.cjs');
const { createFilePublicationService } = require('./services/file-publication-service.cjs');
const { createShellNewService } = require('./services/shell-new-service.cjs');
const { createMediaAccessService } = require('./services/media-access-service.cjs');
const { createMediaFileResponse } = require('./services/media-response-service.cjs');
const { configureProtectedProjectFolderRegistry } = require('./services/protected-project-folder.cjs');
const { PythonDatabaseClient } = require('./repositories/database-client.cjs');
const { WorkspaceSqliteCoordinator } = require('./services/workspace-sqlite-coordinator.cjs');
const { createWorkspaceRepository } = require('./domains/workspace/public.cjs');
const { createOperationsRepository } = require('./domains/file-operations/public.cjs');
const { createMediaRepository } = require('./domains/media/public.cjs');
const { createEventBus } = require('./services/event-bus.cjs');
const { createDomainCommandJournal } = require('./services/domain-command-journal.cjs');
const { createDomainHealthService } = require('./services/domain-health-service.cjs');
const { createBackgroundTaskService } = require('./services/background-task-service.cjs');
const { createProcessSupervisor } = require('./services/process-supervisor.cjs');
const { createBundledPythonRuntime } = require('./services/bundled-python-runtime.cjs');
const { createBackupService } = require('./services/backup-service.cjs');
const { createArchiveService } = require('./services/archive-service.cjs');
const { createCredentialService } = require('./services/credential-service.cjs');
const { createStorageUsageService } = require('./services/storage-usage-service.cjs');
const { loadOrCreateInstallationId, resolveMediaCacheNamespace } = require('./services/media-cache-namespace.cjs');
const { runElectronSmokeProbe } = require('./services/electron-smoke-probe.cjs');
const { createWorkspaceReconcileTask } = require('./services/workspace-reconcile-task.cjs');
const { cleanupRetiredCaptureTimeCache } = require('./services/retired-cache-service.cjs');
const { createPluginService } = require('./services/plugin-service.cjs');
const { createWorkspaceService } = require('./domains/workspace/public.cjs');
const { createFileSystemService } = require('./services/file-system-service.cjs');
const { createThumbnailService } = require('./services/thumbnail-service.cjs');
const { createMediaService } = require('./services/media-service.cjs');
const { parsePythonJsonMessages } = require('./services/python-json-protocol.cjs');
const { createMediaRatingService } = require('./services/media-rating-service.cjs');
const { createRawOrientationService } = require('./services/raw-orientation-service.cjs');
const { createImageThumbnailRuntime } = require('./services/image-thumbnail-runtime.cjs');
const { createVersionService } = require('./domains/versioning/public.cjs');
const { createVersionStaleDetectionService } = require('./services/version-stale-detection-service.cjs');
const { createMediaTrackingScanScheduler } = require('./services/media-tracking-scan-scheduler.cjs');
const { createSelectionService } = require('./services/selection-service.cjs');
const { createTelemetryService } = require('./services/telemetry-service.cjs');
const { createPrivacyService } = require('./privacy-service.cjs');
const { createFileRootWatcherService } = require('./services/file-root-watcher-service.cjs');
const { describeActionableWatchChanges, forgetMissingWatchChanges, recordActionableWatchEntry } = require('./services/watch-change-filter.cjs');
const { createProjectVirtualPathService } = require('./services/project-virtual-path-service.cjs');
const { isInternalWorkspacePath } = require('./infrastructure/internal-workspace-path.cjs');
const cloudConfig = require('./cloud-config.cjs');
const { registerBackgroundTasksIpc } = require('./modules/background-tasks-ipc.cjs');
const { createElectronSecurity, normalizeDevelopmentRendererUrl, normalizeExternalUrl } = require('./security-policy.cjs');
const smokeTestEnabled = process.env.PHOTOFLOW_SMOKE_TEST === '1';
const smokeUserDataPath = String(process.env.PHOTOFLOW_USER_DATA_DIR || '').trim(); const smokeSessionDataPath = String(process.env.PHOTOFLOW_SMOKE_SESSION_DATA_DIR || '').trim();
if (smokeTestEnabled) {
  // Headless/CI Windows sessions may be unable to initialize Electron's GPU
  // child even when Chromium receives --disable-gpu. Disable acceleration at
  // the Electron application layer as well; production startup is unchanged.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  if (!smokeUserDataPath || !path.isAbsolute(smokeUserDataPath) || !smokeSessionDataPath || !path.isAbsolute(smokeSessionDataPath)) throw new Error('smoke userData/sessionData paths must be absolute');
  app.setPath('userData', path.resolve(smokeUserDataPath));
  app.setPath('sessionData', path.resolve(smokeSessionDataPath));
} else {
  // Keep user-facing OS labels localized while runtime data stays in a stable,
  // Latin-only directory name.
  app.setPath('userData', path.join(app.getPath('appData'), 'Photoflow'));
}
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'DirectCompositionVideoOverlays');
app.setName('照片流');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
const managedExternalLinkRegistryPath = path.join(app.getPath('userData'), 'managed-external-links.json');
const projectVirtualPaths = createProjectVirtualPathService({
  shell,
  crypto,
  registryPath: managedExternalLinkRegistryPath,
});
const projectRoot = path.join(__dirname, '..');
const privacyService = createPrivacyService({ app, fs, path, shell, projectRoot });
const userComponentRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'PhotoFlow', 'components')
  : path.join(app.getPath('userData'), 'components');
const componentRegistry = createComponentRegistry({
  projectRoot,
  userComponentRoot,
  isPackaged: app.isPackaged,
});
const componentHostRegistry = createComponentHostRegistry({
  roots: componentRegistry.roots,
  candidateProvider: componentRegistry.hostCandidates,
  admitDescriptor: componentRegistry.admitHostDescriptor,
});
configureProtectedProjectFolderRegistry({ descriptorProvider: componentHostRegistry.list });
let componentViewManager; let componentServiceManager; let configMutationService; let toastViewManager;
const destroyToastViewManager = () => { const manager = toastViewManager; toastViewManager = null; manager?.destroy(); };
const suspendToastViewForNativeDrag = () => toastViewManager?.suspendForNativeDrag();
const resumeToastViewAfterNativeDrag = () => toastViewManager?.resumeAfterNativeDrag();

protocol.registerSchemesAsPrivileged([
  { scheme: 'photoflow-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: 'photoflow-component', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
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
let telemetryService;
let workspaceWatcher = null;
let watchedWorkspacePath = '';
let workspaceWatchTimer = null;
let workspaceReconciliationTimer = null;
const fileOperationState = { projectFileClipboard: null };
const activeProjectFileOperations = new Map();
const mediaMetadataCache = new Map();
const approvedMediaCacheDirectories = new Set([path.resolve(path.join(app.getPath('userData'), 'media-cache'))]);
const renameHistory = [];
const MAX_UNDO_HISTORY = 50;
const discardUndoOperation = operation => {
  if (!['trash', 'import-with-sources', 'paste-replace'].includes(operation?.kind)) return;
  const removedRoots = new Set();
  for (const item of operation.items || []) {
    if (item.backupRoot && !removedRoots.has(item.backupRoot)) {
      removedRoots.add(item.backupRoot);
      void fs.promises.rm(item.backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};
const pushUndoOperation = async operation => {
  const stored = { ...await addUndoIdentities(operation), undoToken: operation.undoToken || crypto.randomUUID() };
  renameHistory.push(stored);
  // Keep undo data bounded. Entries that fall off the stack intentionally
  // become permanent, matching the behaviour of standard file managers.
  if (renameHistory.length > MAX_UNDO_HISTORY) discardUndoOperation(renameHistory.shift());
  return stored;
};
const removeUndoOperation = undoToken => {
  const index = renameHistory.findIndex(operation => operation.undoToken === undoToken);
  if (index < 0) return false;
  const [removed] = renameHistory.splice(index, 1);
  discardUndoOperation(removed);
  return true;
};
const workspaceCatalogs = new Map();
let shellThumbnailProcess = null;
let shellThumbnailManagedProcess = null;
let shellThumbnailOutput = '';
let shellThumbnailRequestId = 0;
let shellThumbnailWorkChain = Promise.resolve();
const shellThumbnailRequests = new Map();
let shellThumbnailUnavailableLogged = false;
let thumbnailPipeline = null;
let thumbnailService = null;
let fileRootWatcherService = null;
let mediaService = null;
const mediaRuntimeState = {
  activeMediaCacheConfig: { maxSizeGB: 50, directory: '' },
};
const normalizeMediaCacheSizeGB = (value, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};
const workspaceWatchChanges = new Map();
const workspaceWatchKnownEntries = new Map();
const workspaceWatchSuppressions = new Map();
let mediaTrackingScanScheduler = null;
const isInternalWorkspaceChange = isInternalWorkspacePath;
const comparableWorkspacePath = value => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
};
const pathIsInside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const isSuppressedWorkspaceChange = (root, fileName) => {
  const candidate = comparableWorkspacePath(path.resolve(root, String(fileName || '')));
  return [...workspaceWatchSuppressions.keys()].some(suppressed => pathIsInside(suppressed, candidate));
};
const suppressWorkspaceWatchPath = targetPath => {
  const suppressed = comparableWorkspacePath(targetPath);
  workspaceWatchSuppressions.set(suppressed, (workspaceWatchSuppressions.get(suppressed) || 0) + 1);
  for (const changedName of workspaceWatchChanges.keys()) {
    const candidate = comparableWorkspacePath(path.resolve(watchedWorkspacePath || path.dirname(targetPath), changedName));
    if (pathIsInside(suppressed, candidate)) workspaceWatchChanges.delete(changedName);
  }
  fileRootWatcherService?.discardChangesInside(targetPath);
};
const releaseWorkspaceWatchPath = (targetPath, delayMs = 750) => {
  const suppressed = comparableWorkspacePath(targetPath);
  setTimeout(() => {
    const count = workspaceWatchSuppressions.get(suppressed) || 0;
    if (count <= 1) workspaceWatchSuppressions.delete(suppressed);
    else workspaceWatchSuppressions.set(suppressed, count - 1);
  }, Math.max(0, delayMs));
};
const trackedVersionThumbnailCopies = new Map();
const nativeConsoleLog = console.log.bind(console);
const nativeConsoleError = console.error.bind(console);
const processSupervisor = createProcessSupervisor({ writeLog: (...args) => writeLog(...args) });
const workspaceSqliteCoordinator = new WorkspaceSqliteCoordinator();

const recycleBinService = createRecycleBinService({ app, shell, projectRoot, processSupervisor });
const fileClipboardService = createFileClipboardService({ app, projectRoot, processSupervisor });
const filePublicationService = createFilePublicationService({ app, projectRoot, processSupervisor });
const shellNewService = createShellNewService({ app });
const fileSystemService = createFileSystemService({ recycleBinService });
const {
  assertExistingInside,
  assertInside,
  assertDiskSpace,
  assertRegularFile,
  CANCELLED_CODE,
  collectCopyPlan,
  copyFileAtomic,
  copyPlannedFiles,
  moveFileAtomic,
  movePathAtomic,
  publishPathNoClobber,
  configureNativePublicationService,
  removeCopiedSources,
  removeCreatedPasteTargets,
  throwIfCancelled,
  uniqueDestination,
  capturePathIdentity,
  addUndoIdentities,
  assertUndoIdentity,
  samePathIdentity,
} = fileSystemService;
configureNativePublicationService(filePublicationService);
const eventBus = createEventBus();
mediaAccessService = createMediaAccessService({
  getWorkspaceRoots: () => [...workspaceCatalogs.keys()],
  getAdditionalRoots: () => [
    mediaRuntimeState.activeMediaCacheConfig.directory && approvedMediaCacheDirectories.has(path.resolve(mediaRuntimeState.activeMediaCacheConfig.directory))
      ? resolveMediaCacheDir(mediaRuntimeState.activeMediaCacheConfig) : '',
    path.join(app.getPath('userData'), 'media-cache'),
    path.join(app.getPath('userData'), 'workspace-data'),
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
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const markerPath = path.join(getLogDir(), '.last-cleanup-date');
  if ((await fs.promises.readFile(markerPath, 'utf8').catch(() => '')).trim() === today) return 0;
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
    await fs.promises.writeFile(markerPath, today, 'utf8');
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
const backgroundTasks = createBackgroundTaskService({
  eventBus,
  writeLog,
  persistencePath: path.join(app.getPath('userData'), 'background-tasks.json'),
});
eventBus.on('background-task:persistence-error', details => writeLog('error', 'Background task persistence failed', details));
const domainCommandJournal = createDomainCommandJournal({
  filePath: path.join(app.getPath('userData'), 'domain-command-journal.json'),
  writeLog,
});
const domainHealthService = createDomainHealthService();
const databaseHealthOptions = domainId => ({
  domainId,
  onHealthChange: state => {
    domainHealthService.update(domainId, state);
    if (state.state !== 'healthy') writeLog(state.state === 'unavailable' ? 'error' : 'warn', 'Domain health changed', state);
  },
});

const rendererEntryFile = path.join(__dirname, '../artifacts/web/index.html');
const toastViewRendererFile = path.join(__dirname, '../artifacts/web/toast-view.html');
const isDevelopmentRenderer = () => process.env.NODE_ENV === 'development';
const developmentRendererUrl = isDevelopmentRenderer() ? normalizeDevelopmentRendererUrl(process.env.PHOTOFLOW_DEV_SERVER_URL) : '';
const { configureWindowSecurity, ipcMain, openAllowedExternalUrl } = createElectronSecurity({
  electronIpcMain, getMainWindow: () => mainWindow, isDevelopment: isDevelopmentRenderer,
  rendererFile: rendererEntryFile, developmentRendererUrl, shell, writeLog,
});
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
  if (shellThumbnailManagedProcess) {
    shellThumbnailManagedProcess.stop('shell-thumbnail-stop');
    shellThumbnailManagedProcess = null;
  } else if (child && !child.killed) child.kill();
};

const attachShellThumbnailProcess = (child, managedProcess = null) => {
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
      managedProcess?.markHealthy({ protocol: 'tab-lines' });
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

const ensureShellThumbnailProcess = () => {
  if (process.platform !== 'win32') return null;
  if (shellThumbnailProcess && !shellThumbnailProcess.killed) return shellThumbnailProcess;
  if (shellThumbnailManagedProcess && !shellThumbnailManagedProcess.released) {
    if (shellThumbnailManagedProcess.state === 'restarting') return shellThumbnailManagedProcess.start();
    shellThumbnailManagedProcess.release();
    shellThumbnailManagedProcess = null;
  }
  const executable = getShellThumbnailExecutable();
  if (!fs.existsSync(executable)) {
    if (!shellThumbnailUnavailableLogged) {
      shellThumbnailUnavailableLogged = true;
      writeLog('warn', 'Windows Shell thumbnail cache helper is unavailable', { executable });
    }
    return null;
  }

  shellThumbnailManagedProcess = processSupervisor.launch({
    id: 'csharp:shell-thumbnail',
    kind: 'csharp-helper',
    command: executable,
    args: [],
    options: { stdio: ['pipe', 'pipe', 'ignore'] },
    restart: { enabled: true, maxRestarts: 3, windowMs: 60000, backoffMs: [100, 400, 1200] },
    onSpawn: attachShellThumbnailProcess,
  });
  return shellThumbnailManagedProcess.child;
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



function createWindow(loadRenderer = true) {
  // On macOS all windows may close without quitting. Tear down IPC and event
  // bindings while the manager still owns its original parent window, before
  // replacing mainWindow during app activation.
  destroyToastViewManager();
  // 2. 彻底移除顶部菜单栏 (File, Edit, View...)
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    icon: app.isPackaged ? undefined : path.join(__dirname, '../packaging/icon.ico'),
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
      sandbox: true,
      webviewTag: false,
      ...(smokeTestEnabled ? { offscreen: true } : {}),
    },
  });
  configureWindowSecurity(mainWindow);
  toastViewManager = new ToastViewManager({ WebContentsView, mainWindow, ipcMain: electronIpcMain, preloadPath: path.join(__dirname, 'toast-view-preload.cjs'), rendererFile: toastViewRendererFile, developmentRendererUrl, writeLog });
  const sendMaximizedState = () => {
    if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('window-maximized-change', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11' || input.isAutoRepeat) return;
    event.preventDefault();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
  mainWindow.center();
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.maximize();
    mainWindow.show();
    sendMaximizedState();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    telemetryService?.reportCrash('renderer', new Error(`Renderer process exited: ${details.reason}`), {
      reason: details.reason,
      exit_code: details.exitCode,
    });
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    writeLog('error', 'Main-window preload failed', { preloadPath, error: error?.stack || error?.message || String(error) });
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame) writeLog('error', 'Main-window renderer failed to load', { errorCode, errorDescription, validatedUrl });
  });
  mainWindow.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error' || details.level === 3) writeLog('error', 'Renderer console error', {
      message: details.message,
      lineNumber: details.lineNumber,
      sourceId: details.sourceId,
    });
  });

  if (loadRenderer) loadMainWindowRenderer();
}

const loadMainWindowRenderer = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    void mainWindow.loadURL(developmentRendererUrl);
    //mainWindow.webContents.openDevTools();
  } else {
    void mainWindow.loadFile(rendererEntryFile);
  }
};

let pluginService;
const bundledPythonRuntime = createBundledPythonRuntime({
  app,
  projectRoot,
  processSupervisor,
  getPluginService: () => pluginService,
});
const { getRunConfig, runJsonCommand, runPythonEventAction, runPythonJsonAction } = bundledPythonRuntime;

pluginService = createPluginService({ app, registry: componentRegistry, runJsonCommand });

const extractVideoTimelineFrames = async (filePath, times) => {
  const operationId = crypto.randomUUID();
  const requestRoot = path.join(app.getPath('temp'), 'photoflow', 'video-playback-timeline', operationId);
  const requestPath = path.join(requestRoot, 'request.json');
  const outputDirectory = path.join(requestRoot, 'frames');
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  await fs.promises.writeFile(requestPath, JSON.stringify({ filePath: path.resolve(filePath), times, outputDirectory }), 'utf8');
  try {
    const result = await pluginService.runJsonForCapability('media.video.timeline-frames', [requestPath], 2 * 60 * 1000);
    if (!result?.success || !Array.isArray(result.frames)) throw new Error(result?.error || '播放器组件未返回时间线帧');
    return result.frames;
  } finally {
    await fs.promises.rm(requestRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

const checkForUpdates = async () => {
  if (!mainWindow) return { success: false, error: '主窗口尚未就绪' };
  try {
    if (!cloudConfig.apiBaseUrl) return { success: false, error: '未配置腾讯云更新服务' };
    const currentVersion = app.getVersion();
    const query = new URLSearchParams({
      platform: process.platform,
      arch: process.arch,
      channel: cloudConfig.updateChannel || 'stable',
      currentVersion,
    });
    const response = await fetch(`${cloudConfig.apiBaseUrl.replace(/\/+$/, '')}/v1/updates?${query}`);
    if (!response.ok) throw new Error(`更新服务返回 ${response.status}`);
    const data = await response.json();
    const updateAvailable = data.updateAvailable === true;
    const downloadUrl = updateAvailable ? normalizeExternalUrl(data.downloadUrl) : '';
    if (updateAvailable && !downloadUrl) throw new Error('更新服务返回了不受信任的下载地址');
    const result = {
      success: true,
      updateAvailable,
      currentVersion,
      latestVersion: data.latestVersion,
      url: downloadUrl,
      notes: data.notes || '',
      sha256: data.sha256 || '',
      mandatory: data.mandatory === true,
    };
    telemetryService?.track('update_checked', { update_available: result.updateAvailable });
    if (result.updateAvailable) mainWindow.webContents.send('update-available', {
      version: result.latestVersion,
      url: result.url,
      notes: result.notes,
      mandatory: result.mandatory,
    });
    return result;
  } catch (error) {
    console.error('Update check failed:', error);
    return { success: false, error: error.message || String(error) };
  }
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
const installationId = loadOrCreateInstallationId({ fs, path, crypto, userDataPath: getConfigDir() });

const getConfigPath = () => {
  return path.join(getConfigDir(), 'photoflow_config.json');
};

const readSavedConfig = () => {
  try {
    const config = readConfigFileWithRecovery(fs, getConfigPath());
    const hasCoreConsent = privacyService.hasCoreConsent();
    const initialExperienceConsent = privacyService.getState().experienceProgramGranted === true;
    const configuredTelemetry = config?.telemetry && typeof config.telemetry === 'object' ? config.telemetry : {};
    return {
      ...(config && typeof config === 'object' ? config : {}),
      telemetry: hasCoreConsent
        ? {
            enabled: typeof configuredTelemetry.enabled === 'boolean' ? configuredTelemetry.enabled : initialExperienceConsent,
            crashReports: typeof configuredTelemetry.crashReports === 'boolean' ? configuredTelemetry.crashReports : initialExperienceConsent,
          }
        : { enabled: false, crashReports: false },
    };
  } catch (error) {
    writeLog('warn', 'Unable to read saved configuration', { error: error.message || String(error) });
    return { telemetry: { enabled: false, crashReports: false } };
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

const workspaceStorageKeyService = createWorkspaceStorageKeyService({
  fs, path, crypto, databaseDir: path.join(app.getPath('userData'), 'workspace-data'), writeLog,
});
const getWorkspaceStorageKey = root => workspaceStorageKeyService.get(root);

const getWorkspaceDatabasePath = root => {
  const databaseDir = path.join(app.getPath('userData'), 'workspace-data');
  fs.mkdirSync(databaseDir, { recursive: true });
  const fileName = `${getWorkspaceStorageKey(root)}.sqlite3`;
  return path.join(databaseDir, fileName);
};

const getWorkspaceDataRoot = root => workspaceStorageKeyService.getDataRootForKey(getWorkspaceStorageKey(root));

const getWorkspaceOperationsDatabasePath = root => path.join(
  getWorkspaceDataRoot(root),
  'databases',
  'operations.sqlite3',
);

const getWorkspaceMediaDatabasePath = root => path.join(
  getWorkspaceDataRoot(root),
  'databases',
  'media.sqlite3',
);
const getWorkspaceVersioningDatabasePath = root => path.join(
  getWorkspaceDataRoot(root),
  'databases',
  'versioning.sqlite3',
);

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

const workspaceDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:workspace-catalog',
  ...databaseHealthOptions('workspace'),
  // A one-time reconciliation can cascade through thousands of media rows
  // after a project folder disappears outside the app. Do not kill the worker
  // halfway through that recovery and leave the project list empty.
  defaultTimeoutMs: 2 * 60 * 1000,
});
const operationsDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceOperationsDatabasePath,
  writeLog,
  scriptName: 'operations_db.py',
  processSupervisor,
  processId: 'python:operations',
  ...databaseHealthOptions('file-operations'),
});
const operationsRepository = createOperationsRepository(operationsDatabase, getWorkspaceDatabasePath);
const workspaceRepository = createWorkspaceRepository(workspaceDatabase, operationsRepository);
// Run routine integrity checks and backups in an independent process so they
// cannot hold up interactive project-catalog requests.
const workspaceMaintenanceDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:workspace-maintenance',
  ...databaseHealthOptions('workspace-maintenance'),
  defaultTimeoutMs: 30 * 60 * 1000,
});
const workspaceMaintenanceRepository = createWorkspaceRepository(workspaceMaintenanceDatabase);
// Keep interactive media/version/team requests on their own worker.
const mediaDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:media-background',
  ...databaseHealthOptions('media-background'),
  defaultTimeoutMs: 30 * 60 * 1000,
});
// Keep small user-driven mutations away from the worker that also performs
// project synchronization and commit planning.  The Python server processes
// one request at a time, so a dedicated worker prevents clicks such as
// tracking/team confirmations from waiting behind an unrelated long request.
const mediaInteractionDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:media-interaction',
  ...databaseHealthOptions('media-interaction'),
  defaultTimeoutMs: 60 * 1000,
});
const mediaBackgroundRepository = createMediaRepository(mediaDatabase);
const mediaInteractionRepository = createMediaRepository(mediaInteractionDatabase);
const trustedExternalMediaRoots = (root, projectName) => {
  const project = workspaceCatalogs.get(path.resolve(root))?.byName.get(String(projectName || '').toLocaleLowerCase());
  if (!project?.relative_path) return [];
  const projectRoot = path.resolve(root, project.relative_path);
  return projectVirtualPaths.listManagedExternalLinks(projectRoot)
    .map(link => ({ path: link.externalTargetRoot, kind: link.externalTargetKind, authorized: true, online: !link.offline }));
};
const mediaRepository = {
  ...mediaBackgroundRepository,
  syncProject: (root, projectName) => mediaBackgroundRepository.syncProject(root, projectName, trustedExternalMediaRoots(root, projectName)),
  syncChangedPaths: (root, projectName, changes, _externalRoots, options) => mediaBackgroundRepository.syncChangedPaths(root, projectName, changes, trustedExternalMediaRoots(root, projectName), options),
  getPhoto: mediaInteractionRepository.getPhoto,
  createVersion: mediaInteractionRepository.createVersion,
  updateVersion: mediaInteractionRepository.updateVersion,
  listFinalVersions: mediaInteractionRepository.listFinalVersions,
  relocateVersion: mediaInteractionRepository.relocateVersion,
  deleteVersion: mediaInteractionRepository.deleteVersion,
  getVersionDeleteScope: mediaInteractionRepository.getVersionDeleteScope,
  deleteProjectMissingVersion: mediaInteractionRepository.deleteProjectMissingVersion,
  recordCompare: mediaInteractionRepository.recordCompare,
  listProgress: mediaInteractionRepository.listProgress,
  snapshotProgress: mediaInteractionRepository.snapshotProgress,
  snapshotProgressLocations: mediaInteractionRepository.snapshotProgressLocations,
  registerProgress: mediaInteractionRepository.registerProgress,
  registerProgressWithGraph: mediaInteractionRepository.registerProgressWithGraph,
  adoptMediaFolder: mediaInteractionRepository.adoptMediaFolder,
  revertExternalAdoptions: mediaInteractionRepository.revertExternalAdoptions,
  updateProgressTree: mediaInteractionRepository.updateProgressTree,
  updateProgressRelation: mediaInteractionRepository.updateProgressRelation,
  repairLegacySelectionRelation: mediaInteractionRepository.repairLegacySelectionRelation,
  createVersionGraphEdge: mediaInteractionRepository.createVersionGraphEdge,
  deleteVersionGraphEdge: mediaInteractionRepository.deleteVersionGraphEdge,
  replaceVersionGraphEdgeSource: mediaInteractionRepository.replaceVersionGraphEdgeSource,
  getVersionTreeLayout: mediaInteractionRepository.getVersionTreeLayout,
  saveVersionTreeLayout: mediaInteractionRepository.saveVersionTreeLayout,
  unregisterProgress: mediaInteractionRepository.unregisterProgress,
  deleteMissingProgress: mediaInteractionRepository.deleteMissingProgress,
  listBatchOperations: mediaInteractionRepository.listBatchOperations,
  getTrackingSession: mediaInteractionRepository.getTrackingSession,
  releaseTrackingSession: mediaInteractionRepository.releaseTrackingSession,
  decideTrackingItem: mediaInteractionRepository.decideTrackingItem,
};
const versionService = createVersionService({ repository: mediaRepository });
let selectionService = null;
const versionStaleDetectionService = createVersionStaleDetectionService({ versionService, backgroundTasks, writeLog });
// Directory walks and deferred full-hash backfills can take minutes on large
// projects. Run scheduled scans on a separate worker so opening a component
// view never waits behind background media tracking work.
const mediaScanDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:media-scan',
  ...databaseHealthOptions('media-scan'),
  defaultTimeoutMs: 30 * 60 * 1000,
});
const mediaScanRepository = createMediaRepository(mediaScanDatabase);
const mediaScanService = createVersionService({ repository: {
  ...mediaScanRepository,
  syncProject: (root, projectName) => mediaScanRepository.syncProject(root, projectName, trustedExternalMediaRoots(root, projectName)),
  syncChangedPaths: (root, projectName, changes, _externalRoots, options) => mediaScanRepository.syncChangedPaths(root, projectName, changes, trustedExternalMediaRoots(root, projectName), options),
} });
// Version comparisons can run alongside a full media-index scan. Give them a
// separate database worker so the scheduler's read concurrency is real rather
// than two UI tasks queued inside one synchronous Python server process.
const trackingScanDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:tracking-scan',
  ...databaseHealthOptions('versioning-scan'),
  defaultTimeoutMs: 30 * 60 * 1000,
});
const trackingScanRepository = createMediaRepository(trackingScanDatabase);
const trackingScanService = createVersionService({ repository: trackingScanRepository });
const workspaceService = createWorkspaceService({
  repository: workspaceRepository,
  reconcileRepository: workspaceMaintenanceRepository,
  catalogs: workspaceCatalogs,
  statuses: WORKSPACE_STATUSES,
  assertInside,
  assertExistingInside,
  getConfiguredInspirationRoot: () => readSavedConfig()?.inspirationLibrary?.rootPath || '',
});
const resolveWorkspaceRoot = workspaceService.resolveRoot;
const ensureWorkspace = workspaceService.ensureRoot;
const refreshWorkspaceCatalog = workspaceService.refreshCatalog;
const reconcileWorkspaceCatalogDirect = workspaceService.reconcileCatalog;
const workspaceCatalogReconciliations = new Map();
const stableCatalogValue = value => Array.isArray(value) ? value.map(stableCatalogValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableCatalogValue(value[key])])) : value;
const stableCatalogExtra = value => { try { return stableCatalogValue(JSON.parse(value || '{}')); } catch { return value || ''; } };
const workspaceCatalogSemanticSnapshot = catalog => JSON.stringify((catalog?.projects || []).map(project => ({
  name: project.name, status: project.status, relative_path: project.relative_path,
  filesystem_id: project.filesystem_id, availability: project.availability, missing_since: project.missing_since,
  extra_json: stableCatalogExtra(project.extra_json),
})).sort((left, right) => `${left.relative_path}\0${left.name}`.localeCompare(`${right.relative_path}\0${right.name}`)));
const reconcileWorkspaceCatalog = root => {
  const existing = workspaceCatalogReconciliations.get(root);
  if (existing) return existing;
  const previousSnapshot = workspaceCatalogSemanticSnapshot(workspaceCatalogs.get(root));
  const operation = reconcileWorkspaceCatalogDirect(root).then(catalog => {
    const changed = previousSnapshot !== workspaceCatalogSemanticSnapshot(catalog);
    if (changed && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workspace-projects-changed', { root, reconciled: true });
    }
    return catalog;
  }).finally(() => workspaceCatalogReconciliations.delete(root));
  workspaceCatalogReconciliations.set(root, operation);
  return operation;
};
const mutateWorkspaceCatalog = workspaceService.mutateCatalog;
const getProjectPath = workspaceService.getProjectPath;
const cleanProjectName = workspaceService.cleanProjectName;

const stopWorkspaceWatcher = (stopSchedulers = false) => {
  const previousWorkspaceRoot = watchedWorkspacePath;
  if (workspaceWatchTimer) clearTimeout(workspaceWatchTimer);
  workspaceWatchTimer = null;
  if (workspaceWatcher) workspaceWatcher.close();
  workspaceWatcher = null;
  watchedWorkspacePath = '';
  workspaceWatchChanges.clear();
  workspaceWatchKnownEntries.clear();
  workspaceWatchSuppressions.clear();
  if (workspaceReconciliationTimer) clearInterval(workspaceReconciliationTimer);
  workspaceReconciliationTimer = null;
  workspaceReconcileTask.reset();
  if (previousWorkspaceRoot) for (const project of workspaceCatalogs.get(previousWorkspaceRoot)?.projects || []) mediaTrackingScanScheduler?.cancel(previousWorkspaceRoot, project.name);
  if (stopSchedulers) {
    mediaTrackingScanScheduler?.stop();
    versionStaleDetectionService.stop();
  }
};

const stopFileRootWatchers = () => {
  fileRootWatcherService?.stop();
};

const acquireFileRootWatcher = (rootPath, options) => fileRootWatcherService?.acquire(rootPath, options)
  || { success: false, root: path.resolve(rootPath), error: '文件根目录监听服务尚未初始化' };

const releaseFileRootWatcher = (rootPath, options) => fileRootWatcherService?.release(rootPath, options);
const suspendFileRootWatcher = rootPath => fileRootWatcherService?.suspend(rootPath) || 0;
const resumeFileRootWatcher = (rootPath, references) => fileRootWatcherService?.resume(rootPath, references)
  || { success: false, root: path.resolve(rootPath), error: '文件根目录监听服务尚未初始化' };

const workspaceReconcileTask = createWorkspaceReconcileTask({ backgroundTasks, getWatchedWorkspacePath: () => watchedWorkspacePath, getProjects: root => workspaceCatalogs.get(root)?.projects, reconcileWorkspaceCatalog, writeLog });
const reconcileWorkspaceState = workspaceReconcileTask.run;

const startWorkspaceReconciliation = root => {
  if (workspaceReconciliationTimer) clearInterval(workspaceReconciliationTimer);
  workspaceReconciliationTimer = setInterval(() => { void reconcileWorkspaceState(root); }, 5 * 60 * 1000);
};

const scheduleMediaTrackingScan = (...args) => mediaTrackingScanScheduler?.schedule(...args);
const cancelMediaTrackingScan = (...args) => mediaTrackingScanScheduler?.cancel(...args);

const watchWorkspace = (root) => {
  if (watchedWorkspacePath === root && workspaceWatcher) return;
  stopWorkspaceWatcher();
  try {
    workspaceWatcher = fs.watch(root, { recursive: process.platform !== 'linux' }, (eventType, fileName) => {
      // File operations are assembled in hidden staging paths and committed
      // atomically. Watching those temporary writes caused thumbnail work and
      // repeated renderer refreshes for every file in a large copy operation.
      if (isInternalWorkspaceChange(fileName)) return;
      if (!fileName) return;
      if (isSuppressedWorkspaceChange(root, fileName)) return;
      const changedName = String(fileName);
      const normalizedEventType = eventType === 'rename' ? 'rename' : 'change';
      recordActionableWatchEntry(workspaceWatchChanges, workspaceWatchKnownEntries, root, changedName, normalizedEventType, fs);
      if (workspaceWatchTimer) clearTimeout(workspaceWatchTimer);
      workspaceWatchTimer = setTimeout(() => {
        const describedChanges = describeActionableWatchChanges(root, [...workspaceWatchChanges], fs);
        workspaceWatchChanges.clear();
        forgetMissingWatchChanges(workspaceWatchKnownEntries, root, describedChanges);
        if (!describedChanges.length) return;
        const changedEntries = describedChanges.map(change => [path.relative(root, change.path), change.eventType]);
        const changedNames = changedEntries.map(([changedName]) => changedName);
        const changedEventTypes = new Map(changedEntries);
        if (thumbnailService) {
          const changesByProject = new Map();
          for (const change of describedChanges) {
            const changedName = path.relative(root, change.path);
            const segments = changedName.split(/[\\/]/).filter(Boolean);
            if (segments.length < 2) continue;
            const projectRoot = path.join(root, segments[0]);
            if (!changesByProject.has(projectRoot)) changesByProject.set(projectRoot, []);
            changesByProject.get(projectRoot).push(change.path);
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
        const catalogRescanNames = new Set(changedEntries.flatMap(([changedName, changedEventType]) => {
          const segments = changedName.split(/[\\/]/).filter(Boolean);
          const firstSegment = segments[0];
          if (!firstSegment) return [];
          return (segments.length === 1 && changedEventType === 'rename'
            || !knownProjectPaths.has(firstSegment.toLocaleLowerCase())) ? [firstSegment] : [];
        }));
        const catalogMayHaveChanged = !changedNames.length || changedSegments.some(segments => segments.length === 1 || !knownProjectPaths.has(String(segments[0] || '').toLocaleLowerCase()));
        const changedProjects = new Set();
        const changedPathsByProject = new Map();
        for (const change of describedChanges) {
          const changedName = path.relative(root, change.path);
          const segments = changedName.split(/[\\/]/).filter(Boolean);
          if (segments.length < 2) continue;
          const firstSegment = segments[0];
          const project = catalog?.projects.find(item => item.relative_path.toLocaleLowerCase() === String(firstSegment || '').toLocaleLowerCase());
          if (project) {
            changedProjects.add(project.name);
            if (!changedPathsByProject.has(project.name)) changedPathsByProject.set(project.name, []);
            changedPathsByProject.get(project.name).push(change);
          }
        }
        if (!changedNames.length) for (const project of catalog?.projects || []) changedProjects.add(project.name);
        for (const projectName of changedProjects) scheduleMediaTrackingScan(
          root, projectName, changedPathsByProject.get(projectName) || [], !changedNames.length,
        );
        if (mainWindow && !mainWindow.isDestroyed()) {
          for (const changedName of changedNames) {
            mainWindow.webContents.send('workspace-files-changed', { root, fileName: changedName, eventType: changedEventTypes.get(changedName) || 'rename' });
          }
        }
        if (catalogMayHaveChanged) {
          void reconcileWorkspaceCatalog(root).then(refreshedCatalog => {
            for (const topLevelName of catalogRescanNames) {
              const project = refreshedCatalog.projects.find(item => item.relative_path.toLocaleLowerCase() === String(topLevelName).toLocaleLowerCase());
              if (project) scheduleMediaTrackingScan(root, project.name, [], true);
            }
          }).catch(error => {
            writeLog('warn', 'Unable to reconcile workspace catalog after file change', { root, error: error.message || String(error) });
          });
        }
      }, 200);
    });
    // Reconcile version state lazily when a project watcher is installed. A
    // workspace with dozens of projects must not enqueue one database writer
    // per project merely because its catalog was opened.
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

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif']);
const IMAGE_PREVIEW_CONVERSION_EXTENSIONS = new Set(['.tif', '.tiff', '.heic', '.heif', '.hif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.mpeg', '.mpg', '.mts', '.m2ts', '.crm']);
const RAW_EXTENSIONS = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']);
const mediaRatingService = createMediaRatingService({
  exiftool, fs, path, imageExtensions: IMAGE_EXTENSIONS, rawExtensions: RAW_EXTENSIONS,
  releaseWorkspaceWatchPath, suppressWorkspaceWatchPath, versionService, projectVirtualPaths, writeLog,
  pendingRatingsPath: path.join(app.getPath('userData'), 'pending-media-ratings.json'),
  onInvalidate: filePath => {
    const prefix = `${path.resolve(filePath)}|`;
    for (const key of mediaMetadataCache.keys()) if (key.startsWith(prefix)) mediaMetadataCache.delete(key);
  },
});
selectionService = createSelectionService({
  fs, crypto, copyFileAtomic, versionService, projectVirtualPaths,
  imageExtensions: IMAGE_EXTENSIONS, rawExtensions: RAW_EXTENSIONS, videoExtensions: VIDEO_EXTENSIONS,
});
const RAW_DECODER_CACHE_VERSION = 'libraw-rawpy-v1';
const HIDDEN_SYSTEM_ENTRY_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store', '.photoflow-workspace-id']);

const resolveMediaCacheDir = (config = {}) => {
  return resolveMediaCacheNamespace({ path, userDataPath: getConfigDir(), installationId, configuredDirectory: config.directory });
};

const getMediaCacheDir = (config = {}) => {
  const requested = typeof config.directory === 'string' ? config.directory.trim() : '';
  const selectedRoot = path.resolve(requested || path.join(getConfigDir(), 'media-cache'));
  const cacheDir = resolveMediaCacheDir(config);
  if (!approvedMediaCacheDirectories.has(selectedRoot)) throw new Error('媒体缓存目录未经授权');
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
  const deadlineAt = Date.now() + 10 * 60 * 1000;
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
    const protectedCachePaths = new Set([...trackedVersionThumbnailCopies.values()].map(pending => {
      const resolved = path.resolve(pending.cachePath);
      return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
    }));
    await thumbnailService.evictCache({
      cacheRoot: directory,
      bytesToFree: Math.max(0, refreshed.totalBytes - refreshed.maxBytes),
      excludePaths: [...protectedCachePaths],
      recoverOrphans: true,
      deadlineAt,
    });
    await refreshMediaCacheIndex(directory);
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

const decodedImagePreviewPath = async (sourcePath, stat, cacheConfig, kind) => {
  const cacheDir = getMediaCacheDir(cacheConfig);
  const target = decodedImagePreviewCacheFile(sourcePath, stat, cacheDir, kind);
  if (isCompleteJpegFile(target)) return target;
  if (fs.existsSync(target)) await thumbnailService?.evictCache({ thumbnailPaths: [target] }).catch(() => undefined);
  try {
    await imageThumbnailRuntime.generateOriginalImagePreviewFile(sourcePath, kind, [{ sizeLabel: `${kind}-preview`, pixels: 0, path: target }]);
    if (!isCompleteJpegFile(target)) return null;
    trimMediaCache(cacheDir, cacheConfig?.maxSizeGB, [target]);
    return target;
  } catch (error) {
    writeLog('warn', 'Browser-compatible image preview generation failed', { sourcePath, kind, error: error.message || String(error) });
    return null;
  }
};

const rawPreviewPath = (sourcePath, stat, cacheConfig) => decodedImagePreviewPath(sourcePath, stat, cacheConfig, 'raw');
const convertedImagePreviewPath = (sourcePath, stat, cacheConfig) => decodedImagePreviewPath(sourcePath, stat, cacheConfig, 'image');

const mediaSourceCacheKey = sourcePath => process.platform === 'win32' ? path.resolve(sourcePath).toLowerCase() : path.resolve(sourcePath);
const decodedImagePreviewCacheFile = (sourcePath, stat, cacheDir, kind) => path.join(cacheDir, crypto.createHash('sha256').update(`decoded-preview|v2|${kind}|${kind === 'raw' ? RAW_DECODER_CACHE_VERSION : 'builtin'}|${mediaSourceCacheKey(sourcePath)}|${stat.size}|${stat.mtimeMs}`).digest('hex') + '.jpg');
const mediaThumbnailCacheFile = (sourcePath, stat, cacheDir, requestedSize, version = THUMBNAIL_VERSION) => path.join(cacheDir, crypto.createHash('sha256').update(`thumbnail|v${version}|${RAW_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()) ? RAW_DECODER_CACHE_VERSION : 'builtin'}|${requestedSize}|${mediaSourceCacheKey(sourcePath)}|${stat.size}|${stat.mtimeMs}`).digest('hex') + '.jpg');

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

mediaTrackingScanScheduler = createMediaTrackingScanScheduler({
  backgroundTasks,
  mediaScanService,
  versionStaleDetectionService,
  getProject: (root, projectName) => workspaceCatalogs.get(root)?.byName.get(String(projectName || '').toLocaleLowerCase()),
  onThumbnailCandidate: candidate => { void ensureTrackedVersionThumbnail(candidate); },
  thumbnailPriority: PRIORITY.project,
  writeLog,
});

const rawOrientationCorrection = createRawOrientationService({ exiftool }).correction;
const imageThumbnailRuntime = createImageThumbnailRuntime({
  crypto, fs, nativeImage, spawn, processSupervisor, getRunConfig, runPythonJsonAction,
  getMediaCacheDir, mediaThumbnailCacheFile, copyWindowsShellThumbnail,
  thumbnailVersion: THUMBNAIL_VERSION,
});

thumbnailPipeline = new ThumbnailPipeline({
  getRunConfig,
  processSupervisor,
  databasePath: path.join(getConfigDir(), 'thumbnail-index.sqlite3'),
  getCacheDir: getMediaCacheDir,
  resolveCacheDir: resolveMediaCacheDir,
  cacheFilePath: mediaThumbnailCacheFile,
  generateThumbnailSet: imageThumbnailRuntime.generateThumbnailSet,
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
thumbnailService = createThumbnailService({ pipeline: thumbnailPipeline, backgroundTasks, writeLog });
fileRootWatcherService = createFileRootWatcherService({
  getMainWindow: () => mainWindow,
  getThumbnailService: () => thumbnailService,
  getMediaCacheConfig: () => mediaRuntimeState.activeMediaCacheConfig,
  isInternalChange: isInternalWorkspaceChange,
  isSuppressedChange: isSuppressedWorkspaceChange,
  writeLog,
});
mediaService = createMediaService({ accessService: mediaAccessService, thumbnailService, toMediaUrl });







const findImportedVideoPreview = async sourcePath => {
  const sourceDir = path.dirname(sourcePath);
  const sourceFolder = path.basename(sourceDir).toLocaleLowerCase();
  if (sourceFolder === 'mov_转码'.toLocaleLowerCase()) return sourcePath;
  if (sourceFolder !== 'mov') return null;

  const previewDir = path.join(path.dirname(sourceDir), 'mov_转码');
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





const writeSystemFileClipboard = (sources, operation) => fileClipboardService.write(sources, operation);
const readSystemFileClipboard = () => fileClipboardService.read();
const clearSystemFileClipboardIfCurrent = snapshot => fileClipboardService.clearIfCurrent(snapshot);
const cancelSystemFileCut = async expectedSources => {
  if (process.platform !== 'win32') return { cleared: false, hasFiles: false };
  const current = await readSystemFileClipboard();
  const expectedKeys = new Set(expectedSources.map(source => path.resolve(source).toLocaleLowerCase()));
  const currentSources = (current?.sources || []).map(source => path.resolve(source));
  const currentKeys = new Set(currentSources.map(source => source.toLocaleLowerCase()));
  const matchesExpectedCut = current?.operation === 'cut'
    && currentSources.length === expectedSources.length
    && currentKeys.size === expectedKeys.size
    && [...currentKeys].every(source => expectedKeys.has(source));
  if (!matchesExpectedCut) return { cleared: false, hasFiles: currentSources.some(source => fs.existsSync(source)) };
  const result = await clearSystemFileClipboardIfCurrent(current);
  return { cleared: Boolean(result.cleared), hasFiles: !result.cleared && Boolean(result.sources?.some(source => fs.existsSync(source))) };
};

















const resolveProjectEntry = (workspacePath, status, projectName, relativePath = '') => {
  const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
  return projectVirtualPaths.resolve(projectPath, relativePath, { externalRootMode: 'target' }).physicalPath;
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
  projectVirtualPaths,
  recycleBinService,
  getMainWindow: () => mainWindow,
  getProjectPath,
  getRunConfig,
  processSupervisor,
  writeLog,
  pushUndoOperation,
  activeOperations: activeProjectFileOperations,
  backgroundTasks,
  getTelemetry: () => telemetryService,
});
registerBackgroundTasksIpc({ ipcMain, eventBus, backgroundTasks, getMainWindow: () => mainWindow });
app.whenReady().then(async () => {
  configMutationService = createConfigMutationService({ fs, crypto, getConfigPath, readSavedConfig, legacySettingsAdoptionsProvider: componentHostRegistry.list }); await configMutationService.ready; await configMutationService.adoptLegacySettings();
  registerComponentIconProtocol({ protocol, registry: componentHostRegistry, fs, writeLog });
  protocol.handle('photoflow-media', async request => {
    try {
      const token = new URL(request.url).pathname.replace(/^\//, '');
      const filePath = mediaAccessService.resolveToken(token);
      if (!filePath) return new Response('Not found', { status: 404 });
      return await createMediaFileResponse(filePath, request);
    } catch (error) {
      writeLog('warn', 'Media protocol request failed', { url: request.url, error: error.message || String(error) });
      return new Response('Bad request', { status: 400 });
    }
  });
  const deletedLogFiles = await cleanupExpiredLogs();
  const deletedCaptureTimeCacheFiles = await cleanupRetiredCaptureTimeCache({ app, fs, path, onError: nativeConsoleError });
  writeLog('info', 'Application started', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, deletedExpiredLogFiles: deletedLogFiles, deletedCaptureTimeCacheFiles });
  const savedStartupConfig = readSavedConfig() || {};
  const savedCacheDirectory = String(savedStartupConfig.mediaCache?.directory || '').trim();
  if (savedCacheDirectory) approvedMediaCacheDirectories.add(path.resolve(savedCacheDirectory));
  const startupMediaCacheConfig = {
    maxSizeGB: normalizeMediaCacheSizeGB(savedStartupConfig.mediaCache?.maxSizeGB),
    directory: savedCacheDirectory,
    autoCleanup30Days: savedStartupConfig.mediaCache?.autoCleanup30Days === true,
  };
  mediaRuntimeState.activeMediaCacheConfig = startupMediaCacheConfig;
  telemetryService = createTelemetryService({
    app,
    fs,
    path,
    crypto,
    getConfig: readSavedConfig,
    getLogDir,
    writeLog,
    apiBaseUrl: cloudConfig.apiBaseUrl,
    ingestKey: cloudConfig.ingestKey,
  });
  telemetryService.start();
  // IPC modules capture the BrowserWindow instance, so create it first but do
  // not load renderer code until every channel has been registered.
  createWindow(false);

  const { componentCapabilityBroker, componentInputGrants, componentNotificationService, clearComponentCapabilityState, clearComponentSecretData, abortComponentNetworkRequests } = createComponentHostCapabilityRuntime({
    ensureWorkspace,
    getWorkspaceDataRoot,
    resolveProjectEntry,
    versionService,
    IMAGE_EXTENSIONS,
    path, fs, crypto, getConfigPath, readSavedConfig, readConfig: configMutationService.read, mutateConfig: configMutationService.mutate,
    getProjectPath, dialog, mainWindow, mediaService, mediaRatingService, exiftool, shell, backgroundTasks,
    uniqueDestination, ensureTrackedVersionThumbnail, projectVirtualPaths, fileSystemService, runPythonJsonAction, extractVideoTimelineFrames, safeStorage, secretsRoot: path.join(app.getPath('userData'), 'component-secrets'),
    getBoundProject: (workspaceRoot, projectName) => workspaceCatalogs.get(path.resolve(workspaceRoot))?.byName.get(String(projectName || '').toLocaleLowerCase()) || null,
    RAW_EXTENSIONS, VIDEO_EXTENSIONS, IMAGE_PREVIEW_CONVERSION_EXTENSIONS,
  });
  componentServiceManager = new ComponentServiceManager({
    registry: componentHostRegistry,
    processSupervisor,
    capabilityBroker: componentCapabilityBroker,
    writeLog,
  });
  componentViewManager = new ComponentViewManager({
    WebContentsView,
    mainWindow,
    registry: componentHostRegistry,
    preloadPath: path.join(__dirname, 'component-preload.cjs'),
    ipcMain: electronIpcMain,
    serviceManager: componentServiceManager, capabilityBroker: componentCapabilityBroker, inputGrantService: componentInputGrants, notificationService: componentNotificationService, clearComponentCapabilityState,
    writeLog,
    onViewStackChanged: () => toastViewManager?.bringToFront(),
  });
  registerComponentHostIpc({ ipcMain, manager: componentViewManager, mainWindow });
  const componentRpcIpcMain = createComponentRpcIpcProxy({ ipcMain, manager: componentViewManager });

  registerSystemIpc({ Array, Boolean, BrowserWindow, Date, Error, JSON, Object, String, abortComponentNetworkRequests, app, approvedMediaCacheDirectories, backgroundTasks, checkForUpdates, clearComponentSecretData, componentCapabilityBroker, componentServiceManager, componentViewManager, configMutationService, console, crypto, dialog, domainCommandJournal, domainHealthService, exiftoolPath, findLatestPhotoshop, fs, getConfigPath, getLogDir, getResourceBirthdaysPath, getRunConfig, getUserBirthdaysPath, ipcMain: componentRpcIpcMain, mainWindow, mediaRuntimeState, openAllowedExternalUrl, path, pluginService, privacyService, process, processSupervisor, readSavedConfig, releaseWorkspaceWatchPath, screen, shell, spawn, suppressWorkspaceWatchPath, telemetryService, thumbnailService, undefined, writeLog });
  for (const descriptor of componentHostRegistry.list()) componentCapabilityBroker.assertCapabilities(descriptor);
  const workspaceIpcController = registerWorkspaceIpc({ Array, Boolean, CANCELLED_CODE, Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES, IMAGE_EXTENSIONS, Math, Number, Object, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, WORKSPACE_STATUSES, activeProjectFileOperations, acquireFileRootWatcher, app, assertDiskSpace, assertExistingInside, assertInside, assertRegularFile, assertUndoIdentity, backgroundTasks, cancelMediaTrackingScan, capturePathIdentity, cleanProjectName, clipboard, collectCopyPlan, copyFileAtomic, copyPlannedFiles, componentServiceManager, crypto, dialog, ensureWorkspace, extractVideoTimelineFrames, findLatestPhotoshop, fs, getProjectPath, getWorkspaceDataRoot, ipcMain: componentRpcIpcMain, mainWindow, mediaRuntimeState, mediaService, moveFileAtomic, movePathAtomic, publishPathNoClobber, mutateWorkspaceCatalog, normalizeMediaCacheSizeGB, path, pathExists, pluginService, projectVirtualPaths, pushUndoOperation, removeUndoOperation, reconcileWorkspaceCatalog, recycleBinService, refreshWorkspaceCatalog, releaseFileRootWatcher, releaseWorkspaceWatchPath, removeCopiedSources, renameHistory, resolveProjectEntry, resolveWorkspaceRoot, resumeFileRootWatcher, runPythonJsonAction, samePathIdentity, scheduleMediaTrackingScan, shell, shellNewService, spawn, suspendFileRootWatcher, suppressWorkspaceWatchPath, telemetryService, thumbnailService, throwIfCancelled, undefined, uniqueDestination, versionService, watchWorkspace, workspaceCatalogs, workspaceMaintenanceRepository, workspaceRepository, writeLog });
  registerFileOperationsIpc({ Array, Boolean, BrowserWindow, CANCELLED_CODE, Date, Error, IMAGE_EXTENSIONS, Math, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, activeProjectFileOperations, app, assertDiskSpace, assertExistingInside, assertInside, backgroundTasks, cancelMediaTrackingScan, cancelSystemFileCut, capturePathIdentity, clearSystemFileClipboardIfCurrent, clipboard, collectCopyPlan, copyFileAtomic, copyPlannedFiles, crypto, ensureWorkspace, fileOperationState, fs, getProjectPath, ipcMain, movePathAtomic, publishPathNoClobber, nativeImage, path, process, projectVirtualPaths, pushUndoOperation, readSystemFileClipboard, recycleBinService, refreshManagedExternalWatchers: workspaceIpcController.refreshManagedExternalWatchers, releaseWorkspaceWatchPath, removeCopiedSources, removeCreatedPasteTargets, resumeToastViewAfterNativeDrag, samePathIdentity, screen, selectionService, suspendToastViewForNativeDrag, suppressWorkspaceWatchPath, throwIfCancelled, uniqueDestination, versionService, workspaceRepository, writeLog, writeSystemFileClipboard });
  registerMediaIpc({ Buffer, Date, Error, IMAGE_EXTENSIONS, IMAGE_PREVIEW_CONVERSION_EXTENSIONS, Math, Number, Object, PRIORITY, Promise, RAW_EXTENSIONS, String, VIDEO_EXTENSIONS, approvedMediaCacheDirectories, backgroundTasks, clearTimeout, convertedImagePreviewPath, dialog, exiftool, findImportedVideoPreview, flattenMetadataValue, fs, getMediaCacheDir, ipcMain, mainWindow, mediaCacheIndexes, mediaMetadataCache, mediaRuntimeState, mediaService, normalizeMediaCacheSizeGB, path, rawOrientationCorrection, rawPreviewPath, refreshMediaCacheIndex, setTimeout, thumbnailService, trimMediaCache, undefined, writeLog });
  registerMediaRatingIpc({ IMAGE_EXTENSIONS, RAW_EXTENSIONS, ensureWorkspace, getProjectPath, ipcMain, mediaRatingService, mediaService, path, refreshWorkspaceCatalog, workspaceCatalogs, writeLog });
  registerVersionIpc({ Array, Boolean, Error, IMAGE_EXTENSIONS, JSON, Math, Number, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, backgroundTasks, buildVersionBatchImportKey, cleanVersionName, copyFileAtomic, crypto, dialog, ensureTrackedVersionThumbnail, ensureWorkspace, fs, getProjectPath, getWorkspaceDataRoot, ipcMain: componentRpcIpcMain, mainWindow, mediaRatingService, mediaScanService, mediaService, path, projectVirtualPaths, recycleBinService, refreshManagedExternalWatchers: workspaceIpcController.refreshManagedExternalWatchers, refreshWorkspaceCatalog, releaseWorkspaceWatchPath, resolveProjectEntry, runPythonEventAction, scheduleMediaTrackingScan, supportedVersionFileKind, suppressWorkspaceWatchPath, thumbnailService, trackingScanService, undefined, uniqueDestination, versionService, workspaceCatalogs, writeLog });
  registerSelectionIpc({ ipcMain, path, fs, selectionService, workspaceCatalogs });
  registerVideoPlaybackIpc({ BrowserWindow, app, crypto, dialog, fs, ipcMain, mediaService, path, pluginService, processSupervisor, screen, spawn, writeLog });
  const credentialService = createCredentialService({ writeLog });
  const recoveryClients = [
    workspaceDatabase,
    operationsDatabase,
    workspaceMaintenanceDatabase,
    mediaDatabase,
    mediaInteractionDatabase,
    mediaScanDatabase,
    trackingScanDatabase,
  ];
  let recoveryClientUsers = 0;
  let recoveryClientTransition = Promise.resolve();
  const runRecoveryClientTransition = worker => {
    const result = recoveryClientTransition.then(worker, worker);
    recoveryClientTransition = result.catch(() => undefined);
    return result;
  };
  const prepareDomainRecovery = () => runRecoveryClientTransition(async () => {
    if (recoveryClientUsers === 0) {
      const results = await Promise.allSettled(recoveryClients.map(client => client.suspend()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) {
        await Promise.allSettled(recoveryClients.map(client => Promise.resolve().then(() => client.resume())));
        throw new AggregateError(failures, '数据库 client 未能全部退出，已取消恢复');
      }
    }
    recoveryClientUsers += 1;
    let released = false;
    return () => runRecoveryClientTransition(async () => {
      if (released) return;
      released = true;
      recoveryClientUsers = Math.max(0, recoveryClientUsers - 1);
      if (recoveryClientUsers > 0) return;
      const resumes = await Promise.allSettled(recoveryClients.map(client => Promise.resolve().then(() => client.resume())));
      const failures = resumes.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, '数据库恢复完成，但部分 client 未能恢复');
    });
  });
  const backupService = createBackupService({ app, backgroundTasks, credentialService, configMutationService, getConfigPath, getUserBirthdaysPath, getManagedExternalLinkRegistryPath: () => managedExternalLinkRegistryPath, getManagedExternalLinks: projectRoot => projectVirtualPaths.listManagedExternalLinks(projectRoot), getWorkspaceDatabasePath, getWorkspaceOperationsDatabasePath, getWorkspaceMediaDatabasePath, getWorkspaceVersioningDatabasePath, getWorkspaceDataRoot, getWorkspaceDataRootForKey: workspaceStorageKeyService.getDataRootForKey, bindWorkspaceStorageKeyForRestore: workspaceStorageKeyService.bindForRestore, workspaceSqliteCoordinator, prepareDomainRecovery, readSavedConfig, runPythonJsonAction, shell, writeLog, componentServiceManager });
  registerBackupIpc({ backupService, credentialService, dialog, ipcMain, getMainWindow: () => mainWindow, shell, writeLog });
  const archiveService = createArchiveService({ backgroundTasks, movePathAtomic, readSavedConfig, workspaceRepository, writeLog });
  registerArchiveIpc({ archiveService, dialog, ipcMain, getMainWindow: () => mainWindow, shell, writeLog });
  const storageUsageService = createStorageUsageService({ app, backgroundTasks, eventBus, getWorkspaceDatabasePath, getWorkspaceDataRoot, readSavedConfig, resolveMediaCacheDirectory: resolveMediaCacheDir, writeLog });
  registerStorageUsageIpc({ ipcMain, storageUsageService, getMainWindow: () => mainWindow });
  thumbnailService.activateStartupRecovery();
  const startupRecovery = thumbnailService.ensureStartupRecovery(startupMediaCacheConfig);
  await startupRecovery.admitted.catch(error => {
    writeLog('error', 'Thumbnail cache startup recovery failed', { error: error.message || String(error), code: error.code });
  });
  void startupRecovery.completion?.catch(error => {
    writeLog('error', 'Thumbnail cache startup recovery failed after admission', { error: error.message || String(error), code: error.code });
  });
  const smokeRecoveryResult = smokeTestEnabled && startupRecovery.completion
    ? await startupRecovery.completion
    : null;
  // A fast renderer can invoke preload APIs immediately on warm starts.
  if (smokeTestEnabled) {
    await runElectronSmokeProbe({ app, mainWindow, rendererEntryFile, loadRenderer: loadMainWindowRenderer, recoveryResult: smokeRecoveryResult, processSupervisor });
  } else loadMainWindowRenderer();

  setTimeout(checkForUpdates, 3000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

registerConfigDrainBeforeQuit({ app, getConfigMutationService: () => configMutationService, writeLog, onQuit: () => {
  destroyToastViewManager();
  componentViewManager?.destroy();
  void componentServiceManager?.destroy();
  telemetryService?.stop();
  pluginService?.stop?.();
  stopWorkspaceWatcher(true);
  stopFileRootWatchers();
  stopShellThumbnailProcess();
  workspaceDatabase.stop();
  operationsDatabase.stop();
  workspaceMaintenanceDatabase.stop();
  mediaDatabase.stop();
  mediaInteractionDatabase.stop();
  mediaScanDatabase.stop();
  trackingScanDatabase.stop();
  imageThumbnailRuntime.stop();
  thumbnailService?.stop();
  backgroundTasks.stop();
  domainCommandJournal.stop();
  processSupervisor.stopAll();
  eventBus.clear();
  void exiftool.end().catch(() => undefined);
} });

app.on('window-all-closed', () => {
  writeLog('info', 'All application windows closed');
  if (process.platform !== 'darwin') app.quit();
});
process.on('uncaughtException', (error) => {
  writeLog('error', 'Uncaught main-process exception', error);
  telemetryService?.reportCrash('main_uncaught_exception', error);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-error', error.message || '主进程发生未知错误');
});

process.on('unhandledRejection', (reason) => {
  writeLog('error', 'Unhandled main-process promise rejection', reason);
  telemetryService?.reportCrash('main_unhandled_rejection', reason);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-error', reason instanceof Error ? reason.message : String(reason || '后台操作失败'));
});
