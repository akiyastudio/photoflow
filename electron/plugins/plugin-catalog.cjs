const PLUGIN_API_VERSION = 1;

const PLUGIN_DEFINITIONS = Object.freeze({
  'team-retouch': {
    id: 'team-retouch',
    version: '26.7.30.1',
    name: '团片协作',
    description: 'AI识别人后规划可合并的工作图，支持人物标记、确定性任务重建并自动合回原尺寸。',
    capabilities: ['team-retouch.detect', 'team-retouch.identify', 'team-retouch.merge'],
    developmentEntry: ['extensions', 'team-retouch', 'team_retouch.py'],
    requiredAssets: [['models', 'rtmdet-ins_m_640x640.onnx']],
  },
  'video-playback-mpv': {
    id: 'video-playback-mpv',
    runtimeOnly: true,
    version: '26.8.16.1',
    name: '高级视频解码',
    description: '使用独立 libmpv 进程、硬件解码和预读缓存播放相机原始视频。',
    capabilities: ['video-playback.advanced'],
    integrityManifest: 'video-playback-mpv-integrity.json',
  },
});

const findPluginByCapability = capability => Object.values(PLUGIN_DEFINITIONS)
  .find(definition => definition.capabilities.includes(capability));

module.exports = { PLUGIN_API_VERSION, PLUGIN_DEFINITIONS, findPluginByCapability };
