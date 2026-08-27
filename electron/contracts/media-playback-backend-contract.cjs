const PLAYBACK_BACKEND_CONTRIBUTION_TYPE = 'media.playbackBackend';
const PLAYBACK_BACKEND_PROTOCOL_VERSION = 1;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const EXTENSION = /^\.[a-z0-9]{1,12}$/;

const parseMediaPlaybackBackendContributions = manifest => {
  const values = Array.isArray(manifest?.runtimeContributions) ? manifest.runtimeContributions : [];
  const seen = new Set();
  return values.filter(value => value?.type === PLAYBACK_BACKEND_CONTRIBUTION_TYPE).map(value => {
    const unknown = Object.keys(value).filter(field => !['type', 'protocolVersion', 'backendId', 'transport', 'priority', 'probe'].includes(field));
    if (unknown.length) throw new Error(`Unknown media playback backend field: ${unknown[0]}`);
    if (Number(value.protocolVersion) !== PLAYBACK_BACKEND_PROTOCOL_VERSION) throw new Error(`Unsupported media playback backend protocol: ${value.protocolVersion}`);
    const backendId = String(value.backendId || '');
    if (!IDENTIFIER.test(backendId) || seen.has(backendId)) throw new Error('Invalid or duplicate media playback backendId');
    seen.add(backendId);
    if (value.transport !== 'native-process-v1') throw new Error(`Unsupported media playback backend transport: ${value.transport}`);
    const priority = Number(value.priority);
    if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) throw new Error('Invalid media playback backend priority');
    const probe = value.probe;
    if (!probe || typeof probe !== 'object' || Array.isArray(probe) || Object.keys(probe).some(field => field !== 'extensions')) throw new Error('Invalid media playback backend probe');
    const extensions = Array.isArray(probe?.extensions) ? probe.extensions.map(item => String(item).toLowerCase()) : [];
    if (!extensions.length || extensions.length > 64 || extensions.some(item => !EXTENSION.test(item)) || new Set(extensions).size !== extensions.length) throw new Error('Invalid media playback backend probe extensions');
    return Object.freeze({
      type: PLAYBACK_BACKEND_CONTRIBUTION_TYPE,
      protocolVersion: PLAYBACK_BACKEND_PROTOCOL_VERSION,
      backendId,
      transport: value.transport,
      priority,
      probe: Object.freeze({ extensions: Object.freeze(extensions) }),
    });
  });
};

module.exports = { PLAYBACK_BACKEND_CONTRIBUTION_TYPE, PLAYBACK_BACKEND_PROTOCOL_VERSION, parseMediaPlaybackBackendContributions };
