const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

class TestEventTarget {
  addEventListener() {}
  removeEventListener() {}
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

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, before) {
    child.parentNode = this;
    const index = this.childNodes.indexOf(before);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
}

const storageWrites = [];
const storage = new Map();
const localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => {
    storage.set(key, String(value));
    storageWrites.push([key, String(value)]);
  },
};

const windowTarget = new TestEventTarget();
const documentTarget = new TestEventTarget();
const testWindow = Object.assign(windowTarget, {
  localStorage,
  setTimeout,
  clearTimeout,
  HTMLElement: TestNode,
  HTMLIFrameElement: class {},
  Node: TestNode,
  getSelection: () => null,
});
const testDocument = Object.assign(documentTarget, {
  nodeType: 9,
  nodeName: '#document',
  defaultView: testWindow,
  activeElement: null,
  createElement: name => new TestNode(1, name.toUpperCase(), testDocument),
  createTextNode: text => Object.assign(new TestNode(3, '#text', testDocument), { nodeValue: text }),
});
testDocument.documentElement = new TestNode(1, 'HTML', testDocument);
testDocument.body = new TestNode(1, 'BODY', testDocument);
testWindow.document = testDocument;

global.window = testWindow;
global.document = testDocument;
global.navigator = { userAgent: 'node' };
global.Node = TestNode;
global.HTMLElement = TestNode;
global.IS_REACT_ACT_ENVIRONMENT = true;

(async () => {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { useTitlebarTabOrder, projectTabId } = await import(pathToFileURL(path.resolve(
    __dirname,
    '..',
    'src',
    'features',
    'app',
    'useTitlebarTabOrder.ts',
  )).href);

  const storageKey = 'photoflow:titlebar-tab-order';
  const legacyId = 'project:C:\\workspace\\project-one';
  const migratedId = projectTabId('project-page-one');
  storage.set(storageKey, JSON.stringify([legacyId]));

  let renderCount = 0;
  let migratedOrder = -1;
  const Harness = ({ projectPath }) => {
    renderCount += 1;
    const getTabProps = useTitlebarTabOrder({
      inspirationPages: [],
      projectPages: [{ id: 'project-page-one', projectPath }],
      toolTabs: [],
      settingsOpen: false,
    });
    migratedOrder = getTabProps(migratedId).style.order;
    return null;
  };

  const container = new TestNode(1, 'DIV', testDocument);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness, { projectPath: 'C:\\workspace\\project-one' }));
  });

  assert.strictEqual(migratedOrder, 0, 'the mounted hook must migrate the legacy project id into the visible project page order');
  const migratedWrites = () => storageWrites.filter(([, value]) => value === JSON.stringify([migratedId])).length;
  assert.strictEqual(migratedWrites(), 1, 'the first legacy migration must persist its migrated id exactly once');
  const rendersAfterMigration = renderCount;

  await React.act(async () => {
    root.render(React.createElement(Harness, { projectPath: `${'C:\\workspace\\'}project-one` }));
  });

  assert.strictEqual(renderCount, rendersAfterMigration + 1, 'a semantic-equivalent rerender must not schedule another state render');
  assert.strictEqual(migratedWrites(), 1, 'a semantic-equivalent rerender must not persist the same migrated state again');

  await React.act(async () => root.unmount());
  console.log('titlebar tab order hook tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
