const path = require('path');

const registerBackupIpc = ({ backupService, credentialService, dialog, ipcMain, getMainWindow, shell, writeLog }) => {
  ipcMain.handle('backup-choose-target', async (_event, currentPath = '') => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择 PhotoFlow 备份位置',
      defaultPath: currentPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    return { cancelled: false, path: backupService.approveTarget(result.filePaths[0]) };
  });

  ipcMain.handle('backup-status', async (_event, workspacePath) => backupService.status(workspacePath));

  ipcMain.handle('backup-set-nas-target', async (_event, targetPath) => {
    try {
      if (!credentialService.isUncPath(targetPath)) throw new Error('请输入有效的 NAS 共享路径，例如 \\\\studio-nas\\backup');
      return { success: true, path: backupService.approveTarget(targetPath) };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-save-nas-credential', async (_event, request) => {
    try {
      return { success: true, ...await credentialService.saveNasCredential(request || {}) };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-read-nas-credential', async (_event, credentialRef) => {
    try {
      return { success: true, credential: await credentialService.readNasCredential(credentialRef) };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-delete-nas-credential', async (_event, credentialRef) => {
    try {
      await credentialService.deleteNasCredential(credentialRef);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-test-connection', async () => {
    try { return { success: true, connection: await backupService.testConnection() }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('backup-space-status', async (_event, workspacePath) => {
    try { return await backupService.spaceStatus(workspacePath); }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('backup-cleanup', async (_event, workspacePath) => {
    try {
      void backupService.cleanup(workspacePath).catch(error => writeLog('error', 'Backup cleanup failed', error));
      return { success: true, queued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-run', async (_event, workspacePath, reason = 'manual') => {
    try {
      const current = await backupService.status(workspacePath);
      if (!current.enabled) return { success: false, error: '请先启用备份并选择备份位置' };
      void backupService.runBackup(workspacePath, reason).catch(error => writeLog('error', 'Workspace backup failed', error));
      return { success: true, queued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-run-if-due', async (_event, workspacePath) => {
    try {
      const result = await backupService.runIfDue(workspacePath);
      return { success: true, skipped: Boolean(result?.skipped) };
    } catch (error) {
      writeLog('warn', 'Scheduled workspace backup was not started', { error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-verify', async (_event, workspacePath, snapshotId) => {
    try {
      void backupService.verify(workspacePath, snapshotId).catch(error => writeLog('error', 'Backup verification failed', error));
      return { success: true, queued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-restore-workspace', async (_event, workspacePath, snapshotId) => {
    try {
      const selected = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择空文件夹恢复工作区',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (selected.canceled || !selected.filePaths[0]) return { success: false, cancelled: true };
      const result = await backupService.restoreWorkspace(workspacePath, snapshotId, selected.filePaths[0]);
      return { success: true, workspacePath: result?.result?.workspacePath || path.resolve(selected.filePaths[0]) };
    } catch (error) {
      writeLog('error', 'Workspace restore failed', error);
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-restore-project', async (_event, workspacePath, snapshotId, projectId) => {
    try {
      const result = await backupService.restoreProject(workspacePath, snapshotId, projectId);
      const project = result?.result?.project;
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send('workspace-projects-changed', { root: path.resolve(workspacePath), reason: 'project-restored' });
      return { success: true, project };
    } catch (error) {
      writeLog('error', 'Project restore failed', error);
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-open-target', async () => {
    try {
      const status = await backupService.status('');
      if (!status.targetPath) throw new Error('尚未设置备份位置');
      const error = await shell.openPath(status.targetPath);
      if (error) throw new Error(error);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
};

module.exports = { registerBackupIpc };
