from __future__ import annotations

import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from thumbnail_db import ThumbnailDatabase  # noqa: E402
from workspace_db import (  # noqa: E402
    connect,
    media_create_version,
    media_delete_version,
    media_delete_project_missing_version,
    media_get,
    media_get_photo,
    media_set_thumbnail,
    media_version_delete_scope,
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
        test_version_and_team_cleanup(root)
    print("Data maintenance tests passed.")


if __name__ == "__main__":
    main()
