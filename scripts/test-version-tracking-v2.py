from __future__ import annotations

import sqlite3
import shutil
import tempfile
import time
from pathlib import Path

import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db as db_api  # noqa: E402


def write_media(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def register(db, workspace: Path, folder: Path, *, version_key: str, node_role: str,
             parent_id: str | None = None, tracking: bool = False,
             rename: bool = False, copy_missing: bool = False):
    return db_api.progress_register(str(workspace), db, {
        "projectName": "Project",
        "mediaKind": "image",
        "versionKey": version_key,
        "displayName": folder.name,
        "folderPath": str(folder),
        "nodeRole": node_role,
        "relationKind": "auxiliary" if node_role == "selection" else ("main" if parent_id else None),
        "parentProgressId": parent_id,
        "trackingEnabled": tracking,
        "trackingState": "ready" if tracking else "disabled",
        "renameFromParent": rename,
        "copyMissingFromParent": copy_missing,
    })["progressFolder"]


def decide_all(db, workspace: Path, session_id: str) -> None:
    session = db_api.tracking_session_get(db, {"sessionId": session_id, "limit": 500})
    for item in session["items"]:
        db_api.tracking_session_decide(str(workspace), db, {
            "sessionId": session_id,
            "itemId": item["id"],
            "status": "rejected" if item["status"] == "missing_reference" else "accepted",
        })


def complete_without_folder_rescan(db, workspace: Path, session_id: str):
    original = db_api.folder_media_snapshot
    db_api.folder_media_snapshot = lambda _path: (_ for _ in ()).throw(AssertionError("tracking commit rescanned a prepared folder"))
    try:
        return db_api.tracking_commit_complete(str(workspace), db, {"sessionId": session_id})
    finally:
        db_api.folder_media_snapshot = original


def test_tracking_engine(root: Path) -> None:
    workspace = root / "workspace"
    project = workspace / "Project"
    original_folder = project / "Camera source"
    progress_folder = project / "Arbitrary edit folder"
    selection_folder = project / "Camera source_selection"
    outside_folder = root / "outside"
    for folder in (original_folder, progress_folder, selection_folder, outside_folder):
        folder.mkdir(parents=True, exist_ok=True)
    write_media(original_folder / "base.jpg", b"base-v0")
    write_media(progress_folder / "working.jpg", b"working-v1")
    write_media(selection_folder / "selected.jpg", b"selection")

    database = root / "tracking.sqlite3"
    db = db_api.connect(str(workspace), str(database))
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("project-id", "Project", "active", "Project", now, now),
    )
    db.commit()
    try:
        original = register(db, workspace, original_folder, version_key="source", node_role="original")
        progress = register(
            db, workspace, progress_folder, version_key="edit", node_role="progress",
            parent_id=original["id"], tracking=True, rename=True, copy_missing=True,
        )
        selection = register(
            db, workspace, selection_folder, version_key="selection", node_role="selection",
            parent_id=original["id"],
        )

        # Preparing a branch without parent-copy policy must not hash or scan
        # every parent RAW merely to find changed child files.
        no_parent_scan_folder = project / "No parent scan child"
        no_parent_scan_folder.mkdir()
        write_media(no_parent_scan_folder / "working.jpg", b"working-v1")
        no_parent_scan = register(
            db, workspace, no_parent_scan_folder, version_key="fast", node_role="progress",
            parent_id=original["id"], tracking=True,
        )
        original_snapshot = db_api.folder_media_snapshot
        scanned_paths = []
        db_api.folder_media_snapshot = lambda folder_path: (scanned_paths.append(Path(folder_path)), original_snapshot(folder_path))[1]
        try:
            fast_prepared = db_api.tracking_prepare(str(workspace), db, {
                "projectName": "Project", "progressId": no_parent_scan["id"], "mode": "compare",
            })
            assert scanned_paths == [no_parent_scan_folder]
        finally:
            db_api.folder_media_snapshot = original_snapshot
        db_api.tracking_session_release(db, {"sessionId": fast_prepared["sessionId"]})
        db.execute("DELETE FROM progress_folders WHERE id=?", (no_parent_scan["id"],))
        db.commit()

        # Arbitrary folder names are irrelevant: IDs and the explicit main edge drive comparison.
        prepared = db_api.tracking_prepare(str(workspace), db, {
            "projectName": "Project", "progressId": progress["id"], "mode": "compare",
        })
        assert prepared["parentProgressId"] == original["id"]
        assert prepared["sourceNames"] == ["working.jpg"]
        first = db_api.tracking_store_preview(db, {
            "sessionId": prepared["sessionId"],
            "items": [{
                "kind": "new", "status": "pending_confirmation",
                "sourceName": "working.jpg", "targetName": "working.jpg",
            }],
        })
        assert first["items"][0]["status"] == "pending_confirmation"
        try:
            db_api.tracking_commit_plan(str(workspace), db, {"sessionId": prepared["sessionId"]})
            raise AssertionError("new media must be explicitly confirmed")
        except ValueError as error:
            assert "1" in str(error)
        decide_all(db, workspace, prepared["sessionId"])
        plan = db_api.tracking_commit_plan(str(workspace), db, {"sessionId": prepared["sessionId"]})
        assert plan["progressId"] == progress["id"] and plan["parentProgressId"] == original["id"]
        complete_without_folder_rescan(db, workspace, prepared["sessionId"])

        # An unchanged refresh does not replay previously confirmed media.
        unchanged = db_api.tracking_prepare(str(workspace), db, {
            "projectName": "Project", "progressId": progress["id"], "mode": "refresh",
        })
        assert unchanged["sourceNames"] == [] and unchanged["copyCandidateNames"] == []
        db_api.tracking_store_preview(db, {"sessionId": unchanged["sessionId"], "items": []})
        db_api.tracking_commit_plan(str(workspace), db, {"sessionId": unchanged["sessionId"]})
        complete_without_folder_rescan(db, workspace, unchanged["sessionId"])

        # Child changes and newly added parent media are the only next candidates.
        write_media(progress_folder / "delta.jpg", b"delta-v1")
        write_media(original_folder / "parent-added.jpg", b"new-parent")
        refresh = db_api.tracking_prepare(str(workspace), db, {
            "projectName": "Project", "progressId": progress["id"], "mode": "refresh",
        })
        assert refresh["sourceNames"] == ["delta.jpg"]
        assert refresh["copyCandidateNames"] == ["parent-added.jpg"]
        preview = db_api.tracking_store_preview(db, {
            "sessionId": refresh["sessionId"],
            "items": [
                {"kind": "new", "status": "pending_confirmation", "sourceName": "delta.jpg", "targetName": "delta.jpg"},
                {"kind": "copy_missing", "status": "pending_confirmation", "referenceName": "parent-added.jpg", "targetName": "parent-added.jpg"},
            ],
        })
        items = {item["kind"]: item for item in preview["items"]}
        # Manual association turns new media into a recognized relationship.
        db_api.tracking_session_decide(str(workspace), db, {
            "sessionId": refresh["sessionId"], "itemId": items["new"]["id"],
            "status": "accepted", "referenceName": "base.jpg",
        })
        db_api.tracking_session_decide(str(workspace), db, {
            "sessionId": refresh["sessionId"], "itemId": items["copy_missing"]["id"],
            "status": "accepted",
        })
        refresh_plan = db_api.tracking_commit_plan(str(workspace), db, {"sessionId": refresh["sessionId"]})
        assert refresh_plan["renameFromParent"] and refresh_plan["copyMissingFromParent"]
        assert refresh_plan["matches"][0]["target"] == "base.jpg"
        assert db_api._rename_target_preserving_source_extension("retouched.png", "base.ARW") == "base.png"
        assert refresh_plan["copyReferences"] == ["parent-added.jpg"]

        # A failed commit is retryable without losing decisions or accepting new paths.
        db_api.tracking_commit_failed(db, {"sessionId": refresh["sessionId"], "error": "simulated failure"})
        retry_plan = db_api.tracking_commit_plan(str(workspace), db, {"sessionId": refresh["sessionId"]})
        assert retry_plan["matches"] == refresh_plan["matches"]
        (progress_folder / "delta.jpg").rename(progress_folder / "base.jpg")
        shutil.copy2(original_folder / "parent-added.jpg", progress_folder / "parent-added.jpg")
        complete_without_folder_rescan(db, workspace, refresh["sessionId"])

        # Direct content changes mark the tracked node stale, including changes
        # discovered after the application was not watching the project.
        write_media(progress_folder / "delta.jpg", b"delta-v1-changed-content")
        detected = db_api.progress_detect_stale(str(workspace), db, {
            "projectName": "Project", "changedPaths": [str(progress_folder / "delta.jpg")],
        })
        assert progress["id"] in detected["staleProgressIds"]
        db_api.progress_mark_ready(db, {
            "progressId": progress["id"],
            "trackingSnapshot": {
                "files": db_api.folder_media_snapshot(str(progress_folder)),
                "parent": db_api.folder_media_snapshot(str(original_folder)),
            },
        })

        no_copy_folder = project / "No copy child"
        no_copy_folder.mkdir()
        no_copy = register(
            db, workspace, no_copy_folder, version_key="no-copy", node_role="progress",
            parent_id=original["id"], tracking=True,
        )
        db_api.progress_mark_ready(db, {
            "progressId": no_copy["id"],
            "trackingSnapshot": {
                "files": db_api.folder_media_snapshot(str(no_copy_folder)),
                "parent": db_api.folder_media_snapshot(str(original_folder)),
            },
        })
        write_media(original_folder / "later-parent.jpg", b"later-parent")
        propagated = db_api.progress_detect_stale(str(workspace), db, {
            "projectName": "Project", "changedPaths": [str(original_folder / "later-parent.jpg")],
        })
        assert progress["id"] in propagated["propagatedProgressIds"]
        assert no_copy["id"] not in propagated["staleProgressIds"]
        assert selection["id"] not in propagated["staleProgressIds"]

        # Releasing a session removes its paged results and restores the state
        # that existed before the background compare began.
        db_api.progress_mark_ready(db, {
            "progressId": progress["id"],
            "trackingSnapshot": {
                "files": db_api.folder_media_snapshot(str(progress_folder)),
                "parent": db_api.folder_media_snapshot(str(original_folder)),
            },
        })
        disposable = db_api.tracking_session_create(str(workspace), db, {
            "projectName": "Project", "progressId": progress["id"], "mode": "refresh",
        })
        duplicate = db_api.tracking_session_create(str(workspace), db, {
            "projectName": "Project", "progressId": progress["id"], "mode": "refresh",
        })
        assert duplicate["sessionId"] == disposable["sessionId"]
        assert duplicate["reused"] is True
        assert duplicate["sessionStatus"] == "comparing"
        active_count = db.execute(
            """SELECT COUNT(*) FROM tracking_sessions WHERE progress_id=?
               AND status IN ('comparing','pending_confirm','committing','failed')""",
            (progress["id"],),
        ).fetchone()[0]
        assert active_count == 1
        assert db_api.tracking_session_get(db, {"sessionId": disposable["sessionId"]})["success"]
        db_api.tracking_commit_failed(db, {
            "sessionId": disposable["sessionId"], "error": "simulated compare failure",
        })
        failed_progress = db_api._progress_row_by_id(db, progress["id"])
        assert failed_progress["tracking_state"] == "stale", "failed refresh must never look ready"
        try:
            db_api.tracking_commit_plan(str(workspace), db, {"sessionId": disposable["sessionId"]})
            raise AssertionError("a failed compare without preview items must not commit an empty result")
        except ValueError as error:
            assert "重新比较" in str(error)
        retry = db_api.tracking_session_create(str(workspace), db, {
            "projectName": "Project", "progressId": progress["id"], "mode": "refresh",
        })
        assert retry["sessionId"] != disposable["sessionId"], "an empty failed compare must be replaced automatically"
        assert retry["reused"] is False
        try:
            db_api.tracking_session_get(db, {"sessionId": disposable["sessionId"]})
            raise AssertionError("the terminal failed session must not remain after automatic retry")
        except ValueError:
            pass
        released = db_api.tracking_session_release(db, {"sessionId": retry["sessionId"]})
        assert released["released"] is True
        try:
            db_api.tracking_session_get(db, {"sessionId": retry["sessionId"]})
            raise AssertionError("released sessions must not remain readable")
        except ValueError:
            pass

        # Auxiliary nodes are rejected by the engine before any compare/commit work.
        try:
            db_api.tracking_prepare(str(workspace), db, {
                "projectName": "Project", "progressId": selection["id"], "mode": "refresh",
            })
            raise AssertionError("auxiliary tracking must be rejected")
        except ValueError as error:
            assert "auxiliary" in str(error)

        # SQLite rejects cycles, and trusted-path validation rejects an escaped DB path.
        try:
            db.execute(
                "UPDATE progress_folders SET parent_progress_id=?,relation_kind='main' WHERE id=?",
                (progress["id"], original["id"]),
            )
            raise AssertionError("cycle must be rejected")
        except sqlite3.IntegrityError:
            db.rollback()
        saved_path = db.execute("SELECT folder_path,folder_path_key FROM progress_folders WHERE id=?", (progress["id"],)).fetchone()
        db.execute(
            "UPDATE progress_folders SET folder_path=?,folder_path_key=? WHERE id=?",
            (str(outside_folder), str(outside_folder).casefold(), progress["id"]),
        )
        db.commit()
        try:
            db_api.tracking_prepare(str(workspace), db, {
                "projectName": "Project", "progressId": progress["id"], "mode": "refresh",
            })
            raise AssertionError("escaped folder path must be rejected")
        except ValueError:
            pass
        db.execute(
            "UPDATE progress_folders SET folder_path=?,folder_path_key=? WHERE id=?",
            (saved_path[0], saved_path[1], progress["id"]),
        )
        db.commit()

        # Version-history queries follow explicit main nodes, retain missing records,
        # and never include a selection batch even if legacy code registered one.
        db_api.batch_register_baseline(str(workspace), db, {"projectName": "Project", "folderPath": str(original_folder)})
        db_api.batch_register_baseline(str(workspace), db, {"projectName": "Project", "folderPath": str(progress_folder)})
        db_api.batch_register_baseline(str(workspace), db, {"projectName": "Project", "folderPath": str(selection_folder)})
        history = db_api.progress_main_branch_media(db, {"progressId": progress["id"]})
        assert history["branchProgressIds"] == [original["id"], progress["id"], no_copy["id"]]
        assert all(entry["progressId"] != selection["id"] for entry in history["entries"])
        progress_entry = next(entry for entry in history["entries"] if entry["progressId"] == progress["id"])
        assert progress_entry["version"]["displayVersionKey"] == "edit"
        by_photo = db_api.progress_main_branch_media(db, {"photoId": history["entries"][0]["photoId"]})
        assert by_photo["progressId"] in (original["id"], progress["id"])
        assert by_photo["entries"] and all(entry["photoId"] == history["entries"][0]["photoId"] for entry in by_photo["entries"])

        # Committed batches retain the old source path after a folder rename.
        # The stable filesystem folder ID must keep those versions discoverable.
        renamed_progress_folder = project / "Renamed edit folder"
        progress_folder.rename(renamed_progress_folder)
        db_api.sync_progress_folder_locations(str(workspace), db, db_api.project_row(db, "Project"))
        renamed_progress = db_api._progress_row_by_id(db, progress["id"])
        progress_batch = db.execute(
            "SELECT * FROM version_batches WHERE project_id=? AND source_folder_id=? ORDER BY sequence DESC LIMIT 1",
            (renamed_progress["project_id"], renamed_progress["folder_id"]),
        ).fetchone()
        assert progress_batch is not None
        assert progress_batch["source_folder_path_key"] != renamed_progress["folder_path_key"]
        renamed_history = db_api.progress_main_branch_media(db, {"progressId": progress["id"]})
        renamed_entry = next(entry for entry in renamed_history["entries"] if entry["progressId"] == progress["id"])
        assert renamed_entry["version"]["id"] == progress_entry["version"]["id"]
        resolved_after_rename = db_api.progress_main_branch_media(db, {"photoId": renamed_entry["photoId"]})
        assert resolved_after_rename["progressId"] == progress["id"]
        first_path = Path(history["entries"][0]["version"]["filePath"])
        first_path.unlink()
        missing_history = db_api.progress_main_branch_media(db, {"progressId": progress["id"]})
        missing_entry = next(entry for entry in missing_history["entries"] if entry["version"]["id"] == history["entries"][0]["version"]["id"])
        assert missing_entry["version"]["fileMissing"] is True
    finally:
        db.close()

    reopened = db_api.connect(str(workspace), str(database))
    try:
        stored = db_api.serialize_progress(db_api._progress_row_by_id(reopened, progress["id"]))
        assert stored["renameFromParent"] and stored["copyMissingFromParent"]
        assert stored["trackingState"] == "ready" and stored["trackingSnapshot"]
        assert reopened.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        reopened.close()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="version-tracking-v2-") as temporary:
        test_tracking_engine(Path(temporary))
    print("version tracking V2 engine tests passed")


if __name__ == "__main__":
    main()
