"""Verify, snapshot and restore an independently owned SQLite domain store."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time
import tempfile
import uuid
from pathlib import Path

from workspace_domain_storage import DOMAIN_TABLES


PATH_COLUMNS = {
    "media": {"photos": ("original_file_path",), "file_records": ("current_path",)},
    "versioning": {
        "versions": ("file_path", "file_path_key", "thumbnail_path"),
        "version_batches": ("source_folder_path", "source_folder_path_key"),
        "progress_folders": ("folder_path", "folder_path_key"),
        "batch_file_operations": ("source_path", "target_path"),
        "batch_items": ("source_path", "source_path_key"),
    },
    "operations": {},
    "team-retouch": {
        "team_patch_tasks": ("patch_path", "mask_path", "edited_patch_path"),
        "team_person_assignments": ("edited_patch_path",),
    },
}


def _connect(path: str, readonly: bool = False) -> sqlite3.Connection:
    absolute = os.path.abspath(path)
    if readonly:
        db = sqlite3.connect(f"{Path(absolute).as_uri()}?mode=ro", uri=True, timeout=30)
    else:
        os.makedirs(os.path.dirname(absolute), exist_ok=True)
        db = sqlite3.connect(absolute, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    return db


def verify(path: str) -> dict:
    absolute = os.path.abspath(path)
    if not os.path.isfile(absolute):
        return {"success": False, "state": "missing", "path": absolute}
    try:
        db = _connect(absolute, readonly=True)
        try:
            quick = [row[0] for row in db.execute("PRAGMA quick_check").fetchall()]
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
            schema = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() if "meta" in tables else None
            return {"success": quick == ["ok"], "state": "healthy" if quick == ["ok"] else "corrupt", "path": absolute, "quickCheck": quick[:10], "schemaVersion": int(schema[0]) if schema else 0, "tables": tables}
        finally:
            db.close()
    except (OSError, sqlite3.Error) as error:
        return {"success": False, "state": "unavailable", "path": absolute, "error": str(error)}


def snapshot(source: str, destination: str) -> dict:
    status = verify(source)
    if not status["success"]:
        raise RuntimeError(f"domain store is not healthy: {status}")
    source_db = _connect(source, readonly=True)
    destination_path = os.path.abspath(destination)
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    if os.path.exists(destination_path):
        os.remove(destination_path)
    target_db = _connect(destination_path)
    try:
        source_db.backup(target_db)
        target_db.commit()
    finally:
        target_db.close()
        source_db.close()
    result = verify(destination_path)
    if not result["success"]:
        raise RuntimeError(f"domain snapshot verification failed: {result}")
    return result


def _replace_path(value, replacements):
    if not value:
        return value
    normalized = os.path.normcase(os.path.normpath(str(value)))
    for old_root, new_root in replacements:
        if not old_root:
            continue
        old = os.path.normcase(os.path.normpath(old_root))
        if normalized == old or normalized.startswith(old + os.sep):
            relative = os.path.relpath(os.path.normpath(str(value)), os.path.normpath(old_root))
            return os.path.normpath(new_root if relative == "." else os.path.join(new_root, relative))
    return value


def _rebase(db: sqlite3.Connection, domain: str, replacements) -> None:
    existing = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    for table, columns in PATH_COLUMNS.get(domain, {}).items():
        if table not in existing:
            continue
        key_columns = [row[1] for row in db.execute(f'PRAGMA table_info("{table}")').fetchall() if row[5]]
        if not key_columns:
            continue
        rows = db.execute(f'SELECT * FROM "{table}"').fetchall()
        for row in rows:
            updates = {column: _replace_path(row[column], replacements) for column in columns if column in row.keys()}
            updates = {column: value for column, value in updates.items() if value != row[column]}
            if not updates:
                continue
            where = " AND ".join(f'"{column}"=?' for column in key_columns)
            db.execute(
                f'UPDATE "{table}" SET {", ".join(f"\"{column}\"=?" for column in updates)} WHERE {where}',
                (*updates.values(), *(row[column] for column in key_columns)),
            )
    db.commit()


def restore_workspace(source: str, destination: str, domain: str, replacements) -> dict:
    status = verify(source)
    if not status["success"]:
        raise RuntimeError(f"domain snapshot is not healthy: {status}")
    destination_path = os.path.abspath(destination)
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    staged = f"{destination_path}.restore-{uuid.uuid4().hex}.tmp"
    backup = ""
    try:
        snapshot(source, staged)
        db = _connect(staged)
        try:
            _rebase(db, domain, replacements)
        finally:
            db.close()
        staged_status = verify(staged)
        if not staged_status["success"]:
            raise RuntimeError(f"rebased domain snapshot is not healthy: {staged_status}")

        if os.path.isfile(destination_path):
            backup = f"{destination_path}.before-domain-restore.{int(time.time())}.bak"
            current = verify(destination_path)
            if current["success"]:
                snapshot(destination_path, backup)
            else:
                shutil.copy2(destination_path, backup)
        # Workers are suspended by Electron before this point. Remove stale WAL
        # sidecars only after the current store has a recoverable backup.
        for suffix in ("-wal", "-shm"):
            try:
                os.remove(destination_path + suffix)
            except FileNotFoundError:
                pass
        os.replace(staged, destination_path)
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(staged + suffix)
            except FileNotFoundError:
                pass
    result = verify(destination_path)
    if not result["success"]:
        raise RuntimeError(f"restored domain store is not healthy: {result}")
    return {**result, "backup": backup}


def _columns(db: sqlite3.Connection, schema: str, table: str) -> list[str]:
    return [row[1] for row in db.execute(f'PRAGMA {schema}.table_info("{table}")').fetchall()]


def _copy_filtered(db: sqlite3.Connection, table: str, where: str, values) -> int:
    source_columns = _columns(db, "source_domain", table)
    target_columns = _columns(db, "main", table)
    columns = [column for column in source_columns if column in target_columns]
    if not columns:
        return 0
    projection = ",".join(f'"{column}"' for column in columns)
    return db.execute(
        f'INSERT OR REPLACE INTO main."{table}"({projection}) SELECT {projection} FROM source_domain."{table}" WHERE {where}', values
    ).rowcount


def restore_project(source: str, destination: str, domain: str, project_id: str, peer_source: str = "", replacements=()) -> dict:
    if domain not in ("media", "versioning", "team-retouch"):
        raise ValueError("project restore is not supported for this domain")
    db = _connect(destination)
    db.execute("ATTACH DATABASE ? AS source_domain", (os.path.abspath(source),))
    if peer_source:
        db.execute("ATTACH DATABASE ? AS peer_domain", (os.path.abspath(peer_source),))
    restored = 0
    try:
        if domain == "media":
            photo_ids = [row[0] for row in db.execute("SELECT id FROM source_domain.photos WHERE project_id=?", (project_id,)).fetchall()]
            db.execute("DELETE FROM photos WHERE project_id=?", (project_id,))
            restored += _copy_filtered(db, "photos", "project_id=?", (project_id,))
            if photo_ids and peer_source:
                placeholders = ",".join("?" for _ in photo_ids)
                version_ids = [row[0] for row in db.execute(f"SELECT id FROM peer_domain.versions WHERE photo_id IN ({placeholders})", photo_ids).fetchall()]
                if version_ids:
                    version_placeholders = ",".join("?" for _ in version_ids)
                    db.execute(f"DELETE FROM file_records WHERE owner_id IN ({version_placeholders})", version_ids)
                    restored += _copy_filtered(db, "file_records", f"owner_id IN ({version_placeholders})", version_ids)
        elif domain == "versioning":
            if not peer_source:
                raise ValueError("versioning project restore requires the media snapshot")
            photo_ids = [row[0] for row in db.execute("SELECT id FROM peer_domain.photos WHERE project_id=?", (project_id,)).fetchall()]
            placeholders = ",".join("?" for _ in photo_ids) or "NULL"
            direct_tables = [table for table in DOMAIN_TABLES["versioning"] if "project_id" in _columns(db, "source_domain", table)]
            for table in reversed(direct_tables):
                db.execute(f'DELETE FROM "{table}" WHERE project_id=?', (project_id,))
            if photo_ids:
                db.execute(f"DELETE FROM versions WHERE photo_id IN ({placeholders})", photo_ids)
                db.execute(f"DELETE FROM version_compare_history WHERE photo_id IN ({placeholders})", photo_ids)
            for table in direct_tables:
                restored += _copy_filtered(db, table, "project_id=?", (project_id,))
            if photo_ids:
                restored += _copy_filtered(db, "versions", f"photo_id IN ({placeholders})", photo_ids)
                restored += _copy_filtered(db, "version_compare_history", f"photo_id IN ({placeholders})", photo_ids)
        else:
            existing = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
            for table in ("team_person_exclusions", "team_person_assignments", "team_retouch_photos", "team_person_identities"):
                if table in existing:
                    db.execute(f'DELETE FROM "{table}" WHERE project_id=?', (project_id,))
                    restored += _copy_filtered(db, table, "project_id=?", (project_id,))
            photo_ids = [row[0] for row in db.execute("SELECT photo_id FROM source_domain.team_retouch_photos WHERE project_id=?", (project_id,)).fetchall()]
            if photo_ids:
                placeholders = ",".join("?" for _ in photo_ids)
                db.execute(f"DELETE FROM team_patch_tasks WHERE photo_id IN ({placeholders})", photo_ids)
                restored += _copy_filtered(db, "team_patch_tasks", f"photo_id IN ({placeholders})", photo_ids)
        db.commit()
        _rebase(db, domain, replacements)
    finally:
        try: db.execute("DETACH DATABASE source_domain")
        except sqlite3.Error: pass
        try: db.execute("DETACH DATABASE peer_domain")
        except sqlite3.Error: pass
        db.close()
    return {"success": True, "projectId": project_id, "restoredRows": restored}


def reset_store(destination: str, domain: str) -> dict:
    """Quarantine one store and recreate only its empty owned schema."""
    destination_path = os.path.abspath(destination)
    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    staged = f"{destination_path}.reset-{uuid.uuid4().hex}.tmp"
    quarantine = ""
    moved_sidecars = []
    try:
        if domain == "operations":
            from operations_db import _connect as connect_operations
            db = connect_operations(staged)
            db.close()
        elif domain == "team-retouch":
            from team_retouch_storage import ensure_schema
            db = ensure_schema(staged)
            db.close()
        elif domain in DOMAIN_TABLES:
            import workspace_db
            from workspace_domain_storage import attach_and_migrate, database_path_for_workspace_database
            with tempfile.TemporaryDirectory(prefix="photoflow-domain-schema-") as temporary:
                root = os.path.join(temporary, "workspace")
                os.makedirs(root, exist_ok=True)
                core = os.path.join(temporary, "workspace-data", "template.sqlite3")
                template = workspace_db.connect(root, core, include_domains=False)
                try:
                    attach_and_migrate(template, core)
                finally:
                    template.close()
                generated = database_path_for_workspace_database(core, domain)
                shutil.copy2(generated, staged)
        else:
            raise ValueError("domain reset is not supported")

        staged_status = verify(staged)
        if not staged_status["success"]:
            raise RuntimeError(f"unable to create a healthy replacement domain store: {staged_status}")
        if os.path.isfile(destination_path):
            quarantine = f"{destination_path}.quarantine.{int(time.time())}.bak"
            os.replace(destination_path, quarantine)
            for suffix in ("-wal", "-shm"):
                if os.path.exists(destination_path + suffix):
                    os.replace(destination_path + suffix, quarantine + suffix)
                    moved_sidecars.append(suffix)
        try:
            os.replace(staged, destination_path)
        except Exception:
            if quarantine and os.path.isfile(quarantine):
                os.replace(quarantine, destination_path)
                for suffix in moved_sidecars:
                    if os.path.exists(quarantine + suffix):
                        os.replace(quarantine + suffix, destination_path + suffix)
            raise
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(staged + suffix)
            except FileNotFoundError:
                pass
    result = verify(destination_path)
    if not result["success"]:
        raise RuntimeError(f"replacement domain store is not healthy: {result}")
    return {**result, "quarantine": quarantine, "requiresReindex": domain == "media"}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("verify", "snapshot", "restore-workspace", "restore-project", "reset"))
    parser.add_argument("--domain", required=True, choices=tuple(PATH_COLUMNS))
    parser.add_argument("--source")
    parser.add_argument("--destination", required=True)
    parser.add_argument("--project-id")
    parser.add_argument("--peer-source", default="")
    parser.add_argument("--old-root", default="")
    parser.add_argument("--new-root", default="")
    parser.add_argument("--old-data-root", default="")
    parser.add_argument("--new-data-root", default="")
    args = parser.parse_args(argv)
    replacements = [(args.old_root, args.new_root), (args.old_data_root, args.new_data_root)]
    if args.action == "verify":
        result = verify(args.destination)
    elif args.action == "snapshot":
        result = snapshot(args.source, args.destination)
    elif args.action == "restore-workspace":
        result = restore_workspace(args.source, args.destination, args.domain, replacements)
    elif args.action == "restore-project":
        result = restore_project(args.source, args.destination, args.domain, args.project_id, args.peer_source, replacements)
    else:
        result = reset_store(args.destination, args.domain)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    main()
