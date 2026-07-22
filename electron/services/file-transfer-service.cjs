const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const CANCELLED_CODE = 'EOPCANCELLED';
const DEFAULT_SMALL_FILE_THRESHOLD = 2 * 1024 * 1024;
const DEFAULT_SMALL_FILE_CONCURRENCY = 8;

const cancelledError = () => Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });

const throwIfCancelled = isCancelled => {
  if (isCancelled?.()) throw cancelledError();
};

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
  const { onProgress = () => undefined, isCancelled = () => false, durable = false } = options;
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
    if (durable) {
      const temporaryHandle = await fs.promises.open(temporary, 'r');
      try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }
    }
    checkCancelled();
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

const collectCopyPlan = async (source, destination, plan, options = {}) => {
  const { isCancelled = () => false } = options;
  const visitDirectory = async (directorySource, directoryDestination) => {
    throwIfCancelled(isCancelled);
    const entries = await fs.promises.readdir(directorySource, { withFileTypes: true });
    for (const entry of entries) {
      throwIfCancelled(isCancelled);
      const entrySource = path.join(directorySource, entry.name);
      const entryDestination = path.join(directoryDestination, entry.name);
      if (entry.isDirectory()) {
        plan.push({ kind: 'directory', source: entrySource, destination: entryDestination, size: 0 });
        await visitDirectory(entrySource, entryDestination);
        continue;
      }
      if (!entry.isFile()) throw new Error(`不支持复制此文件类型：${entry.name}`);
      const stat = await fs.promises.lstat(entrySource);
      plan.push({ kind: 'file', source: entrySource, destination: entryDestination, size: stat.size, mode: stat.mode, atime: stat.atime, mtime: stat.mtime });
    }
  };

  throwIfCancelled(isCancelled);
  const stat = await fs.promises.lstat(source);
  if (stat.isDirectory()) {
    plan.push({ kind: 'directory', source, destination, size: 0 });
    await visitDirectory(source, destination);
    return plan;
  }
  if (!stat.isFile()) throw new Error(`不支持复制此文件类型：${path.basename(source)}`);
  plan.push({ kind: 'file', source, destination, size: stat.size, mode: stat.mode, atime: stat.atime, mtime: stat.mtime });
  return plan;
};

const copySmallFileAtomic = async (entry, options = {}) => {
  const { isCancelled = () => false, durable = false } = options;
  const target = path.resolve(entry.destination);
  const targetDirectory = path.dirname(target);
  await fs.promises.mkdir(targetDirectory, { recursive: true });
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  throwIfCancelled(isCancelled);

  const temporary = path.join(targetDirectory, `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-part`);
  try {
    await fs.promises.copyFile(entry.source, temporary, fs.constants.COPYFILE_EXCL);
    throwIfCancelled(isCancelled);
    const written = await fs.promises.stat(temporary);
    if (written.size !== entry.size) throw new Error(`文件复制不完整：${path.basename(entry.source)}`);
    await fs.promises.chmod(temporary, entry.mode).catch(() => undefined);
    await fs.promises.utimes(temporary, entry.atime, entry.mtime).catch(() => undefined);
    if (durable) {
      const temporaryHandle = await fs.promises.open(temporary, 'r');
      try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }
    }
    throwIfCancelled(isCancelled);
    await fs.promises.rename(temporary, target);
    return { source: entry.source, destination: target, bytes: entry.size, copied: true };
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const copyPlannedFiles = async (plan, options = {}) => {
  const {
    destinationRoot,
    durable = false,
    smallFileThreshold = DEFAULT_SMALL_FILE_THRESHOLD,
    smallFileConcurrency = DEFAULT_SMALL_FILE_CONCURRENCY,
    isCancelled = () => false,
    onCreated = () => undefined,
    onFileStart = () => undefined,
    onProgress = () => undefined,
  } = options;
  const directories = plan.filter(entry => entry.kind === 'directory');
  const files = plan.filter(entry => entry.kind === 'file');
  const smallFiles = files.filter(entry => entry.size <= smallFileThreshold);
  const largeFiles = files.filter(entry => entry.size > smallFileThreshold);
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  if (destinationRoot) await assertDiskSpace(destinationRoot, totalBytes);

  for (const entry of directories) {
    throwIfCancelled(isCancelled);
    await fs.promises.mkdir(entry.destination, { recursive: false });
    onCreated(entry.destination);
  }

  const control = { error: null };
  let activeSmallCopies = 0;
  let peakSmallConcurrency = 0;
  const shouldCancel = () => Boolean(control.error) || isCancelled();
  const rememberError = error => {
    if (!control.error) control.error = error;
  };
  const runPool = async (entries, concurrency, copyEntry) => {
    let nextIndex = 0;
    const worker = async () => {
      while (!control.error) {
        try { throwIfCancelled(isCancelled); } catch (error) { rememberError(error); return; }
        const index = nextIndex++;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          onFileStart(entry);
          const result = await copyEntry(entry);
          onCreated(entry.destination);
          onProgress({ entry, bytesDelta: result?.progressReported ? 0 : entry.size, fileCompleted: true });
        } catch (error) {
          rememberError(error);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), entries.length) }, worker));
  };

  const smallPool = runPool(smallFiles, smallFileConcurrency, async entry => {
    activeSmallCopies += 1;
    peakSmallConcurrency = Math.max(peakSmallConcurrency, activeSmallCopies);
    try {
      await copySmallFileAtomic(entry, { durable, isCancelled: shouldCancel });
    } finally {
      activeSmallCopies -= 1;
    }
  });
  const largePool = runPool(largeFiles, 1, async entry => {
    let reportedBytes = 0;
    await copyFileAtomic(entry.source, entry.destination, {
      durable,
      isCancelled: shouldCancel,
      onProgress: progress => {
        const bytesDelta = Math.max(0, progress.bytesCopied - reportedBytes);
        reportedBytes = progress.bytesCopied;
        if (bytesDelta) onProgress({ entry, bytesDelta, fileCompleted: false });
      },
    });
    return { progressReported: true };
  });

  await Promise.all([smallPool, largePool]);
  if (control.error) throw control.error;
  throwIfCancelled(isCancelled);
  return {
    smallFilesCopied: smallFiles.length,
    largeFilesCopied: largeFiles.length,
    peakSmallConcurrency,
  };
};

const removeCreatedPasteTargets = async targets => {
  for (const target of targets.slice().reverse()) await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
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
  DEFAULT_SMALL_FILE_CONCURRENCY,
  DEFAULT_SMALL_FILE_THRESHOLD,
  assertDiskSpace,
  assertExistingInside,
  assertInside,
  assertRegularFile,
  collectCopyPlan,
  copyFileAtomic,
  copyPlannedFiles,
  copySmallFileAtomic,
  isInside,
  moveFileAtomic,
  removeCreatedPasteTargets,
  throwIfCancelled,
  uniqueDestination,
};
