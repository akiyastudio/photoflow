const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ts = require('typescript');
const {
  TOAST_OVERLAY_MAX_HEIGHT,
  TOAST_OVERLAY_MAX_WIDTH,
  TOAST_OVERLAY_PARENT_VERTICAL_RESERVE,
  TOAST_OVERLAY_TOP_OFFSET,
  ToastOverlayManager,
  validAction,
  validLayout,
  validSnapshot,
} = require('../electron/services/toast-overlay-manager.cjs');

class FakeContents extends EventEmitter {
  constructor(id) { super(); this.id = id; this.sent = []; this.reloadCount = 0; this.session = { setPermissionCheckHandler: handler => { this.permissionCheck = handler; }, setPermissionRequestHandler: handler => { this.permissionRequest = handler; } }; }
  isDestroyed() { return false; }
  send(...args) { this.sent.push(args); }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
}
class FakeWindow extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = new FakeContents(2); this.bounds = []; this.ignored = []; this.visible = false; this.destroyed = false; this.reloadCount = 0; FakeWindow.last = this; }
  setMenuBarVisibility() {}
  setIgnoreMouseEvents(...args) { this.ignored.push(args); }
  loadFile(file) { this.loaded = file; return Promise.resolve(); }
  loadURL(url) { this.loaded = url; return Promise.resolve(); }
  setBounds(bounds) { this.bounds.push(bounds); }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  reload() { this.reloadCount += 1; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

const mainContents = new FakeContents(1);
const parent = new EventEmitter();
Object.assign(parent, {
  webContents: mainContents,
  currentBounds: { x: -1920, y: 120, width: 1536, height: 864 },
  minimized: false,
  visible: true,
  focusCount: 0,
  getBounds() { return this.currentBounds; },
  isMinimized() { return this.minimized; },
  isVisible() { return this.visible; },
  isDestroyed() { return false; },
  focus() { this.focusCount += 1; },
});
mainContents.focusCount = 0;
mainContents.focus = () => { mainContents.focusCount += 1; };
const handlers = new Map();
const listeners = new Map();
const ipcMain = {
  handle: (name, handler) => { if (handlers.has(name)) throw new Error(`duplicate handler: ${name}`); handlers.set(name, handler); },
  removeHandler: name => handlers.delete(name),
  on: (name, handler) => { if (listeners.has(name)) throw new Error(`duplicate listener: ${name}`); listeners.set(name, handler); },
  removeAllListeners: name => listeners.delete(name),
};
const screen = new EventEmitter();
const manager = new ToastOverlayManager({ BrowserWindow: FakeWindow, mainWindow: parent, ipcMain, preloadPath: 'overlay-preload.cjs', rendererFile: 'toast-overlay.html', screen });
const overlay = FakeWindow.last;

const expectedMeasurementBounds = parentBounds => ({
  x: parentBounds.x + Math.floor((parentBounds.width - Math.min(TOAST_OVERLAY_MAX_WIDTH, parentBounds.width)) / 2),
  y: parentBounds.y + Math.min(TOAST_OVERLAY_TOP_OFFSET, Math.max(0, parentBounds.height - 1)),
  width: Math.min(TOAST_OVERLAY_MAX_WIDTH, parentBounds.width),
  height: Math.max(1, Math.min(TOAST_OVERLAY_MAX_HEIGHT, parentBounds.height - TOAST_OVERLAY_PARENT_VERTICAL_RESERVE)),
});

assert.deepStrictEqual(overlay.bounds.at(-1), expectedMeasurementBounds(parent.currentBounds), 'initial hidden measurement viewport is centered, top-limited, and never full-window');
assert.equal(overlay.bounds.at(-1).height, 512, 'large parent windows preserve the absolute 28rem content plus 64 DIP gutter cap');
assert.equal(overlay.visible, false, 'overlay stays hidden before renderer readiness and layout');
overlay.webContents.emit('did-finish-load');
assert.equal(overlay.visible, false, 'first load without content stays hidden');

const update = handlers.get('toast-overlay:update');
const reportLayout = handlers.get('toast-overlay:layout');
assert.throws(() => update({ sender: new FakeContents(3) }, { html: '', dark: false }), /Unauthorized/);
assert.throws(() => reportLayout({ sender: mainContents }, { visible: false, revision: 0, x: 0, y: 0, width: 0, height: 0, viewportWidth: TOAST_OVERLAY_MAX_WIDTH, viewportHeight: TOAST_OVERLAY_MAX_HEIGHT }), /Unauthorized/);
assert.equal(validLayout({ visible: true, revision: 1, x: 0, y: 0, width: TOAST_OVERLAY_MAX_WIDTH, height: 120, viewportWidth: TOAST_OVERLAY_MAX_WIDTH, viewportHeight: TOAST_OVERLAY_MAX_HEIGHT }), true);
assert.equal(validLayout({ visible: true, revision: 1, x: 0, y: 0, width: TOAST_OVERLAY_MAX_WIDTH + 1, height: 120, viewportWidth: TOAST_OVERLAY_MAX_WIDTH + 1, viewportHeight: TOAST_OVERLAY_MAX_HEIGHT }), false, 'renderer cannot expand the overlay beyond the width cap');
assert.equal(validLayout({ visible: true, revision: 1, x: 0, y: 0, width: TOAST_OVERLAY_MAX_WIDTH, height: TOAST_OVERLAY_MAX_HEIGHT + 1, viewportWidth: TOAST_OVERLAY_MAX_WIDTH, viewportHeight: TOAST_OVERLAY_MAX_HEIGHT + 1 }), false, 'renderer cannot expand the overlay beyond the height cap');
assert.equal(validLayout({ visible: true, revision: 1, x: Number.NaN, y: 0, width: 1, height: 1, viewportWidth: 1, viewportHeight: 1 }), false, 'layout values must be finite integers');

assert.deepStrictEqual(update({ sender: mainContents }, { html: '<div data-top-toast-id="notice:1">safe</div>', dark: false }), { success: true });
assert.equal(overlay.visible, false, 'new content remains hidden until its actual rendered bounds are measured');
assert.deepStrictEqual(overlay.webContents.sent.at(-1), ['toast-overlay:snapshot', { html: '<div data-top-toast-id="notice:1">safe</div>', dark: false, revision: 1 }]);
const firstLayout = { visible: true, revision: 1, x: 0, y: 0, width: TOAST_OVERLAY_MAX_WIDTH, height: 112, viewportWidth: TOAST_OVERLAY_MAX_WIDTH, viewportHeight: TOAST_OVERLAY_MAX_HEIGHT };
assert.deepStrictEqual(reportLayout({ sender: overlay.webContents }, firstLayout), { success: true });
assert.deepStrictEqual(overlay.bounds.at(-1), { x: -1424, y: 128, width: 544, height: 112 }, 'renderer content coordinates convert to parent-relative screen DIP coordinates on a negative display');
assert.equal(overlay.visible, true);
assert.notDeepStrictEqual(overlay.bounds.at(-1), parent.currentBounds, 'visible overlay never uses the full parent bounds');

update({ sender: mainContents }, { html: '<div data-top-toast-id="notice:1">same size</div>', dark: false });
assert.equal(overlay.visible, false, 'each new snapshot invalidates the previously accepted layout');
assert.deepStrictEqual(reportLayout({ sender: overlay.webContents }, firstLayout), { success: false, stale: true });
assert.equal(overlay.visible, false, 'a delayed measurement from the previous snapshot cannot reshow stale content');
assert.deepStrictEqual(reportLayout({ sender: overlay.webContents }, { ...firstLayout, revision: 2 }), { success: true });
assert.equal(overlay.visible, true, 'an identical-size consecutive snapshot still reports once and becomes visible again');

update({ sender: mainContents }, { html: '<div data-top-toast-id="task:1">expanded</div>', dark: true });
assert.equal(overlay.visible, false, 'content mutations hide stale bounds until the debounced renderer measurement arrives');
const expandedLayout = { visible: true, revision: 3, x: 0, y: 0, width: TOAST_OVERLAY_MAX_WIDTH, height: 318, viewportWidth: TOAST_OVERLAY_MAX_WIDTH, viewportHeight: TOAST_OVERLAY_MAX_HEIGHT };
reportLayout({ sender: overlay.webContents }, expandedLayout);
assert.deepStrictEqual(overlay.bounds.at(-1), { x: -1424, y: 128, width: 544, height: 318 }, 'expanded task cards resize without clipping');

update({ sender: mainContents }, { html: '<div data-top-toast-id="notice:many-1">many</div>', dark: false });
update({ sender: mainContents }, { html: '<div data-top-toast-id="notice:many-2">more</div>', dark: false });
update({ sender: mainContents }, { html: '<div data-top-toast-id="notice:many-final">final full stack</div>', dark: false });
const fullStackLayout = revision => ({ visible: true, revision, x: 0, y: 0, width: TOAST_OVERLAY_MAX_WIDTH, height: TOAST_OVERLAY_MAX_HEIGHT, viewportWidth: TOAST_OVERLAY_MAX_WIDTH, viewportHeight: TOAST_OVERLAY_MAX_HEIGHT });
assert.deepStrictEqual(reportLayout({ sender: overlay.webContents }, fullStackLayout(4)), { success: false, stale: true }, 'rapid additions reject the oldest full-stack measurement');
assert.deepStrictEqual(reportLayout({ sender: overlay.webContents }, fullStackLayout(5)), { success: false, stale: true }, 'rapid additions reject every superseded intermediate measurement');
assert.deepStrictEqual(reportLayout({ sender: overlay.webContents }, fullStackLayout(6)), { success: true });
assert.deepStrictEqual(overlay.bounds.at(-1), { x: -1424, y: 128, width: 544, height: 512 }, 'overflowing notification stacks cap the native HWND at exactly 544 by 512 DIP');
assert.notDeepStrictEqual(overlay.bounds.at(-1), parent.currentBounds, 'a full toast stack never falls back to full-window bounds');

update({ sender: mainContents }, { html: '<div data-top-toast-id="notice:few">few remaining</div>', dark: false });
const reducedLayout = { visible: true, revision: 7, x: 0, y: 0, width: TOAST_OVERLAY_MAX_WIDTH, height: 148, viewportWidth: TOAST_OVERLAY_MAX_WIDTH, viewportHeight: TOAST_OVERLAY_MAX_HEIGHT };
assert.deepStrictEqual(reportLayout({ sender: overlay.webContents }, reducedLayout), { success: true });
assert.deepStrictEqual(overlay.bounds.at(-1), { x: -1424, y: 128, width: 544, height: 148 }, 'deleting from a full stack shrinks the native window back to the latest measured height');

parent.currentBounds = { x: 240, y: 80, width: 1280, height: 720 };
parent.emit('move');
assert.deepStrictEqual(overlay.bounds.at(-1), { x: 608, y: 88, width: 544, height: 148 }, 'parent movement repositions the measured overlay in screen DIP coordinates');
parent.currentBounds = { x: 100, y: -900, width: 420, height: 600 };
screen.emit('display-metrics-changed');
assert.deepStrictEqual(overlay.bounds.at(-1), { x: 100, y: -892, width: 420, height: 148 }, 'DPI/display changes clamp width to the parent while preserving negative coordinates');
assert(overlay.bounds.at(-1).height <= TOAST_OVERLAY_MAX_HEIGHT && overlay.bounds.at(-1).width <= TOAST_OVERLAY_MAX_WIDTH);

parent.minimized = true; parent.emit('minimize'); assert.equal(overlay.visible, false, 'overlay hides with minimized parent');
parent.minimized = false; parent.visible = false; parent.emit('hide'); assert.equal(overlay.visible, false, 'overlay hides with hidden parent');
parent.visible = true; parent.emit('show'); assert.equal(overlay.visible, true, 'measured content restores without activation');

reportLayout({ sender: overlay.webContents }, { visible: false, revision: 7, x: 0, y: 0, width: 0, height: 0, viewportWidth: 420, viewportHeight: TOAST_OVERLAY_MAX_HEIGHT });
assert.equal(overlay.visible, false, 'empty measured stack leaves no transparent HWND visible');
update({ sender: mainContents }, { html: '', dark: false });
assert.equal(overlay.visible, false, 'empty host snapshot remains hidden');
mainContents.emit('did-start-loading');
assert.deepStrictEqual(overlay.webContents.sent.at(-1), ['toast-overlay:snapshot', { html: '', dark: false, revision: 9 }], 'main renderer reload clears content and layout');
parent.currentBounds = { x: -300, y: 50, width: 400, height: 300 };
parent.emit('resize');
assert.deepStrictEqual(overlay.bounds.at(-1), { x: -300, y: 58, width: 400, height: 192 }, 'small parents preserve calc(100vh - 10.75rem) through parent height minus 108 DIP measurement bounds');
assert.equal(overlay.bounds.at(-1).height - 64, parent.currentBounds.height - 172, 'small-parent stack max-height matches the original CSS formula exactly');
assert(overlay.bounds.at(-1).x >= parent.currentBounds.x && overlay.bounds.at(-1).y >= parent.currentBounds.y
  && overlay.bounds.at(-1).x + overlay.bounds.at(-1).width <= parent.currentBounds.x + parent.currentBounds.width
  && overlay.bounds.at(-1).y + overlay.bounds.at(-1).height <= parent.currentBounds.y + parent.currentBounds.height, 'measurement bounds never escape the parent window');
overlay.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
assert.equal(overlay.visible, false, 'overlay crash immediately hides stale native content');
assert.equal(overlay.reloadCount, 1, 'overlay crash requests a renderer reload');

listeners.get('toast-overlay:pointer-interactive')({ sender: overlay.webContents }, true);
assert.deepStrictEqual(overlay.ignored.at(-1), [false, { forward: true }], 'toast cards retain native pointer interaction');
listeners.get('toast-overlay:pointer-interactive')({ sender: overlay.webContents }, false);
assert.deepStrictEqual(overlay.ignored.at(-1), [true, { forward: true }], 'transparent padding passes pointers through');
listeners.get('toast-overlay:action')({ sender: overlay.webContents }, { action: 'notice-dismiss', id: '7' });
assert.deepStrictEqual(mainContents.sent.at(-1), ['toast-overlay:action', { action: 'notice-dismiss', id: '7' }]);
assert.equal(parent.focusCount, 1); assert.equal(mainContents.focusCount, 1, 'actions retain focus restoration');
assert(validSnapshot({ html: '', dark: true }) && !validSnapshot({ html: '', dark: 'yes' }));
assert(validAction({ action: 'task-cancel', id: 'task-1' }) && !validAction({ action: 'open-url', id: 'x' }));

const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'toast-overlay-preload.cjs'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'toast-overlay.ts'), 'utf8');
const layoutReporterSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'app', 'toast-overlay-layout-reporter.ts'), 'utf8');
const filesIpc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'files-ipc.cjs'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8');
assert(preload.includes("ipcRenderer.invoke('toast-overlay:layout'"), 'overlay preload exposes the validated layout invoke channel');
assert(renderer.includes('ResizeObserver') && renderer.includes('setTimeout') && renderer.includes('requestAnimationFrame'), 'renderer measurement is resize-driven and debounced/throttled');
assert(layoutReporterSource.includes('reportNow();') && layoutReporterSource.includes('timer = setTimer'), 'snapshot measurement has an immediate path plus a direct delayed correction');
assert.equal(TOAST_OVERLAY_TOP_OFFSET + 32, 40, '32px shadow gutter preserves the original 2.5rem visual toast top');
assert.equal(TOAST_OVERLAY_MAX_WIDTH - 64, 480, '32px horizontal gutters preserve the original 30rem toast width without clipping 25px shadows');
assert(/\.top-toast-stack\s*\{[\s\S]*?max-height:max\(1rem,min\(28rem,calc\(100vh - 10\.75rem\)\)\);[\s\S]*?overflow-y:auto;/.test(styles), 'host stack keeps the original 448 DIP cap and internal vertical scrolling');
assert(/\.top-toast-stack--overlay\s*\{[\s\S]*?width:calc\(100% - 4rem\);[\s\S]*?max-height:calc\(100vh - 4rem\);[\s\S]*?margin:2rem auto;/.test(styles), 'overlay stack reserves 32 DIP gutters while scrolling inside the capped native window');
assert(renderer.includes("closest('[data-top-toast-id]')") && renderer.includes('setPointerInteractive(next)'), 'scrolling over toast cards keeps the narrow overlay pointer-interactive');
assert(filesIpc.includes('suspendToastOverlayForNativeDrag?.()') && filesIpc.includes('resumeToastOverlayAfterNativeDrag?.()'), 'native file dragging hides the separate overlay HWND only around the blocking OLE call');

update({ sender: mainContents }, { html: '<div data-top-toast-id="notice:resume">resume</div>', dark: false });
manager.suspendForNativeDrag(); manager.suspendForNativeDrag();
assert.equal(overlay.destroyed, true, 'native drag suspension destroys the separate overlay HWND instead of merely hiding it');
assert.equal(manager.overlayWindow, null);
manager.resumeAfterNativeDrag();
assert.equal(manager.overlayWindow, null, 'nested native drag suspension does not rebuild before the final resume');
manager.resumeAfterNativeDrag();
const rebuiltOverlay = FakeWindow.last;
assert.notStrictEqual(rebuiltOverlay, overlay, 'the final resume creates a fresh HWND after the native drag completes');
assert.equal(parent.listenerCount('move'), 1, 'rebuilding the HWND does not duplicate parent lifecycle listeners');
rebuiltOverlay.webContents.emit('did-finish-load');
assert.equal(rebuiltOverlay.webContents.sent.at(-1)[1].html.includes('notice:resume'), true, 'the rebuilt overlay receives the current notification snapshot');
reportLayout({ sender: rebuiltOverlay.webContents }, { visible: true, revision: manager.snapshot.revision, x: 0, y: 0, width: 320, height: 80, viewportWidth: 400, viewportHeight: 192 });
assert.equal(rebuiltOverlay.visible, true, 'the rebuilt overlay becomes visible after reporting its restored layout');

manager.destroy();
assert.equal(overlay.destroyed, true);
assert.equal(rebuiltOverlay.destroyed, true);
assert.equal(handlers.size, 0);
assert.equal(listeners.size, 0);
assert.equal(screen.listenerCount('display-metrics-changed'), 0, 'destroy removes display listeners idempotently');
manager.destroy();
assert.equal(parent.listenerCount('move'), 0);
assert.equal(parent.listenerCount('resize'), 0);
assert.equal(mainContents.listenerCount('did-start-loading'), 0);
assert.equal(mainContents.listenerCount('render-process-gone'), 0, 'destroy removes every binding to the old parent window');

const replacementManager = new ToastOverlayManager({ BrowserWindow: FakeWindow, mainWindow: parent, ipcMain, preloadPath: 'overlay-preload.cjs', rendererFile: 'toast-overlay.html', screen });
const replacementOverlay = FakeWindow.last;
assert.equal(handlers.size, 2, 'the same ipcMain accepts update/layout handlers after a complete destroy');
assert.equal(listeners.size, 2, 'the replacement manager owns exactly one listener per overlay event channel');
assert.equal(parent.listenerCount('move'), 1);
assert.equal(mainContents.listenerCount('did-start-loading'), 1, 'replacement binds the parent lifecycle exactly once');

const compiledReporter = ts.transpileModule(layoutReporterSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const reporterModule = { exports: {} };
new Function('module', 'exports', 'require', compiledReporter)(reporterModule, reporterModule.exports, require);
const { createToastOverlayLayoutReporter } = reporterModule.exports;
let measuredHeight = 120;
let timerId = 0;
let frameId = 0;
const reporterTimers = new Map();
const reporterFrames = new Map();
const reporter = createToastOverlayLayoutReporter({
  measure: revision => ({ visible: true, revision, x: 0, y: 0, width: 400, height: measuredHeight, viewportWidth: 400, viewportHeight: 192 }),
  send: layout => handlers.get('toast-overlay:layout')({ sender: replacementOverlay.webContents }, layout),
  setTimer: callback => { const id = ++timerId; reporterTimers.set(id, callback); return id; },
  clearTimer: id => reporterTimers.delete(id),
  requestFrame: callback => { const id = ++frameId; reporterFrames.set(id, callback); return id; },
  cancelFrame: id => reporterFrames.delete(id),
});
replacementOverlay.webContents.emit('did-finish-load');
handlers.get('toast-overlay:update')({ sender: mainContents }, { html: '<div data-top-toast-id="notice:first">first</div>', dark: false });
assert.equal(replacementOverlay.visible, false, 'a new snapshot first hides the stale measurement window');
reporter.acceptSnapshot(1);
assert.equal(replacementOverlay.visible, true, 'hidden measurement window synchronously invokes layout and becomes visible without RAF');
assert.equal(reporterFrames.size, 0, 'first snapshot measurement never queues an animation frame');
handlers.get('toast-overlay:update')({ sender: mainContents }, { html: '<div data-top-toast-id="notice:same">same size</div>', dark: false });
reporter.acceptSnapshot(2);
assert.equal(replacementOverlay.visible, true, 'same-size consecutive snapshots synchronously report their new revision');
measuredHeight = 150;
const directCorrection = [...reporterTimers.values()].at(-1); reporterTimers.clear(); directCorrection();
assert.equal(replacementOverlay.bounds.at(-1).height, 150, 'short delayed correction also measures directly without RAF');
measuredHeight = 160;
reporter.schedule();
const resizeDebounce = [...reporterTimers.values()].at(-1); reporterTimers.clear(); resizeDebounce();
assert.equal(reporterFrames.size, 1, 'subsequent ResizeObserver work remains RAF-throttled');
const resizeFrame = [...reporterFrames.values()].at(-1); reporterFrames.clear(); resizeFrame();
assert.equal(replacementOverlay.bounds.at(-1).height, 160);
replacementOverlay.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
assert.equal(replacementOverlay.visible, false);
replacementOverlay.webContents.emit('did-finish-load');
reporter.acceptSnapshot(2);
assert.equal(replacementOverlay.visible, true, 'overlay reload receives the retained snapshot and remeasures synchronously');
reporter.destroy();
replacementManager.destroy();
assert.equal(replacementOverlay.destroyed, true);
assert.equal(handlers.size, 0);
assert.equal(listeners.size, 0);
assert.equal(parent.listenerCount('move'), 0);
assert.equal(mainContents.listenerCount('did-start-loading'), 0);
replacementManager.destroy();

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const createWindowSource = mainSource.slice(mainSource.indexOf('function createWindow'), mainSource.indexOf('function createWindow') + 600);
assert(createWindowSource.indexOf('destroyToastOverlayManager();') < createWindowSource.indexOf('mainWindow = new BrowserWindow'), 'window recreation destroys the manager while it is still bound to the old mainWindow');
console.log('toast overlay manager tests passed');
