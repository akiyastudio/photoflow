from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db  # noqa: E402
from workspace_db_domains import ALL_ACTIONS, PROGRESS_ACTIONS, READ_ONLY_ACTIONS, VERSIONING_ONLY_ACTIONS  # noqa: E402
from workspace_domain_storage import database_path_for_workspace_database  # noqa: E402


def main() -> None:
    action = "progress_locations_snapshot"
    assert action in PROGRESS_ACTIONS
    assert action in VERSIONING_ONLY_ACTIONS
    assert action in ALL_ACTIONS, "the CLI action choices are built from ALL_ACTIONS"
    assert action not in READ_ONLY_ACTIONS, "location refresh synchronizes path, identity, and missing state"

    with tempfile.TemporaryDirectory(prefix="photoflow-progress-routing-") as temporary:
        base = Path(temporary)
        workspace = base / "workspace"
        project = workspace / "26-8-16 Ro迂的盗墓笔记"
        names = ("JPG", "raw", "图片选片", "调色", "修脸2")
        for name in names:
            (project / name).mkdir(parents=True, exist_ok=True)
        database = base / "catalog.sqlite3"
        now = int(time.time() * 1000)
        db = workspace_db.connect(str(workspace), str(database), include_domains=True)
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            ("project", project.name, "后期中", project.name, now, now),
        )
        nodes = (
            ("raw", "0", None, "raw", "original", None, None),
            ("jpg", "source-jpg", None, "JPG", "original", "companion", None),
            ("selection", "selection", "raw", "图片选片", "selection", None, "auxiliary"),
            ("color", "1", "raw", "调色", "progress", None, "main"),
            ("retouch", "2", "color", "修脸2", "progress", None, "main"),
        )
        for node_id, version_key, parent_id, display_name, role, artifact_kind, relation_kind in nodes:
            folder = (project / display_name).resolve()
            db.execute(
                """INSERT INTO progress_folders(
                     id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,
                     folder_path_key,node_role,artifact_kind,relation_kind,tracking_enabled,tracking_state,
                     rename_from_parent,copy_missing_from_parent,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (node_id, "project", "image", version_key, parent_id, display_name, str(folder),
                 str(folder).casefold(), role, artifact_kind, relation_kind, 0, "disabled", 0, 0, now, now),
            )
        db.execute(
            "INSERT INTO version_graph_edges(id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            ("edge-companion", "project", "raw", "jpg", "media_companion", now, now),
        )
        db.execute(
            "INSERT INTO version_graph_edges(id,project_id,source_progress_id,target_progress_id,edge_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            ("edge-selection", "project", "selection", "retouch", "workflow_input", now, now),
        )
        db.execute("INSERT INTO version_tree_layouts(project_id,scope_key,revision,updated_at) VALUES(?,?,?,?)", ("project", "", 24, now))
        db.execute("INSERT INTO version_tree_node_positions(project_id,scope_key,node_key,x,y,updated_at) VALUES(?,?,?,?,?,?)", ("project", "", "entry:user-layout", 123.5, 456.25, now))
        db.commit()
        db.close()
        (project / "修脸2").rmdir()

        core = sqlite3.connect(database)
        try:
            assert core.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='progress_folders'").fetchone() is None
        finally:
            core.close()
        versioning = sqlite3.connect(database_path_for_workspace_database(str(database), "versioning"))
        try:
            assert versioning.execute("SELECT COUNT(*) FROM progress_folders").fetchone()[0] == 5
            assert versioning.execute("SELECT COUNT(*) FROM version_graph_edges").fetchone()[0] == 2
            layout_before = versioning.execute("SELECT project_id,scope_key,revision,updated_at FROM version_tree_layouts ORDER BY project_id,scope_key").fetchall()
            positions_before = versioning.execute("SELECT project_id,scope_key,node_key,x,y,updated_at FROM version_tree_node_positions ORDER BY project_id,scope_key,node_key").fetchall()
        finally:
            versioning.close()

        request = json.dumps({
            "id": "routing-regression", "action": action, "root": str(workspace),
            "database": str(database), "payload": {"projectName": project.name, "includeMissing": True},
        }, ensure_ascii=False)
        completed = subprocess.run(
            [sys.executable, str(ROOT / "python" / "workspace_db.py"), "--server"],
            input=request + "\n", text=True, encoding="utf-8", capture_output=True, check=True,
        )
        response = json.loads(completed.stdout.strip())
        assert response["success"] is True, response
        result = response["result"]
        assert {item["displayName"] for item in result["progressFolders"]} == set(names)
        assert len(result["progressFolders"]) == 5
        assert len(result["graphEdges"]) == 2
        by_name = {item["displayName"]: item for item in result["progressFolders"]}
        assert all(by_name[name]["folderId"] for name in names if name != "修脸2"), "online location identities must persist"
        assert by_name["修脸2"]["folderMissing"] is True and by_name["修脸2"]["missingSince"] is not None
        versioning = sqlite3.connect(database_path_for_workspace_database(str(database), "versioning"))
        try:
            assert versioning.execute("SELECT project_id,scope_key,revision,updated_at FROM version_tree_layouts ORDER BY project_id,scope_key").fetchall() == layout_before
            assert versioning.execute("SELECT project_id,scope_key,node_key,x,y,updated_at FROM version_tree_node_positions ORDER BY project_id,scope_key,node_key").fetchall() == positions_before
            assert versioning.execute("SELECT missing_since FROM progress_folders WHERE id='retouch'").fetchone()[0] is not None
        finally:
            versioning.close()

    print("progress location server/domain routing tests passed")


if __name__ == "__main__":
    main()
