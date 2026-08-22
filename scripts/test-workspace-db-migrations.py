import importlib.util
import json
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


def test_schema_28_migrates_detached_versioning_store(temp_root):
    workspace_root = os.path.join(temp_root, "schema-28-detached-workspace")
    os.makedirs(workspace_root)
    database = os.path.join(temp_root, "schema-28-detached.sqlite3")
    db = workspace_db.connect(workspace_root, database, include_domains=True)
    db.close()
    versioning_database = os.path.join(
        os.path.splitext(database)[0], "databases", "versioning.sqlite3",
    )
    catalog = sqlite3.connect(database)
    catalog.execute("UPDATE meta SET value='27' WHERE key='schema_version'")
    catalog.commit()
    catalog.close()
    versioning = sqlite3.connect(versioning_database)
    versioning.execute("ALTER TABLE tracking_sessions DROP COLUMN copy_operations_json")
    versioning.commit()
    versioning.close()

    catalog_only = workspace_db.connect(workspace_root, database, include_domains=False)
    assert catalog_only.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "28"
    catalog_only.close()
    upgraded = workspace_db.connect(workspace_root, database, include_domains=True)
    columns = {row[1] for row in upgraded.execute("PRAGMA versioning.table_info(tracking_sessions)").fetchall()}
    assert "copy_operations_json" in columns, "the first versioning caller must finish deferred domain migration"
    upgraded.close()


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
    db = workspace_db.connect(workspace_root, database, include_team=True)
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
    db.close()
    failed = False
    try:
        workspace_db.mutate(workspace_root, database, "batch_commit_compare", payload)
    except ValueError:
        failed = True
    db = workspace_db.connect(workspace_root, database, include_team=True)
    assert failed, "a bad later match must fail the batch"
    assert db.execute("SELECT photo_id FROM versions WHERE id=?", (v1["id"],)).fetchone()[0] == source_photo_id
    assert db.execute("SELECT photo_id FROM team_patch_tasks WHERE id='merge-task'").fetchone()[0] == source_photo_id
    failed_batch = db.execute("SELECT id,status FROM version_batches WHERE import_key='merge-existing-v1'").fetchone()
    assert failed_batch["status"] == "failed"
    assert db.execute("SELECT COUNT(*) FROM batch_items WHERE batch_id=?", (failed_batch["id"],)).fetchone()[0] == 0

    payload["matches"] = payload["matches"][:1]
    db.close()
    result = workspace_db.mutate(workspace_root, database, "batch_commit_compare", payload)
    db = workspace_db.connect(workspace_root, database, include_team=True)
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
    logged_rename = db.execute(
        "SELECT status,attempt_count FROM batch_file_operations WHERE batch_id=? AND operation_type='rename'",
        (failed_batch["id"],),
    ).fetchone()
    assert logged_rename is not None and logged_rename["status"] == "succeeded" and logged_rename["attempt_count"] == 1
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

    occupied_path = os.path.join(v1_folder, "occupied.jpg")
    with open(occupied_path, "wb") as output:
        output.write(b"unrelated-file")
    workspace_db.plan_confirmed_batch_renames(db, failed_batch["id"], v1_folder, [
        {"source": "NEW_0003.jpg", "target": "occupied.jpg"},
    ])
    db.commit()
    needs_repair = workspace_db.apply_pending_batch_operations(db, failed_batch["id"])
    assert needs_repair["repairRequired"] is True and needs_repair["renameErrors"]
    assert db.execute("SELECT status FROM version_batches WHERE id=?", (failed_batch["id"],)).fetchone()[0] == "needs_repair"
    os.unlink(occupied_path)
    repaired = workspace_db.batch_retry_operations(db, {"batchId": failed_batch["id"]})
    assert repaired["success"] is True and repaired["repairRequired"] is False
    assert os.path.isfile(os.path.join(v1_folder, "occupied.jpg"))
    assert not os.path.exists(new_source_path)
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


def test_tiered_fingerprint_rejects_same_edges(temp_root):
    first = os.path.join(temp_root, "fingerprint-a.bin")
    second = os.path.join(temp_root, "fingerprint-b.bin")
    edge = b"e" * (128 * 1024)
    with open(first, "wb") as output:
        output.write(edge + b"middle-a" + edge)
    with open(second, "wb") as output:
        output.write(edge + b"middle-b" + edge)
    assert os.path.getsize(first) == os.path.getsize(second)
    assert workspace_db.quick_fingerprint(first) == workspace_db.quick_fingerprint(second)
    assert workspace_db.full_fingerprint(first) != workspace_db.full_fingerprint(second)


def test_full_hash_is_deferred_and_cached(temp_root):
    workspace_root = os.path.join(temp_root, "deferred-hash-workspace")
    project_path = os.path.join(workspace_root, "hash-project")
    os.makedirs(project_path)
    database = os.path.join(temp_root, "deferred-hash.sqlite3")
    db = workspace_db.connect(workspace_root, database)
    workspace_db.sync_directories(workspace_root, db)
    project = workspace_db.project_row(db, "hash-project")
    media_path = os.path.join(project_path, "new-file.jpg")
    with open(media_path, "wb") as output:
        output.write(b"new-media-with-no-candidate")

    original_full_fingerprint = workspace_db.full_fingerprint
    calls = []

    def counted_full_fingerprint(file_path):
        calls.append(file_path)
        return original_full_fingerprint(file_path)

    workspace_db.full_fingerprint = counted_full_fingerprint
    try:
        pending_hashes = []
        workspace_db.sync_media_file(db, project, media_path, pending_hashes)
        assert calls == [], "a brand-new file must not be fully hashed during its DB transaction"
        assert len(pending_hashes) == 1
        db.commit()
        assert workspace_db.backfill_full_fingerprints(db, pending_hashes) == 1
        assert len(calls) == 1
        assert db.execute("SELECT full_hash FROM file_records").fetchone()[0]

        pending_hashes = []
        workspace_db.sync_media_file(db, project, media_path, pending_hashes)
        db.commit()
        workspace_db.backfill_full_fingerprints(db, pending_hashes)
        assert len(calls) == 1, "an unchanged file must reuse its cached full hash"
    finally:
        workspace_db.full_fingerprint = original_full_fingerprint
        db.close()


def test_project_list_is_read_only_until_catalog_sync(temp_root):
    workspace_root = os.path.join(temp_root, "readonly-catalog-workspace")
    os.makedirs(workspace_root)
    database = os.path.join(temp_root, "readonly-catalog.sqlite3")
    initialized = workspace_db.connect(workspace_root, database)
    initialized.close()
    os.mkdir(os.path.join(workspace_root, "externally-created-project"))

    snapshot = workspace_db.load(workspace_root, database)
    assert snapshot["projects"] == [], "project-list reads must not reconcile folders or acquire a write lock"
    synced = workspace_db.mutate(workspace_root, database, "catalog_sync", {})
    assert [project["name"] for project in synced["projects"]] == ["externally-created-project"]
    assert [project["name"] for project in workspace_db.load(workspace_root, database)["projects"]] == ["externally-created-project"]

    writer = workspace_db.connect(workspace_root, database)
    writer.execute("BEGIN IMMEDIATE")
    writer.execute("UPDATE meta SET value=value WHERE key='schema_version'")
    try:
        locked_snapshot = workspace_db.load(workspace_root, database)
        assert [project["name"] for project in locked_snapshot["projects"]] == ["externally-created-project"]
    finally:
        writer.rollback()
        writer.close()


def test_import_staging_directory_never_becomes_a_project(temp_root):
    workspace_root = os.path.join(temp_root, "import-staging-workspace")
    staging_path = os.path.join(workspace_root, "_PhotoFlow_Safety_Temp")
    project_path = os.path.join(workspace_root, "real-project")
    os.makedirs(staging_path)
    os.makedirs(project_path)
    database = os.path.join(temp_root, "import-staging.sqlite3")
    db = workspace_db.connect(workspace_root, database)
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("stale-import-staging", "_PhotoFlow_Safety_Temp", "未分类", "_PhotoFlow_Safety_Temp", now, now),
    )
    db.commit()
    db.close()

    assert workspace_db.load(workspace_root, database)["projects"] == [], "staging records must never be shown as projects"
    synced = workspace_db.mutate(workspace_root, database, "catalog_sync", {})
    assert [project["name"] for project in synced["projects"]] == ["real-project"]
    verification = sqlite3.connect(database)
    try:
        assert verification.execute("SELECT COUNT(*) FROM projects WHERE id='stale-import-staging'").fetchone()[0] == 0
    finally:
        verification.close()


def test_missing_project_can_reconnect_before_retention_cleanup(temp_root):
    workspace_root = os.path.join(temp_root, "missing-project-workspace")
    project_path = os.path.join(workspace_root, "recoverable-project")
    os.makedirs(project_path)
    database = os.path.join(temp_root, "missing-project.sqlite3")
    synced = workspace_db.mutate(workspace_root, database, "catalog_sync", {})
    project_id = synced["projects"][0]["id"]

    os.rmdir(project_path)
    missing = workspace_db.mutate(workspace_root, database, "catalog_sync", {})["projects"][0]
    assert missing["availability"] == "missing"
    assert workspace_db.mutate(workspace_root, database, "missing_projects_list", {"missingBefore": missing["missing_since"] - 1})["projects"] == []

    os.makedirs(project_path)
    restored = workspace_db.mutate(workspace_root, database, "catalog_sync", {})["projects"][0]
    assert restored["id"] == project_id and restored["availability"] == "available"

    os.rmdir(project_path)
    expired = workspace_db.mutate(workspace_root, database, "catalog_sync", {})["projects"][0]
    candidates = workspace_db.mutate(workspace_root, database, "missing_projects_list", {"missingBefore": expired["missing_since"]})["projects"]
    assert [project["id"] for project in candidates] == [project_id]
    workspace_db.mutate(workspace_root, database, "purge_missing_project", {"name": "recoverable-project"})
    assert workspace_db.load(workspace_root, database)["projects"] == []


def test_legacy_selection_nodes_are_repaired_after_original_registration(temp_root):
    workspace_root = os.path.join(temp_root, "legacy-selection-workspace")
    project_path = os.path.join(workspace_root, "legacy-selection-project")
    unresolved_path = os.path.join(workspace_root, "unresolved-selection-project")
    coexist_path = os.path.join(workspace_root, "coexisting-selection-project")
    for folder in ("RAW", "MOV", "JPG", "图片选片", "视频选片"):
        os.makedirs(os.path.join(project_path, folder))
    for folder in ("JPG", "图片选片"):
        os.makedirs(os.path.join(unresolved_path, folder))
    for folder in ("RAW", "图片选片", "RAW_选片"):
        os.makedirs(os.path.join(coexist_path, folder))
    legacy_media_path = os.path.join(project_path, "图片选片", "IMG_0001.jpg")
    with open(legacy_media_path, "wb") as output:
        output.write(b"legacy-selection-media")

    database = os.path.join(temp_root, "legacy-selection.sqlite3")
    workspace_db.mutate(workspace_root, database, "catalog_sync", {})
    db = workspace_db.connect(workspace_root, database)
    image_legacy = workspace_db.progress_register(workspace_root, db, {
        "projectName": "legacy-selection-project", "mediaKind": "image", "versionKey": "0",
        "displayName": "图片选片（原图）", "folderPath": os.path.join(project_path, "图片选片"),
        "nodeRole": "original", "trackingEnabled": False, "trackingState": "disabled",
    })["progressFolder"]
    video_legacy = workspace_db.progress_register(workspace_root, db, {
        "projectName": "legacy-selection-project", "mediaKind": "video", "versionKey": "0",
        "displayName": "视频选片（原片）", "folderPath": os.path.join(project_path, "视频选片"),
        "nodeRole": "original", "trackingEnabled": False, "trackingState": "disabled",
    })["progressFolder"]
    unresolved_legacy = workspace_db.progress_register(workspace_root, db, {
        "projectName": "unresolved-selection-project", "mediaKind": "image", "versionKey": "0",
        "displayName": "图片选片（原图）", "folderPath": os.path.join(unresolved_path, "图片选片"),
        "nodeRole": "original", "trackingEnabled": False, "trackingState": "disabled",
    })["progressFolder"]
    coexist_raw = workspace_db.progress_register(workspace_root, db, {
        "projectName": "coexisting-selection-project", "mediaKind": "image", "versionKey": "original-raw",
        "displayName": "RAW", "folderPath": os.path.join(coexist_path, "RAW"),
        "nodeRole": "original", "trackingEnabled": False, "trackingState": "disabled",
    })["progressFolder"]
    coexist_legacy = workspace_db.progress_register(workspace_root, db, {
        "projectName": "coexisting-selection-project", "mediaKind": "image", "versionKey": "0",
        "displayName": "图片选片（原图）", "folderPath": os.path.join(coexist_path, "图片选片"),
        "nodeRole": "original", "trackingEnabled": False, "trackingState": "disabled",
    })["progressFolder"]
    coexist_modern = workspace_db.progress_register(workspace_root, db, {
        "projectName": "coexisting-selection-project", "mediaKind": "image",
        "versionKey": f"selection-{coexist_raw['id']}", "displayName": "RAW_选片",
        "folderPath": os.path.join(coexist_path, "RAW_选片"), "nodeRole": "selection",
        "relationKind": "auxiliary", "parentProgressId": coexist_raw["id"],
        "trackingEnabled": False, "trackingState": "disabled",
    })["progressFolder"]
    project = workspace_db.project_row(db, "legacy-selection-project")
    legacy_batch = workspace_db.ensure_reference_batch(
        workspace_root, db, project, os.path.join(project_path, "图片选片")
    )
    media_version = workspace_db.ensure_source_version(db, project, legacy_media_path)
    db.execute("UPDATE meta SET value='21' WHERE key='schema_version'")
    db.commit()
    db.close()
    db = workspace_db.connect(workspace_root, database)
    backup_path = db.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0]
    assert os.path.isfile(backup_path), "migration must back up the v21 database before upgrading"
    workspace_db.progress_list(workspace_root, db, {"projectName": "legacy-selection-project"})
    unresolved_result = workspace_db.progress_list(workspace_root, db, {"projectName": "unresolved-selection-project"})
    coexist_result = workspace_db.progress_list(workspace_root, db, {"projectName": "coexisting-selection-project"})
    assert coexist_result["success"] is True, "selection conflicts must never make progress_list fail"
    assert unresolved_result["legacySelectionRelationRepairs"][0]["reason"] == "source_missing"
    assert unresolved_result["legacySelectionRelationRepairs"][0]["progressId"] == unresolved_legacy["id"]
    assert coexist_result["legacySelectionRelationRepairs"][0]["reason"] == "selection_already_exists"
    assert coexist_result["legacySelectionRelationRepairs"][0]["candidateIds"] == [coexist_modern["id"]]
    repaired = {row["id"]: row for row in db.execute("SELECT * FROM progress_folders").fetchall()}
    legacy_project_id = workspace_db.project_row(db, "legacy-selection-project")["id"]
    raw = next(row for row in repaired.values() if row["project_id"] == legacy_project_id and os.path.basename(row["folder_path"]) == "RAW")
    mov = next(row for row in repaired.values() if row["project_id"] == legacy_project_id and os.path.basename(row["folder_path"]) == "MOV")
    assert raw["node_role"] == "original" and mov["node_role"] == "original"
    assert repaired[image_legacy["id"]]["node_role"] == "selection"
    assert repaired[image_legacy["id"]]["parent_progress_id"] == raw["id"]
    assert repaired[image_legacy["id"]]["relation_kind"] == "auxiliary"
    assert repaired[video_legacy["id"]]["node_role"] == "selection"
    assert repaired[video_legacy["id"]]["parent_progress_id"] == mov["id"]
    assert repaired[video_legacy["id"]]["relation_kind"] == "auxiliary"
    assert db.execute("SELECT id FROM versions WHERE id=?", (media_version["id"],)).fetchone()[0] == media_version["id"]
    assert db.execute("SELECT id FROM version_batches WHERE id=?", (legacy_batch["id"],)).fetchone()[0] == legacy_batch["id"]
    unresolved = repaired[unresolved_legacy["id"]]
    assert unresolved["parent_progress_id"] is None, "missing RAW must not make legacy selection attach to JPG"
    pending = db.execute(
        "SELECT reason,expected_source_name FROM legacy_selection_relation_repairs WHERE progress_id=?",
        (unresolved_legacy["id"],),
    ).fetchone()
    assert pending[:] == ("source_missing", "RAW")
    coexist_rows = {row["id"]: row for row in db.execute(
        "SELECT * FROM progress_folders WHERE project_id=?",
        (workspace_db.project_row(db, "coexisting-selection-project")["id"],),
    ).fetchall()}
    assert coexist_rows[coexist_legacy["id"]]["node_role"] == "original"
    assert coexist_rows[coexist_legacy["id"]]["parent_progress_id"] is None
    assert coexist_rows[coexist_legacy["id"]]["version_key"] == "0"
    assert coexist_rows[coexist_modern["id"]]["node_role"] == "selection"
    assert coexist_rows[coexist_modern["id"]]["parent_progress_id"] == coexist_raw["id"]
    coexist_repair = db.execute(
        "SELECT reason,candidate_ids_json FROM legacy_selection_relation_repairs WHERE progress_id=?",
        (coexist_legacy["id"],),
    ).fetchone()
    assert coexist_repair["reason"] == "selection_already_exists"
    assert json.loads(coexist_repair["candidate_ids_json"]) == [coexist_modern["id"]]
    assert os.path.isdir(os.path.join(coexist_path, "图片选片"))
    assert os.path.isdir(os.path.join(coexist_path, "RAW_选片"))
    before = [tuple(row) for row in db.execute(
        "SELECT id,node_role,relation_kind,parent_progress_id,version_key,updated_at FROM progress_folders ORDER BY id"
    ).fetchall()]
    workspace_db.progress_list(workspace_root, db, {"projectName": "legacy-selection-project"})
    unresolved_result = workspace_db.progress_list(workspace_root, db, {"projectName": "unresolved-selection-project"})
    workspace_db.progress_list(workspace_root, db, {"projectName": "coexisting-selection-project"})
    after = [tuple(row) for row in db.execute(
        "SELECT id,node_role,relation_kind,parent_progress_id,version_key,updated_at FROM progress_folders ORDER BY id"
    ).fetchall()]
    assert after == before, "repeated startup repair must be idempotent"
    db.close()


def test_schema_22_upgrades_to_layout_schema_23(temp_root):
    workspace_root = os.path.join(temp_root, "schema-23-workspace")
    database = os.path.join(temp_root, "schema-23.sqlite3")
    os.makedirs(workspace_root)
    db = workspace_db.connect(workspace_root, database)
    db.execute("DROP TABLE version_tree_node_positions")
    db.execute("DROP TABLE version_tree_layouts")
    db.execute("UPDATE meta SET value='22' WHERE key='schema_version'")
    db.commit()
    db.close()

    upgraded = workspace_db.connect(workspace_root, database)
    try:
        assert upgraded.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(workspace_db.TARGET_SCHEMA_VERSION)
        assert upgraded.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='version_tree_layouts'").fetchone()
        assert upgraded.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='version_tree_node_positions'").fetchone()
        backup_path = upgraded.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0]
        assert os.path.isfile(backup_path), "schema 22 to 23 migration must create a database backup"
    finally:
        upgraded.close()
    reopened = workspace_db.connect(workspace_root, database)
    try:
        assert reopened.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(workspace_db.TARGET_SCHEMA_VERSION)
        assert reopened.execute("SELECT COUNT(*) FROM version_tree_layouts").fetchone()[0] == 0
    finally:
        reopened.close()


def test_schema_23_upgrades_to_graph_schema_24(temp_root):
    workspace_root = os.path.join(temp_root, "schema-24-workspace")
    database = os.path.join(temp_root, "schema-24.sqlite3")
    os.makedirs(workspace_root)
    db = workspace_db.connect(workspace_root, database)
    db.executescript(
        """
        DROP TRIGGER IF EXISTS version_graph_edges_validate_insert;
        DROP TRIGGER IF EXISTS version_graph_edges_validate_update;
        DROP TRIGGER IF EXISTS progress_folders_graph_endpoint_update;
        DROP TRIGGER IF EXISTS progress_folders_graph_endpoint_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_shape_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_shape_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_cycle_update;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_insert;
        DROP TRIGGER IF EXISTS progress_folders_v2_policy_update;
        DROP TABLE version_graph_edges;
        ALTER TABLE progress_folders DROP COLUMN artifact_kind;
        UPDATE meta SET value='23' WHERE key='schema_version';
        """
    )
    db.commit()
    db.close()

    upgraded = workspace_db.connect(workspace_root, database)
    try:
        assert upgraded.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(workspace_db.TARGET_SCHEMA_VERSION)
        assert "artifact_kind" in {row[1] for row in upgraded.execute("PRAGMA table_info(progress_folders)")}
        assert upgraded.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='version_graph_edges'").fetchone()
        edge_foreign_keys = upgraded.execute("PRAGMA foreign_key_list(version_graph_edges)").fetchall()
        assert sum(row[2] == "progress_folders" and row[6] == "CASCADE" for row in edge_foreign_keys) == 2
        assert upgraded.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='version_graph_edges_validate_insert'").fetchone()
        backup_path = upgraded.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0]
        assert os.path.isfile(backup_path), "schema 23 to 24 migration must create a database backup"
    finally:
        upgraded.close()


def test_schema_24_upgrades_to_import_slots_schema_25(temp_root):
    workspace_root = os.path.join(temp_root, "schema-25-workspace")
    database = os.path.join(temp_root, "schema-25.sqlite3")
    os.makedirs(workspace_root)
    db = workspace_db.connect(workspace_root, database)
    project_path = os.path.join(workspace_root, "Project")
    raw_path = os.path.join(project_path, "source-a")
    camera_path = os.path.join(project_path, "source-b")
    os.makedirs(raw_path)
    os.makedirs(camera_path)
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ("schema-25-project", "Project", "后期中", "Project", now, now),
    )
    raw = workspace_db.progress_register(workspace_root, db, {
        "projectName": "Project", "mediaKind": "image", "versionKey": "legacy-raw",
        "displayName": "Legacy source", "folderPath": raw_path, "nodeRole": "original",
        "trackingEnabled": False,
    })["progressFolder"]
    camera = workspace_db.progress_register(workspace_root, db, {
        "projectName": "Project", "mediaKind": "image", "versionKey": "legacy-camera",
        "displayName": "Legacy companion", "folderPath": camera_path, "nodeRole": "original",
        "artifactKind": "companion", "trackingEnabled": False,
    })["progressFolder"]
    legacy_manifest = {
        "projectName": "Project", "projectRelativePath": "Project", "importSessionId": "legacy-session",
        "artifacts": [
            {"relativePath": "source-a", "mediaKind": "image", "nodeRole": "original", "displayName": "Legacy source"},
            {"relativePath": "source-b", "mediaKind": "image", "nodeRole": "original", "artifactKind": "companion", "displayName": "Legacy companion"},
        ],
        "relations": [{"sourceRelativePath": "source-a", "targetRelativePath": "source-b", "edgeKind": "media_companion"}],
    }
    db.execute(
        """INSERT INTO media_import_graph_sessions(
             project_id,import_session_id,manifest_json,status,error,created_at,updated_at)
           VALUES(?,?,?,'committed',NULL,?,?)""",
        ("schema-25-project", "legacy-session", json.dumps(legacy_manifest), now, now),
    )
    db.executescript(
        """DROP TRIGGER IF EXISTS media_import_artifact_slots_validate_insert;
           DROP TRIGGER IF EXISTS media_import_artifact_slots_validate_update;
           DROP TABLE media_import_artifact_slots;
           UPDATE meta SET value='24' WHERE key='schema_version';"""
    )
    db.commit()
    db.close()

    upgraded = workspace_db.connect(workspace_root, database)
    try:
        assert upgraded.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(workspace_db.TARGET_SCHEMA_VERSION)
        tracking_columns = {row[1] for row in upgraded.execute("PRAGMA table_info(tracking_sessions)")}
        assert {"prepared_files_snapshot_json", "prepared_parent_snapshot_json"} <= tracking_columns
        assert upgraded.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_import_artifact_slots'").fetchone()
        foreign_keys = upgraded.execute("PRAGMA foreign_key_list(media_import_artifact_slots)").fetchall()
        assert any(row[2] == "projects" and row[6] == "CASCADE" for row in foreign_keys)
        assert any(row[2] == "progress_folders" and row[6] == "CASCADE" for row in foreign_keys)
        assert upgraded.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='media_import_artifact_slots_validate_insert'").fetchone()
        slots = {row["progress_id"]: row["import_slot"] for row in upgraded.execute("SELECT * FROM media_import_artifact_slots")}
        assert slots == {raw["id"]: "raw", camera["id"]: "camera_jpg"}
        backup_path = upgraded.execute("SELECT value FROM meta WHERE key='last_migration_backup'").fetchone()[0]
        backup = sqlite3.connect(backup_path)
        try:
            assert backup.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "24"
        finally:
            backup.close()
    finally:
        upgraded.close()


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
        assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == str(workspace_db.TARGET_SCHEMA_VERSION)
        assert db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='version_tree_layouts'").fetchone()
        assert db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='version_tree_node_positions'").fetchone()
        assert db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='version_graph_edges'").fetchone()
        assignment_columns = {row[1] for row in db.execute("PRAGMA table_info(team_person_assignments)").fetchall()}
        assert {"completion_kind", "edited_patch_path", "return_missing", "return_missing_since", "completed_at"} <= assignment_columns
        progress_columns = {row[1] for row in db.execute("PRAGMA table_info(progress_folders)").fetchall()}
        assert {"node_role", "relation_kind", "tracking_state", "rename_from_parent",
                "copy_missing_from_parent", "last_tracked_at", "tracking_snapshot_json",
                "folder_signature", "missing_since", "tombstone_json", "artifact_kind"} <= progress_columns
        assert db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='batch_file_operations'").fetchone()
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
        missing = db.execute("SELECT availability,missing_since,missing_checks,updated_at FROM projects WHERE id=?", (project_id,)).fetchone()
        assert missing[0] == "missing" and missing[1] is not None and missing[2] == 1
        first_missing_state = missing[:]
        for _ in range(5):
            time.sleep(0.002)
            workspace_db.sync_directories(workspace_root, db)
            repeated_missing = db.execute(
                "SELECT availability,missing_since,missing_checks,updated_at FROM projects WHERE id=?",
                (project_id,),
            ).fetchone()
            assert repeated_missing[:] == first_missing_state, "repeated missing sync must be a no-op"
        assert db.execute("SELECT COUNT(*) FROM photos WHERE project_id=?", (project_id,)).fetchone()[0] == 1
        offline_scan = workspace_db.media_sync_prepare(workspace_root, db, {"projectName": "迁移测试"})
        assert offline_scan["projectUnavailable"] is True

        os.mkdir(os.path.join(workspace_root, "迁移测试"))
        workspace_db.sync_directories(workspace_root, db)
        restored = db.execute("SELECT availability,missing_since,missing_checks,updated_at FROM projects WHERE id=?", (project_id,)).fetchone()
        assert restored[:3] == ("available", None, 0)
        assert restored[3] > first_missing_state[3]

        db.execute("SAVEPOINT cascade_test")
        db.execute("DELETE FROM versions WHERE id=?", (version_id,))
        assert db.execute("SELECT COUNT(*) FROM file_records WHERE owner_id=?", (version_id,)).fetchone()[0] == 1
        workspace_db.reconcile_cross_domain_references(db)
        assert db.execute("SELECT COUNT(*) FROM file_records WHERE owner_id=?", (version_id,)).fetchone()[0] == 0
        db.execute("ROLLBACK TO cascade_test")
        db.execute("RELEASE cascade_test")
        db.close()
        test_existing_v1_can_receive_v0(temp_root)
        test_progress_tree_version_remap(temp_root)
        test_tiered_fingerprint_rejects_same_edges(temp_root)
        test_full_hash_is_deferred_and_cached(temp_root)
        test_project_list_is_read_only_until_catalog_sync(temp_root)
        test_import_staging_directory_never_becomes_a_project(temp_root)
        test_missing_project_can_reconnect_before_retention_cleanup(temp_root)
        test_legacy_selection_nodes_are_repaired_after_original_registration(temp_root)
        test_schema_22_upgrades_to_layout_schema_23(temp_root)
        test_schema_23_upgrades_to_graph_schema_24(temp_root)
        test_schema_24_upgrades_to_import_slots_schema_25(temp_root)
        test_schema_28_migrates_detached_versioning_store(temp_root)
        print("workspace database migration tests passed")
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
