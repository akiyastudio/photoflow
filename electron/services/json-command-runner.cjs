const { findPythonJsonFailureMessage, parsePythonJsonMessages } = require('./python-json-protocol.cjs');
const { terminateAndWait } = require('../infrastructure/process-termination.cjs');

const createJsonCommandRunner = ({ spawnJob, terminationTimeoutMs = 5000 }) => (
  (run, label, timeoutMs = 20 * 60 * 1000, onMessage, signal, requestedDeadlineAt) => new Promise((resolve, reject) => {
    const timeoutDeadline = Date.now() + Math.max(0, timeoutMs);
    const deadlineAt = Number.isFinite(requestedDeadlineAt) ? Math.min(requestedDeadlineAt, timeoutDeadline) : timeoutDeadline;
    if (signal?.aborted) {
      const error = new Error(signal.reason?.message || '任务已取消');
      error.code = typeof signal.reason?.code === 'string' ? signal.reason.code : 'TASK_CANCELLED';
      error.cause = signal.reason;
      reject(error);
      return;
    }
    if (deadlineAt <= Date.now()) {
      const error = new Error(`${label} 处理超时`);
      error.code = 'PROCESS_TIMEOUT';
      reject(error);
      return;
    }
    const child = spawnJob(run);
    let stdout = '';
    let messageBuffer = '';
    let stderr = '';
    let finished = false;
    let terminating = false;
    let abortListener = null;
    let timer = null;
    const settle = callback => value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (abortListener) signal?.removeEventListener?.('abort', abortListener);
      callback(value);
    };
    const succeed = settle(resolve);
    const fail = settle(reject);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      stdout = (stdout + data).slice(-2 * 1024 * 1024);
      if (!onMessage) return;
      const lines = (messageBuffer + data).split(/\r?\n/);
      messageBuffer = lines.pop() || '';
      for (const line of lines) {
        try { onMessage(JSON.parse(line.trim())); }
        catch { /* progress messages are compact JSON lines; ignore other output */ }
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
    child.on('error', error => { if (!terminating) fail(error); });
    child.on('close', code => {
      if (terminating) return;
      const messages = parsePythonJsonMessages(stdout);
      const protocolFailure = findPythonJsonFailureMessage(messages);
      if (code !== 0) return fail(new Error(protocolFailure || stderr.trim() || `${label} 处理失败（代码 ${code}）`));
      if (protocolFailure) return fail(new Error(protocolFailure));
      if (messages.length) return succeed(messages[messages.length - 1]);
      fail(new Error(stderr.trim() || `${label} 未返回有效结果`));
    });
    const terminateThenFail = error => {
      if (finished || terminating) return;
      terminating = true;
      clearTimeout(timer);
      if (abortListener) signal?.removeEventListener?.('abort', abortListener);
      void terminateAndWait(child, Date.now() + terminationTimeoutMs).then(
        () => fail(error),
        terminationError => fail(terminationError),
      );
    };
    timer = setTimeout(() => {
      const error = new Error(`${label} 处理超时`);
      error.code = 'PROCESS_TIMEOUT';
      terminateThenFail(error);
    }, Math.max(0, deadlineAt - Date.now()));
    if (signal) {
      abortListener = () => {
        const error = new Error(signal.reason?.message || '任务已取消');
        error.code = typeof signal.reason?.code === 'string' ? signal.reason.code : 'TASK_CANCELLED';
        error.cause = signal.reason;
        terminateThenFail(error);
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
  })
);

module.exports = { createJsonCommandRunner };
