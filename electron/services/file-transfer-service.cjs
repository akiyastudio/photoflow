const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const CANCELLED_CODE = 'EOPCANCELLED';
const SOURCE_CLEANUP_INCOMPLETE_CODE = 'ESOURCECLEANUP';
const DEFAULT_SMALL_FILE_THRESHOLD = 2 * 1024 * 1024;
const DEFAULT_SMALL_FILE_CONCURRENCY = 8;
const WINDOWS_TRANSIENT_FILE_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);

const attachTransferContext = (error, stage, source, destination) => {
  if (!error || typeof error !== 'object') return error;
  if (!error.transferStage) error.transferStage = stage;
  if (!error.sourcePath && source) error.sourcePath = source;
  if (!error.destinationPath && destination) error.destinationPath = destination;
  return error;
};

const syncTemporaryFile = async (temporary, source, destination) => {
  // FlushFileBuffers on Windows requires a handle opened with write access.
  // Opening with `r` works on Unix but returns EPERM on Windows.
  const temporaryHandle = await fs.promises.open(temporary, 'r+').catch(error => {
    throw attachTransferContext(error, 'sync-temporary', source, destination);
  });
  try {
    await temporaryHandle.sync().catch(error => {
      throw attachTransferContext(error, 'sync-temporary', source, destination);
    });
  } finally {
    await temporaryHandle.close().catch(() => undefined);
  }
};

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

const uniqueDestination = (directory, fileName, reserved = new Set(), isDirectory = false) => {
  const parsed = path.parse(fileName);
  let index = 1;
  let destination = path.join(directory, parsed.base);
  const key = value => process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  while (fs.existsSync(destination) || reserved.has(key(destination))) {
    destination = path.join(directory, isDirectory ? `${parsed.base} (${index++})` : `${parsed.name} (${index++})${parsed.ext}`);
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

const commitTemporaryFile = async (temporary, target, options = {}) => {
  const allowCopyFallback = options.allowCopyFallback ?? process.platform === 'win32';
  const renameFile = options.renameFile || fs.promises.rename.bind(fs.promises);
  const copyFile = options.copyFile || fs.promises.copyFile.bind(fs.promises);
  const maxAttempts = options.maxAttempts ?? (allowCopyFallback ? 6 : 1);
  let renameError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await renameFile(temporary, target);
      return { strategy: 'rename' };
    } catch (error) {
      renameError = error;
      if (!WINDOWS_TRANSIENT_FILE_ERRORS.has(error?.code) || fs.existsSync(target)) throw error;
      if (attempt === maxAttempts) break;
      await new Promise(resolve => setTimeout(resolve, attempt * 75));
    }
  }
  if (!allowCopyFallback || !renameError) throw renameError;

  // Windows thumbnail providers and antivirus software may briefly open the
  // completed temporary file and block rename with EPERM. An exclusive copy
  // still preserves no-overwrite semantics and is safe because the temporary
  // file has already passed the size validation above.
  let copiedTarget = false;
  try {
    await copyFile(temporary, target, fs.constants.COPYFILE_EXCL);
    copiedTarget = true;
    const [temporaryStat, targetStat] = await Promise.all([fs.promises.stat(temporary), fs.promises.stat(target)]);
    if (temporaryStat.size !== targetStat.size) {
      await fs.promises.rm(target, { force: true }).catch(() => undefined);
      throw new Error(`最终文件校验失败：${path.basename(target)}`);
    }
    for (let attempt = 1; attempt <= 6 && fs.existsSync(temporary); attempt += 1) {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      if (fs.existsSync(temporary)) await new Promise(resolve => setTimeout(resolve, attempt * 75));
    }
    return { strategy: 'copy-fallback' };
  } catch (fallbackError) {
    if (copiedTarget && fs.existsSync(target)) await fs.promises.rm(target, { force: true }).catch(() => undefined);
    fallbackError.renameErrorCode = renameError.code;
    throw fallbackError;
  }
};

const copyFileAtomic = async (source, destination, options = {}) => {
  const { onProgress = () => undefined, isCancelled = () => false, waitIfPaused = async () => undefined, durable = false } = options;
  const sourceInfo = await assertRegularFile(source).catch(error => { throw attachTransferContext(error, 'inspect-source', source, destination); });
  const target = path.resolve(destination);
  const targetDirectory = path.dirname(target);
  await fs.promises.mkdir(targetDirectory, { recursive: true }).catch(error => { throw attachTransferContext(error, 'prepare-target', sourceInfo.path, target); });
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  await assertDiskSpace(targetDirectory, sourceInfo.stat.size);

  const temporary = path.join(targetDirectory, `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-part`);
  let copied = 0;
  const reader = fs.createReadStream(sourceInfo.path, { highWaterMark: 4 * 1024 * 1024 });
  // Do not copy a Windows read-only bit onto the temporary file before the
  // atomic rename. A read-only temporary can make the final rename fail with
  // EPERM even though both source and destination are otherwise accessible.
  const writer = fs.createWriteStream(temporary, { flags: 'wx' });
  const checkCancelled = () => {
    if (!isCancelled()) return;
    const error = cancelledError();
    reader.destroy(error);
    writer.destroy(error);
  };
  const observeChunk = chunk => {
    reader.pause();
    copied += chunk.length;
    onProgress({ bytesCopied: copied, totalBytes: sourceInfo.stat.size });
    checkCancelled();
    void Promise.resolve(waitIfPaused()).then(() => {
      checkCancelled();
      if (!reader.destroyed) reader.resume();
    }, error => {
      reader.destroy(error);
      writer.destroy(error);
    });
  };

  try {
    checkCancelled();
    await waitIfPaused();
    reader.on('data', observeChunk);
    await pipeline(reader, writer).catch(error => { throw attachTransferContext(error, 'copy-data', sourceInfo.path, target); });
    checkCancelled();
    const written = await fs.promises.stat(temporary);
    if (written.size !== sourceInfo.stat.size) throw new Error(`文件复制不完整：${path.basename(sourceInfo.path)}`);
    await fs.promises.utimes(temporary, sourceInfo.stat.atime, sourceInfo.stat.mtime).catch(() => undefined);
    if (durable) await syncTemporaryFile(temporary, sourceInfo.path, target);
    checkCancelled();
    const commit = await commitTemporaryFile(temporary, target).catch(error => { throw attachTransferContext(error, 'commit-target', sourceInfo.path, target); });
    await fs.promises.chmod(target, sourceInfo.stat.mode).catch(() => undefined);
    onProgress({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
    return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: true, commitStrategy: commit.strategy };
  } catch (error) {
    reader.destroy();
    writer.destroy();
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const collectCopyPlan = async (source, destination, plan, options = {}) => {
  const { isCancelled = () => false, onDiscovered = () => undefined } = options;
  const identityFromStat = stat => ({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    modifiedMs: stat.mtimeMs,
  });
  const visitDirectory = async (directorySource, directoryDestination, directoryEntry) => {
    throwIfCancelled(isCancelled);
    const entries = await fs.promises.readdir(directorySource, { withFileTypes: true }).catch(error => { throw attachTransferContext(error, 'inspect-source', directorySource, directoryDestination); });
    directoryEntry.children = entries.map(entry => entry.name).sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      throwIfCancelled(isCancelled);
      const entrySource = path.join(directorySource, entry.name);
      const entryDestination = path.join(directoryDestination, entry.name);
      if (entry.isDirectory()) {
        const stat = await fs.promises.lstat(entrySource).catch(error => { throw attachTransferContext(error, 'inspect-source', entrySource, entryDestination); });
        const childDirectory = { kind: 'directory', source: entrySource, destination: entryDestination, size: 0, sourceIdentity: identityFromStat(stat), children: [] };
        plan.push(childDirectory);
        onDiscovered(childDirectory, plan.length);
        await visitDirectory(entrySource, entryDestination, childDirectory);
        continue;
      }
      if (!entry.isFile()) throw new Error(`不支持复制此文件类型：${entry.name}`);
      const stat = await fs.promises.lstat(entrySource).catch(error => { throw attachTransferContext(error, 'inspect-source', entrySource, entryDestination); });
      plan.push({ kind: 'file', source: entrySource, destination: entryDestination, size: stat.size, mode: stat.mode, atime: stat.atime, mtime: stat.mtime, sourceIdentity: identityFromStat(stat) });
      onDiscovered(plan[plan.length - 1], plan.length);
    }
  };

  throwIfCancelled(isCancelled);
  const stat = await fs.promises.lstat(source).catch(error => { throw attachTransferContext(error, 'inspect-source', source, destination); });
  if (stat.isDirectory()) {
    const rootDirectory = { kind: 'directory', source, destination, size: 0, sourceIdentity: identityFromStat(stat), children: [] };
    plan.push(rootDirectory);
    onDiscovered(rootDirectory, plan.length);
    await visitDirectory(source, destination, rootDirectory);
    return plan;
  }
  if (!stat.isFile()) throw new Error(`不支持复制此文件类型：${path.basename(source)}`);
  plan.push({ kind: 'file', source, destination, size: stat.size, mode: stat.mode, atime: stat.atime, mtime: stat.mtime, sourceIdentity: identityFromStat(stat) });
  onDiscovered(plan[plan.length - 1], plan.length);
  return plan;
};

const assertCopyPlanSourcesUnchanged = async plan => {
  for (const entry of plan) {
    let stat;
    try { stat = await fs.promises.lstat(entry.source); }
    catch { throw new Error(`剪切源已不存在：${path.basename(entry.source)}`); }
    const expected = entry.sourceIdentity;
    const currentDevice = stat.dev.toString();
    const currentInode = stat.ino.toString();
    const stableIdentity = expected?.device !== '0' && expected?.inode !== '0' && currentDevice !== '0' && currentInode !== '0';
    if (stableIdentity && (currentDevice !== expected.device || currentInode !== expected.inode)) throw new Error(`剪切源已被替换：${path.basename(entry.source)}`);
    if (entry.kind === 'file') {
      if (!stat.isFile() || stat.size.toString() !== expected?.size || stat.mtimeMs !== expected?.modifiedMs) throw new Error(`剪切源在复制期间发生变化：${path.basename(entry.source)}`);
      continue;
    }
    if (!stat.isDirectory()) throw new Error(`剪切源类型发生变化：${path.basename(entry.source)}`);
    const children = (await fs.promises.readdir(entry.source)).sort((left, right) => left.localeCompare(right));
    if (children.length !== entry.children.length || children.some((name, index) => name !== entry.children[index])) throw new Error(`剪切源文件夹在复制期间发生变化：${path.basename(entry.source)}`);
  }
};

const removeCopiedSources = async (plan, options = {}) => {
  const removeFile = options.removeFile || fs.promises.rm.bind(fs.promises);
  await assertCopyPlanSourcesUnchanged(plan);
  const files = plan.filter(entry => entry.kind === 'file');
  const directories = plan.filter(entry => entry.kind === 'directory').sort((left, right) => right.source.length - left.source.length);
  for (const entry of files) {
    await assertCopyPlanSourcesUnchanged([entry]);
    await removeFile(entry.source, { force: false });
  }
  for (const entry of directories) {
    const children = await fs.promises.readdir(entry.source);
    if (children.length) throw new Error(`剪切源文件夹出现了未复制的新内容：${path.basename(entry.source)}`);
    await fs.promises.rmdir(entry.source);
  }
};

const copySmallFileAtomic = async (entry, options = {}) => {
  const { isCancelled = () => false, durable = false } = options;
  const target = path.resolve(entry.destination);
  const targetDirectory = path.dirname(target);
  await fs.promises.mkdir(targetDirectory, { recursive: true }).catch(error => { throw attachTransferContext(error, 'prepare-target', entry.source, target); });
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  throwIfCancelled(isCancelled);

  const temporary = path.join(targetDirectory, `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-part`);
  try {
    await fs.promises.copyFile(entry.source, temporary, fs.constants.COPYFILE_EXCL).catch(error => { throw attachTransferContext(error, 'copy-data', entry.source, target); });
    throwIfCancelled(isCancelled);
    const written = await fs.promises.stat(temporary);
    if (written.size !== entry.size) throw new Error(`文件复制不完整：${path.basename(entry.source)}`);
    await fs.promises.utimes(temporary, entry.atime, entry.mtime).catch(() => undefined);
    if (durable) await syncTemporaryFile(temporary, entry.source, target);
    throwIfCancelled(isCancelled);
    const commit = await commitTemporaryFile(temporary, target).catch(error => { throw attachTransferContext(error, 'commit-target', entry.source, target); });
    await fs.promises.chmod(target, entry.mode).catch(() => undefined);
    return { source: entry.source, destination: target, bytes: entry.size, copied: true, commitStrategy: commit.strategy };
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const copyPlannedFiles = async (plan, options = {}) => {
  const {
    destinationRoot,
    diskSpaceChecked = false,
    durable = false,
    smallFileThreshold = DEFAULT_SMALL_FILE_THRESHOLD,
    smallFileConcurrency = DEFAULT_SMALL_FILE_CONCURRENCY,
    isCancelled = () => false,
    onCreated = () => undefined,
    onFileStart = () => undefined,
    onProgress = () => undefined,
    waitIfPaused = async () => undefined,
    isEntryComplete = async () => false,
    onEntryComplete = async () => undefined,
  } = options;
  const directories = plan.filter(entry => entry.kind === 'directory');
  const files = plan.filter(entry => entry.kind === 'file');
  const smallFiles = files.filter(entry => entry.size <= smallFileThreshold);
  const largeFiles = files.filter(entry => entry.size > smallFileThreshold);
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  if (destinationRoot && !diskSpaceChecked) await assertDiskSpace(destinationRoot, totalBytes);

  for (const entry of directories) {
    throwIfCancelled(isCancelled);
    await waitIfPaused();
    if (await isEntryComplete(entry)) continue;
    await fs.promises.mkdir(entry.destination, { recursive: false }).catch(error => { throw attachTransferContext(error, 'prepare-target', entry.source, entry.destination); });
    onCreated(entry.destination);
    await onEntryComplete(entry, { copied: true, bytes: 0 });
  }

  const control = { error: null };
  let activeSmallCopies = 0;
  let peakSmallConcurrency = 0;
  let fallbackCommits = 0;
  let smallFilesCopied = 0;
  let largeFilesCopied = 0;
  let resumedFiles = 0;
  const shouldCancel = () => Boolean(control.error) || isCancelled();
  const rememberError = error => {
    if (!control.error) control.error = error;
  };
  const runPool = async (entries, concurrency, copyEntry) => {
    let nextIndex = 0;
    const worker = async () => {
      while (!control.error) {
        try { throwIfCancelled(isCancelled); } catch (error) { rememberError(error); return; }
        try { await waitIfPaused(); } catch (error) { rememberError(error); return; }
        const index = nextIndex++;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          if (await isEntryComplete(entry)) {
            resumedFiles += 1;
            onProgress({ entry, bytesDelta: entry.size, fileCompleted: true, resumed: true });
            continue;
          }
          onFileStart(entry);
          const result = await copyEntry(entry);
          if (result?.commitStrategy === 'copy-fallback') fallbackCommits += 1;
          if (entry.size <= smallFileThreshold) smallFilesCopied += 1;
          else largeFilesCopied += 1;
          onCreated(entry.destination);
          onProgress({ entry, bytesDelta: result?.progressReported ? 0 : entry.size, fileCompleted: true });
          await onEntryComplete(entry, result);
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
      await waitIfPaused();
      return await copySmallFileAtomic(entry, { durable, isCancelled: shouldCancel });
    } finally {
      activeSmallCopies -= 1;
    }
  });
  const largePool = runPool(largeFiles, 1, async entry => {
    let reportedBytes = 0;
    const result = await copyFileAtomic(entry.source, entry.destination, {
      durable,
      isCancelled: shouldCancel,
      waitIfPaused,
      onProgress: progress => {
        const bytesDelta = Math.max(0, progress.bytesCopied - reportedBytes);
        reportedBytes = progress.bytesCopied;
        if (bytesDelta) onProgress({ entry, bytesDelta, fileCompleted: false });
      },
    });
    return { progressReported: true, commitStrategy: result.commitStrategy };
  });

  await Promise.all([smallPool, largePool]);
  if (control.error) throw control.error;
  throwIfCancelled(isCancelled);
  return {
    smallFilesCopied,
    largeFilesCopied,
    resumedFiles,
    peakSmallConcurrency,
    fallbackCommits,
  };
};

const removeCreatedPasteTargets = async targets => {
  for (const target of targets.slice().reverse()) await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
};

const moveFileAtomic = async (source, destination, options = {}) => {
  const sourceInfo = await assertRegularFile(source);
  const target = path.resolve(destination);
  const renameFile = options.renameFile || fs.promises.rename.bind(fs.promises);
  if (options.isCancelled?.()) throw cancelledError();
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await renameFile(sourceInfo.path, target);
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

const movePathAtomic = async (source, destination, options = {}) => {
  const resolvedSource = path.resolve(source);
  const target = path.resolve(destination);
  const sourceStat = await fs.promises.stat(resolvedSource);
  if (sourceStat.isFile()) return moveFileAtomic(resolvedSource, target, options);
  if (!sourceStat.isDirectory()) throw new Error(`不是可移动的文件或文件夹：${path.basename(resolvedSource)}`);
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标已存在：${path.basename(target)}`), { code: 'EEXIST' });

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const renameFile = options.renameFile || fs.promises.rename.bind(fs.promises);
  try {
    await renameFile(resolvedSource, target);
    return { source: resolvedSource, destination: target, copied: false };
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }

  // Cross-volume directories use the same planned atomic-copy pipeline as cut/paste.
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-part`);
  const plan = [];
  let targetCommitted = false;
  try {
    await collectCopyPlan(resolvedSource, temporary, plan, {
      isCancelled: options.isCancelled,
      onDiscovered: options.onDiscovered,
    });
    const totalBytes = plan.reduce((sum, entry) => sum + entry.size, 0);
    await assertDiskSpace(path.dirname(target), totalBytes);
    await copyPlannedFiles(plan, {
      destinationRoot: path.dirname(target),
      diskSpaceChecked: true,
      durable: true,
      isCancelled: options.isCancelled,
      onFileStart: options.onFileStart,
      onProgress: options.onProgress,
    });
    throwIfCancelled(options.isCancelled || (() => false));
    await assertCopyPlanSourcesUnchanged(plan);
    await fs.promises.rename(temporary, target);
    targetCommitted = true;
    throwIfCancelled(options.isCancelled || (() => false));
    await removeCopiedSources(plan, { removeFile: options.removeFile });
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (targetCommitted) {
      const cleanupError = new Error(`目标目录已完整保存，但源清理未完成，可能存在重复内容：${error?.message || '未知错误'}`);
      cleanupError.code = SOURCE_CLEANUP_INCOMPLETE_CODE;
      cleanupError.cause = error;
      cleanupError.transferStage = 'cleanup-source';
      cleanupError.sourcePath = resolvedSource;
      cleanupError.destinationPath = target;
      throw cleanupError;
    }
    throw error;
  }
  return { source: resolvedSource, destination: target, copied: true };
};

module.exports = {
  CANCELLED_CODE,
  SOURCE_CLEANUP_INCOMPLETE_CODE,
  DEFAULT_SMALL_FILE_CONCURRENCY,
  DEFAULT_SMALL_FILE_THRESHOLD,
  assertDiskSpace,
  assertCopyPlanSourcesUnchanged,
  assertExistingInside,
  assertInside,
  assertRegularFile,
  collectCopyPlan,
  commitTemporaryFile,
  copyFileAtomic,
  copyPlannedFiles,
  copySmallFileAtomic,
  isInside,
  moveFileAtomic,
  movePathAtomic,
  removeCopiedSources,
  removeCreatedPasteTargets,
  throwIfCancelled,
  uniqueDestination,
};
