"""Stable workspace database action catalog grouped by application domain."""

CATALOG_ACTIONS = (
    "catalog_sync", "maintenance_run", "add", "status", "archive_project", "unarchive_project",
    "rename", "delete", "restore_project", "deleted_projects_list", "deleted_project_cleanup_plan",
    "purge_deleted_project", "missing_projects_list", "purge_missing_project",
)
MEDIA_ACTIONS = (
    "media_sync_project", "media_get", "media_get_photo", "media_create_version", "media_update_version",
    "media_refresh_metadata_fingerprint", "final_version_list", "media_set_thumbnail", "media_relocate_version",
    "media_delete_version", "media_version_delete_scope", "media_delete_project_missing_version", "media_record_compare",
    "media_workflow_import_commit",
)
PROGRESS_ACTIONS = (
    "batch_list", "progress_list", "progress_snapshot", "progress_register", "progress_register_with_graph",
    "progress_adopt_media", "progress_revert_external_adoptions", "progress_update_tree", "progress_relation_update", "progress_legacy_selection_repair",
    "version_graph_edge_create", "version_graph_edge_list", "version_graph_edge_delete", "version_graph_edge_replace_source",
    "version_tree_layout_get", "version_tree_layout_save", "progress_policy_save", "progress_mark_stale",
    "progress_mark_ready", "progress_main_branch", "progress_visible_relations", "progress_copy_missing_children",
    "progress_detect_stale", "progress_main_branch_media", "progress_unregister", "progress_delete_missing", "batch_register_baseline",
    "batch_commit_compare", "batch_operation_list", "batch_retry_operations",
)
TRACKING_ACTIONS = (
    "tracking_session_create", "tracking_prepare", "tracking_store_preview", "tracking_session_get",
    "tracking_session_release", "tracking_session_decide", "tracking_commit_plan", "tracking_commit_complete",
    "tracking_commit_failed",
)
TEAM_ACTIONS = (
    "team_patch_list", "team_project_workspace", "team_project_register_photo", "team_project_unregister_photo",
    "team_identity_save", "team_identity_assign", "team_identity_confirm_group", "team_identity_complete",
    "team_identity_delete", "team_person_exclusion_list", "team_person_exclusion_add", "team_person_exclusion_clear",
    "team_patch_replace", "team_patch_update", "team_patch_delete", "team_patch_cleanup", "team_project_purge",
)
UNDO_ACTIONS = ("undo_record_add", "undo_record_latest", "undo_record_remove", "undo_record_mark_unavailable")

ALL_ACTIONS = ("init", *CATALOG_ACTIONS, *MEDIA_ACTIONS, *PROGRESS_ACTIONS, *TRACKING_ACTIONS, *TEAM_ACTIONS, *UNDO_ACTIONS)
READ_ONLY_ACTIONS = frozenset(("progress_snapshot", "tracking_session_get", "version_tree_layout_get"))

if len(ALL_ACTIONS) != len(set(ALL_ACTIONS)):
    raise RuntimeError("workspace database action catalog contains duplicates")
