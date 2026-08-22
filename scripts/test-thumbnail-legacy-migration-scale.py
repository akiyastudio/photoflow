from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from thumbnail_db import ThumbnailDatabase  # noqa: E402


MIGRATION_KEY = "thumbnail-cache-migration-v2"
TARGET_INDEXES = {
    "files_project_relative", "files_state", "files_missing", "thumbnails_accessed",
    "thumbnails_path", "thumbnails_cache_access", "thumbnail_publish_receipts_file",
    "thumbnail_orphan_delete_retries_root", "thumbnail_orphan_scan_entries_page",
    "thumbnail_orphan_scan_entries_cleanup", "thumbnail_orphan_scan_state_cleanup",
}


def create_legacy_database(database_path: Path, cache_root: Path) -> None:
    connection = sqlite3.connect(database_path)
    try:
        connection.executescript(
            """
            PRAGMA user_version=1;
            CREATE TABLE files (
                path TEXT PRIMARY KEY, project_root TEXT NOT NULL, relative_path TEXT NOT NULL,
                kind TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, source_hash TEXT,
                version INTEGER NOT NULL DEFAULT 1, thumbnail_state TEXT NOT NULL DEFAULT 'NOT_READY',
                last_error TEXT, exists_on_disk INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE thumbnails (
                file_path TEXT NOT NULL, size_label TEXT NOT NULL, pixel_size INTEGER NOT NULL,
                thumbnail_path TEXT NOT NULL, thumbnail_size INTEGER NOT NULL,
                thumbnail_version INTEGER NOT NULL, source_mtime_ms REAL NOT NULL, source_hash TEXT,
                generated_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL,
                PRIMARY KEY(file_path,size_label),
                FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
            );
            CREATE TABLE project_indexes (
                project_root TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER NOT NULL,
                completed_at INTEGER
            );
            CREATE TABLE maintenance_state (key TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
            """
        )
        source_path = str((database_path.parent / "source.jpg").resolve())
        project_root = str(database_path.parent.resolve())
        connection.execute(
            "INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (source_path, project_root, "source.jpg", "image", 6, 100.0, None, 1, "READY", None, 1, 100, 100),
        )
        connection.executemany(
            "INSERT INTO thumbnails VALUES(?,?,?,?,?,?,?,?,?,?)",
            (
                (source_path, f"legacy-{index}", 320, str((cache_root / f"{index:064x}.jpg").resolve()),
                 10, 1, 100.0, None, 100, 100)
                for index in range(100_000)
            ),
        )
        connection.commit()
    finally:
        connection.close()


def crash_worker(database_path: Path, calls: int, save_last: bool, exit_code: int) -> None:
    database = ThumbnailDatabase(str(database_path))
    cursor = database.maintenance_state_get(MIGRATION_KEY)["cursor"]
    for index in range(calls):
        result = database.run_thumbnail_cache_migration(MIGRATION_KEY, cursor, 512)
        cursor = result["cursor"]
        if save_last or index + 1 < calls:
            database.maintenance_state_save(MIGRATION_KEY, cursor)
    os._exit(exit_code)


def run_parent() -> None:
    with tempfile.TemporaryDirectory(prefix="photoflow-legacy-migration-") as directory:
        root = Path(directory)
        database_path = root / "thumbnail.sqlite3"
        cache_root = root / "cache"
        cache_root.mkdir()
        (root / "source.jpg").write_bytes(b"source")
        create_legacy_database(database_path, cache_root)

        legacy = sqlite3.connect(database_path)
        try:
            columns = {row[1] for row in legacy.execute("PRAGMA table_info(thumbnails)")}
            tables = {row[0] for row in legacy.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert "cache_epoch" not in columns and "cache_root" not in columns
            assert "thumbnail_publish_receipts" not in tables
        finally:
            legacy.close()

        random_batch_calls = random.Random(85_000).randint(7, 31)
        interrupted = subprocess.run(
            [sys.executable, __file__, "--worker", str(database_path), "--calls", str(random_batch_calls),
             "--save-last", "--exit-code", "86"], check=False,
        )
        assert interrupted.returncode == 86, "the data-phase worker must terminate without graceful SQLite close"

        database = ThumbnailDatabase(str(database_path))
        try:
            cursor = database.maintenance_state_get(MIGRATION_KEY)["cursor"]
            assert cursor.get("phase") == "backfill" and cursor.get("afterRowId", 0) > 0
            while cursor.get("phase") != "indexes" or cursor.get("indexOffset", 0) < 5:
                result = database.run_thumbnail_cache_migration(MIGRATION_KEY, cursor, 512)
                cursor = result["cursor"]
                database.maintenance_state_save(MIGRATION_KEY, cursor)
            assert database.maintenance_state_get(MIGRATION_KEY)["completed"] is False
        finally:
            database.close()

        cursor_before_index_crash = dict(cursor)
        interrupted_index = subprocess.run(
            [sys.executable, __file__, "--worker", str(database_path), "--calls", "1", "--exit-code", "87"],
            check=False,
        )
        assert interrupted_index.returncode == 87, "the index worker must terminate after DDL commit and before cursor marker"

        database = ThumbnailDatabase(str(database_path))
        try:
            cursor = database.maintenance_state_get(MIGRATION_KEY)["cursor"]
            assert cursor == cursor_before_index_crash, "the unsaved post-index cursor must not appear committed"
            assert database.maintenance_state_get(MIGRATION_KEY)["completed"] is False
            while True:
                result = database.run_thumbnail_cache_migration(MIGRATION_KEY, cursor, 512)
                cursor = result["cursor"]
                database.maintenance_state_save(MIGRATION_KEY, cursor)
                if result["done"]:
                    break
            assert database.maintenance_state_get(MIGRATION_KEY)["completed"] is False, \
                "migration completion marker must not be written before every phase succeeds"
            assert database.connection.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0] == 100_000
            assert database.connection.execute("SELECT COUNT(*) FROM thumbnails WHERE cache_root='' ").fetchone()[0] == 0
            expected_root = os.path.normcase(os.path.abspath(cache_root))
            assert database.connection.execute("SELECT COUNT(*) FROM thumbnails WHERE cache_root<>?", (expected_root,)).fetchone()[0] == 0
            tables = {row["name"] for row in database.connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            indexes = {row["name"] for row in database.connection.execute("SELECT name FROM sqlite_master WHERE type='index'")}
            assert "thumbnail_publish_receipts" in tables
            assert TARGET_INDEXES <= indexes
            assert int(database.connection.execute("PRAGMA user_version").fetchone()[0]) == 2
            assert database.check_integrity()["result"] == "ok"
            database.maintenance_state_complete(MIGRATION_KEY, cursor)
            assert database.maintenance_state_get(MIGRATION_KEY)["completed"] is True
        finally:
            database.close()
        print(
            "100,000 legacy migration evidence:",
            f"data_interrupt_after_batches={random_batch_calls}",
            "index_interrupt=after-DDL-before-marker",
            "rows=100000 user_version=2 quick_check=ok",
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker")
    parser.add_argument("--calls", type=int, default=1)
    parser.add_argument("--save-last", action="store_true")
    parser.add_argument("--exit-code", type=int, default=86)
    args = parser.parse_args()
    if args.worker:
        crash_worker(Path(args.worker), args.calls, args.save_last, args.exit_code)
    else:
        run_parent()


if __name__ == "__main__":
    main()
