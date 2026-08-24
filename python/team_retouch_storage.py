"""Physical SQLite storage for the team-retouch bounded context."""

import os
import sqlite3
import uuid
from pathlib import Path


SCHEMA_VERSION = 1
TABLES = (
    "team_patch_tasks",
    "team_retouch_photos",
    "team_person_identities",
    "team_person_assignments",
    "team_person_exclusions",
)


def _legacy_tables(workspace_db: sqlite3.Connection) -> set[str]:
    return {
        row[0] for row in workspace_db.execute(
            "SELECT name FROM main.sqlite_master WHERE type='table' AND name LIKE 'team_%'"
        ).fetchall()
        if row[0] in TABLES
    }


def _drop_legacy_tables(workspace_db: sqlite3.Connection, tables) -> bool:
    requested = set(tables)
    ordered = [table for table in reversed(TABLES) if table in requested]
    if not ordered:
        return False
    if workspace_db.in_transaction:
        raise RuntimeError("cannot retire legacy team tables inside a transaction")
    foreign_keys_enabled = int(workspace_db.execute("PRAGMA foreign_keys").fetchone()[0])
    workspace_db.execute("PRAGMA foreign_keys=OFF")
    try:
        workspace_db.execute("BEGIN IMMEDIATE")
        for table in ordered:
            workspace_db.execute(f'DROP TABLE IF EXISTS main."{table}"')
        workspace_db.commit()
    except Exception:
        workspace_db.rollback()
        raise
    finally:
        workspace_db.execute(f"PRAGMA foreign_keys={foreign_keys_enabled}")
    return True


def cleanup_empty_recreated_legacy_tables(workspace_db: sqlite3.Connection) -> bool:
    """Remove empty team tables recreated in core after domain extraction.

    Core schema upgrades historically replayed the legacy all-in-one DDL even
    after team-retouch had moved to its own database. Those empty tables retain
    foreign keys to ``main.photos``/``main.versions`` and make an unrelated
    project DELETE fail once the media/versioning tables are detached.
    """
    legacy_tables = _legacy_tables(workspace_db)
    if not legacy_tables:
        return False
    if any(workspace_db.execute(f'SELECT 1 FROM main."{table}" LIMIT 1').fetchone()
           for table in legacy_tables):
        return False
    main_tables = {
        row[0] for row in workspace_db.execute(
            "SELECT name FROM main.sqlite_master WHERE type='table'"
        ).fetchall()
    }
    revision = workspace_db.execute(
        "SELECT value FROM main.meta WHERE key='team_storage_revision'"
    ).fetchone() if "meta" in main_tables else None
    already_extracted = revision is not None and str(revision[0]) == str(SCHEMA_VERSION)
    detached_parents = "photos" not in main_tables or "versions" not in main_tables
    if not already_extracted and not detached_parents:
        return False
    return _drop_legacy_tables(workspace_db, legacy_tables)


def database_path_for_workspace_database(workspace_database: str) -> str:
    absolute = os.path.abspath(workspace_database)
    workspace_key = os.path.splitext(os.path.basename(absolute))[0]
    return os.path.join(os.path.dirname(absolute), workspace_key, "databases", "team-retouch.sqlite3")


def _configure(db: sqlite3.Connection):
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    journal = db.execute("PRAGMA journal_mode").fetchone()[0]
    if str(journal).casefold() != "wal":
        db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")


def ensure_schema(database: str) -> sqlite3.Connection:
    absolute = os.path.abspath(database)
    os.makedirs(os.path.dirname(absolute), exist_ok=True)
    db = sqlite3.connect(absolute, timeout=30)
    _configure(db)
    existing_tables = {
        row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() if "meta" in existing_tables else None
    if schema is not None and int(schema[0]) == SCHEMA_VERSION and set(TABLES).issubset(existing_tables):
        return db
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_patch_tasks (
            id TEXT PRIMARY KEY,
            photo_id TEXT NOT NULL,
            base_version_id TEXT NOT NULL,
            person_index INTEGER NOT NULL,
            person_name TEXT NOT NULL,
            assignee TEXT NOT NULL DEFAULT '',
            detector TEXT NOT NULL DEFAULT '',
            bbox_json TEXT NOT NULL,
            crop_json TEXT NOT NULL,
            patch_path TEXT NOT NULL,
            mask_path TEXT,
            mask_json TEXT NOT NULL DEFAULT '{}',
            members_json TEXT NOT NULL DEFAULT '[]',
            needs_review INTEGER NOT NULL DEFAULT 0,
            review_reason TEXT NOT NULL DEFAULT '',
            edited_patch_path TEXT,
            status TEXT NOT NULL DEFAULT 'exported',
            merge_metrics_json TEXT NOT NULL DEFAULT '{}',
            merged_version_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS team_patch_photo ON team_patch_tasks(photo_id, base_version_id, is_deleted);
        CREATE INDEX IF NOT EXISTS team_patch_base_version ON team_patch_tasks(base_version_id);
        CREATE INDEX IF NOT EXISTS team_patch_merged_version ON team_patch_tasks(merged_version_id);
        CREATE TABLE IF NOT EXISTS team_retouch_photos (
            photo_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            base_version_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_retouch_photo_project ON team_retouch_photos(project_id, updated_at);
        CREATE TABLE IF NOT EXISTS team_person_identities (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#2563eb',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_person_identity_project ON team_person_identities(project_id, created_at);
        CREATE TABLE IF NOT EXISTS team_person_assignments (
            project_id TEXT NOT NULL,
            photo_id TEXT NOT NULL,
            base_version_id TEXT NOT NULL,
            person_index INTEGER NOT NULL,
            identity_id TEXT REFERENCES team_person_identities(id) ON DELETE SET NULL,
            confidence REAL NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'manual',
            completed INTEGER NOT NULL DEFAULT 0,
            completion_kind TEXT NOT NULL DEFAULT '',
            edited_patch_path TEXT,
            return_missing INTEGER NOT NULL DEFAULT 0 CHECK(return_missing IN (0,1)),
            return_missing_since INTEGER,
            completed_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (photo_id, base_version_id, person_index)
        );
        CREATE INDEX IF NOT EXISTS team_person_assignment_project ON team_person_assignments(project_id, identity_id);
        CREATE TABLE IF NOT EXISTS team_person_exclusions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            photo_id TEXT NOT NULL,
            base_version_id TEXT NOT NULL,
            bbox_json TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT 'false-positive',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_person_exclusion_photo
            ON team_person_exclusions(photo_id, base_version_id, created_at);
        """
    )
    db.execute(
        "INSERT INTO meta(key,value) VALUES('schema_version',?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(SCHEMA_VERSION),),
    )
    db.commit()
    return db


def attach_and_migrate(workspace_db: sqlite3.Connection, workspace_database: str) -> str:
    team_database = database_path_for_workspace_database(workspace_database)
    team_db = ensure_schema(team_database)
    team_db.close()
    attached = {row[1] for row in workspace_db.execute("PRAGMA database_list").fetchall()}
    if "team_retouch" not in attached:
        workspace_db.execute("ATTACH DATABASE ? AS team_retouch", (team_database,))
        workspace_db.execute("PRAGMA team_retouch.busy_timeout=30000")

    legacy_tables = _legacy_tables(workspace_db)
    if not legacy_tables.intersection(TABLES):
        return team_database

    columns = {
        "team_patch_tasks": "id,photo_id,base_version_id,person_index,person_name,assignee,detector,bbox_json,crop_json,patch_path,mask_path,mask_json,members_json,needs_review,review_reason,edited_patch_path,status,merge_metrics_json,merged_version_id,created_at,updated_at,is_deleted",
        "team_retouch_photos": "photo_id,project_id,base_version_id,created_at,updated_at",
        "team_person_identities": "id,project_id,name,color,created_at,updated_at",
        "team_person_assignments": "project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,completion_kind,edited_patch_path,return_missing,return_missing_since,completed_at,updated_at",
        "team_person_exclusions": "id,project_id,photo_id,base_version_id,bbox_json,reason,created_at",
    }
    with workspace_db:
        for table in TABLES:
            if table not in legacy_tables:
                continue
            workspace_db.execute(
                f"INSERT OR IGNORE INTO team_retouch.{table}({columns[table]}) SELECT {columns[table]} FROM main.{table}"
            )
        workspace_db.execute(
            "INSERT OR REPLACE INTO main.meta(key,value) VALUES('team_storage_revision','1')"
        )
    # The media/versioning extraction may already have removed the referenced
    # parent tables from main. Disable FK enforcement only for retiring the
    # successfully copied legacy schema; runtime connections re-enable it.
    _drop_legacy_tables(workspace_db, legacy_tables)
    return team_database


def snapshot(source: str, destination: str) -> dict:
    source_path = os.path.abspath(source)
    destination_path = os.path.abspath(destination)
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    if os.path.exists(destination_path):
        os.remove(destination_path)
    source_db = sqlite3.connect(f"{Path(source_path).as_uri()}?mode=ro", uri=True, timeout=30)
    target_db = sqlite3.connect(destination_path, timeout=30)
    try:
        source_db.backup(target_db)
        check = target_db.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"team-retouch 数据库快照完整性检查失败：{check}")
        return {"success": True, "schemaVersion": SCHEMA_VERSION}
    finally:
        target_db.close()
        source_db.close()


def _replace_path(value, replacements):
    if not value:
        return value
    original = str(value)
    normalized = os.path.normcase(os.path.normpath(original))
    for old_root, new_root in replacements:
        if not old_root:
            continue
        old_normalized = os.path.normcase(os.path.normpath(old_root))
        if normalized == old_normalized or normalized.startswith(old_normalized + os.sep):
            relative = os.path.relpath(os.path.normpath(original), os.path.normpath(old_root))
            return os.path.normpath(new_root if relative == "." else os.path.join(new_root, relative))
    return original


def rebase_workspace(database: str, replacements) -> dict:
    db = ensure_schema(database)
    try:
        with db:
            for table, columns in (
                ("team_patch_tasks", ("patch_path", "mask_path", "edited_patch_path")),
                ("team_person_assignments", ("edited_patch_path",)),
            ):
                for column in columns:
                    rows = db.execute(f"SELECT rowid,{column} FROM {table} WHERE {column} IS NOT NULL").fetchall()
                    for row in rows:
                        rebased = _replace_path(row[column], replacements)
                        if rebased != row[column]:
                            db.execute(f"UPDATE {table} SET {column}=? WHERE rowid=?", (rebased, row["rowid"]))
        return {"success": True}
    finally:
        db.close()


def _restore_project_in_place(source: str, destination: str, project_id: str, replacements) -> dict:
    target = ensure_schema(destination)
    source_path = os.path.abspath(source)
    target.execute("ATTACH DATABASE ? AS portable", (source_path,))
    try:
        photo_ids = [row[0] for row in target.execute(
            "SELECT photo_id FROM portable.team_retouch_photos WHERE project_id=?", (project_id,)
        ).fetchall()]
        with target:
            target.execute("DELETE FROM team_person_exclusions WHERE project_id=?", (project_id,))
            target.execute("DELETE FROM team_person_assignments WHERE project_id=?", (project_id,))
            target.execute("DELETE FROM team_person_identities WHERE project_id=?", (project_id,))
            target.execute("DELETE FROM team_retouch_photos WHERE project_id=?", (project_id,))
            if photo_ids:
                placeholders = ",".join("?" for _ in photo_ids)
                target.execute(f"DELETE FROM team_patch_tasks WHERE photo_id IN ({placeholders})", photo_ids)
            for table in ("team_person_identities", "team_retouch_photos", "team_person_assignments", "team_person_exclusions"):
                columns = [row[1] for row in target.execute(f"PRAGMA table_info({table})").fetchall()]
                names = ",".join(columns)
                target.execute(
                    f"INSERT INTO {table}({names}) SELECT {names} FROM portable.{table} WHERE project_id=?",
                    (project_id,),
                )
            if photo_ids:
                columns = [row[1] for row in target.execute("PRAGMA table_info(team_patch_tasks)").fetchall()]
                names = ",".join(columns)
                placeholders = ",".join("?" for _ in photo_ids)
                target.execute(
                    f"INSERT INTO team_patch_tasks({names}) SELECT {names} FROM portable.team_patch_tasks WHERE photo_id IN ({placeholders})",
                    photo_ids,
                )
        rebase_workspace(destination, replacements)
        return {"success": True, "photoCount": len(photo_ids)}
    finally:
        target.close()


def restore_project(source: str, destination: str, project_id: str, replacements) -> dict:
    destination_path = os.path.abspath(destination)
    staged = f"{destination_path}.restore-project-{uuid.uuid4().hex}.tmp"
    try:
        snapshot(destination_path, staged)
        result = _restore_project_in_place(source, staged, project_id, replacements)
        check_db = sqlite3.connect(staged)
        try:
            check_db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            check = check_db.execute("PRAGMA quick_check").fetchone()[0]
        finally:
            check_db.close()
        if check != "ok":
            raise RuntimeError(f"team-retouch 项目恢复临时数据库完整性检查失败：{check}")
        for suffix in ("-wal", "-shm"):
            try:
                os.remove(destination_path + suffix)
            except FileNotFoundError:
                pass
        os.replace(staged, destination_path)
        return {**result, "quickCheck": check}
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(staged + suffix)
            except FileNotFoundError:
                pass
