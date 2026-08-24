const path = require('path');

const createImageThumbnailRuntime = ({
  crypto, fs, nativeImage, spawn, processSupervisor = null, getRunConfig, runPythonJsonAction,
  getMediaCacheDir, mediaThumbnailCacheFile, copyWindowsShellThumbnail,
  thumbnailVersion,
}) => {
  let imageWorkerSequence = 0;
  class ThumbnailImageWorkerPool {
    constructor(size) {
      this.size = size;
      this.workers = [];
      this.queue = [];
      this.nextId = 0;
      this.stopped = false;
    }

    run(source, kind, outputs, urgent = false) {
      if (this.stopped) return Promise.reject(new Error('图片解码服务已经停止'));
      return new Promise((resolve, reject) => {
        const job = { id: ++this.nextId, source, kind, outputs, resolve, reject };
        if (urgent) this.queue.unshift(job);
        else this.queue.push(job);
        this.pump();
      });
    }

    createWorker() {
      const { command, args } = getRunConfig('thumbnail_image.py', ['--server']);
      const managedProcess = processSupervisor?.launch({
        id: `python:thumbnail-image:${++imageWorkerSequence}`,
        kind: 'python-worker', command, args, options: { stdio: ['pipe', 'pipe', 'pipe'] }, ephemeral: true,
      });
      const child = managedProcess?.child || spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const worker = { child, managedProcess, output: '', stderr: '', job: null, timer: null, dead: false };
      this.workers.push(worker);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        worker.output += data;
        const lines = worker.output.split(/\r?\n/);
        worker.output = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let response;
          try { response = JSON.parse(line); } catch { continue; }
          if (!worker.job || response.id !== worker.job.id) continue;
          worker.managedProcess?.markHealthy({ protocol: 'json-lines' });
          const job = worker.job;
          worker.job = null;
          clearTimeout(worker.timer);
          worker.timer = null;
          if (response.success) job.resolve(response.generated || []);
          else {
            const error = new Error(response.error || '图片解码失败');
            error.code = response.code || 'EIMAGEDECODE';
            job.reject(error);
          }
          this.pump();
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', data => { worker.stderr = (worker.stderr + data).slice(-4000); });
      const finish = error => {
        if (worker.dead) return;
        worker.dead = true;
        clearTimeout(worker.timer);
        if (worker.job) worker.job.reject(error);
        worker.job = null;
        this.workers = this.workers.filter(item => item !== worker);
        if (!this.stopped) this.pump();
      };
      child.on('error', finish);
      child.on('exit', code => finish(new Error(worker.stderr.trim() || `图片解码服务退出，代码 ${code}`)));
      return worker;
    }

    pump() {
      if (this.stopped) return;
      while (this.workers.length < this.size && this.queue.length > this.workers.filter(worker => !worker.job && !worker.dead).length) this.createWorker();
      for (const worker of this.workers) {
        if (worker.dead || worker.job || !this.queue.length) continue;
        const job = this.queue.shift();
        worker.job = job;
        worker.timer = setTimeout(() => {
          if (worker.job === job) worker.child.kill();
        }, 120000);
        worker.child.stdin.write(`${JSON.stringify({ id: job.id, source: job.source, kind: job.kind, outputs: job.outputs })}\n`, error => {
          if (error && !worker.dead) worker.child.kill();
        });
      }
    }

    stop() {
      this.stopped = true;
      for (const job of this.queue.splice(0)) job.reject(new Error('图片解码服务已经停止'));
      for (const worker of this.workers) {
        if (worker.managedProcess) worker.managedProcess.stop('thumbnail-image-pool-stop');
        else if (!worker.child.killed) worker.child.kill();
      }
    }
  }

  let thumbnailPool = null;
  let originalPreviewPool = null;
  const runImageDecoderWithRawFallback = async (pool, sourcePath, kind, outputs, urgent) => {
    try {
      return await pool.run(sourcePath, kind, outputs, urgent);
    } catch (embeddedError) {
      if (kind !== 'raw') throw embeddedError;
      const result = await runPythonJsonAction('raw_decoder.py', ['--source', sourcePath, '--outputs', JSON.stringify(outputs)], 5 * 60 * 1000);
      if (!result?.success || !Array.isArray(result.generated)) throw new Error(result?.error || '内置 RAW 解码器未能生成预览');
      return result.generated;
    }
  };
  const generateImageThumbnailFiles = (sourcePath, kind, outputs, urgent = false) => {
    if (!thumbnailPool) thumbnailPool = new ThumbnailImageWorkerPool(2);
    return runImageDecoderWithRawFallback(thumbnailPool, sourcePath, kind, outputs, urgent);
  };
  const generateOriginalImagePreviewFile = (sourcePath, kind, outputs) => {
    if (!originalPreviewPool) originalPreviewPool = new ThumbnailImageWorkerPool(1);
    return runImageDecoderWithRawFallback(originalPreviewPool, sourcePath, kind, outputs, true);
  };
  const generateVideoCoverSource = (sourcePath, stat, cacheDir, requestedSize) => new Promise((resolve, reject) => {
    const cacheKey = crypto.createHash('sha256').update(`scheduler-video-cover|v${thumbnailVersion}|${requestedSize}|${sourcePath}|${stat.size}|${stat.mtimeMs}`).digest('hex');
    const toolArgs = ['--source', sourcePath, '--output_dir', cacheDir, '--cache_key', cacheKey, '--size', String(requestedSize)];
    const { command, args } = getRunConfig('video_preview.py', toolArgs);
    const managedProcess = processSupervisor?.launch({
      id: `python:video-preview:${++imageWorkerSequence}`,
      kind: 'python-job', command, args, options: {}, ephemeral: true,
    });
    const child = managedProcess?.child || spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const payloads = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        const payload = [...payloads].reverse().find(item => Array.isArray(item.frames) && item.frames.length);
        const errorPayload = [...payloads].reverse().find(item => item?.error);
        if (code !== 0 || !payload || !fs.existsSync(payload.frames[0])) throw new Error(stderr.trim() || errorPayload?.error || 'FFmpeg 未能生成视频封面');
        resolve(payload.frames[0]);
      } catch (error) { reject(error); }
    });
  });
  const writeThumbnailJpeg = async (target, image, quality) => {
    const temporary = `${target}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.promises.writeFile(temporary, image.toJPEG(quality));
      if (fs.existsSync(target)) await fs.promises.unlink(temporary);
      else await fs.promises.rename(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) await fs.promises.unlink(temporary);
    }
  };
  const generateThumbnailSet = async (sourcePath, stat, kind, cacheConfig, sizes) => {
    const cacheDir = getMediaCacheDir(cacheConfig);
    const ordered = [...sizes].sort((left, right) => right.pixels - left.pixels);
    const targets = new Map(ordered.map(size => [
      size.label,
      size.path ? path.resolve(size.path) : mediaThumbnailCacheFile(sourcePath, stat, cacheDir, size.pixels, thumbnailVersion),
    ]));
    let missing = ordered.filter(size => !fs.existsSync(targets.get(size.label)));
    if (!missing.length) return ordered.map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: targets.get(size.label) }));
    const largest = missing[0];
    const largestTarget = targets.get(largest.label);
    let generatedByShell = await copyWindowsShellThumbnail(sourcePath, largestTarget, largest.pixels, true);
    if (!generatedByShell) generatedByShell = await copyWindowsShellThumbnail(sourcePath, largestTarget, largest.pixels, false);
    if (generatedByShell) {
      missing = missing.slice(1);
      if (missing.length) await generateImageThumbnailFiles(largestTarget, 'image', missing.map(size => ({ sizeLabel: size.label, pixels: size.pixels, path: targets.get(size.label) })));
    } else if (kind === 'video') {
      const coverPath = await generateVideoCoverSource(sourcePath, stat, cacheDir, largest.pixels);
      await generateImageThumbnailFiles(coverPath, 'image', missing.map(size => ({ sizeLabel: size.label, pixels: size.pixels, path: targets.get(size.label) })));
    } else {
      try {
        await generateImageThumbnailFiles(sourcePath, kind === 'raw' ? 'raw' : 'image', missing.map(size => ({ sizeLabel: size.label, pixels: size.pixels, path: targets.get(size.label) })));
      } catch (decodeError) {
        if (kind === 'raw') throw decodeError;
        let fallbackGenerated = false;
        for (const size of missing) {
          const target = targets.get(size.label);
          let thumbnail = nativeImage.createEmpty();
          try { thumbnail = await nativeImage.createThumbnailFromPath(sourcePath, { width: size.pixels, height: size.pixels }); } catch {}
          if (!thumbnail.isEmpty()) {
            await writeThumbnailJpeg(target, thumbnail, size.pixels >= 960 ? 84 : 80);
            fallbackGenerated = true;
          }
        }
        if (!fallbackGenerated) throw decodeError;
      }
    }
    return ordered.filter(size => fs.existsSync(targets.get(size.label))).map(size => ({ sizeLabel: size.label, pixelSize: size.pixels, path: targets.get(size.label) }));
  };
  return {
    generateOriginalImagePreviewFile,
    generateThumbnailSet,
    stop: () => {
      thumbnailPool?.stop();
      originalPreviewPool?.stop();
    },
  };
};

module.exports = { createImageThumbnailRuntime };
