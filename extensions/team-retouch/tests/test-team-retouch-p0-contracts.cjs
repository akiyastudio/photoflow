const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHostSimulator } = require('./host-simulator.cjs');

(async () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'service.cjs'), 'utf8');
  assert(serviceSource.includes('p50Ms: percentile(.5)') && serviceSource.includes('p95Ms: percentile(.95)') && serviceSource.includes("migrationMetric('team-rpc'"), 'all RPC metrics expose bounded aggregate p50/p95 fields');
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
  const databasePath = path.join(dataPath, 'storage.sqlite3');
  let taskCapabilityCalls = 0;
  let lifecycleCalls = 0;
  const simulator = createHostSimulator({
    service: path.join(__dirname, '..', 'service.cjs'),
    context: { componentId: 'team-retouch', componentVersion: 'test', surface: 'project', projectId: 'durable-project', projectName: 'Durable', projectStatus: 'active' },
    capabilities: {
      'component.storage': () => ({ dataPath, databasePath, projectId: 'durable-project', ownership: 'component-private' }),
      'tasks': () => { taskCapabilityCalls += 1; return { task: null, cancelled: false }; },
      'component.lifecycle': () => { lifecycleCalls += 1; return { success: true, state: 'ready' }; },
    },
  });
  try {
    const startedAt = performance.now();
    const accepted = await simulator.request('team.workflow.generate.v1', { acceptOnly: true, operationId: 'durable-1', groups: [] });
    const ackMs = performance.now() - startedAt;
    assert.deepEqual({ accepted: accepted.accepted, state: accepted.state, operationId: accepted.operationId }, { accepted: true, state: 'accepted', operationId: 'durable-1' });
    assert(ackMs < 1000, `durable acceptance exceeded 1s: ${ackMs.toFixed(1)}ms`);
    assert.equal(taskCapabilityCalls, 0, 'no Host capability remains running after the acceptance response');
    assert.equal(accepted.revision, '0', 'durable acceptance does not mutate the domain revision');
    const status = await simulator.request('team.operation.get.v1', { operationId: 'durable-1' });
    assert.equal(status.operation.state, 'accepted');
    await assert.rejects(simulator.request('team.identity.assign.v1', { photoId: 'missing', baseVersionId: 'missing', personIndex: 1, expectedRevision: '0' }), /Undeclared simulator capability/);
    const runnable = await simulator.request('team.advanced.preflight.v1', { acceptOnly: true, operationId: 'accept-run-success', expectedRevision: '0' });
    assert.equal(runnable.revision, undefined); assert.equal(runnable.scope, 'application.settings');
    const ran = await simulator.request('team.operation.run.v1', { operationId: 'accept-run-success', expectedRevision: '0' });
    assert.equal(ran.success, true, 'an accepted durable operation runs against its unchanged baseline');
    assert.equal(lifecycleCalls, 1);
    const staleAccepted = await simulator.request('team.advanced.preflight.v1', { acceptOnly: true, operationId: 'accept-run-stale', expectedRevision: '0' });
    assert.equal(staleAccepted.revision, undefined); assert.equal(staleAccepted.scope, 'application.settings');
    const identityMutationStartedAt = performance.now();
    const identityMutation = await simulator.request('team.identity.save.v1', { name: 'Revision Contract', assignments: [] });
    const identityMutationMs = performance.now() - identityMutationStartedAt;
    assert(identityMutationMs < 1000, `lightweight revision-checked mutation exceeded 1s: ${identityMutationMs.toFixed(1)}ms`);
    assert.match(identityMutation.revision, /^\d+$/, 'mutations return the authoritative monotonic workspace revision');
    const globalRun = await simulator.request('team.operation.run.v1', { operationId: 'accept-run-stale', expectedRevision: identityMutation.revision });
    assert.equal(globalRun.success, true, 'application.settings lifecycle is independent of project revision');
    assert.equal(lifecycleCalls, 2);
    await assert.rejects(simulator.request('team.identity.save.v1', { name: 'Stale Mutation', assignments: [], expectedRevision: '0' }), /已被其他操作更新/, 'stale mutations fail inside the public write transaction');
    const durableKinds = [
      ['team.patch.detect.v1', 'detect', { photoId: 'photo', baseVersionId: 'version' }],
      ['team.patch.detect-batch.v1', 'detect-batch', { relativePaths: ['images/one.jpg'] }],
      ['team.identity.suggest.v1', 'identity-suggest', {}],
      ['team.patch.update.v1', 'patch-update', { photoId: 'photo', taskId: 'task' }],
      ['team.person.exclude.v1', 'person-exclude', { photoId: 'photo', baseVersionId: 'version', personIndex: 1 }],
      ['team.advanced.preflight.v1', 'advanced-lifecycle', {}],
      ['team.advanced.install.v1', 'advanced-lifecycle', { repair: true }],
      ['team.advanced.uninstall.v1', 'advanced-lifecycle', {}],
    ];
    let maximumDurableAckMs = ackMs;
    for (const [method, kind, request] of durableKinds) {
      const operationId = `durable-${method}`;
      const operationStartedAt = performance.now();
      const next = await simulator.request(method, { ...request, operationId, acceptOnly: true });
      const operationAckMs = performance.now() - operationStartedAt; maximumDurableAckMs = Math.max(maximumDurableAckMs, operationAckMs);
      assert(operationAckMs < 1000, `${method} durable acceptance exceeded 1s: ${operationAckMs.toFixed(1)}ms`);
      assert.equal(next.state, 'accepted');
      const nextStatus = await simulator.request('team.operation.get.v1', { operationId });
      assert.equal(nextStatus.operation.kind, kind);
    }
    await simulator.request('team.operation.cancel.v1', { operationId: 'durable-1' });
    const cancelled = await simulator.request('team.operation.get.v1', { operationId: 'durable-1' });
    assert.equal(cancelled.operation.cancelRequested, true);
    assert.equal(cancelled.operation.state, 'cancelled', 'accepted-but-not-run operation reaches cancelled terminal state immediately');
    const secretToken = 'SECRET_RETURN_TOKEN_MUST_NOT_PERSIST';
    await simulator.request('team.workflow.return-batch.v1', { acceptOnly: true, operationId: 'secret-return', returnedFiles: [secretToken], items: [] });
    assert(!fs.readFileSync(databasePath).includes(Buffer.from(secretToken)), 'durable SQLite payload never contains one-time return tokens');
    await simulator.request('team.operation.cancel.v1', { operationId: 'secret-return' });
    console.log(`Team-retouch P0 contracts passed: maximum durable ack ${maximumDurableAckMs.toFixed(1)}ms, lightweight mutation ${identityMutationMs.toFixed(1)}ms, media concurrency ${maximum}`);
  } finally { await simulator.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
