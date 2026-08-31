import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, File, FileImage, FileVideo, Folder, Loader2, Search, X } from 'lucide-react';
import type { AppConfig, ProjectFileEntry, WorkspaceProject } from '../../types';
import { normalizeWorkspacePaths } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { MediaThumbnail } from '../workspace/ProjectWorkspace';

const INSPIRATION_PROJECT_NAME = '.__photoflow_inspiration__';
const SEARCH_PAGE_SIZE = 200;
const SEARCH_CONCURRENCY = 4;
export const GLOBAL_SEARCH_RESULT_PAGE_SIZE = 200;
export const GLOBAL_SEARCH_MEMORY_FALLBACK_LIMIT = GLOBAL_SEARCH_RESULT_PAGE_SIZE * 2;
const SEARCH_DATABASE_PREFIX = 'photoflow-global-search-tmp-';

export type GlobalSearchSource = {
  id: string;
  kind: 'project' | 'inspiration';
  label: string;
  workspacePath: string;
  project: WorkspaceProject;
};

type SearchHit = { source: GlobalSearchSource; entry: ProjectFileEntry };
type SearchGroup = { id: string; source: GlobalSearchSource; folderPath: string; entries: ProjectFileEntry[]; totalCount: number };
type StoredSearchHit = { orderKey: string; groupKey: string; hit: SearchHit };
type SearchStoreSnapshot = { storedCount: number; totalCount: number; groupCount: number; truncated: boolean };

class SearchStorageError extends Error {}

export type GlobalSearchResultStore = {
  append: (source: GlobalSearchSource, entries: ProjectFileEntry[]) => Promise<SearchStoreSnapshot>;
  readPage: (pageIndex: number, pageSize: number) => Promise<SearchGroup[]>;
  dispose: () => Promise<void>;
};

export type GlobalSearchPageFetcher = (
  source: GlobalSearchSource,
  query: string,
  cursor: string | undefined,
) => ReturnType<typeof projectWorkspaceClient.listProjectFiles>;

// eslint-disable-next-line react-refresh/only-export-components
export const cancelGlobalSearchCursors = async (
  cursors: Set<string>,
  cancelCursor: (cursor: string) => Promise<unknown> = cursor => projectWorkspaceClient.cancelListProjectFiles(cursor),
) => {
  const pending = [...cursors];
  cursors.clear();
  await Promise.allSettled(pending.map(cursor => cancelCursor(cursor)));
};

// eslint-disable-next-line react-refresh/only-export-components
export const createTrailingSearchRefreshScheduler = <T,>(
  apply: (value: T) => void,
  delay = 75,
  schedule: (callback: () => void, milliseconds: number) => number = (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  cancel: (timer: number) => void = timer => window.clearTimeout(timer),
) => {
  let pending: T | undefined;
  let timer: number | undefined;
  const applyPending = () => {
    timer = undefined;
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    apply(value);
  };
  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    pending = undefined;
  };
  return {
    push(value: T) {
      pending = value;
      if (timer === undefined) timer = schedule(applyPending, delay);
    },
    flush() {
      if (timer !== undefined) cancel(timer);
      applyPending();
    },
    clear,
  };
};

const normalizePathKey = (value: string) => value.trim().replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();

const naturalSortKey = (value: string) => value.normalize('NFKD').toLocaleLowerCase().replace(/\d+/g, digits => {
  const normalized = digits.replace(/^0+(?=\d)/, '');
  return `\u0001${String(normalized.length).padStart(10, '0')}:${normalized}`;
});

const folderPathForEntry = (entry: ProjectFileEntry) => (
  entry.parentRelativePath || entry.relativePath.split(/[\\/]/).slice(0, -1).join('/')
).replace(/\\/g, '/');

const storedHit = (source: GlobalSearchSource, entry: ProjectFileEntry): StoredSearchHit => {
  const folderPath = folderPathForEntry(entry);
  const groupKey = `${source.id}\u0000${folderPath}`;
  return {
    groupKey,
    orderKey: [source.label, folderPath, entry.name, source.id, entry.relativePath, entry.path]
      .map(naturalSortKey).join('\u0000'),
    hit: { source, entry },
  };
};

const groupPageHits = (rows: Array<StoredSearchHit & { groupTotal: number }>): SearchGroup[] => {
  const groups = new Map<string, SearchGroup>();
  for (const row of rows) {
    const folderPath = folderPathForEntry(row.hit.entry);
    const group = groups.get(row.groupKey) || {
      id: row.groupKey,
      source: row.hit.source,
      folderPath,
      entries: [],
      totalCount: row.groupTotal,
    };
    group.entries.push(row.hit.entry);
    groups.set(row.groupKey, group);
  }
  return [...groups.values()];
};

// eslint-disable-next-line react-refresh/only-export-components
export class MemoryBoundedSearchStore implements GlobalSearchResultStore {
  private rows: StoredSearchHit[] = [];
  private totalCount = 0;
  private pageLoader?: (pageIndex: number, pageSize: number, isLoadCurrent: () => boolean) => Promise<SearchGroup[]>;
  private pageLoadSequence = 0;

  async append(source: GlobalSearchSource, entries: ProjectFileEntry[]) {
    this.totalCount += entries.length;
    this.rows = [...this.rows, ...entries.map(entry => storedHit(source, entry))]
      .sort((left, right) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0)
      .slice(0, GLOBAL_SEARCH_MEMORY_FALLBACK_LIMIT);
    return this.snapshot();
  }

  async readPage(pageIndex: number, pageSize: number) {
    if (this.pageLoader) {
      const sequence = ++this.pageLoadSequence;
      return this.pageLoader(pageIndex, pageSize, () => this.pageLoadSequence === sequence);
    }
    const page = this.rows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const counts = new Map<string, number>();
    for (const row of this.rows) counts.set(row.groupKey, (counts.get(row.groupKey) || 0) + 1);
    return groupPageHits(page.map(row => ({ ...row, groupTotal: counts.get(row.groupKey) || 0 })));
  }

  async dispose() { this.pageLoadSequence += 1; this.rows = []; }

  setPageLoader(loader: (pageIndex: number, pageSize: number, isLoadCurrent: () => boolean) => Promise<SearchGroup[]>) {
    this.pageLoader = loader;
  }

  private snapshot(): SearchStoreSnapshot {
    return {
      storedCount: this.totalCount,
      totalCount: this.totalCount,
      groupCount: new Set(this.rows.map(row => row.groupKey)).size,
      truncated: false,
    };
  }
}

const requestResult = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
});

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
});

// eslint-disable-next-line react-refresh/only-export-components
export class IndexedDbSearchStore implements GlobalSearchResultStore {
  private totalCount = 0;
  private storedCount = 0;
  private groupCount = 0;
  private readonly database: IDBDatabase;
  private readonly databaseName: string;

  constructor(database: IDBDatabase, databaseName: string) {
    this.database = database;
    this.databaseName = databaseName;
  }

  async append(source: GlobalSearchSource, entries: ProjectFileEntry[]) {
    if (!entries.length) return this.snapshot();
    const transaction = this.database.transaction(['hits', 'groups'], 'readwrite');
    const done = transactionDone(transaction);
    const hitStore = transaction.objectStore('hits');
    const groupStore = transaction.objectStore('groups');
    for (const entry of entries) {
      const row = storedHit(source, entry);
      hitStore.add(row);
      groupStore.put({ groupKey: row.groupKey });
    }
    try {
      await done;
    } catch (storageError) {
      throw new SearchStorageError(storageError instanceof Error ? storageError.message : String(storageError));
    }
    this.totalCount += entries.length;
    this.storedCount += entries.length;
    try {
      this.groupCount = await requestResult(this.database.transaction('groups').objectStore('groups').count());
    } catch (storageError) {
      throw new SearchStorageError(storageError instanceof Error ? storageError.message : String(storageError));
    }
    return this.snapshot();
  }

  async readPage(pageIndex: number, pageSize: number) {
    const transaction = this.database.transaction('hits');
    const done = transactionDone(transaction);
    const store = transaction.objectStore('hits');
    const index = store.index('orderKey');
    const rows = await new Promise<StoredSearchHit[]>((resolve, reject) => {
      const output: StoredSearchHit[] = [];
      const request = index.openCursor();
      let skipped = pageIndex === 0;
      request.onerror = () => reject(request.error || new Error('无法读取搜索结果'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || output.length >= pageSize) return resolve(output);
        if (!skipped) {
          skipped = true;
          cursor.advance(pageIndex * pageSize);
          return;
        }
        output.push(cursor.value as StoredSearchHit);
        cursor.continue();
      };
    });
    await done;
    const groupTransaction = this.database.transaction('hits');
    const groupDone = transactionDone(groupTransaction);
    const groupIndex = groupTransaction.objectStore('hits').index('groupKey');
    const groupTotals = new Map<string, number>();
    await Promise.all([...new Set(rows.map(row => row.groupKey))].map(async groupKey => {
      groupTotals.set(groupKey, await requestResult(groupIndex.count(IDBKeyRange.only(groupKey))));
    }));
    await groupDone;
    return groupPageHits(rows.map(row => ({ ...row, groupTotal: groupTotals.get(row.groupKey) || 0 })));
  }

  async dispose() {
    this.database.close();
    await new Promise<void>(resolve => {
      const request = indexedDB.deleteDatabase(this.databaseName);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }

  private snapshot(): SearchStoreSnapshot {
    return { storedCount: this.storedCount, totalCount: this.totalCount, groupCount: this.groupCount, truncated: false };
  }
}

let orphanCleanupPromise: Promise<void> | null = null;
const cleanupOrphanedSearchDatabases = () => {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  if (orphanCleanupPromise) return orphanCleanupPromise;
  const databaseList = indexedDB.databases;
  if (!databaseList) return (orphanCleanupPromise = Promise.resolve());
  orphanCleanupPromise = (async () => {
    try {
      const databases = await databaseList.call(indexedDB);
      await Promise.all(databases.filter(database => database.name?.startsWith(SEARCH_DATABASE_PREFIX)).map(database => new Promise<void>(resolve => {
        const request = indexedDB.deleteDatabase(database.name!);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      })));
    } catch {
      // Cleanup is best-effort; opening a fresh session below remains safe.
    }
  })();
  return orphanCleanupPromise;
};

void cleanupOrphanedSearchDatabases();

const createSearchResultStore = async (): Promise<{ store: GlobalSearchResultStore; degraded: boolean }> => {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB 不可用');
    await cleanupOrphanedSearchDatabases();
    const databaseName = `${SEARCH_DATABASE_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      const hits = database.createObjectStore('hits', { autoIncrement: true });
      hits.createIndex('orderKey', 'orderKey');
      hits.createIndex('groupKey', 'groupKey');
      database.createObjectStore('groups', { keyPath: 'groupKey' });
    };
    return { store: new IndexedDbSearchStore(await requestResult(request), databaseName), degraded: false };
  } catch {
    return { store: new MemoryBoundedSearchStore(), degraded: true };
  }
};

const entryTypeLabel = (entry: ProjectFileEntry) => {
  if (entry.kind === 'video') return '视频';
  if (entry.kind === 'image') return '图片';
  if (entry.kind === 'raw') return 'RAW';
  if (entry.kind === 'shortcut') return '快捷方式';
  return entry.extension ? entry.extension.replace(/^\./, '').toLocaleUpperCase() : '文件';
};

const discoverSources = async (config: AppConfig): Promise<{ sources: GlobalSearchSource[]; errors: string[] }> => {
  const roots = normalizeWorkspacePaths(config.workspacePath, config.workspacePaths);
  const catalogs = await Promise.all(roots.map(async requestedRoot => {
    try {
      return { requestedRoot, result: await projectWorkspaceClient.getWorkspaceProjects(requestedRoot) };
    } catch(catalogError) {
      return { requestedRoot, result: { success: false as const, statuses: [], error: catalogError instanceof Error ? catalogError.message : String(catalogError) } };
    }
  }));
  const errors: string[] = [];
  const projectSources: GlobalSearchSource[] = [];
  const seenPaths = new Set<string>();
  for (const { requestedRoot, result } of catalogs) {
    if (!result.success) {
      errors.push(`${requestedRoot}：${result.error || '无法读取项目'}`);
      continue;
    }
    for (const project of result.statuses.flatMap(group => group.projects)) {
      if (project.availability === 'missing' || project.archived) continue;
      const key = normalizePathKey(project.path);
      if (!key || seenPaths.has(key)) continue;
      seenPaths.add(key);
      const workspacePath = project.workspacePath || result.root || requestedRoot;
      projectSources.push({
        id: `project:${key}`,
        kind: 'project',
        label: project.name,
        workspacePath,
        project: { ...project, workspacePath },
      });
    }
  }
  const inspirationRoot = config.inspirationLibrary.rootPath.trim();
  const sources: GlobalSearchSource[] = inspirationRoot ? [{
    id: `inspiration:${normalizePathKey(inspirationRoot)}`,
    kind: 'inspiration' as const,
    label: '灵感库',
    workspacePath: inspirationRoot,
    project: {
      id: `inspiration:${inspirationRoot}`,
      name: INSPIRATION_PROJECT_NAME,
      path: inspirationRoot,
      workspacePath: inspirationRoot,
      status: '未分类',
      updatedAt: Date.now(),
    },
  }, ...projectSources] : projectSources;
  sources.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN', { numeric: true, sensitivity: 'base' })
    || left.id.localeCompare(right.id, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  return { sources, errors };
};

// eslint-disable-next-line react-refresh/only-export-components
export const streamGlobalSearchSource = async ({
  source,
  query,
  isCurrent,
  activeCursors,
  store,
  fetchPage = (currentSource, currentQuery, cursor) => projectWorkspaceClient.listProjectFiles(
    currentSource.workspacePath,
    currentSource.project.status,
    currentSource.project.name,
    '',
    SEARCH_PAGE_SIZE,
    cursor,
    { query: currentQuery },
  ),
  cancelCursor = cursor => projectWorkspaceClient.cancelListProjectFiles(cursor),
  onStored,
}: {
  source: GlobalSearchSource;
  query: string;
  isCurrent: () => boolean;
  activeCursors: Set<string>;
  store: GlobalSearchResultStore;
  fetchPage?: GlobalSearchPageFetcher;
  cancelCursor?: (cursor: string) => Promise<unknown>;
  onStored?: (snapshot: SearchStoreSnapshot) => void;
}) => {
  let cursor = '';
  do {
    if (cursor) activeCursors.add(cursor);
    let result: Awaited<ReturnType<GlobalSearchPageFetcher>>;
    try {
      result = await fetchPage(source, query, cursor || undefined);
    } catch (fetchError) {
      if (cursor && activeCursors.delete(cursor)) await cancelCursor(cursor);
      throw fetchError;
    }
    if (cursor) activeCursors.delete(cursor);
    if (!isCurrent()) {
      const staleCursor = result.cursor || cursor;
      if (staleCursor) await cancelCursor(staleCursor);
      return;
    }
    if (!result.success) {
      const failedCursor = result.cursor || cursor;
      if (failedCursor) await cancelCursor(failedCursor);
      throw new Error(result.error || '读取文件失败');
    }
    const nextCursor = result.cursor || '';
    if (result.hasMore && nextCursor) activeCursors.add(nextCursor);
    let snapshot: SearchStoreSnapshot;
    try {
      snapshot = await store.append(source, result.entries);
    } catch (appendError) {
      if (nextCursor && activeCursors.delete(nextCursor)) await cancelCursor(nextCursor);
      throw appendError;
    }
    if (!isCurrent()) {
      if (nextCursor && activeCursors.delete(nextCursor)) await cancelCursor(nextCursor);
      return;
    }
    onStored?.(snapshot);
    cursor = nextCursor;
    if (!result.hasMore) {
      if (cursor) activeCursors.delete(cursor);
      break;
    }
  } while (cursor);
};

// eslint-disable-next-line react-refresh/only-export-components
export const rescanGlobalSearchPage = async ({
  sources,
  query,
  pageIndex,
  pageSize,
  isCurrent,
  activeCursors,
  fetchPage,
  cancelCursor,
}: {
  sources: GlobalSearchSource[];
  query: string;
  pageIndex: number;
  pageSize: number;
  isCurrent: () => boolean;
  activeCursors: Set<string>;
  fetchPage?: GlobalSearchPageFetcher;
  cancelCursor?: (cursor: string) => Promise<unknown>;
}) => {
  const selected: StoredSearchHit[] = [];
  const start = pageIndex * pageSize;
  const end = start + pageSize;
  let seen = 0;
  let pageComplete = false;
  const windowStore: GlobalSearchResultStore = {
    append: async (source, entries) => {
      for (const entry of entries) {
        if (seen >= start && seen < end) selected.push(storedHit(source, entry));
        seen += 1;
        if (seen >= end) {
          pageComplete = true;
          break;
        }
      }
      return { storedCount: seen, totalCount: seen, groupCount: 0, truncated: false };
    },
    readPage: async () => [],
    dispose: async () => { selected.length = 0; },
  };
  for (const source of sources) {
    if (!isCurrent() || pageComplete) break;
    await streamGlobalSearchSource({ source, query, isCurrent: () => isCurrent() && !pageComplete, activeCursors, store: windowStore, fetchPage, cancelCursor });
  }
  selected.sort((left, right) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0);
  const counts = new Map<string, number>();
  for (const row of selected) counts.set(row.groupKey, (counts.get(row.groupKey) || 0) + 1);
  return groupPageHits(selected.map(row => ({ ...row, groupTotal: counts.get(row.groupKey) || 0 })));
};

const SearchResultIcon = ({ entry, config, queueOrder }: { entry: ProjectFileEntry; config: AppConfig; queueOrder: number }) => {
  if (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') {
    return <MediaThumbnail entry={entry} cacheConfig={config.mediaCache} requestedSize={320} queueOrder={queueOrder}/>;
  }
  if (entry.kind === 'shortcut') return <Folder size={46} strokeWidth={1.4} className="text-blue-500"/>;
  if (entry.extension.match(/^\.(jpe?g|png|gif|webp|bmp|tiff?)$/i)) return <FileImage size={42} strokeWidth={1.4} className="text-violet-500"/>;
  if (entry.extension.match(/^\.(mp4|mov|mkv|avi|webm)$/i)) return <FileVideo size={42} strokeWidth={1.4} className="text-rose-500"/>;
  return <File size={42} strokeWidth={1.4} className="text-slate-400"/>;
};

export const SearchAllPage = ({ active, config, onOpenFolder, onNotice }: {
  active: boolean;
  config: AppConfig;
  onOpenFolder: (source: GlobalSearchSource, relativePath: string) => void;
  onNotice: (message: string, durationOrTone?: number | 'info' | 'success' | 'warning' | 'error') => void;
}) => {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [completedSources, setCompletedSources] = useState(0);
  const [sourceCount, setSourceCount] = useState(0);
  const [resultCount, setResultCount] = useState(0);
  const [storedCount, setStoredCount] = useState(0);
  const [groupCount, setGroupCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [storeRevision, setStoreRevision] = useState(0);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSequenceRef = useRef(0);
  const activeStoreRef = useRef<GlobalSearchResultStore | null>(null);
  const activeCursorsRef = useRef(new Set<string>());
  const pageReadSequenceRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!active) return;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [active]);

  useEffect(() => {
    const sequence = ++requestSequenceRef.current;
    const isCurrent = () => requestSequenceRef.current === sequence;
    const refreshScheduler = createTrailingSearchRefreshScheduler<SearchStoreSnapshot>(snapshot => {
      if (!isCurrent()) return;
      setResultCount(snapshot.totalCount);
      setStoredCount(snapshot.storedCount);
      setGroupCount(snapshot.groupCount);
      setStoreRevision(value => value + 1);
    });
    const previousStore = activeStoreRef.current;
    activeStoreRef.current = null;
    if (previousStore) void previousStore.dispose();
    void cancelGlobalSearchCursors(activeCursorsRef.current);
    setSelectedId('');
    setPageIndex(0);
    setGroups([]);
    setResultCount(0);
    setStoredCount(0);
    setGroupCount(0);
    setDegraded(false);
    if (!active || !debouncedQuery) {
      setLoading(false);
      if (!debouncedQuery) {
        setError('');
        setCompletedSources(0);
        setSourceCount(0);
      }
      return;
    }
    setLoading(true);
    setError('');
    setCompletedSources(0);
    setSourceCount(0);
    void (async () => {
      const discovery = await discoverSources(config);
      if (!isCurrent()) return;
      setSourceCount(discovery.sources.length);
      const scanWithStore = async (store: GlobalSearchResultStore) => {
        const failures = [...discovery.errors];
        let nextSourceIndex = 0;
        const isAttemptCurrent = () => isCurrent() && activeStoreRef.current === store;
        const worker = async () => {
          while (isAttemptCurrent()) {
            const sourceIndex = nextSourceIndex++;
            const source = discovery.sources[sourceIndex];
            if (!source) return;
            try {
              await streamGlobalSearchSource({
                source,
                query: debouncedQuery,
                isCurrent: isAttemptCurrent,
                activeCursors: activeCursorsRef.current,
                store,
                onStored: snapshot => {
                  if (!isAttemptCurrent()) return;
                  refreshScheduler.push(snapshot);
                },
              });
            } catch (sourceError) {
              if (sourceError instanceof SearchStorageError) throw sourceError;
              failures.push(`${source.label}：${sourceError instanceof Error ? sourceError.message : String(sourceError)}`);
            } finally {
              if (isAttemptCurrent()) setCompletedSources(value => value + 1);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, discovery.sources.length) }, () => worker()));
        return failures;
      };

      let storage = await createSearchResultStore();
      if (!isCurrent()) {
        await storage.store.dispose();
        return;
      }
      activeStoreRef.current = storage.store;
      setDegraded(storage.degraded);
      let failures: string[];
      try {
        failures = await scanWithStore(storage.store);
      } catch (storageError) {
        if (!(storageError instanceof SearchStorageError) || !isCurrent()) throw storageError;
        activeStoreRef.current = null;
        await cancelGlobalSearchCursors(activeCursorsRef.current);
        await storage.store.dispose();
        refreshScheduler.clear();
        storage = { store: new MemoryBoundedSearchStore(), degraded: true };
        activeStoreRef.current = storage.store;
        setDegraded(true);
        setCompletedSources(0);
        setGroups([]);
        setResultCount(0);
        setStoredCount(0);
        setGroupCount(0);
        failures = await scanWithStore(storage.store);
      }
      if (!isCurrent() || activeStoreRef.current !== storage.store) return;
      refreshScheduler.flush();
      if (storage.store instanceof MemoryBoundedSearchStore) {
        storage.store.setPageLoader((requestedPage, requestedSize, isLoadCurrent) => rescanGlobalSearchPage({
          sources: discovery.sources,
          query: debouncedQuery,
          pageIndex: requestedPage,
          pageSize: requestedSize,
          isCurrent: () => isCurrent() && isLoadCurrent() && activeStoreRef.current === storage.store,
          activeCursors: activeCursorsRef.current,
        }));
        setStoreRevision(value => value + 1);
      }
      setDegraded(storage.degraded);
      const messages = [];
      if (storage.degraded) messages.push('临时结果存储不可用，翻页时将重新扫描；全部结果仍可浏览');
      if (failures.length) messages.push(`${failures.length} 个位置暂时无法检索，其余结果已显示`);
      setError(messages.join('；'));
    })().catch(searchError => {
      if (isCurrent()) setError(searchError instanceof Error ? searchError.message : String(searchError));
    }).finally(() => {
      if (isCurrent()) setLoading(false);
    });
    return () => {
      requestSequenceRef.current += 1;
      refreshScheduler.clear();
      void cancelGlobalSearchCursors(activeCursorsRef.current);
      const store = activeStoreRef.current;
      activeStoreRef.current = null;
      if (store) void store.dispose();
    };
  }, [active, config, debouncedQuery]);

  useEffect(() => {
    const store = activeStoreRef.current;
    if (!store) return;
    const sequence = requestSequenceRef.current;
    const pageReadSequence = ++pageReadSequenceRef.current;
    void store.readPage(pageIndex, GLOBAL_SEARCH_RESULT_PAGE_SIZE).then(pageGroups => {
      if (requestSequenceRef.current === sequence && pageReadSequenceRef.current === pageReadSequence && activeStoreRef.current === store) setGroups(pageGroups);
    }).catch(pageError => {
      if (requestSequenceRef.current === sequence && pageReadSequenceRef.current === pageReadSequence) setError(pageError instanceof Error ? pageError.message : String(pageError));
    });
    return () => { pageReadSequenceRef.current += 1; };
  }, [pageIndex, storeRevision]);

  const pageHitCount = useMemo(() => groups.reduce((count, group) => count + group.entries.length, 0), [groups]);
  const pageCount = Math.max(1, Math.ceil(storedCount / GLOBAL_SEARCH_RESULT_PAGE_SIZE));

  const openEntry = async (source: GlobalSearchSource, entry: ProjectFileEntry) => {
    try {
      const result = await projectWorkspaceClient.openProjectEntry(source.workspacePath, source.project.status, source.project.name, entry.relativePath);
      if (!result.success) onNotice(`打开文件失败：${result.error || '未知错误'}`, 'error');
    } catch (openError) {
      onNotice(`打开文件失败：${openError instanceof Error ? openError.message : String(openError)}`, 'error');
    }
  };

  const openFolder = async (group: SearchGroup) => {
    try {
      await Promise.resolve(onOpenFolder(group.source, group.folderPath));
    } catch (openError) {
      onNotice(`打开文件夹失败：${openError instanceof Error ? openError.message : String(openError)}`, 'error');
    }
  };

  return <section className="flex h-full min-h-0 flex-col bg-slate-50">
    <header className="shrink-0 border-b border-slate-200 bg-white px-7 py-5">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-4">
          <div><h1 className="text-xl font-bold text-slate-900">全局搜索</h1><p className="mt-1 text-xs text-slate-500">检索所有项目工作目录与灵感库中的文件</p></div>
          {loading && <p role="status" aria-live="polite" className="flex shrink-0 items-center gap-2 text-xs text-blue-600"><Loader2 size={14} className="animate-spin"/>正在检索 {completedSources}/{sourceCount || '…'}</p>}
        </div>
        <div className="mt-4 flex h-11 items-center gap-3 rounded-xl border border-slate-300 bg-slate-50 px-4 shadow-sm focus-within:border-blue-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100">
          <Search size={19} className="shrink-0 text-slate-400"/>
          <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入文件名关键词" aria-label="全局搜索文件" className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"/>
          {query && <button type="button" onClick={() => setQuery('')} aria-label="清除搜索" title="清除搜索" className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X size={16}/></button>}
        </div>
        {debouncedQuery && <p role="status" aria-live="polite" className="mt-3 text-xs text-slate-500">{loading ? '已找到' : '找到'} <span className="font-bold text-slate-700">{resultCount}</span> 个文件{degraded ? '（有界重新扫描分页）' : `，分布在 ${groupCount} 个文件夹中`}</p>}
        {error && <p role="alert" className="mt-2 text-xs text-amber-600">{error}</p>}
      </div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
      <div className="mx-auto max-w-6xl pb-8">
        {!debouncedQuery && <div className="flex min-h-[360px] items-center justify-center text-center"><div><span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-500"><Search size={30}/></span><h2 className="mt-5 text-base font-bold text-slate-700">查找项目中的任意文件</h2><p className="mt-2 text-sm text-slate-400">输入文件名关键词，结果会按项目和文件夹整理</p></div></div>}
        {debouncedQuery && loading && !pageHitCount && <p className="py-20 text-center text-sm text-slate-400"><Loader2 size={18} className="mr-2 inline animate-spin"/>正在搜索全部位置…</p>}
        {debouncedQuery && !loading && !resultCount && <div className="py-20 text-center"><Search size={32} className="mx-auto text-slate-300"/><p className="mt-4 text-sm text-slate-500">没有找到包含“{debouncedQuery}”的文件</p></div>}
        <div role="listbox" aria-label="全局搜索结果">
        {groups.map((group, groupIndex) => <section key={group.id} role="group" aria-label={`${group.source.label} / ${group.folderPath || '项目根目录'}`} className={`${groupIndex ? 'mt-6 border-t border-slate-200 pt-5' : ''}`}>
          <header className="mb-3 flex min-w-0 items-center gap-2">
            <Folder size={17} className={group.source.kind === 'inspiration' ? 'shrink-0 text-amber-500' : 'shrink-0 text-blue-500'}/>
            <button type="button" onClick={() => void openFolder(group)} title={`在新标签页打开 ${group.folderPath || group.source.label}`} className="min-w-0 truncate text-left text-sm font-bold text-slate-700 hover:text-blue-600">{group.source.label}<span className="font-normal text-slate-400"> / {group.folderPath || '项目根目录'}</span></button>
            <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500">{group.totalCount}</span><ExternalLink size={12} className="shrink-0 text-slate-300"/>
          </header>
          <div className="grid w-full content-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 132px), 1fr))' }}>
            {group.entries.map((entry, entryIndex) => {
              const id = `${group.id}\0${entry.relativePath}\0${entry.path}`;
              return <button type="button" key={id} role="option" aria-selected={selectedId === id} aria-label={`${entry.name}，${entryTypeLabel(entry)}`} title={entry.relativePath} onClick={() => setSelectedId(id)} onDoubleClick={() => void openEntry(group.source, entry)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void openEntry(group.source, entry); } }} className={`group min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedId === id ? 'bg-blue-50 ring-1 ring-blue-400' : ''}`}>
                <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-slate-200/80"><SearchResultIcon entry={entry} config={config} queueOrder={groupIndex * 1000 + entryIndex}/></div>
                <p className="mt-2 truncate text-xs font-medium text-slate-700">{entry.name}</p><p className="mt-0.5 truncate text-[10px] uppercase text-slate-400">{entryTypeLabel(entry)}</p>
              </button>;
            })}
          </div>
        </section>)}
        </div>
        {storedCount > 0 && <nav aria-label="搜索结果分页" className="mt-7 flex items-center justify-center gap-3">
          <button type="button" disabled={loading || pageIndex === 0} onClick={() => { setSelectedId(''); setPageIndex(value => Math.max(0, value - 1)); }} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:border-blue-400 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40">上一页</button>
          <span className="min-w-24 text-center text-xs text-slate-500">第 {pageIndex + 1} / {pageCount} 页</span>
          <button type="button" disabled={loading || pageIndex + 1 >= pageCount} onClick={() => { setSelectedId(''); setPageIndex(value => Math.min(pageCount - 1, value + 1)); }} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:border-blue-400 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40">下一页</button>
        </nav>}
      </div>
    </div>
  </section>;
};
