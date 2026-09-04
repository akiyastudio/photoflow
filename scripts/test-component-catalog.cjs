const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createComponentRegistry, readComponentPackageManifest } = require('../electron/component-registry.cjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-catalog-'));
const componentRoot = path.join(sandbox, 'components');
fs.mkdirSync(componentRoot, { recursive: true });

const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const writeZip = (target, files) => {
  const local = []; const central = []; let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name); const data = Buffer.from(raw); const crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBuffer.length, 26);
    local.push(header, nameBuffer, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(nameBuffer.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, nameBuffer); offset += header.length + nameBuffer.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(target, Buffer.concat([...local, directory, end]));
};
const manifest = version => ({ apiVersion: 1, id: 'third-party-tool', version, displayName: 'Third-party tool', platforms: ['win32'], architectures: ['x64'], entrypoints: { 'win32-x64': 'tool.exe' } });

try {
  const registry = createComponentRegistry({ projectRoot: sandbox, userComponentRoot: componentRoot, isPackaged: true, platform: 'win32', arch: 'x64' });
  assert.deepStrictEqual(registry.list(), [], 'static definitions do not create rows');
  const unsupportedManifestArchive = path.join(componentRoot, 'unsupported-manifest.zip');
  writeZip(unsupportedManifestArchive, { 'component.json': JSON.stringify({ ...manifest('1.0.0'), apiVersion: 2 }), 'tool.exe': 'binary' });
  assert.match(registry.list().find(item => item.id === 'third-party-tool').error, /清单格式不兼容/, 'catalog rejects an unsupported manifest format during discovery');
  fs.unlinkSync(unsupportedManifestArchive);
  const missingManifestArchive = path.join(componentRoot, 'missing-manifest-version.zip');
  const { apiVersion: _apiVersion, ...withoutManifestVersion } = manifest('1.0.0');
  writeZip(missingManifestArchive, { 'component.json': JSON.stringify(withoutManifestVersion), 'tool.exe': 'binary' });
  assert.match(registry.list().find(item => item.id === 'third-party-tool').error, /清单格式不兼容/, 'catalog rejects a missing manifest format during discovery');
  fs.unlinkSync(missingManifestArchive);

  const unsafeEntrypointDirectory = path.join(componentRoot, 'unsafe-entrypoint', 'runtime');
  fs.mkdirSync(unsafeEntrypointDirectory, { recursive: true });
  fs.writeFileSync(path.join(unsafeEntrypointDirectory, 'component.json'), JSON.stringify({ ...manifest('1.0.0'), id: 'unsafe-entrypoint', entrypoints: { 'win32-x64': '../escape.exe' } }));
  let unsafeEntrypoint = registry.list().find(item => item.id === 'unsafe-entrypoint');
  assert.match(unsafeEntrypoint.error, /入口路径不安全/);
  fs.writeFileSync(path.join(unsafeEntrypointDirectory, 'component.json'), JSON.stringify({ ...manifest('1.0.0'), id: 'unsafe-entrypoint', entrypoints: {} }));
  unsafeEntrypoint = registry.list().find(item => item.id === 'unsafe-entrypoint');
  assert.match(unsafeEntrypoint.error, /没有适用于当前系统的入口文件/);
  fs.rmSync(path.join(componentRoot, 'unsafe-entrypoint'), { recursive: true, force: true });

  const archive = path.join(componentRoot, 'any-name.zip');
  writeZip(archive, { 'third-party-tool/runtime/component.json': JSON.stringify(manifest('2.0.0')), 'third-party-tool/runtime/tool.exe': 'binary' });
  assert.strictEqual(readComponentPackageManifest(archive).manifest.id, 'third-party-tool');
  let status = registry.list().find(item => item.id === 'third-party-tool');
  assert.strictEqual(status.status, 'pending-install');
  assert.strictEqual(status.integrityStatus, 'unsigned');
  assert.strictEqual(registry.resolvePackage('third-party-tool').packagePath, archive, 'unknown valid packages are installable without a static allowlist entry');
  const olderArchive = path.join(componentRoot, 'older-version.zip');
  writeZip(olderArchive, { 'component.json': JSON.stringify(manifest('1.0.0')), 'tool.exe': 'binary' });
  assert.strictEqual(registry.resolvePackage('third-party-tool').packageVersion, '2.0.0', 'same-spelling package IDs retain highest-version selection instead of becoming a false collision');
  const incompatibleNewerArchive = path.join(componentRoot, 'incompatible-newer-version.zip');
  writeZip(incompatibleNewerArchive, { 'component.json': JSON.stringify({ ...manifest('3.0.0'), platforms: ['linux'] }), 'tool.exe': 'binary' });
  assert.strictEqual(registry.resolvePackage('third-party-tool').packageVersion, '2.0.0', 'a compatible older package wins over an incompatible newer package with the same exact ID');
  fs.unlinkSync(olderArchive); fs.unlinkSync(incompatibleNewerArchive);

  const installed = path.join(componentRoot, 'third-party-tool', 'runtime');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'component.json'), JSON.stringify(manifest('1.0.0')));
  fs.writeFileSync(path.join(installed, 'tool.exe'), 'binary');
  status = registry.list().find(item => item.id === 'third-party-tool');
  assert.strictEqual(status.status, 'update-available');
  registry.setComponentEnabled('third-party-tool', false);
  status = registry.list().find(item => item.id === 'third-party-tool');
  assert.strictEqual(status.enabled, false, 'an installed production component can be disabled without removing it');
  assert.strictEqual(status.status, 'disabled');
  assert.strictEqual(registry.resolve('third-party-tool'), null, 'disabled components cannot resolve a runtime');
  assert(!registry.hostCandidates().some(item => item.expectedId === 'third-party-tool'), 'disabled components are absent from Host discovery');
  const restartedDisabledRegistry = createComponentRegistry({ projectRoot: sandbox, userComponentRoot: componentRoot, isPackaged: true, platform: 'win32', arch: 'x64' });
  assert.strictEqual(restartedDisabledRegistry.inspect('third-party-tool').enabled, false, 'disabled state survives application restart');
  restartedDisabledRegistry.setComponentEnabled('third-party-tool', true);
  const restartedEnabledRegistry = createComponentRegistry({ projectRoot: sandbox, userComponentRoot: componentRoot, isPackaged: true, platform: 'win32', arch: 'x64' });
  assert.strictEqual(restartedEnabledRegistry.inspect('third-party-tool').enabled, true, 're-enabled state survives application restart');
  registry.setComponentEnabled('third-party-tool', true);
  fs.unlinkSync(archive);
  assert.strictEqual(registry.list().find(item => item.id === 'third-party-tool').status, 'installed', 'installed entry survives package deletion');
  fs.rmSync(path.join(componentRoot, 'third-party-tool'), { recursive: true, force: true });
  assert.strictEqual(registry.list().length, 0, 'entry disappears when package and installation are both absent');

  const upperCollisionArchive = path.join(componentRoot, 'upper-id.zip'); const lowerCollisionArchive = path.join(componentRoot, 'lower-id.zip');
  writeZip(upperCollisionArchive, { 'component.json': JSON.stringify({ ...manifest('1.0.0'), id: 'Foo' }), 'tool.exe': 'binary' });
  writeZip(lowerCollisionArchive, { 'component.json': JSON.stringify({ ...manifest('1.0.0'), id: 'foo' }), 'tool.exe': 'binary' });
  const collisionRows = registry.list().filter(item => /大小写折叠冲突/.test(item.error || ''));
  assert.equal(collisionRows.length, 2, 'Foo/foo packages are both rejected instead of sharing one catalog identity');
  assert.throws(() => registry.resolvePackage('foo'), /大小写折叠冲突/, 'case-folding package collisions never resolve to an installable package');
  fs.unlinkSync(upperCollisionArchive); fs.unlinkSync(lowerCollisionArchive);

  const settingsManifest = { ...manifest('1.0.0'), id: 'settings-fixture', componentHost: { contractVersion: 2,  contributions: [{ type: 'workspace.toolbarAction', id: 'open', label: 'Fixture', pageId: 'main' }, { type: 'component.fullPage', id: 'main', title: 'Fixture', entry: 'ui/index.html' }, { type: 'application.settingsPage', id: 'settings', label: 'Fixture', entry: 'ui/settings.html', rpcMethods: ['fixture.settings.v1'] }], service: { protocolVersion: 1, runtime: 'node', entrypoints: { default: 'service.cjs' }, rpcMethods: ['fixture.settings.v1'], capabilities: [], permissions: [], events: [] } } };
  const missingSettingsArchive = path.join(componentRoot, 'settings-missing.zip');
  writeZip(missingSettingsArchive, { 'component.json': JSON.stringify(settingsManifest), 'tool.exe': 'binary', 'service.cjs': '', 'ui/index.html': '<!doctype html>' });
  assert.match(registry.list().find(item => item.id === 'settings-fixture').error, /ui\/settings\.html/, 'final component ZIP validation requires the declared settings entry path');
  fs.unlinkSync(missingSettingsArchive);
  const completeSettingsArchive = path.join(componentRoot, 'settings-complete.zip');
  writeZip(completeSettingsArchive, { 'component.json': JSON.stringify(settingsManifest), 'tool.exe': 'binary', 'service.cjs': '', 'ui/index.html': '<!doctype html>', 'ui/settings.html': '<!doctype html>' });
  assert.equal(registry.list().find(item => item.id === 'settings-fixture').status, 'pending-install', 'a final component ZIP containing the declared settings entry remains installable');
  fs.unlinkSync(completeSettingsArchive);

  const declarativeSettingsManifest = structuredClone(settingsManifest);
  declarativeSettingsManifest.id = 'settings-form-fixture';
  declarativeSettingsManifest.componentHost.contributions = declarativeSettingsManifest.componentHost.contributions.map(item => item.type === 'application.settingsPage' ? { type: 'application.settingsForm', id: 'settings', label: 'Fixture', form: { schemaVersion: 1, groups: [{ id: 'general', title: 'General', fields: [{ id: 'enabled', type: 'toggle', label: 'Enabled', default: true }] }] } } : item);
  declarativeSettingsManifest.componentHost.service.capabilities = ['component.settings'];
  declarativeSettingsManifest.componentHost.service.permissions = ['component.settings'];
  const declarativeSettingsArchive = path.join(componentRoot, 'settings-form.zip');
  writeZip(declarativeSettingsArchive, { 'component.json': JSON.stringify(declarativeSettingsManifest), 'tool.exe': 'binary', 'service.cjs': '', 'ui/index.html': '<!doctype html>' });
  assert.equal(registry.list().find(item => item.id === 'settings-form-fixture').status, 'pending-install', 'a declarative settings form needs no component-owned settings HTML entry');
  fs.unlinkSync(declarativeSettingsArchive);
  declarativeSettingsManifest.componentHost.contributions.find(item => item.type === 'application.settingsForm').customPage = { title: 'Advanced', entry: 'ui/advanced.html', rpcMethods: ['fixture.settings.v1'] };
  const missingHybridArchive = path.join(componentRoot, 'settings-form-hybrid-missing.zip');
  writeZip(missingHybridArchive, { 'component.json': JSON.stringify(declarativeSettingsManifest), 'tool.exe': 'binary', 'service.cjs': '', 'ui/index.html': '<!doctype html>' });
  assert.match(registry.list().find(item => item.id === 'settings-form-fixture').error, /ui\/advanced\.html/, 'a hybrid settings form requires its declared custom page entry');
  fs.unlinkSync(missingHybridArchive);
  const completeHybridArchive = path.join(componentRoot, 'settings-form-hybrid.zip');
  writeZip(completeHybridArchive, { 'component.json': JSON.stringify(declarativeSettingsManifest), 'tool.exe': 'binary', 'service.cjs': '', 'ui/index.html': '<!doctype html>', 'ui/advanced.html': '<!doctype html>' });
  assert.equal(registry.list().find(item => item.id === 'settings-form-fixture').status, 'pending-install');
  fs.unlinkSync(completeHybridArchive);

  const versionedHostArchive = path.join(componentRoot, 'versioned-host-api.zip');
  const versionedHostManifest = { ...settingsManifest, id: 'versioned-host-fixture', componentHost: { ...settingsManifest.componentHost, compatibility: {} } };
  writeZip(versionedHostArchive, { 'component.json': JSON.stringify(versionedHostManifest), 'tool.exe': 'binary', 'service.cjs': '', 'ui/index.html': '<!doctype html>', 'ui/settings.html': '<!doctype html>' });
  assert.match(registry.list().find(item => item.id === 'versioned-host-fixture').error, /Host 字段/, 'catalog preflight rejects obsolete Host API negotiation metadata');
  fs.unlinkSync(versionedHostArchive);

  const incompatible = path.join(componentRoot, 'incompatible.zip');
  writeZip(incompatible, { 'component.json': JSON.stringify({ ...manifest('3.0.0'), platforms: ['linux'] }) });
  assert.strictEqual(registry.list().find(item => item.id === 'third-party-tool').status, 'incompatible');
  assert.throws(() => registry.resolvePackage('third-party-tool'), /不支持 win32/);
  fs.unlinkSync(incompatible);

  const unsafe = path.join(componentRoot, 'unsafe.zip');
  writeZip(unsafe, { '../component.json': JSON.stringify(manifest('3.0.0')) });
  assert.throws(() => readComponentPackageManifest(unsafe), /不安全路径/);
  assert.strictEqual(registry.list()[0].status, 'package-invalid');
  fs.unlinkSync(unsafe);

  const corrupt = path.join(componentRoot, 'corrupt.zip');
  writeZip(corrupt, { 'component.json': JSON.stringify(manifest('4.0.0')), 'tool.exe': 'binary' });
  const bytes = fs.readFileSync(corrupt); bytes[bytes.indexOf(Buffer.from('{'))] ^= 1; fs.writeFileSync(corrupt, bytes);
  assert.throws(() => readComponentPackageManifest(corrupt), /校验失败/);
  assert.strictEqual(registry.list()[0].status, 'package-invalid');

  console.log('Dynamic component catalog tests passed');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
