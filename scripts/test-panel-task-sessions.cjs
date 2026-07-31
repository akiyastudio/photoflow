const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const main = read('src/main.tsx');
const app = read('src/App.tsx');
const taskCenter = read('src/features/background-tasks/TaskCenter.tsx');
const taskStatus = read('src/components/TaskStatus.tsx');
const indicator = read('src/features/background-tasks/BackgroundTaskIndicator.tsx');
const workspace = read('src/features/workspace/ProjectWorkspace.tsx');

assert(main.includes('<TaskCenterProvider>') && main.includes('</TaskCenterProvider>'), 'the app must have one shared task center provider');
assert(taskCenter.includes('onBackgroundTaskChanged') && taskCenter.includes('reportPanelTask') && taskCenter.includes('dismissPanelTask'), 'the task center must combine main-process and panel task state');
assert(taskStatus.includes('usePanelTaskReporter') && taskStatus.includes("state: isRunning ? 'running'"), 'the shared progress component must report panel task state without per-panel adapters');
assert(indicator.includes('useTaskCenter()') && !indicator.includes('onBackgroundTaskChanged('), 'the background indicator must consume the shared provider instead of creating a duplicate subscription');
assert(workspace.includes('mountedPanels.has') && workspace.includes("open={panel === 'research'}") && workspace.includes("open={panel === 'converter'}"), 'component panels must stay mounted while their modal is minimized');
assert(workspace.includes("aria-label={effectiveBusy ? '收起到后台' : '关闭'}") && workspace.includes('if (event.target === event.currentTarget && !effectiveBusy)'), 'running panels must minimize explicitly and ignore accidental backdrop clicks');
assert(indicator.includes('visiblePanelTasks') && indicator.includes('恢复面板') && workspace.includes('photoflow:restore-panel-task'), 'minimized component tasks must restore through the single global task center');
assert(app.includes('photoflow:restore-panel-task') && app.includes("setActiveTab('project')"), 'restoring a component task must activate its project');
assert(app.includes('组件任务仍在运行') && app.includes('runningPanelTask'), 'a project tab must not unmount a running component task');
for (const panelKind of ['converter', 'screenshot-main-image', 'import', 'negative-import', 'broll', 'file-import', 'match', 'research', 'cache', 'trash']) {
  assert(workspace.includes(`mountedPanels.has('${panelKind}')`), `${panelKind} must use the persistent component panel host`);
}

console.log('Panel task session architecture tests passed');
