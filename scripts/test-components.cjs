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

  const advancedBridge = fs.readFileSync(path.join(repositoryRoot, 'components', 'team-retouch', 'advanced_bridge.py'), 'utf8');
  assert(advancedBridge.includes('DEFAULT_DISTROS = ("PhotoFlowNative", "PhotoflowLab")'), 'advanced backend must support both WSL distribution names');
  assert(advancedBridge.includes('WSL_E_DISTRO_NOT_FOUND'), 'advanced backend must fall through only when a distribution is absent');
  assert(advancedBridge.includes('PHOTOFLOW_WSL_DISTRO'), 'custom WSL distribution override must remain supported');
  assert(advancedBridge.includes('class AdvancedBatchSession'), 'batch retouch must keep advanced models resident for the batch lifetime');
  assert(advancedBridge.includes('payload_b64'), 'persistent WSL requests must preserve Unicode paths');
  const pairDetrScript = fs.readFileSync(path.join(repositoryRoot, 'components', 'team-retouch', 'advanced', 'pairdetr_service.py'), 'utf8');
  const sam2Script = fs.readFileSync(path.join(repositoryRoot, 'components', 'team-retouch', 'advanced', 'sam2_service.py'), 'utf8');
  assert(pairDetrScript.includes('parser.add_argument("--serve"'), 'PairDETR must expose persistent service mode');
  assert(sam2Script.includes('parser.add_argument("--serve"'), 'SAM 2.1 must expose persistent service mode');

  for (const component of Object.values(PLUGIN_DEFINITIONS)) {
    assert.match(component.version, /^\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/, `${component.id} must use the date revision version format`);
    const template = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'components', component.id, 'component.template.json'), 'utf8'));
    assert.strictEqual(template.version, component.version, `${component.id} catalog and package versions must match`);
  }

  const systemIpc = fs.readFileSync(path.join(repositoryRoot, 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  assert(systemIpc.includes("component.source !== 'application'"), 'only application-directory components may be removed');
  assert(systemIpc.includes('await shell.trashItem(componentPath)'), 'component uninstall must use the system recycle bin');

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
