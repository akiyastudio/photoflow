import copy
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db


def make_project(root: Path, db, name: str):
    project = root / name
    project.mkdir(parents=True)
    now = int(time.time() * 1000)
    project_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO projects(id,name,status,relative_path,created_at,updated_at)
           VALUES(?,?,?,?,?,?)""",
        (project_id, name, "后期中", name, now, now),
    )
    db.commit()
    return project, project_id


def artifact(relative_path: str, slot: str, display_name: str | None = None):
    return {
        "relativePath": relative_path,
        "mediaKind": "video" if slot in ("mov", "video_transcode") else "image",
        "importSlot": slot,
        "displayName": display_name or relative_path,
    }


def manifest(project_name: str, session_id: str, artifacts):
    return {
        "schemaVersion": 2,
        "projectName": project_name,
        "importSessionId": session_id,
        "artifacts": artifacts,
    }


def commit(root: Path, db, project_name: str, session_id: str, artifacts):
    return workspace_db.media_workflow_import_commit(
        str(root), db, manifest(project_name, session_id, artifacts)
    )


def edge_count(db, project_id: str, kind: str):
    return db.execute(
        "SELECT COUNT(*) FROM version_graph_edges WHERE project_id=? AND edge_kind=?",
        (project_id, kind),
    ).fetchone()[0]


def test_idempotency_and_session_conflict(root: Path, db):
    project, project_id = make_project(root, db, "idempotent")
    for name in ("source-a", "source-b", "source-c", "source-d"):
        (project / name).mkdir()
    items = [
        artifact("source-a", "raw", "RAW"),
        artifact("source-b", "camera_jpg", "JPG"),
        artifact("source-c", "mov", "MOV"),
        artifact("source-d", "video_transcode", "转码"),
    ]
    first = commit(root, db, "idempotent", "same-session", items)
    second = commit(root, db, "idempotent", "same-session", list(reversed(items)))
    assert [node["id"] for node in first["nodes"]] == [node["id"] for node in second["nodes"]]
    assert db.execute("SELECT COUNT(*) FROM progress_folders WHERE project_id=?", (project_id,)).fetchone()[0] == 4
    assert db.execute("SELECT COUNT(*) FROM media_import_artifact_slots WHERE project_id=?", (project_id,)).fetchone()[0] == 4
    assert edge_count(db, project_id, "media_companion") == 1
    assert edge_count(db, project_id, "derived_transcode") == 1
    changed = copy.deepcopy(items)
    changed[0]["displayName"] = "changed"
    try:
        commit(root, db, "idempotent", "same-session", changed)
        raise AssertionError("same session with a different manifest must fail")
    except ValueError as error:
        assert "import_graph_session_conflict" in str(error)


def test_existing_progress_is_never_overwritten(root: Path, db):
    project, project_id = make_project(root, db, "role-conflict")
    folder = project / "explicit-slot-path"
    folder.mkdir()
    source_folder = project / "source"
    source_folder.mkdir()
    source = workspace_db.progress_register(str(root), db, {
        "projectName": "role-conflict", "mediaKind": "image", "versionKey": "source",
        "displayName": "Source", "folderPath": str(source_folder), "nodeRole": "original",
        "trackingEnabled": False,
    })["progressFolder"]
    original = workspace_db.progress_register(str(root), db, {
        "projectName": "role-conflict",
        "mediaKind": "image",
        "versionKey": "manual-progress",
        "displayName": "Manual progress",
        "folderPath": str(folder),
        "nodeRole": "progress",
        "parentProgressId": source["id"],
        "relationKind": "main",
        "trackingEnabled": True,
        "trackingState": "ready",
        "renameFromParent": True,
        "copyMissingFromParent": True,
        "trackingSnapshot": {"sentinel": ["keep-me"]},
    })["progressFolder"]
    before = dict(db.execute("SELECT * FROM progress_folders WHERE id=?", (original["id"],)).fetchone())
    try:
        commit(root, db, "role-conflict", "conflict", [artifact("explicit-slot-path", "raw")])
        raise AssertionError("an ordinary progress at the artifact path must block import graph registration")
    except ValueError as error:
        assert "import_graph_role_conflict" in str(error)
    after = dict(db.execute("SELECT * FROM progress_folders WHERE id=?", (original["id"],)).fetchone())
    assert after == before
    assert json.loads(after["tracking_snapshot_json"]) == {"sentinel": ["keep-me"]}
    assert after["rename_from_parent"] == 1 and after["copy_missing_from_parent"] == 1
    assert db.execute("SELECT COUNT(*) FROM media_import_artifact_slots WHERE project_id=?", (project_id,)).fetchone()[0] == 0


def test_cross_batch_relations(root: Path, db):
    project, project_id = make_project(root, db, "cross-batch")
    for name in ("image-source", "camera-output", "video-source", "transcode-output"):
        (project / name).mkdir()
    commit(root, db, "cross-batch", "raw-only", [artifact("image-source", "raw")])
    assert edge_count(db, project_id, "media_companion") == 0
    commit(root, db, "cross-batch", "camera-later", [artifact("camera-output", "camera_jpg")])
    assert edge_count(db, project_id, "media_companion") == 1
    commit(root, db, "cross-batch", "mov-only", [artifact("video-source", "mov")])
    assert edge_count(db, project_id, "derived_transcode") == 0
    commit(root, db, "cross-batch", "transcode-later", [artifact("transcode-output", "video_transcode")])
    assert edge_count(db, project_id, "derived_transcode") == 1


def test_generated_camera_promotion(root: Path, db):
    project, project_id = make_project(root, db, "promotion")
    (project / "jpg-output").mkdir()
    (project / "raw-output").mkdir()
    generated = commit(root, db, "promotion", "generated-first", [artifact("jpg-output", "generated_jpg")])["nodes"][0]
    commit(root, db, "promotion", "camera-later", [artifact("jpg-output", "camera_jpg")])
    promoted = db.execute("SELECT * FROM progress_folders WHERE id=?", (generated["id"],)).fetchone()
    mapping = db.execute("SELECT import_slot FROM media_import_artifact_slots WHERE progress_id=?", (generated["id"],)).fetchone()
    assert promoted["node_role"] == "original" and promoted["artifact_kind"] == "companion"
    assert mapping["import_slot"] == "camera_jpg"
    commit(root, db, "promotion", "raw-later", [artifact("raw-output", "raw")])
    assert edge_count(db, project_id, "media_companion") == 1
    assert edge_count(db, project_id, "derived_preview") == 0

    project_two, project_two_id = make_project(root, db, "no-downgrade")
    (project_two / "shared-output").mkdir()
    camera = commit(root, db, "no-downgrade", "camera-first", [artifact("shared-output", "camera_jpg")])["nodes"][0]
    commit(root, db, "no-downgrade", "generated-later", [artifact("shared-output", "generated_jpg")])
    unchanged = db.execute("SELECT * FROM progress_folders WHERE id=?", (camera["id"],)).fetchone()
    unchanged_mapping = db.execute("SELECT import_slot FROM media_import_artifact_slots WHERE progress_id=?", (camera["id"],)).fetchone()
    assert unchanged["node_role"] == "original" and unchanged["artifact_kind"] == "companion"
    assert unchanged_mapping["import_slot"] == "camera_jpg"
    assert db.execute("SELECT COUNT(*) FROM progress_folders WHERE project_id=?", (project_two_id,)).fetchone()[0] == 1


def test_atomic_rollback_and_retry(root: Path, db):
    project, project_id = make_project(root, db, "rollback")
    (project / "raw-slot").mkdir()
    (project / "camera-slot").mkdir()
    db.executescript(
        """CREATE TRIGGER fail_test_import_edge BEFORE INSERT ON version_graph_edges
           BEGIN SELECT RAISE(ABORT,'forced relation failure'); END;"""
    )
    payload = [artifact("raw-slot", "raw"), artifact("camera-slot", "camera_jpg")]
    try:
        commit(root, db, "rollback", "retry-session", payload)
        raise AssertionError("forced relation failure must roll back nodes and slot mappings")
    except Exception as error:
        assert "forced relation failure" in str(error)
    assert db.execute("SELECT COUNT(*) FROM progress_folders WHERE project_id=?", (project_id,)).fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM media_import_artifact_slots WHERE project_id=?", (project_id,)).fetchone()[0] == 0
    assert db.execute("SELECT status FROM media_import_graph_sessions WHERE project_id=?", (project_id,)).fetchone()[0] == "failed"
    db.execute("DROP TRIGGER fail_test_import_edge")
    retried = commit(root, db, "rollback", "retry-session", payload)
    assert len(retried["nodes"]) == 2 and edge_count(db, project_id, "media_companion") == 1


def test_legacy_canonical_graph_migration(root: Path, db):
    project, project_id = make_project(root, db, "legacy-canonical")
    for name in ("raw", "jpg", "mov", "mov_转码", "ordinary-folder", "edit-source"):
        (project / name).mkdir()
    raw_source = workspace_db.progress_register(str(root), db, {
        "projectName": "legacy-canonical", "mediaKind": "image", "versionKey": "raw-source",
        "displayName": "raw", "folderPath": str(project / "raw"), "nodeRole": "original",
        "trackingEnabled": False,
    })["progressFolder"]
    source = workspace_db.progress_register(str(root), db, {
        "projectName": "legacy-canonical",
        "mediaKind": "image",
        "versionKey": "manual-source",
        "displayName": "Explicit edit source",
        "folderPath": str(project / "edit-source"),
        "nodeRole": "progress",
        "parentProgressId": raw_source["id"],
        "relationKind": "main",
        "trackingEnabled": False,
    })["progressFolder"]
    now = int(time.time() * 1000)
    photo_id = str(uuid.uuid4())
    version_id = str(uuid.uuid4())
    source_file = project / "edit-source" / "photo.jpg"
    source_file.write_bytes(b"source")
    db.execute(
        """INSERT INTO photos(id,project_id,media_type,original_name,display_name,original_file_path,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?)""",
        (photo_id, project_id, "image", "photo.jpg", "photo", str(source_file), now, now),
    )
    db.execute(
        """INSERT INTO versions(id,photo_id,version_number,version_name,file_path,file_path_key,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?)""",
        (version_id, photo_id, 1, "V1", str(source_file), str(source_file).casefold(), now, now),
    )
    db.commit()

    first = workspace_db.progress_list(str(root), db, {"projectName": "legacy-canonical"})
    by_name = {node["displayName"].casefold(): node for node in first["progressFolders"]}
    assert by_name["jpg"]["artifactKind"] == "companion"
    assert by_name["mov_转码"]["nodeRole"] == "artifact" and by_name["mov_转码"]["artifactKind"] == "transcode"
    assert "ordinary-folder" not in by_name, "ordinary folders must never be inferred into the graph"
    edges = {(edge["sourceProgressId"], edge["targetProgressId"], edge["edgeKind"]) for edge in first["graphEdges"]}
    assert any(kind == "media_companion" for _source, _target, kind in edges)
    assert any(kind == "derived_transcode" for _source, _target, kind in edges)
    second = workspace_db.progress_list(str(root), db, {"projectName": "legacy-canonical"})
    assert len(second["progressFolders"]) == len(first["progressFolders"])
    assert len(second["graphEdges"]) == len(first["graphEdges"]), "legacy graph migration must be idempotent"


def test_late_canonical_reconciliation(root: Path, db):
    project, project_id = make_project(root, db, "late-canonical")
    empty = workspace_db.progress_list(str(root), db, {"projectName": "late-canonical"})
    assert not empty["progressFolders"]
    (project / "RAW").mkdir()
    (project / "JPG").mkdir()
    reconciled = workspace_db.progress_list(str(root), db, {"projectName": "late-canonical"})
    by_name = {node["displayName"].casefold(): node for node in reconciled["progressFolders"]}
    assert by_name["raw"]["nodeRole"] == "original"
    assert by_name["jpg"]["nodeRole"] == "original" and by_name["jpg"]["artifactKind"] == "companion"
    assert edge_count(db, project_id, "media_companion") == 1


def test_safe_import_adoption_and_multiple_groups(root: Path, db):
    project, project_id = make_project(root, db, "import-adoption")
    (project / "manual-raw").mkdir()
    manual = workspace_db.progress_register(str(root), db, {
        "projectName": "import-adoption", "mediaKind": "image", "versionKey": "manual-raw",
        "displayName": "Manual RAW", "folderPath": str(project / "manual-raw"),
        "nodeRole": "original", "trackingEnabled": False,
    })["progressFolder"]
    adopted = commit(root, db, "import-adoption", "adopt-existing", [artifact("manual-raw", "raw")])
    assert adopted["nodes"][0]["id"] == manual["id"]
    assert db.execute("SELECT import_slot FROM media_import_artifact_slots WHERE progress_id=?", (manual["id"],)).fetchone()[0] == "raw"

    for group in ("day-1", "day-2"):
        (project / group / "RAW").mkdir(parents=True)
        (project / group / "JPG").mkdir()
    grouped = [
        artifact("day-1/RAW", "raw"), artifact("day-1/JPG", "camera_jpg"),
        artifact("day-2/RAW", "raw"), artifact("day-2/JPG", "camera_jpg"),
    ]
    commit(root, db, "import-adoption", "two-independent-groups", grouped)
    assert edge_count(db, project_id, "media_companion") == 2, "each relative parent group must own its relation"


def test_import_mapping_follows_external_rename(root: Path, db):
    project, _project_id = make_project(root, db, "rename-slot")
    (project / "day" / "RAW").mkdir(parents=True)
    node = commit(root, db, "rename-slot", "rename-source", [artifact("day/RAW", "raw")])["nodes"][0]
    os.rename(project / "day" / "RAW", project / "day" / "renamed-raw")
    project_row = workspace_db.project_row(db, "rename-slot")
    workspace_db.sync_progress_folder_locations(str(root), db, project_row)
    mapping = db.execute("SELECT relative_path_key FROM media_import_artifact_slots WHERE progress_id=?", (node["id"],)).fetchone()
    assert mapping["relative_path_key"] == "day/renamed-raw"


def test_manual_media_adoption(root: Path, db):
    project, project_id = make_project(root, db, "manual-adopt")
    for name in ("camera-master", "camera-jpeg", "manual-preview", "video-master", "mov_转码", "ordinary-progress", "manual-broll"):
        (project / name).mkdir()
    (project / "manual-broll" / "behind-scenes.jpg").write_bytes(b"jpg")
    (project / "manual-broll" / "behind-scenes.mp4").write_bytes(b"mp4")
    original = workspace_db.progress_adopt_media(str(root), db, {
        "projectName": "manual-adopt", "folderPath": str(project / "camera-master"),
        "mode": "original", "mediaKind": "image",
    })["progressFolder"]
    companion = workspace_db.progress_adopt_media(str(root), db, {
        "projectName": "manual-adopt", "folderPath": str(project / "camera-jpeg"),
        "mode": "companion", "mediaKind": "image", "sourceProgressId": original["id"],
    })["progressFolder"]
    preview = workspace_db.progress_adopt_media(str(root), db, {
        "projectName": "manual-adopt", "folderPath": str(project / "manual-preview"),
        "mode": "preview", "mediaKind": "image", "sourceProgressId": original["id"],
    })["progressFolder"]
    assert companion["artifactKind"] == "companion" and preview["artifactKind"] == "preview"
    assert edge_count(db, project_id, "media_companion") == 1
    assert edge_count(db, project_id, "derived_preview") == 1
    video_original = workspace_db.progress_adopt_media(str(root), db, {
        "projectName": "manual-adopt", "folderPath": str(project / "video-master"),
        "mode": "original", "mediaKind": "video",
    })["progressFolder"]
    transcode = workspace_db.progress_adopt_media(str(root), db, {
        "projectName": "manual-adopt", "folderPath": str(project / "mov_转码"),
        "mode": "transcode", "mediaKind": "video", "sourceProgressId": video_original["id"],
    })["progressFolder"]
    assert transcode["artifactKind"] == "transcode"
    assert edge_count(db, project_id, "derived_transcode") == 1
    broll_result = workspace_db.progress_adopt_media(str(root), db, {
        "projectName": "manual-adopt", "folderPath": str(project / "manual-broll"),
        "mode": "broll", "mediaKind": "mixed",
    })
    broll = broll_result["progressFolder"]
    assert broll["nodeRole"] == "broll" and broll["mediaKind"] == "mixed"
    assert broll.get("parentProgressId") is None and broll.get("relationKind") is None and broll.get("artifactKind") is None
    assert not broll["trackingEnabled"] and broll["trackingState"] == "disabled"
    assert edge_count(db, project_id, "media_companion") == 1 and edge_count(db, project_id, "derived_preview") == 1
    assert edge_count(db, project_id, "derived_transcode") == 1
    repeated_broll = workspace_db.progress_adopt_media(str(root), db, {
        "projectName": "manual-adopt", "folderPath": str(project / "manual-broll"),
        "mode": "broll", "mediaKind": "mixed",
    })
    assert repeated_broll["created"] is False and repeated_broll["progressFolder"]["id"] == broll["id"]
    reloaded_broll = next(node for node in workspace_db.progress_list(str(root), db, {"projectName": "manual-adopt"})["progressFolders"] if node["id"] == broll["id"])
    assert reloaded_broll["nodeRole"] == "broll" and reloaded_broll["mediaKind"] == "mixed", "broll must survive an ordinary reload"
    tracked = workspace_db.progress_register(str(root), db, {
        "projectName": "manual-adopt", "mediaKind": "image", "versionKey": "tracked",
        "displayName": "Tracked", "folderPath": str(project / "ordinary-progress"),
        "nodeRole": "progress", "parentProgressId": original["id"], "relationKind": "main",
        "trackingEnabled": True, "trackingState": "ready",
    })["progressFolder"]
    try:
        workspace_db.progress_adopt_media(str(root), db, {
            "projectName": "manual-adopt", "folderPath": str(project / "ordinary-progress"),
            "mode": "original", "mediaKind": "image",
        })
        raise AssertionError("tracked progress must not be converted into original media")
    except ValueError as error:
        assert "media_adopt_role_conflict" in str(error)
    assert db.execute("SELECT node_role FROM progress_folders WHERE id=?", (tracked["id"],)).fetchone()[0] == "progress"


def test_selection_mainline_repair(root: Path, db):
    project, project_id = make_project(root, db, "selection-mainline-repair")
    for name in ("source", "selection", "progress"):
        (project / name).mkdir()
    raw = workspace_db.progress_register(str(root), db, {
        "projectName": "selection-mainline-repair", "mediaKind": "image", "versionKey": "raw",
        "displayName": "Source", "folderPath": str(project / "source"), "nodeRole": "original",
        "trackingEnabled": False,
    })["progressFolder"]
    selection = workspace_db.progress_register(str(root), db, {
        "projectName": "selection-mainline-repair", "mediaKind": "image", "versionKey": "selection",
        "displayName": "Selection", "folderPath": str(project / "selection"), "nodeRole": "selection",
        "relationKind": "auxiliary", "parentProgressId": raw["id"], "trackingEnabled": False,
    })["progressFolder"]
    progress = workspace_db.progress_register(str(root), db, {
        "projectName": "selection-mainline-repair", "mediaKind": "image", "versionKey": "1",
        "displayName": "Progress 1", "folderPath": str(project / "progress"), "nodeRole": "progress",
        "relationKind": "main", "parentProgressId": raw["id"], "trackingEnabled": False,
    })["progressFolder"]
    workspace_db.version_tree_layout_save(db, {
        "projectName": "selection-mainline-repair", "scopeKey": "", "expectedRevision": 0,
        "mode": "patch", "positions": [{"nodeKey": f"progress:{progress['id']}", "x": 10, "y": 500}],
    })
    parent_triggers = db.execute(
        """SELECT name,sql FROM sqlite_master WHERE type='trigger'
             AND name IN ('progress_folders_v2_parent_update','progress_folders_parent_validate_update')"""
    ).fetchall()
    for trigger in parent_triggers:
        db.execute(f'DROP TRIGGER "{trigger["name"]}"')
    db.execute("UPDATE progress_folders SET parent_progress_id=? WHERE id=?", (selection["id"], progress["id"]))
    for trigger in parent_triggers:
        db.execute(trigger["sql"])
    db.commit()
    try:
        workspace_db._check_integrity(db, force=True)
        raise AssertionError("legacy selection-owned progress must fail the parent-role business check")
    except RuntimeError as error:
        assert "progress_folders.v2_parent_role" in str(error)

    with db:
        assert workspace_db.repair_selection_workflow_mainlines(db, project_id) == 1
    repaired = db.execute("SELECT parent_progress_id,relation_kind FROM progress_folders WHERE id=?", (progress["id"],)).fetchone()
    assert tuple(repaired) == (raw["id"], "main")
    assert db.execute(
        """SELECT COUNT(*) FROM version_graph_edges WHERE project_id=? AND source_progress_id=?
           AND target_progress_id=? AND edge_kind='workflow_input'""",
        (project_id, selection["id"], progress["id"]),
    ).fetchone()[0] == 1
    assert db.execute("SELECT 1 FROM version_tree_layouts WHERE project_id=?", (project_id,)).fetchone() is None
    with db:
        assert workspace_db.repair_selection_workflow_mainlines(db, project_id) == 0
    workspace_db._check_integrity(db, force=True)


def test_import_role_conversion_rejects_structural_children(root: Path, db):
    project, _project_id = make_project(root, db, "role-conversion-children")
    for name in ("camera", "camera-v1"):
        (project / name).mkdir()
    camera = workspace_db.progress_register(str(root), db, {
        "projectName": "role-conversion-children", "mediaKind": "image", "versionKey": "camera-source",
        "displayName": "camera", "folderPath": str(project / "camera"), "nodeRole": "original", "trackingEnabled": False,
    })["progressFolder"]
    workspace_db.progress_register(str(root), db, {
        "projectName": "role-conversion-children", "mediaKind": "image", "versionKey": "1",
        "displayName": "camera-v1", "folderPath": str(project / "camera-v1"), "nodeRole": "progress",
        "parentProgressId": camera["id"], "relationKind": "main", "trackingEnabled": False,
    })
    try:
        workspace_db.media_workflow_import_commit(str(root), db, {
            "schemaVersion": 2, "projectName": "role-conversion-children", "importSessionId": "camera-companion",
            "artifacts": [{"relativePath": "camera", "mediaKind": "image", "importSlot": "camera_jpg", "displayName": "camera"}],
        })
        raise AssertionError("original with structural children was converted to companion")
    except ValueError as error:
        assert "import_graph_role_conflict" in str(error) and "结构子节点" in str(error)
    assert db.execute("SELECT node_role,artifact_kind FROM progress_folders WHERE id=?", (camera["id"],)).fetchone()[:] == ("original", None)

def main():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary) / "workspace"
        root.mkdir()
        db = workspace_db.connect(str(root), str(Path(temporary) / "workspace.db"))
        try:
            test_idempotency_and_session_conflict(root, db)
            test_existing_progress_is_never_overwritten(root, db)
            test_cross_batch_relations(root, db)
            test_generated_camera_promotion(root, db)
            test_atomic_rollback_and_retry(root, db)
            test_legacy_canonical_graph_migration(root, db)
            test_late_canonical_reconciliation(root, db)
            test_safe_import_adoption_and_multiple_groups(root, db)
            test_import_mapping_follows_external_rename(root, db)
            test_manual_media_adoption(root, db)
            test_selection_mainline_repair(root, db)
            test_import_role_conversion_rejects_structural_children(root, db)
        finally:
            db.close()
    print("media workflow graph database tests passed")


if __name__ == "__main__":
    main()
