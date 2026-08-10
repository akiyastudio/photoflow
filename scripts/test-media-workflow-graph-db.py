import copy
import json
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
        "mediaKind": "video" if slot in ("mov", "video_preview") else "image",
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
        artifact("source-d", "video_preview", "预览"),
    ]
    first = commit(root, db, "idempotent", "same-session", items)
    second = commit(root, db, "idempotent", "same-session", list(reversed(items)))
    assert [node["id"] for node in first["nodes"]] == [node["id"] for node in second["nodes"]]
    assert db.execute("SELECT COUNT(*) FROM progress_folders WHERE project_id=?", (project_id,)).fetchone()[0] == 4
    assert db.execute("SELECT COUNT(*) FROM media_import_artifact_slots WHERE project_id=?", (project_id,)).fetchone()[0] == 4
    assert edge_count(db, project_id, "media_companion") == 1
    assert edge_count(db, project_id, "derived_preview") == 1
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
    original = workspace_db.progress_register(str(root), db, {
        "projectName": "role-conflict",
        "mediaKind": "image",
        "versionKey": "manual-progress",
        "displayName": "Manual progress",
        "folderPath": str(folder),
        "nodeRole": "progress",
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
    for name in ("image-source", "camera-output", "video-source", "preview-output"):
        (project / name).mkdir()
    commit(root, db, "cross-batch", "raw-only", [artifact("image-source", "raw")])
    assert edge_count(db, project_id, "media_companion") == 0
    commit(root, db, "cross-batch", "camera-later", [artifact("camera-output", "camera_jpg")])
    assert edge_count(db, project_id, "media_companion") == 1
    commit(root, db, "cross-batch", "mov-only", [artifact("video-source", "mov")])
    assert edge_count(db, project_id, "derived_preview") == 0
    commit(root, db, "cross-batch", "preview-later", [artifact("preview-output", "video_preview")])
    assert edge_count(db, project_id, "derived_preview") == 1


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


def main():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary) / "workspace"
        root.mkdir()
        db = workspace_db.connect(str(root), str(Path(temporary) / "workspace.db"))
        test_idempotency_and_session_conflict(root, db)
        test_existing_progress_is_never_overwritten(root, db)
        test_cross_batch_relations(root, db)
        test_generated_camera_promotion(root, db)
        test_atomic_rollback_and_retry(root, db)
        db.close()
    print("media workflow graph database tests passed")


if __name__ == "__main__":
    main()
