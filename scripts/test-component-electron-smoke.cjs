const assert = require('assert/strict');
const path = require('path');
const { spawn } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['--disable-gpu', path.join(__dirname, 'component-electron-smoke-app')], {
  cwd: repositoryRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = ''; let stderr = '';
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
const timer = setTimeout(() => child.kill(), 60_000);
child.once('exit', code => {
  clearTimeout(timer);
  assert.equal(code, 0, `component Electron smoke exited ${code}\n${stdout}\n${stderr}`);
  const line = stdout.split(/\r?\n/).find(value => value.startsWith('PHOTOFLOW_COMPONENT_SMOKE_RESULT='));
  assert(line, `missing component smoke evidence\n${stdout}\n${stderr}`);
  const evidence = JSON.parse(line.slice('PHOTOFLOW_COMPONENT_SMOKE_RESULT='.length));
  assert.deepEqual(evidence.v2Mounted, { api: true, bridgeContract: 1, root: 'v2-mounted' });
  assert.deepEqual(evidence.v2Event, { value: 'delivered-v2' });
  assert.deepEqual(evidence.v1Mounted, { api: true, bridgeContract: 1, root: 'v1-mounted' });
  assert.deepEqual(evidence.v1Event, { value: 'delivered-v1' });
  assert.deepEqual(evidence.failures, []);
  console.log('Component Electron smoke passed: sandbox=true V2 root/event and V1 compatibility preload verified.');
});
child.once('error', error => { clearTimeout(timer); throw error; });
