const PLUGIN_API_VERSION = 1;

const PLUGIN_DEFINITIONS = Object.freeze({
  'team-retouch': {
    id: 'team-retouch',
    version: '26.7.23.2',
    name: '多人修脸',
    description: 'AI识别人后规划可合并的工作图，支持批量常驻推理并自动合回原尺寸。',
    capabilities: ['team-retouch.detect', 'team-retouch.merge'],
    developmentEntry: ['components', 'team-retouch', 'team_retouch.py'],
    requiredAssets: [['models', 'rtmdet-ins_m_640x640.onnx']],
  },
  'research-tools': {
    id: 'research-tools',
    version: '26.7.23.1',
    name: '调研整理',
    description: '视频分镜识别、图片去重与调研资料整理。',
    capabilities: ['research.organize'],
    developmentEntry: ['python', 'research.py'],
  },
  'office-media-extractor': {
    id: 'office-media-extractor',
    version: '26.7.23.1',
    name: 'Office 图片提取',
    description: '从 Word、PowerPoint 和 Excel 文档中提取全部内嵌图片。',
    capabilities: ['office-media.extract'],
    developmentEntry: ['components', 'office-media-extractor', 'office_media_extractor.py'],
  },
});

const findPluginByCapability = capability => Object.values(PLUGIN_DEFINITIONS)
  .find(definition => definition.capabilities.includes(capability));

module.exports = { PLUGIN_API_VERSION, PLUGIN_DEFINITIONS, findPluginByCapability };
