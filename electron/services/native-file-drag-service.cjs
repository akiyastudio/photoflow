const MIN_WINDOWS_DRAG_LOOP_MS = 8;

const createFallbackDragIcon = nativeImage => {
  if (!nativeImage?.createFromBitmap) throw new Error('无法创建原生拖拽图标');
  const size = 32;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 3; y < 29; y += 1) {
    for (let x = 5; x < 27; x += 1) {
      const offset = (y * size + x) * 4;
      const border = x < 7 || x > 24 || y < 5 || y > 26;
      bitmap[offset] = border ? 0xc4 : 0xff;
      bitmap[offset + 1] = border ? 0x73 : 0xff;
      bitmap[offset + 2] = border ? 0x25 : 0xff;
      bitmap[offset + 3] = 0xff;
    }
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: size, height: size, scaleFactor: 1 });
  if (!icon || icon.isEmpty?.()) throw new Error('原生拖拽备用图标为空');
  return icon;
};

const createNativeFileDragService = ({ app, BrowserWindow, Date, nativeImage, process, writeLog }) => {
  // This icon is constructed when IPC is registered, never inside dragstart.
  // A Shell icon may replace it after prepare(), but start() always has a
  // synchronous, explicitly non-empty image available.
  const fallbackIcon = nativeImage ? createFallbackDragIcon(nativeImage) : null;
  const iconCache = new Map();

  const prepare = async source => {
    try {
      const icon = await app.getFileIcon(source, { size: 'normal' });
      if (!icon || icon.isEmpty?.()) throw new Error('Shell 返回了空图标');
      iconCache.delete(source);
      iconCache.set(source, icon);
      while (iconCache.size > 64) iconCache.delete(iconCache.keys().next().value);
      return { success: true };
    } catch (error) {
      writeLog('warn', 'Unable to preload native file drag icon', { source, error: error?.message || String(error) });
      return { success: false, error: error?.message || String(error) };
    }
  };

  const start = (sender, sources) => {
    const ownerWindow = BrowserWindow.fromWebContents(sender) || sender.getOwnerBrowserWindow?.();
    if (!ownerWindow || ownerWindow.isDestroyed?.()) throw new Error('原生拖拽缺少有效的所属窗口');
    if (ownerWindow.isVisible?.() === false) throw new Error('原生拖拽所属窗口不可见');
    if (sender.isDestroyed()) throw new Error('原生拖拽页面已经销毁');
    if (sender.getLastWebPreferences?.().offscreen) throw new Error('离屏页面不能启动原生文件拖拽');

    const cachedIcon = iconCache.get(sources[0]);
    const icon = cachedIcon && !cachedIcon.isEmpty?.() ? cachedIcon : fallbackIcon;
    if (!icon || icon.isEmpty?.()) throw new Error('原生拖拽图标为空');
    const item = sources.length === 1
      ? { file: sources[0], icon }
      : { files: sources, icon };
    const startedAt = Date.now();
    writeLog('info', 'Starting native project file drag', {
      count: sources.length,
      mode: sources.length === 1 ? 'file' : 'files',
      icon: cachedIcon === icon ? 'shell-cache' : 'fallback',
      ownerVisible: ownerWindow.isVisible?.(),
      offscreen: false,
    });
    try {
      sender.startDrag(item);
    } catch (error) {
      const durationMs = Math.max(0, Date.now() - startedAt);
      error.nativeDrag = { attempted: true, durationMs, status: 'failed' };
      writeLog('error', 'Native project file drag threw', { count: sources.length, durationMs, error: error?.message || String(error) });
      throw error;
    }
    const durationMs = Math.max(0, Date.now() - startedAt);
    // Electron exposes no HRESULT/effect: startDrag returning only proves the
    // blocking call ended. On Windows, a sub-frame return means Chromium never
    // entered a usable OLE drag loop. A separate STA process cannot safely take
    // ownership of the already-held renderer mouse gesture, so Electron remains
    // the gesture owner and the fast return is reported as a failure.
    const status = process.platform === 'win32' && durationMs < MIN_WINDOWS_DRAG_LOOP_MS
      ? 'failed-fast'
      : 'completed';
    writeLog(status === 'failed-fast' ? 'warn' : 'info', 'Native project file drag returned', {
      count: sources.length,
      mode: sources.length === 1 ? 'file' : 'files',
      durationMs,
      status,
    });
    return { attempted: true, durationMs, status };
  };

  return { prepare, start };
};

module.exports = { MIN_WINDOWS_DRAG_LOOP_MS, createFallbackDragIcon, createNativeFileDragService };
