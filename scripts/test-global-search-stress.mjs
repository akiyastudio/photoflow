import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const sourcePath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1))), '..', 'src', 'features', 'search', 'SearchAllPage.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText;

const noopComponent = () => null;
const projectWorkspaceClient = {
  listProjectFiles: async () => { throw new Error('test must inject fetchPage'); },
  cancelListProjectFiles: async () => undefined,
};
const mockRequire = specifier => {
  if (specifier === 'react') return { useEffect: () => undefined, useMemo: fn => fn(), useRef: value => ({ current: value }), useState: value => [value, () => undefined] };
  if (specifier === 'react/jsx-runtime') return { Fragment: Symbol('Fragment'), jsx: noopComponent, jsxs: noopComponent };
  if (specifier === 'lucide-react') return new Proxy({}, { get: () => noopComponent });
  if (specifier === '../../types') return { normalizeWorkspacePaths: () => [] };
  if (specifier === '../../platform/project-workspace-client') return { projectWorkspaceClient };
  if (specifier === '../workspace/ProjectWorkspace') return { MediaThumbnail: noopComponent };
  throw new Error(`Unexpected module import: ${specifier}`);
};
const loadedModule = { exports: {} };
vm.runInThisContext(`(function(require, module, exports) { ${compiled}\n})`, { filename: sourcePath })(mockRequire, loadedModule, loadedModule.exports);
const {
  GLOBAL_SEARCH_RESULT_PAGE_SIZE,
  IndexedDbSearchStore,
  MemoryBoundedSearchStore,
  cancelGlobalSearchCursors,
  createTrailingSearchRefreshScheduler,
  rescanGlobalSearchPage,
  streamGlobalSearchSource,
} = loadedModule.exports;

assert.equal(GLOBAL_SEARCH_RESULT_PAGE_SIZE, 200);

const scheduledRefreshes = [];
const appliedRefreshes = [];
const refreshScheduler = createTrailingSearchRefreshScheduler(
  value => appliedRefreshes.push(value),
  75,
  callback => { scheduledRefreshes.push(callback); return scheduledRefreshes.length; },
  () => undefined,
);
for (let batch = 1; batch <= 500; batch += 1) refreshScheduler.push(batch * 200);
assert.equal(scheduledRefreshes.length, 1, '100k / 200 batches must coalesce into one pending page refresh');
assert.equal(appliedRefreshes.length, 0);
scheduledRefreshes[0]();
assert.deepEqual(appliedRefreshes, [100_000], 'the trailing refresh must retain the final snapshot');
refreshScheduler.push(100_001);
refreshScheduler.flush();
assert.deepEqual(appliedRefreshes, [100_000, 100_001], 'final flush must not lose the newest count');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-search-stress-'));
const resultFile = path.join(tempDirectory, 'results.bin');

class SyntheticDiskPageStore {
  constructor(filePath) {
    this.handle = fs.openSync(filePath, 'w+');
    this.totalCount = 0;
    this.maxAppendBatch = 0;
    this.maxResidentPage = 0;
  }

  async append(_source, entries) {
    this.maxAppendBatch = Math.max(this.maxAppendBatch, entries.length);
    for (const entry of entries) {
      const index = Number(entry.name.slice(4, -4));
      const buffer = Buffer.allocUnsafe(4);
      buffer.writeUInt32LE(index);
      fs.writeSync(this.handle, buffer, 0, 4, index * 4);
    }
    this.totalCount += entries.length;
    return { storedCount: this.totalCount, totalCount: this.totalCount, groupCount: 100, truncated: false };
  }

  async readPage(pageIndex, pageSize) {
    const count = Math.min(pageSize, Math.max(0, this.totalCount - pageIndex * pageSize));
    const buffer = Buffer.alloc(count * 4);
    fs.readSync(this.handle, buffer, 0, buffer.length, pageIndex * pageSize * 4);
    const entries = Array.from({ length: count }, (_, offset) => {
      const index = buffer.readUInt32LE(offset * 4);
      return makeEntry(index);
    });
    this.maxResidentPage = Math.max(this.maxResidentPage, entries.length);
    return count ? [{ id: 'source\0folder', source: testSource, folderPath: 'folder', entries, totalCount: this.totalCount }] : [];
  }

  async dispose() { fs.closeSync(this.handle); }
}

const testSource = {
  id: 'project:stress',
  kind: 'project',
  label: 'Stress 2',
  workspacePath: '/workspace',
  project: { id: 'stress', name: 'Stress', path: '/workspace/Stress', workspacePath: '/workspace', status: 'active', updatedAt: 0 },
};
const makeEntry = index => {
  const number = String(index).padStart(6, '0');
  return { kind: 'file', extension: '.txt', name: `file${number}.txt`, path: `/workspace/Stress/folder/file${number}.txt`, relativePath: `folder/file${number}.txt`, parentRelativePath: 'folder' };
};
const makeSyntheticFetcher = total => async (_source, _query, cursor) => {
  const start = cursor ? Number(cursor) : 0;
  const count = Math.min(GLOBAL_SEARCH_RESULT_PAGE_SIZE, total - start);
  const entries = Array.from({ length: count }, (_, offset) => makeEntry(start + count - offset - 1));
  const next = start + count;
  return { success: true, entries, cursor: next < total ? String(next) : '', hasMore: next < total };
};

try {
  const store = new SyntheticDiskPageStore(resultFile);
  const activeCursors = new Set();
  let maximumReturnedBatch = 0;
  await streamGlobalSearchSource({
    source: testSource,
    query: 'file',
    isCurrent: () => true,
    activeCursors,
    store,
    fetchPage: async (...args) => {
      const result = await makeSyntheticFetcher(100_000)(...args);
      const entries = result.entries;
      maximumReturnedBatch = Math.max(maximumReturnedBatch, entries.length);
      return result;
    },
    cancelCursor: async () => undefined,
  });

  assert.equal(store.totalCount, 100_000, 'all synthetic results must reach temporary storage');
  assert.equal(activeCursors.size, 0, 'a completed scan must retain no IPC cursor');
  assert.ok(maximumReturnedBatch <= 200 && store.maxAppendBatch <= 200, 'streaming batches must stay bounded');
  assert.equal(Object.values(store).some(value => Array.isArray(value)), false, 'the test storage model must not hide a full JS array');

  let traversed = 0;
  let firstName = '';
  let middleName = '';
  let lastName = '';
  for (let pageIndex = 0; pageIndex < 500; pageIndex += 1) {
    const groups = await store.readPage(pageIndex, GLOBAL_SEARCH_RESULT_PAGE_SIZE);
    const entries = groups.flatMap(group => group.entries);
    traversed += entries.length;
    if (pageIndex === 0) firstName = entries[0].name;
    if (pageIndex === 250) middleName = entries[0].name;
    if (pageIndex === 499) lastName = entries.at(-1).name;
  }
  assert.equal(traversed, 100_000, 'previous/next paging must be able to traverse the complete result set');
  assert.equal(firstName, 'file000000.txt');
  assert.equal(middleName, 'file050000.txt');
  assert.equal(lastName, 'file099999.txt');
  assert.ok(store.maxResidentPage <= GLOBAL_SEARCH_RESULT_PAGE_SIZE, 'the resident/render model must remain one fixed-size page');
  await store.dispose();

  const fallbackStore = new MemoryBoundedSearchStore();
  const fallbackCursors = new Set();
  const fallbackBaseFetcher = makeSyntheticFetcher(100_000);
  let fallbackFetchCount = 0;
  const fallbackFetcher = async (...args) => { fallbackFetchCount += 1; return fallbackBaseFetcher(...args); };
  await streamGlobalSearchSource({ source: testSource, query: 'file', isCurrent: () => true, activeCursors: fallbackCursors, store: fallbackStore, fetchPage: fallbackFetcher, cancelCursor: async () => undefined });
  assert.ok(fallbackStore.rows.length <= 400, 'fallback metadata must remain fixed even after 100k results');
  fallbackStore.setPageLoader((pageIndex, pageSize, isLoadCurrent) => rescanGlobalSearchPage({
    sources: [testSource], query: 'file', pageIndex, pageSize, isCurrent: isLoadCurrent, activeCursors: fallbackCursors, fetchPage: fallbackFetcher, cancelCursor: async () => undefined,
  }));
  const fallbackFirst = (await fallbackStore.readPage(0, 200)).flatMap(group => group.entries);
  const beforeMiddle = fallbackFetchCount;
  const fallbackMiddle = (await fallbackStore.readPage(250, 200)).flatMap(group => group.entries);
  const middleFetches = fallbackFetchCount - beforeMiddle;
  const fallbackLast = (await fallbackStore.readPage(499, 200)).flatMap(group => group.entries);
  assert.equal(fallbackFirst[0].name, 'file000000.txt');
  assert.equal(fallbackMiddle[0].name, 'file050000.txt');
  assert.equal(fallbackLast.at(-1).name, 'file099999.txt');
  assert.equal(middleFetches, 251, 'fallback rescan must stop and cancel as soon as the requested page is complete');
  assert.ok(Math.max(fallbackFirst.length, fallbackMiddle.length, fallbackLast.length) <= 200, 'fallback rescans must retain only the requested page');
  await fallbackStore.dispose();

  const indexedRows = [makeEntry(0), makeEntry(1)].map(entry => ({ orderKey: entry.name, groupKey: 'project:stress\0folder', hit: { source: testSource, entry } }));
  let transactionCalls = 0;
  const complete = transaction => setImmediate(() => { transaction.active = false; transaction.oncomplete?.(); });
  const fakeDatabase = {
    transaction() {
      transactionCalls += 1;
      const transaction = { active: true, error: null, oncomplete: null, onabort: null, onerror: null };
      if (transactionCalls === 1) {
        transaction.objectStore = () => ({ index: name => {
          assert.equal(name, 'orderKey');
          return { openCursor: () => {
            const request = { result: null, error: null, onsuccess: null, onerror: null };
            let index = 0;
            const advance = () => setImmediate(() => {
              if (index >= indexedRows.length) {
                request.result = null;
                request.onsuccess?.();
                complete(transaction);
                return;
              }
              request.result = { value: indexedRows[index], continue: () => { index += 1; advance(); }, advance: count => { index += count; advance(); } };
              request.onsuccess?.();
            });
            advance();
            return request;
          } };
        } });
      } else {
        let pending = 0;
        transaction.objectStore = () => ({ index: name => {
          assert.equal(name, 'groupKey');
          return { count: () => {
            if (!transaction.active) throw new Error('TransactionInactiveError');
            pending += 1;
            const request = { result: 0, error: null, onsuccess: null, onerror: null };
            setImmediate(() => {
              request.result = 2;
              request.onsuccess?.();
              pending -= 1;
              if (pending === 0) complete(transaction);
            });
            return request;
          } };
        } });
      }
      return transaction;
    },
  };
  globalThis.IDBKeyRange = { only: value => value };
  const indexedStore = new IndexedDbSearchStore(fakeDatabase, 'fake');
  const indexedGroups = await indexedStore.readPage(0, 200);
  assert.equal(transactionCalls, 2, 'group counts must use a fresh transaction after cursor paging commits');
  assert.equal(indexedGroups[0].totalCount, 2);

  let current = true;
  let resolveSecondPage;
  const secondPage = new Promise(resolve => { resolveSecondPage = resolve; });
  const cancelled = [];
  const switchingStore = new SyntheticDiskPageStore(path.join(tempDirectory, 'switch.bin'));
  const switchingCursors = new Set();
  let fetchCount = 0;
  const scanning = streamGlobalSearchSource({
    source: testSource,
    query: 'old query',
    isCurrent: () => current,
    activeCursors: switchingCursors,
    store: switchingStore,
    fetchPage: async () => {
      fetchCount += 1;
      if (fetchCount === 1) return { success: true, entries: [makeEntry(0)], cursor: 'cursor-1', hasMore: true };
      return secondPage;
    },
    cancelCursor: async cursor => { cancelled.push(cursor); },
  });
  while (fetchCount < 2) await new Promise(resolve => setImmediate(resolve));
  current = false;
  await cancelGlobalSearchCursors(switchingCursors, async cursor => { cancelled.push(cursor); });
  resolveSecondPage({ success: true, entries: [makeEntry(1)], cursor: 'cursor-2', hasMore: true });
  await scanning;
  assert.deepEqual(cancelled.sort(), ['cursor-1', 'cursor-2'], 'query switching must cancel known and stale-response cursors');
  assert.equal(switchingStore.totalCount, 1, 'stale query results must not be persisted');
  await switchingStore.dispose();

  let appendCurrent = true;
  let releaseAppend;
  let appendStarted = false;
  const appendGate = new Promise(resolve => { releaseAppend = resolve; });
  const appendCursors = new Set();
  const appendCancelled = [];
  const hangingStore = {
    append: async () => { appendStarted = true; await appendGate; return { storedCount: 1, totalCount: 1, groupCount: 1, truncated: false }; },
    readPage: async () => [],
    dispose: async () => undefined,
  };
  const appendScan = streamGlobalSearchSource({
    source: testSource, query: 'old query', isCurrent: () => appendCurrent, activeCursors: appendCursors, store: hangingStore,
    fetchPage: async () => ({ success: true, entries: [makeEntry(0)], cursor: 'append-cursor', hasMore: true }),
    cancelCursor: async cursor => { appendCancelled.push(cursor); },
  });
  while (!appendStarted) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...appendCursors], ['append-cursor'], 'the returned server cursor must remain tracked while append is pending');
  appendCurrent = false;
  await cancelGlobalSearchCursors(appendCursors, async cursor => { appendCancelled.push(cursor); });
  releaseAppend();
  await appendScan;
  assert.deepEqual(appendCancelled, ['append-cursor'], 'an append-time query switch must cancel the cursor exactly once');

  const failedCursors = new Set();
  const failedCancelled = [];
  let failureFetches = 0;
  await assert.rejects(streamGlobalSearchSource({
    source: testSource, query: 'failure', isCurrent: () => true, activeCursors: failedCursors, store: hangingStore,
    fetchPage: async () => {
      failureFetches += 1;
      if (failureFetches === 1) return { success: true, entries: [], cursor: 'failed-cursor', hasMore: true };
      throw new Error('synthetic fetch failure');
    },
    cancelCursor: async cursor => { failedCancelled.push(cursor); },
  }), /synthetic fetch failure/);
  assert.equal(failedCursors.size, 0, 'fetch failure must remove its in-flight cursor');
  assert.deepEqual(failedCancelled, ['failed-cursor'], 'fetch failure must cancel its server cursor');

  console.log('global search 100k stress tests passed');
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
