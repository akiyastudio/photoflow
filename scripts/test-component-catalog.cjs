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

  const installed = path.join(componentRoot, 'third-party-tool', 'runtime');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'component.json'), JSON.stringify(manifest('1.0.0')));
  fs.writeFileSync(path.join(installed, 'tool.exe'), 'binary');
  status = registry.list().find(item => item.id === 'third-party-tool');
  assert.strictEqual(status.status, 'update-available');
  fs.unlinkSync(archive);
  assert.strictEqual(registry.list().find(item => item.id === 'third-party-tool').status, 'installed', 'installed entry survives package deletion');
  fs.rmSync(path.join(componentRoot, 'third-party-tool'), { recursive: true, force: true });
  assert.strictEqual(registry.list().length, 0, 'entry disappears when package and installation are both absent');

  const incompatible = path.join(componentRoot, 'incompatible.zip');
  writeZip(incompatible, { 'component.json': JSON.stringify({ ...manifest('3.0.0'), platforms: ['linux'] }) });
  assert.strictEqual(registry.list().find(item => item.id === 'third-party-tool').status, 'incompatible');
  assert.throws(() => registry.resolvePackage('third-party-tool'), /不支持 win32/);
  fs.unlinkSync(incompatible);

  const hostIncompatible = path.join(componentRoot, 'host-incompatible.zip');
  writeZip(hostIncompatible, { 'component.json': JSON.stringify({ ...manifest('3.0.0'), componentHost: { contractVersion: 1, compatibility: { minHostApiVersion: 2, maxHostApiVersion: 3 }, contributions: [{ type: 'workspace.toolbarAction' }, { type: 'component.fullPage' }] } }), 'tool.exe': 'binary' });
  assert.match(registry.list().find(item => item.id === 'third-party-tool').error, /Host API 1 不在支持范围/);
  fs.unlinkSync(hostIncompatible);

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
