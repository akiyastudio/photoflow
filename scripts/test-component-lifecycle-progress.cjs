const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runProcess } = require('../electron/services/component-lifecycle-service.cjs');

const reports = [];
const spawn = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from('PHOTOFLOW_PROGRESS|25|Working\n'));
    child.stderr.emit('data', Buffer.from('actual lifecycle failure\n'));
    child.emit('close', 1, null);
  });
  return child;
};

(async () => {
  await assert.rejects(runProcess({
    spawn,
    owner: { componentId: 'fixture' },
    command: 'fixture',
    args: [],
    cwd: process.cwd(),
    env: {},
    report: (progress, message) => reports.push({ progress, message }),
    timeoutMs: 1000,
  }), error => error.message === 'actual lifecycle failure');
  assert.deepEqual(reports, [{ progress: 25, message: 'Working' }]);
  console.log('Component lifecycle progress and failure-message tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
