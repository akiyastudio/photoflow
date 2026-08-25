const validSnapshot = value => value && typeof value === 'object' && !Array.isArray(value)
  && typeof value.html === 'string' && value.html.length <= 250000
  && typeof value.dark === 'boolean';

const validAction = value => value && typeof value === 'object' && !Array.isArray(value)
  && ['notice-dismiss', 'task-dismiss', 'task-minimize', 'task-pause', 'task-continue', 'task-cancel'].includes(value.action)
  && typeof value.id === 'string' && value.id.length >= 1 && value.id.length <= 200;

class ToastOverlayManager {
  constructor({ BrowserWindow, mainWindow, ipcMain, preloadPath, rendererFile, developmentRendererUrl = '', writeLog = () => undefined }) {
    this.BrowserWindow = BrowserWindow;
    this.mainWindow = mainWindow;
    this.ipcMain = ipcMain;
    this.preloadPath = preloadPath;
    this.rendererFile = rendererFile;
    this.developmentRendererUrl = developmentRendererUrl;
    this.writeLog = writeLog;
    this.overlayWindow = null;
    this.ready = false;
    this.snapshot = { html: '', dark: false };
    this.onParentBoundsChanged = () => this.syncBounds();
    this.onMainRendererReload = () => { this.snapshot = { html: '', dark: false }; this.sendSnapshot(); };
    this.registerIpc();
    this.create();
  }

  registerIpc() {
    this.ipcMain.handle('toast-overlay:update', (event, snapshot) => {
      if (event.sender !== this.mainWindow?.webContents) throw new Error('Unauthorized toast overlay sender');
      if (!validSnapshot(snapshot)) throw new Error('Invalid toast overlay snapshot');
      this.snapshot = Object.freeze({ html: snapshot.html, dark: snapshot.dark });
      this.sendSnapshot();
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

  create() {
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
    overlay.webContents.on('did-finish-load', () => { this.ready = true; this.syncBounds(); this.sendSnapshot(); if (!overlay.isDestroyed()) overlay.showInactive(); });
    overlay.webContents.on('render-process-gone', (_event, details) => { this.ready = false; this.writeLog('error', 'Toast overlay renderer exited', { reason: details?.reason, exitCode: details?.exitCode }); if (!overlay.isDestroyed() && typeof overlay.reload === 'function') void overlay.reload(); });
    overlay.once('closed', () => { this.ready = false; this.overlayWindow = null; });
    for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) this.mainWindow.on(event, this.onParentBoundsChanged);
    this.mainWindow.on('show', this.onParentBoundsChanged);
    this.mainWindow.on('hide', this.onParentBoundsChanged);
    this.mainWindow.webContents.on('did-start-loading', this.onMainRendererReload);
    this.mainWindow.webContents.on('render-process-gone', this.onMainRendererReload);
    if (this.developmentRendererUrl) void overlay.loadURL(`${this.developmentRendererUrl.replace(/\/$/, '')}/toast-overlay.html`);
    else void overlay.loadFile(this.rendererFile);
  }

  syncBounds() {
    const overlay = this.overlayWindow;
    if (!overlay || overlay.isDestroyed() || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    overlay.setBounds(this.mainWindow.getBounds(), false);
    if (this.mainWindow.isVisible() && !this.mainWindow.isMinimized() && this.ready) overlay.showInactive(); else overlay.hide();
  }

  sendSnapshot() {
    const overlay = this.overlayWindow;
    if (!this.ready || !overlay || overlay.isDestroyed() || overlay.webContents.isDestroyed()) return;
    overlay.webContents.send('toast-overlay:snapshot', this.snapshot);
  }

  destroy() {
    for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen', 'show', 'hide']) this.mainWindow?.removeListener?.(event, this.onParentBoundsChanged);
    this.mainWindow?.webContents?.removeListener?.('did-start-loading', this.onMainRendererReload);
    this.mainWindow?.webContents?.removeListener?.('render-process-gone', this.onMainRendererReload);
    this.ipcMain.removeHandler('toast-overlay:update');
    this.ipcMain.removeAllListeners('toast-overlay:pointer-interactive');
    this.ipcMain.removeAllListeners('toast-overlay:action');
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) this.overlayWindow.destroy();
    this.overlayWindow = null; this.ready = false;
  }
}

module.exports = { ToastOverlayManager, validAction, validSnapshot };
