from __future__ import annotations

import sqlite3
import sys
import tempfile
import contextlib
import io
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import domain_recovery  # noqa: E402


def create_media_store(path: Path, marker: str, original_path: str) -> None:
    domain_recovery.reset_store(str(path), "media")
    db = sqlite3.connect(path)
    try:
        db.execute("ALTER TABLE photos ADD COLUMN marker TEXT")
        db.execute(
            """INSERT INTO photos(
                 id,project_id,media_type,original_name,display_name,original_file_path,
                 marker,created_at,updated_at
               ) VALUES('photo','project','image','photo.jpg','photo',?,?,1,1)""",
            (original_path, marker),
        )
        db.commit()
    finally:
        db.close()


def main():
    with tempfile.TemporaryDirectory(prefix="photoflow-domain-recovery-") as temporary:
        root = Path(temporary)
        source = root / "source.sqlite3"
        destination = root / "destination.sqlite3"
        create_media_store(source, "snapshot", str(root / "old" / "photo.jpg"))
        create_media_store(destination, "current", str(root / "current" / "photo.jpg"))

        identityless = root / "identityless.sqlite3"
        create_media_store(identityless, "legacy", str(root / "old" / "legacy.jpg"))
        identityless_db = sqlite3.connect(identityless)
        identityless_db.execute("DELETE FROM meta WHERE key='domain_identity'")
        identityless_db.commit()
        identityless_db.close()
        assert domain_recovery.verify(str(identityless), "media")["success"], "complete identity-less legacy stores remain compatible"

        legacy = root / "legacy-media.sqlite3"
        shutil.copy2(identityless, legacy)
        legacy_db = sqlite3.connect(legacy)
        legacy_db.execute("PRAGMA foreign_keys=OFF")
        for table in reversed(domain_recovery.DOMAIN_TABLES["media"]):
            if table != "photos":
                legacy_db.execute(f'DROP TABLE "{table}"')
        legacy_db.commit()
        legacy_db.close()
        legacy_status = domain_recovery.verify(str(legacy), "media")
        assert legacy_status["success"] and legacy_status["state"] == "legacy-compatible"
        domain_recovery._prepare_staged_domain(str(legacy), "media")
        migrated_status = domain_recovery.verify(str(legacy), "media")
        assert migrated_status["success"] and migrated_status["state"] == "healthy"
        migrated_db = sqlite3.connect(legacy)
        assert migrated_db.execute("SELECT original_file_path FROM photos WHERE id='photo'").fetchone()[0] == str(root / "old" / "legacy.jpg")
        migrated_db.close()

        incomplete = root / "incomplete.sqlite3"
        incomplete_db = sqlite3.connect(incomplete)
        incomplete_db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        incomplete_db.execute("INSERT INTO meta VALUES('schema_version','1')")
        incomplete_db.execute("CREATE TABLE photos(id TEXT PRIMARY KEY,original_file_path TEXT)")
        incomplete_db.commit()
        incomplete_db.close()
        assert not domain_recovery.verify(str(incomplete), "media")["success"], "schema-1 restores require the complete domain contract"
        cli_output = io.StringIO()
        with contextlib.redirect_stdout(cli_output):
            domain_recovery.main(["verify", "--domain", "versioning", "--destination", str(source)])
        cli_result = json.loads(cli_output.getvalue())
        assert not cli_result["success"] and any(
            "required tables" in error or "identity" in error for error in cli_result.get("errors", [])
        ), "CLI verify must pass --domain through and reject a store owned by another domain"

        durable_source = root / "durable-source.sqlite3"
        durable_destination = root / "durable-destination.sqlite3"
        durable_source.write_bytes(b"new")
        durable_destination.write_bytes(b"old")
        original_replace = domain_recovery.os.replace
        original_fsync = domain_recovery.os.fsync
        fsync_calls = []
        domain_recovery.os.fsync = lambda descriptor: fsync_calls.append(descriptor)
        domain_recovery.os.replace = lambda *_args: (_ for _ in ()).throw(OSError("injected replace failure"))
        try:
            try:
                domain_recovery._durable_replace(str(durable_source), str(durable_destination))
                raise AssertionError("replace failure was ignored")
            except OSError as error:
                assert "injected replace failure" in str(error)
        finally:
            domain_recovery.os.replace = original_replace
            domain_recovery.os.fsync = original_fsync
        assert fsync_calls, "staged database must be fsynced before replace"
        assert durable_source.read_bytes() == b"new" and durable_destination.read_bytes() == b"old"

        original_rebase = domain_recovery._rebase
        try:
            domain_recovery._rebase = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("injected rebase failure"))
            try:
                domain_recovery.restore_workspace(
                    str(source), str(destination), "media", [(str(root / "old"), str(root / "new"))]
                )
                raise AssertionError("injected restore failure must be reported")
            except RuntimeError as error:
                assert "injected rebase failure" in str(error)
        finally:
            domain_recovery._rebase = original_rebase
        current = sqlite3.connect(destination)
        try:
            assert current.execute("SELECT marker FROM photos").fetchone()[0] == "current"
        finally:
            current.close()

        restored = domain_recovery.restore_workspace(
            str(source), str(destination), "media", [(str(root / "old"), str(root / "new"))]
        )
        assert restored["success"] and Path(restored["backup"]).is_file()
        current = sqlite3.connect(destination)
        try:
            marker, original_path = current.execute(
                "SELECT marker,original_file_path FROM photos"
            ).fetchone()
            assert marker == "snapshot"
            assert Path(original_path) == root / "new" / "photo.jpg"
        finally:
            current.close()

        destination.write_bytes(b"corrupt-domain-store")
        reset = domain_recovery.reset_store(str(destination), "media")
        assert reset["success"] and reset["requiresReindex"]
        assert Path(reset["quarantine"]).read_bytes() == b"corrupt-domain-store"

    print("Atomic domain recovery tests passed.")


if __name__ == "__main__":
    main()
