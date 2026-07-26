const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createComponentRegistry } = require('../electron/component-registry.cjs');
const { PLUGIN_DEFINITIONS } = require('../electron/plugins/plugin-catalog.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-components-test-'));
const resourcesPath = path.join(sandbox, 'resources');
const executablePath = path.join(sandbox, 'app', 'Photoflow.exe');
const projectRoot = path.join(sandbox, 'project');
const userComponentRoot = path.join(sandbox, 'local-app-data', 'PhotoFlow', 'components');
const repositoryRoot = path.resolve(__dirname, '..');

const writeComponent = (root, id, version, entrypoint = `${id}.exe`) => {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, entrypoint), 'test executable');
  fs.writeFileSync(path.join(directory, 'component.json'), JSON.stringify({
    apiVersion: 1,
    id,
    version,
    platforms: ['win32'],
    architectures: ['x64'],
    entrypoints: { 'win32-x64': entrypoint },
  }));
  return directory;
};

try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const releaseCommand = packageJson.scripts['electron:build'];
  assert(releaseCommand.includes('npm run build:components'), 'default installer build must build both optional components');
  assert(releaseCommand.includes('npm run build:model-packs'), 'default release build must create the prepared identity model pack');
  assert(releaseCommand.indexOf('npm run build:components') < releaseCommand.indexOf('electron-builder'), 'components must be built before electron-builder');
  assert.deepStrictEqual(packageJson.build.win.target, ['nsis'], 'Windows release must only build the NSIS installer');
  assert(releaseCommand.endsWith('npm run cleanup:electron-artifacts'), 'release build must remove the unpacked staging directory');
  const artifactCleanup = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'cleanup-electron-artifacts.cjs'), 'utf8');
  assert(artifactCleanup.includes("path.join(outputDirectory, 'win-unpacked')"), 'artifact cleanup must remove win-unpacked');
  assert(artifactCleanup.includes("entry.name.endsWith('-win.zip')"), 'artifact cleanup must remove legacy application ZIPs');

  const installer = fs.readFileSync(path.join(repositoryRoot, 'build', 'installer.nsh'), 'utf8');
  assert(!installer.includes('release\\components'), 'base installer must not embed optional components');
  assert(installer.includes('$EXEDIR\\PhotoFlow-team-retouch-*-win32-*.zip'), 'installer must discover team-retouch archives beside itself');
  assert(installer.includes('$EXEDIR\\PhotoFlow-research-tools-*-win32-*.zip'), 'installer must discover research archives beside itself');
  assert.strictEqual((installer.match(/\$\{NSD_Check\}/g) || []).length, 3, 'installer must preselect every component archive found beside it');
  assert(installer.includes('$EXEDIR\\PhotoFlow-office-media-extractor-*-win32-*.zip'), 'installer must discover Office media extractor archives beside itself');
  assert(installer.includes('nsisunz::Unzip'), 'installer must extract component archives');
  assert(!installer.includes('$EXEDIR\\components'), 'legacy component folders beside the installer must not be supported');
  assert(!installer.includes('仍兼容旧方式'), 'installer must not advertise the removed legacy component flow');
  assert(!installer.includes('CopyFiles /SILENT'), 'installer must only install component ZIP archives');
  assert(!installer.includes('File /r "${PROJECT_DIR}\\release\\components'), 'component binaries must not be compiled into the base installer');

  const componentBuilder = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'build-components.cjs'), 'utf8');
  assert(componentBuilder.includes('PhotoFlow-${id}-${manifest.version}-${process.platform}-${process.arch}.zip'));
  assert(componentBuilder.includes('existingName.startsWith(artifactPrefix)'), 'component packaging must remove stale archives so the installer finds one version');
  assert(componentBuilder.includes('zipfile.ZIP_DEFLATED'));
  assert(componentBuilder.includes("'--collect-binaries', 'onnxruntime'"));
  assert(!componentBuilder.includes("'--collect-all', 'onnxruntime'"));
  assert(componentBuilder.includes('Git LFS pointer or incomplete'), 'component builds must reject an unsmudged model pointer');
  assert(componentBuilder.includes('advancedInstallerFiles'), 'team-retouch package must include its advanced environment installer');
  assert(componentBuilder.includes("'advanced-installer'"), 'advanced installer files must live inside the component package');
  assert(!componentBuilder.includes('setup-team-retouch-advanced-wsl.sh'), 'network environment builder must not ship in the end-user component');

  const advancedInstaller = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'setup-team-retouch-advanced.ps1'), 'utf8');
  assert(advancedInstaller.includes("PhotoFlow\\components\\team-retouch\\advanced\\wsl\\PhotoFlowNative"), 'advanced data must default to the component application-data namespace');
  assert(advancedInstaller.includes('PackagePath'), 'advanced setup must require a selected offline package');
  assert(advancedInstaller.includes('vhdSha256'), 'offline VHD must be checksum verified');
  assert(advancedInstaller.includes('--import-in-place'), 'verified offline VHD must be imported in place');
  assert(!advancedInstaller.includes('curl.exe'), 'end-user advanced setup must never download from the network');
  assert(!advancedInstaller.includes('https://'), 'end-user advanced setup must not contain network package sources');
  const offlinePackageBuilder = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'create-team-retouch-advanced-offline-package.ps1'), 'utf8');
  assert(offlinePackageBuilder.includes('--export') && offlinePackageBuilder.includes('--vhd'), 'deployment tooling must export a complete verified WSL disk');

  const advancedBridge = fs.readFileSync(path.join(repositoryRoot, 'components', 'team-retouch', 'advanced_bridge.py'), 'utf8');
  assert(advancedBridge.includes('DEFAULT_DISTROS = ("PhotoFlowNative", "PhotoflowLab")'), 'advanced backend must support both WSL distribution names');
  assert(advancedBridge.includes('WSL_E_DISTRO_NOT_FOUND'), 'advanced backend must fall through only when a distribution is absent');
  assert(advancedBridge.includes('HCS/ERROR_PATH_NOT_FOUND'), 'advanced backend must skip a registered distro whose VHDX is missing');
  assert(advancedBridge.includes('PHOTOFLOW_WSL_DISTRO'), 'custom WSL distribution override must remain supported');
  assert(advancedBridge.includes('class AdvancedBatchSession'), 'batch retouch must keep advanced models resident for the batch lifetime');
  assert(advancedBridge.includes('payload_b64'), 'persistent WSL requests must preserve Unicode paths');
  const pairDetrScript = fs.readFileSync(path.join(repositoryRoot, 'components', 'team-retouch', 'advanced', 'pairdetr_service.py'), 'utf8');
  const sam2Script = fs.readFileSync(path.join(repositoryRoot, 'components', 'team-retouch', 'advanced', 'sam2_service.py'), 'utf8');
  assert(pairDetrScript.includes('parser.add_argument("--serve"'), 'PairDETR must expose persistent service mode');
  assert(sam2Script.includes('parser.add_argument("--serve"'), 'SAM 2.1 must expose persistent service mode');
  const teamRetouchEngine = fs.readFileSync(path.join(repositoryRoot, 'components', 'team-retouch', 'team_retouch.py'), 'utf8');
  assert(teamRetouchEngine.includes('choices=("auto", "basic", "advanced")'), 'team-retouch must expose automatic, basic, and strict advanced modes');
  assert(teamRetouchEngine.includes('if advanced_mode == "advanced"'), 'strict advanced mode must not silently fall back');
  assert(teamRetouchEngine.includes('def probe_advanced_runtime()'), 'advanced installation must be verified by loading both production services');
  assert(teamRetouchEngine.includes('people = spatially_order_people(people)') && teamRetouchEngine.includes('def bounded_planning_box'), 'crowd numbering must be left-to-right and leaked masks must not control spatial grouping');

  const settingsFeature = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'settings', 'SettingsFeature.tsx'), 'utf8');
  assert(settingsFeature.includes('基础版 · RTMDet'), 'settings must describe the basic person-detection engine');
  assert(settingsFeature.includes('增强版 · PairDETR + SAM 2.1'), 'settings must describe the enhanced person-detection engine');
  assert(settingsFeature.includes('两个增强 ZIP 都原样放在这里，无需解压'), 'settings must explain the shared prepared-package installation flow');
  assert(settingsFeature.includes('支持 WSL CUDA 的 NVIDIA 显卡与驱动') && settingsFeature.includes('目标磁盘至少 35 GB'), 'settings must disclose hard requirements for enhanced person detection');
  assert(settingsFeature.includes('至少 8 GB 显存、16 GB 系统内存') && settingsFeature.includes('不作为安装硬门槛'), 'settings must distinguish performance recommendations from enforced requirements');
  assert(!settingsFeature.includes('AdaFace 来源') && !settingsFeature.includes('OSNet 来源'), 'model sources must live in open-source licenses instead of the install panel');
  assert(settingsFeature.includes('团片协作组件目录'), 'settings must expose one directory for all team-retouch packages');
  assert(settingsFeature.includes('安装身份识别增强包') && settingsFeature.includes('安装检测增强包'), 'settings must install every team-retouch add-on from the shared component directory');
  assert(!settingsFeature.includes('统一组件安装包目录') && !settingsFeature.includes('高级安装包目录'), 'settings must not expose separate team-retouch package locations');
  assert.strictEqual((settingsFeature.match(/优先使用 GPU 进行全身人物检测/g) || []).length, 1, 'GPU preference must appear once');
  assert(settingsFeature.indexOf('优先使用 GPU 进行全身人物检测') < settingsFeature.indexOf('<TeamRetouchEngineSettings'), 'GPU preference must be the first team-retouch setting');
  assert(settingsFeature.indexOf('通常手机修图软件能导出的画质长边不超过 4000 像素') > settingsFeature.indexOf('人物超过 4000 像素时'), '4000-pixel guidance must live with the oversize crop setting');
const teamRetouchManager = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'TeamRetouchManager.tsx'), 'utf8');
assert.match(teamRetouchManager, /dimension \/ scale/, '团片协作原图标记应使用代理图缩放比例反推原图尺寸');
assert(teamRetouchManager.includes('人物 {member.personIndex}'), '工作图预览应直接标出人物编号');
assert(teamRetouchManager.includes('InteractiveCropEditor'), '工作图范围应支持可视化拖动和缩放');
assert(teamRetouchManager.includes("cropEditor ? 'overflow-visible' : 'overflow-hidden'"), '范围编辑弹窗打开时不应被图片卡片裁切');
  assert(teamRetouchManager.includes('基础可用 · 高级未安装'), 'team-retouch workspace must disclose when only the basic engine is available');
  assert(!teamRetouchManager.includes('aria-label="识别模式"') && settingsFeature.includes('team-retouch-backend-mode'), 'detection mode must stay in settings instead of the team-retouch workspace');
  assert(!teamRetouchManager.includes('aria-label="基础版本"') && teamRetouchManager.includes('bundle.photo?.currentVersionId'), 'team-retouch must use the current version without exposing a redundant base-version selector');
  assert(!teamRetouchManager.includes('合成保存到'), 'recognition must not expose final merge output settings');
  assert(!teamRetouchManager.includes('上传修图结果'), 'recognition must not accept returned edits');
assert(teamRetouchManager.includes('调整范围') && teamRetouchManager.includes('识别错误，删除'), 'recognition review must support real correction actions');
assert(teamRetouchManager.includes('`${task.updatedAt}:${task.crop.x}:${task.crop.y}:${task.crop.width}:${task.crop.height}`'), 'recropped work-image previews must bypass stale thumbnail state');
assert(!teamRetouchManager.includes('>人物名字<') && !teamRetouchManager.includes('>接收人姓名<'), 'work-image cards must not expose redundant task-name and recipient fields');
assert(teamRetouchManager.includes('IdentityPicker') && teamRetouchManager.includes('confirmTeamIdentityGroup') && teamRetouchManager.includes('仅标记当前人物'), 'each detected person must support visual identity confirmation and atomic candidate-group assignment');
assert(teamRetouchManager.includes('识别错误，移除此人物') && teamRetouchManager.includes('excludeTeamPerson') && teamRetouchManager.includes('恢复已排除'), 'false-positive people must be individually suppressible and explicitly recoverable');
assert(teamRetouchManager.includes('photoProcessingMessages') && teamRetouchManager.includes('正在移除误识别人物并重新计算工作图'), 'false-positive recomputation must block only the affected photo card with visible progress');
assert(teamRetouchManager.includes("visibleProcessingMessage = processingMessage || (busy === 'detect'"), 'single-photo recognition must use the same card-local blocking treatment as false-positive removal');
assert(!teamRetouchManager.includes('disabled={Boolean(busy) || identityState.identifying}'), 'background identity matching must not disable every person confirmation row');
assert(teamRetouchManager.includes("event.key !== 'Escape' || busy") && teamRetouchManager.includes('dialogRef.current'), 'the identity confirmation dialog must close with Escape unless a save is in progress');
assert(teamRetouchManager.includes("taskFullyMarked ? '已标记' : '未标记'"), 'work-image status must distinguish marked and unmarked images without a redundant confirmation step');
assert(!teamRetouchManager.includes('确认无误'), 'recognition review must not require a redundant confirmation button');
assert(teamRetouchManager.includes('FullscreenImageViewer') && teamRetouchManager.includes('ImageZoomButton'), 'recognition images must support full-window viewing');
assert(teamRetouchManager.includes('Math.round(task.crop.width)') && teamRetouchManager.includes('Math.round(task.crop.height)') && teamRetouchManager.includes(' px'), 'work-image previews must display their dimensions');
assert(teamRetouchManager.includes('openNextUnmarkedIdentity') && teamRetouchManager.includes('未标记 {unmarkedIdentityCount}'), 'the unmarked counter must open the next unmarked person');
assert(teamRetouchManager.includes('uniqueIdentitySubjectsPerPhoto'), 'identity candidate selection must prevent duplicate assignments from the same photo');
  const personIdentityManager = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'PersonIdentityManager.tsx'), 'utf8');
  const teamRetouchSteps = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'TeamRetouchSteps.tsx'), 'utf8');
  const projectWorkspace = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const appSource = fs.readFileSync(path.join(repositoryRoot, 'src', 'App.tsx'), 'utf8');
  assert(teamRetouchSteps.includes('人物识别与标记') && teamRetouchSteps.includes('任务编排与返图') && !teamRetouchSteps.includes("id: 'people'"), 'team retouch must expose the integrated two-step workflow');
  assert(teamRetouchManager.includes('<TeamRetouchSteps') && personIdentityManager.includes('<TeamRetouchSteps'), 'all team-retouch panels must reuse the same step navigation');
  assert(!projectWorkspace.includes('团片协作菜单'), 'project toolbar must not expose a separate team-retouch dropdown menu');
  assert(projectWorkspace.includes("setTeamRetouchStep('detect')"), 'the single team-retouch entry must start at person detection and cropping');
  assert(appSource.includes('photoflow:components-cache') && appSource.includes('componentsLoading={componentsLoading}'), 'installed component state must be restored before opening a project');
  assert(projectWorkspace.includes('teamRetouchInstalled || componentsLoading'), 'the team-retouch toolbar entry must render immediately while component status is refreshing');
  assert(personIdentityManager.includes('批量导入返图并识别'), 'workflow must expose batch returned-image recognition');
  assert(personIdentityManager.includes('<TeamOutputProgressPicker'), 'only the workflow step must choose the final merge destination');
  assert(personIdentityManager.includes('合成已完成图片'), 'workflow must perform final image merging');
  assert(personIdentityManager.includes('generateTeamWorkflow'), 'workflow must generate its project-local week and identity folders');
  assert(personIdentityManager.includes('打开任务文件夹'), 'generated workflow groups must open their persistent project folders');
  assert(personIdentityManager.includes('删除并重新生成'), 'workflow regeneration must require destructive confirmation');
  assert(personIdentityManager.includes('returnTeamWorkflowBatch'), 'workflow batch returns must use the dedicated non-merging import path');
  assert(personIdentityManager.includes('taskOrder: workflow'), 'workflow returns must send the exact displayed hand-off order');
  assert(personIdentityManager.includes('subjects.filter(subject => !subject.task.needsReview)'), 'unconfirmed work images must not appear in the downstream workflow planner');
  const versionsIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'versions-ipc.cjs'), 'utf8');
  const pluginService = fs.readFileSync(path.join(repositoryRoot, 'electron', 'services', 'plugin-service.cjs'), 'utf8');
  assert(!versionsIpc.includes('runWarmJson') && (versionsIpc.match(/pluginService\.runJson\(\s*'team-retouch'/g) || []).length >= 4, 'every team-retouch operation must start an isolated component process');
  assert(!pluginService.includes('warmWorkers') && !pluginService.includes('stopWarm'), 'the plugin service must not retain a page-level warm model process');
  assert(!teamRetouchManager.includes('closeTeamRetouchRuntime'), 'the team-retouch page must not manage a persistent model process');
  assert(teamRetouchManager.includes('bundleFromWorkspacePhoto') && teamRetouchManager.includes('initialPhoto={initialPhoto}'), 'team-retouch cards must reuse the project workspace load instead of requesting every photo on mount');
  assert(!teamRetouchManager.includes('entries.map(async entry => { const result = await window.electronAPI.getTeamPatches'), 'team-retouch page opening must not perform one workspace query per photo');
  assert(teamRetouchManager.includes('IntersectionObserver') && teamRetouchManager.includes('previewEnabled'), 'team-retouch previews must load only near the visible viewport');
  assert(versionsIpc.includes('autoReleasedCount: clearAssignments.length') && versionsIpc.includes("['manual', 'manual-group'].includes(current.source)"), 'manual identity selection must displace automatic same-photo candidates while preserving manual conflicts');
  assert(versionsIpc.includes('const newSubjects = (patchResult.tasks || []).flatMap') && !versionsIpc.includes('teamSubjects(replacedWorkspace)'), 'false-positive recomputation must restore identities before a workspace read can clean temporary identity records');
  const excludeHandler = versionsIpc.slice(versionsIpc.indexOf("ipcMain.handle('workspace-team-person-exclude'"), versionsIpc.indexOf("ipcMain.handle('workspace-team-project-remove-photo'"));
  assert(excludeHandler.includes("'rebuild', '--input'") && !excludeHandler.includes("'detect', '--input'"), 'removing a false positive must rebuild the stored person set without rerunning detection');
  assert(excludeHandler.includes('expectedPersonCount') && excludeHandler.includes('removedPersonCount'), 'false-positive removal must enforce an exact one-person count change');
  assert(versionsIpc.includes('resolveTeamOutputProgress'), 'team-retouch merges must resolve a registered target progress');
  assert(versionsIpc.includes('合成结果不能写回当前来源进度'), 'team-retouch merges must reject the source folder as their output');
  assert(versionsIpc.includes("ipcMain.handle('workspace-team-patch-open-folder'"), 'delivery and merged-result folders must have a scoped open action');
  assert(versionsIpc.includes("ipcMain.handle('workspace-team-workflow-return-batch'"), 'workflow batch returns must have a dedicated IPC handler');
  assert(versionsIpc.includes("ipcMain.handle('workspace-team-workflow-generate'"), 'workflow generation must have a dedicated IPC handler');
  assert(versionsIpc.includes("path.resolve(projectPath, '团片协作')"), 'workflow output must remain inside the project-local team-retouch folder');
  assert(versionsIpc.includes("'team-retouch', 'workflows'"), 'workflow metadata must live in workspace user data');
  assert(versionsIpc.includes('legacyManifestPath'), 'legacy project-local workflow metadata must migrate automatically');
  assert(versionsIpc.includes('refreshDownstreamWorkflowFiles'), 'returned edits must refresh generated downstream workflow files');
  assert(versionsIpc.includes('refreshWorkflowTaskSourceFiles') && versionsIpc.includes('thumbnailService.invalidateSources([cropTargetPath])'), 'recropping must refresh generated workflow copies and invalidate the old thumbnail');
  assert(versionsIpc.includes('readyTeamWorkflowSubjects(workspace, request.items || [])'), 'workflow return matching must revalidate the currently unlocked person in the main process');
  assert(!versionsIpc.includes('if (task.needsReview) continue;'), 'suggested-review work images must remain available for identity marking and workflow generation');
  assert(!versionsIpc.includes('reviewTaskIds.has(String(item.taskId))'), 'suggested-review status must be advisory instead of blocking workflow generation');
  assert(versionsIpc.includes('const latestWorkspace = await versionService.getTeamProjectWorkspace(workspaceRoot, projectName);'), 'background identity matching must preserve manual decisions made while inference is running');
  assert(versionsIpc.includes('suppliedOrder.length !== group.length'), 'workflow return validation must reject incomplete or altered task orders');

  for (const component of Object.values(PLUGIN_DEFINITIONS)) {
    assert.match(component.version, /^\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/, `${component.id} must use the date revision version format`);
    const template = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'components', component.id, 'component.template.json'), 'utf8'));
    assert.strictEqual(template.version, component.version, `${component.id} catalog and package versions must match`);
  }

  const systemIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  assert(systemIpc.includes("component.source !== 'application'"), 'only application-directory components may be removed');
  assert(systemIpc.includes('await shell.trashItem(containerPath)'), 'component uninstall must recycle the complete component container');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-advanced-install'"), 'settings must be able to install or repair the advanced environment');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-advanced-preflight'"), 'settings must check offline prerequisites before installation');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-advanced-uninstall'"), 'settings must be able to remove the advanced environment');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-identity-models-open-folder'"), 'settings must open the user-managed identity model directory');
  assert(systemIpc.includes("ipcMain.handle('components-delete-package'") && systemIpc.includes("path.extname(resolvedArchive).toLowerCase() !== '.zip'") && systemIpc.includes('await fs.promises.unlink(archivePath)'), 'confirmed package cleanup must only delete a validated ZIP from its component directory');
  assert(systemIpc.includes('packageSizeBytes'), 'successful installers must report the actual package size for cleanup confirmation');
  assert(systemIpc.includes("const teamRetouchRoot"), 'all team-retouch packages must share one component directory');
  assert(systemIpc.includes("path.join(teamRetouchRoot(), 'advanced')") && systemIpc.includes("path.join(teamRetouchRoot(), 'identity-models')"), 'team-retouch runtime data must stay under the single component directory');
  assert(settingsFeature.includes('基础版 · YuNet + SFace + OSNet x0.25') && settingsFeature.includes('增强版 · AdaFace IR-18 + OSNet x1.0'), 'settings must explain the basic and enhanced cross-photo identity models');
  assert(!settingsFeature.includes('实验人物识别模型 · 用户自备'), 'settings must not require end users to compile identity models');

  const identityPackBuilder = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'build-team-retouch-identity-model-pack.cjs'), 'utf8');
  assert(identityPackBuilder.includes('adaface_ir18_webface4m.onnx') && identityPackBuilder.includes('osnet_x1_0_msmt17.onnx'), 'identity model pack must contain both prepared ONNX models');
  assert(identityPackBuilder.includes('model-pack.json') && identityPackBuilder.includes('sha256'), 'identity model pack must contain a versioned checksum manifest');
  const modelLicenses = fs.readFileSync(path.join(repositoryRoot, 'src', 'licenses', 'modelLicenses.ts'), 'utf8');
  for (const modelName of ['AdaFace IR-18', 'OSNet x1.0', 'PairDETR', 'SAM 2.1 Hiera Large']) {
    assert(modelLicenses.includes(`name: '${modelName}'`), `open-source licenses must include ${modelName}`);
  }
  const softwareLicenses = fs.readFileSync(path.join(repositoryRoot, 'src', 'licenses', 'softwareLicenses.ts'), 'utf8');
  for (const dependency of ['PhotoFlow 应用代码', 'Electron', 'Chromium', 'Node.js', 'React / React DOM', 'ExifTool', 'Python', 'PyInstaller', 'OpenCV / opencv-python-headless', 'ONNX Runtime DirectML', 'FFmpeg', 'PyTorch / TorchVision', 'NVIDIA CUDA 运行库']) {
    assert(softwareLicenses.includes(`name: '${dependency}'`), `third-party software notices must include ${dependency}`);
  }
  assert(softwareLicenses.includes("license: 'GPL-3.0-or-later'") && softwareLicenses.includes('--enable-gpl'), 'FFmpeg notice must disclose the actual GPL build');
  assert(softwareLicenses.includes('上游代码授权未明确'), 'PairDETR redistribution uncertainty must remain visible');
  assert(settingsFeature.lastIndexOf('使用提示') < settingsFeature.lastIndexOf('开源许可'), 'usage guidance must appear before open-source licenses');

  const registry = createComponentRegistry({
    resourcesPath,
    executablePath,
    projectRoot,
    userComponentRoot,
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
  });

  assert.strictEqual(registry.list().length, 3);
  assert.strictEqual(registry.resolve('team-retouch'), null);
  assert.strictEqual(registry.resolve('office-media-extractor'), null);
  const installRoot = userComponentRoot;
  assert.strictEqual(registry.ensureInstallRoot(), installRoot);

  writeComponent(path.join(resourcesPath, 'components'), 'research-tools', '1.0.0');
  assert.strictEqual(registry.resolve('research-tools').source, 'bundled');
  assert.strictEqual(registry.resolve('research-tools').version, '1.0.0');

  writeComponent(installRoot, 'research-tools', '2.0.0');
  assert.strictEqual(registry.resolve('research-tools').source, 'application');
  assert.strictEqual(registry.resolve('research-tools').version, '2.0.0');

  const invalidDirectory = path.join(installRoot, 'team-retouch');
  fs.mkdirSync(invalidDirectory, { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'outside.exe'), 'outside');
  fs.writeFileSync(path.join(invalidDirectory, 'component.json'), JSON.stringify({
    apiVersion: 1,
    id: 'team-retouch',
    version: '1.0.0',
    entrypoints: { 'win32-x64': '..\\outside.exe' },
  }));
  const invalid = registry.inspect('team-retouch');
  assert.strictEqual(invalid.installed, false);
  assert.strictEqual(invalid.compatible, false);
  assert.match(invalid.error, /超出组件目录/);

  console.log('Component registry tests passed');
} finally {
  const resolved = path.resolve(sandbox);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(resolved, { recursive: true, force: true });
}
