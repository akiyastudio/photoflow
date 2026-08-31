const crypto = require('crypto');

const SQLITE_RETRYABLE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);
const DATABASE_LOCK_RETRY_DELAYS_MS = [80, 180, 360, 700, 1400];

const wait = (delay, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason || Object.assign(new Error('数据库操作已取消'), { code: 'ABORT_ERR' }));
    return;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason || Object.assign(new Error('数据库操作已取消'), { code: 'ABORT_ERR' }));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener?.('abort', onAbort);
    resolve();
  }, delay);
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

class CoordinatedDatabaseClient {
  constructor({ coordinator, operationPolicy, getDatabasePath, scriptName, execute, retryDelays = DATABASE_LOCK_RETRY_DELAYS_MS, waitForRetry = wait }) {
    if (!coordinator?.run) throw new TypeError('PythonDatabaseClient 必须注入 workspace SQLite coordinator');
    this.coordinator = coordinator;
    this.operationPolicy = operationPolicy;
    this.getDatabasePath = getDatabasePath;
    this.scriptName = scriptName;
    this.execute = execute;
    this.retryDelays = retryDelays;
    this.waitForRetry = waitForRetry;
    this.singleFlight = Promise.resolve();
  }

  call(root, action, payload, options = {}) {
    const database = this.getDatabasePath(root);
    const policy = this.operationPolicy.classify({ root, database, action, payload, scriptName: this.scriptName });
    const run = () => this.callSingleFlight(root, action, payload, options, { database, policy });
    if (policy.mode === 'read') return run();
    const result = this.singleFlight.then(run, run);
    this.singleFlight = result.catch(() => undefined);
    return result;
  }

  async callSingleFlight(root, action, payload, { timeoutMs, signal, label, deadlineAt: requestedDeadlineAt, operationId: requestedOperationId } = {}, classified = {}) {
    const database = classified.database || this.getDatabasePath(root);
    const policy = classified.policy || this.operationPolicy.classify({ root, database, action, payload, scriptName: this.scriptName });
    const operationId = requestedOperationId || crypto.randomUUID();
    let startedDeadlineAt;
    let attempt = 0;
    while (true) {
      try {
        // The lease exists only for this attempt. A rejected attempt unwinds
        // coordinator.run before backoff, so retries always rejoin the queue.
        return await this.coordinator.run({ databases: policy.databases, signal, deadlineAt: requestedDeadlineAt, label: label || action }, () => {
          if (!Number.isFinite(startedDeadlineAt)) {
            const timeoutDeadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : undefined;
            startedDeadlineAt = Number.isFinite(requestedDeadlineAt) && Number.isFinite(timeoutDeadline)
              ? Math.min(requestedDeadlineAt, timeoutDeadline)
              : Number.isFinite(requestedDeadlineAt) ? requestedDeadlineAt : timeoutDeadline;
          }
          const deadlineAt = startedDeadlineAt;
          const remainingMs = Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - Date.now()) : timeoutMs;
          return this.execute({ root, database, databases: policy.databases, action, payload, timeoutMs: remainingMs, signal, deadlineAt, operationId, idempotent: policy.idempotent });
        });
      } catch (error) {
        if (!policy.idempotent || !SQLITE_RETRYABLE_CODES.has(error?.code) || attempt >= this.retryDelays.length) throw error;
        const delay = this.retryDelays[attempt] + Math.floor(Math.random() * 60);
        attempt += 1;
        if (Number.isFinite(startedDeadlineAt) && Date.now() + delay >= startedDeadlineAt) throw error;
        await this.waitForRetry(delay, signal);
        if (signal?.aborted) throw signal.reason || Object.assign(new Error('数据库操作已取消'), { code: 'ABORT_ERR' });
      }
    }
  }
}

module.exports = { CoordinatedDatabaseClient, SQLITE_RETRYABLE_CODES, DATABASE_LOCK_RETRY_DELAYS_MS };
