const createDeletedProjectCleanup = ({
  backgroundTasks, fs, getWorkspaceDataRoot, path, pathExists, recycleBinService,
  renameHistory, setTimeout, thumbnailService, workspaceRepository, writeLog,
}) => {
  const inspectDeletedProject = async (root, project, prefetchedProbe = null) => {
    const originalPath = path.resolve(root, project.relativePath);
    const relative = path.relative(root, originalPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ...project, originalPath, recycleStatus: 'unknown', statusDetail: '项目原路径无效，已保留数据' };
    }
    if (await pathExists(originalPath)) return { ...project, originalPath, recycleStatus: 'restored', statusDetail: '原项目路径已重新出现' };
    if (project.permanent) return { ...project, originalPath, recycleStatus: 'missing', statusDetail: '项目已由 Windows 永久删除' };
    if (!project.recyclePidl || !recycleBinService.nativeAvailable()) {
      return { ...project, originalPath, recycleStatus: 'unknown', statusDetail: '当前无法可靠检查系统回收站，已保留数据' };
    }
    try {
      const probe = prefetchedProbe || await recycleBinService.probe(project.recyclePidl);
      if (probe.success === false || probe.error) throw new Error(probe.error || '无法检查回收站项目');
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
      ...(purgeResult.photoIds || []).map(photoId => path.join(dataRoot, 'thumbnails', photoId)),
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
    await thumbnailService.evictCache({ sourcePaths: cleanupPlan.sourcePaths || [] }).catch(error => {
      writeLog('warn', 'Unable to clear deleted project thumbnail cache', { project: project.name, error: error.message || String(error) });
    });
    task?.report(80, `正在完成“${project.name}”的数据清理`);
    const purgeResult = await workspaceRepository.purgeDeletedProject(root, project.id);
    for (let index = renameHistory.length - 1; index >= 0; index -= 1) {
      const operation = renameHistory[index];
      if (operation.projectCatalog?.name?.toLocaleLowerCase() === project.name.toLocaleLowerCase()
        || (purgeResult.removedUndoIds || []).includes(operation.persistentId)) renameHistory.splice(index, 1);
    }
    writeLog('info', 'Purged unavailable deleted project data', { root, project: project.name, photoCount: purgeResult.photoIds?.length || 0, removedArtifactCount });
    return { removedArtifactCount, purgeResult };
  };

  const purgeConfirmedDeletedProject = async (root, project, prefetchedProbe = null) => {
    const inspected = await inspectDeletedProject(root, project, prefetchedProbe);
    if (inspected.recycleStatus !== 'missing') return { cleaned: false, status: inspected.recycleStatus };
    const { removedArtifactCount } = await purgeDeletedProjectData(root, project);
    return { cleaned: true, status: 'missing', removedArtifactCount };
  };

  const purgeStaleMissingProject = async (root, project) => {
    const purgeResult = await workspaceRepository.purgeMissingProject(root, project.name);
    const removedArtifactCount = await removeInternalProjectArtifacts(root, purgeResult);
    await thumbnailService.evictCache({ sourcePaths: purgeResult.sourcePaths || [] }).catch(error => {
      writeLog('warn', 'Unable to clear stale offline project thumbnails', { projectName: project.name, error: error.message || String(error) });
    });
    writeLog('info', 'Purged stale offline project data', { root, projectName: project.name, removedArtifactCount });
    return { cleaned: true, status: 'missing', removedArtifactCount };
  };

  const runPermanentProjectCleanup = (root, projectName, restartTask = null) => backgroundTasks.run({
    ...(restartTask?.id ? { id: restartTask.id } : {}),
    type: 'deleted-project-cleanup', title: `清理已永久删除项目：${projectName}`,
    dedupeKey: `deleted-project-cleanup:${root}:${projectName.toLocaleLowerCase()}`,
    cancellable: false, metadata: { root, projectName },
  }, async task => {
    const deleted = await workspaceRepository.listDeletedProjects(root);
    const project = (deleted.projects || []).find(item => item.name.toLocaleLowerCase() === projectName.toLocaleLowerCase());
    return project ? purgeDeletedProjectData(root, project, task) : { skipped: true };
  });

  const queuePermanentProjectCleanup = (root, projectName) => {
    setTimeout(() => void runPermanentProjectCleanup(root, projectName).catch(error => {
      writeLog('warn', 'Permanent project cleanup deferred until a later startup', { root, project: projectName, error: error.message || String(error) });
    }), 15000);
  };

  backgroundTasks?.registerTypeRestartFactory?.('deleted-project-cleanup', task => runPermanentProjectCleanup(task.metadata?.root, task.metadata?.projectName, task));
  return { inspectDeletedProject, purgeConfirmedDeletedProject, purgeStaleMissingProject, queuePermanentProjectCleanup };
};

module.exports = { createDeletedProjectCleanup };
