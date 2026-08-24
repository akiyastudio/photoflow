from __future__ import annotations

import sqlite3
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db  # noqa: E402
from compatibility.team_retouch_v1.storage import database_path_for_workspace_database, restore_project, snapshot  # noqa: E402


def main():
    with tempfile.TemporaryDirectory(prefix="photoflow-team-storage-") as temporary:
        temporary_root = Path(temporary)
        workspace = temporary_root / "workspace"
        workspace.mkdir()
        database = temporary_root / "workspace-data" / "isolated.sqlite3"
        now = int(time.time() * 1000)

        db = workspace_db.connect(str(workspace), str(database), include_compatibility=True)
        db.execute(
            """INSERT INTO projects(id,name,status,relative_path,is_deleted,created_at,updated_at,extra_json)
               VALUES('project-1','项目 1','后期中','项目 1',1,?,?, '{}')""",
            (now, now),
        )
        db.execute(
            """INSERT INTO projects(id,name,status,relative_path,is_deleted,created_at,updated_at,extra_json)
               VALUES('project-recreate','待重建项目','后期中','待重建项目',1,?,?, '{}')""",
            (now, now),
        )
        db.execute(
            """INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at)
               VALUES('identity-1','project-1','人物 1','#2563eb',?,?)""",
            (now, now),
        )
        db.execute(
            """INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at)
               VALUES('identity-recreate','project-recreate','待清理人物','#2563eb',?,?)""",
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

        recreated_project = workspace_db.mutate(str(workspace), str(database), "add", {
            "name": "待重建项目", "status": "策划中", "relativePath": "待重建项目", "extra": {},
        })
        assert recreated_project["success"] is True
        recreated_check = workspace_db.connect(str(workspace), str(database), include_compatibility=True)
        try:
            replacement = recreated_check.execute(
                "SELECT id,is_deleted FROM projects WHERE name='待重建项目'"
            ).fetchone()
            assert replacement is not None and replacement["id"] != "project-recreate" and not replacement["is_deleted"]
            assert recreated_check.execute(
                "SELECT 1 FROM team_person_identities WHERE id='identity-recreate'"
            ).fetchone() is None, "recreating a retired project name must clean its detached team rows"
        finally:
            recreated_check.close()

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
        workflow = next(item for item in progress["progressFolders"] if item["nodeRole"] == "workflow")
        assert workflow["artifactKind"] == "team_workspace"
        assert workflow["sourceMetadata"]["parentCapability"] == "workflow-input"
        progress_only.close()

        # A core schema upgrade used to recreate empty legacy team tables after
        # media/versioning had already moved out of main. Merely preparing a
        # project DELETE then tried to resolve their stale main.versions FK.
        recreated = sqlite3.connect(database)
        recreated.execute("PRAGMA foreign_keys=ON")
        recreated.execute(
            """CREATE TABLE team_retouch_photos(
                 photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
                 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                 base_version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
                 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"""
        )
        try:
            recreated.execute(
                "DELETE FROM projects WHERE is_deleted=1 AND name='does-not-exist'"
            )
            raise AssertionError("the fixture must reproduce the stale main.versions failure")
        except sqlite3.OperationalError as error:
            assert "main.versions" in str(error)
        finally:
            recreated.close()

        added = workspace_db.mutate(str(workspace), str(database), "add", {
            "name": "项目 3", "status": "策划中", "relativePath": "项目 3", "extra": {},
        })
        assert added["success"] is True
        cleaned_workspace = sqlite3.connect(database)
        try:
            assert cleaned_workspace.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_retouch_photos'"
            ).fetchone() is None, "catalog writes must retire empty recreated team tables"
        finally:
            cleaned_workspace.close()

        # Never drop a recreated table that gained rows. A team-aware open must
        # copy those rows to the detached store before retiring the old table.
        stranded = sqlite3.connect(database)
        stranded.execute("PRAGMA foreign_keys=ON")
        stranded.execute(
            """CREATE TABLE team_person_identities(
                 id TEXT PRIMARY KEY,
                 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                 name TEXT NOT NULL,color TEXT NOT NULL DEFAULT '#2563eb',
                 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"""
        )
        stranded.execute(
            """CREATE TABLE team_retouch_photos(
                 photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
                 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                 base_version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
                 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"""
        )
        stranded.execute(
            """INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at)
               VALUES('identity-2','project-2','人物 2','#2563eb',?,?)""",
            (now, now),
        )
        stranded.commit()
        stranded.close()

        guarded_add = workspace_db.mutate(str(workspace), str(database), "add", {
            "name": "项目 4", "status": "策划中", "relativePath": "项目 4", "extra": {},
        })
        assert guarded_add["success"] is True, (
            "a new name must not prepare the legacy project DELETE when no retired row exists"
        )

        catalog_only = workspace_db.connect(str(workspace), str(database), include_domains=False)
        try:
            assert catalog_only.execute(
                "SELECT name FROM main.team_person_identities WHERE id='identity-2'"
            ).fetchone()[0] == "人物 2", "non-empty legacy data must not be dropped by catalog cleanup"
        finally:
            catalog_only.close()
        migrated_team = workspace_db.connect(str(workspace), str(database), include_compatibility=True)
        try:
            assert migrated_team.execute(
                "SELECT name FROM team_person_identities WHERE id='identity-2'"
            ).fetchone()[0] == "人物 2"
            assert migrated_team.execute(
                "SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='team_person_identities'"
            ).fetchone() is None
        finally:
            migrated_team.close()

        team_snapshot = temporary_root / "snapshots" / "team-retouch.sqlite3"
        assert snapshot(str(team_database), str(team_snapshot))["schemaVersion"] == 1

        reopened = workspace_db.connect(str(workspace), str(database), include_compatibility=True)
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
