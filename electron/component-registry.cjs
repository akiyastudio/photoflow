const fs = require('fs');
const path = require('path');
const { PLUGIN_API_VERSION, PLUGIN_DEFINITIONS } = require('./plugins/plugin-catalog.cjs');
const { listIntegrityFiles, readPinnedComponentIntegrity, validateComponentIntegrity, validateComponentIntegrityAsync } = require('./component-integrity.cjs');

const COMPONENT_API_VERSION = PLUGIN_API_VERSION;
const COMPONENT_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries(PLUGIN_DEFINITIONS).map(([id, definition]) => [id, {
  ...definition,
  capability: definition.capabilities[0],
}])));
const normalizeRelativeFile = value => String(value || '').replace(/\\/g, '/');

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const directorySize = async root => {
  let size = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries = [];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        try { size += (await fs.promises.stat(entryPath)).size; } catch { /* file changed during inspection */ }
      }
    }
  }
  return size;
};

const createComponentRegistry = ({ projectRoot, userComponentRoot, isPackaged, platform = process.platform, arch = process.arch, integrityManifests = null }) => {
  if (isPackaged && !userComponentRoot) throw new Error('打包版本必须提供用户组件目录');
  const installRoot = isPackaged ? path.resolve(userComponentRoot) : path.join(projectRoot, 'components');
  const roots = isPackaged
    ? [{ source: 'user', path: installRoot }]
    : [
      { source: 'development', path: path.join(projectRoot, 'extensions') },
      { source: 'development', path: installRoot },
    ];
  const integrityCache = new Map();
  const integrityPending = new Map();
  const expectedIntegrity = new Map();
  const getExpectedIntegrity = definition => {
    if (!definition.integrityManifest) return null;
    if (expectedIntegrity.has(definition.id)) return expectedIntegrity.get(definition.id);
    const manifest = integrityManifests?.[definition.id]
      || readPinnedComponentIntegrity(projectRoot, definition.integrityManifest);
    if (manifest.componentId !== definition.id || String(manifest.version || '') !== String(definition.version)) {
      throw new Error(`组件可信完整性清单版本不匹配：${definition.id}`);
    }
    expectedIntegrity.set(definition.id, manifest);
    return manifest;
  };
  const integrityMetadataToken = (componentRoot, manifest) => [
    ...listIntegrityFiles(componentRoot).map(file => {
      const stat = fs.statSync(path.resolve(componentRoot, file), { throwIfNoEntry: false });
      return `${file}:${stat?.size ?? -1}:${stat?.mtimeMs ?? -1}:${stat?.ctimeMs ?? -1}`;
    }),
    (() => {
      const stat = fs.statSync(path.join(componentRoot, 'component-integrity.json'), { throwIfNoEntry: false });
      return `component-integrity.json:${stat?.size ?? -1}:${stat?.mtimeMs ?? -1}:${stat?.ctimeMs ?? -1}`;
    })(),
  ].join('|');
  const componentMetadataToken = (id, componentRoot) => {
    const manifestPath = path.join(componentRoot, 'component.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.id !== id) throw new Error(`组件 ID 不匹配：${manifest.id || '未填写'}`);
    const entrypoints = manifest.entrypoints || {};
    const relativeEntry = entrypoints[`${platform}-${arch}`] || entrypoints[platform] || entrypoints.default;
    const relativeFiles = [...new Set([
      'component.json',
      ...(typeof relativeEntry === 'string' && relativeEntry.trim() ? [relativeEntry] : []),
      ...(Array.isArray(manifest.requiredFiles) ? manifest.requiredFiles : []),
    ].map(normalizeRelativeFile))].sort((left, right) => left.localeCompare(right, 'en'));
    const tokens = relativeFiles.map(relativeFile => {
      const absolute = path.resolve(componentRoot, relativeFile);
      if (!isInside(componentRoot, absolute)) throw new Error(`组件元数据路径越界：${relativeFile}`);
      const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`组件文件不存在或类型不安全：${relativeFile}`);
      return `${relativeFile}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    });
    return `metadata|${tokens.join('|')}`;
  };
  const verifyDirectory = (id, componentRoot, force = false) => {
    const definition = COMPONENT_DEFINITIONS[id];
    if (!definition) throw new Error(`未知组件：${id}`);
    const expected = getExpectedIntegrity(definition);
    if (!expected) return true;
    const token = integrityMetadataToken(componentRoot, expected);
    const cacheKey = `${id}:${path.resolve(componentRoot)}`;
    if (!force && integrityCache.get(cacheKey) === token) return true;
    validateComponentIntegrity(componentRoot, expected);
    integrityCache.set(cacheKey, token);
    return true;
  };
  const verifyDirectoryAsync = async (id, componentRoot, force = false) => {
    const definition = COMPONENT_DEFINITIONS[id];
    if (!definition) throw new Error(`未知组件：${id}`);
    const expected = getExpectedIntegrity(definition);
    if (!expected) return true;
    const token = integrityMetadataToken(componentRoot, expected);
    const cacheKey = `${id}:${path.resolve(componentRoot)}`;
    if (!force && integrityCache.get(cacheKey) === token) return true;
    const pending = integrityPending.get(cacheKey);
    if (pending?.token === token) return pending.promise;
    const promise = validateComponentIntegrityAsync(componentRoot, expected).then(() => {
      integrityCache.set(cacheKey, token);
      return true;
    }).finally(() => {
      if (integrityPending.get(cacheKey)?.promise === promise) integrityPending.delete(cacheKey);
    });
    integrityPending.set(cacheKey, { token, promise });
    return promise;
  };
  const componentIntegrityToken = (id, componentRoot) => {
    const definition = COMPONENT_DEFINITIONS[id];
    if (!definition) throw new Error(`未知组件：${id}`);
    if (!definition.integrityManifest) return componentMetadataToken(id, componentRoot);
    return `integrity|${integrityMetadataToken(componentRoot, getExpectedIntegrity(definition))}`;
  };
  const seedIntegrityToken = (id, componentRoot, token) => {
    if (!token || token !== componentIntegrityToken(id, componentRoot)) return false;
    if (COMPONENT_DEFINITIONS[id]?.integrityManifest) {
      integrityCache.set(`${id}:${path.resolve(componentRoot)}`, token.replace(/^integrity\|/, ''));
    }
    return true;
  };

  const inspectAt = (definition, root, { verifyIntegrity = true } = {}) => {
    const containerRoot = path.join(root.path, definition.id);
    const nestedRuntimeRoot = path.join(containerRoot, 'runtime');
    const componentRoot = fs.existsSync(path.join(nestedRuntimeRoot, 'component.json')) ? nestedRuntimeRoot : containerRoot;
    const manifestPath = path.join(componentRoot, 'component.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.id !== definition.id) throw new Error(`组件 ID 不匹配：${manifest.id || '未填写'}`);
      if (Number(manifest.apiVersion) !== COMPONENT_API_VERSION) throw new Error(`组件接口版本不兼容：${manifest.apiVersion || '未填写'}`);
      if (String(manifest.version || '') !== String(definition.version)) throw new Error(`组件版本不兼容：需要 ${definition.version}，当前为 ${manifest.version || '未知'}`);
      if (Array.isArray(manifest.platforms) && !manifest.platforms.includes(platform)) throw new Error(`组件不支持 ${platform}`);
      if (Array.isArray(manifest.architectures) && !manifest.architectures.includes(arch)) throw new Error(`组件不支持 ${arch}`);
      const entrypoints = manifest.entrypoints || {};
      const relativeEntry = entrypoints[`${platform}-${arch}`] || entrypoints[platform] || entrypoints.default;
      if (typeof relativeEntry !== 'string' || !relativeEntry.trim()) throw new Error('组件没有适用于当前系统的入口文件');
      const command = path.resolve(componentRoot, relativeEntry);
      if (!isInside(componentRoot, command)) throw new Error('组件入口超出组件目录');
      if (!fs.existsSync(command) || !fs.statSync(command).isFile()) throw new Error(`组件入口不存在：${relativeEntry}`);
      for (const relativeFile of Array.isArray(manifest.requiredFiles) ? manifest.requiredFiles : []) {
        if (typeof relativeFile !== 'string' || !relativeFile.trim()) throw new Error('组件必需文件路径无效');
        const requiredFile = path.resolve(componentRoot, relativeFile);
        if (!isInside(componentRoot, requiredFile)) throw new Error(`组件必需文件超出组件目录：${relativeFile}`);
        if (!fs.existsSync(requiredFile) || !fs.statSync(requiredFile).isFile()) throw new Error(`组件必需文件不存在：${relativeFile}`);
      }
      if (verifyIntegrity && root.source === 'user' && definition.integrityManifest) verifyDirectory(definition.id, componentRoot);
      return {
        ...definition,
        installed: true,
        compatible: true,
        version: String(manifest.version || '0.0.0'),
        path: componentRoot,
        source: root.source,
        sizeBytes: 0,
        command,
        argsPrefix: Array.isArray(manifest.argsPrefix) ? manifest.argsPrefix.map(String) : [],
        manifest,
      };
    } catch (error) {
      return {
        ...definition,
        installed: false,
        compatible: false,
        version: '',
        path: componentRoot,
        source: root.source,
        sizeBytes: 0,
        error: error.message || String(error),
      };
    }
  };

  const inspect = (id, options) => {
    const definition = COMPONENT_DEFINITIONS[id];
    if (!definition) return null;
    let incompatible = null;
    for (const root of roots) {
      const result = inspectAt(definition, root, options);
      if (!result) continue;
      if (result.installed) return result;
      incompatible ||= result;
    }
    return incompatible || {
      ...definition,
      installed: false,
      compatible: true,
      version: '',
      path: path.join(installRoot, id, 'runtime'),
      source: 'missing',
      sizeBytes: 0,
    };
  };

  const list = () => Object.keys(COMPONENT_DEFINITIONS).map(inspect);
  const resolve = (id, { verifyIntegrity = false } = {}) => {
    const component = inspect(id, { verifyIntegrity: false });
    if (component?.installed && verifyIntegrity && component.source === 'user') verifyDirectory(id, component.path, true);
    return component?.installed ? component : null;
  };
  const resolveAsync = async (id, { verifyIntegrity = false } = {}) => {
    const component = inspect(id, { verifyIntegrity: false });
    if (component?.installed && verifyIntegrity && component.source === 'user') await verifyDirectoryAsync(id, component.path, true);
    return component?.installed ? component : null;
  };
  const ensureInstallRoot = () => {
    fs.mkdirSync(installRoot, { recursive: true });
    return installRoot;
  };

  const listWithSizes = async () => Promise.all(Object.keys(COMPONENT_DEFINITIONS).map(id => inspect(id, { verifyIntegrity: false })).map(async component => {
    let verified = component;
    if (component.installed && component.source === 'user' && COMPONENT_DEFINITIONS[component.id]?.integrityManifest) {
      try { await verifyDirectoryAsync(component.id, component.path); }
      catch (error) { verified = { ...component, installed: false, compatible: false, error: error.message || String(error) }; }
    }
    return {
      ...verified,
      sizeBytes: verified.path && await fs.promises.stat(verified.path).then(stat => stat.isDirectory(), () => false)
        ? await directorySize(verified.path)
        : 0,
    };
  }));

  return { inspect, list, listWithSizes, resolve, resolveAsync, verifyDirectory, verifyDirectoryAsync, componentIntegrityToken, seedIntegrityToken, ensureInstallRoot, installRoot, roots };
};

module.exports = { COMPONENT_API_VERSION, COMPONENT_DEFINITIONS, createComponentRegistry };
