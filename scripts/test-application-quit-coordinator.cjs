const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerMainWindowQuitGuard, runApplicationQuit } = require('../electron/services/application-quit-coordinator.cjs');

const fixture = ({ background = true, failStopOnce = false, confirm = true } = {}) => {
  const events = [];
  let stopFailure = failStopOnce;
  let processesPresent = background;
  const lifecycle = {
    cancelApplicationQuit: () => events.push('cancel-gate'),
    requestApplicationStop: () => events.push('request-stop'),
    waitForAllWork: async () => events.push('work-drained'),
    commitApplicationQuit: () => events.push('commit'),
  };
  const processSupervisor = {
    list: () => processesPresent ? [{ state: 'running', pid: 1234, owner: { componentId: 'fixture.component' } }] : [],
    stopWhere: async () => events.push('component-processes-stopped'),
    stopAll: async () => {
      events.push('all-processes-stop');
      if (stopFailure) { stopFailure = false; throw Object.assign(new Error('termination failed'), { code: 'PROCESS_TERMINATION_FAILED' }); }
      processesPresent = false;
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
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.match(mainSource, /buttons:\s*\['关闭后台进程并继续退出',\s*'取消'\],\s*defaultId:\s*1,\s*cancelId:\s*1/);
  const systemIpcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'modules', 'system-ipc.cjs'), 'utf8');
  assert.match(systemIpcSource, /uninstall:[\s\S]*?continueLabel:\s*'关闭后台进程并继续退出'[\s\S]*?buttons:\s*\[presentation\.continueLabel,\s*'取消'\],\s*defaultId:\s*1,\s*cancelId:\s*1/, '卸载确认锁定真实退出文案与安全默认项');
  let quitState = 'idle'; let appQuitCalls = 0; let allowedCloseCalls = 0;
  const mainWindow = new EventEmitter();
  mainWindow.close = () => {
    let prevented = false;
    mainWindow.emit('close', { preventDefault: () => { prevented = true; } });
    if (!prevented) allowedCloseCalls += 1;
    return !prevented;
  };
  registerMainWindowQuitGuard({ window: mainWindow, app: { quit: () => { appQuitCalls += 1; quitState = 'draining'; } }, getQuitState: () => quitState, platform: 'win32' });
  assert.equal(mainWindow.close(), false, 'window X/custom window-close cannot destroy the window before quit confirmation');
  assert.equal(appQuitCalls, 1);
  assert.equal(mainWindow.close(), false, 'repeated close while draining stays singleflight');
  assert.equal(appQuitCalls, 1);
  quitState = 'idle';
  assert.equal(mainWindow.close(), false, 'cancel or termination failure keeps the original window and permits retry');
  assert.equal(appQuitCalls, 2);
  quitState = 'ready';
  assert.equal(mainWindow.close(), true);
  assert.equal(allowedCloseCalls, 1, 'the committed app.quit closes the original window exactly once');

  const macWindow = new EventEmitter(); let macPrevented = false; let macQuitCalls = 0;
  registerMainWindowQuitGuard({ window: macWindow, app: { quit: () => { macQuitCalls += 1; } }, getQuitState: () => 'idle', platform: 'darwin' });
  macWindow.emit('close', { preventDefault: () => { macPrevented = true; } });
  assert.equal(macPrevented, false); assert.equal(macQuitCalls, 0, 'macOS keeps close-without-quit behavior');

  const cancelled = fixture({ confirm: false });
  await assert.rejects(runApplicationQuit(cancelled.options), error => error.code === 'APP_QUIT_CANCELLED');
  assert.deepEqual(cancelled.events, ['prompt', 'cancel-gate']);
  assert.equal(cancelled.events.includes('video-disposed'), false, 'before-quit cancellation cannot dispose video sessions');

  const continued = fixture({ confirm: true });
  await runApplicationQuit(continued.options);
  assert(continued.events.indexOf('services-stopped') < continued.events.indexOf('component-processes-stopped'), 'owned services stop before generic owner processes');
  assert(continued.events.indexOf('all-processes-stopped') < continued.events.indexOf('commit'));
  assert(continued.events.indexOf('commit') < continued.events.indexOf('video-disposed'));

  const exhausted = fixture({ background: false, confirm: true });
  exhausted.options.processSupervisor.list = () => [{ state: 'failed', pid: null, targetPid: null, terminationFailed: false, owner: { componentId: 'fixture.component' } }];
  exhausted.options.processSupervisor.hasUnconfirmedOwner = () => false;
  await runApplicationQuit(exhausted.options);
  assert.equal(exhausted.events.includes('prompt'), false, 'restart-exhausted entries without a live child do not prompt on quit');

  const retry = fixture({ confirm: true, failStopOnce: true });
  await assert.rejects(runApplicationQuit(retry.options), error => error.code === 'PROCESS_TERMINATION_FAILED');
  assert.equal(retry.events.includes('commit'), false);
  assert.equal(retry.events.includes('video-disposed'), false);
  assert.equal(retry.events.includes('broker-released'), true);
  await runApplicationQuit(retry.options);
  assert.equal(retry.events.filter(event => event === 'commit').length, 1, 'second quit attempt reaches the commit point once');
  assert.equal(retry.events.filter(event => event === 'video-disposed').length, 1, 'video disposal happens only after confirmed retry');

  const capabilityRetry = fixture({ confirm: true }); let capabilityCloseFails = true;
  capabilityRetry.options.componentViewManager.closeAllAndWait = async () => { capabilityRetry.events.push('views-closed'); if (capabilityCloseFails) { capabilityCloseFails = false; throw new Error('capability clear failed'); } };
  await assert.rejects(runApplicationQuit(capabilityRetry.options), /capability clear failed/);
  assert.equal(capabilityRetry.events.includes('commit'), false, 'capability cleanup failure blocks quit commit');
  await runApplicationQuit(capabilityRetry.options);
  assert.equal(capabilityRetry.events.filter(event => event === 'commit').length, 1, 'capability cleanup failure remains retryable');

  const unconfirmed = fixture({ background: false, confirm: true });
  let stopAttempts = 0;
  unconfirmed.options.processSupervisor.list = () => stopAttempts < 2
    ? [{ state: 'stopped', terminationFailed: true, owner: { componentId: 'fixture.component' } }]
    : [];
  unconfirmed.options.processSupervisor.stopAll = async () => { stopAttempts += 1; unconfirmed.events.push('all-processes-stop'); };
  unconfirmed.options.processSupervisor.hasUnconfirmedOwner = () => stopAttempts < 2;
  await assert.rejects(runApplicationQuit(unconfirmed.options), error => error.code === 'PROCESS_TERMINATION_FAILED');
  assert.equal(unconfirmed.events.includes('prompt'), true, 'stopped but unconfirmed owner still requires confirmation');
  assert.equal(unconfirmed.events.includes('commit'), false);
  assert.equal(unconfirmed.events.includes('video-disposed'), false);
  await runApplicationQuit(unconfirmed.options);
  assert.equal(unconfirmed.events.filter(event => event === 'commit').length, 1);
  assert.equal(unconfirmed.events.filter(event => event === 'video-disposed').length, 1);

  const staleOwner = fixture({ background: false, confirm: true });
  staleOwner.options.componentIds = [];
  let staleStopAttempts = 0;
  staleOwner.options.processSupervisor.list = () => staleStopAttempts < 2
    ? [{ state: 'stopped', terminationFailed: true, owner: { componentId: 'stale.component' } }]
    : [];
  staleOwner.options.processSupervisor.stopAll = async () => { staleStopAttempts += 1; staleOwner.events.push('all-processes-stop'); };
  staleOwner.options.processSupervisor.hasUnconfirmedOwner = componentId => componentId === 'stale.component' && staleStopAttempts < 2;
  await assert.rejects(runApplicationQuit(staleOwner.options), error => error.code === 'PROCESS_TERMINATION_FAILED' && error.componentIds.includes('stale.component'));
  assert.equal(staleOwner.events.includes('commit'), false, 'stale supervisor owner blocks commit even when registry is empty');
  assert.equal(staleOwner.events.includes('video-disposed'), false);
  await runApplicationQuit(staleOwner.options);
  assert.equal(staleOwner.events.filter(event => event === 'commit').length, 1);
  assert.equal(staleOwner.events.filter(event => event === 'video-disposed').length, 1);

  console.log('Application quit commit-point tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
