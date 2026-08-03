const { isProtectedProjectFolderName, isProtectedProjectFolderPath } = require('../services/protected-project-folder.cjs');
const { createProjectFileTask } = require('../services/project-file-task-service.cjs');

const registerWorkspaceIpc = context => {
  const { Array, Boolean, CANCELLED_CODE, Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES, IMAGE_EXTENSIONS, Math, Object, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, WORKSPACE_STATUSES, activeProjectFileOperations, acquireFileRootWatcher, app, assertExistingInside, assertInside, assertRegularFile, assertUndoIdentity, backgroundTasks, cancelMediaTrackingScan, capturePathIdentity, cleanProjectName, clipboard, copyFileAtomic, crypto, dialog, ensureWorkspace, findLatestPhotoshop, fs, getProjectPath, getWorkspaceDataRoot, ipcMain, mainWindow, mediaRuntimeState, mediaService, moveFileAtomic, movePathAtomic, mutateWorkspaceCatalog, normalizeMediaCacheSizeGB, path, pathExists, pluginService, pushUndoOperation, reconcileWorkspaceCatalog, recycleBinService, refreshWorkspaceCatalog, releaseFileRootWatcher, releaseWorkspaceWatchPath, renameHistory, resolveProjectEntry, resolveWorkspaceRoot, runPythonJsonAction, samePathIdentity, scheduleMediaTrackingScan, shell, shellNewService, spawn, suppressWorkspaceWatchPath, telemetryService, thumbnailService, undefined, uniqueDestination, versionService, watchWorkspace, workspaceCatalogs, workspaceMaintenanceRepository, workspaceRepository, writeLog } = context;
  const isValidProjectStatus = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 24 && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const availableProjectStatuses = catalog => {
    const values = [...WORKSPACE_STATUSES, ...((catalog?.projects || []).map(project => project.status))];
    const seen = new Set();
    return values.filter(status => {
      if (!isValidProjectStatus(status)) return false;
      const key = status.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const isInternalFileOperationEntry = name => name.toLowerCase().endsWith('.photoflow-part') || name.toLowerCase() === '_photoflow_safety_temp' || /^\.photoflow-(?:import-|paste|replace|undo|team-workflow-)/i.test(name);
  const officeOpenXmlExtensions = new Set([
    '.docx', '.docm', '.dotx', '.dotm',
    '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppam',
    '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlam', '.xlsb',
  ]);
  const screenshotMainImageExtensions = new Set(['.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
  const missingProjectRetentionMs = 30 * 24 * 60 * 60 * 1000;
  const recentFileSessions = new Map();
  const progressImportConflictCache = new Map();
  const pruneRecentFileSessions = () => {
    const expiry = Date.now() - 10 * 60 * 1000;
    for (const [cursor, session] of recentFileSessions) {
      if (session.touchedAt < expiry) recentFileSessions.delete(cursor);
    }
  };
  const pruneProgressImportConflictCache = () => {
    const now = Date.now();
    for (const [key, entry] of progressImportConflictCache) {
      if (entry.expiresAt <= now) progressImportConflictCache.delete(key);
    }
    while (progressImportConflictCache.size > 32) progressImportConflictCache.delete(progressImportConflictCache.keys().next().value);
  };

  const readProjectDate = project => {
    try {
      const extra = JSON.parse(project?.extra_json || '{}');
      const value = extra?.projectDate;
      if (!value || !Number.isInteger(value.year) || !Number.isInteger(value.month)) return undefined;
      return {
        year: value.year,
        month: value.month,
        ...(Number.isInteger(value.day) ? { day: value.day } : {}),
        precision: Number.isInteger(value.day) ? 'day' : 'month',
      };
    } catch {
      return undefined;
    }
  };

  const normalizeProjectDate = value => {
    if (!value) return null;
    let year = Number(value.year);
    const month = Number(value.month);
    const hasDay = value.day !== undefined && value.day !== null && String(value.day).trim() !== '';
    const day = hasDay ? Number(value.day) : undefined;
    if (year >= 0 && year < 100) year += 2000;
    if (!Number.isInteger(year) || year < 2000 || year > 2099) throw new Error('年份请输入 00–99 或 2000–2099');
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('月份请输入 1–12');
    if (hasDay) {
      const checked = new Date(year, month - 1, day);
      if (!Number.isInteger(day) || day < 1 || checked.getFullYear() !== year || checked.getMonth() !== month - 1 || checked.getDate() !== day) throw new Error('日期无效，请检查年月日');
    }
    return { year, month, ...(hasDay ? { day } : {}), precision: hasDay ? 'day' : 'month' };
  };

  const formatProjectDate = value => value
    ? `${String(value.year).slice(-2)}-${value.month}${value.precision === 'day' ? `-${value.day}` : ''}`
    : '';

  const inspectDeletedProject = async (root, project) => {
    const originalPath = path.resolve(root, project.relativePath);
    const relative = path.relative(root, originalPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ...project, originalPath, recycleStatus: 'unknown', statusDetail: '项目原路径无效，已保留数据' };
    }
    if (await pathExists(originalPath)) {
      return { ...project, originalPath, recycleStatus: 'restored', statusDetail: '原项目路径已重新出现' };
    }
    if (project.permanent) {
      return { ...project, originalPath, recycleStatus: 'missing', statusDetail: '项目已由 Windows 永久删除' };
    }
    if (!project.recyclePidl || !recycleBinService.nativeAvailable()) {
      return { ...project, originalPath, recycleStatus: 'unknown', statusDetail: '当前无法可靠检查系统回收站，已保留数据' };
    }
    try {
      const probe = await recycleBinService.probe(project.recyclePidl);
      return probe.exists
        ? { ...project, originalPath, recycleStatus: 'in_recycle_bin', statusDetail: '项目仍在系统回收站中' }
        : { ...project, originalPath, recycleStatus: 'missing', statusDetail: '回收站条目和原项目路径均不存在' };
    } catch (error) {
      return { ...project, originalPath, recycleStatus: 'unknown', statusDetail: error.message || String(error) };
    }
  };

  const removeInternalProjectArtifacts = async (root, purgeResult) => {
    const dataRoot = path.resolve(getWorkspaceDataRoot(root));
    const candidates = [
      ...(purgeResult.artifactPaths || []),
      ...(purgeResult.photoIds || []).flatMap(photoId => [
        path.join(dataRoot, 'thumbnails', photoId),
        path.join(dataRoot, 'team-retouch', photoId),
      ]),
    ];
    const safeCandidates = [...new Set(candidates)].flatMap(candidate => {
      if (!candidate) return [];
      const resolved = path.resolve(candidate);
      const relative = path.relative(dataRoot, resolved);
      return !relative || relative.startsWith('..') || path.isAbsolute(relative) ? [] : [resolved];
    });
    let removedCount = 0;
    for (let offset = 0; offset < safeCandidates.length; offset += 8) {
      const results = await Promise.all(safeCandidates.slice(offset, offset + 8).map(async resolved => {
        try {
          await fs.promises.rm(resolved, { recursive: true, force: true });
          return true;
        } catch (error) {
          writeLog('warn', 'Unable to remove deleted project artifact', { path: resolved, error: error.message || String(error) });
          return false;
        }
      }));
      removedCount += results.filter(Boolean).length;
    }
    return removedCount;
  };

  const purgeDeletedProjectData = async (root, project, task) => {
    task?.report(15, `正在准备清理“${project.name}”的数据`);
    const cleanupPlan = await workspaceRepository.getDeletedProjectCleanupPlan(root, project.id);
    task?.report(35, `正在清理“${project.name}”的缩略图和内部文件`);
    const removedArtifactCount = await removeInternalProjectArtifacts(root, cleanupPlan);
    await thumbnailService.invalidateSources(cleanupPlan.sourcePaths || []).catch(error => {
      writeLog('warn', 'Unable to clear deleted project thumbnail cache', { project: project.name, error: error.message || String(error) });
    });
    task?.report(80, `正在完成“${project.name}”的数据清理`);
    const purgeResult = await workspaceRepository.purgeDeletedProject(root, project.id);
    for (let index = renameHistory.length - 1; index >= 0; index -= 1) {
      const operation = renameHistory[index];
      if (operation.projectCatalog?.name?.toLocaleLowerCase() === project.name.toLocaleLowerCase()
        || (purgeResult.removedUndoIds || []).includes(operation.persistentId)) renameHistory.splice(index, 1);
    }
    writeLog('info', 'Purged unavailable deleted project data', {
      root,
      project: project.name,
      photoCount: purgeResult.photoIds?.length || 0,
      removedArtifactCount,
    });
    return { removedArtifactCount, purgeResult };
  };

  const purgeConfirmedDeletedProject = async (root, project) => {
    const inspected = await inspectDeletedProject(root, project);
    if (inspected.recycleStatus !== 'missing') return { cleaned: false, status: inspected.recycleStatus };
    const { removedArtifactCount } = await purgeDeletedProjectData(root, project);
    return { cleaned: true, status: 'missing', removedArtifactCount };
  };

  const purgeStaleMissingProject = async (root, project) => {
    const purgeResult = await workspaceRepository.purgeMissingProject(root, project.name);
    const removedArtifactCount = await removeInternalProjectArtifacts(root, purgeResult);
    await thumbnailService.invalidateSources(purgeResult.sourcePaths || []).catch(error => {
      writeLog('warn', 'Unable to clear stale offline project thumbnails', { projectName: project.name, error: error.message || String(error) });
    });
    writeLog('info', 'Purged stale offline project data', { root, projectName: project.name, removedArtifactCount });
    return { cleaned: true, status: 'missing', removedArtifactCount };
  };

  const queuePermanentProjectCleanup = (root, projectName) => {
    const run = () => backgroundTasks.run({
      type: 'deleted-project-cleanup',
      title: `清理已永久删除项目：${projectName}`,
      dedupeKey: `deleted-project-cleanup:${root}:${projectName.toLocaleLowerCase()}`,
      cancellable: false,
      metadata: { root, projectName },
    }, async task => {
      const deleted = await workspaceRepository.listDeletedProjects(root);
      const project = (deleted.projects || []).find(item => item.name.toLocaleLowerCase() === projectName.toLocaleLowerCase());
      if (!project) return { skipped: true };
      return purgeDeletedProjectData(root, project, task);
    }, run);
    setTimeout(() => {
      void run().catch(error => {
        writeLog('warn', 'Permanent project cleanup deferred until a later startup', {
          root,
          project: projectName,
          error: error.message || String(error),
        });
      });
    }, 1000);
  };

  const queueWorkspaceMaintenance = root => {
    if (!workspaceMaintenanceRepository?.runMaintenance) return;
    const run = () => backgroundTasks.run({
      type: 'workspace-database-maintenance',
      title: '维护项目数据库',
      dedupeKey: `workspace-database-maintenance:${root}`,
      cancellable: false,
      metadata: { root },
    }, async task => {
      task.report(10, '正在检查项目数据库');
      const result = await workspaceMaintenanceRepository.runMaintenance(root);
      task.report(100, '项目数据库维护完成');
      return result;
    }, run);
    setTimeout(() => {
      void run().catch(error => writeLog('warn', 'Workspace database maintenance deferred', {
        root,
        error: error.message || String(error),
      }));
    }, 1000);
  };

  ipcMain.handle('workspace-cleanup-deleted-projects', async (_event, workspacePath) => {
    try {
      const root = ensureWorkspace(workspacePath);
      await reconcileWorkspaceCatalog(root);
      const result = await workspaceRepository.listDeletedProjects(root);
      const outcomes = [];
      for (const project of result.projects || []) outcomes.push({ projectId: project.id, name: project.name, ...await purgeConfirmedDeletedProject(root, project) });
      const staleMissing = await workspaceRepository.listMissingProjects(root, Date.now() - missingProjectRetentionMs);
      for (const project of staleMissing.projects || []) outcomes.push({ projectId: project.id, name: project.name, ...await purgeStaleMissingProject(root, project) });
      const cleanedCount = outcomes.filter(outcome => outcome.cleaned).length;
      if (cleanedCount) await refreshWorkspaceCatalog(root);
      return { success: true, checkedCount: outcomes.length, cleanedCount, outcomes };
    } catch (error) {
      writeLog('error', 'Unable to clean deleted project data', error);
      return { success: false, checkedCount: 0, cleanedCount: 0, outcomes: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-projects', async (_event, workspacePath) => {
    try {
      const root = ensureWorkspace(workspacePath);
      watchWorkspace(root);
      const catalog = await refreshWorkspaceCatalog(root);
      void reconcileWorkspaceCatalog(root).catch(error => {
        writeLog('warn', 'Unable to reconcile workspace catalog after project-list read', { root, error: error.message || String(error) });
      });
      queueWorkspaceMaintenance(root);
      const statuses = availableProjectStatuses(catalog).map(status => {
        const onlineProjects = catalog.projects.filter(project => project.status === status && project.availability !== 'missing');
        const offlineArchivedProjects = catalog.projects.filter(project => {
          if (project.status !== status || project.availability !== 'missing') return false;
          try { return Boolean(JSON.parse(project.extra_json || '{}')?.archive?.path); }
          catch { return false; }
        });
        const projects = [...onlineProjects, ...offlineArchivedProjects]
          .map(project => {
            const projectPath = path.resolve(root, project.relative_path);
            let archive = null;
            try { archive = JSON.parse(project.extra_json || '{}')?.archive || null; } catch { /* malformed optional metadata is ignored */ }
            return {
              name: project.name,
              path: projectPath,
              status,
              updatedAt: fs.existsSync(projectPath) ? fs.statSync(projectPath).mtimeMs : project.updated_at,
              projectDate: readProjectDate(project),
              availability: project.availability || 'available',
              missingSince: project.missing_since || undefined,
              missingChecks: project.missing_checks || 0,
              archived: Boolean(archive?.path),
              archivePath: archive?.path || undefined,
              archiveVerifiedAt: archive?.verifiedAt || undefined,
              archiveBytes: archive?.bytes || undefined,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        return { status, projects };
      });
      return { success: true, root, statuses };
    } catch (error) {
      writeLog('error', 'Unable to load workspace projects', error);
      return { success: false, error: String(error), statuses: [] };
    }
  });
  
  ipcMain.handle('workspace-create-project', async (_event, workspacePath, date, name, options) => {
    try {
      const projectDate = normalizeProjectDate(date);
      const datePart = formatProjectDate(projectDate);
      const namePart = cleanProjectName(name || '');
      const projectName = [datePart, namePart].filter(Boolean).join(' ');
      if (!projectName) throw new Error('请至少填写日期或名称');
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      if (catalog.byName.has(projectName.toLocaleLowerCase())) throw new Error('同名项目已存在');
      const projectPath = getProjectPath(workspacePath, '策划中', projectName);
      if (fs.existsSync(projectPath)) throw new Error('同名项目已存在');
      fs.mkdirSync(projectPath, { recursive: false });
      if (options?.createPlanningFolder !== false) fs.mkdirSync(path.join(projectPath, '策划'), { recursive: true });
      await mutateWorkspaceCatalog(root, 'addProject', { name: projectName, status: '策划中', relativePath: path.relative(root, projectPath), extra: projectDate ? { projectDate } : {} });
      writeLog('info', 'Project created', { projectName, projectPath });
      telemetryService?.track('project_created', { planning_folder: options?.createPlanningFolder !== false });
      return { success: true, project: { name: projectName, path: projectPath, status: '策划中', updatedAt: Date.now(), projectDate: projectDate || undefined } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-rename-project', async (_event, workspacePath, status, projectName, dateOrNextName, nextName) => {
    try {
      const legacyCall = typeof dateOrNextName === 'string' && nextName === undefined;
      const projectDate = legacyCall ? undefined : normalizeProjectDate(dateOrNextName);
      const cleanedName = legacyCall
        ? cleanProjectName(dateOrNextName)
        : [formatProjectDate(projectDate), cleanProjectName(nextName || '')].filter(Boolean).join(' ');
      if (!cleanedName) throw new Error('项目名称不能为空');
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      const existingProject = catalog.byName.get(cleanedName.toLocaleLowerCase());
      if (existingProject && existingProject.name.toLocaleLowerCase() !== projectName.toLocaleLowerCase()) throw new Error('同名项目已存在');
      const source = getProjectPath(workspacePath, status, projectName);
      const destination = path.join(path.dirname(source), cleanedName);
      if (!fs.existsSync(source)) throw new Error('项目不存在');
      if (cleanedName !== projectName) {
        if (fs.existsSync(destination)) throw new Error('同名项目已存在');
        await fs.promises.rename(source, destination);
      }
      const previousProjectDate = readProjectDate(catalog.byName.get(projectName.toLocaleLowerCase()));
      await mutateWorkspaceCatalog(root, 'renameProject', { name: projectName, nextName: cleanedName, relativePath: path.relative(root, destination), ...(legacyCall ? {} : { projectDate }) });
      if (cleanedName !== projectName) await pushUndoOperation({ kind: 'project', source, destination, status, workspaceRoot: root, beforeName: projectName, afterName: cleanedName, beforeProjectDate: previousProjectDate, afterProjectDate: projectDate });
      return { success: true, project: { name: cleanedName, path: destination, status, updatedAt: Date.now(), projectDate: projectDate === undefined ? previousProjectDate : projectDate || undefined } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-create-project-folder', async (_event, workspacePath, status, projectName, folderName, relativePath = '', makeUnique = false) => {
    try {
      const cleanedName = cleanProjectName(folderName || '');
      if (!cleanedName) throw new Error('文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const parentPath = path.resolve(projectPath, relativePath || '.');
      if (parentPath !== projectPath && !parentPath.startsWith(projectPath + path.sep)) throw new Error('无效的文件夹位置');
      let actualName = cleanedName;
      let folderPath = path.resolve(parentPath, actualName);
      if (!folderPath.startsWith(parentPath + path.sep)) throw new Error('无效的文件夹名称');
      if (makeUnique) {
        let index = 2;
        while (fs.existsSync(folderPath)) {
          actualName = `${cleanedName} (${index++})`;
          folderPath = path.resolve(parentPath, actualName);
        }
      } else if (fs.existsSync(folderPath)) throw new Error('同名文件夹已存在');
      fs.mkdirSync(folderPath);
      await pushUndoOperation({ kind: 'remove-created', paths: [folderPath], label: '新建文件夹' });
      return { success: true, folder: { name: actualName, path: folderPath, relativePath: path.relative(projectPath, folderPath), updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-shell-new-types', async (_event, refresh = false) => {
    try {
      return { success: true, types: await shellNewService.list({ refresh }) };
    } catch (error) {
      return { success: false, types: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-create-shell-new-file', async (_event, workspacePath, status, projectName, relativePath, typeId) => {
    try {
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requestedParent = path.resolve(projectPath, relativePath || '.');
      const parentPath = assertExistingInside(projectPath, requestedParent, '新建文件位置', true);
      if (!(await fs.promises.stat(parentPath)).isDirectory()) throw new Error('新建文件位置不是文件夹');
      const created = await shellNewService.create(typeId, parentPath, uniqueDestination);
      await pushUndoOperation({ kind: 'remove-created', paths: [created.path], label: '新建文件' });
      return { success: true, file: { ...created, relativePath: path.relative(projectPath, created.path), updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-rename-project-folder', async (_event, workspacePath, status, projectName, folderName, nextName) => {
    try {
      const cleanedName = cleanProjectName(nextName || '');
      if (!cleanedName) throw new Error('文件夹名称不能为空');
      const projectPath = getProjectPath(workspacePath, status, projectName);
      const source = path.resolve(projectPath, folderName);
      const destination = path.resolve(projectPath, cleanedName);
      if (!source.startsWith(projectPath + path.sep) || !destination.startsWith(projectPath + path.sep)) throw new Error('无效的文件夹路径');
      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('文件夹不存在');
      if (isProtectedProjectFolderPath({ fs, path, projectRoot: projectPath, candidate: source })) {
        throw new Error('该文件夹由项目工作流管理，不能使用普通重命名');
      }
      if (isProtectedProjectFolderName(cleanedName)) throw new Error('该名称保留给项目工作流使用');
      if (fs.existsSync(destination)) throw new Error('同名文件夹已存在');
      await fs.promises.rename(source, destination);
      await pushUndoOperation({ kind: 'folder', source, destination, beforeName: folderName, afterName: cleanedName });
      return { success: true, folder: { name: cleanedName, path: destination, updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-undo-rename', async (_event, workspacePath = '', options = {}) => {
    let operation;
    try {
      operation = renameHistory.pop();
      if (!operation && workspacePath) {
        const workspaceRoot = resolveWorkspaceRoot(workspacePath);
        const latest = await workspaceRepository.latestUndoRecord(workspaceRoot);
        if (latest.record) operation = { kind: latest.record.kind, ...latest.record.payload, persistentId: latest.record.id, workspaceRoot };
      }
      if (!operation) return { success: false, error: '没有可撤销的操作' };
      if (operation.kind === 'remove-created') {
        for (const item of operation.paths) await assertUndoIdentity(operation, item);
        for (const item of operation.paths) await fs.promises.rm(item, { recursive: true, force: true });
        return { success: true, message: `已撤销${operation.label || '文件操作'} ${operation.paths.length} 个项目` };
      }
      if (operation.kind === 'trash') {
        const restoreConflictPolicy = ['rename', 'overwrite'].includes(options?.restoreConflictPolicy) ? options.restoreConflictPolicy : '';
        const restoreConflicts = [];
        for (const item of operation.items) {
          if (item.backup) {
            if (await pathExists(item.original) || !await pathExists(item.backup)) throw new Error('原位置已被占用，或旧版恢复副本不可用');
            continue;
          }
          if (!await pathExists(path.parse(item.original).root)) {
            throw Object.assign(new Error('原文件所在磁盘当前未连接，连接磁盘后可以再次撤销'), { code: 'RESTORE_VOLUME_UNAVAILABLE' });
          }
          const originalExists = await pathExists(item.original);
          if (originalExists && await samePathIdentity(item.original, item.originalIdentity)) continue;
          if (originalExists) restoreConflicts.push(item);
          const probe = await recycleBinService.probe(item.recyclePidl);
          if (!probe.exists) {
            if (operation.persistentId && operation.workspaceRoot) await workspaceRepository.markUndoRecordUnavailable(operation.workspaceRoot, operation.persistentId);
            throw Object.assign(new Error('系统回收站中的文件已不存在，可能已经被还原或清空'), { code: 'RECYCLE_ITEM_MISSING' });
          }
        }
        if (restoreConflicts.length && !restoreConflictPolicy) {
          renameHistory.push(operation);
          const names = restoreConflicts.slice(0, 6).map(item => path.basename(item.original));
          return {
            success: true,
            requiresDecision: {
              kind: 'restore-conflict',
              names,
              conflictCount: restoreConflicts.length,
              message: restoreConflicts.length === 1
                ? `“${names[0]}”的原位置已被其他项目占用`
                : `${restoreConflicts.length} 个项目的原位置已被同名项目占用`,
              detail: '可以改名恢复，也可以把当前同名项目移入系统回收站后覆盖恢复。',
            },
          };
        }
        for (const item of operation.items) {
          // Compatibility for deletion records created by older app versions.
          if (item.backup) {
            if (await pathExists(item.original) || !await pathExists(item.backup)) throw new Error('原位置已被占用，或旧版恢复副本不可用');
            await fs.promises.mkdir(path.dirname(item.original), { recursive: true });
            await fs.promises.cp(item.backup, item.original, { recursive: true, preserveTimestamps: true, errorOnExist: true });
            if (item.backupRoot) await fs.promises.rm(item.backupRoot, { recursive: true, force: true });
            continue;
          }
  
          let restoreTarget = item.original;
          if (!await pathExists(path.parse(item.original).root)) {
            throw Object.assign(new Error('原文件所在磁盘当前未连接，连接磁盘后可以再次撤销'), { code: 'RESTORE_VOLUME_UNAVAILABLE' });
          }
          if (await pathExists(item.original)) {
            if (await samePathIdentity(item.original, item.originalIdentity)) continue;
            if (!restoreConflictPolicy) throw new Error('原位置在检查后被占用，请重新撤销');
            if (restoreConflictPolicy === 'rename') {
              const parsed = path.parse(item.original);
              let index = 1;
              do { restoreTarget = path.join(parsed.dir, `${parsed.name} (已恢复${index > 1 ? ` ${index}` : ''})${parsed.ext}`); index += 1; }
              while (await pathExists(restoreTarget));
            } else {
              const replacementIdentity = await recycleBinService.trash(item.original);
              try {
                await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: item.original });
              } catch (error) {
                await recycleBinService.restore({ recyclePidl: replacementIdentity.recyclePidl, originalPath: item.original }).catch(() => undefined);
                throw error;
              }
              if (operation.workspaceRoot && replacementIdentity.recyclePidl) {
                const replacementRecord = await workspaceRepository.addUndoRecord(operation.workspaceRoot, {
                  kind: 'trash', payload: { items: [{ original: item.original, recyclePidl: replacementIdentity.recyclePidl }] },
                });
                await pushUndoOperation({ kind: 'trash', workspaceRoot: operation.workspaceRoot, persistentId: replacementRecord.id, items: [{ original: item.original, recyclePidl: replacementIdentity.recyclePidl }] });
              }
              continue;
            }
          }
          const probe = await recycleBinService.probe(item.recyclePidl);
          if (!probe.exists) {
            if (operation.persistentId && operation.workspaceRoot) await workspaceRepository.markUndoRecordUnavailable(operation.workspaceRoot, operation.persistentId);
            throw Object.assign(new Error('系统回收站中的文件已不存在，可能已经被还原或清空'), { code: 'RECYCLE_ITEM_MISSING' });
          }
          await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: restoreTarget });
        }
        if (operation.projectCatalog && operation.workspaceRoot) {
          await workspaceRepository.restoreProject(operation.workspaceRoot, operation.projectCatalog);
          await refreshWorkspaceCatalog(operation.workspaceRoot);
        }
        if (operation.persistentId && operation.workspaceRoot) await workspaceRepository.removeUndoRecord(operation.workspaceRoot, operation.persistentId);
        return { success: true, message: `已恢复 ${operation.items.length} 个已删除项目` };
      }
      if (operation.kind === 'import-with-sources') {
        for (const createdPath of operation.createdPaths) await assertUndoIdentity(operation, createdPath);
        if (operation.items.some(item => fs.existsSync(item.original) || !fs.existsSync(item.backup))) throw new Error('导入源文件的恢复副本不可用');
        for (const createdPath of operation.createdPaths) await fs.promises.rm(createdPath, { recursive: true, force: true });
        for (const item of operation.items) {
          await fs.promises.mkdir(path.dirname(item.original), { recursive: true });
          await fs.promises.cp(item.backup, item.original, { recursive: true, preserveTimestamps: true, errorOnExist: true });
          await fs.promises.rm(item.backupRoot, { recursive: true, force: true });
        }
        return { success: true, message: `已撤销导入 ${operation.items.length} 个文件` };
      }
      if (operation.kind === 'paste-replace') {
        const moves = Array.isArray(operation.moves) ? operation.moves : [];
        const replacementItems = Array.isArray(operation.items) ? operation.items : [];
        if (replacementItems.some(item => item.permanent || (!item.backup && !item.recyclePidl))) {
          throw new Error('部分被替换的原项目已由 Windows 永久删除，无法完整撤销此次粘贴');
        }
        for (const move of moves) await assertUndoIdentity(operation, move.destination);
        const destinationKeys = new Set(moves.map(move => path.resolve(move.destination).toLocaleLowerCase()));
        if (operation.mode === 'cut' && moves.some(move => fs.existsSync(move.source) && !destinationKeys.has(path.resolve(move.source).toLocaleLowerCase()))) {
          throw new Error('剪切源位置已被占用，无法安全撤销此次粘贴');
        }
        for (const item of replacementItems) {
          if (item.backup) {
            if (!fs.existsSync(item.backup)) throw new Error(`被替换项目“${path.basename(item.original)}”的恢复副本已不存在`);
          } else {
            const probe = await recycleBinService.probe(item.recyclePidl);
            if (!probe.exists) throw Object.assign(new Error(`回收站中的“${path.basename(item.original)}”已不存在，无法撤销替换`), { code: 'PASTE_REPLACEMENT_MISSING' });
          }
        }

        const undoRoot = path.join(path.dirname(moves[0]?.destination || replacementItems[0].original), `.photoflow-undo-paste-${crypto.randomUUID()}`);
        const stagedNewItems = [];
        const restoredOldItems = [];
        let preserveUndoRoot = false;
        await fs.promises.mkdir(undoRoot, { recursive: false });
        try {
          for (const [index, move] of moves.entries()) {
            const temporary = path.join(undoRoot, `new-${index}-${path.basename(move.destination)}`);
            await fs.promises.rename(move.destination, temporary);
            stagedNewItems.push({ ...move, temporary, movedToSource: false });
          }
          for (const item of replacementItems) {
            if (item.backup) await fs.promises.rename(item.backup, item.original);
            else await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: item.original });
            restoredOldItems.push(item);
          }
          if (operation.mode === 'cut') {
            for (const item of stagedNewItems) {
              await movePathAtomic(item.temporary, item.source);
              item.movedToSource = true;
            }
          } else {
            for (const item of stagedNewItems) await fs.promises.rm(item.temporary, { recursive: true, force: true });
          }
        } catch (error) {
          for (const [index, item] of [...restoredOldItems].reverse().entries()) {
            if (!fs.existsSync(item.original)) continue;
            const rollbackBackup = path.join(undoRoot, `old-${index}-${path.basename(item.original)}`);
            try {
              await fs.promises.rename(item.original, rollbackBackup);
              item.backup = rollbackBackup;
              item.backupRoot = undoRoot;
              item.recyclePidl = '';
              item.permanent = false;
              preserveUndoRoot = true;
            } catch { /* a later recovery attempt can report the occupied path */ }
          }
          for (const item of [...stagedNewItems].reverse()) {
            try {
              if (item.movedToSource && fs.existsSync(item.source) && !fs.existsSync(item.temporary)) await movePathAtomic(item.source, item.temporary);
              if (fs.existsSync(item.temporary) && !fs.existsSync(item.destination)) await fs.promises.rename(item.temporary, item.destination);
            } catch { /* best-effort rollback; preserve every reachable copy */ }
          }
          if (!preserveUndoRoot) await fs.promises.rm(undoRoot, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        await fs.promises.rm(undoRoot, { recursive: true, force: true }).catch(() => undefined);
        const backupRoots = new Set(replacementItems.map(item => item.backupRoot).filter(Boolean));
        for (const backupRoot of backupRoots) await fs.promises.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
        return { success: true, message: `已撤销粘贴并恢复 ${replacementItems.length} 个被替换项目` };
      }
      if (operation.kind === 'external-move') {
        for (const move of operation.moves) await assertUndoIdentity(operation, move.destination);
        if (operation.moves.some(move => fs.existsSync(move.source))) throw new Error('原位置已经被占用，无法安全撤销');
        for (const move of operation.moves) {
          try {
            await fs.promises.rename(move.destination, move.source);
          } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await fs.promises.cp(move.destination, move.source, { recursive: true, preserveTimestamps: true, errorOnExist: true });
            await fs.promises.rm(move.destination, { recursive: true, force: true });
          }
        }
        return { success: true, message: `已撤销导入 ${operation.moves.length} 个文件` };
      }
      if (operation.kind === 'broll-import') {
        const createdPaths = Array.isArray(operation.createdPaths) ? operation.createdPaths : [];
        const moves = Array.isArray(operation.moves) ? operation.moves : [];
        for (const item of createdPaths) await assertUndoIdentity(operation, item);
        for (const move of moves) await assertUndoIdentity(operation, move.destination);
        if (moves.some(item => fs.existsSync(item.source))) throw new Error('花絮原位置已被占用，无法安全撤销');
        for (const item of createdPaths) await fs.promises.rm(item, { force: true });
        for (const move of [...moves].reverse()) {
          try {
            await fs.promises.rename(move.destination, move.source);
          } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await fs.promises.copyFile(move.destination, move.source, fs.constants.COPYFILE_EXCL);
            await fs.promises.rm(move.destination, { force: true });
          }
        }
        return { success: true, message: `已撤销导入花絮 ${createdPaths.length + moves.length} 个文件` };
      }
      if (operation.kind === 'files' || operation.kind === 'move') {
        const moves = operation.moves.map(move => ({ source: move.destination, destination: move.source }));
        const normalizedSources = new Set(moves.map(move => path.resolve(move.source).toLocaleLowerCase()));
        for (const move of moves) await assertUndoIdentity(operation, move.source);
        if (moves.some(move => fs.existsSync(move.destination) && !normalizedSources.has(path.resolve(move.destination).toLocaleLowerCase()))) {
          throw new Error('原名称已被占用，无法撤销');
        }
        const staged = [];
        try {
          for (const move of moves) {
            const temporary = path.join(path.dirname(move.source), `.photoflow-undo-rename-${crypto.randomUUID()}${path.extname(move.source)}`);
            await fs.promises.rename(move.source, temporary);
            staged.push({ ...move, temporary, completed: false });
          }
          for (const move of staged) {
            await movePathAtomic(move.temporary, move.destination);
            move.completed = true;
          }
        } catch (error) {
          for (const move of [...staged].reverse()) {
            try {
              if (move.completed && fs.existsSync(move.destination) && !fs.existsSync(move.source)) await movePathAtomic(move.destination, move.source);
              else if (!move.completed && fs.existsSync(move.temporary) && !fs.existsSync(move.source)) await fs.promises.rename(move.temporary, move.source);
            } catch { /* best-effort rollback; original error is reported below */ }
          }
          throw error;
        }
        return { success: true, message: operation.kind === 'files' ? `已撤销重命名 ${moves.length} 个文件` : `已撤销移动 ${moves.length} 个项目` };
      }
      await assertUndoIdentity(operation, operation.destination);
      if (fs.existsSync(operation.source)) {
        throw new Error('原名称已被占用，无法撤销');
      }
      await fs.promises.rename(operation.destination, operation.source);
      const response = { success: true, message: `已撤销重命名：${operation.afterName} → ${operation.beforeName}` };
      if (operation.kind === 'project') {
        await mutateWorkspaceCatalog(operation.workspaceRoot, 'renameProject', { name: operation.afterName, nextName: operation.beforeName, relativePath: path.relative(operation.workspaceRoot, operation.source), ...(Object.prototype.hasOwnProperty.call(operation, 'beforeProjectDate') ? { projectDate: operation.beforeProjectDate || null } : {}) });
        response.project = { name: operation.beforeName, path: operation.source, status: operation.status, updatedAt: Date.now(), projectDate: operation.beforeProjectDate };
      }
      return response;
    } catch (error) {
      if (operation && error.code !== 'RECYCLE_ITEM_MISSING') renameHistory.push(operation);
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-move-project', async (_event, workspacePath, currentStatus, projectName, nextStatus) => {
    try {
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      if (!isValidProjectStatus(nextStatus)) throw new Error('无效的项目状态');
      if (nextStatus === '未分类') throw new Error('未分类仅用于自动发现的新文件夹');
      const source = getProjectPath(workspacePath, currentStatus, projectName);
      if (!fs.existsSync(source)) throw new Error('项目不存在');
      await mutateWorkspaceCatalog(root, 'setProjectStatus', { name: projectName, status: nextStatus });
      return { success: true, project: { name: projectName, path: source, status: nextStatus, updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-archive-imports', async (_event, workspacePath, projectNames = []) => {
    try {
      const root = ensureWorkspace(workspacePath);
      const plannedStatus = '后期中';
      const catalog = await reconcileWorkspaceCatalog(root);
      const requestedNames = new Set((Array.isArray(projectNames) ? projectNames : []).map(value => cleanProjectName(String(value))).filter(Boolean).map(value => value.toLocaleLowerCase()));
      const importedRows = catalog.projects.filter(project => requestedNames.has(project.name.toLocaleLowerCase()));
      const projects = [];
  
      for (const row of importedRows) {
        const projectPath = path.join(root, row.relative_path);
        if (!fs.existsSync(projectPath)) continue;
        if (row.status !== plannedStatus) await workspaceRepository.setProjectStatus(root, { name: row.name, status: plannedStatus });
        projects.push({ name: row.name, path: projectPath, status: plannedStatus, updatedAt: fs.statSync(projectPath).mtimeMs });
      }
  
      if (projects.length) {
        await refreshWorkspaceCatalog(root);
        for (const project of projects) scheduleMediaTrackingScan(root, project.name);
      }
  
      writeLog('info', 'Imported projects moved to post-production', { root, requested: [...requestedNames], count: projects.length });
      return { success: true, projects };
    } catch (error) {
      writeLog('error', 'Unable to archive imported folders', error);
      return { success: false, error: error.message || String(error), projects: [] };
    }
  });
  
  ipcMain.handle('workspace-trash-project', async (event, workspacePath, status, projectName) => {
    const operationId = crypto.randomUUID();
    let suppressedProjectPath = '';
    let task = null;
    const publish = payload => task?.publish(payload);
    try {
      const projectPath = getProjectPath(workspacePath, status, projectName);
      if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'trash', title: `删除项目 · ${projectName}`,
        projectName, resources: [projectPath], cancellable: false, cancelledCode: CANCELLED_CODE,
      });
      await task.start();
      publish({ phase: 'trashing', progress: 0, currentName: projectName, processedCount: 0, totalCount: 1 });
      const root = ensureWorkspace(workspacePath);
      const originalIdentity = await capturePathIdentity(projectPath);
      cancelMediaTrackingScan(root, projectName);
      suppressWorkspaceWatchPath(projectPath);
      suppressedProjectPath = projectPath;
      const recycled = await recycleBinService.trash(projectPath);
      const projectCatalog = { name: projectName, status };
      if (recycled.recyclePidl) {
        const item = { original: projectPath, originalIdentity, recyclePidl: recycled.recyclePidl, preciseRestore: recycled.preciseRestore !== false };
        const record = await workspaceRepository.addUndoRecord(root, { kind: 'trash', payload: { items: [item], projectCatalog } });
        await pushUndoOperation({ kind: 'trash', workspaceRoot: root, persistentId: record.id, items: [item], projectCatalog });
      } else if (recycled.permanent) {
        await workspaceRepository.addUndoRecord(root, {
          kind: 'project-cleanup',
          payload: { items: [{ original: projectPath, originalIdentity, permanent: true }], projectCatalog },
        });
      }
      await mutateWorkspaceCatalog(root, 'softDeleteProject', { name: projectName });
      publish({ phase: 'complete', progress: 100, currentName: projectName, processedCount: 1, totalCount: 1 });
      task.complete('项目已移入回收站');
      if (recycled.permanent) queuePermanentProjectCleanup(root, projectName);
      return { success: true, operationId, permanent: Boolean(recycled.permanent) };
    } catch (error) {
      publish({ phase: 'failed', progress: 0, currentName: projectName, error: error.message || String(error) });
      task?.fail(error);
      return { success: false, error: error.message || String(error), errorCode: error?.code || undefined };
    } finally {
      if (suppressedProjectPath) releaseWorkspaceWatchPath(suppressedProjectPath);
    }
  });
  
  ipcMain.handle('workspace-project-contents', async (_event, workspacePath, status, projectName) => {
    try {
      const projectPath = getProjectPath(workspacePath, status, projectName);
      if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
      const entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
      const folders = (await Promise.all(entries
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(async entry => {
          const folderPath = path.join(projectPath, entry.name);
          return { name: entry.name, path: folderPath, updatedAt: (await fs.promises.stat(folderPath)).mtimeMs };
        })))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      return { success: true, folders };
    } catch (error) {
      return { success: false, error: error.message || String(error), folders: [] };
    }
  });

  ipcMain.handle('workspace-watch-file-root', async (_event, workspacePath, status, projectName) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      mediaService.grantRoot(root);
      return acquireFileRootWatcher(root);
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-unwatch-file-root', async (_event, workspacePath, status, projectName) => {
    try {
      let root;
      try { root = path.resolve(getProjectPath(workspacePath, status, projectName)); }
      catch { root = path.resolve(String(workspacePath || '')); }
      releaseFileRootWatcher(root);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-browse-files', async (_event, workspacePath, status, projectName, relativePath = '', cacheConfig = {}) => {
    try {
      const projectPath = getProjectPath(workspacePath, status, projectName);
      const root = path.resolve(projectPath);
      const requestedPath = assertInside(root, path.resolve(root, relativePath || '.'), '文件夹路径', true);
      const currentPath = assertExistingInside(root, requestedPath, '文件夹路径', true);
      const currentStat = await fs.promises.stat(currentPath);
      if (!currentStat.isDirectory()) throw new Error('文件夹不存在');
      mediaService.grantRoot(root);
      mediaRuntimeState.activeMediaCacheConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
      const directoryEntries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      const entries = directoryEntries
        .filter(entry => !entry.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(entry.name.toLowerCase()) && !isInternalFileOperationEntry(entry.name))
        .map(entry => {
          const entryPath = path.join(currentPath, entry.name);
          const extension = entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase();
          const kind = entry.isDirectory() ? 'folder' : extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          return { name: entry.name, path: entryPath, relativePath: path.relative(root, entryPath), kind, extension, size: -1, createdAt: 0, updatedAt: 0 };
        })
        .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      const directoryIndex = thumbnailService.indexDirectory(root, currentPath, entries, mediaRuntimeState.activeMediaCacheConfig);
      if (!relativePath) {
        void directoryIndex.then(indexed => indexed && thumbnailService.scanProject(root, mediaRuntimeState.activeMediaCacheConfig));
        if (projectName !== '.__photoflow_inspiration__') scheduleMediaTrackingScan(ensureWorkspace(workspacePath), projectName);
      }
      return { success: true, path: path.relative(root, currentPath), entries };
    } catch (error) {
      writeLog('warn', 'Unable to browse project directory', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, missingDirectory: error?.code === 'ENOENT' || error?.code === 'ENOTDIR', error: error.message || String(error), entries: [] };
    }
  });

  ipcMain.handle('workspace-resolve-shortcut', async (_event, workspacePath, status, projectName, relativePath = '') => {
    try {
      if (process.platform !== 'win32') throw new Error('快捷方式解析目前仅支持 Windows');
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requestedPath = assertInside(root, path.resolve(root, relativePath), '快捷方式路径');
      const shortcutPath = assertExistingInside(root, requestedPath, '快捷方式路径');
      if (path.extname(shortcutPath).toLowerCase() !== '.lnk') throw new Error('所选项目不是 Windows 快捷方式');
      const shortcutStat = await fs.promises.stat(shortcutPath);
      if (!shortcutStat.isFile()) throw new Error('快捷方式文件不存在');
      const details = shell.readShortcutLink(shortcutPath);
      const target = path.resolve(String(details?.target || ''));
      if (!details?.target) throw new Error('快捷方式没有有效目标');
      const targetStat = await fs.promises.stat(target);
      if (!targetStat.isDirectory() && !targetStat.isFile()) throw new Error('快捷方式目标类型不受支持');
      return { success: true, target, targetKind: targetStat.isDirectory() ? 'folder' : 'file' };
    } catch (error) {
      writeLog('warn', 'Unable to resolve project shortcut', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-search-files', async (_event, workspacePath, status, projectName, scopeRelativePath = '', query = '') => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requestedScope = assertInside(root, path.resolve(root, scopeRelativePath || '.'), '搜索范围', true);
      const scope = assertExistingInside(root, requestedScope, '搜索范围', true);
      const scopeStat = await fs.promises.stat(scope);
      if (!scopeStat.isDirectory()) throw new Error('搜索范围不是文件夹');
      mediaService.grantRoot(root);
      const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');

      const entries = [];
      const pending = [scope];
      while (pending.length) {
        const directory = pending.pop();
        let children;
        try {
          children = await fs.promises.readdir(directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a project search directory', { directory, error: error.message || String(error) });
          continue;
        }
        for (const child of children) {
          if (child.isSymbolicLink() || HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) || isInternalFileOperationEntry(child.name)) continue;
          const childPath = path.join(directory, child.name);
          if (child.isDirectory()) {
            pending.push(childPath);
            if (!needle || child.name.toLocaleLowerCase('zh-CN').includes(needle)) {
              entries.push({ name: child.name, path: childPath, relativePath: path.relative(root, childPath), kind: 'folder', extension: '', size: -1, createdAt: 0, updatedAt: 0 });
            }
            continue;
          }
          if (!child.isFile() || needle && !child.name.toLocaleLowerCase('zh-CN').includes(needle)) continue;
          const extension = path.extname(child.name).toLowerCase();
          const kind = extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          entries.push({ name: child.name, path: childPath, relativePath: path.relative(root, childPath), kind, extension, size: -1, createdAt: 0, updatedAt: 0 });
        }
      }
      entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      return { success: true, scope: path.relative(root, scope), entries };
    } catch (error) {
      writeLog('warn', 'Unable to search project files', { projectName, scopeRelativePath, error: error.message || String(error) });
      return { success: false, entries: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-recent-files', async (_event, workspacePath, status, projectName, scopeRelativePath = '', requestedLimit = 120, requestedCursor = '') => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requestedScope = assertInside(root, path.resolve(root, scopeRelativePath || '.'), '最近文件范围', true);
      const scope = assertExistingInside(root, requestedScope, '最近文件范围', true);
      const scopeStat = await fs.promises.stat(scope);
      if (!scopeStat.isDirectory()) throw new Error('最近文件范围不是文件夹');
      mediaService.grantRoot(root);
      const pageSize = Math.min(240, Math.max(1, Number(requestedLimit) || 120));
      pruneRecentFileSessions();
      let cursor = String(requestedCursor || '');
      let session = cursor ? recentFileSessions.get(cursor) : null;
      if (cursor && (!session || session.root !== root || session.scope !== scope)) throw new Error('递归显示会话已失效，请重新打开递归显示');
      if (!session) {
        while (recentFileSessions.size >= 16) {
          const oldest = [...recentFileSessions.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
          if (!oldest) break;
          recentFileSessions.delete(oldest[0]);
        }
        cursor = crypto.randomUUID();
        session = {
          root,
          scope,
          pending: [{ directory: scope, priority: Number.MAX_SAFE_INTEGER, offset: 0, virtualPath: path.relative(root, scope).replace(/\\/g, '/'), viaShortcut: false }],
          visitedDirectories: new Set([path.resolve(scope).toLowerCase()]),
          candidates: [],
          scannedDirectories: 0,
          inspectedEntries: 0,
          touchedAt: Date.now(),
        };
        recentFileSessions.set(cursor, session);
      }
      if (!session.visitedDirectories) {
        session.visitedDirectories = new Set([
          path.resolve(scope).toLowerCase(),
          ...session.pending.map(candidate => path.resolve(candidate.directory).toLowerCase()),
        ]);
      }
      session.touchedAt = Date.now();
      const maximumDirectoriesPerPage = 64;
      const maximumInspectedEntriesPerPage = 4000;
      let pageScannedDirectories = 0;
      let pageInspectedEntries = 0;
      while (session.pending.length && pageScannedDirectories < maximumDirectoriesPerPage && pageInspectedEntries < maximumInspectedEntriesPerPage) {
        session.pending.sort((left, right) => right.priority - left.priority);
        const current = session.pending.shift();
        let children;
        try {
          children = await fs.promises.readdir(current.directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a recent-files directory', { directory: current.directory, error: error.message || String(error) });
          continue;
        }
        pageScannedDirectories += 1;
        session.scannedDirectories += 1;
        const allVisibleChildren = children
          .filter(child => !child.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) && !isInternalFileOperationEntry(child.name));
        const startOffset = Math.max(0, Number(current.offset) || 0);
        const visibleChildren = allVisibleChildren.slice(startOffset, startOffset + Math.max(0, maximumInspectedEntriesPerPage - pageInspectedEntries));
        if (startOffset + visibleChildren.length < allVisibleChildren.length) {
          session.pending.push({ ...current, offset: startOffset + visibleChildren.length });
        }
        pageInspectedEntries += visibleChildren.length;
        session.inspectedEntries += visibleChildren.length;
        for (let offset = 0; offset < visibleChildren.length; offset += 64) {
          const batch = visibleChildren.slice(offset, offset + 64);
          const inspected = await Promise.all(batch.map(async child => {
            const childPath = path.join(current.directory, child.name);
            try {
              return { child, childPath, stat: await fs.promises.stat(childPath) };
            } catch (error) {
              writeLog('warn', 'Unable to inspect a recent-files entry', { path: childPath, error: error.message || String(error) });
              return null;
            }
          }));
          for (const item of inspected) {
            if (!item) continue;
            const virtualRelativePath = [current.virtualPath, item.child.name].filter(Boolean).join('/');
            if (item.stat.isDirectory()) {
              const directoryKey = path.resolve(item.childPath).toLowerCase();
              if (!session.visitedDirectories.has(directoryKey)) {
                session.visitedDirectories.add(directoryKey);
                session.pending.push({ directory: item.childPath, priority: item.stat.mtimeMs || item.stat.birthtimeMs || 0, offset: 0, virtualPath: virtualRelativePath, viaShortcut: current.viaShortcut });
              }
              continue;
            }
            if (!item.stat.isFile()) continue;
            const extension = path.extname(item.child.name).toLowerCase();
            const kind = extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
            session.candidates.push({ name: item.child.name, path: item.childPath, relativePath: virtualRelativePath, kind, extension, size: item.stat.size, createdAt: item.stat.birthtimeMs || item.stat.ctimeMs || 0, updatedAt: item.stat.mtimeMs || 0, viaShortcut: Boolean(current.viaShortcut) });
            if (extension === '.lnk' && process.platform === 'win32') {
              try {
                const details = shell.readShortcutLink(item.childPath);
                const target = details?.target ? path.resolve(String(details.target)) : '';
                if (!target) continue;
                const targetStat = await fs.promises.stat(target);
                const directoryKey = path.resolve(target).toLowerCase();
                if (!targetStat.isDirectory() || session.visitedDirectories.has(directoryKey)) continue;
                session.visitedDirectories.add(directoryKey);
                mediaService.grantRoot(target);
                session.pending.push({ directory: target, priority: targetStat.mtimeMs || targetStat.birthtimeMs || item.stat.mtimeMs || 0, offset: 0, virtualPath: virtualRelativePath, viaShortcut: true });
              } catch (error) {
                writeLog('warn', 'Unable to follow a recent-files folder shortcut', { shortcut: item.childPath, error: error.message || String(error) });
              }
            }
          }
        }
        if (session.candidates.length >= pageSize) {
          const recentThreshold = [...session.candidates].sort((left, right) => right.updatedAt - left.updatedAt)[pageSize - 1]?.updatedAt || 0;
          const newestPendingDirectory = session.pending.reduce((newest, candidate) => Math.max(newest, candidate.priority), 0);
          if (newestPendingDirectory <= recentThreshold) break;
        }
      }
      session.candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      const entries = session.candidates.splice(0, pageSize);
      const hasMore = session.pending.length > 0 || session.candidates.length > 0;
      if (!hasMore) recentFileSessions.delete(cursor);
      return {
        success: true,
        scope: path.relative(root, scope),
        entries,
        cursor: hasMore ? cursor : undefined,
        hasMore,
        truncated: hasMore,
        scannedDirectories: session.scannedDirectories,
      };
    } catch (error) {
      writeLog('warn', 'Unable to list recent project files', { projectName, scopeRelativePath, error: error.message || String(error) });
      return { success: false, entries: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-folder-tree', async (_event, workspacePath, status, projectName) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const folders = [];
      const pending = [{ directory: root, relativePath: '', depth: 0 }];
      const maximumFolders = 20000;
      while (pending.length) {
        const current = pending.pop();
        let children;
        try {
          children = await fs.promises.readdir(current.directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a folder-tree directory', { directory: current.directory, error: error.message || String(error) });
          continue;
        }
        const directories = children
          .filter(child => child.isDirectory() && !child.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) && !isInternalFileOperationEntry(child.name))
          .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        for (const child of directories) {
          const childPath = path.join(current.directory, child.name);
          const relativePath = path.relative(root, childPath).replace(/\\/g, '/');
          folders.push({ name: child.name, relativePath, parentRelativePath: current.relativePath, depth: current.depth });
          if (folders.length >= maximumFolders) break;
        }
        if (folders.length >= maximumFolders) break;
        for (let index = directories.length - 1; index >= 0; index -= 1) {
          const child = directories[index];
          const childPath = path.join(current.directory, child.name);
          pending.push({ directory: childPath, relativePath: path.relative(root, childPath).replace(/\\/g, '/'), depth: current.depth + 1 });
        }
      }
      folders.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      return { success: true, folders, truncated: folders.length >= maximumFolders };
    } catch (error) {
      return { success: false, folders: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-add-inspiration-to-project', async (_event, inspirationRoot, targetWorkspacePath, targetStatus, targetProjectName, relativePaths) => {
    const createdTargets = [];
    try {
      const sourceRoot = path.resolve(getProjectPath(inspirationRoot, '未分类', '.__photoflow_inspiration__'));
      const targetRoot = path.resolve(getProjectPath(targetWorkspacePath, targetStatus, targetProjectName));
      const planningFolder = path.join(targetRoot, '策划');
      await fs.promises.mkdir(planningFolder, { recursive: true });
      const requestedPaths = [...new Set((Array.isArray(relativePaths) ? relativePaths : []).map(value => String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean))];
      if (!requestedPaths.length) throw new Error('请先选择要汇聚的文件或文件夹');
      const reserved = new Set();
      let fileCount = 0;
      let shortcutCount = 0;
      for (const relativePath of requestedPaths) {
        const source = path.resolve(resolveProjectEntry(inspirationRoot, '未分类', '.__photoflow_inspiration__', relativePath));
        assertExistingInside(sourceRoot, source, '灵感素材');
        const stat = await fs.promises.stat(source);
        if (stat.isDirectory()) {
          if (process.platform !== 'win32') throw new Error('文件夹快捷方式目前仅支持 Windows');
          const shortcutPath = uniqueDestination(planningFolder, `${path.basename(source)}.lnk`, reserved);
          const created = shell.writeShortcutLink(shortcutPath, { target: source, cwd: source, description: `灵感库：${path.basename(source)}` });
          if (!created) throw new Error(`无法创建文件夹快捷方式：${path.basename(source)}`);
          createdTargets.push(shortcutPath);
          shortcutCount += 1;
          continue;
        }
        if (!stat.isFile()) throw new Error(`不支持的灵感素材：${path.basename(source)}`);
        const destination = uniqueDestination(planningFolder, path.basename(source), reserved);
        await copyFileAtomic(source, destination);
        createdTargets.push(destination);
        fileCount += 1;
      }
      if (createdTargets.length) await pushUndoOperation({ kind: 'remove-created', paths: createdTargets, label: '灵感汇聚' });
      mainWindow?.webContents.send('workspace-files-changed', { root: targetRoot, fileName: '策划', eventType: 'rename' });
      writeLog('info', 'Inspiration items added to project planning folder', { targetProjectName, fileCount, shortcutCount, planningFolder });
      return { success: true, count: createdTargets.length, fileCount, shortcutCount, planningFolder };
    } catch (error) {
      for (const target of [...createdTargets].reverse()) await fs.promises.rm(target, { force: true }).catch(() => undefined);
      writeLog('error', 'Unable to add inspiration items to project', error);
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-entry-details', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const target = assertExistingInside(root, assertInside(root, path.resolve(root, relativePath), '文件路径', true), '文件路径', true);
      const stat = await fs.promises.stat(target);
      let size = stat.isFile() ? stat.size : 0;
      let fileCount = stat.isFile() ? 1 : 0;
      let folderCount = 0;
      if (stat.isDirectory()) {
        const pending = [target];
        while (pending.length) {
          const directory = pending.pop();
          for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) { folderCount += 1; pending.push(entryPath); }
            else if (entry.isFile()) { fileCount += 1; size += (await fs.promises.stat(entryPath)).size; }
          }
        }
      }
      return { success: true, details: { size, createdAt: stat.birthtimeMs || stat.ctimeMs, updatedAt: stat.mtimeMs, fileCount, folderCount } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-create-progress-folder', async (_event, workspacePath, status, projectName, request = {}) => {
    let folderPath = '';
    try {
      const cleanedName = cleanProjectName(String(request.displayName || ''));
      if (!cleanedName) throw new Error('进度文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      folderPath = path.resolve(projectPath, cleanedName);
      if (!folderPath.startsWith(projectPath + path.sep)) throw new Error('无效的进度文件夹名称');
      if (fs.existsSync(folderPath)) throw new Error('同名进度文件夹已存在');
      await fs.promises.mkdir(folderPath);
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const registered = await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: request.mediaKind,
        versionKey: request.versionKey,
        parentProgressId: request.parentProgressId,
        displayName: cleanedName,
        folderPath,
        trackingEnabled: false,
      });
      await pushUndoOperation({ kind: 'remove-created', paths: [folderPath], label: '新建版本进度' });
      return {
        success: true,
        progressFolder: registered.progressFolder,
        folder: { name: cleanedName, path: folderPath, relativePath: path.relative(projectPath, folderPath), updatedAt: Date.now() },
      };
    } catch (error) {
      if (folderPath) await fs.promises.rmdir(folderPath).catch(() => undefined);
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-open-version', async (_event, filePath) => {
    try {
      const target = await mediaService.authorizeInput(filePath);
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-open-project', async (_event, workspacePath, status, projectName, folderName) => {
    try {
      const target = resolveProjectEntry(workspacePath, status, projectName, folderName);
      const error = await shell.openPath(target);
      return { success: !error, error };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-open-entry', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const target = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      const error = await shell.openPath(target);
      return { success: !error, error };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('workspace-extract-office-images', async (_event, workspacePath, status, projectName, relativePaths = []) => {
    try {
      const requestedPaths = Array.isArray(relativePaths) ? relativePaths.slice(0, 50) : [];
      if (!requestedPaths.length) throw new Error('没有选择 Office 文档');
      const targets = requestedPaths.map(relativePath => resolveProjectEntry(workspacePath, status, projectName, relativePath));
      for (const target of targets) {
        if (!fs.statSync(target).isFile() || !officeOpenXmlExtensions.has(path.extname(target).toLowerCase())) {
          throw new Error(`不支持此 Office 文件：${path.basename(target)}`);
        }
      }
      const args = ['extract', ...targets.flatMap(target => ['--input', target])];
      const result = await runPythonJsonAction('office_media_extract.py', args, 20 * 60 * 1000);
      if (!result?.success) throw new Error(result?.error || '提取图片失败');
      mainWindow?.webContents.send('workspace-files-changed', { root: getProjectPath(workspacePath, status, projectName), fileName: '' });
      return { ...result, results: Array.isArray(result.results) ? result.results : [] };
    } catch (error) {
      writeLog('warn', 'Office image extraction failed', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), results: [] };
    }
  });

  ipcMain.handle('workspace-extract-screenshot-main-images', async (event, workspacePath, status, projectName, relativePaths = [], options = {}) => {
    const requestId = String(options?.requestId || '');
    const analyzeOnly = options?.analyzeOnly === true;
    const confirmedCrops = Array.isArray(options?.crops) ? options.crops : null;
    const publish = payload => {
      if (requestId && !event.sender.isDestroyed()) event.sender.send('workspace-screenshot-main-image-progress', { requestId, ...payload });
    };
    try {
      const requestedPaths = Array.isArray(relativePaths) ? relativePaths.slice(0, 2000) : [];
      if (!requestedPaths.length) throw new Error('没有选择图片');
      const targets = requestedPaths.map(relativePath => resolveProjectEntry(workspacePath, status, projectName, relativePath));
      if (confirmedCrops && confirmedCrops.length !== targets.length) throw new Error('确认的裁剪范围与图片数量不一致');
      for (const target of targets) {
        if (!fs.statSync(target).isFile() || !screenshotMainImageExtensions.has(path.extname(target).toLowerCase())) {
          throw new Error(`不支持此图片格式：${path.basename(target)}`);
        }
      }
      const results = [];
      const command = analyzeOnly ? 'analyze' : confirmedCrops ? 'crop' : 'extract';
      publish({ phase: analyzeOnly ? 'analyzing' : 'extracting', progress: 0, processedCount: 0, totalCount: targets.length, message: analyzeOnly ? '正在准备分析截图主图…' : '正在准备提取截图主图…' });
      for (let offset = 0; offset < targets.length; offset += 60) {
        const chunk = targets.slice(offset, offset + 60);
        const cropChunk = confirmedCrops?.slice(offset, offset + chunk.length) || [];
        const args = [command, ...chunk.flatMap((target, index) => {
          if (!confirmedCrops) return ['--input', target];
          const crop = cropChunk[index] || {};
          const values = ['x', 'y', 'width', 'height'].map(key => Math.round(Number(crop[key]) || 0));
          return ['--input', target, '--rectangle', values.join(',')];
        })];
        const payload = await runPythonJsonAction('screenshot_main_image.py', args, 30 * 60 * 1000, message => {
          if (message?.type !== 'progress') return;
          const processedCount = Math.max(0, Math.min(targets.length, offset + Number(message.processedCount || 0)));
          const currentName = String(message.currentName || '');
          const displayIndex = message.phase === 'item-start' ? Math.min(targets.length, processedCount + 1) : processedCount;
          publish({
            phase: analyzeOnly ? 'analyzing' : 'extracting',
            progress: Math.round(processedCount / Math.max(1, targets.length) * 100),
            processedCount,
            totalCount: targets.length,
            currentName,
            message: `${message.phase === 'item-complete' ? '已处理' : analyzeOnly ? '正在分析' : '正在裁剪'} ${displayIndex}/${targets.length}${currentName ? ` · ${currentName}` : ''}`,
          });
        });
        if (!payload?.success && !Array.isArray(payload?.results)) throw new Error(payload?.error || '提取截图主图失败');
        results.push(...(Array.isArray(payload.results) ? payload.results : []));
      }
      const croppedCount = results.filter(result => result?.cropped).length;
      const reviewCount = results.filter(result => result?.needsReview).length;
      const skippedCount = results.filter(result => result?.skipped).length;
      const failedCount = results.filter(result => !result?.success).length;
      publish({ phase: 'complete', progress: 100, processedCount: targets.length, totalCount: targets.length, message: analyzeOnly ? '主图范围分析完成' : '主图提取完成' });
      if (!analyzeOnly) {
        const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
        const outputPaths = results.flatMap(result => result?.cropped && result?.output ? [assertInside(projectRoot, path.resolve(result.output), '主图输出路径')] : []);
        if (outputPaths.length) void thumbnailService.syncChangedPaths(projectRoot, outputPaths, mediaRuntimeState.activeMediaCacheConfig).catch(error => {
          writeLog('warn', 'Unable to queue screenshot main-image thumbnails', { projectName, error: error.message || String(error) });
        });
        const workspaceRoot = path.resolve(resolveWorkspaceRoot(workspacePath));
        mainWindow?.webContents.send('workspace-files-changed', { root: workspaceRoot, fileName: path.relative(workspaceRoot, projectRoot), eventType: 'rename' });
      }
      return {
        success: failedCount < results.length,
        inputCount: results.length,
        croppedCount,
        reviewCount,
        skippedCount,
        failedCount,
        results,
        ...(failedCount === results.length ? { error: results[0]?.error || '提取截图主图失败' } : {}),
      };
    } catch (error) {
      publish({ phase: 'failed', progress: 0, message: `提取失败：${error.message || String(error)}` });
      writeLog('warn', 'Screenshot main image extraction failed', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), results: [] };
    }
  });
  
  ipcMain.handle('workspace-open-entry-photoshop', async (_event, workspacePath, status, projectName, relativePaths) => {
    try {
      const executable = await findLatestPhotoshop();
      if (!executable) throw new Error('未检测到 Photoshop');
      const paths = Array.isArray(relativePaths) ? relativePaths : [relativePaths];
      if (!paths.length) throw new Error('没有选择要打开的文件');
      const targets = paths.map(relativePath => resolveProjectEntry(workspacePath, status, projectName, relativePath));
      if (targets.some(target => !fs.statSync(target).isFile())) throw new Error('只能用 Photoshop 打开文件');
      return await new Promise(resolve => {
        const child = spawn(executable, targets, { detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', error => resolve({ success: false, error: error.message || String(error) }));
        child.once('spawn', () => {
          child.unref();
          resolve({ success: true, count: targets.length });
        });
      });
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  
  ipcMain.handle('workspace-copy-entry-path', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const target = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      clipboard.writeText(target);
      return { success: true };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  
  ipcMain.handle('workspace-entry-file-icon', async (_event, filePath) => {
    try {
      const target = await mediaService.authorizeInput(filePath);
      if (!(await fs.promises.stat(target)).isFile()) throw new Error('文件不存在');
      const icon = await app.getFileIcon(target, { size: 'normal' });
      return { success: !icon.isEmpty(), dataUrl: icon.isEmpty() ? undefined : icon.toDataURL() };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  
  ipcMain.handle('workspace-import-files', async (event, workspacePath, status, projectName, relativePath = '', options = {}) => {
    const operationId = crypto.randomUUID();
    let job = { cancelled: false, finishing: false };
    let task = null;
    const publish = payload => task?.publish(payload);
    const moves = [];
    const createdTargets = [];
    try {
      const deleteSourceAfterImport = options?.deleteSourceAfterImport === true;
      const preserveOriginal = !deleteSourceAfterImport;
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const destinationDir = assertInside(projectPath, path.resolve(projectPath, relativePath || '.'), '导入位置', true);
      if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('当前文件夹不存在');
      const choice = await dialog.showOpenDialog(mainWindow, { title: '选择要导入的文件', properties: ['openFile', 'multiSelections'] });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0 };
      const sourceInfos = await Promise.all(choice.filePaths.map(source => assertRegularFile(source)));
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-files', title: `导入文件 · ${projectName}`,
        projectName, resources: [destinationDir, ...sourceInfos.map(source => source.path)], cancelledCode: CANCELLED_CODE,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeProjectFileOperations.set(operationId, job);
      await task.start();
      const totalBytes = sourceInfos.reduce((sum, source) => sum + source.stat.size, 0);
      let completedBytes = 0;
      let completedFiles = 0;
      let lastPublishedAt = 0;
      publish({ phase: 'scanning', progress: 0, bytesCopied: 0, totalBytes, filesCopied: 0, totalFiles: sourceInfos.length });
      const report = (sourceInfo, itemBytes) => {
        const now = Date.now();
        if (now - lastPublishedAt < 80 && itemBytes < sourceInfo.stat.size) return;
        lastPublishedAt = now;
        const bytesCopied = Math.min(totalBytes, completedBytes + itemBytes);
        publish({ phase: preserveOriginal ? 'copying' : 'moving', progress: totalBytes ? Math.min(99, Math.round(bytesCopied / totalBytes * 100)) : 0, currentName: path.basename(sourceInfo.path), bytesCopied, totalBytes, filesCopied: completedFiles, totalFiles: sourceInfos.length });
      };
      const reserved = new Set();
      for (const sourceInfo of sourceInfos) {
        if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
        const destination = uniqueDestination(destinationDir, path.basename(sourceInfo.path), reserved);
        if (preserveOriginal) {
          await copyFileAtomic(sourceInfo.path, destination, { isCancelled: () => job.cancelled, onProgress: progress => report(sourceInfo, progress.bytesCopied) });
          createdTargets.push(destination);
        } else {
          await moveFileAtomic(sourceInfo.path, destination, { isCancelled: () => job.cancelled, onProgress: progress => report(sourceInfo, progress.bytesCopied) });
          moves.push({ source: sourceInfo.path, destination });
        }
        completedBytes += sourceInfo.stat.size;
        completedFiles += 1;
        report(sourceInfo, sourceInfo.stat.size);
      }
      job.finishing = true;
      publish({ phase: 'finishing', progress: 99, currentName: '正在完成文件导入', bytesCopied: totalBytes, totalBytes, filesCopied: sourceInfos.length, totalFiles: sourceInfos.length });
      if (preserveOriginal && createdTargets.length) await pushUndoOperation({ kind: 'remove-created', paths: createdTargets, label: '导入' });
      if (!preserveOriginal && moves.length) await pushUndoOperation({ kind: 'external-move', moves });
      writeLog('info', 'Files imported into current project directory', { projectName, relativePath, count: choice.filePaths.length, preserveOriginal });
      telemetryService?.track('photos_imported', {
        count_bucket: telemetryService.countBucket(choice.filePaths.length),
        source: 'project_files',
        preserve_original: preserveOriginal,
      });
      publish({ phase: 'complete', progress: 100, currentName: '文件导入完成', bytesCopied: totalBytes, totalBytes, filesCopied: sourceInfos.length, totalFiles: sourceInfos.length });
      task.complete('文件导入完成');
      return { success: true, operationId, count: choice.filePaths.length };
    } catch (error) {
      for (const move of [...moves].reverse()) {
        try {
          if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) await moveFileAtomic(move.destination, move.source);
        } catch (rollbackError) {
          writeLog('error', 'Unable to roll back project file import', { move, error: rollbackError.message || String(rollbackError) });
        }
      }
      for (const target of createdTargets) await fs.promises.rm(target, { force: true }).catch(() => undefined);
      const cancelled = error?.code === CANCELLED_CODE;
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, error: error.message || String(error) });
      if (cancelled) task?.cancelled();
      else task?.fail(error);
      if (!cancelled) writeLog('error', 'Project file import failed', error);
      return cancelled ? { success: true, cancelled: true, operationId, count: 0 } : { success: false, operationId, error: error.message || String(error) };
    } finally {
      activeProjectFileOperations.delete(operationId);
    }
  });
  
  ipcMain.handle('workspace-import-progress-files', async (event, workspacePath, status, projectName, folderName, options = {}) => {
    const operationId = crypto.randomUUID();
    let job = { cancelled: false, finishing: false };
    let task = null;
    const publish = payload => task?.publish(payload);
    let createdFolder = '';
    const createdTargets = [];
    const moves = [];
    try {
      const mediaKind = options.mediaKind === 'video' ? 'video' : 'image';
      const deleteSourceAfterImport = options?.deleteSourceAfterImport === true;
      const preserveOriginal = !deleteSourceAfterImport;
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const appendProgressId = String(options.appendProgressId || '');
      const appendProgress = appendProgressId
        ? (await versionService.listProgress(workspaceRoot, projectName)).progressFolders?.find(progress => progress.id === appendProgressId)
        : null;
      if (appendProgressId && (!appendProgress || appendProgress.folderMissing)) throw new Error('要追加的进度文件夹不存在');
      if (appendProgress && (appendProgress.mediaKind !== mediaKind || appendProgress.versionKey !== String(options.versionKey || ''))) {
        throw new Error('追加目标与所选进度类型或版本号不一致');
      }
      const cleanedName = cleanProjectName(String(appendProgress?.displayName || folderName || ''));
      if (!cleanedName) throw new Error('进度文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const destinationDir = path.resolve(appendProgress ? appendProgress.folderPath : path.join(projectPath, cleanedName));
      if (!destinationDir.startsWith(projectPath + path.sep)) throw new Error('无效的进度文件夹名称');
      if (appendProgress ? !fs.existsSync(destinationDir) : fs.existsSync(destinationDir)) {
        throw new Error(appendProgress ? '要追加的进度文件夹不存在' : '同名进度文件夹已存在');
      }
      const extensions = mediaKind === 'video'
        ? [...VIDEO_EXTENSIONS].map(value => value.slice(1))
        : [...new Set([...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS])].map(value => value.slice(1));
      const progressConflictPolicy = ['skip', 'keep-both'].includes(options.progressConflictPolicy) ? options.progressConflictPolicy : '';
      let selectedSourcePaths;
      if (progressConflictPolicy) {
        if (!appendProgress) throw new Error('只能在向已有进度追加文件时处理同名冲突');
        if (!Array.isArray(options.sourcePaths) || !options.sourcePaths.length) throw new Error('同名文件冲突确认已失效，请重新选择文件');
        selectedSourcePaths = options.sourcePaths.map(value => String(value));
      } else {
        const choice = await dialog.showOpenDialog(mainWindow, {
          title: mediaKind === 'video' ? '选择要导入的视频版本' : '选择要导入的图片版本',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: mediaKind === 'video' ? '视频文件' : '图片与 RAW', extensions }],
        });
        if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0 };
        selectedSourcePaths = choice.filePaths;
      }
      let sourceInfos = [];
      for (const source of selectedSourcePaths) {
        const sourceInfo = await assertRegularFile(source);
        const extension = path.extname(sourceInfo.path).toLowerCase();
        const supported = mediaKind === 'video' ? VIDEO_EXTENSIONS.has(extension) : IMAGE_EXTENSIONS.has(extension) || RAW_EXTENSIONS.has(extension);
        if (!supported) throw new Error(`所选文件不属于${mediaKind === 'video' ? '视频' : '图片'}进度：${path.basename(sourceInfo.path)}`);
        sourceInfos.push(sourceInfo);
      }
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-progress', title: `导入版本进度 · ${projectName}`,
        projectName, resources: [destinationDir, ...sourceInfos.map(source => source.path)], cancelledCode: CANCELLED_CODE, emitLegacyProgress: true,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeProjectFileOperations.set(operationId, job);
      await task.start();
      let totalBytes = sourceInfos.reduce((sum, source) => sum + source.stat.size, 0);
      publish({ phase: 'scanning', progress: 0, currentName: '正在检查重复文件', bytesCopied: 0, totalBytes, filesCopied: 0, totalFiles: sourceInfos.length });
      let skippedCount = 0;
      const skippedNames = [];
      if (appendProgress) {
        const digestFile = filePath => new Promise((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          const stream = fs.createReadStream(filePath);
          stream.on('data', chunk => {
            if (job.cancelled) {
              stream.destroy(Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE }));
              return;
            }
            hash.update(chunk);
          });
          stream.on('error', reject);
          stream.on('end', () => resolve(hash.digest('hex')));
        });
        const collisionRecords = [];
        for (const sourceInfo of sourceInfos) {
          if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
          const existingPath = path.join(destinationDir, path.basename(sourceInfo.path));
          if (!fs.existsSync(existingPath) || !fs.statSync(existingPath).isFile()) continue;
          const [sourceStat, existingStat] = await Promise.all([fs.promises.stat(sourceInfo.path), fs.promises.stat(existingPath)]);
          collisionRecords.push({ sourcePath: sourceInfo.path, existingPath, sourceStat, existingStat });
        }
        const conflictCacheKey = crypto.createHash('sha256').update(JSON.stringify({
          destinationDir,
          files: collisionRecords.map(record => ({
            sourcePath: record.sourcePath,
            sourceSize: record.sourceStat.size,
            sourceMtimeMs: record.sourceStat.mtimeMs,
            existingPath: record.existingPath,
            existingSize: record.existingStat.size,
            existingMtimeMs: record.existingStat.mtimeMs,
          })),
        })).digest('hex');
        pruneProgressImportConflictCache();
        const cachedConflicts = progressImportConflictCache.get(conflictCacheKey);
        const exactDuplicates = new Set(cachedConflicts?.exactDuplicates || []);
        const conflicts = [...(cachedConflicts?.conflicts || [])];
        if (!cachedConflicts) {
          for (const record of collisionRecords) {
            if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
            const identical = record.sourceStat.size === record.existingStat.size
              && await digestFile(record.sourcePath) === await digestFile(record.existingPath);
            if (identical) exactDuplicates.add(record.sourcePath);
            else conflicts.push(record.sourcePath);
          }
          progressImportConflictCache.set(conflictCacheKey, {
            exactDuplicates: [...exactDuplicates],
            conflicts: [...conflicts],
            expiresAt: Date.now() + 10 * 60 * 1000,
          });
        }
        const keepConflicts = progressConflictPolicy === 'keep-both';
        if (conflicts.length) {
          if (!progressConflictPolicy) {
            const conflictNames = conflicts.slice(0, 6).map(filePath => path.basename(filePath));
            const more = conflicts.length > conflictNames.length ? `等 ${conflicts.length} 个文件` : conflictNames.map(name => `“${name}”`).join('、');
            publish({ phase: 'complete', progress: 100, currentName: '等待处理同名文件', count: 0, decisionRequired: true });
            task.complete('等待用户处理同名文件');
            return {
              success: true,
              operationId,
              count: 0,
              requiresDecision: {
                kind: 'progress-import-conflict',
                names: conflictNames,
                conflictCount: conflicts.length,
                sourcePaths: selectedSourcePaths,
                message: `追加进度时发现 ${more}与现有文件同名，但内容不同。`,
                detail: '可以跳过这些文件，或者保留两份并为新文件自动添加编号。现有进度文件不会被覆盖。',
              },
            };
          }
        }
        const skippedPaths = new Set([...exactDuplicates, ...(keepConflicts ? [] : conflicts)]);
        skippedCount = skippedPaths.size;
        skippedNames.push(...[...skippedPaths].map(filePath => path.basename(filePath)));
        sourceInfos = sourceInfos.filter(sourceInfo => !skippedPaths.has(sourceInfo.path));
      }
      if (!appendProgress) {
        await fs.promises.mkdir(destinationDir);
        createdFolder = destinationDir;
      }
      totalBytes = sourceInfos.reduce((sum, source) => sum + source.stat.size, 0);
      let completedBytes = 0;
      let completedFiles = 0;
      let lastPublishedAt = 0;
      publish({ phase: 'scanning', progress: 0, bytesCopied: 0, totalBytes, filesCopied: 0, totalFiles: sourceInfos.length });
      const report = (sourceInfo, itemBytes) => {
        const now = Date.now();
        if (now - lastPublishedAt < 80 && itemBytes < sourceInfo.stat.size) return;
        lastPublishedAt = now;
        const bytesCopied = Math.min(totalBytes, completedBytes + itemBytes);
        publish({ phase: preserveOriginal ? 'copying' : 'moving', progress: totalBytes ? Math.min(99, Math.round(bytesCopied / totalBytes * 100)) : 0, currentName: path.basename(sourceInfo.path), bytesCopied, totalBytes, filesCopied: completedFiles, totalFiles: sourceInfos.length });
      };
      const reserved = new Set();
      for (const sourceInfo of sourceInfos) {
        if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
        const destination = uniqueDestination(destinationDir, path.basename(sourceInfo.path), reserved);
        if (preserveOriginal) {
          await copyFileAtomic(sourceInfo.path, destination, { isCancelled: () => job.cancelled, onProgress: progress => report(sourceInfo, progress.bytesCopied) });
          createdTargets.push(destination);
        } else {
          await moveFileAtomic(sourceInfo.path, destination, { isCancelled: () => job.cancelled, onProgress: progress => report(sourceInfo, progress.bytesCopied) });
          moves.push({ source: sourceInfo.path, destination });
        }
        completedBytes += sourceInfo.stat.size;
        completedFiles += 1;
        report(sourceInfo, sourceInfo.stat.size);
      }
      job.finishing = true;
      publish({ phase: 'finishing', progress: 99, currentName: '正在登记版本进度', bytesCopied: totalBytes, totalBytes, filesCopied: sourceInfos.length, totalFiles: sourceInfos.length });
      const registered = appendProgress ? await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: appendProgress.mediaKind,
        versionKey: appendProgress.versionKey,
        parentProgressId: appendProgress.parentProgressId,
        displayName: appendProgress.displayName,
        folderPath: appendProgress.folderPath,
        trackingEnabled: false,
        trackingState: options.trackingState || appendProgress.trackingState,
        progressId: appendProgress.id,
      }) : await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind,
        versionKey: options.versionKey,
        parentProgressId: options.parentProgressId,
        displayName: cleanedName,
        folderPath: destinationDir,
        trackingEnabled: Boolean(options.trackingEnabled),
        trackingState: options.trackingState,
      });
      if (preserveOriginal && (appendProgress ? createdTargets.length : true)) await pushUndoOperation({ kind: 'remove-created', paths: appendProgress ? createdTargets : [destinationDir], label: appendProgress ? '追加版本进度' : '导入版本进度' });
      else if (moves.length) await pushUndoOperation({ kind: 'external-move', moves });
      writeLog('info', appendProgress ? 'Files appended to progress version' : 'Progress version files imported', { projectName, folderName: cleanedName, mediaKind, count: sourceInfos.length, skippedCount, preserveOriginal });
      telemetryService?.track('photos_imported', {
        count_bucket: telemetryService.countBucket(sourceInfos.length),
        source: appendProgress ? 'progress_version_append' : 'progress_version',
        media_kind: mediaKind,
        preserve_original: preserveOriginal,
      });
      publish({ phase: 'complete', progress: 100, currentName: '版本进度导入完成', bytesCopied: totalBytes, totalBytes, filesCopied: sourceInfos.length, totalFiles: sourceInfos.length });
      task.complete('版本进度导入完成');
      return {
        success: true,
        operationId,
        count: sourceInfos.length,
        skippedCount,
        skippedNames,
        appended: Boolean(appendProgress),
        importedPaths: [...createdTargets, ...moves.map(move => move.destination)],
        progressFolder: registered.progressFolder,
        folder: { name: cleanedName, path: destinationDir, relativePath: path.relative(projectPath, destinationDir), updatedAt: Date.now() },
      };
    } catch (error) {
      for (const move of [...moves].reverse()) {
        try {
          if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) {
            await moveFileAtomic(move.destination, move.source);
          }
        } catch { /* best effort rollback */ }
      }
      for (const target of createdTargets) await fs.promises.rm(target, { force: true }).catch(() => undefined);
      if (createdFolder) await fs.promises.rm(createdFolder, { recursive: true, force: true }).catch(() => undefined);
      const cancelled = error?.code === CANCELLED_CODE;
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, error: error.message || String(error) });
      if (cancelled) task?.cancelled();
      else task?.fail(error);
      if (!cancelled) writeLog('error', 'Progress version import failed', { projectName, folderName, error: error.message || String(error) });
      return cancelled ? { success: true, cancelled: true, operationId, count: 0 } : { success: false, operationId, error: error.message || String(error) };
    } finally {
      activeProjectFileOperations.delete(operationId);
    }
  });
};

module.exports = { registerWorkspaceIpc };
