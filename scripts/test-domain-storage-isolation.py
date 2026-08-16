from __future__ import annotations

import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace_db  # noqa: E402
from workspace_domain_storage import database_path_for_workspace_database  # noqa: E402


def prepare(base: Path, suffix: str):
    workspace = base / f"workspace-{suffix}"
    workspace.mkdir()
    (workspace / "项目").mkdir()
    database = base / "workspace-data" / f"{suffix}.sqlite3"
    now = int(time.time() * 1000)
    db = workspace_db.connect(str(workspace), str(database), include_domains=False)
    db.execute("INSERT INTO projects(id,name,status,relative_path,created_at,updated_at) VALUES('project','项目','后期中','项目',?,?)", (now, now))
    db.execute("""INSERT INTO photos(id,project_id,media_type,display_name,original_name,original_file_path,created_at,updated_at,is_deleted)
                  VALUES('photo','project','image','照片','photo.jpg','photo.jpg',?,?,0)""", (now, now))
    db.execute("""INSERT INTO versions(id,photo_id,version_number,version_name,version_type,file_path,file_path_key,file_size,status,is_current,created_at,updated_at,is_deleted)
                  VALUES('version','photo',0,'原片','original','photo.jpg','photo.jpg',1,'ready',1,?,?,0)""", (now, now))
    db.execute("UPDATE photos SET current_version_id='version' WHERE id='photo'")
    db.execute("""INSERT INTO file_records(id,owner_type,owner_id,current_path,file_name,extension,file_size,modified_at,quick_hash,created_at,updated_at)
                  VALUES('record','version','version','photo.jpg','photo.jpg','.jpg',1,1,'q',?,?)""", (now, now))
    db.commit()
    db.close()
    runtime = workspace_db.connect(str(workspace), str(database), include_domains=True)
    assert runtime.execute("SELECT id FROM photos").fetchone()[0] == "photo"
    assert runtime.execute("SELECT id FROM versions").fetchone()[0] == "version"
    runtime.close()
    return workspace, database


def main():
    with tempfile.TemporaryDirectory(prefix="photoflow-domain-isolation-") as temporary:
        base = Path(temporary)
        for failed_domain in ("media", "versioning"):
            workspace, database = prepare(base, failed_domain)
            media = Path(database_path_for_workspace_database(str(database), "media"))
            versioning = Path(database_path_for_workspace_database(str(database), "versioning"))
            assert media.is_file() and versioning.is_file()
            core = sqlite3.connect(database)
            try:
                tables = {row[0] for row in core.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                assert "photos" not in tables and "versions" not in tables
            finally:
                core.close()

            failed = media if failed_domain == "media" else versioning
            failed.write_bytes(b"not-a-sqlite-database")
            loaded = workspace_db.load(str(workspace), str(database))
            assert loaded["success"] and loaded["projects"][0]["id"] == "project"
            synced = workspace_db.mutate(str(workspace), str(database), "catalog_sync", {})
            assert synced["success"], f"{failed_domain} failure must not block catalog writes"
            try:
                workspace_db.mutate(str(workspace), str(database), "media_get_photo", {"photoId": "photo"})
                raise AssertionError(f"{failed_domain} corruption must fail its dependent domain request")
            except (sqlite3.Error, RuntimeError):
                pass

    print("Domain storage and catalog fault-isolation tests passed.")


if __name__ == "__main__":
    main()
