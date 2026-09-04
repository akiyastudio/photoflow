const activeProcess = status => !['idle', 'stopped', 'exited'].includes(status.state);

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
  const background = processSupervisor.list().filter(status => status.owner?.componentId && (activeProcess(status) || status.terminationFailed === true));
  if (background.length && !await confirmBackgroundProcesses(background)) {
    componentLifecycleCoordinator.cancelApplicationQuit();
    throw Object.assign(new Error('用户取消退出'), { code: 'APP_QUIT_CANCELLED' });
  }

  const barriers = componentIds.map(componentId => componentCapabilityBroker.blockComponent(componentId));
  try {
    await processSupervisor.stopWhere(status => Boolean(status.owner?.componentId), 'application-quit');
    await componentServiceManager?.stopAll('application-quit');
    await componentViewManager?.closeAllAndWait();
    componentIds.forEach(componentId => abortComponentNetworkRequests?.(componentId));
    await Promise.all(barriers.map(barrier => barrier.drain({ timeoutMs: 7500 })));
    await componentLifecycleCoordinator.waitForAllWork({ timeoutMs: 7500 });
    await processSupervisor.stopAll('application-quit');
    const unconfirmed = componentIds.filter(componentId => processSupervisor.hasUnconfirmedOwner?.(componentId) === true);
    if (unconfirmed.length) throw Object.assign(new Error('组件后台进程树终止状态仍未确认'), { code: 'PROCESS_TERMINATION_FAILED', componentIds: unconfirmed });
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

module.exports = { runApplicationQuit };
