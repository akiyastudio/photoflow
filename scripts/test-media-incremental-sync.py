import importlib.util
import json
import os
import shutil
import stat
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


def apply_full_paged(workspace: Path, db, project_name: str):
    legacy = workspace_db.media_sync_prepare(str(workspace), db, {
        "projectName": project_name, "externalRoots": [],
    })
    snapshot_id = str(uuid.uuid4())
    token = "0"
    pages = 0
    count = 0
    paged_total = None
    while True:
        prepared = workspace_db.media_sync_prepare(str(workspace), db, {
            "projectName": project_name, "externalRoots": [], "paged": True,
            "snapshotId": snapshot_id, "pageToken": token, "pageSize": 64,
        })
        assert prepared["paged"] and len(prepared["files"]) <= 64
        assert prepared["baselineVersions"] == [], "paged wire results must not aggregate the baseline"
        paged_total = prepared["totalFiles"] if paged_total is None else paged_total
        assert prepared["totalFiles"] == paged_total
        pages += 1
        if prepared["files"]:
            applied = workspace_db.media_sync_paths_apply_batch(str(workspace), db, {
                "projectName": project_name, "snapshotId": snapshot_id,
                "batchIndex": prepared["pageOffset"] // 64, "files": prepared["files"],
            })
            count += int(applied.get("count") or 0)
        token = prepared.get("nextPageToken")
        if not token:
            break
    finalized = workspace_db.media_sync_paths_finalize(str(workspace), db, {
        "projectName": project_name, "snapshotId": snapshot_id,
    })
    assert paged_total == len(legacy["files"]), "paged and legacy prepare must enumerate the same files"
    return pages, {**finalized, "count": count}


def change(path: Path, event_type="rename", kind="file"):
    return {"path": str(path.resolve()), "eventType": event_type, "kind": kind}


def assert_inside_temporary(temporary: Path, path: Path, label: str):
    temporary_resolved = temporary.resolve(strict=True)
    path_absolute = path.absolute()
    try:
        common = os.path.commonpath((str(temporary_resolved), str(path_absolute)))
        inside = os.path.normcase(common) == os.path.normcase(str(temporary_resolved))
    except ValueError:
        inside = False
    assert inside, f"{label} must remain inside the test temporary directory: {path_absolute}"


def is_directory_link(path: Path):
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    if is_junction is not None and is_junction():
        return True
    if os.name == "nt" and os.path.lexists(path):
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
        return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    return False


def create_directory_link(temporary: Path, link: Path, target: Path):
    temporary_resolved = temporary.resolve(strict=True)
    target_resolved = target.resolve(strict=True)
    requested_link_absolute = link.absolute()
    link_absolute = link.parent.resolve(strict=True) / link.name
    assert os.path.normcase(str(link_absolute)) == os.path.normcase(str(requested_link_absolute)), (
        f"link path must have a resolved parent and fixed basename: {requested_link_absolute}"
    )
    assert_inside_temporary(temporary_resolved, target_resolved, "link target")
    assert_inside_temporary(temporary_resolved, link_absolute, "link path")
    assert not os.path.lexists(link_absolute), f"test link path already exists: {link_absolute}"
    try:
        os.symlink(str(target_resolved), str(link_absolute), target_is_directory=True)
        mechanism = "symbolic link"
    except (OSError, NotImplementedError) as error:
        if not isinstance(error, OSError) or os.name != "nt" or getattr(error, "winerror", None) != 1314:
            raise AssertionError(f"unable to create test directory symbolic link: {error}") from error
        junction = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link_absolute), str(target_resolved)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if junction.returncode != 0:
            reason = (junction.stderr or junction.stdout).strip() or f"exit code {junction.returncode}"
            raise AssertionError(f"unable to create safe test directory junction: {reason}") from error
        mechanism = "directory junction"
    assert is_directory_link(link_absolute), f"created {mechanism} is not a reparse link: {link_absolute}"
    assert link_absolute.resolve(strict=True) == target_resolved, (
        f"created {mechanism} resolves outside its expected target: {link_absolute}"
    )
    return mechanism


def main():
    temporary_directory = tempfile.TemporaryDirectory(prefix="photoflow-media-incremental-")
    temporary = Path(temporary_directory.name)
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

        escape = (project / "escape-link").absolute()
        link_mechanism = None
        try:
            link_mechanism = create_directory_link(temporary, escape, temporary)
            try:
                apply_changes(workspace, db, "Project", [change(escape / "unauthorized.jpg")])
                assert False, "a symlink/junction escape must be rejected"
            except ValueError as error:
                assert "unauthorized" in str(error)
        finally:
            if os.path.lexists(escape):
                assert is_directory_link(escape), "refusing to recursively remove a non-link escape-link path"
                assert escape.resolve(strict=True) == temporary.resolve(strict=True), (
                    "refusing to remove an escape-link whose target is not the test temporary directory"
                )
                if escape.is_symlink():
                    escape.unlink()
                else:
                    os.rmdir(escape)
                assert not os.path.lexists(escape), "test escape link was not removed"
                if link_mechanism is not None:
                    print(f"{link_mechanism} escape rejection and link-only cleanup verified")

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
        aborted_snapshot_id = str(uuid.uuid4())
        worker_two.call("media_sync_paths_prepare", {
            "projectName": "Project", "snapshotId": aborted_snapshot_id, "externalRoots": [],
            "changes": [change(crash_directory, "rename", "directory")],
        })
        aborted = worker_two.call("media_sync_abort", {
            "projectName": "Project", "snapshotId": aborted_snapshot_id,
        })
        assert aborted["removed"] is True
        restarted_after_abort = worker_two.call("media_sync_paths_prepare", {
            "projectName": "Project", "snapshotId": aborted_snapshot_id, "externalRoots": [],
            "changes": [change(crash_directory, "rename", "directory")],
        })
        assert restarted_after_abort["snapshotId"] == aborted_snapshot_id
        worker_two.call("media_sync_abort", {"projectName": "Project", "snapshotId": aborted_snapshot_id})
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
        paged_directory = project / "PagedFull"
        paged_directory.mkdir()
        for index in range(1537):
            (paged_directory / f"{index:04d}.jpg").write_bytes(b"paged")
        full_pages, full_result = apply_full_paged(workspace, checked, "Project")
        assert full_pages > 24 and full_result["count"] >= 1537, "full sync must consume a bounded persisted manifest"
        checked.close()
        print("incremental media synchronization tests passed")
    finally:
        temporary_directory.cleanup()


if __name__ == "__main__":
    main()
