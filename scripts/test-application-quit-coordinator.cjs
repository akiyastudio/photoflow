const assert = require('node:assert/strict');
const { runApplicationQuit } = require('../electron/services/application-quit-coordinator.cjs');

const fixture = ({ background = true, failStopOnce = false, confirm = true } = {}) => {
  const events = [];
  let stopFailure = failStopOnce;
  const lifecycle = {
    cancelApplicationQuit: () => events.push('cancel-gate'),
    waitForAllWork: async () => events.push('work-drained'),
    commitApplicationQuit: () => events.push('commit'),
  };
  const processSupervisor = {
    list: () => background ? [{ state: 'running', owner: { componentId: 'fixture.component' } }] : [],
    stopWhere: async () => events.push('component-processes-stopped'),
    stopAll: async () => {
      events.push('all-processes-stop');
      if (stopFailure) { stopFailure = false; throw Object.assign(new Error('termination failed'), { code: 'PROCESS_TERMINATION_FAILED' }); }
      events.push('all-processes-stopped');
    },
  };
  const options = {
    componentIds: ['fixture.component'], processSupervisor,
    componentServiceManager: { stopAll: async () => events.push('services-stopped') },
    componentViewManager: { closeAllAndWait: async () => events.push('views-closed') },
    componentLifecycleCoordinator: lifecycle,
    componentCapabilityBroker: { blockComponent: () => ({ drain: async () => events.push('broker-drained'), release: () => events.push('broker-released') }) },
    abortComponentNetworkRequests: () => events.push('network-aborted'),
    confirmBackgroundProcesses: async () => { events.push('prompt'); return confirm; },
    teardown: [() => events.push('video-disposed'), () => events.push('databases-closed')],
  };
  return { events, options };
};

(async () => {
  const cancelled = fixture({ confirm: false });
  await assert.rejects(runApplicationQuit(cancelled.options), error => error.code === 'APP_QUIT_CANCELLED');
  assert.deepEqual(cancelled.events, ['prompt', 'cancel-gate']);
  assert.equal(cancelled.events.includes('video-disposed'), false, 'before-quit cancellation cannot dispose video sessions');

  const continued = fixture({ confirm: true });
  await runApplicationQuit(continued.options);
  assert(continued.events.indexOf('all-processes-stopped') < continued.events.indexOf('commit'));
  assert(continued.events.indexOf('commit') < continued.events.indexOf('video-disposed'));

  const retry = fixture({ confirm: true, failStopOnce: true });
  await assert.rejects(runApplicationQuit(retry.options), error => error.code === 'PROCESS_TERMINATION_FAILED');
  assert.equal(retry.events.includes('commit'), false);
  assert.equal(retry.events.includes('video-disposed'), false);
  assert.equal(retry.events.includes('broker-released'), true);
  await runApplicationQuit(retry.options);
  assert.equal(retry.events.filter(event => event === 'commit').length, 1, 'second quit attempt reaches the commit point once');
  assert.equal(retry.events.filter(event => event === 'video-disposed').length, 1, 'video disposal happens only after confirmed retry');

  const unconfirmed = fixture({ background: false, confirm: true });
  let stopAttempts = 0;
  unconfirmed.options.processSupervisor.list = () => [{ state: 'stopped', terminationFailed: true, owner: { componentId: 'fixture.component' } }];
  unconfirmed.options.processSupervisor.stopAll = async () => { stopAttempts += 1; unconfirmed.events.push('all-processes-stop'); };
  unconfirmed.options.processSupervisor.hasUnconfirmedOwner = () => stopAttempts < 2;
  await assert.rejects(runApplicationQuit(unconfirmed.options), error => error.code === 'PROCESS_TERMINATION_FAILED');
  assert.equal(unconfirmed.events.includes('prompt'), true, 'stopped but unconfirmed owner still requires confirmation');
  assert.equal(unconfirmed.events.includes('commit'), false);
  assert.equal(unconfirmed.events.includes('video-disposed'), false);
  await runApplicationQuit(unconfirmed.options);
  assert.equal(unconfirmed.events.filter(event => event === 'commit').length, 1);
  assert.equal(unconfirmed.events.filter(event => event === 'video-disposed').length, 1);

  console.log('Application quit commit-point tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
