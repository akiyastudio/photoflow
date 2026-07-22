const PLUGIN_API_VERSION = 1;

const PLUGIN_DEFINITIONS = Object.freeze({
  'team-retouch': {
    id: 'team-retouch',
    name: '多人裁片修图',
    description: '人物检测、无损裁片、高分辨率 Patch 对齐、融合与拼回。',
    capabilities: ['team-retouch.detect', 'team-retouch.merge'],
    developmentEntry: ['components', 'team-retouch', 'team_retouch.py'],
    requiredAssets: [['models', 'person_detection_mediapipe_2023mar.onnx']],
  },
  'research-tools': {
    id: 'research-tools',
    name: '调研整理',
    description: '视频分镜识别、图片去重与调研资料整理。',
    capabilities: ['research.organize'],
    developmentEntry: ['python', 'research.py'],
  },
});

const findPluginByCapability = capability => Object.values(PLUGIN_DEFINITIONS)
  .find(definition => definition.capabilities.includes(capability));

module.exports = { PLUGIN_API_VERSION, PLUGIN_DEFINITIONS, findPluginByCapability };
