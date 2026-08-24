import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentHostAction, ComponentPageOpenScope } from '../../types';
import { ComponentIcon } from '../../components/ComponentIcon';

const CONTEXT_MENU_VIEWPORT_MARGIN = 8;

export const ComponentToolbarActions = ({ actions, scope, onOpen, overflow = false }: { actions: ComponentHostAction[]; scope: ComponentPageOpenScope; onOpen: (action: ComponentHostAction, scope: ComponentPageOpenScope) => void; overflow?: boolean }) => actions.length ? <>{!overflow && <span aria-hidden className="toolbar-divider"/>}<div aria-label="UI 组件" className={overflow ? 'component-toolbar-actions-overflow' : 'component-toolbar-actions flex shrink-0 items-center gap-1'}>{actions.map(action => <button key={`${action.componentId}:${action.actionId}`} type="button" role={overflow ? 'menuitem' : undefined} onClick={() => onOpen(action, scope)} title={action.label} className={overflow ? 'project-menu-item' : 'project-action-button'}><ComponentIcon src={action.iconUrl} size={16}/><span>{action.label}</span></button>)}</div></> : null;

export const ViewportContextMenu = ({ x, y, widthClass, allowSubmenus = false, children }: { x: number; y: number; widthClass: string; allowSubmenus?: boolean; children: React.ReactNode }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });
  const updatePosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const availableHeight = Math.max(0, window.innerHeight - CONTEXT_MENU_VIEWPORT_MARGIN * 2);
    const width = menu.getBoundingClientRect().width;
    const height = Math.min(menu.scrollHeight, availableHeight);
    const left = Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(x, window.innerWidth - width - CONTEXT_MENU_VIEWPORT_MARGIN));
    const top = Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(y, window.innerHeight - height - CONTEXT_MENU_VIEWPORT_MARGIN));
    setPosition(current => current.left === left && current.top === top && current.ready ? current : { left, top, ready: true });
  }, [x, y]);

  useLayoutEffect(() => {
    updatePosition();
    const menu = menuRef.current;
    const resizeObserver = menu && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePosition) : null;
    if (menu) resizeObserver?.observe(menu);
    window.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('resize', updatePosition);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('resize', updatePosition);
    };
  }, [updatePosition]);

  return <div ref={menuRef} role="menu" className={`project-context-menu fixed z-[301] max-w-[calc(100vw-1rem)] rounded-lg border border-slate-200 bg-white p-1 shadow-xl ${allowSubmenus ? 'overflow-visible' : 'max-h-[calc(100vh-1rem)] overflow-y-auto overscroll-contain'} ${widthClass}`} style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }} onClick={event => event.stopPropagation()}>{children}</div>;
};

export const ColumnResizeHandle = ({ onDrag, label }: { onDrag: (deltaX: number) => void; label: string }) => {
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    let previousX = event.clientX;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - previousX;
      previousX = moveEvent.clientX;
      onDrag(deltaX);
    };
    const finish = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onDrag(event.key === 'ArrowLeft' ? -16 : 16);
  };
  return <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} className="column-resize-handle"/>;
};

export const FileListColumnResizeHandle = ({ onDrag, label, last = false }: { onDrag: (deltaX: number) => void; label: string; last?: boolean }) => {
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (moveEvent: PointerEvent) => onDrag(moveEvent.clientX - startX);
    const finish = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    onDrag(event.key === 'ArrowLeft' ? -16 : 16);
  };
  return <button type="button" role="separator" aria-orientation="vertical" aria-label={label} title={label} onPointerDown={onPointerDown} onKeyDown={onKeyDown} className={`file-list-column-resize-handle ${last ? 'is-last' : ''}`}/>;
};
