const { spawn } = require('child_process');

const DATABASE_LOCK_PATTERN = /(?:database|database table) is locked|SQLITE_BUSY/i;
const DATABASE_LOCK_RETRY_DELAYS_MS = [80, 180, 360, 700, 1400];

class PythonDatabaseClient {
  constructor({ getRunConfig, getDatabasePath, writeLog, defaultTimeoutMs = 30000 }) {
    this.getRunConfig = getRunConfig;
    this.getDatabasePath = getDatabasePath;
    this.writeLog = writeLog;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.process = null;
    this.nextId = 0;
    this.pending = new Map();
    this.stopping = false;
  }

  ensureProcess() {
    if (this.process && !this.process.killed) return this.process;
    const run = this.getRunConfig('workspace_db.py', ['--server']);
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
          if (response.success) request.resolve(response.result);
          else request.reject(new Error(response.error || '工作区数据库操作失败'));
        } catch (error) {
          this.writeLog('warn', 'Unable to parse workspace database response', { error: error.message, line: line.slice(0, 500) });
        }
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.stdin.on('error', () => undefined);
    const finish = error => {
      if (this.process === child) this.process = null;
      for (const [id, request] of this.pending.entries()) {
        if (request.child !== child) continue;
        clearTimeout(request.timer);
        if (request.retryTimer) clearTimeout(request.retryTimer);
        request.reject(error);
        this.pending.delete(id);
      }
      if (!this.stopping) this.writeLog('warn', 'Workspace database service stopped', { error: error.message || String(error) });
    };
    child.on('error', finish);
    child.on('exit', code => finish(new Error(stderr.trim() || `Workspace database service exited with code ${code}`)));
    return child;
  }

  call(root, action, payload = {}, timeoutMs = this.defaultTimeoutMs) {
    return new Promise((resolve, reject) => {
      const child = this.ensureProcess();
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`工作区数据库操作超时：${action}`));
        if (this.process === child) {
          this.process = null;
          if (!child.killed) child.kill();
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
    if (child && !child.killed) child.kill();
  }
}

module.exports = { PythonDatabaseClient };
