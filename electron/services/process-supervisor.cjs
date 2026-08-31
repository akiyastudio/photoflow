const { EventEmitter } = require('events');
const { spawn: defaultSpawn } = require('child_process');
const { stopProcessAndWait, terminateAndWait } = require('../infrastructure/process-termination.cjs');

const DEFAULT_RESTART_POLICY = Object.freeze({ enabled: false, maxRestarts: 0, windowMs: 60000, backoffMs: [100, 300, 1000] });
const safeError = error => error?.message || String(error || 'unknown error');

class ManagedProcess extends EventEmitter {
  constructor(supervisor, specification) {
    super();
    this.supervisor = supervisor;
    this.specification = specification;
    this.id = specification.id;
    this.kind = specification.kind || 'process';
    this.protocol = String(specification.protocol || '');
    this.owner = specification.owner && typeof specification.owner === 'object' ? Object.freeze({ ...specification.owner }) : null;
    this.child = null;
    this.generation = 0;
    this.state = 'idle';
    this.startedAt = 0;
    this.lastHealthyAt = 0;
    this.lastExit = null;
    this.stderrTail = '';
    this.restartTimes = [];
    this.restartTimer = null;
    this.healthTimer = null;
    this.stopping = false;
    this.released = false;
    this.lifecycle = null;
  }

  start() {
    if (this.released) throw new Error(`Managed process has been released: ${this.id}`);
    if (this.child && !this.child.killed) return this.child;
    if (this.lifecycle && !this.lifecycle.settled) {
      return this.lifecycle.settledPromise.then(() => this.start());
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopping = false;
    this.state = 'starting';
    this.startedAt = this.supervisor.now();
    this.stderrTail = '';
    const generation = ++this.generation;
    const spec = this.specification;
    let child;
    try {
      child = this.supervisor.spawnImpl(spec.command, spec.args || [], {
        windowsHide: true,
        ...(spec.options || {}),
      });
    } catch (error) {
      this._failedToStart(error, generation);
      throw error;
    }
    this.child = child;
    let resolveSettled;
    const lifecycle = {
      child, generation, stopRequested: false, settled: false, cleanupPromise: Promise.resolve(),
      settledPromise: new Promise(resolve => { resolveSettled = resolve; }), resolveSettled,
    };
    this.lifecycle = lifecycle;
    this.state = 'running';
    this._safeLog('info', 'Managed process started', this.details({ pid: child.pid, generation }));
    child.stderr?.on?.('data', data => {
      if (this.lifecycle !== lifecycle) return;
      this.stderrTail = (this.stderrTail + data.toString()).slice(-16000);
      this._safeEmit('stderr', data, child);
    });
    child.once('error', error => this._onError(lifecycle, error));
    child.once('exit', (code, signal) => { void this._onExit(lifecycle, code, signal); });
    child.once('close', (code, signal) => { void this._onClose(lifecycle, code, signal); });
    try {
      spec.onSpawn?.(child, this);
      this._safeEmit('spawn', child, generation);
    } catch (error) {
      this._safeLog('error', 'Managed process spawn hook failed', this.details({ generation, error: safeError(error) }));
      lifecycle.stopRequested = true;
      void this.stop('spawn-hook-failed', { release: false }).catch(stopError => {
        this._safeLog('error', 'Managed process cleanup after spawn hook failed', this.details({ generation, error: safeError(stopError) }));
      });
      throw error;
    }
    const startupTimeoutMs = Number(spec.health?.startupTimeoutMs) || 0;
    if (startupTimeoutMs > 0) {
      this.healthTimer = setTimeout(() => {
        if (this.lifecycle !== lifecycle || lifecycle.settled || this.lastHealthyAt >= this.startedAt) return;
        this._safeLog('warn', 'Managed process health check timed out', this.details({ generation, startupTimeoutMs }));
        void this.recycle('startup-health-timeout').catch(error => this._safeLog('error', 'Managed process recycle failed', this.details({ generation, error: safeError(error) })));
      }, startupTimeoutMs);
      this.healthTimer.unref?.();
    }
    return child;
  }

  markHealthy(metadata = {}) {
    if (!this.child || this.child.killed) return false;
    if (metadata && Number.isFinite(metadata.generation) && metadata.generation !== this.generation) return false;
    this.lastHealthyAt = this.supervisor.now();
    clearTimeout(this.healthTimer);
    this.healthTimer = null;
    if (this.state !== 'healthy') {
      this.state = 'healthy';
      this._safeLog('info', 'Managed process healthy', this.details(metadata));
    }
    this._safeEmit('healthy', metadata);
    return true;
  }

  async recycle(reason = 'recycle-requested', { timeoutMs = 2000, rollbackSettleMs = 25 } = {}) {
    const lifecycle = this.lifecycle;
    if (!lifecycle || lifecycle.settled) return this.start();
    this._safeLog('warn', 'Managed process recycled', this.details({ reason, generation: lifecycle.generation }));
    lifecycle.stopRequested = true;
    await stopProcessAndWait(lifecycle.child, timeoutMs, { rollbackSettleMs });
    if (!lifecycle.exitObserved && (lifecycle.child.exitCode != null || lifecycle.child.signalCode != null)) {
      await this._onExit(lifecycle, lifecycle.child.exitCode, lifecycle.child.signalCode);
    }
    await this._waitForLifecycle(lifecycle, timeoutMs);
    if (this.released || this.stopping || this.supervisor.stopping) return null;
    return this.start();
  }

  async stop(reason = 'shutdown', { release = true, timeoutMs = 2000, rollbackSettleMs = 25 } = {}) {
    this.stopping = true;
    this.state = 'stopping';
    this._restartReason = null;
    clearTimeout(this.restartTimer);
    clearTimeout(this.healthTimer);
    this.restartTimer = null;
    this.healthTimer = null;
    const child = this.child;
    const lifecycle = this.lifecycle;
    if (lifecycle) lifecycle.stopRequested = true;
    await stopProcessAndWait(child, timeoutMs, { rollbackSettleMs });
    if (lifecycle && !lifecycle.exitObserved && (child?.exitCode != null || child?.signalCode != null)) {
      await this._onExit(lifecycle, child.exitCode, child.signalCode);
    }
    if (lifecycle) await this._waitForLifecycle(lifecycle, timeoutMs);
    if (this.child === child) this.child = null;
    this.state = 'stopped';
    this._safeLog('info', 'Managed process stopped', this.details({ reason }));
    if (release) this.release();
    return { stopped: true };
  }

  release() {
    this.released = true;
    if (this.supervisor.processes.get(this.id) === this) this.supervisor.processes.delete(this.id);
  }

  status() {
    return {
      id: this.id,
      kind: this.kind,
      protocol: this.protocol || undefined,
      owner: this.owner || undefined,
      state: this.state,
      pid: this.child?.pid || null,
      generation: this.generation,
      startedAt: this.startedAt,
      lastHealthyAt: this.lastHealthyAt,
      restartCount: this.restartTimes.length,
      lastExit: this.lastExit,
    };
  }

  details(extra = {}) {
    return { processId: this.id, processKind: this.kind, ...extra };
  }

  _safeLog(level, message, details) {
    try { this.supervisor.log(level, message, details); } catch (_) { /* logging must never break ownership */ }
  }

  _safeEmit(event, ...args) {
    try { this.emit(event, ...args); }
    catch (error) { this._safeLog('warn', 'Managed process observer failed', this.details({ event, error: safeError(error) })); }
  }

  _failedToStart(error, generation) {
    this.state = 'failed';
    this.lastExit = { at: this.supervisor.now(), generation, error: safeError(error) };
    this._safeLog('error', 'Managed process failed to start', this.details(this.lastExit));
  }

  _onError(lifecycle, error) {
    if (this.lifecycle !== lifecycle || lifecycle.settled) return;
    this._safeLog('warn', 'Managed process error', this.details({ generation: lifecycle.generation, error: safeError(error) }));
    this._safeEmit('process-error', error, lifecycle.child);
  }

  async _onExit(lifecycle, code, signal) {
    if (lifecycle.exitObserved) return lifecycle.settledPromise;
    lifecycle.exitObserved = true;
    const current = this.lifecycle === lifecycle;
    if (current && this.child === lifecycle.child) this.child = null;
    if (!current) return this._settleLifecycle(lifecycle);
    clearTimeout(this.healthTimer);
    this.healthTimer = null;
    const expected = this.stopping || lifecycle.stopRequested;
    this.lastExit = { at: this.supervisor.now(), generation: lifecycle.generation, code, signal, expected, stderr: this.stderrTail.trim() };
    this.state = expected ? 'stopped' : 'exited';
    this._safeLog(expected || code === 0 ? 'info' : 'warn', 'Managed process exited', this.details(this.lastExit));
    try {
      const cleanup = this.specification.onExitCleanup?.({ owner: this.owner, child: lifecycle.child, exit: this.lastExit, managedProcess: this });
      lifecycle.cleanupPromise = Promise.resolve(cleanup);
      if (cleanup && typeof cleanup.then === 'function') {
        await lifecycle.cleanupPromise.catch(error => this._safeLog('warn', 'Managed process exit cleanup failed', this.details({ generation: lifecycle.generation, error: safeError(error) })));
      }
    } catch (error) { this._safeLog('warn', 'Managed process exit cleanup failed', this.details({ generation: lifecycle.generation, error: safeError(error) })); }
    this._safeEmit('exit', this.lastExit, lifecycle.child);
    this._settleLifecycle(lifecycle);
    if (this.lifecycle !== lifecycle) return;
    if (this.specification.ephemeral) this.release();
    else if (!expected) this._scheduleRestart('unexpected-exit');
  }

  _onClose(lifecycle, code, signal) {
    lifecycle.closeObserved = true;
    if (!lifecycle.exitObserved) return this._onExit(lifecycle, code, signal);
    return lifecycle.settledPromise;
  }

  _settleLifecycle(lifecycle) {
    if (!lifecycle.settled) {
      lifecycle.settled = true;
      lifecycle.resolveSettled();
    }
    return lifecycle.settledPromise;
  }

  _waitForLifecycle(lifecycle, timeoutMs) {
    if (lifecycle.settled) return lifecycle.settledPromise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('managed process lifecycle did not settle after termination'), {
          code: 'PROCESS_LIFECYCLE_TIMEOUT', pid: lifecycle.child?.pid || null, generation: lifecycle.generation,
        });
        reject(error);
      }, Math.max(1, Number(timeoutMs) || 2000));
      timer.unref?.();
      lifecycle.settledPromise.then(() => { clearTimeout(timer); resolve(); });
    });
  }

  _scheduleRestart(reason) {
    const policy = { ...DEFAULT_RESTART_POLICY, ...(this.specification.restart || {}) };
    if (!policy.enabled || this.stopping || this.released) {
      if (!this.stopping) this.state = 'failed';
      return false;
    }
    const now = this.supervisor.now();
    this.restartTimes = this.restartTimes.filter(value => now - value <= policy.windowMs);
    if (this.restartTimes.length >= policy.maxRestarts) {
      this.state = 'failed';
      this._safeLog('error', 'Managed process restart limit reached', this.details({ reason, maxRestarts: policy.maxRestarts }));
      this._safeEmit('restart-exhausted', this.status());
      return false;
    }
    const attempt = this.restartTimes.length;
    this.restartTimes.push(now);
    const delays = Array.isArray(policy.backoffMs) && policy.backoffMs.length ? policy.backoffMs : [Number(policy.backoffMs) || 0];
    const delayMs = Math.max(0, Number(delays[Math.min(attempt, delays.length - 1)]) || 0);
    this.state = 'restarting';
    this._safeLog('warn', 'Managed process restart scheduled', this.details({ reason, attempt: attempt + 1, delayMs }));
    this._safeEmit('restarting', { reason, attempt: attempt + 1, delayMs });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping && !this.released) Promise.resolve(this.start()).catch(error => this._safeLog('error', 'Managed process restart failed', this.details({ error: safeError(error) })));
    }, delayMs);
    this.restartTimer.unref?.();
    return true;
  }
}

class ProcessSupervisor {
  constructor({ spawnImpl = defaultSpawn, writeLog = () => undefined, now = () => Date.now() } = {}) {
    this.spawnImpl = spawnImpl;
    this.writeLog = writeLog;
    this.now = now;
    this.processes = new Map();
    this.stopping = false;
  }

  log(level, message, details) {
    this.writeLog(level, message, details);
  }

  launch(specification) {
    if (this.stopping) throw new Error('Process supervisor is stopping');
    const id = String(specification?.id || '').trim();
    if (!id) throw new Error('Managed process ID is required');
    const existing = this.processes.get(id);
    if (existing && !existing.released) throw new Error(`Managed process already exists: ${id}`);
    const managed = new ManagedProcess(this, { ...specification, id });
    this.processes.set(id, managed);
    try {
      managed.start();
    } catch (error) {
      if (managed.child) {
        void managed.stop('launch-failed').catch(stopError => managed._safeLog('error', 'Managed process launch cleanup failed', managed.details({ error: safeError(stopError) })));
      } else managed.release();
      throw error;
    }
    return managed;
  }

  status(id) {
    return this.processes.get(String(id || ''))?.status() || null;
  }

  list() {
    return [...this.processes.values()].map(process => process.status()).sort((left, right) => left.id.localeCompare(right.id));
  }

  async stopWhere(predicate, reason = 'owner-revoked') {
    const matches = [...this.processes.values()].filter(process => predicate(process.status()));
    await Promise.all(matches.map(process => process.stop(reason)));
    return matches.length;
  }

  async stopAll(reason = 'application-shutdown') {
    this.stopping = true;
    await Promise.all([...this.processes.values()].map(process => process.stop(reason)));
    this.processes.clear();
  }
}

const createProcessSupervisor = options => new ProcessSupervisor(options);

module.exports = { DEFAULT_RESTART_POLICY, ManagedProcess, ProcessSupervisor, createProcessSupervisor, stopProcessAndWait, terminateAndWait };
