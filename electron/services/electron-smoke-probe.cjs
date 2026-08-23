const runElectronSmokeProbe = async ({ app, mainWindow, rendererEntryFile, loadRenderer, recoveryResult, processSupervisor }) => {
  const rendererLoaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Electron smoke renderer load timed out')), 30_000);
    mainWindow.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timeout);
      reject(new Error(`Electron smoke renderer failed to load: ${code} ${description}`));
    });
  });
  loadRenderer();
  await rendererLoaded;
  const setupProjects = process.env.PHOTOFLOW_SMOKE_SETUP_PROJECTS === '1';
  const smokeMediaPath = String(process.env.PHOTOFLOW_SMOKE_MEDIA_PATH || '');
  let rendererProbe;
  try {
    rendererProbe = await mainWindow.webContents.executeJavaScript(`(async () => {
    const config = await window.electronAPI.loadConfig();
    const setupProjects = ${JSON.stringify(setupProjects)};
    const smokeMediaPath = ${JSON.stringify(smokeMediaPath)};
    if (setupProjects) {
      await window.electronAPI.getWorkspaceProjects(config.workspacePath);
      await new Promise(resolve => setTimeout(resolve, 1000));
      for (let index = 0; index < 40; index += 1) {
        const created = await window.electronAPI.createWorkspaceProject(
          config.workspacePath, null, \`启动验收 \${String(index + 1).padStart(2, '0')}\`, { createPlanningFolder: false },
        );
        if (!created.success) throw new Error(created.error || 'unable to create smoke project');
      }
    }
    const workspace = await window.electronAPI.getWorkspaceProjects(config.workspacePath);
    if (!setupProjects) await new Promise(resolve => setTimeout(resolve, 2500));
    let thumbnail = null;
    if (!setupProjects && smokeMediaPath) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        thumbnail = await window.electronAPI.getMediaThumbnail(smokeMediaPath, 'image', config.mediaCache, 320, 0, 0);
        if (thumbnail?.state === 'READY') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const backgroundTasks = await window.electronAPI.getBackgroundTasks();
    const automaticMediaTasks = (backgroundTasks.tasks || []).filter(task => task.type === 'version-stale-detection' || task.type === 'version-media-rescan');
    return {
      readyState: document.readyState,
      preloadApi: typeof window.electronAPI === 'object',
      backgroundTasks,
      workspaceProjectCount: (workspace.statuses || []).reduce((count, group) => count + (group.projects || []).length, 0),
      automaticMediaTaskCount: automaticMediaTasks.filter(task => ['queued', 'running', 'pausing', 'paused', 'resuming', 'interrupted'].includes(task.state)).length,
      automaticMediaFailedCount: automaticMediaTasks.filter(task => task.state === 'failed').length,
      setupProjects,
      thumbnailReady: setupProjects || thumbnail?.state === 'READY',
      thumbnailError: thumbnail?.error || '',
    };
  })()`);
  } catch (error) {
    process.stdout.write(`PHOTOFLOW_SMOKE_RESULT=${JSON.stringify({
      type: 'photoflow-electron-smoke', rendererLoaded: false, preloadApi: false,
      backgroundTaskSnapshot: false, probeError: error.message || String(error),
      managedProcesses: processSupervisor.list(), userDataPath: app.getPath('userData'), sessionDataPath: app.getPath('sessionData'), rendererFile: rendererEntryFile,
    })}\n`);
    setImmediate(() => app.quit());
    return;
  }
  const result = {
    type: 'photoflow-electron-smoke',
    rendererLoaded: rendererProbe.readyState === 'complete',
    preloadApi: rendererProbe.preloadApi,
    backgroundTaskSnapshot: rendererProbe.backgroundTasks?.success === true && Array.isArray(rendererProbe.backgroundTasks?.tasks),
    workspaceProjectCount: rendererProbe.workspaceProjectCount,
    automaticMediaTaskCount: rendererProbe.automaticMediaTaskCount,
    automaticMediaFailedCount: rendererProbe.automaticMediaFailedCount,
    thumbnailReady: rendererProbe.thumbnailReady,
    thumbnailError: rendererProbe.thumbnailError,
    startupRecovery: recoveryResult?.task?.state || 'skipped',
    startupRecoveryResult: recoveryResult?.result || null,
    managedProcesses: processSupervisor.list(),
    userDataPath: app.getPath('userData'),
    sessionDataPath: app.getPath('sessionData'),
    rendererFile: rendererEntryFile,
  };
  process.stdout.write(`PHOTOFLOW_SMOKE_RESULT=${JSON.stringify(result)}\n`);
  setImmediate(() => app.quit());
};

module.exports = { runElectronSmokeProbe };
