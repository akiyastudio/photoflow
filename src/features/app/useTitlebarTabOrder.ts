import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

const TITLEBAR_TAB_ORDER_KEY = 'photoflow:titlebar-tab-order';
const TAB_DRAG_THRESHOLD_PX = 5;
const TAB_EDGE_SCROLL_ZONE_PX = 36;

export const projectTabId = (projectPath: string) => `project:${projectPath}`;
export const workspaceToolTabId = (projectPath: string, kind: string) => `project-tool:${kind}:${projectPath}`;

const completeVisibleOrder = (savedOrder: string[], visibleIds: string[]) => {
  const visible = new Set(visibleIds);
  const ordered = savedOrder.filter((id, index) => visible.has(id) && savedOrder.indexOf(id) === index);
  return [...ordered, ...visibleIds.filter(id => !ordered.includes(id))];
};

const keepPinnedInspirationBesideHome = (orderedIds: string[], inspirationPinned: boolean) => {
  if (!inspirationPinned || !orderedIds.includes('home') || !orderedIds.includes('inspiration')) return orderedIds;
  const next = orderedIds.filter(id => id !== 'inspiration');
  next.splice(next.indexOf('home') + 1, 0, 'inspiration');
  return next;
};

export const useTitlebarTabOrder = ({
  inspirationOpen,
  inspirationPinned,
  projectPaths,
  toolTabs,
  settingsOpen,
}: {
  inspirationOpen: boolean;
  inspirationPinned: boolean;
  projectPaths: string[];
  toolTabs: Array<{ projectPath: string; kind: string }>;
  settingsOpen: boolean;
}) => {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(TITLEBAR_TAB_ORDER_KEY) || '[]');
      return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  });
  const [draggedId, setDraggedId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' }>();
  const suppressClickRef = useRef<string>();
  const activeDragCleanupRef = useRef<() => void>();

  useEffect(() => {
    try {
      window.localStorage.setItem(TITLEBAR_TAB_ORDER_KEY, JSON.stringify(order));
    } catch {
      // Tab ordering is a convenience; storage being unavailable must not break navigation.
    }
  }, [order]);

  useEffect(() => () => activeDragCleanupRef.current?.(), []);

  const visibleIds = useMemo(() => [
    'home',
    ...(inspirationOpen ? ['inspiration'] : []),
    ...projectPaths.flatMap(projectPath => [
      projectTabId(projectPath),
      ...toolTabs.filter(tab => tab.projectPath === projectPath).map(tab => workspaceToolTabId(projectPath, tab.kind)),
    ]),
    ...(settingsOpen ? ['settings'] : []),
  ], [inspirationOpen, projectPaths, settingsOpen, toolTabs]);

  const orderedVisibleIds = useMemo(() => keepPinnedInspirationBesideHome(
    completeVisibleOrder(order, visibleIds),
    inspirationPinned,
  ), [inspirationPinned, order, visibleIds]);

  const reorder = useCallback((sourceId: string, targetId: string, side: 'before' | 'after') => {
    if (sourceId === targetId) return;
    setOrder(current => {
      const next = completeVisibleOrder(current, visibleIds).filter(id => id !== sourceId);
      const targetIndex = next.indexOf(targetId);
      if (targetIndex < 0) return current;
      next.splice(targetIndex + (side === 'after' ? 1 : 0), 0, sourceId);
      return keepPinnedInspirationBesideHome(next, inspirationPinned);
    });
  }, [inspirationPinned, visibleIds]);

  return (id: string) => {
    const draggable = id !== 'inspiration' || !inspirationPinned;
    return {
      'data-titlebar-tab-id': id,
      'data-tab-draggable': draggable || undefined,
      'aria-grabbed': draggedId === id || undefined,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (!draggable || event.button !== 0 || (event.target as HTMLElement).closest('[data-tab-drag-ignore="true"]')) return;
        activeDragCleanupRef.current?.();
        const sourceElement = event.currentTarget;
        const container = sourceElement.parentElement;
        if (!container) return;
        const pointerId = event.pointerId;
        const startX = event.clientX;
        let started = false;
        const previousUserSelect = document.body.style.userSelect;
        const previousCursor = document.body.style.cursor;

        const finish = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finishPointer);
          window.removeEventListener('pointercancel', finishPointer);
          window.removeEventListener('blur', finish);
          if (started) {
            suppressClickRef.current = id;
            window.setTimeout(() => {
              if (suppressClickRef.current === id) suppressClickRef.current = undefined;
            }, 0);
          }
          document.body.style.userSelect = previousUserSelect;
          document.body.style.cursor = previousCursor;
          setDraggedId(undefined);
          setDropTarget(undefined);
          activeDragCleanupRef.current = undefined;
        };
        const finishPointer = (pointerEvent: PointerEvent) => {
          if (pointerEvent.pointerId === pointerId) finish();
        };
        const move = (pointerEvent: PointerEvent) => {
          if (pointerEvent.pointerId !== pointerId) return;
          if (!started) {
            if (Math.abs(pointerEvent.clientX - startX) < TAB_DRAG_THRESHOLD_PX) return;
            started = true;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'grabbing';
            setDraggedId(id);
          }
          pointerEvent.preventDefault();
          const containerRect = container.getBoundingClientRect();
          if (pointerEvent.clientX < containerRect.left + TAB_EDGE_SCROLL_ZONE_PX) container.scrollLeft -= 18;
          else if (pointerEvent.clientX > containerRect.right - TAB_EDGE_SCROLL_ZONE_PX) container.scrollLeft += 18;

          const candidates = [...container.querySelectorAll<HTMLElement>('[data-titlebar-tab-id]')]
            .filter(candidate => candidate.dataset.titlebarTabId !== id);
          const target = candidates.reduce<HTMLElement | undefined>((nearest, candidate) => {
            const candidateCenter = candidate.getBoundingClientRect().left + candidate.getBoundingClientRect().width / 2;
            if (!nearest) return candidate;
            const nearestRect = nearest.getBoundingClientRect();
            const nearestCenter = nearestRect.left + nearestRect.width / 2;
            return Math.abs(candidateCenter - pointerEvent.clientX) < Math.abs(nearestCenter - pointerEvent.clientX) ? candidate : nearest;
          }, undefined);
          if (!target?.dataset.titlebarTabId) return;
          const targetRect = target.getBoundingClientRect();
          const side = pointerEvent.clientX < targetRect.left + targetRect.width / 2 ? 'before' : 'after';
          setDropTarget({ id: target.dataset.titlebarTabId, side });
          reorder(id, target.dataset.titlebarTabId, side);
        };

        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', finishPointer);
        window.addEventListener('pointercancel', finishPointer);
        window.addEventListener('blur', finish);
        activeDragCleanupRef.current = finish;
      },
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (suppressClickRef.current !== id) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = undefined;
      },
      style: { order: orderedVisibleIds.indexOf(id) },
      'data-dragging': draggedId === id || undefined,
      'data-drop-target': dropTarget?.id === id || undefined,
      'data-drop-side': dropTarget?.id === id ? dropTarget.side : undefined,
    };
  };
};
