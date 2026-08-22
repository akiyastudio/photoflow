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
  const rendererProbe = await mainWindow.webContents.executeJavaScript(`(async () => ({
    readyState: document.readyState,
    preloadApi: typeof window.electronAPI === 'object',
    backgroundTasks: await window.electronAPI.getBackgroundTasks()
  }))()`);
  const result = {
    type: 'photoflow-electron-smoke',
    rendererLoaded: rendererProbe.readyState === 'complete',
    preloadApi: rendererProbe.preloadApi,
    backgroundTaskSnapshot: rendererProbe.backgroundTasks?.success === true && Array.isArray(rendererProbe.backgroundTasks?.tasks),
    startupRecovery: recoveryResult?.task?.state || 'skipped',
    startupRecoveryResult: recoveryResult?.result || null,
    managedProcesses: processSupervisor.list(),
    userDataPath: app.getPath('userData'),
    rendererFile: rendererEntryFile,
  };
  process.stdout.write(`PHOTOFLOW_SMOKE_RESULT=${JSON.stringify(result)}\n`);
  setImmediate(() => app.quit());
};

module.exports = { runElectronSmokeProbe };
