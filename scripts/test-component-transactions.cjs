const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { captureComponentTreeIdentity, cleanupOwnedComponentPath, verifyComponentTreeIdentity } = require('../electron/component-package-archive.cjs');
const { createComponentTransactionService, nodeIdentity, atomicJson } = require('../electron/services/component-transaction-service.cjs');
const crash = point => Object.assign(new Error(point), { simulateCrash: true });
const exists = target => fs.existsSync(target);
const writeTree = async (root, value) => {
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(path.join(root, 'component.json'), JSON.stringify({ value }));
  await fs.promises.writeFile(path.join(root, 'worker.cjs'), value);
};
const readValue = async root => JSON.parse(await fs.promises.readFile(path.join(root, 'component.json'), 'utf8')).value;
const directoryReceipt = async target => ({ path: target, kind: 'directory', nodeIdentity: nodeIdentity(await fs.promises.lstat(target)), treeIdentity: await captureComponentTreeIdentity(target) });
const fileReceipt = async target => {
  const stat = await fs.promises.lstat(target);
  return { path: target, kind: 'file', nodeIdentity: nodeIdentity(stat), size: stat.size, mode: stat.mode & 0o777, sha256: crypto.createHash('sha256').update(await fs.promises.readFile(target)).digest('hex') };
};
const journalDirectory = state => path.join(state.installRoot, '.transactions', state.componentId);
const readLatestJournal = async state => {
  const directory = journalDirectory(state);
  const statePath = path.join(directory, 'state.json');
  const mutable = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
  const receipt = JSON.parse(await fs.promises.readFile(path.join(directory, 'receipt.json'), 'utf8'));
  return { journal: { ...receipt, ...mutable }, mutable, receipt, statePath, directory };
};
const fixture = async supplied => {
  const sandbox = supplied || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-component-transaction-'));
  const installRoot = path.join(sandbox, 'components');
  const componentId = 'fixture.component';
  const container = path.join(installRoot, componentId);
  const destination = path.join(container, 'runtime');
  await fs.promises.mkdir(container, { recursive: true });
  const enabled = new Map([[componentId, true]]);
  const blocked = new Set();
  const warnings = [];
  const hostPath = path.join(sandbox, 'host.json');
  const hostCommit = async () => fs.promises.writeFile(hostPath, JSON.stringify({ version: 'new' }));
  const defaultCleanup = (_id, clear) => clear ? ['settings', 'secrets'].map(name => ({ name, run: () => fs.promises.rm(path.join(sandbox, name), { force: true }) })) : [];
  const makeService = ({ fault = async () => undefined, cleanupFault = async () => undefined, trashFault = null, onTrash = async () => undefined, fsImpl = fs, preparationRoot = '', cleanupProvider = defaultCleanup,
    recoverInstallHostState = hostCommit, captureTreeIdentityOverride = captureComponentTreeIdentity, verifyTreeIdentityOverride = verifyComponentTreeIdentity } = {}) => createComponentTransactionService({
    fs: fsImpl, path, crypto, installRoot, preparationRoot, fault,
    captureTreeIdentity: captureTreeIdentityOverride, verifyTreeIdentity: verifyTreeIdentityOverride,
    cleanupOwnedPath: (receipt, options) => cleanupOwnedComponentPath(receipt, { ...options, fault: cleanupFault, beforeDelete: async () => {
      await options.beforeDelete?.(); await onTrash(receipt);
      if (trashFault?.current) { const error = trashFault.current; trashFault.current = null; throw error; }
    } }),
    getComponentEnabled: id => enabled.get(id) !== false, setComponentEnabled: (id, value) => enabled.set(id, value), clearComponentEnabledState: id => enabled.delete(id),
    cleanupProvider, recoverInstallHostState, onBlocked: id => blocked.add(id), onUnblocked: id => blocked.delete(id), onWarning: error => warnings.push(error),
  });
  const stage = async value => {
    const target = path.join(installRoot, `.${componentId}-install-${crypto.randomUUID()}`);
    await writeTree(target, value);
    const receipt = await directoryReceipt(target);
    return { target, identity: receipt.nodeIdentity, tree: receipt.treeIdentity };
  };
  const installArgs = staged => ({ componentId, container, destination, stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree, validatePublished: async () => undefined, commitHostState: hostCommit });
  const uninstallArgs = async (clearUserData = false) => {
    const target = clearUserData ? container : destination;
    const receipt = await directoryReceipt(target);
    return { componentId, container, destination, targetPath: target, targetIdentity: receipt.nodeIdentity, targetTreeIdentity: receipt.treeIdentity, clearUserData, previousEnabled: enabled.get(componentId) !== false };
  };
  return { sandbox, installRoot, componentId, container, destination, enabled, blocked, warnings, hostPath, hostCommit, makeService, stage, installArgs, uninstallArgs };
};
const withFixture = async run => {
  const state = await fixture();
  try { await run(state); } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};
const crashOnceAt = target => {
  let fired = false;
  return async point => { if (!fired && point === target) { fired = true; throw crash(point); } };
};

const installCrashMatrix = async () => {
  const beforeCommit = ['journal:after:prepared', 'install:before-publish', 'install:after-publish', 'journal:after:published', 'journal:before:host-committing'];
  const afterCommit = ['journal:after:host-committing', 'install:host-committed', 'journal:after:cleanup-pending', 'journal:after:done', 'journal:after-retire'];
  for (const hasOld of [false, true]) for (const previousEnabled of [false, true]) {
    const points = [...beforeCommit, ...afterCommit, ...(hasOld ? ['install:before-backup', 'install:after-backup', 'cleanup:before:committed-backup', 'cleanup:after:committed-backup'] : [])];
    for (const point of points) await withFixture(async state => {
      if (hasOld) await writeTree(state.destination, 'old');
      state.enabled.set(state.componentId, previousEnabled);
      const staged = await state.stage('new');
      await assert.rejects(state.makeService({ fault: crashOnceAt(point) }).install({ ...state.installArgs(staged), previousEnabled }), error => error.simulateCrash);
      const forward = afterCommit.includes(point) || point.includes('committed-backup');
      const recovered = await state.makeService().recover();
      assert(!recovered.some(item => item.status === 'blocked'), `${point}: ${JSON.stringify(recovered)}`);
      assert.equal(exists(state.destination), hasOld || forward, point);
      if (hasOld || forward) assert.equal(await readValue(state.destination), forward ? 'new' : 'old', point);
      assert.equal(state.enabled.has(state.componentId), hasOld || forward, point);
      if (hasOld || forward) assert.equal(state.enabled.get(state.componentId), forward || previousEnabled, point);
      assert.equal(await state.makeService().hasPendingJournal(state.componentId), false, point);
      assert.equal(exists(staged.target), false, point);
      assert.deepEqual(await state.makeService().recover(), [], 'recovery is idempotent');
    });
  }
};
const rollbackCanCrashAgain = async () => {
  for (const point of ['cleanup:before:rollback-runtime', 'cleanup:after:rollback-runtime', 'install:after-restore', 'cleanup:before:rollback-staging', 'cleanup:after:rollback-staging']) await withFixture(async state => {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    const firstPoint = point.includes('staging') ? 'install:after-backup' : 'journal:after:published';
    await assert.rejects(state.makeService({ fault: crashOnceAt(firstPoint) }).install(state.installArgs(staged)), error => error.simulateCrash);
    assert.equal((await state.makeService({ fault: crashOnceAt(point) }).recover())[0].status, 'blocked');
    const result = await state.makeService().recover();
    assert.equal(result[0].status, 'rolled-back', `${point}: ${JSON.stringify(result)}`);
    assert.equal(await readValue(state.destination), 'old');
  });
};
const uninstallCrashMatrix = async () => {
  for (const clear of [false, true]) {
    const points = ['journal:after:prepared', 'uninstall:before-quarantine', 'uninstall:after-quarantine', 'journal:after:quarantined', 'journal:after:cleanup-pending', 'cleanup:before:uninstall-runtime', 'cleanup:after:uninstall-runtime', 'journal:after:done', ...(clear ? ['uninstall:before:settings', 'uninstall:after:settings', 'uninstall:after:secrets'] : [])];
    for (const point of points) await withFixture(async state => {
      await writeTree(state.destination, 'installed');
      await fs.promises.writeFile(path.join(state.container, 'user-data'), 'keep unless requested');
      for (const name of ['settings', 'secrets']) await fs.promises.writeFile(path.join(state.sandbox, name), 'private');
      await assert.rejects(state.makeService({ fault: crashOnceAt(point) }).uninstall(await state.uninstallArgs(clear)), error => error.simulateCrash);
      const result = await state.makeService().recover();
      assert(!result.some(item => item.status === 'blocked'), `${point}: ${JSON.stringify(result)}`);
      assert.equal(exists(state.destination), false);
      assert.equal(exists(path.join(state.container, 'user-data')), !clear);
      for (const name of ['settings', 'secrets']) assert.equal(exists(path.join(state.sandbox, name)), !clear);
      assert.equal(state.enabled.has(state.componentId), false);
    });
  }
};
const partialDeletionAndOrdinaryFailures = async () => {
  for (const kind of ['install', 'uninstall', 'preparation']) await withFixture(async state => {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    const options = {};
    const args = state.installArgs(staged);
    if (kind === 'preparation') {
      options.preparationRoot = state.sandbox;
      args.operationId = crypto.randomUUID();
      const preparationPath = path.join(state.sandbox, `photoflow-component-package-${state.componentId}-${args.operationId}`);
      await writeTree(preparationPath, 'package');
      await fs.promises.writeFile(`${preparationPath}.zip`, 'zip snapshot');
      args.preparationCleanup = [await directoryReceipt(preparationPath), await fileReceipt(`${preparationPath}.zip`)];
    }
    let fired = false;
    const service = state.makeService({ ...options, cleanupFault: point => { if (!fired && point === 'cleanup:file-deleted') { fired = true; throw crash(point); } } });
    await assert.rejects(kind === 'uninstall' ? service.uninstall(await state.uninstallArgs()) : service.install(args), error => error.simulateCrash);
    const result = await state.makeService(options).recover();
    assert.equal(result[0].status, kind === 'preparation' ? 'rolled-back' : 'committed', JSON.stringify(result));
    if (kind !== 'uninstall') assert.equal(await readValue(state.destination), kind === 'preparation' ? 'old' : 'new');
  });
  await withFixture(async state => {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    await assert.rejects(state.makeService().install({ ...state.installArgs(staged), validatePublished: async () => { throw new Error('invalid package'); } }), /invalid package/);
    assert.equal(await readValue(state.destination), 'old');
    assert.equal(await state.makeService().hasPendingJournal(state.componentId), false);
    const service = state.makeService({ trashFault: { current: new Error('file busy') } });
    const next = await state.stage('new');
    await assert.rejects(service.install(state.installArgs(next)), /file busy/);
    assert.equal((await readLatestJournal(state)).mutable.cleanup['committed-backup'], 'executing');
    assert.equal((await state.makeService().recover())[0].status, 'committed');
  });
};
const corruptionAndOwnership = async () => {
  for (const mode of ['invalid-json', 'wrong-receipt', 'out-of-root', 'foreign-cleanup', 'unknown-runtime', 'missing-runtime', 'added-file', 'wrong-preparation']) await withFixture(async state => {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    await assert.rejects(state.makeService({ fault: crashOnceAt('journal:after:published') }).install(state.installArgs(staged)), error => error.simulateCrash);
    const { mutable, receipt, statePath, directory } = await readLatestJournal(state);
    if (mode === 'invalid-json') await fs.promises.writeFile(statePath, '{');
    if (mode === 'wrong-receipt') { mutable.receiptDigest = '0'.repeat(64); await fs.promises.writeFile(statePath, JSON.stringify(mutable)); }
    if (mode === 'foreign-cleanup') { mutable.cleanup['another-component'] = 'executing'; await fs.promises.writeFile(statePath, JSON.stringify(mutable)); }
    if (mode === 'out-of-root' || mode === 'wrong-preparation') {
      if (mode === 'out-of-root') receipt.source.path = state.sandbox;
      else receipt.preparationCleanup = [{ name: 'package-stage', receipt: await directoryReceipt(state.destination) }];
      const bytes = JSON.stringify(receipt);
      await fs.promises.writeFile(path.join(directory, 'receipt.json'), bytes);
      mutable.receiptDigest = crypto.createHash('sha256').update(bytes).digest('hex');
      await fs.promises.writeFile(statePath, JSON.stringify(mutable));
    }
    if (mode === 'unknown-runtime') { await fs.promises.rename(state.destination, `${state.destination}.displaced`); await writeTree(state.destination, 'foreign'); }
    if (mode === 'missing-runtime') await fs.promises.rm(state.destination, { recursive: true });
    if (mode === 'added-file') await fs.promises.writeFile(path.join(state.destination, 'user-file'), 'must survive');
    const result = await state.makeService().recover();
    assert.equal(result[0].status, 'blocked', `${mode}: ${JSON.stringify(result)}`);
    if (mode === 'unknown-runtime') assert.equal(await readValue(state.destination), 'foreign');
    if (mode === 'added-file') assert.equal(await fs.promises.readFile(path.join(state.destination, 'user-file'), 'utf8'), 'must survive');
    assert(exists(receipt.backup.path), 'old version is retained for recovery');
  });
};
const atomicStateAndMetadataFailures = async () => {
  for (const mode of ['before-replace', 'after-rename-error', 'temporary-delete-error']) await withFixture(async state => {
    const filePath = path.join(state.sandbox, 'state.json');
    await fs.promises.writeFile(filePath, JSON.stringify({ step: 'old' }));
    const promises = { ...fs.promises,
      rename: async (...args) => { await fs.promises.rename(...args); if (mode === 'after-rename-error') throw new Error('lost response'); },
      unlink: async (...args) => { if (mode === 'temporary-delete-error') throw new Error('file busy'); return fs.promises.unlink(...args); },
    };
    const operation = atomicJson({ fs: { ...fs, promises }, path, crypto, filePath, value: { step: 'new' }, fault: point => { if (mode === 'before-replace' && point === 'json:before-replace') throw new Error('disk full'); } });
    if (mode === 'before-replace') await assert.rejects(operation, /disk full/); else await operation;
    assert.equal(JSON.parse(await fs.promises.readFile(filePath)).step, mode === 'before-replace' ? 'old' : 'new');
  });
  for (const mode of ['retire', 'receipt', 'state', 'directory']) await withFixture(async state => {
    await writeTree(state.destination, 'old');
    const fsImpl = { ...fs, promises: { ...fs.promises,
      rename: async (from, to) => { if (mode === 'retire' && path.basename(to).startsWith('.retired-')) throw new Error('antivirus busy'); return fs.promises.rename(from, to); },
      unlink: async target => { if (target.includes('.retired-') && path.basename(target) === `${mode}.json`) throw new Error('antivirus busy'); return fs.promises.unlink(target); },
      rmdir: async target => { if (mode === 'directory' && target.includes('.retired-')) throw new Error('antivirus busy'); return fs.promises.rmdir(target); },
    } };
    const result = await state.makeService({ fsImpl }).install(state.installArgs(await state.stage('new')));
    assert.equal(result.status, 'committed'); assert.equal(result.cleanupWarnings.length, 1);
    assert.equal(state.blocked.size, 0);
    state.enabled.set(state.componentId, false);
    await state.makeService().recover();
    assert.equal(state.enabled.get(state.componentId), false, 'metadata recovery must not replay an obsolete enabled value');
    assert.equal(await readValue(state.destination), 'new');
    assert.deepEqual(await fs.promises.readdir(path.join(state.installRoot, '.transactions')), []);
  });
};
const largeReceiptAndSmallState = async () => withFixture(async state => {
  const staged = await state.stage('new');
  const files = Array.from({ length: 20_000 }, (_, index) => ({ path: `file-${index}`, kind: 'file', node: { dev: 1, ino: index + 1, birthtimeMs: 1 }, size: 1, mode: 0o600, sha256: 'a'.repeat(64) }));
  let initialReceipt;
  let writes = 0;
  const service = state.makeService({ verifyTreeIdentityOverride: async () => true, fault: async (point, value) => {
    if (point !== 'json:after-replace') return;
    if (path.basename(value.filePath) === 'receipt.json') { initialReceipt = await fs.promises.readFile(value.filePath); writes += 1; }
    if (path.basename(value.filePath) === 'state.json') assert((await fs.promises.stat(value.filePath)).size < 2048);
    if (value.value.phase === 'host-committing') throw crash(point);
  } });
  await assert.rejects(service.install({ ...state.installArgs(staged), stagingTreeIdentity: files }), error => error.simulateCrash);
  assert(initialReceipt.length > 2 * 1024 * 1024);
  assert.equal(writes, 1, 'large immutable receipt is written once');
  assert.deepEqual((await fs.promises.readdir(journalDirectory(state))).sort(), ['receipt.json', 'state.json']);
  assert.deepEqual(await fs.promises.readFile(path.join(journalDirectory(state), 'receipt.json')), initialReceipt);
});
const actualProcessCrash = async () => {
  for (const point of ['install:after-backup', 'install:after-publish', 'install:host-committed', 'cleanup:after:committed-backup']) await withFixture(async state => {
    await writeTree(state.destination, 'old');
    const child = spawnSync(process.execPath, [__filename, '--crash-child', state.sandbox, point], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(child.status, 86, `${point}: ${child.stderr}`);
    const result = await state.makeService().recover();
    const forward = point.includes('host-committed') || point.includes('committed-backup');
    assert.equal(result[0].status, forward ? 'committed' : 'rolled-back', JSON.stringify(result));
    assert.equal(await readValue(state.destination), forward ? 'new' : 'old');
    if (forward) assert.equal(JSON.parse(await fs.promises.readFile(state.hostPath)).version, 'new');
  });
};
const commitFailuresStayForward = async () => withFixture(async state => {
  await writeTree(state.destination, 'old');
  const staged = await state.stage('new');
  await assert.rejects(state.makeService().install({ ...state.installArgs(staged), commitHostState: async () => {
    await state.hostCommit(); throw new Error('commit response lost');
  } }), /commit response lost/);
  assert.equal((await readLatestJournal(state)).mutable.phase, 'host-committing');
  assert.equal(await readValue(state.destination), 'new');
  assert.equal((await state.makeService().recover())[0].status, 'committed');
  const calls = { settings: 0, secrets: 0 };
  const cleanupProvider = () => [
    { name: 'settings', run: () => { calls.settings += 1; } },
    { name: 'secrets', run: () => { if (++calls.secrets === 1) throw new Error('secret store busy'); } },
  ];
  await assert.rejects(state.makeService({ cleanupProvider }).uninstall(await state.uninstallArgs(true)), /secret store busy/);
  const pending = (await readLatestJournal(state)).mutable;
  assert.equal(pending.cleanup['data:settings'], 'applied');
  assert.equal(pending.cleanup['data:secrets'], 'executing');
  assert.equal((await state.makeService({ cleanupProvider }).recover())[0].status, 'committed');
  assert.deepEqual(calls, { settings: 1, secrets: 2 });
});
const metadataCannotCrossOperations = async () => withFixture(async state => {
  await writeTree(state.destination, 'old');
  let reachAdmission; let releaseAdmission;
  const reached = new Promise(resolve => { reachAdmission = resolve; });
  const gate = new Promise(resolve => { releaseAdmission = resolve; });
  const service = state.makeService({ fault: async point => { if (point === 'journal:before-admission') { reachAdmission(); await gate; } } });
  const installing = service.install(state.installArgs(await state.stage('new')));
  await reached;
  assert.deepEqual(await service.recover('another-component'), []);
  assert((await fs.promises.readdir(service.journalRoot)).some(name => name.startsWith('.admit-')));
  releaseAdmission(); await installing;
  let retireFailed = false;
  const nextService = state.makeService({ fault: point => { if (point === 'journal:before-retire' && !retireFailed) { retireFailed = true; throw new Error('metadata busy'); } } });
  await nextService.install(state.installArgs(await state.stage('next')));
  assert.equal(await nextService.hasPendingJournal(state.componentId), false);
  assert(exists(journalDirectory(state)), 'status reads do not mutate or retire a journal');
  await nextService.install({ ...state.installArgs(await state.stage('latest')), desiredEnabled: false });
  assert.equal(await readValue(state.destination), 'latest');
  assert.equal(state.enabled.get(state.componentId), false);
});
const concurrentRecoveryIsSingleFlight = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'installed');
    const trashFault = { current: Object.assign(new Error('retry later'), { code: 'EIO' }) };
    await assert.rejects(state.makeService({ trashFault }).uninstall({
      componentId: state.componentId, container: state.container, destination: state.destination,
      targetPath: state.destination, targetIdentity: nodeIdentity(await fs.promises.lstat(state.destination)),
      targetTreeIdentity: await captureComponentTreeIdentity(state.destination), clearUserData: false, previousEnabled: true,
    }));
    let trashCalls = 0;
    const recoveryService = state.makeService({ onTrash: () => { trashCalls += 1; } });
    const [left, right] = await Promise.all([recoveryService.recover(state.componentId), recoveryService.recover(state.componentId)]);
    assert.deepEqual(left, right);
    assert.equal(trashCalls, 1, 'concurrent recovery calls share one replay');
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const activeTransactionRejectsRecovery = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    let reachedValidation;
    const validationReached = new Promise(resolve => { reachedValidation = resolve; });
    let continueValidation;
    const validationGate = new Promise(resolve => { continueValidation = resolve; });
    const service = state.makeService();
    const install = service.install({
      componentId: state.componentId, container: state.container, destination: state.destination,
      stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree,
      validatePublished: async () => { reachedValidation(); await validationGate; }, commitHostState: async () => undefined,
    });
    await validationReached;
    await assert.rejects(service.recover(state.componentId), error => error.code === 'COMPONENT_LIFECYCLE_BUSY');
    continueValidation();
    await install;
    assert.equal(await readValue(state.destination), 'new');
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const makePendingUninstall = async state => {
  await writeTree(state.destination, 'installed');
  const trashFault = { current: Object.assign(new Error('retry later'), { code: 'EIO' }) };
  await assert.rejects(state.makeService({ trashFault }).uninstall({
    componentId: state.componentId, container: state.container, destination: state.destination,
    targetPath: state.destination, targetIdentity: nodeIdentity(await fs.promises.lstat(state.destination)),
    targetTreeIdentity: await captureComponentTreeIdentity(state.destination), clearUserData: false, previousEnabled: true,
  }));
};

const crossScopeRecoveryIsExclusive = async () => {
  for (const order of ['full-first', 'filtered-first']) {
    const state = await fixture();
    try {
      await makePendingUninstall(state);
      let releaseTrash;
      const trashGate = new Promise(resolve => { releaseTrash = resolve; });
      let signalTrash;
      const trashStarted = new Promise(resolve => { signalTrash = resolve; });
      let calls = 0;
      const service = state.makeService({ onTrash: async () => { calls += 1; signalTrash(); await trashGate; } });
      const first = order === 'full-first' ? service.recover() : service.recover(state.componentId);
      await trashStarted;
      const second = order === 'full-first' ? service.recover(state.componentId) : service.recover();
      releaseTrash();
      await Promise.all([first, second]);
      assert.equal(calls, 1, `${order} must replay cleanup once`);
    } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
  }
};

const fullRecoveryWaitsForActiveInstall = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    let signalValidation;
    const validationStarted = new Promise(resolve => { signalValidation = resolve; });
    let releaseValidation;
    const validationGate = new Promise(resolve => { releaseValidation = resolve; });
    const service = state.makeService();
    const install = service.install({
      componentId: state.componentId, container: state.container, destination: state.destination,
      stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree,
      validatePublished: async () => { signalValidation(); await validationGate; }, commitHostState: async () => undefined,
    });
    await validationStarted;
    let recoverySettled = false;
    const recovery = service.recover().then(result => { recoverySettled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recoverySettled, false, 'global recovery waits for active install');
    releaseValidation();
    await Promise.all([install, recovery]);
    assert.equal(await readValue(state.destination), 'new');
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const recoveryDoesNotCrossActiveUninstall = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'installed');
    let signalTrash;
    const trashStarted = new Promise(resolve => { signalTrash = resolve; });
    let releaseTrash;
    const trashGate = new Promise(resolve => { releaseTrash = resolve; });
    let calls = 0;
    const service = state.makeService({ onTrash: async () => { calls += 1; signalTrash(); await trashGate; } });
    const uninstall = service.uninstall({
      componentId: state.componentId, container: state.container, destination: state.destination,
      targetPath: state.destination, targetIdentity: nodeIdentity(await fs.promises.lstat(state.destination)),
      targetTreeIdentity: await captureComponentTreeIdentity(state.destination), clearUserData: false, previousEnabled: true,
    });
    await trashStarted;
    await assert.rejects(service.recover(state.componentId), error => error.code === 'COMPONENT_LIFECYCLE_BUSY');
    let globalSettled = false;
    const globalRecovery = service.recover().then(result => { globalSettled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(globalSettled, false, 'global recovery waits for active uninstall');
    releaseTrash();
    await Promise.all([uninstall, globalRecovery]);
    assert.equal(calls, 1, 'active uninstall and recovery cannot duplicate trash');
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

(async () => {
  if (process.argv[2] === '--crash-child') {
    const state = await fixture(process.argv[3]);
    const service = state.makeService({ fault: point => { if (point === process.argv[4]) process.exit(86); } });
    await service.install(state.installArgs(await state.stage('new')));
    throw new Error('child crash point was not reached');
  }
  for (const test of [installCrashMatrix, rollbackCanCrashAgain, uninstallCrashMatrix, partialDeletionAndOrdinaryFailures, corruptionAndOwnership,
    atomicStateAndMetadataFailures, largeReceiptAndSmallState, actualProcessCrash, commitFailuresStayForward, metadataCannotCrossOperations, concurrentRecoveryIsSingleFlight, activeTransactionRejectsRecovery,
    crossScopeRecoveryIsExclusive, fullRecoveryWaitsForActiveInstall, recoveryDoesNotCrossActiveUninstall]) {
    await test(); console.log(`${test.name} passed`);
  }
  console.log('Component durable transaction tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
