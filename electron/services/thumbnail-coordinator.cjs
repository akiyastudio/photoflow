class ThumbnailCoordinator {
  constructor({ touchFlusher = async () => undefined, touchFlushDelayMs = 250 } = {}) {
    this.touchFlusher = touchFlusher;
    this.touchFlushDelayMs = touchFlushDelayMs;
    this.activeReaders = 0;
    this.maintenanceActive = false;
    this.maintenanceWaiting = 0;
    this.maintenanceYielding = false;
    this.maintenanceYieldResolver = null;
    this.readerQueue = [];
    this.maintenanceQueue = [];
    this.touches = new Map();
    this.touchTimer = null;
    this.touchFlushPromise = null;
  }

  withIndexer(worker) { return this.withReader('indexer', worker); }

  withPublisher(worker) { return this.withReader('publisher', worker); }

  withReader(_kind, worker) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.activeReaders += 1;
        Promise.resolve().then(worker).then(resolve, reject).finally(() => {
          this.activeReaders -= 1;
          this.drain();
        });
      };
      // Writer priority: once maintenance is waiting, later readers queue.
      if (!this.maintenanceYielding && !this.maintenanceActive && this.maintenanceWaiting === 0) run();
      else this.readerQueue.push(run);
    });
  }

  async yieldToReaders({ signal, deadlineAt } = {}) {
    if (!this.maintenanceActive || !this.readerQueue.length) return 0;
    if (signal?.aborted) throw signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' });
    const startedAt = Date.now();
    this.maintenanceYielding = true;
    this.maintenanceActive = false;
    const queued = this.readerQueue.splice(0);
    let deadlineTimer = null;
    try {
      const drained = new Promise((resolve, reject) => {
        this.maintenanceYieldResolver = resolve;
        if (Number.isFinite(deadlineAt)) {
          deadlineTimer = setTimeout(() => reject(Object.assign(
            new Error('thumbnail maintenance deadline exceeded while yielding to foreground readers'),
            { code: 'THUMBNAIL_MAINTENANCE_DEADLINE' },
          )), Math.max(1, deadlineAt - Date.now()));
        }
      });
      for (const run of queued) run();
      if (this.activeReaders) await drained;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.maintenanceYieldResolver = null;
      this.maintenanceYielding = false;
      this.maintenanceActive = true;
    }
    if (signal?.aborted) throw signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' });
    return Math.max(0, Date.now() - startedAt);
  }

  withMaintenance(options, worker) {
    if (typeof options === 'function') {
      worker = options;
      options = {};
    }
    const { signal, deadlineAt, onBlocked = () => undefined, onAdmitted = () => undefined } = options || {};
    if (signal?.aborted) return Promise.reject(signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' }));
    if (Number.isFinite(deadlineAt) && deadlineAt <= Date.now()) {
      return Promise.reject(Object.assign(new Error('thumbnail maintenance deadline exceeded'), { code: 'THUMBNAIL_MAINTENANCE_DEADLINE' }));
    }
    this.maintenanceWaiting += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadlineTimer = null;
      const cleanupWait = () => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const cancelWaiting = error => {
        if (settled) return;
        const index = this.maintenanceQueue.indexOf(run);
        if (index < 0) return;
        this.maintenanceQueue.splice(index, 1);
        this.maintenanceWaiting -= 1;
        settled = true;
        cleanupWait();
        reject(error);
        this.drain();
      };
      const onAbort = () => cancelWaiting(signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' }));
      const run = async () => {
        if (settled) return;
        settled = true;
        cleanupWait();
        this.maintenanceWaiting -= 1;
        this.maintenanceActive = true;
        try {
          await this.flushTouches();
          resolve(await worker());
        } catch (error) {
          reject(error);
        } finally {
          this.maintenanceActive = false;
          if (this.touches.size && !this.touchTimer) {
            this.touchTimer = setTimeout(() => {
              this.touchTimer = null;
              void this.flushTouches();
            }, this.touchFlushDelayMs);
            this.touchTimer.unref?.();
          }
          this.drain();
        }
      };
      this.maintenanceQueue.push(run);
      onAdmitted({ waiting: this.maintenanceWaiting, activeReaders: this.activeReaders });
      if (this.activeReaders || this.maintenanceActive || this.maintenanceQueue[0] !== run) {
        onBlocked({ phase: this.activeReaders ? 'waiting-indexer-publisher' : 'waiting-maintenance-turn', activeReaders: this.activeReaders });
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (Number.isFinite(deadlineAt)) {
        deadlineTimer = setTimeout(() => cancelWaiting(Object.assign(
          new Error('thumbnail maintenance deadline exceeded while waiting for publish/index'),
          { code: 'THUMBNAIL_MAINTENANCE_DEADLINE' },
        )), Math.max(0, deadlineAt - Date.now()));
      }
      this.drain();
    });
  }

  touch(filePath, sizeLabel) {
    const key = `${filePath}\0${sizeLabel}`;
    this.touches.set(key, { file_path: filePath, size_label: sizeLabel });
    if (this.maintenanceActive || this.maintenanceYielding || this.maintenanceWaiting) return;
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      void this.flushTouches();
    }, this.touchFlushDelayMs);
    this.touchTimer.unref?.();
  }

  flushTouches() {
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touchTimer = null;
    if (this.touchFlushPromise) return this.touchFlushPromise;
    if (!this.touches.size) return Promise.resolve({ success: true, count: 0 });
    const touches = [...this.touches.values()];
    this.touches.clear();
    const operation = Promise.resolve().then(() => this.touchFlusher(touches)).catch(error => {
      for (const touch of touches) this.touches.set(`${touch.file_path}\0${touch.size_label}`, touch);
      throw error;
    }).finally(() => {
      if (this.touchFlushPromise === operation) this.touchFlushPromise = null;
    });
    this.touchFlushPromise = operation;
    return operation;
  }

  drain() {
    if (this.maintenanceYielding) {
      if (!this.activeReaders) this.maintenanceYieldResolver?.();
      return;
    }
    if (this.maintenanceActive || this.activeReaders) return;
    if (this.maintenanceQueue.length) {
      const next = this.maintenanceQueue.shift();
      void next();
      return;
    }
    if (this.maintenanceWaiting) return;
    for (const run of this.readerQueue.splice(0)) run();
  }

  status() {
    return {
      activeReaders: this.activeReaders,
      maintenanceActive: this.maintenanceActive,
      maintenanceWaiting: this.maintenanceWaiting,
      queuedReaders: this.readerQueue.length,
      pendingTouches: this.touches.size,
    };
  }
}

module.exports = { ThumbnailCoordinator };
