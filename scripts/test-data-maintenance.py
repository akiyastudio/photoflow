from __future__ import annotations

import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from thumbnail_db import ThumbnailDatabase  # noqa: E402
from workspace_db import (  # noqa: E402
    batch_commit_compare,
    batch_register_baseline,
    connect,
    media_create_version,
    media_delete_version,
    media_delete_project_missing_version,
    media_get,
    media_get_photo,
    media_set_thumbnail,
    media_version_delete_scope,
    progress_list,
    progress_register,
    progress_update_tree,
    team_patch_cleanup,
    team_patch_replace,
    team_patch_update,
)


def write_media(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)


def test_thumbnail_missing_prune(root: Path) -> None:
    project = root / "thumbnail-project"
    source = project / "source.jpg"
    cached = root / "cache" / "source.jpg"
    write_media(source, b"source")
    write_media(cached, b"cached")
    database = ThumbnailDatabase(str(root / "thumbnail.sqlite3"))
    database.sync_directory(str(project), str(project))
    database.mark_ready(str(source), source.stat().st_mtime_ns / 1_000_000, None, [{
        "sizeLabel": "small", "pixelSize": 320, "path": str(cached),
        "fileSize": cached.stat().st_size,
    }])
    source.unlink()
    database.sync_directory(str(project), str(project))
    result = database.prune_missing_sources()
    assert result["sourceCount"] == 1
    assert str(cached.resolve()).casefold() in {str(Path(item).resolve()).casefold() for item in result["thumbnailPaths"]}
    assert database.get_file(str(source)) is None
    database.close()


def test_missing_progress_replacement(root: Path) -> None:
    workspace = root / "progress-workspace"
    project = workspace / "Project"
    original = project / "图片后期_1"
    original.mkdir(parents=True)
    db = connect(str(workspace), str(root / "progress-workspace.sqlite3"))
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("progress-project", "Project", "后期中", "Project", 1, 1),
    )
    db.commit()
    try:
        registered = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "displayName": "图片后期_1", "folderPath": str(original), "trackingEnabled": True,
        })["progressFolder"]
        original.rmdir()
        missing = progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"][0]
        assert missing["id"] == registered["id"] and missing["folderMissing"]

        replacement = project / "图片后期_1_替换"
        replacement.mkdir()
        replaced = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "displayName": "图片后期_1_替换", "folderPath": str(replacement), "trackingEnabled": True,
        })["progressFolder"]
        assert replaced["id"] == registered["id"]
        assert not replaced["folderMissing"] and Path(replaced["folderPath"]).resolve() == replacement.resolve()
    finally:
        db.close()


def test_incremental_progress_append_preserves_existing_items(root: Path) -> None:
    workspace = root / "append-workspace"
    project = workspace / "Project"
    baseline_folder = project / "图片后期_1"
    target_folder = project / "图片后期_2"
    for name in ("one.jpg", "two.jpg"):
        write_media(baseline_folder / name, f"baseline-{name}".encode())
        write_media(target_folder / name, f"target-{name}".encode())
    db = connect(str(workspace), str(root / "append-workspace.sqlite3"))
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("append-project", "Project", "后期中", "Project", 1, 1),
    )
    db.commit()
    try:
        batch_register_baseline(str(workspace), db, {
            "projectName": "Project", "folderPath": str(baseline_folder),
        })
        first = batch_commit_compare(str(workspace), db, {
            "projectName": "Project", "folderA": str(baseline_folder), "folderB": str(target_folder),
            "importKey": "initial-v2", "displayName": "图片后期_2", "matches": [
                {"reference": "one.jpg", "source": "one.jpg", "distance": 0, "confidence": "高"},
                {"reference": "two.jpg", "source": "two.jpg", "distance": 0, "confidence": "高"},
            ],
        })
        batch_id = first["batch"]["id"]
        (target_folder / "two.jpg").unlink()
        write_media(baseline_folder / "three.jpg", b"baseline-three")
        write_media(target_folder / "three.jpg", b"target-three")
        appended = batch_commit_compare(str(workspace), db, {
            "projectName": "Project", "folderA": str(baseline_folder), "folderB": str(target_folder),
            "importKey": "append-v2", "displayName": "图片后期_2", "reconcileExisting": True,
            "incrementalSources": ["three.jpg"],
            "matches": [{"reference": "three.jpg", "source": "three.jpg", "distance": 0, "confidence": "高"}],
        })
        assert appended["batch"]["id"] == batch_id
        item_names = {row["source_name"] for row in db.execute("SELECT source_name FROM batch_items WHERE batch_id=?", (batch_id,))}
        assert item_names == {"one.jpg", "two.jpg", "three.jpg"}
    finally:
        db.close()


def test_modify_progress_replaces_missing_version(root: Path) -> None:
    workspace = root / "replace-progress-workspace"
    project = workspace / "Project"
    missing_path = project / "图片后期_1"
    active_path = project / "图片后期_2"
    child_path = project / "图片后期_2_1"
    for folder in (missing_path, active_path, child_path):
        folder.mkdir(parents=True, exist_ok=True)
    db = connect(str(workspace), str(root / "replace-progress-workspace.sqlite3"))
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("replace-progress-project", "Project", "后期中", "Project", 1, 1),
    )
    db.commit()
    try:
        missing = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "1",
            "displayName": "图片后期_1", "folderPath": str(missing_path), "trackingEnabled": True,
        })["progressFolder"]
        active = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "2",
            "displayName": "图片后期_2", "folderPath": str(active_path), "trackingEnabled": True,
        })["progressFolder"]
        child = progress_register(str(workspace), db, {
            "projectName": "Project", "mediaKind": "image", "versionKey": "2_1",
            "parentProgressId": active["id"], "displayName": "图片后期_2_1",
            "folderPath": str(child_path), "trackingEnabled": True,
        })["progressFolder"]
        missing_path.rmdir()
        active_path.rename(missing_path)
        remapped_child_path = project / "图片后期_1_1"
        child_path.rename(remapped_child_path)
        updated = progress_update_tree(str(workspace), db, {
            "projectName": "Project", "primaryProgressId": missing["id"],
            "replacementProgressId": active["id"],
            "updates": [
                {"id": missing["id"], "mediaKind": "image", "versionKey": "1", "displayName": "图片后期_1", "folderPath": str(missing_path), "trackingEnabled": True},
                {"id": child["id"], "mediaKind": "image", "versionKey": "1_1", "parentProgressId": missing["id"], "displayName": "图片后期_1_1", "folderPath": str(remapped_child_path), "trackingEnabled": True},
            ],
        })
        assert updated["progressFolder"]["id"] == missing["id"]
        rows = {item["id"]: item for item in progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]}
        assert not rows[missing["id"]]["folderMissing"] and rows[missing["id"]]["versionKey"] == "1"
        assert rows[active["id"]]["folderMissing"] and rows[active["id"]]["versionKey"] == "2"
        assert rows[child["id"]]["parentProgressId"] == missing["id"] and rows[child["id"]]["versionKey"] == "1_1"
    finally:
        db.close()


def test_version_and_team_cleanup(root: Path) -> None:
    workspace = root / "workspace"
    project = workspace / "Project"
    originals = [project / "one.jpg", project / "two.jpg"]
    for index, original in enumerate(originals):
        write_media(original, f"original-{index}".encode())
    db = connect(str(workspace), str(root / "workspace.sqlite3"))
    now = 1
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("project", "Project", "未分类", "Project", now, now),
    )
    db.commit()

    created = []
    for index, original in enumerate(originals):
        baseline = media_get(str(workspace), db, {"projectName": "Project", "filePath": str(original)})
        photo = baseline["photo"]
        base = baseline["versions"][0]
        version_file = project / f"version-{index}.jpg"
        write_media(version_file, f"version-{index}".encode())
        version_bundle = media_create_version(db, {
            "photoId": photo["id"], "parentVersionId": base["id"], "filePath": str(version_file),
            "versionName": "丢失版本",
        })
        version = version_bundle["versions"][-1]
        thumbnail = root / "workspace-data" / "thumbnails" / photo["id"] / f"{version['id']}.jpg"
        write_media(thumbnail, b"preview")
        media_set_thumbnail(db, {"versionId": version["id"], "thumbnailPath": str(thumbnail)})
        patch = root / "workspace-data" / "team-retouch" / photo["id"] / version["id"] / "patch.png"
        mask = patch.with_name("mask.png")
        edited = patch.with_name("edited.png")
        for item in (patch, mask, edited):
            write_media(item, item.name.encode())
        team_patch_replace(db, {"photoId": photo["id"], "baseVersionId": version["id"], "tasks": [{
            "id": f"task-{index}", "personIndex": 1, "personName": "人物 1", "assignee": "",
            "detector": "test", "bbox": {"x": 0, "y": 0, "width": 10, "height": 10},
            "crop": {"x": 0, "y": 0, "width": 10, "height": 10},
            "patchPath": str(patch), "maskPath": str(mask), "editedPatchPath": str(edited),
            "status": "merged",
        }]})
        team_patch_update(db, {"taskId": f"task-{index}", "editedPatchPath": str(edited), "status": "merged"})
        version_file.unlink()
        media_get(str(workspace), db, {"projectName": "Project", "filePath": str(original)})
        created.append((photo, base, version, thumbnail, patch, mask, edited))

    scope = media_version_delete_scope(db, {"versionId": created[0][2]["id"]})
    assert scope["versionCount"] == 2 and scope["allMissing"] and scope["childCount"] == 0
    deleted = media_delete_project_missing_version(db, {"versionId": created[0][2]["id"]})
    assert deleted["deletedCount"] == 2
    assert len(deleted["deletedVersions"]) == 2
    assert len(deleted["teamArtifactPaths"]) == 6
    next_versions = []
    for photo, base, _version, _thumbnail, _patch, _mask, _edited in created:
        remaining = media_get_photo(db, {"photoId": photo["id"]})
        assert [item["versionNumber"] for item in remaining["versions"]] == [0]
        next_file = project / f"next-{photo['id']}.jpg"
        write_media(next_file, b"next")
        next_bundle = media_create_version(db, {
            "photoId": photo["id"], "parentVersionId": base["id"], "filePath": str(next_file),
            "versionName": "新版本",
        })
        assert next_bundle["versions"][-1]["versionNumber"] == 2
        next_versions.append(next_bundle["versions"][-1])

    child_file = project / "child-version.jpg"
    write_media(child_file, b"child")
    child_bundle = media_create_version(db, {
        "photoId": created[0][0]["id"], "parentVersionId": next_versions[0]["id"],
        "filePath": str(child_file), "versionName": "后续版本",
    })
    child_version = child_bundle["versions"][-1]
    single_scope = media_version_delete_scope(db, {"versionId": next_versions[0]["id"]})
    assert single_scope["versionCount"] == 2 and not single_scope["allMissing"]
    assert single_scope["selectedChildCount"] == 1 and single_scope["childCount"] == 1
    single_deleted = media_delete_version(db, {"versionId": next_versions[0]["id"]})
    assert single_deleted["reparentedCount"] == 1
    first_remaining = media_get_photo(db, {"photoId": created[0][0]["id"]})["versions"]
    assert [item["id"] for item in first_remaining] == [created[0][1]["id"], child_version["id"]]
    assert first_remaining[-1]["parentVersionId"] == created[0][1]["id"]
    assert any(item["id"] == next_versions[1]["id"] for item in media_get_photo(db, {"photoId": created[1][0]["id"]})["versions"])

    first_photo, first_base = created[0][0], created[0][1]
    completed_patch = root / "completed" / "patch.png"
    write_media(completed_patch, b"completed")
    team_patch_replace(db, {"photoId": first_photo["id"], "baseVersionId": first_base["id"], "tasks": [{
        "id": "completed-task", "personIndex": 1, "personName": "人物 1", "assignee": "",
        "detector": "test", "bbox": {"x": 0, "y": 0, "width": 10, "height": 10},
        "crop": {"x": 0, "y": 0, "width": 10, "height": 10},
        "patchPath": str(completed_patch), "status": "merged",
    }]})
    try:
        cleaned = team_patch_cleanup(db, {"photoId": first_photo["id"], "baseVersionId": first_base["id"]})
        assert cleaned["cleanedCount"] == 1
        assert str(completed_patch.resolve()).casefold() in {str(Path(item).resolve()).casefold() for item in cleaned["artifactPaths"]}
    finally:
        db.close()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="photoflow-maintenance-") as directory:
        root = Path(directory)
        test_thumbnail_missing_prune(root)
        test_missing_progress_replacement(root)
        test_incremental_progress_append_preserves_existing_items(root)
        test_modify_progress_replaces_missing_version(root)
        test_version_and_team_cleanup(root)
    print("Data maintenance tests passed.")


if __name__ == "__main__":
    main()
