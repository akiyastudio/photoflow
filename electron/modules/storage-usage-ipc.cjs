const registerStorageUsageIpc = ({ ipcMain, storageUsageService }) => {
  ipcMain.handle('storage-usage-overview', async (_event, force = false) => {
    try { return await storageUsageService.overview(Boolean(force)); }
    catch (error) { return { success: false, updatedAt: 0, scanning: false, stale: true, volumes: [], error: error.message || String(error) }; }
  });
};

module.exports = { registerStorageUsageIpc };
