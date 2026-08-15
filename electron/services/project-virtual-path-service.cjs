const fs = require('fs');
const path = require('path');

const MANAGED_EXTERNAL_FOLDER_PREFIX = 'PhotoFlow 外链文件夹：';
const MANAGED_EXTERNAL_FILE_PREFIX = 'PhotoFlow 外链文件：';

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

const readManagedExternalLink = (shell, shortcutPath) => {
  if (path.extname(shortcutPath).toLowerCase() !== '.lnk') return null;
  let details;
  try { details = shell.readShortcutLink(shortcutPath); }
  catch { return null; }
  const description = String(details?.description || '');
  const targetKindHint = description.startsWith(MANAGED_EXTERNAL_FOLDER_PREFIX) ? 'folder'
    : description.startsWith(MANAGED_EXTERNAL_FILE_PREFIX) ? 'file' : '';
  if (!targetKindHint) return null;
  const target = String(details?.target || '').trim();
  if (!target || !path.isAbsolute(target)) throw new Error('外链目标路径无效');
  return { ...details, target: path.resolve(target), targetKindHint };
};

const createProjectVirtualPathService = ({ shell }) => {
  if (!shell?.readShortcutLink) throw new Error('外链路径服务缺少快捷方式读取能力');

  const resolve = (projectRoot, virtualPath = '', options = {}) => {
    const root = path.resolve(projectRoot);
    const { normalized, segments } = normalizeVirtualPath(virtualPath);
    const externalLinkIndex = segments.findIndex(segment => path.extname(segment).toLowerCase() === '.lnk');
    const mustExist = options.mustExist !== false;
    const allowMissingLeaf = options.allowMissingLeaf === true;
    const externalRootMode = options.externalRootMode === 'link' ? 'link' : 'target';

    if (externalLinkIndex < 0) {
      const physicalPath = path.resolve(root, ...segments);
      if (!isInsideOrEqual(root, physicalPath)) throw new Error('项目路径超出项目目录');
      if (mustExist && !fs.existsSync(physicalPath)) throw Object.assign(new Error('文件或文件夹不存在'), { code: 'ENOENT' });
      if (allowMissingLeaf && !fs.existsSync(physicalPath)) {
        const parent = path.dirname(physicalPath);
        if (!fs.existsSync(parent)) throw Object.assign(new Error('目标文件夹不存在'), { code: 'ENOENT' });
        const realRoot = fs.realpathSync(root);
        const realParent = fs.realpathSync(parent);
        if (!isInsideOrEqual(realRoot, realParent)) throw new Error('项目路径超出项目目录');
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
    const shortcutPath = path.resolve(root, ...shortcutSegments);
    if (!isInsideOrEqual(root, shortcutPath)) throw new Error('外链路径超出项目目录');
    if (!fs.existsSync(shortcutPath)) throw Object.assign(new Error('外链不存在'), { code: 'ENOENT' });
    const link = readManagedExternalLink(shell, shortcutPath);
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
        const link = readManagedExternalLink(shell, entryPath);
        if (!link) continue;
        let externalTargetKind = link.targetKindHint;
        if (fs.existsSync(link.target)) externalTargetKind = fs.statSync(link.target).isDirectory() ? 'folder' : 'file';
        links.push({
          shortcutPath: entryPath,
          shortcutVirtualPath: virtualPath,
          externalTargetRoot: link.target,
          externalDisplayName: path.basename(entry.name, path.extname(entry.name)),
          externalTargetKind,
          viaExternalLink: true,
          offline: !fs.existsSync(link.target),
        });
      }
    }
    return links;
  };

  return { resolve, toVirtualPath, listManagedExternalLinks, readManagedExternalLink: shortcutPath => readManagedExternalLink(shell, shortcutPath) };
};

module.exports = {
  MANAGED_EXTERNAL_FOLDER_PREFIX,
  MANAGED_EXTERNAL_FILE_PREFIX,
  createProjectVirtualPathService,
  isInsideOrEqual,
  normalizeVirtualPath,
  readManagedExternalLink,
};
