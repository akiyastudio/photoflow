import os
import sqlite3
import tempfile
import unittest

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from workspace_db import media_versions_snapshot


class ComponentVersionSnapshotTest(unittest.TestCase):
    def test_snapshot_is_bounded_scoped_and_side_effect_free(self):
        with tempfile.TemporaryDirectory() as temporary:
            project_path = os.path.join(temporary, "project")
            scope_path = os.path.join(project_path, "scope")
            outside_path = os.path.join(project_path, "outside")
            os.makedirs(scope_path)
            os.makedirs(outside_path)
            db = sqlite3.connect(":memory:")
            db.row_factory = sqlite3.Row
            db.executescript("""
                CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,status TEXT);
                CREATE TABLE photos(id TEXT PRIMARY KEY,project_id TEXT,is_deleted INTEGER);
                CREATE TABLE versions(id TEXT PRIMARY KEY,photo_id TEXT,parent_version_id TEXT,version_number INTEGER,version_name TEXT,version_type TEXT,file_path_key TEXT,status TEXT,note TEXT,is_current INTEGER,is_final INTEGER,file_missing INTEGER,content_changed INTEGER,created_at INTEGER,updated_at INTEGER,is_deleted INTEGER);
            """)
            db.execute("INSERT INTO projects VALUES('project-1','Project','active')")
            db.execute("INSERT INTO photos VALUES('photo-1','project-1',0)")
            rows = [
                ("v1", "photo-1", None, 1, "Inside", "original", os.path.join(scope_path, "one.jpg").casefold(), "ready", "", 1, 0, 0, 0, 10, 11, 0),
                ("v2", "photo-1", "v1", 2, "Outside", "edit", os.path.join(outside_path, "two.jpg").casefold(), "draft", "", 0, 0, 0, 0, 20, 21, 0),
            ]
            db.executemany("INSERT INTO versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            db.commit()
            changes = db.total_changes
            result = media_versions_snapshot(db, {"projectName": "Project", "projectPath": project_path, "scopePath": scope_path, "limit": 10})
            self.assertEqual([item["id"] for item in result["versions"]], ["v1"])
            self.assertFalse(result["truncated"])
            self.assertEqual(db.total_changes, changes)
            self.assertNotIn("filePath", result["versions"][0])
            with self.assertRaisesRegex(ValueError, "scope_invalid"):
                media_versions_snapshot(db, {"projectName": "Project", "projectPath": project_path, "scopePath": temporary, "limit": 10})
            with self.assertRaisesRegex(ValueError, "limit_invalid"):
                media_versions_snapshot(db, {"projectName": "Project", "projectPath": project_path, "scopePath": scope_path, "limit": 5001})


if __name__ == "__main__":
    unittest.main()
