const activeProcess = status => !['idle', 'stopped', 'exited'].includes(status.state);

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
  confirmBackgroundProcesses,
  teardown = [],
  writeLog = () => undefined,
}) => {
  const initialStatuses = processSupervisor.list();
  const supervisedOwnerIds = initialStatuses.map(status => String(status.owner?.componentId || '').trim()).filter(Boolean);
  const guardedComponentIds = [...new Set([...componentIds, ...supervisedOwnerIds])];
  const background = initialStatuses.filter(status => status.owner?.componentId && (activeProcess(status) || status.terminationFailed === true));
  if (background.length && !await confirmBackgroundProcesses(background)) {
    componentLifecycleCoordinator.cancelApplicationQuit();
    throw Object.assign(new Error('用户取消退出'), { code: 'APP_QUIT_CANCELLED' });
  }
  componentLifecycleCoordinator.requestApplicationStop();

  const barriers = guardedComponentIds.map(componentId => componentCapabilityBroker.blockComponent(componentId));
  try {
    await processSupervisor.stopWhere(status => Boolean(status.owner?.componentId), 'application-quit');
    await componentServiceManager?.stopAll('application-quit');
    await componentViewManager?.closeAllAndWait();
    guardedComponentIds.forEach(componentId => abortComponentNetworkRequests?.(componentId));
    await Promise.all(barriers.map(barrier => barrier.drain({ timeoutMs: 7500 })));
    await componentLifecycleCoordinator.waitForAllWork({ timeoutMs: 7500 });
    await processSupervisor.stopAll('application-quit');
    const finalStatuses = processSupervisor.list();
    const remainingOwners = finalStatuses.filter(status => status.owner?.componentId && (activeProcess(status) || status.terminationFailed === true));
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

module.exports = { registerMainWindowQuitGuard, runApplicationQuit };
