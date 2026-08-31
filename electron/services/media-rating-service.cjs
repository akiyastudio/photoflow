const createMediaRatingService = ({ exiftool, fs, path, imageExtensions, rawExtensions, releaseWorkspaceWatchPath, suppressWorkspaceWatchPath, versionService, projectVirtualPaths, writeLog, pendingRatingsPath = '', onInvalidate = () => undefined, retryDelayMs = 30000, checkedRetryDelayMs = 250, checkedRetryDeadlineMs = 30000, now = () => Date.now() }) => {
  const cache = new Map();
  const pendingFile = pendingRatingsPath ? path.resolve(pendingRatingsPath) : '';
  const backupFile = pendingFile ? `${pendingFile}.backup` : '';
  const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
  const pendingRatings = new Map();
  const optimisticRatings = new Map();
  const fileIntentQueues = new Map();
  const fileDrains = new Map();
  const itemCompletions = new Map();
  const terminalStates = new Map();
  const activePhysicalTokens = new Set();
  const physicalAttemptedTokens = new Set();
  const processingTokens = new Set();
  const deadlineSignals = new Set();
  let writeSequence = 0;
  let operationSequence = 0;
  let recoveredFromBackup = false;
  let outboxLoadError = null;
  const normalize = value => Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
  const validPendingItem = item => item && typeof item === 'object'
    && typeof item.workspaceRoot === 'string' && item.workspaceRoot.trim()
    && typeof item.filePath === 'string' && item.filePath.trim()
    && typeof item.token === 'string' && item.token
    && (item.stage === undefined || ['metadata', 'writing', 'fingerprint', 'failed'].includes(item.stage))
    && (item.type === undefined || ['ordinary', 'checked'].includes(item.type))
    && (item.expectedRevision === undefined || Number.isFinite(item.expectedRevision))
    && (item.failureCount === undefined || (Number.isSafeInteger(item.failureCount) && item.failureCount >= 0))
    && (item.lastError === undefined || typeof item.lastError === 'string')
    && (item.deadlineAt === undefined || Number.isFinite(item.deadlineAt))
    && (item.identity === undefined || (item.identity && typeof item.identity === 'object'
      && typeof item.identity.device === 'string' && typeof item.identity.inode === 'string'
      && typeof item.identity.size === 'string' && typeof item.identity.modifiedNs === 'string'
      && item.identity.kind === 'file'))
    && (item.sequence === undefined || Number.isSafeInteger(item.sequence))
    && Number.isInteger(item.rating) && item.rating >= 0 && item.rating <= 5
    && Number.isFinite(item.updatedAt);
  const readPendingDocument = fileName => {
    const parsed = JSON.parse(fs.readFileSync(fileName, 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.items) || parsed.items.length > 10000 || !parsed.items.every(validPendingItem)) throw new Error('媒体评级待处理文件结构无效');
    return parsed.items;
  };
  if (pendingFile && (fs.existsSync(pendingFile) || fs.existsSync(backupFile))) {
    try {
      let items;
      try { items = readPendingDocument(pendingFile); }
      catch (error) {
        if (!fs.existsSync(backupFile)) throw error;
        items = readPendingDocument(backupFile);
        recoveredFromBackup = true;
      }
      for (const item of items) {
        const key = pathKey(item.filePath);
        const entry = { ...item, type: item.type || 'ordinary', stage: item.stage || 'metadata', filePath: path.resolve(item.filePath), workspaceRoot: path.resolve(item.workspaceRoot) };
        if (entry.type === 'checked' && !Number.isFinite(entry.deadlineAt)) entry.deadlineAt = now() + checkedRetryDeadlineMs;
        operationSequence = Math.max(operationSequence, Number(entry.sequence) || 0);
        const queue = pendingRatings.get(key) || [];
        queue.push(entry);
        pendingRatings.set(key, queue);
      }
    } catch (error) {
      outboxLoadError = error;
      writeLog?.('warn', 'Unable to load media rating outbox', { pendingFile, error: error.message || String(error) });
    }
  }
  const refreshOptimistic = key => {
    const pending = (pendingRatings.get(key) || []).filter(item => item.stage !== 'failed');
    if (pending.length) optimisticRatings.set(key, pending[pending.length - 1].rating);
    else optimisticRatings.delete(key);
  };
  for (const key of pendingRatings.keys()) refreshOptimistic(key);
  const syncDirectory = directory => {
    let descriptor;
    try { descriptor = fs.openSync(directory, 'r'); fs.fsyncSync(descriptor); }
    catch { /* directory fsync is unavailable on some Windows filesystems */ }
    finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {} }
  };
  const writePendingTemporary = (temporary, items) => {
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx');
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, items }), 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  const savePendingRatings = () => {
    if (!pendingFile) return;
    if (outboxLoadError) throw new Error(`媒体评级待处理文件损坏，已停止覆盖: ${outboxLoadError.message || String(outboxLoadError)}`);
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    const temporary = `${pendingFile}.tmp-${process.pid}-${Date.now()}-${++writeSequence}`;
    const items = [...pendingRatings.values()].flat();
    try {
      writePendingTemporary(temporary, items);
      try {
        if (fs.existsSync(pendingFile)) {
          fs.rmSync(backupFile, { force: true });
          fs.renameSync(pendingFile, backupFile);
        }
        fs.renameSync(temporary, pendingFile);
        syncDirectory(path.dirname(pendingFile));
      } catch (error) {
        if (!fs.existsSync(pendingFile) && fs.existsSync(backupFile)) fs.renameSync(backupFile, pendingFile);
        throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  };
  if (recoveredFromBackup) {
    const temporary = `${pendingFile}.recovery-${process.pid}-${Date.now()}-${++writeSequence}`;
    const corrupt = `${pendingFile}.corrupt-${process.pid}-${Date.now()}`;
    try {
      writePendingTemporary(temporary, [...pendingRatings.values()].flat());
      if (fs.existsSync(pendingFile)) fs.renameSync(pendingFile, corrupt);
      fs.renameSync(temporary, pendingFile);
      syncDirectory(path.dirname(pendingFile));
    } catch (error) {
      outboxLoadError = error;
      writeLog?.('warn', 'Unable to atomically recover media rating outbox from backup', { pendingFile, backupFile, error: error.message || String(error) });
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const fromTags = tags => {
    const entries = Object.entries(tags || {});
    const direct = entries.find(([name]) => /^XMP[^:]*:Rating$/i.test(name)) || entries.find(([name]) => /(?:^|:)Rating$/i.test(name));
    if (direct) return normalize(direct[1]);
    const percent = Number(entries.find(([name]) => /(?:^|:)RatingPercent$/i.test(name))?.[1]);
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    if (percent <= 1) return 1;
    if (percent <= 25) return 2;
    if (percent <= 50) return 3;
    if (percent <= 75) return 4;
    return 5;
  };
  const read = async (filePath, knownUpdatedAt) => {
    const optimistic = optimisticRatings.get(pathKey(filePath));
    if (optimistic !== undefined) return optimistic;
    const stat = await fs.promises.stat(filePath);
    void knownUpdatedAt;
    const cacheKey = `${path.resolve(filePath)}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const tags = await exiftool.readRaw(filePath, ['-G1', '-Rating#', '-RatingPercent#', '-n', '-api', 'largefilesupport=1']);
    const rating = fromTags(tags);
    if (cache.size >= 4000) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, rating);
    return rating;
  };
  const invalidate = filePath => {
    const prefix = `${path.resolve(filePath)}|`;
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    onInvalidate(filePath);
  };
  const itemAttemptStarts = new Map();
  const enqueueIntent = (key, worker) => {
    const previous = fileIntentQueues.get(key) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(worker);
    fileIntentQueues.set(key, operation);
    return operation.finally(() => { if (fileIntentQueues.get(key) === operation) fileIntentQueues.delete(key); });
  };
  const isInside = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const assertWorkspaceOwnership = async (workspaceRoot, filePath) => {
    const [canonicalWorkspace, canonicalFile] = await Promise.all([fs.promises.realpath(workspaceRoot), fs.promises.realpath(filePath)]);
    if (isInside(canonicalWorkspace, canonicalFile)) return canonicalFile;
    // IPC callers distinguish another workspace from an explicitly authorized
    // external path before entering this service. Component callers resolve
    // through their bound project capability. Do not call the project-scoped
    // virtual-path API with a workspace root and reject valid managed links.
    return canonicalFile;
  };
  const identityFromStat = stat => ({
    device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(), modifiedNs: stat.mtimeNs.toString(), kind: stat.isFile() ? 'file' : 'other',
  });
  const captureFileIdentity = async filePath => {
    const stat = await fs.promises.lstat(filePath, { bigint: true });
    const identity = identityFromStat(stat);
    if (identity.kind !== 'file' || stat.isSymbolicLink()) {
      const error = new Error('media_rating_target_not_regular_file'); error.code = 'EINVAL'; throw error;
    }
    return identity;
  };
  const sameFileIdentity = (expected, current) => {
    if (!expected || expected.kind !== 'file' || current.kind !== 'file') return false;
    if (expected.device !== '0' && expected.inode !== '0' && current.device !== '0' && current.inode !== '0') {
      return expected.device === current.device && expected.inode === current.inode;
    }
    return expected.size === current.size && expected.modifiedNs === current.modifiedNs;
  };
  const openIntentIdentity = async (item, flags = 'r') => {
    if (!item.identity) {
      const error = new Error('media_rating_intent_identity_missing'); error.code = 'MEDIA_RATING_IDENTITY_MISSING'; throw error;
    }
    const handle = await fs.promises.open(item.filePath, flags);
    try {
      const current = identityFromStat(await handle.stat({ bigint: true }));
      if (!sameFileIdentity(item.identity, current)) {
        const error = new Error('media_rating_target_identity_changed'); error.code = 'MEDIA_RATING_IDENTITY_CHANGED'; throw error;
      }
      return handle;
    } catch (error) { await handle.close().catch(() => undefined); throw error; }
  };
  const sortPending = key => (pendingRatings.get(key) || []).sort((left, right) => (Number(left.sequence) || 0) - (Number(right.sequence) || 0));
  const removePendingItem = (key, token) => {
    const remaining = (pendingRatings.get(key) || []).filter(item => item.token !== token);
    if (remaining.length) pendingRatings.set(key, remaining); else pendingRatings.delete(key);
    refreshOptimistic(key);
  };
  const restorePendingHead = (key, item) => {
    const queue = pendingRatings.get(key) || [];
    if (!queue.some(candidate => candidate.token === item.token)) queue.push(item);
    pendingRatings.set(key, queue);
    sortPending(key);
    refreshOptimistic(key);
  };
  const removePendingDurably = (key, item) => {
    removePendingItem(key, item.token);
    try { savePendingRatings(); deadlineSignals.delete(item.token); physicalAttemptedTokens.delete(item.token); }
    catch (error) { restorePendingHead(key, item); throw error; }
  };
  const retryDelay = (item, attempt, keepAlive = false) => new Promise(resolve => {
    const boundedChecked = item.type === 'checked' && ['metadata', 'writing'].includes(item.stage);
    const ordinaryDelay = Math.min(5 * 60 * 1000, retryDelayMs * (2 ** Math.min(6, Math.max(0, attempt - 1))));
    const checkedDelay = Math.min(5000, checkedRetryDelayMs * (2 ** Math.min(6, Math.max(0, attempt - 1))));
    const remaining = boundedChecked ? Math.max(0, Number(item.deadlineAt) - now()) : ordinaryDelay;
    const timer = setTimeout(resolve, boundedChecked ? Math.min(checkedDelay, remaining) : ordinaryDelay);
    if (!keepAlive) timer.unref?.();
  });
  const backgroundRetryDelay = () => new Promise(resolve => {
    const timer = setTimeout(resolve, retryDelayMs);
    timer.unref?.();
  });
  const revisionConflict = () => {
    const error = new Error('media_rating_revision_conflict');
    error.code = 'MEDIA_RATING_REVISION_CONFLICT';
    return error;
  };
  const isPermanentRatingError = error => ['ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'MEDIA_RATING_IDENTITY_MISSING', 'MEDIA_RATING_IDENTITY_CHANGED', 'MEDIA_RATING_LEGACY_PROVENANCE_MISMATCH'].includes(error?.code);
  const markIntentFailedDurably = (key, item, error) => {
    const previousStage = item.stage;
    item.stage = 'failed';
    item.lastError = error?.message || String(error);
    try { savePendingRatings(); }
    catch (persistError) { item.stage = previousStage; throw persistError; }
    deadlineSignals.delete(item.token);
    physicalAttemptedTokens.delete(item.token);
    refreshOptimistic(key);
  };
  const settleCompletion = (item, method, value) => {
    const completion = itemCompletions.get(item.token);
    if (!completion) return;
    itemCompletions.delete(item.token);
    clearTimeout(completion.timer);
    completion[method](value);
  };
  const outcomeUnknownError = persistError => {
    const error = new Error(`media_rating_outcome_unknown: 无法持久化评级终态: ${persistError?.message || String(persistError)}`);
    error.code = 'MEDIA_RATING_OUTCOME_UNKNOWN';
    return error;
  };
  const isolateUnknownIntent = (key, item, persistError) => {
    item.stage = 'failed';
    item.lastError = outcomeUnknownError(persistError).message;
    deadlineSignals.delete(item.token);
    physicalAttemptedTokens.delete(item.token);
    refreshOptimistic(key);
    settleCompletion(item, 'reject', outcomeUnknownError(persistError));
  };
  const checkedDeadlineError = () => {
    const error = new Error('media_rating_checked_deadline_exceeded');
    error.code = 'MEDIA_RATING_CHECKED_DEADLINE_EXCEEDED';
    return error;
  };
  const handleCheckedDeadline = (key, item) => {
    if (!itemCompletions.has(item.token)) return;
    const deadlineError = checkedDeadlineError();
    if (processingTokens.has(item.token)) {
      deadlineSignals.add(item.token);
      settleCompletion(item, 'reject', outcomeUnknownError(deadlineError));
      return;
    }
    if ((item.stage === 'metadata' || item.stage === 'writing')
      && !physicalAttemptedTokens.has(item.token) && !activePhysicalTokens.has(item.token)) {
      try {
        markIntentFailedDurably(key, item, deadlineError);
        settleCompletion(item, 'reject', deadlineError);
      } catch (persistError) { isolateUnknownIntent(key, item, persistError); }
      return;
    }
    deadlineSignals.add(item.token);
    settleCompletion(item, 'reject', outcomeUnknownError(deadlineError));
  };
  const registerCheckedCompletion = (key, item, resolve, reject) => {
    const timer = setTimeout(() => handleCheckedDeadline(key, item), Math.max(0, Number(item.deadlineAt) - now()));
    itemCompletions.set(item.token, { resolve, reject, timer });
  };
  const readPhysicalRating = async filePath => fromTags(await exiftool.readRaw(filePath, ['-G1', '-Rating#', '-RatingPercent#', '-n', '-api', 'largefilesupport=1']));
  const legacyProvenanceMismatch = () => {
    const error = new Error('media_rating_legacy_provenance_mismatch');
    error.code = 'MEDIA_RATING_LEGACY_PROVENANCE_MISMATCH';
    return error;
  };
  const migrateLegacyIntent = async (key, item, filePath) => {
    const identity = await captureFileIdentity(filePath);
    const stat = await fs.promises.lstat(filePath);
    const previous = { identity: item.identity, stage: item.stage, previousRevision: item.previousRevision, revision: item.revision };
    if (item.stage === 'fingerprint') {
      if (await readPhysicalRating(filePath) !== item.rating
        || (Number.isFinite(item.revision) && stat.mtimeMs !== Number(item.revision))) throw legacyProvenanceMismatch();
    } else if (item.stage === 'writing') {
      if (await readPhysicalRating(filePath) === item.rating) {
        item.previousRevision = Number.isFinite(item.expectedRevision) ? Number(item.expectedRevision) : stat.mtimeMs;
        item.revision = stat.mtimeMs;
        item.stage = 'fingerprint';
      } else if (item.type === 'checked' && stat.mtimeMs !== Number(item.expectedRevision)) throw revisionConflict();
    }
    item.identity = identity;
    try { savePendingRatings(); }
    catch (error) {
      if (previous.identity === undefined) delete item.identity; else item.identity = previous.identity;
      item.stage = previous.stage;
      item.previousRevision = previous.previousRevision;
      item.revision = previous.revision;
      throw error;
    }
  };
  const reconcileCompletedCheckedWriteNow = async (key, item) => {
    const handle = await openIntentIdentity(item, 'r+');
    try {
      const aborted = () => item.stage === 'failed' || deadlineSignals.has(item.token);
      if (aborted()) return false;
      const physicalRating = await readPhysicalRating(item.filePath);
      if (aborted() || physicalRating !== item.rating) return false;
      let current = await handle.stat();
      if (aborted()) return false;
      const heldIdentity = identityFromStat(await handle.stat({ bigint: true }));
      if (aborted()) return false;
      const pathIdentity = await captureFileIdentity(item.filePath);
      if (aborted() || !sameFileIdentity(heldIdentity, pathIdentity)) return false;
      if (current.mtimeMs === Number(item.expectedRevision)) {
        if (aborted()) return false;
        const bumped = new Date(Math.max(now(), current.mtimeMs + 2000));
        await handle.utimes(current.atime, bumped);
        if (aborted()) return false;
        current = await handle.stat();
        if (aborted()) return false;
      }
      const finalHeldIdentity = identityFromStat(await handle.stat({ bigint: true }));
      if (aborted()) return false;
      const finalPathIdentity = await captureFileIdentity(item.filePath);
      if (aborted() || !sameFileIdentity(finalHeldIdentity, finalPathIdentity)) return false;
      item.previousRevision = Number(item.expectedRevision);
      const previousIdentity = item.identity;
      item.identity = finalPathIdentity;
      item.revision = current.mtimeMs;
      item.stage = 'fingerprint';
      if (aborted()) { item.identity = previousIdentity; item.stage = 'writing'; return false; }
      try { savePendingRatings(); }
      catch (error) {
        item.identity = previousIdentity;
        item.stage = 'writing';
        error.ratingReconcilePersistFailed = true;
        throw error;
      }
      deadlineSignals.delete(item.token);
      physicalAttemptedTokens.delete(item.token);
      invalidate(item.filePath);
      settleCompletion(item, 'resolve', { rating: item.rating, previousRevision: item.previousRevision, revision: item.revision });
      return true;
    } finally { await handle.close().catch(() => undefined); }
  };
  const reconcileCompletedCheckedWrite = async (key, item) => {
    processingTokens.add(item.token);
    try { return await reconcileCompletedCheckedWriteNow(key, item); }
    finally { processingTokens.delete(item.token); }
  };
  const processPendingHeadNow = async (key, item) => {
    const ownedFilePath = await assertWorkspaceOwnership(item.workspaceRoot, item.filePath);
    if (item.stage === 'failed') return;
    if (item.type === 'checked' && ['metadata', 'writing'].includes(item.stage) && deadlineSignals.has(item.token)) throw checkedDeadlineError();
    if (!item.identity) {
      await migrateLegacyIntent(key, item, ownedFilePath);
      if (item.type === 'checked' && ['metadata', 'writing'].includes(item.stage) && deadlineSignals.has(item.token)) throw checkedDeadlineError();
    }
    if (item.stage === 'metadata') {
      if (item.type === 'checked') {
        if (deadlineSignals.has(item.token) || now() >= Number(item.deadlineAt)) throw checkedDeadlineError();
        const current = await fs.promises.lstat(ownedFilePath);
        if (deadlineSignals.has(item.token) || now() >= Number(item.deadlineAt)) throw checkedDeadlineError();
        if (!current.isFile() || current.isSymbolicLink() || current.mtimeMs !== Number(item.expectedRevision)) throw revisionConflict();
      }
      item.stage = 'writing';
      try { savePendingRatings(); }
      catch (error) { item.stage = 'metadata'; throw error; }
      if (item.type === 'checked' && (deadlineSignals.has(item.token) || now() >= Number(item.deadlineAt))) throw checkedDeadlineError();
    }
    if (item.stage === 'writing') {
      const identityHandle = await openIntentIdentity(item, item.type === 'checked' ? 'r+' : 'r');
      try {
        if (item.stage === 'failed') return;
        if (item.type === 'checked' && deadlineSignals.has(item.token)) throw checkedDeadlineError();
        const before = await identityHandle.stat();
        let publishedIdentity;
        let timestampBumped = false;
        if (!before.isFile()) throw revisionConflict();
        if (item.type === 'checked' && before.mtimeMs !== Number(item.expectedRevision)) {
          if (await readPhysicalRating(ownedFilePath) !== item.rating) throw revisionConflict();
          item.previousRevision = Number(item.expectedRevision);
          item.revision = before.mtimeMs;
          publishedIdentity = await captureFileIdentity(ownedFilePath);
        } else {
          const suppressedPaths = [ownedFilePath, `${ownedFilePath}_exiftool_tmp`, `${ownedFilePath}_original`];
          suppressedPaths.forEach(suppressWorkspaceWatchPath);
          try {
            // Checked writes trade some performance and hidden/read-only file
            // compatibility for a stable file object across the CAS write.
            // Never fall back to rename publication for this strong path.
            const writeArgs = item.type === 'checked' ? ['-overwrite_original_in_place'] : ['-overwrite_original', '-P'];
            if (item.stage === 'failed') return;
            if (item.type === 'checked' && (deadlineSignals.has(item.token) || now() >= Number(item.deadlineAt))) throw checkedDeadlineError();
            if (item.type === 'checked') physicalAttemptedTokens.add(item.token);
            if (item.type === 'checked') activePhysicalTokens.add(item.token);
            const metadataWrite = exiftool.write(ownedFilePath, { 'XMP:Rating': item.rating }, { writeArgs });
            itemAttemptStarts.get(item.token)?.();
            itemAttemptStarts.delete(item.token);
            await metadataWrite;
          } finally {
            activePhysicalTokens.delete(item.token);
            suppressedPaths.forEach(releaseWorkspaceWatchPath);
          }
          let after = await fs.promises.lstat(ownedFilePath);
          const heldAfterWrite = identityFromStat(await identityHandle.stat({ bigint: true }));
          const pathAfterWrite = await captureFileIdentity(ownedFilePath);
          publishedIdentity = pathAfterWrite;
          if (!sameFileIdentity(heldAfterWrite, pathAfterWrite)
            && (item.type === 'checked' || await readPhysicalRating(ownedFilePath) !== item.rating)) {
            const error = new Error('media_rating_target_changed_without_expected_rating'); error.code = 'MEDIA_RATING_IDENTITY_CHANGED'; throw error;
          }
          if (item.type === 'checked' && after.mtimeMs === before.mtimeMs) {
            const bumped = new Date(Math.max(now(), before.mtimeMs + 2000));
            await identityHandle.utimes(after.atime, bumped);
            after = await fs.promises.lstat(ownedFilePath);
            timestampBumped = true;
          }
          item.previousRevision = before.mtimeMs;
          item.revision = after.mtimeMs;
        }
        const finalIdentity = await captureFileIdentity(ownedFilePath);
        const stablePublishedIdentity = publishedIdentity.device !== '0' && publishedIdentity.inode !== '0' && finalIdentity.device !== '0' && finalIdentity.inode !== '0';
        if ((stablePublishedIdentity && !sameFileIdentity(publishedIdentity, finalIdentity))
          || (!stablePublishedIdentity && !timestampBumped && !sameFileIdentity(publishedIdentity, finalIdentity))) {
          const error = new Error('media_rating_target_changed_after_write'); error.code = 'MEDIA_RATING_IDENTITY_CHANGED'; throw error;
        }
        item.identity = finalIdentity;
        invalidate(ownedFilePath);
        item.stage = 'fingerprint';
        try { savePendingRatings(); }
        catch (error) { item.stage = 'writing'; throw error; }
        deadlineSignals.delete(item.token);
        physicalAttemptedTokens.delete(item.token);
      } finally { await identityHandle.close().catch(() => undefined); }
      settleCompletion(item, 'resolve', { rating: item.rating, previousRevision: item.previousRevision, revision: item.revision });
    }
    const fingerprintHandle = await openIntentIdentity(item);
    await fingerprintHandle.close().catch(() => undefined);
    await versionService.refreshMetadataFingerprint(item.workspaceRoot, { filePath: ownedFilePath });
    removePendingDurably(key, item);
  };
  const processPendingHead = async (key, item) => {
    processingTokens.add(item.token);
    try { return await processPendingHeadNow(key, item); }
    finally {
      processingTokens.delete(item.token);
    }
  };
  const ensureFileDrain = key => {
    if (fileDrains.has(key)) return fileDrains.get(key);
    const drain = (async () => {
      while (true) {
        const item = sortPending(key).find(candidate => candidate.stage !== 'failed');
        if (!item) return;
        const boundedChecked = item.type === 'checked' && ['metadata', 'writing'].includes(item.stage);
        const hasCompletion = itemCompletions.has(item.token);
        if (item.stage === 'fingerprint' && terminalStates.get(item.token)?.error?.code === 'MEDIA_RATING_CHECKED_DEADLINE_EXCEEDED') terminalStates.delete(item.token);
        if (boundedChecked && item.stage === 'writing'
          && ((Number(item.failureCount) || 0) >= 5 || now() >= Number(item.deadlineAt) || deadlineSignals.has(item.token))) {
          try {
            if (await reconcileCompletedCheckedWrite(key, item)) {
              terminalStates.delete(item.token);
              continue;
            }
          } catch (error) {
            writeLog('warn', 'Unable to reconcile expired checked rating write', { filePath: item.filePath, error: error.message || String(error) });
            if (error?.ratingReconcilePersistFailed === true) {
              await backgroundRetryDelay();
              continue;
            }
          }
        }
        if (!terminalStates.has(item.token) && boundedChecked
          && ((Number(item.failureCount) || 0) >= 5 || now() >= Number(item.deadlineAt) || deadlineSignals.has(item.token))) {
          const error = new Error(item.lastError || 'media_rating_checked_deadline_exceeded');
          error.code = 'MEDIA_RATING_CHECKED_DEADLINE_EXCEEDED';
          terminalStates.set(item.token, { mode: 'failed', error });
        }
        const terminal = terminalStates.get(item.token);
        if (terminal) {
          try {
            if (terminal.mode === 'remove') removePendingDurably(key, item);
            else markIntentFailedDurably(key, item, terminal.error);
            settleCompletion(item, 'reject', terminal.error);
            terminalStates.delete(item.token);
            continue;
          } catch (persistError) {
            if (boundedChecked && now() >= Number(item.deadlineAt)) {
              isolateUnknownIntent(key, item, persistError);
              terminalStates.delete(item.token);
              continue;
            }
            item.failureCount = (Number(item.failureCount) || 0) + 1;
            writeLog('warn', 'Unable to persist terminal rating state', { filePath: item.filePath, error: persistError.message || String(persistError) });
            await retryDelay(item, item.failureCount, hasCompletion);
            continue;
          }
        }
        try { await processPendingHead(key, item); }
        catch (error) {
          const errorBoundedChecked = item.type === 'checked' && ['metadata', 'writing'].includes(item.stage);
          const errorHasCompletion = itemCompletions.has(item.token);
          if (error?.code === 'MEDIA_RATING_REVISION_CONFLICT') {
            terminalStates.set(item.token, { mode: 'remove', error });
            continue;
          } else if (isPermanentRatingError(error)) {
            terminalStates.set(item.token, { mode: 'failed', error });
            continue;
          } else {
            writeLog('warn', 'Media rating head-of-line stage remains queued for retry', { filePath: item.filePath, stage: item.stage, error: error.message || String(error) });
            item.failureCount = (Number(item.failureCount) || 0) + 1;
            item.lastError = error.message || String(error);
            try { savePendingRatings(); }
            catch (persistError) { writeLog('warn', 'Unable to persist media rating retry state', { filePath: item.filePath, error: persistError.message || String(persistError) }); }
            if (errorBoundedChecked && (item.failureCount >= 5 || now() >= Number(item.deadlineAt))) {
              terminalStates.set(item.token, { mode: 'failed', error });
              continue;
            }
          }
          await retryDelay(item, item.failureCount || 1, errorHasCompletion);
        }
      }
    })().finally(() => {
      if (fileDrains.get(key) === drain) fileDrains.delete(key);
      if ((pendingRatings.get(key) || []).some(item => item.stage !== 'failed')) ensureFileDrain(key);
    });
    fileDrains.set(key, drain);
    return drain;
  };
  const write = async (workspaceRoot, filePath, value) => {
    const rating = normalize(value);
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const resolvedFilePath = path.resolve(filePath);
    const key = pathKey(resolvedFilePath);
    let markAttemptStarted;
    const attemptStarted = new Promise(resolve => { markAttemptStarted = resolve; });
    const item = await enqueueIntent(key, async () => {
      const ownedFilePath = await assertWorkspaceOwnership(resolvedWorkspaceRoot, resolvedFilePath);
      const token = `${Date.now()}-${++writeSequence}`;
      const identity = await captureFileIdentity(ownedFilePath);
      const pending = { workspaceRoot: resolvedWorkspaceRoot, filePath: ownedFilePath, identity, rating, token, type: 'ordinary', sequence: ++operationSequence, updatedAt: now(), stage: 'metadata' };
      const queue = pendingRatings.get(key) || [];
      queue.push(pending);
      pendingRatings.set(key, queue);
      sortPending(key);
      refreshOptimistic(key);
      try { savePendingRatings(); }
      catch (error) { removePendingItem(key, token); throw error; }
      invalidate(ownedFilePath);
      return pending;
    });
    itemAttemptStarts.set(item.token, markAttemptStarted);
    ensureFileDrain(key);
    let attemptWaitTimer;
    await Promise.race([attemptStarted, new Promise(resolve => {
      attemptWaitTimer = setTimeout(resolve, 100);
      attemptWaitTimer.unref?.();
    })]);
    clearTimeout(attemptWaitTimer);
    itemAttemptStarts.delete(item.token);
    return rating;
  };
  const writeChecked = (workspaceRoot, filePath, value, expectedRevision) => {
    const resolvedFilePath = path.resolve(filePath); const key = pathKey(resolvedFilePath); const rating = normalize(value);
    return enqueueIntent(key, async () => {
      const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
      const ownedFilePath = await assertWorkspaceOwnership(resolvedWorkspaceRoot, resolvedFilePath);
      if (!Number.isFinite(Number(expectedRevision))) throw revisionConflict();
      const identity = await captureFileIdentity(ownedFilePath);
      const item = { workspaceRoot: resolvedWorkspaceRoot, filePath: ownedFilePath, identity, rating, token: `${Date.now()}-${++writeSequence}`, type: 'checked', expectedRevision: Number(expectedRevision), deadlineAt: now() + checkedRetryDeadlineMs, sequence: ++operationSequence, updatedAt: now(), stage: 'metadata' };
      const queue = pendingRatings.get(key) || [];
      queue.push(item);
      pendingRatings.set(key, queue);
      sortPending(key);
      refreshOptimistic(key);
      try { savePendingRatings(); }
      catch (error) { removePendingItem(key, item.token); throw error; }
      return item;
    }).then(item => new Promise((resolve, reject) => {
      registerCheckedCompletion(key, item, resolve, reject);
      ensureFileDrain(key);
    }));
  };
  const scanProject = async (projectPath, options = {}, collectEntries = true) => {
    const candidates = [];
    const entries = [];
    let count = 0;
    let skippedDirectories = 0;
    const summaryInspections = new Set();
    const excludedDirectoryPaths = new Set();
    if (options.workspaceRoot && options.projectName && versionService?.listProgress) {
      const listed = await versionService.listProgress(options.workspaceRoot, options.projectName, true);
      for (const progress of listed.progressFolders || []) {
        if (!progress.folderPath) continue;
        const category = progress.sourceMetadata?.category;
        const legacyFavoriteExport = progress.sourceMetadata == null && /^图片后期_.+_喜爱$/u.test(path.basename(progress.folderPath));
        if (category !== 'favorite-export' && !legacyFavoriteExport) continue;
        excludedDirectoryPaths.add(pathKey(progress.folderPath));
      }
    }
    const inspectCandidate = async candidate => {
      try {
        const rating = await read(candidate.filePath);
        if (!rating) return;
        count += 1;
        if (!collectEntries) return;
        const stat = await fs.promises.stat(candidate.filePath);
        entries.push({ name: path.basename(candidate.filePath), path: candidate.filePath, relativePath: candidate.virtualPath, kind: imageExtensions.has(candidate.extension) ? 'image' : 'raw', extension: candidate.extension, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs, updatedAt: stat.mtimeMs, rating, ...(candidate.viaExternalLink ? { viaShortcut: true, viaExternalLink: true, readOnly: false } : {}) });
      } catch (error) {
        writeLog('warn', 'Unable to inspect media rating', { filePath: candidate.filePath, error: error.message || String(error) });
      }
    };
    const queueCandidate = async candidate => {
      if (collectEntries) { candidates.push(candidate); return; }
      const inspection = inspectCandidate(candidate).finally(() => summaryInspections.delete(inspection));
      summaryInspections.add(inspection);
      if (summaryInspections.size >= 6) await Promise.race(summaryInspections);
    };
    const directories = [{ path: projectPath, virtualPath: '', viaExternalLink: false, root: true }];
    for (const link of projectVirtualPaths?.listManagedExternalLinks(projectPath) || []) {
      if (link.offline) continue;
      if (link.externalTargetKind === 'file') {
        const extension = path.extname(link.externalTargetRoot).toLowerCase();
        if (imageExtensions.has(extension) || rawExtensions.has(extension)) await queueCandidate({ filePath: link.externalTargetRoot, extension, virtualPath: link.shortcutVirtualPath, viaExternalLink: true });
      } else directories.push({ path: link.externalTargetRoot, virtualPath: link.shortcutVirtualPath, viaExternalLink: true, root: false });
    }
    const visited = new Set();
    while (directories.length) {
      const directory = directories.pop();
      let realDirectory;
      let directoryEntries;
      try {
        realDirectory = await fs.promises.realpath(directory.path);
        directoryEntries = await fs.promises.readdir(realDirectory, { withFileTypes: true });
      } catch (error) {
        if (directory.root) throw error;
        skippedDirectories += 1;
        writeLog('warn', 'Unable to scan nested media rating directory', { directoryPath: directory.path, error: error.message || String(error) });
        continue;
      }
      const directoryKey = process.platform === 'win32' ? realDirectory.toLocaleLowerCase() : realDirectory;
      if (visited.has(directoryKey)) continue;
      visited.add(directoryKey);
      for (const entry of directoryEntries) {
        const filePath = path.join(realDirectory, entry.name);
        const virtualPath = [directory.virtualPath, entry.name].filter(Boolean).join('/');
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.photoflow-') && !excludedDirectoryPaths.has(pathKey(filePath))) directories.push({ path: filePath, virtualPath, viaExternalLink: directory.viaExternalLink, root: false });
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (imageExtensions.has(extension) || rawExtensions.has(extension)) await queueCandidate({ filePath, extension, virtualPath, viaExternalLink: directory.viaExternalLink });
      }
    }
    await Promise.all(summaryInspections);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(6, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        await inspectCandidate(candidates[cursor++]);
      }
    });
    await Promise.all(workers);
    if (collectEntries) entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    return { entries, count, skippedDirectories };
  };
  const listProject = async (projectPath, options = {}) => {
    const result = await scanProject(projectPath, options, true);
    return result.entries;
  };
  const summarizeProject = async (projectPath, options = {}) => scanProject(projectPath, options, false);
  for (const key of pendingRatings.keys()) ensureFileDrain(key);
  return { invalidate, listProject, summarizeProject, normalize, read, write, writeChecked };
};

module.exports = { createMediaRatingService };
