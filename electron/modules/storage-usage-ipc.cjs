const registerStorageUsageIpc = ({ ipcMain, storageUsageService }) => {
  const channel = 'storage-usage-overview';
  ipcMain.handle(channel, async (event, force = false) => {
    const url = event?.senderFrame?.url || '';
    const trusted = event?.senderFrame === event?.sender?.mainFrame && (url.startsWith('file:') || /^http:\/\/localhost:\d+\//.test(url));
    if (!trusted) throw new Error('Unauthorized IPC sender');
    if (force !== false && force !== true) return { success: false, updatedAt: 0, scanning: false, stale: true, volumes: [], code: 'INVALID_ARGUMENT', error: 'force 只接受 true' };
    try { return await storageUsageService.overview(force === true); }
    catch (error) { return { success: false, updatedAt: 0, scanning: false, stale: true, volumes: [], code: typeof error?.code === 'string' ? error.code : 'STORAGE_USAGE_FAILED', error: error.message || String(error) }; }
  });
  return () => ipcMain.removeHandler(channel);
};

module.exports = { registerStorageUsageIpc };
