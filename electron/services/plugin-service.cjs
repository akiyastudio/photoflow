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
    const plugin = registry.resolve(pluginId);
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
        version: 'development',
        path: path.dirname(development.args[1]),
        source: 'development',
        sizeBytes: 0,
      };
    }
    return registry.inspect(pluginId);
  };

  const list = () => Object.keys(PLUGIN_DEFINITIONS).map(inspect);
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
    listWithSizes: async () => app.isPackaged ? registry.listWithSizes() : list(),
    resolveRunConfig,
    requireCapability,
    runJson: (pluginId, args, timeoutMs) => runJsonCommand(resolveRunConfig(pluginId, args), `Plugin ${pluginId}`, timeoutMs),
    installRoot: registry.installRoot,
    ensureInstallRoot: () => registry.ensureInstallRoot(),
  };
};

module.exports = { createPluginService };
