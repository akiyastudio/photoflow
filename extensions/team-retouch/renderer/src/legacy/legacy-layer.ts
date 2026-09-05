import { useEffect, useRef, type RefObject } from 'react';
import { createModalStack, nextFocusIndex } from './modal-stack-model';

const stack = createModalStack();
const roots = new Map<number, HTMLElement>();
const mutedBackground = new Map<Element, { ariaHidden: string | null; inert: boolean }>();
const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const syncBackground = () => {
  for (const [element, previous] of mutedBackground) {
    if (previous.ariaHidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', previous.ariaHidden);
    if (!previous.inert) element.removeAttribute('inert');
  }
  mutedBackground.clear();
  const topRoot = roots.get(stack.topToken() ?? -1);
  let branch: Element | null = topRoot || null;
  while (branch?.parentElement) {
    for (const sibling of Array.from(branch.parentElement.children)) {
      if (sibling === branch) continue;
      mutedBackground.set(sibling, { ariaHidden: sibling.getAttribute('aria-hidden'), inert: sibling.hasAttribute('inert') });
      sibling.setAttribute('aria-hidden', 'true'); sibling.setAttribute('inert', '');
    }
    branch = branch.parentElement;
  }
};
const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(item => !item.hidden && item.getAttribute('aria-hidden') !== 'true');

if (typeof window !== 'undefined') window.addEventListener('keydown', event => {
  const token = stack.topToken();
  if (token === undefined) return;
  if (event.key === 'Escape') { event.preventDefault(); stack.escape(); return; }
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
    const root = rootRef.current || fallbackRoot;
    if (root) roots.set(token, root);
    syncBackground();
    root?.querySelector<HTMLElement>('[data-autofocus], input[autofocus], button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus();
    return () => { stack.unregister(token); roots.delete(token); syncBackground(); if (opener?.isConnected) opener.focus(); };
  }, [active]);
  useEffect(() => { if (tokenRef.current !== undefined) stack.update(tokenRef.current, () => closeRef.current(), dismissible); }, [dismissible]);
  return rootRef;
};
