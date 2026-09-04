const { PLUGIN_DEFINITIONS, findPluginByCapability } = require('../plugins/plugin-catalog.cjs');
const { legacyRuntimeCommandCapability } = require('../compatibility/legacy-runtime-capabilities.cjs');
const { createJsonCommandRunner } = require('./json-command-runner.cjs');

const createPluginService = ({ app, registry, runJsonCommand, processSupervisor = null }) => {
  let componentRunSequence = 0;
  const runComponentJsonCommand = processSupervisor ? createJsonCommandRunner({ spawnJob: run => processSupervisor.launch({
    id: `component-runtime:${run.componentId}:${++componentRunSequence}`, kind: 'component-runtime', owner: { componentId: run.componentId },
    command: run.command, args: run.args, options: { stdio: ['ignore', 'pipe', 'pipe'] }, ephemeral: true,
  }).child }) : (run, ...args) => {
    const { componentId: _componentId, ...legacyRun } = run;
    return runJsonCommand(legacyRun, ...args);
  };
  const componentForCapability = capability => registry.list().find(component => component?.installed
    && component.enabled !== false
    && component.compatible
    && (component.capabilities || []).includes(String(capability))) || null;
  const runtimeCapability = capability => {
    const component = componentForCapability(capability);
    if (!component) {
      const error = new Error(`未安装提供该运行时能力的组件：${capability}`);
      error.code = 'PLUGIN_MISSING';
      throw error;
    }
    const declaration = component.manifest?.runtimeCommandCapabilities?.[capability] || legacyRuntimeCommandCapability(component.id, capability);
    if (!declaration || !Array.isArray(declaration.argsPrefix) || declaration.argsPrefix.some(value => typeof value !== 'string' || /\0/.test(value))) {
      throw new Error(`组件未声明有效的运行时命令能力：${capability}`);
    }
    return { component, declaration };
  };
  const componentRuntimeCapability = (componentId, capability) => {
    const component = registry.resolve(String(componentId || ''), { verifyIntegrity: app.isPackaged });
    if (!component || !(component.capabilities || []).includes(String(capability))) {
      const error = new Error(`组件未声明运行时能力：${capability}`); error.code = 'PLUGIN_MISSING'; throw error;
    }
    const declaration = component.manifest?.runtimeCommandCapabilities?.[capability] || legacyRuntimeCommandCapability(component.id, capability);
    if (!declaration || !Array.isArray(declaration.argsPrefix) || declaration.argsPrefix.some(value => typeof value !== 'string' || /\0/.test(value))) throw new Error(`组件未声明有效的运行时命令能力：${capability}`);
    return { component, declaration };
  };
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
    if (!plugin?.installed || plugin.enabled === false) {
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
    resolveRunConfigForCapability: (capability, args = []) => {
      const { component, declaration } = runtimeCapability(capability);
      return resolveRunConfig(component.id, [...declaration.argsPrefix, ...args]);
    },
    runJsonForCapability: (capability, args, timeoutMs, onMessage, signal, requestedDeadlineAt) => {
      const { component, declaration } = runtimeCapability(capability);
      return runComponentJsonCommand({ ...resolveRunConfig(component.id, [...declaration.argsPrefix, ...(args || [])]), componentId: component.id }, `Component capability ${capability}`, timeoutMs, onMessage, signal, requestedDeadlineAt);
    },
    runJsonForComponentCapability: (componentId, capability, args, timeoutMs, onMessage, signal, requestedDeadlineAt) => {
      const { component, declaration } = componentRuntimeCapability(componentId, capability);
      return runComponentJsonCommand({ ...resolveRunConfig(component.id, [...declaration.argsPrefix, ...(args || [])]), componentId: component.id }, `Component runtime ${capability}`, timeoutMs, onMessage, signal, requestedDeadlineAt);
    },
    verifyComponentDirectory: (pluginId, componentRoot, force = true) => registry.verifyDirectory(pluginId, componentRoot, force),
    verifyComponentDirectoryAsync: (pluginId, componentRoot, force = true) => registry.verifyDirectoryAsync(pluginId, componentRoot, force),
    componentIntegrityToken: (pluginId, componentRoot) => registry.componentIntegrityToken(pluginId, componentRoot),
    seedIntegrityToken: (pluginId, componentRoot, token) => registry.seedIntegrityToken(pluginId, componentRoot, token),
    setComponentEnabled: (pluginId, enabled) => registry.setComponentEnabled(pluginId, enabled),
    clearComponentEnabledState: pluginId => registry.clearComponentEnabledState(pluginId),
    requireCapability,
    runJson: (pluginId, args, timeoutMs, onMessage, signal, requestedDeadlineAt) => runComponentJsonCommand(
      { ...resolveRunConfig(pluginId, args), componentId: pluginId }, `Plugin ${pluginId}`, timeoutMs, onMessage, signal, requestedDeadlineAt,
    ),
    installRoot: registry.installRoot,
    ensureInstallRoot: () => registry.ensureInstallRoot(),
  };
};

module.exports = { createPluginService };
