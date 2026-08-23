import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("workspace_db_incremental", ROOT / "python" / "workspace_db.py")
workspace_db = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace_db)


class DatabaseWorker:
    def __init__(self, workspace: Path, database: Path):
        self.workspace = workspace
        self.database = database
        self.next_id = 0
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "python" / "workspace_db.py"), "--server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )

    def call(self, action: str, payload: dict):
        self.next_id += 1
        request = {
            "id": self.next_id, "action": action, "root": str(self.workspace),
            "database": str(self.database), "payload": payload,
        }
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(self.process.stderr.read() or "database worker exited without a response")
        response = json.loads(line)
        if not response.get("success"):
            raise RuntimeError(f"{response.get('code')}: {response.get('error')}")
        return response["result"]

    def kill(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=10)


def apply_changes(workspace: Path, db, project_name: str, changes: list[dict], external_roots=None, snapshot_id=None):
    prepared = workspace_db.media_sync_paths_prepare(str(workspace), db, {
        "projectName": project_name, "changes": changes, "externalRoots": external_roots or [],
        **({"snapshotId": snapshot_id} if snapshot_id else {}),
    })
    count = 0
    for offset in range(0, len(prepared["files"]), 64):
        applied = workspace_db.media_sync_paths_apply_batch(str(workspace), db, {
            "projectName": project_name, "snapshotId": prepared["snapshotId"],
            "batchIndex": offset // 64, "authorizedRoots": prepared["authorizedRoots"],
            "files": prepared["files"][offset:offset + 64],
        })
        count += int(applied.get("count") or 0)
    finalized = workspace_db.media_sync_paths_finalize(str(workspace), db, {
        "projectName": project_name, "snapshotId": prepared["snapshotId"],
        "authorizedRoots": prepared["authorizedRoots"], "files": prepared["files"],
        "scopes": prepared["scopes"], "baselineVersions": prepared["baselineVersions"],
    })
    return prepared, {**finalized, "count": count}


def change(path: Path, event_type="rename", kind="file"):
    return {"path": str(path.resolve()), "eventType": event_type, "kind": kind}


def main():
    temporary = Path(tempfile.mkdtemp(prefix="photoflow-media-incremental-"))
    try:
        workspace = temporary / "workspace"
        project = workspace / "Project"
        untouched = project / "Untouched"
        other = workspace / "Other"
        for folder in (untouched, other):
            folder.mkdir(parents=True)
        original = project / "single.jpg"
        stable = untouched / "stable.jpg"
        other_file = other / "other.jpg"
        original.write_bytes(b"original")
        stable.write_bytes(b"stable")
        other_file.write_bytes(b"other")
        database = temporary / "workspace.sqlite3"
        db = workspace_db.connect(str(workspace), str(database))
        now = int(time.time() * 1000)
        db.executemany(
            "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            [("project", "Project", "后期中", "Project", now, now), ("other", "Other", "后期中", "Other", now, now)],
        )
        db.commit()
        workspace_db.media_sync_project(str(workspace), db, {"projectName": "Project", "externalRoots": []})
        workspace_db.media_sync_project(str(workspace), db, {"projectName": "Other", "externalRoots": []})

        stable_before = db.execute("SELECT id,updated_at,file_missing FROM versions WHERE file_path_key=?", (str(stable.resolve()).casefold(),)).fetchone()
        other_before = db.execute("SELECT id,updated_at,file_missing FROM versions WHERE file_path_key=?", (str(other_file.resolve()).casefold(),)).fetchone()
        original.write_bytes(b"modified-content")
        _, modified = apply_changes(workspace, db, "Project", [change(original, "change")])
        assert modified["count"] == 1
        added = project / "added.jpg"
        added.write_bytes(b"added")
        _, inserted = apply_changes(workspace, db, "Project", [change(added)])
        assert inserted["count"] == 1
        original.unlink()
        _, deleted = apply_changes(workspace, db, "Project", [change(original, "rename", "missing")])
        assert deleted["missingCount"] == 1

        special = project / "百分%_下划线_感叹!中文"
        special.mkdir()
        special_file = special / "图像_100%.jpg"
        special_file.write_bytes(b"special")
        special_prepared, special_result = apply_changes(workspace, db, "Project", [change(special, "rename", "directory")])
        assert len(special_prepared["files"]) == 1 and special_result["count"] == 1, special_prepared
        assert db.execute("SELECT file_missing FROM versions WHERE file_path_key=?", (str(special_file.resolve()).casefold(),)).fetchone()[0] == 0
        shutil.rmtree(special)
        _, removed_subtree = apply_changes(workspace, db, "Project", [change(special, "rename", "missing")])
        assert removed_subtree["missingCount"] == 1, "escaped LIKE prefixes must target the exact %, _ and Chinese subtree"

        large = project / "Large"
        large.mkdir()
        for index in range(1537):
            (large / f"{index}.jpg").write_bytes(b"x")
        prepared, large_result = apply_changes(workspace, db, "Project", [change(large, "rename", "directory")])
        assert len(prepared["files"]) == 1537 and large_result["count"] == 1537

        renamed = project / "Renamed"
        large.rename(renamed)
        apply_changes(workspace, db, "Project", [change(large, "rename", "missing"), change(renamed, "rename", "directory")])
        shutil.rmtree(renamed)
        _, removed_large = apply_changes(workspace, db, "Project", [change(renamed, "rename", "missing")])
        assert removed_large["missingCount"] == 1537

        external = temporary / "external"
        external.mkdir()
        external_file = external / "linked.jpg"
        external_file.write_bytes(b"external")
        external_roots = [{"path": str(external.resolve()), "kind": "folder", "authorized": True, "online": True}]
        apply_changes(workspace, db, "Project", [change(external_file)], external_roots)
        assert db.execute("SELECT 1 FROM versions WHERE file_path_key=?", (str(external_file.resolve()).casefold(),)).fetchone()
        shutil.rmtree(external)
        offline_external_roots = [{**external_roots[0], "online": False}]
        _, offline_external = apply_changes(
            workspace, db, "Project", [change(external_file, "rename", "missing")], offline_external_roots,
        )
        assert offline_external["missingCount"] == 1, "an offline external root must still authorize missing reconciliation"
        external.mkdir()
        external_file.write_bytes(b"external-online-again")
        _, online_again = apply_changes(workspace, db, "Project", [change(external_file)], external_roots)
        assert online_again["count"] == 1
        assert db.execute("SELECT file_missing FROM versions WHERE file_path_key=?", (str(external_file.resolve()).casefold(),)).fetchone()[0] == 0

        external_single = temporary / "external-single.jpg"
        external_single.write_bytes(b"single")
        external_file_root = [{"path": str(external_single.resolve()), "kind": "file", "authorized": True, "online": True}]
        apply_changes(workspace, db, "Project", [change(external_single)], external_file_root)
        external_single.unlink()
        _, deleted_external_file = apply_changes(
            workspace, db, "Project", [change(external_single, "rename", "missing")],
            [{**external_file_root[0], "online": False}],
        )
        assert deleted_external_file["missingCount"] == 1, "a deleted managed external file must become missing"
        offline_no_walk = temporary / "offline-no-walk"
        offline_no_walk.mkdir()
        (offline_no_walk / "must-not-enumerate.jpg").write_bytes(b"offline-capability")
        offline_snapshot = workspace_db.media_sync_paths_prepare(str(workspace), db, {
            "projectName": "Project", "changes": [change(offline_no_walk, "rename", "directory")],
            "externalRoots": [{"path": str(offline_no_walk.resolve()), "kind": "folder", "authorized": True, "online": False}],
        })
        assert offline_snapshot["files"] == [], "online=false authority must never enumerate an existing directory"
        workspace_db.media_sync_paths_finalize(str(workspace), db, {
            "projectName": "Project", "snapshotId": offline_snapshot["snapshotId"],
        })
        try:
            apply_changes(
                workspace, db, "Project", [change(offline_no_walk.parent / "parent.jpg", "rename", "missing")],
                [{"path": str(offline_no_walk.resolve()), "kind": "folder", "authorized": True, "online": False}],
            )
            assert False, "offline authority must not expand to its parent"
        except ValueError as error:
            assert "unauthorized" in str(error)
        try:
            apply_changes(
                workspace, db, "Project", [change(external_file)],
                [{"path": str(external.resolve()), "kind": "folder"}],
            )
            assert False, "legacy or renderer-shaped roots must not acquire authority"
        except ValueError as error:
            assert "external_media_root_invalid" in str(error)
        unauthorized = temporary / "unauthorized.jpg"
        unauthorized.write_bytes(b"no")
        try:
            apply_changes(workspace, db, "Project", [change(unauthorized)])
            assert False, "an unauthorized external path must be rejected"
        except ValueError as error:
            assert "unauthorized" in str(error)

        escape = project / "escape-link"
        try:
            os.symlink(str(temporary), str(escape), target_is_directory=True)
            try:
                apply_changes(workspace, db, "Project", [change(escape / "unauthorized.jpg")])
                assert False, "a symlink/junction escape must be rejected"
            except ValueError as error:
                assert "unauthorized" in str(error)
        except (OSError, NotImplementedError) as error:
            print(f"SKIP: junction/symbolic-link escape test unavailable: {error}")

        retry_file = project / "retry.jpg"
        retry_file.write_bytes(b"retry")
        snapshot_id = str(uuid.uuid4())
        _, first_retry = apply_changes(workspace, db, "Project", [change(retry_file)], snapshot_id=snapshot_id)
        _, second_retry = apply_changes(workspace, db, "Project", [change(retry_file)], snapshot_id=snapshot_id)
        assert first_retry == second_retry
        assert db.execute("SELECT COUNT(*) FROM versions WHERE file_path_key=?", (str(retry_file.resolve()).casefold(),)).fetchone()[0] == 1
        try:
            workspace_db.media_sync_paths_apply_batch(str(workspace), db, {
                "projectName": "Project", "snapshotId": snapshot_id, "batchIndex": 0,
                "files": [{"filePath": str(retry_file.resolve()), "fileSize": 999, "modifiedAt": 1}],
            })
            assert False, "a reused batch index with a different digest must fail"
        except workspace_db.MediaSyncBatchMismatch as error:
            assert error.code == "MEDIA_SYNC_BATCH_MISMATCH"

        deep_snapshot = workspace_db.media_sync_paths_prepare(str(workspace), db, {
            "projectName": "Project",
            "changes": [change(project / f"missing-scope-{index}.jpg", "rename", "missing") for index in range(2048)],
            "externalRoots": [],
        })
        assert len(deep_snapshot["scopes"]) == 2048
        workspace_db.media_sync_paths_finalize(str(workspace), db, {
            "projectName": "Project", "snapshotId": deep_snapshot["snapshotId"],
            "files": [{"filePath": "C:/forged.jpg"}], "scopes": [{"pathKey": "forged"}],
        })

        mixed_changes = []
        for index in range(1024):
            mixed_changes.append(change(project / f"mixed-file-{index}.jpg", "rename", "missing"))
            mixed_changes.append(change(project / f"mixed-directory-{index}", "rename", "directory"))
        mixed_snapshot = workspace_db.media_sync_paths_prepare(str(workspace), db, {
            "projectName": "Project", "changes": mixed_changes, "externalRoots": [],
        })
        assert len(mixed_snapshot["scopes"]) == 2048
        assert {scope["kind"] for scope in mixed_snapshot["scopes"]} == {"file", "directory"}
        workspace_db.media_sync_paths_finalize(str(workspace), db, {
            "projectName": "Project", "snapshotId": mixed_snapshot["snapshotId"],
        })

        stable_after = db.execute("SELECT id,updated_at,file_missing FROM versions WHERE id=?", (stable_before["id"],)).fetchone()
        other_after = db.execute("SELECT id,updated_at,file_missing FROM versions WHERE id=?", (other_before["id"],)).fetchone()
        assert tuple(stable_after) == tuple(stable_before), "an untouched directory must remain byte-for-byte unchanged"
        assert tuple(other_after) == tuple(other_before), "another project's records must remain unchanged"
        db.close()

        crash_directory = project / "CrashRecovery"
        crash_directory.mkdir()
        for index in range(65):
            (crash_directory / f"{index:03d}.jpg").write_bytes(f"old-{index}".encode())
        crash_snapshot_id = str(uuid.uuid4())
        worker_one = DatabaseWorker(workspace, database)
        prepared_before_crash = worker_one.call("media_sync_paths_prepare", {
            "projectName": "Project", "snapshotId": crash_snapshot_id,
            "changes": [change(crash_directory, "rename", "directory")], "externalRoots": [],
        })
        assert len(prepared_before_crash["files"]) == 65
        first_batch = prepared_before_crash["files"][:64]
        first_result = worker_one.call("media_sync_paths_apply_batch", {
            "projectName": "Project", "snapshotId": crash_snapshot_id, "batchIndex": 0, "files": first_batch,
        })
        worker_one.kill()

        deleted_during_crash = Path(prepared_before_crash["files"][0]["filePath"])
        deleted_during_crash.unlink()
        added_during_crash = crash_directory / "999.jpg"
        added_during_crash.write_bytes(b"new-during-crash")
        worker_two = DatabaseWorker(workspace, database)
        prepared_after_crash = worker_two.call("media_sync_paths_prepare", {
            "projectName": "Project", "snapshotId": crash_snapshot_id,
            "changes": [change(crash_directory, "rename", "directory")], "externalRoots": [],
        })
        assert prepared_after_crash["manifestHash"] == prepared_before_crash["manifestHash"]
        assert prepared_after_crash["files"] == prepared_before_crash["files"], "resume must not re-enumerate the filesystem"
        assert worker_two.call("media_sync_paths_apply_batch", {
            "projectName": "Project", "snapshotId": crash_snapshot_id, "batchIndex": 0,
            "files": prepared_after_crash["files"][:64],
        }) == first_result
        worker_two.call("media_sync_paths_apply_batch", {
            "projectName": "Project", "snapshotId": crash_snapshot_id, "batchIndex": 1,
            "files": prepared_after_crash["files"][64:],
        })
        worker_two.call("media_sync_paths_finalize", {
            "projectName": "Project", "snapshotId": crash_snapshot_id,
            "files": [], "scopes": [], "baselineVersions": [],
        })

        catch_up = worker_two.call("media_sync_paths_prepare", {
            "projectName": "Project", "snapshotId": str(uuid.uuid4()), "externalRoots": [],
            "changes": [change(deleted_during_crash, "rename", "missing"), change(added_during_crash)],
        })
        for offset in range(0, len(catch_up["files"]), 64):
            worker_two.call("media_sync_paths_apply_batch", {
                "projectName": "Project", "snapshotId": catch_up["snapshotId"],
                "batchIndex": offset // 64, "files": catch_up["files"][offset:offset + 64],
            })
        worker_two.call("media_sync_paths_finalize", {
            "projectName": "Project", "snapshotId": catch_up["snapshotId"],
        })
        worker_two.kill()

        checked = workspace_db.connect(str(workspace), str(database), include_domains=True)
        indexed_present = {
            row["file_path_key"] for row in checked.execute(
                """SELECT versions.file_path_key FROM versions JOIN photos ON photos.id=versions.photo_id
                   WHERE photos.project_id='project' AND versions.file_path_key LIKE ? AND versions.file_missing=0""",
                (str(crash_directory.resolve()).casefold() + os.sep + "%",),
            ).fetchall()
        }
        filesystem_present = {str(path.resolve()).casefold() for path in crash_directory.glob("*.jpg")}
        assert indexed_present == filesystem_present
        for schema in ("main", "media", "versioning"):
            assert checked.execute(f"PRAGMA {schema}.quick_check").fetchone()[0] == "ok"
        scope_indexes = {row[1] for row in checked.execute("PRAGMA media.index_list(media_incremental_snapshot_scopes)").fetchall()}
        assert "media_incremental_snapshot_scopes_path" in scope_indexes
        checked.close()
        print("incremental media synchronization tests passed")
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    main()
