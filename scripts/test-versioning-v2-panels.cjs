const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

class TestEventTarget {
  constructor() { this.listeners = new Map(); this.captureListeners = new Map(); }
  addEventListener(type, listener, options) { const registry = options === true || options?.capture ? this.captureListeners : this.listeners; const values = registry.get(type) || new Set(); values.add(listener); registry.set(type, values); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); this.captureListeners.get(type)?.delete(listener); }
}
class TestNode extends TestEventTarget {
  constructor(nodeType, nodeName, ownerDocument) { super(); this.nodeType = nodeType; this.nodeName = nodeName; this.tagName = nodeType === 1 ? nodeName : undefined; this.ownerDocument = ownerDocument; this.parentNode = null; this.childNodes = []; this.style = {}; this.attributes = new Map(); this.nodeValue = ''; this._textContent = ''; this.capturedPointers = new Set(); this.scrollLeft = 0; this.scrollTop = 0; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  insertBefore(child, before) { child.parentNode = this; const index = this.childNodes.indexOf(before); this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child); return child; }
  removeChild(child) { const index = this.childNodes.indexOf(child); if (index >= 0) this.childNodes.splice(index, 1); child.parentNode = null; return child; }
  get firstChild() { return this.childNodes[0] || null; }
  get options() { return this.nodeName === 'SELECT' ? this.childNodes.filter(child => child.nodeName === 'OPTION') : undefined; }
  get dataset() { return Object.fromEntries([...this.attributes].filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()), value])); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0 }; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.length ? this.childNodes.map(child => child.textContent).join('') : this._textContent; }
  set textContent(value) { this._textContent = String(value); this.childNodes = []; if (value && this.nodeType === 1) this.appendChild(Object.assign(new TestNode(3, '#text', this.ownerDocument), { nodeValue: String(value) })); }
  setPointerCapture(pointerId) { this.capturedPointers.add(pointerId); }
  hasPointerCapture(pointerId) { return this.capturedPointers.has(pointerId); }
  releasePointerCapture(pointerId) { this.capturedPointers.delete(pointerId); }
  querySelectorAll(selector) {
    const matches = [];
    const visit = node => {
      if (selector === '[data-version-tree-node="true"]' && node.attributes?.get('data-version-tree-node') === 'true') matches.push(node);
      node.childNodes?.forEach(visit);
    };
    this.childNodes.forEach(visit);
    return matches;
  }
  closest(selector) {
    let cursor = this;
    while (cursor) {
      if (selector.includes('button') && cursor.nodeName === 'BUTTON') return cursor;
      if (selector.includes('input') && cursor.nodeName === 'INPUT') return cursor;
      if (selector.includes('[data-version-tree-port]') && cursor.attributes?.has('data-version-tree-port')) return cursor;
      if (selector.includes('[data-relation-parent-id]') && cursor.attributes?.has('data-relation-parent-id')) return cursor;
      if (selector.includes('[data-version-output-target-key]') && cursor.attributes?.has('data-version-output-target-key')) return cursor;
      if (selector.includes('[data-version-tree-node]') && cursor.attributes?.has('data-version-tree-node')) return cursor;
      if (selector.includes('[data-entry-path]') && cursor.attributes?.has('data-entry-path')) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }
}
const layoutRequests = { loads: 0, saves: [], failLoadBudget: 0, failNextSave: false, staleNextSave: false, staleMutation: null, revision: 0, positions: [], holdSaves: false, saveReleases: [] };
const testWindow = Object.assign(new TestEventTarget(), { HTMLElement: TestNode, HTMLIFrameElement: class {}, Node: TestNode, getSelection: () => null, electronAPI: {
  async getVersionTreeLayout() {
    layoutRequests.loads += 1;
    if (layoutRequests.failLoadBudget > 0) {
      layoutRequests.failLoadBudget -= 1;
      return { success: false, error: 'simulated layout load failure' };
    }
    return { success: true, revision: layoutRequests.revision, positions: layoutRequests.positions };
  },
  async saveVersionTreeLayout(_workspacePath, _projectName, request) {
    layoutRequests.saves.push(request);
    if (layoutRequests.holdSaves) await new Promise(resolve => layoutRequests.saveReleases.push(resolve));
    if (layoutRequests.staleNextSave) {
      layoutRequests.staleNextSave = false;
      layoutRequests.revision += 1;
      if (layoutRequests.staleMutation) {
        const mutation = layoutRequests.staleMutation;
        layoutRequests.staleMutation = null;
        layoutRequests.positions = [...layoutRequests.positions.filter(position => position.nodeKey !== mutation.nodeKey), mutation];
      }
      return { success: false, error: `stale_layout: 布局已更新（当前 revision=${layoutRequests.revision}）` };
    }
    if (layoutRequests.failNextSave) { layoutRequests.failNextSave = false; return { success: false, error: 'simulated layout failure' }; }
    layoutRequests.revision += 1;
    if (request.mode === 'replace') layoutRequests.positions = request.positions;
    else {
      const patches = new Map(request.positions.map(position => [position.nodeKey, position]));
      layoutRequests.positions = [...layoutRequests.positions.filter(position => !patches.has(position.nodeKey)), ...request.positions];
    }
    return { success: true, revision: layoutRequests.revision };
  },
} });
const testDocument = Object.assign(new TestEventTarget(), { nodeType: 9, nodeName: '#document', defaultView: testWindow, activeElement: null });
let elementAtPoint = null;
testDocument.elementFromPoint = () => elementAtPoint;
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
const sourceFixture = overrides => ({ id: 'node', projectId: 'project', mediaKind: 'image', versionKey: '1', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'root', folderMissing: false, trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled', ...overrides });
const ordinarySelection = sourceFixture({ id: 'selection', nodeRole: 'selection', relationKind: 'auxiliary', sourceMetadata: null });
const ordinaryProgress = sourceFixture({ id: 'progress', sourceMetadata: null });
const legacyWorkflow = sourceFixture({ id: 'legacy-workflow', nodeRole: 'workflow', relationKind: undefined, parentProgressId: undefined, artifactKind: 'component_workspace', sourceMetadata: null });
const metadataWorkflow = sourceFixture({ id: 'metadata-workflow', nodeRole: 'workflow', relationKind: undefined, parentProgressId: undefined, artifactKind: 'vendor.workflow', sourceMetadata: { category: 'workflow', displayName: '供应商流程', componentId: 'vendor', parentCapability: 'workflow-input' } });
assert.equal(model.workflowInputLabel(ordinarySelection), '图片选片');
assert.equal(model.versionSourceMetadata(ordinaryProgress).parentCapability, 'structural');
assert.equal(model.workflowInputLabel(legacyWorkflow), '组件工作流');
assert.equal(model.workflowInputLabel(metadataWorkflow), '供应商流程');
assert.deepEqual(model.selectableWorkflowInputs([ordinarySelection, ordinaryProgress, legacyWorkflow, metadataWorkflow], 'image').map(item => item.id), ['selection', 'legacy-workflow', 'metadata-workflow']);
const panelSwitch = loadCommonJs(compile('src/components/PanelSwitch.tsx'));
const sourcePathPickerModel = loadCommonJs(compile('src/components/source-path-picker-model.ts'));
const sourcePathPicker = loadCommonJs(compile('src/components/SourcePathPicker.tsx'), request => request === './source-path-picker-model' ? sourcePathPickerModel : require(request));
const importSourceControls = loadCommonJs(compile('src/components/ImportSourceControls.tsx'), request => request === './PanelSwitch' ? panelSwitch : request === './SourcePathPicker' ? sourcePathPicker : require(request));
const panel = loadCommonJs(compile('src/features/versioning/VersionProgressPanel.tsx'), request => request === './versioning-v2-model' ? model : request === '../../components/ImportSourceControls' ? importSourceControls : require(request));
const folderMarkModel = loadCommonJs(compile('src/features/versioning/folder-mark-model.ts'), request => request === './versioning-v2-model' ? model : request === './VersionProgressPanel' ? panel : require(request));
const folderMarkPanel = { ...folderMarkModel, ...loadCommonJs(compile('src/features/versioning/FolderMarkPanel.tsx'), request => request === './versioning-v2-model' ? model : request === './VersionProgressPanel' ? panel : request === './folder-mark-model' ? folderMarkModel : require(request)) };
const canvasModel = loadCommonJs(compile('src/features/versioning/version-tree-canvas-model.ts'));
const edgeModel = loadCommonJs(compile('src/features/versioning/version-tree-edge-model.ts'));
const layoutModel = loadCommonJs(compile('src/features/versioning/version-tree-layout-model.ts'), request => request === './version-tree-edge-model.ts' ? edgeModel : require(request));
const canvasHook = loadCommonJs(compile('src/features/versioning/use-version-tree-canvas.ts'), request => request === './version-tree-canvas-model' ? canvasModel : require(request));
const canvasHookSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/features/versioning/use-version-tree-canvas.ts'), 'utf8');
const projectWorkspaceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/features/workspace/ProjectWorkspace.tsx'), 'utf8');
assert(canvasHookSource.includes('sameCanvasPositions(positionsRef.current, next)'), 'version-tree layout reconciliation must skip identical maps to prevent effect update loops');
const initialLayoutLoadSource = canvasHookSource.slice(canvasHookSource.indexOf('const loadServerLayout'), canvasHookSource.indexOf('useEffect(() => {\n    disposedRef.current = false'));
assert(!initialLayoutLoadSource.includes('scrollTop = 0') && !initialLayoutLoadSource.includes('scrollLeft = 0'), 'an asynchronous saved-layout load must preserve a viewport the user already scrolled');
assert(projectWorkspaceSource.includes('setFolderMarkSetup(createFolderMarkDraft') && projectWorkspaceSource.includes('<FolderMarkPanel'), 'ordinary folders must open the unified purpose-marking panel');
assert(projectWorkspaceSource.includes("draft.purpose === 'progress'") && projectWorkspaceSource.includes('await submitProgressSetup(setup)')
  && projectWorkspaceSource.includes("draft.purpose === 'broll' ? 'mixed' : draft.mediaKind"), 'the unified panel must route progress through graph registration and original/broll through restricted purpose adoption');
assert(projectWorkspaceSource.includes("[browserRootLabel, normalizeProjectRelativePath(fileImportTarget)]"), 'file-import destination labels must show the active browser name instead of an internal inspiration workspace name');
const markSubmitSource = projectWorkspaceSource.slice(projectWorkspaceSource.indexOf("if (draft.mode === 'mark')"), projectWorkspaceSource.indexOf('const importOptions'));
assert(markSubmitSource.includes('已登记，但跟踪启动失败') && markSubmitSource.includes('await loadProgressFolders()')
  && !markSubmitSource.includes("throw new Error(started.error || '无法启动版本跟踪任务')"), 'a persisted mark must report tracking-start failure as partial success and refresh the visible node');
const importSubmitSource = projectWorkspaceSource.slice(projectWorkspaceSource.indexOf('const importOptions'), projectWorkspaceSource.indexOf("const trackingParentForProgress"));
assert(importSubmitSource.includes('文件已导入且版本') && importSubmitSource.includes('已登记，但跟踪启动失败'), 'a persisted import must not be misreported as a total import failure when tracking startup fails');
assert(projectWorkspaceSource.includes("const finalExportParentOptions = selectableVersionParents(progressFolders")
  && projectWorkspaceSource.includes("selectableVersionParents(latestFolders, { mediaKind: 'image', relationKind: 'main' })"), 'favorite export dropdown and preflight must share the authoritative structural-parent predicate');
assert(projectWorkspaceSource.includes("(source.nodeRole !== 'original' && source.nodeRole !== 'progress')"), 'drag-to-create must accept both original material and version progress as structural parents');
assert(projectWorkspaceSource.includes("setProgressSetup({ ...nextDraft, contextLocked: true })"), 'dragging a version line to an ordinary or managed external folder must open the locked progress settings panel');
assert(projectWorkspaceSource.includes('targetRelativePath,') && projectWorkspaceSource.includes('trackingEnabled: false,') && projectWorkspaceSource.includes('preserveFolderName: true,'), 'drag-to-create must prefill tracking as disabled before the user submits the mark-progress panel');
assert(projectWorkspaceSource.includes('projectWorkspaceClient.unregisterProgressFolder(workspacePath, project.name, childProgressId)'), 'removing a structural version relation must unregister the folder instead of retaining a detached version node');
assert(projectWorkspaceSource.includes('committedWorkflowInputIds.size === nextWorkflowInputProgressIds.length'), 'structural relation updates must verify obsolete derived selection inputs were removed');
assert(projectWorkspaceSource.includes("edge.edgeKind !== 'workflow_input' || edge.targetProgressId !== childProgressId"), 'the renderer must immediately replace a child version\'s workflow inputs after its structural parent changes');
assert(!projectWorkspaceSource.includes('workflowInputProgressIds: [],'), 'editing a version must never erase its derived selection input');
assert(projectWorkspaceSource.includes('workflowInputIdsForRelationChange(progressFolders, versionGraphEdges, current.existingProgressId'), 'editing a version must recompute its workflow inputs from the selected structural parent');
assert(!projectWorkspaceSource.includes("progressFolders.filter(folder => folder.nodeRole === 'progress' && !folder.parentProgressId") && projectWorkspaceSource.includes('旧版游离进度已保留'), 'reload effects must preserve legacy orphan progress and surface an explicit repair warning');
assert(!projectWorkspaceSource.includes('relationReconnect: true'), 'removed detached records must not retain the obsolete reconnect intake path');
const ordinaryFolderMenu = projectWorkspaceSource.slice(
  projectWorkspaceSource.indexOf('projectWorkflows && isFolderLikeEntry(fileMenu.entry) && !fileMenuVersionTreeFolder'),
  projectWorkspaceSource.indexOf('projectWorkflows && fileMenuRegisteredProgressFolder'),
);
assert(ordinaryFolderMenu.includes('标记…'), 'ordinary-folder context menu must expose the unified marking entry');
assert(!ordinaryFolderMenu.includes('纳入版本树') && !ordinaryFolderMenu.includes('配套素材') && !ordinaryFolderMenu.includes('预览产物')
  && !ordinaryFolderMenu.includes("'companion'") && !ordinaryFolderMenu.includes("'preview'"), 'ordinary-folder context menu must not expose redundant version-tree adoption or legacy artifact purposes');
assert(!ordinaryFolderMenu.includes("'original'") && !ordinaryFolderMenu.includes("'broll'"), 'the context menu must not pre-route original, progress, or broll purposes');
const purposeAdoptionSource = projectWorkspaceSource.slice(
  projectWorkspaceSource.indexOf('const adoptVersionTreeFolder'),
  projectWorkspaceSource.indexOf('const renderVersionTreeEntry'),
);
assert(purposeAdoptionSource.includes("mode: 'original' | 'broll'") && !purposeAdoptionSource.includes("'companion'") && !purposeAdoptionSource.includes("'preview'"), 'the unified mark submit path must create only original or broll standalone purposes');
const versionTreeEntryRendererStart = projectWorkspaceSource.indexOf('const renderVersionTreeEntry');
const versionTreeEntryRendererSource = projectWorkspaceSource.slice(
  versionTreeEntryRendererStart,
  projectWorkspaceSource.indexOf('const progressCompareCandidates =', versionTreeEntryRendererStart),
);
assert(versionTreeEntryRendererSource.includes('progressFolder && inlineRenamePath !== entry.relativePath')
  && versionTreeEntryRendererSource.includes('renderEntryName(entry, true)'), 'a registered progress node must render the shared inline rename input inside the version-tree canvas');
const inlineRenameSource = projectWorkspaceSource.slice(
  projectWorkspaceSource.indexOf('const beginInlineRename'),
  projectWorkspaceSource.indexOf('const openFileMenuAt'),
);
assert(inlineRenameSource.includes('activeFileEntries.find') && inlineRenameSource.includes('if (finalViewOpen) {')
  && inlineRenameSource.includes('await loadFinalViewEntries()'), 'favorite-view rename must resolve the real active entry and refresh the aggregate after committing');
const beginRenameSource = projectWorkspaceSource.slice(
  projectWorkspaceSource.indexOf('const beginRename'),
  projectWorkspaceSource.indexOf('const batchRenameNames', projectWorkspaceSource.indexOf('const beginRename')),
);
assert(!beginRenameSource.includes("if (finalViewOpen)") && !beginRenameSource.includes('externalLinkRelativePath'));
assert(beginRenameSource.includes('registeredProgressEntries.length && targetPaths.length > 1'), 'registered progress folders must allow one local or external alias rename while still rejecting batch rename');
const workspaceGridModel = loadCommonJs(compile('src/features/workspace/marquee-selection-model.ts'));
const versionTreeEntryModel = loadCommonJs(compile('src/features/versioning/project-version-tree-entry-model.ts'));
const versioningPublic = { ...model, ...layoutModel, ...canvasModel, ...edgeModel, ...canvasHook, ...versionTreeEntryModel };
assert.strictEqual(versionTreeEntryModel.versionTreeReactKey({ key: 'entry:old-name', nodeKey: 'progress:stable-progress', folder: { folderId: 'physical-folder-a' } }), 'progress:stable-progress:folder:physical-folder-a', 'registered version nodes combine graph and physical-folder identity');
assert.strictEqual(versionTreeEntryModel.versionTreeReactKey({ key: 'entry:new-name', nodeKey: 'progress:stable-progress', folder: { folderId: 'physical-folder-a' } }), 'progress:stable-progress:folder:physical-folder-a', 'registered version node React identity survives a path-only rename');
assert.notStrictEqual(versionTreeEntryModel.versionTreeReactKey({ key: 'entry:new-name', nodeKey: 'progress:stable-progress', folder: { folderId: 'physical-folder-b' } }), 'progress:stable-progress:folder:physical-folder-a', 'relinking the same graph node to another physical folder must remount its cover');
assert.strictEqual(versionTreeEntryModel.versionTreeReactKey({ key: 'entry:ordinary', nodeKey: 'entry:ordinary' }), 'entry:ordinary', 'ordinary entries keep their path-based React key');
const tree = loadCommonJs(compile('src/components/ProjectVersionTree.tsx'), request => {
  if (request === '../features/versioning/public') return versioningPublic;
  if (request === '../features/versioning/versioning-v2-model') return model;
  if (request === '../features/versioning/version-tree-layout-model') return layoutModel;
  if (request === '../features/versioning/version-tree-canvas-model') return canvasModel;
  if (request === '../features/versioning/version-tree-edge-model') return edgeModel;
  if (request === '../features/versioning/use-version-tree-canvas') return canvasHook;
  if (request === '../features/versioning/project-version-tree-entry-model') return versionTreeEntryModel;
  if (request === '../features/workspace/marquee-selection-model') return workspaceGridModel;
  if (request === './LayerProvider') return { useHostSurfaceSuspension: () => undefined };
  return require(request);
});
const mappingEntry = (name, overrides = {}) => ({ kind: 'folder', name, relativePath: name, path: `C:/p/${name}`, extension: '', size: 0, createdAt: 1, updatedAt: 1, ...overrides });
const stableProgress = sourceFixture({ id: 'stable-progress', displayName: 'Old progress', folderPath: 'C:/p/Old progress' });
const oldProgressEntry = mappingEntry('Old progress');
const optimisticProgressEntry = mappingEntry('New progress', { pendingSourceRelativePath: 'Old progress', previewUrl: 'safe-preview://progress' });
const progressRenameMapping = versionTreeEntryModel.resolveVersionTreeEntryMapping({
  folders: [stableProgress], entries: [optimisticProgressEntry], structureEntries: [oldProgressEntry], scopePath: '', projectRelativePath: value => value.split('/').pop(),
});
assert.strictEqual(progressRenameMapping.versionItems.length, 1, 'old structure plus a renamed optimistic progress folder must resolve to one version item');
assert.strictEqual(progressRenameMapping.versionItems[0].folder.id, 'stable-progress', 'optimistic rename must retain the registered progress identity');
assert.deepStrictEqual({
  name: progressRenameMapping.versionItems[0].entry.name,
  relativePath: progressRenameMapping.versionItems[0].entry.relativePath,
  path: progressRenameMapping.versionItems[0].entry.path,
}, { name: 'New progress', relativePath: 'New progress', path: 'C:/p/New progress' }, 'the stable version item must render the optimistic final name and paths');
assert.deepStrictEqual(progressRenameMapping.ordinaryEntries, [], 'the optimistic progress entry must not be duplicated in Other');
const ordinaryRenameEntry = mappingEntry('New ordinary', { pendingSourceRelativePath: 'Old ordinary' });
const ordinaryRenameMapping = versionTreeEntryModel.resolveVersionTreeEntryMapping({
  folders: [], entries: [ordinaryRenameEntry], structureEntries: [mappingEntry('Old ordinary')], scopePath: '', projectRelativePath: value => value.split('/').pop(),
});
assert.deepStrictEqual(ordinaryRenameMapping.versionItems, []);
assert.deepStrictEqual(ordinaryRenameMapping.ordinaryEntries, [ordinaryRenameEntry], 'an unregistered folder rename must remain one ordinary entry');
const externalProgress = sourceFixture({ id: 'stable-external-progress', displayName: 'External old', folderPath: 'D:/shoot/RAW', externalLinkRelativePath: 'External old.lnk' });
const optimisticExternalEntry = mappingEntry('External new.lnk', { kind: 'shortcut', extension: '.lnk', pendingSourceRelativePath: 'External old.lnk', externalLink: true, externalLinkTarget: 'D:/shoot/RAW' });
const externalRenameMapping = versionTreeEntryModel.resolveVersionTreeEntryMapping({
  folders: [externalProgress], entries: [optimisticExternalEntry], structureEntries: [mappingEntry('External old.lnk', { kind: 'shortcut', extension: '.lnk', externalLink: true, externalLinkTarget: 'D:/shoot/RAW' })], scopePath: '', projectRelativePath: () => '',
});
assert.strictEqual(externalRenameMapping.versionItems.length, 1, 'an external registered progress rename must retain one stable version item');
assert.strictEqual(externalRenameMapping.versionItems[0].entry.relativePath, 'External new.lnk');
assert.deepStrictEqual(externalRenameMapping.ordinaryEntries, [], 'an optimistic external progress alias must not be duplicated in Other');
const legacyRepairNotice = loadCommonJs(compile('src/features/versioning/LegacySelectionRepairNotice.tsx'));
const mutationQueue = loadCommonJs(compile('src/features/versioning/progress-relation-mutation-queue.ts'));
const React = require('react');
const { createRoot } = require('react-dom/client');
const textContent = node => node.textContent;
const allNodes = node => [node, ...node.childNodes.flatMap(allNodes)];
const dispatch = (target, type, extra = {}) => {
  const event = { type, target, bubbles: true, cancelBubble: false, defaultPrevented: false, button: 0, stopPropagation() { this.cancelBubble = true; }, preventDefault() { this.defaultPrevented = true; }, ...extra };
  const path = []; let ancestor = target; while (ancestor) { path.push(ancestor); ancestor = ancestor.parentNode; }
  for (const current of [...path].reverse()) {
    for (const listener of current.captureListeners.get(type) || []) listener(event);
    if (event.cancelBubble) return event;
  }
  let cursor = target;
  while (cursor) {
    for (const listener of cursor.listeners.get(type) || []) listener(event);
    if (event.cancelBubble) break;
    cursor = cursor.parentNode;
  }
  return event;
};
const folders = [{ id: 'raw', projectId: 'p', mediaKind: 'image', versionKey: 'import-d7439bee24773bcbfa2d0a97', displayName: 'RAW', folderPath: 'C:/p/RAW', folderMissing: false, nodeRole: 'original', relationKind: 'main', trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled', trackingSnapshot: {}, tombstone: {}, createdAt: 1, updatedAt: 1 }];
const draft = mode => ({ mode, sourceRelativePath: '客户/RAW', displayName: mode === 'create' ? '新进度' : 'RAW', mediaKind: 'image', relationKind: 'main', parentProgressId: 'raw', versionKey: '1', versionKind: 'main', trackingEnabled: true, renameFromParent: true, copyMissingFromParent: true, workflowInputProgressIds: ['selection'] });

(async () => {
  const container = new TestNode(1, 'DIV', testDocument);
  const root = createRoot(container);
  const markCommon = { relativePath: '客户/素材', folderName: '素材' };
  assert.strictEqual(folderMarkPanel.defaultFolderMarkPurpose('RAW', true), 'original', 'a project-root folder containing RAW files must default to original material');
  assert.strictEqual(folderMarkPanel.defaultFolderMarkPurpose('JPEG', false), 'progress', 'a project-root folder without RAW files must default to progress');
  assert.strictEqual(folderMarkPanel.defaultFolderMarkPurpose('客户/RAW', true), 'progress', 'a nested folder must default to progress even when it contains RAW files');
  assert.strictEqual(folderMarkPanel.defaultFolderMarkPurpose('客户\\RAW', true), 'progress', 'Windows-style nested paths must also default to progress');
  await React.act(async () => root.render(React.createElement(importSourceControls.ImportSourceControls, {
    selectionTitle: '选择文件', selectionDescription: '选择文件', selectedPaths: [], onSelectedPathsChange() {},
    onChooseFiles() {}, deleteSourceAfterImport: false, onDeleteSourceAfterImportChange() {},
    deleteSourceDescription: '保留源文件', importKind: 'files', onImportKindChange() {}, onStart() {},
    disabledImportKinds: ['original', 'progress', 'broll'],
  })));
  const inspirationImportKindButtons = allNodes(container).filter(node => node.nodeName === 'BUTTON' && ['原始素材', '进度', '花絮', '其他文件'].includes(node.textContent));
  assert.deepStrictEqual(inspirationImportKindButtons.filter(node => node.attributes.has('disabled')).map(node => node.textContent), ['原始素材', '进度', '花絮'], 'inspiration imports must disable project-only material kinds');
  assert(!inspirationImportKindButtons.find(node => node.textContent === '其他文件').attributes.has('disabled'), 'inspiration imports must keep other-file import available');
  assert(!allNodes(container).some(node => node.nodeName === 'TEXTAREA'), 'batch path input must start collapsed');
  const pastePathsButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '批量粘贴路径');
  assert(pastePathsButton, 'source selection must render an explicit batch-path toggle button');
  await React.act(async () => dispatch(pastePathsButton, 'click'));
  assert(allNodes(container).some(node => node.nodeName === 'TEXTAREA'), 'clicking the batch-path toggle must reveal the path input');
  const folderSource = 'C:\\Media\\Shoot.v1';
  await React.act(async () => root.render(React.createElement(sourcePathPicker.SourcePathPicker, {
    paths: [folderSource],
    pathKinds: { [sourcePathPickerModel.sourcePathIdentity(folderSource)]: 'folder' },
    onChange() {},
  })));
  assert(textContent(container).includes('目录') && textContent(container).includes('Shoot.v1'), 'known folders must remain one folder row even when their names contain a dot');
  const manySources = Array.from({ length: 501 }, (_, index) => `C:\\Media\\clip-${index}.mov`);
  let changedSources = [];
  await React.act(async () => root.render(React.createElement(sourcePathPicker.SourcePathPicker, {
    paths: manySources,
    onChange(next) { changedSources = next; },
  })));
  const removeFirstSource = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '移除 clip-0.mov');
  await React.act(async () => dispatch(removeFirstSource, 'click'));
  assert.strictEqual(changedSources.length, 500, 'removing one of 501 sources must keep all remaining sources');
  assert(changedSources.includes(manySources[500]), 'removing a source must not discard entries after the old 500-item boundary');
  const secondOriginal = { ...folders[0], id: 'raw-two', versionKey: 'source-two', displayName: 'RAW 2', folderPath: 'C:/p/RAW 2' };
  const ambiguousOriginalDraft = folderMarkPanel.createFolderMarkDraft(markCommon, 'progress', [...folders, secondOriginal], 'image');
  assert.strictEqual(ambiguousOriginalDraft.progress.parentProgressId, '');
  assert.strictEqual(ambiguousOriginalDraft.progress.versionKey, '', 'multiple original sources must require an explicit parent choice');
  const branchLeafA = { ...folders[0], id: 'leaf-a', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'raw', versionKey: '1', displayName: 'Leaf A', folderPath: 'C:/p/Leaf A' };
  const branchLeafB = { ...folders[0], id: 'leaf-b', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'raw', versionKey: '1_1', displayName: 'Leaf B', folderPath: 'C:/p/Leaf B' };
  const ambiguousBranchDraft = folderMarkPanel.createFolderMarkDraft(markCommon, 'progress', [...folders, branchLeafA, branchLeafB], 'image');
  assert.strictEqual(ambiguousBranchDraft.progress.parentProgressId, '');
  assert.strictEqual(ambiguousBranchDraft.progress.versionKey, '', 'multiple progress leaves must never be resolved by array order');
  let markDraft = folderMarkPanel.createFolderMarkDraft(markCommon, 'original', folders, 'image');
  const markSubmissions = [];
  const renderMarkPanel = async () => React.act(async () => root.render(React.createElement(folderMarkPanel.FolderMarkPanel, {
    draft: markDraft,
    folders,
    onChange(next) { markDraft = next; },
    onSubmit(next) { markSubmissions.push(next); },
    onClose() {},
  })));
  await renderMarkPanel();
  assert(textContent(container).includes('标记为') && textContent(container).includes('原始素材') && textContent(container).includes('进度') && textContent(container).includes('花絮'), 'one marking panel must expose all three first-level purposes');
  assert(textContent(container).includes('媒体类型') && !textContent(container).includes('父版本') && !textContent(container).includes('版本跟踪'), 'original mode must show only its media field and no version relationship or tracking fields');
  assert(!allNodes(container).some(node => node.nodeName === 'SELECT') && !allNodes(container).some(node => node.attributes.get('aria-label') === '版本序号'));
  const progressPurposeButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '进度');
  await React.act(async () => dispatch(progressPurposeButton, 'click'));
  assert.strictEqual(markDraft.purpose, 'progress');
  assert.strictEqual(markDraft.progress.parentProgressId, 'raw');
  assert.strictEqual(markDraft.progress.versionKey, '1');
  assert.deepStrictEqual({
    trackingEnabled: markDraft.progress.trackingEnabled,
    renameFromParent: markDraft.progress.renameFromParent,
    copyMissingFromParent: markDraft.progress.copyMissingFromParent,
  }, { trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false }, 'switching to progress must reconstruct clean tracking defaults');
  await renderMarkPanel();
  assert(textContent(container).includes('父版本') && textContent(container).includes('版本序号') && textContent(container).includes('版本跟踪'), 'progress mode must show parent, version/branch, and tracking settings');
  assert(textContent(container).includes('所选文件夹将移动到项目根目录'), 'marking an existing nested folder as progress must show the root-move preflight');
  markDraft = {
    ...markDraft,
    progress: { ...markDraft.progress, versionKey: '7', versionKind: 'branch', trackingEnabled: true, renameFromParent: true, copyMissingFromParent: true, workflowInputProgressIds: ['stale-input'] },
  };
  await renderMarkPanel();
  const brollPurposeButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '花絮');
  await React.act(async () => dispatch(brollPurposeButton, 'click'));
  assert.deepStrictEqual(markDraft, { ...markCommon, purpose: 'broll' }, 'switching to broll must drop every parent/version/tracking temporary field from the discriminated draft');
  await renderMarkPanel();
  assert(textContent(container).includes('混合图片 + 视频') && !textContent(container).includes('父版本') && !textContent(container).includes('版本序号') && !textContent(container).includes('版本跟踪'), 'broll mode must remain mixed and version-chain free');
  const brollSubmit = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '标记为花絮');
  await React.act(async () => dispatch(brollSubmit, 'click'));
  assert.deepStrictEqual(markSubmissions.at(-1), { ...markCommon, purpose: 'broll' }, 'broll submission must contain no stale progress fields');
  const originalPurposeButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '原始素材');
  await React.act(async () => dispatch(originalPurposeButton, 'click'));
  assert.deepStrictEqual(markDraft, { ...markCommon, purpose: 'original', mediaKind: 'image' }, 'switching back to original must build an original-only payload');
  await renderMarkPanel();
  const originalSubmit = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '标记为原始素材');
  await React.act(async () => dispatch(originalSubmit, 'click'));
  assert.strictEqual(markSubmissions.at(-1).purpose, 'original');
  const recreatedProgress = folderMarkPanel.switchFolderMarkPurpose(markDraft, 'progress', folders);
  assert.strictEqual(recreatedProgress.purpose, 'progress');
  assert.strictEqual(recreatedProgress.progress.versionKey, '1');
  assert.strictEqual(recreatedProgress.progress.trackingEnabled, false, 'returning to progress must not resurrect stale version/tracking values');
  markDraft = recreatedProgress;
  await renderMarkPanel();
  const progressSubmit = allNodes(container).find(node => node.nodeName === 'BUTTON' && (node.textContent.includes('继续并检查移动') || node.textContent.includes('创建 V1')));
  await React.act(async () => dispatch(progressSubmit, 'click'));
  assert.strictEqual(markSubmissions.at(-1).purpose, 'progress');
  assert.strictEqual(markSubmissions.at(-1).progress.parentProgressId, 'raw');
  assert.strictEqual(markSubmissions.at(-1).progress.trackingEnabled, false, 'progress submission must use the rebuilt clean branch');
  let lateProgressDraft = folderMarkPanel.createFolderMarkDraft(markCommon, 'progress', [], 'image');
  await React.act(async () => root.render(React.createElement(folderMarkPanel.FolderMarkPanel, {
    draft: lateProgressDraft, folders,
    onChange(next) { lateProgressDraft = next; }, onSubmit() {}, onClose() {},
  })));
  const lateParentSelect = allNodes(container).find(node => node.nodeName === 'SELECT' && node.attributes.get('aria-label') === '父版本');
  assert(lateParentSelect && textContent(container).includes('请选择父版本'), 'late graph hydration must reveal a real parent selector instead of trapping the panel in an empty-parent callout');
  lateParentSelect.value = 'raw';
  await React.act(async () => dispatch(lateParentSelect, 'change'));
  assert.strictEqual(lateProgressDraft.progress.parentProgressId, 'raw');
  assert.strictEqual(lateProgressDraft.progress.versionKey, '1');

  for (const mode of ['create', 'modify']) {
    await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: draft(mode), folders, onChange() {}, onSubmit() {}, onClose() {}, onChooseFolder() {} })));
    const content = textContent(container);
    assert(content.includes('版本跟踪') && content.includes('沿用上一版本文件名') && content.includes('补齐缺失媒体'));
    assert(!content.includes('高级跟踪设置') && !allNodes(container).some(node => node.nodeName === 'DETAILS'), 'tracking policy options must stay visible without a redundant disclosure section');
    assert(content.includes('原始素材 → V1') && !content.includes('import-'), 'internal original-node version keys must never leak into the version creation UI');
    assert(!content.includes('节点用途') && !content.includes('工作流输入'), `${mode} settings must not expose relation types or collaboration inputs`);
    if (mode === 'create') assert(content.includes('将创建') && content.includes('图片') && content.includes('视频') && content.includes('项目根目录'), `${mode} must show the derived version/name summary`);
  }
  const importChanges = [];
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('import'), sourcePaths: ['C:/source'] }, folders, importStep: 'source', onImportStepChange(step) { importChanges.push(step); }, onChange() {}, onSubmit() {}, onClose() {}, onChooseFolder() {} })));
  const sourceContent = textContent(container);
  assert(sourceContent.includes('先选择需要导入的来源') && sourceContent.includes('下一步：设置进度'), 'import must begin with a dedicated source-selection panel');
  assert(!sourceContent.includes('版本跟踪') && !sourceContent.includes('创建版本'), 'source selection must not be merged with version settings');
  const nextButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('下一步：设置进度'));
  await React.act(async () => dispatch(nextButton, 'click'));
  assert.strictEqual(importChanges.at(-1), 'settings');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('import'), sourcePaths: ['C:/source'] }, folders, importStep: 'settings', onImportStepChange(step) { importChanges.push(step); }, onChange() {}, onSubmit() {}, onClose() {}, onChooseFolder() {} })));
  const importSettingsContent = textContent(container);
  assert(importSettingsContent.includes('版本跟踪') && importSettingsContent.includes('创建版本') && importSettingsContent.includes('返回重新选择'), 'the second import step must show version settings and a route back to source selection');
  assert(!importSettingsContent.includes('选择或拖入进度文件/文件夹'), 'the source picker must not remain embedded in the version settings panel');
  const v2Parent = { ...folders[0], id: 'v2', nodeRole: 'progress', versionKey: '2', parentProgressId: 'raw' };
  const createNextChanges = [];
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('create-next'), parentProgressId: 'v2', versionKey: '3', versionKind: 'main' }, folders: [...folders, v2Parent], onChange(next) { createNextChanges.push(next); }, onSubmit() {}, onClose() {} })));
  assert(textContent(container).includes('创建方式') && textContent(container).includes('继续当前分支') && textContent(container).includes('创建子分支'), 'create-next panel must expose explicit continuation/child-branch actions');
  const branchButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('创建子分支'));
  await React.act(async () => dispatch(branchButton, 'click'));
  assert.strictEqual(createNextChanges.at(-1).versionKind, 'branch');
  assert.strictEqual(createNextChanges.at(-1).versionKey, '2_1', 'branch choice must generate the next child number instead of asking the user to type underscore syntax');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: createNextChanges.at(-1), folders: [...folders, v2Parent], onChange(next) { createNextChanges.push(next); }, onSubmit() {}, onClose() {} })));
  assert(textContent(container).includes('V2 → V2_1') && textContent(container).includes('V2_1 ·'), 'generated version must be presented as a derived summary rather than an editable field');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('create-next'), parentProgressId: 'v2', versionKey: '3', versionKind: 'main', contextLocked: true, targetFolderLocked: true }, folders: [...folders, v2Parent], onChange() {}, onSubmit() {}, onClose() {} })));
  const lockedContent = textContent(container);
  assert(lockedContent.includes('从版本树发起，媒体类型和父版本已锁定') && lockedContent.includes('使用现有文件夹“RAW”'), 'version-tree entry must lock its context and describe the existing target folder');
  assert(!allNodes(container).some(node => node.nodeName === 'SELECT') && !allNodes(container).some(node => node.nodeName === 'BUTTON' && (node.textContent === '图片' || node.textContent === '视频')), 'locked version-tree entry must not allow changing parent or media type');
  const v1BranchParent = { ...v2Parent, id: 'v1-1', versionKey: '1_1' };
  const branchMainChanges = [];
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('create-next'), parentProgressId: 'v1-1', versionKey: '1_2', versionKind: 'main' }, folders: [...folders, v2Parent, v1BranchParent], onChange(next) { branchMainChanges.push(next); }, onSubmit() {}, onClose() {} })));
  assert(textContent(container).includes('V1_1 → V1_2'), 'V1_1 main continuation must be presented as V1_2');
  const nestedBranchButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('创建子分支'));
  await React.act(async () => dispatch(nestedBranchButton, 'click'));
  assert.strictEqual(branchMainChanges.at(-1).versionKey, '1_1_1', 'a child branch from V1_1 must be V1_1_1');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: branchMainChanges.at(-1), folders: [...folders, v2Parent, v1BranchParent], onChange(next) { branchMainChanges.push(next); }, onSubmit() {}, onClose() {} })));
  const nestedMainButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('继续当前分支'));
  await React.act(async () => dispatch(nestedMainButton, 'click'));
  assert.strictEqual(branchMainChanges.at(-1).versionKey, '1_2', 'switching back to main must restore the branch-line successor');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: branchMainChanges.at(-1), folders: [...folders, v2Parent, v1BranchParent], onChange(next) { branchMainChanges.push(next); }, onSubmit() {}, onClose() {} })));
  const mainVersionIndex = allNodes(container).find(node => node.nodeName === 'INPUT' && node.attributes.get('aria-label') === '版本序号');
  assert(mainVersionIndex, 'the panel must expose a numeric-only final version segment');
  assert.strictEqual(mainVersionIndex.value, '2', 'the input must contain only the final segment while V1_ remains system-generated');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...branchMainChanges.at(-1), versionKind: 'branch', versionKey: '1_1_1' }, folders: [...folders, v2Parent, v1BranchParent], onChange() {}, onSubmit() {}, onClose() {} })));
  const branchVersionIndex = allNodes(container).find(node => node.nodeName === 'INPUT' && node.attributes.get('aria-label') === '版本序号');
  assert.strictEqual(branchVersionIndex.value, '1', 'a child branch input must expose only its final number while V1_1_ remains system-generated');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...branchMainChanges.at(-1), mode: 'create' }, folders: [...folders, v2Parent, v1BranchParent], onChange(next) { branchMainChanges.push(next); }, onSubmit() {}, onClose() {} })));
  const createNextParentSelect = allNodes(container).find(node => node.nodeName === 'SELECT');
  createNextParentSelect.value = 'v2';
  await React.act(async () => dispatch(createNextParentSelect, 'change'));
  assert.strictEqual(branchMainChanges.at(-1).parentProgressId, 'v2');
  assert.strictEqual(branchMainChanges.at(-1).versionKey, '3', 'changing the parent from V1_1 to V2 must recompute the main successor');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('create'), parentProgressId: '', versionKey: '3', versionKind: 'main' }, folders: [...folders, v2Parent], onChange() {}, onSubmit() {}, onClose() {} })));
  const missingParentSubmit = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('创建 V'));
  assert(textContent(container).includes('请选择父版本') && missingParentSubmit.attributes.has('disabled'), 'an existing version graph must never allow creating a parentless version');
  const mediaSwitchChanges = [];
  const videoOriginalOne = { ...folders[0], id: 'mov-one', mediaKind: 'video', versionKey: 'mov-one', displayName: 'MOV 1', folderPath: 'C:/p/MOV 1' };
  const videoOriginalTwo = { ...videoOriginalOne, id: 'mov-two', versionKey: 'mov-two', displayName: 'MOV 2', folderPath: 'C:/p/MOV 2' };
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: draft('create'), folders: [...folders, videoOriginalOne, videoOriginalTwo], onChange(next) { mediaSwitchChanges.push(next); }, onSubmit() {}, onClose() {} })));
  const videoMediaButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '视频');
  await React.act(async () => dispatch(videoMediaButton, 'click'));
  assert.strictEqual(mediaSwitchChanges.at(-1).parentProgressId, '');
  assert.strictEqual(mediaSwitchChanges.at(-1).versionKey, '', 'switching to an ambiguous media graph must not silently pick the last parent or display V1');
  const emptyMediaDraft = { ...draft('create'), mediaKind: 'video', parentProgressId: '', versionKey: '', versionKind: 'main' };
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: emptyMediaDraft, folders, onChange() {}, onSubmit() {}, onClose() {} })));
  const emptyMediaSubmit = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('创建 V'));
  assert(textContent(container).includes('请先标记原始素材') && textContent(container).includes('没有可用父版本') && emptyMediaSubmit.attributes.has('disabled'), 'an empty media graph must guide the user to mark original material instead of creating a parentless V1');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: draft('create'), folders, onChange() {}, onSubmit() {}, onClose() {} })));
  const rawMainVersionIndex = allNodes(container).find(node => node.nodeName === 'INPUT' && node.attributes.get('aria-label') === '版本序号');
  assert.strictEqual(rawMainVersionIndex.value, '1', 'a main version under original material must expose only its numeric index without an internal prefix');
  const duplicateV17 = { ...v2Parent, id: 'v1-7', versionKey: '1_7', parentProgressId: 'v1-1' };
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('create-next'), parentProgressId: 'v1-1', versionKey: '1_7', versionKind: 'main' }, folders: [...folders, v2Parent, v1BranchParent, duplicateV17], onChange() {}, onSubmit() {}, onClose() {} })));
  const duplicateSubmit = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.has('disabled'));
  assert(textContent(container).includes('版本 V1_7 已存在') && duplicateSubmit, 'a custom final number must not create a duplicate version key');
  const rawBranchChanges = [];
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('modify'), parentProgressId: 'raw', versionKey: 'import-d7439bee24773bcbfa2d0a97', versionKind: 'main' }, folders, onChange(next) { rawBranchChanges.push(next); }, onSubmit() {}, onClose() {} })));
  const rawBranchButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent.includes('创建子分支'));
  await React.act(async () => dispatch(rawBranchButton, 'click'));
  assert.strictEqual(rawBranchChanges.at(-1).versionKey, '1_1', 'an imported RAW internal key must never leak into a visible branch name');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, { draft: { ...draft('modify'), relationKind: 'auxiliary', trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false }, folders, onChange() {}, onSubmit() {}, onClose() {} })));
  assert(textContent(container).includes('选片、预览和协作节点不参与版本跟踪传播'));
  const tracked = {
    ...folders[0],
    id: 'tracked',
    versionKey: '1',
    displayName: 'Tracked',
    folderPath: 'C:/p/Tracked',
    nodeRole: 'progress',
    relationKind: 'main',
    parentProgressId: 'raw',
    trackingEnabled: true,
    trackingState: 'ready',
    createdAt: 2,
    updatedAt: 2,
  };
  const freeProgress = {
    ...tracked,
    id: 'free',
    versionKey: '2',
    displayName: 'Free',
    folderPath: 'C:/p/Free',
    trackingEnabled: false,
    trackingState: 'disabled',
    createdAt: 3,
    updatedAt: 3,
  };
  const selection = {
    ...freeProgress,
    id: 'selection',
    versionKey: 'selection-raw',
    displayName: 'RAW_选片',
    folderPath: 'C:/p/RAW_选片',
    nodeRole: 'selection',
    relationKind: 'auxiliary',
    createdAt: 4,
    updatedAt: 4,
  };
  const generatedArtifact = { ...selection, id: 'generated', displayName: 'generated JPG artifact', folderPath: 'C:/p/generated JPG artifact', nodeRole: 'artifact', artifactKind: 'preview', relationKind: undefined, parentProgressId: undefined };
  const companionArtifact = { ...generatedArtifact, id: 'camera-jpg', displayName: 'Camera JPG', folderPath: 'C:/p/Camera JPG', nodeRole: 'original', artifactKind: 'companion' };
  const ambiguousArtifact = { ...generatedArtifact, id: 'ambiguous-artifact', displayName: 'Ambiguous Artifact', folderPath: 'C:/p/Ambiguous Artifact', artifactKind: undefined };
  const workflow = { ...selection, id: 'workflow', displayName: '组件工作区节点', folderPath: 'C:/p/组件工作区节点', nodeRole: 'workflow', artifactKind: 'component_workspace', relationKind: undefined, parentProgressId: undefined };
  const broll = { ...freeProgress, id: 'broll', mediaKind: 'mixed', versionKey: 'adopt-broll', displayName: '幕后花絮', folderPath: 'C:/p/幕后花絮', nodeRole: 'broll', relationKind: undefined, parentProgressId: undefined, trackingEnabled: false, trackingState: 'disabled' };
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, {
    draft: draft('create'),
    folders: [...folders, selection, generatedArtifact, workflow],
    onChange() {}, onSubmit() {}, onClose() {},
  })));
  const parentSelect = allNodes(container).find(node => node.nodeName === 'SELECT');
  const parentOptionText = parentSelect.options.map(option => option.textContent).join('|');
  assert(parentOptionText.includes('RAW'), 'RAW must be present in the structural parent selector');
  assert(!parentOptionText.includes('generated JPG artifact'), 'generated JPG artifacts must not be structural parent options');
  assert(!parentOptionText.includes('RAW_选片') && !parentOptionText.includes('组件工作区节点'), 'selection and workflow nodes must not be structural parent options');
  assert(!textContent(container).includes('工作流输入'), 'selection and collaboration creation must stay in their own components');
  await React.act(async () => root.render(React.createElement(panel.VersionProgressPanel, {
    draft: draft('modify'), folders, state: 'processing',
    progress: { currentName: '等待“完善版本文件校验信息”完成', waiting: true },
    onChange() {}, onSubmit() {}, onClose() {},
  })));
  assert(textContent(container).includes('等待“完善版本文件校验信息”完成'));
  assert(textContent(container).includes('等待后台资源'));
  assert(!textContent(container).includes('0 / —'), 'indeterminate version edits must not present a fake zero-count progress');
  const entries = [
    { kind: 'folder', name: 'RAW', relativePath: 'RAW', path: 'C:/p/RAW', extension: '', size: 0, createdAt: 1, updatedAt: 1 },
    { kind: 'folder', name: 'Tracked', relativePath: 'Tracked', path: 'C:/p/Tracked', extension: '', size: 0, createdAt: 2, updatedAt: 2 },
    { kind: 'folder', name: 'Free', relativePath: 'Free', path: 'C:/p/Free', extension: '', size: 0, createdAt: 3, updatedAt: 3 },
    { kind: 'folder', name: 'RAW_选片', relativePath: 'RAW_选片', path: 'C:/p/RAW_选片', extension: '', size: 0, createdAt: 4, updatedAt: 4 },
    { kind: 'folder', name: 'generated JPG artifact', relativePath: 'generated JPG artifact', path: 'C:/p/generated JPG artifact', extension: '', size: 0, createdAt: 5, updatedAt: 5 },
    { kind: 'folder', name: 'Camera JPG', relativePath: 'Camera JPG', path: 'C:/p/Camera JPG', extension: '', size: 0, createdAt: 6, updatedAt: 6 },
    { kind: 'folder', name: 'Ambiguous Artifact', relativePath: 'Ambiguous Artifact', path: 'C:/p/Ambiguous Artifact', extension: '', size: 0, createdAt: 7, updatedAt: 7 },
    { kind: 'folder', name: '组件工作区节点', relativePath: '组件工作区节点', path: 'C:/p/组件工作区节点', extension: '', size: 0, createdAt: 8, updatedAt: 8 },
    { kind: 'folder', name: 'Other', relativePath: 'Other', path: 'C:/p/Other', extension: '', size: 0, createdAt: 9, updatedAt: 9 },
    { kind: 'folder', name: '幕后花絮', relativePath: '幕后花絮', path: 'C:/p/幕后花絮', extension: '', size: 0, createdAt: 10, updatedAt: 10 },
    { kind: 'image', name: 'loose.jpg', relativePath: 'loose.jpg', path: 'C:/p/loose.jpg', extension: '.jpg', size: 100, createdAt: 11, updatedAt: 11 },
  ];
  const relationRequests = [];
  const supplementalDeletes = [];
  const supplementalCreates = [];
  const createVersionRequests = [];
  const nativeFileDragRequests = [];
  const layoutNotices = [];
  const viewportScrollStates = [];
  let canvasController = null;
  let entryOpenClicks = 0;
  const treeProps = {
    active: true,
    progressFolders: [...folders, tracked, freeProgress, selection, generatedArtifact, companionArtifact, ambiguousArtifact, workflow, broll],
    graphEdges: [
      { id: 'preview-edge', projectId: 'p', sourceProgressId: 'raw', targetProgressId: 'generated', edgeKind: 'derived_preview', createdAt: 1, updatedAt: 1 },
      { id: 'companion-edge', projectId: 'p', sourceProgressId: 'raw', targetProgressId: 'camera-jpg', edgeKind: 'media_companion', createdAt: 1, updatedAt: 1 },
      { id: 'workflow-edge', projectId: 'p', sourceProgressId: 'selection', targetProgressId: 'tracked', edgeKind: 'workflow_input', createdAt: 1, updatedAt: 1 },
    ],
    entries,
    structureEntries: entries,
    activeRelativePath: '',
    gridIconSize: 100,
    workspacePath: 'C:/workspace',
    projectName: 'Project',
    projectRelativePath: value => value.split('/').pop(),
    renderEntry: (entry, folder, sourceKind) => React.createElement('div', { 'data-source-kind': sourceKind, onClick() { entryOpenClicks += 1; } }, entry.name, folder?.nodeRole === 'broll' ? ` · ${model.versionTreeNodeBadgeLabel(folder)}` : ''),
    pendingChildId: 'tracked',
    onBeginRelationEdit() {},
    onHoverRelationParent() {},
    onRequestRelationChange(childProgressId, parentProgressId) { relationRequests.push({ childProgressId, parentProgressId }); },
    onRequestSupplementalEdgeDelete(edge) { supplementalDeletes.push(edge); },
    onRequestSupplementalEdgeCreate(sourceProgressId, targetProgressId, edgeKind) { supplementalCreates.push({ sourceProgressId, targetProgressId, edgeKind }); },
    onRequestCreateVersion(source, target) { createVersionRequests.push({ sourceId: source.id, targetName: target.name }); },
    onStartFileDrag(event, entry) { event.preventDefault(); nativeFileDragRequests.push(entry.relativePath); },
    onCancelRelationEdit() {},
    onNotice(message) { layoutNotices.push(message); },
    onCanvasControllerChange(controller) { canvasController = controller; },
    onViewportScrollChange(scrolled) { viewportScrollStates.push(scrolled); },
  };
  let renameProbeMounts = 0;
  let renameProbeUnmounts = 0;
  const RenameMountProbe = ({ relativePath }) => {
    React.useEffect(() => {
      renameProbeMounts += 1;
      return () => { renameProbeUnmounts += 1; };
    }, []);
    return React.createElement('div', { 'data-rename-mount-probe': relativePath }, relativePath);
  };
  const stableRawFolder = { ...folders[0], folderId: 'physical-raw-folder' };
  const renameFolder = {
    ...tracked,
    id: 'rename-probe',
    folderId: 'physical-progress-folder',
    folderPath: 'C:/p/Old progress',
    displayName: 'Old progress',
    parentProgressId: 'raw',
    versionKey: 'rename-probe',
  };
  const rawRenameEntry = { ...entries[0] };
  const oldRenameEntry = mappingEntry('Old progress');
  const renameTreeProps = {
    ...treeProps,
    projectName: 'Rename mount identity',
    progressFolders: [stableRawFolder, renameFolder],
    graphEdges: [],
    entries: [rawRenameEntry, oldRenameEntry],
    structureEntries: [rawRenameEntry, oldRenameEntry],
    pendingChildId: undefined,
    renderEntry: (entry, folder) => folder?.id === renameFolder.id
      ? React.createElement(RenameMountProbe, { relativePath: entry.relativePath })
      : React.createElement('div', null, entry.name),
  };
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, renameTreeProps)));
  assert.strictEqual(renameProbeMounts, 1, 'the stateful registered-folder cover mounts once at its original path');
  const pendingRenameEntry = mappingEntry('New progress', { pendingSourceRelativePath: 'Old progress' });
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, {
    ...renameTreeProps,
    entries: [rawRenameEntry, pendingRenameEntry],
  })));
  assert.strictEqual(renameProbeMounts, 1, 'optimistic path rename must preserve the mounted registered-folder cover');
  assert.strictEqual(renameProbeUnmounts, 0, 'optimistic path rename must not tear down the cover subtree');
  const committedRenameFolder = { ...renameFolder, folderPath: 'C:/p/New progress', displayName: 'New progress' };
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, {
    ...renameTreeProps,
    progressFolders: [stableRawFolder, committedRenameFolder],
    entries: [rawRenameEntry, mappingEntry('New progress')],
    structureEntries: [rawRenameEntry, mappingEntry('New progress')],
  })));
  assert.strictEqual(renameProbeMounts, 1, 'committing a rename with the same folderId must retain the cover instance');
  assert.strictEqual(renameProbeUnmounts, 0, 'committed path metadata must not blank a mounted cover');
  const relinkedRenameFolder = { ...committedRenameFolder, folderId: 'replacement-physical-folder', folderPath: 'C:/p/Replacement progress', displayName: 'Replacement progress' };
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, {
    ...renameTreeProps,
    progressFolders: [stableRawFolder, relinkedRenameFolder],
    entries: [rawRenameEntry, mappingEntry('Replacement progress')],
    structureEntries: [rawRenameEntry, mappingEntry('Replacement progress')],
  })));
  assert.strictEqual(renameProbeMounts, 2, 'relinking the graph node to a new folderId must mount a fresh cover');
  assert.strictEqual(renameProbeUnmounts, 1, 'relinking must discard the previous physical folder cover');
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, treeProps)));
  const brollCanvasNodes = allNodes(container).filter(node => node.attributes.get('data-version-progress-id') === 'broll');
  assert.strictEqual(brollCanvasNodes.length, 1, 'a persisted mixed broll folder must render exactly once in the Other shelf');
  assert(brollCanvasNodes[0].textContent.includes('花絮'), 'broll must render a dedicated 花絮 badge instead of original/companion/preview');
  assert(!allNodes(brollCanvasNodes[0]).some(node => node.attributes.has('data-version-tree-port')), 'broll must expose no input or output version-relation ports');
  assert(!brollCanvasNodes[0].attributes.has('data-version-output-target-key'), 'broll must not advertise itself as a drag-to-connect target');
  const feedbackContainer = new TestNode(1, 'DIV', testDocument);
  const feedbackRoot = createRoot(feedbackContainer);
  let feedbackRenders = 0;
  const FeedbackHarness = () => {
    const [, setNoticeRevision] = React.useState(0);
    feedbackRenders += 1;
    return React.createElement(tree.ProjectVersionTree, {
      ...treeProps,
      projectName: 'Effect feedback regression',
      onNotice() { setNoticeRevision(value => value + 1); },
      onCanvasControllerChange() {},
    });
  };
  const loadsBeforeFeedback = layoutRequests.loads;
  layoutRequests.failLoadBudget = 8;
  await React.act(async () => {
    feedbackRoot.render(React.createElement(FeedbackHarness));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.strictEqual(layoutRequests.loads - loadsBeforeFeedback, 1, 'layout load failure feedback must not retrigger the load effect when the parent recreates onNotice');
  assert(feedbackRenders <= 2, 'layout failure feedback must settle after the single parent state update instead of reaching maximum update depth');
  await React.act(async () => feedbackRoot.unmount());
  layoutRequests.failLoadBudget = 0;
  const rawCanvasNode = allNodes(container).find(node => node.nodeName === 'DIV' && node.attributes.get('data-node-role') === 'original');
  const rawEntryNode = allNodes(rawCanvasNode).find(node => node !== rawCanvasNode && node.nodeName === 'DIV' && node.textContent === 'RAW');
  const canvasNode = allNodes(container).find(node => node.nodeName === 'DIV' && node.attributes.get('data-version-tree-canvas') === 'true');
  const canvasViewport = allNodes(container).find(node => node.nodeName === 'DIV' && node.attributes.get('data-version-tree-viewport') === 'true');
  assert((canvasViewport.attributes.get('class') || '').includes('h-full') && (canvasViewport.attributes.get('class') || '').includes('overflow-auto'), 'the version-tree viewport must fill and scroll inside the complete file region');
  await React.act(async () => dispatch(canvasViewport, 'wheel', { deltaY: 120 }));
  assert.strictEqual(viewportScrollStates.at(-1), true, 'downward wheel intent must collapse the project overview before the canvas scroll position changes');
  await React.act(async () => dispatch(canvasViewport, 'scroll'));
  assert.strictEqual(viewportScrollStates.at(-1), true, 'a zero-position scroll event must not immediately undo the wheel-triggered collapse');
  await React.act(async () => dispatch(canvasViewport, 'wheel', { deltaY: -120 }));
  assert.strictEqual(viewportScrollStates.at(-1), false, 'upward wheel intent at an already-zero scroll position must reveal the project overview');
  await React.act(async () => dispatch(canvasViewport, 'wheel', { deltaY: 120 }));
  canvasViewport.scrollTop = 40;
  await React.act(async () => dispatch(canvasViewport, 'scroll'));
  assert.strictEqual(viewportScrollStates.at(-1), true, 'scrolling down the version tree must keep the project overview collapsed');
  canvasViewport.scrollTop = 0;
  await React.act(async () => dispatch(canvasViewport, 'scroll'));
  assert.strictEqual(viewportScrollStates.at(-1), false, 'returning upward to the top of the version tree must reveal the project overview');
  assert.strictEqual(canvasNode.style.minWidth, '100%', 'the interactive dotted canvas must fill the viewport instead of shrinking to graph content');
  assert(!textContent(container).includes('图片工作流') && !textContent(container).includes('视频工作流'), 'legacy workflow headings must be removed');
  assert(allNodes(container).some(node => node.attributes.get('aria-label') === '图片区域'), 'the mounted graph must expose a Blender-like image region');
  assert(allNodes(container).some(node => node.attributes.get('aria-label') === '其他区域'), 'ordinary folders must share the version-tree canvas in an other region');
  assert(!textContent(container).includes('$图片') && !textContent(container).includes('$其他'), 'semantic region labels must not expose template-expression dollar signs');
  const imageArea = allNodes(container).find(node => node.attributes.get('aria-label') === '图片区域');
  const otherArea = allNodes(container).find(node => node.attributes.get('aria-label') === '其他区域');
  assert(parseFloat(imageArea.style.top) + parseFloat(imageArea.style.height) <= parseFloat(otherArea.style.top), 'default semantic regions must not overlap');
  assert(!allNodes(imageArea).some(node => node.nodeName === 'BUTTON') && !/[▶▼]/u.test(textContent(imageArea)), 'semantic frames must be a separate passive layer without disclosure arrows');
  const imageAreaBeforeDrag = { left: imageArea.style.left, top: imageArea.style.top, width: imageArea.style.width, height: imageArea.style.height };
  const looseFileNode = allNodes(container).find(node => node.attributes.get('data-version-tree-node') === 'true' && node.textContent.includes('loose.jpg'));
  assert(looseFileNode, 'ordinary files must remain visible as version-tree canvas nodes');
  assert(!looseFileNode.attributes.has('data-version-output-target-key'), 'ordinary files must stay passive instead of accepting version outputs');
  assert(parseFloat(looseFileNode.style.top) >= parseFloat(otherArea.style.top)
    && parseFloat(looseFileNode.style.top) < parseFloat(otherArea.style.top) + parseFloat(otherArea.style.height), 'ordinary files must render inside the Other region');
  assert(!textContent(container).includes('适应窗口') && !textContent(container).includes('100%') && !textContent(container).includes('剪线工具') && !textContent(container).includes('节点视图'), 'the version tree must not add a second top toolbar');
  const miniMap = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('title') === '小地图：点击显示全部');
  assert((miniMap?.attributes.get('class') || '').includes('fixed') && (miniMap?.attributes.get('class') || '').includes('bottom-4') && (miniMap?.attributes.get('class') || '').includes('right-4'), 'the mini map must remain fixed to the viewport bottom-right');
  assert.strictEqual(typeof canvasController.fitView, 'function');
  assert.strictEqual(typeof canvasController.resetZoom, 'function');
  const initialCanvasWidth = parseFloat(canvasNode.style.width);
  const initialMainPath = allNodes(container).find(node => node.nodeName === 'path' && node.attributes.get('data-relation-kind') === 'main' && node.attributes.has('marker-end'))?.attributes.get('d');
  const initialWorkflowPath = allNodes(container).find(node => node.nodeName === 'path' && node.attributes.get('data-relation-kind') === 'workflow_input' && node.attributes.has('marker-end'))?.attributes.get('d');
  const arrowMarker = allNodes(container).find(node => node.nodeName === 'marker');
  assert.strictEqual(arrowMarker?.attributes.get('markerUnits'), 'userSpaceOnUse', 'arrowheads must use fixed canvas units so thin supplemental edges do not float above their target');
  assert.strictEqual(arrowMarker?.attributes.get('refX'), '0', 'the relation line must join the rear of the arrowhead instead of running through to its tip');
  const imageAreaResizeHandle = allNodes(container).find(node => node.attributes.get('aria-label') === '调整图片区域大小');
  const otherAreaResizeHandle = allNodes(container).find(node => node.attributes.get('aria-label') === '调整其他区域大小');
  assert(imageAreaResizeHandle && otherAreaResizeHandle, 'image, video, and other semantic frames must expose pointer resize handles');
  assert((imageAreaResizeHandle.attributes.get('class') || '').includes('cursor-nwse-resize') && !(imageAreaResizeHandle.attributes.get('class') || '').includes('border-') && !(imageAreaResizeHandle.attributes.get('class') || '').includes('hover:bg-'), 'frame corner handles must stay invisible while exposing the resize cursor');
  const imageAreaWidthBeforeResize = parseFloat(imageArea.style.width);
  await React.act(async () => {
    dispatch(imageAreaResizeHandle, 'pointerdown', { pointerId: 40, button: 0, clientX: 600, clientY: 600 });
    dispatch(imageAreaResizeHandle, 'pointermove', { pointerId: 40, button: 0, clientX: 680, clientY: 660 });
    dispatch(imageAreaResizeHandle, 'pointerup', { pointerId: 40, button: 0, clientX: 680, clientY: 660 });
  });
  assert(parseFloat(imageArea.style.width) > imageAreaWidthBeforeResize, 'dragging a semantic-frame corner must resize the frame');
  const otherAreaWidthBeforeResize = parseFloat(otherArea.style.width);
  await React.act(async () => {
    dispatch(otherAreaResizeHandle, 'pointerdown', { pointerId: 41, button: 0, clientX: 700, clientY: 700 });
    dispatch(otherAreaResizeHandle, 'pointermove', { pointerId: 41, button: 0, clientX: 760, clientY: 740 });
    dispatch(otherAreaResizeHandle, 'pointerup', { pointerId: 41, button: 0, clientX: 760, clientY: 740 });
  });
  assert(parseFloat(otherArea.style.width) > otherAreaWidthBeforeResize, 'the other semantic frame must use the same resize interaction as image and video frames');
  assert(initialWorkflowPath?.includes(' C ') && !initialWorkflowPath.includes(' L '), 'vertically arranged workflow relations must use port-aware curves instead of a top rectangular detour');
  const shelfEntries = [...entries,
    { kind: 'folder', name: 'Other B', relativePath: 'Other B', path: 'C:/p/Other B', extension: '', size: 0, createdAt: 11, updatedAt: 11 },
    { kind: 'folder', name: 'Other C', relativePath: 'Other C', path: 'C:/p/Other C', extension: '', size: 0, createdAt: 12, updatedAt: 12 },
    { kind: 'shortcut', name: 'External RAW.lnk', relativePath: 'External RAW.lnk', path: 'C:/p/External RAW.lnk', extension: '.lnk', size: 0, createdAt: 13, updatedAt: 13, externalLink: true, externalLinkTarget: 'D:/shoot/RAW' },
    { kind: 'shortcut', name: 'raw.lnk', relativePath: 'raw.lnk', path: 'C:/p/raw.lnk', extension: '.lnk', size: 0, createdAt: 14, updatedAt: 14, externalLink: true, externalLinkTarget: 'E:/legacy/raw' },
  ];
  await React.act(async () => {
    root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, entries: shelfEntries, structureEntries: shelfEntries }));
    await Promise.resolve(); await Promise.resolve();
  });
  const shelfNodes = [
    allNodes(container).find(node => node.attributes.get('data-version-output-target-key') === 'entry:other'),
    allNodes(container).find(node => node.attributes.get('data-version-tree-node') === 'true' && node.textContent.includes('loose.jpg')),
    allNodes(container).find(node => node.attributes.get('data-version-output-target-key') === 'entry:other b'),
    allNodes(container).find(node => node.attributes.get('data-version-output-target-key') === 'entry:other c'),
  ];
  assert(shelfNodes.every(Boolean), 'the Other shelf must contain both ordinary files and folders');
  const shelfTops = shelfNodes.map(node => node.style.top);
  assert.strictEqual(new Set(shelfTops).size, 1, 'ordinary entries in the Other region must prefer one horizontal row');
  const shelfLefts = shelfNodes.map(node => parseFloat(node.style.left));
  shelfLefts.slice(1).forEach((left, index) => {
    assert.strictEqual(left - shelfLefts[index], treeProps.gridIconSize + workspaceGridModel.FILE_GRID_GAP, 'every ordinary entry must keep the standard icon-grid pitch');
  });
  assert(allNodes(container).some(node => node.attributes.get('data-version-output-target-key') === 'entry:external raw.lnk'), 'an untracked managed external folder must appear as a regular folder node in the version tree');
  const inferredLegacyOriginal = allNodes(container).find(node => node.attributes.get('data-version-output-target-key') === 'entry:raw.lnk');
  assert(inferredLegacyOriginal && allNodes(inferredLegacyOriginal).some(node => node.attributes.get('data-source-kind') === 'image'), 'an existing canonical RAW external link without historical role metadata must be inferred into the image original-material area instead of Other');
  const externalProgress = { ...freeProgress, id: 'external-progress', displayName: 'External RAW', folderPath: 'D:/shoot/RAW', nodeRole: 'original', versionKey: 'original-external', createdAt: 13, updatedAt: 13 };
  await React.act(async () => {
    root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, entries: shelfEntries, structureEntries: shelfEntries, progressFolders: [...treeProps.progressFolders, externalProgress] }));
    await Promise.resolve(); await Promise.resolve();
  });
  const externalProgressNode = allNodes(container).find(node => node.attributes.get('data-version-progress-id') === 'external-progress');
  assert(externalProgressNode && externalProgressNode.textContent.includes('External RAW.lnk'), 'a managed external folder must remain visible after it is registered as a version node');
  assert.strictEqual(externalProgressNode.attributes.get('data-node-role'), 'original', 'a linked original-material folder must render as an original node instead of remaining an ordinary Other entry');
  await React.act(async () => {
    root.render(React.createElement(tree.ProjectVersionTree, treeProps));
    await Promise.resolve(); await Promise.resolve();
  });
  const initialFreeNode = allNodes(container).find(node => node.attributes.get('data-version-progress-id') === 'free');
  const initialFreeLeft = parseFloat(initialFreeNode.style.left);
  const relinkedFolders = treeProps.progressFolders.map(folder => folder.id === 'free' ? { ...folder, parentProgressId: 'tracked', updatedAt: folder.updatedAt + 1 } : folder);
  await React.act(async () => {
    root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, progressFolders: relinkedFolders }));
    await Promise.resolve(); await Promise.resolve();
  });
  const relinkedFreeNode = allNodes(container).find(node => node.attributes.get('data-version-progress-id') === 'free');
  assert(parseFloat(relinkedFreeNode.style.left) > initialFreeLeft, 'saving a new parent relation must immediately move an automatically positioned child into its new graph column');
  await React.act(async () => {
    root.render(React.createElement(tree.ProjectVersionTree, treeProps));
    await Promise.resolve(); await Promise.resolve();
  });
  Object.assign(imageAreaBeforeDrag, { left: imageArea.style.left, top: imageArea.style.top, width: imageArea.style.width, height: imageArea.style.height });
  const savesBeforeDragging = layoutRequests.saves.length;
  await React.act(async () => {
    dispatch(rawCanvasNode, 'pointerdown', { pointerId: 41, button: 0, clientX: 100, clientY: 100 });
    dispatch(rawCanvasNode, 'pointermove', { pointerId: 41, button: 0, clientX: 103, clientY: 102 });
    dispatch(rawCanvasNode, 'pointerup', { pointerId: 41, button: 0, clientX: 103, clientY: 102 });
    dispatch(rawEntryNode, 'click');
  });
  assert.strictEqual(layoutRequests.saves.length, savesBeforeDragging, 'movement below 5px must remain a normal click and never save layout');
  assert.strictEqual(entryOpenClicks, 1, 'movement below the threshold must preserve the entry click');
  const savesBeforeNativeFileDrag = layoutRequests.saves.length;
  await React.act(async () => {
    dispatch(testWindow, 'keydown', { key: 'Control', ctrlKey: true, target: testDocument.body });
  });
  assert.strictEqual(rawCanvasNode.attributes.get('draggable'), 'true', 'holding Ctrl must arm native draggable before pointerdown so the browser can create a real drag gesture');
  await React.act(async () => {
    dispatch(rawCanvasNode, 'pointerdown', { pointerId: 91, button: 0, ctrlKey: true, clientX: 100, clientY: 100 });
    dispatch(rawCanvasNode, 'pointermove', { pointerId: 91, button: 0, ctrlKey: true, clientX: 700, clientY: 600 });
    dispatch(rawCanvasNode, 'dragstart', { ctrlKey: true });
    dispatch(rawCanvasNode, 'dragend', { ctrlKey: true });
    dispatch(testWindow, 'keyup', { key: 'Control', ctrlKey: false, target: testDocument.body });
  });
  assert.deepStrictEqual(nativeFileDragRequests, ['RAW'], 'Ctrl-dragging a version-tree folder must start the native file drag');
  assert.strictEqual(layoutRequests.saves.length, savesBeforeNativeFileDrag, 'Ctrl-dragging a folder must not move or save its version-tree position');
  assert.strictEqual(rawCanvasNode.attributes.get('draggable'), 'false', 'releasing Ctrl must return the node to canvas-layout mode after native drag');
  await React.act(async () => {
    dispatch(rawCanvasNode, 'pointerdown', { pointerId: 42, button: 0, clientX: 100, clientY: 100 });
    dispatch(rawCanvasNode, 'pointermove', { pointerId: 42, button: 0, clientX: 700, clientY: 600 });
    dispatch(rawCanvasNode, 'pointerup', { pointerId: 42, button: 0, clientX: 700, clientY: 600 });
    dispatch(rawEntryNode, 'click');
    await Promise.resolve(); await Promise.resolve();
  });
  assert.strictEqual(layoutRequests.saves.length, savesBeforeDragging + 1, 'one completed node drag must issue exactly one patch save');
  assert.strictEqual(entryOpenClicks, 1, 'a completed drag must suppress the following folder click');
  assert(parseFloat(canvasNode.style.width) > initialCanvasWidth, 'moving a node right must expand the canvas bounds');
  assert.deepStrictEqual({ left: imageArea.style.left, top: imageArea.style.top, width: imageArea.style.width, height: imageArea.style.height }, imageAreaBeforeDrag, 'ordinary node movement must not resize or chase its semantic frame');
  const movedMainPath = allNodes(container).find(node => node.nodeName === 'path' && node.attributes.get('data-relation-kind') === 'main' && node.attributes.has('marker-end'))?.attributes.get('d');
  assert.notStrictEqual(movedMainPath, initialMainPath, 'relation paths must update during local node movement');
  let savedLeft = rawCanvasNode.style.left;
  let savedTop = rawCanvasNode.style.top;
  const savesBeforeStaleRetry = layoutRequests.saves.length;
  const noticesBeforeStaleRetry = layoutNotices.length;
  const freeCanvasNode = allNodes(container).find(node => node.attributes.get('data-version-progress-id') === 'free');
  const concurrentFreePosition = { nodeKey: 'progress:free', x: parseFloat(freeCanvasNode.style.left) + 333, y: parseFloat(freeCanvasNode.style.top) + 222 };
  layoutRequests.staleMutation = concurrentFreePosition;
  layoutRequests.staleNextSave = true;
  layoutRequests.holdSaves = true;
  let queuedConflictUndo;
  await React.act(async () => {
    dispatch(rawCanvasNode, 'pointerdown', { pointerId: 420, button: 0, clientX: 700, clientY: 600 });
    dispatch(rawCanvasNode, 'pointermove', { pointerId: 420, button: 0, clientX: 720, clientY: 620 });
    dispatch(rawCanvasNode, 'pointerup', { pointerId: 420, button: 0, clientX: 720, clientY: 620 });
    await Promise.resolve();
    queuedConflictUndo = canvasController.undoLayout();
    layoutRequests.holdSaves = false;
    layoutRequests.saveReleases.splice(0).forEach(release => release());
    assert.strictEqual(await queuedConflictUndo, false, 'undo queued before stale recovery must be invalidated by the new history epoch');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
  assert.strictEqual(layoutRequests.saves.length, savesBeforeStaleRetry + 2, 'stale layout saves must reload the revision and retry exactly once');
  assert.strictEqual(layoutNotices.length, noticesBeforeStaleRetry, 'a recovered stale layout save must not show an error notice');
  assert.strictEqual(parseFloat(freeCanvasNode.style.left), concurrentFreePosition.x + 32, 'stale patch recovery must merge the winning server X coordinate for untouched nodes');
  assert.strictEqual(parseFloat(freeCanvasNode.style.top), concurrentFreePosition.y + 32, 'stale patch recovery must merge the winning server Y coordinate for untouched nodes');
  const savesBeforeConflictUndo = layoutRequests.saves.length;
  let conflictUndoResult;
  await React.act(async () => { conflictUndoResult = await canvasController.undoLayout(); });
  assert.strictEqual(conflictUndoResult, false, 'history based on a losing revision must be discarded after a merged retry');
  assert.strictEqual(layoutRequests.saves.length, savesBeforeConflictUndo, 'discarded conflict history must never issue a full replace undo');
  savedLeft = rawCanvasNode.style.left;
  savedTop = rawCanvasNode.style.top;
  const loadsBeforeFailure = layoutRequests.loads;
  layoutRequests.failNextSave = true;
  await React.act(async () => {
    dispatch(rawCanvasNode, 'pointerdown', { pointerId: 43, button: 0, clientX: 700, clientY: 600 });
    dispatch(rawCanvasNode, 'pointermove', { pointerId: 43, button: 0, clientX: 760, clientY: 660 });
    dispatch(rawCanvasNode, 'pointerup', { pointerId: 43, button: 0, clientX: 760, clientY: 660 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
  assert(layoutNotices.some(message => message.includes('保存版本树布局失败')), 'save failure must produce a user-visible notice');
  assert(layoutRequests.loads > loadsBeforeFailure, 'save failure must reload the server layout');
  assert.strictEqual(rawCanvasNode.style.left, savedLeft, 'save failure must restore the previous X position');
  assert.strictEqual(rawCanvasNode.style.top, savedTop, 'save failure must restore the previous Y position');
  const savesBeforeQueuedFailure = layoutRequests.saves.length;
  layoutRequests.holdSaves = true;
  layoutRequests.failNextSave = true;
  await React.act(async () => {
    dispatch(rawCanvasNode, 'pointerdown', { pointerId: 431, button: 0, clientX: 700, clientY: 600 });
    dispatch(rawCanvasNode, 'pointermove', { pointerId: 431, button: 0, clientX: 740, clientY: 640 });
    dispatch(rawCanvasNode, 'pointerup', { pointerId: 431, button: 0, clientX: 740, clientY: 640 });
    await Promise.resolve(); await Promise.resolve();
    dispatch(rawCanvasNode, 'pointerdown', { pointerId: 432, button: 0, clientX: 740, clientY: 640 });
    dispatch(rawCanvasNode, 'pointermove', { pointerId: 432, button: 0, clientX: 780, clientY: 680 });
    dispatch(rawCanvasNode, 'pointerup', { pointerId: 432, button: 0, clientX: 780, clientY: 680 });
  });
  assert.strictEqual(layoutRequests.saves.length, savesBeforeQueuedFailure + 1, 'the second layout write must remain queued while the first write is in flight');
  layoutRequests.holdSaves = false;
  layoutRequests.saveReleases.splice(0).forEach(release => release());
  await React.act(async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); });
  assert.strictEqual(layoutRequests.saves.length, savesBeforeQueuedFailure + 1, 'a failed layout write must cancel later optimistic writes from the same UI epoch');
  canvasViewport.scrollLeft = 80; canvasViewport.scrollTop = 60;
  await React.act(async () => {
    dispatch(canvasNode, 'pointerdown', { pointerId: 44, button: 1, clientX: 200, clientY: 200 });
    dispatch(canvasNode, 'pointermove', { pointerId: 44, button: 1, clientX: 150, clientY: 130 });
    dispatch(canvasNode, 'pointerup', { pointerId: 44, button: 1, clientX: 150, clientY: 130 });
  });
  assert.strictEqual(canvasViewport.scrollLeft, 130, 'middle-button canvas pan must update horizontal scroll');
  assert.strictEqual(canvasViewport.scrollTop, 130, 'middle-button canvas pan must update vertical scroll');
  let spaceKeyDown;
  await React.act(async () => {
    spaceKeyDown = dispatch(testWindow, 'keydown', { code: 'Space', key: ' ', target: testDocument.body });
    const panPointerDown = dispatch(canvasNode, 'pointerdown', { pointerId: 45, button: 0, clientX: 150, clientY: 130 });
    assert(panPointerDown.cancelBubble, 'a claimed canvas pan must not bubble into the outer file-surface marquee interaction');
  });
  assert(spaceKeyDown.defaultPrevented, 'version-tree Space handling must suppress native downward page scrolling');
  assert.strictEqual(canvasNode.attributes.get('data-drag-state'), 'pan', 'Space plus left-button drag must enter canvas panning');
  assert((canvasNode.attributes.get('class') || '').includes('cursor-grabbing'), 'an active canvas pan must show the grabbing cursor');
  let spaceKeyUp;
  await React.act(async () => {
    dispatch(canvasNode, 'pointermove', { pointerId: 45, button: 0, clientX: 120, clientY: 100 });
    spaceKeyUp = dispatch(testWindow, 'keyup', { code: 'Space', key: ' ', target: testDocument.body });
  });
  assert(spaceKeyUp.defaultPrevented, 'releasing Space after a version-tree pan must also suppress its native scroll action');
  assert(!canvasNode.hasPointerCapture(45), 'releasing Space must release the active canvas pointer');
  assert(!canvasNode.attributes.has('data-drag-state'), 'releasing Space must end canvas panning immediately');
  assert(!(canvasNode.attributes.get('class') || '').includes('cursor-grabbing'), 'the grabbing cursor must clear when Space is released');
  await React.act(async () => {
    dispatch(canvasNode, 'pointermove', { pointerId: 45, button: 0, clientX: 80, clientY: 60 });
    dispatch(canvasNode, 'pointerup', { pointerId: 45, button: 0, clientX: 80, clientY: 60 });
  });
  assert.strictEqual(canvasViewport.scrollLeft, 160, 'Space plus left-button drag must pan the canvas');
  assert.strictEqual(canvasViewport.scrollTop, 160, 'Space plus left-button drag must pan vertically');
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, active: false })));
  const inactiveTreeSpace = dispatch(testWindow, 'keydown', { code: 'Space', key: ' ', target: testDocument.body });
  assert(!inactiveTreeSpace.defaultPrevented, 'an inactive version-tree page must preserve the normal Space scroll behavior elsewhere');
  dispatch(testWindow, 'keyup', { code: 'Space', key: ' ', target: testDocument.body });
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, treeProps)));
  assert(canvasController?.hasManualLayout, 'moving a node must mark the current layout as manual');
  const savesBeforeStaleRefresh = layoutRequests.saves.length;
  const loadsBeforeStaleRefresh = layoutRequests.loads;
  layoutRequests.staleNextSave = true;
  let staleRefreshResult;
  await React.act(async () => { staleRefreshResult = await canvasController.refreshLayout(); });
  assert.strictEqual(staleRefreshResult, false, 'a stale atomic replacement must not overwrite a concurrent layout');
  assert.strictEqual(layoutRequests.saves.length, savesBeforeStaleRefresh + 1, 'a stale replacement must not retry against the newer revision');
  assert(layoutRequests.loads > loadsBeforeStaleRefresh, 'a stale replacement must load the winning server layout and revision');
  canvasViewport.scrollLeft = 160; canvasViewport.scrollTop = 160;
  const beforeFailedRefreshLeft = rawCanvasNode.style.left;
  const beforeFailedRefreshTop = rawCanvasNode.style.top;
  const loadsBeforeFailedRefresh = layoutRequests.loads;
  layoutRequests.failNextSave = true;
  let failedRefreshResult;
  await React.act(async () => { failedRefreshResult = await canvasController.refreshLayout(); });
  assert.strictEqual(failedRefreshResult, false, 'failed standard-layout replacement must report failure');
  assert.strictEqual(layoutRequests.saves.at(-1).mode, 'replace', 'standard layout refresh must use an atomic replace save');
  assert.strictEqual(rawCanvasNode.style.left, beforeFailedRefreshLeft, 'failed standard-layout replacement must preserve the current X position');
  assert.strictEqual(rawCanvasNode.style.top, beforeFailedRefreshTop, 'failed standard-layout replacement must preserve the current Y position');
  assert.strictEqual(layoutRequests.loads, loadsBeforeFailedRefresh, 'failed standard-layout replacement must not replace the retained UI with a server reload');
  assert.strictEqual(canvasViewport.scrollLeft, 160, 'failed refresh must preserve the viewport');
  let successfulRefreshResult;
  await React.act(async () => { successfulRefreshResult = await canvasController.refreshLayout(); });
  assert.strictEqual(successfulRefreshResult, true, 'successful standard-layout replacement must report success');
  assert.notStrictEqual(rawCanvasNode.style.left, beforeFailedRefreshLeft, 'successful refresh must apply the default layout after persistence');
  assert.strictEqual(canvasViewport.scrollLeft, 0, 'successful refresh must move the viewport to the layout origin');
  assert.strictEqual(canvasViewport.scrollTop, 0, 'successful refresh must move the viewport to the layout origin vertically');
  assert.strictEqual(canvasController.hasManualLayout, false, 'the restored default coordinates must no longer count as manual layout');
  assert(!allNodes(container).some(node => node.nodeName === 'BUTTON' && (node.textContent === '编辑关系' || node.textContent === '完成关系编辑' || node.textContent === '刷新布局')), 'version tree must not restore the old top relation toolbar');
  assert(!allNodes(container).some(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '刷新版本树布局'), 'layout refresh must not remain as an always-visible toolbar button');
  let nodeContextEvent;
  await React.act(async () => { nodeContextEvent = dispatch(rawCanvasNode, 'contextmenu', { clientX: 100, clientY: 100 }); });
  assert(nodeContextEvent.defaultPrevented && nodeContextEvent.cancelBubble, 'node context menus must not bubble to the blank canvas');
  const trackedInputPort = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '断开 Tracked 的输入连接');
  assert(trackedInputPort, 'connected nodes must expose a left-side disconnect control');
  assert((trackedInputPort.attributes.get('class') || '').includes('h-5') && (trackedInputPort.attributes.get('class') || '').includes('w-5'), 'relation port hit targets must be at least 20px');
  assert((trackedInputPort.attributes.get('class') || '').includes('group-focus-within/version-node:opacity-100'), 'node keyboard focus must reveal relation ports');
  const trackedInputDot = trackedInputPort.childNodes.find(node => node.nodeName === 'SPAN');
  assert((trackedInputDot?.attributes.get('class') || '').includes('h-2.5') && (trackedInputDot?.attributes.get('class') || '').includes('w-2.5'), 'relation port visible dots must remain 10px');
  assert(!allNodes(rawCanvasNode).some(node => node.nodeName === 'BUTTON' && (node.attributes.get('aria-label') || '').includes('输入连接')), 'original nodes must not expose a disconnect port');
  assert(allNodes(container).some(node => node.nodeName === 'BUTTON' && node.attributes.get('data-relation-parent-id') === 'raw'), 'eligible original nodes must expose an output port');
  assert(allNodes(container).some(node => node.nodeName === 'BUTTON' && node.attributes.get('data-relation-parent-id') === 'selection'), 'selection nodes must expose an output port for workflow_input');
  assert(allNodes(container).some(node => node.nodeName === 'BUTTON' && node.attributes.get('data-relation-parent-id') === 'workflow'), 'workflow nodes must expose legal workflow output ports');
  assert(allNodes(container).some(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '断开 Camera JPG 的输入连接'), 'connected artifact nodes must expose supplemental disconnect controls');
  assert(!allNodes(container).some(node => node.nodeName === 'BUTTON' && node.attributes.get('data-relation-parent-id') === 'camera-jpg'), 'artifact nodes must not pretend to be legal relation sources');
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, hoverParentId: 'tracked' })));
  const invalidCandidate = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('data-relation-parent-id') === 'tracked');
  assert.strictEqual(invalidCandidate?.attributes.get('title'), '节点不能连接到自己', 'invalid candidates must expose the concrete validation reason');
  assert((invalidCandidate?.childNodes.find(node => node.nodeName === 'SPAN')?.attributes.get('class') || '').includes('bg-red-600'), 'hovered invalid candidates must turn red');
  assert(allNodes(invalidCandidate).some(node => node.attributes?.get('role') === 'tooltip' && node.textContent === '节点不能连接到自己'), 'hovered invalid candidates must render a visible reason tooltip');
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, pendingChildId: undefined, hoverParentId: undefined })));
  const freeInputPort = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '断开 Free 的输入连接');
  const requestsBeforeDisconnect = relationRequests.length;
  await React.act(async () => dispatch(freeInputPort, 'pointerdown', { pointerId: 45, button: 0 }));
  assert.deepStrictEqual(relationRequests[requestsBeforeDisconnect], { childProgressId: 'free', parentProgressId: null }, 'left-side clicks must request disconnection instead of starting a new line');
  assert(!canvasNode.attributes.has('data-drag-state'), 'left-side disconnect controls must never enter relation dragging');
  const trackedOutputPort = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '从 Tracked 拖出连接');
  const otherTarget = allNodes(container).find(node => node.attributes.get('data-version-output-target-key') === 'entry:other');
  assert(trackedOutputPort && otherTarget, 'progress output ports and ordinary folder targets must both mount');
  elementAtPoint = otherTarget;
  await React.act(async () => {
    dispatch(trackedOutputPort, 'pointerdown', { pointerId: 46, button: 0, clientX: 300, clientY: 200 });
    dispatch(trackedOutputPort, 'pointermove', { pointerId: 46, button: 0, clientX: 600, clientY: 600 });
  });
  assert.strictEqual(canvasNode.attributes.get('data-drag-state'), 'create-version', 'right-side progress dragging must claim the shared canvas drag state');
  await React.act(async () => {
    dispatch(rawCanvasNode, 'pointerdown', { pointerId: 47, button: 0, clientX: 700, clientY: 600 });
    dispatch(rawCanvasNode, 'pointermove', { pointerId: 47, button: 0, clientX: 800, clientY: 700 });
    dispatch(rawCanvasNode, 'pointerup', { pointerId: 47, button: 0, clientX: 800, clientY: 700 });
  });
  await React.act(async () => dispatch(trackedOutputPort, 'pointerup', { pointerId: 46, button: 0, clientX: 600, clientY: 600 }));
  assert.deepStrictEqual(createVersionRequests.at(-1), { sourceId: 'tracked', targetName: 'Other' }, 'dropping a progress output on an ordinary folder must request the next-version setup');
  assert(!canvasNode.attributes.has('data-drag-state'), 'finishing next-version dragging must release the shared drag state');
  elementAtPoint = null;
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, treeProps)));
  const freeEdge = allNodes(container).find(node => node.nodeName === 'path' && (node.attributes.get('data-edge-id') || '').includes(':free:'));
  assert(freeEdge, 'main relation must expose a hit path');
  let edgeContextEvent;
  await React.act(async () => { edgeContextEvent = dispatch(freeEdge, 'contextmenu', { clientX: 100, clientY: 100 }); });
  assert(edgeContextEvent.defaultPrevented && edgeContextEvent.cancelBubble, 'edge context menus must not bubble to the blank canvas');
  assert(textContent(container).includes('起点：RAW') && textContent(container).includes('终点：Free'), 'right-clicking a line must select it and expose the delete menu');
  assert.strictEqual(freeEdge.attributes.get('stroke-width'), '14', 'edge hit targets must stay within the 12-16px interaction width');
  const arrowedMainEdge = allNodes(container).find(node => node.nodeName === 'path' && node.attributes.get('data-relation-kind') === 'main' && node.attributes.has('marker-end'));
  assert(arrowedMainEdge, 'visible relations must render below nodes with a parent-to-child arrow marker');
  await React.act(async () => dispatch(freeEdge, 'click'));
  assert(textContent(container).includes('起点：RAW') && textContent(container).includes('终点：Free') && textContent(container).includes('类型：版本关系'), 'clicking a line must show its relation details');
  assert.strictEqual(freeEdge.attributes.get('data-relation-kind'), 'main', 'selection highlighting must not change the relation kind');
  assert(allNodes(container).some(node => node.nodeName === 'circle' && node.attributes.get('data-edge-child-handle') === 'free'), 'selected line must expose a draggable child endpoint');
  const deleteButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '删除关系');
  assert(deleteButton && !deleteButton.attributes.has('disabled') && deleteButton.disabled !== true, 'untracked progress relation must be deletable');
  await React.act(async () => dispatch(testWindow, 'keydown', { key: 'Backspace', target: testDocument.body }));
  await React.act(async () => dispatch(testWindow, 'keydown', { key: 'Delete', target: testDocument.body }));
  assert.deepStrictEqual(relationRequests.slice(-2), [{ childProgressId: 'free', parentProgressId: null }, { childProgressId: 'free', parentProgressId: null }], 'Delete and Backspace must both request validated relation removal');
  const selectionEdge = allNodes(container).find(node => node.nodeName === 'path' && (node.attributes.get('data-edge-id') || '').includes(':selection:'));
  assert(selectionEdge, 'auxiliary relation must expose a hit path');
  await React.act(async () => dispatch(selectionEdge, 'click'));
  const selectionDelete = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '删除关系');
  assert(selectionDelete && (selectionDelete.attributes.has('disabled') || selectionDelete.disabled === true), 'selection relation must not be deletable');
  assert(textContent(container).includes('选片关系只能更换来源'), 'selection relation must explain its replacement-only rule');
  const requestsBeforeBlockedDelete = relationRequests.length;
  await React.act(async () => dispatch(testWindow, 'keydown', { key: 'Backspace', target: testDocument.body }));
  assert.strictEqual(relationRequests.length, requestsBeforeBlockedDelete, 'selection removal must remain blocked by progressRelationChangeError');

  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, treeProps)));
  const previewEdge = allNodes(container).find(node => node.nodeName === 'path' && node.attributes.get('data-edge-id') === 'preview-edge');
  const companionEdge = allNodes(container).find(node => node.nodeName === 'path' && node.attributes.get('data-edge-id') === 'companion-edge');
  assert.strictEqual(previewEdge?.attributes.get('aria-label'), '选择预览产物关系线');
  assert.strictEqual(companionEdge?.attributes.get('aria-label'), '选择配套素材关系线');
  const visiblePreviewEdge = allNodes(container).find(node => node.nodeName === 'path' && node.attributes.get('data-relation-kind') === 'derived_preview' && node.attributes.get('aria-hidden') === 'true');
  const visibleCompanionEdge = allNodes(container).find(node => node.nodeName === 'path' && node.attributes.get('data-relation-kind') === 'media_companion' && node.attributes.get('aria-hidden') === 'true');
  assert(!visiblePreviewEdge.attributes.has('stroke-dasharray') && !visibleCompanionEdge.attributes.has('stroke-dasharray') && !arrowedMainEdge.attributes.has('stroke-dasharray'), 'all persisted graph relations must be solid');
  assert(!visiblePreviewEdge.attributes.has('marker-end') && !visibleCompanionEdge.attributes.has('marker-end'), 'preview and companion associations must not render arrowheads');
  assert(visiblePreviewEdge.attributes.get('d').includes(' L ') && visibleCompanionEdge.attributes.get('d').includes(' L '), 'preview and companion associations must render as straight lines');
  await React.act(async () => dispatch(companionEdge, 'click'));
  assert(textContent(container).includes('类型：配套素材'), 'supplemental relation details must show the real edge type');
  const companionDeleteButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '删除关系');
  assert((companionDeleteButton.attributes.get('title') || '').includes('删除配套素材关系'));
  await React.act(async () => dispatch(companionDeleteButton, 'click'));
  assert.strictEqual(supplementalDeletes.at(-1).id, 'companion-edge', 'companion deletion must submit the persisted edge identity');

  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, graphEdges: treeProps.graphEdges.filter(edge => edge.id !== 'companion-edge') })));
  const emptyCompanionInput = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === 'Camera JPG 等待输入连接');
  const rawOutput = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '从 RAW 拖出连接');
  const cameraTarget = allNodes(container).find(node => node.attributes.get('data-version-progress-id') === 'camera-jpg');
  assert(emptyCompanionInput && rawOutput && cameraTarget, 'disconnecting a companion relation must leave a reconnectable empty input and source output');
  elementAtPoint = cameraTarget;
  await React.act(async () => {
    dispatch(rawOutput, 'pointerdown', { pointerId: 48, button: 0, clientX: 100, clientY: 100 });
    dispatch(rawOutput, 'pointermove', { pointerId: 48, button: 0, clientX: 400, clientY: 300 });
    dispatch(rawOutput, 'pointerup', { pointerId: 48, button: 0, clientX: 400, clientY: 300 });
  });
  assert.deepStrictEqual(supplementalCreates.at(-1), { sourceProgressId: 'raw', targetProgressId: 'camera-jpg', edgeKind: 'media_companion' }, 'RAW must reconnect JPG from the right output after a disconnect');
  elementAtPoint = null;

  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, graphEdges: [] })));
  const previewInput = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === 'generated JPG artifact 等待输入连接');
  const previewTarget = allNodes(container).find(node => node.attributes.get('data-version-progress-id') === 'generated');
  const refreshedRawOutput = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '从 RAW 拖出连接');
  assert(previewInput && previewTarget && refreshedRawOutput, 'disconnecting a preview relation must preserve both legal endpoints');
  elementAtPoint = previewTarget;
  await React.act(async () => {
    dispatch(refreshedRawOutput, 'pointerdown', { pointerId: 49, button: 0, clientX: 100, clientY: 100 });
    dispatch(refreshedRawOutput, 'pointerup', { pointerId: 49, button: 0, clientX: 450, clientY: 320 });
  });
  assert.deepStrictEqual(supplementalCreates.at(-1), { sourceProgressId: 'raw', targetProgressId: 'generated', edgeKind: 'derived_preview' }, 'MOV/RAW preview artifacts must be reconnectable from the source output');

  const submissionsBeforeIllegal = supplementalCreates.length + relationRequests.length;
  const selectionOutput = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '从 RAW_选片 拖出连接');
  elementAtPoint = previewTarget;
  await React.act(async () => {
    dispatch(selectionOutput, 'pointerdown', { pointerId: 50, button: 0, clientX: 100, clientY: 100 });
    dispatch(selectionOutput, 'pointerup', { pointerId: 50, button: 0, clientX: 450, clientY: 320 });
  });
  assert.strictEqual(supplementalCreates.length + relationRequests.length, submissionsBeforeIllegal, 'an incompatible source must never create a relation');

  const ambiguousTarget = allNodes(container).find(node => node.attributes.get('data-version-progress-id') === 'ambiguous-artifact');
  elementAtPoint = ambiguousTarget;
  await React.act(async () => {
    dispatch(refreshedRawOutput, 'pointerdown', { pointerId: 51, button: 0, clientX: 100, clientY: 100 });
    dispatch(refreshedRawOutput, 'pointerup', { pointerId: 51, button: 0, clientX: 500, clientY: 350 });
  });
  assert(textContent(container).includes('选择关系类型'), 'multiple compatible relation kinds must open an explicit chooser');
  const typeButtons = allNodes(container).filter(node => node.nodeName === 'BUTTON' && (node.textContent === '配套素材' || node.textContent === '预览产物'));
  assert.deepStrictEqual(typeButtons.map(node => node.textContent), ['配套素材', '预览产物']);
  await React.act(async () => dispatch(typeButtons[1], 'click'));
  assert.deepStrictEqual(supplementalCreates.at(-1), { sourceProgressId: 'raw', targetProgressId: 'ambiguous-artifact', edgeKind: 'derived_preview' });
  elementAtPoint = null;

  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, pendingChildId: 'free', mutatingChildIds: ['free'] })));
  const busyPort = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '断开 Free 的输入连接');
  assert(busyPort && (busyPort.attributes.has('disabled') || busyPort.disabled === true), 'busy child relation port must be disabled');
  assert(!allNodes(container).some(node => node.nodeName === 'circle' && node.attributes.get('data-edge-child-handle') === 'free'), 'busy child endpoint must not remain draggable');

  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, selectedRelativePaths: ['Tracked', 'Other'] })));
  const selectedOtherNode = allNodes(container).find(node => node.attributes.get('data-version-output-target-key') === 'entry:other');
  const savesBeforeMixedGroupMove = layoutRequests.saves.length;
  await React.act(async () => {
    dispatch(selectedOtherNode, 'pointerdown', { pointerId: 58, button: 0, clientX: 100, clientY: 100 });
    dispatch(selectedOtherNode, 'pointermove', { pointerId: 58, button: 0, clientX: 180, clientY: 180 });
    dispatch(selectedOtherNode, 'pointerup', { pointerId: 58, button: 0, clientX: 180, clientY: 180 });
    await Promise.resolve(); await Promise.resolve();
  });
  assert.strictEqual(layoutRequests.saves.length, savesBeforeMixedGroupMove + 1, 'a mixed selection of version and Other folders must save as one group move');
  assert.deepStrictEqual(new Set(layoutRequests.saves.at(-1).positions.map(position => position.nodeKey)), new Set(['progress:tracked', 'entry:other']), 'Other folders must use the same multi-select movement layer as registered version folders');

  const thousandFolders = Array.from({ length: 1000 }, (_value, index) => ({ kind: 'folder', name: `Candidate ${index}`, relativePath: `Candidate ${index}`, path: `C:/p/Candidate ${index}`, extension: '', size: 0, createdAt: 20 + index, updatedAt: 20 + index }));
  await React.act(async () => root.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, entries: [...entries, ...thousandFolders], structureEntries: [...entries, ...thousandFolders], pendingChildId: undefined })));
  const renderedCandidates = allNodes(container).filter(node => String(node.attributes?.get('data-version-output-target-key') || '').startsWith('entry:candidate '));
  assert(renderedCandidates.length > 0 && renderedCandidates.length < 120, 'a thousand candidate folders must be viewport-virtualized instead of mounting one thousand rich nodes');

  let repairRequest;
  let keepIndependentRequest;
  await React.act(async () => root.render(React.createElement(legacyRepairNotice.LegacySelectionRepairNotice, {
    repairs: [{ progressId: 'legacy', projectId: 'p', legacyName: '图片选片', expectedSourceName: 'RAW', reason: 'selection_already_exists', candidateIds: ['selection'] }],
    folders: [folders[0], { ...selection, id: 'selection', parentProgressId: 'raw' }, { ...selection, id: 'legacy', displayName: '图片选片', nodeRole: 'original', parentProgressId: undefined, relationKind: undefined }],
    onRepair: (progressId, sourceProgressId) => { repairRequest = { progressId, sourceProgressId }; },
    onKeepIndependent: progressId => { keepIndependentRequest = progressId; },
  })));
  assert(textContent(container).includes('已经存在现代选片节点') && textContent(container).includes('不能静默覆盖或删除'), 'coexisting selections must show an explicit warning');
  const repairButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '确认修复关系');
  const keepIndependentButton = allNodes(container).find(node => node.nodeName === 'BUTTON' && node.textContent === '保留为独立节点');
  await React.act(async () => dispatch(keepIndependentButton, 'click'));
  assert.strictEqual(keepIndependentRequest, 'legacy', 'legacy repair UI must allow an explicit independent-node resolution');
  await React.act(async () => dispatch(repairButton, 'click'));
  assert.deepStrictEqual(repairRequest, { progressId: 'legacy', sourceProgressId: 'raw' }, 'repair UI must submit only project node IDs');
  await React.act(async () => root.unmount());

  const pageAContainer = new TestNode(1, 'DIV', testDocument);
  const pageBContainer = new TestNode(1, 'DIV', testDocument);
  const pageCContainer = new TestNode(1, 'DIV', testDocument);
  const pageARoot = createRoot(pageAContainer);
  const pageBRoot = createRoot(pageBContainer);
  const pageCRoot = createRoot(pageCContainer);
  const pageANotices = [];
  const pageBNotices = [];
  await React.act(async () => {
    pageARoot.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, pendingChildId: undefined, projectName: 'Page A', onNotice: message => pageANotices.push(message) }));
    pageBRoot.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, pendingChildId: undefined, projectName: 'Page B', onNotice: message => pageBNotices.push(message) }));
    pageCRoot.render(React.createElement(tree.ProjectVersionTree, { ...treeProps, pendingChildId: undefined, projectName: 'Page C', onNotice() {} }));
    await Promise.resolve(); await Promise.resolve();
  });
  const pageACanvas = allNodes(pageAContainer).find(node => node.attributes?.get('data-version-tree-canvas') === 'true');
  const pageBCanvas = allNodes(pageBContainer).find(node => node.attributes?.get('data-version-tree-canvas') === 'true');
  const pageANode = allNodes(pageAContainer).find(node => node.attributes?.get('data-node-role') === 'original');
  const pageCCreateVersionPort = allNodes(pageCContainer).find(node => node.nodeName === 'BUTTON' && node.attributes.get('aria-label') === '从 Free 拖出连接');
  layoutRequests.holdSaves = true;
  const savesBeforeUnmountQueue = layoutRequests.saves.length;
  await React.act(async () => {
    dispatch(pageANode, 'pointerdown', { pointerId: 61, button: 0, clientX: 100, clientY: 100 });
    dispatch(pageANode, 'pointermove', { pointerId: 61, button: 0, clientX: 180, clientY: 180 });
    dispatch(pageANode, 'pointerup', { pointerId: 61, button: 0, clientX: 180, clientY: 180 });
    await Promise.resolve(); await Promise.resolve();
    dispatch(pageANode, 'pointerdown', { pointerId: 62, button: 0, clientX: 180, clientY: 180 });
    dispatch(pageANode, 'pointermove', { pointerId: 62, button: 0, clientX: 240, clientY: 240 });
    dispatch(pageANode, 'pointerup', { pointerId: 62, button: 0, clientX: 240, clientY: 240 });
    dispatch(pageANode, 'pointerdown', { pointerId: 63, button: 0, clientX: 240, clientY: 240 });
    dispatch(pageBCanvas, 'pointerdown', { pointerId: 64, button: 1, clientX: 200, clientY: 200 });
    dispatch(pageCCreateVersionPort, 'pointerdown', { pointerId: 65, button: 0, clientX: 200, clientY: 200 });
  });
  assert.strictEqual(layoutRequests.saves.length, savesBeforeUnmountQueue + 1, 'only the started save may reach IPC while the next save remains queued');
  assert.strictEqual(pageACanvas.attributes.get('data-drag-state'), 'node');
  assert.strictEqual(pageBCanvas.attributes.get('data-drag-state'), 'pan', 'two mounted pages must keep independent drag state');
  assert(!pageANode.hasPointerCapture(63) && pageBCanvas.hasPointerCapture(64) && pageCCreateVersionPort.hasPointerCapture(65), 'an unmoved node must leave pointer ownership with its clickable folder, while active canvas and next-version drags own capture');
  const noticesBeforeUnmount = pageANotices.length + pageBNotices.length;
  await React.act(async () => { pageARoot.unmount(); pageBRoot.unmount(); pageCRoot.unmount(); });
  assert(!pageANode.hasPointerCapture(63) && !pageBCanvas.hasPointerCapture(64) && !pageCCreateVersionPort.hasPointerCapture(65), 'unmount must release node, canvas, and next-version pointer capture');
  layoutRequests.holdSaves = false;
  layoutRequests.saveReleases.splice(0).forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(layoutRequests.saves.length, savesBeforeUnmountQueue + 1, 'a save queued behind an in-flight request must not call IPC after unmount');
  assert.strictEqual(pageANotices.length + pageBNotices.length, noticesBeforeUnmount, 'in-flight save completion must not notify an unmounted page');

  const disposableQueue = new mutationQueue.ProgressRelationMutationQueue();
  const queueGeneration = disposableQueue.captureGeneration();
  let releaseRunningMutation;
  const mutationGate = new Promise(resolve => { releaseRunningMutation = resolve; });
  let queuedMutationStarted = false;
  let staleReactUpdate = false;
  const runningMutation = disposableQueue.enqueue('child', async () => { await mutationGate; return true; });
  const queuedMutation = disposableQueue.enqueue('child', async () => { queuedMutationStarted = true; });
  const runningMutationRejected = assert.rejects(runningMutation, /disposed/);
  const queuedMutationRejected = assert.rejects(queuedMutation, /disposed/);
  await new Promise(resolve => setImmediate(resolve));
  disposableQueue.dispose();
  disposableQueue.runIfCurrent(queueGeneration, () => { staleReactUpdate = true; });
  releaseRunningMutation();
  await Promise.all([runningMutationRejected, queuedMutationRejected]);
  assert.strictEqual(queuedMutationStarted, false, 'disposed mutation queues must not start queued work');
  assert.strictEqual(staleReactUpdate, false, 'disposed page generations must not update React state');
  const independentQueue = new mutationQueue.ProgressRelationMutationQueue();
  let independentMutationRan = false;
  await independentQueue.enqueue('child', async () => { independentMutationRan = true; });
  assert(independentMutationRan, 'disposing one page mutation queue must not affect another page');
  console.log('versioning V2 panels real mount tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
