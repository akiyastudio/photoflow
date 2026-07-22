const registerBackgroundTasksIpc = ({ ipcMain, eventBus, backgroundTasks, getMainWindow }) => {
  const sendTask = task => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send('background-task-changed', task);
  };
  const unsubscribe = eventBus.on('background-task:changed', sendTask);
  ipcMain.handle('background-tasks-list', async () => ({ success: true, tasks: backgroundTasks.list() }));
  ipcMain.handle('background-task-cancel', async (_event, id) => ({ success: backgroundTasks.cancel(String(id || '')) }));
  ipcMain.handle('background-task-retry', async (_event, id) => {
    try {
      const result = await backgroundTasks.retry(String(id || ''));
      return { success: true, task: result.task };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  return unsubscribe;
};

module.exports = { registerBackgroundTasksIpc };
