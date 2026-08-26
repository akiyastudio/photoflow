import './index.css';
import { createToastOverlayLayoutReporter, type ToastOverlayLayout } from './features/app/toast-overlay-layout-reporter';

declare global {
  interface Window {
    toastOverlay: {
      onSnapshot: (callback: (value: { html: string; dark: boolean; revision: number }) => void) => () => void;
      reportLayout: (layout: { visible: boolean; revision: number; x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }) => Promise<{ success: boolean; stale?: boolean }>;
      setPointerInteractive: (interactive: boolean) => void;
      sendAction: (action: string, id: string) => void;
    };
  }
}

const root = document.getElementById('toast-overlay-root');
if (!root) throw new Error('Toast overlay root is missing');

const ALLOWED_TAGS = new Set(['DIV', 'SPAN', 'BUTTON', 'P', 'SVG', 'PATH', 'CIRCLE', 'LINE', 'POLYLINE']);
const ALLOWED_ATTRIBUTES = new Set(['class', 'role', 'title', 'type', 'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'points']);
const sanitizeHostMarkup = (html: string) => {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const clean = document.createDocumentFragment();
  const copy = (node: Node, target: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { target.appendChild(document.createTextNode(node.textContent || '')); return; }
    if (!(node instanceof Element) || !ALLOWED_TAGS.has(node.tagName)) return;
    const element = document.createElementNS(node.namespaceURI === 'http://www.w3.org/2000/svg' ? node.namespaceURI : 'http://www.w3.org/1999/xhtml', node.tagName.toLowerCase());
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (ALLOWED_ATTRIBUTES.has(name) || name.startsWith('aria-') || name === 'data-top-toast-id' || name === 'data-toast-tone' || name === 'data-toast-overlay-action' || name === 'data-toast-overlay-id') element.setAttribute(attribute.name, attribute.value.slice(0, 2000));
      else if (name === 'style' && /^width:\s*(?:100|[0-9]{1,2}(?:\.[0-9]+)?)%;?$/i.test(attribute.value.trim())) element.setAttribute('style', attribute.value);
    }
    target.appendChild(element);
    for (const child of [...node.childNodes]) copy(child, element);
  };
  for (const child of [...parsed.body.childNodes]) copy(child, clean);
  return clean;
};

const TOAST_OVERLAY_GUTTER = 32;
const measureLayout = (revision: number): ToastOverlayLayout => {
  const viewportWidth = Math.max(0, Math.round(window.innerWidth));
  const viewportHeight = Math.max(0, Math.round(window.innerHeight));
  const stack = root.querySelector<HTMLElement>('.top-toast-stack--overlay');
  const hasVisibleToast = Boolean(stack?.querySelector('[data-top-toast-id]'));
  return !stack || !hasVisibleToast
    ? { visible: false, revision, x: 0, y: 0, width: 0, height: 0, viewportWidth, viewportHeight }
    : (() => {
        const rect = stack.getBoundingClientRect();
        const x = Math.max(0, Math.floor(rect.left - TOAST_OVERLAY_GUTTER));
        const y = Math.max(0, Math.floor(rect.top - TOAST_OVERLAY_GUTTER));
        const right = Math.min(viewportWidth, Math.ceil(rect.right + TOAST_OVERLAY_GUTTER));
        const bottom = Math.min(viewportHeight, Math.ceil(rect.bottom + TOAST_OVERLAY_GUTTER));
        return { visible: right > x && bottom > y, revision, x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y), viewportWidth, viewportHeight };
      })();
};
const layoutReporter = createToastOverlayLayoutReporter({
  measure: measureLayout,
  send: layout => { void window.toastOverlay.reportLayout(layout).catch(() => undefined); },
  setTimer: (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: timer => window.clearTimeout(timer),
  requestFrame: callback => window.requestAnimationFrame(callback),
  cancelFrame: frame => window.cancelAnimationFrame(frame),
});
const layoutObserver = new ResizeObserver(layoutReporter.schedule);
layoutObserver.observe(root);

window.toastOverlay.onSnapshot(snapshot => {
  const focused = document.activeElement instanceof HTMLElement ? { action: document.activeElement.dataset.toastOverlayAction, id: document.activeElement.dataset.toastOverlayId } : null;
  document.documentElement.classList.toggle('dark', snapshot.dark);
  const stack = document.createElement('div');
  stack.className = 'top-toast-stack top-toast-stack--overlay';
  stack.setAttribute('aria-label', '通知');
  stack.appendChild(sanitizeHostMarkup(snapshot.html));
  root.replaceChildren(stack);
  layoutObserver.disconnect();
  layoutObserver.observe(root);
  layoutObserver.observe(stack);
  layoutReporter.acceptSnapshot(snapshot.revision);
  if (focused?.action && focused.id) stack.querySelector<HTMLElement>(`[data-toast-overlay-action="${CSS.escape(focused.action)}"][data-toast-overlay-id="${CSS.escape(focused.id)}"]`)?.focus();
});

let interactive = false;
window.addEventListener('mousemove', event => {
  const next = event.target instanceof Element && Boolean(event.target.closest('[data-top-toast-id]'));
  if (next === interactive) return;
  interactive = next;
  window.toastOverlay.setPointerInteractive(next);
});
window.addEventListener('mouseleave', () => { interactive = false; window.toastOverlay.setPointerInteractive(false); });
window.addEventListener('resize', layoutReporter.schedule);
window.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-toast-overlay-action]') : null;
  const action = button?.dataset.toastOverlayAction;
  const id = button?.dataset.toastOverlayId;
  if (action && id) { event.preventDefault(); window.toastOverlay.sendAction(action, id); }
});
