const { spawn } = require('node:child_process');
const readline = require('node:readline');

const createHostSimulator = ({ service, context, capabilities = {} }) => {
  const child = spawn(process.execPath, [service], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
      if (target) frame.ok ? target.resolve(frame.result) : target.reject(new Error(frame.error));
    }
  });
  return {
    child,
    request(method, payload = {}) { const id = String(nextId++); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ type: 'request', id, method, payload, context })}\n`); }); },
    close() { child.kill(); }
  };
};
module.exports = { createHostSimulator };
