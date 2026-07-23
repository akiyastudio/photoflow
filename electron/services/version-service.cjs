const createVersionService = ({ repository }) => ({
  syncProject: (root, projectName) => repository.syncProject(root, projectName),
  setThumbnail: (root, payload) => repository.setThumbnail(root, payload),
  getMedia: (root, payload) => repository.getMedia(root, payload),
  getPhoto: (root, photoId) => repository.getPhoto(root, photoId),
  createVersion: (root, payload) => repository.createVersion(root, payload),
  updateVersion: (root, payload) => repository.updateVersion(root, payload),
  listFinalVersions: (root, projectName) => repository.listFinalVersions(root, projectName),
  relocateVersion: (root, payload) => repository.relocateVersion(root, payload),
  deleteVersion: (root, versionId) => repository.deleteVersion(root, versionId),
  getVersionDeleteScope: (root, versionId) => repository.getVersionDeleteScope(root, versionId),
  deleteProjectMissingVersion: (root, versionId) => repository.deleteProjectMissingVersion(root, versionId),
  recordCompare: (root, payload) => repository.recordCompare(root, payload),
  listProgress: (root, projectName) => repository.listProgress(root, projectName),
  registerProgress: (root, payload) => repository.registerProgress(root, payload),
  registerBatchBaseline: (root, payload) => repository.registerBatchBaseline(root, payload),
  commitBatchCompare: (root, payload) => repository.commitBatchCompare(root, payload),
  listTeamPatches: (root, photoId) => repository.listTeamPatches(root, photoId),
  replaceTeamPatches: (root, payload) => repository.replaceTeamPatches(root, payload),
  updateTeamPatch: (root, payload) => repository.updateTeamPatch(root, payload),
  cleanupTeamPatches: (root, payload) => repository.cleanupTeamPatches(root, payload),
});

module.exports = { createVersionService };
