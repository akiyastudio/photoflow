const createWorkspaceReconcileTask = ({ backgroundTasks, getWatchedWorkspacePath, getProjects, reconcileWorkspaceCatalog, writeLog }) => {
  let running = false;
  const run = async (root, restartTask = null) => {
    if (running || getWatchedWorkspacePath() !== root) {
      if (restartTask?.id) throw new Error('工作区当前未处于可对账状态');
      return undefined;
    }
    running = true;
    try {
      return await backgroundTasks.run({
        ...(restartTask?.id ? { id: restartTask.id } : {}),
        type: 'workspace-reconcile',
        title: '工作区文件与数据库对账',
        dedupeKey: `workspace-reconcile:${root}`,
        cancellable: false,
        resources: [{ path: `photoflow-workspace-database/${root}`, access: 'write' }],
        metadata: { root },
      }, async task => {
        task.report(5, '正在读取项目目录');
        const previousProjectsSnapshot = JSON.stringify(getProjects(root) || []);
        const catalog = await reconcileWorkspaceCatalog(root);
        const catalogChanged = previousProjectsSnapshot !== JSON.stringify(catalog.projects || []);
        task.report(95, '项目目录核对完成');
        writeLog('info', 'Periodic workspace reconciliation completed', { root, projects: catalog.projects.length, catalogChanged });
        return catalog;
      });
    } catch (error) {
      writeLog('warn', 'Periodic workspace reconciliation deferred', { root, error: error.message || String(error) });
      if (restartTask?.id) throw error;
      return undefined;
    } finally {
      running = false;
    }
  };
  backgroundTasks.registerTypeRestartFactory('workspace-reconcile', task => run(task.metadata?.root, task), {
    canRestart: task => Boolean(task.metadata?.root), autoRestart: true, autoRestartDelayMs: 5000,
  });
  return { run, reset: () => { running = false; } };
};

module.exports = { createWorkspaceReconcileTask };
