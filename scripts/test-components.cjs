const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');
const { createComponentRegistry } = require('../electron/component-registry.cjs');
const { PLUGIN_DEFINITIONS } = require('../electron/plugins/plugin-catalog.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-components-test-'));
const resourcesPath = path.join(sandbox, 'resources');
const executablePath = path.join(sandbox, 'app', 'Photoflow.exe');
const projectRoot = path.join(sandbox, 'project');
const userComponentRoot = path.join(sandbox, 'local-app-data', 'PhotoFlow', 'components');
const repositoryRoot = path.resolve(__dirname, '..');

const writeComponent = (root, id, version, entrypoint = `${id}.exe`, manifestId = id) => {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, entrypoint), 'test executable');
  fs.writeFileSync(path.join(directory, 'component.json'), JSON.stringify({
    apiVersion: 1,
    id: manifestId,
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
  assert(!releaseCommand.includes('npm run build:components'), 'default application build must not build or bundle optional components');
  assert(!releaseCommand.includes('npm run build:model-packs'), 'default application build must not build team-retouch model packs');
  assert(packageJson.scripts['build:components'] && !packageJson.scripts['build:model-packs'], 'identity models must ship in the standalone team-retouch component instead of a second model pack');
  assert.deepStrictEqual(packageJson.build.win.target, ['nsis'], 'Windows release must only build the NSIS installer');
  assert(releaseCommand.endsWith('npm run cleanup:electron-artifacts'), 'release build must remove the unpacked staging directory');
  const artifactCleanup = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'cleanup-electron-artifacts.cjs'), 'utf8');
  assert(artifactCleanup.includes("path.join(outputDirectory, 'win-unpacked')"), 'artifact cleanup must remove win-unpacked');
  assert(artifactCleanup.includes("entry.name.endsWith('-win.zip')"), 'artifact cleanup must remove legacy application ZIPs');

  const installer = fs.readFileSync(path.join(repositoryRoot, 'packaging', 'installer.nsh'), 'utf8');
  assert.strictEqual(packageJson.build.nsis.license, 'docs/legal/INSTALLER_TERMS.txt', 'NSIS must use the native text license renderer instead of the unreliable legacy HTML control');
  assert.strictEqual(packageJson.build.nsis.perMachine, true, 'installer must request administrator approval before installing for all Windows users');
  const installerLicense = fs.readFileSync(path.join(repositoryRoot, packageJson.build.nsis.license));
  assert.deepStrictEqual([...installerLicense.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'NSIS installation terms must use a UTF-8 BOM so Chinese text renders correctly');
  const installerLicenseText = installerLicense.toString('utf8');
  assert(installerLicenseText.includes('照片流用户协议及内测条款') && installerLicenseText.includes('照片流隐私政策（内测版）'), 'installation terms must contain the complete agreement and privacy policy');
  assert(installerLicenseText.includes('只有明确接受后，安装程序才会继续') && installerLicenseText.includes('实际使用前仍会另行展示规则并取得单独同意'), 'installation terms must explain the installation gate and preserve separate face-recognition consent');
  const installerHtml = fs.readFileSync(path.join(repositoryRoot, 'docs', 'legal', 'INSTALLER_TERMS.html'), 'utf8');
  assert(installerHtml.startsWith('<!doctype html>') && installerHtml.includes('<meta charset="utf-8">'), 'the canonical combined installation terms must remain available as complete HTML');
  assert(releaseCommand.includes('npm run generate:installer-terms'), 'release builds must regenerate the combined installation terms from the current HTML policies');
  const legalResource = packageJson.build.extraResources.find(resource => resource.to === 'legal');
  assert.deepStrictEqual(legalResource?.filter, ['*.html'], 'release packages must include only the user-facing HTML legal documents');
  const legalDocumentNames = [
    'PRIVACY_POLICY',
    'USER_AGREEMENT',
    'FACE_RECOGNITION_RULES',
    'PERSONAL_INFORMATION_LIST',
    'THIRD_PARTY_SERVICES',
    'PERMISSIONS',
    'CHILDREN_PRIVACY',
    'CUSTOMER_DATA_PROCESSING_TERMS',
    'OPEN_SOURCE_NOTICES',
  ];
  const privacyService = fs.readFileSync(path.join(repositoryRoot, 'electron', 'privacy-service.cjs'), 'utf8');
  for (const documentName of legalDocumentNames) {
    const htmlPath = path.join(repositoryRoot, 'docs', 'legal', `${documentName}.html`);
    assert(fs.existsSync(htmlPath), `${documentName} must be distributed as HTML`);
    assert(!fs.existsSync(path.join(repositoryRoot, 'docs', 'legal', `${documentName}.md`)), `${documentName} must not retain a Markdown user-facing copy`);
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert(html.startsWith('<!doctype html>') && html.includes('<html lang="zh-CN">'), `${documentName} must be a complete Chinese HTML document`);
    assert(html.includes('Content-Security-Policy') && html.includes('<meta name="viewport"'), `${documentName} must be safe and responsive when opened in a browser`);
    assert(html.includes('<main>') && html.includes('<h1>') && !html.includes('<script'), `${documentName} must use semantic, script-free document markup`);
    assert(privacyService.includes(`'${documentName}.html'`), `${documentName} must be reachable from the application`);
  }
  const informationListHtml = fs.readFileSync(path.join(repositoryRoot, 'docs', 'legal', 'PERSONAL_INFORMATION_LIST.html'), 'utf8');
  assert(informationListHtml.includes('<table>') && informationListHtml.includes('<thead>') && informationListHtml.includes('<tbody>'), 'the personal-information list must remain a semantic HTML table');
  assert(installer.includes('IfSilent PhotoFlowSkipConsentReceipt'), 'silent installs must not create an interactive consent receipt');
  assert(installer.includes('WriteINIStr "$APPDATA\\Photoflow\\install-consent.ini"') && installer.includes('"Interactive" "1"'), 'interactive installs must write a per-user consent receipt');
  const currentTermsVersion = privacyService.match(/CURRENT_TERMS_VERSION = '([^']+)'/)?.[1];
  const currentPrivacyVersion = privacyService.match(/CURRENT_PRIVACY_NOTICE_VERSION = '([^']+)'/)?.[1];
  assert(installer.includes(`!define PhotoFlowTermsVersion "${currentTermsVersion}"`) && installer.includes(`!define PhotoFlowPrivacyVersion "${currentPrivacyVersion}"`), 'installer receipt versions must match the application consent versions');
  assert(privacyService.includes('coreConsentRevokedAt') && privacyService.includes("coreConsentSource: 'interactive-installer'"), 'the application must import installer consent without allowing an old receipt to undo withdrawal');
  assert(!installer.includes('artifacts\\installers\\components'), 'base installer must not embed optional components');
  assert(!installer.includes('PhotoFlow-team-retouch-') && !installer.includes('PhotoFlowComponentPage'), 'application installer must not discover or offer team-retouch packages');
  assert(!installer.includes('nsisunz::Unzip') && !installer.includes('$INSTDIR\\components'), 'application installer must never write components into the program directory');
  assert(!installer.includes('$EXEDIR\\components') && !installer.includes('CopyFiles /SILENT'), 'installer-adjacent component folders and packages must not be supported');
  assert(!installer.includes('File /r "${PROJECT_DIR}\\artifacts\\installers\\components'), 'component binaries must not be compiled into the base installer');
  assert(installer.includes('customUnWelcomePage') && installer.includes('同时清空照片流的用户数据和注册表'), 'assisted uninstall must offer an explicit user-data cleanup option');
  assert(installer.includes('${NSD_Uncheck} $PhotoFlowDeleteUserDataCheckbox'), 'destructive uninstall cleanup must be opt-in');
  assert(installer.includes('RMDir /r "$APPDATA\\Photoflow"') && installer.includes('RMDir /r "$LOCALAPPDATA\\PhotoFlow"'), 'opt-in cleanup must remove the application user-data and component roots');
  assert(installer.includes('--unregister PhotoFlowNative') && installer.includes('--unregister PhotoflowLab'), 'opt-in cleanup must unregister current and legacy app-owned WSL environments before deleting their disks');
  assert(installer.includes('DeleteRegKey HKCU "Software\\PhotoFlow"') && installer.includes('com.photoflow.toolkit'), 'opt-in cleanup must remove only PhotoFlow-specific registry state');
  assert(installer.includes('不会删除工作区、项目中的照片和视频'), 'uninstall cleanup must disclose that user project media remains untouched');

  const componentSystemIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  assert(componentSystemIpc.includes('resolvePreparedPackage(pluginService.installRoot'), 'component installation must scan the shared components root');
  assert(componentSystemIpc.includes('allowedRoot = pluginService.installRoot'), 'component package cleanup must remain confined to the shared components root');
  const settingsSource = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'settings', 'SettingsFeature.tsx'), 'utf8');
  assert(settingsSource.includes("kind: 'component'") && settingsSource.includes('删除已使用的安装包吗？'), 'component UI must offer optional package cleanup after installation');

  const componentBuilder = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'build-components.cjs'), 'utf8');
  assert(componentBuilder.includes('PhotoFlow-${id}-${manifest.version}-${process.platform}-${process.arch}.zip'));
  assert(componentBuilder.includes('existingName.startsWith(artifactPrefix)'), 'component packaging must remove stale standalone package versions');
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

  const advancedBridge = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'advanced_bridge.py'), 'utf8');
  assert(advancedBridge.includes('DEFAULT_DISTROS = ("PhotoFlowNative", "PhotoflowLab")'), 'advanced backend must support both WSL distribution names');
  assert(advancedBridge.includes('WSL_E_DISTRO_NOT_FOUND'), 'advanced backend must fall through only when a distribution is absent');
  assert(advancedBridge.includes('HCS/ERROR_PATH_NOT_FOUND'), 'advanced backend must skip a registered distro whose VHDX is missing');
  assert(advancedBridge.includes('PHOTOFLOW_WSL_DISTRO'), 'custom WSL distribution override must remain supported');
  assert(advancedBridge.includes('class AdvancedBatchSession'), 'batch retouch must keep advanced models resident for the batch lifetime');
  assert(advancedBridge.includes('payload_b64'), 'persistent WSL requests must preserve Unicode paths');
  const pairDetrScript = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'advanced', 'pairdetr_service.py'), 'utf8');
  const sam2Script = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'advanced', 'sam2_service.py'), 'utf8');
  assert(pairDetrScript.includes('parser.add_argument("--serve"'), 'PairDETR must expose persistent service mode');
  assert(sam2Script.includes('parser.add_argument("--serve"'), 'SAM 2.1 must expose persistent service mode');
  const teamRetouchEngine = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'team_retouch.py'), 'utf8');
  assert(teamRetouchEngine.includes('choices=("auto", "basic", "advanced")'), 'team-retouch must expose automatic, basic, and strict advanced modes');
  assert(teamRetouchEngine.includes('if advanced_mode == "advanced"'), 'strict advanced mode must not silently fall back');
  assert(teamRetouchEngine.includes('def probe_advanced_runtime()'), 'advanced installation must be verified by loading both production services');
  assert(teamRetouchEngine.includes('people = spatially_order_people(people)') && teamRetouchEngine.includes('def bounded_planning_box'), 'crowd numbering must be left-to-right and leaked masks must not control spatial grouping');

  const settingsFeature = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'settings', 'SettingsFeature.tsx'), 'utf8');
  assert(settingsFeature.includes('基础人物检测') && settingsFeature.includes('RTMDet'), 'settings must describe the basic person-detection engine');
  assert(settingsFeature.includes('PairDETR + SAM 2.1'), 'settings must describe the enhanced person-detection engine');
  assert(settingsFeature.includes('基础组件、身份识别模型和检测增强包统一放在这里') && settingsFeature.includes('ZIP 无需解压'), 'settings must explain which models and add-ons are included in the component');
  assert(settingsFeature.includes('支持 WSL CUDA 的 NVIDIA 显卡与驱动') && settingsFeature.includes('至少 35 GB 可用空间'), 'settings must disclose hard requirements for enhanced person detection');
  assert(settingsFeature.includes('至少 8 GB 显存和 16 GB 系统内存') && settingsFeature.includes('不作为安装门槛'), 'settings must distinguish performance recommendations from enforced requirements');
  assert(!settingsFeature.includes('AdaFace 来源') && !settingsFeature.includes('OSNet 来源'), 'model sources must live in open-source licenses instead of the install panel');
  assert(settingsFeature.includes('团片协作组件目录'), 'settings must expose one directory for all team-retouch packages');
  assert(!settingsFeature.includes('安装身份识别增强包') && settingsFeature.includes('安装检测增强包'), 'settings must only expose the optional detection add-on installer');
  assert(!settingsFeature.includes('统一组件安装包目录') && !settingsFeature.includes('高级安装包目录'), 'settings must not expose separate team-retouch package locations');
  assert.strictEqual((settingsFeature.match(/title="优先使用 GPU"/g) || []).length, 1, 'GPU preference must appear once');
  assert(settingsFeature.indexOf('title="优先使用 GPU"') < settingsFeature.indexOf('<TeamRetouchEngineSettings'), 'GPU preference must be the first team-retouch setting');
  assert(settingsFeature.includes('人物超过 4000 像素时选择保持尺寸或扩大裁剪'), '4000-pixel guidance must live with the oversize crop setting');
const teamRetouchManager = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'TeamRetouchManager.tsx'), 'utf8');
assert.match(teamRetouchManager, /dimension \/ scale/, '团片协作原图标记应使用代理图缩放比例反推原图尺寸');
assert(teamRetouchManager.includes('人物 {member.personIndex}'), '工作图预览应直接标出人物编号');
assert(teamRetouchManager.includes('InteractiveCropEditor'), '工作图范围应支持可视化拖动和缩放');
assert(teamRetouchManager.includes("cropEditor ? 'overflow-visible' : 'overflow-hidden'"), '范围编辑弹窗打开时不应被图片卡片裁切');
  assert(teamRetouchManager.includes('默认使用高级模型 · PairDETR + SAM 2.1') && teamRetouchManager.includes('当前使用基础模型 · RTMDet'), 'team-retouch workspace must disclose the automatically selected recognition model');
  assert(!teamRetouchManager.includes('aria-label="识别模式"') && !settingsFeature.includes('team-retouch-backend-mode') && !settingsFeature.includes('默认识别模式'), 'automatic recognition must not expose a redundant mode setting');
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
const layerProvider = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'LayerProvider.tsx'), 'utf8');
assert(teamRetouchManager.includes('useEscapeLayer(true, onClose, !busy)') && !teamRetouchManager.includes('dialogRef.current'), 'the identity confirmation dialog must use the shared Escape layer and stay open while saving');
assert(layerProvider.includes("event.key !== 'Escape'") && layerProvider.includes('layersRef.current') && layerProvider.includes('stopImmediatePropagation'), 'Escape handling must be centralized in a topmost-layer stack');
assert(teamRetouchManager.includes("taskFullyMarked ? '已标记' : '未标记'"), 'work-image status must distinguish marked and unmarked images without a redundant confirmation step');
assert(!teamRetouchManager.includes('确认无误'), 'recognition review must not require a redundant confirmation button');
assert(teamRetouchManager.includes('FullscreenImageViewer') && teamRetouchManager.includes('ImageZoomButton'), 'recognition images must support full-window viewing');
assert(teamRetouchManager.includes('Math.round(task.crop.width)') && teamRetouchManager.includes('Math.round(task.crop.height)') && teamRetouchManager.includes(' px'), 'work-image previews must display their dimensions');
assert(teamRetouchManager.includes('openNextUnmarkedIdentity') && teamRetouchManager.includes('未标记 {unmarkedIdentityCount}'), 'the unmarked counter must open the next unmarked person');
assert(teamRetouchManager.includes('uniqueIdentitySubjectsPerPhoto'), 'identity candidate selection must prevent duplicate assignments from the same photo');
  const personIdentityManager = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'PersonIdentityManager.tsx'), 'utf8');
  assert(personIdentityManager.includes('className="workflow-task-card p-3"') && !personIdentityManager.includes('last:border-0'), 'every workflow task card, including the final card, must retain its full outline');
  const teamOutputProgress = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'TeamRetouchOutputProgress.tsx'), 'utf8');
  const teamRetouchSteps = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'TeamRetouchSteps.tsx'), 'utf8');
  const projectWorkspace = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const marqueeAutoScroll = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'workspace', 'marquee-auto-scroll.ts'), 'utf8');
  const projectWorkspaceLifecycleSource = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'workspace', 'project-workspace-lifecycle.ts'), 'utf8');
  const compiledProjectWorkspaceLifecycle = ts.transpileModule(projectWorkspaceLifecycleSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const projectWorkspaceLifecycleModule = { exports: {} };
  new Function('module', 'exports', compiledProjectWorkspaceLifecycle)(projectWorkspaceLifecycleModule, projectWorkspaceLifecycleModule.exports);
  const { resolveProjectWorkspaceLifecycle } = projectWorkspaceLifecycleModule.exports;
  const pageIdentity = (pageId, overrides = {}) => ({ pageId, projectId: 'shared-project', projectPath: 'C:\\projects\\original', projectName: 'original', projectStatus: 'planning', ...overrides });
  const pageAIdentity = pageIdentity('page-a');
  const pageBIdentity = pageIdentity('page-b');
  assert.deepStrictEqual(resolveProjectWorkspaceLifecycle(undefined, pageAIdentity, '', 'selection'), { kind: 'initialize', relativePath: 'selection', resetNavigation: true });
  assert.deepStrictEqual(resolveProjectWorkspaceLifecycle(undefined, pageBIdentity, '', 'retouch'), { kind: 'initialize', relativePath: 'retouch', resetNavigation: true });
  const movedPageA = pageIdentity('page-a', { projectPath: 'D:\\archive\\renamed', projectName: 'renamed' });
  const movedPageB = pageIdentity('page-b', { projectPath: 'D:\\archive\\renamed', projectName: 'renamed' });
  assert.deepStrictEqual(resolveProjectWorkspaceLifecycle(pageAIdentity, movedPageA, 'selection/group-a', 'selection'), { kind: 'refresh', relativePath: 'selection/group-a', resetNavigation: false }, 'page A must retain its independently navigated folder after project rename or move');
  assert.deepStrictEqual(resolveProjectWorkspaceLifecycle(pageBIdentity, movedPageB, 'retouch/group-b', 'retouch'), { kind: 'refresh', relativePath: 'retouch/group-b', resetNavigation: false }, 'page B must retain its independently navigated folder after the same project rename or move');
  const statusChangedPageA = { ...movedPageA, projectStatus: 'delivered' };
  assert.deepStrictEqual(resolveProjectWorkspaceLifecycle(movedPageA, statusChangedPageA, 'selection/group-a', 'selection'), { kind: 'refresh', relativePath: 'selection/group-a', resetNavigation: false }, 'project status changes must refresh page A at its current folder');
  const shortcutPreviewStateModelSource = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'workspace', 'shortcut-preview-state-model.ts'), 'utf8');
  const compiledShortcutPreviewStateModel = ts.transpileModule(shortcutPreviewStateModelSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const shortcutPreviewStateModelModule = { exports: {} };
  new Function('module', 'exports', compiledShortcutPreviewStateModel)(shortcutPreviewStateModelModule, shortcutPreviewStateModelModule.exports);
  const { applyShortcutPreviewState } = shortcutPreviewStateModelModule.exports;
  const shortcutPath = 'C:\\project\\planning\\reference.lnk';
  const shortcutState = { shortcutTargetKind: 'folder', shortcutBroken: false };
  const shortcutEntry = updatedAt => ({ path: shortcutPath, relativePath: 'planning/reference.lnk', kind: 'shortcut', updatedAt });
  const currentFolderEntries = applyShortcutPreviewState([shortcutEntry(42)], shortcutPath, 42, shortcutState);
  assert.strictEqual(currentFolderEntries[0].shortcutTargetKind, 'folder', 'current-folder shortcut entries must receive resolved cover state');
  const currentProjectEntries = applyShortcutPreviewState([shortcutEntry(42)], shortcutPath, 42, shortcutState);
  assert.strictEqual(currentProjectEntries[0].shortcutTargetKind, 'folder', 'current-project filter entries must receive resolved cover state');
  const recursiveEntries = applyShortcutPreviewState([shortcutEntry(0)], shortcutPath, 42, shortcutState);
  assert.strictEqual(recursiveEntries[0].shortcutTargetKind, 'folder', 'recursive flat results with deferred timestamps must receive resolved cover state by path');
  const appSource = fs.readFileSync(path.join(repositoryRoot, 'src', 'App.tsx'), 'utf8');
  assert(teamRetouchSteps.includes('人物识别与标记') && teamRetouchSteps.includes('任务编排与返图') && !teamRetouchSteps.includes("id: 'people'"), 'team retouch must expose the integrated two-step workflow');
  assert(teamRetouchManager.includes('<TeamRetouchSteps') && personIdentityManager.includes('<TeamRetouchSteps'), 'all team-retouch panels must reuse the same step navigation');
  assert(!projectWorkspace.includes('团片协作菜单'), 'project toolbar must not expose a separate team-retouch dropdown menu');
  assert(projectWorkspace.includes('teamRetouchWorkflowGeneratedRef.current = Boolean(result.workflowGenerated)') && projectWorkspace.includes("setTeamRetouchStep(validTargets.length ? 'detect' : teamRetouchWorkflowGeneratedRef.current ? 'workflow' : 'detect')"), 'existing generated workflows must reopen on task scheduling while newly added images still start at person detection');
  assert(projectWorkspace.includes('const [directoryLoading, setDirectoryLoading]') && projectWorkspace.includes('role="status" aria-live="polite"') && projectWorkspace.includes('加载中…'), 'project browsing must distinguish directory loading from an empty directory');
  const markProgressSource = projectWorkspace.slice(projectWorkspace.indexOf('const openMarkProgress'), projectWorkspace.indexOf('useEffect(() => {', projectWorkspace.indexOf('const openMarkProgress')));
  assert(markProgressSource.indexOf('setProgressSetup(initialDraft)') < markProgressSource.indexOf('void loadProgressFolders().then'), 'mark-progress must open from cached data before refreshing progress folders');
  assert(markProgressSource.includes('current === initialDraft ? latestDraft : current'), 'background progress refresh must not overwrite a mark-progress draft after the user edits it');
  assert(projectWorkspace.includes('设为版本进度…') && projectWorkspace.includes('moveToRoot') && projectWorkspace.includes('registered.relativePath || relativePath'), 'the component must expose version adoption and consume the backend-confirmed root move; executable IPC/DB tests cover rollback and V0-free registration');
  const projectNavigator = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'ProjectNavigator.tsx'), 'utf8');
  assert(projectNavigator.includes('<FolderInput size={15}/>导入项目') && projectNavigator.includes('importExistingProject') && projectNavigator.includes('photoflow:imported-project-tracking:'), 'the split project-create action must import existing projects and continue into tracking onboarding');
  const fileTransferToast = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'background-tasks', 'FileTransferToast.tsx'), 'utf8');
  const taskToastModel = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'background-tasks', 'task-toast-model.ts'), 'utf8');
  const indexCss = fs.readFileSync(path.join(repositoryRoot, 'src', 'index.css'), 'utf8');
  const topToastStack = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'app', 'useTopToastStack.tsx'), 'utf8');
  assert(projectNavigator.includes('cancelExistingProjectImport') && projectNavigator.includes('cancelBackgroundTask(existingProjectImportTask.id)') && indexCss.includes('z-index:510'), 'existing-project imports must remain cancellable from both the modal and the transfer toast above its backdrop');
  assert(fileTransferToast.includes('aria-label="缩小到后台"') && fileTransferToast.includes('onMinimize(task.id)') && fileTransferToast.includes('isTaskToastMinimized(task.id)') && fileTransferToast.includes('selectProjectFileTaskToasts(backgroundTasks, minimizedTaskIds)'), 'each active file-transfer toast must minimize without cancelling and stay hidden until restored');
  assert(fileTransferToast.includes('selectProjectFileTaskToasts') && taskToastModel.includes("task.type === 'project-file-operation'") && !taskToastModel.includes("operation === 'paste'"), 'all active project file operations must use one task-type based toast eligibility rule');
  assert(taskToastModel.includes("left.state === 'running' ? -1 : 1") && taskToastModel.includes('left.createdAt - right.createdAt') && taskToastModel.includes('eligible.slice(0, limit)') && fileTransferToast.includes('还有 {overflowCount} 个任务'), 'the transfer toast model must prioritize running tasks, preserve creation order, and cap visible cards');
  assert(indexCss.includes('.top-toast-stack') && indexCss.includes('display:flex') && indexCss.includes('gap:.75rem') && indexCss.includes('.app-notice-toast') && fileTransferToast.includes('previousTop - top') && fileTransferToast.includes('element.animate(') && !fileTransferToast.includes('style={{ top:') && !fileTransferToast.includes('className="fixed'), 'ordinary notices and file tasks must share one gap-based top stack and animate actual layout movement without per-card positioning');
  assert(topToastStack.includes('enqueueTopToastNotice') && topToastStack.includes('notice.count > 1') && topToastStack.includes('dismissNotice(notice.id)'), 'persistent notices must use the bounded merge model while retaining per-toast manual dismissal');
  assert(projectWorkspace.includes("entry.kind !== 'folder' && entry.kind !== 'shortcut'") && projectWorkspace.includes('browseProjectShortcutPreview(workspacePath, project.status, project.name, entry.relativePath)') && projectWorkspace.includes('shortcut:${entry.relativePath}:${entry.updatedAt}'), 'folder covers must lazily load project folders and shortcut folders through separate bounded APIs and versioned cache keys');
  assert(projectWorkspace.includes("entry.shortcutTargetKind === 'folder'") && projectWorkspace.includes('<FolderCover entry={entry}') && projectWorkspace.includes('shortcut-cover-badge') && projectWorkspace.includes('ArrowUpRight'), 'folder shortcuts must reuse the normal folder cover with a shortcut badge');
  assert(projectWorkspace.includes('entry.shortcutBroken') && projectWorkspace.includes('AlertTriangle') && indexCss.includes('.shortcut-folder-cover.is-broken'), 'broken shortcut folders must use a gray folder treatment with a warning badge');
  assert(projectWorkspace.includes('setFileEntries(applyState)') && projectWorkspace.includes('setScopeEntries(applyState)') && projectWorkspace.includes('setSearchEntries(applyState)') && projectWorkspace.includes('directoryEntriesCacheRef.current.set(directoryKey, next)'), 'shortcut cover resolution must update current-folder, current-project, recursive, and cached directory entries');
  assert(projectWorkspace.includes('pageId: string') && projectWorkspace.includes('initialRelativePath =') && projectWorkspace.includes('useState(initialRelativePath)') && projectWorkspace.includes('onDirectoryChange?.(pageId, relativePath)'), 'each project page instance must own its initial directory and report navigation by page id');
  assert(projectWorkspace.includes('resolveProjectWorkspaceLifecycle(projectLifecycleRef.current') && projectWorkspace.includes("if (lifecycle.kind === 'refresh')") && projectWorkspace.includes('refresh(lifecycle.relativePath)') && projectWorkspace.includes("if (lifecycle.kind === 'none') return"), 'project metadata changes must refresh the current page path without re-running page initialization');
  assert(projectWorkspace.includes('在新页面打开') && projectWorkspace.includes('onOpenDirectoryPage?.(entry.relativePath)') && projectWorkspace.includes("!fileMenu.entry.viaShortcut"), 'project folders must open independent pages without granting that action to shortcut content');
  const projectVersionTree = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'ProjectVersionTree.tsx'), 'utf8');
  assert(projectVersionTree.includes('structureEntries = entries') && projectWorkspace.includes('structureEntries={fileEntries}'), 'version-tree structure must remain independent from search and filter results');
  assert(appSource.includes("'project-version'") && appSource.includes("'project-team'") && projectWorkspace.includes("onOpenToolTab('version'") && projectWorkspace.includes("onOpenToolTab('team'"), 'version management and team retouch must open in reusable project tool tabs');
  assert(appSource.includes('ownerPageId: string; projectId: string') && appSource.includes('openWorkspaceToolTab(pageId, project, kind, label)') && projectWorkspace.includes('onOpenToolTab?.(pageId, kind, label)'), 'project tool tabs must retain the page instance that opened them');
  assert(appSource.includes('closeWorkspaceToolTab(pageId, kind)') && appSource.includes('updateWorkspaceToolTabBusy(pageId, kind, busy)') && projectWorkspace.includes('onToolTabBusyChange?.(pageId, kind, busy)'), 'tool close and busy callbacks must remain scoped to their owner page');
  const inspirationLibrary = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'inspiration', 'InspirationLibrary.tsx'), 'utf8');
  assert(appSource.includes("page.kind === 'inspiration'") && appSource.includes('inspirationTabId(page.id)') && appSource.includes('key={page.id}') && inspirationLibrary.includes('initialRelativePath={initialRelativePath}'), 'each inspiration page must mount a stateful browser instance under its own page id');
  assert(inspirationLibrary.includes('onDirectoryChange(pageId, relativePath)') && !inspirationLibrary.includes('navigationRequest?:'), 'inspiration navigation must update only the owning page instead of a singleton navigation request');
  assert(projectWorkspace.includes("useState<ProjectFilterScope>('current-folder')") && projectWorkspace.includes("changeFilterScope('current-folder')") && projectWorkspace.includes("changeFilterScope('project-root')"), 'each file-browser page must own a current-folder/project-root filter scope');
  assert(projectWorkspace.includes('browserContext.rootFilterLabel') && projectWorkspace.includes('当前文件夹'), 'the shared filter menu must use project and inspiration-specific scope labels');
  assert(projectWorkspace.includes("window.electronAPI.listProjectFiles(workspacePath, project.status, project.name, '', FILE_LIST_PAGE_SIZE") && projectWorkspace.includes('window.electronAPI.cancelListProjectFiles'), 'project-root filtering must use the cancellable paginated file-list API');
  assert(appSource.includes('photoflow:components-cache') && appSource.includes('componentsLoading={componentsLoading}'), 'installed component state must be restored before opening a project');
  assert(projectWorkspace.includes('teamRetouchInstalled || componentsLoading'), 'the team-retouch toolbar entry must render immediately while component status is refreshing');
  assert(personIdentityManager.includes('批量导入返图并识别'), 'workflow must expose batch returned-image recognition');
  assert(personIdentityManager.includes('<TeamOutputProgressPicker'), 'only the workflow step must choose the final merge destination');
  assert(teamOutputProgress.includes('controller.progressOptions') && teamOutputProgress.includes('disabled={option.disabled}'), 'the merge destination picker must display every progress version and disable invalid targets');
  assert(personIdentityManager.includes('workspace.photos.map(photo => photo.sourcePath)'), 'the merge destination boundary must include every source version in a mixed team workspace');
  assert(personIdentityManager.includes('合成已完成图片'), 'workflow must perform final image merging');
  assert(personIdentityManager.includes('generateTeamWorkflow'), 'workflow must generate its project-local week and identity folders');
  assert(personIdentityManager.includes('打开任务文件夹'), 'generated workflow groups must open their persistent project folders');
  assert(personIdentityManager.includes('删除并重新生成'), 'workflow regeneration must require destructive confirmation');
  assert(personIdentityManager.includes('returnTeamWorkflowBatch'), 'workflow batch returns must use the dedicated non-merging import path');
  assert(personIdentityManager.includes('taskOrder: workflow'), 'workflow returns must send the exact displayed hand-off order');
  assert(!personIdentityManager.includes('subjects.filter(subject => !subject.task.needsReview)'), 'suggested-review work images must remain available in the downstream workflow planner');
  assert(personIdentityManager.includes('sameWeekIdentityIds') && personIdentityManager.includes("? '＋' : '→'") && personIdentityManager.includes('toggleSameWeekIdentity'), 'priority labels must switch between same-week and next-week scheduling');
  assert(!personIdentityManager.includes('const workflowOrderLocked = Boolean(workspace.workflowGenerated)') && personIdentityManager.includes('流程已生成 · 仍可调整顺序') && personIdentityManager.includes('排期已调整 · 请重新生成'), 'a generated workflow must remain reorderable until a return or completion starts real work');
  assert(personIdentityManager.includes('workflowNeedsRegeneration') && personIdentityManager.includes('const workflowReady = Boolean'), 'workflow execution must pause after reordering until its folders are regenerated');
  assert(!personIdentityManager.includes('无需修图') && !personIdentityManager.includes('setTeamWorkflowNoRetouch'), 'workflow tasks must always be generated before the user decides whether to upload a return');
  assert(personIdentityManager.includes('}上传</button>') && personIdentityManager.includes('删除返图') && personIdentityManager.includes('撤销不用修'), 'workflow task actions must expose compact upload and reversible no-retouch states');
  assert(personIdentityManager.includes('标记本周不用修') && personIdentityManager.includes('markWeekNoRetouch'), 'each workflow person lane must scope bulk no-retouch completion to the displayed week');
  assert(personIdentityManager.includes('WorkflowReturnReviewDialog') && personIdentityManager.includes("['side-by-side', '并排']") && personIdentityManager.includes('确认匹配并完成'), 'workflow batch returns must provide visual photo comparison and in-place confirmation');
  const workflowReturnDialog = personIdentityManager.slice(personIdentityManager.indexOf('const WorkflowReturnReviewDialog'), personIdentityManager.indexOf('type WorkflowItem'));
  assert(!workflowReturnDialog.includes('event.target === event.currentTarget') && workflowReturnDialog.includes('点击四周不会关闭'), 'the returned-image review dialog must never discard progress when its backdrop is clicked');
  assert(personIdentityManager.includes('getTeamWorkflowReturnReview') && personIdentityManager.includes('继续处理未确认返图') && personIdentityManager.includes('暂存并退出') && personIdentityManager.includes('放弃本批次'), 'unfinished returned-image reviews must persist and expose explicit resume, suspend, and discard actions');
  assert(personIdentityManager.includes('不是任务返图') && personIdentityManager.includes('ignoreTeamWorkflowReturnReview') && personIdentityManager.includes('没有任务被完成'), 'each unmatched returned image must be individually removable without forcing an incorrect task match');
  const returnImageLoader = personIdentityManager.slice(personIdentityManager.indexOf('const ReturnImage'), personIdentityManager.indexOf('const returnCandidates'));
  assert(returnImageLoader.includes("if (eager)") && returnImageLoader.indexOf('getMediaOriginal') < returnImageLoader.indexOf('getMediaThumbnail') && !returnImageLoader.includes("eager ? 1600"), 'full return comparison must load the original directly instead of depending on an oversized Shell thumbnail');
  const visualIdentityPicker = personIdentityManager.slice(personIdentityManager.indexOf('const handlePick'), personIdentityManager.indexOf("window.addEventListener('photoflow-team-person-pick'"));
  assert(!visualIdentityPicker.includes("tab !== 'people'") && visualIdentityPicker.includes("tab === 'workflow'") && visualIdentityPicker.indexOf('setAssigningSubject(subject)') < visualIdentityPicker.indexOf('getTeamIdentitySimilarities'), 'workflow thumbnails must open the visual identity picker immediately while protecting completed tasks');
  const versionsIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'versions-ipc.cjs'), 'utf8');
  assert(versionsIpc.includes("ipcMain.handle('workspace-media-rating-read-batch'") && versionsIpc.includes('Math.min(6, entries.length)') && versionsIpc.includes('requestedEntries.slice(0, 200)'), 'batch rating reads must be finite and use bounded HDD concurrency');
  assert(projectWorkspace.includes('getMediaRatings(batch.map') && projectWorkspace.includes('offset += 200') && projectWorkspace.includes('filterRatingSequenceRef.current') && projectWorkspace.includes('已检查 {filterRatingsCheckedCount} 个文件'), 'rating filters must read only enumerated batches, invalidate stale results, and expose progress');
  assert(projectWorkspace.includes('viewportPointToContentPoint({ x: event.clientX, y: event.clientY }') && projectWorkspace.includes('scrollLeft: container.scrollLeft') && projectWorkspace.includes('scrollTop: container.scrollTop'), 'marquee drag origins must be stored in file-column content coordinates');
  assert(projectWorkspace.includes('hitMarqueeIndices(selection, displayedFileEntries.length, layout)') && !projectWorkspace.includes('measuredEntryRects'), 'virtualized grid and list marquee selection must use logical index geometry');
  assert(projectWorkspace.includes('calculateFileGridGeometry(surfaceWidth, gridIconSize') && projectWorkspace.includes('calculateFileGridGeometry(surface.clientWidth, gridIconSize') && projectWorkspace.includes('gap: FILE_GRID_GAP'), 'virtual scrolling, marquee hit testing, and the rendered grid must share one content-box geometry model');
  assert(projectWorkspace.includes('onPointerCancel={cancelSelectionDrag}') && projectWorkspace.includes('onLostPointerCapture={cancelSelectionDrag}') && projectWorkspace.includes("window.addEventListener('blur', cancelSelectionDrag)"), 'pointer cancellation, capture loss, and window blur must clear marquee state');
  assert(indexCss.includes('.marquee-logical-canvas') && projectWorkspace.includes('overflow-auto') && projectWorkspace.includes('advanceMarqueeAutoScroll(container') && marqueeAutoScroll.includes('container.scrollTop =') && marqueeAutoScroll.includes('container.scrollLeft ='), 'the logical marquee canvas must support horizontal and vertical auto-scroll');
  assert(projectWorkspace.includes('scheduleDirectoryRefresh(result.affectedDirectories') && projectWorkspace.includes('pendingDirectoryRefreshesRef.current.add(normalized)') && projectWorkspace.includes('}, 180)'), 'file mutations and watcher events must coalesce targeted directory refreshes within 100-250ms');
  const ratingFilterEffect = projectWorkspace.slice(projectWorkspace.indexOf('filterRatingSequenceRef.current += 1'), projectWorkspace.indexOf('const displayedFileEntries'));
  assert(ratingFilterEffect.includes("ratingFilter === 'all'") && !ratingFilterEffect.includes('getMediaRating(entry.path)') && !ratingFilterEffect.includes('searchProjectFiles'), 'file-type-only filtering and an all-rating condition must not trigger per-file XMP scans');
  assert(versionsIpc.includes("workspace-team-workflow-return-review-get") && versionsIpc.includes("workspace-team-workflow-return-review-discard") && versionsIpc.includes("workspace-team-workflow-return-review-ignore") && versionsIpc.includes("workflow-return-reviews"), 'the main process must persist and manage unfinished workflow return review sessions');
  const workflowReturnBatchIpc = versionsIpc.slice(versionsIpc.indexOf("workspace-team-workflow-return-batch"), versionsIpc.indexOf("workspace-team-workflow-return-confirm"));
  assert(workflowReturnBatchIpc.indexOf('mkdir(reviewTarget.reviewRoot') < workflowReturnBatchIpc.indexOf('pluginService.runJson(') && workflowReturnBatchIpc.indexOf('mkdir(reviewTarget.reviewRoot') < workflowReturnBatchIpc.indexOf('mkdir(stagingDirectory'), 'the workflow return review parent directory must be verified before matching or completing any task');
  assert(versionsIpc.includes('const requestedSameWeekIdentityIds = new Set((settings.sameWeekIdentityIds || []).map(String))') && versionsIpc.includes('const generatedSameWeekSet = new Set(') && versionsIpc.includes('generatedOrder.slice(1).filter(identityId => generatedSameWeekSet.has(identityId))'), 'same-week workflow settings must compare semantic membership instead of persisted array order');
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
  assert((versionsIpc.match(/const requestedMode = 'auto';/g) || []).length === 2 && !versionsIpc.includes('request.backendMode') && !versionsIpc.includes('personDetection.backendMode'), 'all team-retouch detection paths must automatically prefer advanced and fall back to basic');
  assert(versionsIpc.includes('compareProgressKeys(progress.versionKey, sourceProgress.versionKey) <= 0'), 'team-retouch merges must reject the current source progress and every earlier progress');
  assert(versionsIpc.includes('合成结果不能写回当前来源进度'), 'team-retouch merges must reject the source folder as their output');
  assert(versionsIpc.includes("ipcMain.handle('workspace-team-patch-open-folder'"), 'delivery and merged-result folders must have a scoped open action');
  assert(versionsIpc.includes("ipcMain.handle('workspace-team-workflow-return-batch'"), 'workflow batch returns must have a dedicated IPC handler');
  assert(versionsIpc.includes("ipcMain.handle('workspace-team-workflow-return-confirm'") && versionsIpc.includes('readyTeamWorkflowSubjects(workspace'), 'manual visual return confirmation must revalidate the selected workflow task in the main process');
  assert(versionsIpc.includes("ipcMain.handle('workspace-team-workflow-generate'"), 'workflow generation must have a dedicated IPC handler');
  assert(!versionsIpc.includes("ipcMain.handle('workspace-team-workflow-no-retouch'") && !versionsIpc.includes('syncWorkflowNoRetouchFile'), 'the removed no-retouch workflow must not leave a second completion path');
  assert(versionsIpc.includes('assignmentCompletion: { personIndex, completed: true }') && versionsIpc.includes('assignmentCompletion: { personIndex, completed: false'), 'single uploads and removals must update the return and completion state together');
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
    const template = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'extensions', component.id, 'component.template.json'), 'utf8'));
    assert.strictEqual(template.version, component.version, `${component.id} catalog and package versions must match`);
  }

  const systemIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  assert(systemIpc.includes("component.source !== 'user'"), 'only user-data components may be removed');
  assert(systemIpc.includes('await shell.trashItem(containerPath)'), 'component uninstall must recycle the complete component container');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-advanced-install'"), 'settings must be able to install or repair the advanced environment');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-advanced-preflight'"), 'settings must check offline prerequisites before installation');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-advanced-uninstall'"), 'settings must be able to remove the advanced environment');
  assert(!systemIpc.includes("ipcMain.handle('team-retouch-identity-models"), 'identity models must not retain a separate package installer');
  assert(systemIpc.includes("ipcMain.handle('components-delete-package'") && systemIpc.includes("path.extname(resolvedArchive).toLowerCase() !== '.zip'") && systemIpc.includes('await fs.promises.unlink(archivePath)'), 'confirmed package cleanup must only delete a validated ZIP from its component directory');
  assert(systemIpc.includes('packageSizeBytes'), 'successful installers must report the actual package size for cleanup confirmation');
  assert(systemIpc.includes("const teamRetouchRoot"), 'all team-retouch packages must share one component directory');
  assert(systemIpc.includes("path.join(teamRetouchRoot(), 'advanced')") && !systemIpc.includes("path.join(teamRetouchRoot(), 'identity-models')"), 'only the optional detection engine may retain a team-retouch add-on directory');
  assert(settingsFeature.includes('YuNet、AdaFace IR-18 与 OSNet x1.0') && !settingsFeature.includes('SFace') && !settingsFeature.includes('OSNet x0.25'), 'settings must expose the single enhanced cross-photo identity engine');
  assert(!settingsFeature.includes('实验人物识别模型 · 用户自备'), 'settings must not require end users to compile identity models');

  assert(componentBuilder.includes("'.cache', 'model-lab', 'adaface', 'adaface_ir18_webface4m.onnx") && componentBuilder.includes("'.cache', 'model-lab', 'osnet', 'osnet_x1_0_msmt17.onnx"), 'team-retouch component must contain both enhanced identity ONNX models');
  assert(!componentBuilder.includes('face_recognition_sface_2021dec.onnx') && !componentBuilder.includes('osnet_x0_25_msmt17.onnx'), 'team-retouch component must not contain the retired identity models');
  const teamRetouchTemplate = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'component.template.json'), 'utf8'));
  assert(teamRetouchTemplate.requiredFiles.includes('_internal/models/adaface_ir18_webface4m.onnx') && teamRetouchTemplate.requiredFiles.includes('_internal/models/osnet_x1_0_msmt17.onnx'), 'component installation must reject a package missing either enhanced identity model');
  const identityEngine = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'identity_engine.py'), 'utf8');
  assert(identityEngine.includes('self.face_backend = "adaface-ir18"') && identityEngine.includes('self.body_backend = "osnet-x1"'), 'identity runtime must report only the enhanced backends');
  assert(!identityEngine.includes('FaceRecognizerSF_create') && !identityEngine.includes('osnet-x0.25') && !identityEngine.includes('face_recognition_sface'), 'identity runtime must not retain the basic-model fallback');
  const modelLicenses = fs.readFileSync(path.join(repositoryRoot, 'src', 'licenses', 'modelLicenses.ts'), 'utf8');
  for (const modelName of ['AdaFace IR-18', 'OSNet x1.0', 'PairDETR', 'SAM 2.1 Hiera Large']) {
    assert(modelLicenses.includes(`name: '${modelName}'`), `open-source licenses must include ${modelName}`);
  }
  const softwareLicenses = fs.readFileSync(path.join(repositoryRoot, 'src', 'licenses', 'softwareLicenses.ts'), 'utf8');
  for (const dependency of ['照片流应用代码', 'Electron', 'Chromium', 'Node.js', 'React / React DOM', 'ExifTool', 'Python', 'PyInstaller', 'OpenCV / opencv-python-headless', 'ONNX Runtime DirectML', 'FFmpeg + x264 + x265 + zlib', 'PyTorch / TorchVision', 'NVIDIA CUDA 运行库']) {
    assert(softwareLicenses.includes(`name: '${dependency}'`), `third-party software notices must include ${dependency}`);
  }
  assert(softwareLicenses.includes("license: 'GPL-2.0-or-later'") && softwareLicenses.includes('libx264') && softwareLicenses.includes('libx265'), 'FFmpeg notice must disclose the fixed GPL x264/x265 build');
  assert(softwareLicenses.includes('上游代码授权未明确'), 'PairDETR redistribution uncertainty must remain visible');
  assert(settingsFeature.indexOf("['customer-data'") < settingsFeature.indexOf("['open-source'"), 'customer-data guidance must appear before open-source licenses');

  writeComponent(path.join(path.dirname(executablePath), 'components'), 'team-retouch', '99.0.0');
  writeComponent(path.join(resourcesPath, 'components'), 'team-retouch', '99.0.1');
  const registry = createComponentRegistry({
    resourcesPath,
    executablePath,
    projectRoot,
    userComponentRoot,
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
  });

  assert.strictEqual(registry.list().length, Object.keys(PLUGIN_DEFINITIONS).length);
  const advancedVideoManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'extensions', 'video-playback-mpv', 'component.template.json'), 'utf8'));
  assert.strictEqual(PLUGIN_DEFINITIONS['video-playback-mpv'].version, '26.8.3.1', 'the app must accept the latest published advanced-video component');
  assert.strictEqual(advancedVideoManifest.version, PLUGIN_DEFINITIONS['video-playback-mpv'].version, 'the advanced-video manifest and app compatibility pin must stay aligned');
  assert.strictEqual(registry.resolve('team-retouch'), null);
  assert.strictEqual(registry.resolve('office-media-extractor'), null);
  const installRoot = userComponentRoot;
  assert.strictEqual(registry.ensureInstallRoot(), installRoot);
  assert.deepStrictEqual(registry.roots, [{ source: 'user', path: installRoot }], 'packaged registry must only scan the user component root');

  assert.strictEqual(registry.resolve('research-tools'), null);

  const invalidDirectory = path.join(installRoot, 'team-retouch');
  fs.mkdirSync(invalidDirectory, { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'outside.exe'), 'outside');
  fs.writeFileSync(path.join(invalidDirectory, 'component.json'), JSON.stringify({
    apiVersion: 1,
    id: 'team-retouch',
    version: '26.7.30.1',
    entrypoints: { 'win32-x64': '..\\outside.exe' },
  }));
  const invalid = registry.inspect('team-retouch');
  assert.strictEqual(invalid.installed, false);
  assert.strictEqual(invalid.compatible, false);
  assert.match(invalid.error, /超出组件目录/);

  fs.rmSync(invalidDirectory, { recursive: true, force: true });
  writeComponent(path.join(installRoot, 'team-retouch'), 'runtime', '26.7.30.1', 'team-retouch.exe', 'team-retouch');
  const installed = registry.inspect('team-retouch');
  assert.strictEqual(installed.installed, true);
  assert.strictEqual(installed.source, 'user');
  assert.strictEqual(registry.resolve('team-retouch').command, path.join(installRoot, 'team-retouch', 'runtime', 'team-retouch.exe'));

  console.log('Component registry tests passed');
} finally {
  const resolved = path.resolve(sandbox);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(resolved, { recursive: true, force: true });
}

require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'test-recent-files-active-pagination.cjs')], { stdio: 'inherit' });
