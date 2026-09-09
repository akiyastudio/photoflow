const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const main = read('src/main.tsx');
const app = read('src/App.tsx');
const indicator = read('src/features/background-tasks/BackgroundTaskIndicator.tsx');
const resizeHandle = read('src/features/app/AppShellLayout.tsx');
const resizeModel = read('src/features/app/app-shell-layout-model.ts');
const layoutState = read('src/features/app/useAppShellLayoutState.ts');
const inspirationLibrary = read('src/features/inspiration/InspirationLibrary.tsx');
const settingsFeature = read('src/features/settings/SettingsFeature.tsx');
const toast = read('src/features/app/useTopToastStack.tsx');
const toastView = read('src/toast-view.tsx');
const taskToast = read('src/features/background-tasks/FileTransferToast.tsx');
const styles = read('src/index.css');
const electronMain = read('electron/main.cjs');
const vite = read('vite.config.ts');

assert(!fs.existsSync(path.join(root, 'src', 'components', 'GlobalOverlayProvider.tsx')) && !main.includes('GlobalOverlayProvider'), 'the retired task overlay outlet must be removed');
assert(app.includes('backgroundTaskDrawerHostRef') && indicator.includes('drawerHostRef.current') && indicator.includes('createPortal('), 'the task panel must portal into the right-hand layout drawer');
assert(app.includes('style={{ width: renderedBackgroundTaskDrawerWidth }}') && app.includes("backgroundTaskDrawerOpen ? 'shrink-0 overflow-hidden bg-white'") && app.includes(": 'hidden'"), 'the open drawer must occupy layout width and the closed drawer must leave no gap');
assert(!app.includes("backgroundTaskDrawerOpen ? 'shrink-0 overflow-hidden border-l") && !inspirationLibrary.includes('aria-label="灵感库导航" className="flex min-h-0 flex-1 flex-col border-r') && !settingsFeature.includes('aria-label="设置分类" className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain border-r'), 'resize handles must be the single visual divider for side panels');
assert(indicator.includes('useEscapeLayer(open, closeAndRestoreFocus)') && !indicator.includes('suspendExternalSurfaces') && !indicator.includes('useHostSurfaceSuspension'), 'opening the drawer must not suspend native plugin surfaces');

assert(resizeModel.includes("BACKGROUND_TASK_DRAWER_STORAGE_KEY = 'photoflow:background-task-drawer-width'") && app.includes('readStoredNumber(BACKGROUND_TASK_DRAWER_STORAGE_KEY') && layoutState.includes('localStorage.setItem(BACKGROUND_TASK_DRAWER_STORAGE_KEY'), 'drawer width must persist across renderer sessions');
assert(resizeModel.includes('BACKGROUND_TASK_DRAWER_MIN_WIDTH = 260') && resizeModel.includes('BACKGROUND_TASK_DRAWER_MAX_WIDTH = 640') && app.includes('viewportWidth - (sidebarCollapsed ? 0 : renderedSidebarWidth) - 420'), 'drawer width must preserve a usable main-content area');
assert(layoutState.includes('useState(() => window.innerWidth)') && layoutState.includes("window.addEventListener('resize', measureViewport)") && layoutState.includes("window.removeEventListener('resize', measureViewport)"), 'viewport width must initialize synchronously and clean up its resize listener');
assert(app.includes('width - deltaX') && app.includes('onReset={() => setBackgroundTaskDrawerWidth(BACKGROUND_TASK_DRAWER_DEFAULT_WIDTH)}'), 'dragging the left edge must resize in the correct direction and support resetting');
assert(resizeHandle.includes('setPointerCapture(pointerId)') && resizeHandle.includes('releasePointerCapture(pointerId)'), 'the resize handle must capture and release its initiating pointer');
assert(resizeHandle.includes('moveEvent.pointerId !== pointerId') && resizeHandle.includes('finishEvent.pointerId !== pointerId') && resizeHandle.includes("addEventListener('pointerup', finish)") && resizeHandle.includes("addEventListener('pointercancel', finish)"), 'move, pointerup, and pointercancel must ignore every pointer except the initiating pointer');
assert(resizeHandle.includes("addEventListener('lostpointercapture', lostCapture)") && resizeHandle.includes("addEventListener('blur', cleanup)") && resizeHandle.includes('if (cleaned) return'), 'capture loss and window blur must run idempotent drag cleanup');
for (const attribute of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-orientation="vertical"']) assert(resizeHandle.includes(attribute), `resize handle accessibility missing: ${attribute}`);

assert(indicator.includes('aria-expanded={open}') && indicator.includes('aria-label="关闭后台任务抽屉"') && indicator.includes('triggerRef.current?.focus()'), 'drawer open state, close action, Escape, and focus restoration must remain accessible');
for (const action of ['pauseBackgroundTask', 'continueBackgroundTask', 'cancelBackgroundTask', 'retryBackgroundTask', 'resumeBackgroundTask', 'restartBackgroundTask', 'dismissBackgroundTask']) assert(indicator.includes(action), `task drawer action missing: ${action}`);
assert(taskToast.includes('visibleTasks.map(task => <FileTransferToastItem key={taskToastInstanceKey(task)}'), 'task cards must use generation-unique identities when a fixed task ID is reused');
assert(toastView.includes("import { taskToastInstanceKey } from './features/background-tasks/task-toast-model'") && toastView.includes('snapshot.tasks.map(task => <FileTransferToastItem key={taskToastInstanceKey(task)}'), 'the native Toast view must use the same generation-unique task identity');
assert(toast.includes('top-toast-stack--model') && toastView.includes('data-global-overlay-layer="toast"') && /\.top-toast-stack\s*\{[\s\S]*?z-index:var\(--app-layer-toast\);/.test(styles), 'the host model must be hidden while the native Toast view remains the global top layer');
assert(!indicator.includes('BrowserWindow') && !indicator.includes('window.open(') && !vite.includes('backgroundTask') && !vite.includes('background-task'), 'the drawer must not add a renderer entry or top-level window');
assert(!/background[ -]?task[\s\S]{0,160}new BrowserWindow/i.test(electronMain), 'the main process must not create a background-task BrowserWindow');

const compiled = ts.transpileModule(resizeModel, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const modelModule = { exports: {} };
new Function('module', 'exports', compiled)(modelModule, modelModule.exports);
assert.equal(modelModule.exports.clampNumber(200, 260, 640), 260);
assert.equal(modelModule.exports.clampNumber(720, 260, 640), 640);
assert.equal(modelModule.exports.clampNumber(420, 260, 640), 420);

const loadRendererModule = (source, dependencies) => {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', 'window', output)(name => {
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected drawer dependency: ${name}`);
  }, loaded, loaded.exports, { requestAnimationFrame: () => {} });
  return loaded.exports;
};
const toastModel = loadRendererModule(read('src/features/background-tasks/task-toast-model.ts'), {});
const findClearButton = node => {
  if (!node || typeof node !== 'object') return undefined;
  if (node.props?.['aria-label'] === '清空已结束的任务') return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = findClearButton(child);
    if (result) return result;
  }
};
const exerciseClearButton = async (rejectOne = false) => {
  const dismissed = [];
  const dismissedPanels = [];
  const openChanges = [];
  const stateChanges = [];
  let finishDismiss;
  const gate = new Promise(resolve => { finishDismiss = resolve; });
  const tasks = ['completed', 'failed', 'cancelled', 'interrupted', 'queued', 'running', 'pausing', 'paused', 'resuming'].map(state => ({
    id: state, state, title: state, metadata: {}, capabilities: {}, taskCenterPolicy: 'always',
  }));
  tasks.push({ ...tasks[1], id: 'retry-source', retryPending: true });
  tasks.push({ ...tasks[1], id: 'old-failure' });
  tasks[0].retryOfTaskId = 'old-failure';
  const { BackgroundTaskIndicator } = loadRendererModule(indicator, {
    'react/jsx-runtime': require('react/jsx-runtime'),
    react: { useMemo: fn => fn(), useRef: value => ({ current: value }), useState: value => [value, next => stateChanges.push(next)] },
    'react-dom': { createPortal: node => node },
    'lucide-react': Object.fromEntries(['Activity', 'Pause', 'Play', 'RotateCcw', 'Trash2', 'X'].map(name => [name, name])),
    '../../components/ProgressBar': { ProgressBar: 'progress' },
    '../../components/LayerProvider': { useEscapeLayer: () => {} },
    '../../components/useTaskPresentation': { formatTaskBytes: String, taskStateLabel: task => task.state },
    './panel-task-session-model': {},
    './task-toast-model': toastModel,
    './TaskCenter': { useTaskCenter: () => ({
      backgroundTasks: tasks,
      panelTasks: Object.fromEntries(['completed', 'running', 'failed'].map(state => [state, { key: state, ownerPageId: 'page', state }])),
      dismissBackgroundTask: async id => { dismissed.push(id); await gate; return { success: !(rejectOne && id === 'failed') }; },
      dismissPanelTask: key => dismissedPanels.push(key),
      isTaskToastMinimized: () => false,
    }) },
  });
  const tree = BackgroundTaskIndicator({ ownerPageIds: new Set(['page']), open: true, onOpenChange: value => openChanges.push(value), drawerHostRef: { current: {} } });
  const button = findClearButton(tree);
  assert(button && !button.props.disabled, 'the drawer header exposes the clear button');
  button.props.onClick();
  button.props.onClick();
  assert.deepEqual(dismissed, ['completed', 'failed', 'cancelled', 'interrupted', 'old-failure'], 'clear retains active/retrying work, includes hidden retry predecessors, and prevents duplicate submissions');
  assert.deepEqual(openChanges, [], 'the drawer stays open until dismissal completes');
  finishDismiss();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dismissedPanels, ['completed', 'failed'], 'running panel tasks survive');
  assert.deepEqual(openChanges, rejectOne ? [] : [false], 'only successful clearing closes the drawer');
  if (rejectOne) assert(stateChanges.some(value => typeof value === 'string' && value.includes('部分任务未能清除')), 'partial failures stay visible');
};
(async () => {
  await exerciseClearButton();
  await exerciseClearButton(true);
  console.log('background task resizable drawer tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
