const registerArchiveIpc = ({ archiveService, dialog, getMainWindow, ipcMain, shell, writeLog }) => {
  ipcMain.handle('archive-choose-target', async (_event, currentPath = '') => {
    const result = await dialog.showOpenDialog(getMainWindow(), { title: '选择 PhotoFlow 项目归档盘', defaultPath: currentPath || undefined, properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    return { cancelled: false, path: archiveService.approveTarget(result.filePaths[0]) };
  });
  ipcMain.handle('archive-status', async () => archiveService.status());
  ipcMain.handle('archive-project', async (_event, workspacePath, projectName) => {
    try {
      void archiveService.archiveProject(workspacePath, projectName).then(() => {
        const window = getMainWindow();
        if (window && !window.isDestroyed()) window.webContents.send('workspace-projects-changed', { root: workspacePath, reason: 'project-archived' });
      }).catch(error => writeLog('error', 'Project archive failed', error));
      return { success: true, queued: true };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('archive-move-back', async (_event, workspacePath, projectName, statusAfter) => {
    try {
      void archiveService.moveBack(workspacePath, projectName, statusAfter).then(() => {
        const window = getMainWindow();
        if (window && !window.isDestroyed()) window.webContents.send('workspace-projects-changed', { root: workspacePath, reason: 'project-unarchived' });
      }).catch(error => writeLog('error', 'Project move-back failed', error));
      return { success: true, queued: true };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('archive-open-target', async () => {
    try {
      const current = await archiveService.status();
      if (!current.targetPath) throw new Error('尚未设置归档盘');
      const error = await shell.openPath(current.targetPath);
      if (error) throw new Error(error);
      return { success: true };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
};

module.exports = { registerArchiveIpc };
