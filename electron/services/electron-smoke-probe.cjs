const runElectronSmokeProbe = async ({ app, mainWindow, rendererEntryFile, loadRenderer, recoveryResult, processSupervisor, componentServiceManager, componentHostRegistry, applicationQuitUi, backgroundTasks }) => {
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
  if (process.env.PHOTOFLOW_RENAME_BENCHMARK === '1') {
    await require('./rename-performance-probe.cjs').runRenamePerformanceProbe({ app, mainWindow });
    setImmediate(() => app.quit());
    return;
  }
  const setupProjects = process.env.PHOTOFLOW_SMOKE_SETUP_PROJECTS === '1';
  const smokeMediaPath = String(process.env.PHOTOFLOW_SMOKE_MEDIA_PATH || '');
  const idleComponentId = String(process.env.PHOTOFLOW_SMOKE_IDLE_COMPONENT_ID || '');
  let idleComponentReady = false;
  let rendererProbe;
  let quitUiVerified = false;
  try {
    if (idleComponentId) {
      const descriptor = componentHostRegistry.resolve(idleComponentId);
      if (!descriptor?.service) throw new Error('Idle component smoke service is unavailable');
      const session = await componentServiceManager.ensureSession(descriptor);
      await session.ready;
      idleComponentReady = true;
    }
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
    if (!workspace.success) throw new Error(workspace.error || 'unable to load workspace catalog');
    const firstGroup = (workspace.statuses || []).find(group => group.projects?.length);
    const firstProject = firstGroup?.projects[0];
    if (!firstProject) throw new Error('smoke project is missing from the workspace catalog');
    const [contents, files, progress] = await Promise.all([
      window.electronAPI.getProjectContents(config.workspacePath, firstGroup.status, firstProject.name),
      window.electronAPI.browseProjectFiles(config.workspacePath, firstGroup.status, firstProject.name, '', config.mediaCache),
      window.electronAPI.getProgressFoldersSnapshot(config.workspacePath, firstProject.name),
    ]);
    for (const [label, response] of [['project contents', contents], ['project files', files], ['version progress', progress]]) {
      if (!response?.success) throw new Error(label + ': ' + (response?.error || 'read failed'));
    }
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
      projectFilesReadable: contents.success && files.success,
      versionProgressReadable: progress.success,
      workspaceProjectCount: (workspace.statuses || []).reduce((count, group) => count + (group.projects || []).length, 0),
      automaticMediaTaskCount: automaticMediaTasks.filter(task => ['queued', 'running', 'pausing', 'paused', 'resuming', 'interrupted'].includes(task.state)).length,
      automaticMediaFailedCount: automaticMediaTasks.filter(task => task.state === 'failed').length,
      setupProjects,
      thumbnailReady: setupProjects || thumbnail?.state === 'READY',
      thumbnailError: thumbnail?.error || '',
    };
  })()`);
    if (process.env.PHOTOFLOW_SMOKE_QUIT_UI === '1') {
      await mainWindow.webContents.executeJavaScript("document.documentElement.classList.add('dark'); window.electronAPI.getApplicationQuitState()");
      const decision = applicationQuitUi.confirmAndPrepare([{ id: 'quit-ui-fixture', title: '视频转码', state: 'running', progress: 42 }]);
      void decision.catch(() => undefined);
      const rect = await mainWindow.webContents.executeJavaScript(`(async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const dialog = [...document.querySelectorAll('[role="dialog"]')].find(item => item.textContent.includes('还有任务未完成'));
          if (dialog && document.activeElement?.textContent === '暂不退出') {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const rect = dialog.getBoundingClientRect();
            if (!dialog.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))) throw new Error('Quit dialog is covered by another application layer');
            return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('Application styled quit dialog was not rendered with safe default focus');
      })()`);
      if (process.env.PHOTOFLOW_SMOKE_QUIT_SCREENSHOT) {
        const captured = await mainWindow.webContents.capturePage(rect);
        require('node:fs').writeFileSync(process.env.PHOTOFLOW_SMOKE_QUIT_SCREENSHOT, captured.toPNG());
      }
      await mainWindow.webContents.executeJavaScript("[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === '暂不退出').click()");
      if (await decision !== false) throw new Error('Quit dialog cancellation failed');
      quitUiVerified = true;
    }
    const queuedScans = Number(process.env.PHOTOFLOW_SMOKE_QUIT_QUEUED_SCANS || 0);
    for (let index = 0; index < Math.min(100, queuedScans); index += 1) {
      void backgroundTasks.run({ type: 'version-media-rescan', title: '退出验收扫描 ' + index, cancellable: true, concurrencyGroup: 'background-quit-smoke', concurrencyLimit: 1 }, task => new Promise((resolve, reject) => {
        task.signal.addEventListener('abort', () => reject(Object.assign(new Error('因退出停止'), { code: 'APP_SHUTTING_DOWN' })), { once: true });
      })).catch(() => undefined);
    }
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
    idleComponentReady,
    quitUiVerified,
    rendererLoaded: rendererProbe.readyState === 'complete',
    preloadApi: rendererProbe.preloadApi,
    backgroundTaskSnapshot: rendererProbe.backgroundTasks?.success === true && Array.isArray(rendererProbe.backgroundTasks?.tasks),
    projectFilesReadable: rendererProbe.projectFilesReadable,
    versionProgressReadable: rendererProbe.versionProgressReadable,
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
