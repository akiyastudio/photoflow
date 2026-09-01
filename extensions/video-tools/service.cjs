const readline = require('readline');

const pendingCapabilities = new Map();
const activeOperations = new Map();
let nextCapabilityId = 1;
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const callHost = (parentId, method, payload) => new Promise((resolve, reject) => {
  const id = `cap-${nextCapabilityId++}`;
  pendingCapabilities.set(id, { resolve, reject });
  send({ type: 'capability', id, parentId, method, payload });
});
const defaults = Object.freeze({ container: 'mp4', videoMode: 'h264', quality: 'balanced', resolution: 'original', frameRate: 'original', audioMode: 'aac', subtitleMode: 'copy', colorMode: 'auto', bitDepth: 'auto', frameRateMode: 'preserve', rotation: 'auto', aspectMode: 'preserve', audioTrack: 'all', videoBitrateMbps: null, audioBitrateKbps: 192, encoderPreset: 'balanced' });
const normalizeSettings = value => ({ ...defaults, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}), retryCount: 1 });
const normalizePresets = value => (Array.isArray(value) ? value : []).slice(0, 30).flatMap(item => {
  const id = typeof item?.id === 'string' ? item.id.slice(0, 80) : '';
  const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 40) : '';
  return id && name && item?.settings && typeof item.settings === 'object' && !Array.isArray(item.settings)
    ? [{ id, name, settings: normalizeSettings(item.settings) }]
    : [];
});
const paths = payload => [...new Set((Array.isArray(payload?.relativePaths) ? payload.relativePaths : []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 120);
const transcodeArgs = (settings, extras = []) => {
  const value = normalizeSettings(settings); const text = (field, allowed, fallback) => allowed.includes(String(value[field] || '')) ? String(value[field]) : fallback;
  const bitrate = Number(value.videoBitrateMbps); const audioBitrate = Number(value.audioBitrateKbps);
  return ['--container', text('container', ['mp4', 'mov', 'mkv'], 'mp4'), '--video-mode', text('videoMode', ['h264', 'h265', 'av1', 'prores', 'copy'], 'h264'), '--quality', text('quality', ['high', 'balanced', 'small'], 'balanced'), '--resolution', text('resolution', ['original', '2160p', '1080p', '720p'], 'original'), '--frame-rate', text('frameRate', ['original', '24', '25', '30', '50', '60'], 'original'), '--audio-mode', text('audioMode', ['copy', 'aac', 'remove'], 'aac'), '--subtitle-mode', text('subtitleMode', ['copy', 'burn', 'remove'], 'copy'), '--color-mode', text('colorMode', ['auto', 'sdr', 'hdr10', 'hlg', 'hdr-to-sdr'], 'auto'), '--bit-depth', text('bitDepth', ['auto', '8', '10'], 'auto'), '--frame-rate-mode', text('frameRateMode', ['preserve', 'cfr', 'vfr'], 'preserve'), '--rotation', text('rotation', ['auto', '0', '90', '180', '270'], 'auto'), '--aspect-mode', text('aspectMode', ['preserve', 'square-pixels'], 'preserve'), '--audio-track', text('audioTrack', ['all', 'first'], 'all'), '--audio-bitrate-kbps', String([96, 128, 160, 192, 256, 320].includes(audioBitrate) ? audioBitrate : 192), '--encoder-preset', text('encoderPreset', ['fast', 'balanced', 'quality'], 'balanced'), '--retry-count', '1', ...(Number.isFinite(bitrate) && bitrate > 0 && bitrate <= 800 ? ['--video-bitrate-mbps', String(bitrate)] : []), ...extras];
};
const operationKey = (context, action) => `${context.projectId}:${action}`;

const handle = async frame => {
  const { id, method, payload = {}, context } = frame;
  if (method === 'video-tools.settings.get.v1') {
    const result = await callHost(id, 'component.settings', { action: 'get' });
    return { revision: result.revision, settings: normalizeSettings(result.settings?.transcode), presets: normalizePresets(result.settings?.transcodePresets) };
  }
  if (method === 'video-tools.sources.choose.v1') {
    const folder = payload.kind === 'folder'; const result = await callHost(id, 'dialogs', folder ? { kind: 'openDirectory', title: '追加视频文件夹', extensions: ['mp4','mov','m4v','mkv','avi','webm','crm','mts','m2ts','ts'], recursive: true, directoryToken: true } : { kind: 'openFiles', title: '追加视频', extensions: ['mp4','mov','m4v','mkv','avi','webm','crm','mts','m2ts','ts'], multiple: true });
    return { cancelled: result.cancelled === true, sources: (result.inputs || []).slice(0, 120).map(item => ({ token: item.token, name: item.relativeName || item.name, kind: item.kind === 'directory' ? 'folder' : 'file' })) };
  }
  if (method === 'video-tools.sources.preview.v1') return callHost(id, 'project.media.process', { action: 'video.sources.preview', relativePaths: paths(payload), inputTokens: Array.isArray(payload.inputTokens) ? payload.inputTokens.map(String).slice(0,120) : [] });
  if (method === 'video-tools.settings.update.v1') {
    const settings = normalizeSettings(payload.settings);
    const patch = { transcode: settings };
    if (Array.isArray(payload.presets)) patch.transcodePresets = normalizePresets(payload.presets);
    const result = await callHost(id, 'component.settings', { action: 'merge', settings: patch });
    return { revision: result.revision, settings, presets: normalizePresets(result.settings?.transcodePresets) };
  }
  if (method === 'video-tools.inspect.v1') return callHost(id, 'project.media.process', { action: 'video.transcode.inspect', relativePaths: paths(payload), inputTokens: Array.isArray(payload.inputTokens) ? payload.inputTokens.map(String).slice(0,120) : [], runtimeArgs: transcodeArgs(payload.settings, ['--inspect-only', '--skip-capability-probe']) });
  if (method === 'video-tools.transcode.v1' || method === 'video-tools.split.v1') {
    const processAction = method === 'video-tools.transcode.v1' ? 'video.transcode' : 'video.split';
    const idempotencyKey = String(payload.idempotencyKey || ''); const key = operationKey(context, processAction);
    activeOperations.set(key, { processAction, idempotencyKey, state: 'running' });
    try {
      const result = await callHost(id, 'project.media.process', processAction === 'video.transcode'
        ? { action: processAction, idempotencyKey, relativePaths: paths(payload), inputTokens: Array.isArray(payload.inputTokens) ? payload.inputTokens.map(String).slice(0,120) : [], runtimeArgs: transcodeArgs(payload.settings, ['--output-mode', payload.outputMode === 'delete-original' ? 'delete-original' : 'new']) }
        : { action: processAction, idempotencyKey, relativePaths: paths(payload), inputTokens: Array.isArray(payload.inputTokens) ? payload.inputTokens.map(String).slice(0,120) : [], runtimeArgs: [] });
      activeOperations.set(key, { processAction, idempotencyKey, state: 'completed', result }); return result;
    } catch (error) { activeOperations.set(key, { processAction, idempotencyKey, state: 'failed', error: error.message }); throw error; }
  }
  if (method === 'video-tools.operation.current.v1') {
    const processAction = payload.processAction === 'video.split' ? 'video.split' : 'video.transcode'; const current = activeOperations.get(operationKey(context, processAction));
    if (!current) return { operation: null };
    const status = await callHost(id, 'project.media.process', { action: 'status', processAction, idempotencyKey: current.idempotencyKey });
    return { operation: { ...current, task: status.task } };
  }
  if (method === 'video-tools.operation.control.v1') {
    const processAction = payload.processAction === 'video.split' ? 'video.split' : 'video.transcode'; const current = activeOperations.get(operationKey(context, processAction));
    if (!current) return { operation: null };
    const action = ['cancel', 'pause', 'resume'].includes(payload.action) ? payload.action : 'status';
    return callHost(id, 'project.media.process', { action, processAction, idempotencyKey: current.idempotencyKey });
  }
  throw new Error(`Unknown video tools method: ${method}`);
};

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === 'capability-response') { const pending = pendingCapabilities.get(frame.id); pendingCapabilities.delete(frame.id); if (frame.ok) pending?.resolve(frame.result); else pending?.reject(Object.assign(new Error(frame.error), { code: frame.errorCode })); return; }
  if (frame.type !== 'request') return;
  Promise.resolve().then(() => handle(frame)).then(result => send({ type: 'response', id: frame.id, ok: true, result })).catch(error => send({ type: 'response', id: frame.id, ok: false, error: error.message || String(error), errorCode: error.code || 'COMPONENT_SERVICE_FAILED' }));
});
send({ type: 'ready', protocolVersion: 1 });
