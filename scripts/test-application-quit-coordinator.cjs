const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerMainWindowQuitGuard, runApplicationQuit, selectApplicationQuitTasks, applicationQuitTaskDetail } = require('../electron/services/application-quit-coordinator.cjs');

const fixture = ({ background = true, failStopOnce = false, confirm = true, taskSnapshots = background ? [{ id: 'transcode-task', type: 'component-runtime', title: '视频转码', state: 'running' }] : [] } = {}) => {
  const events = [];
  const confirmations = [];
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
    backgroundTasks: { list: () => taskSnapshots },
    confirmPendingTasks: async tasks => { events.push('prompt'); confirmations.push(tasks); return confirm; },
    teardown: [() => events.push('video-disposed'), () => events.push('databases-closed')],
  };
  return { events, options, confirmations };
};

(async () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.match(mainSource, /buttons:\s*\['仍然退出',\s*'暂不退出'\],\s*defaultId:\s*1,\s*cancelId:\s*1/);
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

  const idlePlugin = fixture({ taskSnapshots: [], confirm: false });
  await runApplicationQuit(idlePlugin.options);
  assert.equal(idlePlugin.events.includes('prompt'), false, 'idle plugin service processes are not unfinished tasks');
  assert(idlePlugin.events.includes('services-stopped') && idlePlugin.events.includes('all-processes-stopped'), 'quiet exit still closes and confirms every process');
  const automaticMaintenance = fixture({ taskSnapshots: [
    { id: 'cache', type: 'thumbnail-cache-recovery', state: 'running', title: '修复缩略图缓存索引' },
    { id: 'scan', type: 'version-stale-detection', state: 'running', title: '检查版本状态' },
    { id: 'done', type: 'component-runtime', state: 'completed', title: '已完成转码' },
    { id: 'failed', type: 'component-runtime', state: 'failed', title: '已失败任务' },
    { id: 'interrupted', type: 'component-runtime', state: 'interrupted', title: '上次中断的任务' },
  ] });
  await runApplicationQuit(automaticMaintenance.options);
  assert.equal(automaticMaintenance.events.includes('prompt'), false, 'automatic maintenance and history do not produce phantom task warnings');
  const fileCopy = fixture({ background: false, confirm: false, taskSnapshots: [{ id: 'copy', type: 'project-file-operation', state: 'queued', title: '复制文件' }] });
  await assert.rejects(runApplicationQuit(fileCopy.options), error => error.code === 'APP_QUIT_CANCELLED');
  assert.equal(fileCopy.confirmations[0][0].title, '复制文件', 'core tasks require confirmation even without plugin processes');
  const pausedTask = { id: 'paused', type: 'component-runtime', state: 'paused', title: '视频转码' };
  const queuedTask = { id: 'queued', type: 'component-operation', state: 'queued', title: '视频转文字' };
  assert.deepEqual(selectApplicationQuitTasks([pausedTask, queuedTask]), [pausedTask, queuedTask]);
  const detail = applicationQuitTaskDetail([pausedTask, queuedTask]);
  assert(detail.includes('视频转码（已暂停）') && detail.includes('视频转文字（等待中）'), 'confirmation must identify the actual unfinished tasks');
  assert.match(applicationQuitTaskDetail(Array.from({ length: 7 }, () => pausedTask)), /另有 2 个任务/);

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
  assert.equal(unconfirmed.events.includes('prompt'), false, 'unconfirmed process termination must block exit without claiming that an unfinished task exists');
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
