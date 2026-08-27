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

const createNativeFileDragService = ({ nativeImage, writeLog }) => {
  // Electron requires startDrag to run directly from dragstart. Keep the hot
  // path synchronous and use one already-created icon for every item.
  let icon = nativeImage?.createFromBitmap ? createFallbackDragIcon(nativeImage) : null;
  const dragIcon = () => {
    if (!icon) icon = createFallbackDragIcon(nativeImage);
    return icon;
  };
  const start = (sender, sources, sourceSummary = {}) => {
    if (sender.isDestroyed()) throw new Error('原生拖拽页面已经销毁');
    const item = sources.length === 1
      ? { file: sources[0], icon: dragIcon() }
      : { file: sources[0], files: sources, icon: dragIcon() };
    const startedAt = Date.now();
    const details = { count: sources.length, mode: sources.length === 1 ? 'file' : 'files', ...sourceSummary };
    writeLog('info', 'Starting native project file drag', details);
    try {
      sender.startDrag(item);
    } catch (error) {
      writeLog('error', 'Native project file drag failed', { count: sources.length, error: error?.message || String(error) });
      throw error;
    }
    writeLog('info', 'Native project file drag ended', { ...details, durationMs: Math.max(0, Date.now() - startedAt) });
  };

  return { start };
};

module.exports = { createFallbackDragIcon, createNativeFileDragService };
