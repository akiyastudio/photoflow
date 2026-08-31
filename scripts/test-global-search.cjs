const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'search', 'SearchAllPage.tsx'), 'utf8');
assert(source.includes('GLOBAL_SEARCH_RESULT_PAGE_SIZE = 200'), 'large result sets must mount only one bounded page');
assert(source.includes('上一页') && source.includes('下一页'), 'bounded rendering must preserve access to every persisted result');
assert(!source.includes('nextHits') && !source.includes('setHits(current => [...current'), 'search must not accumulate a full JS result collection');
assert(source.includes('createObjectStore(\'hits\'') && source.includes("createIndex('orderKey'"), 'results must be sorted and paged from temporary IndexedDB');
assert(source.includes('cancelGlobalSearchCursors'), 'query changes must cancel all known file-list cursors');
assert(source.includes('pageReadSequenceRef'), 'late page reads must not overwrite a newer requested page');
assert(source.includes('Promise.resolve(onOpenFolder') && source.includes('打开文件夹失败'), 'folder-open rejection must produce user feedback');
assert(source.includes('role="listbox"') && source.includes('role="option"') && source.includes('aria-selected'), 'search results must expose keyboard selection semantics');
assert(source.includes('window.clearTimeout(focusTimer)'), 'deferred focus must be cancelled when the active query surface changes');
assert(source.includes('catch(catalogError'), 'one rejected workspace catalog must not discard successful catalogs');
console.log('global search regression tests passed');
