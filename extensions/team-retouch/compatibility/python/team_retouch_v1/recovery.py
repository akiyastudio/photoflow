"""Plugin-owned recovery adapter for legacy snapshots."""

from . import DOMAIN
from .storage import ensure_schema


DOMAIN_ID = "team-retouch"


def declaration():
    return {
        "pathColumns": {
            DOMAIN_ID: {
                "team_patch_tasks": ("patch_path", "mask_path", "edited_patch_path"),
                "team_person_assignments": ("edited_patch_path",),
            },
        },
    }


def supports(domain):
    return domain == DOMAIN_ID


def restore_project(domain, db, project_id, copy_filtered):
    if domain != DOMAIN_ID:
        return 0
    restored = 0
    existing = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    for table in ("team_person_exclusions", "team_person_assignments", "team_retouch_photos", "team_person_identities"):
        if table in existing:
            db.execute(f'DELETE FROM "{table}" WHERE project_id=?', (project_id,))
            restored += copy_filtered(db, table, "project_id=?", (project_id,))
    photo_ids = [row[0] for row in db.execute(
        "SELECT photo_id FROM source_domain.team_retouch_photos WHERE project_id=?", (project_id,)
    ).fetchall()]
    if photo_ids:
        placeholders = ",".join("?" for _ in photo_ids)
        db.execute(f"DELETE FROM team_patch_tasks WHERE photo_id IN ({placeholders})", photo_ids)
        restored += copy_filtered(db, "team_patch_tasks", f"photo_id IN ({placeholders})", photo_ids)
    return restored


def reset_store(domain, staged):
    if domain != DOMAIN_ID:
        return False
    db = ensure_schema(staged)
    db.close()
    return True


DOMAIN.hooks["recovery_declaration"].append(declaration)
DOMAIN.hooks["recovery_supports"].append(supports)
DOMAIN.hooks["recovery_restore_project"].append(restore_project)
DOMAIN.hooks["recovery_reset_store"].append(reset_store)
