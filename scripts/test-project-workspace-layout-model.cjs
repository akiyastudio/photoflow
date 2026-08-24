const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'project-workspace-layout-model.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
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

console.log('Project workspace layout model tests passed.');
