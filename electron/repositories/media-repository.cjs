const createMediaRepository = client => ({
  syncProject: (root, projectName) => client.call(root, 'media_sync_project', { projectName }),
  setThumbnail: (root, payload) => client.call(root, 'media_set_thumbnail', payload),
  getMedia: (root, payload) => client.call(root, 'media_get', payload),
  getPhoto: (root, photoId) => client.call(root, 'media_get_photo', { photoId }),
  createVersion: (root, payload) => client.call(root, 'media_create_version', payload),
  updateVersion: (root, payload) => client.call(root, 'media_update_version', payload),
  listFinalVersions: (root, projectName) => client.call(root, 'final_version_list', { projectName }),
  relocateVersion: (root, payload) => client.call(root, 'media_relocate_version', payload),
  deleteVersion: (root, versionId) => client.call(root, 'media_delete_version', { versionId }),
  recordCompare: (root, payload) => client.call(root, 'media_record_compare', payload),
  listProgress: (root, projectName) => client.call(root, 'progress_list', { projectName }),
  registerProgress: (root, payload) => client.call(root, 'progress_register', payload),
  registerBatchBaseline: (root, payload) => client.call(root, 'batch_register_baseline', payload),
  commitBatchCompare: (root, payload) => client.call(root, 'batch_commit_compare', payload),
  listTeamPatches: (root, photoId) => client.call(root, 'team_patch_list', { photoId }),
  replaceTeamPatches: (root, payload) => client.call(root, 'team_patch_replace', payload),
  updateTeamPatch: (root, payload) => client.call(root, 'team_patch_update', payload),
  stop: () => client.stop(),
});

module.exports = { createMediaRepository };
