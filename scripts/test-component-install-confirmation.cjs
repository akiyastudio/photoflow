const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requestComponentInstallConfirmation } = require('../electron/services/component-install-confirmation.cjs');
const makeSender = () => Object.assign(new EventEmitter(), {
  mainFrame: {}, isDestroyed: () => false,
  send(channel, payload) { this.sent = { channel, payload }; },
});
const reply = (sender, requestId, accepted, frame = sender.mainFrame) => sender.emit('ipc-message', { senderFrame: frame }, 'components-install-confirmation-response', { requestId, accepted });
(async () => {
  const sender = makeSender();
  const pending = requestComponentInstallConfirmation(sender, { title: '安装组件？' });
  const id = sender.sent.payload.requestId;
  reply(sender, 'stale-request', true);
  reply(sender, id, true, {});
  assert.equal(sender.listenerCount('ipc-message'), 1, 'stale and subframe replies cannot approve');
  reply(sender, id, true);
  assert.equal(await pending, true);
  assert.equal(sender.listenerCount('ipc-message'), 0);
  const next = requestComponentInstallConfirmation(sender, {});
  reply(sender, id, true);
  reply(sender, sender.sent.payload.requestId, false);
  assert.equal(await next, false);
  for (const event of ['destroyed', 'did-start-navigation']) {
    const wait = requestComponentInstallConfirmation(sender, {});
    sender.emit(event, {}, '', false, true);
    assert.equal(await wait, false);
    assert.equal(sender.listenerCount('ipc-message'), 0);
  }
  const controller = new AbortController();
  const aborted = requestComponentInstallConfirmation(sender, {}, { signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, false);
  assert.equal(await requestComponentInstallConfirmation(sender, {}, { deadlineAt: Date.now() - 1 }), false);
  console.log('Component install confirmation tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
