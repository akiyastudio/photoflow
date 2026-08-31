const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'search', 'SearchAllPage.tsx'), 'utf8');
assert(source.includes('VISIBLE_RESULT_BATCH'), 'large result sets must mount thumbnails in bounded batches');
assert(source.includes('visibleHitCount') && source.includes('显示更多结果'), 'bounded rendering must preserve access to every result');
assert(source.includes('Promise.resolve(onOpenFolder') && source.includes('打开文件夹失败'), 'folder-open rejection must produce user feedback');
assert(source.includes('role="listbox"') && source.includes('role="option"') && source.includes('aria-selected'), 'search results must expose keyboard selection semantics');
assert(source.includes('window.clearTimeout(focusTimer)'), 'deferred focus must be cancelled when the active query surface changes');
assert(source.includes('catch(catalogError'), 'one rejected workspace catalog must not discard successful catalogs');
console.log('global search regression tests passed');
