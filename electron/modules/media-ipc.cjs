const registerMediaIpc = context => {
  const { Array, Boolean, Buffer, Date, Error, IMAGE_EXTENSIONS, JSON, Math, Number, Object, PRIORITY, Promise, RAW_EXTENSIONS, String, VIDEO_EXTENSIONS, approvedMediaCacheDirectories, backgroundTasks, clearInterval, clearTimeout, crypto, dialog, exiftool, findImportedVideoPreview, flattenMetadataValue, fs, getMediaCacheDir, getRunConfig, ipcMain, mainWindow, mediaCacheIndexes, mediaMetadataCache, mediaRuntimeState, mediaService, normalizeMediaCacheSizeGB, path, rawOrientationCorrection, rawPreviewPath, refreshMediaCacheIndex, setInterval, setTimeout, spawn, thumbnailService, trimMediaCache, undefined, videoPreviewJobs, writeLog } = context;

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
  
  ipcMain.handle('media-video-hover-preview', async (_event, filePath, cacheConfig = {}, requestedSize = 640, cacheOnly = false, generateHoverFrames = false) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      if (!VIDEO_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()) || !fs.existsSync(sourcePath)) throw new Error('视频文件不存在或格式不受支持');
      const isImportedOriginal = path.basename(path.dirname(sourcePath)).toLocaleLowerCase() === 'mov';
      const importedPreview = await findImportedVideoPreview(sourcePath);
      // Imported camera originals deliberately do not trigger ad-hoc hover
      // transcoding. Treat the absence of an imported preview as a terminal
      // result so the renderer does not poll forever while the pointer is over
      // the card.
      if (isImportedOriginal && !importedPreview) return { success: true, cached: false, complete: true, unavailable: true, duration: 0, frameUrls: [] };
      const previewSource = importedPreview || sourcePath;
      const stat = fs.statSync(previewSource);
      const size = Math.max(320, Math.min(1600, Math.round(Number(requestedSize) || 640)));
      const cacheDir = getMediaCacheDir(cacheConfig);
      const cacheKey = crypto.createHash('sha256').update(`video-preview|v2|${size}|${previewSource}|${stat.size}|${stat.mtimeMs}`).digest('hex');
      const manifestPath = path.join(cacheDir, `${cacheKey}.json`);
      const readCached = () => {
        if (!fs.existsSync(manifestPath)) return null;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (!Array.isArray(manifest.frames) || !manifest.frames.length || !manifest.frames.every(frame => fs.existsSync(frame))) return null;
          return { success: true, cached: true, complete: manifest.complete === true, duration: Number(manifest.duration) || 0, frameUrls: manifest.frames.map(mediaService.toUrl) };
        } catch { return null; }
      };
      const cached = readCached();
      if (cached?.complete || cacheOnly || (cached && !generateHoverFrames)) return cached || { success: true, cached: false, complete: false, duration: 0, frameUrls: [] };
  
      if (!videoPreviewJobs.has(cacheKey)) {
        const runPreviewJob = () => new Promise((resolve, reject) => {
          const toolArgs = ['--source', previewSource, '--output_dir', cacheDir, '--cache_key', cacheKey, '--size', String(size)];
          if (generateHoverFrames && cached) toolArgs.push('--remaining_only');
          else if (!generateHoverFrames) toolArgs.push('--cover_only');
          const { command, args } = getRunConfig('video_preview.py', toolArgs);
          const child = spawn(command, args, { windowsHide: true });
          let stdoutBuffer = '';
          let stderr = '';
          let previewDuration = 0;
          let publishedFrameCount = 0;
          let progressTimer;
          const isCompleteJpeg = framePath => {
            try {
              const frameStat = fs.statSync(framePath);
              if (frameStat.size < 1024) return false;
              const handle = fs.openSync(framePath, 'r');
              const ending = Buffer.alloc(2);
              fs.readSync(handle, ending, 0, 2, frameStat.size - 2);
              fs.closeSync(handle);
              return ending[0] === 0xff && ending[1] === 0xd9;
            } catch { return false; }
          };
          const publishFinishedFrames = () => {
            if (!previewDuration) return;
            const frames = Array.from({ length: 5 }, (_value, index) => path.join(cacheDir, `${cacheKey}-${index + 1}.jpg`)).filter(isCompleteJpeg);
            if (frames.length <= publishedFrameCount) return;
            publishedFrameCount = frames.length;
            fs.writeFileSync(manifestPath, JSON.stringify({ duration: previewDuration, frames, complete: frames.length === 5 }), 'utf8');
          };
          const consumeOutput = (flush = false) => {
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = flush ? '' : lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const payload = JSON.parse(trimmed);
                if (payload.error) throw new Error(payload.error);
                if (Array.isArray(payload.frames) && payload.frames.length && payload.frames.every(frame => fs.existsSync(frame))) {
                  previewDuration = Number(payload.duration) || previewDuration;
                  fs.writeFileSync(manifestPath, JSON.stringify(payload), 'utf8');
                  publishedFrameCount = Math.max(publishedFrameCount, payload.frames.length);
                  if (!progressTimer && payload.complete !== true) progressTimer = setInterval(publishFinishedFrames, 100);
                }
              } catch (error) {
                writeLog('warn', 'Unable to process video preview progress', { filePath, error: error.message || String(error) });
              }
            }
          };
          child.stdout.on('data', data => { stdoutBuffer += data.toString(); consumeOutput(); });
          child.stderr.on('data', data => { stderr += data.toString(); });
          child.on('error', reject);
          child.on('close', code => {
            try {
              if (progressTimer) clearInterval(progressTimer);
              if (stdoutBuffer.trim()) { stdoutBuffer += '\n'; consumeOutput(true); }
              publishFinishedFrames();
              const finalManifest = readCached();
              if (code !== 0 || !finalManifest || (generateHoverFrames && !finalManifest.complete)) throw new Error(stderr.trim() || '视频抽样进程失败');
              trimMediaCache(cacheDir, cacheConfig?.maxSizeGB, [manifestPath, ...finalManifest.frames]);
              resolve(finalManifest);
            } catch (error) { reject(error); }
          });
        });
      const job = generateHoverFrames ? runPreviewJob() : mediaRuntimeState.videoPreviewWorkChain.then(runPreviewJob);
      if (!generateHoverFrames) mediaRuntimeState.videoPreviewWorkChain = job.catch(() => undefined);
        const trackedJob = job.finally(() => videoPreviewJobs.delete(cacheKey));
        trackedJob.catch(() => undefined);
        videoPreviewJobs.set(cacheKey, trackedJob);
      }
      if (cached && !generateHoverFrames) return cached;
      const job = videoPreviewJobs.get(cacheKey);
      while (videoPreviewJobs.has(cacheKey)) {
        const progressive = readCached();
        if (progressive) return progressive;
        await Promise.race([job.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 50))]);
      }
      const generated = readCached();
      if (!generated) throw new Error('视频代表帧未能写入缓存');
      return generated;
    } catch (error) {
      writeLog('warn', 'Video hover preview failed', { filePath, error: error.message || String(error) });
      return { success: false, cached: false, complete: false, duration: 0, frameUrls: [], error: error.message || String(error) };
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
        mediaCacheIndexes.delete(path.resolve(cacheDir));
        return { deletedCount: deletedPaths.length };
      });
      return { success: true, deletedCount: execution.result.deletedCount, taskId: execution.task.id };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
};

module.exports = { registerMediaIpc };
