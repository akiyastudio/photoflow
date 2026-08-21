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


def migration_28(db, table_columns):
    """Journal tracking copies and serialize progress-tree filesystem mutations."""
    del table_columns
    # Catalog-only startup deliberately leaves the optional versioning store
    # detached. Inspect every attached schema so the migration can be rerun
    # safely when that domain is opened by its first caller.
    migrated = False
    for schema in [row[1] for row in db.execute("PRAGMA database_list").fetchall()]:
        columns = {row[1] for row in db.execute(f'PRAGMA "{schema}".table_info("tracking_sessions")').fetchall()}
        if columns and "copy_operations_json" not in columns:
            db.execute(
                f'ALTER TABLE "{schema}"."tracking_sessions" ADD COLUMN copy_operations_json '
                "TEXT NOT NULL DEFAULT '[]'"
            )
            migrated = True
    return migrated
