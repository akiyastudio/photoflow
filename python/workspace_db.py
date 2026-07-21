"""SQLite-backed workspace catalog stored outside the user's project folders."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import uuid

STATUSES = ("未分类", "策划中", "待拍摄", "后期中", "已归档")
IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff",
    ".heic", ".avif", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf",
    ".rw2", ".dng", ".rwl", ".3fr", ".fff", ".iiq", ".pef", ".srw",
}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}


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
        CREATE INDEX IF NOT EXISTS versions_file_identity ON versions(file_id);
        CREATE INDEX IF NOT EXISTS versions_file_path_key ON versions(file_path_key);
        CREATE INDEX IF NOT EXISTS versions_fingerprint ON versions(file_fingerprint);
        CREATE TABLE IF NOT EXISTS file_records (
            id TEXT PRIMARY KEY,
            owner_type TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            current_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            extension TEXT NOT NULL,
            windows_file_id TEXT,
            volume_id TEXT,
            file_size INTEGER NOT NULL,
            modified_at INTEGER,
            quick_hash TEXT,
            full_hash TEXT,
            missing INTEGER NOT NULL DEFAULT 0,
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
            edited_patch_path TEXT,
            status TEXT NOT NULL DEFAULT 'exported',
            merge_metrics_json TEXT NOT NULL DEFAULT '{}',
            merged_version_id TEXT REFERENCES versions(id),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS team_patch_photo ON team_patch_tasks(photo_id, base_version_id, is_deleted);
        INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3');
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


def canonical_path(value: str) -> str:
    # Preserve the user's path casing for display. Case-insensitive matching is
    # handled separately by `file_path_key`, never by the visible path value.
    return os.path.normpath(os.path.abspath(value))


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
    return {"photo": serialize_photo(photo), "versions": [serialize_version(row) for row in versions]}


def upsert_file_record(db, owner_id: str, file_path: str, stat: os.stat_result, identity: str | None, fingerprint: str):
    timestamp = int(time.time() * 1000)
    record = db.execute("SELECT id, created_at FROM file_records WHERE owner_type='version' AND owner_id=?", (owner_id,)).fetchone()
    values = (
        canonical_path(file_path), os.path.basename(file_path), os.path.splitext(file_path)[1].lower(), identity,
        str(stat.st_dev), stat.st_size, int(stat.st_mtime_ns / 1_000_000), fingerprint, timestamp,
    )
    if record:
        db.execute(
            """UPDATE file_records SET current_path=?, file_name=?, extension=?, windows_file_id=?, volume_id=?,
               file_size=?, modified_at=?, quick_hash=?, missing=0, updated_at=? WHERE id=?""",
            values + (record["id"],),
        )
    else:
        db.execute(
            """INSERT INTO file_records(id,owner_type,owner_id,current_path,file_name,extension,windows_file_id,
               volume_id,file_size,modified_at,quick_hash,missing,created_at,updated_at)
               VALUES(?,'version',?,?,?,?,?,?,?,?,?,0,?,?)""",
            (str(uuid.uuid4()), owner_id, *values[:-1], timestamp, timestamp),
        )


def sync_media_file(db, project, file_path: str):
    file_path = canonical_path(file_path)
    kind = media_type(file_path)
    if not kind or not os.path.isfile(file_path):
        return None
    stat = os.stat(file_path)
    identity = file_identity(file_path)
    path_key = file_path.casefold()
    mtime_ms = int(stat.st_mtime_ns / 1_000_000)
    existing = None
    if identity:
        existing = db.execute(
            """SELECT versions.* FROM versions JOIN photos ON photos.id=versions.photo_id
               WHERE versions.file_id=? AND versions.is_deleted=0 AND photos.project_id=? LIMIT 1""",
            (identity, project["id"]),
        ).fetchone()
    if existing is None:
        existing = db.execute(
            """SELECT versions.* FROM versions JOIN photos ON photos.id=versions.photo_id
               WHERE versions.file_path_key=? AND versions.is_deleted=0 AND photos.project_id=? LIMIT 1""",
            (path_key, project["id"]),
        ).fetchone()

    fingerprint = None
    changed = False
    if existing is not None:
        changed = existing["file_size"] != stat.st_size or existing["file_modified_at"] != mtime_ms
        if changed or not existing["file_fingerprint"] or existing["file_id"] != identity:
            fingerprint = quick_fingerprint(file_path, stat)
        else:
            fingerprint = existing["file_fingerprint"]
    else:
        fingerprint = quick_fingerprint(file_path, stat)
        tombstone = db.execute(
            """SELECT versions.photo_id, versions.file_fingerprint FROM versions
               JOIN photos ON photos.id=versions.photo_id
               WHERE versions.file_path_key=? AND versions.is_deleted=1 AND photos.project_id=?
               ORDER BY versions.updated_at DESC LIMIT 1""",
            (path_key, project["id"]),
        ).fetchone()
        if tombstone is not None and tombstone["file_fingerprint"] == fingerprint:
            return tombstone["photo_id"]
        # Cross-volume moves change the OS identity. Only claim a fingerprint
        # whose previous file is missing, otherwise identical exports remain
        # independent Photos instead of being merged accidentally.
        existing = db.execute(
            """SELECT versions.* FROM versions JOIN photos ON photos.id=versions.photo_id
               WHERE versions.file_fingerprint=? AND versions.is_deleted=0 AND photos.project_id=?
                 AND (versions.file_missing=1 OR NOT EXISTS (SELECT 1 FROM file_records
                   WHERE owner_type='version' AND owner_id=versions.id AND missing=0)) LIMIT 1""",
            (fingerprint, project["id"]),
        ).fetchone()

    timestamp = int(time.time() * 1000)
    if existing is not None:
        content_changed_now = bool(
            changed and existing["file_id"] == identity and existing["file_fingerprint"] and existing["file_fingerprint"] != fingerprint
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
        upsert_file_record(db, existing["id"], file_path, stat, identity, fingerprint)
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
    upsert_file_record(db, version_id, file_path, stat, identity, fingerprint)
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
    project_path = os.path.join(os.path.abspath(root), project["relative_path"])
    # Mark disappeared sources first so a same-content file discovered on a
    # different volume can retain its Photo ID instead of becoming a duplicate.
    mark_missing_project_versions(db, project["id"])
    seen_paths = set()
    created_or_updated = 0
    for directory, directory_names, file_names in os.walk(project_path):
        directory_names[:] = [name for name in directory_names if not name.startswith(".") and name.casefold() not in {"thumbnails", "comparecache", "patches"}]
        for name in file_names:
            file_path = os.path.join(directory, name)
            if not media_type(file_path):
                continue
            try:
                if sync_media_file(db, project, file_path):
                    seen_paths.add(canonical_path(file_path).casefold())
                    created_or_updated += 1
            except (FileNotFoundError, PermissionError, OSError):
                continue
            if created_or_updated % 128 == 0:
                db.commit()
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
    photo_id = sync_media_file(db, project, file_path)
    db.commit()
    if not photo_id:
        raise ValueError("该文件不是可追踪的图片或视频")
    return {"success": True, **media_bundle(db, photo_id)}


def media_get_photo(db, payload: dict):
    bundle = media_bundle(db, payload["photoId"])
    if not bundle["photo"]:
        raise ValueError("素材版本记录不存在")
    return {"success": True, **bundle}


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
    timestamp = int(time.time() * 1000)
    next_number = db.execute("SELECT COALESCE(MAX(version_number), -1)+1 FROM versions WHERE photo_id=?", (photo_id,)).fetchone()[0]
    version_id = payload.get("versionId") or str(uuid.uuid4())
    db.execute("UPDATE versions SET is_current=0, updated_at=? WHERE photo_id=?", (timestamp, photo_id))
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
    upsert_file_record(db, version_id, file_path, stat, identity, fingerprint)
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
    fingerprint_matches = not row["file_fingerprint"] or row["file_fingerprint"] == fingerprint
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
    upsert_file_record(db, row["id"], file_path, stat, identity, fingerprint)
    db.commit()
    return {"success": True, **media_bundle(db, row["photo_id"])}


def media_delete_version(db, payload: dict):
    row = db.execute("SELECT * FROM versions WHERE id=? AND is_deleted=0", (payload["versionId"],)).fetchone()
    if row is None:
        raise ValueError("版本不存在")
    if row["version_number"] == 0:
        raise ValueError("原片版本 V0 受保护，不能删除")
    child = db.execute("SELECT id FROM versions WHERE parent_version_id=? AND is_deleted=0 LIMIT 1", (row["id"],)).fetchone()
    if child:
        raise ValueError("该版本仍有子版本，需先删除或改接子版本")
    timestamp = int(time.time() * 1000)
    db.execute("UPDATE versions SET is_deleted=1, is_current=0, updated_at=? WHERE id=?", (timestamp, row["id"]))
    db.execute("DELETE FROM file_records WHERE owner_type='version' AND owner_id=?", (row["id"],))
    if row["is_current"]:
        replacement = db.execute(
            "SELECT id FROM versions WHERE photo_id=? AND is_deleted=0 ORDER BY version_number DESC LIMIT 1", (row["photo_id"],)
        ).fetchone()
        if replacement:
            db.execute("UPDATE versions SET is_current=1 WHERE id=?", (replacement["id"],))
            db.execute("UPDATE photos SET current_version_id=?, updated_at=? WHERE id=?", (replacement["id"], timestamp, row["photo_id"]))
    db.commit()
    return {"success": True, **media_bundle(db, row["photo_id"])}


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
        "patchPath": row["patch_path"], "editedPatchPath": row["edited_patch_path"], "status": row["status"],
        "mergeMetrics": json.loads(row["merge_metrics_json"] or "{}"), "mergedVersionId": row["merged_version_id"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def team_patch_list(db, payload: dict):
    rows = db.execute(
        """SELECT * FROM team_patch_tasks WHERE photo_id=? AND is_deleted=0
           ORDER BY person_index, created_at""", (payload["photoId"],)
    ).fetchall()
    return {"success": True, "tasks": [serialize_team_patch(row) for row in rows]}


def team_patch_replace(db, payload: dict):
    timestamp = int(time.time() * 1000)
    db.execute(
        "UPDATE team_patch_tasks SET is_deleted=1, updated_at=? WHERE photo_id=? AND base_version_id=? AND is_deleted=0",
        (timestamp, payload["photoId"], payload["baseVersionId"]),
    )
    for task in payload.get("tasks", []):
        db.execute(
            """INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,assignee,
               detector,bbox_json,crop_json,patch_path,status,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (task["id"], payload["photoId"], payload["baseVersionId"], int(task["personIndex"]),
             task.get("personName") or f"人物 {task['personIndex']}", task.get("assignee") or "",
             task.get("detector") or "", json.dumps(task["bbox"], ensure_ascii=False),
             json.dumps(task["crop"], ensure_ascii=False), canonical_path(task["patchPath"]),
             task.get("status") or "exported", timestamp, timestamp),
        )
    db.commit()
    return team_patch_list(db, {"photoId": payload["photoId"]})


def team_patch_update(db, payload: dict):
    row = db.execute("SELECT * FROM team_patch_tasks WHERE id=? AND is_deleted=0", (payload["taskId"],)).fetchone()
    if row is None:
        raise ValueError("人物修图任务不存在")
    fields, values = [], []
    mapping = {"personName": "person_name", "assignee": "assignee", "status": "status", "mergedVersionId": "merged_version_id"}
    for source, target in mapping.items():
        if source in payload:
            fields.append(f"{target}=?")
            values.append(str(payload[source] or ""))
    if "editedPatchPath" in payload:
        fields.append("edited_patch_path=?")
        values.append(canonical_path(payload["editedPatchPath"]) if payload["editedPatchPath"] else None)
    if "mergeMetrics" in payload:
        fields.append("merge_metrics_json=?")
        values.append(json.dumps(payload["mergeMetrics"] or {}, ensure_ascii=False))
    fields.append("updated_at=?")
    values.append(int(time.time() * 1000))
    values.append(row["id"])
    db.execute(f"UPDATE team_patch_tasks SET {', '.join(fields)} WHERE id=?", values)
    db.commit()
    return team_patch_list(db, {"photoId": row["photo_id"]})


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
    elif action == "media_update_version":
        result = media_update_version(db, payload)
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
    elif action == "media_record_compare":
        result = media_record_compare(db, payload)
        db.close()
        return result
    elif action == "team_patch_list":
        result = team_patch_list(db, payload)
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
    else:
        raise ValueError(f"不支持的数据库操作：{action}")
    db.commit()
    db.close()
    return {"success": True}


def run(args_list=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", nargs="?", choices=("init", "add", "status", "rename", "delete", "media_sync_project", "media_get", "media_get_photo", "media_create_version", "media_update_version", "media_set_thumbnail", "media_relocate_version", "media_delete_version", "media_record_compare", "team_patch_list", "team_patch_replace", "team_patch_update"))
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
