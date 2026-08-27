const { MAX_CHANGED_PATHS } = require('../contracts/media-sync-limits.cjs');

const MEDIA_SYNC_BATCH_SIZE = 64;

const createMediaRepository = client => {
  const prepareMediaSync = (root, projectName, externalRoots = []) => client.call(root, 'media_sync_prepare', { projectName, externalRoots }, 30 * 60 * 1000);
  const applyMediaSyncBatch = (root, payload) => client.call(root, 'media_sync_apply_batch', payload, 2 * 60 * 1000);
  const finalizeMediaSync = (root, payload) => client.call(root, 'media_sync_finalize', payload, 2 * 60 * 1000);
  const prepareChangedPaths = (root, payload) => client.call(root, 'media_sync_paths_prepare', payload, 30 * 60 * 1000);
  const applyChangedPathsBatch = (root, payload) => client.call(root, 'media_sync_paths_apply_batch', payload, 2 * 60 * 1000);
  const finalizeChangedPaths = (root, payload) => client.call(root, 'media_sync_paths_finalize', payload, 2 * 60 * 1000);
  const syncProject = async (root, projectName, externalRoots = []) => {
    const prepared = await prepareMediaSync(root, projectName, externalRoots);
    if (prepared.projectUnavailable) return prepared;
    let count = 0;
    for (let offset = 0, batchIndex = 0; offset < prepared.files.length; offset += MEDIA_SYNC_BATCH_SIZE, batchIndex += 1) {
      const applied = await applyMediaSyncBatch(root, {
        projectName,
        snapshotId: prepared.snapshotId,
        batchIndex,
        authorizedRoots: prepared.authorizedRoots,
        files: prepared.files.slice(offset, offset + MEDIA_SYNC_BATCH_SIZE),
      });
      count += Number(applied.count) || 0;
      // The physical writer lease was released when the action returned. Yield
      // before rejoining the coordinator so queued interactive writes can run.
      await new Promise(resolve => setImmediate(resolve));
    }
    const finalized = await finalizeMediaSync(root, {
      projectName,
      snapshotId: prepared.snapshotId,
      authorizedRoots: prepared.authorizedRoots,
      files: prepared.files,
      baselineVersions: prepared.baselineVersions,
    });
    return { ...finalized, count };
  };
  const syncChangedPaths = async (root, projectName, changes, externalRoots = [], options = {}) => {
    if (!Array.isArray(changes) || changes.length > MAX_CHANGED_PATHS) throw new Error(`media_sync_paths_limit: 增量路径最多 ${MAX_CHANGED_PATHS} 条`);
    const normalizedChanges = changes.map(change => typeof change === 'string'
      ? { path: change, eventType: 'rename', kind: 'missing' }
      : { ...change, path: String(change?.path || '') });
    const prepared = await prepareChangedPaths(root, {
      projectName, changes: normalizedChanges, externalRoots,
      ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
    });
    let count = 0;
    for (let offset = 0, batchIndex = 0; offset < prepared.files.length; offset += MEDIA_SYNC_BATCH_SIZE, batchIndex += 1) {
      const applied = await applyChangedPathsBatch(root, {
        projectName, snapshotId: prepared.snapshotId, batchIndex,
        files: prepared.files.slice(offset, offset + MEDIA_SYNC_BATCH_SIZE),
      });
      count += Number(applied.count) || 0;
      await new Promise(resolve => setImmediate(resolve));
    }
    const finalized = await finalizeChangedPaths(root, {
      projectName, snapshotId: prepared.snapshotId,
    });
    return { ...finalized, count };
  };

  const prepareProgressStale = (root, payload) => client.call(root, 'progress_stale_prepare', payload, 30 * 60 * 1000);
  const applyProgressStale = (root, payload) => client.call(root, 'progress_stale_apply', payload);
  const detectProgressStale = async (root, payload) => {
    for (let revisionAttempt = 0; revisionAttempt < 5; revisionAttempt += 1) {
      const prepared = await prepareProgressStale(root, payload);
      if (!prepared.candidates.length) return prepared;
      const applied = await applyProgressStale(root, {
        projectName: payload.projectName,
        snapshotId: prepared.snapshotId,
        revision: prepared.revision,
        candidates: prepared.candidates,
        scannedProgressIds: prepared.scannedProgressIds,
        propagatedProgressIds: prepared.propagatedProgressIds,
      });
      if (!applied.revisionExpired) return applied;
      await new Promise(resolve => setImmediate(resolve));
    }
    const error = new Error('progress_stale_revision_busy: 版本状态持续变化，请稍后重试');
    error.code = 'PROGRESS_STALE_REVISION_BUSY';
    throw error;
  };

  return ({
  syncProject,
  syncChangedPaths,
  prepareMediaSync,
  applyMediaSyncBatch,
  finalizeMediaSync,
  prepareChangedPaths,
  applyChangedPathsBatch,
  finalizeChangedPaths,
  setThumbnail: (root, payload) => client.call(root, 'media_set_thumbnail', payload),
  getMedia: (root, payload) => client.call(root, 'media_get', payload),
  snapshotProjectVersions: (root, payload) => client.call(root, 'media_versions_snapshot', payload),
  getPhoto: (root, photoId) => client.call(root, 'media_get_photo', { photoId }),
  createVersion: (root, payload) => client.call(root, 'media_create_version', payload),
  updateVersion: (root, payload) => client.call(root, 'media_update_version', payload),
  componentUpdateVersion: (root, payload) => client.call(root, 'media_component_update_version', payload),
  componentDeleteVersion: (root, payload) => client.call(root, 'media_component_delete_version', payload),
  refreshMetadataFingerprint: (root, payload) => client.call(root, 'media_refresh_metadata_fingerprint', payload),
  listFinalVersions: (root, projectName) => client.call(root, 'final_version_list', { projectName }),
  relocateVersion: (root, payload) => client.call(root, 'media_relocate_version', payload),
  deleteVersion: (root, versionId) => client.call(root, 'media_delete_version', { versionId }),
  getVersionDeleteScope: (root, versionId) => client.call(root, 'media_version_delete_scope', { versionId }),
  deleteProjectMissingVersion: (root, versionId) => client.call(root, 'media_delete_project_missing_version', { versionId }),
  recordCompare: (root, payload) => client.call(root, 'media_record_compare', payload),
  listProgress: (root, projectName, includeMissing = false) => client.call(root, 'progress_list', { projectName, includeMissing }),
  snapshotProgress: (root, projectName, includeMissing = false) => client.call(root, 'progress_snapshot', { projectName, includeMissing }),
  snapshotProgressLocations: (root, projectName, includeMissing = false) => client.call(root, 'progress_locations_snapshot', { projectName, includeMissing }),
  registerProgress: (root, payload) => client.call(root, 'progress_register', payload),
  registerProgressWithGraph: (root, payload) => client.call(root, 'progress_register_with_graph', payload),
  adoptMediaFolder: (root, payload) => client.call(root, 'progress_adopt_media', payload),
  revertExternalAdoptions: (root, payload) => client.call(root, 'progress_revert_external_adoptions', payload),
  updateProgressTree: (root, payload) => client.call(root, 'progress_update_tree', payload),
  beginProgressTreeUpdate: (root, payload) => client.call(root, 'progress_update_tree_begin', payload),
  finishProgressTreeUpdate: (root, payload) => client.call(root, 'progress_update_tree_finish', payload),
  renameProgressFolder: (root, payload) => client.call(root, 'progress_folder_rename', payload),
  renameExternalProgressLinkRoute: (root, payload) => client.call(root, 'progress_external_link_route_rename', payload),
  updateProgressRelation: (root, payload) => client.call(root, 'progress_relation_update', payload),
  repairLegacySelectionRelation: (root, payload) => client.call(root, 'progress_legacy_selection_repair', payload),
  commitImportGraph: (root, payload) => client.call(root, 'media_workflow_import_commit', payload),
  createVersionGraphEdge: (root, payload) => client.call(root, 'version_graph_edge_create', payload),
  deleteVersionGraphEdge: (root, payload) => client.call(root, 'version_graph_edge_delete', payload),
  replaceVersionGraphEdgeSource: (root, payload) => client.call(root, 'version_graph_edge_replace_source', payload),
  getVersionTreeLayout: (root, payload) => client.call(root, 'version_tree_layout_get', payload),
  saveVersionTreeLayout: (root, payload) => client.call(root, 'version_tree_layout_save', payload),
  unregisterProgress: (root, payload) => client.call(root, 'progress_unregister', payload),
  componentManageProgress: (root, payload) => client.call(root, 'progress_component_manage', payload),
  deleteMissingProgress: (root, payload) => client.call(root, 'progress_delete_missing', payload),
  registerBatchBaseline: (root, payload) => client.call(root, 'batch_register_baseline', payload),
  commitBatchCompare: (root, payload) => client.call(root, 'batch_commit_compare', payload),
  listBatchOperations: (root, batchId) => client.call(root, 'batch_operation_list', { batchId }),
  retryBatchOperations: (root, batchId) => client.call(root, 'batch_retry_operations', { batchId }),
  detectProgressStale,
  prepareProgressStale,
  applyProgressStale,
  createTrackingSession: (root, payload) => client.call(root, 'tracking_session_create', payload),
  prepareTracking: (root, payload) => client.call(root, 'tracking_prepare', payload, 30 * 60 * 1000),
  storeTrackingPreview: (root, payload) => client.call(root, 'tracking_store_preview', payload, 60 * 1000),
  getTrackingSession: (root, payload) => client.call(root, 'tracking_session_get', payload),
  releaseTrackingSession: (root, sessionId) => client.call(root, 'tracking_session_release', { sessionId }),
  decideTrackingItem: (root, payload) => client.call(root, 'tracking_session_decide', payload),
  getTrackingCommitPlan: (root, sessionId) => client.call(root, 'tracking_commit_plan', { sessionId }),
  getTrackingCommitResources: (root, sessionId) => client.call(root, 'tracking_commit_resources', { sessionId }),
  applyTrackingCopies: (root, sessionId) => client.call(root, 'tracking_apply_copies', { sessionId }, 30 * 60 * 1000),
  // Legacy in-flight sessions may not have a prepared snapshot and must fall
  // back to fingerprinting both folders. Keep that compatibility path bounded
  // as a long disk operation instead of killing the database worker at 60s.
  completeTrackingCommit: (root, payload) => client.call(root, 'tracking_commit_complete', payload, 30 * 60 * 1000),
  failTrackingCommit: (root, payload) => client.call(root, 'tracking_commit_failed', payload),
  getMainBranchMedia: (root, payload) => client.call(root, 'progress_main_branch_media', payload),
  stop: () => client.stop(),
  });
};

module.exports = { createMediaRepository, MEDIA_SYNC_BATCH_SIZE };
