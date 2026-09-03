import os
import sqlite3
import sys
import tempfile
import time
import uuid
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "python"))

import workspace_db  # noqa: E402
from database_error_codes import error_response  # noqa: E402


busy_error = sqlite3.OperationalError("本地化后的错误消息")
busy_error.sqlite_errorcode = sqlite3.SQLITE_BUSY
assert error_response("request", busy_error)["code"] == "SQLITE_BUSY", \
    "the worker protocol must expose SQLite status without parsing localized text"


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary) / "workspace"
    root.mkdir()
    database = Path(temporary) / "workspace.sqlite3"
    project_path = root / "Project"
    project_path.mkdir()

    # Finish one-time domain extraction before the test deliberately holds the
    # catalog writer lock; the assertion below covers current-schema opens, not
    # first-run migration work.
    initialized = workspace_db.connect(str(root), str(database), include_domains=True)
    now = int(time.time() * 1000)
    initialized.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        (str(uuid.uuid4()), "Project", "active", "Project", now, now),
    )
    initialized.commit()
    initialized.close()

    legacy = sqlite3.connect(database)
    assert legacy.execute("PRAGMA journal_mode=DELETE").fetchone()[0].lower() == "delete"
    legacy.close()
    snapshot = workspace_db.load(str(root), str(database))
    assert snapshot["success"]
    probe = sqlite3.connect(database)
    assert probe.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal", \
        "workspace startup must migrate a legacy database to WAL before the version tree is opened"
    probe.close()

    holder = sqlite3.connect(database, timeout=1)
    holder.execute("PRAGMA journal_mode=WAL")
    holder.execute("BEGIN IMMEDIATE")
    holder.execute("UPDATE projects SET updated_at=updated_at WHERE name='Project'")

    started = time.monotonic()
    operational = workspace_db.connect(str(root), str(database))
    elapsed = time.monotonic() - started
    assert elapsed < 2, f"current-schema connection waited for a writer lock: {elapsed:.2f}s"
    assert operational.total_changes == 0, "current-schema connection performed an unexpected write"
    operational.close()

    layout = workspace_db.mutate(str(root), str(database), "version_tree_layout_get", {
        "projectName": "Project",
        "scopeKey": "",
    })
    assert layout["success"] and layout["positions"] == []

    progress = workspace_db.mutate(str(root), str(database), "progress_snapshot", {
        "projectName": "Project",
    })
    assert progress["success"] and progress["progressFolders"] == []

    holder.rollback()
    holder.close()

    original_connect_read_only = workspace_db.connect_read_only
    original_connect = workspace_db.connect

    def require_writer(*_args, **_kwargs):
        raise workspace_db.DatabaseWriteRequired("test initialization required")

    def record_writable_fallback(*_args, **_kwargs):
        nonlocal_marker[0] = True
        raise RuntimeError("writable fallback reached")

    nonlocal_marker = [False]
    workspace_db.connect_read_only = require_writer
    workspace_db.connect = record_writable_fallback
    try:
        try:
            workspace_db.mutate(str(root), str(database), "version_tree_layout_get", {
                "projectName": "Project", "scopeKey": "",
            })
            raise AssertionError("an audited read must not silently fall back to a writable connection")
        except workspace_db.DatabaseWriteRequired:
            pass
        assert not nonlocal_marker[0], "the first read-lease attempt must not open a writable connection"
        try:
            workspace_db.mutate(str(root), str(database), "version_tree_layout_get", {
                "projectName": "Project", "scopeKey": "", "_coordinatorWriteFallback": True,
            })
        except RuntimeError as error:
            assert str(error) == "writable fallback reached"
        else:
            raise AssertionError("the promoted writer attempt did not reach writable initialization")
        assert nonlocal_marker[0], "only the writer-lease retry may open a writable connection"
    finally:
        workspace_db.connect_read_only = original_connect_read_only
        workspace_db.connect = original_connect

    original_meta_value = workspace_db._meta_value

    class ReadCandidate:
        def close(self):
            pass

    nonlocal_marker[0] = False
    workspace_db.connect_read_only = lambda *_args, **_kwargs: ReadCandidate()
    workspace_db._meta_value = lambda *_args, **_kwargs: "pending-purge"
    workspace_db.connect = record_writable_fallback
    try:
        try:
            workspace_db.mutate(str(root), str(database), "progress_snapshot", {"projectName": "Project"})
            raise AssertionError("a pending purge journal must promote an audited read before recovery")
        except workspace_db.DatabaseWriteRequired:
            pass
        assert not nonlocal_marker[0], "purge recovery must not run while the coordinator still holds a read lease"
    finally:
        workspace_db.connect_read_only = original_connect_read_only
        workspace_db._meta_value = original_meta_value
        workspace_db.connect = original_connect

print("database locking regression tests passed")
