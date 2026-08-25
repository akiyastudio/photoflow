const registerComponentHostIpc = ({ ipcMain, manager, mainWindow }) => {
  ipcMain.handle('component-host-list', () => ({ success: true, actions: manager.listToolbarActions() }));
  ipcMain.handle('component-host-settings-list', () => ({ success: true, pages: manager.listSettingsPages() }));
  ipcMain.handle('component-host-open', (_event, request) => manager.open(request).then(page => ({ success: true, page }), error => ({ success: false, error: error.message || String(error) })));
  ipcMain.handle('component-host-settings-open', (_event, request) => manager.openSettings(request).then(page => ({ success: true, page }), error => ({ success: false, error: error.message || String(error) })));
  ipcMain.handle('component-host-settings-release', (_event, request) => ({ success: manager.releaseSettings(request) }));
  ipcMain.handle('component-host-activate', (_event, instanceId) => ({ success: manager.activate(String(instanceId || '')) }));
  ipcMain.handle('component-host-set-suspended', (event, update) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) throw new Error('Unauthorized host surface sender');
    return { success: manager.setHostSurfaceSuspended(update) };
  });
  ipcMain.handle('component-host-set-bounds', (_event, instanceId, bounds) => ({ success: manager.setBounds(String(instanceId || ''), bounds) }));
  ipcMain.handle('component-host-close', (_event, instanceId) => ({ success: manager.close(String(instanceId || '')) }));
  ipcMain.handle('component-host-close-project', (_event, workspacePath, projectId) => ({ success: true, closedCount: manager.closeProject(workspacePath, projectId) }));
};

module.exports = { registerComponentHostIpc };
