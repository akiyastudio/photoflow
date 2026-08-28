const { parseMediaPlaybackBackendContributions } = require('../contracts/media-playback-backend-contract.cjs');

const supportRank = Object.freeze({ probably: 3, maybe: 2, unknown: 1, unsupported: 0 });
const normalizeBrowserProbe = value => ['probably', 'maybe', 'unsupported'].includes(value) ? value : 'unknown';
const CHROMIUM_FEATURES = Object.freeze({
  transforms: Object.freeze(['source', 'contain', 'cover', '16:9', '4:3', '1:1', 'rotate', 'flip-horizontal', 'flip-vertical']),
  hdr: Object.freeze({ modes: Object.freeze(['auto', 'sdr', 'tone-map']), requiresHdrDisplay: false }),
  statistics: Object.freeze({ levels: Object.freeze(['basic']), maxUpdateHz: 4 }),
  subtitles: Object.freeze({ formats: Object.freeze(['vtt']), externalFiles: true }),
  hardwareDecoding: true,
  capture: Object.freeze({ supported: true, appliesTransforms: true }),
});

const createVideoPlaybackBroker = ({ pluginService, path }) => {
  const contributions = () => pluginService.list().flatMap(component => {
    if (!component?.installed || !component.compatible) return [];
    let declared = [];
    try { declared = parseMediaPlaybackBackendContributions(component.manifest); } catch { return []; }
    return declared.map(contribution => ({ component, contribution, backendId: `${component.id}:${contribution.backendId}` }));
  });

  const listDescriptors = async (filePath, browserProbe) => {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    const chromiumSupport = normalizeBrowserProbe(browserProbe);
    const descriptors = [{
      backendId: 'core.chromium', protocolVersion: 1, transport: 'chromium',
      displayName: 'Chromium', priority: 100,
      probe: { support: chromiumSupport, basis: 'html-media-can-play-type', containers: [], codecs: { video: [], audio: [] }, extensions: [extension].filter(Boolean) },
      features: CHROMIUM_FEATURES,
    }];
    for (const item of contributions()) {
      // A declared extension proves only that the backend accepts the
      // container family; it says nothing about the file's actual codec.
      const support = item.contribution.probe.extensions.includes(extension) ? 'maybe' : 'unknown';
      descriptors.push({
        backendId: item.backendId,
        protocolVersion: item.contribution.protocolVersion,
        transport: item.contribution.transport,
        displayName: item.component.name || item.contribution.backendId,
        priority: item.contribution.priority,
        probe: { support, basis: 'manifest-extension-hint', ...item.contribution.probe },
        features: item.contribution.features,
      });
    }
    const chromiumHasCapabilitySignal = chromiumSupport === 'probably' || chromiumSupport === 'maybe';
    return descriptors.filter(item => item.probe.support !== 'unsupported')
      .sort((left, right) => {
        // Manifest priority compares contributed backends only. A container
        // extension hint may never outrank a positive Chromium capability signal.
        if (chromiumHasCapabilitySignal && left.transport !== right.transport) return left.transport === 'chromium' ? -1 : 1;
        return supportRank[right.probe.support] - supportRank[left.probe.support]
          || right.priority - left.priority
          || left.backendId.localeCompare(right.backendId);
      });
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
