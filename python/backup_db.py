"""Consistent PhotoFlow database snapshots and restore helpers."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path


PATH_COLUMNS = {
    "photos": ("original_file_path",),
    "versions": ("file_path", "file_path_key", "thumbnail_path"),
    "version_batches": ("source_folder_path", "source_folder_path_key"),
    "progress_folders": ("folder_path", "folder_path_key"),
    "batch_file_operations": ("source_path", "target_path"),
    "batch_items": ("source_path", "source_path_key"),
    "file_records": ("current_path",),
    "team_patch_tasks": ("patch_path", "mask_path", "edited_patch_path"),
    "team_person_assignments": ("edited_patch_path",),
}

PROJECT_TABLE_ORDER = (
    "projects",
    "project_properties",
    "project_tags",
    "photos",
    "versions",
    "version_batches",
    "progress_folders",
    "batch_file_operations",
    "batch_items",
    "file_records",
    "version_compare_history",
    "team_patch_tasks",
    "team_retouch_photos",
    "team_person_identities",
    "team_person_assignments",
    "team_person_exclusions",
)


def connect(path: str, *, readonly: bool = False) -> sqlite3.Connection:
    absolute = os.path.abspath(path)
    if readonly:
        uri = f"{Path(absolute).as_uri()}?mode=ro"
        db = sqlite3.connect(uri, uri=True, timeout=30)
    else:
        os.makedirs(os.path.dirname(absolute), exist_ok=True)
        db = sqlite3.connect(absolute, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def snapshot(source: str, destination: str, media: str = "") -> dict:
    source_db = connect(source, readonly=True)
    if media and os.path.isfile(media) and "photos" not in {
        row[0] for row in source_db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }:
        source_db.execute("ATTACH DATABASE ? AS media", (os.path.abspath(media),))
    destination = os.path.abspath(destination)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    if os.path.exists(destination):
        os.remove(destination)
    target_db = connect(destination)
    try:
        source_db.backup(target_db)
        check = target_db.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"数据库快照完整性检查失败：{check}")
        projects = []
        for row in source_db.execute(
            "SELECT id,name,status,relative_path,extra_json FROM projects WHERE is_deleted=0 ORDER BY name"
        ):
            photo_ids = [item[0] for item in source_db.execute(
                "SELECT id FROM photos WHERE project_id=? AND is_deleted=0", (row["id"],)
            )]
            name_hash = hashlib.sha256(row["name"].encode("utf-8")).hexdigest()
            workflow_hash = hashlib.sha256(f'{row["status"]}\0{row["name"]}'.encode("utf-8")).hexdigest()
            projects.append({
                "id": row["id"],
                "name": row["name"],
                "status": row["status"],
                "relativePath": row["relative_path"],
                "extra": json.loads(row["extra_json"] or "{}"),
                "workspaceDataPrefixes": [f"team-retouch/{photo_id}/" for photo_id in photo_ids],
                "workspaceDataFiles": [
                    f"team-retouch/workflows/{workflow_hash}.json",
                    f"team-retouch/identity-similarities/{name_hash}.json",
                    f"team-retouch/workflow-settings/{name_hash}.json",
                ],
            })
        schema = target_db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        return {"success": True, "schemaVersion": int(schema[0] if schema else 0), "projects": projects}
    finally:
        target_db.close()
        source_db.close()


def path_replacement(value, replacements):
    if not value:
        return value
    original = str(value)
    normalized = os.path.normcase(os.path.normpath(original))
    for old_root, new_root in replacements:
        old_normalized = os.path.normcase(os.path.normpath(old_root))
        if normalized == old_normalized:
            return os.path.normpath(new_root)
        prefix = old_normalized + os.sep
        if normalized.startswith(prefix):
            relative = os.path.relpath(os.path.normpath(original), os.path.normpath(old_root))
            return os.path.normpath(os.path.join(new_root, relative))
    return original


def rebase_database(db: sqlite3.Connection, replacements):
    existing_tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table, columns in PATH_COLUMNS.items():
        if table not in existing_tables:
            continue
        available = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        usable = [column for column in columns if column in available]
        if not usable:
            continue
        rows = db.execute(f"SELECT rowid,{','.join(usable)} FROM {table}").fetchall()
        for row in rows:
            updates = {}
            for column in usable:
                if table == "versions" and column == "thumbnail_path":
                    updates[column] = None
                else:
                    updates[column] = path_replacement(row[column], replacements)
            assignments = ",".join(f"{column}=?" for column in usable)
            db.execute(
                f"UPDATE {table} SET {assignments} WHERE rowid=?",
                (*[updates[column] for column in usable], row["rowid"]),
            )
    if "file_records" in existing_tables:
        columns = {row[1] for row in db.execute("PRAGMA table_info(file_records)")}
        reset = [column for column in ("windows_file_id", "volume_id") if column in columns]
        if reset:
            db.execute(f"UPDATE file_records SET {','.join(f'{column}=NULL' for column in reset)}")
    if "versions" in existing_tables:
        db.execute("UPDATE versions SET file_id=NULL")
    if "photos" in existing_tables:
        db.execute("UPDATE photos SET original_file_id=NULL")
    if "version_batches" in existing_tables:
        db.execute("UPDATE version_batches SET source_folder_id=NULL")
    if "progress_folders" in existing_tables:
        db.execute("UPDATE progress_folders SET folder_id=NULL")
    if "batch_items" in existing_tables:
        db.execute("UPDATE batch_items SET source_file_id=NULL")


def clear_materialized_archives(db: sqlite3.Connection, project_ids):
    for project_id in project_ids:
        row = db.execute("SELECT extra_json FROM projects WHERE id=?", (str(project_id),)).fetchone()
        if row is None:
            continue
        try:
            extra = json.loads(row["extra_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            extra = {}
        extra.pop("archive", None)
        db.execute("UPDATE projects SET extra_json=?,availability='available',missing_since=NULL,missing_checks=0 WHERE id=?", (json.dumps(extra, ensure_ascii=False), str(project_id)))


def restore_workspace(source: str, destination: str, old_root: str, new_root: str,
                      old_data_root: str = "", new_data_root: str = "", materialized_archive_project_ids=None) -> dict:
    source_db = connect(source, readonly=True)
    destination = os.path.abspath(destination)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    if os.path.exists(destination):
        raise RuntimeError("目标工作区数据库已存在")
    target_db = connect(destination)
    try:
        source_db.backup(target_db)
        replacements = [(old_root, new_root)]
        if old_data_root and new_data_root:
            replacements.insert(0, (old_data_root, new_data_root))
        rebase_database(target_db, replacements)
        clear_materialized_archives(target_db, materialized_archive_project_ids or [])
        target_db.execute(
            "INSERT INTO meta(key,value) VALUES('workspace_root',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (os.path.abspath(new_root),),
        )
        target_db.commit()
        check = target_db.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"恢复后的数据库完整性检查失败：{check}")
        return {"success": True}
    finally:
        target_db.close()
        source_db.close()


def table_columns(db: sqlite3.Connection, table: str):
    if "." in table:
        schema, name = table.split(".", 1)
        return [row[1] for row in db.execute(f"PRAGMA {schema}.table_info({name})")]
    return [row[1] for row in db.execute(f"PRAGMA table_info({table})")]


def restore_project(source: str, destination: str, project_id: str, old_root: str, new_root: str,
                    target_relative_path: str, old_data_root: str = "", new_data_root: str = "", materialized_archive_project_ids=None) -> dict:
    source_db = connect(source, readonly=True)
    target_db = connect(destination)
    temporary = f"{destination}.project-import-{os.getpid()}.sqlite3"
    try:
        project = source_db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if project is None:
            raise RuntimeError("备份中找不到项目记录")
        name_conflict = target_db.execute(
            "SELECT id FROM projects WHERE name=? COLLATE NOCASE AND id<>?", (project["name"], project_id)
        ).fetchone()
        if name_conflict:
            raise RuntimeError("当前工作区已有同名项目")
        if os.path.exists(temporary):
            os.remove(temporary)
        temporary_db = connect(temporary)
        source_db.backup(temporary_db)
        replacements = [(old_root, new_root)]
        if old_data_root and new_data_root:
            replacements.insert(0, (old_data_root, new_data_root))
        rebase_database(temporary_db, replacements)
        clear_materialized_archives(temporary_db, materialized_archive_project_ids or [])
        temporary_db.execute(
            "UPDATE projects SET relative_path=?,availability='available',missing_since=NULL,missing_checks=0,is_deleted=0 WHERE id=?",
            (target_relative_path, project_id),
        )
        temporary_db.commit()
        temporary_db.close()

        target_db.execute("BEGIN IMMEDIATE")
        target_db.execute("DELETE FROM projects WHERE id=?", (project_id,))
        target_db.execute("ATTACH DATABASE ? AS portable", (temporary,))
        try:
            for table in PROJECT_TABLE_ORDER:
                target_columns = table_columns(target_db, table)
                portable_columns = table_columns(target_db, f"portable.{table}")
                columns = [column for column in target_columns if column in portable_columns]
                if not columns:
                    continue
                column_list = ",".join(columns)
                if table == "projects":
                    target_db.execute(
                        f"INSERT INTO {table}({column_list}) SELECT {column_list} FROM portable.{table} WHERE id=?",
                        (project_id,),
                    )
                elif "project_id" in columns:
                    target_db.execute(
                        f"INSERT INTO {table}({column_list}) SELECT {column_list} FROM portable.{table} WHERE project_id=?",
                        (project_id,),
                    )
                elif table == "versions":
                    target_db.execute(
                        f"INSERT INTO versions({column_list}) SELECT {column_list} FROM portable.versions WHERE photo_id IN (SELECT id FROM portable.photos WHERE project_id=?)",
                        (project_id,),
                    )
                elif table in ("batch_file_operations", "batch_items"):
                    target_db.execute(
                        f"INSERT INTO {table}({column_list}) SELECT {column_list} FROM portable.{table} WHERE batch_id IN (SELECT id FROM portable.version_batches WHERE project_id=?)",
                        (project_id,),
                    )
                elif table == "file_records":
                    target_db.execute(
                        f"INSERT INTO file_records({column_list}) SELECT {column_list} FROM portable.file_records WHERE owner_id IN (SELECT v.id FROM portable.versions v JOIN portable.photos p ON p.id=v.photo_id WHERE p.project_id=?)",
                        (project_id,),
                    )
                elif table == "version_compare_history":
                    target_db.execute(
                        f"INSERT INTO version_compare_history({column_list}) SELECT {column_list} FROM portable.version_compare_history WHERE photo_id IN (SELECT id FROM portable.photos WHERE project_id=?)",
                        (project_id,),
                    )
                elif table == "team_patch_tasks":
                    target_db.execute(
                        f"INSERT INTO team_patch_tasks({column_list}) SELECT {column_list} FROM portable.team_patch_tasks WHERE photo_id IN (SELECT id FROM portable.photos WHERE project_id=?)",
                        (project_id,),
                    )
            target_db.commit()
            target_db.execute("DETACH DATABASE portable")
        except Exception:
            target_db.rollback()
            raise
        return {"success": True, "projectId": project_id, "name": project["name"]}
    finally:
        target_db.close()
        source_db.close()
        try:
            os.remove(temporary)
        except OSError:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--source", required=True)
    snapshot_parser.add_argument("--destination", required=True)
    snapshot_parser.add_argument("--media", default="")
    workspace_parser = subparsers.add_parser("restore-workspace")
    workspace_parser.add_argument("--source", required=True)
    workspace_parser.add_argument("--destination", required=True)
    workspace_parser.add_argument("--old-root", required=True)
    workspace_parser.add_argument("--new-root", required=True)
    workspace_parser.add_argument("--old-data-root", default="")
    workspace_parser.add_argument("--new-data-root", default="")
    workspace_parser.add_argument("--materialized-archive-project-ids", default="[]")
    project_parser = subparsers.add_parser("restore-project")
    project_parser.add_argument("--source", required=True)
    project_parser.add_argument("--destination", required=True)
    project_parser.add_argument("--project-id", required=True)
    project_parser.add_argument("--old-root", required=True)
    project_parser.add_argument("--new-root", required=True)
    project_parser.add_argument("--target-relative-path", required=True)
    project_parser.add_argument("--old-data-root", default="")
    project_parser.add_argument("--new-data-root", default="")
    project_parser.add_argument("--materialized-archive-project-ids", default="[]")
    args = parser.parse_args(argv)
    if args.command == "snapshot":
        result = snapshot(args.source, args.destination, args.media)
    elif args.command == "restore-workspace":
        result = restore_workspace(args.source, args.destination, args.old_root, args.new_root, args.old_data_root, args.new_data_root, json.loads(args.materialized_archive_project_ids))
    else:
        result = restore_project(args.source, args.destination, args.project_id, args.old_root, args.new_root, args.target_relative_path, args.old_data_root, args.new_data_root, json.loads(args.materialized_archive_project_ids))
    print(json.dumps(result, ensure_ascii=False))


def run(argv=None):
    main(argv)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    main()
