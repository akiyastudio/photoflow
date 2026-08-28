const PLAYBACK_BACKEND_CONTRIBUTION_TYPE = 'media.playbackBackend';
const PLAYBACK_BACKEND_PROTOCOL_VERSION = 1;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXTENSION = /^\.[a-z0-9]{1,12}$/;
const MEDIA_TOKEN = /^[a-z0-9][a-z0-9.+_-]{0,63}$/i;
const HDR_MODES = new Set(['auto', 'sdr', 'hdr-passthrough', 'tone-map']);
const TRANSFORMS = new Set(['source', 'contain', 'cover', '16:9', '4:3', '1:1', 'rotate', 'flip-horizontal', 'flip-vertical']);
const STATISTICS_LEVELS = new Set(['basic', 'detailed']);
const SUBTITLE_FORMATS = new Set(['vtt', 'srt', 'ass', 'ssa']);

const exactObject = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid media playback backend ${label}`);
  const unknown = Object.keys(value).filter(field => !allowed.includes(field));
  if (unknown.length) throw new Error(`Unknown media playback backend ${label} field: ${unknown[0]}`);
  return value;
};
const boundedUniqueStrings = (value, { label, pattern = MEDIA_TOKEN, allowed = null, min = 1, max = 64 }) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid media playback backend ${label}`);
  const result = value.map(item => String(item).toLowerCase());
  if (new Set(result).size !== result.length || result.some(item => allowed ? !allowed.has(item) : !pattern.test(item))) throw new Error(`Invalid media playback backend ${label}`);
  return Object.freeze(result);
};

const parseFeatures = value => {
  const raw = exactObject(value, ['transforms', 'hdr', 'statistics', 'subtitles', 'hardwareDecoding', 'capture'], 'features');
  const hdr = exactObject(raw.hdr, ['modes', 'requiresHdrDisplay'], 'HDR features');
  const statistics = exactObject(raw.statistics, ['levels', 'maxUpdateHz'], 'statistics features');
  const subtitles = exactObject(raw.subtitles, ['formats', 'externalFiles'], 'subtitle features');
  const capture = exactObject(raw.capture, ['supported', 'appliesTransforms'], 'capture features');
  const maxUpdateHz = Number(statistics.maxUpdateHz);
  if (!Number.isFinite(maxUpdateHz) || maxUpdateHz < 0.2 || maxUpdateHz > 30) throw new Error('Invalid media playback backend statistics maxUpdateHz');
  if (typeof raw.hardwareDecoding !== 'boolean' || typeof hdr.requiresHdrDisplay !== 'boolean' || typeof subtitles.externalFiles !== 'boolean' || typeof capture.supported !== 'boolean' || typeof capture.appliesTransforms !== 'boolean') throw new Error('Invalid media playback backend feature flag');
  return Object.freeze({
    transforms: boundedUniqueStrings(raw.transforms, { label: 'transforms', allowed: TRANSFORMS }),
    hdr: Object.freeze({ modes: boundedUniqueStrings(hdr.modes, { label: 'HDR modes', allowed: HDR_MODES }), requiresHdrDisplay: hdr.requiresHdrDisplay }),
    statistics: Object.freeze({ levels: boundedUniqueStrings(statistics.levels, { label: 'statistics levels', allowed: STATISTICS_LEVELS }), maxUpdateHz }),
    subtitles: Object.freeze({ formats: boundedUniqueStrings(subtitles.formats, { label: 'subtitle formats', allowed: SUBTITLE_FORMATS }), externalFiles: subtitles.externalFiles }),
    hardwareDecoding: raw.hardwareDecoding,
    capture: Object.freeze({ supported: capture.supported, appliesTransforms: capture.appliesTransforms }),
  });
};

const parseMediaPlaybackBackendContributions = manifest => {
  const values = Array.isArray(manifest?.runtimeContributions) ? manifest.runtimeContributions : [];
  const seen = new Set();
  return values.filter(value => value?.type === PLAYBACK_BACKEND_CONTRIBUTION_TYPE).map(value => {
    exactObject(value, ['type', 'protocolVersion', 'backendId', 'displayName', 'backendVersion', 'transport', 'priority', 'probe', 'features'], 'contribution');
    if (Number(value.protocolVersion) !== PLAYBACK_BACKEND_PROTOCOL_VERSION) throw new Error(`Unsupported media playback backend protocol: ${value.protocolVersion}`);
    const backendId = String(value.backendId || '');
    if (!IDENTIFIER.test(backendId) || seen.has(backendId)) throw new Error('Invalid or duplicate media playback backendId');
    seen.add(backendId);
    const displayName = String(value.displayName || '').trim(); if (!displayName || displayName.length > 120) throw new Error('Invalid media playback backend displayName');
    const backendVersion = String(value.backendVersion || ''); if (!SEMVER.test(backendVersion)) throw new Error('Invalid media playback backend backendVersion');
    if (value.transport !== 'media-playback-backend-v1') throw new Error(`Unsupported media playback backend transport: ${value.transport}`);
    const priority = Number(value.priority);
    if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) throw new Error('Invalid media playback backend priority');
    const probe = exactObject(value.probe, ['containers', 'codecs', 'extensions'], 'probe');
    const codecs = exactObject(probe.codecs, ['video', 'audio'], 'codec probe');
    return Object.freeze({
      type: PLAYBACK_BACKEND_CONTRIBUTION_TYPE,
      protocolVersion: PLAYBACK_BACKEND_PROTOCOL_VERSION,
      backendId,
      displayName,
      backendVersion,
      transport: value.transport,
      priority,
      probe: Object.freeze({
        containers: boundedUniqueStrings(probe.containers, { label: 'containers' }),
        codecs: Object.freeze({
          video: boundedUniqueStrings(codecs.video, { label: 'video codecs', min: 0 }),
          audio: boundedUniqueStrings(codecs.audio, { label: 'audio codecs', min: 0 }),
        }),
        extensions: boundedUniqueStrings(probe.extensions, { label: 'extensions', pattern: EXTENSION }),
      }),
      features: parseFeatures(value.features),
    });
  });
};

module.exports = { PLAYBACK_BACKEND_CONTRIBUTION_TYPE, PLAYBACK_BACKEND_PROTOCOL_VERSION, parseMediaPlaybackBackendContributions };
