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


def test_existing_v1_can_receive_v0(temp_root):
    workspace_root = os.path.join(temp_root, "merge-workspace")
    project_path = os.path.join(workspace_root, "merge-project")
    v0_folder = os.path.join(project_path, "selection")
    v1_folder = os.path.join(project_path, "retouch-v1")
    os.makedirs(v0_folder)
    os.makedirs(v1_folder)
    v0_path = os.path.join(v0_folder, "IMG_0001.CR3")
    v1_path = os.path.join(v1_folder, "IMG_0001.jpg")
    with open(v0_path, "wb") as output:
        output.write(b"camera-raw-v0")
    with open(v1_path, "wb") as output:
        output.write(b"returned-jpeg-v1")

    database = os.path.join(temp_root, "merge-workspace.sqlite3")
    db = workspace_db.connect(workspace_root, database)
    now = int(time.time() * 1000)
    project_id = "merge-project-id"
    db.execute(
        """INSERT INTO projects(id,name,status,relative_path,filesystem_id,is_deleted,availability,
           missing_checks,created_at,updated_at,extra_json) VALUES(?,?,?,?,?,0,'available',0,?,?, '{}')""",
        (project_id, "merge-project", "后期中", "merge-project", workspace_db.directory_identity(project_path), now, now),
    )
    db.commit()
    project = workspace_db.project_row(db, "merge-project")
    workspace_db.ensure_reference_batch(workspace_root, db, project, v0_folder)
    v0 = workspace_db.ensure_source_version(db, project, v0_path)
    v1 = workspace_db.ensure_source_version(db, project, v1_path)
    source_photo_id = v1["photo_id"]

    db.execute(
        "INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)",
        (source_photo_id, project_id, v1["id"], now, now),
    )
    db.execute(
        """INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,assignee,
           detector,bbox_json,crop_json,patch_path,status,created_at,updated_at,is_deleted)
           VALUES('merge-task',?,?,1,'人物 1','修图师','test','{}','{}',?,'exported',?,?,0)""",
        (source_photo_id, v1["id"], os.path.join(v1_folder, "patch.png"), now, now),
    )
    db.execute(
        "INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES('merge-person',?,'人物 1','#2563eb',?,?)",
        (project_id, now, now),
    )
    db.execute(
        """INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,
           identity_id,confidence,source,completed,updated_at) VALUES(?,?,?,1,'merge-person',1,'manual',1,?)""",
        (project_id, source_photo_id, v1["id"], now),
    )
    db.execute(
        """INSERT INTO team_person_exclusions(id,project_id,photo_id,base_version_id,bbox_json,reason,created_at)
           VALUES('merge-exclusion',?,?,?,'{}','false-positive',?)""",
        (project_id, source_photo_id, v1["id"], now),
    )
    db.execute(
        """INSERT INTO version_compare_history(id,photo_id,left_version_id,right_version_id,compare_mode,created_at)
           VALUES('merge-compare',?,?,?,'side',?)""",
        (source_photo_id, v1["id"], v1["id"], now),
    )
    db.commit()

    payload = {
        "projectName": "merge-project", "folderA": v0_folder, "folderB": v1_folder,
        "displayName": "retouch-v1", "importKey": "merge-existing-v1",
        "matches": [
            {"reference": "IMG_0001.CR3", "source": "IMG_0001.jpg", "target": "IMG_0001.jpg", "distance": 0, "confidence": "高"},
            {"reference": "IMG_0001.CR3", "source": "missing.jpg", "target": "missing.jpg", "distance": 1, "confidence": "高"},
        ],
    }
    failed = False
    try:
        workspace_db.batch_commit_compare(workspace_root, db, payload)
    except ValueError:
        failed = True
    assert failed, "a bad later match must fail the batch"
    assert db.execute("SELECT photo_id FROM versions WHERE id=?", (v1["id"],)).fetchone()[0] == source_photo_id
    assert db.execute("SELECT photo_id FROM team_patch_tasks WHERE id='merge-task'").fetchone()[0] == source_photo_id
    failed_batch = db.execute("SELECT id,status FROM version_batches WHERE import_key='merge-existing-v1'").fetchone()
    assert failed_batch["status"] == "failed"
    assert db.execute("SELECT COUNT(*) FROM batch_items WHERE batch_id=?", (failed_batch["id"],)).fetchone()[0] == 0

    payload["matches"] = payload["matches"][:1]
    result = workspace_db.batch_commit_compare(workspace_root, db, payload)
    assert result["success"] is True
    moved_v1 = db.execute("SELECT * FROM versions WHERE id=?", (v1["id"],)).fetchone()
    assert moved_v1["photo_id"] == v0["photo_id"]
    assert moved_v1["parent_version_id"] == v0["id"]
    assert moved_v1["version_number"] == 1
    assert moved_v1["version_name"] == "retouch-v1"
    assert db.execute("SELECT COUNT(*) FROM photos WHERE id=?", (source_photo_id,)).fetchone()[0] == 0
    assert db.execute("SELECT photo_id,base_version_id FROM team_patch_tasks WHERE id='merge-task'").fetchone()[:] == (v0["photo_id"], v1["id"])
    assert db.execute("SELECT photo_id,base_version_id FROM team_retouch_photos WHERE photo_id=?", (v0["photo_id"],)).fetchone()[:] == (v0["photo_id"], v1["id"])
    assert db.execute("SELECT photo_id,base_version_id FROM team_person_assignments WHERE identity_id='merge-person'").fetchone()[:] == (v0["photo_id"], v1["id"])
    assert db.execute("SELECT photo_id FROM team_person_exclusions WHERE id='merge-exclusion'").fetchone()[0] == v0["photo_id"]
    assert db.execute("SELECT photo_id FROM version_compare_history WHERE id='merge-compare'").fetchone()[0] == v0["photo_id"]
    assert db.execute("SELECT current_version_id FROM photos WHERE id=?", (v0["photo_id"],)).fetchone()[0] == v1["id"]

    second_reference_path = os.path.join(v0_folder, "IMG_0002.CR3")
    second_source_path = os.path.join(v1_folder, "IMG_0002.CR3")
    with open(second_reference_path, "wb") as output:
        output.write(b"camera-raw-v0-second")
    shutil.copy2(second_reference_path, second_source_path)
    version_count_before_reconcile = db.execute("SELECT COUNT(*) FROM versions").fetchone()[0]
    payload.update({
        "reconcileExisting": True,
        "renameSources": True,
        "matches": [
            {"reference": "IMG_0001.CR3", "source": "IMG_0001.jpg", "target": "IMG_0001_renamed.jpg", "distance": 0, "confidence": "高"},
            {"reference": "IMG_0002.CR3", "source": "IMG_0002.CR3", "target": "IMG_0002.CR3", "distance": 0, "confidence": "复制补齐"},
        ],
    })
    reconciled = workspace_db.batch_commit_compare(workspace_root, db, payload)
    assert reconciled["success"] is True and reconciled["reconciled"] is True
    assert reconciled["renamedCount"] == 1
    assert os.path.isfile(os.path.join(v1_folder, "IMG_0001_renamed.jpg"))
    assert not os.path.exists(v1_path)
    assert db.execute("SELECT COUNT(*) FROM version_batches WHERE project_id=?", (project_id,)).fetchone()[0] == 2
    assert db.execute("SELECT COUNT(*) FROM batch_items WHERE batch_id=?", (failed_batch["id"],)).fetchone()[0] == 2
    assert db.execute("SELECT COUNT(*) FROM versions").fetchone()[0] == version_count_before_reconcile + 2

    os.unlink(second_source_path)
    new_source_path = os.path.join(v1_folder, "NEW_0003.jpg")
    with open(new_source_path, "wb") as output:
        output.write(b"new-unmatched-source")
    payload.update({
        "importKey": "merge-existing-v1-refresh",
        "renameSources": False,
        "matches": [
            {"reference": "IMG_0001.CR3", "source": "IMG_0001_renamed.jpg", "target": "IMG_0001_renamed.jpg", "distance": 0, "confidence": "高"},
        ],
    })
    refreshed = workspace_db.batch_commit_compare(workspace_root, db, payload)
    assert refreshed["success"] is True and refreshed["reconciled"] is True
    assert refreshed["batch"]["itemCount"] == 2
    assert refreshed["batch"]["matchedCount"] == 1
    assert refreshed["batch"]["newCount"] == 1
    refreshed_sources = {
        row[0] for row in db.execute("SELECT source_name FROM batch_items WHERE batch_id=?", (failed_batch["id"],)).fetchall()
    }
    assert refreshed_sources == {"IMG_0001_renamed.jpg", "NEW_0003.jpg"}
    workspace_db._check_integrity(db, force=True)
    db.close()


def test_progress_tree_version_remap(temp_root):
    workspace_root = os.path.join(temp_root, "progress-remap-workspace")
    project_path = os.path.join(workspace_root, "进度重映射")
    os.makedirs(project_path)
    database = os.path.join(temp_root, "progress-remap.sqlite3")
    db = workspace_db.connect(workspace_root, database)
    now = int(time.time() * 1000)
    db.execute(
        """INSERT INTO projects(id,name,status,relative_path,filesystem_id,is_deleted,availability,missing_checks,created_at,updated_at,extra_json)
           VALUES('progress-project','进度重映射','后期中','进度重映射',?,0,'available',0,?,?, '{}')""",
        (workspace_db.directory_identity(project_path), now, now),
    )
    root_old = os.path.join(project_path, "图片后期_1")
    child_old = os.path.join(project_path, "图片后期_1_1_精修")
    os.makedirs(root_old)
    os.makedirs(child_old)
    root_progress = workspace_db.progress_register(workspace_root, db, {
        "projectName": "进度重映射", "mediaKind": "image", "versionKey": "1",
        "displayName": "图片后期_1", "folderPath": root_old, "trackingEnabled": True,
    })["progressFolder"]
    child_progress = workspace_db.progress_register(workspace_root, db, {
        "projectName": "进度重映射", "mediaKind": "image", "versionKey": "1_1",
        "parentProgressId": root_progress["id"], "displayName": "图片后期_1_1_精修",
        "folderPath": child_old, "trackingEnabled": True,
    })["progressFolder"]

    root_new = os.path.join(project_path, "图片后期_3")
    child_new = os.path.join(project_path, "图片后期_3_1_精修")
    os.rename(root_old, root_new)
    os.rename(child_old, child_new)
    result = workspace_db.progress_update_tree(workspace_root, db, {
        "projectName": "进度重映射",
        "primaryProgressId": root_progress["id"],
        "updates": [
            {"id": root_progress["id"], "mediaKind": "image", "versionKey": "3", "displayName": "图片后期_3", "folderPath": root_new, "trackingEnabled": False},
            {"id": child_progress["id"], "mediaKind": "image", "versionKey": "3_1", "parentProgressId": root_progress["id"], "displayName": "图片后期_3_1_精修", "folderPath": child_new},
        ],
    })
    assert result["progressFolder"]["versionKey"] == "3"
    assert result["progressFolder"]["trackingEnabled"] is False
    remapped = {folder["id"]: folder for folder in result["progressFolders"]}
    assert remapped[child_progress["id"]]["versionKey"] == "3_1"
    assert remapped[child_progress["id"]]["parentProgressId"] == root_progress["id"]
    assert remapped[child_progress["id"]]["displayName"] == "图片后期_3_1_精修"
    assert remapped[child_progress["id"]]["trackingEnabled"] is True
    workspace_db._check_integrity(db, force=True)
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
        test_existing_v1_can_receive_v0(temp_root)
        test_progress_tree_version_remap(temp_root)
        print("workspace database migration tests passed")
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
