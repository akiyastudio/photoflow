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

assert(app.includes("photoflow:background-task-drawer-width") && app.includes('readStoredNumber(BACKGROUND_TASK_DRAWER_STORAGE_KEY') && app.includes('localStorage.setItem(BACKGROUND_TASK_DRAWER_STORAGE_KEY'), 'drawer width must persist across renderer sessions');
assert(app.includes('BACKGROUND_TASK_DRAWER_MIN_WIDTH = 260') && app.includes('BACKGROUND_TASK_DRAWER_MAX_WIDTH = 640') && app.includes('viewportWidth - (sidebarCollapsed ? 0 : renderedSidebarWidth) - 420'), 'drawer width must preserve a usable main-content area');
assert(app.includes('width - deltaX') && app.includes('onReset={() => setBackgroundTaskDrawerWidth(BACKGROUND_TASK_DRAWER_DEFAULT_WIDTH)}'), 'dragging the left edge must resize in the correct direction and support resetting');
assert(resizeHandle.includes('setPointerCapture(event.pointerId)') && resizeHandle.includes('releasePointerCapture(event.pointerId)'), 'the resize handle must retain its pointer gesture');
for (const attribute of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-orientation="vertical"']) assert(resizeHandle.includes(attribute), `resize handle accessibility missing: ${attribute}`);

assert(indicator.includes('aria-expanded={open}') && indicator.includes('aria-label="关闭后台任务抽屉"') && indicator.includes('triggerRef.current?.focus()'), 'drawer open state, close action, Escape, and focus restoration must remain accessible');
for (const action of ['pauseBackgroundTask', 'continueBackgroundTask', 'cancelBackgroundTask', 'retryBackgroundTask', 'resumeBackgroundTask', 'restartBackgroundTask', 'dismissBackgroundTask']) assert(indicator.includes(action), `task drawer action missing: ${action}`);
assert(taskToast.includes('visibleTasks.map(task => <FileTransferToastItem key={task.id}'), 'stable task IDs must continue updating the existing toast card in place');
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
