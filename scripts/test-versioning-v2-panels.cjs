const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

class TestEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { const values = this.listeners.get(type) || new Set(); values.add(listener); this.listeners.set(type, values); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
}
class TestNode extends TestEventTarget {
  constructor(nodeType, nodeName, ownerDocument) { super(); this.nodeType = nodeType; this.nodeName = nodeName; this.tagName = nodeType === 1 ? nodeName : undefined; this.ownerDocument = ownerDocument; this.parentNode = null; this.childNodes = []; this.style = {}; this.attributes = new Map(); this.nodeValue = ''; this._textContent = ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  insertBefore(child, before) { child.parentNode = this; const index = this.childNodes.indexOf(before); this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child); return child; }
  removeChild(child) { const index = this.childNodes.indexOf(child); if (index >= 0) this.childNodes.splice(index, 1); child.parentNode = null; return child; }
  get firstChild() { return this.childNodes[0] || null; }
  get options() { return this.nodeName === 'SELECT' ? this.childNodes.filter(child => child.nodeName === 'OPTION') : undefined; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.length ? this.childNodes.map(child => child.textContent).join('') : this._textContent; }
  set textContent(value) { this._textContent = String(value); this.childNodes = []; if (value && this.nodeType === 1) this.appendChild(Object.assign(new TestNode(3, '#text', this.ownerDocument), { nodeValue: String(value) })); }
}
const testWindow = Object.assign(new TestEventTarget(), { HTMLElement: TestNode, HTMLIFrameElement: class {}, Node: TestNode, getSelection: () => null });
const testDocument = Object.assign(new TestEventTarget(), { nodeType: 9, nodeName: '#document', defaultView: testWindow, activeElement: null });
testDocument.createElement = name => new TestNode(1, name.toUpperCase(), testDocument);
testDocument.createElementNS = (_namespace, name) => new TestNode(1, name, testDocument);
testDocument.createTextNode = text => Object.assign(new TestNode(3, '#text', testDocument), { nodeValue: text });
testDocument.documentElement = new TestNode(1, 'HTML', testDocument);
testDocument.body = new TestNode(1, 'BODY', testDocument);
testWindow.document = testDocument;
global.window = testWindow; global.document = testDocument; global.navigator = { userAgent: 'node' }; global.Node = TestNode; global.HTMLElement = TestNode; global.IS_REACT_ACT_ENVIRONMENT = true;

const compile = relativePath => ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const loadCommonJs = (source, localRequire = require) => { const module = { exports: {} }; new Function('module', 'exports', 'require', source)(module, module.exports, localRequire); return module.exports; };
const model = loadCommonJs(compile('src/features/versioning/versioning-v2-model.ts'));
const panel = loadCommonJs(compile('src/features/versioning/VersionProgressPanel.tsx'), request => request === './versioning-v2-model' ? model : require(request));
const React = require('react');
const { createRoot } = require('react-dom/client');
const textContent = node => node.textContent;
const folders = [{ id: 'raw', projectId: 'p', mediaKind: 'image', versionKey: 'legacy', displayName: 'RAW', folderPath: 'C:/p/RAW', folderMissing: false, nodeRole: 'original', relationKind: 'main', trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled', trackingSnapshot: {}, tombstone: {}, createdAt: 1, updatedAt: 1 }];
const draft = mode => ({ mode, sourceRelativePath: '客户/RAW', displayName: mode === 'create' ? '新进度' : 'RAW', mediaKind: 'image', relationKind: 'main', parentProgressId: 'raw', trackingEnabled: true, renameFromParent: true, copyMissingFromParent: true });

(async () => {
  const container = new TestNode(1, 'DIV', testDocument);
  const root = createRoot(container);
  for (const mode of ['create', 'import', 'modify']) {
    await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: draft(mode), folders, onChange() {}, onSubmit() {}, onClose() {}, onChooseFolder() {} })));
    const content = textContent(container);
    assert(content.includes(model.VERSION_PANEL_DEFINITIONS[mode].title), `${mode} panel must mount with its V2 title`);
    assert(content.includes('主分支') && content.includes('附属分支') && content.includes('沿用上一版本文件名') && content.includes('补齐缺失媒体'));
    if (mode !== 'create') assert(content.includes('需要移动到项目根目录'));
  }
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('modify'), relationKind: 'auxiliary', trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false }, folders, onChange() {}, onSubmit() {}, onClose() {} })));
  assert(textContent(container).includes('附属分支禁止图片跟踪'));
  await React.act(async () => root.unmount());
  console.log('versioning V2 panels real mount tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
