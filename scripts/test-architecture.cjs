const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createEventBus } = require('../electron/services/event-bus.cjs');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { PLUGIN_DEFINITIONS, findPluginByCapability } = require('../electron/plugins/plugin-catalog.cjs');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const lines = value => value.split(/\r?\n/).length;

const main = read('electron/main.cjs');
const app = read('src/App.tsx');
const projectWorkspace = read('src/features/workspace/ProjectWorkspace.tsx');
const projectNavigator = read('src/components/ProjectNavigator.tsx');
const settingsFeature = read('src/features/settings/SettingsFeature.tsx');
const requirePlugin = read('src/features/plugins/RequirePlugin.tsx');
const recycleBinFailure = read('src/utils/recycleBinFailure.ts');
const recycleBinService = read('electron/services/recycle-bin-service.cjs');
const filesIpc = read('electron/modules/files-ipc.cjs');
const workspaceIpc = read('electron/modules/workspace-ipc.cjs');
const shellNewService = read('electron/services/shell-new-service.cjs');
const nativeRecycleBinService = read('electron/native/RecycleBinService.cs');
const packageJson = JSON.parse(read('package.json'));
assert(/\btsc\s+-b\b/.test(packageJson.scripts.build), 'production build must type-check referenced TypeScript projects');
assert(projectWorkspace.includes('folder.trackingEnabled && !folder.folderMissing'), 'version management must require an enabled, available progress tracker');
assert(/openVersions[\s\S]*?if \(!hasVersionTrackingForEntry\(target\)\)/.test(projectWorkspace), 'version management must guard every open path before creating media history');
assert(!/ipcMain\.(?:handle|on)\s*\(/.test(main), 'main.cjs must not own IPC handlers');
assert(lines(main) < 2000, 'main.cjs exceeded the architecture size budget');
assert(/workspaceDatabase = new PythonDatabaseClient\([\s\S]*?defaultTimeoutMs: 2 \* 60 \* 1000/.test(main), 'workspace recovery must allow long project-catalog reconciliation to finish');
assert(lines(app) < 1000, 'App.tsx exceeded the architecture size budget');
assert(!/run(?:Workspace|Media)Database/.test(`${main}\n${read('electron/modules/workspace-ipc.cjs')}\n${read('electron/modules/versions-ipc.cjs')}`), 'IPC code bypassed repositories');
assert.strictEqual((app.match(/electronAPI\.getComponents\(/g) || []).length, 1, 'App must be the single renderer owner of component status');
assert(!settingsFeature.includes('electronAPI.getComponents('), 'settings must consume App component state instead of fetching it');
assert(!projectWorkspace.includes('electronAPI.getComponents('), 'project workspace must consume App component state instead of fetching it');
assert(!requirePlugin.includes('electronAPI.getComponents('), 'component contributions must not independently fetch component state');
assert(app.includes("card !== 'research' || installedComponentIds.has('research-tools')"), 'research home contribution must be hidden when its component is not installed');
assert(!app.includes('尚未安装调研整理组件'), 'uninstalled component contributions must not leave placeholder UI');
assert(projectWorkspace.includes("teamRetouchAvailable && fileMenu.entry.kind === 'image'"), 'team retouch context-menu contribution must require the installed component');
assert(settingsFeature.includes('filter(item => installedComponentIds.has(item.componentId))'), 'component settings contributions must require the installed component');
assert(app.includes("componentSettings: { ...fileConfig.componentSettings, 'team-retouch': personDetectionSettings, 'research-tools': researchSettings }"), 'legacy component config must migrate into componentSettings');
for (const code of ['RECYCLE_BIN_FAILED', 'RECYCLE_UNAVAILABLE', 'RECYCLE_SERVICE_MISSING', 'EPERM', 'EACCES', 'EBUSY']) {
  assert(recycleBinFailure.includes(`'${code}'`), `recycle-bin failure dialog must recognize ${code}`);
}
assert(recycleBinFailure.includes('拒绝访问') && recycleBinFailure.includes('being used by another process'), 'recycle-bin failure dialog must recognize localized Windows denial messages');
assert(recycleBinService.includes("args[0] === 'trash' ? 'RECYCLE_BIN_FAILED'"), 'native trash failures must expose a stable structured error code');
assert(projectWorkspace.includes('isRecycleBinFailure(result.error, result.errorCode)'), 'project and ordinary file deletion must use structured recycle-bin errors');
assert(/missingDirectory && !requestedPath[\s\S]*?onDeleted\(\)/.test(projectWorkspace), 'an externally deleted open project must close its stale tab');
assert(!nativeRecycleBinService.includes('EnsureRecycleCapacity') && !nativeRecycleBinService.includes('CalculateSourceSize'), 'trash must not pre-scan folder size before handing deletion to Windows');
assert(nativeRecycleBinService.includes('FOF_WANTNUKEWARNING') && nativeRecycleBinService.includes('{ "permanent", permanent }'), 'Windows must warn before a non-recyclable item is permanently deleted and report that outcome');
assert(filesIpc.includes("buttons: ['替换并继续', '保留两者', '取消']"), 'paste conflicts must let the user replace, keep both, or cancel');
assert(/requestedItems\.filter\(item => item\.conflict\)[\s\S]*?isDirectory: fs\.statSync\(item\.desiredDestination\)\.isDirectory\(\)/.test(filesIpc), 'paste conflict detection must include same-name files as well as folders');
assert(/operation === 'paste'[\s\S]*?activeProjectFileOperations\.set\(operationId, job\)[\s\S]*?await readSystemFileClipboard\(\)/.test(filesIpc), 'paste must acquire its concurrency lock before reading the clipboard');
assert(/if \(process\.platform === 'win32'\) throw new Error\(`[\s\S]*?Windows[\s\S]*?fileOperationState\.projectFileClipboard/.test(filesIpc), 'Windows clipboard failures must not fall back to stale internal clipboard state');
assert(filesIpc.includes('const destinationDir = assertExistingInside(root, requestedDestination'), 'paste destinations must be checked through their real filesystem path');
assert(filesIpc.includes('`.photoflow-paste-${operationId}`') && filesIpc.includes('await fs.promises.rename(item.stagedDestination, item.destination)'), 'copied trees must remain hidden until their top-level atomic commit');
assert(filesIpc.includes('`.photoflow-replace-${operationId}`') && filesIpc.indexOf('await stageReplacements();', filesIpc.indexOf('await copyPlannedFiles(plan')) > filesIpc.indexOf('await copyPlannedFiles(plan'), 'replacement targets must be staged only after incoming copies are complete');
assert(filesIpc.includes('samePathIdentity(destination, replacementIdentities.get(pathKey(destination)))'), 'a replacement must reject a target changed after user confirmation');
assert(filesIpc.includes('await removeCopiedSources(plan)'), 'cross-volume cut must validate the source snapshot before removal');
assert(workspaceIpc.includes('isInternalFileOperationEntry(entry.name)'), 'temporary transfer and recovery entries must remain hidden from project browsing');
assert(workspaceIpc.includes("operation.kind === 'paste-replace'"), 'replacement paste operations must have a transactional undo path');
assert(filesIpc.includes("writeLog('info', 'Project files moved by same-volume rename'"), 'same-volume cut/paste must use filesystem moves instead of copy-then-delete');
assert(filesIpc.includes('await movePathAtomic(item.source, item.destination'), 'same-volume cut/paste must use the safe move primitive');
assert(filesIpc.includes('await writeSystemFileClipboard(sources, operation)'), 'copy/cut must wait until the Windows file clipboard is ready');
assert(main.includes("$data.SetData('Preferred DropEffect', $false, [byte[]]$effectBytes)"), 'Windows cut clipboard data must expose a DWORD-compatible Preferred DropEffect');
assert(projectNavigator.includes("(showNew || renameProject) && <ProjectDialog title={renameProject ? '重命名项目' : '新建项目'}"), 'project create and rename must share the same editor panel');
assert(projectNavigator.includes('createPortal(<div className="fixed inset-x-0 bottom-0 top-10 z-[500]') && projectNavigator.includes('disabled={isCreating || !nextProjectDisplayName}'), 'project editor must escape sidebar stacking and allow a date-only name');
assert(projectNavigator.includes('const legacyMonthDay = project.name.match') && projectNavigator.includes('"9-12-2" becomes date YY-9-12 plus name "2"') && projectNavigator.includes('setEditor(projectEditorValue(project))'), 'legacy M-D and M-D-name projects must reopen with the current year and an optional name');
assert(projectNavigator.includes('type="number" min="0" max="2099"') && projectNavigator.includes('type="number" min="1" max="12"'), 'project date fields must resist Chromium text autofill restoring stale visible values');
assert(app.includes("createPlanningFolder: true") && app.includes("defaultFolderSort: 'date'"), 'project creation and folder sorting defaults must be explicit');
assert(settingsFeature.includes('新建项目时自动创建“策划”文件夹') && settingsFeature.includes('文件夹默认排序方式'), 'general settings must expose project folder creation and default sorting');
assert(projectNavigator.includes('createWorkspaceProject(workspacePath, projectDate(), name, { createPlanningFolder })'), 'project creation must forward the planning-folder preference');
assert(workspaceIpc.includes("options?.createPlanningFolder !== false") && workspaceIpc.includes("path.join(projectPath, '策划')"), 'workspace creation must default to creating the planning folder while allowing opt-out');
assert(projectWorkspace.includes('useState<ProjectFileSortField>(defaultFolderSort)') && projectWorkspace.includes("defaultFolderSort === 'name' ? 'asc' : 'desc'"), 'project folders must initialize from the configured sort mode');
assert(projectWorkspace.includes("entries.filter(entry => entry.kind === 'image' || entry.kind === 'raw')"), 'Photoshop actions must include RAW files');
assert(/if \(event\.ctrlKey \|\| event\.metaKey\) \{\s*toggleSelected\(entry\.relativePath\)/.test(projectWorkspace), 'Ctrl-click must toggle selection instead of opening an entry');
assert(projectWorkspace.includes('setSelectedPaths(displayedFileEntries.map(entry => entry.relativePath))'), 'Ctrl+A must select the current displayed folder contents');
assert(shellNewService.includes("Registry::HKEY_CLASSES_ROOT") && shellNewService.includes("Command and handler-based entries are intentionally not executed"), 'ShellNew discovery must be read-only and must not execute registered commands');
assert(!shellNewService.includes('runPowerShellJson(DISCOVERY_SCRIPT).catch(() => [])') && shellNewService.includes('const nextTypes = normalized.slice(0, 80)') && shellNewService.indexOf('cachedTypes = nextTypes') > shellNewService.indexOf('app.getFileIcon(iconSource'), 'ShellNew discovery failures must remain retryable and cache publication must be atomic');
assert(shellNewService.includes("shell-new-types-cache.json") && shellNewService.includes('CACHE_MAX_AGE_MS') && shellNewService.includes('writePersistentCache(cachedTypes)'), 'ShellNew types and icons must persist across app launches instead of rescanning every time');
assert(projectWorkspace.includes('createProjectShellNewFile') && projectWorkspace.includes('Windows 文件类型'), 'the top New menu must expose supported Windows ShellNew file types');
assert(shellNewService.includes("app.getFileIcon(iconSource, { size: 'normal' })") && projectWorkspace.includes('type.iconDataUrl'), 'the top New menu must display Windows-associated file type icons');
assert(projectWorkspace.includes('project-menu-item flex items-center gap-2') && projectWorkspace.includes('重新扫描 Windows 新建文件类型'), 'ShellNew menu rows must place text beside the icon and expose manual refresh');

const electronSources = fs.readdirSync(path.join(root, 'electron'), { recursive: true })
  .filter(name => name.endsWith('.cjs'))
  .map(name => read(path.join('electron', name)))
  .join('\n');
const registeredChannels = new Set([...electronSources.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]));
const preload = read('electron/preload.cjs');
const requestedChannels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
for (const channel of requestedChannels) assert(registeredChannels.has(channel), `preload channel is not registered: ${channel}`);

assert(findPluginByCapability('team-retouch.detect')?.id === 'team-retouch');
assert(findPluginByCapability('research.organize')?.id === 'research-tools');
assert(Object.values(PLUGIN_DEFINITIONS).every(plugin => Array.isArray(plugin.capabilities) && plugin.capabilities.length));

const testBackgroundTasks = async () => {
  const eventBus = createEventBus();
  const service = createBackgroundTaskService({ eventBus, maxHistory: 10 });
  const updates = [];
  eventBus.on('background-task:changed', task => updates.push(task));

  const completed = await service.run({ type: 'test', title: 'test task' }, async task => {
    task.report(50, 'half');
    return 42;
  });
  assert.strictEqual(completed.result, 42);
  assert.strictEqual(completed.task.state, 'completed');
  assert(updates.some(task => task.progress === 50));

  let attempts = 0;
  let retryRun;
  retryRun = () => service.run({ type: 'retry-test', title: 'retry test' }, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('first attempt fails');
    return 'retried';
  }, retryRun);
  let failedId = '';
  try {
    await retryRun();
  } catch {
    failedId = service.list().find(task => task.type === 'retry-test')?.id || '';
  }
  assert(failedId, 'failed task was not retained');
  const retried = await service.retry(failedId);
  assert.strictEqual(retried.result, 'retried');

  const cancelling = service.run({ type: 'cancel-test', title: 'cancel test' }, task => new Promise(resolve => {
    task.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  }));
  await new Promise(resolve => setImmediate(resolve));
  const cancelTask = service.list().find(task => task.type === 'cancel-test');
  assert(cancelTask && service.cancel(cancelTask.id));
  const cancelled = await cancelling;
  assert(cancelled.cancelled);
  service.stop();
  eventBus.clear();
};

testBackgroundTasks().then(() => console.log('Architecture contracts passed.')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
