const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// v3 switches media covers from square crops to full-frame thumbnails.
// v4 rejects undersized Windows Shell images that were previously cached as
// larger tiers and therefore looked visibly soft when the renderer enlarged them.
const THUMBNAIL_VERSION = 4;
const THUMBNAIL_SIZES = [
  { label: 'small', pixels: 320 },
  { label: 'medium', pixels: 640 },
  { label: 'large', pixels: 1600 },
];
const PRIORITY = { visible: 0, nearby: 1, directory: 2, project: 3 };
const pathKey = filePath => process.platform === 'win32' ? path.resolve(filePath).toLocaleLowerCase() : path.resolve(filePath);
const isInternalTransientMediaPath = filePath => path.resolve(filePath)
  .split(path.sep)
  .some(segment => {
    const normalized = segment.toLowerCase();
    return normalized.startsWith('.') && normalized.includes('.photoflow-transcode')
      || /^\.photoflow-(?:import-|paste|replace|split-|undo|team-workflow-)/i.test(normalized);
  });

const chooseSize = requestedSize => {
  const requested = Math.max(1, Number(requestedSize) || 640);
  return THUMBNAIL_SIZES.find(item => requested <= item.pixels) || THUMBNAIL_SIZES[THUMBNAIL_SIZES.length - 1];
};

const isThumbnailSizeSufficient = (width, height, requestedSize) => {
  const longestEdge = Math.max(Number(width) || 0, Number(height) || 0);
  const requested = Math.max(1, Number(requestedSize) || 640);
  return longestEdge >= Math.ceil(requested * 0.75);
};

let thumbnailDatabaseSequence = 0;

class ThumbnailDatabaseClient {
  constructor({ getRunConfig, databasePath, log, serviceArgs = [], processSupervisor = null }) {
    this.getRunConfig = getRunConfig;
    this.databasePath = databasePath;
    this.log = log;
    this.serviceArgs = serviceArgs;
    this.processSupervisor = processSupervisor;
    this.processId = `python:thumbnail-database:${++thumbnailDatabaseSequence}`;
    this.managedProcess = null;
    this.process = null;
    this.nextId = 0;
    this.pending = new Map();
    this.terminationReasons = new WeakMap();
  }

  ensureProcess() {
    if (this.process && !this.process.killed) return this.process;
    if (this.managedProcess && !this.managedProcess.released) {
      if (this.managedProcess.child && !this.managedProcess.child.killed) return this.managedProcess.child;
      if (this.managedProcess.state === 'restarting') return this.managedProcess.start();
      this.managedProcess.release();
      this.managedProcess = null;
    }
    const run = this.getRunConfig('thumbnail_db.py', ['--server', '--db', this.databasePath, ...this.serviceArgs]);
    if (this.processSupervisor) {
      this.managedProcess = this.processSupervisor.launch({
        id: this.processId,
        kind: 'python-worker',
        command: run.command,
        args: run.args,
        options: { stdio: ['pipe', 'pipe', 'pipe'] },
        restart: { enabled: true, maxRestarts: 3, windowMs: 60000, backoffMs: [100, 400, 1200] },
        onSpawn: (child, managed) => this.attachProcess(child, managed),
      });
      return this.managedProcess.child;
    }
    const child = spawn(run.command, run.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.attachProcess(child, null);
    return child;
  }

  attachProcess(child, managedProcess) {
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
          managedProcess?.markHealthy({ protocol: 'json-lines' });
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
          if (this.managedProcess?.child === child) {
            this.managedProcess.stop(`request-timeout:${op}`);
            this.managedProcess = null;
          } else if (!child.killed) child.kill();
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
    if (this.managedProcess) {
      this.managedProcess.stop('thumbnail-database-stop');
      this.managedProcess = null;
    } else if (child && !child.killed) child.kill();
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
    return item.filePath;
  }

  put(key, filePath, bytes) {
    const current = this.items.get(key);
    if (current) this.totalBytes -= current.bytes;
    // Cache the durable thumbnail path, not its expiring media-access URL.
    // A fresh grant must be issued every time the thumbnail is returned.
    const item = { bytes, filePath };
    this.items.delete(key);
    this.items.set(key, item);
    this.totalBytes += item.bytes;
    while (this.totalBytes > this.maxBytes && this.items.size > 1) {
      const oldestKey = this.items.keys().next().value;
      const oldest = this.items.get(oldestKey);
      this.items.delete(oldestKey);
      this.totalBytes -= oldest.bytes;
    }
    return item.filePath;
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
    toPreviewUrl, trimCache, notify, log, concurrency = 2, maxBackgroundTasks = 1000,
    sourceStabilityDelayMs = 350, sourceStabilityProbeMs = 100, processSupervisor = null }) {
    this.databaseConfig = { getRunConfig, databasePath, log, processSupervisor };
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
    this.projectIndexUpdates = new Map();
    this.projectScanQueue = [];
    this.activeProjectScans = 0;
    this.projectScanPumpTimer = null;
    this.thumbnailPumpTimer = null;
    this.backgroundResumeTimer = null;
    this.sourceChangeVersions = new Map();
    this.sourceStabilityDelayMs = sourceStabilityDelayMs;
    this.sourceStabilityProbeMs = sourceStabilityProbeMs;
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
      const cachedPath = this.memory.put(this.cacheKey(filePath, stat, size.label), target, thumbnailStat.size);
      void this.database.call('touch_thumbnail', { file_path: filePath, size_label: size.label }).catch(() => undefined);
      return { previewUrl: this.toPreviewUrl(cachedPath), target };
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
      const memoryPath = this.memory.get(this.cacheKey(sourcePath, stat, size.label));
      if (memoryPath) return { success: true, state: 'READY', previewUrl: this.toPreviewUrl(memoryPath), cacheLayer: 'memory', mediaUrl: kind === 'video' ? null : undefined };
    }

    // Merge the request into an existing task before touching its output. This
    // closes the read/delete race between a foreground request and generation.
    if (this.tasks.has(pathKey(sourcePath))) {
      this.enqueue({ filePath: sourcePath, kind, cacheConfig, stat, persistState: false, requestedSizes: [size], queueOrder, forceRegenerate }, priority);
      return { success: true, state: 'QUEUED', cacheLayer: 'source', mediaUrl: kind === 'video' ? null : undefined };
    }

    if (!forceRegenerate) {
      const disk = await this.readDisk(sourcePath, stat, cacheConfig, size);
      if (disk) return { success: true, state: 'READY', previewUrl: disk.previewUrl, cacheLayer: 'disk', mediaUrl: kind === 'video' ? null : undefined };
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
            metadata = await Promise.all(generated.map(async item => ({
              sizeLabel: item.sizeLabel,
              pixelSize: item.pixelSize,
              path: item.path,
              fileSize: (await fs.promises.stat(item.path)).size,
            })));
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
          const cachedPath = this.memory.put(this.cacheKey(filePath, stat, item.sizeLabel), item.path, bytes);
          urls[item.sizeLabel] = this.toPreviewUrl(cachedPath);
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

    for (const entry of entries) {
      if (!['image', 'raw', 'video'].includes(entry.kind)) continue;
      try {
        const stat = await fs.promises.stat(entry.path);
        const candidates = THUMBNAIL_SIZES.map(size => ({ size, target: this.targetFor(entry.path, stat, cacheConfig, size) }));
        const cached = [];
        for (const item of candidates) if (await fs.promises.access(item.target).then(() => true, () => false)) cached.push(item);
        if (cached.length) {
          void this.database.call('mark_ready', {
            file_path: entry.path,
            source_mtime_ms: stat.mtimeMs,
            source_digest: null,
            thumbnails: await Promise.all(cached.map(async item => ({
              sizeLabel: item.size.label,
              pixelSize: item.size.pixels,
              path: item.target,
              fileSize: (await fs.promises.stat(item.target)).size,
            }))),
          }).catch(() => undefined);
        }
      } catch { /* the worker will classify missing/offline files */ }
    }
    // Directory indexing is metadata-only. MediaThumbnail requests visible and
    // near-visible tiles through IntersectionObserver; warming every uncached
    // file here kept HDDs at 100% long after the UI had finished loading.
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

  async inspectToolSources(projectRoot, filePaths, collectVideos = false, collectDirectPng = false, collectRecursivePng = false) {
    const root = path.resolve(projectRoot);
    if (this.projectScans.has(root) || (this.projectIndexUpdates.get(root) || 0) > 0) return { indexed: false, hasVideo: false, hasPng: false, videoPaths: [], pngPaths: [] };
    return this.database.call('inspect_tool_sources', {
      project_root: root,
      paths: filePaths.map(filePath => path.resolve(filePath)),
      collect_videos: Boolean(collectVideos),
      collect_direct_png: Boolean(collectDirectPng),
      collect_recursive_png: Boolean(collectRecursivePng),
    });
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
    const root = path.resolve(projectRoot);
    this.projectIndexUpdates.set(root, (this.projectIndexUpdates.get(root) || 0) + 1);
    try {
      return await this.runChangedPathSync(root, filePaths, cacheConfig);
    } finally {
      const remaining = (this.projectIndexUpdates.get(root) || 1) - 1;
      if (remaining > 0) this.projectIndexUpdates.set(root, remaining);
      else this.projectIndexUpdates.delete(root);
    }
  }

  async runChangedPathSync(projectRoot, filePaths, cacheConfig) {
    const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif']);
    const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
    const rawExtensions = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']);
    const mediaExtensions = new Set([...imageExtensions, ...videoExtensions, ...rawExtensions]);
    const visibleFilePaths = filePaths.filter(filePath => !isInternalTransientMediaPath(filePath));
    const mediaPaths = [...new Map(visibleFilePaths
      .filter(filePath => mediaExtensions.has(path.extname(filePath).toLowerCase()))
      .map(filePath => [pathKey(filePath), path.resolve(filePath)])).values()];
    const needsProjectScan = visibleFilePaths.some(filePath => !mediaExtensions.has(path.extname(filePath).toLowerCase()));

    // Editors often emit several watcher events while a file is still being
    // replaced. Keep the old thumbnail visible during that short window, then
    // invalidate it only after size and mtime have settled. A newer event
    // supersedes the pending probe for the same path.
    const changed = await Promise.all(mediaPaths.map(async filePath => {
      const key = pathKey(filePath);
      const version = (this.sourceChangeVersions.get(key) || 0) + 1;
      this.sourceChangeVersions.set(key, version);
      this.memory.deleteFile(filePath);
      await new Promise(resolve => setTimeout(resolve, this.sourceStabilityDelayMs));
      if (this.sourceChangeVersions.get(key) !== version) return null;
      try {
        let stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) throw new Error('not a file');
        await new Promise(resolve => setTimeout(resolve, this.sourceStabilityProbeMs));
        if (this.sourceChangeVersions.get(key) !== version) return null;
        const confirmed = await fs.promises.stat(filePath);
        if (!confirmed.isFile()) throw new Error('not a file');
        if (confirmed.size !== stat.size || confirmed.mtimeMs !== stat.mtimeMs) {
          await new Promise(resolve => setTimeout(resolve, this.sourceStabilityDelayMs));
          if (this.sourceChangeVersions.get(key) !== version) return null;
          stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) throw new Error('not a file');
        } else {
          stat = confirmed;
        }
        this.sourceChangeVersions.delete(key);
        const extension = path.extname(filePath).toLowerCase();
        const kind = videoExtensions.has(extension) ? 'video' : rawExtensions.has(extension) ? 'raw' : 'image';
        this.notify({ filePath, state: 'STALE', sourceMtimeMs: stat.mtimeMs, sourceSize: stat.size });
        this.enqueue({ filePath, kind, cacheConfig, stat, persistState: false, requestedSizes: [THUMBNAIL_SIZES[0]], forceRegenerate: true }, PRIORITY.nearby);
        return filePath;
      } catch {
        if (this.sourceChangeVersions.get(key) !== version) return null;
        this.sourceChangeVersions.delete(key);
        this.notify({ filePath, state: 'MISSING' });
        return null;
      }
    }));
    if (mediaPaths.length) {
      await this.database.call('sync_paths', { project_root: projectRoot, paths: mediaPaths, calculate_hash: false }, 60 * 1000)
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

  async invalidateSources(sourcePaths) {
    this.memory.clear();
    const result = await this.database.call('invalidate_sources', { source_paths: sourcePaths || [] });
    await Promise.all((result.thumbnailPaths || []).map(filePath => fs.promises.unlink(filePath).catch(() => undefined)));
    return result;
  }

  async pruneMissingSources() {
    this.memory.clear();
    const result = await this.database.call('prune_missing_sources');
    await Promise.all((result.thumbnailPaths || []).map(filePath => fs.promises.unlink(filePath).catch(() => undefined)));
    return result;
  }

  stop() {
    if (this.projectScanPumpTimer) clearTimeout(this.projectScanPumpTimer);
    if (this.thumbnailPumpTimer) clearTimeout(this.thumbnailPumpTimer);
    if (this.backgroundResumeTimer) clearTimeout(this.backgroundResumeTimer);
    this.projectScanPumpTimer = null;
    this.thumbnailPumpTimer = null;
    this.sourceChangeVersions.clear();
    this.projectIndexUpdates.clear();
    this.backgroundResumeTimer = null;
    this.memory.clear();
    this.database.stop();
  }
}

module.exports = { ThumbnailPipeline, THUMBNAIL_SIZES, THUMBNAIL_VERSION, PRIORITY, chooseSize, isThumbnailSizeSufficient };
