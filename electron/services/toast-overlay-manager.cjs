const validSnapshot = value => value && typeof value === 'object' && !Array.isArray(value)
  && typeof value.html === 'string' && value.html.length <= 250000
  && typeof value.dark === 'boolean';

const validAction = value => value && typeof value === 'object' && !Array.isArray(value)
  && ['notice-dismiss', 'task-dismiss', 'task-minimize', 'task-pause', 'task-continue', 'task-cancel'].includes(value.action)
  && typeof value.id === 'string' && value.id.length >= 1 && value.id.length <= 200;

const TOAST_OVERLAY_MAX_WIDTH = 544;
const TOAST_OVERLAY_MAX_HEIGHT = 512;
const TOAST_OVERLAY_TOP_OFFSET = 8;
const TOAST_OVERLAY_PARENT_VERTICAL_RESERVE = 108;
const finiteInteger = value => Number.isInteger(value) && Number.isFinite(value);
const validLayout = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.visible !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
  const fields = ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'];
  if (!fields.every(field => finiteInteger(value[field]))) return false;
  if (!value.visible) return value.x === 0 && value.y === 0 && value.width === 0 && value.height === 0
    && value.viewportWidth >= 0 && value.viewportWidth <= TOAST_OVERLAY_MAX_WIDTH
    && value.viewportHeight >= 0 && value.viewportHeight <= TOAST_OVERLAY_MAX_HEIGHT;
  return value.x >= 0 && value.y >= 0 && value.width >= 1 && value.height >= 1
    && value.viewportWidth >= value.width && value.viewportWidth <= TOAST_OVERLAY_MAX_WIDTH
    && value.viewportHeight >= value.height && value.viewportHeight <= TOAST_OVERLAY_MAX_HEIGHT
    && value.x + value.width <= value.viewportWidth && value.y + value.height <= value.viewportHeight;
};

class ToastOverlayManager {
  constructor({ BrowserWindow, mainWindow, ipcMain, preloadPath, rendererFile, developmentRendererUrl = '', screen, writeLog = () => undefined }) {
    this.BrowserWindow = BrowserWindow;
    this.mainWindow = mainWindow;
    this.ipcMain = ipcMain;
    this.preloadPath = preloadPath;
    this.rendererFile = rendererFile;
    this.developmentRendererUrl = developmentRendererUrl;
    this.screen = screen;
    this.writeLog = writeLog;
    this.overlayWindow = null;
    this.ready = false;
    this.snapshotRevision = 0;
    this.snapshot = { html: '', dark: false, revision: this.snapshotRevision };
    this.layout = null;
    this.nativeDragSuspendCount = 0;
    this.parentListenersRegistered = false;
    this.onParentBoundsChanged = () => this.syncBounds();
    this.onMainRendererReload = () => { this.snapshot = { html: '', dark: false, revision: ++this.snapshotRevision }; this.layout = null; this.syncBounds(); this.sendSnapshot(); };
    this.onDisplayMetricsChanged = () => this.syncBounds();
    this.registerIpc();
    this.create();
  }

  registerIpc() {
    this.ipcMain.handle('toast-overlay:update', (event, snapshot) => {
      if (event.sender !== this.mainWindow?.webContents) throw new Error('Unauthorized toast overlay sender');
      if (!validSnapshot(snapshot)) throw new Error('Invalid toast overlay snapshot');
      this.snapshot = Object.freeze({ html: snapshot.html, dark: snapshot.dark, revision: ++this.snapshotRevision });
      this.layout = null;
      this.syncBounds();
      this.sendSnapshot();
      return { success: true };
    });
    this.ipcMain.handle('toast-overlay:layout', (event, layout) => {
      if (event.sender !== this.overlayWindow?.webContents) throw new Error('Unauthorized toast overlay layout sender');
      if (!validLayout(layout)) throw new Error('Invalid toast overlay layout');
      if (layout.revision !== this.snapshot.revision) return { success: false, stale: true };
      this.layout = layout.visible ? Object.freeze({ ...layout }) : null;
      this.syncBounds();
      return { success: true };
    });
    this.ipcMain.on('toast-overlay:pointer-interactive', (event, interactive) => {
      if (event.sender !== this.overlayWindow?.webContents || typeof interactive !== 'boolean') return;
      this.overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
    });
    this.ipcMain.on('toast-overlay:action', (event, action) => {
      if (event.sender !== this.overlayWindow?.webContents || !validAction(action)) return;
      if (!this.mainWindow?.isDestroyed() && !this.mainWindow.webContents.isDestroyed()) {
        this.mainWindow.webContents.send('toast-overlay:action', Object.freeze({ action: action.action, id: action.id }));
        this.restoreMainWindowFocus();
      }
    });
  }

  restoreMainWindowFocus() {
    const target = this.mainWindow;
    if (!target || target.isDestroyed() || target.isMinimized() || !target.isVisible()) return false;
    try {
      target.focus();
      target.webContents.focus?.();
      return true;
    } catch {
      return false;
    }
  }

  suspendForNativeDrag() {
    this.nativeDragSuspendCount += 1;
    if (this.nativeDragSuspendCount !== 1) return;
    const overlay = this.overlayWindow;
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
  }

  resumeAfterNativeDrag() {
    this.nativeDragSuspendCount = Math.max(0, this.nativeDragSuspendCount - 1);
    if (this.nativeDragSuspendCount !== 0) return;
    if (!this.overlayWindow && this.mainWindow && !this.mainWindow.isDestroyed()) this.create();
    else this.syncBounds();
  }

  create() {
    if (this.nativeDragSuspendCount > 0 || this.overlayWindow || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    const overlay = new this.BrowserWindow({
      parent: this.mainWindow,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: { preload: this.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
    });
    this.overlayWindow = overlay;
    overlay.setMenuBarVisibility(false);
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', event => event.preventDefault());
    overlay.webContents.on('will-attach-webview', event => event.preventDefault());
    overlay.webContents.session.setPermissionCheckHandler(() => false);
    overlay.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    overlay.webContents.on('did-finish-load', () => { this.ready = true; this.layout = null; this.syncBounds(); this.sendSnapshot(); });
    overlay.webContents.on('render-process-gone', (_event, details) => { this.ready = false; this.layout = null; overlay.hide(); this.writeLog('error', 'Toast overlay renderer exited', { reason: details?.reason, exitCode: details?.exitCode }); if (!overlay.isDestroyed() && typeof overlay.reload === 'function') void overlay.reload(); });
    overlay.once('closed', () => { this.ready = false; this.layout = null; this.overlayWindow = null; });
    if (!this.parentListenersRegistered) {
      for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) this.mainWindow.on(event, this.onParentBoundsChanged);
      this.mainWindow.on('show', this.onParentBoundsChanged);
      this.mainWindow.on('hide', this.onParentBoundsChanged);
      this.mainWindow.webContents.on('did-start-loading', this.onMainRendererReload);
      this.mainWindow.webContents.on('render-process-gone', this.onMainRendererReload);
      this.screen?.on?.('display-metrics-changed', this.onDisplayMetricsChanged);
      this.parentListenersRegistered = true;
    }
    this.syncBounds();
    if (this.developmentRendererUrl) void overlay.loadURL(`${this.developmentRendererUrl.replace(/\/$/, '')}/toast-overlay.html`);
    else void overlay.loadFile(this.rendererFile);
  }

  syncBounds() {
    const overlay = this.overlayWindow;
    if (!overlay || overlay.isDestroyed() || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    const parent = this.mainWindow.getBounds();
    const maxWidth = Math.max(1, Math.min(TOAST_OVERLAY_MAX_WIDTH, parent.width));
    const maxHeight = Math.max(1, Math.min(TOAST_OVERLAY_MAX_HEIGHT, parent.height - TOAST_OVERLAY_PARENT_VERTICAL_RESERVE));
    const measurementBounds = {
      x: parent.x + Math.floor((parent.width - maxWidth) / 2),
      y: parent.y + Math.min(TOAST_OVERLAY_TOP_OFFSET, Math.max(0, parent.height - 1)),
      width: maxWidth,
      height: maxHeight,
    };
    const layout = this.layout;
    if (this.nativeDragSuspendCount > 0 || !layout || !this.ready || !this.snapshot.html.trim() || !this.mainWindow.isVisible() || this.mainWindow.isMinimized()) {
      overlay.setBounds(measurementBounds, false);
      overlay.hide();
      return;
    }
    const viewportWidth = Math.min(layout.viewportWidth, maxWidth);
    const viewportHeight = Math.min(layout.viewportHeight, maxHeight);
    const width = Math.min(layout.width, viewportWidth, maxWidth);
    const height = Math.min(layout.height, viewportHeight, maxHeight);
    const viewportX = parent.x + Math.floor((parent.width - viewportWidth) / 2);
    const maxX = parent.x + parent.width - width;
    const maxY = parent.y + Math.min(parent.height, TOAST_OVERLAY_TOP_OFFSET + maxHeight) - height;
    overlay.setBounds({
      x: Math.max(parent.x, Math.min(maxX, viewportX + layout.x)),
      y: Math.max(parent.y, Math.min(maxY, parent.y + TOAST_OVERLAY_TOP_OFFSET + layout.y)),
      width,
      height,
    }, false);
    overlay.showInactive();
  }

  sendSnapshot() {
    const overlay = this.overlayWindow;
    if (!this.ready || !overlay || overlay.isDestroyed() || overlay.webContents.isDestroyed()) return;
    overlay.webContents.send('toast-overlay:snapshot', this.snapshot);
  }

  destroy() {
    if (this.parentListenersRegistered) {
      for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen', 'show', 'hide']) this.mainWindow?.removeListener?.(event, this.onParentBoundsChanged);
      this.mainWindow?.webContents?.removeListener?.('did-start-loading', this.onMainRendererReload);
      this.mainWindow?.webContents?.removeListener?.('render-process-gone', this.onMainRendererReload);
      this.screen?.removeListener?.('display-metrics-changed', this.onDisplayMetricsChanged);
      this.parentListenersRegistered = false;
    }
    this.ipcMain.removeHandler('toast-overlay:update');
    this.ipcMain.removeHandler('toast-overlay:layout');
    this.ipcMain.removeAllListeners('toast-overlay:pointer-interactive');
    this.ipcMain.removeAllListeners('toast-overlay:action');
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) this.overlayWindow.destroy();
    this.overlayWindow = null; this.ready = false;
  }
}

module.exports = { TOAST_OVERLAY_MAX_HEIGHT, TOAST_OVERLAY_MAX_WIDTH, TOAST_OVERLAY_PARENT_VERTICAL_RESERVE, TOAST_OVERLAY_TOP_OFFSET, ToastOverlayManager, validAction, validLayout, validSnapshot };
