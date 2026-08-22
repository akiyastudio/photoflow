const FINGERPRINT_MAINTENANCE_IDLE_DELAY_MS = 15_000;

const registerVersionTrackingIpc = context => {
  const { backgroundTasks, crypto, ensureWorkspace, fs, getWorkspaceDataRoot = root => root, ipcMain, path, refreshWorkspaceCatalog, runPythonEventAction, trackingScanService, versionService, workspaceCatalogs, writeLog = () => undefined } = context;
  const trackingCommitJobs = new Map();
  const trackingCommitKey = (workspaceRoot, sessionId) => `${process.platform === 'win32' ? path.resolve(workspaceRoot).toLowerCase() : path.resolve(workspaceRoot)}\0${sessionId}`;
  const trackingPreviewItems = (prepared, preview = {}) => {
    const pendingSources = new Set((prepared.sourceNames || []).map(String));
    const items = [];
    const append = item => {
      const sourceName = item.sourceName ? String(item.sourceName) : undefined;
      if (sourceName && !pendingSources.has(sourceName)) return;
      if (sourceName) pendingSources.delete(sourceName);
      items.push(item);
    };
    for (const match of Array.isArray(preview.matches) ? preview.matches : []) append({
      kind: 'recognized', status: 'recognized', sourceName: match.source,
      referenceName: match.reference, targetName: match.target || match.source,
      distance: Number(match.distance) || 0, confidence: String(match.confidence || ''),
    });
    for (const suggestion of Array.isArray(preview.suggestions) ? preview.suggestions : []) append({
      kind: 'new', status: 'pending_confirmation', sourceName: suggestion.source,
      referenceName: suggestion.reference, targetName: suggestion.target || suggestion.source,
      distance: Number(suggestion.distance) || 0, confidence: String(suggestion.confidence || ''),
    });
    for (const sourceName of Array.isArray(preview.unmatched) ? preview.unmatched : []) append({
      kind: 'new', status: 'pending_confirmation', sourceName: String(sourceName), targetName: String(sourceName),
      confidence: '未匹配',
    });
    for (const sourceName of pendingSources) items.push({
      kind: 'new', status: 'pending_confirmation', sourceName, targetName: sourceName, confidence: '新增或变化',
    });
    for (const referenceName of prepared.copyCandidateNames || []) items.push({
      kind: 'copy_missing', status: 'pending_confirmation', referenceName: String(referenceName),
      targetName: String(referenceName), confidence: '父版本新增',
    });
    for (const sourceName of prepared.removedNames || []) items.push({
      kind: 'missing', status: 'missing_reference', sourceName: String(sourceName), confidence: '当前版本已缺失',
    });
    return items;
  };

  const executeTrackingCompare = async (workspaceRoot, prepared, task) => {
    task?.throwIfCancelled?.();
    const totalCount = (prepared.sourceNames?.length || 0) + (prepared.copyCandidateNames?.length || 0) + (prepared.removedNames?.length || 0);
    task?.report(0, '正在读取版本媒体', {
      sessionId: prepared.sessionId, progressId: prepared.progressId,
      processedCount: 0, totalCount,
    });
    writeLog('info', 'Version tracking compare started', {
      sessionId: prepared.sessionId, progressId: prepared.progressId, mode: prepared.mode,
      parentFolderPath: prepared.parentFolderPath, progressFolderPath: prepared.progressFolderPath,
      sourceCount: prepared.sourceNames?.length || 0, removedCount: prepared.removedNames?.length || 0,
      copyCandidateCount: prepared.copyCandidateNames?.length || 0,
    });
    let preview = { matches: [], suggestions: [], unmatched: [], unmatchedReference: [] };
    if (prepared.sourceNames?.length) {
      const trackingDataDirectory = path.join(getWorkspaceDataRoot(workspaceRoot), 'version-tracking');
      const sourceManifestPath = path.join(trackingDataDirectory, `${prepared.sessionId}-sources.json`);
      await fs.promises.mkdir(trackingDataDirectory, { recursive: true });
      await fs.promises.writeFile(sourceManifestPath, JSON.stringify(prepared.sourceNames), 'utf8');
      const onWorkerEvent = event => {
        if (event.type === 'progress' && Number.isFinite(event.progress)) {
          const workerProgress = Math.max(0, Math.min(100, Number(event.progress)));
          task?.report(workerProgress * 0.8, event.message || '正在比较版本媒体', {
            sessionId: prepared.sessionId, progressId: prepared.progressId,
            processedCount: totalCount > 0 ? Math.min(totalCount, Math.round(totalCount * workerProgress / 100)) : 0,
            totalCount,
          });
        } else if (event.type === 'log' || event.type === 'warning') {
          writeLog(event.type === 'warning' ? 'warn' : 'info', 'Version tracking worker event', {
            sessionId: prepared.sessionId, progressId: prepared.progressId, message: event.message || '',
          });
        }
      };
      let events;
      try {
        events = await runPythonEventAction('rename.py', [
          '--folder_a', prepared.parentFolderPath,
          '--folder_b', prepared.progressFolderPath,
          '--preview', '--source_files_file', sourceManifestPath,
        ], 60 * 60 * 1000, task?.signal, onWorkerEvent);
      } finally {
        await fs.promises.rm(sourceManifestPath, { force: true }).catch(() => undefined);
      }
      task?.throwIfCancelled();
      const previewEvent = events.find(event => event.type === 'preview');
      if (!previewEvent) throw new Error('版本对比没有返回匹配结果');
      preview = previewEvent.data || preview;
    }
    task?.throwIfCancelled?.();
    task?.report(80, '正在保存待确认结果');
    const stored = await versionService.storeTrackingPreview(workspaceRoot, {
      sessionId: prepared.sessionId,
      items: trackingPreviewItems(prepared, preview),
    });
    task?.report(95, '正在保存待确认结果', {
      sessionId: prepared.sessionId, progressId: prepared.progressId,
      processedCount: totalCount, totalCount,
    });
    task?.report(100, '等待确认跟踪图片');
    writeLog('info', 'Version tracking compare completed', {
      sessionId: prepared.sessionId, progressId: prepared.progressId, totalCount,
      itemCount: Array.isArray(stored?.items) ? stored.items.length : undefined,
    });
    return stored;
  };

  const runFingerprintMaintenance = (workspaceRoot, projectName, resourcePath, restartTask = null) => backgroundTasks.run({
      ...(restartTask?.id ? { id: restartTask.id } : {}),
      type: 'version-fingerprint-maintenance',
      title: '完善版本文件校验信息',
      dedupeKey: `version-fingerprint-maintenance:${workspaceRoot}:${projectName}`,
      concurrencyGroup: 'disk-io',
      concurrencyLimit: 3,
      concurrencyWriteLimit: 2,
      resourceAccess: 'read',
      cancellable: false,
      resources: [
        ...(resourcePath ? [{ path: resourcePath, access: 'read' }] : []),
        { path: `photoflow-workspace-database/${workspaceRoot}`, access: 'write' },
      ],
      metadata: { workspaceRoot, projectName, resourcePath },
    }, () => trackingScanService.syncProject(workspaceRoot, projectName));
  const queueFingerprintMaintenance = (workspaceRoot, projectName, resourcePath) => {
    if (!backgroundTasks?.run || !trackingScanService?.syncProject) return;
    // Full-file hashes are maintenance metadata, not part of the interactive
    // commit. Give the user a short window to continue editing the version tree
    // before this low-priority disk reader reserves the same project paths.
    const timer = setTimeout(() => void runFingerprintMaintenance(workspaceRoot, projectName, resourcePath).catch(() => undefined), FINGERPRINT_MAINTENANCE_IDLE_DELAY_MS);
    timer.unref?.();
  };
  backgroundTasks?.registerTypeRestartFactory?.('version-fingerprint-maintenance', task => runFingerprintMaintenance(task.metadata?.workspaceRoot, task.metadata?.projectName, task.metadata?.resourcePath, task), {
    canRestart: task => Boolean(task.metadata?.workspaceRoot && task.metadata?.projectName),
    autoRestart: true,
  });

  const restartTrackingTask = async interruptedTask => {
    const workspaceRoot = ensureWorkspace(interruptedTask.metadata?.workspaceRoot);
    const projectName = String(interruptedTask.metadata?.projectName || '');
    const progressId = String(interruptedTask.metadata?.progressId || '');
    const mode = interruptedTask.metadata?.mode === 'refresh' ? 'refresh' : 'compare';
    if (!projectName || !/^[0-9a-z-]{8,128}$/i.test(progressId)) throw new Error('版本跟踪重跑参数无效');
    if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
    const previousSessionId = String(interruptedTask.metadata?.sessionId || '');
    if (previousSessionId) await versionService.releaseTrackingSession(workspaceRoot, previousSessionId).catch(() => undefined);
    const created = await versionService.createTrackingSession(workspaceRoot, { projectName, progressId, mode });
    const handle = backgroundTasks.create({
      id: interruptedTask.id,
      type: 'version-tracking',
      title: mode === 'refresh' ? '刷新版本跟踪' : '比较版本跟踪',
      message: '正在重新开始版本比较',
      runningMessage: '正在准备版本比较',
      cancellable: true,
      resources: [
        { path: created.parentFolderPath, access: 'read' },
        { path: created.progressFolderPath, access: 'read' },
        { path: `photoflow-workspace-database/${workspaceRoot}`, access: 'write' },
      ],
      concurrencyGroup: 'disk-io',
      concurrencyLimit: 3,
      concurrencyWriteLimit: 2,
      resourceAccess: 'read',
      dedupeKey: `version-tracking:${workspaceRoot}:${progressId}`,
      metadata: { workspaceRoot, projectName, mode, sessionId: created.sessionId, progressId: created.progressId, processedCount: 0, totalCount: 0 },
    });
    if (!handle.deduplicated) setTimeout(() => void (async () => {
      try {
        await handle.waitForStart();
        const prepared = await trackingScanService.prepareTracking(workspaceRoot, { projectName, progressId, mode, sessionId: created.sessionId });
        await executeTrackingCompare(workspaceRoot, prepared, handle.context);
        handle.complete('等待确认跟踪图片');
      } catch (error) {
        if (handle.context.signal.aborted || error?.code === 'TASK_CANCELLED') {
          await versionService.releaseTrackingSession(workspaceRoot, created.sessionId).catch(() => undefined);
          handle.cancelled();
        } else {
          await versionService.failTrackingCommit(workspaceRoot, { sessionId: created.sessionId, error: error?.message || String(error) }).catch(() => undefined);
          handle.fail(error);
        }
      }
    })(), 0);
    return { task: handle.task, result: { sessionId: created.sessionId, progressId: created.progressId } };
  };
  backgroundTasks?.registerTypeRestartFactory?.('version-tracking', restartTrackingTask, {
    canRestart: task => Boolean(task.metadata?.workspaceRoot && task.metadata?.projectName && task.metadata?.progressId),
  });

  ipcMain.handle('workspace-progress-tracking-start', async (_event, workspacePath, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const progressId = String(request.progressId || '');
      const mode = request.mode === 'refresh' ? 'refresh' : 'compare';
      if (!/^[0-9a-z-]{8,128}$/i.test(progressId)) throw new Error('progressId 无效');
      let created = await versionService.createTrackingSession(workspaceRoot, { projectName, progressId, mode });
      if (created.reused) {
        const activeTask = backgroundTasks?.list?.().find(task => task.type === 'version-tracking'
          && task.metadata?.sessionId === created.sessionId
          && (task.state === 'queued' || task.state === 'running'));
        if (activeTask) {
          return { success: true, taskId: activeTask.id, sessionId: created.sessionId, sessionStatus: created.sessionStatus, resumed: true };
        }
        if (created.sessionStatus === 'pending_confirm' || created.sessionStatus === 'committing' || created.sessionStatus === 'failed') {
          return { success: true, sessionId: created.sessionId, sessionStatus: created.sessionStatus, resumed: true };
        }
        // A comparing row without a live in-memory task was left by an app
        // restart or interrupted worker. Release it and start a clean scan.
        await versionService.releaseTrackingSession(workspaceRoot, created.sessionId);
        created = await versionService.createTrackingSession(workspaceRoot, { projectName, progressId, mode });
      }
      const taskId = crypto.randomUUID();
      const handle = backgroundTasks?.create?.({
        id: taskId,
        type: 'version-tracking',
        title: mode === 'refresh' ? '刷新版本跟踪' : '比较版本跟踪',
        message: '等待其他文件操作完成，之后自动开始版本比较',
        runningMessage: '正在准备版本比较',
        cancellable: true,
        resources: [
          { path: created.parentFolderPath, access: 'read' },
          { path: created.progressFolderPath, access: 'read' },
          { path: `photoflow-workspace-database/${workspaceRoot}`, access: 'write' },
        ],
        concurrencyGroup: 'disk-io',
        concurrencyLimit: 3,
        concurrencyWriteLimit: 2,
        resourceAccess: 'read',
        dedupeKey: `version-tracking:${workspaceRoot}:${progressId}`,
        metadata: {
          workspaceRoot, projectName, mode, sessionId: created.sessionId, progressId: created.progressId,
          processedCount: 0, totalCount: 0,
        },
      }) || {
        context: undefined,
        waitForStart: async () => undefined,
        complete: () => undefined,
        fail: () => undefined,
        cancelled: () => undefined,
      };
      setTimeout(() => void (async () => {
        try {
          await handle?.waitForStart?.();
          const prepared = await trackingScanService.prepareTracking(workspaceRoot, {
            projectName, progressId, mode, sessionId: created.sessionId,
          });
          await executeTrackingCompare(workspaceRoot, prepared, handle.context);
          handle.complete('等待确认跟踪图片');
        } catch (error) {
          if (handle?.context?.signal?.aborted || error?.code === 'TASK_CANCELLED') {
            await versionService.releaseTrackingSession(workspaceRoot, created.sessionId).catch(() => undefined);
            handle?.cancelled?.();
          } else {
            writeLog('error', 'Version tracking compare failed', {
              projectName, progressId, sessionId: created.sessionId,
              error: error?.message || String(error), stack: error?.stack,
            });
            await versionService.failTrackingCommit(workspaceRoot, { sessionId: created.sessionId, error: error?.message || String(error) }).catch(() => undefined);
            handle?.fail?.(error);
          }
        }
      })(), 0);
      return { success: true, taskId, sessionId: created.sessionId, sessionStatus: 'comparing', resumed: false };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-session', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sessionId = String(request.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('sessionId 无效');
      return await versionService.getTrackingSession(workspaceRoot, {
        sessionId, cursor: Number(request.cursor) || 0, limit: Number(request.limit) || 100,
      });
    } catch (error) {
      return { success: false, items: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-session-release', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sessionId = String(request.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('sessionId 无效');
      if (trackingCommitJobs.has(trackingCommitKey(workspaceRoot, sessionId))) {
        return { success: false, released: false, sessionId, error: '跟踪结果正在提交，暂时不能放弃会话' };
      }
      return await versionService.releaseTrackingSession(workspaceRoot, sessionId);
    } catch (error) {
      return { success: false, released: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-decide', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      return await versionService.decideTrackingItem(workspaceRoot, {
        sessionId: String(request.sessionId || ''), itemId: String(request.itemId || ''),
        status: request.status === 'accepted' ? 'accepted' : request.status === 'rejected' ? 'rejected' : '',
        ...(request.referenceName ? { referenceName: String(request.referenceName) } : {}),
      });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  const runTrackingCommit = async (workspaceRoot, sessionId) => {
    let committedBatchId;
    try {
      const plan = await versionService.getTrackingCommitPlan(workspaceRoot, sessionId);
      if (!plan.success && plan.staleSnapshot) return plan;
      if (plan.alreadyCommitted) return await versionService.getTrackingSession(workspaceRoot, { sessionId, cursor: 0, limit: 200 });
      if (plan.repairBatchId) {
        const repaired = await versionService.retryBatchOperations(workspaceRoot, plan.repairBatchId);
        if (repaired.repairRequired) throw Object.assign(new Error('文件操作仍需修复后重试'), { batchId: plan.repairBatchId });
        return await trackingScanService.completeTrackingCommit(workspaceRoot, { sessionId, batchId: plan.repairBatchId });
      }
      let copiedNames = [];
      if (plan.copyMissingFromParent && (plan.copyReferences || []).length) {
        const copyResult = await versionService.applyTrackingCopies(workspaceRoot, sessionId);
        copiedNames = copyResult.copiedNames || [];
        if (!copyResult.success || copyResult.repairRequired) {
          throw Object.assign(new Error(copyResult.copyErrors?.[0]?.error || '补齐文件需要修复后重试'), {
            copyRepairRequired: true,
          });
        }
      }
      if (!(plan.matches || []).length && !(plan.incrementalSources || []).length && !copiedNames.length) {
        return await trackingScanService.completeTrackingCommit(workspaceRoot, { sessionId });
      }
      const result = await versionService.commitBatchCompare(workspaceRoot, {
        projectName: plan.projectName,
        folderA: plan.parentFolderPath,
        folderB: plan.progressFolderPath,
        importKey: `tracking:${sessionId}`,
        displayName: plan.displayName,
        renameSources: plan.renameFromParent,
        reconcileExisting: plan.mode === 'refresh',
        incrementalSources: [...new Set([...(plan.incrementalSources || []), ...copiedNames])],
        matches: [...(plan.matches || []), ...copiedNames.map(name => ({ reference: name, source: name, target: name, distance: 0, confidence: '复制补齐' }))],
      });
      committedBatchId = result.batch?.id;
      if (result.repairRequired) {
        await versionService.failTrackingCommit(workspaceRoot, {
          sessionId, batchId: result.batch?.id, error: '文件操作需要修复后重试',
        });
        return { ...result, success: false, sessionId, retryable: true, items: [] };
      }
      const completed = await trackingScanService.completeTrackingCommit(workspaceRoot, { sessionId, batchId: result.batch?.id });
      queueFingerprintMaintenance(workspaceRoot, plan.projectName, plan.progressFolderPath);
      return { ...completed, batch: result.batch, renamedCount: result.renamedCount || 0 };
    } catch (error) {
      if (workspaceRoot && sessionId) await versionService.failTrackingCommit(workspaceRoot, {
        sessionId, batchId: error.batchId || committedBatchId, error: error.message || String(error),
      }).catch(() => undefined);
      return { success: false, sessionId, retryable: true, items: [], error: error.message || String(error) };
    }
  };

  ipcMain.handle('workspace-progress-tracking-commit', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sessionId = String(request.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('sessionId 无效');
      const key = trackingCommitKey(workspaceRoot, sessionId);
      const running = trackingCommitJobs.get(key);
      if (running) return await running;
      const resources = versionService.getTrackingCommitResources
        ? await versionService.getTrackingCommitResources(workspaceRoot, sessionId)
        : { parentFolderPath: '', progressFolderPath: '' };
      const execute = async () => {
        const result = await runTrackingCommit(workspaceRoot, sessionId);
        if (!result?.success) {
          const error = new Error(result?.error || '版本跟踪提交失败');
          error.trackingResult = result;
          throw error;
        }
        return result;
      };
      const job = backgroundTasks?.run
        ? backgroundTasks.run({
          type: 'version-tracking-commit',
          title: '提交版本跟踪',
          message: '等待其他文件操作完成',
          runningMessage: '正在提交版本跟踪',
          notificationPolicy: 'progress-toast',
          cancellable: false,
          resources: [
            ...[resources.parentFolderPath, resources.progressFolderPath].filter(Boolean).map(resourcePath => ({ path: resourcePath, access: 'write' })),
            { path: `photoflow-workspace-database/${workspaceRoot}`, access: 'write' },
          ],
          concurrencyGroup: 'disk-io',
          concurrencyLimit: 3,
          concurrencyWriteLimit: 2,
          resourceAccess: 'write',
          dedupeKey: `version-tracking-commit:${workspaceRoot}:${sessionId}`,
          metadata: { sessionId },
        }, execute).then(execution => execution.result || { success: false, sessionId, error: '版本跟踪提交没有返回结果' })
        : execute();
      trackingCommitJobs.set(key, job);
      try {
        return await job;
      } finally {
        if (trackingCommitJobs.get(key) === job) trackingCommitJobs.delete(key);
      }
    } catch (error) {
      return error.trackingResult || { success: false, sessionId: String(request.sessionId || ''), retryable: true, items: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-main-branch-media', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      return await versionService.getMainBranchMedia(workspaceRoot, {
        progressId: String(request.progressId || ''),
        ...(request.photoId ? { photoId: String(request.photoId) } : {}),
      });
    } catch (error) {
      return { success: false, entries: [], branchProgressIds: [], error: error.message || String(error) };
    }
  });
  
};

module.exports = { registerVersionTrackingIpc };
