const assert = require('node:assert/strict');
const { ComponentLifecycleCoordinator } = require('../electron/services/component-lifecycle-coordinator.cjs');

(async () => {
  const blocked = new Set();
  const coordinator = new ComponentLifecycleCoordinator({ blocker: id => blocked.has(id) });

  const install = coordinator.acquire('a', 'install');
  assert.throws(() => coordinator.acquire('a', 'uninstall'), error => error.code === 'COMPONENT_QUIESCING');
  assert.equal(coordinator.beginApplicationQuit(), false, 'quit must not race an active component transition');
  install.release();

  const work = coordinator.acquireWork('b', 'lifecycle:repair');
  const intent = coordinator.acquire('b', 'uninstall', { stopOnly: true });
  assert.throws(() => coordinator.acquireWork('b', 'lifecycle:install'), error => error.code === 'COMPONENT_QUIESCING', 'intent blocks new work');
  let promoted = false;
  const promotion = intent.promote().then(() => { promoted = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(promoted, false, 'transition waits for existing lifecycle work');
  work.release();
  await promotion;
  intent.release();

  assert.equal(coordinator.beginApplicationQuit(), true);
  assert.throws(() => coordinator.acquire('c', 'install'), error => error.code === 'COMPONENT_QUIESCING');
  coordinator.cancelApplicationQuit();

  blocked.add('c');
  assert.throws(() => coordinator.acquire('c', 'install'), error => error.code === 'COMPONENT_TERMINATION_UNCONFIRMED');
  const retry = coordinator.acquire('c', 'uninstall', { stopOnly: true });
  retry.release();

  coordinator.blockPersistent('d', new Error('cleanup pending'));
  assert.throws(() => coordinator.acquireWork('d'), error => error.code === 'COMPONENT_TRANSACTION_BLOCKED');
  coordinator.unblockPersistent('d');
  const recovered = coordinator.acquireWork('d');
  recovered.release();

  coordinator.beginStartupRecovery();
  assert.throws(() => coordinator.acquireWork('e'), error => error.code === 'COMPONENT_RECOVERY_PENDING');
  assert.equal(coordinator.beginApplicationQuit(), false, 'quit waits for startup transaction recovery');
  coordinator.completeStartupRecovery();

  const quitWork = coordinator.acquireWork('quit-fixture', 'lifecycle:pre-spawn');
  assert.equal(coordinator.beginApplicationQuit(), true);
  let quitWorkSettled = false;
  const quitWait = coordinator.waitForAllWork({ timeoutMs: 1000 }).then(() => { quitWorkSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitWorkSettled, false);
  assert.throws(() => coordinator.assertLaunchAllowed('quit-fixture', quitWork), error => error.code === 'COMPONENT_QUIESCING');
  quitWork.release();
  await quitWait;
  coordinator.cancelApplicationQuit();

  console.log('Component lifecycle coordinator tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
