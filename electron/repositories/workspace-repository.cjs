const createWorkspaceRepository = client => ({
  load: root => client.call(root, 'init'),
  addProject: (root, payload) => client.call(root, 'add', payload),
  renameProject: (root, payload) => client.call(root, 'rename', payload),
  setProjectStatus: (root, payload) => client.call(root, 'status', payload),
  softDeleteProject: (root, payload) => client.call(root, 'delete', payload),
  restoreProject: (root, payload) => client.call(root, 'restore_project', payload),
  addUndoRecord: (root, payload) => client.call(root, 'undo_record_add', payload),
  latestUndoRecord: root => client.call(root, 'undo_record_latest', {}),
  removeUndoRecord: (root, id) => client.call(root, 'undo_record_remove', { id }),
  markUndoRecordUnavailable: (root, id) => client.call(root, 'undo_record_mark_unavailable', { id }),
  stop: () => client.stop(),
});

module.exports = { createWorkspaceRepository };
