const path = require('path');

// These actions use workspace_db.connect_read_only and attach initialized
// domain stores with mode=ro; keep this allowlist limited to audited queries.
const CONFIRMED_READ_ACTIONS = new Set([
  'progress_snapshot', 'media_versions_snapshot', 'tracking_session_get',
  'tracking_commit_resources', 'media_sync_prepare', 'progress_stale_prepare',
]);

const IDEMPOTENT_ACTIONS = new Set([
  'progress_snapshot', 'progress_locations_snapshot', 'tracking_session_get', 'tracking_commit_resources', 'version_tree_layout_get',
  'media_sync_prepare', 'media_sync_paths_prepare', 'progress_stale_prepare',
  'maintenance_run', 'media_sync_apply_batch', 'media_sync_finalize',
  'media_sync_paths_apply_batch', 'media_sync_paths_finalize', 'progress_stale_apply',
]);
const VERSIONING_ONLY_ACTIONS = new Set(['batch_list', 'progress_snapshot', 'progress_locations_snapshot', 'version_graph_edge_list', 'version_tree_layout_get', 'version_tree_layout_save']);

const domainDatabasePath = (database, domain) => {
  const absolute = path.resolve(database);
  const workspaceKey = path.parse(absolute).name;
  return path.join(path.dirname(absolute), workspaceKey, 'databases', `${domain}.sqlite3`);
};

class WorkspaceDatabaseOperationPolicy {
  classify({ database, action, payload = {}, scriptName = 'workspace_db.py' }) {
    const mode = action === 'maintenance_run' ? 'exclusive' : CONFIRMED_READ_ACTIONS.has(action) ? 'read' : 'write';
    const databases = [{ path: database, mode }];

    if (scriptName === 'operations_db.py') {
      if (payload.legacyDatabase) databases.push({ path: payload.legacyDatabase, mode: 'write' });
    } else if (scriptName === 'workspace_db.py') {
      const needsRetiredProjectCleanup = action === 'add';
      const needsDomains = action === 'maintenance_run' || VERSIONING_ONLY_ACTIONS.has(action)
        || /^(media_|progress_|batch_|tracking_|version_)/.test(action)
        || ['deleted_projects_list', 'deleted_project_cleanup_plan', 'purge_deleted_project', 'purge_missing_project'].includes(action)
        || needsRetiredProjectCleanup;
      if (needsDomains) databases.push({ path: domainDatabasePath(database, 'versioning'), mode });
      if (needsDomains && !VERSIONING_ONLY_ACTIONS.has(action)) databases.push({ path: domainDatabasePath(database, 'media'), mode });
    }

    return { databases, idempotent: IDEMPOTENT_ACTIONS.has(action), mode };
  }
}

module.exports = { WorkspaceDatabaseOperationPolicy, CONFIRMED_READ_ACTIONS, IDEMPOTENT_ACTIONS, domainDatabasePath };
