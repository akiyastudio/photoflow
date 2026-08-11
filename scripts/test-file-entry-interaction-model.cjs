const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { fileEntryClickIntent } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'file-entry-interaction-model.ts')).href);
  const intent = overrides => fileEntryClickIntent({
    openMode: 'single',
    selectionCount: 0,
    range: false,
    additive: false,
    ...overrides,
  });

  assert.strictEqual(intent({ openMode: 'single' }), 'open', 'single-click mode opens when selection mode is inactive');
  assert.strictEqual(intent({ openMode: 'double' }), 'focus', 'double-click mode focuses on its first click');
  assert.strictEqual(intent({ openMode: 'single', selectionCount: 1 }), 'toggle-select', 'an existing selection keeps single-click mode in selection interaction');
  assert.strictEqual(intent({ openMode: 'double', selectionCount: 1 }), 'toggle-select', 'an existing selection keeps double-click mode in selection interaction');
  assert.strictEqual(intent({ additive: true }), 'toggle-select', 'Ctrl/Cmd click toggles selection without opening');
  assert.strictEqual(intent({ range: true, selectionCount: 2 }), 'range-select', 'Shift click retains range selection precedence');
  assert.strictEqual(intent({ selectionCount: 2, clickCount: 2 }), 'ignore-repeat', 'the second click in a double click must not undo the first selection change');

  console.log('File entry interaction model tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
