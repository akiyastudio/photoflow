const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const zlib = require('node:zlib');
const { readComponentPackageManifest, readZipEntries, createComponentRegistry } = require('../electron/component-registry.cjs');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');
const { validateComponentIntegrity } = require('../electron/component-integrity.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const defaultPackageRoot = path.join(repositoryRoot, 'artifacts', 'installers');
const MAX_ENTRY_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_INTEGRITY_BYTES = 4 * 1024 * 1024;
const COMPONENT_ARCHIVE = /^PhotoFlow-(.+)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(win32|darwin|linux)-(x64|arm64|ia32)\.zip$/;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

const readExact = (fd, length, position) => {
  const value = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, value, offset, length - offset, position + offset);
    if (!count) throw new Error('ZIP 文件意外结束');
    offset += count;
  }
  return value;
};

const entryDataOffset = (archive, entry) => {
  const fd = fs.openSync(archive.archivePath, 'r');
  try {
    const local = readExact(fd, 30, entry.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP 本地条目损坏：${entry.name}`);
    const flags = local.readUInt16LE(6);
    const method = local.readUInt16LE(8);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const localName = readExact(fd, nameLength, entry.localOffset + 30).toString('utf8').replace(/\\/g, '/');
    if (localName !== entry.name || flags !== entry.flags || method !== entry.method) throw new Error(`ZIP 本地条目与中央目录不一致：${entry.name}`);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    if (start + entry.compressedSize > archive.size) throw new Error(`ZIP 条目数据越界：${entry.name}`);
    return start;
  } finally { fs.closeSync(fd); }
};

const assertEntrySet = entries => {
  let total = 0;
  const files = new Set();
  const directories = new Set();
  for (const entry of entries) {
    if (entry.flags & 1) throw new Error(`安装包包含加密条目：${entry.name}`);
    if (![0, 8].includes(entry.method)) throw new Error(`安装包包含不支持的压缩方法：${entry.name}`);
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`安装包条目过大：${entry.name}`);
    total += entry.uncompressedSize;
    if (!Number.isSafeInteger(total) || total > MAX_PACKAGE_BYTES) throw new Error('安装包展开大小超过安全上限');
    const name = entry.name.replace(/\/$/, '').toLowerCase();
    const isDirectory = entry.name.endsWith('/');
    if (isDirectory && entry.uncompressedSize !== 0) throw new Error(`ZIP 目录条目包含数据：${entry.name}`);
    const segments = name.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/');
      if (files.has(parent)) throw new Error(`安装包包含文件/目录碰撞：${entry.name}`);
      directories.add(parent);
    }
    if (isDirectory) {
      if (files.has(name)) throw new Error(`安装包包含文件/目录碰撞：${entry.name}`);
      directories.add(name);
    } else {
      if (directories.has(name)) throw new Error(`安装包包含文件/目录碰撞：${entry.name}`);
      files.add(name);
    }
  }
};

const extractEntry = async (archive, entry, target) => {
  if (entry.name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const start = entryDataOffset(archive, entry);
  const source = entry.compressedSize
    ? fs.createReadStream(archive.archivePath, { start, end: start + entry.compressedSize - 1 })
    : require('node:stream').Readable.from([]);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let crc = 0xffffffff;
  const inspect = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    hash.update(chunk);
    for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    callback(null, chunk);
  } });
  const streams = [source];
  if (entry.method === 8) streams.push(zlib.createInflateRaw());
  streams.push(inspect, fs.createWriteStream(target, { flags: 'wx' }));
  await pipeline(streams);
  if (bytes !== entry.uncompressedSize) throw new Error(`ZIP 条目展开大小不匹配：${entry.name}`);
  if (((crc ^ 0xffffffff) >>> 0) !== entry.expectedCrc) throw new Error(`ZIP 条目 CRC-32 校验失败：${entry.name}`);
  return hash.digest('hex');
};

const verifyComponentPackage = async archivePath => {
  const absoluteArchive = path.resolve(archivePath);
  const fileName = path.basename(absoluteArchive);
  const nameMatch = COMPONENT_ARCHIVE.exec(fileName);
  if (!nameMatch) throw new Error(`组件包文件名无效：${fileName}`);
  const packageManifest = readComponentPackageManifest(absoluteArchive);
  const { archive, entries } = readZipEntries(absoluteArchive);
  assertEntrySet(entries);
  const manifest = packageManifest.manifest;
  const expectedName = `PhotoFlow-${manifest.id}-${manifest.version}-${nameMatch[3]}-${nameMatch[4]}.zip`;
  if (fileName !== expectedName) throw new Error(`组件包文件名身份不匹配：需要 ${expectedName}`);
  if (!Array.isArray(manifest.platforms) || !manifest.platforms.includes(nameMatch[3])) throw new Error(`组件清单平台与文件名不匹配：${nameMatch[3]}`);
  if (!Array.isArray(manifest.architectures) || !manifest.architectures.includes(nameMatch[4])) throw new Error(`组件清单架构与文件名不匹配：${nameMatch[4]}`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-verify-'));
  try {
    const extractedRoot = path.join(temporaryRoot, 'extracted');
    for (const entry of entries) await extractEntry(archive, entry, path.join(extractedRoot, ...entry.name.split('/')));
    const manifestRoot = path.dirname(path.join(extractedRoot, ...packageManifest.manifestEntry.split('/')));
    parseComponentHostManifest(manifest, manifestRoot);
    const isolatedPackageRoot = path.join(temporaryRoot, 'packages');
    fs.mkdirSync(isolatedPackageRoot);
    const isolatedArchive = path.join(isolatedPackageRoot, fileName);
    try { fs.linkSync(absoluteArchive, isolatedArchive); }
    catch { fs.copyFileSync(absoluteArchive, isolatedArchive); }
    const registry = createComponentRegistry({ projectRoot: repositoryRoot, userComponentRoot: isolatedPackageRoot, isPackaged: true, platform: nameMatch[3], arch: nameMatch[4] });
    const resolved = registry.resolvePackage(manifest.id);
    if (path.resolve(resolved.packagePath) !== isolatedArchive) throw new Error(`组件注册表未接受当前包：${fileName}`);
    if (manifest.integrity !== undefined) {
      if (manifest.integrity !== 'component-integrity.json') throw new Error('组件完整性清单必须为 component-integrity.json');
      const integrityPath = path.join(manifestRoot, manifest.integrity);
      const stat = fs.statSync(integrityPath, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size > MAX_INTEGRITY_BYTES) throw new Error('组件完整性清单缺失或过大');
      const integrity = JSON.parse(fs.readFileSync(integrityPath, 'utf8'));
      if (String(integrity.componentId) !== String(manifest.id) || String(integrity.version) !== String(manifest.version)) throw new Error('组件完整性清单身份与 component.json 不一致');
      validateComponentIntegrity(manifestRoot, integrity);
    }
    const packageHash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(absoluteArchive), new Transform({ transform(chunk, encoding, callback) { packageHash.update(chunk); callback(); } }));
    return { fileName, size: archive.size, sha256: packageHash.digest('hex'), componentId: manifest.id, version: manifest.version, platform: nameMatch[3], arch: nameMatch[4] };
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
};

const discoverPackages = packageRoot => fs.readdirSync(packageRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && /^PhotoFlow-.*\.zip$/i.test(entry.name))
  .map(entry => path.join(packageRoot, entry.name)).sort();

const run = async () => {
  const paths = process.argv.slice(2).filter(value => !value.startsWith('--'));
  const packageRootIndex = process.argv.indexOf('--package-root');
  const packageRoot = packageRootIndex >= 0 ? path.resolve(process.argv[packageRootIndex + 1]) : defaultPackageRoot;
  const packages = paths.length ? paths.map(value => path.resolve(value)) : discoverPackages(packageRoot);
  if (!packages.length) throw new Error(`没有找到组件 ZIP：${packageRoot}`);
  const results = [];
  for (const packagePath of packages) {
    const verified = await verifyComponentPackage(packagePath);
    results.push(verified);
    console.log(`Verified component package: ${verified.fileName} (${verified.size} bytes, sha256 ${verified.sha256})`);
  }
  return results;
};

if (require.main === module) run().catch(error => { console.error(`Component package verification failed: ${error.message || error}`); process.exitCode = 1; });

module.exports = { verifyComponentPackage, discoverPackages };
