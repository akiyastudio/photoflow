const { spawn } = require('child_process');

const DATABASE_LOCK_PATTERN = /(?:database|database table) is locked|SQLITE_BUSY/i;
const INFRASTRUCTURE_FAILURE_PATTERN = /(?:SQLITE_|database disk image is malformed|database service exited|EPIPE|ECONNRESET|timed out|operation timeout|操作超时|I\/O error|readonly database)/i;
const DATABASE_LOCK_RETRY_DELAYS_MS = [80, 180, 360, 700, 1400];
let databaseClientSequence = 0;

class PythonDatabaseClient {
  constructor({ getRunConfig, getDatabasePath, writeLog, defaultTimeoutMs = 30000, scriptName = 'workspace_db.py', processSupervisor = null, processId = '', domainId = '', onHealthChange = () => undefined, failureThreshold = 3, circuitCooldownMs = 5000, maximumPending = 100 }) {
    this.getRunConfig = getRunConfig;
    this.getDatabasePath = getDatabasePath;
    this.writeLog = writeLog;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.scriptName = scriptName;
    this.processSupervisor = processSupervisor;
    this.processId = processId || `python-database:${scriptName}:${++databaseClientSequence}`;
    this.domainId = domainId || this.processId;
    this.onHealthChange = onHealthChange;
    this.failureThreshold = failureThreshold;
    this.circuitCooldownMs = circuitCooldownMs;
    this.maximumPending = maximumPending;
    this.health = { domainId: this.domainId, state: 'healthy', failures: 0, circuitOpenedAt: 0, lastError: '', updatedAt: Date.now() };
    this.managedProcess = null;
    this.process = null;
    this.nextId = 0;
    this.pending = new Map();
    this.stopping = false;
  }

  updateHealth(state, details = {}) {
    this.health = { ...this.health, ...details, state, updatedAt: Date.now() };
    this.onHealthChange({ ...this.health });
  }

  noteSuccess() {
    if (this.health.state !== 'healthy' || this.health.failures) this.updateHealth('healthy', { failures: 0, circuitOpenedAt: 0, lastError: '' });
  }

  noteFailure(error) {
    const message = error?.message || String(error);
    if (!INFRASTRUCTURE_FAILURE_PATTERN.test(message)) return;
    const failures = this.health.failures + 1;
    if (failures >= this.failureThreshold) this.updateHealth('unavailable', { failures, circuitOpenedAt: Date.now(), lastError: message });
    else this.updateHealth('degraded', { failures, lastError: message });
  }

  assertCircuitAvailable() {
    if (this.health.state !== 'unavailable') return;
    if (Date.now() - this.health.circuitOpenedAt >= this.circuitCooldownMs) {
      this.updateHealth('recovering', { lastError: '' });
      return;
    }
    const error = new Error(`${this.domainId} 业务域暂时不可用，请稍后重试`);
    error.code = 'DOMAIN_UNAVAILABLE';
    throw error;
  }

  ensureProcess() {
    if (this.process && !this.process.killed) return this.process;
    if (this.managedProcess && !this.managedProcess.released) {
      if (this.managedProcess.child && !this.managedProcess.child.killed) return this.managedProcess.child;
      if (this.managedProcess.state === 'restarting') return this.managedProcess.start();
      this.managedProcess.release();
      this.managedProcess = null;
    }
    const run = this.getRunConfig(this.scriptName, ['--server']);
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
          if (!response.success && DATABASE_LOCK_PATTERN.test(response.error || '')
            && request.lockRetryCount < DATABASE_LOCK_RETRY_DELAYS_MS.length) {
            const delay = DATABASE_LOCK_RETRY_DELAYS_MS[request.lockRetryCount] + Math.floor(Math.random() * 60);
            request.lockRetryCount += 1;
            request.retryTimer = setTimeout(() => {
              request.retryTimer = null;
              if (this.pending.get(response.id) !== request || request.child !== child || child.killed) return;
              child.stdin.write(`${request.serialized}\n`, error => {
                if (!error) return;
                if (this.pending.get(response.id) !== request) return;
                this.pending.delete(response.id);
                clearTimeout(request.timer);
                request.reject(error);
              });
            }, delay);
            continue;
          }
          this.pending.delete(response.id);
          clearTimeout(request.timer);
          if (request.retryTimer) clearTimeout(request.retryTimer);
          if (response.success) {
            this.noteSuccess();
            request.resolve(response.result);
          } else {
            const error = new Error(response.error || '工作区数据库操作失败');
            this.noteFailure(error);
            request.reject(error);
          }
        } catch (error) {
          this.writeLog('warn', 'Unable to parse database service response', { scriptName: this.scriptName, error: error.message, line: line.slice(0, 500) });
        }
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.stdin.on('error', () => undefined);
    const finish = error => {
      this.noteFailure(error);
      if (this.process === child) this.process = null;
      for (const [id, request] of this.pending.entries()) {
        if (request.child !== child) continue;
        clearTimeout(request.timer);
        if (request.retryTimer) clearTimeout(request.retryTimer);
        request.reject(error);
        this.pending.delete(id);
      }
      if (!this.stopping && !this.processSupervisor) this.writeLog('warn', 'Database service stopped', { scriptName: this.scriptName, error: error.message || String(error) });
    };
    child.on('error', finish);
    child.on('exit', code => finish(new Error(stderr.trim() || `Workspace database service exited with code ${code}`)));
  }

  call(root, action, payload = {}, timeoutMs = this.defaultTimeoutMs) {
    return new Promise((resolve, reject) => {
      try { this.assertCircuitAvailable(); } catch (error) { reject(error); return; }
      if (this.pending.size >= this.maximumPending) {
        const error = new Error(`${this.domainId} 请求队列已满`);
        error.code = 'DOMAIN_BACKPRESSURE';
        reject(error);
        return;
      }
      const child = this.ensureProcess();
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`工作区数据库操作超时：${action}`);
        this.noteFailure(error);
        reject(error);
        if (this.process === child) {
          this.process = null;
          if (this.managedProcess?.child === child) {
            this.managedProcess.stop(`request-timeout:${action}`);
            this.managedProcess = null;
          } else if (!child.killed) child.kill();
        }
      }, timeoutMs);
      const request = { id, root, database: this.getDatabasePath(root), action, payload };
      const serialized = JSON.stringify(request);
      this.pending.set(id, { resolve, reject, timer, child, serialized, lockRetryCount: 0, retryTimer: null });
      try {
        child.stdin.write(`${serialized}\n`, error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending || pending.child !== child) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          if (pending.retryTimer) clearTimeout(pending.retryTimer);
          pending.reject(error);
        });
      } catch (error) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.retryTimer) clearTimeout(pending.retryTimer);
        pending.reject(error);
      }
    });
  }

  stop() {
    this.stopping = true;
    const child = this.process;
    this.process = null;
    if (this.managedProcess) {
      this.managedProcess.stop('database-client-stop');
      this.managedProcess = null;
    } else if (child && !child.killed) child.kill();
  }

  resume() {
    this.stopping = false;
    if (this.health.state === 'unavailable') this.updateHealth('recovering', { failures: 0, circuitOpenedAt: 0, lastError: '' });
  }

  async suspend(timeoutMs = 5000) {
    const child = this.process;
    this.stop();
    if (!child || child.exitCode != null) return;
    await Promise.race([
      new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); }),
      new Promise(resolve => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
    ]);
  }

  status() { return { ...this.health, pending: this.pending.size }; }
}

module.exports = { PythonDatabaseClient };
