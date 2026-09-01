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

console.log('background task resizable drawer tests passed');
