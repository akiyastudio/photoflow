const { PLUGIN_DEFINITIONS, findPluginByCapability } = require('../plugins/plugin-catalog.cjs');

const createPluginService = ({ app, registry, runJsonCommand }) => {
  const resolveRunConfig = (pluginId, args = []) => {
    const plugin = registry.resolve(pluginId, { verifyIntegrity: app.isPackaged });
    if (!plugin) {
      const error = new Error(`未安装插件：${PLUGIN_DEFINITIONS[pluginId]?.name || pluginId}`);
      error.code = 'PLUGIN_MISSING';
      throw error;
    }
    return { command: plugin.command, args: [...plugin.argsPrefix, ...args] };
  };
  const resolveRunConfigAsync = async (pluginId, args = []) => {
    const plugin = await registry.resolveAsync(pluginId, { verifyIntegrity: app.isPackaged });
    if (!plugin) {
      const error = new Error(`未安装插件：${PLUGIN_DEFINITIONS[pluginId]?.name || pluginId}`);
      error.code = 'PLUGIN_MISSING';
      throw error;
    }
    return { command: plugin.command, args: [...plugin.argsPrefix, ...args] };
  };

  const inspect = pluginId => {
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
