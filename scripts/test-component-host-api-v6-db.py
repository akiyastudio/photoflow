import importlib.util
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("workspace_db_v6", ROOT / "python" / "workspace_db.py")
dbmod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dbmod)


with tempfile.TemporaryDirectory() as temporary:
    workspace = Path(temporary) / "workspace"
    project = workspace / "Project"
    project.mkdir(parents=True)
    media = project / "photo.jpg"
    media.write_bytes(b"photo")
    database = Path(temporary) / "workspace.sqlite3"
    db = dbmod.connect(str(workspace), str(database), include_domains=True)
    now = int(time.time() * 1000)
    db.execute("INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('project-1','Project','active','Project',?,?)", (now, now))
    db.execute("INSERT INTO photos(id,project_id,media_type,original_name,display_name,original_file_path,created_at,updated_at) VALUES('photo-1','project-1','image','photo.jpg','Photo',?,?,?)", (str(media), now, now))
    db.execute("""INSERT INTO versions(id,photo_id,parent_version_id,version_number,version_name,version_type,file_path,file_path_key,note,status,is_current,is_final,created_at,updated_at)
                  VALUES('v1','photo-1',NULL,1,'One','edit',?,?,'','draft',1,0,?,?)""", (str(media), str(media).casefold(), now, now))
    progress = project / "progress"
    progress.mkdir()
    db.execute("""INSERT INTO progress_folders(id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,folder_path_key,tracking_enabled,tracking_state,node_role,relation_kind,created_at,updated_at)
                  VALUES('p0','project-1','image','0',NULL,'Original',?,?,0,'disabled','original',NULL,?,?)""", (str(project), str(project).casefold(), now, now))
    db.execute("""INSERT INTO progress_folders(id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,folder_path_key,tracking_enabled,tracking_state,node_role,relation_kind,created_at,updated_at)
                  VALUES('p1','project-1','image','1','p0','Progress',?,?,0,'disabled','progress','main',?,?)""", (str(progress), str(progress).casefold(), now, now))
    for node_id, suffix in (("ps1", "selection-1"), ("ps2", "selection-2")):
        folder = project / suffix
        folder.mkdir()
        db.execute("""INSERT INTO progress_folders(id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,folder_path_key,tracking_enabled,tracking_state,node_role,relation_kind,created_at,updated_at)
                      VALUES(?,?,?,?,?,?,?,?,0,'disabled','selection','auxiliary',?,?)""", (node_id, "project-1", "image", suffix, "p0", suffix, str(folder), str(folder).casefold(), now, now))
    db.commit()
    progress_scope = {"projectName": "Project", "projectId": "project-1", "projectPath": str(project), "scopePath": str(project)}
    manage_progress = lambda payload: dbmod.progress_component_manage(str(workspace), db, {**progress_scope, **payload})

    update = dbmod.media_component_update_version(db, {"projectId": "project-1", "projectPath": str(project), "scopePath": str(project), "versionId": "v1", "expectedUpdatedAt": now, "versionName": "Updated"})
    assert update["version"]["versionName"] == "Updated" and "filePath" not in update["version"]
    assert dbmod._component_version_row(db, {"projectId": "project-1", "projectPath": str(project).upper(), "scopePath": str(project).upper(), "versionId": "v1", "expectedUpdatedAt": update["version"]["updatedAt"]})["id"] == "v1", "component version scope comparison uses Windows case-insensitive path keys"
    try:
        dbmod.media_component_update_version(db, {"projectId": "project-1", "projectPath": str(project), "scopePath": str(project), "versionId": "v1", "expectedUpdatedAt": now, "note": "stale"})
        raise AssertionError("stale version CAS was accepted")
    except ValueError as error:
        assert "stale" in str(error)
    progress_update = manage_progress({"action": "update", "progressId": "p1", "expectedUpdatedAt": now, "displayName": "Updated Progress"})
    assert progress_update["progressFolder"]["displayName"] == "Updated Progress"
    try:
        manage_progress({"action": "update", "progressId": "p1", "expectedUpdatedAt": now, "displayName": "Stale"})
        raise AssertionError("stale progress CAS was accepted")
    except ValueError as error:
        assert "stale" in str(error)
    current_progress = progress_update["progressFolder"]["updatedAt"]
    created_edge = manage_progress({"action": "edgeCreate", "sourceProgressId": "ps1", "targetProgressId": "p1", "edgeKind": "workflow_input", "expectedUpdatedAt": current_progress})["edge"]
    replaced_edge = manage_progress({"action": "edgeReplaceSource", "sourceProgressId": "ps1", "targetProgressId": "p1", "newSourceProgressId": "ps2", "edgeKind": "workflow_input", "expectedUpdatedAt": created_edge["updatedAt"]})["edge"]
    assert replaced_edge["sourceProgressId"] == "ps2"
    manage_progress({"action": "edgeDelete", "sourceProgressId": "ps2", "targetProgressId": "p1", "edgeKind": "workflow_input", "expectedUpdatedAt": replaced_edge["updatedAt"]})
    unregistered = manage_progress({"action": "unregister", "progressId": "p1", "expectedUpdatedAt": current_progress})
    assert unregistered["progressId"] == "p1"
    moved = project / "moved-after-precheck"
    moved.mkdir()
    db.execute("""INSERT INTO progress_folders(id,project_id,media_kind,version_key,parent_progress_id,display_name,folder_path,folder_path_key,tracking_enabled,tracking_state,node_role,relation_kind,created_at,updated_at)
                  VALUES('p-toctou','project-1','image','toctou','p0','TOCTOU',?,?,0,'disabled','progress','main',?,?)""", (str(moved), str(moved).casefold(), now, now))
    db.commit()
    outside = workspace / "outside"
    outside.mkdir()
    db.execute("UPDATE progress_folders SET folder_path=?,folder_path_key=? WHERE id='p-toctou'", (str(outside), str(outside).casefold()))
    db.commit()
    try:
        manage_progress({"action": "update", "progressId": "p-toctou", "expectedUpdatedAt": now, "displayName": "Escaped"})
        raise AssertionError("progress moved outside scope after preflight was accepted")
    except ValueError as error:
        assert "scope" in str(error)
    deleted = dbmod.media_component_delete_version(db, {"projectId": "project-1", "projectPath": str(project), "scopePath": str(project), "versionId": "v1", "expectedUpdatedAt": update["version"]["updatedAt"]})
    assert deleted["versionId"] == "v1"
    db.close()

print("Component Host API V6 database CAS tests passed")
