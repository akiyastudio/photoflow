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
  assert.deepEqual(evidence.hostMounted, { api: true, notify: true, dialog: true, bridgeContract: 1, root: 'host-mounted' });
  assert.deepEqual(evidence.hostEvent, { value: 'delivered-host' });
  assert.equal(evidence.legacyRejected, true);
  assert.deepEqual(evidence.failures, []);
  console.log('Component Electron smoke passed: sandbox=true Host API root/event and legacy contract default-deny verified.');
});
child.once('error', error => { clearTimeout(timer); throw error; });
