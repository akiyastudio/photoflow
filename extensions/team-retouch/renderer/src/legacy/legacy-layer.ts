import { useEffect, useRef, type RefObject } from 'react';
import { createModalStack, nextFocusIndex } from './modal-stack-model';

const stack = createModalStack();
const roots = new Map<number, HTMLElement>();
const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const syncBackground = () => {
  const topRoot = roots.get(stack.topToken() ?? -1);
  for (const child of Array.from(document.body.children)) {
    if (topRoot && !child.contains(topRoot)) { child.setAttribute('aria-hidden', 'true'); child.setAttribute('inert', ''); }
    else { child.removeAttribute('aria-hidden'); child.removeAttribute('inert'); }
  }
};
const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(item => !item.hidden && item.getAttribute('aria-hidden') !== 'true');

if (typeof window !== 'undefined') window.addEventListener('keydown', event => {
  const token = stack.topToken();
  if (token === undefined) return;
  if (event.key === 'Escape') { if (stack.escape()) event.preventDefault(); return; }
  if (event.key !== 'Tab') return;
  const root = roots.get(token);
  if (!root) return;
  const items = focusables(root);
  const next = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
  if (next >= 0) { event.preventDefault(); items[next].focus(); }
});

export const useEscapeLayer = <T extends HTMLElement>(active: boolean, close: () => void, dismissible = true): RefObject<T> => {
  const rootRef = useRef<T>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  const tokenRef = useRef<number>();
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const token = stack.register(() => closeRef.current(), dismissibleRef.current);
    tokenRef.current = token;
    const fallbackRoot = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).reverse().find(root => ![...roots.values()].includes(root));
    if (rootRef.current || fallbackRoot) roots.set(token, rootRef.current || fallbackRoot!);
    syncBackground();
    rootRef.current?.querySelector<HTMLElement>('[data-autofocus], input[autofocus], button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus();
    return () => { stack.unregister(token); roots.delete(token); syncBackground(); if (opener?.isConnected) opener.focus(); };
  }, [active]);
  useEffect(() => { if (tokenRef.current !== undefined) stack.update(tokenRef.current, () => closeRef.current(), dismissible); }, [dismissible]);
  return rootRef;
};
