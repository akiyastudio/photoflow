const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');
const { createComponentRegistry, readComponentPackageManifest } = require('../electron/component-registry.cjs');
const { createComponentIntegrityManifest } = require('../electron/component-integrity.cjs');
const { decideComponentStatusRefresh } = require('../electron/services/component-status-refresh-policy.cjs');
const { PLUGIN_DEFINITIONS } = require('../electron/plugins/plugin-catalog.cjs');
const { COMPONENT_RPC_METHODS } = require('../electron/component-rpc-contract.cjs');

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
const zipCrc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const writeStoredZip = (target, files) => {
  const local = []; const central = []; let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name); const data = Buffer.from(raw); const crc = zipCrc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBuffer.length, 26);
    local.push(header, nameBuffer, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(nameBuffer.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, nameBuffer); offset += header.length + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(target, Buffer.concat([...local, centralBuffer, end]));
};

const run = async () => {
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
  assert(componentSystemIpc.includes('pluginService.resolvePackage(componentId)'), 'component installation must use the dynamically discovered package catalog');
  assert(componentSystemIpc.includes('allowedRoot = pluginService.installRoot'), 'component package cleanup must remain confined to the shared components root');
  assert(componentSystemIpc.includes('await pluginService.verifyComponentDirectoryAsync(componentId, componentRoot, true)'), 'native components must be integrity checked asynchronously before installation');
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
  assert(advancedInstaller.includes('ExpectedAdvancedRuntimeApiVersion') && advancedInstaller.includes('advancedRuntimeApiVersion'), 'advanced packages must be checked by an API version independent from the component release');
  assert(advancedInstaller.includes('CompatibleLegacyComponentVersions') && advancedInstaller.includes('reviewed compatibility list'), 'only explicitly reviewed legacy advanced packages may bypass the new API field');
  assert(advancedInstaller.includes('--import-in-place'), 'verified offline VHD must be imported in place');
  assert(!advancedInstaller.includes('curl.exe'), 'end-user advanced setup must never download from the network');
  assert(!advancedInstaller.includes('https://'), 'end-user advanced setup must not contain network package sources');
  const offlinePackageBuilder = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'create-team-retouch-advanced-offline-package.ps1'), 'utf8');
  assert(offlinePackageBuilder.includes('--export') && offlinePackageBuilder.includes('--vhd'), 'deployment tooling must export a complete verified WSL disk');
  assert(offlinePackageBuilder.includes('advancedRuntimeApiVersion') && offlinePackageBuilder.includes('AdvancedRuntimeApiVersion'), 'new advanced packages must publish their independent runtime API version');

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
  const projectPreload = fs.readFileSync(path.join(repositoryRoot, 'electron', 'preload.cjs'), 'utf8');
  const teamRenderer = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'renderer', 'src', 'main.tsx'), 'utf8')
    + fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'renderer', 'src', 'interaction-model.ts'), 'utf8');
  const teamSdk = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'renderer', 'src', 'sdk.ts'), 'utf8');
  const componentRpcContract = fs.readFileSync(path.join(repositoryRoot, 'electron', 'component-rpc-contract.cjs'), 'utf8');
  const componentPreload = fs.readFileSync(path.join(repositoryRoot, 'electron', 'component-preload.cjs'), 'utf8');
  const teamTemplate = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'component.template.json'), 'utf8'));
  for (const legacyUi of ['TeamRetouchManager.tsx', 'PersonIdentityManager.tsx', 'TeamRetouchSteps.tsx', 'TeamRetouchOutputProgress.tsx', 'useTeamOutputProgress.ts']) {
    assert(!fs.existsSync(path.join(repositoryRoot, 'src', 'components', legacyUi)), `${legacyUi} must not remain in the application renderer`);
  }
  assert(!settingsFeature.includes("activeSection === 'team-retouch'") && !settingsFeature.includes('TeamRetouchEngineSettings'), 'application settings must only retain generic component management');
  assert(!projectPreload.includes('workspace-team-') && !projectPreload.includes('TeamRetouch'), 'the application preload must not expose team-retouch APIs or events');
  assert(teamRenderer.includes("export type Tab = 'detect' | 'people' | 'workflow' | 'returns' | 'merge' | 'settings'") && teamRenderer.includes('workflowGroups') && teamRenderer.includes('team.workflow.return-batch.v1'), 'the React component renderer must own the complete collaboration UI and workflow orchestration');
  assert(teamSdk.includes('allowedMethods') && teamSdk.includes('window.photoFlowComponent.rpc') && !teamSdk.includes('electronAPI') && !teamSdk.includes('ipcRenderer'), 'the component renderer must depend only on its restricted SDK');
  assert(componentRpcContract.includes('sanitizePayload') && componentRpcContract.includes('fields:') && componentRpcContract.includes('manager.registerRpcMethod') && componentRpcContract.includes("'team-retouch'"), 'component RPC methods must have payload field allowlists and a component owner');
  assert(componentPreload.includes('COMPONENT_EVENTS') && !componentPreload.includes("exposeInMainWorld('electronAPI'"), 'component events must use a closed topic map without the application bridge');
  assert(teamTemplate.componentHost.contributions.some(item => item.type === 'component.fullPage' && item.entry === 'ui/index.html'), 'team-retouch manifest must declare its packaged renderer entry');
  assert(teamTemplate.displayName === '团片协作' && teamTemplate.icon === 'ui/team-retouch.svg', 'team-retouch package must own its copy and icon');
  const projectWorkspace = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const marqueeAutoScroll = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'workspace', 'marquee-auto-scroll.ts'), 'utf8');
  const projectWorkspaceLifecycleSource = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'workspace', 'project-workspace-lifecycle.ts'), 'utf8');
  const compiledProjectWorkspaceLifecycle = ts.transpileModule(projectWorkspaceLifecycleSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const projectWorkspaceLifecycleModule = { exports: {} };
  new Function('module', 'exports', compiledProjectWorkspaceLifecycle)(projectWorkspaceLifecycleModule, projectWorkspaceLifecycleModule.exports);
  const { PROJECT_BACKGROUND_LOAD_DELAYS_MS, PROJECT_WATCH_RECONCILE_COOLDOWN_MS, isForegroundDirectoryRefresh, resolveProjectWorkspaceLifecycle, shouldReconcileProjectWatch } = projectWorkspaceLifecycleModule.exports;
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
  assert(PROJECT_BACKGROUND_LOAD_DELAYS_MS.progress < PROJECT_BACKGROUND_LOAD_DELAYS_MS.watcher
    && PROJECT_BACKGROUND_LOAD_DELAYS_MS.watcher < PROJECT_BACKGROUND_LOAD_DELAYS_MS.clipboard
    && PROJECT_BACKGROUND_LOAD_DELAYS_MS.clipboard < PROJECT_BACKGROUND_LOAD_DELAYS_MS.drives,
  'non-critical project services must start in a staggered order after the first directory paint');
  assert.strictEqual(shouldReconcileProjectWatch(0, 10_000), true, 'the first project watcher install must reconcile missed changes');
  assert.strictEqual(shouldReconcileProjectWatch(10_000, 10_000 + PROJECT_WATCH_RECONCILE_COOLDOWN_MS - 1), false, 'quick tab reactivation must reuse the recent reconciliation');
  assert.strictEqual(shouldReconcileProjectWatch(10_000, 10_000 + PROJECT_WATCH_RECONCILE_COOLDOWN_MS), true, 'an older watcher reconciliation must be refreshed');
  assert.strictEqual(shouldReconcileProjectWatch(10_000, 10_001, true), true, 'external-link changes and degraded watcher recovery must force reconciliation');
  assert.strictEqual(isForegroundDirectoryRefresh('图片选片', '图片选片', 'C:\\projects\\original', 'C:\\projects\\original'), true, 'the visible directory refresh must own its loading state');
  assert.strictEqual(isForegroundDirectoryRefresh('', '图片选片', 'C:\\projects\\original', 'C:\\projects\\original'), false, 'a root refresh requested after version marking must not take over a visible child directory');
  assert.strictEqual(isForegroundDirectoryRefresh('图片选片', '图片选片', 'C:\\projects\\original', 'D:\\archive\\moved'), false, 'a request for an obsolete project location must not update the visible directory');
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
  assert(!projectWorkspace.includes('TeamRetouch') && !projectWorkspace.includes('teamRetouch') && !projectWorkspace.includes('团片协作'), 'the project workspace must contain no legacy team-retouch UI or entry');
  assert(projectWorkspace.includes('const [directoryLoading, setDirectoryLoading]') && projectWorkspace.includes('role="status" aria-live="polite"') && projectWorkspace.includes('加载中…'), 'project browsing must distinguish directory loading from an empty directory');
  assert(projectWorkspace.includes('foregroundDirectoryReady') && projectWorkspace.includes('scheduleAfterProjectPaint(PROJECT_BACKGROUND_LOAD_DELAYS_MS.progress') && projectWorkspace.includes('scheduleAfterProjectPaint(PROJECT_BACKGROUND_LOAD_DELAYS_MS.watcher'), 'directory content must paint before progress and watcher reconciliation cold-start');
  const markProgressSource = projectWorkspace.slice(projectWorkspace.indexOf('const openMarkProgress'), projectWorkspace.indexOf('useEffect(() => {', projectWorkspace.indexOf('const openMarkProgress')));
  assert(markProgressSource.indexOf('setProgressSetup(initialDraft)') < markProgressSource.indexOf('void loadProgressFolders().then'), 'mark-progress must open from cached data before refreshing progress folders');
  assert(markProgressSource.includes('current === initialDraft ? latestDraft : current'), 'background progress refresh must not overwrite a mark-progress draft after the user edits it');
  assert(projectWorkspace.includes('标记…') && projectWorkspace.includes('<FolderMarkPanel') && projectWorkspace.includes('moveToRoot') && projectWorkspace.includes('registered.relativePath || targetRelativePath'), 'the component must expose unified purpose marking and consume the backend-confirmed root move; executable IPC/DB tests cover rollback and parent-required registration');
  const projectNavigator = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'ProjectNavigator.tsx'), 'utf8');
  assert(projectNavigator.includes('<FolderInput size={15}/>导入项目') && projectNavigator.includes('importExistingProject') && projectNavigator.includes('photoflow:imported-project-tracking:'), 'the split project-create action must import existing projects and continue into tracking onboarding');
  const fileTransferToast = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'background-tasks', 'FileTransferToast.tsx'), 'utf8');
  const taskToastModel = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'background-tasks', 'task-toast-model.ts'), 'utf8');
  const indexCss = fs.readFileSync(path.join(repositoryRoot, 'src', 'index.css'), 'utf8');
  const topToastStack = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'app', 'useTopToastStack.tsx'), 'utf8');
  assert(projectNavigator.includes('cancelExistingProjectImport') && projectNavigator.includes('cancelBackgroundTask(existingProjectImportTask.id)') && indexCss.includes('z-index:510'), 'existing-project imports must remain cancellable from both the modal and the transfer toast above its backdrop');
  assert(fileTransferToast.includes('aria-label="收起到任务中心"') && fileTransferToast.includes('onMinimize(task.id)') && fileTransferToast.includes('isTaskToastMinimized(task.id)') && fileTransferToast.includes('selectProjectFileTaskToasts(backgroundTasks, minimizedTaskIds, 4, clock)'), 'each active file-transfer toast must minimize without cancelling and stay hidden until restored');
  assert(fileTransferToast.includes('aria-label="暂停任务"') && fileTransferToast.includes("(task.state === 'running' || task.state === 'resuming') && task.capabilities.pausable") && fileTransferToast.includes('aria-label="继续任务"') && fileTransferToast.includes('(paused || pausing) && task.capabilities.pausable') && fileTransferToast.includes('aria-label="取消任务"') && !fileTransferToast.includes('<span>后台</span>') && !fileTransferToast.includes('>暂停</button>') && !fileTransferToast.includes('>继续</button>') && !fileTransferToast.includes('>取消</button>'), 'toast task actions must stay icon-only, show pause only while pausing is available, and replace it with continue after pausing');
  assert(fileTransferToast.includes('selectProjectFileTaskToasts') && taskToastModel.includes("task.type === 'project-file-operation'") && !taskToastModel.includes("operation === 'paste'"), 'all active project file operations must use one task-type based toast eligibility rule');
  assert(taskToastModel.includes("task.state === 'running' || task.state === 'resuming' ? 0") && taskToastModel.includes('left.createdAt - right.createdAt') && taskToastModel.includes('eligible.slice(0, limit)') && taskToastModel.includes('mergeBackgroundTaskSnapshots') && taskToastModel.includes('limit - retained.length') && fileTransferToast.includes('还有 {overflowCount} 个任务'), 'the transfer toast model must prioritize running tasks, preserve creation order, cap visible cards, and retain active tasks ahead of bounded history');
  assert(indexCss.includes('.top-toast-stack') && indexCss.includes('display:flex') && indexCss.includes('gap:.75rem') && indexCss.includes('.app-notice-toast') && fileTransferToast.includes('previousTop - top') && fileTransferToast.includes('element.animate(') && !fileTransferToast.includes('style={{ top:') && !fileTransferToast.includes('className="fixed'), 'ordinary notices and file tasks must share one gap-based top stack and animate actual layout movement without per-card positioning');
  assert(topToastStack.includes('enqueueTopToastNotice') && topToastStack.includes('notice.count > 1') && topToastStack.includes('dismissNotice(notice.id)'), 'persistent notices must use the bounded merge model while retaining per-toast manual dismissal');
  assert(projectWorkspace.includes("entry.kind !== 'folder' && entry.kind !== 'shortcut'") && projectWorkspace.includes('browseProjectShortcutPreview(workspacePath, project.status, project.name, entry.relativePath)') && projectWorkspace.includes('shortcut:${entry.relativePath}:${entry.updatedAt}'), 'folder covers must lazily load project folders and shortcut folders through separate bounded APIs and versioned cache keys');
  assert(projectWorkspace.includes("requestedSize, 1, queueOrder") && projectWorkspace.includes("result.state === 'NOT_READY' || result.state === 'QUEUED' || result.state === 'GENERATING'") && projectWorkspace.includes('FOLDER_COVER_THUMBNAIL_RETRY_DELAYS_MS'), 'visible folder covers must bypass the background-only queue cap and recover from a dropped or missed thumbnail completion');
  assert(projectWorkspace.includes("entry.shortcutTargetKind === 'folder') return <>") && projectWorkspace.includes('<FolderCover entry={entry}') && projectWorkspace.includes('aria-label="快捷方式" className="shortcut-cover-badge"') && projectWorkspace.includes('ArrowUpRight'), 'folder shortcuts must reuse the exact normal folder layout with an independently overlaid shortcut badge');
  assert(projectWorkspace.includes('const shortcutIcon = <ShortcutEntryIcon') && projectWorkspace.includes('relative flex h-full w-full min-h-0 min-w-0 items-center justify-center'), 'large shortcut icons must stay inside a fixed grid-square wrapper so their folder preview cannot push shortcut labels below ordinary file labels');
  assert(!projectWorkspace.includes("['raw', 'jpg', 'mov'].includes(displayName.toLocaleLowerCase())") && projectWorkspace.includes('title={displayName}>{displayName}</p>'), 'version-tree node names must preserve the original filename casing instead of forcing RAW, JPG, or MOV to uppercase');
  assert(projectWorkspace.includes('entry.shortcutBroken') && projectWorkspace.includes('AlertTriangle') && indexCss.includes('.shortcut-folder-cover.is-broken'), 'broken shortcut folders must use a gray folder treatment with a warning badge');
  assert(projectWorkspace.includes('setFileEntries(applyState)') && projectWorkspace.includes('setScopeEntries(applyState)') && projectWorkspace.includes('setSearchEntries(applyState)') && projectWorkspace.includes('directoryEntriesCacheRef.current.set(directoryKey, next)'), 'shortcut cover resolution must update current-folder, current-project, recursive, and cached directory entries');
  assert(projectWorkspace.includes('pageId: string') && projectWorkspace.includes('initialRelativePath =') && projectWorkspace.includes('useState(initialRelativePath)') && projectWorkspace.includes('onDirectoryChange?.(pageId, relativePath)'), 'each project page instance must own its initial directory and report navigation by page id');
  assert(projectWorkspace.includes('resolveProjectWorkspaceLifecycle(projectLifecycleRef.current') && projectWorkspace.includes("if (lifecycle.kind === 'refresh')") && projectWorkspace.includes('refresh(lifecycle.relativePath)') && projectWorkspace.includes("if (lifecycle.kind === 'none') return"), 'project metadata changes must refresh the current page path without re-running page initialization');
  assert(projectWorkspace.includes('在新标签页打开') && projectWorkspace.includes('onOpenDirectoryPage(entry.relativePath)') && projectWorkspace.includes('!isUnsupportedShortcutContent(fileMenu.entry)'), 'project, inspiration, and managed external folders must open independent tabs without granting that action to ordinary shortcut content');
  const projectVersionTree = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'ProjectVersionTree.tsx'), 'utf8');
  assert(projectVersionTree.includes('structureEntries = entries') && projectWorkspace.includes('structureEntries={fileEntries}'), 'version-tree structure must remain independent from search and filter results');
  assert(appSource.includes("'project-version'") && !appSource.includes("'project-team'") && projectWorkspace.includes("onOpenToolTab('version'"), 'version management must remain the only project-owned tool tab');
  assert(appSource.includes('ownerPageId: string; projectId: string') && appSource.includes('openWorkspaceToolTab(pageId, project, kind, label)') && projectWorkspace.includes('onOpenToolTab?.(pageId, kind, label)'), 'project tool tabs must retain the page instance that opened them');
  const inspirationLibrary = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'inspiration', 'InspirationLibrary.tsx'), 'utf8');
  assert(appSource.includes("page.kind === 'inspiration'") && appSource.includes('inspirationTabId(page.id)') && appSource.includes('key={page.id}') && inspirationLibrary.includes('initialRelativePath={initialRelativePath}'), 'each inspiration page must mount a stateful browser instance under its own page id');
  assert(inspirationLibrary.includes('onDirectoryChange(pageId, relativePath)') && inspirationLibrary.includes('navigationRequest={navigationRequest}'), 'inspiration navigation requests must stay scoped to the owning mounted page');
  assert(projectWorkspace.includes("useState<ProjectFilterScope>('current-folder')") && projectWorkspace.includes("changeFilterScope('current-folder')") && projectWorkspace.includes("changeFilterScope('project-root')"), 'each file-browser page must own a current-folder/project-root filter scope');
  assert(projectWorkspace.includes('browserContext.rootFilterLabel') && projectWorkspace.includes('当前文件夹'), 'the shared filter menu must use project and inspiration-specific scope labels');
  assert(projectWorkspace.includes("projectWorkspaceClient.listProjectFiles(workspacePath, project.status, project.name, '', FILE_LIST_PAGE_SIZE") && projectWorkspace.includes('projectWorkspaceClient.cancelListProjectFiles'), 'project-root filtering must use the typed, cancellable paginated file-list API');
  assert(appSource.includes('photoflow:components-cache') && appSource.includes('componentHostActions={componentHostActions}'), 'installed component state must drive the declarative component host action list');
  for (const requiredInteraction of ['检测全部', '逐人物身份确认', '确认人物组', '工作图上传', '拖拽排期', '生成工作流', '取消工作流', '导出人物任务', '选择返图文件', '逐张对比确认', '忽略返图', '选择合并目标进度', '合并到目标进度', '组件设置', '安装 / 修复', '卸载']) {
    assert(teamRenderer.includes(requiredInteraction), `the independent React renderer must retain ${requiredInteraction}`);
  }
  assert(teamRenderer.includes('IntersectionObserver') && teamRenderer.includes('onDeactivate') && teamRenderer.includes("event.key === 'Escape'"), 'preview loading, deactivation, and Escape handling must remain component-owned');
  const versionsIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'versions-ipc.cjs'), 'utf8');
  const teamService = fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'service.cjs'), 'utf8');
  assert(teamService.includes('workflowAvailableSubjectKeys') && teamService.includes('`${item.baseVersionId}:${Number(item.personIndex)}`'), 'the component backend must expose stable availability keys for generated workflow subjects');
  const mediaRatingIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'media-rating-ipc.cjs'), 'utf8');
  assert(mediaRatingIpc.includes("ipcMain.handle('workspace-media-rating-read-batch'") && mediaRatingIpc.includes('Math.min(6, entries.length)') && mediaRatingIpc.includes('requestedEntries.slice(0, 200)'), 'batch rating reads must be finite and use bounded HDD concurrency');
  assert(projectWorkspace.includes('getMediaRatings(batch.map') && projectWorkspace.includes('offset += 200') && projectWorkspace.includes('filterRatingSequenceRef.current') && projectWorkspace.includes('已检查 {filterRatingsCheckedCount} 个文件'), 'rating filters must read only enumerated batches, invalidate stale results, and expose progress');
  assert(projectWorkspace.includes('viewportPointToContentPoint({ x: event.clientX, y: event.clientY }') && projectWorkspace.includes('scrollLeft: container.scrollLeft') && projectWorkspace.includes('scrollTop: container.scrollTop'), 'marquee drag origins must be stored in file-column content coordinates');
  assert(projectWorkspace.includes('hitMarqueeIndices(selection, displayedFileEntries.length, layout)') && !projectWorkspace.includes('measuredEntryRects'), 'virtualized grid and list marquee selection must use logical index geometry');
  assert(projectWorkspace.includes('calculateFileGridGeometry(surfaceWidth, gridIconSize') && projectWorkspace.includes('calculateFileGridGeometry(surface.clientWidth, gridIconSize') && projectWorkspace.includes('gap: FILE_GRID_GAP'), 'virtual scrolling, marquee hit testing, and the rendered grid must share one content-box geometry model');
  assert(projectWorkspace.includes('onPointerCancel={cancelSelectionDrag}') && projectWorkspace.includes('onLostPointerCapture={cancelSelectionDrag}') && projectWorkspace.includes("window.addEventListener('blur', cancelSelectionDrag)"), 'pointer cancellation, capture loss, and window blur must clear marquee state');
  assert(indexCss.includes('.marquee-logical-canvas') && projectWorkspace.includes('overflow-auto') && projectWorkspace.includes('advanceMarqueeAutoScroll(container') && marqueeAutoScroll.includes('container.scrollTop =') && marqueeAutoScroll.includes('container.scrollLeft ='), 'the logical marquee canvas must support horizontal and vertical auto-scroll');
  assert(projectWorkspace.includes('scheduleDirectoryRefresh(result.affectedDirectories') && projectWorkspace.includes('pendingDirectoryRefreshesRef.current.add(normalized)') && projectWorkspace.includes('}, 180)'), 'file mutations and watcher events must coalesce targeted directory refreshes within 100-250ms');
  const ratingFilterEffect = projectWorkspace.slice(projectWorkspace.indexOf('filterRatingSequenceRef.current += 1'), projectWorkspace.indexOf('const displayedFileEntries'));
  assert(ratingFilterEffect.includes("ratingFilter === 'all'") && !ratingFilterEffect.includes('getMediaRating(entry.path)') && !ratingFilterEffect.includes('searchProjectFiles'), 'file-type-only filtering and an all-rating condition must not trigger per-file XMP scans');
  assert(teamService.includes('const reviewTarget') && teamService.includes('scope.reviewDirectory') && teamService.includes('reviewSessionCompleted'), 'the component service must persist and manage unfinished workflow return review sessions in its authorized scope');
  assert(teamService.indexOf('mkdir(path.dirname(target.directory)') < teamService.indexOf('mkdir(pending, { recursive: false })'), 'the workflow return review parent directory must be verified before matching or completing any task');
  assert(teamService.includes('const requestedSameWeek = new Set(uniqueText(settings.sameWeekIdentityIds))') && teamService.includes('const generatedSameWeek = new Set(uniqueText(generatedSettings?.sameWeekIdentityIds))') && teamService.includes('generatedOrder.slice(1).filter(id => generatedSameWeek.has(id))'), 'same-week workflow settings must compare semantic membership instead of persisted array order');
  const pluginService = fs.readFileSync(path.join(repositoryRoot, 'electron', 'services', 'plugin-service.cjs'), 'utf8');
  assert.equal((versionsIpc.match(/ipcMain\.handle\('workspace-team-/g) || []).length, 0, 'versions IPC must not register any legacy team handler');
  assert(!versionsIpc.includes('pluginService') && !versionsIpc.includes('shell.openPath'), 'team algorithms and arbitrary path opening must not remain in versions IPC');
  assert(!pluginService.includes('warmWorkers') && !pluginService.includes('stopWarm'), 'the plugin service must not retain a page-level warm model process');
  assert(pluginService.includes('registry.inspect(pluginId, { verifyIntegrity: false })'), 'component status queries must defer native payload hashing to the asynchronous detailed refresh');
  assert(teamService.includes('autoReleasedCount: clearAssignments.length') && teamService.includes("['manual', 'manual-group'].includes(current.source)"), 'manual identity selection must displace automatic same-photo candidates while preserving manual conflicts');
  assert(teamTemplate.componentHost.service.rpcMethods.filter(method => method.startsWith('team.')).every(method => !COMPONENT_RPC_METHODS[method]), 'every team RPC must have one service owner and no legacy mapping');
  for (const token of ['runAlgorithm', 'appendCommand', "state: 'prepared'", "state: 'rolled-back'", "'version.register.v1'", "'project.output.authorize.v1'"]) assert(teamService.includes(token), `component service must retain ${token}`);
  assert(teamService.includes("'--advanced-mode', 'auto'") && !teamService.includes('request.backendMode'), 'component-owned detection must automatically prefer advanced and fall back to basic');
  assert(teamService.includes("'team.workflow.return-batch.v1'") && teamService.includes("'team.workflow.return-confirm.v1'") && teamService.includes('readyWorkflowCandidates'), 'workflow return confirmation must be component-owned and revalidate the selected task');
  assert(teamService.includes("'team.workflow.generate.v1'"), 'workflow generation must have exactly one component-service owner');
  assert(teamService.includes("completed=1,completion_kind='retouched'") && teamService.includes("completed=0,completion_kind=''"), 'single uploads and removals must update the return and completion state together');
  assert(teamService.includes("path.resolve(project.rootPath, '团片协作')") || teamService.includes('scope.outputDirectory'), 'workflow output must remain inside the authorized project-local team-retouch folder');
  assert(teamService.includes("path.join(storage.dataRoot, 'workflows'") || teamService.includes('workflowDirectory'), 'workflow metadata must remain in component-owned workspace data');
  assert(teamService.includes('legacyManifestPath') || teamService.includes('artifact.migrate'), 'legacy project-local workflow metadata must migrate automatically');
  assert(teamService.includes('refreshDownstream('), 'returned edits must refresh generated downstream workflow files');
  assert(teamService.includes("type: 'recrop'") && teamService.includes('backupPath') && teamService.includes("state: 'rolled-back'"), 'recropping must stage replacement content and compensate after failure');
  assert(teamService.includes('readyWorkflowCandidates(snapshot, payload.items)'), 'workflow return matching must revalidate the currently unlocked person in the component service');
  assert(teamService.includes('current = await workspaceSnapshot(parentId, context);'), 'background identity matching must preserve manual decisions made while inference is running');
  assert(teamService.includes('readyWorkflowCandidates'), 'workflow return validation must reject incomplete or altered task orders in the component service');

  for (const component of Object.values(PLUGIN_DEFINITIONS)) {
    assert.match(component.version, /^\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/, `${component.id} must use the date revision version format`);
    const template = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'extensions', component.id, 'component.template.json'), 'utf8'));
    assert.strictEqual(template.version, component.version, `${component.id} catalog and package versions must match`);
    if (component.developmentEntry) {
      const developmentEntry = path.join(repositoryRoot, ...component.developmentEntry);
      assert(fs.existsSync(developmentEntry), `${component.id} development entry must exist`);
      for (const requiredAsset of component.requiredAssets || []) {
        assert(fs.existsSync(path.join(path.dirname(developmentEntry), ...requiredAsset)), `${component.id} development asset must exist: ${requiredAsset.join('/')}`);
      }
    }
  }

  const systemIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  assert(systemIpc.includes("component.source !== 'user'"), 'only user-data components may be removed');
  assert(systemIpc.includes('await shell.trashItem(containerPath)'), 'component uninstall must recycle the complete component container');
  assert(!systemIpc.includes("ipcMain.handle('team-retouch-advanced-install'") && !systemIpc.includes("ipcMain.handle('team-retouch-advanced-preflight'") && !systemIpc.includes("ipcMain.handle('team-retouch-advanced-uninstall'"), 'advanced environment actions must not retain system IPC routes');
  const lifecycleTemplate = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'component.template.json'), 'utf8'));
  assert(lifecycleTemplate.componentHost.service.rpcMethods.includes('component.advanced.install.v1') && lifecycleTemplate.componentHost.service.capabilities.includes('component.lifecycle.v1'), 'settings must use the component service lifecycle capability');
  assert(!systemIpc.includes("ipcMain.handle('team-retouch-identity-models"), 'identity models must not retain a separate package installer');
  assert(systemIpc.includes("ipcMain.handle('components-delete-package'") && systemIpc.includes("path.extname(resolvedArchive).toLowerCase() !== '.zip'") && systemIpc.includes('await fs.promises.unlink(archivePath)'), 'confirmed package cleanup must only delete a validated ZIP from its component directory');
  assert(systemIpc.includes('packageSizeBytes'), 'successful installers must report the actual package size for cleanup confirmation');
  assert(systemIpc.includes("const teamRetouchRoot"), 'all team-retouch packages must share one component directory');
  const componentLifecycleService = fs.readFileSync(path.join(repositoryRoot, 'electron', 'services', 'component-lifecycle-service.cjs'), 'utf8');
  assert(componentLifecycleService.includes('const advancedInstallRoot') && componentLifecycleService.includes("'advanced', 'wsl', 'PhotoFlowNative'") && componentLifecycleService.includes("'PhotoFlow', 'components', component.id") && !systemIpc.includes("path.join(teamRetouchRoot(), 'identity-models')"), 'only the component lifecycle may retain an optional detection-engine data directory and development must recognize the application-data installation');
  assert(teamRenderer.includes('人物身份') && teamRenderer.includes('自动生成候选') && !settingsFeature.includes("activeSection === 'team-retouch'"), 'cross-photo identity controls must be owned by the component renderer');
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

  assert.strictEqual(registry.list().length, 0, 'static compatibility definitions must not manufacture component UI entries');
  const advancedVideoManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'extensions', 'video-playback-mpv', 'component.template.json'), 'utf8'));
  assert.strictEqual(PLUGIN_DEFINITIONS['video-playback-mpv'].version, '26.8.16.1', 'the app must accept the latest published advanced-video component');
  assert.strictEqual(PLUGIN_DEFINITIONS['video-playback-mpv'].runtimeOnly, true, 'advanced video must be catalogued as a backend runtime only');
  assert.strictEqual(advancedVideoManifest.version, PLUGIN_DEFINITIONS['video-playback-mpv'].version, 'the advanced-video manifest and app compatibility pin must stay aligned');
  assert.deepStrictEqual(Object.keys(advancedVideoManifest.entrypoints), ['win32-x64'], 'advanced video must expose only its native decoder entrypoint');
  assert(!('renderer' in advancedVideoManifest) && !('contributes' in advancedVideoManifest), 'advanced video manifest must not contribute a renderer or UI');
  assert.strictEqual(registry.resolve('team-retouch'), null);
  assert.strictEqual(registry.resolve('office-media-extractor'), null);
  const installRoot = userComponentRoot;
  assert.strictEqual(registry.ensureInstallRoot(), installRoot);
  assert.deepStrictEqual(registry.roots, [{ source: 'user', path: installRoot }], 'packaged registry must only scan the user component root');

  const integrityComponent = writeComponent(
    installRoot,
    'video-playback-mpv',
    PLUGIN_DEFINITIONS['video-playback-mpv'].version,
    'advanced-video-decoder.exe',
  );
  fs.writeFileSync(path.join(integrityComponent, 'libmpv-2.dll'), 'test libmpv');
  fs.writeFileSync(path.join(integrityComponent, 'runtime-manifest.json'), '{}');
  const testIntegrity = createComponentIntegrityManifest(
    integrityComponent,
    'video-playback-mpv',
    PLUGIN_DEFINITIONS['video-playback-mpv'].version,
  );
  fs.writeFileSync(path.join(integrityComponent, 'component-integrity.json'), JSON.stringify(testIntegrity));
  const integrityRegistry = createComponentRegistry({
    projectRoot,
    userComponentRoot,
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
    integrityManifests: { 'video-playback-mpv': testIntegrity },
  });
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (filePath, ...args) => {
    if (path.resolve(String(filePath)) === path.resolve(integrityComponent, 'libmpv-2.dll')) {
      throw new Error('async integrity verification performed a synchronous payload read');
    }
    return originalReadFileSync(filePath, ...args);
  };
  try {
    assert.strictEqual(integrityRegistry.inspect('video-playback-mpv', { verifyIntegrity: false })?.installed, true);
    assert.strictEqual(integrityRegistry.resolve('video-playback-mpv')?.installed, true);
    assert.strictEqual((await integrityRegistry.resolveAsync('video-playback-mpv', { verifyIntegrity: true }))?.installed, true);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  fs.writeFileSync(path.join(integrityComponent, 'undeclared-helper.exe'), 'rogue executable');
  const undeclaredExecutable = (await integrityRegistry.listWithSizes()).find(component => component.id === 'video-playback-mpv');
  assert.strictEqual(undeclaredExecutable.status, 'integrity-invalid');
  assert.match(undeclaredExecutable.error, /未声明的可执行文件/);
  fs.rmSync(path.join(integrityComponent, 'undeclared-helper.exe'));
  fs.writeFileSync(path.join(integrityComponent, 'libmpv-2.dll'), 'tampered libmpv');
  const tampered = (await integrityRegistry.listWithSizes()).find(component => component.id === 'video-playback-mpv');
  assert.strictEqual(tampered.status, 'integrity-invalid');
  assert.match(tampered.error, /大小不匹配|SHA-256 不匹配/);
  fs.rmSync(integrityComponent, { recursive: true, force: true });

  writeComponent(
    path.join(projectRoot, 'extensions', 'video-playback-mpv'),
    'runtime',
    PLUGIN_DEFINITIONS['video-playback-mpv'].version,
    'advanced-video-decoder.exe',
    'video-playback-mpv',
  );
  const developmentRegistry = createComponentRegistry({
    projectRoot,
    isPackaged: false,
    platform: 'win32',
    arch: 'x64',
  });
  assert.deepStrictEqual(developmentRegistry.roots, [
    { source: 'development', path: path.join(projectRoot, 'extensions') },
    { source: 'development', path: path.join(projectRoot, 'components') },
  ], 'development registry must scan extension runtimes before the legacy component root');
  const developmentVideo = developmentRegistry.resolve('video-playback-mpv');
  assert.strictEqual(developmentVideo?.source, 'development');
  assert.strictEqual(developmentVideo?.path, path.join(projectRoot, 'extensions', 'video-playback-mpv', 'runtime'));

  assert(!fs.existsSync(path.join(repositoryRoot, 'extensions', 'team-retouch', 'component.json')), 'development registration must not generate a source component.json');
  const sourceDevelopmentRegistry = createComponentRegistry({ projectRoot: repositoryRoot, isPackaged: false, platform: 'win32', arch: 'x64' });
  const sourceTeamRetouch = sourceDevelopmentRegistry.inspect('team-retouch');
  assert.deepStrictEqual({ source: sourceTeamRetouch?.source, installed: sourceTeamRetouch?.installed, compatible: sourceTeamRetouch?.compatible }, { source: 'development', installed: true, compatible: true }, 'the checked-in component.template.json must register the development source component');
  assert.strictEqual(sourceTeamRetouch?.path, path.join(repositoryRoot, 'extensions', 'team-retouch'));
  assert.strictEqual(registry.list().some(component => component.id === 'team-retouch'), false, 'packaged registries must not discover source templates');

  assert.strictEqual(registry.resolve('research-tools'), null);

  const invalidDirectory = path.join(installRoot, 'team-retouch');
  fs.mkdirSync(invalidDirectory, { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'outside.exe'), 'outside');
  fs.writeFileSync(path.join(invalidDirectory, 'component.json'), JSON.stringify({
    apiVersion: 1,
    id: 'team-retouch',
    version: PLUGIN_DEFINITIONS['team-retouch'].version,
    entrypoints: { 'win32-x64': '..\\outside.exe' },
  }));
  const invalid = registry.inspect('team-retouch');
  assert.strictEqual(invalid.installed, true, 'a discovered but invalid installed directory remains visible for repair or uninstall');
  assert.strictEqual(invalid.compatible, false);
  assert.match(invalid.error, /路径不安全/);

  fs.rmSync(invalidDirectory, { recursive: true, force: true });
  writeComponent(path.join(installRoot, 'team-retouch'), 'runtime', PLUGIN_DEFINITIONS['team-retouch'].version, 'team-retouch.exe', 'team-retouch');
  const installed = registry.inspect('team-retouch');
  assert.strictEqual(installed.installed, true);
  assert.strictEqual(installed.source, 'user');
  assert.strictEqual(registry.resolve('team-retouch').command, path.join(installRoot, 'team-retouch', 'runtime', 'team-retouch.exe'));
  const teamRetouchToken = registry.componentIntegrityToken('team-retouch', installed.path);
  assert.match(teamRetouchToken, /^metadata\|/, 'a user component without an integrity manifest must still expose a reusable metadata token');
  const unchangedTeamRetouchToken = registry.componentIntegrityToken('team-retouch', installed.path);
  assert.strictEqual(unchangedTeamRetouchToken, teamRetouchToken, 'unchanged team-retouch metadata must remain reusable across refreshes');
  assert.strictEqual(decideComponentStatusRefresh({ integrityReusable: Boolean(unchangedTeamRetouchToken && unchangedTeamRetouchToken === teamRetouchToken), lastDetailedAt: Date.now(), lastDetailedAttemptAt: Date.now() }).shouldProbeRuntime, false, 'the real packaged team-retouch definition must not trigger a runtime probe before TTL expiry');
  fs.appendFileSync(path.join(installed.path, 'team-retouch.exe'), 'changed');
  assert.notStrictEqual(registry.componentIntegrityToken('team-retouch', installed.path), teamRetouchToken, 'entrypoint changes must invalidate the lightweight team-retouch token');

  fs.rmSync(path.join(installRoot, 'team-retouch'), { recursive: true, force: true });
  const unknownManifest = { apiVersion: 1, id: 'sample-dynamic', version: '2.0.0', displayName: 'Dynamic sample', description: 'catalog test', platforms: ['win32'], architectures: ['x64'], entrypoints: { 'win32-x64': 'sample.exe' } };
  const unknownZip = path.join(installRoot, 'arbitrary-package-name.zip');
  writeStoredZip(unknownZip, { 'sample-dynamic/runtime/component.json': JSON.stringify(unknownManifest), 'sample-dynamic/runtime/sample.exe': 'binary' });
  assert.strictEqual(readComponentPackageManifest(unknownZip).manifest.id, 'sample-dynamic');
  let discovered = registry.list();
  const pendingUnknown = discovered.find(component => component.id === 'sample-dynamic');
  assert.strictEqual(pendingUnknown?.status, 'pending-install', 'a compatible unknown component must be discovered from its manifest rather than a static allowlist');
  assert.strictEqual(pendingUnknown?.integrityStatus, 'unsigned', 'unsigned packages must state the actual conservative trust level');
  writeComponent(path.join(installRoot, 'sample-dynamic'), 'runtime', '1.0.0', 'sample.exe', 'sample-dynamic');
  discovered = registry.list();
  assert.strictEqual(discovered.find(component => component.id === 'sample-dynamic')?.status, 'update-available');
  fs.rmSync(unknownZip);
  assert.strictEqual(registry.list().find(component => component.id === 'sample-dynamic')?.status, 'installed', 'installed components remain visible after their ZIP is deleted');
  fs.rmSync(path.join(installRoot, 'sample-dynamic'), { recursive: true, force: true });
  assert(!registry.list().some(component => component.id === 'sample-dynamic'), 'components disappear when neither ZIP nor installed directory exists');

  const unsafeZip = path.join(installRoot, 'unsafe.zip');
  writeStoredZip(unsafeZip, { '../component.json': JSON.stringify(unknownManifest) });
  assert.throws(() => readComponentPackageManifest(unsafeZip), /不安全路径/);
  assert.strictEqual(registry.list().find(component => component.packagePath === unsafeZip)?.status, 'package-invalid');

  console.log('Component registry tests passed');
} finally {
  const resolved = path.resolve(sandbox);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(resolved, { recursive: true, force: true });
}

require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'test-recent-files-active-pagination.cjs')], { stdio: 'inherit' });
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
