const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-probe-coalescing-'));
const algorithm = path.join(root, 'algorithm.cjs');
const counter = path.join(root, 'counter.txt');
fs.writeFileSync(counter, '');
fs.writeFileSync(algorithm, `
const fs = require('node:fs');
const counter = process.argv[2];
fs.appendFileSync(counter, 'probe\\n');
setTimeout(() => process.stdout.write(JSON.stringify({ success: true, advancedAvailable: true, pairDetrReady: true, sam2Ready: true }) + '\\n'), 80);
`);

const service = spawn(process.execPath, [
  path.join(__dirname, '..', 'service.cjs'),
  '--photoflow-development-command', process.execPath,
  '--photoflow-development-arg', algorithm,
  '--photoflow-development-arg', counter,
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const lines = readline.createInterface({ input: service.stdout, crlfDelay: Infinity });
const responses = new Map();
let settled = false;
const finish = error => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  lines.close();
  service.kill();
  fs.rmSync(root, { recursive: true, force: true });
  if (error) { console.error(error); process.exitCode = 1; }
};
const request = id => service.stdin.write(`${JSON.stringify({ type: 'request', id, method: 'team.advanced.status.v1', payload: {}, context: { surface: 'application.settings' } })}\n`);
const timer = setTimeout(() => finish(new Error('advanced probe coalescing test timed out')), 10_000);

lines.on('line', line => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.type === 'ready') { request('first'); request('second'); return; }
  if (frame.type !== 'response') return;
  responses.set(frame.id, frame);
  if (responses.size === 2) { request('cached'); return; }
  if (responses.size !== 3) return;
  try {
    assert.equal([...responses.values()].every(item => item.ok && item.result?.advancedAvailable), true);
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split(/\r?\n/).filter(Boolean).length, 1, 'concurrent and cached status reads launch exactly one algorithm probe');
    console.log('Team-retouch advanced status probe coalescing tests passed');
    finish();
  } catch (error) { finish(error); }
});
service.once('error', finish);
service.once('exit', code => { if (!settled) finish(new Error(`team-retouch service exited early (${code})`)); });
