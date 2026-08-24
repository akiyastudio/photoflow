import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { ProgressFolder, ProjectFileEntry, VersionGraphEdge } from '../types';
import { layoutVersionTree, DEFAULT_VERSION_TREE_SPACING, versionTreeAreaSize, versionTreeCanvasBounds, allowedVersionTreeRelationKinds, versionTreeEdgeGeometry, versionTreeEdgePath, versionTreeEdgePresentation, versionTreeRelationLabel, type VersionTreeEdgeKind, type VersionTreeSupplementalEdgeKind, useVersionTreeCanvas, type VersionTreeDragState, progressRelationChangeError, projectVisibleVersionGraph, trackingStateLabel } from '../features/versioning/public';
import { FILE_GRID_GAP } from '../features/workspace/marquee-selection-model';

type ProjectVersionTreeProps = {
  progressFolders: ProgressFolder[];
  graphEdges?: VersionGraphEdge[];
  entries: ProjectFileEntry[];
  structureEntries?: ProjectFileEntry[];
  selectedRelativePaths?: string[];
  filterActive?: boolean;
  activeRelativePath: string;
  gridIconSize: number;
  workspacePath: string;
  projectName: string;
  projectRelativePath: (absolutePath: string) => string;
  renderEntry: (entry: ProjectFileEntry, progressFolder?: ProgressFolder, sourceKind?: 'image' | 'video') => ReactNode;
  pendingChildId?: string;
  hoverParentId?: string;
  mutatingChildIds?: string[];
  onBeginRelationEdit?: (childId: string) => void;
  onHoverRelationParent?: (parentId?: string) => void;
  onRequestRelationChange?: (childProgressId: string, parentProgressId: string | null) => void;
  onRequestSupplementalEdgeDelete?: (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => void;
  onRequestSupplementalEdgeReconnect?: (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>, newSourceProgressId: string) => void;
  onRequestSupplementalEdgeCreate?: (sourceProgressId: string, targetProgressId: string, edgeKind: VersionTreeSupplementalEdgeKind) => void;
  onRequestCreateVersion?: (source: ProgressFolder, target: ProjectFileEntry) => void;
  onRequestCreateEmptyVersion?: (source: ProgressFolder, branch: boolean) => void;
  onStartFileDrag?: (event: ReactDragEvent<HTMLDivElement>, entry: ProjectFileEntry) => void;
  canUndoRelation?: boolean;
  canRedoRelation?: boolean;
  onUndoRelation?: () => void;
  onRedoRelation?: () => void;
  onCancelRelationEdit?: () => void;
  onNotice: (message: string, duration?: number) => void;
  onCanvasControllerChange?: (controller: VersionTreeCanvasController | null) => void;
};

export type VersionTreeCanvasController = {
  hasManualLayout: boolean;
  refreshLayout: () => Promise<boolean>;
  fitView: () => void;
  resetZoom: () => void;
  undoLayout: () => Promise<boolean>;
  redoLayout: () => Promise<boolean>;
};

type VersionTreeAreaKind = 'image' | 'video' | 'other';
type VersionTreeAreaBand = { areaKind: VersionTreeAreaKind; label: string; left: number; right: number; top: number; bottom: number };
type VersionTreeAreaSize = { width: number; height: number };
type PositionedItem = { key: string; nodeKey: string; areaKind: VersionTreeAreaKind; folder?: ProgressFolder; sourceKind?: 'image' | 'video'; entry: ProjectFileEntry; x: number; y: number };
type LayoutRelation = { id: string; kind: VersionTreeEdgeKind; parentId: string; childId: string; selectable: boolean };
type DrawnEdge = { id: string; kind: VersionTreeEdgeKind; path: string; parentId?: string; childId?: string; startX: number; startY: number; endX: number; endY: number; menuX: number; menuY: number };

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('zh-CN');
const parentPath = (value: string) => normalizePath(value).split('/').slice(0, -1).join('/');
const inferredExternalOriginalKind = (entry: ProjectFileEntry): 'image' | 'video' | undefined => {
  if (!entry.externalLink || entry.externalLinkTargetKind === 'file') return undefined;
  const name = entry.name.replace(/\.lnk$/i, '').trim().toLocaleLowerCase('zh-CN');
  if (/^(raw|jpg|原片|原图|底片|原始素材)$/iu.test(name)) return 'image';
  if (/^(mov|视频原片|原始视频)$/iu.test(name)) return 'video';
  return undefined;
};
const isVersionFolderEntry = (entry: ProjectFileEntry) => entry.kind === 'folder' || entry.externalLink === true && entry.externalLinkTargetKind !== 'file';
const EMPTY_VERSION_TREE_IDS: string[] = [];
const EMPTY_VERSION_TREE_EDGES: VersionGraphEdge[] = [];
const afterVersionTreePaint = (callback: () => void) => typeof window.requestAnimationFrame === 'function'
  ? window.requestAnimationFrame(callback)
  : globalThis.setTimeout(callback, 0);

export const ProjectVersionTree = ({ progressFolders, graphEdges = EMPTY_VERSION_TREE_EDGES, entries, structureEntries = entries, selectedRelativePaths = EMPTY_VERSION_TREE_IDS, filterActive = false, activeRelativePath, gridIconSize, workspacePath, projectName, projectRelativePath, renderEntry, pendingChildId, hoverParentId, mutatingChildIds = EMPTY_VERSION_TREE_IDS, onBeginRelationEdit, onHoverRelationParent, onRequestRelationChange, onRequestSupplementalEdgeDelete, onRequestSupplementalEdgeReconnect, onRequestSupplementalEdgeCreate, onRequestCreateVersion, onRequestCreateEmptyVersion, onStartFileDrag, canUndoRelation = false, canRedoRelation = false, onUndoRelation, onRedoRelation, onCancelRelationEdit, onNotice, onCanvasControllerChange }: ProjectVersionTreeProps) => {
  const [pointerPoint, setPointerPoint] = useState<{ x: number; y: number } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [dragState, setDragState] = useState<VersionTreeDragState>(null);
  const [relationChoice, setRelationChoice] = useState<{ sourceId: string; targetId: string; kinds: VersionTreeEdgeKind[] } | null>(null);
  const [createVersionTargetKey, setCreateVersionTargetKey] = useState('');
  const [zoom, setZoom] = useState(1);
  const [selectedNodeKey, setSelectedNodeKey] = useState('');
  const [blankOutputSourceId, setBlankOutputSourceId] = useState('');
  const [viewportBounds, setViewportBounds] = useState({ left: 0, top: 0, width: 1600, height: 1000 });
  const [areaBandSizes, setAreaBandSizes] = useState<Partial<Record<VersionTreeAreaKind, VersionTreeAreaSize>>>({});
  const areaResizeRef = useRef<{ element: Element; pointerId: number; areaKind: VersionTreeAreaKind; axis: 'x' | 'y' | 'both'; startX: number; startY: number; width: number; height: number } | null>(null);
  const nativeFileDragRef = useRef<{ nodeKey: string; pointerId: number } | null>(null);
  const dragStateRef = useRef<VersionTreeDragState>(null);
  const changeDragState = useCallback((next: VersionTreeDragState) => {
    dragStateRef.current = next;
    setDragState(next);
  }, []);
  const arrowMarkerId = `version-tree-arrow-${useId().replace(/:/g, '')}`;
  const activePortRef = useRef<{ element: Element; pointerId: number; childId: string } | null>(null);
  const createVersionPortRef = useRef<{ element: Element; pointerId: number; sourceId: string } | null>(null);
  const reconnectEdgeRef = useRef<Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'> | null>(null);
  useEffect(() => {
    if (pendingChildId || !activePortRef.current) return;
    const activePort = activePortRef.current;
    if (activePort.element.hasPointerCapture(activePort.pointerId)) activePort.element.releasePointerCapture(activePort.pointerId);
    activePortRef.current = null;
    reconnectEdgeRef.current = null;
    setPointerPoint(null);
    if (dragStateRef.current?.type === 'relation') changeDragState(null);
  }, [changeDragState, pendingChildId]);
  useEffect(() => () => {
    const activePort = activePortRef.current;
    if (activePort?.element.hasPointerCapture(activePort.pointerId)) activePort.element.releasePointerCapture(activePort.pointerId);
    activePortRef.current = null;
    const createVersionPort = createVersionPortRef.current;
    if (createVersionPort?.element.hasPointerCapture(createVersionPort.pointerId)) createVersionPort.element.releasePointerCapture(createVersionPort.pointerId);
    createVersionPortRef.current = null;
    reconnectEdgeRef.current = null;
    const areaResize = areaResizeRef.current;
    if (areaResize?.element.hasPointerCapture(areaResize.pointerId)) areaResize.element.releasePointerCapture(areaResize.pointerId);
    areaResizeRef.current = null;
    nativeFileDragRef.current = null;
    dragStateRef.current = null;
  }, []);
  const scopePath = normalizePath(activeRelativePath);
  const graph = useMemo(() => projectVisibleVersionGraph(progressFolders, graphEdges), [graphEdges, progressFolders]);
  const entryByPath = useMemo(() => new Map(structureEntries.map(entry => [normalizePath(entry.relativePath), entry])), [structureEntries]);
  const externalEntryByTarget = useMemo(() => new Map(structureEntries
    .filter(entry => entry.externalLink && entry.externalLinkTarget)
    .map(entry => [normalizePath(entry.externalLinkTarget!), entry])), [structureEntries]);
  const versionItems = useMemo(() => graph.folders.flatMap(folder => {
    const relativePath = normalizePath(folder.externalLinkRelativePath || projectRelativePath(folder.folderPath));
    const foundEntry = externalEntryByTarget.get(normalizePath(folder.folderPath)) || entryByPath.get(normalizePath(relativePath));
    const entry: ProjectFileEntry | undefined = foundEntry || folder.folderMissing ? foundEntry || {
      kind: 'folder', name: folder.displayName, path: folder.folderPath, relativePath, extension: '', size: 0, createdAt: folder.createdAt, updatedAt: folder.updatedAt,
    } : undefined;
    return entry && parentPath(relativePath) === scopePath ? [{ folder, entry }] : [];
  }), [entryByPath, externalEntryByTarget, graph.folders, projectRelativePath, scopePath]);
  const visibleIds = useMemo(() => new Set(versionItems.map(item => item.folder.id)), [versionItems]);
  const visibleEdges = useMemo(() => graph.edges.filter(edge => visibleIds.has(edge.parentId) && visibleIds.has(edge.childId)), [graph.edges, visibleIds]);
  const trackedEntryPaths = useMemo(() => new Set(versionItems.map(item => normalizePath(item.entry.relativePath))), [versionItems]);
  const selectedPathSet = useMemo(() => new Set(selectedRelativePaths.map(normalizePath)), [selectedRelativePaths]);
  // The canvas represents folders and version relations, not every loose media
  // file in the current directory. This keeps large shoots usable.
  const ordinaryEntries = useMemo(() => entries.filter(entry => isVersionFolderEntry(entry) && !trackedEntryPaths.has(normalizePath(entry.relativePath))), [entries, trackedEntryPaths]);
  const selectedNodeIds = useMemo(() => new Set([
    ...versionItems.filter(item => selectedPathSet.has(normalizePath(item.entry.relativePath))).map(item => `entry:${normalizePath(item.entry.relativePath)}`),
    ...ordinaryEntries.filter(entry => selectedPathSet.has(normalizePath(entry.relativePath))).map(entry => `entry:${normalizePath(entry.relativePath)}`),
  ]), [ordinaryEntries, selectedPathSet, versionItems]);

  const nodeWidth = Math.max(80, Math.round(gridIconSize));
  const nodeHeight = nodeWidth + 52;
  const { horizontalGap: defaultColumnGap, rowGap, auxiliaryGap, rootGap, padding: canvasPadding } = DEFAULT_VERSION_TREE_SPACING;
  const columnGap = Math.max(76, defaultColumnGap);
  const otherColumnGap = FILE_GRID_GAP;
  const defaultLayout = useMemo(() => {
    const itemById = new Map(versionItems.map(item => [item.folder.id, item]));
    const positioned: PositionedItem[] = [];
    const relations: LayoutRelation[] = [];
    let areaTop = 0;
    for (const mediaKind of ['image', 'video'] as const) {
      const mediaIds = new Set(versionItems.filter(item => item.folder.mediaKind === mediaKind).map(item => item.folder.id));
      const forest = layoutVersionTree({
        nodes: versionItems.filter(item => mediaIds.has(item.folder.id)).map(({ folder }) => ({ id: folder.id, mediaKind, nodeRole: folder.nodeRole, artifactKind: folder.artifactKind, relationKind: folder.relationKind, createdAt: folder.createdAt })),
        edges: visibleEdges.filter(edge => mediaIds.has(edge.parentId) && mediaIds.has(edge.childId)).map(edge => ({ ...edge, id: edge.id || `${edge.parentId}:${edge.childId}:${edge.relationKind}` })),
        nodeWidth, nodeHeight, columnGap, rowGap, auxiliaryGap, rootGap,
      });
      const mediaNodes = forest.nodes.flatMap(node => {
        const item = itemById.get(node.id);
        return item ? [{ key: `entry:${normalizePath(item.entry.relativePath)}`, nodeKey: `progress:${node.id}`, areaKind: mediaKind, ...item, x: node.x, y: node.y + areaTop }] : [];
      });
      const inferredOriginalNodes = ordinaryEntries
        .filter(entry => inferredExternalOriginalKind(entry) === mediaKind)
        .map((entry, index) => ({
          key: `entry:${normalizePath(entry.relativePath)}`,
          nodeKey: `entry:${normalizePath(entry.relativePath)}`,
          areaKind: mediaKind,
          sourceKind: mediaKind,
          entry,
          x: index * (nodeWidth + otherColumnGap),
          y: mediaNodes.length ? Math.max(...mediaNodes.map(item => item.y + nodeHeight)) + rowGap : areaTop,
        }));
      positioned.push(...mediaNodes, ...inferredOriginalNodes);
      relations.push(...forest.edges.map(edge => ({ id: edge.id, kind: edge.relationKind, parentId: edge.parentId, childId: edge.childId, selectable: true })));
      const areaNodes = [...mediaNodes, ...inferredOriginalNodes];
      if (areaNodes.length) areaTop = Math.max(...areaNodes.map(item => item.y + nodeHeight)) + rootGap + 12;
    }
    const graphBottom = positioned.length ? Math.max(...positioned.map(item => item.y + nodeHeight)) : 0;
    const otherTop = graphBottom ? graphBottom + rootGap + 12 : 0;
    // Keep loose folders in a compact horizontal shelf. They do not need the
    // wider column spacing reserved for relation arrows in the version graph.
    const brollItems = versionItems.filter(item => item.folder.nodeRole === 'broll');
    const otherEntries = ordinaryEntries.filter(entry => !inferredExternalOriginalKind(entry));
    const otherItems = [
      ...brollItems.map(item => ({
        key: `entry:${normalizePath(item.entry.relativePath)}`,
        nodeKey: `progress:${item.folder.id}`,
        areaKind: 'other' as const,
        ...item,
      })),
      ...otherEntries.map(entry => ({
        key: `entry:${normalizePath(entry.relativePath)}`,
        nodeKey: `entry:${normalizePath(entry.relativePath)}`,
        areaKind: 'other' as const,
        entry,
      })),
    ];
    const otherColumns = Math.max(1, otherItems.length);
    positioned.push(...otherItems.map((item, index) => ({
      ...item,
      x: index % otherColumns * (nodeWidth + otherColumnGap),
      y: otherTop + Math.floor(index / otherColumns) * (nodeHeight + rowGap),
    })));
    return { positioned, relations };
  }, [auxiliaryGap, columnGap, nodeHeight, nodeWidth, ordinaryEntries, otherColumnGap, rootGap, rowGap, versionItems, visibleEdges]);
  const canvasNodes = useMemo(() => defaultLayout.positioned.map(item => ({ id: item.key, nodeKey: item.nodeKey, fallbackNodeKeys: item.folder ? [item.key] : undefined, x: item.x, y: item.y })), [defaultLayout]);
  const canvas = useVersionTreeCanvas({
    nodes: canvasNodes,
    workspacePath, projectName, scopeKey: activeRelativePath, nodeWidth, nodeHeight, collisionHorizontalGap: otherColumnGap, coordinateScale: zoom, onNotice,
    selectedNodeIds, dragStateRef, onDragStateChange: changeDragState,
  });
  const layout = useMemo(() => {
    const positioned = defaultLayout.positioned.flatMap(item => {
      const position = canvas.positions.get(item.key);
      return position ? [{ ...item, x: canvasPadding + position.x, y: canvasPadding + position.y }] : [];
    });
    const byId = new Map<string, PositionedItem>();
    positioned.forEach(item => { byId.set(item.key, item); if (item.folder) byId.set(item.folder.id, item); });
    const edges: DrawnEdge[] = defaultLayout.relations.flatMap(edge => {
      const parent = byId.get(edge.parentId);
      const child = byId.get(edge.childId);
      if (!parent || !child) return [];
      const geometry = versionTreeEdgeGeometry(
        { x: parent.x, y: parent.y, width: nodeWidth, height: nodeHeight },
        { x: child.x, y: child.y, width: nodeWidth, height: nodeHeight },
      );
      const directAssociation = edge.kind === 'media_companion' || edge.kind === 'derived_preview';
      const path = directAssociation
        ? `M ${geometry.start.x} ${geometry.start.y} L ${geometry.end.x} ${geometry.end.y}`
        : geometry.path;
      return [{ id: edge.id, kind: edge.kind, path, parentId: edge.selectable ? edge.parentId : undefined, childId: edge.selectable ? edge.childId : undefined, startX: geometry.start.x, startY: geometry.start.y, endX: geometry.end.x, endY: geometry.end.y, menuX: geometry.midpoint.x, menuY: geometry.midpoint.y }];
    });
    const bounds = versionTreeCanvasBounds(canvas.positions, nodeWidth, nodeHeight, canvasPadding);
    return { positioned, edges, width: bounds.width, height: bounds.height };
  }, [canvas.positions, canvasPadding, defaultLayout, nodeHeight, nodeWidth]);
  const naturalAreaBands = useMemo(() => ([['image', '图片'], ['video', '视频'], ['other', '其他']] as const).flatMap(([areaKind, label]) => {
      const items = defaultLayout.positioned.filter(item => item.areaKind === areaKind);
      if (!items.length) return [];
      return [{
        areaKind, label,
        left: canvasPadding + Math.min(...items.map(item => item.x)),
        right: canvasPadding + Math.max(...items.map(item => item.x + nodeWidth)),
        top: canvasPadding + Math.min(...items.map(item => item.y)),
        bottom: canvasPadding + Math.max(...items.map(item => item.y + nodeHeight)),
      }];
    }), [canvasPadding, defaultLayout.positioned, nodeHeight, nodeWidth]);
  const areaBands = useMemo(() => naturalAreaBands.map(area => {
    const custom = areaBandSizes[area.areaKind];
    const size = versionTreeAreaSize(
      { width: area.right - area.left, height: area.bottom - area.top },
      custom,
      { width: nodeWidth, height: nodeHeight },
    );
    return {
      ...area,
      right: area.left + size.width,
      bottom: area.top + size.height,
    };
  }), [areaBandSizes, naturalAreaBands, nodeHeight, nodeWidth]);
  const beginAreaResize = (event: ReactPointerEvent<HTMLSpanElement>, area: VersionTreeAreaBand, axis: 'x' | 'y' | 'both') => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    areaResizeRef.current = { element: event.currentTarget, pointerId: event.pointerId, areaKind: area.areaKind, axis, startX: event.clientX, startY: event.clientY, width: area.right - area.left, height: area.bottom - area.top };
  };
  const updateAreaResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = areaResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const scale = zoom > 0 ? zoom : 1;
    const deltaX = (event.clientX - resize.startX) / scale;
    const deltaY = (event.clientY - resize.startY) / scale;
    setAreaBandSizes(current => ({
      ...current,
      [resize.areaKind]: {
        width: Math.max(nodeWidth, resize.width + (resize.axis === 'y' ? 0 : deltaX)),
        height: Math.max(nodeHeight, resize.height + (resize.axis === 'x' ? 0 : deltaY)),
      },
    }));
  };
  const endAreaResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = areaResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (resize.element.hasPointerCapture(resize.pointerId)) resize.element.releasePointerCapture(resize.pointerId);
    areaResizeRef.current = null;
  };
  const framedLayoutWidth = Math.max(layout.width, ...areaBands.map(area => area.right + canvasPadding));
  const framedLayoutHeight = Math.max(layout.height, ...areaBands.map(area => area.bottom + canvasPadding));
  const fitView = useCallback(() => {
    const viewport = canvas.viewportRef.current;
    if (!viewport) return;
    const measuredWidth = Number(viewport.clientWidth);
    const availableWidth = Number.isFinite(measuredWidth) && measuredWidth > 24 ? measuredWidth - 24 : Math.max(1, layout.width);
    const nextZoom = Math.max(.45, Math.min(1, availableWidth / Math.max(1, framedLayoutWidth)));
    setZoom(nextZoom);
    afterVersionTreePaint(canvas.resetViewport);
  }, [canvas.resetViewport, canvas.viewportRef, framedLayoutWidth]);
  const resetZoom = useCallback(() => {
    setZoom(1);
    afterVersionTreePaint(canvas.resetViewport);
  }, [canvas.resetViewport]);
  const focusNode = useCallback((nodeKey: string) => {
    const viewport = canvas.viewportRef.current;
    const item = layout.positioned.find(candidate => candidate.key === nodeKey);
    if (!viewport || !item) return;
    viewport.scrollTo({
      left: Math.max(0, (item.x + nodeWidth / 2) * zoom - viewport.clientWidth / 2),
      top: Math.max(0, (item.y + nodeHeight / 2) * zoom - viewport.clientHeight / 2),
      behavior: 'smooth',
    });
    setSelectedNodeKey(nodeKey);
  }, [canvas.viewportRef, layout.positioned, nodeHeight, nodeWidth, zoom]);
  useEffect(() => {
    const viewport = canvas.viewportRef.current;
    if (!viewport) return;
    const updateBounds = () => setViewportBounds(current => {
      const next = {
        left: viewport.scrollLeft / zoom,
        top: viewport.scrollTop / zoom,
        width: (viewport.clientWidth || 1600) / zoom,
        height: (viewport.clientHeight || 1000) / zoom,
      };
      return current.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height
        ? current
        : next;
    });
    updateBounds();
    viewport.addEventListener('scroll', updateBounds, { passive: true });
    window.addEventListener('resize', updateBounds);
    return () => { viewport.removeEventListener('scroll', updateBounds); window.removeEventListener('resize', updateBounds); };
  }, [canvas.viewportRef, zoom]);
  const refreshAndFit = useCallback(async () => {
    const refreshed = await canvas.refreshLayout();
    if (refreshed) {
      setAreaBandSizes({});
      afterVersionTreePaint(fitView);
    }
    return refreshed;
  }, [canvas.refreshLayout, fitView]);
  useEffect(() => {
    if (!onCanvasControllerChange) return;
    onCanvasControllerChange({ hasManualLayout: canvas.hasManualLayout, refreshLayout: refreshAndFit, fitView, resetZoom, undoLayout: canvas.undoLayout, redoLayout: canvas.redoLayout });
    return () => onCanvasControllerChange(null);
  }, [canvas.hasManualLayout, canvas.redoLayout, canvas.undoLayout, fitView, onCanvasControllerChange, refreshAndFit, resetZoom]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.target as Element | null)?.closest?.('input,select,textarea')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey && canRedoRelation) onRedoRelation?.();
        else if (!event.shiftKey && canUndoRelation) onUndoRelation?.();
        else void (event.shiftKey ? canvas.redoLayout() : canvas.undoLayout());
      } else if (event.key === 'Home') {
        event.preventDefault();
        fitView();
      } else if ((event.key.toLocaleLowerCase() === 'f' || event.key === 'Decimal') && selectedNodeKey) {
        event.preventDefault();
        focusNode(selectedNodeKey);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canRedoRelation, canUndoRelation, canvas.redoLayout, canvas.undoLayout, fitView, focusNode, onRedoRelation, onUndoRelation, selectedNodeKey]);

  const visibleFolderById = useMemo(() => new Map(versionItems.map(item => [item.folder.id, item.folder])), [versionItems]);
  const mutatingIds = useMemo(() => new Set(mutatingChildIds), [mutatingChildIds]);
  const relationWouldCycle = (sourceId: string, targetId: string, ignoredEdgeId?: string) => {
    const adjacency = new Map<string, string[]>();
    for (const candidate of graph.edges) {
      if (candidate.id === ignoredEdgeId) continue;
      adjacency.set(candidate.parentId, [...(adjacency.get(candidate.parentId) || []), candidate.childId]);
    }
    const stack = [targetId];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === sourceId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...(adjacency.get(current) || []));
    }
    return false;
  };
  const validRelationKinds = (sourceId: string, targetId: string, ignoredEdgeId?: string) => {
    const source = visibleFolderById.get(sourceId);
    const target = visibleFolderById.get(targetId);
    if (!source || !target) return [];
    return allowedVersionTreeRelationKinds(source, target).filter(kind => {
      if ((kind === 'main' || kind === 'auxiliary') && progressRelationChangeError(graph.folders, target.id, source.id)) return false;
      if (relationWouldCycle(source.id, target.id, ignoredEdgeId)) return false;
      return !graph.edges.some(edge => edge.id !== ignoredEdgeId && edge.parentId === source.id && edge.childId === target.id && edge.relationKind === kind);
    });
  };
  const supplementalRelationError = (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>, sourceId: string) => {
    const source = visibleFolderById.get(sourceId);
    const target = visibleFolderById.get(edge.targetProgressId);
    if (!source || !target) return '候选节点不在当前版本树中';
    if (source.id === target.id) return '节点不能连接到自己';
    if (source.projectId !== target.projectId) return '节点不属于同一个项目';
    if (source.mediaKind !== target.mediaKind) return '图片和视频节点不能互相连接';
    if (!allowedVersionTreeRelationKinds(source, target).includes(edge.edgeKind)) return '节点角色不符合这类补充关系';
    if (relationWouldCycle(source.id, target.id, edge.id)) return '该连接会形成循环';
    return graph.edges.some(candidate => candidate.id !== edge.id && candidate.parentId === source.id && candidate.childId === target.id && candidate.relationKind === edge.edgeKind)
      ? '相同关系已经存在'
      : '';
  };
  const relationError = (childId: string, parentId: string | null) => {
    const reconnectEdge = reconnectEdgeRef.current;
    if (reconnectEdge && parentId) return supplementalRelationError(reconnectEdge, parentId);
    if (!parentId) return progressRelationChangeError(graph.folders, childId, null);
    const source = visibleFolderById.get(parentId);
    const target = visibleFolderById.get(childId);
    if (!source || !target) return '候选节点不在当前版本树中';
    if (source.id === target.id) return '节点不能连接到自己';
    if (source.projectId !== target.projectId) return '节点不属于同一个项目';
    if (source.mediaKind !== target.mediaKind) return '图片和视频节点不能互相连接';
    return validRelationKinds(parentId, childId).length ? '' : '节点角色不允许建立关系';
  };
  const updatePointerCandidate = (clientX: number, clientY: number, currentTarget: Element) => {
    const canvas = currentTarget.closest<HTMLElement>('[data-version-tree-canvas]');
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    setPointerPoint({ x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom });
    const candidate = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-relation-parent-id]')?.dataset.relationParentId;
    onHoverRelationParent?.(candidate || undefined);
    return candidate;
  };
  const beginRelationDrag = (event: ReactPointerEvent<Element>, childProgressId: string, point: { x: number; y: number }, reconnectEdge?: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => {
    if (dragStateRef.current || mutatingIds.has(childProgressId)) return false;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePortRef.current = { element: event.currentTarget, pointerId: event.pointerId, childId: childProgressId };
    reconnectEdgeRef.current = reconnectEdge || null;
    changeDragState({ type: 'relation', childProgressId, pointerId: event.pointerId });
    onBeginRelationEdit?.(childProgressId);
    setPointerPoint(point);
    return true;
  };
  const endRelationDrag = (event: ReactPointerEvent<Element>, childProgressId: string) => {
    if (activePortRef.current?.pointerId !== event.pointerId || dragStateRef.current?.type !== 'relation') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const reconnectEdge = reconnectEdgeRef.current;
    activePortRef.current = null;
    reconnectEdgeRef.current = null;
    changeDragState(null);
    finishPointerRelation(event.clientX, event.clientY, childProgressId, reconnectEdge);
  };
  const cancelRelationDrag = (event: ReactPointerEvent<Element>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    activePortRef.current = null;
    reconnectEdgeRef.current = null;
    changeDragState(null);
    setPointerPoint(null);
    cancelRelationSelection();
  };
  const updateCreateVersionTarget = (clientX: number, clientY: number, currentTarget: Element) => {
    const canvasElement = currentTarget.closest<HTMLElement>('[data-version-tree-canvas]');
    if (!canvasElement) return '';
    const rect = canvasElement.getBoundingClientRect();
    setPointerPoint({ x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom });
    const targetKey = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-version-output-target-key]')?.dataset.versionOutputTargetKey || '';
    setCreateVersionTargetKey(targetKey);
    return targetKey;
  };
  const beginCreateVersionDrag = (event: ReactPointerEvent<Element>, sourceProgressId: string, point: { x: number; y: number }) => {
    if (dragStateRef.current || mutatingIds.has(sourceProgressId)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    createVersionPortRef.current = { element: event.currentTarget, pointerId: event.pointerId, sourceId: sourceProgressId };
    changeDragState({ type: 'create-version', sourceProgressId, pointerId: event.pointerId });
    setCreateVersionTargetKey('');
    setPointerPoint(point);
  };
  const endCreateVersionDrag = (event: ReactPointerEvent<Element>, sourceProgressId: string) => {
    if (createVersionPortRef.current?.pointerId !== event.pointerId || dragStateRef.current?.type !== 'create-version') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const targetKey = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-version-output-target-key]')?.dataset.versionOutputTargetKey || '';
    createVersionPortRef.current = null;
    changeDragState(null);
    setPointerPoint(null);
    setCreateVersionTargetKey('');
    const source = visibleFolderById.get(sourceProgressId);
    const targetItem = layout.positioned.find(item => item.key === targetKey);
    if (!source) return;
    if (!targetItem || targetItem.key === sourceProgressId) {
      if (source.nodeRole === 'progress') setBlankOutputSourceId(source.id);
      return;
    }
    if (!targetItem.folder) {
      if ((source.nodeRole === 'original' || source.nodeRole === 'progress') && isVersionFolderEntry(targetItem.entry)) onRequestCreateVersion?.(source, targetItem.entry);
      else onNotice('只有原始素材或版本进度可以向普通文件夹创建下一版本', 4000);
      return;
    }
    const kinds = validRelationKinds(source.id, targetItem.folder.id);
    if (kinds.length === 1) submitNewRelation(source.id, targetItem.folder.id, kinds[0]);
    else if (kinds.length > 1) setRelationChoice({ sourceId: source.id, targetId: targetItem.folder.id, kinds });
    else onNotice('这两个节点的类型不允许建立关系', 4000);
  };
  const cancelCreateVersionDrag = (event: ReactPointerEvent<Element>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    createVersionPortRef.current = null;
    changeDragState(null);
    setPointerPoint(null);
    setCreateVersionTargetKey('');
  };
  const submitNewRelation = (sourceId: string, targetId: string, kind: VersionTreeEdgeKind) => {
    setRelationChoice(null);
    if (kind === 'main' || kind === 'auxiliary') {
      onRequestRelationChange?.(targetId, sourceId);
      return;
    }
    if (kind === 'workflow_input' && !onRequestSupplementalEdgeCreate) {
      onRequestRelationChange?.(targetId, sourceId);
      return;
    }
    if (kind === 'media_companion' || kind === 'derived_preview' || kind === 'workflow_input') {
      if (onRequestSupplementalEdgeCreate) onRequestSupplementalEdgeCreate(sourceId, targetId, kind);
      else onNotice(`当前页面无法创建${versionTreeRelationLabel(kind)}关系`, 5000);
    }
  };
  function finishPointerRelation(clientX: number, clientY: number, childId: string, reconnectEdge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'> | null) {
    const candidate = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-relation-parent-id]')?.dataset.relationParentId;
    setPointerPoint(null);
    onHoverRelationParent?.(undefined);
    const error = candidate && reconnectEdge ? supplementalRelationError(reconnectEdge, candidate) : relationError(childId, candidate || null);
    if (candidate && !error && reconnectEdge) onRequestSupplementalEdgeReconnect?.(reconnectEdge, candidate);
    else if (candidate && !error) {
      const kinds = validRelationKinds(candidate, childId);
      if (kinds.length === 1) submitNewRelation(candidate, childId, kinds[0]);
      else if (kinds.length > 1) setRelationChoice({ sourceId: candidate, targetId: childId, kinds });
      else onCancelRelationEdit?.();
    } else onCancelRelationEdit?.();
  }
  const activeRelationChildId = pendingChildId || (dragState?.type === 'relation' ? dragState.childProgressId : undefined);
  const pendingPosition = activeRelationChildId ? layout.positioned.find(item => item.folder?.id === activeRelationChildId) : undefined;
  const createVersionSourceId = dragState?.type === 'create-version' ? dragState.sourceProgressId : undefined;
  const createVersionSourcePosition = createVersionSourceId ? layout.positioned.find(item => item.folder?.id === createVersionSourceId) : undefined;
  const selectedEdge = layout.edges.find(edge => edge.id === selectedEdgeId && edge.childId && edge.parentId);
  const selectedChild = selectedEdge?.childId ? visibleFolderById.get(selectedEdge.childId) : undefined;
  const selectedParent = selectedEdge?.parentId ? visibleFolderById.get(selectedEdge.parentId) : undefined;
  const selectedBusy = Boolean(selectedChild && mutatingIds.has(selectedChild.id));
  const selectedSupplementalEdge = selectedEdge && ['media_companion', 'derived_preview', 'workflow_input'].includes(selectedEdge.kind)
    ? graphEdges.find(edge => edge.id === selectedEdge.id)
    : undefined;
  const selectedDeletionError = selectedChild && !selectedSupplementalEdge ? relationError(selectedChild.id, null) : '';
  const requestEdgeDeletion = (edge: DrawnEdge) => {
    if (!edge.childId) return;
    const child = visibleFolderById.get(edge.childId);
    if (!child || mutatingIds.has(child.id)) return;
    const supplemental = ['media_companion', 'derived_preview', 'workflow_input'].includes(edge.kind) ? graphEdges.find(candidate => candidate.id === edge.id) : undefined;
    if (supplemental) { onRequestSupplementalEdgeDelete?.(supplemental); return; }
    const error = progressRelationChangeError(graph.folders, child.id, null);
    if (error) { onNotice(error, 5000); return; }
    onRequestRelationChange?.(child.id, null);
  };
  const requestSelectedEdgeDeletion = () => {
    if (!selectedEdge || !selectedChild || selectedBusy) return;
    requestEdgeDeletion(selectedEdge);
  };
  useEffect(() => {
    if (selectedEdgeId && !layout.edges.some(edge => edge.id === selectedEdgeId)) setSelectedEdgeId('');
  }, [layout.edges, selectedEdgeId]);
  useEffect(() => {
    if (!selectedEdge) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.target as Element | null)?.closest?.('input,select,textarea')) return;
      if (event.key === 'Escape') {
        setSelectedEdgeId('');
        onCancelRelationEdit?.();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedChild && !selectedBusy) {
        event.preventDefault();
        const error = progressRelationChangeError(graph.folders, selectedChild.id, selectedSupplementalEdge ? selectedChild.parentProgressId || null : null);
        if (selectedSupplementalEdge) onRequestSupplementalEdgeDelete?.(selectedSupplementalEdge);
        else if (!error) onRequestRelationChange?.(selectedChild.id, null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [graph.folders, onCancelRelationEdit, onRequestRelationChange, onRequestSupplementalEdgeDelete, selectedBusy, selectedChild, selectedEdge, selectedSupplementalEdge]);
  const selectEdge = (edge: DrawnEdge) => {
    if (!edge.childId || !edge.parentId || edge.kind === 'team-workspace') return;
    setSelectedEdgeId(edge.id);
  };
  function cancelRelationSelection() {
    setSelectedEdgeId('');
    onCancelRelationEdit?.();
  }
  const removeNodeInput = (folder: ProgressFolder) => {
    const incoming = layout.edges.filter(edge => edge.childId === folder.id && edge.parentId);
    const edge = incoming.find(candidate => candidate.kind === 'main' || candidate.kind === 'auxiliary') || incoming[0];
    if (!edge) {
      onNotice('该节点当前没有可断开的输入连接');
      return;
    }
    if (edge.kind === 'media_companion' || edge.kind === 'derived_preview' || edge.kind === 'workflow_input') {
      const supplemental = graphEdges.find(candidate => candidate.id === edge.id);
      if (supplemental) onRequestSupplementalEdgeDelete?.(supplemental);
      else onNotice('没有找到要断开的补充关系，请刷新后重试');
      return;
    }
    const error = progressRelationChangeError(graph.folders, folder.id, null);
    if (error) {
      onNotice(error, 5000);
      return;
    }
    onRequestRelationChange?.(folder.id, null);
  };
  const hasGraphItems = layout.positioned.length > 0;
  const renderedItems = layout.positioned.filter(item => item.folder || item.x + nodeWidth >= viewportBounds.left - 500 && item.x <= viewportBounds.left + viewportBounds.width + 500 && item.y + nodeHeight >= viewportBounds.top - 500 && item.y <= viewportBounds.top + viewportBounds.height + 500);
  return <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
    {graph.cycleNodeIds.length > 0 && <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">版本关系需要修复：{graph.cycleNodeIds.join('、')}</div>}
    {relationChoice && <div role="dialog" aria-modal="true" aria-label="选择关系类型" className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4"><section className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"><h3 className="font-bold text-slate-800">选择关系类型</h3><p className="mt-1 text-xs text-slate-500">两端节点支持多种合法关系，请明确选择本次连线语义。</p><div className="mt-4 grid gap-2">{relationChoice.kinds.map(kind => <button key={kind} type="button" onClick={() => submitNewRelation(relationChoice.sourceId, relationChoice.targetId, kind)} className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-blue-400 hover:bg-blue-50">{versionTreeRelationLabel(kind)}</button>)}</div><button type="button" onClick={() => { setRelationChoice(null); onCancelRelationEdit?.(); }} className="mt-3 w-full rounded px-3 py-2 text-sm text-slate-500 hover:bg-slate-100">取消</button></section></div>}
    {blankOutputSourceId && <div role="dialog" aria-modal="true" aria-label="从输出端创建节点" className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/40 p-4"><section className="w-full max-w-xs rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"><h3 className="font-bold text-slate-800">从 V{visibleFolderById.get(blankOutputSourceId)?.versionKey} 创建</h3><p className="mt-1 text-xs text-slate-500">输出线放到空白处时，可直接新建兼容节点。</p><div className="mt-4 grid gap-2"><button type="button" onClick={() => { const source = visibleFolderById.get(blankOutputSourceId); setBlankOutputSourceId(''); if (source) onRequestCreateEmptyVersion?.(source, false); }} className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-left text-sm font-semibold text-blue-700">新建下一版本</button><button type="button" onClick={() => { const source = visibleFolderById.get(blankOutputSourceId); setBlankOutputSourceId(''); if (source) onRequestCreateEmptyVersion?.(source, true); }} className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-700">新建可跟踪版本分支</button></div><button type="button" onClick={() => setBlankOutputSourceId('')} className="mt-3 w-full rounded px-3 py-2 text-sm text-slate-500 hover:bg-slate-100">取消</button></section></div>}
      {hasGraphItems && <div className="relative min-h-0 flex-1"><div ref={canvas.viewportRef} data-version-tree-viewport="true" className="h-full min-h-[360px] overflow-auto"><div className="relative min-h-full min-w-full" style={{ width: framedLayoutWidth * zoom, height: Math.max(360, framedLayoutHeight * zoom, viewportBounds.height) }}><div data-version-tree-canvas="true" data-drag-state={dragState?.type} onPointerDown={event => { canvas.canvasPointerHandlers.onPointerDown(event); if (!(event.target as Element).closest('[data-version-tree-node],[data-edge-id],button')) { cancelRelationSelection(); setSelectedNodeKey(''); } }} onPointerMove={canvas.canvasPointerHandlers.onPointerMove} onPointerUp={canvas.canvasPointerHandlers.onPointerUp} onPointerCancel={canvas.canvasPointerHandlers.onPointerCancel} className="absolute left-0 top-0 cursor-default" style={{ width: framedLayoutWidth, height: framedLayoutHeight, minWidth: `${100 / zoom}%`, minHeight: Math.max(360, viewportBounds.height / zoom), touchAction: 'none', transform: `scale(${zoom})`, transformOrigin: 'left top', backgroundImage: 'radial-gradient(circle, rgb(148 163 184 / 0.025) 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
      {areaBands.map(area => <div key={area.areaKind} aria-label={`${area.label}区域`} className={`pointer-events-none absolute rounded-2xl border ${area.areaKind === 'image' ? 'border-sky-300/30 bg-sky-500/[0.035]' : area.areaKind === 'video' ? 'border-violet-300/30 bg-violet-500/[0.035]' : 'border-slate-300/40 bg-slate-500/[0.035]'}`} style={{ left: area.left - 16, top: area.top - 28, width: area.right - area.left + 32, height: area.bottom - area.top + 44 }}><span className={`absolute left-3 top-2 px-1 text-[10px] font-semibold tracking-[0.16em] ${area.areaKind === 'image' ? 'text-sky-600/70' : area.areaKind === 'video' ? 'text-violet-600/70' : 'text-slate-600/65'}`}>{area.label} · {defaultLayout.positioned.filter(item => item.areaKind === area.areaKind).length}</span><span role="separator" aria-orientation="vertical" aria-label={`调整${area.label}区域宽度`} title="拖动调整宽度" onPointerDown={event => beginAreaResize(event, area, 'x')} onPointerMove={updateAreaResize} onPointerUp={endAreaResize} onPointerCancel={endAreaResize} className="pointer-events-auto absolute -right-1 top-8 bottom-3 z-30 w-2 cursor-ew-resize bg-transparent"/><span role="separator" aria-orientation="horizontal" aria-label={`调整${area.label}区域高度`} title="拖动调整高度" onPointerDown={event => beginAreaResize(event, area, 'y')} onPointerMove={updateAreaResize} onPointerUp={endAreaResize} onPointerCancel={endAreaResize} className="pointer-events-auto absolute -bottom-1 left-3 right-3 z-30 h-2 cursor-ns-resize bg-transparent"/><span role="separator" aria-label={`调整${area.label}区域大小`} title="拖动调整大小" onPointerDown={event => beginAreaResize(event, area, 'both')} onPointerMove={updateAreaResize} onPointerUp={endAreaResize} onPointerCancel={endAreaResize} className="pointer-events-auto absolute -bottom-2 -right-2 z-30 h-5 w-5 cursor-nwse-resize bg-transparent"/></div>)}
      <svg aria-label="版本关系连线" className="absolute inset-0 z-10 h-full w-full overflow-visible"><defs><marker id={arrowMarkerId} markerWidth="8" markerHeight="8" refX="0" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke"/></marker></defs>{layout.edges.map(edge => { const presentation = versionTreeEdgePresentation(edge.kind, selectedEdgeId === edge.id); const directAssociation = edge.kind === 'media_companion' || edge.kind === 'derived_preview'; return <g key={edge.id}>
        <path data-edge-id={edge.id} data-relation-kind={edge.kind} role={edge.childId ? 'button' : undefined} tabIndex={edge.childId ? 0 : undefined} aria-label={edge.childId ? `选择${versionTreeRelationLabel(edge.kind)}关系线` : undefined} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); selectEdge(edge); }} onClick={event => { event.stopPropagation(); selectEdge(edge); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectEdge(edge); } }} d={edge.path} fill="none" stroke="transparent" strokeWidth="14" pointerEvents="stroke" className={edge.childId ? 'cursor-pointer' : undefined}/>
        <path aria-hidden data-relation-kind={edge.kind} d={edge.path} fill="none" stroke={presentation.stroke} strokeWidth={presentation.strokeWidth} opacity={presentation.opacity} markerEnd={directAssociation ? undefined : `url(#${arrowMarkerId})`} pointerEvents="none"/>
        {selectedEdgeId === edge.id && edge.childId && !mutatingIds.has(edge.childId) && <circle data-edge-child-handle={edge.childId} role="button" tabIndex={0} aria-label={`拖动${versionTreeRelationLabel(edge.kind)}终点以重新连接`} cx={edge.endX} cy={edge.endY} r="7" fill="white" stroke="#2563eb" strokeWidth="2" className="cursor-grab" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={event => { beginRelationDrag(event, edge.childId!, { x: edge.endX, y: edge.endY }, selectedSupplementalEdge); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePointerCandidate(event.clientX, event.clientY, event.currentTarget); }} onPointerUp={event => endRelationDrag(event, edge.childId!)} onPointerCancel={cancelRelationDrag}/>} {null}
      </g>; })}{pendingPosition && pointerPoint && <path d={versionTreeEdgePath(pendingPosition.x, pendingPosition.y + nodeHeight / 2, pointerPoint.x, pointerPoint.y)} fill="none" stroke={hoverParentId && activeRelationChildId && relationError(activeRelationChildId, hoverParentId) ? '#ef4444' : '#2563eb'} strokeWidth="2" pointerEvents="none"/>}{createVersionSourcePosition && pointerPoint && <path d={versionTreeEdgePath(createVersionSourcePosition.x + nodeWidth, createVersionSourcePosition.y + nodeHeight / 2, pointerPoint.x, pointerPoint.y)} fill="none" stroke={createVersionTargetKey ? '#10b981' : '#2563eb'} strokeWidth="2" pointerEvents="none"/>}</svg>
      {selectedEdge && selectedChild && selectedParent && <div role="status" style={{ left: selectedEdge.menuX, top: selectedEdge.menuY }} className="absolute z-30 flex -translate-x-1/2 -translate-y-1/2 flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-600 shadow-lg">
        <span>起点：{selectedParent.displayName}</span><span>终点：{selectedChild.displayName}</span><span>类型：{versionTreeRelationLabel(selectedEdge.kind)}</span>
        <button type="button" onClick={requestSelectedEdgeDeletion} disabled={selectedBusy || Boolean(selectedDeletionError)} title={selectedDeletionError || (selectedSupplementalEdge ? `删除${versionTreeRelationLabel(selectedEdge.kind)}关系；不会改变结构父节点，之后可以重新连接` : '删除结构关系并成为独立根节点')} className="rounded bg-red-50 px-2.5 py-1 text-red-700 disabled:cursor-not-allowed disabled:opacity-40">删除关系</button>
        <button type="button" onClick={cancelRelationSelection} className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100">关闭</button>
        {selectedChild.nodeRole === 'selection' && <span className="text-violet-600">选片关系只能更换来源</span>}
      </div>}
      {renderedItems.map(item => {
        const nodeHandlers = canvas.nodePointerHandlers(item.key);
        const canBeParent = Boolean(item.folder && !item.folder.folderMissing
          && (item.folder.nodeRole === 'original' && !item.folder.artifactKind
            || ['selection', 'workflow'].includes(item.folder.nodeRole)
            || item.folder.nodeRole === 'progress' && item.folder.parentProgressId && item.folder.relationKind === 'main'));
        const hasInputRelation = Boolean(item.folder && layout.edges.some(edge => edge.childId === item.folder!.id && edge.parentId));
        const canAcceptInput = Boolean(item.folder && (['progress', 'selection', 'artifact', 'workflow'].includes(item.folder.nodeRole)
          || item.folder.nodeRole === 'original' && item.folder.artifactKind));
        const createVersionTarget = !item.folder && isVersionFolderEntry(item.entry) && (!item.entry.viaShortcut || item.entry.viaExternalLink);
        const candidateError = item.folder && activeRelationChildId ? relationError(activeRelationChildId, item.folder.id) : '';
        const candidateHovered = Boolean(item.folder && activeRelationChildId && hoverParentId === item.folder.id);
        const candidateColor = !activeRelationChildId
          ? 'bg-violet-600'
          : candidateHovered && candidateError
            ? 'bg-red-600'
            : candidateError
              ? 'bg-slate-300'
              : candidateHovered
                ? 'bg-emerald-500'
                : 'bg-blue-600';
        return <div key={item.key} {...nodeHandlers} draggable={false} data-version-tree-node="true" data-version-progress-id={item.folder?.id} data-version-output-target-key={createVersionTarget || item.folder && item.folder.nodeRole !== 'broll' ? item.key : undefined} onPointerDownCapture={event => {
          setSelectedNodeKey(item.key);
          if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || !onStartFileDrag || (event.target as Element).closest('button,input,select,textarea,[data-version-tree-port]')) return;
          nativeFileDragRef.current = { nodeKey: item.key, pointerId: event.pointerId };
          event.currentTarget.draggable = true;
          // Ctrl-drag belongs to the OS file-drag path. Do not let the canvas
          // node handler claim this pointer and persist a new layout position.
          event.stopPropagation();
        }} onPointerUpCapture={event => {
          const nativeDrag = nativeFileDragRef.current;
          if (!nativeDrag || nativeDrag.nodeKey !== item.key || nativeDrag.pointerId !== event.pointerId) return;
          nativeFileDragRef.current = null;
          event.currentTarget.draggable = false;
        }} onPointerCancelCapture={event => {
          const nativeDrag = nativeFileDragRef.current;
          if (!nativeDrag || nativeDrag.nodeKey !== item.key || nativeDrag.pointerId !== event.pointerId) return;
          nativeFileDragRef.current = null;
          event.currentTarget.draggable = false;
        }} onDragStart={event => {
          const nativeDrag = nativeFileDragRef.current;
          if (!nativeDrag || nativeDrag.nodeKey !== item.key || !onStartFileDrag) { event.preventDefault(); return; }
          event.stopPropagation();
          try { onStartFileDrag(event, item.entry); }
          finally {
            // Electron owns the drag after startProjectFileDrag is sent and a
            // cancelled HTML drag is not guaranteed to emit dragend.
            nativeFileDragRef.current = null;
            event.currentTarget.draggable = false;
          }
        }} onDragEnd={event => {
          nativeFileDragRef.current = null;
          event.currentTarget.draggable = false;
        }} onFocusCapture={() => setSelectedNodeKey(item.key)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} className={`group/version-node absolute z-20 cursor-grab rounded-xl active:cursor-grabbing ${createVersionTargetKey === item.key ? 'ring-2 ring-emerald-400 ring-offset-2' : ''}`} data-node-role={item.folder?.nodeRole} data-tracking-label={item.folder ? trackingStateLabel(item.folder) : undefined} style={{ left: item.x, top: item.y, width: nodeWidth, minHeight: nodeHeight, touchAction: 'none' }}>
        {renderEntry(item.entry, item.folder, item.sourceKind)}
        {item.folder && <>
          {canAcceptInput && <button type="button" data-version-tree-port="true" disabled={mutatingIds.has(item.folder.id)} aria-label={hasInputRelation ? `断开 ${item.folder.displayName} 的输入连接` : `${item.folder.displayName} 等待输入连接`} title={mutatingIds.has(item.folder.id) ? '关系正在更新' : hasInputRelation ? '按下只会断开左侧输入连接' : '空输入端：请从来源节点右侧输出端拖入'} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); if (hasInputRelation) removeNodeInput(item.folder!); else onNotice('左侧触点只用于断开已有连接；请从来源节点右侧拖出新线。'); }} onClick={event => { event.preventDefault(); event.stopPropagation(); }} className="absolute -left-2.5 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity group-hover/version-node:opacity-100 group-focus-within/version-node:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"><span aria-hidden className={`h-2.5 w-2.5 rounded-full border-2 shadow ${hasInputRelation ? 'border-white bg-red-500' : 'border-slate-400 bg-white'}`}/></button>}
          {canBeParent && <button type="button" data-version-tree-port="true" data-relation-parent-id={item.folder.id} aria-label={`从 ${item.folder.displayName} 拖出连接`} title={activeRelationChildId ? candidateError || '可连接' : item.folder.nodeRole === 'progress' ? '拖到普通文件夹创建下一版本，或拖到兼容节点建立关系' : '从右侧输出端拖到兼容节点'} onPointerDown={event => beginCreateVersionDrag(event, item.folder!.id, { x: item.x + nodeWidth, y: item.y + nodeHeight / 2 })} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateCreateVersionTarget(event.clientX, event.clientY, event.currentTarget); }} onPointerUp={event => endCreateVersionDrag(event, item.folder!.id)} onPointerCancel={cancelCreateVersionDrag} className="absolute -right-2.5 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity group-hover/version-node:opacity-100 group-focus-within/version-node:opacity-100 focus:opacity-100"><span aria-hidden className={`h-2.5 w-2.5 rounded-full border-2 border-white shadow ${candidateColor}`}/>{candidateHovered && candidateError && <span role="tooltip" className="pointer-events-none absolute left-5 top-1/2 z-40 -translate-y-1/2 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-[10px] font-medium text-white shadow-lg">{candidateError}</span>}</button>}
        </>}
      </div>; })}
    </div></div></div>
      <button type="button" onClick={fitView} title="小地图：点击显示全部" className="fixed bottom-4 right-4 z-[120] h-20 w-36 overflow-hidden rounded-lg border border-slate-300 bg-slate-950/75 shadow-lg"><svg viewBox={`0 0 ${Math.max(1, framedLayoutWidth)} ${Math.max(1, framedLayoutHeight)}`} className="h-full w-full">{layout.positioned.map(item => <rect key={item.key} x={item.x} y={item.y} width={nodeWidth} height={nodeHeight} rx="8" fill={item.areaKind === 'image' ? '#38bdf8' : item.areaKind === 'video' ? '#8b5cf6' : '#94a3b8'} opacity={selectedNodeKey === item.key ? 1 : .65}/>)}</svg></button>
    </div>}
    {filterActive && !hasGraphItems && <p className="py-6 text-center text-xs text-slate-400">没有文件符合当前搜索或筛选条件。</p>}
    {!hasGraphItems && !ordinaryEntries.length && <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">当前文件夹为空。</p>}
  </div>;
};
