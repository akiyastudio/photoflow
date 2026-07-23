"""Persistent SQLite index for the media thumbnail pipeline.

The process runs as a small JSON-lines service. Keeping SQLite in Python avoids
shipping a Node native addon whose ABI must match every Electron release.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path


THUMBNAIL_STATES = {"NOT_READY", "QUEUED", "GENERATING", "READY", "STALE", "FAILED", "MISSING"}
MEDIA_EXTENSIONS = {
    ".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image",
    ".webp": "image", ".bmp": "image", ".tif": "image", ".tiff": "image",
    ".heic": "image", ".avif": "image",
    ".mp4": "video", ".mov": "video", ".m4v": "video", ".webm": "video",
    ".avi": "video", ".mkv": "video",
    ".cr2": "raw", ".cr3": "raw", ".nef": "raw", ".arw": "raw",
    ".raf": "raw", ".orf": "raw", ".rw2": "raw", ".dng": "raw",
    ".rwl": "raw", ".3fr": "raw", ".fff": "raw", ".iiq": "raw",
    ".pef": "raw", ".srw": "raw",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def canonical(value: str) -> str:
    return os.path.normcase(os.path.abspath(value))


def source_hash(file_path: str) -> str:
    digest = hashlib.sha256()
    with open(file_path, "rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


class ThumbnailDatabase:
    def __init__(self, database_path: str, recover: bool = True):
        Path(database_path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(database_path, timeout=30)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                project_root TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                kind TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime_ms REAL NOT NULL,
                source_hash TEXT,
                version INTEGER NOT NULL DEFAULT 1,
                thumbnail_state TEXT NOT NULL DEFAULT 'NOT_READY',
                last_error TEXT,
                exists_on_disk INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS files_project_relative
                ON files(project_root, relative_path);
            CREATE INDEX IF NOT EXISTS files_state
                ON files(project_root, thumbnail_state);

            CREATE TABLE IF NOT EXISTS thumbnails (
                file_path TEXT NOT NULL,
                size_label TEXT NOT NULL,
                pixel_size INTEGER NOT NULL,
                thumbnail_path TEXT NOT NULL,
                thumbnail_size INTEGER NOT NULL,
                thumbnail_version INTEGER NOT NULL,
                source_mtime_ms REAL NOT NULL,
                source_hash TEXT,
                generated_at INTEGER NOT NULL,
                last_accessed_at INTEGER NOT NULL,
                PRIMARY KEY(file_path, size_label),
                FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS thumbnails_accessed
                ON thumbnails(last_accessed_at);
            """
        )
        # Jobs interrupted by a previous shutdown are safe to retry. Secondary
        # scan connections skip this so they never rewrite live worker state.
        if recover:
            self.connection.execute(
                "UPDATE files SET thumbnail_state='QUEUED', updated_at=? WHERE thumbnail_state='GENERATING'",
                (now_ms(),),
            )
        self.connection.commit()

    def close(self) -> None:
        self.connection.commit()
        self.connection.close()

    def _upsert_file(self, project_root: str, file_path: str, kind: str, stat: os.stat_result,
                     calculate_hash: bool = False) -> dict:
        project_root = canonical(project_root)
        file_path = canonical(file_path)
        current = self.connection.execute("SELECT * FROM files WHERE path=?", (file_path,)).fetchone()
        mtime_ms = stat.st_mtime_ns / 1_000_000
        changed = current is None or current["size"] != stat.st_size or current["mtime_ms"] != mtime_ms
        # Size/mtime are the cheap change detector. Hash only new or changed
        # sources (or records imported before hashes existed); unchanged media
        # must not be reread in full on every application launch.
        should_hash = calculate_hash and (changed or current is None or not current["source_hash"])
        # Never carry a hash across a size/mtime change. If a later duplicate
        # check needs it, that explicit operation can calculate a fresh value.
        digest = source_hash(file_path) if should_hash else (current["source_hash"] if current and not changed else None)
        if current is not None and current["source_hash"] and digest and digest != current["source_hash"]:
            changed = True
        timestamp = now_ms()
        inserted = False
        if current is None:
            state = "NOT_READY"
            version = 1
            cursor = self.connection.execute(
                """INSERT OR IGNORE INTO files
                   (path, project_root, relative_path, kind, size, mtime_ms, source_hash, version,
                    thumbnail_state, exists_on_disk, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (file_path, project_root, os.path.relpath(file_path, project_root), kind, stat.st_size,
                 mtime_ms, digest, version, state, timestamp, timestamp),
            )
            inserted = cursor.rowcount > 0
            if not inserted:
                # A foreground directory sync and the background project scan
                # may discover the same path concurrently. Treat the winner's
                # row as current instead of aborting the whole scan.
                current = self.connection.execute("SELECT * FROM files WHERE path=?", (file_path,)).fetchone()
                changed = current["size"] != stat.st_size or current["mtime_ms"] != mtime_ms
                if digest is None and not changed:
                    digest = current["source_hash"]
        if not inserted:
            state = "STALE" if changed else current["thumbnail_state"]
            if not changed and state == "MISSING":
                state = "NOT_READY"
            version = current["version"] + 1 if changed else current["version"]
            self.connection.execute(
                """UPDATE files SET project_root=?, relative_path=?, kind=?, size=?, mtime_ms=?,
                   source_hash=?, version=?, thumbnail_state=?, last_error=NULL, exists_on_disk=1,
                   updated_at=? WHERE path=?""",
                (project_root, os.path.relpath(file_path, project_root), kind, stat.st_size, mtime_ms,
                 digest, version, state, timestamp, file_path),
            )
            if changed:
                self.connection.execute("DELETE FROM thumbnails WHERE file_path=?", (file_path,))
        return {"path": file_path, "kind": kind, "state": state, "changed": changed,
                "size": stat.st_size, "mtimeMs": mtime_ms, "sourceHash": digest, "version": version}

    def sync_directory(self, project_root: str, directory: str) -> dict:
        project_root, directory = canonical(project_root), canonical(directory)
        seen = set()
        records = []
        with self.connection:
            for entry in os.scandir(directory):
                if not entry.is_file(follow_symlinks=False):
                    continue
                kind = MEDIA_EXTENSIONS.get(Path(entry.name).suffix.lower())
                if not kind:
                    continue
                record = self._upsert_file(project_root, entry.path, kind, entry.stat(follow_symlinks=False))
                records.append(record)
                seen.add(canonical(entry.path))
            prefix = directory + os.sep
            rows = self.connection.execute(
                "SELECT path FROM files WHERE project_root=? AND path LIKE ? AND exists_on_disk=1",
                (project_root, prefix + "%"),
            ).fetchall()
            timestamp = now_ms()
            for row in rows:
                relative_to_directory = os.path.relpath(row["path"], directory)
                if os.sep in relative_to_directory or row["path"] in seen:
                    continue
                self.connection.execute(
                    "UPDATE files SET thumbnail_state='MISSING', exists_on_disk=0, updated_at=? WHERE path=?",
                    (timestamp, row["path"]),
                )
        return {"records": records}

    def sync_project(self, project_root: str) -> dict:
        project_root = canonical(project_root)
        seen = set()
        pending = []
        changed_count = 0
        writes_since_commit = 0
        for directory, _directory_names, file_names in os.walk(project_root):
            for name in file_names:
                kind = MEDIA_EXTENSIONS.get(Path(name).suffix.lower())
                if not kind:
                    continue
                file_path = canonical(os.path.join(directory, name))
                try:
                    # Opening a project is an index refresh, not a duplicate
                    # verification pass. Size and mtime are sufficient here;
                    # reading every byte of multi-gigabyte videos made cold
                    # starts compete directly with visible previews.
                    record = self._upsert_file(project_root, file_path, kind, os.stat(file_path), calculate_hash=False)
                except (FileNotFoundError, PermissionError, OSError):
                    continue
                seen.add(file_path)
                changed_count += int(record["changed"])
                if record["state"] in {"NOT_READY", "STALE", "QUEUED", "FAILED"}:
                    pending.append(record)
                writes_since_commit += 1
                # Keep writer-lock windows short without forcing a disk commit
                # for every individual file in a large project.
                if writes_since_commit >= 256:
                    self.connection.commit()
                    writes_since_commit = 0
        self.connection.commit()
        timestamp = now_ms()
        with self.connection:
            if pending:
                self.connection.executemany(
                    "UPDATE files SET thumbnail_state='QUEUED', updated_at=? WHERE path=?",
                    [(timestamp, record["path"]) for record in pending],
                )
            for row in self.connection.execute(
                "SELECT path FROM files WHERE project_root=? AND exists_on_disk=1", (project_root,)
            ).fetchall():
                if row["path"] not in seen:
                    self.connection.execute(
                        "UPDATE files SET thumbnail_state='MISSING', exists_on_disk=0, updated_at=? WHERE path=?",
                        (timestamp, row["path"]),
                    )
        return {"fileCount": len(seen), "changedCount": changed_count, "pending": pending}

    def sync_paths(self, project_root: str, paths: list[str], calculate_hash: bool = False) -> dict:
        project_root = canonical(project_root)
        records = []
        with self.connection:
            for value in paths:
                file_path = canonical(value)
                kind = MEDIA_EXTENSIONS.get(Path(file_path).suffix.lower())
                if os.path.isfile(file_path) and kind:
                    records.append(self._upsert_file(project_root, file_path, kind, os.stat(file_path), calculate_hash=calculate_hash))
                else:
                    self.connection.execute(
                        "UPDATE files SET thumbnail_state='MISSING', exists_on_disk=0, updated_at=? WHERE path=?",
                        (now_ms(), file_path),
                    )
                    records.append({"path": file_path, "state": "MISSING", "changed": True})
        return {"records": records}

    def get_file(self, file_path: str) -> dict | None:
        row = self.connection.execute("SELECT * FROM files WHERE path=?", (canonical(file_path),)).fetchone()
        return dict(row) if row else None

    def set_state(self, file_path: str, state: str, error: str | None = None) -> dict:
        if state not in THUMBNAIL_STATES:
            raise ValueError(f"invalid thumbnail state: {state}")
        self.connection.execute(
            "UPDATE files SET thumbnail_state=?, last_error=?, updated_at=? WHERE path=?",
            (state, error, now_ms(), canonical(file_path)),
        )
        self.connection.commit()
        return {"state": state}

    def set_states(self, file_paths: list[str], state: str) -> dict:
        if state not in THUMBNAIL_STATES:
            raise ValueError(f"invalid thumbnail state: {state}")
        timestamp = now_ms()
        with self.connection:
            self.connection.executemany(
                "UPDATE files SET thumbnail_state=?, last_error=NULL, updated_at=? WHERE path=?",
                [(state, timestamp, canonical(file_path)) for file_path in file_paths],
            )
        return {"state": state, "count": len(file_paths)}

    def mark_ready(self, file_path: str, source_mtime_ms: float, source_digest: str | None,
                   thumbnails: list[dict]) -> dict:
        file_path = canonical(file_path)
        timestamp = now_ms()
        with self.connection:
            self.connection.execute(
                """UPDATE files SET thumbnail_state='READY', source_hash=COALESCE(?, source_hash),
                   last_error=NULL, exists_on_disk=1, updated_at=? WHERE path=?""",
                (source_digest, timestamp, file_path),
            )
            row = self.connection.execute("SELECT version FROM files WHERE path=?", (file_path,)).fetchone()
            # A queued thumbnail can finish after its project scan was cancelled
            # or its database service was recycled. In that case the parent
            # `files` row no longer exists and inserting a thumbnail would break
            # the foreign-key constraint. The next scan will register and queue
            # the file again, so safely defer this stale completion.
            if row is None:
                return {"state": "NOT_READY", "deferred": True}
            source_version = row["version"]
            for item in thumbnails:
                self.connection.execute(
                    """INSERT INTO thumbnails
                       (file_path, size_label, pixel_size, thumbnail_path, thumbnail_size,
                        thumbnail_version, source_mtime_ms, source_hash, generated_at, last_accessed_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(file_path, size_label) DO UPDATE SET
                         pixel_size=excluded.pixel_size, thumbnail_path=excluded.thumbnail_path,
                         thumbnail_size=excluded.thumbnail_size, thumbnail_version=excluded.thumbnail_version,
                         source_mtime_ms=excluded.source_mtime_ms, source_hash=excluded.source_hash,
                         generated_at=excluded.generated_at, last_accessed_at=excluded.last_accessed_at""",
                    (file_path, item["sizeLabel"], item["pixelSize"], canonical(item["path"]),
                     item["fileSize"], source_version, source_mtime_ms, source_digest, timestamp, timestamp),
                )
        return {"state": "READY"}

    def touch_thumbnail(self, file_path: str, size_label: str) -> dict:
        self.connection.execute(
            "UPDATE thumbnails SET last_accessed_at=? WHERE file_path=? AND size_label=?",
            (now_ms(), canonical(file_path), size_label),
        )
        self.connection.commit()
        return {"success": True}

    def invalidate_cache(self, deleted_paths: list[str] | None = None, before_ms: int | None = None) -> dict:
        with self.connection:
            if deleted_paths:
                normalized = [canonical(value) for value in deleted_paths]
                self.connection.executemany("DELETE FROM thumbnails WHERE thumbnail_path=?", [(value,) for value in normalized])
            elif before_ms is not None:
                self.connection.execute("DELETE FROM thumbnails WHERE generated_at < ?", (before_ms,))
            else:
                self.connection.execute("DELETE FROM thumbnails")
            self.connection.execute(
                """UPDATE files SET thumbnail_state='STALE', updated_at=?
                   WHERE thumbnail_state='READY' AND NOT EXISTS
                     (SELECT 1 FROM thumbnails WHERE thumbnails.file_path=files.path)""",
                (now_ms(),),
            )
        return {"success": True}

    def invalidate_sources(self, source_paths: list[str] | None = None) -> dict:
        normalized = list(dict.fromkeys(canonical(value) for value in (source_paths or []) if value))
        if not normalized:
            return {"success": True, "thumbnailPaths": [], "sourceCount": 0}
        placeholders = ",".join("?" for _ in normalized)
        thumbnail_rows = self.connection.execute(
            f"SELECT thumbnail_path FROM thumbnails WHERE file_path IN ({placeholders})",
            normalized,
        ).fetchall()
        with self.connection:
            self.connection.execute(f"DELETE FROM files WHERE path IN ({placeholders})", normalized)
        return {
            "success": True,
            "thumbnailPaths": list(dict.fromkeys(row["thumbnail_path"] for row in thumbnail_rows if row["thumbnail_path"])),
            "sourceCount": len(normalized),
        }

    def prune_missing_sources(self) -> dict:
        """Remove source-index rows already confirmed missing by a directory/project scan."""
        rows = self.connection.execute(
            """SELECT DISTINCT thumbnails.thumbnail_path
               FROM thumbnails JOIN files ON files.path=thumbnails.file_path
               WHERE files.exists_on_disk=0 OR files.thumbnail_state='MISSING'"""
        ).fetchall()
        count_row = self.connection.execute(
            "SELECT COUNT(*) AS count FROM files WHERE exists_on_disk=0 OR thumbnail_state='MISSING'"
        ).fetchone()
        with self.connection:
            self.connection.execute(
                "DELETE FROM files WHERE exists_on_disk=0 OR thumbnail_state='MISSING'"
            )
        return {
            "success": True,
            "thumbnailPaths": list(dict.fromkeys(row["thumbnail_path"] for row in rows if row["thumbnail_path"])),
            "sourceCount": int(count_row["count"] if count_row else 0),
        }


def run_server(database_path: str, recover: bool = True) -> None:
    # Keep the JSONL protocol independent of the Windows system code page;
    # project and media paths commonly contain Chinese characters.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    database = ThumbnailDatabase(database_path, recover=recover)
    try:
        for line in sys.stdin:
            request = None
            try:
                request = json.loads(line)
                request_id = request.get("id")
                operation = request["op"]
                args = request.get("args", {})
                handler = getattr(database, operation)
                result = handler(**args)
                response = {"id": request_id, "success": True, "result": result}
            except Exception as error:  # service errors must not terminate the index
                response = {"id": request.get("id") if isinstance(request, dict) else None,
                            "success": False, "error": str(error)}
            print(json.dumps(response, ensure_ascii=False), flush=True)
    finally:
        database.close()


def run(args_list=None):
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--db", required=True)
    parser.add_argument("--no-recover", action="store_true")
    args = parser.parse_args(args_list)
    if not args.server:
        raise SystemExit("thumbnail_db must run in server mode")
    run_server(args.db, recover=not args.no_recover)


if __name__ == "__main__":
    run()
