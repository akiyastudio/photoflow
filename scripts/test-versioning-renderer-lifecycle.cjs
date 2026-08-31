const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

class TestEventTarget {
  constructor() { this.listeners = new Map(); this.captureListeners = new Map(); }
  addEventListener(type, listener, options) {
    const registry = options === true || options?.capture ? this.captureListeners : this.listeners;
    const values = registry.get(type) || new Set();
    values.add(listener);
    registry.set(type, values);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
    this.captureListeners.get(type)?.delete(listener);
  }
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
    this.nodeValue = '';
    this._textContent = '';
    this.value = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
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
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.length ? this.childNodes.map(child => child.textContent).join('') : this._textContent; }
  set textContent(value) {
    this._textContent = String(value);
    this.childNodes = [];
    if (value && this.nodeType === 1) this.appendChild(Object.assign(new TestNode(3, '#text', this.ownerDocument), { nodeValue: String(value) }));
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0 }; }
  contains(target) { for (let cursor = target; cursor; cursor = cursor.parentNode) if (cursor === this) return true; return false; }
  closest() { return null; }
  setPointerCapture() {}
}

const testWindow = Object.assign(new TestEventTarget(), {
  HTMLElement: TestNode,
  HTMLIFrameElement: class {},
  Node: TestNode,
  innerWidth: 1200,
  innerHeight: 900,
  localStorage: { values: new Map(), getItem(key) { return this.values.get(key) || null; }, setItem(key, value) { this.values.set(key, String(value)); } },
});
const testDocument = Object.assign(new TestEventTarget(), { nodeType: 9, nodeName: '#document', defaultView: testWindow, activeElement: null });
testDocument.createElement = name => new TestNode(1, name.toUpperCase(), testDocument);
testDocument.createElementNS = (_namespace, name) => new TestNode(1, name, testDocument);
testDocument.createTextNode = text => Object.assign(new TestNode(3, '#text', testDocument), { nodeValue: text });
testDocument.documentElement = new TestNode(1, 'HTML', testDocument);
testDocument.body = new TestNode(1, 'BODY', testDocument);
testWindow.document = testDocument;
global.window = testWindow;
global.document = testDocument;
global.navigator = { userAgent: 'node', clipboard: { async writeText() {} } };
global.Node = TestNode;
global.HTMLElement = TestNode;
global.ResizeObserver = class { observe() {} disconnect() {} };
global.IS_REACT_ACT_ENVIRONMENT = true;

const compile = relativePath => ts.transpileModule(
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } },
).outputText;
const loadCommonJs = (source, localRequire = require) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'require', source)(module, module.exports, localRequire);
  return module.exports;
};
const React = require('react');
const { createRoot } = require('react-dom/client');
const allNodes = node => [node, ...node.childNodes.flatMap(allNodes)];
const dispatch = (target, type, extra = {}) => {
  const event = { type, target, bubbles: true, cancelBubble: false, defaultPrevented: false, button: 0, stopPropagation() { this.cancelBubble = true; }, preventDefault() { this.defaultPrevented = true; }, ...extra };
  const eventPath = [];
  for (let cursor = target; cursor; cursor = cursor.parentNode) eventPath.push(cursor);
  for (const current of [...eventPath].reverse()) {
    for (const listener of current.captureListeners.get(type) || []) listener(event);
    if (event.cancelBubble) return event;
  }
  for (const current of eventPath) {
    for (const listener of current.listeners.get(type) || []) listener(event);
    if (event.cancelBubble) break;
  }
  return event;
};
const flush = async () => React.act(async () => { await Promise.resolve(); await Promise.resolve(); });
const iconModule = new Proxy({}, { get: (_target, name) => name === '__esModule' ? true : () => React.createElement('i') });
const comparisonModule = { ImageComparisonView: ({ left, right }) => React.createElement('div', null, left.content, right.content) };
const versioningModel = loadCommonJs(compile('src/features/versioning/versioning-v2-model.ts'));

(async () => {
  const thumbnailSubscribers = new Set();
  const thumbnailResolvers = [];
  const thumbnailRequests = [];
  const thumbnailCancels = [];
  testWindow.electronAPI = {
    onThumbnailStateChanged(listener) { thumbnailSubscribers.add(listener); return () => thumbnailSubscribers.delete(listener); },
    getMediaThumbnail(filePath, _kind, _config, size) {
      thumbnailRequests.push({ filePath, size });
      return new Promise(resolve => thumbnailResolvers.push(() => resolve({ success: true, previewUrl: `preview:${filePath}` })));
    },
    async cancelMediaThumbnail(filePath, size) { thumbnailCancels.push({ filePath, size }); },
  };
  const previewModule = loadCommonJs(compile('src/features/versioning/ProgressPairPreview.tsx'), request => {
    if (request === 'lucide-react') return iconModule;
    if (request === '../../components/ImageComparisonView') return comparisonModule;
    if (request === './versioning-v2-model') return versioningModel;
    return require(request);
  });
  const previewProps = {
    referencePath: 'C:/project/shared.jpg', sourcePath: 'C:/project/current.jpg', mode: 'side-by-side', swapped: false,
    cacheConfig: { directory: '', maxSizeGB: 1 }, onModeChange() {}, onSwappedChange() {},
  };
  const previewContainerA = new TestNode(1, 'DIV', testDocument);
  const previewContainerB = new TestNode(1, 'DIV', testDocument);
  const previewRootA = createRoot(previewContainerA);
  const previewRootB = createRoot(previewContainerB);
  await React.act(async () => {
    previewRootA.render(React.createElement(previewModule.ProgressPairPreview, previewProps));
    previewRootB.render(React.createElement(previewModule.ProgressPairPreview, previewProps));
  });
  assert.strictEqual(thumbnailRequests.length, 4, 'both mounted consumers request their two preview sides');
  await React.act(async () => previewRootA.unmount());
  assert.deepStrictEqual(thumbnailCancels, [], 'unmounting one consumer must not globally cancel shared file+size thumbnail work');
  await React.act(async () => { thumbnailResolvers.splice(0).forEach(resolve => resolve()); await Promise.resolve(); });
  assert(allNodes(previewContainerB).some(node => node.nodeName === 'IMG' && node.attributes.get('src') === 'preview:C:/project/shared.jpg'), 'the surviving consumer receives the shared request result');
  await React.act(async () => previewRootB.unmount());
  assert.deepStrictEqual(thumbnailCancels, [], 'sequence gating and unsubscribe are sufficient cleanup for every consumer');

  const trackingModel = loadCommonJs(compile('src/features/versioning/tracking-confirmation-model.ts'));
  const trackingCalls = { decide: [], commit: [], release: [] };
  const trackingCallbacks = { close: 0, committed: 0, released: 0, notices: [] };
  const trackingEvents = [];
  let failNextSessionCCommit = true;
  let resolveSessionB;
  const trackingSession = id => ({ id, progressId: `progress-${id}`, parentProgressId: `parent-${id}`, mode: 'refresh', status: 'pending_confirm', renameFromParent: false, copyMissingFromParent: false, error: '', total: 1, unresolvedCount: 1 });
  const trackingItem = { id: 'item-a', kind: 'new', sourceName: 'current.jpg', referenceName: 'reference.jpg', targetName: 'current.jpg', status: 'pending_confirmation' };
  testWindow.electronAPI = {
    async getProgressTrackingSession(_workspacePath, request) {
      if (request.sessionId === 'A') return { success: true, session: trackingSession('A'), items: [trackingItem], nextCursor: null };
      if (request.sessionId === 'C') return { success: true, session: { ...trackingSession('C'), unresolvedCount: 0 }, items: [{ ...trackingItem, id: 'item-c', status: 'accepted' }], nextCursor: null };
      return new Promise(resolve => { resolveSessionB = resolve; });
    },
    async decideProgressTrackingItem(_workspacePath, request) { trackingCalls.decide.push(request); return { success: true }; },
    async commitProgressTracking(_workspacePath, request) {
      trackingCalls.commit.push(request);
      trackingEvents.push(`commit:${request.sessionId}`);
      if (request.sessionId === 'C' && failNextSessionCCommit) { failNextSessionCCommit = false; return { success: false, error: 'simulated commit failure' }; }
      return { success: true };
    },
    async releaseProgressTrackingSession(_workspacePath, request) { trackingCalls.release.push(request); trackingEvents.push(`release:${request.sessionId}`); return { success: true, released: true }; },
  };
  const trackingPanelModule = loadCommonJs(compile('src/features/versioning/TrackingConfirmationPanel.tsx'), request => {
    if (request === 'lucide-react') return iconModule;
    if (request === './ProgressPairPreview') return { ProgressPairPreview: () => React.createElement('div', { 'data-preview': 'true' }) };
    if (request === '../../components/LayerProvider') return { useHostSurfaceSuspension() {} };
    if (request === './tracking-confirmation-model') return trackingModel;
    return require(request);
  });
  const trackingContainer = new TestNode(1, 'DIV', testDocument);
  const trackingRoot = createRoot(trackingContainer);
  const trackingProps = sessionId => ({
    active: true, sessionId, workspacePath: 'C:/workspace',
    progressFolders: [
      { id: `parent-${sessionId}`, displayName: `Parent ${sessionId}`, folderPath: `C:/parent-${sessionId}` },
      { id: `progress-${sessionId}`, displayName: `Progress ${sessionId}`, folderPath: `C:/progress-${sessionId}` },
    ],
    cacheConfig: { directory: '', maxSizeGB: 1 },
    onClose() { trackingCallbacks.close += 1; trackingEvents.push('close'); },
    onCommitted() { trackingCallbacks.committed += 1; trackingEvents.push('committed'); },
    onReleased() { trackingCallbacks.released += 1; trackingEvents.push('released'); },
    onNotice(message) { trackingCallbacks.notices.push(message); trackingEvents.push('notice'); },
  });
  await React.act(async () => { trackingRoot.render(React.createElement(trackingPanelModule.TrackingConfirmationPanel, trackingProps('A'))); await Promise.resolve(); await Promise.resolve(); });
  const oldDecisionButton = allNodes(trackingContainer).find(node => node.nodeName === 'BUTTON' && node.textContent === '确认同一张');
  assert(oldDecisionButton, 'session A renders its pending decision action');
  await React.act(async () => { dispatch(oldDecisionButton, 'click'); await Promise.resolve(); });
  assert.deepStrictEqual(trackingCalls.decide, [{ sessionId: 'A', itemId: 'item-a', status: 'accepted' }], 'session A decision uses its own loaded identity');
  const oldCommitButton = allNodes(trackingContainer).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('提交结果'));
  assert(oldCommitButton, 'resolving session A exposes its commit action before the prop switch');
  await React.act(async () => { trackingRoot.render(React.createElement(trackingPanelModule.TrackingConfirmationPanel, trackingProps('B'))); await Promise.resolve(); });
  const switchedReleaseButton = allNodes(trackingContainer).find(node => node.nodeName === 'BUTTON' && node.textContent === '放弃本次确认');
  assert(switchedReleaseButton.attributes.has('disabled'), 'session actions are disabled while session B has no matching loaded view');
  await React.act(async () => { dispatch(oldDecisionButton, 'click'); dispatch(oldCommitButton, 'click'); dispatch(switchedReleaseButton, 'click'); await Promise.resolve(); });
  assert.deepStrictEqual(trackingCalls, {
    decide: [{ sessionId: 'A', itemId: 'item-a', status: 'accepted' }], commit: [], release: [],
  }, 'old session A decision/commit controls and transitional release cannot be combined with the new session B prop for IPC');
  resolveSessionB({ success: true, session: { ...trackingSession('B'), unresolvedCount: 0 }, items: [{ ...trackingItem, id: 'item-b', status: 'accepted' }], nextCursor: null });
  await React.act(async () => { await Promise.resolve(); });

  const sessionBCommitButton = allNodes(trackingContainer).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('提交结果'));
  await React.act(async () => { dispatch(sessionBCommitButton, 'click'); await Promise.resolve(); await Promise.resolve(); });
  assert.deepStrictEqual(trackingCalls.commit, [{ sessionId: 'B' }], 'a normal commit targets the loaded session B');
  assert.deepStrictEqual(trackingCalls.release, [{ sessionId: 'B' }], 'a successful commit releases the same session before callbacks');
  assert.deepStrictEqual(trackingCallbacks, { close: 1, committed: 1, released: 0, notices: [] }, 'commit and release success close and report committed exactly once');
  assert.deepStrictEqual(trackingEvents, ['commit:B', 'release:B', 'close', 'committed'], 'successful commit waits for release before closing and reporting completion');

  await React.act(async () => { trackingRoot.render(React.createElement(trackingPanelModule.TrackingConfirmationPanel, trackingProps('C'))); await Promise.resolve(); await Promise.resolve(); });
  const firstSessionCCommitButton = allNodes(trackingContainer).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('提交结果'));
  await React.act(async () => { dispatch(firstSessionCCommitButton, 'click'); await Promise.resolve(); await Promise.resolve(); });
  assert.deepStrictEqual(trackingCalls.commit, [{ sessionId: 'B' }, { sessionId: 'C' }], 'session C performs its first commit attempt');
  assert.deepStrictEqual(trackingCalls.release, [{ sessionId: 'B' }], 'a failed commit must not release its session');
  assert.strictEqual(trackingCallbacks.close, 1, 'a failed commit must not close the panel');
  assert.strictEqual(trackingCallbacks.committed, 1, 'a failed commit must not report completion');
  assert(trackingCallbacks.notices.some(message => message.includes('simulated commit failure')), 'commit failure remains visible to the user');
  const retrySessionCCommitButton = allNodes(trackingContainer).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('提交结果'));
  assert(retrySessionCCommitButton && !retrySessionCCommitButton.attributes.has('disabled'), 'commit failure clears the in-flight gate so the user can retry');
  await React.act(async () => { dispatch(retrySessionCCommitButton, 'click'); await Promise.resolve(); await Promise.resolve(); });
  assert.deepStrictEqual(trackingCalls.commit, [{ sessionId: 'B' }, { sessionId: 'C' }, { sessionId: 'C' }], 'the recovered retry targets session C again');
  assert.deepStrictEqual(trackingCalls.release, [{ sessionId: 'B' }, { sessionId: 'C' }], 'the successful retry releases session C');
  assert.strictEqual(trackingCallbacks.close, 2, 'the successful retry closes exactly once');
  assert.strictEqual(trackingCallbacks.committed, 2, 'the successful retry reports committed exactly once');
  await React.act(async () => trackingRoot.unmount());

  const updateResolvers = [];
  const updateRequests = [];
  const deleteResolvers = [];
  const deleteRequests = [];
  const recycleAlerts = [];
  const version = (id, name) => ({ id, photoId: `photo-${id}`, versionNumber: 1, versionName: name, versionType: 'custom', filePath: `C:/project/${id}.jpg`, fileSize: 100, note: '', status: 'ready', isCurrent: false, isFinal: false, fileMissing: false, contentChanged: false, createdAt: 1, updatedAt: 1 });
  const bundles = {
    'a.jpg': { success: true, photo: { id: 'photo-a', projectId: 'project', mediaType: 'image', originalName: 'a.jpg', displayName: 'A photo', currentVersionId: 'a', originalFilePath: 'C:/project/a.jpg', createdAt: 1, updatedAt: 1 }, versions: [version('a', 'A original')] },
    'b.jpg': { success: true, photo: { id: 'photo-b', projectId: 'project', mediaType: 'image', originalName: 'b.jpg', displayName: 'B photo', currentVersionId: 'b', originalFilePath: 'C:/project/b.jpg', createdAt: 1, updatedAt: 1 }, versions: [version('b', 'B current')] },
    'c.jpg': { success: true, photo: { id: 'photo-c', projectId: 'project', mediaType: 'image', originalName: 'c.jpg', displayName: 'C photo', currentVersionId: 'c', originalFilePath: 'C:/project/c.jpg', createdAt: 1, updatedAt: 1 }, versions: [version('c', 'C current')] },
  };
  testWindow.electronAPI = {
    async getMediaVersions(_workspace, _status, _project, relativePath) { return bundles[relativePath]; },
    async getMediaMetadata() { return { success: true, fields: [] }; },
    async getMediaThumbnail(filePath) { return { success: true, previewUrl: `preview:${filePath}` }; },
    async getMediaOriginal(filePath) { return { success: true, mediaUrl: `original:${filePath}` }; },
    updateMediaVersion(_workspace, request) { updateRequests.push(request); return new Promise(resolve => updateResolvers.push(resolve)); },
    async getMediaVersionDeleteScope() { return { success: true, selectedChildCount: 0, childCount: 0, allMissing: false, versionCount: 1, versionNumber: 1 }; },
    deleteMediaVersion(_workspace, request) { deleteRequests.push(request); return new Promise(resolve => deleteResolvers.push(resolve)); },
    async saveMediaComparisonPreference() { return { success: true }; },
    async openMediaVersion() { return { success: true }; },
    reportRendererError() {},
  };
  const versionManagerModule = loadCommonJs(compile('src/components/VersionManager.tsx'), request => {
    if (request === 'lucide-react') return iconModule;
    if (request === './AppDialogProvider') return { useAppDialog: () => ({ async confirm() { return true; }, async choice() { return undefined; }, async alert(dialog) { recycleAlerts.push(dialog); } }) };
    if (request === './LayerProvider') return { useEscapeLayer() {} };
    if (request === '../utils/recycleBinFailure') return { RECYCLE_BIN_FAILURE_DIALOG: {} };
    if (request === './AdvancedVideoPlayer') return { VideoPlayer: () => React.createElement('div') };
    if (request === '../features/metadata/metadata-labels') return { metadataFieldLabel: value => value, metadataGroupLabel: value => value };
    if (request === '../features/versioning/public') return {
      MAIN_BRANCH_PHOTO_PAGE_SIZE: 48,
      mainBranchPhotoSummaries: () => [],
      mainBranchVersionsForPhoto: () => [],
      paginateMainBranchPhotos: photos => ({ items: photos, currentPage: 0, pageCount: 1, total: photos.length }),
      versioningMediaKind: versioningModel.versioningMediaKind,
    };
    if (request === './ImageComparisonView') return comparisonModule;
    return require(request);
  });
  const notices = [];
  let invalidations = 0;
  let closes = 0;
  const managerContainer = new TestNode(1, 'DIV', testDocument);
  const managerRoot = createRoot(managerContainer);
  const managerProps = entry => ({
    entry, workspacePath: 'C:/workspace', project: { id: 'project', name: 'Project', status: 'active' },
    cacheConfig: { directory: '', maxSizeGB: 1 }, videoPlaybackSettings: {}, onClose() { closes += 1; },
    onNotice(message) { notices.push(message); }, onVersionStateChanged() { invalidations += 1; },
  });
  const entryA = { kind: 'image', name: 'a.jpg', relativePath: 'a.jpg', path: 'C:/project/a.jpg', extension: '.jpg', size: 100, createdAt: 1, updatedAt: 1 };
  const entryB = { ...entryA, name: 'b.jpg', relativePath: 'b.jpg', path: 'C:/project/b.jpg', updatedAt: 2 };
  const entryC = { ...entryA, name: 'c.jpg', relativePath: 'c.jpg', path: 'C:/project/c.jpg', updatedAt: 3 };
  await React.act(async () => managerRoot.render(React.createElement(versionManagerModule.VersionManager, managerProps(entryA))));
  await flush();
  const actionsButton = allNodes(managerContainer).find(node => node.attributes.get('aria-label') === '版本操作');
  await React.act(async () => dispatch(actionsButton, 'click'));
  const makeCurrentButton = allNodes(managerContainer).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('设为当前工作版本'));
  await React.act(async () => dispatch(makeCurrentButton, 'click'));
  assert.deepStrictEqual(updateRequests, [{ versionId: 'a', makeCurrent: true }], 'a real mounted manager starts the requested version mutation');
  const closeButtons = allNodes(managerContainer).filter(node => node.attributes.get('aria-label') === '关闭版本管理' || node.attributes.get('aria-label') === '关闭版本对比');
  assert(closeButtons.length >= 2 && closeButtons.every(node => node.attributes.has('disabled')), 'generation-changing close navigation is disabled while a write is in flight');

  await React.act(async () => managerRoot.render(React.createElement(versionManagerModule.VersionManager, managerProps(entryB))));
  await flush();
  assert(managerContainer.textContent.includes('B current'), 'switching page identity renders the new photo before the old write completes');
  const bActionsButton = allNodes(managerContainer).find(node => node.attributes.get('aria-label') === '版本操作');
  await React.act(async () => dispatch(bActionsButton, 'click'));
  const bMakeCurrentButton = allNodes(managerContainer).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('设为当前工作版本'));
  await React.act(async () => dispatch(bMakeCurrentButton, 'click'));
  assert.deepStrictEqual(updateRequests.at(-1), { versionId: 'b', makeCurrent: true }, 'the new page may begin its own mutation after invalidating the old page lease');

  await React.act(async () => { updateResolvers[0]({ ...bundles['a.jpg'], versions: [{ ...bundles['a.jpg'].versions[0], isCurrent: true, versionName: 'A committed' }] }); await Promise.resolve(); });
  assert.strictEqual(invalidations, 1, 'a successful write publishes outer invalidation even after page generation changes');
  assert.deepStrictEqual(notices, ['已切换当前版本'], 'a successful stale-page write still publishes its completion notice exactly once');
  assert(managerContainer.textContent.includes('B current') && !managerContainer.textContent.includes('A committed'), 'the stale successful result cannot overwrite the newly selected page');
  const busyCloseButtons = allNodes(managerContainer).filter(node => node.attributes.get('aria-label') === '关闭版本管理' || node.attributes.get('aria-label') === '关闭版本对比');
  assert(busyCloseButtons.every(node => node.attributes.has('disabled')), 'settling old mutation A must not clear new mutation B busy state');

  const busyActionsButton = allNodes(managerContainer).find(node => node.attributes.get('aria-label') === '版本操作');
  await React.act(async () => dispatch(busyActionsButton, 'click'));
  const blockedThirdMutationButton = allNodes(managerContainer).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('设为当前工作版本'));
  assert(blockedThirdMutationButton.attributes.has('disabled'), 'the current mutation action remains disabled after the stale owner settles');
  await React.act(async () => dispatch(blockedThirdMutationButton, 'click'));
  assert.strictEqual(updateRequests.length, 2, 'a third write cannot bypass the ref guard while mutation B owns the busy lease');

  await React.act(async () => { updateResolvers[1]({ ...bundles['b.jpg'], versions: [{ ...bundles['b.jpg'].versions[0], versionName: 'B committed' }] }); await Promise.resolve(); });
  assert.strictEqual(invalidations, 2, 'the current-page mutation publishes its own invalidation');
  const releasedCloseButtons = allNodes(managerContainer).filter(node => node.attributes.get('aria-label') === '关闭版本管理' || node.attributes.get('aria-label') === '关闭版本对比');
  assert(releasedCloseButtons.every(node => !node.attributes.has('disabled')), 'the current busy lease releases when mutation B settles');
  const allowedThirdMutationButton = allNodes(managerContainer).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('设为当前工作版本'));
  await React.act(async () => dispatch(allowedThirdMutationButton, 'click'));
  assert.strictEqual(updateRequests.length, 3, 'a third write may start only after mutation B releases its lease');
  await React.act(async () => { updateResolvers[2](bundles['b.jpg']); await Promise.resolve(); });
  assert.strictEqual(invalidations, 3);
  assert.strictEqual(closes, 0, 'disabled close controls do not close the manager during the tested write');

  const deleteActionsButton = allNodes(managerContainer).find(node => node.attributes.get('aria-label') === '版本操作');
  await React.act(async () => dispatch(deleteActionsButton, 'click'));
  const deleteButton = allNodes(managerContainer).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('删除版本记录'));
  await React.act(async () => { dispatch(deleteButton, 'click'); await Promise.resolve(); await Promise.resolve(); });
  assert.strictEqual(deleteRequests.length, 1, 'the mounted old page begins its delete IPC');
  await React.act(async () => managerRoot.render(React.createElement(versionManagerModule.VersionManager, managerProps(entryC))));
  await flush();
  assert(managerContainer.textContent.includes('C current'), 'the new identity is visible while the old delete remains in flight');
  await React.act(async () => { deleteResolvers[0]({ ...bundles['b.jpg'], warning: 'simulated recycle failure' }); await Promise.resolve(); await Promise.resolve(); });
  assert.strictEqual(invalidations, 4, 'a stale-identity delete committed with a recycle warning still invalidates outer version state exactly once');
  assert.strictEqual(recycleAlerts.length, 1, 'a stale-identity recycle warning publishes the established failure dialog exactly once');
  assert(!notices.some(message => message.includes('文件已移入回收站')), 'a recycle warning must never claim that the file reached the recycle bin');
  assert(managerContainer.textContent.includes('C current') && !managerContainer.textContent.includes('B current'), 'the stale warning result cannot overwrite the new page');
  await React.act(async () => managerRoot.unmount());

  const managerSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/VersionManager.tsx'), 'utf8');
  for (const operation of ['updateVersion', 'deleteVersion', 'relocateVersion']) {
    const start = managerSource.indexOf(`const ${operation} = async`);
    const end = managerSource.indexOf('\n  const ', start + 10);
    const body = managerSource.slice(start, end < 0 ? undefined : end);
    const publishIndex = body.indexOf('publishCommittedMutation()');
    assert(publishIndex >= 0, `${operation} must publish committed writes`);
    assert(body.indexOf('pageGenerationIsCurrent(pageGeneration)', publishIndex) > publishIndex, `${operation} must gate local reconciliation after publishing success`);
  }
  const deleteMutationSource = managerSource.slice(managerSource.indexOf('const deleteVersion = async'), managerSource.indexOf('const relocateVersion = async'));
  const warningPublishIndex = deleteMutationSource.indexOf('if (result.warning) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG)');
  assert(warningPublishIndex > deleteMutationSource.lastIndexOf('publishCommittedMutation()', warningPublishIndex), 'recycle failure must be published after outer invalidation');
  assert(deleteMutationSource.indexOf('pageGenerationIsCurrent(pageGeneration)', warningPublishIndex) > warningPublishIndex, 'recycle failure must be published before stale-page reconciliation gating');
  assert(!fs.readFileSync(path.resolve(__dirname, '..', 'src/features/versioning/ProgressPairPreview.tsx'), 'utf8').includes('cancelMediaThumbnail'), 'the preview must not issue consumer-unsafe global cancellation');
  console.log('versioning renderer lifecycle real mount tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
