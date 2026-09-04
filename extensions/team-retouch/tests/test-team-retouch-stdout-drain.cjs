const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { waitForReadableDrain } = require('../service.cjs');

(async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = waitForReadableDrain(child.stdout);
  child.stdout.destroy();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('close without end did not drain')), 1000))]);
  child.kill();

  const errored = new PassThrough();
  errored.on('error', () => undefined);
  const errorDrain = waitForReadableDrain(errored);
  errored.emit('error', new Error('controlled stream error'));
  await Promise.race([errorDrain, new Promise((_, reject) => setTimeout(() => reject(new Error('error did not drain')), 1000))]);
  assert.ok(true);
  console.log('Team-retouch stdout close/error drain tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
