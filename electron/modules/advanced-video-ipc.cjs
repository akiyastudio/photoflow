const { createAdvancedVideoService } = require('../services/advanced-video-service.cjs');

const registerAdvancedVideoIpc = ({ BrowserWindow, app, crypto, ipcMain, mediaService, path, pluginService, spawn, writeLog }) => {
  const service = createAdvancedVideoService({ BrowserWindow, crypto, mediaService, path, pluginService, spawn, writeLog });
  ipcMain.handle('advanced-video-start', async (event, filePath, arrowKeyAction) => {
    try { return { success: true, ...(await service.start(event, filePath, arrowKeyAction)) }; }
    catch (error) {
      writeLog('warn', 'Advanced video decoder start failed', { error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });
  ipcMain.on('advanced-video-bounds', (event, sessionId, bounds) => service.setBounds(event, sessionId, bounds));
  ipcMain.on('advanced-video-control', (event, sessionId, request) => service.control(event, sessionId, request));
  ipcMain.handle('advanced-video-screenshot', async (event, sessionId) => {
    try { return { success: true, ...(await service.screenshot(event, sessionId)) }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('advanced-video-stop', (event, sessionId) => ({ success: service.stop(sessionId, event.sender.id) }));
  app.once('before-quit', () => service.dispose());
  return service;
};

module.exports = { registerAdvancedVideoIpc };
