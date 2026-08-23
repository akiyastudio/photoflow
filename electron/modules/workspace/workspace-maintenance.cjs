const WORKSPACE_MAINTENANCE_LOCK_RETRY_DELAYS_MS = [1000, 2500, 5000, 10000, 20000];
const workspaceDatabaseTaskResource = root => ({ path: `photoflow-workspace-database/${root}`, access: 'write' });
const isDatabaseLockedError = error => error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';

const runWorkspaceMaintenanceWithRetry = async ({
  root,
  repository,
  task,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  retryDelays = WORKSPACE_MAINTENANCE_LOCK_RETRY_DELAYS_MS,
}) => {
  let lastError;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await repository.runMaintenance(root);
    } catch (error) {
      lastError = error;
      if (!isDatabaseLockedError(error) || attempt >= retryDelays.length) throw error;
      const delay = retryDelays[attempt];
      task?.report?.(10, `项目数据库正忙，${Math.max(1, Math.ceil(delay / 1000))} 秒后自动重试`, { maintenanceAttempt: attempt + 2 });
      await wait(delay);
    }
  }
  throw lastError;
};

module.exports = { runWorkspaceMaintenanceWithRetry, workspaceDatabaseTaskResource };
