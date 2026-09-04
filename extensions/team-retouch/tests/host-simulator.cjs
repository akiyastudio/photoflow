const { spawn } = require('node:child_process');
const readline = require('node:readline');

const createHostSimulator = ({ service, serviceArgs = [], context, capabilities = {}, env = {} }) => {
  const child = spawn(process.execPath, [service, ...serviceArgs], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let nextId = 1;
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'capability') {
      Promise.resolve(capabilities[frame.method]?.(frame.payload, frame) ?? Promise.reject(new Error(`Undeclared simulator capability: ${frame.method}`)))
        .then(result => child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: true, result })}\n`))
        .catch(error => child.stdin.write(`${JSON.stringify({ type: 'capability-response', id: frame.id, ok: false, error: String(error.message || error) })}\n`));
    } else if (frame.type === 'response') {
      const target = pending.get(frame.id); pending.delete(frame.id);
      if (target) frame.ok ? target.resolve(frame.result) : target.reject(Object.assign(new Error(frame.error), { code: frame.errorCode, retryable: frame.retryable === true }));
    }
  });
  return {
    child,
    request(method, payload = {}) { const id = String(nextId++); const promise = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload, context })}\n`); }); promise.requestId = id; return promise; },
    cancelRequest(id) { child.stdin.write(`${JSON.stringify({ type: 'cancel', id: String(id) })}\n`); },
    close() {
      if (child.exitCode !== null) return Promise.resolve();
      return new Promise(resolve => {
        const force = setTimeout(() => child.kill(), 500); force.unref?.();
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.stdin.end();
      });
    }
  };
};
module.exports = { createHostSimulator };
