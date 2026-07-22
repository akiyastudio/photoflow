const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createComponentRegistry } = require('../electron/component-registry.cjs');

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

  const installer = fs.readFileSync(path.join(repositoryRoot, 'build', 'installer.nsh'), 'utf8');
  assert(!installer.includes('release\\components'), 'base installer must not embed optional components');
  assert(installer.includes('$EXEDIR\\components'), 'offline media may provide independently packaged components beside the installer');
  assert(!installer.includes('File /r "${PROJECT_DIR}\\release\\components'), 'component binaries must not be compiled into the base installer');

  const componentBuilder = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'build-components.cjs'), 'utf8');
  assert(componentBuilder.includes('PhotoFlow-${id}-${manifest.version}-${process.platform}-${process.arch}.zip'));
  assert(componentBuilder.includes('zipfile.ZIP_DEFLATED'));
  assert(componentBuilder.includes("'--collect-binaries', 'onnxruntime'"));
  assert(!componentBuilder.includes("'--collect-all', 'onnxruntime'"));

  const registry = createComponentRegistry({
    resourcesPath,
    executablePath,
    projectRoot,
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
  });

  assert.strictEqual(registry.list().length, 2);
  assert.strictEqual(registry.resolve('team-retouch'), null);
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
