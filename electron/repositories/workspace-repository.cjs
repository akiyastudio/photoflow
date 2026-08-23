const createWorkspaceRepository = (client, operationsRepository = null) => ({
  load: async root => {
    const catalog = await client.call(root, 'init');
    return catalog;
  },
  syncCatalog: root => client.call(root, 'catalog_sync', {}),
  runMaintenance: root => client.call(root, 'maintenance_run', {}),
  addProject: (root, payload) => client.call(root, 'add', payload),
  renameProject: (root, payload) => client.call(root, 'rename', payload),
  setProjectStatus: (root, payload) => client.call(root, 'status', payload),
  archiveProject: (root, payload) => client.call(root, 'archive_project', payload),
  unarchiveProject: (root, payload) => client.call(root, 'unarchive_project', payload),
  softDeleteProject: (root, payload) => client.call(root, 'delete', payload),
  restoreProject: (root, payload) => client.call(root, 'restore_project', payload),
  listDeletedProjects: async root => client.call(root, 'deleted_projects_list', operationsRepository
    ? { undoRecords: (await operationsRepository.listUndoRecords(root)).records }
    : {}),
  getDeletedProjectCleanupPlan: async (root, projectId) => client.call(root, 'deleted_project_cleanup_plan', {
    projectId,
    ...(operationsRepository ? { undoRecords: (await operationsRepository.listUndoRecords(root)).records } : {}),
  }),
  purgeDeletedProject: async (root, projectId) => {
    const result = await client.call(root, 'purge_deleted_project', {
      projectId,
      ...(operationsRepository ? { undoRecords: (await operationsRepository.listUndoRecords(root)).records } : {}),
    });
    if (operationsRepository && result.removedUndoIds?.length) await operationsRepository.removeUndoRecords(root, result.removedUndoIds);
    return result;
  },
  purgeMissingProject: async (root, name) => {
    const result = await client.call(root, 'purge_missing_project', {
      name,
      ...(operationsRepository ? { undoRecords: (await operationsRepository.listUndoRecords(root)).records } : {}),
    });
    if (operationsRepository && result.removedUndoIds?.length) await operationsRepository.removeUndoRecords(root, result.removedUndoIds);
    return result;
  },
  listMissingProjects: (root, missingBefore) => client.call(root, 'missing_projects_list', { missingBefore }),
  addUndoRecord: (root, payload) => operationsRepository
    ? operationsRepository.addUndoRecord(root, payload)
    : client.call(root, 'undo_record_add', payload),
  latestUndoRecord: root => operationsRepository
    ? operationsRepository.latestUndoRecord(root)
    : client.call(root, 'undo_record_latest', {}),
  removeUndoRecord: (root, id) => operationsRepository
    ? operationsRepository.removeUndoRecord(root, id)
    : client.call(root, 'undo_record_remove', { id }),
  markUndoRecordUnavailable: (root, id) => operationsRepository
    ? operationsRepository.markUndoRecordUnavailable(root, id)
    : client.call(root, 'undo_record_mark_unavailable', { id }),
  stop: () => client.stop(),
});

module.exports = { createWorkspaceRepository };
