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
  assert.equal(coordinator.currentLease('b'), work, 'registered and returned work lease identity is stable');
  const intent = coordinator.acquire('b', 'uninstall', { stopOnly: true });
  assert.throws(() => coordinator.acquireWork('b', 'lifecycle:install'), error => error.code === 'COMPONENT_QUIESCING', 'intent blocks new work');
  assert.doesNotThrow(() => coordinator.assertLaunchAllowed('b', work), 'existing work may launch while the user is deciding');
  intent.requestStop();
  assert.throws(() => coordinator.assertLaunchAllowed('b', work), error => error.code === 'COMPONENT_QUIESCING');
  assert.throws(() => coordinator.assertLaunchAllowed('b', intent), error => error.code === 'COMPONENT_QUIESCING', 'transition token cannot authorize process launch after stop');
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
  const recoveryGate = coordinator.acquireRecovery('d');
  assert.equal(coordinator.beginApplicationQuit(), false, 'filtered recovery blocks application quit before destructive work');
  assert.throws(() => coordinator.acquireWork('d'), error => error.code === 'COMPONENT_TRANSACTION_BLOCKED');
  recoveryGate.requestStop(); await recoveryGate.promote(); recoveryGate.release();
  assert.throws(() => coordinator.acquireWork('d'), error => error.code === 'COMPONENT_TRANSACTION_BLOCKED', 'releasing recovery does not clear the durable blocker');
  coordinator.unblockPersistent('d');
  const recovered = coordinator.acquireWork('d');
  recovered.release();

  const recoveryDrainCoordinator = new ComponentLifecycleCoordinator();
  const oldRecoveryWork = recoveryDrainCoordinator.acquireWork('recover-drain', 'old-work');
  recoveryDrainCoordinator.blockPersistent('recover-drain', new Error('pending journal'));
  const drainingRecovery = recoveryDrainCoordinator.acquireRecovery('recover-drain'); drainingRecovery.requestStop();
  let recoveryPromoted = false; const recoveryPromotion = drainingRecovery.promote().then(() => { recoveryPromoted = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(recoveryPromoted, false, 'recovery waits for pre-existing work');
  oldRecoveryWork.release(); await recoveryPromotion; drainingRecovery.release();

  const timeoutCoordinator = new ComponentLifecycleCoordinator({ promotionTimeoutMs: 20 });
  const stuckWork = timeoutCoordinator.acquireWork('stuck', 'leaked-work'); const timedTransition = timeoutCoordinator.acquire('stuck', 'disable', { stopOnly: true }); timedTransition.requestStop();
  await assert.rejects(timedTransition.promote(), error => error.code === 'COMPONENT_BUSY');
  assert.equal(timeoutCoordinator.transitions.get('stuck').phase, 'intent', 'promotion timeout does not enter exclusive mutation phase');
  assert.equal(timeoutCoordinator.workWaiters.has('stuck'), false, 'promotion timeout removes its waiter'); timedTransition.release();
  stuckWork.release(); const retryTransition = timeoutCoordinator.acquire('stuck', 'disable', { stopOnly: true }); retryTransition.requestStop(); await retryTransition.promote(); retryTransition.release();

  const quitTimeoutCoordinator = new ComponentLifecycleCoordinator();
  const stuckQuitWork = quitTimeoutCoordinator.acquireWork('quit-timeout', 'leaked-work');
  await assert.rejects(quitTimeoutCoordinator.waitForAllWork({ timeoutMs: 20 }), error => error.code === 'APP_QUIT_BUSY');
  assert.equal(quitTimeoutCoordinator.workWaiters.has('quit-timeout'), false, 'application timeout removes every registered waiter');
  stuckQuitWork.release(); await quitTimeoutCoordinator.waitForAllWork({ timeoutMs: 20 });

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
  assert.doesNotThrow(() => coordinator.assertLaunchAllowed('quit-fixture', quitWork), 'quit intent does not disrupt existing work before confirmation');
  coordinator.requestApplicationStop();
  assert.throws(() => coordinator.assertLaunchAllowed('quit-fixture', quitWork), error => error.code === 'COMPONENT_QUIESCING');
  quitWork.release();
  await quitWait;
  coordinator.cancelApplicationQuit();

  const cancelledCoordinator = new ComponentLifecycleCoordinator();
  const cancelledWork = cancelledCoordinator.acquireWork('cancel-fixture', 'runtime');
  assert.equal(cancelledCoordinator.beginApplicationQuit(), true);
  assert.doesNotThrow(() => cancelledCoordinator.assertLaunchAllowed('cancel-fixture', cancelledWork));
  cancelledCoordinator.cancelApplicationQuit();
  assert.doesNotThrow(() => cancelledCoordinator.assertLaunchAllowed('cancel-fixture', cancelledWork), 'cancel leaves existing work healthy');
  cancelledWork.release();

  const terminationCoordinator = new ComponentLifecycleCoordinator({ blocker: id => blocked.has(id) });
  const terminationLease = terminationCoordinator.acquireWork('hard-termination');
  blocked.add('hard-termination');
  assert.throws(() => terminationCoordinator.assertLaunchAllowed('hard-termination', terminationLease), error => error.code === 'COMPONENT_TERMINATION_UNCONFIRMED');
  terminationLease.release(); blocked.delete('hard-termination');

  const persistentCoordinator = new ComponentLifecycleCoordinator();
  const persistentLease = persistentCoordinator.acquireWork('hard-persistent');
  persistentCoordinator.blockPersistent('hard-persistent', new Error('blocked'));
  assert.throws(() => persistentCoordinator.assertLaunchAllowed('hard-persistent', persistentLease), error => error.code === 'COMPONENT_TRANSACTION_BLOCKED');
  persistentLease.release();

  const corruptCoordinator = new ComponentLifecycleCoordinator();
  const corruptLease = corruptCoordinator.acquireWork('hard-corrupt');
  corruptCoordinator.blockForCorruptTransaction();
  assert.throws(() => corruptCoordinator.assertLaunchAllowed('hard-corrupt', corruptLease), error => error.code === 'COMPONENT_TRANSACTION_BLOCKED');
  assert.throws(() => corruptCoordinator.acquireRecovery('hard-corrupt'), error => error.code === 'COMPONENT_QUIESCING');
  corruptLease.release();

  const startupCoordinator = new ComponentLifecycleCoordinator();
  const startupLease = startupCoordinator.acquireWork('hard-startup');
  startupCoordinator.beginStartupRecovery();
  assert.throws(() => startupCoordinator.assertLaunchAllowed('hard-startup', startupLease), error => error.code === 'COMPONENT_RECOVERY_PENDING');
  startupLease.release();

  console.log('Component lifecycle coordinator tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
