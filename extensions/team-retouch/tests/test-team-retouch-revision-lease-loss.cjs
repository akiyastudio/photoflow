const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHostSimulator } = require('./host-simulator.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'team-retouch-lease-loss-'));
const dataPath = path.join(sandbox, 'storage'); fs.mkdirSync(dataPath, { recursive: true });
const databasePath = path.join(dataPath, 'storage.sqlite3');
const service = path.join(__dirname, '..', 'service.cjs');
const context = { componentId: 'team-retouch', surface: 'project', projectId: 'lease-project' };
const commonEnv = { PHOTOFLOW_TEST_REVISION_LEASES: '1', PHOTOFLOW_TEST_REVISION_LEASE_TTL_MS: '800', PHOTOFLOW_TEST_REVISION_LEASE_RENEW_MS: '100' };
let lifecycleCalls = 0;
const capabilities = {
  'component.storage': () => ({ dataPath, databasePath, projectId: context.projectId, ownership: 'component-private' }),
  'component.lifecycle': () => { lifecycleCalls += 1; return { success: true, state: 'ready' }; },
};
const first = createHostSimulator({ service, context, capabilities, env: commonEnv });
const second = createHostSimulator({ service, context, capabilities, env: commonEnv });

const leaseRows = () => {
  if (!fs.existsSync(databasePath)) return [];
  const db = new DatabaseSync(databasePath); try { db.exec('PRAGMA busy_timeout=100'); return db.prepare('SELECT * FROM team_project_revision_leases').all(); } finally { db.close(); }
};
const waitForLease = async () => {
  for (let count = 0; count < 100; count += 1) { try { const rows = leaseRows(); if (rows.length) return rows[0]; } catch (error) { if (!/locked/.test(String(error.message))) throw error; } await sleep(10); }
  throw new Error('revision lease was not acquired');
};
const deleteLease = () => { const db = new DatabaseSync(databasePath); try { db.prepare('DELETE FROM team_project_revision_leases WHERE project_id=?').run(context.projectId); } finally { db.close(); } };

(async () => {
  try {
    const renewed = await first.request('team.test.revision-lease.v1', { delayMs: 1900, marker: 'renewed' });
    assert.equal(renewed.success, true, 'normal long operation renews through multiple TTL windows');

    const zeroUpdate = first.request('team.test.revision-lease.v1', { delayMs: 350, boundary: 'host', marker: 'zero' });
    await waitForLease(); deleteLease();
    await assert.rejects(zeroUpdate, /租约已失效/);
    assert.equal(lifecycleCalls, 0, 'zero-row renewal aborts before the Host side effect');

    const blocked = first.request('team.test.revision-lease.v1', { delayMs: 1000, blockEventLoop: true, boundary: 'host', marker: 'blocked' });
    await assert.rejects(blocked, /租约已失效/, 'event-loop stalls beyond TTL fail closed');
    assert.equal(lifecycleCalls, 0);

    const oldDb = first.request('team.test.revision-lease.v1', { delayMs: 1100, marker: 'old-db' });
    await waitForLease(); deleteLease();
    const takeover = await second.request('team.test.revision-lease.v1', { marker: 'new-owner' });
    assert.equal(takeover.success, true, 'a second process can take over an abandoned lease');
    await assert.rejects(oldDb, /租约已失效/, 'the old process cannot write after takeover');

    const oldFile = first.request('team.test.revision-lease.v1', { delayMs: 1100, boundary: 'file', marker: 'old-file' });
    await waitForLease(); deleteLease();
    await second.request('team.test.revision-lease.v1', { boundary: 'file', marker: 'new-owner-file' });
    await assert.rejects(oldFile, /租约已失效/, 'the old process cannot publish a persistent file after takeover');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataPath, 'lease-test.json'), 'utf8')).request, 'new-owner-file', 'stale rollback cannot delete or overwrite the successor file');

    const oldJournal = first.request('team.test.revision-lease.v1', { delayMs: 1100, boundary: 'journal', marker: 'old-journal' });
    await waitForLease(); deleteLease();
    await second.request('team.test.revision-lease.v1', { boundary: 'journal', marker: 'new-journal' });
    await assert.rejects(oldJournal, /租约已失效/, 'stale owner cannot append a misleading committed journal record');
    const journal = fs.readFileSync(path.join(dataPath, 'command-log', 'operations.ndjson'), 'utf8');
    assert.match(journal, /new-journal/); assert.doesNotMatch(journal, /old-journal/);

    const oldWorkflow = first.request('team.test.revision-lease.v1', { delayMs: 1100, boundary: 'workflow-stage', marker: 'old-workflow' });
    await waitForLease(); deleteLease();
    await second.request('team.test.revision-lease.v1', { boundary: 'workflow-stage', marker: 'new-workflow' });
    await assert.rejects(oldWorkflow, /租约已失效/, 'stale workflow owner cannot publish or roll back after takeover');
    assert.equal(fs.readFileSync(path.join(dataPath, 'lease-workflow-test', 'workflow', 'owner.txt'), 'utf8'), 'new-workflow');
    assert.equal(fs.readdirSync(path.join(dataPath, 'lease-workflow-test')).some(name => name.startsWith('.stage-')), true, 'stale owner stage remains isolated for validated resume or bounded collection');

    const state = await first.request('team.test.revision-lease-state.v1');
    assert.deepEqual(state, { leases: 0, guards: 0, timers: 0, states: 0 }, 'completion and lease loss clean timers, leases, guards, and in-memory state');

    const faulted = createHostSimulator({ service, context, capabilities, env: { ...commonEnv, PHOTOFLOW_TEST_REVISION_LEASE_RENEW_FAULT: 'sqlite' } });
    try {
      await assert.rejects(faulted.request('team.test.revision-lease.v1', { delayMs: 300, boundary: 'host' }), /租约已失效/, 'SQLite renewal errors are not swallowed');
    } finally { await faulted.close(); }
    console.log('Team-retouch revision lease loss behavior tests passed');
  } finally {
    await Promise.all([first.close(), second.close()]);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
