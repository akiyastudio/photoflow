const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ToastOverlayManager, validAction, validSnapshot } = require('../electron/services/toast-overlay-manager.cjs');

class FakeContents extends EventEmitter {
  constructor(id) { super(); this.id = id; this.sent = []; this.session = { setPermissionCheckHandler: handler => { this.permissionCheck = handler; }, setPermissionRequestHandler: handler => { this.permissionRequest = handler; } }; }
  isDestroyed() { return false; }
  send(...args) { this.sent.push(args); }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
}
class FakeWindow extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = new FakeContents(2); this.bounds = []; this.ignored = []; this.visible = false; this.destroyed = false; FakeWindow.last = this; }
  setMenuBarVisibility() {}
  setIgnoreMouseEvents(...args) { this.ignored.push(args); }
  loadFile(file) { this.loaded = file; return Promise.resolve(); }
  loadURL(url) { this.loaded = url; return Promise.resolve(); }
  setBounds(bounds) { this.bounds.push(bounds); }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

const mainContents = new FakeContents(1); const parent = new EventEmitter();
Object.assign(parent, { webContents: mainContents, currentBounds: { x: -1920, y: 120, width: 1536, height: 864 }, minimized: false, visible: true,
  getBounds() { return this.currentBounds; }, isMinimized() { return this.minimized; }, isVisible() { return this.visible; }, isDestroyed() { return false; } });
const handlers = new Map(); const listeners = new Map();
const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name), on: (name, handler) => listeners.set(name, handler), removeAllListeners: name => listeners.delete(name) };
const manager = new ToastOverlayManager({ BrowserWindow: FakeWindow, mainWindow: parent, ipcMain, preloadPath: 'overlay-preload.cjs', rendererFile: 'toast-overlay.html' });
const overlay = FakeWindow.last; overlay.webContents.emit('did-finish-load');
assert.deepStrictEqual(overlay.bounds.at(-1), parent.currentBounds, 'overlay uses Electron DIP screen coordinates unchanged on a negative-coordinate secondary display');
parent.currentBounds = { x: 240, y: 80, width: 1280, height: 720 }; parent.emit('resize');
assert.deepStrictEqual(overlay.bounds.at(-1), parent.currentBounds, 'overlay follows parent resize/move bounds without scale conversion');
parent.minimized = true; parent.emit('minimize'); assert.equal(overlay.visible, false, 'overlay hides with minimized parent');
parent.minimized = false; parent.emit('restore'); assert.equal(overlay.visible, true, 'overlay restores without activation');
const update = handlers.get('toast-overlay:update');
assert.throws(() => update({ sender: new FakeContents(3) }, { html: '', dark: false }), /Unauthorized/);
assert.deepStrictEqual(update({ sender: mainContents }, { html: '<div>safe</div>', dark: false }), { success: true });
assert.deepStrictEqual(overlay.webContents.sent.at(-1), ['toast-overlay:snapshot', { html: '<div>safe</div>', dark: false }]);
mainContents.emit('did-start-loading');
assert.deepStrictEqual(overlay.webContents.sent.at(-1), ['toast-overlay:snapshot', { html: '', dark: false }], 'main renderer reload immediately clears stale overlay markup');
listeners.get('toast-overlay:pointer-interactive')({ sender: overlay.webContents }, true);
assert.deepStrictEqual(overlay.ignored.at(-1), [false, { forward: true }], 'toast cards enable native pointer interaction');
listeners.get('toast-overlay:pointer-interactive')({ sender: overlay.webContents }, false);
assert.deepStrictEqual(overlay.ignored.at(-1), [true, { forward: true }], 'transparent gaps pass pointers through');
listeners.get('toast-overlay:action')({ sender: overlay.webContents }, { action: 'notice-dismiss', id: '7' });
assert.deepStrictEqual(mainContents.sent.at(-1), ['toast-overlay:action', { action: 'notice-dismiss', id: '7' }]);
assert(validSnapshot({ html: '', dark: true }) && !validSnapshot({ html: '', dark: 'yes' }));
assert(validAction({ action: 'task-cancel', id: 'task-1' }) && !validAction({ action: 'open-url', id: 'x' }));

const html = fs.readFileSync(path.join(__dirname, '..', 'toast-overlay.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'toast-overlay.ts'), 'utf8');
assert(html.includes('Content-Security-Policy') && html.includes("default-src 'none'") && html.includes("object-src 'none'"), 'overlay has a deny-by-default CSP');
assert(renderer.includes('ALLOWED_TAGS') && renderer.includes('sanitizeHostMarkup') && !renderer.includes('root.innerHTML'), 'host DOM mirror is sanitized through a strict allowlist');
manager.destroy(); assert.equal(overlay.destroyed, true); assert.equal(handlers.size, 0); assert.equal(listeners.size, 0);
console.log('toast overlay manager tests passed');
