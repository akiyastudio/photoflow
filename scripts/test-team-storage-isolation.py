from __future__ import annotations

import sqlite3
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db  # noqa: E402
from team_retouch_storage import database_path_for_workspace_database, restore_project, snapshot  # noqa: E402


def main():
    with tempfile.TemporaryDirectory(prefix="photoflow-team-storage-") as temporary:
        temporary_root = Path(temporary)
        workspace = temporary_root / "workspace"
        workspace.mkdir()
        database = temporary_root / "workspace-data" / "isolated.sqlite3"
        now = int(time.time() * 1000)

        db = workspace_db.connect(str(workspace), str(database), include_team=True)
        db.execute(
            """INSERT INTO projects(id,name,status,relative_path,is_deleted,created_at,updated_at,extra_json)
               VALUES('project-1','项目 1','后期中','项目 1',1,?,?, '{}')""",
            (now, now),
        )
        db.execute(
            """INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at)
               VALUES('identity-1','project-1','人物 1','#2563eb',?,?)""",
            (now, now),
        )
        db.commit()
        db.close()

        team_database = Path(database_path_for_workspace_database(str(database)))
        assert team_database.is_file()
        raw_workspace = sqlite3.connect(database)
        try:
            main_team_tables = raw_workspace.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'team_%'"
            ).fetchall()
            assert main_team_tables == [], "workspace.sqlite3 must not retain team-owned tables"
        finally:
            raw_workspace.close()

        raw_team = sqlite3.connect(team_database)
        try:
            assert raw_team.execute(
                "SELECT name FROM team_person_identities WHERE id='identity-1'"
            ).fetchone()[0] == "人物 1"
        finally:
            raw_team.close()

        # Progress-only workers deliberately do not attach the team store. A
        # canonical team-workspace directory must still be discoverable without
        # the legacy graph reconciler querying an unavailable team table.
        project_path = workspace / "项目 2"
        (project_path / "团片协作").mkdir(parents=True)
        progress_only = workspace_db.connect(str(workspace), str(database), include_domains=True)
        attached = {row[1] for row in progress_only.execute("PRAGMA database_list").fetchall()}
        assert "team_retouch" not in attached
        progress_only.execute(
            """INSERT INTO projects(id,name,status,relative_path,is_deleted,created_at,updated_at,extra_json)
               VALUES('project-2','项目 2','后期中','项目 2',0,?,?, '{}')""",
            (now, now),
        )
        progress_only.commit()
        progress = workspace_db.progress_list(
            str(workspace), progress_only, {"projectName": "项目 2"}
        )
        assert any(
            item["nodeRole"] == "workflow" and item["artifactKind"] == "team_workspace"
            for item in progress["progressFolders"]
        )
        progress_only.close()

        team_snapshot = temporary_root / "snapshots" / "team-retouch.sqlite3"
        assert snapshot(str(team_database), str(team_snapshot))["schemaVersion"] == 1

        reopened = workspace_db.connect(str(workspace), str(database), include_team=True)
        assert reopened.execute(
            "SELECT name FROM team_person_identities WHERE id='identity-1'"
        ).fetchone()[0] == "人物 1", "runtime queries must resolve the attached team-retouch store"
        result = workspace_db.purge_deleted_project(reopened, {"projectId": "project-1", "undoRecords": []})
        assert result["success"] is True
        workspace_db.team_project_purge(reopened, result["teamCleanup"])
        assert reopened.execute(
            "SELECT 1 FROM team_person_identities WHERE project_id='project-1'"
        ).fetchone() is None, "project cleanup must explicitly delete cross-store team data"
        reopened.close()

        restored = restore_project(
            str(team_snapshot), str(team_database), "project-1", []
        )
        assert restored["success"] is True
        restored_team = sqlite3.connect(team_database)
        try:
            assert restored_team.execute(
                "SELECT name FROM team_person_identities WHERE id='identity-1'"
            ).fetchone()[0] == "人物 1", "project restore must recover team-owned rows"
        finally:
            restored_team.close()

    print("Team-retouch storage isolation tests passed.")


if __name__ == "__main__":
    main()
