const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHostSimulator } = require('./host-simulator.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-runner-tree-')); const pidPath = path.join(root, 'grandchild.pid');
const simulator = createHostSimulator({
  service: path.join(__dirname, '..', 'service.cjs'),
  serviceArgs: ['--photoflow-development-command', process.execPath, '--photoflow-development-arg', path.join(__dirname, 'fixture-algorithm-grandchild.cjs')],
  env: { PHOTOFLOW_TEST_ALGORITHM_TIMEOUT_MS: '250', PHOTOFLOW_TEST_GRANDCHILD_PID: pidPath },
  context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'application.settings' },
});

(async () => {
  try {
    const status = await simulator.request('team.advanced.status.v1');
    assert.equal(status.advancedAvailable, false); assert.equal(status.errorCategory, 'runtime-incomplete');
    const pid = Number(fs.readFileSync(pidPath, 'utf8')); let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) { try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); } catch { alive = false; } }
    assert.equal(alive, false, 'timeout termination waits for and removes the spawned grandchild process');
    console.log('Team-retouch algorithm process-tree timeout tests passed');
  } finally { await simulator.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
})().catch(error => { console.error(error); process.exitCode = 1; });
