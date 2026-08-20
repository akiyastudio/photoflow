const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDomainCommandJournal } = require('../electron/services/domain-command-journal.cjs');

const waitFor = async predicate => {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('journal test timed out');
};

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-domain-journal-'));
  const journalPath = path.join(temporary, 'journal.json');
  let attempts = 0;
  const journal = createDomainCommandJournal({ filePath: journalPath, backoffMs: [0, 0, 0], writeLog: () => undefined });
  journal.register('team-retouch', 'team-retouch.project.purge.v1', async command => {
    attempts += 1;
    if (attempts < 3) throw new Error('injected team failure');
    return { projectId: command.payload.projectId };
  });
  const queued = journal.enqueue({
    commandId: 'command-1', correlationId: 'correlation-1', target: 'team-retouch',
    type: 'team-retouch.project.purge.v1', workspaceRoot: temporary, payload: { projectId: 'project-1' },
  });
  journal.enqueue({ ...queued, workspaceRoot: temporary });
  await waitFor(() => journal.status()[0]?.status === 'completed');
  assert.strictEqual(journal.status().length, 1, 'command IDs must be idempotent');
  assert.strictEqual(journal.status()[0].attempts, 2, 'failed delivery must be retried');
  journal.stop();

  const reopened = createDomainCommandJournal({ filePath: journalPath, writeLog: () => undefined });
  assert.strictEqual(reopened.status()[0].status, 'completed', 'journal state must survive restart');
  reopened.stop();

  const corruptPath = path.join(temporary, 'corrupt-journal.json');
  fs.writeFileSync(corruptPath, '{not-json', 'utf8');
  const corrupt = createDomainCommandJournal({ filePath: corruptPath, now: () => 12345, writeLog: () => undefined });
  assert.deepStrictEqual(corrupt.status(), [], 'a corrupt journal must not expose partial records');
  assert.ok(fs.existsSync(`${corruptPath}.corrupt-12345`), 'the corrupt journal must be quarantined before new writes');
  corrupt.enqueue({ commandId: 'waiting', target: 'late-domain', type: 'late.command.v1', workspaceRoot: temporary, payload: {} });
  assert.strictEqual(corrupt.status()[0].status, 'pending', 'a command may wait safely for a late handler');
  corrupt.register('late-domain', 'late.command.v1', async () => ({ handled: true }));
  await waitFor(() => corrupt.status()[0]?.status === 'completed');
  corrupt.stop();
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log('Durable domain command journal tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
