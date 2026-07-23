const registerWorkspaceIpc = context => {
  const { Array, Boolean, Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES, IMAGE_EXTENSIONS, Object, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, WORKSPACE_STATUSES, app, assertExistingInside, assertInside, assertRegularFile, assertUndoIdentity, capturePathIdentity, cleanProjectName, clipboard, copyFileAtomic, crypto, dialog, ensureWorkspace, findLatestPhotoshop, fs, getProjectPath, getWorkspaceDataRoot, ipcMain, mainWindow, mediaRuntimeState, mediaService, moveFileAtomic, mutateWorkspaceCatalog, normalizeMediaCacheSizeGB, path, pathExists, pluginService, pushUndoOperation, recycleBinService, refreshWorkspaceCatalog, renameHistory, resolveProjectEntry, resolveWorkspaceRoot, samePathIdentity, scheduleMediaTrackingScan, shell, spawn, thumbnailService, undefined, uniqueDestination, versionService, watchWorkspace, workspaceCatalogs, workspaceRepository, writeLog } = context;
  const officeOpenXmlExtensions = new Set([
    '.docx', '.docm', '.dotx', '.dotm',
    '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppam',
    '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlam', '.xlsb',
  ]);

  const inspectDeletedProject = async (root, project) => {
    const originalPath = path.resolve(root, project.relativePath);
    const relative = path.relative(root, originalPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ...project, originalPath, recycleStatus: 'unknown', statusDetail: '项目原路径无效，已保留数据' };
    }
    if (await pathExists(originalPath)) {
      return { ...project, originalPath, recycleStatus: 'restored', statusDetail: '原项目路径已重新出现' };
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
    let removedCount = 0;
    for (const candidate of new Set(candidates)) {
      if (!candidate) continue;
      const resolved = path.resolve(candidate);
      const relative = path.relative(dataRoot, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      try {
        await fs.promises.rm(resolved, { recursive: true, force: true });
        removedCount += 1;
      } catch (error) {
        writeLog('warn', 'Unable to remove deleted project artifact', { path: resolved, error: error.message || String(error) });
      }
    }
    return removedCount;
  };

  const purgeConfirmedDeletedProject = async (root, project) => {
    const inspected = await inspectDeletedProject(root, project);
    if (inspected.recycleStatus !== 'missing') return { cleaned: false, status: inspected.recycleStatus };
    const purgeResult = await workspaceRepository.purgeDeletedProject(root, project.id);
    const removedArtifactCount = await removeInternalProjectArtifacts(root, purgeResult);
    await thumbnailService.invalidateSources(purgeResult.sourcePaths || []).catch(error => {
      writeLog('warn', 'Unable to clear deleted project thumbnail cache', { project: project.name, error: error.message || String(error) });
    });
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
    return { cleaned: true, status: 'missing', removedArtifactCount };
  };

  ipcMain.handle('workspace-cleanup-deleted-projects', async (_event, workspacePath) => {
    try {
      const root = ensureWorkspace(workspacePath);
      const result = await workspaceRepository.listDeletedProjects(root);
      const outcomes = [];
      for (const project of result.projects || []) outcomes.push({ projectId: project.id, name: project.name, ...await purgeConfirmedDeletedProject(root, project) });
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
      const statuses = WORKSPACE_STATUSES.map(status => {
        const projects = catalog.projects
          .filter(project => project.status === status)
          .map(project => {
            const projectPath = path.resolve(root, project.relative_path);
            return { name: project.name, path: projectPath, status, updatedAt: fs.existsSync(projectPath) ? fs.statSync(projectPath).mtimeMs : project.updated_at };
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
  
  ipcMain.handle('workspace-create-project', async (_event, workspacePath, date, name) => {
    try {
      const datePart = cleanProjectName(date || '');
      const namePart = cleanProjectName(name || '');
      const projectName = [datePart, namePart].filter(Boolean).join(' ');
      if (!projectName) throw new Error('请至少填写日期或名称');
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      if (catalog.byName.has(projectName.toLocaleLowerCase())) throw new Error('同名项目已存在');
      const projectPath = getProjectPath(workspacePath, '策划中', projectName);
      if (fs.existsSync(projectPath)) throw new Error('同名项目已存在');
      fs.mkdirSync(projectPath, { recursive: false });
      fs.mkdirSync(path.join(projectPath, '策划'), { recursive: true });
      await mutateWorkspaceCatalog(root, 'addProject', { name: projectName, status: '策划中', relativePath: path.relative(root, projectPath) });
      writeLog('info', 'Project created', { projectName, projectPath });
      return { success: true, project: { name: projectName, path: projectPath, status: '策划中', updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-rename-project', async (_event, workspacePath, status, projectName, nextName) => {
    try {
      const cleanedName = cleanProjectName(nextName || '');
      if (!cleanedName) throw new Error('项目名称不能为空');
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      const existingProject = catalog.byName.get(cleanedName.toLocaleLowerCase());
      if (existingProject && existingProject.name.toLocaleLowerCase() !== projectName.toLocaleLowerCase()) throw new Error('同名项目已存在');
      const source = getProjectPath(workspacePath, status, projectName);
      const destination = path.join(path.dirname(source), cleanedName);
      if (!fs.existsSync(source)) throw new Error('项目不存在');
      if (fs.existsSync(destination)) throw new Error('同名项目已存在');
      await fs.promises.rename(source, destination);
      await mutateWorkspaceCatalog(root, 'renameProject', { name: projectName, nextName: cleanedName, relativePath: path.relative(root, destination) });
      await pushUndoOperation({ kind: 'project', source, destination, status, workspaceRoot: root, beforeName: projectName, afterName: cleanedName });
      return { success: true, project: { name: cleanedName, path: destination, status, updatedAt: Date.now() } };
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
  
  ipcMain.handle('workspace-rename-project-folder', async (_event, workspacePath, status, projectName, folderName, nextName) => {
    try {
      const cleanedName = cleanProjectName(nextName || '');
      if (!cleanedName) throw new Error('文件夹名称不能为空');
      const projectPath = getProjectPath(workspacePath, status, projectName);
      const source = path.resolve(projectPath, folderName);
      const destination = path.resolve(projectPath, cleanedName);
      if (!source.startsWith(projectPath + path.sep) || !destination.startsWith(projectPath + path.sep)) throw new Error('无效的文件夹路径');
      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('文件夹不存在');
      if (fs.existsSync(destination)) throw new Error('同名文件夹已存在');
      await fs.promises.rename(source, destination);
      await pushUndoOperation({ kind: 'folder', source, destination, beforeName: folderName, afterName: cleanedName });
      return { success: true, folder: { name: cleanedName, path: destination, updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-undo-rename', async (_event, workspacePath = '') => {
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
            const choice = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              title: '原位置已有同名项目',
              message: `“${path.basename(item.original)}”的原位置已被其他项目占用`,
              detail: '可以改名恢复，也可以把当前同名项目移入系统回收站后覆盖恢复。',
              buttons: ['改名恢复', '覆盖恢复', '取消'],
              defaultId: 0,
              cancelId: 2,
              noLink: true,
            });
            if (choice.response === 2) throw Object.assign(new Error('已取消撤销'), { code: 'UNDO_CANCELLED' });
            if (choice.response === 0) {
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
            await fs.promises.rename(move.temporary, move.destination);
            move.completed = true;
          }
        } catch (error) {
          for (const move of [...staged].reverse()) {
            try {
              if (move.completed && fs.existsSync(move.destination) && !fs.existsSync(move.source)) await fs.promises.rename(move.destination, move.source);
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
        await mutateWorkspaceCatalog(operation.workspaceRoot, 'renameProject', { name: operation.afterName, nextName: operation.beforeName, relativePath: path.relative(operation.workspaceRoot, operation.source) });
        response.project = { name: operation.beforeName, path: operation.source, status: operation.status, updatedAt: Date.now() };
      }
      return response;
    } catch (error) {
      if (operation && error.code !== 'RECYCLE_ITEM_MISSING') renameHistory.push(operation);
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-move-project', async (_event, workspacePath, currentStatus, projectName, nextStatus) => {
    try {
      if (!WORKSPACE_STATUSES.includes(nextStatus)) throw new Error('无效的项目状态');
      if (nextStatus === '未分类') throw new Error('未分类仅用于自动发现的新文件夹');
      const root = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(root)) await refreshWorkspaceCatalog(root);
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
      const catalog = await refreshWorkspaceCatalog(root);
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
    const publish = payload => {
      if (!event.sender.isDestroyed()) event.sender.send('workspace-file-operation-progress', { operationId, operation: 'trash', ...payload });
    };
    try {
      const projectPath = getProjectPath(workspacePath, status, projectName);
      if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
      publish({ phase: 'trashing', progress: 0, currentName: projectName, processedCount: 0, totalCount: 1 });
      const root = ensureWorkspace(workspacePath);
      const originalIdentity = await capturePathIdentity(projectPath);
      const recycled = await recycleBinService.trash(projectPath);
      const item = { original: projectPath, originalIdentity, recyclePidl: recycled.recyclePidl, preciseRestore: recycled.preciseRestore !== false };
      const projectCatalog = { name: projectName, status };
      const record = await workspaceRepository.addUndoRecord(root, { kind: 'trash', payload: { items: [item], projectCatalog } });
      await pushUndoOperation({ kind: 'trash', workspaceRoot: root, persistentId: record.id, items: [item], projectCatalog });
      await mutateWorkspaceCatalog(root, 'softDeleteProject', { name: projectName });
      publish({ phase: 'complete', progress: 100, currentName: projectName, processedCount: 1, totalCount: 1 });
      return { success: true, operationId };
    } catch (error) {
      publish({ phase: 'failed', progress: 0, currentName: projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), errorCode: error?.code || undefined };
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
  
  ipcMain.handle('workspace-browse-files', async (_event, workspacePath, status, projectName, relativePath = '', cacheConfig = {}) => {
    try {
      const projectPath = getProjectPath(workspacePath, status, projectName);
      const root = path.resolve(projectPath);
      const requestedPath = assertInside(root, path.resolve(root, relativePath || '.'), '文件夹路径', true);
      const currentPath = assertExistingInside(root, requestedPath, '文件夹路径', true);
      const currentStat = await fs.promises.stat(currentPath);
      if (!currentStat.isDirectory()) throw new Error('文件夹不存在');
      mediaRuntimeState.activeMediaCacheConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
      const directoryEntries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      const entries = directoryEntries
        .filter(entry => !entry.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(entry.name.toLowerCase()))
        .map(entry => {
          const entryPath = path.join(currentPath, entry.name);
          const extension = entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase();
          const kind = entry.isDirectory() ? 'folder' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          return { name: entry.name, path: entryPath, relativePath: path.relative(root, entryPath), kind, extension, size: -1, createdAt: 0, updatedAt: 0 };
        })
        .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      const directoryIndex = thumbnailService.indexDirectory(root, currentPath, entries, mediaRuntimeState.activeMediaCacheConfig);
      if (!relativePath) {
        void directoryIndex.then(indexed => indexed && thumbnailService.scanProject(root, mediaRuntimeState.activeMediaCacheConfig));
        scheduleMediaTrackingScan(ensureWorkspace(workspacePath), projectName);
      }
      return { success: true, path: path.relative(root, currentPath), entries };
    } catch (error) {
      writeLog('warn', 'Unable to browse project directory', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, missingDirectory: error?.code === 'ENOENT' || error?.code === 'ENOTDIR', error: error.message || String(error), entries: [] };
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
      pluginService.requireCapability('office-media.extract');
      const requestedPaths = Array.isArray(relativePaths) ? relativePaths.slice(0, 50) : [];
      if (!requestedPaths.length) throw new Error('没有选择 Office 文档');
      const targets = requestedPaths.map(relativePath => resolveProjectEntry(workspacePath, status, projectName, relativePath));
      for (const target of targets) {
        if (!fs.statSync(target).isFile() || !officeOpenXmlExtensions.has(path.extname(target).toLowerCase())) {
          throw new Error(`不支持此 Office 文件：${path.basename(target)}`);
        }
      }
      const args = ['extract', ...targets.flatMap(target => ['--input', target])];
      const result = await pluginService.runJson('office-media-extractor', args, 20 * 60 * 1000);
      if (!result?.success) throw new Error(result?.error || '提取图片失败');
      mainWindow?.webContents.send('workspace-files-changed', { root: getProjectPath(workspacePath, status, projectName), fileName: '' });
      return { ...result, results: Array.isArray(result.results) ? result.results : [] };
    } catch (error) {
      writeLog('warn', 'Office image extraction failed', { projectName, error: error.message || String(error) });
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
  
  ipcMain.handle('workspace-import-files', async (_event, workspacePath, status, projectName, relativePath = '', options = {}) => {
    const moves = [];
    const createdTargets = [];
    try {
      const { preserveOriginal = false } = options || {};
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const destinationDir = assertInside(projectPath, path.resolve(projectPath, relativePath || '.'), '导入位置', true);
      if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('当前文件夹不存在');
      const choice = await dialog.showOpenDialog(mainWindow, { title: '选择要导入的文件', properties: ['openFile', 'multiSelections'] });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0 };
      const reserved = new Set();
      for (const source of choice.filePaths) {
        const sourceInfo = await assertRegularFile(source);
        const destination = uniqueDestination(destinationDir, path.basename(sourceInfo.path), reserved);
        if (preserveOriginal) {
          await copyFileAtomic(sourceInfo.path, destination);
          createdTargets.push(destination);
        } else {
          await moveFileAtomic(sourceInfo.path, destination);
          moves.push({ source: sourceInfo.path, destination });
        }
      }
      if (preserveOriginal && createdTargets.length) await pushUndoOperation({ kind: 'remove-created', paths: createdTargets, label: '导入' });
      if (!preserveOriginal && moves.length) await pushUndoOperation({ kind: 'external-move', moves });
      writeLog('info', 'Files imported into current project directory', { projectName, relativePath, count: choice.filePaths.length, preserveOriginal });
      return { success: true, count: choice.filePaths.length };
    } catch (error) {
      for (const move of [...moves].reverse()) {
        try {
          if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) await moveFileAtomic(move.destination, move.source);
        } catch (rollbackError) {
          writeLog('error', 'Unable to roll back project file import', { move, error: rollbackError.message || String(rollbackError) });
        }
      }
      for (const target of createdTargets) await fs.promises.rm(target, { force: true }).catch(() => undefined);
      writeLog('error', 'Project file import failed', error);
      return { success: false, error: error.message || String(error) };
    }
  });
  
  ipcMain.handle('workspace-import-progress-files', async (_event, workspacePath, status, projectName, folderName, options = {}) => {
    let createdFolder = '';
    const createdTargets = [];
    const moves = [];
    try {
      const mediaKind = options.mediaKind === 'video' ? 'video' : 'image';
      const preserveOriginal = Boolean(options.preserveOriginal);
      const cleanedName = cleanProjectName(String(folderName || ''));
      if (!cleanedName) throw new Error('进度文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const destinationDir = path.resolve(projectPath, cleanedName);
      if (!destinationDir.startsWith(projectPath + path.sep)) throw new Error('无效的进度文件夹名称');
      if (fs.existsSync(destinationDir)) throw new Error('同名进度文件夹已存在');
      const extensions = mediaKind === 'video'
        ? [...VIDEO_EXTENSIONS].map(value => value.slice(1))
        : [...new Set([...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS])].map(value => value.slice(1));
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: mediaKind === 'video' ? '选择要导入的视频版本' : '选择要导入的图片版本',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: mediaKind === 'video' ? '视频文件' : '图片与 RAW', extensions }],
      });
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0 };
      const sourceInfos = [];
      for (const source of choice.filePaths) {
        const sourceInfo = await assertRegularFile(source);
        const extension = path.extname(sourceInfo.path).toLowerCase();
        const supported = mediaKind === 'video' ? VIDEO_EXTENSIONS.has(extension) : IMAGE_EXTENSIONS.has(extension) || RAW_EXTENSIONS.has(extension);
        if (!supported) throw new Error(`所选文件不属于${mediaKind === 'video' ? '视频' : '图片'}进度：${path.basename(sourceInfo.path)}`);
        sourceInfos.push(sourceInfo);
      }
      await fs.promises.mkdir(destinationDir);
      createdFolder = destinationDir;
      const reserved = new Set();
      for (const sourceInfo of sourceInfos) {
        const destination = uniqueDestination(destinationDir, path.basename(sourceInfo.path), reserved);
        if (preserveOriginal) {
          await copyFileAtomic(sourceInfo.path, destination);
          createdTargets.push(destination);
        } else {
          await moveFileAtomic(sourceInfo.path, destination);
          moves.push({ source: sourceInfo.path, destination });
        }
      }
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const registered = await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind,
        versionKey: options.versionKey,
        parentProgressId: options.parentProgressId,
        displayName: cleanedName,
        folderPath: destinationDir,
        trackingEnabled: Boolean(options.trackingEnabled),
      });
      if (preserveOriginal) await pushUndoOperation({ kind: 'remove-created', paths: [destinationDir], label: '导入版本进度' });
      else if (moves.length) await pushUndoOperation({ kind: 'external-move', moves });
      writeLog('info', 'Progress version files imported', { projectName, folderName: cleanedName, mediaKind, count: choice.filePaths.length, preserveOriginal });
      return {
        success: true,
        count: choice.filePaths.length,
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
      writeLog('error', 'Progress version import failed', { projectName, folderName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });
};

module.exports = { registerWorkspaceIpc };
