import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { ProgressFolder, ProjectFileEntry, VersionGraphEdge } from '../types';
import { layoutVersionTree } from '../features/versioning/version-tree-layout-model';
import { DEFAULT_VERSION_TREE_SPACING, versionTreeCanvasBounds } from '../features/versioning/version-tree-canvas-model';
import { allowedVersionTreeRelationKinds, versionTreeEdgeGeometry, versionTreeEdgePath, versionTreeEdgePresentation, versionTreeRelationLabel, type VersionTreeEdgeKind, type VersionTreeSupplementalEdgeKind } from '../features/versioning/version-tree-edge-model';
import { useVersionTreeCanvas, type VersionTreeDragState } from '../features/versioning/use-version-tree-canvas';
import { progressRelationChangeError, projectVisibleVersionGraph, trackingStateLabel } from '../features/versioning/versioning-v2-model';

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
  onOpenMissingProgressMenu?: (folder: ProgressFolder, x: number, y: number) => void;
  pendingChildId?: string;
  hoverParentId?: string;
  mutatingChildIds?: string[];
  onBeginRelationEdit?: (childId: string) => void;
  onHoverRelationParent?: (parentId?: string) => void;
  onRequestRelationChange?: (childProgressId: string, parentProgressId: string | null) => void;
  onRequestSupplementalEdgeDelete?: (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => void;
  onRequestSupplementalEdgeReconnect?: (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>, newSourceProgressId: string) => void;
  onRequestSupplementalEdgeCreate?: (sourceProgressId: string, targetProgressId: string, edgeKind: VersionTreeSupplementalEdgeKind) => void;
  onCancelRelationEdit?: () => void;
  onNotice: (message: string, duration?: number) => void;
  onCanvasControllerChange?: (controller: VersionTreeCanvasController | null) => void;
};

export type VersionTreeCanvasController = {
  hasManualLayout: boolean;
  refreshLayout: () => Promise<boolean>;
};

type PositionedItem = { key: string; nodeKey: string; folder?: ProgressFolder; entry: ProjectFileEntry; x: number; y: number };
type LayoutRelation = { id: string; kind: VersionTreeEdgeKind; parentId: string; childId: string; selectable: boolean };
type DrawnEdge = { id: string; kind: VersionTreeEdgeKind; path: string; parentId?: string; childId?: string; endX: number; endY: number; menuX: number; menuY: number };

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('zh-CN');
const parentPath = (value: string) => normalizePath(value).split('/').slice(0, -1).join('/');
const EMPTY_VERSION_TREE_IDS: string[] = [];
const EMPTY_VERSION_TREE_EDGES: VersionGraphEdge[] = [];

export const ProjectVersionTree = ({ progressFolders, graphEdges = EMPTY_VERSION_TREE_EDGES, entries, structureEntries = entries, selectedRelativePaths = EMPTY_VERSION_TREE_IDS, filterActive = false, activeRelativePath, gridIconSize, workspacePath, projectName, projectRelativePath, renderEntry, pendingChildId, hoverParentId, mutatingChildIds = EMPTY_VERSION_TREE_IDS, onBeginRelationEdit, onHoverRelationParent, onRequestRelationChange, onRequestSupplementalEdgeDelete, onRequestSupplementalEdgeReconnect, onRequestSupplementalEdgeCreate, onCancelRelationEdit, onNotice, onCanvasControllerChange }: ProjectVersionTreeProps) => {
  const [pointerPoint, setPointerPoint] = useState<{ x: number; y: number } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [dragState, setDragState] = useState<VersionTreeDragState>(null);
  const [relationChoice, setRelationChoice] = useState<{ sourceId: string; targetId: string; kinds: VersionTreeEdgeKind[] } | null>(null);
  const dragStateRef = useRef<VersionTreeDragState>(null);
  const changeDragState = useCallback((next: VersionTreeDragState) => {
    dragStateRef.current = next;
    setDragState(next);
  }, []);
  const arrowMarkerId = `version-tree-arrow-${useId().replace(/:/g, '')}`;
  const activePortRef = useRef<{ element: Element; pointerId: number; childId: string } | null>(null);
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
    reconnectEdgeRef.current = null;
    dragStateRef.current = null;
  }, []);
  const scopePath = normalizePath(activeRelativePath);
  const graph = useMemo(() => projectVisibleVersionGraph(progressFolders, graphEdges), [graphEdges, progressFolders]);
  const entryByPath = useMemo(() => new Map(structureEntries.map(entry => [normalizePath(entry.relativePath), entry])), [structureEntries]);
  const versionItems = useMemo(() => graph.folders.flatMap(folder => {
    const relativePath = projectRelativePath(folder.folderPath);
    const entry = entryByPath.get(normalizePath(relativePath));
    return entry && parentPath(relativePath) === scopePath ? [{ folder, entry }] : [];
  }), [entryByPath, graph.folders, projectRelativePath, scopePath]);
  const visibleIds = useMemo(() => new Set(versionItems.map(item => item.folder.id)), [versionItems]);
  const visibleEdges = useMemo(() => graph.edges.filter(edge => visibleIds.has(edge.parentId) && visibleIds.has(edge.childId)), [graph.edges, visibleIds]);
  const trackedEntryPaths = useMemo(() => new Set(versionItems.map(item => normalizePath(item.entry.relativePath))), [versionItems]);
  const selectedPathSet = useMemo(() => new Set(selectedRelativePaths.map(normalizePath)), [selectedRelativePaths]);
  const selectedNodeIds = useMemo(() => new Set(versionItems.filter(item => selectedPathSet.has(normalizePath(item.entry.relativePath))).map(item => item.folder.id)), [selectedPathSet, versionItems]);
  const ordinaryEntries = useMemo(() => entries.filter(entry => !trackedEntryPaths.has(normalizePath(entry.relativePath))), [entries, trackedEntryPaths]);

  const nodeWidth = Math.max(80, gridIconSize);
  const nodeHeight = nodeWidth + 66;
  const { horizontalGap: columnGap, rowGap, auxiliaryGap, rootGap, padding: canvasPadding } = DEFAULT_VERSION_TREE_SPACING;
  const defaultLayout = useMemo(() => {
    const itemById = new Map(versionItems.map(item => [item.folder.id, item]));
    const forest = layoutVersionTree({
      nodes: versionItems.map(({ folder }) => ({ id: folder.id, mediaKind: folder.mediaKind, nodeRole: folder.nodeRole, artifactKind: folder.artifactKind, relationKind: folder.relationKind, createdAt: folder.createdAt })),
      edges: visibleEdges.map(edge => ({ ...edge, id: edge.id || `${edge.parentId}:${edge.childId}:${edge.relationKind}` })),
      nodeWidth, nodeHeight, columnGap, rowGap, auxiliaryGap, rootGap,
    });
    const positioned: PositionedItem[] = forest.nodes.flatMap(node => {
      const item = itemById.get(node.id);
      return item ? [{ key: node.id, nodeKey: `progress:${node.id}`, ...item, x: node.x, y: node.y }] : [];
    });
    const relations: LayoutRelation[] = forest.edges.map(edge => ({ id: edge.id, kind: edge.relationKind, parentId: edge.parentId, childId: edge.childId, selectable: true }));
    return { positioned, relations };
  }, [auxiliaryGap, columnGap, nodeHeight, nodeWidth, rootGap, rowGap, versionItems, visibleEdges]);
  const canvasNodes = useMemo(() => defaultLayout.positioned.map(item => ({ id: item.key, nodeKey: item.nodeKey, x: item.x, y: item.y })), [defaultLayout]);
  const canvas = useVersionTreeCanvas({
    nodes: canvasNodes,
    workspacePath, projectName, scopeKey: activeRelativePath, nodeWidth, nodeHeight, onNotice,
    selectedNodeIds, dragStateRef, onDragStateChange: changeDragState,
  });
  useEffect(() => {
    if (!onCanvasControllerChange) return;
    onCanvasControllerChange({ hasManualLayout: canvas.hasManualLayout, refreshLayout: canvas.refreshLayout });
    return () => onCanvasControllerChange(null);
  }, [canvas.hasManualLayout, canvas.refreshLayout, onCanvasControllerChange]);
  const layout = useMemo(() => {
    const positioned = defaultLayout.positioned.flatMap(item => {
      const position = canvas.positions.get(item.key);
      return position ? [{ ...item, x: canvasPadding + position.x, y: canvasPadding + position.y }] : [];
    });
    const byId = new Map(positioned.map(item => [item.key, item]));
    const edges: DrawnEdge[] = defaultLayout.relations.flatMap(edge => {
      const parent = byId.get(edge.parentId);
      const child = byId.get(edge.childId);
      if (!parent || !child) return [];
      const geometry = versionTreeEdgeGeometry(
        { x: parent.x, y: parent.y, width: nodeWidth, height: nodeHeight },
        { x: child.x, y: child.y, width: nodeWidth, height: nodeHeight },
      );
      return [{ id: edge.id, kind: edge.kind, path: geometry.path, parentId: edge.selectable ? edge.parentId : undefined, childId: edge.selectable ? edge.childId : undefined, endX: geometry.end.x, endY: geometry.end.y, menuX: geometry.midpoint.x, menuY: geometry.midpoint.y }];
    });
    const bounds = versionTreeCanvasBounds(canvas.positions, nodeWidth, nodeHeight, canvasPadding);
    return { positioned, edges, width: bounds.width, height: bounds.height };
  }, [canvas.positions, canvasPadding, defaultLayout, nodeHeight, nodeWidth]);

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
    setPointerPoint({ x: clientX - rect.left, y: clientY - rect.top });
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
  const pendingPosition = activeRelationChildId ? layout.positioned.find(item => item.key === activeRelationChildId) : undefined;
  const selectedEdge = layout.edges.find(edge => edge.id === selectedEdgeId && edge.childId && edge.parentId);
  const selectedChild = selectedEdge?.childId ? visibleFolderById.get(selectedEdge.childId) : undefined;
  const selectedParent = selectedEdge?.parentId ? visibleFolderById.get(selectedEdge.parentId) : undefined;
  const selectedBusy = Boolean(selectedChild && mutatingIds.has(selectedChild.id));
  const selectedSupplementalEdge = selectedEdge && ['media_companion', 'derived_preview', 'workflow_input'].includes(selectedEdge.kind)
    ? graphEdges.find(edge => edge.id === selectedEdge.id)
    : undefined;
  const selectedDeletionError = selectedChild && !selectedSupplementalEdge ? relationError(selectedChild.id, null) : '';
  const requestSelectedEdgeDeletion = () => {
    if (!selectedChild || selectedBusy) return;
    const error = progressRelationChangeError(graph.folders, selectedChild.id, selectedSupplementalEdge ? selectedChild.parentProgressId || null : null);
    if (selectedSupplementalEdge) {
      onRequestSupplementalEdgeDelete?.(selectedSupplementalEdge);
      return;
    }
    if (!error) onRequestRelationChange?.(selectedChild.id, null);
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
  const hasGraphItems = layout.positioned.length > 0;
  return <div className="relative min-w-0 flex-1 pb-4">
    {graph.cycleNodeIds.length > 0 && <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">版本关系需要修复：{graph.cycleNodeIds.join('、')}</div>}
    {relationChoice && <div role="dialog" aria-modal="true" aria-label="选择关系类型" className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4"><section className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"><h3 className="font-bold text-slate-800">选择关系类型</h3><p className="mt-1 text-xs text-slate-500">两端节点支持多种合法关系，请明确选择本次连线语义。</p><div className="mt-4 grid gap-2">{relationChoice.kinds.map(kind => <button key={kind} type="button" onClick={() => submitNewRelation(relationChoice.sourceId, relationChoice.targetId, kind)} className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-blue-400 hover:bg-blue-50">{versionTreeRelationLabel(kind)}</button>)}</div><button type="button" onClick={() => { setRelationChoice(null); onCancelRelationEdit?.(); }} className="mt-3 w-full rounded px-3 py-2 text-sm text-slate-500 hover:bg-slate-100">取消</button></section></div>}
    {hasGraphItems && <div ref={canvas.viewportRef} className="overflow-auto"><div data-version-tree-canvas="true" data-drag-state={dragState?.type} onPointerDown={event => { canvas.canvasPointerHandlers.onPointerDown(event); if (!(event.target as Element).closest('[data-version-tree-node],[data-edge-id],button')) cancelRelationSelection(); }} onPointerMove={canvas.canvasPointerHandlers.onPointerMove} onPointerUp={canvas.canvasPointerHandlers.onPointerUp} onPointerCancel={canvas.canvasPointerHandlers.onPointerCancel} className="relative cursor-default" style={{ width: layout.width, height: layout.height, minWidth: '100%', minHeight: 360, touchAction: 'none', backgroundImage: 'radial-gradient(circle, rgb(148 163 184 / 0.05) 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
      <svg aria-label="版本关系连线" className="absolute inset-0 h-full w-full overflow-visible"><defs><marker id={arrowMarkerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke"/></marker></defs>{layout.edges.map(edge => { const presentation = versionTreeEdgePresentation(edge.kind, selectedEdgeId === edge.id); return <g key={edge.id}>
        <path data-edge-id={edge.id} data-relation-kind={edge.kind} role={edge.childId ? 'button' : undefined} tabIndex={edge.childId ? 0 : undefined} aria-label={edge.childId ? `选择${versionTreeRelationLabel(edge.kind)}关系线` : undefined} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); selectEdge(edge); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectEdge(edge); } }} d={edge.path} fill="none" stroke="transparent" strokeWidth="14" pointerEvents="stroke" className={edge.childId ? 'cursor-pointer' : undefined}/>
        <path aria-hidden data-relation-kind={edge.kind} d={edge.path} fill="none" stroke={presentation.stroke} strokeWidth={presentation.strokeWidth} strokeDasharray={presentation.strokeDasharray} markerEnd={`url(#${arrowMarkerId})`} pointerEvents="none"/>
        {selectedEdgeId === edge.id && edge.childId && !mutatingIds.has(edge.childId) && <circle data-edge-child-handle={edge.childId} role="button" tabIndex={0} aria-label={`拖动${versionTreeRelationLabel(edge.kind)}终点以重新连接`} cx={edge.endX} cy={edge.endY} r="7" fill="white" stroke="#2563eb" strokeWidth="2" className="cursor-grab" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={event => { beginRelationDrag(event, edge.childId!, { x: edge.endX, y: edge.endY }, selectedSupplementalEdge); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePointerCandidate(event.clientX, event.clientY, event.currentTarget); }} onPointerUp={event => endRelationDrag(event, edge.childId!)} onPointerCancel={cancelRelationDrag}/>} {null}
      </g>; })}{pendingPosition && pointerPoint && <path d={versionTreeEdgePath(pendingPosition.x, pendingPosition.y + nodeHeight / 2, pointerPoint.x, pointerPoint.y)} fill="none" stroke={hoverParentId && activeRelationChildId && relationError(activeRelationChildId, hoverParentId) ? '#ef4444' : '#2563eb'} strokeWidth="2" strokeDasharray="5 4" pointerEvents="none"/>}</svg>
      {selectedEdge && selectedChild && selectedParent && <div role="status" style={{ left: selectedEdge.menuX, top: selectedEdge.menuY }} className="absolute z-30 flex -translate-x-1/2 -translate-y-1/2 flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-600 shadow-lg">
        <span>起点：{selectedParent.displayName}</span><span>终点：{selectedChild.displayName}</span><span>类型：{versionTreeRelationLabel(selectedEdge.kind)}</span>
        <button type="button" onClick={requestSelectedEdgeDeletion} disabled={selectedBusy || Boolean(selectedDeletionError)} title={selectedDeletionError || (selectedSupplementalEdge ? `删除${versionTreeRelationLabel(selectedEdge.kind)}关系；不会改变结构父节点，之后可以重新连接` : '删除结构关系并成为独立根节点')} className="rounded bg-red-50 px-2.5 py-1 text-red-700 disabled:cursor-not-allowed disabled:opacity-40">删除关系</button>
        <button type="button" onClick={cancelRelationSelection} className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100">关闭</button>
        {selectedChild.nodeRole === 'selection' && <span className="text-violet-600">选片关系只能更换来源</span>}
      </div>}
      {layout.positioned.map(item => {
        const nodeHandlers = canvas.nodePointerHandlers(item.key);
        const canBeParent = Boolean(item.folder && !item.folder.folderMissing && ['original', 'progress', 'selection', 'workflow'].includes(item.folder.nodeRole));
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
        return <div key={item.key} {...nodeHandlers} data-version-tree-node="true" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} className="group/version-node absolute cursor-grab active:cursor-grabbing" data-node-role={item.folder?.nodeRole} data-tracking-label={item.folder ? trackingStateLabel(item.folder) : undefined} style={{ left: item.x, top: item.y, width: nodeWidth, minHeight: nodeHeight, touchAction: 'none' }}>
        {renderEntry(item.entry, item.folder)}
        {item.folder && <>
          {(item.folder.nodeRole === 'progress' || item.folder.nodeRole === 'selection' || item.folder.nodeRole === 'workflow' || item.folder.nodeRole === 'artifact') && <button type="button" data-version-tree-port="true" disabled={mutatingIds.has(item.folder.id)} aria-label={`连接或修改 ${item.folder.displayName} 的输入关系`} title={mutatingIds.has(item.folder.id) ? '关系正在更新' : '拖动输入触点到合法的关系来源'} onPointerDown={event => { beginRelationDrag(event, item.folder!.id, { x: item.x, y: item.y + nodeHeight / 2 }); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePointerCandidate(event.clientX, event.clientY, event.currentTarget); }} onPointerUp={event => endRelationDrag(event, item.folder!.id)} onPointerCancel={cancelRelationDrag} className="absolute -left-2.5 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity group-hover/version-node:opacity-100 group-focus-within/version-node:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"><span aria-hidden className="h-2.5 w-2.5 rounded-full border-2 border-white bg-blue-600 shadow"/></button>}
          {canBeParent && <button type="button" data-version-tree-port="true" data-relation-parent-id={item.folder.id} aria-label={`${item.folder.displayName} 关系来源候选`} title={activeRelationChildId ? candidateError || '可连接' : '关系来源输出触点'} className="absolute -right-2.5 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity group-hover/version-node:opacity-100 group-focus-within/version-node:opacity-100 focus:opacity-100"><span aria-hidden className={`h-2.5 w-2.5 rounded-full border-2 border-white shadow ${candidateColor}`}/>{candidateHovered && candidateError && <span role="tooltip" className="pointer-events-none absolute left-5 top-1/2 z-40 -translate-y-1/2 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-[10px] font-medium text-white shadow-lg">{candidateError}</span>}</button>}
        </>}
      </div>; })}
    </div></div>}
    {ordinaryEntries.length > 0 && <section className={hasGraphItems ? 'mt-5 border-t border-slate-200 pt-4' : undefined}>{hasGraphItems && <p className="mb-2 px-1 text-xs font-medium text-slate-400">其他</p>}<div className="grid w-full content-start gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{ordinaryEntries.map(entry => <div key={`${entry.relativePath}|${entry.path}`} className="min-w-0">{renderEntry(entry)}</div>)}</div></section>}
    {filterActive && hasGraphItems && !ordinaryEntries.length && <p className="mt-5 border-t border-slate-200 py-6 text-center text-xs text-slate-400">没有其他文件符合当前搜索或筛选条件。</p>}
    {!hasGraphItems && !ordinaryEntries.length && <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">当前文件夹为空。</p>}
  </div>;
};
