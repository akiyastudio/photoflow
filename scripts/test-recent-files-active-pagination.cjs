const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

class TestEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener(); }
}

class TestNode extends TestEventTarget {
  constructor(nodeType, nodeName, ownerDocument) {
    super();
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.tagName = nodeType === 1 ? nodeName : undefined;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.style = {};
    this.attributes = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  insertBefore(child, before) { child.parentNode = this; const index = this.childNodes.indexOf(before); this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child); return child; }
  removeChild(child) { const index = this.childNodes.indexOf(child); if (index >= 0) this.childNodes.splice(index, 1); child.parentNode = null; return child; }
  get firstChild() { return this.childNodes[0] || null; }
}

let nextFrameId = 1;
const frames = new Map();
const testWindow = Object.assign(new TestEventTarget(), {
  requestAnimationFrame: callback => { const id = nextFrameId++; frames.set(id, callback); return id; },
  cancelAnimationFrame: id => frames.delete(id),
  HTMLElement: TestNode,
  HTMLIFrameElement: class {},
  Node: TestNode,
  getSelection: () => null,
});
const testDocument = Object.assign(new TestEventTarget(), {
  nodeType: 9,
  nodeName: '#document',
  defaultView: testWindow,
  activeElement: null,
});
testDocument.createElement = name => new TestNode(1, name.toUpperCase(), testDocument);
testDocument.createTextNode = text => Object.assign(new TestNode(3, '#text', testDocument), { nodeValue: text });
testDocument.documentElement = new TestNode(1, 'HTML', testDocument);
testDocument.body = new TestNode(1, 'BODY', testDocument);
testWindow.document = testDocument;
global.window = testWindow;
global.document = testDocument;
global.navigator = { userAgent: 'node' };
global.Node = TestNode;
global.HTMLElement = TestNode;
global.IS_REACT_ACT_ENVIRONMENT = true;

const flushFrames = () => {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(0);
};

(async () => {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { useRecentFilesAutoLoad } = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'useRecentFilesAutoLoad.ts')).href);
  const containers = {
    a: Object.assign(new TestEventTarget(), { scrollHeight: 0, scrollTop: 0, clientHeight: 0 }),
    b: Object.assign(new TestEventTarget(), { scrollHeight: 0, scrollTop: 0, clientHeight: 0 }),
  };
  const calls = { a: 0, b: 0 };
  let resolvePageA;
  const listRecentProjectFiles = page => {
    calls[page] += 1;
    if (page === 'a') return new Promise(resolve => { resolvePageA = resolve; });
    return Promise.resolve();
  };
  const Page = ({ id, active }) => {
    const ref = React.useRef(containers[id]);
    const loadMore = React.useCallback(() => listRecentProjectFiles(id), [id]);
    useRecentFilesAutoLoad(active, true, ref, loadMore, 0, 900);
    return null;
  };
  const Harness = ({ activePage }) => React.createElement(React.Fragment, null,
    React.createElement(Page, { id: 'a', active: activePage === 'a' }),
    React.createElement(Page, { id: 'b', active: activePage === 'b' }),
  );

  const root = createRoot(new TestNode(1, 'DIV', testDocument));
  await React.act(async () => root.render(React.createElement(Harness, { activePage: 'a' })));
  flushFrames();
  assert.strictEqual(calls.a, 1, 'page A must begin recent-file pagination while active');

  await React.act(async () => root.render(React.createElement(Harness, { activePage: 'b' })));
  containers.a.dispatch('scroll');
  resolvePageA();
  await React.act(async () => { await Promise.resolve(); });
  flushFrames();
  assert.strictEqual(calls.a, 1, 'page A must not issue another recent-file request after becoming hidden');
  assert.strictEqual(calls.b, 1, 'the newly active page may start its own pagination');

  await React.act(async () => root.unmount());
  console.log('recent-files active pagination mount tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
