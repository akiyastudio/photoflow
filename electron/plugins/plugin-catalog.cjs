const PLUGIN_API_VERSION = 1;
const { LEGACY_PLUGIN_DEFINITIONS } = require('../compatibility/component-v1-metadata.cjs');

const PLUGIN_DEFINITIONS = Object.freeze({
  ...LEGACY_PLUGIN_DEFINITIONS,
  'video-playback-mpv': {
    id: 'video-playback-mpv',
    runtimeOnly: true,
    version: '26.8.16.1',
    name: '视频播放器',
    description: '使用独立 libmpv 进程、硬件解码和预读缓存播放相机原始视频。',
    // Legacy capability token retained for already published package metadata.
    capabilities: ['video-playback.advanced'],
    integrityManifest: 'video-playback-mpv-integrity.json',
  },
});

const findPluginByCapability = capability => Object.values(PLUGIN_DEFINITIONS)
  .find(definition => definition.capabilities.includes(capability));

module.exports = { PLUGIN_API_VERSION, PLUGIN_DEFINITIONS, findPluginByCapability };
