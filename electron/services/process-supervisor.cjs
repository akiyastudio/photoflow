const { EventEmitter } = require('events');
const { spawn: defaultSpawn } = require('child_process');

const DEFAULT_RESTART_POLICY = Object.freeze({ enabled: false, maxRestarts: 0, windowMs: 60000, backoffMs: [100, 300, 1000] });
const safeError = error => error?.message || String(error || 'unknown error');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
const childHasExited = child => !child || child.exitCode != null || child.signalCode != null;
const waitForChildExit = (child, deadlineAt = Infinity) => {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer = null;
    const finish = () => {
      child.removeListener?.('exit', finish);
      child.removeListener?.('close', finish);
      child.removeListener?.('error', finish);
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', finish);
    if (Number.isFinite(deadlineAt)) {
      timer = setTimeout(() => {
        child.removeListener?.('exit', finish);
        child.removeListener?.('close', finish);
        child.removeListener?.('error', finish);
        resolve(childHasExited(child));
      }, Math.max(0, deadlineAt - Date.now()));
    }
  });
};

const terminateAndWait = async (child, deadlineAt, { rollbackSettleMs = 25 } = {}) => {
  if (!child) return { exited: true, forced: false };
  const terminationDeadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + 2000;
  try { child.stdin?.end?.(); } catch { /* stdin may already be closed */ }
  try { child.stdin?.destroy?.(); } catch { /* best effort */ }
  if (!childHasExited(child)) {
    try { child.kill(); } catch { /* exit/error may already be in flight */ }
  }
  let exited = childHasExited(child);
  if (!exited) {
    const remaining = Math.max(0, terminationDeadline - Date.now());
    const gracefulDeadline = Date.now() + Math.min(500, Math.floor(remaining / 2));
    exited = await waitForChildExit(child, gracefulDeadline);
  }
  let forced = false;
  if (!exited) {
    forced = true;
    let forcedByChild = false;
    try { forcedByChild = child.kill('SIGKILL') !== false; } catch { /* fall through to PID kill */ }
    if (!forcedByChild && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* wait for an already requested exit */ }
    }
    exited = await waitForChildExit(child, terminationDeadline);
  }
  if (!exited) {
    const error = new Error('无法确认子进程已退出，数据库可能仍被占用');
    error.code = 'PROCESS_TERMINATION_FAILED';
    error.pid = child.pid || null;
    throw error;
  }
  if (rollbackSettleMs > 0) await delay(rollbackSettleMs);
  return { exited: true, forced };
};

const stopProcessAndWait = (child, timeoutMs = 2000, options = {}) => (
  terminateAndWait(child, Date.now() + Math.max(0, timeoutMs), options)
);

class ManagedProcess extends EventEmitter {
  constructor(supervisor, specification) {
    super();
    this.supervisor = supervisor;
    this.specification = specification;
    this.id = specification.id;
    this.kind = specification.kind || 'process';
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
  }

  start() {
    if (this.released) throw new Error(`Managed process has been released: ${this.id}`);
    if (this.child && !this.child.killed) return this.child;
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
    this.state = 'running';
    this.supervisor.log('info', 'Managed process started', this.details({ pid: child.pid, generation }));
    child.stderr?.on?.('data', data => {
      this.stderrTail = (this.stderrTail + data.toString()).slice(-16000);
      this.emit('stderr', data, child);
    });
    child.once('error', error => this._onError(child, generation, error));
    child.once('exit', (code, signal) => this._onExit(child, generation, code, signal));
    spec.onSpawn?.(child, this);
    this.emit('spawn', child, generation);
    const startupTimeoutMs = Number(spec.health?.startupTimeoutMs) || 0;
    if (startupTimeoutMs > 0) {
      this.healthTimer = setTimeout(() => {
        if (this.child !== child || this.lastHealthyAt >= this.startedAt) return;
        this.supervisor.log('warn', 'Managed process health check timed out', this.details({ generation, startupTimeoutMs }));
        this.recycle('startup-health-timeout');
      }, startupTimeoutMs);
      this.healthTimer.unref?.();
    }
    return child;
  }

  markHealthy(metadata = {}) {
    if (!this.child || this.child.killed) return false;
    this.lastHealthyAt = this.supervisor.now();
    clearTimeout(this.healthTimer);
    this.healthTimer = null;
    if (this.state !== 'healthy') {
      this.state = 'healthy';
      this.supervisor.log('info', 'Managed process healthy', this.details(metadata));
    }
    this.emit('healthy', metadata);
    return true;
  }

  recycle(reason = 'recycle-requested') {
    const child = this.child;
    if (!child || child.killed) return this.start();
    this.supervisor.log('warn', 'Managed process recycled', this.details({ reason }));
    this._restartReason = reason;
    child.kill();
    return child;
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
    await stopProcessAndWait(child, timeoutMs, { rollbackSettleMs });
    if (this.child === child) this.child = null;
    this.state = 'stopped';
    this.supervisor.log('info', 'Managed process stopped', this.details({ reason }));
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

  _failedToStart(error, generation) {
    this.state = 'failed';
    this.lastExit = { at: this.supervisor.now(), generation, error: safeError(error) };
    this.supervisor.log('error', 'Managed process failed to start', this.details(this.lastExit));
  }

  _onError(child, generation, error) {
    if (this.child !== child) return;
    this.supervisor.log('warn', 'Managed process error', this.details({ generation, error: safeError(error) }));
    this.emit('process-error', error, child);
  }

  _onExit(child, generation, code, signal) {
    if (this.child === child) this.child = null;
    clearTimeout(this.healthTimer);
    this.healthTimer = null;
    const expected = this.stopping;
    this.lastExit = { at: this.supervisor.now(), generation, code, signal, expected, stderr: this.stderrTail.trim() };
    this.state = expected ? 'stopped' : 'exited';
    this.supervisor.log(expected || code === 0 ? 'info' : 'warn', 'Managed process exited', this.details(this.lastExit));
    this.emit('exit', this.lastExit, child);
    if (this.specification.ephemeral) this.release();
    else if (!expected) this._scheduleRestart(this._restartReason || 'unexpected-exit');
    this._restartReason = null;
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
      this.supervisor.log('error', 'Managed process restart limit reached', this.details({ reason, maxRestarts: policy.maxRestarts }));
      this.emit('restart-exhausted', this.status());
      return false;
    }
    const attempt = this.restartTimes.length;
    this.restartTimes.push(now);
    const delays = Array.isArray(policy.backoffMs) && policy.backoffMs.length ? policy.backoffMs : [Number(policy.backoffMs) || 0];
    const delayMs = Math.max(0, Number(delays[Math.min(attempt, delays.length - 1)]) || 0);
    this.state = 'restarting';
    this.supervisor.log('warn', 'Managed process restart scheduled', this.details({ reason, attempt: attempt + 1, delayMs }));
    this.emit('restarting', { reason, attempt: attempt + 1, delayMs });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping && !this.released) this.start();
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
      managed.release();
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

  async stopAll(reason = 'application-shutdown') {
    this.stopping = true;
    await Promise.all([...this.processes.values()].map(process => process.stop(reason)));
    this.processes.clear();
  }
}

const createProcessSupervisor = options => new ProcessSupervisor(options);

module.exports = { DEFAULT_RESTART_POLICY, ManagedProcess, ProcessSupervisor, createProcessSupervisor, stopProcessAndWait, terminateAndWait };
