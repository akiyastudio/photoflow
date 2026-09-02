const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'project-workspace-layout-model.ts');
const workspacePath = path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx');
const workspaceLayoutPath = path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspaceLayout.tsx');
const versionTreePath = path.resolve(__dirname, '..', 'src', 'components', 'ProjectVersionTree.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const workspace = [
  workspacePath,
  path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'useProjectFileQueries.ts'),
  path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'useProjectVersionRelations.ts'),
].map(filePath => fs.readFileSync(filePath, 'utf8')).join('\n');
const workspaceLayout = fs.readFileSync(workspaceLayoutPath, 'utf8');
const versionTree = fs.readFileSync(versionTreePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('module', 'exports', 'require', compiled)(moduleUnderTest, moduleUnderTest.exports, require);

const {
  DEFAULT_FILE_LIST_COLUMN_WIDTHS,
  MIN_FILE_LIST_COLUMN_WIDTHS,
  fitFileListColumnWidths,
  createDelayedCloseController,
  groupedResultsAreInitiallyLoading,
  positionViewportSubmenu,
  cleanViewportSubmenuClassName,
  resizeFileListColumnBoundary,
  shouldRetainGroupedResultsDuringRefresh,
} = moduleUnderTest.exports;

let fakeNow = 0; let nextTimerId = 1; const fakeTimers = new Map();
const fakeSetTimeout = (callback, delay) => { const id = nextTimerId++; fakeTimers.set(id, { at: fakeNow + delay, callback }); return id; };
const fakeClearTimeout = id => fakeTimers.delete(id);
const advanceFakeTimers = milliseconds => {
  fakeNow += milliseconds;
  for (const [id, timer] of [...fakeTimers].sort((left, right) => left[1].at - right[1].at)) if (timer.at <= fakeNow) { fakeTimers.delete(id); timer.callback(); }
};
let delayedCloseCalls = 0;
const delayedClose = createDelayedCloseController(() => { delayedCloseCalls += 1; }, 100, fakeSetTimeout, fakeClearTimeout);
delayedClose.scheduleClose(); advanceFakeTimers(60); delayedClose.cancelClose(); advanceFakeTimers(100);
assert.strictEqual(delayedCloseCalls, 0, 'entering the submenu during the pointer gap cancels delayed close and keeps it open');
delayedClose.scheduleClose(); advanceFakeTimers(99); assert.strictEqual(delayedCloseCalls, 0, 'slow pointer transit remains open for the full grace period'); advanceFakeTimers(1);
assert.strictEqual(delayedCloseCalls, 1, 'a genuine leave closes after the grace period');
delayedClose.scheduleClose(); delayedClose.dispose(); advanceFakeTimers(100); assert.strictEqual(delayedCloseCalls, 1, 'unmount disposal clears pending close timers');

assert.strictEqual(cleanViewportSubmenuClassName('invisible absolute left-full top-0 opacity-0 group-hover/submenu:visible group-hover/submenu:opacity-100 w-52 bg-white shadow-xl overflow-y-auto'), 'w-52 bg-white shadow-xl overflow-y-auto', 'submenu cleanup removes only legacy visibility and positioning state while preserving static presentation');

const clampedRootTrigger = { left: 984, right: 1192, top: 40 };
assert.deepStrictEqual(
  positionViewportSubmenu(clampedRootTrigger, { width: 208, height: 300 }, { width: 1200, height: 800 }),
  { openLeft: true, left: 772, top: 40 },
  'submenu positioning uses the trigger rect after the root menu has been clamped at the right viewport edge',
);
assert.deepStrictEqual(
  positionViewportSubmenu({ left: 400, right: 608, top: 760 }, { width: 208, height: 300 }, { width: 1200, height: 800 }),
  { openLeft: false, left: 612, top: 492 },
  'submenu positioning clamps upward from the real trigger near the bottom edge',
);

assert.strictEqual(shouldRetainGroupedResultsDuringRefresh('same', 'same', 12), true, 'a background refresh of the same grouped request must retain visible files');
assert.strictEqual(shouldRetainGroupedResultsDuringRefresh('old', 'new', 12), false, 'a new search or scope must not retain unrelated results');
assert.strictEqual(shouldRetainGroupedResultsDuringRefresh('same', 'same', 0), false, 'an empty first load has nothing to retain');
assert.strictEqual(groupedResultsAreInitiallyLoading(true, 0), true, 'an empty grouped request must show its initial loading state');
assert.strictEqual(groupedResultsAreInitiallyLoading(true, 3), false, 'a background refresh must not replace visible folder groups with a loading screen');
assert.strictEqual(groupedResultsAreInitiallyLoading(false, 0), false);

const sumWidths = widths => Object.values(widths).reduce((total, value) => total + value, 0);
const approximatelyEqual = (left, right) => Math.abs(left - right) < 0.001;

const fitted = fitFileListColumnWidths(DEFAULT_FILE_LIST_COLUMN_WIDTHS, 1380);
assert(approximatelyEqual(sumWidths(fitted), 1380), 'fitted file-list columns must fill the available track width');
for (const key of Object.keys(MIN_FILE_LIST_COLUMN_WIDTHS)) {
  assert(fitted[key] >= MIN_FILE_LIST_COLUMN_WIDTHS[key], `${key} must respect its minimum width`);
}

const narrow = fitFileListColumnWidths(DEFAULT_FILE_LIST_COLUMN_WIDTHS, 40);
assert.deepStrictEqual(narrow, MIN_FILE_LIST_COLUMN_WIDTHS, 'a narrow list must stop at the configured column minimums');

const resized = resizeFileListColumnBoundary(fitted, 0, 48);
assert(approximatelyEqual(resized.name, fitted.name + 48));
assert.strictEqual(resized.modified, fitted.modified);
assert.strictEqual(resized.type, fitted.type);
assert.strictEqual(resized.size, fitted.size);
assert(approximatelyEqual(sumWidths(resized), sumWidths(fitted) + 48), 'expanding one column must shift every later column instead of consuming the next column');

const clamped = resizeFileListColumnBoundary(fitted, 1, -500);
assert.strictEqual(clamped.modified, MIN_FILE_LIST_COLUMN_WIDTHS.modified, 'dragging left must not shrink the left column below its minimum');
assert.strictEqual(clamped.type, fitted.type, 'shrinking one column must not resize the following column');

const resizedLast = resizeFileListColumnBoundary(fitted, 3, -500);
assert.strictEqual(resizedLast.size, MIN_FILE_LIST_COLUMN_WIDTHS.size, 'the final size column must have its own independently draggable boundary');
assert.strictEqual(resizedLast.type, fitted.type);

const recovered = fitFileListColumnWidths({ name: NaN, modified: -1, type: 0, size: Infinity }, 920);
assert(approximatelyEqual(sumWidths(recovered), 920), 'invalid persisted widths must fall back to finite defaults');

assert(workspace.includes('const [versionTreeHeaderCollapsed, setVersionTreeHeaderCollapsed] = useState(false)') && workspace.includes("versionTreeHeaderCollapsed ? 'grid-rows-[0fr]' : 'mb-3 grid-rows-[1fr]'"), 'version-tree mode must show the project overview initially and smoothly collapse it after scrolling');
assert(workspace.includes('groupedResultsAreInitiallyLoading(groupedLoading, searchResultGroups.length)') && workspace.includes('groupedInitialLoading ?'), 'grouped file refreshes must keep existing folder sections mounted instead of replacing them with the initial loading screen');
assert(workspace.includes('shouldRetainGroupedResultsDuringRefresh(') && workspace.includes('if (!retainExistingEntries) setSearchEntries([])'), 'same-scope all-files refreshes must retain the previous entries until refreshed data is ready');
assert(workspace.includes('onViewportScrollChange={setVersionTreeHeaderCollapsed}'), 'the version-tree viewport must drive the project overview collapse state');
assert(workspace.includes('onWheelCapture={handleFilesColumnWheelCapture}') && workspace.includes("viewport.scrollTop <= 2) setVersionTreeHeaderCollapsed(false)"), 'the version-tree file column must collapse on downward wheel input and reveal on upward input when its viewport is already at the top');
assert(versionTree.includes('if (nextScrollTop > 1) onViewportScrollChange?.(true)') && versionTree.includes('else if (nextScrollTop < previousScrollTop) onViewportScrollChange?.(false)'), 'vertical version-tree scrolling must not immediately undo a wheel-triggered collapse while still at the top');
assert(versionTree.includes('if (event.deltaY > 0) onViewportScrollChange?.(true)') && versionTree.includes('event.deltaY < 0 && viewport.scrollTop <= 1'), 'version-tree wheel intent must collapse the overview even before the canvas itself can scroll and reveal it again at the top');
assert(workspace.includes("versionTreeOpen ? 'gap-0 overflow-hidden pb-0' : 'gap-3 overflow-auto pb-6'"), 'version-tree mode must not add the normal content gap below its breadcrumb');
assert(workspace.includes('const safeStorageGet =') && workspace.includes('const safeStorageSet =') && workspace.includes('const safeStorageRemove ='), 'tracking session storage access must be guarded when localStorage is unavailable');
assert(!workspace.includes('window.localStorage.getItem(sessionKey)') && !workspace.includes('window.localStorage.removeItem(sessionKey)'), 'tracking session recovery must use the safe storage wrappers');
assert(workspace.includes('!relativePaths?.length && !result.partial') && workspace.includes('result.warning ||'), 'materialize partial/warning responses must retain the external-link affordance and show a non-destructive notice');
assert(workspaceLayout.includes('onMouseLeave={() => closeControllerRef.current?.scheduleClose()}') && workspaceLayout.includes('onMouseEnter: openNow') && workspaceLayout.includes('closeControllerRef.current?.dispose()'), 'ViewportSubmenu must cancel delayed close on wrapper/submenu entry and clear the timer on unmount');

console.log('Project workspace layout model tests passed.');
