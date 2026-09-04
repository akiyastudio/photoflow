const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureComponentTreeIdentity, verifyComponentTreeIdentity } = require('../electron/component-package-archive.cjs');
const { createComponentTransactionService, nodeIdentity } = require('../electron/services/component-transaction-service.cjs');

const writeTree = async (root, value) => {
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(path.join(root, 'component.json'), JSON.stringify({ value }), 'utf8');
};
const readValue = async root => JSON.parse(await fs.promises.readFile(path.join(root, 'component.json'), 'utf8')).value;
const crash = message => Object.assign(new Error(message), { simulateCrash: true, code: 'SIMULATED_CRASH' });

const fixture = async () => {
  const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'photoflow-component-transaction-'));
  const installRoot = path.join(sandbox, 'components');
  const componentId = 'fixture.component';
  const container = path.join(installRoot, componentId);
  const destination = path.join(container, 'runtime');
  const recycle = path.join(sandbox, 'recycle');
  await fs.promises.mkdir(container, { recursive: true });
  await fs.promises.mkdir(recycle, { recursive: true });
  const enabled = new Map([[componentId, true]]);
  const makeService = ({ fault = async () => undefined, trashFault = null, blocked = new Set(), onTrash = () => undefined } = {}) => createComponentTransactionService({
    fs, path, crypto, installRoot,
    captureTreeIdentity: captureComponentTreeIdentity,
    verifyTreeIdentity: verifyComponentTreeIdentity,
    getComponentEnabled: id => enabled.get(id) !== false,
    setComponentEnabled: (id, value) => enabled.set(id, value),
    clearComponentEnabledState: id => enabled.delete(id),
    recoverInstallHostState: async (_id, target, desired) => { await readValue(target); enabled.set(componentId, desired); },
    cleanupProvider: (_id, clearUserData) => [
      ...(clearUserData ? [{ name: 'settings', run: async () => undefined }, { name: 'secrets', run: async () => undefined }] : []),
      { name: 'runtime-trash', run: async target => {
        onTrash();
        if (trashFault?.current) { const error = trashFault.current; trashFault.current = null; throw error; }
        const stat = await fs.promises.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (stat) await fs.promises.rename(target, path.join(recycle, crypto.randomUUID()));
      } },
    ],
    onBlocked: id => blocked.add(id),
    onUnblocked: id => blocked.delete(id),
    fault,
  });
  const stage = async value => {
    const target = path.join(installRoot, `.stage-${crypto.randomUUID()}`);
    await writeTree(target, value);
    return { target, identity: nodeIdentity(await fs.promises.lstat(target)), tree: await captureComponentTreeIdentity(target) };
  };
  return { sandbox, installRoot, componentId, container, destination, enabled, makeService, stage };
};

const installCrashRecovery = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    let fired = false;
    const service = state.makeService({ fault: async point => { if (!fired && point === 'journal:install:published') { fired = true; throw crash(point); } } });
    await assert.rejects(service.install({
      componentId: state.componentId, container: state.container, destination: state.destination,
      stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree,
      previousEnabled: false, desiredEnabled: true, validatePublished: async target => assert.equal(await readValue(target), 'new'), commitHostState: async () => undefined,
    }), error => error.simulateCrash === true);
    state.enabled.set(state.componentId, true);
    await state.makeService().recover();
    assert.equal(await readValue(state.destination), 'old');
    assert.equal(state.enabled.get(state.componentId), false, 'rollback restores previous enablement');
    assert.equal((await fs.promises.readdir(state.installRoot)).filter(name => name.includes('quarantine')).length, 0, 'only backup is consumed by recovery');
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const committedCleanupRecovery = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    let fired = false;
    const service = state.makeService({ fault: async point => { if (!fired && point === 'install:cleanup-backup') { fired = true; throw crash(point); } } });
    await assert.rejects(service.install({ componentId: state.componentId, container: state.container, destination: state.destination, stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree, previousEnabled: false, desiredEnabled: true, validatePublished: async () => undefined, commitHostState: async () => undefined }), error => error.simulateCrash === true);
    await state.makeService().recover();
    assert.equal(await readValue(state.destination), 'new');
    assert.equal(state.enabled.get(state.componentId), true, 'committed cleanup recovery keeps desired enablement');
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const preJournalFailureRetainsCallerOwnership = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    let fired = false;
    const service = state.makeService({ fault: async point => { if (!fired && point === 'journal:install:prepared') { fired = true; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } } });
    let admitted = false;
    await assert.rejects(service.install({ componentId: state.componentId, container: state.container, destination: state.destination, stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree, validatePublished: async () => undefined, commitHostState: async () => undefined, onAdmitted: () => { admitted = true; } }), error => error.code === 'EACCES');
    assert.equal(admitted, false);
    assert.equal(await readValue(staged.target), 'new');
    assert.equal(await readValue(state.destination), 'old');
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const firstInstallRollbackIsAbsent = async () => {
  for (const point of ['journal:install:published', 'journal:install:host-committing']) {
    const state = await fixture();
    try {
      state.enabled.delete(state.componentId);
      const staged = await state.stage('new');
      let fired = false;
      await assert.rejects(state.makeService({ fault: async current => {
        if (!fired && current === point) { fired = true; throw crash(point); }
      } }).install({
        componentId: state.componentId, container: state.container, destination: state.destination,
        stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree,
        previousInstalled: false, previousEnabled: false, desiredEnabled: true,
        validatePublished: async () => undefined, commitHostState: async () => undefined,
      }), error => error.simulateCrash === true);
      await state.makeService().recover();
      assert.equal(await fs.promises.lstat(state.destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), null, point);
      assert.equal(state.enabled.has(state.componentId), false, `${point} must not leave ghost enablement`);
    } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
  }
};

const uninstallRecovery = async () => {
  for (const point of ['uninstall:quarantine', 'journal:uninstall:quarantined']) {
    const state = await fixture();
    try {
      await writeTree(state.destination, 'installed');
      const targetIdentity = nodeIdentity(await fs.promises.lstat(state.destination));
      const targetTreeIdentity = await captureComponentTreeIdentity(state.destination);
      let fired = false;
      const service = state.makeService({ fault: async current => { if (!fired && current === point) { fired = true; throw crash(point); } } });
      await assert.rejects(service.uninstall({ componentId: state.componentId, container: state.container, destination: state.destination, targetPath: state.destination, targetIdentity, targetTreeIdentity, clearUserData: true, previousEnabled: true }), error => error.simulateCrash === true);
      await state.makeService().recover();
      assert.equal(await fs.promises.lstat(state.destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), null);
      assert.equal(state.enabled.has(state.componentId), false, point);
    } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
  }
};

const runtimeTrashRetry = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'installed');
    const trashFault = { current: Object.assign(new Error('runtime trash denied'), { code: 'EACCES' }) };
    const service = state.makeService({ trashFault });
    await assert.rejects(service.uninstall({ componentId: state.componentId, container: state.container, destination: state.destination, targetPath: state.destination, targetIdentity: nodeIdentity(await fs.promises.lstat(state.destination)), targetTreeIdentity: await captureComponentTreeIdentity(state.destination), clearUserData: false, previousEnabled: true }), error => Boolean(error.code === 'EACCES' && error.journal?.operationId));
    const recovered = await state.makeService().recover();
    assert.equal(recovered[0].status, 'committed');
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const competitorIsNeverDeleted = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'old');
    const staged = await state.stage('new');
    let fired = false;
    await assert.rejects(state.makeService({ fault: async point => { if (!fired && point === 'journal:install:published') { fired = true; throw crash(point); } } }).install({ componentId: state.componentId, container: state.container, destination: state.destination, stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree, validatePublished: async () => undefined, commitHostState: async () => undefined }), error => error.simulateCrash === true);
    const displaced = path.join(state.installRoot, '.displaced-new');
    await fs.promises.rename(state.destination, displaced);
    await writeTree(state.destination, 'competitor');
    const blocked = new Set();
    const result = await state.makeService({ blocked }).recover();
    assert.equal(result[0].status, 'blocked');
    assert.equal(await readValue(state.destination), 'competitor');
    assert.equal(blocked.has(state.componentId), true);
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const journalFaultMatrix = async () => {
  for (const code of ['EIO', 'EACCES']) {
    for (const phase of ['prepared', 'backup-moved', 'published', 'host-committing', 'committed']) {
      const state = await fixture();
      try {
        await writeTree(state.destination, 'old');
        const staged = await state.stage('new');
        let fired = false;
        const service = state.makeService({ fault: async point => {
          if (!fired && point === `journal:install:${phase}`) { fired = true; throw Object.assign(new Error(`${code}:${phase}`), { code }); }
        } });
        const operation = service.install({ componentId: state.componentId, container: state.container, destination: state.destination, stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree, validatePublished: async () => undefined, commitHostState: async () => undefined });
        if (phase === 'committed') await operation;
        else await assert.rejects(operation);
        assert.equal(await readValue(state.destination), phase === 'committed' ? 'new' : 'old', `${code} install ${phase}`);
      } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
    }
    for (const phase of ['prepared', 'quarantined', 'cleanup-pending', 'committed']) {
      const state = await fixture();
      try {
        await writeTree(state.destination, 'installed');
        let fired = false;
        const service = state.makeService({ fault: async point => {
          if (!fired && point === `journal:uninstall:${phase}`) { fired = true; throw Object.assign(new Error(`${code}:${phase}`), { code }); }
        } });
        await assert.rejects(service.uninstall({ componentId: state.componentId, container: state.container, destination: state.destination, targetPath: state.destination, targetIdentity: nodeIdentity(await fs.promises.lstat(state.destination)), targetTreeIdentity: await captureComponentTreeIdentity(state.destination), clearUserData: true, previousEnabled: true }));
        await state.makeService().recover();
        const remaining = await fs.promises.lstat(state.destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        assert.equal(Boolean(remaining), phase === 'prepared', `${code} uninstall ${phase}`);
      } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
    }
  }
};

const partialCleanupRecovery = async () => {
  for (const pathField of ['destination', 'quarantinePath', 'sourcePath']) {
    const state = await fixture();
    try {
      await writeTree(state.destination, 'old');
      const staged = await state.stage('new');
      let publicationFaulted = false;
      let cleanupFaulted = false;
      const fault = async (point, context) => {
        if (pathField === 'sourcePath' && !publicationFaulted && point === 'install:publish') {
          publicationFaulted = true;
          throw new Error('publish stopped before rename');
        }
        if (!cleanupFaulted && point === `cleanup:remove:${pathField}`) {
          cleanupFaulted = true;
          await fs.promises.rm(path.join(context.detached, 'component.json'));
          throw Object.assign(new Error(`partial cleanup ${pathField}`), { code: 'EIO', simulateCrash: true });
        }
      };
      const service = state.makeService({ fault });
      const install = service.install({
        componentId: state.componentId, container: state.container, destination: state.destination,
        stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree,
        validatePublished: async () => { if (pathField === 'destination') throw new Error('validation failure'); },
        commitHostState: async () => undefined,
      });
      await assert.rejects(install);
      const recovered = await state.makeService().recover();
      assert.notEqual(recovered[0].status, 'blocked', pathField);
      assert.equal(await readValue(state.destination), pathField === 'quarantinePath' ? 'new' : 'old', pathField);
    } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
  }
};

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

(async () => {
  await installCrashRecovery();
  await committedCleanupRecovery();
  await preJournalFailureRetainsCallerOwnership();
  await firstInstallRollbackIsAbsent();
  await uninstallRecovery();
  await runtimeTrashRetry();
  await competitorIsNeverDeleted();
  await journalFaultMatrix();
  await partialCleanupRecovery();
  await concurrentRecoveryIsSingleFlight();
  await activeTransactionRejectsRecovery();
  console.log('Component durable transaction tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
