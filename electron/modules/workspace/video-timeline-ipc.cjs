const registerVideoTimelineIpc = ({ ipcMain, extractVideoTimelineFrames, resolveProjectEntry, fs, path, VIDEO_EXTENSIONS, writeLog }) => {
  ipcMain.handle('workspace-video-timeline-frames', async (_event, workspacePath, status, projectName, relativePath, times = []) => {
    try {
      const sourcePath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile() || !VIDEO_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) throw new Error('请选择项目中的视频文件');
      const safeTimes = (Array.isArray(times) ? times : []).slice(0, 16).map(Number);
      if (!safeTimes.length || safeTimes.some(time => !Number.isFinite(time) || time < 0)) throw new Error('视频时间轴位置无效');
      if (typeof extractVideoTimelineFrames !== 'function') throw new Error('视频播放器组件不支持时间线帧提取');
      const frames = await extractVideoTimelineFrames(sourcePath, safeTimes);
      return Array.isArray(frames) && frames.length ? { success: true, frames } : { success: false, error: '无法生成视频时间轴画面' };
    } catch (error) {
      writeLog('warn', 'Video timeline frame extraction failed', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });
};

module.exports = { registerVideoTimelineIpc };
