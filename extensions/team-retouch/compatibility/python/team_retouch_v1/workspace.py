"""Plugin-owned workspace compatibility for legacy data."""

import json
import os
import shutil
import time
import uuid

from compatibility.registry import register_exports

from . import DOMAIN
from .storage import attach_and_migrate, cleanup_empty_recreated_legacy_tables


def bind_core(core):
    values = core if isinstance(core, dict) else {name: getattr(core, name) for name in dir(core) if not name.startswith("__")}
    globals().update({name: value for name, value in values.items() if not name.startswith("__")})


def prepare_connection(db, database, enabled):
    cleanup_empty_recreated_legacy_tables(db)
    if enabled:
        attach_and_migrate(db, database)


def _columns(db, table):
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}


def _table_available(db, table):
    return any(db.execute(f"SELECT 1 FROM {schema}.sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
               for schema in (row[1] for row in db.execute("PRAGMA database_list").fetchall()))


def migrate(db, version):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if version == 11 and "team_patch_tasks" in tables:
        columns = _columns(db, "team_patch_tasks")
        additions = {
            "mask_path": "TEXT",
            "mask_json": "TEXT NOT NULL DEFAULT '{}'",
            "members_json": "TEXT NOT NULL DEFAULT '[]'",
            "needs_review": "INTEGER NOT NULL DEFAULT 0",
            "review_reason": "TEXT NOT NULL DEFAULT ''",
        }
        for name, declaration in additions.items():
            if name not in columns:
                db.execute(f"ALTER TABLE team_patch_tasks ADD COLUMN {name} {declaration}")
        if "team_retouch_photos" in tables:
            db.execute(
                """INSERT OR IGNORE INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at)
                   SELECT task.photo_id,photos.project_id,task.base_version_id,MIN(task.created_at),MAX(task.updated_at)
                   FROM team_patch_tasks task JOIN photos ON photos.id=task.photo_id
                   WHERE task.is_deleted=0 AND task.updated_at=(
                     SELECT MAX(latest.updated_at) FROM team_patch_tasks latest
                     WHERE latest.photo_id=task.photo_id AND latest.is_deleted=0
                   ) GROUP BY task.photo_id"""
            )
    if version == 15 and "team_person_assignments" in tables:
        columns = _columns(db, "team_person_assignments")
        if "completion_kind" not in columns:
            db.execute("ALTER TABLE team_person_assignments ADD COLUMN completion_kind TEXT NOT NULL DEFAULT ''")
        if "edited_patch_path" not in columns:
            db.execute("ALTER TABLE team_person_assignments ADD COLUMN edited_patch_path TEXT")
        if "completed_at" not in columns:
            db.execute("ALTER TABLE team_person_assignments ADD COLUMN completed_at INTEGER")
        db.execute(
            """UPDATE team_person_assignments
               SET completion_kind=CASE WHEN completed=1 THEN 'no-retouch' ELSE '' END,
                   completed_at=CASE WHEN completed=1 THEN updated_at ELSE NULL END
               WHERE completion_kind=''"""
        )
        if "team_patch_tasks" in tables:
            tasks = db.execute(
                """SELECT photo_id,base_version_id,edited_patch_path FROM team_patch_tasks
                   WHERE is_deleted=0 AND edited_patch_path IS NOT NULL"""
            ).fetchall()
            for task in tasks:
                latest = db.execute(
                    """SELECT person_index FROM team_person_assignments
                       WHERE photo_id=? AND base_version_id=? AND completed=1
                       ORDER BY updated_at DESC,person_index DESC LIMIT 1""",
                    (task["photo_id"], task["base_version_id"]),
                ).fetchone()
                if latest is not None:
                    db.execute(
                        """UPDATE team_person_assignments SET completion_kind='returned',edited_patch_path=?
                           WHERE photo_id=? AND base_version_id=? AND person_index=?""",
                        (task["edited_patch_path"], task["photo_id"], task["base_version_id"], latest["person_index"]),
                    )
    if version == 17 and "team_person_assignments" in tables:
        columns = _columns(db, "team_person_assignments")
        if "return_missing" not in columns:
            db.execute("ALTER TABLE team_person_assignments ADD COLUMN return_missing INTEGER NOT NULL DEFAULT 0 CHECK(return_missing IN (0,1))")
        if "return_missing_since" not in columns:
            db.execute("ALTER TABLE team_person_assignments ADD COLUMN return_missing_since INTEGER")
    if version == 32:
        attached = {row[1] for row in db.execute("PRAGMA database_list").fetchall()}
        schema = "versioning" if "versioning" in attached else "main"
        progress_tables = {row[0] for row in db.execute(f"SELECT name FROM {schema}.sqlite_master WHERE type='table'").fetchall()}
        progress_columns = {row[1] for row in db.execute(f"PRAGMA {schema}.table_info(progress_folders)").fetchall()}
        if "progress_folders" in progress_tables and "source_metadata_json" in progress_columns:
            db.execute(
                """UPDATE progress_folders SET source_metadata_json=?
                   WHERE node_role='workflow' AND artifact_kind='team_workspace'
                     AND (source_metadata_json IS NULL OR source_metadata_json='{}')""",
                (json.dumps({"category": "workflow", "role": "component-workspace", "componentId": "team-retouch", "parentCapability": "workflow-input"}, separators=(",", ":")),),
            )


def integrity(db):
    attached = {row[1] for row in db.execute("PRAGMA database_list").fetchall()}
    if "team_retouch" not in attached:
        return {"quickCheck": ["ok"], "foreignKeyErrors": [], "businessChecks": {}}
    return {
        "quickCheck": [row[0] for row in db.execute("PRAGMA team_retouch.quick_check").fetchall()],
        "foreignKeyErrors": db.execute("PRAGMA team_retouch.foreign_key_check").fetchall(),
        "businessChecks": {
            "team_patch_tasks.owner": """SELECT COUNT(*) FROM team_patch_tasks item WHERE NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.id=item.photo_id AND versions.id=item.base_version_id) OR (item.merged_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM versions WHERE versions.id=item.merged_version_id))""",
            "team_retouch_photos.owner": """SELECT COUNT(*) FROM team_retouch_photos item WHERE NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.project_id=item.project_id AND photos.id=item.photo_id AND versions.id=item.base_version_id)""",
            "team_person_identities.owner": """SELECT COUNT(*) FROM team_person_identities item WHERE NOT EXISTS(SELECT 1 FROM projects WHERE projects.id=item.project_id)""",
            "team_person_assignments.owner": """SELECT COUNT(*) FROM team_person_assignments item WHERE NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.project_id=item.project_id AND photos.id=item.photo_id AND versions.id=item.base_version_id) OR (item.identity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM team_person_identities identity WHERE identity.id=item.identity_id AND identity.project_id=item.project_id))""",
            "team_person_exclusions.owner": """SELECT COUNT(*) FROM team_person_exclusions item WHERE NOT EXISTS(SELECT 1 FROM photos JOIN versions ON versions.photo_id=photos.id WHERE photos.project_id=item.project_id AND photos.id=item.photo_id AND versions.id=item.base_version_id)""",
        },
    }


def delete_versions(db, version_ids, timestamp):
    if not version_ids or not _table_available(db, "team_patch_tasks"):
        return {"teamArtifactPaths": []}
    placeholders = ",".join("?" for _ in version_ids)
    rows = db.execute(
        f"SELECT patch_path,mask_path,edited_patch_path,members_json FROM team_patch_tasks WHERE base_version_id IN ({placeholders})",
        version_ids,
    ).fetchall()
    candidates = team_artifact_paths(rows)
    db.execute(f"DELETE FROM team_patch_tasks WHERE base_version_id IN ({placeholders})", version_ids)
    db.execute(f"DELETE FROM team_person_assignments WHERE base_version_id IN ({placeholders})", version_ids)
    db.execute(f"DELETE FROM team_person_exclusions WHERE base_version_id IN ({placeholders})", version_ids)
    db.execute(f"DELETE FROM team_retouch_photos WHERE base_version_id IN ({placeholders})", version_ids)
    db.execute(
        f"""UPDATE team_patch_tasks SET merged_version_id=NULL,
              status=CASE WHEN edited_patch_path IS NOT NULL THEN 'uploaded' ELSE 'exported' END,
              updated_at=? WHERE merged_version_id IN ({placeholders}) AND is_deleted=0""",
        (timestamp, *version_ids),
    )
    return {"teamArtifactPaths": unreferenced_team_artifact_paths(db, candidates)}


def project_cleanup_plan(_db, project_id, photo_ids):
    return {"teamCleanup": {"projectId": project_id, "photoIds": photo_ids}}


def merge_photo_history(db, project, source_photo_id, target_photo_id, timestamp):
    if not _table_available(db, "team_patch_tasks"):
        return
    db.execute("UPDATE team_patch_tasks SET photo_id=?,updated_at=? WHERE photo_id=?", (target_photo_id, timestamp, source_photo_id))
    db.execute("UPDATE team_person_assignments SET photo_id=?,updated_at=? WHERE photo_id=?", (target_photo_id, timestamp, source_photo_id))
    db.execute("UPDATE team_person_exclusions SET photo_id=? WHERE photo_id=?", (target_photo_id, source_photo_id))
    registration = db.execute("SELECT * FROM team_retouch_photos WHERE photo_id=?", (source_photo_id,)).fetchone()
    if registration is not None:
        db.execute("DELETE FROM team_retouch_photos WHERE photo_id=?", (target_photo_id,))
        db.execute(
            "UPDATE team_retouch_photos SET photo_id=?,project_id=?,updated_at=? WHERE photo_id=?",
            (target_photo_id, project["id"], timestamp, source_photo_id),
        )


def migrate_workflow_graph(db, project, directories, timestamp, _node_for_path, insert_artifact, add_edge):
    folder = directories.get("团片协作")
    if not folder:
        return
    workflow = insert_artifact(
        folder, os.path.basename(folder), "image", "team-workspace", "workflow", "team_workspace",
    )
    db.execute(
        "UPDATE progress_folders SET source_metadata_json=? WHERE id=?",
        (json.dumps({"category": "workflow", "role": "component-workspace", "componentId": "team-retouch", "parentCapability": "workflow-input"}, separators=(",", ":")), workflow["id"]),
    )
    attached = {row[1] for row in db.execute("PRAGMA database_list").fetchall()}
    source_table = (
        "team_retouch.team_retouch_photos" if "team_retouch" in attached
        else "main.team_retouch_photos" if "team_retouch_photos" in {
            row[0] for row in db.execute("SELECT name FROM main.sqlite_master WHERE type='table'").fetchall()
        } else None
    )
    if workflow["node_role"] != "workflow" or workflow["artifact_kind"] != "team_workspace" or not source_table:
        return
    source_rows = db.execute(
        f"""SELECT versions.file_path FROM {source_table} item
           JOIN versions ON versions.id=item.base_version_id AND versions.is_deleted=0
           WHERE item.project_id=?""",
        (project["id"],),
    ).fetchall()
    candidates = db.execute(
        """SELECT * FROM progress_folders WHERE project_id=? AND media_kind='image'
           AND node_role='progress' AND missing_since IS NULL""",
        (project["id"],),
    ).fetchall()
    sources = set()
    for source_row in source_rows:
        file_key = canonical_path(source_row["file_path"]).casefold()
        matches = [candidate for candidate in candidates if file_key.startswith(candidate["folder_path_key"] + os.sep.casefold())]
        if matches:
            sources.add(max(matches, key=lambda candidate: len(candidate["folder_path_key"]))["id"])
    for source_id in sorted(sources):
        add_edge(next(candidate for candidate in candidates if candidate["id"] == source_id), workflow, "workflow_input")


def team_artifact_paths(rows) -> list[str]:
    values = []
    for row in rows:
        values.extend(value for value in (row["patch_path"], row["mask_path"], row["edited_patch_path"]) if value)
        try:
            members = json.loads(row["members_json"] or "[]")
        except (KeyError, IndexError, TypeError, json.JSONDecodeError):
            members = []
        values.extend(str(member.get("maskPath")) for member in members if member.get("maskPath"))
    return list(dict.fromkeys(values))

def team_assignment_artifact_paths(db, photo_id: str, base_version_id: str, person_indices=None) -> list[str]:
    values = [photo_id, base_version_id]
    member_filter = ""
    if person_indices:
        indexes = sorted({int(value) for value in person_indices})
        member_filter = f" AND person_index IN ({','.join('?' for _ in indexes)})"
        values.extend(indexes)
    rows = db.execute(
        f"""SELECT edited_patch_path FROM team_person_assignments
            WHERE photo_id=? AND base_version_id=? AND edited_patch_path IS NOT NULL{member_filter}""",
        values,
    ).fetchall()
    return list(dict.fromkeys(row["edited_patch_path"] for row in rows if row["edited_patch_path"]))

def unreferenced_team_artifact_paths(db, candidates: list[str]) -> list[str]:
    if not candidates:
        return []
    referenced = set()
    for row in db.execute(
        "SELECT patch_path,mask_path,edited_patch_path,members_json FROM team_patch_tasks WHERE is_deleted=0"
    ).fetchall():
        referenced.update(canonical_path(value) for value in (row["patch_path"], row["mask_path"], row["edited_patch_path"]) if value)
        try:
            members = json.loads(row["members_json"] or "[]")
        except json.JSONDecodeError:
            members = []
        referenced.update(canonical_path(member["maskPath"]) for member in members if member.get("maskPath"))
    for row in db.execute(
        "SELECT edited_patch_path FROM team_person_assignments WHERE edited_patch_path IS NOT NULL"
    ).fetchall():
        referenced.add(canonical_path(row["edited_patch_path"]))
    return [value for value in dict.fromkeys(candidates) if canonical_path(value) not in referenced]

def serialize_team_patch(row):
    return {
        "id": row["id"], "photoId": row["photo_id"], "baseVersionId": row["base_version_id"],
        "personIndex": row["person_index"], "personName": row["person_name"], "assignee": row["assignee"],
        "detector": row["detector"], "bbox": json.loads(row["bbox_json"]), "crop": json.loads(row["crop_json"]),
        "patchPath": row["patch_path"], "maskPath": row["mask_path"], "mask": json.loads(row["mask_json"] or "{}"),
        "members": json.loads(row["members_json"] or "[]"),
        "needsReview": bool(row["needs_review"]), "reviewReason": row["review_reason"],
        "editedPatchPath": row["edited_patch_path"], "status": row["status"],
        "mergeMetrics": json.loads(row["merge_metrics_json"] or "{}"), "mergedVersionId": row["merged_version_id"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }

def is_generated_team_identity_name(name):
    prefix = "\u5f85\u786e\u8ba4\u4eba\u7269 "
    value = str(name or "")
    return value.startswith(prefix) and value[len(prefix):].isdigit()

def cleanup_empty_generated_team_identities(db, project_id):
    rows = db.execute(
        """SELECT identity.id,identity.name
           FROM team_person_identities identity
           LEFT JOIN team_person_assignments assignment ON assignment.identity_id=identity.id
           WHERE identity.project_id=?
           GROUP BY identity.id
           HAVING COUNT(assignment.identity_id)=0""",
        (project_id,),
    ).fetchall()
    stale_ids = [row["id"] for row in rows if is_generated_team_identity_name(row["name"])]
    if stale_ids:
        db.executemany("DELETE FROM team_person_identities WHERE id=?", ((identity_id,) for identity_id in stale_ids))
    return len(stale_ids)

def team_patch_list(db, payload: dict):
    rows = db.execute(
        """SELECT * FROM team_patch_tasks WHERE photo_id=? AND is_deleted=0
           ORDER BY person_index, created_at""", (payload["photoId"],)
    ).fetchall()
    return {"success": True, "tasks": [serialize_team_patch(row) for row in rows]}

def reconcile_team_return_artifacts(db, project_id: str) -> dict:
    """Reconcile returned-image history with disk while keeping paths recoverable."""
    timestamp = int(time.time() * 1000)
    assignments = db.execute(
        """SELECT photo_id,base_version_id,person_index,edited_patch_path,
                  return_missing,return_missing_since,completed_at,updated_at
           FROM team_person_assignments
           WHERE project_id=? AND completed=1 AND completion_kind='returned'""",
        (project_id,),
    ).fetchall()
    assignment_states = {}
    missing_count = 0
    changed_count = 0
    for row in assignments:
        artifact_exists = bool(row["edited_patch_path"] and os.path.isfile(row["edited_patch_path"]))
        missing = not artifact_exists
        missing_count += int(missing)
        missing_since = (row["return_missing_since"] or timestamp) if missing else None
        if bool(row["return_missing"]) != missing or row["return_missing_since"] != missing_since:
            db.execute(
                """UPDATE team_person_assignments
                   SET return_missing=?,return_missing_since=?
                   WHERE photo_id=? AND base_version_id=? AND person_index=?""",
                (int(missing), missing_since, row["photo_id"], row["base_version_id"], row["person_index"]),
            )
            changed_count += 1
        assignment_states[(row["photo_id"], row["base_version_id"], int(row["person_index"]))] = {
            "path": row["edited_patch_path"],
            "missing": missing,
            "completed_at": int(row["completed_at"] or row["updated_at"] or 0),
        }

    tasks = db.execute(
        """SELECT task.id,task.photo_id,task.base_version_id,task.person_index,task.members_json,
                  task.edited_patch_path,task.status
           FROM team_patch_tasks task
           JOIN photos ON photos.id=task.photo_id
           WHERE photos.project_id=? AND task.is_deleted=0""",
        (project_id,),
    ).fetchall()
    for task in tasks:
        try:
            members = json.loads(task["members_json"] or "[]")
        except json.JSONDecodeError:
            members = []
        person_indices = {int(member.get("personIndex") or 0) for member in members}
        if not person_indices:
            person_indices = {int(task["person_index"])}
        task_assignments = [
            assignment_states[(task["photo_id"], task["base_version_id"], person_index)]
            for person_index in person_indices
            if (task["photo_id"], task["base_version_id"], person_index) in assignment_states
        ]
        # Legacy task-only returns have no person assignment to reconcile.
        if not task_assignments:
            continue
        available = [item for item in task_assignments if not item["missing"] and item["path"]]
        latest = max(available, key=lambda item: item["completed_at"], default=None)
        desired_path = latest["path"] if latest else None
        desired_status = task["status"] if task["status"] == "merged" else "uploaded" if desired_path else "exported"
        current_path = canonical_path(task["edited_patch_path"]) if task["edited_patch_path"] else None
        if current_path != desired_path or task["status"] != desired_status:
            db.execute(
                "UPDATE team_patch_tasks SET edited_patch_path=?,status=?,updated_at=? WHERE id=?",
                (desired_path, desired_status, timestamp, task["id"]),
            )
            changed_count += 1
    if changed_count:
        db.commit()
    return {"missingCount": missing_count, "changedCount": changed_count}

def ensure_team_workflow_node(root: str, db, project):
    project_path = canonical_path(os.path.join(os.path.abspath(root), project["relative_path"]))
    folder_path = canonical_path(os.path.join(project_path, "团片协作"))
    if not os.path.isdir(folder_path):
        return None, False
    existing = db.execute(
        "SELECT id FROM progress_folders WHERE project_id=? AND folder_path_key=?",
        (project["id"], folder_path.casefold()),
    ).fetchone()
    request = {
        "projectName": project["name"],
        "mediaKind": "image",
        "versionKey": "team-workspace",
        "displayName": "团片协作",
        "folderPath": folder_path,
        "nodeRole": "workflow",
        "artifactKind": "team_workspace",
        "sourceMetadata": {"category": "workflow", "role": "component-workspace", "componentId": "team-retouch", "parentCapability": "workflow-input"},
        "trackingEnabled": False,
        "trackingState": "disabled",
        "renameFromParent": False,
        "copyMissingFromParent": False,
    }
    if existing is not None:
        request["progressId"] = existing["id"]
    return progress_register(root, db, request, allow_role_conversion=True)["progressFolder"], existing is None

def team_project_workspace(root: str, db, payload: dict):
    project = project_row(db, payload["projectName"])
    return_artifacts = reconcile_team_return_artifacts(db, project["id"])
    if cleanup_empty_generated_team_identities(db, project["id"]):
        db.commit()
    project_path = os.path.join(os.path.abspath(root), project["relative_path"])
    workflow_node, workflow_node_created = ensure_team_workflow_node(root, db, project)
    rows = db.execute(
        """SELECT task.*, photos.display_name AS photo_name, photos.original_name, photos.current_version_id,
                  versions.file_path AS source_path
           FROM team_patch_tasks task
           JOIN photos ON photos.id=task.photo_id AND photos.is_deleted=0
           JOIN versions ON versions.id=task.base_version_id AND versions.is_deleted=0
           WHERE photos.project_id=? AND task.is_deleted=0
           ORDER BY photos.created_at, task.photo_id, task.person_index""",
        (project["id"],),
    ).fetchall()
    groups = {}
    for row in rows:
        key = f'{row["photo_id"]}:{row["base_version_id"]}'
        if key not in groups:
            relative_path = os.path.relpath(row["source_path"], project_path)
            groups[key] = {
                "photoId": row["photo_id"], "baseVersionId": row["base_version_id"],
                "name": row["photo_name"] or os.path.splitext(row["original_name"])[0],
                "relativePath": relative_path, "sourcePath": row["source_path"], "tasks": [],
                "currentVersionId": row["current_version_id"], "latestTaskAt": 0,
            }
        groups[key]["tasks"].append(serialize_team_patch(row))
        groups[key]["latestTaskAt"] = max(groups[key]["latestTaskAt"], int(row["updated_at"] or 0))
    selected_groups = {}
    for group in groups.values():
        current = selected_groups.get(group["photoId"])
        group_is_current = group["baseVersionId"] == group["currentVersionId"]
        current_is_current = current and current["baseVersionId"] == current["currentVersionId"]
        if current is None or group_is_current and not current_is_current or group_is_current == current_is_current and group["latestTaskAt"] > current["latestTaskAt"]:
            selected_groups[group["photoId"]] = group
    registered = db.execute(
        """SELECT registered.photo_id,registered.base_version_id,registered.created_at,registered.updated_at,
                  photos.display_name,photos.original_name,versions.file_path AS source_path
           FROM team_retouch_photos registered
           JOIN photos ON photos.id=registered.photo_id AND photos.is_deleted=0
           JOIN versions ON versions.id=registered.base_version_id AND versions.is_deleted=0
           WHERE registered.project_id=? ORDER BY registered.created_at""",
        (project["id"],),
    ).fetchall()
    for row in registered:
        key = f'{row["photo_id"]}:{row["base_version_id"]}'
        group = groups.get(key) or {
            "photoId": row["photo_id"], "baseVersionId": row["base_version_id"],
            "name": row["display_name"] or os.path.splitext(row["original_name"])[0],
            "relativePath": os.path.relpath(row["source_path"], project_path),
            "sourcePath": row["source_path"], "tasks": [], "currentVersionId": row["base_version_id"],
            "latestTaskAt": int(row["updated_at"] or 0),
        }
        selected_groups[row["photo_id"]] = group
    photos = []
    exclusion_counts = {
        f'{row["photo_id"]}:{row["base_version_id"]}': int(row["count"])
        for row in db.execute(
            """SELECT photo_id,base_version_id,COUNT(*) AS count
               FROM team_person_exclusions WHERE project_id=?
               GROUP BY photo_id,base_version_id""",
            (project["id"],),
        ).fetchall()
    }
    for group in selected_groups.values():
        group.pop("currentVersionId", None)
        group.pop("latestTaskAt", None)
        group["excludedPersonCount"] = exclusion_counts.get(f'{group["photoId"]}:{group["baseVersionId"]}', 0)
        photos.append(group)
    identities = [dict(row) for row in db.execute(
        "SELECT id,name,color,created_at AS createdAt,updated_at AS updatedAt FROM team_person_identities WHERE project_id=? ORDER BY created_at",
        (project["id"],),
    ).fetchall()]
    assignments = [dict(row) for row in db.execute(
        """SELECT photo_id AS photoId,base_version_id AS baseVersionId,person_index AS personIndex,
                  identity_id AS identityId,confidence,source,completed,
                  completion_kind AS completionKind,edited_patch_path AS editedPatchPath,
                  return_missing AS returnMissing,return_missing_since AS returnMissingSince,
                  completed_at AS completedAt,updated_at AS updatedAt
           FROM team_person_assignments WHERE project_id=?""",
        (project["id"],),
    ).fetchall()]
    for item in assignments:
        item["returnMissing"] = bool(item["returnMissing"])
        item["completed"] = bool(item["completed"]) and not item["returnMissing"]
    return {"success": True, "photos": photos, "identities": identities, "assignments": assignments,
            "workflowNode": workflow_node, "workflowNodeCreated": workflow_node_created,
            "missingReturnCount": return_artifacts["missingCount"]}

def team_project_register_photo(db, payload: dict):
    project = project_row(db, payload["projectName"])
    photo = db.execute("SELECT id,project_id FROM photos WHERE id=? AND is_deleted=0", (payload["photoId"],)).fetchone()
    version = db.execute("SELECT id,photo_id FROM versions WHERE id=? AND is_deleted=0", (payload["baseVersionId"],)).fetchone()
    if photo is None or photo["project_id"] != project["id"] or version is None or version["photo_id"] != photo["id"]:
        raise ValueError("团片协作图片或基础版本不属于当前项目")
    has_crop_task = db.execute(
        "SELECT 1 FROM team_patch_tasks WHERE photo_id=? AND base_version_id=? AND is_deleted=0 LIMIT 1",
        (photo["id"], version["id"]),
    ).fetchone()
    if has_crop_task is None:
        raise ValueError("团片协作图片尚未产生实际裁剪任务，不能登记")
    timestamp = int(time.time() * 1000)
    db.execute(
        """INSERT INTO team_retouch_photos(photo_id,project_id,base_version_id,created_at,updated_at) VALUES(?,?,?,?,?)
           ON CONFLICT(photo_id) DO UPDATE SET base_version_id=excluded.base_version_id,updated_at=excluded.updated_at""",
        (photo["id"], project["id"], version["id"], timestamp, timestamp),
    )
    db.commit()
    return {"success": True}

def team_project_unregister_photo(db, payload: dict):
    db.execute("DELETE FROM team_retouch_photos WHERE photo_id=?", (payload["photoId"],))
    db.commit()
    return {"success": True}

def team_identity_save(db, payload: dict):
    project = project_row(db, payload["projectName"])
    timestamp = int(time.time() * 1000)
    identity_id = str(payload.get("identityId") or uuid.uuid4())
    name = str(payload.get("name") or "未命名人物").strip()[:80] or "未命名人物"
    existing = db.execute("SELECT id FROM team_person_identities WHERE id=? AND project_id=?", (identity_id, project["id"])).fetchone()
    if existing:
        db.execute("UPDATE team_person_identities SET name=?,updated_at=? WHERE id=?", (name, timestamp, identity_id))
    else:
        colors = ("#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#059669", "#0891b2", "#4f46e5")
        count = db.execute("SELECT COUNT(*) FROM team_person_identities WHERE project_id=?", (project["id"],)).fetchone()[0]
        db.execute(
            "INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (identity_id, project["id"], name, colors[count % len(colors)], timestamp, timestamp),
        )
    for assignment in payload.get("assignments") or []:
        db.execute(
            """INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(photo_id,base_version_id,person_index) DO UPDATE SET
                 identity_id=excluded.identity_id,confidence=excluded.confidence,source=excluded.source,
                 completed=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.completed ELSE 0 END,
                 completion_kind=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.completion_kind ELSE '' END,
                 edited_patch_path=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.edited_patch_path ELSE NULL END,
                 return_missing=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.return_missing ELSE 0 END,
                 return_missing_since=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.return_missing_since ELSE NULL END,
                 completed_at=CASE WHEN team_person_assignments.identity_id=excluded.identity_id THEN team_person_assignments.completed_at ELSE NULL END,
                 updated_at=excluded.updated_at""",
            (project["id"], assignment["photoId"], assignment["baseVersionId"], int(assignment["personIndex"]),
             identity_id, float(assignment.get("confidence", 1)), str(assignment.get("source") or "manual"),
             int(bool(assignment.get("completed", False))), timestamp),
        )
    db.commit()
    return {"success": True, "identityId": identity_id}

def team_identity_assign(db, payload: dict):
    project = project_row(db, payload["projectName"])
    identity_id = payload.get("identityId") or None
    if identity_id and db.execute("SELECT id FROM team_person_identities WHERE id=? AND project_id=?", (identity_id, project["id"])).fetchone() is None:
        raise ValueError("人物身份不存在")
    timestamp = int(time.time() * 1000)
    existing = db.execute(
        "SELECT identity_id,completed FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?",
        (payload["photoId"], payload["baseVersionId"], int(payload["personIndex"])),
    ).fetchone()
    completed = bool(payload.get("completed", False))
    if not identity_id or existing and existing["identity_id"] != identity_id:
        completed = False
    db.execute(
        """INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(photo_id,base_version_id,person_index) DO UPDATE SET
             identity_id=excluded.identity_id,confidence=excluded.confidence,source=excluded.source,
             completed=excluded.completed,
             completion_kind=CASE WHEN excluded.completed=1 THEN team_person_assignments.completion_kind ELSE '' END,
             edited_patch_path=CASE WHEN excluded.completed=1 THEN team_person_assignments.edited_patch_path ELSE NULL END,
             return_missing=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing ELSE 0 END,
             return_missing_since=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing_since ELSE NULL END,
             completed_at=CASE WHEN excluded.completed=1 THEN team_person_assignments.completed_at ELSE NULL END,
             updated_at=excluded.updated_at""",
        (project["id"], payload["photoId"], payload["baseVersionId"], int(payload["personIndex"]), identity_id,
         float(payload.get("confidence", 1)), str(payload.get("source") or "manual"), int(completed), timestamp),
    )
    previous_identity_id = existing["identity_id"] if existing else None
    if previous_identity_id and previous_identity_id != identity_id:
        cleanup_empty_generated_team_identities(db, project["id"])
    db.commit()
    return {"success": True}

def team_identity_confirm_group(db, payload: dict):
    project = project_row(db, payload["projectName"])
    timestamp = int(time.time() * 1000)
    requested_identity_id = str(payload.get("identityId") or "").strip() or None
    requested_name = str(payload.get("name") or "").strip()[:80]
    assignments = payload.get("assignments") or []
    if not assignments:
        raise ValueError("没有需要标记的人物")

    identity_id = requested_identity_id
    if requested_name:
        same_name = db.execute(
            "SELECT id FROM team_person_identities WHERE project_id=? AND lower(trim(name))=lower(trim(?)) LIMIT 1",
            (project["id"], requested_name),
        ).fetchone()
        if same_name and same_name["id"] != requested_identity_id:
            identity_id = same_name["id"]
        elif requested_identity_id:
            existing = db.execute(
                "SELECT id FROM team_person_identities WHERE id=? AND project_id=?",
                (requested_identity_id, project["id"]),
            ).fetchone()
            if existing is None:
                raise ValueError("人物身份不存在")
            db.execute(
                "UPDATE team_person_identities SET name=?,updated_at=? WHERE id=?",
                (requested_name, timestamp, requested_identity_id),
            )
        else:
            identity_id = str(uuid.uuid4())
            colors = ("#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#059669", "#0891b2", "#4f46e5")
            count = db.execute("SELECT COUNT(*) FROM team_person_identities WHERE project_id=?", (project["id"],)).fetchone()[0]
            db.execute(
                "INSERT INTO team_person_identities(id,project_id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (identity_id, project["id"], requested_name, colors[count % len(colors)], timestamp, timestamp),
            )
    elif identity_id:
        existing = db.execute(
            "SELECT id FROM team_person_identities WHERE id=? AND project_id=?",
            (identity_id, project["id"]),
        ).fetchone()
        if existing is None:
            raise ValueError("人物身份不存在")

    anchor_key = str(payload.get("anchorSubjectKey") or "")
    seen = set()
    updated = 0
    previous_identity_ids = set()
    for assignment in payload.get("clearAssignments") or []:
        photo_id = str(assignment.get("photoId") or "")
        base_version_id = str(assignment.get("baseVersionId") or "")
        person_index = int(assignment.get("personIndex"))
        existing_assignment = db.execute(
            """SELECT identity_id FROM team_person_assignments
               WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?""",
            (project["id"], photo_id, base_version_id, person_index),
        ).fetchone()
        if existing_assignment is None:
            continue
        if existing_assignment["identity_id"]:
            previous_identity_ids.add(existing_assignment["identity_id"])
        db.execute(
            """DELETE FROM team_person_assignments
               WHERE project_id=? AND photo_id=? AND base_version_id=? AND person_index=?""",
            (project["id"], photo_id, base_version_id, person_index),
        )
    for assignment in assignments:
        photo_id = str(assignment.get("photoId") or "")
        base_version_id = str(assignment.get("baseVersionId") or "")
        person_index = int(assignment.get("personIndex"))
        key = f"{photo_id}:{base_version_id}:{person_index}"
        if key in seen:
            continue
        seen.add(key)
        owned = db.execute(
            """SELECT 1 FROM photos photo
               JOIN versions version ON version.id=? AND version.photo_id=photo.id AND version.is_deleted=0
               WHERE photo.id=? AND photo.project_id=? AND photo.is_deleted=0""",
            (base_version_id, photo_id, project["id"]),
        ).fetchone()
        if owned is None:
            raise ValueError("人物实例不属于当前团片协作项目")
        existing_assignment = db.execute(
            "SELECT identity_id,completed FROM team_person_assignments WHERE photo_id=? AND base_version_id=? AND person_index=?",
            (photo_id, base_version_id, person_index),
        ).fetchone()
        previous_identity_id = existing_assignment["identity_id"] if existing_assignment else None
        if previous_identity_id:
            previous_identity_ids.add(previous_identity_id)
        completed = bool(existing_assignment["completed"]) if existing_assignment and previous_identity_id == identity_id else False
        source = "manual" if key == anchor_key else "manual-group"
        db.execute(
            """INSERT INTO team_person_assignments(project_id,photo_id,base_version_id,person_index,identity_id,confidence,source,completed,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(photo_id,base_version_id,person_index) DO UPDATE SET
                 identity_id=excluded.identity_id,confidence=excluded.confidence,source=excluded.source,
                 completed=excluded.completed,
                 completion_kind=CASE WHEN excluded.completed=1 THEN team_person_assignments.completion_kind ELSE '' END,
                 edited_patch_path=CASE WHEN excluded.completed=1 THEN team_person_assignments.edited_patch_path ELSE NULL END,
                 return_missing=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing ELSE 0 END,
                 return_missing_since=CASE WHEN excluded.completed=1 THEN team_person_assignments.return_missing_since ELSE NULL END,
                 completed_at=CASE WHEN excluded.completed=1 THEN team_person_assignments.completed_at ELSE NULL END,
                 updated_at=excluded.updated_at""",
            (project["id"], photo_id, base_version_id, person_index, identity_id,
             float(assignment.get("confidence", 1)), source, int(completed), timestamp),
        )
        updated += 1

    if any(previous_identity_id != identity_id for previous_identity_id in previous_identity_ids):
        cleanup_empty_generated_team_identities(db, project["id"])
    db.commit()
    return {"success": True, "identityId": identity_id, "updatedCount": updated}

def team_identity_complete(db, payload: dict):
    timestamp = int(time.time() * 1000)
    completed = bool(payload.get("completed"))
    completion_kind = str(payload.get("completionKind") or ("no-retouch" if completed else ""))
    if completion_kind not in ("", "returned", "no-retouch", "skip-requested"):
        raise ValueError("人物完成方式无效")
    edited_patch_path = canonical_path(payload["editedPatchPath"]) if payload.get("editedPatchPath") else None
    result = db.execute(
        """UPDATE team_person_assignments
           SET completed=?,completion_kind=?,edited_patch_path=?,return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=?
           WHERE photo_id=? AND base_version_id=? AND person_index=?""",
        (int(completed), completion_kind, edited_patch_path, timestamp if completed else None, timestamp,
         payload["photoId"], payload["baseVersionId"], int(payload["personIndex"])),
    )
    if result.rowcount != 1:
        raise ValueError("请先给这个人物标记身份")
    db.commit()
    return {"success": True}

def team_identity_delete(db, payload: dict):
    project = project_row(db, payload["projectName"])
    db.execute(
        """UPDATE team_person_assignments
           SET completed=0,completion_kind='',edited_patch_path=NULL,return_missing=0,return_missing_since=NULL,completed_at=NULL
           WHERE identity_id=? AND project_id=?""",
        (payload["identityId"], project["id"]),
    )
    db.execute("DELETE FROM team_person_identities WHERE id=? AND project_id=?", (payload["identityId"], project["id"]))
    db.commit()
    return {"success": True}

def team_person_exclusion_list(db, payload: dict):
    values = [payload["photoId"], payload["baseVersionId"]]
    project_filter = ""
    if payload.get("projectName"):
        project = project_row(db, payload["projectName"])
        project_filter = " AND project_id=?"
        values.append(project["id"])
    rows = db.execute(
        f"""SELECT id,photo_id AS photoId,base_version_id AS baseVersionId,
                   bbox_json,reason,created_at AS createdAt
            FROM team_person_exclusions
            WHERE photo_id=? AND base_version_id=?{project_filter}
            ORDER BY created_at""",
        values,
    ).fetchall()
    return {
        "success": True,
        "exclusions": [{
            "id": row["id"],
            "photoId": row["photoId"],
            "baseVersionId": row["baseVersionId"],
            "bbox": json.loads(row["bbox_json"]),
            "reason": row["reason"],
            "createdAt": row["createdAt"],
        } for row in rows],
    }

def team_person_exclusion_add(db, payload: dict):
    project = project_row(db, payload["projectName"])
    photo = db.execute(
        "SELECT id,project_id FROM photos WHERE id=? AND is_deleted=0",
        (payload["photoId"],),
    ).fetchone()
    version = db.execute(
        "SELECT id,photo_id FROM versions WHERE id=? AND is_deleted=0",
        (payload["baseVersionId"],),
    ).fetchone()
    if photo is None or photo["project_id"] != project["id"] or version is None or version["photo_id"] != photo["id"]:
        raise ValueError("人物实例不属于当前团片协作项目")
    bbox = payload.get("bbox") or {}
    normalized_bbox = {key: int(round(float(bbox.get(key, 0)))) for key in ("x", "y", "width", "height")}
    if normalized_bbox["x"] < 0 or normalized_bbox["y"] < 0 or normalized_bbox["width"] < 1 or normalized_bbox["height"] < 1:
        raise ValueError("人物识别框无效")
    exclusion_id = str(payload.get("id") or uuid.uuid4())
    timestamp = int(time.time() * 1000)
    db.execute(
        """INSERT INTO team_person_exclusions(
             id,project_id,photo_id,base_version_id,bbox_json,reason,created_at
           ) VALUES(?,?,?,?,?,?,?)""",
        (
            exclusion_id, project["id"], photo["id"], version["id"],
            json.dumps(normalized_bbox, ensure_ascii=False),
            str(payload.get("reason") or "false-positive")[:80],
            timestamp,
        ),
    )
    db.commit()
    return {"success": True, "id": exclusion_id, "bbox": normalized_bbox}

def team_person_exclusion_clear(db, payload: dict):
    project = project_row(db, payload["projectName"])
    result = db.execute(
        """DELETE FROM team_person_exclusions
           WHERE project_id=? AND photo_id=? AND base_version_id=?""",
        (project["id"], payload["photoId"], payload["baseVersionId"]),
    )
    db.commit()
    return {"success": True, "clearedCount": result.rowcount}

def team_patch_replace(db, payload: dict):
    timestamp = int(time.time() * 1000)
    previous_rows = db.execute(
        "SELECT patch_path,mask_path,edited_patch_path,members_json FROM team_patch_tasks WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    ).fetchall()
    assignment_artifacts = team_assignment_artifact_paths(db, payload["photoId"], payload["baseVersionId"])
    db.execute(
        "DELETE FROM team_patch_tasks WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    )
    # Person indices are produced by the detector and can change after a new
    # recognition pass. Keeping old identity links would silently attach names
    # to the wrong body, so the user must confirm them again.
    db.execute(
        "DELETE FROM team_person_assignments WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    )
    for task in payload.get("tasks", []):
        db.execute(
            """INSERT INTO team_patch_tasks(id,photo_id,base_version_id,person_index,person_name,assignee,
               detector,bbox_json,crop_json,patch_path,mask_path,mask_json,members_json,needs_review,review_reason,status,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (task["id"], payload["photoId"], payload["baseVersionId"], int(task["personIndex"]),
             task.get("personName") or f"人物 {task['personIndex']}", task.get("assignee") or "",
             task.get("detector") or "", json.dumps(task["bbox"], ensure_ascii=False),
             json.dumps(task["crop"], ensure_ascii=False), canonical_path(task["patchPath"]),
             canonical_path(task["maskPath"]) if task.get("maskPath") else None,
             json.dumps(task.get("mask") or {}, ensure_ascii=False),
             json.dumps(task.get("members") or [], ensure_ascii=False),
             int(bool(task.get("needsReview"))),
             str(task.get("reviewReason") or ""),
             task.get("status") or "exported", timestamp, timestamp),
        )
    if not payload.get("tasks"):
        db.execute(
            "DELETE FROM team_retouch_photos WHERE photo_id=? AND base_version_id=?",
            (payload["photoId"], payload["baseVersionId"]),
        )
    db.commit()
    result = team_patch_list(db, {"photoId": payload["photoId"]})
    result["artifactPaths"] = unreferenced_team_artifact_paths(db, team_artifact_paths(previous_rows) + assignment_artifacts)
    return result

def team_patch_cleanup(db, payload: dict):
    rows = db.execute(
        """SELECT * FROM team_patch_tasks
           WHERE photo_id=? AND base_version_id=? AND is_deleted=0""",
        (payload["photoId"], payload["baseVersionId"]),
    ).fetchall()
    if not rows:
        return {**team_patch_list(db, {"photoId": payload["photoId"]}), "artifactPaths": [], "cleanedCount": 0}
    if not payload.get("force") and any(row["status"] != "merged" for row in rows):
        raise ValueError("仍有未完成的团片协作任务，不能清理工作数据")
    candidates = team_artifact_paths(rows) + team_assignment_artifact_paths(db, payload["photoId"], payload["baseVersionId"])
    db.execute(
        "DELETE FROM team_patch_tasks WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    )
    db.execute(
        "DELETE FROM team_person_assignments WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    )
    db.execute(
        "DELETE FROM team_retouch_photos WHERE photo_id=? AND base_version_id=?",
        (payload["photoId"], payload["baseVersionId"]),
    )
    db.commit()
    result = team_patch_list(db, {"photoId": payload["photoId"]})
    result.update({"artifactPaths": unreferenced_team_artifact_paths(db, candidates), "cleanedCount": len(rows)})
    return result

def team_patch_update(db, payload: dict):
    row = db.execute("SELECT * FROM team_patch_tasks WHERE id=? AND is_deleted=0", (payload["taskId"],)).fetchone()
    if row is None:
        raise ValueError("人物修图任务不存在")
    assignment_completion = payload.get("assignmentCompletion")
    assignment_person_index = None
    if assignment_completion is not None:
        if not isinstance(assignment_completion, dict):
            raise ValueError("人物完成状态无效")
        assignment_person_index = int(assignment_completion.get("personIndex") or 0)
        members = json.loads(row["members_json"] or "[]") or [{"personIndex": row["person_index"]}]
        member_indices = {int(member.get("personIndex") or 0) for member in members}
        if assignment_person_index < 1 or assignment_person_index not in member_indices:
            raise ValueError("人物不属于这个修图任务")
        assignment = db.execute(
            """SELECT 1 FROM team_person_assignments
               WHERE photo_id=? AND base_version_id=? AND person_index=?""",
            (row["photo_id"], row["base_version_id"], assignment_person_index),
        ).fetchone()
        if assignment is None:
            raise ValueError("请先给这个人物标记身份")
    fields, values = [], []
    mapping = {"personName": "person_name", "assignee": "assignee", "status": "status", "mergedVersionId": "merged_version_id"}
    for source, target in mapping.items():
        if source in payload:
            fields.append(f"{target}=?")
            values.append(None if source == "mergedVersionId" and not payload[source] else str(payload[source] or ""))
    if "editedPatchPath" in payload:
        fields.append("edited_patch_path=?")
        values.append(canonical_path(payload["editedPatchPath"]) if payload["editedPatchPath"] else None)
    if "patchPath" in payload:
        fields.append("patch_path=?")
        values.append(canonical_path(payload["patchPath"]) if payload["patchPath"] else None)
    if "mergeMetrics" in payload:
        fields.append("merge_metrics_json=?")
        values.append(json.dumps(payload["mergeMetrics"] or {}, ensure_ascii=False))
    if "needsReview" in payload:
        fields.append("needs_review=?")
        values.append(int(bool(payload["needsReview"])))
    if "reviewReason" in payload:
        fields.append("review_reason=?")
        values.append(str(payload["reviewReason"] or ""))
    if "crop" in payload:
        crop = payload.get("crop") or {}
        normalized_crop = {key: int(crop.get(key, 0)) for key in ("x", "y", "width", "height")}
        if normalized_crop["x"] < 0 or normalized_crop["y"] < 0 or normalized_crop["width"] < 1 or normalized_crop["height"] < 1:
            raise ValueError("工作图范围无效")
        fields.append("crop_json=?")
        values.append(json.dumps(normalized_crop, ensure_ascii=False))
    timestamp = int(time.time() * 1000)
    fields.append("updated_at=?")
    values.append(timestamp)
    values.append(row["id"])
    try:
        db.execute(f"UPDATE team_patch_tasks SET {', '.join(fields)} WHERE id=?", values)
        if assignment_person_index is not None:
            assignment_completed = bool(assignment_completion.get("completed"))
            assignment_completion_kind = str(assignment_completion.get("completionKind") or ("returned" if assignment_completed and payload.get("editedPatchPath") else "no-retouch" if assignment_completed else ""))
            if assignment_completion_kind not in ("", "returned", "no-retouch", "skip-requested"):
                raise ValueError("人物完成方式无效")
            assignment_edited_path = assignment_completion.get("editedPatchPath")
            if assignment_edited_path is None and assignment_completion_kind == "returned":
                assignment_edited_path = payload.get("editedPatchPath")
            db.execute(
                """UPDATE team_person_assignments
                   SET completed=?,completion_kind=?,edited_patch_path=?,return_missing=0,return_missing_since=NULL,completed_at=?,updated_at=?
                   WHERE photo_id=? AND base_version_id=? AND person_index=?""",
                (int(assignment_completed), assignment_completion_kind,
                 canonical_path(assignment_edited_path) if assignment_edited_path else None,
                 timestamp if assignment_completed else None, timestamp,
                 row["photo_id"], row["base_version_id"], assignment_person_index),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return team_patch_list(db, {"photoId": row["photo_id"]})

def team_patch_delete(db, payload: dict):
    row = db.execute(
        """SELECT task.*,photos.project_id FROM team_patch_tasks task
           JOIN photos ON photos.id=task.photo_id WHERE task.id=? AND task.is_deleted=0""",
        (payload["taskId"],),
    ).fetchone()
    if row is None:
        raise ValueError("人物工作图不存在")
    members = json.loads(row["members_json"] or "[]") or [{"personIndex": row["person_index"]}]
    person_indices = sorted({int(member.get("personIndex") or 0) for member in members if int(member.get("personIndex") or 0) > 0})
    candidates = team_artifact_paths([row]) + team_assignment_artifact_paths(db, row["photo_id"], row["base_version_id"], person_indices)
    db.execute("DELETE FROM team_patch_tasks WHERE id=?", (row["id"],))
    if person_indices:
        placeholders = ",".join("?" for _ in person_indices)
        db.execute(
            f"""DELETE FROM team_person_assignments
                WHERE photo_id=? AND base_version_id=? AND person_index IN ({placeholders})""",
            (row["photo_id"], row["base_version_id"], *person_indices),
        )
    remaining_task = db.execute(
        "SELECT 1 FROM team_patch_tasks WHERE photo_id=? AND base_version_id=? AND is_deleted=0 LIMIT 1",
        (row["photo_id"], row["base_version_id"]),
    ).fetchone()
    if remaining_task is None:
        db.execute(
            "DELETE FROM team_retouch_photos WHERE photo_id=? AND base_version_id=?",
            (row["photo_id"], row["base_version_id"]),
        )
    cleanup_empty_generated_team_identities(db, row["project_id"])
    db.commit()
    result = team_patch_list(db, {"photoId": row["photo_id"]})
    result["artifactPaths"] = unreferenced_team_artifact_paths(db, candidates)
    return result

def delete_team_project_rows(db, project_id: str):
    photo_ids = [row[0] for row in db.execute("SELECT id FROM photos WHERE project_id=?", (project_id,)).fetchall()]
    if photo_ids:
        placeholders = ",".join("?" for _ in photo_ids)
        db.execute(f"DELETE FROM team_patch_tasks WHERE photo_id IN ({placeholders})", photo_ids)
    db.execute("DELETE FROM team_person_exclusions WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM team_person_assignments WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM team_retouch_photos WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM team_person_identities WHERE project_id=?", (project_id,))

def team_project_purge(db, payload: dict):
    project_id = str(payload.get("projectId") or "")
    photo_ids = [str(value) for value in payload.get("photoIds", []) if value]
    artifact_rows = []
    if photo_ids:
        placeholders = ",".join("?" for _ in photo_ids)
        artifact_rows = db.execute(
            f"""SELECT patch_path,mask_path,edited_patch_path,members_json FROM team_patch_tasks
                WHERE photo_id IN ({placeholders})""", photo_ids
        ).fetchall()
        db.execute(f"DELETE FROM team_patch_tasks WHERE photo_id IN ({placeholders})", photo_ids)
    if project_id:
        db.execute("DELETE FROM team_person_exclusions WHERE project_id=?", (project_id,))
        db.execute("DELETE FROM team_person_assignments WHERE project_id=?", (project_id,))
        db.execute("DELETE FROM team_retouch_photos WHERE project_id=?", (project_id,))
        db.execute("DELETE FROM team_person_identities WHERE project_id=?", (project_id,))
    db.commit()
    return {"success": True, "artifactPaths": unreferenced_team_artifact_paths(db, team_artifact_paths(artifact_rows))}

_ACTION_NAMES = (
    "team_patch_list", "team_project_workspace", "team_project_register_photo", "team_project_unregister_photo",
    "team_identity_save", "team_identity_assign", "team_identity_confirm_group", "team_identity_complete",
    "team_identity_delete", "team_person_exclusion_list", "team_person_exclusion_add", "team_person_exclusion_clear",
    "team_patch_replace", "team_patch_update", "team_patch_delete", "team_patch_cleanup", "team_project_purge",
)


def _dispatch(root, db, payload, *, handler):
    if handler is team_project_workspace:
        return handler(root, db, payload)
    return handler(db, payload)


DOMAIN.actions.update({name: (lambda root, db, payload, handler=globals()[name]: _dispatch(root, db, payload, handler=handler)) for name in _ACTION_NAMES})
register_exports("workspace-actions", {name: globals()[name] for name in _ACTION_NAMES})
DOMAIN.integrated_actions.update({"batch_commit_compare", "media_delete_version", "media_delete_project_missing_version", "progress_delete_missing"})
DOMAIN.hooks["bind_core"].append(bind_core)
DOMAIN.hooks["prepare_connection"].append(prepare_connection)
DOMAIN.hooks["migrate"].append(migrate)
DOMAIN.hooks["integrity"].append(integrity)
DOMAIN.hooks["delete_versions"].append(delete_versions)
DOMAIN.hooks["project_cleanup_plan"].append(project_cleanup_plan)
DOMAIN.hooks["merge_photo_history"].append(merge_photo_history)
DOMAIN.hooks["migrate_workflow_graph"].append(migrate_workflow_graph)
DOMAIN.hooks["purge_project_rows"].append(delete_team_project_rows)
