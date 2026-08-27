const { findPythonJsonFailureMessage, parsePythonJsonMessages } = require('./python-json-protocol.cjs');
const { terminateAndWait } = require('../infrastructure/process-termination.cjs');

const MAX_JSON_MESSAGE_BYTES = 32 * 1024 * 1024;

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
    let messageBuffer = '';
    const messages = [];
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
      const lines = (messageBuffer + data).split(/\r?\n/);
      messageBuffer = lines.pop() || '';
      if (Buffer.byteLength(messageBuffer, 'utf8') > MAX_JSON_MESSAGE_BYTES) {
        const error = new Error(`${label} 返回的单条 JSON 消息超过安全上限`);
        error.code = 'PROCESS_PROTOCOL_MESSAGE_TOO_LARGE';
        terminateThenFail(error);
        return;
      }
      for (const line of lines) {
        if (Buffer.byteLength(line, 'utf8') > MAX_JSON_MESSAGE_BYTES) {
          const error = new Error(`${label} 返回的单条 JSON 消息超过安全上限`);
          error.code = 'PROCESS_PROTOCOL_MESSAGE_TOO_LARGE';
          terminateThenFail(error);
          return;
        }
        const parsed = parsePythonJsonMessages(line);
        if (!parsed.length) continue;
        messages.push(...parsed);
        if (messages.length > 256) messages.splice(0, messages.length - 256);
        for (const message of parsed) onMessage?.(message);
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
    child.on('error', error => { if (!terminating) fail(error); });
    child.on('close', code => {
      if (terminating) return;
      if (messageBuffer.trim()) messages.push(...parsePythonJsonMessages(messageBuffer));
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
