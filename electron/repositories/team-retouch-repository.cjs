const createTeamRetouchRepository = client => ({
  listTeamPatches: (root, photoId) => client.call(root, 'team_patch_list', { photoId }),
  getTeamProjectWorkspace: (root, projectName) => client.call(root, 'team_project_workspace', { projectName }, 60 * 1000),
  registerTeamProjectPhoto: (root, payload) => client.call(root, 'team_project_register_photo', payload),
  unregisterTeamProjectPhoto: (root, payload) => client.call(root, 'team_project_unregister_photo', payload),
  saveTeamIdentity: (root, payload) => client.call(root, 'team_identity_save', payload),
  assignTeamIdentity: (root, payload) => client.call(root, 'team_identity_assign', payload),
  confirmTeamIdentityGroup: (root, payload) => client.call(root, 'team_identity_confirm_group', payload),
  completeTeamIdentity: (root, payload) => client.call(root, 'team_identity_complete', payload),
  deleteTeamIdentity: (root, payload) => client.call(root, 'team_identity_delete', payload),
  listTeamPersonExclusions: (root, payload) => client.call(root, 'team_person_exclusion_list', payload),
  addTeamPersonExclusion: (root, payload) => client.call(root, 'team_person_exclusion_add', payload),
  clearTeamPersonExclusions: (root, payload) => client.call(root, 'team_person_exclusion_clear', payload),
  replaceTeamPatches: (root, payload) => client.call(root, 'team_patch_replace', payload),
  updateTeamPatch: (root, payload) => client.call(root, 'team_patch_update', payload),
  deleteTeamPatch: (root, payload) => client.call(root, 'team_patch_delete', payload),
  cleanupTeamPatches: (root, payload) => client.call(root, 'team_patch_cleanup', payload),
  purgeTeamProject: (root, payload) => client.call(root, 'team_project_purge', payload),
  stop: () => client.stop(),
});

module.exports = { createTeamRetouchRepository };
