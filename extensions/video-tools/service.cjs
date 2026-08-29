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
const paths = payload => [...new Set((Array.isArray(payload?.relativePaths) ? payload.relativePaths : []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 120);
const operationKey = (context, action) => `${context.projectId}:${action}`;

const handle = async frame => {
  const { id, method, payload = {}, context } = frame;
  if (method === 'video-tools.settings.get.v1') {
    const result = await callHost(id, 'component.settings.v7', { action: 'get' });
    return { revision: result.revision, settings: normalizeSettings(result.settings?.transcode) };
  }
  if (method === 'video-tools.sources.choose.v1') {
    const folder = payload.kind === 'folder'; const result = await callHost(id, 'dialogs.v7', folder ? { kind: 'openDirectory', title: '追加视频文件夹', extensions: ['mp4','mov','m4v','mkv','avi','webm','crm','mts','m2ts','ts'], recursive: true, directoryToken: true } : { kind: 'openFiles', title: '追加视频', extensions: ['mp4','mov','m4v','mkv','avi','webm','crm','mts','m2ts','ts'], multiple: true });
    return { cancelled: result.cancelled === true, sources: (result.inputs || []).slice(0, 120).map(item => ({ token: item.token, name: item.relativeName || item.name, kind: item.kind === 'directory' ? 'folder' : 'file' })) };
  }
  if (method === 'video-tools.sources.preview.v1') return callHost(id, 'project.media.process.v7', { action: 'video.sources.preview', relativePaths: paths(payload), inputTokens: Array.isArray(payload.inputTokens) ? payload.inputTokens.map(String).slice(0,120) : [] });
  if (method === 'video-tools.settings.update.v1') {
    const settings = normalizeSettings(payload.settings);
    const result = await callHost(id, 'component.settings.v7', { action: 'merge', settings: { transcode: settings } });
    return { revision: result.revision, settings };
  }
  if (method === 'video-tools.inspect.v1') return callHost(id, 'project.media.process.v7', { action: 'video.transcode.inspect', relativePaths: paths(payload), inputTokens: Array.isArray(payload.inputTokens) ? payload.inputTokens.map(String).slice(0,120) : [], settings: normalizeSettings(payload.settings) });
  if (method === 'video-tools.transcode.v1' || method === 'video-tools.split.v1') {
    const processAction = method === 'video-tools.transcode.v1' ? 'video.transcode' : 'video.split';
    const idempotencyKey = String(payload.idempotencyKey || ''); const key = operationKey(context, processAction);
    activeOperations.set(key, { processAction, idempotencyKey, state: 'running' });
    try {
      const result = await callHost(id, 'project.media.process.v7', processAction === 'video.transcode'
        ? { action: processAction, idempotencyKey, relativePaths: paths(payload), inputTokens: Array.isArray(payload.inputTokens) ? payload.inputTokens.map(String).slice(0,120) : [], settings: normalizeSettings(payload.settings), outputMode: payload.outputMode === 'delete-original' ? 'delete-original' : 'new' }
        : { action: processAction, idempotencyKey, relativePaths: paths(payload), inputTokens: Array.isArray(payload.inputTokens) ? payload.inputTokens.map(String).slice(0,120) : [] });
      activeOperations.set(key, { processAction, idempotencyKey, state: 'completed', result }); return result;
    } catch (error) { activeOperations.set(key, { processAction, idempotencyKey, state: 'failed', error: error.message }); throw error; }
  }
  if (method === 'video-tools.operation.current.v1') {
    const processAction = payload.processAction === 'video.split' ? 'video.split' : 'video.transcode'; const current = activeOperations.get(operationKey(context, processAction));
    if (!current) return { operation: null };
    const status = await callHost(id, 'project.media.process.v7', { action: 'status', processAction, idempotencyKey: current.idempotencyKey });
    return { operation: { ...current, task: status.task } };
  }
  if (method === 'video-tools.operation.control.v1') {
    const processAction = payload.processAction === 'video.split' ? 'video.split' : 'video.transcode'; const current = activeOperations.get(operationKey(context, processAction));
    if (!current) return { operation: null };
    const action = ['cancel', 'pause', 'resume'].includes(payload.action) ? payload.action : 'status';
    return callHost(id, 'project.media.process.v7', { action, processAction, idempotencyKey: current.idempotencyKey });
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
