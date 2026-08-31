const CHANNELS = ['background-tasks-list', 'background-task-cancel', 'background-task-pause', 'background-task-continue', 'background-task-dismiss', 'background-task-resume', 'background-task-restart', 'background-task-retry'];
const EXTERNAL_CHANNELS = new Set(['workspace-screenshot-main-image-progress', 'workspace-selection-progress']);
const SCREENSHOT_PHASES = new Set(['scanning', 'moving', 'copying', 'splitting', 'finishing', 'trashing', 'running', 'complete', 'cancelled', 'failed']);
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const serializeError = (error, fallback = '操作失败') => ({ code: typeof error?.code === 'string' ? error.code : 'BACKGROUND_TASK_FAILED', error: typeof error?.message === 'string' ? error.message : fallback });
const normalizedId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9:._-]{0,199}$/i.test(value) ? value : '';

const normalizeExternalProgress = (channel, value = {}) => {
  if (!EXTERNAL_CHANNELS.has(channel) || !isPlainObject(value)) return null;
  const numericProgress = Number(value.progress);
  const progress = Number.isFinite(numericProgress) ? Math.max(0, Math.min(100, numericProgress)) : 0;
  const stateFor = phase => phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'cancelled' : phase === 'complete' ? 'completed' : 'running';
  if (channel === 'workspace-screenshot-main-image-progress') {
    const requestId = normalizedId(value.requestId);
    if (!requestId || !SCREENSHOT_PHASES.has(value.phase)) return null;
    return { id: `external:screenshot-main-image:${requestId}`, type: 'screenshot-main-image', title: '提取截图主图', state: stateFor(value.phase), progress, message: typeof value.message === 'string' ? value.message : undefined, metadata: { phase: value.phase, requestId, processedCount: value.processedCount, totalCount: value.totalCount, currentName: value.currentName } };
  }
  const operationId = normalizedId(value.operationId);
  if (!operationId || !['copying', 'complete', 'cancelled', 'failed'].includes(value.phase)) return null;
  return { id: `external:selection:${operationId}`, type: 'selection-operation', title: '选片文件处理', state: stateFor(value.phase), progress, message: value.fileName || value.message || '正在处理选片文件', error: typeof value.error === 'string' ? value.error : undefined, cancellable: true, metadata: { phase: value.phase, operationId, bytesCopied: value.bytesCopied, totalBytes: value.totalBytes, filesCopied: value.fileIndex, totalFiles: value.totalFiles } };
};

const registerBackgroundTasksIpc = ({ ipcMain, eventBus, backgroundTasks, getMainWindow }) => {
  const trusted = event => { const window = getMainWindow(); return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents && !event.sender.isDestroyed?.()); };
  const handle = (channel, listener) => ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('Unauthorized IPC sender');
    try { return await listener(...args); } catch (error) { return { success: false, ...serializeError(error) }; }
  });
  const requireId = value => { const id = normalizedId(value); if (!id) throw new Error('无效的任务 ID'); return id; };
  const sendTask = delta => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send('background-task-changed', delta); };
  const unsubscribe = eventBus.on('background-task:changed', sendTask);
  const externalProgressListener = (event, channel, value) => { if (!trusted(event) || typeof channel !== 'string') return; const task = normalizeExternalProgress(channel, value); if (task) backgroundTasks.upsertExternal(task); };
  ipcMain.on('background-task-external-progress', externalProgressListener);
  handle('background-tasks-list', async () => ({ success: true, ...backgroundTasks.snapshot() }));
  handle('background-task-cancel', async id => ({ success: backgroundTasks.cancel(requireId(id)) }));
  handle('background-task-pause', async id => ({ success: backgroundTasks.pause(requireId(id)) }));
  handle('background-task-continue', async id => ({ success: backgroundTasks.continuePaused(requireId(id)) }));
  handle('background-task-dismiss', async id => ({ success: backgroundTasks.dismiss(requireId(id)) }));
  handle('background-task-resume', async id => ({ success: true, task: (await backgroundTasks.resume(requireId(id))).task }));
  handle('background-task-restart', async id => ({ success: true, task: (await backgroundTasks.restart(requireId(id)))?.task }));
  handle('background-task-retry', async id => { const { completion: _completion, ...accepted } = await backgroundTasks.retry(requireId(id)); return { success: true, ...accepted }; });
  return () => { unsubscribe(); ipcMain.removeListener('background-task-external-progress', externalProgressListener); CHANNELS.forEach(channel => ipcMain.removeHandler(channel)); };
};

module.exports = { normalizeExternalProgress, registerBackgroundTasksIpc };
