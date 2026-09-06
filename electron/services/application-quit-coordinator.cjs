const { isActiveManagedProcessStatus } = require('./process-supervisor.cjs');
const { resolveBackgroundTaskPolicy } = require('./background-task-policies.cjs');

const QUIT_TASK_STATES = new Set(['queued', 'running', 'pausing', 'paused', 'resuming']);
const selectApplicationQuitTasks = tasks => tasks.filter(task => {
  if (!QUIT_TASK_STATES.has(task.state)) return false;
  const policy = resolveBackgroundTaskPolicy(task);
  return policy.taskCenterPolicy === 'always' && !policy.foregroundNonBlocking && policy.notificationPolicy !== 'silent';
});

const applicationQuitTaskDetail = tasks => {
  const labels = { queued: '等待中', running: '进行中', pausing: '暂停中', paused: '已暂停', resuming: '恢复中' };
  const lines = tasks.slice(0, 5).map(task => {
    const title = String(task.title || '未命名任务').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160);
    return `• ${title}（${labels[task.state] || '未完成'}）`;
  });
  if (tasks.length > 5) lines.push(`另有 ${tasks.length - 5} 个任务`);
  return `退出后，以下任务将停止：\n${lines.join('\n')}`;
};

const registerMainWindowQuitGuard = ({ window, app, getQuitState, platform = process.platform }) => {
  if (platform === 'darwin') return () => undefined;
  const onClose = event => {
    const state = getQuitState();
    if (state === 'ready') return;
    event.preventDefault();
    if (state === 'idle') app.quit();
  };
  window.on('close', onClose);
  return () => window.removeListener?.('close', onClose);
};

const runApplicationQuit = async ({
  componentIds,
  processSupervisor,
  componentServiceManager,
  componentViewManager,
  componentLifecycleCoordinator,
  componentCapabilityBroker,
  abortComponentNetworkRequests,
  backgroundTasks,
  confirmPendingTasks,
  teardown = [],
  writeLog = () => undefined,
}) => {
  const initialStatuses = processSupervisor.list();
  const supervisedOwnerIds = initialStatuses.map(status => String(status.owner?.componentId || '').trim()).filter(Boolean);
  const guardedComponentIds = [...new Set([...componentIds, ...supervisedOwnerIds])];
  const pendingTasks = selectApplicationQuitTasks(backgroundTasks.list());
  if (pendingTasks.length && !await confirmPendingTasks(pendingTasks)) {
    componentLifecycleCoordinator.cancelApplicationQuit();
    throw Object.assign(new Error('用户取消退出'), { code: 'APP_QUIT_CANCELLED' });
  }
  componentLifecycleCoordinator.requestApplicationStop();

  const barriers = guardedComponentIds.map(componentId => componentCapabilityBroker.blockComponent(componentId));
  try {
    await componentServiceManager?.stopAll('application-quit');
    await processSupervisor.stopWhere(status => Boolean(status.owner?.componentId), 'application-quit');
    await componentViewManager?.closeAllAndWait();
    guardedComponentIds.forEach(componentId => abortComponentNetworkRequests?.(componentId));
    await Promise.all(barriers.map(barrier => barrier.drain({ timeoutMs: 7500 })));
    await componentLifecycleCoordinator.waitForAllWork({ timeoutMs: 7500 });
    await processSupervisor.stopAll('application-quit');
    const finalStatuses = processSupervisor.list();
    const remainingOwners = finalStatuses.filter(status => status.owner?.componentId && isActiveManagedProcessStatus(status));
    const stickyUnconfirmedIds = guardedComponentIds.filter(componentId => processSupervisor.hasUnconfirmedOwner?.(componentId) === true);
    const unconfirmedIds = [...new Set([...remainingOwners.map(status => String(status.owner.componentId)), ...stickyUnconfirmedIds])];
    if (unconfirmedIds.length) throw Object.assign(new Error('组件后台进程树终止状态仍未确认'), { code: 'PROCESS_TERMINATION_FAILED', componentIds: unconfirmedIds });
  } catch (error) {
    barriers.forEach(barrier => barrier.release());
    componentLifecycleCoordinator.cancelApplicationQuit();
    throw error;
  }

  componentLifecycleCoordinator.commitApplicationQuit();
  for (const operation of teardown) {
    try { await operation(); }
    catch (error) { writeLog('warn', 'Post-commit application teardown warning', { error: error.message || String(error) }); }
  }
  return { committed: true };
};

module.exports = { registerMainWindowQuitGuard, runApplicationQuit, selectApplicationQuitTasks, applicationQuitTaskDetail };
