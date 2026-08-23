const fs = require('fs');
const path = require('path');
const { PLUGIN_DEFINITIONS, findPluginByCapability } = require('../plugins/plugin-catalog.cjs');

const createPluginService = ({ app, projectRoot, registry, getDevelopmentPython, runJsonCommand }) => {
  const developmentRunConfig = (pluginId, args = []) => {
    const definition = PLUGIN_DEFINITIONS[pluginId];
    if (!definition?.developmentEntry) return null;
    const scriptPath = path.join(projectRoot, ...definition.developmentEntry);
    if (!fs.existsSync(scriptPath)) return null;
    for (const asset of definition.requiredAssets || []) {
      if (!fs.existsSync(path.join(path.dirname(scriptPath), ...asset))) return null;
    }
    return { command: getDevelopmentPython(), args: ['-u', scriptPath, ...args] };
  };

  const resolveRunConfig = (pluginId, args = []) => {
    if (!app.isPackaged) {
      const development = developmentRunConfig(pluginId, args);
      if (development) return development;
    }
    const plugin = registry.resolve(pluginId, { verifyIntegrity: app.isPackaged });
    if (!plugin) {
      const error = new Error(`未安装插件：${PLUGIN_DEFINITIONS[pluginId]?.name || pluginId}`);
      error.code = 'PLUGIN_MISSING';
      throw error;
    }
    return { command: plugin.command, args: [...plugin.argsPrefix, ...args] };
  };
  const resolveRunConfigAsync = async (pluginId, args = []) => {
    if (!app.isPackaged) {
      const development = developmentRunConfig(pluginId, args);
      if (development) return development;
    }
    const plugin = await registry.resolveAsync(pluginId, { verifyIntegrity: app.isPackaged });
    if (!plugin) {
      const error = new Error(`未安装插件：${PLUGIN_DEFINITIONS[pluginId]?.name || pluginId}`);
      error.code = 'PLUGIN_MISSING';
      throw error;
    }
    return { command: plugin.command, args: [...plugin.argsPrefix, ...args] };
  };

  const inspect = pluginId => {
    if (!app.isPackaged) {
      const development = developmentRunConfig(pluginId, []);
      if (development) return {
        ...PLUGIN_DEFINITIONS[pluginId],
        capability: PLUGIN_DEFINITIONS[pluginId].capabilities[0],
        installed: true,
        compatible: true,
        version: PLUGIN_DEFINITIONS[pluginId].version || 'development',
        path: path.dirname(development.args[1]),
        source: 'development',
        sizeBytes: 0,
      };
    }
    return registry.inspect(pluginId, { verifyIntegrity: false });
  };

  // The registry owns discovery. Static definitions are only runtime compatibility
  // metadata and must never manufacture settings rows for absent components.
  const list = () => registry.list();
  const requireCapability = capability => {
    const definition = findPluginByCapability(capability);
    if (!definition) throw new Error(`未知插件能力：${capability}`);
    const plugin = inspect(definition.id);
    if (!plugin?.installed) {
      const error = new Error(`未安装“${definition.name}”插件`);
      error.code = 'PLUGIN_MISSING';
      throw error;
    }
    return plugin;
  };

  return {
    inspect,
    list,
    listWithSizes: () => registry.listWithSizes(),
    resolvePackage: pluginId => registry.resolvePackage(pluginId),
    resolveRunConfig,
    resolveRunConfigAsync,
    verifyComponentDirectory: (pluginId, componentRoot, force = true) => registry.verifyDirectory(pluginId, componentRoot, force),
    verifyComponentDirectoryAsync: (pluginId, componentRoot, force = true) => registry.verifyDirectoryAsync(pluginId, componentRoot, force),
    componentIntegrityToken: (pluginId, componentRoot) => registry.componentIntegrityToken(pluginId, componentRoot),
    seedIntegrityToken: (pluginId, componentRoot, token) => registry.seedIntegrityToken(pluginId, componentRoot, token),
    requireCapability,
    runJson: (pluginId, args, timeoutMs, onMessage) => runJsonCommand(resolveRunConfig(pluginId, args), `Plugin ${pluginId}`, timeoutMs, onMessage),
    installRoot: registry.installRoot,
    ensureInstallRoot: () => registry.ensureInstallRoot(),
  };
};

module.exports = { createPluginService };
