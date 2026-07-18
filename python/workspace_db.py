"""SQLite-backed workspace catalog stored outside the user's project folders."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import uuid

STATUSES = ("未分类", "策划中", "待拍摄", "后期中", "已归档")


def connect(root: str, database: str):
    root = os.path.abspath(root)
    database = os.path.abspath(database)
    os.makedirs(os.path.dirname(database), exist_ok=True)
    db = sqlite3.connect(database)
    db.row_factory = sqlite3.Row
    db.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            status TEXT NOT NULL,
            relative_path TEXT NOT NULL UNIQUE,
            filesystem_id TEXT,
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
        INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
    """)
    columns = {row[1] for row in db.execute("PRAGMA table_info(projects)").fetchall()}
    if "filesystem_id" not in columns:
        db.execute("ALTER TABLE projects ADD COLUMN filesystem_id TEXT")
    db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('workspace_root', ?)", (root,))
    db.commit()
    return db


def directory_identity(path: str):
    try:
        stat = os.stat(path)
        return f"{stat.st_dev}:{stat.st_ino}" if stat.st_ino else None
    except OSError:
        return None


def sync_directories(root: str, db):
    """Reconcile direct child folders with the catalog without moving files."""
    now = int(time.time() * 1000)
    rows = db.execute("SELECT * FROM projects").fetchall()
    by_path = {row["relative_path"].casefold(): row for row in rows}
    by_identity = {row["filesystem_id"]: row for row in rows if row["filesystem_id"]}
    seen_ids = set()

    for entry in os.scandir(root):
        if not entry.is_dir() or entry.name.startswith((".", "_")):
            continue
        relative_path = entry.name
        identity = directory_identity(entry.path)
        row = by_path.get(relative_path.casefold())
        if row is not None:
            seen_ids.add(row["id"])
            if identity and identity != row["filesystem_id"]:
                db.execute("UPDATE projects SET filesystem_id=?, updated_at=? WHERE id=?", (identity, now, row["id"]))
            continue
        renamed_row = by_identity.get(identity) if identity else None
        if renamed_row is not None and renamed_row["id"] not in seen_ids:
            db.execute("UPDATE projects SET name=?, relative_path=?, updated_at=? WHERE id=?", (entry.name, relative_path, now, renamed_row["id"]))
            seen_ids.add(renamed_row["id"])
            continue
        project_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,filesystem_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (project_id, entry.name, "未分类", relative_path, identity, now, now),
        )
        seen_ids.add(project_id)

    for row in rows:
        if row["id"] not in seen_ids and not os.path.isdir(os.path.join(root, row["relative_path"])):
            db.execute("DELETE FROM projects WHERE id=?", (row["id"],))
    db.commit()


def load(root: str, database: str):
    db = connect(root, database)
    sync_directories(os.path.abspath(root), db)
    rows = [dict(row) for row in db.execute("SELECT * FROM projects ORDER BY name COLLATE NOCASE").fetchall()]
    db.close()
    return {"success": True, "projects": rows, "database": os.path.abspath(database)}


def mutate(root: str, database: str, action: str, payload: dict):
    db = connect(root, database)
    now = int(time.time() * 1000)
    if action == "add":
        if payload["status"] not in STATUSES:
            raise ValueError("无效的项目状态")
        project_path = os.path.join(os.path.abspath(root), payload["relativePath"])
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,filesystem_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), payload["name"], payload["status"], payload["relativePath"], directory_identity(project_path), now, now),
        )
    elif action == "status":
        if payload["status"] not in STATUSES:
            raise ValueError("无效的项目状态")
        db.execute("UPDATE projects SET status=?, updated_at=? WHERE name=? COLLATE NOCASE", (payload["status"], now, payload["name"]))
    elif action == "rename":
        db.execute("UPDATE projects SET name=?, relative_path=?, updated_at=? WHERE name=? COLLATE NOCASE", (payload["nextName"], payload["relativePath"], now, payload["name"]))
    elif action == "delete":
        db.execute("DELETE FROM projects WHERE name=? COLLATE NOCASE", (payload["name"],))
    db.commit()
    db.close()
    return {"success": True}


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", nargs="?", choices=("init", "add", "status", "rename", "delete"))
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
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    run(sys.argv[1:])
