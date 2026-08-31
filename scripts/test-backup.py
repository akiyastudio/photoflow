import os
import json
import shutil
import sqlite3
import sys
import tempfile
import time


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON_ROOT = os.path.join(ROOT, "python")
if PYTHON_ROOT not in sys.path:
    sys.path.insert(0, PYTHON_ROOT)

import backup_db
import workspace_db


def main():
    temporary_root = tempfile.mkdtemp(prefix="photoflow-backup-test-")
    try:
        old_root = os.path.join(temporary_root, "old-workspace")
        old_data_root = os.path.join(temporary_root, "old-data")
        project_relative = "待处理\示例项目"
        project_root = os.path.join(old_root, project_relative)
        os.makedirs(project_root)
        os.makedirs(old_data_root)
        source_database = os.path.join(temporary_root, "source.sqlite3")
        db = workspace_db.connect(old_root, source_database)
        now = int(time.time() * 1000)
        project_id = "project-backup-test"
        photo_id = "photo-backup-test"
        version_id = "version-backup-test"
        original_path = os.path.join(project_root, "原片.jpg")
        version_path = os.path.join(project_root, "修图", "版本一.jpg")
        thumbnail_path = os.path.join(old_data_root, "thumbnails", "版本一.jpg")
        db.execute(
            "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (project_id, "示例项目", "待处理", project_relative, now, now),
        )
        db.execute(
            "INSERT INTO photos(id,project_id,media_type,original_name,display_name,original_file_path,original_file_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (photo_id, project_id, "image", "原片.jpg", "原片", original_path, "old-photo-file-id", now, now),
        )
        db.execute(
            "INSERT INTO versions(id,photo_id,version_number,version_name,file_path,file_path_key,file_id,thumbnail_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (version_id, photo_id, 1, "版本一", version_path, os.path.normcase(version_path), "old-version-file-id", thumbnail_path, now, now),
        )
        db.execute("UPDATE photos SET current_version_id=? WHERE id=?", (version_id, photo_id))
        db.execute("UPDATE projects SET extra_json=? WHERE id=?", (json.dumps({"archive": {"path": os.path.join(temporary_root, "archive", "示例项目")}}, ensure_ascii=False), project_id))
        db.commit()
        db.close()

        snapshot_database = os.path.join(temporary_root, "snapshot.sqlite3")
        snapshot = backup_db.snapshot(source_database, snapshot_database)
        assert snapshot["success"] and snapshot["projects"][0]["id"] == project_id
        maintenance_db = workspace_db.connect(old_root, source_database)
        maintenance_db.execute("UPDATE projects SET availability='missing',missing_since=1 WHERE id=?", (project_id,))
        maintenance_db.commit()
        assert workspace_db.missing_projects_list(maintenance_db, {"missingBefore": 1})["projects"] == [], "offline archived projects must never be purged by missing-project maintenance"
        maintenance_db.execute("UPDATE projects SET availability='available',missing_since=NULL WHERE id=?", (project_id,))
        maintenance_db.commit()
        maintenance_db.close()

        restored_root = os.path.join(temporary_root, "Restored-Workspace")
        restored_data_root = os.path.join(temporary_root, "restored-data")
        restored_database = os.path.join(temporary_root, "restored.sqlite3")
        os.makedirs(restored_root)
        result = backup_db.restore_workspace(
            snapshot_database,
            restored_database,
            old_root,
            restored_root,
            old_data_root,
            restored_data_root,
            [project_id],
        )
        assert result["success"]
        restored = sqlite3.connect(restored_database)
        restored.row_factory = sqlite3.Row
        photo = restored.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
        version = restored.execute("SELECT * FROM versions WHERE id=?", (version_id,)).fetchone()
        assert photo["original_file_path"] == os.path.join(restored_root, project_relative, "原片.jpg")
        assert photo["original_file_id"] is None
        restored_version_path = os.path.join(restored_root, project_relative, "修图", "版本一.jpg")
        assert version["file_path"] == restored_version_path
        assert version["file_path"] != restored_version_path.casefold(), "display path must preserve its original casing"
        assert version["file_path_key"] == os.path.normpath(restored_version_path).casefold()
        assert version["file_id"] is None and version["thumbnail_path"] is None
        assert restored.execute("SELECT value FROM meta WHERE key='workspace_root'").fetchone()[0] == restored_root
        assert "archive" not in json.loads(restored.execute("SELECT extra_json FROM projects WHERE id=?", (project_id,)).fetchone()[0])
        restored.close()

        import_root = os.path.join(temporary_root, "import-workspace")
        imported_database = os.path.join(temporary_root, "imported.sqlite3")
        os.makedirs(import_root)
        target = workspace_db.connect(import_root, imported_database)
        target.close()
        imported = backup_db.restore_project(
            snapshot_database,
            imported_database,
            project_id,
            old_root,
            import_root,
            project_relative,
            old_data_root,
            os.path.join(temporary_root, "import-data"),
            [project_id],
        )
        assert imported["success"] and imported["projectId"] == project_id
        target = sqlite3.connect(imported_database)
        target.row_factory = sqlite3.Row
        assert target.execute("SELECT COUNT(*) FROM projects WHERE id=?", (project_id,)).fetchone()[0] == 1
        assert "archive" not in json.loads(target.execute("SELECT extra_json FROM projects WHERE id=?", (project_id,)).fetchone()[0])
        assert target.execute("SELECT COUNT(*) FROM photos WHERE project_id=?", (project_id,)).fetchone()[0] == 1
        imported_version = target.execute("SELECT * FROM versions WHERE id=?", (version_id,)).fetchone()
        assert imported_version["file_path"] == os.path.join(import_root, project_relative, "修图", "版本一.jpg")
        assert target.execute("PRAGMA foreign_key_check").fetchall() == []
        target.close()
        print("Backup database snapshot and restore tests passed.")
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


if __name__ == "__main__":
    main()
