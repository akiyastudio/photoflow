const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'project-workspace-layout-model.ts');
const workspacePath = path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx');
const versionTreePath = path.resolve(__dirname, '..', 'src', 'components', 'ProjectVersionTree.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const workspace = fs.readFileSync(workspacePath, 'utf8');
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
  resizeFileListColumnBoundary,
} = moduleUnderTest.exports;

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
assert(workspace.includes('onViewportScrollChange={setVersionTreeHeaderCollapsed}'), 'the version-tree viewport must drive the project overview collapse state');
assert(workspace.includes('onWheelCapture={handleFilesColumnWheelCapture}') && workspace.includes("viewport.scrollTop <= 2) setVersionTreeHeaderCollapsed(false)"), 'the version-tree file column must collapse on downward wheel input and reveal on upward input when its viewport is already at the top');
assert(versionTree.includes('if (nextScrollTop > 1) onViewportScrollChange?.(true)') && versionTree.includes('else if (nextScrollTop < previousScrollTop) onViewportScrollChange?.(false)'), 'vertical version-tree scrolling must not immediately undo a wheel-triggered collapse while still at the top');
assert(versionTree.includes('if (event.deltaY > 0) onViewportScrollChange?.(true)') && versionTree.includes('event.deltaY < 0 && viewport.scrollTop <= 1'), 'version-tree wheel intent must collapse the overview even before the canvas itself can scroll and reveal it again at the top');
assert(workspace.includes("versionTreeOpen ? 'gap-0 overflow-hidden pb-0' : 'gap-3 overflow-auto pb-6'"), 'version-tree mode must not add the normal content gap below its breadcrumb');

console.log('Project workspace layout model tests passed.');
