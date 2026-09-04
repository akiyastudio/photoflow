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
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_INTEGRITY_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const RECEIPT_SCHEMA_VERSION = 1;
const VERIFIER_VERSION = 1;
const COMPONENT_ARCHIVE = /^PhotoFlow-(.+)-(win32|darwin|linux)-(x64|arm64|ia32)\.zip$/;
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
    const localCrc = local.readUInt32LE(14);
    const localCompressedSize = local.readUInt32LE(18);
    const localUncompressedSize = local.readUInt32LE(22);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const localName = readExact(fd, nameLength, entry.localOffset + 30).toString('utf8').replace(/\\/g, '/');
    if (localName !== entry.name || flags !== entry.flags || method !== entry.method) throw new Error(`ZIP 本地条目与中央目录不一致：${entry.name}`);
    if (!(flags & 8) && (localCrc !== entry.expectedCrc || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize)) throw new Error(`ZIP 本地条目大小或校验值与中央目录不一致：${entry.name}`);
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
      if (files.has(name)) throw new Error(`安装包包含重复或大小写冲突路径：${entry.name}`);
      if (directories.has(name)) throw new Error(`安装包包含文件/目录碰撞：${entry.name}`);
      files.add(name);
    }
  }
};

const identityFor = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameIdentity = (left, right) => left && right && Object.keys(left).every(key => left[key] === right[key]);
const assertSourceIdentity = (archivePath, expected) => {
  const current = fs.statSync(archivePath, { throwIfNoEntry: false });
  if (!current?.isFile() || !sameIdentity(expected, identityFor(current))) throw new Error(`组件包在验证期间被替换或修改：${archivePath}`);
};
const captureArtifactIdentity = artifactPath => {
  const stat = fs.statSync(artifactPath, { throwIfNoEntry: false });
  if (!stat?.isFile() || !Number.isSafeInteger(stat.size)) throw new Error(`交付物不存在或不是普通文件：${artifactPath}`);
  return identityFor(stat);
};
const hashStableArtifact = async archivePath => {
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 22 || stat.size > MAX_ARCHIVE_BYTES) throw new Error(`组件包本体大小超过安全上限：${archivePath}`);
    const identity = identityFor(stat);
    assertSourceIdentity(archivePath, identity);
    const hash = crypto.createHash('sha256');
    await pipeline(handle.createReadStream({ autoClose: false }), new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(); } }));
    if (!sameIdentity(identity, identityFor(await handle.stat()))) throw new Error(`组件包在哈希期间被修改：${archivePath}`);
    assertSourceIdentity(archivePath, identity);
    return { size: stat.size, sha256: hash.digest('hex'), identity };
  } finally { await handle.close(); }
};
const snapshotArchive = async (archivePath, target) => {
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`组件包不是普通文件：${archivePath}`);
    if (!Number.isSafeInteger(before.size) || before.size < 22 || before.size > MAX_ARCHIVE_BYTES) throw new Error(`组件包本体大小超过安全上限：${archivePath}`);
    const identity = identityFor(before);
    assertSourceIdentity(archivePath, identity);
    await pipeline(handle.createReadStream({ autoClose: false }), fs.createWriteStream(target, { flags: 'wx' }));
    if (!sameIdentity(identity, identityFor(await handle.stat()))) throw new Error(`组件包在快照期间被修改：${archivePath}`);
    assertSourceIdentity(archivePath, identity);
    return identity;
  } finally { await handle.close(); }
};

const expectedComponentPackages = (packageRoot, platform = process.platform, arch = process.arch) => {
  const seenIds = new Set();
  return fs.readdirSync(path.join(repositoryRoot, 'extensions'), { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const packagePath = path.join(repositoryRoot, 'extensions', entry.name, 'package.json');
    if (!fs.existsSync(packagePath)) return [];
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (!packageJson.photoflowComponent || !packageJson.scripts?.['package:host']) return [];
    const manifestPath = path.join(path.dirname(packagePath), String(packageJson.photoflowComponent.manifest || ''));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const id = String(manifest.id || '');
    if (!id || seenIds.has(id)) throw new Error(`组件发布集合包含重复或无效 ID：${id || entry.name}`);
    seenIds.add(id);
    const fileName = `PhotoFlow-${id}-${manifest.version}-${platform}-${arch}.zip`;
    return [{ id, version: String(manifest.version || ''), fileName, path: path.join(packageRoot, fileName) }];
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
};

const extractEntry = async (archive, entry, target, actualBudget) => {
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
    const nextEntryBytes = bytes + chunk.length;
    const nextPackageBytes = actualBudget.bytes + chunk.length;
    if (nextEntryBytes > entry.uncompressedSize || nextEntryBytes > MAX_ENTRY_BYTES) return callback(new Error(`ZIP 条目实际展开大小超过声明或安全上限：${entry.name}`));
    if (nextPackageBytes > MAX_PACKAGE_BYTES) return callback(new Error('安装包实际展开大小超过安全上限'));
    bytes = nextEntryBytes;
    actualBudget.bytes = nextPackageBytes;
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
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-component-verify-'));
  try {
    const isolatedPackageRoot = path.join(temporaryRoot, 'packages');
    fs.mkdirSync(isolatedPackageRoot);
    const isolatedArchive = path.join(isolatedPackageRoot, fileName);
    const sourceIdentity = await snapshotArchive(absoluteArchive, isolatedArchive);
    const packageManifest = readComponentPackageManifest(isolatedArchive);
    const { archive, entries } = readZipEntries(isolatedArchive);
    assertEntrySet(entries);
    const manifest = packageManifest.manifest;
    const platform = nameMatch[2];
    const arch = nameMatch[3];
    const expectedName = `PhotoFlow-${manifest.id}-${manifest.version}-${platform}-${arch}.zip`;
    if (fileName !== expectedName) throw new Error(`组件包文件名身份不匹配：需要 ${expectedName}`);
    if (!Array.isArray(manifest.platforms) || !manifest.platforms.includes(platform)) throw new Error(`组件清单平台与文件名不匹配：${platform}`);
    if (!Array.isArray(manifest.architectures) || !manifest.architectures.includes(arch)) throw new Error(`组件清单架构与文件名不匹配：${arch}`);
    const extractedRoot = path.join(temporaryRoot, 'extracted');
    const actualBudget = { bytes: 0 };
    for (const entry of entries) await extractEntry(archive, entry, path.join(extractedRoot, ...entry.name.split('/')), actualBudget);
    const manifestRoot = path.dirname(path.join(extractedRoot, ...packageManifest.manifestEntry.split('/')));
    parseComponentHostManifest(manifest, manifestRoot);
    const registry = createComponentRegistry({ projectRoot: repositoryRoot, userComponentRoot: isolatedPackageRoot, isPackaged: true, platform, arch });
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
    await pipeline(fs.createReadStream(isolatedArchive), new Transform({ transform(chunk, encoding, callback) { packageHash.update(chunk); callback(); } }));
    assertSourceIdentity(absoluteArchive, sourceIdentity);
    return { fileName, size: archive.size, sha256: packageHash.digest('hex'), componentId: manifest.id, version: manifest.version, platform, arch, sourceIdentity };
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
};

const receiptPathFor = archivePath => `${path.resolve(archivePath)}.verification.json`;
const writeVerificationReceipt = (archivePath, result) => {
  const receiptPath = receiptPathFor(archivePath);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    verifierVersion: VERIFIER_VERSION,
    command: 'npm run verify:component-packages',
    status: 'passed',
    verifiedAt: new Date().toISOString(),
    archive: { fileName: result.fileName, size: result.size, sha256: result.sha256 },
    component: { id: result.componentId, version: result.version, platform: result.platform, arch: result.arch },
  };
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, receiptPath);
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  return receiptPath;
};
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error(`组件验证回执 ${label} 结构无效`);
};
const verifyComponentPackageReceipt = async (archivePath, expected) => {
  const absoluteArchive = path.resolve(archivePath);
  const verified = await verifyComponentPackage(absoluteArchive);
  const receiptPath = receiptPathFor(absoluteArchive);
  let receiptFd;
  try { receiptFd = fs.openSync(receiptPath, 'r'); }
  catch (error) { if (error?.code === 'ENOENT') throw new Error(`组件验证回执缺失或过大：${path.basename(receiptPath)}`); throw error; }
  let receiptIdentity;
  let receipt;
  try {
    const receiptStat = fs.fstatSync(receiptFd);
    if (!receiptStat.isFile() || receiptStat.size < 2 || receiptStat.size > MAX_RECEIPT_BYTES) throw new Error(`组件验证回执缺失或过大：${path.basename(receiptPath)}`);
    receiptIdentity = identityFor(receiptStat);
    assertSourceIdentity(receiptPath, receiptIdentity);
    receipt = JSON.parse(fs.readFileSync(receiptFd, 'utf8'));
    if (!sameIdentity(receiptIdentity, identityFor(fs.fstatSync(receiptFd)))) throw new Error(`组件验证回执在读取期间被修改：${path.basename(receiptPath)}`);
    assertSourceIdentity(receiptPath, receiptIdentity);
  } finally { fs.closeSync(receiptFd); }
  exactKeys(receipt, ['schemaVersion', 'verifierVersion', 'command', 'status', 'verifiedAt', 'archive', 'component'], '根对象');
  exactKeys(receipt.archive, ['fileName', 'size', 'sha256'], 'archive');
  exactKeys(receipt.component, ['id', 'version', 'platform', 'arch'], 'component');
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || receipt.verifierVersion !== VERIFIER_VERSION || receipt.command !== 'npm run verify:component-packages' || receipt.status !== 'passed' || !Number.isFinite(Date.parse(receipt.verifiedAt))) throw new Error('组件验证回执版本或执行证据无效，必须重新完整验证');
  const expectedIdentity = { id: String(expected.id), version: String(expected.version), platform: String(expected.platform), arch: String(expected.arch) };
  if (JSON.stringify(receipt.component) !== JSON.stringify(expectedIdentity)) throw new Error(`组件验证回执身份与当前发布集合不一致：${path.basename(absoluteArchive)}`);
  if (receipt.archive.fileName !== path.basename(absoluteArchive) || !Number.isSafeInteger(receipt.archive.size) || !/^[a-f0-9]{64}$/.test(receipt.archive.sha256)) throw new Error('组件验证回执 archive 字段无效');
  if (verified.fileName !== receipt.archive.fileName || verified.size !== receipt.archive.size || verified.sha256 !== receipt.archive.sha256
    || verified.componentId !== receipt.component.id || String(verified.version) !== receipt.component.version || verified.platform !== receipt.component.platform || verified.arch !== receipt.component.arch) throw new Error(`组件 ZIP 与审计回执不一致：${path.basename(absoluteArchive)}`);
  return { ...verified, receiptPath, receiptIdentity, verificationReceipt: { schemaVersion: receipt.schemaVersion, verifierVersion: receipt.verifierVersion, command: receipt.command, status: receipt.status, verifiedAt: receipt.verifiedAt, trust: 'informational' } };
};

const parseArguments = values => {
  const result = { packageRoot: defaultPackageRoot, paths: [], writeReceipts: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--write-receipts') result.writeReceipts = true;
    else if (value === '--package-root') {
      const directory = values[++index];
      if (!directory || directory.startsWith('--')) throw new Error('--package-root 需要目录参数');
      result.packageRoot = path.resolve(directory);
    } else if (value.startsWith('--package-root=')) {
      const directory = value.slice('--package-root='.length);
      if (!directory) throw new Error('--package-root 需要目录参数');
      result.packageRoot = path.resolve(directory);
    } else if (value.startsWith('--')) throw new Error(`未知参数：${value}`);
    else result.paths.push(path.resolve(value));
  }
  return result;
};

const run = async () => {
  const { packageRoot, paths, writeReceipts } = parseArguments(process.argv.slice(2));
  const expected = paths.length ? [] : expectedComponentPackages(packageRoot);
  const packages = paths.length ? paths : expected.map(component => {
    if (!fs.statSync(component.path, { throwIfNoEntry: false })?.isFile()) throw new Error(`组件包缺失：${component.fileName}`);
    return component.path;
  });
  const results = [];
  for (const packagePath of packages) {
    const verified = await verifyComponentPackage(packagePath);
    results.push(verified);
    console.log(`Verified component package: ${verified.fileName} (${verified.size} bytes, sha256 ${verified.sha256})`);
    if (writeReceipts) console.log(`Verification receipt: ${writeVerificationReceipt(packagePath, verified)}`);
  }
  return results;
};

if (require.main === module) run().catch(error => { console.error(`Component package verification failed: ${error.message || error}`); process.exitCode = 1; });

module.exports = { verifyComponentPackage, verifyComponentPackageReceipt, writeVerificationReceipt, expectedComponentPackages, parseArguments, receiptPathFor, hashStableArtifact, captureArtifactIdentity, assertSourceIdentity };
