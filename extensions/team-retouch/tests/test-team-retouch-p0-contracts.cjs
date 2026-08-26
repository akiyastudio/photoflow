const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHostSimulator } = require('./host-simulator.cjs');

(async () => {
  const schedulerPath = pathToFileURL(path.join(__dirname, '..', 'renderer', 'src', 'legacy', 'legacy-media-scheduler.ts')).href;
  const { scheduleLegacyMedia, expireLegacyMedia } = await import(schedulerPath);
  let active = 0; let maximum = 0; let executions = 0;
  const work = key => scheduleLegacyMedia(key, async () => {
    executions += 1; active += 1; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 8)); active -= 1; return key;
  });
  const duplicate = [work('same'), work('same'), ...Array.from({ length: 8 }, (_, index) => work(`item-${index}`))];
  await Promise.all(duplicate);
  assert.equal(executions, 9, 'ref+variant-equivalent requests share one in-flight request');
  assert(maximum <= 5, `media scheduler exceeded bounded concurrency: ${maximum}`);
  expireLegacyMedia('reject');
  await assert.rejects(scheduleLegacyMedia('reject', async () => { throw new Error('rpc rejected'); }), /rpc rejected/);
  assert.equal(await scheduleLegacyMedia('reject', async () => 'recovered'), 'recovered', 'a rejected RPC releases pending state and remains retryable');

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-durable-contract-'));
  const dataPath = path.join(sandbox, 'storage'); fs.mkdirSync(dataPath, { recursive: true });
  let taskCapabilityCalls = 0;
  const simulator = createHostSimulator({
    service: path.join(__dirname, '..', 'service.cjs'),
    context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'durable-project', projectName: 'Durable', projectStatus: 'active' },
    capabilities: {
      'component.storage.v2': () => ({ apiVersion: 2, dataPath, databasePath: path.join(dataPath, 'storage.sqlite3'), projectId: 'durable-project', ownership: 'component-private' }),
      'tasks.v2': () => { taskCapabilityCalls += 1; return { apiVersion: 2, task: null, cancelled: false }; },
    },
  });
  try {
    const startedAt = performance.now();
    const accepted = await simulator.request('team.workflow.generate.v1', { acceptOnly: true, operationId: 'durable-1', groups: [] });
    const ackMs = performance.now() - startedAt;
    assert.deepEqual({ accepted: accepted.accepted, state: accepted.state, operationId: accepted.operationId }, { accepted: true, state: 'accepted', operationId: 'durable-1' });
    assert(ackMs < 1000, `durable acceptance exceeded 1s: ${ackMs.toFixed(1)}ms`);
    assert.equal(taskCapabilityCalls, 0, 'no Host capability remains running after the acceptance response');
    const status = await simulator.request('team.operation.get.v1', { operationId: 'durable-1' });
    assert.equal(status.operation.state, 'accepted');
    await simulator.request('team.operation.cancel.v1', { operationId: 'durable-1' });
    const cancelled = await simulator.request('team.operation.get.v1', { operationId: 'durable-1' });
    assert.equal(cancelled.operation.cancelRequested, true);
    console.log(`Team-retouch P0 contracts passed: durable ack ${ackMs.toFixed(1)}ms, media concurrency ${maximum}`);
  } finally { simulator.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
