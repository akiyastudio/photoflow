const path = require('node:path');

const MEDIA_EXTENSIONS = Object.freeze(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mpg', 'mpeg', 'mts', 'm2ts', 'wmv', 'flv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma']);
const MEDIA_EXTENSION_SET = new Set(MEDIA_EXTENSIONS.map(value => `.${value}`));
const TERMINAL_STATES = new Set(['completed', 'partial_failure', 'failed', 'cancelled']);
const WHISPER_MODELS = Object.freeze([
  { id: 'tiny', label: 'Tiny', category: '最快' }, { id: 'tiny.en', label: 'Tiny English', category: '英语专用' },
  { id: 'base', label: 'Base', category: '轻量' }, { id: 'base.en', label: 'Base English', category: '英语专用' },
  { id: 'small', label: 'Small', category: '平衡' }, { id: 'small.en', label: 'Small English', category: '英语专用' },
  { id: 'medium', label: 'Medium', category: '高质量' }, { id: 'medium.en', label: 'Medium English', category: '英语专用' },
  { id: 'large-v1', label: 'Large V1', category: '高质量' }, { id: 'large-v2', label: 'Large V2', category: '高质量' },
  { id: 'large-v3', label: 'Large V3', category: '最高质量' }, { id: 'large-v3-turbo', label: 'Large V3 Turbo', category: '推荐' },
  { id: 'distil-large-v2', label: 'Distil Large V2', category: '英语高速' }, { id: 'distil-large-v3', label: 'Distil Large V3', category: '英语高速' },
  { id: 'distil-medium.en', label: 'Distil Medium English', category: '英语高速' }, { id: 'distil-small.en', label: 'Distil Small English', category: '英语高速' },
]);
const WHISPER_MODEL_IDS = new Set(WHISPER_MODELS.map(item => item.id));
const DEFAULT_SETTINGS = Object.freeze({ language: 'zh', model: 'large-v3', device: 'cuda', computeType: 'float16', beamSize: 5, vadFilter: true, simplifyChinese: true, cpuFallback: true });

const cleanName = value => path.basename(String(value || '').replace(/\\/g, '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').trim().slice(0, 255) || 'media';
const cleanRelativeName = value => {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').map(cleanName);
  return parts.join('/').slice(0, 1024) || 'media';
};
const isSupportedMediaName = value => MEDIA_EXTENSION_SET.has(path.posix.extname(String(value || '').replace(/\\/g, '/')).toLowerCase());
const normalizeDialogInputs = inputs => {
  const seen = new Set();
  return (Array.isArray(inputs) ? inputs : []).flatMap(item => {
    const token = String(item?.token || '');
    const relativeName = cleanRelativeName(item?.relativeName || item?.name);
    if (!token.startsWith('component-input:') && !token.startsWith('test-input:')) return [];
    if (!isSupportedMediaName(relativeName)) return [];
    const key = `${token}\0${relativeName.toLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ token, name: cleanName(item?.name || relativeName), relativeName }];
  });
};
const normalizeSettings = value => {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawLanguage = Object.hasOwn(input, 'language') ? input.language : DEFAULT_SETTINGS.language;
  const language = rawLanguage === null ? '' : String(rawLanguage).trim().slice(0, 16);
  const requestedModel = String(input.model ?? DEFAULT_SETTINGS.model).trim();
  const model = WHISPER_MODEL_IDS.has(requestedModel) ? requestedModel : DEFAULT_SETTINGS.model;
  const device = ['auto', 'cpu', 'cuda'].includes(input.device) ? input.device : DEFAULT_SETTINGS.device;
  const allowedCompute = new Set(['default', 'int8', 'int8_float16', 'float16', 'float32']);
  const computeType = allowedCompute.has(input.computeType) ? input.computeType : (device === 'cpu' ? 'int8' : DEFAULT_SETTINGS.computeType);
  const beamSize = Math.min(10, Math.max(1, Number(input.beamSize) || DEFAULT_SETTINGS.beamSize));
  return { language: language === 'auto' ? null : language || null, model, device, computeType, beamSize, vadFilter: input.vadFilter !== false, simplifyChinese: input.simplifyChinese !== false, cpuFallback: input.cpuFallback !== false };
};
const redactError = (value, { optional = false } = {}) => {
  const raw = value instanceof Error ? value.message : value?.message ?? value;
  if (optional && (raw === null || raw === undefined || String(raw).trim() === '')) return '';
  return String(raw || '未知错误')
    .replace(/[A-Za-z]:\\[^\r\n"']+/g, '[私有路径]')
    .replace(/\\\\[^\r\n"']+/g, '[私有路径]')
    .replace(/\/(?:Users|home|tmp|var|private)\/[^\r\n"']+/g, '[私有路径]')
    .split(/\r?\n/)[0].slice(0, 500);
};
const srtNameFor = value => cleanRelativeName(value).replace(/\.[^.\/]+$/, '') + '.srt';
const parseTimestamp = value => {
  const match = String(value || '').trim().match(/^(\d{1,}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
};
const parseSrt = value => {
  const normalized = String(value || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const segments = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim() || '')) lines.shift();
    const timing = lines.shift()?.match(/^\s*(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})/);
    if (!timing) continue;
    const start = parseTimestamp(timing[1]); const end = parseTimestamp(timing[2]);
    const text = lines.join('\n').trim();
    if (start === null || end === null || !text) continue;
    segments.push({ seq: segments.length + 1, start, end, text });
  }
  return segments;
};
const publicFile = file => ({
  id: file.id, operationId: file.operationId, ordinal: file.ordinal, displayName: file.displayName,
  relativeName: file.relativeName, sourceKind: file.sourceKind, state: file.state,
  progress: Number(file.progress) || 0, error: redactError(file.error, { optional: true }), language: file.language || '',
  segmentCount: Number(file.segmentCount) || 0, updatedAt: Number(file.updatedAt) || 0, output: file.output ? { ...file.output } : {},
});
const operationSnapshot = (operation, includeFiles = true) => operation ? {
  id: operation.id, state: operation.state, sourceKind: operation.sourceKind, total: operation.files.length,
  succeeded: operation.files.filter(file => file.state === 'completed').length,
  failed: operation.files.filter(file => file.state === 'failed').length,
  createdAt: operation.createdAt, updatedAt: operation.updatedAt,
  error: redactError(operation.error, { optional: true }), terminal: TERMINAL_STATES.has(operation.state),
  ...(includeFiles ? { files: operation.files.map(publicFile) } : {}),
} : null;

module.exports = { MEDIA_EXTENSIONS, MEDIA_EXTENSION_SET, TERMINAL_STATES, WHISPER_MODELS, WHISPER_MODEL_IDS, DEFAULT_SETTINGS, cleanName, cleanRelativeName, isSupportedMediaName, normalizeDialogInputs, normalizeSettings, redactError, srtNameFor, parseTimestamp, parseSrt, publicFile, operationSnapshot };
