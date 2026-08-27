const { createAdvancedVideoService } = require('../services/advanced-video-service.cjs');

const registerAdvancedVideoIpc = ({ BrowserWindow, app, crypto, dialog, fs, ipcMain, mediaService, path, pluginService, processSupervisor, spawn, writeLog }) => {
  const service = createAdvancedVideoService({ BrowserWindow, crypto, mediaService, path, pluginService, processSupervisor, spawn, writeLog });
  const screenshotTarget = sourcePath => {
    const now = new Date();
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
    const parsed = path.parse(sourcePath);
    const id = crypto.randomUUID();
    return {
      finalPath: path.join(parsed.dir, `${parsed.name}_截图_${stamp}_${id.slice(0, 8)}.png`),
      temporaryPath: path.join(parsed.dir, `.${parsed.name}.${id}.photoflow-chromium-screenshot.png`),
    };
  };
  ipcMain.handle('video-playback-source', async (_event, filePath) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      return { success: true, mediaUrl: mediaService.toUrl(sourcePath, true) };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('video-player-publish-frame', async (_event, filePath, bytes) => {
    let temporaryPath = '';
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      const buffer = Buffer.from(bytes || []);
      const hasPngTrailer = buffer.length >= 20 && buffer.readUInt32BE(buffer.length - 12) === 0 && buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii') === 'IEND';
      if (!hasPngTrailer || buffer.length > 100 * 1024 * 1024 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('视频截图数据无效');
      const target = screenshotTarget(sourcePath);
      temporaryPath = target.temporaryPath;
      await fs.promises.writeFile(temporaryPath, buffer, { flag: 'wx' });
      await fs.promises.rename(temporaryPath, target.finalPath);
      temporaryPath = '';
      return { success: true, path: target.finalPath };
    } catch (error) {
      if (temporaryPath) await fs.promises.unlink(temporaryPath).catch(() => undefined);
      return { success: false, error: error.message || String(error) };
    }
  });
  // Legacy IPC aliases remain for renderer compatibility; current UI uses video-player-* only.
  ipcMain.handle('advanced-video-start', async (event, filePath, arrowKeyAction, playerId, requestId) => {
    try { return { success: true, ...(await service.start(event, filePath, arrowKeyAction, playerId, requestId)) }; }
    catch (error) {
      writeLog('warn', 'Advanced video decoder start failed', { error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });
  ipcMain.handle('video-player-start', async (event, filePath, settings, playerId, requestId) => {
    try { return { success: true, ...(await service.start(event, filePath, settings, playerId, requestId)) }; }
    catch (error) {
      writeLog('warn', 'Video player start failed', { error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });
  ipcMain.on('advanced-video-bounds', (event, sessionId, bounds) => service.setBounds(event, sessionId, bounds));
  ipcMain.on('advanced-video-control', (event, sessionId, request) => service.control(event, sessionId, request));
  ipcMain.on('video-player-control', (event, sessionId, request) => service.control(event, sessionId, request));
  ipcMain.on('video-player-bounds', (event, sessionId, bounds) => service.setBounds(event, sessionId, bounds));
  ipcMain.handle('video-player-subtitle-choose', async (event, sessionId) => {
    try {
      if (!service.ownsSession(sessionId, event.sender.id)) return { success: false, error: '视频播放会话不存在' };
      const owner = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(owner, { title: '添加本地字幕', properties: ['openFile'], filters: [{ name: '字幕文件', extensions: ['srt', 'ass', 'ssa', 'vtt'] }] });
      if (result.canceled || !result.filePaths[0]) return { success: true, cancelled: true };
      // The path crosses the Electron boundary only after the trusted native dialog returns it.
      service.addSubtitle(event, sessionId, result.filePaths[0]);
      return { success: true, path: result.filePaths[0] };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('video-player-subtitle-add', async (event, sessionId, filePath) => {
    try { service.addSubtitle(event, sessionId, await mediaService.authorizeInput(filePath)); return { success: true }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('advanced-video-screenshot', async (event, sessionId) => {
    try { return { success: true, ...(await service.screenshot(event, sessionId)) }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('video-player-screenshot', async (event, sessionId) => {
    try { return { success: true, ...(await service.screenshot(event, sessionId)) }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('video-player-stop', (event, sessionId) => ({ success: service.stop(sessionId, event.sender.id) }));
  ipcMain.handle('advanced-video-stop', (event, sessionId) => ({ success: service.stop(sessionId, event.sender.id) }));
  app.once('before-quit', () => service.dispose());
  return service;
};

module.exports = { registerAdvancedVideoIpc };
