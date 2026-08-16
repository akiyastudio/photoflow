const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'file-entry-sort-model.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('module', 'exports', 'require', compiled)(moduleUnderTest, moduleUnderTest.exports, require);

const { compareProjectFileNames, defaultProjectFileSortDirection, sortProjectFileEntries } = moduleUnderTest.exports;
const entry = (name, overrides = {}) => ({
  name,
  path: name,
  relativePath: name,
  kind: 'file',
  extension: path.extname(name),
  size: 0,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

assert(compareProjectFileNames('photo2.jpg', 'photo10.jpg') < 0, 'ordinary numbered names should retain natural ordering');
assert(compareProjectFileNames('2343803efe56e4e53174deb10bae25bd.jpg', '657226b15343127f22237766eac6cb6e.jpg') < 0, 'content-hash names should use visible A-Z ordering');
assert.strictEqual(defaultProjectFileSortDirection('name'), 'asc', 'filename sort should default to A-Z');
assert.strictEqual(defaultProjectFileSortDirection('date'), 'desc', 'date sort should default to newest first');
assert.strictEqual(defaultProjectFileSortDirection('size'), 'desc', 'size sort should default to largest first');

const hashEntries = [
  entry('657226b15343127f22237766eac6cb6e.jpg'),
  entry('2343803efe56e4e53174deb10bae25bd.jpg'),
];
assert.deepStrictEqual(
  sortProjectFileEntries(hashEntries, 'name', 'asc').map(item => item.name),
  ['2343803efe56e4e53174deb10bae25bd.jpg', '657226b15343127f22237766eac6cb6e.jpg'],
  'ascending filename sort should match the visible character order for hashes',
);
assert.deepStrictEqual(
  sortProjectFileEntries(hashEntries, 'name', 'desc').map(item => item.name),
  ['657226b15343127f22237766eac6cb6e.jpg', '2343803efe56e4e53174deb10bae25bd.jpg'],
  'descending filename sort should reverse the visible character order for hashes',
);

const mixedEntries = [entry('2.jpg'), entry('folder', { kind: 'folder' }), entry('10.jpg')];
assert.deepStrictEqual(
  sortProjectFileEntries(mixedEntries, 'name', 'asc').map(item => item.name),
  ['folder', '2.jpg', '10.jpg'],
  'folders should remain grouped first while ordinary numbers use natural ordering',
);

console.log('File entry sort model tests passed.');
