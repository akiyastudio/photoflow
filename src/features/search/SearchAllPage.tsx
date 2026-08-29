import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, File, FileImage, FileVideo, Folder, Loader2, Search, X } from 'lucide-react';
import type { AppConfig, ProjectFileEntry, WorkspaceProject } from '../../types';
import { normalizeWorkspacePaths } from '../../types';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { MediaThumbnail } from '../workspace/ProjectWorkspace';

const INSPIRATION_PROJECT_NAME = '.__photoflow_inspiration__';
const SEARCH_PAGE_SIZE = 200;
const SEARCH_CONCURRENCY = 4;

export type GlobalSearchSource = {
  id: string;
  kind: 'project' | 'inspiration';
  label: string;
  workspacePath: string;
  project: WorkspaceProject;
};

type SearchHit = { source: GlobalSearchSource; entry: ProjectFileEntry };
type SearchGroup = { id: string; source: GlobalSearchSource; folderPath: string; entries: ProjectFileEntry[] };

const normalizePathKey = (value: string) => value.trim().replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();

const entryTypeLabel = (entry: ProjectFileEntry) => {
  if (entry.kind === 'video') return '视频';
  if (entry.kind === 'image') return '图片';
  if (entry.kind === 'raw') return 'RAW';
  if (entry.kind === 'shortcut') return '快捷方式';
  return entry.extension ? entry.extension.replace(/^\./, '').toLocaleUpperCase() : '文件';
};

const discoverSources = async (config: AppConfig): Promise<{ sources: GlobalSearchSource[]; errors: string[] }> => {
  const roots = normalizeWorkspacePaths(config.workspacePath, config.workspacePaths);
  const catalogs = await Promise.all(roots.map(async requestedRoot => ({
    requestedRoot,
    result: await projectWorkspaceClient.getWorkspaceProjects(requestedRoot),
  })));
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
  const sources = inspirationRoot ? [{
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
  return { sources, errors };
};

const searchSource = async (source: GlobalSearchSource, query: string, isCurrent: () => boolean) => {
  const entries: ProjectFileEntry[] = [];
  let cursor = '';
  do {
    const result = await projectWorkspaceClient.listProjectFiles(
      source.workspacePath,
      source.project.status,
      source.project.name,
      '',
      SEARCH_PAGE_SIZE,
      cursor || undefined,
      { query },
    );
    if (!isCurrent()) {
      if (result.cursor) void projectWorkspaceClient.cancelListProjectFiles(result.cursor);
      return entries;
    }
    if (!result.success) throw new Error(result.error || '读取文件失败');
    entries.push(...result.entries);
    cursor = result.cursor || '';
    if (!result.hasMore) break;
  } while (cursor);
  return entries;
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
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [completedSources, setCompletedSources] = useState(0);
  const [sourceCount, setSourceCount] = useState(0);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (active) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [active]);

  useEffect(() => {
    const sequence = ++requestSequenceRef.current;
    const isCurrent = () => requestSequenceRef.current === sequence;
    setSelectedId('');
    if (!active || !debouncedQuery) {
      setLoading(false);
      if (!debouncedQuery) {
        setHits([]);
        setError('');
        setCompletedSources(0);
        setSourceCount(0);
      }
      return;
    }
    setLoading(true);
    setHits([]);
    setError('');
    setCompletedSources(0);
    setSourceCount(0);
    void (async () => {
      const discovery = await discoverSources(config);
      if (!isCurrent()) return;
      setSourceCount(discovery.sources.length);
      const nextHits: SearchHit[] = [];
      const failures = [...discovery.errors];
      let nextSourceIndex = 0;
      const worker = async () => {
        while (isCurrent()) {
          const sourceIndex = nextSourceIndex++;
          const source = discovery.sources[sourceIndex];
          if (!source) return;
          try {
            const entries = await searchSource(source, debouncedQuery, isCurrent);
            if (isCurrent()) nextHits.push(...entries.map(entry => ({ source, entry })));
          } catch (sourceError) {
            failures.push(`${source.label}：${sourceError instanceof Error ? sourceError.message : String(sourceError)}`);
          } finally {
            if (isCurrent()) setCompletedSources(value => value + 1);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, discovery.sources.length) }, () => worker()));
      if (!isCurrent()) return;
      nextHits.sort((left, right) => left.source.label.localeCompare(right.source.label, 'zh-CN', { numeric: true, sensitivity: 'base' })
        || (left.entry.parentRelativePath || '').localeCompare(right.entry.parentRelativePath || '', 'zh-CN', { numeric: true, sensitivity: 'base' })
        || left.entry.name.localeCompare(right.entry.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      setHits(nextHits);
      if (failures.length) setError(`${failures.length} 个位置暂时无法检索，其余结果已显示`);
    })().catch(searchError => {
      if (isCurrent()) setError(searchError instanceof Error ? searchError.message : String(searchError));
    }).finally(() => {
      if (isCurrent()) setLoading(false);
    });
    return () => { requestSequenceRef.current += 1; };
  }, [active, config, debouncedQuery]);

  const groups = useMemo(() => {
    const grouped = new Map<string, SearchGroup>();
    for (const hit of hits) {
      const folderPath = (hit.entry.parentRelativePath || hit.entry.relativePath.split(/[\\/]/).slice(0, -1).join('/')).replace(/\\/g, '/');
      const id = `${hit.source.id}\0${folderPath}`;
      const group = grouped.get(id) || { id, source: hit.source, folderPath, entries: [] };
      group.entries.push(hit.entry);
      grouped.set(id, group);
    }
    return [...grouped.values()];
  }, [hits]);

  const openEntry = async (source: GlobalSearchSource, entry: ProjectFileEntry) => {
    const result = await projectWorkspaceClient.openProjectEntry(source.workspacePath, source.project.status, source.project.name, entry.relativePath);
    if (!result.success) onNotice(`打开文件失败：${result.error || '未知错误'}`, 'error');
  };

  return <section className="flex h-full min-h-0 flex-col bg-slate-50">
    <header className="shrink-0 border-b border-slate-200 bg-white px-7 py-5">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-4">
          <div><h1 className="text-xl font-bold text-slate-900">全局搜索</h1><p className="mt-1 text-xs text-slate-500">检索所有项目工作目录与灵感库中的文件</p></div>
          {loading && <p className="flex shrink-0 items-center gap-2 text-xs text-blue-600"><Loader2 size={14} className="animate-spin"/>正在检索 {completedSources}/{sourceCount || '…'}</p>}
        </div>
        <div className="mt-4 flex h-11 items-center gap-3 rounded-xl border border-slate-300 bg-slate-50 px-4 shadow-sm focus-within:border-blue-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100">
          <Search size={19} className="shrink-0 text-slate-400"/>
          <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入文件名关键词" aria-label="全局搜索文件" className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"/>
          {query && <button type="button" onClick={() => setQuery('')} aria-label="清除搜索" title="清除搜索" className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X size={16}/></button>}
        </div>
        {debouncedQuery && !loading && <p className="mt-3 text-xs text-slate-500">找到 <span className="font-bold text-slate-700">{hits.length}</span> 个文件，分布在 {groups.length} 个文件夹中</p>}
        {error && <p className="mt-2 text-xs text-amber-600">{error}</p>}
      </div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
      <div className="mx-auto max-w-6xl pb-8">
        {!debouncedQuery && <div className="flex min-h-[360px] items-center justify-center text-center"><div><span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-500"><Search size={30}/></span><h2 className="mt-5 text-base font-bold text-slate-700">查找项目中的任意文件</h2><p className="mt-2 text-sm text-slate-400">输入文件名关键词，结果会按项目和文件夹整理</p></div></div>}
        {debouncedQuery && loading && !hits.length && <p className="py-20 text-center text-sm text-slate-400"><Loader2 size={18} className="mr-2 inline animate-spin"/>正在搜索全部位置…</p>}
        {debouncedQuery && !loading && !hits.length && <div className="py-20 text-center"><Search size={32} className="mx-auto text-slate-300"/><p className="mt-4 text-sm text-slate-500">没有找到包含“{debouncedQuery}”的文件</p></div>}
        {groups.map((group, groupIndex) => <section key={group.id} className={`${groupIndex ? 'mt-6 border-t border-slate-200 pt-5' : ''}`}>
          <header className="mb-3 flex min-w-0 items-center gap-2">
            <Folder size={17} className={group.source.kind === 'inspiration' ? 'shrink-0 text-amber-500' : 'shrink-0 text-blue-500'}/>
            <button type="button" onClick={() => onOpenFolder(group.source, group.folderPath)} title={`在新标签页打开 ${group.folderPath || group.source.label}`} className="min-w-0 truncate text-left text-sm font-bold text-slate-700 hover:text-blue-600">{group.source.label}<span className="font-normal text-slate-400"> / {group.folderPath || '项目根目录'}</span></button>
            <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500">{group.entries.length}</span><ExternalLink size={12} className="shrink-0 text-slate-300"/>
          </header>
          <div className="grid w-full content-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 132px), 1fr))' }}>
            {group.entries.map((entry, entryIndex) => {
              const id = `${group.id}\0${entry.relativePath}\0${entry.path}`;
              return <div key={id} role="button" tabIndex={0} title={entry.relativePath} onClick={() => setSelectedId(id)} onDoubleClick={() => void openEntry(group.source, entry)} onKeyDown={event => { if (event.key === 'Enter') void openEntry(group.source, entry); }} className={`group min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedId === id ? 'bg-blue-50 ring-1 ring-blue-400' : ''}`}>
                <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-slate-200/80"><SearchResultIcon entry={entry} config={config} queueOrder={groupIndex * 1000 + entryIndex}/></div>
                <p className="mt-2 truncate text-xs font-medium text-slate-700">{entry.name}</p><p className="mt-0.5 truncate text-[10px] uppercase text-slate-400">{entryTypeLabel(entry)}</p>
              </div>;
            })}
          </div>
        </section>)}
      </div>
    </div>
  </section>;
};
