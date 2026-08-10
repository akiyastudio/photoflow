"""SQLite-backed workspace catalog stored outside the user's project folders."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import sys
import time
import uuid
from pathlib import Path

STATUSES = ("未分类", "策划中", "待拍摄", "后期中", "已归档")
IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff",
    ".heic", ".heif", ".hif", ".avif", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf",
    ".rw2", ".dng", ".rwl", ".3fr", ".fff", ".iiq", ".pef", ".srw",
}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".crm"}
SQLITE_BUSY_TIMEOUT_MS = 15_000
LEGACY_PROGRESS_MIGRATION_KEY = "legacy_progress_folders_migrated"
LEGACY_MEDIA_WORKFLOW_MIGRATION_KEY = "legacy_media_workflow_graph_migrated_v1"
SELECTION_MAINLINE_REPAIR_REVISION = "1"
VERSION_TREE_DEFAULT_LAYOUT_REVISION = "2"
TARGET_SCHEMA_VERSION = 25
PROGRESS_NODE_ROLES = ("original", "progress", "selection", "artifact", "workflow")
PROGRESS_RELATION_KINDS = ("main", "auxiliary")
PROGRESS_ARTIFACT_KINDS = ("companion", "preview", "team_workspace")
VERSION_GRAPH_EDGE_KINDS = ("media_companion", "derived_preview", "workflow_input")
IMPORT_ARTIFACT_SLOTS = ("raw", "camera_jpg", "generated_jpg", "mov", "video_preview")
IMPORT_ARTIFACT_SLOT_SHAPES = {
    "raw": ("image", "original", None),
    "camera_jpg": ("image", "original", "companion"),
    "generated_jpg": ("image", "artifact", "preview"),
    "mov": ("video", "original", None),
    "video_preview": ("video", "artifact", "preview"),
}
PROGRESS_TRACKING_STATES = (
    "disabled", "pending_compare", "pending_confirm", "committing", "ready", "stale", "needs_repair",
)
PROGRESS_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
TRACKING_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000
INTEGRITY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
MIGRATION_BACKUP_LIMIT = 5
AUTOMATIC_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
AUTOMATIC_BACKUP_LIMIT = 7


def valid_project_status(value) -> bool:
    return (
        isinstance(value, str)
        and value == value.strip()
        and 0 < len(value) <= 24
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )


def is_internal_workspace_directory(value: str) -> bool:
    name = str(value or "").replace("\\", "/").rstrip("/").rsplit("/", 1)[-1].casefold()
    return name == "_photoflow_safety_temp" or name.startswith(".photoflow-")


def _table_columns(db, table: str) -> set[str]:
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}


def _table_exists(db, table: str) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def _meta_value(db, key: str):
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row is not None else None


def _set_meta(db, key: str, value):
    db.execute(
        """INSERT INTO meta(key,value) VALUES(?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
        (key, str(value)),
    )


def _backup_before_migration(db, database: str, schema_version: int) -> str:
    backup_dir = os.path.join(os.path.dirname(database), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.join(
        backup_dir,
        f"{os.path.basename(database)}.v{schema_version}.{stamp}.{uuid.uuid4().hex[:6]}.bak",
    )
    backup = sqlite3.connect(backup_path)
    try:
        db.backup(backup)
        if backup.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("迁移备份完整性检查失败")
    finally:
        backup.close()
    prefix = f"{os.path.basename(database)}.v"
    backups = sorted(
        (
            os.path.join(backup_dir, name)
            for name in os.listdir(backup_dir)
            if name.startswith(prefix) and name.endswith(".bak")
        ),
        key=os.path.getmtime,
        reverse=True,
    )
    for stale_path in backups[MIGRATION_BACKUP_LIMIT:]:
        try:
            os.remove(stale_path)
        except OSError:
            pass
    return backup_path


def _automatic_backup_if_due(db, database: str):
    now = int(time.time() * 1000)
    db.execute("BEGIN IMMEDIATE")
    try:
        last_attempt = int(_meta_value(db, "last_automatic_backup_attempt_at") or 0)
        if now - last_attempt < AUTOMATIC_BACKUP_INTERVAL_MS:
            db.rollback()
            return
        _set_meta(db, "last_automatic_backup_attempt_at", now)
        db.commit()
    except Exception:
        db.rollback()
        raise

    backup_dir = os.path.join(os.path.dirname(database), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.join(
        backup_dir,
        f"{os.path.basename(database)}.auto.{stamp}.{uuid.uuid4().hex[:6]}.bak",
    )
    try:
        backup = sqlite3.connect(backup_path)
        try:
            db.backup(backup)
            if backup.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise RuntimeError("自动备份完整性检查失败")
        finally:
            backup.close()
        backups = sorted(
            (
                os.path.join(backup_dir, name)
                for name in os.listdir(backup_dir)
                if name.startswith(f"{os.path.basename(database)}.auto.") and name.endswith(".bak")
            ),
            key=os.path.getmtime,
            reverse=True,
        )
        for stale_path in backups[AUTOMATIC_BACKUP_LIMIT:]:
            try:
                os.remove(stale_path)
            except OSError:
                pass
        _set_meta(db, "last_automatic_backup_at", now)
        _set_meta(db, "last_automatic_backup", backup_path)
        _set_meta(db, "last_automatic_backup_error", "")
    except Exception as error:
        try:
            os.remove(backup_path)
        except OSError:
            pass
        _set_meta(db, "last_automatic_backup_error", str(error))
    db.commit()


def _migration_11(db):
    columns = _table_columns(db, "projects")
    if "filesystem_id" not in columns:
        db.execute("ALTER TABLE projects ADD COLUMN filesystem_id TEXT")
    if "is_deleted" not in columns:
        db.execute("ALTER TABLE projects ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
    patch_columns = _table_columns(db, "team_patch_tasks")
    if "mask_path" not in patch_columns:
        db.execute("ALTER TABLE team_patch_tasks ADD COLUMN mask_path TEXT")
    if "mask_json" not in patch_columns:
        db.execute("ALTER TABLE team_patch_tasks ADD COLUMN mask_json TEXT NOT NULL DEFAULT '{}'")
    if "members_json" not in patch_columns:
        db.execute("ALTER TABLE team_patch_tasks ADD COLUMN members_json TEXT NOT NULL DEFAULT '[]'")
    if "needs_review" not in patch_columns:
        db.execute("ALTER TABLE team_patch_tasks ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0")
    if "review_reason" not in patch_columns:
        db.execute("ALTER TABLE team_patch_tasks ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''")
    db.execute(
        """INSERT OR IGNORE INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at)
           SELECT task.photo_id,photos.project_id,task.base_version_id,MIN(task.created_at),MAX(task.updated_at)
           FROM team_patch_tasks task JOIN photos ON photos.id=task.photo_id
           WHERE task.is_deleted=0 AND task.updated_at=(
             SELECT MAX(latest.updated_at) FROM team_patch_tasks latest
             WHERE latest.photo_id=task.photo_id AND latest.is_deleted=0
           ) GROUP BY task.photo_id"""
    )


def _migration_12(db):
    """Make every file record owned by a real version and discard legacy orphans."""
    removed = db.execute(
        """SELECT COUNT(*) FROM file_records
           WHERE owner_type!='version' OR NOT EXISTS(
             SELECT 1 FROM versions WHERE versions.id=file_records.owner_id
           )"""
    ).fetchone()[0]
    foreign_keys = db.execute("PRAGMA foreign_key_list(file_records)").fetchall()
    has_owner_fk = any(row[2] == "versions" and row[3] == "owner_id" and row[4] == "id" for row in foreign_keys)
    if not has_owner_fk:
        db.execute("DROP TABLE IF EXISTS file_records_v12")
        db.execute(
            """CREATE TABLE file_records_v12 (
                id TEXT PRIMARY KEY,
                owner_type TEXT NOT NULL CHECK(owner_type='version'),
                owner_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
                current_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                extension TEXT NOT NULL,
                windows_file_id TEXT,
                volume_id TEXT,
                file_size INTEGER NOT NULL CHECK(file_size>=0),
                modified_at INTEGER,
                quick_hash TEXT,
                full_hash TEXT,
                missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN (0,1)),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(owner_type, owner_id)
            )"""
        )
        db.execute(
            """INSERT INTO file_records_v12
               SELECT records.* FROM file_records records
               JOIN versions ON versions.id=records.owner_id
               WHERE records.owner_type='version'"""
        )
        db.execute("DROP TABLE file_records")
        db.execute("ALTER TABLE file_records_v12 RENAME TO file_records")
    else:
        db.execute(
            """DELETE FROM file_records
               WHERE owner_type!='version' OR NOT EXISTS(
                 SELECT 1 FROM versions WHERE versions.id=file_records.owner_id
               )"""
        )
    _set_meta(db, "migration_12_orphan_file_records_removed", removed)


def _repair_version_flags(db):
    for duplicate in db.execute(
        """SELECT photo_id FROM versions
           WHERE is_current=1 AND is_deleted=0 GROUP BY photo_id HAVING COUNT(*)>1"""
    ).fetchall():
        photo_id = duplicate[0]
        preferred = db.execute(
            """SELECT versions.id FROM versions JOIN photos ON photos.id=versions.photo_id
               WHERE versions.photo_id=? AND versions.is_current=1 AND versions.is_deleted=0
               ORDER BY versions.id=photos.current_version_id DESC, versions.version_number DESC LIMIT 1""",
            (photo_id,),
        ).fetchone()[0]
        db.execute("UPDATE versions SET is_current=(id=?) WHERE photo_id=? AND is_deleted=0", (preferred, photo_id))
    for duplicate in db.execute(
        """SELECT photo_id FROM versions
           WHERE is_final=1 AND is_deleted=0 GROUP BY photo_id HAVING COUNT(*)>1"""
    ).fetchall():
        photo_id = duplicate[0]
        preferred = db.execute(
            """SELECT id FROM versions WHERE photo_id=? AND is_final=1 AND is_deleted=0
               ORDER BY version_number DESC, updated_at DESC LIMIT 1""",
            (photo_id,),
        ).fetchone()[0]
        db.execute("UPDATE versions SET is_final=(id=?) WHERE photo_id=? AND is_deleted=0", (preferred, photo_id))


def _migration_13(db):
    columns = _table_columns(db, "projects")
    if "availability" not in columns:
        db.execute(
            "ALTER TABLE projects ADD COLUMN availability TEXT NOT NULL DEFAULT 'available' "
            "CHECK(availability IN ('available','missing'))"
        )
    if "missing_since" not in columns:
        db.execute("ALTER TABLE projects ADD COLUMN missing_since INTEGER")
    if "missing_checks" not in columns:
        db.execute("ALTER TABLE projects ADD COLUMN missing_checks INTEGER NOT NULL DEFAULT 0 CHECK(missing_checks>=0)")
    _repair_version_flags(db)
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS versions_one_current "
        "ON versions(photo_id) WHERE is_current=1 AND is_deleted=0"
    )
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS versions_one_final "
        "ON versions(photo_id) WHERE is_final=1 AND is_deleted=0"
    )
    db.execute(
        """CREATE TRIGGER IF NOT EXISTS versions_parent_same_photo_insert
           BEFORE INSERT ON versions WHEN NEW.parent_version_id IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM versions parent WHERE parent.id=NEW.parent_version_id AND parent.photo_id=NEW.photo_id)
           BEGIN SELECT RAISE(ABORT,'parent version belongs to another photo'); END"""
    )
    db.execute(
        """CREATE TRIGGER IF NOT EXISTS versions_parent_same_photo_update
           BEFORE UPDATE OF parent_version_id,photo_id ON versions WHEN NEW.parent_version_id IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM versions parent WHERE parent.id=NEW.parent_version_id AND parent.photo_id=NEW.photo_id)
           BEGIN SELECT RAISE(ABORT,'parent version belongs to another photo'); END"""
    )
    db.execute(
        """CREATE TRIGGER IF NOT EXISTS photos_current_version_same_photo
           BEFORE UPDATE OF current_version_id ON photos WHEN NEW.current_version_id IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM versions WHERE id=NEW.current_version_id AND photo_id=NEW.id AND is_deleted=0)
           BEGIN SELECT RAISE(ABORT,'current version belongs to another photo'); END"""
    )
    guards = (
        (
            "version_batches_parent_project",
            "version_batches",
            "parent_batch_id,project_id",
            "NEW.parent_batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM version_batches parent WHERE parent.id=NEW.parent_batch_id AND parent.project_id=NEW.project_id)",
            "parent batch belongs to another project",
        ),
        (
            "progress_folders_parent_project",
            "progress_folders",
            "parent_progress_id,project_id,media_kind",
            "NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind)",
            "parent progress folder belongs to another project or media kind",
        ),
        (
            "batch_items_owner_consistency",
            "batch_items",
            "batch_id,photo_id,version_id",
            "NOT EXISTS(SELECT 1 FROM version_batches batch JOIN photos ON photos.project_id=batch.project_id JOIN versions ON versions.photo_id=photos.id WHERE batch.id=NEW.batch_id AND photos.id=NEW.photo_id AND versions.id=NEW.version_id)",
            "batch item owners are inconsistent",
        ),
        (
            "team_retouch_photo_consistency",
            "team_retouch_photos",
            "project_id,photo_id,base_version_id",
            "NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.project_id=NEW.project_id AND photos.id=NEW.photo_id AND versions.id=NEW.base_version_id)",
            "team retouch photo owners are inconsistent",
        ),
        (
            "team_assignment_consistency",
            "team_person_assignments",
            "project_id,photo_id,base_version_id,identity_id",
            "NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.project_id=NEW.project_id AND photos.id=NEW.photo_id AND versions.id=NEW.base_version_id) OR (NEW.identity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM team_person_identities identity WHERE identity.id=NEW.identity_id AND identity.project_id=NEW.project_id))",
            "team assignment owners are inconsistent",
        ),
        (
            "team_exclusion_consistency",
            "team_person_exclusions",
            "project_id,photo_id,base_version_id",
            "NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.project_id=NEW.project_id AND photos.id=NEW.photo_id AND versions.id=NEW.base_version_id)",
            "team exclusion owners are inconsistent",
        ),
    )
    for name, table, update_columns, condition, message in guards:
        db.execute(
            f"""CREATE TRIGGER IF NOT EXISTS {name}_insert
                BEFORE INSERT ON {table} WHEN {condition}
                BEGIN SELECT RAISE(ABORT,'{message}'); END"""
        )
        db.execute(
            f"""CREATE TRIGGER IF NOT EXISTS {name}_update
                BEFORE UPDATE OF {update_columns} ON {table} WHEN {condition}
                BEGIN SELECT RAISE(ABORT,'{message}'); END"""
        )


def _migration_14(db):
    progress_columns = _table_columns(db, "progress_folders")
    if "tracking_state" not in progress_columns:
        db.execute(
            "ALTER TABLE progress_folders ADD COLUMN tracking_state TEXT NOT NULL DEFAULT 'disabled'"
        )
    db.execute(
        """UPDATE progress_folders SET tracking_state=CASE
             WHEN tracking_enabled=1 THEN 'ready' ELSE 'disabled' END
           WHERE tracking_state IS NULL OR tracking_state='' OR tracking_state='disabled'"""
    )
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS batch_file_operations (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES version_batches(id) ON DELETE CASCADE,
            operation_type TEXT NOT NULL CHECK(operation_type IN ('rename','copy')),
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','skipped')),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
            error TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(batch_id, operation_type, source_path, target_path)
        );
        CREATE INDEX IF NOT EXISTS batch_file_operations_batch
          ON batch_file_operations(batch_id, status, created_at);
        """
    )


def _migration_15(db):
    """Store return artifacts on the exact person hand-off node."""
    columns = _table_columns(db, "team_person_assignments")
    if "completion_kind" not in columns:
        db.execute("ALTER TABLE team_person_assignments ADD COLUMN completion_kind TEXT NOT NULL DEFAULT ''")
    if "edited_patch_path" not in columns:
        db.execute("ALTER TABLE team_person_assignments ADD COLUMN edited_patch_path TEXT")
    if "completed_at" not in columns:
        db.execute("ALTER TABLE team_person_assignments ADD COLUMN completed_at INTEGER")

    # Older builds stored just one latest return on the shared crop task. Keep
    # that artifact on the most recently completed member and treat any older
    # completed members as no-retouch hand-offs instead of claiming that every
    # person returned the same file.
    db.execute(
        """UPDATE team_person_assignments
           SET completion_kind=CASE WHEN completed=1 THEN 'no-retouch' ELSE '' END,
               completed_at=CASE WHEN completed=1 THEN updated_at ELSE NULL END
           WHERE completion_kind=''"""
    )
    tasks = db.execute(
        """SELECT photo_id,base_version_id,edited_patch_path
           FROM team_patch_tasks
           WHERE is_deleted=0 AND edited_patch_path IS NOT NULL"""
    ).fetchall()
    for task in tasks:
        latest = db.execute(
            """SELECT person_index FROM team_person_assignments
               WHERE photo_id=? AND base_version_id=? AND completed=1
               ORDER BY updated_at DESC,person_index DESC LIMIT 1""",
            (task["photo_id"], task["base_version_id"]),
        ).fetchone()
        if latest is not None:
            db.execute(
                """UPDATE team_person_assignments
                   SET completion_kind='returned',edited_patch_path=?
                   WHERE photo_id=? AND base_version_id=? AND person_index=?""",
                (task["edited_patch_path"], task["photo_id"], task["base_version_id"], latest["person_index"]),
            )


def _migration_16(db):
    """Keep progress-folder tombstones recoverable after their directory disappears."""
    columns = _table_columns(db, "progress_folders")
    if "missing_since" not in columns:
        db.execute("ALTER TABLE progress_folders ADD COLUMN missing_since INTEGER")


def _migration_17(db):
    """Track externally removed team-retouch return artifacts without losing history."""
    columns = _table_columns(db, "team_person_assignments")
    if "return_missing" not in columns:
        db.execute("ALTER TABLE team_person_assignments ADD COLUMN return_missing INTEGER NOT NULL DEFAULT 0 CHECK(return_missing IN (0,1))")
    if "return_missing_since" not in columns:
        db.execute("ALTER TABLE team_person_assignments ADD COLUMN return_missing_since INTEGER")


def _progress_relation_cycles(db) -> list[tuple[str, ...]]:
    """Find every parent-pointer cycle without recursive SQL or Python recursion."""
    rows = db.execute("SELECT id,parent_progress_id FROM progress_folders ORDER BY id").fetchall()
    parents = {str(row["id"]): str(row["parent_progress_id"]) if row["parent_progress_id"] else None for row in rows}
    finished: set[str] = set()
    cycles: list[tuple[str, ...]] = []
    for start_id in sorted(parents):
        if start_id in finished:
            continue
        path: list[str] = []
        path_indexes: dict[str, int] = {}
        current_id: str | None = start_id
        while current_id is not None and current_id in parents and current_id not in finished:
            if current_id in path_indexes:
                cycles.append(tuple(sorted(path[path_indexes[current_id]:])))
                break
            path_indexes[current_id] = len(path)
            path.append(current_id)
            current_id = parents[current_id]
        finished.update(path)
    return sorted(set(cycles))


def _version_graph_adjacency(db, project_id: str, exclude_edge_id: str | None = None) -> dict[str, set[str]]:
    rows = db.execute(
        "SELECT id,parent_progress_id FROM progress_folders WHERE project_id=?",
        (project_id,),
    ).fetchall()
    adjacency = {str(row["id"]): set() for row in rows}
    for row in rows:
        if row["parent_progress_id"]:
            adjacency.setdefault(str(row["parent_progress_id"]), set()).add(str(row["id"]))
    edge_rows = db.execute(
        "SELECT id,source_progress_id,target_progress_id FROM version_graph_edges WHERE project_id=?",
        (project_id,),
    ).fetchall() if _table_exists(db, "version_graph_edges") else []
    for edge in edge_rows:
        if exclude_edge_id and str(edge["id"]) == exclude_edge_id:
            continue
        adjacency.setdefault(str(edge["source_progress_id"]), set()).add(str(edge["target_progress_id"]))
    return adjacency


def _version_graph_reaches(db, project_id: str, start_id: str, target_id: str, exclude_edge_id: str | None = None) -> bool:
    adjacency = _version_graph_adjacency(db, project_id, exclude_edge_id)
    pending = [start_id]
    visited: set[str] = set()
    while pending:
        current = pending.pop()
        if current == target_id:
            return True
        if current in visited:
            continue
        visited.add(current)
        pending.extend(adjacency.get(current, ()))
    return False


def _version_graph_cycle_nodes(db) -> set[str]:
    if not _table_exists(db, "version_graph_edges"):
        return set()
    projects = [str(row[0]) for row in db.execute("SELECT id FROM projects").fetchall()]
    cyclic: set[str] = set()
    for project_id in projects:
        adjacency = _version_graph_adjacency(db, project_id)
        indegree = {node_id: 0 for node_id in adjacency}
        for targets in adjacency.values():
            for target_id in targets:
                indegree[target_id] = indegree.get(target_id, 0) + 1
        pending = [node_id for node_id, degree in indegree.items() if degree == 0]
        removed: set[str] = set()
        while pending:
            node_id = pending.pop()
            if node_id in removed:
                continue
            removed.add(node_id)
            for target_id in adjacency.get(node_id, ()):
                indegree[target_id] -= 1
                if indegree[target_id] == 0:
                    pending.append(target_id)
        cyclic.update(set(indegree) - removed)
    return cyclic


def _repair_progress_relation_cycles(db) -> list[dict]:
    """Deterministically break one edge per legacy cycle and retain an audit log."""
    db.execute(
        """CREATE TABLE IF NOT EXISTS progress_relation_repair_log(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             repaired_progress_id TEXT NOT NULL,
             previous_parent_progress_id TEXT NOT NULL,
             cycle_node_ids_json TEXT NOT NULL,
             repair_kind TEXT NOT NULL,
             repaired_at INTEGER NOT NULL
           )"""
    )
    timestamp = int(time.time() * 1000)
    repairs = []
    for cycle_node_ids in _progress_relation_cycles(db):
        repaired_id = min(cycle_node_ids)
        row = db.execute(
            "SELECT parent_progress_id,node_role FROM progress_folders WHERE id=?",
            (repaired_id,),
        ).fetchone()
        if row is None or not row["parent_progress_id"]:
            continue
        previous_parent_id = str(row["parent_progress_id"])
        db.execute(
            """UPDATE progress_folders
               SET parent_progress_id=NULL,relation_kind=NULL,
                   node_role=CASE WHEN node_role='selection' THEN 'progress' ELSE node_role END,
                   updated_at=? WHERE id=?""",
            (timestamp, repaired_id),
        )
        cycle_json = json.dumps(list(cycle_node_ids), ensure_ascii=False, separators=(",", ":"))
        db.execute(
            """INSERT INTO progress_relation_repair_log(
                 repaired_progress_id,previous_parent_progress_id,cycle_node_ids_json,repair_kind,repaired_at)
               VALUES(?,?,?,'legacy_cycle_rooted',?)""",
            (repaired_id, previous_parent_id, cycle_json, timestamp),
        )
        repairs.append({
            "repairedProgressId": repaired_id,
            "previousParentProgressId": previous_parent_id,
            "cycleNodeIds": list(cycle_node_ids),
        })
    if repairs:
        _set_meta(db, "last_progress_relation_cycle_repair", json.dumps(repairs, ensure_ascii=False, separators=(",", ":")))
    return repairs


def _migration_18(db):
    """Add the explicit V2 folder-node model without inferring branches from names."""
    columns = _table_columns(db, "progress_folders")
    additions = (
        ("node_role", "TEXT NOT NULL DEFAULT 'progress'"),
        ("relation_kind", "TEXT"),
        ("rename_from_parent", "INTEGER NOT NULL DEFAULT 0"),
        ("copy_missing_from_parent", "INTEGER NOT NULL DEFAULT 0"),
        ("last_tracked_at", "INTEGER"),
        ("tracking_snapshot_json", "TEXT NOT NULL DEFAULT '{}'"),
        ("folder_signature", "TEXT"),
        ("tombstone_json", "TEXT NOT NULL DEFAULT '{}'"),
    )
    for name, declaration in additions:
        if name not in columns:
            db.execute(f"ALTER TABLE progress_folders ADD COLUMN {name} {declaration}")

    # Old underscore versions remain main progress nodes. Only explicit root
    # baseline identities are promoted to original; the version key format is
    # never used to infer an auxiliary relation.
    db.execute(
        """UPDATE progress_folders
           SET node_role=CASE
             WHEN parent_progress_id IS NULL AND (
               version_key='0' OR lower(display_name) IN ('raw','jpg','mov')
               OR lower(replace(folder_path,'\','/')) LIKE '%/raw'
               OR lower(replace(folder_path,'\','/')) LIKE '%/jpg'
               OR lower(replace(folder_path,'\','/')) LIKE '%/mov'
             ) THEN 'original' ELSE 'progress' END,
             relation_kind=CASE WHEN parent_progress_id IS NULL THEN NULL ELSE 'main' END,
             tracking_state=CASE
               WHEN tracking_state IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
                 THEN tracking_state
               WHEN tracking_enabled=1 THEN 'ready' ELSE 'disabled' END,
             tracking_enabled=CASE
               WHEN tracking_state='disabled' THEN 0 ELSE 1 END,
             rename_from_parent=0,
             copy_missing_from_parent=0,
             last_tracked_at=CASE WHEN tracking_state='ready' THEN COALESCE(last_tracked_at,updated_at) ELSE last_tracked_at END,
             tracking_snapshot_json=COALESCE(NULLIF(tracking_snapshot_json,''),'{}'),
             tombstone_json=COALESCE(NULLIF(tombstone_json,''),'{}')"""
    )
    # Originals and auxiliary nodes never carry active tracking policy.
    db.execute(
        """UPDATE progress_folders SET tracking_enabled=0,rename_from_parent=0,
           copy_missing_from_parent=0,tracking_state='disabled'
           WHERE node_role='original' OR relation_kind='auxiliary'"""
    )
    # Existing schema-17 data may already contain cycles. Repair it before
    # installing V2 triggers or running the post-migration integrity check.
    _repair_progress_relation_cycles(db)
    db.executescript(
        """
        CREATE INDEX IF NOT EXISTS progress_folders_missing
          ON progress_folders(project_id, missing_since);
        CREATE INDEX IF NOT EXISTS progress_folders_branch
          ON progress_folders(project_id, media_kind, relation_kind, parent_progress_id);

        DROP TRIGGER IF EXISTS progress_folders_v2_shape_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_shape_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_parent_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_parent_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_update;
        DROP TRIGGER IF EXISTS version_graph_edges_validate_insert;
        DROP TRIGGER IF EXISTS version_graph_edges_validate_update;
        DROP TRIGGER IF EXISTS progress_folders_graph_endpoint_update;

        CREATE TRIGGER progress_folders_v2_shape_insert
        BEFORE INSERT ON progress_folders WHEN
          NEW.node_role NOT IN ('original','progress','selection')
          OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
          OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
          OR (NEW.node_role='original' AND NEW.parent_progress_id IS NOT NULL)
          OR (NEW.node_role='selection' AND NEW.relation_kind!='auxiliary')
          OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main')
          OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
        BEGIN SELECT RAISE(ABORT,'invalid V2 progress node shape'); END;

        CREATE TRIGGER progress_folders_v2_shape_update
        BEFORE UPDATE OF node_role,relation_kind,parent_progress_id ON progress_folders WHEN
          NEW.node_role NOT IN ('original','progress','selection')
          OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
          OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
          OR (NEW.node_role='original' AND NEW.parent_progress_id IS NOT NULL)
          OR (NEW.node_role='selection' AND NEW.relation_kind!='auxiliary')
          OR (NEW.node_role='progress' AND NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main')
          OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
        BEGIN SELECT RAISE(ABORT,'invalid V2 progress node shape'); END;

        CREATE TRIGGER progress_folders_v2_parent_insert
        BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id
            AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind
            AND parent.node_role IN ('original','progress')
        ) BEGIN SELECT RAISE(ABORT,'invalid V2 progress parent'); END;

        CREATE TRIGGER progress_folders_v2_parent_update
        BEFORE UPDATE OF parent_progress_id,project_id,media_kind ON progress_folders
        WHEN NEW.parent_progress_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM progress_folders parent WHERE parent.id=NEW.parent_progress_id
            AND parent.project_id=NEW.project_id AND parent.media_kind=NEW.media_kind
            AND parent.node_role IN ('original','progress')
        ) BEGIN SELECT RAISE(ABORT,'invalid V2 progress parent'); END;

        CREATE TRIGGER progress_folders_v2_cycle_insert
        BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_progress_id UNION
            SELECT parent.parent_progress_id FROM progress_folders parent JOIN ancestors ON parent.id=ancestors.id
            WHERE parent.parent_progress_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        ) BEGIN SELECT RAISE(ABORT,'progress relation cycle'); END;

        CREATE TRIGGER progress_folders_v2_cycle_update
        BEFORE UPDATE OF parent_progress_id ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_progress_id UNION
            SELECT parent.parent_progress_id FROM progress_folders parent JOIN ancestors ON parent.id=ancestors.id
            WHERE parent.parent_progress_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        ) BEGIN SELECT RAISE(ABORT,'progress relation cycle'); END;

        CREATE TRIGGER progress_folders_v2_policy_insert
        BEFORE INSERT ON progress_folders WHEN
          NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
          OR NEW.copy_missing_from_parent NOT IN (0,1)
          OR ((NEW.node_role='original' OR NEW.relation_kind='auxiliary') AND (
            NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
          OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
        BEGIN SELECT RAISE(ABORT,'invalid V2 tracking policy'); END;

        CREATE TRIGGER progress_folders_v2_policy_update
        BEFORE UPDATE OF node_role,relation_kind,tracking_enabled,rename_from_parent,copy_missing_from_parent,tracking_state
        ON progress_folders WHEN
          NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
          OR NEW.copy_missing_from_parent NOT IN (0,1)
          OR ((NEW.node_role='original' OR NEW.relation_kind='auxiliary') AND (
            NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
          OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
        BEGIN SELECT RAISE(ABORT,'invalid V2 tracking policy'); END;
        """
    )


def _migration_19(db):
    """Persist V2 compare/refresh sessions and explicit confirmation decisions."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS tracking_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          progress_id TEXT NOT NULL REFERENCES progress_folders(id) ON DELETE CASCADE,
          parent_progress_id TEXT NOT NULL REFERENCES progress_folders(id),
          mode TEXT NOT NULL CHECK(mode IN ('compare','refresh')),
          status TEXT NOT NULL CHECK(status IN ('comparing','pending_confirm','committing','committed','failed','cancelled')),
          previous_tracking_state TEXT NOT NULL,
          rename_from_parent INTEGER NOT NULL DEFAULT 0 CHECK(rename_from_parent IN (0,1)),
          copy_missing_from_parent INTEGER NOT NULL DEFAULT 0 CHECK(copy_missing_from_parent IN (0,1)),
          committed_batch_id TEXT REFERENCES version_batches(id) ON DELETE SET NULL,
          error TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tracking_sessions_progress
          ON tracking_sessions(progress_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS tracking_session_items (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES tracking_sessions(id) ON DELETE CASCADE,
          item_kind TEXT NOT NULL CHECK(item_kind IN ('recognized','new','copy_missing','missing')),
          source_name TEXT,
          reference_name TEXT,
          target_name TEXT,
          status TEXT NOT NULL CHECK(status IN ('recognized','pending_confirmation','accepted','missing_reference','rejected')),
          distance REAL,
          confidence TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(session_id,item_kind,source_name,reference_name)
        );
        CREATE INDEX IF NOT EXISTS tracking_session_items_session
          ON tracking_session_items(session_id, created_at, id);
        """
    )


def _migration_20(db):
    """Repair cycles missed by older V2 builds and install terminating guards."""
    _repair_progress_relation_cycles(db)
    db.executescript(
        """
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_update;

        CREATE TRIGGER progress_folders_v2_cycle_insert
        BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_progress_id UNION
            SELECT parent.parent_progress_id FROM progress_folders parent JOIN ancestors ON parent.id=ancestors.id
            WHERE parent.parent_progress_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        ) BEGIN SELECT RAISE(ABORT,'progress relation cycle'); END;

        CREATE TRIGGER progress_folders_v2_cycle_update
        BEFORE UPDATE OF parent_progress_id ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_progress_id UNION
            SELECT parent.parent_progress_id FROM progress_folders parent JOIN ancestors ON parent.id=ancestors.id
            WHERE parent.parent_progress_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        ) BEGIN SELECT RAISE(ABORT,'progress relation cycle'); END;
        """
    )


def _migration_21(db):
    """Keep at most one resumable tracking session for each progress node."""
    db.executescript(
        """
        DELETE FROM tracking_sessions
        WHERE status IN ('comparing','pending_confirm','committing','failed')
          AND EXISTS (
            SELECT 1 FROM tracking_sessions newer
            WHERE newer.progress_id=tracking_sessions.progress_id
              AND newer.status IN ('comparing','pending_confirm','committing','failed')
              AND (
                newer.updated_at > tracking_sessions.updated_at
                OR (newer.updated_at = tracking_sessions.updated_at AND newer.id > tracking_sessions.id)
              )
          );
        CREATE UNIQUE INDEX IF NOT EXISTS tracking_sessions_one_active_progress
          ON tracking_sessions(progress_id)
          WHERE status IN ('comparing','pending_confirm','committing','failed');
        """
    )


def _migration_22(db):
    """Persist legacy selection nodes whose source cannot be repaired safely."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS legacy_selection_relation_repairs (
          progress_id TEXT PRIMARY KEY REFERENCES progress_folders(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          legacy_name TEXT NOT NULL,
          expected_source_name TEXT NOT NULL,
          reason TEXT NOT NULL,
          candidate_ids_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS legacy_selection_relation_repairs_project
          ON legacy_selection_relation_repairs(project_id, created_at, progress_id);
        """
    )


def _migration_23(db):
    """Persist free-canvas version-tree positions by stable project node ID."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS version_tree_layouts (
          project_id TEXT NOT NULL,
          scope_key TEXT NOT NULL DEFAULT '',
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, scope_key),
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS version_tree_node_positions (
          project_id TEXT NOT NULL,
          scope_key TEXT NOT NULL DEFAULT '',
          node_key TEXT NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, scope_key, node_key),
          FOREIGN KEY(project_id, scope_key)
            REFERENCES version_tree_layouts(project_id, scope_key) ON DELETE CASCADE
        );
        """
    )


def _migration_24(db):
    """Add non-structural version-graph edges and explicit artifact/workflow nodes."""
    columns = _table_columns(db, "progress_folders")
    if "artifact_kind" not in columns:
        db.execute("ALTER TABLE progress_folders ADD COLUMN artifact_kind TEXT")
    db.execute(
        """UPDATE progress_folders SET tracking_enabled=0,rename_from_parent=0,
           copy_missing_from_parent=0,tracking_state='disabled'
           WHERE node_role IN ('artifact','workflow')"""
    )
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS version_graph_edges (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          source_progress_id TEXT NOT NULL REFERENCES progress_folders(id) ON DELETE CASCADE,
          target_progress_id TEXT NOT NULL REFERENCES progress_folders(id) ON DELETE CASCADE,
          edge_kind TEXT NOT NULL CHECK(edge_kind IN ('media_companion','derived_preview','workflow_input')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, source_progress_id, target_progress_id, edge_kind)
        );
        CREATE INDEX IF NOT EXISTS version_graph_edges_source
          ON version_graph_edges(project_id, source_progress_id, edge_kind);
        CREATE INDEX IF NOT EXISTS version_graph_edges_target
          ON version_graph_edges(project_id, target_progress_id, edge_kind);
        CREATE TABLE IF NOT EXISTS media_import_graph_sessions (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          import_session_id TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','committed','failed')),
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, import_session_id)
        );

        DROP TRIGGER IF EXISTS progress_folders_v2_shape_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_shape_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_update;
        DROP TRIGGER IF EXISTS version_graph_edges_validate_insert;
        DROP TRIGGER IF EXISTS version_graph_edges_validate_update;
        DROP TRIGGER IF EXISTS progress_folders_graph_endpoint_update;

        CREATE TRIGGER progress_folders_v2_shape_insert
        BEFORE INSERT ON progress_folders WHEN
          NEW.node_role NOT IN ('original','progress','selection','artifact','workflow')
          OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
          OR (NEW.artifact_kind IS NOT NULL AND NEW.artifact_kind NOT IN ('companion','preview','team_workspace'))
          OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
          OR (NEW.node_role='original' AND (NEW.parent_progress_id IS NOT NULL OR NEW.artifact_kind NOT IN ('companion')))
          OR (NEW.node_role='selection' AND (NEW.relation_kind!='auxiliary' OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.node_role='progress' AND ((NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main') OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.node_role='artifact' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind NOT IN ('companion','preview')))
          OR (NEW.node_role='workflow' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind!='team_workspace'))
          OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
        BEGIN SELECT RAISE(ABORT,'invalid V3 progress node shape'); END;

        CREATE TRIGGER progress_folders_v2_shape_update
        BEFORE UPDATE OF node_role,artifact_kind,relation_kind,parent_progress_id ON progress_folders WHEN
          NEW.node_role NOT IN ('original','progress','selection','artifact','workflow')
          OR (NEW.relation_kind IS NOT NULL AND NEW.relation_kind NOT IN ('main','auxiliary'))
          OR (NEW.artifact_kind IS NOT NULL AND NEW.artifact_kind NOT IN ('companion','preview','team_workspace'))
          OR (NEW.parent_progress_id IS NULL) != (NEW.relation_kind IS NULL)
          OR (NEW.node_role='original' AND (NEW.parent_progress_id IS NOT NULL OR NEW.artifact_kind NOT IN ('companion')))
          OR (NEW.node_role='selection' AND (NEW.relation_kind!='auxiliary' OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.node_role='progress' AND ((NEW.parent_progress_id IS NOT NULL AND NEW.relation_kind!='main') OR NEW.artifact_kind IS NOT NULL))
          OR (NEW.node_role='artifact' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind NOT IN ('companion','preview')))
          OR (NEW.node_role='workflow' AND (NEW.parent_progress_id IS NOT NULL OR NEW.relation_kind IS NOT NULL OR NEW.artifact_kind!='team_workspace'))
          OR (NEW.relation_kind='auxiliary' AND NEW.node_role!='selection')
        BEGIN SELECT RAISE(ABORT,'invalid V3 progress node shape'); END;

        CREATE TRIGGER progress_folders_v2_policy_insert
        BEFORE INSERT ON progress_folders WHEN
          NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
          OR NEW.copy_missing_from_parent NOT IN (0,1)
          OR ((NEW.node_role IN ('original','artifact','workflow') OR NEW.relation_kind='auxiliary') AND (
            NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
          OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
        BEGIN SELECT RAISE(ABORT,'invalid V3 tracking policy'); END;

        CREATE TRIGGER progress_folders_v2_policy_update
        BEFORE UPDATE OF node_role,relation_kind,tracking_enabled,rename_from_parent,copy_missing_from_parent,tracking_state
        ON progress_folders WHEN
          NEW.tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR NEW.tracking_enabled NOT IN (0,1) OR NEW.rename_from_parent NOT IN (0,1)
          OR NEW.copy_missing_from_parent NOT IN (0,1)
          OR ((NEW.node_role IN ('original','artifact','workflow') OR NEW.relation_kind='auxiliary') AND (
            NEW.tracking_enabled!=0 OR NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0 OR NEW.tracking_state!='disabled'))
          OR (NEW.tracking_enabled=0 AND (NEW.rename_from_parent!=0 OR NEW.copy_missing_from_parent!=0))
        BEGIN SELECT RAISE(ABORT,'invalid V3 tracking policy'); END;

        CREATE TRIGGER progress_folders_v2_cycle_insert
        BEFORE INSERT ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE descendants(id) AS (
            SELECT NEW.id
            UNION
            SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id
            UNION
            SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
          ) SELECT 1 FROM descendants WHERE id=NEW.parent_progress_id
        ) BEGIN SELECT RAISE(ABORT,'version graph cycle'); END;

        CREATE TRIGGER progress_folders_v2_cycle_update
        BEFORE UPDATE OF parent_progress_id ON progress_folders WHEN NEW.parent_progress_id IS NOT NULL AND EXISTS(
          WITH RECURSIVE descendants(id) AS (
            SELECT NEW.id
            UNION
            SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id
            UNION
            SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
          ) SELECT 1 FROM descendants WHERE id=NEW.parent_progress_id
        ) BEGIN SELECT RAISE(ABORT,'version graph cycle'); END;

        CREATE TRIGGER version_graph_edges_validate_insert
        BEFORE INSERT ON version_graph_edges WHEN
          NEW.source_progress_id=NEW.target_progress_id
          OR NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id)
          OR NOT EXISTS(
            SELECT 1 FROM progress_folders source JOIN progress_folders target
              ON target.id=NEW.target_progress_id
            WHERE source.id=NEW.source_progress_id
              AND source.project_id=NEW.project_id AND target.project_id=NEW.project_id
              AND source.media_kind=target.media_kind
              AND (
                (NEW.edge_kind='media_companion' AND source.node_role='original' AND target.node_role='original' AND target.artifact_kind='companion')
                OR (NEW.edge_kind='derived_preview' AND source.node_role IN ('original','progress') AND target.node_role='artifact' AND target.artifact_kind='preview')
                OR (NEW.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND target.node_role='progress') OR (source.node_role IN ('original','progress') AND target.node_role='workflow' AND target.artifact_kind='team_workspace')))
              )
          )
          OR EXISTS(
            WITH RECURSIVE descendants(id) AS (
              SELECT NEW.target_progress_id
              UNION
              SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id
              UNION
              SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
            ) SELECT 1 FROM descendants WHERE id=NEW.source_progress_id
          )
        BEGIN SELECT RAISE(ABORT,'invalid version graph edge'); END;

        CREATE TRIGGER version_graph_edges_validate_update
        BEFORE UPDATE OF project_id,source_progress_id,target_progress_id,edge_kind ON version_graph_edges WHEN
          NEW.source_progress_id=NEW.target_progress_id
          OR NOT EXISTS(
            SELECT 1 FROM progress_folders source JOIN progress_folders target
              ON target.id=NEW.target_progress_id
            WHERE source.id=NEW.source_progress_id
              AND source.project_id=NEW.project_id AND target.project_id=NEW.project_id
              AND source.media_kind=target.media_kind
              AND (
                (NEW.edge_kind='media_companion' AND source.node_role='original' AND target.node_role='original' AND target.artifact_kind='companion')
                OR (NEW.edge_kind='derived_preview' AND source.node_role IN ('original','progress') AND target.node_role='artifact' AND target.artifact_kind='preview')
                OR (NEW.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND target.node_role='progress') OR (source.node_role IN ('original','progress') AND target.node_role='workflow' AND target.artifact_kind='team_workspace')))
              )
          )
          OR EXISTS(
            WITH RECURSIVE descendants(id) AS (
              SELECT NEW.target_progress_id
              UNION
              SELECT child.id FROM progress_folders child JOIN descendants ON child.parent_progress_id=descendants.id
              UNION
              SELECT edge.target_progress_id FROM version_graph_edges edge JOIN descendants ON edge.source_progress_id=descendants.id
              WHERE edge.id!=OLD.id
            ) SELECT 1 FROM descendants WHERE id=NEW.source_progress_id
        )
        BEGIN SELECT RAISE(ABORT,'invalid version graph edge'); END;

        CREATE TRIGGER progress_folders_graph_endpoint_update
        BEFORE UPDATE OF project_id,media_kind,node_role,artifact_kind ON progress_folders WHEN
          EXISTS(
            SELECT 1 FROM version_graph_edges edge JOIN progress_folders target ON target.id=edge.target_progress_id
            WHERE edge.source_progress_id=OLD.id AND NOT(
              NEW.project_id=edge.project_id AND target.project_id=edge.project_id
              AND NEW.media_kind=target.media_kind AND (
                (edge.edge_kind='media_companion' AND NEW.node_role='original' AND target.node_role='original' AND target.artifact_kind='companion')
                OR (edge.edge_kind='derived_preview' AND NEW.node_role IN ('original','progress') AND target.node_role='artifact' AND target.artifact_kind='preview')
                OR (edge.edge_kind='workflow_input' AND ((NEW.node_role IN ('selection','workflow') AND target.node_role='progress') OR (NEW.node_role IN ('original','progress') AND target.node_role='workflow' AND target.artifact_kind='team_workspace')))
              )
            )
          )
          OR EXISTS(
            SELECT 1 FROM version_graph_edges edge JOIN progress_folders source ON source.id=edge.source_progress_id
            WHERE edge.target_progress_id=OLD.id AND NOT(
              NEW.project_id=edge.project_id AND source.project_id=edge.project_id
              AND source.media_kind=NEW.media_kind AND (
                (edge.edge_kind='media_companion' AND source.node_role='original' AND NEW.node_role='original' AND NEW.artifact_kind='companion')
                OR (edge.edge_kind='derived_preview' AND source.node_role IN ('original','progress') AND NEW.node_role='artifact' AND NEW.artifact_kind='preview')
                OR (edge.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND NEW.node_role='progress') OR (source.node_role IN ('original','progress') AND NEW.node_role='workflow' AND NEW.artifact_kind='team_workspace')))
              )
            )
          )
        BEGIN SELECT RAISE(ABORT,'invalid version graph endpoint update'); END;
        """
    )


def _migration_25(db):
    """Persist importer-provided artifact semantics independently from node display metadata."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS media_import_artifact_slots (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          progress_id TEXT NOT NULL REFERENCES progress_folders(id) ON DELETE CASCADE,
          import_slot TEXT NOT NULL CHECK(import_slot IN ('raw','camera_jpg','generated_jpg','mov','video_preview')),
          relative_path_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, progress_id),
          UNIQUE(project_id, relative_path_key)
        );
        CREATE INDEX IF NOT EXISTS media_import_artifact_slots_kind
          ON media_import_artifact_slots(project_id, import_slot, updated_at, progress_id);

        DROP TRIGGER IF EXISTS media_import_artifact_slots_validate_insert;
        DROP TRIGGER IF EXISTS media_import_artifact_slots_validate_update;
        CREATE TRIGGER media_import_artifact_slots_validate_insert
        BEFORE INSERT ON media_import_artifact_slots WHEN NOT EXISTS (
          SELECT 1 FROM progress_folders progress
          WHERE progress.id=NEW.progress_id AND progress.project_id=NEW.project_id
        )
        BEGIN SELECT RAISE(ABORT,'import artifact slot project mismatch'); END;
        CREATE TRIGGER media_import_artifact_slots_validate_update
        BEFORE UPDATE OF project_id,progress_id ON media_import_artifact_slots WHEN NOT EXISTS (
          SELECT 1 FROM progress_folders progress
          WHERE progress.id=NEW.progress_id AND progress.project_id=NEW.project_id
        )
        BEGIN SELECT RAISE(ABORT,'import artifact slot project mismatch'); END;
        """
    )
    workspace_root = _meta_value(db, "workspace_root")
    if not workspace_root or not _table_exists(db, "media_import_graph_sessions"):
        return
    projects = {row["id"]: row for row in db.execute("SELECT id,relative_path FROM projects").fetchall()}
    for session in db.execute("SELECT project_id,manifest_json,updated_at FROM media_import_graph_sessions").fetchall():
        project = projects.get(session["project_id"])
        if project is None:
            continue
        try:
            manifest = json.loads(session["manifest_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        artifacts = manifest.get("artifacts")
        if not isinstance(artifacts, list):
            continue
        slots_by_path = {}
        for item in artifacts:
            if isinstance(item, dict) and item.get("importSlot") in IMPORT_ARTIFACT_SLOTS:
                try:
                    slots_by_path[_import_relative_path(item.get("relativePath")).casefold()] = item["importSlot"]
                except ValueError:
                    pass
        # Legacy schema-24 manifests can only be backfilled when their explicit
        # relation endpoints or media kind make the slot unambiguous.
        for relation in manifest.get("relations") if isinstance(manifest.get("relations"), list) else []:
            if not isinstance(relation, dict):
                continue
            try:
                source_key = _import_relative_path(relation.get("sourceRelativePath")).casefold()
                target_key = _import_relative_path(relation.get("targetRelativePath")).casefold()
            except ValueError:
                continue
            if relation.get("edgeKind") == "media_companion":
                slots_by_path[source_key] = "raw"
                slots_by_path[target_key] = "camera_jpg"
            elif relation.get("edgeKind") == "derived_preview":
                target_artifact = next((item for item in artifacts if isinstance(item, dict)
                                        and str(item.get("relativePath") or "").replace("\\", "/").strip("/").casefold() == target_key), None)
                if target_artifact and target_artifact.get("mediaKind") == "video":
                    slots_by_path[source_key] = "mov"
                    slots_by_path[target_key] = "video_preview"
                elif target_artifact and target_artifact.get("mediaKind") == "image":
                    slots_by_path[source_key] = "raw"
                    slots_by_path[target_key] = "generated_jpg"
        for item in artifacts:
            if not isinstance(item, dict):
                continue
            try:
                relative_path = _import_relative_path(item.get("relativePath"))
            except ValueError:
                continue
            path_key = relative_path.casefold()
            slot = slots_by_path.get(path_key)
            if slot is None and item.get("mediaKind") == "video" and item.get("nodeRole") == "original":
                slot = "mov"
            if slot is None:
                continue
            folder_path = canonical_path(os.path.join(workspace_root, project["relative_path"], *relative_path.split("/")))
            progress = db.execute(
                "SELECT * FROM progress_folders WHERE project_id=? AND folder_path_key=?",
                (project["id"], folder_path.casefold()),
            ).fetchone()
            if progress is None:
                continue
            expected = IMPORT_ARTIFACT_SLOT_SHAPES[slot]
            if (progress["media_kind"], progress["node_role"], progress["artifact_kind"]) != expected:
                continue
            existing = db.execute(
                "SELECT * FROM media_import_artifact_slots WHERE project_id=? AND relative_path_key=?",
                (project["id"], path_key),
            ).fetchone()
            timestamp = int(session["updated_at"] or 0)
            if existing is None:
                db.execute(
                    """INSERT INTO media_import_artifact_slots(
                         project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
                       VALUES(?,?,?,?,?,?)""",
                    (project["id"], progress["id"], slot, path_key, timestamp, timestamp),
                )
            elif existing["progress_id"] == progress["id"] and existing["import_slot"] == "generated_jpg" and slot == "camera_jpg":
                db.execute(
                    "UPDATE media_import_artifact_slots SET import_slot='camera_jpg',updated_at=? WHERE project_id=? AND progress_id=?",
                    (timestamp, project["id"], progress["id"]),
                )


MIGRATIONS = {
    11: _migration_11,
    12: _migration_12,
    13: _migration_13,
    14: _migration_14,
    15: _migration_15,
    16: _migration_16,
    17: _migration_17,
    18: _migration_18,
    19: _migration_19,
    20: _migration_20,
    21: _migration_21,
    22: _migration_22,
    23: _migration_23,
    24: _migration_24,
    25: _migration_25,
}


def _check_integrity(db, force: bool = False):
    now = int(time.time() * 1000)
    last_check = int(_meta_value(db, "last_integrity_check_at") or 0)
    if not force and now - last_check < INTEGRITY_CHECK_INTERVAL_MS:
        return
    quick_check = [row[0] for row in db.execute("PRAGMA quick_check").fetchall()]
    foreign_key_errors = db.execute("PRAGMA foreign_key_check").fetchall()
    business_checks = {
        "photos.current_version": """SELECT COUNT(*) FROM photos WHERE current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM versions WHERE versions.id=photos.current_version_id AND versions.photo_id=photos.id AND versions.is_deleted=0)""",
        "versions.parent": """SELECT COUNT(*) FROM versions child WHERE parent_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM versions parent WHERE parent.id=child.parent_version_id AND parent.photo_id=child.photo_id)""",
        "version_batches.parent": """SELECT COUNT(*) FROM version_batches child WHERE parent_batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM version_batches parent WHERE parent.id=child.parent_batch_id AND parent.project_id=child.project_id)""",
        "progress_folders.parent": """SELECT COUNT(*) FROM progress_folders child WHERE parent_progress_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM progress_folders parent WHERE parent.id=child.parent_progress_id AND parent.project_id=child.project_id AND parent.media_kind=child.media_kind)""",
        "progress_folders.v2_shape": """SELECT COUNT(*) FROM progress_folders WHERE
          node_role NOT IN ('original','progress','selection','artifact','workflow')
          OR (relation_kind IS NOT NULL AND relation_kind NOT IN ('main','auxiliary'))
          OR (artifact_kind IS NOT NULL AND artifact_kind NOT IN ('companion','preview','team_workspace'))
          OR (parent_progress_id IS NULL) != (relation_kind IS NULL)
          OR (node_role='original' AND (parent_progress_id IS NOT NULL OR artifact_kind NOT IN ('companion')))
          OR (node_role='selection' AND (relation_kind!='auxiliary' OR artifact_kind IS NOT NULL))
          OR (node_role='progress' AND ((parent_progress_id IS NOT NULL AND relation_kind!='main') OR artifact_kind IS NOT NULL))
          OR (node_role='artifact' AND (parent_progress_id IS NOT NULL OR relation_kind IS NOT NULL OR artifact_kind NOT IN ('companion','preview')))
          OR (node_role='workflow' AND (parent_progress_id IS NOT NULL OR relation_kind IS NOT NULL OR artifact_kind!='team_workspace'))""",
        "progress_folders.v2_policy": """SELECT COUNT(*) FROM progress_folders WHERE
          tracking_state NOT IN ('disabled','pending_compare','pending_confirm','committing','ready','stale','needs_repair')
          OR tracking_enabled NOT IN (0,1) OR rename_from_parent NOT IN (0,1) OR copy_missing_from_parent NOT IN (0,1)
          OR ((node_role IN ('original','artifact','workflow') OR relation_kind='auxiliary') AND
              (tracking_enabled!=0 OR rename_from_parent!=0 OR copy_missing_from_parent!=0 OR tracking_state!='disabled'))
          OR (tracking_enabled=0 AND (rename_from_parent!=0 OR copy_missing_from_parent!=0))""",
        "progress_folders.v2_parent_role": """SELECT COUNT(*) FROM progress_folders child
          WHERE child.parent_progress_id IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM progress_folders parent WHERE parent.id=child.parent_progress_id
              AND parent.project_id=child.project_id AND parent.media_kind=child.media_kind
              AND parent.node_role IN ('original','progress'))""",
        "version_graph_edges.owner_kind": """SELECT COUNT(*) FROM version_graph_edges edge
          WHERE edge.edge_kind NOT IN ('media_companion','derived_preview','workflow_input') OR NOT EXISTS(
            SELECT 1 FROM progress_folders source JOIN progress_folders target ON target.id=edge.target_progress_id
            WHERE source.id=edge.source_progress_id AND source.project_id=edge.project_id
              AND target.project_id=edge.project_id AND source.media_kind=target.media_kind
              AND ((edge.edge_kind='media_companion' AND source.node_role='original' AND target.node_role='original' AND target.artifact_kind='companion')
                OR (edge.edge_kind='derived_preview' AND source.node_role IN ('original','progress') AND target.node_role='artifact' AND target.artifact_kind='preview')
                OR (edge.edge_kind='workflow_input' AND ((source.node_role IN ('selection','workflow') AND target.node_role='progress') OR (source.node_role IN ('original','progress') AND target.node_role='workflow' AND target.artifact_kind='team_workspace'))))
          )""",
        "media_import_artifact_slots.owner_kind": """SELECT COUNT(*) FROM media_import_artifact_slots slot
          WHERE NOT EXISTS(SELECT 1 FROM progress_folders progress WHERE progress.id=slot.progress_id
            AND progress.project_id=slot.project_id AND (
              (slot.import_slot='raw' AND progress.media_kind='image' AND progress.node_role='original' AND progress.artifact_kind IS NULL)
              OR (slot.import_slot='camera_jpg' AND progress.media_kind='image' AND progress.node_role='original' AND progress.artifact_kind='companion')
              OR (slot.import_slot='generated_jpg' AND progress.media_kind='image' AND progress.node_role='artifact' AND progress.artifact_kind='preview')
              OR (slot.import_slot='mov' AND progress.media_kind='video' AND progress.node_role='original' AND progress.artifact_kind IS NULL)
              OR (slot.import_slot='video_preview' AND progress.media_kind='video' AND progress.node_role='artifact' AND progress.artifact_kind='preview')
            ))""",
        "batch_items.owner": """SELECT COUNT(*) FROM batch_items item WHERE NOT EXISTS(SELECT 1 FROM version_batches batch JOIN photos ON photos.project_id=batch.project_id JOIN versions ON versions.photo_id=photos.id WHERE batch.id=item.batch_id AND photos.id=item.photo_id AND versions.id=item.version_id)""",
        "team_retouch_photos.owner": """SELECT COUNT(*) FROM team_retouch_photos item WHERE NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.project_id=item.project_id AND photos.id=item.photo_id AND versions.id=item.base_version_id)""",
        "team_person_assignments.owner": """SELECT COUNT(*) FROM team_person_assignments item WHERE NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.project_id=item.project_id AND photos.id=item.photo_id AND versions.id=item.base_version_id) OR (item.identity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM team_person_identities identity WHERE identity.id=item.identity_id AND identity.project_id=item.project_id))""",
        "team_person_exclusions.owner": """SELECT COUNT(*) FROM team_person_exclusions item WHERE NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.project_id=item.project_id AND photos.id=item.photo_id AND versions.id=item.base_version_id)""",
    }
    business_errors = {name: db.execute(query).fetchone()[0] for name, query in business_checks.items()}
    progress_cycles = _progress_relation_cycles(db)
    if progress_cycles:
        business_errors["progress_folders.v2_cycle"] = len(progress_cycles)
    version_graph_cycle_nodes = _version_graph_cycle_nodes(db)
    if version_graph_cycle_nodes:
        business_errors["version_graph_edges.cycle"] = len(version_graph_cycle_nodes)
    business_errors = {name: count for name, count in business_errors.items() if count}
    if quick_check != ["ok"] or foreign_key_errors or business_errors:
        raise RuntimeError(
            f"数据库完整性检查失败：quick_check={quick_check[:3]}，foreign_key_errors={len(foreign_key_errors)}，business_errors={business_errors}"
        )
    _set_meta(db, "last_integrity_check_at", now)
    _set_meta(db, "last_integrity_check_result", "ok")
    db.commit()


def connect(root: str, database: str):
    root = os.path.abspath(root)
    database = os.path.abspath(database)
    os.makedirs(os.path.dirname(database), exist_ok=True)
    db = sqlite3.connect(database, timeout=SQLITE_BUSY_TIMEOUT_MS / 1000)
    db.row_factory = sqlite3.Row
    # The catalog and media workers intentionally share this database. Give a
    # short-lived writer time to finish instead of surfacing SQLITE_BUSY to the
    # UI, and avoid requesting the WAL transition again after initialization:
    # changing journal mode itself needs an exclusive database lock.
    db.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
    journal_mode = db.execute("PRAGMA journal_mode").fetchone()[0]
    if str(journal_mode).casefold() != "wal":
        db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    existing_tables = {
        row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.commit()
    schema_value = _meta_value(db, "schema_version")
    schema_version = int(schema_value or 0)
    is_fresh = not (existing_tables - {"meta"})
    if schema_version > TARGET_SCHEMA_VERSION:
        db.close()
        raise RuntimeError(f"数据库版本 {schema_version} 高于当前软件支持的 {TARGET_SCHEMA_VERSION}")
    backup_path = None
    if not is_fresh and schema_version < TARGET_SCHEMA_VERSION:
        backup_path = _backup_before_migration(db, database, schema_version)
    # Migrations that reconcile trusted relative paths must use the workspace
    # root from this connection, including after the workspace has moved.
    _set_meta(db, "workspace_root", root)
    db.executescript("""
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            status TEXT NOT NULL,
            relative_path TEXT NOT NULL UNIQUE,
            filesystem_id TEXT,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','missing')),
            missing_since INTEGER,
            missing_checks INTEGER NOT NULL DEFAULT 0 CHECK(missing_checks>=0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            extra_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS project_properties (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (project_id, key)
        );
        CREATE TABLE IF NOT EXISTS project_tags (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            value_json TEXT NOT NULL DEFAULT 'true',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (project_id, tag)
        );
        CREATE TABLE IF NOT EXISTS photos (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            media_type TEXT NOT NULL,
            original_name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            current_version_id TEXT,
            original_file_path TEXT NOT NULL,
            original_file_id TEXT,
            original_fingerprint TEXT,
            capture_time INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS photos_project ON photos(project_id, is_deleted);
        CREATE TABLE IF NOT EXISTS versions (
            id TEXT PRIMARY KEY,
            photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            parent_version_id TEXT REFERENCES versions(id),
            version_number INTEGER NOT NULL,
            version_name TEXT NOT NULL,
            version_type TEXT NOT NULL DEFAULT 'custom',
            file_path TEXT NOT NULL,
            file_path_key TEXT NOT NULL,
            file_id TEXT,
            file_fingerprint TEXT,
            file_size INTEGER NOT NULL DEFAULT 0,
            file_modified_at INTEGER,
            thumbnail_path TEXT,
            author TEXT,
            note TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'draft',
            is_current INTEGER NOT NULL DEFAULT 0,
            is_final INTEGER NOT NULL DEFAULT 0,
            file_missing INTEGER NOT NULL DEFAULT 0,
            content_changed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            UNIQUE(photo_id, version_number)
        );
        CREATE INDEX IF NOT EXISTS versions_photo ON versions(photo_id, version_number);
        CREATE INDEX IF NOT EXISTS versions_parent ON versions(parent_version_id);
        CREATE INDEX IF NOT EXISTS versions_file_identity ON versions(file_id);
        CREATE INDEX IF NOT EXISTS versions_file_path_key ON versions(file_path_key);
        CREATE INDEX IF NOT EXISTS versions_fingerprint ON versions(file_fingerprint);
        CREATE TABLE IF NOT EXISTS version_batches (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            display_name TEXT NOT NULL,
            source_folder_path TEXT NOT NULL,
            source_folder_path_key TEXT NOT NULL,
            source_folder_id TEXT,
            parent_batch_id TEXT REFERENCES version_batches(id),
            import_key TEXT UNIQUE,
            status TEXT NOT NULL DEFAULT 'ready',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(project_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS version_batches_project ON version_batches(project_id, sequence);
        CREATE INDEX IF NOT EXISTS version_batches_parent ON version_batches(parent_batch_id);
        CREATE INDEX IF NOT EXISTS version_batches_folder ON version_batches(project_id, source_folder_path_key);
        CREATE INDEX IF NOT EXISTS version_batches_folder_id ON version_batches(project_id, source_folder_id);
        CREATE TABLE IF NOT EXISTS progress_folders (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            media_kind TEXT NOT NULL,
            version_key TEXT NOT NULL,
            parent_progress_id TEXT REFERENCES progress_folders(id),
            display_name TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            folder_path_key TEXT NOT NULL,
            folder_id TEXT,
            node_role TEXT NOT NULL DEFAULT 'progress',
            artifact_kind TEXT,
            relation_kind TEXT,
            tracking_enabled INTEGER NOT NULL DEFAULT 0,
            tracking_state TEXT NOT NULL DEFAULT 'disabled',
            rename_from_parent INTEGER NOT NULL DEFAULT 0,
            copy_missing_from_parent INTEGER NOT NULL DEFAULT 0,
            last_tracked_at INTEGER,
            tracking_snapshot_json TEXT NOT NULL DEFAULT '{}',
            folder_signature TEXT,
            missing_since INTEGER,
            tombstone_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(project_id, media_kind, version_key)
        );
        CREATE INDEX IF NOT EXISTS progress_folders_project ON progress_folders(project_id, media_kind, version_key);
        CREATE INDEX IF NOT EXISTS progress_folders_parent ON progress_folders(parent_progress_id);
        CREATE INDEX IF NOT EXISTS progress_folders_identity ON progress_folders(project_id, folder_id);
        CREATE TABLE IF NOT EXISTS batch_file_operations (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES version_batches(id) ON DELETE CASCADE,
            operation_type TEXT NOT NULL CHECK(operation_type IN ('rename','copy')),
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','skipped')),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
            error TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(batch_id, operation_type, source_path, target_path)
        );
        CREATE INDEX IF NOT EXISTS batch_file_operations_batch
          ON batch_file_operations(batch_id, status, created_at);
        CREATE TABLE IF NOT EXISTS batch_items (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES version_batches(id) ON DELETE CASCADE,
            photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            version_id TEXT NOT NULL REFERENCES versions(id),
            source_name TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_path_key TEXT NOT NULL,
            source_file_id TEXT,
            source_fingerprint TEXT,
            match_method TEXT NOT NULL DEFAULT 'new',
            match_distance REAL,
            confidence TEXT NOT NULL DEFAULT '',
            review_status TEXT NOT NULL DEFAULT 'confirmed',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(batch_id, version_id),
            UNIQUE(batch_id, source_path_key)
        );
        CREATE INDEX IF NOT EXISTS batch_items_photo ON batch_items(photo_id, batch_id);
        CREATE INDEX IF NOT EXISTS batch_items_batch ON batch_items(batch_id);
        CREATE INDEX IF NOT EXISTS batch_items_version ON batch_items(version_id);
        CREATE INDEX IF NOT EXISTS batch_items_source_file ON batch_items(source_file_id);
        CREATE TABLE IF NOT EXISTS file_records (
            id TEXT PRIMARY KEY,
            owner_type TEXT NOT NULL CHECK(owner_type='version'),
            owner_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
            current_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            extension TEXT NOT NULL,
            windows_file_id TEXT,
            volume_id TEXT,
            file_size INTEGER NOT NULL CHECK(file_size>=0),
            modified_at INTEGER,
            quick_hash TEXT,
            full_hash TEXT,
            missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN (0,1)),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(owner_type, owner_id)
        );
        CREATE TABLE IF NOT EXISTS version_compare_history (
            id TEXT PRIMARY KEY,
            photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            left_version_id TEXT NOT NULL REFERENCES versions(id),
            right_version_id TEXT NOT NULL REFERENCES versions(id),
            compare_mode TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS version_compare_history_photo ON version_compare_history(photo_id);
        CREATE INDEX IF NOT EXISTS version_compare_history_left ON version_compare_history(left_version_id);
        CREATE INDEX IF NOT EXISTS version_compare_history_right ON version_compare_history(right_version_id);
        CREATE TABLE IF NOT EXISTS team_patch_tasks (
            id TEXT PRIMARY KEY,
            photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            base_version_id TEXT NOT NULL REFERENCES versions(id),
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
            merged_version_id TEXT REFERENCES versions(id),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS team_patch_photo ON team_patch_tasks(photo_id, base_version_id, is_deleted);
        CREATE INDEX IF NOT EXISTS team_patch_base_version ON team_patch_tasks(base_version_id);
        CREATE INDEX IF NOT EXISTS team_patch_merged_version ON team_patch_tasks(merged_version_id);
        CREATE TABLE IF NOT EXISTS team_retouch_photos (
            photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            base_version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_retouch_photo_project ON team_retouch_photos(project_id, updated_at);
        CREATE TABLE IF NOT EXISTS team_person_identities (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#2563eb',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_person_identity_project ON team_person_identities(project_id, created_at);
        CREATE TABLE IF NOT EXISTS team_person_assignments (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            base_version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
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
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            base_version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
            bbox_json TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT 'false-positive',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_person_exclusion_photo
            ON team_person_exclusions(photo_id, base_version_id, created_at);
        CREATE TABLE IF NOT EXISTS undo_records (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'ready',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS undo_records_ready ON undo_records(state, created_at DESC);
    """)
    if is_fresh:
        with db:
            _migration_13(db)
            _migration_18(db)
            _migration_19(db)
            _migration_20(db)
            _migration_21(db)
            _migration_22(db)
            _migration_23(db)
            _migration_24(db)
            _migration_25(db)
            _set_meta(db, "schema_version", TARGET_SCHEMA_VERSION)
    else:
        for next_version in range(schema_version + 1, TARGET_SCHEMA_VERSION + 1):
            migration = MIGRATIONS.get(next_version)
            if migration is None:
                db.close()
                raise RuntimeError(f"缺少数据库迁移：{next_version}")
            with db:
                migration(db)
                _set_meta(db, "schema_version", next_version)
    # Schema 24 was still under active development when import graph sessions
    # and original/companion nodes were added. Apply this idempotent revision
    # once so databases opened by an earlier schema-24 build are upgraded too.
    if _meta_value(db, "schema_24_graph_revision") != "3":
        with db:
            _migration_24(db)
            _set_meta(db, "schema_24_graph_revision", "3")
    # Early V2 builds stored the first ordinary progress structurally below a
    # selection. The V2 graph model requires the ordinary progress to remain on
    # the original's main chain and represents selection participation with a
    # supplemental workflow_input edge. Repair that invalid shape before an
    # integrity check can reject the database.
    if _meta_value(db, "selection_mainline_repair_revision") != SELECTION_MAINLINE_REPAIR_REVISION:
        with db:
            project_ids = [row[0] for row in db.execute("SELECT id FROM projects WHERE is_deleted=0").fetchall()]
            for project_id in project_ids:
                repair_selection_workflow_mainlines(db, project_id)
            _set_meta(db, "selection_mainline_repair_revision", SELECTION_MAINLINE_REPAIR_REVISION)
    # Layout revision 2 changes the canonical tree from stacked legacy lanes to
    # left-to-right media mainlines. Persisted coordinates have no auto/manual
    # provenance, so invalidate them once and let the revision-safe layout API
    # reject saves from pages that still hold an older layout revision.
    if _meta_value(db, "version_tree_default_layout_revision") != VERSION_TREE_DEFAULT_LAYOUT_REVISION:
        with db:
            db.execute("DELETE FROM version_tree_layouts")
            _set_meta(db, "version_tree_default_layout_revision", VERSION_TREE_DEFAULT_LAYOUT_REVISION)
    _set_meta(db, "workspace_root", root)
    if backup_path:
        _set_meta(db, "last_migration_backup", backup_path)
    db.commit()
    # A fresh database and a migration must be verified before it is exposed.
    # Routine daily maintenance is dispatched by Electron on a separate worker
    # so opening the project list never waits for a full integrity scan/backup.
    if backup_path or is_fresh:
        _check_integrity(db, force=True)
    return db


def connect_read_only(database: str):
    """Open the catalog without schema writes so WAL readers never need the writer slot."""
    database = os.path.abspath(database)
    uri = f"{Path(database).resolve().as_uri()}?mode=ro"
    db = sqlite3.connect(uri, uri=True, timeout=SQLITE_BUSY_TIMEOUT_MS / 1000)
    db.row_factory = sqlite3.Row
    db.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
    db.execute("PRAGMA query_only=ON")
    return db


def database_needs_initialization(database: str) -> bool:
    if not os.path.isfile(database):
        return True
    try:
        db = connect_read_only(database)
        try:
            row = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            return row is None or int(row["value"] or 0) != TARGET_SCHEMA_VERSION
        finally:
            db.close()
    except (sqlite3.Error, ValueError):
        return True


def directory_identity(path: str):
    try:
        stat = os.stat(path)
        return f"{stat.st_dev}:{stat.st_ino}" if stat.st_ino else None
    except OSError:
        return None


def canonical_path(value: str) -> str:
    # Preserve the user's path casing for display. Case-insensitive matching is
    # handled separately by `file_path_key`, never by the visible path value.
    return os.path.normpath(os.path.abspath(value))


def is_project_descendant(candidate_path: str, project_path: str) -> bool:
    """Return True only for an existing path strictly inside the project."""
    candidate = canonical_path(candidate_path)
    project = canonical_path(project_path)
    if candidate.casefold() == project.casefold():
        return False
    try:
        return os.path.commonpath((candidate, project)).casefold() == project.casefold()
    except ValueError:
        return False


def media_type(path: str):
    extension = os.path.splitext(path)[1].lower()
    if extension in IMAGE_EXTENSIONS:
        return "image"
    if extension in VIDEO_EXTENSIONS:
        return "video"
    return None


def file_identity(path: str):
    try:
        stat = os.stat(path)
        if not stat.st_ino:
            return None
        return f"{stat.st_dev}:{stat.st_ino}"
    except OSError:
        return None


def quick_fingerprint(path: str, stat: os.stat_result | None = None) -> str:
    """A rename-safe, inexpensive identity hint for cross-volume moves."""
    stat = stat or os.stat(path)
    digest = hashlib.sha256()
    digest.update(str(stat.st_size).encode("ascii"))
    sample_size = 128 * 1024
    with open(path, "rb") as source:
        digest.update(source.read(sample_size))
        if stat.st_size > sample_size:
            source.seek(max(0, stat.st_size - sample_size))
            digest.update(source.read(sample_size))
    return digest.hexdigest()


def full_fingerprint(path: str) -> str:
    """Authoritative content identity used after the quick candidate filter."""
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def queue_full_fingerprint(pending_hashes, version_id: str, file_path: str, stat: os.stat_result):
    """Queue one authoritative hash without reading the file while a DB write is open."""
    if pending_hashes is None:
        return
    path = canonical_path(file_path)
    request = {
        "versionId": version_id,
        "filePath": path,
        "fileSize": stat.st_size,
        "modifiedAt": int(stat.st_mtime_ns / 1_000_000),
    }
    for index, existing in enumerate(pending_hashes):
        if existing["versionId"] == version_id:
            pending_hashes[index] = request
            return
    pending_hashes.append(request)


def backfill_full_fingerprints(db, requests: list[dict]):
    """Hash files with no write transaction held, then persist each result briefly."""
    completed = 0
    for request in requests:
        try:
            db.commit()
            version_id = str(request["versionId"])
            file_path = canonical_path(request["filePath"])
            expected_size = int(request["fileSize"])
            expected_mtime = int(request["modifiedAt"])
            record = db.execute(
                """SELECT current_path,file_size,modified_at,full_hash FROM file_records
                   WHERE owner_type='version' AND owner_id=?""",
                (version_id,),
            ).fetchone()
            if (record is None or record["full_hash"]
                    or canonical_path(record["current_path"]).casefold() != file_path.casefold()
                    or record["file_size"] != expected_size or record["modified_at"] != expected_mtime):
                continue
            before = os.stat(file_path)
            if before.st_size != expected_size or int(before.st_mtime_ns / 1_000_000) != expected_mtime:
                continue
            authoritative_hash = full_fingerprint(file_path)
            after = os.stat(file_path)
            if after.st_size != expected_size or int(after.st_mtime_ns / 1_000_000) != expected_mtime:
                continue
            current = db.execute(
                """SELECT current_path,file_size,modified_at,full_hash FROM file_records
                   WHERE owner_type='version' AND owner_id=?""",
                (version_id,),
            ).fetchone()
            if (current is None or current["full_hash"]
                    or canonical_path(current["current_path"]).casefold() != file_path.casefold()
                    or current["file_size"] != expected_size or current["modified_at"] != expected_mtime):
                continue
            db.execute(
                """UPDATE file_records SET full_hash=?,updated_at=?
                   WHERE owner_type='version' AND owner_id=?""",
                (authoritative_hash, int(time.time() * 1000), version_id),
            )
            db.commit()
            completed += 1
        except (FileNotFoundError, PermissionError, OSError, sqlite3.Error):
            db.rollback()
    return completed


def project_row(db, project_name: str):
    row = db.execute("SELECT * FROM projects WHERE name=? COLLATE NOCASE AND status != ''", (project_name,)).fetchone()
    if row is None:
        raise ValueError("项目未登记，请先刷新项目列表")
    return row


def serialize_photo(row):
    if row is None:
        return None
    return {
        "id": row["id"], "projectId": row["project_id"], "mediaType": row["media_type"],
        "originalName": row["original_name"], "displayName": row["display_name"],
        "currentVersionId": row["current_version_id"], "originalFilePath": row["original_file_path"],
        "captureTime": row["capture_time"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def serialize_version(row):
    return {
        "id": row["id"], "photoId": row["photo_id"], "parentVersionId": row["parent_version_id"],
        "versionNumber": row["version_number"], "versionName": row["version_name"],
        "versionType": row["version_type"], "filePath": row["file_path"],
        "fileSize": row["file_size"], "fileModifiedAt": row["file_modified_at"],
        "thumbnailPath": row["thumbnail_path"], "author": row["author"], "note": row["note"],
        "status": row["status"], "isCurrent": bool(row["is_current"]), "isFinal": bool(row["is_final"]),
        "fileMissing": bool(row["file_missing"]), "contentChanged": bool(row["content_changed"]),
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def media_bundle(db, photo_id: str):
    photo = db.execute("SELECT * FROM photos WHERE id=? AND is_deleted=0", (photo_id,)).fetchone()
    versions = db.execute(
        "SELECT * FROM versions WHERE photo_id=? AND is_deleted=0 ORDER BY version_number, created_at", (photo_id,)
    ).fetchall()
    next_version_number = db.execute(
        "SELECT COALESCE(MAX(version_number), -1)+1 FROM versions WHERE photo_id=?", (photo_id,)
    ).fetchone()[0]
    return {
        "photo": serialize_photo(photo), "versions": [serialize_version(row) for row in versions],
        "nextVersionNumber": next_version_number,
    }


def upsert_file_record(db, owner_id: str, file_path: str, stat: os.stat_result, identity: str | None,
                       fingerprint: str, full_hash: str | None = None):
    timestamp = int(time.time() * 1000)
    record = db.execute("SELECT id, created_at FROM file_records WHERE owner_type='version' AND owner_id=?", (owner_id,)).fetchone()
    values = (
        canonical_path(file_path), os.path.basename(file_path), os.path.splitext(file_path)[1].lower(), identity,
        str(stat.st_dev), stat.st_size, int(stat.st_mtime_ns / 1_000_000), fingerprint, full_hash, timestamp,
    )
    if record:
        db.execute(
            """UPDATE file_records SET current_path=?, file_name=?, extension=?, windows_file_id=?, volume_id=?,
               file_size=?, modified_at=?, quick_hash=?, full_hash=?, missing=0, updated_at=? WHERE id=?""",
            values + (record["id"],),
        )
    else:
        db.execute(
            """INSERT INTO file_records(id,owner_type,owner_id,current_path,file_name,extension,windows_file_id,
               volume_id,file_size,modified_at,quick_hash,full_hash,missing,created_at,updated_at)
               VALUES(?,'version',?,?,?,?,?,?,?,?,?,?,0,?,?)""",
            (str(uuid.uuid4()), owner_id, *values[:-1], timestamp, timestamp),
        )


def sync_media_file(db, project, file_path: str, pending_hashes=None):
    file_path = canonical_path(file_path)
    kind = media_type(file_path)
    if not kind or not os.path.isfile(file_path):
        return None
    stat = os.stat(file_path)
    identity = file_identity(file_path)
    path_key = file_path.casefold()
    mtime_ms = int(stat.st_mtime_ns / 1_000_000)
    linked_source = db.execute(
        """SELECT batch_items.id AS item_id,batch_items.photo_id,versions.id AS version_id,
                  versions.file_path_key,versions.file_fingerprint,versions.content_changed,
                  file_records.full_hash AS stored_full_hash
           FROM batch_items
           JOIN version_batches ON version_batches.id=batch_items.batch_id
           JOIN versions ON versions.id=batch_items.version_id
           LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
           WHERE versions.is_deleted=0 AND version_batches.status IN ('importing','applying','needs_repair','ready')
             AND (batch_items.source_path_key=? OR (? IS NOT NULL AND batch_items.source_file_id=?))
           ORDER BY version_batches.sequence DESC LIMIT 1""",
        (path_key, identity, identity),
    ).fetchone()
    # A rename keeps the cached full hash. A quick-hash change invalidates it
    # and queues one replacement after the short metadata transaction commits.
    if linked_source is not None and linked_source["file_path_key"] != path_key:
        fingerprint = quick_fingerprint(file_path, stat)
        fingerprint_changed = bool(
            linked_source["file_fingerprint"] and linked_source["file_fingerprint"] != fingerprint
        )
        content_changed = bool(linked_source["content_changed"] or fingerprint_changed)
        timestamp = int(time.time() * 1000)
        db.execute(
            """UPDATE batch_items SET source_name=?, source_path=?, source_path_key=?,
               source_file_id=?, updated_at=? WHERE id=?""",
            (os.path.basename(file_path), file_path, path_key, identity, timestamp, linked_source["item_id"]),
        )
        db.execute(
            """UPDATE versions SET file_path=?,file_path_key=?,file_id=?,file_fingerprint=?,file_size=?,
               file_modified_at=?,file_missing=0,content_changed=?,
               thumbnail_path=CASE WHEN ?=1 THEN NULL ELSE thumbnail_path END,updated_at=? WHERE id=?""",
            (file_path, path_key, identity, fingerprint, stat.st_size, mtime_ms, int(content_changed),
             int(fingerprint_changed), timestamp, linked_source["version_id"]),
        )
        cached_hash = None if fingerprint_changed else linked_source["stored_full_hash"]
        upsert_file_record(db, linked_source["version_id"], file_path, stat, identity, fingerprint, cached_hash)
        if not cached_hash:
            queue_full_fingerprint(pending_hashes, linked_source["version_id"], file_path, stat)
        return linked_source["photo_id"]

    existing = None
    if identity:
        existing = db.execute(
            """SELECT versions.*,file_records.full_hash AS stored_full_hash
               FROM versions JOIN photos ON photos.id=versions.photo_id
               LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
               WHERE versions.file_id=? AND versions.is_deleted=0 AND photos.project_id=? LIMIT 1""",
            (identity, project["id"]),
        ).fetchone()
    if existing is None:
        existing = db.execute(
            """SELECT versions.*,file_records.full_hash AS stored_full_hash
               FROM versions JOIN photos ON photos.id=versions.photo_id
               LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
               WHERE versions.file_path_key=? AND versions.is_deleted=0 AND photos.project_id=? LIMIT 1""",
            (path_key, project["id"]),
        ).fetchone()

    fingerprint = None
    changed = False
    if existing is not None:
        changed = existing["file_size"] != stat.st_size or existing["file_modified_at"] != mtime_ms
        fingerprint = quick_fingerprint(file_path, stat) if (
            changed or not existing["file_fingerprint"] or existing["file_id"] != identity
        ) else existing["file_fingerprint"]
    else:
        fingerprint = quick_fingerprint(file_path, stat)
        tombstone = db.execute(
            """SELECT versions.photo_id,file_records.full_hash FROM versions
               JOIN photos ON photos.id=versions.photo_id
               LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
               WHERE versions.file_path_key=? AND versions.file_fingerprint=?
                 AND versions.is_deleted=1 AND photos.project_id=?
               ORDER BY versions.updated_at DESC LIMIT 1""",
            (path_key, fingerprint, project["id"]),
        ).fetchone()
        candidates = db.execute(
            """SELECT versions.*,file_records.full_hash AS stored_full_hash FROM versions
               JOIN photos ON photos.id=versions.photo_id
               LEFT JOIN file_records ON file_records.owner_type='version' AND file_records.owner_id=versions.id
               WHERE versions.file_fingerprint=? AND versions.is_deleted=0 AND photos.project_id=?
                 AND (versions.file_missing=1 OR NOT EXISTS (SELECT 1 FROM file_records
                   WHERE owner_type='version' AND owner_id=versions.id AND missing=0))""",
            (fingerprint, project["id"]),
        ).fetchall()
        candidate_hashes = [tombstone["full_hash"] if tombstone is not None else None]
        candidate_hashes.extend(candidate["stored_full_hash"] for candidate in candidates)
        # The expensive pass is only useful when the cheap stages produced an
        # authoritative candidate. Brand-new files are registered immediately.
        authoritative_hash = full_fingerprint(file_path) if any(candidate_hashes) else None
        if tombstone is not None and tombstone["full_hash"] == authoritative_hash:
            return tombstone["photo_id"]
        exact_candidates = [
            candidate for candidate in candidates
            if candidate["stored_full_hash"] and candidate["stored_full_hash"] == authoritative_hash
        ]
        existing = exact_candidates[0] if len(exact_candidates) == 1 else None

    timestamp = int(time.time() * 1000)
    if existing is not None:
        content_changed_now = bool(
            changed and existing["file_id"] == identity and existing["file_fingerprint"]
            and existing["file_fingerprint"] != fingerprint
        )
        content_changed = bool(existing["content_changed"] or content_changed_now)
        db.execute(
            """UPDATE versions SET file_path=?, file_path_key=?, file_id=?, file_fingerprint=?, file_size=?,
               file_modified_at=?, file_missing=0, content_changed=?,
               thumbnail_path=CASE WHEN ?=1 THEN NULL ELSE thumbnail_path END,
               updated_at=? WHERE id=?""",
            (file_path, path_key, identity, fingerprint, stat.st_size, mtime_ms, int(content_changed),
             int(content_changed_now), timestamp, existing["id"]),
        )
        db.execute(
            """UPDATE photos SET original_file_path=CASE WHEN ?=0 THEN ? ELSE original_file_path END,
               original_file_id=CASE WHEN ?=0 THEN ? ELSE original_file_id END,
               original_fingerprint=CASE WHEN ?=0 THEN ? ELSE original_fingerprint END,
               updated_at=? WHERE id=?""",
            (existing["version_number"], file_path, existing["version_number"], identity,
             existing["version_number"], fingerprint, timestamp, existing["photo_id"]),
        )
        cached_hash = None if changed else existing["stored_full_hash"]
        upsert_file_record(db, existing["id"], file_path, stat, identity, fingerprint, cached_hash)
        if not cached_hash:
            queue_full_fingerprint(pending_hashes, existing["id"], file_path, stat)
        return existing["photo_id"]

    photo_id = str(uuid.uuid4())
    version_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO photos(id,project_id,media_type,original_name,display_name,current_version_id,
           original_file_path,original_file_id,original_fingerprint,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (photo_id, project["id"], kind, os.path.basename(file_path), os.path.splitext(os.path.basename(file_path))[0],
         version_id, file_path, identity, fingerprint, timestamp, timestamp),
    )
    db.execute(
        """INSERT INTO versions(id,photo_id,parent_version_id,version_number,version_name,version_type,file_path,
           file_path_key,file_id,file_fingerprint,file_size,file_modified_at,status,is_current,created_at,updated_at)
           VALUES(?,?,NULL,0,'原片','original',?,?,?,?,?,?,'original',1,?,?)""",
        (version_id, photo_id, file_path, path_key, identity, fingerprint, stat.st_size, mtime_ms, timestamp, timestamp),
    )
    upsert_file_record(db, version_id, file_path, stat, identity, fingerprint, None)
    queue_full_fingerprint(pending_hashes, version_id, file_path, stat)
    return photo_id


def mark_missing_project_versions(db, project_id: str):
    """Refresh missing flags before matching fingerprints across volumes."""
    timestamp = int(time.time() * 1000)
    rows = db.execute(
        """SELECT versions.id, versions.file_path FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0""", (project_id,)
    ).fetchall()
    for row in rows:
        if os.path.isfile(row["file_path"]):
            continue
        db.execute("UPDATE versions SET file_missing=1, updated_at=? WHERE id=?", (timestamp, row["id"]))
        db.execute(
            "UPDATE file_records SET missing=1, updated_at=? WHERE owner_type='version' AND owner_id=?",
            (timestamp, row["id"]),
        )


def media_sync_project(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    if "availability" in project.keys() and project["availability"] == "missing":
        return {"success": True, "count": 0, "thumbnailCandidates": [], "projectUnavailable": True}
    project_path = os.path.join(os.path.abspath(root), project["relative_path"])
    # Mark disappeared sources first so a same-content file discovered on a
    # different volume can retain its Photo ID instead of becoming a duplicate.
    mark_missing_project_versions(db, project["id"])
    db.commit()
    seen_paths = set()
    created_or_updated = 0
    for directory, _directory_names, file_names in os.walk(project_path):
        for name in file_names:
            file_path = os.path.join(directory, name)
            if not media_type(file_path):
                continue
            pending_hashes = []
            try:
                if sync_media_file(db, project, file_path, pending_hashes):
                    seen_paths.add(canonical_path(file_path).casefold())
                    created_or_updated += 1
            except (FileNotFoundError, PermissionError, OSError):
                continue
            # Fingerprinting the next media file can be slow. Release SQLite's
            # single WAL writer slot before doing that work so project status
            # changes and other interactive writes stay responsive.
            db.commit()
            backfill_full_fingerprints(db, pending_hashes)
    timestamp = int(time.time() * 1000)
    version_rows = db.execute(
        """SELECT versions.id, versions.file_path, versions.file_path_key FROM versions
           JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0""", (project["id"],)
    ).fetchall()
    for row in version_rows:
        if row["file_path_key"] not in seen_paths and not os.path.isfile(row["file_path"]):
            db.execute("UPDATE versions SET file_missing=1, updated_at=? WHERE id=?", (timestamp, row["id"]))
            db.execute("UPDATE file_records SET missing=1, updated_at=? WHERE owner_type='version' AND owner_id=?", (timestamp, row["id"]))
    db.commit()
    thumbnail_rows = db.execute(
        """SELECT versions.id AS version_id, versions.photo_id, versions.file_path, versions.thumbnail_path
           FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0 AND versions.file_missing=0""",
        (project["id"],),
    ).fetchall()
    thumbnail_candidates = [
        {"versionId": row["version_id"], "photoId": row["photo_id"], "filePath": row["file_path"]}
        for row in thumbnail_rows
        if not row["thumbnail_path"] or not os.path.isfile(row["thumbnail_path"])
    ]
    return {"success": True, "count": created_or_updated, "thumbnailCandidates": thumbnail_candidates}


def media_get(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    file_path = canonical_path(payload["filePath"])
    mark_missing_project_versions(db, project["id"])
    db.commit()
    pending_hashes = []
    photo_id = sync_media_file(db, project, file_path, pending_hashes)
    db.commit()
    backfill_full_fingerprints(db, pending_hashes)
    if not photo_id:
        raise ValueError("该文件不是可追踪的图片或视频")
    return {"success": True, **media_bundle(db, photo_id)}


def media_get_photo(db, payload: dict):
    bundle = media_bundle(db, payload["photoId"])
    if not bundle["photo"]:
        raise ValueError("素材版本记录不存在")
    return {"success": True, **bundle}


def serialize_batch(row):
    return {
        "id": row["id"], "projectId": row["project_id"], "sequence": row["sequence"],
        "displayName": row["display_name"], "sourceFolderPath": row["source_folder_path"],
        "parentBatchId": row["parent_batch_id"], "parentSequence": row["parent_sequence"],
        "status": row["status"], "itemCount": row["item_count"],
        "matchedCount": row["matched_count"], "newCount": row["new_count"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def serialize_progress(row):
    tracking_state = row["tracking_state"] if "tracking_state" in row.keys() else ("ready" if row["tracking_enabled"] else "disabled")
    folder_missing = row["missing_since"] is not None if "missing_since" in row.keys() else not os.path.isdir(row["folder_path"])
    missing_since = row["missing_since"] if "missing_since" in row.keys() else None
    return {
        "id": row["id"], "projectId": row["project_id"], "mediaKind": row["media_kind"],
        "versionKey": row["version_key"], "parentProgressId": row["parent_progress_id"],
        "parentVersionKey": row["parent_version_key"], "displayName": row["display_name"],
        "folderPath": row["folder_path"], "folderMissing": folder_missing,
        "missingSince": missing_since if folder_missing else None,
        "nodeRole": row["node_role"] if "node_role" in row.keys() else "progress",
        "artifactKind": row["artifact_kind"] if "artifact_kind" in row.keys() else None,
        "relationKind": row["relation_kind"] if "relation_kind" in row.keys() else ("main" if row["parent_progress_id"] else None),
        "trackingEnabled": bool(row["tracking_enabled"]),
        "renameFromParent": bool(row["rename_from_parent"]) if "rename_from_parent" in row.keys() else False,
        "copyMissingFromParent": bool(row["copy_missing_from_parent"]) if "copy_missing_from_parent" in row.keys() else False,
        "trackingState": tracking_state,
        "lastTrackedAt": row["last_tracked_at"] if "last_tracked_at" in row.keys() else None,
        "trackingSnapshot": json.loads(row["tracking_snapshot_json"] or "{}") if "tracking_snapshot_json" in row.keys() else {},
        "folderSignature": row["folder_signature"] if "folder_signature" in row.keys() else None,
        "tombstone": json.loads(row["tombstone_json"] or "{}") if "tombstone_json" in row.keys() else {},
        "repairBatchId": row["repair_batch_id"] if "repair_batch_id" in row.keys() else None,
        "pendingOperationCount": int(row["pending_operation_count"] or 0) if "pending_operation_count" in row.keys() else 0,
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def progress_rows(db, project_id: str, include_missing: bool = True):
    missing_filter = "" if include_missing else " AND progress.missing_since IS NULL"
    return db.execute(
        f"""SELECT progress.*, parent.version_key AS parent_version_key,
           (SELECT batches.id FROM version_batches batches
              WHERE batches.project_id=progress.project_id
                AND batches.source_folder_path_key=progress.folder_path_key
                AND batches.status='needs_repair'
              ORDER BY batches.sequence DESC LIMIT 1) AS repair_batch_id,
           (SELECT COUNT(*) FROM batch_file_operations operations
              JOIN version_batches batches ON batches.id=operations.batch_id
              WHERE batches.project_id=progress.project_id
                AND batches.source_folder_path_key=progress.folder_path_key
                AND batches.status='needs_repair'
                AND operations.status IN ('pending','failed')) AS pending_operation_count
           FROM progress_folders AS progress
           LEFT JOIN progress_folders AS parent ON parent.id=progress.parent_progress_id
           WHERE progress.project_id=?{missing_filter}
           ORDER BY progress.media_kind, progress.created_at, progress.version_key""",
        (project_id,),
    ).fetchall()


def sync_progress_folder_locations(root: str, db, project, commit: bool = True):
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    existing = progress_rows(db, project["id"])
    by_identity = {row["folder_id"]: row for row in existing if row["folder_id"]}
    by_path = {row["folder_path_key"]: row for row in existing}
    timestamp = int(time.time() * 1000)
    if not os.path.isdir(project_path):
        return
    # Follow root nodes plus same-parent renames of explicitly registered
    # nested nodes. This remains bounded by the number of graph nodes and never
    # turns progress refresh into a recursive project-wide scan.
    scan_directories = {project_path}
    for row in existing:
        parent_directory = canonical_path(os.path.dirname(row["folder_path"]))
        if is_project_descendant(parent_directory, project_path) and os.path.isdir(parent_directory):
            scan_directories.add(parent_directory)
    project_entries_by_path = {}
    for directory in sorted(scan_directories):
        for entry in os.scandir(directory):
            if entry.is_dir():
                project_entries_by_path[canonical_path(entry.path).casefold()] = entry
    project_entries = list(project_entries_by_path.values())
    entry_locations = [
        (entry, canonical_path(entry.path), directory_identity(entry.path))
        for entry in project_entries
    ]
    present_identities = {identity for _entry, _folder_path, identity in entry_locations if identity}
    # Folder identity survives a rename, so only follow the physical path.
    # The user-facing progress name is independent and must remain unchanged.
    for _entry, folder_path, identity in entry_locations:
        tracked = by_identity.get(identity) if identity else None
        if tracked is None:
            path_match = by_path.get(folder_path.casefold())
            # A directory recreated at the original path gets a new filesystem
            # identity. Rebind it only when the old identity is no longer
            # present elsewhere, otherwise this is a rename plus path reuse.
            if path_match is not None and path_match["folder_id"] not in present_identities:
                tracked = path_match
        if tracked is not None and (tracked["folder_path_key"] != folder_path.casefold()
                                    or tracked["folder_id"] != identity
                                    or tracked["missing_since"] is not None):
            db.execute(
                """UPDATE progress_folders SET folder_path=?,folder_path_key=?,folder_id=?,missing_since=NULL,
                   tombstone_json='{}',updated_at=?
                   WHERE id=?""",
                (folder_path, folder_path.casefold(), identity, timestamp, tracked["id"]),
            )
            # Import graph slots are keyed by a project-relative path. Folder
            # identity is the authority after an external rename, so keep the
            # slot path in the same transaction as the progress-folder move.
            relative_path_key = os.path.relpath(folder_path, project_path).replace("\\", "/").casefold()
            db.execute(
                """UPDATE media_import_artifact_slots SET relative_path_key=?,updated_at=?
                   WHERE project_id=? AND progress_id=?""",
                (relative_path_key, timestamp, project["id"], tracked["id"]),
            )
    for row in progress_rows(db, project["id"]):
        if os.path.isdir(row["folder_path"]):
            if row["missing_since"] is not None:
                db.execute(
                    "UPDATE progress_folders SET missing_since=NULL,tombstone_json='{}',updated_at=? WHERE id=?",
                    (timestamp, row["id"]),
                )
        elif row["missing_since"] is None:
            db.execute(
                "UPDATE progress_folders SET missing_since=?,tombstone_json=?,updated_at=? WHERE id=?",
                (timestamp, json.dumps({"reason": "folder_missing", "path": row["folder_path"]}, ensure_ascii=False), timestamp, row["id"]),
            )
    if commit:
        db.commit()


def sync_legacy_progress_folders(root: str, db, project):
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    timestamp = int(time.time() * 1000)
    discovered = []
    prefixes = (("图片后期_", "image"), ("视频后期_", "video"))
    if not os.path.isdir(project_path):
        return
    project_entries = [entry for entry in os.scandir(project_path) if entry.is_dir()]
    sync_progress_folder_locations(root, db, project)
    existing = progress_rows(db, project["id"])
    by_identity = {row["folder_id"]: row for row in existing if row["folder_id"]}
    by_path = {row["folder_path_key"]: row for row in existing}
    for entry in project_entries:
        for prefix, media_kind in prefixes:
            if not entry.name.startswith(prefix):
                continue
            version_key = entry.name[len(prefix):]
            if not version_key or any(not part.isdigit() for part in version_key.split("_")):
                continue
            discovered.append((len(version_key.split("_")), tuple(int(part) for part in version_key.split("_")), entry, media_kind, version_key))
            break
    discovered.sort(key=lambda item: (item[0], item[1]))
    by_key = {(row["media_kind"], row["version_key"]): row for row in existing}
    for _depth, _parts, entry, media_kind, version_key in discovered:
        folder_path = canonical_path(entry.path)
        identity = directory_identity(folder_path)
        row = by_identity.get(identity) if identity else None
        if row is None:
            row = by_path.get(folder_path.casefold()) or by_key.get((media_kind, version_key))
        parent_key = "_".join(version_key.split("_")[:-1]) or None
        parent = by_key.get((media_kind, parent_key)) if parent_key else None
        if row is not None:
            db.execute(
                """UPDATE progress_folders SET folder_path=?,folder_path_key=?,folder_id=?,
                   parent_progress_id=COALESCE(parent_progress_id,?),
                   relation_kind=CASE WHEN COALESCE(parent_progress_id,?) IS NULL THEN NULL ELSE 'main' END,
                   missing_since=NULL,updated_at=? WHERE id=?""",
                (folder_path, folder_path.casefold(), identity, parent["id"] if parent else None,
                 parent["id"] if parent else None, timestamp, row["id"]),
            )
        else:
            progress_id = str(uuid.uuid4())
            db.execute(
                """INSERT INTO progress_folders(id,project_id,media_kind,version_key,parent_progress_id,
                   display_name,folder_path,folder_path_key,folder_id,node_role,relation_kind,
                   tracking_enabled,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,'progress',?,0,?,?)""",
                (progress_id, project["id"], media_kind, version_key, parent["id"] if parent else None,
                 entry.name, folder_path, folder_path.casefold(), identity,
                 "main" if parent else None, timestamp, timestamp),
            )
            row = db.execute("SELECT * FROM progress_folders WHERE id=?", (progress_id,)).fetchone()
        by_key[(media_kind, version_key)] = row
        by_path[folder_path.casefold()] = row
        if identity:
            by_identity[identity] = row
    db.commit()


def migrate_legacy_progress_folders_once(root: str, db, project):
    migrated = db.execute(
        "SELECT 1 FROM project_properties WHERE project_id=? AND key=?",
        (project["id"], LEGACY_PROGRESS_MIGRATION_KEY),
    ).fetchone()
    if migrated is not None:
        return
    sync_legacy_progress_folders(root, db, project)
    db.execute(
        "INSERT OR REPLACE INTO project_properties(project_id,key,value_json,updated_at) VALUES(?,?,?,?)",
        (project["id"], LEGACY_PROGRESS_MIGRATION_KEY, "true", int(time.time() * 1000)),
    )
    db.commit()


def register_original_baselines(root: str, db, project):
    """Register conventional baseline folders as explicit original nodes."""
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    if not os.path.isdir(project_path):
        return
    timestamp = int(time.time() * 1000)
    changed = False
    for entry in os.scandir(project_path):
        baseline = entry.name.casefold()
        if not entry.is_dir() or baseline not in {"raw", "jpg", "mov"}:
            continue
        media_kind = "video" if baseline == "mov" else "image"
        folder_path = canonical_path(entry.path)
        identity = directory_identity(folder_path)
        existing = db.execute(
            """SELECT id FROM progress_folders WHERE project_id=? AND (
                 (folder_id IS NOT NULL AND folder_id=?) OR folder_path_key=?)""",
            (project["id"], identity, folder_path.casefold()),
        ).fetchone()
        if existing is not None:
            continue
        db.execute(
            """INSERT INTO progress_folders(
                 id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,
                 folder_path_key,folder_id,node_role,relation_kind,tracking_enabled,tracking_state,
                 rename_from_parent,copy_missing_from_parent,created_at,updated_at)
               VALUES(?,?,?,?,NULL,?,?,?,?, 'original',NULL,0,'disabled',0,0,?,?)""",
            (str(uuid.uuid4()), project["id"], media_kind, f"original-{baseline}", entry.name,
             folder_path, folder_path.casefold(), identity, timestamp, timestamp),
        )
        changed = True
    if changed:
        db.commit()


def migrate_legacy_media_workflow_graph_once(root: str, db, project):
    """Reconcile canonical import/team artifacts into explicit graph records.

    Despite the historical function name this is intentionally repeatable:
    projects can be opened before RAW/JPG/MOV folders are created. It never
    infers main-version relationships and remains bounded to root-level exact
    canonical destinations plus persisted team sources.
    """
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    if not os.path.isdir(project_path):
        return
    timestamp = int(time.time() * 1000)
    directories = {
        entry.name.casefold(): canonical_path(entry.path)
        for entry in os.scandir(project_path)
        if entry.is_dir()
    }

    def node_for_path(folder_path):
        if not folder_path:
            return None
        return db.execute(
            "SELECT * FROM progress_folders WHERE project_id=? AND folder_path_key=?",
            (project["id"], folder_path.casefold()),
        ).fetchone()

    def insert_artifact(folder_path, display_name, media_kind, version_key, node_role, artifact_kind):
        existing = node_for_path(folder_path)
        if existing is not None:
            return existing
        progress_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO progress_folders(
                 id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,
                 folder_path_key,folder_id,node_role,artifact_kind,relation_kind,tracking_enabled,
                 tracking_state,rename_from_parent,copy_missing_from_parent,created_at,updated_at)
               VALUES(?,?,?,?,NULL,?,?,?,?,?,?,NULL,0,'disabled',0,0,?,?)""",
            (progress_id, project["id"], media_kind, version_key, display_name, folder_path,
             folder_path.casefold(), directory_identity(folder_path), node_role, artifact_kind,
             timestamp, timestamp),
        )
        return db.execute("SELECT * FROM progress_folders WHERE id=?", (progress_id,)).fetchone()

    def add_edge(source, target, edge_kind):
        if source is None or target is None:
            return
        existing = db.execute(
            """SELECT 1 FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
               AND target_progress_id=? AND edge_kind=?""",
            (project["id"], source["id"], target["id"], edge_kind),
        ).fetchone()
        if existing is None:
            db.execute(
                """INSERT INTO version_graph_edges(
                     id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?)""",
                (str(uuid.uuid4()), project["id"], source["id"], target["id"], edge_kind, timestamp, timestamp),
            )

    db.execute("SAVEPOINT legacy_media_workflow_graph")
    try:
        raw = node_for_path(directories.get("raw"))
        jpg = node_for_path(directories.get("jpg"))
        if raw is not None and jpg is not None and raw["node_role"] == "original" and jpg["node_role"] == "original" \
                and jpg["artifact_kind"] in (None, "companion"):
            if jpg["artifact_kind"] is None:
                db.execute("UPDATE progress_folders SET artifact_kind='companion',updated_at=? WHERE id=?", (timestamp, jpg["id"]))
                jpg = db.execute("SELECT * FROM progress_folders WHERE id=?", (jpg["id"],)).fetchone()
            add_edge(raw, jpg, "media_companion")

        mov = node_for_path(directories.get("mov"))
        preview_path = directories.get("mov_预览")
        if mov is not None and mov["node_role"] == "original" and preview_path:
            preview = insert_artifact(
                preview_path, os.path.basename(preview_path), "video",
                "legacy-preview-mov", "artifact", "preview",
            )
            if preview["node_role"] == "artifact" and preview["artifact_kind"] == "preview":
                add_edge(mov, preview, "derived_preview")

        team_path = directories.get("团片协作")
        if team_path:
            workflow = insert_artifact(
                team_path, os.path.basename(team_path), "image",
                "team-workspace", "workflow", "team_workspace",
            )
            if workflow["node_role"] == "workflow" and workflow["artifact_kind"] == "team_workspace":
                source_rows = db.execute(
                    """SELECT versions.file_path FROM team_retouch_photos team
                       JOIN versions ON versions.id=team.base_version_id AND versions.is_deleted=0
                       WHERE team.project_id=?""",
                    (project["id"],),
                ).fetchall()
                candidates = db.execute(
                    """SELECT * FROM progress_folders WHERE project_id=? AND media_kind='image'
                       AND node_role IN ('original','progress') AND missing_since IS NULL""",
                    (project["id"],),
                ).fetchall()
                sources = set()
                for source_row in source_rows:
                    file_key = canonical_path(source_row["file_path"]).casefold()
                    matches = [candidate for candidate in candidates if file_key.startswith(candidate["folder_path_key"] + os.sep.casefold())]
                    if matches:
                        sources.add(max(matches, key=lambda candidate: len(candidate["folder_path_key"]))["id"])
                for source_id in sorted(sources):
                    source = next(candidate for candidate in candidates if candidate["id"] == source_id)
                    add_edge(source, workflow, "workflow_input")

        db.execute(
            "INSERT OR IGNORE INTO project_properties(project_id,key,value_json,updated_at) VALUES(?,?,?,?)",
            (project["id"], LEGACY_MEDIA_WORKFLOW_MIGRATION_KEY, "true", timestamp),
        )
        db.execute("RELEASE SAVEPOINT legacy_media_workflow_graph")
        db.commit()
    except Exception:
        db.execute("ROLLBACK TO SAVEPOINT legacy_media_workflow_graph")
        db.execute("RELEASE SAVEPOINT legacy_media_workflow_graph")
        raise


def repair_legacy_selection_nodes(root: str, db, project):
    """Repair only deterministic legacy selections, recording every ambiguous conflict."""
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    if not os.path.isdir(project_path):
        return
    root_directories = {
        entry.name.casefold(): canonical_path(entry.path)
        for entry in os.scandir(project_path)
        if entry.is_dir()
    }
    definitions = {
        "图片选片": {
            "media_kind": "image", "source_name": "RAW",
            "display_names": {"图片选片", "图片选片（原图）"},
        },
        "视频选片": {
            "media_kind": "video", "source_name": "MOV",
            "display_names": {"视频选片", "视频选片（原片）"},
        },
    }
    timestamp = int(time.time() * 1000)

    def record_repair(legacy_node, legacy_name, source_name, reason, candidate_ids):
        db.execute(
            """INSERT INTO legacy_selection_relation_repairs(
                 progress_id,project_id,legacy_name,expected_source_name,reason,
                 candidate_ids_json,created_at) VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(progress_id) DO UPDATE SET
                 legacy_name=excluded.legacy_name,
                 expected_source_name=excluded.expected_source_name,
                 reason=excluded.reason,
                 candidate_ids_json=excluded.candidate_ids_json""",
            (legacy_node["id"], project["id"], legacy_name, source_name, reason,
             json.dumps(candidate_ids, ensure_ascii=False), timestamp),
        )

    # sqlite's connection context is the transaction boundary: unexpected
    # errors roll back every repair for this project before propagating.
    with db:
        for legacy_name, definition in definitions.items():
            legacy_path = root_directories.get(legacy_name.casefold())
            if legacy_path is None:
                continue
            legacy_nodes = db.execute(
                """SELECT * FROM progress_folders
                   WHERE project_id=? AND media_kind=? AND parent_progress_id IS NULL
                     AND version_key='0' AND node_role IN ('original','progress')
                     AND folder_path_key=?""",
                (project["id"], definition["media_kind"], legacy_path.casefold()),
            ).fetchall()
            legacy_nodes = [
                node for node in legacy_nodes
                if os.path.basename(canonical_path(node["folder_path"])) == legacy_name
                and node["display_name"] in definition["display_names"]
            ]
            if not legacy_nodes:
                continue
            source_path = root_directories.get(definition["source_name"].casefold())
            candidates = [] if source_path is None else db.execute(
                """SELECT id FROM progress_folders
                   WHERE project_id=? AND media_kind=? AND node_role='original'
                     AND parent_progress_id IS NULL AND folder_path_key=? AND missing_since IS NULL
                   ORDER BY id""",
                (project["id"], definition["media_kind"], source_path.casefold()),
            ).fetchall()
            source_ids = [row["id"] for row in candidates]
            for legacy_node in legacy_nodes:
                if len(source_ids) != 1:
                    record_repair(
                        legacy_node, legacy_name, definition["source_name"],
                        "source_missing" if not source_ids else "source_ambiguous", source_ids,
                    )
                    continue
                source_id = source_ids[0]
                existing_selections = db.execute(
                    """SELECT id FROM progress_folders
                       WHERE project_id=? AND media_kind=? AND node_role='selection'
                         AND relation_kind='auxiliary' AND parent_progress_id=?
                         AND id<>? AND missing_since IS NULL ORDER BY id""",
                    (project["id"], definition["media_kind"], source_id, legacy_node["id"]),
                ).fetchall()
                existing_selection_ids = [row["id"] for row in existing_selections]
                if existing_selection_ids:
                    record_repair(
                        legacy_node, legacy_name, definition["source_name"],
                        "selection_already_exists", existing_selection_ids,
                    )
                    continue
                target_version_key = f"selection-{source_id}"
                key_owner = db.execute(
                    """SELECT id FROM progress_folders
                       WHERE project_id=? AND media_kind=? AND version_key=? AND id<>?""",
                    (project["id"], definition["media_kind"], target_version_key, legacy_node["id"]),
                ).fetchone()
                if key_owner is not None:
                    record_repair(
                        legacy_node, legacy_name, definition["source_name"],
                        "selection_already_exists", [key_owner["id"]],
                    )
                    continue
                try:
                    db.execute(
                        """UPDATE progress_folders SET node_role='selection',relation_kind='auxiliary',
                           parent_progress_id=?,tracking_enabled=0,tracking_state='disabled',
                           rename_from_parent=0,copy_missing_from_parent=0,version_key=?,updated_at=?
                           WHERE id=?""",
                        (source_id, target_version_key, timestamp, legacy_node["id"]),
                    )
                except sqlite3.IntegrityError:
                    # A concurrent/key conflict is a repair decision, not a
                    # reason for progress_list to fail and hide the whole tree.
                    record_repair(
                        legacy_node, legacy_name, definition["source_name"],
                        "selection_already_exists", [],
                    )
                    continue
                db.execute(
                    "DELETE FROM legacy_selection_relation_repairs WHERE progress_id=?",
                    (legacy_node["id"],),
                )


def repair_selection_workflow_mainlines(db, project_id: str):
    """Move legacy selection-owned progress nodes back onto their original mainline.

    The old shape was original -> selection -> progress. The explicit V2 shape
    is original -> progress (main) plus selection -> progress (workflow_input).
    This is intentionally role-driven and never infers a relation from folder
    names or version strings.
    """
    timestamp = int(time.time() * 1000)
    rows = db.execute(
        """SELECT child.id AS child_id, child.updated_at AS child_updated_at,
                  selection.id AS selection_id, original.id AS original_id
           FROM progress_folders child
           JOIN progress_folders selection ON selection.id=child.parent_progress_id
           JOIN progress_folders original ON original.id=selection.parent_progress_id
           WHERE child.project_id=? AND child.node_role='progress' AND child.relation_kind='main'
             AND selection.project_id=child.project_id AND selection.media_kind=child.media_kind
             AND selection.node_role='selection' AND selection.relation_kind='auxiliary'
             AND original.project_id=child.project_id AND original.media_kind=child.media_kind
             AND original.node_role='original' AND original.missing_since IS NULL""",
        (project_id,),
    ).fetchall()
    changed = 0
    for row in rows:
        updated_at = max(timestamp, int(row["child_updated_at"] or 0) + 1)
        db.execute(
            "UPDATE progress_folders SET parent_progress_id=?,relation_kind='main',updated_at=? WHERE id=?",
            (row["original_id"], updated_at, row["child_id"]),
        )
        db.execute(
            """INSERT INTO version_graph_edges(
                 id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
               SELECT ?,?,?,?,?,?,?
               WHERE NOT EXISTS(
                 SELECT 1 FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                   AND target_progress_id=? AND edge_kind='workflow_input'
               )""",
            (str(uuid.uuid4()), project_id, row["selection_id"], row["child_id"], "workflow_input",
             timestamp, timestamp, project_id, row["selection_id"], row["child_id"]),
        )
        changed += 1
    if changed:
        # A stored coordinate set describes the old topology. Deleting the
        # layout row also deletes positions and makes stale renderer saves fail
        # their expectedRevision check instead of restoring the broken layout.
        db.execute("DELETE FROM version_tree_layouts WHERE project_id=?", (project_id,))
    return changed


def progress_list(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    recover_stale_version_batches(db, project["id"])
    migrate_legacy_progress_folders_once(root, db, project)
    register_original_baselines(root, db, project)
    migrate_legacy_media_workflow_graph_once(root, db, project)
    repair_legacy_selection_nodes(root, db, project)
    with db:
        repair_selection_workflow_mainlines(db, project["id"])
    sync_progress_folder_locations(root, db, project)
    include_missing = bool(payload.get("includeMissing"))
    repair_rows = db.execute(
        """SELECT progress_id,project_id,legacy_name,expected_source_name,reason,
                  candidate_ids_json FROM legacy_selection_relation_repairs
           WHERE project_id=? ORDER BY created_at,progress_id""",
        (project["id"],),
    ).fetchall()
    return {
        "success": True,
        "progressFolders": [serialize_progress(row) for row in progress_rows(db, project["id"], include_missing)],
        "graphEdges": [
            serialize_version_graph_edge(row) for row in db.execute(
                "SELECT * FROM version_graph_edges WHERE project_id=? ORDER BY created_at,id",
                (project["id"],),
            ).fetchall()
        ],
        "legacySelectionRelationRepairs": [
            {
                "progressId": row["progress_id"],
                "projectId": row["project_id"],
                "legacyName": row["legacy_name"],
                "expectedSourceName": row["expected_source_name"],
                "reason": row["reason"],
                "candidateIds": json.loads(row["candidate_ids_json"] or "[]"),
            }
            for row in repair_rows
        ],
    }


def progress_legacy_selection_repair(db, payload: dict):
    progress_id = str(payload.get("progressId") or "").strip()
    source_progress_id = str(payload.get("sourceProgressId") or "").strip()
    if not progress_id or not source_progress_id:
        raise ValueError("legacy_selection_repair_payload_invalid: 修复节点 ID 无效")
    with db:
        repair = db.execute(
            "SELECT * FROM legacy_selection_relation_repairs WHERE progress_id=?",
            (progress_id,),
        ).fetchone()
        legacy = db.execute("SELECT * FROM progress_folders WHERE id=?", (progress_id,)).fetchone()
        source = db.execute("SELECT * FROM progress_folders WHERE id=?", (source_progress_id,)).fetchone()
        if repair is None or legacy is None:
            raise ValueError("legacy_selection_repair_not_found: 遗留选片修复记录不存在")
        if source is None or source["project_id"] != repair["project_id"] or legacy["project_id"] != repair["project_id"]:
            raise ValueError("legacy_selection_repair_project_mismatch: 节点不属于当前项目")
        if source["media_kind"] != legacy["media_kind"]:
            raise ValueError("legacy_selection_repair_media_mismatch: 来源媒体类型不一致")
        if source["node_role"] != "original" or source["parent_progress_id"] is not None or source["missing_since"] is not None:
            raise ValueError("legacy_selection_repair_source_invalid: 来源必须是有效的原始素材节点")
        if legacy["parent_progress_id"] is not None or legacy["version_key"] != "0" or legacy["node_role"] not in ("original", "progress"):
            raise ValueError("legacy_selection_repair_state_changed: 遗留节点状态已经变化，请刷新后重试")
        preferred_key = f"selection-{source_progress_id}"
        key_owner = db.execute(
            """SELECT id FROM progress_folders
               WHERE project_id=? AND media_kind=? AND version_key=? AND id<>?""",
            (legacy["project_id"], legacy["media_kind"], preferred_key, progress_id),
        ).fetchone()
        version_key = f"legacy-selection-{progress_id}" if key_owner is not None else preferred_key
        fallback_owner = db.execute(
            """SELECT id FROM progress_folders
               WHERE project_id=? AND media_kind=? AND version_key=? AND id<>?""",
            (legacy["project_id"], legacy["media_kind"], version_key, progress_id),
        ).fetchone()
        if fallback_owner is not None:
            raise ValueError("legacy_selection_repair_key_conflict: 遗留选片内部标识冲突")
        timestamp = max(int(time.time() * 1000), int(legacy["updated_at"]) + 1)
        db.execute(
            """UPDATE progress_folders SET node_role='selection',relation_kind='auxiliary',
               parent_progress_id=?,version_key=?,tracking_enabled=0,tracking_state='disabled',
               rename_from_parent=0,copy_missing_from_parent=0,last_tracked_at=NULL,
               tracking_snapshot_json='{}',folder_signature=NULL,updated_at=? WHERE id=?""",
            (source_progress_id, version_key, timestamp, progress_id),
        )
        db.execute("DELETE FROM legacy_selection_relation_repairs WHERE progress_id=?", (progress_id,))
    updated = next(row for row in progress_rows(db, legacy["project_id"], True) if row["id"] == progress_id)
    return {"success": True, "progressFolder": serialize_progress(updated)}


VERSION_TREE_MAX_COORDINATE = 1_000_000.0
VERSION_TREE_MAX_POSITIONS = 1000


def normalize_version_tree_scope(value) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if len(raw) > 1024 or raw.startswith("/") or (len(raw) >= 2 and raw[1] == ":"):
        raise ValueError("version_tree_scope_invalid: scopeKey 必须是项目内相对路径")
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ValueError("version_tree_scope_invalid: scopeKey 不能包含 ..")
    return "/".join(parts)


def version_tree_project_node_keys(db, project_id: str) -> set[str]:
    keys = {f"progress:{row['id']}" for row in db.execute(
        "SELECT id FROM progress_folders WHERE project_id=?",
        (project_id,),
    ).fetchall()}
    return keys


def version_tree_entry_node_belongs_to_scope(node_key: str, scope_key: str) -> bool:
    if not node_key.startswith("entry:"):
        return False
    relative_path = node_key[len("entry:"):]
    if not relative_path or len(relative_path) > 1024 or "\\" in relative_path:
        return False
    try:
        normalized_path = normalize_version_tree_scope(relative_path)
    except ValueError:
        return False
    if normalized_path != relative_path:
        return False
    parent_scope = "/".join(normalized_path.split("/")[:-1])
    return parent_scope.casefold() == scope_key.casefold()


def version_tree_layout_get(db, payload: dict):
    project = project_row(db, payload["projectName"])
    scope_key = normalize_version_tree_scope(payload.get("scopeKey"))
    valid_keys = version_tree_project_node_keys(db, project["id"])
    with db:
        layout = db.execute(
            "SELECT revision,updated_at FROM version_tree_layouts WHERE project_id=? AND scope_key=?",
            (project["id"], scope_key),
        ).fetchone()
        rows = db.execute(
            """SELECT node_key,x,y,updated_at FROM version_tree_node_positions
               WHERE project_id=? AND scope_key=? ORDER BY node_key""",
            (project["id"], scope_key),
        ).fetchall()
        stale_keys = [row["node_key"] for row in rows if row["node_key"] not in valid_keys and not version_tree_entry_node_belongs_to_scope(row["node_key"], scope_key)]
        for node_key in stale_keys:
            db.execute(
                "DELETE FROM version_tree_node_positions WHERE project_id=? AND scope_key=? AND node_key=?",
                (project["id"], scope_key, node_key),
            )
    return {
        "success": True,
        "scopeKey": scope_key,
        "revision": int(layout["revision"]) if layout else 0,
        "updatedAt": int(layout["updated_at"]) if layout else 0,
        "positions": [
            {"nodeKey": row["node_key"], "x": float(row["x"]), "y": float(row["y"]), "updatedAt": int(row["updated_at"])}
            for row in rows if row["node_key"] in valid_keys or version_tree_entry_node_belongs_to_scope(row["node_key"], scope_key)
        ],
    }


def version_tree_layout_save(db, payload: dict):
    project = project_row(db, payload["projectName"])
    scope_key = normalize_version_tree_scope(payload.get("scopeKey"))
    mode = str(payload.get("mode") or "")
    if mode not in ("patch", "replace"):
        raise ValueError("version_tree_layout_mode_invalid: mode 必须是 patch 或 replace")
    expected_revision = payload.get("expectedRevision")
    if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or expected_revision < 0:
        raise ValueError("version_tree_layout_revision_invalid: expectedRevision 无效")
    positions = payload.get("positions")
    if not isinstance(positions, list) or len(positions) > VERSION_TREE_MAX_POSITIONS:
        raise ValueError("version_tree_layout_positions_invalid: 单次保存节点数量无效")
    valid_keys = version_tree_project_node_keys(db, project["id"])
    normalized = []
    seen = set()
    for position in positions:
        if not isinstance(position, dict):
            raise ValueError("version_tree_layout_position_invalid: 坐标记录无效")
        node_key = str(position.get("nodeKey") or "")
        x = position.get("x")
        y = position.get("y")
        if (node_key not in valid_keys and not version_tree_entry_node_belongs_to_scope(node_key, scope_key)) or node_key in seen:
            raise ValueError("version_tree_layout_node_invalid: 节点不属于当前项目")
        if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            raise ValueError("version_tree_layout_coordinate_invalid: 坐标必须是有限数字")
        x_value, y_value = float(x), float(y)
        if not math.isfinite(x_value) or not math.isfinite(y_value) or abs(x_value) > VERSION_TREE_MAX_COORDINATE or abs(y_value) > VERSION_TREE_MAX_COORDINATE:
            raise ValueError("version_tree_layout_coordinate_invalid: 坐标超出允许范围")
        seen.add(node_key)
        normalized.append((node_key, x_value, y_value))
    timestamp = int(time.time() * 1000)
    with db:
        current = db.execute(
            "SELECT revision FROM version_tree_layouts WHERE project_id=? AND scope_key=?",
            (project["id"], scope_key),
        ).fetchone()
        current_revision = int(current["revision"]) if current else 0
        if current_revision != expected_revision:
            raise ValueError(f"stale_layout: 布局已更新（当前 revision={current_revision}）")
        next_revision = current_revision + 1
        db.execute(
            """INSERT INTO version_tree_layouts(project_id,scope_key,revision,updated_at) VALUES(?,?,?,?)
               ON CONFLICT(project_id,scope_key) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at""",
            (project["id"], scope_key, next_revision, timestamp),
        )
        if mode == "replace":
            db.execute(
                "DELETE FROM version_tree_node_positions WHERE project_id=? AND scope_key=?",
                (project["id"], scope_key),
            )
        db.executemany(
            """INSERT INTO version_tree_node_positions(project_id,scope_key,node_key,x,y,updated_at)
               VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,scope_key,node_key) DO UPDATE SET
               x=excluded.x,y=excluded.y,updated_at=excluded.updated_at""",
            [(project["id"], scope_key, node_key, x, y, timestamp) for node_key, x, y in normalized],
        )
    return {"success": True, "scopeKey": scope_key, "revision": next_revision, "updatedAt": timestamp}


def recover_stale_version_batches(db, project_id: str):
    """Expose interrupted worker state as a recoverable tracking state."""
    cutoff = int(time.time() * 1000) - 10 * 60 * 1000
    stale = db.execute(
        """SELECT * FROM version_batches WHERE project_id=? AND status IN ('importing','applying')
           AND updated_at<?""",
        (project_id, cutoff),
    ).fetchall()
    if not stale:
        return
    timestamp = int(time.time() * 1000)
    for batch in stale:
        pending_operations = db.execute(
            "SELECT COUNT(*) FROM batch_file_operations WHERE batch_id=? AND status!='succeeded'",
            (batch["id"],),
        ).fetchone()[0]
        if pending_operations:
            db.execute(
                """UPDATE batch_file_operations SET status='failed',error=CASE WHEN error='' THEN '上次文件操作意外中断' ELSE error END,
                   updated_at=? WHERE batch_id=? AND status IN ('pending','running')""",
                (timestamp, batch["id"]),
            )
            db.execute("UPDATE version_batches SET status='needs_repair',updated_at=? WHERE id=?", (timestamp, batch["id"]))
            db.execute(
                """UPDATE progress_folders SET tracking_state='needs_repair',updated_at=?
                   WHERE project_id=? AND folder_path_key=?""",
                (timestamp, project_id, batch["source_folder_path_key"]),
            )
        else:
            db.execute("UPDATE version_batches SET status='failed',updated_at=? WHERE id=?", (timestamp, batch["id"]))
            db.execute(
                """UPDATE progress_folders SET tracking_state='pending_compare',updated_at=?
                   WHERE project_id=? AND folder_path_key=?""",
                (timestamp, project_id, batch["source_folder_path_key"]),
            )
    db.commit()


def progress_register(root: str, db, payload: dict, commit: bool = True, sync_locations: bool = True):
    project = project_row(db, payload["projectName"])
    if sync_locations:
        sync_progress_folder_locations(root, db, project, commit=commit)
    media_kind = str(payload.get("mediaKind") or "")
    if media_kind not in ("image", "video", "mixed"):
        raise ValueError("无效的进度类型")
    version_key = str(payload.get("versionKey") or f"node-{uuid.uuid4().hex}").strip()
    if not version_key or len(version_key) > 128 or any(ord(character) < 32 for character in version_key):
        raise ValueError("无效的版本编号")
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    folder_path = canonical_path(payload["folderPath"])
    if not is_project_descendant(folder_path, project_path) or not os.path.isdir(folder_path):
        raise ValueError("版本进度必须是项目内的文件夹")
    node_role = str(payload.get("nodeRole") or "progress")
    if node_role not in PROGRESS_NODE_ROLES:
        raise ValueError("无效的文件夹节点角色")
    artifact_kind = str(payload.get("artifactKind") or "") or None
    if artifact_kind not in (*PROGRESS_ARTIFACT_KINDS, None):
        raise ValueError("无效的产物节点类型")
    parent_id = payload.get("parentProgressId") or None
    relation_kind = payload.get("relationKind") or None
    if parent_id and relation_kind is None:
        relation_kind = "auxiliary" if node_role == "selection" else "main"
    if not parent_id:
        relation_kind = None
    if relation_kind is not None:
        relation_kind = str(relation_kind)
    if relation_kind not in (*PROGRESS_RELATION_KINDS, None):
        raise ValueError("无效的父子关系类型")
    if node_role == "original" and parent_id:
        raise ValueError("原始素材节点不能指定父节点")
    if node_role == "selection" and (not parent_id or relation_kind != "auxiliary"):
        raise ValueError("选片节点必须通过 auxiliary 关系连接来源节点")
    if node_role == "progress" and parent_id and relation_kind != "main":
        raise ValueError("进度节点必须通过 main 关系连接父节点")
    if node_role == "artifact" and (parent_id or relation_kind or artifact_kind not in ("companion", "preview")):
        raise ValueError("产物节点不能使用结构父关系，且必须指定 companion 或 preview 类型")
    if node_role == "workflow" and (parent_id or relation_kind or artifact_kind != "team_workspace"):
        raise ValueError("工作流节点不能使用结构父关系，且必须是 team_workspace 类型")
    if node_role == "original" and artifact_kind not in (None, "companion"):
        raise ValueError("original nodes may only use the companion artifact kind")
    if node_role in ("progress", "selection") and artifact_kind is not None:
        raise ValueError("普通版本节点不能指定产物类型")
    if parent_id:
        parent = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=? AND media_kind=?",
            (parent_id, project["id"], media_kind),
        ).fetchone()
        if parent is None or parent["node_role"] not in ("original", "progress"):
            raise ValueError("父版本进度不存在")
    timestamp = int(time.time() * 1000)
    progress_id = str(payload.get("progressId") or payload.get("takeoverProgressId") or "")
    display_name = str(payload.get("displayName") or os.path.basename(folder_path))
    existing = None
    if progress_id:
        existing = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
            (progress_id, project["id"]),
        ).fetchone()
        if existing is None:
            raise ValueError("要修改的进度不存在")
    else:
        existing = db.execute(
            "SELECT * FROM progress_folders WHERE project_id=? AND media_kind=? AND version_key=?",
            (project["id"], media_kind, version_key),
        ).fetchone()
        if existing is not None and os.path.isdir(existing["folder_path"]) and existing["folder_path_key"] != folder_path.casefold():
            raise ValueError(f"版本 _{version_key} 已存在")
        if existing is None:
            folder_identity = directory_identity(folder_path)
            existing = db.execute(
                """SELECT * FROM progress_folders WHERE project_id=? AND missing_since IS NOT NULL AND (
                     (folder_id IS NOT NULL AND folder_id=?) OR folder_path_key=?)
                   AND media_kind=? AND node_role=?
                   ORDER BY missing_since LIMIT 1""",
                (project["id"], folder_identity, folder_path.casefold(), media_kind, node_role),
            ).fetchone()
    if existing is not None and existing["missing_since"] is not None and existing["node_role"] != node_role:
        raise ValueError("tombstone 节点角色与接管文件夹不兼容")
    existing_id = existing["id"] if existing is not None else progress_id
    duplicate_name = db.execute(
        """SELECT id FROM progress_folders WHERE project_id=? AND display_name=? COLLATE NOCASE
           AND id<>? AND missing_since IS NULL""",
        (project["id"], display_name, existing_id),
    ).fetchone()
    if duplicate_name is not None:
        raise ValueError(f"进度名称已存在：{display_name}")
    if progress_id:
        conflict = db.execute(
            "SELECT id FROM progress_folders WHERE project_id=? AND media_kind=? AND version_key=? AND id<>?",
            (project["id"], media_kind, version_key, progress_id),
        ).fetchone()
        if conflict is not None:
            raise ValueError(f"版本 _{version_key} 已存在")
    requested_tracking_state = payload.get("trackingState")
    tracking_enabled = bool(payload.get("trackingEnabled"))
    if requested_tracking_state is None:
        requested_tracking_state = "ready" if tracking_enabled else "disabled"
    tracking_state = str(requested_tracking_state)
    if tracking_state not in PROGRESS_TRACKING_STATES:
        raise ValueError("无效的版本跟踪状态")
    if "trackingEnabled" not in payload:
        tracking_enabled = tracking_state != "disabled"
    rename_from_parent = bool(payload.get("renameFromParent"))
    copy_missing_from_parent = bool(payload.get("copyMissingFromParent"))
    if node_role in ("original", "artifact", "workflow") or relation_kind == "auxiliary":
        if tracking_enabled or rename_from_parent or copy_missing_from_parent or tracking_state != "disabled":
            raise ValueError("original/selection/artifact/workflow 节点禁止开启版本跟踪")
        tracking_enabled = rename_from_parent = copy_missing_from_parent = False
        tracking_state = "disabled"
    if not tracking_enabled and (rename_from_parent or copy_missing_from_parent):
        raise ValueError("未开启跟踪时不能保存沿用文件名或补齐策略")
    snapshot = payload.get("trackingSnapshot") or {}
    if not isinstance(snapshot, (dict, list)):
        raise ValueError("无效的跟踪快照")
    snapshot_json = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    folder_signature = str(payload.get("folderSignature") or "") or None
    last_tracked_at = int(payload.get("lastTrackedAt") or timestamp) if tracking_state == "ready" else None
    values = (
        parent_id, display_name, folder_path, folder_path.casefold(), directory_identity(folder_path),
        node_role, artifact_kind, relation_kind, int(tracking_enabled), tracking_state, int(rename_from_parent),
        int(copy_missing_from_parent), last_tracked_at, snapshot_json, folder_signature, timestamp,
    )
    if existing:
        db.execute(
            """UPDATE progress_folders SET media_kind=?,version_key=?,parent_progress_id=?,display_name=?,folder_path=?,folder_path_key=?,
               folder_id=?,node_role=?,artifact_kind=?,relation_kind=?,tracking_enabled=?,tracking_state=?,rename_from_parent=?,
               copy_missing_from_parent=?,last_tracked_at=?,tracking_snapshot_json=?,folder_signature=?,
               missing_since=NULL,tombstone_json='{}',updated_at=? WHERE id=?""",
            (media_kind, version_key, *values, existing["id"]),
        )
        progress_id = existing["id"]
    else:
        progress_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO progress_folders(id,project_id,media_kind,version_key,parent_progress_id,
               display_name,folder_path,folder_path_key,folder_id,node_role,artifact_kind,relation_kind,tracking_enabled,
               tracking_state,rename_from_parent,copy_missing_from_parent,last_tracked_at,tracking_snapshot_json,
               folder_signature,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (progress_id, project["id"], media_kind, version_key, *values[:-1], timestamp, timestamp),
        )
    if commit:
        db.commit()
    row = next(row for row in progress_rows(db, project["id"]) if row["id"] == progress_id)
    return {"success": True, "progressFolder": serialize_progress(row)}


def progress_register_with_graph(root: str, db, payload: dict):
    """Atomically register/update one main progress and synchronize workflow inputs."""
    if not isinstance(payload, dict) or set(payload) - {"projectName", "progress", "workflowInputProgressIds"}:
        raise ValueError("progress_graph_payload_invalid: only projectName, progress and workflow inputs are accepted")
    project_name = str(payload.get("projectName") or "").strip()
    progress_payload = payload.get("progress")
    input_ids = payload.get("workflowInputProgressIds")
    if not project_name or not isinstance(progress_payload, dict) or not isinstance(input_ids, list):
        raise ValueError("progress_graph_payload_invalid: project, progress or workflow inputs are invalid")
    allowed_progress_fields = {
        "progressId", "mediaKind", "versionKey", "parentProgressId", "displayName", "folderPath",
        "relationKind", "trackingEnabled", "trackingState", "renameFromParent", "copyMissingFromParent",
    }
    if set(progress_payload) - allowed_progress_fields or "nodeRole" in progress_payload or "edgeKind" in progress_payload:
        raise ValueError("progress_graph_payload_invalid: renderer cannot assign node roles, paths or edge kinds")
    normalized_inputs = []
    for value in input_ids:
        input_id = str(value or "").strip()
        if not input_id or input_id in normalized_inputs:
            raise ValueError("progress_graph_input_invalid: workflow input IDs must be unique and non-empty")
        normalized_inputs.append(input_id)

    project = project_row(db, project_name)
    progress_id = str(progress_payload.get("progressId") or "").strip()
    updates_progress = bool(set(progress_payload) - {"progressId"})
    required = ("mediaKind", "versionKey", "displayName", "folderPath")
    if (not progress_id or updates_progress) and any(not progress_payload.get(field) for field in required):
        raise ValueError("progress_graph_payload_invalid: new or updated progress fields are incomplete")

    try:
        with db:
            if updates_progress or not progress_id:
                register_payload = {
                    "projectName": project_name,
                    "progressId": progress_id or None,
                    "mediaKind": progress_payload["mediaKind"],
                    "versionKey": progress_payload["versionKey"],
                    "parentProgressId": progress_payload.get("parentProgressId"),
                    "displayName": progress_payload["displayName"],
                    "folderPath": progress_payload["folderPath"],
                    "nodeRole": "progress",
                    "relationKind": progress_payload.get("relationKind") or ("main" if progress_payload.get("parentProgressId") else None),
                    "trackingEnabled": bool(progress_payload.get("trackingEnabled")),
                    "trackingState": progress_payload.get("trackingState"),
                    "renameFromParent": bool(progress_payload.get("renameFromParent")),
                    "copyMissingFromParent": bool(progress_payload.get("copyMissingFromParent")),
                }
                registered = progress_register(root, db, register_payload, commit=False, sync_locations=False)
                progress_id = registered["progressFolder"]["id"]
            else:
                existing = db.execute(
                    "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
                    (progress_id, project["id"]),
                ).fetchone()
                if existing is None or existing["missing_since"] is not None:
                    raise ValueError("progress_graph_target_invalid: target progress does not exist")

            target = db.execute("SELECT * FROM progress_folders WHERE id=?", (progress_id,)).fetchone()
            sources = {}
            for source_id in normalized_inputs:
                source = db.execute("SELECT * FROM progress_folders WHERE id=?", (source_id,)).fetchone()
                if source is None or source["missing_since"] is not None:
                    raise ValueError("progress_graph_input_invalid: an input progress does not exist")
                sources[source_id] = source
            if target["node_role"] == "workflow":
                if any(source["node_role"] not in ("original", "progress") for source in sources.values()):
                    raise ValueError("progress_graph_input_invalid: workflow inputs must be original or main progress nodes")
            elif target["node_role"] == "progress":
                if any(source["node_role"] not in ("selection", "workflow") for source in sources.values()):
                    raise ValueError("progress_graph_input_invalid: progress inputs must be selection or workflow nodes")
            else:
                raise ValueError("progress_graph_target_invalid: target must be a workflow or main progress")

            for source_id in normalized_inputs:
                _validated_version_graph_edge(db, {
                    "projectId": project["id"], "sourceProgressId": source_id,
                    "targetProgressId": progress_id, "edgeKind": "workflow_input",
                }) if db.execute(
                    """SELECT 1 FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                       AND target_progress_id=? AND edge_kind='workflow_input'""",
                    (project["id"], source_id, progress_id),
                ).fetchone() is None else None

            if target["node_role"] == "workflow":
                db.execute(
                    """DELETE FROM version_graph_edges WHERE project_id=? AND target_progress_id=?
                       AND edge_kind='workflow_input' AND source_progress_id NOT IN
                       (SELECT value FROM json_each(?))""",
                    (project["id"], progress_id, json.dumps(normalized_inputs)),
                )
            elif target["node_role"] == "progress":
                db.execute(
                    """DELETE FROM version_graph_edges WHERE project_id=? AND target_progress_id=?
                       AND edge_kind='workflow_input' AND source_progress_id NOT IN
                       (SELECT value FROM json_each(?))""",
                    (project["id"], progress_id, json.dumps(normalized_inputs)),
                )
                workflow_inputs = [source_id for source_id, source in sources.items() if source["node_role"] == "workflow"]
                for workflow_id in workflow_inputs:
                    db.execute(
                        """DELETE FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                           AND edge_kind='workflow_input' AND target_progress_id<>?""",
                        (project["id"], workflow_id, progress_id),
                    )
            timestamp = int(time.time() * 1000)
            for source_id in normalized_inputs:
                db.execute(
                    """INSERT OR IGNORE INTO version_graph_edges(
                         id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (str(uuid.uuid4()), project["id"], source_id, progress_id, "workflow_input", timestamp, timestamp),
                )
    except Exception:
        db.rollback()
        raise

    row = next(row for row in progress_rows(db, project["id"], True) if row["id"] == progress_id)
    edges = db.execute(
        "SELECT * FROM version_graph_edges WHERE project_id=? AND (source_progress_id=? OR target_progress_id=?) ORDER BY created_at,id",
        (project["id"], progress_id, progress_id),
    ).fetchall()
    return {"success": True, "progressFolder": serialize_progress(row), "edges": [serialize_version_graph_edge(edge) for edge in edges]}


def progress_relation_update(db, payload: dict):
    child_id = str(payload.get("childProgressId") or "").strip()
    parent_value = payload.get("parentProgressId")
    parent_id = str(parent_value).strip() if parent_value is not None else None
    if not child_id or parent_id == "":
        raise ValueError("relation_payload_invalid: 节点 ID 无效")
    expected_updated_at = payload.get("expectedUpdatedAt")
    with db:
        child = db.execute("SELECT * FROM progress_folders WHERE id=?", (child_id,)).fetchone()
        if child is None:
            raise ValueError("child_not_found: 子节点不存在")
        if expected_updated_at is not None and int(expected_updated_at) != int(child["updated_at"]):
            raise ValueError("stale_update: 版本关系已被其他操作修改，请刷新后重试")
        if child["node_role"] == "original":
            raise ValueError("original_parent_forbidden: 原始素材不能拥有父节点")
        if child["node_role"] not in ("progress", "selection"):
            raise ValueError("child_role_invalid: 子节点角色无效")
        if child["tracking_state"] in ("pending_compare", "pending_confirm", "committing"):
            raise ValueError("node_busy: 节点正在比较或提交，暂时不能修改关系")
        active_session = db.execute(
            "SELECT 1 FROM tracking_sessions WHERE progress_id=? AND status IN ('comparing','pending_confirm','committing') LIMIT 1",
            (child_id,),
        ).fetchone()
        if active_session is not None:
            raise ValueError("node_busy: 节点正在比较或提交，暂时不能修改关系")
        if child["node_role"] == "progress" and parent_id is None and child["tracking_enabled"]:
            raise ValueError("tracked_detach_forbidden: 已开启跟踪的进度不能断开为根节点，请先关闭跟踪")
        if child["node_role"] == "selection" and parent_id is None:
            raise ValueError("selection_parent_required: 选片节点必须保留有效来源")
        if parent_id is not None:
            parent = db.execute("SELECT * FROM progress_folders WHERE id=?", (parent_id,)).fetchone()
            if parent is None or parent["project_id"] != child["project_id"]:
                raise ValueError("relation_project_mismatch: 父子节点不属于同一项目")
            if parent["media_kind"] != child["media_kind"]:
                raise ValueError("media_kind_mismatch: 父子节点媒体类型不一致")
            if parent["node_role"] == "selection" or parent["relation_kind"] == "auxiliary":
                raise ValueError("invalid_parent_role: 不能挂到选片或附属分支下")
            if parent["missing_since"] is not None:
                raise ValueError("parent_missing: 父节点已经失效")
            if _version_graph_reaches(db, str(child["project_id"]), child_id, parent_id):
                raise ValueError("cycle_detected: 结构关系和补充关系不能形成有向环")
        relation_kind = "auxiliary" if child["node_role"] == "selection" else ("main" if parent_id else None)
        tracking_state = "stale" if child["node_role"] == "progress" and child["tracking_enabled"] else "disabled"
        timestamp = max(int(time.time() * 1000), int(child["updated_at"]) + 1)
        version_key = f"selection-{parent_id}" if child["node_role"] == "selection" else child["version_key"]
        db.execute(
            """UPDATE progress_folders SET parent_progress_id=?,relation_kind=?,version_key=?,
               tracking_state=?,last_tracked_at=NULL,tracking_snapshot_json='{}',folder_signature=NULL,
               updated_at=? WHERE id=?""",
            (parent_id, relation_kind, version_key, tracking_state, timestamp, child_id),
        )
    row = next(row for row in progress_rows(db, child["project_id"]) if row["id"] == child_id)
    return {"success": True, "progressFolder": serialize_progress(row)}


def serialize_version_graph_edge(row):
    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "sourceProgressId": row["source_progress_id"],
        "targetProgressId": row["target_progress_id"],
        "edgeKind": row["edge_kind"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _strict_version_graph_payload(payload: dict, allowed: set[str]):
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValueError("version_graph_edge_payload_invalid: 只能提交项目 ID、节点 ID 和关系类型")


def _validated_version_graph_edge(db, payload: dict, exclude_edge_id: str | None = None):
    _strict_version_graph_payload(payload, {"projectId", "sourceProgressId", "targetProgressId", "edgeKind"})
    project_id = str(payload.get("projectId") or "").strip()
    source_id = str(payload.get("sourceProgressId") or "").strip()
    target_id = str(payload.get("targetProgressId") or "").strip()
    edge_kind = str(payload.get("edgeKind") or "").strip()
    if not project_id or not source_id or not target_id or edge_kind not in VERSION_GRAPH_EDGE_KINDS:
        raise ValueError("version_graph_edge_payload_invalid: 项目、节点或关系类型无效")
    if source_id == target_id:
        raise ValueError("version_graph_edge_cycle: 节点不能连接到自己")
    nodes = db.execute(
        "SELECT * FROM progress_folders WHERE id IN (?,?)",
        (source_id, target_id),
    ).fetchall()
    by_id = {str(row["id"]): row for row in nodes}
    source = by_id.get(source_id)
    target = by_id.get(target_id)
    if source is None or target is None:
        raise ValueError("version_graph_edge_node_missing: 补充关系节点不存在")
    if source["project_id"] != project_id or target["project_id"] != project_id:
        raise ValueError("version_graph_edge_project_mismatch: 所有节点必须属于指定项目")
    if source["media_kind"] != target["media_kind"]:
        raise ValueError("version_graph_edge_media_mismatch: 图片和视频节点不能互相连接")
    valid_roles = (
        edge_kind == "media_companion" and source["node_role"] == "original" and target["node_role"] == "original"
        and target["artifact_kind"] == "companion"
        or edge_kind == "derived_preview" and source["node_role"] in ("original", "progress")
        and target["node_role"] == "artifact" and target["artifact_kind"] == "preview"
        or edge_kind == "workflow_input" and (
            source["node_role"] in ("selection", "workflow") and target["node_role"] == "progress"
            or source["node_role"] in ("original", "progress") and target["node_role"] == "workflow"
            and target["artifact_kind"] == "team_workspace"
        )
    )
    if not valid_roles:
        raise ValueError("version_graph_edge_role_invalid: 节点角色不符合补充关系类型")
    duplicate = db.execute(
        """SELECT 1 FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
           AND target_progress_id=? AND edge_kind=? AND (? IS NULL OR id<>?)""",
        (project_id, source_id, target_id, edge_kind, exclude_edge_id, exclude_edge_id),
    ).fetchone()
    if duplicate is not None:
        raise ValueError("version_graph_edge_duplicate: 同一补充关系不能重复")
    if _version_graph_reaches(db, project_id, target_id, source_id, exclude_edge_id):
        raise ValueError("version_graph_edge_cycle: 结构关系和补充关系不能形成有向环")
    return project_id, source_id, target_id, edge_kind


def version_graph_edge_create(db, payload: dict):
    project_id, source_id, target_id, edge_kind = _validated_version_graph_edge(db, payload)
    timestamp = int(time.time() * 1000)
    edge_id = str(uuid.uuid4())
    with db:
        db.execute(
            """INSERT INTO version_graph_edges(
                 id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?)""",
            (edge_id, project_id, source_id, target_id, edge_kind, timestamp, timestamp),
        )
    row = db.execute("SELECT * FROM version_graph_edges WHERE id=?", (edge_id,)).fetchone()
    return {"success": True, "edge": serialize_version_graph_edge(row)}


def version_graph_edge_list(db, payload: dict):
    _strict_version_graph_payload(payload, {"projectId"})
    project_id = str(payload.get("projectId") or "").strip()
    if not project_id:
        raise ValueError("version_graph_edge_payload_invalid: 项目 ID 无效")
    rows = db.execute(
        "SELECT * FROM version_graph_edges WHERE project_id=? ORDER BY created_at,id",
        (project_id,),
    ).fetchall()
    return {"success": True, "edges": [serialize_version_graph_edge(row) for row in rows]}


def version_graph_edge_delete(db, payload: dict):
    _strict_version_graph_payload(payload, {"projectId", "sourceProgressId", "targetProgressId", "edgeKind"})
    project_id = str(payload.get("projectId") or "").strip()
    source_id = str(payload.get("sourceProgressId") or "").strip()
    target_id = str(payload.get("targetProgressId") or "").strip()
    edge_kind = str(payload.get("edgeKind") or "").strip()
    if not project_id or not source_id or not target_id or edge_kind not in VERSION_GRAPH_EDGE_KINDS:
        raise ValueError("version_graph_edge_payload_invalid: 项目、节点或关系类型无效")
    with db:
        changed = db.execute(
            """DELETE FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
               AND target_progress_id=? AND edge_kind=?""",
            (project_id, source_id, target_id, edge_kind),
        ).rowcount
    if not changed:
        raise ValueError("version_graph_edge_not_found: 补充关系不存在")
    return {"success": True}


def version_graph_edge_replace_source(db, payload: dict):
    _strict_version_graph_payload(
        payload,
        {"projectId", "sourceProgressId", "targetProgressId", "edgeKind", "newSourceProgressId"},
    )
    project_id = str(payload.get("projectId") or "").strip()
    source_id = str(payload.get("sourceProgressId") or "").strip()
    target_id = str(payload.get("targetProgressId") or "").strip()
    edge_kind = str(payload.get("edgeKind") or "").strip()
    new_source_id = str(payload.get("newSourceProgressId") or "").strip()
    if not project_id or not source_id or not target_id or not new_source_id or edge_kind not in VERSION_GRAPH_EDGE_KINDS:
        raise ValueError("version_graph_edge_payload_invalid: 项目、节点或关系类型无效")
    existing = db.execute(
        """SELECT * FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
           AND target_progress_id=? AND edge_kind=?""",
        (project_id, source_id, target_id, edge_kind),
    ).fetchone()
    if existing is None:
        raise ValueError("version_graph_edge_not_found: 补充关系不存在")
    if new_source_id == source_id:
        return {"success": True, "edge": serialize_version_graph_edge(existing)}
    edge_id = str(existing["id"])
    timestamp = int(time.time() * 1000)
    with db:
        project_id, new_source_id, target_id, edge_kind = _validated_version_graph_edge(
            db,
            {
                "projectId": project_id,
                "sourceProgressId": new_source_id,
                "targetProgressId": target_id,
                "edgeKind": edge_kind,
            },
            edge_id,
        )
        db.execute(
            """UPDATE version_graph_edges SET source_progress_id=?,updated_at=? WHERE id=?""",
            (new_source_id, timestamp, edge_id),
        )
    row = db.execute("SELECT * FROM version_graph_edges WHERE id=?", (edge_id,)).fetchone()
    return {"success": True, "edge": serialize_version_graph_edge(row)}


def _import_relative_path(value) -> str:
    normalized = str(value or "").replace("\\", "/").strip("/")
    parts = normalized.split("/") if normalized else []
    if not parts or any(part in ("", ".", "..") for part in parts) or os.path.isabs(str(value or "")):
        raise ValueError("import_graph_relative_path_invalid: import graph paths must be project-relative")
    return "/".join(parts)


def media_workflow_import_commit(root: str, db, payload: dict):
    """Commit an importer-authored V2 artifact manifest without inferring graph semantics from names."""
    allowed = {"schemaVersion", "projectName", "importSessionId", "artifacts"}
    if not isinstance(payload, dict) or set(payload) - allowed or payload.get("schemaVersion") != 2:
        raise ValueError("import_graph_payload_invalid: schemaVersion 2 and supported fields are required")
    project_name = str(payload.get("projectName") or "").strip()
    session_id = str(payload.get("importSessionId") or "").strip()
    if not project_name or not session_id or len(session_id) > 128 or any(ord(char) < 32 for char in session_id):
        raise ValueError("import_graph_payload_invalid: project name and import session are required")
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise ValueError("import_graph_payload_invalid: artifacts must be a non-empty array")

    slot_shapes = IMPORT_ARTIFACT_SLOT_SHAPES
    normalized_artifacts = []
    artifact_paths = set()
    artifact_allowed = {"relativePath", "mediaKind", "importSlot", "displayName"}
    for item in artifacts:
        if not isinstance(item, dict) or set(item) - artifact_allowed:
            raise ValueError("import_graph_artifact_invalid: unsupported artifact field")
        relative_path = _import_relative_path(item.get("relativePath"))
        relative_path_key = relative_path.casefold()
        if relative_path_key in artifact_paths:
            raise ValueError("import_graph_artifact_duplicate: artifact path is duplicated")
        artifact_paths.add(relative_path_key)
        import_slot = str(item.get("importSlot") or "")
        media_kind = str(item.get("mediaKind") or "")
        shape = slot_shapes.get(import_slot)
        if shape is None or media_kind != shape[0]:
            raise ValueError("import_graph_artifact_invalid: media kind does not match import slot")
        display_name = str(item.get("displayName") or os.path.basename(relative_path)).strip()
        if not display_name:
            raise ValueError("import_graph_artifact_invalid: display name is required")
        normalized_artifacts.append({
            "relativePath": relative_path,
            "relativePathKey": relative_path_key,
            "mediaKind": media_kind,
            "importSlot": import_slot,
            "displayName": display_name,
        })
    normalized_artifacts.sort(key=lambda item: (item["relativePathKey"], item["importSlot"]))

    canonical_manifest = json.dumps({
        "schemaVersion": 2,
        "projectName": project_name,
        "importSessionId": session_id,
        "artifacts": [
            {key: item[key] for key in ("relativePath", "mediaKind", "importSlot", "displayName")}
            for item in normalized_artifacts
        ],
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    project = project_row(db, project_name)
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    timestamp = int(time.time() * 1000)
    session = db.execute(
        "SELECT * FROM media_import_graph_sessions WHERE project_id=? AND import_session_id=?",
        (project["id"], session_id),
    ).fetchone()
    if session is not None and session["manifest_json"] != canonical_manifest:
        raise ValueError("import_graph_session_conflict: the import session has a different manifest")
    if session is None:
        db.execute(
            """INSERT INTO media_import_graph_sessions(project_id,import_session_id,manifest_json,status,error,created_at,updated_at)
               VALUES(?,?,?,'pending',NULL,?,?)""",
            (project["id"], session_id, canonical_manifest, timestamp, timestamp),
        )
    elif session["status"] != "committed":
        db.execute(
            "UPDATE media_import_graph_sessions SET status='pending',error=NULL,updated_at=? WHERE project_id=? AND import_session_id=?",
            (timestamp, project["id"], session_id),
        )
    db.commit()

    try:
        db.execute("BEGIN IMMEDIATE")
        nodes_by_path = {}
        for item in normalized_artifacts:
            folder_path = canonical_path(os.path.join(project_path, *item["relativePath"].split("/")))
            if not is_project_descendant(folder_path, project_path) or not os.path.isdir(folder_path):
                raise ValueError(f"import_graph_folder_missing: {item['relativePath']}")
            existing = db.execute(
                "SELECT * FROM progress_folders WHERE project_id=? AND folder_path_key=?",
                (project["id"], folder_path.casefold()),
            ).fetchone()
            mapping = db.execute(
                "SELECT * FROM media_import_artifact_slots WHERE project_id=? AND relative_path_key=?",
                (project["id"], item["relativePathKey"]),
            ).fetchone()
            expected_media, expected_role, expected_artifact = slot_shapes[item["importSlot"]]
            if existing is not None:
                if mapping is not None and mapping["progress_id"] != existing["id"]:
                    raise ValueError(f"import_graph_role_conflict: {item['relativePath']} mapping does not match its node")
                current_slot = str(mapping["import_slot"]) if mapping is not None else ""
                if mapping is None:
                    # A bounded project-root scan or watcher may register the
                    # directory before the importer commits its receipt. Adopt
                    # only an untracked, structurally compatible material node;
                    # ordinary progress/selection/workflow nodes remain denied.
                    has_relations = db.execute(
                        """SELECT 1 FROM version_graph_edges WHERE project_id=?
                           AND (source_progress_id=? OR target_progress_id=?) LIMIT 1""",
                        (project["id"], existing["id"], existing["id"]),
                    ).fetchone() is not None
                    compatible_slot = item["importSlot"]
                    compatible = False
                    if existing["media_kind"] == expected_media and not existing["tracking_enabled"] \
                            and existing["tracking_state"] == "disabled" and existing["parent_progress_id"] is None:
                        if item["importSlot"] in ("raw", "mov"):
                            compatible = existing["node_role"] == "original" and existing["artifact_kind"] is None and not has_relations
                        elif item["importSlot"] == "camera_jpg":
                            compatible = existing["node_role"] == "original" and existing["artifact_kind"] in (None, "companion")
                        elif item["importSlot"] == "generated_jpg" and existing["node_role"] == "original" \
                                and existing["artifact_kind"] == "companion":
                            # Canonical reconciliation has stronger evidence
                            # that this is a camera companion; never silently
                            # downgrade it into a generated preview.
                            compatible = True
                            compatible_slot = "camera_jpg"
                        elif item["importSlot"] in ("generated_jpg", "video_preview"):
                            compatible = existing["node_role"] == "artifact" and existing["artifact_kind"] == "preview"
                    if not compatible:
                        raise ValueError(f"import_graph_role_conflict: {item['relativePath']} is not safely adoptable")
                    adopted_shape = slot_shapes[compatible_slot]
                    db.execute(
                        """UPDATE progress_folders SET node_role=?,artifact_kind=?,missing_since=NULL,
                           tombstone_json='{}',updated_at=? WHERE id=?""",
                        (adopted_shape[1], adopted_shape[2], timestamp, existing["id"]),
                    )
                    db.execute(
                        """INSERT INTO media_import_artifact_slots(
                             project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
                           VALUES(?,?,?,?,?,?)""",
                        (project["id"], existing["id"], compatible_slot, item["relativePathKey"], timestamp, timestamp),
                    )
                    current_slot = compatible_slot
                    mapping = db.execute(
                        "SELECT * FROM media_import_artifact_slots WHERE project_id=? AND progress_id=?",
                        (project["id"], existing["id"]),
                    ).fetchone()
                    existing = db.execute("SELECT * FROM progress_folders WHERE id=?", (existing["id"],)).fetchone()
                current_shape = slot_shapes[current_slot]
                if existing["media_kind"] != current_shape[0] or existing["node_role"] != current_shape[1] or existing["artifact_kind"] != current_shape[2]:
                    raise ValueError(f"import_graph_role_conflict: {item['relativePath']} import metadata is inconsistent")
                if current_slot == "generated_jpg" and item["importSlot"] == "camera_jpg":
                    db.execute(
                        "DELETE FROM version_graph_edges WHERE project_id=? AND target_progress_id=? AND edge_kind='derived_preview'",
                        (project["id"], existing["id"]),
                    )
                    db.execute(
                        """UPDATE progress_folders SET node_role='original',artifact_kind='companion',missing_since=NULL,
                           tombstone_json='{}',updated_at=? WHERE id=?""",
                        (timestamp, existing["id"]),
                    )
                    db.execute(
                        "UPDATE media_import_artifact_slots SET import_slot='camera_jpg',updated_at=? WHERE project_id=? AND progress_id=?",
                        (timestamp, project["id"], existing["id"]),
                    )
                elif current_slot == "camera_jpg" and item["importSlot"] == "generated_jpg":
                    pass
                elif current_slot != item["importSlot"]:
                    raise ValueError(f"import_graph_role_conflict: {item['relativePath']} import slot cannot be changed")
                else:
                    db.execute(
                        "UPDATE progress_folders SET missing_since=NULL,tombstone_json='{}' WHERE id=?",
                        (existing["id"],),
                    )
                registered_row = next(row for row in progress_rows(db, project["id"]) if row["id"] == existing["id"])
                registered = serialize_progress(registered_row)
            else:
                if mapping is not None:
                    raise ValueError(f"import_graph_role_conflict: {item['relativePath']} mapping does not match its node")
                registered = progress_register(root, db, {
                    "projectName": project_name,
                    "mediaKind": expected_media,
                    "versionKey": "import-" + hashlib.sha256(item["relativePathKey"].encode("utf-8")).hexdigest()[:24],
                    "displayName": item["displayName"],
                    "folderPath": folder_path,
                    "nodeRole": expected_role,
                    "artifactKind": expected_artifact,
                    "trackingEnabled": False,
                    "renameFromParent": False,
                    "copyMissingFromParent": False,
                    "trackingState": "disabled",
                }, commit=False, sync_locations=False)["progressFolder"]
                db.execute(
                    """INSERT INTO media_import_artifact_slots(
                         project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
                       VALUES(?,?,?,?,?,?)""",
                    (project["id"], registered["id"], item["importSlot"], item["relativePathKey"], timestamp, timestamp),
                )
            nodes_by_path[item["relativePath"].casefold()] = registered

        slot_rows = db.execute(
            """SELECT slot.*,progress.* FROM media_import_artifact_slots slot
               JOIN progress_folders progress ON progress.id=slot.progress_id AND progress.project_id=slot.project_id
               WHERE slot.project_id=? AND progress.missing_since IS NULL ORDER BY slot.updated_at DESC,slot.progress_id""",
            (project["id"],),
        ).fetchall()
        nodes_by_group_and_slot = {}
        for row in slot_rows:
            relative_key = str(row["relative_path_key"] or "").replace("\\", "/")
            group_key = relative_key.rsplit("/", 1)[0] if "/" in relative_key else ""
            nodes_by_group_and_slot.setdefault((group_key, row["import_slot"]), []).append(row)
        for (group_key, slot), rows in nodes_by_group_and_slot.items():
            if len(rows) > 1:
                raise ValueError(f"import_graph_slot_ambiguous: multiple {slot} nodes are registered in {group_key or 'project root'}")

        desired_relations = []
        group_keys = sorted({group_key for group_key, _slot in nodes_by_group_and_slot})
        def add_slot_relation(group_key, source_slot, target_slot, edge_kind):
            source_rows = nodes_by_group_and_slot.get((group_key, source_slot), [])
            target_rows = nodes_by_group_and_slot.get((group_key, target_slot), [])
            if source_rows and target_rows:
                desired_relations.append((source_rows[0], target_rows[0], edge_kind))

        for group_key in group_keys:
            add_slot_relation(group_key, "raw", "camera_jpg", "media_companion")
            add_slot_relation(group_key, "raw", "generated_jpg", "derived_preview")
            add_slot_relation(group_key, "mov", "video_preview", "derived_preview")
        committed_edges = []
        for source, target, edge_kind in desired_relations:
            edge_payload = {
                "projectId": project["id"],
                "sourceProgressId": source["id"],
                "targetProgressId": target["id"],
                "edgeKind": edge_kind,
            }
            existing = db.execute(
                """SELECT * FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                   AND target_progress_id=? AND edge_kind=?""",
                (project["id"], source["id"], target["id"], edge_kind),
            ).fetchone()
            if existing is None:
                project_id, source_id, target_id, edge_kind = _validated_version_graph_edge(db, edge_payload)
                edge_id = str(uuid.uuid4())
                db.execute(
                    """INSERT INTO version_graph_edges(id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (edge_id, project_id, source_id, target_id, edge_kind, timestamp, timestamp),
                )
                existing = db.execute("SELECT * FROM version_graph_edges WHERE id=?", (edge_id,)).fetchone()
            committed_edges.append(serialize_version_graph_edge(existing))
        db.execute(
            "UPDATE media_import_graph_sessions SET status='committed',error=NULL,updated_at=? WHERE project_id=? AND import_session_id=?",
            (timestamp, project["id"], session_id),
        )
        db.commit()
        return {"success": True, "importSessionId": session_id, "nodes": list(nodes_by_path.values()), "edges": committed_edges}
    except Exception as error:
        db.rollback()
        db.execute(
            "UPDATE media_import_graph_sessions SET status='failed',error=?,updated_at=? WHERE project_id=? AND import_session_id=?",
            (str(error), int(time.time() * 1000), project["id"], session_id),
        )
        db.commit()
        raise


def progress_adopt_media(root: str, db, payload: dict):
    """Atomically adopt a user-created folder into the explicit media graph.

    The renderer never supplies a node role, edge kind or arbitrary source
    path. Electron resolves the project-relative path and this function derives
    the only legal role/edge shape from ``mode``.
    """
    allowed = {"projectName", "folderPath", "mode", "mediaKind", "sourceProgressId"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValueError("media_adopt_payload_invalid: 请求字段无效")
    project_name = str(payload.get("projectName") or "").strip()
    mode = str(payload.get("mode") or "").strip()
    media_kind = str(payload.get("mediaKind") or "").strip()
    source_id = str(payload.get("sourceProgressId") or "").strip()
    if not project_name or mode not in ("original", "companion", "preview") or media_kind not in ("image", "video"):
        raise ValueError("media_adopt_payload_invalid: 素材类型或接管方式无效")
    if mode == "companion" and media_kind != "image":
        raise ValueError("media_adopt_payload_invalid: 配套素材只适用于图片")
    if (mode == "original" and source_id) or (mode != "original" and not source_id):
        raise ValueError("media_adopt_payload_invalid: 来源节点无效")
    project = project_row(db, project_name)
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    folder_path = canonical_path(payload.get("folderPath") or "")
    if not is_project_descendant(folder_path, project_path) or not os.path.isdir(folder_path):
        raise ValueError("media_adopt_folder_invalid: 只能接管项目内现有文件夹")
    existing = db.execute(
        "SELECT * FROM progress_folders WHERE project_id=? AND folder_path_key=?",
        (project["id"], folder_path.casefold()),
    ).fetchone()
    source = None
    if source_id:
        source = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=? AND missing_since IS NULL",
            (source_id, project["id"]),
        ).fetchone()
        if source is None or source["media_kind"] != media_kind or source["node_role"] not in ("original", "progress"):
            raise ValueError("media_adopt_source_invalid: 来源必须是同项目、同媒体类型的原始素材或主进度")
        if mode == "companion" and source["node_role"] != "original":
            raise ValueError("media_adopt_source_invalid: 配套素材来源必须是原始素材")
        if source["folder_path_key"] == folder_path.casefold():
            raise ValueError("media_adopt_source_invalid: 来源和目标不能相同")

    target_role = "original" if mode in ("original", "companion") else "artifact"
    artifact_kind = "companion" if mode == "companion" else "preview" if mode == "preview" else None
    edge_kind = "media_companion" if mode == "companion" else "derived_preview" if mode == "preview" else None
    timestamp = int(time.time() * 1000)
    with db:
        if existing is not None:
            mapping = db.execute(
                "SELECT * FROM media_import_artifact_slots WHERE project_id=? AND progress_id=?",
                (project["id"], existing["id"]),
            ).fetchone()
            exact_shape = existing["media_kind"] == media_kind and existing["node_role"] == target_role \
                and existing["artifact_kind"] == artifact_kind and existing["parent_progress_id"] is None
            if mapping is not None and not exact_shape:
                raise ValueError("media_adopt_import_managed: 导入器管理的素材不能改变角色")
            relation_rows = db.execute(
                """SELECT * FROM version_graph_edges WHERE project_id=?
                   AND (source_progress_id=? OR target_progress_id=?)""",
                (project["id"], existing["id"], existing["id"]),
            ).fetchall()
            expected_relation = edge_kind and any(
                row["source_progress_id"] == source_id and row["target_progress_id"] == existing["id"]
                and row["edge_kind"] == edge_kind for row in relation_rows
            )
            unexpected_relations = [row for row in relation_rows if not expected_relation or not (
                row["source_progress_id"] == source_id and row["target_progress_id"] == existing["id"]
                and row["edge_kind"] == edge_kind
            )]
            safely_convertible = existing["parent_progress_id"] is None and not existing["tracking_enabled"] \
                and existing["tracking_state"] == "disabled" and existing["node_role"] in ("original", "artifact") \
                and not unexpected_relations
            if exact_shape and edge_kind and unexpected_relations:
                raise ValueError("media_adopt_role_conflict: 产物已经连接到其他来源")
            if not exact_shape and not safely_convertible:
                raise ValueError("media_adopt_role_conflict: 文件夹已有版本或工作流关系，不能接管")
        registered = progress_register(root, db, {
            "projectName": project_name,
            "progressId": existing["id"] if existing is not None else None,
            "mediaKind": media_kind,
            "versionKey": existing["version_key"] if existing is not None else "adopt-" + hashlib.sha256(
                os.path.relpath(folder_path, project_path).replace("\\", "/").casefold().encode("utf-8")
            ).hexdigest()[:24],
            "displayName": existing["display_name"] if existing is not None else os.path.basename(folder_path),
            "folderPath": folder_path,
            "nodeRole": target_role,
            "artifactKind": artifact_kind,
            "trackingEnabled": False,
            "trackingState": "disabled",
            "renameFromParent": False,
            "copyMissingFromParent": False,
        }, commit=False, sync_locations=False)
        target_id = registered["progressFolder"]["id"]
        edge = None
        if edge_kind:
            edge = db.execute(
                """SELECT * FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
                   AND target_progress_id=? AND edge_kind=?""",
                (project["id"], source_id, target_id, edge_kind),
            ).fetchone()
            if edge is None:
                _validated_version_graph_edge(db, {
                    "projectId": project["id"], "sourceProgressId": source_id,
                    "targetProgressId": target_id, "edgeKind": edge_kind,
                })
                edge_id = str(uuid.uuid4())
                db.execute(
                    """INSERT INTO version_graph_edges(
                         id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (edge_id, project["id"], source_id, target_id, edge_kind, timestamp, timestamp),
                )
                edge = db.execute("SELECT * FROM version_graph_edges WHERE id=?", (edge_id,)).fetchone()
    row = next(row for row in progress_rows(db, project["id"]) if row["id"] == target_id)
    return {
        "success": True,
        "progressFolder": serialize_progress(row),
        "edge": serialize_version_graph_edge(edge) if edge is not None else None,
    }


def progress_update_tree(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    updates = payload.get("updates")
    primary_id = str(payload.get("primaryProgressId") or "")
    replacement_id = str(payload.get("replacementProgressId") or "")
    if not primary_id or not isinstance(updates, list) or not updates:
        raise ValueError("没有可更新的进度关系")

    rows = {row["id"]: row for row in progress_rows(db, project["id"])}
    update_ids = {str(update.get("id") or "") for update in updates}
    if "" in update_ids or len(update_ids) != len(updates) or primary_id not in update_ids:
        raise ValueError("进度更新列表无效")
    if any(progress_id not in rows for progress_id in update_ids):
        raise ValueError("要修改的进度不存在")
    children_by_parent = {}
    for row in rows.values():
        parent_id = row["parent_progress_id"]
        if parent_id and row["relation_kind"] == "main" and row["node_role"] == "progress":
            children_by_parent.setdefault(parent_id, []).append(row["id"])
    expected_ids = set()

    def collect_subtree(progress_id):
        expected_ids.add(progress_id)
        for child_id in children_by_parent.get(progress_id, []):
            collect_subtree(child_id)

    collect_subtree(replacement_id or primary_id)
    if replacement_id:
        replacement = rows.get(replacement_id)
        replacement_target = rows.get(primary_id)
        if replacement is None or replacement_target is None or replacement_id == primary_id:
            raise ValueError("失效进度替换目标无效")
        if replacement["media_kind"] != replacement_target["media_kind"]:
            raise ValueError("失效进度替换时不能改变图片或视频类型")
        if os.path.isdir(replacement["folder_path"]):
            raise ValueError("被替换进度的原文件夹仍然存在")
        expected_ids.discard(replacement_id)
        expected_ids.add(primary_id)
    if update_ids != expected_ids:
        raise ValueError("必须一次性更新当前进度及其全部后代")

    normalized = []
    target_versions = set()
    target_names = set()
    target_paths = set()
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    for update in updates:
        progress_id = str(update["id"])
        row = rows[progress_id]
        if row["node_role"] != "progress":
            raise ValueError("修改版本树只接受 progress 节点")
        media_kind = str(update.get("mediaKind") or row["media_kind"])
        if media_kind != row["media_kind"]:
            raise ValueError("修改进度时不能改变图片或视频类型")
        version_key = str(update.get("versionKey") or "")
        if not version_key or len(version_key) > 128 or any(ord(character) < 32 for character in version_key):
            raise ValueError("无效的版本编号")
        display_name = str(update.get("displayName") or "").strip()
        if not display_name:
            raise ValueError("进度名称不能为空")
        folder_path = canonical_path(update.get("folderPath") or "")
        if not is_project_descendant(folder_path, project_path) or not os.path.isdir(folder_path):
            raise ValueError("版本进度必须是项目内的文件夹")
        parent_id = update.get("parentProgressId") or None
        if parent_id:
            parent = rows.get(parent_id)
            if parent is None or parent["media_kind"] != media_kind or parent["node_role"] not in ("original", "progress"):
                raise ValueError("父版本进度不存在")

        version_identity = (media_kind, version_key.casefold())
        name_identity = display_name.casefold()
        path_identity = folder_path.casefold()
        if version_identity in target_versions:
            raise ValueError(f"版本 _{version_key} 重复")
        if name_identity in target_names:
            raise ValueError(f"进度名称重复：{display_name}")
        if path_identity in target_paths:
            raise ValueError(f"进度文件夹重复：{display_name}")
        target_versions.add(version_identity)
        target_names.add(name_identity)
        target_paths.add(path_identity)
        if update.get("trackingState"):
            tracking_state = str(update["trackingState"])
        elif "trackingEnabled" in update:
            tracking_state = "ready" if bool(update["trackingEnabled"]) else "disabled"
        else:
            tracking_state = str(row["tracking_state"] or ("ready" if row["tracking_enabled"] else "disabled"))
        if tracking_state not in PROGRESS_TRACKING_STATES:
            raise ValueError("无效的版本跟踪状态")
        tracking_enabled = int(update.get("trackingEnabled", row["tracking_enabled"]))
        if tracking_state == "disabled":
            tracking_enabled = 0
        normalized.append((progress_id, media_kind, version_key, parent_id, display_name, folder_path, tracking_enabled, tracking_state))

    for row in rows.values():
        if row["id"] in update_ids:
            continue
        if (row["media_kind"], row["version_key"].casefold()) in target_versions:
            raise ValueError(f"版本 _{row['version_key']} 已存在")
        if row["display_name"].casefold() in target_names:
            raise ValueError(f"进度名称已存在：{row['display_name']}")
        if row["folder_path_key"] in target_paths:
            raise ValueError(f"进度文件夹已登记：{row['display_name']}")

    timestamp = int(time.time() * 1000)
    try:
        # Unique(project, kind, version) requires temporary values so swaps and
        # prefix remaps can be committed as one transaction.
        for index, (progress_id, _media_kind, _version_key, _parent_id, _display_name, _folder_path, _tracking_enabled, _tracking_state) in enumerate(normalized):
            db.execute(
                "UPDATE progress_folders SET version_key=?,updated_at=? WHERE id=?",
                (f"__progress_update_{index}_{uuid.uuid4().hex}", timestamp, progress_id),
            )
        for progress_id, media_kind, version_key, parent_id, display_name, folder_path, tracking_enabled, tracking_state in normalized:
            db.execute(
                """UPDATE progress_folders SET media_kind=?,version_key=?,parent_progress_id=?,
                   relation_kind=CASE WHEN ? IS NULL THEN NULL ELSE 'main' END,display_name=?,
                   folder_path=?,folder_path_key=?,folder_id=?,tracking_enabled=?,tracking_state=?,missing_since=NULL,updated_at=? WHERE id=?""",
                (media_kind, version_key, parent_id, parent_id, display_name, folder_path, folder_path.casefold(),
                 directory_identity(folder_path), tracking_enabled, tracking_state, timestamp, progress_id),
            )
        if replacement_id:
            # The physical directory identity moved to the recovered progress.
            # Clear it from the now-missing former progress so a later location
            # sync cannot bind both database rows to the same folder.
            db.execute(
                """UPDATE progress_folders SET folder_id=NULL,missing_since=COALESCE(missing_since,?),updated_at=?
                   WHERE id=?""",
                (timestamp, timestamp, replacement_id),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise

    refreshed = progress_rows(db, project["id"])
    primary = next(row for row in refreshed if row["id"] == primary_id)
    return {
        "success": True,
        "progressFolder": serialize_progress(primary),
        "progressFolders": [serialize_progress(row) for row in refreshed],
    }


def _progress_row_by_id(db, progress_id: str):
    row = db.execute("SELECT project_id FROM progress_folders WHERE id=?", (progress_id,)).fetchone()
    if row is None:
        raise ValueError("版本节点不存在")
    return next(item for item in progress_rows(db, row["project_id"]) if item["id"] == progress_id)


def progress_policy_save(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    row = _progress_row_by_id(db, progress_id)
    tracking_enabled = bool(payload.get("trackingEnabled", row["tracking_enabled"]))
    rename_from_parent = bool(payload.get("renameFromParent", row["rename_from_parent"]))
    copy_missing_from_parent = bool(payload.get("copyMissingFromParent", row["copy_missing_from_parent"]))
    restricted_policy = row["node_role"] in ("original", "artifact", "workflow") or row["relation_kind"] == "auxiliary"
    if restricted_policy:
        if tracking_enabled or rename_from_parent or copy_missing_from_parent:
            raise ValueError("original/selection/artifact/workflow 节点禁止开启版本跟踪")
    if not tracking_enabled and (rename_from_parent or copy_missing_from_parent):
        raise ValueError("未开启跟踪时不能保存沿用文件名或补齐策略")
    tracking_state = str(payload.get("trackingState") or row["tracking_state"])
    if tracking_state not in PROGRESS_TRACKING_STATES:
        raise ValueError("无效的版本跟踪状态")
    if not tracking_enabled or restricted_policy:
        tracking_state = "disabled"
    timestamp = int(time.time() * 1000)
    db.execute(
        """UPDATE progress_folders SET tracking_enabled=?,rename_from_parent=?,copy_missing_from_parent=?,
           tracking_state=?,updated_at=? WHERE id=?""",
        (int(tracking_enabled), int(rename_from_parent), int(copy_missing_from_parent),
         tracking_state, timestamp, progress_id),
    )
    db.commit()
    return {"success": True, "progressFolder": serialize_progress(_progress_row_by_id(db, progress_id))}


def progress_mark_stale(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    timestamp = int(time.time() * 1000)
    changed = db.execute(
        """UPDATE progress_folders SET tracking_state='stale',updated_at=?
           WHERE id=? AND node_role='progress' AND (relation_kind='main' OR parent_progress_id IS NULL)
             AND tracking_enabled=1 AND tracking_state='ready' AND missing_since IS NULL""",
        (timestamp, progress_id),
    ).rowcount
    db.commit()
    return {"success": True, "changed": bool(changed), "progressFolder": serialize_progress(_progress_row_by_id(db, progress_id))}


def progress_mark_ready(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    row = _progress_row_by_id(db, progress_id)
    if (row["node_role"] != "progress" or row["relation_kind"] == "auxiliary"
            or not row["tracking_enabled"]):
        raise ValueError("只有已开启跟踪的 main progress 可以恢复 ready")
    snapshot = payload.get("trackingSnapshot") or {}
    if not isinstance(snapshot, (dict, list)):
        raise ValueError("无效的跟踪快照")
    timestamp = int(payload.get("trackedAt") or int(time.time() * 1000))
    signature = str(payload.get("folderSignature") or "") or None
    db.execute(
        """UPDATE progress_folders SET tracking_state='ready',last_tracked_at=?,tracking_snapshot_json=?,
           folder_signature=?,updated_at=? WHERE id=?""",
        (timestamp, json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), signature, timestamp, progress_id),
    )
    db.commit()
    return {"success": True, "progressFolder": serialize_progress(_progress_row_by_id(db, progress_id))}


def progress_copy_missing_children(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    parent = _progress_row_by_id(db, progress_id)
    rows = db.execute(
        """SELECT id FROM progress_folders WHERE project_id=? AND media_kind=? AND parent_progress_id=?
           AND relation_kind='main' AND node_role='progress' AND tracking_enabled=1
           AND copy_missing_from_parent=1 AND tracking_state='ready' AND missing_since IS NULL
           ORDER BY created_at,id""",
        (parent["project_id"], parent["media_kind"], progress_id),
    ).fetchall()
    return {"success": True, "progressIds": [row["id"] for row in rows]}


def progress_main_branch(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    start = _progress_row_by_id(db, progress_id)
    if start["node_role"] == "selection" or start["relation_kind"] == "auxiliary":
        return {"success": True, "progressFolders": []}
    include_missing = bool(payload.get("includeMissing"))
    rows = progress_rows(db, start["project_id"])
    by_id = {row["id"]: row for row in rows}
    selected = {progress_id}
    cursor = start
    while cursor["parent_progress_id"] and cursor["relation_kind"] == "main":
        cursor = by_id.get(cursor["parent_progress_id"])
        if cursor is None or cursor["node_role"] == "selection":
            break
        selected.add(cursor["id"])
    queue = list(selected)
    while queue:
        parent_id = queue.pop(0)
        for row in rows:
            if row["parent_progress_id"] == parent_id and row["relation_kind"] == "main" and row["node_role"] != "selection" and row["id"] not in selected:
                selected.add(row["id"])
                queue.append(row["id"])
    visible = [row for row in rows if row["id"] in selected and (include_missing or row["missing_since"] is None)]
    return {"success": True, "progressFolders": [serialize_progress(row) for row in visible]}


def progress_visible_relations(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    start = _progress_row_by_id(db, progress_id)
    rows = progress_rows(db, start["project_id"])
    by_id = {row["id"]: row for row in rows}
    ancestors = []
    cursor = start
    visited = set()
    while cursor["parent_progress_id"]:
        if cursor["id"] in visited:
            raise ValueError("版本关系形成循环")
        visited.add(cursor["id"])
        cursor = by_id.get(cursor["parent_progress_id"])
        if cursor is None:
            break
        if cursor["missing_since"] is None:
            ancestors.append(cursor["id"])
    descendants = []
    visible_parent_by_id = {}
    queue = [(progress_id, progress_id)]
    while queue:
        parent_id, nearest_visible = queue.pop(0)
        for child in (row for row in rows if row["parent_progress_id"] == parent_id):
            if child["missing_since"] is None:
                descendants.append(child["id"])
                visible_parent_by_id[child["id"]] = nearest_visible
                queue.append((child["id"], child["id"]))
            else:
                queue.append((child["id"], nearest_visible))
    return {
        "success": True,
        "visibleAncestorIds": ancestors,
        "visibleDescendantIds": descendants,
        "visibleParentById": visible_parent_by_id,
    }


def cleanup_progress_tombstones(root: str, db, cutoff: int | None = None):
    cutoff = int(cutoff if cutoff is not None else int(time.time() * 1000) - PROGRESS_TOMBSTONE_RETENTION_MS)
    candidates = db.execute(
        """SELECT * FROM progress_folders WHERE missing_since IS NOT NULL AND missing_since<=?
           ORDER BY project_id,media_kind,missing_since""",
        (cutoff,),
    ).fetchall()
    removed = []
    removed_selection_metadata = []
    reparented = 0
    skipped = []
    timestamp = int(time.time() * 1000)
    for candidate in candidates:
        if db.execute(
            "SELECT 1 FROM tracking_sessions WHERE progress_id=? OR parent_progress_id=? LIMIT 1",
            (candidate["id"], candidate["id"]),
        ).fetchone() is not None:
            skipped.append(candidate["id"])
            continue
        if os.path.isdir(candidate["folder_path"]):
            skipped.append(candidate["id"])
            continue
        parent_id = candidate["parent_progress_id"]
        while parent_id:
            parent = db.execute("SELECT * FROM progress_folders WHERE id=?", (parent_id,)).fetchone()
            if parent is None:
                parent_id = None
                break
            if parent["missing_since"] is None:
                break
            parent_id = parent["parent_progress_id"]
        children = db.execute("SELECT * FROM progress_folders WHERE parent_progress_id=?", (candidate["id"],)).fetchall()
        orphaned_selections = [child for child in children if parent_id is None and child["node_role"] == "selection"]
        if orphaned_selections:
            blocked_selection_ids = [child["id"] for child in orphaned_selections if db.execute(
                """SELECT 1 WHERE EXISTS(SELECT 1 FROM tracking_sessions WHERE progress_id=? OR parent_progress_id=?)
                   OR EXISTS(SELECT 1 FROM progress_folders WHERE parent_progress_id=?)""",
                (child["id"], child["id"], child["id"]),
            ).fetchone() is not None]
            if blocked_selection_ids:
                skipped.append(candidate["id"])
                continue
            # A selection node cannot legally become a root. Remove only its
            # relationship metadata; its existing folder and media stay on disk
            # and therefore become an ordinary project folder.
            for child in orphaned_selections:
                db.execute("DELETE FROM progress_folders WHERE id=?", (child["id"],))
                removed.append(child["id"])
                removed_selection_metadata.append(child["id"])
            children = [child for child in children if child["id"] not in removed_selection_metadata]
        for child in children:
            relation_kind = None if parent_id is None else ("auxiliary" if child["node_role"] == "selection" else "main")
            db.execute(
                """UPDATE progress_folders SET parent_progress_id=?,relation_kind=?,updated_at=? WHERE id=?""",
                (parent_id, relation_kind, timestamp, child["id"]),
            )
            reparented += 1
        db.execute("DELETE FROM progress_folders WHERE id=?", (candidate["id"],))
        removed.append(candidate["id"])
    db.commit()
    return {
        "removedProgressIds": removed,
        "removedSelectionMetadataIds": removed_selection_metadata,
        "reparentedProgressCount": reparented,
        "skippedProgressIds": skipped,
    }


def progress_delete_missing(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    sync_progress_folder_locations(root, db, project)
    progress_id = str(payload.get("progressId") or "")
    progress = db.execute(
        "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
        (progress_id, project["id"]),
    ).fetchone()
    if progress is None:
        raise ValueError("失效版本记录不存在")
    if progress["node_role"] == "original" or progress["version_key"] == "0":
        raise ValueError("原始版本 V0 受保护，不能移除")
    if os.path.isdir(progress["folder_path"]):
        raise ValueError("版本文件夹仍然存在，不能按失效记录移除")

    batches = db.execute(
        """SELECT * FROM version_batches
           WHERE project_id=? AND (source_folder_path_key=? OR (source_folder_id IS NOT NULL AND source_folder_id=?))
           ORDER BY sequence""",
        (project["id"], progress["folder_path_key"], progress["folder_id"]),
    ).fetchall()
    batch_ids = [row["id"] for row in batches]
    version_rows = []
    if batch_ids:
        placeholders = ",".join("?" for _ in batch_ids)
        version_rows = db.execute(
            f"""SELECT DISTINCT versions.* FROM versions
                JOIN batch_items ON batch_items.version_id=versions.id
                WHERE batch_items.batch_id IN ({placeholders}) AND versions.is_deleted=0""",
            batch_ids,
        ).fetchall()
    # The filesystem is authoritative here. A stale file_missing flag must never
    # allow a still-existing media file to be detached from version history.
    available_count = sum(os.path.isfile(row["file_path"]) for row in version_rows)
    if available_count:
        raise ValueError(f"该节点仍关联 {available_count} 个可用文件，请在版本管理中逐个处理")

    cleanup = delete_version_rows(db, version_rows)
    deleted_batch_ids = set(batch_ids)
    parent_by_batch = {row["id"]: row["parent_batch_id"] for row in batches}
    for batch in db.execute(
        "SELECT id,parent_batch_id FROM version_batches WHERE project_id=? AND parent_batch_id IS NOT NULL",
        (project["id"],),
    ).fetchall():
        parent_id = batch["parent_batch_id"]
        visited = set()
        while parent_id in deleted_batch_ids and parent_id not in visited:
            visited.add(parent_id)
            parent_id = parent_by_batch.get(parent_id)
        if parent_id != batch["parent_batch_id"]:
            db.execute("UPDATE version_batches SET parent_batch_id=? WHERE id=?", (parent_id, batch["id"]))
    if batch_ids:
        placeholders = ",".join("?" for _ in batch_ids)
        db.execute(f"DELETE FROM version_batches WHERE id IN ({placeholders})", batch_ids)

    timestamp = int(time.time() * 1000)
    reparented_progress_count = db.execute(
        """UPDATE progress_folders SET parent_progress_id=?,
           relation_kind=CASE WHEN ? IS NULL THEN NULL WHEN node_role='selection' THEN 'auxiliary' ELSE 'main' END,
           updated_at=? WHERE parent_progress_id=?""",
        (progress["parent_progress_id"], progress["parent_progress_id"], timestamp, progress_id),
    ).rowcount
    db.execute("DELETE FROM progress_folders WHERE id=?", (progress_id,))
    db.commit()
    return {
        "success": True,
        "progressId": progress_id,
        "versionKey": progress["version_key"],
        "deletedVersionCount": len(version_rows),
        "deletedBatchCount": len(batch_ids),
        "reparentedProgressCount": reparented_progress_count,
        **cleanup,
    }


def batch_summary(db, batch_id: str):
    row = db.execute(
        """SELECT batches.*, parent.sequence AS parent_sequence,
           COUNT(items.id) AS item_count,
           COALESCE(SUM(CASE WHEN items.match_method='visual-hash' THEN 1 ELSE 0 END), 0) AS matched_count,
           COALESCE(SUM(CASE WHEN items.match_method='new' THEN 1 ELSE 0 END), 0) AS new_count
           FROM version_batches AS batches
           LEFT JOIN version_batches AS parent ON parent.id=batches.parent_batch_id
           LEFT JOIN batch_items AS items ON items.batch_id=batches.id
           WHERE batches.id=? GROUP BY batches.id""",
        (batch_id,),
    ).fetchone()
    return serialize_batch(row) if row else None


def batch_list(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    rows = db.execute(
        """SELECT batches.*, parent.sequence AS parent_sequence,
           COUNT(items.id) AS item_count,
           COALESCE(SUM(CASE WHEN items.match_method='visual-hash' THEN 1 ELSE 0 END), 0) AS matched_count,
           COALESCE(SUM(CASE WHEN items.match_method='new' THEN 1 ELSE 0 END), 0) AS new_count
           FROM version_batches AS batches
           LEFT JOIN version_batches AS parent ON parent.id=batches.parent_batch_id
           LEFT JOIN batch_items AS items ON items.batch_id=batches.id
           WHERE batches.project_id=? GROUP BY batches.id ORDER BY batches.sequence""",
        (project["id"],),
    ).fetchall()
    return {"success": True, "batches": [serialize_batch(row) for row in rows]}


def folder_media_files(folder_path: str):
    return [
        entry.path for entry in sorted(os.scandir(folder_path), key=lambda item: item.name.casefold())
        if entry.is_file() and media_type(entry.path)
    ]


def folder_media_snapshot(folder_path: str):
    snapshot = {}
    for file_path in folder_media_files(folder_path):
        stat = os.stat(file_path)
        snapshot[os.path.basename(file_path)] = {
            "size": stat.st_size,
            "modifiedAt": int(stat.st_mtime_ns / 1_000_000),
            "signature": quick_fingerprint(file_path, stat),
        }
    return snapshot


def _tracking_snapshot_parts(row):
    try:
        stored = json.loads(row["tracking_snapshot_json"] or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        stored = {}
    if not isinstance(stored, dict):
        return {}, {}
    files = stored.get("files") if isinstance(stored.get("files"), dict) else {}
    parent = stored.get("parent") if isinstance(stored.get("parent"), dict) else {}
    return files, parent


def _validated_tracking_nodes(root: str, db, project_name: str, progress_id: str):
    project = project_row(db, project_name)
    progress = db.execute(
        "SELECT * FROM progress_folders WHERE id=? AND project_id=?",
        (progress_id, project["id"]),
    ).fetchone()
    if progress is None:
        raise ValueError("主分支进度不存在")
    if progress["node_role"] != "progress" or progress["relation_kind"] != "main":
        raise ValueError("auxiliary/original 节点禁止版本比较、刷新或提交")
    if not progress["tracking_enabled"]:
        raise ValueError("该主分支进度未开启跟踪")
    if not progress["parent_progress_id"]:
        raise ValueError("主分支进度必须指定 parentProgressId")
    parent = db.execute(
        "SELECT * FROM progress_folders WHERE id=? AND project_id=? AND media_kind=?",
        (progress["parent_progress_id"], project["id"], progress["media_kind"]),
    ).fetchone()
    if parent is None or parent["node_role"] not in ("original", "progress") or parent["relation_kind"] == "auxiliary":
        raise ValueError("父节点不存在、媒体类型不兼容或不是主分支节点")

    visited = {progress["id"]}
    cursor = parent
    while cursor is not None:
        if cursor["id"] in visited:
            raise ValueError("主分支关系形成循环")
        visited.add(cursor["id"])
        if not cursor["parent_progress_id"]:
            break
        cursor = db.execute(
            "SELECT * FROM progress_folders WHERE id=? AND project_id=? AND media_kind=?",
            (cursor["parent_progress_id"], project["id"], progress["media_kind"]),
        ).fetchone()
        if cursor is None:
            raise ValueError("主分支父节点关系不完整")

    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    project_real = canonical_path(os.path.realpath(project_path))
    if not os.path.isdir(project_real):
        raise ValueError("项目文件夹不存在")

    def validated_folder(node):
        folder_path = canonical_path(node["folder_path"])
        real_path = canonical_path(os.path.realpath(folder_path))
        if not os.path.isdir(folder_path) or not os.path.isdir(real_path) or node["missing_since"] is not None:
            raise ValueError(f"版本节点文件夹不存在：{node['display_name']}")
        try:
            inside = os.path.commonpath((project_real, real_path)).casefold() == project_real.casefold()
        except ValueError:
            inside = False
        if not inside or real_path.casefold() == project_real.casefold():
            raise ValueError("版本节点目录越出项目范围")
        return real_path

    return project, parent, progress, validated_folder(parent), validated_folder(progress)


def tracking_session_create(root: str, db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    mode = str(payload.get("mode") or "compare")
    if mode not in ("compare", "refresh"):
        raise ValueError("无效的跟踪模式")
    project, parent, progress, parent_path, progress_path = _validated_tracking_nodes(
        root, db, str(payload.get("projectName") or ""), progress_id,
    )
    active = db.execute(
        """SELECT id FROM tracking_sessions WHERE progress_id=?
           AND status IN ('comparing','pending_confirm','committing','failed') LIMIT 1""",
        (progress["id"],),
    ).fetchone()
    if active is not None:
        raise ValueError(f"progress already has an active tracking session: {active['id']}")
    timestamp = int(time.time() * 1000)
    session_id = str(payload.get("sessionId") or uuid.uuid4())
    db.execute(
        """INSERT INTO tracking_sessions(
             id,project_id,progress_id,parent_progress_id,mode,status,previous_tracking_state,
             rename_from_parent,copy_missing_from_parent,created_at,updated_at)
           VALUES(?,?,?,?,?,'comparing',?,?,?,?,?)""",
        (session_id, project["id"], progress["id"], parent["id"], mode, progress["tracking_state"],
         progress["rename_from_parent"], progress["copy_missing_from_parent"], timestamp, timestamp),
    )
    db.execute(
        "UPDATE progress_folders SET tracking_state='pending_compare',updated_at=? WHERE id=?",
        (timestamp, progress["id"]),
    )
    db.commit()
    return {
        "success": True, "sessionId": session_id, "progressId": progress["id"],
        "parentProgressId": parent["id"], "mode": mode,
        "parentFolderPath": parent_path, "progressFolderPath": progress_path,
    }


def tracking_prepare(root: str, db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    mode = str(payload.get("mode") or "compare")
    if mode not in ("compare", "refresh"):
        raise ValueError("无效的跟踪模式")
    project, parent, progress, parent_path, progress_path = _validated_tracking_nodes(
        root, db, str(payload.get("projectName") or ""), progress_id,
    )
    current_files = folder_media_snapshot(progress_path)
    current_parent = folder_media_snapshot(parent_path)
    previous_files, previous_parent = _tracking_snapshot_parts(progress)
    if mode == "refresh" and previous_files:
        source_names = sorted(
            name for name, signature in current_files.items()
            if previous_files.get(name) != signature
        )
        removed_names = sorted(name for name in previous_files if name not in current_files)
    else:
        source_names = sorted(current_files)
        removed_names = []
    copy_candidate_names = []
    if progress["copy_missing_from_parent"]:
        copy_candidate_names = sorted(
            name for name, signature in current_parent.items()
            if previous_parent.get(name) != signature and name not in current_files
        )
    session_id = str(payload.get("sessionId") or "")
    if session_id:
        session = db.execute(
            "SELECT * FROM tracking_sessions WHERE id=? AND project_id=? AND progress_id=?",
            (session_id, project["id"], progress["id"]),
        ).fetchone()
        if session is None or session["status"] != "comparing" or session["mode"] != mode:
            raise ValueError("跟踪会话不存在或状态无效")
    else:
        session_id = tracking_session_create(root, db, payload)["sessionId"]
    return {
        "success": True,
        "sessionId": session_id,
        "progressId": progress["id"],
        "parentProgressId": parent["id"],
        "mode": mode,
        "parentFolderPath": parent_path,
        "progressFolderPath": progress_path,
        "sourceNames": source_names,
        "removedNames": removed_names,
        "copyCandidateNames": copy_candidate_names,
        "renameFromParent": bool(progress["rename_from_parent"]),
        "copyMissingFromParent": bool(progress["copy_missing_from_parent"]),
    }


def _valid_tracking_file_name(value) -> str:
    value = str(value or "")
    if not value or os.path.basename(value) != value or len(value) > 255:
        raise ValueError("跟踪结果包含无效文件名")
    return value


def tracking_store_preview(db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None or session["status"] != "comparing":
        raise ValueError("跟踪会话不存在或状态无效")
    raw_items = payload.get("items") or []
    if not isinstance(raw_items, list) or len(raw_items) > 50_000:
        raise ValueError("跟踪确认结果数量无效")
    timestamp = int(time.time() * 1000)
    db.execute("DELETE FROM tracking_session_items WHERE session_id=?", (session_id,))
    for item in raw_items:
        kind = str(item.get("kind") or "")
        if kind not in ("recognized", "new", "copy_missing", "missing"):
            raise ValueError("无效的跟踪确认项目类型")
        source_name = _valid_tracking_file_name(item.get("sourceName")) if item.get("sourceName") else None
        reference_name = _valid_tracking_file_name(item.get("referenceName")) if item.get("referenceName") else None
        target_name = _valid_tracking_file_name(item.get("targetName")) if item.get("targetName") else source_name
        status = str(item.get("status") or "")
        expected_status = {
            "recognized": "recognized", "new": "pending_confirmation",
            "copy_missing": "pending_confirmation", "missing": "missing_reference",
        }[kind]
        if status != expected_status:
            raise ValueError("比较结果不能跳过用户确认")
        db.execute(
            """INSERT INTO tracking_session_items(
                 id,session_id,item_kind,source_name,reference_name,target_name,status,distance,
                 confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (str(uuid.uuid4()), session_id, kind, source_name, reference_name, target_name, status,
             float(item["distance"]) if item.get("distance") is not None else None,
             str(item.get("confidence") or "")[:40], timestamp, timestamp),
        )
    db.execute(
        "UPDATE tracking_sessions SET status='pending_confirm',error='',updated_at=? WHERE id=?",
        (timestamp, session_id),
    )
    db.execute(
        "UPDATE progress_folders SET tracking_state='pending_confirm',updated_at=? WHERE id=?",
        (timestamp, session["progress_id"]),
    )
    db.commit()
    return tracking_session_get(db, {"sessionId": session_id, "cursor": 0, "limit": 200})


def serialize_tracking_item(row):
    return {
        "id": row["id"], "kind": row["item_kind"], "sourceName": row["source_name"],
        "referenceName": row["reference_name"], "targetName": row["target_name"],
        "status": row["status"], "distance": row["distance"], "confidence": row["confidence"],
    }


def tracking_session_get(db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        raise ValueError("跟踪会话不存在")
    cursor = max(0, int(payload.get("cursor") or 0))
    limit = max(1, min(500, int(payload.get("limit") or 100)))
    total = db.execute("SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?", (session_id,)).fetchone()[0]
    items = db.execute(
        """SELECT * FROM tracking_session_items WHERE session_id=? ORDER BY created_at,id
           LIMIT ? OFFSET ?""",
        (session_id, limit, cursor),
    ).fetchall()
    unresolved = db.execute(
        """SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?
           AND status IN ('pending_confirmation','missing_reference')""",
        (session_id,),
    ).fetchone()[0]
    return {
        "success": True,
        "session": {
            "id": session["id"], "progressId": session["progress_id"],
            "parentProgressId": session["parent_progress_id"], "mode": session["mode"],
            "status": session["status"], "renameFromParent": bool(session["rename_from_parent"]),
            "copyMissingFromParent": bool(session["copy_missing_from_parent"]),
            "committedBatchId": session["committed_batch_id"], "error": session["error"],
            "total": total, "unresolvedCount": unresolved,
        },
        "items": [serialize_tracking_item(row) for row in items],
        "nextCursor": cursor + len(items) if cursor + len(items) < total else None,
    }


def tracking_session_release(db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        return {"success": True, "released": False, "sessionId": session_id}
    if session["status"] != "committed":
        restore_state = session["previous_tracking_state"]
        if restore_state not in PROGRESS_TRACKING_STATES or restore_state in ("pending_compare", "pending_confirm", "committing"):
            restore_state = "stale" if session["mode"] == "refresh" else "needs_repair"
        db.execute(
            """UPDATE progress_folders SET tracking_state=?,updated_at=?
               WHERE id=? AND tracking_state IN ('pending_compare','pending_confirm','committing')""",
            (restore_state, int(time.time() * 1000), session["progress_id"]),
        )
    db.execute("DELETE FROM tracking_sessions WHERE id=?", (session_id,))
    db.commit()
    return {"success": True, "released": True, "sessionId": session_id}


def cleanup_tracking_sessions(db, cutoff: int | None = None):
    cutoff = int(cutoff if cutoff is not None else int(time.time() * 1000) - TRACKING_SESSION_RETENTION_MS)
    rows = db.execute(
        "SELECT id FROM tracking_sessions WHERE updated_at<=? ORDER BY updated_at,id",
        (cutoff,),
    ).fetchall()
    released = []
    for row in rows:
        if tracking_session_release(db, {"sessionId": row["id"]})["released"]:
            released.append(row["id"])
    return {"releasedSessionIds": released, "releasedCount": len(released)}


def progress_detect_stale(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    sync_progress_folder_locations(root, db, project)
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    raw_changed_paths = payload.get("changedPaths") or []
    if not isinstance(raw_changed_paths, list) or len(raw_changed_paths) > 10_000:
        raise ValueError("变化路径列表无效")
    changed_paths = []
    for value in raw_changed_paths:
        candidate = canonical_path(value)
        if candidate.casefold() != project_path.casefold() and not is_project_descendant(candidate, project_path):
            raise ValueError("变化路径超出项目范围")
        changed_paths.append(candidate)
    full_scan = not changed_paths
    rows = progress_rows(db, project["id"])
    by_id = {row["id"]: row for row in rows}
    snapshot_cache = {}

    def path_touched(folder_path):
        if full_scan:
            return True
        folder_key = canonical_path(folder_path).casefold()
        for changed_path in changed_paths:
            changed_key = changed_path.casefold()
            if changed_key == folder_key or changed_key.startswith(folder_key + os.sep) or folder_key.startswith(changed_key + os.sep):
                return True
        return False

    def current_snapshot(node):
        if node["id"] not in snapshot_cache:
            snapshot_cache[node["id"]] = folder_media_snapshot(node["folder_path"]) if os.path.isdir(node["folder_path"]) else None
        return snapshot_cache[node["id"]]

    stale_ids = set()
    propagated_ids = set()
    scanned_ids = set()
    timestamp = int(time.time() * 1000)
    for node in rows:
        if (node["node_role"] != "progress" or node["relation_kind"] != "main"
                or not node["tracking_enabled"] or node["tracking_state"] != "ready"
                or node["missing_since"] is not None or not path_touched(node["folder_path"])):
            continue
        previous_files, _previous_parent = _tracking_snapshot_parts(node)
        current_files = current_snapshot(node)
        scanned_ids.add(node["id"])
        if current_files is None or current_files != previous_files:
            stale_ids.add(node["id"])

    for child in rows:
        if (child["node_role"] != "progress" or child["relation_kind"] != "main"
                or not child["tracking_enabled"] or not child["copy_missing_from_parent"]
                or child["tracking_state"] != "ready" or not child["parent_progress_id"]):
            continue
        parent = by_id.get(child["parent_progress_id"])
        if (parent is None or parent["node_role"] == "selection" or parent["relation_kind"] == "auxiliary"
                or parent["missing_since"] is not None or not path_touched(parent["folder_path"])):
            continue
        _previous_files, previous_parent = _tracking_snapshot_parts(child)
        current_parent = current_snapshot(parent)
        scanned_ids.add(parent["id"])
        if current_parent is not None and any(name not in previous_parent for name in current_parent):
            stale_ids.add(child["id"])
            propagated_ids.add(child["id"])
    if stale_ids:
        placeholders = ",".join("?" for _ in stale_ids)
        db.execute(
            f"UPDATE progress_folders SET tracking_state='stale',updated_at=? WHERE id IN ({placeholders}) AND tracking_state='ready'",
            (timestamp, *sorted(stale_ids)),
        )
        db.commit()
    return {
        "success": True,
        "projectName": project["name"],
        "scannedProgressIds": sorted(scanned_ids),
        "staleProgressIds": sorted(stale_ids),
        "propagatedProgressIds": sorted(propagated_ids),
    }


def tracking_session_decide(root: str, db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    item_id = str(payload.get("itemId") or "")
    decision = str(payload.get("status") or "")
    if decision not in ("accepted", "rejected"):
        raise ValueError("确认结果只能是 accepted 或 rejected")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    item = db.execute(
        "SELECT * FROM tracking_session_items WHERE id=? AND session_id=?",
        (item_id, session_id),
    ).fetchone()
    if session is None or item is None or session["status"] not in ("pending_confirm", "failed"):
        raise ValueError("跟踪确认项目不存在或会话状态无效")
    reference_name = item["reference_name"]
    if payload.get("referenceName"):
        reference_name = _valid_tracking_file_name(payload["referenceName"])
        _project, _parent, _progress, parent_path, _progress_path = _validated_tracking_nodes(
            root, db, db.execute("SELECT name FROM projects WHERE id=?", (session["project_id"],)).fetchone()[0],
            session["progress_id"],
        )
        safe_folder_file(parent_path, reference_name)
    if decision == "accepted" and item["item_kind"] in ("recognized", "copy_missing") and not reference_name:
        raise ValueError("该确认项目缺少上一版本引用")
    timestamp = int(time.time() * 1000)
    db.execute(
        "UPDATE tracking_session_items SET status=?,reference_name=?,updated_at=? WHERE id=?",
        (decision, reference_name, timestamp, item_id),
    )
    db.execute("UPDATE tracking_sessions SET status='pending_confirm',error='',updated_at=? WHERE id=?", (timestamp, session_id))
    db.commit()
    return {"success": True, "item": serialize_tracking_item(db.execute("SELECT * FROM tracking_session_items WHERE id=?", (item_id,)).fetchone())}


def tracking_commit_plan(root: str, db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        raise ValueError("跟踪会话不存在")
    if session["status"] == "committed":
        return {"success": True, "alreadyCommitted": True, "sessionId": session_id, "batchId": session["committed_batch_id"]}
    if session["status"] not in ("pending_confirm", "failed"):
        raise ValueError("跟踪会话当前不能提交")
    if session["status"] == "failed" and not session["committed_batch_id"]:
        item_count = db.execute(
            "SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?", (session_id,)
        ).fetchone()[0]
        if not item_count:
            raise ValueError("版本比较尚未产生可提交结果，请释放会话后重新比较")
    unresolved = db.execute(
        """SELECT COUNT(*) FROM tracking_session_items WHERE session_id=?
           AND status IN ('pending_confirmation','missing_reference')""",
        (session_id,),
    ).fetchone()[0]
    if unresolved:
        raise ValueError(f"仍有 {unresolved} 个跟踪项目需要用户明确处理")
    project_name = db.execute("SELECT name FROM projects WHERE id=?", (session["project_id"],)).fetchone()[0]
    _project, parent, progress, parent_path, progress_path = _validated_tracking_nodes(
        root, db, project_name, session["progress_id"],
    )
    rows = db.execute(
        "SELECT * FROM tracking_session_items WHERE session_id=? AND status IN ('recognized','accepted') ORDER BY created_at,id",
        (session_id,),
    ).fetchall()
    matches = []
    incremental = []
    copies = []
    for item in rows:
        if item["item_kind"] == "copy_missing":
            copies.append(item["reference_name"])
        elif item["reference_name"] and item["source_name"]:
            matches.append({
                "reference": item["reference_name"], "source": item["source_name"],
                "target": item["reference_name"] if session["rename_from_parent"] else (item["target_name"] or item["source_name"]),
                "distance": item["distance"] if item["distance"] is not None else 0,
                "confidence": item["confidence"],
            })
            incremental.append(item["source_name"])
        elif item["source_name"]:
            incremental.append(item["source_name"])
    timestamp = int(time.time() * 1000)
    db.execute("UPDATE tracking_sessions SET status='committing',error='',updated_at=? WHERE id=?", (timestamp, session_id))
    db.execute("UPDATE progress_folders SET tracking_state='committing',updated_at=? WHERE id=?", (timestamp, progress["id"]))
    db.commit()
    return {
        "success": True, "alreadyCommitted": False, "sessionId": session_id,
        "mode": session["mode"], "repairBatchId": session["committed_batch_id"],
        "projectName": project_name, "progressId": progress["id"], "parentProgressId": parent["id"],
        "parentFolderPath": parent_path, "progressFolderPath": progress_path,
        "displayName": progress["display_name"], "renameFromParent": bool(session["rename_from_parent"]),
        "copyMissingFromParent": bool(session["copy_missing_from_parent"]),
        "matches": matches, "incrementalSources": sorted(set(incremental)), "copyReferences": sorted(set(copies)),
    }


def tracking_commit_complete(root: str, db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        raise ValueError("跟踪会话不存在")
    project_name = db.execute("SELECT name FROM projects WHERE id=?", (session["project_id"],)).fetchone()[0]
    _project, _parent, progress, parent_path, progress_path = _validated_tracking_nodes(root, db, project_name, session["progress_id"])
    snapshot = {"files": folder_media_snapshot(progress_path), "parent": folder_media_snapshot(parent_path)}
    timestamp = int(time.time() * 1000)
    db.execute(
        """UPDATE tracking_sessions SET status='committed',committed_batch_id=?,error='',updated_at=? WHERE id=?""",
        (payload.get("batchId") or session["committed_batch_id"], timestamp, session_id),
    )
    db.execute(
        """UPDATE progress_folders SET tracking_state='ready',last_tracked_at=?,tracking_snapshot_json=?,
           folder_signature=?,updated_at=? WHERE id=?""",
        (timestamp, json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
         hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode("utf-8")).hexdigest(), timestamp, progress["id"]),
    )
    db.commit()
    return tracking_session_get(db, {"sessionId": session_id, "cursor": 0, "limit": 200})


def tracking_commit_failed(db, payload: dict):
    session_id = str(payload.get("sessionId") or "")
    session = db.execute("SELECT * FROM tracking_sessions WHERE id=?", (session_id,)).fetchone()
    if session is None:
        raise ValueError("跟踪会话不存在")
    timestamp = int(time.time() * 1000)
    error = str(payload.get("error") or "提交失败")[:2000]
    failed_while_comparing = session["status"] == "comparing"
    db.execute(
        """UPDATE tracking_sessions SET status='failed',error=?,
           committed_batch_id=COALESCE(?,committed_batch_id),updated_at=? WHERE id=?""",
        (error, payload.get("batchId") or None, timestamp, session_id),
    )
    if failed_while_comparing:
        restore_state = "stale" if session["mode"] == "refresh" else "needs_repair"
        db.execute(
            "UPDATE progress_folders SET tracking_state=?,updated_at=? WHERE id=?",
            (restore_state, timestamp, session["progress_id"]),
        )
    else:
        db.execute(
            """UPDATE progress_folders SET tracking_state=CASE WHEN tracking_state='needs_repair'
                 THEN 'needs_repair' ELSE 'pending_confirm' END,updated_at=? WHERE id=?""",
            (timestamp, session["progress_id"]),
        )
    db.commit()
    return {"success": True, "sessionId": session_id, "retryable": True}


def progress_main_branch_media(db, payload: dict):
    progress_id = str(payload.get("progressId") or "")
    photo_id = str(payload.get("photoId") or "") or None
    if not progress_id and photo_id:
        resolved = db.execute(
            """SELECT progress.id FROM versions
               JOIN batch_items items ON items.version_id=versions.id
               JOIN version_batches batches ON batches.id=items.batch_id
               JOIN progress_folders progress
                 ON progress.project_id=batches.project_id
                AND progress.folder_path_key=batches.source_folder_path_key
               WHERE versions.photo_id=? AND versions.is_deleted=0
                 AND progress.node_role IN ('original','progress')
                 AND (progress.relation_kind IS NULL OR progress.relation_kind='main')
               ORDER BY batches.sequence DESC,items.created_at DESC LIMIT 1""",
            (photo_id,),
        ).fetchone()
        if resolved is None:
            raise ValueError("找不到该媒体所属的主分支进度")
        progress_id = resolved["id"]
    if not progress_id:
        raise ValueError("必须提供 progressId 或 photoId")
    start = _progress_row_by_id(db, progress_id)
    if start["node_role"] == "selection" or start["relation_kind"] == "auxiliary":
        raise ValueError("auxiliary/selection 不属于主分支版本历史")
    rows = progress_rows(db, start["project_id"])
    by_id = {row["id"]: row for row in rows}
    root_node = start
    visited = set()
    while root_node["parent_progress_id"] and root_node["relation_kind"] == "main":
        if root_node["id"] in visited:
            raise ValueError("主分支关系形成循环")
        visited.add(root_node["id"])
        parent = by_id.get(root_node["parent_progress_id"])
        if parent is None or parent["node_role"] == "selection" or parent["relation_kind"] == "auxiliary":
            break
        root_node = parent
    children = {}
    for row in rows:
        if row["relation_kind"] != "main" or row["node_role"] == "selection" or not row["parent_progress_id"]:
            continue
        children.setdefault(row["parent_progress_id"], []).append(row)
    for values in children.values():
        values.sort(key=lambda row: (row["created_at"], row["id"]))
    ordered_nodes = []

    def visit(node):
        ordered_nodes.append(node)
        for child in children.get(node["id"], []):
            visit(child)

    visit(root_node)
    entries = []
    seen_versions = set()
    for branch_index, node in enumerate(ordered_nodes):
        parameters = [node["project_id"], node["folder_path_key"]]
        photo_filter = ""
        if photo_id:
            photo_filter = " AND versions.photo_id=?"
            parameters.append(photo_id)
        versions = db.execute(
            f"""SELECT versions.*,photos.original_name,items.created_at AS item_created_at
                FROM version_batches batches
                JOIN batch_items items ON items.batch_id=batches.id
                JOIN versions ON versions.id=items.version_id
                JOIN photos ON photos.id=versions.photo_id
                WHERE batches.project_id=? AND batches.source_folder_path_key=?
                  AND versions.is_deleted=0{photo_filter}
                ORDER BY batches.sequence,items.created_at,items.id""",
            parameters,
        ).fetchall()
        for version in versions:
            if version["id"] in seen_versions:
                continue
            seen_versions.add(version["id"])
            serialized = serialize_version(version)
            serialized["fileMissing"] = serialized["fileMissing"] or not os.path.isfile(version["file_path"])
            entries.append({
                "branchIndex": branch_index,
                "progressId": node["id"],
                "parentProgressId": node["parent_progress_id"],
                "nodeRole": node["node_role"],
                "relationKind": node["relation_kind"],
                "photoId": version["photo_id"],
                "originalName": version["original_name"],
                "version": serialized,
            })
    return {
        "success": True,
        "progressId": progress_id,
        "branchProgressIds": [node["id"] for node in ordered_nodes],
        "entries": entries,
    }


def safe_folder_file(folder_path: str, file_name: str):
    file_name = str(file_name or "")
    if not file_name or os.path.basename(file_name) != file_name:
        raise ValueError("批次匹配包含无效文件名")
    file_path = canonical_path(os.path.join(folder_path, file_name))
    if os.path.dirname(file_path).casefold() != canonical_path(folder_path).casefold():
        raise ValueError("批次匹配文件超出所选文件夹")
    if not os.path.isfile(file_path) or not media_type(file_path):
        raise ValueError(f"批次图片不存在或格式不受支持：{file_name}")
    return file_path


def source_version_row(db, project_id: str, file_path: str):
    file_path = canonical_path(file_path)
    path_key = file_path.casefold()
    identity = file_identity(file_path)
    linked = db.execute(
        """SELECT versions.* FROM batch_items
           JOIN version_batches ON version_batches.id=batch_items.batch_id
           JOIN versions ON versions.id=batch_items.version_id
           WHERE version_batches.project_id=? AND versions.is_deleted=0
             AND (batch_items.source_path_key=? OR (? IS NOT NULL AND batch_items.source_file_id=?))
           ORDER BY version_batches.sequence DESC LIMIT 1""",
        (project_id, path_key, identity, identity),
    ).fetchone()
    if linked is not None:
        return linked
    return db.execute(
        """SELECT versions.* FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0
             AND (versions.file_path_key=? OR (? IS NOT NULL AND versions.file_id=?))
           ORDER BY versions.updated_at DESC LIMIT 1""",
        (project_id, path_key, identity, identity),
    ).fetchone()


def ensure_source_version(db, project, file_path: str, pending_hashes=None):
    row = source_version_row(db, project["id"], file_path)
    if row is not None:
        record = db.execute(
            "SELECT full_hash FROM file_records WHERE owner_type='version' AND owner_id=?",
            (row["id"],),
        ).fetchone()
        if record is None or not record["full_hash"]:
            queue_full_fingerprint(pending_hashes, row["id"], file_path, os.stat(file_path))
        return row
    photo_id = sync_media_file(db, project, file_path, pending_hashes)
    if not photo_id:
        raise ValueError(f"无法登记批次图片：{os.path.basename(file_path)}")
    row = source_version_row(db, project["id"], file_path)
    if row is None:
        row = db.execute(
            "SELECT * FROM versions WHERE photo_id=? AND is_deleted=0 ORDER BY version_number DESC LIMIT 1",
            (photo_id,),
        ).fetchone()
    if row is None:
        raise ValueError(f"无法读取批次版本：{os.path.basename(file_path)}")
    return row


def create_batch_row(db, project_id: str, folder_path: str, display_name: str, parent_batch_id=None, import_key=None):
    timestamp = int(time.time() * 1000)
    sequence = db.execute(
        "SELECT COALESCE(MAX(sequence), 0)+1 FROM version_batches WHERE project_id=?", (project_id,)
    ).fetchone()[0]
    batch_id = str(uuid.uuid4())
    folder_path = canonical_path(folder_path)
    db.execute(
        """INSERT INTO version_batches(id,project_id,sequence,display_name,source_folder_path,
           source_folder_path_key,source_folder_id,parent_batch_id,import_key,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,'importing',?,?)""",
        (batch_id, project_id, sequence, display_name or os.path.basename(folder_path), folder_path,
         folder_path.casefold(), directory_identity(folder_path), parent_batch_id, import_key, timestamp, timestamp),
    )
    return db.execute("SELECT * FROM version_batches WHERE id=?", (batch_id,)).fetchone()


def register_batch_item(db, batch_id: str, version, source_path: str, match_method: str,
                        match_distance=None, confidence="", review_status="confirmed"):
    source_path = canonical_path(source_path)
    stat = os.stat(source_path)
    identity = file_identity(source_path)
    fingerprint = version["file_fingerprint"] if version["file_path_key"] == source_path.casefold() else quick_fingerprint(source_path, stat)
    timestamp = int(time.time() * 1000)
    existing = db.execute(
        "SELECT id FROM batch_items WHERE batch_id=? AND (version_id=? OR source_path_key=?) LIMIT 1",
        (batch_id, version["id"], source_path.casefold()),
    ).fetchone()
    values = (
        version["photo_id"], version["id"], os.path.basename(source_path), source_path, source_path.casefold(),
        identity, fingerprint, match_method, match_distance, confidence, review_status, timestamp,
    )
    if existing:
        db.execute(
            """UPDATE batch_items SET photo_id=?,version_id=?,source_name=?,source_path=?,source_path_key=?,
               source_file_id=?,source_fingerprint=?,match_method=?,match_distance=?,confidence=?,
               review_status=?,updated_at=? WHERE id=?""",
            values + (existing["id"],),
        )
        return existing["id"]
    item_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO batch_items(id,batch_id,photo_id,version_id,source_name,source_path,source_path_key,
           source_file_id,source_fingerprint,match_method,match_distance,confidence,review_status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (item_id, batch_id, *values[:-1], timestamp, timestamp),
    )
    return item_id


def ensure_reference_batch(root: str, db, project, folder_path: str):
    folder_path = canonical_path(folder_path)
    identity = directory_identity(folder_path)
    batch = db.execute(
        """SELECT * FROM version_batches WHERE project_id=?
           AND (source_folder_path_key=? OR (? IS NOT NULL AND source_folder_id=?))
           ORDER BY CASE WHEN status='ready' THEN 0 ELSE 1 END, sequence DESC LIMIT 1""",
        (project["id"], folder_path.casefold(), identity, identity),
    ).fetchone()
    if batch is not None:
        if batch["source_folder_path_key"] != folder_path.casefold():
            db.execute(
                """UPDATE version_batches SET source_folder_path=?,source_folder_path_key=?,source_folder_id=?,
                   updated_at=? WHERE id=?""",
                (folder_path, folder_path.casefold(), identity, int(time.time() * 1000), batch["id"]),
            )
            db.commit()
            batch = db.execute("SELECT * FROM version_batches WHERE id=?", (batch["id"],)).fetchone()
        db.execute(
            "UPDATE version_batches SET status='importing',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
    else:
        batch = create_batch_row(
            db, project["id"], folder_path, os.path.basename(folder_path), import_key=f"baseline-{uuid.uuid4()}"
        )
    db.commit()
    try:
        current_source_keys = set()
        for file_path in folder_media_files(folder_path):
            current_source_keys.add(canonical_path(file_path).casefold())
            pending_hashes = []
            version = ensure_source_version(db, project, file_path, pending_hashes)
            register_batch_item(db, batch["id"], version, file_path, "baseline")
            db.commit()
            backfill_full_fingerprints(db, pending_hashes)
        stale_items = db.execute(
            "SELECT id,source_path_key FROM batch_items WHERE batch_id=?",
            (batch["id"],),
        ).fetchall()
        for item in stale_items:
            if item["source_path_key"] not in current_source_keys:
                db.execute("DELETE FROM batch_items WHERE id=?", (item["id"],))
        db.execute(
            "UPDATE version_batches SET status='ready',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
        db.commit()
    except Exception:
        db.rollback()
        db.execute(
            "UPDATE version_batches SET status='failed',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
        db.commit()
        raise
    return db.execute("SELECT * FROM version_batches WHERE id=?", (batch["id"],)).fetchone()


def batch_register_baseline(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    folder_path = canonical_path(payload["folderPath"])
    try:
        batch = ensure_reference_batch(root, db, project, folder_path)
    except Exception:
        set_progress_tracking_state_for_folder(db, project["id"], folder_path, "pending_compare")
        db.commit()
        raise
    version_name = str(payload.get("versionName") or "").strip()
    if version_name:
        db.execute(
            """UPDATE versions SET version_name=?,updated_at=?
                 WHERE version_number=0 AND id IN (
                   SELECT version_id FROM batch_items WHERE batch_id=?
                 )""",
            (version_name, int(time.time() * 1000), batch["id"]),
        )
        db.commit()
    set_progress_tracking_state_for_folder(db, project["id"], folder_path, "ready")
    db.commit()
    return {"success": True, "batch": batch_summary(db, batch["id"])}


def merge_source_photo_history(db, project, source_path: str, target_photo_id: str, parent_version_id: str, version_name: str):
    """Attach an already-registered returned image to an earlier photo history.

    A returned image can be used by team retouch before its V0 relationship is
    registered. Preserve that V1 version ID and move every dependent row to the
    V0 photo instead of deleting and recreating the version.
    """
    source_path = canonical_path(source_path)
    identity = file_identity(source_path)
    row = db.execute(
        """SELECT versions.* FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.is_deleted=0
             AND (versions.file_path_key=? OR (? IS NOT NULL AND versions.file_id=?))
           ORDER BY versions.updated_at DESC LIMIT 1""",
        (project["id"], source_path.casefold(), identity, identity),
    ).fetchone()
    if row is None:
        return None
    if row["photo_id"] == target_photo_id:
        return row

    source_photo_id = row["photo_id"]
    versions = db.execute(
        "SELECT * FROM versions WHERE photo_id=? ORDER BY version_number,created_at,id",
        (source_photo_id,),
    ).fetchall()
    if not versions:
        raise ValueError(f"{os.path.basename(source_path)} 的已有版本历史为空")
    source_version_ids = {version["id"] for version in versions}
    if parent_version_id in source_version_ids:
        raise ValueError(f"{os.path.basename(source_path)} 的版本关系形成循环")
    if db.execute(
        "SELECT id FROM versions WHERE id=? AND photo_id=? AND is_deleted=0",
        (parent_version_id, target_photo_id),
    ).fetchone() is None:
        raise ValueError("要补入的 V0 不属于目标版本历史")

    timestamp = int(time.time() * 1000)
    source_final_ids = [version["id"] for version in versions if version["is_final"] and not version["is_deleted"]]
    db.execute("UPDATE photos SET current_version_id=NULL,updated_at=? WHERE id=?", (timestamp, source_photo_id))
    db.execute("UPDATE versions SET is_current=0,is_final=0,updated_at=? WHERE photo_id=?", (timestamp, source_photo_id))
    if source_final_ids:
        db.execute("UPDATE versions SET is_final=0,updated_at=? WHERE photo_id=?", (timestamp, target_photo_id))

    next_number = db.execute(
        "SELECT COALESCE(MAX(version_number),-1)+1 FROM versions WHERE photo_id=?",
        (target_photo_id,),
    ).fetchone()[0]
    pending = {version["id"]: version for version in versions}
    moved = set()
    while pending:
        ready = [
            version for version in pending.values()
            if version["parent_version_id"] is None or version["parent_version_id"] not in source_version_ids or version["parent_version_id"] in moved
        ]
        if not ready:
            raise ValueError(f"{os.path.basename(source_path)} 的已有版本历史包含循环")
        for version in ready:
            previous_parent_id = version["parent_version_id"]
            next_parent_id = previous_parent_id if previous_parent_id in source_version_ids else parent_version_id
            db.execute(
                """UPDATE versions SET photo_id=?,parent_version_id=?,version_number=?,updated_at=?
                   WHERE id=?""",
                (target_photo_id, next_parent_id, next_number, timestamp, version["id"]),
            )
            next_number += 1
            moved.add(version["id"])
            pending.pop(version["id"])

    # Move every owner reference before deleting the now-empty source photo.
    db.execute("UPDATE batch_items SET photo_id=?,updated_at=? WHERE photo_id=?", (target_photo_id, timestamp, source_photo_id))
    db.execute("UPDATE version_compare_history SET photo_id=? WHERE photo_id=?", (target_photo_id, source_photo_id))
    db.execute("UPDATE team_patch_tasks SET photo_id=?,updated_at=? WHERE photo_id=?", (target_photo_id, timestamp, source_photo_id))
    db.execute("UPDATE team_person_assignments SET photo_id=?,updated_at=? WHERE photo_id=?", (target_photo_id, timestamp, source_photo_id))
    db.execute("UPDATE team_person_exclusions SET photo_id=? WHERE photo_id=?", (target_photo_id, source_photo_id))

    registration = db.execute(
        "SELECT * FROM team_retouch_photos WHERE photo_id=?",
        (source_photo_id,),
    ).fetchone()
    if registration is not None:
        # The returned V1 is the later workflow base. Its registration replaces
        # an older V0 registration while all actual tasks remain intact.
        db.execute("DELETE FROM team_retouch_photos WHERE photo_id=?", (target_photo_id,))
        db.execute(
            "UPDATE team_retouch_photos SET photo_id=?,project_id=?,updated_at=? WHERE photo_id=?",
            (target_photo_id, project["id"], timestamp, source_photo_id),
        )

    selected_version_id = row["id"]
    db.execute("UPDATE versions SET is_current=0,updated_at=? WHERE photo_id=?", (timestamp, target_photo_id))
    db.execute(
        """UPDATE versions SET version_name=?,version_type='batch',status='draft',is_current=1,
           author=?,note=?,updated_at=? WHERE id=?""",
        (version_name, os.environ.get("USERNAME") or "本机用户",
         f"补入早期版本后由进度“{version_name}”接入", timestamp, selected_version_id),
    )
    if source_final_ids:
        db.execute("UPDATE versions SET is_final=1,updated_at=? WHERE id=?", (timestamp, source_final_ids[-1]))
    db.execute(
        "UPDATE photos SET current_version_id=?,updated_at=? WHERE id=?",
        (selected_version_id, timestamp, target_photo_id),
    )
    db.execute("DELETE FROM photos WHERE id=?", (source_photo_id,))
    return db.execute("SELECT * FROM versions WHERE id=?", (selected_version_id,)).fetchone()


def create_linked_batch_version(db, project, batch, parent, source_path: str, pending_hashes=None):
    existing_item = db.execute(
        """SELECT versions.* FROM batch_items JOIN versions ON versions.id=batch_items.version_id
           WHERE batch_items.batch_id=? AND batch_items.source_path_key=? AND versions.is_deleted=0 LIMIT 1""",
        (batch["id"], canonical_path(source_path).casefold()),
    ).fetchone()
    if existing_item is not None:
        if existing_item["photo_id"] != parent["photo_id"]:
            merged = merge_source_photo_history(
                db, project, source_path, parent["photo_id"], parent["id"], batch["display_name"],
            )
            if merged is None:
                raise ValueError(f"无法合并已有版本：{os.path.basename(source_path)}")
            return merged, None
        return existing_item, None

    merged = merge_source_photo_history(
        db, project, source_path, parent["photo_id"], parent["id"], batch["display_name"],
    )
    if merged is not None:
        return merged, None
    next_number = db.execute(
        "SELECT COALESCE(MAX(version_number), -1)+1 FROM versions WHERE photo_id=?", (parent["photo_id"],)
    ).fetchone()[0]
    source_path = canonical_path(source_path)
    stat = os.stat(source_path)
    identity = file_identity(source_path)
    fingerprint = quick_fingerprint(source_path, stat)
    cached_record = db.execute(
        """SELECT full_hash FROM file_records
           WHERE current_path=? AND file_size=? AND modified_at=? AND quick_hash=? AND missing=0
             AND full_hash IS NOT NULL ORDER BY updated_at DESC LIMIT 1""",
        (source_path, stat.st_size, int(stat.st_mtime_ns / 1_000_000), fingerprint),
    ).fetchone()
    cached_hash = cached_record["full_hash"] if cached_record is not None else None
    timestamp = int(time.time() * 1000)
    version_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO versions(id,photo_id,parent_version_id,version_number,version_name,version_type,file_path,
           file_path_key,file_id,file_fingerprint,file_size,file_modified_at,author,note,status,is_current,is_final,
           created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (version_id, parent["photo_id"], parent["id"], next_number,
         batch["display_name"], "batch", source_path, source_path.casefold(),
         identity, fingerprint, stat.st_size, int(stat.st_mtime_ns / 1_000_000),
         os.environ.get("USERNAME") or "本机用户", f"由进度“{batch['display_name']}”自动建立",
         "draft", 0, 0, timestamp, timestamp),
    )
    upsert_file_record(db, version_id, source_path, stat, identity, fingerprint, cached_hash)
    if not cached_hash:
        queue_full_fingerprint(pending_hashes, version_id, source_path, stat)
    return db.execute("SELECT * FROM versions WHERE id=?", (version_id,)).fetchone(), None


def serialize_batch_operation(row):
    return {
        "id": row["id"], "batchId": row["batch_id"], "operationType": row["operation_type"],
        "sourcePath": row["source_path"], "targetPath": row["target_path"], "status": row["status"],
        "attemptCount": row["attempt_count"], "error": row["error"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def set_progress_tracking_state_for_folder(db, project_id: str, folder_path: str, state: str):
    if state not in PROGRESS_TRACKING_STATES:
        raise ValueError("无效的版本跟踪状态")
    timestamp = int(time.time() * 1000)
    db.execute(
        """UPDATE progress_folders SET tracking_state=?,
           last_tracked_at=CASE WHEN ?='ready' THEN ? ELSE last_tracked_at END,updated_at=?
           WHERE project_id=? AND folder_path_key=? AND node_role='progress'
             AND relation_kind='main' AND tracking_enabled=1""",
        (state, state, timestamp, timestamp, project_id, canonical_path(folder_path).casefold()),
    )


def plan_confirmed_batch_renames(db, batch_id: str, folder_path: str, matches: list):
    folder_path = canonical_path(folder_path)
    timestamp = int(time.time() * 1000)
    for match in matches:
        source_name = str(match.get("source") or "")
        target_name = str(match.get("target") or "")
        if not target_name or target_name == source_name:
            continue
        source_path = safe_folder_file(folder_path, source_name)
        if os.path.basename(target_name) != target_name:
            raise ValueError("目标文件名无效")
        target_path = canonical_path(os.path.join(folder_path, target_name))
        if os.path.dirname(target_path).casefold() != folder_path.casefold():
            raise ValueError("目标文件超出所选文件夹")
        planning_error = ""
        if os.path.exists(target_path):
            planning_error = f"目标文件已存在：{target_name}"
        if db.execute(
            "SELECT id FROM batch_items WHERE batch_id=? AND source_path_key=? LIMIT 1",
            (batch_id, source_path.casefold()),
        ).fetchone() is None:
            planning_error = f"没有找到对应的批次记录：{source_name}"
        db.execute(
            """INSERT INTO batch_file_operations(id,batch_id,operation_type,source_path,target_path,
               status,attempt_count,error,created_at,updated_at)
               VALUES(?,?,'rename',?,?,?,0,?,?,?)
               ON CONFLICT(batch_id,operation_type,source_path,target_path) DO NOTHING""",
            (str(uuid.uuid4()), batch_id, source_path, target_path,
             "failed" if planning_error else "pending", planning_error, timestamp, timestamp),
        )


def apply_pending_batch_operations(db, batch_id: str):
    batch = db.execute("SELECT * FROM version_batches WHERE id=?", (batch_id,)).fetchone()
    if batch is None:
        raise ValueError("版本批次不存在")
    operations = db.execute(
        """SELECT * FROM batch_file_operations WHERE batch_id=? AND status IN ('pending','failed','running')
           ORDER BY created_at,id""", (batch_id,),
    ).fetchall()
    succeeded = 0
    errors = []
    for operation in operations:
        timestamp = int(time.time() * 1000)
        db.execute(
            "UPDATE batch_file_operations SET status='running',attempt_count=attempt_count+1,error='',updated_at=? WHERE id=?",
            (timestamp, operation["id"]),
        )
        db.commit()
        try:
            source_path = canonical_path(operation["source_path"])
            target_path = canonical_path(operation["target_path"])
            item = db.execute(
                "SELECT * FROM batch_items WHERE batch_id=? AND source_path_key=? LIMIT 1",
                (batch_id, source_path.casefold()),
            ).fetchone()
            if item is None:
                item = db.execute(
                    "SELECT * FROM batch_items WHERE batch_id=? AND source_path_key=? LIMIT 1",
                    (batch_id, target_path.casefold()),
                ).fetchone()
            if item is None:
                raise ValueError("没有找到对应的批次记录")
            if os.path.exists(source_path):
                if os.path.exists(target_path):
                    raise FileExistsError(f"目标文件已存在：{os.path.basename(target_path)}")
                os.rename(source_path, target_path)
            elif not os.path.isfile(target_path):
                raise FileNotFoundError(f"源文件和目标文件都不存在：{os.path.basename(source_path)}")
            stat = os.stat(target_path)
            identity = file_identity(target_path)
            fingerprint = quick_fingerprint(target_path, stat)
            if item["source_fingerprint"] and item["source_fingerprint"] != fingerprint:
                raise ValueError("目标文件内容与待重命名素材不一致")
            existing_record = db.execute(
                "SELECT full_hash FROM file_records WHERE owner_type='version' AND owner_id=?",
                (item["version_id"],),
            ).fetchone()
            authoritative_hash = existing_record["full_hash"] if existing_record is not None else None
            if not authoritative_hash:
                authoritative_hash = full_fingerprint(target_path)
            timestamp = int(time.time() * 1000)
            db.execute(
                """UPDATE batch_items SET source_name=?,source_path=?,source_path_key=?,source_file_id=?,updated_at=?
                   WHERE id=?""",
                (os.path.basename(target_path), target_path, target_path.casefold(), identity, timestamp, item["id"]),
            )
            db.execute(
                """UPDATE versions SET file_path=?,file_path_key=?,file_id=?,file_fingerprint=?,file_size=?,
                   file_modified_at=?,file_missing=0,content_changed=0,updated_at=? WHERE id=?""",
                (target_path, target_path.casefold(), identity, fingerprint, stat.st_size,
                 int(stat.st_mtime_ns / 1_000_000), timestamp, item["version_id"]),
            )
            upsert_file_record(db, item["version_id"], target_path, stat, identity, fingerprint, authoritative_hash)
            db.execute(
                "UPDATE batch_file_operations SET status='succeeded',error='',updated_at=? WHERE id=?",
                (timestamp, operation["id"]),
            )
            db.commit()
            succeeded += 1
        except Exception as error:
            db.rollback()
            timestamp = int(time.time() * 1000)
            db.execute(
                "UPDATE batch_file_operations SET status='failed',error=?,updated_at=? WHERE id=?",
                (str(error), timestamp, operation["id"]),
            )
            db.commit()
            errors.append({
                "operationId": operation["id"], "source": os.path.basename(operation["source_path"]),
                "target": os.path.basename(operation["target_path"]), "error": str(error),
            })
    remaining = db.execute(
        "SELECT COUNT(*) FROM batch_file_operations WHERE batch_id=? AND status!='succeeded'",
        (batch_id,),
    ).fetchone()[0]
    final_status = "needs_repair" if remaining else "ready"
    timestamp = int(time.time() * 1000)
    db.execute("UPDATE version_batches SET status=?,updated_at=? WHERE id=?", (final_status, timestamp, batch_id))
    set_progress_tracking_state_for_folder(db, batch["project_id"], batch["source_folder_path"], final_status)
    db.commit()
    return {
        "renamedCount": succeeded,
        "renameErrors": errors,
        "repairRequired": bool(remaining),
        "operationCount": len(operations),
    }


def rename_confirmed_batch_sources(db, batch_id: str, folder_path: str, matches: list):
    plan_confirmed_batch_renames(db, batch_id, folder_path, matches)
    db.execute("UPDATE version_batches SET status='applying',updated_at=? WHERE id=?", (int(time.time() * 1000), batch_id))
    db.commit()
    return apply_pending_batch_operations(db, batch_id)


def batch_operation_list(db, payload: dict):
    batch_id = str(payload.get("batchId") or "")
    rows = db.execute(
        "SELECT * FROM batch_file_operations WHERE batch_id=? ORDER BY created_at,id", (batch_id,),
    ).fetchall()
    batch = db.execute("SELECT * FROM version_batches WHERE id=?", (batch_id,)).fetchone()
    if batch is None:
        raise ValueError("版本批次不存在")
    return {"success": True, "batch": batch_summary(db, batch_id), "operations": [serialize_batch_operation(row) for row in rows]}


def batch_retry_operations(db, payload: dict):
    batch_id = str(payload.get("batchId") or "")
    result = apply_pending_batch_operations(db, batch_id)
    return {"success": not result["repairRequired"], "batch": batch_summary(db, batch_id), **result}


def batch_commit_compare(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    folder_a = canonical_path(payload["folderA"])
    folder_b = canonical_path(payload["folderB"])
    if not os.path.isdir(folder_a) or not os.path.isdir(folder_b):
        raise ValueError("批次文件夹不存在")
    if folder_a.casefold() == folder_b.casefold():
        raise ValueError("对照批次和新返图不能是同一个文件夹")
    set_progress_tracking_state_for_folder(db, project["id"], folder_b, "committing")
    db.commit()

    reference_batch = ensure_reference_batch(root, db, project, folder_a)
    pending_hashes = []
    # Register and hash returned files one by one before the relationship
    # transaction starts. Later batch writes can then reuse cached hashes and
    # never hold SQLite's writer slot while reading a large RAW/video file.
    for source_path in folder_media_files(folder_b):
        preflight_hashes = []
        ensure_source_version(db, project, source_path, preflight_hashes)
        db.commit()
        backfill_full_fingerprints(db, preflight_hashes)
    import_key = str(payload.get("importKey") or uuid.uuid4())
    batch = db.execute("SELECT * FROM version_batches WHERE import_key=?", (import_key,)).fetchone()
    if batch is None and payload.get("reconcileExisting"):
        folder_identity = directory_identity(folder_b)
        batch = db.execute(
            """SELECT * FROM version_batches WHERE project_id=? AND parent_batch_id=? AND status='ready'
               AND (source_folder_path_key=? OR (? IS NOT NULL AND source_folder_id=?))
               ORDER BY sequence DESC LIMIT 1""",
            (project["id"], reference_batch["id"], folder_b.casefold(), folder_identity, folder_identity),
        ).fetchone()
    if batch is not None and batch["project_id"] != project["id"]:
        raise ValueError("批次提交标识已被其他项目使用")
    if batch is not None and batch["status"] == "ready" and not payload.get("reconcileExisting"):
        set_progress_tracking_state_for_folder(db, project["id"], folder_b, "ready")
        db.commit()
        return {
            "success": True, "alreadyCommitted": True,
            "referenceBatch": batch_summary(db, reference_batch["id"]),
            "batch": batch_summary(db, batch["id"]),
        }
    if batch is not None and batch["status"] == "ready":
        created_paths = []
        try:
            incremental_sources = [
                safe_folder_file(folder_b, source_name)
                for source_name in (payload.get("incrementalSources") or [])
            ]
            matches = sorted(
                payload.get("matches") or [],
                key=lambda match: float(match.get("distance") if match.get("distance") is not None else 1_000_000),
            )
            best_versions = {}
            matched_source_keys = set()
            for match in matches:
                reference_path = safe_folder_file(folder_a, match.get("reference"))
                source_path = safe_folder_file(folder_b, match.get("source"))
                source_key = source_path.casefold()
                if source_key in matched_source_keys:
                    continue
                matched_source_keys.add(source_key)
                parent = ensure_source_version(db, project, reference_path, pending_hashes)
                register_batch_item(db, reference_batch["id"], parent, reference_path, "baseline")
                version, created_path = create_linked_batch_version(db, project, batch, parent, source_path, pending_hashes)
                register_batch_item(
                    db, batch["id"], version, source_path, "visual-hash",
                    float(match.get("distance") or 0), str(match.get("confidence") or ""), "confirmed",
                )
                if created_path:
                    created_paths.append(created_path)
                best_versions.setdefault(version["photo_id"], version["id"])

            current_source_keys = set()
            for source_path in incremental_sources or folder_media_files(folder_b):
                source_key = source_path.casefold()
                current_source_keys.add(source_key)
                if source_key in matched_source_keys:
                    continue
                version = ensure_source_version(db, project, source_path, pending_hashes)
                register_batch_item(db, batch["id"], version, source_path, "new", review_status="new")
            if not incremental_sources:
                stale_items = db.execute(
                    "SELECT id,source_path_key FROM batch_items WHERE batch_id=?",
                    (batch["id"],),
                ).fetchall()
                for item in stale_items:
                    if item["source_path_key"] not in current_source_keys:
                        db.execute("DELETE FROM batch_items WHERE id=?", (item["id"],))

            timestamp = int(time.time() * 1000)
            for photo_id, version_id in best_versions.items():
                db.execute("UPDATE versions SET is_current=0,updated_at=? WHERE photo_id=?", (timestamp, photo_id))
                db.execute("UPDATE versions SET is_current=1,updated_at=? WHERE id=?", (timestamp, version_id))
                db.execute("UPDATE photos SET current_version_id=?,updated_at=? WHERE id=?", (version_id, timestamp, photo_id))
            if payload.get("renameSources"):
                plan_confirmed_batch_renames(db, batch["id"], folder_b, matches)
            db.execute(
                "UPDATE version_batches SET status=?,updated_at=? WHERE id=?",
                ("applying" if payload.get("renameSources") else "ready", timestamp, batch["id"]),
            )
            if not payload.get("renameSources"):
                set_progress_tracking_state_for_folder(db, project["id"], folder_b, "ready")
            db.commit()
            backfill_full_fingerprints(db, pending_hashes)
            rename_result = apply_pending_batch_operations(db, batch["id"]) if payload.get("renameSources") else {"renamedCount": 0, "renameErrors": [], "repairRequired": False, "operationCount": 0}
            return {
                "success": True,
                "reconciled": True,
                "referenceBatch": batch_summary(db, reference_batch["id"]),
                "batch": batch_summary(db, batch["id"]),
                **rename_result,
            }
        except Exception:
            db.rollback()
            db.execute(
                "UPDATE version_batches SET status='failed',updated_at=? WHERE id=?",
                (int(time.time() * 1000), batch["id"]),
            )
            set_progress_tracking_state_for_folder(db, project["id"], folder_b, "pending_compare")
            db.commit()
            for created_path in created_paths:
                try:
                    os.unlink(created_path)
                except OSError:
                    pass
            raise
    if batch is None:
        batch = create_batch_row(
            db, project["id"], folder_b, payload.get("displayName") or os.path.basename(folder_b),
            parent_batch_id=reference_batch["id"], import_key=import_key,
        )
        db.commit()
    else:
        db.execute(
            "UPDATE version_batches SET status='importing',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
        db.commit()

    matched_source_keys = set()
    created_paths = []
    try:
        matches = sorted(
            payload.get("matches") or [],
            key=lambda match: float(match.get("distance") if match.get("distance") is not None else 1_000_000),
        )
        for match in matches:
            reference_path = safe_folder_file(folder_a, match.get("reference"))
            source_path = safe_folder_file(folder_b, match.get("source"))
            source_key = source_path.casefold()
            if source_key in matched_source_keys:
                continue
            matched_source_keys.add(source_key)
            parent = ensure_source_version(db, project, reference_path, pending_hashes)
            register_batch_item(db, reference_batch["id"], parent, reference_path, "baseline")
            version, created_path = create_linked_batch_version(db, project, batch, parent, source_path, pending_hashes)
            register_batch_item(
                db, batch["id"], version, source_path, "visual-hash",
                float(match.get("distance") or 0), str(match.get("confidence") or ""), "confirmed",
            )
            if created_path:
                created_paths.append(created_path)

        for source_path in folder_media_files(folder_b):
            if source_path.casefold() in matched_source_keys:
                continue
            version = ensure_source_version(db, project, source_path, pending_hashes)
            register_batch_item(db, batch["id"], version, source_path, "new", review_status="new")

        best_versions = {}
        rows = db.execute(
            """SELECT photo_id,version_id,match_distance FROM batch_items
               WHERE batch_id=? AND match_method='visual-hash'
               ORDER BY COALESCE(match_distance, 1000000), created_at""",
            (batch["id"],),
        ).fetchall()
        for row in rows:
            best_versions.setdefault(row["photo_id"], row["version_id"])
        timestamp = int(time.time() * 1000)
        for photo_id, version_id in best_versions.items():
            db.execute("UPDATE versions SET is_current=0,updated_at=? WHERE photo_id=?", (timestamp, photo_id))
            db.execute("UPDATE versions SET is_current=1,updated_at=? WHERE id=?", (timestamp, version_id))
            db.execute("UPDATE photos SET current_version_id=?,updated_at=? WHERE id=?", (version_id, timestamp, photo_id))
        if payload.get("renameSources"):
            plan_confirmed_batch_renames(db, batch["id"], folder_b, matches)
        db.execute(
            "UPDATE version_batches SET status=?,updated_at=? WHERE id=?",
            ("applying" if payload.get("renameSources") else "ready", timestamp, batch["id"]),
        )
        if not payload.get("renameSources"):
            set_progress_tracking_state_for_folder(db, project["id"], folder_b, "ready")
        db.commit()
        backfill_full_fingerprints(db, pending_hashes)
        rename_result = apply_pending_batch_operations(db, batch["id"]) if payload.get("renameSources") else {"renamedCount": 0, "renameErrors": [], "repairRequired": False, "operationCount": 0}
        return {
            "success": True,
            "referenceBatch": batch_summary(db, reference_batch["id"]),
            "batch": batch_summary(db, batch["id"]),
            **rename_result,
        }
    except Exception:
        db.rollback()
        db.execute(
            "UPDATE version_batches SET status='failed',updated_at=? WHERE id=?",
            (int(time.time() * 1000), batch["id"]),
        )
        set_progress_tracking_state_for_folder(db, project["id"], folder_b, "pending_compare")
        db.commit()
        raise


def media_create_version(db, payload: dict):
    photo_id = payload["photoId"]
    source = db.execute("SELECT * FROM versions WHERE id=? AND photo_id=? AND is_deleted=0", (payload["parentVersionId"], photo_id)).fetchone()
    if source is None:
        raise ValueError("基础版本不存在")
    file_path = canonical_path(payload["filePath"])
    if not os.path.isfile(file_path):
        raise ValueError("新版本文件不存在或不可读取")
    stat = os.stat(file_path)
    identity = file_identity(file_path)
    fingerprint = quick_fingerprint(file_path, stat)
    authoritative_hash = full_fingerprint(file_path)
    timestamp = int(time.time() * 1000)
    next_number = db.execute("SELECT COALESCE(MAX(version_number), -1)+1 FROM versions WHERE photo_id=?", (photo_id,)).fetchone()[0]
    version_id = payload.get("versionId") or str(uuid.uuid4())
    db.execute("UPDATE versions SET is_current=0, updated_at=? WHERE photo_id=?", (timestamp, photo_id))
    if payload.get("isFinal"):
        db.execute("UPDATE versions SET is_final=0, updated_at=? WHERE photo_id=?", (timestamp, photo_id))
    db.execute(
        """INSERT INTO versions(id,photo_id,parent_version_id,version_number,version_name,version_type,file_path,
           file_path_key,file_id,file_fingerprint,file_size,file_modified_at,author,note,status,is_current,is_final,
           created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (version_id, photo_id, source["id"], next_number, payload.get("versionName") or f"版本 {next_number}",
         payload.get("versionType") or "custom", file_path, file_path.casefold(), identity, fingerprint, stat.st_size,
         int(stat.st_mtime_ns / 1_000_000), payload.get("author") or os.environ.get("USERNAME") or "本机用户",
         payload.get("note") or "", payload.get("status") or "draft", 1, int(bool(payload.get("isFinal"))), timestamp, timestamp),
    )
    db.execute("UPDATE photos SET current_version_id=?, updated_at=? WHERE id=?", (version_id, timestamp, photo_id))
    upsert_file_record(db, version_id, file_path, stat, identity, fingerprint, authoritative_hash)
    db.commit()
    return {"success": True, **media_bundle(db, photo_id)}


def media_update_version(db, payload: dict):
    row = db.execute("SELECT * FROM versions WHERE id=? AND is_deleted=0", (payload["versionId"],)).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    timestamp = int(time.time() * 1000)
    fields, values = [], []
    if "versionName" in payload:
        name = str(payload["versionName"]).strip()
        if not name:
            raise ValueError("版本名称不能为空")
        fields.append("version_name=?")
        values.append(name)
    if "note" in payload:
        fields.append("note=?")
        values.append(str(payload["note"]))
    if "isFinal" in payload:
        if payload["isFinal"]:
            db.execute("UPDATE versions SET is_final=0 WHERE photo_id=?", (row["photo_id"],))
        fields.append("is_final=?")
        values.append(int(bool(payload["isFinal"])))
    if payload.get("makeCurrent"):
        db.execute("UPDATE versions SET is_current=0 WHERE photo_id=?", (row["photo_id"],))
        fields.append("is_current=1")
        db.execute("UPDATE photos SET current_version_id=?, updated_at=? WHERE id=?", (row["id"], timestamp, row["photo_id"]))
    fields.append("updated_at=?")
    values.append(timestamp)
    values.append(row["id"])
    db.execute(f"UPDATE versions SET {', '.join(fields)} WHERE id=?", values)
    db.commit()
    return {"success": True, **media_bundle(db, row["photo_id"])}


def media_refresh_metadata_fingerprint(db, payload: dict):
    """Accept an in-app metadata-only write without flagging a visual version change."""
    file_path = canonical_path(payload["filePath"])
    if not os.path.isfile(file_path):
        return {"success": True, "updatedCount": 0}
    rows = db.execute(
        """SELECT id,photo_id,version_number FROM versions
           WHERE file_path_key=? AND is_deleted=0""",
        (file_path.casefold(),),
    ).fetchall()
    if not rows:
        return {"success": True, "updatedCount": 0}
    stat = os.stat(file_path)
    identity = file_identity(file_path)
    fingerprint = quick_fingerprint(file_path, stat)
    authoritative_hash = full_fingerprint(file_path)
    modified_at = int(stat.st_mtime_ns / 1_000_000)
    timestamp = int(time.time() * 1000)
    for row in rows:
        db.execute(
            """UPDATE versions SET file_id=?,file_fingerprint=?,file_size=?,file_modified_at=?,
               file_missing=0,updated_at=? WHERE id=?""",
            (identity, fingerprint, stat.st_size, modified_at, timestamp, row["id"]),
        )
        if row["version_number"] == 0:
            db.execute(
                """UPDATE photos SET original_file_path=?,original_file_id=?,original_fingerprint=?,updated_at=?
                   WHERE id=?""",
                (file_path, identity, fingerprint, timestamp, row["photo_id"]),
            )
        upsert_file_record(db, row["id"], file_path, stat, identity, fingerprint, authoritative_hash)
    db.commit()
    return {"success": True, "updatedCount": len(rows)}


def final_version_list(db, payload: dict):
    project = project_row(db, payload["projectName"])
    rows = db.execute(
        """SELECT versions.*,photos.display_name AS photo_display_name
             FROM versions JOIN photos ON photos.id=versions.photo_id
            WHERE photos.project_id=? AND photos.media_type='image'
              AND versions.is_deleted=0 AND versions.is_final=1
            ORDER BY photos.display_name COLLATE NOCASE,versions.version_number""",
        (project["id"],),
    ).fetchall()
    items = []
    for row in rows:
        exists = os.path.isfile(row["file_path"])
        items.append({
            "id": row["id"],
            "photoId": row["photo_id"],
            "displayName": row["photo_display_name"],
            "versionNumber": row["version_number"],
            "versionName": row["version_name"],
            "filePath": row["file_path"],
            "fileName": os.path.basename(row["file_path"]),
            "fileMissing": not exists,
        })
    available_count = sum(1 for item in items if not item["fileMissing"])
    return {
        "success": True,
        "count": len(items),
        "availableCount": available_count,
        "missingCount": len(items) - available_count,
        "versions": items,
    }


def media_set_thumbnail(db, payload: dict):
    version = db.execute(
        "SELECT photo_id FROM versions WHERE id=? AND is_deleted=0", (payload["versionId"],)
    ).fetchone()
    if version is None:
        raise ValueError("版本不存在")
    thumbnail_path = canonical_path(payload["thumbnailPath"])
    db.execute(
        "UPDATE versions SET thumbnail_path=?, updated_at=? WHERE id=?",
        (thumbnail_path, int(time.time() * 1000), payload["versionId"]),
    )
    db.commit()
    return {"success": True, "thumbnailPath": thumbnail_path}


def media_relocate_version(db, payload: dict):
    row = db.execute("SELECT * FROM versions WHERE id=? AND is_deleted=0", (payload["versionId"],)).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    file_path = canonical_path(payload["filePath"])
    if not os.path.isfile(file_path) or not media_type(file_path):
        raise ValueError("所选文件不是可读取的图片或视频")
    stat = os.stat(file_path)
    identity = file_identity(file_path)
    fingerprint = quick_fingerprint(file_path, stat)
    source_full_hash = full_fingerprint(file_path)
    stored_record = db.execute(
        "SELECT full_hash FROM file_records WHERE owner_type='version' AND owner_id=?",
        (row["id"],),
    ).fetchone()
    stored_full_hash = stored_record["full_hash"] if stored_record is not None else None
    fingerprint_matches = bool(
        row["file_fingerprint"] and row["file_fingerprint"] == fingerprint
        and stored_full_hash and stored_full_hash == source_full_hash
    )
    if not fingerprint_matches and not payload.get("force"):
        return {"success": False, "fingerprintMismatch": True, "error": "所选文件与原版本的内容指纹不一致"}
    duplicate = db.execute(
        """SELECT id FROM versions WHERE id<>? AND is_deleted=0
           AND (file_path_key=? OR (? IS NOT NULL AND file_id=?)) LIMIT 1""",
        (row["id"], file_path.casefold(), identity, identity),
    ).fetchone()
    if duplicate:
        raise ValueError("所选文件已经属于另一个版本")
    timestamp = int(time.time() * 1000)
    db.execute(
        """UPDATE versions SET file_path=?, file_path_key=?, file_id=?, file_fingerprint=?, file_size=?,
           file_modified_at=?, thumbnail_path=NULL, file_missing=0,
           content_changed=?, updated_at=? WHERE id=?""",
        (file_path, file_path.casefold(), identity, fingerprint, stat.st_size,
         int(stat.st_mtime_ns / 1_000_000), int(bool(row["content_changed"] or not fingerprint_matches)),
         timestamp, row["id"]),
    )
    if row["version_number"] == 0:
        db.execute(
            """UPDATE photos SET original_file_path=?, original_file_id=?, original_fingerprint=?,
               updated_at=? WHERE id=?""",
            (file_path, identity, fingerprint, timestamp, row["photo_id"]),
        )
    upsert_file_record(db, row["id"], file_path, stat, identity, fingerprint, source_full_hash)
    db.commit()
    return {"success": True, **media_bundle(db, row["photo_id"])}


def team_artifact_paths(rows) -> list[str]:
    values = []
    for row in rows:
        values.extend(value for value in (row["patch_path"], row["mask_path"], row["edited_patch_path"]) if value)
        try:
            members = json.loads(row["members_json"] or "[]")
        except (KeyError, IndexError, TypeError, json.JSONDecodeError):
            members = []
        values.extend(str(member.get("maskPath")) for member in members if member.get("maskPath"))
    return list(dict.fromkeys(values))


def team_assignment_artifact_paths(db, photo_id: str, base_version_id: str, person_indices=None) -> list[str]:
    values = [photo_id, base_version_id]
    member_filter = ""
    if person_indices:
        indexes = sorted({int(value) for value in person_indices})
        member_filter = f" AND person_index IN ({','.join('?' for _ in indexes)})"
        values.extend(indexes)
    rows = db.execute(
        f"""SELECT edited_patch_path FROM team_person_assignments
            WHERE photo_id=? AND base_version_id=? AND edited_patch_path IS NOT NULL{member_filter}""",
        values,
    ).fetchall()
    return list(dict.fromkeys(row["edited_patch_path"] for row in rows if row["edited_patch_path"]))


def unreferenced_team_artifact_paths(db, candidates: list[str]) -> list[str]:
    if not candidates:
        return []
    referenced = set()
    for row in db.execute(
        "SELECT patch_path,mask_path,edited_patch_path,members_json FROM team_patch_tasks WHERE is_deleted=0"
    ).fetchall():
        referenced.update(canonical_path(value) for value in (row["patch_path"], row["mask_path"], row["edited_patch_path"]) if value)
        try:
            members = json.loads(row["members_json"] or "[]")
        except json.JSONDecodeError:
            members = []
        referenced.update(canonical_path(member["maskPath"]) for member in members if member.get("maskPath"))
    for row in db.execute(
        "SELECT edited_patch_path FROM team_person_assignments WHERE edited_patch_path IS NOT NULL"
    ).fetchall():
        referenced.add(canonical_path(row["edited_patch_path"]))
    return [value for value in dict.fromkeys(candidates) if canonical_path(value) not in referenced]


def delete_version_rows(db, rows) -> dict:
    timestamp = int(time.time() * 1000)
    version_ids = [row["id"] for row in rows]
    if not version_ids:
        return {"deletedVersions": [], "teamArtifactPaths": [], "sourcePaths": []}
    placeholders = ",".join("?" for _ in version_ids)
    reparented_count = 0
    for row in rows:
        cursor = db.execute(
            """UPDATE versions SET parent_version_id=?,updated_at=?
               WHERE parent_version_id=? AND is_deleted=0""",
            (row["parent_version_id"], timestamp, row["id"]),
        )
        reparented_count += cursor.rowcount
    task_rows = db.execute(
        f"""SELECT patch_path,mask_path,edited_patch_path FROM team_patch_tasks
            WHERE base_version_id IN ({placeholders})""",
        version_ids,
    ).fetchall()
    team_candidates = team_artifact_paths(task_rows)
    db.execute(f"DELETE FROM team_patch_tasks WHERE base_version_id IN ({placeholders})", version_ids)
    db.execute(
        f"""UPDATE team_patch_tasks SET merged_version_id=NULL,
              status=CASE WHEN edited_patch_path IS NOT NULL THEN 'uploaded' ELSE 'exported' END,
              updated_at=? WHERE merged_version_id IN ({placeholders}) AND is_deleted=0""",
        (timestamp, *version_ids),
    )
    db.execute(
        f"UPDATE versions SET is_deleted=1,is_current=0,is_final=0,updated_at=? WHERE id IN ({placeholders})",
        (timestamp, *version_ids),
    )
    db.execute(
        f"DELETE FROM file_records WHERE owner_type='version' AND owner_id IN ({placeholders})",
        version_ids,
    )
    for photo_id in dict.fromkeys(row["photo_id"] for row in rows if row["is_current"]):
        replacement = db.execute(
            "SELECT id FROM versions WHERE photo_id=? AND is_deleted=0 ORDER BY version_number DESC LIMIT 1",
            (photo_id,),
        ).fetchone()
        replacement_id = replacement["id"] if replacement else None
        if replacement_id:
            db.execute("UPDATE versions SET is_current=1 WHERE id=?", (replacement_id,))
        db.execute(
            "UPDATE photos SET current_version_id=?,updated_at=? WHERE id=?",
            (replacement_id, timestamp, photo_id),
        )
    return {
        "deletedVersions": [{
            "id": row["id"], "photoId": row["photo_id"], "filePath": row["file_path"],
            "thumbnailPath": row["thumbnail_path"], "versionNumber": row["version_number"],
        } for row in rows],
        "teamArtifactPaths": unreferenced_team_artifact_paths(db, team_candidates),
        "sourcePaths": list(dict.fromkeys(row["file_path"] for row in rows if row["file_path"])),
        "reparentedCount": reparented_count,
    }


def media_version_delete_scope(db, payload: dict):
    row = db.execute(
        """SELECT versions.*,photos.project_id FROM versions
           JOIN photos ON photos.id=versions.photo_id
           WHERE versions.id=? AND versions.is_deleted=0""",
        (payload["versionId"],),
    ).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    rows = db.execute(
        """SELECT versions.id,versions.file_missing FROM versions
           JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.version_number=? AND versions.is_deleted=0""",
        (row["project_id"], row["version_number"]),
    ).fetchall()
    version_ids = [item["id"] for item in rows]
    child_count = 0
    if version_ids:
        placeholders = ",".join("?" for _ in version_ids)
        child_count = db.execute(
            f"SELECT COUNT(*) AS count FROM versions WHERE parent_version_id IN ({placeholders}) AND is_deleted=0",
            version_ids,
        ).fetchone()["count"]
    selected_child_count = db.execute(
        "SELECT COUNT(*) AS count FROM versions WHERE parent_version_id=? AND is_deleted=0",
        (row["id"],),
    ).fetchone()["count"]
    missing_count = sum(int(item["file_missing"]) for item in rows)
    return {
        "success": True,
        "versionNumber": row["version_number"],
        "versionCount": len(rows),
        "missingCount": missing_count,
        "allMissing": bool(rows) and missing_count == len(rows),
        "childCount": int(child_count),
        "selectedChildCount": int(selected_child_count),
    }


def media_delete_version(db, payload: dict):
    row = db.execute("SELECT * FROM versions WHERE id=? AND is_deleted=0", (payload["versionId"],)).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    if row["version_number"] == 0:
        raise ValueError("原片版本 V0 受保护，不能删除")
    cleanup = delete_version_rows(db, [row])
    db.commit()
    return {"success": True, **media_bundle(db, row["photo_id"]), **cleanup}


def media_delete_project_missing_version(db, payload: dict):
    selected = db.execute(
        """SELECT versions.*,photos.project_id FROM versions
           JOIN photos ON photos.id=versions.photo_id
           WHERE versions.id=? AND versions.is_deleted=0""",
        (payload["versionId"],),
    ).fetchone()
    if selected is None:
        raise ValueError("版本不存在")
    if selected["version_number"] == 0:
        raise ValueError("原片版本 V0 受保护，不能删除")
    rows = db.execute(
        """SELECT versions.* FROM versions JOIN photos ON photos.id=versions.photo_id
           WHERE photos.project_id=? AND versions.version_number=? AND versions.is_deleted=0""",
        (selected["project_id"], selected["version_number"]),
    ).fetchall()
    if not rows or any(not row["file_missing"] for row in rows):
        raise ValueError("该版本仍有文件存在，不能批量删除")
    cleanup = delete_version_rows(db, rows)
    db.commit()
    return {"success": True, "deletedCount": len(rows), "versionNumber": selected["version_number"], **cleanup}


def media_record_compare(db, payload: dict):
    timestamp = int(time.time() * 1000)
    db.execute(
        "INSERT INTO version_compare_history(id,photo_id,left_version_id,right_version_id,compare_mode,created_at) VALUES(?,?,?,?,?,?)",
        (str(uuid.uuid4()), payload["photoId"], payload["leftVersionId"], payload["rightVersionId"], payload.get("compareMode") or "side-by-side", timestamp),
    )
    db.commit()
    return {"success": True}


def serialize_team_patch(row):
    return {
        "id": row["id"], "photoId": row["photo_id"], "baseVersionId": row["base_version_id"],
        "personIndex": row["person_index"], "personName": row["person_name"], "assignee": row["assignee"],
        "detector": row["detector"], "bbox": json.loads(row["bbox_json"]), "crop": json.loads(row["crop_json"]),
        "patchPath": row["patch_path"], "maskPath": row["mask_path"], "mask": json.loads(row["mask_json"] or "{}"),
        "members": json.loads(row["members_json"] or "[]"),
        "needsReview": bool(row["needs_review"]), "reviewReason": row["review_reason"],
        "editedPatchPath": row["edited_patch_path"], "status": row["status"],
        "mergeMetrics": json.loads(row["merge_metrics_json"] or "{}"), "mergedVersionId": row["merged_version_id"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def is_generated_team_identity_name(name):
    prefix = "\u5f85\u786e\u8ba4\u4eba\u7269 "
    value = str(name or "")
    return value.startswith(prefix) and value[len(prefix):].isdigit()


def cleanup_empty_generated_team_identities(db, project_id):
    rows = db.execute(
        """SELECT identity.id,identity.name
           FROM team_person_identities identity
           LEFT JOIN team_person_assignments assignment ON assignment.identity_id=identity.id
           WHERE identity.project_id=?
           GROUP BY identity.id
           HAVING COUNT(assignment.identity_id)=0""",
        (project_id,),
    ).fetchall()
    stale_ids = [row["id"] for row in rows if is_generated_team_identity_name(row["name"])]
    if stale_ids:
        db.executemany("DELETE FROM team_person_identities WHERE id=?", ((identity_id,) for identity_id in stale_ids))
    return len(stale_ids)


def team_patch_list(db, payload: dict):
    rows = db.execute(
        """SELECT * FROM team_patch_tasks WHERE photo_id=? AND is_deleted=0
           ORDER BY person_index, created_at""", (payload["photoId"],)
    ).fetchall()
    return {"success": True, "tasks": [serialize_team_patch(row) for row in rows]}


def reconcile_team_return_artifacts(db, project_id: str) -> dict:
    """Reconcile returned-image history with disk while keeping paths recoverable."""
    timestamp = int(time.time() * 1000)
    assignments = db.execute(
        """SELECT photo_id,base_version_id,person_index,edited_patch_path,
                  return_missing,return_missing_since,completed_at,updated_at
           FROM team_person_assignments
           WHERE project_id=? AND completed=1 AND completion_kind='returned'""",
        (project_id,),
    ).fetchall()
    assignment_states = {}
    missing_count = 0
    changed_count = 0
    for row in assignments:
        artifact_exists = bool(row["edited_patch_path"] and os.path.isfile(row["edited_patch_path"]))
        missing = not artifact_exists
        missing_count += int(missing)
        missing_since = (row["return_missing_since"] or timestamp) if missing else None
        if bool(row["return_missing"]) != missing or row["return_missing_since"] != missing_since:
            db.execute(
                """UPDATE team_person_assignments
                   SET return_missing=?,return_missing_since=?
                   WHERE photo_id=? AND base_version_id=? AND person_index=?""",
                (int(missing), missing_since, row["photo_id"], row["base_version_id"], row["person_index"]),
            )
            changed_count += 1
        assignment_states[(row["photo_id"], row["base_version_id"], int(row["person_index"]))] = {
            "path": row["edited_patch_path"],
            "missing": missing,
            "completed_at": int(row["completed_at"] or row["updated_at"] or 0),
        }

    tasks = db.execute(
        """SELECT task.id,task.photo_id,task.base_version_id,task.person_index,task.members_json,
                  task.edited_patch_path,task.status
           FROM team_patch_tasks task
           JOIN photos ON photos.id=task.photo_id
           WHERE photos.project_id=? AND task.is_deleted=0""",
        (project_id,),
    ).fetchall()
    for task in tasks:
        try:
            members = json.loads(task["members_json"] or "[]")
        except json.JSONDecodeError:
            members = []
        person_indices = {int(member.get("personIndex") or 0) for member in members}
        if not person_indices:
            person_indices = {int(task["person_index"])}
        task_assignments = [
            assignment_states[(task["photo_id"], task["base_version_id"], person_index)]
            for person_index in person_indices
            if (task["photo_id"], task["base_version_id"], person_index) in assignment_states
        ]
        # Legacy task-only returns have no person assignment to reconcile.
        if not task_assignments:
            continue
        available = [item for item in task_assignments if not item["missing"] and item["path"]]
        latest = max(available, key=lambda item: item["completed_at"], default=None)
        desired_path = latest["path"] if latest else None
        desired_status = task["status"] if task["status"] == "merged" else "uploaded" if desired_path else "exported"
        current_path = canonical_path(task["edited_patch_path"]) if task["edited_patch_path"] else None
        if current_path != desired_path or task["status"] != desired_status:
            db.execute(
                "UPDATE team_patch_tasks SET edited_patch_path=?,status=?,updated_at=? WHERE id=?",
                (desired_path, desired_status, timestamp, task["id"]),
            )
            changed_count += 1
    if changed_count:
        db.commit()
    return {"missingCount": missing_count, "changedCount": changed_count}


def ensure_team_workflow_node(root: str, db, project):
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    folder_path = canonical_path(os.path.join(project_path, "团片协作"))
    if not os.path.isdir(folder_path):
        return None, False
    existing = db.execute(
        "SELECT id FROM progress_folders WHERE project_id=? AND folder_path_key=?",
        (project["id"], folder_path.casefold()),
    ).fetchone()
    request = {
        "projectName": project["name"],
        "mediaKind": "image",
        "versionKey": "team-workspace",
        "displayName": "团片协作",
        "folderPath": folder_path,
        "nodeRole": "workflow",
        "artifactKind": "team_workspace",
        "trackingEnabled": False,
        "trackingState": "disabled",
        "renameFromParent": False,
        "copyMissingFromParent": False,
    }
    if existing is not None:
        request["progressId"] = existing["id"]
    return progress_register(root, db, request)["progressFolder"], existing is None


def team_project_workspace(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    return_artifacts = reconcile_team_return_artifacts(db, project["id"])
    if cleanup_empty_generated_team_identities(db, project["id"]):
        db.commit()
    project_path = os.path.join(os.path.abspath(root), project["relative_path"])
    workflow_node, workflow_node_created = ensure_team_workflow_node(root, db, project)
    rows = db.execute(
        """SELECT task.*, photos.display_name AS photo_name, photos.original_name, photos.current_version_id,
                  versions.file_path AS source_path
           FROM team_patch_tasks task
           JOIN photos ON photos.id=task.photo_id AND photos.is_deleted=0
           JOIN versions ON versions.id=task.base_version_id AND versions.is_deleted=0
           WHERE photos.project_id=? AND task.is_deleted=0
           ORDER BY photos.created_at, task.photo_id, task.person_index""",
        (project["id"],),
    ).fetchall()
    groups = {}
    for row in rows:
        key = f'{row["photo_id"]}:{row["base_version_id"]}'
        if key not in groups:
            relative_path = os.path.relpath(row["source_path"], project_path)
            groups[key] = {
                "photoId": row["photo_id"], "baseVersionId": row["base_version_id"],
                "name": row["photo_name"] or os.path.splitext(row["original_name"])[0],
                "relativePath": relative_path, "sourcePath": row["source_path"], "tasks": [],
                "currentVersionId": row["current_version_id"], "latestTaskAt": 0,
            }
        groups[key]["tasks"].append(serialize_team_patch(row))
        groups[key]["latestTaskAt"] = max(groups[key]["latestTaskAt"], int(row["updated_at"] or 0))
    selected_groups = {}
    for group in groups.values():
        current = selected_groups.get(group["photoId"])
        group_is_current = group["baseVersionId"] == group["currentVersionId"]
        current_is_current = current and current["baseVersionId"] == current["currentVersionId"]
        if current is None or group_is_current and not current_is_current or group_is_current == current_is_current and group["latestTaskAt"] > current["latestTaskAt"]:
            selected_groups[group["photoId"]] = group
    registered = db.execute(
        """SELECT registered.photo_id,registered.base_version_id,registered.created_at,registered.updated_at,
                  photos.display_name,photos.original_name,versions.file_path AS source_path
           FROM team_retouch_photos registered
           JOIN photos ON photos.id=registered.photo_id AND photos.is_deleted=0
           JOIN versions ON versions.id=registered.base_version_id AND versions.is_deleted=0
           WHERE registered.project_id=? ORDER BY registered.created_at""",
        (project["id"],),
    ).fetchall()
    for row in registered:
        key = f'{row["photo_id"]}:{row["base_version_id"]}'
        group = groups.get(key) or {
            "photoId": row["photo_id"], "baseVersionId": row["base_version_id"],
            "name": row["display_name"] or os.path.splitext(row["original_name"])[0],
            "relativePath": os.path.relpath(row["source_path"], project_path),
            "sourcePath": row["source_path"], "tasks": [], "currentVersionId": row["base_version_id"],
            "latestTaskAt": int(row["updated_at"] or 0),
        }
        selected_groups[row["photo_id"]] = group
    photos = []
    exclusion_counts = {
        f'{row["photo_id"]}:{row["base_version_id"]}': int(row["count"])
        for row in db.execute(
            """SELECT photo_id,base_version_id,COUNT(*) AS count
               FROM team_person_exclusions WHERE project_id=?
               GROUP BY photo_id,base_version_id""",
            (project["id"],),
        ).fetchall()
    }
    for group in selected_groups.values():
        group.pop("currentVersionId", None)
        group.pop("latestTaskAt", None)
        group["excludedPersonCount"] = exclusion_counts.get(f'{group["photoId"]}:{group["baseVersionId"]}', 0)
        photos.append(group)
    identities = [dict(row) for row in db.execute(
        "SELECT id,name,color,created_at AS createdAt,updated_at AS updatedAt FROM team_person_identities WHERE project_id=? ORDER BY created_at",
        (project["id"],),
    ).fetchall()]
    assignments = [dict(row) for row in db.execute(
        """SELECT photo_id AS photoId,base_version_id AS baseVersionId,person_index AS personIndex,
                  identity_id AS identityId,confidence,source,completed,
                  completion_kind AS completionKind,edited_patch_path AS editedPatchPath,
                  return_missing AS returnMissing,return_missing_since AS returnMissingSince,
                  completed_at AS completedAt,updated_at AS updatedAt
           FROM team_person_assignments WHERE project_id=?""",
        (project["id"],),
    ).fetchall()]
    for item in assignments:
        item["returnMissing"] = bool(item["returnMissing"])
        item["completed"] = bool(item["completed"]) and not item["returnMissing"]
    return {"success": True, "photos": photos, "identities": identities, "assignments": assignments,
            "workflowNode": workflow_node, "workflowNodeCreated": workflow_node_created,
            "missingReturnCount": return_artifacts["missingCount"]}


def team_project_register_photo(db, payload: dict):
    project = project_row(db, payload["projectName"])
    photo = db.execute("SELECT id,project_id FROM photos WHERE id=? AND is_deleted=0", (payload["photoId"],)).fetchone()
    version = db.execute("SELECT id,photo_id FROM versions WHERE id=? AND is_deleted=0", (payload["baseVersionId"],)).fetchone()
    if photo is None or photo["project_id"] != project["id"] or version is None or version["photo_id"] != photo["id"]:
        raise ValueError("团片协作图片或基础版本不属于当前项目")
    timestamp = int(time.time() * 1000)
    db.execute(
        """INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)
           ON CONFLICT(photo_id) DO UPDATE SET base_version_id=excluded.base_version_id,updated_at=excluded.updated_at""",
        (photo["id"], project["id"], version["id"], timestamp, timestamp),
    )
    db.commit()
    return {"success": True}


def team_project_unregister_photo(db, payload: dict):
    db.execute("DELETE FROM team_retouch_photos WHERE photo_id=?", (payload["photoId"],))
    db.commit()
    return {"success": True}


def team_identity_save(db, payload: dict):
    project = project_row(db, payload["projectName"])
    timestamp = int(time.time() * 1000)
    identity_id = str(payload.get("identityId") or uuid.uuid4())
    name = str(payload.get("name") or "未命名人物").strip()[:80] or "未命名人物"
    existing = db.execute("SELECT id FROM team_person_identities WHERE id=? AND project_id=?", (identity_id, project["id"])).fetchone()
    if existing:
        db.execute("UPDATE team_person_identities SET name=?,updated_at=? WHERE id=?", (name, timestamp, identity_id))
    else:
        colors = ("#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#059669", "#0891b2", "#4f46e5")
        count = db.execute("SELECT COUNT(*) FROM team_person_identities WHERE project_id=?", (project["id"],)).fetchone()[0]
        db.execute(
            "INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (identity_id, project["id"], name, colors[count % len(colors)], timestamp, timestamp),
        )
    for assignment in payload.get("assignments") or []:
        db.execute(
            """INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(photo_id,base_version_id,person_index) DO UPDATE SET
                 identity_id=excluded.identity_id,confidence=excluded.confidence,source=excluded.source,
                 completed=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.completed ELSE 0 END,
                 completion_kind=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.completion_kind ELSE '' END,
                 edited_patch_path=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.edited_patch_path ELSE NULL END,
                 return_missing=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.return_missing ELSE 0 END,
                 return_missing_since=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.return_missing_since ELSE NULL END,
                 completed_at=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.completed_at ELSE NULL END,
                 updated_at=excluded.updated_at""",
            (project["id"], assignment["photoId"], assignment["baseVersionId"], int(assignment["personIndex"]),
             identity_id, float(assignment.get("confidence", 1)), str(assignment.get("source") or "manual"),
             int(bool(assignment.get("completed", False))), timestamp),
        )
    db.commit()
    return {"success": True, "identityId": identity_id}


def team_identity_assign(db, payload: dict):
    project = project_row(db, payload["projectName"])
    identity_id = payload.get("identityId") or None
    if identity_id and db.execute("SELECT id FROM team_person_identities WHERE id=? AND project_id=?", (identity_id, project["id"])).fetchone() is None:
        raise ValueError("人物身份不存在")
    timestamp = int(time.time() * 1000)
    existing = db.execute(
        "SELECT identity_id,completed FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?",
        (payload["photoId"], payload["baseVersionId"], int(payload["personIndex"])),
    ).fetchone()
    completed = bool(payload.get("completed", False))
    if not identity_id or existing and existing["identity_id"] != identity_id:
        completed = False
    db.execute(
        """INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(photo_id,base_version_id,person_index) DO UPDATE SET
             identity_id=excluded.identity_id,confidence=excluded.confidence,source=excluded.source,
             completed=excluded.completed,
             completion_kind=CASE WHEN excluded.completed=1 THEN team_person_assignments.completion_kind ELSE '' END,
             edited_patch_path=CASE WHEN excluded.completed=1 THEN team_person_assignments.edited_patch_path ELSE NULL END,
             return_missing=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing ELSE 0 END,
             return_missing_since=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing_since ELSE NULL END,
             completed_at=CASE WHEN excluded.completed=1 THEN team_person_assignments.completed_at ELSE NULL END,
             updated_at=excluded.updated_at""",
        (project["id"], payload["photoId"], payload["baseVersionId"], int(payload["personIndex"]), identity_id,
         float(payload.get("confidence", 1)), str(payload.get("source") or "manual"), int(completed), timestamp),
    )
    previous_identity_id = existing["identity_id"] if existing else None
    if previous_identity_id and previous_identity_id != identity_id:
        cleanup_empty_generated_team_identities(db, project["id"])
    db.commit()
    return {"success": True}


def team_identity_confirm_group(db, payload: dict):
    project = project_row(db, payload["projectName"])
    timestamp = int(time.time() * 1000)
    requested_identity_id = str(payload.get("identityId") or "").strip() or None
    requested_name = str(payload.get("name") or "").strip()[:80]
    assignments = payload.get("assignments") or []
    if not assignments:
        raise ValueError("没有需要标记的人物")

    identity_id = requested_identity_id
    if requested_name:
        same_name = db.execute(
            "SELECT id FROM team_person_identities WHERE project_id=? AND lower(trim(name))=lower(trim(?)) LIMIT 1",
            (project["id"], requested_name),
        ).fetchone()
        if same_name and same_name["id"] != requested_identity_id:
            identity_id = same_name["id"]
        elif requested_identity_id:
            existing = db.execute(
                "SELECT id FROM team_person_identities WHERE id=? AND project_id=?",
                (requested_identity_id, project["id"]),
            ).fetchone()
            if existing is None:
                raise ValueError("人物身份不存在")
            db.execute(
                "UPDATE team_person_identities SET name=?,updated_at=? WHERE id=?",
                (requested_name, timestamp, requested_identity_id),
            )
        else:
            identity_id = str(uuid.uuid4())
            colors = ("#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#059669", "#0891b2", "#4f46e5")
            count = db.execute("SELECT COUNT(*) FROM team_person_identities WHERE project_id=?", (project["id"],)).fetchone()[0]
            db.execute(
                "INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (identity_id, project["id"], requested_name, colors[count % len(colors)], timestamp, timestamp),
            )
    elif identity_id:
        existing = db.execute(
            "SELECT id FROM team_person_identities WHERE id=? AND project_id=?",
            (identity_id, project["id"]),
        ).fetchone()
        if existing is None:
            raise ValueError("人物身份不存在")

    anchor_key = str(payload.get("anchorSubjectKey") or "")
    seen = set()
    updated = 0
    previous_identity_ids = set()
    for assignment in payload.get("clearAssignments") or []:
        photo_id = str(assignment.get("photoId") or "")
        base_version_id = str(assignment.get("baseVersionId") or "")
        person_index = int(assignment.get("personIndex"))
        existing_assignment = db.execute(
            """SELECT identity_id FROM team_person_assignments
               WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?""",
            (project["id"], photo_id, base_version_id, person_index),
        ).fetchone()
        if existing_assignment is None:
            continue
        if existing_assignment["identity_id"]:
            previous_identity_ids.add(existing_assignment["identity_id"])
        db.execute(
            """DELETE FROM team_person_assignments
               WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?""",
            (project["id"], photo_id, base_version_id, person_index),
        )
    for assignment in assignments:
        photo_id = str(assignment.get("photoId") or "")
        base_version_id = str(assignment.get("baseVersionId") or "")
        person_index = int(assignment.get("personIndex"))
        key = f"{photo_id}:{base_version_id}:{person_index}"
        if key in seen:
            continue
        seen.add(key)
        owned = db.execute(
            """SELECT 1 FROM photos photo
               JOIN versions version ON version.id=? AND version.photo_id=photo.id AND version.is_deleted=0
               WHERE photo.id=? AND photo.project_id=? AND photo.is_deleted=0""",
            (base_version_id, photo_id, project["id"]),
        ).fetchone()
        if owned is None:
            raise ValueError("人物实例不属于当前团片协作项目")
        existing_assignment = db.execute(
            "SELECT identity_id,completed FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?",
            (photo_id, base_version_id, person_index),
        ).fetchone()
        previous_identity_id = existing_assignment["identity_id"] if existing_assignment else None
        if previous_identity_id:
            previous_identity_ids.add(previous_identity_id)
        completed = bool(existing_assignment["completed"]) if existing_assignment and previous_identity_id == identity_id else False
        source = "manual" if key == anchor_key else "manual-group"
        db.execute(
            """INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(photo_id,base_version_id,person_index) DO UPDATE SET
                 identity_id=excluded.identity_id,confidence=excluded.confidence,source=excluded.source,
                 completed=excluded.completed,
                 completion_kind=CASE WHEN excluded.completed=1 THEN team_person_assignments.completion_kind ELSE '' END,
                 edited_patch_path=CASE WHEN excluded.completed=1 THEN team_person_assignments.edited_patch_path ELSE NULL END,
                 return_missing=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing ELSE 0 END,
                 return_missing_since=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing_since ELSE NULL END,
                 completed_at=CASE WHEN excluded.completed=1 THEN team_person_assignments.completed_at ELSE NULL END,
                 updated_at=excluded.updated_at""",
            (project["id"], photo_id, base_version_id, person_index, identity_id,
             float(assignment.get("confidence", 1)), source, int(completed), timestamp),
        )
        updated += 1

    if any(previous_identity_id != identity_id for previous_identity_id in previous_identity_ids):
        cleanup_empty_generated_team_identities(db, project["id"])
    db.commit()
    return {"success": True, "identityId": identity_id, "updatedCount": updated}


def team_identity_complete(db, payload: dict):
    timestamp = int(time.time() * 1000)
    completed = bool(payload.get("completed"))
    completion_kind = str(payload.get("completionKind") or ("no-retouch" if completed else ""))
    if completion_kind not in ("", "returned", "no-retouch", "skip-requested"):
        raise ValueError("人物完成方式无效")
    edited_patch_path = canonical_path(payload["editedPatchPath"]) if payload.get("editedPatchPath") else None
    result = db.execute(
        """UPDATE team_person_assignments
           SET completed=?,completion_kind=?,edited_patch_path=?,return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=?
           WHERE photo_id=? AND base_version_id=? AND person_index=?""",
        (int(completed), completion_kind, edited_patch_path, timestamp if completed else None, timestamp,
         payload["photoId"], payload["baseVersionId"], int(payload["personIndex"])),
    )
    if result.rowcount != 1:
        raise ValueError("请先给这个人物标记身份")
    db.commit()
    return {"success": True}


def team_identity_delete(db, payload: dict):
    project = project_row(db, payload["projectName"])
    db.execute(
        """UPDATE team_person_assignments
           SET completed=0,completion_kind='',edited_patch_path=NULL,return_missing=0,return_missing_since=NULL,completed_at=NULL
           WHERE identity_id=? AND project_id=?""",
        (payload["identityId"], project["id"]),
    )
    db.execute("DELETE FROM team_person_identities WHERE id=? AND project_id=?", (payload["identityId"], project["id"]))
    db.commit()
    return {"success": True}


def team_person_exclusion_list(db, payload: dict):
    values = [payload["photoId"], payload["baseVersionId"]]
    project_filter = ""
    if payload.get("projectName"):
        project = project_row(db, payload["projectName"])
        project_filter = " AND project_id=?"
        values.append(project["id"])
    rows = db.execute(
        f"""SELECT id,photo_id AS photoId,base_version_id AS baseVersionId,
                   bbox_json,reason,created_at AS createdAt
            FROM team_person_exclusions
            WHERE photo_id=? AND base_version_id=?{project_filter}
            ORDER BY created_at""",
        values,
    ).fetchall()
    return {
        "success": True,
        "exclusions": [{
            "id": row["id"],
            "photoId": row["photoId"],
            "baseVersionId": row["baseVersionId"],
            "bbox": json.loads(row["bbox_json"]),
            "reason": row["reason"],
            "createdAt": row["createdAt"],
        } for row in rows],
    }


def team_person_exclusion_add(db, payload: dict):
    project = project_row(db, payload["projectName"])
    photo = db.execute(
        "SELECT id,project_id FROM photos WHERE id=? AND is_deleted=0",
        (payload["photoId"],),
    ).fetchone()
    version = db.execute(
        "SELECT id,photo_id FROM versions WHERE id=? AND is_deleted=0",
        (payload["baseVersionId"],),
    ).fetchone()
    if photo is None or photo["project_id"] != project["id"] or version is None or version["photo_id"] != photo["id"]:
        raise ValueError("人物实例不属于当前团片协作项目")
    bbox = payload.get("bbox") or {}
    normalized_bbox = {key: int(round(float(bbox.get(key, 0)))) for key in ("x", "y", "width", "height")}
    if normalized_bbox["x"] < 0 or normalized_bbox["y"] < 0 or normalized_bbox["width"] < 1 or normalized_bbox["height"] < 1:
        raise ValueError("人物识别框无效")
    exclusion_id = str(payload.get("id") or uuid.uuid4())
    timestamp = int(time.time() * 1000)
    db.execute(
        """INSERT INTO team_person_exclusions(
             id,project_id,photo_id,base_version_id,bbox_json,reason,created_at
           ) VALUES(?,?,?,?,?,?,?)""",
        (
            exclusion_id, project["id"], photo["id"], version["id"],
            json.dumps(normalized_bbox, ensure_ascii=False),
            str(payload.get("reason") or "false-positive")[:80],
            timestamp,
        ),
    )
    db.commit()
    return {"success": True, "id": exclusion_id, "bbox": normalized_bbox}


def team_person_exclusion_clear(db, payload: dict):
    project = project_row(db, payload["projectName"])
    result = db.execute(
        """DELETE FROM team_person_exclusions
           WHERE project_id=? AND photo_id=? AND base_version_id=?""",
        (project["id"], payload["photoId"], payload["baseVersionId"]),
    )
    db.commit()
    return {"success": True, "clearedCount": result.rowcount}


def team_patch_replace(db, payload: dict):
    timestamp = int(time.time() * 1000)
    previous_rows = db.execute(
        "SELECT patch_path,mask_path,edited_patch_path,members_json FROM team_patch_tasks WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    ).fetchall()
    assignment_artifacts = team_assignment_artifact_paths(db, payload["photoId"], payload["baseVersionId"])
    db.execute(
        "DELETE FROM team_patch_tasks WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    )
    # Person indices are produced by the detector and can change after a new
    # recognition pass. Keeping old identity links would silently attach names
    # to the wrong body, so the user must confirm them again.
    db.execute(
        "DELETE FROM team_person_assignments WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    )
    for task in payload.get("tasks", []):
        db.execute(
            """INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,assignee,
               detector,bbox_json,crop_json,patch_path,mask_path,mask_json,members_json,needs_review,review_reason,status,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (task["id"], payload["photoId"], payload["baseVersionId"], int(task["personIndex"]),
             task.get("personName") or f"人物 {task['personIndex']}", task.get("assignee") or "",
             task.get("detector") or "", json.dumps(task["bbox"], ensure_ascii=False),
             json.dumps(task["crop"], ensure_ascii=False), canonical_path(task["patchPath"]),
             canonical_path(task["maskPath"]) if task.get("maskPath") else None,
             json.dumps(task.get("mask") or {}, ensure_ascii=False),
             json.dumps(task.get("members") or [], ensure_ascii=False),
             int(bool(task.get("needsReview"))),
             str(task.get("reviewReason") or ""),
             task.get("status") or "exported", timestamp, timestamp),
        )
    db.commit()
    result = team_patch_list(db, {"photoId": payload["photoId"]})
    result["artifactPaths"] = unreferenced_team_artifact_paths(db, team_artifact_paths(previous_rows) + assignment_artifacts)
    return result


def team_patch_cleanup(db, payload: dict):
    rows = db.execute(
        """SELECT * FROM team_patch_tasks
           WHERE photo_id=? AND base_version_id=? AND is_deleted=0""",
        (payload["photoId"], payload["baseVersionId"]),
    ).fetchall()
    if not rows:
        return {**team_patch_list(db, {"photoId": payload["photoId"]}), "artifactPaths": [], "cleanedCount": 0}
    if not payload.get("force") and any(row["status"] != "merged" for row in rows):
        raise ValueError("仍有未完成的团片协作任务，不能清理工作数据")
    candidates = team_artifact_paths(rows) + team_assignment_artifact_paths(db, payload["photoId"], payload["baseVersionId"])
    db.execute(
        "DELETE FROM team_patch_tasks WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    )
    db.execute(
        "DELETE FROM team_person_assignments WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    )
    db.commit()
    result = team_patch_list(db, {"photoId": payload["photoId"]})
    result.update({"artifactPaths": unreferenced_team_artifact_paths(db, candidates), "cleanedCount": len(rows)})
    return result


def team_patch_update(db, payload: dict):
    row = db.execute("SELECT * FROM team_patch_tasks WHERE id=? AND is_deleted=0", (payload["taskId"],)).fetchone()
    if row is None:
        raise ValueError("人物修图任务不存在")
    assignment_completion = payload.get("assignmentCompletion")
    assignment_person_index = None
    if assignment_completion is not None:
        if not isinstance(assignment_completion, dict):
            raise ValueError("人物完成状态无效")
        assignment_person_index = int(assignment_completion.get("personIndex") or 0)
        members = json.loads(row["members_json"] or "[]") or [{"personIndex": row["person_index"]}]
        member_indices = {int(member.get("personIndex") or 0) for member in members}
        if assignment_person_index < 1 or assignment_person_index not in member_indices:
            raise ValueError("人物不属于这个修图任务")
        assignment = db.execute(
            """SELECT 1 FROM team_person_assignments
               WHERE photo_id=? AND base_version_id=? AND person_index=?""",
            (row["photo_id"], row["base_version_id"], assignment_person_index),
        ).fetchone()
        if assignment is None:
            raise ValueError("请先给这个人物标记身份")
    fields, values = [], []
    mapping = {"personName": "person_name", "assignee": "assignee", "status": "status", "mergedVersionId": "merged_version_id"}
    for source, target in mapping.items():
        if source in payload:
            fields.append(f"{target}=?")
            values.append(None if source == "mergedVersionId" and not payload[source] else str(payload[source] or ""))
    if "editedPatchPath" in payload:
        fields.append("edited_patch_path=?")
        values.append(canonical_path(payload["editedPatchPath"]) if payload["editedPatchPath"] else None)
    if "patchPath" in payload:
        fields.append("patch_path=?")
        values.append(canonical_path(payload["patchPath"]) if payload["patchPath"] else None)
    if "mergeMetrics" in payload:
        fields.append("merge_metrics_json=?")
        values.append(json.dumps(payload["mergeMetrics"] or {}, ensure_ascii=False))
    if "needsReview" in payload:
        fields.append("needs_review=?")
        values.append(int(bool(payload["needsReview"])))
    if "reviewReason" in payload:
        fields.append("review_reason=?")
        values.append(str(payload["reviewReason"] or ""))
    if "crop" in payload:
        crop = payload.get("crop") or {}
        normalized_crop = {key: int(crop.get(key, 0)) for key in ("x", "y", "width", "height")}
        if normalized_crop["x"] < 0 or normalized_crop["y"] < 0 or normalized_crop["width"] < 1 or normalized_crop["height"] < 1:
            raise ValueError("工作图范围无效")
        fields.append("crop_json=?")
        values.append(json.dumps(normalized_crop, ensure_ascii=False))
    timestamp = int(time.time() * 1000)
    fields.append("updated_at=?")
    values.append(timestamp)
    values.append(row["id"])
    try:
        db.execute(f"UPDATE team_patch_tasks SET {', '.join(fields)} WHERE id=?", values)
        if assignment_person_index is not None:
            assignment_completed = bool(assignment_completion.get("completed"))
            assignment_completion_kind = str(assignment_completion.get("completionKind") or ("returned" if assignment_completed and payload.get("editedPatchPath") else "no-retouch" if assignment_completed else ""))
            if assignment_completion_kind not in ("", "returned", "no-retouch", "skip-requested"):
                raise ValueError("人物完成方式无效")
            assignment_edited_path = assignment_completion.get("editedPatchPath")
            if assignment_edited_path is None and assignment_completion_kind == "returned":
                assignment_edited_path = payload.get("editedPatchPath")
            db.execute(
                """UPDATE team_person_assignments
                   SET completed=?,completion_kind=?,edited_patch_path=?,return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=?
                   WHERE photo_id=? AND base_version_id=? AND person_index=?""",
                (int(assignment_completed), assignment_completion_kind,
                 canonical_path(assignment_edited_path) if assignment_edited_path else None,
                 timestamp if assignment_completed else None, timestamp,
                 row["photo_id"], row["base_version_id"], assignment_person_index),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return team_patch_list(db, {"photoId": row["photo_id"]})


def team_patch_delete(db, payload: dict):
    row = db.execute(
        """SELECT task.*,photos.project_id FROM team_patch_tasks task
           JOIN photos ON photos.id=task.photo_id WHERE task.id=? AND task.is_deleted=0""",
        (payload["taskId"],),
    ).fetchone()
    if row is None:
        raise ValueError("人物工作图不存在")
    members = json.loads(row["members_json"] or "[]") or [{"personIndex": row["person_index"]}]
    person_indices = sorted({int(member.get("personIndex") or 0) for member in members if int(member.get("personIndex") or 0) > 0})
    candidates = team_artifact_paths([row]) + team_assignment_artifact_paths(db, row["photo_id"], row["base_version_id"], person_indices)
    db.execute("DELETE FROM team_patch_tasks WHERE id=?", (row["id"],))
    if person_indices:
        placeholders = ",".join("?" for _ in person_indices)
        db.execute(
            f"""DELETE FROM team_person_assignments
                WHERE photo_id=? AND base_version_id=? AND person_index IN ({placeholders})""",
            (row["photo_id"], row["base_version_id"], *person_indices),
        )
    cleanup_empty_generated_team_identities(db, row["project_id"])
    db.commit()
    result = team_patch_list(db, {"photoId": row["photo_id"]})
    result["artifactPaths"] = unreferenced_team_artifact_paths(db, candidates)
    return result


def sync_directories(root: str, db):
    """Reconcile direct child folders with the catalog without moving files."""
    now = int(time.time() * 1000)
    rows = db.execute("SELECT * FROM projects").fetchall()
    internal_rows = [row for row in rows if is_internal_workspace_directory(row["relative_path"])]
    for row in internal_rows:
        db.execute("DELETE FROM projects WHERE id=?", (row["id"],))
    internal_ids = {row["id"] for row in internal_rows}
    rows = [row for row in rows if row["id"] not in internal_ids]
    by_path = {row["relative_path"].casefold(): row for row in rows}
    by_identity = {row["filesystem_id"]: row for row in rows if row["filesystem_id"]}
    seen_ids = set()

    for entry in os.scandir(root):
        if not entry.is_dir() or is_internal_workspace_directory(entry.name):
            continue
        relative_path = entry.name
        identity = directory_identity(entry.path)
        row = by_path.get(relative_path.casefold())
        if row is not None:
            if row["is_deleted"]:
                db.execute(
                    """UPDATE projects SET is_deleted=0,filesystem_id=?,availability='available',
                       missing_since=NULL,missing_checks=0,updated_at=? WHERE id=?""",
                    (identity, now, row["id"]),
                )
            seen_ids.add(row["id"])
            if identity != row["filesystem_id"] or row["availability"] != "available" or row["missing_checks"]:
                db.execute(
                    """UPDATE projects SET filesystem_id=?,availability='available',missing_since=NULL,
                       missing_checks=0,updated_at=? WHERE id=?""",
                    (identity, now, row["id"]),
                )
            continue
        renamed_row = by_identity.get(identity) if identity else None
        if renamed_row is not None and renamed_row["id"] not in seen_ids:
            db.execute(
                """UPDATE projects SET name=?,relative_path=?,is_deleted=0,availability='available',
                   missing_since=NULL,missing_checks=0,updated_at=? WHERE id=?""",
                (entry.name, relative_path, now, renamed_row["id"]),
            )
            seen_ids.add(renamed_row["id"])
            continue
        project_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,filesystem_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (project_id, entry.name, "未分类", relative_path, identity, now, now),
        )
        seen_ids.add(project_id)

    for row in rows:
        if (not row["is_deleted"] and row["id"] not in seen_ids
                and row["availability"] != "missing"
                and not os.path.isdir(os.path.join(root, row["relative_path"]))):
            db.execute(
                """UPDATE projects SET availability='missing',missing_since=?,
                   missing_checks=1,updated_at=? WHERE id=?""",
                (now, now, row["id"]),
            )
    db.commit()


def catalog_snapshot(db, database: str):
    rows = [dict(row) for row in db.execute("SELECT * FROM projects WHERE is_deleted=0 ORDER BY name COLLATE NOCASE").fetchall() if not is_internal_workspace_directory(row["relative_path"])]
    return {"success": True, "projects": rows, "database": os.path.abspath(database)}


def load(root: str, database: str):
    # Schema creation/migration happens only when required. Normal project-list
    # refreshes use a query-only connection and never compete for SQLite's
    # single WAL writer slot.
    if database_needs_initialization(database):
        initialized = connect(root, database)
        initialized.close()
    db = connect_read_only(database)
    try:
        return catalog_snapshot(db, database)
    finally:
        db.close()


def deleted_projects_list(db):
    records_by_name = {}
    for record in db.execute(
        "SELECT * FROM undo_records WHERE kind IN ('trash','project-cleanup') ORDER BY created_at DESC"
    ).fetchall():
        try:
            payload = json.loads(record["payload_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        catalog = payload.get("projectCatalog") or {}
        name = str(catalog.get("name") or "").casefold()
        if not name or name in records_by_name:
            continue
        item = (payload.get("items") or [{}])[0] or {}
        records_by_name[name] = {
            "undoRecordId": record["id"],
            "undoRecordState": record["state"],
            "originalPath": str(item.get("original") or ""),
            "recyclePidl": str(item.get("recyclePidl") or ""),
            "preciseRestore": bool(item.get("preciseRestore", True)),
            "permanent": bool(item.get("permanent", False)),
        }

    rows = db.execute(
        """SELECT projects.*,
                  (SELECT COUNT(*) FROM photos WHERE photos.project_id=projects.id) AS photo_count,
                  (SELECT COUNT(*) FROM versions JOIN photos ON photos.id=versions.photo_id
                    WHERE photos.project_id=projects.id) AS version_count
           FROM projects WHERE projects.is_deleted=1 ORDER BY projects.updated_at DESC"""
    ).fetchall()
    projects = []
    for row in rows:
        record = records_by_name.get(str(row["name"]).casefold(), {})
        projects.append({
            "id": row["id"],
            "name": row["name"],
            "status": row["status"],
            "relativePath": row["relative_path"],
            "deletedAt": row["updated_at"],
            "photoCount": row["photo_count"],
            "versionCount": row["version_count"],
            **record,
        })
    return {"success": True, "projects": projects}


def project_cleanup_plan(db, project):
    project_id = project["id"]
    photo_rows = db.execute("SELECT id,original_file_path FROM photos WHERE project_id=?", (project_id,)).fetchall()
    photo_ids = [row["id"] for row in photo_rows]
    version_rows = db.execute(
        """SELECT versions.id,versions.file_path,versions.thumbnail_path FROM versions
           JOIN photos ON photos.id=versions.photo_id WHERE photos.project_id=?""",
        (project_id,),
    ).fetchall()
    version_ids = [row["id"] for row in version_rows]
    source_paths = [row["original_file_path"] for row in photo_rows if row["original_file_path"]]
    source_paths.extend(row["file_path"] for row in version_rows if row["file_path"])
    artifact_paths = [row["thumbnail_path"] for row in version_rows if row["thumbnail_path"]]
    if photo_ids:
        placeholders = ",".join("?" for _ in photo_ids)
        patch_rows = db.execute(
            f"""SELECT patch_path,mask_path,edited_patch_path FROM team_patch_tasks
                WHERE photo_id IN ({placeholders})""",
            photo_ids,
        ).fetchall()
        for row in patch_rows:
            artifact_paths.extend(value for value in (row["patch_path"], row["mask_path"], row["edited_patch_path"]) if value)
    if version_ids:
        placeholders = ",".join("?" for _ in version_ids)
        db.execute(f"DELETE FROM file_records WHERE owner_type='version' AND owner_id IN ({placeholders})", version_ids)

    removed_undo_ids = []
    for record in db.execute(
        "SELECT id,payload_json FROM undo_records WHERE kind IN ('trash','project-cleanup')"
    ).fetchall():
        try:
            record_payload = json.loads(record["payload_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        catalog = record_payload.get("projectCatalog") or {}
        if str(catalog.get("name") or "").casefold() == str(project["name"]).casefold():
            removed_undo_ids.append(record["id"])

    return {
        "success": True,
        "name": project["name"],
        "photoIds": photo_ids,
        "sourcePaths": list(dict.fromkeys(source_paths)),
        "artifactPaths": list(dict.fromkeys(artifact_paths)),
        "removedUndoIds": removed_undo_ids,
    }


def deleted_project_cleanup_plan(db, payload: dict):
    project_id = str(payload.get("projectId") or "")
    project = db.execute("SELECT * FROM projects WHERE id=? AND is_deleted=1", (project_id,)).fetchone()
    if project is None:
        raise ValueError("已删除项目记录不存在")
    return project_cleanup_plan(db, project)


def purge_deleted_project(db, payload: dict):
    result = deleted_project_cleanup_plan(db, payload)
    project_id = str(payload.get("projectId") or "")
    removed_undo_ids = result["removedUndoIds"]
    if removed_undo_ids:
        placeholders = ",".join("?" for _ in removed_undo_ids)
        db.execute(f"DELETE FROM undo_records WHERE id IN ({placeholders})", removed_undo_ids)

    db.execute("DELETE FROM projects WHERE id=? AND is_deleted=1", (project_id,))
    db.commit()
    return result


def purge_missing_project(root: str, db, payload: dict):
    name = str(payload.get("name") or "").strip()
    project = db.execute(
        "SELECT * FROM projects WHERE name=? COLLATE NOCASE AND is_deleted=0 AND availability='missing'",
        (name,),
    ).fetchone()
    if project is None:
        raise ValueError("离线项目记录不存在或项目已经恢复")
    project_path = os.path.abspath(os.path.join(root, project["relative_path"]))
    if os.path.exists(project_path):
        raise ValueError("项目文件夹仍然存在，不能只移除软件记录")
    result = project_cleanup_plan(db, project)
    removed_undo_ids = result["removedUndoIds"]
    if removed_undo_ids:
        placeholders = ",".join("?" for _ in removed_undo_ids)
        db.execute(f"DELETE FROM undo_records WHERE id IN ({placeholders})", removed_undo_ids)
    db.execute("DELETE FROM projects WHERE id=? AND is_deleted=0 AND availability='missing'", (project["id"],))
    db.commit()
    return result


def missing_projects_list(db, payload: dict):
    cutoff = int(payload.get("missingBefore") or 0)
    rows = db.execute(
        """SELECT id,name,relative_path,missing_since,extra_json FROM projects
           WHERE is_deleted=0 AND availability='missing' AND missing_since IS NOT NULL AND missing_since<=?
           ORDER BY missing_since""",
        (cutoff,),
    ).fetchall()
    projects = []
    for row in rows:
        try:
            archive = (json.loads(row["extra_json"] or "{}").get("archive") or {})
        except (TypeError, ValueError, json.JSONDecodeError):
            archive = {}
        if archive.get("path"):
            continue
        projects.append({"id": row["id"], "name": row["name"], "relativePath": row["relative_path"], "missingSince": row["missing_since"]})
    return {"success": True, "projects": projects}


def cleanup_media_workflow_graph(root: str, db, session_cutoff: int | None = None):
    """Remove stale retry metadata and graph records that no longer satisfy endpoint rules."""
    now = int(time.time() * 1000)
    cutoff = int(session_cutoff if session_cutoff is not None else now - 30 * 24 * 60 * 60 * 1000)
    for project in db.execute("SELECT * FROM projects WHERE is_deleted=0").fetchall():
        sync_progress_folder_locations(root, db, project, commit=False)
    removed_slot_mappings = db.execute(
        """DELETE FROM media_import_artifact_slots AS slot WHERE NOT EXISTS(
             SELECT 1 FROM progress_folders progress WHERE progress.id=slot.progress_id
               AND progress.project_id=slot.project_id AND (
                 (slot.import_slot='raw' AND progress.media_kind='image' AND progress.node_role='original' AND progress.artifact_kind IS NULL)
                 OR (slot.import_slot='camera_jpg' AND progress.media_kind='image' AND progress.node_role='original' AND progress.artifact_kind='companion')
                 OR (slot.import_slot='generated_jpg' AND progress.media_kind='image' AND progress.node_role='artifact' AND progress.artifact_kind='preview')
                 OR (slot.import_slot='mov' AND progress.media_kind='video' AND progress.node_role='original' AND progress.artifact_kind IS NULL)
                 OR (slot.import_slot='video_preview' AND progress.media_kind='video' AND progress.node_role='artifact' AND progress.artifact_kind='preview')
               )
           )"""
    ).rowcount
    removed_edges = []
    rows = db.execute(
        """SELECT edge.*,source.media_kind AS source_media_kind,source.node_role AS source_role,
                  source.artifact_kind AS source_artifact_kind,target.media_kind AS target_media_kind,
                  target.node_role AS target_role,target.artifact_kind AS target_artifact_kind
           FROM version_graph_edges edge
           LEFT JOIN progress_folders source ON source.id=edge.source_progress_id
           LEFT JOIN progress_folders target ON target.id=edge.target_progress_id"""
    ).fetchall()
    for row in rows:
        valid = row["source_role"] is not None and row["target_role"] is not None and row["source_media_kind"] == row["target_media_kind"] and (
            row["edge_kind"] == "media_companion" and row["source_role"] == "original"
            and row["target_role"] == "original" and row["target_artifact_kind"] == "companion"
            or row["edge_kind"] == "derived_preview" and row["source_role"] in ("original", "progress")
            and row["target_role"] == "artifact" and row["target_artifact_kind"] == "preview"
            or row["edge_kind"] == "workflow_input" and (
                row["source_role"] in ("selection", "workflow") and row["target_role"] == "progress"
                or row["source_role"] in ("original", "progress") and row["target_role"] == "workflow"
                and row["target_artifact_kind"] == "team_workspace"
            )
        )
        if not valid:
            db.execute("DELETE FROM version_graph_edges WHERE id=?", (row["id"],))
            removed_edges.append(row["id"])
    removed_sessions = db.execute(
        "DELETE FROM media_import_graph_sessions WHERE updated_at<=?",
        (cutoff,),
    ).rowcount
    db.commit()
    return {"removedEdgeIds": removed_edges, "removedImportSessionCount": removed_sessions,
            "removedImportSlotMappingCount": removed_slot_mappings}


def mutate(root: str, database: str, action: str, payload: dict):
    db = connect(root, database)
    now = int(time.time() * 1000)
    if action == "catalog_sync":
        try:
            sync_directories(os.path.abspath(root), db)
            return catalog_snapshot(db, database)
        finally:
            db.close()
    if action == "maintenance_run":
        try:
            graph_cleanup = cleanup_media_workflow_graph(root, db, payload.get("importSessionCutoff"))
            _check_integrity(db)
            _automatic_backup_if_due(db, database)
            progress_cleanup = cleanup_progress_tombstones(root, db, payload.get("progressTombstoneCutoff"))
            tracking_cleanup = cleanup_tracking_sessions(db, payload.get("trackingSessionCutoff"))
            _check_integrity(db, force=True)
            return {"success": True, "progressTombstones": progress_cleanup, "trackingSessions": tracking_cleanup, "mediaWorkflowGraph": graph_cleanup}
        finally:
            db.close()
    if action == "add":
        if not valid_project_status(payload["status"]):
            raise ValueError("无效的项目状态")
        project_path = os.path.join(os.path.abspath(root), payload["relativePath"])
        db.execute("DELETE FROM projects WHERE is_deleted=1 AND name=? COLLATE NOCASE", (payload["name"],))
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,filesystem_id,created_at,updated_at,extra_json) VALUES(?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), payload["name"], payload["status"], payload["relativePath"], directory_identity(project_path), now, now, json.dumps(payload.get("extra") or {}, ensure_ascii=False)),
        )
    elif action == "status":
        if not valid_project_status(payload["status"]):
            raise ValueError("无效的项目状态")
        db.execute("UPDATE projects SET status=?, updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["status"], now, payload["name"]))
    elif action == "archive_project":
        row = db.execute("SELECT extra_json FROM projects WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["name"],)).fetchone()
        if row is None:
            raise ValueError("项目不存在")
        try:
            extra = json.loads(row["extra_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            extra = {}
        extra["archive"] = {
            "path": os.path.abspath(payload["archivePath"]),
            "verifiedAt": int(payload.get("verifiedAt") or now),
            "fileCount": int(payload.get("fileCount") or 0),
            "bytes": int(payload.get("bytes") or 0),
        }
        db.execute(
            "UPDATE projects SET status='已归档',availability='available',missing_since=NULL,missing_checks=0,extra_json=?,updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE",
            (json.dumps(extra, ensure_ascii=False), now, payload["name"]),
        )
    elif action == "unarchive_project":
        status = payload.get("status") or "后期中"
        if not valid_project_status(status) or status in ("未分类", "已归档"):
            raise ValueError("无效的移回状态")
        row = db.execute("SELECT extra_json FROM projects WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["name"],)).fetchone()
        if row is None:
            raise ValueError("项目不存在")
        try:
            extra = json.loads(row["extra_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            extra = {}
        extra.pop("archive", None)
        db.execute(
            "UPDATE projects SET status=?,availability='available',missing_since=NULL,missing_checks=0,extra_json=?,updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE",
            (status, json.dumps(extra, ensure_ascii=False), now, payload["name"]),
        )
    elif action == "rename":
        extra_json = None
        if "projectDate" in payload:
            row = db.execute("SELECT extra_json FROM projects WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["name"],)).fetchone()
            try:
                extra = json.loads((row["extra_json"] if row else "") or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                extra = {}
            if payload.get("projectDate"):
                extra["projectDate"] = payload["projectDate"]
            else:
                extra.pop("projectDate", None)
            extra_json = json.dumps(extra, ensure_ascii=False)
        if extra_json is None:
            db.execute("UPDATE projects SET name=?, relative_path=?, updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["nextName"], payload["relativePath"], now, payload["name"]))
        else:
            db.execute("UPDATE projects SET name=?, relative_path=?, extra_json=?, updated_at=? WHERE is_deleted=0 AND name=? COLLATE NOCASE", (payload["nextName"], payload["relativePath"], extra_json, now, payload["name"]))
    elif action == "delete":
        db.execute("UPDATE projects SET is_deleted=1, updated_at=? WHERE name=? COLLATE NOCASE", (now, payload["name"]))
    elif action == "restore_project":
        next_name = payload.get("nextName") or payload["name"]
        relative_path = payload.get("relativePath") or next_name
        filesystem_id = directory_identity(os.path.join(os.path.abspath(root), relative_path))
        db.execute(
            """UPDATE projects SET is_deleted=0,name=?,status=?,relative_path=?,filesystem_id=?,updated_at=?
               WHERE name=? COLLATE NOCASE""",
            (next_name, payload.get("status") or "未分类", relative_path, filesystem_id, now, payload["name"]),
        )
    elif action == "deleted_projects_list":
        result = deleted_projects_list(db)
        db.close()
        return result
    elif action == "deleted_project_cleanup_plan":
        result = deleted_project_cleanup_plan(db, payload)
        db.close()
        return result
    elif action == "purge_deleted_project":
        result = purge_deleted_project(db, payload)
        db.close()
        return result
    elif action == "purge_missing_project":
        result = purge_missing_project(root, db, payload)
        db.close()
        return result
    elif action == "missing_projects_list":
        result = missing_projects_list(db, payload)
        db.close()
        return result
    elif action == "media_sync_project":
        result = media_sync_project(root, db, payload)
        db.close()
        return result
    elif action == "media_get":
        result = media_get(root, db, payload)
        db.close()
        return result
    elif action == "media_create_version":
        result = media_create_version(db, payload)
        db.close()
        return result
    elif action == "media_get_photo":
        result = media_get_photo(db, payload)
        db.close()
        return result
    elif action == "batch_list":
        result = batch_list(root, db, payload)
        db.close()
        return result
    elif action == "progress_list":
        result = progress_list(root, db, payload)
        db.close()
        return result
    elif action == "progress_register":
        result = progress_register(root, db, payload)
        db.close()
        return result
    elif action == "progress_register_with_graph":
        result = progress_register_with_graph(root, db, payload)
        db.close()
        return result
    elif action == "progress_update_tree":
        result = progress_update_tree(root, db, payload)
        db.close()
        return result
    elif action == "progress_relation_update":
        result = progress_relation_update(db, payload)
        db.close()
        return result
    elif action == "progress_legacy_selection_repair":
        result = progress_legacy_selection_repair(db, payload)
        db.close()
        return result
    elif action == "version_graph_edge_create":
        result = version_graph_edge_create(db, payload)
        db.close()
        return result
    elif action == "version_graph_edge_list":
        result = version_graph_edge_list(db, payload)
        db.close()
        return result
    elif action == "version_graph_edge_delete":
        result = version_graph_edge_delete(db, payload)
        db.close()
        return result
    elif action == "version_graph_edge_replace_source":
        result = version_graph_edge_replace_source(db, payload)
        db.close()
        return result
    elif action == "media_workflow_import_commit":
        result = media_workflow_import_commit(root, db, payload)
        db.close()
        return result
    elif action == "progress_adopt_media":
        result = progress_adopt_media(root, db, payload)
        db.close()
        return result
    elif action == "version_tree_layout_get":
        result = version_tree_layout_get(db, payload)
        db.close()
        return result
    elif action == "version_tree_layout_save":
        result = version_tree_layout_save(db, payload)
        db.close()
        return result
    elif action == "progress_policy_save":
        result = progress_policy_save(db, payload)
        db.close()
        return result
    elif action == "progress_mark_stale":
        result = progress_mark_stale(db, payload)
        db.close()
        return result
    elif action == "progress_mark_ready":
        result = progress_mark_ready(db, payload)
        db.close()
        return result
    elif action == "progress_main_branch":
        result = progress_main_branch(db, payload)
        db.close()
        return result
    elif action == "progress_visible_relations":
        result = progress_visible_relations(db, payload)
        db.close()
        return result
    elif action == "progress_copy_missing_children":
        result = progress_copy_missing_children(db, payload)
        db.close()
        return result
    elif action == "progress_detect_stale":
        result = progress_detect_stale(root, db, payload)
        db.close()
        return result
    elif action == "tracking_session_create":
        result = tracking_session_create(root, db, payload)
        db.close()
        return result
    elif action == "tracking_prepare":
        result = tracking_prepare(root, db, payload)
        db.close()
        return result
    elif action == "tracking_store_preview":
        result = tracking_store_preview(db, payload)
        db.close()
        return result
    elif action == "tracking_session_get":
        result = tracking_session_get(db, payload)
        db.close()
        return result
    elif action == "tracking_session_release":
        result = tracking_session_release(db, payload)
        db.close()
        return result
    elif action == "tracking_session_decide":
        result = tracking_session_decide(root, db, payload)
        db.close()
        return result
    elif action == "tracking_commit_plan":
        result = tracking_commit_plan(root, db, payload)
        db.close()
        return result
    elif action == "tracking_commit_complete":
        result = tracking_commit_complete(root, db, payload)
        db.close()
        return result
    elif action == "tracking_commit_failed":
        result = tracking_commit_failed(db, payload)
        db.close()
        return result
    elif action == "progress_main_branch_media":
        result = progress_main_branch_media(db, payload)
        db.close()
        return result
    elif action == "progress_delete_missing":
        result = progress_delete_missing(root, db, payload)
        db.close()
        return result
    elif action == "batch_register_baseline":
        result = batch_register_baseline(root, db, payload)
        db.close()
        return result
    elif action == "batch_commit_compare":
        result = batch_commit_compare(root, db, payload)
        db.close()
        return result
    elif action == "batch_operation_list":
        result = batch_operation_list(db, payload)
        db.close()
        return result
    elif action == "batch_retry_operations":
        result = batch_retry_operations(db, payload)
        db.close()
        return result
    elif action == "media_update_version":
        result = media_update_version(db, payload)
        db.close()
        return result
    elif action == "media_refresh_metadata_fingerprint":
        result = media_refresh_metadata_fingerprint(db, payload)
        db.close()
        return result
    elif action == "final_version_list":
        result = final_version_list(db, payload)
        db.close()
        return result
    elif action == "media_set_thumbnail":
        result = media_set_thumbnail(db, payload)
        db.close()
        return result
    elif action == "media_relocate_version":
        result = media_relocate_version(db, payload)
        db.close()
        return result
    elif action == "media_delete_version":
        result = media_delete_version(db, payload)
        db.close()
        return result
    elif action == "media_version_delete_scope":
        result = media_version_delete_scope(db, payload)
        db.close()
        return result
    elif action == "media_delete_project_missing_version":
        result = media_delete_project_missing_version(db, payload)
        db.close()
        return result
    elif action == "media_record_compare":
        result = media_record_compare(db, payload)
        db.close()
        return result
    elif action == "team_patch_list":
        result = team_patch_list(db, payload)
        db.close()
        return result
    elif action == "team_project_workspace":
        result = team_project_workspace(root, db, payload)
        db.close()
        return result
    elif action == "team_project_register_photo":
        result = team_project_register_photo(db, payload)
        db.close()
        return result
    elif action == "team_project_unregister_photo":
        result = team_project_unregister_photo(db, payload)
        db.close()
        return result
    elif action == "team_identity_save":
        result = team_identity_save(db, payload)
        db.close()
        return result
    elif action == "team_identity_assign":
        result = team_identity_assign(db, payload)
        db.close()
        return result
    elif action == "team_identity_confirm_group":
        result = team_identity_confirm_group(db, payload)
        db.close()
        return result
    elif action == "team_identity_complete":
        result = team_identity_complete(db, payload)
        db.close()
        return result
    elif action == "team_identity_delete":
        result = team_identity_delete(db, payload)
        db.close()
        return result
    elif action == "team_person_exclusion_list":
        result = team_person_exclusion_list(db, payload)
        db.close()
        return result
    elif action == "team_person_exclusion_add":
        result = team_person_exclusion_add(db, payload)
        db.close()
        return result
    elif action == "team_person_exclusion_clear":
        result = team_person_exclusion_clear(db, payload)
        db.close()
        return result
    elif action == "team_patch_replace":
        result = team_patch_replace(db, payload)
        db.close()
        return result
    elif action == "team_patch_update":
        result = team_patch_update(db, payload)
        db.close()
        return result
    elif action == "team_patch_delete":
        result = team_patch_delete(db, payload)
        db.close()
        return result
    elif action == "team_patch_cleanup":
        result = team_patch_cleanup(db, payload)
        db.close()
        return result
    elif action == "undo_record_add":
        record_id = str(payload.get("id") or uuid.uuid4())
        db.execute(
            "INSERT OR REPLACE INTO undo_records(id,kind,payload_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (record_id, str(payload.get("kind") or "trash"), json.dumps(payload.get("payload") or {}, ensure_ascii=False), "ready", now, now),
        )
        db.commit()
        db.close()
        return {"success": True, "id": record_id}
    elif action == "undo_record_latest":
        row = db.execute(
            "SELECT * FROM undo_records WHERE state='ready' AND kind='trash' ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        db.close()
        if row is None:
            return {"success": True, "record": None}
        record = dict(row)
        record["payload"] = json.loads(record.pop("payload_json"))
        return {"success": True, "record": record}
    elif action == "undo_record_remove":
        db.execute("DELETE FROM undo_records WHERE id=?", (str(payload.get("id") or ""),))
    elif action == "undo_record_mark_unavailable":
        db.execute("UPDATE undo_records SET state='unavailable', updated_at=? WHERE id=?", (now, str(payload.get("id") or "")))
    else:
        raise ValueError(f"不支持的数据库操作：{action}")
    db.commit()
    db.close()
    return {"success": True}


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", nargs="?", choices=("init", "catalog_sync", "maintenance_run", "add", "status", "archive_project", "unarchive_project", "rename", "delete", "restore_project", "deleted_projects_list", "deleted_project_cleanup_plan", "purge_deleted_project", "missing_projects_list", "purge_missing_project", "media_sync_project", "media_get", "media_get_photo", "batch_list", "progress_list", "progress_register", "progress_register_with_graph", "progress_adopt_media", "progress_update_tree", "progress_relation_update", "progress_legacy_selection_repair", "version_graph_edge_create", "version_graph_edge_list", "version_graph_edge_delete", "version_graph_edge_replace_source", "media_workflow_import_commit", "version_tree_layout_get", "version_tree_layout_save", "progress_policy_save", "progress_mark_stale", "progress_mark_ready", "progress_main_branch", "progress_visible_relations", "progress_copy_missing_children", "progress_detect_stale", "tracking_session_create", "tracking_prepare", "tracking_store_preview", "tracking_session_get", "tracking_session_release", "tracking_session_decide", "tracking_commit_plan", "tracking_commit_complete", "tracking_commit_failed", "progress_main_branch_media", "progress_delete_missing", "batch_register_baseline", "batch_commit_compare", "batch_operation_list", "batch_retry_operations", "media_create_version", "media_update_version", "media_refresh_metadata_fingerprint", "final_version_list", "media_set_thumbnail", "media_relocate_version", "media_delete_version", "media_version_delete_scope", "media_delete_project_missing_version", "media_record_compare", "team_patch_list", "team_project_workspace", "team_project_register_photo", "team_project_unregister_photo", "team_identity_save", "team_identity_assign", "team_identity_confirm_group", "team_identity_complete", "team_identity_delete", "team_person_exclusion_list", "team_person_exclusion_add", "team_person_exclusion_clear", "team_patch_replace", "team_patch_update", "team_patch_delete", "team_patch_cleanup", "undo_record_add", "undo_record_latest", "undo_record_remove", "undo_record_mark_unavailable"))
    parser.add_argument("--root")
    parser.add_argument("--database")
    parser.add_argument("--payload", default="{}")
    parser.add_argument("--server", action="store_true")
    args = parser.parse_args(args_list)
    if args.server:
        run_server()
        return
    if not args.action or not args.root or not args.database:
        parser.error("action, --root and --database are required outside server mode")
    result = load(args.root, args.database) if args.action == "init" else mutate(args.root, args.database, args.action, json.loads(args.payload))
    print(json.dumps(result, ensure_ascii=False), flush=True)


def run_server():
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            action = request["action"]
            root = request["root"]
            database = request["database"]
            payload = request.get("payload") or {}
            result = load(root, database) if action == "init" else mutate(root, database, action, payload)
            response = {"id": request_id, "success": True, "result": result}
        except Exception as error:
            response = {"id": request_id, "success": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    run(sys.argv[1:])
