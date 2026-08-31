const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { physicalPathKey, identityFromStat, identitiesMatch } = require('./file-identity-service.cjs');

const MANAGED_EXTERNAL_FOLDER_PREFIX = 'PhotoFlow 外链文件夹：';
const MANAGED_EXTERNAL_FILE_PREFIX = 'PhotoFlow 外链文件：';
const MANAGED_EXTERNAL_ID_MARKER = ' | PhotoFlow-ID:';
const REGISTRY_PROTOCOL = 'photoflow-external-links-registry-v1';
const HARDLINK_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'UNKNOWN']);

const normalizeVirtualPath = value => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized ? normalized.split('/') : [];
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw new Error('项目路径无效');
  }
  return { normalized, segments };
};

const isInsideOrEqual = (parent, candidate) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const createProjectVirtualPathService = ({ shell, registryPath = '', crypto = require('crypto'), platform = process.platform, runtimeDirectory = __dirname, resourcesPath = process.resourcesPath, isPackaged = null, nativeRegistryPublisher = null, registryFaultInjector = () => undefined, executableExists = fs.existsSync, spawnSyncImpl = spawnSync }) => {
  if (!shell?.readShortcutLink) throw new Error('外链路径服务缺少快捷方式读取能力');
  const registryFile = registryPath ? path.resolve(registryPath) : '';
  let registryCache = null;
  let registryIdentity = null;
  const digestSync = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const writeSyncedFileSync = (filePath, contents) => {
    const handle = fs.openSync(filePath, 'wx', 0o600);
    try { fs.writeFileSync(handle, contents, 'utf8'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  };
  const nativeMoveNoReplaceSync = (source, destination) => {
    if (nativeRegistryPublisher) return nativeRegistryPublisher(source, destination);
    const binaryName = platform === 'win32' ? 'file-publication-service.exe' : 'file-publication-service';
    const normalizedRuntime = path.resolve(runtimeDirectory).replace(/\\/g, '/').toLowerCase();
    const packagedRuntime = /(?:^|\/)app\.asar(?:\.unpacked)?(?:\/|$)/.test(normalizedRuntime);
    const packagedMode = typeof isPackaged === 'boolean' ? isPackaged : packagedRuntime;
    const developmentExecutable = path.resolve(runtimeDirectory, '..', 'bin', binaryName);
    const resourceCandidates = resourcesPath ? [path.join(resourcesPath, binaryName), path.join(resourcesPath, 'app.asar.unpacked', 'electron', 'bin', binaryName)] : [];
    const candidates = packagedMode ? resourceCandidates : [developmentExecutable, ...resourceCandidates];
    const executable = candidates.find(candidate => candidate && executableExists(candidate));
    if (!executable) throw Object.assign(new Error('registry native publication service unavailable'), { code: 'FILE_PUBLICATION_SERVICE_MISSING' });
    const result = spawnSyncImpl(executable, ['move-no-replace', '--source', path.resolve(source), '--target', path.resolve(destination)], { encoding: 'utf8', windowsHide: true });
    const line = String(result.stdout || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).pop();
    let payload; try { payload = line ? JSON.parse(line) : null; } catch { payload = null; }
    if (!payload?.success) {
      let reconciled = false;
      if (payload?.published === true && payload?.outcomeUnknown !== true && payload?.identity && !fs.existsSync(source) && fs.existsSync(destination)) {
        const inspectedResult = spawnSyncImpl(executable, ['inspect-path', '--path', path.resolve(destination)], { encoding: 'utf8', windowsHide: true });
        const inspectedLine = String(inspectedResult.stdout || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).pop();
        let inspected; try { inspected = inspectedLine ? JSON.parse(inspectedLine) : null; } catch { inspected = null; }
        reconciled = inspected?.success === true && inspected.identity === payload.identity;
      }
      if (reconciled) return { ...payload, success: true, strategy: 'native-write-through-reconciled' };
      throw Object.assign(new Error(payload?.error || String(result.stderr || 'registry native publication failed')), { code: payload?.code || 'FILE_PUBLICATION_FAILED', published: payload?.published, outcomeUnknown: payload?.outcomeUnknown, identity: payload?.identity });
    }
    return payload;
  };
  const publishFileNoClobberSync = (source, destination, options = {}) => {
    if (options.registryCanonical) {
      const native = nativeMoveNoReplaceSync(source, destination);
      return { strategy: native.strategy || 'native-write-through-no-clobber', identity: identityFromStat(destination, fs.statSync(destination, { bigint: true })), nativeIdentity: native.identity, cleanupWarning: '' };
    }
    let strategy = 'hardlink-no-clobber';
    try { fs.linkSync(source, destination); }
    catch (error) {
      if (!HARDLINK_FALLBACK_CODES.has(error?.code)) throw error;
      strategy = 'copyfile-excl-fallback';
      try {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        const sourceMode = fs.statSync(source).mode;
        fs.chmodSync(destination, sourceMode | 0o200);
        const handle = fs.openSync(destination, 'r+');
        try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
        if (fs.statSync(source).size !== fs.statSync(destination).size || digestSync(source) !== digestSync(destination)) throw Object.assign(new Error('no-clobber fallback verification failed'), { code: 'PUBLISH_VERIFY_FAILED' });
        try { fs.chmodSync(destination, sourceMode); } catch { /* identity remains verified */ }
      } catch (copyError) {
        if (fs.existsSync(destination)) {
          const recovery = `${destination}.recovery-${crypto.randomUUID()}`;
          try { fs.renameSync(destination, recovery); copyError.recoveryPath = recovery; } catch { /* preserve ambiguous destination */ }
        }
        throw copyError;
      }
    }
    const identity = identityFromStat(destination, fs.statSync(destination, { bigint: true }));
    let cleanupWarning = '';
    try { fs.unlinkSync(source); } catch (error) { cleanupWarning = error?.message || String(error); }
    return { strategy, identity, cleanupWarning };
  };
  const parseRegistryCandidate = filePath => {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (value?.version !== 1 || !value.links || typeof value.links !== 'object' || Array.isArray(value.links)) return null;
      const meta = value._registryWrite;
      if (meta !== undefined && (meta?.protocol !== REGISTRY_PROTOCOL || !Number.isSafeInteger(meta.generation) || meta.generation < 1 || typeof meta.operationId !== 'string')) return null;
      return { filePath, value, generation: Number(meta?.generation || 0) };
    } catch { return null; }
  };
  const selectRegistryRecovery = () => {
    const directory = path.dirname(registryFile); const basename = path.basename(registryFile);
    if (!fs.existsSync(directory)) return null;
    const names = fs.readdirSync(directory, { withFileTypes: true });
    const artifactPaths = names.filter(entry => entry.isFile() && (entry.name.startsWith(`${basename}.tmp-`) || entry.name.startsWith(`${basename}.backup-`))).map(entry => path.join(directory, entry.name));
    if (!artifactPaths.length) return null;
    const candidates = artifactPaths.map(parseRegistryCandidate);
    if (candidates.some(candidate => !candidate)) throw Object.assign(new Error('外链注册表恢复候选损坏'), { code: 'EXTERNAL_LINK_REGISTRY_RECOVERY_AMBIGUOUS' });
    const temporary = candidates.filter(candidate => path.basename(candidate.filePath).startsWith(`${basename}.tmp-`));
    const backups = candidates.filter(candidate => path.basename(candidate.filePath).startsWith(`${basename}.backup-`));
    let winner = null;
    if (temporary.length === 1 && backups.length <= 1 && (backups.length ? temporary[0].generation === backups[0].generation + 1 : temporary[0].generation === 1)) winner = temporary[0];
    else if (!temporary.length && backups.length === 1) winner = backups[0];
    if (!winner) throw Object.assign(new Error('外链注册表恢复候选不唯一或代际冲突'), { code: 'EXTERNAL_LINK_REGISTRY_RECOVERY_AMBIGUOUS' });
    return { candidates, winner };
  };
  const recoverMissingRegistry = () => {
    if (!registryFile || fs.existsSync(registryFile)) return;
    const recovery = selectRegistryRecovery();
    if (!recovery) return;
    const { candidates, winner } = recovery;
    publishFileNoClobberSync(winner.filePath, registryFile, { registryCanonical: true });
    for (const candidate of candidates) if (candidate !== winner) try { fs.rmSync(candidate.filePath, { force: true }); } catch { /* canonical is already authoritative */ }
  };
  const recoverInvalidRegistry = () => {
    const recovery = selectRegistryRecovery();
    if (!recovery) throw Object.assign(new Error('外链注册表已损坏且没有恢复候选'), { code: 'EXTERNAL_LINK_REGISTRY_CORRUPT' });
    const corruptRecovery = `${registryFile}.recovery-corrupt-${crypto.randomUUID()}`;
    publishFileNoClobberSync(registryFile, corruptRecovery, { registryCanonical: true });
    try { publishFileNoClobberSync(recovery.winner.filePath, registryFile, { registryCanonical: true }); }
    catch (error) { if (!fs.existsSync(registryFile) && fs.existsSync(corruptRecovery)) try { publishFileNoClobberSync(corruptRecovery, registryFile, { registryCanonical: true }); } catch { error.recoveryPath = corruptRecovery; } throw error; }
    for (const candidate of recovery.candidates) if (candidate !== recovery.winner) try { fs.rmSync(candidate.filePath, { force: true }); } catch { /* recovered canonical is authoritative */ }
    try { fs.rmSync(corruptRecovery, { force: true }); } catch { /* non-authoritative damaged recovery */ }
  };
  const rollbackCommittedShortcut = item => {
    let current;
    try { current = identityFromStat(item.shortcutPath, fs.statSync(item.shortcutPath, { bigint: true })); }
    catch { return { success: false }; }
    if (!identitiesMatch(current, item.publishedIdentity, { destructive: true }) || digestSync(item.shortcutPath) !== item.publishedIdentity.sha256) return { success: false };
    const quarantine = `${item.shortcutPath}.recovery-${crypto.randomUUID()}`;
    let publication;
    try { publication = publishFileNoClobberSync(item.shortcutPath, quarantine); }
    catch (error) { return { success: false, recoveryPath: error?.recoveryPath }; }
    const valid = fs.statSync(quarantine).size.toString() === item.publishedIdentity.size && digestSync(quarantine) === item.publishedIdentity.sha256;
    if (!valid) {
      if (!fs.existsSync(item.shortcutPath)) try { publishFileNoClobberSync(quarantine, item.shortcutPath); return { success: false }; } catch { /* preserve quarantine */ }
      return { success: false, recoveryPath: quarantine };
    }
    try { fs.unlinkSync(quarantine); return { success: true, strategy: publication.strategy }; }
    catch { return { success: false, recoveryPath: quarantine }; }
  };
  const loadRegistry = () => {
    if (registryFile && !fs.existsSync(registryFile)) recoverMissingRegistry();
    const currentStat = registryFile ? fs.statSync(registryFile, { bigint: true, throwIfNoEntry: false }) : null;
    const currentIdentity = currentStat ? identityFromStat(registryFile, currentStat) : null;
    if (registryCache && Boolean(currentIdentity) === Boolean(registryIdentity) && (!currentIdentity || identitiesMatch(currentIdentity, registryIdentity))) return registryCache;
    if (!registryFile || !currentStat) {
      registryIdentity = null;
      return (registryCache = { version: 1, links: {} });
    }
    try {
      const candidate = parseRegistryCandidate(registryFile);
      if (!candidate) { recoverInvalidRegistry(); return loadRegistry(); }
      registryCache = candidate.value;
    } catch (cause) {
      throw Object.assign(new Error('外链注册表已损坏，拒绝覆盖'), { code: 'EXTERNAL_LINK_REGISTRY_CORRUPT', cause });
    }
    registryIdentity = identityFromStat(registryFile, currentStat);
    return registryCache;
  };
  const saveRegistry = () => {
    if (!registryFile) return;
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const currentStat = fs.statSync(registryFile, { bigint: true, throwIfNoEntry: false });
    const currentIdentity = currentStat ? identityFromStat(registryFile, currentStat) : null;
    if (Boolean(currentIdentity) !== Boolean(registryIdentity) || currentIdentity && !identitiesMatch(currentIdentity, registryIdentity)) {
      throw Object.assign(new Error('外链注册表已被其他操作修改'), { code: 'EXTERNAL_LINK_REGISTRY_CHANGED' });
    }
    const operationId = crypto.randomUUID();
    const generation = Number(loadRegistry()._registryWrite?.generation || 0) + 1;
    const temporary = `${registryFile}.tmp-${process.pid}-${operationId}`;
    const backup = `${registryFile}.backup-${process.pid}-${operationId}`;
    const snapshot = { ...loadRegistry(), _registryWrite: { protocol: REGISTRY_PROTOCOL, operationId, generation } };
    writeSyncedFileSync(temporary, JSON.stringify(snapshot));
    registryFaultInjector('after-temp-sync', { registryFile, temporary, backup, snapshot });
    let published = false; let simulatedCrash = false;
    try {
      if (fs.existsSync(registryFile)) publishFileNoClobberSync(registryFile, backup, { registryCanonical: true });
      registryFaultInjector('after-backup-before-canonical', { registryFile, temporary, backup, snapshot });
      publishFileNoClobberSync(temporary, registryFile, { registryCanonical: true });
      published = true;
      registryFaultInjector('after-canonical', { registryFile, temporary, backup, snapshot });
      const publishedStat = fs.statSync(registryFile, { bigint: true });
      registryIdentity = identityFromStat(registryFile, publishedStat);
      registryCache = snapshot;
      try { fs.rmSync(backup, { force: true }); } catch { /* cleanup cannot invalidate a committed registry */ }
    } catch (error) {
      simulatedCrash = error?.simulateCrash === true;
      if (!simulatedCrash && !published && !fs.existsSync(registryFile) && fs.existsSync(backup)) try { publishFileNoClobberSync(backup, registryFile, { registryCanonical: true }); } catch { error.recoveryPath = backup; }
      throw error;
    } finally { if (!simulatedCrash && (published || fs.existsSync(registryFile))) try { fs.rmSync(temporary, { force: true }); } catch { /* recovery scanner validates leftovers */ } }
  };
  const targetKey = physicalPathKey;

  const readManagedExternalLink = shortcutPath => {
  if (path.extname(shortcutPath).toLowerCase() !== '.lnk') return null;
  let details;
  try { details = shell.readShortcutLink(shortcutPath); }
  catch { return null; }
  const description = String(details?.description || '');
  const targetKindHint = description.startsWith(MANAGED_EXTERNAL_FOLDER_PREFIX) ? 'folder'
    : description.startsWith(MANAGED_EXTERNAL_FILE_PREFIX) ? 'file' : '';
  if (!targetKindHint) return null;
  const markerIndex = description.lastIndexOf(MANAGED_EXTERNAL_ID_MARKER);
  const linkId = markerIndex >= 0 ? description.slice(markerIndex + MANAGED_EXTERNAL_ID_MARKER.length).trim() : '';
  const registered = linkId && loadRegistry().links[linkId];
  if (!registered || registered.kind !== targetKindHint) return null;
  const target = String(details?.target || '').trim();
  if (!target || !path.isAbsolute(target)) throw new Error('外链目标路径无效');
  if (targetKey(registered.target) !== targetKey(target)) return null;
  return { ...details, target: path.resolve(target), targetKindHint, linkId };
  };

  const createManagedExternalLink = (shortcutPath, { target, kind, displayName }) => {
    return createManagedExternalLinksBatch([{ shortcutPath, target, kind, displayName }])[0];
  };

  const createManagedExternalLinksBatch = requests => {
    if (!Array.isArray(requests) || !requests.length) return [];
    const registry = loadRegistry();
    const planned = [];
    const destinations = new Set();
    for (const request of requests) {
      const targetKind = request?.kind === 'folder' ? 'folder' : request?.kind === 'file' ? 'file' : '';
      const rawTarget = String(request?.target || '').trim();
      const destination = path.resolve(String(request?.shortcutPath || ''));
      if (!targetKind || !rawTarget || !path.isAbsolute(rawTarget)) throw new Error('外链目标无效');
      if (path.extname(destination).toLowerCase() !== '.lnk') throw new Error('外链快捷方式路径无效');
      const destinationKey = targetKey(destination);
      if (destinations.has(destinationKey) || fs.existsSync(destination)) throw new Error(`外链目标名称已被占用：${path.basename(destination)}`);
      destinations.add(destinationKey);
      const resolvedTarget = path.resolve(rawTarget);
      const linkId = crypto.randomUUID();
      const prefix = targetKind === 'folder' ? MANAGED_EXTERNAL_FOLDER_PREFIX : MANAGED_EXTERNAL_FILE_PREFIX;
      const description = `${prefix}${String(request?.displayName || path.basename(resolvedTarget))}${MANAGED_EXTERNAL_ID_MARKER}${linkId}`;
      const temporary = path.join(path.dirname(destination), `.photoflow-link-${crypto.randomUUID()}.lnk`);
      planned.push({ shortcutPath: destination, temporary, target: resolvedTarget, kind: targetKind, linkId, description });
    }
    const committed = [];
    try {
      for (const item of planned) {
        fs.mkdirSync(path.dirname(item.shortcutPath), { recursive: true });
        if (!shell.writeShortcutLink(item.temporary, {
          target: item.target,
          cwd: item.kind === 'folder' ? item.target : path.dirname(item.target),
          description: item.description,
        })) throw new Error(`无法创建外链：${path.basename(item.target)}`);
      }
      for (const item of planned) {
        const publication = publishFileNoClobberSync(item.temporary, item.shortcutPath);
        const publishedIdentity = { ...publication.identity, sha256: digestSync(item.shortcutPath) };
        committed.push({ ...item, publishedIdentity });
        registry.links[item.linkId] = { target: item.target, kind: item.kind, createdAt: Date.now() };
      }
      saveRegistry();
      return planned.map(({ temporary: _temporary, ...item }) => item);
    } catch (error) {
      for (const item of planned) {
        fs.rmSync(item.temporary, { force: true });
        delete registry.links[item.linkId];
      }
      for (const item of committed.reverse()) {
        rollbackCommittedShortcut(item);
      }
      throw error;
    }
  };

  const revokeManagedExternalLinkIds = linkIds => {
    const registry = loadRegistry();
    const uniqueIds = [...new Set((Array.isArray(linkIds) ? linkIds : []).map(value => String(value || '').trim()).filter(Boolean))];
    const removed = [];
    for (const linkId of uniqueIds) {
      if (!registry.links[linkId]) continue;
      removed.push([linkId, registry.links[linkId]]);
      delete registry.links[linkId];
    }
    if (!removed.length) return 0;
    try { saveRegistry(); }
    catch (error) {
      for (const [linkId, entry] of removed) registry.links[linkId] = entry;
      throw error;
    }
    return removed.length;
  };

  const resolve = (projectRoot, virtualPath = '', options = {}) => {
    const root = path.resolve(projectRoot);
    const { normalized, segments } = normalizeVirtualPath(virtualPath);
    const externalLinkIndex = segments.findIndex(segment => path.extname(segment).toLowerCase() === '.lnk');
    const mustExist = options.mustExist !== false;
    const allowMissingLeaf = options.allowMissingLeaf === true;
    const externalRootMode = options.externalRootMode === 'link' ? 'link' : 'target';

    if (externalLinkIndex < 0) {
      const requestedPath = path.resolve(root, ...segments);
      if (!isInsideOrEqual(root, requestedPath)) throw new Error('项目路径超出项目目录');
      if (mustExist && !fs.existsSync(requestedPath)) throw Object.assign(new Error('文件或文件夹不存在'), { code: 'ENOENT' });
      const realRoot = fs.realpathSync(root);
      let physicalPath = requestedPath;
      if (fs.existsSync(requestedPath)) {
        physicalPath = fs.realpathSync(requestedPath);
        if (!isInsideOrEqual(realRoot, physicalPath)) throw new Error('项目内容通过重解析点跳出了项目目录');
      } else if (allowMissingLeaf) {
        const parent = path.dirname(requestedPath);
        if (!fs.existsSync(parent)) throw Object.assign(new Error('目标文件夹不存在'), { code: 'ENOENT' });
        const realParent = fs.realpathSync(parent);
        if (!isInsideOrEqual(realRoot, realParent)) throw new Error('项目路径超出项目目录');
        physicalPath = path.join(realParent, path.basename(requestedPath));
      }
      return {
        projectRoot: root,
        virtualPath: normalized,
        physicalPath,
        mediaRoot: root,
        viaExternalLink: false,
        isExternalLinkRoot: false,
        writable: true,
        offline: false,
      };
    }

    const shortcutSegments = segments.slice(0, externalLinkIndex + 1);
    const shortcutVirtualPath = shortcutSegments.join('/');
    const requestedShortcutPath = path.resolve(root, ...shortcutSegments);
    if (!isInsideOrEqual(root, requestedShortcutPath)) throw new Error('外链路径超出项目目录');
    if (!fs.existsSync(requestedShortcutPath)) throw Object.assign(new Error('外链不存在'), { code: 'ENOENT' });
    const realRoot = fs.realpathSync(root);
    const shortcutPath = fs.realpathSync(requestedShortcutPath);
    if (!isInsideOrEqual(realRoot, shortcutPath)) throw new Error('外链快捷方式通过重解析点跳出了项目目录');
    if (!fs.statSync(shortcutPath).isFile()) throw new Error('外链快捷方式不是文件');
    const link = readManagedExternalLink(shortcutPath);
    if (!link) throw new Error('所选项目不是 PhotoFlow 外链');
    const isExternalLinkRoot = externalLinkIndex === segments.length - 1;
    if (isExternalLinkRoot && externalRootMode === 'link') {
      return {
        projectRoot: root,
        virtualPath: normalized,
        physicalPath: shortcutPath,
        mediaRoot: root,
        shortcutPath,
        shortcutVirtualPath,
        externalTargetRoot: link.target,
        externalTargetKind: link.targetKindHint,
        linkId: link.linkId,
        externalDisplayName: path.basename(shortcutPath, path.extname(shortcutPath)),
        viaExternalLink: true,
        isExternalLinkRoot: true,
        writable: true,
        offline: !fs.existsSync(link.target),
      };
    }

    if (!fs.existsSync(link.target)) throw Object.assign(new Error('外链目标当前离线或不存在'), { code: 'EXTERNAL_LINK_OFFLINE' });
    const targetStat = fs.statSync(link.target);
    if (!targetStat.isDirectory() && !targetStat.isFile()) throw new Error('外链目标类型不受支持');
    const realTargetRoot = fs.realpathSync(link.target);
    const childSegments = segments.slice(externalLinkIndex + 1);
    if (targetStat.isFile()) {
      if (childSegments.length) throw new Error('外链文件不能包含子路径');
      return {
        projectRoot: root, virtualPath: normalized, physicalPath: realTargetRoot, mediaRoot: path.dirname(realTargetRoot),
        shortcutPath, shortcutVirtualPath, externalTargetRoot: realTargetRoot, externalTargetKind: 'file',
        linkId: link.linkId,
        externalDisplayName: path.basename(shortcutPath, path.extname(shortcutPath)), viaExternalLink: true,
        isExternalLinkRoot: true, writable: true, offline: false,
      };
    }
    const requested = path.resolve(realTargetRoot, ...childSegments);
    if (!isInsideOrEqual(realTargetRoot, requested)) throw new Error('外链路径超出目标文件夹');

    let physicalPath = requested;
    if (fs.existsSync(requested)) {
      physicalPath = fs.realpathSync(requested);
      if (!isInsideOrEqual(realTargetRoot, physicalPath)) throw new Error('外链内容通过重解析点跳出了目标文件夹');
    } else if (mustExist && !allowMissingLeaf) {
      throw Object.assign(new Error('外链中的文件或文件夹不存在'), { code: 'ENOENT' });
    } else if (allowMissingLeaf) {
      const parent = path.dirname(requested);
      if (!fs.existsSync(parent)) throw Object.assign(new Error('外链目标文件夹不存在'), { code: 'ENOENT' });
      const realParent = fs.realpathSync(parent);
      if (!isInsideOrEqual(realTargetRoot, realParent)) throw new Error('外链目标路径超出目标文件夹');
      physicalPath = path.join(realParent, path.basename(requested));
    }

    return {
      projectRoot: root,
      virtualPath: normalized,
      physicalPath,
      mediaRoot: realTargetRoot,
      shortcutPath,
      shortcutVirtualPath,
      externalTargetRoot: realTargetRoot,
      externalTargetKind: 'folder',
      linkId: link.linkId,
      externalDisplayName: path.basename(shortcutPath, path.extname(shortcutPath)),
      viaExternalLink: true,
      isExternalLinkRoot,
      writable: true,
      offline: false,
    };
  };

  const toVirtualPath = (projectRoot, physicalPath, hint) => {
    const root = path.resolve(projectRoot);
    const physical = path.resolve(physicalPath);
    if (hint?.viaExternalLink && hint.externalTargetRoot && hint.shortcutVirtualPath) {
      const relative = path.relative(path.resolve(hint.externalTargetRoot), physical);
      if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) throw new Error('物理路径不属于外链');
      return [hint.shortcutVirtualPath, relative.replace(/\\/g, '/')].filter(Boolean).join('/');
    }
    if (!isInsideOrEqual(root, physical)) throw new Error('物理路径不属于项目');
    return path.relative(root, physical).replace(/\\/g, '/');
  };

  const listManagedExternalLinks = (projectRoot, options = {}) => {
    const root = path.resolve(projectRoot);
    if (!fs.existsSync(root)) return [];
    const numericLimit = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const maxDepth = Math.max(0, Math.min(128, numericLimit(options.maxDepth, 32)));
    const maxDirectories = Math.max(1, Math.min(100000, numericLimit(options.maxDirectories, 10000)));
    const maxEntries = Math.max(1, Math.min(500000, numericLimit(options.maxEntries, 50000)));
    const cancelled = typeof options.cancel === 'function' ? options.cancel : () => false;
    const links = [];
    const pending = [{ directory: root, virtualDirectory: '', depth: 0 }];
    const visited = new Set();
    let directoriesScanned = 0; let entriesScanned = 0; let skipped = 0; let truncated = false; let wasCancelled = false;
    while (pending.length && !truncated) {
      if (cancelled()) { truncated = true; wasCancelled = true; break; }
      const current = pending.pop();
      let realDirectory; let directoryStat;
      try { realDirectory = fs.realpathSync.native(current.directory); directoryStat = fs.statSync(realDirectory, { bigint: true }); }
      catch { skipped += 1; continue; }
      const visitKey = directoryStat.dev !== 0n && directoryStat.ino !== 0n ? `${directoryStat.dev}:${directoryStat.ino}` : physicalPathKey(realDirectory);
      if (visited.has(visitKey)) { skipped += 1; continue; }
      visited.add(visitKey);
      directoriesScanned += 1;
      if (directoriesScanned > maxDirectories) { truncated = true; break; }
      let entries = [];
      try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (cancelled()) { truncated = true; wasCancelled = true; break; }
        entriesScanned += 1;
        if (entriesScanned > maxEntries) { truncated = true; break; }
        if (entry.isSymbolicLink()) { skipped += 1; continue; }
        const entryPath = path.join(current.directory, entry.name);
        const virtualPath = [current.virtualDirectory, entry.name].filter(Boolean).join('/');
        if (entry.isDirectory()) {
          if (current.depth >= maxDepth) { skipped += 1; truncated = true; continue; }
          pending.push({ directory: entryPath, virtualDirectory: virtualPath, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.lnk') continue;
        const link = readManagedExternalLink(entryPath);
        if (!link) continue;
        let externalTargetKind = link.targetKindHint;
        if (fs.existsSync(link.target)) externalTargetKind = fs.statSync(link.target).isDirectory() ? 'folder' : 'file';
        links.push({
          shortcutPath: entryPath,
          shortcutVirtualPath: virtualPath,
          externalTargetRoot: link.target,
          externalDisplayName: path.basename(entry.name, path.extname(entry.name)),
          externalTargetKind,
          linkId: link.linkId,
          viaExternalLink: true,
          offline: !fs.existsSync(link.target),
        });
      }
    }
    Object.defineProperties(links, {
      truncated: { value: truncated, enumerable: false },
      cancelled: { value: wasCancelled, enumerable: false },
      skipped: { value: skipped, enumerable: false },
      directoriesScanned: { value: directoriesScanned, enumerable: false },
      entriesScanned: { value: entriesScanned, enumerable: false },
    });
    return links;
  };

  return {
    resolve, toVirtualPath, listManagedExternalLinks, readManagedExternalLink,
    createManagedExternalLink, createManagedExternalLinksBatch, revokeManagedExternalLinkIds,
  };
};

module.exports = {
  MANAGED_EXTERNAL_ID_MARKER,
  MANAGED_EXTERNAL_FOLDER_PREFIX,
  MANAGED_EXTERNAL_FILE_PREFIX,
  createProjectVirtualPathService,
  isInsideOrEqual,
  normalizeVirtualPath,
};
