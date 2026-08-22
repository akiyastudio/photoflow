const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { spawn } = require('child_process');
const { ThumbnailCoordinator } = require('./services/thumbnail-coordinator.cjs');
const { stopProcessAndWait } = require('./services/process-supervisor.cjs');

// v3 switches media covers from square crops to full-frame thumbnails.
// v4 rejects undersized Windows Shell images that were previously cached as
// larger tiers and therefore looked visibly soft when the renderer enlarged them.
const THUMBNAIL_VERSION = 4;
const THUMBNAIL_MAINTENANCE_TIMEOUT_MS = 10 * 60 * 1000;
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
    this.processStops = new WeakMap();
    this.processReady = new WeakMap();
    this.terminationPromise = null;
  }

  stopChildAndWait(child, reason, timeoutMs = 2000) {
    const existing = this.processStops.get(child);
    if (existing) return existing;
    let resolveBarrier;
    const barrier = new Promise(resolve => { resolveBarrier = resolve; });
    this.processStops.set(child, barrier);
    this.terminationPromise = barrier;
    this.terminationReasons.set(child, reason);
    if (this.process === child) this.process = null;
    const managed = this.managedProcess?.child === child ? this.managedProcess : null;
    if (managed) this.managedProcess = null;
    const stopping = managed
      ? managed.stop(reason, { timeoutMs, rollbackSettleMs: 25 })
      : stopProcessAndWait(child, timeoutMs, { rollbackSettleMs: 25 });
    Promise.resolve(stopping).catch(() => undefined).then(resolveBarrier).finally(() => {
      if (this.terminationPromise === barrier) this.terminationPromise = null;
    });
    return barrier;
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
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.processReady.set(child, ready);
    void ready.catch(() => undefined);
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
          if (response.type === 'ready') {
            this.lastHandshake = response;
            resolveReady(response);
            continue;
          }
          const request = this.pending.get(response.id);
          if (!request || request.child !== child) continue;
          this.pending.delete(response.id);
          clearTimeout(request.timer);
          if (response.success) request.resolve(response.result);
          else {
            const error = new Error(response.error || 'SQLite thumbnail service failed');
            if (response.code) error.code = response.code;
            request.reject(error);
          }
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
    const finishRequests = (error) => {
      rejectReady(error);
      if (this.process === child) this.process = null;
      for (const [id, request] of this.pending.entries()) {
        if (request.child !== child) continue;
        clearTimeout(request.timer);
        request.reject(error);
        this.pending.delete(id);
      }
    };
    const finish = error => {
      const barrier = this.processStops.get(child);
      if (barrier) void barrier.then(() => finishRequests(error));
      else finishRequests(error);
    };
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(this.terminationReasons.get(child) || stderr.trim() || `Thumbnail database service exited with code ${code}`)));
  }

  call(op, args = {}, timeoutMs = 30000) {
    if (this.terminationPromise) return this.terminationPromise.then(() => this.call(op, args, timeoutMs));
    const child = this.ensureProcess();
    const ready = this.processReady.get(child);
    if (!ready) return Promise.reject(new Error('Thumbnail database service has no readiness handshake'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('Thumbnail database service readiness timed out'), { code: 'THUMBNAIL_DATABASE_READY_TIMEOUT' });
        void this.stopChildAndWait(child, 'thumbnail-database-readiness-timeout').then(() => reject(error));
      }, Math.min(10000, timeoutMs));
      ready.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    }).then(() => this.callReady(child, op, args, timeoutMs));
  }

  callReady(child, op, args = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        const timedOut = this.pending.get(id);
        if (!timedOut || timedOut.child !== child) return;
        this.pending.delete(id);
        const error = Object.assign(new Error(`Thumbnail database request timed out: ${op}`), { code: 'THUMBNAIL_DATABASE_TIMEOUT' });
        // A synchronous Python handler can be stuck in filesystem I/O. Merely
        // rejecting this request leaves every later operation trapped behind
        // it, so recycle the service and let the caller retry safely via WAL.
        void this.stopChildAndWait(child, `Thumbnail database service recycled after ${op} timed out`).then(() => reject(error));
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
    if (child) return this.stopChildAndWait(child, 'thumbnail-database-stop');
    if (this.managedProcess) {
      const managed = this.managedProcess;
      this.managedProcess = null;
      return managed.stop('thumbnail-database-stop');
    }
    return Promise.resolve();
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
    sourceStabilityDelayMs = 350, sourceStabilityProbeMs = 100, processSupervisor = null,
    databaseServiceArgs = [], resolveCacheDir = getCacheDir }) {
    this.databaseConfig = { getRunConfig, databasePath, log, processSupervisor, serviceArgs: databaseServiceArgs };
    this.database = new ThumbnailDatabaseClient(this.databaseConfig);
    this.resolveCacheDir = resolveCacheDir;
    this.coordinator = new ThumbnailCoordinator({
      touchFlusher: touches => this.database.call('touch_thumbnails', { touches }),
    });
    this.maintenanceContext = new AsyncLocalStorage();
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
    this.databaseMaintenanceDepth = 0;
    this.databaseMaintenanceTail = Promise.resolve();
    this.projectScanIdleWaiters = new Set();
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

  cacheDirectory(cacheConfig = {}) {
    return this.resolveCacheDir(cacheConfig);
  }

  ensureCacheDirectory(cacheConfig = {}) { return this.getCacheDir(cacheConfig); }

  async isSafeManagedCachePath(cacheRoot, candidate) {
    const root = path.resolve(cacheRoot);
    const resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const segments = relative.split(path.sep);
    const fileName = segments.at(-1) || '';
    const finalName = /^[0-9a-f]{64}\.jpg$/i.test(fileName) && segments.length === 1;
    const stagingName = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/i.test(fileName)
      && segments.length === 2 && segments[0] === '.staging';
    if (!finalName && !stagingName) return false;
    const stat = await fs.promises.lstat(resolved).catch(() => null);
    if (stat?.isSymbolicLink()) return false;
    const [realRoot, realParent] = await Promise.all([
      fs.promises.realpath(root).catch(() => root),
      fs.promises.realpath(path.dirname(resolved)).catch(() => path.dirname(resolved)),
    ]);
    const realRelative = path.relative(realRoot, realParent);
    return !realRelative.startsWith('..') && !path.isAbsolute(realRelative);
  }

  withIndexer(worker) {
    if (this.maintenanceContext.getStore()?.pipeline === this) return Promise.resolve().then(worker);
    return this.coordinator.withIndexer(worker);
  }

  maintenanceControl() { return this.maintenanceContext.getStore()?.control || null; }

  assertMaintenanceBoundary(control, phase, processedCount = 0) {
    control?.task?.throwIfCancelled?.();
    if (control?.signal?.aborted) throw control.signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' });
    if (Number.isFinite(control?.deadlineAt) && Date.now() >= control.deadlineAt) {
      throw Object.assign(new Error(`thumbnail maintenance deadline exceeded during ${phase}`), {
        code: 'THUMBNAIL_MAINTENANCE_DEADLINE',
        phase,
        processedCount,
      });
    }
    control?.onBlocked?.({ phase, processedCount, deadlineAt: control.deadlineAt });
  }

  maintenanceCallTimeout(control) {
    if (!Number.isFinite(control?.deadlineAt)) return THUMBNAIL_MAINTENANCE_TIMEOUT_MS;
    return Math.max(1, control.deadlineAt - Date.now());
  }

  async runThumbnailMigration(control, options) {
    let migrationCursor = options.migrationCursor && typeof options.migrationCursor === 'object'
      ? options.migrationCursor : {};
    while (true) {
      this.assertMaintenanceBoundary(control, 'thumbnail-cache-migration', control.processedCount);
      const migration = await this.database.call('run_thumbnail_cache_migration', {
        migration_version: options.migrationVersion,
        cursor: migrationCursor,
        limit: 512,
      }, this.maintenanceCallTimeout(control));
      migrationCursor = migration.cursor || migrationCursor;
      await this.database.call('maintenance_state_save', {
        key: options.completeMigrationKey,
        cursor: migrationCursor,
      }, this.maintenanceCallTimeout(control));
      control.processedCount += Number(migration.processed) || 0;
      if (!migration.done) continue;
      await this.database.call('maintenance_state_complete', {
        key: options.completeMigrationKey,
        cursor: { ...migrationCursor, migrationVersion: options.migrationVersion, userVersion: 2 },
      }, this.maintenanceCallTimeout(control));
      return migration;
    }
  }

  async withMaintenanceDeadline(operation, control, phase) {
    if (!Number.isFinite(control?.deadlineAt)) return operation;
    const remaining = control.deadlineAt - Date.now();
    if (remaining <= 0) this.assertMaintenanceBoundary(control, phase, control.processedCount || 0);
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(
            new Error(`thumbnail maintenance deadline exceeded during ${phase}`),
            { code: 'THUMBNAIL_MAINTENANCE_DEADLINE', phase, processedCount: control.processedCount || 0 },
          )), Math.max(1, remaining));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async waitForMaintenanceDependency(promise, control, phase) {
    while (true) {
      this.assertMaintenanceBoundary(control, phase, control.processedCount || 0);
      const pending = Symbol('pending');
      const result = await Promise.race([
        Promise.resolve(promise),
        new Promise(resolve => setTimeout(() => resolve(pending), 50)),
      ]);
      if (result !== pending) return result;
    }
  }

  setPersistentState(filePath, state, error = null) {
    return this.withIndexer(() => this.database.call('set_state', { file_path: filePath, state, error }));
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
      const durable = await this.coordinator.withIndexer(() => this.database.call('get_thumbnail_publish', {
        file_path: filePath,
        size_label: size.label,
        source_size: stat.size,
        source_mtime_ms: stat.mtimeMs,
      }));
      if (!durable || pathKey(durable.thumbnailPath) !== pathKey(target)) return null;
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
      this.coordinator.touch(filePath, size.label);
      return { previewUrl: this.toPreviewUrl(cachedPath), target };
    } catch {
      await handle?.close().catch(() => undefined);
      // A second renderer request can arrive while the worker for this source
      // is publishing a cache tier. Never let that reader delete a file owned
      // by the in-flight task. Only remove a positively identified stale file.
      if (invalidThumbnail && !this.tasks.has(pathKey(filePath))) {
        await this.evictCache({ thumbnailPaths: [target] }).catch(() => undefined);
      }
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
      void this.setPersistentState(sourcePath, 'MISSING').catch(() => undefined);
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
    const accepted = this.enqueue({ filePath: sourcePath, kind, cacheConfig, stat, persistState: false, requestedSizes: [size], queueOrder }, priority);
    if (!accepted) {
      return { success: false, state: 'NOT_READY', error: '缩略图任务队列繁忙，请稍后重试', cacheLayer: 'source', mediaUrl: kind === 'video' ? null : undefined };
    }
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
      return true;
    }
    if (normalizedPriority >= PRIORITY.directory && this.tasks.size >= this.maxBackgroundTasks) return false;
    const requestedSizes = new Map((input.requestedSizes || [THUMBNAIL_SIZES[0]]).map(size => [size.label, size]));
    const task = { key, input: { ...input, filePath: sourcePath }, requestedSizes, completedSizes: new Set(), priority: normalizedPriority, order: queueOrder, running: false, cancelled: false };
    this.tasks.set(key, task);
    this.queues[normalizedPriority].push(task);
    this.queues[normalizedPriority].sort((left, right) => left.order - right.order);
    if (input.persistState !== false) void this.setPersistentState(sourcePath, 'QUEUED').catch(() => undefined);
    this.schedulePump();
    return true;
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

  async generateStagedThumbnailSet(filePath, stat, kind, cacheConfig, requestedSizes) {
    const cacheRoot = path.resolve(this.getCacheDir(cacheConfig));
    const stagingRoot = path.join(cacheRoot, '.staging');
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    const plan = new Map(requestedSizes.map(size => [size.label, {
      size,
      stagingPath: path.join(stagingRoot, `${crypto.randomUUID()}.jpg`),
      finalPath: this.targetFor(filePath, stat, cacheConfig, size),
    }]));
    let generated;
    try {
      generated = await this.generateThumbnailSet(
        filePath,
        stat,
        kind,
        cacheConfig,
        requestedSizes.map(size => ({ ...size, path: plan.get(size.label).stagingPath })),
      );
      const staged = [];
      for (const item of generated) {
        const target = plan.get(item.sizeLabel);
        if (!target) continue;
        const returnedPath = path.resolve(item.path);
        if (pathKey(returnedPath) !== pathKey(target.stagingPath)) {
          await fs.promises.rename(returnedPath, target.stagingPath);
        }
        const stagedStat = await fs.promises.stat(target.stagingPath);
        staged.push({
          sizeLabel: item.sizeLabel,
          pixelSize: item.pixelSize,
          stagingPath: target.stagingPath,
          finalPath: target.finalPath,
          fileSize: stagedStat.size,
        });
      }
      return staged;
    } catch (error) {
      await Promise.all([...plan.values()].map(item => fs.promises.unlink(item.stagingPath).catch(() => undefined)));
      throw error;
    }
  }

  async publishStagedThumbnailSet(filePath, capture, staged) {
    const ownedFinals = [];
    const publishId = crypto.randomUUID();
    let published = [];
    let publishRequest = null;
    try {
      return await this.coordinator.withPublisher(async () => {
        const currentSource = await fs.promises.stat(filePath);
        if (!currentSource.isFile() || currentSource.size !== capture.sourceSize || currentSource.mtimeMs !== capture.sourceMtimeMs) {
          throw Object.assign(new Error('thumbnail source changed before publish'), { code: 'SOURCE_STALE' });
        }
        const currentEpoch = await this.database.call('get_cache_epoch', {});
        if (currentEpoch.cacheEpoch !== capture.cacheEpoch) {
          throw Object.assign(new Error('thumbnail cache epoch changed before publish'), { code: 'EPOCH_STALE' });
        }
        published = [];
        for (const item of staged) {
          await fs.promises.mkdir(path.dirname(item.finalPath), { recursive: true });
          let ownsFinal = false;
          if (await fs.promises.access(item.finalPath).then(() => true, () => false)) {
            await fs.promises.unlink(item.stagingPath).catch(() => undefined);
          } else {
            await fs.promises.rename(item.stagingPath, item.finalPath);
            ownsFinal = true;
            ownedFinals.push(item.finalPath);
          }
          const finalStat = await fs.promises.stat(item.finalPath);
          published.push({
            sizeLabel: item.sizeLabel,
            pixelSize: item.pixelSize,
            path: item.finalPath,
            fileSize: finalStat.size,
            ownsFinal,
          });
        }
        publishRequest = {
          publish_id: publishId,
          file_path: filePath,
          cache_epoch: capture.cacheEpoch,
          source_version: capture.sourceVersion,
          source_size: capture.sourceSize,
          source_mtime_ms: capture.sourceMtimeMs,
          source_digest: capture.sourceDigest || null,
          thumbnails: published.map(({ ownsFinal: _ownsFinal, ...item }) => item),
        };
        await this.database.call('commit_thumbnail_publish', publishRequest);
        return published;
      });
    } catch (error) {
      await Promise.all(staged.map(item => fs.promises.unlink(item.stagingPath).catch(() => undefined)));
      const explicitlyRejected = error?.code === 'EPOCH_STALE' || error?.code === 'SOURCE_STALE';
      if (explicitlyRejected) {
        await Promise.all(ownedFinals.map(item => fs.promises.unlink(item).catch(() => undefined)));
        throw error;
      }
      try {
        const outcome = await this.resolveThumbnailPublish(publishId, publishRequest);
        if (outcome?.state === 'COMMITTED') return published;
      } catch (resolutionError) {
        if (resolutionError?.code === 'EPOCH_STALE' || resolutionError?.code === 'SOURCE_STALE') {
          await Promise.all(ownedFinals.map(item => fs.promises.unlink(item).catch(() => undefined)));
          throw resolutionError;
        }
      }
      // Ambiguous after bounded reconnection attempts: keep owned finals. They
      // are either the committed publication or safe orphans for startup
      // recovery; deleting them could corrupt a committed READY row.
      error.publishOutcome = 'unknown';
      this.log('warn', 'Thumbnail publish result remains ambiguous; preserving final files', {
        filePath,
        publishId,
        error: error.message || String(error),
      });
      throw error;
    }
  }

  async resolveThumbnailPublish(publishId, publishRequest, attempts = 4) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const receipt = await this.database.call('resolve_thumbnail_publish', { publish_id: publishId }, 30 * 1000);
        if (receipt?.state === 'COMMITTED') return receipt;
        if (receipt?.state === 'NOT_FOUND' && publishRequest) {
          const result = await this.database.call('commit_thumbnail_publish', publishRequest, 30 * 1000);
          return { state: 'COMMITTED', committed: true, publishId, result };
        }
      } catch (error) {
        if (error?.code === 'EPOCH_STALE' || error?.code === 'SOURCE_STALE') throw error;
        if (attempt === attempts - 1) return null;
        this.log('warn', 'Unable to resolve thumbnail publish result; reconnecting', {
          publishId,
          attempt: attempt + 1,
          error: error.message || String(error),
        });
      }
      if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
    return null;
  }

  async runTask(task) {
    const { filePath, kind, cacheConfig, sourceHash } = task.input;
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw Object.assign(new Error('原始文件不存在'), { code: 'ENOENT' });
    } catch (error) {
      const state = 'MISSING';
      void this.setPersistentState(filePath, state, error.message || String(error)).catch(() => undefined);
      this.notify({ filePath, state, error: error.message || String(error) });
      this.log('warn', 'Thumbnail source is missing', { filePath, kind, state, error: error.message || String(error) });
      return;
    }
    try {
      this.notify({ filePath, state: 'GENERATING' });
      void this.setPersistentState(filePath, 'GENERATING').catch(() => undefined);
      while (true) {
        const requestedSizes = [...task.requestedSizes.values()].filter(size => !task.completedSizes.has(size.label));
        if (!requestedSizes.length) break;
        let published;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const capture = await this.coordinator.withIndexer(() => this.database.call('capture_thumbnail_publish', {
              file_path: filePath,
              kind,
            }));
            stat = await fs.promises.stat(filePath);
            const staged = await this.generateStagedThumbnailSet(filePath, stat, kind, cacheConfig, requestedSizes);
            if (!staged.length) throw Object.assign(new Error('缩略图缓存输出在生成后丢失'), { code: 'ECACHEMISS' });
            published = await this.publishStagedThumbnailSet(filePath, { ...capture, sourceDigest: sourceHash || null }, staged);
            break;
          } catch (error) {
            let sourceExists = false;
            try { sourceExists = (await fs.promises.stat(filePath)).isFile(); } catch { /* source is genuinely missing/offline */ }
            const retryable = error?.code === 'ENOENT' || error?.code === 'ECACHEMISS'
              || error?.code === 'EPOCH_STALE' || error?.code === 'SOURCE_STALE';
            if (attempt === 0 && sourceExists && retryable) {
              this.log('warn', 'Thumbnail publish became stale; retrying with a fresh epoch', { filePath, code: error?.code, error: error.message || String(error) });
              await new Promise(resolve => setTimeout(resolve, 25));
              continue;
            }
            if (sourceExists && (error?.code === 'EPOCH_STALE' || error?.code === 'SOURCE_STALE')) {
              const freshStat = await fs.promises.stat(filePath);
              this.notify({ filePath, state: 'STALE', sourceMtimeMs: freshStat.mtimeMs, sourceSize: freshStat.size });
              void this.setPersistentState(filePath, 'STALE').catch(() => undefined);
              setTimeout(() => this.enqueue({
                ...task.input,
                filePath,
                stat: freshStat,
                forceRegenerate: true,
                requestedSizes,
              }, task.priority), 0);
              return;
            }
            throw error;
          }
        }
        const urls = {};
        for (const item of published) {
          task.completedSizes.add(item.sizeLabel);
          const cachedPath = this.memory.put(this.cacheKey(filePath, stat, item.sizeLabel), item.path, item.fileSize);
          urls[item.sizeLabel] = this.toPreviewUrl(cachedPath);
        }
        // Durable DB commit happens in publishStagedThumbnailSet. Only now may
        // memory state and renderer visibility advance to READY.
        this.notify({ filePath, state: 'READY', previewUrls: urls });
        this.trimCache(this.getCacheDir(cacheConfig), cacheConfig.maxSizeGB, published.map(item => item.path));
      }
    } catch (error) {
      let sourceExists = false;
      try { sourceExists = (await fs.promises.stat(filePath)).isFile(); } catch { /* source is genuinely missing/offline */ }
      const state = sourceExists ? 'FAILED' : 'MISSING';
      void this.setPersistentState(filePath, state, error.message || String(error)).catch(() => undefined);
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
        await this.coordinator.withIndexer(() => this.database.call('sync_directory', { project_root: projectRoot, directory }, 60 * 1000));
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
          const capture = await this.coordinator.withIndexer(() => this.database.call('capture_thumbnail_publish', {
            file_path: entry.path,
            kind: entry.kind,
            project_root: projectRoot,
          }));
          const thumbnails = await Promise.all(cached.map(async item => ({
              sizeLabel: item.size.label,
              pixelSize: item.size.pixels,
              path: item.target,
              fileSize: (await fs.promises.stat(item.target)).size,
          })));
          await this.coordinator.withPublisher(() => this.database.call('commit_thumbnail_publish', {
            publish_id: crypto.randomUUID(),
            file_path: entry.path,
            cache_epoch: capture.cacheEpoch,
            source_version: capture.sourceVersion,
            source_size: capture.sourceSize,
            source_mtime_ms: capture.sourceMtimeMs,
            source_digest: null,
            thumbnails,
          })).catch(() => undefined);
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

  async runDatabaseMaintenance(worker, options = {}) {
    const existingContext = this.maintenanceContext.getStore();
    if (existingContext?.pipeline === this) return worker(existingContext.control);
    const control = {
      signal: options.signal || options.task?.signal,
      task: options.task || null,
      deadlineAt: Number.isFinite(options.deadlineAt) ? options.deadlineAt : Date.now() + THUMBNAIL_MAINTENANCE_TIMEOUT_MS,
      onBlocked: options.onBlocked || (() => undefined),
      onAdmitted: options.onAdmitted || (() => undefined),
      processedCount: 0,
    };
    this.assertMaintenanceBoundary(control, 'waiting-maintenance-turn', 0);
    let releaseTurn;
    const previousTurn = this.databaseMaintenanceTail;
    this.databaseMaintenanceTail = new Promise(resolve => { releaseTurn = resolve; });
    this.databaseMaintenanceDepth += 1;
    try {
      await this.waitForMaintenanceDependency(previousTurn, control, 'waiting-maintenance-turn');
      while (this.activeProjectScans) {
        await this.waitForMaintenanceDependency(
          new Promise(resolve => setTimeout(resolve, 50)),
          control,
          'waiting-project-scan',
        );
      }
      return await this.coordinator.withMaintenance({
        signal: control.signal,
        deadlineAt: control.deadlineAt,
        onAdmitted: control.onAdmitted,
        onBlocked: details => control.onBlocked({ ...details, processedCount: control.processedCount, deadlineAt: control.deadlineAt }),
      }, async () => {
        if (typeof options.preflight === 'function') {
          this.assertMaintenanceBoundary(control, 'maintenance-preflight', control.processedCount);
          await options.preflight(control);
        }
        this.assertMaintenanceBoundary(control, 'begin-cache-maintenance', control.processedCount);
        await this.database.call('begin_cache_maintenance', {}, this.maintenanceCallTimeout(control));
        this.memory.clear();
        return this.maintenanceContext.run({ pipeline: this, control }, () => worker(control));
      });
    } finally {
      this.databaseMaintenanceDepth = Math.max(0, this.databaseMaintenanceDepth - 1);
      releaseTurn();
      if (!this.databaseMaintenanceDepth) this.pumpProjectScans();
    }
  }

  async inspectToolSources(projectRoot, filePaths, collectVideos = false, collectDirectPng = false, collectRecursivePng = false) {
    const root = path.resolve(projectRoot);
    if (this.projectScans.has(root) || (this.projectIndexUpdates.get(root) || 0) > 0) return { indexed: false, hasVideo: false, hasPng: false, videoPaths: [], pngPaths: [] };
    return this.withIndexer(() => this.database.call('inspect_tool_sources', {
      project_root: root,
      paths: filePaths.map(filePath => path.resolve(filePath)),
      collect_videos: Boolean(collectVideos),
      collect_direct_png: Boolean(collectDirectPng),
      collect_recursive_png: Boolean(collectRecursivePng),
    }));
  }

  pumpProjectScans() {
    if (this.databaseMaintenanceDepth || this.activeProjectScans || !this.projectScanQueue.length) return;
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
    void this.coordinator.withIndexer(() => scanner.call('sync_project', { project_root: job.root }, 30 * 60 * 1000))
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
        for (const resolve of this.projectScanIdleWaiters) resolve();
        this.projectScanIdleWaiters.clear();
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
      await this.coordinator.withIndexer(() => this.database.call('sync_paths', { project_root: projectRoot, paths: mediaPaths, calculate_hash: false }, 60 * 1000))
        .catch(error => this.log('warn', 'Thumbnail watcher index update deferred', { projectRoot, error: error.message || String(error) }));
    }
    if (needsProjectScan) void this.scanProject(projectRoot, cacheConfig);
    return { queued: mediaPaths.length, projectScanScheduled: needsProjectScan };
  }

  async invalidateDeleted(deletedPaths, beforeMs) {
    if (!beforeMs) {
      for (const [filePath, task] of this.tasks) {
        if (task.running) continue;
        task.cancelled = true;
        this.tasks.delete(filePath);
      }
    }
    return this.evictCache(deletedPaths
      ? { thumbnailPaths: deletedPaths }
      : beforeMs ? { beforeMs } : { all: true });
  }

  async listCacheCleanupCandidates(beforeMs, cacheRoot = null) {
    return this.database.call('list_cache_cleanup', { before_ms: beforeMs, cache_root: cacheRoot }, THUMBNAIL_MAINTENANCE_TIMEOUT_MS);
  }

  async evictCache(options = {}) {
    return this.runDatabaseMaintenance(async control => {
      this.memory.clear();
      const physicalPaths = new Map();
      let detachedCount = 0;
      let detachedBytes = 0;
      let prunedSourceCount = 0;
      let repairedMissingCount = 0;
      let completedRecoveryCursor = options.recoveryCursor && typeof options.recoveryCursor === 'object'
        ? options.recoveryCursor : {};
      const collect = result => {
        detachedCount += Number(result?.detachedCount) || 0;
        detachedBytes += Number(result?.detachedBytes) || 0;
        for (const value of result?.thumbnailPaths || []) {
          const resolved = path.resolve(value);
          physicalPaths.set(pathKey(resolved), resolved);
        }
        control.processedCount = detachedCount;
      };

      const detachSelector = async selector => {
        while (true) {
          this.assertMaintenanceBoundary(control, 'detach-cache-batch', control.processedCount);
          const result = await this.database.call('detach_cache_batch', { ...selector, limit: 512 }, this.maintenanceCallTimeout(control));
          collect(result);
          if (result.done || (options.bytesToFree && detachedBytes >= Number(options.bytesToFree))) break;
        }
      };

      if (options.thumbnailPaths) {
        const values = [...new Set(options.thumbnailPaths.map(value => path.resolve(value)))];
        for (let offset = 0; offset < values.length; offset += 512) {
          await detachSelector({ thumbnail_paths: values.slice(offset, offset + 512) });
        }
        for (const value of values) physicalPaths.set(pathKey(value), value);
      } else if (options.sourcePaths) {
        const values = [...new Set(options.sourcePaths.map(value => path.resolve(value)))];
        for (let offset = 0; offset < values.length; offset += 512) {
          await detachSelector({ source_paths: values.slice(offset, offset + 512) });
        }
      } else if (options.all || options.beforeMs != null || options.bytesToFree) {
        await detachSelector({
          cache_root: options.cacheRoot || null,
          before_ms: options.beforeMs ?? null,
          all_cache: options.all === true || options.bytesToFree != null,
          exclude_paths: options.excludePaths || [],
        });
      }

      if (options.pruneMissing) {
        while (true) {
          this.assertMaintenanceBoundary(control, 'prune-missing-batch', control.processedCount);
          const result = await this.database.call('prune_missing_batch', { limit: 512, cache_root: options.cacheRoot || null }, this.maintenanceCallTimeout(control));
          collect(result);
          prunedSourceCount += Number(result.sourceCount) || 0;
          if (result.done) break;
        }
      }

      const deletedPaths = [];
      const failedPaths = [];
      const physicalRetryFailures = [];
      const physicalRetryClears = [];
      let deletedBytes = 0;
      for (const filePath of physicalPaths.values()) {
        this.assertMaintenanceBoundary(control, 'delete-cache-files', control.processedCount + deletedPaths.length + failedPaths.length);
        if (options.cacheRoot && !await this.isSafeManagedCachePath(options.cacheRoot, filePath)) {
          failedPaths.push(filePath);
          this.log('warn', 'Skipped unsafe thumbnail cache deletion path', { cacheRoot: options.cacheRoot, filePath });
          continue;
        }
        try {
          const fileSize = await this.withMaintenanceDeadline(
            fs.promises.stat(filePath).then(stat => stat.size, () => 0), control, 'stat-cache-file',
          );
          await this.withMaintenanceDeadline(fs.promises.unlink(filePath), control, 'delete-cache-file');
          deletedPaths.push(filePath);
          deletedBytes += fileSize;
          physicalRetryClears.push(filePath);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            deletedPaths.push(filePath);
            physicalRetryClears.push(filePath);
          } else {
            failedPaths.push(filePath);
            physicalRetryFailures.push({ path: filePath, error: error?.message || String(error) });
          }
        }
      }
      if (options.cacheRoot && physicalRetryClears.length) {
        await this.database.call('clear_orphan_delete_retries', {
          thumbnail_paths: physicalRetryClears,
        }, this.maintenanceCallTimeout(control));
      }
      if (options.cacheRoot && physicalRetryFailures.length) {
        await this.database.call('record_orphan_delete_failures', {
          cache_root: options.cacheRoot,
          failures: physicalRetryFailures,
        }, this.maintenanceCallTimeout(control));
      }

      if (options.recoverOrphans && options.cacheRoot
          && (!options.bytesToFree || deletedBytes < Number(options.bytesToFree))) {
        let recoveryCursor = completedRecoveryCursor;
        const attempted = new Set([
          ...[...physicalPaths.values()].map(value => pathKey(value)),
          ...(options.excludePaths || []).map(value => pathKey(value)),
        ]);
        while (true) {
          const pageFailureCount = failedPaths.length;
          this.assertMaintenanceBoundary(control, 'recover-cache-publications', control.processedCount + deletedPaths.length + failedPaths.length);
          const recovered = await this.database.call('recover_cache_publications', {
            cache_root: options.cacheRoot,
            before_ms: options.orphanBeforeMs ?? options.beforeMs ?? null,
            scan_root_orphans: options.scanRootOrphans !== false,
            generation: String(recoveryCursor.generation || ''),
            generation_max_row_id: Number(recoveryCursor.generationMaxRowId) || 0,
            after_row_id: Number(recoveryCursor.afterRowId) || 0,
            inspect_limit: 2048,
            delete_limit: 512,
            directory_cursor: recoveryCursor.directory || {},
          }, this.maintenanceCallTimeout(control));
          recoveryCursor = recovered.cursor || {
            generation: String(recoveryCursor.generation || ''),
            generationMaxRowId: Number(recovered.generationMaxRowId) || 0,
            afterRowId: Number(recovered.afterRowId) || 0,
            lastCompletedAt: 0,
            directory: recovered.directoryCursor || {},
          };
          completedRecoveryCursor = recoveryCursor;
          repairedMissingCount += Number(recovered.repairedMissingCount) || 0;
          control.processedCount = detachedCount + repairedMissingCount + prunedSourceCount;
          if (!recovered.orphanPaths?.length) {
            if (options.completeMaintenanceKey) {
              await this.database.call('maintenance_state_save', {
                key: options.completeMaintenanceKey,
                cursor: recoveryCursor,
              }, this.maintenanceCallTimeout(control));
            }
            if (recovered.done) break;
            continue;
          }
          let newCandidateCount = 0;
          const clearedRetryPaths = [];
          const retryFailures = [];
          for (const value of recovered.orphanPaths) {
            if (options.bytesToFree && deletedBytes >= Number(options.bytesToFree)) break;
            this.assertMaintenanceBoundary(control, 'delete-orphan-files', control.processedCount + deletedPaths.length + failedPaths.length);
            const filePath = path.resolve(value);
            const candidateKey = pathKey(filePath);
            if (attempted.has(candidateKey)) continue;
            attempted.add(candidateKey);
            newCandidateCount += 1;
            if (!await this.isSafeManagedCachePath(options.cacheRoot, filePath)) {
              failedPaths.push(filePath);
              retryFailures.push({ path: filePath, error: 'unsafe managed cache path' });
              this.log('warn', 'Skipped unsafe thumbnail orphan deletion path', { cacheRoot: options.cacheRoot, filePath });
              continue;
            }
            try {
              const fileSize = await this.withMaintenanceDeadline(
                fs.promises.stat(filePath).then(stat => stat.size, () => 0), control, 'stat-orphan-file',
              );
              await this.withMaintenanceDeadline(fs.promises.unlink(filePath), control, 'delete-orphan-file');
              deletedPaths.push(filePath);
              deletedBytes += fileSize;
              clearedRetryPaths.push(filePath);
            } catch (error) {
              if (error?.code === 'ENOENT') {
                deletedPaths.push(filePath);
                clearedRetryPaths.push(filePath);
              } else {
                failedPaths.push(filePath);
                retryFailures.push({ path: filePath, error: error?.message || String(error) });
              }
            }
          }
          if (clearedRetryPaths.length) {
            await this.database.call('clear_orphan_delete_retries', {
              thumbnail_paths: clearedRetryPaths,
            }, this.maintenanceCallTimeout(control));
          }
          if (retryFailures.length) {
            await this.database.call('record_orphan_delete_failures', {
              cache_root: options.cacheRoot,
              failures: retryFailures,
            }, this.maintenanceCallTimeout(control));
          }
          if (options.completeMaintenanceKey && failedPaths.length === pageFailureCount) {
            await this.database.call('maintenance_state_save', {
              key: options.completeMaintenanceKey,
              cursor: recoveryCursor,
            }, this.maintenanceCallTimeout(control));
          }
          if (options.failOnDeleteError && failedPaths.length > pageFailureCount) break;
          if (recovered.done || newCandidateCount === 0
              || (options.bytesToFree && deletedBytes >= Number(options.bytesToFree))) break;
        }
      }

      const result = {
        success: true,
        detachedCount,
        detachedBytes,
        deletedBytes,
        deletedCount: deletedPaths.length,
        failedCount: failedPaths.length,
        deletedPaths,
        failedPaths,
        prunedSourceCount,
        repairedMissingCount,
      };
      if (options.failOnDeleteError && failedPaths.length) {
        throw Object.assign(new Error(`thumbnail cache recovery left ${failedPaths.length} unsafe or unavailable paths`), {
          code: 'THUMBNAIL_CACHE_RECOVERY_INCOMPLETE',
          result,
        });
      }
      if (options.completeMaintenanceKey) {
        await this.database.call('maintenance_state_complete', {
          key: options.completeMaintenanceKey,
          cursor: completedRecoveryCursor,
        }, this.maintenanceCallTimeout(control));
      }
      return result;
    }, {
      signal: options.signal,
      deadlineAt: options.deadlineAt,
      task: options.task,
      onBlocked: options.onBlocked,
      onAdmitted: options.onAdmitted,
      preflight: options.completeMigrationKey
        ? control => this.runThumbnailMigration(control, options)
        : options.verifyIntegrity
          ? control => this.database.call('check_integrity', {}, this.maintenanceCallTimeout(control))
          : null,
    });
  }

  async maintenanceState(key) {
    return this.withIndexer(() => this.database.call('maintenance_state_get', { key }));
  }

  async saveMaintenanceState(key, cursor) {
    return this.withIndexer(() => this.database.call('maintenance_state_save', { key, cursor }));
  }

  async cleanupOrphanCache(cacheRoot, beforeMs, intervalMs) {
    void intervalMs;
    return this.evictCache({ cacheRoot, recoverOrphans: true, orphanBeforeMs: beforeMs });
  }

  async invalidateSources(sourcePaths) {
    return this.evictCache({ sourcePaths: sourcePaths || [] });
  }

  async pruneMissingSources() {
    return this.evictCache({ pruneMissing: true });
  }

  stop() {
    if (this.projectScanPumpTimer) clearTimeout(this.projectScanPumpTimer);
    if (this.thumbnailPumpTimer) clearTimeout(this.thumbnailPumpTimer);
    if (this.backgroundResumeTimer) clearTimeout(this.backgroundResumeTimer);
    this.projectScanPumpTimer = null;
    this.thumbnailPumpTimer = null;
    this.sourceChangeVersions.clear();
    this.projectIndexUpdates.clear();
    for (const resolve of this.projectScanIdleWaiters) resolve();
    this.projectScanIdleWaiters.clear();
    this.backgroundResumeTimer = null;
    this.memory.clear();
    this.database.stop();
  }
}

module.exports = { ThumbnailPipeline, THUMBNAIL_SIZES, THUMBNAIL_VERSION, PRIORITY, chooseSize, isThumbnailSizeSufficient };
