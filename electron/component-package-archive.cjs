const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');

const MAX_ENTRIES = 10_000;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
// This parser intentionally accepts classic ZIP32 only. Its 32-bit central
// directory offset makes archives above roughly 4 GiB invalid regardless.
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  return crc >>> 0;
});

const readExact = (fd, length, position) => {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (!count) throw new Error('ZIP 文件意外结束');
    offset += count;
  }
  return buffer;
};
const fileIdentity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameFileIdentity = (left, right) => left && right && Object.keys(left).every(key => left[key] === right[key]);
const assertAvailableDiskSpace = async (targetPath, requiredBytes) => {
  let existing = path.resolve(targetPath);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('无法确定组件安装目标卷');
    existing = parent;
  }
  if (typeof fs.promises.statfs !== 'function') throw new Error('当前运行时无法检查组件安装所需磁盘空间');
  const volume = await fs.promises.statfs(existing, { bigint: true });
  const available = volume.bavail * volume.bsize;
  const required = BigInt(Math.ceil(requiredBytes)) + 64n * 1024n * 1024n;
  if (available < required) throw new Error(`组件安装空间不足：至少还需要 ${requiredBytes} 字节及安全余量`);
  return true;
};
const snapshotComponentArchive = async (sourcePath, targetPath, { maxArchiveBytes = MAX_ARCHIVE_BYTES } = {}) => {
  const resolvedSource = path.resolve(sourcePath);
  const sourceLstat = await fs.promises.lstat(resolvedSource);
  if (!sourceLstat.isFile() || sourceLstat.isSymbolicLink()) throw new Error('组件包必须是普通文件且不能是符号链接');
  if (!Number.isSafeInteger(sourceLstat.size) || sourceLstat.size < 22 || sourceLstat.size > maxArchiveBytes) throw new Error('组件包本体大小超过安全上限');
  await assertAvailableDiskSpace(path.dirname(targetPath), sourceLstat.size);
  const handle = await fs.promises.open(resolvedSource, 'r');
  try {
    const before = await handle.stat();
    const identity = fileIdentity(before);
    if (!before.isFile() || !sameFileIdentity(identity, fileIdentity(sourceLstat))) throw new Error('组件包在快照前被替换或修改');
    await pipeline(handle.createReadStream({ autoClose: false }), fs.createWriteStream(targetPath, { flags: 'wx' }));
    if (!sameFileIdentity(identity, fileIdentity(await handle.stat()))) throw new Error('组件包在快照期间被修改');
    const afterPath = await fs.promises.lstat(resolvedSource);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameFileIdentity(identity, fileIdentity(afterPath))) throw new Error('组件包在快照期间被替换或修改');
    return identity;
  } finally { await handle.close(); }
};
const normalizeName = value => String(value || '').replace(/\\/g, '/');
const validArchivePath = value => {
  const normalized = normalizeName(value);
  const segments = normalized.split('/');
  return Boolean(normalized && normalized.length <= 1024 && !/[\0-\x1f:]/.test(normalized) && !normalized.startsWith('/') && !/^[a-z]:/i.test(normalized)
    && !segments.some(segment => segment === '..' || segment === '.' || segment === '' || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)));
};

const localDataRange = (fd, archive, entry) => {
  const local = readExact(fd, 30, entry.localOffset);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP 本地条目损坏：${entry.name}`);
  const flags = local.readUInt16LE(6);
  const method = local.readUInt16LE(8);
  const crc = local.readUInt32LE(14);
  const compressedSize = local.readUInt32LE(18);
  const uncompressedSize = local.readUInt32LE(22);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const localName = normalizeName(readExact(fd, nameLength, entry.localOffset + 30).toString('utf8'));
  if (localName !== entry.name || flags !== entry.flags || method !== entry.method) throw new Error(`ZIP 本地条目与中央目录不一致：${entry.name}`);
  if (!(flags & 8) && (crc !== entry.expectedCrc || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize)) throw new Error(`ZIP 本地条目大小或 CRC 与中央目录不一致：${entry.name}`);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > archive.directoryOffset) throw new Error(`ZIP 条目数据越界：${entry.name}`);
  return { start: entry.localOffset, dataStart, dataEnd };
};

const inspectComponentArchive = archivePath => {
  const resolved = path.resolve(archivePath);
  const archiveStat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!archiveStat?.isFile() || !Number.isSafeInteger(archiveStat.size) || archiveStat.size < 22 || archiveStat.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件不存在、过小或本体大小超过安全上限');
  const fd = fs.openSync(resolved, 'r');
  try {
    const tailLength = Math.min(archiveStat.size, 65_557);
    const tailStart = archiveStat.size - tailLength;
    const tail = readExact(fd, tailLength, tailStart);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error('ZIP 中央目录缺失或包已损坏');
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0 || tail.readUInt16LE(eocd + 8) !== tail.readUInt16LE(eocd + 10)) throw new Error('不支持多卷 ZIP 组件包');
    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    const absoluteEocd = tailStart + eocd;
    if (!count || count > MAX_ENTRIES || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || directorySize > MAX_DIRECTORY_BYTES || directoryOffset + directorySize !== absoluteEocd) throw new Error('ZIP 中央目录越界或包已损坏');
    const archive = Object.freeze({ archivePath: resolved, size: archiveStat.size, directoryOffset });
    const directory = readExact(fd, directorySize, directoryOffset);
    const entries = [];
    const files = new Set();
    const directories = new Set();
    const declaredPaths = new Set();
    const directorySpelling = new Map();
    let total = 0;
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 条目目录损坏');
      const flags = directory.readUInt16LE(offset + 8);
      const method = directory.readUInt16LE(offset + 10);
      const expectedCrc = directory.readUInt32LE(offset + 16);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const externalAttributes = directory.readUInt32LE(offset + 38);
      const localOffset = directory.readUInt32LE(offset + 42);
      const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
      if (!nameLength || entryEnd > directory.length) throw new Error('ZIP 条目目录越界');
      const originalName = directory.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      const isDirectory = /[\\/]$/.test(originalName);
      const name = normalizeName(originalName);
      const pathName = name.replace(/\/$/, '');
      const folded = pathName.toLowerCase();
      if (!validArchivePath(pathName)) throw new Error(`安装包包含不安全路径：${originalName || '(空路径)'}`);
      if (declaredPaths.has(folded)) throw new Error(`安装包包含重复或大小写冲突路径：${name}`);
      declaredPaths.add(folded);
      if (flags & 1) throw new Error(`安装包包含加密条目：${name}`);
      if (![0, 8].includes(method)) throw new Error(`安装包包含不支持的压缩方法：${name}`);
      const unixMode = externalAttributes >>> 16;
      const unixType = unixMode & 0xf000;
      if (unixType === 0xa000) throw new Error(`安装包包含不安全的符号链接：${name}`);
      if (unixType && unixType !== 0x8000 && unixType !== 0x4000) throw new Error(`安装包包含不安全的特殊文件：${name}`);
      if (unixType === 0x4000 && !isDirectory || unixType === 0x8000 && isDirectory) throw new Error(`ZIP 条目类型与路径不一致：${name}`);
      if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`安装包条目过大：${name}`);
      total += uncompressedSize;
      if (!Number.isSafeInteger(total) || total > MAX_PACKAGE_BYTES) throw new Error('安装包展开大小超过安全上限');
      if (isDirectory && (uncompressedSize !== 0 || compressedSize !== 0)) throw new Error(`ZIP 目录条目包含数据：${name}`);
      const segments = pathName.split('/');
      for (let parentIndex = 1; parentIndex < segments.length; parentIndex += 1) {
        const parentName = segments.slice(0, parentIndex).join('/');
        const parent = parentName.toLowerCase();
        if (files.has(parent)) throw new Error(`安装包包含文件/目录碰撞：${name}`);
        if (directorySpelling.has(parent) && directorySpelling.get(parent) !== parentName) throw new Error(`安装包包含目录大小写冲突：${name}`);
        directories.add(parent); directorySpelling.set(parent, parentName);
      }
      if (isDirectory) {
        if (files.has(folded)) throw new Error(`安装包包含文件/目录碰撞：${name}`);
        if (directorySpelling.has(folded) && directorySpelling.get(folded) !== pathName) throw new Error(`安装包包含目录大小写冲突：${name}`);
        directories.add(folded); directorySpelling.set(folded, pathName);
      } else {
        if (files.has(folded)) throw new Error(`安装包包含重复或大小写冲突路径：${name}`);
        if (directories.has(folded)) throw new Error(`安装包包含文件/目录碰撞：${name}`);
        files.add(folded);
      }
      entries.push({ name, isDirectory, flags, method, expectedCrc, compressedSize, uncompressedSize, localOffset, unixMode: unixMode & 0o777 });
      offset = entryEnd;
    }
    if (offset !== directory.length) throw new Error('ZIP 中央目录条目数量不一致');
    const ranges = entries.map(entry => ({ entry, ...localDataRange(fd, archive, entry) })).sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index += 1) if (ranges[index].start < ranges[index - 1].dataEnd) throw new Error(`ZIP 条目数据区域重叠：${ranges[index].entry.name}`);
    const manifests = ranges.filter(item => /(^|\/)component\.json$/i.test(item.entry.name));
    if (manifests.length !== 1) throw new Error(manifests.length ? '安装包包含多个 component.json' : '安装包中没有 component.json');
    return Object.freeze({ archive, entries: ranges.map(item => Object.freeze({ ...item.entry, dataStart: item.dataStart })), manifestEntry: manifests[0].entry.name, totalUncompressedBytes: total });
  } finally { fs.closeSync(fd); }
};

const extractEntry = async (inspection, entry, target) => {
  if (entry.isDirectory) { await fs.promises.mkdir(target, { recursive: true }); return null; }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const source = entry.compressedSize ? fs.createReadStream(inspection.archive.archivePath, { start: entry.dataStart, end: entry.dataStart + entry.compressedSize - 1 }) : Readable.from([]);
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  let crc = 0xffffffff;
  const inspect = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > entry.uncompressedSize || bytes > MAX_ENTRY_BYTES) { callback(new Error(`ZIP 条目展开大小超过声明：${entry.name}`)); return; }
    digest.update(chunk);
    for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    callback(null, chunk);
  } });
  const streams = [source];
  if (entry.method === 8) streams.push(zlib.createInflateRaw());
  streams.push(inspect, fs.createWriteStream(target, { flags: 'wx' }));
  await pipeline(streams);
  if (bytes !== entry.uncompressedSize) throw new Error(`ZIP 条目展开大小不匹配：${entry.name}`);
  if (((crc ^ 0xffffffff) >>> 0) !== entry.expectedCrc) throw new Error(`ZIP 条目 CRC-32 校验失败：${entry.name}`);
  if (entry.unixMode) await fs.promises.chmod(target, entry.unixMode);
  return digest.digest('hex');
};

const extractComponentArchive = async (inspection, targetRoot) => {
  await assertAvailableDiskSpace(path.dirname(targetRoot), inspection.totalUncompressedBytes);
  await fs.promises.mkdir(targetRoot, { recursive: false });
  for (const entry of inspection.entries) {
    const target = path.join(targetRoot, ...entry.name.replace(/\/$/, '').split('/'));
    await extractEntry(inspection, entry, target);
  }
  const manifestPath = path.join(targetRoot, ...inspection.manifestEntry.split('/'));
  const manifestStat = await fs.promises.stat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) throw new Error('component.json 过大或类型无效');
  let manifest;
  try { manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')); }
  catch (error) { throw new Error(`component.json 无效：${error.message || String(error)}`); }
  return { manifest, manifestEntry: inspection.manifestEntry, manifestPath };
};

const fileDigest = async filePath => {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(); } }));
  return hash.digest('hex');
};
const captureComponentTreeIdentity = async root => {
  const resolvedRoot = path.resolve(root);
  const rootStat = await fs.promises.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('组件暂存根目录类型无效');
  const identity = [];
  const pending = [''];
  while (pending.length) {
    const relativeDirectory = pending.pop();
    const directory = path.join(resolvedRoot, ...relativeDirectory.split('/').filter(Boolean));
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = normalizeName(path.posix.join(relativeDirectory, entry.name));
      const absolute = path.join(directory, entry.name);
      const before = await fs.promises.lstat(absolute);
      if (before.isSymbolicLink()) throw new Error(`组件目录包含符号链接：${relative}`);
      if (before.isDirectory()) { identity.push({ path: relative, kind: 'directory' }); pending.push(relative); continue; }
      if (!before.isFile()) throw new Error(`组件目录包含特殊文件：${relative}`);
      const sha256 = await fileDigest(absolute);
      const after = await fs.promises.lstat(absolute);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`组件文件在校验期间发生变化：${relative}`);
      identity.push({ path: relative, kind: 'file', size: after.size, sha256 });
    }
  }
  identity.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const folded = new Set();
  for (const entry of identity) { const key = entry.path.toLowerCase(); if (folded.has(key)) throw new Error(`组件目录包含重复或大小写冲突路径：${entry.path}`); folded.add(key); }
  return identity;
};
const verifyComponentTreeIdentity = async (root, expected) => {
  const actual = await captureComponentTreeIdentity(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('组件文件在确认或复制期间发生变化');
  return true;
};

module.exports = {
  MAX_ENTRIES,
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_BYTES,
  MAX_PACKAGE_BYTES,
  assertAvailableDiskSpace,
  captureComponentTreeIdentity,
  extractComponentArchive,
  inspectComponentArchive,
  snapshotComponentArchive,
  verifyComponentTreeIdentity,
};
