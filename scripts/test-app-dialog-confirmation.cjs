const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requestAppConfirmation } = require('../electron/services/app-dialog-confirmation.cjs');
const makeSender = () => Object.assign(new EventEmitter(), {
  mainFrame: {}, isDestroyed: () => false,
  send(channel, payload) { this.sent = { channel, payload }; },
});
const reply = (sender, requestId, accepted, frame = sender.mainFrame) => sender.emit('ipc-message', { senderFrame: frame }, 'app-dialog:confirmation-response', { requestId, accepted });
(async () => {
  const sender = makeSender();
  const pending = requestAppConfirmation(sender, { title: '安装组件？' });
  const id = sender.sent.payload.requestId;
  reply(sender, 'stale-request', true);
  reply(sender, id, true, {});
  assert.equal(sender.listenerCount('ipc-message'), 1, 'stale and subframe replies cannot approve');
  reply(sender, id, true);
  assert.equal(await pending, true);
  assert.equal(sender.sent.channel, 'app-dialog:confirmation-closed');
  assert.equal(sender.sent.payload, id);
  assert.equal(sender.listenerCount('ipc-message'), 0);
  const next = requestAppConfirmation(sender, {});
  reply(sender, id, true);
  reply(sender, sender.sent.payload.requestId, false);
  assert.equal(await next, false);
  for (const event of ['destroyed', 'did-start-navigation']) {
    const wait = requestAppConfirmation(sender, {});
    sender.emit(event, {}, '', false, true);
    assert.equal(await wait, false);
    assert.equal(sender.listenerCount('ipc-message'), 0);
  }
  const controller = new AbortController();
  const aborted = requestAppConfirmation(sender, {}, { signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, false);
  assert.equal(await requestAppConfirmation(sender, {}, { deadlineAt: Date.now() - 1 }), false);
  const handlers = new Map();
  let answer = true;
  const { registerComponentProjectCapabilities } = require('../electron/services/component-project-capabilities.cjs');
  registerComponentProjectCapabilities({
    broker: { register: (name, handler) => handlers.set(name, handler) },
    requestConfirmation: async options => { assert.equal(options.cancelDefault, true); assert.equal(options.confirmLabel, '继续'); return answer; },
  });
  const confirm = handlers.get('dialogs');
  assert.deepEqual(await confirm({ kind: 'confirm', message: '继续？' }, {}, {}), { confirmed: true });
  answer = false;
  assert.deepEqual(await confirm({ kind: 'confirm' }, { surface: 'application.settings' }, {}), { confirmed: false });
  const ipc = new EventEmitter();
  ipc.send = (channel, payload) => { ipc.lastReply = { channel, payload }; };
  let api;
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require('node:path').join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } } }; },
  });
  const unsubscribe = api.onAppConfirmation(async options => options.message === 'yes');
  ipc.emit('app-dialog:confirmation', {}, { requestId: 'first', message: 'yes' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ipc.lastReply.payload.accepted, true);
  ipc.emit('app-dialog:confirmation', {}, { requestId: 'second', message: 'no' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ipc.lastReply.payload.accepted, false);
  unsubscribe();
  const failing = api.onAppConfirmation(async () => { throw new Error('closed'); });
  ipc.emit('app-dialog:confirmation', {}, { requestId: 'third' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ipc.lastReply.payload.accepted, false);
  failing();
  assert.equal(ipc.listenerCount('app-dialog:confirmation'), 0);
  console.log('App dialog confirmation tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
