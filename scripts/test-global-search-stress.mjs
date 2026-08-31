import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

class VirtualFile {
  content = '';
  failNextClose = false;
  async getFile() { return { text: async () => this.content }; }
  async createWritable() {
    let pending = '';
    return {
      write: async value => { pending = String(value); },
      close: async () => {
        if (this.failNextClose) { this.failNextClose = false; throw new Error('synthetic OPFS write failure'); }
        this.content = pending;
      },
    };
  }
}
class VirtualDirectory {
  files = new Map();
  directories = new Map();
  failNextWrite = false;
  async getFileHandle(name, options = {}) {
    let file = this.files.get(name);
    if (!file && options.create) { file = new VirtualFile(); this.files.set(name, file); }
    if (!file) throw new DOMException('missing', 'NotFoundError');
    if (this.failNextWrite && options.create) { file.failNextClose = true; this.failNextWrite = false; }
    return file;
  }
  async getDirectoryHandle(name, options = {}) {
    let directory = this.directories.get(name);
    if (!directory && options.create) { directory = new VirtualDirectory(); this.directories.set(name, directory); }
    if (!directory) throw new DOMException('missing', 'NotFoundError');
    return directory;
  }
  async removeEntry(name) { this.files.delete(name); this.directories.delete(name); }
  async *entries() {
    for (const item of this.directories) yield item;
    for (const item of this.files) yield item;
  }
}
const opfsStorageRoot = new VirtualDirectory();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  storage: { getDirectory: async () => opfsStorageRoot },
  locks: { request: async (_name, _options, callback) => callback({ name: _name }) },
} });

const require = createRequire(import.meta.url);
const ts = require('typescript');
const sourcePath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1))), '..', 'src', 'features', 'search', 'SearchAllPage.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: sourcePath }).outputText;
const noopComponent = () => null;
const projectWorkspaceClient = { listProjectFiles: async () => { throw new Error('test must inject fetchPage'); }, cancelListProjectFiles: async () => undefined };
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
  GLOBAL_SEARCH_MAX_MOUNTED_RESULTS,
  GLOBAL_SEARCH_MAX_INDEX_RESIDENT_HITS,
  DiskBPlusTreeSearchStore,
  IndexedDbTreeBackend,
  OpfsTreeBackend,
  calculateGlobalSearchVirtualWindow,
  cancelGlobalSearchCursors,
  createRafSearchScrollScheduler,
  createSearchResultStore,
  createTrailingSearchRefreshScheduler,
  streamGlobalSearchSource,
} = loadedModule.exports;

assert.equal(GLOBAL_SEARCH_RESULT_PAGE_SIZE, 200);
assert.equal(GLOBAL_SEARCH_MAX_MOUNTED_RESULTS, 400);
const virtualModels = [0, 0.5, 1].map(fraction => {
  const top = calculateGlobalSearchVirtualWindow({ totalCount: 100_000, scrollTop: 0, viewportHeight: 800, containerWidth: 1_100 });
  return calculateGlobalSearchVirtualWindow({ totalCount: 100_000, scrollTop: Math.max(0, top.totalHeight * fraction - 800 * fraction), viewportHeight: 800, containerWidth: 1_100 });
});
for (const model of virtualModels) assert.ok(model.end - model.start <= GLOBAL_SEARCH_MAX_MOUNTED_RESULTS, 'DOM/React/MediaThumbnail window must remain bounded');
assert.equal(virtualModels[0].start, 0);
assert.ok(virtualModels[1].start > 40_000 && virtualModels[1].end < 60_000);
assert.equal(virtualModels[2].end, 100_000);

const rafCallbacks = []; const rafValues = [];
const rafScheduler = createRafSearchScrollScheduler(value => rafValues.push(value), callback => { rafCallbacks.push(callback); return rafCallbacks.length; }, () => undefined);
for (let value = 0; value < 10_000; value += 10) rafScheduler.push(value);
assert.equal(rafCallbacks.length, 1); rafCallbacks[0](); assert.deepEqual(rafValues, [9_990]);
const refreshCallbacks = []; const refreshed = [];
const refresh = createTrailingSearchRefreshScheduler(value => refreshed.push(value), 75, callback => { refreshCallbacks.push(callback); return 1; }, () => undefined);
for (let count = 200; count <= 100_000; count += 200) refresh.push(count);
assert.equal(refreshCallbacks.length, 1, 'stream updates must coalesce without changing continuous-window semantics');
refreshCallbacks[0](); assert.deepEqual(refreshed, [100_000]);

class MemoryTreeBackend {
  kind = 'opfs'; nodes = new Map(); values = new Map(); readGeneration = 0;
  nodeGets = 0; readNodeGets = 0; maxDirtyRows = 0; editCount = 0; readCount = 0;
  failEditAt = 0;
  scanNodeDelayMs = 0; scanNodeStarted = undefined; scanNodeGets = 0; scanFailure = undefined;
  async edit(operation) {
    this.editCount += 1;
    if (this.failEditAt === this.editCount) throw new Error('synthetic IndexedDB write failure');
    const cache = new Map(); const dirty = new Map(); const values = new Map();
    const flush = async () => {
      for (const [key, value] of dirty) this.nodes.set(key, structuredClone(value));
      for (const [key, value] of values) this.values.set(key, structuredClone(value));
      dirty.clear(); values.clear(); cache.clear();
    };
    const access = {
      getNode: async id => {
        if (!cache.has(id)) { this.nodeGets += 1; cache.set(id, structuredClone(this.nodes.get(id))); }
        return cache.get(id);
      },
      putNode: node => {
        cache.set(node.id, node); dirty.set(node.id, node);
        this.maxDirtyRows = Math.max(this.maxDirtyRows, [...dirty.values()].reduce((sum, item) => sum + (item.kind === 'leaf' ? item.rows.length : 0), 0));
      },
      getValue: async key => values.has(key) ? values.get(key) : structuredClone(this.values.get(key)),
      putValue: (key, value) => values.set(key, structuredClone(value)),
      flush,
    };
    const result = await operation(access);
    await flush();
    return result;
  }
  async read(operation) {
    const generation = ++this.readGeneration; this.readCount += 1;
    try {
      return await operation({
        getNode: async id => { await Promise.resolve(); if (generation !== this.readGeneration) throw new DOMException('stale', 'AbortError'); this.readNodeGets += 1; return structuredClone(this.nodes.get(id)); },
        putNode: () => { throw new Error('readonly'); }, getValue: async key => structuredClone(this.values.get(key)), putValue: () => { throw new Error('readonly'); }, flush: async () => undefined,
      });
    } catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return undefined; throw error; }
  }
  async scan(operation) {
    if (this.scanFailure) throw this.scanFailure;
    return operation({
      getNode: async id => {
        this.scanNodeStarted?.();
        if (this.scanNodeDelayMs) await new Promise(resolve => setTimeout(resolve, this.scanNodeDelayMs));
        this.scanNodeGets += 1;
        return structuredClone(this.nodes.get(id));
      },
      putNode: () => { throw new Error('readonly'); }, getValue: async key => structuredClone(this.values.get(key)), putValue: () => { throw new Error('readonly'); }, flush: async () => undefined,
    });
  }
  async dispose() { this.readGeneration += 1; }
}

const testSource = { id: 'project:stress', kind: 'project', label: 'Stress 2', workspacePath: '/workspace', project: { id: 'stress', name: 'Stress', path: '/workspace/Stress', workspacePath: '/workspace', status: 'active', updatedAt: 0 } };
const makeEntry = index => { const number = String(index).padStart(6, '0'); return { kind: 'file', extension: '.txt', name: `file${number}.txt`, path: `/workspace/Stress/folder/file${number}.txt`, relativePath: `folder/file${number}.txt`, parentRelativePath: 'folder' }; };
const makeFetcher = total => async (_source, _query, cursor) => {
  const start = cursor ? Number(cursor) : 0; const count = Math.min(200, total - start);
  const entries = Array.from({ length: count }, (_, offset) => makeEntry(start + count - offset - 1));
  const next = start + count; return { success: true, entries, cursor: next < total ? String(next) : '', hasMore: next < total };
};

const backend = new MemoryTreeBackend();
backend.kind = 'indexeddb';
const store = await DiskBPlusTreeSearchStore.open(backend);
const cursors = new Set();
let firstSnapshot;
const started = performance.now();
await streamGlobalSearchSource({ source: testSource, query: 'file', isCurrent: () => true, activeCursors: cursors, store, fetchPage: makeFetcher(100_000), cancelCursor: async () => undefined, onStored: snapshot => { firstSnapshot ||= snapshot; } });
await store.finalize();
const appendMilliseconds = performance.now() - started;
assert.equal(firstSnapshot.storedCount, 200, 'the first completed disk batch must be progressively visible');
assert.equal(firstSnapshot.groupsFinalized, false, 'progressive results must not claim that they span zero folders');
assert.equal(cursors.size, 0);
assert.ok(appendMilliseconds < 30_000, `100k index construction took ${appendMilliseconds.toFixed(0)}ms`);
assert.ok(backend.nodeGets < 50_000, `transaction-local cache and fixed write chunks must bound 100k node reads, got ${backend.nodeGets}`);
assert.ok(backend.maxDirtyRows <= 400, `index construction resident hit metadata must be bounded, got ${backend.maxDirtyRows}`);
assert.ok(backend.editCount <= 502, `100k ingestion must use one readwrite transaction per IPC batch plus finalize, got ${backend.editCount}`);
assert.equal((await store.append(testSource, [])).groupCount, 1, 'the disk snapshot must retain the global unique folder count');
assert.equal((await store.append(testSource, [])).groupsFinalized, true, 'the final snapshot must expose the completed folder count');

const first = (await store.readWindow(0, 200)).flatMap(group => group.entries);
const beforeMiddleGets = backend.readNodeGets;
const middle = (await store.readWindow(50_000, 200)).flatMap(group => group.entries);
const middleGets = backend.readNodeGets - beforeMiddleGets;
const beforeEndGets = backend.readNodeGets;
const end = (await store.readWindow(99_800, 200)).flatMap(group => group.entries);
const endGets = backend.readNodeGets - beforeEndGets;
assert.equal(first[0].name, 'file000000.txt'); assert.equal(middle[0].name, 'file050000.txt'); assert.equal(end.at(-1).name, 'file099999.txt');
assert.ok(middleGets < 20 && endGets < 20, `rank reads must be O(tree height + window leaves), got middle=${middleGets}, end=${endGets}`);
assert.ok(Math.max(first.length, middle.length, end.length) <= 200);
let traversed = 0;
for (let start = 0; start < 100_000; start += 200) traversed += (await store.readWindow(start, 200)).flatMap(group => group.entries).length;
assert.equal(traversed, 100_000, 'all results must remain accessible through one continuous sequence of bounded windows');

const readsBeforeRapid = backend.readCount;
const rapid = [10_000, 30_000, 70_000, 99_000].map(start => store.readWindow(start, 200));
const rapidResults = await Promise.all(rapid);
assert.deepEqual(rapidResults.slice(0, -1), [[], [], []], 'obsolete rapid-scroll windows must be cancelled');
assert.equal(rapidResults.at(-1).flatMap(group => group.entries)[0].name, 'file099000.txt');
assert.ok(backend.readCount - readsBeforeRapid <= 1, 'only the latest queued continuous-window read should execute');

let indexedAbortCount = 0; let indexedTransactionId = 0;
const fakeIndexedDatabase = { close: () => undefined, transaction: () => {
  const transactionId = ++indexedTransactionId; const requests = new Set();
  const transaction = { error: null, oncomplete: null, onabort: null, onerror: null, objectStore: () => ({ get: () => {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null }; requests.add(request);
    setImmediate(() => {
      if (transaction.error) return;
      request.result = transactionId === 1 ? undefined : { id: 'n0', kind: 'leaf', count: 0, maxKey: '', rows: [] };
      request.onsuccess?.(); setImmediate(() => transaction.oncomplete?.());
    });
    return request;
  } }), abort: () => {
    indexedAbortCount += 1; transaction.error = new DOMException('aborted', 'AbortError');
    for (const request of requests) { request.error = transaction.error; request.onerror?.(); }
    transaction.onabort?.();
  } };
  return transaction;
} };
const indexedReadBackend = new IndexedDbTreeBackend(fakeIndexedDatabase, 'fake-idb', { name: 'fake-idb', release: async () => undefined });
const obsoleteIndexedRead = indexedReadBackend.read(access => access.getNode('n0'));
const latestIndexedRead = indexedReadBackend.read(access => access.getNode('n0'));
assert.equal(await obsoleteIndexedRead, undefined, 'AbortError from an obsolete IndexedDB window must be silent');
assert.equal((await latestIndexedRead).id, 'n0');
assert.equal(indexedAbortCount, 1, 'starting a newer IndexedDB window must abort the old readonly transaction');

const disorderBackend = new MemoryTreeBackend(); const disorderStore = await DiskBPlusTreeSearchStore.open(disorderBackend);
await disorderStore.append(testSource, [makeEntry(20), makeEntry(2), makeEntry(11), { ...makeEntry(2), name: 'file000002.txt' }]);
await disorderStore.append(testSource, [makeEntry(10), makeEntry(1), makeEntry(3)]);
const disorderNames = (await disorderStore.readWindow(0, 20)).flatMap(group => group.entries).map(entry => entry.name);
assert.deepEqual(disorderNames, [...disorderNames].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), 'cross-batch disorder must still produce one globally natural order');
assert.equal(disorderNames.filter(name => name === 'file000002.txt').length, 2, 'duplicate keys must remain stable and accessible');

const makeFolderEntry = (folderIndex, inserted = false) => {
  const folder = `folder${String(folderIndex).padStart(6, '0')}`; const name = inserted ? 'insert.txt' : 'base.txt';
  return { kind: 'file', extension: '.txt', name, path: `/workspace/Stress/${folder}/${name}`, relativePath: `${folder}/${name}`, parentRelativePath: folder };
};
const scatteredBackend = new MemoryTreeBackend(); const scatteredStore = await DiskBPlusTreeSearchStore.open(scatteredBackend);
for (let start = 0; start < 10_000; start += 200) await scatteredStore.append(testSource, Array.from({ length: 200 }, (_, offset) => makeFolderEntry(start + offset)));
scatteredBackend.maxDirtyRows = 0; const scatteredGetsBefore = scatteredBackend.nodeGets; const scatteredStarted = performance.now();
const scatteredSnapshot = await scatteredStore.append(testSource, Array.from({ length: 200 }, (_, index) => makeFolderEntry(index * 50, true)));
const scatteredMilliseconds = performance.now() - scatteredStarted; const scatteredGets = scatteredBackend.nodeGets - scatteredGetsBefore;
const scatteredFinalSnapshot = await scatteredStore.finalize();
assert.equal(scatteredSnapshot.groupCount, 0, 'folder counting may wait until ingestion completes');
assert.equal(scatteredSnapshot.groupsFinalized, false);
assert.equal(scatteredFinalSnapshot.groupCount, 10_000, 'bounded sorted traversal must count folders without marker files or a resident full Set');
assert.equal(scatteredFinalSnapshot.groupsFinalized, true);
assert.ok(scatteredBackend.maxDirtyRows <= GLOBAL_SEARCH_MAX_INDEX_RESIDENT_HITS, `a 200-hit batch scattered across old leaves retained ${scatteredBackend.maxDirtyRows} hits`);
assert.ok(scatteredMilliseconds < 2_000, `scattered 200-hit append took ${scatteredMilliseconds.toFixed(0)}ms`);
assert.ok(scatteredGets < 1_000, `scattered fixed-chunk append issued ${scatteredGets} node reads`);

const failedStatsBackend = new MemoryTreeBackend(); const failedStatsStore = await DiskBPlusTreeSearchStore.open(failedStatsBackend);
await failedStatsStore.append(testSource, Array.from({ length: 1_000 }, (_, index) => makeEntry(index)));
failedStatsBackend.scanFailure = new Error('synthetic statistics failure');
const failedStatsSnapshot = await failedStatsStore.finalize();
assert.equal(failedStatsSnapshot.groupsFinalized, false, 'folder statistics failure must remain auxiliary');
assert.equal((await failedStatsStore.readWindow(0, 1_000)).flatMap(group => group.entries).length, 1_000, 'statistics failure must preserve the complete readable index');

let releaseFinalizeStart;
const finalizeStartedReading = new Promise(resolve => { releaseFinalizeStart = resolve; });
scatteredBackend.scanNodeDelayMs = 5;
scatteredBackend.scanNodeStarted = () => { scatteredBackend.scanNodeStarted = undefined; releaseFinalizeStart(); };
const nodesBeforeCancelledFinalize = scatteredBackend.scanNodeGets;
const cancelledFinalize = scatteredStore.finalize();
const cancelledFinalizeRejected = assert.rejects(cancelledFinalize, error => error instanceof DOMException && error.name === 'AbortError');
await finalizeStartedReading;
const concurrentReadStarted = performance.now();
assert.equal((await scatteredStore.readWindow(5_000, 200)).flatMap(group => group.entries).length, 200, 'a normal window must remain readable during folder statistics');
assert.ok(performance.now() - concurrentReadStarted < 150, 'folder statistics must not serialize ordinary window reads');
const disposeStarted = performance.now();
await scatteredStore.dispose();
const disposeMilliseconds = performance.now() - disposeStarted;
await cancelledFinalizeRejected;
assert.ok(scatteredBackend.scanNodeGets - nodesBeforeCancelledFinalize < 10, 'disposing must stop finalize without scanning the remaining tree');
assert.ok(disposeMilliseconds < 150, `dispose waited ${disposeMilliseconds.toFixed(0)}ms for a cancelled finalize`);
await assert.rejects(scatteredStore.append(testSource, [makeEntry(1)]), error => error instanceof DOMException && error.name === 'AbortError');
assert.deepEqual(await scatteredStore.readWindow(0, 10), [], 'a disposed store must not publish another read window');

const opfsRoot = new VirtualDirectory(); const opfsDirectory = await opfsRoot.getDirectoryHandle('session', { create: true });
const fakeLease = { name: 'session', release: async () => undefined };
const opfsStore = await DiskBPlusTreeSearchStore.open(new OpfsTreeBackend(opfsRoot, opfsDirectory, 'session', fakeLease));
await opfsStore.append(testSource, [makeEntry(1)]);
opfsDirectory.failNextWrite = true;
await assert.rejects(opfsStore.append(testSource, [makeEntry(2)]), /synthetic OPFS write failure/);
await assert.rejects(opfsStore.readWindow(0, 10), /OPFS 临时索引已失效/, 'a partial non-transactional write must invalidate the whole tree');
await opfsStore.dispose();

const savedIndexedDb = globalThis.indexedDB;
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { databases: async () => [], open: () => { throw new Error('synthetic IDB open failure'); } } });
const fallback = await createSearchResultStore();
assert.equal(fallback.store.storageKind, 'opfs', 'IndexedDB open failure must select real OPFS storage');
await fallback.store.append(testSource, [makeEntry(7), makeEntry(6)]);
assert.deepEqual((await fallback.store.readWindow(0, 10)).flatMap(group => group.entries).map(entry => entry.name), ['file000006.txt', 'file000007.txt']);
await fallback.store.dispose();
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: savedIndexedDb });

const failingBackend = new MemoryTreeBackend(); failingBackend.kind = 'indexeddb'; failingBackend.failEditAt = 3;
const failingStore = await DiskBPlusTreeSearchStore.open(failingBackend); const failedWriteCursors = new Set(); const failedWriteCancelled = [];
await assert.rejects(streamGlobalSearchSource({ source: testSource, query: 'file', isCurrent: () => true, activeCursors: failedWriteCursors, store: failingStore, fetchPage: makeFetcher(1_000), cancelCursor: async cursor => { failedWriteCancelled.push(cursor); } }), /synthetic IndexedDB write failure/);
assert.equal(failedWriteCursors.size, 0, 'a mid-scan disk write failure must not leak an IPC cursor');
assert.deepEqual(failedWriteCancelled, ['400'], 'the cursor returned with the failed write must be cancelled');
const recoveredStore = await loadedModule.exports.createOpfsSearchStore();
await streamGlobalSearchSource({ source: testSource, query: 'file', isCurrent: () => true, activeCursors: new Set(), store: recoveredStore, fetchPage: makeFetcher(1_000), cancelCursor: async () => undefined });
assert.equal((await recoveredStore.readWindow(980, 20)).flatMap(group => group.entries).at(-1).name, 'file000999.txt', 'OPFS recovery must rebuild the complete scan, not expose the partial IndexedDB tree');
await Promise.all([failingStore.dispose(), recoveredStore.dispose()]);

let current = true; let releaseSecond; const second = new Promise(resolve => { releaseSecond = resolve; }); const cancelled = []; let fetchCount = 0;
const switching = streamGlobalSearchSource({ source: testSource, query: 'old', isCurrent: () => current, activeCursors: cursors, store: disorderStore, fetchPage: async () => ++fetchCount === 1 ? { success: true, entries: [], cursor: 'c1', hasMore: true } : second, cancelCursor: async cursor => { cancelled.push(cursor); } });
while (fetchCount < 2) await new Promise(resolve => setImmediate(resolve));
current = false; await cancelGlobalSearchCursors(cursors, async cursor => { cancelled.push(cursor); }); releaseSecond({ success: true, entries: [], cursor: 'c2', hasMore: true }); await switching;
assert.deepEqual(cancelled.sort(), ['c1', 'c2']);

await Promise.all([store.dispose(), disorderStore.dispose(), failedStatsStore.dispose()]);
console.log(`global search 100k stress tests passed (${appendMilliseconds.toFixed(0)}ms append, ${backend.nodeGets} cached node reads, middle/end ${middleGets}/${endGets}; scattered ${scatteredMilliseconds.toFixed(0)}ms/${scatteredGets} reads/${scatteredBackend.maxDirtyRows} resident hits)`);
