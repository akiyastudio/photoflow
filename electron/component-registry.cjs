const fs = require('fs');
const path = require('path');
const { parseMediaPlaybackBackendContributions } = require('./contracts/media-playback-backend-contract.cjs');
const zlib = require('zlib');
const { PLUGIN_DEFINITIONS } = require('./plugins/plugin-catalog.cjs');
const { COMPONENT_HOST_CONTRACT_VERSION, parseComponentHostManifest } = require('./component-host-contract.cjs');
const { listIntegrityFiles, readPinnedComponentIntegrity, validateComponentIntegrity, validateComponentIntegrityAsync } = require('./component-integrity.cjs');
const { developmentComponentMetadataToken, discoverDevelopmentComponents, safeFile } = require('./component-development.cjs');
const { legacyRuntimeCapabilities } = require('./compatibility/legacy-runtime-capabilities.cjs');

const COMPONENT_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries(PLUGIN_DEFINITIONS).map(([id, definition]) => [id, { ...definition, capability: definition.capabilities[0] }])));
const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const COMPONENT_STATE_VERSION = 1;
const normalizeRelativeFile = value => String(value || '').replace(/\\/g, '/');
const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const validArchivePath = value => {
  const normalized = normalizeRelativeFile(value);
  const segments = normalized.split('/');
  return Boolean(normalized && normalized.length <= 1024 && !/[\0-\x1f:]/.test(normalized) && !normalized.startsWith('/') && !/^[a-z]:/i.test(normalized)
    && !segments.some(segment => segment === '..' || segment === '.' || segment === '' || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)));
};
const compareVersions = (left, right) => {
  const parse = value => { const [withoutBuild] = String(value || '').split('+', 1); const separator = withoutBuild.indexOf('-'); const core = (separator < 0 ? withoutBuild : withoutBuild.slice(0, separator)).split('.').map(part => /^\d+$/.test(part) ? Number(part) : part); const prerelease = separator < 0 ? null : withoutBuild.slice(separator + 1).split('.').map(part => /^\d+$/.test(part) ? Number(part) : part); return { core, prerelease }; };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const av = a.core[index] ?? 0; const bv = b.core[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av < bv ? -1 : 1;
    return String(av).localeCompare(String(bv), 'en');
  }
  if (a.prerelease === null || b.prerelease === null) return a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) { const av = a.prerelease[index]; const bv = b.prerelease[index]; if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1; if (av === bv) continue; if (typeof av === 'number' && typeof bv === 'number') return av < bv ? -1 : 1; if (typeof av === 'number') return -1; if (typeof bv === 'number') return 1; return String(av).localeCompare(String(bv), 'en'); }
  return 0;
};
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

// The catalog reads component.json directly from ZIP central-directory metadata.
// This keeps discovery deterministic and testable without extracting untrusted files.
const readExact = (fd, length, position) => { const buffer = Buffer.allocUnsafe(length); let offset = 0; while (offset < length) { const count = fs.readSync(fd, buffer, offset, length - offset, position + offset); if (!count) throw new Error('ZIP 文件意外结束'); offset += count; } return buffer; };
const readZipEntries = archivePath => {
  const size = fs.statSync(archivePath).size;
  if (!Number.isSafeInteger(size) || size < 22) throw new Error('ZIP 文件过小或大小无效');
  const fd = fs.openSync(archivePath, 'r');
  try {
  const tailLength = Math.min(size, 65_557); const tailStart = size - tailLength; const tail = readExact(fd, tailLength, tailStart);
  let eocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('ZIP 中央目录缺失或包已损坏');
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0 || tail.readUInt16LE(eocd + 8) !== tail.readUInt16LE(eocd + 10)) throw new Error('不支持多卷 ZIP 组件包');
  const count = tail.readUInt16LE(eocd + 10); const directorySize = tail.readUInt32LE(eocd + 12); const directoryOffset = tail.readUInt32LE(eocd + 16); const absoluteEocd = tailStart + eocd;
  if (!count || count > 10000 || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || directorySize > 64 * 1024 * 1024 || directoryOffset + directorySize !== absoluteEocd) throw new Error('ZIP 中央目录越界或包已损坏');
  const directory = readExact(fd, directorySize, directoryOffset);
  const entries = [];
  const names = new Set();
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 条目目录损坏');
    const flags = directory.readUInt16LE(offset + 8); const method = directory.readUInt16LE(offset + 10); const expectedCrc = directory.readUInt32LE(offset + 16); const compressedSize = directory.readUInt32LE(offset + 20); const uncompressedSize = directory.readUInt32LE(offset + 24); const nameLength = directory.readUInt16LE(offset + 28); const extraLength = directory.readUInt16LE(offset + 30); const commentLength = directory.readUInt16LE(offset + 32); const externalAttributes = directory.readUInt32LE(offset + 38); const localOffset = directory.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || entryEnd > directory.length) throw new Error('ZIP 条目目录越界');
    const name = directory.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const pathWithoutSlash = name.replace(/[\\/]$/, '');
    if (!validArchivePath(pathWithoutSlash)) throw new Error(`安装包包含不安全路径：${name || '(空路径)'}`);
    if (((externalAttributes >>> 16) & 0xf000) === 0xa000) throw new Error(`安装包包含不安全的符号链接：${name}`);
    const normalizedName = normalizeRelativeFile(name); const foldedName = normalizedName.toLowerCase();
    if (names.has(foldedName)) throw new Error(`安装包包含重复或大小写冲突路径：${name}`);
    names.add(foldedName);
    entries.push({ name: normalizedName, flags, method, expectedCrc, compressedSize, uncompressedSize, localOffset });
    offset = entryEnd;
  }
  if (offset !== directory.length) throw new Error('ZIP 中央目录条目数量不一致');
  return { archive: Object.freeze({ archivePath, size }), entries };
  } finally { fs.closeSync(fd); }
};
const readZipEntry = (archive, entry) => {
  if (entry.flags & 1) throw new Error('不支持加密组件包');
  if (entry.uncompressedSize > MAX_MANIFEST_BYTES || entry.compressedSize > MAX_MANIFEST_BYTES + 64 * 1024) throw new Error('component.json 过大');
  const fd = fs.openSync(archive.archivePath, 'r'); let source;
  try { const local = readExact(fd, 30, entry.localOffset); if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 本地条目损坏'); const localFlags = local.readUInt16LE(6); const localMethod = local.readUInt16LE(8); const localNameLength = local.readUInt16LE(26); const localExtraLength = local.readUInt16LE(28); const localName = readExact(fd, localNameLength, entry.localOffset + 30).toString('utf8'); if (normalizeRelativeFile(localName) !== entry.name || localFlags !== entry.flags || localMethod !== entry.method) throw new Error('ZIP 本地条目与中央目录不一致'); const start = entry.localOffset + 30 + localNameLength + localExtraLength; if (start + entry.compressedSize > archive.size) throw new Error('ZIP 条目数据越界'); source = readExact(fd, entry.compressedSize, start); } finally { fs.closeSync(fd); }
  const value = entry.method === 0 ? source : entry.method === 8 ? zlib.inflateRawSync(source, { maxOutputLength: MAX_MANIFEST_BYTES }) : null;
  if (!value) throw new Error(`component.json 使用了不支持的 ZIP 压缩方法：${entry.method}`);
  if (value.length !== entry.uncompressedSize || crc32(value) !== entry.expectedCrc) throw new Error('component.json 校验失败，安装包可能已损坏');
  return value;
};
const readComponentPackageManifest = archivePath => {
  const { archive, entries } = readZipEntries(archivePath);
  const manifests = entries.filter(entry => /(^|\/)component\.json$/i.test(entry.name));
  if (manifests.length !== 1) throw new Error(manifests.length ? '安装包包含多个 component.json' : '安装包中没有 component.json');
  let manifest;
  try { manifest = JSON.parse(readZipEntry(archive, manifests[0]).toString('utf8')); }
  catch (error) { throw new Error(`component.json 无效：${error.message || String(error)}`); }
  return { manifest, manifestEntry: manifests[0].name, entries: entries.map(entry => entry.name) };
};

const manifestIdentity = (manifest, fallback = {}) => ({
  id: String(manifest?.id || fallback.id || '').trim(),
  name: String(manifest?.displayName || manifest?.name || fallback.name || manifest?.id || fallback.id || '').trim(),
  description: String(manifest?.description || fallback.description || '').trim(),
  capabilities: Array.isArray(manifest?.capabilities) ? manifest.capabilities.map(String) : (fallback.capabilities?.length ? fallback.capabilities : legacyRuntimeCapabilities(manifest?.id || fallback.id)),
});
const manifestCompatibilityError = (manifest, platform, arch) => {
  if (!COMPONENT_ID.test(String(manifest?.id || ''))) return '组件 ID 缺失或格式无效';
  if (!String(manifest?.version || '').trim()) return '组件版本缺失';
  try { parseMediaPlaybackBackendContributions(manifest); }
  catch (error) { return error.message || String(error); }
  if (Array.isArray(manifest.platforms) && !manifest.platforms.includes(platform)) return `组件不支持 ${platform}`;
  if (Array.isArray(manifest.architectures) && !manifest.architectures.includes(arch)) return `组件不支持 ${arch}`;
  if (manifest.componentHost !== undefined) {
    const host = manifest.componentHost;
    if (!host || Number(host.contractVersion) !== COMPONENT_HOST_CONTRACT_VERSION) return `组件 Host 协议不兼容：${host?.contractVersion || '未填写'}`;
    const contributions = Array.isArray(host.contributions) ? host.contributions : [];
    const toolbarCount = contributions.filter(item => item?.type === 'workspace.toolbarAction').length;
    const pageCount = contributions.filter(item => item?.type === 'component.fullPage').length;
    const settingsPageCount = contributions.filter(item => item?.type === 'application.settingsPage').length;
    const settingsFormCount = contributions.filter(item => item?.type === 'application.settingsForm').length;
    const sidePanelCount = contributions.filter(item => item?.type === 'component.sidePanel').length;
    const hostContributionCount = contributions.filter(item => ['component.sidePanel', 'media.contextAction', 'project.contextAction', 'project.importProvider', 'project.exportProvider', 'application.command'].includes(item?.type)).length;
    if (toolbarCount > 1 || toolbarCount + sidePanelCount < 1 || pageCount < 1 || pageCount > 16 || settingsPageCount + settingsFormCount > 16 || contributions.length !== toolbarCount + pageCount + settingsPageCount + settingsFormCount + hostContributionCount) return '页面组件必须贡献 toolbarAction 或 sidePanel、1-16 个 fullPage，并可选贡献设置页、声明式设置表单或其他 Host API 入口';
  }
  const entrypoints = manifest.entrypoints || {};
  const relativeEntry = entrypoints[`${platform}-${arch}`] || entrypoints[platform] || entrypoints.default;
  if (typeof relativeEntry !== 'string' || !relativeEntry.trim()) return '组件没有适用于当前系统的入口文件';
  if (!validArchivePath(relativeEntry)) return `组件入口路径不安全：${relativeEntry}`;
  return '';
};
const packageContentsError = (packageManifest, platform, arch) => {
  const manifestDirectory = path.posix.dirname(packageManifest.manifestEntry);
  const entries = new Set(packageManifest.entries.map(normalizeRelativeFile));
  const entrypoints = packageManifest.manifest.entrypoints || {};
  const host = packageManifest.manifest.componentHost;
  const serviceEntries = host?.service?.entrypoints || {};
  const required = [
    entrypoints[`${platform}-${arch}`] || entrypoints[platform] || entrypoints.default,
    ...(Array.isArray(packageManifest.manifest.requiredFiles) ? packageManifest.manifest.requiredFiles : []),
    ...(Array.isArray(host?.contributions) ? host.contributions.filter(item => ['component.fullPage', 'application.settingsPage'].includes(item?.type)).map(item => item.entry) : []),
    ...(Array.isArray(host?.contributions) ? host.contributions.filter(item => item?.type === 'application.settingsForm').map(item => item.customPage?.entry) : []),
    ...(host?.service ? [serviceEntries[`${platform}-${arch}`] || serviceEntries[platform] || serviceEntries.default] : []),
    ...Object.values(host?.service?.lifecycleActions || {}).map(action => action?.entry),
  ].filter(Boolean);
  for (const relativeFile of required) {
    if (!validArchivePath(relativeFile)) return `组件文件路径无效：${relativeFile}`;
    const archiveEntry = path.posix.normalize(path.posix.join(manifestDirectory === '.' ? '' : manifestDirectory, normalizeRelativeFile(relativeFile)));
    if (!entries.has(archiveEntry)) return `安装包缺少组件文件：${relativeFile}`;
  }
  return '';
};
const directorySize = async root => {
  let size = 0; const pending = [root];
  while (pending.length) {
    const directory = pending.pop(); let entries = [];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) { try { size += (await fs.promises.stat(entryPath)).size; } catch { /* changed */ } }
    }
  }
  return size;
};

const createComponentRegistry = ({ projectRoot, userComponentRoot, isPackaged, platform = process.platform, arch = process.arch, integrityManifests = null, environment = process.env }) => {
  if (!userComponentRoot) throw new Error('必须提供用户组件目录');
  // ZIP discovery and installed runtimes always live in user data. Development
  // source discovery is a separate overlay and must never redirect installs
  // into the repository checkout.
  const installRoot = path.resolve(userComponentRoot);
  const componentStatePath = path.join(installRoot, '.component-state.json');
  const disabledComponentIds = new Set();
  let enablementStateTrusted = true;
  try {
    let statePath = componentStatePath;
    if (!fs.existsSync(statePath)) {
      const base = path.basename(componentStatePath); const backups = fs.existsSync(installRoot) ? fs.readdirSync(installRoot, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.startsWith(`${base}.`) && entry.name.endsWith('.backup')) : [];
      if (backups.length > 1) throw new Error('Ambiguous component enablement state backups');
      if (backups.length === 1) statePath = path.join(installRoot, backups[0].name);
    }
    if (fs.existsSync(statePath)) {
      const savedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (Number(savedState?.version) !== COMPONENT_STATE_VERSION || !Array.isArray(savedState.disabledComponentIds) || savedState.disabledComponentIds.length > 1024 || savedState.disabledComponentIds.some(id => !COMPONENT_ID.test(String(id || '')))) throw new Error('Invalid component enablement state');
      for (const id of savedState.disabledComponentIds) disabledComponentIds.add(String(id));
      if (statePath !== componentStatePath) fs.renameSync(statePath, componentStatePath);
    }
  } catch { enablementStateTrusted = false; }
  const persistComponentState = () => {
    fs.mkdirSync(installRoot, { recursive: true });
    const pending = `${componentStatePath}.${process.pid}.tmp`;
    const backup = `${componentStatePath}.${process.pid}.backup`; let backedUp = false;
    fs.writeFileSync(pending, JSON.stringify({ version: COMPONENT_STATE_VERSION, disabledComponentIds: [...disabledComponentIds].sort() }), { encoding: 'utf8', flag: 'w' });
    try { if (fs.existsSync(componentStatePath)) { fs.renameSync(componentStatePath, backup); backedUp = true; } fs.renameSync(pending, componentStatePath); if (backedUp) { fs.rmSync(backup, { force: true }); backedUp = false; } }
    catch (error) { if (backedUp && !fs.existsSync(componentStatePath)) { try { fs.renameSync(backup, componentStatePath); backedUp = false; } catch { /* Preserve backup for manual recovery. */ } } throw error; }
    finally { fs.rmSync(pending, { force: true }); }
    enablementStateTrusted = true;
  };
  const withEnablementState = component => component && component.installed
    ? { ...component, enabled: enablementStateTrusted && !disabledComponentIds.has(component.id), ...(!enablementStateTrusted || disabledComponentIds.has(component.id) ? { status: 'disabled' } : {}) }
    : component;
  const roots = [{ source: 'user', path: installRoot }];
  let developmentCache = { token: '', components: [] };
  let inspectedDevelopmentCache = { components: null, inspected: [] };
  const developmentOptions = { projectRoot, environment, platform, arch };
  const developmentComponents = () => {
    if (isPackaged) return [];
    const token = developmentComponentMetadataToken(developmentOptions);
    if (developmentCache.token === token) return developmentCache.components;
    const components = discoverDevelopmentComponents(developmentOptions);
    developmentCache = { token, components };
    return components;
  };
  const integrityCache = new Map(); const integrityPending = new Map(); const expectedIntegrity = new Map();
  const definitionFor = (id, manifest = null) => COMPONENT_DEFINITIONS[id] || { ...manifestIdentity(manifest), id, capability: manifest?.capabilities?.[0] || '', capabilities: manifest?.capabilities || [] };
  const getExpectedIntegrity = definition => {
    if (!definition.integrityManifest) return null;
    if (expectedIntegrity.has(definition.id)) return expectedIntegrity.get(definition.id);
    const manifest = integrityManifests?.[definition.id] || readPinnedComponentIntegrity(projectRoot, definition.integrityManifest);
    if (manifest.componentId !== definition.id || String(manifest.version || '') !== String(definition.version)) throw new Error(`组件可信完整性清单版本不匹配：${definition.id}`);
    expectedIntegrity.set(definition.id, manifest); return manifest;
  };
  const integrityMetadataToken = componentRoot => [...listIntegrityFiles(componentRoot), 'component-integrity.json'].map(file => {
    const stat = fs.statSync(path.resolve(componentRoot, file), { throwIfNoEntry: false });
    return `${file}:${stat?.size ?? -1}:${stat?.mtimeMs ?? -1}:${stat?.ctimeMs ?? -1}`;
  }).join('|');
  const componentMetadataToken = (id, componentRoot) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(componentRoot, 'component.json'), 'utf8'));
    if (manifest.id !== id) throw new Error(`组件 ID 不匹配：${manifest.id || '未填写'}`);
    const entrypoints = manifest.entrypoints || {};
    const relativeEntry = entrypoints[`${platform}-${arch}`] || entrypoints[platform] || entrypoints.default;
    const host = manifest.componentHost || {};
    const serviceEntries = host.service?.entrypoints || {};
    const serviceEntry = serviceEntries[`${platform}-${arch}`] || serviceEntries[platform] || serviceEntries.default;
    const declaredEntries = [
      ...(Array.isArray(host.contributions) ? host.contributions.map(item => item?.entry) : []),
      ...(Array.isArray(host.contributions) ? host.contributions.map(item => item?.customPage?.entry) : []),
      serviceEntry,
      ...Object.values(host.service?.lifecycleActions || {}).map(action => action?.entry),
    ];
    const files = [...new Set(['component.json', relativeEntry, ...declaredEntries, ...(Array.isArray(manifest.requiredFiles) ? manifest.requiredFiles : [])].filter(Boolean).map(normalizeRelativeFile))].sort();
    return files.map(file => {
      const absolute = path.resolve(componentRoot, file); const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
      if (!validArchivePath(file) || !isInside(componentRoot, absolute) || !stat?.isFile() || stat.isSymbolicLink()) throw new Error(`组件文件不存在或类型不安全：${file}`);
      return `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }).join('|');
  };
  const verifyDirectory = (id, componentRoot, force = false) => {
    const componentManifest = JSON.parse(fs.readFileSync(path.join(componentRoot, 'component.json'), 'utf8'));
    if (componentManifest.id !== id) throw new Error(`组件 ID 不匹配：${componentManifest.id || '未填写'}`);
    parseComponentHostManifest(componentManifest, componentRoot);
    const definition = definitionFor(id, componentManifest);
    const expected = getExpectedIntegrity(definition); if (!expected) return true;
    const token = integrityMetadataToken(componentRoot); const cacheKey = `${id}:${path.resolve(componentRoot)}`;
    if (!force && integrityCache.get(cacheKey) === token) return true;
    validateComponentIntegrity(componentRoot, expected); integrityCache.set(cacheKey, token); return true;
  };
  const verifyDirectoryAsync = async (id, componentRoot, force = false) => {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(componentRoot, 'component.json'), 'utf8'));
    if (manifest.id !== id) throw new Error(`组件 ID 不匹配：${manifest.id || '未填写'}`);
    parseComponentHostManifest(manifest, componentRoot);
    const definition = definitionFor(id, manifest); const expected = getExpectedIntegrity(definition); if (!expected) return true;
    const token = integrityMetadataToken(componentRoot); const cacheKey = `${id}:${path.resolve(componentRoot)}`;
    if (!force && integrityCache.get(cacheKey) === token) return true;
    const pending = integrityPending.get(cacheKey); if (pending?.token === token) return pending.promise;
    const promise = validateComponentIntegrityAsync(componentRoot, expected).then(() => { integrityCache.set(cacheKey, token); return true; }).finally(() => {
      if (integrityPending.get(cacheKey)?.promise === promise) integrityPending.delete(cacheKey);
    });
    integrityPending.set(cacheKey, { token, promise }); return promise;
  };
  const componentIntegrityToken = (id, componentRoot) => COMPONENT_DEFINITIONS[id]?.integrityManifest ? `integrity|${integrityMetadataToken(componentRoot)}` : `metadata|${componentMetadataToken(id, componentRoot)}`;
  const seedIntegrityToken = (id, componentRoot, token) => {
    if (!token || token !== componentIntegrityToken(id, componentRoot)) return false;
    if (COMPONENT_DEFINITIONS[id]?.integrityManifest) integrityCache.set(`${id}:${path.resolve(componentRoot)}`, token.replace(/^integrity\|/, ''));
    return true;
  };
  const inspectRoot = (componentRoot, source, expectedId) => {
    const manifestPath = path.join(componentRoot, 'component.json'); if (!fs.existsSync(manifestPath)) return null;
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.id !== expectedId) throw new Error(`组件 ID 与目录不匹配：需要 ${expectedId}，实际为 ${manifest.id || '未填写'}`);
      const identity = manifestIdentity(manifest, COMPONENT_DEFINITIONS[manifest.id]);
      const compatibilityError = manifestCompatibilityError(manifest, platform, arch); if (compatibilityError) throw new Error(compatibilityError);
      const entrypoints = manifest.entrypoints || {};
      const relativeEntry = entrypoints[`${platform}-${arch}`] || entrypoints[platform] || entrypoints.default;
      const command = path.resolve(componentRoot, relativeEntry); const commandStat = fs.lstatSync(command, { throwIfNoEntry: false });
      if (!isInside(componentRoot, command) || !commandStat?.isFile() || commandStat.isSymbolicLink() || !isInside(fs.realpathSync(componentRoot), fs.realpathSync(command))) throw new Error(`组件入口不存在或路径不安全：${relativeEntry}`);
      for (const relativeFile of Array.isArray(manifest.requiredFiles) ? manifest.requiredFiles : []) {
        const requiredFile = path.resolve(componentRoot, String(relativeFile)); const stat = fs.lstatSync(requiredFile, { throwIfNoEntry: false });
        if (!validArchivePath(relativeFile) || !isInside(componentRoot, requiredFile) || !stat?.isFile() || stat.isSymbolicLink()) throw new Error(`组件必需文件不存在或路径不安全：${relativeFile}`);
      }
      parseComponentHostManifest(manifest, componentRoot);
      const definition = definitionFor(identity.id, manifest);
      return { ...definition, ...identity, capability: definition.capability || identity.capabilities[0] || '', installed: true, compatible: true, version: String(manifest.version), path: componentRoot, source, sizeBytes: 0,
        command, argsPrefix: Array.isArray(manifest.argsPrefix) ? manifest.argsPrefix.map(String) : [], manifest, integrityStatus: definition.integrityManifest ? 'pinned-unverified' : 'unsigned',
        integrityMessage: definition.integrityManifest ? '完整性将在运行或安装时按应用固定清单校验' : '未提供可由应用验证的数字签名；仅完成结构与路径校验' };
    } catch (error) {
      const containerName = path.basename(componentRoot) === 'runtime' ? path.basename(path.dirname(componentRoot)) : path.basename(componentRoot);
      const id = String(manifest?.id || containerName || '').trim(); if (!COMPONENT_ID.test(id)) return null;
      const definition = definitionFor(id, manifest);
      return { ...definition, ...manifestIdentity(manifest, definition), id, capability: definition.capability || '', installed: true, compatible: false, version: String(manifest?.version || ''), path: componentRoot, source, sizeBytes: 0,
        manifest, status: 'invalid', integrityStatus: 'invalid', error: error.message || String(error) };
    }
  };
  const inspectDevelopment = development => {
    const manifest = development.manifest || null; const id = String(manifest?.id || development.id || '').trim();
    if (!COMPONENT_ID.test(id)) return null;
    try {
      if (development.error) throw new Error(development.error);
      const compatibilityError = manifestCompatibilityError(manifest, platform, arch); if (compatibilityError) throw new Error(compatibilityError);
      for (const relative of Array.isArray(manifest.requiredFiles) ? manifest.requiredFiles : []) {
        const normalized = normalizeRelativeFile(relative);
        if (development.files[normalized]) continue;
        safeFile(development.componentRoot, normalized, `component required file ${normalized}`);
      }
      parseComponentHostManifest(manifest, development.componentRoot, { componentRoot: development.componentRoot, files: development.files });
      const identity = manifestIdentity(manifest, definitionFor(id, manifest)); const definition = definitionFor(id, manifest);
      return { ...definition, ...identity, capability: definition.capability || identity.capabilities[0] || '', installed: true, compatible: true, version: String(manifest.version), path: development.componentRoot,
        source: 'development', sizeBytes: 0, command: development.command, argsPrefix: [...development.argsPrefix], manifest, manifestPath: development.manifestPath, developmentFiles: development.files,
        status: 'installed', integrityStatus: 'development', integrityMessage: '开发组件（源码/开发构建）；未经正式安装包完整性验证' };
    } catch (error) {
      const definition = definitionFor(id, manifest);
      return { ...definition, ...manifestIdentity(manifest, definition), id, capability: definition.capability || '', installed: false, compatible: false, version: String(manifest?.version || ''), path: development.componentRoot,
        source: 'development', sizeBytes: 0, manifest, status: 'invalid', integrityStatus: 'invalid', error: `开发组件不可用：${error.message || String(error)}。请在组件目录运行声明的 prepare/build 脚本。` };
    }
  };
  const inspectedDevelopmentComponents = () => {
    const components = developmentComponents();
    if (inspectedDevelopmentCache.components === components) return inspectedDevelopmentCache.inspected;
    const inspected = components.map(inspectDevelopment).filter(Boolean);
    inspectedDevelopmentCache = { components, inspected };
    return inspected;
  };
  const installedComponents = () => {
    const byId = new Map();
    for (const root of roots) {
      let entries = []; try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !COMPONENT_ID.test(entry.name) || entry.name.startsWith('.')) continue;
        const container = path.join(root.path, entry.name); const runtime = path.join(container, 'runtime');
        const componentRoot = fs.existsSync(path.join(runtime, 'component.json')) ? runtime : container;
        const inspected = inspectRoot(componentRoot, root.source, entry.name);
        if (inspected && !byId.has(inspected.id)) byId.set(inspected.id, withEnablementState(inspected));
      }
    }
    for (const inspected of inspectedDevelopmentComponents()) {
      // Current source must win over an older user installation while running
      // an unpackaged development build of the same component.
      byId.set(inspected.id, withEnablementState(inspected));
    }
    return byId;
  };
  const packageComponents = () => {
    const byId = new Map(); let entries = [];
    try { entries = fs.readdirSync(installRoot, { withFileTypes: true }); } catch { return byId; }
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.zip') continue;
      const archivePath = path.join(installRoot, entry.name); let manifest = null;
      try {
        const packageManifest = readComponentPackageManifest(archivePath);
        ({ manifest } = packageManifest);
        const identity = manifestIdentity(manifest, COMPONENT_DEFINITIONS[manifest.id]); if (!COMPONENT_ID.test(identity.id)) throw new Error('组件 ID 缺失或格式无效');
        const definition = definitionFor(identity.id, manifest);
        const pinnedVersionError = definition.integrityManifest && String(manifest.version) !== String(definition.version) ? `组件版本不兼容：需要 ${definition.version}，安装包为 ${manifest.version}` : '';
        const error = manifestCompatibilityError(manifest, platform, arch) || packageContentsError(packageManifest, platform, arch) || pinnedVersionError;
        const candidate = { ...definition, ...identity, capability: definition.capability || identity.capabilities[0] || '', installed: false, compatible: !error, version: String(manifest.version || ''), packageVersion: String(manifest.version || ''),
          path: path.join(installRoot, identity.id, 'runtime'), source: 'package', packagePath: archivePath, packageSizeBytes: fs.statSync(archivePath).size, sizeBytes: 0, manifest, manifestEntry: packageManifest.manifestEntry,
          status: error ? 'incompatible' : 'pending-install', integrityStatus: definition.integrityManifest ? 'pinned-unverified' : 'unsigned',
          integrityMessage: definition.integrityManifest ? '安装时将按应用固定完整性清单校验' : '未提供可由应用验证的数字签名；安装前仅能校验包结构与路径', ...(error ? { error } : {}) };
        const previous = byId.get(identity.id); if (!previous || candidate.compatible && !previous.compatible || candidate.compatible === previous.compatible && compareVersions(previous.packageVersion, candidate.packageVersion) < 0) byId.set(identity.id, candidate);
      } catch (error) {
        const inferred = String(manifest?.id || entry.name.replace(/\.zip$/i, '')).trim();
        const id = COMPONENT_ID.test(inferred) ? inferred : `invalid-package-${Buffer.from(entry.name).toString('hex').slice(0, 24)}`;
        if (!byId.get(id)?.compatible) byId.set(id, { id, name: manifest?.displayName || manifest?.name || entry.name, description: '组件安装包无法读取', capability: '', installed: false, compatible: false, version: String(manifest?.version || ''),
          path: path.join(installRoot, id, 'runtime'), source: 'package', packagePath: archivePath, packageSizeBytes: fs.statSync(archivePath).size, sizeBytes: 0,
          status: 'package-invalid', integrityStatus: 'invalid', error: error.message || String(error) });
      }
    }
    return byId;
  };
  const list = () => {
    const installed = installedComponents(); const packages = packageComponents(); const ids = new Set([...installed.keys(), ...packages.keys()]);
    return [...ids].map(id => {
      const current = installed.get(id); const available = packages.get(id);
      if (!current) return available;
      if (current.source === 'development') return current;
      if (!available) return { ...current, status: current.enabled === false ? 'disabled' : (current.compatible ? 'installed' : 'invalid') };
      const update = current.compatible && available.compatible && compareVersions(current.version, available.packageVersion) < 0;
      return { ...current, packagePath: available.packagePath, packageSizeBytes: available.packageSizeBytes, packageVersion: available.packageVersion, packageCompatible: available.compatible,
        packageError: available.error, status: current.enabled === false ? 'disabled' : update ? 'update-available' : (current.compatible ? 'installed' : 'invalid'), updateAvailable: update };
    }).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN'));
  };
  const inspect = id => list().find(item => item.id === id) || null;
  const resolve = (id, { verifyIntegrity = false } = {}) => {
    const component = installedComponents().get(id) || null;
    if (component?.installed && component.enabled !== false && component.compatible && verifyIntegrity && component.source === 'user') verifyDirectory(id, component.path, true);
    return component?.installed && component.enabled !== false && component.compatible ? component : null;
  };
  const resolveAsync = async (id, { verifyIntegrity = false } = {}) => {
    const component = installedComponents().get(id) || null;
    if (component?.installed && component.enabled !== false && component.compatible && verifyIntegrity && component.source === 'user') await verifyDirectoryAsync(id, component.path, true);
    return component?.installed && component.enabled !== false && component.compatible ? component : null;
  };
  const ensureInstallRoot = () => { fs.mkdirSync(installRoot, { recursive: true }); return installRoot; };
  const listWithSizes = async () => Promise.all(list().map(async component => {
    let verified = component;
    if (component.installed && component.compatible && component.source === 'user' && COMPONENT_DEFINITIONS[component.id]?.integrityManifest) {
      try { await verifyDirectoryAsync(component.id, component.path); verified = { ...component, integrityStatus: 'verified', integrityMessage: '已按应用固定完整性清单校验' }; }
      catch (error) { verified = { ...component, compatible: false, status: 'integrity-invalid', integrityStatus: 'invalid', error: error.message || String(error) }; }
    }
    return { ...verified, sizeBytes: verified.installed && verified.source === 'user' && verified.path && await fs.promises.stat(verified.path).then(stat => stat.isDirectory(), () => false) ? await directorySize(verified.path) : 0 };
  }));
  const resolvePackage = id => {
    const component = packageComponents().get(String(id));
    if (!component) throw new Error(`未发现“${id}”的有效组件包`);
    if (!component.compatible || component.status === 'package-invalid') throw new Error(component.error || '组件包无效或不兼容');
    return component;
  };
  let admittedHostCandidates = new Set();
  const hostCandidateKey = (componentId, componentRoot) => `${process.platform === 'win32' ? path.resolve(componentRoot).toLowerCase() : path.resolve(componentRoot)}\0${componentId}`;
  const hostCandidates = () => {
    const values = [...installedComponents().values()]
      .filter(component => component.installed && component.enabled !== false && component.compatible && component.manifest?.componentHost)
      .map(component => component.source === 'development' ? {
        componentRoot: component.path, manifestPath: component.manifestPath, manifest: component.manifest, expectedId: component.id, source: component.source,
        developmentFiles: { componentRoot: component.path, files: component.developmentFiles }, developmentRuntime: { command: component.command, argsPrefix: component.argsPrefix },
      } : { componentRoot: component.path, manifestPath: path.join(component.path, 'component.json'), manifest: component.manifest, expectedId: component.id, source: component.source });
    admittedHostCandidates = new Set(values.map(candidate => hostCandidateKey(candidate.expectedId, candidate.componentRoot)));
    return values;
  };
  const admitHostDescriptor = (descriptor, componentRoot) => {
    if (!descriptor || !admittedHostCandidates.has(hostCandidateKey(descriptor.componentId, componentRoot))) return false;
    if (COMPONENT_DEFINITIONS[descriptor.componentId]?.integrityManifest) verifyDirectory(descriptor.componentId, componentRoot, true);
    return true;
  };
  const setComponentEnabled = (componentId, enabled) => {
    const id = String(componentId || '').trim();
    if (!COMPONENT_ID.test(id)) throw new Error('组件 ID 无效');
    const component = installedComponents().get(id);
    if (!component?.installed) throw new Error('组件尚未安装或发现');
    const shouldEnable = enabled === true;
    const wasDisabled = disabledComponentIds.has(id);
    if (wasDisabled === !shouldEnable) return { componentId: id, enabled: shouldEnable };
    if (shouldEnable) disabledComponentIds.delete(id); else disabledComponentIds.add(id);
    try { persistComponentState(); }
    catch (error) {
      if (wasDisabled) disabledComponentIds.add(id); else disabledComponentIds.delete(id);
      throw error;
    }
    return { componentId: id, enabled: shouldEnable };
  };
  const clearComponentEnabledState = componentId => {
    const id = String(componentId || '').trim();
    if (!disabledComponentIds.delete(id)) return false;
    try { persistComponentState(); }
    catch (error) { disabledComponentIds.add(id); throw error; }
    return true;
  };
  return { inspect, list, listWithSizes, resolve, resolveAsync, resolvePackage, verifyDirectory, verifyDirectoryAsync, componentIntegrityToken, seedIntegrityToken, ensureInstallRoot, installRoot, roots, hostCandidates, admitHostDescriptor, componentStatePath, setComponentEnabled, clearComponentEnabledState };
};

module.exports = { COMPONENT_DEFINITIONS, compareVersions, readComponentPackageManifest, readZipEntries, createComponentRegistry };
