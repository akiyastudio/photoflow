const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const CANCELLED_CODE = 'EOPCANCELLED';

const cancelledError = () => Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });

const isInside = (root, candidate, allowRoot = false) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowRoot && relative === '') || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
};

const assertInside = (root, candidate, label = '路径', allowRoot = false) => {
  const resolved = path.resolve(candidate);
  if (!isInside(root, resolved, allowRoot)) throw new Error(`${label}超出允许的目录`);
  return resolved;
};

const assertExistingInside = (root, candidate, label = '路径', allowRoot = false) => {
  const resolvedRoot = fs.realpathSync.native(path.resolve(root));
  const resolvedCandidate = fs.realpathSync.native(path.resolve(candidate));
  if (!isInside(resolvedRoot, resolvedCandidate, allowRoot)) throw new Error(`${label}通过符号链接超出允许的目录`);
  return resolvedCandidate;
};

const assertRegularFile = async filePath => {
  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) throw new Error(`不是可导入的普通文件：${path.basename(resolved)}`);
  return { path: resolved, stat };
};

const uniqueDestination = (directory, fileName, reserved = new Set()) => {
  const parsed = path.parse(fileName);
  let index = 1;
  let destination = path.join(directory, parsed.base);
  const key = value => process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  while (fs.existsSync(destination) || reserved.has(key(destination))) {
    destination = path.join(directory, `${parsed.name} (${index++})${parsed.ext}`);
  }
  reserved.add(key(destination));
  return destination;
};

const assertDiskSpace = async (directory, requiredBytes) => {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0 || typeof fs.promises.statfs !== 'function') return;
  try {
    const stat = await fs.promises.statfs(directory);
    const available = Number(stat.bavail) * Number(stat.bsize);
    const reserve = Math.max(256 * 1024 * 1024, Math.ceil(requiredBytes * 0.02));
    if (Number.isFinite(available) && available < requiredBytes + reserve) {
      const neededGb = ((requiredBytes + reserve - available) / 1024 ** 3).toFixed(1);
      throw new Error(`目标磁盘空间不足，至少还需要约 ${neededGb} GB`);
    }
  } catch (error) {
    if (/目标磁盘空间不足/.test(error?.message || '')) throw error;
    // Some network filesystems do not implement statfs. The atomic copy still
    // protects the final destination from partial output in that case.
  }
};

const copyFileAtomic = async (source, destination, options = {}) => {
  const { onProgress = () => undefined, isCancelled = () => false } = options;
  const sourceInfo = await assertRegularFile(source);
  const target = path.resolve(destination);
  const targetDirectory = path.dirname(target);
  await fs.promises.mkdir(targetDirectory, { recursive: true });
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  await assertDiskSpace(targetDirectory, sourceInfo.stat.size);

  const temporary = path.join(targetDirectory, `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-part`);
  let copied = 0;
  const reader = fs.createReadStream(sourceInfo.path, { highWaterMark: 4 * 1024 * 1024 });
  const writer = fs.createWriteStream(temporary, { flags: 'wx', mode: sourceInfo.stat.mode });
  const checkCancelled = () => {
    if (!isCancelled()) return;
    const error = cancelledError();
    reader.destroy(error);
    writer.destroy(error);
  };
  reader.on('data', chunk => {
    copied += chunk.length;
    onProgress({ bytesCopied: copied, totalBytes: sourceInfo.stat.size });
    checkCancelled();
  });

  try {
    checkCancelled();
    await pipeline(reader, writer);
    checkCancelled();
    const written = await fs.promises.stat(temporary);
    if (written.size !== sourceInfo.stat.size) throw new Error(`文件复制不完整：${path.basename(sourceInfo.path)}`);
    await fs.promises.utimes(temporary, sourceInfo.stat.atime, sourceInfo.stat.mtime).catch(() => undefined);
    await fs.promises.rename(temporary, target);
    onProgress({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
    return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: true };
  } catch (error) {
    reader.destroy();
    writer.destroy();
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const moveFileAtomic = async (source, destination, options = {}) => {
  const sourceInfo = await assertRegularFile(source);
  const target = path.resolve(destination);
  if (options.isCancelled?.()) throw cancelledError();
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.rename(sourceInfo.path, target);
    options.onProgress?.({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
    return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: false };
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }

  const result = await copyFileAtomic(sourceInfo.path, target, options);
  if (options.isCancelled?.()) {
    await fs.promises.rm(target, { force: true }).catch(() => undefined);
    throw cancelledError();
  }
  await fs.promises.rm(sourceInfo.path, { force: true });
  return { ...result, copied: true };
};

module.exports = {
  CANCELLED_CODE,
  assertDiskSpace,
  assertExistingInside,
  assertInside,
  assertRegularFile,
  copyFileAtomic,
  isInside,
  moveFileAtomic,
  uniqueDestination,
};
