const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { TOAST_VIEW_EMPTY_GRACE_MS, TOAST_VIEW_MAX_REFLOW_MS, TOAST_VIEW_RETRY_DELAYS_MS, ToastViewManager, snapshotLayoutKey, validAction, validSnapshot } = require('../electron/services/toast-view-manager.cjs');

let nextContentsId = 1;
class Contents extends EventEmitter {
  constructor() { super(); this.id = nextContentsId++; this.sent = []; this.focusCount = 0; this.closed = false; this.loadCalls = []; this.session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }; }
  setWindowOpenHandler() {}
  loadFile(file) { this.loaded = file; this.loadCalls.push(file); return Promise.resolve(); }
  loadURL(url) { this.loaded = url; this.loadCalls.push(url); return Promise.resolve(); }
  send(...args) { this.sent.push(args); }
  focus() { this.focusCount += 1; }
  reload() { this.reloaded = true; }
  isDestroyed() { return this.closed; }
  close() { this.closed = true; }
}
class View {
  constructor(options) { this.options = options; this.webContents = new Contents(); this.visible = false; this.boundsCalls = []; View.instances.push(this); }
  setBackgroundColor(color) { this.backgroundColor = color; }
  setBounds(bounds) { this.bounds = bounds; this.boundsCalls.push(bounds); }
  setVisible(visible) { this.visible = visible; }
}
View.instances = [];

const handlers = new Map();
const ipcMain = new EventEmitter();
ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
ipcMain.removeHandler = channel => handlers.delete(channel);
const children = [];
const mainContents = new Contents();
const mainWindow = new EventEmitter();
mainWindow.webContents = mainContents;
mainWindow.destroyed = false;
mainWindow.isDestroyed = () => mainWindow.destroyed;
mainWindow.getContentBounds = () => ({ x: 100, y: 50, width: 1000, height: 800 });
mainWindow.contentView = {
  addChildView: view => { if (!children.includes(view)) children.push(view); },
  removeChildView: view => { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1); },
};
const retryTimers = new Map();
let nextRetryTimer = 1;
const setTimeoutFn = (callback, delay) => { const id = nextRetryTimer++; retryTimers.set(id, { callback, delay }); return id; };
const clearTimeoutFn = id => retryTimers.delete(id);

const manager = new ToastViewManager({ WebContentsView: View, mainWindow, ipcMain, preloadPath: 'toast-view-preload.cjs', rendererFile: 'toast-view.html', developmentRendererUrl: 'http://localhost:5173', setTimeoutFn, clearTimeoutFn });
const view = View.instances[0];
assert.equal(View.instances.length, 1, 'the persistent Toast WebContentsView is created once');
assert.equal(children.at(-1), view);
assert.equal(view.visible, false);
assert.equal(view.backgroundColor, '#00000000');
assert.deepEqual(view.webContents.loadCalls, ['http://localhost:5173/toast-view.html']);

const snapshot = { revision: 1, dark: true, top: 40, width: 480, height: 100, notices: [{ id: 1, message: 'ok', persistent: false, count: 1, tone: 'info' }], tasks: [], overflowCount: 0 };
assert(validSnapshot(snapshot));
assert(!validSnapshot({ ...snapshot, width: 9000 }));
assert.equal(snapshotLayoutKey(snapshot), snapshotLayoutKey({ ...snapshot, revision: 99 }), 'progress revisions alone never invalidate Toast geometry');
const runningTask = { id: 'copy-1', state: 'running', progress: 1, message: 'A.CR3', metadata: { filesCopied: 1 }, capabilities: {} };
const taskSnapshot = { ...snapshot, notices: [], tasks: [runningTask] };
assert.equal(snapshotLayoutKey(taskSnapshot), snapshotLayoutKey({ ...taskSnapshot, revision: 2, tasks: [{ ...runningTask, progress: 76, message: 'B.CR3', metadata: { filesCopied: 500 } }] }), 'file names, counters, and progress percentages retain the same task-card geometry lease');
assert.throws(() => handlers.get('toast-view:update')({ sender: new Contents() }, snapshot), /Unauthorized/);
assert.deepEqual(handlers.get('toast-view:update')({ sender: mainContents }, snapshot), { success: true });
assert.equal(view.visible, false, 'the view stays hidden until its preload subscribes');
ipcMain.emit('toast-view:ready', { sender: view.webContents });
assert.equal(view.visible, true);
assert.deepEqual(view.bounds, { x: 260, y: 40, width: 480, height: 100 });
assert.deepEqual(view.webContents.sent.at(-1), ['toast-view:snapshot', manager.snapshot]);

handlers.get('toast-view:update')({ sender: mainContents }, { ...snapshot, revision: 2, height: 104, notices: [{ ...snapshot.notices[0], message: 'updated' }] });
assert.equal(View.instances.length, 1, 'progress updates reuse the same Toast WebContentsView');
ipcMain.emit('toast-view:layout', { sender: view.webContents }, { revision: 2, height: 112 });
assert.equal(view.bounds.height, 112, 'renderer layout corrections resize without recreating the view');
assert.deepEqual(mainContents.sent.at(-1), ['toast-view:presentation', { visible: true }], 'the host hides its fallback only after the child reports rendered layout');
const presentationEventCount = mainContents.sent.filter(message => message[0] === 'toast-view:presentation').length;
const stableBoundsCount = view.boundsCalls.length;
handlers.get('toast-view:update')({ sender: mainContents }, { ...snapshot, revision: 3, height: 112, notices: [{ ...snapshot.notices[0], message: 'updated' }] });
ipcMain.emit('toast-view:layout', { sender: view.webContents }, { revision: 3, height: 118 });
assert.equal(mainContents.sent.filter(message => message[0] === 'toast-view:presentation').length, presentationEventCount, 'progress revisions retain one stable native presentation lease');
assert.equal(view.boundsCalls.length, stableBoundsCount, 'stable progress revisions ignore incidental height jitter instead of resizing the native Toast surface');

const pluginView = { name: 'plugin' };
children.push(pluginView);
manager.bringToFront();
assert.equal(children.at(-1), view, 'Toast view is restored above newly attached plugin views');
manager.suspendForNativeDrag();
assert.equal(view.visible, false, 'native OLE dragging removes the Toast view from hit testing');
assert.deepEqual(mainContents.sent.at(-1), ['toast-view:presentation', { visible: false }], 'the main renderer restores its fallback while the native surface is suspended');
handlers.get('toast-view:update')({ sender: mainContents }, { ...snapshot, revision: 4, height: 120 });
assert.equal(View.instances.length, 1);
manager.resumeAfterNativeDrag();
assert.equal(view.visible, true, 'the same view returns after native dragging');
assert.equal(view.bounds.height, 120);

const visibleBoundsCount = view.boundsCalls.length;
handlers.get('toast-view:update')({ sender: mainContents }, { ...snapshot, revision: 5, width: 0, height: 0, notices: [] });
assert.equal(view.visible, true, 'an empty transition keeps the native surface lease briefly for a following task');
assert.equal([...retryTimers.values()][0].delay, TOAST_VIEW_EMPTY_GRACE_MS);
handlers.get('toast-view:update')({ sender: mainContents }, { ...snapshot, revision: 6, height: 120, notices: [{ ...snapshot.notices[0], message: 'next task' }] });
assert.equal(retryTimers.size, 0, 'new content cancels the pending empty-surface teardown');
assert.equal(view.boundsCalls.length, visibleBoundsCount + 1, 'replacement content changes width once without an estimate/actual-height bounce');

handlers.get('toast-view:update')({ sender: mainContents }, { ...snapshot, revision: 7, height: 200, notices: [{ ...snapshot.notices[0], message: 'one' }, { ...snapshot.notices[0], id: 2, message: 'two' }] });
ipcMain.emit('toast-view:layout', { sender: view.webContents }, { revision: 7, height: 200, reflowMs: 200 });
const expandedBoundsCount = view.boundsCalls.length;
handlers.get('toast-view:update')({ sender: mainContents }, { ...snapshot, revision: 8, height: 100, notices: [{ ...snapshot.notices[0], id: 2, message: 'two' }] });
ipcMain.emit('toast-view:layout', { sender: view.webContents }, { revision: 8, height: 100, reflowMs: 999 });
assert.equal(view.boundsCalls.length, expandedBoundsCount, 'removing one of several cards keeps the old bounds during reflow');
assert.equal([...retryTimers.values()][0].delay, TOAST_VIEW_MAX_REFLOW_MS, 'renderer-requested shrink delays are safely bounded');
const shrinkTimer = [...retryTimers.entries()][0];
retryTimers.delete(shrinkTimer[0]);
shrinkTimer[1].callback();
assert.equal(view.bounds.height, 100, 'the native surface shrinks once after remaining cards finish moving');

assert(validAction({ action: 'task-pause', id: 'task-1' }));
assert(!validAction({ action: 'open-url', id: 'x' }));
ipcMain.emit('toast-view:action', { sender: view.webContents }, { action: 'notice-dismiss', id: '1' });
assert.deepEqual(mainContents.sent.at(-1), ['toast-view:action', { action: 'notice-dismiss', id: '1' }]);
assert.equal(mainContents.focusCount, 1);

view.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/toast-view.html', true);
assert.equal(view.visible, false, 'a failed development load immediately hides the stale Toast surface');
assert.equal(retryTimers.size, 1, 'a failed development load schedules one recovery attempt');
assert.equal([...retryTimers.values()][0].delay, TOAST_VIEW_RETRY_DELAYS_MS[0]);
view.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/toast-view.html', true);
assert.equal(retryTimers.size, 1, 'duplicate failure signals do not stack recovery timers');
const firstRetry = [...retryTimers.values()][0];
retryTimers.clear();
firstRetry.callback();
assert.equal(view.webContents.loadCalls.length, 2, 'the recovery attempt reloads the Toast development URL');
ipcMain.emit('toast-view:ready', { sender: view.webContents });
assert.equal(view.visible, true, 'a recovered preload restores the latest Toast snapshot');
assert.equal(retryTimers.size, 0, 'renderer readiness clears pending recovery work');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const managerSource = fs.readFileSync(path.join(root, 'electron', 'services', 'toast-view-manager.cjs'), 'utf8');
const hostSource = fs.readFileSync(path.join(root, 'src', 'features', 'app', 'useTopToastStack.tsx'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'toast-view.tsx'), 'utf8');
const reflowSource = fs.readFileSync(path.join(root, 'src', 'features', 'app', 'useToastStackReflow.ts'), 'utf8');
const filesSource = fs.readFileSync(path.join(root, 'electron', 'modules', 'files-ipc.cjs'), 'utf8');
assert(mainSource.includes('new ToastViewManager({ WebContentsView') && !/toast[^\n]{0,80}new BrowserWindow/i.test(mainSource), 'Toast uses a child WebContentsView, never a second BrowserWindow');
assert(hostSource.includes('updateToastView({') && !hostSource.includes('innerHTML'), 'host publishes structured state rather than cloned HTML');
assert(hostSource.includes('Math.max(320, contentWidth + 32)') && hostSource.includes('Math.ceil(rect.height) + 8'), 'short notices retain horizontal and vertical breathing room while task stacks keep a bounded height');
assert(rendererSource.includes('Math.ceil(stack.scrollHeight)'), 'the child renderer must correct height after text wrapping');
assert(rendererSource.includes('useToastStackReflow(stackRef, reflowKey)') && reflowSource.includes('[layoutKey, stackRef]') && reflowSource.includes('element.animate('), 'both Toast surfaces animate reflow only when card identity or layout state changes');
assert(rendererSource.includes('key={task.id}') && rendererSource.includes('key={notice.id}'), 'stable IDs preserve mounted cards across updates');
assert(managerSource.includes('suspendForNativeDrag()') && !managerSource.slice(managerSource.indexOf('suspendForNativeDrag()'), managerSource.indexOf('resumeAfterNativeDrag()')).includes('destroy'), 'drag suspension hides without destroying the renderer');
assert(filesSource.includes('suspendToastViewForNativeDrag?.()') && filesSource.includes('resumeToastViewAfterNativeDrag?.()'), 'native drag brackets the Toast hit-test surface');

const compile = relative => ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const evaluate = (compiled, requireModule) => { const module = { exports: {} }; new Function('module', 'exports', 'require', compiled)(module, module.exports, requireModule); return module.exports; };
const icons = new Proxy({}, { get: (_target, name) => function Icon() { return name; } });
const taskModel = evaluate(compile('src/features/background-tasks/task-toast-model.ts'), require);
const taskModule = evaluate(compile('src/features/background-tasks/FileTransferToast.tsx'), request => request === 'lucide-react' ? icons : request === './TaskCenter' ? { useTaskCenter: () => ({}) } : request === './task-toast-model' ? taskModel : request === '../app/useToastStackReflow' ? { useToastStackReflow: () => undefined } : require(request));
const actions = [];
const task = { id: 'task-stable', type: 'project-file-operation', title: '导入', state: 'running', progress: 10, message: '正在导入', createdAt: 1, updatedAt: 2, cancellable: true, capabilities: { pausable: true }, metadata: {} };
const tree = taskModule.FileTransferToastItem({ task, onMinimize: id => actions.push(['minimize', id]), onDismiss: id => actions.push(['dismiss', id]), onPause: id => actions.push(['pause', id]), onContinue: id => actions.push(['continue', id]), onCancel: value => actions.push(['cancel', value.id]) });
const walkButtons = (value, result = []) => { if (!value || typeof value !== 'object') return result; if (value.type === 'button') result.push(value); const children = value.props?.children; for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) walkButtons(child, result); return result; };
const buttons = walkButtons(tree);
assert.deepEqual(buttons.map(button => button.props['aria-label']), ['收起到任务中心', '暂停任务', '取消任务']);
buttons.forEach(button => button.props.onClick());
assert.deepEqual(actions, [['minimize', task.id], ['pause', task.id], ['cancel', task.id]], 'all three native Toast view actions route through structured callbacks');

const completedTree = taskModule.FileTransferToastItem({ task: { ...task, state: 'completed', progress: 100, message: '文件导入完成' }, onMinimize() {}, onDismiss() {}, onPause() {}, onContinue() {}, onCancel() {} });
assert.deepEqual(walkButtons(completedTree).map(button => button.props['aria-label']), ['关闭通知'], 'a completed task must not retain a second cancel button when its cancellable snapshot is stale');

view.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/toast-view.html', true);
assert.equal(retryTimers.size, 1);
manager.destroy();
assert.equal(view.webContents.closed, true);
assert.equal(handlers.size, 0);
assert.equal(retryTimers.size, 0, 'destroying the manager cancels every pending retry');
console.log('persistent Toast WebContentsView tests passed');
