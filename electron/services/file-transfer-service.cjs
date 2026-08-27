const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { createFilePublicationService } = require('./file-publication-service.cjs');

const CANCELLED_CODE = 'EOPCANCELLED';
const SOURCE_CLEANUP_INCOMPLETE_CODE = 'ESOURCECLEANUP';
const PUBLISH_PARTIAL_CODE = 'EPUBLISHPARTIAL';
const DEFAULT_SMALL_FILE_THRESHOLD = 2 * 1024 * 1024;
const DEFAULT_SMALL_FILE_CONCURRENCY = 8;
const LINK_COPY_FALLBACK_ERRORS = new Set(['EXDEV']);
const MAX_BATCH_MANIFEST_BYTES = 480 * 1024;
let configuredNativePublicationService = null;
const configureNativePublicationService = service => { configuredNativePublicationService = service || null; };
const bundledNativePublicationService = createFilePublicationService({ app: { isPackaged: false }, projectRoot: path.resolve(__dirname, '..', '..') });
const takeBoundedBatch = (items, start, maxItems, measure) => {
  const batch = []; let bytes = 0;
  while (start + batch.length < items.length && batch.length < maxItems) {
    const item = items[start + batch.length]; const next = measure(item) + 32;
    if (batch.length && bytes + next > MAX_BATCH_MANIFEST_BYTES) break;
    batch.push(item); bytes += next;
  }
  return batch;
};

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

const publishedIdentityFromStat = (filePath, stat) => ({
  path: path.resolve(filePath),
  device: stat.dev.toString(),
  inode: stat.ino.toString(),
  size: stat.size.toString(),
  modifiedNs: typeof stat.mtimeNs === 'bigint' ? stat.mtimeNs.toString() : String(Math.trunc(stat.mtimeMs * 1e6)),
  directory: stat.isDirectory(),
});

const capturePublishedIdentity = async filePath => publishedIdentityFromStat(filePath, await fs.promises.stat(filePath, { bigint: true }));
const fileDigest = async filePath => {
  const hash = crypto.createHash('sha256');
  const reader = fs.createReadStream(filePath);
  for await (const chunk of reader) hash.update(chunk);
  return hash.digest('hex');
};

const partialPublishError = ({ source, target, identity, cleanupError, rollbackError, strategy }) => {
  const error = new Error(`内容已发布到“${path.basename(target)}”，但源文件清理失败且无法安全回滚；已保留可恢复副本`);
  error.code = PUBLISH_PARTIAL_CODE;
  error.transferStage = 'cleanup-published-source';
  error.sourcePath = source;
  error.destinationPath = target;
  error.publishedIdentity = identity;
  error.publishStrategy = strategy;
  error.published = true;
  error.recoveryRequired = true;
  error.recoveryPath = cleanupError?.recoveryPath || target;
  error.sourceRetained = true;
  error.cleanupError = cleanupError?.message || String(cleanupError);
  error.cleanupCode = cleanupError?.code;
  error.cause = cleanupError;
  error.rollbackError = rollbackError?.message || String(rollbackError || '');
  return error;
};
const stagingRecoveryError = ({ source, destination, staging, cause, strategy }) => {
  const error = new Error(`目标“${path.basename(destination)}”尚未发布；跨卷暂存副本已保留，可安全恢复或重试`);
  error.code = PUBLISH_PARTIAL_CODE;
  error.transferStage = 'recovery-staging';
  error.sourcePath = source;
  error.destinationPath = destination;
  error.published = false;
  error.publishStrategy = strategy;
  error.recoveryRequired = true;
  error.recoveryPath = cause?.recoveryPath || staging;
  error.sourceRetained = fs.existsSync(source);
  error.cleanupError = cause?.message || String(cause);
  error.cleanupCode = cause?.code;
  error.cause = cause;
  return error;
};
const publicationServiceMissingError = source => Object.assign(new Error('平台原子文件发布服务不可用，未发布任何目标，源内容已保留'), { code: 'FILE_PUBLICATION_SERVICE_MISSING', sourcePath: source, sourceRetained: true, published: false, recoveryRequired: false });

const publishPathNoClobber = async (source, destination, options = {}) => {
  const resolvedSource = path.resolve(source);
  const target = path.resolve(destination);
  const sourceStat = await fs.promises.lstat(resolvedSource);
  const existing = await fs.promises.lstat(target).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) throw Object.assign(new Error(`目标已存在：${path.basename(target)}`), { code: 'EEXIST' });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error(`不支持发布此文件类型：${path.basename(resolvedSource)}`);
  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  if (!nativeService?.nativeAvailable?.()) {
    throw publicationServiceMissingError(resolvedSource);
  }
  const result = await nativeService.moveNoReplace(resolvedSource, target);
  return { strategy: result.strategy || 'win32-move-no-replace', identity: await capturePublishedIdentity(target), nativeIdentity: result.identity, sourceRemoved: true, recoveryRequired: false };
};

const commitTemporaryFile = async (temporary, target, options = {}) => {
  return publishPathNoClobber(temporary, target, options);
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
    const commit = await commitTemporaryFile(temporary, target, options).catch(error => { throw attachTransferContext(error, 'commit-target', sourceInfo.path, target); });
    await fs.promises.chmod(target, sourceInfo.stat.mode).catch(() => undefined);
    onProgress({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
    return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: true, commitStrategy: commit.strategy, publishedIdentity: commit.identity, nativePublishedIdentity: commit.nativeIdentity };
  } catch (error) {
    reader.destroy();
    writer.destroy();
    if (error?.code !== PUBLISH_PARTIAL_CODE) await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
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

const stageSmallFileAtomic = async (entry, options = {}) => {
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
    const originalMode = Number.isInteger(entry.mode) ? entry.mode : written.mode;
    // copyFile preserves the Windows read-only attribute. Keep the staging
    // file writable for durable sync and atomic commit, then restore the
    // source mode on the published target below.
    await fs.promises.chmod(temporary, originalMode | 0o200).catch(error => {
      throw attachTransferContext(error, 'sync-temporary', entry.source, target);
    });
    await fs.promises.utimes(temporary, entry.atime, entry.mtime).catch(() => undefined);
    if (durable) await syncTemporaryFile(temporary, entry.source, target);
    throwIfCancelled(isCancelled);
    return { entry, temporary, target, originalMode };
  } catch (error) {
    if (error?.code !== PUBLISH_PARTIAL_CODE) await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const copySmallFileAtomic = async (entry, options = {}) => {
  const staged = await stageSmallFileAtomic(entry, options);
  try {
    const commit = await commitTemporaryFile(staged.temporary, staged.target, options).catch(error => { throw attachTransferContext(error, 'commit-target', entry.source, staged.target); });
    await fs.promises.chmod(staged.target, staged.originalMode).catch(() => undefined);
    return { source: entry.source, destination: staged.target, bytes: entry.size, copied: true, commitStrategy: commit.strategy, publishedIdentity: commit.identity };
  } catch (error) {
    if (error?.code !== PUBLISH_PARTIAL_CODE) await fs.promises.rm(staged.temporary, { force: true }).catch(() => undefined);
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
    copyLargeFileAtomic = copyFileAtomic,
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
    if (!control.error) { control.error = error; return; }
    if (error?.recoveryRequired) control.error.recoveryRequired = true;
    if (Array.isArray(error?.recoveryPaths)) control.error.recoveryPaths = [...new Set([...(control.error.recoveryPaths || []), ...error.recoveryPaths])];
    if (Array.isArray(error?.unknownIndexes)) control.error.unknownIndexes = [...new Set([...(control.error.unknownIndexes || []), ...error.unknownIndexes])];
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

  const smallPool = (async () => {
    const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
    if (typeof nativeService?.moveNoReplaceBatch !== 'function') {
      await runPool(smallFiles, smallFileConcurrency, async entry => {
        activeSmallCopies += 1;
        peakSmallConcurrency = Math.max(peakSmallConcurrency, activeSmallCopies);
        try {
          await waitIfPaused();
          return await copySmallFileAtomic(entry, { durable, isCancelled: shouldCancel, nativePublicationService: nativeService });
        } finally {
          activeSmallCopies -= 1;
        }
      });
      return;
    }

    const prepared = [];
    let nextIndex = 0;
    const prepareWorker = async () => {
      while (!control.error) {
        try { throwIfCancelled(isCancelled); await waitIfPaused(); } catch (error) { rememberError(error); return; }
        const index = nextIndex++;
        if (index >= smallFiles.length) return;
        const entry = smallFiles[index];
        try {
          if (await isEntryComplete(entry)) {
            resumedFiles += 1;
            onProgress({ entry, bytesDelta: entry.size, fileCompleted: true, resumed: true });
            continue;
          }
          onFileStart(entry);
          activeSmallCopies += 1;
          peakSmallConcurrency = Math.max(peakSmallConcurrency, activeSmallCopies);
          try {
            const staged = await stageSmallFileAtomic(entry, { durable, isCancelled: shouldCancel });
            prepared.push({ ...staged, planIndex: index });
          } finally {
            activeSmallCopies -= 1;
          }
        } catch (error) {
          rememberError(error);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, smallFileConcurrency), smallFiles.length) }, prepareWorker));
    prepared.sort((left, right) => left.planIndex - right.planIndex);
    if (control.error || isCancelled()) {
      if (!control.error) rememberError(cancelledError());
    }
    if (!prepared.length) return;

    const batchSize = 2048;
    const preservedUnknown = new Set();
    try {
      for (let offset = 0; offset < prepared.length;) {
        const inspectionChunk = takeBoundedBatch(prepared, offset, batchSize, item => Math.ceil(Buffer.byteLength(item.temporary) / 3) * 4);
        const inspections = await nativeService.inspectPathsBatch(inspectionChunk.map(item => item.temporary));
        for (let index = 0; index < inspectionChunk.length; index += 1) {
          if (!inspections[index]?.success || typeof inspections[index].identity !== 'string') throw Object.assign(new Error('无法预捕获批量发布源身份'), { code: 'PUBLISH_OWNERSHIP_CONFLICT', recoveryPaths: inspectionChunk.map(item => item.temporary), recoveryRequired: true });
          inspectionChunk[index].nativeIdentity = inspections[index].identity;
        }
        offset += inspectionChunk.length;
      }
    } catch (error) {
      error.recoveryRequired = true;
      error.recoveryPaths = prepared.filter(item => !item.nativeIdentity).map(item => item.temporary);
      rememberError(error);
    }
    for (let offset = 0; offset < prepared.length && !control.error;) {
      try { throwIfCancelled(isCancelled); await waitIfPaused(); } catch (error) { rememberError(error); break; }
      const chunk = takeBoundedBatch(prepared, offset, batchSize, item => Math.ceil(Buffer.byteLength(item.temporary) / 3) * 4 + Math.ceil(Buffer.byteLength(item.target) / 3) * 4 + Math.ceil(Buffer.byteLength(item.nativeIdentity) / 3) * 4);
      let completed = [];
      let publicationError = null;
      try {
        completed = await nativeService.moveNoReplaceBatch(chunk.map(item => ({ source: item.temporary, target: item.target, identity: item.nativeIdentity })));
      } catch (error) {
        completed = Array.isArray(error.completed) ? error.completed : [];
        publicationError = error;
        try {
          const observed = await nativeService.inspectPathsBatch([...chunk.map(item => item.temporary), ...chunk.map(item => item.target)]);
          const reconciled = [];
          const unknown = [];
          for (let index = 0; index < chunk.length; index += 1) {
            const sourceState = observed[index]; const targetState = observed[chunk.length + index]; const identity = chunk[index].nativeIdentity;
            if (!sourceState.success && targetState.success && targetState.identity === identity) reconciled.push({ index, identity, strategy: 'native-batch-reconciled' });
            else if (!(sourceState.success && sourceState.identity === identity && !targetState.success)) unknown.push(index);
          }
          completed = reconciled;
          if (unknown.length) {
            publicationError.unknownIndexes = unknown.map(index => offset + index);
            for (const index of unknown) preservedUnknown.add(chunk[index].temporary);
            publicationError.recoveryRequired = true;
            publicationError.recoveryPaths = unknown.map(index => chunk[index].temporary).filter(candidate => fs.existsSync(candidate));
          }
        } catch (reconcileError) {
          publicationError.reconciliationError = reconcileError;
        }
      }
      const completedIndexes = new Set(completed.map(item => item.index));
      const published = chunk.filter((_, index) => completedIndexes.has(index));

      // Establish ownership of every target in this chunk before a callback
      // can cancel or fail, so callers can roll back the exact committed set.
      const owned = [];
      for (const item of published) {
        await fs.promises.chmod(item.target, item.originalMode).catch(() => undefined);
        const localIndex = chunk.indexOf(item); const nativeResult = completed.find(result => result.index === localIndex);
        const targetStat = await fs.promises.stat(item.target, { bigint: true });
        const publishedIdentity = { ...publishedIdentityFromStat(item.target, targetStat), nativeIdentity: nativeResult.identity };
        owned.push({ item, publishedIdentity, strategy: nativeResult.strategy || 'native-batch-move-no-replace' });
        onCreated(item.target);
      }
      for (const { item, publishedIdentity, strategy } of owned) {
        smallFilesCopied += 1;
        onProgress({ entry: item.entry, bytesDelta: item.entry.size, fileCompleted: true });
        try { await onEntryComplete(item.entry, { source: item.entry.source, destination: item.target, bytes: item.entry.size, copied: true, commitStrategy: strategy, publishedIdentity }); }
        catch (error) { rememberError(error); break; }
      }
      if (publicationError && !control.error) {
        const failed = chunk[publicationError.failedIndex];
        rememberError(attachTransferContext(publicationError, 'commit-target', failed?.entry.source, failed?.target));
      }
      offset += chunk.length;
    }
    if (isCancelled() && !control.error) rememberError(cancelledError());
    const unprocessed = prepared.filter(item => !preservedUnknown.has(item.temporary) && item.nativeIdentity && fs.existsSync(item.temporary));
    if (control.error || isCancelled()) {
      for (let offset = 0; offset < unprocessed.length;) {
        const cleanupChunk = takeBoundedBatch(unprocessed, offset, batchSize, item => Math.ceil(Buffer.byteLength(item.temporary) / 3) * 4 + Math.ceil(Buffer.byteLength(item.nativeIdentity) / 3) * 4);
        try {
          const results = await nativeService.deletePathsBatch(cleanupChunk.map(item => ({ path: item.temporary, identity: item.nativeIdentity })));
          const retained = results.map((result, index) => result.success ? null : (result.recoveryPath || cleanupChunk[index].temporary)).filter(Boolean);
          if (retained.length && control.error) { control.error.recoveryRequired = true; control.error.recoveryPaths = [...new Set([...(control.error.recoveryPaths || []), ...retained])]; }
        } catch (cleanupError) {
          if (control.error) { control.error.recoveryRequired = true; control.error.recoveryPaths = [...new Set([...(control.error.recoveryPaths || []), ...cleanupChunk.map(item => item.temporary)])]; control.error.cleanupError = cleanupError; }
        }
        offset += cleanupChunk.length;
      }
    }
  })();
  const largePool = runPool(largeFiles, 1, async entry => {
    let reportedBytes = 0;
    const result = await copyLargeFileAtomic(entry.source, entry.destination, {
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
  if (options.isCancelled?.()) throw cancelledError();
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    const publish = await publishPathNoClobber(sourceInfo.path, target, options);
    options.onProgress?.({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
    return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: false, commitStrategy: publish.strategy };
  } catch (error) {
    if (!LINK_COPY_FALLBACK_ERRORS.has(error?.code)) throw error;
  }

  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  if (!nativeService?.nativeAvailable?.()) {
    throw publicationServiceMissingError(sourceInfo.path);
  }
  const sourceIdentity = (await nativeService.inspectPath(sourceInfo.path)).identity;
  const staged = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-cross-volume`);
  try {
    const stagedCopy = await copyFileAtomic(sourceInfo.path, staged, { ...options, isCancelled: options.isCancelled });
    const [stagedStat, sha256] = await Promise.all([fs.promises.stat(staged), fileDigest(staged)]);
    if (options.isCancelled?.()) {
      await nativeService.compareDeleteFile({ target: staged, sha256, size: stagedStat.size, identity: stagedCopy.nativePublishedIdentity });
      throw cancelledError();
    }
    const committed = await nativeService.commitCrossVolumeFile({ source: sourceInfo.path, staged, target, sha256, size: stagedStat.size, sourceIdentity });
    options.onProgress?.({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
    return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: true, commitStrategy: committed.strategy };
  } catch (error) {
    if (error?.code === CANCELLED_CODE || error?.code === 'EEXIST') throw error;
    const targetExists = fs.existsSync(target);
    const stagedExists = fs.existsSync(staged);
    if (stagedExists) error.recoveryPath = staged;
    if (targetExists) throw partialPublishError({ source: sourceInfo.path, target, cleanupError: error, strategy: 'win32-cross-volume-locked-commit' });
    if (stagedExists) throw stagingRecoveryError({ source: sourceInfo.path, destination: target, staging: staged, cause: error, strategy: 'cross-volume-staging-recovery' });
    throw error;
  }
};

const movePathAtomic = async (source, destination, options = {}) => {
  const resolvedSource = path.resolve(source);
  const target = path.resolve(destination);
  const sourceStat = await fs.promises.stat(resolvedSource);
  if (sourceStat.isFile()) return moveFileAtomic(resolvedSource, target, options);
  if (!sourceStat.isDirectory()) throw new Error(`不是可移动的文件或文件夹：${path.basename(resolvedSource)}`);
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标已存在：${path.basename(target)}`), { code: 'EEXIST' });

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await publishPathNoClobber(resolvedSource, target, options);
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
    const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
    if (nativeService?.nativeAvailable?.()) {
      for (const entry of plan) entry.nativeSourceIdentity = (await nativeService.inspectPath(entry.source)).identity;
    }
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
    await publishPathNoClobber(temporary, target, options.publishTemporaryOptions || {});
    targetCommitted = true;
    throwIfCancelled(options.isCancelled || (() => false));
    if (nativeService?.nativeAvailable?.()) {
      const completedSources = [];
      try {
        for (const entry of plan.filter(item => item.kind === 'file')) {
          throwIfCancelled(options.isCancelled || (() => false));
          const relative = path.relative(temporary, entry.destination);
          const targetFile = path.join(target, relative);
          const sha256 = await fileDigest(targetFile);
          await nativeService.commitTreeFile({ source: entry.source, target: targetFile, sha256, size: entry.size, identity: entry.nativeSourceIdentity });
          completedSources.push(entry.source);
        }
        for (const entry of plan.filter(item => item.kind === 'directory').sort((left, right) => right.source.length - left.source.length)) {
          throwIfCancelled(options.isCancelled || (() => false));
          await nativeService.deleteEmptyDirectory({ source: entry.source, identity: entry.nativeSourceIdentity });
          completedSources.push(entry.source);
        }
      } catch (cleanupError) {
        const partial = partialPublishError({ source: resolvedSource, target, identity: await capturePublishedIdentity(target), cleanupError, strategy: 'win32-cross-volume-directory-locked-commit' });
        partial.completedSourcePaths = completedSources;
        partial.remainingSourcePaths = plan.map(entry => entry.source).filter(candidate => fs.existsSync(candidate));
        throw partial;
      }
    } else throw publicationServiceMissingError(resolvedSource);
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (error?.code === PUBLISH_PARTIAL_CODE) throw error;
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
  PUBLISH_PARTIAL_CODE,
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
  configureNativePublicationService,
  copyFileAtomic,
  copyPlannedFiles,
  copySmallFileAtomic,
  isInside,
  moveFileAtomic,
  movePathAtomic,
  publishPathNoClobber,
  removeCopiedSources,
  removeCreatedPasteTargets,
  throwIfCancelled,
  uniqueDestination,
};
