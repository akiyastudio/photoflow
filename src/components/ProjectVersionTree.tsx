import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ProgressFolder, ProjectFileEntry } from '../types';
import { projectVisibleVersionGraph, trackingStateLabel } from '../features/versioning/versioning-v2-model';

type ProjectVersionTreeProps = {
  progressFolders: ProgressFolder[];
  entries: ProjectFileEntry[];
  structureEntries?: ProjectFileEntry[];
  filterActive?: boolean;
  activeRelativePath: string;
  gridIconSize: number;
  projectRelativePath: (absolutePath: string) => string;
  renderEntry: (entry: ProjectFileEntry, progressFolder?: ProgressFolder, sourceKind?: 'image' | 'video') => ReactNode;
  teamRetouchParentProgressIds?: string[];
  onOpenMissingProgressMenu?: (folder: ProgressFolder, x: number, y: number) => void;
};

type PositionedItem = { key: string; folder?: ProgressFolder; entry: ProjectFileEntry; x: number; y: number };
type PositionedEdge = { parent: PositionedItem; child: PositionedItem; kind: 'main' | 'auxiliary' | 'team-workspace' };

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('zh-CN');
const parentPath = (value: string) => normalizePath(value).split('/').slice(0, -1).join('/');

export const ProjectVersionTree = ({ progressFolders, entries, structureEntries = entries, filterActive = false, activeRelativePath, gridIconSize, projectRelativePath, renderEntry, teamRetouchParentProgressIds = [] }: ProjectVersionTreeProps) => {
  const scopePath = normalizePath(activeRelativePath);
  const graph = useMemo(() => projectVisibleVersionGraph(progressFolders), [progressFolders]);
  const entryByPath = useMemo(() => new Map(structureEntries.map(entry => [normalizePath(entry.relativePath), entry])), [structureEntries]);
  const versionItems = useMemo(() => graph.folders.flatMap(folder => {
    const relativePath = projectRelativePath(folder.folderPath);
    const entry = entryByPath.get(normalizePath(relativePath));
    return entry && parentPath(relativePath) === scopePath ? [{ folder, entry }] : [];
  }), [entryByPath, graph.folders, projectRelativePath, scopePath]);
  const visibleIds = useMemo(() => new Set(versionItems.map(item => item.folder.id)), [versionItems]);
  const visibleEdges = useMemo(() => graph.edges.filter(edge => visibleIds.has(edge.parentId) && visibleIds.has(edge.childId)), [graph.edges, visibleIds]);
  const teamWorkspaceEntry = useMemo(() => structureEntries.find(entry => entry.kind === 'folder' && entry.name === '团片协作'), [structureEntries]);
  const teamParentIds = useMemo(() => teamRetouchParentProgressIds.filter(id => visibleIds.has(id)), [teamRetouchParentProgressIds, visibleIds]);
  const trackedEntryPaths = useMemo(() => new Set([
    ...versionItems.map(item => normalizePath(item.entry.relativePath)),
    ...(teamWorkspaceEntry && teamParentIds.length ? [normalizePath(teamWorkspaceEntry.relativePath)] : []),
  ]), [teamParentIds.length, teamWorkspaceEntry, versionItems]);
  const ordinaryEntries = useMemo(() => entries.filter(entry => !trackedEntryPaths.has(normalizePath(entry.relativePath))), [entries, trackedEntryPaths]);

  const nodeWidth = Math.max(80, gridIconSize);
  const nodeHeight = nodeWidth + 66;
  const columnGap = Math.max(58, Math.round(nodeWidth * 0.42));
  const rowGap = 28;
  const canvasPadding = 12;
  const layout = useMemo(() => {
    const parentByChild = new Map(visibleEdges.map(edge => [edge.childId, edge.parentId]));
    const depthById = new Map<string, number>();
    for (const item of versionItems) {
      let cursor = item.folder.id;
      let depth = 0;
      const visited = new Set<string>();
      while (parentByChild.has(cursor) && !visited.has(cursor)) {
        visited.add(cursor);
        cursor = parentByChild.get(cursor)!;
        depth += 1;
      }
      depthById.set(item.folder.id, depth);
    }
    const sorted = [...versionItems].sort((left, right) => (depthById.get(left.folder.id) || 0) - (depthById.get(right.folder.id) || 0) || left.folder.createdAt - right.folder.createdAt || left.folder.id.localeCompare(right.folder.id));
    const positioned: PositionedItem[] = sorted.map((item, index) => ({
      key: item.folder.id,
      ...item,
      x: canvasPadding + (depthById.get(item.folder.id) || 0) * (nodeWidth + columnGap),
      y: canvasPadding + index * (nodeHeight + rowGap),
    }));
    const byId = new Map(positioned.map(item => [item.folder!.id, item]));
    const edges: PositionedEdge[] = visibleEdges.flatMap(edge => {
      const parent = byId.get(edge.parentId);
      const child = byId.get(edge.childId);
      return parent && child ? [{ parent, child, kind: edge.relationKind }] : [];
    });
    if (teamWorkspaceEntry && teamParentIds.length) {
      const teamDepth = Math.max(...teamParentIds.map(id => depthById.get(id) || 0)) + 1;
      const team: PositionedItem = { key: `team-workspace:${normalizePath(teamWorkspaceEntry.relativePath)}`, entry: teamWorkspaceEntry, x: canvasPadding + teamDepth * (nodeWidth + columnGap), y: canvasPadding + positioned.length * (nodeHeight + rowGap) };
      positioned.push(team);
      teamParentIds.forEach(id => { const parent = byId.get(id); if (parent) edges.push({ parent, child: team, kind: 'team-workspace' }); });
    }
    return {
      positioned,
      edges,
      width: Math.max(nodeWidth, ...positioned.map(item => item.x + nodeWidth + canvasPadding)),
      height: Math.max(nodeHeight, ...positioned.map(item => item.y + nodeHeight + canvasPadding)),
    };
  }, [columnGap, nodeHeight, nodeWidth, teamParentIds, teamWorkspaceEntry, versionItems, visibleEdges]);

  const hasGraphItems = layout.positioned.length > 0;
  return <div className="min-w-0 flex-1 pb-4">
    {graph.cycleNodeIds.length > 0 && <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">版本关系需要修复：{graph.cycleNodeIds.join('、')}</div>}
    {hasGraphItems && <div className="overflow-auto"><div className="relative" style={{ width: layout.width, height: layout.height }}>
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">{layout.edges.map(({ parent, child, kind }) => {
        const startX = parent.x + nodeWidth * 0.82;
        const startY = parent.y + nodeWidth * 0.48;
        const endX = child.x + nodeWidth * 0.18;
        const endY = child.y + nodeWidth * 0.48;
        const bend = Math.max(28, (endX - startX) * 0.5);
        return <path key={`${parent.key}-${child.key}`} data-relation-kind={kind} d={`M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`} fill="none" stroke={kind === 'team-workspace' ? '#8b5cf6' : kind === 'auxiliary' ? '#8b5cf6' : '#94a3b8'} strokeWidth="2" strokeDasharray={kind === 'auxiliary' || kind === 'team-workspace' ? '7 5' : undefined}/>;
      })}</svg>
      {layout.positioned.map(item => <div key={item.key} className="absolute" data-node-role={item.folder?.nodeRole} data-tracking-label={item.folder ? trackingStateLabel(item.folder) : undefined} style={{ left: item.x, top: item.y, width: nodeWidth, minHeight: nodeHeight }}>{renderEntry(item.entry, item.folder)}</div>)}
    </div></div>}
    {ordinaryEntries.length > 0 && <section className={hasGraphItems ? 'mt-5 border-t border-slate-200 pt-4' : undefined}>{hasGraphItems && <p className="mb-2 px-1 text-xs font-medium text-slate-400">其他</p>}<div className="grid w-full content-start gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{ordinaryEntries.map(entry => <div key={`${entry.relativePath}|${entry.path}`} className="min-w-0">{renderEntry(entry)}</div>)}</div></section>}
    {filterActive && hasGraphItems && !ordinaryEntries.length && <p className="mt-5 border-t border-slate-200 py-6 text-center text-xs text-slate-400">没有其他文件符合当前搜索或筛选条件。</p>}
    {!hasGraphItems && !ordinaryEntries.length && <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">当前文件夹为空。</p>}
  </div>;
};
