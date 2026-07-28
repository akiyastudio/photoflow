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
const toolViews = read('src/features/tools/ToolViews.tsx');
const projectWorkspace = read('src/features/workspace/ProjectWorkspace.tsx');
const inspirationLibrary = read('src/features/inspiration/InspirationLibrary.tsx');
const projectNavigator = read('src/components/ProjectNavigator.tsx');
const settingsFeature = read('src/features/settings/SettingsFeature.tsx');
const requirePlugin = read('src/features/plugins/RequirePlugin.tsx');
const recycleBinFailure = read('src/utils/recycleBinFailure.ts');
const recycleBinService = read('electron/services/recycle-bin-service.cjs');
const filesIpc = read('electron/modules/files-ipc.cjs');
const workspaceIpc = read('electron/modules/workspace-ipc.cjs');
const versionsIpc = read('electron/modules/versions-ipc.cjs');
const systemIpc = read('electron/modules/system-ipc.cjs');
const workspaceDb = read('python/workspace_db.py');
const appDialogProvider = read('src/components/AppDialogProvider.tsx');
const shellNewService = read('electron/services/shell-new-service.cjs');
const nativeRecycleBinService = read('electron/native/RecycleBinService.cs');
const packageJson = JSON.parse(read('package.json'));
assert(/\btsc\s+-b\b/.test(packageJson.scripts.build), 'production build must type-check referenced TypeScript projects');
assert(app.includes("videoPreviewQuality: 'medium'") && app.includes('normalizeVideoPreviewQuality(fileConfig.smartImport?.videoPreviewQuality)'), 'video preview quality must default and migrate to medium');
assert(settingsFeature.includes('<option value="medium">中（默认 · 约 4 Mbps）</option>') && settingsFeature.includes('<option value="high">高（约 10 Mbps）</option>') && !settingsFeature.includes('<option value="maximum">最高（约 20 Mbps）</option>'), 'import settings must expose only medium and high video preview qualities');
assert(toolViews.includes("args.push('--generate_video_preview', '--video_preview_quality', config.videoPreviewQuality)"), 'SD-card imports must forward the selected video preview quality');
assert(/if \(isClipboardSelection\) \{[\s\S]*?setCutPaths\([\s\S]*?setClipboardHasFiles\(true\)[\s\S]*?onNotice\([\s\S]*?let result = await window\.electronAPI\.projectFileOperation/.test(projectWorkspace), 'copy and cut must update the renderer before waiting for Windows clipboard synchronization');
assert(/if \(!result\.success\) \{[\s\S]*?clipboardOperationSequenceRef\.current === clipboardOperationSequence[\s\S]*?setCutPaths\(previousCutPaths\)[\s\S]*?setClipboardHasFiles\(previousClipboardHasFiles\)/.test(projectWorkspace), 'failed clipboard synchronization must roll back the optimistic copy or cut state');
assert(projectWorkspace.includes("update.state !== 'STALE'") && projectWorkspace.includes('forgetMediaThumbnailPreviews(update.filePath)') && projectWorkspace.includes('updatedAt: update.sourceMtimeMs ?? Date.now()'), 'external media changes must invalidate renderer thumbnails and publish the new source revision');
assert(projectWorkspace.includes("state === 'STALE'") && projectWorkspace.includes('setSourceRevision(version => version + 1)') && projectWorkspace.includes('entry?.updatedAt, cacheConfig.directory'), 'visible thumbnails and the preview pane must reload when an external source changes');
assert(projectWorkspace.includes('folder.trackingEnabled && !folder.folderMissing'), 'version management must require an enabled, available progress tracker');
assert(/openVersions[\s\S]*?if \(!hasVersionTrackingForEntry\(target\)\)/.test(projectWorkspace), 'version management must guard every open path before creating media history');
assert(!/ipcMain\.(?:handle|on)\s*\(/.test(main), 'main.cjs must not own IPC handlers');
assert(lines(main) < 2000, 'main.cjs exceeded the architecture size budget');
assert(/workspaceDatabase = new PythonDatabaseClient\([\s\S]*?defaultTimeoutMs: 2 \* 60 \* 1000/.test(main), 'workspace recovery must allow long project-catalog reconciliation to finish');
assert(lines(app) < 1000, 'App.tsx exceeded the architecture size budget');
assert(!/run(?:Workspace|Media)Database/.test(`${main}\n${read('electron/modules/workspace-ipc.cjs')}\n${read('electron/modules/versions-ipc.cjs')}`), 'IPC code bypassed repositories');
assert.strictEqual((app.match(/electronAPI\.getComponents\(/g) || []).length, 1, 'App must be the single renderer owner of component status');
assert(!settingsFeature.includes('electronAPI.getComponents('), 'settings must consume App component state instead of fetching it');
assert(settingsFeature.includes("title: '删除已使用的安装包吗？'") && settingsFeature.includes('删除并释放 ${size}') && settingsFeature.includes("kind: 'component'") && settingsFeature.includes("kind: 'identity-models'") && settingsFeature.includes("kind: 'advanced'"), 'every in-app component installer must offer standard-dialog package cleanup with the actual size');
assert(!projectWorkspace.includes('electronAPI.getComponents('), 'project workspace must consume App component state instead of fetching it');
assert(!requirePlugin.includes('electronAPI.getComponents('), 'component contributions must not independently fetch component state');
assert(app.includes("DEFAULT_HOME_ORDER: HomeCardId[] = ['birthday', 'import', 'inspiration', 'converter']") && app.includes('openInspirationTab'), 'the home page must expose the built-in inspiration library tab');
assert(app.includes('grid grid-cols-2 gap-4') && app.includes('if (card === \'converter\') return null;') && !app.includes('<HomePanel title="灵感库"'), 'the inspiration and PNG launchers must be two side-by-side direct buttons rather than collapsible panels');
assert(!app.includes("installedComponentIds.has('research-tools')"), 'the inspiration library must not be gated by a component install');
assert(projectWorkspace.includes("teamRetouchAvailable && fileMenu.entry.kind === 'image'"), 'team retouch context-menu contribution must require the installed component');
assert(projectWorkspace.includes("onNotice('正在加载团片协作数据…', 30000)") && projectWorkspace.includes('teamRetouchOpening || !teamRetouchInstalled && componentsLoading') && projectWorkspace.includes('团片协作已加载，共 ${combined.size} 张图片'), 'opening team retouch must immediately expose loading, completion, and busy-button feedback');
assert(settingsFeature.includes('filter(item => installedComponentIds.has(item.componentId))'), 'component settings contributions must require the installed component');
assert(app.includes("delete componentSettings['research-tools']") && app.includes('const inspirationLibrary:'), 'legacy research component config must migrate into the built-in inspiration library');
assert(inspirationLibrary.includes('browserMode="inspiration"') && inspirationLibrary.includes('InspirationLibraryNavigator'), 'the inspiration library must reuse the core file browser with its own hierarchical navigation');
assert(app.includes("rootPath: ''") && inspirationLibrary.includes('attemptedInitialChoiceRef') && inspirationLibrary.includes('chooseWorkspaceDirectory(rootPath)'), 'first use of the inspiration library must request its root folder instead of silently defaulting to Downloads');
assert(settingsFeature.includes('updateInspirationLibraryRoot') && settingsFeature.includes('选择后立即保存'), 'changing the inspiration-library folder in settings must persist immediately');
assert(projectWorkspace.includes('setRecursiveFlatOpen') && projectWorkspace.includes('递归平铺当前文件夹'), 'the shared file browser must expose recursive flat browsing');
assert(workspaceIpc.includes("runPythonJsonAction('office_media_extract.py'"), 'Office image extraction must run from the built-in application runtime');
for (const code of ['RECYCLE_BIN_FAILED', 'RECYCLE_UNAVAILABLE', 'RECYCLE_SERVICE_MISSING', 'EPERM', 'EACCES', 'EBUSY']) {
  assert(recycleBinFailure.includes(`'${code}'`), `recycle-bin failure dialog must recognize ${code}`);
}
assert(recycleBinFailure.includes('拒绝访问') && recycleBinFailure.includes('being used by another process'), 'recycle-bin failure dialog must recognize localized Windows denial messages');
assert(recycleBinService.includes("args[0] === 'trash' ? 'RECYCLE_BIN_FAILED'"), 'native trash failures must expose a stable structured error code');
assert(projectWorkspace.includes('isRecycleBinFailure(result.error, result.errorCode)'), 'project and ordinary file deletion must use structured recycle-bin errors');
assert(/missingDirectory && !requestedPath[\s\S]*?onDeleted\(\)/.test(projectWorkspace), 'an externally deleted open project must close its stale tab');
assert(!nativeRecycleBinService.includes('EnsureRecycleCapacity') && !nativeRecycleBinService.includes('CalculateSourceSize'), 'trash must not pre-scan folder size before handing deletion to Windows');
assert(nativeRecycleBinService.includes('FOF_WANTNUKEWARNING') && nativeRecycleBinService.includes('{ "permanent", permanent }'), 'Windows must warn before a non-recyclable item is permanently deleted and report that outcome');
assert(/publish\(\{ phase: 'complete'[\s\S]*?queuePermanentProjectCleanup\(root, projectName\)/.test(workspaceIpc), 'permanent project deletion must release the foreground UI before scheduling internal cleanup');
assert(workspaceIpc.includes("kind: 'project-cleanup'") && workspaceIpc.includes("type: 'deleted-project-cleanup'"), 'permanent project cleanup must be restart-safe and visible as a background task');
assert(workspaceIpc.indexOf('getDeletedProjectCleanupPlan') < workspaceIpc.indexOf('removeInternalProjectArtifacts(root, cleanupPlan)') && workspaceIpc.indexOf('removeInternalProjectArtifacts(root, cleanupPlan)') < workspaceIpc.indexOf('purgeDeletedProject(root, project.id)'), 'deleted project artifacts must be planned and removed before the recoverable database row is purged');
assert(main.includes('isSuppressedWorkspaceChange(root, fileName)') && workspaceIpc.includes('suppressWorkspaceWatchPath(projectPath)') && workspaceIpc.includes('releaseWorkspaceWatchPath(suppressedProjectPath)'), 'project deletion must suppress its recursive workspace watcher event storm');
const databaseConnect = workspaceDb.slice(workspaceDb.indexOf('def connect('), workspaceDb.indexOf('def directory_identity('));
assert(databaseConnect.includes('if backup_path or is_fresh:') && !databaseConnect.includes('_automatic_backup_if_due'), 'routine database maintenance must not block opening the workspace catalog');
assert(main.includes('workspaceMaintenanceDatabase = new PythonDatabaseClient') && workspaceIpc.includes("type: 'workspace-database-maintenance'"), 'daily database maintenance must use an independent background worker');
assert(filesIpc.includes("new Set(['import', 'move', 'paste', 'trash', 'select', 'rename'])") && filesIpc.includes('suppressWorkspaceWatchPath?.(root)') && filesIpc.includes('releaseWorkspaceWatchPath?.(suppressedProjectRoot)'), 'bulk file mutations must suppress recursive watcher and media-scan storms');
const componentsListHandler = systemIpc.slice(systemIpc.indexOf("ipcMain.handle('components-list'"), systemIpc.indexOf("ipcMain.handle('components-open-folder'"));
assert(componentsListHandler.includes('pluginService.list()') && componentsListHandler.includes('queueComponentStatusRefresh()') && !componentsListHandler.includes('listWithSizes'), 'component listing must return cached status before recursive sizing and runtime probes');
assert(systemIpc.includes("type: 'component-status-refresh'") && app.includes('onComponentsStatusChanged'), 'detailed component status must refresh through a background event');
assert(systemIpc.includes('queueSystemFilesystemCleanup(cleanupPaths') && versionsIpc.includes('queueCleanupArtifacts(workspaceRoot') && versionsIpc.includes("queueFilesystemCleanup([previousWorkflowDirectory]"), 'committed installs, versions, and workflows must defer obsolete internal-file cleanup');
assert(appDialogProvider.includes('choice: (options: ChoiceDialogOptions)') && appDialogProvider.includes("enqueue('choice', options)"), 'the shared in-app dialog provider must support multi-choice decisions');
assert(filesIpc.includes("kind: 'paste-conflict'") && projectWorkspace.includes("value: 'replace'") && projectWorkspace.includes("value: 'keep-both'"), 'paste conflicts must return a decision request and let the in-app UI replace, keep both, or cancel');
assert(workspaceIpc.includes("kind: 'restore-conflict'") && app.includes("value: 'rename'") && app.includes("value: 'overwrite'"), 'occupied restore targets must be resolved through the in-app choice dialog');
assert(versionsIpc.includes("kind: 'version-fingerprint-mismatch'") && read('src/components/VersionManager.tsx').includes("value: 'relocate'"), 'fingerprint mismatches must be resolved through the in-app choice dialog');
assert(!filesIpc.includes('showMessageBox') && !workspaceIpc.includes('showMessageBox') && !versionsIpc.includes('showMessageBox'), 'non-file native message boxes must not remain in workspace file flows');
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
assert(projectWorkspace.includes('entryPointerModifiersRef.current') && projectWorkspace.includes('const additive = event.ctrlKey || event.metaKey || Boolean(pointerModifiers?.additive)') && /if \(additive\) \{\s*toggleSelected\(entry\.relativePath\)/.test(projectWorkspace), 'Ctrl-click must preserve pointer modifiers and toggle selection instead of opening an entry');
assert(projectWorkspace.includes('initialPaths: [...selectedPaths]') && projectWorkspace.includes('const additive = drag.additive || event.ctrlKey || event.metaKey') && projectWorkspace.includes('initialPaths.filter(path => !hitSet.has(path))') && projectWorkspace.includes('hitPaths.filter(path => !initialSet.has(path))') && projectWorkspace.includes('mergeMarqueeSelection(drag.initialPaths, hits, additive)'), 'Ctrl-drag marquee selection must toggle hit entries relative to the initial selection');
assert(workspaceIpc.includes("ipcMain.handle('workspace-search-files'") && projectWorkspace.includes('searchResultGroups.map'), 'project search must recurse through its current scope and group results by folder');
assert(projectWorkspace.includes("currentRelativePath ? '当前文件夹及其子文件夹' : '整个项目'"), 'search scope must be the whole project at root and the current folder below root');
assert(projectWorkspace.includes("part.toLocaleLowerCase() === 'jpg' || part.endsWith('导出')") && projectWorkspace.includes("'move', [candidate], ''"), 'external Photoshop and PixelCake export folders must be offered as root progress folders');
assert(projectWorkspace.includes('const projectLocation = `${project.name}/${candidate}`') && projectWorkspace.includes('项目内位置：“${projectLocation}”'), 'new export prompts must identify the discovered folder by its location inside the project');
assert(projectWorkspace.includes('setSelectedPaths(displayedFileEntries.map(entry => entry.relativePath))'), 'Ctrl+A must select the current displayed folder contents');
assert(shellNewService.includes("Registry::HKEY_CLASSES_ROOT") && shellNewService.includes("Command and handler-based entries are intentionally not executed"), 'ShellNew discovery must be read-only and must not execute registered commands');
assert(!shellNewService.includes('runPowerShellJson(DISCOVERY_SCRIPT).catch(() => [])') && shellNewService.includes('const nextTypes = normalized.slice(0, 80)') && shellNewService.indexOf('cachedTypes = nextTypes') > shellNewService.indexOf('app.getFileIcon(iconSource'), 'ShellNew discovery failures must remain retryable and cache publication must be atomic');
assert(shellNewService.includes("shell-new-types-cache.json") && shellNewService.includes('CACHE_MAX_AGE_MS') && shellNewService.includes('writePersistentCache(cachedTypes)'), 'ShellNew types and icons must persist across app launches instead of rescanning every time');
assert(projectWorkspace.includes('createProjectShellNewFile') && projectWorkspace.includes('Windows 文件类型'), 'the top New menu must expose supported Windows ShellNew file types');
assert(shellNewService.includes("app.getFileIcon(iconSource, { size: 'normal' })") && projectWorkspace.includes('type.iconDataUrl'), 'the top New menu must display Windows-associated file type icons');
assert(read('src/index.css').includes('.project-create-menu .project-menu-item { display:flex; align-items:center; gap:.5rem; }') && projectWorkspace.includes('project-create-menu') && projectWorkspace.includes('重新扫描 Windows 新建文件类型'), 'ShellNew menu rows must place text beside the icon and expose manual refresh');
assert(projectWorkspace.includes('setProgressSetup(makeProgressDraft') && projectWorkspace.includes('void loadProgressFolders();'), 'the progress editor must open from cached state before refreshing progress folders');
assert(settingsFeature.includes('overflow-y-auto overscroll-contain'), 'the settings navigator must scroll when its component list exceeds the viewport');
assert(main.includes('isInternalWorkspaceChange(fileName)'), 'workspace watching must ignore hidden file-operation staging writes');
assert(main.includes(".photoflow-workspace-id"), 'workspace databases must use a stable identity marker that survives moving the workspace');
assert(/show: false,[\s\S]*?once\('ready-to-show'[\s\S]*?mainWindow\.maximize\(\)[\s\S]*?mainWindow\.show\(\)/.test(main), 'the main window must start maximized without flashing its initial bounds');

const electronSources = fs.readdirSync(path.join(root, 'electron'), { recursive: true })
  .filter(name => name.endsWith('.cjs'))
  .map(name => read(path.join('electron', name)))
  .join('\n');
const registeredChannels = new Set([...electronSources.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]));
const preload = read('electron/preload.cjs');
const requestedChannels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
for (const channel of requestedChannels) assert(registeredChannels.has(channel), `preload channel is not registered: ${channel}`);

assert(findPluginByCapability('team-retouch.detect')?.id === 'team-retouch');
assert.strictEqual(findPluginByCapability('research.organize'), undefined);
assert.strictEqual(findPluginByCapability('office-media.extract'), undefined);
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
