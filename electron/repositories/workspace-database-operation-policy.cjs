const path = require('path');

// workspace_db currently attaches domain stores through a helper that verifies
// and updates domain schema metadata. Until that attachment path is genuinely
// query-only, even logically read-only actions must take the writer lease.
const CONFIRMED_READ_ACTIONS = new Set();

const IDEMPOTENT_ACTIONS = new Set([
  'progress_snapshot', 'tracking_session_get', 'tracking_commit_resources', 'version_tree_layout_get',
  'media_sync_prepare', 'media_sync_paths_prepare', 'progress_stale_prepare',
  'maintenance_run', 'media_sync_apply_batch', 'media_sync_finalize',
  'media_sync_paths_apply_batch', 'media_sync_paths_finalize', 'progress_stale_apply',
]);
const VERSIONING_ONLY_ACTIONS = new Set(['batch_list', 'progress_snapshot', 'version_graph_edge_list', 'version_tree_layout_get', 'version_tree_layout_save']);

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
      if (action === 'init' && payload.legacyDatabase) databases.push({ path: payload.legacyDatabase, mode: 'read' });
    } else if (scriptName === 'workspace_db.py') {
      const needsDomains = action === 'maintenance_run' || VERSIONING_ONLY_ACTIONS.has(action)
        || /^(media_|progress_|batch_|tracking_|version_)/.test(action)
        || ['deleted_projects_list', 'deleted_project_cleanup_plan', 'purge_deleted_project', 'purge_missing_project'].includes(action);
      if (needsDomains) databases.push({ path: domainDatabasePath(database, 'versioning'), mode });
      if (needsDomains && !VERSIONING_ONLY_ACTIONS.has(action)) databases.push({ path: domainDatabasePath(database, 'media'), mode });
    }

    return { databases, idempotent: IDEMPOTENT_ACTIONS.has(action), mode };
  }
}

module.exports = { WorkspaceDatabaseOperationPolicy, CONFIRMED_READ_ACTIONS, IDEMPOTENT_ACTIONS, domainDatabasePath };
