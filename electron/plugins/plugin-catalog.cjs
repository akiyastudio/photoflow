const PLUGIN_API_VERSION = 1;

const PLUGIN_DEFINITIONS = Object.freeze({
  'team-retouch': {
    id: 'team-retouch',
    version: '26.7.28.2',
    name: '团片协作',
    description: 'AI识别人后规划可合并的工作图，支持人物标记、确定性任务重建并自动合回原尺寸。',
    capabilities: ['team-retouch.detect', 'team-retouch.identify', 'team-retouch.merge'],
    developmentEntry: ['components', 'team-retouch', 'team_retouch.py'],
    requiredAssets: [['models', 'rtmdet-ins_m_640x640.onnx']],
  },
});

const findPluginByCapability = capability => Object.values(PLUGIN_DEFINITIONS)
  .find(definition => definition.capabilities.includes(capability));

module.exports = { PLUGIN_API_VERSION, PLUGIN_DEFINITIONS, findPluginByCapability };
