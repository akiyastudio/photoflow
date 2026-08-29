const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const main = read('src/main.tsx');
const app = read('src/App.tsx');
const taskCenter = read('src/features/background-tasks/TaskCenter.tsx');
const taskStatus = read('src/components/TaskStatus.tsx');
const toolViews = read('src/features/tools/ToolViews.tsx');
const indicator = read('src/features/background-tasks/BackgroundTaskIndicator.tsx');
const fileTransferToast = read('src/features/background-tasks/FileTransferToast.tsx');
const toastModelSource = read('src/features/background-tasks/task-toast-model.ts');
const topToastStack = read('src/features/app/useTopToastStack.tsx');
const topToastNoticeModelSource = read('src/features/app/top-toast-notice-model.ts');
const projectPanelLifecycleSource = read('src/features/workspace/project-panel-lifecycle.ts');
const panelTaskSessionModelSource = read('src/features/background-tasks/panel-task-session-model.ts');
const workspace = read('src/features/workspace/ProjectWorkspace.tsx');
const projectToolModal = read('src/features/workspace/ProjectToolModal.tsx');
const projectVersionTree = read('src/components/ProjectVersionTree.tsx');
const trackingConfirmation = read('src/features/versioning/TrackingConfirmationPanel.tsx');
const versionManager = read('src/components/VersionManager.tsx');
const videoToolsUi = read('extensions/video-tools/ui/app.js');

const compiledFileTransferToast = ts.transpileModule(fileTransferToast, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

const compiledToastModel = ts.transpileModule(toastModelSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const toastModelModule = { exports: {} };
new Function('module', 'exports', 'require', compiledToastModel)(toastModelModule, toastModelModule.exports, require);
const {
  isActiveProjectFileTask,
  isPointerInsideTaskIndicator,
  mergeBackgroundTaskSnapshots,
  pruneFinishedTaskToastIds,
  selectProjectFileTaskToasts,
  setTaskToastMinimized,
} = toastModelModule.exports;
const compiledProjectPanelLifecycle = ts.transpileModule(projectPanelLifecycleSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const projectPanelLifecycleModule = { exports: {} };
new Function('module', 'exports', 'require', compiledProjectPanelLifecycle)(projectPanelLifecycleModule, projectPanelLifecycleModule.exports, require);
const { converterTriggerAction } = projectPanelLifecycleModule.exports;
const compiledPanelTaskSessionModel = ts.transpileModule(panelTaskSessionModelSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const panelTaskSessionModelModule = { exports: {} };
new Function('module', 'exports', compiledPanelTaskSessionModel)(panelTaskSessionModelModule, panelTaskSessionModelModule.exports);
const { isActivePresentedBackgroundTaskForPanel, isPanelTaskRestoreForPage, nextPanelTaskStartedAt, panelTaskRestoreDetail, panelTaskSessionKey, removePanelTasksByOwnerPageId } = panelTaskSessionModelModule.exports;
const compiledTopToastNoticeModel = ts.transpileModule(topToastNoticeModelSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const topToastNoticeModelModule = { exports: {} };
new Function('module', 'exports', compiledTopToastNoticeModel)(topToastNoticeModelModule, topToastNoticeModelModule.exports);
const { enqueueTopToastNotice, MAX_PERSISTENT_NOTICES, removeTopToastNotice } = topToastNoticeModelModule.exports;
const fileTransferToastModule = { exports: {} };
const fileTransferToastRequire = request => {
  if (request === './TaskCenter') return { useTaskCenter: () => { throw new Error('not used by FileTransferToastItem'); } };
  if (request === './task-toast-model') return toastModelModule.exports;
  if (request === '../app/useToastStackReflow') return { useToastStackReflow: () => undefined };
  return require(request);
};
new Function('module', 'exports', 'require', compiledFileTransferToast)(fileTransferToastModule, fileTransferToastModule.exports, fileTransferToastRequire);
const { FileTransferToastItem } = fileTransferToastModule.exports;
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

assert.strictEqual(converterTriggerAction(false, false), 'inspect', 'the first PNG conversion trigger must inspect sources and open the panel');
assert.strictEqual(converterTriggerAction(true, false), 'close', 'an already-open idle converter must toggle closed');
assert.strictEqual(converterTriggerAction(true, true), 'restore', 'an open running converter must remain active');
assert.strictEqual(converterTriggerAction(false, true), 'restore', 'a minimized running converter must be restored without starting another inspection');

assert.equal(nextPanelTaskStartedAt(undefined, 'idle', 100), 0, 'an idle panel must not claim a start time');
assert.equal(nextPanelTaskStartedAt(undefined, 'running', 100), 100, 'the first running report must capture the panel task start time');
assert.equal(nextPanelTaskStartedAt({ state: 'running', startedAt: 100 }, 'running', 200), 100, 'progress reports must preserve the first start time');
assert.equal(nextPanelTaskStartedAt({ state: 'running', startedAt: 100 }, 'completed', 200), 100, 'completion must retain the original start time');
assert.equal(nextPanelTaskStartedAt({ state: 'completed', startedAt: 100 }, 'running', 300), 300, 'a new run using the same panel must receive a new start time');

const presentedPythonTask = (state, ownerPageId = 'page-a', panelKind = 'research') => ({
  state,
  metadata: { presentationOwnerPageId: ownerPageId, presentationPanelKind: panelKind },
});
for (const state of ['queued', 'running', 'pausing', 'paused', 'resuming']) {
  assert(isActivePresentedBackgroundTaskForPanel(presentedPythonTask(state), 'page-a', 'research'), `${state} presented Python tasks must keep their owning panel in background-minimize mode`);
}
for (const state of ['completed', 'failed', 'cancelled', 'interrupted']) {
  assert(!isActivePresentedBackgroundTaskForPanel(presentedPythonTask(state), 'page-a', 'research'), `${state} presented Python tasks must restore the ordinary close control`);
}
assert(!isActivePresentedBackgroundTaskForPanel(presentedPythonTask('running', 'page-b'), 'page-a', 'research'), 'a task from another page must not affect the current panel');
assert(!isActivePresentedBackgroundTaskForPanel(presentedPythonTask('running', 'page-a', 'video-split'), 'page-a', 'research'), 'a task from another panel kind must not affect the current panel');

const makeTask = (id, operation, state, createdAt) => ({ id, type: 'project-file-operation', title: id, state, progress: 0, message: '', cancellable: true, retryable: false, resumable: false, resumeAvailable: false, restartAvailable: false, capabilities: { cancellable: true, pausable: false, resumable: false, retryable: false }, resumePolicy: 'checkpoint', notificationPolicy: 'progress-toast', metadata: { operation }, createdAt, updatedAt: createdAt, startedAt: 0, finishedAt: 0 });
const moveTask = makeTask('move', 'move', 'running', 20);
const trashTask = makeTask('trash', 'trash', 'queued', 10);
const pasteTask = makeTask('paste', 'paste', 'running', 5);
assert(isActiveProjectFileTask(moveTask) && isActiveProjectFileTask(trashTask), 'move and trash project-file operations must be eligible for progress toasts');
assert(!isActiveProjectFileTask(makeTask('done', 'move', 'completed', 1)), 'terminal file tasks must leave the toast stack');
assert.deepStrictEqual(selectProjectFileTaskToasts([trashTask, moveTask, pasteTask], new Set()).visible.map(task => task.id), ['paste', 'move', 'trash'], 'running tasks must precede queued tasks and use creation order within a state');
assert.deepStrictEqual(selectProjectFileTaskToasts([{ ...trashTask, createdAt: 9_600 }], new Set(), 4, 10_000).visible, [], 'short queued waits must not flash a scheduler toast');
assert.deepStrictEqual(selectProjectFileTaskToasts([{ ...trashTask, createdAt: 9_000 }], new Set(), 4, 10_000).visible.map(task => task.id), ['trash'], 'a real queued wait must become visible after the grace period');
const overflowSelection = selectProjectFileTaskToasts(Array.from({ length: 7 }, (_, index) => makeTask(`overflow-${index}`, 'copy', 'running', index)), new Set(), 4, 10_000);
assert.deepStrictEqual(overflowSelection.visible.map(task => task.id), ['overflow-0', 'overflow-1', 'overflow-2', 'overflow-3']);
assert.equal(overflowSelection.overflowCount, 3, 'large task bursts retain four interactive cards and the existing overflow counter');
const retainedRunningTask = { ...moveTask, id: 'long-running', createdAt: 1, updatedAt: 1 };
const completedHistory = Array.from({ length: 205 }, (_, index) => ({ ...makeTask(`done-${index}`, 'copy', 'completed', 1000 - index), updatedAt: 1000 - index }));
const mergedSnapshots = completedHistory.reduce((current, task) => mergeBackgroundTaskSnapshots(current, [task]), [retainedRunningTask]);
assert(mergedSnapshots.some(task => task.id === retainedRunningTask.id), 'the renderer task-history cap must never evict an older active task');
assert.equal(mergedSnapshots.length, 200, 'terminal task history must remain bounded after retaining active tasks');
const copiedFilesMarkup = renderToStaticMarkup(React.createElement(FileTransferToastItem, { task: { ...pasteTask, metadata: { operation: 'paste', filesCopied: 3, totalFiles: 10 } }, onMinimize: () => {} }));
assert(copiedFilesMarkup.includes('3/10 文件'), 'copy-style task metadata must render its actual file count with the file unit');
const processedItemsMarkup = renderToStaticMarkup(React.createElement(FileTransferToastItem, { task: { ...moveTask, metadata: { operation: 'move', processedCount: 3, totalCount: 10 } }, onMinimize: () => {} }));
assert(processedItemsMarkup.includes('3/10 项'), 'move and trash metadata must render its actual processed item count with the generic item unit');
const queuedTrackingMarkup = renderToStaticMarkup(React.createElement(FileTransferToastItem, { task: { ...trashTask, type: 'version-tracking', title: '比较版本跟踪', message: '等待其他文件操作完成，之后自动开始版本比较' }, onMinimize: () => {} }));
assert(queuedTrackingMarkup.includes('等待其他文件操作完成') && queuedTrackingMarkup.includes('完成后自动开始版本比较') && !queuedTrackingMarkup.includes('磁盘任务名额'), 'queued tracking must explain the wait without exposing scheduler terminology');

let minimized = setTaskToastMinimized(new Set(), moveTask.id, true);
assert(minimized.has('move') && !minimized.has('trash'), 'minimizing one toast must not affect another task');
assert.deepStrictEqual(selectProjectFileTaskToasts([moveTask, trashTask], minimized).visible.map(task => task.id), ['trash'], 'a minimized task must leave the visible stack so the next card moves up');
minimized = setTaskToastMinimized(minimized, moveTask.id, false);
assert.deepStrictEqual(selectProjectFileTaskToasts([moveTask, trashTask], minimized).visible.map(task => task.id), ['move', 'trash'], 'restoring a task must return only that toast');
minimized = setTaskToastMinimized(minimized, moveTask.id, true);
minimized = pruneFinishedTaskToastIds(minimized, [{ ...moveTask, state: 'completed' }, trashTask]);
assert(!minimized.has('move'), 'completion must clear the minimized state');

let notices = [];
for (let index = 1; index <= 10; index += 1) {
  notices = enqueueTopToastNotice(notices, { id: index, message: `error-${index}`, persistent: true, count: 1 });
}
assert.strictEqual(notices.length, MAX_PERSISTENT_NOTICES, 'many distinct persistent errors must stay within the explicit queue limit');
assert.deepStrictEqual(notices.map(notice => notice.message), ['error-7', 'error-8', 'error-9', 'error-10'], 'persistent overflow must evict the oldest errors first');
const repeatedId = notices.at(-1).id;
notices = enqueueTopToastNotice(notices, { id: 11, message: 'error-10', persistent: true, count: 1 });
notices = enqueueTopToastNotice(notices, { id: 12, message: 'error-10', persistent: true, count: 1 });
assert.strictEqual(notices.length, MAX_PERSISTENT_NOTICES, 'repeated errors must merge instead of consuming queue capacity');
assert.strictEqual(notices.at(-1).id, repeatedId, 'a repeated error must retain its dismissible toast identity');
assert.strictEqual(notices.at(-1).count, 3, 'a repeated error must expose its occurrence count');
notices = enqueueTopToastNotice(notices, { id: 13, message: 'saved', persistent: false, count: 1 });
assert(notices.some(notice => notice.id === 13), 'a timed notice must coexist with the capped persistent errors');
notices = removeTopToastNotice(notices, 13);
assert(!notices.some(notice => notice.id === 13), 'timer expiry must remove only the expired timed notice');
const nextToastId = notices[1].id;
notices = removeTopToastNotice(notices, notices[0].id);
assert.strictEqual(notices[0].id, nextToastId, 'after the leading toast is dismissed, the following toast must move into its stack position');
assert(topToastStack.includes('dismiss: () => dismiss(id)') && topToastStack.includes('update: value => update(id, value)'), 'typed handles must let callers update or dismiss an activity immediately');

const triggerTarget = {};
const panelTarget = {};
const outsideTarget = {};
const triggerBoundary = { contains: target => target === triggerTarget };
const panelBoundary = { contains: target => target === panelTarget };
assert(isPointerInsideTaskIndicator(triggerBoundary, panelBoundary, triggerTarget), 'pointerdown on the trigger must stay inside the task popover boundary');
assert(isPointerInsideTaskIndicator(triggerBoundary, panelBoundary, panelTarget), 'pointerdown on panel controls must not close the task popover');
assert(!isPointerInsideTaskIndicator(triggerBoundary, panelBoundary, outsideTarget), 'pointerdown elsewhere must close the task popover');

const sharedProjectPath = 'C:\\projects\\shared';
const pageA = { id: 'page-a', projectPath: sharedProjectPath };
const pageB = { id: 'page-b', projectPath: sharedProjectPath };
const panelKind = 'converter';
const panelTasks = new Map([
  [panelTaskSessionKey(pageA.id, panelKind), { ownerPageId: pageA.id, panelKind, state: 'running' }],
  [panelTaskSessionKey(pageB.id, panelKind), { ownerPageId: pageB.id, panelKind, state: 'running' }],
]);
assert.strictEqual(panelTasks.size, 2, 'two pages of the same project must keep independent running sessions for the same panel kind');
let openPanels = { [pageA.id]: panelKind, [pageB.id]: panelKind };
openPanels = { ...openPanels, [pageA.id]: null };
assert.strictEqual(openPanels[pageA.id], null, 'minimizing page A must hide only page A panel');
assert.strictEqual(openPanels[pageB.id], panelKind, 'minimizing page A must not hide page B panel');
openPanels = { ...openPanels, [pageB.id]: null };
const restorePanel = detail => {
  for (const page of [pageA, pageB]) {
    if (isPanelTaskRestoreForPage(page.id, detail)) openPanels = { ...openPanels, [page.id]: detail.panelKind };
  }
};
restorePanel(panelTaskRestoreDetail(pageA.id, panelKind));
assert.deepStrictEqual(openPanels, { [pageA.id]: panelKind, [pageB.id]: null }, 'restoring page A must not restore the same panel on page B');
restorePanel(panelTaskRestoreDetail(pageB.id, panelKind));
assert.deepStrictEqual(openPanels, { [pageA.id]: panelKind, [pageB.id]: panelKind }, 'page B must restore independently after page A');

const inspirationPage = { id: 'inspiration-page' };
const otherProjectPage = { id: 'other-project-page' };
const makeOwnedTask = (page, kind = panelKind) => ({ ownerPageId: page.id, panelKind: kind, state: 'running' });
const initialOwnedTasks = {
  [panelTaskSessionKey(pageA.id, panelKind)]: makeOwnedTask(pageA),
  [panelTaskSessionKey(pageB.id, panelKind)]: makeOwnedTask(pageB),
  [panelTaskSessionKey(inspirationPage.id, 'research')]: makeOwnedTask(inspirationPage, 'research'),
  [panelTaskSessionKey(otherProjectPage.id, 'import')]: makeOwnedTask(otherProjectPage, 'import'),
};
const dismissOwners = (tasks, pageIds) => pageIds.reduce(removePanelTasksByOwnerPageId, tasks);
const afterSingleProjectClose = dismissOwners(initialOwnedTasks, [pageA.id]);
assert(!Object.values(afterSingleProjectClose).some(task => task.ownerPageId === pageA.id), 'closing one project page must remove all of its panel snapshots');
assert(Object.values(afterSingleProjectClose).some(task => task.ownerPageId === pageB.id), 'closing one project page must preserve a sibling page task from the same project');
const afterInspirationClose = dismissOwners(initialOwnedTasks, [inspirationPage.id]);
assert(!Object.values(afterInspirationClose).some(task => task.ownerPageId === inspirationPage.id), 'closing an inspiration page must remove its panel snapshots');
const afterWholeProjectClose = dismissOwners(initialOwnedTasks, [pageA.id, pageB.id]);
assert(!Object.values(afterWholeProjectClose).some(task => task.ownerPageId === pageA.id || task.ownerPageId === pageB.id), 'closing every page for a project must remove every page-owned panel snapshot');
assert(Object.values(afterWholeProjectClose).some(task => task.ownerPageId === otherProjectPage.id), 'whole-project cleanup must preserve unrelated page tasks');
const afterExternalProjectDeletion = dismissOwners(initialOwnedTasks, [pageA.id, pageB.id]);
assert.deepStrictEqual(afterExternalProjectDeletion, afterWholeProjectClose, 'external project deletion must use the same page-owned task cleanup as an in-app whole-project close');

assert(main.includes('<TaskCenterProvider>') && main.includes('</TaskCenterProvider>'), 'the app must have one shared task center provider');
assert(taskCenter.includes('onBackgroundTaskChanged') && taskCenter.includes('reportPanelTask') && taskCenter.includes('dismissPanelTask'), 'the task center must combine main-process and panel task state');
assert(taskStatus.includes('usePanelTaskReporter') && taskStatus.includes("const state: TaskCenterProgressReport['state'] = isRunning ? 'running'"), 'the shared progress component must report panel task state without per-panel adapters');
assert(indicator.includes('useTaskCenter()') && !indicator.includes('onBackgroundTaskChanged('), 'the background indicator must consume the shared provider instead of creating a duplicate subscription');
assert(workspace.includes('mountedPanels.has') && workspace.includes("open={panel === 'research'}") && workspace.includes("open={panel === 'converter'}"), 'component panels must stay mounted while their modal is minimized');
assert(projectToolModal.includes('isActivePresentedBackgroundTaskForPanel(candidate, ownerPageId, panelKind)') && projectToolModal.includes("aria-label={effectiveBusy ? '收起到后台' : '关闭'}") && projectToolModal.includes("window.addEventListener('pointerdown', interceptOutsidePointer, true)") && projectToolModal.includes('event.preventDefault()') && projectToolModal.includes('event.stopImmediatePropagation()') && projectToolModal.includes('if (!effectiveBusy) onClose()'), 'the capture-phase backdrop boundary must consume every outside pointer and close only idle panels');
assert(projectToolModal.includes('useBackgroundTaskBusyFallback && backgroundTaskActive') && !workspace.includes('busy={videoTranscodeBusy}') && videoToolsUi.includes("event.eventType!=='complete'") && videoToolsUi.includes('video-tools.operation.current.v1'), 'plugin video transcode must use live component events and recover the current Host task instead of a stale renderer snapshot');
assert(toolViews.includes('const transcodeBusy = task.isRunning;') && toolViews.includes('onBusyChange?.(transcodeBusy)') && toolViews.includes('onBusyChange?.(true)'), 'only real encoding, not automatic output estimation, may put the video transcode panel in busy mode');
assert(toolViews.includes('AUTO_TRANSCODE_INSPECTION_DELAY_MS') && toolViews.includes("startInspectionRef.current([...taskArguments, '--inspect-only']") && toolViews.includes('lastRequestedInspectionKeyRef.current === inspectionKey') && !toolViews.includes('分析媒体与设备'), 'video transcode configuration changes must debounce an automatic output estimate without a manual analysis button');
for (const inlineLayerState of ['progressCompare', 'progressRepair', 'pendingProgressFolders.length', 'draggingChildId || pendingRelationChange', 'batchRenameOpen', 'confirmDelete']) {
  assert(workspace.includes(`useEscapeLayer(active && Boolean(${inlineLayerState})`) || workspace.includes(`useEscapeLayer(active && ${inlineLayerState}`), `inline ${inlineLayerState} host suspension must release when its project page becomes inactive`);
}
assert(projectVersionTree.includes('useHostSurfaceSuspension(active && Boolean(relationChoice || blankOutputSourceId))') && workspace.includes("active={active && activeView === 'project'}"), 'inline version-tree choices must not suspend host surfaces from a hidden project page or a different project subview');
assert(trackingConfirmation.includes('useHostSurfaceSuspension(active)') && workspace.includes('active={active} sessionId={trackingConfirmationSessionId}'), 'the inline tracking confirmation must follow its owning project page visibility');
assert(versionManager.includes('onSaveNote={note => updateVersion') && versionManager.includes('保存说明') && !versionManager.includes('编辑版本说明') && workspace.includes('<VersionManager active={active && activeView === \'version\'}'), 'version notes must be directly editable without a modal editor and the version view must still receive active-tab state');
assert(projectToolModal.includes('createPortal(') && projectToolModal.includes('useEscapeLayer(open, onClose, true, true)') && workspace.includes('useEscapeLayer(Boolean(gatherPickerPaths)'), 'body-portal project tools remain globally visible and continue suspending host surfaces across tab switches');
assert(indicator.includes('visiblePanelTasks') && indicator.includes('恢复面板') && workspace.includes('photoflow:restore-panel-task'), 'minimized component tasks must restore through the single global task center');
assert(taskCenter.includes('const startedAt = nextPanelTaskStartedAt(previous, report.state, updatedAt)') && taskCenter.includes('progress, startedAt, updatedAt') && (indicator.match(/formatBackgroundTaskStartedAt\(task\.startedAt\)/g) || []).length >= 2, 'both panel tasks and main-process background tasks must display their captured start time');
assert(taskCenter.includes('minimizedToastTaskIds') && taskCenter.includes('minimizeTaskToast') && taskCenter.includes('restoreTaskToast') && taskCenter.includes('isTaskToastMinimized') && !taskCenter.includes('localStorage'), 'file-transfer toast minimization must be session-only shared task-center state');
assert(taskCenter.includes('pruneFinishedTaskToastIds(current, backgroundTasks)'), 'terminal background tasks must be removed from the minimized-toast set');
assert(indicator.includes('isTaskToastMinimized(task.id)') && indicator.includes('显示进度') && indicator.includes('restoreTaskToast(task.id)'), 'the background task indicator must restore the current minimized file-transfer task');
assert(fileTransferToast.includes('Minimize2') && fileTransferToast.includes('aria-label="收起到任务中心"') && fileTransferToast.includes('title="收起到任务中心，任务会继续运行"') && !fileTransferToast.includes('minimizeTaskToast(task.id)} className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-bold text-red'), 'minimizing a file-transfer toast must use a clearly labeled control rather than the cancel action');
assert(indicator.includes('aria-expanded={open}') && indicator.includes('onOpenChange(!open)') && indicator.includes('useEscapeLayer(open, closeAndRestoreFocus)') && indicator.includes('aria-label="关闭后台任务抽屉"') && indicator.includes('triggerRef.current?.focus()'), 'the controlled background task drawer must toggle accessibly, retain Escape handling, and restore trigger focus when dismissed');
assert(indicator.includes('drawerHostRef.current') && indicator.includes('createPortal(') && app.includes('backgroundTaskDrawerHostRef') && app.includes('renderedBackgroundTaskDrawerWidth'), 'the task center must dock beside the host content with adjustable layout width');
assert(!indicator.includes('useHostSurfaceSuspension') && !indicator.includes('useEscapeLayer(open, closeAndRestoreFocus, true, true)'), 'the docked task drawer must not suspend native plugin surfaces');
assert(main.includes('<TaskCenterProvider>') && main.includes('<TopToastProvider>') && main.includes('<TopToastViewport />') && !main.includes('<FileTransferToast') && !app.includes('topToastStack') && topToastStack.includes('top-toast-stack--model') && topToastStack.includes('updateToastView({') && topToastStack.includes('presentation={presentation}'), 'ordinary notices and file task progress must publish from one hidden host model to the persistent Toast view');
assert(projectToolModal.includes("const reportBusyAsPanelTask = !panelKind.startsWith('version-')") && workspace.includes('progressSubmittingRef.current'), 'version operations must not create a duplicate panel task and must synchronously reject repeated submissions');
const closeImageConverter = workspace.slice(workspace.indexOf('const closeImageConverterPanel'), workspace.indexOf('const openImageConverter'));
assert(closeImageConverter.includes('conversionInspectionSequenceRef.current += 1') && closeImageConverter.includes('setConversionCollecting(false)') && closeImageConverter.includes('setPanel(null)'), 'closing an idle converter must invalidate source inspection and clear its collecting state');
assert(workspace.includes("triggerAction === 'restore'") && workspace.includes("setPanel('converter')") && workspace.includes('onClose={closeImageConverterPanel}'), 'running converter triggers must restore the persistent panel while every real close uses the same cleanup path');
assert(workspace.includes('openImageConverter(selectedEntries.map(entry => entry.relativePath))') && workspace.includes('fileMenuEntries.map(entry => entry.relativePath)'), 'image converter entry points must send project-relative paths to the virtual path inspection API');
assert(app.includes('photoflow:restore-panel-task') && app.includes('item.id === ownerPageId') && app.includes("setActiveTab('project')") && app.includes("setActiveTab('inspiration')"), 'restoring a component task must activate its exact owning project or inspiration page');
const closeProjectPage = app.slice(app.indexOf('const closeProjectTab'), app.indexOf('const closeAllPagesForProject'));
assert(closeProjectPage.includes('disposePageOwnedUi([pageId])') && app.includes('dismissPanelTasksByOwnerPageId(pageId)') && !closeProjectPage.includes('cancelBackgroundTask'), 'closing a page must remove its page-owned panel and tool state without cancelling shared main-process tasks');
assert(app.includes('disposePageOwnedUi(closingPageIds)') && app.includes('const closingPageIds = projectPages.filter'), 'whole-project and external deletion flows must clean panel state for every owned page');
assert(indicator.includes('ownerPageIds.has(task.ownerPageId)') && app.includes('<BackgroundTaskIndicator ownerPageIds={openPageIds}'), 'the background list must not offer restoration for a missing owner page');
assert(taskCenter.includes('ownerPageId: string') && workspace.includes('ownerPageId={pageId}') && !taskCenter.includes('scopeKey: string'), 'panel task identity must be owned by a page instead of a project path');
for (const panelKind of ['converter', 'screenshot-main-image', 'import', 'negative-import', 'broll', 'file-import', 'match', 'research', 'trash']) {
  assert(workspace.includes(`mountedPanels.has('${panelKind}')`), `${panelKind} must use the persistent component panel host`);
}

console.log('Panel task session architecture tests passed');
