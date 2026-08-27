const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createComponentRegistry } = require('../electron/component-registry.cjs');
const { createComponentHostRegistry } = require('../electron/component-host-contract.cjs');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'component-development-'));
const projectRoot = path.join(sandbox, 'host'); const developmentRoot = path.join(sandbox, 'components');
fs.mkdirSync(projectRoot, { recursive: true }); fs.mkdirSync(developmentRoot, { recursive: true });
const writeFixture = (id, mutate = () => undefined) => {
  const root = path.join(developmentRoot, id); fs.mkdirSync(path.join(root, 'dist', 'ui'), { recursive: true }); fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [name, contents] of [['dist/ui/index.html', '<!doctype html><title>Page</title>'], ['dist/ui/settings.html', '<!doctype html><title>Settings</title>'], ['src/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>'], ['src/service.cjs', ''], ['runtime.bin', 'runtime'], ['algorithm.js', 'algorithm']]) {
    fs.writeFileSync(path.join(root, ...name.split('/')), contents);
  }
  const method = `${id}.settings.v1`;
  const manifest = { apiVersion: 1, id, version: '1.0.0', displayName: `Fixture ${id}`, description: 'Generic development fixture', icon: 'ui/icon.svg', entrypoints: { default: 'algorithm.bin' }, requiredFiles: ['ui/index.html', 'ui/settings.html', 'ui/icon.svg', 'service.cjs'], componentHost: { contractVersion: 2, compatibility: { minHostApiVersion: 7, maxHostApiVersion: 7 }, contributions: [{ type: 'workspace.toolbarAction', id: 'open', label: 'Open', pageId: 'main' }, { type: 'component.fullPage', id: 'main', title: 'Fixture', entry: 'ui/index.html' }, { type: 'application.settingsPage', id: 'settings', label: 'Settings', entry: 'ui/settings.html', rpcMethods: [method] }], service: { protocolVersion: 1, runtime: 'node', entrypoints: { default: 'service.cjs' }, rpcMethods: [method], capabilities: ['component.settings.v7'], permissions: ['component.settings'], events: [], runtimeActions: [] } } };
  const packageManifest = { name: `fixture-${id}`, private: true, scripts: { build: 'fixture-build' }, photoflowComponent: { manifest: 'component.template.json', tests: { 'package-layout': ['tests/layout.cjs'] }, development: { prepare: 'build', runtime: { command: 'runtime.bin', entry: 'algorithm.js', argsPrefix: ['--fixture'] }, files: { 'algorithm.bin': 'algorithm.js', 'ui/index.html': 'dist/ui/index.html', 'ui/settings.html': 'dist/ui/settings.html', 'ui/icon.svg': 'src/icon.svg', 'service.cjs': 'src/service.cjs' } } } };
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true }); fs.writeFileSync(path.join(root, 'tests', 'layout.cjs'), '');
  mutate({ root, manifest, packageManifest });
  fs.writeFileSync(path.join(root, 'component.template.json'), JSON.stringify(manifest)); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageManifest));
  return root;
};
const env = { PHOTOFLOW_COMPONENT_DEV_ROOTS: developmentRoot, PHOTOFLOW_COMPONENT_DEV_DEFAULTS: '0' };
try {
  const validRoot = writeFixture('sample-dev');
  const registry = createComponentRegistry({ projectRoot, userComponentRoot: path.join(sandbox, 'installed'), isPackaged: false, environment: env });
  const component = registry.inspect('sample-dev');
  assert.equal(component.source, 'development'); assert.equal(component.installed, true); assert.equal(component.integrityStatus, 'development');
  assert.equal(component.command, path.join(validRoot, 'runtime.bin')); assert.deepEqual(component.argsPrefix, ['--fixture', path.join(validRoot, 'algorithm.js')]);
  const host = createComponentHostRegistry({ candidateProvider: registry.hostCandidates, admitDescriptor: () => true }); const descriptor = host.resolve('sample-dev');
  assert.equal(descriptor.development, true); assert.equal(descriptor.fullPage.entry, path.join(validRoot, 'dist', 'ui', 'index.html'));
  assert.equal(descriptor.settingsPages[0].entry, path.join(validRoot, 'dist', 'ui', 'settings.html')); assert.equal(descriptor.icon.entry, path.join(validRoot, 'src', 'icon.svg'));
  assert.equal(descriptor.service.entry, path.join(validRoot, 'src', 'service.cjs')); assert.equal(descriptor.developmentRuntime.command, path.join(validRoot, 'runtime.bin'));
  const action = ComponentViewManager.prototype.listToolbarActions.call({ registry: host })[0]; const settingsPage = ComponentViewManager.prototype.listSettingsPages.call({ registry: host })[0];
  assert.equal(action.development, true); assert.equal(action.label, 'Open'); assert.equal(action.pageTitle, 'Fixture');
  assert.equal(settingsPage.development, true); assert.equal(settingsPage.label, 'Settings');

  const packaged = createComponentRegistry({ projectRoot, userComponentRoot: path.join(sandbox, 'production-components'), isPackaged: true, environment: env });
  assert.equal(packaged.list().length, 0, 'production must never discover source registrations'); assert.equal(packaged.hostCandidates().length, 0);

  writeFixture('missing-build', ({ root }) => fs.rmSync(path.join(root, 'dist', 'ui', 'index.html')));
  writeFixture('path-escape', ({ packageManifest }) => { packageManifest.photoflowComponent.development.files['ui/index.html'] = '../outside.html'; });
  writeFixture('unknown-field', ({ packageManifest }) => { packageManifest.photoflowComponent.development.catalogMagic = true; });
  writeFixture('unsafe-test', ({ packageManifest }) => { packageManifest.photoflowComponent.tests['package-layout'] = ['../outside.cjs']; });
  writeFixture('undeclared-map', ({ packageManifest }) => { packageManifest.photoflowComponent.development.files['private/secret.js'] = 'algorithm.js'; });
  writeFixture('permission-default-deny', ({ manifest }) => { delete manifest.componentHost.service.permissions; });
  for (const [id, pattern] of [['missing-build', /missing or unsafe/], ['path-escape', /component-local relative file/], ['unknown-field', /Unknown component development field/], ['unsafe-test', /component-local relative file/], ['undeclared-map', /undeclared component file/], ['permission-default-deny', /Host API 7 permissions must be exact and unique/]]) {
    const invalid = registry.inspect(id); assert.equal(invalid.source, 'development'); assert.equal(invalid.compatible, false); assert.match(invalid.error, pattern);
  }

  const linkRoot = writeFixture('linked-file'); let linked = false;
  try { fs.rmSync(path.join(linkRoot, 'dist', 'ui', 'index.html')); fs.symlinkSync(path.join(validRoot, 'dist', 'ui', 'index.html'), path.join(linkRoot, 'dist', 'ui', 'index.html'), 'file'); linked = true; } catch { /* Windows may deny symlink creation to an unprivileged test process. */ }
  if (linked) assert.match(registry.inspect('linked-file').error, /missing or unsafe/);
  console.log('Generic development component discovery/security tests passed');
} finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
