const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ThumbnailPipeline } = require('../electron/thumbnail-pipeline.cjs');
const { PythonDatabaseClient } = require('../electron/repositories/database-client.cjs');
const { WorkspaceSqliteCoordinator } = require('../electron/services/workspace-sqlite-coordinator.cjs');
const { createProcessSupervisor } = require('../electron/services/process-supervisor.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-database-process-lifecycle-'));
const repository = path.resolve(__dirname, '..');
const python = path.join(repository, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const makePipeline = processSupervisor => new ThumbnailPipeline({
  getRunConfig: (script, args) => ({ command: python, args: ['-u', path.join(repository, 'python', script), ...args] }),
  processSupervisor, databasePath: path.join(root, 'thumbnail.sqlite3'),
  getCacheDir: () => root, cacheFilePath: () => path.join(root, 'thumbnail.jpg'),
  generateThumbnailSet: async () => [], toPreviewUrl: value => value, trimCache: () => undefined,
  notify: () => undefined, log: () => undefined,
});
const fakeChild = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });

const run = async () => {
  try {
    const thumbnail = makePipeline(null).database;
    const child = fakeChild();
    let attempts = 0;
    const stopError = Object.assign(new Error('tree termination unconfirmed'), { code: 'PROCESS_TREE_TERMINATION_UNCONFIRMED' });
    const managed = { child, lifecycle: { child }, released: false, stop: async () => {
      attempts += 1;
      managed.child = null;
      if (attempts === 1) throw stopError;
      managed.released = true;
      return { stopped: true };
    } };
    thumbnail.process = child; thumbnail.managedProcess = managed;
    await assert.rejects(thumbnail.stop(), error => error === stopError, 'thumbnail stop failures must not become success');
    assert.equal(thumbnail.managedProcess, managed, 'retain ownership for retry after the parent exits');
    assert.throws(() => thumbnail.ensureProcess(), error => error === stopError, 'an unconfirmed database owner must block replacement');
    await thumbnail.stop();
    assert.equal(attempts, 2);
    assert.equal(thumbnail.managedProcess, null);
    assert.equal(thumbnail.stopFailure, null);

    const healthClient = (supervisor, owner) => {
      const client = new PythonDatabaseClient({
        coordinator: new WorkspaceSqliteCoordinator(), getRunConfig: () => ({ command: 'unused', args: [] }),
        getDatabasePath: () => path.join(root, 'unused.sqlite3'), writeLog: () => undefined,
        domainId: 'fixture-domain', processSupervisor: supervisor,
      });
      const process = fakeChild(); client.attachProcess(process, owner);
      process.emit('exit', 1);
      return client;
    };
    assert.equal(healthClient({ stopping: true }, { stopping: true }).status().state, 'healthy', 'application shutdown cannot degrade a healthy database domain');
    assert.equal(healthClient({ stopping: false }, { stopping: true }).status().state, 'healthy', 'intentional managed recycling cannot degrade a healthy database domain');
    assert.equal(healthClient({ stopping: false }, { stopping: false }).status().state, 'degraded', 'unexpected database exits still report faults');

    if (process.platform === 'win32') {
      const supervisor = createProcessSupervisor({ windowsJobByDefault: true });
      const children = [];
      const launch = supervisor.launch.bind(supervisor);
      supervisor.launch = specification => { const managedProcess = launch(specification); children.push(managedProcess.child); return managedProcess; };
      try {
        for (let index = 0; index < 6; index += 1) {
          const pipeline = makePipeline(supervisor);
          await pipeline.database.call('get_cache_epoch');
          await pipeline.database.stop();
          assert.equal(supervisor.list().length, 0, 'temporary thumbnail clients must release their supervisor entry');
          await pipeline.stop();
        }
        const pipeline = makePipeline(supervisor);
        await pipeline.database.call('get_cache_epoch');
        await Promise.all([pipeline.database.stop(), supervisor.stopAll('application-quit')]);
        await pipeline.stop();
        assert.equal(children.length, 7);
        assert(children.every(process => process.__photoFlowTreeExitConfirmed === true && process.__photoFlowCloseObserved === true), 'every database recycle and final quit must confirm the entire job and helper close');
        assert.equal(supervisor.list().length, 0);
      } finally { await supervisor.stopAll('fixture-cleanup'); }
    }
    console.log('Database lifecycle: failed-stop retry, intentional/unexpected health classification, 6 thumbnail recycles and concurrent quit passed.');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
};
run().catch(error => { console.error(error); process.exitCode = 1; });
