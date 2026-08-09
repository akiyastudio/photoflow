import importlib.util
import json
import os
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = REPOSITORY_ROOT / "python" / "workspace_db.py"
SPEC = importlib.util.spec_from_file_location("workspace_db_v2", MODULE_PATH)
workspace_db = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace_db)


def create_schema_17_database(database: Path, workspace: Path) -> None:
    database.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(database)
    db.executescript(
        """
        PRAGMA foreign_keys=ON;
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE projects(
          id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE,status TEXT NOT NULL,
          relative_path TEXT NOT NULL UNIQUE,filesystem_id TEXT,is_deleted INTEGER NOT NULL DEFAULT 0,
          availability TEXT NOT NULL DEFAULT 'available',missing_since INTEGER,missing_checks INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,extra_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE progress_folders(
          id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          media_kind TEXT NOT NULL,version_key TEXT NOT NULL,parent_progress_id TEXT REFERENCES progress_folders(id),
          display_name TEXT NOT NULL,folder_path TEXT NOT NULL,folder_path_key TEXT NOT NULL,folder_id TEXT,
          tracking_enabled INTEGER NOT NULL DEFAULT 0,tracking_state TEXT NOT NULL DEFAULT 'disabled',
          missing_since INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
          UNIQUE(project_id,media_kind,version_key)
        );
        INSERT INTO meta VALUES('schema_version','17');
        """
    )
    project = workspace / "Legacy"
    raw = project / "RAW"
    main = project / "调色_1"
    underscored = project / "调色_1_1"
    for folder in (raw, main, underscored):
        folder.mkdir(parents=True, exist_ok=True)
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('legacy-project','Legacy','后期中','Legacy',?,?)",
        (now, now),
    )
    rows = (
        ("legacy-raw", "image", "0", None, "RAW", raw, 0, "disabled"),
        ("legacy-main", "image", "1", "legacy-raw", "调色_1", main, 1, "ready"),
        ("legacy-underscore", "image", "1_1", "legacy-main", "调色_1_1", underscored, 0, "pending_compare"),
    )
    for node_id, media_kind, version_key, parent_id, display_name, folder, enabled, state in rows:
        db.execute(
            """INSERT INTO progress_folders(
                 id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,
                 folder_path_key,tracking_enabled,tracking_state,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (node_id, "legacy-project", media_kind, version_key, parent_id, display_name,
             str(folder.resolve()), str(folder.resolve()).casefold(), enabled, state, now, now),
        )
    db.commit()
    db.close()


def test_schema_17_upgrade(root: Path) -> None:
    workspace = root / "legacy-workspace"
    database = root / "legacy.sqlite3"
    create_schema_17_database(database, workspace)
    db = workspace_db.connect(str(workspace), str(database))
    try:
        assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "21"
        columns = {row[1] for row in db.execute("PRAGMA table_info(progress_folders)")}
        assert {"node_role", "relation_kind", "rename_from_parent", "copy_missing_from_parent",
                "last_tracked_at", "tracking_snapshot_json", "folder_signature", "tombstone_json"} <= columns
        session_columns = {row[1] for row in db.execute("PRAGMA table_info(tracking_sessions)")}
        item_columns = {row[1] for row in db.execute("PRAGMA table_info(tracking_session_items)")}
        assert {"progress_id", "parent_progress_id", "mode", "status", "rename_from_parent",
                "copy_missing_from_parent", "committed_batch_id"} <= session_columns
        assert {"session_id", "item_kind", "source_name", "reference_name", "target_name", "status"} <= item_columns
        rows = {row["id"]: row for row in db.execute("SELECT * FROM progress_folders")}
        assert rows["legacy-raw"]["node_role"] == "original"
        assert rows["legacy-raw"]["relation_kind"] is None
        assert rows["legacy-main"]["node_role"] == "progress" and rows["legacy-main"]["relation_kind"] == "main"
        assert rows["legacy-main"]["parent_progress_id"] == "legacy-raw"
        assert rows["legacy-main"]["tracking_enabled"] == 1 and rows["legacy-main"]["tracking_state"] == "ready"
        # An underscore is legacy numbering only. It remains a main edge and
        # keeps its parent rather than being guessed into an auxiliary branch.
        assert rows["legacy-underscore"]["node_role"] == "progress"
        assert rows["legacy-underscore"]["relation_kind"] == "main"
        assert rows["legacy-underscore"]["parent_progress_id"] == "legacy-main"
        assert rows["legacy-underscore"]["tracking_enabled"] == 1
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT COUNT(*) FROM progress_relation_repair_log").fetchone()[0] == 0
        backup_path = db.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0]
        assert Path(backup_path).is_file()
        backup = sqlite3.connect(backup_path)
        try:
            assert backup.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "17"
        finally:
            backup.close()
        workspace_db._check_integrity(db, force=True)
    finally:
        db.close()
    reopened = workspace_db.connect(str(workspace), str(database))
    try:
        assert reopened.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "21"
        assert reopened.execute("SELECT COUNT(*) FROM progress_folders").fetchone()[0] == 3
        assert reopened.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        reopened.close()


def test_schema_17_cycle_repairs(root: Path) -> None:
    cases = {
        "self": {
            "updates": [("legacy-raw", "legacy-raw")],
            "cycle": ["legacy-raw"],
        },
        "two": {
            "updates": [("legacy-main", "legacy-underscore"), ("legacy-underscore", "legacy-main")],
            "cycle": ["legacy-main", "legacy-underscore"],
        },
    }
    for case_name, case in cases.items():
        workspace = root / f"cycle-{case_name}-workspace"
        database = root / f"cycle-{case_name}.sqlite3"
        create_schema_17_database(database, workspace)
        legacy = sqlite3.connect(database)
        try:
            for node_id, parent_id in case["updates"]:
                legacy.execute("UPDATE progress_folders SET parent_progress_id=? WHERE id=?", (parent_id, node_id))
            legacy.commit()
        finally:
            legacy.close()

        db = workspace_db.connect(str(workspace), str(database))
        try:
            assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "21"
            assert workspace_db._progress_relation_cycles(db) == []
            expected_cycle = sorted(case["cycle"])
            repaired_id = min(expected_cycle)
            repaired = db.execute(
                "SELECT parent_progress_id,relation_kind,node_role FROM progress_folders WHERE id=?",
                (repaired_id,),
            ).fetchone()
            assert repaired["parent_progress_id"] is None and repaired["relation_kind"] is None
            assert repaired["node_role"] == "progress"
            repair_log = db.execute("SELECT * FROM progress_relation_repair_log").fetchall()
            assert len(repair_log) == 1
            assert repair_log[0]["repaired_progress_id"] == repaired_id
            assert json.loads(repair_log[0]["cycle_node_ids_json"]) == expected_cycle
            assert repair_log[0]["repair_kind"] == "legacy_cycle_rooted"
            trigger_sql = "\n".join(row[0] for row in db.execute(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'progress_folders_v2_cycle_%' ORDER BY name"
            ).fetchall())
            assert "UNION ALL" not in trigger_sql.upper() and " UNION\n" in trigger_sql.upper()
            workspace_db._check_integrity(db, force=True)
            backup_path = Path(db.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0])
            assert backup_path.is_file()
            backup = sqlite3.connect(backup_path)
            try:
                assert backup.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "17"
                assert backup.execute("SELECT parent_progress_id FROM progress_folders WHERE id=?", (repaired_id,)).fetchone()[0] is not None
            finally:
                backup.close()
        finally:
            db.close()


def test_schema_19_cycle_repair(root: Path) -> None:
    """Databases already marked V2 must also receive the repair migration."""
    workspace = root / "schema-19-cycle-workspace"
    database = root / "schema-19-cycle.sqlite3"
    create_schema_17_database(database, workspace)
    upgraded = workspace_db.connect(str(workspace), str(database))
    upgraded.close()

    legacy_v2 = sqlite3.connect(database)
    try:
        legacy_v2.executescript(
            """DROP TRIGGER IF EXISTS progress_folders_v2_cycle_insert;
               DROP TRIGGER IF EXISTS progress_folders_v2_cycle_update;"""
        )
        legacy_v2.execute("UPDATE progress_folders SET parent_progress_id='legacy-underscore',relation_kind='main' WHERE id='legacy-main'")
        legacy_v2.execute("UPDATE progress_folders SET parent_progress_id='legacy-main',relation_kind='main' WHERE id='legacy-underscore'")
        legacy_v2.execute("UPDATE meta SET value='19' WHERE key='schema_version'")
        legacy_v2.commit()
    finally:
        legacy_v2.close()

    repaired = workspace_db.connect(str(workspace), str(database))
    try:
        assert repaired.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "21"
        assert workspace_db._progress_relation_cycles(repaired) == []
        latest_log = repaired.execute("SELECT * FROM progress_relation_repair_log ORDER BY id DESC LIMIT 1").fetchone()
        assert latest_log["repaired_progress_id"] == "legacy-main"
        assert json.loads(latest_log["cycle_node_ids_json"]) == ["legacy-main", "legacy-underscore"]
        backup_path = Path(repaired.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0])
        backup = sqlite3.connect(backup_path)
        try:
            assert backup.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "19"
        finally:
            backup.close()
    finally:
        repaired.close()


def register(db, workspace: Path, **payload):
    return workspace_db.progress_register(str(workspace), db, {"projectName": "Project", **payload})["progressFolder"]


def test_v2_node_operations(root: Path) -> None:
    workspace = root / "workspace"
    project = workspace / "Project"
    raw_folder = project / "RAW"
    raw_folder.mkdir(parents=True)
    database = root / "v2.sqlite3"
    db = workspace_db.connect(str(workspace), str(database))
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('project','Project','后期中','Project',?,?)",
        (now, now),
    )
    db.commit()
    try:
        initial = workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]
        original = next(item for item in initial if item["nodeRole"] == "original" and item["displayName"] == "RAW")

        parent_folder = project / "调色一版"
        child_folder = project / "调色二版"
        selection_folder = project / "RAW_选片"
        stale_child_folder = project / "精修版"
        for folder in (parent_folder, child_folder, selection_folder, stale_child_folder):
            folder.mkdir()
        parent = register(
            db, workspace, mediaKind="image", versionKey="v1", displayName="调色一版",
            folderPath=str(parent_folder), nodeRole="progress", relationKind="main",
            parentProgressId=original["id"], trackingEnabled=True, renameFromParent=True,
            copyMissingFromParent=False, trackingState="ready", trackingSnapshot={"count": 10},
            folderSignature="sig-v1",
        )
        child = register(
            db, workspace, mediaKind="image", versionKey="v2", displayName="调色二版",
            folderPath=str(child_folder), nodeRole="progress", relationKind="main",
            parentProgressId=parent["id"], trackingEnabled=True, trackingState="ready",
        )
        selection = register(
            db, workspace, mediaKind="image", versionKey="selection-raw", displayName="RAW_选片",
            folderPath=str(selection_folder), nodeRole="selection", relationKind="auxiliary",
            parentProgressId=original["id"], trackingEnabled=False, trackingState="disabled",
        )
        assert parent["parentProgressId"] == original["id"] and parent["relationKind"] == "main"
        assert selection["parentProgressId"] == original["id"] and selection["relationKind"] == "auxiliary"
        assert not selection["trackingEnabled"] and not selection["renameFromParent"] and not selection["copyMissingFromParent"]

        # Explicit IDs, not version-key prefixes, define the subtree. Renaming
        # an arbitrary-key parent must still include its main child while the
        # child's unrelated display key remains stable.
        remapped = workspace_db.progress_update_tree(str(workspace), db, {
            "projectName": "Project", "primaryProgressId": parent["id"],
            "updates": [
                {"id": parent["id"], "mediaKind": "image", "versionKey": "renamed-main",
                 "displayName": parent["displayName"], "folderPath": str(parent_folder),
                 "parentProgressId": original["id"], "trackingEnabled": True, "trackingState": "ready"},
                {"id": child["id"], "mediaKind": "image", "versionKey": "v2",
                 "displayName": child["displayName"], "folderPath": str(child_folder),
                 "parentProgressId": parent["id"], "trackingEnabled": True, "trackingState": "ready"},
            ],
        })
        remapped_by_id = {item["id"]: item for item in remapped["progressFolders"]}
        assert remapped_by_id[parent["id"]]["versionKey"] == "renamed-main"
        assert remapped_by_id[child["id"]]["versionKey"] == "v2"
        assert remapped_by_id[child["id"]]["parentProgressId"] == parent["id"]

        blocked_folder = project / "非法选片"
        blocked_folder.mkdir()
        try:
            register(
                db, workspace, mediaKind="image", versionKey="blocked-selection", displayName="非法选片",
                folderPath=str(blocked_folder), nodeRole="selection", relationKind="auxiliary",
                parentProgressId=original["id"], trackingEnabled=True, trackingState="ready",
            )
            raise AssertionError("auxiliary tracking must be rejected")
        except ValueError as error:
            assert "禁止开启" in str(error)

        # Same-project, same-kind cycles are rejected by SQLite itself.
        try:
            db.execute(
                "UPDATE progress_folders SET parent_progress_id=?,relation_kind='main' WHERE id=?",
                (child["id"], parent["id"]),
            )
            raise AssertionError("cycle must be rejected")
        except sqlite3.IntegrityError as error:
            assert "cycle" in str(error)
            db.rollback()

        # Missing nodes disappear from the normal tree but remain queryable for takeover.
        selection_folder.rmdir()
        visible_ids = {item["id"] for item in workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})["progressFolders"]}
        assert selection["id"] not in visible_ids
        missing_rows = workspace_db.progress_list(
            str(workspace), db, {"projectName": "Project", "includeMissing": True}
        )["progressFolders"]
        missing_selection = next(item for item in missing_rows if item["id"] == selection["id"])
        assert missing_selection["folderMissing"] and missing_selection["missingSince"]
        replacement_folder = project / "重新生成的选片"
        replacement_folder.mkdir()
        replacement = register(
            db, workspace, mediaKind="image", versionKey="selection-raw", displayName="RAW_选片",
            folderPath=str(replacement_folder), nodeRole="selection", relationKind="auxiliary",
            parentProgressId=original["id"], trackingEnabled=False, trackingState="disabled",
        )
        assert replacement["id"] == selection["id"] and not replacement["folderMissing"]

        stale_child = register(
            db, workspace, mediaKind="image", versionKey="v3", displayName="精修版",
            folderPath=str(stale_child_folder), nodeRole="progress", relationKind="main",
            parentProgressId=child["id"], trackingEnabled=True, renameFromParent=True,
            copyMissingFromParent=True, trackingState="ready",
        )
        saved_policy = workspace_db.progress_policy_save(db, {
            "progressId": stale_child["id"], "trackingEnabled": True,
            "renameFromParent": True, "copyMissingFromParent": True,
        })["progressFolder"]
        assert saved_policy["renameFromParent"] and saved_policy["copyMissingFromParent"]
        stale_candidates = workspace_db.progress_copy_missing_children(db, {"progressId": child["id"]})
        assert stale_candidates["progressIds"] == [stale_child["id"]]
        assert workspace_db.progress_mark_stale(db, {"progressId": stale_child["id"]})["progressFolder"]["trackingState"] == "stale"
        ready = workspace_db.progress_mark_ready(db, {
            "progressId": stale_child["id"], "trackingSnapshot": {"files": 42},
            "folderSignature": "sig-v3", "trackedAt": now + 100,
        })["progressFolder"]
        assert ready["trackingState"] == "ready" and ready["trackingSnapshot"] == {"files": 42}

        # Tombstone cleanup reconnects the surviving child and never touches media.
        media_file = child_folder / "keep.jpg"
        media_file.write_bytes(b"user-media")
        parent_folder.rmdir()
        workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})
        db.execute("UPDATE progress_folders SET missing_since=1 WHERE id=?", (parent["id"],))
        db.commit()
        relations = workspace_db.progress_visible_relations(db, {"progressId": child["id"]})
        assert original["id"] in relations["visibleAncestorIds"] and parent["id"] not in relations["visibleAncestorIds"]
        db.close()
        maintenance = workspace_db.mutate(
            str(workspace), str(database), "maintenance_run", {"progressTombstoneCutoff": 1}
        )
        cleanup = maintenance["progressTombstones"]
        db = workspace_db.connect(str(workspace), str(database))
        assert cleanup["removedProgressIds"] == [parent["id"]] and cleanup["reparentedProgressCount"] == 1
        assert media_file.read_bytes() == b"user-media"
        reparented = db.execute("SELECT parent_progress_id,relation_kind FROM progress_folders WHERE id=?", (child["id"],)).fetchone()
        assert reparented[:] == (original["id"], "main")

        branch_ids = {item["id"] for item in workspace_db.progress_main_branch(db, {"progressId": child["id"]})["progressFolders"]}
        assert {original["id"], child["id"], stale_child["id"]} <= branch_ids
        assert selection["id"] not in branch_ids
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []

        # If a deleted original has only a surviving auxiliary selection child,
        # maintenance removes both relationship records but never touches the
        # real selection folder or its user media.
        orphan_source_folder = project / "孤立来源"
        orphan_selection_folder = project / "孤立来源_选片"
        orphan_source_folder.mkdir()
        orphan_selection_folder.mkdir()
        selected_media = orphan_selection_folder / "selected.jpg"
        selected_media.write_bytes(b"selected-user-media")
        orphan_source = register(
            db, workspace, mediaKind="image", versionKey="orphan-source", displayName="孤立来源",
            folderPath=str(orphan_source_folder), nodeRole="original", relationKind=None,
            parentProgressId=None, trackingEnabled=False, trackingState="disabled",
        )
        orphan_selection = register(
            db, workspace, mediaKind="image", versionKey="orphan-selection", displayName="孤立来源_选片",
            folderPath=str(orphan_selection_folder), nodeRole="selection", relationKind="auxiliary",
            parentProgressId=orphan_source["id"], trackingEnabled=False, trackingState="disabled",
        )
        orphan_source_folder.rmdir()
        workspace_db.progress_list(str(workspace), db, {"projectName": "Project"})
        db.execute("UPDATE progress_folders SET missing_since=1 WHERE id=?", (orphan_source["id"],))
        db.commit()
        db.close()
        orphan_maintenance = workspace_db.mutate(
            str(workspace), str(database), "maintenance_run", {"progressTombstoneCutoff": 1}
        )["progressTombstones"]
        db = workspace_db.connect(str(workspace), str(database))
        assert set(orphan_maintenance["removedProgressIds"]) == {orphan_source["id"], orphan_selection["id"]}
        assert orphan_maintenance["removedSelectionMetadataIds"] == [orphan_selection["id"]]
        assert orphan_source["id"] not in orphan_maintenance["skippedProgressIds"]
        assert db.execute(
            "SELECT COUNT(*) FROM progress_folders WHERE id IN (?,?)",
            (orphan_source["id"], orphan_selection["id"]),
        ).fetchone()[0] == 0
        assert orphan_selection_folder.is_dir() and selected_media.read_bytes() == b"selected-user-media"
        listed_paths = {Path(item["folderPath"]) for item in workspace_db.progress_list(
            str(workspace), db, {"projectName": "Project", "includeMissing": True}
        )["progressFolders"]}
        assert orphan_selection_folder.resolve() not in listed_paths
    finally:
        db.close()

    # Policies, snapshot, and last tracked state survive a real database reopen.
    reopened = workspace_db.connect(str(workspace), str(database))
    try:
        stored = workspace_db._progress_row_by_id(reopened, stale_child["id"])
        serialized = workspace_db.serialize_progress(stored)
        assert serialized["trackingEnabled"] and serialized["renameFromParent"] and serialized["copyMissingFromParent"]
        assert serialized["trackingState"] == "ready" and serialized["trackingSnapshot"] == {"files": 42}
        assert serialized["folderSignature"] == "sig-v3" and serialized["lastTrackedAt"] == now + 100
    finally:
        reopened.close()


def main() -> None:
    temp_root = Path(tempfile.mkdtemp(prefix="photoflow-versioning-v2-db-"))
    try:
        test_schema_17_upgrade(temp_root)
        test_schema_17_cycle_repairs(temp_root)
        test_schema_19_cycle_repair(temp_root)
        test_v2_node_operations(temp_root)
        print("versioning V2 database tests passed")
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
