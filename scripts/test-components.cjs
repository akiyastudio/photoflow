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

  const settingsFeature = fs.readFileSync(path.join(repositoryRoot, 'src', 'features', 'settings', 'SettingsFeature.tsx'), 'utf8');
  assert(settingsFeature.includes('基础方案 · RTMDet'), 'settings must describe the basic engine');
  assert(settingsFeature.includes('高级方案 · PairDETR + SAM 2.1'), 'settings must describe the advanced engine');
  assert(settingsFeature.includes('高级方案通过离线安装包部署，程序不会联网下载'), 'settings must explain the offline-only advanced deployment model');
  assert(settingsFeature.includes('选择离线安装包'), 'settings must provide the offline package picker');
  const teamRetouchManager = fs.readFileSync(path.join(repositoryRoot, 'src', 'components', 'TeamRetouchManager.tsx'), 'utf8');
  assert(teamRetouchManager.includes('基础可用 · 高级未安装'), 'team-retouch workspace must disclose when only the basic engine is available');
  assert(teamRetouchManager.includes('aria-label="识别模式"'), 'single and batch workflows must expose the backend mode selector');
  assert(teamRetouchManager.includes('同一来源进度会记住此选择'), 'team-retouch output progress must be shared by source progress and remain editable');
  assert(teamRetouchManager.includes('initialCompareIds'), 'successful merges must open the existing version comparison flow');
  assert(teamRetouchManager.includes('打开交付文件夹'), 'cropped images must expose their delivery folders');
  const versionsIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'versions-ipc.cjs'), 'utf8');
  assert(versionsIpc.includes('resolveTeamOutputProgress'), 'team-retouch merges must resolve a registered target progress');
  assert(versionsIpc.includes('合成结果不能写回当前来源进度'), 'team-retouch merges must reject the source folder as their output');
  assert(versionsIpc.includes("ipcMain.handle('workspace-team-patch-open-folder'"), 'delivery and merged-result folders must have a scoped open action');

  for (const component of Object.values(PLUGIN_DEFINITIONS)) {
    assert.match(component.version, /^\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/, `${component.id} must use the date revision version format`);
    const template = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'components', component.id, 'component.template.json'), 'utf8'));
    assert.strictEqual(template.version, component.version, `${component.id} catalog and package versions must match`);
  }

  const systemIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  assert(systemIpc.includes("component.source !== 'application'"), 'only application-directory components may be removed');
  assert(systemIpc.includes('await shell.trashItem(componentPath)'), 'component uninstall must use the system recycle bin');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-advanced-install'"), 'settings must be able to install or repair the advanced environment');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-advanced-preflight'"), 'settings must check offline prerequisites before installation');
  assert(systemIpc.includes("ipcMain.handle('team-retouch-advanced-uninstall'"), 'settings must be able to remove the advanced environment');

  const registry = createComponentRegistry({
    resourcesPath,
    executablePath,
    projectRoot,
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
  });

  assert.strictEqual(registry.list().length, 3);
  assert.strictEqual(registry.resolve('team-retouch'), null);
  assert.strictEqual(registry.resolve('office-media-extractor'), null);
  const installRoot = path.join(path.dirname(executablePath), 'components');
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
