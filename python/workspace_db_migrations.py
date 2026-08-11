"""Small, dependency-free migration helpers shared by the workspace database worker."""


def migration_26(db, table_columns):
    """Cache prepared tracking snapshots so commit finalization never rescans whole folders."""
    columns = table_columns(db, "tracking_sessions")
    if "prepared_files_snapshot_json" not in columns:
        db.execute("ALTER TABLE tracking_sessions ADD COLUMN prepared_files_snapshot_json TEXT")
    if "prepared_parent_snapshot_json" not in columns:
        db.execute("ALTER TABLE tracking_sessions ADD COLUMN prepared_parent_snapshot_json TEXT")
