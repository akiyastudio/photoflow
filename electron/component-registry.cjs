const fs = require('fs');
const path = require('path');

const COMPONENT_API_VERSION = 1;
const COMPONENT_DEFINITIONS = Object.freeze({
  'team-retouch': {
    id: 'team-retouch',
    name: '多人裁片修图',
    description: '人物检测、无损裁片以及高分辨率 Patch 对齐、融合与拼回。',
    capability: 'team-retouch',
  },
  'research-tools': {
    id: 'research-tools',
    name: '调研整理',
    description: '视频分镜识别、图片去重与调研资料整理。',
    capability: 'research.organize',
  },
});

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const directorySize = root => {
  let size = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        try { size += fs.statSync(entryPath).size; } catch { /* file changed during inspection */ }
      }
    }
  }
  return size;
};

const createComponentRegistry = ({ resourcesPath, executablePath, projectRoot, isPackaged, platform = process.platform, arch = process.arch }) => {
  const installRoot = isPackaged
    ? path.join(path.dirname(executablePath), 'components')
    : path.join(projectRoot, 'components');
  const roots = isPackaged
    ? [
      { source: 'application', path: installRoot },
      { source: 'bundled', path: path.join(resourcesPath, 'components') },
    ]
    : [{ source: 'development', path: installRoot }];

  const inspectAt = (definition, root) => {
    const componentRoot = path.join(root.path, definition.id);
    const manifestPath = path.join(componentRoot, 'component.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.id !== definition.id) throw new Error(`组件 ID 不匹配：${manifest.id || '未填写'}`);
      if (Number(manifest.apiVersion) !== COMPONENT_API_VERSION) throw new Error(`组件接口版本不兼容：${manifest.apiVersion || '未填写'}`);
      if (Array.isArray(manifest.platforms) && !manifest.platforms.includes(platform)) throw new Error(`组件不支持 ${platform}`);
      if (Array.isArray(manifest.architectures) && !manifest.architectures.includes(arch)) throw new Error(`组件不支持 ${arch}`);
      const entrypoints = manifest.entrypoints || {};
      const relativeEntry = entrypoints[`${platform}-${arch}`] || entrypoints[platform] || entrypoints.default;
      if (typeof relativeEntry !== 'string' || !relativeEntry.trim()) throw new Error('组件没有适用于当前系统的入口文件');
      const command = path.resolve(componentRoot, relativeEntry);
      if (!isInside(componentRoot, command)) throw new Error('组件入口超出组件目录');
      if (!fs.existsSync(command) || !fs.statSync(command).isFile()) throw new Error(`组件入口不存在：${relativeEntry}`);
      return {
        ...definition,
        installed: true,
        compatible: true,
        version: String(manifest.version || '0.0.0'),
        path: componentRoot,
        source: root.source,
        sizeBytes: directorySize(componentRoot),
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
        sizeBytes: directorySize(componentRoot),
        error: error.message || String(error),
      };
    }
  };

  const inspect = id => {
    const definition = COMPONENT_DEFINITIONS[id];
    if (!definition) return null;
    let incompatible = null;
    for (const root of roots) {
      const result = inspectAt(definition, root);
      if (!result) continue;
      if (result.installed) return result;
      incompatible ||= result;
    }
    return incompatible || {
      ...definition,
      installed: false,
      compatible: true,
      version: '',
      path: path.join(installRoot, id),
      source: 'missing',
      sizeBytes: 0,
    };
  };

  const list = () => Object.keys(COMPONENT_DEFINITIONS).map(inspect);
  const resolve = id => {
    const component = inspect(id);
    return component?.installed ? component : null;
  };
  const ensureInstallRoot = () => {
    fs.mkdirSync(installRoot, { recursive: true });
    return installRoot;
  };

  return { inspect, list, resolve, ensureInstallRoot, installRoot, roots };
};

module.exports = { COMPONENT_API_VERSION, COMPONENT_DEFINITIONS, createComponentRegistry };
