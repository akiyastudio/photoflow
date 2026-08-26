import importlib.util
import os
import tempfile
import time
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("workspace_db_relocation", REPOSITORY_ROOT / "python" / "workspace_db.py")
workspace_db = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace_db)


def seed(root: Path, database: Path):
    project = root / "Project"
    original = project / "RAW"
    progress = project / "自由名称"
    original.mkdir(parents=True)
    progress.mkdir()
    (progress / "photo.jpg").write_bytes(b"photo")
    db = workspace_db.connect(str(root), str(database), include_domains=True)
    now = int(time.time() * 1000)
    db.execute(
        """INSERT INTO projects(id,name,status,relative_path,created_at,updated_at)
           VALUES('project','Project','后期中','Project',?,?)""", (now, now),
    )
    common = """INSERT INTO progress_folders(
      id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,folder_path_key,folder_id,
      node_role,relation_kind,tracking_enabled,tracking_state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""
    db.execute(common, (
        "original", "project", "image", "0", None, "RAW", str(original), str(original).casefold(),
        workspace_db.directory_identity(str(original)), "original", None, 0, "disabled", now, now,
    ))
    db.execute(common, (
        "progress", "project", "image", "1", "original", "自由名称", str(progress), str(progress).casefold(),
        workspace_db.directory_identity(str(progress)), "progress", "main", 1, "ready", now, now,
    ))
    db.execute(
        """INSERT INTO media_import_artifact_slots(project_id,progress_id,import_slot,relative_path_key,created_at,updated_at)
           VALUES('project','progress','generated_jpg','自由名称',?,?)""", (now, now),
    )
    db.execute(
        """INSERT INTO photos(id,project_id,media_type,original_name,display_name,current_version_id,
           original_file_path,created_at,updated_at) VALUES('photo','project','image','photo.jpg','photo.jpg','version',?,?,?)""",
        (str(progress / "photo.jpg"), now, now),
    )
    db.execute(
        """INSERT INTO versions(id,photo_id,version_number,version_name,file_path,file_path_key,file_size,
           created_at,updated_at) VALUES('version','photo',0,'V0',?,?,5,?,?)""",
        (str(progress / "photo.jpg"), str(progress / "photo.jpg").casefold(), now, now),
    )
    db.execute(
        """INSERT INTO file_records(id,owner_type,owner_id,current_path,file_name,extension,file_size,created_at,updated_at)
           VALUES('record','version','version',?,'photo.jpg','.jpg',5,?,?)""", (str(progress / "photo.jpg"), now, now),
    )
    db.execute(
        """INSERT INTO version_batches(id,project_id,sequence,display_name,source_folder_path,source_folder_path_key,
           source_folder_id,status,created_at,updated_at) VALUES('batch','project',1,'自由名称',?,?,?,'needs_repair',?,?)""",
        (str(progress), str(progress).casefold(), workspace_db.directory_identity(str(progress)), now, now),
    )
    db.execute(
        """INSERT INTO batch_items(id,batch_id,photo_id,version_id,source_name,source_path,source_path_key,
           match_method,created_at,updated_at) VALUES('item','batch','photo','version','photo.jpg',?,?,'new',?,?)""",
        (str(progress / "photo.jpg"), str(progress / "photo.jpg").casefold(), now, now),
    )
    db.execute(
        """INSERT INTO batch_file_operations(id,batch_id,operation_type,source_path,target_path,status,error,created_at,updated_at)
           VALUES('operation','batch','rename',?,?,'failed','injected',?,?)""",
        (str(progress / "photo.jpg"), str(progress / "photo-final.jpg"), now, now),
    )
    db.execute(
        "INSERT INTO media_incremental_snapshots(snapshot_id,project_id,state,manifest_hash,created_at) VALUES('snapshot','project','prepared','hash',?)",
        (now,),
    )
    db.execute(
        """INSERT INTO media_incremental_snapshot_files(snapshot_id,ordinal,file_path,file_path_key,file_size,modified_at)
           VALUES('snapshot',0,?,?,5,?)""", (str(progress / "photo.jpg"), str(progress / "photo.jpg").casefold(), now),
    )
    db.commit()
    return db, progress


def rename(db, root: Path, progress: Path, new_name: str, fault_after=None):
    token = workspace_db.progress_update_tree_begin(db, {"projectName": "Project"})["mutationToken"]
    return workspace_db.progress_folder_rename(str(root), db, {
        "projectName": "Project", "progressId": "progress", "expectedFolderId": workspace_db.directory_identity(str(progress)),
        "expectedRelativePath": f"Project/{progress.name}".split("/", 1)[1], "newName": new_name, "mutationToken": token,
    }, fault_after=fault_after)


def assert_relocated(db, target: Path):
    target_key = str(target).casefold()
    progress = db.execute("SELECT folder_path_key,display_name FROM progress_folders WHERE id='progress'").fetchone()
    assert progress["folder_path_key"] == target_key and progress["display_name"] == target.name
    assert db.execute("SELECT relative_path_key FROM media_import_artifact_slots WHERE progress_id='progress'").fetchone()[0] == target.name.casefold()
    batch = db.execute("SELECT source_folder_path_key,source_folder_id,status FROM version_batches WHERE id='batch'").fetchone()
    assert batch[0] == target_key and batch[1] == workspace_db.directory_identity(str(target)) and batch[2] == "needs_repair"
    assert db.execute("SELECT source_path_key FROM batch_items WHERE id='item'").fetchone()[0] == str(target / "photo.jpg").casefold()
    operation = db.execute("SELECT source_path,target_path FROM batch_file_operations WHERE id='operation'").fetchone()
    assert operation[0] == str(target / "photo.jpg") and operation[1] == str(target / "photo-final.jpg")
    assert db.execute("SELECT file_path_key FROM versions WHERE id='version'").fetchone()[0] == str(target / "photo.jpg").casefold()
    assert db.execute("SELECT original_file_path FROM photos WHERE id='photo'").fetchone()[0] == str(target / "photo.jpg")
    assert db.execute("SELECT current_path FROM file_records WHERE id='record'").fetchone()[0] == str(target / "photo.jpg")
    assert db.execute("SELECT COUNT(*) FROM media_incremental_snapshots").fetchone()[0] == 0
    progress_row = next(row for row in workspace_db.progress_rows(db, "project") if row["id"] == "progress")
    assert progress_row["repair_batch_id"] == "batch" and progress_row["pending_operation_count"] == 1


def test_relocation_and_needs_repair_retry(temp: Path):
    root = temp / "workspace"
    db, progress = seed(root, temp / "workspace.sqlite3")
    try:
        result = rename(db, root, progress, "客户自定义 A")
        target = progress.with_name("客户自定义 A")
        assert result["oldRelativePath"] == "自由名称" and result["newRelativePath"] == "客户自定义 A"
        assert target.is_dir() and not progress.exists()
        assert_relocated(db, target)
        retried = workspace_db.batch_retry_operations(db, {"batchId": "batch"})
        assert retried["success"] and (target / "photo-final.jpg").is_file(), retried
        assert db.execute("SELECT tracking_state FROM progress_folders WHERE id='progress'").fetchone()[0] == "ready"
    finally:
        db.close()


def test_fault_recovery(temp: Path):
    for stage in ("temporary_moved", "filesystem_moved", "database_relocated", "completed"):
        case = temp / stage
        db, progress = seed(case / "workspace", case / "workspace.sqlite3")
        target = progress.with_name(f"恢复-{stage}")
        try:
            try:
                rename(db, case / "workspace", progress, target.name, fault_after=stage)
                raise AssertionError(f"fault {stage} did not fire")
            except RuntimeError as error:
                assert f"test_fault_after_{stage}" in str(error)
            recovered = workspace_db.recover_progress_folder_relocations(str(case / "workspace"), db)
            assert recovered["pending"] == 0 and target.is_dir()
            assert_relocated(db, target)
            assert db.execute("SELECT state FROM progress_folder_relocations").fetchone()[0] == "completed"
        finally:
            db.close()


def test_validation_guards(temp: Path):
    root = temp / "validation" / "workspace"
    db, progress = seed(root, temp / "validation" / "workspace.sqlite3")
    try:
        for invalid_name, error_code in (
            ("CON", "progress_folder_name_invalid"), ("bad.", "progress_folder_name_invalid"),
            (".photoflow-private", "progress_folder_name_reserved"), ("RAW", "progress_folder_name_reserved"),
        ):
            token = workspace_db.progress_update_tree_begin(db, {"projectName": "Project"})["mutationToken"]
            try:
                workspace_db.progress_folder_rename(str(root), db, {
                    "projectName": "Project", "progressId": "progress",
                    "expectedFolderId": workspace_db.directory_identity(str(progress)),
                    "expectedRelativePath": progress.name, "newName": invalid_name, "mutationToken": token,
                })
                raise AssertionError(f"invalid name was accepted: {invalid_name}")
            except ValueError as error:
                assert error_code in str(error)
            finally:
                workspace_db.progress_update_tree_finish(db, {"projectName": "Project", "mutationToken": token})
        conflict = progress.with_name("occupied")
        conflict.mkdir()
        token = workspace_db.progress_update_tree_begin(db, {"projectName": "Project"})["mutationToken"]
        try:
            workspace_db.progress_folder_rename(str(root), db, {
                "projectName": "Project", "progressId": "progress", "expectedFolderId": "stale",
                "expectedRelativePath": progress.name, "newName": conflict.name, "mutationToken": token,
            })
            raise AssertionError("stale folder identity was accepted")
        except ValueError as error:
            assert "progress_folder_identity_mismatch" in str(error)
        finally:
            workspace_db.progress_update_tree_finish(db, {"projectName": "Project", "mutationToken": token})
        token = workspace_db.progress_update_tree_begin(db, {"projectName": "Project"})["mutationToken"]
        try:
            workspace_db.progress_folder_rename(str(root), db, {
                "projectName": "Project", "progressId": "progress",
                "expectedFolderId": workspace_db.directory_identity(str(progress)),
                "expectedRelativePath": progress.name, "newName": conflict.name, "mutationToken": token,
            })
            raise AssertionError("conflicting target was overwritten")
        except ValueError as error:
            assert "progress_folder_target_conflict" in str(error)
        finally:
            workspace_db.progress_update_tree_finish(db, {"projectName": "Project", "mutationToken": token})
        assert conflict.is_dir() and progress.is_dir(), "validation must never overwrite a conflicting directory"
    finally:
        db.close()


def test_external_link_route_rename(temp: Path):
    root = temp / "external-route-workspace"
    db, progress = seed(root, temp / "external-route.sqlite3")
    try:
        db.execute(
            "UPDATE progress_folders SET external_link_relative_path='客户精修.lnk' WHERE id='progress'"
        )
        db.execute(
            "UPDATE media_import_artifact_slots SET relative_path_key='客户精修.lnk' WHERE progress_id='progress'"
        )
        db.commit()
        token = workspace_db.progress_update_tree_begin(db, {"projectName": "Project"})["mutationToken"]
        preflight = workspace_db.progress_external_link_route_rename(str(root), db, {
            "projectName": "Project", "progressId": "progress", "oldRelativePath": "客户精修.lnk",
            "newRelativePath": "客户终稿.lnk", "mutationToken": token, "preflight": True,
        })
        assert preflight["success"] and preflight["affectedProgressIds"] == ["progress"]
        result = workspace_db.progress_external_link_route_rename(str(root), db, {
            "projectName": "Project", "progressId": "progress", "oldRelativePath": "客户精修.lnk",
            "newRelativePath": "客户终稿.lnk", "mutationToken": token,
        })
        assert result["success"] and result["oldRelativePath"] == "客户精修.lnk"
        assert result["newRelativePath"] == "客户终稿.lnk"
        row = db.execute(
            "SELECT external_link_relative_path,display_name FROM progress_folders WHERE id='progress'"
        ).fetchone()
        assert tuple(row) == ("客户终稿.lnk", "客户终稿")
        assert db.execute(
            "SELECT relative_path_key FROM media_import_artifact_slots WHERE progress_id='progress'"
        ).fetchone()[0] == "客户终稿.lnk".casefold()
        assert progress.is_dir(), "renaming an external-link alias must not rename the physical target directory"
    finally:
        db.close()


def main():
    with tempfile.TemporaryDirectory(prefix="photoflow-progress-relocation-") as temporary:
        temp = Path(temporary)
        test_relocation_and_needs_repair_retry(temp)
        test_fault_recovery(temp)
        test_validation_guards(temp)
        test_external_link_route_rename(temp)
    print("progress folder relocation database tests passed")


if __name__ == "__main__":
    main()
