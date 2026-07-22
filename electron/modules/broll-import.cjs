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

const BROLL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.mp4', '.mov', '.avi', '.m4v', '.mkv']);
const BROLL_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.m4v', '.mkv']);
const FOUR_GB = 4 * 1024 * 1024 * 1024;

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
}) => {
  ipcMain.handle('workspace-import-broll', async (event, workspacePath, status, projectName, options = {}) => {
    const operationId = crypto.randomUUID();
    const job = { cancelled: false, finishing: false };
    const publish = payload => {
      if (!event.sender.isDestroyed()) event.sender.send('workspace-file-operation-progress', {
        operationId,
        operation: 'import-broll',
        ...payload,
      });
    };
    const createdPaths = [];
    const moves = [];
    try {
      if (activeOperations.size) throw new Error('已有文件任务正在进行');
      const preserveOriginal = Boolean(options?.preserveOriginal ?? options?.clearSource === false);
      const splitLargeFiles = Boolean(options?.splitLargeFiles);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const choice = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择花絮文件',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '媒体文件', extensions: [...BROLL_EXTENSIONS].map(value => value.slice(1)) }],
      });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0, splitCount: 0, clearedCount: 0 };

      const destinationDir = assertInside(projectPath, path.join(projectPath, '花絮'), '花絮目录');
      await fs.promises.mkdir(destinationDir, { recursive: true });
      const sources = [];
      for (const selected of choice.filePaths) {
        const info = await assertRegularFile(selected);
        const extension = path.extname(info.path).toLowerCase();
        if (!BROLL_EXTENSIONS.has(extension)) throw new Error(`不支持的花絮文件格式：${path.basename(info.path)}`);
        sources.push({ ...info, extension });
      }
      const totalBytes = sources.reduce((sum, item) => sum + item.stat.size, 0);
      const splitBytes = sources.reduce((sum, item) => sum + (splitLargeFiles && BROLL_VIDEO_EXTENSIONS.has(item.extension) && item.stat.size > FOUR_GB ? item.stat.size : 0), 0);
      await assertDiskSpace(destinationDir, preserveOriginal ? totalBytes + splitBytes : splitBytes);
      activeOperations.set(operationId, job);
      publish({ phase: 'scanning', progress: 0, totalBytes, bytesCopied: 0, totalFiles: sources.length, filesCopied: 0 });

      const reserved = new Set();
      const sourcesToTrash = [];
      let completedBytes = 0;
      let completedFiles = 0;
      let splitCount = 0;
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
          splitCount += 1;
          if (!preserveOriginal) sourcesToTrash.push(item.path);
        } else if (preserveOriginal) {
          await copyFileAtomic(item.path, targetPath, {
            isCancelled: () => job.cancelled,
            onProgress: progress => report(item, progress.bytesCopied),
          });
          createdPaths.push(targetPath);
        } else {
          const moved = await moveFileAtomic(item.path, targetPath, {
            isCancelled: () => job.cancelled,
            onProgress: progress => report(item, progress.bytesCopied),
          });
          moves.push({ source: item.path, destination: targetPath });
          if (moved.copied) writeLog('info', 'B-roll crossed filesystems and was copied atomically before source removal', { source: item.path, destination: targetPath });
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
      writeLog('info', 'B-roll imported', { projectPath, count: sources.length, splitCount, clearedCount, totalBytes, warning });
      return { success: true, operationId, count: sources.length, splitCount, clearedCount, warning: warning || undefined };
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
      if (!cancelled) writeLog('error', 'B-roll import failed', { projectName, error: error.message || String(error) });
      return cancelled ? { success: true, cancelled: true, count: 0, splitCount: 0, clearedCount: 0 } : { success: false, error: error.message || String(error) };
    } finally {
      activeOperations.delete(operationId);
    }
  });
};

module.exports = { registerBrollImportIpc };
