"""Legacy snapshot declarations owned by the plugin."""

from . import DOMAIN


def declaration():
    return {
        "pathColumns": {
            "team_patch_tasks": ("patch_path", "mask_path", "edited_patch_path"),
            "team_person_assignments": ("edited_patch_path",),
        },
        "projectTables": (
            "team_patch_tasks", "team_retouch_photos", "team_person_identities",
            "team_person_assignments", "team_person_exclusions",
        ),
    }


def project_metadata(_db, _project, photo_ids, name_hash, workflow_hash):
    return {
        "workspaceDataPrefixes": [f"team-retouch/{photo_id}/" for photo_id in photo_ids],
        "workspaceDataFiles": [
            f"team-retouch/workflows/{workflow_hash}.json",
            f"team-retouch/identity-similarities/{name_hash}.json",
            f"team-retouch/workflow-settings/{name_hash}.json",
        ],
    }


def restore_project_table(db, table, column_list, project_id):
    if table != "team_patch_tasks":
        return False
    db.execute(
        f"INSERT INTO team_patch_tasks({column_list}) SELECT {column_list} FROM portable.team_patch_tasks WHERE photo_id IN (SELECT id FROM portable.photos WHERE project_id=?)",
        (project_id,),
    )
    return True


DOMAIN.hooks["backup_declaration"].append(declaration)
DOMAIN.hooks["backup_project_metadata"].append(project_metadata)
DOMAIN.hooks["backup_restore_project_table"].append(restore_project_table)
