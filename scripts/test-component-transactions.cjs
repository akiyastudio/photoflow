const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureComponentTreeIdentity, componentCleanupIntentPaths, verifyComponentTreeIdentity } = require('../electron/component-package-archive.cjs');
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
  await fs.promises.mkdir(container, { recursive: true });
  const enabled = new Map([[componentId, true]]);
  const makeService = ({ fault = async () => undefined, cleanupFault = async () => undefined, trashFault = null, blocked = new Set(), onTrash = () => undefined } = {}) => createComponentTransactionService({
    fs, path, crypto, installRoot,
    captureTreeIdentity: captureComponentTreeIdentity,
    verifyTreeIdentity: verifyComponentTreeIdentity,
    cleanupOwnedPath: async (receipt, { persistPrepared }) => {
      const sidecars = componentCleanupIntentPaths(receipt);
      const preparedReceipt = { ...receipt, cleanupPhase: 'prepared', sidecarReceipts: [['intent', sidecars.intentPath], ['proof', sidecars.proofPath], ['verified', sidecars.verifiedPath]].map(([role, sidecarPath]) => ({ path: sidecarPath, role, size: 1, sha256: 'a'.repeat(64), nativeIdentity: `native:${role}` })) };
      await persistPrepared(preparedReceipt);
      await cleanupFault('after-prepared', preparedReceipt);
      await onTrash(receipt);
      if (trashFault?.current) { const error = trashFault.current; trashFault.current = null; throw error; }
      await fs.promises.rm(receipt.path, { recursive: true, force: true });
      await cleanupFault('after-delete', preparedReceipt);
      return { preparedReceipt };
    },
    finalizeOwnedPath: receipt => cleanupFault('finalize', receipt),
    deleteOwnedFile: async receipt => {
      const stat = await fs.promises.lstat(receipt.path);
      const content = await fs.promises.readFile(receipt.path);
      const digest = crypto.createHash('sha256').update(content).digest('hex');
      if (stat.isSymbolicLink() || stat.dev !== receipt.nodeIdentity.dev || stat.ino !== receipt.nodeIdentity.ino || stat.birthtimeMs !== receipt.nodeIdentity.birthtimeMs || stat.size !== receipt.size || digest !== receipt.sha256) throw new Error('bound file replacement');
      await fs.promises.unlink(receipt.path);
    },
    getComponentEnabled: id => enabled.get(id) !== false,
    setComponentEnabled: (id, value) => enabled.set(id, value),
    clearComponentEnabledState: id => enabled.delete(id),
    recoverInstallHostState: async (_id, target, desired) => { await readValue(target); enabled.set(componentId, desired); },
    cleanupProvider: (_id, clearUserData) => clearUserData ? [{ name: 'settings', run: async () => undefined }, { name: 'secrets', run: async () => undefined }] : [],
    onBlocked: id => blocked.add(id),
    onUnblocked: id => blocked.delete(id),
    fault,
  });
  const stage = async value => {
    const target = path.join(installRoot, `.${componentId}-install-${crypto.randomUUID()}`);
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
      const targetIdentity = nodeIdentity(await fs.promises.lstat(state.container));
      const targetTreeIdentity = await captureComponentTreeIdentity(state.container);
      let fired = false;
      const service = state.makeService({ fault: async current => { if (!fired && current === point) { fired = true; throw crash(point); } } });
      await assert.rejects(service.uninstall({ componentId: state.componentId, container: state.container, destination: state.destination, targetPath: state.container, targetIdentity, targetTreeIdentity, clearUserData: true, previousEnabled: true }), error => error.simulateCrash === true);
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
        await assert.rejects(service.uninstall({ componentId: state.componentId, container: state.container, destination: state.destination, targetPath: state.container, targetIdentity: nodeIdentity(await fs.promises.lstat(state.container)), targetTreeIdentity: await captureComponentTreeIdentity(state.container), clearUserData: true, previousEnabled: true }));
        await state.makeService().recover();
        const remaining = await fs.promises.lstat(state.destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        assert.equal(Boolean(remaining), phase === 'prepared', `${code} uninstall ${phase}`);
      } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
    }
  }
};

const partialCleanupRecovery = async () => {
  for (const phase of ['prepared', 'after-delete', 'data-complete', 'finalized']) {
    const state = await fixture();
    try {
      await writeTree(state.destination, 'installed');
      let fired = false;
      const crashAtPhase = point => {
        if (fired) return;
        if (phase === 'prepared' && point === 'after-prepared' || phase === 'after-delete' && point === 'after-delete' || phase === 'data-complete' && point === 'cleanup:data-complete:uninstall-runtime' || phase === 'finalized' && point === 'cleanup:finalized:uninstall-runtime') {
          fired = true;
          throw crash(`cleanup:${phase}`);
        }
      };
      const service = state.makeService({ fault: crashAtPhase, cleanupFault: crashAtPhase });
      await assert.rejects(service.uninstall({
        componentId: state.componentId, container: state.container, destination: state.destination,
        targetPath: state.destination, targetIdentity: nodeIdentity(await fs.promises.lstat(state.destination)),
        targetTreeIdentity: await captureComponentTreeIdentity(state.destination), clearUserData: false, previousEnabled: true,
      }), error => error.simulateCrash === true);
      const journal = JSON.parse(await fs.promises.readFile(path.join(state.installRoot, '.transactions', `${state.componentId}.json`), 'utf8'));
      assert.equal(journal.cleanupItems.find(item => item.name === 'uninstall-runtime').phase, phase === 'after-delete' ? 'prepared' : phase);
      const recovered = await state.makeService().recover();
      assert.equal(recovered[0].status, 'committed', phase);
      assert.equal(await fs.promises.lstat(state.destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), null, phase);
      assert.equal(state.enabled.has(state.componentId), false, phase);
    } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
  }
};

const installCleanupRoleCrashRecovery = async () => {
  for (const role of ['rollback-runtime', 'rollback-staging', 'committed-backup']) {
    const state = await fixture();
    try {
      await writeTree(state.destination, 'old');
      state.enabled.set(state.componentId, false);
      const staged = await state.stage('new');
      let fired = false;
      const cleanupFault = (point, receipt) => {
        const matches = role === 'rollback-runtime' ? receipt.path === state.destination : role === 'rollback-staging' ? receipt.path === staged.target : receipt.path.includes('-quarantine-');
        if (!fired && matches && point === 'after-delete') { fired = true; throw crash(`${role}:after-delete`); }
      };
      const fault = role === 'rollback-staging' ? point => { if (point === 'install:publish') throw new Error('publish rejected'); } : async () => undefined;
      const validatePublished = role === 'rollback-runtime' ? async () => { throw new Error('validation rejected'); } : async () => undefined;
      await assert.rejects(state.makeService({ cleanupFault, fault }).install({
        componentId: state.componentId, container: state.container, destination: state.destination,
        stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree,
        previousEnabled: false, desiredEnabled: true, validatePublished, commitHostState: async () => undefined,
      }));
      const journalPath = path.join(state.installRoot, '.transactions', `${state.componentId}.json`);
      const journal = JSON.parse(await fs.promises.readFile(journalPath, 'utf8'));
      assert.equal(journal.cleanupItems.find(item => item.name === role).phase, 'prepared', `${role} persists prepared before native deletion`);
      const recovered = await state.makeService().recover();
      assert.equal(recovered[0].status, role === 'committed-backup' ? 'committed' : 'rolled-back');
      assert.equal(await readValue(state.destination), role === 'committed-backup' ? 'new' : 'old');
      assert.equal(state.enabled.get(state.componentId), role === 'committed-backup');
    } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
  }
};

const committedCleanupKeepsLatestPreparedRecord = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'old');
    state.enabled.set(state.componentId, false);
    const staged = await state.stage('new');
    const trashFault = { current: Object.assign(new Error('native delete retry'), { code: 'EIO' }) };
    await assert.rejects(state.makeService({ trashFault }).install({
      componentId: state.componentId, container: state.container, destination: state.destination,
      stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree,
      previousEnabled: false, desiredEnabled: true, validatePublished: async () => undefined, commitHostState: async () => undefined,
    }), error => Boolean(error.journal));
    const journal = JSON.parse(await fs.promises.readFile(path.join(state.installRoot, '.transactions', `${state.componentId}.json`), 'utf8'));
    assert.equal(journal.phase, 'committed', 'forward-only cleanup failure never regresses to host-committing');
    assert.equal(journal.cleanupItems.find(item => item.name === 'committed-backup').phase, 'prepared', 'latest prepared receipt survives outer error handling');
    assert.equal(state.enabled.get(state.componentId), false, 'desired enablement waits for cleanup finalization');
    await state.makeService().recover();
    assert.equal(state.enabled.get(state.componentId), true);
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const cleanupReceiptTamperIsBlocked = async () => {
  const state = await fixture();
  try {
    await writeTree(state.destination, 'installed');
    let fired = false;
    await assert.rejects(state.makeService({ fault: point => {
      if (!fired && point === 'cleanup:pending:uninstall-runtime') { fired = true; throw crash(point); }
    } }).uninstall({
      componentId: state.componentId, container: state.container, destination: state.destination,
      targetPath: state.destination, targetIdentity: nodeIdentity(await fs.promises.lstat(state.destination)),
      targetTreeIdentity: await captureComponentTreeIdentity(state.destination), clearUserData: false, previousEnabled: true,
    }), error => error.simulateCrash === true);
    const journalPath = path.join(state.installRoot, '.transactions', `${state.componentId}.json`);
    const journal = JSON.parse(await fs.promises.readFile(journalPath, 'utf8'));
    journal.cleanupItems[0].receipt.path = path.join(state.sandbox, 'outside-owned-root');
    await fs.promises.writeFile(journalPath, `${JSON.stringify(journal)}\n`, 'utf8');
    let nativeDeletes = 0;
    const recovered = await state.makeService({ onTrash: () => { nativeDeletes += 1; } }).recover();
    assert.equal(recovered[0].status, 'blocked');
    assert.equal(nativeDeletes, 0, 'forged cleanup receipt must be rejected before native deletion');
    assert.equal(await readValue(journal.quarantinePath), 'installed');
    assert.equal(fs.existsSync(journalPath), true, 'corrupt journal remains durably blocked for inspection');
  } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
};

const missingCleanupTargetsFailClosed = async () => {
  for (const role of ['rollback-runtime', 'committed-backup', 'uninstall-runtime']) {
    const state = await fixture();
    try {
      let fired = false;
      let cleanupTarget;
      if (role === 'uninstall-runtime') {
        await writeTree(state.destination, 'installed');
        await assert.rejects(state.makeService({ fault: point => { if (!fired && point === 'cleanup:pending:uninstall-runtime') { fired = true; throw crash(point); } } }).uninstall({
          componentId: state.componentId, container: state.container, destination: state.destination,
          targetPath: state.destination, targetIdentity: nodeIdentity(await fs.promises.lstat(state.destination)), targetTreeIdentity: await captureComponentTreeIdentity(state.destination), clearUserData: false,
        }), error => error.simulateCrash === true);
      } else {
        await writeTree(state.destination, 'old');
        const staged = await state.stage('new');
        const faultPoint = role === 'rollback-runtime' ? 'journal:install:published' : 'install:cleanup-backup';
        await assert.rejects(state.makeService({ fault: point => { if (!fired && point === faultPoint) { fired = true; throw crash(point); } } }).install({
          componentId: state.componentId, container: state.container, destination: state.destination,
          stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree,
          validatePublished: async () => undefined, commitHostState: async () => undefined,
        }), error => error.simulateCrash === true);
      }
      const journalPath = path.join(state.installRoot, '.transactions', `${state.componentId}.json`);
      const journal = JSON.parse(await fs.promises.readFile(journalPath, 'utf8'));
      cleanupTarget = role === 'rollback-runtime' ? journal.destination : journal.quarantinePath;
      await fs.promises.rm(cleanupTarget, { recursive: true, force: true });
      let nativeDeletes = 0;
      const recovered = await state.makeService({ onTrash: () => { nativeDeletes += 1; } }).recover();
      assert.equal(recovered[0].status, 'blocked', role);
      assert.equal(nativeDeletes, 0, `${role} missing without prepared proof performs zero native deletes`);
      assert.equal(fs.existsSync(journalPath), true, `${role} remains persistently blocked`);
    } finally { await fs.promises.rm(state.sandbox, { recursive: true, force: true }); }
  }
};

const replacementsBeforeCommitStayDisabled = async () => {
  for (const mode of ['install', 'uninstall', 'rollback']) {
    const state = await fixture();
    try {
      await writeTree(state.destination, 'old');
      state.enabled.set(state.componentId, false);
      let replaced = false;
      const replaceDestination = async (point, receipt) => {
        if (point !== 'finalize' || replaced) return;
        const relevant = mode === 'install' ? receipt.path.includes('-quarantine-') : mode === 'uninstall' ? receipt.path.includes('-uninstall-') : receipt.path.includes('-install-');
        if (!relevant) return;
        replaced = true;
        await fs.promises.rm(state.destination, { recursive: true, force: true });
        await writeTree(state.destination, 'competitor');
      };
      if (mode === 'uninstall') {
        await assert.rejects(state.makeService({ cleanupFault: replaceDestination }).uninstall({
          componentId: state.componentId, container: state.container, destination: state.destination,
          targetPath: state.destination, targetIdentity: nodeIdentity(await fs.promises.lstat(state.destination)), targetTreeIdentity: await captureComponentTreeIdentity(state.destination), clearUserData: false, previousEnabled: false,
        }));
      } else {
        const staged = await state.stage('new');
        const fault = mode === 'rollback' ? point => { if (point === 'install:publish') throw new Error('publish rejected'); } : async () => undefined;
        await assert.rejects(state.makeService({ cleanupFault: replaceDestination, fault }).install({
          componentId: state.componentId, container: state.container, destination: state.destination,
          stagingPath: staged.target, stagingIdentity: staged.identity, stagingTreeIdentity: staged.tree,
          previousEnabled: false, desiredEnabled: true, validatePublished: async () => undefined, commitHostState: async () => undefined,
        }));
      }
      assert.equal(replaced, true, mode);
      assert.equal(await readValue(state.destination), 'competitor', `${mode} preserves replacement runtime`);
      assert.equal(state.enabled.get(state.componentId), false, `${mode} never enables or clears disabled state after replacement`);
      assert.equal(fs.existsSync(path.join(state.installRoot, '.transactions', `${state.componentId}.json`)), true, `${mode} remains durably blocked`);
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
  await installCrashRecovery();
  await committedCleanupRecovery();
  await committedCleanupKeepsLatestPreparedRecord();
  await preJournalFailureRetainsCallerOwnership();
  await firstInstallRollbackIsAbsent();
  await uninstallRecovery();
  await runtimeTrashRetry();
  await competitorIsNeverDeleted();
  await journalFaultMatrix();
  await partialCleanupRecovery();
  await installCleanupRoleCrashRecovery();
  await cleanupReceiptTamperIsBlocked();
  await missingCleanupTargetsFailClosed();
  await replacementsBeforeCommitStayDisabled();
  await concurrentRecoveryIsSingleFlight();
  await activeTransactionRejectsRecovery();
  await crossScopeRecoveryIsExclusive();
  await fullRecoveryWaitsForActiveInstall();
  await recoveryDoesNotCrossActiveUninstall();
  console.log('Component durable transaction tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
