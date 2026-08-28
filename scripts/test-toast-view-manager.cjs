const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { ToastViewManager, validAction, validSnapshot } = require('../electron/services/toast-view-manager.cjs');

let nextContentsId = 1;
class Contents extends EventEmitter {
  constructor() { super(); this.id = nextContentsId++; this.sent = []; this.focusCount = 0; this.closed = false; this.session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }; }
  setWindowOpenHandler() {}
  loadFile(file) { this.loaded = file; return Promise.resolve(); }
  loadURL(url) { this.loaded = url; return Promise.resolve(); }
  send(...args) { this.sent.push(args); }
  focus() { this.focusCount += 1; }
  reload() { this.reloaded = true; }
  isDestroyed() { return this.closed; }
  close() { this.closed = true; }
}
class View {
  constructor(options) { this.options = options; this.webContents = new Contents(); this.visible = false; View.instances.push(this); }
  setBackgroundColor(color) { this.backgroundColor = color; }
  setBounds(bounds) { this.bounds = bounds; }
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

const manager = new ToastViewManager({ WebContentsView: View, mainWindow, ipcMain, preloadPath: 'toast-view-preload.cjs', rendererFile: 'toast-view.html' });
const view = View.instances[0];
assert.equal(View.instances.length, 1, 'the persistent Toast WebContentsView is created once');
assert.equal(children.at(-1), view);
assert.equal(view.visible, false);
assert.equal(view.backgroundColor, '#00000000');

const snapshot = { revision: 1, dark: true, top: 40, width: 480, height: 100, notices: [{ id: 1, message: 'ok', persistent: false, count: 1, tone: 'info' }], tasks: [], overflowCount: 0 };
assert(validSnapshot(snapshot));
assert(!validSnapshot({ ...snapshot, width: 9000 }));
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

const pluginView = { name: 'plugin' };
children.push(pluginView);
manager.bringToFront();
assert.equal(children.at(-1), view, 'Toast view is restored above newly attached plugin views');
manager.suspendForNativeDrag();
assert.equal(view.visible, false, 'native OLE dragging removes the Toast view from hit testing');
handlers.get('toast-view:update')({ sender: mainContents }, { ...snapshot, revision: 3, height: 120 });
assert.equal(View.instances.length, 1);
manager.resumeAfterNativeDrag();
assert.equal(view.visible, true, 'the same view returns after native dragging');
assert.equal(view.bounds.height, 120);

assert(validAction({ action: 'task-pause', id: 'task-1' }));
assert(!validAction({ action: 'open-url', id: 'x' }));
ipcMain.emit('toast-view:action', { sender: view.webContents }, { action: 'notice-dismiss', id: '1' });
assert.deepEqual(mainContents.sent.at(-1), ['toast-view:action', { action: 'notice-dismiss', id: '1' }]);
assert.equal(mainContents.focusCount, 1);

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const managerSource = fs.readFileSync(path.join(root, 'electron', 'services', 'toast-view-manager.cjs'), 'utf8');
const hostSource = fs.readFileSync(path.join(root, 'src', 'features', 'app', 'useTopToastStack.tsx'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'toast-view.tsx'), 'utf8');
const filesSource = fs.readFileSync(path.join(root, 'electron', 'modules', 'files-ipc.cjs'), 'utf8');
assert(mainSource.includes('new ToastViewManager({ WebContentsView') && !/toast[^\n]{0,80}new BrowserWindow/i.test(mainSource), 'Toast uses a child WebContentsView, never a second BrowserWindow');
assert(hostSource.includes('updateToastView({') && !hostSource.includes('innerHTML'), 'host publishes structured state rather than cloned HTML');
assert(rendererSource.includes('key={task.id}') && rendererSource.includes('key={notice.id}'), 'stable IDs preserve mounted cards across updates');
assert(managerSource.includes('suspendForNativeDrag()') && !managerSource.slice(managerSource.indexOf('suspendForNativeDrag()'), managerSource.indexOf('resumeAfterNativeDrag()')).includes('destroy'), 'drag suspension hides without destroying the renderer');
assert(filesSource.includes('suspendToastViewForNativeDrag?.()') && filesSource.includes('resumeToastViewAfterNativeDrag?.()'), 'native drag brackets the Toast hit-test surface');

const compile = relative => ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const evaluate = (compiled, requireModule) => { const module = { exports: {} }; new Function('module', 'exports', 'require', compiled)(module, module.exports, requireModule); return module.exports; };
const icons = new Proxy({}, { get: (_target, name) => function Icon() { return name; } });
const taskModel = evaluate(compile('src/features/background-tasks/task-toast-model.ts'), require);
const taskModule = evaluate(compile('src/features/background-tasks/FileTransferToast.tsx'), request => request === 'lucide-react' ? icons : request === './TaskCenter' ? { useTaskCenter: () => ({}) } : request === './task-toast-model' ? taskModel : require(request));
const actions = [];
const task = { id: 'task-stable', type: 'project-file-operation', title: '导入', state: 'running', progress: 10, message: '正在导入', createdAt: 1, updatedAt: 2, cancellable: true, capabilities: { pausable: true }, metadata: {} };
const tree = taskModule.FileTransferToastItem({ task, onMinimize: id => actions.push(['minimize', id]), onDismiss: id => actions.push(['dismiss', id]), onPause: id => actions.push(['pause', id]), onContinue: id => actions.push(['continue', id]), onCancel: value => actions.push(['cancel', value.id]) });
const walkButtons = (value, result = []) => { if (!value || typeof value !== 'object') return result; if (value.type === 'button') result.push(value); const children = value.props?.children; for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) walkButtons(child, result); return result; };
const buttons = walkButtons(tree);
assert.deepEqual(buttons.map(button => button.props['aria-label']), ['收起到任务中心', '暂停任务', '取消任务']);
buttons.forEach(button => button.props.onClick());
assert.deepEqual(actions, [['minimize', task.id], ['pause', task.id], ['cancel', task.id]], 'all three native Toast view actions route through structured callbacks');

manager.destroy();
assert.equal(view.webContents.closed, true);
assert.equal(handlers.size, 0);
console.log('persistent Toast WebContentsView tests passed');
