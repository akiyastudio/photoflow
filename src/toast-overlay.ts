import './index.css';

declare global {
  interface Window {
    toastOverlay: {
      onSnapshot: (callback: (value: { html: string; dark: boolean }) => void) => () => void;
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

window.toastOverlay.onSnapshot(snapshot => {
  const focused = document.activeElement instanceof HTMLElement ? { action: document.activeElement.dataset.toastOverlayAction, id: document.activeElement.dataset.toastOverlayId } : null;
  document.documentElement.classList.toggle('dark', snapshot.dark);
  const stack = document.createElement('div');
  stack.className = 'top-toast-stack top-toast-stack--overlay';
  stack.setAttribute('aria-label', '通知');
  stack.appendChild(sanitizeHostMarkup(snapshot.html));
  root.replaceChildren(stack);
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
window.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-toast-overlay-action]') : null;
  const action = button?.dataset.toastOverlayAction;
  const id = button?.dataset.toastOverlayId;
  if (action && id) { event.preventDefault(); window.toastOverlay.sendAction(action, id); }
});
