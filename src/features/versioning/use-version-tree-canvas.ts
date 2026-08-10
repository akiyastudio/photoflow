import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';
import { reconcileVersionTreeCanvasPositions, translateVersionTreeCanvasSelection, type VersionTreeCanvasPosition } from './version-tree-canvas-model';

export type VersionTreeCanvasItem = { id: string; nodeKey: string; x: number; y: number };
export type VersionTreeDragState =
  | { type: 'node'; nodeKey: string; pointerId: number }
  | { type: 'relation'; childProgressId: string; pointerId: number }
  | { type: 'pan'; pointerId: number }
  | null;

type UseVersionTreeCanvasInput = {
  nodes: readonly VersionTreeCanvasItem[];
  workspacePath: string;
  projectName: string;
  scopeKey: string;
  nodeWidth: number;
  nodeHeight: number;
  coordinateScale?: number;
  onNotice: (message: string, duration?: number) => void;
  selectedNodeIds?: ReadonlySet<string>;
  dragStateRef: MutableRefObject<VersionTreeDragState>;
  onDragStateChange: (state: VersionTreeDragState) => void;
};

type NodeDrag = {
  element: Element;
  pointerId: number;
  anchorId: string;
  ids: string[];
  startClientX: number;
  startClientY: number;
  startPositions: Map<string, VersionTreeCanvasPosition>;
  before: Map<string, VersionTreeCanvasPosition>;
  dragged: boolean;
};

type CanvasPan = { element: Element; pointerId: number; clientX: number; clientY: number; scrollLeft: number; scrollTop: number };
const DRAG_THRESHOLD = 5;

export const useVersionTreeCanvas = ({ nodes, workspacePath, projectName, scopeKey, nodeWidth, nodeHeight, coordinateScale = 1, onNotice, selectedNodeIds = new Set(), dragStateRef, onDragStateChange }: UseVersionTreeCanvasInput) => {
  const nodesRef = useRef(nodes);
  const dimensionsRef = useRef({ nodeWidth, nodeHeight });
  const serverPositionsRef = useRef(new Map<string, VersionTreeCanvasPosition>());
  const appliedServerNodeKeysRef = useRef(new Set<string>());
  nodesRef.current = nodes;
  dimensionsRef.current = { nodeWidth, nodeHeight };
  const defaultPositions = useCallback(() => new Map(nodesRef.current.map(node => [node.id, { x: node.x, y: node.y }])), []);
  const [positions, setPositions] = useState<Map<string, VersionTreeCanvasPosition>>(defaultPositions);
  const positionsRef = useRef(positions);
  const revisionRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const saveQueueRef = useRef(Promise.resolve());
  const generationRef = useRef(0);
  const disposedRef = useRef(false);
  const nodeDragRef = useRef<NodeDrag | null>(null);
  const canvasPanRef = useRef<CanvasPan | null>(null);
  const suppressClickRef = useRef('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const spacePressedRef = useRef(false);
  positionsRef.current = positions;

  const applyPositions = useCallback((next: Map<string, VersionTreeCanvasPosition>) => {
    if (disposedRef.current) return;
    positionsRef.current = next;
    setPositions(next);
  }, []);

  const loadServerLayout = useCallback(async (generation = generationRef.current) => {
    if (disposedRef.current || generation !== generationRef.current) return;
    const sequence = ++loadSequenceRef.current;
    const result = await window.electronAPI.getVersionTreeLayout(workspacePath, projectName, scopeKey).catch(error => ({
      success: false,
      revision: 0,
      positions: [],
      error: error instanceof Error ? error.message : String(error),
    }));
    if (disposedRef.current || generation !== generationRef.current || sequence !== loadSequenceRef.current) return;
    if (!result.success) {
      onNotice(`读取版本树布局失败：${result.error || '未知错误'}`, 5000);
      return;
    }
    revisionRef.current = result.revision;
    serverPositionsRef.current = new Map(result.positions.map(position => [position.nodeKey, { x: position.x, y: position.y, manual: true }]));
    appliedServerNodeKeysRef.current = new Set();
    const currentNodes = nodesRef.current;
    const idByNodeKey = new Map(currentNodes.map(node => [node.nodeKey, node.id]));
    const saved = new Map<string, VersionTreeCanvasPosition>();
    result.positions.forEach(position => {
      const id = idByNodeKey.get(position.nodeKey);
      if (id) {
        saved.set(id, { x: position.x, y: position.y, manual: true });
        appliedServerNodeKeysRef.current.add(position.nodeKey);
      }
    });
    const dimensions = dimensionsRef.current;
    applyPositions(reconcileVersionTreeCanvasPositions({ nodes: currentNodes, previous: saved, nodeWidth: dimensions.nodeWidth, nodeHeight: dimensions.nodeHeight }));
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
      viewportRef.current.scrollTop = 0;
    }
  }, [applyPositions, onNotice, projectName, scopeKey, workspacePath]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      generationRef.current += 1;
      loadSequenceRef.current += 1;
      const drag = nodeDragRef.current;
      if (drag?.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
      const pan = canvasPanRef.current;
      if (pan?.element.hasPointerCapture(pan.pointerId)) pan.element.releasePointerCapture(pan.pointerId);
      nodeDragRef.current = null;
      canvasPanRef.current = null;
      suppressClickRef.current = '';
      spacePressedRef.current = false;
      dragStateRef.current = null;
      saveQueueRef.current = Promise.resolve();
    };
  }, [dragStateRef]);

  useEffect(() => {
    const generation = ++generationRef.current;
    serverPositionsRef.current = new Map();
    appliedServerNodeKeysRef.current = new Set();
    applyPositions(defaultPositions());
    void loadServerLayout(generation);
    return () => { loadSequenceRef.current += 1; generationRef.current += 1; saveQueueRef.current = Promise.resolve(); };
  }, [applyPositions, defaultPositions, loadServerLayout]);

  useEffect(() => {
    const previous = new Map(positionsRef.current);
    nodes.forEach(node => {
      const saved = serverPositionsRef.current.get(node.nodeKey);
      if (saved && !appliedServerNodeKeysRef.current.has(node.nodeKey)) {
        previous.set(node.id, saved);
        appliedServerNodeKeysRef.current.add(node.nodeKey);
      }
    });
    applyPositions(reconcileVersionTreeCanvasPositions({ nodes, previous, nodeWidth, nodeHeight }));
  }, [applyPositions, nodeHeight, nodeWidth, nodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.code === 'Space' && !(event.target as Element | null)?.closest?.('input,select,textarea')) { spacePressedRef.current = true; event.preventDefault(); } };
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') spacePressedRef.current = false; };
    const onBlur = () => { spacePressedRef.current = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); };
  }, []);

  const enqueueSave = useCallback((mode: 'patch' | 'replace', savedPositions: Map<string, VersionTreeCanvasPosition>, before: Map<string, VersionTreeCanvasPosition>, applyOnSuccess?: Map<string, VersionTreeCanvasPosition>) => {
    if (disposedRef.current) return Promise.resolve(false);
    const generation = generationRef.current;
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const operation = saveQueueRef.current.then(async () => {
      if (disposedRef.current || generation !== generationRef.current) return false;
      const payload = [...savedPositions].flatMap(([id, position]) => {
        const node = nodeById.get(id);
        return node ? [{ nodeKey: node.nodeKey, x: position.x, y: position.y }] : [];
      });
      const result = await window.electronAPI.saveVersionTreeLayout(workspacePath, projectName, {
        scopeKey,
        expectedRevision: revisionRef.current,
        mode,
        positions: payload,
      }).catch(error => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
      if (disposedRef.current || generation !== generationRef.current) return false;
      if (result.success) {
        revisionRef.current = 'revision' in result && result.revision !== undefined ? result.revision : revisionRef.current + 1;
        if (applyOnSuccess) {
          applyPositions(applyOnSuccess);
          if (viewportRef.current) {
            viewportRef.current.scrollLeft = 0;
            viewportRef.current.scrollTop = 0;
          }
        }
        return true;
      }
      if (!applyOnSuccess) applyPositions(before);
      onNotice(`保存版本树布局失败：${result.error || '未知错误'}`, 5000);
      if (!applyOnSuccess) await loadServerLayout(generation);
      return false;
    });
    saveQueueRef.current = operation.then(() => undefined);
    return operation;
  }, [applyPositions, loadServerLayout, nodes, onNotice, projectName, scopeKey, workspacePath]);

  const nodePointerHandlers = useCallback((id: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disposedRef.current || dragStateRef.current || event.button !== 0 || (event.target as Element).closest('button,input,select,textarea,[data-version-tree-port]')) return;
      const startPosition = positionsRef.current.get(id);
      if (!startPosition) return;
      const ids = selectedNodeIds.has(id) && selectedNodeIds.size > 1
        ? [...selectedNodeIds].filter(candidate => positionsRef.current.has(candidate))
        : [id];
      const startPositions = new Map(ids.flatMap(candidate => {
        const position = positionsRef.current.get(candidate);
        return position ? [[candidate, position] as const] : [];
      }));
      event.currentTarget.setPointerCapture(event.pointerId);
      onDragStateChange({ type: 'node', nodeKey: id, pointerId: event.pointerId });
      nodeDragRef.current = { element: event.currentTarget, pointerId: event.pointerId, anchorId: id, ids, startClientX: event.clientX, startClientY: event.clientY, startPositions, before: new Map(positionsRef.current), dragged: false };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = nodeDragRef.current;
      if (!drag || drag.anchorId !== id || drag.pointerId !== event.pointerId) return;
      const scale = Number.isFinite(coordinateScale) && coordinateScale > 0 ? coordinateScale : 1;
      const deltaX = (event.clientX - drag.startClientX) / scale;
      const deltaY = (event.clientY - drag.startClientY) / scale;
      if (!drag.dragged && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
      drag.dragged = true;
      event.preventDefault();
      const moved = translateVersionTreeCanvasSelection(drag.startPositions, deltaX, deltaY);
      const next = new Map(positionsRef.current);
      moved.forEach((position, nodeId) => next.set(nodeId, position));
      applyPositions(next);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = nodeDragRef.current;
      if (!drag || drag.anchorId !== id || drag.pointerId !== event.pointerId) return;
      if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
      nodeDragRef.current = null;
      onDragStateChange(null);
      if (!drag.dragged) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = id;
      const moved = new Map(drag.ids.flatMap(nodeId => {
        const position = positionsRef.current.get(nodeId);
        return position ? [[nodeId, position] as const] : [];
      }));
      if (moved.size) void enqueueSave('patch', moved, drag.before);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = nodeDragRef.current;
      if (!drag || drag.anchorId !== id || drag.pointerId !== event.pointerId) return;
      if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
      nodeDragRef.current = null;
      onDragStateChange(null);
      applyPositions(drag.before);
    },
    onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current !== id) return;
      suppressClickRef.current = '';
      event.preventDefault();
      event.stopPropagation();
    },
  }), [applyPositions, coordinateScale, dragStateRef, enqueueSave, onDragStateChange, selectedNodeIds]);

  const canvasPointerHandlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      const shouldPan = event.button === 1 || event.button === 0 && spacePressedRef.current;
      if (disposedRef.current || dragStateRef.current || !shouldPan || (event.target as Element).closest('[data-version-tree-node]')) return;
      const viewport = viewportRef.current;
      if (!viewport) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      onDragStateChange({ type: 'pan', pointerId: event.pointerId });
      canvasPanRef.current = { element: event.currentTarget, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const pan = canvasPanRef.current;
      const viewport = viewportRef.current;
      if (!pan || !viewport || pan.pointerId !== event.pointerId) return;
      viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
      viewport.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const pan = canvasPanRef.current;
      if (!pan || pan.pointerId !== event.pointerId) return;
      if (pan.element.hasPointerCapture(pan.pointerId)) pan.element.releasePointerCapture(pan.pointerId);
      canvasPanRef.current = null;
      onDragStateChange(null);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => {
      const pan = canvasPanRef.current;
      if (!pan || pan.pointerId !== event.pointerId) return;
      if (pan.element.hasPointerCapture(pan.pointerId)) pan.element.releasePointerCapture(pan.pointerId);
      canvasPanRef.current = null;
      onDragStateChange(null);
    },
  };

  const refreshLayout = useCallback(async () => {
    const before = new Map(positionsRef.current);
    const next = defaultPositions();
    return enqueueSave('replace', next, before, next);
  }, [defaultPositions, enqueueSave]);

  const resetViewport = useCallback(() => {
    if (!viewportRef.current) return;
    viewportRef.current.scrollLeft = 0;
    viewportRef.current.scrollTop = 0;
  }, []);

  const hasManualLayout = nodes.some(node => {
    const position = positions.get(node.id);
    return Boolean(position && (position.x !== node.x || position.y !== node.y));
  });

  return { positions, viewportRef, nodePointerHandlers, canvasPointerHandlers, refreshLayout, resetViewport, hasManualLayout };
};
