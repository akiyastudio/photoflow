const registerStorageUsageIpc = ({ ipcMain, storageUsageService, getMainWindow, assertTrustedSender }) => {
  const channel = 'storage-usage-overview';
  ipcMain.handle(channel, async (event, force = false) => {
    const mainWindow = getMainWindow?.();
    const url = event?.senderFrame?.url || '';
    const fallbackTopLevelRenderer = event?.senderFrame === event?.sender?.mainFrame
      && event?.sender?.getType?.() === 'window'
      && (url.startsWith('file:') || /^http:\/\/localhost:\d+\//.test(url));
    const trusted = typeof assertTrustedSender === 'function' ? assertTrustedSender(event)
      : mainWindow ? !mainWindow.isDestroyed() && event?.sender === mainWindow.webContents
        // Compatibility fallback for the existing main.cjs registration. This is origin/top-level validation,
        // not a substitute for injecting the main-window identity.
        : fallbackTopLevelRenderer;
    if (!trusted) throw new Error('Unauthorized IPC sender');
    if (force !== false && force !== true) return { success: false, updatedAt: 0, scanning: false, stale: true, volumes: [], code: 'INVALID_ARGUMENT', error: 'force 只接受 true' };
    try { return await storageUsageService.overview(force === true); }
    catch (error) { return { success: false, updatedAt: 0, scanning: false, stale: true, volumes: [], code: typeof error?.code === 'string' ? error.code : 'STORAGE_USAGE_FAILED', error: error.message || String(error) }; }
  });
  return () => ipcMain.removeHandler(channel);
};

module.exports = { registerStorageUsageIpc };
