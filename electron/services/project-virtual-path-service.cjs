const fs = require('fs');
const path = require('path');

const MANAGED_EXTERNAL_FOLDER_PREFIX = 'PhotoFlow 外链文件夹：';
const MANAGED_EXTERNAL_FILE_PREFIX = 'PhotoFlow 外链文件：';
const MANAGED_EXTERNAL_ID_MARKER = ' | PhotoFlow-ID:';

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

const createProjectVirtualPathService = ({ shell, registryPath = '', crypto = require('crypto') }) => {
  if (!shell?.readShortcutLink) throw new Error('外链路径服务缺少快捷方式读取能力');
  const registryFile = registryPath ? path.resolve(registryPath) : '';
  let registryCache = null;
  let registryMtimeMs = 0;
  const loadRegistry = () => {
    const currentMtimeMs = registryFile ? fs.statSync(registryFile, { throwIfNoEntry: false })?.mtimeMs || 0 : 0;
    if (registryCache && currentMtimeMs === registryMtimeMs) return registryCache;
    if (!registryFile) return (registryCache = { version: 1, links: {} });
    try {
      const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      registryCache = parsed?.version === 1 && parsed.links && typeof parsed.links === 'object' ? parsed : { version: 1, links: {} };
    } catch { registryCache = { version: 1, links: {} }; }
    registryMtimeMs = currentMtimeMs;
    return registryCache;
  };
  const saveRegistry = () => {
    if (!registryFile) return;
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const temporary = `${registryFile}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const backup = `${registryFile}.backup-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(temporary, JSON.stringify(loadRegistry()), { encoding: 'utf8', flag: 'wx' });
    try {
      if (fs.existsSync(registryFile)) fs.renameSync(registryFile, backup);
      fs.renameSync(temporary, registryFile);
      registryMtimeMs = fs.statSync(registryFile).mtimeMs;
      fs.rmSync(backup, { force: true });
    } catch (error) {
      if (!fs.existsSync(registryFile) && fs.existsSync(backup)) fs.renameSync(backup, registryFile);
      throw error;
    } finally { fs.rmSync(temporary, { force: true }); fs.rmSync(backup, { force: true }); }
  };
  const targetKey = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);

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
        fs.renameSync(item.temporary, item.shortcutPath);
        committed.push(item);
        registry.links[item.linkId] = { target: item.target, kind: item.kind, createdAt: Date.now() };
      }
      saveRegistry();
      return planned.map(({ temporary: _temporary, ...item }) => item);
    } catch (error) {
      for (const item of planned) {
        fs.rmSync(item.temporary, { force: true });
        fs.rmSync(item.shortcutPath, { force: true });
        delete registry.links[item.linkId];
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

  const listManagedExternalLinks = projectRoot => {
    const root = path.resolve(projectRoot);
    if (!fs.existsSync(root)) return [];
    const links = [];
    const pending = [{ directory: root, virtualDirectory: '' }];
    while (pending.length) {
      const current = pending.pop();
      let entries = [];
      try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryPath = path.join(current.directory, entry.name);
        const virtualPath = [current.virtualDirectory, entry.name].filter(Boolean).join('/');
        if (entry.isDirectory()) {
          pending.push({ directory: entryPath, virtualDirectory: virtualPath });
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
