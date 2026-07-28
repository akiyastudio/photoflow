import importlib.util
import os
import shutil
import sqlite3
import tempfile
import time


REPOSITORY_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(REPOSITORY_ROOT, "python", "workspace_db.py")
SPEC = importlib.util.spec_from_file_location("workspace_db", MODULE_PATH)
workspace_db = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace_db)


def create_legacy_database(database, project_id, photo_id, version_id):
    db = sqlite3.connect(database)
    now = int(time.time() * 1000)
    db.executescript(
        """
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE projects(
          id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE,status TEXT NOT NULL,
          relative_path TEXT NOT NULL UNIQUE,filesystem_id TEXT,is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,extra_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE photos(
          id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          media_type TEXT NOT NULL,original_name TEXT NOT NULL,display_name TEXT NOT NULL,
          current_version_id TEXT,original_file_path TEXT NOT NULL,original_file_id TEXT,
          original_fingerprint TEXT,capture_time INTEGER,created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,is_deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE versions(
          id TEXT PRIMARY KEY,photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
          parent_version_id TEXT REFERENCES versions(id),version_number INTEGER NOT NULL,
          version_name TEXT NOT NULL,version_type TEXT NOT NULL DEFAULT 'custom',file_path TEXT NOT NULL,
          file_path_key TEXT NOT NULL,file_id TEXT,file_fingerprint TEXT,file_size INTEGER NOT NULL DEFAULT 0,
          file_modified_at INTEGER,thumbnail_path TEXT,author TEXT,note TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',is_current INTEGER NOT NULL DEFAULT 0,
          is_final INTEGER NOT NULL DEFAULT 0,file_missing INTEGER NOT NULL DEFAULT 0,
          content_changed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,is_deleted INTEGER NOT NULL DEFAULT 0,
          UNIQUE(photo_id,version_number)
        );
        CREATE TABLE file_records(
          id TEXT PRIMARY KEY,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,current_path TEXT NOT NULL,
          file_name TEXT NOT NULL,extension TEXT NOT NULL,windows_file_id TEXT,volume_id TEXT,
          file_size INTEGER NOT NULL,modified_at INTEGER,quick_hash TEXT,full_hash TEXT,
          missing INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
          UNIQUE(owner_type,owner_id)
        );
        """
    )
    db.execute("INSERT INTO meta VALUES('schema_version','10')")
    db.execute(
        "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
        (project_id, "迁移测试", "后期中", "迁移测试", None, 0, now, now, "{}"),
    )
    db.execute(
        """INSERT INTO photos(
             id,project_id,media_type,original_name,display_name,current_version_id,
             original_file_path,created_at,updated_at,is_deleted
           ) VALUES(?,?,?,?,?,?,?,?,?,0)""",
        (photo_id, project_id, "image", "a.jpg", "a.jpg", version_id, "a.jpg", now, now),
    )
    db.execute(
        """INSERT INTO versions(
             id,photo_id,version_number,version_name,version_type,file_path,file_path_key,
             file_size,status,is_current,created_at,updated_at,is_deleted
           ) VALUES(?,?,0,'原片','original','a.jpg','a.jpg',1,'original',1,?,?,0)""",
        (version_id, photo_id, now, now),
    )
    db.execute(
        """INSERT INTO file_records(
             id,owner_type,owner_id,current_path,file_name,extension,file_size,missing,created_at,updated_at
           ) VALUES('record-valid','version',?,'a.jpg','a.jpg','.jpg',1,0,?,?)""",
        (version_id, now, now),
    )
    db.execute(
        """INSERT INTO file_records(
             id,owner_type,owner_id,current_path,file_name,extension,file_size,missing,created_at,updated_at
           ) VALUES('record-orphan','version','missing-version','old.jpg','old.jpg','.jpg',1,1,?,?)""",
        (now, now),
    )
    db.commit()
    db.close()


def main():
    temp_root = tempfile.mkdtemp(prefix="photoflow-db-migration-")
    try:
        workspace_root = os.path.join(temp_root, "workspace")
        os.makedirs(workspace_root)
        database = os.path.join(temp_root, "workspace.sqlite3")
        project_id = "project-1"
        photo_id = "photo-1"
        version_id = "version-1"
        create_legacy_database(database, project_id, photo_id, version_id)

        db = workspace_db.connect(workspace_root, database)
        assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "13"
        assert db.execute("SELECT COUNT(*) FROM file_records").fetchone()[0] == 1
        assert db.execute("SELECT value FROM meta WHERE key='migration_12_orphan_file_records_removed'").fetchone()[0] == "1"
        owner_foreign_keys = db.execute("PRAGMA foreign_key_list(file_records)").fetchall()
        assert any(row[2] == "versions" and row[3] == "owner_id" and row[4] == "id" and row[6] == "CASCADE" for row in owner_foreign_keys)
        assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT availability,missing_checks FROM projects WHERE id=?", (project_id,)).fetchone()[:] == ("available", 0)
        backup_path = db.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0]
        assert os.path.isfile(backup_path)
        assert db.execute("SELECT value FROM meta WHERE key='last_automatic_backup'").fetchone() is None
        db.close()

        assert workspace_db.mutate(workspace_root, database, "maintenance_run", {})["success"] is True
        db = workspace_db.connect(workspace_root, database)
        automatic_backup_path = db.execute("SELECT value FROM meta WHERE key='last_automatic_backup'").fetchone()[0]
        assert os.path.isfile(automatic_backup_path)

        rejected_second_current = False
        try:
            db.execute(
                """INSERT INTO versions(
                     id,photo_id,version_number,version_name,version_type,file_path,file_path_key,
                     file_size,status,is_current,created_at,updated_at,is_deleted
                   ) VALUES('version-2',?,1,'修图','custom','b.jpg','b.jpg',1,'draft',1,?,?,0)""",
                (photo_id, int(time.time() * 1000), int(time.time() * 1000)),
            )
        except sqlite3.IntegrityError:
            rejected_second_current = True
        assert rejected_second_current, "a photo must not have two active current versions"
        db.rollback()

        workspace_db.sync_directories(workspace_root, db)
        missing = db.execute("SELECT availability,missing_since,missing_checks FROM projects WHERE id=?", (project_id,)).fetchone()
        assert missing[0] == "missing" and missing[1] is not None and missing[2] == 1
        assert db.execute("SELECT COUNT(*) FROM photos WHERE project_id=?", (project_id,)).fetchone()[0] == 1
        offline_scan = workspace_db.media_sync_project(workspace_root, db, {"projectName": "迁移测试"})
        assert offline_scan["projectUnavailable"] is True

        os.mkdir(os.path.join(workspace_root, "迁移测试"))
        workspace_db.sync_directories(workspace_root, db)
        restored = db.execute("SELECT availability,missing_since,missing_checks FROM projects WHERE id=?", (project_id,)).fetchone()
        assert restored[:] == ("available", None, 0)

        db.execute("SAVEPOINT cascade_test")
        db.execute("DELETE FROM versions WHERE id=?", (version_id,))
        assert db.execute("SELECT COUNT(*) FROM file_records WHERE owner_id=?", (version_id,)).fetchone()[0] == 0
        db.execute("ROLLBACK TO cascade_test")
        db.execute("RELEASE cascade_test")
        db.close()
        print("workspace database migration tests passed")
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
