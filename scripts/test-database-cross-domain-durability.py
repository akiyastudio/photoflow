from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db  # noqa: E402


class InjectedCrash(BaseException):
    pass


def test_batch_rename_live_journal(root: Path):
    workspace = root / "batch-workspace"
    folder = workspace / "Project" / "Progress"
    folder.mkdir(parents=True)
    source = folder / "source.jpg"
    target = folder / "target.jpg"
    source.write_bytes(b"batch-rename")
    database = root / "batch.sqlite3"
    db = workspace_db.connect(str(workspace), str(database), include_domains=True)
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.execute(
        """INSERT INTO photos(
             id,project_id,media_type,original_name,display_name,current_version_id,
             original_file_path,created_at,updated_at)
           VALUES('photo','project','image','source.jpg','source','version',?,?,?)""",
        (str(source), now, now),
    )
    stat = source.stat()
    fingerprint = workspace_db.quick_fingerprint(str(source), stat)
    db.execute(
        """INSERT INTO versions(
             id,photo_id,version_number,version_name,file_path,file_path_key,file_fingerprint,
             file_size,file_modified_at,created_at,updated_at)
           VALUES('version','photo',1,'Progress',?,?,?,?,?,?,?)""",
        (str(source), str(source).casefold(), fingerprint, stat.st_size,
         int(stat.st_mtime_ns / 1_000_000), now, now),
    )
    db.execute(
        """INSERT INTO file_records(
             id,owner_type,owner_id,current_path,file_name,extension,file_size,modified_at,
             quick_hash,created_at,updated_at)
           VALUES('record','version','version',?,'source.jpg','.jpg',?,?,?, ?,?)""",
        (str(source), stat.st_size, int(stat.st_mtime_ns / 1_000_000), fingerprint, now, now),
    )
    db.execute(
        """INSERT INTO version_batches(
             id,project_id,sequence,display_name,source_folder_path,source_folder_path_key,
             status,created_at,updated_at)
           VALUES('batch','project',1,'Progress',?,?,'applying',?,?)""",
        (str(folder), str(folder).casefold(), now, now),
    )
    db.execute(
        """INSERT INTO batch_items(
             id,batch_id,photo_id,version_id,source_name,source_path,source_path_key,
             source_fingerprint,created_at,updated_at)
           VALUES('item','batch','photo','version','source.jpg',?,?,?, ?,?)""",
        (str(source), str(source).casefold(), fingerprint, now, now),
    )
    db.execute(
        """INSERT INTO batch_file_operations(
             id,batch_id,operation_type,source_path,target_path,status,attempt_count,error,created_at,updated_at)
           VALUES('operation','batch','rename',?,?,'pending',0,'',?,?)""",
        (str(source), str(target), now, now),
    )
    db.commit()
    assert "batch_commit_compare" not in workspace_db.MEDIA_DURABLE_ACTIONS, "filesystem batch commits must not execute rename inside generic staged mutations"
    assert "batch_retry_operations" in workspace_db.BATCH_CROSS_DOMAIN_DURABLE_ACTIONS
    db.close()
    original_rename = workspace_db.os.rename

    def crash_after_rename(old, new):
        original_rename(old, new)
        raise InjectedCrash()

    workspace_db.os.rename = crash_after_rename
    try:
        workspace_db.mutate(
            str(workspace), str(database), "batch_retry_operations", {"batchId": "batch"}, "stable-batch-operation",
        )
        raise AssertionError("injected crash was ignored")
    except InjectedCrash:
        pass
    finally:
        workspace_db.os.rename = original_rename
    assert not source.exists() and target.exists()
    interrupted = workspace_db._read_media_operation_journal(str(database))
    assert interrupted and interrupted["state"] == "filesystem"
    # Startup alone must roll forward filesystem evidence, staged DB finalize,
    # and media/versioning/core publication without resending the request.
    replay = workspace_db.connect(str(workspace), str(database), include_domains=True)
    assert replay.execute("SELECT status FROM batch_file_operations WHERE id='operation'").fetchone()[0] == "succeeded"
    assert replay.execute("SELECT source_path FROM batch_items WHERE id='item'").fetchone()[0] == str(target)
    replay.close()
    result = workspace_db.mutate(
        str(workspace), str(database), "batch_retry_operations", {"batchId": "batch"}, "stable-batch-operation",
    )
    assert not result["repairRequired"] and result["renamedCount"] == 1
    try:
        workspace_db.mutate(
            str(workspace), str(database), "batch_retry_operations", {"batchId": "batch", "changed": True},
            "stable-batch-operation",
        )
        raise AssertionError("same operationId with a different digest must fail closed")
    except ValueError as error:
        assert "digest mismatch" in str(error)

    conflict_source = folder / "conflict-source.jpg"
    conflict_target = folder / "conflict-target.jpg"
    conflict_source.write_bytes(b"source")
    conflict_target.write_bytes(b"occupied")
    conflict_db = workspace_db.connect(str(workspace), str(database), include_domains=True)
    conflict_db.execute(
        """INSERT INTO batch_file_operations(
             id,batch_id,operation_type,source_path,target_path,status,attempt_count,error,created_at,updated_at)
           VALUES('conflict-operation','batch','rename',?,?,'pending',0,'',?,?)""",
        (str(conflict_source), str(conflict_target), now + 1, now + 1),
    )
    conflict_db.commit(); conflict_db.close()
    conflict_result = workspace_db.mutate(
        str(workspace), str(database), "batch_retry_operations", {"batchId": "batch"}, "conflict-batch-operation",
    )
    assert conflict_result["repairRequired"] and conflict_result["renameErrors"]
    assert conflict_source.read_bytes() == b"source" and conflict_target.read_bytes() == b"occupied"
    assert workspace_db._read_media_operation_journal(str(database)) is None, "repair results must still publish and clear the journal"
    cleanup_conflict = workspace_db.connect(str(workspace), str(database), include_domains=True)
    cleanup_conflict.execute("DELETE FROM batch_file_operations WHERE id='conflict-operation'")
    cleanup_conflict.commit(); cleanup_conflict.close()

    def add_pending(label):
        pending_source = folder / f"{label}-source.jpg"
        pending_target = folder / f"{label}-target.jpg"
        pending_source.write_bytes(label.encode())
        pending_db = workspace_db.connect(str(workspace), str(database), include_domains=True)
        stamp = now + 100 + len(label)
        photo_id, version_id, item_id, operation_id = (
            f"{label}-photo", f"{label}-version", f"{label}-item", f"{label}-operation",
        )
        pending_db.execute(
            """INSERT INTO photos(id,project_id,media_type,original_name,display_name,current_version_id,
                 original_file_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)""",
            (photo_id, "project", "image", pending_source.name, label, version_id, str(pending_source), stamp, stamp),
        )
        pending_stat = pending_source.stat()
        pending_fingerprint = workspace_db.quick_fingerprint(str(pending_source), pending_stat)
        pending_db.execute(
            """INSERT INTO versions(id,photo_id,version_number,version_name,file_path,file_path_key,
                 file_fingerprint,file_size,file_modified_at,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (version_id, photo_id, 1, label, str(pending_source), str(pending_source).casefold(),
             pending_fingerprint, pending_stat.st_size, int(pending_stat.st_mtime_ns / 1_000_000), stamp, stamp),
        )
        pending_db.execute(
            """INSERT INTO file_records(id,owner_type,owner_id,current_path,file_name,extension,file_size,
                 modified_at,quick_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (f"{label}-record", "version", version_id, str(pending_source), pending_source.name, ".jpg",
             pending_stat.st_size, int(pending_stat.st_mtime_ns / 1_000_000), pending_fingerprint, stamp, stamp),
        )
        pending_db.execute(
            """INSERT INTO batch_items(id,batch_id,photo_id,version_id,source_name,source_path,source_path_key,
                 source_fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (item_id, "batch", photo_id, version_id, pending_source.name, str(pending_source),
             str(pending_source).casefold(), pending_fingerprint, stamp, stamp),
        )
        pending_db.execute(
            """INSERT INTO batch_file_operations(id,batch_id,operation_type,source_path,target_path,status,
                 attempt_count,error,created_at,updated_at) VALUES(?,?,'rename',?,?,'pending',0,'',?,?)""",
            (operation_id, "batch", str(pending_source), str(pending_target), stamp, stamp),
        )
        pending_db.commit(); pending_db.close()
        return operation_id, pending_source, pending_target

    crash_points = [("stage-finalize", "finalize", 0), ("media-publish", "publish", 1),
                    ("versioning-publish", "publish", 2), ("core-publish", "publish", 3)]
    for label, kind, ordinal in crash_points:
        operation_row_id, pending_source, pending_target = add_pending(label)
        original_finalize = workspace_db._finalize_staged_batch_operation
        original_publish = workspace_db._publish_sqlite_stage
        calls = 0
        if kind == "finalize":
            def crash_finalize(journal):
                original_finalize(journal)
                raise InjectedCrash()
            workspace_db._finalize_staged_batch_operation = crash_finalize
        else:
            def crash_publish(source_path, destination_path):
                nonlocal calls
                calls += 1
                original_publish(source_path, destination_path)
                if calls == ordinal:
                    raise InjectedCrash()
            workspace_db._publish_sqlite_stage = crash_publish
        try:
            workspace_db.mutate(
                str(workspace), str(database), "batch_retry_operations", {"batchId": "batch"}, f"{label}-request",
            )
            raise AssertionError(f"{label} crash was ignored")
        except InjectedCrash:
            pass
        finally:
            workspace_db._finalize_staged_batch_operation = original_finalize
            workspace_db._publish_sqlite_stage = original_publish
        restarted = workspace_db.connect(str(workspace), str(database), include_domains=True)
        assert pending_target.exists() and not pending_source.exists()
        assert restarted.execute(
            "SELECT status FROM batch_file_operations WHERE id=?", (operation_row_id,),
        ).fetchone()[0] == "succeeded"
        restarted.close()


def test_full_sync_starting_baseline(root: Path):
    workspace = root / "sync-workspace"
    project_path = workspace / "Project"
    project_path.mkdir(parents=True)
    database = root / "sync.sqlite3"
    db = workspace_db.connect(str(workspace), str(database), include_domains=True)
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.execute(
        """INSERT INTO photos(id,project_id,media_type,original_name,display_name,current_version_id,
             original_file_path,created_at,updated_at)
           VALUES('old-photo','project','image','old.jpg','old','old-version',?,?,?)""",
        (str(project_path / "old.jpg"), now, now),
    )
    db.execute(
        """INSERT INTO versions(id,photo_id,version_number,version_name,file_path,file_path_key,
             file_missing,created_at,updated_at)
           VALUES('old-version','old-photo',1,'old',?,?,0,?,?)""",
        (str(project_path / "old.jpg"), str(project_path / "old.jpg").casefold(), now, now),
    )
    db.commit()

    original_walk = workspace_db.os.walk
    injected = False

    def injecting_walk(path):
        nonlocal injected
        if not injected:
            injected = True
            concurrent = workspace_db.connect(str(workspace), str(database), include_domains=True)
            created = now + 1
            concurrent.execute(
                """INSERT INTO photos(id,project_id,media_type,original_name,display_name,current_version_id,
                     original_file_path,created_at,updated_at)
                   VALUES('new-photo','project','image','new.jpg','new','new-version',?,?,?)""",
                (str(project_path / "new.jpg"), created, created),
            )
            concurrent.execute(
                """INSERT INTO versions(id,photo_id,version_number,version_name,file_path,file_path_key,
                     file_missing,created_at,updated_at)
                   VALUES('new-version','new-photo',1,'new',?,?,0,?,?)""",
                (str(project_path / "new.jpg"), str(project_path / "new.jpg").casefold(), created, created),
            )
            concurrent.commit(); concurrent.close()
        yield from original_walk(path)

    workspace_db.os.walk = injecting_walk
    try:
        prepared = workspace_db.media_sync_prepare(str(workspace), db, {
            "projectName": "Project", "externalRoots": [], "paged": True,
            "snapshotId": "30000000-0000-0000-0000-000000000001", "pageToken": "0", "pageSize": 64,
        })
    finally:
        workspace_db.os.walk = original_walk
    baseline = {row[0] for row in db.execute(
        "SELECT version_id FROM media_incremental_snapshot_baseline WHERE snapshot_id=?", (prepared["snapshotId"],)
    )}
    assert baseline == {"old-version"}, baseline
    workspace_db.media_sync_paths_finalize(str(workspace), db, {
        "projectName": "Project", "snapshotId": prepared["snapshotId"],
    })
    assert db.execute("SELECT file_missing FROM versions WHERE id='old-version'").fetchone()[0] == 1
    assert db.execute("SELECT file_missing FROM versions WHERE id='new-version'").fetchone()[0] == 0, "post-watermark versions must not be marked missing"
    db.close()


def main():
    with tempfile.TemporaryDirectory(prefix="photoflow-cross-domain-durability-") as temporary:
        root = Path(temporary)
        test_batch_rename_live_journal(root)
        test_full_sync_starting_baseline(root)
    print("cross-domain filesystem journal and full-sync watermark tests passed")


if __name__ == "__main__":
    main()
