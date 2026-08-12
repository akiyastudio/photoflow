const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const project = (overrides = {}) => ({
  id: 'project-1',
  name: '项目一',
  path: 'C:/workspace/project-one',
  status: '策划中',
  updatedAt: 1,
  ...overrides,
});

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'app', 'workspace-tab-model.ts')).href);
  const initialRootState = model.selectProjectFromSidebar(model.EMPTY_WORKSPACE_TABS, project(), 'initial-root');
  assert.strictEqual(initialRootState.pages.length, 1, 'sidebar click must create a root page when the project has no pages');
  assert.strictEqual(initialRootState.pages[0].currentRelativePath, '');
  assert.strictEqual(initialRootState.pages[0].initialRelativePath, '');
  assert.strictEqual(model.updateBrowserPagePath(initialRootState, 'initial-root', ''), initialRootState, 'reporting the current page path again must preserve state identity and cannot trigger a render loop');
  assert.strictEqual(model.updateBrowserPagePath(initialRootState, 'missing-page', 'ignored'), initialRootState, 'a stale page notification must preserve state identity');
  const navigatedInitialRootState = model.updateBrowserPagePath(initialRootState, 'initial-root', '选片');
  const reopenedRootState = model.selectProjectFromSidebar(navigatedInitialRootState, project(), 'replacement-root');
  assert.strictEqual(reopenedRootState.pages.length, 2, 'a page initially opened at root must not be reused after it navigates into a child folder');
  assert.strictEqual(reopenedRootState.activePageId, 'replacement-root');
  assert.strictEqual(reopenedRootState.pages.find(page => page.id === 'replacement-root').currentRelativePath, '');
  let state = model.EMPTY_WORKSPACE_TABS;
  state = model.createBrowserPage(state, { id: 'page-child', kind: 'project', projectId: 'project-1', project: project(), currentRelativePath: '选片', initialRelativePath: '选片', operation: null });
  state = model.createBrowserPage(state, { id: 'page-child-2', kind: 'project', projectId: 'project-1', project: project(), currentRelativePath: '精修', initialRelativePath: '精修', operation: 'match' });
  assert.strictEqual(state.pages.length, 2);
  assert.notStrictEqual(state.pages[0].id, state.pages[1].id, 'one project must support multiple page instance ids');
  assert(state.pages.every(page => page.projectId === 'project-1'));
  state = model.activateBrowserPage(state, 'page-child');
  assert.strictEqual(state.activePageId, 'page-child');

  state = model.selectProjectFromSidebar(state, project(), 'page-root');
  assert.strictEqual(state.pages.length, 3, 'sidebar click must create a root page when only child pages exist');
  assert.strictEqual(state.activePageId, 'page-root');
  state = model.selectProjectFromSidebar(state, project(), 'unused-page');
  assert.strictEqual(state.pages.length, 3, 'sidebar click must reuse an existing root page');
  assert.strictEqual(state.activePageId, 'page-root');

  state = model.updateBrowserPagePath(state, 'page-root', '交付');
  state = model.updateBrowserPagePath(state, 'page-child-2', '');
  state = model.selectProjectFromSidebar(state, project(), 'unused-returned-root');
  assert.strictEqual(state.pages.length, 3, 'a child page that later navigates to root must be reused');
  assert.strictEqual(state.activePageId, 'page-child-2');

  state = model.updateBrowserPagePath(state, 'page-child', '选片/第一组');
  assert.strictEqual(state.pages.find(page => page.id === 'page-child').currentRelativePath, '选片/第一组');
  const renamed = project({ name: '项目一（已改名）', path: 'D:/archive/project-one', updatedAt: 2 });
  const pageCountBeforeRename = state.pages.length;
  const activePageBeforeRename = state.activePageId;
  const pathsBeforeRename = state.pages.map(page => [page.id, page.currentRelativePath]);
  state = model.updateProjectPages(state, renamed);
  assert(state.pages.every(page => page.project === renamed), 'project metadata updates must reach every page with the same project id');
  assert.strictEqual(state.pages.length, pageCountBeforeRename, 'project metadata updates must not create a root page');
  assert.strictEqual(state.activePageId, activePageBeforeRename, 'project metadata updates must preserve the active page');
  assert.deepStrictEqual(state.pages.map(page => [page.id, page.currentRelativePath]), pathsBeforeRename, 'project metadata updates must preserve every current directory');

  state = model.closeBrowserPage(state, 'page-child');
  assert.strictEqual(state.pages.length, 2);
  assert(state.pages.some(page => page.id === 'page-child-2'), 'closing one page must preserve sibling pages from the same project');
  state = model.closeProjectPages(state, 'project-1');
  assert.deepStrictEqual(state, { pages: [], activePageId: null });
  const duplicatePage = { id: 'duplicate', kind: 'project', projectId: 'project-1', project: project(), currentRelativePath: '', initialRelativePath: '', operation: null };
  const onePage = model.createBrowserPage(state, duplicatePage);
  assert.throws(() => model.createBrowserPage(onePage, duplicatePage), /Duplicate browser page id/);

  let inspirationState = model.selectInspirationPath(model.EMPTY_WORKSPACE_TABS, 'C:/inspiration', '', 'inspiration-root');
  inspirationState = model.selectInspirationPath(inspirationState, 'C:/inspiration', 'weddings', 'inspiration-weddings');
  inspirationState = model.selectInspirationPath(inspirationState, 'C:/inspiration', 'portraits', 'inspiration-portraits');
  assert.strictEqual(inspirationState.pages.length, 3, 'root and two inspiration folders must coexist as independent pages');
  inspirationState = model.selectInspirationPath(inspirationState, 'C:/inspiration', 'weddings', 'unused-inspiration');
  assert.strictEqual(inspirationState.pages.length, 3, 'requesting an existing inspiration path must reuse its page');
  assert.strictEqual(inspirationState.activePageId, 'inspiration-weddings');
  inspirationState = model.updateBrowserPagePath(inspirationState, 'inspiration-weddings', 'weddings/detail');
  assert.strictEqual(inspirationState.pages.find(page => page.id === 'inspiration-portraits').currentRelativePath, 'portraits', 'one inspiration page navigation must not affect siblings');
  let pinnedNavigatedState = model.selectInspirationPath(model.EMPTY_WORKSPACE_TABS, 'C:/inspiration', '', 'pinned-navigated-root');
  pinnedNavigatedState = model.updateBrowserPagePath(pinnedNavigatedState, 'pinned-navigated-root', 'weddings');
  const ensuredPinnedState = model.ensureInspirationRootPage(pinnedNavigatedState, 'C:/inspiration', 'must-not-be-created');
  assert.strictEqual(ensuredPinnedState.pages.length, 1, 'navigating a pinned inspiration tab must not cause a replacement root tab to be auto-created');
  assert.strictEqual(ensuredPinnedState.pages[0].currentRelativePath, 'weddings');
  inspirationState = model.replaceInspirationRootPages(inspirationState, 'D:/new-inspiration', true, 'new-root');
  assert.strictEqual(inspirationState.pages.length, 1, 'changing roots must remove every page that points at the old root');
  assert.strictEqual(inspirationState.pages[0].inspirationRootPath, 'D:/new-inspiration');
  assert.strictEqual(inspirationState.pages[0].currentRelativePath, '');
  let mixedState = model.createBrowserPage(model.EMPTY_WORKSPACE_TABS, { id: 'active-project', kind: 'project', projectId: 'project-1', project: project(), currentRelativePath: '', initialRelativePath: '', operation: null });
  mixedState = model.replaceInspirationRootPages(mixedState, 'D:/new-inspiration', true, 'pinned-root');
  assert.strictEqual(mixedState.activePageId, 'active-project', 'pinning an inspiration root must not steal focus from an active project page');
  const afterDeletingActiveProject = model.closeProjectPages(mixedState, 'project-1');
  const activeAfterProjectDelete = afterDeletingActiveProject.pages.find(page => page.id === afterDeletingActiveProject.activePageId);
  assert.strictEqual(afterDeletingActiveProject.activePageId, 'pinned-root', 'deleting the active project must leave the inspiration page active in the tab model');
  assert.deepStrictEqual(
    model.browserPageActivation(activeAfterProjectDelete),
    { activeTab: 'inspiration', selectedProject: null, projectDestination: null },
    'deleting the active project while inspiration remains must switch the app view to inspiration and clear project selection',
  );

  const titlebarOrder = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'app', 'useTitlebarTabOrder.ts')).href);
  const toolTabs = [
    { ownerPageId: 'version-owner', projectPath: 'C:\\workspace\\project-one', kind: 'version' },
    { ownerPageId: 'team-owner', projectPath: 'D:\\archive\\project-two', kind: 'team' },
  ];
  assert.strictEqual(titlebarOrder.migrateLegacyWorkspaceToolTabId('project-tool:version:C:\\workspace\\project-one', toolTabs), 'project-tool:version:version-owner');
  assert.strictEqual(titlebarOrder.migrateLegacyWorkspaceToolTabId('project-tool:team:D:\\archive\\project-two', toolTabs), 'project-tool:team:team-owner');
  assert.strictEqual(titlebarOrder.migrateLegacyWorkspaceToolTabId('project-tool:version:version-owner', toolTabs), 'project-tool:version:version-owner', 'new owner-page ids must not be migrated again');
  assert.strictEqual(titlebarOrder.migrateLegacyWorkspaceToolTabId('project-tool:team:E:\\missing', toolTabs), 'project-tool:team:E:\\missing', 'unmatched legacy ids must be preserved');

  let closeToProject = model.createBrowserPage(model.EMPTY_WORKSPACE_TABS, { id: 'closing-project', kind: 'project', projectId: 'project-1', project: project(), currentRelativePath: '', initialRelativePath: '', operation: null });
  closeToProject = model.createBrowserPage(closeToProject, { id: 'neighbor-project', kind: 'project', projectId: 'project-2', project: project({ id: 'project-2' }), currentRelativePath: '', initialRelativePath: '', operation: null });
  closeToProject = model.activateBrowserPage(closeToProject, 'closing-project');
  assert.strictEqual(model.closeBrowserPage(closeToProject, 'closing-project').activePageId, 'neighbor-project', 'closing an active project page must select the adjacent project page');

  let closeToInspiration = model.createBrowserPage(model.EMPTY_WORKSPACE_TABS, { id: 'closing-project', kind: 'project', projectId: 'project-1', project: project(), currentRelativePath: '', initialRelativePath: '', operation: null });
  closeToInspiration = model.createBrowserPage(closeToInspiration, { id: 'neighbor-inspiration', kind: 'inspiration', projectId: 'inspiration:C:/inspiration', project: null, inspirationRootPath: 'C:/inspiration', currentRelativePath: '', initialRelativePath: '', operation: null });
  closeToInspiration = model.activateBrowserPage(closeToInspiration, 'closing-project');
  assert.strictEqual(model.closeBrowserPage(closeToInspiration, 'closing-project').activePageId, 'neighbor-inspiration', 'closing an active project page must select the adjacent inspiration page');

  const closeToHome = model.closeBrowserPage(model.createBrowserPage(model.EMPTY_WORKSPACE_TABS, { id: 'only-project', kind: 'project', projectId: 'project-1', project: project(), currentRelativePath: '', initialRelativePath: '', operation: null }), 'only-project');
  assert.deepStrictEqual(closeToHome, model.EMPTY_WORKSPACE_TABS, 'home is used only after the last browser page closes');
  assert.deepStrictEqual(model.browserPageActivation(undefined), { activeTab: 'home', selectedProject: null, projectDestination: null }, 'home must only be selected when no browser page remains');
  console.log('Workspace tab model tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
