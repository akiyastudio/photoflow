const TOAST_VIEW_MAX_ITEMS = 12;
const TOAST_VIEW_MAX_WIDTH = 720;
const TOAST_VIEW_MAX_HEIGHT = 2000;
const TOAST_VIEW_ACTIONS = new Set(['notice-dismiss', 'task-dismiss', 'task-minimize', 'task-pause', 'task-continue', 'task-cancel']);

const finiteInteger = value => Number.isSafeInteger(value);
const validSnapshot = value => value && typeof value === 'object' && !Array.isArray(value)
  && finiteInteger(value.revision) && value.revision >= 0
  && typeof value.dark === 'boolean'
  && finiteInteger(value.top) && value.top >= 0 && value.top <= 2000
  && finiteInteger(value.width) && value.width >= 0 && value.width <= TOAST_VIEW_MAX_WIDTH
  && finiteInteger(value.height) && value.height >= 0 && value.height <= TOAST_VIEW_MAX_HEIGHT
  && Array.isArray(value.notices) && value.notices.length <= TOAST_VIEW_MAX_ITEMS
  && Array.isArray(value.tasks) && value.tasks.length <= 4
  && finiteInteger(value.overflowCount) && value.overflowCount >= 0 && value.overflowCount <= 10000;

const validAction = value => value && typeof value === 'object' && !Array.isArray(value)
  && TOAST_VIEW_ACTIONS.has(value.action)
  && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200;

class ToastViewManager {
  constructor({ WebContentsView, mainWindow, ipcMain, preloadPath, rendererFile, developmentRendererUrl = '', writeLog = () => undefined }) {
    this.WebContentsView = WebContentsView;
    this.mainWindow = mainWindow;
    this.ipcMain = ipcMain;
    this.preloadPath = preloadPath;
    this.rendererFile = rendererFile;
    this.developmentRendererUrl = developmentRendererUrl;
    this.writeLog = writeLog;
    this.view = null;
    this.ready = false;
    this.nativeDragDepth = 0;
    this.renderedHeight = 0;
    this.snapshot = { revision: 0, dark: false, top: 40, width: 0, height: 0, notices: [], tasks: [], overflowCount: 0 };
    this.onWindowResize = () => this.syncBounds();
    this.onUpdate = (event, snapshot) => {
      if (event.sender !== this.mainWindow?.webContents) throw new Error('Unauthorized toast view sender');
      if (!validSnapshot(snapshot)) throw new Error('Invalid toast view snapshot');
      this.snapshot = Object.freeze({ ...snapshot, notices: Object.freeze([...snapshot.notices]), tasks: Object.freeze([...snapshot.tasks]) });
      this.renderedHeight = snapshot.height;
      this.sendSnapshot();
      this.syncBounds();
      return { success: true };
    };
    this.onReady = event => {
      if (event.sender !== this.view?.webContents) return;
      this.ready = true;
      this.sendSnapshot();
      this.syncBounds();
    };
    this.onLayout = (event, layout) => {
      if (event.sender !== this.view?.webContents || !layout || layout.revision !== this.snapshot.revision) return;
      const height = Number(layout.height);
      if (!finiteInteger(height) || height < 0 || height > TOAST_VIEW_MAX_HEIGHT) return;
      if (height === this.renderedHeight) return;
      this.renderedHeight = height;
      this.syncBounds();
    };
    this.onAction = (event, action) => {
      if (event.sender !== this.view?.webContents || !validAction(action)) return;
      if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.webContents.isDestroyed()) return;
      this.mainWindow.webContents.send('toast-view:action', Object.freeze({ action: action.action, id: action.id }));
      this.mainWindow.webContents.focus();
    };
    this.registerIpc();
    this.create();
  }

  registerIpc() {
    this.ipcMain.handle('toast-view:update', this.onUpdate);
    this.ipcMain.on('toast-view:ready', this.onReady);
    this.ipcMain.on('toast-view:layout', this.onLayout);
    this.ipcMain.on('toast-view:action', this.onAction);
  }

  create() {
    const view = new this.WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
      },
    });
    this.view = view;
    view.setBackgroundColor('#00000000');
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.on('preload-error', (_event, _preloadPath, error) => this.writeLog('error', 'Toast view preload failed', { error: error?.stack || error?.message || String(error) }));
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame !== false) this.writeLog('error', 'Toast view failed to load', { errorCode, errorDescription, validatedUrl });
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      this.ready = false;
      view.setVisible(false);
      this.writeLog('error', 'Toast view renderer exited', { reason: details?.reason, exitCode: details?.exitCode });
      if (!view.webContents.isDestroyed()) void view.webContents.reload();
    });
    this.mainWindow.contentView.addChildView(view);
    this.mainWindow.on('resize', this.onWindowResize);
    if (this.developmentRendererUrl) void view.webContents.loadURL(`${this.developmentRendererUrl.replace(/\/$/, '')}/toast-view.html`);
    else void view.webContents.loadFile(this.rendererFile);
  }

  sendSnapshot() {
    if (!this.ready || !this.view || this.view.webContents.isDestroyed()) return;
    this.view.webContents.send('toast-view:snapshot', this.snapshot);
  }

  syncBounds() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    const content = this.mainWindow.getContentBounds();
    const width = Math.min(this.snapshot.width, Math.max(0, content.width - 16));
    const maximumHeight = Math.max(0, content.height - this.snapshot.top - 8);
    const height = Math.min(this.renderedHeight, maximumHeight);
    if (!this.ready || this.nativeDragDepth > 0 || width <= 0 || height <= 0) {
      view.setVisible(false);
      return;
    }
    view.setBounds({ x: Math.max(0, Math.round((content.width - width) / 2)), y: this.snapshot.top, width, height });
    view.setVisible(true);
  }

  bringToFront() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    try { this.mainWindow.contentView.removeChildView(view); } catch { /* already detached */ }
    this.mainWindow.contentView.addChildView(view);
    this.syncBounds();
  }

  suspendForNativeDrag() {
    this.nativeDragDepth += 1;
    this.view?.setVisible(false);
  }

  resumeAfterNativeDrag() {
    this.nativeDragDepth = Math.max(0, this.nativeDragDepth - 1);
    if (this.nativeDragDepth === 0) this.syncBounds();
  }

  destroy() {
    this.ipcMain.removeHandler('toast-view:update');
    this.ipcMain.removeListener('toast-view:ready', this.onReady);
    this.ipcMain.removeListener('toast-view:layout', this.onLayout);
    this.ipcMain.removeListener('toast-view:action', this.onAction);
    this.mainWindow?.removeListener('resize', this.onWindowResize);
    const view = this.view;
    this.view = null;
    this.ready = false;
    if (!view) return;
    try { this.mainWindow.contentView.removeChildView(view); } catch { /* already detached */ }
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }
}

module.exports = { ToastViewManager, validAction, validSnapshot };
