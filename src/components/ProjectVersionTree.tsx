import { useMemo } from 'react';
import { AlertTriangle, Folder } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProgressFolder, ProjectFileEntry } from '../types';

type ProjectVersionTreeProps = {
  progressFolders: ProgressFolder[];
  entries: ProjectFileEntry[];
  activeRelativePath: string;
  gridIconSize: number;
  projectRelativePath: (absolutePath: string) => string;
  renderEntry: (entry: ProjectFileEntry, progressFolder?: ProgressFolder, sourceKind?: 'image' | 'video') => ReactNode;
  teamRetouchParentProgressIds?: string[];
};

type VersionTreeItem = {
  folder: ProgressFolder;
  entry?: ProjectFileEntry;
};

type SourceTreeItem = {
  entry: ProjectFileEntry;
  sourceKind: 'image' | 'video';
};

type PositionedItem = {
  key: string;
  folder?: ProgressFolder;
  entry?: ProjectFileEntry;
  sourceKind?: 'image' | 'video';
  x: number;
  y: number;
};

type PositionedEdge = {
  parent: PositionedItem;
  child: PositionedItem;
  kind?: 'team-workspace';
};

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('zh-CN');
const parentPath = (value: string) => normalizePath(value).split('/').slice(0, -1).join('/');
const versionSegments = (value: string) => value.split('_').map(segment => Number(segment) || 0);
const compareProgressFolders = (left: ProgressFolder, right: ProgressFolder) => {
  if (left.mediaKind !== right.mediaKind) return left.mediaKind === 'image' ? -1 : 1;
  const leftSegments = versionSegments(left.versionKey);
  const rightSegments = versionSegments(right.versionKey);
  const length = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftSegments[index] || 0) - (rightSegments[index] || 0);
    if (difference) return difference;
  }
  return left.createdAt - right.createdAt;
};

export const ProjectVersionTree = ({ progressFolders, entries, activeRelativePath, gridIconSize, projectRelativePath, renderEntry, teamRetouchParentProgressIds = [] }: ProjectVersionTreeProps) => {
  const scopePath = normalizePath(activeRelativePath);
  const scopedFolders = useMemo(() => progressFolders
    .filter(folder => parentPath(projectRelativePath(folder.folderPath)) === scopePath)
    .sort(compareProgressFolders), [progressFolders, projectRelativePath, scopePath]);

  const entryByPath = useMemo(() => new Map(entries.map(entry => [normalizePath(entry.relativePath), entry])), [entries]);
  const versionItems = useMemo<VersionTreeItem[]>(() => scopedFolders.map(folder => ({
    folder,
    entry: entryByPath.get(normalizePath(projectRelativePath(folder.folderPath))),
  })), [entryByPath, projectRelativePath, scopedFolders]);
  const sourceEntries = useMemo(() => entries.reduce<SourceTreeItem[]>((items, entry) => {
    if (entry.kind !== 'folder') return items;
    const name = entry.name.toLocaleLowerCase('zh-CN');
    if (name === 'raw' || name === 'jpg') items.push({ entry, sourceKind: 'image' });
    if (name === 'mov') items.push({ entry, sourceKind: 'video' });
    return items;
  }, []), [entries]);
  const teamWorkspaceEntry = useMemo(() => entries.find(entry => entry.kind === 'folder' && entry.name === '团片协作'), [entries]);
  const scopedProgressIds = useMemo(() => new Set(versionItems.map(item => item.folder.id)), [versionItems]);
  const teamWorkspaceParentIds = useMemo(() => teamRetouchParentProgressIds.filter(id => scopedProgressIds.has(id)), [scopedProgressIds, teamRetouchParentProgressIds]);
  const trackedEntryPaths = useMemo(() => new Set([
    ...versionItems.flatMap(item => item.entry ? [normalizePath(item.entry.relativePath)] : []),
    ...sourceEntries.map(item => normalizePath(item.entry.relativePath)),
    ...(teamWorkspaceEntry && teamWorkspaceParentIds.length ? [normalizePath(teamWorkspaceEntry.relativePath)] : []),
  ]), [sourceEntries, teamWorkspaceEntry, teamWorkspaceParentIds.length, versionItems]);
  const ordinaryEntries = useMemo(() => entries.filter(entry => !trackedEntryPaths.has(normalizePath(entry.relativePath))), [entries, trackedEntryPaths]);

  const nodeWidth = Math.max(80, gridIconSize);
  const nodeHeight = nodeWidth + 66;
  const columnGap = Math.max(58, Math.round(nodeWidth * 0.42));
  const rowGap = 28;
  const canvasPadding = 12;

  const layout = useMemo(() => {
    const byId = new Map(versionItems.map(item => [item.folder.id, item]));
    const effectiveParent = new Map<string, string>();
    for (const item of versionItems) {
      const parentId = item.folder.parentProgressId;
      if (parentId && parentId !== item.folder.id && byId.has(parentId)) effectiveParent.set(item.folder.id, parentId);
    }

    // V0 is the project baseline rather than a manually selected branch parent.
    // Visually attach the first root version of each media kind to it so the
    // project history reads naturally as V0 → V1.
    for (const mediaKind of ['image', 'video'] as const) {
      const baseline = versionItems.find(item => item.folder.mediaKind === mediaKind && item.folder.versionKey === '0');
      if (!baseline) continue;
      const firstRoot = versionItems
        .filter(item => item.folder.mediaKind === mediaKind && item.folder.versionKey !== '0' && !effectiveParent.has(item.folder.id))
        .sort((left, right) => compareProgressFolders(left.folder, right.folder))[0];
      if (firstRoot) effectiveParent.set(firstRoot.folder.id, baseline.folder.id);
    }

    const childrenByParent = new Map<string, VersionTreeItem[]>();
    for (const item of versionItems) {
      const parentId = effectiveParent.get(item.folder.id);
      if (!parentId) continue;
      const children = childrenByParent.get(parentId) || [];
      children.push(item);
      childrenByParent.set(parentId, children);
    }
    childrenByParent.forEach(children => children.sort((left, right) => compareProgressFolders(left.folder, right.folder)));

    const positioned: PositionedItem[] = [];
    const visited = new Set<string>();
    let nextLeafY = canvasPadding;
    const primaryTeamParentId = teamWorkspaceEntry ? teamWorkspaceParentIds[0] : undefined;
    const positionBranch = (item: VersionTreeItem, depth: number): number => {
      if (visited.has(item.folder.id)) return nextLeafY;
      visited.add(item.folder.id);
      const children = (childrenByParent.get(item.folder.id) || []).filter(child => !visited.has(child.folder.id));
      const hasTeamWorkspaceChild = item.folder.id === primaryTeamParentId;
      let y: number;
      if (!children.length && !hasTeamWorkspaceChild) {
        y = nextLeafY;
        nextLeafY += nodeHeight + rowGap;
      } else {
        const childYs = children.map(child => positionBranch(child, depth + 1));
        if (hasTeamWorkspaceChild && teamWorkspaceEntry) {
          const teamY = nextLeafY;
          nextLeafY += nodeHeight + rowGap;
          positioned.push({
            key: `team-workspace:${normalizePath(teamWorkspaceEntry.relativePath)}`,
            entry: teamWorkspaceEntry,
            x: canvasPadding + (depth + 1) * (nodeWidth + columnGap),
            y: teamY,
          });
          childYs.push(teamY);
        }
        y = (childYs[0] + childYs[childYs.length - 1]) / 2;
      }
      positioned.push({ key: item.folder.id, ...item, x: canvasPadding + depth * (nodeWidth + columnGap), y });
      return y;
    };

    const roots = versionItems.filter(item => !effectiveParent.has(item.folder.id));
    roots.forEach((item, index) => {
      if (index && nextLeafY > canvasPadding) nextLeafY += rowGap;
      positionBranch(item, 0);
    });
    versionItems.filter(item => !visited.has(item.folder.id)).forEach(item => positionBranch(item, 0));

    const positionedById = new Map(positioned.flatMap(item => item.folder ? [[item.folder.id, item] as const] : []));
    const edges: PositionedEdge[] = positioned.flatMap(child => {
      if (!child.folder) return [];
      const parentId = effectiveParent.get(child.folder.id);
      const parent = parentId ? positionedById.get(parentId) : undefined;
      return parent ? [{ parent, child }] : [];
    });
    const teamNode = positioned.find(item => item.key.startsWith('team-workspace:'));
    if (teamNode) {
      teamWorkspaceParentIds
        .map(id => positionedById.get(id))
        .filter((item): item is PositionedItem => Boolean(item))
        .forEach(parent => edges.push({ parent, child: teamNode, kind: 'team-workspace' }));
    }

    if (sourceEntries.length) {
      const sourceColumnOffset = nodeWidth + columnGap;
      positioned.forEach(item => { item.x += sourceColumnOffset; });
      let unattachedY = Math.max(nextLeafY, canvasPadding);
      for (const mediaKind of ['image', 'video'] as const) {
        const sources = sourceEntries.filter(item => item.sourceKind === mediaKind);
        if (!sources.length) continue;
        const baseline = positioned.find(item => item.folder?.mediaKind === mediaKind && item.folder.versionKey === '0');
        const spacing = nodeHeight + rowGap;
        const firstY = baseline ? baseline.y - (sources.length - 1) * spacing / 2 : unattachedY;
        sources.forEach(({ entry, sourceKind }, index) => {
          const sourceNode: PositionedItem = {
            key: `source:${normalizePath(entry.relativePath)}`,
            entry,
            sourceKind,
            x: canvasPadding,
            y: firstY + index * spacing,
          };
          positioned.push(sourceNode);
          if (baseline) edges.push({ parent: sourceNode, child: baseline });
        });
        if (!baseline) unattachedY += sources.length * spacing + rowGap;
      }
      const minimumY = Math.min(...positioned.map(item => item.y));
      if (minimumY < canvasPadding) {
        const shiftY = canvasPadding - minimumY;
        positioned.forEach(item => { item.y += shiftY; });
      }
    }
    return {
      positioned,
      edges,
      width: Math.max(nodeWidth, ...positioned.map(item => item.x + nodeWidth + canvasPadding)),
      height: Math.max(nodeHeight, ...positioned.map(item => item.y + nodeHeight + canvasPadding)),
    };
  }, [columnGap, nodeHeight, nodeWidth, sourceEntries, teamWorkspaceEntry, teamWorkspaceParentIds, versionItems]);

  const hasGraphItems = versionItems.length > 0 || sourceEntries.length > 0 || Boolean(teamWorkspaceEntry && teamWorkspaceParentIds.length);

  return <div className="min-w-0 flex-1 pb-4">
    {hasGraphItems && <div className="overflow-auto">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          {layout.edges.map(({ parent, child, kind }) => {
            const startX = parent.x + nodeWidth * 0.82;
            const startY = parent.y + nodeWidth * 0.48;
            const endX = child.x + nodeWidth * 0.18;
            const endY = child.y + nodeWidth * 0.48;
            const bend = Math.max(28, (endX - startX) * 0.5);
            return <path key={`${parent.key}-${child.key}`} d={`M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`} fill="none" stroke={kind === 'team-workspace' ? '#8b5cf6' : child.folder?.folderMissing ? '#fca5a5' : '#94a3b8'} strokeWidth="2" strokeDasharray={kind === 'team-workspace' ? '7 5' : child.folder?.folderMissing ? '6 5' : undefined}/>;
          })}
        </svg>
        {layout.positioned.map(item => <div key={item.key} className="absolute" style={{ left: item.x, top: item.y, width: nodeWidth, minHeight: nodeHeight }}>
          {item.entry ? renderEntry(item.entry, item.folder, item.sourceKind) : item.folder ? <div title={`${item.folder.displayName} 对应的文件夹已失效`} className="relative flex min-h-full flex-col items-center rounded-lg p-2 text-center text-red-500">
            <span className="absolute right-2 top-2 z-10 rounded-full bg-red-50 px-2 py-1 font-mono text-[10px] font-bold">V{item.folder.versionKey}</span>
            <span className="relative flex aspect-square w-full items-center justify-center"><Folder size={Math.max(46, nodeWidth * 0.48)} strokeWidth={1.4} fill="currentColor" className="text-red-300"/><AlertTriangle size={18} className="absolute text-red-600"/></span>
            <span className="mt-2 w-full truncate text-xs font-medium">{item.folder.displayName}</span>
            <span className="mt-0.5 text-[10px] font-bold">文件夹失效</span>
          </div> : null}
        </div>)}
      </div>
    </div>}

    {ordinaryEntries.length > 0 && <section className={hasGraphItems ? 'mt-5 border-t border-slate-200 pt-4' : undefined}>
      {hasGraphItems && <p className="mb-2 px-1 text-xs font-medium text-slate-400">其他</p>}
      <div className="grid w-full content-start gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>
        {ordinaryEntries.map(entry => <div key={`${entry.relativePath}|${entry.path}`} className="min-w-0">{renderEntry(entry)}</div>)}
      </div>
    </section>}

    {!hasGraphItems && !ordinaryEntries.length && <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">当前文件夹为空。</p>}
  </div>;
};
