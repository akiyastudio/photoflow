const registerMediaIpc = context => {
  const { Buffer, Date, Error, IMAGE_EXTENSIONS, Math, Number, Object, PRIORITY, Promise, RAW_EXTENSIONS, String, VIDEO_EXTENSIONS, approvedMediaCacheDirectories, backgroundTasks, clearTimeout, dialog, exiftool, findImportedVideoPreview, flattenMetadataValue, fs, getMediaCacheDir, ipcMain, mainWindow, mediaCacheIndexes, mediaMetadataCache, mediaRuntimeState, mediaService, normalizeMediaCacheSizeGB, path, rawOrientationCorrection, rawPreviewPath, refreshMediaCacheIndex, setTimeout, thumbnailService, trimMediaCache, undefined, writeLog } = context;

  ipcMain.handle('media-thumbnail', async (_event, filePath, kind, cacheConfig = {}, requestedSize = 640, priority = PRIORITY.visible, queueOrder = Number.MAX_SAFE_INTEGER) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      const extension = path.extname(sourcePath).toLowerCase();
      const supported = kind === 'raw' ? RAW_EXTENSIONS.has(extension) : kind === 'video' ? VIDEO_EXTENSIONS.has(extension) : IMAGE_EXTENSIONS.has(extension);
      if (!supported || !fs.existsSync(sourcePath)) throw new Error('文件不存在或格式不受支持');
      mediaRuntimeState.activeMediaCacheConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
      const result = await mediaService.requestThumbnail({ filePath: sourcePath, kind, cacheConfig: mediaRuntimeState.activeMediaCacheConfig, requestedSize, priority, queueOrder });
      if (kind !== 'video') return result;
      const isImportedOriginal = path.basename(path.dirname(sourcePath)).toLocaleLowerCase() === 'mov';
      const importedPreview = await findImportedVideoPreview(sourcePath);
      return {
        ...result,
        mediaUrl: importedPreview ? mediaService.toUrl(importedPreview) : isImportedOriginal ? undefined : mediaService.toUrl(sourcePath),
        usingImportedPreview: Boolean(importedPreview),
        importedVideoWithoutPreview: isImportedOriginal && !importedPreview
      };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  
  ipcMain.handle('media-thumbnail-cancel', async (_event, filePath, requestedSize = 640) => {
    try { return { success: true, cancelled: mediaService.cancelThumbnail(await mediaService.authorizeInput(filePath), requestedSize) }; }
    catch (error) { return { success: false, cancelled: false, error: error.message || String(error) }; }
  });
  
  ipcMain.handle('media-original', async (_event, filePath, kind, cacheConfig = {}) => {
    try {
      thumbnailService?.noteForegroundActivity();
      const sourcePath = await mediaService.authorizeInput(filePath);
      const extension = path.extname(sourcePath).toLowerCase();
      const supported = kind === 'raw' ? RAW_EXTENSIONS.has(extension) : kind === 'image' ? IMAGE_EXTENSIONS.has(extension) : false;
      if (!supported || !fs.existsSync(sourcePath)) throw new Error('图片不存在或格式不受支持');
      if (kind === 'image') return { success: true, mediaUrl: mediaService.toUrl(sourcePath, true), original: true };
  
      // Chromium cannot decode camera RAW containers directly. Use the largest
      // camera-embedded JPEG, which is the closest displayable source preview.
      const stat = await fs.promises.stat(sourcePath);
      const previewPath = await rawPreviewPath(sourcePath, stat, cacheConfig);
      if (!previewPath) throw new Error('RAW 文件中没有可显示的内嵌原图');
      let orientationTimer;
      const orientation = await Promise.race([
        rawOrientationCorrection(sourcePath, previewPath, stat),
        new Promise(resolve => {
          orientationTimer = setTimeout(() => resolve({ matrix: [1, 0, 0, 1], swapsAxes: false, rawOrientation: 1, embeddedOrientation: 1 }), 3000);
        })
      ]);
      clearTimeout(orientationTimer);
      return { success: true, mediaUrl: mediaService.toUrl(previewPath, true), original: false, orientation };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('media-metadata', async (_event, filePath) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      const extension = path.extname(sourcePath).toLowerCase();
      if (![...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...RAW_EXTENSIONS].includes(extension) || !fs.existsSync(sourcePath)) throw new Error('媒体文件不存在或格式不受支持');
      const stat = await fs.promises.stat(sourcePath);
      const cacheKey = `${sourcePath}|${stat.size}|${stat.mtimeMs}`;
      const cached = mediaMetadataCache.get(cacheKey);
      if (cached) return cached;
  
      const tags = await exiftool.readRaw(sourcePath, ['-G1', '-struct', '-api', 'largefilesupport=1']);
      const fields = Object.entries(tags).flatMap(([qualifiedName, rawValue]) => {
        if (qualifiedName === 'SourceFile') return [];
        const separatorIndex = qualifiedName.indexOf(':');
        const group = separatorIndex > 0 ? qualifiedName.slice(0, separatorIndex) : '其他';
        const name = separatorIndex > 0 ? qualifiedName.slice(separatorIndex + 1) : qualifiedName;
        return flattenMetadataValue(group, name, rawValue);
      });
      const result = { success: true, fields };
      if (mediaMetadataCache.size >= 32) mediaMetadataCache.delete(mediaMetadataCache.keys().next().value);
      mediaMetadataCache.set(cacheKey, result);
      return result;
    } catch (error) {
      writeLog('warn', 'Unable to read media metadata', { filePath, error: error.message || String(error) });
      return { success: false, fields: [], error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('media-raw-preview', async (_event, filePath, cacheConfig = {}) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      if (!RAW_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()) || !fs.existsSync(sourcePath)) throw new Error('RAW 文件不存在或格式不受支持');
      const preview = await rawPreviewPath(sourcePath, await fs.promises.stat(sourcePath), cacheConfig);
      return preview ? { success: true, previewUrl: mediaService.toUrl(preview) } : { success: false, error: '未找到内嵌预览' };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  
  ipcMain.handle('folder-has-png', async (_event, folderPath) => {
    try {
      const target = await mediaService.authorizeInput(folderPath);
      if (!(await fs.promises.stat(target)).isDirectory()) throw new Error('文件夹不存在');
      for (const entry of await fs.promises.readdir(target, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const handle = await fs.promises.open(path.join(target, entry.name), 'r');
        const header = Buffer.alloc(8);
        try { await handle.read(header, 0, 8, 0); }
        finally { await handle.close(); }
        if (header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { success: true, hasPng: true };
      }
      return { success: true, hasPng: false };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  
  ipcMain.handle('choose-cache-directory', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, { title: '选择缩略图缓存目录', properties: ['openDirectory', 'createDirectory'] });
    if (!choice.canceled && choice.filePaths[0]) approvedMediaCacheDirectories.add(path.resolve(choice.filePaths[0]));
    return choice.canceled ? { cancelled: true } : { path: choice.filePaths[0] };
  });
  
  ipcMain.handle('media-cache-info', async (_event, cacheConfig = {}) => {
    try {
      const normalizedConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
      const cacheDir = getMediaCacheDir(normalizedConfig);
      const state = await refreshMediaCacheIndex(cacheDir);
      trimMediaCache(cacheDir, normalizedConfig.maxSizeGB);
      return { success: true, path: cacheDir, sizeBytes: state.totalBytes, fileCount: state.files.size };
    }
    catch (error) { return { success: false, path: '', sizeBytes: 0, fileCount: 0, error: error.message || String(error) }; }
  });
  
  ipcMain.handle('media-cache-clear', async (_event, cacheConfig = {}, olderThanDays) => {
    try {
      const execution = await backgroundTasks.run({ type: 'cache-cleanup', title: '清理媒体缓存' }, async task => {
        const cacheDir = getMediaCacheDir(cacheConfig);
        const days = Number(olderThanDays);
        const cutoff = Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
        const deletedPaths = [];
        const entries = (await fs.promises.readdir(cacheDir, { withFileTypes: true })).filter(entry => entry.isFile());
        for (let offset = 0; offset < entries.length; offset += 64) {
          task.throwIfCancelled();
          await Promise.all(entries.slice(offset, offset + 64).map(async entry => {
            const filePath = path.join(cacheDir, entry.name);
            try {
              if (cutoff !== null && (await fs.promises.stat(filePath)).mtimeMs >= cutoff) return;
              await fs.promises.unlink(filePath);
              deletedPaths.push(filePath);
            } catch { /* cache files can disappear while cleanup is running */ }
          }));
          task.report(Math.round(((offset + 64) / Math.max(1, entries.length)) * 95), `已检查 ${Math.min(offset + 64, entries.length)} / ${entries.length} 个文件`);
        }
        await thumbnailService.invalidateDeleted(deletedPaths, cutoff);
        const pruned = await thumbnailService.pruneMissingSources();
        mediaCacheIndexes.delete(path.resolve(cacheDir));
        return { deletedCount: deletedPaths.length, prunedSourceCount: pruned.sourceCount || 0 };
      });
      return { success: true, deletedCount: execution.result.deletedCount, prunedSourceCount: execution.result.prunedSourceCount, taskId: execution.task.id };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
};

module.exports = { registerMediaIpc };
