from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db  # noqa: E402


def main():
    with tempfile.TemporaryDirectory(prefix="photoflow-purge-journal-") as temporary:
        workspace = Path(temporary) / "workspace"
        project_path = workspace / "Project"
        project_path.mkdir(parents=True)
        database = Path(temporary) / "workspace.sqlite3"
        db = workspace_db.connect(str(workspace), str(database), include_domains=True)
        now = int(time.time() * 1000)
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,is_deleted,created_at,updated_at) VALUES(?,?,?,?,1,?,?)",
            ("project", "Project", "未分类", "Project", now, now),
        )
        db.execute(
            """INSERT INTO photos(
                 id,project_id,media_type,original_name,display_name,current_version_id,
                 original_file_path,created_at,updated_at)
               VALUES('photo','project','image','photo.jpg','photo','version',?, ?, ?)""",
            (str(project_path / "photo.jpg"), now, now),
        )
        db.execute(
            """INSERT INTO versions(
                 id,photo_id,version_number,version_name,file_path,file_path_key,created_at,updated_at)
               VALUES('version','photo',0,'原片',?,?,?,?)""",
            (str(project_path / "photo.jpg"), str(project_path / "photo.jpg").casefold(), now, now),
        )
        db.execute(
            """INSERT INTO file_records(
                 id,owner_type,owner_id,current_path,file_name,extension,file_size,created_at,updated_at)
               VALUES('record','version','version',?,'photo.jpg','.jpg',1,?,?)""",
            (str(project_path / "photo.jpg"), now, now),
        )
        db.commit()

        project = db.execute("SELECT * FROM projects WHERE id='project'").fetchone()
        plan = workspace_db.project_cleanup_plan(db, project, {"undoRecords": []})
        assert plan["photoIds"] == ["photo"]
        assert db.execute("SELECT COUNT(*) FROM file_records WHERE id='record'").fetchone()[0] == 1
        assert not db.in_transaction, "cleanup planning must remain a pure read"

        original_prepare = workspace_db._prepare_durable_purge
        workspace_db._prepare_durable_purge = lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("injected failure before durable purge journal")
        )
        try:
            try:
                workspace_db.purge_deleted_project(db, {"projectId": "project", "undoRecords": []})
                raise AssertionError("injected pre-journal failure must surface")
            except RuntimeError as error:
                assert "before durable purge journal" in str(error)
        finally:
            workspace_db._prepare_durable_purge = original_prepare
        assert workspace_db._meta_value(db, "purge_journal_v1") is None
        assert db.execute("SELECT COUNT(*) FROM file_records WHERE id='record'").fetchone()[0] == 1

        retention = workspace_db.MEDIA_RECEIPT_RETENTION_MS
        recent = workspace_db.MEDIA_RECEIPT_RECENT_MS
        current = 10 * retention
        for index in range(workspace_db.PURGE_RECEIPT_SOFT_LIMIT + 3):
            completed = current - recent - 1 if index < 3 else current
            workspace_db._set_meta(db, f"purge_receipt:test-{index}", json.dumps({"completedAt": completed}))
        workspace_db._set_meta(db, "purge_receipt:expired", json.dumps({"completedAt": current - retention - 1}))
        workspace_db._set_meta(db, "purge_receipt:malformed", "not-json")
        removed = workspace_db._prune_purge_receipts(db, current)
        assert removed == 4, removed
        assert workspace_db._meta_value(db, "purge_receipt:malformed") == "not-json", "malformed idempotency evidence fails closed"
        assert workspace_db._meta_value(db, f"purge_receipt:test-{workspace_db.PURGE_RECEIPT_SOFT_LIMIT + 2}") is not None

        for index in range(workspace_db.SYNC_COMPLETION_SOFT_LIMIT + 3):
            snapshot_id = f"00000000-0000-0000-0000-{index:012d}"
            completed = current - recent - 1 if index < 3 else current
            workspace_db._set_meta(db, f"media_sync:{snapshot_id}:completed-at", str(completed))
            workspace_db._set_meta(db, f"media_sync:{snapshot_id}:completed-batches", "{}")
        assert workspace_db._prune_legacy_sync_completions(db, current) == 6
        assert workspace_db._meta_value(db, "media_sync:00000000-0000-0000-0000-000000000000:completed-at") is None
        assert workspace_db._meta_value(
            db, f"media_sync:00000000-0000-0000-0000-{workspace_db.SYNC_COMPLETION_SOFT_LIMIT + 2:012d}:completed-at"
        ) is not None

        db.executemany(
            """INSERT INTO media_incremental_snapshots(
                 snapshot_id,project_id,state,manifest_hash,result_json,created_at,finalized_at)
               VALUES(?,?,'finalized','hash','{}',?,?)""",
            [(f"10000000-0000-0000-0000-{index:012d}", "project", completed, completed)
             for index in range(workspace_db.SYNC_COMPLETION_SOFT_LIMIT + 3)
             for completed in [current - recent - 1 if index < 3 else current]],
        )
        assert workspace_db._prune_incremental_sync_completions(db, current) == 3
        stale_incomplete = "20000000-0000-0000-0000-000000000001"
        recent_incomplete = "20000000-0000-0000-0000-000000000002"
        db.executemany(
            """INSERT INTO media_incremental_snapshots(
                 snapshot_id,project_id,state,manifest_hash,result_json,created_at,finalized_at)
               VALUES(?,?,'preparing','',NULL,?,NULL)""",
            [(stale_incomplete, "project", current - workspace_db.MEDIA_INCREMENTAL_INCOMPLETE_RETENTION_MS - 1),
             (recent_incomplete, "project", current)],
        )
        db.execute(
            """INSERT INTO media_incremental_snapshot_files(
                 snapshot_id,ordinal,file_path,file_path_key,file_size,modified_at)
               VALUES(?,0,'stale.jpg','stale.jpg',1,1)""", (stale_incomplete,),
        )
        workspace_db._cleanup_incremental_snapshots(db, current)
        assert workspace_db._incremental_snapshot_row(db, stale_incomplete) is None
        assert workspace_db._incremental_snapshot_row(db, recent_incomplete) is not None, "recent active manifests must not be collected"
        interrupted_ids = [f"21000000-0000-0000-0000-{index:012d}" for index in range(40)]
        db.executemany(
            """INSERT INTO media_incremental_snapshots(
                 snapshot_id,project_id,state,manifest_hash,result_json,created_at,finalized_at)
               VALUES(?,?,'preparing','',NULL,?,NULL)""",
            [(snapshot_id, "project", current + index + 1) for index, snapshot_id in enumerate(interrupted_ids)],
        )
        active_id = interrupted_ids[-1]
        workspace_db._cleanup_incremental_snapshots(db, current + 100, active_id, "project")
        retained_incomplete = db.execute(
            "SELECT COUNT(*) FROM media_incremental_snapshots WHERE project_id='project' AND state!='finalized'"
        ).fetchone()[0]
        assert retained_incomplete == len(interrupted_ids) + 1, "cleanup must not delete unexpired concurrent scans"
        assert workspace_db._incremental_snapshot_row(db, active_id) is not None, "the caller's active manifest is always retained"
        try:
            workspace_db._assert_incremental_snapshot_capacity(
                db, "project", "21999999-0000-0000-0000-000000000999",
            )
            raise AssertionError("new scans must be rejected at the incomplete hard limit")
        except RuntimeError as error:
            assert getattr(error, "code", "") == "MEDIA_SYNC_SCAN_BUSY"
        db.rollback()
        db.close()

        concurrent_workspace = Path(temporary) / "concurrent-workspace"
        concurrent_project = concurrent_workspace / "Project"
        concurrent_project.mkdir(parents=True)
        concurrent_database = Path(temporary) / "concurrent.sqlite3"
        seed = workspace_db.connect(str(concurrent_workspace), str(concurrent_database), include_domains=True)
        seed.execute(
            "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('project','Project','后期中','Project',1,1)"
        )
        seed.commit(); seed.close()
        barrier = threading.Barrier(40)
        outcomes = []
        outcome_lock = threading.Lock()

        def run_scan(index):
            snapshot_id = f"22000000-0000-0000-0000-{index:012d}"
            barrier.wait()
            connection = sqlite3.connect(concurrent_database, timeout=30)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=30000")
            connection.execute("ATTACH DATABASE ? AS media", (
                workspace_db.database_path_for_workspace_database(str(concurrent_database), "media"),
            ))
            connection.execute("ATTACH DATABASE ? AS versioning", (
                workspace_db.database_path_for_workspace_database(str(concurrent_database), "versioning"),
            ))
            try:
                workspace_db.media_sync_prepare(str(concurrent_workspace), connection, {
                    "projectName": "Project", "externalRoots": [], "paged": True,
                    "snapshotId": snapshot_id, "pageToken": "0", "pageSize": 64,
                })
                outcome = "success"
            except RuntimeError as error:
                outcome = getattr(error, "code", "error")
            finally:
                connection.close()
            with outcome_lock:
                outcomes.append(outcome)

        workers = [threading.Thread(target=run_scan, args=(index,)) for index in range(40)]
        for worker in workers: worker.start()
        for worker in workers: worker.join(timeout=60)
        assert all(not worker.is_alive() for worker in workers)
        assert outcomes.count("success") == workspace_db.MEDIA_INCREMENTAL_INCOMPLETE_SOFT_LIMIT, outcomes
        assert outcomes.count("MEDIA_SYNC_SCAN_BUSY") == 40 - workspace_db.MEDIA_INCREMENTAL_INCOMPLETE_SOFT_LIMIT
        verify_concurrent = workspace_db.connect(str(concurrent_workspace), str(concurrent_database), include_domains=True)
        assert verify_concurrent.execute(
            "SELECT COUNT(*) FROM media_incremental_snapshots WHERE project_id='project' AND state='prepared'"
        ).fetchone()[0] == workspace_db.MEDIA_INCREMENTAL_INCOMPLETE_SOFT_LIMIT
        verify_concurrent.close()

    print("purge journal ordering and receipt retention tests passed")


if __name__ == "__main__":
    main()
