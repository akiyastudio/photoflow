const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  CANCELLED_CODE,
  assertDiskSpace,
  assertInside,
  assertRegularFile,
  copyFileAtomic,
  moveFileAtomic,
  uniqueDestination,
} = require('../services/file-transfer-service.cjs');
const { createProjectFileTask } = require('../services/project-file-task-service.cjs');

const BROLL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.hif', '.mp4', '.mov', '.avi', '.m4v', '.mkv']);
const BROLL_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.m4v', '.mkv']);
const FOUR_GB = 4 * 1024 * 1024 * 1024;

const expandBrollSourcePaths = async selectedPaths => {
  const discovered = new Set();
  const visit = async (selectedPath, fromDirectory = false) => {
    const resolved = path.resolve(selectedPath);
    const stat = await fs.promises.lstat(resolved);
    if (stat.isDirectory()) {
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory()) await visit(path.join(resolved, entry.name), true);
        else if (entry.isFile() && BROLL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) discovered.add(path.join(resolved, entry.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`不支持导入此文件类型：${path.basename(resolved)}`);
    if (!BROLL_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      if (fromDirectory) return;
      throw new Error(`不支持的花絮文件格式：${path.basename(resolved)}`);
    }
    discovered.add(resolved);
  };
  for (const selectedPath of selectedPaths) await visit(selectedPath);
  return [...discovered];
};

const runSplitter = async ({ getRunConfig, source, outputDirectory, outputStem, extension, onProgress, isCancelled }) => {
  const prefix = `${outputStem}_part`;
  const listOutputs = async () => (await fs.promises.readdir(outputDirectory))
    .filter(name => name.startsWith(prefix) && path.extname(name).toLowerCase() === extension)
    .map(name => path.join(outputDirectory, name));
  const existingOutputs = new Set(await listOutputs());
  if (existingOutputs.size) {
    throw new Error(`目标分段文件已存在：${outputStem}_part…${extension}`);
  }
  const cleanupNewOutputs = async () => {
    for (const output of await listOutputs()) {
      if (!existingOutputs.has(output)) await fs.promises.rm(output, { force: true }).catch(() => undefined);
    }
  };
  return new Promise((resolve, reject) => {
  const { command, args } = getRunConfig('cut_video.py', [source, '--output-dir', outputDirectory, '--output-stem', outputStem]);
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let reportedError = '';
  const consumeLine = line => {
    if (!line.trim()) return;
    try {
      const payload = JSON.parse(line);
      if (payload.type === 'error') reportedError = payload.message || '视频分割失败';
      if (Number.isFinite(Number(payload.progress))) onProgress(Number(payload.progress), payload.message || '正在分割视频');
    } catch { /* non-JSON output is included in stderr diagnostics only */ }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    stdout += data;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || '';
    lines.forEach(consumeLine);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  child.on('error', reject);
  let cancellationSent = false;
  const cancellationTimer = setInterval(() => {
    if (!isCancelled() || cancellationSent) return;
    cancellationSent = true;
    child.stdin.write('cancel\n', error => {
      if (error && !child.killed) child.kill();
    });
  }, 200);
  child.on('close', async code => {
    clearInterval(cancellationTimer);
    if (stdout.trim()) consumeLine(stdout);
    if (isCancelled()) {
      await cleanupNewOutputs();
      return reject(Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE }));
    }
    if (code !== 0 || reportedError) {
      await cleanupNewOutputs();
      return reject(new Error(reportedError || stderr.trim() || `视频分割进程退出，代码 ${code}`));
    }
    const candidates = (await listOutputs()).filter(filePath => !existingOutputs.has(filePath));
    const outputs = [];
    for (const filePath of candidates) {
      try { if ((await fs.promises.stat(filePath)).size > 0) outputs.push(filePath); } catch { /* incomplete output */ }
    }
    outputs.sort();
    if (outputs.length < 2) {
      await cleanupNewOutputs();
      return reject(new Error(`视频分割未生成完整分段：${path.basename(source)}`));
    }
    resolve(outputs);
  });
  });
};

const runTranscoder = async ({ getRunConfig, source, settings, onProgress, isCancelled }) => new Promise((resolve, reject) => {
  const args = [
    source,
    '--container', settings?.container || 'mp4',
    '--video-mode', settings?.videoMode || 'h264',
    '--quality', settings?.quality || 'balanced',
    '--resolution', settings?.resolution || 'original',
    '--frame-rate', settings?.frameRate || 'original',
    '--audio-mode', settings?.audioMode || 'aac',
    '--output-mode', 'new',
  ];
  const runConfig = getRunConfig('ffmpeg_transcode.py', args);
  const child = spawn(runConfig.command, runConfig.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let output = '';
  let reportedError = '';
  const consumeLine = line => {
    if (!line.trim()) return;
    try {
      const payload = JSON.parse(line);
      if (payload.type === 'error') reportedError = payload.message || '视频转码失败';
      if (Number.isFinite(Number(payload.progress))) onProgress(Number(payload.progress), payload.message || '正在转码视频');
      if (payload.type === 'success' && Array.isArray(payload.outputs)) output = payload.outputs[0] || '';
    } catch { /* diagnostics are retained in stderr */ }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    stdout += data;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || '';
    lines.forEach(consumeLine);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  child.on('error', reject);
  let cancellationSent = false;
  const cancellationTimer = setInterval(() => {
    if (!isCancelled() || cancellationSent) return;
    cancellationSent = true;
    child.stdin.write('cancel\n', error => { if (error && !child.killed) child.kill(); });
  }, 200);
  child.on('close', code => {
    clearInterval(cancellationTimer);
    if (stdout.trim()) consumeLine(stdout);
    if (isCancelled()) return reject(Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE }));
    if (code !== 0 || reportedError || !output || !fs.existsSync(output)) return reject(new Error(reportedError || stderr.trim() || '视频转码未生成有效文件'));
    resolve(output);
  });
});

const registerBrollImportIpc = ({
  ipcMain,
  dialog,
  shell,
  recycleBinService,
  getMainWindow,
  getProjectPath,
  getRunConfig,
  writeLog,
  pushUndoOperation,
  activeOperations,
  backgroundTasks,
  getTelemetry,
}) => {
  ipcMain.handle('choose-broll-source-files', async () => {
    const choice = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择花絮文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '媒体文件', extensions: [...BROLL_EXTENSIONS].map(value => value.slice(1)) }],
    });
    return choice.canceled ? { cancelled: true, paths: [] } : { paths: choice.filePaths };
  });

  ipcMain.handle('workspace-import-broll', async (event, workspacePath, status, projectName, options = {}) => {
    const operationId = crypto.randomUUID();
    let job = { cancelled: false, finishing: false };
    let task = null;
    const publish = payload => task?.publish(payload);
    const createdPaths = [];
    const moves = [];
    try {
      const deleteSourceAfterImport = options?.deleteSourceAfterImport === true;
      const linkOnly = options?.linkOnly === true;
      const preserveOriginal = !deleteSourceAfterImport;
      const splitLargeFiles = Boolean(options?.splitVideosOnImport ?? options?.splitLargeFiles);
      const transcodeVideos = Boolean(options?.transcodeVideosOnImport);
      const transcodeSettings = options?.transcodeSettings || {};
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      let sourcePaths = Array.isArray(options?.sourcePaths) ? options.sourcePaths.map(source => String(source)) : [];
      if (!sourcePaths.length) {
        const choice = await dialog.showOpenDialog(getMainWindow(), {
          title: '选择花絮文件',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '媒体文件', extensions: [...BROLL_EXTENSIONS].map(value => value.slice(1)) }],
        });
        if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0, splitCount: 0, clearedCount: 0 };
        sourcePaths = choice.filePaths;
      }
      if (sourcePaths.length > 500) throw new Error('一次最多导入 500 个花絮文件或文件夹');

      const destinationDir = assertInside(projectPath, path.join(projectPath, '花絮'), '花絮目录');
      await fs.promises.mkdir(destinationDir, { recursive: true });
      if (linkOnly) {
        const reserved = new Set();
        for (const selected of sourcePaths) {
          const source = path.resolve(selected);
          const stat = await fs.promises.stat(source);
          if (!stat.isFile() && !stat.isDirectory()) throw new Error(`不支持创建外链：${path.basename(source)}`);
          const shortcutPath = uniqueDestination(destinationDir, `${path.basename(source)}.lnk`, reserved);
          if (!shell.writeShortcutLink(shortcutPath, { target: source, cwd: stat.isDirectory() ? source : path.dirname(source), description: `${stat.isDirectory() ? 'PhotoFlow 外链文件夹' : 'PhotoFlow 外链文件'}：${path.basename(source)}` })) throw new Error(`无法创建外链：${path.basename(source)}`);
          createdPaths.push(shortcutPath);
        }
        if (createdPaths.length) await pushUndoOperation({ kind: 'remove-created', paths: createdPaths, label: '导入花絮外链' });
        return { success: true, operationId, count: createdPaths.length, splitCount: 0, transcodeCount: 0, clearedCount: 0, linked: true };
      }
      sourcePaths = await expandBrollSourcePaths(sourcePaths);
      if (!sourcePaths.length) throw new Error('所选文件夹中没有可导入的花絮媒体文件');
      if (sourcePaths.length > 500) throw new Error('一次最多导入 500 个花絮文件');
      const sources = [];
      for (const selected of sourcePaths) {
        const info = await assertRegularFile(selected);
        const extension = path.extname(info.path).toLowerCase();
        if (!BROLL_EXTENSIONS.has(extension)) throw new Error(`不支持的花絮文件格式：${path.basename(info.path)}`);
        sources.push({ ...info, extension });
      }
      const totalBytes = sources.reduce((sum, item) => sum + item.stat.size, 0);
      const splitBytes = sources.reduce((sum, item) => sum + (splitLargeFiles && BROLL_VIDEO_EXTENSIONS.has(item.extension) && item.stat.size > FOUR_GB ? item.stat.size : 0), 0);
      await assertDiskSpace(destinationDir, preserveOriginal ? totalBytes + splitBytes : splitBytes);
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-broll', title: `导入花絮 · ${projectName}`,
        projectName,
        resources: [destinationDir, ...sources.map(source => source.path)],
        concurrencyGroup: splitLargeFiles || transcodeVideos ? 'heavy-media' : 'disk-io',
        concurrencyLimit: splitLargeFiles || transcodeVideos ? 1 : 3,
        concurrencyWriteLimit: splitLargeFiles || transcodeVideos ? 1 : 2,
        cancelledCode: CANCELLED_CODE,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeOperations.set(operationId, job);
      await task.start();
      publish({ phase: 'scanning', progress: 0, totalBytes, bytesCopied: 0, totalFiles: sources.length, filesCopied: 0 });

      const reserved = new Set();
      const sourcesToTrash = [];
      let completedBytes = 0;
      let completedFiles = 0;
      let splitCount = 0;
      let transcodeCount = 0;
      let lastPublishedAt = 0;
      const report = (item, itemBytes, phase = 'copying', detail) => {
        const now = Date.now();
        if (now - lastPublishedAt < 80 && itemBytes < item.stat.size) return;
        lastPublishedAt = now;
        const bytesCopied = Math.min(totalBytes, completedBytes + itemBytes);
        publish({
          phase,
          progress: totalBytes ? Math.min(99, Math.round(bytesCopied / totalBytes * 100)) : 0,
          currentName: detail || path.basename(item.path),
          bytesCopied,
          totalBytes,
          filesCopied: completedFiles,
          totalFiles: sources.length,
        });
      };

      for (const item of sources) {
        if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
        let targetPath = uniqueDestination(destinationDir, path.basename(item.path), reserved);
        const shouldSplit = splitLargeFiles && BROLL_VIDEO_EXTENSIONS.has(item.extension) && item.stat.size > FOUR_GB;
        let importedVideoPaths = [];
        if (shouldSplit) {
          while ((await fs.promises.readdir(destinationDir)).some(name => name.startsWith(`${path.parse(targetPath).name}_part`) && path.extname(name).toLowerCase() === item.extension)) {
            targetPath = uniqueDestination(destinationDir, path.basename(item.path), reserved);
          }
          const outputStem = path.parse(targetPath).name;
          const outputs = await runSplitter({
            getRunConfig,
            source: item.path,
            outputDirectory: destinationDir,
            outputStem,
            extension: item.extension,
            isCancelled: () => job.cancelled,
            onProgress: (progress, message) => report(item, item.stat.size * Math.max(0, Math.min(100, progress)) / 100, 'splitting', message),
          });
          createdPaths.push(...outputs);
          importedVideoPaths = outputs;
          splitCount += 1;
          if (!preserveOriginal) sourcesToTrash.push(item.path);
        } else if (preserveOriginal) {
          await copyFileAtomic(item.path, targetPath, {
            isCancelled: () => job.cancelled,
            onProgress: progress => report(item, progress.bytesCopied),
          });
          createdPaths.push(targetPath);
          if (BROLL_VIDEO_EXTENSIONS.has(item.extension)) importedVideoPaths = [targetPath];
        } else {
          const moved = await moveFileAtomic(item.path, targetPath, {
            isCancelled: () => job.cancelled,
            onProgress: progress => report(item, progress.bytesCopied),
          });
          moves.push({ source: item.path, destination: targetPath });
          if (BROLL_VIDEO_EXTENSIONS.has(item.extension)) importedVideoPaths = [targetPath];
          if (moved.copied) writeLog('info', 'B-roll crossed filesystems and was copied atomically before source removal', { source: item.path, destination: targetPath });
        }
        if (transcodeVideos) {
          for (const videoPath of importedVideoPaths) {
            const output = await runTranscoder({
              getRunConfig,
              source: videoPath,
              settings: transcodeSettings,
              isCancelled: () => job.cancelled,
              onProgress: (progress, message) => report(item, item.stat.size * Math.max(0, Math.min(100, progress)) / 100, 'transcoding', message),
            });
            createdPaths.push(output);
            transcodeCount += 1;
          }
        }
        completedBytes += item.stat.size;
        completedFiles += 1;
        report(item, item.stat.size);
      }

      job.finishing = true;
      publish({ phase: 'finishing', progress: 99, currentName: '正在完成花絮导入', bytesCopied: totalBytes, totalBytes, filesCopied: sources.length, totalFiles: sources.length });
      let clearedCount = moves.length;
      const cleanupWarnings = [];
      for (const source of sourcesToTrash) {
        try {
          await recycleBinService.trash(source);
          clearedCount += 1;
        } catch (error) {
          cleanupWarnings.push(`${path.basename(source)}：${error.message || String(error)}`);
        }
      }

      if (createdPaths.length && moves.length) await pushUndoOperation({ kind: 'broll-import', createdPaths: [...createdPaths], moves: [...moves], label: '导入花絮' });
      else if (createdPaths.length) await pushUndoOperation({ kind: 'remove-created', paths: [...createdPaths], label: '导入花絮' });
      else if (moves.length) await pushUndoOperation({ kind: 'external-move', moves: [...moves] });
      const warningParts = [];
      if (sourcesToTrash.length) warningParts.push('已分割的源视频位于系统回收站，撤销只会移除生成的分段');
      if (cleanupWarnings.length) warningParts.push(`部分源文件未能移入回收站：${cleanupWarnings.join('；')}`);
      const warning = warningParts.join('；');
      publish({ phase: 'complete', progress: 100, currentName: '花絮导入完成', bytesCopied: totalBytes, totalBytes, filesCopied: sources.length, totalFiles: sources.length });
      task.complete('花絮导入完成');
      writeLog('info', 'B-roll imported', { projectPath, count: sources.length, splitCount, transcodeCount, clearedCount, totalBytes, warning });
      const telemetry = getTelemetry?.();
      telemetry?.track('photos_imported', {
        count_bucket: telemetry.countBucket(sources.length),
        source: 'broll',
        media_kind: 'mixed',
      });
      return { success: true, operationId, count: sources.length, splitCount, transcodeCount, clearedCount, warning: warning || undefined };
    } catch (error) {
      for (const move of [...moves].reverse()) {
        try {
          if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) await moveFileAtomic(move.destination, move.source);
        } catch (rollbackError) {
          writeLog('error', 'Unable to roll back B-roll move', { move, error: rollbackError.message || String(rollbackError) });
        }
      }
      for (const created of [...createdPaths].reverse()) await fs.promises.rm(created, { force: true }).catch(() => undefined);
      const cancelled = error?.code === CANCELLED_CODE;
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, error: error.message || String(error) });
      if (cancelled) task?.cancelled();
      else task?.fail(error);
      if (!cancelled) writeLog('error', 'B-roll import failed', { projectName, error: error.message || String(error) });
      return cancelled ? { success: true, cancelled: true, count: 0, splitCount: 0, clearedCount: 0 } : { success: false, error: error.message || String(error) };
    } finally {
      activeOperations.delete(operationId);
    }
  });
};

module.exports = { registerBrollImportIpc };
