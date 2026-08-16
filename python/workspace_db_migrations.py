"""Small, dependency-free migration helpers shared by the workspace database worker."""


def migration_26(db, table_columns):
    """Cache prepared tracking snapshots so commit finalization never rescans whole folders."""
    columns = table_columns(db, "tracking_sessions")
    if "prepared_files_snapshot_json" not in columns:
        db.execute("ALTER TABLE tracking_sessions ADD COLUMN prepared_files_snapshot_json TEXT")
    if "prepared_parent_snapshot_json" not in columns:
        db.execute("ALTER TABLE tracking_sessions ADD COLUMN prepared_parent_snapshot_json TEXT")


def migration_27(db, table_columns):
    """Persist the trusted project-relative route for externally linked version folders."""
    columns = table_columns(db, "progress_folders")
    if "external_link_relative_path" not in columns:
        db.execute("ALTER TABLE progress_folders ADD COLUMN external_link_relative_path TEXT")
    db.execute(
        "CREATE INDEX IF NOT EXISTS progress_folders_external_link "
        "ON progress_folders(project_id, external_link_relative_path)"
    )
