const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// v3 switches media covers from square crops to full-frame thumbnails.
const THUMBNAIL_VERSION = 3;
const THUMBNAIL_SIZES = [
  { label: 'small', pixels: 320 },
  { label: 'medium', pixels: 640 },
  { label: 'large', pixels: 1600 },
];
const PRIORITY = { visible: 0, nearby: 1, directory: 2, project: 3 };
const pathKey = filePath => process.platform === 'win32' ? path.resolve(filePath).toLocaleLowerCase() : path.resolve(filePath);

const chooseSize = requestedSize => {
  const requested = Math.max(1, Number(requestedSize) || 640);
  return THUMBNAIL_SIZES.find(item => requested <= item.pixels) || THUMBNAIL_SIZES[THUMBNAIL_SIZES.length - 1];
};

class ThumbnailDatabaseClient {
  constructor({ getRunConfig, databasePath, log, serviceArgs = [] }) {
    this.getRunConfig = getRunConfig;
    this.databasePath = databasePath;
    this.log = log;
    this.serviceArgs = serviceArgs;
    this.process = null;
    this.nextId = 0;
    this.pending = new Map();
    this.terminationReasons = new WeakMap();
  }

  ensureProcess() {
    if (this.process && !this.process.killed) return this.process;
    const run = this.getRunConfig('thumbnail_db.py', ['--server', '--db', this.databasePath, ...this.serviceArgs]);
    const child = spawn(run.command, run.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      output += data;
      const lines = output.split(/\r?\n/);
      output = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          const request = this.pending.get(response.id);
          if (!request || request.child !== child) continue;
          this.pending.delete(response.id);
          clearTimeout(request.timer);
          if (response.success) request.resolve(response.result);
          else request.reject(new Error(response.error || 'SQLite thumbnail service failed'));
        } catch (error) {
          this.log('warn', 'Unable to parse thumbnail database response', { error: error.message, line: line.slice(0, 500) });
        }
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    // A timed-out service is deliberately killed. Its writable stream may emit
    // EPIPE before the child exit event; consume it here and let pending calls
    // receive the more useful service-termination error below.
    child.stdin.on('error', () => undefined);
    const finish = (error) => {
      if (this.process === child) this.process = null;
      for (const [id, request] of this.pending.entries()) {
        if (request.child !== child) continue;
        clearTimeout(request.timer);
        request.reject(error);
        this.pending.delete(id);
      }
    };
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(this.terminationReasons.get(child) || stderr.trim() || `Thumbnail database service exited with code ${code}`)));
    return child;
  }

  call(op, args = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const child = this.ensureProcess();
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Thumbnail database request timed out: ${op}`));
        // A synchronous Python handler can be stuck in filesystem I/O. Merely
        // rejecting this request leaves every later operation trapped behind
        // it, so recycle the service and let the caller retry safely via WAL.
        if (this.process === child) {
          this.terminationReasons.set(child, `Thumbnail database service recycled after ${op} timed out`);
          this.process = null;
          if (!child.killed) child.kill();
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      try {
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`, error => {
          if (!error) return;
          const request = this.pending.get(id);
          if (!request || request.child !== child) return;
          this.pending.delete(id);
          clearTimeout(request.timer);
          request.reject(error);
        });
      } catch (error) {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        request.reject(error);
      }
    });
  }

  stop() {
    const child = this.process;
    this.process = null;
    if (child && !child.killed) child.kill();
  }
}

class MemoryThumbnailCache {
  constructor(maxBytes = 128 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.totalBytes = 0;
    this.items = new Map();
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    this.items.delete(key);
    this.items.set(key, item);
    return item.dataUrl;
  }

  put(key, previewUrl, bytes) {
    const current = this.items.get(key);
    if (current) this.totalBytes -= current.bytes;
    const item = { bytes, dataUrl: previewUrl };
    this.items.delete(key);
    this.items.set(key, item);
    this.totalBytes += item.bytes;
    while (this.totalBytes > this.maxBytes && this.items.size > 1) {
      const oldestKey = this.items.keys().next().value;
      const oldest = this.items.get(oldestKey);
      this.items.delete(oldestKey);
      this.totalBytes -= oldest.bytes;
    }
    return item.dataUrl;
  }

  deleteFile(filePath) {
    const prefix = `${pathKey(filePath)}|`;
    for (const [key, item] of this.items) {
      if (!key.startsWith(prefix)) continue;
      this.items.delete(key);
      this.totalBytes -= item.bytes;
    }
  }

  clear() {
    this.items.clear();
    this.totalBytes = 0;
  }
}

class ThumbnailPipeline {
  constructor({ getRunConfig, databasePath, getCacheDir, cacheFilePath, generateThumbnailSet,
    toPreviewUrl, trimCache, notify, log, concurrency = 2, maxBackgroundTasks = 1000 }) {
    this.databaseConfig = { getRunConfig, databasePath, log };
    this.database = new ThumbnailDatabaseClient(this.databaseConfig);
    this.getCacheDir = getCacheDir;
    this.cacheFilePath = cacheFilePath;
    this.generateThumbnailSet = generateThumbnailSet;
    this.toPreviewUrl = toPreviewUrl;
    this.trimCache = trimCache;
    this.notify = notify;
    this.log = log;
    this.concurrency = concurrency;
    this.maxBackgroundTasks = maxBackgroundTasks;
    this.activeWorkers = 0;
    this.memory = new MemoryThumbnailCache();
    this.tasks = new Map();
    this.queues = [[], [], [], []];
    this.directoryIndexes = new Map();
    this.projectScans = new Map();
    this.projectScanQueue = [];
    this.activeProjectScans = 0;
    this.projectScanPumpTimer = null;
    this.thumbnailPumpTimer = null;
    this.backgroundResumeTimer = null;
    this.lastForegroundActivityAt = Date.now();
    this.directoryIdleDelayMs = 1500;
    this.projectIdleDelayMs = 5000;
  }

  noteForegroundActivity() {
    this.lastForegroundActivityAt = Date.now();
    if (this.backgroundResumeTimer) clearTimeout(this.backgroundResumeTimer);
    this.backgroundResumeTimer = setTimeout(() => {
      this.backgroundResumeTimer = null;
      this.pump();
      this.pumpProjectScans();
    }, this.directoryIdleDelayMs);
  }

  backgroundWaitMs(priority) {
    const delay = priority >= PRIORITY.project ? this.projectIdleDelayMs : this.directoryIdleDelayMs;
    return Math.max(0, this.lastForegroundActivityAt + delay - Date.now());
  }

  scheduleBackgroundResume(waitMs) {
    if (this.backgroundResumeTimer) clearTimeout(this.backgroundResumeTimer);
    this.backgroundResumeTimer = setTimeout(() => {
      this.backgroundResumeTimer = null;
      this.pump();
      this.pumpProjectScans();
    }, Math.max(8, waitMs));
  }

  async waitForBackgroundIdle(priority) {
    let waitMs = this.backgroundWaitMs(priority);
    while (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
      waitMs = this.backgroundWaitMs(priority);
    }
  }

  cacheKey(filePath, stat, sizeLabel) {
    return `${pathKey(filePath)}|${stat.size}|${stat.mtimeMs}|${sizeLabel}|v${THUMBNAIL_VERSION}`;
  }

  targetFor(filePath, stat, cacheConfig, size) {
    return this.cacheFilePath(filePath, stat, this.getCacheDir(cacheConfig), size.pixels, THUMBNAIL_VERSION);
  }

  async readDisk(filePath, stat, cacheConfig, size) {
    const target = this.targetFor(filePath, stat, cacheConfig, size);
    let handle;
    let invalidThumbnail = false;
    try {
      const thumbnailStat = await fs.promises.stat(target);
      if (thumbnailStat.size < 128) {
        invalidThumbnail = true;
        throw new Error('thumbnail is empty or damaged');
      }
      handle = await fs.promises.open(target, 'r');
      const markers = Buffer.alloc(4);
      await handle.read(markers, 0, 2, 0);
      await handle.read(markers, 2, 2, thumbnailStat.size - 2);
      if (markers[0] !== 0xff || markers[1] !== 0xd8 || markers[2] !== 0xff || markers[3] !== 0xd9) {
        invalidThumbnail = true;
        throw new Error('thumbnail is empty or damaged');
      }
      await handle.close();
      handle = null;
      const now = new Date();
      void fs.promises.utimes(target, now, now).catch(() => undefined);
      const dataUrl = this.memory.put(this.cacheKey(filePath, stat, size.label), this.toPreviewUrl(target), thumbnailStat.size);
      void this.database.call('touch_thumbnail', { file_path: filePath, size_label: size.label }).catch(() => undefined);
      return { dataUrl, target };
    } catch {
      await handle?.close().catch(() => undefined);
      // A second renderer request can arrive while the worker for this source
      // is publishing a cache tier. Never let that reader delete a file owned
      // by the in-flight task. Only remove a positively identified stale file.
      if (invalidThumbnail && !this.tasks.has(pathKey(filePath))) await fs.promises.unlink(target).catch(() => undefined);
      return null;
    }
  }

  async request({ filePath, kind, cacheConfig = {}, requestedSize = 640, priority = PRIORITY.visible, queueOrder = Number.MAX_SAFE_INTEGER, requireDisk = false, forceRegenerate = false }) {
    if (priority <= PRIORITY.nearby) this.noteForegroundActivity();
    const sourcePath = path.resolve(filePath);
    const size = chooseSize(requestedSize);
    let stat;
    try {
      stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      void this.database.call('set_state', { file_path: sourcePath, state: 'MISSING' }).catch(() => undefined);
      return { success: false, state: 'MISSING', error: '原始文件不存在或磁盘离线' };
    }

    if (!requireDisk && !forceRegenerate) {
      const memoryUrl = this.memory.get(this.cacheKey(sourcePath, stat, size.label));
      if (memoryUrl) return { success: true, state: 'READY', previewUrl: memoryUrl, cacheLayer: 'memory', mediaUrl: kind === 'video' ? null : undefined };
    }

    // Merge the request into an existing task before touching its output. This
    // closes the read/delete race between a foreground request and generation.
    if (this.tasks.has(pathKey(sourcePath))) {
      this.enqueue({ filePath: sourcePath, kind, cacheConfig, stat, persistState: false, requestedSizes: [size], queueOrder, forceRegenerate }, priority);
      return { success: true, state: 'QUEUED', cacheLayer: 'source', mediaUrl: kind === 'video' ? null : undefined };
    }

    if (!forceRegenerate) {
      const disk = await this.readDisk(sourcePath, stat, cacheConfig, size);
      if (disk) return { success: true, state: 'READY', previewUrl: disk.dataUrl, cacheLayer: 'disk', mediaUrl: kind === 'video' ? null : undefined };
    }

    // The database index is durable metadata, not a prerequisite for showing
    // an image. Visible cache misses enter the scheduler immediately; index
    // and state writes are completed asynchronously in the background.
    this.enqueue({ filePath: sourcePath, kind, cacheConfig, stat, persistState: false, requestedSizes: [size], queueOrder }, priority);
    return { success: true, state: 'QUEUED', cacheLayer: 'source', mediaUrl: kind === 'video' ? null : undefined };
  }

  enqueue(input, priority = PRIORITY.project) {
    const sourcePath = path.resolve(input.filePath);
    const key = pathKey(sourcePath);
    const normalizedPriority = Math.max(0, Math.min(3, Number(priority) || 0));
    if (normalizedPriority <= PRIORITY.nearby) this.noteForegroundActivity();
    const queueOrder = Number.isFinite(Number(input.queueOrder)) ? Number(input.queueOrder) : Number.MAX_SAFE_INTEGER;
    const existing = this.tasks.get(key);
    if (existing) {
      existing.input = { ...existing.input, ...input, filePath: sourcePath };
      existing.order = Math.min(existing.order, queueOrder);
      for (const size of input.requestedSizes || [THUMBNAIL_SIZES[0]]) {
        existing.requestedSizes.set(size.label, size);
        if (input.forceRegenerate) existing.completedSizes.delete(size.label);
      }
      if (normalizedPriority < existing.priority && !existing.running) {
        existing.cancelled = true;
        const replacement = { key, input: existing.input, requestedSizes: existing.requestedSizes, completedSizes: existing.completedSizes, priority: normalizedPriority, order: existing.order, running: false, cancelled: false };
        this.tasks.set(key, replacement);
        this.queues[normalizedPriority].push(replacement);
        this.queues[normalizedPriority].sort((left, right) => left.order - right.order);
      } else if (!existing.running) {
        this.queues[existing.priority].sort((left, right) => left.order - right.order);
      }
      return;
    }
    if (normalizedPriority >= PRIORITY.directory && this.tasks.size >= this.maxBackgroundTasks) return;
    const requestedSizes = new Map((input.requestedSizes || [THUMBNAIL_SIZES[0]]).map(size => [size.label, size]));
    const task = { key, input: { ...input, filePath: sourcePath }, requestedSizes, completedSizes: new Set(), priority: normalizedPriority, order: queueOrder, running: false, cancelled: false };
    this.tasks.set(key, task);
    this.queues[normalizedPriority].push(task);
    this.queues[normalizedPriority].sort((left, right) => left.order - right.order);
    if (input.persistState !== false) void this.database.call('set_state', { file_path: sourcePath, state: 'QUEUED' }).catch(() => undefined);
    this.schedulePump();
  }

  schedulePump() {
    if (this.thumbnailPumpTimer) return;
    // Collect the IntersectionObserver requests from the same render frame so
    // visible tiles can be sorted by their actual list position before work
    // starts. Eight milliseconds is below one 60 Hz frame.
    this.thumbnailPumpTimer = setTimeout(() => {
      this.thumbnailPumpTimer = null;
      this.pump();
    }, 8);
  }

  cancel(filePath, requestedSize) {
    const key = pathKey(filePath);
    const task = this.tasks.get(key);
    if (!task || task.running) return false;
    task.requestedSizes.delete(chooseSize(requestedSize).label);
    if (task.requestedSizes.size) return true;
    task.cancelled = true;
    this.tasks.delete(key);
    return true;
  }

  nextTask(allowBackground) {
    const highestQueue = allowBackground ? PRIORITY.project : PRIORITY.nearby;
    for (let priority = PRIORITY.visible; priority <= highestQueue; priority += 1) {
      const queue = this.queues[priority];
      if (!queue.length) continue;
      if (priority >= PRIORITY.directory) {
        const waitMs = this.backgroundWaitMs(priority);
        if (waitMs > 0) {
          this.scheduleBackgroundResume(waitMs);
          return null;
        }
      }
      while (queue.length) {
        const task = queue.shift();
        if (!task.cancelled && this.tasks.get(task.key) === task) return task;
      }
    }
    return null;
  }

  pump() {
    while (this.activeWorkers < this.concurrency) {
      // Keep one slot free for a newly selected/visible item. Long-running RAW
      // or video background work must not occupy every decoder concurrently.
      const backgroundLimit = Math.max(1, this.concurrency - 1);
      const task = this.nextTask(this.activeWorkers < backgroundLimit);
      if (!task) break;
      task.running = true;
      this.activeWorkers += 1;
      void this.runTask(task).finally(() => {
        this.activeWorkers -= 1;
        if (this.tasks.get(task.key) === task) this.tasks.delete(task.key);
        this.pump();
      });
    }
  }

  async runTask(task) {
    const { filePath, kind, cacheConfig, sourceHash } = task.input;
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw Object.assign(new Error('原始文件不存在'), { code: 'ENOENT' });
    } catch (error) {
      const state = 'MISSING';
      void this.database.call('set_state', { file_path: filePath, state, error: error.message || String(error) }).catch(() => undefined);
      this.notify({ filePath, state, error: error.message || String(error) });
      this.log('warn', 'Thumbnail source is missing', { filePath, kind, state, error: error.message || String(error) });
      return;
    }
    try {
      this.notify({ filePath, state: 'GENERATING' });
      void this.database.call('set_state', { file_path: filePath, state: 'GENERATING' }).catch(() => undefined);
      while (true) {
        const requestedSizes = [...task.requestedSizes.values()].filter(size => !task.completedSizes.has(size.label));
        if (!requestedSizes.length) break;
        let generated;
        let metadata;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            generated = await this.generateThumbnailSet(filePath, stat, kind, cacheConfig, requestedSizes);
            if (!generated.length) throw Object.assign(new Error('缩略图缓存输出在生成后丢失'), { code: 'ECACHEMISS' });
            metadata = generated.map(item => ({
              sizeLabel: item.sizeLabel,
              pixelSize: item.pixelSize,
              path: item.path,
              fileSize: fs.statSync(item.path).size,
            }));
            break;
          } catch (error) {
            let sourceExists = false;
            try { sourceExists = (await fs.promises.stat(filePath)).isFile(); } catch { /* source is genuinely missing/offline */ }
            const cacheOutputMissing = error?.code === 'ENOENT' || error?.code === 'ECACHEMISS';
            if (attempt === 0 && sourceExists && cacheOutputMissing) {
              this.log('warn', 'Thumbnail cache output disappeared; retrying once', { filePath, error: error.message || String(error) });
              await new Promise(resolve => setTimeout(resolve, 25));
              continue;
            }
            throw error;
          }
        }
        const urls = {};
        for (const item of generated) {
          task.completedSizes.add(item.sizeLabel);
          const bytes = metadata.find(record => record.sizeLabel === item.sizeLabel)?.fileSize || 0;
          urls[item.sizeLabel] = this.memory.put(this.cacheKey(filePath, stat, item.sizeLabel), this.toPreviewUrl(item.path), bytes);
        }
        this.notify({ filePath, state: 'READY', previewUrls: urls });
        void this.database.call('mark_ready', {
          file_path: filePath,
          source_mtime_ms: stat.mtimeMs,
          source_digest: sourceHash || null,
          thumbnails: metadata,
        }).catch(error => this.log('warn', 'Thumbnail metadata update deferred', { filePath, error: error.message || String(error) }));
        this.trimCache(this.getCacheDir(cacheConfig), cacheConfig.maxSizeGB, generated.map(item => item.path));
      }
    } catch (error) {
      let sourceExists = false;
      try { sourceExists = (await fs.promises.stat(filePath)).isFile(); } catch { /* source is genuinely missing/offline */ }
      const state = sourceExists ? 'FAILED' : 'MISSING';
      void this.database.call('set_state', { file_path: filePath, state, error: error.message || String(error) }).catch(() => undefined);
      this.notify({ filePath, state, error: error.message || String(error) });
      this.log('warn', 'Thumbnail generation failed', { filePath, kind, state, error: error.message || String(error) });
    }
  }

  indexDirectory(projectRoot, directory, entries, cacheConfig) {
    const directoryKey = pathKey(directory);
    const existing = this.directoryIndexes.get(directoryKey);
    if (existing) return existing;
    const job = this.runDirectoryIndex(projectRoot, directory, entries, cacheConfig)
      .catch(error => {
        this.log('warn', 'Directory thumbnail index update failed', { directory, error: error.message || String(error) });
        return false;
      })
      .finally(() => this.directoryIndexes.delete(directoryKey));
    this.directoryIndexes.set(directoryKey, job);
    return job;
  }

  async runDirectoryIndex(projectRoot, directory, entries, cacheConfig) {
    // Let the renderer's visible thumbnail requests claim the disk first.
    // Directory indexing touches the same source and cache files and otherwise
    // creates a burst of duplicate I/O while a folder is opening.
    await new Promise(resolve => setTimeout(resolve, 50));
    await this.waitForBackgroundIdle(PRIORITY.directory);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.database.call('sync_directory', { project_root: projectRoot, directory }, 60 * 1000);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 750));
      }
    }
    if (lastError) throw lastError;

    const pending = [];
    for (const entry of entries) {
      if (!['image', 'raw', 'video'].includes(entry.kind)) continue;
      try {
        const stat = await fs.promises.stat(entry.path);
        const cached = THUMBNAIL_SIZES.map(size => ({ size, target: this.targetFor(entry.path, stat, cacheConfig, size) })).filter(item => fs.existsSync(item.target));
        if (cached.length) {
          void this.database.call('mark_ready', {
            file_path: entry.path,
            source_mtime_ms: stat.mtimeMs,
            source_digest: null,
            thumbnails: cached.map(item => ({
              sizeLabel: item.size.label,
              pixelSize: item.size.pixels,
              path: item.target,
              fileSize: fs.statSync(item.target).size,
            })),
          }).catch(() => undefined);
          if (cached.some(item => item.size.label === 'small')) continue;
        }
      } catch { /* the worker will classify missing/offline files */ }
      pending.push(entry);
    }
    if (pending.length) {
      await this.database.call('set_states', { file_paths: pending.map(entry => entry.path), state: 'QUEUED' }, 10 * 60 * 1000);
      for (const [index, entry] of pending.entries()) {
        this.enqueue({ filePath: entry.path, kind: entry.kind, cacheConfig, persistState: false, requestedSizes: [THUMBNAIL_SIZES[0]], queueOrder: index }, PRIORITY.directory);
      }
    }
    return true;
  }

  scanProject(projectRoot, cacheConfig) {
    const root = path.resolve(projectRoot);
    const current = this.projectScans.get(root);
    if (current) return current;
    let resolveScan;
    const scan = new Promise(resolve => { resolveScan = resolve; });
    this.projectScanQueue.push({ root, cacheConfig, resolve: resolveScan });
    this.projectScans.set(root, scan);
    this.pumpProjectScans();
    return scan;
  }

  pumpProjectScans() {
    if (this.activeProjectScans || !this.projectScanQueue.length) return;
    // Foreground directory indexes are intentionally drained first. Starting a
    // whole-project metadata scan while other projects are opening can otherwise
    // reintroduce writer-lock contention between the two SQLite connections.
    const idleWaitMs = this.backgroundWaitMs(PRIORITY.project);
    if (this.directoryIndexes.size || idleWaitMs > 0) {
      if (!this.projectScanPumpTimer) {
        this.projectScanPumpTimer = setTimeout(() => {
          this.projectScanPumpTimer = null;
          this.pumpProjectScans();
        }, Math.max(250, idleWaitMs));
      }
      return;
    }
    const job = this.projectScanQueue.shift();
    this.activeProjectScans = 1;
    const scanner = new ThumbnailDatabaseClient({ ...this.databaseConfig, serviceArgs: ['--no-recover'] });
    void scanner.call('sync_project', { project_root: job.root }, 30 * 60 * 1000)
      .then(result => {
        for (const [index, record] of (result.pending || []).entries()) {
          this.enqueue({ filePath: record.path, kind: record.kind, cacheConfig: job.cacheConfig, sourceHash: record.sourceHash, persistState: false, requestedSizes: [THUMBNAIL_SIZES[0]], queueOrder: index }, PRIORITY.project);
        }
        job.resolve(result);
      })
      .catch(error => {
        this.log('warn', 'Project thumbnail index scan failed', { projectRoot: job.root, error: error.message || String(error) });
        job.resolve(undefined);
      })
      .finally(() => {
        scanner.stop();
        this.projectScans.delete(job.root);
        this.activeProjectScans = 0;
        this.pumpProjectScans();
      });
  }

  async syncChangedPaths(projectRoot, filePaths, cacheConfig) {
    const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.avif']);
    const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
    const rawExtensions = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']);
    const mediaExtensions = new Set([...imageExtensions, ...videoExtensions, ...rawExtensions]);
    const mediaPaths = filePaths.filter(filePath => mediaExtensions.has(path.extname(filePath).toLowerCase()));
    const needsProjectScan = filePaths.some(filePath => !mediaExtensions.has(path.extname(filePath).toLowerCase()));

    // Watcher responsiveness must not depend on SQLite. New or modified media
    // enters the nearby queue immediately; the durable index catches up in a
    // best-effort background call.
    for (const filePath of mediaPaths) {
      const extension = path.extname(filePath).toLowerCase();
      const kind = videoExtensions.has(extension) ? 'video' : rawExtensions.has(extension) ? 'raw' : 'image';
      this.memory.deleteFile(filePath);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) throw new Error('not a file');
        this.notify({ filePath, state: 'QUEUED' });
        this.enqueue({ filePath, kind, cacheConfig, stat, persistState: false, requestedSizes: [THUMBNAIL_SIZES[0]] }, PRIORITY.nearby);
      } catch {
        this.notify({ filePath, state: 'MISSING' });
      }
    }

    if (mediaPaths.length) {
      void this.database.call('sync_paths', { project_root: projectRoot, paths: mediaPaths, calculate_hash: false }, 60 * 1000)
        .catch(error => this.log('warn', 'Thumbnail watcher index update deferred', { projectRoot, error: error.message || String(error) }));
    }
    if (needsProjectScan) void this.scanProject(projectRoot, cacheConfig);
    return { queued: mediaPaths.length, projectScanScheduled: needsProjectScan };
  }

  async invalidateDeleted(deletedPaths, beforeMs) {
    this.memory.clear();
    if (!beforeMs) {
      for (const [filePath, task] of this.tasks) {
        if (task.running) continue;
        task.cancelled = true;
        this.tasks.delete(filePath);
      }
    }
    await this.database.call('invalidate_cache', { deleted_paths: deletedPaths || null, before_ms: beforeMs || null });
  }

  stop() {
    if (this.projectScanPumpTimer) clearTimeout(this.projectScanPumpTimer);
    if (this.thumbnailPumpTimer) clearTimeout(this.thumbnailPumpTimer);
    if (this.backgroundResumeTimer) clearTimeout(this.backgroundResumeTimer);
    this.projectScanPumpTimer = null;
    this.thumbnailPumpTimer = null;
    this.backgroundResumeTimer = null;
    this.memory.clear();
    this.database.stop();
  }
}

module.exports = { ThumbnailPipeline, THUMBNAIL_SIZES, THUMBNAIL_VERSION, PRIORITY, chooseSize };
