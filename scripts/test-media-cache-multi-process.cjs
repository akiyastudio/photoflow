const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const fixture = path.resolve(__dirname, 'helpers', 'media-cache-process-fixture.cjs');
const runFixture = (action, configuredDirectory, userDataPath) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fixture, action, configuredDirectory, userDataPath], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('exit', code => {
    if (code !== 0) { reject(new Error(stderr || `fixture exited ${code}`)); return; }
    try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))); } catch (error) { reject(new Error(`invalid fixture output: ${stdout}\n${stderr}`, { cause: error })); }
  });
});

const run = async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-cache-processes-'));
  try {
    const configured = path.join(root, 'configured');
    const userDataA = path.join(root, 'user-data-a');
    const userDataB = path.join(root, 'user-data-b');
    await Promise.all([configured, userDataA, userDataB].map(value => fs.promises.mkdir(value, { recursive: true })));
    const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await Promise.all([
      fs.promises.writeFile(path.join(userDataA, 'installation-id'), `${idA}\n`),
      fs.promises.writeFile(path.join(userDataB, 'installation-id'), `${idB}\n`),
    ]);
    const [a, b] = await Promise.all([runFixture('init', configured, userDataA), runFixture('init', configured, userDataB)]);
    assert.equal(a.cacheRoot, path.join(configured, '.photoflow-cache', idA));
    assert.equal(b.cacheRoot, path.join(configured, '.photoflow-cache', idB));
    assert(a.finalExists && b.finalExists && a.state === 'READY' && b.state === 'READY');
    assert.equal(a.integrity, 'ok');
    assert.equal(b.integrity, 'ok');

    const evictedA = await runFixture('evict', configured, userDataA);
    const untouchedB = await runFixture('inspect', configured, userDataB);
    assert.equal(evictedA.finalExists, false);
    assert.equal(evictedA.state, 'STALE');
    assert.equal(untouchedB.finalExists, true, 'process A must not delete process B final');
    assert.equal(untouchedB.state, 'READY', 'process A must not mutate process B database');

    const restoredA = await runFixture('init', configured, userDataA);
    const evictedB = await runFixture('evict', configured, userDataB);
    const untouchedA = await runFixture('inspect', configured, userDataA);
    assert.equal(evictedB.finalExists, false);
    assert.equal(evictedB.state, 'STALE');
    assert.equal(untouchedA.finalExists, true, 'process B must not delete process A final');
    assert.equal(untouchedA.state, 'READY', 'process B must not mutate process A database');
    assert.equal(restoredA.integrity, 'ok');
    assert.equal(evictedB.integrity, 'ok');
    assert.equal(untouchedA.integrity, 'ok');
    console.log(`multi-process namespace evidence: A=${a.cacheRoot} B=${b.cacheRoot} quick_check=ok`);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
