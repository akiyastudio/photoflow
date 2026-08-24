const { normalizeLegacyExternalProgress } = require('../compatibility/component-v1-metadata.cjs');

const normalizeExternalProgress = (channel, value = {}) => {
  const progress = Math.max(0, Math.min(100, Number(value.progress) || 0));
  const stateFor = phase => phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'cancelled' : phase === 'complete' || progress >= 100 ? 'completed' : 'running';
  if (channel === 'workspace-screenshot-main-image-progress') return { id: `external:screenshot-main-image:${value.requestId}`, type: 'screenshot-main-image', title: '提取截图主图', state: stateFor(value.phase), progress, message: value.message, metadata: { phase: value.phase, requestId: value.requestId, processedCount: value.processedCount, totalCount: value.totalCount, currentName: value.currentName } };
  if (channel === 'workspace-selection-progress') {
    const operationId = String(value.operationId || '');
    if (!operationId || !['copying', 'complete', 'cancelled', 'failed'].includes(value.phase)) return null;
    return { id: `external:selection:${operationId}`, type: 'selection-operation', title: '选片文件处理', state: stateFor(value.phase), progress, message: value.fileName || value.message || '正在处理选片文件', error: value.error, cancellable: true, metadata: { phase: value.phase, operationId, bytesCopied: value.bytesCopied, totalBytes: value.totalBytes, filesCopied: value.fileIndex, totalFiles: value.totalFiles } };
  }
  return normalizeLegacyExternalProgress(channel, value, stateFor);
};

const registerBackgroundTasksIpc = ({ ipcMain, eventBus, backgroundTasks, getMainWindow }) => {
  const sendTask = delta => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send('background-task-changed', delta);
  };
  const unsubscribe = eventBus.on('background-task:changed', sendTask);
  const externalProgressListener = (event, channel, value) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
    const task = normalizeExternalProgress(String(channel || ''), value);
    if (task) backgroundTasks.upsertExternal(task);
  };
  ipcMain.on('background-task-external-progress', externalProgressListener);
  ipcMain.handle('background-tasks-list', async () => ({ success: true, ...backgroundTasks.snapshot() }));
  ipcMain.handle('background-task-cancel', async (_event, id) => ({ success: backgroundTasks.cancel(String(id || '')) }));
  ipcMain.handle('background-task-pause', async (_event, id) => ({ success: backgroundTasks.pause(String(id || '')) }));
  ipcMain.handle('background-task-continue', async (_event, id) => ({ success: backgroundTasks.continuePaused(String(id || '')) }));
  ipcMain.handle('background-task-dismiss', async (_event, id) => ({ success: backgroundTasks.dismiss(String(id || '')) }));
  ipcMain.handle('background-task-resume', async (_event, id) => {
    try {
      const result = await backgroundTasks.resume(String(id || ''));
      return { success: true, task: result.task };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  ipcMain.handle('background-task-restart', async (_event, id) => {
    try {
      const result = await backgroundTasks.restart(String(id || ''));
      return { success: true, task: result?.task };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  ipcMain.handle('background-task-retry', async (_event, id) => {
    try {
      const result = await backgroundTasks.retry(String(id || ''));
      const { completion: _completion, ...accepted } = result;
      return { success: true, ...accepted };
    } catch (error) {
      return { success: false, code: error.code || 'RETRY_FAILED', error: error.message || String(error) };
    }
  });
  return () => {
    unsubscribe();
    ipcMain.removeListener('background-task-external-progress', externalProgressListener);
  };
};

module.exports = { normalizeExternalProgress, registerBackgroundTasksIpc };
