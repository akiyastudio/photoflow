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

print("database locking regression tests passed")
