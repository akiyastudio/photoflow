const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

class TestEventTarget {
  addEventListener() {}
  removeEventListener() {}
}
class TestNode extends TestEventTarget {
  constructor(nodeType, nodeName, ownerDocument) {
    super(); this.nodeType = nodeType; this.nodeName = nodeName; this.tagName = nodeType === 1 ? nodeName : undefined;
    this.ownerDocument = ownerDocument; this.parentNode = null; this.childNodes = []; this.attributes = new Map(); this.style = {};
    this.nodeValue = nodeType === 3 ? '' : null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  insertBefore(child, before) { child.parentNode = this; const index = this.childNodes.indexOf(before); this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child); return child; }
  removeChild(child) { const index = this.childNodes.indexOf(child); if (index >= 0) this.childNodes.splice(index, 1); child.parentNode = null; return child; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get children() { return this.childNodes.filter(child => child.nodeType === 1); }
  get childElementCount() { return this.childNodes.filter(child => child.nodeType === 1).length; }
  get scrollHeight() { return this.getBoundingClientRect().height; }
  getBoundingClientRect() { return { x: 0, y: 40, top: 40, bottom: this.childElementCount ? 140 : 40, width: 480, height: this.childElementCount ? 100 : 0 }; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { if (this.nodeType === 3) this.nodeValue = String(value); else this.childNodes = value ? [Object.assign(new TestNode(3, '#text', this.ownerDocument), { nodeValue: String(value), parentNode: this })] : []; }
  get innerHTML() { return this.textContent; }
}

const testWindow = new TestEventTarget();
const testDocument = new TestEventTarget();
Object.assign(testDocument, {
  nodeType: 9, nodeName: '#document', defaultView: testWindow, activeElement: null,
  createElement: name => new TestNode(1, name.toUpperCase(), testDocument),
  createTextNode: text => Object.assign(new TestNode(3, '#text', testDocument), { nodeValue: String(text) }),
});
testDocument.documentElement = new TestNode(1, 'HTML', testDocument);
testDocument.documentElement.classList = { contains: name => name === 'dark' && testDocument.documentElement.attributes.get('class')?.split(/\s+/).includes('dark') };
testDocument.body = new TestNode(1, 'BODY', testDocument);
testWindow.document = testDocument;

let timerSequence = 0;
const timers = new Map();
let frameSequence = 0;
const frames = new Map();
const snapshots = [];
let presentationListener = null;
const observers = [];
class TestResizeObserver {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() {}
}
Object.assign(testWindow, {
  HTMLElement: TestNode,
  HTMLIFrameElement: class {},
  Node: TestNode,
  setTimeout: (callback, delay) => { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; },
  clearTimeout: id => timers.delete(id),
  requestAnimationFrame: callback => { const id = ++frameSequence; frames.set(id, callback); return id; },
  cancelAnimationFrame: id => frames.delete(id),
  ResizeObserver: TestResizeObserver,
  electronAPI: {
    onComponentNotification: () => () => undefined,
    setComponentNotificationReady: async () => ({ ready: true, flushed: 0 }),
    updateToastView: async snapshot => { snapshots.push(snapshot); return { success: true }; },
    onToastViewAction: () => () => undefined,
    onToastViewPresentation: callback => { presentationListener = callback; return () => { presentationListener = null; }; },
  },
});
global.window = testWindow;
global.document = testDocument;
global.navigator = { userAgent: 'node' };
global.Node = TestNode;
global.HTMLElement = TestNode;
global.ResizeObserver = TestResizeObserver;
global.IS_REACT_ACT_ENVIRONMENT = true;

const compile = relativePath => ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const evaluate = (compiled, requireModule) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(module, module.exports, requireModule);
  return module.exports;
};
const model = evaluate(compile('src/features/app/top-toast-notice-model.ts'), require);
const toneModel = evaluate(compile('src/features/app/top-toast-tone-model.ts'), request => {
  if (request === 'lucide-react') return { AlertTriangle: () => null, CheckCircle2: () => null, Info: () => null, XCircle: () => null };
  return require(request);
});
const icons = new Proxy({}, { get: () => () => null });
const emptyTaskPresentation = { visibleTasks: [], overflowCount: 0, dismissBackgroundTask: () => undefined, minimizeTaskToast: () => undefined };
const toastModule = evaluate(compile('src/features/app/useTopToastStack.tsx'), request => {
  if (request === 'lucide-react') return icons;
  if (request === '../../components/LayerProvider') return { useHostRendererToken: () => 'renderer-test' };
  if (request === '../background-tasks/FileTransferToast') return { FileTransferToast: () => null, useFileTransferToastPresentation: () => emptyTaskPresentation };
  if (request === './top-toast-notice-model') return model;
  if (request === './top-toast-tone-model') return toneModel;
  return require(request);
});

const findAll = (node, predicate, result = []) => {
  if (predicate(node)) result.push(node);
  for (const child of node.childNodes || []) findAll(child, predicate, result);
  return result;
};
const flushFrames = timestamp => {
  const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(timestamp));
};

(async () => {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  let toast;
  const Harness = () => { toast = toastModule.useToast(); return null; };
  const container = new TestNode(1, 'DIV', testDocument);
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(toastModule.TopToastProvider, null,
    React.createElement(toastModule.TopToastViewport), React.createElement(Harness))));
  await React.act(async () => flushFrames(1));
  assert.equal(snapshots.length, 1, 'initial viewport mount publishes one structured Toast view snapshot');
  assert(!findAll(container, node => node.getAttribute?.('data-toast-view-model'))[0].getAttribute('class').includes('top-toast-stack--model'), 'the host fallback remains visible until the native view confirms the current revision');

  let first; let replacement;
  await React.act(async () => {
    first = toast.show('准备保存', { tone: 'info', dedupeKey: 'same-tick', durationMs: 900 });
    replacement = toast.show('保存失败', { tone: 'error', dedupeKey: 'same-tick', lifecycle: 'persistent' });
    assert.equal(replacement.id, first.id, 'same-tick same-key show must synchronously resolve to the existing card');
  });
  let cards = findAll(container, node => node.getAttribute?.('data-top-toast-id'));
  assert.equal(cards.length, 1); assert.equal(cards[0].getAttribute('data-toast-tone'), 'error'); assert.match(cards[0].textContent, /保存失败/);
  assert.equal(timers.size, 0, 'replacing an auto notice with a persistent notice clears the old timer immediately');

  let failedActivity; let dismissedActivity;
  await React.act(async () => {
    failedActivity = toast.activity('正在处理', { dedupeKey: 'immediate-fail' });
    failedActivity.fail('处理失败');
    dismissedActivity = toast.activity('无需继续', { dedupeKey: 'immediate-dismiss' });
    dismissedActivity.dismiss();
  });
  cards = findAll(container, node => node.getAttribute?.('data-top-toast-id'));
  const failedCard = cards.find(node => node.getAttribute('data-top-toast-id') === `notice:${failedActivity.id}`);
  assert(failedCard && failedCard.getAttribute('data-toast-tone') === 'error' && /处理失败/.test(failedCard.textContent), 'activity.fail in the creation tick updates the mounted card');
  assert(!cards.some(node => node.getAttribute('data-top-toast-id') === `notice:${dismissedActivity.id}`), 'activity.dismiss in the creation tick removes the card');

  assert.equal(frames.size, 1, 'batched notice mutations schedule at most one pending Toast view frame');
  observers.forEach(observer => { observer.callback([]); observer.callback([]); observer.callback([]); });
  assert.equal(frames.size, 1, 'repeated resize callbacks coalesce into the pending Toast view frame');
  await React.act(async () => flushFrames(2));
  assert.equal(snapshots.length, 2, 'one animation frame produces only one additional structured snapshot');
  assert.equal(snapshots.at(-1).notices[0].message, '保存失败');
  await React.act(async () => presentationListener({ visible: true }));
  assert(findAll(container, node => node.getAttribute?.('data-toast-view-model'))[0].getAttribute('class').includes('top-toast-stack--model'), 'the host fallback hides only after native presentation acknowledgement');
  await React.act(async () => {
    toast.show('继续处理', { tone: 'info', durationMs: 900 });
  });
  await React.act(async () => flushFrames(3));
  assert(findAll(container, node => node.getAttribute?.('data-toast-view-model'))[0].getAttribute('class').includes('top-toast-stack--model'), 'new progress snapshots keep the stable native presentation lease instead of flashing the fallback');
  await React.act(async () => presentationListener({ visible: false }));
  assert(!findAll(container, node => node.getAttribute?.('data-toast-view-model'))[0].getAttribute('class').includes('top-toast-stack--model'), 'the host fallback returns when the native surface becomes unavailable');

  await React.act(async () => root.unmount());
  assert.equal(snapshots.at(-1).height, 0, 'unmount hides the persistent Toast view');
  console.log('top toast mounted hook tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
