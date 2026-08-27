const { parseMediaPlaybackBackendContributions } = require('../contracts/media-playback-backend-contract.cjs');

// Compatibility is deliberately contained here. Published runtime-only
// packages before media.playbackBackend@v1 did not carry runtimeContributions.
const LEGACY_BACKEND_COMPONENT_ID = 'video-playback-mpv';
const LEGACY_BACKEND = Object.freeze({
  type: 'media.playbackBackend', protocolVersion: 1, backendId: 'advanced-video',
  transport: 'native-process-v1', priority: 80,
  probe: Object.freeze({ extensions: Object.freeze(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.mts', '.m2ts', '.webm']) }),
});

const supportRank = Object.freeze({ probably: 3, maybe: 2, unknown: 1, unsupported: 0 });
const normalizeBrowserProbe = value => ['probably', 'maybe', 'unsupported'].includes(value) ? value : 'unknown';

const createVideoPlaybackBroker = ({ pluginService, path }) => {
  const contributions = () => pluginService.list().flatMap(component => {
    if (!component?.installed || !component.compatible) return [];
    let declared = [];
    try { declared = parseMediaPlaybackBackendContributions(component.manifest); } catch { return []; }
    if (!declared.length && component.id === LEGACY_BACKEND_COMPONENT_ID) declared = [LEGACY_BACKEND];
    return declared.map(contribution => ({ component, contribution, backendId: `${component.id}:${contribution.backendId}` }));
  });

  const listDescriptors = async (filePath, browserProbe) => {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    const chromiumSupport = normalizeBrowserProbe(browserProbe);
    const descriptors = [{
      backendId: 'core.chromium', protocolVersion: 1, transport: 'chromium',
      displayName: 'Chromium', priority: 100, probe: { support: chromiumSupport, basis: 'html-media-can-play-type' },
    }];
    for (const item of contributions()) {
      const support = item.contribution.probe.extensions.includes(extension) ? 'probably' : 'maybe';
      descriptors.push({
        backendId: item.backendId,
        protocolVersion: item.contribution.protocolVersion,
        transport: item.contribution.transport,
        displayName: item.component.name || item.contribution.backendId,
        priority: item.contribution.priority,
        probe: { support, basis: 'manifest-container-probe' },
      });
    }
    return descriptors.filter(item => item.probe.support !== 'unsupported')
      .sort((left, right) => supportRank[right.probe.support] - supportRank[left.probe.support] || right.priority - left.priority || left.backendId.localeCompare(right.backendId));
  };

  const resolveRunConfigAsync = async (backendId, args) => {
    const match = contributions().find(item => item.backendId === backendId);
    if (!match) {
      const error = new Error('视频播放后端不可用或已经变更');
      error.code = 'PLAYBACK_BACKEND_MISSING';
      throw error;
    }
    return pluginService.resolveRunConfigAsync(match.component.id, args);
  };

  const defaultBackendId = () => contributions()[0]?.backendId || '';

  return { listDescriptors, resolveRunConfigAsync, defaultBackendId };
};

module.exports = { createVideoPlaybackBroker };
