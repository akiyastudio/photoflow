const readline = require('readline');

const pending = new Map();
let nextCapabilityId = 1;
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const capability = (parentId, method, payload) => new Promise((resolve, reject) => {
  const id = `cap-${nextCapabilityId++}`;
  pending.set(id, { resolve, reject });
  send({ type: 'capability', id, parentId, method, payload });
});

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'capability-response') {
    const request = pending.get(frame.id); pending.delete(frame.id);
    if (frame.ok) request?.resolve(frame.result);
    else request?.reject(Object.assign(new Error(frame.error), { code: frame.errorCode }));
    return;
  }
  if (frame.type !== 'request') return;
  Promise.resolve(frame.method === 'sample.context.v1'
    ? { context: frame.context }
    : capability(frame.id, 'project.media.page.v7', { pageSize: 20, kinds: ['image', 'raw'] }))
    .then(result => send({ type: 'response', id: frame.id, ok: true, result }))
    .catch(error => send({ type: 'response', id: frame.id, ok: false, error: error.message, errorCode: error.code || 'COMPONENT_SERVICE_FAILED' }));
});

send({ type: 'ready', protocolVersion: 1 });
